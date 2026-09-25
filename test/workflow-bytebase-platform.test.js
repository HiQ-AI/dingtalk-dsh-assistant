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
  verificationSql: 'SELECT v FROM public.t WHERE id = 1;', expectedChange: 'v=2' }
const pkg = { ...packageBody, validation: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'review-1', packageDigest: executionDigest(packageBody) } }
const prepared = { package: pkg, rehearsal: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'uat-run-1', packageDigest: pkg.validation.packageDigest,
  uat: true, passed: true, observedChange: 'v=2' } }

function fixture(options = {}) {
  const calls = []
  let rehearsalResult = null
  const issue = { id: 'projects/app/issues/i', project: 'projects/app', planId: 'projects/app/plans/p',
    taskId: 'projects/app/rollouts/r/stages/s/tasks/t', packageDigest: pkg.validation.packageDigest,
    operationKey: '' }
  const sheet = { id: 'projects/app/sheets/s', project: 'projects/app', sha256: pkg.applySqlSha256, target }
  const plan = { id: issue.planId, project: 'projects/app', sheetId: sheet.id }
  const task = { id: issue.taskId, planId: plan.id, status: 'NOT_STARTED' }
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
      baselineEvidenceRef: args.baseline.evidenceRef } },
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
      return { issue, sheet, plan, task } },
    async getIssueBundle() { calls.push('read-issue'); return { issue, sheet, plan, task } },
    async runTask() { calls.push('run-task'); return { taskId: task.id } },
    async getTaskExecution() { calls.push('read-task'); return { task: { ...task, status: 'DONE' },
      taskRun: { id: 'task-run-1', taskId: task.id, status: 'DONE' } } },
    async queryVerification(args) { calls.push('verify'); return { passed: true, target: args.target,
      packageDigest: pkg.validation.packageDigest, readbackId: 'readback-1', observedChange: 'v=2' } },
    async findIssueByOperationKey() { calls.push('find-issue'); return options.issueVisible ? { issue, sheet, plan, task } : null },
  }
  const uatApi = Object.fromEntries(['getDatabase', 'readBaseline', 'checkPreconditions',
    'rehearseInUat', 'getUatRehearsalByOperationKey'].map(name => [name, api[name]]))
  const approvalApi = { async getApproval(args) { calls.push('read-approval'); return {
    decision: 'approved', source: 'assistant', human: true, issueId: args.issueId,
    taskId: args.taskId, target: args.target, sheetSha256: args.sheetSha256,
    packageDigest: args.packageDigest, scopeDigest: args.scopeDigest,
    requestId: 'approval-1', decidedBy: 'reviewer' } } }
  return { ...createBytebaseDataChangePlatform({ config: options.config ?? config,
    api: { ...api, ...options.api }, uatApi: { ...uatApi, ...options.uatApi },
    approvalApi: { ...approvalApi, ...options.approvalApi } }), calls,
    issue, sheet, plan, task }
}

test('Bytebase 必须显式配置生产与 UAT 精确目标', () => {
  assert.throws(() => createBytebaseDataChangePlatform({ config: { ...config, targets: [] }, api: {} }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => fixture({ config: { ...config,
    targets: [{ project: 'projects/app', target }] } }),
  { code: 'BYTEBASE_TARGET_CONFIG_INVALID' })
  assert.throws(() => fixture({ api: { readBaseline: undefined } }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  const f = fixture()
  assert.equal(f.workflowAdapter.id, 'bytebase')
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

test('Host 冻结的生产基线 SHA 与受信回读不符时，Review 与演练均不得开始', async () => {
  const f = fixture({ api: { async readBaseline(args) { f.calls.push('read-baseline'); return {
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
  assert.equal(view.task.status, 'NOT_STARTED')
  const approvalIntent = await f.workflowAdapter.prepareApproval({ view: { ...view, prepared },
    runId: 'run-1', generation: 1, requirementDigest: sha('requirement') })
  const approvalRequest = { ...request, stage: 'approval-gate', intent: approvalIntent,
    taskId: f.task.id }
  const approvalReceipt = await f.externalAdapter.execute(approvalRequest)
  const approval = await f.workflowAdapter.inspect({ stage: 'approval', ...view, prepared,
    request: approvalRequest, receipt: approvalReceipt })
  assert.equal(approval.decision, 'approved')
  assert.equal(approval.source, 'assistant')
  const preflight = await f.workflowAdapter.inspect({ stage: 'pre-execution', ...view, prepared })
  assert.equal(preflight.task.id, f.task.id)
  const executionIntent = await f.workflowAdapter.prepareExecute({ identity: {
    target, taskId: f.task.id, approvalRequestId: approval.requestId,
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
  }, issue: view.issue, approval, prepared })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    taskId: f.task.id, approvalRequestId: approval.requestId }
  const executionReceipt = await f.externalAdapter.execute(executionRequest)
  assert.equal(executionReceipt.result.taskId, f.task.id)
  const result = await f.workflowAdapter.readback({ stage: 'execute-task', request: executionRequest,
    receipt: executionReceipt, ...view, prepared })
  assert.equal(result.production.readbackId, 'readback-1')
  assert.ok(f.calls.indexOf('read-approval') < f.calls.indexOf('run-task'))
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
    target, taskId: f.task.id, approvalRequestId,
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
  }, issue: { id: f.issue.id }, approval: { decision: 'approved', source: 'assistant', human: true,
    issueId: f.issue.id, target, taskId: f.task.id, sheetSha256: pkg.applySqlSha256,
    packageDigest: pkg.validation.packageDigest, scopeDigest: sha('scope'), requestId: approvalRequestId,
    decidedBy: 'reviewer' }, prepared })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    taskId: f.task.id, approvalRequestId }
  await assert.rejects(f.externalAdapter.execute(executionRequest), { code: 'BYTEBASE_APPROVAL_UNCONFIRMED' })
  assert.ok(!f.calls.includes('run-task'))
})
