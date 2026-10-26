import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { taskNotificationRecovery } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { taskNotificationOutbound } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

// Real HTTP + service + durable SQLite. Only the model/DSH session calls are deterministic fixtures.
// This does not verify a real browser, DingTalk transport, model, credentials, or deployment.
test('任务会话HTTP端到端：唯一会话、动态执行、需求修订、CAS取消与旧写入口退役', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-session-http-'))
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'task-http-test' })
  const residentStore = await openResidentStore(facility)
  await residentStore.subscribe({ groupId: 'g', name: '验收群', responsibility: '处理用户授权的验收工作' })
  const legacy = { getAgentConfig: () => ({ model: 'test', provider: 'test', workspaceDir: root }), getGroup: id => residentStore.getGroup(id),
    getTask: id => id === 'old' ? { taskId: 'old', state: 'completed', result: '历史结果' } : undefined }
  const noop = async () => {}
  let taskTurns = 0
  const service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } }, legacy, residentStore,
    config: { dbPath: join(root, 'control.sqlite'), workspaceDir: root, instanceId: 'http-fixture', initialize: true, webActorId: 'owner' },
    persistence: { register: noop, close: noop }, groupSessions: { run: noop, close: noop },
    taskSessions: { close: noop, cancel: noop, run: async ({ input, delegate, submit, onSessionBound }) => { taskTurns++; await onSessionBound(); if (!input.executions.length) for (let i = 0; i < 10; i++) await delegate({ key: `核对服务${String(i).padStart(2, '0')}`, objective: '检查实际服务状态', context: '只核对', resourceKeys: [] }); await submit({ action: 'wait', summary: '已委派核对，等待确认', evidence: ['fixture-only'], limitations: ['未调用真实模型'] }) } },
    executionSessions: { close: noop, cancel: noop, run: async ({ onSessionBound, onResult, onProgress }) => { await onSessionBound(); await onProgress({ summary: '已读取状态，开始验证', evidence: ['actual-evidence.txt'], activity: '验证状态', reportId: 'http-stage' }); await onResult({ status: 'completed', summary: '核对成功', evidence: ['actual-evidence.txt'], limitations: ['未部署'], artifacts: [] }); return { status: 'submitted' } } },
  })
  const runtime = { ...legacy, coordinationSources: service.coordinationSources, coordinationSourceDetail: service.coordinationSourceDetail,
    listTaskView: () => service.boardTasks(), getTaskSessionDetail: id => service.taskDetail(id), getTaskSessionExecutions: (...args) => service.taskExecutions(...args), getTaskSessionDecisions: (...args) => service.taskDecisions(...args),
    createTask: args => service.createTask(args), appendTaskContext: args => service.appendTaskContext(args), cancelTask: args => service.cancelTask(args),
    getTaskDialogue: id => service.taskDialogue(id), sendTaskDialogue: args => service.sendTaskDialogue(args) }
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  try {
    const emptyCoordination = await (await fetch(base + '/state/coordination-sources')).json()
    assert.equal(emptyCoordination.total, 0)
    const source = (await service.store.command({ id: 'observer-reserve', kind: 'coordination.reserve',
      args: { unitId: 'synthetic-observer-source', revision: 1, groupId: 'g', original: 'Synthetic reserved input' } })).result.source
    const sourceDetail = await (await fetch(base + `/state/coordination-sources/${source.id}`)).json()
    assert.equal(sourceDetail.source.original, 'Synthetic reserved input')
    assert.equal(sourceDetail.coordination, null)
    const input = { requestId: 'create', groupId: 'g', title: '核对服务', objective: '核对服务并保留证据', acceptanceCriteria: ['状态可查'] }
    const created = await post('/tasks', input)
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const taskId = created.body.taskId, sessionId = created.body.session.sessionId
    assert.ok(taskId && sessionId)
    assert.equal(residentStore.listTopics('g').length, 1)
    assert.equal((await service.store.query({ kind: 'task.get', taskId })).topicRefs.length, 1)
    const duplicate = await post('/tasks', input)
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body)); assert.equal(duplicate.body.taskId, taskId)
    await service.whenIdle(); await service.recover(); await service.whenIdle()
    const executions = await service.store.query({ kind: 'execution.list', taskId })
    assert.equal(executions.length, 10, 'The pagination fixture starts with ten dispatched executions')
    assert.ok(executions.every(execution => execution.status === 'succeeded' && execution.drained))
    // 历史读取夹具：旧任务可能已有超过十个执行；不经新派发绕过上限，也不删分页覆盖。
    // 十个真实服务执行保留原样，另复制43个已结束历史记录及其阶段事件，仅用于HTTP读取断言。
    const stage = (await service.store.query({ kind: 'wake.list', taskId })).find(wake => wake.kind === 'execution.stage.progress' && wake.payload.executionId === executions[0].executionId)
    assert.ok(stage)
    const db = new DatabaseSync(join(root, 'control.sqlite'))
    try {
      db.exec('BEGIN')
      for (let index = 10; index < 53; index++) {
        const execution = structuredClone(executions[0]), id = `historical-fixture-${index}`, title = `核对服务${index}`
        delete execution.resources
        Object.assign(execution, { id, executionId: id, sessionId: `task-execution-${id}`, key: title, title })
        execution.input.title = title
        db.prepare('INSERT INTO dynamic_executions(id,body) VALUES (?,?)').run(id, JSON.stringify(execution))
        const wake = structuredClone(stage)
        Object.assign(wake, { id: `stage-${id}`, wakeId: `stage-${id}`, state: 'acked' })
        wake.payload.executionId = id
        db.prepare('INSERT INTO dynamic_wakes(id,body) VALUES (?,?)').run(wake.id, JSON.stringify(wake))
      }
      db.exec('COMMIT')
    } finally { db.close() }
    assert.equal((await service.store.query({ kind: 'execution.list', taskId })).length, 53)
    const detail = await (await fetch(base + `/state/tasks/${taskId}/detail`)).json()
    assert.equal(detail.session.sessionId, sessionId)
    assert.ok(detail.session.workspaceDir.startsWith(root))
    assert.ok(detail.session.logPath.startsWith(root))
    assert.equal(detail.timeline.version, 1)
    assert.equal(detail.timeline.executions.length, 53)
    assert.ok(detail.timeline.executions.every(row => row.complete && row.segments.length === 2 && row.segments.every(segment => segment.endedAt)))
    assert.ok(detail.timeline.executions.every(row => row.segments[1].label === '验证状态' && row.milestones.length === 1))
    assert.equal(detail.timeline.human.title, '人工介入')
    assert.deepEqual(detail.timeline.human.segments, [])
    const page = await (await fetch(base + `/state/tasks/${taskId}/executions?offset=0&limit=20`)).json()
    assert.equal(page.total, 53)
    const decisions = await (await fetch(base + `/state/tasks/${taskId}/decisions?limit=1`)).json()
    assert.equal(decisions.decisions.length, 1)
    assert.ok(decisions.decisions[0].decision.summary)
    assert.ok(Array.isArray(decisions.decisions[0].decision.evidence))
    assert.equal(decisions.decisions[0].sessionId, sessionId)
    assert.equal((await fetch(base + `/state/tasks/${taskId}/decisions?limit=0`)).status, 400)
    assert.equal((await fetch(base + '/state/tasks/missing/decisions')).status, 404)
    assert.equal(page.executions.length, 20)
    const board = await (await fetch(base + '/state/tasks')).json()
    assert.equal(board[0].executionSessions.length, 53)
    assert.equal(new Set(board[0].executionSessions.map(item => item.sessionId)).size, 53)
    assert.deepEqual(board[0].executionSessions, detail.executionSessions)
    assert.ok(board[0].executionSessions.every(item => /^核对服务\d{2}$/.test(item.title)))
    assert.ok(board[0].executionSessions.every(item => item.runTiming.recorded === true && item.runTiming.elapsedMs >= 0 && item.runTiming.startedAt === null))
    assert.ok(board[0].executionSessions.every(item => item.latestRoundTiming.active === false
      && Date.parse(item.latestRoundTiming.endedAt) >= Date.parse(item.latestRoundTiming.startedAt)))
    assert.ok(board[0].executionSessions.every(item => item.drained === true && item.recovering === false))
    assert.deepEqual((await service.boardTasks())[0].executionSessions, board[0].executionSessions)
    assert.equal(page.executions[0].status, 'succeeded')
    assert.notEqual(page.executions[0].sessionId, sessionId)
    assert.equal(page.executions[0].result.summary, '核对成功')
    const dialoguePath = `/tasks/${taskId}/dialogue`
    assert.equal((await post(dialoguePath, { requestId: 'chat', text: '现在进度怎样？', actorId: 'spoof' })).status, 400)
    const saved = await post(dialoguePath, { requestId: 'chat', text: '现在进度怎样？' })
    assert.equal(saved.status, 202); assert.equal(saved.body.reply, null)
    await service.whenIdle()
    const conversation = await (await fetch(base + `/state${dialoguePath}`)).json()
    assert.equal(conversation.sessionId, sessionId)
    assert.equal(conversation.messages.length, 1)
    assert.ok(conversation.messages[0].reply)
    const dialogueDecisions = await (await fetch(base + `/state/tasks/${taskId}/decisions?limit=1`)).json()
    assert.equal(dialogueDecisions.decisions[0].decision.summary, conversation.messages[0].reply)
    assert.ok(dialogueDecisions.decisions[0].triggers.some(item => item.kind === 'task.dialogue'))
    assert.equal((await post(dialoguePath, { requestId: 'chat', text: '现在进度怎样？' })).status, 202)
    assert.equal((await post(dialoguePath, { requestId: 'chat', text: '同一ID不同正文' })).status, 409)
    assert.equal((await service.taskDetail(taskId)).executionCount, 53)
    assert.equal((await service.taskDetail(taskId)).requirementRevision, 1)
    const foreignOrigin = await fetch(base + dialoguePath, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
      body: JSON.stringify({ requestId: 'foreign', text: '不能受理' }) })
    assert.equal(foreignOrigin.status, 403)
    assert.equal((await post(dialoguePath, { requestId: 'empty', text: '   ' })).status, 400)
    assert.deepEqual(page.executions[0].result.limitations, ['未部署'])
    const missing = await post(`/tasks/${taskId}/context`, { requestId: 'missing-classification', context: '开发分支别搞错了', expectedRequirementRevision: detail.requirementRevision, expectedControlRevision: detail.controlRevision })
    assert.equal(missing.status, 400)
    assert.equal((await service.taskDetail(taskId)).requirementRevision, detail.requirementRevision)
    const conflict = await post(`/tasks/${taskId}/context`, { requestId: 'conflicting-classification', context: '收回授权', progressImpact: 'preserve', authorizationChange: 'changed', expectedRequirementRevision: detail.requirementRevision, expectedControlRevision: detail.controlRevision })
    assert.equal(conflict.status, 400)
    assert.equal((await service.taskDetail(taskId)).contextInputContract.missingClassification, 'reject-without-cancelling')
    await assert.rejects(service.appendTaskContext({ taskId, requestId: 'direct-api-missing', context: '开发分支别搞错了' }), { code: 'TASK_CONTEXT_CLASSIFICATION_REQUIRED' })
    const revised = await post(`/tasks/${taskId}/context`, { requestId: 'revise', progressImpact: 'replan', context: '补充：还需读取错误日志', expectedRequirementRevision: detail.requirementRevision, expectedControlRevision: detail.controlRevision })
    assert.equal(revised.status, 200, JSON.stringify(revised.body))
    assert.equal(revised.body.requirementRevision, 2)
    assert.equal(revised.body.session.sessionId, sessionId)
    await service.whenIdle()
    const stale = await post(`/tasks/${taskId}/context`, { requestId: 'stale', progressImpact: 'replan', context: '旧客户端资料', expectedRequirementRevision: 1, expectedControlRevision: detail.controlRevision })
    assert.equal(stale.status, 409, JSON.stringify(stale.body))
    const current = await service.taskDetail(taskId)
    const cancelled = await post(`/tasks/${taskId}/cancel`, { requestId: 'cancel', reason: '验收完成', expectedControlRevision: current.controlRevision })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.controlState, 'cancelled')
    assert.equal(cancelled.body.session.sessionId, sessionId)
    assert.equal((await service.taskDialogue(taskId)).writable, false)
    assert.notEqual((await post(dialoguePath, { requestId: 'after-cancel', text: '不能自动恢复任务' })).status, 202)
    assert.equal((await post(dialoguePath, { requestId: 'chat', text: '现在进度怎样？' })).status, 202, 'saved request remains idempotent after terminal state')
    assert.equal((await service.taskDialogue(taskId)).messages.length, 1)
    assert.equal((await (await fetch(base + '/state/tasks')).json()).length, 1)
    assert.equal((await post('/tasks/old/context', { requestId: 'old', progressImpact: 'replan', context: '禁止恢复', expectedRequirementRevision: 1, expectedControlRevision: 1 })).status, 404)
    for (const path of ['/tasks/old/reopen', '/tasks/old/reports/r/retry', '/authorizations/old/decision', '/workflows/message/requests/r/answer']) assert.equal((await post(path, {})).status, 410)
    assert.ok(taskTurns >= 1)
    await residentStore.ingest({groupId:'g',messageId:'startup-alert',text:'待处理',senderOpenDingTalkId:'owner',occurredAt:'2026-10-20T10:39:40Z'})
    await residentStore.markMessageAgentDelivery({groupId:'g',messageId:'startup-alert',status:'decision-failed',error:'agent-preset/invalid'})
    assert.equal(service.listAlerts().find(item=>item.alertId==='coordination:g').detail,'agent-preset/invalid', '持久消息故障不能依赖会被扫描清空的内存失败表')
    await residentStore.markMessageAgentDelivery({groupId:'g',messageId:'startup-alert',status:'delivered'})
    assert.equal(service.listAlerts().some(item=>item.alertId==='coordination:g'),false)

  } finally { await new Promise(resolve => server.close(resolve)); await service.close(); await residentStore.close(); await rm(root, { recursive: true, force: true }) }
})

const notificationGuardError = { phase: 'send', knownNotSent: true, retryable: true, exitCode: 1, stdout: '',
  stderr: JSON.stringify({ error: { category: 'api', code: 1, origin: 'mcp_gateway', operation: 'chat/get_conversation_info',
    reason: 'topic_quote_guard_unavailable', retryable: true, message: '无法确认引用回复目标是否属于话题圈，已阻止发送' } }) }

async function notificationServiceFixture(t, notifications) {
  const root = await mkdtemp(join(tmpdir(), 'notification-service-retry-')), snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'notification-service-test' })
  const residentStore = await openResidentStore(facility)
  await residentStore.subscribe({ groupId: 'g', name: '合成群', responsibility: '仅隔离测试' })
  const noop = async () => {}
  const service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } }, residentStore, notifications,
    legacy: { getAgentConfig: () => ({ workspaceDir: root }), getGroup: id => residentStore.getGroup(id) },
    config: { dbPath: join(root, 'tasks.sqlite'), workspaceDir: root, instanceId: 'notification-service', initialize: true },
    persistence: { register: noop, close: noop }, taskSessions: { close: noop, cancel: noop }, executionSessions: { close: noop, cancel: noop } })
  t.after(async () => { await service.close(); await residentStore.close(); await rm(root, { recursive: true, force: true }) })
  let sequence = 0
  const command = (kind, args) => service.store.command({ kind, args, id: `fixture:${++sequence}` })
  const read = id => service.store.query({ kind: 'notification.get', notificationId: id })
  const prepare = async (id, payload = {}) => (await command('notification.prepare', { notificationId: id, requirementRevision: 1, kind: 'topic-reply',
    payload: { conversationId: 'g', sourceMessageId: 'source', actorId: 'owner', sourceVersion: 1, text: '合成原回复', replyKind: 'substantive',
      fact: { topicRefs: [{ topicId: 'topic', revision: 1 }] }, ...payload } })).result.notification
  const failed = async (id, payload = {}, outbound = {}) => {
    await prepare(id, payload)
    const started = (await command('notification.start', { notificationId: id })).result.notification
    await command('notification.receipt', { notificationId: id, dispatchToken: started.dispatchToken, state: 'failed', error: notificationGuardError,
      nextAttemptAt: '2099-01-01T00:00:00Z' })
    const row = await read(id)
    await residentStore.projectTaskNotification({ groupId: 'g', outbound: { ...taskNotificationOutbound(row), ...outbound } })
    return row
  }
  const retry = row => service.retryNotification({ groupId: 'g', notificationId: row.id, expectedToken: taskNotificationRecovery(row).expectedToken })
  return { service, residentStore, command, read, prepare, failed, retry }
}

test('notification service manual recovery uses the original identity, stages and private response whitelist', async t => {
  let sends = 0
  const f = await notificationServiceFixture(t, { send: async row => { sends++; assert.equal(row.id, 'notice'); return { openTaskId: 'accepted' } },
    readback: async () => ({ messageId: 'verified', conversationId: 'g' }) })
  await f.command('source.record', { sourceId: 'stage-source', groupId: 'g', messageId: 'source', actorId: 'owner', text: '合成来源', version: 1 })
  const failed = await f.failed('notice')
  const result = await f.retry(failed)
  assert.deepEqual(result, { groupId: 'g', notificationId: 'notice', status: 'attempted', action: 'send' })
  assert.doesNotMatch(JSON.stringify(result), /payload|合成原回复|owner|dispatchToken/)
  const delivered = await f.read('notice')
  assert.equal(delivered.state, 'delivered'); assert.equal(delivered.sendAttemptCount, 2); assert.equal(sends, 1)
  assert.equal(delivered.payloadDigest, failed.payloadDigest)
  const source = await f.service.store.query({ kind: 'source.get', sourceId: 'stage-source' })
  assert.deepEqual(source.stages.map(stage => stage.stage), ['send', 'readback'])
  assert.ok(source.stages.every(stage => stage.completedAt))
  assert.equal(f.residentStore.getGroup('g').outbox.find(row => row.outboundId === 'notice').notificationState, 'delivered')
  await assert.rejects(f.retry(failed), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  await assert.rejects(f.retry(delivered), { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN' })
  assert.equal(f.service.listAlerts().some(row => row.alertId === 'failure:notice'), false, 'a forbidden click is not a delivery failure')
})

test('notification service rejects wrong group, missing identity, operator rows and stale CAS without effects', async t => {
  const f = await notificationServiceFixture(t, { send: async () => assert.fail('must not send'), readback: async () => assert.fail('must not read') })
  const row = await f.prepare('notice'), expectedToken = taskNotificationRecovery(row).expectedToken
  const before = await f.service.store.query({ kind: 'notification.list' })
  for (const args of [{ groupId: 'other', notificationId: row.id, expectedToken }, { groupId: 'g', notificationId: 'missing', expectedToken },
    { groupId: '', notificationId: row.id, expectedToken }])
    await assert.rejects(f.service.retryNotification(args), { code: 'TASK_NOTIFICATION_NOT_FOUND' })
  await assert.rejects(f.service.retryNotification({ groupId: 'g', notificationId: row.id, expectedToken: 'old' }), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  assert.deepEqual(await f.service.store.query({ kind: 'notification.list' }), before)
  const privateRow = await f.prepare('private', { audience: 'operator', recipientUserId: 'PRIVATE' })
  await assert.rejects(f.retry(privateRow), { code: 'TASK_NOTIFICATION_NOT_FOUND' })
  assert.equal(f.residentStore.getGroup('g').outbox.some(row => row.outboundId === 'private'), false)
})

for (const gate of ['superseded', 'recall', 'confirmation', 'task-terminal']) test(`notification service shares automatic retirement gate: ${gate}`, async t => {
  const f = await notificationServiceFixture(t, { send: async () => assert.fail('retired intent must not send'), readback: async () => assert.fail('must not read') })
  const outbound = gate === 'superseded' ? { status: 'superseded', supersededByOutboundId: 'new' }
    : gate === 'recall' ? { recallStatus: 'recalled' } : {}
  if (gate === 'task-terminal') {
    await f.command('task.create', { taskId: 'terminal', groupId: 'g', request: '合成任务', operationId: 'decision:action:0' })
    await f.command('task.control', { taskId: 'terminal', control: 'cancelled' })
    outbound.taskIds = ['terminal']; outbound.decisionId = 'decision'
  }
  const payload = ['confirmation', 'task-terminal'].includes(gate) ? { replyKind: 'confirmation' } : {}
  const row = await f.failed('notice', payload, outbound)
  await assert.rejects(f.service.retryNotification({ groupId: 'g', notificationId: row.id, expectedToken: 'old' }),
    { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE' })
  assert.deepEqual(await f.read('notice'), row)
  await assert.rejects(f.retry(row), { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN' })
  const retired = await f.read('notice')
  assert.equal(retired.retirement.reason, ['superseded', 'recall'].includes(gate) ? 'superseded'
    : gate === 'confirmation' ? 'confirmation-reassessment-required' : 'task-terminal')
  assert.equal(retired.sendAttemptCount, 1)
  assert.equal(f.service.listAlerts().some(row => row.alertId === 'failure:notice'), false, 'retirement is not a failed effect')
  await f.failed('automatic', payload, outbound)
  await f.service.whenIdle()
  assert.equal((await f.read('notice')).sendAttemptCount, 1)
  assert.equal((await f.read('automatic')).retirement.reason, retired.retirement.reason)
  assert.equal((await f.read('automatic')).sendAttemptCount, 1)
})

test('notification service manual unknown recovery is readback-only and rejects concurrent automatic or manual effects', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let sends = 0, reads = 0
  t.after(() => release.resolve())
  const f = await notificationServiceFixture(t, { send: async () => { sends++; throw new Error('network timeout') },
    readback: async () => { reads++; entered.resolve(); await release.promise; return { messageId: 'verified', conversationId: 'g' } } })
  await f.prepare('notice')
  await f.service.whenIdle()
  const unknown = await f.read('notice')
  assert.equal(unknown.state, 'unknown'); assert.equal(sends, 1)
  const pending = f.retry(unknown)
  await entered.promise
  await assert.rejects(f.retry(unknown), { code: 'TASK_NOTIFICATION_RECOVERY_IN_PROGRESS' })
  const auto = f.service.whenIdle()
  release.resolve(); await pending; await auto
  assert.equal(reads, 1); assert.equal(sends, 1); assert.equal((await f.read('notice')).state, 'delivered')
})


test('notification service manual refusal remains recoverable after credentials are repaired', async t => {
  let blocked = true, sends = 0
  const f = await notificationServiceFixture(t, { send: async () => {
    sends++
    if (blocked) throw Object.assign(new Error('upstream HTTP 401'), notificationGuardError)
    return { openTaskId: 'accepted' }
  }, readback: async () => ({ messageId: 'verified' }) })
  const failed = await f.failed('notice')
  await assert.rejects(f.retry(failed), /upstream HTTP 401/)
  const stillFailed = await f.read('notice')
  assert.equal(stillFailed.state, 'failed'); assert.equal(stillFailed.sendAttemptCount, 2)
  assert.ok(Date.parse(stillFailed.nextAttemptAt) > Date.now())
  blocked = false
  await f.retry(stillFailed)
  assert.equal((await f.read('notice')).state, 'delivered'); assert.equal(sends, 2)
})

test('notification service manual recovery preserves pending-source send fences', async t => {
  const f = await notificationServiceFixture(t, { send: async () => assert.fail('new source must block old send') })
  await f.command('source.record', { sourceId: 'original', groupId: 'g', messageId: 'source', actorId: 'owner', text: 'original', timestamp: '2026-10-26T08:00:00Z' })
  const source = (await f.command('coordination.reserve', { unitId: 'unit-original', revision: 1, groupId: 'g', original: 'original',
    reservationId: 'reservation-original', reservationGeneration: 1, actorId: 'owner', sourceRefs: ['original'], sourceMessageId: 'source' })).result.source
  await f.command('coordination.source.clarify', { sourceId: source.id, fence: 1, coordinationId: 'arrangement', question: '几点？' })
  await f.command('source.record', { sourceId: 'newer', groupId: 'g', messageId: 'newer', actorId: 'owner', text: 'correction', timestamp: '2026-10-26T08:01:00Z' })
  const prepared = (await f.command('notification.prepare', { notificationId: 'notice', requirementRevision: 1, kind: 'coordination',
    payload: { conversationId: 'g', text: '几点？', sourceMessageId: 'source', actorId: 'owner', replyKind: 'substantive',
      fact: { coordinationId: 'arrangement', eventId: 'clarification:original', sourceUnitId: source.unitId, sourceUnitRevision: 1 } } })).result.notification
  const result = await f.retry(prepared)
  assert.equal(result.sourcePending, true)
  const saved = await f.read('notice')
  assert.equal(saved.state, 'prepared'); assert.equal(saved.sendAttemptCount, undefined); assert.equal(saved.sendPermit, undefined)
})

test('manual recovery releases the serial slot and drains a notification prepared during its readback', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const sends = [], reads = []
  const f = await notificationServiceFixture(t, { send: async row => { sends.push(row.id); return { messageId: `sent-${row.id}` } },
    readback: async row => { reads.push(row.id); if (row.id === 'manual') { entered.resolve(); await release.promise }; return { messageId: `sent-${row.id}`, visible: true } } })
  await f.prepare('manual')
  const claimed = (await f.command('notification.start', { notificationId: 'manual' })).result.notification
  await f.command('notification.receipt', { notificationId: 'manual', dispatchToken: claimed.dispatchToken, state: 'unknown',
    nextAttemptAt: '2099-01-01T00:00:00Z' })
  const pending = f.retry(await f.read('manual'))
  await entered.promise
  await f.prepare('queued')
  await f.service.recover()
  assert.equal((await f.read('queued')).state, 'prepared')
  release.resolve(); await pending
  const deadline = Date.now() + 700
  while ((await f.read('queued')).state !== 'delivered' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await f.read('queued')).state, 'delivered', 'slot release must wake the existing automatic drain without recover/whenIdle')
  assert.deepEqual(sends, ['queued']); assert.deepEqual(reads, ['manual', 'queued'])
})

test('notification service manual recovery cannot race the original automatic send', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  let sends = 0
  const f = await notificationServiceFixture(t, { send: async () => { sends++; entered.resolve(); await release.promise; return { openTaskId: 'accepted' } },
    readback: async () => ({ messageId: 'verified' }) })
  await f.prepare('notice')
  const automatic = f.service.whenIdle()
  await entered.promise
  await assert.rejects(f.retry(await f.read('notice')), { code: 'TASK_NOTIFICATION_RECOVERY_IN_PROGRESS' })
  release.resolve(); await automatic
  assert.equal(sends, 1); assert.equal((await f.read('notice')).state, 'delivered')
})
