import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

const number = { type: 'number' }
const workflow = execute => ({ id: 'synthetic', version: '1', nodes: [
  { id: 'calculate', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number, mapInput: ({ requirement }) => requirement, execute: execute ?? (async ({ input }) => input + 1) },
  { id: 'verify', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: number, outputSchema: number, mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => input * 2 },
] })

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
