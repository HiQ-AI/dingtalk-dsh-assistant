import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'

const workflow = id => ({ id, version: '1', nodes: [{
  id: 'produce', version: '1', executor: 'code', allowedEffects: ['pure'],
  inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
  mapInput: ({ requirement }) => requirement,
  execute: async ({ input }) => input + 1,
}] })
const runFile = promisify(execFile)

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stage-plan-'))
  const dbPath = join(directory, 'control.sqlite'), instanceId = 'plan-test'
  const store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [workflow('investigate'), workflow('implement')] })
  t.after(async () => { await controller.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { store, artifacts, controller, dbPath, instanceId }
}

test('任务与 Owner 原子接纳后保持零阶段，Owner 初始化计划才可启动 Run', async t => {
  const { store, artifacts, controller } = await setup(t)
  const goal = await artifacts.put(3)
  await store.command({ id: 'accept-zero', kind: 'task.accept', args: {
    taskId: 'new-task', requirementRef: goal.ref, requirementRevision: 1,
    sessionId: 'owner-new-task', criteria: ['结果为 4'], sourceKey: 'source-1', eventKey: 'created-new-task',
  } })
  const before = await controller.taskPlan('new-task')
  assert.equal(before.task.status, 'pending')
  assert.equal(before.task.planRevision, 0)
  assert.equal(before.task.requirementRef, goal.ref)
  assert.deepEqual(before.stages, [])
  assert.equal((await store.query({ kind: 'run.list', taskId: 'new-task' })).length, 0)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'new-task' })).eventWatermark > 0, true)
  await controller.initializeTaskPlan({ commandId: 'initialize-new-task', taskId: 'new-task',
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', input: 3 }] })
  await assert.rejects(controller.initializeTaskPlan({ commandId: 'initialize-twice', taskId: 'new-task',
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', input: 3 }] }), { code: 'TASK_PLAN_STALE' })
  const active = await controller.taskPlan('new-task')
  assert.equal(active.task.planRevision, 1)
  assert.equal(active.task.requirementRevision, 1)
  assert.equal(active.stages[0].status, 'ready')
  await controller.advanceTaskPlan('new-task')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'new-task' })).length, 1)
})

test('Owner 初始化失败时 Task 接纳事务整体回滚', async t => {
  const { store, artifacts } = await setup(t)
  const goal = await artifacts.put(3)
  await assert.rejects(store.command({ id: 'accept-invalid-owner', kind: 'task.accept', args: {
    taskId: 'rollback-task', requirementRef: goal.ref, requirementRevision: 1,
    sessionId: 'owner-rollback', criteria: [], sourceKey: 'source-1', eventKey: 'created-rollback',
  } }), { code: 'TASK_OWNER_CRITERIA_INVALID' })
  assert.equal(await store.query({ kind: 'task.plan', taskId: 'rollback-task' }), null)
  assert.equal(await store.query({ kind: 'task.owner', taskId: 'rollback-task' }), null)
})

test('要求更新与 Owner 事件原子落账并使旧计划候选失效', async t => {
  const { store, artifacts, controller } = await setup(t)
  const first = await artifacts.put(3), second = await artifacts.put(5)
  await store.command({ id: 'accept-versioned', kind: 'task.accept', args: {
    taskId: 'versioned', requirementRef: first.ref, requirementRevision: 1,
    sessionId: 'owner-versioned', criteria: ['完成结果'], sourceKey: 'source-1', eventKey: 'created-versioned',
  } })
  const oldOwner = await store.query({ kind: 'task.owner', taskId: 'versioned' })
  const updated = await store.command({ id: 'update-versioned', kind: 'task.requirement.update', args: {
    taskId: 'versioned', expectedRequirementRevision: 1, requirementRef: second.ref, eventKey: 'updated-versioned',
  } })
  assert.equal(updated.result.requirementRevision, 2)
  const current = await controller.taskPlan('versioned')
  assert.equal(current.task.requirementRef, second.ref)
  assert.equal(current.task.planRevision, 0)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'versioned' })).eventWatermark > oldOwner.eventWatermark, true)
  await assert.rejects(controller.initializeTaskPlan({ commandId: 'stale-initialize', taskId: 'versioned',
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', input: 3 }] }), { code: 'TASK_PLAN_STALE' })
})

test('零阶段任务的 Owner 可接纳 initialize 并保留待应用决定', async t => {
  const { store, artifacts } = await setup(t)
  const goal = await artifacts.put(3)
  await store.command({ id: 'accept-owner-init', kind: 'task.accept', args: {
    taskId: 'owner-init-task', requirementRef: goal.ref, requirementRevision: 1,
    sessionId: 'owner-init-session', criteria: ['结果为 4'], sourceKey: 'source-1', eventKey: 'owner-init-event',
  } })
  const claim = (await store.command({ id: 'claim-owner-init', kind: 'task.owner.claim', args: {
    taskId: 'owner-init-task', turnId: 'turn-owner-init', expectedLeaseEpoch: 0,
  } })).result
  await store.command({ id: 'bound-owner-init', kind: 'task.owner.sessionBound', args: {
    taskId: 'owner-init-task', turnId: 'turn-owner-init', leaseEpoch: claim.leaseEpoch,
    sessionId: 'owner-init-session',
  } })
  await store.command({ id: 'candidate-owner-init', kind: 'task.owner.candidate', args: {
    taskId: 'owner-init-task', turnId: 'turn-owner-init', leaseEpoch: claim.leaseEpoch,
    decision: { action: 'advance', summary: '先排查', evidenceRefs: [], planChange: {
      kind: 'initialize', stages: [{ workflowId: 'investigate', gate: 'none' }],
    } },
  } })
  const accepted = (await store.command({ id: 'accepted-owner-init', kind: 'task.owner.accept', args: {
    taskId: 'owner-init-task', turnId: 'turn-owner-init', leaseEpoch: claim.leaseEpoch,
  } })).result
  assert.equal(accepted.decision.planChange.kind, 'initialize')
  assert.equal(accepted.decision.appendStages.length, 1)
  assert.equal((await store.query({ kind: 'task.owner.actions.pending', limit: 10 })).length, 1)
})

test('新任务计划结算后可追加阶段，要求版本不随计划操作增长', async t => {
  const { store, artifacts, controller } = await setup(t)
  const goal = await artifacts.put(3)
  await store.command({ id: 'accept-append', kind: 'task.accept', args: {
    taskId: 'append-task', requirementRef: goal.ref, requirementRevision: 1,
    sessionId: 'owner-append', criteria: ['完成两个步骤'], sourceKey: 'source-1', eventKey: 'created-append',
  } })
  await controller.initializeTaskPlan({ commandId: 'initialize-append', taskId: 'append-task',
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', input: 3 }] })
  let plan = await controller.advanceTaskPlan('append-task')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('append-task')
  assert.equal(plan.task.status, 'succeeded')
  await controller.extendTaskPlan({ commandId: 'extend-settled', taskId: 'append-task',
    expectedPlanRevision: 1, expectedControlRevision: 1, requirementRevision: 1,
    stages: [{ stageId: 'stage-2', workflowId: 'implement' }] })
  plan = await controller.taskPlan('append-task')
  assert.equal(plan.task.requirementRevision, 1)
  assert.equal(plan.task.planRevision, 1)
  assert.equal(plan.task.status, 'active')
  assert.equal(plan.stages[1].status, 'ready')
})

test('新要求使旧成功计划的完成候选失效，必须重新确认计划适用性', async t => {
  const { store, artifacts, controller } = await setup(t)
  const first = await artifacts.put(3), second = await artifacts.put(5)
  await store.command({ id: 'accept-fence', kind: 'task.accept', args: {
    taskId: 'fence-task', requirementRef: first.ref, requirementRevision: 1,
    sessionId: 'owner-fence', criteria: ['结果满足最新要求'], sourceKey: 'source-1', eventKey: 'fence-created',
  } })
  await controller.initializeTaskPlan({ commandId: 'initialize-fence', taskId: 'fence-task',
    expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', input: 3 }] })
  let plan = await controller.advanceTaskPlan('fence-task')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('fence-task')
  assert.equal(plan.task.status, 'succeeded')
  await store.command({ id: 'update-fence', kind: 'task.requirement.update', args: {
    taskId: 'fence-task', expectedRequirementRevision: 1, requirementRef: second.ref, eventKey: 'fence-updated',
  } })
  plan = await controller.taskPlan('fence-task')
  assert.equal(plan.task.requirementRevision, 2)
  assert.equal(plan.task.planRequirementRevision, 1)
  const claim = (await store.command({ id: 'claim-fence-owner', kind: 'task.owner.claim', args: {
    taskId: 'fence-task', turnId: 'turn-fence-owner', expectedLeaseEpoch: 0,
  } })).result
  await store.command({ id: 'bound-fence-owner', kind: 'task.owner.sessionBound', args: {
    taskId: 'fence-task', turnId: 'turn-fence-owner', leaseEpoch: claim.leaseEpoch, sessionId: 'owner-fence',
  } })
  await store.command({ id: 'candidate-fence-owner', kind: 'task.owner.candidate', args: {
    taskId: 'fence-task', turnId: 'turn-fence-owner', leaseEpoch: claim.leaseEpoch,
    decision: { action: 'complete', summary: '错误地宣称完成', evidenceRefs: [plan.stages[0].outputRef],
      assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: [plan.stages[0].outputRef] }] },
  } })
  await assert.rejects(store.command({ id: 'accept-stale-complete', kind: 'task.owner.accept', args: {
    taskId: 'fence-task', turnId: 'turn-fence-owner', leaseEpoch: claim.leaseEpoch,
  } }), { code: 'TASK_OWNER_COMPLETION_UNPROVEN' })
})

test('任务级控制屏障落盘后即阻止节点领取，不等待异步Run停止', async t => {
  const { store } = await setup(t)
  const digest = 'a'.repeat(64)
  await store.command({ id: 'plan-fence', kind: 'task.plan.create', args: { taskId: 'fenced', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', workflowDigest: digest, unavailableReason: null,
      requirementRef: 'sha256/input.json', gate: 'none' }] } })
  await store.command({ id: 'run-fence', kind: 'run.create', args: { runId: 'fenced-run', taskId: 'fenced',
    workflowId: 'investigate', workflowDigest: digest, requirementRef: 'sha256/input.json',
    stageBinding: { planRevision: 1, stageId: 'stage-1', attempt: 1, expectedControlRevision: 1 },
    nodes: [{ nodeId: 'produce', nodeVersion: '1', executor: 'code', inputRef: 'sha256/input.json', inputDigest: digest }] } })
  await store.command({ id: 'pause-fence', kind: 'task.control.pause', args: {
    taskId: 'fenced', expectedControlRevision: 1 } })
  assert.equal((await store.query({ kind: 'task.plan', taskId: 'fenced' })).task.controlState, 'pausing')
  await assert.rejects(store.command({ id: 'claim-fence', kind: 'node.claim', args: {
    runId: 'fenced-run', nodeId: 'produce', expectedGeneration: 1, expectedLeaseEpoch: 0 } }),
  { code: 'TASK_DISPATCH_BLOCKED' })
})

test('任务取消落盘后阻止已领取节点准备新的外部效果', async t => {
  const { store } = await setup(t)
  const digest = 'b'.repeat(64)
  await store.command({ id: 'plan-effect-fence', kind: 'task.plan.create', args: { taskId: 'effect-fenced', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', workflowDigest: digest,
      unavailableReason: null, requirementRef: 'sha256/input.json', gate: 'none' }] } })
  await store.command({ id: 'run-effect-fence', kind: 'run.create', args: { runId: 'effect-run', taskId: 'effect-fenced',
    workflowId: 'investigate', workflowDigest: digest, requirementRef: 'sha256/input.json',
    stageBinding: { planRevision: 1, stageId: 'stage-1', attempt: 1, expectedControlRevision: 1 },
    nodes: [{ nodeId: 'produce', nodeVersion: '1', executor: 'code', inputRef: 'sha256/input.json', inputDigest: digest }] } })
  await store.command({ id: 'claim-effect-fence', kind: 'node.claim', args: {
    runId: 'effect-run', nodeId: 'produce', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  await store.command({ id: 'prepare-before-cancel', kind: 'effect.prepare', args: {
    effectId: 'prepared-write', kind: 'operation', runId: 'effect-run', nodeId: 'produce', generation: 1,
    inputDigest: digest, leaseEpoch: 1, definition: { adapterId: 'fixture', adapterVersion: '1', principalId: 'owner' },
    resourceKeys: ['resource:a'], authorizationRef: 'approved-scope' } })
  await store.command({ id: 'cancel-effect-fence', kind: 'task.control.cancel', args: {
    taskId: 'effect-fenced', expectedControlRevision: 1 } })
  await assert.rejects(store.command({ id: 'begin-effect-fence', kind: 'effect.begin', args: {
    effectId: 'prepared-write', leaseEpoch: 1, expectedSafetyEpoch: 0 } }), { code: 'TASK_DISPATCH_BLOCKED' })
  await assert.rejects(store.command({ id: 'prepare-effect-fence', kind: 'effect.prepare', args: {
    effectId: 'new-write', kind: 'operation', runId: 'effect-run', nodeId: 'produce', generation: 1,
    inputDigest: digest, leaseEpoch: 1, definition: { adapterId: 'fixture', adapterVersion: '1', principalId: 'owner' },
    resourceKeys: ['resource:a'], authorizationRef: 'approved-scope' } }), { code: 'TASK_DISPATCH_BLOCKED' })
})

test('外部效果已发而回执未知时取消只阻止后续派发，原效果仍待对账', async t => {
  const { store } = await setup(t)
  const digest = 'c'.repeat(64)
  await store.command({ id: 'plan-unknown', kind: 'task.plan.create', args: { taskId: 'unknown-task', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'investigate', workflowDigest: digest,
      unavailableReason: null, requirementRef: 'sha256/input.json', gate: 'none' }] } })
  await store.command({ id: 'run-unknown', kind: 'run.create', args: { runId: 'unknown-run', taskId: 'unknown-task',
    workflowId: 'investigate', workflowDigest: digest, requirementRef: 'sha256/input.json',
    stageBinding: { planRevision: 1, stageId: 'stage-1', attempt: 1, expectedControlRevision: 1 },
    nodes: [{ nodeId: 'produce', nodeVersion: '1', executor: 'code', inputRef: 'sha256/input.json', inputDigest: digest }] } })
  await store.command({ id: 'claim-unknown', kind: 'node.claim', args: {
    runId: 'unknown-run', nodeId: 'produce', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  await store.command({ id: 'prepare-unknown', kind: 'effect.prepare', args: {
    effectId: 'unknown-write', kind: 'operation', runId: 'unknown-run', nodeId: 'produce', generation: 1,
    inputDigest: digest, leaseEpoch: 1, definition: { adapterId: 'fixture', adapterVersion: '1', principalId: 'owner' },
    resourceKeys: ['resource:a'], authorizationRef: 'approved-scope' } })
  assert.equal((await store.command({ id: 'begin-unknown', kind: 'effect.begin', args: {
    effectId: 'unknown-write', leaseEpoch: 1, expectedSafetyEpoch: 0 } })).dispatchEligible, true)
  await store.command({ id: 'cancel-unknown', kind: 'task.control.cancel', args: {
    taskId: 'unknown-task', expectedControlRevision: 1 } })
  await store.command({ id: 'observe-unknown', kind: 'effect.observe', args: { effectId: 'unknown-write',
    receiptId: 'readback-unknown', status: 'unknown', evidenceRef: 'sha256/readback.json' } })
  assert.equal((await store.query({ kind: 'effect.get', effectId: 'unknown-write' })).state, 'unknown')
  await assert.rejects(store.command({ id: 'new-effect-after-cancel', kind: 'effect.prepare', args: {
    effectId: 'another-write', kind: 'operation', runId: 'unknown-run', nodeId: 'produce', generation: 1,
    inputDigest: digest, leaseEpoch: 1, definition: { adapterId: 'fixture', adapterVersion: '1', principalId: 'owner' },
    resourceKeys: ['resource:b'], authorizationRef: 'approved-scope' } }), { code: 'TASK_DISPATCH_BLOCKED' })
  await assert.rejects(store.command({ id: 'settle-before-readback', kind: 'task.control.settle', args: {
    taskId: 'unknown-task', expectedControlRevision: 2 } }), { code: 'TASK_CONTROL_NOT_DRAINED' })
})

test('同一业务 Task 顺序启动独立 Run；方案确认前开发不启动；恢复重放无重复 Run', async t => {
  const { controller, store } = await setup(t)
  const stages = [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
    { stageId: 'engineering', workflowId: 'implement', gate: 'confirmation' },
  ]
  await controller.createTaskPlan({ commandId: 'plan-create', taskId: 'business', stages })
  assert.deepEqual((await controller.pendingTaskPlans()).map(item => item.taskId), ['business'])
  const starts = await Promise.all([controller.advanceTaskPlan('business'), controller.advanceTaskPlan('business')])
  let plan = starts[0]
  assert.equal(starts[0].stages[0].runId, starts[1].stages[0].runId)
  const firstRun = plan.stages[0].runId
  assert.equal(plan.stages[0].status, 'running')
  assert.equal(plan.stages[1].runId, null)
  await controller.whenIdle(firstRun)
  const completions = await Promise.all([controller.advanceTaskPlan('business'), controller.advanceTaskPlan('business')])
  plan = completions[0]
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal(plan.task.status, 'waiting_confirmation')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'business' })).length, 1)
  await assert.rejects(controller.confirmTaskStage({ commandId: 'bad-confirm', taskId: 'business', planRevision: 1,
    stageId: 'engineering', outputRef: 'sha256/wrong.json' }), { code: 'TASK_CONFIRMATION_OUTPUT_STALE' })
  await controller.confirmTaskStage({ commandId: 'confirm', taskId: 'business', planRevision: 1,
    stageId: 'engineering', outputRef: plan.stages[0].outputRef })
  assert.equal((await controller.advanceTaskPlan('business')).stages[1].runId, null)
  await controller.bindTaskStageInput({ commandId: 'bind', taskId: 'business', planRevision: 1,
    stageId: 'engineering', predecessorOutputRef: plan.stages[0].outputRef, input: 10 })
  plan = await controller.advanceTaskPlan('business')
  const secondRun = plan.stages[1].runId
  assert.notEqual(firstRun, secondRun)
  await controller.whenIdle(secondRun)
  plan = await controller.advanceTaskPlan('business')
  assert.equal(plan.task.status, 'succeeded')
  assert.deepEqual(plan.stages.map(stage => stage.status), ['succeeded', 'succeeded'])
  assert.equal((await store.query({ kind: 'run.list', taskId: 'business' })).length, 2)
  assert.equal((await controller.pendingTaskPlans()).length, 0)
  await controller.advanceTaskPlan('business')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'business' })).length, 2)
})

test('修订只复用已成功前缀，后缀换代并拒绝旧确认', async t => {
  const { controller } = await setup(t)
  const stages = [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
    { stageId: 'engineering', workflowId: 'implement', gate: 'confirmation' },
  ]
  await controller.createTaskPlan({ commandId: 'create', taskId: 'business', stages })
  let plan = await controller.advanceTaskPlan('business')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('business')
  const priorRun = plan.stages[0].runId
  await controller.reviseTaskPlan({ commandId: 'revise', taskId: 'business', expectedPlanRevision: 1,
    requirementRevision: 2, affectedFrom: 1,
    stages: [{ stageId: 'investigation', workflowId: 'investigate' }, stages[1]] })
  plan = await controller.taskPlan('business')
  assert.equal(plan.task.planRevision, 2)
  assert.equal(plan.stages[0].runId, priorRun)
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal(plan.stages[1].attempt, 2)
  await assert.rejects(controller.confirmTaskStage({ commandId: 'old-confirm', taskId: 'business',
    planRevision: 1, stageId: 'engineering', outputRef: plan.stages[0].outputRef }), { code: 'TASK_PLAN_STALE' })
})

test('执行中追加后续阶段不打断当前 Run，阶段完成后只启动一次后继', async t => {
  const { controller, store } = await setup(t)
  await controller.createTaskPlan({ commandId: 'create-active', taskId: 'active-task', stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
  ] })
  let plan = await controller.advanceTaskPlan('active-task')
  const firstRun = plan.stages[0].runId
  await controller.extendTaskPlan({ commandId: 'extend-active', taskId: 'active-task', expectedPlanRevision: 1,
    requirementRevision: 2, stages: [{ stageId: 'implementation', workflowId: 'implement' }] })
  plan = await controller.taskPlan('active-task')
  assert.equal(plan.stages[0].runId, firstRun)
  assert.equal(plan.stages[1].status, 'blocked')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'active-task' })).length, 1)
  await controller.whenIdle(firstRun)
  plan = await controller.advanceTaskPlan('active-task')
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].status, 'ready')
  await controller.bindTaskStageInput({ commandId: 'bind-appended', taskId: 'active-task', planRevision: 1,
    stageId: 'implementation', predecessorOutputRef: plan.stages[0].outputRef, input: 2 })
  plan = await controller.advanceTaskPlan('active-task')
  assert.ok(plan.stages[1].runId)
  await controller.whenIdle(plan.stages[1].runId)
  await controller.advanceTaskPlan('active-task')
  assert.equal((await controller.taskPlan('active-task')).task.status, 'succeeded')
})

test('纯排查完成后可以保留终态 Run，在同一个 Task 的新版计划追加开发', async t => {
  const { controller, store } = await setup(t)
  await controller.createTaskPlan({ commandId: 'investigate-plan', taskId: 'business', stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 3 },
  ] })
  let plan = await controller.advanceTaskPlan('business')
  const investigationRunId = plan.stages[0].runId
  await controller.whenIdle(investigationRunId)
  plan = await controller.advanceTaskPlan('business')
  assert.equal(plan.task.status, 'succeeded')
  assert.equal((await controller.state(investigationRunId)).run.status, 'succeeded')
  await controller.reviseTaskPlan({ commandId: 'continue-plan', taskId: 'business',
    expectedPlanRevision: 1, requirementRevision: 2, affectedFrom: 1, stages: [
      { stageId: 'investigation', workflowId: 'investigate' },
      { stageId: 'engineering', workflowId: 'implement', gate: 'confirmation' },
    ] })
  plan = await controller.taskPlan('business')
  assert.equal(plan.stages[0].runId, investigationRunId)
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  await controller.confirmTaskStage({ commandId: 'confirm-continuation', taskId: 'business',
    stageId: 'engineering', planRevision: 2, outputRef: plan.stages[0].outputRef })
  await assert.rejects(controller.bindTaskStageInput({ commandId: 'stale-input', taskId: 'business',
    stageId: 'engineering', planRevision: 2, predecessorOutputRef: 'sha256/wrong.json', input: 8 }),
  { code: 'TASK_STAGE_PREDECESSOR_STALE' })
  await controller.bindTaskStageInput({ commandId: 'fresh-input', taskId: 'business',
    stageId: 'engineering', planRevision: 2, predecessorOutputRef: plan.stages[0].outputRef, input: 8 })
  plan = await controller.advanceTaskPlan('business')
  assert.notEqual(plan.stages[1].runId, investigationRunId)
  await controller.whenIdle(plan.stages[1].runId)
  plan = await controller.advanceTaskPlan('business')
  assert.equal(plan.task.status, 'succeeded')
  assert.equal((await controller.state(investigationRunId)).run.status, 'succeeded')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'business' })).length, 2)
})

test('未来 UAT 缺适配器保留阻塞阶段；工程 workflow 在交接时绑定确定 Run 身份', async t => {
  const { controller } = await setup(t)
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'business', stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 4 },
    { stageId: 'engineering', workflowId: 'task-engineering', gate: 'confirmation' },
    { stageId: 'uat', workflowId: 'task-uat', unavailableReason: 'UAT adapter 未配置' },
  ] })
  let plan = await controller.advanceTaskPlan('business')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('business')
  const preparedRunId = controller.plannedTaskStageRunId({ taskId: 'business', planRevision: 1,
    stageId: 'engineering', attempt: 1 })
  controller.registerWorkflow(workflow('task-engineering-command'))
  await controller.confirmTaskStage({ commandId: 'confirm', taskId: 'business',
    planRevision: 1, stageId: 'engineering', outputRef: plan.stages[0].outputRef })
  await controller.bindTaskStageInput({ commandId: 'bind', taskId: 'business', planRevision: 1,
    stageId: 'engineering', predecessorOutputRef: plan.stages[0].outputRef,
    workflowId: 'task-engineering-command', input: 6 })
  plan = await controller.advanceTaskPlan('business')
  assert.equal(plan.stages[1].runId, preparedRunId)
  await controller.whenIdle(preparedRunId)
  plan = await controller.advanceTaskPlan('business')
  assert.equal(plan.task.status, 'blocked')
  assert.equal(plan.stages[2].status, 'blocked')
  assert.equal(plan.stages[2].unavailableReason, 'UAT adapter 未配置')
  assert.equal(plan.stages[2].runId, null)
})

test('排查、方案、真人确认、开发、UAT 四阶段沿用同一业务 Task 且逐段交接产物', async t => {
  const { controller, store, artifacts } = await setup(t)
  const taskId = 'four-stage-task'
  const turns = []
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller,
    modelConfig: () => ({}), advanceTask: id => controller.advanceTaskPlan(id),
    authorizeStages: async () => false,
    sessionRunner: { async run({ binding, input, onSessionBound, onCandidate }) {
      await onSessionBound()
      turns.push({ binding, input })
      const complete = input.stages.every(stage => stage.status === 'succeeded')
      const evidenceRefs = input.stages.flatMap(stage => stage.evidenceRefs ?? [])
      const decision = complete
        ? { action: 'complete', summary: '全部阶段有产物', evidenceRefs,
          assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) }
        : { action: 'wait', summary: '等待当前阶段或真人确认', evidenceRefs: [] }
      await onCandidate(decision)
      return { status: 'submitted', decision }
    }, async close() {} } })
  t.after(() => owner.close())
  await controller.createTaskPlan({ commandId: 'four-stage-create', taskId, stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
    { stageId: 'proposal', workflowId: 'investigate' },
    { stageId: 'engineering', workflowId: 'implement', gate: 'confirmation' },
    { stageId: 'uat', workflowId: 'implement' },
  ] })
  await owner.ensure({ taskId, sourceKey: 'fixture-source', criteria: ['完成排查、方案、开发和 UAT'],
    origin: { sourceMessageId: 'fixture-message', actorId: 'authorized-user' } })
  await owner.drive(taskId)
  assert.deepEqual(await owner.applyPending(), [])
  const originalSessionId = (await store.query({ kind: 'task.owner', taskId })).sessionId
  let plan = await controller.advanceTaskPlan(taskId)
  const runIds = []
  for (let index = 0; index < 4; index++) {
    const stage = plan.stages[index]
    if (index > 0) {
      const previous = plan.stages[index - 1]
      assert.equal(previous.status, 'succeeded')
      assert.equal(stage.runId, null)
      if (index === 2) {
        assert.equal(stage.status, 'waiting_confirmation')
        assert.equal((await store.query({ kind: 'run.list', taskId })).length, 2)
        await owner.observe(taskId)
        await owner.drive(taskId)
        assert.deepEqual(await owner.applyPending(), [])
        const confirmationTurn = turns.at(-1)
        assert.equal(confirmationTurn.binding.sessionId, originalSessionId)
        assert.ok(confirmationTurn.input.events.some(event => event.eventType === 'workflow.confirmation.required'
          && event.payload.stageId === 'engineering' && event.payload.runId === null))
        assert.ok(confirmationTurn.input.events.some(event => event.eventType === 'workflow.succeeded'
          && event.payload.stageId === 'proposal' && event.payload.outputRef === previous.outputRef))
        assert.equal((await store.query({ kind: 'run.list', taskId })).length, 2)
        await controller.confirmTaskStage({ commandId: 'four-stage-confirm', taskId, planRevision: 1,
          stageId: stage.stageId, outputRef: previous.outputRef })
      }
      const priorValue = await artifacts.read(previous.outputRef)
      await controller.bindTaskStageInput({ commandId: `four-stage-bind-${index}`, taskId, planRevision: 1,
        stageId: stage.stageId, predecessorOutputRef: previous.outputRef, input: priorValue })
      plan = await controller.advanceTaskPlan(taskId)
    }
    runIds.push(plan.stages[index].runId)
    await controller.whenIdle(runIds[index])
    plan = await controller.advanceTaskPlan(taskId)
    await owner.observe(taskId)
    await owner.drive(taskId)
    assert.deepEqual(await owner.applyPending(), [])
    const ownerTurn = turns.at(-1)
    assert.equal(ownerTurn.binding.taskId, taskId)
    assert.equal(ownerTurn.binding.sessionId, originalSessionId)
    assert.ok(ownerTurn.input.events.some(event => event.eventType === 'workflow.succeeded'
      && event.payload.stageId === plan.stages[index].stageId
      && event.payload.runId === runIds[index]
      && event.payload.outputRef === plan.stages[index].outputRef))
  }
  assert.equal(plan.task.status, 'succeeded')
  assert.deepEqual(plan.stages.map(stage => stage.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded'])
  assert.equal(new Set(runIds).size, 4)
  assert.equal((await store.query({ kind: 'run.list', taskId })).length, 4)
  assert.equal(await artifacts.read(plan.stages[3].outputRef), 5)
  assert.equal((await store.query({ kind: 'task.owner', taskId })).sessionId, originalSessionId)
  assert.ok(turns.length >= 5)
  await controller.advanceTaskPlan(taskId)
  assert.equal((await store.query({ kind: 'run.list', taskId })).length, 4)
})

test('确认间隙取消阻断旧确认和后续 Run；重新打开仍需修订计划', async t => {
  const { controller, store } = await setup(t)
  await controller.createTaskPlan({ commandId: 'control-create', taskId: 'controlled', stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
    { stageId: 'engineering', workflowId: 'implement', gate: 'confirmation' },
  ] })
  let plan = await controller.advanceTaskPlan('controlled')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('controlled')
  assert.equal(plan.task.status, 'waiting_confirmation')
  const cancelled = await store.command({ id: 'task-cancel', kind: 'task.control.cancel',
    args: { taskId: 'controlled', expectedControlRevision: plan.task.controlRevision } })
  assert.equal(cancelled.result.controlState, 'cancelled')
  plan = await controller.advanceTaskPlan('controlled')
  assert.equal(plan.task.status, 'cancelled')
  assert.equal((await store.query({ kind: 'run.list', taskId: 'controlled' })).length, 1)
  await assert.rejects(store.command({ id: 'late-confirm', kind: 'task.plan.confirm', args: {
    taskId: 'controlled', planRevision: 1, stageId: 'engineering', outputRef: plan.stages[0].outputRef,
    expectedControlRevision: 1,
  } }), { code: 'TASK_CONTROL_STALE' })
  await assert.rejects(store.command({ id: 'invalid-reopen-reference', kind: 'task.control.reopen', args: {
    taskId: 'controlled', expectedControlRevision: 2, requirementRevision: 2,
    authorizationRef: '../invalid',
  } }), { code: 'TASK_PLAN_REF_INVALID' })
  const reopened = await store.command({ id: 'valid-reopen-reference', kind: 'task.control.reopen', args: {
    taskId: 'controlled', expectedControlRevision: 2, requirementRevision: 2,
    authorizationRef: 'sha256/authorization.json',
  } })
  assert.equal(reopened.result.controlState, 'active')
  assert.equal(reopened.result.taskStatus, 'blocked')
  assert.equal((await controller.taskPlan('controlled')).task.status, 'blocked')
  await assert.rejects(store.command({ id: 'old-control', kind: 'task.control.resume', args: {
    taskId: 'controlled', expectedControlRevision: 2,
  } }), { code: 'TASK_CONTROL_STALE' })
  await assert.rejects(store.command({ id: 'reopened-old-confirm', kind: 'task.plan.confirm', args: {
    taskId: 'controlled', planRevision: 1, stageId: 'engineering', outputRef: plan.stages[0].outputRef,
    expectedControlRevision: 3,
  } }), { code: 'TASK_CONTROL_STALE' })
})

test('运行中任务级暂停保留已成功 Run 并阻止后继启动，恢复后继续', async t => {
  const { controller, store } = await setup(t)
  await controller.createTaskPlan({ commandId: 'pause-create', taskId: 'pausable', stages: [
    { stageId: 'investigation', workflowId: 'investigate', input: 1 },
    { stageId: 'engineering', workflowId: 'implement' },
  ] })
  let plan = await controller.advanceTaskPlan('pausable')
  assert.equal(plan.stages[0].status, 'running')
  const paused = await store.command({ id: 'task-pause', kind: 'task.control.pause', args: {
    taskId: 'pausable', expectedControlRevision: plan.task.controlRevision,
  } })
  assert.equal(paused.result.controlState, 'pausing')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('pausable')
  assert.equal(plan.task.status, 'paused')
  assert.equal(plan.stages[0].status, 'succeeded')
  assert.equal(plan.stages[1].runId, null)
  assert.equal((await store.query({ kind: 'run.list', taskId: 'pausable' })).length, 1)
  const resumed = await store.command({ id: 'task-resume', kind: 'task.control.resume', args: {
    taskId: 'pausable', expectedControlRevision: plan.task.controlRevision,
  } })
  assert.equal(resumed.result.controlState, 'active')
  await controller.bindTaskStageInput({ commandId: 'bind-after-resume', taskId: 'pausable',
    planRevision: 1, stageId: 'engineering', predecessorOutputRef: plan.stages[0].outputRef, input: 2 })
  plan = await controller.advanceTaskPlan('pausable')
  assert.ok(plan.stages[1].runId)
})

test('任务级恢复同时唤醒被暂停的当前Run', async t => {
  const { controller, store } = await setup(t)
  let started, release
  const began = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  controller.registerWorkflow({ id: 'pausable-run', version: '1', nodes: [{
    id: 'work', version: '1', executor: 'code', allowedEffects: ['pure'],
    inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
    mapInput: ({ requirement }) => requirement,
    execute: async ({ input, signal }) => { calls++; if (calls === 1) { started(); await gate }
      signal.throwIfAborted(); return input + 1 },
  }] })
  t.after(() => release())
  await controller.createTaskPlan({ commandId: 'plan-pause-run', taskId: 'pause-run-task',
    stages: [{ stageId: 'work', workflowId: 'pausable-run', input: 1 }] })
  const initial = await controller.advanceTaskPlan('pause-run-task')
  await began
  await controller.controlTask({ commandId: 'pause-business-run', taskId: 'pause-run-task',
    intent: 'pause', expectedControlRevision: initial.task.controlRevision })
  release()
  await controller.whenIdle(initial.stages[0].runId)
  await controller.advanceTaskPlan('pause-run-task')
  const paused = await controller.taskPlan('pause-run-task')
  assert.equal(paused.task.controlState, 'paused')
  await controller.controlTask({ commandId: 'resume-business-run', taskId: 'pause-run-task',
    intent: 'resume', expectedControlRevision: paused.task.controlRevision })
  await controller.whenIdle(initial.stages[0].runId)
  const state = await store.query({ kind: 'run', runId: initial.stages[0].runId })
  assert.equal(state.run.status, 'succeeded')
  assert.ok(calls >= 2)
})

test('旧单 Run 仅在完整成功且有输出证据时显式纳入业务 Task', async t => {
  const { controller } = await setup(t)
  await controller.createRun({ commandId: 'old-create', taskId: 'legacy-task', runId: 'old-run',
    workflowId: 'investigate', input: 2 })
  await controller.whenIdle('old-run')
  await controller.adoptLegacyTaskPlan({ commandId: 'adopt', taskId: 'legacy-task',
    runId: 'old-run', stageId: 'investigation' })
  const plan = await controller.taskPlan('legacy-task')
  assert.equal(plan.task.status, 'succeeded')
  assert.equal(plan.stages[0].runId, 'old-run')
  assert.ok(plan.stages[0].outputRef)
  assert.ok(plan.stages[0].evidenceRefs.length)
  await assert.rejects(controller.adoptLegacyTaskPlan({ commandId: 'adopt-again', taskId: 'legacy-task',
    runId: 'old-run', stageId: 'investigation' }), { code: 'TASK_PLAN_EXISTS' })
})

test('v4 历史任务空要求可原子补绑要求与 Owner 并保持原计划版本', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-legacy-bind-'))
  const dbPath = join(directory, 'control.sqlite')
  const initial = await openExecutionStore({ dbPath, instanceId: 'legacy-bind', initialize: true })
  await initial.close()
  const db = new DatabaseSync(dbPath)
  const now = new Date().toISOString()
  db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,plan_requirement_revision,status,created_at,updated_at) VALUES('legacy',2,1,2,'active',?,?)").run(now, now)
  db.prepare("INSERT INTO task_controls(task_id,control_revision,state) VALUES('legacy',1,'active')").run()
  db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,gate,status,attempt) VALUES('legacy',1,'stage-1',0,'investigate','none','ready',1)").run()
  db.close()
  const store = await openExecutionStore({ dbPath, instanceId: 'legacy-bind', initialize: false })
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const saved = await artifacts.put({ request: '继续排查原任务', acceptanceCriteria: ['核对原问题'] })
  const args = { taskId: 'legacy', expectedRequirementRevision: 2, requirementRef: saved.ref,
    sessionId: 'owner-legacy', criteria: ['核对原问题'], sourceKey: 'source-legacy', eventKey: 'legacy-bound' }
  const first = await store.command({ id: 'bind-legacy', kind: 'task.requirement.bind-legacy', args })
  assert.equal(first.result.requirementRevision, 2)
  assert.equal((await store.query({ kind: 'task.plan', taskId: 'legacy' })).task.requirementRef, saved.ref)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'legacy' })).sessionId, 'owner-legacy')
  assert.equal((await store.command({ id: 'bind-legacy', kind: 'task.requirement.bind-legacy', args })).replayed, true)
})

test('v1 迁移先零副作用检查，再备份升级并独立读回版本', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-plan-migrate-'))
  const dbPath = join(directory, 'control.sqlite'), instanceId = 'migration-test'
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  await store.command({ id: 'historical-create', kind: 'run.create', args: {
    taskId: 'historical', runId: 'historical-run', workflowId: 'investigate',
    workflowDigest: 'a'.repeat(64), requirementRef: 'sha256/requirement.json',
    nodes: [{ nodeId: 'one', nodeVersion: '1', executor: 'code', inputRef: 'sha256/input.json', inputDigest: 'a'.repeat(64) }],
  } })
  await store.close()
  const raw = new DatabaseSync(dbPath)
  raw.exec(`DROP TABLE task_reports; DROP TABLE task_owner_turns; DROP TABLE task_acceptance_items; DROP TABLE task_events;
    DROP TABLE task_owners; DROP TABLE task_plan_stages; DROP TABLE task_controls;
    DROP TABLE business_tasks; PRAGMA user_version=1;`)
  raw.prepare('UPDATE execution_meta SET schema_version=1 WHERE singleton=1').run()
  raw.close()
  const script = fileURLToPath(new URL('../scripts/migrate-execution-task-plan.js', import.meta.url))
  const check = JSON.parse((await runFile(process.execPath, [script, '--check', dbPath])).stdout)
  assert.equal(check.writable, false)
  const before = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(Object.values(before.prepare('PRAGMA user_version').get())[0], 1)
  before.close()
  const result = JSON.parse((await runFile(process.execPath, [script, '--execute', dbPath])).stdout)
  assert.equal(result.schemaReadback, 2)
  assert.ok(result.backupPath)
  const ownerMigration = fileURLToPath(new URL('../scripts/migrate-task-owner-store.mjs', import.meta.url))
  const ownerCheck = JSON.parse((await runFile(process.execPath, [ownerMigration, '--check', dbPath])).stdout)
  assert.equal(ownerCheck.writes, 0)
  assert.equal(ownerCheck.fromVersion, 2)
  const ownerResult = JSON.parse((await runFile(process.execPath, [ownerMigration, '--execute', dbPath])).stdout)
  assert.equal(ownerResult.schemaReadback, 3)
  assert.ok(ownerResult.backupPath)
  const v4Migration = fileURLToPath(new URL('../scripts/migrate-task-workflow-v4.mjs', import.meta.url))
  const v4Check = JSON.parse((await runFile(process.execPath, [v4Migration, '--check', dbPath])).stdout)
  assert.equal(v4Check.writes, 0)
  const v4Result = JSON.parse((await runFile(process.execPath, [v4Migration, '--execute', dbPath])).stdout)
  assert.equal(v4Result.schemaReadback, 4)
  assert.ok(v4Result.backupPath)
  const reopened = await openExecutionStore({ dbPath, instanceId })
  assert.equal(reopened.info.schemaVersion, 4)
  assert.equal((await reopened.query({ kind: 'run', runId: 'historical-run' })).run.taskId, 'historical')
  await reopened.close()
})
