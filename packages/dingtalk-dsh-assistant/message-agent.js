import { assertGroupReply } from './workflow-notifications.js'
import { randomUUID } from 'node:crypto'
import { createExecutionSessions } from './execution-session.js'
import { executionDigest, executionError } from './execution-artifacts.js'
import { agentWorkDefinition, validateAgentWorkResult, classifyAgentWorkOutputError } from './agent-work.js'
import { readExecutedAgentQueryRefs } from './agent-query-tools.js'

const bindingOf = entry => ({ kind: 'message-unit', runId: entry.runId, unitId: entry.unitId,
  inputVersion: entry.inputVersion, inputDigest: entry.inputDigest, sessionId: entry.sessionId,
  leaseEpoch: entry.leaseEpoch, sessionBound: entry.sessionBound })
const commandBinding = entry => Object.fromEntries(['commandId', 'commandLeaseEpoch', 'leaseEpoch',
  'inputVersion', 'inputDigest', 'sessionId'].map(key => [key, entry[key]]))

/** 消息控制器拥有执行记录；共用原生会话基础，不创建业务 Task 或平行调度器。 */
export function createMessageAgentController({ ctx, store, artifacts, tools, modelConfig,
  prepareInput, verifyEvidence, ownerActorId, getWorkspaceDir, sessionRunner, selectTools, onCommandSettled }) {
  const flights = new Map()
  let closed = false
  const read = commandId => store.query({ kind: 'message.agent.execution', commandId })
  const command = async (kind, args) => (await store.command({ id: `${kind}:${randomUUID()}`, kind, args })).result
  const isCurrent = async binding => {
    const data = await store.query({ kind: 'message.run', runId: binding.runId })
    const entry = data.executions?.find(item => item.unitId === binding.unitId && item.sessionId === binding.sessionId)
    return !!entry && entry.status === 'running' && data.run.status !== 'superseded'
      && entry.inputVersion === binding.inputVersion && entry.inputDigest === binding.inputDigest
      && entry.leaseEpoch === binding.leaseEpoch
  }
  const sessions = sessionRunner ?? createExecutionSessions({ ctx, tools, isCurrent, getWorkspaceDir })

  const validateOutput = async (entry, input, result) => {
    const live = ctx.sessions.get(entry.sessionId)
    const events = live ? live.snapshotEvents() : (await ctx.sessionPersistence.inspect(entry.sessionId)).events
    const accepted = await validateAgentWorkResult(result, {
      sourceRefs: input.sourceRefs ?? [],
      executedQueryRefs: readExecutedAgentQueryRefs(events, tools.map(tool => tool.name)),
      verifyEvidence: refs => verifyEvidence({ refs, entry, binding: bindingOf(entry), input }),
    })
    assertGroupReply(accepted.summary, [entry.runId, entry.unitId, entry.sessionId])
    assertGroupReply(accepted.question, [entry.runId, entry.unitId, entry.sessionId])
    return accepted
  }
  async function finish(entry, input, result) {
    const accepted = await validateOutput(entry, input, result)
    const saved = await artifacts.put(accepted)
    if (accepted.outcome === 'needs_input') {
      await command('message.agent.wait', { ...commandBinding(entry), drained: true,
        conversationId: input.scope.conversationId,
        request: { requestId: `agent-question-${executionDigest([entry.commandId, entry.inputVersion])}`,
          question: accepted.question, permittedActors: [...new Set([input.scope.actorId, ownerActorId])].filter(Boolean) } })
      return
    }
    const answer = { status: accepted.outcome === 'completed' ? 'answered' : 'blocked',
      reply: accepted.summary, resultRef: saved.ref, evidenceRefs: accepted.evidenceRefs,
      limitations: accepted.limitations }
    await command('message.agent.complete', { ...commandBinding(entry), drained: true, resultRef: saved.ref, result: answer })
    await command('message.command.complete', { commandId: entry.commandId, leaseEpoch: entry.commandLeaseEpoch, result: answer })
    return true
  }

  async function execute(entry, input, definition) {
    const binding = bindingOf(entry)
    let settled = false
    try {
      const outcome = await sessions.run({ binding, input, definition,
        onSessionBound: () => command('message.agent.bind', commandBinding(entry)),
        validateOutput: result => validateOutput(entry, input, result), classifyOutputError: classifyAgentWorkOutputError,
        onResult: async result => { settled = await finish(entry, input, result) } })
      // 原生 run 的 finally 已释放占位后才唤醒同消息的后续命令。
      if (outcome.status === 'submitted') { if (settled) await onCommandSettled?.(entry.runId); return }
      if (outcome.status === 'cancelled' || outcome.status === 'stale' || !await isCurrent(binding)) {
        await command('message.agent.drained', { commandId: entry.commandId, leaseEpoch: entry.leaseEpoch, sessionId: entry.sessionId })
        return
      }
      throw executionError(outcome.reason ?? 'AGENT_WORK_NO_RESULT')
    } catch (error) {
      // 未证明排空时保留执行占用，不能以一条失败通知宣称已安全终止。
      if (error.executionDrained === false) throw error
      if (!await isCurrent(binding)) {
        await command('message.agent.drained', { commandId: entry.commandId, leaseEpoch: entry.leaseEpoch, sessionId: entry.sessionId })
        return
      }
      const failure = { status: 'blocked', reply: '本次查询因系统读取问题未完成，执行已停止，需要修复后继续。',
        reason: error.code ?? error.message }
      const saved = await artifacts.put(failure)
      await command('message.agent.fail', { ...commandBinding(entry), drained: true, error: failure.reason,
        resultRef: saved.ref, result: failure })
      await command('message.command.complete', { commandId: entry.commandId, leaseEpoch: entry.commandLeaseEpoch, result: failure })
      await onCommandSettled?.(entry.runId)
    }
  }

  async function start(action, info) {
    if (closed) throw executionError('MESSAGE_AGENT_CLOSED')
    if (flights.has(info.commandId)) return { executionPending: true }
    const prior = await read(info.commandId)
    const input = prior?.inputRef ? await artifacts.read(prior.inputRef) : await prepareInput(action, info)
    const terminal = prior && ['succeeded', 'failed'].includes(prior.status)
    const selected = terminal ? null : await modelConfig({ stage: 'answer', input })
    const allowedTools = terminal ? [] : selectTools ? await selectTools(input) : tools.map(tool => tool.name)
    if (!Array.isArray(allowedTools) || allowedTools.some(name => !tools.some(tool => tool.name === name))) throw executionError('MESSAGE_AGENT_TOOLS_INVALID')
    const definition = terminal ? null : agentWorkDefinition({ ...selected, allowedTools })
    const inputRef = prior?.inputRef ?? (await artifacts.put(input)).ref
    const { execution: entry, cached } = await command('message.agent.begin', {
      commandId: info.commandId, commandLeaseEpoch: info.commandLeaseEpoch,
      inputVersion: prior?.inputVersion ?? 1, inputDigest: executionDigest(input), inputRef,
      sessionId: prior?.sessionId ?? `answer-${executionDigest(info.commandId).slice(0, 40)}`,
      toolPolicyDigest: terminal ? prior.toolPolicyDigest : executionDigest({ definition, scope: input.scope }), mode: 'read-only' })
    if (cached) return entry.result
    const flight = { entry, error: null, promise: null }
    flights.set(info.commandId, flight)
    flight.promise = execute(entry, input, definition).catch(error => { flight.error = error })
      .finally(() => { if (!flight.error) flights.delete(info.commandId) })
    return { executionPending: true }
  }

  async function prepareRetry(action, info, { retryKey, reason }) {
    const prior = await read(info.commandId)
    if (!prior || prior.status !== 'failed' || !prior.drained || prior.error !== 'execution_tool_failed') throw executionError('MESSAGE_READONLY_RETRY_FORBIDDEN')
    const input = await prepareInput(action, info)
    const selected = await modelConfig({ stage: 'answer', input })
    const allowedTools = selectTools ? await selectTools(input) : tools.map(tool => tool.name)
    if (!Array.isArray(allowedTools) || allowedTools.some(name => !tools.some(tool => tool.name === name))) throw executionError('MESSAGE_AGENT_TOOLS_INVALID')
    const definition = agentWorkDefinition({ ...selected, allowedTools })
    return { commandId: info.commandId, expectedInputVersion: prior.inputVersion, expectedInputDigest: prior.inputDigest,
      expectedLeaseEpoch: prior.leaseEpoch, sourceVersion: info.run.sourceVersion, expectedRunRevision: info.run.revision,
      retryKey, reason, inputVersion: prior.inputVersion + 1, inputDigest: executionDigest(input), inputRef: (await artifacts.put(input)).ref,
      sessionId: `answer-${executionDigest([info.commandId, retryKey, prior.inputVersion + 1]).slice(0, 40)}`,
      toolPolicyDigest: executionDigest({ definition, scope: input.scope }) }
  }

  async function resume({ request, data, identity, eventId, answer }) {
    const entry = await read(request.commandId)
    if (!entry) throw executionError('MESSAGE_AGENT_NOT_FOUND')
    if (entry.inputHistory.some(item => item.requestId === request.id && item.eventId === eventId)) {
      return command('message.agent.resume', { commandId: entry.commandId, requestId: request.id,
        eventId, actorId: identity.actorId, conversationId: data.run.conversationId, answer,
        inputVersion: entry.inputVersion, inputDigest: entry.inputDigest, inputRef: entry.inputRef })
    }
    const previous = await artifacts.read(entry.inputRef)
    const input = { ...previous, clarificationAnswers: [...(previous.clarificationAnswers ?? []),
      { requestId: request.id, eventId, actorId: identity.actorId, question: request.question, answer }] }
    const saved = await artifacts.put(input)
    return command('message.agent.resume', { commandId: entry.commandId, requestId: request.id,
      eventId, actorId: identity.actorId, conversationId: data.run.conversationId, answer,
      inputVersion: entry.inputVersion + 1, inputDigest: executionDigest(input), inputRef: saved.ref })
  }

  async function cancel(commandId, reason) {
    const entry = await read(commandId)
    if (!entry) throw executionError('MESSAGE_AGENT_NOT_FOUND')
    const cancelled = await command('message.agent.cancel', { commandId, expectedLeaseEpoch: entry.leaseEpoch, reason })
    if (cancelled.execution.drained) return cancelled
    const flight = flights.get(commandId)
    await sessions.cancel(bindingOf(entry))
    if (flight) {
      await flight.promise
    }
    // 没有本进程 flight 时，必须由原生注册表确认不存在仍运行的同身份会话。
    if (typeof sessions.assertDrained === 'function') {
      if (await sessions.assertDrained(bindingOf(entry)) !== true) throw executionError('MESSAGE_AGENT_DRAIN_UNCONFIRMED')
    }
    else if (!flight || flight.error) throw flight?.error ?? executionError('MESSAGE_AGENT_DRAIN_UNCONFIRMED')
    // 即使先前启动失败，只有原生注册表明确确认无占用才能完成取消。
    flights.delete(commandId)
    return command('message.agent.drained', { commandId, leaseEpoch: entry.leaseEpoch, sessionId: entry.sessionId })
  }

  return { start, prepareRetry, resume, cancel, isCurrent,
    async reconcile() {
      for (const flight of flights.values()) {
        if (flight.error) throw flight.error
        const binding = bindingOf(flight.entry)
        if (!await isCurrent(binding)) await sessions.cancel(binding)
      }
    },
    async idle() { await Promise.all([...flights.values()].map(item => item.promise));
      const failed = [...flights.values()].find(item => item.error); if (failed) throw failed.error },
    async close() { closed = true; await sessions.close(); await this.idle() },
  }
}
