import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'

async function fixture(t, { mutateFinal, action = 'complete' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'owner-manifest-')), dbPath = join(directory, 'control.sqlite')
  const store = await openExecutionStore({ dbPath, instanceId: 'manifest', initialize: true })
  let owner, controller
  t.after(async () => { await owner?.close(); await controller?.close(); await store.close() })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workflow = { id: 'report', version: '1', ownerContract: { id: 'report-result', version: '1',
    resultContract: { id: 'report', version: '1', requiredFields: ['summary'] }, validateCompletion: () => true },
    nodes: [{ id: 'report', version: '1', executor: 'code', allowedEffects: ['pure'],
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '结果已核验' }) }] }
  controller = createExecutionController({ store, artifacts, workflows: [workflow] })
  const helpers = createTaskWorkflowContracts({ controller, store, artifacts })
  const requirement = { request: '交付报告', acceptanceCriteria: ['交付报告'], scope: {} }
  await controller.createTaskPlan({ commandId: 'create', taskId: 'task', stages: [{ stageId: 'first', workflowId: 'report', input: requirement }] })
  if (action === 'complete') {
    const started = await controller.advanceTaskPlan('task')
    await controller.whenIdle(started.stages[0].runId)
    await controller.advanceTaskPlan('task')
  }
  let snapshotRef
  owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller,
    modelConfig: () => ({}), advanceTask: async () => {}, authorizeStages: async () => false,
    authorizeCompletion: async ({ taskId, decision }) => helpers.authorizeCompletion({ taskId, decision, requirement, plan: await controller.taskPlan(taskId) }),
    readDeliveryManifest: async args => {
      const value = await helpers.readDeliveryManifest(args)
      return args.decision && mutateFinal ? mutateFinal(value) : value
    },
    sessionRunner: { async run({ input, readArtifact, onSessionBound, onCandidate }) {
      await onSessionBound()
      snapshotRef = input.deliveryManifest.ref
      const snapshot = await readArtifact(snapshotRef)
      assert.equal(snapshot.complete, false)
      assert.equal(snapshot.acceptance[0].status, 'pending')
      const outputRef = input.stages[0].outputRef
      const decision = { action, summary: '处理当前任务', evidenceRefs: outputRef ? [outputRef] : [],
        ...(action === 'complete' ? { assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: [outputRef] })) } : {}) }
      await onCandidate(decision)
      return { status: 'submitted', decision }
    }, async close() {} },
  })
  const initial = await owner.ensure({ taskId: 'task', sourceKey: 'source', criteria: requirement.acceptanceCriteria, origin: {} })
  await store.command({ id: 'bind', kind: 'task.requirement.bind-legacy', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: (await artifacts.put(requirement)).ref, sessionId: initial.sessionId,
    criteria: requirement.acceptanceCriteria, sourceKey: 'source', eventKey: 'bind' } })
  return { owner, store, artifacts, dbPath, snapshotRef: () => snapshotRef }
}

test('Owner允许读取清单快照，最终完成清单独立持久化且重启后可查询', async t => {
  const f = await fixture(t)
  assert.equal(await f.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }), null)
  await f.owner.drive('task')
  const saved = await f.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' })
  assert.equal(saved.taskId, 'task'); assert.equal(saved.requirementRevision, 1); assert.equal(saved.planRevision, 1)
  assert.notEqual(saved.ref, f.snapshotRef())
  const manifest = await f.artifacts.read(saved.ref)
  assert.equal(manifest.complete, true)
  assert.equal(manifest.acceptance[0].status, 'satisfied')
  assert.equal(manifest.businessValidation.status, 'accepted')
  assert.equal(manifest.businessValidation.items[0].itemId, manifest.acceptance[0].itemId)
  assert.match(manifest.businessValidation.items[0].validators[0].policyDigest, /^[a-f0-9]{64}$/)
  await f.owner.close(); await f.store.close()
  const reopened = await openExecutionStore({ dbPath: f.dbPath, instanceId: 'manifest' })
  try { assert.deepEqual(await reopened.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }), saved) }
  finally { await reopened.close() }
})

test('需求或计划版本变化使旧完成清单失效', async t => {
  for (const column of ['requirement_revision', 'plan_revision']) await t.test(column, async child => {
    const f = await fixture(child); await f.owner.drive('task')
    assert.ok(await f.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }))
    const db = new DatabaseSync(f.dbPath)
    try { db.prepare(`UPDATE business_tasks SET ${column}=2 WHERE task_id='task'`).run() } finally { db.close() }
    assert.equal(await f.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }), null)
  })
})

test('非完成决定不会存正式清单，不完整或旧版本清单不能接纳完成', async t => {
  const waiting = await fixture(t, { action: 'wait' }); await waiting.owner.drive('task')
  assert.equal(await waiting.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }), null)
  for (const mutateFinal of [value => ({ ...value, complete: false }),
    value => ({ ...value, complete: 'yes' }), value => ({ ...value, requirementRevision: 0 }),
    value => ({ ...value, planRevision: 0 }), value => ({ ...value, taskId: 'foreign' }),
    value => ({ ...value, kind: 'other' }), value => ({ ...value, version: 2 }),
    value => ({ ...value, businessValidation: undefined }),
    value => ({ ...value, businessValidation: { status: 'unverified' } })]) {
    const f = await fixture(t, { mutateFinal })
    await assert.rejects(f.owner.drive('task'), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
    assert.equal(await f.store.query({ kind: 'task.owner.delivery-manifest', taskId: 'task' }), null)
  }
})


test('Owner事件、清单快照和正式清单使用当前任务归属', async t => {
  const f = await fixture(t), writes = [], put = f.artifacts.put
  f.artifacts.put = async (value, options) => { writes.push({ value, options }); return put(value, options) }
  await f.owner.event({ taskId: 'task', eventKey: 'routing', eventType: 'task.created', payload: { marker: 'routing' } })
  await f.owner.drive('task')
  assert.ok(writes.some(entry => entry.value?.marker === 'routing'))
  assert.ok(writes.some(entry => entry.value?.kind === 'task-delivery-manifest' && entry.value.complete === false))
  assert.ok(writes.some(entry => entry.value?.kind === 'task-delivery-manifest' && entry.value.complete === true))
  for (const entry of writes) assert.deepEqual(entry.options, { taskId: 'task' })
})
