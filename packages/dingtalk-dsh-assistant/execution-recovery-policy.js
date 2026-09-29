// Host服务与控制事务共用分类；未列入暂态白名单的错误不能自动重领。
export const engineeringPatchRepairReasons = Object.freeze(['ENGINEERING_PATCH_AMBIGUOUS', 'ENGINEERING_PATCH_CONFLICT', 'ENGINEERING_PATCH_BASE_CONFLICT'])
export const transientRecoveryReasons = Object.freeze(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'PLATFORM_REQUEST_FAILED',
  'PLATFORM_HTTP_429', 'PLATFORM_HTTP_502', 'PLATFORM_HTTP_503', 'PLATFORM_HTTP_504', 'ENGINEERING_REMOTE_READ_TRANSIENT', 'controller-restarted'])
export const recoveryRetryLimit = 3
export const recoveryRetryDelayMs = attempt => 1000 * 2 ** (attempt - 1)

// 诊断只描述恢复责任，不授予重试权限；自动重领仍由控制账和既有预算决定。
const failurePolicies = Object.freeze({
  'correctable-output': ['node-executor', 'correct-output-within-budget'],
  'business-validation': ['task-owner', 'repair-artifact-and-revalidate'],
  'task-blocked': ['task-owner', 'inspect-blocker-and-replan'],
  'missing-input': ['requester', 'supply-required-input'],
  'missing-environment': ['operator', 'restore-required-environment'],
  'external-uncertain': ['effect-reconciler', 'reconcile-before-replay'],
  'transient-execution': ['execution-controller', 'retry-under-existing-policy'],
  'implementation-error': ['maintainer', 'inspect-and-fix-implementation'],
})
const classifiedReasons = new Map([
  ...['ENGINEERING_VERIFICATION_FAILED', 'ENGINEERING_ACCEPTANCE_FAILED', 'LOCAL_ACCEPTANCE_FAILED',
    'RELEASE_PIPELINE_FAILED', ...engineeringPatchRepairReasons].map(code => [code, 'business-validation']),
  ['AGENT_WORK_NEEDS_INPUT', 'missing-input'],
  ['AGENT_WORK_BLOCKED', 'task-blocked'],
  ['ENGINEERING_UAT_ENVIRONMENT_REQUIRED', 'missing-environment'],
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
