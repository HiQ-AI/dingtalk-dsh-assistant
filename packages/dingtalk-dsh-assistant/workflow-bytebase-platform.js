import { createHash } from 'node:crypto'
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
 * 生产与 UAT 数据库；UAT 演练作为独立外部效果进入 Controller 效果账。
 *
 * api 仅用于 Bytebase 生产端；uatApi 由受信 PostgreSQL 客户端提供独立回读与事务演练。
 * api: getDatabase, readBaseline, checkPreconditions, validateSql, createIssueBundle,
 * getIssueBundle, runTask, getTaskExecution, queryVerification,
 * findIssueByOperationKey。所有方法必须返回 Bytebase 的独立读回结果。
 */
export function createBytebaseDataChangePlatform({ config, api, uatApi, approvalApi }) {
  const targets = config?.targets
  const names = ['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql', 'createIssueBundle',
    'getIssueBundle', 'runTask', 'getTaskExecution', 'queryVerification',
    'findIssueByOperationKey']
  required(nonempty(config?.adapterId) && nonempty(config?.adapterVersion)
    && Array.isArray(targets) && targets.length > 0 && names.every(name => typeof api?.[name] === 'function')
    && ['getDatabase', 'readBaseline', 'checkPreconditions', 'rehearseInUat',
      'getUatRehearsalByOperationKey'].every(name => typeof uatApi?.[name] === 'function')
    && typeof approvalApi?.getApproval === 'function',
  'BYTEBASE_PLATFORM_NOT_CONFIGURED')
  const seen = new Set()
  for (const entry of targets) {
    const { project, target, uatTarget } = entry
    required(/^projects\/[A-Za-z0-9._-]+$/.test(project ?? '') && canonicalTarget(target)
      && target?.environment === 'production' && canonicalUatTarget(uatTarget)
      && uatTarget.instance !== target.instance
      && uatTarget.database !== target.database, 'BYTEBASE_TARGET_CONFIG_INVALID')
    const key = executionDigest(target)
    required(!seen.has(key), 'BYTEBASE_TARGET_CONFIG_DUPLICATE')
    seen.add(key)
  }
  const rulesDigest = executionDigest({ adapterId: config.adapterId, adapterVersion: config.adapterVersion,
    targets: targets.map(({ project, target, uatTarget }) => ({ project, target, uatTarget })) })
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
    const port = target.environment === 'uat' ? uatApi : api
    const result = await port.checkPreconditions({ project, target, baseline,
      applySql: pkg.applySql, applySqlSha256: pkg.applySqlSha256,
      expectedChange: pkg.expectedChange, verificationSql: pkg.verificationSql, signal })
    required(result?.passed === true && exactTarget(result.target, target)
      && result.sqlSha256 === pkg.applySqlSha256 && nonempty(result.checkId)
      && result.baselineEvidenceRef === baseline.evidenceRef, 'BYTEBASE_PRECONDITIONS_UNCONFIRMED')
    return result
  }
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
  const approvalScope = request => executionDigest({ runId: request.runId,
    generation: request.generation, issueId: request.intent.issueId,
    taskId: request.intent.taskId, target: request.target,
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
  const assertApproval = (approval, { issueId, taskId, target, sheetSha256, packageDigest,
    scopeDigest, requestId }) => required(approval?.decision === 'approved'
    && approval.source === 'assistant' && approval.human === true
    && approval.issueId === issueId && approval.taskId === taskId
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
        && request.intent.productionBaseline?.schemaVersion === request.intent.uatBaseline?.schemaVersion
        && request.intent.productionBaseline?.schemaDigest === request.intent.uatBaseline?.schemaDigest))
      && (request.stage !== 'approval-gate' || (nonempty(request.intent.issueId)
        && nonempty(request.intent.taskId) && request.intent.taskId === request.taskId
        && request.intent.sheetSha256 === request.applySqlSha256
        && request.intent.scopeDigest === approvalScope(request)))
      && (request.stage !== 'execute-task' || /^[a-f0-9]{64}$/.test(request.intent.approvalScopeDigest ?? ''))
      && request.intent.operationKey === (request.stage === 'rehearse-uat'
        ? rehearsalKey({ project: entry.project, target: request.target,
          uatTarget: entry.uatTarget, productionBaseline: request.intent.productionBaseline,
          uatBaseline: request.intent.uatBaseline, packageDigest: request.packageDigest })
        : request.stage === 'create-issue' ? issueKey(request)
          : request.stage === 'approval-gate' ? approvalKey(request) : executeKey(request)),
    'BYTEBASE_OPERATION_IDENTITY_CHANGED')
    return entry
  }
  const adapter = {
    id: config.adapterId, version: config.adapterVersion, rulesDigest,
    async validate({ target, baseline, applySql, applySqlSha256, expectedChange,
      verificationSql, packageDigest, signal }) {
      const entry = entryFor(target)
      required(sha(applySql) === applySqlSha256 && nonempty(baseline?.snapshotId)
        && /^[a-f0-9]{64}$/.test(baseline?.sha256 ?? ''), 'BYTEBASE_PACKAGE_INVALID')
      assertDatabase(await api.getDatabase({ project: entry.project, target, signal }), entry.project, target)
      const actualBaseline = await api.readBaseline({ project: entry.project, target,
        scope: 'current', signal })
      assertBaseline(actualBaseline, entry.project, target)
      required(actualBaseline?.snapshotId === baseline.snapshotId
        && actualBaseline.sha256 === baseline.sha256, 'BYTEBASE_BASELINE_UNCONFIRMED')
      await checkPreconditions({ project: entry.project, target, baseline: actualBaseline,
        pkg: { applySql, applySqlSha256, expectedChange, verificationSql }, signal })
      const result = await api.validateSql({ project: entry.project, target, sql: applySql,
        sqlSha256: applySqlSha256, baseline: actualBaseline, signal })
      required(result?.passed === true && result.sqlSha256 === applySqlSha256
        && exactTarget(result.target, target) && nonempty(result.reviewId), 'BYTEBASE_SQL_REVIEW_UNCONFIRMED')
      return { passed: true, packageDigest, receiptId: result.reviewId }
    },
    async prepareRehearsal({ package: pkg, signal }) {
      const entry = entryFor(pkg.target)
      required(pkg.validation?.packageDigest === executionDigest((({ validation, ...body }) => body)(pkg))
        && sha(pkg.applySql) === pkg.applySqlSha256, 'BYTEBASE_PACKAGE_IDENTITY_CHANGED')
      const productionBaseline = await api.readBaseline({ project: entry.project, target: pkg.target,
        scope: 'current', signal })
      assertBaseline(productionBaseline, entry.project, pkg.target)
      required(productionBaseline.snapshotId === pkg.baseline.snapshotId
        && productionBaseline.sha256 === pkg.baseline.sha256, 'BYTEBASE_BASELINE_UNCONFIRMED')
      assertDatabase(await uatApi.getDatabase({ project: entry.project, target: entry.uatTarget, signal }),
        entry.project, entry.uatTarget)
      const uatBaseline = await uatApi.readBaseline({ project: entry.project, target: entry.uatTarget,
        scope: 'current', signal })
      assertBaseline(uatBaseline, entry.project, entry.uatTarget)
      required(uatBaseline.schemaVersion === productionBaseline.schemaVersion
        && uatBaseline.schemaDigest === productionBaseline.schemaDigest,
      'BYTEBASE_UAT_SCHEMA_BASELINE_CHANGED')
      await checkPreconditions({ project: entry.project, target: pkg.target,
        baseline: productionBaseline, pkg, signal })
      await checkPreconditions({ project: entry.project, target: entry.uatTarget,
        baseline: uatBaseline, pkg, signal })
      return { project: entry.project, target: pkg.target, sourceTarget: pkg.target,
        uatTarget: entry.uatTarget, productionBaseline, uatBaseline,
        operationKey: rehearsalKey({ project: entry.project, target: pkg.target,
          uatTarget: entry.uatTarget, productionBaseline, uatBaseline,
          packageDigest: pkg.validation.packageDigest }),
        applySql: pkg.applySql, verificationSql: pkg.verificationSql,
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
      required(prepared.rehearsal?.passed === true && prepared.rehearsal?.uat === true
        && prepared.rehearsal.packageDigest === pkg.validation.packageDigest, 'BYTEBASE_REHEARSAL_REQUIRED')
      const request = { runId, generation, requirementDigest, packageDigest: pkg.validation.packageDigest,
        target: pkg.target }
      return { project: entry.project, target: pkg.target, operationKey: issueKey(request),
        packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
        applySql: pkg.applySql, expectedChange: pkg.expectedChange }
    },
    async prepareApproval({ view, runId, generation, requirementDigest }) {
      const pkg = view.prepared.package, entry = entryFor(pkg.target)
      const issue = view.issue, task = view.task, sheet = view.sheet
      required(issue?.taskId === task?.id && sheet?.sha256 === pkg.applySqlSha256
        && exactTarget(sheet.target, pkg.target) && task?.status === 'NOT_STARTED',
      'BYTEBASE_APPROVAL_SCOPE_INVALID')
      const request = { runId, generation, requirementDigest, target: pkg.target,
        packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
        intent: { issueId: issue.id, taskId: task.id } }
      return { project: entry.project, target: pkg.target,
        issueId: issue.id, taskId: task.id, planId: view.plan.id, sheetId: sheet.id,
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
    async inspect({ stage, issue, sheet, plan, task, prepared, request, receipt, signal }) {
      const pkg = prepared.package, entry = entryFor(pkg.target)
      if (stage === 'approval') {
        checkRequest(request)
        required(request.stage === 'approval-gate' && receipt?.status === 'succeeded'
          && receipt.result?.scopeDigest === request.intent.scopeDigest
          && receipt.result?.operationKey === request.intent.operationKey,
        'BYTEBASE_APPROVAL_RECEIPT_UNCONFIRMED')
        const approval = await approvalApi.getApproval({ runId: request.runId,
          generation: request.generation, requirementDigest: request.requirementDigest,
          resourceKey: request.resourceKey, scopeDigest: request.intent.scopeDigest,
          issueId: issue.id, taskId: task.id, target: pkg.target,
          sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest, signal })
        assertApproval(approval, { issueId: issue.id, taskId: task.id, target: pkg.target,
          sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest,
          scopeDigest: request.intent.scopeDigest })
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
    async prepareExecute({ identity, issue, approval, prepared, signal }) {
      const entry = entryFor(identity.target)
      const pkg = prepared.package
      assertApproval(approval, { issueId: issue.id, taskId: identity.taskId,
        target: identity.target, sheetSha256: identity.applySqlSha256,
        packageDigest: identity.packageDigest, requestId: identity.approvalRequestId,
        scopeDigest: approval.scopeDigest })
      const baseline = await api.readBaseline({ project: entry.project, target: identity.target,
        scope: 'current', signal })
      assertBaseline(baseline, entry.project, identity.target)
      await checkPreconditions({ project: entry.project, target: identity.target,
        baseline, pkg, signal })
      return { project: entry.project, target: identity.target, issueId: issue.id,
        taskId: identity.taskId, approvalRequestId: identity.approvalRequestId,
        approvalScopeDigest: approval.scopeDigest,
        packageDigest: identity.packageDigest, applySqlSha256: identity.applySqlSha256,
        baseline, applySql: pkg.applySql, expectedChange: pkg.expectedChange,
        verificationSql: pkg.verificationSql,
        operationKey: executeKey({ packageDigest: identity.packageDigest, taskId: identity.taskId,
          approvalRequestId: identity.approvalRequestId }) }
    },
  }
  const externalAdapter = {
    async execute(request) {
      const entry = checkRequest(request)
      if (request.stage === 'rehearse-uat') {
        required(sha(request.intent.applySql) === request.applySqlSha256
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
        await checkPreconditions({ project: entry.project, target: entry.uatTarget,
          baseline: currentUatBaseline, pkg: request.intent })
        const result = await uatApi.rehearseInUat(request.intent)
        const verified = rehearsalView(result, request.intent)
        return { status: 'succeeded', result: { receiptId: verified.receiptId } }
      }
      if (request.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: request.intent.scopeDigest,
          operationKey: request.intent.operationKey } }
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
      const approval = await approvalApi.getApproval({ runId: request.runId,
        generation: request.generation, requirementDigest: request.requirementDigest,
        resourceKey: request.resourceKey, scopeDigest: request.intent.approvalScopeDigest,
        issueId: request.intent.issueId, taskId: request.taskId, target: request.target,
        sheetSha256: request.applySqlSha256, packageDigest: request.packageDigest })
      assertApproval(approval, { issueId: request.intent.issueId, taskId: request.taskId,
        target: request.target, sheetSha256: request.applySqlSha256,
        packageDigest: request.packageDigest, requestId: request.approvalRequestId,
        scopeDigest: request.intent.approvalScopeDigest })
      const currentBaseline = await api.readBaseline({ project: entry.project,
        target: request.target, scope: 'current' })
      assertBaseline(currentBaseline, entry.project, request.target)
      required(currentBaseline.schemaVersion === request.intent.baseline?.schemaVersion
        && currentBaseline.schemaDigest === request.intent.baseline?.schemaDigest,
      'BYTEBASE_PRODUCTION_SCHEMA_CHANGED')
      required(sha(request.intent.applySql) === request.applySqlSha256,
        'BYTEBASE_SQL_IDENTITY_CHANGED')
      await checkPreconditions({ project: entry.project, target: request.target,
        baseline: currentBaseline, pkg: request.intent })
      const result = await api.runTask({ project: entry.project, issueId: request.intent.issueId,
        taskId: request.taskId, operationKey: request.intent.operationKey })
      required(result?.taskId === request.taskId, 'BYTEBASE_RUN_TASK_RECEIPT_UNKNOWN')
      return { status: 'succeeded', result: { taskId: request.taskId } }
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
      if (request.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: request.intent.scopeDigest,
          operationKey: request.intent.operationKey } }
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
