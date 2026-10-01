import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { classifyExecutionFailure, recoveryRetryDelayMs } from '../packages/dingtalk-dsh-assistant/execution-recovery-policy.js'

const number = { type: 'number' }
const workflow = execute => ({ id: 'synthetic', version: '1', nodes: [
  { id: 'calculate', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number, mapInput: ({ requirement }) => requirement, execute: execute ?? (async ({ input }) => input + 1) },
  { id: 'verify', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number, mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => input * 2 },
] })

test('失败分类仅使用精确白名单，输出错误不扩散到输入和未知故障', () => {
  for (const [code, category] of [
    ['ENGINEERING_ACCEPTANCE_FAILED', 'business-validation'], ['AGENT_WORK_NEEDS_INPUT', 'missing-input'],
    ['AGENT_WORK_BLOCKED', 'task-blocked'],
    ['ENGINEERING_UAT_ENVIRONMENT_REQUIRED', 'missing-environment'],
    ['DELIVERY_RECONCILIATION_REQUIRED', 'external-uncertain'], ['ECONNRESET', 'transient-execution'], ['GIT_CONNECTION_FAILED', 'transient-execution'],
    ['NOT_ECONNRESET', 'implementation-error'], ['CUSTOM_ACCEPTANCE_FAILED', 'implementation-error'],
    ['NODE_SCHEMA_INVALID', 'implementation-error'], [undefined, 'implementation-error'],
  ]) assert.equal(classifyExecutionFailure({ code }).category, category)
  assert.deepEqual(classifyExecutionFailure({ code: 'NODE_SCHEMA_INVALID', phase: 'output-validation' }), {
    category: 'correctable-output', responsibleParty: 'node-executor', nextAction: 'correct-output-and-continue',
  })
  for (const phase of ['output-validation', 'output-admission'])
    assert.equal(classifyExecutionFailure({ code: 'AGENT_WORK_RESULT_INVALID', phase }).category, 'correctable-output')
  for (const code of ['AGENT_WORK_RESULT_INVALID', 'CUSTOM_AGENT_WORK_RESULT_INVALID'])
    assert.equal(classifyExecutionFailure({ code, phase: 'input-validation' }).category, 'implementation-error')
  assert.equal(classifyExecutionFailure({ code: 'CUSTOM_AGENT_WORK_RESULT_INVALID', phase: 'output-admission' }).category, 'implementation-error')
})

test('执行失败保存恢复责任，未知故障和外部未知结果不自动重放', async t => {
  for (const [code, category, nextAction] of [
    ['ENGINEERING_ACCEPTANCE_FAILED', 'business-validation', 'repair-artifact-and-revalidate'],
    ['ENGINEERING_UAT_ENVIRONMENT_REQUIRED', 'missing-environment', 'restore-required-environment'],
    ['DELIVERY_RECONCILIATION_REQUIRED', 'external-uncertain', 'reconcile-before-replay'],
    ['CUSTOM_ACCEPTANCE_FAILED', 'implementation-error', 'inspect-and-fix-implementation'],
  ]) await t.test(code, async child => {
    let calls = 0
    const { controller, artifacts } = await setup(child, workflow(async () => {
      calls++; throw Object.assign(new Error(code), { code })
    }))
    await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
    const state = await controller.whenIdle('run')
    const diagnosis = await artifacts.read(state.nodes[0].evidenceRefs.at(-1))
    assert.equal(state.run.status, 'waiting')
    assert.equal(diagnosis.recovery.category, category)
    assert.equal(diagnosis.recovery.nextAction, nextAction)
    assert.equal(calls, 1)
    assert.equal(state.nodes[1].leaseEpoch, 0)
  })
})

test('缺资料等待保存分类和原始产物，不改变续行协议', async t => {
  const definition = workflow()
  definition.nodes[0].admitOutput = () => ({ outcome: 'waiting', waitReason: { kind: 'input', reference: 'AGENT_WORK_NEEDS_INPUT' } })
  const { controller, artifacts } = await setup(t, definition)
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  const state = await controller.whenIdle('run'), node = state.nodes[0]
  const diagnosis = await artifacts.read(node.evidenceRefs.at(-1))
  assert.equal(state.run.status, 'waiting')
  assert.equal(await artifacts.read(node.outputRef), 2)
  assert.equal(diagnosis.producedOutputRef, node.outputRef)
  assert.equal(diagnosis.recovery.category, 'missing-input')
  assert.equal(diagnosis.recovery.responsibleParty, 'requester')
  assert.deepEqual(node.waitReason, { kind: 'input', reference: 'AGENT_WORK_NEEDS_INPUT' })
})

test('未知业务失败也保存诊断，非法失败材料不能让已排空节点残留 running', async t => {
  for (const invalid of [false, true]) await t.test(invalid ? '非法材料' : '第三类业务材料', async child => {
    const evidence = invalid ? [new Map([['key', 'value']])] : [{ kind: 'inventory-discrepancy', expected: 2, actual: 1 }]
    const { controller, artifacts } = await setup(child, workflow(async () => {
      throw Object.assign(new Error('库存核对不一致'), { code: 'INVENTORY_CHECK_FAILED', evidence })
    }))
    await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
    const state = await controller.whenIdle('run'), node = state.nodes[0]
    assert.equal(state.run.status, 'waiting'); assert.equal(node.drained, true)
    assert.equal(state.nodes[1].leaseEpoch, 0)
    const values = await Promise.all(node.evidenceRefs.map(ref => artifacts.read(ref)))
    assert.equal(values.at(-1).kind, 'execution-failure')
    assert.equal(values.at(-1).phase, invalid ? 'failure-evidence' : 'execution')
    assert.equal(values.at(-1).nodeRunId, node.nodeRunId)
    if (invalid) assert.equal(values.length, 1)
    else assert.deepEqual(values[0], evidence[0])
  })
})

test('相同函数跨 LF/CRLF 打包保持定义身份，旧 CRLF 摘要可恢复', async t => {
  const body = 'async ({ input }) => {\n return input + 1\n}'
  const lf = workflow(eval(`(${body})`))
  const crlf = { ...lf, nodes: lf.nodes.map(node => ({ ...node,
    mapInput: eval(`(${node.mapInput.toString().replace(/\n/g, '\r\n')})`),
    execute: eval(`(${node.execute.toString().replace(/\n/g, '\r\n')})`) })) }
  const current = defineExecutionWorkflow(lf), historical = defineExecutionWorkflow(crlf)
  assert.equal(current.digest, historical.digest)
  assert.ok(historical.legacyDigests.some(digest => digest !== current.digest))
  assert.notEqual(current.digest, defineExecutionWorkflow(workflow(async ({ input }) => input + 2)).digest)
  const { store, artifacts, controller } = await setup(t, lf)
  const requirement = await artifacts.put(2)
  const oldDigest = historical.legacyDigests[0]
  const input = await artifacts.put({ workflowDigest: oldDigest, nodeId: 'calculate', nodeVersion: '1', requirementRef: requirement.ref, data: 2 })
  await store.command({ id: 'old-eol', kind: 'run.create', args: { runId: 'old-eol', taskId: 'old-task', workflowId: current.id,
    workflowDigest: oldDigest, requirementRef: requirement.ref, nodes: current.nodes.map((node, index) => ({
      nodeId: node.id, nodeVersion: node.version, executor: node.executor,
      inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })) } })
  await controller.recover({ commandId: 'recover-eol', runId: 'old-eol' })
  const state = await controller.whenIdle('old-eol')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(state.run.workflowDigest, oldDigest)
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 6)
  await store.command({ id: 'old-stage-plan', kind: 'task.plan.create', args: { taskId: 'old-stage-task', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: current.id, workflowDigest: oldDigest,
      unavailableReason: null, requirementRef: requirement.ref, gate: 'none' }] } })
  const stagePlan = await controller.advanceTaskPlan('old-stage-task')
  const stageRun = await controller.whenIdle(stagePlan.stages[0].runId)
  assert.equal(stageRun.run.workflowDigest, oldDigest)
  assert.equal(await artifacts.read(stageRun.nodes[1].outputRef), 6)
})

test('暂停等待真实排空，保留新输入，系统恢复不解除用户暂停，resume先应用新输入', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = []
  const { controller, artifacts } = await setup(t, workflow(async ({ input, signal }) => {
    calls.push(input)
    if (input === 1) { entered.resolve(); await release.promise; signal.throwIfAborted() }
    return input + 1
  }))
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await entered.promise
  await controller.pause({ commandId: 'pause', runId: 'run', reason: 'user pause' })
  assert.equal((await controller.state('run')).run.recoveryReason, 'pause_requested')
  await assert.rejects(controller.resume({ commandId: 'early-resume', runId: 'run' }), { code: 'RUN_NOT_USER_PAUSED' })
  await controller.changeInput({ commandId: 'change', runId: 'run', inputId: 'input', sourceKey: 'source', input: 9 })
  release.resolve()
  let state = await controller.whenIdle('run')
  assert.equal(state.run.recoveryReason, 'user_pause')
  assert.equal(state.pendingInputCount, 1)
  await controller.recover({ commandId: 'system-recover', runId: 'run' })
  state = await controller.whenIdle('run')
  assert.equal(state.run.pauseRequested, true)
  assert.deepEqual(calls, [1])
  await controller.resume({ commandId: 'resume', runId: 'run' })
  state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 20)
  assert.deepEqual(calls, [1, 9])
})

test('取消的任务不能通过resume复活', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { controller } = await setup(t, workflow(async ({ signal }) => { entered.resolve(); await release.promise; signal.throwIfAborted(); return 1 }))
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await entered.promise
  await controller.stop({ commandId: 'stop', runId: 'run', reason: 'cancel' }); release.resolve()
  assert.equal((await controller.whenIdle('run')).run.status, 'cancelled')
  await assert.rejects(controller.resume({ commandId: 'resume', runId: 'run' }), { code: 'RUN_NOT_USER_PAUSED' })
})

test('暂停在排空前重启：系统恢复仅完成暂停，用户resume才重领节点', async t => {
  const { store, artifacts, controller, dbPath, instanceId } = await setup(t)
  const definition = defineExecutionWorkflow(workflow()), requirement = await artifacts.put(1)
  const input = await artifacts.put({ workflowDigest: definition.digest, nodeId: 'calculate', nodeVersion: '1', requirementRef: requirement.ref, data: 1 })
  await store.command({ id: 'create', kind: 'run.create', args: { runId: 'run', taskId: 'task', workflowId: definition.id, workflowDigest: definition.digest, requirementRef: requirement.ref,
    nodes: definition.nodes.map((n, index) => ({ nodeId: n.id, nodeVersion: n.version, executor: n.executor, inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })) } })
  await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'calculate', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  await store.command({ id: 'pause', kind: 'run.pause', args: { runId: 'run', reason: 'user pause' } })
  await controller.close(); await store.close()
  const reopened = await openExecutionStore({ dbPath, instanceId })
  const resumed = createExecutionController({ store: reopened, artifacts, workflows: [workflow()] })
  t.after(async () => { await resumed.close(); await reopened.close() })
  await resumed.recover({ commandId: 'recover', runId: 'run' })
  const paused = await resumed.whenIdle('run')
  assert.equal(paused.run.recoveryReason, 'user_pause')
  assert.equal(paused.nodes[0].leaseEpoch, 1)
  await resumed.resume({ commandId: 'resume', runId: 'run' })
  assert.equal((await resumed.whenIdle('run')).run.status, 'succeeded')
})

test('当前定义改变时注册历史定义，旧run按旧digest续接而新run用当前定义', async t => {
  const { store, artifacts, controller } = await setup(t)
  const old = workflow(), definition = defineExecutionWorkflow(old), requirement = await artifacts.put(2)
  const input = await artifacts.put({ workflowDigest: definition.digest, nodeId: 'calculate', nodeVersion: '1', requirementRef: requirement.ref, data: 2 })
  await store.command({ id: 'old-create', kind: 'run.create', args: { runId: 'old-run', taskId: 'old-task', workflowId: definition.id, workflowDigest: definition.digest, requirementRef: requirement.ref,
    nodes: definition.nodes.map((n, index) => ({ nodeId: n.id, nodeVersion: n.version, executor: n.executor, inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })) } })
  await controller.close()
  const replacement = createExecutionController({ store, artifacts, workflows: [workflow(async ({ input }) => input + 10)], historicalWorkflows: [old] })
  t.after(() => replacement.close())
  await replacement.recover({ commandId: 'recover', runId: 'old-run' })
  let state = await replacement.whenIdle('old-run')
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 6)
  await replacement.createRun({ commandId: 'new-create', taskId: 'new-task', runId: 'new-run', workflowId: 'synthetic', input: 2 })
  state = await replacement.whenIdle('new-run')
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 24)
})
async function setup(t, definition = workflow()) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-execution-controller-'))
  const dbPath = join(directory, 'control.db'), instanceId = 'synthetic-instance'
  const store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [definition], changeQuietMs: 10, maxChangeDelayMs: 50 })
  t.after(async () => { await controller.close(); await store.close() })
  return { directory, dbPath, instanceId, store, artifacts, controller }
}

test('正式Controller：schema映射→事务下游→最终输出，不读取聊天历史', async t => {
  const { controller, artifacts, store } = await setup(t)
  await controller.createRun({ commandId: 'create-1', taskId: 'task-1', runId: 'run-1', workflowId: 'synthetic', input: 2 })
  const state = await controller.whenIdle('run-1')
  assert.equal(state.run.status, 'succeeded')
  assert.deepEqual(state.nodes.map(n => n.status), ['succeeded', 'succeeded'])
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 6)
  assert.ok(state.nodes.every(n => n.drained && n.leaseEpoch === 1))
  await controller.createRun({ commandId: 'create-1', taskId: 'task-1', runId: 'run-1', workflowId: 'synthetic', input: 2 })
  await controller.whenIdle('run-1')
  assert.deepEqual((await store.query({ kind: 'run', runId: 'run-1' })).nodes.map(n => n.leaseEpoch), [1, 1])
})

test('新输入先持久屏障，旧执行排空后换代，只使用最新输入', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const calls = []
  const { controller, store, artifacts } = await setup(t, workflow(async ({ input, signal }) => {
    calls.push(input)
    if (input === 1) { entered.resolve(); await release.promise; signal.throwIfAborted() }
    return input + 1
  }))
  await controller.createRun({ commandId: 'create-1', taskId: 'task-1', runId: 'run-1', workflowId: 'synthetic', input: 1 })
  await entered.promise
  await controller.changeInput({ commandId: 'change-1', runId: 'run-1', inputId: 'input-1', sourceKey: 'web:1', input: 7 })
  await controller.changeInput({ commandId: 'change-2', runId: 'run-1', inputId: 'input-2', sourceKey: 'web:2', input: 9 })
  const fenced = await store.query({ kind: 'run', runId: 'run-1' })
  assert.equal(fenced.pendingInputCount, 2)
  assert.equal(fenced.nodes[0].generation, 1)
  assert.equal(fenced.nodes[0].drained, false)
  release.resolve()
  const state = await controller.whenIdle('run-1')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(state.pendingInputCount, 0)
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 20)
  assert.deepEqual(calls, [1, 9])
  assert.equal(state.nodes[0].generation, 2)
})

test('取消先记cancelling，真实函数未退出不显示cancelled、不启动下游', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { controller } = await setup(t, workflow(async ({ signal }) => { entered.resolve(); await release.promise; signal.throwIfAborted(); return 1 }))
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await entered.promise
  await controller.stop({ commandId: 'stop', runId: 'run', reason: 'synthetic cancellation' })
  assert.equal((await controller.state('run')).run.status, 'cancelling')
  release.resolve()
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'cancelled')
  assert.equal(state.nodes[1].leaseEpoch, 0)
})

test('无效输出不能让下游获得执行租约', async t => {
  const { controller } = await setup(t, workflow(async () => 'not-a-number'))
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'failed')
  assert.equal(state.nodes[1].leaseEpoch, 0)
})

test('产出和后继纯映射错误统一持久交接，保留有效产物且下游不执行', async t => {
  for (const [name, value, mapper, expectedPhase] of [
    ['date', new Date(), null, 'output-validation'],
    ['map', new Map(), null, 'output-validation'],
    ['undefined', undefined, null, 'output-validation'],
    ['mapper', 2, () => { throw new TypeError('missing requirement') }, 'input-mapping'],
    ['next-schema', 2, () => 'wrong', 'input-validation'],
  ]) await t.test(name, async t => {
    const definition = workflow(async () => value)
    if (mapper) definition.nodes[1].mapInput = mapper
    const { controller, artifacts, store } = await setup(t, definition)
    await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: definition.id, input: 1 })
    await controller.whenIdle('run')
    const state = await store.query({ kind: 'run', runId: 'run' })
    assert.equal(state.run.status, 'failed')
    assert.equal(state.nodes[0].drained, true)
    assert.equal(state.nodes[1].leaseEpoch, 0)
    const diagnosis = await artifacts.read(state.nodes[0].evidenceRefs.at(-1))
    assert.equal(diagnosis.kind, 'execution-failure')
    assert.equal(diagnosis.phase, expectedPhase)
    assert.equal(diagnosis.recovery.category, mapper ? 'implementation-error' : 'correctable-output')
    assert.equal(diagnosis.nodeRunId, state.nodes[0].nodeRunId)
    if (mapper) {
      assert.equal(diagnosis.targetNodeId, 'verify')
      assert.equal(await artifacts.read(diagnosis.producedOutputRef), 2)
    }
  })
})

test('结果落盘响应未知时读取原提交继续，不写失败或重做已完成节点', async t => {
  let executions = 0
  const definition = workflow(async () => { executions++; return 2 })
  const { controller: initial, store, artifacts } = await setup(t, definition)
  await initial.close()
  let lost = false
  const controller = createExecutionController({ artifacts, workflows: [definition], store: { query: store.query, command: async command => {
    const receipt = await store.command(command)
    if (!lost && command.kind === 'node.commit' && command.args.outcome === 'succeeded') {
      lost = true
      throw Object.assign(new Error('receipt unknown'), { code: 'COMMIT_ACK_UNKNOWN' })
    }
    return receipt
  } } })
  t.after(() => controller.close())
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await controller.whenIdle('run')
  const committed = await store.query({ kind: 'run', runId: 'run' })
  assert.equal(lost, true)
  assert.equal(committed.run.status, 'succeeded')
  assert.equal(committed.nodes[0].status, 'succeeded')
  assert.equal(committed.nodes[1].status, 'succeeded')
  await controller.recover({ commandId: 'recover', runId: 'run' })
  assert.equal((await controller.whenIdle('run')).run.status, 'succeeded')
  assert.equal(executions, 1)
})

test('工件磁盘写失败不伪造契约失败，不派发下游', async t => {
  const { controller, artifacts, store } = await setup(t, workflow(async () => 42))
  const put = artifacts.put
  artifacts.put = value => value === 42 ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) : put(value)
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await assert.rejects(controller.whenIdle('run'), { code: 'ENOSPC' })
  const state = await store.query({ kind: 'run', runId: 'run' })
  assert.equal(state.nodes[0].drained, true)
  assert.equal(state.nodes[0].status, 'running')
  assert.equal(state.nodes[1].leaseEpoch, 0)
  assert.equal((await controller.state('run')).controllerError, 'ENOSPC')
  assert.equal(await store.query({ kind: 'receipt', commandId: `invalid-result:${state.nodes[0].nodeRunId}:1` }), null)
})

test('冻结待启动阶段在重启升级后按原摘要运行，合同也随摘要固定', async t => {
  const old = workflow(), current = workflow(async ({ input }) => input + 10)
  current.version = '2'
  current.ownerContract = { id: 'sample', version: '1', validateCompletion: async () => true }
  const { controller, store, artifacts, dbPath, instanceId } = await setup(t, old)
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'one', workflowId: old.id, input: 2 }] })
  const oldDigest = (await controller.taskPlan('task')).stages[0].workflowDigest
  await controller.close(); await store.close()
  const reopened = await openExecutionStore({ dbPath, instanceId })
  const unavailable = createExecutionController({ store: reopened, artifacts, workflows: [current] })
  await assert.rejects(unavailable.advanceTaskPlan('task'), { code: 'WORKFLOW_VERSION_UNAVAILABLE' })
  assert.equal((await unavailable.taskPlan('task')).stages[0].runId, null)
  await unavailable.close()
  const upgraded = createExecutionController({ store: reopened, artifacts, workflows: [current], historicalWorkflows: [old] })
  t.after(async () => { await upgraded.close(); await reopened.close() })
  const plan = await upgraded.advanceTaskPlan('task')
  const state = await upgraded.whenIdle(plan.stages[0].runId)
  assert.equal(state.run.workflowDigest, oldDigest)
  assert.equal(await artifacts.read(state.nodes.at(-1).outputRef), 6)
  assert.equal(upgraded.workflowDefinition(old.id, oldDigest).ownerContract, undefined)
  assert.equal(upgraded.workflowDefinition(current.id).ownerContract.version, '1')
  assert.notEqual(defineExecutionWorkflow(current).digest, defineExecutionWorkflow({ ...current,
    ownerContract: { ...current.ownerContract, validateCompletion: async () => false } }).digest)
})

test('失败结果在Owner唤醒前重启仍可读取，重复观察不重复事件或业务执行', async t => {
  let executions = 0
  const definition = workflow(async () => {
    executions++
    throw Object.assign(new Error('custom domain failure'), { code: 'CUSTOM_DOMAIN_FAILURE', evidence: [{ actual: 'failed' }] })
  })
  const { controller, store, artifacts, dbPath, instanceId } = await setup(t, definition)
  const turns = []
  const createOwner = (controller, store) => createTaskOwnerController({ ctx: {}, store, artifacts, controller,
    modelConfig: () => ({}), authorizeStages: async () => false, advanceTask: async () => {},
    sessionRunner: { async run({ input, onSessionBound, onCandidate, readArtifact }) {
      await onSessionBound()
      turns.push(input)
      for (const stage of input.stageArtifacts) {
        assert.deepEqual(stage.completionEvidenceRefs, [])
        const materials = await Promise.all(stage.evidenceRefs.map(readArtifact))
        assert.ok(materials.some(value => value.actual === 'failed'))
        assert.ok(materials.some(value => value.code === 'CUSTOM_DOMAIN_FAILURE'))
        assert.deepEqual(materials.find(value => value.code === 'CUSTOM_DOMAIN_FAILURE').recovery, {
          category: 'implementation-error', responsibleParty: 'maintainer', nextAction: 'inspect-and-fix-implementation',
        })
      }
      await assert.rejects(readArtifact('sha256-' + 'f'.repeat(64) + '.json'), { code: 'TASK_OWNER_ARTIFACT_NOT_ALLOWED' })
      const decision = { action: 'wait', summary: '已读失败原因，等待所需能力', evidenceRefs: [] }
      await onCandidate(decision)
      return { status: 'submitted', decision }
    }, async close() {} } })
  let owner = createOwner(controller, store)
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'one', workflowId: definition.id, input: 1 }] })
  await owner.ensure({ taskId: 'task', sourceKey: 'source', criteria: ['交付结果'], origin: {} })
  await owner.drive('task')
  const plan = await controller.advanceTaskPlan('task')
  await controller.whenIdle(plan.stages[0].runId)
  await owner.close(); await controller.close(); await store.close()
  const reopened = await openExecutionStore({ dbPath, instanceId })
  const resumed = createExecutionController({ store: reopened, artifacts, workflows: [definition] })
  owner = createOwner(resumed, reopened)
  t.after(async () => { await owner.close(); await resumed.close(); await reopened.close() })
  await owner.observe('task')
  const before = await reopened.query({ kind: 'task.owner', taskId: 'task' })
  await owner.observe('task')
  assert.equal((await reopened.query({ kind: 'task.owner', taskId: 'task' })).eventWatermark, before.eventWatermark)
  assert.deepEqual(await owner.recover(), [])
  const received = turns.at(-1)
  assert.equal(received.stageArtifacts[0].diagnostics[0].waitReason.reference, 'CUSTOM_DOMAIN_FAILURE')
  assert.ok(received.events.some(event => event.eventType === 'workflow.failed'))
  assert.equal(executions, 1)
})

test('工件坏字节拒绝读取；正常读不会悄悄修复内容', async t => {
  const { artifacts } = await setup(t)
  const { ref } = await artifacts.put({ value: 1 })
  await writeFile(join(artifacts.root, ref), '{"value":2}')
  await assert.rejects(artifacts.read(ref), { code: 'ARTIFACT_DIGEST_MISMATCH' })
  await assert.rejects(artifacts.put({ value: 1 }), { code: 'ARTIFACT_DIGEST_MISMATCH' })
  assert.equal(await readFile(join(artifacts.root, ref), 'utf8'), '{"value":2}')
})

test('工件读取期间stop已持久接纳，释放读取后不得再进入executor', async t => {
  let executed = 0
  const { controller, artifacts } = await setup(t, workflow(async () => { executed++; return 1 }))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const read = artifacts.read
  artifacts.read = async ref => {
    const value = await read(ref)
    if (value && typeof value === 'object' && value.nodeId === 'calculate') { entered.resolve(); await release.promise }
    return value
  }
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 1 })
  await entered.promise
  await controller.stop({ commandId: 'stop', runId: 'run', reason: 'cancel before execution' })
  release.resolve()
  const state = await controller.whenIdle('run')
  assert.equal(executed, 0)
  assert.equal(state.run.status, 'cancelled')
})

test('同一内容并发落盘只能公开完整工件', async t => {
  const { artifacts } = await setup(t)
  const results = await Promise.all(Array.from({ length: 20 }, () => artifacts.put({ data: 'same content'.repeat(100) })))
  assert.equal(new Set(results.map(r => r.ref)).size, 1)
  assert.deepEqual(await artifacts.read(results[0].ref), { data: 'same content'.repeat(100) })
})

for (const action of ['input', 'stop']) test(`重启恢复优先处理已持久${action}屏障`, async t => {
  const { store, artifacts, controller, dbPath, instanceId } = await setup(t)
  const definition = defineExecutionWorkflow(workflow())
  const requirement = await artifacts.put(1)
  const input = await artifacts.put({ workflowDigest: definition.digest, nodeId: 'calculate', nodeVersion: '1', requirementRef: requirement.ref, data: 1 })
  await store.command({ id: 'create', kind: 'run.create', args: {
    runId: 'run', taskId: 'task', workflowId: definition.id, workflowDigest: definition.digest, requirementRef: requirement.ref,
    nodes: definition.nodes.map((n, index) => ({ nodeId: n.id, nodeVersion: n.version, executor: n.executor, inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })),
  } })
  await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'calculate', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  if (action === 'input') {
    const replacement = await artifacts.put(9)
    await store.command({ id: 'change', kind: 'input.accept', args: { runId: 'run', inputId: 'input', sourceKey: 'web:change', requirementRef: replacement.ref } })
  } else await store.command({ id: 'stop', kind: 'run.stop', args: { runId: 'run', reason: 'cancel before restart' } })
  await controller.close(); await store.close()
  const reopened = await openExecutionStore({ dbPath, instanceId })
  const resumed = createExecutionController({ store: reopened, artifacts, workflows: [workflow()], changeQuietMs: 0, maxChangeDelayMs: 0 })
  t.after(async () => { await resumed.close(); await reopened.close() })
  await resumed.recover({ commandId: 'recover', runId: 'run' })
  const state = await resumed.whenIdle('run')
  assert.equal(state.run.status, action === 'input' ? 'succeeded' : 'cancelled')
  if (action === 'input') {
    assert.equal(state.pendingInputCount, 0)
    assert.equal(state.nodes[0].generation, 2)
    assert.equal(await artifacts.read(state.nodes[1].outputRef), 20)
  } else assert.equal(state.nodes[1].leaseEpoch, 0)
})

test('省略runId时重试同一创建命令沿用确定身份', async t => {
  const { controller } = await setup(t)
  const request = { commandId: 'create', taskId: 'task', workflowId: 'synthetic', input: 1 }
  const first = await controller.createRun(request)
  await controller.whenIdle(first.runId)
  const replay = await controller.createRun(request)
  assert.equal(replay.runId, first.runId)
  assert.equal(replay.receipt.replayed, true)
  await controller.whenIdle(first.runId)
})

for (const committedFirst of [false, true]) test(`持久ready节点重启恢复：${committedFirst ? '前节点已提交' : '尚未首次claim'}`, async t => {
  const { store, artifacts, controller, dbPath, instanceId } = await setup(t)
  const definition = defineExecutionWorkflow(workflow()), requirement = await artifacts.put(1)
  const input = await artifacts.put({ workflowDigest: definition.digest, nodeId: 'calculate', nodeVersion: '1', requirementRef: requirement.ref, data: 1 })
  await store.command({ id: 'create', kind: 'run.create', args: {
    runId: 'run', taskId: 'task', workflowId: definition.id, workflowDigest: definition.digest, requirementRef: requirement.ref,
    nodes: definition.nodes.map((n, index) => ({ nodeId: n.id, nodeVersion: n.version, executor: n.executor, inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })),
  } })
  if (committedFirst) {
    const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'calculate', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
    const identity = { runId: 'run', nodeId: 'calculate', generation: binding.generation, leaseEpoch: binding.leaseEpoch }
    const evidence = await artifacts.put({ disposed: true }), output = await artifacts.put(2)
    const next = await artifacts.put({ workflowDigest: definition.digest, nodeId: 'verify', nodeVersion: '1', requirementRef: requirement.ref, data: 2 })
    await store.command({ id: 'drain', kind: 'node.drained', args: { ...identity, evidenceRef: evidence.ref } })
    await store.command({ id: 'commit', kind: 'node.commit', args: { ...identity, inputDigest: binding.inputDigest, outcome: 'succeeded', outputRef: output.ref, evidenceRefs: [evidence.ref], nextInput: { nodeId: 'verify', inputRef: next.ref, inputDigest: next.digest } } })
  }
  await controller.close(); await store.close()
  const reopened = await openExecutionStore({ dbPath, instanceId })
  const resumed = createExecutionController({ store: reopened, artifacts, workflows: [workflow()] })
  t.after(async () => { await resumed.close(); await reopened.close() })
  await resumed.recover({ commandId: 'recover', runId: 'run' })
  const state = await resumed.whenIdle('run')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 4)
  assert.deepEqual(state.nodes.map(n => n.leaseEpoch), [1, 1])
  await resumed.recover({ commandId: 'recover-terminal', runId: 'run' })
  assert.deepEqual((await resumed.whenIdle('run')).nodes.map(n => n.leaseEpoch), [1, 1])
})

test('大量合法长inputId分批应用，不超过RPC上限且只运行最后输入', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = []
  const { controller, artifacts } = await setup(t, workflow(async ({ input, signal }) => {
    calls.push(input)
    if (input === 0) { entered.resolve(); await release.promise; signal.throwIfAborted() }
    return input + 1
  }))
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'synthetic', input: 0 })
  await entered.promise
  try {
    for (let i = 1; i <= 65; i++) await controller.changeInput({ commandId: `change-${i}`, runId: 'run', inputId: `${i}-${'\u0000'.repeat(4080)}`, sourceKey: `web:${i}`, input: i })
  } finally { release.resolve() }
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded')
  assert.equal(state.pendingInputCount, 0)
  assert.equal(await artifacts.read(state.nodes[1].outputRef), 132)
  assert.deepEqual(calls, [0, 65])
})

test('外部检查未排空跨Store重启保留屏障，真实存活父子进程不能被recover误放行', { skip: process.platform !== 'win32' }, async t => {
  const { spawn, execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const directory=await mkdtemp(join(tmpdir(),'dsh-drain-restart-')), options={dbPath:join(directory,'control.db'),instanceId:'drain-restart',initialize:true}
  const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true})
  let store=await openExecutionStore(options),controller,child,pids,downstream=0
  t.after(async()=>{if(child){await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{})}await controller?.close();await store.close()})
  const definition=workflow(async()=>{
    child=spawn(process.execPath,['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    pids=await new Promise((resolve,reject)=>{child.stdout.once('data',b=>resolve(JSON.parse(b.toString())));child.once('error',reject)})
    throw Object.assign(new Error('synthetic termination acknowledgement unavailable'),{code:'VERIFY_JOB_DRAIN_UNCONFIRMED',executionDrained:false})
  });definition.nodes[0].drainPolicy='external-process';definition.nodes[1].execute=async()=>{downstream++;return 0}
  controller=createExecutionController({store,artifacts,workflows:[definition]})
  await controller.createRun({commandId:'create',runId:'run',taskId:'task',workflowId:'synthetic',input:1})
  await assert.rejects(controller.whenIdle('run'),{code:'VERIFY_JOB_DRAIN_UNCONFIRMED'})
  await assert.rejects(controller.recover({commandId:'same-process-recover',runId:'run'}),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED'})
  await controller.close();await store.close()
  store=await openExecutionStore({...options,initialize:false});controller=createExecutionController({store,artifacts,workflows:[definition]})
  for(const pid of pids)assert.doesNotThrow(()=>process.kill(pid,0))
  await assert.rejects(controller.recover({commandId:'restart-recover',runId:'run'}),{code:'EXECUTOR_DRAIN_EVIDENCE_REQUIRED'})
  const state=await controller.state('run');assert.equal(state.nodes[0].drained,false);assert.equal(state.nodes[1].status,'blocked');assert.equal(downstream,0)
  await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true})
  for(const pid of pids)assert.throws(()=>process.kill(pid,0));child=null
})


test('任务新输入按任务归属写入，执行输出和失败证据沿用持久输入引用', async t => {
  for (const failed of [false, true]) await t.test(failed ? '失败证据及新输入' : '成功输出', async child => {
    const { controller, artifacts } = await setup(child, workflow(failed ? async () => {
      throw Object.assign(new Error('synthetic'), { evidence: [{ detail: 'failure proof' }] })
    } : undefined))
    const writes = [], put = artifacts.put
    artifacts.put = async (value, options) => { writes.push({ value, options }); return put(value, options) }
    await controller.createRun({ commandId: 'create-routing', taskId: 'task-routing', runId: 'run-routing', workflowId: 'synthetic', input: 2 })
    let state = await controller.whenIdle('run-routing')
    assert.equal(writes[0].options.taskId, 'task-routing')
    for (const entry of writes.slice(1)) assert.match(entry.options.reference, /^sha256-/)
    if (failed) {
      assert.ok(writes.some(entry => entry.value?.detail === 'failure proof'))
      assert.ok(writes.some(entry => entry.value?.kind === 'execution-failure'))
      const before = writes.length
      await controller.changeInput({ commandId: 'change-routing', runId: 'run-routing', inputId: 'input-routing', sourceKey: 'source-routing', input: 3 })
      await controller.whenIdle('run-routing')
      assert.equal(writes[before].options.reference, state.run.requirementRef)
    }
  })
})

test('Owner恢复调用不热循环，输入条件变化立即唤醒同会话', async t => {
 const {controller,store,artifacts}=await setup(t,workflow())
 let attempts=0
 const owner=createTaskOwnerController({ctx:{},store,artifacts,controller,modelConfig:()=>({}),advanceTask:async()=>{},authorizeStages:async()=>true,
  sessionRunner:{async run(){attempts++;throw Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'})},async close(){}}})
 t.after(()=>owner.close())
 await controller.createTaskPlan({commandId:'owner-backoff-plan',taskId:'owner-backoff',stages:[{stageId:'first',workflowId:'synthetic',input:1}]})
 await owner.ensure({taskId:'owner-backoff',criteria:['完成'],sourceKey:'owner-backoff-source',origin:{}})
 await assert.rejects(owner.drive('owner-backoff'),{code:'ECONNRESET'})
 await owner.recover();await owner.recover();assert.equal(attempts,1)
 const before=await store.query({kind:'task.owner',taskId:'owner-backoff'})
 assert.ok(Date.parse(before.retryAt)>Date.now())
 await owner.event({taskId:'owner-backoff',eventKey:'new-condition',eventType:'authorization.changed'})
 await assert.rejects(owner.drive('owner-backoff'),{code:'ECONNRESET'})
 const after=await store.query({kind:'task.owner',taskId:'owner-backoff'})
 assert.equal(attempts,2);assert.equal(after.sessionId,before.sessionId)
 assert.equal(recoveryRetryDelayMs(Number.MAX_SAFE_INTEGER),60_000)
})
for(const stop of ['cancel','close'])test(`Owner模型已排空后${stop}仍取消完成授权，未接纳完成且不累计失败`,async t=>{
 const {controller,store,artifacts}=await setup(t,workflow())
 const entered=Promise.withResolvers(),stopped=Promise.withResolvers()
 let observedSignal
 const owner=createTaskOwnerController({ctx:{},store,artifacts,controller,modelConfig:()=>({}),advanceTask:async()=>{},authorizeStages:async()=>true,
  authorizeCompletion:async({signal})=>{
   observedSignal=signal;entered.resolve()
   await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{stopped.resolve();reject(signal.reason)},{once:true})})
   return true
  },
  sessionRunner:{async run({onSessionBound,onCandidate}){
   await onSessionBound()
   const decision={action:'complete',summary:'等待实际业务验收',evidenceRefs:[]}
   await onCandidate(decision);return{status:'submitted',decision}
  },async cancel(){},async close(){}}})
 t.after(()=>owner.close())
 await controller.createTaskPlan({commandId:`cancel-owner-plan-${stop}`,taskId:`cancel-owner-${stop}`,stages:[{stageId:'first',workflowId:'synthetic',input:1}]})
 await owner.ensure({taskId:`cancel-owner-${stop}`,criteria:['完成'],sourceKey:'cancel-owner-source',origin:{}})
 const driving=owner.drive(`cancel-owner-${stop}`)
 await entered.promise
 if(stop==='cancel')await owner.cancel(`cancel-owner-${stop}`);else await owner.close()
 await stopped.promise
 assert.equal(await driving,null);assert.equal(observedSignal.aborted,true)
 const state=await store.query({kind:'task.owner',taskId:`cancel-owner-${stop}`})
 assert.equal(state.status,'pending');assert.equal(state.failureCount,0)
 assert.notEqual(state.applicationStatus,'pending')
})
test('超过32个节点的完整Run持续执行并保留全部成功产物', async t => {
  const definition={id:'many-nodes',version:'1',nodes:Array.from({length:80},(_,index)=>({
    id:`step-${index}`,version:'1',executor:'code',allowedEffects:['pure'],inputSchema:number,outputSchema:number,
    mapInput:({requirement,previousOutput})=>index?previousOutput:requirement,execute:async({input})=>input+1,
  }))}
  const {controller,artifacts}=await setup(t,definition)
  await controller.createRun({commandId:'create-many',taskId:'many-task',runId:'many-run',workflowId:definition.id,input:0})
  const result=await controller.whenIdle('many-run')
  assert.equal(result.run.status,'succeeded');assert.equal(result.run.claimCount,80)
  assert.equal(result.nodes.length,80);assert.ok(result.nodes.every(node=>node.status==='succeeded'&&node.outputRef))
  assert.equal(await artifacts.read(result.nodes.at(-1).outputRef),80)
})
