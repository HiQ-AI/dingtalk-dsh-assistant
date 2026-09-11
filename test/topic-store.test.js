import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { stagePlanFor } from '../packages/dingtalk-dsh-assistant/task-input-revision.js'

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

test('明确发送阻塞重启保留，普通错误不清阻塞，真实晚回执清阻塞但保留替换终态', async () => {
  const { store, snapshot } = await setup()
  for (const id of ['blocked', 'replaced']) {
    await store.appendOutbox({ groupId: 'g', outboundId: id, sourceMessageId: id, text: id })
    await store.recordOutboundDeliveryAttempt({ groupId: 'g', outboundId: id, blocked: true, reason: 'send_failed', error: 'server rejected' })
    await store.recordOutboundDeliveryAttempt({ groupId: 'g', outboundId: id, error: 'read failed' })
    assert.ok(store.getGroup('g').outbox.find(item => item.outboundId === id).deliveryBlockedAt)
  }
  await store.appendOutbox({ groupId: 'g', outboundId: 'correction', sourceMessageId: 'correction', text: '纠正', replacesOutboundIds: ['replaced'] })
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  for (const id of ['blocked', 'replaced']) {
    const before = reopened.getGroup('g').outbox.find(item => item.outboundId === id)
    assert.ok(before.deliveryBlockedAt)
    assert.equal(before.status, id === 'replaced' ? 'superseded' : 'pending')
    await reopened.acknowledge({ groupId: 'g', outboundId: id, deliveredMessageId: `late-${id}` })
    const after = reopened.getGroup('g').outbox.find(item => item.outboundId === id)
    assert.equal(after.deliveryBlockedAt, undefined)
    assert.equal(after.status, id === 'replaced' ? 'superseded' : 'sent')
    assert.equal(after.deliveredMessageId, `late-${id}`)
  }
  await reopened.close()
})

test('替换图在决策接纳前拒绝未知目标，重复协调不产生持久写入', async () => {
  const snapshot = { tables: {}, global: null }
  let writes = 0
  const store = await openResidentStore(facility(snapshot, () => { writes += 1 }))
  await store.subscribe({ groupId: 'g' }); await ingest(store, 'a')
  const topicId = (await route(store, 'r', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const before = structuredClone(store.getGroup('g'))
  await assert.rejects(store.acceptTopicDecision(decision('invalid-replacement', topicId, 1, { decision: { actions: [], replyReview: { replaceOutboundIds: ['missing'] } } })), /replacement_unknown/)
  assert.deepEqual(store.getGroup('g'), before)
  await store.appendOutbox({ groupId: 'g', outboundId: 'a', sourceMessageId: 'a', text: '旧' })
  await store.appendOutbox({ groupId: 'g', outboundId: 'b', sourceMessageId: 'b', text: '新', replacesOutboundIds: ['a'] })
  const beforeWrites = writes
  await store.reconcileOutboxReplacements({ groupId: 'g' })
  await store.reconcileOutboxReplacements({ groupId: 'g' })
  assert.equal(writes, beforeWrites)
  await store.close()
})

test('替换pending原子停止旧发送，发送领取与替换串行且晚回执保留终态', async () => {
  const { store, snapshot } = await setup()
  const append = (id, replacesOutboundIds = []) => store.appendOutbox({ groupId: 'g', outboundId: id, sourceMessageId: id, text: id, replacesOutboundIds })
  await append('a')
  assert.equal(await store.beginOutboundSend({ groupId: 'g', outboundId: 'a' }), true)
  await append('b', ['a'])
  await append('c', ['b'])
  assert.equal(await store.beginOutboundSend({ groupId: 'g', outboundId: 'a' }), false)
  assert.equal(await store.beginOutboundSend({ groupId: 'g', outboundId: 'b' }), false)
  await store.acknowledge({ groupId: 'g', outboundId: 'a', deliveredMessageId: 'late-a' })
  await store.recordOutboundDeliveryAttempt({ groupId: 'g', outboundId: 'a', error: 'late-error' })
  const a = store.getGroup('g').outbox.find(item => item.outboundId === 'a')
  assert.equal(a.status, 'superseded'); assert.equal(a.deliveredMessageId, 'late-a'); assert.ok(a.sendStartedAt)
  assert.equal(a.supersededByOutboundId, 'b')
  assert.equal(store.getGroup('g').outbox.find(item => item.outboundId === 'b').supersededByOutboundId, 'c')
  const before = structuredClone(store.getGroup('g'))
  await assert.rejects(append('unknown', ['missing']), /replacement_unknown/)
  await assert.rejects(append('self', ['self']), /replacement_cycle/)
  assert.deepEqual(store.getGroup('g'), before)
  await store.updateOutboundRecall({ groupId: 'g', outboundId: 'a', status: 'requested' })
  await store.updateOutboundRecall({ groupId: 'g', outboundId: 'a', status: 'failed', error: '失败', retryAt: '2026-09-12T00:00:00Z' })
  await store.close()
  const reopened = await openResidentStore(facility(snapshot))
  const restored = reopened.getGroup('g').outbox.find(item => item.outboundId === 'a')
  assert.equal(restored.status, 'superseded'); assert.equal(restored.recallAttemptCount, 1); assert.ok(restored.recallRetryAt)
  await reopened.updateOutboundRecall({ groupId: 'g', outboundId: 'a', status: 'recalled' })
  assert.equal(reopened.getGroup('g').outbox.find(item => item.outboundId === 'a').recallRetryAt, undefined)
  await reopened.close()
})

test('历史替换图先完整校验，拒绝环与分叉且保留已有有效链', async () => {
  for (const mode of ['chain', 'cycle', 'fork']) {
    const { store, snapshot } = await setup()
    for (const id of ['a', 'b', 'c']) await store.appendOutbox({ groupId: 'g', outboundId: id, sourceMessageId: id, text: id })
    await store.close()
    const [a, b, c] = snapshot.tables.groups.g.outbox
    b.replacesOutboundIds = ['a']; c.replacesOutboundIds = mode === 'fork' ? ['a'] : ['b', 'a']
    if (mode === 'cycle') a.replacesOutboundIds = ['c']
    if (mode === 'chain') a.supersededByOutboundId = 'b'
    const reopened = await openResidentStore(facility(snapshot))
    const before = structuredClone(reopened.getGroup('g'))
    if (mode === 'chain') {
      await reopened.reconcileOutboxReplacements({ groupId: 'g' })
      assert.deepEqual(reopened.getGroup('g').outbox.map(item => [item.status, item.supersededByOutboundId]), [['superseded', 'b'], ['superseded', 'c'], ['pending', undefined]])
      const reconciled = structuredClone(reopened.getGroup('g'))
      await reopened.reconcileOutboxReplacements({ groupId: 'g' })
      assert.deepEqual(reopened.getGroup('g'), reconciled)
    } else {
      await assert.rejects(reopened.reconcileOutboxReplacements({ groupId: 'g' }), new RegExp(`replacement_${mode}`))
      assert.deepEqual(reopened.getGroup('g'), before)
    }
    await reopened.close()
  }
})

async function revisionFixture() {
  const fixture = await setup()
  await ingest(fixture.store, 'revision-source')
  const topicId = (await route(fixture.store, 'revision-route', [['revision-source', { newTopicKey: 'a', title: '阶段修订' }]])).topicIdsByKey.a
  const { task } = await fixture.store.createTask({ groupId: 'g', topicRefs: [{ topicId, revision: 1 }], title: '阶段任务', objective: '验证修订', acceptanceCriteria: ['可核验'], stageTasks: ['排查', '验证'] })
  const action = { kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: '重新验证', topicRefs: task.topicRefs,
    progressImpact: 'replan', impactEvidence: { basisMessageIds: ['revision-source'], reason: '新增证据推翻阶段结论', affectedStageIds: [stagePlanFor(task, task.stageTasks)[0].stageId] } }
  const input = decision('revision-decision', topicId, 1, { decision: { actions: [action], basisMessageIds: ['revision-source'], reply: '重新验证' }, expectedTaskVersions: [{ taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence }] })
  return { ...fixture, topicId, task, action, input }
}

test('阶段修订在原子接纳前拒绝未知ID，修正同请求可接受；Web遵循相同校验', async () => {
  for (const web of [false, true]) {
    const { store, task, action, input } = await revisionFixture()
    const bad = { ...action, impactEvidence: { ...action.impactEvidence, affectedStageIds: ['不存在的阶段'] } }
    const submit = candidate => web ? store.submitWebTaskInput({ groupId: 'g', requestId: 'web-revision', text: '重新验证', topicRefs: task.topicRefs, action: candidate })
      : store.acceptTopicDecision({ ...input, decision: { ...input.decision, actions: [candidate] } })
    const before = structuredClone(store.getGroup('g'))
    await assert.rejects(submit(bad), /task_revision_stage_invalid/)
    assert.deepEqual(store.getGroup('g'), before)
    assert.deepEqual(store.getTask(task.taskId), task)
    assert.equal((await submit(action)).status, 'accepted')
    await store.close()
  }
})

test('新建与重开都拒绝重复阶段，不能先接受后破坏主叶上下文', async () => {
  const { store, task, input } = await revisionFixture()
  for (const kind of ['new-task', 'task-reopen']) {
    if (kind === 'task-reopen') await store.updateTask(task.taskId, current => ({ ...current, state: 'completed' }))
    const before = structuredClone(store.getGroup('g'))
    const candidate = kind === 'new-task'
      ? { kind, title: '新任务', objective: '验证阶段', acceptanceCriteria: ['可核验'], stageTasks: ['验证', ' 验证 '], topicRefs: task.topicRefs }
      : { kind, taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: '重开', stageTasks: ['验证', ' 验证 '], topicRefs: task.topicRefs }
    await assert.rejects(store.acceptTopicDecision({ ...input, expectedTaskVersions: kind === 'new-task' ? [] : input.expectedTaskVersions, decision: { ...input.decision, actions: [candidate] } }), /task_revision_stage_titles_invalid/)
    await assert.rejects(store.submitWebTaskInput({ groupId: 'g', requestId: `invalid-${kind}`, text: '重复阶段', action: candidate, topicRefs: task.topicRefs }), /task_revision_stage_titles_invalid/)
    assert.deepEqual(store.getGroup('g'), before)
  }
  await store.close()
})

test('同group串行队列使用最新Task阶段与版本校验，不接纳排队前的旧计划', async () => {
  const { store, task, input } = await revisionFixture()
  const change = store.updateTask(task.taskId, current => ({ ...current, stageTasks: ['新阶段'], stagePlan: undefined }))
  const accepted = store.acceptTopicDecision(input)
  await change
  await assert.rejects(accepted, /task_revision_stage_invalid/)
  assert.equal(store.getGroup('g').taskReservations.length, 0)
  const versionChange = store.updateTask(task.taskId, current => ({ ...current, inputVersion: current.inputVersion + 1 }))
  const stale = store.acceptTopicDecision({ ...input, decision: { ...input.decision, actions: [{ ...input.decision.actions[0], impactEvidence: undefined, progressImpact: 'preserve' }] } })
  await versionChange
  assert.equal((await stale).status, 'task-stale')
  await store.close()
})

test('接纳与执行共用参数规范化，空数组默认值可用而trim后重复阶段在接纳前拒绝', async () => {
  const { store, task, input, action } = await revisionFixture()
  const before = structuredClone(store.getGroup('g'))
  for (const patch of [
    { stageTasks: [' 排查 ', '排查'] },
    { impactEvidence: { ...action.impactEvidence, basisMessageIds: ['foreign-source'] } },
    { progressImpact: 'replan', impactEvidence: undefined },
  ]) {
    await assert.rejects(store.acceptTopicDecision({ ...input, decision: { ...input.decision, actions: [{ ...action, ...patch }] } }), /task_revision_(stage_titles_invalid|basis_invalid|impact_required)/)
    assert.deepEqual(store.getGroup('g'), before)
  }
  const candidate = { ...action, stageTasks: [], acceptanceCriteria: [] }
  assert.equal((await store.acceptTopicDecision({ ...input, decision: { ...input.decision, actions: [candidate] } })).status, 'accepted')
  assert.equal(store.getTask(task.taskId).inputVersion, task.inputVersion)
  await store.close()
})

test('拒绝旧决策的持久写入失败时不释放预约，不把内存结果当已恢复', async () => {
  const { store, snapshot, topicId, input } = await revisionFixture()
  await store.acceptTopicDecision(input); await store.close()
  snapshot.tables.groups.g.topics.find(topic => topic.topicId === topicId).decisions[0].decision.actions[0].impactEvidence.affectedStageIds = ['bad-id']
  let fail = false
  const reopened = await openResidentStore(facility(snapshot, table => { if (fail && table === 'groups') throw new Error('durable-failure') }))
  const before = structuredClone(reopened.getGroup('g'))
  const persistedBefore = structuredClone(snapshot.tables.groups.g)
  fail = true
  await assert.rejects(reopened.rejectInvalidTopicDecision({ groupId: 'g', topicId, decisionId: input.decisionId }), /durable-failure/)
  assert.deepEqual(reopened.getGroup('g'), before)
  assert.deepEqual(snapshot.tables.groups.g, persistedBefore)
  fail = false
  assert.equal(await reopened.rejectInvalidTopicDecision({ groupId: 'g', topicId, decisionId: input.decisionId }), true)
  await reopened.close()
})

test('重开旧坏决策仅释放自己的预约，保留输入、Task和Outbox且rejected不可复活', async () => {
  const { store, snapshot, topicId, task, input } = await revisionFixture()
  await store.acceptTopicDecision(input)
  await store.appendOutbox({ groupId: 'g', sourceMessageId: 'old-confirmation', text: '已经确认的历史回复', decisionId: input.decisionId })
  await store.close()
  const group = snapshot.tables.groups.g
  const record = group.topics.find(topic => topic.topicId === topicId).decisions[0]
  record.status = 'failed'
  record.decision.actions[0].impactEvidence.affectedStageIds = ['历史错误阶段']
  group.taskReservations.push({ taskId: 'another-task', inputVersion: 1, runSequence: 1, decisionId: 'another-decision', topicId })
  const reopened = await openResidentStore(facility(snapshot))
  const before = structuredClone(reopened.getGroup('g'))
  const target = { groupId: 'g', topicId, decisionId: input.decisionId }
  assert.equal(await reopened.rejectInvalidTopicDecision(target), true)
  assert.deepEqual(reopened.getTask(task.taskId), task)
  assert.equal(reopened.getTopic('g', topicId).processedRevision, 0)
  assert.deepEqual(reopened.getGroup('g').messages, before.messages)
  assert.deepEqual(reopened.getGroup('g').outbox, before.outbox)
  assert.deepEqual(reopened.getGroup('g').taskReservations, before.taskReservations.filter(item => item.decisionId !== input.decisionId))
  assert.equal((await reopened.updateTopicDecision({ ...target, patch: { status: 'applying', operations: [] } })).status, 'rejected')
  await assert.rejects(reopened.completeTopicDecision(target), /topic_decision_rejected/)
  assert.equal(reopened.getTopic('g', topicId).processedRevision, 0)
  await reopened.close()
  const again = await openResidentStore(facility(snapshot))
  assert.equal(again.getTopic('g', topicId).decisions[0].status, 'rejected')
  await again.close()
})

test('旧坏决策出现已执行账本、部分应用、取消副作用或版本变化时不能退回', async () => {
  for (const scenario of ['task-applied', 'operation-applied', 'cancel-mixed', 'version-changed']) {
    const { store, snapshot, topicId, task, input } = await revisionFixture()
    await store.acceptTopicDecision(input)
    await store.close()
    const record = snapshot.tables.groups.g.topics.find(topic => topic.topicId === topicId).decisions[0]
    record.status = 'failed'
    record.decision.actions[0].impactEvidence.affectedStageIds = ['历史错误阶段']
    const storedTask = snapshot.tables.tasks[task.taskId]
    if (scenario === 'task-applied') storedTask.appliedOperations.push(record.operations[0].operationId)
    if (scenario === 'operation-applied') record.operations[0].status = 'applied'
    if (scenario === 'cancel-mixed') {
      record.decision.actions.push({ kind: 'task-cancel', taskId: 'another-task', reason: '停止' })
      record.operations.push({ operationId: 'cancel-operation', actionIndex: 1, taskId: 'another-task', status: 'pending' })
    }
    if (scenario === 'version-changed') storedTask.inputVersion += 1
    const reopened = await openResidentStore(facility(snapshot))
    const before = structuredClone(reopened.getGroup('g'))
    assert.equal(await reopened.rejectInvalidTopicDecision({ groupId: 'g', topicId, decisionId: input.decisionId }), false, scenario)
    assert.deepEqual(reopened.getGroup('g'), before, scenario)
    await reopened.close()
  }
})

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
  const input = decision('durable', a, 1, { decision: { actions: [{ kind: 'new-task', title: 'A', objective: '执行A', acceptanceCriteria: ['结果可验证'] }] } })
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
  await store.appendOutbox({ groupId: 'g', outboundId: 'outbound-prior', sourceMessageId: 'prior', text: '旧回复' })
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
  await store.appendOutbox({ groupId: 'g', outboundId: 'old-reply', sourceMessageId: 'old-reply', text: '旧回复' })
  await store.acknowledge({ groupId: 'g', outboundId: 'old-reply', deliveredMessageId: 'old-message' })
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  const first = store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-a-result', text: '任务甲订正', replacesOutboundIds: ['old-reply'] })
  const second = store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-b-result', text: '任务乙订正', replacesOutboundIds: ['old-reply'] })
  assert.equal((await first).outbox.length, 2)
  assert.equal((await second).status, 'reply-busy')
  const candidate = decision('topic-replacement', a, 1, { decision: { actions: [], replyReview: { replaceOutboundIds: ['old-reply'] } } })
  assert.equal((await store.acceptTopicDecision(candidate)).status, 'reply-busy')
  assert.equal(store.getGroup('g').outbox.length, 2)
  const duplicate = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-a-result', text: '任务甲订正', replacesOutboundIds: ['old-reply'] })
  assert.equal(duplicate.outbox.length, 2)
})

test('已接受Topic意图阻止其他通知抢占回复，但自身Outbox允许落盘', async () => {
  const { store } = await setup(); await ingest(store, 'a')
  await store.appendOutbox({ groupId: 'g', outboundId: 'old', sourceMessageId: 'old', text: '旧回复' })
  await store.acknowledge({ groupId: 'g', outboundId: 'old', deliveredMessageId: 'old-message' })
  const a = (await route(store, 'r1', [['a', { newTopicKey: 'a', title: 'A' }]])).topicIdsByKey.a
  await store.acceptTopicDecision(decision('reserved', a, 1, { decision: { actions: [], replyReview: { replaceOutboundIds: ['old'] } } }))
  const other = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'task-result', text: '结果', replacesOutboundIds: ['old'] })
  assert.equal(other.status, 'reply-busy')
  const own = await store.appendOutbox({ groupId: 'g', sourceMessageId: 'topic-decision:reserved', decisionId: 'reserved', text: '订正', replacesOutboundIds: ['old'] })
  assert.equal(own.outbox.length, 2)
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
