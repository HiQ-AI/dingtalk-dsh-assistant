import { createHash } from 'node:crypto'
import { inspectSession } from './session-persistence.js'

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
