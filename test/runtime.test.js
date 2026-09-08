import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { buildTaskAssociationIndex, openResidentRuntime, residentSessionId } from '../packages/dingtalk-dsh-assistant/runtime.js'
import { openResidentStore, taskSessionId } from '../packages/dingtalk-dsh-assistant/store.js'

const agentWorkspace = mkdtempSync(join(tmpdir(), 'dsh-agent-workspace-'))
const replacementWorkspace = mkdtempSync(join(tmpdir(), 'dsh-replacement-workspace-'))
after(() => { rmSync(agentWorkspace, { recursive: true, force: true }); rmSync(replacementWorkspace, { recursive: true, force: true }) })

// 旧群级观察/消息副本 fixture 已替换为真实 Store：exact batch、独立 Topic、
// stale、basis、版本审阅、恢复提交等边界由 topic-runtime.test.js 直接覆盖。
// 此文件核验 Runtime 集成、实际叶子协议、外部投递和 Resident 生命周期。
function memoryFacility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'runtime-test' })
}
const immediate = () => new Promise((resolve) => setImmediate(resolve))
async function until(condition) {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('fixture 条件未在 3 秒内成立')
}
async function setup(t, options = {}) {
  const snapshot = options.snapshot ?? { tables: {}, global: null }
  const store = await openResidentStore(memoryFacility(snapshot))
  for (const groupId of options.groups ?? ['g']) if (!store.getGroup(groupId)) await store.subscribe({ groupId, responsibility: '处理测试任务', residentSessionId: residentSessionId(groupId), residentAgentPreset: 'standard' })
  await store.setAgentNames(['助理'])
  const h = { store, snapshot, handles: new Map(), calls: [], cancelled: [], disposed: [], permissions: [], goals: options.goals ?? new Map(), events: new Map(), idle: new Map(), idleCalls: new Map(), onSteer: undefined }
  const never = new Promise(() => {})
  const makeHandle = async (input, resumed) => {
    const sessionId = String(input.sessionId ?? input.resumeSessionId)
    if (resumed) await options.beforeResume?.(input)
    else await options.beforeCreate?.(input)
    if (options.resumeFailure && resumed && options.resumeFailure(sessionId)) throw new Error('corrupt session log: synthetic failure')
    const events = [...(input.seed ?? options.sessionEvents?.get(sessionId) ?? [])]
    const inheritedEventCount = input.inheritedEventCount ?? 0
    const session = { id: sessionId, seq: events.length, header: input.meta ?? {}, inheritedEventCount,
      snapshotEvents() { return [...events] }, ownEvents() { return events.slice(inheritedEventCount) },
      append(type, data) { events.push({ seq: this.seq++, type, data }) } }
    const tools = new Map(), sections = [], restrictions = [], sent = []
    const agent = { session, status: 'running', inbox: options.inbox ?? { nextStep: [], nextTurn: [], remove() { return false } },
      steer(message) { sent.push(message); session.append('user/message', message); h.onSteer?.(sessionId, message) },
      followup(message) { sent.push(message); h.onSteer?.(sessionId, message) },
      whenIdle: () => { h.idleCalls.set(sessionId, (h.idleCalls.get(sessionId) ?? 0) + 1); return h.idle.get(sessionId) ?? never },
      cancel(cause) { h.cancelled.push({ sessionId, cause }) },
    }
    const handle = { agent, tools, sections, restrictions, sent, async dispose() { await options.disposeGate?.(sessionId); h.disposed.push(sessionId) } }
    h.handles.set(sessionId, handle)
    const agentCtx = { on: () => () => {}, tools: { register(tool) { tools.set(tool.name, tool) }, restrict(rule) { restrictions.push(rule) } }, systemPrompt: { section(value) { sections.push(value) } } }
    const setupResult = await input.setup?.(agentCtx)
    assert.equal(setupResult, undefined)
    h.calls.push({ resumed, sessionId, input })
    return handle
  }
  const selection = { provider: 'fake', model: 'fake' }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ ...selection }), async saveSelection(value) { Object.assign(selection, value); h.savedSelection = value } },
    agents: { create: (input) => makeHandle(input, false), resume: (input) => makeHandle(input, true), get: (id) => h.handles.get(String(id))?.agent },
    subagents: { drainContinuableDescendants: async () => {} },
    agentPresets: { mount: async (_ctx, id) => ({ id }), composeFrom: () => 'standard', serviceFor: () => ({ set(session, preset) { h.permissions.push([session.id, preset]) } }) },
    goals: {
      get: (agent) => h.goals.get(agent.session.id),
      create(agent, value) { const goal = { id: `goal-${agent.session.id}`, revision: 1, phase: 'active', activation: 'armed', roundsStarted: 0, ...value }; h.goals.set(agent.session.id, goal); return goal },
      complete(agent, ref) { const goal = { ...h.goals.get(agent.session.id), revision: (ref?.revision ?? 1) + 1, phase: 'complete', activation: 'disarmed' }; h.goals.set(agent.session.id, goal); return goal },
      block(agent, ref, reason) { const goal = { ...h.goals.get(agent.session.id), revision: ref.revision + 1, phase: 'blocked', activation: 'disarmed', blockedReason: reason }; h.goals.set(agent.session.id, goal); return goal },
      edit(agent, ref, patch) { const goal = { ...h.goals.get(agent.session.id), ...patch, revision: ref.revision + 1 }; h.goals.set(agent.session.id, goal); return goal },
      resume(agent, ref) { const goal = { ...h.goals.get(agent.session.id), revision: ref.revision + 1, phase: 'active', activation: 'armed' }; h.goals.set(agent.session.id, goal); return goal },
    },
    on(name, fn) { h.events.set(name, fn); return () => h.events.delete(name) },
    ...(options.attachments ? { attachments: options.attachments } : {}),
  }
  h.ctx = ctx
  h.runtime = await openResidentRuntime(ctx, store, agentWorkspace, { maxConcurrentTasks: options.maxConcurrentTasks ?? 1, supervisorIntervalMs: 0, resumeTimeoutMs: options.resumeTimeoutMs ?? 10_000, decisionRetryBaseMs: options.retryDelayMs ?? 60_000 })
  h.resident = (groupId = 'g') => h.handles.get(store.getGroup(groupId)?.residentSessionId)
  h.call = (name, args, groupId = 'g', agent) => h.resident(groupId).tools.get(name).execute(args, { agent: agent ?? h.resident(groupId).agent })
  h.envelope = (prefix, groupId = 'g', label = 'Topic 请求') => {
    const text = h.resident(groupId).sent.findLast((message) => message.content[0]?.text.startsWith(prefix))?.content[0].text
    return text ? JSON.parse(text.split('\n').find((line) => line.startsWith(`${label}：`)).slice(label.length + 1)) : undefined
  }
  t.after(async () => { h.onSteer = undefined; for (const id of h.handles.keys()) h.idle.set(id, Promise.resolve()); await h.runtime.close() })
  return h
}
async function ingest(h, id, extra = {}) {
  return h.runtime.ingest({ groupId: 'g', messageId: id, text: `@助理 ${id}`, occurredAt: '2026-09-07T00:00:00Z', senderName: '甲', senderOpenDingTalkId: 'od-a', ...extra })
}
async function route(h, topicByMessage = {}, groupId = 'g') {
  await h.runtime.recoverInterruptedDecisions()
  const request = h.envelope('[GROUP_TOPIC_ROUTE]', groupId)
  assert.ok(request, 'Runtime 必须先建立归类请求')
  return h.call('group_topic_route_submit', { requestId: request.requestId, routes: request.messages.map((message) => ({ messageId: message.messageId, messageVersion: message.messageVersion, topics: [topicByMessage[message.messageId] ? { topicId: topicByMessage[message.messageId] } : { newTopicKey: message.messageId, title: message.messageId }] })) }, groupId)
}
async function decide(h, request, decision = {}, groupId = 'g') {
  const value = { basisMessageIds: [request.messages.at(-1).messageId], actions: [], ...(decision.reply ? { replyReview: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } : {}), ...(decision.reply === undefined ? { reason: '无需回复' } : {}), ...decision }
  const result = await h.call('group_decision_submit', { requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: value }, groupId)
  await h.runtime.drainTopicOperations(groupId)
  return result
}
async function createTask(h, id = 'task-input', extra = {}) {
  await ingest(h, id)
  const request = (await route(h)).pendingDecisions.find((item) => item.messages.some((message) => message.messageId === id))
  const action = { kind: 'new-task', title: id, objective: `核验 ${id}`, acceptanceCriteria: ['结果可查'], stageTasks: ['核验阶段'], topicRefs: [{ topicId: request.topicId, revision: request.revision }], ...extra }
  assert.equal((await decide(h, request, { actions: [action], reply: '已收到，会继续处理。' })).status, 'accepted')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.at(-1).status, 'completed', JSON.stringify(h.runtime.listRecoveryIssues()))
  return h.store.listTasks().find((task) => task.topicRefs.some((ref) => ref.topicId === request.topicId))
}

test('入站持久接收立即返回，模型尚未提交时也能接收后续消息', async (t) => {
  const h = await setup(t)
  const first = await ingest(h, 'a'), second = await ingest(h, 'b')
  assert.equal(first.accepted, true); assert.equal(second.accepted, true)
  assert.equal(h.store.getGroup('g').messages.length, 2)
  assert.equal(h.store.getGroup('g').outbox.length, 0)
  assert.ok(h.envelope('[GROUP_TOPIC_ROUTE]'))
})

test('重复入站幂等，Topic 提交成功后只生成一条可靠回复', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); assert.equal((await ingest(h, 'a')).duplicate, true)
  const request = (await route(h)).pendingDecisions[0]
  assert.equal((await decide(h, request, { reply: '已核验。' })).status, 'accepted')
  assert.equal(h.store.getGroup('g').messages.length, 1)
  assert.deepEqual(h.store.getGroup('g').outbox.map((item) => item.text), ['已核验。'])
  assert.equal((await decide(h, request, { reply: '重复。' })).status, 'topic-stale')
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

test('Task 只保存固定 Topic 引用，叶子收到版本化原始上下文', async (t) => {
  const h = await setup(t), task = await createTask(h)
  assert.equal(task.state, 'running')
  for (const name of ['sourceMessageId', 'sourceMessageIds', 'triggerHistory', 'messageHistory', 'relatedContexts']) assert.equal(name in task, false)
  assert.equal(task.inputVersion, 1); assert.equal(task.runSequence, 1)
  assert.equal(task.childSessionId, taskSessionId(task.taskId))
  const leaf = h.handles.get(task.childSessionId)
  assert.ok(leaf)
  assert.equal(h.goals.get(task.childSessionId).objective, task.objective)
  const call = h.calls.find((item) => item.sessionId === task.childSessionId)
  assert.equal(call.input.meta.cwd, agentWorkspace)
  assert.equal(call.input.meta.parentSession, h.store.getGroup('g').residentSessionId)
  assert.equal(call.input.meta.origin, 'subagent')
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('[TASK_TOPIC_CONTEXT]')))
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('"inputVersion":1')))
  for (const tool of leaf.tools.values()) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema) }
})

test('任务关联摘要不复制原文，按需读取返回 Topic refs 与执行约定', async (t) => {
  const h = await setup(t), task = await createTask(h, '任务范围')
  const index = buildTaskAssociationIndex([task])
  assert.deepEqual(index[0].topicRefs, task.topicRefs)
  assert.doesNotMatch(JSON.stringify(index), /messageHistory|senderOpenDingTalkId/)
  const detail = await h.call('group_task_context_get', { taskIds: [task.taskId] })
  assert.equal(detail.tasks[0].objective, task.objective)
  assert.deepEqual(detail.tasks[0].topicRefs, task.topicRefs)
  assert.equal('messageHistory' in detail.tasks[0], false)
  await assert.rejects(h.call('group_task_context_get', { taskIds: [task.taskId, task.taskId] }), /group_task_context_request_duplicate/)
  await assert.rejects(h.call('group_task_context_get', { taskIds: ['missing'] }), /group_task_context_not_found/)
})

test('任务并发容量满时 FIFO 排队，取消释放名额并保留取消事实', async (t) => {
  const h = await setup(t, { maxConcurrentTasks: 2 })
  const one = await createTask(h, 'one'), two = await createTask(h, 'two'), three = await createTask(h, 'three')
  assert.deepEqual([h.store.getTask(one.taskId).state, h.store.getTask(two.taskId).state, h.store.getTask(three.taskId).state], ['running', 'running', 'queued'])
  await h.runtime.cancelTask({ taskId: one.taskId, requestId: 'cancel-one', topicRefs: one.topicRefs, ...inputVersion(h.store.getTask(one.taskId)), reason: '用户取消' })
  assert.equal(h.store.getTask(one.taskId).state, 'completed')
  assert.equal(h.store.getTask(three.taskId).state, 'running')
  assert.equal(h.cancelled[0].sessionId, one.childSessionId)
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
  const text = h.resident().sent.at(-1).content[0].text
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

test('新群创建原生 Session 后绑定，工具不能访问其他 Session', async (t) => {
  const h = await setup(t, { groups: [] })
  const result = await h.runtime.subscribe({ groupId: 'g', name: '新群' })
  assert.equal(result.created, true)
  assert.equal(result.group.residentSessionId, residentSessionId('g'))
  assert.equal(h.calls[0].resumed, false)
  assert.equal(h.calls[0].input.meta.cwd, agentWorkspace)
  assert.deepEqual(h.permissions, [[residentSessionId('g'), 'read-only']])
  assert.equal((await h.runtime.subscribe({ groupId: 'g' })).created, false)
  assert.equal(h.calls.length, 1)
})

test('工作区切换保留事件历史并重建 Resident，旧 Session 释放', async (t) => {
  const h = await setup(t), oldId = h.store.getGroup('g').residentSessionId
  h.resident().agent.session.append('turn/end', { status: 'success' })
  h.idle.set(oldId, Promise.resolve())
  const result = await h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  assert.equal(result.workspaceDir, replacementWorkspace)
  assert.notEqual(h.store.getGroup('g').residentSessionId, oldId)
  const replacement = h.calls.at(-1)
  assert.equal(replacement.input.meta.cwd, replacementWorkspace)
  assert.ok(replacement.input.seed.some((event) => event.type === 'turn/end'))
  assert.ok(h.disposed.includes(oldId))
})

test('存在活动 Task 时拒绝工作区或模型切换，不修改已保存配置', async (t) => {
  const h = await setup(t); await createTask(h)
  await assert.rejects(h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }), /agent_config_has_active_tasks/)
  await assert.rejects(h.runtime.updateAgentConfig({ model: 'other' }), /agent_config_has_active_tasks/)
  assert.equal(h.runtime.getAgentConfig().workspaceDir, agentWorkspace)
  assert.equal(h.runtime.getAgentConfig().model, 'fake')
})

test('模型与推理深度使用原生配置服务保存', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ model: 'next-model', reasoningEffort: 'high' })
  assert.equal(saved.model, 'next-model')
  assert.deepEqual(h.savedSelection, { provider: 'fake', model: 'next-model', reasoningEffort: 'high' })
})

test('叶子会话提示词通过统一配置字段保存和读取', async (t) => {
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ leafSessionPrompt: '先核对范围，再提交可复核证据。' })
  assert.equal(saved.leafSessionPrompt, '先核对范围，再提交可复核证据。')
  assert.equal(h.runtime.getAgentConfig().leafSessionPrompt, '先核对范围，再提交可复核证据。')
  assert.equal('taskExecutionGuidance' in saved, false)
  assert.equal('taskEvidenceGuidance' in saved, false)
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

const inputVersion = (task) => ({ inputVersion: task.inputVersion, runSequence: task.runSequence })
const leafCall = (h, task, name, args) => h.handles.get(task.childSessionId).tools.get(name).execute(args, { agent: h.handles.get(task.childSessionId).agent })
async function checkpoint(h, task, patch) {
  const previous = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId
  const args = { ...inputVersion(task), summary: '核验检查点', evidence: ['执行证据'], completedItems: [], remainingItems: [], nextStep: '继续', needsCoordinatorDecision: false, ...patch }
  const pending = leafCall(h, task, 'submit_task_checkpoint', args)
  if (args.kind === 'stage-completed' && args.needsCoordinatorDecision === false && args.evidence.length > 0) return pending
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }))
  await until(() => h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId !== previous)
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '检查点证据与目标一致' } })).status, 'accepted')
  const result = await outcome
  if (result.error) throw result.error
  return result.value
}
async function fullCheckpoints(h, task) {
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验正常分支', '核验异常分支'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: task.stageTasks[0], completedItems: ['核验正常分支'], remainingItems: ['核验异常分支'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: task.stageTasks[0], completedItems: ['核验异常分支'], remainingItems: [] })
}
async function completeResult(h, task, accepted = true) {
  const previous = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')?.requestId
  const result = { ...inputVersion(task), status: 'completed', summary: '已核验全部范围', evidence: ['正常与异常测试通过'], artifacts: [] }
  const submitted = leafCall(h, task, 'submit_task_result', result)
  const outcome = submitted.then((value) => ({ value }), (error) => ({ error }))
  await until(() => h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')?.requestId !== previous)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: request.requestId, review: { accepted, reason: accepted ? '全部证据齐全' : '缺少部署后的核验' } })
  return outcome
}

test('叶子结果与检查点拒绝缺失或过期 inputVersion/runSequence', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = { status: 'waiting', waitingKind: 'information', summary: '缺少输入', waitingReason: '缺少范围', questions: ['范围是什么？'], evidence: [], artifacts: [] }
  await assert.rejects(leafCall(h, task, 'submit_task_result', result))
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...result, inputVersion: task.inputVersion + 1, runSequence: task.runSequence }), /task_input_version_stale/)
  const value = { inputVersion: 9, runSequence: 1, kind: 'plan-confirmed', summary: '旧计划', remainingItems: ['一', '二'], nextStep: '核验' }
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', value), /task_input_version_stale/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal((h.store.getTask(task.taskId).checkpoints ?? []).length, 0)
})

test('检查点逐项推进并由结构化内部审阅确认，不能跳项完成', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['一', '二'] })
  await assert.rejects(leafCall(h, task, 'submit_task_checkpoint', { ...inputVersion(task), kind: 'stage-completed', stageTask: task.stageTasks[0], summary: '跳项', completedItems: ['一', '二'], remainingItems: [], nextStep: '结束' }), /task_checkpoint_must_advance_one/)
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'], artifacts: [] }), /task_checkpoints_insufficient|task_checkpoints_remaining/)
  assert.equal(h.store.getTask(task.taskId).checkpoints.length, 1)
  assert.equal(h.store.getGroup('g').outbox.length, 1, '内部审阅不能发群消息')
})

test('完成验收拒绝后保持 running 并向叶子发送具体纠偏', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await fullCheckpoints(h, task)
  const outcome = await completeResult(h, task, false)
  assert.match(outcome.error.message, /task_result_objective_not_covered/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.ok(h.handles.get(task.childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_RESULT_REJECTED]')))
  assert.equal(h.store.getGroup('g').outbox.length, 1)
})

test('完成落盘与通知解耦，Resident 未回复时 FIFO 下个任务仍启动', async (t) => {
  const h = await setup(t), task = await createTask(h, 'first'), queued = await createTask(h, 'second')
  assert.equal(queued.state, 'queued')
  await fullCheckpoints(h, task)
  const outcome = await completeResult(h, task)
  assert.equal(outcome.value.state, 'completed')
  assert.equal(h.store.getTask(queued.taskId).state, 'running')
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 0)
  const notification = h.envelope('[TASK_COORDINATION]')
  const review = await h.call('group_reply_review_get', { requestIds: [notification.requestId] })
  const accepted = await h.call('group_reply_submit', { requestId: notification.requestId, reply: '已完成核验，正常与异常测试通过。', replyToMessageId: 'first', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })
  assert.equal(accepted.status, 'accepted')
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
  await h.runtime.reconcileCompletedNotifications()
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
})

test('尚未归类的新消息阻止叶子提交等待或完成结果', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await ingest(h, 'new-info')
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '需要输入', waitingReason: '范围未明', questions: ['范围？'], evidence: [], artifacts: [] }), /task_input_pending/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
})

test('Web 创建按 requestId 幂等，原始输入只落 Topic，参数变更不能复用身份', async (t) => {
  const h = await setup(t)
  const request = { groupId: 'g', requestId: 'web-create-1', title: 'Web 核验', objective: '核验 Web 流程', context: '请核验保存与读取', acceptanceCriteria: ['保存和读取都可验证'], stageTasks: ['核验'] }
  const task = await h.runtime.createTask(request), repeated = await h.runtime.createTask(request)
  assert.equal(task.taskId, repeated.taskId)
  assert.equal(h.store.listTasks().length, 1)
  assert.equal(h.store.getGroup('g').messages.length, 1)
  const message = h.runtime.getTopicContext({ groupId: 'g', ...task.topicRefs[0] }).messages[0]
  assert.equal(message.sourceKind, 'web')
  assert.match(message.text, /请核验保存与读取/)
  assert.equal('sourceMessageId' in task, false)
  await assert.rejects(h.runtime.createTask({ ...request, context: '不同输入' }), /identity_conflict/)
})

test('Web 补充提升输入版本并重置当前检查点，同请求重试不重复补充', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['一', '二'] })
  const request = { taskId: task.taskId, requestId: 'web-append-1', topicRefs: task.topicRefs, context: '新增异常分支范围', ...inputVersion(task) }
  const updated = await h.runtime.appendTaskContext(request)
  assert.equal(updated.inputVersion, task.inputVersion + 1)
  assert.equal(updated.runSequence, task.runSequence)
  assert.deepEqual(updated.checkpoints, [])
  assert.ok(updated.executionEvents.some((event) => event.checkpoints?.length === 1))
  const repeated = await h.runtime.appendTaskContext(request)
  assert.equal(repeated.inputVersion, updated.inputVersion)
  assert.equal(h.store.getGroup('g').messages.length, 2)
  await assert.rejects(h.runtime.appendTaskContext({ ...request, requestId: 'stale-append' }), /task_web_task-stale|task_input_version_stale/)
  const leaf = h.handles.get(task.childSessionId)
  assert.ok(leaf.sent.some((message) => message.content[0].text.includes('"inputVersion":2')))
})

test('preserve 新输入作废待审 checkpoint，并按新版本重新审阅', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const value = { ...inputVersion(task), kind: 'plan-confirmed', summary: '初始计划', completedItems: [], evidence: [], remainingItems: ['核验'], nextStep: '核验', needsCoordinatorDecision: false }
  const pending = leafCall(h, task, 'submit_task_checkpoint', value)
  await until(() => Boolean(h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')))
  await h.runtime.inspectRunningTasks()
  assert.equal(h.resident().sent.filter((message) => message.content[0].text.startsWith('[TASK_CHECKPOINT_REVIEW]')).length, 1)
  const request = { taskId: task.taskId, requestId: 'preserve-pending', topicRefs: task.topicRefs, context: '补充核验地址，不改变范围', progressImpact: 'preserve', ...inputVersion(task) }
  const updated = await h.runtime.appendTaskContext(request)
  assert.equal(updated.inputVersion, 2)
  assert.deepEqual(updated.checkpoints, [])
  assert.equal(updated.executionEvents.at(-1).checkpoints.length, 1)
  const oldReview = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  assert.equal((await h.call('group_task_review_submit', { requestId: oldReview.requestId, review: { decision: 'acknowledge', reason: '旧审阅' } })).status, 'task-stale')
  await assert.rejects(pending, /task_review_context_changed/)
  await checkpoint(h, updated, { kind: 'plan-confirmed', remainingItems: ['核验'] })
  assert.equal(h.store.getTask(task.taskId).checkpoints[0].inputVersion, 2)
})

test('旧执行轮次的 idle 回收不释放已重开的叶子', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: task.stageTasks[0], completedItems: ['核验'], remainingItems: [] })
  let release
  h.idle.set(task.childSessionId, new Promise((resolve) => { release = resolve }))
  const completion = completeResult(h, task)
  const review = await completion
  assert.equal(review.value.state, 'completed')
  const completed = h.store.getTask(task.taskId)
  const reopened = await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'reopen-before-old-idle', topicRefs: completed.topicRefs, context: '重新核验', ...inputVersion(completed) })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.disposed.includes(task.childSessionId), false)
  await checkpoint(h, reopened, { kind: 'plan-confirmed', remainingItems: ['重新核验'] })
  assert.equal(h.store.getTask(task.taskId).state, 'running')
})

test('人工批准与排队启动竞争时不突破并发上限', async (t) => {
  let release, entered = false, blockedId
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { maxConcurrentTasks: 1, beforeCreate: async (input) => { if (String(input.sessionId) === blockedId) { entered = true; await gate } } })
  t.after(() => release())
  const waiting = await createTask(h, 'waiting')
  await leafCall(h, waiting, 'submit_task_result', { ...inputVersion(waiting), status: 'waiting', waitingKind: 'human-intervention', summary: '需要许可', evidence: ['隔离证据'], artifacts: [], waitingReason: '需要许可', blockerCategory: 'redline', requestedAction: '执行隔离测试', risk: '测试环境' })
  const running = await createTask(h, 'running')
  const queued = await createTask(h, 'queued')
  blockedId = queued.childSessionId
  await h.runtime.cancelTask({ taskId: running.taskId, requestId: 'release-capacity', topicRefs: running.topicRefs, ...inputVersion(running), reason: '释放容量' })
  await until(() => entered)
  await h.runtime.decideAuthorization({ requestId: h.store.getTask(waiting.taskId).humanBlocker.requestId, decision: 'approved', comment: '批准测试' })
  assert.equal(h.store.getTask(waiting.taskId).state, 'queued')
  assert.equal(h.store.listTasks().filter((task) => task.state === 'running').length, 0)
  release()
  await until(() => h.store.getTask(queued.taskId).state === 'running')
  assert.equal(h.store.listTasks().filter((task) => task.state === 'running').length, 1)
})

test('Web 重开完成任务建立新轮次，固定保留旧输入版本与历史', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await h.runtime.cancelTask({ taskId: task.taskId, requestId: 'cancel-before-reopen', topicRefs: task.topicRefs, ...inputVersion(h.store.getTask(task.taskId)), reason: '先停止' })
  const completed = h.store.getTask(task.taskId)
  const reopened = await h.runtime.reopenTask({ taskId: task.taskId, requestId: 'web-reopen-1', topicRefs: completed.topicRefs, context: '继续核验剩余范围', ...inputVersion(completed) })
  assert.equal(reopened.state, 'running')
  assert.equal(reopened.runSequence, completed.runSequence + 1)
  assert.equal(reopened.inputVersion, completed.inputVersion + 1)
  assert.equal(reopened.runHistory.length, 1)
  assert.deepEqual(reopened.runHistory[0].topicRefs, completed.topicRefs)
  assert.equal(h.store.listTasks().length, 1)
  for (const field of ['messageHistory', 'sourceMessageId', 'triggerHistory', 'relatedContexts']) assert.equal(field in reopened.runHistory[0], false)
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

test('人工授权重发、引用校验、批准幂等及已批准范围复用', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const requested = []
  h.runtime.onHumanBlockerRequested((value) => { requested.push(value) })
  const result = { ...inputVersion(task), status: 'waiting', waitingKind: 'human-intervention', summary: '等待批准', evidence: ['范围已核验'], artifacts: [], waitingReason: '需要批准发布', blockerCategory: 'redline', risk: '影响服务', attemptedActions: ['完成预检'], requestedAction: '批准发布本次补丁' }
  await leafCall(h, task, 'submit_task_result', result)
  await until(() => requested.length === 1)
  const original = h.store.getTask(task.taskId).humanBlocker
  assert.equal(h.goals.get(task.childSessionId).phase, 'blocked')
  await h.runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: original.requestId, openTaskId: 'approval-1', conversationId: 'approval-chat', messageId: 'approval-msg-1', sentAt: '2026-09-07T01:00:00Z', formatVersion: 3 })
  const reissued = await h.runtime.reissueAuthorization({ requestId: original.requestId, reason: '重发结构化审批' })
  assert.equal(h.runtime.getAuthorizationRequest(original.requestId).status, 'superseded')
  assert.equal(h.runtime.getAuthorizationRequest(original.requestId).recallStatus, 'pending')
  await assert.rejects(h.runtime.decideAuthorization({ requestId: original.requestId, decision: 'approved' }), /authorization_request_not_pending/)
  await h.runtime.recordHumanBlockerDelivery({ taskId: task.taskId, requestId: reissued.request.requestId, conversationId: 'approval-chat', messageId: 'approval-msg-2', sentAt: '2026-09-07T01:01:00Z', formatVersion: 3 })
  await assert.rejects(h.runtime.resolveHumanBlocker({ taskId: task.taskId, requestId: reissued.request.requestId, quotedMessageId: 'wrong', replyMessageId: 'reply1', reply: '批准', decision: 'approved' }), /human_blocker_reply_mismatch/)
  const approved = await h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'approved', comment: '范围内批准' })
  const repeated = await h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'approved' })
  assert.equal(approved.requestId, repeated.requestId)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
  const before = requested.length
  await leafCall(h, task, 'submit_task_result', result)
  await immediate()
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(requested.length, before, '相同已批准范围不得重复发起审批')
  await assert.rejects(h.runtime.decideAuthorization({ requestId: reissued.request.requestId, decision: 'rejected' }), /authorization_decision_conflict/)
})

test('Goal 耗尽转真实 waiting，正常 turn 结束只记录活动不完成 Task', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const event = { seq: 999, type: 'turn/end', data: { status: 'success' } }
  h.events.get('session/event')({ id: task.childSessionId }, event); h.events.get('session/event')({ id: task.childSessionId }, event)
  await h.runtime.flushActivities()
  assert.equal(h.runtime.listActivities().length, 1)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  h.goals.set(task.childSessionId, { ...h.goals.get(task.childSessionId), phase: 'blocked', activation: 'disarmed', roundsStarted: 24, maxGoalRounds: 24 })
  const inspected = await h.runtime.inspectRunningTasks()
  assert.equal(inspected.find((item) => item.taskId === task.taskId).exhausted, true)
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).result.inputVersion, task.inputVersion)
})

test('叶子异常暂停最多重建两次，继续失败升级为人工阻塞', async (t) => {
  const h = await setup(t), task = await createTask(h)
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = h.store.getTask(task.taskId), handle = h.handles.get(current.childSessionId)
    handle.agent.status = 'idle'
    h.goals.set(current.childSessionId, { ...h.goals.get(current.childSessionId), phase: 'paused', activation: 'disarmed' })
    const inspected = await h.runtime.inspectRunningTasks()
    if (attempt < 2) {
      assert.equal(inspected[0].sessionRecovered, true)
      assert.notEqual(h.store.getTask(task.taskId).childSessionId, current.childSessionId)
      assert.ok(h.handles.get(h.store.getTask(task.taskId).childSessionId).sent.some((message) => message.content[0].text.includes('[TASK_TOPIC_CONTEXT]')))
    }
  }
  assert.equal(h.store.getTask(task.taskId).state, 'waiting')
  assert.equal(h.store.getTask(task.taskId).humanBlocker.category, 'unexpected')
})

test('Resident 恢复超时由原生 AbortSignal 隔离，不阻止下一群恢复', { timeout: 2_000 }, async (t) => {
  const h = await setup(t, { groups: ['g', 'b'], resumeTimeoutMs: 10, beforeResume: (input) => {
    if (input.resumeSessionId !== residentSessionId('g')) return
    return new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); input.signal.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal.reason) }, { once: true }) })
  } })
  assert.ok(h.runtime.listRecoveryIssues().some((item) => item.groupId === 'g' && /timeout|timed out/i.test(item.error)))
  assert.ok(h.resident('b'))
})

test('恢复清理旧协议与旧 Topic 请求 Inbox，但保留普通待办', async (t) => {
  const messages = ['[GROUP_MESSAGE_STEER]', '[GROUP_TOPIC_ROUTE]', '[GROUP_TOPIC_DECISION]', '普通待办'].map((text, index) => ({ id: `m${index}`, content: [{ type: 'text', text }] }))
  const removed = []
  const h = await setup(t, { inbox: { nextStep: messages, nextTurn: [], remove(id) { removed.push(id); return true } } })
  assert.deepEqual(removed, ['m0', 'm1', 'm2'])
  assert.ok(h.resident())
})

test('重启恢复 Running 叶子沿用 Goal 与已接纳输入，不重复 steer 同版本', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const sessionEvents = new Map([...h.handles].map(([id, handle]) => [id, handle.agent.session.snapshotEvents()]))
  await h.runtime.close()
  const recovered = await setup(t, { snapshot: h.snapshot, goals: h.goals, sessionEvents })
  assert.equal(recovered.store.getTask(task.taskId).state, 'running')
  assert.equal(recovered.handles.get(task.childSessionId).sent.length, 0)
  assert.equal(recovered.goals.get(task.childSessionId).phase, 'active')
})

test('关闭等待已接受的可靠 Outbox 写入，期间新消息被拒绝', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  let release, entered
  const gate = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { entered = resolve })
  const original = h.store.appendOutbox
  h.store.appendOutbox = async (args) => { entered(); await gate; return original(args) }
  const accepted = await h.call('group_decision_submit', { requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision: { basisMessageIds: ['a'], actions: [], reply: '可靠回复', replyReview: { kind: 'substantive' } } })
  assert.equal(accepted.status, 'accepted'); await started
  let closed = false
  const closing = h.runtime.close().then(() => { closed = true })
  await immediate(); assert.equal(closed, false)
  await assert.rejects(ingest(h, 'late'), /resident_runtime_closed/)
  release(); await closing
  const records = h.snapshot.tables.groups
  assert.equal(Object.values(records)[0].outbox.length, 1)
})

test('替换确认先持久化意图，渠道准备时精确撤回已回读的旧消息', async (t) => {
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
  assert.deepEqual(recalls, ['actual-old-message'])
  assert.equal(h.store.getGroup('g').outbox[0].recallStatus, 'recalled')
})

test('未回读的旧确认不允许渠道发送替换消息，持久意图保留可恢复', async (t) => {
  const h = await setup(t); await ingest(h, 'a'); const request = (await route(h)).pendingDecisions[0]
  await decide(h, request, { reply: '旧确认', replyReview: { kind: 'confirmation' } })
  const old = h.store.getGroup('g').outbox[0]
  await ingest(h, 'a2'); const revised = (await route(h, { a2: request.topicId })).pendingDecisions[0]
  const candidates = await h.call('group_reply_review_get', { requestIds: [revised.requestId] })
  await decide(h, revised, { reply: '新的确认', replyReview: { kind: 'confirmation', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [old.outboundId], replaceOutboundIds: [old.outboundId] } })
  h.runtime.registerGroupMessageRecaller(async () => { assert.fail('缺真实投递ID不得调用撤回') })
  await assert.rejects(h.runtime.prepareOutbound({ groupId: 'g', outbound: h.store.getGroup('g').outbox[1] }), /readback|delivered|pending/)
  assert.equal(h.store.getGroup('g').outbox.length, 2)
})

test('等待通知在同版本 resume 清除 result 后失效，不发送旧问题', async (t) => {
  const h = await setup(t), task = await createTask(h)
  await leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '等问题一', evidence: [], artifacts: [], waitingReason: '缺少输入一', questions: ['输入一是什么？'] })
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  const old = h.envelope('[TASK_COORDINATION]')
  await h.runtime.resumeTask({ taskId: task.taskId })
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
  const reply = await h.call('group_reply_submit', { requestId: old.requestId, reply: '输入一是什么？', replyReview: { kind: 'substantive' }, replyToMessageId: 'task-input', atOpenDingTalkIds: ['od-a'] })
  assert.equal(reply.status, 'task-stale')
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 0)
})

test('同版本重新 waiting 新问题不能被旧问题的通知快照覆盖', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const result = (id) => ({ ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: `问题${id}`, evidence: [], artifacts: [], waitingReason: `缺少输入${id}`, questions: [`输入${id}是什么？`] })
  await leafCall(h, task, 'submit_task_result', result(1)); await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  const old = h.envelope('[TASK_COORDINATION]')
  await h.runtime.resumeTask({ taskId: task.taskId })
  await leafCall(h, task, 'submit_task_result', result(2)); await until(() => h.envelope('[TASK_COORDINATION]')?.requestId !== old.requestId)
  assert.equal(h.store.getTask(task.taskId).inputVersion, task.inputVersion)
  assert.equal((await h.call('group_reply_submit', { requestId: old.requestId, reply: '旧问题', replyReview: { kind: 'substantive' }, replyToMessageId: 'task-input', atOpenDingTalkIds: ['od-a'] })).status, 'task-stale')
  assert.equal(h.store.getTask(task.taskId).result.waitingReason, '缺少输入2')
})

test('等待结果原子落盘时发现新输入，Task 与 Goal 都保持 running', async (t) => {
  const h = await setup(t), task = await createTask(h)
  const original = h.store.updateTask; let injected = false
  h.store.updateTask = async (...args) => { if (!injected) { injected = true; await ingest(h, 'arrived-at-commit') } return original(...args) }
  await assert.rejects(leafCall(h, task, 'submit_task_result', { ...inputVersion(task), status: 'waiting', waitingKind: 'information', summary: '缺少输入', evidence: [], artifacts: [], waitingReason: '缺范围', questions: ['范围？'] }), /task_input_pending/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
})

test('完成审阅通过后原子落盘遇新输入，不能提前 complete Goal', async (t) => {
  const h = await setup(t), task = await createTask(h); await fullCheckpoints(h, task)
  const result = { ...inputVersion(task), status: 'completed', summary: '完成', evidence: ['证据'], artifacts: [] }
  const pending = leafCall(h, task, 'submit_task_result', result)
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')))
  const original = h.store.updateTask; let injected = false
  h.store.updateTask = async (...args) => { if (!injected) { injected = true; await ingest(h, 'arrived-after-review') } return original(...args) }
  const review = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  await h.call('group_task_review_submit', { requestId: review.requestId, review: { accepted: true, reason: '通过' } })
  assert.match((await outcome).error.message, /task_input_pending/)
  assert.equal(h.store.getTask(task.taskId).state, 'running')
  assert.equal(h.goals.get(task.childSessionId).phase, 'active')
})

test('通知 Outbox 首次失败后相同请求重试使用稳定结果键且只落一次', async (t) => {
  const h = await setup(t), task = await createTask(h); await fullCheckpoints(h, task); await completeResult(h, task)
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  const request = h.envelope('[TASK_COORDINATION]'), review = await h.call('group_reply_review_get', { requestIds: [request.requestId] })
  const original = h.store.appendOutbox; let fail = true
  h.store.appendOutbox = async (args) => { if (fail) throw new Error('outbox_storage_failure'); return original(args) }
  const args = { requestId: request.requestId, reply: '完成核验', replyToMessageId: 'task-input', atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } }
  await assert.rejects(h.call('group_reply_submit', args), /outbox_storage_failure/)
  assert.equal(h.store.getTask(task.taskId).state, 'completed')
  fail = false
  assert.equal((await h.call('group_reply_submit', args)).status, 'accepted')
  await h.runtime.reconcileCompletedNotifications()
  assert.equal(h.store.getGroup('g').outbox.filter((item) => item.sourceMessageId.startsWith('task-result:')).length, 1)
})

test('慢叶子创建期间同群其他 Topic 仍可完成', async (t) => {
  let release, entered = false
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { beforeCreate: async (input) => { if (input.meta?.origin === 'subagent') { entered = true; await gate } } })
  t.after(() => release())
  await ingest(h, 'slow-a')
  const a = (await route(h)).pendingDecisions[0]
  const result = await h.call('group_decision_submit', { requestId: a.requestId, topicId: a.topicId, revision: a.revision, decision: { basisMessageIds: ['slow-a'], actions: [{ kind: 'new-task', title: 'A', objective: '核验 A', acceptanceCriteria: ['可查'], topicRefs: [{ topicId: a.topicId, revision: a.revision }] }], reply: '开始核验。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } })
  assert.equal(result.status, 'accepted')
  await until(() => entered)
  try {
    await ingest(h, 'fast-b')
    const b = (await route(h)).pendingDecisions.find((item) => item.messages.some((message) => message.messageId === 'fast-b'))
    assert.equal((await h.call('group_decision_submit', { requestId: b.requestId, topicId: b.topicId, revision: b.revision, decision: { basisMessageIds: ['fast-b'], actions: [], reason: '独立讨论无需回复' } })).status, 'accepted')
    await until(() => h.store.getTopic('g', b.topicId).processedRevision === b.revision)
    assert.equal(h.store.listTasks()[0].state, 'queued')
  } finally { release() }
  await h.runtime.drainTopicOperations('g')
  assert.equal(h.store.listTasks()[0].state, 'running')
})

test('排队叶子启动中取消立即落盘，迟到的 Session 创建不能复活任务', async (t) => {
  let release, entered = false, blockedId
  const gate = new Promise((resolve) => { release = resolve })
  const h = await setup(t, { beforeCreate: async (input) => { if (String(input.sessionId) === blockedId) { entered = true; await gate } } })
  t.after(() => release())
  const one = await createTask(h, 'first'), two = await createTask(h, 'second')
  blockedId = two.childSessionId
  try {
    await h.runtime.cancelTask({ taskId: one.taskId, requestId: 'cancel-first-start-second', topicRefs: one.topicRefs, ...inputVersion(one), reason: '取消第一个' })
    await until(() => entered)
    await h.runtime.cancelTask({ taskId: two.taskId, requestId: 'cancel-second-during-create', topicRefs: two.topicRefs, ...inputVersion(two), reason: '取消第二个' })
    assert.equal(h.store.getTask(two.taskId).state, 'completed')
  } finally { release() }
  await until(() => h.disposed.includes(two.childSessionId))
  assert.equal(h.store.getTask(two.taskId).state, 'completed')
  assert.equal(h.goals.has(two.childSessionId), false)
  assert.equal(h.handles.get(two.childSessionId).sent.length, 0)
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

// 恢复测试从已持久完成的 Task 开始，避免通过叶子结果通路预先生成通知请求。
async function persistedCompletedTask(h, groupId = 'g') {
  const messageId = `recovered-${groupId}`
  await h.store.ingest({ groupId, messageId, text: '@助理 核验', senderOpenDingTalkId: 'od-a', occurredAt: '2026-09-07T00:00:00Z' })
  await h.store.routeMessages({ groupId, routeId: `route-${groupId}`, routingRevision: h.store.getGroup(groupId).routingRevision, routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: messageId, title: '历史核验' }] }] })
  const topic = h.store.listTopics(groupId).at(-1), decisionId = `decision-${groupId}`
  await h.store.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: 1, decisionId, decision: { basisMessageIds: [messageId], actions: [], reason: '恢复夹具' } })
  await h.store.completeTopicDecision({ groupId, topicId: topic.topicId, decisionId })
  const { task } = await h.store.createTask({ groupId, title: '历史核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: topic.topicId, revision: 1 }] })
  return h.store.updateTask(task.taskId, (current) => ({ ...current, state: 'completed', completionSequence: 1, result: { ...inputVersion(current), status: 'completed', summary: '核验通过', evidence: ['结果日志'], artifacts: [] } }))
}
async function submitNotification(h, groupId = 'g') {
  const request = h.envelope('[TASK_COORDINATION]', groupId)
  const review = await h.call('group_reply_review_get', { requestIds: [request.requestId] }, groupId)
  return h.call('group_reply_submit', { requestId: request.requestId, reply: '核验已完成，结果日志可查。', replyToMessageId: request.messages[0].messageId, atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } }, groupId)
}

test('通知补发同批跳过退订群、隔离损坏 Resident，正常群仍独立完成', async (t) => {
  const h = await setup(t, { groups: ['g', 'bad', 'gone'], resumeFailure: (id) => id === residentSessionId('bad') })
  for (const id of ['g', 'bad']) await persistedCompletedTask(h, id)
  await h.store.removeGroup({ groupId: 'gone' })
  const reconciliation = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  assert.equal((await submitNotification(h)).status, 'accepted')
  const outcome = await reconciliation
  assert.match(outcome.error.message, /task_notification_reconcile_failed:resident_not_active:bad/)
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.equal(h.store.getGroup('bad').outbox.length, 0)
  assert.equal(h.handles.get(residentSessionId('gone')).sent.length, 0)
  assert.ok(h.runtime.listRecoveryIssues().some((issue) => issue.groupId === 'bad' && issue.kind === 'task-notification-reconcile'))
  assert.equal(h.runtime.listRecoveryIssues().some((issue) => issue.groupId === 'gone' && issue.kind === 'task-notification-reconcile'), false)
})

test('工作区屏障内到达的历史导入与通知等待新 Resident，导入先前事件进入新 seed', async (t) => {
  const h = await setup(t), task = await persistedCompletedTask(h), old = h.resident(), oldId = old.agent.session.id
  await h.runtime.hydrateGroupHistory({ groupId: 'g' })
  const priorHistory = old.sent.at(-1).id
  let releaseIdle
  const idle = new Promise((resolve) => { releaseIdle = resolve })
  h.idle.set(oldId, idle)
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const importing = h.runtime.hydrateGroupHistory({ groupId: 'g' })
  const notifying = h.runtime.reconcileCompletedNotifications()
  try {
    await immediate()
    assert.equal(old.sent.filter((message) => message.content[0].text.startsWith('[GROUP_HISTORY_IMPORT]')).length, 1)
    assert.equal(h.envelope('[TASK_COORDINATION]'), undefined)
  } finally { releaseIdle() }
  await changing
  const imported = await importing
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  const current = h.resident()
  assert.notEqual(current.agent.session.id, oldId)
  assert.equal(imported.residentSessionId, current.agent.session.id)
  assert.ok(h.calls.at(-1).input.seed.some((event) => event.type === 'user/message' && event.data.id === priorHistory))
  assert.equal(old.sent.some((message) => message.content[0].text.startsWith('[TASK_COORDINATION]')), false)
  assert.equal(h.envelope('[TASK_COORDINATION]').taskId, task.taskId)
  await submitNotification(h)
  await notifying
})

test('切换工作区等待已经开始的结果通知，通知落盘前不释放旧 Resident', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const old = h.resident(), oldId = old.agent.session.id
  const notifying = h.runtime.reconcileCompletedNotifications()
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  h.idle.set(oldId, Promise.resolve())
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace })
  await immediate()
  assert.equal(h.resident(), old)
  assert.equal(h.calls.filter((call) => !call.resumed).length, 0)
  assert.equal((await submitNotification(h)).status, 'accepted')
  await notifying; await changing
  assert.equal(h.store.getGroup('g').outbox.length, 1)
  assert.ok(h.disposed.includes(oldId))
})

test('退订屏障之后的历史导入拒绝旧 Resident，等待期间其他群仍可提交', async (t) => {
  const h = await setup(t, { groups: ['g', 'b'] }), old = h.resident(), oldId = old.agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const removing = h.runtime.unsubscribe({ groupId: 'g' })
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const importing = h.runtime.hydrateGroupHistory({ groupId: 'g' }).then((value) => ({ value }), (error) => ({ error }))
  try {
    await ingest(h, 'b-live', { groupId: 'b' })
    assert.equal((await decide(h, (await route(h, {}, 'b')).pendingDecisions[0], { reply: 'B 完成' }, 'b')).status, 'accepted')
    assert.equal(old.sent.length, 0)
  } finally { releaseIdle() }
  await removing
  assert.match((await importing).error.message, /group_not_subscribed:g/)
  assert.ok(h.disposed.includes(oldId))
  assert.equal(old.sent.length, 0)
})

test('关闭与进行中工作区切换串行收口，旧和替换 Resident 均释放一次', async (t) => {
  const h = await setup(t), oldId = h.resident().agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  const closing = h.runtime.close()
  releaseIdle()
  const result = await changing
  await closing
  assert.equal(result.error, undefined)
  assert.equal(h.disposed.filter((id) => id === oldId).length, 1)
  const replacementId = h.calls.at(-1).sessionId
  assert.notEqual(replacementId, oldId)
  assert.equal(h.disposed.filter((id) => id === replacementId).length, 1)
})

test('同 Topic 一次决策不能重复改变同一 Task，共享主 Topic 可取消两个不同 Task 各一次', async (t) => {
  const h = await setup(t), one = await createTask(h, 'task-one'), two = await createTask(h, 'task-two')
  await ingest(h, 'cancel-both', { text: '@助理 两个任务都取消' })
  await h.runtime.recoverInterruptedDecisions()
  const routing = h.envelope('[GROUP_TOPIC_ROUTE]')
  const routed = await h.call('group_topic_route_submit', { requestId: routing.requestId, routes: routing.messages.map((message) => ({ messageId: message.messageId, messageVersion: message.messageVersion, topics: [{ topicId: one.topicRefs[0].topicId }, { topicId: two.topicRefs[0].topicId }] })) })
  const owner = routed.pendingDecisions.find((item) => item.topicId === one.topicRefs[0].topicId)
  const actions = [one, two].map((task) => ({ kind: 'task-cancel', taskId: task.taskId, ...inputVersion(task), reason: '用户明确取消两个任务', topicRefs: [{ topicId: owner.topicId, revision: owner.revision }] }))
  const submission = { requestId: owner.requestId, topicId: owner.topicId, revision: owner.revision, decision: { basisMessageIds: ['cancel-both'], actions: [actions[0], actions[0]], reply: '已取消这两个任务。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }
  await assert.rejects(h.call('group_decision_submit', submission), /topic_decision_task_target_duplicate/)
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
  assert.equal(b.effectOwnerTopicIds['executed-source'], a.topicId)
  assert.deepEqual(b.ownedDeltaMessageIds, [])
  const newAction = { kind: 'new-task', title: '重复原指令', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: b.topicId, revision: b.revision }] }
  await assert.rejects(h.call('group_decision_submit', { requestId: b.requestId, topicId: b.topicId, revision: b.revision, decision: { basisMessageIds: ['executed-source'], actions: [newAction], reply: '再建任务', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }), /topic_effect_owner_required/)
  assert.equal(h.store.listTasks().length, 1)
  await ingest(h, 'fresh-authorization', { text: '@助理 请另建一个独立任务，重新核验 B' })
  const fresh = (await route(h, { 'fresh-authorization': b.topicId })).pendingDecisions.find((request) => request.topicId === b.topicId)
  assert.deepEqual(fresh.ownedDeltaMessageIds, ['fresh-authorization'])
  const candidates = await h.call('group_reply_review_get', { requestIds: [fresh.requestId] })
  assert.equal((await decide(h, fresh, { basisMessageIds: ['fresh-authorization'], actions: [{ ...newAction, title: '新授权任务', topicRefs: [{ topicId: fresh.topicId, revision: fresh.revision }] }], reply: '按新授权创建独立核验任务。', replyReview: { kind: 'substantive', reviewedOutboundIds: candidates.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } })).status, 'accepted')
  assert.equal(h.store.listTasks().length, 2)
  assert.deepEqual(h.store.getTask(original.taskId).topicRefs, [a])
})

test('工作区切换等待期间不占任务提交队列，提交前复核新出现的活动任务', async (t) => {
  const h = await setup(t), old = h.resident(), oldId = old.agent.session.id
  let releaseIdle
  h.idle.set(oldId, new Promise((resolve) => { releaseIdle = resolve }))
  const beforeIdle = h.idleCalls.get(oldId) ?? 0
  const changing = h.runtime.updateAgentConfig({ workspaceDir: replacementWorkspace }).then((value) => ({ value }), (error) => ({ error }))
  await until(() => (h.idleCalls.get(oldId) ?? 0) > beforeIdle)
  try {
    const task = await h.runtime.createTask({ groupId: 'g', requestId: 'created-during-config', context: '配置等待时用户独立下达任务', title: '即时任务', objective: '核验', acceptanceCriteria: ['证据'] })
    assert.equal(task.state, 'running')
  } finally { releaseIdle() }
  assert.match((await changing).error.message, /agent_config_has_active_tasks/)
  assert.equal(h.resident(), old)
  assert.equal(h.runtime.getAgentConfig().workspaceDir, agentWorkspace)
  assert.equal(h.disposed.includes(oldId), false)
  assert.ok(h.disposed.some((id) => id !== oldId))
})

test('关闭拒绝尚未提交的结果通知且不悬挂', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const notifying = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  await h.runtime.close()
  assert.match((await notifying).error.message, /resident_runtime_closed/)
  assert.equal(Object.values(h.snapshot.tables.groups)[0].outbox.length, 0)
})

test('关闭等待已开始提交的结果通知 Outbox，不能提前关闭存储', async (t) => {
  const h = await setup(t); await persistedCompletedTask(h)
  const notifying = h.runtime.reconcileCompletedNotifications().then((value) => ({ value }), (error) => ({ error }))
  await until(() => Boolean(h.envelope('[TASK_COORDINATION]')))
  let release, entered = false
  const gate = new Promise((resolve) => { release = resolve }), original = h.store.appendOutbox
  h.store.appendOutbox = async (args) => { entered = true; await gate; return original(args) }
  const submitting = submitNotification(h).then((value) => ({ value }), (error) => ({ error }))
  await until(() => entered)
  let closed = false
  const closing = h.runtime.close().then(() => { closed = true })
  try { await immediate(); assert.equal(closed, false) } finally { release() }
  const result = await submitting
  await notifying; await closing
  assert.equal(result.error, undefined)
  assert.equal(result.value.status, 'accepted')
  assert.equal(Object.values(h.snapshot.tables.groups)[0].outbox.length, 1)
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
