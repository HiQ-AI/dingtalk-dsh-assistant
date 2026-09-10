import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Session } from '@deepseek-ai/dsh-session'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createTopicCoordinator, projectTopicContext, TASK_REVIEW_MAX_CHARS } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { visiblePromptRefs, visibleSectionLength } from '../packages/dingtalk-dsh-assistant/coordination-context.js'

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
  const agent = { session: options.session, inbox: options.inbox, steer(message) { sent.push(message.content[0].text); options.onSteer?.(message) }, whenIdle: options.whenIdle ?? (() => new Promise(() => {})) }
  const coordinator = createTopicCoordinator({
    store, getAgent: () => agent, assertSession(exec, groupId) { if (exec?.groupId !== groupId) throw new Error('wrong_session') },
    serializeTasks: options.serializeTasks ?? ((fn) => fn()), isClosing: options.isClosing ?? (() => false), retryDelayMs: options.retryDelayMs ?? 60_000,
    reviewCandidates: options.reviewCandidates ?? (() => []), onDecisionRequest: options.onDecisionRequest, maxRequestAttempts: options.maxRequestAttempts ?? 3,
    validateReplyReview(review, candidates) {
      if (candidates.length && (!review || candidates.some((item) => !review.reviewedOutboundIds?.includes(item.outboundId)))) throw new Error('incomplete_review')
      return review
    },
    appendOutbox: async (outbound) => { await options.beforeAppend?.(); return store.appendOutbox(outbound) }, cancelTask() {}, onError(_groupId, error) { errors.push(error); options.onError?.(error) },
    async applyAction(groupId, action, operation) {
      applications.push(operation.operationId)
      if (action.kind === 'new-task') await store.createTask({ groupId, taskId: operation.taskId, operationId: operation.operationId, ...action })
      else await store.applyTaskOperation({ taskId: action.taskId, operationId: operation.operationId, expectedInputVersion: action.inputVersion, expectedRunSequence: action.runSequence, transform: (task) => ({ ...task, inputVersion: task.inputVersion + 1, topicRefs: action.topicRefs }) })
      await options.afterAction?.(operation)
    },
  })
  coordinator.register({ tools: { register(tool) { tools.set(tool.name, tool) } } }, 'g')
  t.after(async () => { await coordinator.close(); await store.close() })
  return { store, snapshot, coordinator, sent, errors, applications,
    call: (name, args, exec = { groupId: 'g' }) => tools.get(name).execute(args, exec),
    envelope(prefix, label = 'Topic 请求') { const text = sent.findLast((item) => item.startsWith(prefix)); return text ? JSON.parse(text.split('\n').find((line) => line.startsWith(`${label}：`)).slice(label.length + 1)) : undefined },
  }
}
async function ingest(h, messageId, extra = {}) {
  await h.store.ingest({ groupId: 'g', messageId, text: `@助理 ${messageId}`, senderOpenDingTalkId: 'od-a', occurredAt: '2026-09-07T00:00:00Z', ...extra })
}

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
  const routed = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'lossless', messageVersion: 1, topics: [{ newTopicKey: 'lossless', title: '无损输出' }],
  }] })
  assert.deepEqual(JSON.parse(JSON.stringify(routed)), routed)
  const recovered = await h.call('group_topic_route_submit', { requestId: request.requestId, routes: [{
    messageId: 'lossless', messageVersion: 1, topics: [{ newTopicKey: 'lossless', title: '无损输出' }],
  }] })
  assert.equal(recovered.status, 'accepted')
  assert.equal(recovered.recovered, true)
  assert.deepEqual(recovered.topicIdsByKey, routed.topicIdsByKey)
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

test('归类期间消息版本变化返回刷新后的当前请求', async (t) => {
  const h = await setup(t)
  await ingest(h, 'edited', { text: '@助理 初始内容' })
  await h.coordinator.schedule('g')
  const original = h.envelope('[GROUP_TOPIC_ROUTE]')
  await ingest(h, 'edited', { text: '@助理 初始内容', senderName: '发送人' })
  const result = await h.call('group_topic_route_submit', { requestId: original.requestId, routes: [{ messageId: 'edited', messageVersion: 1, topics: [{ newTopicKey: 'edited', title: '消息修改' }] }] })
  assert.equal(result.status, 'stale')
  assert.equal(result.reason, 'message-version-changed')
  assert.equal(result.currentRequest.messages[0].messageVersion, 2)
  assert.equal(h.store.listTopics('g').length, 0)
})
async function route(h, choices = {}) {
  await h.coordinator.schedule('g')
  const request = h.envelope('[GROUP_TOPIC_ROUTE]')
  return h.call('group_topic_route_submit', { requestId: request.requestId, routes: request.messages.map((message) => ({ messageId: message.messageId, messageVersion: message.messageVersion, topics: [typeof choices[message.messageId] === 'string' ? { topicId: choices[message.messageId] } : choices[message.messageId] ?? { newTopicKey: message.messageId, title: message.messageId }] })) })
}
const submission = (request, patch = {}) => ({ requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { basisMessageIds: [request.messages.at(-1)?.messageId ?? request.removedMessageIds?.[0]], ...(patch.reply ? { replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } : {}), actions: [], ...(patch.reply === undefined ? { reason: '无需回复' } : {}), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } })
async function complete(h, request) {
  assert.equal((await h.call('group_decision_submit', submission(request))).status, 'accepted')
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
  assert.ok(JSON.stringify(request.messages).length <= 40_000)
  assert.ok(request.omittedDeltaMessageIds.length > 0)
  assert.equal(request.ownedDeltaMessageIds.every((id) => request.messages.some((message) => message.messageId === id)), true)
  await assert.rejects(h.call('group_decision_submit', submission(request)), /topic_decision_delta_unread/)
  let offset = 0, textOffset = 0
  while (offset < request.totalMessages) {
    const page = await h.call('group_topic_context_get', { topicId: request.topicId, revision: request.revision, offset, limit: 5, ...(textOffset ? { textOffset } : {}) })
    assert.ok(JSON.stringify(page).length <= 40_000)
    offset = page.nextOffset; textOffset = page.nextTextOffset ?? 0
  }
  assert.equal((await h.call('group_decision_submit', submission(request))).status, 'accepted')
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

test('未知输入返回 routing-required，归到 B 后原 A 请求继续有效', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const a = (await route(h)).pendingDecisions[0]
  await ingest(h, 'b')
  assert.equal((await h.call('group_decision_submit', submission(a))).status, 'routing-required')
  assert.equal(h.store.getTopic('g', a.topicId).decisions.length, 0)
  await route(h)
  await complete(h, a)
})

test('同 Topic 新增输入使旧决策失效且新依据必须覆盖本次增量', async (t) => {
  const h = await setup(t); await ingest(h, 'a1')
  const a = (await route(h)).pendingDecisions[0]
  await complete(h, a)
  await ingest(h, 'a2')
  const current = (await route(h, { a2: a.topicId })).pendingDecisions[0]
  assert.equal((await h.call('group_decision_submit', submission(a))).status, 'topic-stale')
  await assert.rejects(h.call('group_decision_submit', submission(current, { basisMessageIds: ['a1'] })), /topic_decision_current_basis_required/)
  await assert.rejects(h.call('group_decision_submit', submission(current, { basisMessageIds: ['foreign'] })), /topic_decision_basis_invalid/)
  await complete(h, current)
  assert.equal(h.store.getTopic('g', a.topicId).processedRevision, 2)
})

test('Topic 关联不能替代原消息授权，明确给他人的请求不得擅自接单', async (t) => {
  const h = await setup(t); await ingest(h, 'a', { text: '@李四 请查原因' })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '查原因', objective: '查原因', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  await assert.rejects(h.call('group_decision_submit', submission(request, { actions: [action], reply: '开始', reason: undefined })), /task_action_directed_to_other_participants/)
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
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
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  await h.coordinator.close(); await h.store.close()
  const reopened = await setup(t, { snapshot: h.snapshot })
  await reopened.coordinator.recover(); await reopened.coordinator.drain('g')
  assert.equal(reopened.store.listTasks().length, 1)
  assert.equal(reopened.store.getGroup('g').outbox.length, 1)
  assert.equal(reopened.store.getTopic('g', request.topicId).processedRevision, 1)
  assert.equal(reopened.store.getTopic('g', request.topicId).decisions[0].operations[0].status, 'applied')
  assert.deepEqual(reopened.applications, h.applications)
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
  candidates = [{ outboundId: 'new-result', sourceMessageId: 'a1', reply: '刚到达的结果' }]
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
  const index = await h.call('group_topic_list', { query: '导出', offset: 0, limit: 1 })
  assert.equal(index.total, 1)
  const page = await h.call('group_topic_context_get', { topicId: request.topicId, revision: 1, offset: 0, limit: 1 })
  assert.equal(page.total, 1)
  assert.equal(page.messages[0].messageId, 'a')
  await assert.rejects(h.call('group_topic_context_get', { topicId: 'foreign-topic', revision: 1 }), /topic_not_found/)
  await assert.rejects(h.call('group_topic_list', { offset: -1 }), /topic_page_invalid/)
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
  candidates = [{ outboundId: 'just-arrived', sourceMessageId: 'a1', reply: '本任务先前的结果' }]
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


test('已接受决策失败后到期自动恢复，无需新消息或重启', { timeout: 2_000 }, async (t) => {
  let attempt = 0, recovered
  const secondAttempt = new Promise((resolve) => { recovered = resolve })
  const h = await setup(t, { retryDelayMs: 10, afterAction() { attempt += 1; if (attempt === 1) throw new Error('temporary_action_failure'); recovered() } })
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
  assert.equal(h.applications.length, 2)
  assert.equal(new Set(h.applications).size, 1)
})

test('共享消息只有主 Topic 能创建 Task 或确认，其他 Topic 可独立实质回答', async (t) => {
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
  await assert.rejects(h.call('group_decision_submit', submission(a, { actions: [action(a)], reply: '收到' })), /topic_effect_owner_required/)
  await assert.rejects(h.call('group_decision_submit', submission(a, { reply: '收到', replyReview: { kind: 'confirmation' } })), /topic_effect_owner_required/)
  assert.equal((await h.call('group_decision_submit', submission(a, { reply: 'A 的独立分析结果', replyReview: { kind: 'substantive' } }))).status, 'accepted')
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
  await assert.rejects(h.call('group_decision_submit', submission(removed, { actions: [action], reply: '执行' })), /topic_effect_owner_required/)
  await complete(h, removed)
  assert.equal(h.store.getTopic('g', original.topicId).processedRevision, 2)
  assert.equal(h.store.listTasks().length, 0)
})

test('明确给他人的补充或取消同样不能改变已有 Task，引用转交后才可执行', async (t) => {
  const h = await setup(t), { task, request: original } = await taskFixture(h)
  await ingest(h, 'other', { text: '@乙 暂停你的任务' })
  const current = (await route(h, { other: original.topicId })).pendingDecisions[0]
  for (const kind of ['task-context', 'task-cancel', 'task-reopen']) {
    await h.store.updateTask(task.taskId, (value) => ({ ...value, state: kind === 'task-reopen' ? 'completed' : 'running' }))
    const action = { kind, taskId: task.taskId, inputVersion: 1, runSequence: 1, topicRefs: [{ topicId: original.topicId, revision: current.revision }], ...(kind === 'task-cancel' ? { reason: '取消' } : { context: '修改任务' }) }
    await assert.rejects(h.call('group_decision_submit', submission(current, { actions: [action], reply: '收到' })), /task_action_directed_to_other_participants/)
  }
  assert.equal(h.store.getTopic('g', original.topicId).decisions.length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await ingest(h, 'forward', { text: '@助理 请接手核验', quotedMessage: { messageId: 'other', content: '@乙 暂停你的任务' } })
  const forwarded = (await route(h, { forward: original.topicId })).pendingDecisions[0]
  const action = { kind: 'task-reopen', taskId: task.taskId, inputVersion: 1, runSequence: 1, context: '按明确转交核验', topicRefs: [{ topicId: original.topicId, revision: forwarded.revision }] }
  assert.equal((await h.call('group_decision_submit', submission(forwarded, { basisMessageIds: ['forward'], actions: [action], reply: '接手核验。' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.applications.length, 1)
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
  assert.equal(context.topic.processing.status, 'failed')
  assert.equal(context.topic.processing.error, 'delivery-store-failure')
  assert.equal(context.topic.processing.appliedOperations, 0)
  assert.equal(context.topic.processing.totalOperations, 0)
  assert.equal(Object.hasOwn(context.topic, 'decisions'), false)
})

test('动作必须先有确认且可靠 Outbox 拒绝时零 Task 副作用', async (t) => {
  const h = await setup(t), request = await (async () => { await ingest(h, 'a'); return (await route(h)).pendingDecisions[0] })()
  const actions = [{ kind: 'new-task', title: 'A', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: request.revision }] }]
  assert.equal((await h.call('group_decision_submit', submission(request, { actions }))).status, 'invalid-arguments')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
  h.store.appendOutbox = async () => ({ status: 'reply-busy' })
  assert.equal((await h.call('group_decision_submit', submission(request, { actions, reply: '确认核验' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.applications.length, 0)
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].error, 'topic_outbox_reply-busy')
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
  session.append('assistant/message', { turn: 1, step: 1, message: { id: `assistant-${id}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id, name, arguments: '{}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: JSON.stringify(result) }] }] } }, { surfaceOp: 'append' })
}

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
  session.append('user/message', { id: `summary-${session.snapshotEvents().length}`, role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: '之前曾经读取流程和原文；此摘要不保留完整正文。' }] }, { surfaceOp: { op: 'replace', start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes })
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
  const reopened = Session.fromRestore(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), JSON.parse(JSON.stringify(session.header)))
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
  const restored = Session.fromRestore(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), JSON.parse(JSON.stringify(session.header)))
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
  const session = Session.create('session-pending-body'), inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
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
