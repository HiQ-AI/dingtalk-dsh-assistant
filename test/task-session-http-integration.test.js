import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
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
    taskSessions: { close: noop, cancel: noop, run: async ({ input, delegate, submit, onSessionBound }) => { taskTurns++; await onSessionBound(); if (!input.executions.length) for (let i = 0; i < 53; i++) await delegate({ key: `核对服务${String(i).padStart(2, '0')}`, objective: '检查实际服务状态', context: '只核对', resourceKeys: [] }); await submit({ action: 'wait', summary: '已委派核对，等待确认', evidence: ['fixture-only'], limitations: ['未调用真实模型'] }) } },
    executionSessions: { close: noop, cancel: noop, run: async ({ onSessionBound, onResult, onProgress }) => { await onSessionBound(); await onProgress({ summary: '已读取状态，开始验证', evidence: ['actual-evidence.txt'], activity: '验证状态', reportId: 'http-stage' }); await onResult({ status: 'completed', summary: '核对成功', evidence: ['actual-evidence.txt'], limitations: ['未部署'], artifacts: [] }); return { status: 'submitted' } } },
  })
  const runtime = { ...legacy, listTaskView: () => service.boardTasks(), getTaskSessionDetail: id => service.taskDetail(id), getTaskSessionExecutions: (...args) => service.taskExecutions(...args),
    createTask: args => service.createTask(args), appendTaskContext: args => service.appendTaskContext(args), cancelTask: args => service.cancelTask(args) }
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  try {
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
    assert.equal(page.executions.length, 20)
    const board = await (await fetch(base + '/state/tasks')).json()
    assert.equal(board[0].executionSessions.length, 53)
    assert.equal(new Set(board[0].executionSessions.map(item => item.sessionId)).size, 53)
    assert.deepEqual(board[0].executionSessions, detail.executionSessions)
    assert.ok(board[0].executionSessions.every(item => /^核对服务\d{2}$/.test(item.title)))
    assert.ok(board[0].executionSessions.every(item => item.runTiming.recorded === true && item.runTiming.elapsedMs >= 0 && item.runTiming.startedAt === null))
    assert.ok(board[0].executionSessions.every(item => item.drained === true && item.recovering === false))
    assert.deepEqual((await service.boardTasks())[0].executionSessions, board[0].executionSessions)
    assert.equal(page.executions[0].status, 'succeeded')
    assert.notEqual(page.executions[0].sessionId, sessionId)
    assert.equal(page.executions[0].result.summary, '核对成功')
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
    assert.equal((await (await fetch(base + '/state/tasks')).json()).length, 1)
    assert.equal((await post('/tasks/old/context', { requestId: 'old', progressImpact: 'replan', context: '禁止恢复', expectedRequirementRevision: 1, expectedControlRevision: 1 })).status, 404)
    for (const path of ['/tasks/old/reopen', '/tasks/old/reports/r/retry', '/authorizations/old/decision', '/workflows/message/requests/r/answer']) assert.equal((await post(path, {})).status, 410)
    assert.ok(taskTurns >= 1)
  } finally { await new Promise(resolve => server.close(resolve)); await service.close(); await residentStore.close(); await rm(root, { recursive: true, force: true }) }
})
