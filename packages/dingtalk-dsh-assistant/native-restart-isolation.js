import { createHash } from 'node:crypto'

export const isolationDigest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
export const originalOperation = operation => {
  const { recoverySettlement: _settlement, ...original } = operation
  return original
}
export const isolationBinding = (operation, callId) => ({ operationId: operation.operationId, operationDigest: isolationDigest(originalOperation(operation)),
  taskId: operation.taskId, executionId: operation.executionId, sessionId: operation.dispatchBinding?.sessionId,
  jobId: operation.job?.jobId, startedAt: operation.job?.startedAt, callId, argumentsDigest: operation.definition?.argumentsDigest })

// Only the trusted Host capability owns this durable fence, never a shell/model report.
export function validIsolationReceipt(receipt, binding) {
  const scoped = receipt?.kind === 'native-source-scope-isolation' && receipt.issuer === 'native-windows-scope-evidence-v1'
    && receipt.sourceScopeQuiescent === true && receipt.durableSourceExclusion === true && receipt.activeSourceCount === 0
    && receipt.provenance?.historicalJobObjectIdentity === 'unavailable' && receipt.provenance?.isolationBasis === 'bounded-producer-exclusion'
    && receipt.provenanceDigest === isolationDigest(receipt.provenance)
  const managed = receipt?.kind === 'native-job-durable-isolation' && receipt.durableFence === true && receipt.managedRangeEmpty === true
    && receipt.activeWriterCount === 0
  return (scoped || managed) && typeof receipt.receiptId === 'string' && !!receipt.receiptId
    && typeof receipt.issuer === 'string' && !!receipt.issuer && typeof receipt.fenceRef === 'string' && !!receipt.fenceRef
    && typeof receipt.hostExitRef === 'string' && !!receipt.hostExitRef
    && receipt.originalHostExited === true && receipt.externalWritersExcluded === true
    && Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) >= binding.startedAt
    && isolationDigest(receipt.binding) === isolationDigest(binding)
}

export function hasRestartIsolation(operation) {
  const audit = operation?.recoverySettlement, proof = audit?.proof
  return operation?.state === 'unknown' && operation.recoveryReason === 'host_restart'
    && audit?.kind === 'host-restart-isolated' && audit.exitStatus === 'unknown' && audit.noReplay === true
    && audit.partialEffectsPossible === true && typeof audit.operatorSourceId === 'string' && !!audit.operatorSourceId
    && typeof audit.humanRequestId === 'string' && !!audit.humanRequestId
    && proof?.kind === 'native-host-restart-isolated' && proof.operationDigest === isolationDigest(originalOperation(operation))
    && proof.operationId === operation.operationId && proof.taskId === operation.taskId && proof.executionId === operation.executionId
    && proof.sessionId === operation.dispatchBinding?.sessionId && typeof proof.callId === 'string'
    && proof.argumentsDigest === operation.definition?.argumentsDigest && Array.isArray(proof.observations) && proof.observations.length > 0
    && validIsolationReceipt(proof.isolation, isolationBinding(operation, proof.callId))
}

export const operationBlocksRecovery = operation => !['succeeded', 'failed', 'cancelled'].includes(operation.state) && !hasRestartIsolation(operation)

export async function readAuditedRestartDrain({ ctx, query, binding, calls }) {
  const operations = await query('operation.list', { taskId: binding.taskId }), refs = []
  const jobs = ctx.get?.('jobs')
  if (!jobs?.list || jobs.list(binding.sessionId).some(job => ['running', 'stopping'].includes(job.status))) return null
  for (const call of calls) {
    const operation = operations.find(item => item.executionId === binding.executionId && item.dispatchBinding?.sessionId === binding.sessionId
      && item.dispatchBinding.inputVersion === binding.inputVersion && item.dispatchBinding.inputDigest === binding.inputDigest
      && item.dispatchBinding.leaseEpoch === binding.leaseEpoch && hasRestartIsolation(item)
      && item.recoverySettlement.proof.callId === call.data.callId && item.recoverySettlement.proof.callSequence === call.seq)
    let args
    try { args = JSON.parse(call.data.arguments) } catch { return null }
    if (!operation || operation.definition.toolName !== call.data.name || operation.definition.argumentsDigest !== isolationDigest(args)
      || !await verifyRestartIsolation(ctx, operation)) return null
    refs.push({ operationId: operation.operationId, auditDigest: isolationDigest(operation.recoverySettlement) })
  }
  return refs
}

export async function verifyRestartIsolation(ctx, operation) {
  if (!hasRestartIsolation(operation)) return false
  const receipt = operation.recoverySettlement.proof.isolation
  if (receipt.issuer === 'native-windows-scope-evidence-v1') {
    const jobs = ctx.get?.('jobs')
    return !!jobs?.list && !jobs.list(operation.dispatchBinding.sessionId).some(job => (job.id ?? job.jobId) === operation.job.jobId && ['running', 'stopping'].includes(job.status))
      && receipt.provenance?.kind === 'native-windows-restart-probe' && receipt.provenanceDigest === isolationDigest(receipt.provenance)
  }
  const authority = ctx.get?.('nativeJobRecovery')
  if (typeof authority?.verifyIsolation !== 'function') return false
  return await authority.verifyIsolation({ receipt: operation.recoverySettlement.proof.isolation,
    binding: isolationBinding(operation, operation.recoverySettlement.proof.callId) }) === true
}
