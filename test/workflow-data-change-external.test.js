import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createDataChangeTaskWorkflow } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const sql = 'BEGIN; UPDATE t SET v=2 WHERE id=1 AND v=1; COMMIT;'
const target = { instance: 'prod', database: 'app', environment: 'production' }
const input = () => ({ request: '更新一条记录', constraints: [], target, baseline: { snapshotId: 'baseline-1', sha256: sha('baseline') },
  sources: [{ id: 'change.csv', content: 'id,v\n1,2', sha256: sha('id,v\n1,2') }] })
const proposal = { applySql: sql, rollbackSql: 'BEGIN; UPDATE t SET v=1 WHERE id=1 AND v=2; COMMIT;',
  verificationSql: 'SELECT v FROM t WHERE id=1;', expectedChange: '仅 id=1 的 v 从 1 变成 2' }

async function fixture(t, { unknownExecution = false, unknownRehearsal = false,
  driftPreflight = false, driftIssue = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-data-external-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'data-external', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const sends = [], reconciles = []
  let rehearsalObserved = false, createdPackageDigest = null
  const sheet = { id: 'sheet-1', sha256: sha(sql), target }, plan = { id: 'plan-1', sheetId: 'sheet-1' }
  const task = { id: 'task-1', planId: 'plan-1', status: 'NOT_STARTED' }, issue = { id: 'issue-1', planId: 'plan-1', taskId: 'task-1' }
  const adapter = {
    id: 'synthetic-bytebase', version: '1', rulesDigest: sha('synthetic-bytebase-v1'),
    async validate(args) { return { passed: true, packageDigest: args.packageDigest, receiptId: 'validate-1' } },
    async rehearse(args) { return { passed: true, uat: true, packageDigest: args.package.validation.packageDigest,
      receiptId: 'rehearse-1', observedChange: 'one row only' } },
    async prepareRehearsal(args) { return { packageDigest: args.package.validation.packageDigest,
      applySqlSha256: args.package.applySqlSha256, target, operationKey: 'uat-rehearsal-1' } },
    async readbackRehearsal(args) { assert.equal(args.receipt.result.receiptId, 'uat-rehearsal-1')
      return { passed: true, uat: true, packageDigest: args.package.validation.packageDigest,
        receiptId: 'uat-rehearsal-1', observedChange: 'one row only' } },
    async prepareIssue(args) { createdPackageDigest = args.prepared.package.validation.packageDigest; return { sheetSha256: sha(sql), packageDigest: createdPackageDigest } },
    async prepareApproval(args) { return { issueId: args.view.issue.id, taskId: args.view.task.id,
      scopeDigest: sha('scope'), operationKey: sha('approval-operation') } },
    async prepareExecute(args) { return { taskId: args.identity.taskId, approvalRequestId: args.identity.approvalRequestId,
      packageDigest: args.identity.packageDigest } },
    async inspect(args) {
      if (args.stage === 'approval') return { decision: 'approved', source: 'assistant', human: true,
        issueId: issue.id, target, taskId: task.id, sheetSha256: sheet.sha256,
        packageDigest: createdPackageDigest, scopeDigest: sha('scope'),
        requestId: 'approval-gate', decidedBy: 'owner' }
      if (args.stage === 'pre-execution') return { sheet: driftPreflight ? { ...sheet, sha256: sha('altered') } : sheet, plan, task }
      throw Error('unexpected inspection')
    },
    async readback(args) {
      if (args.stage === 'create-issue') { assert.equal(args.receipt.result.issueId, issue.id); return { issue, sheet: driftIssue ? { ...sheet, sha256: sha('altered') } : sheet, plan, task } }
      if (args.stage === 'execute-task') return { task: { ...task, status: 'DONE' }, taskRun: { id: 'task-run-1', taskId: task.id, status: 'DONE' },
        production: { passed: true, target, packageDigest: createdPackageDigest, readbackId: 'production-readback-1', observedChange: 'id=1 has v=2' } }
      throw Error('unexpected readback')
    },
  }
  const externalAdapter = {
    async execute(prepared) {
      sends.push(prepared.stage)
      if (prepared.stage === 'rehearse-uat') {
        if (unknownRehearsal) throw new Error('uat acknowledgement lost')
        return { status: 'succeeded', result: { receiptId: 'uat-rehearsal-1' } }
      }
      if (prepared.stage === 'create-issue') return { status: 'succeeded', result: { issueId: issue.id } }
      if (prepared.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: prepared.intent.scopeDigest,
          operationKey: prepared.intent.operationKey } }
      if (prepared.stage === 'execute-task' && unknownExecution) throw new Error('ack lost')
      if (prepared.stage === 'execute-task') return { status: 'succeeded', result: { taskId: task.id } }
      throw Error('unexpected stage')
    },
    async reconcile(prepared) {
      reconciles.push(prepared.stage)
      if (prepared.stage === 'rehearse-uat') return rehearsalObserved
        ? { status: 'succeeded', result: { receiptId: 'uat-rehearsal-1' } }
        : { status: 'unknown', reason: 'uat_run_not_observed' }
      return prepared.stage === 'execute-task' && unknownExecution
        ? { status: 'succeeded', result: { taskId: task.id } } : { status: 'unknown', reason: 'not_observed' }
    },
  }
  const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => ({ principalId: 'owner', authorizationRef: 'unused' }),
    externalAdapter, authorizeExternal: async ({ prepared }) => {
      if (prepared.stage === 'rehearse-uat') return { principalId: 'owner', authorizationRef: 'uat-rehearsal-specific' }
      if (prepared.stage === 'create-issue') return { principalId: 'owner', authorizationRef: 'issue-submission-specific' }
      if (prepared.stage === 'approval-gate') return { principalId: 'owner',
        approval: { requestId: 'approval-gate', approverIds: ['owner'] } }
      assert.equal(prepared.taskId, 'task-1')
      assert.equal(prepared.approvalRequestId, 'approval-gate')
      return { principalId: 'owner', authorizationRef: 'production-task-specific' }
    },
  })
  const sessions = { async run({ onSessionBound, onResult }) { await onSessionBound(); onResult(proposal) }, async cancel() {}, async close() {} }
  const workflow = createDataChangeTaskWorkflow({ provider: 'test', model: 'synthetic', adapter })
  assert.equal(defineExecutionWorkflow(workflow).nodes.length, 15)
  const controller = createExecutionController({ store, artifacts, sessions, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  return { store, artifacts, controller, delivery, workflow, sends, reconciles,
    observeRehearsal() { rehearsalObserved = true } }
}

test('UAT 演练未知回执进入效果账等待，对账成功后同一 Run 继续且不重发', async t => {
  const f = await fixture(t, { unknownRehearsal: true })
  await f.controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task',
    workflowId: f.workflow.id, input: input() })
  let state = await f.controller.whenIdle('run')
  assert.equal(state.nodes[4].waitReason?.reference, 'DELIVERY_RECONCILIATION_REQUIRED')
  assert.deepEqual(f.sends, ['rehearse-uat'])
  const effect = (await f.store.query({ kind: 'effect.list', runId: 'run' }))
    .find(item => item.definition?.payload?.stage === 'rehearse-uat')
  assert.ok(effect)
  assert.equal((await f.delivery.reconcile(effect.effectId)).state, 'unknown')
  assert.deepEqual(f.sends, ['rehearse-uat'])
  f.observeRehearsal()
  assert.equal((await f.delivery.reconcile(effect.effectId)).state, 'succeeded')
  await f.controller.recover({ commandId: 'rehearsal-observed', runId: 'run' })
  state = await f.controller.whenIdle('run')
  assert.equal(state.nodes[10].waitReason?.reference, 'effect_approval_required')
  assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue'])
})

for (const unknownExecution of [false, true]) test(`数据变更受控链：工单独立回读、审批前零生产发送、生产回查${unknownExecution ? '及未知回执不重放' : ''}`, async t => {
  const f = await fixture(t, { unknownExecution })
  await f.controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: f.workflow.id, input: input() })
  let state = await f.controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes[10].waitReason?.reference, 'effect_approval_required', JSON.stringify(state.nodes.map(node => [node.nodeId, node.status, node.waitReason])))
  assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue'])
  await f.store.command({ id: 'approve-execute', kind: 'approval.decide', args: {
    requestId: 'approval-gate', actorId: 'owner', source: 'web', decision: 'approved',
  } })
  await f.controller.recover({ commandId: 'recover-effect', runId: 'run' })
  state = await f.controller.whenIdle('run')
  if (unknownExecution) {
    assert.equal(state.nodes[13].waitReason?.reference, 'DELIVERY_RECONCILIATION_REQUIRED')
    assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue', 'approval-gate', 'execute-task'])
    const effect = (await f.store.query({ kind: 'effect.list', runId: 'run' })).find(item => item.definition?.payload?.stage === 'execute-task')
    assert.ok(effect)
    assert.equal((await f.delivery.reconcile(effect.effectId)).state, 'succeeded')
    await f.controller.recover({ commandId: 'reconcile-effect', runId: 'run' })
    state = await f.controller.whenIdle('run')
  }
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(node => [node.nodeId, node.waitReason])))
  assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue', 'approval-gate', 'execute-task'])
  if (unknownExecution) assert.deepEqual(f.reconciles, ['execute-task'])
  const result = await f.artifacts.read(state.nodes.at(-1).outputRef)
  assert.equal(result.taskRunId, 'task-run-1')
  assert.equal(result.productionReadbackId, 'production-readback-1')
})

test('数据变更工单或执行适配器缺失时拒绝注册', () => {
  assert.throws(() => createDataChangeTaskWorkflow({ provider: 'test', model: 'test', adapter: {} }), { code: 'DATA_CHANGE_EXTERNAL_ADAPTER_REQUIRED' })
})

test('工单 Sheet 内容漂移阻止审批及生产发送', async t => {
  const f = await fixture(t, { driftIssue: true })
  await f.controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: f.workflow.id, input: input() })
  const state = await f.controller.whenIdle('run')
  assert.equal(state.nodes[8].waitReason?.reference, 'DATA_CHANGE_ISSUE_READBACK_UNCONFIRMED')
  assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue'])
})

test('审批后执行前 Sheet 漂移阻止生产发送', async t => {
  const f = await fixture(t, { driftPreflight: true })
  await f.controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: f.workflow.id, input: input() })
  await f.controller.whenIdle('run')
  await f.store.command({ id: 'approve-gate', kind: 'approval.decide', args: {
    requestId: 'approval-gate', actorId: 'owner', source: 'web', decision: 'approved',
  } })
  await f.controller.recover({ commandId: 'recover-approval', runId: 'run' })
  const state = await f.controller.whenIdle('run')
  assert.equal(state.nodes[12].waitReason?.reference, 'DATA_CHANGE_PREFLIGHT_CHANGED')
  assert.deepEqual(f.sends, ['rehearse-uat', 'create-issue', 'approval-gate'])
})
