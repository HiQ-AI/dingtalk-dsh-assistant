import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createBytebaseDataChangePlatform } from '../packages/dingtalk-dsh-assistant/workflow-bytebase-platform.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const target = { instance: 'instances/prod', database: 'instances/prod/databases/app', environment: 'production' }
const isolated = { instance: 'instances/isolated', database: 'instances/isolated/databases/app', environment: 'isolated' }
const config = { adapterId: 'bytebase', adapterVersion: '1', targets: [{ project: 'projects/app', target,
  isolation: { target: isolated, proofRef: 'clone-evidence-1' } }] }
const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1 AND v = 1;'
const packageBody = { target, baseline: { snapshotId: 'baseline-1', sha256: sha('baseline') },
  sourceDigest: sha('source'), applySql, applySqlSha256: sha(applySql),
  rollbackSql: 'UPDATE public.t SET v = 1 WHERE id = 1 AND v = 2;',
  verificationSql: 'SELECT v FROM public.t WHERE id = 1;', expectedChange: 'v=2' }
const pkg = { ...packageBody, validation: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'review-1', packageDigest: executionDigest(packageBody) } }
const prepared = { package: pkg, rehearsal: { adapterId: 'bytebase', adapterVersion: '1',
  receiptId: 'isolated-run-1', packageDigest: pkg.validation.packageDigest,
  isolated: true, passed: true, observedChange: 'v=2' } }

function fixture(options = {}) {
  const calls = []
  const issue = { id: 'projects/app/issues/i', project: 'projects/app', planId: 'projects/app/plans/p',
    taskId: 'projects/app/rollouts/r/stages/s/tasks/t', packageDigest: pkg.validation.packageDigest,
    operationKey: '' }
  const sheet = { id: 'projects/app/sheets/s', project: 'projects/app', sha256: pkg.applySqlSha256, target }
  const plan = { id: issue.planId, project: 'projects/app', sheetId: sheet.id }
  const task = { id: issue.taskId, planId: plan.id, status: 'NOT_STARTED' }
  const api = {
    async getDatabase() { return { ...target, project: 'projects/app' } },
    async validateSql(args) { calls.push('review'); return { passed: true, target: args.target,
      sqlSha256: args.sqlSha256, reviewId: 'review-1' } },
    async rehearseIsolated(args) { calls.push('rehearse'); return { passed: true, isolated: true,
      target: args.target, baselineSha256: args.baseline.sha256,
      isolationProofRef: args.isolationProofRef, packageDigest: args.packageDigest,
      observedChange: 'v=2', receiptId: 'isolated-run-1' } },
    async createIssueBundle(args) { calls.push('create-issue'); issue.operationKey = args.operationKey;
      return { issue, sheet, plan, task } },
    async getIssueBundle() { calls.push('read-issue'); return { issue, sheet, plan, task } },
    async getApproval() { calls.push('read-approval'); return { decision: 'approved', taskId: task.id,
      sheetSha256: sheet.sha256, packageDigest: pkg.validation.packageDigest,
      requestId: 'approval-1', decidedBy: 'reviewer' } },
    async runTask() { calls.push('run-task'); return { taskId: task.id } },
    async getTaskExecution() { calls.push('read-task'); return { task: { ...task, status: 'DONE' },
      taskRun: { id: 'task-run-1', taskId: task.id, status: 'DONE' } } },
    async queryVerification(args) { calls.push('verify'); return { passed: true, target: args.target,
      packageDigest: pkg.validation.packageDigest, readbackId: 'readback-1', observedChange: 'v=2' } },
    async findIssueByOperationKey() { calls.push('find-issue'); return options.issueVisible ? { issue, sheet, plan, task } : null },
  }
  return { ...createBytebaseDataChangePlatform({ config, api: { ...api, ...options.api } }), calls,
    issue, sheet, plan, task }
}

test('Bytebase 必须显式配置真实目标、隔离副本和完整平台端口', () => {
  assert.throws(() => createBytebaseDataChangePlatform({ config: { ...config, targets: [] }, api: {} }),
    { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  assert.throws(() => createBytebaseDataChangePlatform({ config: { ...config,
    targets: [{ ...config.targets[0], isolation: null }] }, api: {} }),
  { code: 'BYTEBASE_PLATFORM_NOT_CONFIGURED' })
  const f = fixture()
  assert.equal(f.workflowAdapter.id, 'bytebase')
})

test('SQL Review 与隔离演练均核验精确摘要和隔离证据', async () => {
  const f = fixture()
  const validation = await f.workflowAdapter.validate({ ...packageBody,
    packageDigest: pkg.validation.packageDigest })
  assert.equal(validation.receiptId, 'review-1')
  const rehearsal = await f.workflowAdapter.rehearse({ package: pkg })
  assert.equal(rehearsal.isolated, true)
  assert.deepEqual(f.calls, ['review', 'rehearse'])
  const bad = fixture({ api: { async rehearseIsolated(args) { return { passed: true, isolated: true,
    target: args.target, packageDigest: args.packageDigest, baselineSha256: args.baseline.sha256,
    isolationProofRef: 'other', receiptId: 'fake', observedChange: 'v=2' } } } })
  await assert.rejects(bad.workflowAdapter.rehearse({ package: pkg }),
    { code: 'BYTEBASE_REHEARSAL_UNCONFIRMED' })
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
  const approval = await f.workflowAdapter.inspect({ stage: 'approval', ...view, prepared })
  assert.equal(approval.decision, 'approved')
  const preflight = await f.workflowAdapter.inspect({ stage: 'pre-execution', ...view, prepared })
  assert.equal(preflight.task.id, f.task.id)
  const executionIntent = await f.workflowAdapter.prepareExecute({ identity: {
    target, taskId: f.task.id, approvalRequestId: approval.requestId,
    packageDigest: pkg.validation.packageDigest, applySqlSha256: pkg.applySqlSha256,
  }, issue: view.issue, approval })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    taskId: f.task.id, approvalRequestId: approval.requestId }
  const executionReceipt = await f.externalAdapter.execute(executionRequest)
  assert.equal(executionReceipt.result.taskId, f.task.id)
  const result = await f.workflowAdapter.readback({ stage: 'execute-task', request: executionRequest,
    receipt: executionReceipt, ...view, prepared })
  assert.equal(result.production.readbackId, 'readback-1')
  assert.deepEqual(f.calls, ['create-issue', 'read-issue', 'read-approval', 'read-issue',
    'read-issue', 'read-approval', 'run-task', 'read-task', 'verify'])
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
  const f = fixture({ api: { async getApproval() { return { decision: 'pending' } } } })
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
  }, issue: { id: f.issue.id }, approval: { decision: 'approved', requestId: approvalRequestId } })
  const executionRequest = { ...request, stage: 'execute-task', intent: executionIntent,
    taskId: f.task.id, approvalRequestId }
  await assert.rejects(f.externalAdapter.execute(executionRequest), { code: 'BYTEBASE_APPROVAL_CHANGED' })
  assert.ok(!f.calls.includes('run-task'))
})
