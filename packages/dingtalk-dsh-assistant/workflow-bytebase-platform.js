import { createHash } from 'node:crypto'
import { isSimpleNullableColumnSql, simpleNullableColumnDefinition } from './workflow-data-change.js'
import { executionDigest, executionError } from './execution-artifacts.js'

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const same = (a, b) => executionDigest(a) === executionDigest(b)
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0
const exactTarget = (a, b) => a?.instance === b?.instance && a?.database === b?.database
  && a?.environment === b?.environment
const canonicalTarget = target => /^instances\/[A-Za-z0-9._-]+$/.test(target?.instance ?? '')
  && new RegExp(`^${target.instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/databases\/[A-Za-z0-9._-]+$`).test(target?.database ?? '')
const canonicalUatTarget = target => /^postgresql\/[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/.test(target?.instance ?? '')
  && /^[A-Za-z0-9_]+$/.test(target?.database ?? '') && target?.environment === 'uat'
const required = (condition, code) => { if (!condition) throw executionError(code) }

/**
 * Bytebase 的受限平台端口。api 由运行时提供已认证的实现；本模块只接受显式列入配置的
 * 生产数据库；复杂 SQL 的 UAT 目标显式配置，演练作为独立外部效果进入 Controller 效果账。
 * 简单加列只核对生产目录并送审；真人批准由 Bytebase 原生审批独立回读。
 *
 * api 仅用于 Bytebase 生产工单与执行；productionApi 通过天翼云只读副本回读生产结构；
 * uatApi 由受信 PostgreSQL 客户端提供本地 SQL 审查与事务演练。
 * api: getDatabase, createIssueBundle,
 * getIssueBundle, runTask, getTaskExecution, queryVerification,
 * findIssueByOperationKey、getIssueApproval。所有方法必须返回 Bytebase 的独立读回结果。
 */
export function createBytebaseDataChangePlatform({ config, api, productionApi, uatApi, approvalApi, approvalSource = 'bytebase' }) {
  const nativeApproval = approvalSource === 'bytebase' && typeof api?.getIssueApproval === 'function'
  const pluginApproval = approvalSource === 'assistant'
  const modern = nativeApproval || pluginApproval
  const targets = config?.targets
  const names = ['getDatabase', 'createIssueBundle', 'activateRollout',
    'getIssueBundle', 'runTask', 'getTaskExecution', 'queryVerification',
    'findIssueByOperationKey']
  required(['bytebase', 'assistant'].includes(approvalSource) && nonempty(config?.adapterId) && nonempty(config?.adapterVersion)
    && Array.isArray(targets) && targets.length > 0 && names.every(name => typeof api?.[name] === 'function')
    && ['getDatabase', 'readBaseline', 'checkPreconditions'].every(name =>
      typeof productionApi?.[name] === 'function')
    && (modern && targets.every(entry => !entry.uatTarget) || ['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql', 'rehearseInUat',
      'getUatRehearsalByOperationKey'].every(name => typeof uatApi?.[name] === 'function'))
    && (nativeApproval || typeof approvalApi?.getApproval === 'function'),
  'BYTEBASE_PLATFORM_NOT_CONFIGURED')
  const seen = new Set()
  for (const entry of targets) {
    const { project, target, uatTarget } = entry
    required(/^projects\/[A-Za-z0-9._-]+$/.test(project ?? '') && canonicalTarget(target)
      && target?.environment === 'production' && (modern && !uatTarget || canonicalUatTarget(uatTarget)
      && uatTarget.instance !== target.instance
      && uatTarget.database !== target.database), 'BYTEBASE_TARGET_CONFIG_INVALID')
    const key = executionDigest(target)
    required(!seen.has(key), 'BYTEBASE_TARGET_CONFIG_DUPLICATE')
    seen.add(key)
  }
  const rulesDigest = executionDigest({ adapterId: config.adapterId, adapterVersion: config.adapterVersion,
    ...(pluginApproval ? { approvalSource: 'assistant' } : {}),
    targets: targets.map(({ project, target, uatTarget }) => ({ project, target, ...(uatTarget ? { uatTarget } : {}) })) })
  const entryFor = target => {
    const entry = targets.find(item => exactTarget(item.target, target))
    required(entry && same(entry.target, target), 'BYTEBASE_TARGET_NOT_ALLOWED')
    return entry
  }
  const assertDatabase = (db, project, target) => required(db?.project === project
    && exactTarget(db, target), 'BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED')
  const assertBaseline = (baseline, project, target) => required(baseline?.project === project
    && exactTarget(baseline.target, target) && nonempty(baseline.snapshotId)
    && /^[a-f0-9]{64}$/.test(baseline.sha256 ?? '')
    && nonempty(baseline.schemaVersion) && /^[a-f0-9]{64}$/.test(baseline.schemaDigest ?? '')
    && nonempty(baseline.evidenceRef), 'BYTEBASE_BASELINE_UNCONFIRMED')
  const checkPreconditions = async ({ project, target, baseline, pkg, signal }) => {
    const port = target.environment === 'uat' ? uatApi : productionApi
    const result = await port.checkPreconditions({ project, target, baseline,
      applySql: pkg.applySql, applySqlSha256: pkg.applySqlSha256,
      expectedChange: pkg.expectedChange, verificationSql: pkg.verificationSql, signal })
    required(result?.passed === true && exactTarget(result.target, target)
      && result.sqlSha256 === pkg.applySqlSha256 && nonempty(result.checkId)
      && result.baselineEvidenceRef === baseline.evidenceRef
      && /^[a-f0-9]{64}$/.test(result.schemaProofDigest ?? ''), 'BYTEBASE_PRECONDITIONS_UNCONFIRMED')
    return result
  }
  const assertUnstartedTask = async (bundle, project) => {
    if (!bundle.task) return
    required(modern && bundle.task.planId === bundle.plan.id && bundle.task.status === 'NOT_STARTED',
      'BYTEBASE_PREAPPROVAL_EXECUTION_DETECTED')
    const execution = await api.getTaskExecution({ project, issueId: bundle.issue.id, taskId: bundle.task.id })
    required(execution?.task?.id === bundle.task.id && execution.task.planId === bundle.plan.id
      && execution.task.status === 'NOT_STARTED' && execution.taskRun === null,
    'BYTEBASE_PREAPPROVAL_EXECUTION_DETECTED')
  }
  const issueBundle = async (bundle, { project, target, sqlSha256, packageDigest, operationKey }) => {
      const { issue, sheet, plan } = bundle ?? {}
    required(nonempty(issue?.id) && nonempty(sheet?.id) && nonempty(plan?.id)
      && issue.project === project && issue.planId === plan.id
      && issue.operationKey === operationKey && issue.packageDigest === packageDigest
      && sheet.project === project && sheet.sha256 === sqlSha256 && exactTarget(sheet.target, target)
      && plan.project === project && plan.sheetId === sheet.id,
    'BYTEBASE_ISSUE_IDENTITY_UNCONFIRMED')
    await assertUnstartedTask(bundle, project)
    return { issue: { id: issue.id, planId: plan.id },
      sheet: { id: sheet.id, sha256: sheet.sha256, target: sheet.target },
      plan: { id: plan.id, sheetId: sheet.id } }
  }
  const issueKey = request => executionDigest({ stage: 'create-issue', runId: request.runId,
    generation: request.generation, requirementDigest: request.requirementDigest,
    packageDigest: request.packageDigest, target: request.target })
  const executeKey = request => executionDigest({ stage: 'execute-task',
    packageDigest: request.packageDigest, issueId: request.intent.issueId,
    approvalRequestId: request.approvalRequestId })
  const approvalScope = request => executionDigest({ runId: request.runId,
    generation: request.generation, issueId: request.intent.issueId,
    planId: request.intent.planId, sheetId: request.intent.sheetId, target: request.target,
    sheetSha256: request.applySqlSha256, packageDigest: request.packageDigest })
  const approvalKey = request => executionDigest({ stage: 'approval-gate',
    runId: request.runId, generation: request.generation,
    requirementDigest: request.requirementDigest,
    scopeDigest: approvalScope(request) })
  const rehearsalKey = ({ project, target, uatTarget, productionBaseline, uatBaseline, packageDigest }) => executionDigest({
    kind: 'bytebase-uat-rehearsal', project, sourceTarget: target, uatTarget,
    productionSchemaVersion: productionBaseline?.schemaVersion,
    productionSchemaDigest: productionBaseline?.schemaDigest,
    uatSnapshotId: uatBaseline?.snapshotId, uatSchemaDigest: uatBaseline?.schemaDigest,
    packageDigest })
  const rehearsalView = (result, intent) => {
    required(result?.passed === true && result.uat === true && nonempty(result.receiptId)
      && nonempty(result.taskRunId) && nonempty(result.verificationReadbackId)
      && nonempty(result.observedChange) && result.packageDigest === intent.packageDigest
      && result.sqlSha256 === intent.applySqlSha256
      && result.operationKey === intent.operationKey
      && exactTarget(result.target, intent.uatTarget)
      && exactTarget(result.sourceTarget, intent.sourceTarget)
      && result.productionBaselineEvidenceRef === intent.productionBaseline.evidenceRef
      && result.uatBaselineEvidenceRef === intent.uatBaseline.evidenceRef
      && result.schemaVersion === intent.uatBaseline.schemaVersion
      && result.schemaDigest === intent.uatBaseline.schemaDigest,
    'BYTEBASE_REHEARSAL_UNCONFIRMED')
    return { passed: true, uat: true, receiptId: result.receiptId,
      packageDigest: result.packageDigest, observedChange: result.observedChange }
  }
  const assertApproval = (approval, { issueId, planId, sheetId, target, sheetSha256, packageDigest,
    scopeDigest, requestId }) => required(approval?.decision === 'approved'
    && approval.source === (nativeApproval ? 'bytebase' : 'assistant') && approval.human === true
    && approval.issueId === issueId && approval.planId === planId && approval.sheetId === sheetId
    && exactTarget(approval.target, target)
    && approval.sheetSha256 === sheetSha256 && approval.packageDigest === packageDigest
    && /^[a-f0-9]{64}$/.test(approval.scopeDigest ?? '')
    && (!scopeDigest || approval.scopeDigest === scopeDigest)
    && nonempty(approval.requestId) && (!requestId || approval.requestId === requestId)
    && nonempty(approval.decidedBy), 'BYTEBASE_APPROVAL_UNCONFIRMED')
  const checkRequest = request => {
    required(request?.workflowKind === 'data-change'
      && ['rehearse-uat', 'create-issue', 'approval-gate', 'execute-task'].includes(request.stage),
      'BYTEBASE_OPERATION_INVALID')
    const entry = entryFor(request.target)
    required(request.intent?.project === entry.project && request.intent.packageDigest === request.packageDigest
      && request.intent.applySqlSha256 === request.applySqlSha256
      && exactTarget(request.intent.target, entry.target)
      && (request.stage !== 'rehearse-uat' || (exactTarget(request.intent.uatTarget, entry.uatTarget)
        && exactTarget(request.intent.sourceTarget, entry.target)
        && /^[a-f0-9]{64}$/.test(request.intent.schemaProofDigest ?? '')))
      && (request.stage !== 'approval-gate' || (nonempty(request.intent.issueId)
        && nonempty(request.intent.planId) && nonempty(request.intent.sheetId)
        && request.intent.sheetSha256 === request.applySqlSha256
        && request.intent.scopeDigest === approvalScope(request)))
      && (request.stage !== 'execute-task' || (nonempty(request.intent.issueId)
        && nonempty(request.intent.planId) && nonempty(request.intent.sheetId)
        && /^[a-f0-9]{64}$/.test(request.intent.approvalScopeDigest ?? '')
        && (!modern || (/^[a-f0-9]{64}$/.test(request.intent.issueCreationOperationKey ?? '')
          && request.intent.executeOperationKey === request.intent.operationKey))))
      && request.intent.operationKey === (request.stage === 'rehearse-uat'
        ? rehearsalKey({ project: entry.project, target: request.target,
          uatTarget: entry.uatTarget, productionBaseline: request.intent.productionBaseline,
          uatBaseline: request.intent.uatBaseline, packageDigest: request.packageDigest })
        : request.stage === 'create-issue' ? issueKey(request)
          : request.stage === 'approval-gate' ? approvalKey(request) : executeKey(request)),
    'BYTEBASE_OPERATION_IDENTITY_CHANGED')
    return entry
  }
  const getApproval = args => nativeApproval ? api.getIssueApproval({ project: entryFor(args.target).project, ...args }) : approvalApi.getApproval(args)
  const readNativeGate = async request => {
    const approval = await getApproval({ ...request.intent, target: request.target, sheetSha256: request.applySqlSha256 })
    if (!['approved', 'rejected'].includes(approval?.decision)) return { status: 'unknown', reason: approval?.decision === 'unconfigured' ? 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED' : 'BYTEBASE_APPROVAL_PENDING', result: { approval } }
    assertApproval({ ...approval, decision: 'approved' }, { issueId: request.intent.issueId,
      planId: request.intent.planId, sheetId: request.intent.sheetId, target: request.target,
      sheetSha256: request.applySqlSha256, packageDigest: request.packageDigest, scopeDigest: request.intent.scopeDigest })
    return { status: 'succeeded', result: { scopeDigest: request.intent.scopeDigest, operationKey: request.intent.operationKey, approval } }
  }
  const adapter = {
    nativeApproval, pluginApproval, requiresRehearsal: pkg => !modern || !isSimpleNullableColumnSql(pkg.applySql),
    id: config.adapterId, version: config.adapterVersion, rulesDigest,
    async readBaselineForCandidate({ target, applySql, signal }) {
      const entry = entryFor(target), column = simpleNullableColumnDefinition(applySql)
      const scope = column ? { schema: column.schema, table: column.table } : 'current'
      const baseline = await productionApi.readBaseline({ project: entry.project, target, scope, signal })
      assertBaseline(baseline, entry.project, target)
      if (column) required(same(baseline.scope, scope), 'BYTEBASE_BASELINE_SCOPE_UNCONFIRMED')
      return { snapshotId: baseline.snapshotId, sha256: baseline.sha256, ...(column ? { scope } : {}) }
    },
    async validate({ target, baseline, applySql, applySqlSha256, expectedChange,
      verificationSql, packageDigest, signal }) {
      const entry = entryFor(target)
      required(sha(applySql) === applySqlSha256 && nonempty(baseline?.snapshotId)
        && /^[a-f0-9]{64}$/.test(baseline?.sha256 ?? ''), 'BYTEBASE_PACKAGE_INVALID')
      if (baseline.scope) {
        const column = simpleNullableColumnDefinition(applySql)
        required(column && same(baseline.scope, { schema: column.schema, table: column.table }),
          'BYTEBASE_BASELINE_SCOPE_UNCONFIRMED')
      }
      assertDatabase(await productionApi.getDatabase({ project: entry.project, target, signal }), entry.project, target)
      assertDatabase(await api.getDatabase({ project: entry.project, target, signal }), entry.project, target)
      const actualBaseline = await productionApi.readBaseline({ project: entry.project, target,
        scope: baseline.scope ?? 'current', signal })
      assertBaseline(actualBaseline, entry.project, target)
      required(actualBaseline?.snapshotId === baseline.snapshotId
        && actualBaseline.sha256 === baseline.sha256
        && (!baseline.scope || same(actualBaseline.scope, baseline.scope)), 'BYTEBASE_BASELINE_UNCONFIRMED')
      const preconditions = await checkPreconditions({ project: entry.project, target, baseline: actualBaseline,
        pkg: { applySql, applySqlSha256, expectedChange, verificationSql }, signal })
      if (modern && isSimpleNullableColumnSql(applySql)) return { passed: true, packageDigest, receiptId: preconditions.checkId }
      required(entry.uatTarget, 'BYTEBASE_UAT_TARGET_REQUIRED_FOR_COMPLEX_SQL')
      const result = await uatApi.validateSql({ project: entry.project, target: entry.uatTarget,
        sql: applySql, sqlSha256: applySqlSha256, verificationSql, signal })
      required(result?.passed === true && result.sqlSha256 === applySqlSha256
        && exactTarget(result.target, entry.uatTarget) && nonempty(result.reviewId),
      'BYTEBASE_SQL_REVIEW_UNCONFIRMED')
      return { passed: true, packageDigest, receiptId: result.reviewId }
    },
    async prepareRehearsal({ package: pkg, signal }) {
      const entry = entryFor(pkg.target)
      required(entry.uatTarget, 'BYTEBASE_UAT_TARGET_REQUIRED_FOR_COMPLEX_SQL')
      required(pkg.validation?.packageDigest === executionDigest((({ validation, ...body }) => body)(pkg))
        && sha(pkg.applySql) === pkg.applySqlSha256, 'BYTEBASE_PACKAGE_IDENTITY_CHANGED')
      const productionBaseline = await productionApi.readBaseline({ project: entry.project, target: pkg.target,
        scope: 'current', signal })
      assertBaseline(productionBaseline, entry.project, pkg.target)
      required(productionBaseline.snapshotId === pkg.baseline.snapshotId
        && productionBaseline.sha256 === pkg.baseline.sha256, 'BYTEBASE_BASELINE_UNCONFIRMED')
      assertDatabase(await uatApi.getDatabase({ project: entry.project, target: entry.uatTarget, signal }),
        entry.project, entry.uatTarget)
      const uatBaseline = await uatApi.readBaseline({ project: entry.project, target: entry.uatTarget,
        scope: 'current', signal })
      assertBaseline(uatBaseline, entry.project, entry.uatTarget)
      const productionCheck = await checkPreconditions({ project: entry.project, target: pkg.target,
        baseline: productionBaseline, pkg, signal })
      const uatCheck = await checkPreconditions({ project: entry.project, target: entry.uatTarget,
        baseline: uatBaseline, pkg, signal })
      required(productionCheck.schemaProofDigest === uatCheck.schemaProofDigest,
        'BYTEBASE_UAT_SCHEMA_BASELINE_CHANGED')
      return { project: entry.project, target: pkg.target, sourceTarget: pkg.target,
        uatTarget: entry.uatTarget, productionBaseline, uatBaseline,
        schemaProofDigest: productionCheck.schemaProofDigest,
        operationKey: rehearsalKey({ project: entry.project, target: pkg.target,
          uatTarget: entry.uatTarget, productionBaseline, uatBaseline,
          packageDigest: pkg.validation.packageDigest }),
        applySql: pkg.applySql, expectedChange: pkg.expectedChange,
        verificationSql: pkg.verificationSql,
        rollbackSql: pkg.rollbackSql, packageDigest: pkg.validation.packageDigest,
        applySqlSha256: pkg.applySqlSha256 }
    },
    async readbackRehearsal({ package: pkg, request, receipt, signal }) {
      checkRequest(request)
      required(receipt?.result?.receiptId && request.packageDigest === pkg.validation.packageDigest
        && sha(pkg.applySql) === request.applySqlSha256, 'BYTEBASE_REHEARSAL_RECEIPT_UNKNOWN')
      const result = await uatApi.getUatRehearsalByOperationKey({ project: request.intent.project,
        operationKey: request.intent.operationKey, signal })
      required(result?.receiptId === receipt.result.receiptId, 'BYTEBASE_REHEARSAL_RECEIPT_UNKNOWN')
      return rehearsalView(result, request.intent)
    },
    async prepareIssue({ prepared, runId, generation, requirementDigest }) {
      const pkg = prepared.package, entry = entryFor(pkg.target)
      required((modern && isSimpleNullableColumnSql(pkg.applySql) && !prepared.rehearsal) || (prepared.rehearsal?.passed === true && prepared.rehearsal?.uat === true
        && prepared.rehearsal.packageDigest === pkg.validation.packageDigest), 'BYTEBASE_REHEARSAL_REQUIRED')
      const request = { runId, generation, requirementDigest, packageDigest: pkg.validation.packageDigest,
        target: pkg.target }
      return { project: entry.project, target: pkg.target, ...(modern ? { approvalSource: nativeApproval ? 'bytebase' : 'assistant' } : {}), operationKey: issueKey(request),
        packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
        applySql: pkg.applySql, expectedChange: pkg.expectedChange,
        ...(modern ? { proposalSummary: `待真人审批的候选 SQL：${pkg.applySql}` } : {}),
        ...(pkg.previousIssueId ? { previousIssueId: pkg.previousIssueId } : {}) }
    },
    async prepareApproval({ view, runId, generation, requirementDigest }) {
      const pkg = view.prepared.package, entry = entryFor(pkg.target)
      const issue = view.issue, sheet = view.sheet, plan = view.plan
      required(issue?.planId === plan?.id && plan?.sheetId === sheet?.id
        && sheet?.sha256 === pkg.applySqlSha256 && exactTarget(sheet.target, pkg.target),
      'BYTEBASE_APPROVAL_SCOPE_INVALID')
      const request = { runId, generation, requirementDigest, target: pkg.target,
        packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
        intent: { issueId: issue.id, planId: plan.id, sheetId: sheet.id } }
      return { project: entry.project, target: pkg.target, ...(pluginApproval ? { applySql: pkg.applySql } : {}), ...(modern ? { approvalSource: nativeApproval ? 'bytebase' : 'assistant' } : {}),
        issueId: issue.id, planId: plan.id, sheetId: sheet.id,
        sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest,
        applySqlSha256: pkg.applySqlSha256, scopeDigest: approvalScope(request),
        operationKey: approvalKey(request) }
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
      required(stage === 'execute-task' && nonempty(receipt?.result?.taskId),
        'BYTEBASE_TASK_RECEIPT_UNKNOWN')
      const taskId = receipt.result.taskId
      let result
      for (let attempt = 0; attempt < 30; attempt++) {
        signal?.throwIfAborted()
        result = await api.getTaskExecution({ project: entry.project, issueId: issue?.id,
          taskId, signal })
        if (result?.task?.status === 'DONE' && result.taskRun?.status === 'DONE') break
        required(result?.task?.status !== 'FAILED' && result?.taskRun?.status !== 'FAILED',
          'BYTEBASE_TASK_RUN_FAILED')
        if (attempt < 29) await new Promise(resolve => setTimeout(resolve, 2000))
      }
      required(result?.task?.id === taskId && result.task.planId === plan.id
        && result.task.status === 'DONE'
        && result.taskRun?.taskId === taskId && result.taskRun?.status === 'DONE'
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
    async inspect({ stage, issue, sheet, plan, prepared, request, receipt, signal }) {
      const pkg = prepared.package, entry = entryFor(pkg.target)
      if (modern && stage === 'approval-state') {
        checkRequest(request)
        return getApproval({ ...request, ...request.intent, target: request.target, sheetSha256: request.applySqlSha256, signal })
      }
      if (stage === 'approval') {
        checkRequest(request)
        required(request.stage === 'approval-gate' && receipt?.status === 'succeeded'
          && receipt.result?.scopeDigest === request.intent.scopeDigest
          && receipt.result?.operationKey === request.intent.operationKey,
        'BYTEBASE_APPROVAL_RECEIPT_UNCONFIRMED')
        const approval = await getApproval({ runId: request.runId,
          generation: request.generation, requirementDigest: request.requirementDigest,
          resourceKey: request.resourceKey, scopeDigest: request.intent.scopeDigest,
          issueId: issue.id, planId: plan.id, sheetId: sheet.id, target: pkg.target,
          sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest, signal })
        if (modern && approval?.decision === 'rejected') return approval
        assertApproval(approval, { issueId: issue.id, planId: plan.id, sheetId: sheet.id,
          target: pkg.target,
          sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest,
          scopeDigest: request.intent.scopeDigest })
        return approval
      }
      required(stage === 'pre-execution', 'BYTEBASE_INSPECTION_INVALID')
      const bundle = await api.getIssueBundle({ project: entry.project, issueId: issue.id, signal })
      required(bundle?.issue?.id === issue.id && bundle?.issue?.packageDigest === pkg.validation.packageDigest
        && bundle?.sheet?.sha256 === sheet.sha256 && exactTarget(bundle.sheet.target, pkg.target)
        && bundle?.plan?.id === plan.id && bundle?.plan?.sheetId === sheet.id, 'BYTEBASE_PREFLIGHT_CHANGED')
      await assertUnstartedTask(bundle, entry.project)
      return { sheet, plan }
    },
    async prepareExecute({ identity, issue, approval, prepared, signal }) {
      const entry = entryFor(identity.target)
      const pkg = prepared.package
      assertApproval(approval, { issueId: issue.id, planId: identity.planId,
        sheetId: identity.sheetId,
        target: identity.target, sheetSha256: identity.applySqlSha256,
        packageDigest: identity.packageDigest, requestId: identity.approvalRequestId,
        scopeDigest: approval.scopeDigest })
      const baseline = await productionApi.readBaseline({ project: entry.project, target: identity.target,
        scope: pkg.baseline.scope ?? 'current', signal })
      assertBaseline(baseline, entry.project, identity.target)
      if (pkg.baseline.scope) required(same(baseline.scope, pkg.baseline.scope)
        && baseline.snapshotId === pkg.baseline.snapshotId && baseline.sha256 === pkg.baseline.sha256,
      'BYTEBASE_PRODUCTION_SCHEMA_CHANGED')
      await checkPreconditions({ project: entry.project, target: identity.target,
        baseline, pkg, signal })
      const bundle = await api.getIssueBundle({ project: entry.project, issueId: issue.id, signal })
      required(bundle?.issue?.id === issue.id && bundle.issue.packageDigest === identity.packageDigest
        && bundle.plan?.id === identity.planId && bundle.sheet?.id === identity.sheetId
        && bundle.sheet.sha256 === identity.applySqlSha256 && exactTarget(bundle.sheet.target, identity.target)
        && /^[a-f0-9]{64}$/.test(bundle.issue.operationKey ?? ''), 'BYTEBASE_PREFLIGHT_CHANGED')
      const executeOperationKey = executeKey({ packageDigest: identity.packageDigest,
        intent: { issueId: issue.id }, approvalRequestId: identity.approvalRequestId })
      return { project: entry.project, target: identity.target, ...(modern ? { approvalSource: nativeApproval ? 'bytebase' : 'assistant' } : {}), issueId: issue.id,
        planId: identity.planId, sheetId: identity.sheetId,
        approvalRequestId: identity.approvalRequestId,
        approvalScopeDigest: approval.scopeDigest,
        packageDigest: identity.packageDigest, applySqlSha256: identity.applySqlSha256,
        baseline, applySql: pkg.applySql, expectedChange: pkg.expectedChange,
        verificationSql: pkg.verificationSql,
        issueCreationOperationKey: bundle.issue.operationKey, executeOperationKey,
        operationKey: executeOperationKey }
    },
  }
  const externalAdapter = {
    async execute(request) {
      const entry = checkRequest(request)
      if (request.stage === 'rehearse-uat') {
        required(sha(request.intent.applySql) === request.applySqlSha256
          && nonempty(request.intent.expectedChange)
          && exactTarget(request.intent.uatTarget, entry.uatTarget)
          && exactTarget(request.intent.sourceTarget, request.target)
          && nonempty(request.intent.productionBaseline?.evidenceRef)
          && nonempty(request.intent.uatBaseline?.evidenceRef), 'BYTEBASE_REHEARSAL_IDENTITY_CHANGED')
        assertDatabase(await uatApi.getDatabase({ project: entry.project, target: entry.uatTarget }),
          entry.project, entry.uatTarget)
        const currentUatBaseline = await uatApi.readBaseline({ project: entry.project,
          target: entry.uatTarget, scope: 'current' })
        assertBaseline(currentUatBaseline, entry.project, entry.uatTarget)
        required(currentUatBaseline.schemaVersion === request.intent.uatBaseline.schemaVersion
          && currentUatBaseline.schemaDigest === request.intent.uatBaseline.schemaDigest,
        'BYTEBASE_UAT_SCHEMA_BASELINE_CHANGED')
        const productionBaseline = await productionApi.readBaseline({ project: entry.project,
          target: request.target, scope: 'current' })
        assertBaseline(productionBaseline, entry.project, request.target)
        required(productionBaseline.snapshotId === request.intent.productionBaseline.snapshotId
          && productionBaseline.schemaDigest === request.intent.productionBaseline.schemaDigest,
        'BYTEBASE_PRODUCTION_SCHEMA_BASELINE_CHANGED')
        const productionCheck = await checkPreconditions({ project: entry.project,
          target: request.target, baseline: productionBaseline, pkg: request.intent })
        const uatCheck = await checkPreconditions({ project: entry.project, target: entry.uatTarget,
          baseline: currentUatBaseline, pkg: request.intent })
        required(productionCheck.schemaProofDigest === request.intent.schemaProofDigest
          && uatCheck.schemaProofDigest === request.intent.schemaProofDigest,
        'BYTEBASE_UAT_SCHEMA_BASELINE_CHANGED')
        const result = await uatApi.rehearseInUat(request.intent)
        const verified = rehearsalView(result, request.intent)
        return { status: 'succeeded', result: { receiptId: verified.receiptId } }
      }
      if (request.stage === 'approval-gate' && nativeApproval) return readNativeGate(request)
      if (request.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: request.intent.scopeDigest,
          operationKey: request.intent.operationKey } }
      if (request.stage === 'create-issue') {
        required(sha(request.intent.applySql) === request.applySqlSha256,
          'BYTEBASE_SQL_IDENTITY_CHANGED')
        const result = await api.createIssueBundle({ ...request.intent, signal: undefined })
        const view = await issueBundle(result, { project: entry.project, target: request.target,
          sqlSha256: request.applySqlSha256, packageDigest: request.packageDigest,
          operationKey: request.intent.operationKey })
        return { status: 'succeeded', result: { issueId: view.issue.id } }
      }
      const bundle = await api.getIssueBundle({ project: entry.project, issueId: request.intent.issueId })
      required(bundle?.plan?.id === request.intent.planId
        && bundle?.sheet?.id === request.intent.sheetId
        && bundle.sheet.sha256 === request.applySqlSha256
        && bundle?.issue?.packageDigest === request.packageDigest
        && (!modern || bundle.issue.operationKey === request.intent.issueCreationOperationKey), 'BYTEBASE_PREFLIGHT_CHANGED')
      const approval = await getApproval({ runId: request.runId,
        generation: request.generation, requirementDigest: request.requirementDigest,
        resourceKey: request.resourceKey, scopeDigest: request.intent.approvalScopeDigest,
        issueId: request.intent.issueId, planId: request.intent.planId,
        sheetId: request.intent.sheetId, target: request.target,
        sheetSha256: request.applySqlSha256, packageDigest: request.packageDigest })
      assertApproval(approval, { issueId: request.intent.issueId,
        planId: request.intent.planId, sheetId: request.intent.sheetId,
        target: request.target, sheetSha256: request.applySqlSha256,
        packageDigest: request.packageDigest, requestId: request.approvalRequestId,
        scopeDigest: request.intent.approvalScopeDigest })
      const currentBaseline = await productionApi.readBaseline({ project: entry.project,
        target: request.target, scope: request.intent.baseline?.scope ?? 'current' })
      assertBaseline(currentBaseline, entry.project, request.target)
      required(currentBaseline.schemaVersion === request.intent.baseline?.schemaVersion
        && currentBaseline.schemaDigest === request.intent.baseline?.schemaDigest,
      'BYTEBASE_PRODUCTION_SCHEMA_CHANGED')
      required(sha(request.intent.applySql) === request.applySqlSha256,
        'BYTEBASE_SQL_IDENTITY_CHANGED')
      await checkPreconditions({ project: entry.project, target: request.target,
        baseline: currentBaseline, pkg: request.intent })
      const activated = await api.activateRollout({ project: entry.project,
        issueId: request.intent.issueId, issueCreationOperationKey: bundle.issue.operationKey,
        executeOperationKey: request.intent.operationKey, approvalRequestId: request.approvalRequestId,
        planId: request.intent.planId, sheetId: request.intent.sheetId, target: request.target,
        applySqlSha256: request.applySqlSha256, packageDigest: request.packageDigest })
      required(activated?.task?.planId === request.intent.planId
        && nonempty(activated.task.id), 'BYTEBASE_ROLLOUT_UNCONFIRMED')
      const result = await api.runTask({ project: entry.project, issueId: request.intent.issueId,
        taskId: activated.task.id, issueCreationOperationKey: bundle.issue.operationKey,
        executeOperationKey: request.intent.operationKey, approvalRequestId: request.approvalRequestId,
        planId: request.intent.planId, sheetId: request.intent.sheetId, target: request.target,
        applySqlSha256: request.applySqlSha256, packageDigest: request.packageDigest })
      required(result?.taskId === activated.task.id, 'BYTEBASE_RUN_TASK_RECEIPT_UNKNOWN')
      return { status: 'succeeded', result: { taskId: activated.task.id } }
    },
    async reconcile(request) {
      const entry = checkRequest(request)
      if (request.stage === 'rehearse-uat') {
        const result = await uatApi.getUatRehearsalByOperationKey({ project: entry.project,
          operationKey: request.intent.operationKey })
        if (!result?.passed) return { status: 'unknown', reason: 'rehearsal_not_observed' }
        const verified = rehearsalView(result, request.intent)
        return { status: 'succeeded', result: { receiptId: verified.receiptId } }
      }
      if (request.stage === 'approval-gate' && nativeApproval) return readNativeGate(request)
      if (request.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: request.intent.scopeDigest,
          operationKey: request.intent.operationKey } }
      if (request.stage === 'create-issue') {
        const found = await api.findIssueByOperationKey({ project: entry.project,
          operationKey: request.intent.operationKey })
        if (!found) return { status: 'unknown', reason: 'issue_not_observed' }
        const view = await issueBundle(found, { project: entry.project, target: request.target,
          sqlSha256: request.applySqlSha256, packageDigest: request.packageDigest,
          operationKey: request.intent.operationKey })
        return { status: 'succeeded', result: { issueId: view.issue.id } }
      }
      const bundle = await api.getIssueBundle({ project: entry.project,
        issueId: request.intent.issueId })
      required(bundle?.issue?.id === request.intent.issueId && bundle.issue.packageDigest === request.packageDigest
        && bundle.plan?.id === request.intent.planId && bundle.sheet?.id === request.intent.sheetId
        && bundle.sheet.sha256 === request.applySqlSha256 && exactTarget(bundle.sheet.target, request.target)
        && (!modern || bundle.issue.operationKey === request.intent.issueCreationOperationKey),
      'BYTEBASE_EXECUTION_READBACK_IDENTITY_CHANGED')
      if (!bundle?.task?.id || bundle.task.planId !== request.intent.planId)
        return { status: 'unknown', reason: 'run_not_observed' }
      const result = await api.getTaskExecution({ project: entry.project,
        issueId: request.intent.issueId, taskId: bundle.task.id })
      if (result?.taskRun?.taskId !== bundle.task.id)
        return { status: 'unknown', reason: 'run_not_observed' }
      return { status: 'succeeded', result: { taskId: bundle.task.id } }
    },
  }
  async function verifyApprovalHandoff({ request, view }) {
    const entry = checkRequest(request), pkg = view?.prepared?.package
    const { validation, ...body } = pkg ?? {}
    required(nativeApproval && request.stage === 'approval-gate' && request.intent.approvalSource === 'bytebase'
      && validation?.packageDigest === executionDigest(body)
      && request.packageDigest === validation.packageDigest
      && pkg.applySqlSha256 === request.applySqlSha256 && sha(pkg.applySql) === request.applySqlSha256
      && exactTarget(pkg.target, request.target)
      && view.issue.id === request.intent.issueId && view.plan.id === request.intent.planId
      && view.sheet.id === request.intent.sheetId, 'BYTEBASE_APPROVAL_HANDOFF_IDENTITY_INVALID')
    const bundle = await api.getIssueBundle({ project: entry.project, issueId: view.issue.id })
    required(nonempty(bundle?.task?.id), 'BYTEBASE_APPROVAL_HANDOFF_TASK_UNCONFIRMED')
    const current = await issueBundle(bundle, { project: entry.project, target: request.target,
      sqlSha256: request.applySqlSha256, packageDigest: request.packageDigest, operationKey: issueKey(request) })
    required(same(current, { issue: view.issue, sheet: view.sheet, plan: view.plan }), 'BYTEBASE_APPROVAL_HANDOFF_IDENTITY_INVALID')
    const approval = await api.getIssueApproval({ project: entry.project, ...request.intent,
      target: request.target, sheetSha256: request.applySqlSha256 })
    required(approval?.decision === 'unconfigured' && approval.source === 'bytebase'
      && approval.issueId === view.issue.id && approval.planId === view.plan.id && approval.sheetId === view.sheet.id
      && approval.packageDigest === request.packageDigest && approval.sheetSha256 === request.applySqlSha256
      && approval.scopeDigest === request.intent.scopeDigest && exactTarget(approval.target, request.target),
    'BYTEBASE_APPROVAL_HANDOFF_NOT_SKIPPED')
    const baseline = await productionApi.readBaseline({ project: entry.project, target: pkg.target,
      scope: pkg.baseline.scope ?? 'current' })
    assertBaseline(baseline, entry.project, pkg.target)
    required(!pkg.baseline.scope || same(baseline.scope, pkg.baseline.scope)
      && baseline.snapshotId === pkg.baseline.snapshotId && baseline.sha256 === pkg.baseline.sha256,
    'BYTEBASE_PRODUCTION_SCHEMA_CHANGED')
    await checkPreconditions({ project: entry.project, target: pkg.target, baseline, pkg })
    return structuredClone(view)
  }
  return { workflowAdapter: adapter, externalAdapter, verifyApprovalHandoff }
}
