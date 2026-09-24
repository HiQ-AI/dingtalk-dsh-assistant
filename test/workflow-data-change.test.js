import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createDataChangePreparationWorkflow, assertDataChangeExecutionIdentity } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const requirement = () => ({ request: '同步翻译', constraints: ['仅更新指定键'],
  target: { instance: 'prod', database: 'i18n', environment: 'production' },
  sources: [{ id: 'translation.csv', content: 'key,value\na,b', sha256: sha('key,value\na,b') }],
  baseline: { snapshotId: 'baseline-1', sha256: sha('baseline') },
})
const proposal = { applySql: 'BEGIN; UPDATE i18n SET value = \'b\' WHERE key = \'a\' AND value = \'old\'; COMMIT;',
  rollbackSql: 'BEGIN; UPDATE i18n SET value = \'old\' WHERE key = \'a\' AND value = \'b\'; COMMIT;',
  verificationSql: 'SELECT value FROM i18n WHERE key = \'a\';', expectedChange: '仅 a 从 old 变成 b' }

test('数据变更准备：固定四节点只调用隔离校验和演练，产出精确身份', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-data-prep-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'data', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  let validateCalls = 0, rehearseCalls = 0
  const adapter = { id: 'isolated-test', version: '1', rulesDigest: sha('isolated-test-v1'), async validate(input) {
    validateCalls++; assert.equal(input.target.environment, 'production')
    return { passed: true, packageDigest: input.packageDigest, receiptId: 'validation-1' }
  }, async rehearse(input) {
    rehearseCalls++; assert.equal(input.package.applySqlSha256, sha(proposal.applySql))
    return { passed: true, isolated: true, packageDigest: input.package.validation.packageDigest,
      receiptId: 'rehearsal-1', observedChange: 'a= b, other keys unchanged' }
  } }
  const workflow = createDataChangePreparationWorkflow({ provider: 'test', model: 'synthetic', adapter })
  assert.equal(defineExecutionWorkflow(workflow).nodes.length, 4)
  const sessions = { async run({ definition, onSessionBound, onResult }) {
    assert.deepEqual(definition.allowedTools, []); await onSessionBound(); onResult(proposal)
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: workflow.id, input: requirement() })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(node => [node.nodeId, node.waitReason])))
  assert.equal(validateCalls, 1); assert.equal(rehearseCalls, 1)
  const prepared = await artifacts.read(state.nodes.at(-1).outputRef)
  const sheet = { id: 'sheet-1', sha256: sha(proposal.applySql), target: requirement().target }
  const plan = { id: 'plan-1', sheetId: sheet.id }, task = { id: 'task-1', planId: plan.id, status: 'NOT_STARTED' }
  const approval = { decision: 'approved', taskId: task.id, sheetSha256: sheet.sha256,
    packageDigest: prepared.package.validation.packageDigest, requestId: 'request-1', decidedBy: 'owner' }
  assert.equal(assertDataChangeExecutionIdentity({ prepared, sheet, plan, task, approval }).taskId, task.id)
  for (const changed of [
    { sheet: { ...sheet, sha256: sha('other') } },
    { sheet: { ...sheet, target: { ...sheet.target, database: 'other' } } },
    { plan: { ...plan, sheetId: 'other' } },
    { task: { ...task, status: 'DONE' } },
    { approval: { ...approval, decision: 'pending' } },
    { approval: { ...approval, packageDigest: sha('other') } },
    { prepared: { ...prepared, package: { ...prepared.package, applySql: 'changed after approval' } } },
  ]) assert.throws(() => assertDataChangeExecutionIdentity({ prepared, sheet, plan, task, approval, ...changed }), { code: 'DATA_CHANGE_EXECUTION_IDENTITY_UNCONFIRMED' })
})

test('数据变更准备：来源摘要不符及假演练均被拒绝', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-data-invalid-'))
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'data', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const adapter = { id: 'isolated-test', version: '1', rulesDigest: sha('isolated-test-v1'), async validate(input) {
    return { passed: true, packageDigest: input.packageDigest, receiptId: 'validation-1' }
  }, async rehearse(input) {
    return { passed: true, isolated: false, packageDigest: input.package.validation.packageDigest,
      receiptId: 'rehearsal-1', observedChange: 'changed' }
  } }
  const workflow = createDataChangePreparationWorkflow({ provider: 'test', model: 'synthetic', adapter })
  const sessions = { async run({ onSessionBound, onResult }) { await onSessionBound(); onResult(proposal) }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  const wrong = requirement(); wrong.sources[0].sha256 = sha('other')
  await controller.createRun({ commandId: 'wrong', runId: 'wrong', taskId: 'wrong', workflowId: workflow.id, input: wrong })
  const rejected = await controller.whenIdle('wrong')
  assert.equal(rejected.run.status, 'waiting')
  assert.equal(rejected.nodes[0].waitReason.reference, 'DATA_CHANGE_INPUT_INVALID')
  await controller.createRun({ commandId: 'valid', runId: 'valid', taskId: 'valid', workflowId: workflow.id, input: requirement() })
  const unconfirmed = await controller.whenIdle('valid')
  assert.equal(unconfirmed.run.status, 'waiting')
  assert.equal(unconfirmed.nodes[3].waitReason.reference, 'DATA_CHANGE_REHEARSAL_UNCONFIRMED')
})
