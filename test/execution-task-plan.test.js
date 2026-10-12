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

async function setup(t, extraWorkflows=[]) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stage-plan-'))
  const dbPath = join(directory, 'control.sqlite'), instanceId = 'plan-test'
  const store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [workflow('investigate'), workflow('implement'), ...extraWorkflows] })
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
  assert.equal(plan.task.status, 'pending')
  assert.equal(plan.task.planStatus, 'succeeded')
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
  assert.equal(plan.task.status, 'pending')
  assert.equal(plan.task.planStatus, 'succeeded')
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
  await assert.rejects(store.command({ id: 'candidate-fence-owner', kind: 'task.owner.candidate', args: {
    taskId: 'fence-task', turnId: 'turn-fence-owner', leaseEpoch: claim.leaseEpoch,
    decision: { action: 'complete', summary: '错误地宣称完成', evidenceRefs: [plan.stages[0].outputRef],
      assessments: [{ itemId: 'acceptance-1', status: 'satisfied', evidenceRefs: [plan.stages[0].outputRef] }] },
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
    sessionRunner: { async run({ binding, input, onSessionBound, onCandidate, readArtifact }) {
      await onSessionBound()
      const events = await Promise.all(input.events.map(async event => ({ ...event,
        payload: event.payloadRef ? await readArtifact(event.payloadRef) : null })))
      turns.push({ binding, input: { ...input, events } })
      const complete = input.stages.every(stage => stage.status === 'succeeded')
      const evidenceRefs = input.stages.flatMap(stage => stage.evidenceRefs ?? [])
      const decision = complete
        ? { action: 'complete', summary: '全部阶段有产物', evidenceRefs,
          assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs })) }
        : { action: 'wait', summary: '等待当前阶段或真人确认', evidenceRefs: [], condition: {
          kind: 'execution', missing: '当前阶段或真人确认尚未完成', responsibleParty: '阶段执行方或确认人',
          resumeWhen: '阶段完成或取得真人确认', evidenceRefs: [] } }
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
      && event.payload?.stageId === plan.stages[index].stageId
      && event.payload.runId === runIds[index]
      && event.payload.outputRef === plan.stages[index].outputRef))
  }
  plan = await controller.taskPlan(taskId)
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
  raw.exec(`DROP TABLE message_topic_facts; DROP TABLE task_reports; DROP TABLE task_owner_turns; DROP TABLE task_acceptance_items; DROP TABLE task_events;
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
  const v5Migration = fileURLToPath(new URL('../scripts/migrate-message-topic-facts.js', import.meta.url))
  const v5Check = JSON.parse((await runFile(process.execPath, [v5Migration, '--check', dbPath])).stdout)
  assert.equal(v5Check.writable, false)
  assert.equal(v5Check.fromVersion, 4)
  const v5Result = JSON.parse((await runFile(process.execPath, [v5Migration, '--execute', dbPath])).stdout)
  assert.equal(v5Result.toVersion, 5)
  assert.ok(v5Result.backupPath)
  const v6Migration = fileURLToPath(new URL('../scripts/migrate-message-impact.js', import.meta.url))
  const v6Check = JSON.parse((await runFile(process.execPath, [v6Migration, '--check', dbPath])).stdout)
  assert.equal(v6Check.writable, false)
  await runFile(process.execPath, [v6Migration, '--execute', dbPath])
  await assert.rejects(openExecutionStore({ dbPath, instanceId }), {code:'STORE_SCHEMA_MISMATCH'})
  const inspected = new DatabaseSync(dbPath,{readOnly:true})
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version,6)
  assert.equal(inspected.prepare("SELECT task_id FROM execution_runs WHERE run_id='historical-run'").get().task_id,'historical')
  inspected.close()
})

test('同Task两条测试后等待指定发送人验收，精确阶段条件与产物版本不可冒用', async t => {
  const { controller, store, artifacts } = await setup(t)
  const { executionDigest } = await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
  const body = '先执行两条测试数据，我验证通过后，再刷69条正式数据'
  await store.command({ id: 'receive-stage-condition', kind: 'message.receive', args: { runId: 'stage-source', sourceKey: 'stage-source', sourceVersion: 1,
    actorId: 'lichen', conversationId: 'group', body, context: {}, policy: {} } })
  const condition = { sourceKey: 'stage-source', sourceVersion: 1, sourceQuote: body, objective: '刷69条正式数据', requiredActorId: 'lichen' }
  await controller.createTaskPlan({ commandId: 'condition-plan', taskId: 'condition-task', stages: [
    { stageId: 'test-two', workflowId: 'implement', input: 2, sourceCondition: { sourceKey: 'stage-source', sourceVersion: 1, sourceQuote: body, objective: '执行两条测试数据' } },
    { stageId: 'formal-69', workflowId: 'implement', gate: 'confirmation', sourceCondition: condition },
  ] })
  let plan = await controller.advanceTaskPlan('condition-task')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('condition-task')
  assert.deepEqual(plan.stages[1].sourceCondition, condition)
  assert.equal(plan.stages[1].status, 'waiting_confirmation')
  assert.equal(plan.stages[1].runId, null)
  assert.equal((await store.query({ kind: 'run.list', taskId: 'condition-task' })).length, 1)
  const confirm = { taskId: 'condition-task', planRevision: 1, stageId: 'formal-69', expectedRequirementRevision: 1, outputRef: plan.stages[0].outputRef }
  await assert.rejects(controller.confirmTaskStage({ ...confirm, commandId: 'missing-source-confirm' }), { code: 'TASK_CONFIRMATION_SOURCE_REQUIRED' })
  await store.command({ id: 'receive-wrong-confirm', kind: 'message.receive', args: { runId: 'wrong-confirm', sourceKey: 'wrong-confirm', sourceVersion: 1,
    actorId: 'other', conversationId: 'group', body: '验证通过', context: {}, policy: {} } })
  await assert.rejects(controller.confirmTaskStage({ ...confirm, commandId: 'wrong-actor-confirm', confirmation: { conditionDigest: executionDigest(condition), actorId: 'other', sourceKey: 'wrong-confirm', sourceVersion: 1 } }), { code: 'TASK_CONFIRMATION_SOURCE_REQUIRED' })
  await store.command({ id: 'receive-good-confirm', kind: 'message.receive', args: { runId: 'good-confirm', sourceKey: 'good-confirm', sourceVersion: 1,
    actorId: 'lichen', conversationId: 'group', body: '两条测试已验证通过，继续正式69条', context: {}, policy: {} } })
  const confirmation = { conditionDigest: executionDigest(condition), actorId: 'lichen', sourceKey: 'good-confirm', sourceVersion: 1 }
  await assert.rejects(controller.confirmTaskStage({ ...confirm, commandId: 'stale-condition-confirm', confirmation: { ...confirmation, conditionDigest: '0'.repeat(64) } }), { code: 'TASK_CONFIRMATION_SOURCE_REQUIRED' })
  await assert.rejects(controller.confirmTaskStage({ ...confirm, commandId: 'stale-output-confirm', outputRef: 'sha256/wrong.json', confirmation }), { code: 'TASK_CONFIRMATION_OUTPUT_STALE' })
  await controller.confirmTaskStage({ ...confirm, commandId: 'good-condition-confirm', confirmation })
  await controller.bindTaskStageInput({ commandId: 'bind-69', taskId: 'condition-task', planRevision: 1, stageId: 'formal-69', predecessorOutputRef: plan.stages[0].outputRef, input: 69 })
  plan = await controller.advanceTaskPlan('condition-task')
  await controller.whenIdle(plan.stages[1].runId)
  plan = await controller.advanceTaskPlan('condition-task')
  assert.equal(plan.task.status, 'succeeded')
  assert.equal(await artifacts.read(plan.stages[1].outputRef), 70)
  assert.equal((await store.query({ kind: 'run.list', taskId: 'condition-task' })).length, 2)
})

for (const viaOwner of [false, true]) test(`必要工程依赖插入保留等待Run和成功前缀，完成后返回原阶段 owner=${viaOwner}`, async t => {
  let { controller, store, artifacts, dbPath, instanceId } = await setup(t)
  const frontend = { ...workflow('task-engineering-frontend'), nodes: [
    { ...workflow('unused').nodes[0], id: 'prepare' },
    { ...workflow('unused').nodes[0], id: 'accept', execute: async () => { throw Object.assign(new Error('backend missing'), { code: 'LOCAL_ACCEPTANCE_PLAN_INVALID' }) } },
  ] }
  controller.registerWorkflow(frontend)
  controller.registerWorkflow(workflow('task-engineering-backend'))
  const body = '开发生产活动合并结果和失败明细下载，提测UAT3'
  await store.command({ id: 'dependency-source', kind: 'message.receive', args: { runId: 'dependency-source', sourceKey: 'dependency-source', sourceVersion: 1,
    actorId: 'requester', conversationId: 'group', body, context: {}, policy: {} } })
  await controller.createTaskPlan({ commandId: 'dependency-plan', taskId: 'dependency-task', stages: [
    { stageId: 'frontend', workflowId: frontend.id, input: 2 },
  ] })
  let plan = await controller.advanceTaskPlan('dependency-task')
  const originalRunId = plan.stages[0].runId
  await controller.whenIdle(originalRunId)
  const original = await controller.state(originalRunId)
  assert.equal(original.run.status, 'waiting')
  assert.equal(original.nodes[0].status, 'succeeded')
  const request = { commandId: 'insert-backend', taskId: 'dependency-task', expectedPlanRevision: 1, expectedControlRevision: 1,
    requirementRevision: 1, beforeStageId: 'frontend', stage: { stageId: 'backend', workflowId: 'task-engineering-backend', input: 2,
      sourceCondition: { sourceKey: 'dependency-source', sourceVersion: 1, sourceQuote: body, objective: '失败明细下载', repositoryId: 'dataset', acceptanceCriteria: ['真实导出API返回失败组明细Excel'] } } }
  await assert.rejects(controller.insertTaskDependency({ ...request, commandId: 'stale-dependency', requirementRevision: 2 }), { code: 'TASK_PLAN_STALE' })
  await assert.rejects(controller.insertTaskDependency({ ...request, commandId: 'foreign-source', stage: { ...request.stage,
    sourceCondition: { ...request.stage.sourceCondition, sourceVersion: 2 } } }), { code: 'TASK_STAGE_SOURCE_CONDITION_INVALID' })
  if (viaOwner) {
    const decision = { action: 'advance', summary: '原需求失败明细下载需要真实后端导出实现，先完成此必要依赖再继续原前端', evidenceRefs: [],
      planChange: { kind: 'insertDependency', stages: [{ workflowId: 'task-engineering', gate: 'none', sourceCondition: request.stage.sourceCondition }] } }
    const owner = createTaskOwnerController({ctx:{},store,artifacts,controller,modelConfig:()=>({}),advanceTask:id=>controller.advanceTaskPlan(id),
      authorizeStages:async({stages})=>stages[0].sourceCondition.repositoryId==='dataset',
      prepareInitialStage:async()=>({workflowId:'task-engineering-backend',input:2}),
      sessionRunner:{async run({onSessionBound,onCandidate}){await onSessionBound();await onCandidate(decision);return {status:'submitted',decision}},async close(){}}})
    t.after(()=>owner.close())
    await owner.ensure({taskId:'dependency-task',sourceKey:'dependency-source',criteria:['真实前后端完成'],origin:{actorId:'requester'}})
    await owner.drive('dependency-task')
    assert.deepEqual(await owner.applyPending(),[])
    // Owner 使用自动分配stage-2，测试后续按持久身份读取，不假设模型指定ID。
    request.stage.stageId='stage-2'
  } else {
    await controller.insertTaskDependency(request)
    assert.deepEqual((await controller.insertTaskDependency(request)).result, await store.query({ kind: 'receipt', commandId: 'insert-backend' }).then(receipt => receipt.result))
  }
  plan = await controller.taskPlan('dependency-task')
  assert.equal(plan.stages[0].stageId,request.stage.stageId)
  assert.equal(plan.stages[1].status,'blocked')
  assert.equal(plan.stages[1].runId, originalRunId)
  await assert.rejects(controller.insertTaskDependency({ ...request, commandId: 'duplicate-dependency', stage: { ...request.stage, stageId: 'another-backend' } }), { code: 'TASK_DEPENDENCY_INVALID' })
  await assert.rejects(controller.recover({ commandId: 'resume-suspended-frontend', runId: originalRunId }), { code: 'TASK_DEPENDENCY_PENDING' })
  assert.deepEqual((await controller.state(originalRunId)).nodes, original.nodes)
  assert.deepEqual((await controller.state(originalRunId)).nodes, original.nodes)
  if (!viaOwner) {
    await controller.close();await store.close()
    store=await openExecutionStore({dbPath,instanceId})
    controller=createExecutionController({store,artifacts,workflows:[frontend,workflow('task-engineering-backend')]})
    const reopenedController=controller,reopenedStore=store
    t.after(async()=>{await reopenedController.close();await reopenedStore.close()})
    assert.equal((await controller.state(originalRunId)).run.recoveryReason,'stage-dependency')
  }
  plan = await controller.advanceTaskPlan('dependency-task')
  await controller.whenIdle(plan.stages[0].runId)
  await controller.advanceTaskPlan('dependency-task')
  plan = await controller.taskPlan('dependency-task')
  assert.equal(plan.stages[1].status, 'running')
  assert.equal(plan.stages[1].runId, originalRunId)
  assert.deepEqual((await controller.state(originalRunId)).nodes, original.nodes)
  await controller.recover({commandId:'continue-original-after-backend',runId:originalRunId})
  await controller.whenIdle(originalRunId)
  const continued=await controller.state(originalRunId)
  assert.deepEqual(continued.nodes[0],original.nodes[0])
  assert.equal(continued.nodes[1].leaseEpoch,original.nodes[1].leaseEpoch+1)
  assert.equal(continued.run.generation,original.run.generation)
  if (!viaOwner) { await controller.close();await store.close() }
})

test('必要依赖拒绝活跃节点与新输入，未改原Run或阶段', async t => {
 const {controller,store,artifacts,dbPath}=await setup(t)
 let release, entered
 const gate=new Promise(resolve=>{release=resolve}), started=new Promise(resolve=>{entered=resolve})
 t.after(()=>release())
 controller.registerWorkflow({...workflow('task-engineering-busy'),nodes:[{...workflow('x').nodes[0],execute:async()=>{entered();await gate;throw Error('needs backend')}}]})
 controller.registerWorkflow(workflow('task-engineering-needed'))
 const body='实现失败明细下载'
 await store.command({id:'busy-source',kind:'message.receive',args:{runId:'busy-source',sourceKey:'busy-source',sourceVersion:1,actorId:'human',conversationId:'group',body,context:{},policy:{}}})
 await controller.createTaskPlan({commandId:'busy-plan',taskId:'busy-task',stages:[{stageId:'frontend',workflowId:'task-engineering-busy',input:1}]})
 const plan=await controller.advanceTaskPlan('busy-task');await started
 const runId=plan.stages[0].runId
 const request={commandId:'insert-busy',taskId:'busy-task',expectedPlanRevision:1,expectedControlRevision:1,requirementRevision:1,beforeStageId:'frontend',stage:{stageId:'dependency',workflowId:'task-engineering-needed',input:1,sourceCondition:{sourceKey:'busy-source',sourceVersion:1,sourceQuote:body,objective:body,repositoryId:'dataset',acceptanceCriteria:['真实下载']}}}
 await assert.rejects(controller.insertTaskDependency(request),{code:'TASK_DEPENDENCY_NOT_DRAINED'})
 release();await controller.whenIdle(runId)
 // 仅隔离fixture模拟曾发出但尚未对账的效果，生产路径不写SQL。
 const node=(await controller.state(runId)).nodes[0], fixtureDb=new DatabaseSync(dbPath)
 try {
  fixtureDb.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at)
   VALUES('unknown-effect','operation',?,?,?,?,?,'digest','{}','[]','auth','unknown','now','now')`).run(runId,node.nodeRunId,node.nodeId,node.generation,node.inputDigest)
  await assert.rejects(controller.insertTaskDependency({...request,commandId:'insert-unknown-effect'}),{code:'run_effects_not_drained'})
  fixtureDb.prepare("DELETE FROM execution_effects WHERE effect_id='unknown-effect'").run()
 } finally {fixtureDb.close()}

 const replacement=await artifacts.put(2)
 await store.command({id:'new-business-input',kind:'input.accept',args:{runId,inputId:'new-input',sourceKey:'web:change',requirementRef:replacement.ref}})
 await assert.rejects(controller.insertTaskDependency({...request,commandId:'insert-pending'}),{code:'TASK_DEPENDENCY_NOT_DRAINED'})
 assert.equal((await controller.taskPlan('busy-task')).stages.length,1)
 assert.notEqual((await controller.state(runId)).run.recoveryReason,'stage-dependency')
})

for(const late of [false,true])test(`new requirement keeps old successful Run immutable; late completion=${late}`,async t=>{
 const {controller,store,artifacts}=await setup(t);
 const first=await artifacts.put(1);await store.command({id:'accept-revised-success',kind:'task.accept',args:{taskId:'revised-success',requirementRef:first.ref,requirementRevision:1,sessionId:'owner-revised-success',criteria:['result 2'],sourceKey:'source-revised-success',eventKey:'created-revised-success'}});
 await controller.initializeTaskPlan({commandId:'create-revised-success',taskId:'revised-success',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'first',workflowId:'investigate',input:1}]});
 let plan=await controller.advanceTaskPlan('revised-success');const runId=plan.stages[0].runId;await controller.whenIdle(runId);
 if(!late)plan=await controller.advanceTaskPlan('revised-success');
 const history=await store.query({kind:'run',runId});const before=await controller.taskPlan('revised-success');const replacement=await artifacts.put(2);
 await store.command({id:'new-success-requirement',kind:'task.requirement.update',args:{taskId:'revised-success',expectedRequirementRevision:1,requirementRef:replacement.ref,eventKey:'new-success-requirement'}});
 if(late)await store.command({id:'late-old-completion',kind:'task.stage.complete',args:{taskId:'revised-success',planRevision:1,stageId:'first',runId}});
 const current=await controller.taskPlan('revised-success');assert.equal(current.task.status,'pending');assert.equal(current.task.requirementRevision,2);assert.equal(current.task.planRequirementRevision,1);assert.equal(current.task.controlRevision,before.task.controlRevision);
 assert.deepEqual(await store.query({kind:'run',runId}),history);assert.equal((await store.query({kind:'run.list',taskId:'revised-success'})).length,1);
});



test('completion correction refuses active task, stale declaration and running Owner without rewriting cancellation receipts',async t=>{
 const {store,artifacts,controller}=await setup(t);const requirement=await artifacts.put({request:'manually handled topic'});await store.command({id:'accept-user-confirmation',kind:'task.accept',args:{taskId:'confirmed-topic',requirementRevision:1,requirementRef:requirement.ref,sessionId:'owner-confirmed-topic',sourceKey:'source-user',criteria:['manual completion'],eventKey:'created-topic'}});const args={taskId:'confirmed-topic',expectedControlRevision:1,expectedRequirementRevision:1,actorId:'owner',topicId:'original-topic',declaration:'User declares manually handled task complete; no engineering verification.'};await assert.rejects(store.command({id:'active-must-not-complete',kind:'task.completion.confirm',args}),{code:'TASK_COMPLETION_CORRECTION_UNSAFE'});await store.command({id:'running-owner',kind:'task.owner.claim',args:{taskId:args.taskId,turnId:'inflight-owner',expectedLeaseEpoch:0}});const cancellation=await controller.controlTask({commandId:'cancel-topic',taskId:args.taskId,intent:'cancel',expectedControlRevision:1});const plan=await controller.taskPlan(args.taskId);assert.equal(plan.task.controlState,'cancelled');await assert.rejects(store.command({id:'stale-completion',kind:'task.completion.confirm',args}),{code:'TASK_COMPLETION_STALE'});await assert.rejects(store.command({id:'running-must-not-complete',kind:'task.completion.confirm',args:{...args,expectedControlRevision:plan.task.controlRevision}}),{code:'TASK_COMPLETION_CORRECTION_UNSAFE'});assert.equal((await controller.taskPlan(args.taskId)).task.status,'cancelled');assert.deepEqual((await store.query({kind:'receipt',commandId:'cancel-topic'})).result,cancellation.receipt.result);assert.equal((await store.query({kind:'run.list',taskId:args.taskId})).length,0);
});


test('user-declared no-plan completion survives real Store close and cold reopen without reopening execution', async t => {
 const directory=await mkdtemp(join(tmpdir(),'completion-cold-'));const dbPath=join(directory,'control.sqlite');let store;
 t.after(async()=>{await store?.close();await rm(directory,{recursive:true,force:true})});
 store=await openExecutionStore({dbPath,instanceId:'completion-cold',initialize:true});
 await store.command({id:'accept-cold',kind:'task.accept',args:{taskId:'cold-task',requirementRef:'requirement.json',requirementRevision:1,sessionId:'owner-cold',criteria:['manual'],sourceKey:'cold-source',eventKey:'cold-created'}});
 await store.command({id:'cancel-cold',kind:'task.control.cancel',args:{taskId:'cold-task',expectedControlRevision:1}});
 const before=await store.query({kind:'task.plan',taskId:'cold-task'});
 await store.command({id:'confirm-cold',kind:'task.completion.confirm',args:{taskId:'cold-task',expectedControlRevision:before.task.controlRevision,expectedRequirementRevision:1,actorId:'owner',topicId:'original-topic',declaration:'User confirms complete.'}});
 const expected=await store.query({kind:'task.plan',taskId:'cold-task'});await store.close();store=null;
 store=await openExecutionStore({dbPath,instanceId:'completion-cold'});assert.deepEqual(await store.query({kind:'task.plan',taskId:'cold-task'}),expected);assert.equal(expected.task.status,'succeeded');assert.equal(expected.task.controlState,'paused');assert.deepEqual(expected.stages,[]);assert.equal((await store.query({kind:'run.list',taskId:'cold-task'})).length,0);
 await store.close();store=null;
 // Invalid synthetic persisted completions must retain the original startup invariant.
 for(const scenario of ['audit-missing','requirement-mismatch','execution-active']){
  const db=new DatabaseSync(dbPath);db.exec('BEGIN');
  if(scenario==='audit-missing')db.prepare("DELETE FROM execution_events WHERE kind='task.completion.confirmed'").run();
  if(scenario==='requirement-mismatch')db.prepare('UPDATE business_tasks SET requirement_revision=2').run();
  if(scenario==='execution-active')db.prepare("UPDATE task_controls SET state='active'").run();
  const {validateTaskPlanSchema}=await import('../packages/dingtalk-dsh-assistant/execution-task-plan.js');assert.throws(()=>validateTaskPlanSchema(db),{code:'TASK_PLAN_INVARIANT_FAILED'},scenario);db.exec('ROLLBACK');db.close();
 }
});

for(const blocker of [null,'not-paused','not-drained','same-requirement','engineering','effect'])test(`replace stopped no-effect publication suffix, blocker=${blocker}`,async t=>{
 const id=blocker==='engineering'?'task-engineering-test':'task-uat-pr-merge'
 const w=workflow(id);w.nodes[0].execute=async()=>{throw new Error('EXPECTED_PREFLIGHT_FAILURE')}
 const {store,artifacts,controller,dbPath}=await setup(t,[w]);const first=await artifacts.put(1)
 await store.command({id:'accept-paused-publication',kind:'task.accept',args:{taskId:'paused-publication',requirementRef:first.ref,requirementRevision:1,sessionId:'owner-paused-publication',criteria:['actual publication'],sourceKey:'source-publication',eventKey:'created-publication'}})
 await controller.initializeTaskPlan({commandId:'init-paused-publication',taskId:'paused-publication',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'publish',workflowId:id,input:1}]})
 const plan=await controller.advanceTaskPlan('paused-publication'),runId=plan.stages[0].runId;await controller.whenIdle(runId)
 await controller.pause({commandId:'pause-publication',runId,reason:'wrong candidate, no effects'})
 if(blocker!=='same-requirement'){const updated=await artifacts.put(2);await store.command({id:'update-publication',kind:'task.requirement.update',args:{taskId:'paused-publication',expectedRequirementRevision:1,requirementRef:updated.ref,eventKey:'updated-publication'}})}
 const db=new DatabaseSync(dbPath)
 try{
  db.prepare("UPDATE execution_runs SET status='waiting',pause_requested=1,stop_requested=0 WHERE run_id=?").run(runId)
  if(blocker==='not-paused')db.prepare('UPDATE execution_runs SET pause_requested=0 WHERE run_id=?').run(runId)
  if(blocker==='not-drained')db.prepare('UPDATE execution_nodes SET drained=0 WHERE run_id=?').run(runId)
  if(blocker==='effect'){
   const n=db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1').get(runId)
   db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('effect-publication','operation',runId,n.node_run_id,n.node_id,1,'a'.repeat(64),'b'.repeat(64),'{}','[]','test-authority','failed',new Date().toISOString(),new Date().toISOString())
  }
 }finally{db.close()}
 const request={commandId:'revise-paused-publication',taskId:'paused-publication',expectedPlanRevision:1,expectedControlRevision:1,requirementRevision:blocker==='same-requirement'?1:2,affectedFrom:0,stages:[{stageId:'publish',workflowId:id,input:2}]}
 if(blocker){await assert.rejects(controller.reviseTaskPlan(request),{code:'TASK_STAGE_STILL_RUNNING'});assert.equal((await controller.taskPlan('paused-publication')).task.planRevision,1)}
 else {await controller.reviseTaskPlan(request);const current=await controller.taskPlan('paused-publication');assert.equal(current.task.planRevision,2);assert.equal(current.stages[0].attempt,2);assert.equal((await controller.state(runId)).run.status,'cancelled');assert.equal((await controller.state(runId)).nodes[0].evidenceRefs.length>0,true)}
})

for(const affectedFrom of [0,1])test(`no-effect publication suffix preserves completed effect prefix, affectedFrom=${affectedFrom}`,async t=>{
 const w=workflow('task-uat-pr-merge');w.nodes[0].execute=async()=>{throw new Error('EXPECTED_PREFLIGHT_FAILURE')}
 const {store,artifacts,controller,dbPath}=await setup(t,[w]);const goal=await artifacts.put(1)
 await store.command({id:'accept-effect-prefix',kind:'task.accept',args:{taskId:'effect-prefix',requirementRef:goal.ref,requirementRevision:1,sessionId:'owner-effect-prefix',criteria:['actual publication'],sourceKey:'source-effect-prefix',eventKey:'created-effect-prefix'}})
 await controller.initializeTaskPlan({commandId:'init-effect-prefix',taskId:'effect-prefix',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'done',workflowId:'investigate',input:1},{stageId:'publish',workflowId:'task-uat-pr-merge'}]})
 let plan=await controller.advanceTaskPlan('effect-prefix');const prefixRunId=plan.stages[0].runId;await controller.whenIdle(prefixRunId);plan=await controller.advanceTaskPlan('effect-prefix');const prefix=structuredClone(plan.stages[0])
 await controller.bindTaskStageInput({commandId:'bind-publication',taskId:'effect-prefix',planRevision:1,expectedControlRevision:1,stageId:'publish',predecessorOutputRef:prefix.outputRef,input:2})
 plan=await controller.advanceTaskPlan('effect-prefix');const pausedRunId=plan.stages[1].runId;await controller.whenIdle(pausedRunId);await controller.pause({commandId:'stop-publication',runId:pausedRunId,reason:'wrong old candidate'})
 const updated=await artifacts.put(3);await store.command({id:'update-effect-prefix',kind:'task.requirement.update',args:{taskId:'effect-prefix',expectedRequirementRevision:1,requirementRef:updated.ref,eventKey:'updated-effect-prefix'}})
 const db=new DatabaseSync(dbPath)
 try{
  const n=db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1').get(prefixRunId)
  db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('prefix-effect','operation',prefixRunId,n.node_run_id,n.node_id,1,'a'.repeat(64),'b'.repeat(64),'{}','[]','test-authority','succeeded',new Date().toISOString(),new Date().toISOString())
  db.prepare("UPDATE execution_runs SET status='waiting',pause_requested=1,stop_requested=0 WHERE run_id=?").run(pausedRunId)
 }finally{db.close()}
 const request={commandId:'replace-effect-prefix',taskId:'effect-prefix',expectedPlanRevision:1,expectedControlRevision:1,requirementRevision:2,affectedFrom,stages:[{stageId:'done',workflowId:'investigate',...(affectedFrom===0?{input:3}:{})},{stageId:'publish',workflowId:'task-uat-pr-merge'}]}
 if(affectedFrom===0){await assert.rejects(controller.reviseTaskPlan(request),{code:'TASK_PLAN_IMPACT_INVALID'});assert.equal((await controller.taskPlan('effect-prefix')).task.planRevision,1);assert.equal((await controller.state(pausedRunId)).run.status,'waiting')}
 else {await controller.reviseTaskPlan(request);assert.equal((await controller.taskPlan('effect-prefix')).task.planRevision,2);assert.equal((await controller.state(pausedRunId)).run.status,'cancelled')}
 const current=await controller.taskPlan('effect-prefix');assert.deepEqual(current.stages[0],prefix);assert.equal((await controller.state(prefixRunId)).run.status,'succeeded');assert.equal((await store.query({kind:'effect.list',runId:prefixRunId})).length,1)
})

test('new owner-managed flow stays pending until the original session explicitly completes; replay and historical done stay stable', async t => {
  const {store, artifacts, controller}=await setup(t)
  const goal=await artifacts.put(3)
  await store.command({id:'completion-create',kind:'task.accept',args:{taskId:'completion-task',requirementRef:goal.ref,requirementRevision:1,sessionId:'original-session',criteria:['result reviewed'],sourceKey:'source',eventKey:'created'}})
  await controller.initializeTaskPlan({commandId:'completion-plan',taskId:'completion-task',expectedPlanRevision:0,expectedRequirementRevision:1,stages:[{stageId:'first',workflowId:'investigate',input:3}]})
  let plan=await controller.advanceTaskPlan('completion-task');await controller.whenIdle(plan.stages[0].runId);plan=await controller.advanceTaskPlan('completion-task')
  assert.equal(plan.stages[0].status,'succeeded');assert.equal(plan.task.planStatus,'succeeded');assert.equal(plan.task.status,'pending')
  const claim=(await store.command({id:'completion-claim',kind:'task.owner.claim',args:{taskId:'completion-task',turnId:'review',expectedLeaseEpoch:0}})).result
  await store.command({id:'completion-bound',kind:'task.owner.sessionBound',args:{taskId:'completion-task',turnId:'review',leaseEpoch:claim.leaseEpoch,sessionId:'original-session'}})
  const evidenceRefs=[plan.stages[0].outputRef]
  await store.command({id:'completion-candidate',kind:'task.owner.candidate',args:{taskId:'completion-task',turnId:'review',leaseEpoch:claim.leaseEpoch,decision:{action:'complete',summary:'whole task explicitly reviewed',evidenceRefs,assessments:[{itemId:'acceptance-1',status:'satisfied',evidenceRefs}]}}})
  await store.command({id:'completion-accept',kind:'task.owner.accept',args:{taskId:'completion-task',turnId:'review',leaseEpoch:claim.leaseEpoch}})
  assert.equal((await controller.taskPlan('completion-task')).task.status,'pending')
  const applied={id:'completion-applied',kind:'task.owner.applied',args:{taskId:'completion-task',turnId:'review',leaseEpoch:claim.leaseEpoch}}
  await store.command(applied);plan=await controller.taskPlan('completion-task');assert.equal(plan.task.status,'succeeded')
  await store.command(applied);await controller.advanceTaskPlan('completion-task');assert.deepEqual(await controller.taskPlan('completion-task'),plan)
  await controller.createTaskPlan({commandId:'legacy-plan',taskId:'legacy-done',stages:[{stageId:'first',workflowId:'investigate',input:3}]})
  let legacy=await controller.advanceTaskPlan('legacy-done');await controller.whenIdle(legacy.stages[0].runId);legacy=await controller.advanceTaskPlan('legacy-done')
  assert.equal(legacy.task.status,'succeeded');await controller.advanceTaskPlan('legacy-done');assert.deepEqual(await controller.taskPlan('legacy-done'),legacy)
})

test('accepted session completion cannot finish a newer requirement', async t => {
  const {store,artifacts,controller}=await setup(t)
  const goal=await artifacts.put(3)
  await store.command({id:'stale-completion-create',kind:'task.accept',args:{taskId:'stale-completion',requirementRef:goal.ref,requirementRevision:1,sessionId:'original-stale-session',criteria:['review result'],sourceKey:'source',eventKey:'created'}})
  await controller.initializeTaskPlan({commandId:'stale-completion-plan',taskId:'stale-completion',expectedPlanRevision:0,expectedRequirementRevision:1,stages:[{stageId:'first',workflowId:'investigate',input:3}]})
  let plan=await controller.advanceTaskPlan('stale-completion');await controller.whenIdle(plan.stages[0].runId);plan=await controller.advanceTaskPlan('stale-completion')
  const claim=(await store.command({id:'stale-completion-claim',kind:'task.owner.claim',args:{taskId:'stale-completion',turnId:'review',expectedLeaseEpoch:0}})).result
  await store.command({id:'stale-completion-bound',kind:'task.owner.sessionBound',args:{taskId:'stale-completion',turnId:'review',leaseEpoch:claim.leaseEpoch,sessionId:'original-stale-session'}})
  const evidenceRefs=[plan.stages[0].outputRef]
  await store.command({id:'stale-completion-candidate',kind:'task.owner.candidate',args:{taskId:'stale-completion',turnId:'review',leaseEpoch:claim.leaseEpoch,decision:{action:'complete',summary:'old goal complete',evidenceRefs,assessments:[{itemId:'acceptance-1',status:'satisfied',evidenceRefs}]}}})
  await store.command({id:'stale-completion-accept',kind:'task.owner.accept',args:{taskId:'stale-completion',turnId:'review',leaseEpoch:claim.leaseEpoch}})
  const next=await artifacts.put(5)
  await store.command({id:'stale-completion-update',kind:'task.requirement.update',args:{taskId:'stale-completion',expectedRequirementRevision:1,requirementRef:next.ref,eventKey:'new-goal'}})
  await assert.rejects(store.command({id:'stale-completion-apply',kind:'task.owner.applied',args:{taskId:'stale-completion',turnId:'review',leaseEpoch:claim.leaseEpoch}}),{code:'TASK_OWNER_CANDIDATE_STALE'})
  assert.equal((await controller.taskPlan('stale-completion')).task.status,'pending')
})


test('新要求恢复任务只唤醒Owner，不恢复旧计划暂停Run或重放开发',async t=>{
 let executions=0
 const stopped=workflow('old-development');stopped.nodes[0].execute=async()=>{executions++;throw new Error('EXPECTED_OLD_STOP')}
 const {store,artifacts,controller,dbPath}=await setup(t,[stopped])
 await store.command({id:'old-round-accept',kind:'task.accept',args:{taskId:'new-round-resume',requirementRef:(await artifacts.put(1)).ref,requirementRevision:1,sessionId:'original-owner',criteria:['Current authorized delivery'],sourceKey:'original-source',eventKey:'created'}})
 await controller.initializeTaskPlan({commandId:'old-development-plan',taskId:'new-round-resume',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'develop',workflowId:'old-development',input:1}]})
 const started=await controller.advanceTaskPlan('new-round-resume'),runId=started.stages[0].runId
 await controller.whenIdle(runId)
 await controller.pause({commandId:'old-run-pause',runId,reason:'Old round stopped before publication'})
 const db=new DatabaseSync(dbPath)
 // Exact drained paused checkpoint in this disposable fixture, never the resident database.
 db.prepare("UPDATE execution_runs SET status='waiting',pause_requested=1,recovery_reason='user_pause' WHERE run_id=?").run(runId)
 db.close()
 const before=await controller.taskPlan('new-round-resume')
 await controller.controlTask({commandId:'old-task-pause',taskId:'new-round-resume',intent:'pause',expectedControlRevision:before.task.controlRevision})
 const paused=await controller.taskPlan('new-round-resume')
 await store.command({id:'current-requirement',kind:'task.requirement.update',args:{taskId:'new-round-resume',expectedRequirementRevision:paused.task.requirementRevision,requirementRef:(await artifacts.put(2)).ref,eventKey:'current-scope'}})
 const oldState=await controller.state(runId),oldExecutions=executions
 const resumed=await controller.controlTask({commandId:'explicit-current-resume',taskId:'new-round-resume',intent:'resume',expectedControlRevision:paused.task.controlRevision})
 assert.equal(resumed.plan.task.controlState,'active')
 assert.notEqual(resumed.plan.task.planRequirementRevision,resumed.plan.task.requirementRevision)
 assert.equal((await controller.state(runId)).run.pauseRequested,true)
 assert.equal((await controller.state(runId)).run.generation,oldState.run.generation)
 assert.equal(executions,oldExecutions)
 const runs=await store.query({kind:'run.list',taskId:'new-round-resume'});assert.equal(runs.length,1);assert.equal(runs[0].runId,runId)
})

for(const blocker of [null,'receipt-recovery','current-workspace','same-requirement','not-paused','not-drained','current-effect','old-unsettled','pending-input','stale-generation','stale-plan','task-session'])test(`formal obsolete run retirement preserves earlier effects, blocker=${blocker}`,async t=>{
 let executions=0
 const w=workflow('obsolete-engineering');w.nodes[0].execute=async()=>{executions++;throw new Error('EXPECTED_STOP')}
 const {store,artifacts,controller,dbPath}=await setup(t,[w]);const taskId='retirement-test'
 const original=(await artifacts.put(1)).ref
 await store.command({id:'accept',kind:'task.accept',args:{taskId,requirementRef:original,requirementRevision:1,sessionId:'owner',criteria:['current delivery'],sourceKey:'source',eventKey:'created'}})
 await controller.initializeTaskPlan({commandId:'init',taskId,expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'engineering',workflowId:w.id,input:1}]})
 const plan=await controller.advanceTaskPlan(taskId),runId=plan.stages[0].runId;await controller.whenIdle(runId)
 if(blocker!=='same-requirement')await store.command({id:'new-requirement',kind:'task.requirement.update',args:{taskId,expectedRequirementRevision:1,requirementRef:(await artifacts.put(2)).ref,eventKey:'new-scope'}})
 const db=new DatabaseSync(dbPath),now=new Date().toISOString()
 try{
  db.prepare("UPDATE execution_runs SET generation=2,status='waiting',pause_requested=1,stop_requested=0 WHERE run_id=?").run(runId)
  db.prepare('UPDATE execution_nodes SET generation=2 WHERE run_id=? AND current=1').run(runId)
  const n=db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1').get(runId)
  db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-success','operation',runId,n.node_run_id,n.node_id,['current-effect','current-workspace'].includes(blocker)?2:1,'a'.repeat(64),'b'.repeat(64),blocker==='current-workspace'?'{"action":"workspace"}':'{}','[]','test-authority',blocker==='old-unsettled'?'unknown':'succeeded',now,now)
  if(blocker==='not-paused')db.prepare('UPDATE execution_runs SET pause_requested=0 WHERE run_id=?').run(runId)
  if(blocker==='not-drained')db.prepare('UPDATE execution_nodes SET drained=0 WHERE run_id=?').run(runId)
  if(blocker==='pending-input')db.prepare("INSERT INTO execution_inputs(run_id,input_id,source_key,requirement_ref,status,accepted_at) VALUES(?,?,?,?,?,?)").run(runId,'pending','input-source',original,'pending',now)
 }finally{db.close()}
 const effects=await store.query({kind:'effect.list',runId}),before=executions
 const args={commandId:'retire',taskId,runId,action:'retire',source:blocker==='task-session'?'task-session':'operator',actorId:'operator',reason:'new authorized scope replaces drained old generation',expectedRequirementRevision:blocker==='same-requirement'?1:2,expectedControlRevision:1,generation:blocker==='stale-generation'?1:2,expectedPlanRevision:blocker==='stale-plan'?2:1}
 if(blocker&&!['receipt-recovery','current-workspace'].includes(blocker)){await assert.rejects(controller.controlRun(args));assert.equal((await controller.state(runId)).run.status,'waiting');assert.equal((await controller.taskPlan(taskId)).stages[0].status,'running')}
 else{
  if(blocker==='receipt-recovery'){const {commandId,...nativeArgs}=args;await store.command({id:commandId,kind:'run.control',args:nativeArgs});assert.equal((await controller.state(runId)).run.status,'cancelling')}
  await controller.controlRun(args);await controller.controlRun(args)
  assert.equal((await controller.state(runId)).run.status,'cancelled')
  const current=await controller.taskPlan(taskId);assert.equal(current.stages[0].status,'blocked');assert.equal(current.task.controlState,'active')
  await assert.rejects(controller.controlRun({...args,generation:1}),{code:'NODE_CONTROL_REQUEST_CONFLICT'})
  await controller.reviseTaskPlan({commandId:'current-suffix',taskId,expectedPlanRevision:1,expectedControlRevision:1,requirementRevision:2,affectedFrom:0,stages:[{stageId:'current-work',workflowId:'investigate',input:2}]})
  const beforeReplay=await controller.taskPlan(taskId)
  await controller.controlRun(args)
  assert.deepEqual(await controller.taskPlan(taskId),beforeReplay)

 }
 assert.deepEqual(await store.query({kind:'effect.list',runId}),effects)
 assert.equal(executions,before);assert.equal((await store.query({kind:'run.list',taskId})).length,1)
})
