import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'

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
  if (!store.getGroup('g')) await store.subscribe({ groupId: 'g' })
  await store.setAgentNames(['助理'])
  const sent = [], errors = [], tools = new Map(), applications = []
  const agent = { steer(message) { sent.push(message.content[0].text) }, whenIdle: options.whenIdle ?? (() => new Promise(() => {})) }
  const coordinator = createTopicCoordinator({
    store, getAgent: () => agent, assertSession(exec, groupId) { if (exec?.groupId !== groupId) throw new Error('wrong_session') },
    serializeTasks: (fn) => fn(), isClosing: options.isClosing ?? (() => false), retryDelayMs: options.retryDelayMs ?? 60_000,
    reviewCandidates: options.reviewCandidates ?? (() => []),
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
  await h.store.ingest({ groupId: 'g', messageId, text: messageId, senderOpenDingTalkId: 'od-a', occurredAt: '2026-09-07T00:00:00Z', ...extra })
}
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

test('消息仅在全部关联 Topic 完成后收口为已投递', async (t) => {
  const h = await setup(t)
  await ingest(h, 'shared')
  await h.coordinator.schedule('g')
  const routeRequest = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{
    messageId: 'shared', messageVersion: 1, topics: [{ newTopicKey: 'a', title: 'A' }, { newTopicKey: 'b', title: 'B' }],
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
async function taskFixture(h) {
  await ingest(h, 'a1')
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

test('内部检查点必须结构化确认，不能携带相互矛盾的 guidance', async (t) => {
  const h = await setup(t), { task } = await taskFixture(h)
  const promise = h.coordinator.requestReview('checkpoint', task, { summary: '计划完成' })
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
  await assert.rejects(h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: 'ok', guidance: '改计划' } }), /task_review_guidance_invalid/)
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'guidance', reason: '范围遗漏', guidance: '补异常分支' } })).status, 'accepted')
  assert.deepEqual(await promise, { decision: 'guidance', reason: '范围遗漏', guidance: '补异常分支' })
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
  await assert.rejects(h.call('group_reply_submit', args), /topic_reply_request_unknown/)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
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
  const routed = await h.call('group_topic_route_submit', { requestId: routeRequest.requestId, routes: [{ messageId: 'shared', messageVersion: 1, topics: [{ newTopicKey: 'a', title: 'A' }, { newTopicKey: 'b', title: 'B' }] }] })
  const [a, b] = routed.pendingDecisions
  assert.equal(a.effectOwnerTopicIds.shared, a.topicId)
  assert.deepEqual(a.ownedDeltaMessageIds, ['shared'])
  assert.deepEqual(b.ownedDeltaMessageIds, [])
  const action = (request) => ({ kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] })
  await assert.rejects(h.call('group_decision_submit', submission(b, { actions: [action(b)], reply: '收到' })), /topic_effect_owner_required/)
  await assert.rejects(h.call('group_decision_submit', submission(b, { reply: '收到', replyReview: { kind: 'confirmation' } })), /topic_effect_owner_required/)
  assert.equal((await h.call('group_decision_submit', submission(b, { reply: 'B 的独立分析结果', replyReview: { kind: 'substantive' } }))).status, 'accepted')
  assert.equal((await h.call('group_decision_submit', submission(a, { actions: [action(a)], reply: '收到', replyReview: { kind: 'confirmation' } }))).status, 'accepted')
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
  await assert.rejects(h.call('group_topic_route_review', { messageIds: ['a1'], reason: '' }))
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
  await assert.rejects(h.call('group_decision_submit', submission(request, { actions })))
  assert.equal(h.store.getTopic('g', request.topicId).decisions.length, 0)
  h.store.appendOutbox = async () => ({ status: 'reply-busy' })
  assert.equal((await h.call('group_decision_submit', submission(request, { actions, reply: '确认核验' }))).status, 'accepted')
  await h.coordinator.drain('g')
  assert.equal(h.store.listTasks().length, 0)
  assert.equal(h.applications.length, 0)
  assert.equal(h.store.getTopic('g', request.topicId).decisions[0].error, 'topic_outbox_reply-busy')
})

test('模型停稳但未提交归类会定时生成新请求，旧请求不能迟到提交', async (t) => {
  let idleCalls = 0, timedOut
  const timeout = new Promise((resolve) => { timedOut = resolve })
  const h = await setup(t, { retryDelayMs: 5, whenIdle: () => ++idleCalls === 1 ? Promise.resolve() : new Promise(() => {}), onError: timedOut })
  await ingest(h, 'unsubmitted'); await h.coordinator.schedule('g')
  const original = h.envelope('[GROUP_TOPIC_ROUTE]')
  // timer.unref 不应由测试进程存活决定，保留一个有界watchdog等待真实超时事件。
  let watchdog
  try {
    await Promise.race([timeout, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('route_retry_timeout')), 1000) })])
  } finally { clearTimeout(watchdog) }
  await h.coordinator.schedule('g')
  const current = h.envelope('[GROUP_TOPIC_ROUTE]')
  assert.notEqual(current.requestId, original.requestId)
  const routes = [{ messageId: 'unsubmitted', messageVersion: 1, topics: [{ newTopicKey: 'retry', title: '重试话题' }] }]
  await assert.rejects(h.call('group_topic_route_submit', { requestId: original.requestId, routes }), /topic_route_request_unknown/)
  assert.equal((await h.call('group_topic_route_submit', { requestId: current.requestId, routes })).status, 'accepted')
  assert.equal(h.store.listTopics('g').length, 1)
})
