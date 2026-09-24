import { createHash } from 'node:crypto'
import { executionDigest, executionError } from './execution-artifacts.js'

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const same = (a, b) => executionDigest(a) === executionDigest(b)
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0
const exactTarget = (a, b) => a?.instance === b?.instance && a?.database === b?.database
  && a?.environment === b?.environment
const canonicalTarget = target => /^instances\/[A-Za-z0-9._-]+$/.test(target?.instance ?? '')
  && new RegExp(`^${target.instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/databases\/[A-Za-z0-9._-]+$`).test(target?.database ?? '')
const required = (condition, code) => { if (!condition) throw executionError(code) }

/**
 * Bytebase 的受限平台端口。api 由运行时提供已认证的实现；本模块只接受显式列入配置的
 * 项目、数据库和隔离副本，绝不将宽泛的 Bytebase MCP 工具直接暴露给工作流。
 *
 * api: getDatabase, validateSql, rehearseIsolated, createIssueBundle,
 * getIssueBundle, getApproval, runTask, getTaskExecution, queryVerification,
 * findIssueByOperationKey。所有方法必须返回 Bytebase 的独立读回结果。
 */
export function createBytebaseDataChangePlatform({ config, api }) {
  const targets = config?.targets
  const names = ['getDatabase', 'validateSql', 'rehearseIsolated', 'createIssueBundle',
    'getIssueBundle', 'getApproval', 'runTask', 'getTaskExecution', 'queryVerification',
    'findIssueByOperationKey']
  required(nonempty(config?.adapterId) && nonempty(config?.adapterVersion)
    && Array.isArray(targets) && targets.length > 0 && names.every(name => typeof api?.[name] === 'function'),
  'BYTEBASE_PLATFORM_NOT_CONFIGURED')
  const seen = new Set()
  for (const entry of targets) {
    const { project, target, isolation } = entry
    required(/^projects\/[A-Za-z0-9._-]+$/.test(project ?? '') && canonicalTarget(target)
      && ['uat', 'production'].includes(target?.environment)
      && nonempty(isolation?.proofRef) && canonicalTarget(isolation?.target)
      && isolation?.target?.environment === 'isolated'
      && target.instance !== isolation.target.instance
      && target.database !== isolation.target.database, 'BYTEBASE_TARGET_CONFIG_INVALID')
    const key = executionDigest(target)
    required(!seen.has(key), 'BYTEBASE_TARGET_CONFIG_DUPLICATE')
    seen.add(key)
  }
  const rulesDigest = executionDigest({ adapterId: config.adapterId, adapterVersion: config.adapterVersion,
    targets: targets.map(({ project, target, isolation }) => ({ project, target, isolation })) })
  const entryFor = target => {
    const entry = targets.find(item => exactTarget(item.target, target))
    required(entry && same(entry.target, target), 'BYTEBASE_TARGET_NOT_ALLOWED')
    return entry
  }
  const assertDatabase = (db, entry) => required(db?.project === entry.project
    && exactTarget(db, entry.target), 'BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED')
  const issueBundle = (bundle, { project, target, sqlSha256, packageDigest, operationKey }) => {
    const { issue, sheet, plan, task } = bundle ?? {}
    required(nonempty(issue?.id) && nonempty(sheet?.id) && nonempty(plan?.id) && nonempty(task?.id)
      && issue.project === project && issue.planId === plan.id && issue.taskId === task.id
      && issue.operationKey === operationKey && issue.packageDigest === packageDigest
      && sheet.project === project && sheet.sha256 === sqlSha256 && exactTarget(sheet.target, target)
      && plan.project === project && plan.sheetId === sheet.id && task.planId === plan.id
      && task.status === 'NOT_STARTED', 'BYTEBASE_ISSUE_IDENTITY_UNCONFIRMED')
    return { issue: { id: issue.id, planId: plan.id, taskId: task.id },
      sheet: { id: sheet.id, sha256: sheet.sha256, target: sheet.target },
      plan: { id: plan.id, sheetId: sheet.id }, task: { id: task.id, planId: plan.id, status: task.status } }
  }
  const issueKey = request => executionDigest({ stage: 'create-issue', runId: request.runId,
    generation: request.generation, requirementDigest: request.requirementDigest,
    packageDigest: request.packageDigest, target: request.target })
  const executeKey = request => executionDigest({ stage: 'execute-task',
    packageDigest: request.packageDigest, taskId: request.taskId,
    approvalRequestId: request.approvalRequestId })
  const checkRequest = request => {
    required(request?.workflowKind === 'data-change' && ['create-issue', 'execute-task'].includes(request.stage),
      'BYTEBASE_OPERATION_INVALID')
    const entry = entryFor(request.target)
    required(request.intent?.project === entry.project && request.intent.packageDigest === request.packageDigest
      && request.intent.applySqlSha256 === request.applySqlSha256
      && exactTarget(request.intent.target, entry.target)
      && request.intent.operationKey === (request.stage === 'create-issue' ? issueKey(request) : executeKey(request)),
    'BYTEBASE_OPERATION_IDENTITY_CHANGED')
    return entry
  }
  const adapter = {
    id: config.adapterId, version: config.adapterVersion, rulesDigest,
    async validate({ target, baseline, applySql, applySqlSha256, packageDigest, signal }) {
      const entry = entryFor(target)
      required(sha(applySql) === applySqlSha256 && nonempty(baseline?.snapshotId)
        && /^[a-f0-9]{64}$/.test(baseline?.sha256 ?? ''), 'BYTEBASE_PACKAGE_INVALID')
      assertDatabase(await api.getDatabase({ project: entry.project, target, signal }), entry)
      const result = await api.validateSql({ project: entry.project, target, sql: applySql,
        sqlSha256: applySqlSha256, baseline, signal })
      required(result?.passed === true && result.sqlSha256 === applySqlSha256
        && exactTarget(result.target, target) && nonempty(result.reviewId), 'BYTEBASE_SQL_REVIEW_UNCONFIRMED')
      return { passed: true, packageDigest, receiptId: result.reviewId }
    },
    async rehearse({ package: pkg, signal }) {
      const entry = entryFor(pkg.target)
      required(pkg.validation?.packageDigest === executionDigest((({ validation, ...body }) => body)(pkg))
        && sha(pkg.applySql) === pkg.applySqlSha256, 'BYTEBASE_PACKAGE_IDENTITY_CHANGED')
      const result = await api.rehearseIsolated({ project: entry.project, target: entry.isolation.target,
        isolationProofRef: entry.isolation.proofRef, baseline: pkg.baseline,
        applySql: pkg.applySql, verificationSql: pkg.verificationSql,
        rollbackSql: pkg.rollbackSql, packageDigest: pkg.validation.packageDigest, signal })
      required(result?.passed === true && result.isolated === true && nonempty(result.receiptId)
        && nonempty(result.observedChange) && result.packageDigest === pkg.validation.packageDigest
        && result.isolationProofRef === entry.isolation.proofRef
        && result.baselineSha256 === pkg.baseline.sha256
        && exactTarget(result.target, entry.isolation.target), 'BYTEBASE_REHEARSAL_UNCONFIRMED')
      return { passed: true, isolated: true, receiptId: result.receiptId,
        packageDigest: result.packageDigest, observedChange: result.observedChange }
    },
    async prepareIssue({ prepared, runId, generation, requirementDigest }) {
      const pkg = prepared.package, entry = entryFor(pkg.target)
      required(prepared.rehearsal?.passed === true && prepared.rehearsal?.isolated === true
        && prepared.rehearsal.packageDigest === pkg.validation.packageDigest, 'BYTEBASE_REHEARSAL_REQUIRED')
      const request = { runId, generation, requirementDigest, packageDigest: pkg.validation.packageDigest,
        target: pkg.target }
      return { project: entry.project, target: pkg.target, operationKey: issueKey(request),
        packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
        applySql: pkg.applySql, expectedChange: pkg.expectedChange }
    },
    async readback({ stage, request, receipt, issue, sheet, plan, task, prepared, signal }) {
      const entry = checkRequest(request)
      if (stage === 'create-issue') {
        const id = receipt?.result?.issueId
        required(nonempty(id), 'BYTEBASE_ISSUE_RECEIPT_UNKNOWN')
        return issueBundle(await api.getIssueBundle({ project: entry.project, issueId: id, signal }),
          { project: entry.project, target: request.target, sqlSha256: request.applySqlSha256,
            packageDigest: request.packageDigest, operationKey: request.intent.operationKey })
      }
      required(stage === 'execute-task' && receipt?.result?.taskId === task?.id,
        'BYTEBASE_TASK_RECEIPT_UNKNOWN')
      const result = await api.getTaskExecution({ project: entry.project, issueId: issue?.id,
        taskId: task.id, signal })
      required(result?.task?.id === task.id && result.task.status === 'DONE'
        && result.taskRun?.taskId === task.id && result.taskRun?.status === 'DONE'
        && nonempty(result.taskRun?.id), 'BYTEBASE_TASK_RUN_UNCONFIRMED')
      const verification = await api.queryVerification({ project: entry.project, target: request.target,
        sql: prepared.package.verificationSql, taskRunId: result.taskRun.id,
        expectedChange: prepared.package.expectedChange, signal })
      required(verification?.passed === true && nonempty(verification.readbackId)
        && nonempty(verification.observedChange) && exactTarget(verification.target, request.target)
        && verification.packageDigest === request.packageDigest,
      'BYTEBASE_PRODUCTION_VERIFICATION_UNCONFIRMED')
      return { task: result.task, taskRun: result.taskRun,
        production: { passed: true, target: request.target, packageDigest: request.packageDigest,
          readbackId: verification.readbackId, observedChange: verification.observedChange } }
    },
    async inspect({ stage, issue, sheet, plan, task, prepared, signal }) {
      const pkg = prepared.package, entry = entryFor(pkg.target)
      if (stage === 'approval') {
        const approval = await api.getApproval({ project: entry.project, issueId: issue.id, signal })
        if (approval?.decision === 'pending') return approval
        required(approval?.decision === 'approved' && approval.taskId === task.id
          && approval.sheetSha256 === sheet.sha256
          && approval.packageDigest === pkg.validation.packageDigest
          && nonempty(approval.requestId) && nonempty(approval.decidedBy),
        'BYTEBASE_APPROVAL_UNCONFIRMED')
        return approval
      }
      required(stage === 'pre-execution', 'BYTEBASE_INSPECTION_INVALID')
      const bundle = await api.getIssueBundle({ project: entry.project, issueId: issue.id, signal })
      required(bundle?.issue?.id === issue.id && bundle?.issue?.packageDigest === pkg.validation.packageDigest
        && bundle?.sheet?.sha256 === sheet.sha256 && exactTarget(bundle.sheet.target, pkg.target)
        && bundle?.plan?.id === plan.id && bundle?.plan?.sheetId === sheet.id
        && bundle?.task?.id === task.id && bundle?.task?.planId === plan.id
        && bundle?.task?.status === 'NOT_STARTED', 'BYTEBASE_PREFLIGHT_CHANGED')
      return { sheet, plan, task }
    },
    async prepareExecute({ identity, issue, approval }) {
      const entry = entryFor(identity.target)
      required(approval?.decision === 'approved' && approval.requestId === identity.approvalRequestId,
        'BYTEBASE_APPROVAL_UNCONFIRMED')
      return { project: entry.project, target: identity.target, issueId: issue.id,
        taskId: identity.taskId, approvalRequestId: identity.approvalRequestId,
        packageDigest: identity.packageDigest, applySqlSha256: identity.applySqlSha256,
        operationKey: executeKey({ packageDigest: identity.packageDigest, taskId: identity.taskId,
          approvalRequestId: identity.approvalRequestId }) }
    },
  }
  const externalAdapter = {
    async execute(request) {
      const entry = checkRequest(request)
      if (request.stage === 'create-issue') {
        required(sha(request.intent.applySql) === request.applySqlSha256,
          'BYTEBASE_SQL_IDENTITY_CHANGED')
        const result = await api.createIssueBundle({ ...request.intent, signal: undefined })
        const view = issueBundle(result, { project: entry.project, target: request.target,
          sqlSha256: request.applySqlSha256, packageDigest: request.packageDigest,
          operationKey: request.intent.operationKey })
        return { status: 'succeeded', result: { issueId: view.issue.id } }
      }
      const bundle = await api.getIssueBundle({ project: entry.project, issueId: request.intent.issueId })
      required(bundle?.task?.id === request.taskId && bundle.task.status === 'NOT_STARTED'
        && bundle?.sheet?.sha256 === request.applySqlSha256
        && bundle?.issue?.packageDigest === request.packageDigest, 'BYTEBASE_PREFLIGHT_CHANGED')
      const approval = await api.getApproval({ project: entry.project, issueId: request.intent.issueId })
      required(approval?.decision === 'approved' && approval.requestId === request.approvalRequestId
        && approval.taskId === request.taskId && approval.sheetSha256 === request.applySqlSha256
        && approval.packageDigest === request.packageDigest, 'BYTEBASE_APPROVAL_CHANGED')
      const result = await api.runTask({ project: entry.project, issueId: request.intent.issueId,
        taskId: request.taskId, operationKey: request.intent.operationKey })
      required(result?.taskId === request.taskId, 'BYTEBASE_RUN_TASK_RECEIPT_UNKNOWN')
      return { status: 'succeeded', result: { taskId: request.taskId } }
    },
    async reconcile(request) {
      const entry = checkRequest(request)
      if (request.stage === 'create-issue') {
        const found = await api.findIssueByOperationKey({ project: entry.project,
          operationKey: request.intent.operationKey })
        if (!found) return { status: 'unknown', reason: 'issue_not_observed' }
        const view = issueBundle(found, { project: entry.project, target: request.target,
          sqlSha256: request.applySqlSha256, packageDigest: request.packageDigest,
          operationKey: request.intent.operationKey })
        return { status: 'succeeded', result: { issueId: view.issue.id } }
      }
      const result = await api.getTaskExecution({ project: entry.project,
        issueId: request.intent.issueId, taskId: request.taskId })
      if (result?.taskRun?.taskId !== request.taskId) return { status: 'unknown', reason: 'run_not_observed' }
      return { status: 'succeeded', result: { taskId: request.taskId } }
    },
  }
  return { workflowAdapter: adapter, externalAdapter }
}
