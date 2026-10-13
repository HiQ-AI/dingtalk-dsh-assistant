import { executionError, executionDigest } from './execution-artifacts.js'

// Host supplied scope, never a model supplied repository or executable.
export function validateEngineeringPlanScope(plan, scope) {
  const fail = message => { throw executionError('ENGINEERING_TECHNICAL_PLAN_INVALID', message) }
  if (!scope || !scope.repositoryId || !scope.objective?.trim()) fail('当前阶段仓库和目标缺失')
  for (const path of plan.scopePaths) {
    if (!path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) fail('方案路径必须为当前仓库相对路径')
    if (scope.editablePaths.length ? !scope.editablePaths.includes(path)
      : !scope.allowedPrefixes.some(prefix => path.startsWith(prefix))) fail(`方案路径超出阶段范围: ${path}`)
  }
  if (!scope.criteria.length || scope.criteria.some(criterion => !plan.criteria.some(item => item.criterion === criterion)))
    fail('方案必须逐项保留当前阶段验收原文，不可用整份PRD替代阶段合同')
  if (plan.criteria.some(item => !scope.criteria.includes(item.criterion))) fail('方案包含其他阶段验收项')
  return plan
}

export function validateLocalAcceptanceSubmission(plan, context) {
  const cases = plan?.cases
  if (!context?.scenarios?.length) throw executionError('LOCAL_ACCEPTANCE_CAPABILITY_MISSING', '当前阶段没有可执行验收场景；需要Host补齐能力，不能提交空计划')
  const stage=context.stageContract, applicability=context.acceptanceApplicability
  const expectedScope=stage&&{taskId:stage.taskId,stageId:stage.stageId,repositoryId:stage.repositoryId,requestDigest:executionDigest({request:stage.objective,acceptanceCriteria:stage.criteria})}
  if(!stage || !applicability?.scope || executionDigest(applicability.scope)!==executionDigest(expectedScope)
    || !Array.isArray(applicability.scenarios) || context.criteria.some(criterion=>!applicability.scenarios.some(policy=>policy.criteria?.includes(criterion.description)&&context.scenarios.some(scenario=>scenario.id===policy.scenarioId))))
    throw executionError('LOCAL_ACCEPTANCE_CAPABILITY_MISSING','当前任务/阶段缺少摘要绑定且覆盖该业务验收原文的场景配置，不能按ID存在冒充适用能力')
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(item => item.criterionId)).size !== cases.length
    || context.criteria.some(criterion => !cases.some(item => item.criterionId === criterion.id))
    || cases.some(item => !context.criteria.some(criterion => criterion.id === item.criterionId)
      || !context.scenarios.some(scenario => scenario.id === item.scenarioId)
      || !applicability.scenarios.some(policy=>policy.scenarioId===item.scenarioId&&policy.criteria?.includes(context.criteria.find(criterion=>criterion.id===item.criterionId)?.description))
      || !item.expected?.trim() || !item.steps?.length || item.steps.some(step => !step.trim() || step.length > 2000)))
    throw executionError('LOCAL_ACCEPTANCE_PLAN_INVALID', '验收计划必须非空，逐项覆盖当前criteria，使用已配置场景并填写操作与预期；缺能力不能编造场景')
  return plan
}

// Current planning contract: implementation and verification own quality checks.
export function validateEngineeringApproach(plan, scope) {
  if (typeof plan?.document?.markdown !== 'string' || !plan.document.markdown.trim())
    throw executionError('ENGINEERING_TECHNICAL_PLAN_INVALID', 'A technical approach is required')
  if (plan.scopePaths !== undefined) {
    if (!Array.isArray(plan.scopePaths)) throw executionError('ENGINEERING_TECHNICAL_PLAN_INVALID')
    for (const path of plan.scopePaths) {
      if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
        throw executionError('ENGINEERING_TECHNICAL_PLAN_INVALID', 'Paths must remain inside the repository')
      if (scope?.editablePaths?.length ? !scope.editablePaths.includes(path)
        : scope?.allowedPrefixes?.length && !scope.allowedPrefixes.some(prefix => path.startsWith(prefix)))
        throw executionError('ENGINEERING_TECHNICAL_PLAN_INVALID', 'Path is outside the approved editing scope')
    }
  }
  return plan
}
