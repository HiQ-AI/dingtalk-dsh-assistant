import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'

const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/execution-store.js', import.meta.url).href
const d = 'a'.repeat(64), changedDigest = 'b'.repeat(64)
const command = (kind, args, id = randomUUID()) => ({ id, kind, args })
const identity = n => ({ runId: n.runId, nodeId: n.nodeId, generation: n.generation, leaseEpoch: n.leaseEpoch })
const plan = (nodeId = 'one', executor = 'code', ready = true) => ({ nodeId, nodeVersion: '1', executor,
  inputRef: ready ? 'sha256/input.json' : null, inputDigest: ready ? d : null })
const creation = (nodes = [plan()], extra = {}) => ({ runId: 'run', taskId: 'task', workflowId: 'sequential',
  workflowDigest: d, requirementRef: 'sha256/requirement.json', nodes, ...extra })
async function fixture(t, args = creation()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-execution-store-'))
  const f = { root, dbPath: join(root, 'control.sqlite'), instanceId: randomUUID(), stores: [] }
  t.after(async () => {
    for (const store of f.stores) await store.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('dsh-execution-store-'))
    await rm(root, { recursive: true, force: true })
  })
  f.open = async (initialize = false) => {
    f.store = await openExecutionStore({ dbPath: f.dbPath, instanceId: f.instanceId, initialize })
    f.stores.push(f.store)
    return f.store
  }
  await f.open(true)
  if (args) await f.store.command(command('run.create', args, 'create'))
  f.query = () => f.store.query({ kind: 'run', runId: 'run' })
  f.claim = async (nodeId = 'one', generation = 1, leaseEpoch = 0, id = randomUUID()) =>
    (await f.store.command(command('node.claim', { runId: 'run', nodeId, expectedGeneration: generation, expectedLeaseEpoch: leaseEpoch }, id))).result.binding
  f.drain = n => f.store.command(command('node.drained', { ...identity(n), evidenceRef: 'sha256/disposed.json' }))
  return f
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code)

test('工程索引容量等待仅在旧节点排空且下游未运行时切换定义', async t => {
  const f = await fixture(t, creation([plan('prepare-workspace'), plan('index-files', 'code', false),
    plan('select-files', 'agent', false), plan('validate-selection', 'code', false)]))
  const prepare = await f.claim('prepare-workspace'); await f.drain(prepare)
  await f.store.command(command('node.commit', { ...identity(prepare), inputDigest: d, outcome: 'succeeded', outputRef: 'sha256/prepare.json', evidenceRefs: [],
    nextInput: { nodeId: 'index-files', inputRef: 'sha256/index-old.json', inputDigest: d } }))
  const index = await f.claim('index-files'); await f.drain(index)
  await f.store.command(command('node.commit', { ...identity(index), inputDigest: d, outcome: 'waiting', evidenceRefs: [],
    waitReason: { kind: 'recovery', reference: 'ENGINEERING_INDEX_CAPACITY_EXCEEDED' } }))
  const before = await f.query(), args = { runId: 'run', expectedRevision: before.run.revision, fromDigest: d, toDigest: changedDigest,
    nodeRunId: index.nodeRunId, inputRef: 'sha256/index-new.json', inputDigest: changedDigest }
  await rejects(f.store.command(command('run.workflow.migrate-index', { ...args, nodeRunId: 'other' })), 'WORKFLOW_MIGRATION_UNSAFE')
  await f.store.command(command('run.workflow.migrate-index', args, `migrate-index:run:${changedDigest}`))
  const after = await f.query()
  assert.equal(after.run.workflowDigest, changedDigest)
  assert.equal(after.run.status, 'queued')
  assert.deepEqual(after.nodes.map(node => node.nodeVersion), ['1', '2', '2', '2'])
  assert.equal(after.nodes[1].inputRef, args.inputRef)
  assert.equal(after.nodes[1].status, 'ready')
  await rejects(f.store.command(command('run.workflow.migrate-index', args)), 'WORKFLOW_MIGRATION_CONFLICT')
  // 构造旧包已补额度却留下预算耗尽领取回执的快照。
  await f.store.close()
  const raw = new DatabaseSync(f.dbPath)
  const oldNode = after.nodes[1]
  const exhaustedClaim = `claim:${oldNode.nodeRunId}:${oldNode.leaseEpoch + 1}`
  raw.prepare('INSERT INTO execution_receipts(command_id,payload_digest,result,created_at) VALUES(?,?,?,?)')
    .run(exhaustedClaim, d, JSON.stringify({ status: 'budget_exhausted' }), new Date().toISOString())
  raw.prepare('INSERT INTO execution_receipts(command_id,payload_digest,result,created_at) VALUES(?,?,?,?)')
    .run(`index-budget:run:${changedDigest}`, d, JSON.stringify({ status: 'applied' }), new Date().toISOString())
  raw.close(); await f.open(false)
  await rejects(f.store.command(command('run.workflow.index-budget-lease', { runId: 'run', workflowDigest: changedDigest })), 'WORKFLOW_BUDGET_COMMAND_INVALID')
  const leaseId = `index-budget-lease:run:${changedDigest}`
  await f.store.command(command('run.workflow.index-budget-lease', { runId: 'run', workflowDigest: changedDigest }, leaseId))
  const resumed = await f.query()
  assert.equal(resumed.nodes[1].status, 'ready')
  assert.equal(resumed.nodes[1].leaseEpoch, oldNode.leaseEpoch + 1)
  const next = await f.store.command(command('node.claim', { runId: 'run', nodeId: 'index-files', expectedGeneration: resumed.nodes[1].generation,
    expectedLeaseEpoch: resumed.nodes[1].leaseEpoch }, `claim:${resumed.nodes[1].nodeRunId}:${resumed.nodes[1].leaseEpoch + 1}`))
  assert.equal(next.result.status, 'applied')
  assert.equal(next.result.binding.nodeId, 'index-files')
  assert.equal((await f.store.command(command('run.workflow.index-budget-lease', { runId: 'run', workflowDigest: changedDigest }, leaseId))).replayed, true)
})
test('工程读取节点仅在旧执行已排空且下游未开始时迁移定义', async t => {
  const names = ['prepare-workspace', 'index-files', 'select-files', 'validate-selection', 'read-files', 'propose-changes', 'apply-changes']
  const f = await fixture(t, creation(names.map((name, index) => plan(name, index === 2 || index === 5 ? 'agent' : 'code', index === 0))))
  await f.store.close()
  const raw = new DatabaseSync(f.dbPath)
  raw.prepare("UPDATE execution_nodes SET status='succeeded' WHERE run_id='run' AND position<4").run()
  raw.prepare("UPDATE execution_nodes SET status='waiting',lease_epoch=1,drained=0,input_ref='sha256/old.json',input_digest=?,wait_reason=? WHERE run_id='run' AND node_id='read-files'")
    .run(d, JSON.stringify({ kind: 'recovery', reference: 'TASK_CONTEXT_TOO_LARGE' }))
  raw.prepare("UPDATE execution_runs SET status='waiting',recovery_reason='TASK_CONTEXT_TOO_LARGE' WHERE run_id='run'").run()
  raw.close(); await f.open(false)
  const read = (await f.query()).nodes[4]
  const args = { runId: 'run', expectedRevision: 0, fromDigest: d, toDigest: changedDigest,
    nodeRunId: read.nodeRunId, inputRef: 'sha256/new.json', inputDigest: changedDigest }
  await rejects(f.store.command(command('run.workflow.migrate-read', { ...args, nodeRunId: 'other' }, `migrate-read:run:${changedDigest}`)), 'WORKFLOW_MIGRATION_UNSAFE')
  await rejects(f.store.command(command('run.workflow.migrate-read', args, `migrate-read:run:${changedDigest}`)), 'WORKFLOW_MIGRATION_UNSAFE')
  await f.store.command(command('node.drained', { ...identity(read), evidenceRef: 'sha256/disposed.json' }))
  await f.store.command(command('run.workflow.migrate-read', args, `migrate-read:run:${changedDigest}`))
  const state = await f.query()
  assert.equal(state.run.workflowDigest, changedDigest)
  assert.equal(state.run.status, 'queued')
  assert.equal(state.nodes[4].nodeVersion, '2')
  assert.equal(state.nodes[4].status, 'ready')
  assert.equal(state.nodes[4].inputRef, args.inputRef)
  assert.ok(state.nodes.slice(5).every(node => node.status === 'blocked'))
})
function child(t, source, args, preload) {
  const execArgs = [...(preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : []),
    '-e', `(async()=>{${source}})().catch(e=>{if(process.send)process.send({type:'error',code:e.code,message:e.message});process.exitCode=1})`, ...args]
  const proc = spawn(process.execPath, execArgs, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  proc.stderr.on('data', value => { stderr += value })
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await exited })
  const messages = [], listeners = []
  proc.on('message', message => {
    const index = listeners.findIndex(item => item.type === message.type || message.type === 'error')
    if (index < 0) messages.push(message)
    else { const item = listeners.splice(index, 1)[0]; clearTimeout(item.timer); message.type === 'error' ? item.reject(new Error(JSON.stringify(message))) : item.resolve(message) }
  })
  return { proc, exited, message(type) {
    const index = messages.findIndex(m => m.type === type || m.type === 'error')
    if (index >= 0) { const m = messages.splice(index, 1)[0]; return m.type === 'error' ? Promise.reject(new Error(JSON.stringify(m))) : Promise.resolve(m) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child message timeout ${type}: ${stderr}`)), 20000)
      listeners.push({ type, resolve, reject, timer })
    })
  } }
}

test('磁盘配置读回、显式初始化、正常开启及身份/schema严格检查', async t => {
  const f = await fixture(t)
  assert.equal(f.store.info.journalMode, 'wal')
  assert.equal(f.store.info.synchronous, 2)
  assert.equal(f.store.info.foreignKeys, 1)
  assert.equal(f.store.info.lockStrategy, 'separate-sqlite-begin-exclusive')
  await f.store.close()
  await rejects(openExecutionStore({ dbPath: join(f.root, 'missing.sqlite'), instanceId: f.instanceId }), 'STORE_DATABASE_MISSING')
  await assert.rejects(stat(join(f.root, 'missing.sqlite')), e => e.code === 'ENOENT')
  await rejects(openExecutionStore({ dbPath: f.dbPath, instanceId: 'wrong' }), 'STORE_INSTANCE_MISMATCH')
  await f.open()
  assert.equal((await f.query()).nodes[0].generation, 1)
  await f.store.close()
  const raw = new DatabaseSync(f.dbPath)
  raw.exec('PRAGMA user_version=4')
  raw.close()
  await rejects(f.open(), 'STORE_SCHEMA_MISMATCH')
})

test('损坏与空库不隐式建表；未知生产参数拒绝', async t => {
  const f = await fixture(t, null)
  await f.store.close()
  const bad = join(f.root, 'bad.sqlite')
  await writeFile(bad, 'deliberate invalid sqlite header')
  const before = await readFile(bad)
  await rejects(openExecutionStore({ dbPath: bad, instanceId: f.instanceId }), 'ERR_SQLITE_ERROR')
  assert.deepEqual(await readFile(bad), before)
  await writeFile(bad, '')
  await rejects(openExecutionStore({ dbPath: bad, instanceId: f.instanceId }), 'STORE_DATABASE_MISSING')
  assert.equal((await stat(bad)).size, 0)
  await rejects(openExecutionStore({ dbPath: f.dbPath, instanceId: f.instanceId, fault: 'drop-ack' }), 'INVALID_STORE_OPTIONS')
})

test('独立锁库阻止另一个worker及进程；关闭后可重新取得锁', async t => {
  const f = await fixture(t)
  await rejects(openExecutionStore({ dbPath: f.dbPath, instanceId: f.instanceId }), 'STORE_OWNER_LOCKED')
  const probe = child(t, `const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    try{const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});await s.close();process.send({type:'lock',code:'unexpected-success'})}
    catch(e){process.send({type:'lock',code:e.code})}`, [f.dbPath, f.instanceId])
  assert.equal((await probe.message('lock')).code, 'STORE_OWNER_LOCKED')
  assert.equal((await probe.exited).code, 0)
  await f.store.close()
  await f.open()
  assert.equal((await f.query()).run.status, 'queued')
})

test('顺序节点必须绑定输入；drained和业务输出落盘后，成功与后继ready原子提交', async t => {
  const f = await fixture(t, creation([plan(), plan('two', 'code', false)]))
  await rejects(f.claim('two'), 'NODE_NOT_READY')
  const n = await f.claim()
  const commit = { ...identity(n), inputDigest: d, outcome: 'succeeded', outputRef: 'sha256/output.json', evidenceRefs: [] }
  await rejects(f.store.command(command('node.commit', commit)), 'NODE_NOT_DRAINED')
  await f.drain(n)
  await rejects(f.store.command(command('node.drained', { ...identity(n), evidenceRef: 'sha256/another-stop-proof.json' })), 'DRAIN_EVIDENCE_CONFLICT')
  await rejects(f.store.command(command('node.commit', commit)), 'INVALID_ARGUMENT')
  assert.equal((await f.query()).nodes[1].status, 'blocked')
  await f.store.command(command('node.commit', { ...commit, nextInput: { nodeId: 'two', inputRef: 'sha256/next.json', inputDigest: changedDigest } }, 'commit-one'))
  let state = await f.query()
  assert.equal(state.nodes[0].status, 'succeeded')
  assert.equal(state.nodes[1].status, 'ready')
  assert.equal(state.nodes[1].inputDigest, changedDigest)
  const two = await f.claim('two')
  await f.drain(two)
  await f.store.command(command('node.commit', { ...identity(two), inputDigest: changedDigest, outcome: 'succeeded', outputRef: 'sha256/final.json', evidenceRefs: [] }))
  state = await f.query()
  assert.equal(state.run.status, 'succeeded')
  assert.equal(state.run.claimCount, 2)
  const replay = await f.store.command(command('node.commit', { ...commit, nextInput: { nodeId: 'two', inputRef: 'sha256/next.json', inputDigest: changedDigest } }, 'commit-one'))
  assert.equal(replay.replayed, true)
  assert.equal(replay.dispatchEligible, false)
  await rejects(f.store.command(command('node.commit', { ...commit, outputRef: 'sha256/changed.json' }, 'commit-one')), 'COMMAND_ID_CONFLICT')
})

test('sessionId先落盘；重启不推定旧句柄停止，确认排空后同Session新lease恢复', async t => {
  const f = await fixture(t, creation([plan('one', 'agent')]))
  const n = await f.claim('one', 1, 0, 'claim')
  assert.ok(n.sessionId)
  assert.equal(n.sessionBound, false)
  assert.equal((await f.query()).nodes[0].sessionId, n.sessionId)
  await f.store.command(command('node.sessionBound', { ...identity(n), sessionId: n.sessionId }))
  await f.store.close()
  await f.open()
  let state = await f.query()
  assert.equal(state.nodes[0].status, 'waiting')
  assert.equal(state.nodes[0].drained, false)
  await rejects(f.store.command(command('run.recover', { runId: 'run' })), 'NODE_NOT_DRAINED')
  await f.drain(n)
  await f.store.command(command('run.recover', { runId: 'run' }, 'recover'))
  const recovered = await f.claim('one', 1, 1)
  assert.equal(recovered.sessionId, n.sessionId)
  assert.equal(recovered.sessionBound, true)
  assert.equal(recovered.leaseEpoch, 2)
  const replay = await f.store.command(command('node.claim', { runId: 'run', nodeId: 'one', expectedGeneration: 1, expectedLeaseEpoch: 0 }, 'claim'))
  assert.equal(replay.replayed, true)
  assert.equal((await f.query()).run.claimCount, 2)
})

test('输入来源去重、payload冲突、drained前拒绝换代；旧结果CAS和未处理屏障持续生效', async t => {
  const f = await fixture(t)
  const n = await f.claim()
  const first = { runId: 'run', inputId: 'i1', sourceKey: 'message1', requirementRef: 'sha256/req2.json' }
  assert.equal((await f.store.command(command('input.accept', first))).result.accepted, true)
  assert.equal((await f.store.command(command('input.accept', { ...first, inputId: 'duplicate-id' }))).result.accepted, false)
  await rejects(f.store.command(command('input.accept', { ...first, requirementRef: 'sha256/conflict.json' })), 'INPUT_SOURCE_CONFLICT')
  await f.store.command(command('input.accept', { runId: 'run', inputId: 'i2', sourceKey: 'message2', requirementRef: 'sha256/req3.json' }))
  const apply = { runId: 'run', inputIds: ['i1'], expectedRevision: 0, requirementRef: first.requirementRef,
    nodes: [{ nodeId: 'one', inputRef: 'sha256/new-input.json', inputDigest: changedDigest }] }
  await rejects(f.store.command(command('input.apply', apply)), 'NODE_NOT_DRAINED')
  await f.drain(n)
  await f.store.command(command('input.apply', apply, 'apply1'))
  let state = await f.query()
  assert.equal(state.run.generation, 2)
  assert.equal(state.pendingInputCount, 1)
  assert.equal(state.run.claimCount, 1)
  await rejects(f.claim('one', 2, 0), 'INPUT_PENDING')
  const apply2 = { ...apply, inputIds: ['i2'], expectedRevision: 1, requirementRef: 'sha256/req3.json' }
  await f.store.command(command('input.apply', apply2))
  await rejects(f.store.command(command('node.commit', { ...identity(n), inputDigest: d, outcome: 'succeeded', outputRef: 'sha256/old.json', evidenceRefs: [] })), 'NODE_STALE')
  state = await f.store.query({ kind: 'run', runId: 'run', includeHistory: true })
  assert.equal(state.nodeHistory.length, 3)
  assert.equal(state.inputs.every(i => i.status === 'applied'), true)
  assert.equal((await f.store.command(command('input.apply', apply, 'apply1'))).replayed, true)
})

test('stop先持久阻断；run.stopped必须等租约排空；无等待模型调用', async t => {
  const f = await fixture(t)
  const n = await f.claim()
  await f.store.command(command('run.stop', { runId: 'run', reason: 'user cancelled' }))
  await rejects(f.store.command(command('run.stopped', { runId: 'run' })), 'NODE_NOT_DRAINED')
  await rejects(f.claim('one', 1, 1), 'RUN_NOT_ACTIVE')
  await f.drain(n)
  await f.store.command(command('run.stopped', { runId: 'run' }))
  assert.equal((await f.query()).run.status, 'cancelled')
})

test('同Task仅一个非终态run，业务冲突不破坏控制库健康', async t => {
  const f = await fixture(t)
  await rejects(f.store.command(command('run.create', creation([plan()], { runId: 'another-run' }))), 'TASK_ALREADY_RUNNING')
  assert.equal(f.store.healthy, true)
  await f.store.command(command('run.stop', { runId: 'run', reason: 'done' }))
  await f.store.command(command('run.stopped', { runId: 'run' }))
  await f.store.command(command('run.create', creation([plan()], { runId: 'another-run' })))
  assert.equal((await f.store.query({ kind: 'run', runId: 'another-run' })).run.status, 'queued')
})

test('会话创建失败可落waiting/recovery，不能伪造sessionBound或提交成功', async t => {
  const f = await fixture(t, creation([plan('one', 'agent')]))
  const n = await f.claim()
  await f.drain(n)
  const base = { ...identity(n), inputDigest: d, evidenceRefs: [] }
  await rejects(f.store.command(command('node.commit', { ...base, outcome: 'succeeded', outputRef: 'sha256/out.json' })), 'SESSION_NOT_BOUND')
  await f.store.command(command('node.commit', { ...base, outcome: 'waiting', waitReason: { kind: 'recovery', reference: 'SESSION_CREATE_FAILED' } }))
  const state = await f.query()
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes[0].sessionBound, false)
  assert.equal(state.nodes[0].waitReason.reference, 'SESSION_CREATE_FAILED')
  await f.store.command(command('run.recover', { runId: 'run' }))
  const next = await f.claim('one', 1, 1)
  assert.equal(next.sessionId, n.sessionId)
  assert.equal(next.sessionBound, false)
})

test('持久预算跨input generation保留，耗尽状态提交且receipt replay不扣额', async t => {
  const f = await fixture(t, creation([plan()], { maxClaims: 1 }))
  const n = await f.claim()
  await f.drain(n)
  await f.store.command(command('input.accept', { runId: 'run', inputId: 'i', sourceKey: 'm', requirementRef: 'sha256/r2.json' }))
  await f.store.command(command('input.apply', { runId: 'run', inputIds: ['i'], expectedRevision: 0, requirementRef: 'sha256/r2.json',
    nodes: [{ nodeId: 'one', inputRef: 'sha256/i2.json', inputDigest: changedDigest }] }))
  const claim = command('node.claim', { runId: 'run', nodeId: 'one', expectedGeneration: 2, expectedLeaseEpoch: 0 }, 'exhausted')
  assert.equal((await f.store.command(claim)).result.status, 'budget_exhausted')
  await f.store.close()
  await f.open()
  const state = await f.query()
  assert.equal(state.run.claimCount, 1)
  assert.equal(state.run.status, 'waiting')
  assert.equal(state.nodes[0].waitReason.reference, 'EXECUTION_BUDGET_EXHAUSTED')
  await rejects(f.store.command(command('run.recover', { runId: 'run' })), 'EXECUTION_BUDGET_EXHAUSTED')
  assert.equal((await f.store.command(claim)).replayed, true)
})

test('真实子进程COMMIT前强杀：状态及receipt共同回滚，独占锁随进程释放', async t => {
  const f = await fixture(t)
  await f.store.close()
  // 注入只在测试进程 --import 中；生产API/worker没有fault开关。
  const preload = `import {DatabaseSync} from 'node:sqlite';import{isMainThread,parentPort}from'node:worker_threads';
    if(!isMainThread){const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
      if(sql==='COMMIT'){let hit=false;try{hit=!!this.prepare('SELECT 1 FROM execution_receipts WHERE command_id=?').get('kill-before-commit')}catch{}
        if(hit){parentPort.postMessage({type:'test-before-commit'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}
      return Reflect.apply(original,this,[sql])}}`
  const probe = child(t, `const {Worker}=await import('node:worker_threads');const on=Worker.prototype.on;
    Worker.prototype.on=function(name,fn){return on.call(this,name,name==='message'?m=>{if(m.type==='test-before-commit')process.send({type:'checkpoint'});fn(m)}:fn)};
    const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});
    await s.command({id:'kill-before-commit',kind:'run.stop',args:{runId:'run',reason:'synthetic'}});await s.close();`, [f.dbPath, f.instanceId], preload)
  await probe.message('checkpoint')
  assert.equal(probe.proc.kill('SIGKILL'), true)
  assert.equal((await probe.exited).signal, 'SIGKILL')
  await f.open()
  assert.equal((await f.query()).run.stopRequested, false)
  assert.equal(await f.store.query({ kind: 'receipt', commandId: 'kill-before-commit' }), null)
})

test('真实COMMIT后ACK丢失：调用器超时封闭写，重开按原ID读回且不再claim', { timeout: 30000 }, async t => {
  const f = await fixture(t, creation([plan('one', 'agent')]))
  await f.store.close()
  const probe = child(t, `const {Worker}=await import('node:worker_threads');const on=Worker.prototype.on;
    Worker.prototype.on=function(name,fn){return on.call(this,name,name==='message'?m=>{if(m.type==='response'&&m.value?.result?.binding){process.send({type:'dropped'});return}fn(m)}:fn)};
    const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});let code,after;
    try{await s.command({id:'lost-claim',kind:'node.claim',args:{runId:'run',nodeId:'one',expectedGeneration:1,expectedLeaseEpoch:0}})}catch(e){code=e.code}
    try{await s.command({id:'offline-stop',kind:'run.stop',args:{runId:'run',reason:'x'}})}catch(e){after=e.code}
    await s.close();process.send({type:'result',code,after});`, [f.dbPath, f.instanceId])
  await probe.message('dropped')
  assert.deepEqual(await probe.message('result'), { type: 'result', code: 'COMMIT_ACK_UNKNOWN', after: 'STORE_UNAVAILABLE' })
  assert.equal((await probe.exited).code, 0)
  await f.open()
  const replay = await f.store.command(command('node.claim', { runId: 'run', nodeId: 'one', expectedGeneration: 1, expectedLeaseEpoch: 0 }, 'lost-claim'))
  assert.equal(replay.replayed, true)
  assert.equal(replay.dispatchEligible, false)
  assert.ok(replay.result.binding.sessionId)
  const state = await f.query()
  assert.equal(state.run.claimCount, 1)
  assert.equal(state.nodes[0].leaseEpoch, 1)
  assert.equal(state.nodes[0].status, 'waiting')
  assert.equal(state.nodes[0].drained, false)
})

test('RPC队列有界，拒绝超额请求且已接纳查询可完成', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled(Array.from({ length: 65 }, () => f.query()))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 64)
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'STORE_QUEUE_FULL').length, 1)
})

test('测试进程限额触发原生SQLITE_FULL：整条命令回滚且封闭写，不模拟物理卷满', async t => {
  const f = await fixture(t)
  await f.store.close()
  const preload = `import {DatabaseSync} from 'node:sqlite';import{isMainThread}from'node:worker_threads';
    if(!isMainThread){const original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){
      const connection=this,statement=Reflect.apply(original,this,[sql]);
      if(!sql.startsWith('INSERT INTO execution_receipts'))return statement;
      return new Proxy(statement,{get(target,key){if(key==='run')return(...args)=>{
        if(args[0]==='full-stop'){const pages=connection.prepare('PRAGMA page_count').get().page_count;
          connection.exec('PRAGMA max_page_count='+pages);
          connection.exec(\"INSERT INTO execution_events(kind,payload,created_at) VALUES('full',json_object('data',hex(zeroblob(1048576))),'now')\")}
        return Reflect.apply(target.run,target,args)};
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}}`
  const probe = child(t, `const{openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});let code,sqliteCode,after;
    try{await s.command({id:'full-stop',kind:'run.stop',args:{runId:'run',reason:'synthetic'}})}catch(e){code=e.code;sqliteCode=e.sqliteCode}
    try{await s.command({id:'after-full',kind:'run.stop',args:{runId:'run',reason:'blocked'}})}catch(e){after=e.code}
    await s.close();process.send({type:'result',code,sqliteCode,after});`, [f.dbPath, f.instanceId], preload)
  assert.deepEqual(await probe.message('result'), { type: 'result', code: 'ERR_SQLITE_ERROR', sqliteCode: 13, after: 'STORE_UNAVAILABLE' })
  assert.equal((await probe.exited).code, 0)
  await f.open()
  assert.equal((await f.query()).run.stopRequested, false)
  assert.equal(await f.store.query({ kind: 'receipt', commandId: 'full-stop' }), null)
})
