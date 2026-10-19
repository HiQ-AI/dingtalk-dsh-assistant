import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, waitUntil, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { requestSystemText } from './fixtures/session-persistence.js'
const call = (name, args) => ({ name, args })
const requestHuman = (audience = 'operator') => call('task_request_human', { audience, reason: '目标环境尚未明确，不能自行扩大授权', question: '请明确本次允许的环境和操作范围', evidence: ['已读取原始交办'], attemptedActions: ['核对现有需求，未执行外部修改'] })
const finish = summary => call('task_session_submit', { decision: { action: 'complete', summary, evidence: ['已核对人工原文和原执行结果'], limitations: [] } })
async function fixture(t, decide, options) {
  const root = await mkdtemp(join(tmpdir(), 'task-human-native-'))
  const h = await nativeTaskHost(root, decide, options)
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return h
}
async function pending(h) { return (await h.service.listAuthorizationRequests()).find(item => item.status === 'waiting-reply') }

test('operator technical reply retains business sources and shared scope protocol in the same resumed execution', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const objective = '测试助手，修复后部署到UAT2，隔离验证，不操作真实申请'
  const reply = '技术已恢复；本答复不新增部署批准，不撤销此前明确交办范围。用户纠正：说了部署到UAT就部署到UAT，这个申请不应该提。'
  const seen = [], scopes = []
  const h = await fixture(t, async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    const input = latestInput(request)
    scopes.push(requestSystemText(request))
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      assert.match(request.tools.find(tool => tool.name === 'task_request_human').description, /已授权的目标持续完成/)
      const execution = input.executions[0]
      if (!execution) return [call('task_delegate', { key: 'prepare', objective: '准备原交付' }), call('task_session_submit', { decision: { action: 'wait', summary: '准备中', evidence: [], limitations: [] } })]
      if (!input.task.humanRequests.length) return [call('task_request_human', { reason: '准备已完成，工具配置需操作人恢复', question: '请恢复原工具配置', evidence: ['原生配置诊断'], attemptedActions: ['原配置检查'] })]
      if (execution.inputVersion === 1) return [call('task_delegate', { executionId: execution.executionId, key: 'continue', objective: '按原来源继续完整UAT交付' }), call('task_session_submit', { decision: { action: 'wait', summary: '沿原执行继续', evidence: [], limitations: [] } })]
      return [finish('原执行已收到完整来源')]
    }
    seen.push(input)
    return [call('execution_submit', { output: { status: 'completed', summary: '测试夹具仅记录输入，没有执行外部部署', evidence: [], limitations: [], artifacts: [] } })]
  }, { config: { webActorId: 'operator-user' } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'business-authorization', senderOpenDingTalkId: 'native-user', text: objective, occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const before = (await h.query('task.list'))[0], original = (await h.query('execution.list'))[0], request = await pending(h)
  await h.service.respondHumanRequest({ taskId: before.taskId, humanRequestId: request.requestId, requestId: 'scope-continuation', reply,
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision })
  await h.service.whenIdle()
  const after = await h.query('task.get', { taskId: before.taskId }), executions = await h.query('execution.list')
  assert.equal(executions.length, 1)
  assert.equal(executions[0].executionId, original.executionId)
  assert.equal(executions[0].sessionId, original.sessionId)
  assert.equal(executions[0].inputVersion, 2)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.humanRequests.length, 1)
  assert.equal(after.humanRequests[0].status, 'answered')
  assert.ok(h.toolResults.some(result => result.name === 'model_content_read'), '超预算上下文经过真实只读工具，不把引用视为已读')
  for (const request of h.requests) for (const message of request.messages.filter(message => message.source?.taskSession))
    assert.ok(Buffer.byteLength(message.content[0].text) <= 3000, '恢复后仍保留Host的UTF8预算')
  assert.equal(seen.at(-1).sources.find(source => source.messageId === 'business-authorization').text, objective)
  assert.equal(seen.at(-1).sources.find(source => source.text === reply).actorId, 'operator-user')
  assert.equal(seen.at(-1).task.objective, after.objective)
  for (const scope of scopes) {
    assert.match(scope, /不自动撤销此前已明确授予的范围/)
    assert.match(scope, /明确暂停、撤销、仅准备或改变目标环境则优先/)
    assert.match(scope, /真实原生权限拒绝和尚未满足的审批条件不得绕过/)
    assert.match(scope, /作出任何授权判断前（包括认定可以继续）/)
    assert.match(scope, /用户说“部署到UAT”就是该任务的UAT部署授权/)
    assert.match(scope, /规则写“需批准”不等于当前“尚未批准”/)
    assert.match(scope, /具体规则、触发条件与已有授权尚缺什么/)
  }
  assert.deepEqual(await h.query('operation.list'), [], '输入与恢复证明不冒充真实发布或工具效果')
})

test('技术申请进入Web和登录人私聊，精确引用及真实作者恢复原任务，零技术群询问', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let ownerTurns = 0, resumed, h
  const sent = []
  h = await fixture(t, async request => {
    const calls = topicTaskCalls(request)
    if (calls) return calls
    if (++ownerTurns === 1) return [call('task_request_human', { audience: 'operator', reason: '原生能力需修复', question: '请恢复GitHub查询能力', evidence: ['已核实Host拒绝'], attemptedActions: ['读取原操作日志'] })]
    resumed = latestInput(request)
    return [finish('人工技术处理结果已接纳')]
  }, { config: { operatorUserId: 'actual-login-user' }, notifications: {
    async send(notification) { sent.push(notification); return { messageId: notification.payload.audience === 'operator' ? 'operator-notice' : `group-${sent.length}` } },
    async readback(notification) { return notification.payload.audience === 'operator'
      ? { messageId: 'operator-notice', conversationId: 'self-private', senderActorId: 'actual-operator', observedAt: new Date().toISOString() }
      : { messageId: notification.ack.messageId, visible: true } },
  } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'business-request', senderOpenDingTalkId: 'native-user', text: '测试助手，核查既有业务目标', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const request = await pending(h), waiting = (await h.query('task.list'))[0]
  assert.equal(request.audience, 'operator')
  assert.equal(request.notification.state, 'delivered')
  assert.equal(sent.find(item => item.payload.audience === 'operator').payload.recipientUserId, 'actual-login-user')
  assert.equal(h.residentStore.getGroup('native-group').outbox.length, 1, '私聊通知不投影为业务群发件箱')
  assert.ok(!h.residentStore.getGroup('native-group').outbox.some(item => item.text.includes('恢复GitHub')))
  const reply = { groupId: 'self-private', messageId: 'human-private-answer', senderOpenDingTalkId: 'actual-operator',
    quotedMessage: { messageId: 'operator-notice' }, text: '技术能力已修复，请沿原任务继续只读核查', occurredAt: new Date().toISOString() }
  for (const change of [{ groupId: 'native-group' }, { senderOpenDingTalkId: 'native-user' }, { quotedMessage: { messageId: 'other' } }])
    await assert.rejects(h.service.respondPrivateHumanReply({ ...reply, ...change }), /DYNAMIC_HUMAN_RESPONSE_FORBIDDEN|TASK_HUMAN_PRIVATE_REQUEST_NOT_FOUND/)
  await h.service.respondPrivateHumanReply(reply); await h.service.whenIdle()
  const completed = (await h.query('task.list'))[0]
  assert.equal(completed.sessionId, waiting.sessionId)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.humanRequests[0].replyChannel, 'private')
  assert.equal(completed.humanRequests[0].actorId, 'actual-operator')
  assert.equal(resumed.sources.find(item => item.messageId === reply.messageId).actorId, 'actual-operator')
  await h.service.respondPrivateHumanReply(reply); await h.service.whenIdle()
  assert.equal(ownerTurns, 2)
  assert.equal(sent.filter(item => item.payload.audience === 'operator').length, 1)
})

test('native human request waits without repeat wakes; authenticated HTTP reply resumes the original session from actual source text', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let turns = 0, replyInput
  const h = await fixture(t, async request => {
    const input = latestInput(request); turns++
    if (turns === 1) return [requestHuman()]
    replyInput = input
    return [finish('仅按人工明确的 UAT3 范围完成核对')]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-native', objective: '按明确范围核对' })
  await h.service.whenIdle()
  const request = await pending(h), waiting = await h.query('task.get', { taskId: created.taskId })
  assert.ok(request)
  assert.equal(waiting.lastDecision.action, 'blocked')
  assert.equal(waiting.drained, true)
  assert.deepEqual(request.attemptedActions, ['核对现有需求，未执行外部修改'])
  for (let i = 0; i < 3; i++) { await h.service.recover(); await h.service.whenIdle() }
  assert.equal(turns, 1)
  const server = createServer((req, res) => handleRequest(req, res, { respondTaskHumanRequest: args => h.service.respondHumanRequest(args) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tasks/${created.taskId}/human-requests/${encodeURIComponent(request.requestId)}/reply`
  const body = { requestId: 'real-human-response', reply: '仅允许 UAT3 的只读核对；不得修改生产或发布', expectedRequirementRevision: waiting.requirementRevision, expectedControlRevision: waiting.controlRevision }
  const forbidden = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://outside.invalid' }, body: JSON.stringify(body) })
  assert.equal(forbidden.status, 403)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  await h.service.whenIdle()
  const completed = await h.query('task.get', { taskId: created.taskId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, waiting.sessionId)
  assert.equal(completed.requirementRevision, 1)
  assert.equal(completed.humanRequests[0].status, 'answered')
  assert.equal(replyInput.sources.find(source => source.text === body.reply)?.actorId, 'native-user')
  assert.ok(!JSON.stringify(replyInput).includes('unlimitedApproval'))
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 0)
})

test('an execution result cannot bypass human waiting; reply reads the original execution and continues the original task', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const released = Promise.withResolvers(); let turns = 0, executionId, afterReply, originalSummary
  t.after(() => released.resolve())
  const h = await fixture(t, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      await released.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行已完成只读核对', evidence: ['原执行事实'], limitations: [], artifacts: [] } })]
    }
    const input = latestInput(request)
    turns++
    if (turns === 1) return [call('task_delegate', { key: 'original-inspection', objective: '只读核对原目标' })]
    if (turns === 2) return [requestHuman()]
    afterReply = input
    const execution = input.executions[0], ref = execution.resultRef ?? input.catalogRef
    const path = (execution.resultRef ? '' : '/executions/' + execution.executionId + '/result') + '/payload/output/summary'
    const page = modelToolValues(request).find(value => value.contentRef === ref.contentRef && value.path === path)
    if (!page) return [call('model_content_read', { contentRef: ref.contentRef, path })]
    originalSummary = page.text
    return [finish('已读取原执行结果并按人工范围收束')]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-execution', objective: '核对原目标，边界不清时申请人工' })
  const request = await waitUntil(() => pending(h), 'persisted human request')
  released.resolve()
  await h.service.whenIdle(); await h.service.recover(); await h.service.whenIdle()
  assert.equal(turns, 2, 'execution-result wake must remain held while waiting for the human reply')
  const [execution] = await h.query('execution.list'); executionId = execution.executionId
  assert.equal(execution.status, 'succeeded')
  const waiting = await h.query('task.get', { taskId: created.taskId })
  await h.service.respondHumanRequest({ taskId: created.taskId, humanRequestId: request.requestId, requestId: 'reply-original-execution', reply: '仅使用现有只读结果，不追加写入', expectedRequirementRevision: waiting.requirementRevision, expectedControlRevision: waiting.controlRevision })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal(afterReply.executions[0].executionId, executionId)
  assert.equal(originalSummary, '原执行已完成只读核对')
  assert.equal((await h.query('execution.list')).length, 1)
})

test('a native blocked decision without a human question is corrected into an explicit durable request', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let steps = 0
  const h = await fixture(t, async request => {
    steps++
    if (steps === 1) return [call('task_session_submit', { decision: { action: 'blocked', summary: '需要人工', evidence: [], limitations: [] } })]
    assert.match(JSON.stringify(request.messages), /blocked requires a specific human question/)
    return [requestHuman()]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'human-correction', objective: '按实际边界处理' })
  await h.service.whenIdle()
  assert.equal(steps, 2)
  const task = await h.query('task.get', { taskId: created.taskId })
  assert.equal(task.humanRequests.length, 1)
  assert.equal(task.humanRequests[0].status, 'waiting-reply')
  assert.equal(task.lastDecision.question, '请明确本次允许的环境和操作范围')
  assert.ok(h.toolResults.some(item => item.name === 'task_session_submit' && item.result.isError))
})

for (const changed of [false, true]) test(`original-group human input preserves clarification but fences explicit authorization change: changed=${changed}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const release = Promise.withResolvers(); t.after(() => release.resolve())
  let ownerTurns = 0, originalTask, originalTopic, answeredInput
  const replyText = '测试助手，本次只允许 UAT3 只读核对，保持现有执行，不得发布生产。'
  const h = await fixture(t, async request => {
    const names = request.tools.map(tool => tool.name)
    if (names.includes('group_topic_route_submit')) {
      const calls = topicTaskCalls(request)
      for (const route of calls[0].args.routes) for (const unit of route.units) unit.topics = [{ topicId: originalTopic }]
      return calls
    }
    if (names.includes('group_decision_submit')) {
      // Reproduce a coordinator slower than the former 100ms executor release.
      if (changed) await new Promise(resolve => setTimeout(resolve, 500))
      const calls = topicTaskCalls(request), submitted = calls[0].args
      submitted.decision.actions = [{ kind: 'task-context', taskId: originalTask.taskId, inputVersion: originalTask.requirementRevision,
        runSequence: originalTask.runSequence, context: replyText, progressImpact: 'preserve', topicRefs: [{ topicId: submitted.topicId, revision: submitted.revision }],
        ...(changed ? { authorizationChange: 'changed', progressImpact: 'replan' } : {}),
        basisUnitRefs: submitted.decision.basisUnitRefs }]
      submitted.decision.reply = '已收到本次范围答复，将沿原任务继续。'
      return calls
    }
    if (!names.includes('task_delegate')) {
      await release.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行按只读范围完成', evidence: ['原执行结果'], limitations: [], artifacts: [] } })]
    }
    const input = latestInput(request); ownerTurns++
    if (ownerTurns === 1) return [call('task_delegate', { key: 'live-original', objective: '保持原有只读核对' })]
    if (ownerTurns === 2) return [requestHuman('requester')]
    if (!input.executions.every(execution => execution.drained)) {
      answeredInput = input
      return [call('task_session_submit', { decision: { action: 'wait', summary: '已读取原群答复，等待原执行完成', evidence: [], limitations: [] } })]
    }
    return [finish('原任务与原执行沿人工明确范围完成')]
  })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'original-group-answer', objective: '原群原任务核对' })
  await waitUntil(() => pending(h), 'human wait before original-group reply')
  originalTask = await h.query('task.get', { taskId: created.taskId }); originalTopic = originalTask.topicRefs[0].topicId
  const [before] = await h.query('execution.list')
  assert.equal(before.drained, false)
  const ingestion = h.service.ingest({ groupId: 'native-group', messageId: 'real-group-human-answer', senderOpenDingTalkId: 'native-user', text: replyText,
    occurredAt: new Date().toISOString(), timestamp: new Date().toISOString() })
  if (changed) {
    // Keep the provider live until cancellation is actually requested, then let Host drain it.
    await waitUntil(async () => (await h.query('execution.list')).find(execution => execution.executionId === before.executionId)?.cancelRequested,
      'original execution receives authorization cancellation')
    release.resolve()
    await ingestion; await h.service.whenIdle()
    const task = await h.query('task.get', { taskId: created.taskId }), [execution] = await h.query('execution.list')
    assert.equal(task.requirementRevision, originalTask.requirementRevision + 1)
    assert.equal(task.humanRequests[0].status, 'superseded')
    assert.equal(execution.cancelRequested, true)
    assert.equal(execution.result.current, false)
    return
  }
  await ingestion
  await waitUntil(() => answeredInput, 'owner receives authenticated group answer').catch(async error => {
    error.message += JSON.stringify({ toolErrors: h.toolResults.filter(item => item.name === 'group_decision_submit').slice(-1),
      alerts: await h.service.listAlerts(), task: (await h.query('task.get', { taskId: created.taskId })).humanRequests,
      topics: h.residentStore.listTopics('native-group').map(topic => ({ id: topic.topicId, decisions: topic.decisions?.map(decision => ({ status: decision.status, error: decision.error })) })) })
    throw error
  })
  const answered = await h.query('task.get', { taskId: created.taskId }), [stillLive] = await h.query('execution.list')
  assert.equal(answered.humanRequests[0].status, 'answered')
  assert.equal(answered.humanRequests[0].actorId, 'native-user')
  assert.equal(answered.requirementRevision, originalTask.requirementRevision)
  assert.equal(answered.controlRevision, originalTask.controlRevision)
  assert.equal(answered.sessionId, originalTask.sessionId)
  assert.equal(stillLive.executionId, before.executionId)
  assert.equal(stillLive.sessionId, before.sessionId)
  assert.equal(stillLive.cancelRequested, false)
  assert.equal(stillLive.drained, false)
  assert.equal(answeredInput.sources.find(source => source.messageId === 'real-group-human-answer')?.text, replyText)
  assert.equal(answered.topicRefs[0].topicId, originalTopic)
  assert.ok(answered.appliedOperations.length > originalTask.appliedOperations.length)
  release.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 1)
})

test('Web answer recalls its delivered operator notification once without recalling group replies', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  let turns = 0
  const recalls = []
  const h = await fixture(t, async request => {
    const routed = topicTaskCalls(request)
    if (routed) return routed
    return ++turns === 1 ? [requestHuman()] : [finish('已按人工答复继续')]
  }, { config: { operatorUserId: 'login', webActorId: 'web-user' }, notifications: {
    async send(notification) { return { messageId: notification.id } },
    async readback(notification) { return { messageId: notification.id, conversationId: notification.payload.audience === 'operator' ? 'self-private' : 'native-group', senderActorId: 'login', visible: true } },
    async recall(notification) { recalls.push(notification); return { ...notification.receipt, recallStatus: 'SUCCESS' } },
  } })
  await h.service.ingest({ groupId: 'native-group', messageId: 'request', senderOpenDingTalkId: 'native-user', text: '测试助手，检查原业务需求', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const request = await pending(h), task = (await h.query('task.list'))[0]
  const reply = { taskId: task.taskId, humanRequestId: request.requestId, requestId: 'web-reply', reply: '已修复原能力',
    expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision }
  await Promise.all([h.service.respondHumanRequest(reply), h.service.respondHumanRequest(reply)])
  await h.service.whenIdle()
  await h.service.respondHumanRequest(reply)
  await h.service.whenIdle()
  assert.equal(recalls.length, 1)
  assert.equal(recalls[0].payload.humanRequestId, request.requestId)
  assert.equal(recalls[0].payload.audience, 'operator')
  assert.equal(recalls[0].receipt.conversationId, 'self-private')
  const answered = (await h.service.listAuthorizationRequests()).find(item => item.requestId === request.requestId)
  assert.equal(answered.status, 'answered')
  assert.equal(answered.notification.recall.state, 'recalled')
})
