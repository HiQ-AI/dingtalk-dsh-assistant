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
  raw.exec('DROP TABLE task_plan_stages; DROP TABLE business_tasks; PRAGMA user_version=1;')
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
  const reopened = await openExecutionStore({ dbPath, instanceId })
  assert.equal(reopened.info.schemaVersion, 2)
  assert.equal((await reopened.query({ kind: 'run', runId: 'historical-run' })).run.taskId, 'historical')
  await reopened.close()
})
