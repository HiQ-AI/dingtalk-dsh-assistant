import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'

async function fixture({ requiredFile = false, deliver = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task-delivery-manifest-'))
  const managed = createTaskArtifactFiles({ root })
  const file = await managed.register({ taskId: 'task', requirementRevision: 1, role: 'report', fileName: 'report.md',
    producer: { runId: 'run', nodeRunId: 'node', outputRef: 'operation:write' }, bytes: Buffer.from('verified report') })
  const output = { summary: '调查已完成', artifactFiles: requiredFile ? [file] : [] }
  const plan = { task: { taskId: 'task', status: 'succeeded', requirementRevision: 1, planRequirementRevision: 1, planRevision: 2 },
    stages: [{ stageId: 'stage', runId: 'run', workflowId: 'workflow', workflowDigest: 'frozen-v1', status: 'succeeded', outputRef: 'result' }] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: 'workflow', workflowDigest: 'frozen-v1', status: 'succeeded', generation: 0 },
    pendingInputCount: 0, nodes: [{ nodeRunId: 'node', status: 'succeeded', outputRef: 'result', generation: 0 }] }
  const contract = { id: 'result-owner', version: '1', resultContract: { id: 'report', version: '1', requiredFields: ['summary'] }, validateCompletion: () => true }
  const requirement = { scope: { ...(requiredFile ? { artifactFiles: [{ role: 'report', fileName: 'report.md' }] } : {}) },
    ...(deliver ? { fileDelivery: { files: [{ role: 'report', fileName: 'report.md' }] } } : {}) }
  const decision = { evidenceRefs: ['result'], assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: ['result'] }] }
  let delivered = true
  const dependencies = {
    controller: { state: async () => state, workflowDefinition: (id, digest) => {
      assert.equal(digest, 'frozen-v1'); return { ownerContract: contract }
    } },
    store: { query: async () => [{ itemId: 'acceptance-1', criterion: '交付有证据的报告' }] },
    artifacts: { read: async ref => { assert.equal(ref, 'result'); return output } },
    validateFiles: managed.validateManifest, verifyFileDelivery: async () => delivered,
  }
  const helpers = createTaskWorkflowContracts(dependencies)
  const context = { taskId: 'task', plan, requirement, decision }
  return { root, file, output, plan, state, contract, context, helpers, dependencies, unconfirmDelivery: () => { delivered = false } }
}

test('正式清单绑定冻结产物身份及验收，计划成功不能代替逐项评估', async () => {
  const f = await fixture(), manifest = await f.helpers.readDeliveryManifest(f.context)
  assert.equal(manifest.complete, true)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.planRevision, 2)
  assert.equal(manifest.requirementRevision, 1)
  assert.deepEqual(manifest.artifacts[0].resultContract, { id: 'report', version: '1' })
  assert.deepEqual(manifest.artifacts[0].acceptanceItemIds, ['acceptance-1'])
  assert.equal(await f.helpers.authorizeCompletion(f.context), true)
  const pending = await f.helpers.readDeliveryManifest({ ...f.context, decision: undefined })
  assert.equal(pending.complete, false)
  assert.equal(pending.acceptance[0].status, 'pending')
  await assert.rejects(f.helpers.authorizeCompletion({ ...f.context, decision: { ...f.context.decision, assessments: [] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  f.context.decision.assessments[0].evidenceRefs = ['foreign']
  assert.equal((await f.helpers.readDeliveryManifest(f.context)).complete, false)
})

test('缺字段、未成功阶段和旧需求清单不可完成，串换Run或代际直接拒绝', async () => {
  for (const mutate of [f => { delete f.output.summary }, f => { f.plan.stages[0].status = 'running' },
    f => { f.plan.task.planRequirementRevision = 0 }]) {
    const f = await fixture(); mutate(f)
    assert.equal((await f.helpers.readDeliveryManifest(f.context)).complete, false)
    await assert.rejects(f.helpers.authorizeCompletion(f.context), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  }
  for (const mutate of [f => { f.state.run.runId = 'foreign' }, f => { f.state.nodes[0].generation = 1 }]) {
    const f = await fixture(); mutate(f)
    await assert.rejects(f.helpers.readDeliveryManifest(f.context), /WORKFLOW_OWNER_STAGE_MISMATCH/)
  }
})

test('必交文件由受管字节独立核验，缺失、旧版本、错误生产者和摘要损坏不得通过', async () => {
  const good = await fixture({ requiredFile: true })
  const manifest = await good.helpers.readDeliveryManifest(good.context)
  assert.equal(manifest.complete, true)
  assert.equal(manifest.files[0].artifactId, good.file.artifactId)
  assert.equal(manifest.files[0].stageId, 'stage')
  for (const mutate of [f => { f.output.artifactFiles = [] }, f => { f.file.requirementRevision = 2 }]) {
    const f = await fixture({ requiredFile: true }); mutate(f)
    assert.equal((await f.helpers.readDeliveryManifest(f.context)).complete, false)
    await assert.rejects(f.helpers.authorizeCompletion(f.context), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  }
  const wrong = await fixture({ requiredFile: true }); wrong.file.producer.runId = 'other'
  await assert.rejects(wrong.helpers.readDeliveryManifest(wrong.context), /TASK_DELIVERY_FILE_PRODUCER_MISMATCH/)
  await writeFile(join(good.root, good.file.fileRef), 'corrupt')
  await assert.rejects(good.helpers.readDeliveryManifest(good.context), { code: 'TASK_ARTIFACT_DIGEST_MISMATCH' })
})

test('外发声明必须取得独立送达核验，文件生成不能替代送达', async () => {
  const f = await fixture({ requiredFile: true, deliver: true })
  assert.equal((await f.helpers.readDeliveryManifest(f.context)).complete, true)
  f.unconfirmDelivery()
  const manifest = await f.helpers.readDeliveryManifest(f.context)
  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.complete, false)
  assert.ok(manifest.missing.some(item => item.code === 'TASK_DELIVERY_FILE_RECEIPT_REQUIRED'))
  await assert.rejects(f.helpers.authorizeCompletion(f.context), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
})

test('文件验证回调缺失、false或篡改结果均不能授予完成', async () => {
  const f = await fixture({ requiredFile: true })
  const missing = createTaskWorkflowContracts({ ...f.dependencies, validateFiles: undefined })
  assert.equal((await missing.readDeliveryManifest(f.context)).complete, false)
  for (const validateFiles of [async () => false, async values => [{ ...values[0], sha256: '0'.repeat(64) }]]) {
    const helpers = createTaskWorkflowContracts({ ...f.dependencies, validateFiles })
    await assert.rejects(helpers.readDeliveryManifest(f.context), { code: 'TASK_DELIVERY_FILE_VERIFICATION_FAILED' })
  }
})
