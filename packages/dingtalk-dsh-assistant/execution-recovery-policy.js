// Host服务与控制事务共用分类；未列入暂态白名单的错误不能自动重领。
export const engineeringPatchRepairReasons = Object.freeze(['ENGINEERING_PATCH_AMBIGUOUS', 'ENGINEERING_PATCH_CONFLICT', 'ENGINEERING_PATCH_BASE_CONFLICT'])
export const transientRecoveryReasons = Object.freeze(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'PLATFORM_REQUEST_FAILED',
  'PLATFORM_HTTP_429', 'PLATFORM_HTTP_502', 'PLATFORM_HTTP_503', 'PLATFORM_HTTP_504', 'ENGINEERING_REMOTE_READ_TRANSIENT', 'EXECUTION_PROVIDER_TRANSIENT', 'GIT_CONNECTION_FAILED', 'PR_CONNECTION_FAILED', 'controller-restarted'])
// 探测间隔退避到一分钟；provider暂态由持久控制账限制三次，其余次数只作观察，指数不会溢出。
export const recoveryRetryDelayMs = attempt => Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)))
export const correctableOwnerReasons = Object.freeze(['TASK_OWNER_NO_DECISION', 'TASK_OWNER_ADVANCE_CONFLICT',
  'TASK_OWNER_DECISION_INVALID', 'TASK_OWNER_REPAIR_BINDING_INVALID', 'TASK_OWNER_COMPLETION_UNVERIFIED',
  'TASK_OWNER_STAGE_NOT_AUTHORIZED', 'TASK_OWNER_EVENTS_UNREAD', 'TASK_OWNER_RECOVERY_AVAILABLE',
  'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD', 'TASK_OWNER_REPEATED_INVALID_DECISION'])
export const ownerRetryableReason = code => transientRecoveryReasons.includes(code)
  || correctableOwnerReasons.includes(code) || ['TASK_OWNER_SESSION_MISSING', 'TASK_OWNER_TIMEOUT'].includes(code)

// 诊断描述恢复责任；暂态重领由控制账、排空证明和持久退避共同决定。
const failurePolicies = Object.freeze({
  'correctable-output': ['node-executor', 'correct-output-and-continue'],
  'business-validation': ['task-owner', 'repair-artifact-and-revalidate'],
  'task-blocked': ['task-owner', 'inspect-blocker-and-replan'],
  'missing-input': ['requester', 'supply-required-input'],
  'missing-environment': ['operator', 'restore-required-environment'],
  'external-uncertain': ['effect-reconciler', 'reconcile-before-replay'],
  'transient-execution': ['execution-controller', 'retry-with-persisted-backoff'],
  'implementation-error': ['maintainer', 'inspect-and-fix-implementation'],
})
const classifiedReasons = new Map([
  ...['ENGINEERING_VERIFICATION_FAILED', 'ENGINEERING_ACCEPTANCE_FAILED', 'LOCAL_ACCEPTANCE_FAILED',
    'RELEASE_PIPELINE_FAILED', ...engineeringPatchRepairReasons].map(code => [code, 'business-validation']),
  ['AGENT_WORK_NEEDS_INPUT', 'missing-input'],
  ['AGENT_WORK_BLOCKED', 'task-blocked'],
  ['ENGINEERING_UAT_ENVIRONMENT_REQUIRED', 'missing-environment'],
  ['ENGINEERING_SOURCE_REPOSITORY_UNAVAILABLE', 'missing-environment'],
  ['SESSION_ADAPTER_UNAVAILABLE', 'missing-environment'],
  ['DELIVERY_RECONCILIATION_REQUIRED', 'external-uncertain'],
  ...transientRecoveryReasons.map(code => [code, 'transient-execution']),
])

export function classifyExecutionFailure({ code, phase = 'execution' }) {
  // Schema 不合法只在输出边界可归于结果修正；同一错误发生在输入映射时属于实现合同错误。
  const correctable = phase === 'output-validation' && ['NODE_SCHEMA_INVALID', 'INVALID_JSON_VALUE', 'INVALID_JSON_OBJECT'].includes(code)
    || ['output-validation', 'output-admission'].includes(phase) && code === 'AGENT_WORK_RESULT_INVALID'
  const category = correctable
    ? 'correctable-output' : classifiedReasons.get(code) ?? 'implementation-error'
  const [responsibleParty, nextAction] = failurePolicies[category]
  return { category, responsibleParty, nextAction }
}
