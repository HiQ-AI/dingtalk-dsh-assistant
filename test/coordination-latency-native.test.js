import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createCoordinationSessions, createCoordinationStepGate } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'

const requireGoal = createRequire(import.meta.resolve('@deepseek-ai/dsh-goal'))
const { SessionProjectionRegistry } = requireGoal('@deepseek-ai/dsh-session-projection')
const tick = () => new Promise(resolve => setImmediate(resolve))

// 确定性模型只决定调用序列；消息路由、工具校验、调度、决策和 Task 落库均走真实实现。
test('真实协调器中九次非法旧决策不挡住新图文任务，公平续行不消耗请求重试次数', { timeout: 10000 }, async t => {
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'native-latency-test' })
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'g', responsibility: '响应明确发给小小鹏的排查请求' })
  await store.setAgentNames(['小小鹏'])
  await store.ingest({ groupId: 'g', messageId: 'old', text: '小小鹏，上次盘点不要接。', occurredAt: '2026-09-22T08:26:00Z' })
  await store.routeMessages({ groupId: 'g', routeId: 'seed-old-topic', routingRevision: 0,
    routes: [{ messageId: 'old', messageVersion: 1, topics: [{ newTopicKey: 'old', title: '代理越界接活' }] }] })
  const oldTopicId = store.listTopics('g')[0].topicId
  const image = { attachmentId: 'sha256:' + '1'.repeat(64), mediaType: 'image/jpeg', bytes: 19471, width: 720, height: 335 }
  const incoming = { groupId: 'g', messageId: 'msg5oChb4j8c29-fixture', text: '小小鹏看下这个：任一专家已经开始审核后不可撤回；一个专家审核完了，为啥可以撤回，如下图',
    occurredAt: '2026-09-22T08:26:18.310Z', imageRefs: [image] }
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const firstEntered = Promise.withResolvers(), releaseFirst = Promise.withResolvers(), taskCreated = Promise.withResolvers()
  const oldFinished = Promise.withResolvers(), newFinished = Promise.withResolvers()
  const calls = new Map(), agents = new Map(), requests = new Map(), acceptedOrder = [], applicationIds = [], errors = [], imagesSeen = []
  let coordinator, manager, oldRequest, newRequest, taskCreatedWhileOldPending = false

  class Model extends LlmAdapter {
    constructor(entry) { super(); this.entry = entry }
    async *stream(options) {
      const { request, role } = this.entry
      const count = (calls.get(request.requestId) ?? 0) + 1
      calls.set(request.requestId, count)
      const isOld = request.topicId === oldTopicId
      let name, args
      if (role === 'route') {
        assert.equal(count, 1, '小消息的真实路由仅需一次模型调用')
        name = 'group_topic_route_submit'
        args = { requestId: request.requestId, routes: request.messages.map(message => ({
          messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [], units: [{
            unitKey: 'review-recall', summary: '排查专家已审核后仍可撤回的原因', replacesUnitIds: [],
            sourceRefs: [{ quote: message.text }, { imageRefId: image.attachmentId }],
            topics: [{ newTopicKey: 'review-recall', title: '专家审核后撤回异常' }],
          }],
        })) }
      } else if (isOld) {
        assert.ok(count <= 10, '旧话题不得无限重复提交')
        if (count === 1) { firstEntered.resolve(); await releaseFirst.promise }
        name = 'group_decision_submit'
        args = { requestId: request.requestId, topicId: request.topicId, revision: request.revision,
          decision: { basisMessageIds: ['old'], actions: [], reason: '停止承接盘点。', ...(count <= 9 ? { reply: '本次不会继续处理。' } : {}) } }
      } else {
        assert.ok(count <= 2, '任务决策不应因其他话题错误重复生成')
        imagesSeen.push((options.messages ?? []).flatMap(message => message.content ?? []).filter(part => part.type === 'image').map(part => part.attachment))
        if (count === 1) {
          name = 'group_decision_context_get'
          args = { requestId: request.requestId, section: 'messages', offset: 0 }
        } else {
          name = 'group_decision_submit'
          args = { requestId: request.requestId, topicId: request.topicId, revision: request.revision,
            decision: { basisMessageIds: [incoming.messageId], actions: [{ kind: 'new-task', title: '排查审核后撤回异常',
              objective: '排查已有专家审核后仍能撤回分配的原因', acceptanceCriteria: ['给出根因及代码证据'], topicRefs: [{ topicId: request.topicId, revision: request.revision }] }],
            reply: '收到，我会排查原因。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }
        }
      }
      const id = request.requestId + '-' + count, json = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }

  manager = createCoordinationSessions({ isCurrent: request => coordinator.isCurrentRequest(request), onError: error => errors.push(error), create: async entry => {
    requests.set(entry.request.requestId, entry.request)
    if (entry.request.topicId === oldTopicId) oldRequest = entry.request
    else if (entry.role === 'decision') newRequest = entry.request
    ctx.llm.registerAdapter([entry.sessionId], new Model(entry))
    const handle = await loop.createAgent(ctx, { sessionId: entry.sessionId, agentOptions: { provider: entry.sessionId, model: 'fixture' }, setup(agentCtx) {
      agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, request => coordinator.isCurrentRequest(request)))
      coordinator.register(agentCtx, 'g', entry.request)
    } })
    agents.set(entry.request.requestId, handle.agent)
    return handle
  } })
  coordinator = createTopicCoordinator({ store, getAgent: (groupId, request) => request ? manager.get(groupId, request) : {},
    dispatchRequest: (request, message) => manager.dispatch(request, message), waitRequestIdle: request => manager.whenSettled(request),
    onRequestFinished(request) {
      acceptedOrder.push(request.requestId); manager.finish(request)
      if (request.topicId === oldTopicId) oldFinished.resolve()
      else if (request.requestId.startsWith('coord-decision-')) newFinished.resolve()
    },
    assertSession(exec, groupId, scope) { manager.assert(exec.agent, groupId, scope.requestId) },
    serializeTasks: operation => operation(), isClosing: () => false, retryDelayMs: 1,
    reviewCandidates: () => [], validateReplyReview: review => review,
    appendOutbox: outbound => store.appendOutbox(outbound), cancelTask() {}, onError(_groupId, error) { errors.push(error) },
    async applyAction(groupId, action, operation) {
      assert.equal(action.kind, 'new-task')
      applicationIds.push(operation.operationId)
      await store.createTask({ groupId, taskId: operation.taskId, operationId: operation.operationId, ...action })
      taskCreatedWhileOldPending = coordinator.isCurrentRequest(oldRequest)
      taskCreated.resolve()
    },
  })
  t.after(async () => { releaseFirst.resolve(); await coordinator.close(); await manager.close(); await store.close(); await ctx.fiber.dispose() })
  await coordinator.schedule('g')
  await firstEntered.promise
  await store.ingest(incoming)
  await coordinator.schedule('g')
  releaseFirst.resolve()
  await newFinished.promise; await taskCreated.promise
  assert.equal(taskCreatedWhileOldPending, true, '旧话题未结束时，后续图文任务已落库')
  assert.ok(calls.get(oldRequest.requestId) < 10)
  assert.ok(acceptedOrder.includes(newRequest.requestId))
  assert.equal(acceptedOrder.includes(oldRequest.requestId), false)
  assert.ok(imagesSeen.some(refs => refs.some(ref => ref.attachmentId === image.attachmentId)), '真实原生模型上下文保留图片附件')
  await oldFinished.promise
  await Promise.all([...requests.values()].map(request => manager.whenSettled(request)))
  await coordinator.drain('g'); await tick()
  assert.equal(calls.get(oldRequest.requestId), 10)
  assert.equal(calls.get(newRequest.requestId), 2)
  const results = agents.get(oldRequest.requestId).session.snapshotEvents().filter(event => event.type === 'tool/result')
    .map(event => JSON.parse(event.data.message.content[0].content[0].text))
  assert.equal(results.filter(result => result.status === 'invalid-arguments').length, 9)
  assert.ok(results.slice(0, 9).every(result => result.issues.some(issue => issue.field === 'decision.reason')))
  assert.equal(store.listTasks().length, 1)
  assert.equal(applicationIds.length, 1)
  assert.equal(store.getGroup('g').outbox.length, 1, '只落库一次确认，不调用真实 DWS')
  for (const request of requests.values()) assert.equal(store.getCoordinationRequest('g', request.requestId).attempt, 0, '公平续行不是请求失败重试')
  await coordinator.schedule('g'); await coordinator.drain('g')
  assert.equal(store.listTasks().length, 1)
  assert.equal(applicationIds.length, 1)
  assert.deepEqual(errors, [])
})
