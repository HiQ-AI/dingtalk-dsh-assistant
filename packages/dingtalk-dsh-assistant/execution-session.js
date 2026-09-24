import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const IDENTITY_EVENT = 'dingtalk/execution-session'
const SUBMIT = 'execution_node_submit'
const identityKeys = ['taskId', 'runId', 'nodeRunId', 'generation', 'inputDigest', 'sessionId']
const failure = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code })
const notDrained = code => Object.assign(failure(code), { executionDrained: false })
const copy = value => structuredClone(value)
const identityOf = binding => Object.fromEntries(identityKeys.map(key => [key, binding[key]]))

function validateBinding(binding) {
  for (const key of ['taskId', 'runId', 'nodeRunId', 'inputDigest', 'sessionId']) {
    if (typeof binding?.[key] !== 'string' || !binding[key]) throw failure('execution_binding_invalid', key)
  }
  for (const key of ['generation', 'leaseEpoch']) {
    if (!Number.isSafeInteger(binding[key]) || binding[key] < 1) throw failure('execution_binding_invalid', key)
  }
  if (typeof binding.sessionBound !== 'boolean') throw failure('execution_binding_invalid', 'sessionBound')
}

function validateHistory(events, binding) {
  const identities = events.filter(event => event.type === IDENTITY_EVENT)
  if (identities.length !== 1 || identities[0].data.version !== 1
    || identityKeys.some(key => identities[0].data.identity?.[key] !== binding[key])) {
    throw failure('execution_session_identity_mismatch')
  }
  const leases = [identities[0].data.creationLease, ...events.flatMap(event => event.type === 'user/message' ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : [])
    .filter(message => message.source?.kind === 'coordinator' && message.source.executionSession?.sessionId === binding.sessionId)
    .map(message => message.source.executionSession.leaseEpoch)]
  if (leases.some(lease => !Number.isSafeInteger(lease) || lease < 1 || lease >= binding.leaseEpoch)) {
    throw failure('execution_session_lease_not_advanced')
  }
}

/**
 * 节点只持有本次原生运行句柄。身份/租约来自 Controller；业务完成由 onResult 持久接纳。
 * outputSchema 使用 dsh-tools 支持的 JSON Schema。工具仅提交 { output }，不接受模型身份。
 */
export function createExecutionSessions({ ctx, isCurrent, repositoryInspect }) {
  if (typeof isCurrent !== 'function') throw failure('execution_current_check_required')
  const entries = new Map(), sessions = new Map()
  let closed = false

  async function current(entry) {
    if (closed || entry.cancelled) return false
    if (!await isCurrent(entry.binding)) { entry.stale = true; return false }
    return !closed && !entry.cancelled
  }

  function halt(entry, code) { entry.haltCode ??= code }

  async function drain(entry) {
    return entry.draining ??= (async () => {
      try {
        if (entry.handle) {
          await entry.handle.agent.whenIdle()
          try { await ctx.sessions.flush(entry.handle.agent.session) }
          finally { await entry.handle.dispose() }
        }
      } catch (error) {
        entry.drainError = Object.assign(failure('execution_session_drain_failed'), { executionDrained: false, cause: error })
        throw entry.drainError
      }
      finally { clearTimeout(entry.timer); entry.drained.resolve() }
    })()
  }

  function setup(entry, definition) {
    return agentCtx => {
      const allowed = new Set([...definition.allowedTools, SUBMIT])
      agentCtx.systemPrompt.section({ name: 'execution:node', order: 0, text: definition.prompt, complete: true })
      agentCtx.tools.restrict({ allow: definition.allowedTools.filter(name => name !== 'engineering_repo_inspect') })
      // restrict 只过滤继承工具；单调 guard 同时约束后来注册的 scope-local 工具。
      agentCtx.tools.guard(exec => {
        if (!allowed.has(exec.name)) { halt(entry, 'execution_tool_not_allowed'); return 'execution_tool_not_allowed' }
        if (closed || entry.cancelled || entry.stale || entry.haltCode || entry.attempted) return 'execution_attempt_stopped'
      })
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!await current(entry) || entry.attempted || entry.haltCode) return { kind: 'reject' }
        if (entry.steps >= definition.maxSteps) { halt(entry, 'execution_step_budget_exhausted'); return { kind: 'reject' } }
        entry.steps++
        return next()
      })
      agentCtx.on('tools/pre-execute', async (_exec, next) => {
        if (!await current(entry)) return { kind: 'deny', reason: 'execution_binding_stale' }
        return next()
      })
      agentCtx.on('tools/result', (exec, result) => {
        if (result.isError) halt(entry, exec.name === SUBMIT ? 'execution_submission_rejected' : 'execution_tool_failed')
        if (exec.name === SUBMIT && exec.callId === entry.submissionCallId && !result.isError) entry.accepted = true
      })
      agentCtx.tools.register({
        name: SUBMIT,
        description: '提交此节点的业务输出；一次提交结束本次执行，不传任务、代际或租约身份。',
        parameters: { type: 'object', properties: { output: definition.outputSchema }, required: ['output'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { received: { type: 'boolean' } }, required: ['received'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          entry.attempted = true
          const problems = validateJsonSchemaValue({ type: 'object', properties: { output: definition.outputSchema }, required: ['output'], additionalProperties: false }, args)
          if (problems.length) { halt(entry, 'execution_output_invalid'); throw failure('execution_output_invalid', problems.join('; ')) }
          if (!await current(entry)) throw failure('execution_binding_stale')
          exec.signal.throwIfAborted()
          entry.output = copy(args.output)
          entry.submissionCallId = exec.callId
          // 不在工具栈内调用 Controller：原生工具结果与 post-execute 必须先排空。
          exec.concludeTurn()
          return { received: true }
        },
      })
      if (definition.allowedTools.includes('engineering_repo_inspect')) agentCtx.tools.register({
        name: 'engineering_repo_inspect',
        description: '在本任务受管仓库中按需列出路径、搜索文本或分段读取文件；返回完整文件 SHA256 用于修改校验。',
        parameters: { type: 'object', properties: {
          operation: { type: 'string', enum: ['list', 'search', 'read'] }, query: { type: 'string' }, path: { type: 'string' },
          offset: { type: 'integer' }, limit: { type: 'integer' },
        }, required: ['operation'], additionalProperties: false },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          if (typeof repositoryInspect !== 'function') throw failure('execution_repository_inspector_unavailable')
          if (!await current(entry)) throw failure('execution_binding_stale')
          exec.signal.throwIfAborted()
          return repositoryInspect(entry.binding, args, exec.signal, entry.input)
        },
      })
    }
  }

  async function run({ binding, input, definition, onSessionBound, onResult }) {
    if (closed) return Promise.reject(failure('execution_sessions_closed'))
    try {
      validateBinding(binding)
      if (!definition || typeof definition.prompt !== 'string' || !definition.provider || !definition.model
        || !Array.isArray(definition.allowedTools) || definition.allowedTools.some(name => typeof name !== 'string' || !name || name === SUBMIT)) throw failure('execution_definition_invalid')
      if (!Number.isSafeInteger(definition.maxSteps ?? 32) || (definition.maxSteps ?? 32) < 1 || (definition.maxSteps ?? 32) > 256
        || !Number.isSafeInteger(definition.timeoutMs ?? 120000) || (definition.timeoutMs ?? 120000) < 1 || (definition.timeoutMs ?? 120000) > 2147483647) throw failure('execution_budget_invalid')
      assertSupportedJsonSchema(definition.outputSchema)
      if (typeof onSessionBound !== 'function' || typeof onResult !== 'function') throw failure('execution_callbacks_required')
      if (entries.has(binding.runId) || sessions.has(binding.sessionId)) throw notDrained('execution_run_busy')
    } catch (error) { return Promise.reject(error) }
    binding = Object.freeze(copy(binding))
    const entry = { binding, input: copy(input), cancelled: false, stale: false, attempted: false, accepted: false, steps: 0, abort: new AbortController(), drained: Promise.withResolvers() }
    // 定义还可含 Controller 的 mapper/checker 函数；此边界只快照模型实际需要的字段。
    const fixedDefinition = copy({ provider: definition.provider, model: definition.model, ...(definition.reasoningEffort === undefined ? {} : { reasoningEffort: definition.reasoningEffort }), prompt: definition.prompt, allowedTools: definition.allowedTools, outputSchema: definition.outputSchema, maxSteps: definition.maxSteps ?? 32, timeoutMs: definition.timeoutMs ?? 120000 })
    entries.set(binding.runId, entry); sessions.set(binding.sessionId, entry)
    entry.timer = setTimeout(() => {
      halt(entry, 'execution_timeout')
      entry.abort.abort(failure('execution_timeout'))
      entry.handle?.agent.cancel({ kind: 'user' })
    }, fixedDefinition.timeoutMs)
    return (async () => {
      try {
        if (!await current(entry)) return { status: entry.cancelled || closed ? 'cancelled' : 'stale' }
        if (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)) throw notDrained('execution_session_already_live')
        let stored
        try { stored = await ctx.sessionPersistence.inspect(binding.sessionId) }
        catch (error) {
          // 原生 inspect 用专门错误表示不存在；I/O、损坏和其他错误必须继续失败。
          if (error.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== binding.sessionId) throw error
        }
        if (binding.sessionBound && !stored) throw failure('execution_session_missing')
        if (stored) validateHistory(stored.events, entry.binding)
        if (!await current(entry)) return { status: entry.cancelled || closed ? 'cancelled' : 'stale' }
        const options = { agentOptions: { provider: fixedDefinition.provider, model: fixedDefinition.model, ...(fixedDefinition.reasoningEffort === undefined ? {} : { reasoningEffort: fixedDefinition.reasoningEffort }) }, setup: setup(entry, fixedDefinition), signal: entry.abort.signal }
        entry.handle = stored
          ? await ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
          : await ctx.agents.create({ ...options, sessionId: binding.sessionId,
            // 当前原生 append 不提供 ignorable 参数；用受支持 seed 保留不参与原生投影的插件身份。
            seed: [{ type: IDENTITY_EVENT, seq: 0, time: Date.now(), ignorable: true, data: { version: 1, identity: identityOf(entry.binding), creationLease: binding.leaseEpoch } }],
          })
        const session = entry.handle.agent.session
        // prepare/resume 可能追加原生恢复事件；再次核对已发布句柄的同一历史身份。
        if (stored) validateHistory(session.snapshotEvents(), entry.binding)
        await ctx.sessions.flush(session)
        if (!await current(entry)) return { status: entry.cancelled || closed ? 'cancelled' : 'stale' }
        await onSessionBound()
        if (!await current(entry)) return { status: entry.cancelled || closed ? 'cancelled' : 'stale' }
        if (entry.haltCode) return { status: 'no_submission', reason: entry.haltCode }
        // 租约是 Host 的来源元数据，正常 inbox/user-message 持久化保留，不是模型参数。
        entry.handle.agent.steer(createUserMessage({ source: { kind: 'coordinator', executionSession: { sessionId: binding.sessionId, leaseEpoch: binding.leaseEpoch } }, content: [{ type: 'text', text: JSON.stringify(entry.input) }] }))
        await entry.handle.agent.whenIdle()
        await drain(entry)
        if (entry.cancelled || closed) return { status: 'cancelled' }
        if (!await current(entry)) return { status: 'stale' }
        if (!entry.accepted || entry.haltCode) return { status: 'no_submission', reason: entry.haltCode ?? 'execution_no_submission' }
        await onResult(copy(entry.output))
        return { status: 'submitted', output: copy(entry.output) }
      } catch (error) {
        // inspect 与 create/resume 之间也可能出现其他所有者；没有句柄就无权确认它已退出。
        if (!entry.handle && (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId))) {
          throw error.executionDrained === false ? error : Object.assign(notDrained('execution_session_already_live'), { cause: error })
        }
        if (entry.cancelled || closed) return { status: 'cancelled' }
        if (entry.haltCode === 'execution_timeout') return { status: 'no_submission', reason: entry.haltCode }
        throw error
      } finally {
        await drain(entry)
        // 未证明排空的句柄保留占位，禁止创建替身。
        if (!entry.drainError) { entries.delete(entry.binding.runId); sessions.delete(entry.binding.sessionId) }
      }
    })()
  }

  async function cancel(runId) {
    const entry = entries.get(runId)
    if (!entry) return
    entry.cancelled = true
    entry.abort.abort(failure('execution_cancelled'))
    entry.handle?.agent.cancel({ kind: 'user' })
    await entry.drained.promise
    if (entry.drainError) throw entry.drainError
  }

  // cancel 只排空本适配器拥有的句柄。恢复写入 node.drained 前还须核对原生注册表。
  function assertDrained(binding) {
    if (typeof binding?.runId !== 'string' || !binding.runId) throw failure('execution_binding_invalid', 'runId')
    const entry = entries.get(binding.runId) ?? sessions.get(binding.sessionId)
    if (entry?.drainError) throw entry.drainError
    if (entry) throw notDrained('execution_run_busy')
    if (binding.sessionId && (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId))) throw notDrained('execution_session_already_live')
    return true
  }

  return { run, cancel, assertDrained, async close() {
    closed = true
    await Promise.all([...entries.keys()].map(cancel))
  } }
}
