import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createBytebaseDataChangePlatform } from '../packages/dingtalk-dsh-assistant/workflow-bytebase-platform.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const target = { instance: 'instances/prod', database: 'instances/prod/databases/app', environment: 'production' }
const uatTarget = { instance: 'postgresql/192.168.8.8:30770', database: 'app', environment: 'uat' }
const config = { adapterId: 'bytebase', adapterVersion: '1',
  targets: [{ project: 'projects/app', target, uatTarget }] }
const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1 AND v = 1;'
const packageBody = { target, baseline: { snapshotId: 'baseline-1', sha256: sha('baseline') },
  sourceDigest: sha('source'), applySql, applySqlSha256: sha(applySql),
  rollbackSql: 'UPDATE public.t SET v = 1 WHERE id = 1 AND v = 2;',
  verificationSql: 'SELECT v FROM public.t WHERE id = 1;', expectedChange: '{"rows":[{"v":2}]}' }
const pkg = { ...packageBody, validation: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'review-1', packageDigest: executionDigest(packageBody) } }
const prepared = { package: pkg, rehearsal: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'uat-run-1', packageDigest: pkg.validation.packageDigest,
  uat: true, passed: true, observedChange: 'v=2' } }

test('完成回查绑定冻结审批 SQL 与当前工单，仅使用只读端口且拒绝漂移及未完成事实', async () => {
  let bundle, taskFailed = false, reads = 0
  const f = fixture({ api: {
    async getIssueBundle() { reads++; return bundle },
    async getTaskExecution() { return { task: { ...bundle.task, status: taskFailed ? 'FAILED' : 'DONE' },
      taskRun: { id: 'task-run-1', taskId: bundle.task.id, status: taskFailed ? 'FAILED' : 'DONE' } } },
    async createIssueBundle() { assert.fail('完成回查不得创建工单') },
    async activateRollout() { assert.fail('完成回查不得发布') },
    async runTask() { assert.fail('完成回查不得执行 SQL') },
  } })
  f.issue.operationKey = sha('original-creation')
  const requestId = 'approval-1'
  const scopeDigest = executionDigest({ runId: 'run-1', generation: 1, issueId: f.issue.id,
    planId: f.plan.id, sheetId: f.sheet.id, target, sheetSha256: pkg.applySqlSha256,
    packageDigest: pkg.validation.packageDigest })
  const operationKey = executionDigest({ stage: 'execute-task', packageDigest: pkg.validation.packageDigest,
    issueId: f.issue.id, approvalRequestId: requestId })
  const view = { prepared, issue: { id: f.issue.id, planId: f.plan.id }, sheet: f.sheet, plan: f.plan,
    approval: { decision: 'approved', source: 'assistant', human: true, decidedBy: 'reviewer', requestId,
      issueId: f.issue.id, planId: f.plan.id, sheetId: f.sheet.id, target,
      sheetSha256: pkg.applySqlSha256, packageDigest: pkg.validation.packageDigest, scopeDigest } }
  const request = { workflowKind: 'data-change', stage: 'execute-task', runId: 'run-1', generation: 1,
    requirementDigest: sha('requirement'), packageDigest: pkg.validation.packageDigest,
    applySqlSha256: pkg.applySqlSha256, target, approvalRequestId: requestId,
    intent: { project: 'projects/app', target, packageDigest: pkg.validation.packageDigest,
      applySqlSha256: pkg.applySqlSha256, issueId: f.issue.id, planId: f.plan.id, sheetId: f.sheet.id,
      approvalRequestId: requestId, approvalScopeDigest: scopeDigest, applySql,
      issueCreationOperationKey: f.issue.operationKey, executeOperationKey: operationKey, operationKey } }
  const receipt = { status: 'succeeded', result: { taskId: f.task.id } }
  const original = { issue: f.issue, sheet: f.sheet, plan: f.plan, task: { ...f.task, status: 'DONE' } }
  bundle = structuredClone(original)
  const digestBefore = f.workflowAdapter.rulesDigest
  const result = await f.workflowAdapter.readCompletion({ request, receipt, view })
  assert.equal(result.applySql, applySql)
  assert.equal(result.task.status, 'DONE')
  assert.equal(result.taskRun.status, 'DONE')
  assert.equal(result.production.passed, true)
  assert.deepEqual(result.production.verification.observation.rows, [{ relation_kind: 'r', column_exists: false, columns: [] }])
  assert.equal(f.workflowAdapter.rulesDigest, digestBefore)
  assert.equal(reads, 1)
  assert.deepEqual(f.calls, ['verify'])
  for (const change of [b => { b.sheet.sha256 = sha('different SQL') },
    b => { b.sheet.target.database = 'instances/prod/databases/other' },
    b => { b.issue.id = 'projects/app/issues/other' }, b => { b.plan.id = 'projects/app/plans/other' },
    b => { b.sheet.id = 'projects/app/sheets/other' }, b => { b.sheet.project = 'projects/other' },
    b => { b.issue.operationKey = sha('other creation') }, b => { b.issue.packageDigest = sha('other package') },
    b => { delete b.sheet.project }]) {
    bundle = structuredClone(original); change(bundle)
    await assert.rejects(f.workflowAdapter.readCompletion({ request, receipt, view }),
      { code: 'BYTEBASE_COMPLETION_IDENTITY_UNCONFIRMED' })
  }
  bundle = structuredClone(original); taskFailed = true
  await assert.rejects(f.workflowAdapter.readCompletion({ request, receipt, view }), { code: 'BYTEBASE_TASK_RUN_FAILED' })
  assert.deepEqual(f.calls, ['verify'])
})

function fixture(options = {}) {
  const calls = []
  let rehearsalResult = null
  let activated = false
  const issue = { id: 'projects/app/issues/i', project: 'projects/app', planId: 'projects/app/plans/p',
    packageDigest: pkg.validation.packageDigest,
    operationKey: '' }
  const sheet = { id: 'projects/app/sheets/s', project: 'projects/app', sha256: pkg.applySqlSha256, target }
  const plan = { id: issue.planId, project: 'projects/app', sheetId: sheet.id }
  const task = { id: 'projects/app/rollouts/r/stages/s/tasks/t', planId: plan.id, status: 'NOT_STARTED' }
  const api = {
    async getDatabase(args) { return { ...args.target, project: 'projects/app' } },
    async readBaseline(args) { calls.push('read-baseline'); return { project: args.project,
      target: args.target, snapshotId: args.target.environment === 'uat' ? 'uat-baseline-1' : 'baseline-1',
      sha256: args.target.environment === 'uat'
        ? sha('uat-data-snapshot') : pkg.baseline.sha256,
      schemaVersion: 'migration-42', schemaDigest: sha('shared-schema'),
      evidenceRef: 'bytebase-baseline-readback-1' } },
    async checkPreconditions(args) { calls.push('check-preconditions'); return { passed: true,
      target: args.target, sqlSha256: args.applySqlSha256, checkId: 'preconditions-1',
      baselineEvidenceRef: args.baseline.evidenceRef,
      schemaProofDigest: args.target.environment === 'uat' && options.uatSchemaProofDigest
        ? options.uatSchemaProofDigest : sha('table-proof') } },
    async validateSql(args) { calls.push('review'); return { passed: true, target: args.target,
      sqlSha256: args.sqlSha256, reviewId: 'review-1' } },
    async rehearseInUat(args) { calls.push('rehearse-uat'); rehearsalResult = { passed: true, uat: true,
      operationKey: args.operationKey,
      target: uatTarget, sourceTarget: args.sourceTarget,
      productionBaselineEvidenceRef: args.productionBaseline.evidenceRef,
      uatBaselineEvidenceRef: args.uatBaseline.evidenceRef,
      schemaVersion: args.uatBaseline.schemaVersion, schemaDigest: args.uatBaseline.schemaDigest,
      sqlSha256: args.applySqlSha256, taskRunId: 'uat-task-run-1',
      verificationReadbackId: 'uat-verification-1',
      packageDigest: args.packageDigest,
      observedChange: 'v=2', receiptId: 'uat-run-1' }; return rehearsalResult },
    async getUatRehearsalByOperationKey() { calls.push('read-rehearsal'); return rehearsalResult },
    async createIssueBundle(args) { calls.push('create-issue'); issue.operationKey = args.operationKey;
      return { issue, sheet, plan, task: null } },
    async getIssueBundle() { calls.push('read-issue'); return { issue, sheet, plan,
      task: activated ? task : null } },
    async activateRollout() { calls.push('activate-rollout'); activated = true;
      return { issue, sheet, plan, task } },
    async runTask() { calls.push('run-task'); return { taskId: task.id } },
    async getTaskExecution() { calls.push('read-task'); return { task: { ...task, status: 'DONE' },
      taskRun: { id: 'task-run-1', taskId: task.id, status: 'DONE' } } },
    async queryVerification(args) { calls.push('verify'); return { passed: true, target: args.target,
      packageDigest: pkg.validation.packageDigest, readbackId: 'readback-1', observedChange: 'v=2', observation: { rows: [{ relation_kind: 'r', column_exists: false, columns: [] }] } } },
    async findIssueByOperationKey() { calls.push('find-issue'); return options.issueVisible
      ? { issue, sheet, plan, task: null } : null },
  }
  const uatApi = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions', 'validateSql',
    'rehearseInUat', 'getUatRehearsalByOperationKey'].map(name => [name, api[name]]))
  const productionApi = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions']
    .map(name => [name, api[name]]))
  const approvalApi = { async getApproval(args) { calls.push('read-approval'); return {
    decision: 'approved', source: 'assistant', human: true, issueId: args.issueId,
    planId: args.planId, sheetId: args.sheetId,
    target: args.target, sheetSha256: args.sheetSha256,
    packageDigest: args.packageDigest, scopeDigest: args.scopeDigest,
    requestId: 'approval-1', decidedBy: 'reviewer' } } }
  return { ...createBytebaseDataChangePlatform({ config: options.config ?? config,
    api: { ...api, ...options.api }, productionApi: { ...productionApi, ...options.productionApi },
    uatApi: { ...uatApi, ...options.uatApi },
    approvalApi: { ...approvalApi, ...options.approvalApi } }), calls,
    issue, sheet, plan, task }
}

test('Bytebase 必须显式配置生产与 UAT 精确目标', () => {
  assert.throws(() => createBytebaseDataChangePlatform({ config: { ...config, targets: [] }, api: {} }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => fixture({ config: { ...config,
    targets: [{ project: 'projects/app', target }] } }),
  { code: 'BYTEBASE_TARGET_CONFIG_INVALID' })
  assert.throws(() => fixture({ productionApi: { readBaseline: undefined } }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  const f = fixture()
  assert.equal(f.workflowAdapter.id, 'bytebase')
})

test('候选基线只由受信 SQL 提取范围，错表回读及伪造包范围拒绝，复杂候选保持全库合同', async () => {
  const scopes = []
  let wrong = false
  const f = fixture({ api: { async getIssueApproval() {} }, productionApi: {
    async readBaseline(args) {
      scopes.push(args.scope)
      return { project: args.project, target: args.target, snapshotId: 'baseline-1', sha256: pkg.baseline.sha256,
        schemaVersion: 'migration-42', schemaDigest: sha('schema'), evidenceRef: 'read-only-proof',
        ...(args.scope === 'current' ? {} : { scope: wrong ? { schema: 'public', table: 'other' } : args.scope }) }
    } } })
  const sql = 'ALTER TABLE public.t ADD COLUMN name character varying;'
  const baseline = await f.workflowAdapter.readBaselineForCandidate({ target, applySql: sql })
  assert.deepEqual(baseline.scope, { schema: 'public', table: 't' })
  assert.deepEqual(scopes, [{ schema: 'public', table: 't' }])
  wrong = true
  await assert.rejects(f.workflowAdapter.readBaselineForCandidate({ target, applySql: sql }), { code: 'BYTEBASE_BASELINE_SCOPE_UNCONFIRMED' })
  await assert.rejects(f.workflowAdapter.validate({ ...packageBody, applySql: sql, applySqlSha256: sha(sql),
    baseline: { ...baseline, scope: { schema: 'public', table: 'other' } } }), { code: 'BYTEBASE_BASELINE_SCOPE_UNCONFIRMED' })
  const complex = await f.workflowAdapter.readBaselineForCandidate({ target, applySql })
  assert.equal(complex.scope, undefined)
  assert.equal(scopes.at(-1), 'current')
})

test('SQL Review 与 UAT 演练均核验精确摘要和同结构基线', async () => {
  const f = fixture()
  const validation = await f.workflowAdapter.validate({ ...packageBody,
    packageDigest: pkg.validation.packageDigest })
  assert.equal(validation.receiptId, 'review-1')
  const rehearsalIntent = await f.workflowAdapter.prepareRehearsal({ package: pkg })
  const request = { workflowKind: 'data-change', stage: 'rehearse-uat',
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
    target, intent: rehearsalIntent }
  const receipt = await f.externalAdapter.execute(request)
  const rehearsal = await f.workflowAdapter.readbackRehearsal({ package: pkg, request, receipt })
  assert.equal(rehearsal.uat, true)
  assert.ok(f.calls.includes('rehearse-uat'))
  assert.ok(f.calls.includes('read-rehearsal'))
  const bad = fixture({ uatApi: { async rehearseInUat(args) { return { passed: true, uat: true,
    operationKey: args.operationKey,
    target: args.sourceTarget, sourceTarget: args.sourceTarget,
    productionBaselineEvidenceRef: args.productionBaseline.evidenceRef,
    uatBaselineEvidenceRef: args.uatBaseline.evidenceRef,
    schemaVersion: args.uatBaseline.schemaVersion, schemaDigest: args.uatBaseline.schemaDigest,
    sqlSha256: args.applySqlSha256, taskRunId: 'uat-task-run-1',
    verificationReadbackId: 'uat-verification-1',
    packageDigest: args.packageDigest, receiptId: 'fake', observedChange: 'v=2' } } } })
  const badIntent = await bad.workflowAdapter.prepareRehearsal({ package: pkg })
  await assert.rejects(bad.externalAdapter.execute({ ...request, intent: badIntent }),
    { code: 'BYTEBASE_REHEARSAL_UNCONFIRMED' })
})

test('生产与 UAT 涉及表结构证明不同则拒绝演练', async () => {
  const f = fixture({ uatSchemaProofDigest: sha('different-table-proof') })
  await assert.rejects(f.workflowAdapter.prepareRehearsal({ package: pkg }),
    { code: 'BYTEBASE_UAT_SCHEMA_BASELINE_CHANGED' })
  assert.equal(f.calls.includes('rehearse-uat'), false)
})

test('Host 冻结的生产基线 SHA 与受信回读不符时，Review 与演练均不得开始', async () => {
  const f = fixture({ productionApi: { async readBaseline(args) { f.calls.push('read-baseline'); return {
    project: args.project, target: args.target, snapshotId: 'baseline-1',
    sha256: sha('different-live-baseline'), schemaVersion: 'migration-42',
    schemaDigest: sha('shared-schema'), evidenceRef: 'fresh-readback' } } } })
  await assert.rejects(f.workflowAdapter.validate({ ...packageBody,
    packageDigest: pkg.validation.packageDigest }), { code: 'BYTEBASE_BASELINE_UNCONFIRMED' })
  await assert.rejects(f.workflowAdapter.prepareRehearsal({ package: pkg }),
    { code: 'BYTEBASE_BASELINE_UNCONFIRMED' })
  assert.deepEqual(f.calls, ['read-baseline', 'read-baseline'])
})

test('工单创建、审批、执行和生产回查均依赖独立平台读回', async () => {
  const f = fixture({ issueVisible: true })
  const intent = await f.workflowAdapter.prepareIssue({ prepared, runId: 'run-1', generation: 1,
    requirementDigest: sha('requirement') })
  const request = { workflowKind: 'data-change', stage: 'create-issue', runId: 'run-1',
    generation: 1, requirementDigest: sha('requirement'), packageDigest: pkg.validation.packageDigest,
    applySqlSha256: pkg.applySqlSha256, target, intent }
  const receipt = await f.externalAdapter.execute(request)
  assert.equal(receipt.result.issueId, f.issue.id)
  const view = await f.workflowAdapter.readback({ stage: 'create-issue', request, receipt })
  assert.equal(view.task, undefined)
  const approvalIntent = await f.workflowAdapter.prepareApproval({ view: { ...view, prepared },
    runId: 'run-1', generation: 1, requirementDigest: sha('requirement') })
  const approvalRequest = { ...request, stage: 'approval-gate', intent: approvalIntent }
  const approvalReceipt = await f.externalAdapter.execute(approvalRequest)
  const approval = await f.workflowAdapter.inspect({ stage: 'approval', ...view, prepared,
    request: approvalRequest, receipt: approvalReceipt })
  assert.equal(approval.decision, 'approved')
  assert.equal(approval.source, 'assistant')
  const preflight = await f.workflowAdapter.inspect({ stage: 'pre-execution', ...view, prepared })
  assert.equal(preflight.plan.id, f.plan.id)
  const executionIntent = await f.workflowAdapter.prepareExecute({ identity: {
    target, planId: f.plan.id, sheetId: f.sheet.id,
    approvalRequestId: approval.requestId,
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
  }, issue: view.issue, approval, prepared })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    approvalRequestId: approval.requestId }
  const executionReceipt = await f.externalAdapter.execute(executionRequest)
  assert.equal(executionReceipt.result.taskId, f.task.id)
  const result = await f.workflowAdapter.readback({ stage: 'execute-task', request: executionRequest,
    receipt: executionReceipt, ...view, prepared })
  assert.equal(result.production.readbackId, 'readback-1')
  assert.ok(f.calls.indexOf('read-approval') < f.calls.indexOf('run-task'))
  assert.ok(f.calls.indexOf('read-approval') < f.calls.indexOf('activate-rollout'))
  assert.ok(f.calls.indexOf('check-preconditions') < f.calls.indexOf('run-task'))
  assert.ok(f.calls.indexOf('run-task') < f.calls.indexOf('verify'))
})

test('不明执行回执只独立对账，不重复提交工单或运行 Task', async () => {
  const f = fixture()
  const intent = await f.workflowAdapter.prepareIssue({ prepared, runId: 'run-1', generation: 1,
    requirementDigest: sha('requirement') })
  const request = { workflowKind: 'data-change', stage: 'create-issue', runId: 'run-1',
    generation: 1, requirementDigest: sha('requirement'), packageDigest: pkg.validation.packageDigest,
    applySqlSha256: pkg.applySqlSha256, target, intent }
  const result = await f.externalAdapter.reconcile(request)
  assert.equal(result.status, 'unknown')
  assert.deepEqual(f.calls, ['find-issue'])
})

test('未列入配置的目标和审批漂移均阻止外部执行', async () => {
  const f = fixture({ approvalApi: { async getApproval() { return { decision: 'pending' } } } })
  await assert.rejects(f.workflowAdapter.validate({ ...packageBody,
    target: { ...target, database: 'instances/prod/databases/other' },
    packageDigest: pkg.validation.packageDigest }), { code: 'BYTEBASE_TARGET_NOT_ALLOWED' })
  const intent = await f.workflowAdapter.prepareIssue({ prepared, runId: 'run-1', generation: 1,
    requirementDigest: sha('requirement') })
  const request = { workflowKind: 'data-change', stage: 'create-issue', runId: 'run-1',
    generation: 1, requirementDigest: sha('requirement'), packageDigest: pkg.validation.packageDigest,
    applySqlSha256: pkg.applySqlSha256, target, intent }
  await f.externalAdapter.execute(request)
  const approvalRequestId = 'approval-1'
  const executionIntent = await f.workflowAdapter.prepareExecute({ identity: {
    target, planId: f.plan.id, sheetId: f.sheet.id, approvalRequestId,
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
  }, issue: { id: f.issue.id }, approval: { decision: 'approved', source: 'assistant', human: true,
    issueId: f.issue.id, planId: f.plan.id, sheetId: f.sheet.id,
    target, sheetSha256: pkg.applySqlSha256,
    packageDigest: pkg.validation.packageDigest, scopeDigest: sha('scope'), requestId: approvalRequestId,
    decidedBy: 'reviewer' }, prepared })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    approvalRequestId }
  await assert.rejects(f.externalAdapter.execute(executionRequest), { code: 'BYTEBASE_APPROVAL_UNCONFIRMED' })
  assert.ok(!f.calls.includes('run-task'))
})

test('原生审批区分等待、SKIPPED 与真人决定，不调用 Assistant 审批', async () => {
  let decision = 'pending'
  const f = fixture({ api: { async getIssueApproval(args) { return { ...args, source: 'bytebase',
    decision, human: ['approved','rejected'].includes(decision), decidedBy: 'users/reviewer',
    requestId: 'projects/app/issues/i/issueComments/review-1', comment: '改名后重审', evidenceRef: 'approval-evidence' } } },
    approvalApi: { async getApproval() { throw Error('unexpected Assistant approval') } } })
  const view = { prepared, issue: { id: f.issue.id, planId: f.plan.id },
    sheet: { id: f.sheet.id, sha256: f.sheet.sha256, target }, plan: { id: f.plan.id, sheetId: f.sheet.id } }
  const intent = await f.workflowAdapter.prepareApproval({ view, runId: 'native', generation: 1, requirementDigest: sha('req') })
  const request = { workflowKind: 'data-change', stage: 'approval-gate', runId: 'native', generation: 1,
    requirementDigest: sha('req'), packageDigest: pkg.validation.packageDigest,
    applySqlSha256: pkg.applySqlSha256, target, intent }
  assert.equal((await f.externalAdapter.execute(request)).reason, 'BYTEBASE_APPROVAL_PENDING')
  decision = 'unconfigured'
  assert.equal((await f.externalAdapter.reconcile(request)).reason, 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED')
  decision = 'rejected'
  const rejected = await f.externalAdapter.reconcile(request)
  assert.equal(rejected.status, 'succeeded')
  assert.equal(rejected.result.approval.decision, 'rejected')
  decision = 'approved'
  assert.equal((await f.externalAdapter.reconcile(request)).result.approval.human, true)
  assert.equal(f.calls.includes('run-task'), false)
})

test('原生工单已有未执行Task仅独立回读接纳，任何TaskRun或已执行状态拒绝', async () => {
  for (const mode of ['unstarted', 'pending-run', 'done']) {
    let reads = 0
    const f = fixture({ api: { async getIssueApproval() {},
      async getIssueBundle() { return { issue: f.issue, sheet: f.sheet, plan: f.plan,
        task: { ...f.task, status: mode === 'done' ? 'DONE' : 'NOT_STARTED' } } },
      async getTaskExecution() { reads++; return { task: { ...f.task, status: mode === 'done' ? 'DONE' : 'NOT_STARTED' },
        taskRun: mode === 'pending-run' ? { id: 'run', taskId: f.task.id, status: 'PENDING' } : null } } } })
    const identity = { runId: 'run', generation: 1, requirementDigest: sha('requirement') }
    const intent = await f.workflowAdapter.prepareIssue({ prepared, ...identity })
    f.issue.operationKey = intent.operationKey
    const request = { ...identity, action: 'external', workflowKind: 'data-change', stage: 'create-issue',
      target, packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256, intent }
    const read = f.workflowAdapter.readback({ stage: 'create-issue', request, receipt: { status: 'succeeded', result: { issueId: f.issue.id } } })
    if (mode === 'unstarted') { const view = await read; assert.equal(view.issue.id, f.issue.id); assert.equal(view.task, undefined); assert.equal(reads, 1) }
    else await assert.rejects(read, { code: 'BYTEBASE_PREAPPROVAL_EXECUTION_DETECTED' })
    assert.ok(!f.calls.includes('run-task'))
  }
})

test('简单加列仅做生产只读前置核对，其他 SQL 继续演练', async () => {
  const f = fixture({ config: { ...config, targets: [{ project: 'projects/app', target }] },
    api: { async getIssueApproval() {} }, uatApi: { getDatabase: undefined, readBaseline: undefined,
      checkPreconditions: undefined, validateSql: undefined, rehearseInUat: undefined, getUatRehearsalByOperationKey: undefined } })
  for (const sql of ['ALTER TABLE public.t ADD COLUMN name character varying;',
    'ALTER TABLE public.other_table ADD COLUMN display_name text;']) {
    const body = { ...packageBody, applySql: sql, applySqlSha256: sha(sql) }
    const result = await f.workflowAdapter.validate({ ...body, packageDigest: executionDigest(body) })
    assert.equal(result.passed, true)
    assert.equal(f.workflowAdapter.requiresRehearsal(body), false)
  }
  for (const sql of ['ALTER TABLE public.t ADD COLUMN name text NOT NULL;',
    "ALTER TABLE public.t ADD COLUMN name text DEFAULT '';", 'UPDATE public.t SET v=2;',
    'ALTER TABLE public.t ADD COLUMN name text; DROP TABLE public.t;', 'ALTER TABLE public.t DROP COLUMN name;', 'ALTER TABLE public.t DROP COLUMN name CASCADE;',
    'ALTER TABLE public.t DROP COLUMN IF EXISTS name;', 'ALTER TABLE public.t DROP COLUMN name; DROP TABLE public.t;']) {
    assert.equal(f.workflowAdapter.requiresRehearsal({ applySql: sql }), true)
  }
  assert.equal(f.calls.includes('review'), false)
  assert.equal(f.calls.includes('rehearse-uat'), false)
})
