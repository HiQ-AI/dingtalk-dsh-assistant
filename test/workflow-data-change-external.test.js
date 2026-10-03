import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { createAgentQueryTools } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExternalStageContracts, nativeDataChangeOwnerContract } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { createDataChangeTaskWorkflow, createDataChangeTaskWorkflowV6, createDataChangeTaskWorkflowV4, simpleNullableColumnDefinition } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { createProductionPostgresHost } from '../packages/dingtalk-dsh-assistant/workflow-postgres-production-host.js'
import { createPlatformClients } from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'
import { uatCatalogBaselineSql, uatCatalogBaselineCountSql } from '../packages/dingtalk-dsh-assistant/workflow-postgres-uat-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const sql = 'BEGIN; UPDATE t SET v=2 WHERE id=1 AND v=1; COMMIT;'
const target = { instance: 'prod', database: 'app', environment: 'production' }
const input = () => ({ request: '更新一条记录', constraints: [], target, baseline: { snapshotId: 'baseline-1', sha256: sha('baseline') },
  sources: [{ id: 'change.csv', content: 'id,v\n1,2', sha256: sha('id,v\n1,2') }] })
const proposal = { applySql: sql, rollbackSql: 'BEGIN; UPDATE t SET v=1 WHERE id=1 AND v=2; COMMIT;',
  verificationSql: 'SELECT v FROM t WHERE id=1;', expectedChange: '仅 id=1 的 v 从 1 变成 2' }

async function fixture(t, { unknownExecution = false, unknownRehearsal = false,
  driftPreflight = false, driftIssue = false, prematureTask = false, native = false, simpleSql = 'ALTER TABLE public.t ADD COLUMN name character varying;' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-data-external-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'data-external', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const sends = [], reconciles = [], issuePreparations = []
  const fixtureSql = native ? simpleSql : sql
  const column = native ? simpleNullableColumnDefinition(fixtureSql) : null
  const nativeProposal = column ? {
    verificationSql: `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema='${column.schema}' AND table_name='${column.table}' AND column_name='${column.column}';`,
    expectedChange: JSON.stringify({ rows: [{ column_name: column.column,
      data_type: /^(?:varchar|character varying)/.test(column.type) ? 'character varying' : column.type, is_nullable: 'YES', column_default: null,
      character_maximum_length: column.type.includes('(') ? Number(column.type.match(/\d+/)[0]) : null }] }),
  } : {}
  let approvalDecision = 'pending'
  const nativeReceipt = prepared => ({ status: approvalDecision === 'pending' ? 'unknown' : 'succeeded',
    ...(approvalDecision === 'pending' ? { reason: 'BYTEBASE_APPROVAL_PENDING' } : {}),
    result: { scopeDigest: prepared.intent.scopeDigest, operationKey: prepared.intent.operationKey } })
  let rehearsalObserved = false, createdPackageDigest = null
  const sheet = { id: 'sheet-1', sha256: sha(fixtureSql), target }, plan = { id: 'plan-1', sheetId: 'sheet-1' }
  const task = { id: 'task-1', planId: 'plan-1', status: 'NOT_STARTED' }, issue = { id: 'issue-1', planId: 'plan-1' }
  const adapter = {
    nativeApproval: native, requiresRehearsal: () => !native,
    id: 'synthetic-bytebase', version: '1', rulesDigest: sha('synthetic-bytebase-v1'),
    async readBaselineForCandidate() { return input().baseline },
    async validate(args) { return { passed: true, packageDigest: args.packageDigest, receiptId: 'validate-1' } },
    async rehearse(args) { return { passed: true, uat: true, packageDigest: args.package.validation.packageDigest,
      receiptId: 'rehearse-1', observedChange: 'one row only' } },
    async prepareRehearsal(args) { return { packageDigest: args.package.validation.packageDigest,
      applySqlSha256: args.package.applySqlSha256, target, operationKey: 'uat-rehearsal-1' } },
    async readbackRehearsal(args) { assert.equal(args.receipt.result.receiptId, 'uat-rehearsal-1')
      return { passed: true, uat: true, packageDigest: args.package.validation.packageDigest,
        receiptId: 'uat-rehearsal-1', observedChange: 'one row only' } },
    async prepareIssue(args) { issuePreparations.push(args); createdPackageDigest = args.prepared.package.validation.packageDigest; return { sheetSha256: sha(fixtureSql), packageDigest: createdPackageDigest } },
    async prepareApproval(args) { return { issueId: args.view.issue.id,
      planId: args.view.plan.id, sheetId: args.view.sheet.id,
      scopeDigest: sha('scope'), operationKey: sha('approval-operation') } },
    async prepareExecute(args) { return { issueId: args.identity.issueId,
      approvalRequestId: args.identity.approvalRequestId,
      packageDigest: args.identity.packageDigest } },
    async inspect(args) {
      if (args.stage === 'approval-state') return { decision: approvalDecision }
      if (args.stage === 'approval') return { decision: native ? approvalDecision : 'approved', source: native ? 'bytebase' : 'assistant', human: true,
        ...(native ? { comment: '字段名改为 display_name', evidenceRef: 'bytebase-comment-1' } : {}),
        issueId: issue.id, planId: plan.id, sheetId: sheet.id, target,
        sheetSha256: sheet.sha256,
        packageDigest: createdPackageDigest, scopeDigest: sha('scope'),
        requestId: 'approval-gate', decidedBy: 'owner' }
      if (args.stage === 'pre-execution') return { sheet: driftPreflight ? { ...sheet, sha256: sha('altered') } : sheet, plan }
      throw Error('unexpected inspection')
    },
    async readback(args) {
      if (args.stage === 'create-issue') { assert.equal(args.receipt.result.issueId, issue.id); return {
        issue: prematureTask ? { ...issue, taskId: task.id } : issue,
        sheet: driftIssue ? { ...sheet, sha256: sha('altered') } : sheet,
        plan, ...(prematureTask ? { task } : {}) } }
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
      if (prepared.stage === 'approval-gate' && native) return nativeReceipt(prepared)
      if (prepared.stage === 'approval-gate') return { status: 'succeeded',
        result: { scopeDigest: prepared.intent.scopeDigest,
          operationKey: prepared.intent.operationKey } }
      if (prepared.stage === 'execute-task' && unknownExecution) throw new Error('ack lost')
      if (prepared.stage === 'execute-task') return { status: 'succeeded', result: { taskId: task.id } }
      throw Error('unexpected stage')
    },
    async reconcile(prepared) {
      reconciles.push(prepared.stage)
      if (prepared.stage === 'approval-gate' && native) return nativeReceipt(prepared)
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
      if (prepared.stage === 'approval-gate' && native) return { principalId: 'owner', authorizationRef: 'native-bytebase-read' }
      if (prepared.stage === 'approval-gate') return { principalId: 'owner',
        approval: { requestId: 'approval-gate', approverIds: ['owner'] } }
      assert.equal(prepared.taskId, undefined)
      assert.equal(prepared.approvalRequestId, 'approval-gate')
      return { principalId: 'owner', authorizationRef: 'production-task-specific' }
    },
  })
  const sessions = { async run({ onSessionBound, onResult }) { await onSessionBound(); onResult({ ...proposal, ...nativeProposal, applySql: fixtureSql }) }, async cancel() {}, async close() {} }
  t.after(async () => { await store.close() })
  const workflow = createDataChangeTaskWorkflow({ provider: 'test', model: 'synthetic', adapter })
  assert.equal(defineExecutionWorkflow(workflow).nodes.length, 15)
  const controller = createExecutionController({ store, artifacts, sessions, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  return { store, artifacts, controller, delivery, workflow, adapter, sessions, sends, reconciles, issuePreparations,
    observeRehearsal() { rehearsalObserved = true }, setApproval(value) { approvalDecision = value } }
}

test('持久 v4 原生待审 Run 使用冻结定义恢复，v5 新定义不改其必填基线合同', async t => {
  const f = await fixture(t, { native: true })
  await f.controller.close()
  const legacy = createDataChangeTaskWorkflowV4({ provider: 'test', model: 'synthetic', adapter: f.adapter })
  const definition = defineExecutionWorkflow(legacy)
  assert.equal(legacy.version, '4')
  assert.ok(legacy.nodes[0].inputSchema.required.includes('baseline'))
  const historicalController = createExecutionController({ store: f.store, artifacts: f.artifacts,
    sessions: f.sessions, delivery: f.delivery, workflows: [legacy] })
  await historicalController.createRun({ commandId: 'create-v4', runId: 'historical-v4', taskId: 'task-v4',
    workflowId: legacy.id, input: input() })
  assert.equal((await historicalController.whenIdle('historical-v4')).nodes[10].waitReason.reference, 'BYTEBASE_APPROVAL_PENDING')
  await historicalController.close()
  const oldAgain = createDataChangeTaskWorkflowV4({ provider: 'test', model: 'synthetic', adapter: f.adapter })
  assert.equal(defineExecutionWorkflow(oldAgain).digest, definition.digest)
  const restored = createExecutionController({ store: f.store, artifacts: f.artifacts,
    sessions: f.sessions, delivery: f.delivery, workflows: [f.workflow], historicalWorkflows: [oldAgain] })
  t.after(async () => restored.close())
  const sends = f.sends.length
  f.setApproval('approved')
  const gate = (await f.store.query({ kind: 'effect.list', runId: 'historical-v4' })).find(effect => effect.definition.payload.stage === 'approval-gate')
  await f.delivery.reconcile(gate.effectId)
  await restored.recover({ commandId: 'recover-v4', runId: 'historical-v4' })
  assert.equal((await restored.whenIdle('historical-v4')).run.status, 'succeeded')
  assert.equal(f.sends.slice(sends).filter(stage => stage === 'create-issue').length, 0)
})

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

test('审批前工单若已出现 task，立即停在只读回读节点', async t => {
  const f = await fixture(t, { prematureTask: true })
  await f.controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task',
    workflowId: f.workflow.id, input: input() })
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

for (const decision of ['approved', 'rejected']) test(`原生 Bytebase 简单加列：等待恢复后${decision}，无 UAT 或重复建单`, async t => {
  const f = await fixture(t, { native: true })
  await f.controller.createRun({ commandId: 'create-native', runId: 'run', taskId: 'task', workflowId: f.workflow.id, input: input() })
  let state = await f.controller.whenIdle('run')
  assert.equal(state.run.status, 'waiting', JSON.stringify(state.nodes.map(n => [n.nodeId,n.waitReason])))
  assert.equal(state.nodes[10].waitReason.kind, 'recovery')
  assert.equal(state.nodes[10].waitReason.reference, 'BYTEBASE_APPROVAL_PENDING')
  assert.deepEqual(f.sends, ['create-issue', 'approval-gate'])
  assert.equal((await f.store.query({ kind: 'approval.list' })).length, 0)
  const effect = (await f.store.query({ kind: 'effect.list', runId: 'run' })).find(e => e.definition.payload.stage === 'approval-gate')
  assert.equal((await f.delivery.reconcile(effect.effectId)).state, 'unknown')
  f.setApproval(decision)
  assert.equal((await f.delivery.reconcile(effect.effectId)).state, 'succeeded')
  await f.controller.recover({ commandId: `native-${decision}`, runId: 'run' })
  state = await f.controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(n => [n.nodeId,n.waitReason])))
  const output = await f.artifacts.read(state.nodes.at(-1).outputRef)
  if (decision === 'rejected') {
    assert.equal(output.outcome, 'needs_revision')
    assert.equal(output.comment, '字段名改为 display_name')
    assert.deepEqual(f.sends, ['create-issue', 'approval-gate'])
  } else {
    assert.equal(output.taskRunId, 'task-run-1')
    assert.deepEqual(f.sends, ['create-issue', 'approval-gate', 'execute-task'])
  }
})

test('两轮驳回的后继阶段消费具体意见和旧工单身份，不重复旧 SQL 或完成 Task', async t => {
  const source = new Map(), submissions = []
  const [contract] = createExternalStageContracts({ workflowIds: ['task-data-change'],
    readArtifact: async ref => source.get(ref), external: { async prepareRequirement({ action, materials }) {
      submissions.push({ action, materials })
      return { ...input(), previousIssueId: action.arguments.previousIssueId,
        sources: materials.map(material => ({ id: material.resourceRef, content: material.text, sha256: sha(material.text) })) }
    } } })
  const plan = { stages: [] }, origin = { command: { args: { arguments: {} } }, run: { sourceKey: 'original', body: '给表增加名称列' } }
  for (const [round, comment, nextSql] of [[1,'名称列改为 display_name','ALTER TABLE public.t ADD COLUMN display_name text;'],
    [2,'名称长度限定 80','ALTER TABLE public.t ADD COLUMN display_name varchar(80);']]) {
    const rejected = { outcome: 'needs_revision', issueId: `projects/app/issues/${round}`, planId: `plan-${round}`,
      sheetId: `sheet-${round}`, applySql: round === 1 ? 'ALTER TABLE public.t ADD COLUMN name text;' : 'ALTER TABLE public.t ADD COLUMN display_name text;',
      comment, evidenceRef: `approval-${round}` }
    assert.equal(await nativeDataChangeOwnerContract.validateCompletion({ output: rejected }), false)
    const ref = `rejected-output-${round}`
    source.set(ref, rejected); plan.stages.push({ stageId: `revision-${round}`, status: 'succeeded', outputRef: ref })
    const prepared = await contract.prepare({ taskId: 'same-task', stage: { workflowId: 'task-data-change' }, plan,
      stageIndex: plan.stages.length, requirement: { request: `按审批意见修改：${comment}`, constraints: [], stageTargets: { 'task-data-change': 'editor' } }, origin })
    assert.equal(prepared.input.previousIssueId, rejected.issueId)
    assert.equal(submissions.at(-1).action.taskId, 'same-task')
    assert.equal(JSON.parse(submissions.at(-1).materials[0].text).comment, comment)
    const f = await fixture(t, { native: true, simpleSql: nextSql })
    await f.controller.createRun({ commandId: `revision-${round}`, runId: `run-${round}`, taskId: 'same-task', workflowId: f.workflow.id, input: prepared.input })
    const state = await f.controller.whenIdle(`run-${round}`)
    assert.equal(state.nodes[10].waitReason.reference, 'BYTEBASE_APPROVAL_PENDING')
    assert.equal(f.issuePreparations[0].prepared.package.previousIssueId, rejected.issueId)
    assert.equal(f.issuePreparations[0].prepared.package.applySql, nextSql)
    assert.ok(f.issuePreparations[0].prepared.package.verificationSql.includes('FROM information_schema.columns'))
    assert.equal(JSON.parse(f.issuePreparations[0].prepared.package.expectedChange).rows[0].column_name, 'display_name')
    assert.notEqual(f.issuePreparations[0].prepared.package.applySql, rejected.applySql)
    assert.deepEqual(f.sends, ['create-issue', 'approval-gate'])
  }
})

for (const [automatic, precreated, decision = 'approved', drop = false] of [[false, false], [true, false], [false, true], [false, true, 'rejected'], [false, true, 'approved', true], [false, true, 'rejected', true]]) test(`真实 StageContract、生产 Host 和 Bytebase client 全路径插件审批 decision=${decision} auto=${automatic} precreated=${precreated} drop=${drop}`, async t => {
  const project = 'projects/flbn', exactTarget = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  const applySql = drop ? 'ALTER TABLE public.process_id_temp DROP COLUMN name;' : 'ALTER TABLE public.process_id_temp ADD COLUMN name character varying;'
  const verificationSql = "SELECT column_name, data_type, is_nullable, column_default, character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='process_id_temp' AND column_name='name';"
  const expectedRow = { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null, character_maximum_length: null }
  const queries = [], writes = [], catalog = [{ schema_name: 'public', table_name: 'process_id_temp', relation_kind: 'r',
    column_name: 'id', data_type: 'character varying', not_null: true, default_expression: null }]
  class Client {
    constructor(options) { this.options = options }
    async connect() {}
    async end() {}
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql.includes('pg_is_in_recovery()')) return { rows: [{ database_name: this.options.database, transaction_read_only: 'on', in_recovery: true }] }
      if (sql.includes('AS has_dependencies')) {
        assert.deepEqual(values, ['public', 'process_id_temp', 'name'])
        return { rows: [{ relation_kind: 'r', identity_kind: '', generated_kind: '', has_inheritance: false, has_dependencies: false }] }
      }
      if (drop && sql.includes('AS columns')) {
        assert.deepEqual(values, ['public', 'process_id_temp', 'name'])
        return { rows: [{ relation_kind: 'r', column_exists: false, columns: [] }] }
      }
      if (sql.includes('n.nspname = $1 AND c.relname = $2') && !sql.includes('AS column_exists')) {
        assert.deepEqual(values, ['public', 'process_id_temp'])
        return { rows: sql.startsWith('SELECT count(') ? [{ expected_rows: catalog.length }] : catalog }
      }
      if (sql.includes('FROM information_schema.columns')) { assert.deepEqual(values, ['public', 'process_id_temp', 'name']); return { rows: [expectedRow] } }
      if (sql.includes('AS column_exists')) {
        assert.deepEqual(values, ['public', 'process_id_temp', 'name'])
        return { rows: [{ relation_kind: 'r', column_exists: false, has_children: false }] }
      }
      throw Error(`UNEXPECTED_PRODUCTION_QUERY:${sql}`)
    }
  }
  const productionPostgres = createProductionPostgresHost({ Client, entries: ['hiq_editor','hiq_background_db','hiq_admin'].map(database => ({
    project, target: { ...exactTarget, database: `instances/flbnpguaf/databases/${database}` },
    connection: { host: '101.89.215.147', port: 5432, database, user: 'fixture', password: 'fixture' } })) })
  let sheet, plan, issue, approved = false, ran = false
  const response = value => ({ ok: true, json: async () => value })
  const bytebase = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev', bytebaseToken: 'fixture',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null
      if (options.method === 'POST') {
        writes.push(path)
        if (path.endsWith('/sheets')) { sheet = { ...body, name: `${project}/sheets/900` }; return response(sheet) }
        if (path.endsWith('/plans')) { plan = { ...body, name: `${project}/plans/900`, hasRollout: false }; return response(plan) }
        if (path.endsWith('/issues')) { issue = { ...body, name: `${project}/issues/900`, status: precreated ? 'DONE' : 'OPEN', approvalStatus: precreated ? 'SKIPPED' : 'PENDING' }; plan.issue = issue.name; if (precreated) plan.hasRollout = true; return response(issue) }
        if (path.endsWith('/rollout')) { plan.hasRollout = true; if (automatic) ran = true; return response({ name: `${plan.name}/rollout` }) }
        if (path.endsWith('/tasks:batchRun')) { ran = true; return response({}) }
        throw Error(`UNEXPECTED_BYTEBASE_WRITE:${path}`)
      }
      if (path === `/v1/${exactTarget.database}`) return response({ name: exactTarget.database, project,
        instanceResource: { name: exactTarget.instance }, effectiveEnvironment: 'environments/prod' })
      if (path === '/v1/environments/prod/policies/rollout_policy') return response({ name: 'environments/prod/policies/rollout_policy',
        type: 'ROLLOUT_POLICY', resourceType: 'ENVIRONMENT', rolloutPolicy: { automatic: false } })
      if (path === `/v1/${project}/issues`) return response({ issues: issue ? [issue] : [] })
      if (path === `/v1/${project}/issues/900`) return response({ ...issue, approvalStatus: approved ? 'APPROVED' : issue.approvalStatus,
        approvers: approved ? [{ principal: 'users/reviewer', status: 'APPROVED' }] : [] })
      if (path.endsWith('/issueComments')) return response({ issueComments: [{ name: `${issue.name}/issueComments/approval-1`,
        creator: 'users/reviewer', createTime: '2026-10-02T01:00:00Z', approval: { status: 'APPROVED' }, comment: '同意新增 name' }] })
      const taskId = `${project}/plans/900/rollout/stages/prod/tasks/1`
      if (path.endsWith('/rollout')) return response({ name: `${plan.name}/rollout`, stages: [{ environment: 'environments/prod',
        tasks: [{ name: taskId, specId: plan.specs[0].id, target: exactTarget.database, databaseUpdate: { sheet: sheet.name }, status: ran ? 'DONE' : 'NOT_STARTED' }] }] })
      if (path.endsWith('/taskRuns')) return response(ran ? { taskRuns: [{ name: `${taskId}/taskRuns/1`, status: 'DONE' }] }
        : precreated ? {} : { taskRuns: [] })
      if (path === `/v1/${project}/plans/900`) return response(plan)
      if (path === `/v1/${project}/sheets/900`) return response(sheet)
      throw Error(`UNEXPECTED_BYTEBASE_READ:${path}`)
    } }).bytebase
  bytebase.queryVerification = args => productionPostgres.queryVerification({ ...args, packageDigest: JSON.parse(issue.description).packageDigest })
  const external = createTrustedWorkflowPlatforms({ ownerActorId: 'owner', config: { bytebase: {
    adapterId: 'bytebase', adapterVersion: '1', targets: [{ id: 'editor-prod', project, target: exactTarget }] } },
    clients: { bytebase, productionPostgres } })
  const source = { summary: '生产 public.process_id_temp 只有 id 列；新增 name 使用待审批候选',
    evidenceRefs: ['production-column-proof'], limitations: [] }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-simple-change-real-contract-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'real-contract', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true, taskWorkspaceRoot: join(directory, 'tasks'), getTaskDirectories: async taskId => ({ logicalTaskId: taskId }) })
  external.bindStore(store)
  const workflow = createDataChangeTaskWorkflow({ provider: 'fixture', model: 'fixture', adapter: external.dataChangeAdapter })
  assert.equal(workflow.version, '7')
  const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => false,
    externalAdapter: external.operationAdapter, authorizeExternal: external.authorizeExternal })
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow], sessions: {
    async run({ input, onSessionBound, onResult }) {
      assert.ok(input.request.includes('process_id_temp')); assert.equal(input.sources[0].id, 'verified-investigation-output')
      await onSessionBound(); onResult({ applySql, rollbackSql: 'ALTER TABLE public.process_id_temp DROP COLUMN name;',
        verificationSql, expectedChange: JSON.stringify({ rows: drop ? [] : [expectedRow] }) })
    }, async close() {}, async cancel() {} } })
  t.after(async () => { await controller.close(); await store.close() })
  external.bindExecution({ store, artifacts, controller })
  const requirement = { request: drop ? '生产 Editor public.process_id_temp 删除 name，提交 Bytebase 真人审批后执行' : '生产 Editor public.process_id_temp 新增 name，提交 Bytebase 真人审批后执行',
    constraints: [], scope: { database: exactTarget.database, schema: 'public', table: 'process_id_temp' }, stageTargets: { 'task-data-change': 'editor-prod' } }
  await controller.createTaskPlan({ commandId: 'real-task-plan', taskId: 'same-production-task', stages: [{ stageId: 'change', workflowId: workflow.id, input: requirement }] })
  const queryTools = createAgentQueryTools({ artifacts, resolveScope: async () => requirement.scope, capabilities: [{
    id: 'query_readonly_database', identity: { id: 'editor-readonly-catalog', version: '1' }, effectClass: 'read', parameters: { type: 'object', additionalProperties: false },
    authorize: async ({ scope }) => scope.database === exactTarget.database,
    execute: async () => {
      const client = new Client({ database: 'hiq_editor' })
      await client.connect()
      try { return { target: exactTarget, rows: (await client.query('SELECT n.nspname = $1 AND c.relname = $2', ['public', 'process_id_temp'])).rows } }
      finally { await client.end() }
    }, verify: async ({ output }) => ({ passed: output.target.database === exactTarget.database, sourceRefs: ['production-readonly-catalog'] }) }] })
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller, modelConfig: () => ({}), advanceTask: async () => {}, authorizeStages: async () => false,
    tools: queryTools, prepareQueryInput: async () => requirement,
    sessionRunner: { async close() {}, async run({ binding, tools, queryInput, onSessionBound, onQueryEvidence, onCandidate }) {
      await onSessionBound()
      const queried = await tools[0].execute({ binding, input: queryInput, args: {} })
      const queryBinding = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(key => [key, binding[key]]))
      await onQueryEvidence({ binding: queryBinding, evidenceRef: queried.evidenceRef })
      const decision = { action: 'wait', summary: '当前目标结构已核对，等待本测试提交审批候选', evidenceRefs: [queried.evidenceRef], condition: { kind: 'execution', missing: '审批候选', responsibleParty: '执行方', resumeWhen: '本测试继续', evidenceRefs: [queried.evidenceRef] } }
      await onCandidate(decision); return { status: 'submitted', decision }
    } } })
  t.after(() => owner.close())
  await owner.ensure({ taskId: 'same-production-task', sourceKey: 'original', criteria: ['精确SQL经过插件审批后完成回查'], origin: {} })
  const ownerRecord = await store.query({ kind: 'task.owner', taskId: 'same-production-task' })
  const requirementRef = (await artifacts.put(requirement, { taskId: 'same-production-task' })).ref
  await store.command({ id: 'bind-current-requirement', kind: 'task.requirement.bind-legacy', args: { taskId: 'same-production-task', expectedRequirementRevision: 1, requirementRef, sessionId: ownerRecord.sessionId, criteria: ['精确SQL经过插件审批后完成回查'], sourceKey: 'original', eventKey: 'bind-current' } })
  await owner.drive('same-production-task')
  const [contract] = createExternalStageContracts({ workflowIds: ['task-data-change'], external,
    readTaskEvidence: args => owner.readTaskEvidence(args), readArtifact: async ref => { assert.equal(ref, 'verified-investigation-output'); return source } })
  const currentPlan = await controller.taskPlan('same-production-task')
  const prepared = await contract.prepare({ taskId: 'same-production-task', stage: { workflowId: 'task-data-change' }, stageIndex: 1,
    plan: { ...currentPlan, stages: [{ workflowId: 'task-investigation', status: 'succeeded', outputRef: 'verified-investigation-output' }] }, requirement,
    origin: { command: { args: { arguments: {} } }, run: { body: requirement.request, sourceKey: 'original' } } })
  assert.deepEqual(JSON.parse(prepared.input.sources[0].content), source)
  const queryProof = JSON.parse(prepared.input.sources.at(-1).content)
  assert.equal(queryProof.taskId, 'same-production-task'); assert.equal(queryProof.requirementRevision, currentPlan.task.requirementRevision)
  assert.deepEqual(queryProof.result.rows, catalog)
  assert.deepEqual(prepared.input.target, exactTarget)
  assert.equal(prepared.input.baseline, undefined)
  assert.equal(queries.length, 1, '候选形成前只有Owner主动提交的只读结构查询')
  await controller.reviseTaskPlan({ commandId: 'bind-prepared-change', taskId: 'same-production-task', expectedPlanRevision: currentPlan.task.planRevision, expectedControlRevision: currentPlan.task.controlRevision, requirementRevision: currentPlan.task.requirementRevision, affectedFrom: 0, stages: [{ stageId: 'change', workflowId: workflow.id, input: prepared.input }] })
  const boundPlan = await controller.taskPlan('same-production-task')
  await controller.createRun({ commandId: 'real-contract-create', runId: 'real-contract-run', taskId: 'same-production-task',
    workflowId: workflow.id, input: prepared.input, stageBinding: { stageId: 'change', planRevision: boundPlan.task.planRevision, attempt: boundPlan.stages[0].attempt, expectedControlRevision: boundPlan.task.controlRevision } })
  const state = await controller.whenIdle('real-contract-run')
  assert.equal(state.nodes[10].waitReason?.reference, 'PLUGIN_APPROVAL_PENDING', JSON.stringify(state.nodes.map(node => [node.nodeId,node.waitReason])))
  assert.deepEqual(writes, [`/v1/${project}/sheets`, `/v1/${project}/plans`, `/v1/${project}/issues`])
  assert.equal(Buffer.from(sheet.content, 'base64').toString('utf8'), applySql)
  assert.deepEqual(plan.specs[0].changeDatabaseConfig.targets, [exactTarget.database])
  assert.equal(issue.approvalStatus, precreated ? 'SKIPPED' : 'PENDING')
  if (drop) assert.match(issue.description, /永久删除该列及其中全部数据/)
  const pluginApprovals = await store.query({ kind: 'approval.list' })
  assert.equal(pluginApprovals.length, 1)
  assert.equal(pluginApprovals[0].decision, 'pending')
  assert.equal(queries.filter(item => item.sql.includes(drop ? 'AS has_dependencies' : 'AS column_exists')).length, 1)
  assert.equal(queries.some(item => /^\s*(ALTER|UPDATE|DELETE|INSERT)\b/i.test(item.sql)), false)
  const saved = await artifacts.read(state.nodes[2].outputRef)
  assert.deepEqual(saved.baseline.scope, { schema: 'public', table: 'process_id_temp' })
  assert.deepEqual(JSON.parse(saved.expectedChange), { rows: drop ? [] : [expectedRow] })
  assert.equal(ran, false)
  await store.command({ id: 'plugin-approved', kind: 'approval.decide', args: { requestId: pluginApprovals[0].requestId, actorId: 'owner', source: 'web', decision, comment: '保留 character varying 类型，说明回滚方案后重新送审' } })
  const gate = (await store.query({ kind: 'effect.list', runId: 'real-contract-run' })).find(effect => effect.definition.payload.stage === 'approval-gate')
  assert.equal((await delivery.reconcile(gate.effectId)).state, decision === 'rejected' ? 'failed' : 'prepared')
  await controller.recover({ commandId: 'real-contract-approved', runId: 'real-contract-run' })
  const completed = await controller.whenIdle('real-contract-run')
  assert.equal(completed.run.status, 'succeeded', JSON.stringify(completed.nodes.map(node => [node.nodeId,node.waitReason])))
  if (decision === 'rejected') {
    const rejected = await artifacts.read(completed.nodes.at(-1).outputRef)
    assert.equal(rejected.outcome, 'needs_revision')
    assert.equal(rejected.comment, '保留 character varying 类型，说明回滚方案后重新送审')
    assert.equal(ran, false)
    assert.equal(writes.some(path => path.endsWith('/rollout') || path.endsWith('/tasks:batchRun')), false)
    return
  }
  assert.equal(writes.filter(path => path.endsWith('/rollout')).length, precreated ? 0 : 1)
  assert.equal(writes.filter(path => path.endsWith('/tasks:batchRun')).length, automatic ? 0 : 1)
  const result = await artifacts.read(completed.nodes.at(-1).outputRef)
  assert.equal(result.taskRunId, `${plan.name}/rollout/stages/prod/tasks/1/taskRuns/1`)
  assert.deepEqual(JSON.parse(result.observedChange), drop ? [] : [expectedRow])
  const executeEffect = (await store.query({ kind: 'effect.list', runId: 'real-contract-run' })).find(effect => effect.definition.payload.stage === 'execute-task')
  const identity = executeEffect.definition.payload.intent
  assert.deepEqual(identity.baseline.scope, saved.baseline.scope)
  assert.equal(queries.some(item => item.sql === uatCatalogBaselineSql() || item.sql === uatCatalogBaselineCountSql()), false)
  assert.notEqual(identity.issueCreationOperationKey, identity.executeOperationKey)
  const beforeWrites = writes.length
  assert.equal((await external.operationAdapter.reconcile(executeEffect.definition.payload)).status, 'succeeded')
  assert.equal(writes.length, beforeWrites)
  await assert.rejects(bytebase.runTask({ project, issueId: issue.name, taskId: result.taskId,
    issueCreationOperationKey: identity.issueCreationOperationKey, executeOperationKey: identity.issueCreationOperationKey,
    approvalRequestId: executeEffect.definition.payload.approvalRequestId }), /BYTEBASE_TASK_NOT_READY/)
  assert.equal(writes.length, beforeWrites)
})

test('历史v6不获得新增删除准入，v7明确提供单列删除候选', async t => {
  const f = await fixture(t, { native: true })
  const options = { provider: 'fixture', model: 'fixture', adapter: { ...f.adapter, pluginApproval: true } }
  const old = createDataChangeTaskWorkflowV6(options), current = createDataChangeTaskWorkflow(options)
  assert.equal(old.version, '6'); assert.equal(current.version, '7')
  const context = { input: { requirement: input(), proposal: { ...proposal, applySql: 'ALTER TABLE public.t DROP COLUMN name;' } } }
  assert.throws(() => old.nodes.find(node => node.id === 'validate-package').execute(context), { code: 'DATA_CHANGE_COLUMN_DELETE_REQUIRES_V7' })
  assert.equal((await current.nodes.find(node => node.id === 'validate-package').execute(context)).applySql, context.input.proposal.applySql)
  assert.match(current.nodes.find(node => node.id === 'propose-sql').prompt, /重新添加同名列不能恢复原数据/)
})