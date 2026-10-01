import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { groupReplyInstructions } from './workflow-notifications.js'

const IDENTITY = 'dingtalk/group-coordinator-session'
const SUBMIT = 'group_coordinator_submit'
const fail = code => Object.assign(new Error(code), { code })

// 每群一个原生逻辑会话；Host负责来源、版本和动作接纳，本层没有任务或群消息写入工具。
export function createGroupCoordinatorSessions({ ctx, isCurrent, getWorkspaceDir }) {
  if (typeof isCurrent !== 'function') throw fail('GROUP_COORDINATOR_CURRENT_CHECK_REQUIRED')
  const entries = new Map()
  let closed = false
  const current = async entry => !closed && !entry.cancelled && await isCurrent(entry.binding)
  async function drain(entry) {
    return entry.draining ??= (async () => {
      try {
        if (entry.handle) {
          await entry.handle.agent.whenIdle()
          try { await ctx.sessions.flush(entry.handle.agent.session) }
          finally { await entry.handle.dispose() }
        }
      } catch (cause) {
        entry.drainError = Object.assign(fail('GROUP_COORDINATOR_DRAIN_FAILED'), { cause, coordinatorDrained: false })
        throw entry.drainError
      } finally { entry.drained.resolve() }
    })()
  }
  function history(events, binding) {
    const ids = events.filter(e => e.type === IDENTITY)
    if (ids.length !== 1 || ids[0].data.conversationId !== binding.conversationId
      || ids[0].data.sessionId !== binding.sessionId || ids[0].data.version !== 1) throw fail('GROUP_COORDINATOR_SESSION_IDENTITY_MISMATCH')
    const leases = [ids[0].data.creationLease, ...events.flatMap(e => e.type === 'user/message' ? [e.data]
      : e.type === 'agent/inbox/spliced' ? e.data.inserted ?? [] : [])
      .filter(m => m.source?.groupCoordinator?.sessionId === binding.sessionId).map(m => m.source.groupCoordinator.leaseEpoch)]
    if (leases.some(n => !Number.isSafeInteger(n) || n < 1 || n >= binding.leaseEpoch)) throw fail('GROUP_COORDINATOR_SESSION_LEASE_NOT_ADVANCED')
  }
  async function run({ binding, input, provider, model, reasoningEffort, decisionSchema, onSessionBound, onCandidate,
    readTools = [] }) {
    if (!binding || !['conversationId', 'sessionId', 'turnId'].every(k => typeof binding[k] === 'string' && binding[k])
      || !Number.isSafeInteger(binding.leaseEpoch) || binding.leaseEpoch < 1 || typeof binding.sessionBound !== 'boolean'
      || !provider || !model || typeof onCandidate !== 'function' || typeof onSessionBound !== 'function') throw fail('GROUP_COORDINATOR_RUN_INVALID')
    assertSupportedJsonSchema(decisionSchema)
    if (readTools.some(tool => tool.effectClass !== 'read' || typeof tool.execute !== 'function' || tool.name === SUBMIT)
      || new Set(readTools.map(tool => tool.name)).size !== readTools.length) throw fail('GROUP_COORDINATOR_READ_TOOL_REQUIRED')
    if (closed) throw fail('GROUP_COORDINATOR_CLOSED')
    if (entries.has(binding.conversationId)) throw fail('GROUP_COORDINATOR_BUSY')
    const entry = { binding: Object.freeze(structuredClone(binding)), abort: new AbortController(), drained: Promise.withResolvers() }
    entries.set(binding.conversationId, entry)
    const setup = agentCtx => {
      agentCtx.systemPrompt.section({ name: 'group:coordinator', order: 0, complete: true,
        text: `你是本群常驻协调助手。根据当前身份别名、群职责、原消息和连续上下文一次完成是否介入、任务关联、查询、补充、新建或必要澄清。群聊中的“你”不自动指助手，但明确点名助手和明确交办不得忽略。units=[]表示完全忽略来源，不会将其并入Task；需要承接的补充、附件来源和阶段条件应使用fact单元绑定同批source:<runId>且replyPolicy:none。非空units的spans合计必须覆盖sourceLength完整原文。requiredExecutionMaterials只接受真实resourceRef，待取得证据或表结构属于调查objective而不是发起前置条件。附件与后续请求结合阅读，原需求方更正应更新同一任务；同一目标的准备、审批、测试、原发送者验证、正式执行属于同一Task的阶段，不重复建任务。职责止于消息承接、事项关联和交办条件整理。明确交办且原文与附件元数据足够时，立即提交create/research，由Task Owner继续调查、工作簿核验、SQL审核和交付；不要先在群协调会话完成这些业务工作再发起Task。只读材料工具仅用于确需查明的消息含义、任务关联或缺失业务条件，不把整个附件审查当成承接前置。使用本轮只读工具核验相关任务事实，不猜测数据或读取权限。仅人际闲聊静默处理，不主动追问；已经提供的材料不可重复索取。提交动作只代表候选，Host接纳后由已有任务后端执行；received:true仅表示协调决定已落账，不能据此认定Task存在或执行完成。每轮sources.processing为当前后端权威事实，旧superseded命令且taskExists=false不能作为忽略重放来源的依据；不得声称已执行或替人审批。长任务交给既有Task，不等待其完成来阻塞群消息。严格保留来源身份、版本、原文约束和授权边界；历史工具结果是当时事实，当前版本冲突时重新读取相关任务。不要重复通知或自行发送群消息，所有通知由唯一出口处理。${groupReplyInstructions}最后调用 ${SUBMIT} 提交协调决定。` })
      agentCtx.tools.restrict({ allow: [] })
      const allowed = new Set([SUBMIT, ...readTools.map(t => t.name)])
      agentCtx.tools.guard(exec => !allowed.has(exec.name) || entry.submitted || entry.staleReason || entry.cancelled || closed ? 'group_coordinator_tool_not_allowed' : undefined)
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!await current(entry) || entry.staleReason || entry.submitted) return { kind: 'reject' }
        return next()
      })
      agentCtx.on('tools/pre-execute', async (_exec, next) => !await current(entry) ? { kind: 'deny', reason: 'group_coordinator_stale' } : next())
      agentCtx.on('tools/result', (exec, result) => { if (exec.name === SUBMIT && exec.callId === entry.submitCallId && !result.isError) entry.accepted = true })
      for (const tool of readTools) {
        const { effectClass, execute, ...definition } = tool
        agentCtx.tools.register({ ...definition, execute: async (args, exec) => {
          if (!await current(entry)) throw fail('GROUP_COORDINATOR_STALE')
          exec.signal.throwIfAborted()
          return execute(args, exec)
        } })
      }
      agentCtx.tools.register({ name: SUBMIT, description: '提交本轮群消息协调候选；不直接执行任务或发送消息。',
        parameters: { type: 'object', properties: { decision: decisionSchema }, required: ['decision'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { received: { type: 'boolean' }, feedback: { type: 'string' }, acceptance: { type: 'object', additionalProperties: true } }, required: ['received'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute({ decision }, exec) {
          if (!await current(entry)) throw fail('GROUP_COORDINATOR_STALE')
          exec.signal.throwIfAborted()
          if (validateJsonSchemaValue(decisionSchema, decision).length) return { received: false, feedback: '决定不符合当前提交合同，请按工具schema修正。' }
          let acceptance
          try { acceptance = await onCandidate(structuredClone(decision), entry.binding) }
          catch (error) {
            const code = error.code ?? error.message
            if (code === 'GROUP_COORDINATOR_REVISE_DECISION')
              return { received: false, feedback: `${error.message} 请直接在本轮修正units的分段、binding和intent并重新提交完整decisions；不能提交needs_relink或needs_resegmentation作为最终决定。本轮batchCandidates可作为新事项目标，按其中binding使用。` }
            if (code === 'GROUP_COORDINATOR_READ_MATERIAL_FIRST')
              return { received: false, feedback: `${error.message} 请先调用group_coordinator_read_material读取本轮真实resourceRef，再提交intent；needs_context不是协调最终决定。若是尚待调查的事实，将其写入objective交由Task调查。` }
            if (['GROUP_COORDINATOR_UNKNOWN_TARGET', 'GROUP_COORDINATOR_BATCH_TARGET_DISPOSITION_INVALID'].includes(code))
              return { received: false, feedback: `${error.message} 请仅修正错误绑定：已有目标用当前candidates，批次source:<runId>用当前batchCandidates且disposition为conversation或new；不要凭旧历史构造引用。` }
            if (code === 'GROUP_COORDINATOR_SOURCE_COVERAGE_INVALID')
              return { received: false, feedback: `${error.message}：非空units的spans合计必须完整覆盖sourceLength，不能省略后续条件；请修正完整决定。` }
            if (code === 'GROUP_COORDINATOR_MATERIAL_SOURCE_UNBOUND')
              return { received: false, feedback: `${error.message} 请提交对应来源完整fact单元，绑定同一source候选且replyPolicy:none，再提交整批决定。` }
            if (code === 'GROUP_COORDINATOR_MATERIAL_REFERENCE_INVALID')
              return { received: false, feedback: 'requiredExecutionMaterials只能填本轮真实resourceRef；待取得证据、表结构等属于调查objective，不是Task发起前置材料。请修正完整决定。' }
            if (code === 'GROUP_COORDINATOR_EXISTING_TASK_REQUIRES_UPDATE')
              return { received: false, feedback: '同一事项只能创建一个Task，请将create/research合并为一个创建动作；已有Task的补充请使用fact/revise，再提交完整决定。' }
            if (['MESSAGE_STALE', 'MESSAGE_COORDINATOR_STALE', 'GROUP_COORDINATOR_SOURCE_STALE'].includes(code)) {
              entry.staleReason = code
              return { received: false, feedback: '本轮来源或领取身份已失效，本轮结束，Host将重新领取当前来源。' }
            }
            if (/^(?:MESSAGE_(?:STALE|TOPIC_STALE|TASK_FACTS_STALE|SCOPE_PROOF_INVALID)|TASK_.*STALE|GROUP_COORDINATOR_.*STALE)$/u.test(code) && await current(entry))
              return { received: false, feedback: `${code}：当前来源或任务版本已改变，请重新读取受影响事实后修正决定。` }
            throw error
          }
          if (!await current(entry)) throw fail('GROUP_COORDINATOR_STALE')
          entry.decision = structuredClone(decision); entry.submitCallId = exec.callId; entry.submitted = true
          return { received: true, acceptance: acceptance ?? { authority: 'not_observed', meaning: '候选已接纳；未提供Task创建或执行证明。' } }
        } })
    }
    try {
      if (!await current(entry)) return { status: 'stale' }
      if (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)) throw Object.assign(fail('GROUP_COORDINATOR_SESSION_ALREADY_LIVE'), { coordinatorDrained: false })
      let stored
      try { stored = await ctx.sessionPersistence.inspect(binding.sessionId) }
      catch (error) { if (error.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== binding.sessionId) throw error }
      if (binding.sessionBound && !stored) throw fail('GROUP_COORDINATOR_SESSION_MISSING')
      if (stored) history(stored.events, binding)
      const workspaceDir = !stored && getWorkspaceDir ? await getWorkspaceDir({ binding: entry.binding }) : undefined
      const options = { agentOptions: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }, setup, signal: entry.abort.signal }
      entry.handle = stored ? await ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
        : await ctx.agents.create({ ...options, sessionId: binding.sessionId, ...(workspaceDir ? { meta: { cwd: workspaceDir } } : {}),
          seed: [{ type: IDENTITY, seq: 0, time: Date.now(), ignorable: true, data: { version: 1, conversationId: binding.conversationId, sessionId: binding.sessionId, creationLease: binding.leaseEpoch } }] })
      if (stored) history(entry.handle.agent.session.snapshotEvents(), binding)
      await ctx.sessions.flush(entry.handle.agent.session)
      if (!await current(entry)) return { status: 'stale' }
      await onSessionBound(binding)
      if (!await current(entry)) return { status: 'stale' }
      entry.handle.agent.steer(createUserMessage({ source: { kind: 'coordinator', groupCoordinator: entry.binding }, content: [{ type: 'text', text: JSON.stringify(input) }] }))
      await entry.handle.agent.whenIdle()
      await drain(entry)
      if (entry.cancelled || closed) return { status: 'cancelled' }
      if (entry.staleReason) return { status: 'stale', reason: entry.staleReason }
      if (!await current(entry)) return { status: 'stale' }
      return entry.accepted ? { status: 'submitted', decision: structuredClone(entry.decision) } : { status: 'no_submission' }
    } catch (error) {
      if (entry.cancelled || closed) return { status: 'cancelled' }
      throw error
    } finally { await drain(entry); if (!entry.drainError) entries.delete(binding.conversationId) }
  }
  async function cancel(conversationId) {
    const entry = entries.get(conversationId)
    if (!entry) return
    entry.cancelled = true; entry.abort.abort(fail('GROUP_COORDINATOR_CANCELLED')); entry.handle?.agent.cancel({ kind: 'user' })
    await entry.drained.promise
    if (entry.drainError) throw entry.drainError
  }
  return { run, cancel, async close() { closed = true; await Promise.all([...entries.keys()].map(cancel)) } }
}
