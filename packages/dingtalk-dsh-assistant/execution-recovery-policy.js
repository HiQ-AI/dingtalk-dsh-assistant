// Host服务与控制事务共用分类；未列入暂态白名单的错误不能自动重领。
export const engineeringPatchRepairReasons = Object.freeze(['ENGINEERING_PATCH_AMBIGUOUS', 'ENGINEERING_PATCH_CONFLICT', 'ENGINEERING_PATCH_BASE_CONFLICT'])
export const transientRecoveryReasons = Object.freeze(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'PLATFORM_REQUEST_FAILED',
  'PLATFORM_HTTP_429', 'PLATFORM_HTTP_502', 'PLATFORM_HTTP_503', 'PLATFORM_HTTP_504', 'ENGINEERING_REMOTE_READ_TRANSIENT', 'EXECUTION_PROVIDER_TRANSIENT', 'GIT_CONNECTION_FAILED', 'PR_CONNECTION_FAILED', 'ENGINEERING_PR_UNCONFIRMED', 'controller-restarted'])
// 探测间隔退避到一分钟；provider暂态由持久控制账限制三次，其余次数只作观察，指数不会溢出。
export const recoveryRetryDelayMs = attempt => Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)))
export const correctableOwnerReasons = Object.freeze(['TASK_OWNER_NO_DECISION', 'TASK_OWNER_ADVANCE_CONFLICT',
  'TASK_OWNER_DECISION_INVALID', 'TASK_OWNER_REPAIR_BINDING_INVALID', 'TASK_OWNER_COMPLETION_UNVERIFIED',
  'TASK_OWNER_STAGE_NOT_AUTHORIZED', 'TASK_OWNER_EVENTS_UNREAD', 'TASK_OWNER_RECOVERY_AVAILABLE',
  'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD', 'TASK_OWNER_REPEATED_INVALID_DECISION'])
export const ownerRetryableReason = code => transientRecoveryReasons.includes(code)
  || correctableOwnerReasons.includes(code) || ['TASK_OWNER_SESSION_MISSING', 'TASK_OWNER_TIMEOUT'].includes(code)

// 诊断标明具体处理方，不转移任务 Owner 的整体责任，也不授予自动修复能力；续行仍由控制账准入。
export const engineeringProposalCorrectionReasons = Object.freeze(['ENGINEERING_NO_EFFECT_MODIFICATION', 'ENGINEERING_CHANGE_DISPOSITION_INVALID',
  'ENGINEERING_NO_CHANGE_EVIDENCE_REQUIRED', 'ENGINEERING_PROPOSAL_DOCUMENT_INVALID'])
// 诊断与控制账复用同一份既有准入列表；输出错误必须同时满足输出阶段。
export const agentContinuationReasons = Object.freeze(['AGENT_WORK_BLOCKED', 'NO_NODE_SUBMISSION', 'execution_no_submission',
  'EXECUTION_TURN_INTERRUPTED', 'execution_step_budget_exhausted', 'execution_timeout',
  'QUERY_ARGUMENT_INVALID', 'QUERY_NOT_FOUND', 'QUERY_LIMIT_INVALID', 'QUERY_TIMEOUT', 'QUERY_CAPACITY', 'ENGINEERING_READ_PATH_INVALID'])
export const agentCorrectableOutputReasons = Object.freeze(['NODE_SCHEMA_INVALID', 'INVALID_JSON_VALUE', 'INVALID_JSON_OBJECT',
  'AGENT_WORK_RESULT_INVALID', 'AGENT_WORK_EVIDENCE_INVALID', 'AGENT_WORK_COVERAGE_INCOMPLETE', 'QUERY_EVIDENCE_INVALID', 'GROUP_REPLY_INTERNAL_DETAILS'])
const failurePolicies = Object.freeze({
  'correctable-output': ['node-executor', 'correct-output-and-continue'],
  'business-validation': ['node-executor', 'inspect-diagnosis-and-correct-within-capability'],
  'task-blocked': ['node-executor', 'inspect-blocker-and-report-resume-condition'],
  'missing-input': ['requester', 'supply-required-input'],
  'missing-environment': ['operator', 'restore-required-environment'],
  'external-uncertain': ['effect-reconciler', 'reconcile-before-replay'],
  'transient-execution': ['execution-controller', 'retry-with-persisted-backoff'],
  'authorization-assessment': ['node-executor', 'assess-authorization-and-use-visible-step'],
  'authorization-waiting': ['authorization-session', 'await-real-authorization-result'],
  'implementation-error': ['maintainer', 'inspect-and-fix-implementation'],
})
const classifiedReasons = new Map([
  ['AUTHORIZATION_ASSESSMENT_REQUIRED', 'authorization-assessment'],
  ['effect_approval_required', 'authorization-waiting'],
  ...engineeringProposalCorrectionReasons.map(code => [code, 'correctable-output']),
  ...['ENGINEERING_VERIFICATION_FAILED', 'ENGINEERING_ACCEPTANCE_FAILED', 'LOCAL_ACCEPTANCE_FAILED',
    'RELEASE_PIPELINE_FAILED', ...engineeringPatchRepairReasons].map(code => [code, 'business-validation']),
  ['AGENT_WORK_NEEDS_INPUT', 'missing-input'],
  ...agentContinuationReasons.map(code => [code, 'task-blocked']),
  ['LOCAL_ACCEPTANCE_CAPABILITY_MISSING', 'task-blocked'],
  ['ENGINEERING_UAT_ENVIRONMENT_REQUIRED', 'missing-environment'],
  ['ENGINEERING_SOURCE_REPOSITORY_UNAVAILABLE', 'missing-environment'],
  ['SESSION_ADAPTER_UNAVAILABLE', 'missing-environment'],
  ['DELIVERY_RECONCILIATION_REQUIRED', 'external-uncertain'],
  ...transientRecoveryReasons.map(code => [code, 'transient-execution']),
])

export function classifyExecutionFailure({ code, phase = 'execution' }) {
  // Schema 不合法只在输出边界可归于结果修正；同一错误发生在输入映射时属于实现合同错误。
  const correctable = ['output-validation', 'output-admission'].includes(phase) && agentCorrectableOutputReasons.includes(code)
  const category = correctable
    ? 'correctable-output' : classifiedReasons.get(code) ?? 'implementation-error'
  const [responsibleParty, nextAction] = failurePolicies[category]
  return { category, responsibleParty, nextAction }
}
