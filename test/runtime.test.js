import test from 'node:test'
import { assert, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, execFileSync, tmpdir, join, pathToFileURL, createHash, after, DomainFacility, assertSupportedJsonSchema, buildTaskAssociationIndex, openResidentRuntime, residentSessionId, openResidentStore, resolveTopicMessages, taskSessionId, stagePlanFor, taskReports, taskPlanFixture, stageOutputFixture, fingerprint, stableId, startDwsBridge, agentWorkspace, replacementWorkspace, memoryFacility, immediate, until, setup, ingest, route, decide, createTask, workflowAssessment, statusLlm, statusReply, taskWithWorkflow, inputVersion, directLeafCall, prepareFixturePlan, rawLeafCall, leafCall, blockedItem, checkpoint, fullCheckpoints, completeResult, persistedCompletedTask, submitNotification } from './fixtures/runtime-mixed.js'

test('Resident 完整提示词保留群职责与动态别名，不叠加登录人特殊禁令', async (t) => {
  const h = await setup(t)
  const responsibility = '负责编辑器；明确要求助理或当前登录人处理时承接任务。'
  await h.store.updateGroup({ groupId: 'g', responsibility })
  const prompt = () => h.resident().sections.map((section) => typeof section.text === 'function' ? section.text() : section.text).join('\n')
  await h.store.setAgentNames(['助理', '当前登录人'])
  assert.ok(prompt().includes(responsibility))
  assert.ok(prompt().includes('当前 Agent 名称/别名：["助理","当前登录人"]'))
  assert.doesNotMatch(prompt(), /DWS 登录人/u, '完整协议中不能残留准入或静默的登录人特殊规则')
  await h.store.setAgentNames(['助理'])
  assert.ok(prompt().includes('当前 Agent 名称/别名：["助理"]'), '配置变更应在下一次提示词计算中生效')
})

test('运行时协调请求独立日志与工具角色绑定；群主和旧请求均不能越权提交', async t => {
  const h = await setup(t, { groups: ['g', 'b'] })
  await ingest(h, 'isolated')
  await until(() => h.envelope('[GROUP_TOPIC_ROUTE]'))
  const routing = h.envelope('[GROUP_TOPIC_ROUTE]'), owner = h.owner(routing.requestId)
  const create = h.calls.find(call => call.sessionId === owner.agent.session.id)
  assert.equal(create.input.meta.parentSession, residentSessionId('g'))
  assert.equal(create.input.seed, undefined, '新请求不继承群主历史')
  assert.equal(owner.agent.session.snapshotEvents().find(event => event.type === 'dingtalk/coordination').data.requestId, routing.requestId)
  const allow = owner.restrictions.find(rule => rule.allow)?.allow
  assert.ok(owner.tools.has('group_topic_route_submit'))
  assert.ok(owner.tools.has('group_resource_get'))
  assert.ok(!allow.includes('pwsh'))
  assert.equal(owner.tools.has('group_decision_submit'), false)
  assert.equal(owner.guards[0]({ name: 'pwsh' }), 'coordination_tool_outside_role')
  await assert.rejects(() => h.resident().tools.get('group_topic_route_submit').execute({ requestId: routing.requestId, routes: [] }, { agent: h.resident().agent }), /request_session_required/)
  await assert.rejects(() => owner.tools.get('group_topic_route_submit').execute({ requestId: routing.requestId, routes: [] }, { agent: h.resident('b').agent }), /wrong_request/)
  const result = await route(h)
  const decision = result.pendingDecisions[0], next = h.owner(decision.requestId)
  assert.notEqual(owner.agent.session.id, next.agent.session.id)
  await assert.rejects(() => next.tools.get('group_topic_route_review').execute({ messageIds: ['unrelated'], reason: '不能越界纠正' }, { agent: next.agent }), /coordination_message_outside_request/)
  assert.equal(h.resident().sent.filter(message => message.content[0]?.text.startsWith('[GROUP_TOPIC_')).length, 0)
  await assert.rejects(() => next.tools.get('group_decision_submit').execute({ requestId: decision.requestId }, { agent: owner.agent }), /wrong_request/)
  await decide(h, decision)
  await until(() => h.disposed.includes(next.agent.session.id))
  assert.equal(h.store.listTasks().length, 0)
})

test('重启仅为未接纳协调请求建新会话，已接纳业务效果不重放', async t => {
  const first = await setup(t)
  await ingest(first, 'restart-request')
  await until(() => first.envelope('[GROUP_TOPIC_ROUTE]'))
  const old = first.envelope('[GROUP_TOPIC_ROUTE]'), oldOwner = first.owner(old.requestId)
  await first.runtime.close()
  const second = await setup(t, { snapshot: first.snapshot })
  await second.runtime.recoverInterruptedDecisions()
  await until(() => second.envelope('[GROUP_TOPIC_ROUTE]'))
  const restored = second.envelope('[GROUP_TOPIC_ROUTE]')
  assert.equal(restored.requestId, old.requestId)
  assert.notEqual(second.owner(restored.requestId).agent.session.id, oldOwner.agent.session.id)
  const decision = (await route(second)).pendingDecisions[0]
  await decide(second, decision, { reply: '一次通知。' })
  await second.runtime.close()
  const third = await setup(t, { snapshot: second.snapshot })
  await third.runtime.recoverInterruptedDecisions()
  assert.equal(third.store.getGroup('g').outbox.length, 1)
  assert.equal(third.calls.filter(call => call.sessionId.startsWith('session-coordination-')).length, 0)
})

test('别名修复请求创建任务，后续无称呼的图片补充续接同一叶子', async (t) => {
  const h = await setup(t, { attachments: { async saveImages() { return [{ id: 'database-image', mediaType: 'image/png' }] } } })
  await h.store.setAgentNames(['助理', '当前登录人'])
  await ingest(h, 'repair-request', { text: '@当前登录人(当前登录人) 选择数据集时切换数据库列表未更新，需要修复；后续步骤禁用数据库切换。' })
  const first = (await route(h)).pendingDecisions[0]
  assert.equal((await decide(h, first, { actions: [{ kind: 'new-task', title: '数据库切换修复', objective: '修复首步切库刷新并禁用后续步骤切库', acceptanceCriteria: ['首步切库刷新列表，后续步骤不可切库'], topicRefs: [{ topicId: first.topicId, revision: first.revision }] }], reply: '收到，我来处理。' })).status, 'accepted')
  await until(() => h.store.listTasks()[0].state === 'running' && h.store.listTasks()[0].dispatchedInputVersion === 1)
  const task = h.store.listTasks()[0]
  assert.equal(task.state, 'running')
  h.idle.set(task.childSessionId, Promise.resolve())
  await ingest(h, 'repair-image', { text: '[图片消息] 问题页面截图', images: [{ data: 'base64', mediaType: 'image/png' }] })
  const second = (await route(h, { 'repair-image': first.topicId })).pendingDecisions[0]
  const review = await h.call('group_reply_review_get', { requestIds: [second.requestId] })
  assert.equal((await decide(h, second, { basisMessageIds: ['repair-image'], actions: [{ kind: 'task-context', taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, context: '补充问题页面截图', progressImpact: 'preserve', topicRefs: [{ topicId: second.topicId, revision: second.revision }] }], reply: '收到截图，会结合处理。', replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })).status, 'accepted')
  const updated = h.store.getTask(task.taskId)
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(updated.childSessionId, task.childSessionId)
  assert.equal(updated.inputVersion, task.inputVersion + 1)
  assert.equal(updated.runSequence, task.runSequence)
  assert.deepEqual(updated.topicRefs, [{ topicId: second.topicId, revision: second.revision }])
  await until(() => h.store.getTask(task.taskId).dispatchedInputVersion === updated.inputVersion)
  assert.ok(JSON.stringify(h.handles.get(task.childSessionId).sent).includes('database-image'))
})

test('入站持久接收立即返回，模型尚未提交时也能接收后续消息', async (t) => {
  const h = await setup(t)
  const first = await ingest(h, 'a'), second = await ingest(h, 'b')
  assert.equal(first.accepted, true); assert.equal(second.accepted, true)
  assert.equal(h.store.getGroup('g').messages.length, 2)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  await until(() => Boolean(h.envelope('[GROUP_TOPIC_ROUTE]')))
  assert.ok(h.envelope('[GROUP_TOPIC_ROUTE]'))
})

test('重复入站幂等，Topic 提交成功后只生成一条可靠回复', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); assert.equal((await ingest(h, 'a')).duplicate, true)
  const request = (await route(h)).pendingDecisions[0]
  assert.equal((await decide(h, request, { reply: '已核验。' })).status, 'accepted')
  assert.equal(h.store.getGroup('g').messages.length, 1)
  assert.deepEqual(h.store.getGroup('g').outbox.map((item) => item.text), ['已核验。'])
  const retired = h.owner(request.requestId)
  await assert.rejects(() => retired.tools.get('group_decision_submit').execute({ requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { actions: [], reason: '重复' } }, { agent: retired.agent }), /coordination_tool_wrong_request/)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('普通 assistant 文本或 turn 结束不能替代 Topic 结构化提交', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]
  h.resident().agent.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '我处理好了' }] } })
  h.resident().agent.session.append('turn/end', { status: 'success' })
  await h.runtime.drainTopicOperations('g')
  assert.equal(h.store.getTopic('g', request.topicId).processedRevision, 0)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('注册工具符合 DSH JSON Schema，Resident 只能通过 Topic 决策建任务', async (t) => {
  const h = await setup(t)
  const names = [...h.resident().tools.keys()]
  for (const name of ['group_topic_route_submit', 'group_topic_context_get', 'group_topic_list', 'group_decision_submit', 'group_task_review_submit', 'group_task_context_get']) assert.ok(names.includes(name), name)
  for (const name of ['group_task_create', 'group_task_context_append', 'group_task_reopen']) assert.equal(names.includes(name), false, '模型不能伪装 Web 输入绕过归属和授权')
  for (const tool of h.resident().tools.values()) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema) }
  assert.deepEqual(h.resident().restrictions, [{ deny: ['get_goal', 'create_goal', 'update_goal'] }])
  await assert.rejects(h.call('group_topic_list', {}, 'g', { session: { id: 'foreign' } }), /resident_tool_wrong_session/)
})

test('来源附件先持久保存，归类输入可恢复相同 imageRefs', async (t) => {
  let saved
  const h = await setup(t, { attachments: { async saveImages(images) { saved = images; return [{ id: 'image-a', mediaType: 'image/png' }] } } })
  await ingest(h, 'a', { images: [{ data: 'base64', mediaType: 'image/png', name: '说明图' }] })
  assert.equal(saved[0].name, '说明图')
  assert.equal(h.store.getGroup('g').messages[0].imageRefs[0].id, 'image-a')
  await route(h)
  assert.equal(h.envelope('[GROUP_TOPIC_DECISION]').messages[0].imageRefs[0].id, 'image-a')
})

test('附件缺失硬拦截任务，仍发送明确缺失反馈', async (t) => {
  const h = await setup(t); await ingest(h, 'a', { mediaUnavailable: ['图片获取失败'] })
  const request = (await route(h)).pendingDecisions[0]
  const action = { kind: 'new-task', title: '核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: request.topicId, revision: 1 }] }
  assert.equal((await decide(h, request, { actions: [action], reply: '开始' })).status, 'accepted')
  assert.equal(h.store.listTasks().length, 0)
  assert.match(h.store.getGroup('g').outbox[0].text, /图片获取失败/)
})

test('多群请求隔离，A 等待归类不阻止 B 完成', async (t) => {
  const h = await setup(t, { groups: ['g', 'b'] })
  await ingest(h, 'a'); await ingest(h, 'b', { groupId: 'b' })
  const b = (await route(h, {}, 'b')).pendingDecisions[0]
  assert.equal((await decide(h, b, { reply: 'B 完成' }, 'b')).status, 'accepted')
  assert.equal(h.store.getGroup('b').outbox.length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  assert.equal(h.store.getGroup('g').messages[0].routingStatus, 'pending')
})

test('Outbox 已落盘时监听器失败不会回滚已接受 Topic 决策', async (t) => {
  const h = await setup(t)
  h.runtime.onOutboxAppended(() => { throw new Error('listener_failure') })
  await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  assert.equal((await decide(h, request, { reply: '回复已可靠保存' })).status, 'accepted')
  await immediate()
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.store.getTopic('g', request.topicId).processedRevision, 1)
  assert.ok(h.runtime.listRecoveryIssues().some((issue) => issue.error.includes('listener_failure')))
})

test('历史导入只发送 Topic 索引，不重放历史消息正文或指令', async (t) => {
  const h = await setup(t); await ingest(h, 'a')
  const request = (await route(h)).pendingDecisions[0]; await decide(h, request)
  const result = await h.runtime.hydrateGroupHistory({ groupId: 'g' })
  assert.equal(result.imported, 1)
  const text = h.messages().at(-1).content[0].text
  assert.match(text, /历史 Topic 索引/)
  assert.doesNotMatch(text, /@助理 a/)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
})

test('恢复失败保留原 Resident Session，其他群仍能工作', async (t) => {
  const h = await setup(t, { groups: ['g', 'b'], resumeFailure: (id) => id === residentSessionId('g') })
  assert.equal(h.store.getGroup('g').residentSessionId, residentSessionId('g'))
  assert.equal(h.calls.some((item) => !item.resumed && item.sessionId === residentSessionId('g')), false)
  assert.ok(h.runtime.listRecoveryIssues().some((issue) => issue.groupId === 'g' && issue.error.includes('corrupt session')))
  await ingest(h, 'b', { groupId: 'b' }); const request = (await route(h, {}, 'b')).pendingDecisions[0]
  assert.equal((await decide(h, request, { reply: '正常' }, 'b')).status, 'accepted')
})

test('新群主会话具有完整工具权限，Topic 工具仍不能访问其他 Session', async (t) => {
  const h = await setup(t, { groups: [] })
  const result = await h.runtime.subscribe({ groupId: 'g', name: '新群' })
  assert.equal(result.created, true)
  assert.equal(result.group.residentSessionId, residentSessionId('g'))
  assert.equal(h.calls[0].resumed, false)
  assert.equal(h.calls[0].input.meta.cwd, join(agentWorkspace, 'session-workspaces', '群聊常驻'))
  assert.deepEqual(h.permissions, [[residentSessionId('g'), 'danger-full-access']])
  assert.equal((await h.runtime.subscribe({ groupId: 'g' })).created, false)
  assert.equal(h.calls.length, 1)
})

test('模型与推理深度使用原生配置服务保存', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ model: 'next-model', reasoningEffort: 'high' })
  assert.equal(saved.model, 'next-model')
  assert.deepEqual(h.savedSelection, { provider: 'fake', model: 'next-model', reasoningEffort: 'high' })
})

test('退订存储失败时保留 Resident，修复后可再次退订', async (t) => {
  const h = await setup(t), id = h.store.getGroup('g').residentSessionId
  h.idle.set(id, Promise.resolve())
  const original = h.store.removeGroup; let fail = true
  h.store.removeGroup = async (args) => { if (fail) throw new Error('remove_failure'); return original(args) }
  await assert.rejects(h.runtime.unsubscribe({ groupId: 'g' }), /remove_failure/)
  assert.ok(h.store.getGroup('g')); assert.equal(h.disposed.includes(id), false)
  fail = false
  await h.runtime.unsubscribe({ groupId: 'g' })
  assert.equal(h.store.getGroup('g'), undefined)
  assert.ok(h.disposed.includes(id))
})

test('关闭后拒绝新消息，关闭两次只释放每个 Session 一次', async (t) => {
  const h = await setup(t), id = h.store.getGroup('g').residentSessionId
  await h.runtime.close(); await h.runtime.close()
  await assert.rejects(ingest(h, 'late'), /resident_runtime_closed/)
  assert.equal(h.disposed.filter((value) => value === id).length, 1)
})

test('叶子 Topic 读取仅允许已接纳版本，拒绝未来版本及其他话题', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await ingest(h, 'later')
  const later = (await route(h, { later: task.topicRefs[0].topicId })).pendingDecisions[0]
  const leaf = h.handles.get(task.childSessionId)
  const reader = leaf.tools.get('group_topic_context_get')
  const initial = await reader.execute({ topicId: task.topicRefs[0].topicId, revision: task.topicRefs[0].revision }, { agent: leaf.agent })
  assert.equal(initial.messages.length, 1)
  assert.throws(() => reader.execute({ topicId: task.topicRefs[0].topicId, revision: later.revision }, { agent: leaf.agent }), /topic.*version|topic.*revision|task_topic/)
  assert.throws(() => reader.execute({ topicId: 'foreign', revision: 1 }, { agent: leaf.agent }), /topic.*not|task_topic/)
})

test('同一消息并发补齐身份与附件不会丢失任一事实', async (t) => {
  const h = await setup(t)
  await Promise.all([
    ingest(h, 'same', { senderName: '甲', senderOpenDingTalkId: 'od-a' }),
    ingest(h, 'same', { senderName: '甲', senderOpenDingTalkId: 'od-a', imageRefs: [{ id: 'image-1', mediaType: 'image/png' }] }),
  ])
  const messages = h.store.getGroup('g').messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0].senderOpenDingTalkId, 'od-a')
  assert.equal(messages[0].imageRefs[0].id, 'image-1')
  assert.equal(messages[0].messageVersion, 2)
})

test('关闭等待已接受的可靠 Outbox 写入，期间新消息被拒绝', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  let release, entered
  const gate = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
  const original = h.store.appendOutbox
  h.store.appendOutbox = async (args) => { entered(); await gate; return original(args) }
  const accepted = await h.call('group_decision_submit', { requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { basisMessageIds: ['a'], actions: [], reply: '可靠回复', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive' } } })
  assert.equal(accepted.status, 'accepted'); await started
  let closed = false
  const closing = h.runtime.close().then(() => { closed = true })
  await immediate(); assert.equal(closed, false)
  await assert.rejects(ingest(h, 'late'), /resident_runtime_closed/)
  release(); await closing
  const records = h.snapshot.tables.groups
  assert.equal(Object.values(records)[0].outbox.length, 1)
})

test('替换确认先送达新消息，随后精确撤回旧消息且重复恢复幂等', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  await decide(h, request, { reply: '旧确认', replyReview: { kind: 'confirmation' } })
  const old = h.store.getGroup('g').outbox[0]
  await h.store.acknowledge({ groupId: 'g', outboundId: old.outboundId, deliveredMessageId: 'actual-old-message' })
  await ingest(h, 'a2'); const revised = (await route(h, { a2: request.topicId })).pendingDecisions[0]
  const candidates = await h.call('group_reply_review_get', { requestIds: [revised.requestId] })
  await decide(h, revised, { reply: '合并后的确认', replyReview: { kind: 'confirmation', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [old.outboundId], replaceOutboundIds: [old.outboundId] } })
  const next = h.store.getGroup('g').outbox[1], recalls = []
  h.runtime.registerGroupMessageRecaller(async (value) => { recalls.push(value.messageId) })
  await h.runtime.prepareOutbound({ groupId: 'g', outbound: next })
  await h.runtime.prepareOutbound({ groupId: 'g', outbound: next })
  assert.deepEqual(recalls, [])
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound: next })
  assert.deepEqual(recalls, [])
  await h.store.acknowledge({ groupId: 'g', outboundId: next.outboundId, deliveredMessageId: 'actual-new-message' })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound: next })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound: next })
  assert.deepEqual(recalls, ['actual-old-message'])
  assert.equal(h.store.getGroup('g').outbox[0].recallStatus, 'recalled')
})

test('未回读的旧确认停止重发，不阻塞替换，未观察到仍保持送达未知', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  await decide(h, request, { reply: '旧确认', replyReview: { kind: 'confirmation' } })
  const old = h.store.getGroup('g').outbox[0]
  await ingest(h, 'a2'); const revised = (await route(h, { a2: request.topicId })).pendingDecisions[0]
  const candidates = await h.call('group_reply_review_get', { requestIds: [revised.requestId] })
  await decide(h, revised, { reply: '新的确认', replyReview: { kind: 'confirmation', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [old.outboundId], replaceOutboundIds: [old.outboundId] } })
  let lookups = 0
  h.runtime.registerGroupMessageRecaller(async ({ messageId }) => { assert.equal(messageId, undefined); lookups++; return { status: 'not-observed' } })
  const next = h.store.getGroup('g').outbox[1]
  assert.equal((await h.runtime.prepareOutbound({ groupId: 'g', outbound: next })).status, 'pending')
  assert.equal(h.store.getGroup('g').outbox[0].status, 'superseded')
  await h.store.acknowledge({ groupId: 'g', outboundId: next.outboundId, deliveredMessageId: 'actual-new-message' })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound: next })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound: next })
  assert.equal(lookups, 1)
  assert.equal(h.store.getGroup('g').outbox[0].recallError, 'replacement_delivery_unknown')
  assert.equal(h.store.getGroup('g').outbox[0].deliveredMessageId, undefined)
  assert.equal(h.store.getGroup('g').outbox.length, 2)
})

test('链式替换先送达最终通知，部分撤回失败不阻塞其他目标且永久拒绝不重试', async (t) => {
  const h = await setup(t)
  await h.store.subscribe({ groupId: 'g' })
  for (const id of ['a', 'b']) {
    await h.store.appendOutbox({ groupId: 'g', outboundId: id, sourceMessageId: id, text: id })
    await h.store.acknowledge({ groupId: 'g', outboundId: id, deliveredMessageId: `message-${id}` })
  }
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'middle', sourceMessageId: 'middle', text: 'middle', replacesOutboundIds: ['a'] })
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'final', sourceMessageId: 'final', text: 'correction', replacesOutboundIds: ['middle', 'b'] })
  const calls = []
  h.runtime.registerGroupMessageRecaller(async ({ outbound }) => {
    calls.push(outbound.outboundId)
    if (outbound.outboundId === 'a') { const error = new Error('dws_recall_failed:1:1001'); error.serverErrorCode = '1001'; throw error }
    if (outbound.outboundId === 'middle' && !outbound.deliveredMessageId) return { status: 'not-observed' }
  })
  const outbound = h.store.getGroup('g').outbox.at(-1)
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.deepEqual(calls, [])
  await h.store.acknowledge({ groupId: 'g', outboundId: 'final', deliveredMessageId: 'message-final' })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.deepEqual(calls, ['a', 'middle', 'b'])
  assert.equal(h.store.getGroup('g').outbox.find(x => x.outboundId === 'final').status, 'sent')
  assert.equal(h.store.getGroup('g').outbox.find(x => x.outboundId === 'a').recallAttemptCount, 1)
  // 已替代消息的迟到回执只补事实，不重新发送；继续撤回而不重撤已成功目标。
  await h.store.acknowledge({ groupId: 'g', outboundId: 'middle', deliveredMessageId: 'late-middle' })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.deepEqual(calls, ['a', 'middle', 'b', 'middle'])
  assert.equal(h.store.getGroup('g').outbox.find(x => x.outboundId === 'middle').status, 'superseded')
})

test('撤回瞬态异常有限重试，持久次数达到上限后不再调用渠道', async (t) => {
  const h = await setup(t); await h.store.subscribe({ groupId: 'g' })
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'old', sourceMessageId: 'old', text: 'old' })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'old', deliveredMessageId: 'old-msg' })
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'new', sourceMessageId: 'new', text: 'new', replacesOutboundIds: ['old'] })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'new', deliveredMessageId: 'new-msg' })
  let calls = 0
  h.runtime.registerGroupMessageRecaller(async () => { calls++; throw new Error('network_timeout') })
  const outbound = h.store.getGroup('g').outbox.at(-1)
  for (let i = 0; i < 3; i++) {
    await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
    const old = h.store.getGroup('g').outbox[0]
    assert.equal(calls, i + 1)
    if (i < 2) {
      assert.ok(old.recallRetryAt)
      await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
      assert.equal(calls, i + 1)
      await h.store.updateOutboundRecall({ groupId: 'g', outboundId: 'old', status: 'failed', error: old.recallError, retryAt: '2000-01-01T00:00:00.000Z' })
    }
  }
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.equal(calls, 3)
  assert.equal(h.store.getGroup('g').outbox[0].recallRetryAt, undefined)
})

test('撤回成功后持久写失败不能伪报成功，恢复永久拒绝后保留人工核验状态', async (t) => {
  const h = await setup(t)
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'old', sourceMessageId: 'old', text: 'old' })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'old', deliveredMessageId: 'old-msg' })
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'new', sourceMessageId: 'new', text: 'new', replacesOutboundIds: ['old'] })
  await h.store.acknowledge({ groupId: 'g', outboundId: 'new', deliveredMessageId: 'new-msg' })
  const update = h.store.updateOutboundRecall
  h.store.updateOutboundRecall = async args => { if (args.status === 'recalled') throw new Error('recall_disk_failure'); return update(args) }
  let calls = 0
  h.runtime.registerGroupMessageRecaller(async () => { if (calls++ > 0) { const error = new Error('already_absent_unverified'); error.serverErrorCode = '1001'; throw error } })
  const outbound = h.store.getGroup('g').outbox.at(-1)
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.equal(h.store.getGroup('g').outbox[0].recallStatus, 'failed')
  assert.equal(h.store.getGroup('g').outbox[1].status, 'sent')
  await update({ groupId: 'g', outboundId: 'old', status: 'failed', error: 'recall_disk_failure', retryAt: '2000-01-01T00:00:00.000Z' })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  await h.runtime.completeOutboundReplacement({ groupId: 'g', outbound })
  assert.equal(calls, 2)
  assert.equal(h.store.getGroup('g').outbox[0].recallRetryAt, undefined)
  assert.equal(h.store.getGroup('g').outbox[0].recalledAt, undefined)
})

test('真实Store与Bridge在监听和启动补偿并发、回执落盘崩溃及两次重启下不重发旧消息', async (t) => {
  let h = await setup(t)
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'old', sourceMessageId: 'old', text: 'old confirmation' })
  const messages = [], sends = [], recalls = []
  let release, entered, failAck = true
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const adapter = {
    startGroupSubscription: () => ({ done: Promise.resolve(), stop() {} }),
    readGroup: async () => ({ complete: true, messages: [...messages] }),
    findOutboundMessage: async (_group, outbound) => messages.find(message => message.text === outbound.text),
    async sendGroup({ text, idempotencyKey }) { sends.push(idempotencyKey); messages.push({ text, messageId: `actual-${idempotencyKey}` }); if (idempotencyKey === 'old') { entered(); await gate } return {} },
    async recallMessage(id) { recalls.push(id); const index = messages.findIndex(message => message.messageId === id); if (index >= 0) messages.splice(index, 1) },
  }
  const originalAck = h.runtime.acknowledge
  h.runtime.acknowledge = async args => { if (args.outboundId === 'old' && failAck) { failAck = false; throw new Error('ack_disk_failure') } return originalAck(args) }
  const start = () => startDwsBridge({ runtime: h.runtime, adapter, logger: { warn() {} }, humanPollIntervalMs: 0, groupBackfillIntervalMs: 0, outboxRetryIntervalMs: 10 })
  let stop = start()
  await started
  // 发送已经开始时提交替换。外部旧发送不能撤销，晚回执须保留，纠正不能并发越过旧发送。
  await h.store.appendOutbox({ groupId: 'g', outboundId: 'new', sourceMessageId: 'new', text: 'new correction', replacesOutboundIds: ['old'] })
  assert.deepEqual(sends, ['old'])
  release()
  await until(() => h.store.getGroup('g').outbox.find(x => x.outboundId === 'new').status === 'sent')
  await until(() => h.store.getGroup('g').outbox.find(x => x.outboundId === 'old').recallStatus === 'recalled')
  await stop(); await h.runtime.close()
  for (let i = 0; i < 2; i++) {
    h = await setup(t, { snapshot: h.snapshot })
    stop = start(); await new Promise(resolve => setTimeout(resolve, 30)); await stop(); await h.runtime.close()
  }
  assert.deepEqual(sends, ['old', 'new'])
  assert.deepEqual(recalls, ['actual-old'])
  const old = Object.values(h.snapshot.tables.groups)[0].outbox.find(x => x.outboundId === 'old')
  assert.equal(old.status, 'superseded')
  assert.equal(old.deliveredMessageId, 'actual-old')
  assert.ok(old.sendStartedAt)
})

test('通知 Outbox 首次失败后相同请求重试使用稳定结果键且只落一次', async (t) => {
  const h = await setup(t), task = await createTask(h); await fullCheckpoints(h, task)
  const original = h.store.appendOutbox; let fail = true
  h.store.appendOutbox = async (args) => { if (fail) throw new Error('outbox_storage_failure'); return original(args) }
  await completeResult(h, task)
  await until(() => h.store.getTask(task.taskId).notificationIntents[0]?.status === 'blocked')
  const intent = h.store.getTask(task.taskId).notificationIntents[0]
  assert.equal(h.store.getTask(task.taskId).state, 'completed')
  fail = false
  await h.runtime.retryCompletionNotification({ taskId: task.taskId, intentId: intent.intentId })
  await h.runtime.recoverCompletionNotifications()
  assert.equal(h.store.getTask(task.taskId).notificationIntents[0].outboundId, intent.outboundId)
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
})

test('DSH原生默认模型在运行中变化时配置读回和下一请求同步更新', async (t) => {
  const h = await setup(t), task = await createTask(h, 'native-model-change')
  const leaf = h.handles.get(task.childSessionId)
  h.defaultSelection.model = 'native-next-model'
  h.defaultSelection.reasoningEffort = 'xhigh'
  assert.equal(h.runtime.getAgentConfig().model, 'native-next-model')
  const assembled = await leaf.hooks.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }))
  assert.equal(assembled.variables.model, 'native-next-model')
  const request = await leaf.hooks.get('agent/request')({}, async () => ({ provider: 'fake', model: 'fake' }))
  assert.deepEqual(request, { provider: 'fake', model: 'native-next-model', reasoningEffort: 'xhigh' })
})

test('缺少稳定发送人 ID 不伪造引用，缓冲回复监听异常不损失已存意图', async (t) => {
  const h = await setup(t)
  await ingest(h, 'anonymous', { senderOpenDingTalkId: undefined })
  await decide(h, (await route(h)).pendingDecisions[0], { reply: '已答复' })
  const outbound = h.store.getGroup('g').outbox[0]
  assert.equal(outbound.replyToMessageId, undefined)
  assert.equal(outbound.atOpenDingTalkIds, undefined)
  h.runtime.onOutboxAppended(() => { throw new Error('buffered_listener_failure') })
  await until(() => h.runtime.listRecoveryIssues().some((item) => item.error.includes('buffered_listener_failure')))
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('DWS 恢复关闭同群 carrier 告警且不误清其他异常', async (t) => {
  const h = await setup(t), task = await createTask(h)
  for (const fingerprint of ['dws-consumer-exit:1', 'dws-consumer-start-failed:1', 'leaf-paused']) await h.store.recordAlert({ taskId: task.taskId, fingerprint, detail: fingerprint })
  await h.runtime.resolveGroupCarrierIssues({ groupId: 'g' })
  for (const alert of h.store.listAlerts()) assert.equal(alert.status, alert.fingerprint.startsWith('dws-consumer-') ? 'resolved' : 'active')
})

test('同 Topic 一次决策不能重复改变同一 Task，共享主 Topic 可取消两个不同 Task 各一次', async (t) => {
  const h = await setup(t), one = await createTask(h, 'task-one'), two = await createTask(h, 'task-two')
  await ingest(h, 'cancel-both', { text: '@助理 两个任务都取消' })
  await h.runtime.recoverInterruptedDecisions()
  await until(() => h.envelope('[GROUP_TOPIC_ROUTE]')?.messages.some(message => message.messageId === 'cancel-both'))
  const routing = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routing.requestId, routes: routing.messages.map((message) => ({ messageId: message.messageId, messageVersion: message.messageVersion, topics: [
    { topicId: one.topicRefs[0].topicId, relationship: 'affected', reason: '明确取消任务一' },
    { topicId: two.topicRefs[0].topicId, relationship: 'affected', reason: '明确取消任务二' },
  ], effectOwner: { topicId: one.topicRefs[0].topicId } })) })
  const owner = routed.pendingDecisions.find((item) => item.topicId === one.topicRefs[0].topicId)
  const actions = [one, two].map((task) => ({ kind: 'task-cancel', taskId: task.taskId, ...inputVersion(task), reason: '用户明确取消两个任务', topicRefs: [{ topicId: owner.topicId, revision: owner.revision }] }))
  const submission = { requestId: owner.requestId, topicId: owner.topicId, revision: owner.revision, decision: { basisMessageIds: ['cancel-both'], actions: [actions[0], actions[0]], reply: '已取消这两个任务。', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }
  const duplicate = await h.call('group_decision_submit', submission)
  assert.equal(duplicate.status, 'invalid-arguments')
  assert.ok(duplicate.issues.some(issue => issue.code === 'topic_decision_task_target_duplicate'))
  assert.equal(h.store.getTask(one.taskId).state, 'running')
  assert.equal(h.store.getTask(two.taskId).state, 'queued')
  await h.call('group_reply_review_get', { requestIds: [owner.requestId] }).then((review) => { submission.decision.replyReview.reviewedOutboundIds = review.candidates.map((item) => item.outboundId) })
  submission.decision.actions = actions
  assert.equal((await h.call('group_decision_submit', submission)).status, 'accepted')
  await h.runtime.drainTopicOperations('g')
  for (const task of [one, two]) {
    const current = h.store.getTask(task.taskId)
    assert.equal(current.state, 'completed')
    assert.equal(current.inputVersion, task.inputVersion + 1)
    assert.equal(current.appliedOperations.length, 2)
  }
  const record = h.store.getTopic('g', owner.topicId).decisions.at(-1)
  assert.equal(record.status, 'completed')
  assert.equal(record.operations.length, 2)
  assert.ok(record.operations.every((operation) => operation.status === 'applied'))
})

test('已执行来源改归属不会重新授予效果权限，新授权消息可以创建新任务', async (t) => {
  const h = await setup(t), original = await createTask(h, 'executed-source')
  const a = original.topicRefs[0]
  const review = await h.call('group_topic_route_review', { messageIds: ['executed-source'], reason: '原归类错误，移到 B' })
  const moved = await h.call('group_topic_route_submit', { requestId: review.requestId, routes: [{ messageId: 'executed-source', messageVersion: 1, topics: [{ newTopicKey: 'correct-b', title: 'B' }] }] })
  const b = moved.pendingDecisions.find((request) => request.topicId !== a.topicId)
  const bEnvelope = h.messages().filter((message) => message.content[0]?.text.startsWith('[GROUP_TOPIC_DECISION]'))
    .map((message) => JSON.parse(message.content[0].text.split('\n').find((line) => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length)))
    .find((item) => item.topicId === b.topicId)
  assert.equal(bEnvelope.messages.find((message) => message.messageId === 'executed-source').effectOwnerTopicId, a.topicId)
  assert.deepEqual(b.ownedDeltaMessageIds, [])
  const newAction = { kind: 'new-task', title: '重复原指令', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: b.topicId, revision: b.revision }] }
  const unauthorized = await h.call('group_decision_submit', { requestId: b.requestId, topicId: b.topicId, revision: b.revision, decision: { basisMessageIds: ['executed-source'], actions: [newAction], reply: '再建任务', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })
  assert.equal(unauthorized.status, 'invalid-arguments')
  assert.ok(unauthorized.issues.some(issue => issue.code === 'topic_effect_owner_required'))
  assert.equal(h.store.listTasks().length, 1)
  await ingest(h, 'fresh-authorization', { text: '@助理 请另建一个独立任务，重新核验 B' })
  const fresh = (await route(h, { 'fresh-authorization': b.topicId })).pendingDecisions.find((request) => request.topicId === b.topicId)
  assert.deepEqual(fresh.ownedDeltaMessageIds, ['fresh-authorization'])
  const candidates = await h.call('group_reply_review_get', { requestIds: [fresh.requestId] })
  assert.equal((await decide(h, fresh, { basisMessageIds: ['fresh-authorization'], actions: [{ ...newAction, title: '新授权任务', topicRefs: [{ topicId: fresh.topicId, revision: fresh.revision }] }], reply: '按新授权创建独立核验任务。', replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })).status, 'accepted')
  assert.equal(h.store.listTasks().length, 2)
  assert.deepEqual(h.store.getTask(original.taskId).topicRefs, [a])
})

test('相同引用 ID 下的不同事项不自动撤回，只有显式 replacement 才能产生撤回意图', async (t) => {
  const h = await setup(t)
  await ingest(h, 'quote-one', { text: '@助理 记录 A 事项', quotedMessage: { messageId: 'shared-anchor', content: '群内讨论' } })
  const one = (await route(h)).pendingDecisions[0]
  await decide(h, one, { reply: 'A 已记录', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } })
  await ingest(h, 'quote-two', { text: '@助理 另一个 B 事项', quotedMessage: { messageId: 'shared-anchor', content: '群内讨论' } })
  const two = (await route(h, { 'quote-two': one.topicId })).pendingDecisions[0]
  const review = await h.call('group_reply_review_get', { requestIds: [two.requestId] })
  assert.equal(review.candidates.length, 1)
  await decide(h, two, { reply: 'B 已记录', replyReview: { kind: 'confirmation', reviewedOutboundIds: review.candidates.map((candidate) => candidate.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })
  const outbox = h.store.getGroup('g').outbox
  assert.equal(outbox.length, 2)
  assert.deepEqual(outbox[1].replacesOutboundIds ?? [], [])
  assert.equal(outbox[0].recallStatus, undefined)
})
