import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LlmRuntime, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { openResidentStore, resolveTopicMessages } from '../packages/dingtalk-dsh-assistant/store.js'
import { boundedTopicContext, createTopicCoordinator, projectTopicContext, TASK_REVIEW_MAX_CHARS } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { visiblePromptRefs, visibleSectionLength, compactSectionValue } from '../packages/dingtalk-dsh-assistant/coordination-context.js'
import { stagePlanFor } from '../packages/dingtalk-dsh-assistant/task-input-revision.js'

function memoryFacility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'topic-test' })
}
async function setup(t, options = {}) {
  const snapshot = options.snapshot ?? { tables: {}, global: null }
  const store = await openResidentStore(memoryFacility(snapshot))
  if (!store.getGroup('g')) await store.subscribe({ groupId: 'g', responsibility: '处理测试任务' })
  await store.setAgentNames(['助理'])
  const sent = [], errors = [], tools = new Map(), applications = []
  const consumedEvents = []
  const agent = { session: options.session ?? { snapshotEvents: () => consumedEvents }, inbox: options.inbox, steer(message) { consumedEvents.push({ type: 'user/message', data: message }); sent.push(message.content[0].text); options.onSteer?.(message) }, whenIdle: options.whenIdle ?? (() => new Promise(() => {})) }
  const coordinator = createTopicCoordinator({
    taskFacts: options.taskFacts, fixedTopicsEnabled: options.fixedTopicsEnabled, workflowPromptsEnabled: options.workflowPromptsEnabled, dispatchRequest: options.dispatchRequest, checkStartupRecovery: options.checkStartupRecovery, quotedReminderContext: options.quotedReminderContext,
    store, getAgent: () => agent, assertSession(exec, groupId) { if (exec?.groupId !== groupId) throw new Error('wrong_session') },
    serializeTasks: options.serializeTasks ?? ((fn) => fn()), isClosing: options.isClosing ?? (() => false), retryDelayMs: options.retryDelayMs ?? 60_000,
    reviewCandidates: options.reviewCandidates ?? (() => []), onDecisionRequest: options.onDecisionRequest, maxRequestAttempts: options.maxRequestAttempts ?? 3,
    validateReplyReview(review, candidates) {
      if (candidates.length && (!review || candidates.some((item) => !review.reviewedOutboundIds?.includes(item.outboundId)))) throw new Error('incomplete_review')
      return review
    },
    appendOutbox: async (outbound) => { await options.beforeAppend?.(); return store.appendOutbox(outbound) }, cancelTask: options.cancelTask ?? (() => {}), onError(_groupId, error) { errors.push(error); options.onError?.(error) },
    async applyAction(groupId, action, operation) {
      if (action.kind === 'task-proposal') return
      applications.push(operation.operationId)
      await options.beforeAction?.(operation)
      if (action.kind === 'new-task') await store.createTask({ groupId, taskId: operation.taskId, operationId: operation.operationId, ...action })
      else await store.applyTaskOperation({ taskId: action.taskId, operationId: operation.operationId, expectedInputVersion: action.inputVersion, expectedRunSequence: action.runSequence, transform: (task) => ({ ...task, inputVersion: task.inputVersion + 1, topicRefs: action.topicRefs }) })
      await options.afterAction?.(operation)
    },
  })
  coordinator.register({ tools: { register(tool) { tools.set(tool.name, tool) } } }, 'g', options.scope)
  t.after(async () => { await coordinator.close(); await store.close() })
  return { store, snapshot, coordinator, sent, errors, applications, tools,
    rawCall: (name, args, exec = { groupId: 'g' }) => tools.get(name).execute(args, exec),
    async call(name, args, exec = { groupId: 'g' }) {
      const result = await tools.get(name).execute(args, exec)
      if (name !== 'group_topic_route_submit' || result.status !== 'accepted') return result
      const receipt = store.getGroup('g').routeHistory.find((item) => item.routeId === args.requestId)
      const pendingDecisions = (await coordinator.schedule('g')).map((item) => ({ ...item, messages: resolveTopicMessages(store.getGroup('g'), item.topicId, item.revision) }))
      return { ...result, topicIdsByKey: receipt?.topicIdsByKey ?? {}, pendingDecisions }
    },
    envelope(prefix, label = 'Topic 请求') { const text = sent.findLast((item) => item.startsWith(prefix)); return text ? JSON.parse(text.split('\n').find((line) => line.startsWith(`${label}：`)).slice(label.length + 1)) : undefined },
  }
}
async function assertDecisionIssue(promise, pattern) {
  const result = await promise
  assert.equal(result.status, 'invalid-arguments')
  assert.ok(result.issues.some(issue => pattern.test(issue.code)), JSON.stringify(result))
}
async function ingest(h, messageId, extra = {}) {
  await h.store.ingest({ groupId: 'g', messageId, text: `@助理 ${messageId}`, senderOpenDingTalkId: 'od-a', occurredAt: '2026-09-07T00:00:00Z', ...extra })
}

const settleStartup = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
const startupFailure = () => Object.assign(new Error('agent preset invalid'), { coordinationStartupFailure: true, code: 'agent-preset/invalid' })
const pendingStartupAgent = () => ({ whenIdle: () => new Promise(() => {}) })

test('启动失败持久退避，预设未恢复不派发，到期沿原请求恢复并清除故障', async t => {
  let available = false, broken = true
  const dispatched = [], checked = []
  const h = await setup(t, { retryDelayMs: 60_000,
    checkStartupRecovery: async (groupId, requestId) => { checked.push([groupId, requestId]); return available },
    dispatchRequest: async (request, message) => { dispatched.push({ requestId: request.requestId, messageId: message.id }); if (broken) throw startupFailure(); return pendingStartupAgent() },
  })
  await ingest(h, 'startup-original'); await h.coordinator.schedule('g'); await settleStartup()
  const requestId = dispatched[0].requestId
  let state = h.store.getCoordinationRequest('g', requestId)
  assert.equal(state.status, 'exhausted'); assert.equal(state.failurePhase, 'startup')
  assert.equal(state.failureCode, 'agent-preset/invalid'); assert.equal(state.startupAttempt, 1)
  assert.equal(state.attempt, 0); assert.equal(state.messageId, undefined)
  assert.ok(Date.parse(state.nextRetryAt) > Date.now())
  await h.coordinator.recover(); await settleStartup()
  assert.equal(dispatched.length, 1, '未到期不重新创建句柄')
  await h.store.updateCoordinationRequest('g', requestId, { nextRetryAt: new Date(0).toISOString() })
  await h.coordinator.recover(); await settleStartup()
  assert.equal(dispatched.length, 1, '预设仍无效不派发')
  assert.deepEqual(checked.at(-1), ['g', requestId])
  available = true; broken = false
  await h.coordinator.recover(); await settleStartup()
  assert.deepEqual(dispatched, [dispatched[0], dispatched[0]], '原请求与输入 ID 原样接续')
  state = h.store.getCoordinationRequest('g', requestId)
  assert.equal(state.status, 'pending'); assert.equal(state.attempt, 0)
  assert.equal(state.failurePhase, undefined); assert.equal(state.failureCode, undefined)
  assert.equal(state.startupAttempt, undefined); assert.equal(state.nextRetryAt, undefined)
})

test('重启保留启动退避，校验异常保留原故障，历史零输入失败可恢复', async t => {
  const calls = []
  const h = await setup(t, { dispatchRequest: async request => { calls.push(request.requestId); throw startupFailure() } })
  await ingest(h, 'startup-restart'); await h.coordinator.schedule('g'); await settleStartup()
  const requestId = calls[0], saved = structuredClone(h.store.getCoordinationRequest('g', requestId))
  await h.coordinator.close(); await h.store.close()
  let checkThrows = true
  const reopened = await setup(t, { snapshot: h.snapshot,
    checkStartupRecovery: async () => { if (checkThrows) throw new Error('preset service unavailable'); return true },
    dispatchRequest: async request => { calls.push(request.requestId); return pendingStartupAgent() },
  })
  await reopened.coordinator.recover(); await settleStartup()
  assert.equal(calls.length, 1)
  assert.equal(reopened.store.getCoordinationRequest('g', requestId).nextRetryAt, saved.nextRetryAt)
  await reopened.store.updateCoordinationRequest('g', requestId, { nextRetryAt: new Date(0).toISOString() })
  await assert.rejects(reopened.coordinator.recover(), /preset service unavailable/); await settleStartup()
  assert.equal(calls.length, 1)
  assert.equal(reopened.store.getCoordinationRequest('g', requestId).failurePhase, 'startup')
  assert.equal(reopened.store.getCoordinationRequest('g', requestId).lastError, saved.lastError)
  // 历史记录没有新分类字段，只有 attempt=0 且没有已派发输入才能接回。
  await reopened.store.updateCoordinationRequest('g', requestId, { failurePhase: undefined, failureCode: undefined, startupAttempt: undefined })
  checkThrows = false
  await reopened.coordinator.recover(); await settleStartup()
  assert.deepEqual(calls, [requestId, requestId])
})

test('普通协议耗尽与已派发后失败均不被启动补偿重放', async t => {
  const calls = []
  const h = await setup(t, { checkStartupRecovery: async () => true,
    dispatchRequest: async request => { calls.push(request.requestId); throw new Error('after dispatch failure') },
  })
  await ingest(h, 'protocol-exhausted'); await h.coordinator.schedule('g'); await settleStartup()
  const requestId = calls[0]
  const failed = h.store.getCoordinationRequest('g', requestId)
  assert.equal(failed.failurePhase, 'dispatch')
  assert.equal(failed.attempt, 0); assert.equal(failed.messageId, undefined)
  await h.coordinator.recover(); await settleStartup()
  assert.equal(calls.length, 1, '新派发 Promise 普通拒绝不可冒充旧版未分类启动错误')
  await h.store.updateCoordinationRequest('g', requestId, { status: 'exhausted', attempt: 3, messageId: `message-${requestId}`, nextRetryAt: new Date(0).toISOString() })
  await h.coordinator.recover(); await settleStartup()
  assert.equal(calls.length, 1)
  await h.store.updateCoordinationRequest('g', requestId, { attempt: 0 })
  await h.coordinator.recover(); await settleStartup()
  assert.equal(calls.length, 1, '有已派发 messageId 的零次协议请求也不能当作历史启动失败')
  assert.equal(h.store.getCoordinationRequest('g', requestId).failurePhase, 'dispatch')
  await h.store.updateCoordinationRequest('g', requestId, { failurePhase: 'startup', failureCode: 'agent-preset/invalid', startupAttempt: 1 })
  await h.coordinator.recover(); await settleStartup()
  assert.equal(calls.length, 1, '已有 messageId 时即使后来出现启动错误也不能自动重放')
})

test('连续启动失败增加独立退避次数，并发恢复只派发一次', async t => {
  const calls = []
  const h = await setup(t, { retryDelayMs: 60_000, checkStartupRecovery: async () => true,
    dispatchRequest: async request => { calls.push(request.requestId); throw startupFailure() },
  })
  await ingest(h, 'startup-concurrent'); await h.coordinator.schedule('g'); await settleStartup()
  const requestId = calls[0]
  await h.store.updateCoordinationRequest('g', requestId, { nextRetryAt: new Date(0).toISOString() })
  const before = Date.now()
  await Promise.all([h.coordinator.recover(), h.coordinator.recover()]); await settleStartup()
  assert.deepEqual(calls, [requestId, requestId])
  const state = h.store.getCoordinationRequest('g', requestId)
  assert.equal(state.startupAttempt, 2); assert.equal(state.attempt, 0)
  assert.ok(Date.parse(state.nextRetryAt) >= before + 120_000)
  assert.ok(Date.parse(state.nextRetryAt) <= Date.now() + 120_000)
  await h.store.updateCoordinationRequest('g', requestId, { startupAttempt: 10, nextRetryAt: new Date(0).toISOString() })
  const cappedBefore = Date.now()
  await h.coordinator.recover(); await settleStartup()
  const capped = h.store.getCoordinationRequest('g', requestId)
  assert.equal(capped.startupAttempt, 11); assert.equal(capped.attempt, 0)
  assert.ok(Date.parse(capped.nextRetryAt) >= cappedBefore + 300_000)
  assert.ok(Date.parse(capped.nextRetryAt) <= Date.now() + 300_000)
})

test('manual request recovery fences message version, units and request token and coalesces repeated clicks', async t => {
  let offline = true
  const h = await setup(t, { dispatchRequest: async () => { if (offline) throw startupFailure(); return pendingStartupAgent() } })
  await ingest(h, 'manual-recovery'); await h.coordinator.schedule('g'); await settleStartup()
  const first = h.coordinator.messageProcessingRequests('g')[0]
  const args = { groupId: 'g', messageId: 'manual-recovery', messageVersion: 1, activeUnitRefs: [], requestId: first.requestId, token: first.retryToken }
  await assert.rejects(h.coordinator.retryMessageRequest({ ...args, messageVersion: 2 }), /MESSAGE_RETRY_STALE/)
  await assert.rejects(h.coordinator.retryMessageRequest({ ...args, activeUnitRefs: [{ unitId: 'foreign', unitRevision: 1 }] }), /MESSAGE_RETRY_STALE/)
  await assert.rejects(h.coordinator.retryMessageRequest({ ...args, token: 'old' }), /MESSAGE_RETRY_STALE/)
  const results = await Promise.allSettled([h.coordinator.retryMessageRequest(args), h.coordinator.retryMessageRequest(args)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  await settleStartup()
  const second = h.coordinator.messageProcessingRequests('g')[0]
  assert.equal(second.status, 'exhausted'); assert.notEqual(second.retryToken, first.retryToken)
  await assert.rejects(h.coordinator.retryMessageRequest(args), /MESSAGE_RETRY_STALE/)
  offline = false
  await h.coordinator.retryMessageRequest({ ...args, token: second.retryToken }); await settleStartup()
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].status, 'pending')
  await assert.rejects(h.coordinator.retryMessageRequest({ ...args, token: second.retryToken }), /MESSAGE_RETRY_STALE/)
  assert.equal(h.store.getGroup('g').messages.length, 1)
})

test('messageProcessingRequests preserves startup compensation and exposes only detached read-only fields', async t => {
  const h = await setup(t, { dispatchRequest: async () => { throw startupFailure() } })
  await ingest(h, 'request-private', { text: 'PRIVATE-BODY', senderOpenDingTalkId: 'PRIVATE-ACTOR' })
  await h.coordinator.schedule('g'); await settleStartup()
  const before = structuredClone(h.snapshot), sent = h.sent.length, errors = h.errors.length
  const requestId = Object.keys(h.store.getGroup('g').coordinationRequests)[0]
  const [request] = h.coordinator.messageProcessingRequests('g')
  assert.deepEqual(request, { requestId, groupId: 'g', status: 'exhausted', attempt: 0, failurePhase: 'startup',
    nextRetryAt: h.store.getCoordinationRequest('g', requestId).nextRetryAt, retryToken: request.retryToken,
    messages: [{ messageId: 'request-private', messageVersion: 1 }] })
  assert.ok(Date.parse(request.nextRetryAt) > Date.now())
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE|lastError|failureCode|sender|text/)
  request.messages[0].messageId = 'tampered'; request.messages.push({ messageId: 'foreign', messageVersion: 1 })
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].messages[0].messageId, 'request-private')
  assert.deepEqual(h.snapshot, before); assert.equal(h.sent.length, sent); assert.equal(h.errors.length, errors)
  assert.deepEqual(h.coordinator.messageProcessingRequests('other-group'), [])
})

test('messageProcessingRequests classifies legacy zero-input exhaustion by the existing startup recovery rule', async t => {
  const h = await setup(t, { dispatchRequest: async () => { throw startupFailure() } })
  await ingest(h, 'legacy-startup'); await h.coordinator.schedule('g'); await settleStartup()
  const id = Object.keys(h.store.getGroup('g').coordinationRequests)[0]
  await h.store.updateCoordinationRequest('g', id, { failurePhase: undefined, failureCode: undefined, startupAttempt: undefined })
  const before = structuredClone(h.snapshot), persisted = h.store.getCoordinationRequest('g', id)
  assert.equal(persisted.status, 'exhausted'); assert.equal(persisted.attempt, 0)
  assert.equal(persisted.messageId, undefined); assert.ok(persisted.nextRetryAt)
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].failurePhase, 'startup')
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].nextRetryAt, persisted.nextRetryAt)
  assert.deepEqual(h.snapshot, before)
  await h.store.updateCoordinationRequest('g', id, { messageId: 'already-dispatched' })
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].failurePhase, null)
  await h.store.updateCoordinationRequest('g', id, { messageId: undefined, attempt: 3 })
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].failurePhase, null)
  await h.store.updateCoordinationRequest('g', id, { attempt: 0, failurePhase: 'dispatch' })
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].failurePhase, 'dispatch')
})

test('messageProcessingRequests route scope requires current unrouted message versions and live status', async t => {
  const h = await setup(t)
  await ingest(h, 'route-current'); await ingest(h, 'route-other'); await h.coordinator.schedule('g'); await settleStartup()
  const id = h.envelope('[GROUP_TOPIC_ROUTE]').requestId
  assert.deepEqual(h.coordinator.messageProcessingRequests('g')[0].messages,
    [{ messageId: 'route-current', messageVersion: 1 }, { messageId: 'route-other', messageVersion: 1 }])
  await ingest(h, 'route-current', { text: 'new exact version', messageVersion: 2 })
  assert.equal(h.store.getGroup('g').messages.find(message => message.messageId === 'route-current').messageVersion, 2)
  assert.deepEqual(h.coordinator.messageProcessingRequests('g')[0].messages, [{ messageId: 'route-other', messageVersion: 1 }])
  await h.store.updateCoordinationRequest('g', id, { status: 'completed' })
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [])
  await h.store.updateCoordinationRequest('g', id, { status: 'superseded' })
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [])
  await h.store.updateCoordinationRequest('g', id, { status: 'pending' })
  await h.store.routeMessages({ groupId: 'g', routeId: 'route-outside-runtime', routingRevision: h.store.getGroup('g').routingRevision,
    routes: [{ messageId: 'route-other', messageVersion: 1, topics: [], reason: 'background only' }] })
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [])
})

test('messageProcessingRequests decision scope includes only current unprocessed delta units', async t => {
  const h = await setup(t)
  await ingest(h, 'history')
  const first = (await route(h)).pendingDecisions[0]
  await complete(h, first)
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [])
  await ingest(h, 'current', { text: 'PRIVATE-ONE;PRIVATE-TWO', senderOpenDingTalkId: 'PRIVATE-ACTOR' })
  await h.coordinator.schedule('g')
  const routing = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.call('group_topic_route_submit', { requestId: routing.requestId, routes: [{ messageId: 'current', messageVersion: 1, ignoredRefs: [], units: [
    { unitKey: 'one', summary: 'one', sourceRefs: [{ quote: 'PRIVATE-ONE;' }], topics: [{ topicId: first.topicId }] },
    { unitKey: 'two', summary: 'two', sourceRefs: [{ quote: 'PRIVATE-TWO' }], topics: [{ topicId: first.topicId }] },
  ] }] })
  await settleStartup()
  const current = h.envelope('[GROUP_TOPIC_DECISION]'), topic = h.store.getTopic('g', first.topicId)
  const expected = h.store.getGroup('g').messages.find(message => message.messageId === 'current').activeUnitRefs
    .map(ref => ({ messageId: 'current', messageVersion: 1, ...ref }))
  const [request] = h.coordinator.messageProcessingRequests('g')
  assert.deepEqual(request, { requestId: current.requestId, groupId: 'g', topicId: topic.topicId, revision: topic.revision,
    status: 'pending', attempt: 0, failurePhase: null, nextRetryAt: null, retryToken: request.retryToken, messages: expected })
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE|history|original|sender|text|lastError/)
  await h.store.updateCoordinationRequest('g', request.requestId, { status: 'exhausted', attempt: 3, failurePhase: 'dispatch', lastError: 'PRIVATE-ERROR' })
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].status, 'exhausted')
  assert.equal(h.coordinator.messageProcessingRequests('g')[0].attempt, 3)
  await ingest(h, 'current', { text: 'new version', messageVersion: 2 })
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [], 'old source facts cannot label the new message version')
})

test('messageProcessingRequests excludes replaced Topic revisions and removed Unit ownership before rescheduling', async t => {
  const h = await setup(t)
  await ingest(h, 'same-version', { text: 'source text' })
  const first = (await route(h)).pendingDecisions[0]
  const old = h.coordinator.messageProcessingRequests('g')[0]
  await h.store.routeMessages({ groupId: 'g', routeId: 'revise-unit', routingRevision: h.store.getGroup('g').routingRevision,
    routes: [{ messageId: 'same-version', messageVersion: 1, ignoredRefs: [], units: [{ unitKey: 'whole-message', summary: 'revised semantic unit',
      sourceRefs: [{ quote: 'source text' }], topics: [{ newTopicKey: 'replacement', title: 'replacement' }] }] }] })
  assert.deepEqual(h.coordinator.messageProcessingRequests('g'), [])
  await h.coordinator.schedule('g'); await settleStartup()
  const requests = h.coordinator.messageProcessingRequests('g')
  assert.equal(requests.some(request => request.requestId === first.requestId), false)
  const messages = requests.flatMap(request => request.messages)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].unitId, old.messages[0].unitId)
  assert.equal(messages[0].unitRevision, old.messages[0].unitRevision + 1)
  assert.equal(messages[0].messageVersion, 1)
})

for (const kind of ['route', 'decision']) test(`messageProcessingRequests rebuilds ${kind} scope for legacy exhausted state without replay`, async t => {
  const h = await setup(t)
  await ingest(h, 'restart-current')
  if (kind === 'decision') await route(h)
  else await h.coordinator.schedule('g')
  await settleStartup()
  const id = h.envelope(kind === 'route' ? '[GROUP_TOPIC_ROUTE]' : '[GROUP_TOPIC_DECISION]').requestId
  await h.store.updateCoordinationRequest('g', id, { status: 'exhausted', attempt: 3, lastError: 'PRIVATE-OLD-ERROR' })
  const persisted = structuredClone(h.store.getCoordinationRequest('g', id))
  assert.equal(persisted.topicId, undefined); assert.equal(persisted.messages, undefined)
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await reopened.coordinator.recover(); await settleStartup()
  const recovered = structuredClone(reopened.store.getCoordinationRequest('g', id))
  const [request] = reopened.coordinator.messageProcessingRequests('g')
  assert.equal(request.requestId, id); assert.equal(request.status, 'exhausted'); assert.equal(request.attempt, 3)
  assert.equal(request.failurePhase, null); assert.equal(request.nextRetryAt, null)
  assert.equal(request.messages[0].messageId, 'restart-current'); assert.equal(request.messages[0].messageVersion, 1)
  assert.equal(!!request.topicId, kind === 'decision')
  assert.equal(Number.isInteger(request.messages[0].unitRevision), kind === 'decision')
  assert.deepEqual(reopened.sent, [], 'snapshot and recovery do not resend exhausted protocol input')
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE|lastError|text|sender/)
  assert.deepEqual(reopened.store.getCoordinationRequest('g', id), recovered)
  assert.equal(recovered.status, persisted.status); assert.equal(recovered.attempt, persisted.attempt)
  assert.equal(recovered.messageId, persisted.messageId)
})

test('Topic 固定版本投影在摘要缺失时仍是无损 JSON', () => {
  const projected = projectTopicContext({
    groupId: 'g', topicId: 'topic-a', revision: 1, messages: [{ messageId: 'm', quotedMessage: undefined, imageRefs: [{ id: 'a', optional: undefined }] }], total: 1, offset: 0, limit: 50, taskRefs: [],
    topic: { topicId: 'topic-a', title: 'A', revision: 1, processedRevision: 0, status: 'active', summary: undefined, summaryRevision: 0, openQuestions: [], decisions: [] },
  })
  assert.equal('summary' in projected.topic, false)
  assert.equal('quotedMessage' in projected.messages[0], false)
  assert.equal('optional' in projected.messages[0].imageRefs[0], false)
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected)
})

test('Topic 工具统一返回 lossless JSON', async (t) => {
  const h = await setup(t)
  await ingest(h, 'lossless')
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'lossless', messageVersion: 1, topics: [{ newTopicKey: 'lossless', title: '无损输出' }],
  }] })
  assert.deepEqual(JSON.parse(JSON.stringify(routed)), routed)
  const recovered = await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'lossless', messageVersion: 1, topics: [{ newTopicKey: 'lossless', title: '无损输出' }],
  }] })
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.requestId, routed.requestId)
  assert.ok(Buffer.byteLength(JSON.stringify(routed), 'utf8') <= 1024)
  const reviewed = await h.call('group_topic_route_review', { messageIds: ['lossless'], reason: '核验输出投影' })
  assert.deepEqual(JSON.parse(JSON.stringify(reviewed)), reviewed)
})

test('工具参数错误返回精简字段问题且不产生副作用', async (t) => {
  const h = await setup(t)
  await ingest(h, 'invalid')
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [], extra: 'unexpected' })
  assert.equal(result.status, 'invalid-arguments')
  assert.equal(result.nextAction, 'correct-arguments')
  assert.ok(result.issues.length > 0 && result.issues.length <= 8)
  assert.equal(h.store.listTopics('g').length, 0)
})

test('联合分支错误返回具体多余字段和动作路径，不只返回 Invalid input', async t => {
  const h = await setup(t)
  const input = { requestId: 'invalid', topicId: 'invalid', revision: 1,
    decision: { basisMessageIds: ['m'], actions: [], reply: '收到', reason: '不能混用两个分支' } }
  const result = await h.rawCall('group_decision_submit', input)
  assert.equal(result.status, 'invalid-arguments')
  assert.ok(result.issues.some(issue => issue.path === 'decision.reason' && issue.code === 'unrecognized_keys' && issue.branch))
  assert.ok(result.issues.some(issue => issue.path === 'decision.reply' && issue.branch))
  const invalidAction = await h.rawCall('group_decision_submit', { ...input, decision: { basisMessageIds: ['m'], actions: [{ kind: 'unknown-action' }], reply: '收到' } })
  assert.ok(invalidAction.issues.some(issue => issue.path.startsWith('decision.actions.0')))
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('归类期间消息版本变化返回刷新后的当前请求', async (t) => {
  const h = await setup(t)
  await ingest(h, 'edited', { text: '@助理 初始内容' })
  await h.coordinator.schedule('g')
  const original = h.envelope('[GROUP_TOPIC_ROUTE]')
  await ingest(h, 'edited', { text: '@助理 初始内容', senderName: '发送人' })
  const result = await h.call('group_topic_route_submit', { requestId: original.requestId, routes: [{ messageId: 'edited', messageVersion: 1, topics: [{ newTopicKey: 'edited', title: '消息修改' }] }] })
  assert.equal(result.status, 'stale')
  assert.equal(result.reason, 'message-version-changed')
  assert.equal(result.currentRequest.requestId, h.envelope('[GROUP_TOPIC_ROUTE]').requestId)
  assert.equal(h.envelope('[GROUP_TOPIC_ROUTE]').messages[0].messageVersion, 2)
  assert.equal(h.store.listTopics('g').length, 0)
})
async function route(h, choices = {}) {
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  for (const message of request.messages.filter((item) => item.textHasMore)) {
    let offset = message.text.length
    while (offset < message.textTotal) offset = (await h.call('group_topic_route_context_get', { requestId: request.requestId, messageId: message.messageId, offset })).nextOffset
  }
  return h.call('group_topic_route_submit', { requestId: request.requestId, routes: request.messages.map((message) => ({ messageId: message.messageId, messageVersion: message.messageVersion, topics: [typeof choices[message.messageId] === 'string' ? { topicId: choices[message.messageId] } : choices[message.messageId] ?? { newTopicKey: message.messageId, title: message.messageId }] })) })
}
const submission = (request, patch = {}) => ({ requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { basisMessageIds: [request.messages.at(-1)?.messageId ?? request.removedMessageIds?.[0]], ...(patch.reply ? { replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] }, ...(!Object.hasOwn(patch, 'replyToMessageId') ? { replyToMessageId: request.messages.at(-1)?.messageId } : {}) } : {}), actions: [], ...(patch.reply === undefined ? { reason: '无需回复' } : {}), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } })

test('多依据普通回复应指向语义接收人而非最后解释者', async t => {
  const h = await setup(t)
  await ingest(h, 'request-a', { text: '@助理 请核对这个事项。', senderOpenDingTalkId: 'user-a', senderName: '请求人A' })
  await ingest(h, 'explanation-b', { text: '补充说明：材料已准备。', senderOpenDingTalkId: 'user-b', senderName: '解释人B' })
  const routed = await route(h, { 'request-a': { newTopicKey: 'same', title: '材料核对' }, 'explanation-b': { newTopicKey: 'same', title: '材料核对' } })
  const request = routed.pendingDecisions[0]
  const result = await h.call('group_decision_submit', submission(request, { basisMessageIds: ['request-a', 'explanation-b'],
    reply: '已收到，将核对材料。', replyToMessageId: 'request-a', atOpenDingTalkIds: ['user-a'],
    replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } }))
  assert.equal(result.status, 'accepted')
  await h.coordinator.drain('g')
  const replies = h.store.getGroup('g').outbox
  assert.equal(replies.length, 1)
  assert.equal(replies[0].replyToMessageId, 'request-a')
  assert.deepEqual(replies[0].atOpenDingTalkIds, ['user-a'])
})

test('普通回复只接受固定Topic真人来源及受信参与者收件人', async t => {
  for (const [label, routing, error] of [
    ['缺少目标', { replyToMessageId: undefined }, /group_reply_routing_required/],
    ['目标不在话题', { replyToMessageId: 'other-group-message' }, /group_reply_routing_required|group_reply_target_not_in_topic/],
    ['收件人不在话题', { replyToMessageId: 'source-a', atOpenDingTalkIds: ['other-group-user'] }, /group_reply_recipient_not_in_topic/],
    ['引用作者不在收件集合', { replyToMessageId: 'source-a', atOpenDingTalkIds: [] }, /group_reply_quote_author_not_in_recipients/],
  ]) {
    await t.test(label, async t => {
      const h = await setup(t)
      await ingest(h, 'source-a', { senderOpenDingTalkId: 'user-a' })
      const request = (await route(h)).pendingDecisions[0]
      await assertDecisionIssue(h.call('group_decision_submit', submission(request, { reply: '收到。', ...routing })), error)
      await h.coordinator.drain('g')
      assert.equal(h.store.getGroup('g').outbox.length, 0)
      assert.equal(h.applications.length, 0)
    })
  }
})

test('引用默认通知作者、重复身份去重，明确空收件人仅普通消息可用', async t => {
  for (const [label, recipients, quoted, expected] of [['省略', undefined, true, ['user-a']],
    ['重复身份', ['user-a', 'user-a'], true, ['user-a']], ['空数组普通消息', [], false, []]]) {
    await t.test(label, async t => {
      const h = await setup(t)
      await ingest(h, 'source-a', { senderOpenDingTalkId: 'user-a' })
      await ingest(h, 'source-b', { senderOpenDingTalkId: 'user-b' })
      const choices = { 'source-a': { newTopicKey: 'same', title: '核对' }, 'source-b': { newTopicKey: 'same', title: '核对' } }
      const request = (await route(h, choices)).pendingDecisions[0]
      const result = await h.call('group_decision_submit', submission(request, { basisMessageIds: ['source-a', 'source-b'], reply: '收到。', replyToMessageId: quoted ? 'source-a' : undefined, atOpenDingTalkIds: recipients }))
      assert.equal(result.status, 'accepted')
      await h.coordinator.drain('g')
      assert.equal(h.store.getGroup('g').outbox[0].replyToMessageId, quoted ? 'source-a' : undefined)
      assert.deepEqual(h.store.getGroup('g').outbox[0].atOpenDingTalkIds ?? [], expected)
    })
  }
})

test('引用其他人消息或外群助手消息不取得本群回复归属', async t => {
  const h = await setup(t)
  await h.store.subscribe({ groupId: 'other' })
  await h.store.appendOutbox({ groupId: 'other', sourceMessageId: 'other-source', outboundId: 'other-outbound', text: '外群通知' })
  await h.store.acknowledge({ groupId: 'other', outboundId: 'other-outbound', deliveredMessageId: 'other-delivered' })
  await ingest(h, 'human-quote', { senderOpenDingTalkId: 'user-a', senderName: '同名成员', quotedMessage: { messageId: 'human-message', content: '其他人消息' } })
  await ingest(h, 'cross-group-quote', { senderOpenDingTalkId: 'user-b', senderName: '同名成员', quotedMessage: { messageId: 'other-delivered', content: '外群通知' } })
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  for (const item of routeRequest.messages) assert.equal(item.quotedReply, undefined)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  const untouched = structuredClone(h.store.getGroup('other').outbox)
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: routeRequest.messages.map(item => ({
    messageId: item.messageId, messageVersion: item.messageVersion, topics: [{ newTopicKey: 'same', title: '引用核对' }],
  })) })
  const request = routed.pendingDecisions[0]
  await assertDecisionIssue(h.call('group_decision_submit', submission(request, { reply: '回复', replyToMessageId: 'human-quote', atOpenDingTalkIds: ['other-user'] })), /group_reply_recipient_not_in_topic/)
  assert.deepEqual(h.store.getGroup('other').outbox, untouched)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('同批混合来源并发推进，跨Topic同源只确认一次，各自来源仍能回复', async t => {
  const h = await setup(t)
  await ingest(h, 'own', { text: '@助理 核对B的补充。' })
  await ingest(h, 'shared', { text: '@助理 核对A；核对B。' })
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [
    { messageId: 'own', messageVersion: 1, topics: [{ newTopicKey: 'b', title: 'B核对' }] },
    { messageId: 'shared', messageVersion: 1, replyTopic: { newTopicKey: 'a' }, ignoredRefs: [], units: [
      { unitKey: 'a', summary: '核对A', sourceRefs: [{ quote: '@助理 核对A；' }], topics: [{ newTopicKey: 'a', title: 'A核对' }] },
      { unitKey: 'b', summary: '核对B', sourceRefs: [{ quote: '核对B。' }], topics: [{ newTopicKey: 'b', title: 'B核对' }] },
    ] },
  ] })
  const results = await Promise.all(routed.pendingDecisions.map(request => {
    const refs = request.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
    const action = { kind: 'new-task', title: '核对事项', objective: '核对本话题的全部要求', acceptanceCriteria: ['有核对证据'],
      topicRefs: [{ topicId: request.topicId, revision: request.revision }], basisUnitRefs: refs,
      dispatchAssessment: { businessObject: '核对事项', agentDeliverable: '核对结果', externalFollowup: [], sourceUnitRefs: refs, workflowRefs: [], workflowReason: '无专用流程' } }
    return h.call('group_decision_submit', submission(request, { basisMessageIds: [...new Set(request.messages.map(message => message.messageId))],
      basisUnitRefs: refs, actions: [action], reply: '已承接本条要求。', replyToMessageId: request.messages.some(message => message.messageId === 'own') ? 'own' : 'shared', replyReview: { kind: 'confirmation' } }))
  }))
  assert.ok(results.every(result => result.status === 'accepted'), JSON.stringify(results))
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 2)
  const replies = h.store.getGroup('g').outbox
  assert.equal(replies.length, 2)
  assert.equal(replies.filter(reply => reply.replyToMessageId === 'shared').length, 1)
  const own = replies.find(reply => reply.replyToMessageId === 'own')
  assert.ok(own)
  assert.deepEqual(own.matterSourceMessageIds, ['own'])
  assert.ok(own.matterUnitRefs.every(ref => h.store.getGroup('g').messages.find(message => message.messageId === 'own').activeUnitRefs.some(unit => unit.unitId === ref.unitId)))
  assert.ok(h.store.listTopics('g').every(topic => topic.processedRevision === topic.revision))
})
async function complete(h, request, patch = {}) {
  const envelope = h.envelope('[GROUP_TOPIC_DECISION]')
  if (envelope?.requestId === request.requestId) {
    for (const section of ['messages', 'quotedMessages', 'sourceMessages', 'removedUnitRefs', 'rejectedDecisions', 'ownership']) {
      if (envelope[section]?.section !== section) continue
      let offset = 0, page
      do {
        page = await h.call('group_decision_context_get', { requestId: request.requestId, section, offset })
        offset = page.nextOffset
      } while (page.hasMore)
    }
  }
  assert.equal((await h.call('group_decision_submit', submission(request, patch))).status, 'accepted')
  await h.coordinator.drain('g')
}

test('Topic 决策信封受字符预算约束，缺失增量读完后才可提交', async (t) => {
  const h = await setup(t)
  await ingest(h, 'large-0', { text: '测'.repeat(12_000) })
  const first = (await route(h)).pendingDecisions[0]
  for (let index = 1; index < 10; index++) {
    await ingest(h, `large-${index}`, { text: '测'.repeat(12_000) })
    await route(h, { [`large-${index}`]: first.topicId })
  }
  const request = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.ok(Buffer.byteLength(h.sent.findLast((item) => item.startsWith('[GROUP_TOPIC_DECISION]')), 'utf8') <= 12 * 1024)
  assert.equal(request.omittedDeltaCount, 10)
  assert.equal(request.messages.section, 'messages')
  const args = submission({ ...request, messages: [{ messageId: 'large-9' }] })
  await assert.rejects(h.call('group_decision_submit', args), /topic_decision_delta_unread/)
  await assert.rejects(h.call('group_decision_context_get', { requestId: request.requestId, section: 'messages', offset: 2 }), /decision_context_offset_out_of_order/)
  await assert.rejects(h.call('group_decision_context_get', { requestId: request.requestId, section: 'unknown' }), /decision_context_section_unknown/)
  await assert.rejects(h.call('group_decision_context_get', { requestId: request.requestId, section: 'messages' }, { groupId: 'other' }), /wrong_session/)
  let offset = 0, text = '', page
  do {
    page = await h.call('group_decision_context_get', { requestId: request.requestId, section: 'messages', offset })
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12 * 1024)
    text += page.text; offset = page.nextOffset
  } while (page.hasMore)
  assert.equal(JSON.parse(text).at(-1).messageId, 'large-9')
  assert.equal((await h.call('group_decision_submit', args)).status, 'accepted')
})

test('超长直接引用保持当前事项可见，引用续读前拒绝决策', async (t) => {
  const h = await setup(t)
  await ingest(h, 'quoted-long', { text: '@助理 请确认', quotedMessage: { messageId: 'quoted-long-source', content: '引用'.repeat(12_000) } })
  const request = (await route(h)).pendingDecisions[0]
  const envelope = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(envelope.messages[0].messageId, 'quoted-long')
  assert.equal(envelope.quotedMessages.section, 'quotedMessages')
  assert.ok(Buffer.byteLength(h.sent.findLast((item) => item.startsWith('[GROUP_TOPIC_DECISION]')), 'utf8') <= 12 * 1024)
  await assert.rejects(h.call('group_decision_submit', submission(request)), /topic_decision_context_unread/)
  let offset = 0, text = '', page
  do {
    page = await h.call('group_decision_context_get', { requestId: request.requestId, section: 'quotedMessages', offset })
    text += page.text; offset = page.nextOffset
  } while (page.hasMore)
  assert.equal(JSON.parse(text)[0].content, '引用'.repeat(12_000))
  assert.equal((await h.call('group_decision_submit', submission(request))).status, 'accepted')
})

test('长历史不进入新决策首屏，路由回执保持精简', async (t) => {
  const h = await setup(t)
  await ingest(h, 'history-0')
  const first = (await route(h)).pendingDecisions[0]
  await complete(h, first)
  for (let index = 1; index <= 24; index++) {
    const id = `history-${index}`
    await ingest(h, id, { text: `@助理 ${'历史内容'.repeat(100)}` })
    const routed = await route(h, { [id]: first.topicId })
    assert.ok(Buffer.byteLength(JSON.stringify({ status: routed.status, requestId: routed.requestId }), 'utf8') <= 1024)
    await complete(h, routed.pendingDecisions[0])
  }
  await ingest(h, 'current', { text: '@助理 现在确认测试账号？', quotedMessage: { messageId: 'quoted-current', content: '测试账号' } })
  const routed = await route(h, { current: first.topicId })
  const envelope = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(envelope.totalMessages, 26)
  assert.equal(envelope.historyAvailable, true)
  assert.deepEqual(envelope.messages.map((message) => message.messageId), ['current'])
  assert.equal(envelope.quotedMessages.length, 1)
  assert.ok(Buffer.byteLength(h.sent.findLast((item) => item.startsWith('[GROUP_TOPIC_DECISION]')), 'utf8') <= 12 * 1024)
  assert.equal(routed.pendingDecisions[0].topicId, first.topicId)
})

test('同消息多事项的引用与原始点名只发送一次', async (t) => {
  const h = await setup(t)
  await ingest(h, 'multi', { text: '@助理 第一项；第二项', quotedMessage: { messageId: 'quoted-multi', content: '前一条讨论' } })
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const raw = await h.rawCall('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: 'multi', messageVersion: 1,
    ignoredRefs: [{ quote: '@助理 ', reason: '点名适用于下列事项' }], units: [
      { unitKey: 'one', summary: '第一项', sourceRefs: [{ quote: '第一项；' }], topics: [{ newTopicKey: 'same', title: '两项讨论' }] },
      { unitKey: 'two', summary: '第二项', sourceRefs: [{ quote: '第二项' }], contextRefs: [{ quote: '@助理 ', purpose: '原始点名' }], topics: [{ newTopicKey: 'same', title: '两项讨论' }] },
    ] }] })
  assert.ok(Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 1024)
  assert.equal(raw.pendingDecisions, undefined)
  const envelope = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(envelope.messages.length, 2)
  assert.equal(envelope.quotedMessages.length, 1)
  assert.equal(envelope.sourceMessages.length, 1)
  assert.equal(envelope.sourceMessages[0].text, '@助理 第一项；第二项')
  assert.equal(envelope.messages[0].quotedMessageId, 'quoted-multi')
  assert.equal(envelope.messages[1].quotedMessageId, 'quoted-multi')
})

test('拆分确认和条件后，各话题仍能读取完整同条原文且不取得其他事项效果所有权', async (t) => {
  const h = await setup(t)
  const confirmation = '可以，按原方案修复。'
  const condition = '但是点击编辑就要变为待提交，刷新后也应保持。'
  const unrelated = '另外统计本月报表。'
  const original = confirmation + condition + unrelated
  await ingest(h, 'conditional-answer', { text: original, quotedMessage: { messageId: 'proposal', content: '修复后部署 UAT，是否同意方案？' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'conditional-answer', messageVersion: 1, replyTopic: { newTopicKey: 'fix' }, ignoredRefs: [], units: [
      { unitKey: 'confirmation', summary: '确认原修复', sourceRefs: [{ quote: confirmation }],
        contextRefs: [{ quote: condition, purpose: '本次确认附带的状态要求' }], topics: [{ newTopicKey: 'fix', title: '编辑状态修复' }] },
      { unitKey: 'condition', summary: '编辑状态持久化要求', sourceRefs: [{ quote: condition }],
        contextRefs: [{ quote: confirmation, purpose: '订正所针对的已确认方案' }], topics: [{ newTopicKey: 'state', title: '状态持久化' }] },
      { unitKey: 'report', summary: '独立报表统计', sourceRefs: [{ quote: unrelated }], topics: [{ newTopicKey: 'report', title: '月度报表' }] },
    ],
  }] })
  const envelopes = h.sent.filter(text => text.startsWith('[GROUP_TOPIC_DECISION]')).map(text => JSON.parse(text.split('\n').find(line => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length)))
  assert.equal(envelopes.length, 3)
  const fix = envelopes.find(value => value.messages.some(message => message.unitSummary === '确认原修复'))
  assert.equal(fix.messages.length, 1)
  assert.equal(fix.sourceMessages[0].text, original, '完整原文可用于判断确认条件，不能被单元摘要替代')
  assert.ok(fix.messages[0].text.includes(condition), '关联条件在现有 contextRefs 中随原事项传递')
  assert.ok(!fix.messages[0].text.includes(unrelated), '独立事项不混入本单元的动作内容')
  assert.equal(fix.quotedMessages.length, 1)
  assert.equal(fix.ownedDeltaUnitRefs.length, 1, '完整原文可读不授予其他单元的效果所有权')
})

test('压缩移除已见决策正文后需重新取得必要增量', async (t) => {
  let visible = []
  const h = await setup(t, { session: { deriveMessages: () => visible } })
  await ingest(h, 'surface')
  const request = (await route(h)).pendingDecisions[0]
  const body = h.sent.findLast((item) => item.startsWith('[GROUP_TOPIC_DECISION]'))
  visible = [{ role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: body }] }]
  const args = { requestId: request.requestId, topicId: request.topicId, revision: request.revision,
    decision: { basisMessageIds: ['surface'], actions: [], reply: '正在核对', replyToMessageId: 'surface' } }
  assert.equal((await h.call('group_decision_submit', args)).status, 'review-required')
  visible = []
  await assert.rejects(h.call('group_decision_submit', args), /topic_decision_delta_unread/)
  visible = [{ role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: body }] }]
  assert.equal((await h.call('group_decision_submit', { ...args, decision: { ...args.decision,
    replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })).status, 'accepted')
})

test('超长单消息必须按连续文本片段读完后才允许决策', async (t) => {
  const h = await setup(t)
  await ingest(h, 'long-message', { text: '长'.repeat(90_000) })
  const request = (await route(h)).pendingDecisions[0]
  const args = { requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { basisMessageIds: ['long-message'], actions: [], reason: '完整读取后静默处理' } }
  await assert.rejects(h.call('group_decision_submit', args), /topic_decision_delta_unread/)
  const first = await h.call('group_topic_context_get', { topicId: request.topicId, revision: request.revision, offset: 0 })
  assert.ok(JSON.stringify(first).length <= 40_000)
  await h.call('group_topic_context_get', { topicId: request.topicId, revision: request.revision, offset: 0, textOffset: first.nextTextOffset + 10 })
  await assert.rejects(h.call('group_decision_submit', args), /topic_decision_delta_unread/)
  let offset = first.nextOffset, textOffset = first.nextTextOffset, calls = 1
  do {
    const page = await h.call('group_topic_context_get', { topicId: request.topicId, revision: request.revision, offset, ...(textOffset ? { textOffset } : {}) })
    assert.ok(JSON.stringify(page).length <= 40_000)
    assert.equal(page.messages[0].textOffset ?? 0, textOffset)
    offset = page.nextOffset; textOffset = page.nextTextOffset ?? 0; calls += 1
  } while (offset < request.totalMessages)
  assert.ok(calls >= 3)
  assert.equal((await h.call('group_decision_submit', args)).status, 'accepted')
})

test('归类协议区分 Topic 归属与历史资料查询', async (t) => {
  const h = await setup(t)
  await ingest(h, 'branch-question', { text: '你做的草稿箱前端在哪个分支，我自己调整后合入' })
  await h.coordinator.schedule('g')
  const prompt = h.sent.findLast((item) => item.startsWith('[GROUP_TOPIC_ROUTE]'))
  assert.match(prompt, /历史资料时.*不得把资料来源 Topic 加入归属/u)
  assert.match(prompt, /effectOwner 指定唯一动作主归属/u)
})

test('消息仅在全部关联 Topic 完成后收口为已投递', async (t) => {
  const h = await setup(t)
  await ingest(h, 'shared')
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{
    messageId: 'shared', messageVersion: 1, topics: [
      { newTopicKey: 'a', title: 'A', relationship: 'continuation', reason: '继续事项 A' },
      { newTopicKey: 'b', title: 'B', relationship: 'affected', reason: '同时改变事项 B' },
    ], effectOwner: { newTopicKey: 'b' },
  }] })
  const [a, b] = routed.pendingDecisions
  assert.equal(h.store.getGroup('g').messages[0].agentDeliveryStatus, 'pending')
  await complete(h, a)
  assert.equal(h.store.getGroup('g').messages[0].agentDeliveryStatus, 'pending')
  await complete(h, b)
  assert.equal(h.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})

test('明确无需进入 Topic 的消息在归类完成后直接收口', async (t) => {
  const h = await setup(t)
  await ingest(h, 'ignored')
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.equal((await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'ignored', messageVersion: 1, topics: [], reason: '无需处理' }] })).status, 'accepted')
  assert.equal(h.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})
async function taskFixture(h, message = {}) {
  await ingest(h, 'a1', message)
  const result = await route(h)
  const request = result.pendingDecisions[0]
  await complete(h, request)
  const { task } = await h.store.createTask({ groupId: 'g', topicRefs: [{ topicId: request.topicId, revision: request.revision }], title: '核验 A', objective: '核验 A', acceptanceCriteria: ['结果有证据'] })
  return { task, request }
}

test('引用已送达助手回复的对象纠正可以沟通而不变更任务', async t => {
  const h = await setup(t)
  const { task, request: initial } = await taskFixture(h, { senderOpenDingTalkId: 'user-a', senderName: '参与者A' })
  await ingest(h, 'explanation-b', { senderOpenDingTalkId: 'user-b', text: '材料已准备。' })
  await complete(h, (await route(h, { 'explanation-b': initial.topicId })).pendingDecisions[0])
  await h.store.appendOutbox({ groupId: 'g', sourceMessageId: 'previous-reply', outboundId: 'previous-outbound', topicId: initial.topicId,
    text: '已收到。', replyToMessageId: 'explanation-b', atOpenDingTalkIds: ['user-b'] })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'previous-outbound', deliveredMessageId: 'delivered-previous' })
  const before = structuredClone(h.store.getTask(task.taskId))
  await ingest(h, 'correction-c', { senderOpenDingTalkId: 'user-c', text: '回复对象应为参与者A。',
    quotedMessage: { messageId: 'delivered-previous', content: '已收到。' } })
  const request = (await route(h, { 'correction-c': initial.topicId })).pendingDecisions[0]
  const args = submission(request, { reply: '已更正，后续与参与者A沟通。', replyToMessageId: 'a1', atOpenDingTalkIds: ['user-a'] })
  assert.equal((await h.call('group_decision_submit', args)).status, 'accepted')
  await h.coordinator.drain('g')
  const replies = h.store.getGroup('g').outbox
  assert.equal(replies.length, 2)
  assert.equal(replies[1].replyToMessageId, 'a1')
  assert.deepEqual(replies[1].atOpenDingTalkIds, ['user-a'])
  assert.deepEqual(h.store.getTask(task.taskId), before)
  assert.equal(h.store.listTasks().length, 1)
  assert.deepEqual(h.applications, [])
  await h.coordinator.recover(); await h.coordinator.drain('g')
  assert.equal(h.store.getGroup('g').outbox.length, 2)
})

test('连续话题版本刷新关联Task状态摘要，保留未答来源并拒绝旧决策', async t => {
  const h = await setup(t)
  const { task, request } = await taskFixture(h)
  await ingest(h, 'follow-317')
  const pending = (await route(h, { 'follow-317': request.topicId })).pendingDecisions[0]
  const first = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(first.linkedTasks.total, 1)
  assert.deepEqual(first.linkedTasks.snapshots, [{ taskId: task.taskId, title: '核验 A', inputVersion: 1, runSequence: 1, state: 'queued', summary: '' }])
  assert.deepEqual(first.linkedTasks.reads[0].readCall, { name: 'group_task_context_get', arguments: { taskIds: [task.taskId] } })
  await h.store.updateTask(task.taskId, current => ({ ...current, inputVersion: current.inputVersion + 1, objective: '更新后的完整验收目标' }))
  await ingest(h, 'follow-318')
  const next = (await route(h, { 'follow-318': request.topicId })).pendingDecisions[0]
  const second = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(second.linkedTasks.snapshots[0].inputVersion, task.inputVersion + 1)
  assert.equal(second.linkedTasks.snapshots[0].objective, undefined, '完整目标只在按需读取中提供')
  assert.equal(h.store.getTask(task.taskId).objective, '更新后的完整验收目标')
  assert.equal(first.linkedTasks.snapshots[0].inputVersion, task.inputVersion, '旧输入不能被新缓存原位改写')
  assert.ok(second.messages.some(message => message.messageId === 'follow-317'), '新版本保留未答来源')
  assert.ok(second.messages.some(message => message.messageId === 'follow-318'))
  assert.equal((await h.call('group_decision_submit', submission(pending))).status, 'topic-stale')
  await complete(h, next)
  assert.equal(h.store.getTopic('g', request.topicId).processedRevision, next.revision)
  assert.equal(h.applications.length, 0, '预取上下文不应用任何Task动作')
})

test('关联Task默认摘要有界，正文按需读取，跨群不泄露，超量显式续查', async t => {
  const h = await setup(t)
  const { request } = await taskFixture(h)
  const large = '完整原始目标'.repeat(3000)
  const { task } = await h.store.createTask({ groupId: 'g', topicRefs: [{ topicId: request.topicId, revision: 1 }],
    title: '超长任务', objective: large, acceptanceCriteria: ['完整核验'] })
  for (let index = 0; index < 12; index++) await h.store.createTask({ groupId: 'g', topicRefs: [{ topicId: request.topicId, revision: 1 }],
    title: `关联任务${index}`, objective: `目标${index}`, acceptanceCriteria: ['证据'] })
  await h.store.subscribe({ groupId: 'private-group' })
  await h.store.ingest({ groupId: 'private-group', messageId: 'private', text: '私有来源', occurredAt: '2026-10-27T06:00:00Z' })
  const privateRoute = await h.store.routeMessages({ groupId: 'private-group', routeId: 'private-route', routingRevision: 0,
    routes: [{ messageId: 'private', messageVersion: 1, topics: [{ newTopicKey: 'private', title: '私有话题' }] }] })
  await h.store.createTask({ groupId: 'private-group', topicRefs: [{ topicId: privateRoute.topicIdsByKey.private, revision: 1 }],
    title: '跨群私有目标', objective: '不得泄露', acceptanceCriteria: ['私有'] })
  await ingest(h, 'bounded-follow')
  await route(h, { 'bounded-follow': request.topicId })
  const next = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(next.linkedTasks.total, 14)
  assert.equal(next.linkedTasks.hasMore, true)
  assert.ok(next.linkedTasks.reads.length <= 8)
  assert.ok(Buffer.byteLength(JSON.stringify(next.linkedTasks.snapshots), 'utf8') <= 3000)
  assert.ok(next.linkedTasks.snapshots.some(snapshot => snapshot.taskId === task.taskId))
  assert.ok(next.linkedTasks.snapshots.every(snapshot => !Object.hasOwn(snapshot, 'objective')))
  assert.ok(next.linkedTasks.reads.some(read => read.taskId === task.taskId), '完整目标提供精确读回')
  assert.equal(h.store.getTask(task.taskId).objective, large)
  assert.equal(JSON.stringify(next).includes('跨群私有目标'), false)
  assert.ok(Buffer.byteLength(h.sent.findLast(text => text.startsWith('[GROUP_TOPIC_DECISION]')), 'utf8') <= 12000)
})

test('关联Task内联后发生版本变化，旧快照不能放行Task动作', async t => {
  const h = await setup(t)
  const { task, request } = await taskFixture(h)
  await h.store.updateTask(task.taskId, current => ({ ...current, state: 'running' }))
  await ingest(h, 'task-fence')
  const next = (await route(h, { 'task-fence': request.topicId })).pendingDecisions[0]
  const inline = h.envelope('[GROUP_TOPIC_DECISION]').linkedTasks.snapshots[0]
  await h.store.updateTask(task.taskId, current => ({ ...current, inputVersion: current.inputVersion + 1 }))
  const result = await h.call('group_decision_submit', submission(next, { reply: '收到本次补充', reason: undefined,
    actions: [{ kind: 'task-context', taskId: task.taskId,
    inputVersion: inline.inputVersion, runSequence: inline.runSequence, context: '需要保留的新要求', progressImpact: 'preserve',
    topicRefs: [{ topicId: next.topicId, revision: next.revision }] }] }))
  assert.equal(result.status, 'task-stale', JSON.stringify(result))
  assert.equal(h.applications.length, 0)
  assert.ok(h.store.getTopic('g', next.topicId).processedRevision < next.revision, '旧快照被拒后来源仍未答')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('归类 exact batch 零副作用拒绝漏项，新增消息进入下一批', async (t) => {
  const h = await setup(t)
  await ingest(h, 'a'); await ingest(h, 'b'); await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routes = request.messages.map((message) => ({ messageId: message.messageId, messageVersion: 1, topics: [{ newTopicKey: message.messageId, title: message.messageId }] }))
  const before = structuredClone(h.store.getGroup('g'))
  await assert.rejects(h.call('group_topic_route_submit', { requestId: request.requestId, routes: routes.slice(0, 1) }), /topic_route_batch_incomplete/)
  assert.deepEqual(h.store.getGroup('g'), before)
  await assert.rejects(h.call('group_topic_route_submit', { requestId: request.requestId, routes }, { groupId: 'foreign' }), /wrong_session/)
  await ingest(h, 'c')
  const accepted = await h.call('group_topic_route_submit', { requestId: request.requestId, routes })
  assert.equal(accepted.status, 'accepted')
  assert.equal(h.store.listTopics('g').length, 2)
  assert.deepEqual(h.envelope('[GROUP_TOPIC_ROUTE]').messages.map((message) => message.messageId), ['c'])
})

test('A/B 独立提交不要求覆盖其他 Topic，先完成 B 不消费 A', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); await ingest(h, 'b')
  const result = await route(h), [a, b] = result.pendingDecisions
  await complete(h, b)
  assert.equal(h.store.getTopic('g', b.topicId).processedRevision, 1)
  assert.equal(h.store.getTopic('g', a.topicId).processedRevision, 0)
  await complete(h, a)
  assert.equal(h.store.getTopic('g', a.topicId).processedRevision, 1)
})

test('超长消息路由必须按冻结原文坐标连续读完，未读完不能原子接受', async (t) => {
  const h = await setup(t)
  const text = `@助理 ${'长'.repeat(90_000)}`
  await ingest(h, 'long-route', { text })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.equal(request.hasMoreMessages, true)
  const routeArgs = { requestId: request.requestId, routes: [{ messageId: 'long-route', messageVersion: 1, ignoredRefs: [], units: [{ unitKey: 'whole', summary: '处理超长事项', replacesUnitIds: [], sourceRefs: [{ wholeMessage: true }], topics: [{ newTopicKey: 'long', title: '超长事项' }] }] }] }
  await assert.rejects(h.call('group_topic_route_submit', routeArgs), /topic_route_source_unread/)
  let offset = request.messages[0].text.length
  while (offset < text.length) {
    const page = await h.call('group_topic_route_context_get', { requestId: request.requestId, messageId: 'long-route', offset })
    assert.equal(page.textOffset, offset)
    assert.ok(JSON.stringify(page).length <= 40_000)
    offset = page.nextOffset
  }
  assert.equal((await h.call('group_topic_route_submit', routeArgs)).status, 'accepted')
})

test('#1066 单消息拆成三个事项，各自建 Task 且已完成事项不等待兄弟事项反馈', async (t) => {
  const h = await setup(t)
  const text = '@助理 请回归审核增强；请确认审核草稿方案和排期；请确认撤回通知方案和排期。'
  await ingest(h, '1066', { text })
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: '1066', messageVersion: 1, replyTopic: { newTopicKey: 'regression' }, ignoredRefs: [], units: [
    { unitKey: 'regression', summary: '回归审核增强', sourceRefs: [{ quote: '@助理 请回归审核增强；' }], topics: [{ newTopicKey: 'regression', title: '审核增强回归' }] },
    { unitKey: 'draft', summary: '确认审核草稿方案和排期', sourceRefs: [{ quote: '请确认审核草稿方案和排期；' }], contextRefs: [{ quote: '@助理 ', purpose: '该点名适用于本事项' }], topics: [{ newTopicKey: 'draft', title: '审核草稿需求' }] },
    { unitKey: 'recall', summary: '确认撤回通知方案和排期', sourceRefs: [{ quote: '请确认撤回通知方案和排期。' }], contextRefs: [{ quote: '@助理 ', purpose: '该点名适用于本事项' }], topics: [{ newTopicKey: 'recall', title: '撤回通知需求' }] },
  ] }] })
  assert.equal(routed.pendingDecisions.length, 3)
  const [first, ...siblings] = routed.pendingDecisions
  const ref = { unitId: first.messages[0].unitId, unitRevision: first.messages[0].unitRevision }
  const action = { kind: 'new-task', title: first.messages[0].unitSummary, objective: first.messages[0].unitSummary, acceptanceCriteria: ['给出可核验证据'], topicRefs: [{ topicId: first.topicId, revision: first.revision }], basisUnitRefs: [ref],
    dispatchAssessment: { businessObject: '审核增强', agentDeliverable: '回归结果', externalFollowup: [], sourceUnitRefs: [ref], workflowRefs: [], workflowReason: '当前无专用流程' } }
  await assertDecisionIssue(h.call('group_decision_submit', submission(first, { basisUnitRefs: [ref], actions: [{ ...action, dispatchAssessment: undefined }], reply: '已开始处理。', replyReview: { kind: 'confirmation' } })), /task_dispatch_assessment_required/)
  await assertDecisionIssue(h.call('group_decision_submit', submission(first, { basisUnitRefs: [ref], actions: [{ ...action, dispatchAssessment: { ...action.dispatchAssessment, sourceUnitRefs: [{ unitId: siblings[0].messages[0].unitId, unitRevision: 1 }] } }], reply: '已开始处理。', replyReview: { kind: 'confirmation' } })), /task_dispatch_source_units_invalid/)
  assert.equal((await h.call('group_decision_submit', submission(first, { basisUnitRefs: [ref], actions: [action], reply: '已开始处理。', replyReview: { kind: 'confirmation' } }))).status, 'accepted')
  await h.coordinator.drain('g')
  const task = h.store.listTasks()[0]
  assert.ok(task)
  assert.equal(siblings.every((request) => h.store.getTopic('g', request.topicId).processedRevision === 0), true)
  assert.equal(h.coordinator.hasPendingTaskInput(task), false)

  const running = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'running' }))
  const result = { inputVersion: running.inputVersion, runSequence: running.runSequence, status: 'completed', summary: '回归完成', evidence: ['回归结果已核验'], artifacts: [] }
  const pending = h.coordinator.requestReview('completion', running, result)
  const reviewRequest = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: reviewRequest.requestId, review: { accepted: true, reason: '证据完整', notification: {
    reply: '审核增强回归已完成。', replyToMessageId: '1066', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
  } } })).status, 'accepted')
  const review = await pending
  const completed = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result }))
  const outbound = await h.coordinator.commitCompletionNotification(review.preparedNotification, completed, result)
  assert.equal(outbound.text, '审核增强回归已完成。')
  assert.equal(siblings.every((request) => h.store.getTopic('g', request.topicId).processedRevision === 0), true)
  for (const request of siblings) {
    const unitRef = { unitId: request.messages[0].unitId, unitRevision: request.messages[0].unitRevision }
    const siblingAction = { kind: 'new-task', title: request.messages[0].unitSummary, objective: request.messages[0].unitSummary, acceptanceCriteria: ['给出方案和排期'], topicRefs: [{ topicId: request.topicId, revision: request.revision }], basisUnitRefs: [unitRef],
      dispatchAssessment: { businessObject: request.messages[0].unitSummary, agentDeliverable: '方案和排期', externalFollowup: [], sourceUnitRefs: [unitRef], workflowRefs: [], workflowReason: '当前无专用流程' } }
    assert.equal((await h.call('group_decision_submit', submission(request, { basisUnitRefs: [unitRef], actions: [siblingAction], reason: '来源由回归话题统一回复，独立推进本事项。' }))).status, 'accepted')
    await h.coordinator.drain('g')
  }
  assert.equal(h.store.listTasks().length, 3)
})

test('同消息复核不能改 unitKey 重授执行权，显式拆分保留旧固定版本', async (t) => {
  const h = await setup(t)
  await ingest(h, 'split', { text: '@助理 A；B' })
  const original = (await route(h)).pendingDecisions[0]
  const oldContext = await h.call('group_topic_context_get', { topicId: original.topicId, revision: original.revision })
  const oldUnitId = oldContext.messages[0].unitId
  const review = await h.call('group_topic_route_review', { messageIds: ['split'], reason: '原消息应拆为两个事项' })
  const units = [
    { unitKey: 'a', summary: '事项 A', replacesUnitIds: [oldUnitId], effectInheritance: 'inherit', revisionReason: '保留旧事项已执行效果', sourceRefs: [{ quote: '@助理 A；' }], topics: [{ topicId: original.topicId }] },
    { unitKey: 'b', summary: '事项 B', replacesUnitIds: [oldUnitId], effectInheritance: 'new-scope', revisionReason: '旧合并事项未单独覆盖 B', sourceRefs: [{ quote: 'B' }], contextRefs: [{ quote: '@助理 ', purpose: '点名适用于事项 B' }], topics: [{ newTopicKey: 'split-b', title: '事项 B' }] },
  ]
  await assert.rejects(h.store.routeMessages({ groupId: 'g', routeId: 'silent-key-change', routingRevision: h.store.getGroup('g').routingRevision, routes: [{ messageId: 'split', messageVersion: 1, units: units.map(({ effectInheritance: _inherit, revisionReason: _reason, ...unit }) => ({ ...unit, replacesUnitIds: [] })), ignoredRefs: [] }] }), /topic_unit_revision_mapping_required/)
  const result = await h.call('group_topic_route_submit', { requestId: review.requestId, routes: [{ messageId: 'split', messageVersion: 1, replyTopic: { topicId: original.topicId }, units, ignoredRefs: [] }] })
  assert.equal(result.status, 'accepted')
  const frozen = await h.call('group_topic_context_get', { topicId: original.topicId, revision: original.revision })
  assert.equal(frozen.messages[0].unitId, oldUnitId)
  assert.equal(frozen.messages[0].text, '@助理 A；B')
  assert.equal(h.store.getGroup('g').messages[0].activeUnitRefs.length, 2)
})

test('未知输入返回 routing-required，归到 B 后原 A 草稿自动重验提交', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'b')
  const deferred = await h.call('group_decision_submit', submission(a))
  assert.equal(deferred.status, 'routing-required')
  assert.equal(deferred.nextAction, 'wait-for-routing')
  assert.equal(deferred.retryScheduled, true)
  assert.equal(deferred.routeRequestId, h.envelope('[GROUP_TOPIC_ROUTE]').requestId)
  assert.equal(h.store.getTopic('g', a.topicId).decisions.length, 0)
  await route(h)
  await new Promise(resolve => setImmediate(resolve))
  await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', a.topicId).processedRevision, 1)
  assert.equal(h.store.getTopic('g', a.topicId).decisions.length, 1)
  assert.equal(h.store.getCoordinationRequest('g', a.requestId).status, 'completed')
  assert.equal(h.store.getCoordinationRequest('g', a.requestId).nextRetryAt, undefined)
  assert.equal(h.sent.filter(text => text.startsWith('[GROUP_TOPIC_DECISION]') && text.includes(a.requestId)).length, 1)
})

test('待归类输入不阻止已准备的其他 Topic 决策进入公平队列', async (t) => {
  const h = await setup(t)
  await ingest(h, 'a'); const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'b')
  await h.store.routeMessages({ groupId: 'g', routeId: 'direct-b', routingRevision: h.store.getGroup('g').routingRevision, routes: [{ messageId: 'b', messageVersion: 1, topics: [{ newTopicKey: 'b', title: 'B' }] }] })
  await ingest(h, 'c')
  const before = h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]')).length
  assert.equal((await h.coordinator.schedule('g')).length, 2)
  assert.equal(h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]')).length, before + 1)
  assert.equal(h.store.listTasks().length, 0)
  const routed = await route(h)
  assert.equal(routed.status, 'accepted')
  assert.equal(routed.pendingDecisions.length, 3)
  assert.equal(h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]')).length, before + 2)
  await complete(h, a)
})

test('待路由的新建任务草稿遇同话题撤销时失效，不能自动补建', async t => {
  const session = Session.create('same-round-cancel')
  const h = await setup(t, { session, onSteer: message => session.append('user/message', message, { surfaceOp: 'append' }) })
  await ingest(h, 'request-task')
  const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'cancel-task', { text: '@助理 先不要执行这个任务' })
  const action = { kind: 'new-task', title: '排查审核撤回', objective: '排查撤回规则', acceptanceCriteria: ['原因证据'], topicRefs: [{ topicId: a.topicId, revision: 1 }] }
  assert.equal((await h.call('group_decision_submit', submission(a, { actions: [action], reply: '开始排查' }))).status, 'routing-required')
  const routed = await route(h, { 'cancel-task': a.topicId })
  await new Promise(resolve => setImmediate(resolve))
  const current = routed.pendingDecisions.find(request => request.topicId === a.topicId)
  assert.equal(current.revision, 2)
  assert.equal(current.requestId, a.requestId)
  assert.equal(h.store.getCoordinationRequest('g', a.requestId).status, 'pending')
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await complete(h, current)
  assert.equal(h.store.listTasks().length, 0)
})

test('路由等待期间回复候选变化，缓存草稿仍须重新审阅', async t => {
  let candidates = []
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) })
  await ingest(h, 'a')
  const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'b')
  assert.equal((await h.call('group_decision_submit', submission(a, { reply: '排查结论' }))).status, 'routing-required')
  candidates = [{ outboundId: 'new-a-result', sourceMessageId: 'a', reply: '等待期间已有新结果' }]
  await route(h)
  await new Promise(resolve => setImmediate(resolve))
  await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', a.topicId).decisions.length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await h.call('group_reply_review_get', { requestIds: [a.requestId] })
  const accepted = await h.call('group_decision_submit', submission(a, { reply: '新结论', replyReview: { kind: 'substantive', reviewedOutboundIds: ['new-a-result'], sameMatterOutboundIds: [], replaceOutboundIds: [] } }))
  assert.equal(accepted.status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('异步决策预处理期间来了新消息，原请求仍仅派发一次且提交受保护', async (t) => {
  let release, started
  const entered = new Promise((resolve) => { started = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { onDecisionRequest: async () => { started(); await held; return false } })
  await ingest(h, 'a'); const a = (await route(h)).pendingDecisions[0]
  await entered
  await ingest(h, 'b')
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]')).length, 1)
  assert.equal(h.store.listTasks().length, 0)
  const routed = await route(h)
  assert.equal(routed.status, 'accepted')
  await h.coordinator.drain('g')
  const aRequests = h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]') && text.includes(a.requestId))
  assert.equal(aRequests.length, 1)
  await complete(h, a)
})

test('新消息等待归类时决策协议提醒不消耗重试次数', async (t) => {
  let idle
  const settled = new Promise((resolve) => { idle = resolve })
  const h = await setup(t, { whenIdle: () => settled, retryDelayMs: 1000 })
  await ingest(h, 'a'); const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'b'); await h.coordinator.schedule('g')
  idle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.store.getCoordinationRequest('g', a.requestId).attempt, 0)
  assert.equal(h.sent.filter((text) => text.includes(`[COORDINATION_RESUME]\n请求 ${a.requestId}`)).length, 0)
  await route(h)
  assert.equal(h.store.getCoordinationRequest('g', a.requestId).status, 'pending')
  await complete(h, a)
})

test('同 Topic 新增输入使旧决策失效且新依据必须覆盖本次增量', async (t) => {
  const h = await setup(t); await ingest(h, 'a1')
  const a = (await route(h)).pendingDecisions[0]
  await complete(h, a)
  await ingest(h, 'a2')
  const current = (await route(h, { a2: a.topicId })).pendingDecisions[0]
  assert.equal((await h.call('group_decision_submit', submission(a))).status, 'topic-stale')
  await assertDecisionIssue(h.call('group_decision_submit', submission(current, { basisMessageIds: ['a1'] })), /topic_decision_current_basis_required/)
  await assert.rejects(h.call('group_decision_submit', submission(current, { basisMessageIds: ['foreign'] })), /topic_decision_basis_invalid/)
  await complete(h, current)
  assert.equal(h.store.getTopic('g', a.topicId).processedRevision, 2)
})

// These decisions are scripted: verify context/evidence delivery and Host effects, not model inference.
test('Topic 上下文已交办时，仅同步同事或省略助手称呼仍可创建任务', async t => {
  for (const [name, currentText, quoted] of [
    ['notify-peers', '@成员甲 @成员乙 状态列需要显示等待中的记录。', false],
    ['agent-before-peer', '@助理 状态列需要显示等待中的记录，@成员甲 同步一下。', false],
    ['quoted-assignment', '按上面的分工，状态列需要显示等待中的记录。', true],
  ]) await t.test(name, async t => {
    const h = await setup(t)
    const assignment = '@助理 列表相关的明确需求由你实现，成员甲和成员乙接收同步。'
    await ingest(h, 'assignment', { text: assignment })
    const initial = (await route(h)).pendingDecisions[0]
    const summary = '助手负责实现列表需求；两位成员接收同步，等待具体展示要求。'
    await complete(h, initial, { topicUpdate: { summary } })
    await ingest(h, 'requirement', { text: currentText, ...(quoted ? { quotedMessage: { messageId: 'assignment', content: assignment } } : {}) })
    const current = (await route(h, { requirement: initial.topicId })).pendingDecisions[0]
    const input = h.envelope('[GROUP_TOPIC_DECISION]')
    assert.equal(input.summary, summary)
    assert.equal(input.historyAvailable, true)
    assert.equal(input.messages[0].text, currentText)
    if (quoted) assert.equal(input.quotedMessages[0].content, assignment)
    const context = await h.call('group_topic_context_get', { topicId: current.topicId, revision: current.revision })
    assert.deepEqual(context.messages.map(item => item.text), [assignment, currentText])
    const action = { kind: 'new-task', title: '列表状态展示', objective: '按原分工在列表显示等待中的记录', acceptanceCriteria: ['等待中的记录可见'], topicRefs: [{ topicId: current.topicId, revision: current.revision }] }
    const decisionSummary = '原分工由助手实现；本条明确展示需求，同事仅接收同步，创建列表状态任务。'
    const basisMessageIds = quoted ? ['requirement'] : ['assignment', 'requirement']
    assert.equal((await h.call('group_decision_submit', submission(current, { basisMessageIds, actions: [action], topicUpdate: { summary: decisionSummary }, reply: '开始处理列表状态展示。' }))).status, 'accepted')
    await h.coordinator.drain('g')
    assert.equal(h.store.listTasks().length, 1)
    const topic = h.store.getTopic('g', current.topicId)
    assert.equal(topic.summary, decisionSummary)
    assert.deepEqual(topic.decisions.at(-1).decision.basisMessageIds, basisMessageIds)
    assert.equal(h.store.getGroup('g').outbox.length, 1)
  })
})

test('事项正文剥离称呼后仍提供完整来源供语义判断', async t => {
  for (const [name, text, shouldAct] of [
    ['agent', '@助理 请修复关联 ID 合并', true],
    ['colleague', '@成员甲 请修复关联 ID 合并', false],
  ]) await t.test(name, async t => {
    const h = await setup(t)
    await ingest(h, name, { text })
    await h.coordinator.schedule('g')
    const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
    const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: name, messageVersion: 1,
      ignoredRefs: [{ quote: text.split(' ')[0], reason: '称呼不是独立事项' }],
      units: [{ unitKey: 'repair', summary: '修复关联 ID 合并', sourceRefs: [{ quote: '请修复关联 ID 合并' }], topics: [{ newTopicKey: 'repair', title: '关联 ID 合并修复' }] }],
    }] })
    const current = routed.pendingDecisions[0]
    assert.equal(current.messages[0].text, '请修复关联 ID 合并')
    assert.equal(h.envelope('[GROUP_TOPIC_DECISION]').sourceMessages[0].text, text)
    const action = { kind: 'new-task', title: '修复关联 ID 合并', objective: '修复关联 ID 合并', acceptanceCriteria: ['修复结果'], topicRefs: [{ topicId: current.topicId, revision: current.revision }] }
    const patch = shouldAct ? { actions: [action], reply: '开始处理。' } : { actions: [], reason: '原文交给成员甲，未要求助手参与', topicUpdate: { summary: '成员甲负责修复关联 ID 合并。' } }
    assert.equal((await h.call('group_decision_submit', submission(current, patch))).status, 'accepted')
    await h.coordinator.drain('g')
    assert.equal(h.store.listTasks().length, shouldAct ? 1 : 0)
    assert.equal(h.store.getGroup('g').outbox.length, shouldAct ? 1 : 0)
  })
})

test('同一消息多个事项保留分工原文并按语义选择动作', async t => {
  for (const [name, text, sources, target, shouldAct] of [
    ['other-b', '@助理 修复 A；@成员甲 修复 B。', ['@助理 修复 A；', '@成员甲 修复 B。'], 'b', false],
    ['shared-agent', '@助理 修复 A；修复 B。', ['@助理 修复 A；', '修复 B。'], 'b', true],
    ['other-after-agent', '@助理 修复 A；@成员甲 修复 B；修复 C。', ['@助理 修复 A；', '@成员甲 修复 B；', '修复 C。'], 'c', false],
    ['agent-after-other', '@成员甲 修复 A；@助理 修复 B。', ['@成员甲 修复 A；', '@助理 修复 B。'], 'b', true],
    ['other-despite-agent-in-decision', '@成员甲 修复 A；@助理 修复 B。', ['@成员甲 修复 A；', '@助理 修复 B。'], 'a', false],
  ]) await t.test(name, async t => {
    const h = await setup(t)
    await ingest(h, name, { text })
    await h.coordinator.schedule('g')
    const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
    const units = sources.map((quote, index) => ({ unitKey: String.fromCharCode(97 + index), summary: quote, sourceRefs: [{ quote }], topics: [{ newTopicKey: name === 'other-despite-agent-in-decision' ? 'shared' : `matter-${index}`, title: name === 'other-despite-agent-in-decision' ? '共同话题' : `事项 ${index}` }] }))
    const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: name, messageVersion: 1, replyTopic: { newTopicKey: units[target.charCodeAt(0) - 97].topics[0].newTopicKey }, ignoredRefs: [], units }] })
    const current = routed.pendingDecisions.find(item => item.messages.some(message => message.unitSummary === units[target.charCodeAt(0) - 97].summary))
    const selected = current.messages.find(message => message.unitSummary === units[target.charCodeAt(0) - 97].summary)
    const input = h.sent.filter(item => item.startsWith('[GROUP_TOPIC_DECISION]')).map(item => JSON.parse(item.split('\n')[1].slice('Topic 请求：'.length))).find(item => item.requestId === current.requestId)
    assert.equal(input.sourceMessages[0].text, text)
    const basisUnitRefs = [{ unitId: selected.unitId, unitRevision: selected.unitRevision }]
    const action = { kind: 'new-task', title: `处理 ${target}`, objective: `处理 ${target}`, acceptanceCriteria: ['完成'], topicRefs: [{ topicId: current.topicId, revision: current.revision }], basisUnitRefs,
      dispatchAssessment: { businessObject: `事项 ${target}`, agentDeliverable: `处理 ${target}`, externalFollowup: [], sourceUnitRefs: basisUnitRefs, workflowRefs: [], workflowReason: '当前无专用流程' } }
    const patch = shouldAct ? { actions: [action], reply: '开始处理。' } : { actions: [], reason: '当前事项交给成员甲，其他事项对助手的交办不适用', topicUpdate: { summary: '保留各事项的分工，当前事项由成员甲负责。' } }
    assert.equal((await h.call('group_decision_submit', submission(current, { basisUnitRefs, ...patch }))).status, 'accepted')
    await h.coordinator.drain('g')
    assert.equal(h.store.listTasks().length, shouldAct ? 1 : 0)
    assert.equal(h.applications.length, shouldAct ? 1 : 0)
    assert.equal(h.store.getGroup('g').outbox.length, shouldAct ? 1 : 0)
  })
})

test('明确他人负责、纠正误介入和多人身份不确定都可在原 Topic 静默留痕', async t => {
  for (const [name, text, explanation] of [
    ['assigned-away', '@成员甲 这项由你负责，成员乙提供资料。', '成员甲负责，未要求助手参与'],
    ['dismissed-agent', '@助理 没你的事，不是找你，这项交给成员甲。', '明确纠正助手误介入'],
    ['uncertain-alias', '@小甲 @成员乙 你把这个看一下。', '无法从多人对话确定交给助手，不猜别名或分工'],
  ]) await t.test(name, async t => {
    const h = await setup(t)
    await h.store.updateGroup({ groupId: 'g', personAliases: [{ alias: '小甲', name: '成员甲' }] })
    await ingest(h, 'discussion', { text: '讨论列表状态展示，目前尚未确定分工。' })
    const initial = (await route(h)).pendingDecisions[0]
    await complete(h, initial, { topicUpdate: { summary: '讨论列表状态展示，尚未交办。' } })
    await ingest(h, name, { text, senderOpenDingTalkId: 'participant-b' })
    const current = (await route(h, { [name]: initial.topicId })).pendingDecisions[0]
    const input = h.envelope('[GROUP_TOPIC_DECISION]')
    assert.equal(input.messages[0].text, text)
    if (name === 'uncertain-alias') assert.deepEqual(input.personAliases, [{ alias: '小甲', name: '成员甲' }])
    assert.equal((await h.call('group_decision_submit', submission(current, { actions: [], reason: explanation, topicUpdate: { summary: explanation } }))).status, 'accepted')
    await h.coordinator.drain('g')
    assert.equal(h.store.listTopics('g').length, 1)
    const topic = h.store.getTopic('g', initial.topicId)
    assert.equal(topic.summary, explanation)
    assert.deepEqual(topic.decisions.at(-1).decision.basisMessageIds, [name])
    assert.equal(h.store.listTasks().length, 0)
    assert.equal(h.applications.length, 0)
    assert.equal(h.store.getGroup('g').outbox.length, 0)
  })
})

test('引用消息正文不能作为当前消息的 contextRefs', async (t) => {
  const h = await setup(t)
  await ingest(h, 'quoted-context', { text: '@助理 这个需要修复', quotedMessage: { messageId: 'previous', content: '此前的错误详情' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const invalid = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'quoted-context', messageVersion: 1, ignoredRefs: [], units: [{
    unitKey: 'repair', summary: '修复错误', sourceRefs: [{ quote: '@助理 这个需要修复' }], contextRefs: [{ quote: '此前的错误详情', purpose: '引用消息背景' }], topics: [{ newTopicKey: 'repair', title: '错误修复' }],
  }] }] })
  assert.equal(invalid.status, 'invalid-arguments')
  assert.equal(invalid.issues[0].code, 'topic_unit_context_ambiguous')
  assert.equal(h.store.listTopics('g').length, 0)
  const routed = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'quoted-context', messageVersion: 1, ignoredRefs: [], units: [{
    unitKey: 'repair', summary: '修复错误', sourceRefs: [{ quote: '@助理 这个需要修复' }], contextRefs: [], topics: [{ newTopicKey: 'repair', title: '错误修复' }],
  }] }] })
  const current = routed.pendingDecisions[0]
  const basisUnitRefs = [{ unitId: current.messages[0].unitId, unitRevision: current.messages[0].unitRevision }]
  const action = { kind: 'new-task', title: '修复错误', objective: '修复错误', acceptanceCriteria: ['完成'], topicRefs: [{ topicId: current.topicId, revision: current.revision }], basisUnitRefs }
  assert.equal((await h.call('group_decision_submit', submission(current, { basisUnitRefs, actions: [action], reply: '开始处理', replyReview: { kind: 'confirmation' } }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 1)
})

test('引用中助手的另一事项不自动承接当前需求', async t => {
  const h = await setup(t)
  await ingest(h, 'quoted-direction', { text: '请修复 B', quotedMessage: { messageId: 'previous', content: '@助理 请修复 A' } })
  const current = (await route(h)).pendingDecisions[0]
  const input = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(input.messages[0].text, '请修复 B')
  assert.equal(input.quotedMessages[0].content, '@助理 请修复 A')
  const explanation = '引用交办的是 A，当前 B 尚未确认由助手承接，不能继承另一事项授权。'
  const action = { kind: 'task-proposal', title: '修复 B', objective: '修复 B', topicRefs: [{ topicId: current.topicId, revision: current.revision }] }
  assert.equal((await h.call('group_decision_submit', submission(current, { actions: [action], topicUpdate: { summary: explanation }, reply: '这个事项是否需要我处理？' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.store.getTopic('g', current.topicId).summary, explanation)
})

test('已建 Task 后故障，重启恢复只保留一个 Task 与 Outbox', async (t) => {
  let failed = false
  const h = await setup(t, { afterAction() { if (!failed) { failed = true; throw new Error('injected_after_task_commit') } } })
  await ingest(h, 'a', { text: '@助理 请查原因' })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '查原因', objective: '查原因', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  assert.equal((await h.call('group_decision_submit', submission(request, { actions: [action], reply: '收到', reason: undefined }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'failed')
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 0, '动作提交后的异常仍不能提前发送成功回复')
  await h.store.updateTopicDecision({ groupId: 'g', topicId: request.topicId, decisionId: request.requestId, patch: { nextRetryAt: new Date(0).toISOString() } })
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await reopened.coordinator.recover(); await reopened.coordinator.drain('g')
  assert.equal(reopened.store.listTasks().length, 1)
  assert.equal(reopened.store.getGroup('g').outbox.length, 1)
  assert.equal(reopened.store.getTopic('g', request.topicId).processedRevision, 1)
  assert.equal(reopened.store.getTopic('g', request.topicId).decisions[0].operations[0].status, 'applied')
  assert.deepEqual(reopened.applications, [])
})

test('旧决定已应用取消动作后恢复不重复取消且缺路由时不发回复', async t => {
  const cancelled = []
  const h = await setup(t, { cancelTask: taskId => cancelled.push(taskId), beforeAppend() { throw new Error('temporary-outbox-failure') } })
  const { task, request: initial } = await taskFixture(h)
  await ingest(h, 'cancel-current', { text: '@助理 停止该任务。' })
  const request = (await route(h, { 'cancel-current': initial.topicId })).pendingDecisions[0]
  const action = { kind: 'task-cancel', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
    reason: '明确停止', topicRefs: [{ topicId: request.topicId, revision: request.revision }] }
  assert.equal((await h.call('group_decision_submit', submission(request, { actions: [action], reply: '已停止。', replyToMessageId: 'cancel-current' }))).status, 'accepted')
  await h.coordinator.drain('g')
  const record = h.store.getTopic('g', request.topicId).decisions.find(item => item.decisionId === request.requestId)
  assert.equal(record.operations[0].status, 'applied')
  assert.deepEqual(cancelled, [task.taskId])
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await h.coordinator.close(); await h.store.close()
  const persisted = h.snapshot.tables.groups.g.topics.find(topic => topic.topicId === request.topicId).decisions.find(item => item.decisionId === request.requestId)
  delete persisted.decision.replyToMessageId
  delete persisted.decision.atOpenDingTalkIds
  persisted.nextRetryAt = new Date(0).toISOString()
  const replayed = []
  const reopened = await setup(t, { snapshot: h.snapshot, cancelTask: taskId => replayed.push(taskId) })
  await reopened.coordinator.recover(); await reopened.coordinator.drain('g')
  assert.deepEqual(replayed, [])
  assert.deepEqual(reopened.applications, [])
  assert.equal(reopened.store.getGroup('g').outbox.length, 0)
  assert.notEqual(reopened.store.getTopic('g', request.topicId).decisions.find(item => item.decisionId === request.requestId).status, 'completed')
})

test('任务动作拒绝时零回复；动作全部落账后才发送承接回复', async t => {
  const h = await setup(t, { beforeAction() { throw new Error('TASK_TOPIC_SOURCE_VERSION_MISSING') } })
  await ingest(h, 'a', { text: '@助理 请查原因' })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '查原因', objective: '查原因', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  await h.call('group_decision_submit', submission(request, { actions: [action], reply: '已补入任务', reason: undefined }))
  await h.coordinator.drain('g')
  const record = h.store.getTopic('g', request.topicId).decisions[0]
  assert.equal(record.status, 'blocked')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  assert.equal(h.store.listTasks().length, 0)
  const reopened = await setup(t, { snapshot: h.snapshot, beforeAppend() {
    const current = reopened.store.getTopic('g', request.topicId).decisions[0]
    assert.ok(current.operations.every(operation => operation.status === 'applied'))
    assert.equal(reopened.store.listTasks().length, 1)
  } })
  await reopened.coordinator.retryOperation({ groupId: 'g', topicId: request.topicId, decisionId: record.decisionId,
    operationId: record.failureOperationId, resolution: 'not-applied', reason: '已核对来源错误发生在任务写入之前' })
  assert.equal(reopened.store.getGroup('g').outbox.length, 1)
  await reopened.coordinator.recover(); await reopened.coordinator.drain('g')
  assert.equal(reopened.store.getGroup('g').outbox.length, 1)
  assert.equal(reopened.applications.length, 1)
})

test('同revision拒绝后新请求跨重启稳定，共享消息不转授权且已发回复不重放', async t => {
  const h = await setup(t), { task, request: initial } = await taskFixture(h)
  await ingest(h, 'shared-revision')
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: 'shared-revision', messageVersion: 1,
    topics: [{ topicId: initial.topicId, relationship: 'continuation', reason: '原任务补充' }, { newTopicKey: 'other', title: '另一个受影响话题', relationship: 'affected', reason: '同步影响' }], effectOwner: { topicId: initial.topicId } }] })
  assert.equal(routed.status, 'accepted', JSON.stringify(routed))
  const original = routed.pendingDecisions.find(item => item.topicId === initial.topicId)
  const action = { kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: '追加依据', progressImpact: 'replan',
    impactEvidence: { basisMessageIds: ['shared-revision'], reason: '需重验阶段', affectedStageIds: [stagePlanFor(task, task.stageTasks)[0].stageId] }, topicRefs: [{ topicId: original.topicId, revision: original.revision }] }
  const accepted = await h.store.acceptTopicDecision({ groupId: 'g', topicId: original.topicId, revision: original.revision, decisionId: original.requestId,
    decision: submission(original, { actions: [action], reply: '原确认' }).decision, expectedTaskVersions: [{ taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence }] })
  await h.store.appendOutbox({ groupId: 'g', sourceMessageId: `topic-decision:${original.requestId}`, decisionId: original.requestId, outboundId: accepted.record.outboundId, text: '原确认' })
  await h.store.acknowledge({ groupId: 'g', outboundId: accepted.record.outboundId, deliveredMessageId: 'already-delivered' })
  await h.coordinator.close(); await h.store.close()
  const record = h.snapshot.tables.groups.g.topics.find(topic => topic.topicId === original.topicId).decisions.at(-1)
  record.status = 'failed'; record.decision.actions[0].impactEvidence.affectedStageIds = ['bad-stage']
  const restored = await setup(t, { snapshot: h.snapshot })
  await restored.coordinator.recover(); await restored.coordinator.drain('g')
  const requests = await restored.coordinator.schedule('g')
  const retry = requests.find(item => item.topicId === original.topicId)
  assert.notEqual(retry.requestId, original.requestId)
  assert.deepEqual(retry.ownedDeltaMessageIds, ['shared-revision'])
  const other = requests.find(item => item.topicId !== original.topicId)
  assert.deepEqual(other.ownedDeltaMessageIds, [])
  const foreignAction = { ...action, topicRefs: [{ topicId: other.topicId, revision: other.revision }] }
  await assertDecisionIssue(restored.call('group_decision_submit', submission(other, { actions: [foreignAction], reply: '不应获权' })), /topic_effect_owner_required/)
  await restored.coordinator.close(); await restored.store.close()
  const again = await setup(t, { snapshot: h.snapshot })
  await again.coordinator.recover(); await again.coordinator.drain('g')
  const same = (await again.coordinator.schedule('g')).find(item => item.topicId === original.topicId)
  assert.equal(same.requestId, retry.requestId)
  assert.equal((await again.call('group_decision_submit', submission(same, { actions: [action], reply: '补充判断已完成' }))).status, 'accepted')
  await again.coordinator.drain('g')
  const after = structuredClone(again.store.getGroup('g').outbox)
  assert.equal(after.filter(item => item.outboundId === accepted.record.outboundId).length, 1)
  assert.equal(after.find(item => item.outboundId === accepted.record.outboundId).deliveredMessageId, 'already-delivered')
  assert.equal(again.store.getTask(task.taskId).inputVersion, task.inputVersion + 1)
  await again.coordinator.recover(); await again.coordinator.drain('g')
  assert.deepEqual(again.store.getGroup('g').outbox, after)
  assert.equal(again.applications.length, 1)
})

test('审阅工具同源契约通过真实 DSH 校验，并按请求种类限制字段', async (t) => {
  const samples = {
    completion: { accepted: false, reason: '缺少证据' },
    checkpoint: { decision: 'acknowledge', reason: '计划有效' },
    waiting: { decision: 'continue', reason: '依赖已恢复' },
  }
  for (const kind of [undefined, ...Object.keys(samples)]) {
    const h = await setup(t, { scope: kind ? { kind, requestId: 'review-contract' } : undefined })
    const schema = h.tools.get('group_task_review_submit').parameters
    assert.doesNotThrow(() => assertSupportedJsonSchema(schema))
    for (const [sampleKind, review] of Object.entries(samples)) {
      const errors = validateJsonSchemaValue(schema, { requestId: 'review-contract', review })
      assert.equal(errors.length === 0, !kind || kind === sampleKind, `${kind}: ${sampleKind}`)
    }
    for (const review of [{}, { decision: 'invented', reason: '不合法' }, { ...samples[kind ?? 'completion'], unauthorized: true }]) {
      assert.ok(validateJsonSchemaValue(schema, { requestId: 'review-contract', review }).length)
    }
  }
})

test('Host 审阅拒绝跨种类决策及原生投影未执行的空文本约束', async (t) => {
  for (const kind of ['checkpoint', 'waiting']) {
    const h = await setup(t), { task } = await taskFixture(h)
    const pending = h.coordinator.requestReview(kind, task, { summary: '检查' })
    const request = h.envelope(kind === 'waiting' ? '[TASK_WAITING_REVIEW]' : '[TASK_CHECKPOINT_REVIEW]', '审阅请求')
    assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: {
      decision: kind === 'waiting' ? 'acknowledge' : 'continue', reason: '跨种类',
    } })).status, 'invalid-arguments')
    const decision = kind === 'waiting' ? 'continue' : 'acknowledge'
    assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision, reason: ' ' } })).status, 'invalid-arguments')
    assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision, reason: '已核验' } })).status, 'accepted')
    assert.equal((await pending).decision, decision)
  }
})

test('内部审阅按请求绑定 Task 版本，拒绝错种类和版本变更', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const promise = h.coordinator.requestReview('completion', task, { summary: '完成', evidence: ['通过'] })
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }))
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: 'ok' } }), /task_review_kind_invalid/)
  await h.store.updateTask(task.taskId, (current) => ({ ...current, inputVersion: current.inputVersion + 1 }))
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '完成' } })).status, 'task-stale')
  assert.match((await outcome).error.message, /task_review_context_changed/)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('完成审阅一次提交通知草稿，Task 落盘后才写入 Outbox', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('delivery')], 0)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, state: 'running', taskPromptRefs: [{ id: 'delivery', revision: 1 }] }))
  const result = { inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'completed', summary: '完成', evidence: ['通过'], artifacts: [] }
  const pending = h.coordinator.requestReview('completion', task, result)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  const context = h.envelope('[TASK_COMPLETION_REVIEW]', '通知上下文')
  assert.equal(context.messages.length, 1)
  assert.equal(h.sent.some((item) => item.startsWith('[TASK_COORDINATION]')), false)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['delivery'] })
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '证据完整', notification: {
    reply: '核验已完成', replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
  } } })).status, 'accepted')
  const review = await pending
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  const completed = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result }))
  await h.store.setTaskPrompts([reviewPrompt('delivery', '完成后变更配置，不撤销历史完成事实')], 1)
  const outbound = await h.coordinator.commitCompletionNotification(review.preparedNotification, completed, result)
  assert.equal(outbound.text, '核验已完成')
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.sent.some((item) => item.startsWith('[TASK_COORDINATION]')), false)
})

test('完成审阅后新增历史候选使通知草稿失效', async (t) => {
  let candidates = []
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) }), fixture = await taskFixture(h)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, state: 'running' }))
  const result = { inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'completed', summary: '完成', evidence: ['通过'], artifacts: [] }
  const pending = h.coordinator.requestReview('completion', task, result)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '证据完整', notification: {
    reply: '核验已完成', replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
  } } })
  const review = await pending
  const completed = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result }))
  candidates = [{ outboundId: 'new-result', sourceMessageId: 'a1', reply: '刚到达的结果', taskIds: [task.taskId] }]
  assert.equal((await h.coordinator.commitCompletionNotification(review.preparedNotification, completed, result)).status, 'review-required')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('完成审阅只内联受限的近期 Topic 消息', async (t) => {
  const h = await setup(t)
  await ingest(h, 'history-0', { text: `@助理 ${'长'.repeat(900)}` })
  const first = (await route(h)).pendingDecisions[0]
  await complete(h, first)
  let revision = first.revision
  for (let index = 1; index < 25; index++) {
    await ingest(h, `history-${index}`, { text: `@助理 ${index}-${'长'.repeat(900)}` })
    const request = (await route(h, { [`history-${index}`]: first.topicId })).pendingDecisions[0]
    revision = request.revision
    await complete(h, request)
  }
  const { task: created } = await h.store.createTask({ groupId: 'g', topicRefs: [{ topicId: first.topicId, revision }], title: '长话题核验', objective: '核验', acceptanceCriteria: ['证据'] })
  const task = await h.store.updateTask(created.taskId, (current) => ({ ...current, state: 'running' }))
  const pending = h.coordinator.requestReview('completion', task, { inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'completed', summary: '完成', evidence: ['通过'], artifacts: [] })
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  const context = h.envelope('[TASK_COMPLETION_REVIEW]', '通知上下文')
  assert.equal(context.totalMessages, 25)
  assert.ok(context.messages.length <= 20)
  assert.ok(JSON.stringify(context.messages).length <= 12_000)
  assert.equal(context.hasMoreMessages, true)
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: false, reason: '仅核验上下文预算' } })
  assert.equal((await pending).accepted, false)
})

test('内部检查点必须结构化确认，不能携带相互矛盾的 guidance', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const promise = h.coordinator.requestReview('checkpoint', task, { summary: '计划完成' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: 'ok', guidance: '改计划' } }), /task_review_guidance_invalid/)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'guidance', reason: '范围遗漏', guidance: '补异常分支' } })).status, 'accepted')
  assert.deepEqual(await promise, { decision: 'guidance', reason: '范围遗漏', guidance: '补异常分支' })
})

async function readReviewSection(h, requestId, section) {
  let offset = 0, text = ''
  while (true) {
    const page = await h.call('group_task_review_context_get', { requestId, section, offset })
    assert.ok(JSON.stringify(page).length <= 12_000)
    text += page.text
    if (!page.hasMore) return JSON.parse(text)
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  }
}

test('话题上下文剩余预算连一个字符也装不下时保留已装入消息', () => {
  const first = { messageId: 'first', unitId: 'unit-first', unitRevision: 1, text: '已读消息' }
  const second = { messageId: 'second', unitId: 'unit-second', unitRevision: 1, text: '后续消息' }
  const context = { topic: {}, messages: [first, second], offset: 0, total: 2, taskRefs: [] }
  const budget = JSON.stringify(boundedTopicContext({ ...context, messages: [first] })).length
  const result = boundedTopicContext(context, { maxChars: budget })
  assert.deepEqual(result.messages.map(message => message.messageId), ['first'])
  assert.equal(result.nextOffset, 1)
  assert.equal(result.nextTextOffset, undefined)
  assert.equal(result.hasMoreMessages, true)
  assert.ok(JSON.stringify(result).length <= budget)
})
const reviewPrompt = (id, prompt = '按流程核验') => ({ id, name: id, description: `${id}适用范围`, prompt, enabled: true })

test('单条超长消息保持 12k 硬预算并可完整续读', async (t) => {
  const h = await setup(t), original = `@助理 ${'长'.repeat(26_000)}`
  const { task } = await taskFixture(h, { text: original })
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '计划' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  const context = h.envelope('[TASK_CHECKPOINT_REVIEW]', '任务原始上下文')
  assert.ok(JSON.stringify(context.messages).length <= 12_000)
  assert.equal(context.hasMoreMessages, true)
  assert.equal(context.messages[0].messageId, 'a1')
  assert.equal(context.messages[0].textHasMore, true)
  const restored = await readReviewSection(h, request.requestId, 'messages')
  assert.equal(restored[0].text, original)
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '已读原文' } })
  assert.equal((await pending).decision, 'acknowledge')
  const reply = h.coordinator.requestReply(task, { status: 'waiting', summary: '等待确认' }, 'fallback-budget').catch((error) => error)
  const replyContext = h.envelope('[TASK_COORDINATION]')
  assert.ok(JSON.stringify(replyContext.messages).length <= 12_000)
  assert.equal(replyContext.hasMoreMessages, true)
  await h.coordinator.close()
  await reply
})

test('超长目标及审阅结果分页保留原文，越序读取不能绕过完整读取门禁', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  const objective = '目标"\\\n'.repeat(20_000)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, objective }))
  const value = { kind: 'plan-confirmed', summary: '说明'.repeat(20_000), evidence: ['证据'] }
  const pending = h.coordinator.requestReview('checkpoint', task, value)
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.ok(h.sent.at(-1).length <= TASK_REVIEW_MAX_CHARS)
  const args = { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } }
  assert.deepEqual((await h.call('group_task_review_submit', args)).unreadSections.sort(), ['objective', 'value'])
  assert.equal((await h.call('group_task_review_submit', { ...args, review: { decision: 'guidance', reason: '指引也会使计划生效', guidance: '继续核验' } })).status, 'context-review-required')
  await h.call('group_task_review_context_get', { requestId: request.requestId, section: 'objective', offset: JSON.stringify(objective).length })
  assert.equal((await h.call('group_task_review_submit', args)).status, 'context-review-required')
  assert.equal(await readReviewSection(h, request.requestId, 'objective'), objective)
  assert.deepEqual(await readReviewSection(h, request.requestId, 'value'), value)
  assert.equal((await h.call('group_task_review_submit', args)).status, 'accepted')
  await pending
})

test('无专用流程时审阅者仍可见目录和选择依据并读取未选候选', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('investigate'), reviewPrompt('repair')], 0)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, executionEvents: [{ kind: 'task-prompts-selected', inputVersion: current.inputVersion, taskPromptRefs: [], reason: '暂认为无需专用流程' }] }))
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '计划' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.deepEqual(h.envelope('[TASK_CHECKPOINT_REVIEW]', '可用流程索引').map((item) => item.id), ['investigate', 'repair'])
  assert.equal(h.envelope('[TASK_CHECKPOINT_REVIEW]', '流程选择依据').reason, '暂认为无需专用流程')
  assert.equal((await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['repair'] })).prompts[0].prompt, '按流程核验')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'reject', reason: '应补选修复流程' } })).status, 'accepted')
  assert.equal((await pending).decision, 'reject')
})

test('审阅读取后已选或未选候选改版、禁用、删除都使旧请求失效，无关配置不影响', async (t) => {
  for (const selected of [true, false]) for (const change of ['revision', 'disabled', 'deleted']) {
    const h = await setup(t), fixture = await taskFixture(h)
    await h.store.setTaskPrompts([reviewPrompt('flow'), reviewPrompt('other')], 0)
    const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, taskPromptRefs: selected ? [{ id: 'flow', revision: 1 }] : [] }))
    const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '计划' })
    const outcome = pending.then((value) => ({ value }), (error) => ({ error }))
    const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
    await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['flow'] })
    const updated = change === 'deleted' ? [] : [{ ...reviewPrompt('flow', change === 'revision' ? '新版流程' : '按流程核验'), enabled: change !== 'disabled' }]
    await h.store.setTaskPrompts([...updated, reviewPrompt('other')], 1)
    assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } })).status, 'task-stale')
    assert.match((await outcome).error.message, /task_prompt_selection_stale:flow/)
    await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '迟到' } }), /task_review_request_unknown/)
  }
  const h = await setup(t), { task } = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('other')], 0)
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '无匹配流程' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  await h.store.setTaskPrompts([reviewPrompt('other', '新内容')], 1)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '无匹配，通用规范即可' } })).status, 'accepted')
  await pending
})

test('多流程组合一次批量读取，后续检查点会使原审阅失效', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('investigate'), reviewPrompt('repair')], 0)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, taskPromptRefs: [{ id: 'investigate', revision: 1 }, { id: 'repair', revision: 1 }] }))
  const outcome = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '组合计划' }).then((value) => ({ value }), (error) => ({ error }))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  const args = { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } }
  await assert.rejects(h.call('group_task_prompt_get', { requestId: request.requestId, ids: [] }), /task_review_prompt_ids_required/)
  assert.deepEqual((await h.call('group_task_review_submit', args)).missingPromptRefs, [{ id: 'investigate', revision: 1 }, { id: 'repair', revision: 1 }])
  const promptResult = await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['investigate', 'investigate', 'repair'] })
  assert.deepEqual(promptResult.prompts.map((item) => item.id), ['investigate', 'repair'])
  await h.store.updateTask(task.taskId, (current) => ({ ...current, checkpoints: [{ checkpointId: 'later-diagnostic', inputVersion: current.inputVersion, runSequence: current.runSequence, kind: 'scope-conflict', summary: '需要改计划', evidence: [], completedItems: [], remainingItems: [], nextStep: '协调', needsCoordinatorDecision: true, submittedAt: '2026-09-09T01:00:00Z' }] }))
  assert.equal((await h.call('group_task_review_submit', args)).status, 'task-stale')
  assert.match((await outcome).error.message, /task_review_context_changed/)
})

test('诊断检查点可在旧流程删除后不读取流程获得协调意见', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('candidate')], 0)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, taskPromptRefs: [{ id: 'removed', revision: 1 }] }))
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'scope-conflict', summary: '旧流程不可用' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['candidate'] })
  await h.store.setTaskPrompts([reviewPrompt('candidate', '改版候选')], 1)
  assert.equal((await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['candidate'] })).status, 'prompt-unavailable')
  const updatedTask = await h.store.updateTask(task.taskId, (current) => ({ ...current, taskPromptRefs: [] }))
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'guidance', reason: '重订计划', guidance: '按当前索引匹配' } })).status, 'accepted')
  assert.equal((await pending).decision, 'guidance')
  const longReport = h.coordinator.requestReview('checkpoint', updatedTask, { kind: 'evidence-gap', summary: '缺失证据'.repeat(10_000) })
  const longRequest = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.ok(h.sent.at(-1).length <= TASK_REVIEW_MAX_CHARS)
  assert.equal((await h.call('group_task_review_submit', { requestId: longRequest.requestId, review: { decision: 'acknowledge', reason: '已知悉缺口，继续协调' } })).status, 'accepted')
  assert.equal((await longReport).decision, 'acknowledge')
})

test('通知回退同样限制整体预算并须读完超长目标结果后才允许入队', async (t) => {
  const h = await setup(t), fixture = await taskFixture(h)
  const objective = '回退目标'.repeat(20_000)
  const result = { inputVersion: fixture.task.inputVersion, runSequence: fixture.task.runSequence, status: 'completed', summary: '实际结果'.repeat(20_000), evidence: ['已验证'], artifacts: [] }
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, state: 'completed', objective, result }))
  const pending = h.coordinator.requestReply(task, result, 'large-result-fallback')
  const request = h.envelope('[TASK_COORDINATION]')
  assert.ok(h.sent.at(-1).length <= TASK_REVIEW_MAX_CHARS)
  const args = { requestId: request.requestId, reply: '已完成', replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } }
  assert.equal((await h.call('group_reply_submit', args)).status, 'context-review-required')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  assert.equal(await readReviewSection(h, request.requestId, 'objective'), objective)
  assert.deepEqual(await readReviewSection(h, request.requestId, 'result'), result)
  assert.equal((await h.call('group_reply_submit', args)).status, 'accepted')
  assert.equal((await pending).text, '已完成')
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('协调方使指定 Task 审阅失效后拒绝迟到结果', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const outcome = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '旧计划' }).then((value) => ({ value }), (error) => ({ error }))
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  h.coordinator.invalidateTaskReviews(task.taskId, 'task_checkpoint_superseded')
  assert.equal((await outcome).error.message, 'task_checkpoint_superseded')
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '迟到' } }), /task_review_request_unknown/)
})

test('Topic 按需搜索分页及固定版本读回，跨群与越界拒绝', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); await ingest(h, 'b')
  const routed = await route(h, { a: { newTopicKey: 'shared', title: '导出核验' }, b: { newTopicKey: 'shared', title: '导出核验' } })
  const request = routed.pendingDecisions[0]
  const listSchema=h.tools.get('group_topic_list').parameters,contextSchema=h.tools.get('group_topic_context_get').parameters
  for(const schema of [listSchema,contextSchema])assert.doesNotThrow(()=>assertSupportedJsonSchema(schema))
  assert.match(listSchema.properties.limit.description,/1\.\.100，默认50/)
  assert.match(contextSchema.properties.limit.description,/消息条数，非字符数，整数1\.\.500，默认10/)
  assert.match(contextSchema.properties.revision.description,/1\.\.当前Topic revision/)
  assert.match(contextSchema.properties.textOffset.description,/UTF-16字符偏移/)
  assert.equal((await h.call('group_topic_list',{})).limit,50)
  assert.equal((await h.call('group_topic_context_get',{topicId:request.topicId})).limit,10)
  assert.equal((await h.call('group_topic_list',{limit:100})).limit,100)
  assert.equal((await h.call('group_topic_context_get',{topicId:request.topicId,limit:500})).limit,500)
  for(const limit of [0,101,10000])await assert.rejects(h.call('group_topic_list',{limit}),/topic_page_invalid/)
  for(const limit of [0,501,10000])await assert.rejects(h.call('group_topic_context_get',{topicId:request.topicId,limit}),/topic_page_invalid/)
  for(const revision of [0,request.revision+1])await assert.rejects(h.call('group_topic_context_get',{topicId:request.topicId,revision}),/topic_revision_invalid/)
  for(const textOffset of [-1,10000])await assert.rejects(h.call('group_topic_context_get',{topicId:request.topicId,textOffset}),/topic_text_offset_invalid/)
  await assert.rejects(h.call('group_topic_context_get',{topicId:request.topicId,offset:-1}),/topic_page_invalid/)
  const index = await h.call('group_topic_list', { query: '导出', offset: 0, limit: 1 })
  assert.equal(index.total, 1)
  assert.deepEqual(index.topics[0].readCall, { name: 'group_topic_context_get', arguments: { topicId: request.topicId, revision: request.revision } })
  const page = await h.call('group_topic_context_get', { topicId: request.topicId, revision: 1, offset: 0, limit: 1 })
  assert.equal(page.total, 1)
  assert.equal(page.messages[0].messageId, 'a')
  await assert.rejects(h.call('group_topic_context_get', { topicId: 'foreign-topic', revision: 1 }), /topic_not_found/)
  await assert.rejects(h.call('group_topic_list', { offset: -1 }), /topic_page_invalid/)
})

test('普通已处理话题补齐空摘要，不重做任务动作，之后不重复补齐', async t => {
  const h = await setup(t)
  await ingest(h, 'summary-backfill')
  const request = (await route(h, { 'summary-backfill': { newTopicKey: 'summary-backfill', title: '排查保存失败' } })).pendingDecisions[0]
  await complete(h, request)
  await h.coordinator.schedule('g')
  const pending = h.envelope('[GROUP_TOPIC_SUMMARY_MIGRATION]')
  assert.equal(pending.topicId, request.topicId)
  const before = h.applications.length
  const summary = '排查保存失败，当前仅完成讨论，尚无修复结论。'
  assert.equal((await h.call('group_topic_summary_submit', { requestId: pending.requestId, topicId: pending.topicId, summary })).status, 'accepted')
  const topic = h.store.getTopic('g', pending.topicId)
  assert.equal(topic.summary, summary)
  assert.equal(topic.summaryRevision, topic.revision)
  assert.equal(h.applications.length, before)
  const count = h.sent.length
  await h.coordinator.schedule('g')
  assert.equal(h.sent.length, count)
})

test('历史 Topic 先根据引用消息补 summary，再据此重生成 title', async (t) => {
  const h = await setup(t)
  await ingest(h, 'legacy')
  const request = (await route(h, { legacy: { newTopicKey: 'legacy', title: '历史话题' } })).pendingDecisions[0]
  await complete(h, request)
  const summary = '统一编辑器草稿和工作区的地理位置字段，并完成导入、复制、保存及历史数据兼容验证。'
  const topic = h.store.getTopic('g', request.topicId)
  // 模拟 v6 迁移形成的空摘要 Topic；迁移标记只来自历史数据。
  topic.migrationBaseline = true
  await h.store.updateTopicTitle({ groupId: 'g', topicId: topic.topicId, expectedTitle: topic.title, expectedSummary: topic.summary, title: '修复编辑器草稿详情页地理位置字段命名并完成所有相关场景兼容验证' })

  await h.coordinator.schedule('g')
  const summaryMigration = h.envelope('[GROUP_TOPIC_SUMMARY_MIGRATION]')
  assert.deepEqual(Object.keys(summaryMigration).sort(), ['messages', 'requestId', 'revision', 'topicId', 'totalMessages'])
  assert.equal(summaryMigration.messages[0].messageId, 'legacy')
  assert.equal((await h.call('group_topic_summary_submit', { requestId: summaryMigration.requestId, topicId: topic.topicId, summary })).status, 'accepted')
  assert.equal(h.store.getTopic('g', topic.topicId).summary, summary)

  const migration = h.envelope('[GROUP_TOPIC_TITLE_MIGRATION]')
  const legacy = h.store.getTopic('g', topic.topicId)
  assert.deepEqual(Object.keys(migration).sort(), ['requestId', 'summary', 'topicId'])
  assert.equal(migration.summary, summary)
  assert.equal((await h.store.updateTopicTitle({ groupId: 'g', topicId: topic.topicId, expectedTitle: legacy.title, expectedSummary: `${summary}已更新`, title: '错误的过期标题' })).status, 'topic-stale')
  assert.equal(h.store.getTopic('g', topic.topicId).title, legacy.title)
  await assert.rejects(h.call('group_topic_title_submit', { requestId: migration.requestId, topicId: topic.topicId, title: summary.slice(0, 30) }), /topic_title_truncation_rejected/)
  assert.equal((await h.call('group_topic_title_submit', { requestId: migration.requestId, topicId: topic.topicId, title: '编辑器地理位置字段统一' })).status, 'accepted')
  assert.equal(h.store.getTopic('g', topic.topicId).title, '编辑器地理位置字段统一')
})

test('Task 通知要求真实 Topic 引用及参与人，并拒绝旧 Task 输入', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const replyTask = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result: { inputVersion: current.inputVersion, runSequence: current.runSequence, status: 'completed', summary: '已核验', evidence: ['核验通过'], artifacts: [] } }))
  const promise = h.coordinator.requestReply(replyTask, replyTask.result, 'task-result:fixture')
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }))
  const request = h.envelope('[TASK_COORDINATION]')
  await assert.rejects(h.call('group_reply_submit', { requestId: request.requestId, reply: '结果', replyReview: { kind: 'substantive' }, replyToMessageId: 'a1', atOpenDingTalkIds: ['foreign'] }), /group_reply_recipient_not_in_topic/)
  await h.store.updateTask(task.taskId, (current) => ({ ...current, inputVersion: current.inputVersion + 1 }))
  assert.equal((await h.call('group_reply_submit', { requestId: request.requestId, reply: '结果', replyReview: { kind: 'substantive' }, replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'] })).status, 'task-stale')
  assert.match((await outcome).error.message, /task_result_context_changed/)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.store.getCoordinationRequest('g', request.requestId).status, 'superseded')
})

test('同Topic新版本保留尚未接纳的同轮请求与持久协调账', async (t) => {
  const h = await setup(t); await ingest(h, 'a1')
  const old = (await route(h)).pendingDecisions[0]
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.store.getCoordinationRequest('g', old.requestId).status, 'pending')
  await ingest(h, 'a2')
  await route(h, { a2: old.topicId })
  await new Promise(resolve => setImmediate(resolve))
  const current = h.envelope('[GROUP_TOPIC_DECISION]')
  const terminal = h.store.getCoordinationRequest('g', old.requestId)
  assert.equal(terminal.status, 'pending')
  assert.equal(current.requestId, old.requestId)
  assert.equal(current.revision, 2)
})

test('普通Task通知与完成通知一致：引用消息时省略at默认关联发送人', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const replyTask = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result: { inputVersion: current.inputVersion, runSequence: current.runSequence, status: 'completed', summary: '已核验', evidence: ['核验通过'], artifacts: [] } }))
  const promise = h.coordinator.requestReply(replyTask, replyTask.result, 'task-result:default-recipient')
  const request = h.envelope('[TASK_COORDINATION]')
  const result = await h.call('group_reply_submit', { requestId: request.requestId, reply: '结果', replyReview: { kind: 'substantive' }, replyToMessageId: 'a1' })
  assert.equal(result.status, 'accepted')
  const outbound = await promise
  assert.equal(outbound.replyToMessageId, 'a1')
  assert.deepEqual(outbound.atOpenDingTalkIds, ['od-a'])
  assert.equal(h.store.getCoordinationRequest('g', request.requestId).status, 'completed')
})

test('审阅后历史候选变化必须重新读取，不能用旧快照发新回复', async (t) => {
  let candidates = [{ outboundId: 'old-1', sourceMessageId: 'a', reply: '旧结果' }]
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) })
  await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  candidates = [...candidates, { outboundId: 'new-2', sourceMessageId: 'a', reply: '另一请求刚发的结果' }]
  const result = await h.call('group_decision_submit', submission(request, { reason: undefined, reply: '新回复', replyReview: { kind: 'substantive', reviewedOutboundIds: ['old-1'], sameMatterOutboundIds: [], replaceOutboundIds: [] } }))
  assert.equal(result.status, 'review-required')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})



test('审阅后的Task瞬态运行状态不使候选事实失效，正文来源和归属仍须重读', async (t) => {
  for (const change of ['state', 'terminal-state', 'reply', 'source', 'ownership']) {
    const candidates = [{ outboundId: 'old-a', sourceMessageId: 'a', reply: '旧结果', taskIds: ['task-a'],
      tasks: [{ taskId: 'task-a', objective: '核验', state: 'running' }] }]
    const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) })
    await ingest(h, 'a')
    const request = (await route(h)).pendingDecisions[0]
    await h.call('group_reply_review_get', { requestIds: [request.requestId] })
    if (change === 'state') candidates[0].tasks[0].state = 'waiting'
    else if (change === 'terminal-state') candidates[0].tasks[0].state = 'completed'
    else if (change === 'reply') candidates[0].reply = '新结果'
    else if (change === 'source') candidates[0].sourceMessages = [{ messageId: 'a', text: '更新来源' }]
    else candidates[0].taskIds = ['task-b']
    const args = submission(request, { reply: '新回复', replyReview: { kind: 'substantive', reviewedOutboundIds: ['old-a'], sameMatterOutboundIds: [], replaceOutboundIds: [] } })
    const result = await h.call('group_decision_submit', args)
    assert.equal(result.status, change === 'state' ? 'accepted' : 'review-required', change)
    if (change !== 'state') {
      assert.equal(result.nextAction, 'group_reply_review_get')
      assert.deepEqual(result.requestIds, [request.requestId])
      assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
      await h.call(result.nextAction, { requestIds: result.requestIds })
      assert.equal((await h.call('group_decision_submit', args)).status, 'accepted')
    }
    await h.coordinator.drain('g')
    assert.equal(h.store.getGroup('g').outbox.length, 1)
  }
})

test('无关 B 的新历史回复不使 A 的候选审阅失效', async (t) => {
  let candidates = [{ outboundId: 'old-a', sourceMessageId: 'a', reply: 'A 旧结果' }]
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) })
  await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  candidates.push({ outboundId: 'new-b', sourceMessageId: 'b', reply: '无关 B 的结果' })
  const result = await h.call('group_decision_submit', submission(request, { reply: 'A 新回复', replyReview: { kind: 'substantive', reviewedOutboundIds: ['old-a'], sameMatterOutboundIds: [], replaceOutboundIds: [] } }))
  assert.equal(result.status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('决策进入 Store 队列后候选变化仍在原子提交点拦截', async (t) => {
  let candidates = [{ outboundId: 'old-a', sourceMessageId: 'a', reply: 'A 旧结果' }]
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) })
  await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  const original = h.store.acceptTopicDecision
  h.store.acceptTopicDecision = async (args) => {
    candidates.push({ outboundId: 'new-a', sourceMessageId: 'a', reply: '提交前插入 A 结果' })
    return original(args)
  }
  const result = await h.call('group_decision_submit', submission(request, { reply: 'A 新回复', replyReview: { kind: 'substantive', reviewedOutboundIds: ['old-a'], sameMatterOutboundIds: [], replaceOutboundIds: [] } }))
  assert.equal(result.status, 'review-required')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
})

test('Task 通知在 Outbox 落盘前再次核对输入版本', async (t) => {
  let taskId
  const h = await setup(t, { beforeAppend: async () => { await h.store.updateTask(taskId, (current) => ({ ...current, inputVersion: current.inputVersion + 1 })) } })
  const { task } = await taskFixture(h); taskId = task.taskId
  const replyTask = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result: { inputVersion: current.inputVersion, runSequence: current.runSequence, status: 'completed', summary: '已核验', evidence: ['核验通过'], artifacts: [] } }))
  const promise = h.coordinator.requestReply(replyTask, replyTask.result, 'task-result:atomic')
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }))
  const request = h.envelope('[TASK_COORDINATION]')
  const result = await h.call('group_reply_submit', { requestId: request.requestId, reply: '结果', replyReview: { kind: 'substantive' }, replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'] })
  assert.equal(result.status, 'task-stale')
  assert.match((await outcome).error.message, /task_result_context_changed/)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('Task 通知读取最新相关候选后可提交，重试不产生第二条 Outbox', async (t) => {
  let candidates = []
  const h = await setup(t, { reviewCandidates: () => structuredClone(candidates) }), { task } = await taskFixture(h)
  const replyTask = await h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', result: { inputVersion: current.inputVersion, runSequence: current.runSequence, status: 'completed', summary: '已核验', evidence: ['核验通过'], artifacts: [] } }))
  const promise = h.coordinator.requestReply(replyTask, replyTask.result, 'task-result:success')
  const request = h.envelope('[TASK_COORDINATION]')
  candidates = [{ outboundId: 'just-arrived', sourceMessageId: 'a1', reply: '本任务先前的结果', taskIds: [task.taskId] }]
  const args = { requestId: request.requestId, reply: '核验结果', replyReview: { kind: 'substantive' }, replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'] }
  assert.equal((await h.call('group_reply_submit', args)).status, 'review-required')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  const read = await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  assert.deepEqual(read.candidates.map((item) => item.outboundId), ['just-arrived'])
  const accepted = await h.call('group_reply_submit', { ...args, replyReview: { kind: 'substantive', reviewedOutboundIds: ['just-arrived'], sameMatterOutboundIds: [], replaceOutboundIds: [] } })
  assert.equal(accepted.status, 'accepted')
  assert.equal((await promise).text, '核验结果')
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  const recovered = await h.call('group_reply_submit', args)
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.outboundId, accepted.outboundId)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('未知回复请求不可用且不产生 Outbox', async (t) => {
  const h = await setup(t)
  const result = await h.call('group_reply_submit', { requestId: 'missing', reply: '不应发送' })
  assert.deepEqual(result, { status: 'request-unavailable', nextAction: 'wait-for-current-request' })
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})


test('本地已知瞬时错误最多三次，跨重启保存预算并保持冲突保留', async t => {
  const h = await setup(t, { beforeAction() { throw Object.assign(new Error('暂时不可写'), { code: 'storage_transient' }) } })
  await ingest(h, 'retry-budget')
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  await h.call('group_decision_submit', submission(request, { actions: [action], reply: '收到' })); await h.coordinator.drain('g')
  const saved = () => h.store.getTopic('g', request.topicId).decisions[0]
  assert.equal(saved().attempt, 1); assert.ok(saved().nextRetryAt)
  for (let i = 0; i < 2; i++) {
    await h.store.updateTopicDecision({ groupId: 'g', topicId: request.topicId, decisionId: request.requestId, patch: { nextRetryAt: new Date(0).toISOString() } })
    await h.coordinator.recover(); await h.coordinator.drain('g')
  }
  assert.equal(saved().status, 'blocked'); assert.equal(saved().attempt, 3)
  assert.equal(h.applications.length, 3); assert.ok(h.store.getGroup('g').taskReservations.length)
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await reopened.coordinator.recover(); await reopened.coordinator.drain('g')
  assert.equal(reopened.applications.length, 0)
  assert.equal(reopened.store.getTopic('g', request.topicId).decisions[0].attempt, 3)
})

test('未知错误停住，普通消息重试不解锁；显式原操作对账恢复', async t => {
  let fail = true
  const h = await setup(t, { beforeAction() { if (fail) throw new Error('unknown-effect') } })
  await ingest(h, 'unknown')
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  await h.call('group_decision_submit', submission(request, { actions: [action], reply: '收到' })); await h.coordinator.drain('g')
  const record = h.store.getTopic('g', request.topicId).decisions[0]
  assert.equal(record.status, 'blocked')
  await h.coordinator.retryMessage('g', 'unknown'); await h.coordinator.drain('g')
  assert.equal(h.applications.length, 1)
  const args = { groupId: 'g', topicId: request.topicId, decisionId: record.decisionId, operationId: record.operations[0].operationId, reason: '独立查询确认Task尚未创建' }
  await assert.rejects(h.coordinator.retryOperation({ ...args, resolution: 'applied' }), /evidence_conflict/)
  fail = false
  await h.coordinator.retryOperation({ ...args, resolution: 'not-applied' }); await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'completed')
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(new Set(h.applications).size, 1)
})

test('取消控制可越过已阻塞保留，普通上下文和进行中保留仍拒绝', async t => {
  const h = await setup(t), { task } = await taskFixture(h)
  const cancel = { kind: 'task-cancel', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, reason: '明确撤销' }
  const first = await h.store.submitWebTaskInput({ groupId: 'g', requestId: 'cancel-first', text: '停止任务', action: cancel })
  assert.equal(first.status, 'accepted')
  assert.equal((await h.store.submitWebTaskInput({ groupId: 'g', requestId: 'cancel-busy', text: '停止任务', action: cancel })).status, 'task-busy')
  await h.store.updateTopicDecision({ groupId: 'g', topicId: first.topicId, decisionId: first.record.decisionId, patch: { status: 'blocked' } })
  assert.equal((await h.store.submitWebTaskInput({ groupId: 'g', requestId: 'context-busy', text: '继续核验', action: { ...cancel, kind: 'task-context', context: '继续核验' } })).status, 'task-busy')
  const next = await h.store.submitWebTaskInput({ groupId: 'g', requestId: 'cancel-again', text: '明确停止', action: cancel })
  assert.equal(next.status, 'accepted')
  assert.equal(h.store.getTopic('g', first.topicId).decisions[0].status, 'blocked')
  assert.equal(h.store.getGroup('g').taskReservations.filter(item => item.taskId === task.taskId).length, 2)
})

test('部分成功时不能用已应用动作或Outbox的对账解锁另一未知操作', async t => {
  let fail = true
  const h = await setup(t, { beforeAction(operation) { if (operation.actionIndex === 1 && fail) throw new Error('second-operation-unknown') } })
  await ingest(h, 'two-actions')
  const request = (await route(h)).pendingDecisions[0]
  const actions = ['A', 'B'].map(title => ({ kind: 'new-task', title, objective: title, acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }))
  assert.equal((await h.call('group_decision_submit', submission(request, { actions, reply: '核验两项' }))).status, 'accepted')
  await h.coordinator.drain('g')
  const record = h.store.getTopic('g', request.topicId).decisions[0]
  assert.equal(record.status, 'blocked')
  assert.equal(record.operations[0].status, 'applied'); assert.equal(record.operations[1].status, 'blocked')
  assert.equal(record.failureOperationId, record.operations[1].operationId)
  const args = { groupId: 'g', topicId: request.topicId, decisionId: record.decisionId, resolution: 'applied', reason: '第一个动作已经应用' }
  for (const operationId of [record.operations[0].operationId, record.outboundId]) {
    await assert.rejects(h.coordinator.retryOperation({ ...args, operationId }), /wrong_failed_operation/)
  }
  assert.equal(h.applications.length, 2)
  assert.equal(h.store.listTasks().length, 1)
  fail = false
  await h.coordinator.retryOperation({ ...args, operationId: record.operations[1].operationId, resolution: 'not-applied', reason: '独立核对第二项未创建' })
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 2)
  assert.equal(h.applications.filter(id => id === record.operations[0].operationId).length, 1)
})

test('已接受决策已落盘后到期对账完成，不重复执行动作', { timeout: 2_000 }, async (t) => {
  let attempt = 0, recovered
  const secondAttempt = new Promise((resolve) => { recovered = resolve })
  const h = await setup(t, { retryDelayMs: 10, afterAction() { attempt += 1; if (attempt === 1) throw new Error('temporary_action_failure') } })
  const completeDecision = h.store.completeTopicDecision
  h.store.completeTopicDecision = async args => { const result = await completeDecision(args); recovered(); return result }
  await ingest(h, 'a', { text: '@助理 请查原因' })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '查原因', objective: '查原因', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  assert.equal((await h.call('group_decision_submit', submission(request, { actions: [action], reply: '收到' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'failed')
  await secondAttempt
  await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'completed')
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.applications.length, 1)
  assert.equal(new Set(h.applications).size, 1)
})

test('共享消息由主 Topic 统一回复，其他 Topic 不重复确认或实质回答', async (t) => {
  const h = await setup(t); await ingest(h, 'shared', { text: '@助理 同时核对两个事项' }); await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: 'shared', messageVersion: 1, topics: [
    { newTopicKey: 'a', title: 'A', relationship: 'continuation', reason: '继续事项 A' },
    { newTopicKey: 'b', title: 'B', relationship: 'affected', reason: '同时改变事项 B' },
  ], effectOwner: { newTopicKey: 'b' } }] })
  const [a, b] = routed.pendingDecisions
  assert.equal(a.effectOwnerTopicIds.shared, b.topicId)
  assert.deepEqual(a.ownedDeltaMessageIds, [])
  assert.deepEqual(b.ownedDeltaMessageIds, ['shared'])
  const action = (request) => ({ kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] })
  await assertDecisionIssue(h.call('group_decision_submit', submission(a, { actions: [action(a)], reply: '收到' })), /topic_effect_owner_required/)
  await assertDecisionIssue(h.call('group_decision_submit', submission(a, { reply: '收到', replyReview: { kind: 'confirmation' } })), /topic_effect_owner_required/)
  assert.equal((await h.call('group_decision_submit', submission(a, { reply: 'A 的独立分析结果', replyReview: { kind: 'substantive' } }))).status, 'reply-owned-by-other-topic')
  assert.equal((await h.call('group_decision_submit', submission(b, { actions: [action(b)], reply: '收到', replyReview: { kind: 'confirmation' } }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 1)
})

test('非空回复必须声明 kind，不能用省略审阅绕过共享确认门禁', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  const args = submission(request, { reply: '收到' }); delete args.decision.replyReview
  assert.deepEqual(await h.call('group_decision_submit', args), { status: 'review-required', error: 'reply_kind_required' })
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('改归属后空 Topic 可以用 removedMessageIds 静默完成，但不能创建任务', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const original = (await route(h)).pendingDecisions[0]
  await complete(h, original)
  await h.store.routeMessages({ groupId: 'g', routeId: 'correct-route', routingRevision: h.store.getGroup('g').routingRevision, routes: [{ messageId: 'a', messageVersion: 1, topics: [{ newTopicKey: 'corrected', title: '正确话题' }] }] })
  const pending = await h.coordinator.schedule('g')
  const removed = pending.find((request) => request.topicId === original.topicId)
  assert.deepEqual(removed.messages, [])
  assert.deepEqual(removed.removedMessageIds, ['a'])
  const action = { kind: 'new-task', title: '错误派生', objective: '错误派生', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: removed.topicId, revision: removed.revision }] }
  await assertDecisionIssue(h.call('group_decision_submit', submission(removed, { actions: [action], reply: '执行' })), /topic_effect_owner_required/)
  await complete(h, removed)
  assert.equal(h.store.getTopic('g', original.topicId).processedRevision, 2)
  assert.equal(h.store.listTasks().length, 0)
})

test('已有任务中的他人分工静默保留，后续助手补充不受同步提及阻挡', async t => {
  for (const state of ['running', 'completed']) await t.test(state, async t => {
    const h = await setup(t), { task, request: original } = await taskFixture(h, { text: '@助理 请核验列表状态展示' })
    await h.store.updateTask(task.taskId, value => ({ ...value, state }))
    const before = structuredClone(h.store.getTask(task.taskId))
    await ingest(h, 'other', { text: '@成员甲 暂停你的验证，等成员乙提供材料。' })
    const other = (await route(h, { other: original.topicId })).pendingDecisions[0]
    await complete(h, other, { topicUpdate: { summary: '成员甲等待材料；助手原任务保持不变。' } })
    assert.deepEqual(h.store.getTask(task.taskId), before)
    assert.equal(h.applications.length, 0)
    assert.equal(h.store.getGroup('g').outbox.length, 0)
    await ingest(h, 'supplement', { text: '@成员甲 @成员乙 同步一下：助手的列表核验还需覆盖空状态。', quotedMessage: { messageId: 'a1', content: '@助理 请核验列表状态展示' } })
    const current = (await route(h, { supplement: original.topicId })).pendingDecisions[0]
    assert.equal(h.envelope('[GROUP_TOPIC_DECISION]').linkedTasks.snapshots[0].taskId, task.taskId)
    const action = { kind: state === 'completed' ? 'task-reopen' : 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence,
      context: '沿原列表核验补充空状态用例', ...(state === 'running' ? { progressImpact: 'preserve' } : {}), topicRefs: [{ topicId: current.topicId, revision: current.revision }] }
    assert.equal((await h.call('group_decision_submit', submission(current, { actions: [action], reply: '补充原核验的空状态用例。', topicUpdate: { summary: '助手续办原列表核验，同事仅接收同步。' } }))).status, 'accepted')
    await h.coordinator.drain('g')
    assert.equal(h.store.listTasks().length, 1)
    assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion + 1)
    assert.equal(h.applications.length, 1)
  })
})

test('显式归属复核冻结已处理消息，修订后原 Task 仍可读取旧 Topic 版本', async (t) => {
  const h = await setup(t), { task, request: original } = await taskFixture(h)
  assert.equal((await h.call('group_topic_route_review', { messageIds: ['a1'], reason: '' })).status, 'invalid-arguments')
  await assert.rejects(h.call('group_topic_route_review', { messageIds: ['foreign'], reason: '修正误归类' }), /message_not_found/)
  await assert.rejects(h.call('group_topic_route_review', { messageIds: ['a1', 'a1'], reason: '修正误归类' }), /topic_route_review_duplicate/)
  const review = await h.call('group_topic_route_review', { messageIds: ['a1'], reason: '该消息实际属于 B' })
  assert.equal(review.messages[0].messageVersion, 1)
  const routed = await h.call('group_topic_route_submit', { requestId: review.requestId, routes: [{ messageId: 'a1', messageVersion: 1, topics: [{ newTopicKey: 'b', title: 'B' }] }] })
  assert.equal(routed.status, 'accepted')
  const old = routed.pendingDecisions.find((item) => item.topicId === original.topicId)
  assert.deepEqual(old.messages, [])
  assert.deepEqual(old.removedMessageIds, ['a1'])
  await complete(h, old)
  assert.equal(h.store.getTopic('g', original.topicId).entries.at(-1).reason, '该消息实际属于 B')
  const context = await h.call('group_topic_context_get', { ...task.topicRefs[0] })
  assert.equal(context.messages[0].messageId, 'a1')
  assert.equal('entries' in context.topic, false)
  assert.equal('decisions' in context.topic, false)
})

test('精确消息重试清除失败等待且不重放已完成动作', async (t) => {
  let fail = true
  const h = await setup(t, { afterAction() { if (fail) throw new Error('retry_manually') } })
  await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  await h.call('group_decision_submit', submission(request, { actions: [action], reply: '收到' })); await h.coordinator.drain('g')
  fail = false
  await h.store.updateTopicDecision({ groupId: 'g', topicId: request.topicId, decisionId: request.requestId, patch: { nextRetryAt: new Date(0).toISOString() } })
  await h.coordinator.retryMessage('g', 'a'); await h.coordinator.drain('g')
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'completed')
  assert.equal(h.store.listTasks().length, 1)
  const attempts = h.applications.length
  await h.coordinator.retryMessage('g', 'a'); await h.coordinator.drain('g')
  assert.equal(h.applications.length, attempts)
  await assert.rejects(h.coordinator.retryMessage('g', 'foreign'), /message_not_found/)
})


test('嵌套暂停需全部释放且 release 幂等，关闭后拒绝所有工具新意图', async (t) => {
  let closing = false
  const h = await setup(t, { isClosing: () => closing })
  const first = h.coordinator.pause('g'), second = h.coordinator.pause('g')
  await ingest(h, 'paused')
  first(); first()
  await h.coordinator.schedule('g')
  assert.equal(h.envelope('[GROUP_TOPIC_ROUTE]'), undefined)
  second()
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.ok(request)
  closing = true
  await assert.rejects(h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'paused', messageVersion: 1, topics: [{ newTopicKey: 'a', title: 'A' }] }] }), /resident_runtime_closed/)
  await assert.rejects(h.call('group_topic_route_review', { messageIds: ['paused'], reason: '重新核验' }), /resident_runtime_closed/)
  assert.equal(h.store.listTopics('g').length, 0)
})

test('归类快照只携带当前事实，失败决策按需查询可见精简进度', async (t) => {
  const h = await setup(t, { beforeAppend: async () => { throw new Error('delivery-store-failure') } })
  await ingest(h, 'versioned', { text: '初始', imageRefs: [{ id: 'image-current' }], quotedMessage: { messageId: 'quote', content: '引用原文' } })
  await ingest(h, 'versioned', { text: '初始', senderName: '甲' })
  const request = (await route(h)).pendingDecisions[0]
  const message = h.envelope('[GROUP_TOPIC_ROUTE]').messages[0]
  assert.equal(Object.hasOwn(message, 'facts'), false)
  assert.deepEqual(message.imageRefs, [{ id: 'image-current' }])
  assert.equal(message.quotedMessage.content, '引用原文')
  assert.equal((await h.call('group_decision_submit', submission(request, { reply: '答复' }))).status, 'accepted')
  await h.coordinator.drain('g')
  const context = await h.call('group_topic_context_get', { topicId: request.topicId, revision: request.revision })
  assert.equal(context.topic.processing.status, 'blocked')
  assert.equal(context.topic.processing.error, 'delivery-store-failure')
  assert.equal(context.topic.processing.appliedOperations, 0)
  assert.equal(context.topic.processing.totalOperations, 0)
  assert.equal(Object.hasOwn(context.topic, 'decisions'), false)
})

test('动作仍要求确认草稿，Outbox 拒绝保留已应用动作且恢复不重复执行', async (t) => {
  const h = await setup(t), request = await (async () => { await ingest(h, 'a'); return (await route(h)).pendingDecisions[0] })()
  const actions = [{ kind: 'new-task', title: 'A', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: request.revision }] }]
  assert.equal((await h.call('group_decision_submit', submission(request, { actions }))).status, 'reply-required')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
  h.store.appendOutbox = async () => ({ status: 'reply-busy' })
  assert.equal((await h.call('group_decision_submit', submission(request, { actions, reply: '确认核验' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(h.applications.length, 1)
  const record = h.store.getTopic('g', request.topicId).decisions[0]
  assert.equal(record.error, 'topic_outbox_reply-busy')
  assert.equal(record.failureOperationId, record.outboundId)
  assert.equal(record.operations[0].status, 'applied')
  const reopened = await setup(t, { snapshot: h.snapshot })
  await reopened.coordinator.retryOperation({ groupId: 'g', topicId: request.topicId, decisionId: record.decisionId,
    operationId: record.outboundId, resolution: 'not-applied', reason: '回复入口拒绝，原任务动作已经独立回读' })
  assert.equal(reopened.store.listTasks().length, 1)
  assert.equal(reopened.store.getGroup('g').outbox.length, 1)
  assert.equal(reopened.applications.length, 0)
})

test('模型停稳后仅有限次提醒，同一归类请求仍可提交', async (t) => {
  let idleCalls = 0, reminded
  const reminder = new Promise((resolve) => { reminded = resolve })
  const h = await setup(t, { retryDelayMs: 5, whenIdle: () => ++idleCalls === 1 ? Promise.resolve() : new Promise(() => {}), onSteer: () => { if (idleCalls) reminded() } })
  await ingest(h, 'unsubmitted'); await h.coordinator.schedule('g')
  const original = h.envelope('[GROUP_TOPIC_ROUTE]')
  let watchdog
  try { await Promise.race([reminder, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('route_retry_timeout')), 1000) })]) }
  finally { clearTimeout(watchdog) }
  const current = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.equal(current.requestId, original.requestId)
  assert.equal(h.sent.length, 2)
  const routes = [{ messageId: 'unsubmitted', messageVersion: 1, topics: [{ newTopicKey: 'retry', title: '重试话题' }] }]
  assert.equal((await h.call('group_topic_route_submit', { requestId: original.requestId, routes })).status, 'accepted')
  assert.equal(h.store.listTopics('g').length, 1)
  assert.equal(h.store.getCoordinationRequest('g', original.requestId).status, 'completed')
})

function visibleTool(session, name, result) {
  const id = `call-${session.snapshotEvents().length}`
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: `assistant-${id}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id, name, arguments: '{}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: { ...createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] }), id: `result-${id}` } }, { surfaceOp: 'append' })
}

test('材料清单从当前surface分页形成，跨请求与压缩摘要不冒充正文', async t => {
  const session = Session.create('manifest-session'), h = await setup(t, { session }), { task } = await taskFixture(h)
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '材料'.repeat(3000) }).catch(() => {})
  const requestId = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求').requestId
  const manifest = () => h.call('group_task_review_context_get', { requestId, section: 'manifest' })
  assert.equal((await manifest()).entries.find(item => item.id === 'value').complete, false)
  let offset = 0
  do {
    const page = await h.call('group_task_review_context_get', { requestId, section: 'value', offset })
    visibleTool(session, 'group_task_review_context_get', { ...page, requestId: 'other-request' })
    assert.equal((await manifest()).entries.find(item => item.id === 'value').complete, false)
    visibleTool(session, 'group_task_review_context_get', page)
    offset = page.nextOffset
    if (!page.hasMore) break
  } while (true)
  assert.equal((await manifest()).entries.find(item => item.id === 'value').complete, true)
  compactSurface(session)
  assert.equal((await manifest()).entries.find(item => item.id === 'value').complete, false)
  await h.coordinator.close(); await pending
})

test('审阅先落Task执行事件，重启同报告换提交时间仍恢复原response且不再次注入', async t => {
  const h = await setup(t), { task } = await taskFixture(h)
  const value = { kind: 'plan-confirmed', summary: '计划', submittedAt: '2026-09-10T01:00:00Z' }
  const pending = h.coordinator.requestReview('checkpoint', task, value)
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  const review = { decision: 'acknowledge', reason: '已经核准' }
  await h.call('group_task_review_submit', { requestId: request.requestId, review })
  assert.deepEqual(await pending, review)
  const saved = h.store.getTask(task.taskId).executionEvents.find(event => event.kind === 'coordination-review-accepted')
  assert.equal(saved.requestId, request.requestId)
  assert.deepEqual(saved.review, review)
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: JSON.parse(JSON.stringify(h.snapshot)) })
  const restored = await reopened.coordinator.requestReview('checkpoint', reopened.store.getTask(task.taskId), { ...value, submittedAt: '2026-09-10T02:00:00Z' })
  assert.deepEqual(restored, review)
  assert.equal(reopened.sent.length, 0)
  await reopened.coordinator.close(); await reopened.store.close()
  const twice = await setup(t, { snapshot: JSON.parse(JSON.stringify(reopened.snapshot)) })
  assert.deepEqual(await twice.coordinator.requestReview('checkpoint', twice.store.getTask(task.taskId), { ...value, submittedAt: '2026-09-10T03:00:00Z' }), review)
  assert.equal(twice.sent.length, 0)
})

test('审阅持久化失败不得resolve，重提相同判断后只保存一份', async t => {
  const h = await setup(t), { task } = await taskFixture(h)
  let resolved = false
  const pending = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '计划' }).then(value => { resolved = true; return value })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  const update = h.store.updateTask
  h.store.updateTask = async () => { throw new Error('injected-storage-failure') }
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '核准' } }), /injected-storage-failure/)
  assert.equal(resolved, false)
  h.store.updateTask = update
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '核准' } })
  await pending
  assert.equal(h.store.getTask(task.taskId).executionEvents.filter(event => event.kind === 'coordination-review-accepted').length, 1)
})

test('耗尽审阅不自动reset，显式reset只清账与旧Promise不创建新审阅', async t => {
  const h = await setup(t), { task } = await taskFixture(h)
  const value = { kind: 'plan-confirmed', summary: '计划' }
  h.coordinator.requestReview('checkpoint', task, value).catch(() => {})
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  await h.store.updateCoordinationRequest('g', request.requestId, { status: 'exhausted', attempt: 3 })
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await assert.rejects(reopened.coordinator.requestReview('checkpoint', reopened.store.getTask(task.taskId), value), /retry_exhausted/)
  assert.equal(reopened.sent.length, 0)
  assert.equal((await reopened.coordinator.resetReviewRequest('g', request.requestId)).status, 'reset')
  assert.equal(reopened.sent.length, 0)
  assert.equal(reopened.store.getCoordinationRequest('g', request.requestId).resumeEpoch, 1)
  const pending = reopened.coordinator.requestReview('checkpoint', reopened.store.getTask(task.taskId), value)
  const next = reopened.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.equal(next.requestId, request.requestId)
  await reopened.call('group_task_review_submit', { requestId: next.requestId, review: { decision: 'acknowledge', reason: '恢复后核准' } })
  assert.equal((await pending).decision, 'acknowledge')
})

test('完成审阅重启恢复时重建preparedNotification，保持原审批且不新增模型请求', async t => {
  const h = await setup(t), fixture = await taskFixture(h)
  const task = await h.store.updateTask(fixture.task.taskId, current => ({ ...current, state: 'running' }))
  const value = { inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'completed', summary: '完成', evidence: ['通过'], artifacts: [] }
  const pending = h.coordinator.requestReview('completion', task, value)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted: true, reason: '核准', notification: { reply: '已经完成', replyToMessageId: 'a1', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } } })
  await pending
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: JSON.parse(JSON.stringify(h.snapshot)) })
  const restored = await reopened.coordinator.requestReview('completion', reopened.store.getTask(task.taskId), value)
  assert.ok(restored.preparedNotification)
  assert.equal(reopened.sent.length, 0)
  const completed = await reopened.store.updateTask(task.taskId, current => ({ ...current, state: 'completed', result: value }))
  await reopened.coordinator.commitCompletionNotification(restored.preparedNotification, completed, value)
  assert.equal(reopened.store.getGroup('g').outbox.filter(item => item.outboundId === `reply-${request.requestId}`).length, 1)
})

test('审阅身份忽略提交时间，但流程引用、最后检查点和Topic修订变化会换身份', async t => {
  const h = await setup(t), { task } = await taskFixture(h)
  const value = { kind: 'plan-confirmed', summary: '计划', submittedAt: '2026-09-10T01:00:00Z' }
  const first = h.coordinator.requestReview('checkpoint', task, value)
  first.catch(() => {})
  const firstId = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求').requestId
  const sentCount = h.sent.length
  assert.equal(h.coordinator.requestReview('checkpoint', task, { ...value, submittedAt: '2026-09-10T02:00:00Z' }), first)
  assert.equal(h.sent.length, sentCount)
  h.coordinator.requestReview('checkpoint', { ...task, taskPromptRefs: [{ id: 'flow', revision: 2 }] }, value).catch(() => {})
  assert.notEqual(h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求').requestId, firstId)
  h.coordinator.requestReview('checkpoint', { ...task, checkpoints: [{ checkpointId: 'new-checkpoint' }] }, value).catch(() => {})
  assert.notEqual(h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求').requestId, firstId)
  await ingest(h, 'revision-change')
  await h.store.routeMessages({ groupId: 'g', routeId: 'route-new-revision', routingRevision: h.store.getGroup('g').routingRevision, routes: [{ messageId: 'revision-change', messageVersion: 1, topics: [{ topicId: task.topicRefs[0].topicId }] }] })
  h.coordinator.requestReview('checkpoint', task, value).catch(() => {})
  assert.notEqual(h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求').requestId, firstId)
})
function compactSurface(session) {
  const nodes = [...session.surface.nodes]
  session.append('user/message', { id: `summary-${session.snapshotEvents().length}`, role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: '之前曾经读取流程和原文；此摘要不保留完整正文。' }] }, { surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) }, sourceEventSeqs: nodes })
}

test('原生 surface 流程正文与连续页跨请求复用，压缩后历史日志不能冒充可见', () => {
  const session = Session.create('session-visible-context'), agent = { session }
  const prompt = { id: 'release', revision: 1, name: '发布', description: '发布校验', prompt: '核对批准原文' }
  visibleTool(session, 'pwsh', { prompts: [prompt] })
  assert.deepEqual(visiblePromptRefs(agent, [prompt]), [])
  visibleTool(session, 'group_task_prompt_get', { prompts: [prompt] })
  assert.deepEqual(visiblePromptRefs(agent, [prompt]), [{ id: 'release', revision: 1 }])
  assert.deepEqual(visiblePromptRefs(agent, [{ ...prompt, revision: 2 }]), [])
  const text = '当前完整证据原文'
  visibleTool(session, 'group_task_review_context_get', { requestId: 'old', section: 'messages', offset: 4, nextOffset: text.length, text: text.slice(4) })
  assert.equal(visibleSectionLength(agent, text), 0)
  visibleTool(session, 'group_task_review_context_get', { requestId: 'old', section: 'messages', offset: 0, nextOffset: 4, text: text.slice(0, 4) })
  assert.equal(visibleSectionLength(agent, text), text.length)
  const reopened = Session.fromRestore(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), JSON.parse(JSON.stringify(session.header)), 0, 'detached')
  assert.equal(visiblePromptRefs({ session: reopened }, [prompt]).length, 1)
  compactSurface(reopened)
  assert.ok(reopened.snapshotEvents().some((event) => event.type === 'tool/result'))
  assert.deepEqual(visiblePromptRefs({ session: reopened }, [prompt]), [])
  assert.equal(visibleSectionLength({ session: reopened }, text), 0)
})

test('审阅复用当前流程正文，压缩或禁用后重新门禁而不是沿用已读标记', async (t) => {
  const session = Session.create('session-review-visible'), h = await setup(t, { session }), fixture = await taskFixture(h)
  await h.store.setTaskPrompts([reviewPrompt('delivery')], 0)
  const task = await h.store.updateTask(fixture.task.taskId, (current) => ({ ...current, taskPromptRefs: [{ id: 'delivery', revision: 1 }] }))
  visibleTool(session, 'group_task_prompt_get', { prompts: h.store.getTaskPrompts() })
  const first = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '第一计划' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.deepEqual(request.visiblePromptRefs, [{ id: 'delivery', revision: 1 }])
  const receipt = await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['delivery'] })
  assert.equal(receipt.prompts[0].reused, true)
  assert.equal(receipt.prompts[0].prompt, undefined)
  compactSurface(session)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } })).status, 'prompt-review-required')
  const restored = await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['delivery'] })
  assert.equal(restored.prompts[0].prompt, '按流程核验')
  visibleTool(session, 'group_task_prompt_get', restored)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '通过' } })).status, 'accepted')
  await first
  const second = h.coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: '第二计划' }).catch((error) => error)
  const secondRequest = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  assert.notEqual(secondRequest.requestId, request.requestId)
  assert.equal(secondRequest.visiblePromptRefs.length, 1)
  await h.store.setTaskPrompts([{ ...reviewPrompt('delivery'), enabled: false }], 1)
  assert.equal((await h.call('group_task_review_submit', { requestId: secondRequest.requestId, review: { decision: 'acknowledge', reason: '通过' } })).status, 'task-stale')
  assert.match((await second).message, /task_prompt_selection_stale/)
})

test('稳定请求跨重启识别已消费消息，原文可见时恢复只发送短提醒', async (t) => {
  const session = Session.create('session-request-restart')
  const h = await setup(t, { session, onSteer: (message) => session.append('user/message', message, { surfaceOp: 'append' }) })
  await ingest(h, 'restart'); await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.coordinator.close(); await h.store.close()
  const restored = Session.fromRestore(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), JSON.parse(JSON.stringify(session.header)), 0, 'detached')
  let resume, idleCalls = 0
  const reminder = new Promise((resolve) => { resume = resolve })
  const reopened = await setup(t, { snapshot: h.snapshot, session: restored, retryDelayMs: 5, whenIdle: () => ++idleCalls === 1 ? Promise.resolve() : new Promise(() => {}), onSteer: resume })
  await reopened.coordinator.recover()
  assert.equal(reopened.sent.length, 0)
  let watchdog
  try {
    const message = await Promise.race([reminder, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('resume_timeout')), 1000) })])
    assert.ok(message.content[0].text.startsWith('[COORDINATION_RESUME]'))
    assert.ok(message.content[0].text.includes(request.requestId))
    assert.ok(message.content[0].text.length < 300)
  } finally { clearTimeout(watchdog) }
})

test('协议提醒到上限后持久停住，新增输入仍能形成新请求', async (t) => {
  let exhausted
  const stopped = new Promise((resolve) => { exhausted = resolve })
  const h = await setup(t, { retryDelayMs: 2, maxRequestAttempts: 2, whenIdle: () => Promise.resolve(), onError: exhausted })
  await ingest(h, 'stalled'); await h.coordinator.schedule('g')
  const original = h.envelope('[GROUP_TOPIC_ROUTE]')
  let watchdog
  try { await Promise.race([stopped, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('exhaustion_timeout')), 1000) })]) }
  finally { clearTimeout(watchdog) }
  assert.equal(h.sent.length, 3)
  assert.equal(h.store.getCoordinationRequest('g', original.requestId).status, 'exhausted')
  await h.coordinator.schedule('g')
  assert.equal(h.sent.length, 3)
  await ingest(h, 'new-input'); await h.coordinator.schedule('g')
  const next = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.notEqual(next.requestId, original.requestId)
  assert.equal(next.messages.length, 2)
})

test('只读快路径共享决策门禁，成功时不向常驻再注入请求', async (t) => {
  let h, finish
  const completed = new Promise((resolve) => { finish = resolve })
  h = await setup(t, { onDecisionRequest: async ({ groupId, requestId }) => {
    const context = h.coordinator.getReadOnlyDecisionContext(groupId, requestId)
    assert.deepEqual(context.deltaMessageIds, ['progress'])
    assert.equal(context.policyContext.responsibility, '处理测试任务')
    const result = await h.coordinator.submitReadOnlyDecision(groupId, submission(context, { reply: '当前暂无执行结果。' }), context.candidateFingerprint, () => true)
    finish(result)
    return result.status === 'accepted'
  } })
  await ingest(h, 'progress'); await route(h)
  assert.equal((await completed).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.sent.filter((text) => text.startsWith('[GROUP_TOPIC_DECISION]')).length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('只读快路径拒绝动作和候选变化，Task事实在真实提交临界点变更时零Outbox', async (t) => {
  const h = await setup(t)
  await ingest(h, 'atomic-status')
  const request = (await route(h)).pendingDecisions[0]
  const context = h.coordinator.getReadOnlyDecisionContext('g', request.requestId)
  const args = submission(context, { reply: '已完成' })
  await assert.rejects(h.coordinator.submitReadOnlyDecision('g', args, context.candidateFingerprint), /snapshot_validator_required/)
  const action = { kind: 'new-task', title: '误操作', objective: '执行', acceptanceCriteria: ['完成'], topicRefs: [{ topicId: request.topicId, revision: request.revision }] }
  await assert.rejects(h.coordinator.submitReadOnlyDecision('g', submission(context, { reply: '执行', actions: [action] }), context.candidateFingerprint, () => true), /read_only_decision_action_forbidden/)
  assert.equal((await h.coordinator.submitReadOnlyDecision('g', args, 'old-candidate', () => true)).status, 'review-required')
  let valid = true, validations = 0
  const accept = h.store.acceptTopicDecision
  h.store.acceptTopicDecision = (input) => { valid = false; return accept(input) }
  const result = await h.coordinator.submitReadOnlyDecision('g', args, context.candidateFingerprint, () => { validations++; return valid })
  assert.equal(result.status, 'task-stale')
  assert.equal(validations, 2)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  assert.equal(h.store.listTasks().length, 0)
})

test('原生 Inbox 仍停放原请求时，恢复提醒不会再排入第二份正文', async (t) => {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx)
  const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
  const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.agentLoop
  const { session, inbox } = await loop.create('session-pending-body')
  t.after(() => ctx.fiber.dispose())
  let finish, idleCalls = 0
  const reminder = new Promise((resolve) => { finish = resolve })
  const h = await setup(t, { session, inbox, retryDelayMs: 2, whenIdle: () => ++idleCalls === 1 ? Promise.resolve() : new Promise(() => {}), onSteer(message) { inbox.append('next-step', message); if (message.content[0].text.startsWith('[COORDINATION_RESUME]')) finish() } })
  await ingest(h, 'parked'); await h.coordinator.schedule('g')
  let watchdog
  try { await Promise.race([reminder, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('pending_reminder_timeout')), 1000) })]) }
  finally { clearTimeout(watchdog) }
  assert.equal(inbox.nextStep.length, 2)
  assert.equal(inbox.nextStep.filter((message) => message.content[0].text.startsWith('[GROUP_TOPIC_ROUTE]')).length, 1)
})

test('显式恢复递增持久epoch，不会被此前已消费提醒身份吞掉', async (t) => {
  const session = Session.create('session-explicit-retry'), messages = []
  let exhausted
  const stopped = new Promise((resolve) => { exhausted = resolve })
  const h = await setup(t, { session, retryDelayMs: 2, maxRequestAttempts: 1, whenIdle: () => Promise.resolve(), onError: exhausted, onSteer(message) { messages.push(message); session.append('user/message', message, { surfaceOp: 'append' }) } })
  await ingest(h, 'retry-explicit'); await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  let watchdog
  try { await Promise.race([stopped, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('exhaustion_timeout')), 1000) })]) }
  finally { clearTimeout(watchdog) }
  assert.equal(messages.length, 2)
  await h.coordinator.retryRequest('g', request.requestId)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(messages.length, 3)
  assert.equal(new Set(messages.map((message) => message.id)).size, 3)
  assert.equal(h.store.getCoordinationRequest('g', request.requestId).resumeEpoch, 1)
})


test('同请求材料只保留一份正文，跨请求或内容变化不复用', () => {
  const text = '需要完整保留的授权及业务要求'.repeat(20)
  const request = { requestId: 'r1' }
  assert.equal(compactSectionValue(request, 'objective', text), text)
  const value = compactSectionValue(request, 'value', { objective: text, reason: '当前报告' })
  assert.deepEqual(value.objective.materialRef.path, [])
  assert.equal(value.objective.materialRef.section, 'objective')
  assert.equal(value.objective.materialRef.requestId, 'r1')
  assert.equal(compactSectionValue({ requestId: 'r2' }, 'value', text), text)
  assert.equal(compactSectionValue(request, 'updated', text + '撤销授权'), text + '撤销授权')
})

test('结构校验一次返回全部引用歧义及字段位置，整批零副作用', async (t) => {
  const h = await setup(t)
  await ingest(h, 'multiple-errors', { text: '甲 甲 乙 乙' })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const before = structuredClone(h.store.getGroup('g'))
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'multiple-errors', messageVersion: 1, units: [{
    unitKey: 'a', summary: '两处重复引用', sourceRefs: [{ quote: '甲' }], contextRefs: [{ quote: '乙', purpose: '共享要求' }], topics: [{ newTopicKey: 'a', title: '不能写入' }],
  }] }] })
  assert.equal(result.status, 'invalid-arguments')
  assert.ok(result.issues.some(issue => issue.field === 'routes.0.units.0.sourceRefs.0' && issue.candidates.length === 2))
  assert.ok(result.issues.some(issue => issue.field === 'routes.0.units.0.contextRefs.0' && issue.candidates.length === 2))
  assert.deepEqual(h.store.getGroup('g'), before)
  assert.equal(h.applications.length, 0)
})

async function quotedReminderRouting(t, quotedReminderContext) {
  const h = await setup(t, { quotedReminderContext, fixedTopicsEnabled: true })
  await ingest(h, 'reminder-catalog-seed')
  const topics = Array.from({ length: 34 }, (_, index) => ({ newTopicKey: `history-${index}`, title: `历史事项${index}`, relationship: 'affected', reason: '历史关系' }))
  await h.store.routeMessages({ groupId: 'g', routeId: 'reminder-seed', routingRevision: 0,
    routes: [{ messageId: 'reminder-catalog-seed', messageVersion: 1, topics, effectOwner: { newTopicKey: 'history-0' } }] })
  return h
}
const quotedReminder = { quotedMessageId: 'delivered-reminder', coordinationId: 'coordination-reminder',
  schedule: { id: 'schedule-reminder', action: { kind: 'message-reminder', text: '提醒小李查看进度' }, target: { recipientIds: ['recipient-b'] } } }

test('精确引用提醒首屏省略34个无关话题，A设置B不改变收件人且完整目录仍可读取', async t => {
  const calls = [], before = structuredClone(quotedReminder)
  const h = await quotedReminderRouting(t, async args => { calls.push(args); return quotedReminder })
  await ingest(h, 'quoted-change', { text: '提前三分钟', quotedMessage: { messageId: 'delivered-reminder', content: '已安排17:57提醒小李查看进度。' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(calls, [{ groupId: 'g', messageId: 'quoted-change', messageVersion: 1, actorId: 'od-a' }])
  assert.deepEqual(request.topics, []); assert.equal(request.totalTopics, 34); assert.equal(request.hasMoreTopics, true); assert.equal(request.nextTopicOffset, 0)
  assert.equal(request.messages[0].quotedReminder.coordinationId, quotedReminder.coordinationId)
  assert.match(request.quotedReminderGuide, /新增或混合事项仍逐项判断/)
  assert.equal((await h.call('group_topic_list', { offset: request.nextTopicOffset, limit: 100 })).topics.length, 34)
  assert.deepEqual(quotedReminder, before, '路由只消费引用关联，不修改A设置的B收件人')
  assert.deepEqual(h.applications, []); assert.deepEqual(h.store.getGroup('g').outbox, [])
})

test('引用提醒内的新业务仍可按需查目录并拆成独立事项，不被强制归入原提醒', async t => {
  const h = await quotedReminderRouting(t, async () => quotedReminder)
  await ingest(h, 'quoted-mixed', { text: '提前三分钟。另外查一下登录失败。', quotedMessage: { messageId: 'delivered-reminder', content: '已安排17:57提醒。' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(request.topics, [])
  assert.equal((await h.call('group_topic_list', { query: '登录失败' })).topics.length, 0)
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'quoted-mixed', messageVersion: 1, ignoredRefs: [], units: [
    { unitKey: 'reminder-change', summary: '提醒提前三分钟', sourceRefs: [{ quote: '提前三分钟。' }], fixedTopic: 'agent-platform', topics: [], reason: '平台提醒变更请求独立处理' },
    { unitKey: 'login-investigation', summary: '登录失败排查', sourceRefs: [{ quote: '另外查一下登录失败。' }], topics: [{ newTopicKey: 'login', title: '登录失败排查' }] },
  ] }] })
  assert.equal(result.status, 'accepted', JSON.stringify(result))
  const units = h.store.getGroup('g').messages.find(item => item.messageId === 'quoted-mixed').units
  assert.equal(units.filter(item => item.fixedTopic === 'agent-platform').length, 1)
  assert.equal(units.filter(item => item.dispatchOwner === 'coordination').length, 0)
  assert.equal(h.store.getGroup('g').topics.length, 35)
})

test('精确关联未通过时保留普通话题目录，路由不自行猜测关联', async t => {
  const h = await quotedReminderRouting(t, async () => null)
  await ingest(h, 'unverified-quote', { text: '提前三分钟', quotedMessage: { messageId: 'unverified-reminder', content: '未经证实的引用' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.ok(request.topics.length > 0); assert.equal(request.totalTopics, 34)
  assert.equal(request.messages[0].quotedReminder, undefined); assert.equal(request.quotedReminderGuide, undefined)
})

test('普通新事项不调用提醒关联，混合批次保留原目录', async t => {
  let calls = 0
  const h = await quotedReminderRouting(t, async () => { calls++; return quotedReminder })
  await ingest(h, 'ordinary-new', { text: '请检查新的登录问题' })
  await ingest(h, 'quoted-in-batch', { text: '提前三分钟', quotedMessage: { messageId: 'delivered-reminder', content: '17:57提醒' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.equal(calls, 1); assert.ok(request.topics.length > 0)
  assert.equal(request.messages.find(item => item.messageId === 'ordinary-new').quotedReminder, undefined)
})

test('精确引用查询异常显式报告并释放未派发路由请求，恢复后沿原路径重试', async t => {
  let broken = true
  const h = await quotedReminderRouting(t, async () => { if (broken) throw new Error('quote-query-failed'); return quotedReminder })
  await ingest(h, 'quoted-error', { quotedMessage: { messageId: 'delivered-reminder', content: '17:57提醒' } })
  await h.coordinator.schedule('g')
  assert.equal(h.envelope('[GROUP_TOPIC_ROUTE]'), undefined); assert.match(h.errors[0].message, /quote-query-failed/)
  broken = false; await h.coordinator.schedule('g')
  assert.deepEqual(h.envelope('[GROUP_TOPIC_ROUTE]').topics, [])
})

test('引用关联等待期间版本变化只重建原批次，新增消息不丢失也不混入旧请求', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), versions = []
  t.after(() => release.resolve())
  const h = await quotedReminderRouting(t, async args => {
    versions.push(args.messageVersion)
    if (versions.length === 1) { entered.resolve(); await release.promise }
    return quotedReminder
  })
  const original = { text: '提前三分钟', quotedMessage: { messageId: 'delivered-reminder', content: '17:57提醒' } }
  await ingest(h, 'quoted-enrichment', original)
  const scheduled = h.coordinator.schedule('g')
  await entered.promise
  await ingest(h, 'quoted-enrichment', { ...original, senderName: '真实发送人' })
  await ingest(h, 'later-independent', { text: '另外核查登录失败' })
  const concurrent = h.coordinator.schedule('g')
  release.resolve(); await Promise.all([scheduled, concurrent])
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(versions, [1, 2])
  assert.equal(h.sent.filter(item => item.startsWith('[GROUP_TOPIC_ROUTE]')).length, 1, '旧版本不能占用一次模型往返')
  assert.deepEqual(request.messages.map(item => [item.messageId, item.messageVersion]), [['quoted-enrichment', 2]])
  const accepted = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'quoted-enrichment', messageVersion: 2,
    ignoredRefs: [], units: [{ unitKey: 'change', summary: '提醒提前三分钟', sourceRefs: [{ quote: original.text }],
      fixedTopic: 'agent-platform', topics: [], reason: '平台提醒变更请求' }] }] })
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(h.envelope('[GROUP_TOPIC_ROUTE]').messages.map(item => item.messageId), ['later-independent'])
  assert.equal(h.errors.length, 0)
})

test('引用关联等待期间关闭不会派发尚未准备的路由', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = await quotedReminderRouting(t, async () => { entered.resolve(); await release.promise; return quotedReminder })
  await ingest(h, 'quoted-close', { quotedMessage: { messageId: 'delivered-reminder', content: '17:57提醒' } })
  const scheduled = h.coordinator.schedule('g')
  await entered.promise; await h.coordinator.close(); release.resolve(); await scheduled
  assert.equal(h.envelope('[GROUP_TOPIC_ROUTE]'), undefined)
})

test('紧凑目录连续分页无漏项，引用同消息全部旧事项保留摘要', async (t) => {
  const h = await setup(t)
  await ingest(h, 'catalog-seed')
  const refs = Array.from({ length: 110 }, (_, index) => ({ newTopicKey: 't' + index, title: '历史事项' + index, relationship: 'affected', reason: '历史关系' }))
  await h.store.routeMessages({ groupId: 'g', routeId: 'seed', routingRevision: 0, routes: [{ messageId: 'catalog-seed', messageVersion: 1, topics: refs, effectOwner: { newTopicKey: 't0' } }] })
  await ingest(h, 'catalog-current', { quotedMessage: { messageId: 'catalog-seed', content: '历史引用' } })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.ok(request.topics.every(topic => (topic.summary?.length ?? 0) <= 240 && !Object.hasOwn(topic, 'processedRevision')))
  for (const topic of request.topics) assert.deepEqual(topic.readCall, { name: 'group_topic_context_get', arguments: { topicId: topic.topicId, revision: topic.revision } })
  assert.ok(JSON.stringify(request.relatedTopics).length <= 3000)
  const relatedIds = request.relatedTopics.map(topic => topic.topicId)
  let relatedOffset = request.nextRelatedTopicOffset
  while (relatedOffset < request.totalRelatedTopics) {
    const page = await h.call('group_topic_list', { requestId: request.requestId, offset: relatedOffset, limit: 100 })
    assert.ok(JSON.stringify(page.topics).length <= 3000)
    relatedIds.push(...page.topics.map(topic => topic.topicId))
    assert.ok(page.nextOffset > relatedOffset)
    relatedOffset = page.nextOffset
  }
  assert.equal(new Set(relatedIds).size, 110)
  assert.equal(relatedIds.length, 110)
  await assert.rejects(h.call('group_topic_list', { requestId: 'wrong-request' }), /topic_route_request_unknown/)
  const ids = request.topics.map(topic => topic.topicId)
  let offset = request.nextTopicOffset
  while (offset < request.totalTopics) {
    const page = await h.call('group_topic_list', { offset, limit: 100 })
    ids.push(...page.topics.map(topic => topic.topicId))
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  }
  assert.equal(new Set(ids).size, 110)
  assert.equal(ids.length, 110)
})


test('路由关联摘要包含引用命中Task的其他固定Topic，不只保留被引用单项', async t => {
  const h = await setup(t)
  await ingest(h, 'linked-a'); await ingest(h, 'linked-b')
  const routed = await h.store.routeMessages({ groupId: 'g', routeId: 'linked-seed', routingRevision: 0, routes: ['linked-a', 'linked-b'].map(id => ({ messageId: id, messageVersion: 1, topics: [{ newTopicKey: id, title: id }] })) })
  const refs = Object.values(routed.topicIdsByKey).map(topicId => ({ topicId, revision: h.store.getTopic('g', topicId).revision }))
  await h.store.createTask({ groupId: 'g', topicRefs: refs, title: '关联交付', objective: '关联核验', acceptanceCriteria: ['证据'] })
  await ingest(h, 'linked-current', { quotedMessage: { messageId: 'linked-a', content: '已有材料' } })
  await h.coordinator.schedule('g')
  assert.deepEqual(new Set(h.envelope('[GROUP_TOPIC_ROUTE]').relatedTopics.map(topic => topic.topicId)), new Set(refs.map(ref => ref.topicId)))
})

test('决策一次报告独立动作的版本和归属问题，不写Task或Outbox', async (t) => {
  const h = await setup(t)
  await ingest(h, 'decision-issues')
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'decision-issues', messageVersion: 1, topics: [{ newTopicKey: 'a', title: '当前事项' }] }] })
  const current = routed.pendingDecisions[0]
  const before = structuredClone(h.store.getGroup('g'))
  const actions = ['missing-a', 'missing-b'].map(taskId => ({ kind: 'task-cancel', taskId, inputVersion: 1, runSequence: 1, reason: '校验', topicRefs: [{ topicId: current.topicId, revision: current.revision + 1 }] }))
  const result = await h.call('group_decision_submit', submission(current, { actions, reply: '不能提交' }))
  assert.equal(result.status, 'invalid-arguments')
  for (const index of [0, 1]) {
    assert.ok(result.issues.some(issue => issue.field === 'decision.actions.' + index && issue.code === 'task_topic_version_invalid'))
    assert.ok(result.issues.some(issue => issue.field === 'decision.actions.' + index && issue.code === 'task_not_found'))
    assert.ok(!result.issues.some(issue => issue.field === 'decision.actions.' + index && issue.code === 'task_topic_wrong_group'))
  }
  assert.deepEqual(h.store.getGroup('g'), before)
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.applications.length, 0)
})

test('决策首包提供固定流程索引、合法 section 与批量正文读取，并拒绝跨请求', async (t) => {
  const h = await setup(t)
  await h.store.setTaskPrompts([reviewPrompt('investigate'), { ...reviewPrompt('disabled'), enabled: false }], 0)
  await ingest(h, 'decision-prompts')
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'decision-prompts', messageVersion: 1, topics: [{ newTopicKey: 'a', title: '排查' }] }] })
  const request = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.deepEqual(request.promptIndex.map(({ id }) => id), ['investigate'])
  assert.ok(request.contextSections.includes('promptIndex'))
  assert.deepEqual(h.tools.get('group_decision_context_get').parameters.properties.section.enum, request.contextSections)
  const scoped = new Map()
  h.coordinator.register({ tools: { register(tool) { scoped.set(tool.name, tool) } } }, 'g', request)
  assert.ok(scoped.has('group_task_prompt_get'))
  await assert.rejects(scoped.get('group_task_prompt_get').execute({ requestId: 'another', ids: ['investigate'] }, { groupId: 'g' }), /coordination_tool_wrong_request/)
  const read = await scoped.get('group_task_prompt_get').execute({ requestId: request.requestId, ids: ['investigate'] }, { groupId: 'g' })
  assert.equal(read.prompts[0].revision, request.promptIndex[0].revision)
  assert.equal(read.prompts[0].prompt, '按流程核验')
  await assert.rejects(h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['disabled'] }), /task_review_prompt_not_available/)
  await assert.rejects(h.call('group_decision_context_get', { requestId: request.requestId, section: 'workflows' }), /allowed=.*promptIndex/)
  await h.store.setTaskPrompts([reviewPrompt('investigate', '新版')], 1)
  const stale = await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['investigate'] })
  assert.equal(stale.status, 'decision-stale')
  const current = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.notEqual(current.requestId, request.requestId)
  assert.equal((await h.call('group_task_prompt_get', { requestId: current.requestId, ids: ['investigate'] })).prompts[0].prompt, '新版')
  await assert.rejects(h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['investigate'] }), /task_review_request_unknown/)
})

test('固定请求绑定审阅身份与当前Topic，路由缺Topic明确拒绝且不猜测其他事项', async t => {
  const h = await setup(t)
  await ingest(h, 'bound-read')
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]'), routeTools = new Map()
  h.coordinator.register({ tools: { register(tool) { routeTools.set(tool.name, tool) } } }, 'g', route)
  assert.deepEqual(routeTools.get('group_topic_context_get').parameters.required, ['topicId'])
  const missing = await routeTools.get('group_topic_context_get').execute({}, { groupId: 'g' })
  assert.equal(missing.status, 'invalid-arguments')
  assert.equal(missing.issues[0].code, 'topic_id_required')
  assert.deepEqual(missing.nextCall, { name: 'group_topic_list', arguments: { offset: 0, limit: 50 } })
  assert.deepEqual(missing.choices, [])
  await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'bound-read', messageVersion: 1,
    topics: [{ newTopicKey: 'bound', title: '固定请求读取' }] }] })
  const request = h.envelope('[GROUP_TOPIC_DECISION]'), scoped = new Map()
  h.coordinator.register({ tools: { register(tool) { scoped.set(tool.name, tool) } } }, 'g', request)
  assert.deepEqual(scoped.get('group_reply_review_get').parameters.required, [])
  assert.deepEqual(scoped.get('group_topic_context_get').parameters.required, [])
  const review = await scoped.get('group_reply_review_get').execute({}, { groupId: 'g' })
  assert.deepEqual(review.requestIds, [request.requestId])
  assert.deepEqual(review.candidates, [])
  const context = await scoped.get('group_topic_context_get').execute({}, { groupId: 'g' })
  assert.equal(context.topic.topicId, request.topicId); assert.equal(context.topic.revision, request.revision)
  assert.equal(context.messages[0].messageId, 'bound-read')
  await assert.rejects(scoped.get('group_reply_review_get').execute({ requestIds: ['different-request'] }, { groupId: 'g' }), /coordination_tool_wrong_request/)
  await assert.rejects(scoped.get('group_reply_review_get').execute({}, { groupId: 'other' }), /wrong_session/)
  await assert.rejects(scoped.get('group_topic_context_get').execute({ revision: request.revision + 1 }, { groupId: 'g' }), /decision_context_topic_stale/)
  await assert.rejects(scoped.get('group_topic_context_get').execute({ topicId: 'other-group-topic' }, { groupId: 'g' }), /topic_not_found/)
  await assert.rejects(h.rawCall('group_reply_review_get', {}), /topic_review_request_invalid/)
  await ingest(h, 'changed-topic')
  await h.store.routeMessages({ groupId: 'g', routeId: 'changed-after-fixed-read', routingRevision: h.store.getGroup('g').routingRevision,
    routes: [{ messageId: 'changed-topic', messageVersion: 1, topics: [{ topicId: request.topicId }] }] })
  await assert.rejects(scoped.get('group_topic_context_get').execute({}, { groupId: 'g' }), /decision_context_topic_stale/)
})

test('超长流程索引通过声明的 promptIndex 分页完整读取且保持决策首包预算', async (t) => {
  const h = await setup(t)
  await h.store.setTaskPrompts(Array.from({ length: 24 }, (_, index) => ({ ...reviewPrompt(`flow-${index}`), description: '流程适用范围'.repeat(60) })), 0)
  await ingest(h, 'large-prompt-index')
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'large-prompt-index', messageVersion: 1, topics: [{ newTopicKey: 'a', title: '流程索引' }] }] })
  const request = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.equal(request.promptIndex.section, 'promptIndex')
  let offset = 0, text = ''
  while (true) {
    const page = await h.call('group_decision_context_get', { requestId: request.requestId, section: 'promptIndex', offset })
    text += page.text
    if (!page.hasMore) break
    offset = page.nextOffset
  }
  assert.equal(JSON.parse(text).length, 24)
  assertSupportedJsonSchema(h.tools.get('group_decision_context_get').parameters)
  assert.equal((await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['flow-23'] })).prompts[0].id, 'flow-23')
})

test('读取流程后更新或禁用，new-task 提交拒绝旧版本且不写 Task 或 Outbox', async (t) => {
  for (const change of ['revision', 'disabled']) await t.test(change, async (t) => {
    const h = await setup(t)
    await h.store.setTaskPrompts([reviewPrompt('repair')], 0)
    await ingest(h, 'prompt-stale-task', { text: '@助理 请修复审核草稿保存问题' })
    await h.coordinator.schedule('g')
    const route = h.envelope('[GROUP_TOPIC_ROUTE]')
    await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'prompt-stale-task', messageVersion: 1, topics: [{ newTopicKey: 'a', title: '审核草稿' }] }] })
    const request = h.envelope('[GROUP_TOPIC_DECISION]')
    assert.ok(Array.isArray(request.messages))
    assert.match(h.sent.findLast(text => text.startsWith('[GROUP_TOPIC_DECISION]')), /首包内联的 messages 和其他正文可直接使用，无需重复读取/)
    const read = await h.call('group_task_prompt_get', { requestId: request.requestId, ids: ['repair'] })
    const ref = { unitId: request.messages[0].unitId, unitRevision: request.messages[0].unitRevision }
    const action = { kind: 'new-task', title: '修复审核草稿', objective: '修复审核草稿保存', acceptanceCriteria: ['保存回显正确'], topicRefs: [{ topicId: request.topicId, revision: request.revision }], basisUnitRefs: [ref],
      dispatchAssessment: { businessObject: '审核草稿', agentDeliverable: '保存修复', externalFollowup: [], sourceUnitRefs: [ref], workflowRefs: read.prompts.map(({ id, revision }) => ({ id, revision })), workflowReason: '修复流程适用' } }
    await h.store.setTaskPrompts([{ ...reviewPrompt('repair', change === 'revision' ? '新版本正文' : '按流程核验'), enabled: change !== 'disabled' }], 1)
    await assertDecisionIssue(h.call('group_decision_submit', submission(request, { basisUnitRefs: [ref], actions: [action], reply: '已开始修复。', replyReview: { kind: 'confirmation' } })), /task_dispatch_workflow_refs_invalid/)
    assert.equal(h.store.listTasks().length, 0)
    assert.equal(h.store.getGroup('g').outbox.length, 0)
    assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
  })
})

test('无动作且从未入 Outbox 的 blocked 决策可并发安全重判，保留失败证据与原输入', async t => {
  let fail = true
  const h = await setup(t, { beforeAppend() { if (fail) throw new Error('EPERM rename') } })
  await ingest(h, 'reconsider')
  const request = (await route(h)).pendingDecisions[0]
  await h.call('group_decision_submit', submission(request, { reply: '旧的错误判断' }))
  await h.coordinator.drain('g')
  const before = h.store.getTopic('g', request.topicId)
  const record = before.decisions[0]
  assert.equal(record.status, 'blocked')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  const args = { groupId: 'g', topicId: request.topicId, decisionId: record.decisionId, operationId: record.outboundId, resolution: 'reconsider', reason: '已核验原文件存在，旧回复未落盘，需重新判断' }
  fail = false
  const results = await Promise.all([h.coordinator.retryOperation(args), h.coordinator.retryOperation(args)])
  assert.ok(results.every(item => item.status === 'rejected'))
  const after = h.store.getTopic('g', request.topicId)
  assert.equal(after.processedRevision, before.processedRevision)
  assert.equal(after.decisions[0].error, 'EPERM rename')
  assert.equal(after.decisions[0].decision.reply, '旧的错误判断')
  assert.equal(after.decisions[0].recoveryReason, args.reason)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  const next = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.notEqual(next.requestId, request.requestId)
  assert.equal(next.messages[0].messageId, 'reconsider')
  for (const identity of [{ outboundId: record.outboundId }, { decisionId: record.decisionId }, { sourceMessageId: `topic-decision:${record.decisionId}` }]) {
    assert.equal((await h.store.appendOutbox({ groupId: 'g', sourceMessageId: 'late-stale', text: '旧草稿', ...identity })).status, 'decision-rejected')
  }
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('重判与旧 not-applied 恢复并发时旧恢复 CAS 不得复活已拒绝草稿', async t => {
  const h = await setup(t, { beforeAppend() { throw new Error('EPERM rename') } })
  await ingest(h, 'recovery-race')
  const request = (await route(h)).pendingDecisions[0]
  await h.call('group_decision_submit', submission(request, { reply: '旧草稿' }))
  await h.coordinator.drain('g')
  const record = h.store.getTopic('g', request.topicId).decisions[0]
  const args = { groupId: 'g', topicId: request.topicId, decisionId: record.decisionId, operationId: record.outboundId, reason: '核对零副作用' }
  const results = await Promise.allSettled([
    h.coordinator.retryOperation({ ...args, resolution: 'reconsider' }),
    h.coordinator.retryOperation({ ...args, resolution: 'not-applied' }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /decision_recovery_status_changed|decision_recovery_not_blocked/)
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].status, 'rejected')
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('纯闲聊完整归类收口但不新建话题或触发业务决策', async t => {
  const h = await setup(t)
  const text = '早上好，今天不聊任务，午饭吃什么？'
  await ingest(h, 'small-talk', { text })
  await h.coordinator.schedule('g')
  const prompt = h.sent.findLast(value => value.startsWith('[GROUP_TOPIC_ROUTE]'))
  assert.match(prompt, /日常寒暄、随口聊天/u)
  assert.match(prompt, /纯闲聊提交 units=\[\]/u)
  assert.match(prompt, /不能当作闲聊丢掉/u)
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const empty = await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'small-talk', messageVersion: 1, units: [], ignoredRefs: [] }] })
  assert.equal(empty.status, 'invalid-arguments')
  const partial = await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'small-talk', messageVersion: 1, units: [], ignoredRefs: [{ quote: '早上好', reason: '日常寒暄' }] }] })
  assert.equal(partial.status, 'invalid-arguments')
  assert.ok(partial.issues.some(issue => issue.code === 'topic_route_uncovered_text'))
  assert.equal(h.store.getGroup('g').topics.length, 0)
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'small-talk', messageVersion: 1, units: [], ignoredRefs: [{ quote: text, reason: '日常闲聊，无具体事项' }],
  }] })
  assert.equal(result.status, 'accepted', JSON.stringify(result))
  assert.equal(h.store.getGroup('g').topics.length, 0)
  assert.deepEqual(result.pendingDecisions, [])
  assert.equal(h.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})

test('遗漏范围按 UTF-16 保留 emoji 和多个独立事项的原文', async t => {
  const h = await setup(t)
  const text = '你好😀 第一事项 第二事项'
  await ingest(h, 'uncovered-emoji', { text })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const result = await h.rawCall('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'uncovered-emoji', messageVersion: 1, units: [], ignoredRefs: [{ quote: '你好', reason: '问候' }],
  }] })
  assert.equal(result.status, 'invalid-arguments')
  const issue = result.issues.find(item => item.code === 'topic_route_uncovered_text')
  assert.deepEqual(issue?.uncoveredRanges, [
    { start: 2, end: 4, quote: '😀' },
    { start: 5, end: 9, quote: '第一事项' },
    { start: 10, end: 14, quote: '第二事项' },
  ])
  assert.equal(h.store.getGroup('g').topics.length, 0)
})

test('混合消息只为具体事项建话题，闲聊片段保留在忽略范围', async t => {
  const h = await setup(t)
  const greeting = '早上好！'
  const matter = '请排查登录页保存失败的问题。'
  await ingest(h, 'mixed-matter', { text: greeting + matter })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'mixed-matter', messageVersion: 1,
    ignoredRefs: [{ quote: greeting, reason: '日常寒暄' }],
    units: [{ unitKey: 'login-save', summary: '排查登录页保存失败', replacesUnitIds: [],
      sourceRefs: [{ quote: matter }], topics: [{ newTopicKey: 'login-save', title: '登录页保存失败排查' }] }],
  }] })
  assert.equal(result.status, 'accepted')
  assert.equal(h.store.getGroup('g').topics.length, 1)
  assert.equal(result.pendingDecisions.length, 1)
  const topicId = result.pendingDecisions[0].topicId
  await ingest(h, 'matter-feedback', { text: '谢谢，那个保存问题修好了。' })
  await h.coordinator.schedule('g')
  const followup = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: followup.requestId, routes: [{
    messageId: 'matter-feedback', messageVersion: 1, ignoredRefs: [],
    units: [{ unitKey: 'save-feedback', summary: '保存问题已修复反馈', replacesUnitIds: [],
      sourceRefs: [{ quote: '谢谢，那个保存问题修好了。' }], topics: [{ topicId }] }],
  }] })
  assert.equal(routed.status, 'accepted')
  assert.equal(h.store.getGroup('g').topics.length, 1)
})

test('new messages cannot reopen archived tasks; normal new-task path remains available', async t => {
  const h = await setup(t), { task, request: original } = await taskFixture(h)
  await h.store.updateTask(task.taskId, value => ({ ...value, state: 'completed', archivedAt: '2026-10-15T00:00:00Z' }))
  await ingest(h, 'archive-followup', { text: '@助理 请继续核验这个事项' })
  const current = (await route(h, { 'archive-followup': original.topicId })).pendingDecisions[0]
  const action = { kind: 'task-reopen', taskId: task.taskId, inputVersion: 1, runSequence: 1, topicRefs: [{ topicId: original.topicId, revision: current.revision }], context: '继续核验' }
  await assertDecisionIssue(h.call('group_decision_submit', submission(current, { actions: [action], reply: '' })), /task_archived/)
  assert.equal(h.applications.length, 0)
  const newTask = { kind: 'new-task', title: '后续核验', objective: '重新核验', acceptanceCriteria: ['证据可查'], topicRefs: action.topicRefs }
  const accepted = await h.call('group_decision_submit', submission(current, { actions: [newTask], reply: '已创建后续核验任务' }))
  assert.equal(accepted.status, 'accepted'); await h.coordinator.drain(); assert.equal(h.applications.length, 1)
  assert.equal(h.store.getTask(task.taskId).archivedAt, '2026-10-15T00:00:00Z')
})

for (const workflowPromptsEnabled of [false, true]) test('workflow instructions respect runtime mode: ' + workflowPromptsEnabled, async t => {
  const h = await setup(t, { workflowPromptsEnabled })
  await ingest(h, 'mode-check')
  await route(h)
  const text = h.sent.findLast(text => text.startsWith('[GROUP_TOPIC_DECISION]'))
  assert.ok(text)
  for (const retired of ['适用流程 ID/版本', 'group_task_prompt_get', '候选流程正文']) {
    assert.equal(text.includes(retired), workflowPromptsEnabled, retired)
  }
  assert.ok(text.includes('dispatchAssessment'))
  assert.ok(text.includes('group_task_context_get'))
})

test('fixed route categories are offered by active mode and bypass business decisions', async t => {
  const h = await setup(t, { fixedTopicsEnabled: true, workflowPromptsEnabled: false })
  await ingest(h, 'fixed-source', { text: '查平台；买咖啡；修复UPR' })
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(request.fixedTopics.map(topic => topic.title), ['职责外话题', '职责内Agent平台相关'])
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{ messageId: 'fixed-source', messageVersion: 1, units: [
    { unitKey: 'platform', summary: '平台查询', sourceRefs: [{ quote: '查平台；' }], fixedTopic: 'agent-platform', topics: [], reason: '平台整体查询' },
    { unitKey: 'outside', summary: '买咖啡', sourceRefs: [{ quote: '买咖啡；' }], fixedTopic: 'out-of-scope', topics: [], reason: '职责外' },
    { unitKey: 'upr', summary: '修复UPR', sourceRefs: [{ quote: '修复UPR' }], topics: [{ newTopicKey: 'upr', title: 'UPR修复' }] },
  ] }] })
  assert.equal(result.status, 'accepted')
  assert.equal(result.pendingDecisions.length, 1)
  assert.equal(result.pendingDecisions[0].messages.length, 1)
  assert.equal(result.pendingDecisions[0].messages[0].text, '修复UPR')
  assert.equal(h.store.getGroup('g').topics.length, 1)
  assert.deepEqual(h.applications, [])
})

test('Route and Topic receive only referenced group person identities without filtering business requests or existing-topic facts', async t => {
  const h = await setup(t, { fixedTopicsEnabled: true })
  const text = '@测试成员乙 负责发布；助理请核对小甲的修复结果'
  await ingest(h, 'named-request', { text })
  await h.coordinator.schedule('g')
  const old = h.envelope('[GROUP_TOPIC_ROUTE]')
  const personAliases = [{ alias: '小甲', name: '测试成员甲' }]
  await h.store.updateGroup({ groupId: 'g', personAliases: [...personAliases, { alias: '小乙', name: '测试成员乙' }] })
  const route = { messageId: 'named-request', messageVersion: 1, units: [
    { unitKey: 'owner', summary: '他人负责发布', sourceRefs: [{ quote: '@测试成员乙 负责发布；' }], topics: [{ newTopicKey: 'check', title: '核对修复结果' }], reason: '同一业务事项的人员分工仍保留原文，不授权本助手发布' },
    { unitKey: 'check', summary: '核对修复结果', sourceRefs: [{ quote: '助理请核对小甲的修复结果' }], topics: [{ newTopicKey: 'check', title: '核对修复结果' }] },
  ] }
  const stale = await h.rawCall('group_topic_route_submit', { requestId: old.requestId, routes: [route] })
  assert.equal(stale.status, 'stale'); assert.equal(stale.reason, 'routing-context-changed')
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(request.personAliases, personAliases)
  assert.match(request.personAliasGuide, /仅提到人名不等于指定负责人/)
  assert.match(h.sent.at(-1), /话题归属与助手动作分开判断/)
  const result = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [route] })
  assert.equal(result.status, 'accepted'); assert.equal(result.pendingDecisions.length, 1)
  assert.equal(result.pendingDecisions[0].messages.map(item => item.text).join(''), text)
  assert.equal((await h.store.listFixedTopicMessagesPage({ groupId: 'g', topicId: 'out-of-scope' })).total, 0)
  assert.deepEqual(h.envelope('[GROUP_TOPIC_DECISION]').personAliases, personAliases)
  const topicId = result.topicIdsByKey.check
  await ingest(h, 'quoted-fact', { text: '@测试成员乙 给你同步一下，这份结果是原核对事项的补充', quotedMessage: { messageId: 'named-request', content: '看小甲发的应该是这样吧' } })
  await h.coordinator.schedule('g')
  const followup = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.deepEqual(followup.personAliases, personAliases, 'quoted nickname still resolves to the confirmed full name')
  const updated = await h.call('group_topic_route_submit', { requestId: followup.requestId, routes: [{ messageId: 'quoted-fact', messageVersion: 1,
    units: [{ unitKey: 'fact', summary: '已有核对事项的新事实', sourceRefs: [{ wholeMessage: true }], topics: [{ topicId }] }] }] })
  assert.equal(updated.status, 'accepted')
  assert.equal(h.store.listTopics('g').length, 1)
  assert.deepEqual(h.applications, [], 'a name reference or status fact alone must not execute a task')
})

for (const atCommit of [false, true]) test('changed relevant person identity fences a Topic decision, including the atomic commit: ' + atCommit, async t => {
  const h = await setup(t, { fixedTopicsEnabled: true })
  await h.store.updateGroup({ groupId: 'g', personAliases: [{ alias: '小甲', name: '旧记录' }] })
  await ingest(h, 'alias-fact', { text: '助理请核对小甲的修复结果' })
  await h.coordinator.schedule('g')
  const route = h.envelope('[GROUP_TOPIC_ROUTE]')
  await h.call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'alias-fact', messageVersion: 1,
    topics: [{ newTopicKey: 'check', title: '核对结果' }] }] })
  const old = h.envelope('[GROUP_TOPIC_DECISION]')
  await h.store.updateGroup({ groupId: 'g', personAliases: [{ alias: '小甲', name: '旧记录' }, { alias: '小乙', name: '测试成员乙' }] })
  await h.coordinator.schedule('g')
  assert.equal(h.envelope('[GROUP_TOPIC_DECISION]').requestId, old.requestId, 'unrelated identity changes do not replace the decision')
  const correct = () => h.store.updateGroup({ groupId: 'g', personAliases: [{ alias: '小甲', name: '测试成员甲' }] })
  if (atCommit) {
    const accept = h.store.acceptTopicDecision
    h.store.acceptTopicDecision = async args => { await correct(); return accept(args) }
  } else await correct()
  const result = await h.call('group_decision_submit', { requestId: old.requestId, topicId: old.topicId, revision: old.revision,
    decision: { basisMessageIds: ['alias-fact'], actions: [], topicUpdate: { summary: '旧身份下的判断' }, reason: '保持沉默' } })
  assert.equal(result.status, 'topic-stale')
  assert.equal(h.store.getTopic('g', old.topicId).decisions.length, 0)
  const current = h.envelope('[GROUP_TOPIC_DECISION]')
  assert.notEqual(current.requestId, old.requestId)
  assert.deepEqual(current.personAliases, [{ alias: '小甲', name: '测试成员甲' }])
  assert.deepEqual(h.applications, []); assert.deepEqual(h.store.getGroup('g').outbox, [])
})

test('same-round latest input must be consumed; stale and queued submissions cannot commit; restart keeps accepted receipt', async t => {
  const events = [], inbox = { nextStep: [], nextTurn: [] }
  const h = await setup(t, { session: { snapshotEvents: () => events }, inbox, onSteer(message) {
    if (message.id.includes('-revision-')) inbox.nextStep.push(message)
    else events.push({ type: 'user/message', data: message })
  } })
  await ingest(h, 'round-one'); const first = (await route(h)).pendingDecisions[0]
  await ingest(h, 'round-two'); const current = (await route(h, { 'round-two': first.topicId })).pendingDecisions[0]
  assert.equal(first.requestId, current.requestId)
  assert.equal((await h.call('group_decision_submit', submission(first))).status, 'topic-stale')
  assert.equal((await h.call('group_decision_submit', submission(current))).status, 'decision-update-unread')
  assert.equal(h.store.getTopic('g', first.topicId).decisions.length, 0)
  const count = h.sent.length
  await h.coordinator.schedule('g'); await h.coordinator.schedule('g')
  assert.equal(h.sent.length, count)
  events.push({ type: 'user/message', data: inbox.nextStep[0] })
  assert.equal((await h.call('group_decision_submit', submission(current))).status, 'decision-update-unread', 'durable body alone is insufficient while still pending')
  inbox.nextStep.length = 0
  assert.equal((await h.call('group_decision_submit', submission(current))).status, 'accepted')
  await h.coordinator.drain('g')
  const recovered = await setup(t, { snapshot: h.snapshot })
  await recovered.coordinator.recover(); await recovered.coordinator.drain('g')
  assert.equal(recovered.store.getTopic('g', first.topicId).decisions.length, 1)
  assert.equal(recovered.applications.length, 0)
  await ingest(h, 'round-next'); const next = (await route(h, { 'round-next': first.topicId })).pendingDecisions[0]
  assert.notEqual(next.requestId, first.requestId)
})


test('latest revision cannot borrow the old consumption marker while its envelope awaits Task facts', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let reads = 0
  const h = await setup(t, { taskFacts: { context: async () => null, tasks: async () => {
    if (++reads === 2) { entered.resolve(); await release.promise }
    return []
  } } })
  t.after(() => release.resolve())
  await ingest(h, 'build-first'); const first = (await route(h)).pendingDecisions[0]
  await ingest(h, 'build-second')
  const updating = route(h, { 'build-second': first.topicId })
  await entered.promise
  const premature = await h.call('group_decision_submit', submission({ ...first, revision: 2 }))
  assert.equal(premature.status, 'decision-update-unread')
  assert.equal(h.store.getTopic('g', first.topicId).decisions.length, 0)
  release.resolve(); await updating
  assert.equal(h.envelope('[GROUP_TOPIC_DECISION]').revision, 2)
})

for (const [kind, expected] of [['route', []], ['title', ['group_topic_title_submit']], ['summary', ['group_topic_summary_submit']]]) test('request-scoped maintenance tools: ' + kind, async t => {
  const h = await setup(t, { scope: { requestId: 'coord-' + kind + '-fixture', groupId: 'g', messages: [] } })
  for (const name of ['group_topic_title_submit', 'group_topic_summary_submit']) assert.equal(h.tools.has(name), expected.includes(name))
  for (const name of ['group_topic_list','group_topic_context_get','group_topic_route_context_get','group_topic_route_submit']) assert.ok(h.tools.has(name), name)
})
for (const enabled of [false,true]) test('workflow prompt tool follows explicit program capability without narrowing business reads: ' + enabled, async t => {
  const h = await setup(t, { workflowPromptsEnabled: enabled, scope: { requestId: 'coord-decision-fixture', groupId: 'g', topicId: 'fixture', revision: 1, messages: [] } })
  assert.equal(h.tools.has('group_task_prompt_get'), enabled)
  for (const name of ['group_topic_list','group_topic_context_get','group_decision_context_get','group_reply_review_get','group_decision_submit','group_topic_route_review']) assert.ok(h.tools.has(name), name)
})
