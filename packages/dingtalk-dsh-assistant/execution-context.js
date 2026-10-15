// Shared by every Host injection path, including active blockers and read tools.
// The durable ledger retains complete inputs and historical results.
export function taskExecutionContext(execution) {
  const fields = ['executionId', 'sessionId', 'taskId', 'key', 'inputVersion', 'requirementRevision', 'controlRevision',
    'leaseEpoch', 'inputDigest', 'status', 'drained', 'recovering', 'cancelRequested', 'result', 'updatedAt', 'progressReview', 'stageProgress', 'providerRecovery']
  return { ...Object.fromEntries(fields.filter(key => Object.hasOwn(execution, key)).map(key => [key, execution[key]])),
    input: Object.fromEntries(['title', 'objective', 'recoveryReadOnly', 'readbackOperationId', 'skillNames']
      .filter(key => Object.hasOwn(execution.input ?? {}, key)).map(key => [key, execution.input[key]])) }
}
