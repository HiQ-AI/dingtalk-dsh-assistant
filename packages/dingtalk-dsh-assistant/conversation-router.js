import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { toToolJsonSchema } from './tool-schema.js'
import { acceptanceCriteriaSchema, taskContextProgressImpactSchema, assertTaskContextSemantics } from './task-input-contract.js'
import { createConversationRouterSessions } from './conversation-router-session.js'
import { sessionWorkspace } from './session-workspaces.js'
import { taskModelSelection } from './task-model-config.js'
import { routerReplyCandidates, validateRouterReplyReview } from './store.js'
import { assertGroupReply } from './group-message.js'
import { groupNotificationFields, groupNotificationInstructions, groupNotificationRouting } from './group-notification.js'

export function createRouterSourceExposure({ batchId, sources, context }) {
  if (typeof batchId !== 'string' || !batchId || !Array.isArray(sources)) throw new Error('router_exposure_invalid')
  const originals = new Map(), snapshots = new Map()
  for (const source of sources) {
    if (typeof source?.sourceId !== 'string' || !source.sourceId || originals.has(source.sourceId)) throw new Error('router_exposure_invalid')
    originals.set(source.sourceId, JSON.stringify(source))
    snapshots.set(source.sourceId, structuredClone(source))
  }
  const initial = [...originals].map(([sourceId, text]) => ({ sourceId, text: text.slice(0, 1000), totalLength: text.length }))
  const initialIds = new Set(initial.map(item => item.sourceId))
  function admit(source) {
    if (typeof source?.sourceId !== 'string' || !source.sourceId) throw new Error('router_exposure_invalid')
    const text = JSON.stringify(source), previous = originals.get(source.sourceId)
    if (previous !== undefined && previous !== text) throw new Error('router_source_identity_conflict')
    originals.set(source.sourceId, text)
    snapshots.set(source.sourceId, structuredClone(source))
  }
  const message = createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify({ batchId, sources: initial, ...(context === undefined ? {} : { context }) }) }] })
  function assertContextVisible(agent) {
    if (!agent.session.deriveMessages().some(value => value.role === 'user' && value.id === message.id
      && JSON.stringify(value.content) === JSON.stringify(message.content))) throw new Error('router_context_unread')
  }
  function read({ sourceId, offset, limit = 4000 }) {
    const text = originals.get(sourceId)
    if (text === undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('router_source_read_invalid')
    const nextOffset = Math.min(text.length, offset + limit)
    return { batchId, sourceId, offset, nextOffset, totalLength: text.length, text: text.slice(offset, nextOffset) }
  }
  function assertVisible(agent, sourceIds) {
    const messages = agent.session.deriveMessages()
    const visible = messages.some(value => value.role === 'user' && value.id === message.id
      && JSON.stringify(value.content) === JSON.stringify(message.content))
    const calls = new Map(messages.filter(value => value.role === 'assistant').flatMap(value => value.content ?? [])
      .filter(block => block.type === 'tool-call').map(block => [block.id, block.name]))
    const pages = []
    for (const value of messages) {
      if (value.role !== 'tool' || value.isError || calls.get(value.toolCallId) !== 'router_source_read') continue
      try {
        const page = JSON.parse((value.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'))
        if (page.batchId === batchId) pages.push(page)
      } catch { continue }
    }
    for (const sourceId of sourceIds) {
      const text = originals.get(sourceId)
      if (text === undefined) throw new Error('router_source_unadmitted')
      let offset = visible && initialIds.has(sourceId) ? Math.min(1000, text.length) : 0
      while (offset < text.length) {
        const next = Math.max(offset, ...pages.filter(page => page.sourceId === sourceId && Number.isSafeInteger(page.offset)
          && Number.isSafeInteger(page.nextOffset) && page.offset >= 0 && page.offset <= offset && page.nextOffset > offset
          && page.nextOffset <= text.length && page.totalLength === text.length
          && text.slice(page.offset, page.nextOffset) === page.text).map(page => page.nextOffset))
        if (next === offset) throw new Error('router_source_unread')
        offset = next
      }
    }
  }
  function tool(assertCurrent, loadSource) {
    return { name: 'router_source_read', description: '分页读取本轮准入来源的完整内容。',
      parameters: { type: 'object', properties: { sourceId: { type: 'string' }, offset: { type: 'integer' },
        limit: { type: 'integer' } }, required: ['sourceId', 'offset'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        await assertCurrent(exec.agent)
        if (!originals.has(args.sourceId) && loadSource) {
          const source = await loadSource(args.sourceId)
          if (source?.sourceId !== args.sourceId) throw new Error('router_source_unadmitted')
          await assertCurrent(exec.agent)
          admit(source)
        }
        return read(args)
      },
    }
  }
  return { message, admit, read, tool, assertVisible, assertContextVisible, source: id => structuredClone(snapshots.get(id)),
    sources: () => structuredClone([...snapshots.values()]) }
}

const routerText = z.string().trim().min(1)
const routerDependencies = z.array(z.strictObject({ taskId: routerText, requirementRevision: z.number().int().positive(),
  contextRevision: z.number().int().nonnegative(), controlRevision: z.number().int().positive(), runSequence: z.number().int().positive() })).min(1)
const routerActionBasis = { sourceIds: z.array(routerText).min(1), dependencies: routerDependencies.optional(), retryOfOperationId: routerText.optional() }
const routerTaskVersion = { taskId: routerText, inputVersion: z.number().int().positive().describe('router_task_get 返回的 requirementRevision'),
  runSequence: z.number().int().positive(), expectedControlRevision: z.number().int().positive().describe('router_task_get 返回的 controlRevision') }
const routerTaskChanges = { title: routerText.optional(), objective: routerText.optional(), acceptanceCriteria: acceptanceCriteriaSchema.optional() }
const routerNewTask = { kind: z.literal('new-task').describe('独立交付才新建；同一事项按任务状态使用 task-context 或 task-reopen。'),
  title: routerText, objective: routerText, acceptanceCriteria: acceptanceCriteriaSchema.optional(), ...routerActionBasis }
const routerActionSchema = z.union([
  z.strictObject(routerNewTask),
  z.strictObject({ kind: z.literal('new-task'), sourceIds: routerActionBasis.sourceIds, arrangementId: routerText, dependencies: routerDependencies })
    .describe('激活已保存安排：仅填写安排身份、原来源及已读取的前置任务版本，不另填任务标题、目标或taskId。'),
  z.strictObject({ ...routerNewTask, taskId: routerText, arrangementId: routerText.optional(), retryOfOperationId: routerText })
    .describe('重试明确未执行的新建动作：保留 context.retries 中原动作及任务身份，仅更新 dependencies。'),
  z.strictObject({ kind: z.literal('task-context').describe('向未完成原任务补充上下文；必须明确 preserve 或 replan。'),
    ...routerTaskVersion, ...routerActionBasis, context: routerText, ...routerTaskChanges, progressImpact: taskContextProgressImpactSchema,
    authorizationChange: z.enum(['none', 'changed']).optional(), stageTasks: z.array(routerText).optional(),
    impactEvidence: z.strictObject({ basisMessageIds: z.array(routerText).min(1), reason: routerText, affectedStageIds: z.array(routerText).min(1) }).optional(),
    factFeedback: z.literal(true).optional() }),
  z.strictObject({ kind: z.literal('task-reopen').describe('已完成原任务获得开发、修订或提测等后续授权时重开，复用原Task和会话。'),
    ...routerTaskVersion, ...routerActionBasis, context: routerText, ...routerTaskChanges }),
  z.strictObject({ kind: z.literal('task-cancel').describe('按真实来源权限取消原任务。'), ...routerTaskVersion, ...routerActionBasis, reason: routerText }),
])

function assertFailedTaskActionsHandled(agent, current, candidate) {
  const messages = agent.session.deriveMessages()
  const start = messages.findLastIndex(message => message.id === current.exposure.message.id)
  if (start < 0) throw new Error('router_batch_unread')
  const calls = new Map(), failedSourceIds = new Set(current.unresolvedTaskSources ?? [])
  // 从真实工具历史读取，包含进入 execute 前被原生 Schema 拒绝的候选；只看当前批次。
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'assistant') for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && block.name === 'router_submit') calls.set(block.id, block.arguments)
    }
    if (message.role !== 'tool' || !message.isError || !calls.has(message.toolCallId)) continue
    let failed
    try { failed = JSON.parse(calls.get(message.toolCallId)) } catch { continue }
    if (!Array.isArray(failed.actions) || !failed.actions.length) continue
    const ids = failed.actions.flatMap(action => Array.isArray(action?.sourceIds) ? action.sourceIds : [])
      .filter(id => typeof id === 'string' && current.exposure.source(id))
    for (const id of ids.length ? ids : current.batch.inputs.filter(item => item.kind === 'source').map(item => item.sourceRef.sourceId)) failedSourceIds.add(id)
  }
  const handled = new Set([...candidate.actions, ...(candidate.arrangements ?? [])].flatMap(item => item.sourceIds))
  if ([...failedSourceIds].some(id => !handled.has(id))) {
    current.submissionError = new Error('router_task_action_unresolved')
    throw current.submissionError
  }
}

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
function assertReplyReview(agent, read, review) {
  validateRouterReplyReview(review, read.candidates)
  const messages = agent.session.deriveMessages()
  if (!messages.some(message => message.role === 'assistant' && message.content?.some(block => block.type === 'tool-call'
    && block.id === read.callId && block.name === 'router_reply_review_get'))
    || !messages.some(message => message.role === 'tool' && !message.isError && message.toolCallId === read.callId
      && message.content?.some(block => block.type === 'text' && block.text === JSON.stringify({ sourceId: read.sourceId, candidates: read.candidates })))) throw new Error('router_reply_review_unread')
}


export function assertRouterDependencies(agent, taskReads, dependencies) {
  if (!Array.isArray(dependencies) || !dependencies.length
    || new Set(dependencies.map(item => item?.taskId)).size !== dependencies.length) throw new Error('router_dependency_invalid')
  for (const dependency of dependencies) {
    const seen = taskReads.get(dependency?.taskId)
    const visible = seen && agent.session.deriveMessages().some(message => message.role === 'tool' && !message.isError
      && message.toolCallId === seen.callId && message.content?.some(block => block.type === 'text' && block.text === JSON.stringify(seen.result)))
    if (!visible) throw new Error('router_dependency_unread')
    const task = seen.result.task ?? seen.result
    if (Object.keys(dependency).sort().join(',') !== 'contextRevision,controlRevision,requirementRevision,runSequence,taskId'
      || ['requirementRevision', 'contextRevision', 'controlRevision', 'runSequence'].some(key => !Number.isSafeInteger(dependency[key]) || dependency[key] !== task[key])) throw new Error('router_dependency_stale')
    if (task.status !== 'completed' || !task.drained || task.recovering || !Array.isArray(seen.result.executions) || !Array.isArray(seen.result.operations)
      || seen.result.executions.some(item => !item.drained || !['succeeded', 'failed', 'cancelled', 'stale'].includes(item.status))
      || seen.result.operations.some(item => !['succeeded', 'failed', 'cancelled'].includes(item.state))) throw new Error('router_dependency_unsettled')
  }
}

function conversationContext(store, groupId) {
  const group = store.getGroup(groupId)
  return { conversationType: group.conversationType ?? 'group', conversationId: group.conversationId ?? groupId,
    responsibility: group.responsibility, agentNames: store.getAgentNames() }
}

export async function runNativeTriage({ ctx, store, groupId, source, workspaceRoot, agentPreset, selection, isOwnSource, signal, onStage = async () => {} }) {
  const sessionId = `session-triage-${randomUUID()}`
  const sourceRef = { sourceId: source.sourceId, messageId: source.messageId, messageVersion: source.version }
  const exposure = createRouterSourceExposure({ batchId: sessionId, sources: [source], context: conversationContext(store, groupId) })
  const current = async () => {
    signal?.throwIfAborted()
    const message = store.getGroup(groupId)?.messages.find(item => item.messageId === source.messageId)
    if (!message || message.messageVersion !== source.version || message.senderOpenDingTalkId !== source.actorId
      || await isOwnSource({ groupId, messageId: source.messageId })) throw new Error('router_triage_source_stale')
    signal?.throwIfAborted()
  }
  let receipt, replyReview
  const override = store.getTriageModelConfig()
  const cwd = await sessionWorkspace(workspaceRoot, 'triage')
  signal?.throwIfAborted()
  const handle = await ctx.agents.create({ sessionId, signal,
    meta: { cwd, origin: 'subagent', delegationDepth: 1, agentPreset },
    agentOptions: override ? taskModelSelection(selection, override) : selection,
    setup: async agentCtx => {
      const presets = agentCtx.get('agentPresets')
      if (!presets) throw new Error('agent_presets_required')
      const preset = await presets.mount(agentCtx, agentPreset)
      if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error('coordination_agent_preset_invalid')
      agentCtx.systemPrompt.section({ name: 'dingtalk:triage', order: 0, text: '你负责快速初筛当前消息。判断是否需要交会话 Router 处理，并决定静默或简短回复。不要拆分事项、编排或执行任务，也不要声称任务已创建或完成。首包来源可能截断，必要时用 router_source_read 从 offset 0 开始，依次使用 nextOffset 读至 totalLength，再调用 triage_submit。回复前调用 router_reply_review_get，提交 review（kind、reviewedOutboundIds、sameMatterOutboundIds、replaceOutboundIds），确认不能替换实质答复。' })
      const allowed = new Set(['router_source_read', 'router_reply_review_get', 'triage_submit'])
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.tools.guard(exec => allowed.has(exec.name) && !receipt ? undefined : 'router_tool_forbidden')
      agentCtx.tools.register(exposure.tool(current))
      agentCtx.tools.register({ name: 'router_reply_review_get', description: '读取当前会话已有回复候选，用于避免重复。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
        async execute(_args, exec) { await current(); const candidates = routerReplyCandidates(store.getGroup(groupId), sourceRef); replyReview = { callId: exec.callId, sourceId: source.sourceId, candidates }; return { sourceId: source.sourceId, candidates } } })
      agentCtx.tools.register({ name: 'triage_submit', description: '提交当前消息的处理和简短回复意图。',
        parameters: { type: 'object', properties: { needsProcessing: { type: 'boolean' }, reply: { anyOf: [{ type: 'string' }, { type: 'null' }] }, review: { type: 'object' } },
          required: ['needsProcessing', 'reply'], additionalProperties: false }, output,
        async execute({ needsProcessing, reply, review }, exec) {
          exec.signal.throwIfAborted()
          await current()
          exposure.assertVisible(exec.agent, [source.sourceId])
          if (reply !== null) {
            assertGroupReply(reply, [groupId, source.sourceId, source.messageId, source.actorId])
            if (!replyReview || JSON.stringify(replyReview.candidates) !== JSON.stringify(routerReplyCandidates(store.getGroup(groupId), sourceRef))) throw new Error('router_reply_review_stale')
            assertReplyReview(exec.agent, replyReview, review)
          }
          receipt = await store.triageAccept({ groupId, sourceRef, actorId: source.actorId, needsProcessing, reply, ...(reply === null ? {} : { replyReview: { candidates: replyReview.candidates, review } }) })
          exec.concludeTurn()
          return { accepted: true, triageId: receipt.triageId }
        } })
    },
  })
  let turn, timingTail = Promise.resolve()
  const stopTiming = ctx.on?.('session/event', (session, event) => {
    if (session.id !== sessionId || !['turn/start', 'turn/end'].includes(event.type)) return
    if (event.type === 'turn/start') turn = { spanId: `turn:${sessionId}:${event.seq}`, stage: 'turn',
      requestId: `triage:${source.sourceId}`, sessionId, attempt: 0, startedAt: new Date(event.time).toISOString(), completedAt: null }
    if (!turn) return
    const stage = { ...turn, ...(event.type === 'turn/end' ? { completedAt: new Date(event.time).toISOString() } : {}) }
    timingTail = timingTail.then(() => onStage({ groupId, sourceId: source.sourceId }, stage))
      .catch(error => ctx.logger?.warn?.(`message timing: ${error.code ?? error.message}`))
    if (event.type === 'turn/end') turn = undefined
  })
  const cancel = () => handle.agent.cancel({ kind: 'user' })
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    await current()
    handle.agent.steer(exposure.message)
    await handle.agent.whenIdle()
    signal?.throwIfAborted()
    if (!receipt) throw new Error('router_triage_no_submission')
    return receipt
  } finally {
    signal?.removeEventListener('abort', cancel)
    try { await handle.dispose() } finally { stopTiming?.(); await timingTail }
  }
}

export function createConversationRouter({ ctx, store, workspaceRoot, agentPreset, selection, readSources, readSource, readTasks, readTask,
  sourceProcessed, applyRouterAction, prepareReply, isOwnSource, onStage }) {
  const turns = new Map(), running = new Map(), abort = new AbortController()
  const shutdown = Object.assign(new Error('router_closed'), { code: 'ROUTER_CLOSED' })
  const interrupted = error => abort.signal.aborted && (error === shutdown || error?.name === 'AbortError' || error?.code === 'ROUTER_SESSION_CLOSED')
  let closed = false
  const isCurrent = binding => {
    const state = store.getRouterState(binding.groupId)
    return state.generation === binding.generation && state.lease === binding.lease && state.sessionId === binding.sessionId
  }
  const setup = (binding, presetId) => async agentCtx => {
    const presets = agentCtx.get('agentPresets')
    if (!presets) throw new Error('agent_presets_required')
    const preset = await presets.mount(agentCtx, presetId)
    if (preset?.id !== undefined && preset.id !== presetId) throw new Error('coordination_agent_preset_invalid')
    agentCtx.systemPrompt.section({ name: 'dingtalk:conversation-router', order: 0,
      text: `你负责本会话任务安排。同一目标的阶段留在同一 Task。等待前置任务的后续新任务写入 arrangements：sourceIds、title、objective、dependsOnTaskIds；Host 固定安排和后续 taskId。激活已保存安排时，提交 action，包含 arrangementId、sourceIds 和 dependencies；依赖任务必须先读取当前版本。context.retries 是明确未执行的旧动作：重新核实依赖后保留原 action 字段和任务身份，仅更新 dependencies，并附 retryOfOperationId、sourceIds 和原 arrangementId；已成功动作不可重做。任务动作仅支持 new-task、task-context、task-reopen、task-cancel。普通 new-task 用于独立事项；未完成原任务补充用 task-context，显式 progressImpact:preserve/replan；已完成原任务收到开发、修订或重新提测授权用 task-reopen，不新建重复Task。操作已有Task先 router_task_get，填写 taskId、inputVersion=requirementRevision、runSequence、expectedControlRevision=controlRevision；task-context/task-reopen 必须填写 context，task-cancel 填写 reason。动作失败时纠正候选或保留失败，不得用空 actions 或连续性摘要代替未成功的派工。若需回复，先以真实 sourceId 读取完整来源并调用 router_reply_review_get，再提交 reply:{sourceId,text,review}；review 包含 kind、reviewedOutboundIds、sameMatterOutboundIds、replaceOutboundIds。确认不得替换实质答复。reply 可选 replyToMessageId、atOpenDingTalkIds、atAll；引用与成员身份必须来自同会话完整已读来源。${groupNotificationInstructions} 三个通知字段均省略时沿用当前来源的默认定向；明确不提及时填写空数组。若交付本批 completed fact 中的文件，reply 可含 completion:{factId,taskId,artifactIds}，文件 ID 必须来自可见完成事实，Host 固定并核验真实文件。摘要不能作为来源授权。提交候选由 Host 核验并执行，不声称已执行。` })
    const allowed = new Set(['router_source_read', 'router_task_list', 'router_task_get', 'router_reply_review_get', 'router_submit'])
    const turn = () => {
      const value = turns.get(binding.groupId)
      if (!value) throw new Error('router_turn_inactive')
      return value
    }
    const check = async agent => { await sessions.assert(agent, turn().binding) }
    agentCtx.tools.restrict({ allow: [] })
    agentCtx.tools.guard(exec => allowed.has(exec.name) && turns.has(binding.groupId) ? undefined : 'router_tool_forbidden')
    agentCtx.tools.register({ name: 'router_source_read', description: '分页读取当前会话的真实来源。',
      parameters: { type: 'object', properties: { sourceId: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['sourceId', 'offset'], additionalProperties: false }, output,
      async execute(args, exec) { return turn().exposure.tool(check, id => readSource({ groupId: binding.groupId, sourceId: id })).execute(args, exec) } })
    agentCtx.tools.register({ name: 'router_task_list', description: '查询当前会话任务目录。', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(_args, exec) { await check(exec.agent); return { tasks: await readTasks({ groupId: binding.groupId }) } } })
    agentCtx.tools.register({ name: 'router_task_get', description: '读取当前任务与执行、排空和未决效果。',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false }, output,
      async execute({ taskId }, exec) {
        await check(exec.agent)
        const loaded = await readTask({ groupId: binding.groupId, taskId })
        await check(exec.agent)
        if (!loaded || (loaded.task?.taskId ?? loaded.taskId) !== taskId) throw new Error('router_task_missing')
        const result = structuredClone(loaded)
        const task = result.task ?? result
        task.contextRevision ??= 0
        turn().taskReads.set(taskId, { callId: exec.callId, result: structuredClone(result) })
        return result
      } })
    agentCtx.tools.register({ name: 'router_reply_review_get', description: '审阅指定真实来源关联的活动回复。',
      parameters: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false }, output,
      async execute({ sourceId }, exec) {
        await check(exec.agent)
        const current = turn(), source = current.exposure.source(sourceId)
        if (!source) throw new Error('router_source_unadmitted')
        current.exposure.assertVisible(exec.agent, [sourceId])
        const sourceRef = { sourceId, messageId: source.messageId, messageVersion: source.version }
        const candidates = routerReplyCandidates(store.getGroup(binding.groupId), sourceRef)
        current.replyReads.set(sourceId, { callId: exec.callId, sourceId, candidates })
        return { sourceId, candidates }
      } })
    agentCtx.tools.register({ name: 'router_submit', description: '提交本批任务动作和必要连续性。',
      parameters: { type: 'object', properties: { actions: { type: 'array', items: toToolJsonSchema(routerActionSchema) }, arrangements: { type: 'array', items: { type: 'object' } }, continuity: { type: 'array', items: { type: 'object' } }, reply: { anyOf: [{ type: 'object' }, { type: 'null' }] } },
        required: ['actions', 'continuity', 'reply'], additionalProperties: false }, output,
      async execute(candidate, exec) {
        await check(exec.agent)
        const current = turn()
        if (current.decision) throw new Error('router_already_submitted')
        if (!Array.isArray(candidate.actions) || !Array.isArray(candidate.continuity) || !(candidate.reply === null || candidate.reply && typeof candidate.reply === 'object')
          || candidate.arrangements !== undefined && !Array.isArray(candidate.arrangements)) throw new Error('router_decision_invalid')
        const arrangements = []
        for (const proposed of candidate.arrangements ?? []) {
          if (!proposed || Object.keys(proposed).sort().join(',') !== 'dependsOnTaskIds,objective,sourceIds,title'
            || !Array.isArray(proposed.sourceIds) || !proposed.sourceIds.length || new Set(proposed.sourceIds).size !== proposed.sourceIds.length
            || !Array.isArray(proposed.dependsOnTaskIds) || !proposed.dependsOnTaskIds.length
            || new Set(proposed.dependsOnTaskIds).size !== proposed.dependsOnTaskIds.length
            || typeof proposed.title !== 'string' || !proposed.title.trim() || typeof proposed.objective !== 'string' || !proposed.objective.trim()) throw new Error('router_arrangement_invalid')
          current.exposure.assertVisible(exec.agent, proposed.sourceIds)
          const sourceRefs = proposed.sourceIds.map(id => current.exposure.source(id)).map(source => ({ sourceId: source.sourceId, messageId: source.messageId, messageVersion: source.version }))
          arrangements.push({ arrangementId: `arrangement-${randomUUID()}`, taskId: `task-${randomUUID()}`, sourceRefs,
            title: proposed.title, objective: proposed.objective, dependsOnTaskIds: proposed.dependsOnTaskIds })
        }
        const applications = []
        for (const proposed of candidate.actions) {
          const parsed = routerActionSchema.safeParse(proposed)
          if (!parsed.success) throw new Error(`router_action_invalid: ${parsed.error.message}`)
          if (proposed.kind === 'task-context') assertTaskContextSemantics(proposed)
          if (!proposed || !['new-task', 'task-context', 'task-reopen', 'task-cancel'].includes(proposed.kind)
            || !Array.isArray(proposed.sourceIds) || !proposed.sourceIds.length || new Set(proposed.sourceIds).size !== proposed.sourceIds.length) throw new Error('router_action_invalid')
          current.exposure.assertVisible(exec.agent, proposed.sourceIds)
          const sources = proposed.sourceIds.map(id => current.exposure.source(id))
          const sourceRefs = sources.map(source => ({ sourceId: source.sourceId, messageId: source.messageId, messageVersion: source.version }))
          const { sourceIds, arrangementId, retryOfOperationId, ...action } = proposed
          if (action.dependencies !== undefined) assertRouterDependencies(exec.agent, current.taskReads, action.dependencies)
          if (retryOfOperationId !== undefined) {
            const input = current.batch.inputs.find(item => item.kind === 'retry' && item.operationId === retryOfOperationId)
            const decision = input && store.getRouterState(binding.groupId).decisions.find(item => item.decisionId === input.decisionId)
            const prior = decision?.applications.find(item => item.operationId === retryOfOperationId)
            if (!prior || prior.status !== 'rejected' || prior.arrangementId !== arrangementId || !isDeepStrictEqual(sourceRefs, prior.sourceRefs)) throw new Error('router_retry_invalid')
            const { dependencies: _oldDependencies, ...original } = prior.action
            const { dependencies: _newDependencies, ...proposedAction } = action
            if (!isDeepStrictEqual(original, proposedAction)) throw new Error('router_retry_invalid')
          } else if (arrangementId !== undefined) {
            const arrangement = (store.getRouterState(binding.groupId).arrangements ?? []).find(item => item.arrangementId === arrangementId)
            if (!arrangement || arrangement.status !== 'waiting' || action.kind !== 'new-task'
              || Object.keys(action).sort().join(',') !== 'dependencies,kind' || !Array.isArray(action.dependencies)
              || JSON.stringify(sourceRefs) !== JSON.stringify(arrangement.sourceRefs)) throw new Error('router_arrangement_conflict')
            Object.assign(action, { taskId: arrangement.taskId, title: arrangement.title, objective: arrangement.objective })
          } else if (action.kind === 'new-task') {
            if (action.taskId !== undefined || typeof action.objective !== 'string' || !action.objective.trim()) throw new Error('router_action_invalid')
            action.taskId = `task-${randomUUID()}`
          } else {
            const seen = current.taskReads.get(action.taskId)
            if (!seen) throw new Error('router_task_unread')
            const visible = exec.agent.session.deriveMessages().some(message => message.role === 'tool' && !message.isError
              && message.toolCallId === seen.callId && message.content?.some(block => block.type === 'text' && block.text === JSON.stringify(seen.result)))
            if (!visible) throw new Error('router_task_unread')
            const task = seen.result.task ?? seen.result
            if (action.inputVersion !== task.requirementRevision || action.runSequence !== task.runSequence
              || action.expectedControlRevision !== task.controlRevision) throw new Error('router_task_stale')
          }
          applications.push({ operationId: `router-operation-${randomUUID()}`, sourceRefs, action, ...(arrangementId === undefined ? {} : { arrangementId }),
            ...(retryOfOperationId === undefined ? {} : { retryOfOperationId }) })
        }
        if (candidate.reply !== null) {
          const { sourceId, text, review, completion: requestedCompletion, ...routingFields } = candidate.reply
          if (typeof text !== 'string' || !text.trim()) throw new Error('router_reply_invalid')
          const routing = z.strictObject(groupNotificationFields).parse(routingFields)
          const source = current.exposure.source(sourceId), read = current.replyReads.get(sourceId)
          if (!source || !read) throw new Error('router_reply_review_unread')
          assertGroupReply(text, [binding.groupId, ...current.exposure.sources().flatMap(item => [item.sourceId, item.messageId, item.actorId]),
            ...current.taskReads.keys(), ...current.facts.flatMap(fact => [fact.factId, fact.taskId,
              ...(fact.result?.artifactFiles ?? []).map(file => file?.artifact?.artifactId)])])
          current.exposure.assertVisible(exec.agent, [sourceId])
          assertReplyReview(exec.agent, read, review)
          const sourceRef = { sourceId, messageId: source.messageId, messageVersion: source.version }
          let notificationRouting
          if (Object.keys(routingFields).length) {
            const group = store.getGroup(binding.groupId), direct = group.conversationType === 'direct'
            if (direct && (routing.atAll || routing.atOpenDingTalkIds?.length)) throw new Error('group_reply_audience_invalid')
            const available = current.exposure.sources().filter(item => item.groupId === binding.groupId && item.actorId
              && !['web', 'internal'].includes(item.channel) && group.messages.some(message => message.messageId === item.messageId
                && message.messageVersion === item.version && !message.ownNotificationRetirement
                && (message.senderOpenDingTalkId ?? message.actorId) === item.actorId))
            const participants = available.map(item => ({ messageId: item.messageId, senderOpenDingTalkId: item.actorId, sourceKind: item.channel }))
            const selected = groupNotificationRouting(participants, direct ? { ...routing, atOpenDingTalkIds: [] } : routing, { quote: !direct })
            const evidence = available.filter(item => item.messageId === selected.target?.messageId || selected.recipients.includes(item.actorId))
            const needed = [...new Map(evidence.map(item => [item.actorId, item])).values()]
            const target = selected.target && available.find(item => item.messageId === selected.target.messageId)
            if (target && !needed.some(item => item.sourceId === target.sourceId)) needed.push(target)
            current.exposure.assertVisible(exec.agent, needed.map(item => item.sourceId))
            notificationRouting = { ...(target ? { replyToMessageId: target.messageId, replyToSenderOpenDingTalkId: target.actorId } : {}),
              atOpenDingTalkIds: selected.recipients, ...(selected.atAll ? { atAll: true } : {}),
              sourceRefs: needed.map(item => ({ sourceId: item.sourceId, messageId: item.messageId, messageVersion: item.version, actorId: item.actorId })) }
          }
          let completion
          if (requestedCompletion !== undefined) {
            const requested = requestedCompletion
            if (!requested || Object.keys(requested).sort().join(',') !== 'artifactIds,factId,taskId'
              || !Array.isArray(requested.artifactIds) || !requested.artifactIds.length
              || new Set(requested.artifactIds).size !== requested.artifactIds.length) throw new Error('router_reply_completion_invalid')
            current.exposure.assertContextVisible(exec.agent)
            const fact = current.facts.find(item => item.factId === requested.factId && item.taskId === requested.taskId && item.kind === 'completed')
            if (!fact || !fact.sourceIds?.includes(sourceId) || !Array.isArray(fact.result?.artifactFiles)) throw new Error('router_reply_completion_invalid')
            const files = requested.artifactIds.map(id => fact.result.artifactFiles.find(item => item?.artifact?.artifactId === id))
            if (files.some(item => !item || item.artifact.taskId !== fact.taskId || item.artifact.requirementRevision !== fact.taskVersion?.requirementRevision)) throw new Error('router_reply_completion_invalid')
            completion = { factId: fact.factId, factDigest: fact.factDigest, taskId: fact.taskId, taskVersion: fact.taskVersion, files }
          }
          applications.push({ kind: 'reply', operationId: `router-reply-${randomUUID()}`, sourceRef, actorId: source.actorId, text,
            replyReview: { candidates: read.candidates, review }, ...(completion ? { completion } : {}), ...(notificationRouting ? { notificationRouting } : {}) })
        }
        await check(exec.agent)
        assertFailedTaskActionsHandled(exec.agent, current, candidate)
        current.decision = await store.routerCommit({ groupId: binding.groupId, binding: current.binding, batchId: current.batch.batchId,
          decision: candidate, continuity: candidate.continuity, applications, arrangements })
        exec.concludeTurn()
        return { accepted: true, decisionId: current.decision.decisionId }
      } })
  }
  const currentValue = value => typeof value === 'function' ? value() : value
  const agentOptions = () => {
    const override = store.getRouterModelConfig(), current = currentValue(selection)
    return override ? taskModelSelection(current, override) : current
  }
  const sessions = createConversationRouterSessions({ ctx, isCurrent,
    create: async (binding, signal) => {
      const presetId = currentValue(agentPreset)
      const cwd = await sessionWorkspace(workspaceRoot, 'router')
      signal.throwIfAborted()
      return ctx.agents.create({ sessionId: binding.sessionId, signal,
        meta: { cwd, origin: 'subagent', delegationDepth: 1, agentPreset: presetId }, agentOptions: agentOptions(), setup: setup(binding, presetId) })
    },
    resume: (binding, signal) => {
      const presetId = currentValue(agentPreset)
      return ctx.agents.resume({ resumeSessionId: binding.sessionId, signal, agentOptions: agentOptions(), setup: setup(binding, presetId) })
    },
  })
  async function staleReplySource(groupId, sourceRef, notificationRouting) {
    const group = store.getGroup(groupId)
    for (const ref of [sourceRef, ...(notificationRouting?.sourceRefs ?? [])]) {
      const message = group?.messages.find(item => item.messageId === ref.messageId)
      if (!message || message.ownNotificationRetirement || !(message.messageVersion > ref.messageVersion)) continue
      let source
      try { source = await readSource({ groupId, sourceId: ref.sourceId }) }
      catch (error) { if (error.code === 'TASK_ROUTER_SOURCE_INVALID') continue; throw error }
      if (source?.sourceId === ref.sourceId && source.groupId === groupId && source.messageId === ref.messageId
        && source.version === ref.messageVersion && source.actorId && (!ref.actorId || ref.actorId === source.actorId)
        && (message.senderOpenDingTalkId ?? message.actorId) === source.actorId) return true
    }
    return false
  }
  async function applyPending(groupId) {
    const state = store.getRouterState(groupId)
    for (const triage of state.triage) {
      if (triage.replyStatus === 'pending') {
        const failure = (store.getRouterState(groupId).failures ?? []).find(item => item.phase === 'host' && item.requestId === triage.triageId)
        if (failure?.status === 'failed' && !await staleReplySource(groupId, triage.sourceRef)) continue
        try {
          if (prepareReply.reviewContract !== 1) throw new Error('router_reply_host_review_unavailable')
          const { review, candidates } = triage.disposition.replyReview
          const receipt = await prepareReply({ groupId, decisionId: triage.triageId, operationId: triage.triageId, sourceRef: triage.sourceRef,
            text: triage.disposition.reply, replyKind: review.kind, replyReview: review, candidates })
          await store.triageRecordReply({ groupId, triageId: triage.triageId, receipt })
          await store.routerResolveFailure({ groupId, sourceId: triage.sourceRef.sourceId, phase: 'host', requestId: triage.triageId })
        } catch (error) {
          await store.routerRecordFailure({ groupId, sourceRef: triage.sourceRef, phase: 'host', requestId: triage.triageId,
            error: error.code ?? error.message, failurePhase: 'reply' })
          throw error
        }
      }
      if (!triage.disposition.needsProcessing) await sourceProcessed({ groupId, sourceRef: triage.sourceRef, phase: 'triage', decisionId: triage.triageId })
    }
    for (const decision of store.getRouterState(groupId).decisions) {
      for (const application of decision.applications.filter(item => item.status === 'pending')) {
        const refs = application.kind === 'reply' ? [application.sourceRef] : application.sourceRefs ?? []
        const failures = store.getRouterState(groupId).failures ?? []
        const matchingFailures = failures.filter(item => item.phase === 'host' && item.requestId === application.operationId)
        const blocked = matchingFailures.some(item => item.status === 'failed') && !matchingFailures.some(item => item.status === 'retrying')
        let reconciliationOnly = false
        if (blocked) {
          if (application.kind === 'reply') {
            if (!await staleReplySource(groupId, application.sourceRef, application.notificationRouting)) continue
          } else {
            for (const ref of refs) if (await staleReplySource(groupId, ref)) { reconciliationOnly = true; break }
            if (!reconciliationOnly) continue
          }
        }
        try {
          if (application.kind === 'reply' && prepareReply.reviewContract !== 1) throw new Error('router_reply_host_review_unavailable')
          const receipt = application.kind === 'reply'
            ? await prepareReply({ groupId, decisionId: decision.decisionId, operationId: application.operationId, sourceRef: application.sourceRef,
              text: application.text, replyKind: application.replyReview.review.kind, replyReview: application.replyReview.review, candidates: application.replyReview.candidates,
              ...(application.completion ? { completion: application.completion } : {}),
              ...(application.notificationRouting ? { notificationRouting: application.notificationRouting } : {}) })
            : await applyRouterAction({ groupId, decisionId: decision.decisionId, operationId: application.operationId,
              sourceRefs: application.sourceRefs, action: application.action, ...(reconciliationOnly ? { reconciliationOnly: true } : {}) })
          if (reconciliationOnly && receipt?.status === 'unsettled') continue
          if (receipt?.status === 'known-not-applied') await store.routerRecordRejection({ groupId, decisionId: decision.decisionId, operationId: application.operationId, receipt })
          else await store.routerRecordApplication({ groupId, decisionId: decision.decisionId, operationId: application.operationId, receipt })
          for (const ref of refs) await store.routerResolveFailure({ groupId, sourceId: ref.sourceId, phase: 'host', requestId: application.operationId })
        } catch (error) {
          if (reconciliationOnly) throw error
          for (const sourceRef of refs) await store.routerRecordFailure({ groupId, sourceRef, phase: 'host', requestId: application.operationId,
            error: error.code ?? error.message, failurePhase: 'application' })
          throw error
        }
      }
    }
    const decisions = store.getRouterState(groupId).decisions
    const applied = application => {
      if (application.status === 'applied') return true
      if (application.status !== 'rejected' || !application.retriedBy) return false
      const next = decisions.find(item => item.decisionId === application.retriedBy.decisionId)?.applications.find(item => item.operationId === application.retriedBy.operationId)
      return !!next && applied(next)
    }
    for (const decision of decisions) if (decision.applications.every(applied))
      for (const input of decision.inputs.filter(item => item.kind === 'source'))
        await sourceProcessed({ groupId, sourceRef: input.sourceRef, phase: 'router', decisionId: decision.decisionId })
  }
  async function wakeReadyArrangements(groupId) {
    for (const arrangement of (store.getRouterState(groupId).arrangements ?? []).filter(item => item.status === 'waiting')) {
      const dependencies = []
      for (const taskId of arrangement.dependsOnTaskIds) {
        const result = await readTask({ groupId, taskId }), task = result?.task
        if (!task || task.status !== 'completed' || !task.drained || task.recovering
          || !Array.isArray(result.executions) || !Array.isArray(result.operations)
          || result.executions.some(item => !item.drained || !['succeeded', 'failed', 'cancelled', 'stale'].includes(item.status))
          || result.operations.some(item => !['succeeded', 'failed', 'cancelled'].includes(item.state))) break
        const version = { taskId, requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0,
          controlRevision: task.controlRevision, runSequence: task.runSequence }
        if (Object.values(version).slice(1).some(value => !Number.isSafeInteger(value))) break
        dependencies.push(version)
      }
      if (dependencies.length === arrangement.dependsOnTaskIds.length) await store.routerWakeArrangement({ groupId,
        arrangementId: arrangement.arrangementId, revision: arrangement.revision ?? 0, dependencies })
    }
  }
  async function process(groupId) {
    if (closed) return
    const initialState = store.getRouterState(groupId)
    for (const failure of initialState.failures ?? []) {
      if (failure.phase === 'decision' && initialState.decisions.some(item => item.batchId === failure.requestId)
        || failure.phase === 'host' && initialState.decisions.some(item => item.applications.some(application => application.operationId === failure.requestId && application.status !== 'pending'))) {
        await store.routerResolveFailure({ groupId, sourceId: failure.sourceRef.sourceId, phase: failure.phase, requestId: failure.requestId })
      }
    }
    await applyPending(groupId)
    for (const source of await readSources({ groupId })) {
      abort.signal.throwIfAborted()
      const state = store.getRouterState(groupId), requestId = `triage:${source.sourceId}`
      if (state.triage.some(item => item.sourceRef.sourceId === source.sourceId)) {
        await store.routerResolveFailure({ groupId, sourceId: source.sourceId, phase: 'routing', requestId })
        continue
      }
      if ((state.failures ?? []).some(item => item.requestId === requestId && item.phase === 'routing' && item.status === 'failed')) continue
      try {
        await runNativeTriage({ ctx, store, groupId, source, workspaceRoot, agentPreset: currentValue(agentPreset), selection: currentValue(selection), isOwnSource, signal: abort.signal, onStage })
      } catch (error) {
        if (interrupted(error)) throw error
        await store.routerRecordFailure({ groupId, sourceRef: { sourceId: source.sourceId, messageId: source.messageId, messageVersion: source.version },
          phase: 'routing', requestId, error: error.code ?? error.message, failurePhase: 'triage' })
        throw error
      }
      await store.routerResolveFailure({ groupId, sourceId: source.sourceId, phase: 'routing', requestId })
      await applyPending(groupId)
    }
    while (!closed) {
      await wakeReadyArrangements(groupId)
      let state = store.getRouterState(groupId), claim
      if (!state.active && !state.queue.length) break
      if (!state.sessionId) {
        const group = store.getGroup(groupId)
        const initSources = state.queue.filter(item => item.kind === 'source').map(item => item.sourceRef)
        const blocked = (state.failures ?? []).filter(item => item.phase === 'decision' && item.requestId.startsWith('router-init:'))
        if (blocked.some(item => item.status === 'failed') && !blocked.some(item => item.status === 'retrying')) break
        const candidate = { groupId, conversationType: group.conversationType ?? 'group', conversationId: group.conversationId ?? groupId,
          generation: 1, sessionId: `session-router-${randomUUID()}` }
        try {
          await sessions.prepare({ binding: candidate })
          for (const sourceRef of initSources) await store.routerResolveFailure({ groupId, sourceId: sourceRef.sourceId, phase: 'decision', requestId: `router-init:${sourceRef.sourceId}` })
        } catch (error) {
          if (interrupted(error)) throw error
          for (const sourceRef of initSources) await store.routerRecordFailure({ groupId, sourceRef, phase: 'decision', requestId: `router-init:${sourceRef.sourceId}`,
            error: error.code ?? error.message, failurePhase: 'router-start' })
          throw error
        }
        let committed = false, candidatePrepared = true
        try {
          claim = await store.routerClaim({ groupId, sessionId: candidate.sessionId })
          if (!claim || claim.binding.sessionId !== candidate.sessionId) {
            await sessions.abortPrepare({ binding: candidate })
            candidatePrepared = false
            if (!claim) break
          } else {
            committed = true
            await sessions.activate({ newBinding: claim.binding })
          }
        } catch (error) {
          if (!committed && candidatePrepared && !closed) await sessions.abortPrepare({ binding: candidate })
          throw error
        }
      } else claim = await store.routerClaim({ groupId })
      if (!claim) break
      const group = store.getGroup(groupId)
      if (claim.batch.inputs.some(item => item.kind === 'source' ? !group.messages.some(message => message.messageId === item.sourceRef.messageId
        && message.messageVersion === item.sourceRef.messageVersion && message.senderOpenDingTalkId === item.actorId)
        : ['retry', 'dependency'].includes(item.kind) && item.sourceRefs.some(ref => !group.messages.some(message => message.messageId === ref.messageId && message.messageVersion === ref.messageVersion)))) {
        await store.routerReleaseStale({ groupId, binding: claim.binding, batchId: claim.batch.batchId })
        continue
      }
      const facts = (store.getGroup(groupId).routerFacts ?? []).filter(item => claim.batch.inputs.some(input => input.kind === 'fact' && input.id === item.fact.factId)).map(item => item.fact)
      const refs = [...new Set([...claim.batch.inputs.flatMap(item => item.kind === 'source' ? [item.sourceRef.sourceId]
        : ['retry', 'dependency'].includes(item.kind) ? item.sourceRefs.map(ref => ref.sourceId) : []), ...facts.flatMap(fact => fact.sourceIds ?? [])])]
      const sources = await Promise.all(refs.map(sourceId => readSource({ groupId, sourceId })))
      const retries = claim.batch.inputs.filter(item => item.kind === 'retry').map(item => {
        const decision = store.getRouterState(groupId).decisions.find(value => value.decisionId === item.decisionId)
        return { ...item, application: decision.applications.find(value => value.operationId === item.operationId),
          applied: decision.applications.filter(value => value.status === 'applied') }
      })
      const dependencyWakes = claim.batch.inputs.filter(item => item.kind === 'dependency')
      const exposure = createRouterSourceExposure({ batchId: claim.batch.batchId, sources, context: { ...conversationContext(store, groupId), continuity: claim.continuity,
        newSourceIds: claim.batch.inputs.filter(item => item.kind === 'source').map(item => item.sourceRef.sourceId), facts, retries, dependencyWakes,
        arrangements: (store.getRouterState(groupId).arrangements ?? []).filter(item => item.status === 'waiting') } })
      const turn = { ...claim, exposure, facts, taskReads: new Map(), replyReads: new Map(), decision: null }
      const batchFailures = (store.getRouterState(groupId).failures ?? []).filter(item => item.phase === 'decision' && item.requestId === claim.batch.batchId)
      turn.unresolvedTaskSources = batchFailures.filter(item => item.code === 'router_task_action_unresolved').map(item => item.sourceRef.sourceId)
      if (batchFailures.some(item => item.status === 'failed') && !batchFailures.some(item => item.status === 'retrying')) break
      turns.set(groupId, turn)
      try {
        await sessions.run({ binding: claim.binding, input: exposure.message })
        if (!turn.decision) throw turn.submissionError ?? new Error('router_no_submission')
        for (const source of sources) await store.routerResolveFailure({ groupId, sourceId: source.sourceId, phase: 'decision', requestId: claim.batch.batchId })
      } catch (error) {
        if (interrupted(error)) throw error
        for (const source of sources) await store.routerRecordFailure({ groupId,
          sourceRef: { sourceId: source.sourceId, messageId: source.messageId, messageVersion: source.version },
          phase: 'decision', requestId: claim.batch.batchId, error: error.code ?? error.message, failurePhase: 'router' })
        throw error
      } finally { turns.delete(groupId) }
      await applyPending(groupId)
      state = store.getRouterState(groupId)
      if (state.active || state.queue.length) continue
      const candidate = { ...claim.binding, generation: claim.binding.generation + 1, lease: undefined, sessionId: `session-router-${randomUUID()}` }
      await sessions.prepare({ binding: candidate })
      let next
      try {
        next = await sessions.withIdle({ binding: claim.binding }, () => store.routerRotate({ groupId, binding: claim.binding,
          expectedContinuityRevision: state.continuityRevision, sessionId: candidate.sessionId }))
      } catch (error) { if (!closed) await sessions.abortPrepare({ binding: candidate }); throw error }
      await sessions.activate({ oldBinding: claim.binding, newBinding: next })
    }
  }
  function schedule(groupId) {
    if (closed) return Promise.reject(new Error('router_closed'))
    const previous = running.get(groupId) ?? Promise.resolve()
    const pending = previous.then(() => process(groupId), () => process(groupId))
    running.set(groupId, pending)
    pending.finally(() => { if (running.get(groupId) === pending) running.delete(groupId) }).catch(() => {})
    return pending
  }
  return {
    schedule,
    async recover() { for (const group of store.listGroups()) await schedule(group.groupId) },
    async close() {
      closed = true
      abort.abort(shutdown)
      sessions.stop(shutdown)
      await Promise.allSettled([...running.values()])
      await sessions.close()
    },
  }
}
