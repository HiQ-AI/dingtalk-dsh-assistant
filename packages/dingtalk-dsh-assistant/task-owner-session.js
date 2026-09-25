import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const IDENTITY_EVENT = 'dingtalk/task-owner-session'
const SUBMIT = 'task_owner_submit'
const fail = code => Object.assign(new Error(code), { code })
const notDrained = code => Object.assign(fail(code), { taskOwnerDrained: false })
const copy = value => structuredClone(value)

const stageSchema = { type: 'object', properties: {
  workflowId: { type: 'string' }, gate: { type: 'string', enum: ['none', 'confirmation'] },
  capabilityStep: { type: 'object', properties: {
    capabilityId: { type: 'string' }, input: { type: 'object' }, expectedEvidence: { type: 'string' },
  }, required: ['capabilityId', 'input', 'expectedEvidence'], additionalProperties: false },
}, required: ['workflowId', 'gate'], additionalProperties: false }
const assessmentSchema = { type: 'object', properties: {
  itemId: { type: 'string' }, status: { type: 'string', enum: ['satisfied'] },
  evidenceRefs: { type: 'array', items: { type: 'string' } },
}, required: ['itemId', 'status', 'evidenceRefs'], additionalProperties: false }
export const ownerDecisionSchema = { type: 'object', properties: {
  action: { type: 'string', enum: ['advance', 'wait', 'complete', 'block'] },
  summary: { type: 'string' },
  evidenceRefs: { type: 'array', items: { type: 'string' } },
  appendStages: { type: 'array', items: stageSchema },
  assessments: { type: 'array', items: assessmentSchema },
}, required: ['action', 'summary', 'evidenceRefs'], additionalProperties: false }
assertSupportedJsonSchema(ownerDecisionSchema)

function assertBinding(binding) {
  if (!binding || typeof binding.taskId !== 'string' || !binding.taskId
    || typeof binding.sessionId !== 'string' || !binding.sessionId
    || typeof binding.turnId !== 'string' || !binding.turnId
    || !Number.isSafeInteger(binding.leaseEpoch) || binding.leaseEpoch < 1
    || !Number.isSafeInteger(binding.ownerEpoch) || binding.ownerEpoch < 1
    || typeof binding.sessionBound !== 'boolean') throw fail('TASK_OWNER_BINDING_INVALID')
}

function validateHistory(events, binding) {
  const identities = events.filter(event => event.type === IDENTITY_EVENT)
  if (identities.length !== 1 || identities[0].data?.version !== 1
    || identities[0].data.taskId !== binding.taskId
    || identities[0].data.sessionId !== binding.sessionId
    || identities[0].data.ownerEpoch !== binding.ownerEpoch) throw fail('TASK_OWNER_SESSION_IDENTITY_MISMATCH')
  const leases = [identities[0].data.creationLease, ...events.flatMap(event => event.type === 'user/message' ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : [])
    .filter(message => message.source?.kind === 'coordinator' && message.source.taskOwner?.sessionId === binding.sessionId)
    .map(message => message.source.taskOwner.leaseEpoch)]
  if (leases.some(lease => !Number.isSafeInteger(lease) || lease < 1 || lease >= binding.leaseEpoch))
    throw fail('TASK_OWNER_SESSION_LEASE_NOT_ADVANCED')
}

/** 原生会话只提出本任务的决定；计划、验收和外部效果由 Host 接纳。 */
export function createTaskOwnerSessions({ ctx, isCurrent }) {
  if (typeof isCurrent !== 'function') throw fail('TASK_OWNER_CURRENT_CHECK_REQUIRED')
  const entries = new Map()
  let closed = false

  async function current(entry) {
    if (closed || entry.cancelled) return false
    if (!await isCurrent(entry.binding)) { entry.stale = true; return false }
    return !closed && !entry.cancelled
  }

  async function drain(entry) {
    return entry.draining ??= (async () => {
      try {
        if (entry.handle) {
          await entry.handle.agent.whenIdle()
          try { await ctx.sessions.flush(entry.handle.agent.session) }
          finally { await entry.handle.dispose() }
        }
      } catch (cause) {
        entry.drainError = Object.assign(notDrained('TASK_OWNER_DRAIN_FAILED'), { cause })
        throw entry.drainError
      } finally {
        clearTimeout(entry.timer)
        entry.drained.resolve()
      }
    })()
  }

  function setup(entry, onCandidate, readPage) {
    return agentCtx => {
      agentCtx.systemPrompt.section({ name: 'task:owner', order: 0, complete: true, text: `你负责一个业务任务。阅读本轮提供的有效目标、验收项、已执行成果和事件。若输入含 eventPages，先逐个调用 task_owner_read_events 读取全部页面，再提交决定；未读完不能提交。判断是否推进当前计划、等待输入、因缺证据阻塞或已满足整个目标。complete 必须对每个 acceptanceItem 提交 satisfied 的 assessments，并引用真实阶段证据；不能把阶段成功当作整体目标完成。日常任务从 capabilities 中选择一项真实可用的只读能力，在 appendStages 中追加 workflowId=task-general-capability、gate=none 和 capabilityStep（能力参数与预期证据）；Host 冻结范围并核验执行结果，一次只选择一步。缺能力时 block，不能虚构已执行。仅报告语言改变时，保留已核验业务产物和验收结论，按 report.preference.changed 事件所要求的语言重新写 summary，不追加流程。新增流程只能在 appendStages 中建议，不能自行执行或审批。最后仅调用 ${SUBMIT}。` })
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.tools.guard(exec => {
        if (exec.name !== SUBMIT && exec.name !== 'task_owner_read_events') return 'task_owner_tool_not_allowed'
        if (exec.name === SUBMIT && entry.unreadPages.size) return 'task_owner_events_unread'
        if (closed || entry.cancelled || entry.stale || entry.attempted) return 'task_owner_turn_stopped'
      })
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!await current(entry) || entry.attempted || entry.steps >= entry.maxSteps) return { kind: 'reject' }
        entry.steps++
        return next()
      })
      agentCtx.on('tools/pre-execute', async (_exec, next) => {
        if (!await current(entry)) return { kind: 'deny', reason: 'task_owner_stale' }
        return next()
      })
      agentCtx.on('tools/result', (exec, result) => {
        if (exec.name === SUBMIT && exec.callId === entry.submissionCallId && !result.isError) entry.accepted = true
      })
      agentCtx.tools.register({
        name: SUBMIT,
        description: '持久提交当前任务负责人的候选决定；回执仅表示候选已收到，Host 稍后核验。',
        parameters: { type: 'object', properties: { decision: ownerDecisionSchema }, required: ['decision'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { received: { type: 'boolean' } }, required: ['received'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          entry.attempted = true
          const problems = validateJsonSchemaValue({ type: 'object', properties: { decision: ownerDecisionSchema },
            required: ['decision'], additionalProperties: false }, args)
          if (problems.length) throw fail('TASK_OWNER_DECISION_INVALID')
          if (!args.decision.summary.trim() || args.decision.summary.length > 8000
            || args.decision.evidenceRefs.length > 64 || args.decision.appendStages?.length > 16
            || args.decision.assessments?.length > 32
            || args.decision.appendStages?.some(stage => !stage.workflowId.trim())
            || Buffer.byteLength(JSON.stringify(args.decision), 'utf8') > 16000) throw fail('TASK_OWNER_DECISION_INVALID')
          if (!await current(entry)) throw fail('TASK_OWNER_STALE')
          exec.signal.throwIfAborted()
          await onCandidate(copy(args.decision), entry.binding)
          entry.decision = copy(args.decision)
          entry.submissionCallId = exec.callId
          exec.concludeTurn()
          return { received: true }
        },
      })
      if (entry.unreadPages.size) agentCtx.tools.register({
        name: 'task_owner_read_events',
        description: '读取本任务当前水位内的一页持久事件；所有页面读完后才能提交候选。',
        parameters: { type: 'object', properties: { pageRef: { type: 'string' } },
          required: ['pageRef'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { page: { type: 'string' } },
          required: ['page'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: value.page }] },
        async execute({ pageRef }, exec) {
          if (!await current(entry) || !entry.unreadPages.has(pageRef)) throw fail('TASK_OWNER_PAGE_NOT_ALLOWED')
          exec.signal.throwIfAborted()
          const page = await readPage(pageRef)
          entry.unreadPages.delete(pageRef)
          return { page: JSON.stringify(page) }
        },
      })
    }
  }

  async function run({ binding, input, provider, model, reasoningEffort, onSessionBound, onCandidate, readPage, timeoutMs = 120000 }) {
    assertBinding(binding)
    if (!provider || !model || typeof onSessionBound !== 'function' || typeof onCandidate !== 'function'
      || input?.eventPages?.length && typeof readPage !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2147483647) throw fail('TASK_OWNER_RUN_INVALID')
    if (closed) throw fail('TASK_OWNER_CLOSED')
    if (entries.has(binding.taskId)) throw notDrained('TASK_OWNER_BUSY')
    binding = Object.freeze(copy(binding))
    const entry = { binding, cancelled: false, stale: false, attempted: false, accepted: false, steps: 0,
      maxSteps: input.eventPages?.length ? 64 : 8,
      unreadPages: new Set((input.eventPages ?? []).map(page => page.ref)),
      abort: new AbortController(), drained: Promise.withResolvers() }
    entries.set(binding.taskId, entry)
    entry.timer = setTimeout(() => {
      entry.abort.abort(fail('TASK_OWNER_TIMEOUT'))
      entry.handle?.agent.cancel({ kind: 'user' })
    }, timeoutMs)
    try {
      if (!await current(entry)) return { status: 'stale' }
      if (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)) throw notDrained('TASK_OWNER_SESSION_ALREADY_LIVE')
      let stored
      try { stored = await ctx.sessionPersistence.inspect(binding.sessionId) }
      catch (error) {
        if (error.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== binding.sessionId) throw error
      }
      if (binding.sessionBound && !stored) throw fail('TASK_OWNER_SESSION_MISSING')
      if (stored) validateHistory(stored.events, binding)
      if (!await current(entry)) return { status: 'stale' }
      const options = { agentOptions: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
        setup: setup(entry, onCandidate, readPage), signal: entry.abort.signal }
      entry.handle = stored ? await ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
        : await ctx.agents.create({ ...options, sessionId: binding.sessionId, seed: [{ type: IDENTITY_EVENT,
          seq: 0, time: Date.now(), ignorable: true,
          data: { version: 1, taskId: binding.taskId, sessionId: binding.sessionId,
            ownerEpoch: binding.ownerEpoch, creationLease: binding.leaseEpoch } }] })
      if (stored) validateHistory(entry.handle.agent.session.snapshotEvents(), binding)
      await ctx.sessions.flush(entry.handle.agent.session)
      if (!await current(entry)) return { status: 'stale' }
      await onSessionBound(binding)
      if (!await current(entry)) return { status: 'stale' }
      entry.handle.agent.steer(createUserMessage({ source: { kind: 'coordinator',
        taskOwner: { taskId: binding.taskId, sessionId: binding.sessionId, leaseEpoch: binding.leaseEpoch,
          turnId: binding.turnId } }, content: [{ type: 'text', text: JSON.stringify(input) }] }))
      await entry.handle.agent.whenIdle()
      await drain(entry)
      if (!await current(entry)) return { status: 'stale' }
      return entry.accepted ? { status: 'submitted', decision: copy(entry.decision) }
        : { status: 'no_submission' }
    } catch (error) {
      if (!entry.handle && (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)))
        throw error.taskOwnerDrained === false ? error : Object.assign(notDrained('TASK_OWNER_SESSION_ALREADY_LIVE'), { cause: error })
      if (entry.cancelled || closed) return { status: 'cancelled' }
      if (entry.abort.signal.aborted) return { status: 'no_submission', reason: 'TASK_OWNER_TIMEOUT' }
      throw error
    } finally {
      await drain(entry)
      if (!entry.drainError) entries.delete(binding.taskId)
    }
  }

  async function cancel(taskId) {
    const entry = entries.get(taskId)
    if (!entry) return
    entry.cancelled = true
    entry.abort.abort(fail('TASK_OWNER_CANCELLED'))
    entry.handle?.agent.cancel({ kind: 'user' })
    await entry.drained.promise
    if (entry.drainError) throw entry.drainError
  }

  return { run, cancel, async close() {
    closed = true
    await Promise.all([...entries.keys()].map(cancel))
  } }
}
