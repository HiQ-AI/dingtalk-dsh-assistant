import { createHash } from 'node:crypto'
import { inspectSession } from './session-persistence.js'
import { safeNotificationDetail } from './notification-delivery.js'

const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const results = event => event.type !== 'tool/result' ? [] : event.data.message?.role === 'tool' ? [event.data.message] : event.data.message?.content ?? []
export const legacyDrainedError = 'execution_background_result_not_supported: The tool returned a background job; its managed process was stopped and drained. Background execution is not supported by this task executor.'
const identity = (events, binding) => events.some(event => event.type === 'plugin:dingtalk/execution-session'
  && event.data.identity?.kind === 'task-execution' && event.data.identity.taskId === binding.taskId
  && event.data.identity.executionId === binding.executionId && event.data.identity.sessionId === binding.sessionId)
const inputFor = (events, binding) => events.findLast(event => event.type === 'user/message'
  && event.data.source?.executionSession?.sessionId === binding.sessionId
  && event.data.source.executionSession.leaseEpoch === binding.leaseEpoch
  && event.data.source.executionSession.inputVersion === binding.inputVersion
  && event.data.source.executionSession.inputDigest === binding.inputDigest)

/** 原调用作为调查材料提供，必须绑定真实日志和账本摘要；不把它当成效果成功证明。 */
export async function readNativeOperationContext({ ctx, operation }) {
  const binding = operation.dispatchBinding
  if (!binding || !operation.result?.callId) return null
  const { events } = await inspectSession(ctx.sessionPersistence, binding.sessionId)
  if (!identity(events, binding)) return null
  const input = inputFor(events, binding)
  if (!input) return null
  const callId = operation.result.callId
  if (operation.key !== `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${callId}`) return null
  const call = events.find(event => event.seq > input.seq && event.type === 'tool/call' && event.data.callId === callId && event.data.name === operation.definition.toolName)
  let args
  try { args = JSON.parse(call?.data.arguments) } catch { return null }
  if (hash(args) !== operation.definition.argumentsDigest) return null
  const resultEvent = events.find(event => event.seq > call.seq && results(event).some(result => result.toolCallId === callId
    && result.isError === operation.result.isError && hash(result.content) === operation.result.resultDigest))
  if (!resultEvent) return null
  return { operationId: operation.operationId, sessionId: binding.sessionId, toolName: call.data.name, arguments: args,
    result: results(resultEvent).find(result => result.toolCallId === callId), callSequence: call.seq, resultSequence: resultEvent.seq,
    limitation: '原生调用及结果仅用于定位调查对象，不证明命令成功或没有部分效果；不能重放原命令。' }
}

/** 仅对账已结束的原生网页读取错误；写工具的错误结果仍不能证明效果。 */
export async function inspectFailedNativeWebRead({ ctx, operation, execution }) {
  const binding = operation.dispatchBinding
  if (operation.state !== 'unknown' || !binding || !['web_fetch', 'web_search'].includes(operation.definition?.toolName)
    || operation.definition.effectClass !== undefined && !['read', 'pure'].includes(operation.definition.effectClass)
    || operation.executionId !== execution?.executionId || operation.taskId !== execution.taskId
    || binding.sessionId !== execution.sessionId || !execution.drained || execution.recovering
    || ctx.agents.get(execution.sessionId) || ctx.sessions.get(execution.sessionId)
    || operation.result?.isError !== true || operation.result.cancelled === true
    || operation.result.toolName !== operation.definition.toolName) return null
  const jobs = ctx.get?.('jobs')
  if (!jobs?.list || jobs.list(execution.sessionId).some(job => ['running', 'stopping'].includes(job.status))) return null
  const original = await readNativeOperationContext({ ctx, operation })
  if (!original || original.result.isError !== true) return null
  const { events } = await inspectSession(ctx.sessionPersistence, binding.sessionId)
  const input = inputFor(events, binding)
  const start = events.findLast(event => event.seq < original.callSequence && event.type === 'turn/start')
  const result = events.find(event => event.seq === original.resultSequence && event.type === 'tool/result')
  const end = events.find(event => event.seq > original.resultSequence && event.type === 'turn/end')
  if (!input || !start || input.seq < start.seq || !Number.isSafeInteger(start.data.turn) || result?.data.turn !== start.data.turn
    || end?.data.turn !== start.data.turn || end.data.reason?.kind !== 'completed'
    || events.some(event => event.seq > start.seq && event.seq < end.seq && (event.type === 'turn/end' || event.type === 'turn/start'))) return null
  return { kind: 'native-web-read-failed', operationId: operation.operationId, operationDigest: hash(operation),
    taskId: operation.taskId, executionId: execution.executionId, sessionId: binding.sessionId,
    callId: operation.result.callId, toolName: operation.definition.toolName,
    argumentsDigest: operation.definition.argumentsDigest, resultDigest: operation.result.resultDigest,
    resultSequence: original.resultSequence, turnEndSequence: end.seq }
}

// Compatibility with the retired a5 promotion rejection only. That exact Host
// path awaited terminate + waitForExit before throwing. A model summary, stderr,
// arbitrary error, or an execution's self-reported result is never a drain proof.
export async function inspectStoppedNativeOperation({ ctx, operation, execution, executions }) {
  const binding = operation.dispatchBinding
  const live = sessionId => ctx.agents.get(sessionId) || ctx.sessions.get(sessionId)
  if (operation.state !== 'unknown' || !binding || !['bash','pwsh'].includes(operation.definition?.toolName)
    || operation.executionId !== execution?.executionId || operation.taskId !== execution.taskId
    || binding.sessionId !== execution.sessionId || !execution.drained || execution.recovering || live(execution.sessionId)
    || operation.result?.isError !== true || operation.result.toolName !== operation.definition.toolName) return null
  const jobs = ctx.get?.('jobs')
  if (!jobs?.list || jobs.list(execution.sessionId).some(job => ['running','stopping'].includes(job.status))) return null
  const saved = await inspectSession(ctx.sessionPersistence, execution.sessionId), events = saved.events
  if (!identity(events, binding)) return null
  const input = inputFor(events, binding)
  if (!input) return null
  const callId = operation.result.callId
  if (operation.key !== `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${callId}`) return null
  const call = events.find(event => event.seq > input.seq && event.type === 'tool/call' && event.data.callId === callId && event.data.name === operation.definition.toolName)
  let args
  try { args = JSON.parse(call?.data.arguments) } catch { return null }
  if (hash(args) !== operation.definition.argumentsDigest) return null
  const resultEvent = events.find(event => event.seq > call.seq && results(event).some(result => result.toolCallId === callId && result.isError === true
    && result.content?.length === 1 && result.content[0].type === 'text'
    && [legacyDrainedError, `Error: ${legacyDrainedError}`].includes(result.content[0].text)))
  if (!resultEvent || ![hash([{type:'text',text:legacyDrainedError}]), hash([{type:'text',text:`Error: ${legacyDrainedError}`}])].includes(operation.result.resultDigest)) return null
  const observations = []
  for (const candidate of executions) {
    if (candidate.taskId !== operation.taskId || !candidate.drained || candidate.recovering || live(candidate.sessionId)
      || candidate.definition?.recoveryReadOnly !== true || candidate.input?.readbackOperationId !== operation.operationId
      || candidate.status !== 'succeeded' || Date.parse(candidate.updatedAt) < Date.parse(operation.updatedAt)) continue
    const log = candidate.sessionId === execution.sessionId ? saved : await inspectSession(ctx.sessionPersistence, candidate.sessionId)
    const current = { ...candidate, kind: 'task-execution' }
    if (!identity(log.events, current)) continue
    const readInput = inputFor(log.events, current)
    if (!readInput || candidate.sessionId === execution.sessionId && readInput.seq <= resultEvent.seq) continue
    for (const read of log.events.filter(event => event.seq > readInput.seq && event.type === 'tool/call' && ['read','read_image','glob','grep','ls'].includes(event.data.name))) {
      const observed = log.events.find(event => event.seq > read.seq && results(event).some(result => result.toolCallId === read.data.callId && result.isError === false))
      if (observed) observations.push({ executionId: candidate.executionId, sessionId: candidate.sessionId,
        inputVersion: candidate.inputVersion, callId: read.data.callId, toolName: read.data.name, callDigest: hash(read.data), resultDigest: hash(observed.data), sequence: observed.seq })
    }
  }
  if (!observations.length) return null
  return { kind: 'legacy-host-drained-partial', operationId: operation.operationId, operationDigest: hash(operation),
    taskId: operation.taskId, executionId: execution.executionId, sessionId: execution.sessionId, callId,
    argumentsDigest: operation.definition.argumentsDigest, resultDigest: operation.result.resultDigest,
    originalResultSequence: resultEvent.seq, observations, partialEffectsPossible: true,
    conclusion: 'The original Host stopped and drained this command. Partial effects remain possible; readback does not prove command success. Do not automatically replay it.' }
}


/** 读取当前输入对应的真实执行日志；摘录供统筹判断方向，不把活跃或沉默当作进展结论。 */
export async function readExecutionProgress({ ctx, execution }) {
  const reject = code => { throw Object.assign(new Error(code), { code }) }
  if (!execution?.sessionId || !execution.taskId || !execution.executionId || !Number.isSafeInteger(execution.inputVersion)
    || !Number.isSafeInteger(execution.leaseEpoch) || !execution.inputDigest) reject('EXECUTION_PROGRESS_BINDING_INVALID')
  const binding = { kind: 'task-execution', taskId: execution.taskId, executionId: execution.executionId,
    sessionId: execution.sessionId, inputVersion: execution.inputVersion, leaseEpoch: execution.leaseEpoch, inputDigest: execution.inputDigest }
  let saved
  try { saved = await inspectSession(ctx.sessionPersistence, execution.sessionId) }
  catch (cause) { throw Object.assign(new Error('EXECUTION_PROGRESS_LOG_UNREADABLE'), { code: 'EXECUTION_PROGRESS_LOG_UNREADABLE', cause }) }
  const { events } = saved
  if (saved.meta.id !== binding.sessionId || !identity(events, binding)) reject('EXECUTION_PROGRESS_IDENTITY_MISMATCH')
  const input = inputFor(events, binding)
  const latestInput = events.findLast(event => event.type === 'user/message' && event.data.source?.executionSession)
  if (!input || input !== latestInput) reject('EXECUTION_PROGRESS_INPUT_MISMATCH')
  const currentEvents = events.filter(event => event.seq >= input.seq)
  const lastSequence = currentEvents.reduce((sequence, event) => Math.max(sequence, event.seq), -1)
  const previousSequence = execution.progressReview?.lastSequence ?? -1
  const newEvents = currentEvents.filter(event => event.seq > previousSequence)
  const meaningful = new Set(['assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end', 'agent/error', 'session/end-seed'])
  const excerpt = event => {
    const raw = JSON.stringify(event.data ?? null), safe = JSON.stringify(safeNotificationDetail(event.data))
    return { sequence: event.seq, type: event.type, time: event.time ?? null, digest: hash(event.data),
      preview: safe.slice(0, 640), truncated: safe.length > 640 || raw.length > 640 }
  }
  const completedCalls = new Set(currentEvents.flatMap(event => results(event).map(result => result.toolCallId)))
  const pendingCalls = currentEvents.filter(event => event.type === 'tool/call' && !completedCalls.has(event.data.callId))
  const activityTime = currentEvents.findLast(event => event.time !== undefined)?.time
  const activityTimestamp = typeof activityTime === 'number' ? activityTime : typeof activityTime === 'string' ? Date.parse(activityTime) : NaN
  const lastActivityAt = Number.isFinite(activityTimestamp) && Number.isFinite(new Date(activityTimestamp).getTime()) ? new Date(activityTimestamp).toISOString() : null
  return { ...binding, previousSequence, lastSequence, newEventCount: newEvents.length, changed: newEvents.length > 0, hasNewEvents: newEvents.length > 0,
    lastActivityAt,
    excerpts: currentEvents.filter(event => meaningful.has(event.type)).slice(-8).map(excerpt),
    pendingToolCallCount: pendingCalls.length, pendingToolCalls: pendingCalls.slice(-8).map(event => ({ callId: event.data.callId, toolName: event.data.name, sequence: event.seq, time: event.time ?? null, digest: hash(event.data) })),
    pendingToolCallsTruncated: pendingCalls.length > 8,
    limitations: ['摘录来自当前输入的持久日志；无新日志不证明停止，有新事件不证明业务推进。请结合实际内容判断进度、错误和方向；未结束调用不证明进程仍运行。较旧未结束调用仅给出日志引用，未摘录部分需按原日志进一步读取。'] }
}
