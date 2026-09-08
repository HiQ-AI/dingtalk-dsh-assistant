import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'

// 使用真实 DomainFacility 的验证与串行持久化链；只有介质写入被隔离为内存。
function facility(snapshot = { tables: {}, global: null }, beforePut = () => {}) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { beforePut(table, key, value); (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'isolated' })
}
async function setup() {
  const snapshot = { tables: {}, global: null }
  const storage = facility(snapshot), store = await openResidentStore(storage)
  await store.subscribe({ groupId: 'g' })
  return { snapshot, storage, store }
}
async function ingest(store, messageId, extra = {}) {
  return store.ingest({ groupId: 'g', messageId, text: messageId, occurredAt: '2026-09-07T00:00:00Z', senderName: '甲', senderOpenDingTalkId: 'od-a', ...extra })
}
async function route(store, id, items) {
  return store.routeMessages({ groupId: 'g', routeId: id, routingRevision: store.getGroup('g').routingRevision,
    routes: items.map(([messageId, topic]) => ({ messageId, messageVersion: store.getGroup('g').messages.find((item) => item.messageId === messageId).messageVersion, topics: [typeof topic === 'string' ? { topicId: topic } : topic] })) })
}
const decision = (id, topicId, revision, extra = {}) => ({ groupId: 'g', topicId, revision, decisionId: id, decision: { actions: [], reason: '无需回复' }, ...extra })

test('A/B交错归类跨turn延续、固定快照及Task不复制消息', async () => {
  const { store } = await setup()
  for (const id of ['a1', 'b1', 'a2']) await ingest(store, id)
  const routed = await route(store, 'r1', [['a1', { newTopicKey: 'a', title: 'A' }], ['b1', { newTopicKey: 'b', title: 'B' }], ['a2', { newTopicKey: 'a', title: 'A' }]])
  const topicId = routed.topicIdsByKey.a
  assert.deepEqual(store.getTopicContext({ groupId: 'g', topicId, revision: 2 }).messages.map((item) => item.messageId), ['a1', 'a2'])
  const { task } = await store.createTask({ groupId: 'g', topicRefs: [{ topicId, revision: 2 }], title: 'A执行', objective: '执行A', acceptanceCriteria: ['完成并验证'] })
  assert.deepEqual(task.topicRefs, [{ topicId, revision: 2 }])
  for (const field of ['sourceMessageId', 'triggerHistory', 'messageHistory', 'relatedContexts']) assert.equal(field in task, false)
  await ingest(store, 'a3'); await route(store, 'r2', [['a3', topicId]])
  assert.equal(store.getTopic('g', topicId).revision, 3)
  assert.equal(store.getTopicContext({ groupId: 'g', topicId, revision: task.topicRefs[0].revision }).total, 2)
  await assert.rejects(store.removeGroup({ groupId: 'g' }), /group_has_referenced_topics/)
})

test('归类整批预检拒绝跨群/重复/过时事实且幂等重试不重复Topic', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const input = { groupId: 'g', routeId: 'route', routingRevision: 0, routes: [{ messageId: 'a', messageVersion: 1, topics: [{ newTopicKey: 'a', title: 'A' }] }] }
  const before = structuredClone(store.getGroup('g'))
  await assert.rejects(store.routeMessages({ ...input, routes: [...input.routes, { messageId: 'foreign', messageVersion: 1, topics: [] }] }), /message_not_found/)
  assert.deepEqual(store.getGroup('g'), before)
  const first = await store.routeMessages(input), again = await store.routeMessages(input)
  assert.deepEqual(again.topicIdsByKey, first.topicIdsByKey)
  assert.equal(store.listTopics('g').length, 1)
  await assert.rejects(store.routeMessages({ ...input, routes: [] }), /topic_routes_invalid/)
})

test('未知输入阻止提交，已归类无关B允许A提交，同A补充使旧版本失效', async () => {
  const { store } = await setup(); await ingest(store, 'a1')
  const a = (await route(store, 'r1', [['a1', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await ingest(store, 'b1')
  assert.equal((await store.acceptTopicDecision(decision('d-a', a, 1))).status, 'routing-required')
  await route(store, 'r2', [['b1', { newTopicKey: 'b', title: 'B' }]])
  assert.equal((await store.acceptTopicDecision(decision('d-a', a, 1))).status, 'accepted')
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'd-a' })
  await ingest(store, 'a2'); await route(store, 'r3', [['a2', a]])
  assert.equal((await store.acceptTopicDecision(decision('old', a, 1))).status, 'topic-stale')
  assert.equal(store.getTopic('g', a).decisions.length, 1)
})

test('附件与身份补齐产生新事实版本，重开仍可读取旧Topic快照', async () => {
  const { store, snapshot } = await setup()
  await ingest(store, 'a', { mediaUnavailable: ['image fetch failed'] })
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await ingest(store, 'a', { mediaUnavailable: [], imageRefs: [{ id: 'attachment-a', mediaType: 'image/png' }] })
  assert.equal(store.getTopic('g', a).revision, 2)
  assert.equal(store.getTopicContext({ groupId: 'g', topicId: a, revision: 1 }).messages[0].mediaUnavailable[0], 'image fetch failed')
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  assert.equal(reopened.getTopicContext({ groupId: 'g', topicId: a, revision: 2 }).messages[0].imageRefs[0].id, 'attachment-a')
  assert.equal(reopened.getGroup('g').messages[0].routingStatus, 'pending')
})

test('错误归属追加remove/add保留原版本', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const b = (await route(store, 'r2', [['a', { newTopicKey: 'b', title: 'B' }]])).topicIdsByKey.b
  assert.equal(store.getTopicContext({ groupId: 'g', topicId: a, revision: 1 }).total, 1)
  assert.equal(store.getTopicContext({ groupId: 'g', topicId: a, revision: 2 }).total, 0)
  assert.equal(store.getTopicContext({ groupId: 'g', topicId: b, revision: 1 }).total, 1)
})

test('决策固定动作身份、失败后重开恢复、Task变更恰好一次', async () => {
  const { store, snapshot } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const input = decision('durable', a, 1, { decision: { actions: [{ kind: 'new-task' }] } })
  const accepted = await store.acceptTopicDecision(input), op = accepted.record.operations[0]
  const taskInput = { groupId: 'g', taskId: op.taskId, operationId: op.operationId, topicRefs: [{ topicId: a, revision: 1 }], title: 'A', objective: '执行A', acceptanceCriteria: ['结果可验证'] }
  assert.equal((await store.createTask(taskInput)).created, true)
  await store.updateTopicDecision({ groupId: 'g', topicId: a, decisionId: 'durable', patch: { status: 'failed', error: '故障注入' } })
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  assert.equal((await reopened.acceptTopicDecision(input)).status, 'duplicate')
  assert.equal((await reopened.createTask(taskInput)).created, false)
  assert.equal(reopened.listTasks().length, 1)
  await reopened.updateTopicDecision({ groupId: 'g', topicId: a, decisionId: 'durable', patch: { operations: [{ ...op, status: 'applied' }] } })
  await reopened.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'durable' })
  assert.equal(reopened.getTopic('g', a).processedRevision, 1)
  const update = { taskId: op.taskId, operationId: 'context-2', expectedInputVersion: 1, transform: (task) => ({ ...task, inputVersion: 2 }) }
  assert.equal((await reopened.applyTaskOperation(update)).applied, true)
  assert.equal((await reopened.applyTaskOperation(update)).applied, false)
  assert.equal(reopened.getTask(op.taskId).inputVersion, 2)
})

test('共享Task版本和保留项阻止其他Topic覆盖', async () => {
  const { store } = await setup(); await ingest(store, 'a'); await ingest(store, 'b')
  const routed = await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }], ['b', { newTopicKey: 'b', title: 'B' }]])
  const a = routed.topicIdsByKey.a, b = routed.topicIdsByKey.b
  const { task } = await store.createTask({ groupId: 'g', topicRefs: [{ topicId: a, revision: 1 }], title: 'A', objective: '执行A', acceptanceCriteria: ['完成可查'] })
  const versions = [{ taskId: task.taskId, inputVersion: 1, runSequence: 1 }]
  assert.equal((await store.acceptTopicDecision(decision('d-a', a, 1, { expectedTaskVersions: versions }))).status, 'accepted')
  assert.equal((await store.acceptTopicDecision(decision('d-b', b, 1, { expectedTaskVersions: versions }))).status, 'task-busy')
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'd-a' })
  await store.applyTaskOperation({ taskId: task.taskId, operationId: 'change', expectedInputVersion: 1, transform: (current) => ({ ...current, inputVersion: 2 }) })
  assert.equal((await store.acceptTopicDecision(decision('d-b', b, 1, { expectedTaskVersions: versions }))).status, 'task-stale')
})

test('一条共享消息只存一份并更新两个Topic，归类与决策排队按最新状态检查', async () => {
  const { store } = await setup(); await ingest(store, 'a'); await ingest(store, 'b')
  const routed = await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }], ['b', { newTopicKey: 'b', title: 'B' }]])
  const a = routed.topicIdsByKey.a, b = routed.topicIdsByKey.b
  const accepted = store.acceptTopicDecision(decision('before', a, 1))
  const inbound = ingest(store, 'shared')
  assert.equal((await accepted).status, 'accepted'); await inbound
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'before' })
  const pending = store.routeMessages({ groupId: 'g', routeId: 'shared', routingRevision: 1, routes: [{ messageId: 'shared', messageVersion: 1, topics: [
    { topicId: a, relationship: 'continuation', reason: '继续事项 A' },
    { topicId: b, relationship: 'affected', reason: '同时改变事项 B' },
  ], effectOwner: { topicId: b } }] })
  const stale = store.acceptTopicDecision(decision('after', a, 1))
  await pending
  assert.equal((await stale).status, 'topic-stale')
  assert.equal(store.getGroup('g').messages.length, 3)
  assert.equal(store.getTopic('g', a).revision, 2)
  assert.equal(store.getTopic('g', b).revision, 2)
  assert.equal(store.getTopic('g', a).entries.at(-1).effectOwner, false)
  assert.equal(store.getTopic('g', b).entries.at(-1).effectOwner, true)
})

test('回复快照preflight在Group原子更新内拒绝，决策和Outbox均零副作用', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const snapshot = store.getGroup('g').outbox.length
  const first = store.appendOutbox({ groupId: 'g', sourceMessageId: 'prior', text: '先前回复' })
  const preflight = (latest) => latest.outbox.length === snapshot ? undefined : { status: 'reply-review-stale' }
  const commit = store.acceptTopicDecision(decision('candidate', a, 1, { preflight }))
  const reply = store.appendOutbox({ groupId: 'g', sourceMessageId: 'candidate', text: '候选回复', preflight })
  await first
  assert.equal((await commit).status, 'reply-review-stale')
  assert.equal((await reply).status, 'reply-review-stale')
  assert.equal(store.getTopic('g', a).decisions.length, 0)
  assert.equal(store.getGroup('g').outbox.length, 1)
})

test('重复引用补齐保留已知正文，改变引用ID不串用旧正文和身份', async () => {
  const { store } = await setup()
  await ingest(store, 'quote', { quotedMessage: { messageId: 'original', content: '已知正文', senderName: '乙', occurredAt: 'yesterday' } })
  const same = await ingest(store, 'quote', { quotedMessage: { messageId: 'original', content: '', senderName: 'null' } })
  assert.equal(same.enriched, false)
  assert.equal(same.group.messages[0].quotedMessage.content, '已知正文')
  const changed = await ingest(store, 'quote', { quotedMessage: { messageId: 'another', content: '' } })
  assert.equal(changed.group.messages[0].quotedMessage.content, '')
  assert.equal(changed.group.messages[0].quotedMessage.senderName, undefined)
  assert.equal(changed.group.messages[0].quotedMessage.occurredAt, undefined)
})

test('固定版本不暴露后来摘要，旧决策完成不关闭已收到新输入的话题', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await store.acceptTopicDecision(decision('first', a, 1, { decision: { actions: [], topicUpdate: { summary: '第一版', status: 'closed' } } }))
  await ingest(store, 'b'); await route(store, 'r2', [['b', a]])
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'first' })
  assert.equal(store.getTopic('g', a).status, 'active')
  await store.acceptTopicDecision(decision('second', a, 2, { decision: { actions: [], topicUpdate: { summary: '后来的第二版', openQuestions: ['后来问题'] } } }))
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'second' })
  const previous = store.getTopicContext({ groupId: 'g', topicId: a, revision: 1 })
  assert.equal(previous.topic.revision, 1)
  assert.equal(previous.topic.summary, '')
  assert.equal(previous.topic.decisions.length, 1)
  assert.deepEqual(previous.topic.openQuestions, [])
})

test('不同Topic不能同时接受撤回同一Outbox的意图', async () => {
  const { store } = await setup(); await ingest(store, 'a'); await ingest(store, 'b')
  const routed = await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }], ['b', { newTopicKey: 'b', title: 'B' }]])
  const patch = { decision: { actions: [], replyReview: { replaceOutboundIds: ['outbound-prior'] } } }
  assert.equal((await store.acceptTopicDecision(decision('a', routed.topicIdsByKey.a, 1, patch))).status, 'accepted')
  assert.equal((await store.acceptTopicDecision(decision('b', routed.topicIdsByKey.b, 1, patch))).status, 'reply-busy')
  assert.equal(store.getTopic('g', routed.topicIdsByKey.b).decisions.length, 0)
})

test('Web输入与Topic决策一次写入，持久失败零副作用且重试固定身份', async () => {
  const snapshot = { tables: {}, global: null }
  let fail = false
  const store = await openResidentStore(facility(snapshot, (table) => { if (fail && table === 'groups') { fail = false; throw new Error('injected-durable-write-failure') } }))
  await store.subscribe({ groupId: 'g' })
  const request = { groupId: 'g', requestId: 'web-create', text: '从管理页面创建任务', action: { kind: 'new-task', title: 'Web任务', objective: '执行页面要求', acceptanceCriteria: ['结果可核验'] }, topicRefs: [] }
  const before = structuredClone(store.getGroup('g'))
  fail = true
  await assert.rejects(store.submitWebTaskInput(request), /injected-durable-write-failure/)
  assert.deepEqual(store.getGroup('g'), before)
  assert.deepEqual(snapshot.tables.groups.g, before)
  const accepted = await store.submitWebTaskInput(request)
  assert.equal(accepted.status, 'accepted')
  assert.equal(store.getGroup('g').messages.length, 1)
  assert.equal(store.getGroup('g').messages[0].sourceKind, 'web')
  assert.equal(store.getTopic('g', accepted.topicId).revision, 1)
  assert.deepEqual(accepted.record.decision.actions[0].topicRefs, [{ topicId: accepted.topicId, revision: 1 }])
  const operation = accepted.record.operations[0]
  const task = await store.createTask({ groupId: 'g', ...accepted.record.decision.actions[0], taskId: operation.taskId, operationId: operation.operationId })
  assert.equal(task.created, true)
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  await ingest(reopened, 'arrived-after-web')
  const duplicate = await reopened.submitWebTaskInput(request)
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.record.decisionId, accepted.record.decisionId)
  assert.equal(reopened.getGroup('g').messages.length, 2)
  await assert.rejects(reopened.submitWebTaskInput({ ...request, text: '相同请求ID不同原文' }), /web_task_request_identity_conflict/)
})

test('Web输入原子复核未知消息、Topic版本、Task版本状态与保留项', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const { task } = await store.createTask({ groupId: 'g', topicRefs: [{ topicId: a, revision: 1 }], title: 'A', objective: '执行A', acceptanceCriteria: ['完成可核验'] })
  const request = { groupId: 'g', requestId: 'web-context', text: '页面补充', topicRefs: [{ topicId: a, revision: 1 }], action: { kind: 'task-context', taskId: task.taskId, inputVersion: 1, runSequence: 1, context: '补充背景' } }
  await ingest(store, 'unknown')
  assert.equal((await store.submitWebTaskInput(request)).status, 'routing-required')
  await route(store, 'r2', [['unknown', { newTopicKey: 'b', title: 'B' }]])
  assert.equal((await store.submitWebTaskInput({ ...request, topicRefs: [{ topicId: a, revision: 2 }] })).status, 'topic-stale')
  assert.equal((await store.submitWebTaskInput({ ...request, action: { ...request.action, inputVersion: 2 } })).status, 'task-stale')
  assert.equal((await store.submitWebTaskInput({ ...request, action: { ...request.action, kind: 'task-reopen' } })).status, 'task-state-invalid')
  const accepted = await store.submitWebTaskInput(request)
  assert.equal(accepted.status, 'accepted')
  assert.equal((await store.submitWebTaskInput({ ...request, requestId: 'second-context' })).status, 'task-busy')
  assert.equal(store.getGroup('g').messages.filter((message) => message.sourceKind === 'web').length, 1)
})

test('Task通知并发替换同一旧回复时只有首个Outbox接受，pending意图也阻止Topic决策', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const first = store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-a-result', text: '任务甲订正', replacesOutboundIds: ['old-reply'] })
  const second = store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-b-result', text: '任务乙订正', replacesOutboundIds: ['old-reply'] })
  assert.equal((await first).outbox.length, 1)
  assert.equal((await second).status, 'reply-busy')
  const candidate = decision('topic-replacement', a, 1, { decision: { actions: [], replyReview: { replaceOutboundIds: ['old-reply'] } } })
  assert.equal((await store.acceptTopicDecision(candidate)).status, 'reply-busy')
  assert.equal(store.getGroup('g').outbox.length, 1)
  const duplicate = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-a-result', text: '任务甲订正', replacesOutboundIds: ['old-reply'] })
  assert.equal(duplicate.outbox.length, 1)
})

test('已接受Topic意图阻止其他通知抢占回复，但自身Outbox允许落盘', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await store.acceptTopicDecision(decision('reserved', a, 1, { decision: { actions: [], replyReview: { replaceOutboundIds: ['old'] } } }))
  const other = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-result', text: '结果', replacesOutboundIds: ['old'] })
  assert.equal(other.status, 'reply-busy')
  const own = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'topic-decision:reserved', decisionId: 'reserved', text: '订正', replacesOutboundIds: ['old'] })
  assert.equal(own.outbox.length, 1)
})

test('Topic已完成但Outbox未送达时退订拒绝，确认送达后才允许删除', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await store.acceptTopicDecision(decision('done', a, 1))
  await store.completeTopicDecision({ groupId: 'g', topicId: a, decisionId: 'done' })
  const group = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'done', text: '独立通知' })
  await assert.rejects(store.removeGroup({ groupId: 'g' }), /group_has_pending_outbox/)
  assert.equal(store.getGroup('g').outbox.length, 1)
  await store.acknowledge({ groupId: 'g', outboundId: group.outbox[0].outboundId, deliveredMessageId: 'confirmed' })
  assert.equal((await store.removeGroup({ groupId: 'g' })).removed, true)
})

test('新Outbox结果指纹通过真实domain schema保存且重开可查询', async () => {
  const { store, snapshot } = await setup()
  await store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-result:example', text: '结果', resultFingerprint: 'canonical-result-fingerprint', taskIds: ['task-example'] })
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  assert.equal(reopened.getGroup('g').outbox[0].resultFingerprint, 'canonical-result-fingerprint')
  assert.deepEqual(reopened.getGroup('g').outbox[0].taskIds, ['task-example'])
})
