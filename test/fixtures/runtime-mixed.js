import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import test, { after } from 'node:test'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { buildTaskAssociationIndex, openResidentRuntime, residentSessionId } from '../../packages/dingtalk-dsh-assistant/runtime.js'
import { openResidentStore, resolveTopicMessages, taskSessionId } from '../../packages/dingtalk-dsh-assistant/store.js'
import { stagePlanFor } from '../../packages/dingtalk-dsh-assistant/task-input-revision.js'
import { taskReports } from '../../packages/dingtalk-dsh-assistant/task-reports.js'
import { taskPlanFixture, stageOutputFixture } from './task-plan.js'
import { fingerprint, stableId } from '../../packages/dingtalk-dsh-assistant/topic-model.js'
import { startDwsBridge } from '../../packages/dingtalk-dsh-assistant/dws-bridge.js'

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
  const h = { store, snapshot, handles: new Map(), deliveries: [], calls: [], cancelled: [], disposed: [], permissions: [], goals: options.goals ?? new Map(), events: new Map(), idle: new Map(), idleCalls: new Map(), onSteer: undefined }
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
    const tools = new Map(), sections = [], restrictions = [], sent = [], guards = [], hooks = new Map()
    let cancelIdle; const cancelledIdle = new Promise(resolve => { cancelIdle = resolve })
    let completeStep; const completedStep = new Promise(resolve => { completeStep = resolve })
    // 工具返回才结束模拟步骤；显式 idle gate 仍可表示在途模型/工具尚未退出。
    // 首次工具前保持 busy，避免把仅发送初始输入误当作执行已结束。
    let toolStep, hasFinishedToolStep = false
    const agent = { session, status: 'running', inbox: options.inbox ?? { nextStep: [], nextTurn: [], remove() { return false } },
      steer(message) { sent.push(message); h.deliveries.push({ sessionId, message }); session.append('user/message', message); h.onSteer?.(sessionId, message) },
      followup(message) { sent.push(message); h.deliveries.push({ sessionId, message }); h.onSteer?.(sessionId, message) },
      whenIdle: () => { h.idleCalls.set(sessionId, (h.idleCalls.get(sessionId) ?? 0) + 1); return Promise.race([h.idle.get(sessionId) ?? toolStep?.promise ?? (hasFinishedToolStep || agent.status === 'idle' || sessionId.startsWith('session-coordination-') ? Promise.resolve() : never), cancelledIdle, completedStep]) },
      cancel(cause) { h.cancelled.push({ sessionId, cause }); cancelIdle() },
    }
    const handle = { agent, tools, sections, restrictions, sent, guards, hooks, completeStep,
      beginToolStep() {
        assert.equal(toolStep, undefined, 'fixture 每个叶子同时只能执行一个工具步骤')
        let finish; const promise = new Promise(resolve => { finish = resolve })
        toolStep = { promise, finish }
      },
      finishToolStep() { toolStep?.finish(); toolStep = undefined; hasFinishedToolStep = true },
      async dispose() { await options.disposeGate?.(sessionId); h.disposed.push(sessionId) } }
    h.handles.set(sessionId, handle)
    const agentCtx = { on(name, listener) { hooks.set(name, listener); return () => hooks.delete(name) }, tools: { register(tool) { tools.set(tool.name, tool) }, restrict(rule) { restrictions.push(rule) }, guard(check) { guards.push(check) }, get(name) { return ['read', 'glob', 'grep', 'skill'].includes(name) ? { name } : undefined } }, systemPrompt: { section(value) { sections.push(value) } } }
    const setupResult = await input.setup?.(agentCtx, agent)
    assert.equal(setupResult, undefined)
    h.calls.push({ resumed, sessionId, input })
    return handle
  }
  const selection = { provider: 'fake', model: 'fake' }
  h.defaultSelection = selection
  const ctx = {
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.sessionPersistence ? { sessionPersistence: options.sessionPersistence } : {}),
    agentDefaultModel: { currentSelection: () => ({ ...selection }), async saveSelection(value) { Object.assign(selection, value); h.savedSelection = value } },
    agents: { create: (input) => makeHandle(input, false), resume: (input) => makeHandle(input, true), get: (id) => h.handles.get(String(id))?.agent },
    subagents: { drainDescendants: async () => {} },
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
  await options.beforeRuntime?.(h)
  h.runtime = await openResidentRuntime(ctx, store, agentWorkspace, { maxConcurrentTasks: options.maxConcurrentTasks ?? 1, supervisorIntervalMs: 0, resumeTimeoutMs: options.resumeTimeoutMs ?? 10_000, decisionRetryBaseMs: options.retryDelayMs ?? 60_000, actionAdapters: options.actionAdapters, authorizeTaskAction: options.authorizeTaskAction, workflowGroupIds: options.workflowGroupIds ?? [] })
  h.resident = (groupId = 'g') => h.handles.get(store.getGroup(groupId)?.residentSessionId)
  h.messages = (groupId = 'g') => h.deliveries.filter(({ sessionId }) => sessionId === store.getGroup(groupId)?.residentSessionId || h.handles.get(sessionId)?.agent.session.snapshotEvents().some(event => event.type === 'dingtalk/coordination' && event.data.groupId === groupId)).map(item => item.message)
  h.owner = (requestId, groupId = 'g') => [...h.handles.values()].findLast(handle => handle.agent.session.snapshotEvents().some(event => event.type === 'dingtalk/coordination' && event.data.groupId === groupId && event.data.requestId === requestId))
  h.call = async (name, args, groupId = 'g', agent) => {
    const requestId = args.requestId ?? args.requestIds?.[0]
    if (requestId) await until(() => h.owner(requestId, groupId))
    const owner = requestId ? h.owner(requestId, groupId) : h.resident(groupId)
    const result = await owner.tools.get(name).execute(args, { agent: agent ?? owner.agent })
    if (requestId && result.status === 'accepted') owner.completeStep()
    if (name !== 'group_topic_route_submit' || result.status !== 'accepted') return result
    const receipt = store.getGroup(groupId).routeHistory.find((item) => item.routeId === args.requestId)
    const changedTopics = [...Object.values(receipt?.topicIdsByKey ?? {}), ...args.routes.flatMap(route => (route.topics ?? []).map(topic => topic.topicId).filter(Boolean))]
    await until(() => changedTopics.every(topicId => {
      const topic = store.getTopic(groupId, topicId)
      return topic?.processedRevision >= topic?.revision || h.messages(groupId).some(message => {
        const text = message.content[0]?.text
        if (!text?.startsWith('[GROUP_TOPIC_DECISION]')) return false
        const input = JSON.parse(text.split('\n').find(line => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length))
        return input.topicId === topicId && input.revision === topic.revision
      })
    }))
    const delivered = h.messages(groupId).filter((message) => message.content[0]?.text.startsWith('[GROUP_TOPIC_DECISION]'))
      .map((message) => JSON.parse(message.content[0].text.split('\n').find((line) => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length)))
    const pendingDecisions = delivered.filter((item) => {
      const topic = store.getTopic(groupId, item.topicId)
      return topic?.revision === item.revision && topic.processedRevision < item.revision
    })
      .map((item) => ({ ...item, messages: resolveTopicMessages(store.getGroup(groupId), item.topicId, item.revision) }))
    return { ...result, topicIdsByKey: receipt?.topicIdsByKey ?? {}, pendingDecisions }
  }
  h.envelope = (prefix, groupId = 'g', label = 'Topic 请求') => {
    const text = h.messages(groupId).findLast((message) => message.content[0]?.text.startsWith(prefix))?.content[0].text
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
  await until(() => {
    const envelope = h.envelope('[GROUP_TOPIC_ROUTE]', groupId)
    return envelope && !h.store.getGroup(groupId).routeHistory.some(item => item.routeId === envelope.requestId)
  })
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
async function createTask(h, id = 'task-input', extra = {}, source = {}) {
  await ingest(h, id, source)
  const request = (await route(h)).pendingDecisions.find((item) => item.messages.some((message) => message.messageId === id))
  const action = { kind: 'new-task', title: id, objective: `核验 ${id}`, acceptanceCriteria: ['结果可查'], stageTasks: ['核验阶段'], topicRefs: [{ topicId: request.topicId, revision: request.revision }], ...extra }
  assert.equal((await decide(h, request, { actions: [action], reply: '已收到，会继续处理。' })).status, 'accepted')
  assert.equal(h.store.getTopic('g', request.topicId).decisions.at(-1).status, 'completed', JSON.stringify(h.runtime.listRecoveryIssues()))
  const task = h.store.listTasks().find((task) => task.topicRefs.some((ref) => ref.topicId === request.topicId))
  const pendingInput = h.store.getGroup('g').messages.some(message => message.routingStatus !== 'routed')
    || task.topicRefs.some(ref => { const topic = h.store.getTopic('g', ref.topicId); return topic.processedRevision < topic.revision })
  const hasCapacity = h.store.listTasks().filter(item => item.taskId !== task.taskId && item.state === 'running').length < h.runtime.getAgentConfig().maxConcurrentTasks
  if (!pendingInput && hasCapacity) await until(() => h.store.getTask(task.taskId).state === 'running' && h.store.getTask(task.taskId).dispatchedInputVersion === task.inputVersion)
  return h.store.getTask(task.taskId)
}
const workflowAssessment = (task, patch = {}) => ({ promptRefs: task.taskPromptRefs ?? [], reusedEvidence: [], inapplicableSteps: [], exceptions: [], ...patch })

























function statusLlm(answer, calls) {
  return { async *stream(request) {
    calls.push(request)
    const input = JSON.parse(request.messages[0].content[0].text)
    const result = await answer(input)
    yield { type: 'text-delta', text: JSON.stringify(result) }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
const statusReply = input => ({ kind: 'reply', decision: {
  basisMessageIds: input.sourceMessageIds, actions: [], reply: '已有部署证据；尚未独立核验业务结果。',
  replyReview: { kind: 'substantive', reviewedOutboundIds: input.replyCandidates.map(item => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] },
} })











































































async function taskWithWorkflow(t, id) {
  const h = await setup(t)
  const config = await h.runtime.updateAgentConfig({ taskPrompts: [{ id: 'audit-flow', name: '核验流程', description: '核验任务', prompt: '第一版核验要求', enabled: true }], taskPromptsVersion: 0 })
  let task = await createTask(h, id)
  await leafCall(h, task, 'load_task_prompt', { id: 'audit-flow' })
  task = h.store.getTask(task.taskId)
  return { h, task, config }
}

























const inputVersion = (task) => ({ inputVersion: task.inputVersion, runSequence: task.runSequence })
// 契约反例直接调用此入口；业务夹具只补本轮新增的结构，不修正调用者的已有字段。
const directLeafCall = async (h, task, name, args) => {
  const handle = h.handles.get(task.childSessionId)
  handle.beginToolStep()
  try { return await handle.tools.get(name).execute(args, { agent: handle.agent }) }
  finally { handle.finishToolStep() }
}
async function prepareFixturePlan(h, task, titles, verificationPolicy = 'semantic') {
  const current = h.store.getTask(task.taskId)
  const sourceRefs = current.topicRefs.flatMap(ref => resolveTopicMessages(h.store.getGroup(current.groupId), ref.topicId, ref.revision)).map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion }))
  const sources = [...new Map(sourceRefs.map(ref => [`${ref.messageId}:${ref.messageVersion}`, ref])).values()]
  const previous = current.plan
  const criteria = current.acceptanceCriteria.map((description, i) => {
    const existing = previous?.criteria.find(item => item.description === description)
    return { key: `c${i}`, description, sourceRefs: existing?.sourceRefs ?? sources, verificationPolicy, ...(existing ? { criterionId: existing.criterionId } : {}) }
  })
  const completedTitles = previous?.stages.filter(stage => current.checkpoints?.some(item => item.kind === 'stage-completed' && item.coordinatorDecision && item.coordinatorDecision !== 'reject' && item.stageOutput?.stageId === stage.stageId)).map(stage => stage.title) ?? []
  const stageTitles = [...completedTitles.filter(title => !titles.includes(title)), ...titles]
  const stages = stageTitles.map((title, i) => ({ key: `s${i}`, title, criterionKeys: criteria.map(item => item.key), dependsOnKeys: i ? [`s${i - 1}`] : [], expectedOutputs: ['核验记录'],
    ...(previous?.stages.find(item => item.title === title) ? { stageId: previous.stages.find(item => item.title === title).stageId } : {}) }))
  return (await directLeafCall(h, task, 'task_plan_prepare', { ...inputVersion(task), draft: { criteria, stages } })).plan
}
const rawLeafCall = async (h, task, name, args) => {
  let value = { ...args }
  const current = h.store.getTask(task.taskId)
  if (name === 'submit_task_checkpoint' && value.kind === 'plan-confirmed' && !Object.hasOwn(value, 'plan')) {
    value.plan = await prepareFixturePlan(h, task, value.remainingItems ?? current.stageTasks)
  }
  if (name === 'submit_task_checkpoint' && value.kind === 'stage-completed' && !Object.hasOwn(value, 'stageOutput')) {
    // 无计划的负例只补结构样本，不写入或批准计划；Host 必须继续拒绝。
    const plan = current.plan ?? taskPlanFixture({ ...inputVersion(task), titles: [value.stageTask ?? '无计划阶段'] })
    const index = plan.stages.findIndex(stage => stage.title === value.stageTask)
    const sample = stageOutputFixture(plan, Math.max(index, 0))
    const { artifactId: _artifactId, ...artifactInput } = sample.artifact
    const artifact = await directLeafCall(h, task, 'task_artifact_register', { ...inputVersion(task), artifact: artifactInput })
    if (!Object.hasOwn(value, 'artifactRecords')) value.artifactRecords = [artifact]
    if (!Object.hasOwn(value, 'modelEvidence')) value.modelEvidence = [{ ...sample.evidence, artifactRefs: [artifact.artifactId] }]
    value.stageOutput = { ...sample.output, ...inputVersion(task), stageId: value.stageId ?? (index >= 0 ? sample.output.stageId : 'invalid-stage'), artifactRefs: [artifact.artifactId] }
  }
  if (name === 'submit_task_result' && value.status === 'completed') {
    const plan = current.plan ?? taskPlanFixture(inputVersion(task))
    if (!Object.hasOwn(value, 'planRevision')) value.planRevision = plan.revision
    if (!Object.hasOwn(value, 'criterionReviews')) value.criterionReviews = plan.criteria.map(criterion => {
      const evidenceRefs = current.checkpoints?.flatMap(checkpoint => checkpoint.modelEvidence ?? []).filter(evidence => evidence.criterionIds.includes(criterion.criterionId)).map(evidence => evidence.evidenceId) ?? []
      return { criterionId: criterion.criterionId, evidenceRefs: evidenceRefs.length ? evidenceRefs : ['missing-evidence-for-negative-case'], verdict: 'pass', reason: '夹具中的逐项语义审阅' }
    })
  }
  return directLeafCall(h, task, name, value)
}












// 既有业务验收等待持久报告处理结果；独立 receipt 测试直接调用 rawLeafCall。
const leafCall = async (h, task, name, args) => {
  const waiting = name === 'submit_task_result' && args.status === 'waiting' && args.waitingKind !== 'coordination'
  const previousReview = waiting ? h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')?.requestId : undefined
  const submitted = waiting && !args.blockedItems ? { ...args, blockedItems: [blockedItem(h, task, args.waitingReason)] } : args
  const value = await rawLeafCall(h, task, name, submitted)
  if (!['submit_task_checkpoint', 'submit_task_result'].includes(name)) return value
  const waitingForInput = () => taskReports(h.store.getTask(task.taskId)).find(report => report.submissionId === value.submissionId)?.status === 'input-wait'
  if (waitingForInput()) return value
  if (waiting) {
    await until(() => waitingForInput() || !['pending', undefined].includes(h.runtime.getTaskReport({ taskId: task.taskId, submissionId: value.submissionId })?.reviewStatus) || h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')?.requestId !== previousReview)
    const current = h.runtime.getTaskReport({ taskId: task.taskId, submissionId: value.submissionId })
    if (waitingForInput()) return current
    if (current.reviewStatus === 'pending') {
      const request = h.envelope('[TASK_WAITING_REVIEW]', 'g', '审阅请求')
      assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'approve-wait', reason: '来源消息明确要求当前 Agent 完成交付，所需输入仍缺失' } })).status, 'accepted')
    }
  }
  let report = value
  await until(() => { report = h.runtime.getTaskReport({ taskId: task.taskId, submissionId: value.submissionId }); return report.reviewStatus !== 'pending' || waitingForInput() })
  if (waitingForInput()) return report
  if (report.error) throw new Error(report.error)
  if (report.reviewStatus === 'stale') throw new Error('task_result_context_changed:history-only')
  return name === 'submit_task_checkpoint' ? report.result : h.store.getTask(task.taskId)
}
const blockedItem = (h, task, dependency) => ({ requirement: task.objective, basisMessageIds: [resolveTopicMessages(h.store.getGroup(task.groupId), task.topicRefs[0].topicId, task.topicRefs[0].revision)[0].messageId], dependency, reason: '测试夹具中的本职工作缺少必要输入' })
async function checkpoint(h, task, patch) {
  const previous = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId
  const args = { ...inputVersion(task), summary: '核验检查点', evidence: ['执行证据'], completedItems: [], remainingItems: [], nextStep: '继续', needsCoordinatorDecision: false, ...patch }
  const pending = leafCall(h, task, 'submit_task_checkpoint', args)
  if (args.kind === 'stage-completed' && args.needsCoordinatorDecision === false && args.evidence.length > 0) return pending
  let settled
  const outcome = pending.then((value) => ({ value }), (error) => ({ error })).then(result => { settled = result; return result })
  await until(() => settled || h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')?.requestId !== previous)
  if (settled?.error) throw settled.error
  if (settled) return settled.value
  const request = h.envelope('[TASK_CHECKPOINT_REVIEW]', 'g', '审阅请求')
  if ((args.kind === 'plan-confirmed' || args.kind === 'stage-completed') && request.promptRefs?.length) await h.call('group_task_prompt_get', { requestId: request.requestId, ids: request.promptRefs.map((ref) => ref.id) })
  assert.equal((await h.call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '检查点证据与目标一致' } })).status, 'accepted')
  const result = await outcome
  if (result.error) throw result.error
  return result.value
}
async function fullCheckpoints(h, task) {
  await checkpoint(h, task, { kind: 'plan-confirmed', remainingItems: ['核验正常分支', '核验异常分支'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验正常分支', completedItems: ['核验正常分支'], remainingItems: ['核验异常分支'] })
  await checkpoint(h, task, { kind: 'stage-completed', stageTask: '核验异常分支', completedItems: ['核验异常分支'], remainingItems: [] })
}
async function completeResult(h, task, accepted = true, patch = {}, reviewPatch = {}) {
  const previous = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')?.requestId
  const result = { ...inputVersion(task), status: 'completed', summary: '已核验全部范围', evidence: ['正常与异常测试通过'], artifacts: [], ...patch }
  const submitted = leafCall(h, task, 'submit_task_result', result)
  const outcome = submitted.then((value) => ({ value }), (error) => ({ error }))
  await until(() => h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')?.requestId !== previous)
  const request = h.envelope('[TASK_COMPLETION_REVIEW]', 'g', '审阅请求')
  if (request.promptRefs?.length) await h.call('group_task_prompt_get', { requestId: request.requestId, ids: request.promptRefs.map((ref) => ref.id) })
  const replyReview = accepted ? await h.call('group_reply_review_get', { requestIds: [request.requestId] }) : { candidates: [] }
  await h.call('group_task_review_submit', { requestId: request.requestId, review: accepted
    ? { accepted: true, reason: '全部证据齐全', notification: { reply: '已完成核验，正常与异常测试通过。', replyToMessageId: task.title, atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: replyReview.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } }, ...reviewPatch }
    : { accepted: false, reason: '缺少部署后的核验' } })
  return outcome
}























































































































// 恢复测试从已持久完成的 Task 开始，避免通过叶子结果通路预先生成通知请求。
async function persistedCompletedTask(h, groupId = 'g') {
  const messageId = `recovered-${groupId}`
  await h.store.ingest({ groupId, messageId, text: '@助理 核验', senderOpenDingTalkId: 'od-a', occurredAt: '2026-09-07T00:00:00Z' })
  await h.store.routeMessages({ groupId, routeId: `route-${groupId}`, routingRevision: h.store.getGroup(groupId).routingRevision, routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: messageId, title: '历史核验' }] }] })
  const topic = h.store.listTopics(groupId).at(-1), decisionId = `decision-${groupId}`
  await h.store.acceptTopicDecision({ groupId, topicId: topic.topicId, revision: 1, decisionId, decision: { basisMessageIds: [messageId], actions: [], reason: '恢复夹具' } })
  await h.store.completeTopicDecision({ groupId, topicId: topic.topicId, decisionId })
  const { task } = await h.store.createTask({ groupId, title: '历史核验', objective: '核验', acceptanceCriteria: ['证据'], topicRefs: [{ topicId: topic.topicId, revision: 1 }] })
  return h.store.updateTask(task.taskId, current => {
    const result = { ...inputVersion(current), status: 'completed', summary: '核验通过', evidence: ['结果日志'], artifacts: [] }, at = new Date().toISOString()
    return { ...current, state: 'completed', outcome: 'succeeded', completionSequence: 1, result,
      notificationIntents: [{ intentId: `intent-${task.taskId}`, outboundId: `outbound-${task.taskId}`, ...inputVersion(current), resultFingerprint: fingerprint(result), sourceMessageId: `task-result:${task.taskId}:completed:1`, status: 'pending', createdAt: at, updatedAt: at }] }
  })
}
async function submitNotification(h, groupId = 'g') {
  const request = h.envelope('[TASK_COORDINATION]', groupId)
  const review = await h.call('group_reply_review_get', { requestIds: [request.requestId] }, groupId)
  return h.call('group_reply_submit', { requestId: request.requestId, reply: '核验已完成，结果日志可查。', replyToMessageId: request.messages[0].messageId, atOpenDingTalkIds: ['od-a'], replyReview: { kind: 'substantive', reviewedOutboundIds: review.candidates.map((item) => item.outboundId), sameMatterOutboundIds: [], replaceOutboundIds: [] } }, groupId)
}

















































export { assert, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, execFileSync, tmpdir, join, pathToFileURL, createHash, after, DomainFacility, assertSupportedJsonSchema, buildTaskAssociationIndex, openResidentRuntime, residentSessionId, openResidentStore, resolveTopicMessages, taskSessionId, stagePlanFor, taskReports, taskPlanFixture, stageOutputFixture, fingerprint, stableId, startDwsBridge, agentWorkspace, replacementWorkspace, memoryFacility, immediate, until, setup, ingest, route, decide, createTask, workflowAssessment, statusLlm, statusReply, taskWithWorkflow, inputVersion, directLeafCall, prepareFixturePlan, rawLeafCall, leafCall, blockedItem, checkpoint, fullCheckpoints, completeResult, persistedCompletedTask, submitNotification }
