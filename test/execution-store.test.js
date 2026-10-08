import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { migrateExecutionEventsIndex } from '../scripts/migrate-execution-events-index.mjs'

const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/execution-store.js', import.meta.url).href
const ownerControllerUrl = new URL('../packages/dingtalk-dsh-assistant/task-owner-controller.js', import.meta.url).href
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

async function seedTaskFamily(f, links) {
  await f.store.close()
  const database = new DatabaseSync(f.dbPath)
  try {
    database.prepare('INSERT INTO message_runs(run_id,source_key,source_version,body) VALUES(?,?,?,?)')
      .run('family-source', 'family-source', 1, JSON.stringify({ runId: 'family-source', status: 'settled', actorId: 'owner' }))
    database.prepare('INSERT INTO message_items(item_id,run_id,kind,body) VALUES(?,?,?,?)')
      .run('family-source-command', 'family-source', 'command', JSON.stringify({ kind: 'create', args: { taskId: 'root' } }))
    for (const [taskId, rerunOfTaskId] of links) database.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)')
      .run('task.web-rerun.accept', JSON.stringify({ taskId, rerunOfTaskId, source: { actorId: 'owner', sourceKey: taskId, request: { objective: taskId } } }), new Date().toISOString())
  } finally { database.close() }
  await f.open()
}

test('任务家族全量关系与目录不受最近200条run截断，阶段run仍属于同一次执行', async t => {
  const f = await fixture(t, null)
  for (let index = 0; index < 203; index++) {
    const taskId = index === 0 ? 'root' : index === 1 ? 'second' : 'latest'
    const runId = `family-run-${index}`
    await f.store.command(command('run.create', creation([plan()], { runId, taskId })))
    await f.store.command(command('run.stop', { runId, reason: 'test' }))
    await f.store.command(command('run.stopped', { runId }))
  }
  await seedTaskFamily(f, [['second', 'root'], ['latest', 'second']])
  const expected = { rootTaskId: 'root', taskIds: ['root', 'second', 'latest'], latestTaskId: 'latest' }
  assert.deepEqual(await f.store.query({ kind: 'task.family', taskId: 'second' }), expected)
  assert.deepEqual(await f.store.query({ kind: 'task.families' }), [expected])
  const catalog = await f.store.query({ kind: 'task.catalog' })
  assert.equal(catalog.reduce((n, task) => n + task.runs.length, 0), 203)
  const latest = await f.store.query({ kind: 'task.catalog', taskId: 'latest' })
  assert.equal(latest.length, 1); assert.equal(latest[0].runs.length, 201)
  assert.equal(latest[0].runs[0].runId, 'family-run-202')
  await rejects(f.store.command(command('task.web-input.prepare', { eventId: 'stale', actorId: 'owner', request: { taskId: 'second' }, input: null })), 'TASK_EXECUTION_STALE')
  await rejects(f.store.command(command('task.web-input.prepare', { eventId: 'unauthorized-stale', actorId: 'attacker', request: { taskId: 'second' }, input: null })), 'WORKFLOW_TASK_FORBIDDEN')
  await rejects(f.store.command(command('task.web-rerun.accept', { taskId: 'fourth', rerunOfTaskId: 'root', actorId: 'owner', request: {}, requirementRef: 'sha256/new.json', criteria: ['通过'], sourceKey: 'web-rerun:fourth' })), 'TASK_EXECUTION_STALE')
  const result = (await f.store.command(command('task.archive', { taskId: 'latest', actorId: 'owner' }))).result
  assert.deepEqual(result.taskIds, expected.taskIds)
  const replay = (await f.store.command(command('task.archive', { taskId: 'root', actorId: 'owner' }))).result
  assert.equal(replay.archivedAt, result.archivedAt)
  assert.equal(new Set((await f.store.query({ kind: 'task.archives' })).map(item => item.taskId)).size, 3)
  await rejects(f.store.command(command('task.archive', { taskId: 'latest', actorId: 'attacker' })), 'WORKFLOW_TASK_FORBIDDEN')
})

test('损坏的重执行祖先或循环关系封闭拒绝，不拆成正常卡片', async t => {
  for (const links of [[['root', 'missing']], [['root', 'root']]]) {
    const f = await fixture(t, creation([plan()], { taskId: 'root' }))
    await seedTaskFamily(f, links)
    await rejects(f.store.query({ kind: 'task.families' }), 'TASK_FAMILY_INVALID')
  }
})

test('家族历史仍活动时禁止整体归档与重执行，事务不留下部分归档', async t => {
  const f = await fixture(t, creation([plan()], { runId: 'root-run', taskId: 'root' }))
  await f.store.command(command('run.create', creation([plan()], { runId: 'second-run', taskId: 'second' })))
  await f.store.command(command('run.stop', { runId: 'second-run', reason: 'test' }))
  await f.store.command(command('run.stopped', { runId: 'second-run' }))
  await seedTaskFamily(f, [['second', 'root']])
  await rejects(f.store.command(command('task.archive', { taskId: 'second', actorId: 'owner' })), 'TASK_ARCHIVE_NOT_COMPLETED')
  assert.deepEqual(await f.store.query({ kind: 'task.archives' }), [])
  await rejects(f.store.command(command('task.web-rerun.accept', { taskId: 'third', rerunOfTaskId: 'second', actorId: 'owner',
    request: { expectedRunId: 'second-run' }, requirementRef: 'sha256/new.json', criteria: ['通过'], sourceKey: 'web-rerun:third' })), 'TASK_RERUN_SOURCE_NOT_COMPLETED')
  assert.equal(await f.store.query({ kind: 'task.family', taskId: 'third' }), null)
})

test('首次run开始前取消的最新执行可用明确null重执行，旧成员与缺失绑定仍拒绝', async t => {
  const f = await fixture(t, creation([plan()], { runId: 'root-run', taskId: 'root' }))
  await f.store.command(command('run.stop', { runId: 'root-run', reason: 'test' }))
  await f.store.command(command('run.stopped', { runId: 'root-run' }))
  await seedTaskFamily(f, [])
  const rerun = (taskId, rerunOfTaskId, expectedRunId) => command('task.web-rerun.accept', { taskId, rerunOfTaskId, actorId: 'owner',
    request: { expectedRunId, objective: '验证未开始执行的取消' }, requirementRef: 'sha256/new.json', criteria: ['通过'], sourceKey: `web-rerun:${taskId}` })
  await f.store.command(rerun('second', 'root', 'root-run'))
  assert.deepEqual(await f.store.query({ kind: 'task.catalog', taskId: 'second' }), [{ taskId: 'second', runs: [] }])
  await f.store.command(command('task.control.cancel', { taskId: 'second', expectedControlRevision: 1 }))
  const missingBinding = rerun('missing-binding', 'second', null)
  delete missingBinding.args.request.expectedRunId
  await rejects(f.store.command(missingBinding), 'TASK_RERUN_SOURCE_CHANGED')
  await rejects(f.store.command(rerun('wrong-binding', 'second', 'root-run')), 'TASK_RERUN_SOURCE_CHANGED')
  await f.store.command(rerun('third', 'second', null))
  assert.deepEqual(await f.store.query({ kind: 'task.family', taskId: 'third' }), {
    rootTaskId: 'root', taskIds: ['root', 'second', 'third'], latestTaskId: 'third'
  })
  await rejects(f.store.command(rerun('old-source', 'second', null)), 'TASK_EXECUTION_STALE')
})

test('维护屏障与领取同事务，重启保留且旧许可不能恢复派发', async t => {
  const f = await fixture(t)
  const args = { active: true, expectedRevision: 0, maintenanceId: 'deploy-one', actorId: 'owner', reason: '部署排空' }
  const entered = await f.store.command(command('runtime.maintenance.change', args, 'enter'))
  assert.equal(entered.result.revision, 1)
  for (const kind of ['node.claim','task.owner.claim','effect.begin','message.node.claim','message.command.claim','message.notification.claim','message.notification.operation.claim']) {
    await rejects(f.store.command(command(kind, {})), 'RUNTIME_MAINTENANCE_ACTIVE')
  }
  assert.equal((await f.query()).run.claimCount, 0)
  assert.equal((await f.store.query({ kind: 'runtime.maintenance' })).stopPermitted, false)
  assert.equal((await f.store.command(command('runtime.maintenance.change', args, 'enter'))).replayed, true)
  await f.store.close(); await f.open()
  await rejects(f.claim(), 'RUNTIME_MAINTENANCE_ACTIVE')
  await rejects(f.store.command(command('runtime.maintenance.change', { ...args, active: false })), 'RUNTIME_MAINTENANCE_STALE')
  await rejects(f.store.command(command('runtime.maintenance.change', { ...args, active: false, expectedRevision: 1, actorId: 'different' })), 'RUNTIME_MAINTENANCE_STALE')
  await f.store.command(command('runtime.maintenance.change', { ...args, active: false, expectedRevision: 1 }))
  assert.equal((await f.claim()).status, 'running')
})

test('维护期间已有节点可排空，未排空不给停机许可', async t => {
  const f = await fixture(t), node = await f.claim()
  await f.store.command(command('runtime.maintenance.change', { active: true, expectedRevision: 0, maintenanceId: 'deploy-two', actorId: 'owner', reason: '部署' }))
  assert.equal((await f.store.query({ kind: 'runtime.maintenance' })).stopPermitted, false)
  const seal = {expectedRevision:1,maintenanceId:'deploy-two',actorId:'owner',reason:'停机'}
  await rejects(f.store.command(command('runtime.maintenance.seal',seal)), 'RUNTIME_MAINTENANCE_NOT_DRAINED')
  await f.drain(node)
  await f.store.command(command('node.commit', { ...identity(node), inputDigest: d, outcome: 'succeeded', outputRef: 'sha256/result.json', evidenceRefs: [] }))
  const state = await f.store.query({ kind: 'runtime.maintenance' })
  assert.equal(state.active, true); assert.equal(state.stopPermitted, false)
  await f.store.command(command('runtime.maintenance.seal',seal))
  assert.equal((await f.store.query({kind:'runtime.maintenance'})).stopPermitted,true)
})

test('停机seal原子封存后旧进程leave和resume均拒绝；新进程持久回读后正式resume', async t => {
  const f=await fixture(t), args={maintenanceId:'sealed-deploy',actorId:'owner',reason:'部署',expectedRevision:0}
  await f.store.command(command('runtime.maintenance.change',{...args,active:true}))
  await f.store.command(command('runtime.maintenance.seal',{...args,expectedRevision:1},'seal'))
  const sealed=await f.store.query({kind:'runtime.maintenance'})
  assert.equal(sealed.phase,'stopping');assert.equal(sealed.stopPermitted,true);assert.equal(sealed.resumePermitted,false)
  assert.match(sealed.processIncarnation,new RegExp(`^${process.pid}:`))
  await rejects(f.store.command(command('runtime.maintenance.change',{...args,expectedRevision:2,active:false})),'RUNTIME_MAINTENANCE_SEALED')
  await rejects(f.store.command(command('runtime.maintenance.resume',{...args,expectedRevision:2})),'RUNTIME_MAINTENANCE_SEALED')
  await rejects(f.store.command(command('runtime.maintenance.resume',{...args,expectedRevision:2,processIncarnation:'pretend-new'})),'RUNTIME_MAINTENANCE_INVALID')
  await f.store.close();await f.open()
  assert.equal((await f.store.query({kind:'runtime.maintenance'})).processIncarnation,sealed.processIncarnation)
  await rejects(f.store.command(command('runtime.maintenance.resume',{...args,expectedRevision:2})),'RUNTIME_MAINTENANCE_SEALED')
  await rejects(f.claim(),'RUNTIME_MAINTENANCE_ACTIVE')
  await f.store.close()
  const script=join(f.root,'resume.mjs')
  await writeFile(script,`import {openExecutionStore} from ${JSON.stringify(moduleUrl)};const input=JSON.parse(process.argv[2]);const store=await openExecutionStore(input.options);try{const before=await store.query({kind:'runtime.maintenance'});await store.command({id:'new-process-resume',kind:'runtime.maintenance.resume',args:input.args});console.log(JSON.stringify({before,after:await store.query({kind:'runtime.maintenance'})}));}finally{await store.close()}`)
  const child=spawnSync(process.execPath,[script,JSON.stringify({options:{dbPath:f.dbPath,instanceId:f.instanceId},args:{...args,expectedRevision:2}})],{encoding:'utf8',windowsHide:true})
  assert.equal(child.status,0,child.stderr)
  const result=JSON.parse(child.stdout)
  assert.equal(result.before.stopPermitted,false);assert.equal(result.before.resumePermitted,true)
  assert.notEqual(result.before.processIncarnation,sealed.processIncarnation)
  assert.equal(result.after.active,false);assert.equal(result.after.phase,'inactive');assert.equal(result.after.revision,3)
  await f.open();assert.equal((await f.claim()).status,'running')
})

test('节点耗时来自已提交 claim/commit，重开存储后仍可读取', async t => {
  const f = await fixture(t)
  assert.equal((await f.query()).nodes[0].startedAt, null)
  const node = await f.claim()
  const running = (await f.query()).nodes[0]
  assert.ok(Number.isFinite(Date.parse(running.startedAt)))
  assert.equal(running.completedAt, null)
  await f.drain(node)
  await f.store.command(command('node.commit', { ...identity(node), inputDigest: d,
    outcome: 'succeeded', outputRef: 'sha256/result.json', evidenceRefs: [] }))
  const completed = (await f.query()).nodes[0]
  assert.equal(completed.startedAt, running.startedAt)
  assert.ok(Date.parse(completed.completedAt) >= Date.parse(completed.startedAt))
  await f.store.close()
  await f.open()
  assert.deepEqual((await f.query()).nodes[0], completed)
})

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
  raw.exec('PRAGMA user_version=9')
  raw.close()
  await rejects(f.open(), 'STORE_SCHEMA_MISMATCH')
})

for (const variant of ['missing', 'reversed', 'partial', 'unique', 'expression']) test(`schema8事件索引结构严格检查：${variant}`, async t => {
  const f = await fixture(t, null)
  assert.equal(f.store.info.schemaVersion, 8)
  await f.store.close()
  const raw = new DatabaseSync(f.dbPath)
  raw.exec('DROP INDEX execution_events_kind_seq')
  if (variant === 'reversed') raw.exec('CREATE INDEX execution_events_kind_seq ON execution_events(seq,kind)')
  if (variant === 'partial') raw.exec('CREATE INDEX execution_events_kind_seq ON execution_events(kind,seq) WHERE seq>0')
  if (variant === 'unique') raw.exec('CREATE UNIQUE INDEX execution_events_kind_seq ON execution_events(kind,seq)')
  if (variant === 'expression') raw.exec('CREATE INDEX execution_events_kind_seq ON execution_events(kind,seq+0)')
  raw.close()
  await rejects(f.open(), 'STORE_SCHEMA_MISMATCH')
  const readback = new DatabaseSync(f.dbPath, { readOnly: true })
  assert.equal(readback.prepare('PRAGMA user_version').get().user_version, 8)
  const indexes = readback.prepare("PRAGMA index_list('execution_events')").all()
  assert.equal(indexes.length, variant === 'missing' ? 0 : 1, '启动拒绝后不能偷偷修复索引')
  readback.close()
})

test('schema8按事件kind索引查询且原生历史排序保持完整', async t => {
  const f = await fixture(t, null)
  await f.store.close()
  const raw = new DatabaseSync(f.dbPath)
  const insert = raw.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)')
  for (let position = 0; position < 3; position++) {
    insert.run('task.archive', JSON.stringify({ taskId: `archived-${position}`, archivedAt: `2026-10-02T00:00:0${position}.000Z`, actorId: 'owner' }), '2026-10-02T00:00:00.000Z')
    insert.run('test.other-event', JSON.stringify({ position }), '2026-10-02T00:00:00.000Z')
  }
  const plans = [
    "EXPLAIN QUERY PLAN SELECT payload FROM execution_events WHERE kind='task.archive' ORDER BY seq",
    "EXPLAIN QUERY PLAN SELECT payload FROM execution_events WHERE kind='task.archive' ORDER BY seq DESC",
  ].flatMap(sql => raw.prepare(sql).all())
  assert.ok(plans.every(row => row.detail.includes('USING INDEX execution_events_kind_seq') && row.detail.includes('kind=?')))
  const before = raw.prepare("SELECT seq,payload FROM execution_events WHERE kind='task.archive' ORDER BY seq").all()
  raw.close()
  await f.open()
  assert.deepEqual((await f.store.query({ kind: 'task.archives' })).map(row => row.taskId), ['archived-0', 'archived-1', 'archived-2'])
  const readback = new DatabaseSync(f.dbPath, { readOnly: true })
  assert.deepEqual(readback.prepare("SELECT seq,payload FROM execution_events WHERE kind='task.archive' ORDER BY seq").all(), before)
  assert.deepEqual(readback.prepare("SELECT seq,payload FROM execution_events WHERE kind='task.archive' ORDER BY seq DESC").all(), [...before].reverse())
  readback.close()
})
test('话题事实 v4→v5 离线迁移先零写检查并备份，逐条回读身份',async t=>{
  const f=await fixture(t)
  await f.store.close()
  const raw=new DatabaseSync(f.dbPath)
  raw.exec('PRAGMA foreign_keys=ON')
  const fact={id:'old-fact',kind:'constraint',text:'只用中文',sourceRefs:[{sourceKey:'m',sourceVersion:1,text:'只用中文'}],status:'active'}
  raw.prepare('INSERT INTO message_runs(run_id,source_key,source_version,body) VALUES(?,?,?,?)').run('migration-source','m',1,JSON.stringify({runId:'migration-source',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'owner',body:'只用中文'}))
  raw.prepare('INSERT INTO message_runs(run_id,source_key,source_version,body) VALUES(?,?,?,?)').run('stale-v1','stale',1,JSON.stringify({conversationId:'g',body:'只用中文'}))
  raw.prepare('INSERT INTO message_runs(run_id,source_key,source_version,body) VALUES(?,?,?,?)').run('stale-v2','stale',2,JSON.stringify({conversationId:'g',body:'已修改'}))
  const topic={topicId:'old-topic',conversationId:'g',title:'旧话题',revision:1,inputRevision:1,facts:[fact,{...fact,id:'implicit-fact',status:undefined},{...fact,id:'stale-fact',status:undefined,sourceRefs:[{sourceKey:'stale',sourceVersion:1,text:'只用中文'}]}]}
  raw.prepare('INSERT INTO message_topics(topic_id,conversation_id,body) VALUES(?,?,?)').run(topic.topicId,topic.conversationId,JSON.stringify(topic))
  raw.exec('DROP TABLE message_topic_facts; PRAGMA user_version=4')
  raw.prepare('UPDATE execution_meta SET schema_version=4 WHERE singleton=1').run()
  raw.close()
  const script=resolve('scripts/migrate-message-topic-facts.js')
  const invalidSource=new DatabaseSync(f.dbPath)
  invalidSource.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify({conversationId:'other-group',body:'只用中文'}),'migration-source')
  invalidSource.close()
  const rejected=spawnSync(process.execPath,[script,'--check',f.dbPath],{encoding:'utf8'})
  assert.notEqual(rejected.status,0)
  assert.match(rejected.stderr,/MIGRATION_FACT_SOURCE_INVALID/)
  const restoredSource=new DatabaseSync(f.dbPath)
  restoredSource.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify({runId:'migration-source',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'owner',body:'只用中文'}),'migration-source')
  restoredSource.close()
  const check=spawnSync(process.execPath,[script,'--check',f.dbPath],{encoding:'utf8'})
  assert.equal(check.status,0,check.stderr)
  assert.equal(JSON.parse(check.stdout).facts,3)
  assert.equal(JSON.parse(check.stdout).unknownEffects,0)
  assert.equal(JSON.parse(check.stdout).pendingApprovals,0)
  assert.equal(JSON.parse(check.stdout).baseline.execution_runs.count,1)
  const unchanged=new DatabaseSync(f.dbPath,{readOnly:true})
  assert.equal(Object.values(unchanged.prepare('PRAGMA user_version').get())[0],4)
  assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='message_topic_facts'").get(),undefined)
  unchanged.close()
  const liveOwner=new DatabaseSync(f.dbPath+'.owner.sqlite')
  liveOwner.exec('BEGIN EXCLUSIVE')
  try {
    const blocked=spawnSync(process.execPath,[script,'--execute',f.dbPath],{encoding:'utf8'})
    assert.notEqual(blocked.status,0)
    assert.match(blocked.stderr,/locked|busy/)
    const blockedReadback=new DatabaseSync(f.dbPath,{readOnly:true})
    assert.equal(Object.values(blockedReadback.prepare('PRAGMA user_version').get())[0],4)
    assert.equal(blockedReadback.prepare("SELECT name FROM sqlite_master WHERE name='message_topic_facts'").get(),undefined)
    blockedReadback.close()
  } finally {liveOwner.exec('ROLLBACK');liveOwner.close()}
  const execute=spawnSync(process.execPath,[script,'--execute',f.dbPath],{encoding:'utf8'})
  assert.equal(execute.status,0,execute.stderr)
  const result=JSON.parse(execute.stdout)
  assert.deepEqual(result.baseline,JSON.parse(check.stdout).baseline)
  assert.equal((await stat(result.backupPath)).size>0,true)
  const backup=new DatabaseSync(result.backupPath,{readOnly:true})
  assert.equal(Object.values(backup.prepare('PRAGMA user_version').get())[0],4)
  assert.equal(JSON.parse(backup.prepare('SELECT body FROM message_topics WHERE topic_id=?').get('old-topic').body).facts[0].id,'old-fact')
  backup.close()
  const migrated=new DatabaseSync(f.dbPath,{readOnly:true})
  assert.equal(Object.values(migrated.prepare('PRAGMA user_version').get())[0],5)
  assert.deepEqual(JSON.parse(migrated.prepare('SELECT body FROM message_topic_facts WHERE topic_id=? AND fact_id=?').get('old-topic','old-fact').body),fact)
  assert.equal(JSON.parse(migrated.prepare('SELECT body FROM message_topics WHERE topic_id=?').get('old-topic').body).facts,undefined)
  assert.equal(JSON.parse(migrated.prepare('SELECT body FROM message_topic_facts WHERE fact_id=?').get('implicit-fact').body).status,'active')
  assert.equal(JSON.parse(migrated.prepare('SELECT body FROM message_topic_facts WHERE fact_id=?').get('stale-fact').body).status,'invalidated')
  migrated.close()
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

test('Owner候选落盘后进程强杀，重开原Task重新领取且旧租约失效', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-crash-'))
  const dbPath = join(root, 'control.sqlite'), instanceId = 'owner-crash'
  let store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }) })
  await store.command(command('task.plan.create', { taskId: 'task-owner', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'analysis', workflowDigest: d, unavailableReason: null,
      requirementRef: 'sha256/input.json', gate: 'none' }] }))
  await store.command(command('task.owner.init', { taskId: 'task-owner', sessionId: 'owner-session',
    sourceKey: 'source-1', criteria: ['核验目标'] }))
  await store.command(command('task.owner.event', { taskId: 'task-owner', eventKey: 'event-1', eventType: 'task.created' }))
  await store.close(); store = null
  const probe = child(t, `const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});
    await s.command({id:'claim',kind:'task.owner.claim',args:{taskId:'task-owner',turnId:'turn-old',expectedLeaseEpoch:0}});
    await s.command({id:'bound',kind:'task.owner.sessionBound',args:{taskId:'task-owner',turnId:'turn-old',leaseEpoch:1,sessionId:'owner-session'}});
    await s.command({id:'candidate',kind:'task.owner.candidate',args:{taskId:'task-owner',turnId:'turn-old',leaseEpoch:1,
      decision:{action:'advance',summary:'推进原任务',evidenceRefs:[]}}});
    process.send({type:'candidate'});setInterval(()=>{},10000)`, [dbPath, instanceId])
  await probe.message('candidate')
  assert.equal(probe.proc.kill('SIGKILL'), true)
  assert.equal((await probe.exited).signal, 'SIGKILL')
  store = await openExecutionStore({ dbPath, instanceId })
  const owner = await store.query({ kind: 'task.owner', taskId: 'task-owner' })
  assert.equal(owner.status, 'pending')
  assert.equal(owner.sessionId, 'owner-session')
  assert.equal(owner.processedWatermark, 0)
  assert.equal((await store.query({ kind: 'task.owner.events', taskId: 'task-owner', limit: 10 })).length, 1)
  await assert.rejects(store.command(command('task.owner.accept', { taskId: 'task-owner', turnId: 'turn-old',
    leaseEpoch: 1 })), { code: 'TASK_OWNER_LEASE_STALE' })
  await store.close(); store = null
  const accepted = child(t, `const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});
    const claim=(await s.command({id:'claim-new',kind:'task.owner.claim',args:{taskId:'task-owner',turnId:'turn-new',expectedLeaseEpoch:Number(process.argv[3])}})).result;
    await s.command({id:'bound-new',kind:'task.owner.sessionBound',args:{taskId:'task-owner',turnId:'turn-new',leaseEpoch:claim.leaseEpoch,sessionId:'owner-session'}});
    await s.command({id:'candidate-new',kind:'task.owner.candidate',args:{taskId:'task-owner',turnId:'turn-new',leaseEpoch:claim.leaseEpoch,
      decision:{action:'advance',summary:'重新接纳原任务',evidenceRefs:[]}}});
    await s.command({id:'accept-after-kill',kind:'task.owner.accept',args:{taskId:'task-owner',turnId:'turn-new',leaseEpoch:claim.leaseEpoch}});
    process.send({type:'accepted',sessionId:claim.sessionId,eventWatermark:claim.eventWatermark});setInterval(()=>{},10000)`, [dbPath, instanceId, String(owner.leaseEpoch)])
  const acceptedReceipt = await accepted.message('accepted')
  assert.equal(acceptedReceipt.sessionId, 'owner-session')
  assert.equal(acceptedReceipt.eventWatermark, owner.eventWatermark)
  assert.equal(accepted.proc.kill('SIGKILL'), true)
  assert.equal((await accepted.exited).signal, 'SIGKILL')
  store = await openExecutionStore({ dbPath, instanceId })
  const afterAcceptance = await store.query({ kind: 'task.owner', taskId: 'task-owner' })
  assert.equal(afterAcceptance.processedWatermark, afterAcceptance.eventWatermark)
  assert.deepEqual((await store.query({ kind: 'task.owner.actions.pending', limit: 10 })).map(item => item.turnId), ['turn-new'])
  assert.equal((await store.query({ kind: 'receipt', commandId: 'accept-after-kill' })).result.status, 'accepted')
})

test('Owner已接纳的追加阶段落盘后强杀，重启只应用一次原决定', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-applied-crash-'))
  const dbPath = join(root, 'control.sqlite'), instanceId = 'owner-action-crash'
  let store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }) })
  await store.command(command('task.plan.create', { taskId: 'task-owner', requirementRevision: 1,
    stages: [{ stageId: 'stage-1', workflowId: 'analysis', workflowDigest: d, unavailableReason: null,
      requirementRef: 'sha256/input.json', gate: 'none' }] }))
  await store.command(command('task.owner.init', { taskId: 'task-owner', sessionId: 'owner-session',
    sourceKey: 'source-1', criteria: ['完成两个阶段'] }))
  await store.command(command('task.owner.event', { taskId: 'task-owner', eventKey: 'event-1', eventType: 'task.created' }))
  await store.command(command('task.owner.claim', { taskId: 'task-owner', turnId: 'turn-accepted', expectedLeaseEpoch: 0 }))
  await store.command(command('task.owner.sessionBound', { taskId: 'task-owner', turnId: 'turn-accepted',
    leaseEpoch: 1, sessionId: 'owner-session' }))
  await store.command(command('task.owner.candidate', { taskId: 'task-owner', turnId: 'turn-accepted', leaseEpoch: 1,
    decision: { action: 'advance', summary: '追加后续阶段', evidenceRefs: [],
      appendStages: [{ workflowId: 'analysis', gate: 'none' }] } }))
  await store.command(command('task.owner.accept', { taskId: 'task-owner', turnId: 'turn-accepted', leaseEpoch: 1 }))
  await store.close(); store = null
  const probe = child(t, `const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});
    const {createTaskOwnerController}=await import(${JSON.stringify(ownerControllerUrl)});
    const s=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});
    const controller={taskPlan:taskId=>s.query({kind:'task.plan',taskId}),
      extendTaskPlan:async({commandId,taskId,expectedPlanRevision,expectedControlRevision,requirementRevision,stages})=>s.command({id:commandId,kind:'task.plan.extend',args:{taskId,expectedPlanRevision,expectedControlRevision,requirementRevision,
        stages:stages.map(stage=>({stageId:stage.stageId,workflowId:stage.workflowId,workflowDigest:'a'.repeat(64),unavailableReason:null,requirementRef:null,gate:stage.gate}))}})};
    const owner=createTaskOwnerController({ctx:{},store:s,artifacts:{},controller,modelConfig:()=>({}),
      authorizeStages:async()=>true,sessionRunner:{close:async()=>{}},
      advanceTask:async()=>{process.send({type:'plan-applied'});await new Promise(()=>{})}});
    await owner.applyPending()`, [dbPath, instanceId])
  await probe.message('plan-applied')
  assert.equal(probe.proc.kill('SIGKILL'), true)
  assert.equal((await probe.exited).signal, 'SIGKILL')
  store = await openExecutionStore({ dbPath, instanceId })
  const plan = await store.query({ kind: 'task.plan', taskId: 'task-owner' })
  assert.equal(plan.stages.length, 2)
  assert.equal(plan.task.requirementRevision, 2)
  let resumedCalls = 0
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts: {},
    controller: { taskPlan: taskId => store.query({ kind: 'task.plan', taskId }) },
    modelConfig: () => ({}), authorizeStages: async () => true,
    sessionRunner: { close: async () => {} }, advanceTask: async () => { resumedCalls++ } })
  assert.deepEqual(await owner.applyPending(), [])
  assert.deepEqual(await owner.applyPending(), [])
  assert.equal(resumedCalls, 1)
  assert.equal((await store.query({ kind: 'task.plan', taskId: 'task-owner' })).stages.length, 2)
  assert.deepEqual(await store.query({ kind: 'task.owner.actions.pending', limit: 10 }), [])
  await owner.close()
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
  const retryTiming = (await f.query()).nodes[0]
  assert.ok(Date.parse(retryTiming.startedAt) >= Date.parse(state.nodes[0].startedAt))
  assert.equal(retryTiming.completedAt, null)
  const replay = await f.store.command(command('node.claim', { runId: 'run', nodeId: 'one', expectedGeneration: 1, expectedLeaseEpoch: 0 }, 'claim'))
  assert.equal(replay.replayed, true)
  assert.equal((await f.query()).run.claimCount, 2)
  assert.equal((await f.query()).nodes[0].startedAt, retryTiming.startedAt)
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
test('Task 历史 run 游标分页保持范围且无遗漏重复',async t=>{
  const f=await fixture(t,null)
  for(const runId of ['history-1','history-2','history-3']){
    await f.store.command(command('run.create',creation([plan()],{runId,taskId:'history-task'})))
    await f.store.command(command('run.stop',{runId,reason:'test'}))
    await f.store.command(command('run.stopped',{runId}))
  }
  await f.store.command(command('run.create',creation([plan()],{runId:'other-run',taskId:'other-task'})))
  const first=await f.store.query({kind:'run.list',taskId:'history-task',limit:2})
  assert.deepEqual(first.map(run=>run.runId),['history-3','history-2'])
  assert.ok(first.every(run=>Number.isSafeInteger(run.sequenceId)))
  const second=await f.store.query({kind:'run.list',taskId:'history-task',limit:2,beforeSequenceId:first.at(-1).sequenceId})
  assert.deepEqual(second.map(run=>run.runId),['history-1'])
  assert.equal(new Set([...first,...second].map(run=>run.runId)).size,3)
  assert.deepEqual(await f.store.query({kind:'run.list',taskId:'history-task',activeOnly:true}),[])
  assert.deepEqual((await f.store.query({kind:'run.list',activeOnly:true})).map(run=>run.runId),['other-run'])
  await rejects(f.store.query({kind:'run.list',beforeSequenceId:0}),'INVALID_ARGUMENT')
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

test('领取统计跨重启保留，重复恢复不触发次数截止', async t => {
  const f = await fixture(t)
  for(let index=0;index<8;index++) {
    const n=await f.claim('one',1,index)
    await f.drain(n)
    await f.store.command(command('node.commit',{...identity(n),inputDigest:n.inputDigest,evidenceRefs:[],outcome:'waiting',waitReason:{kind:'recovery',reference:'ECONNRESET'}}))
    await f.store.command(command('run.recover',{runId:'run'}))
  }
  await f.store.close();await f.open()
  assert.equal((await f.query()).run.claimCount,8)
  const claim=command('node.claim',{runId:'run',nodeId:'one',expectedGeneration:1,expectedLeaseEpoch:8},'after-restart')
  assert.equal((await f.store.command(claim)).result.status,'applied')
  assert.equal((await f.store.command(claim)).replayed,true)
  assert.equal((await f.query()).run.claimCount,9)
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

test('原生worker启动校验超过旧10秒仍等待ready，不消耗命令回执窗口', {timeout:25000}, async t=>{
 const f=await fixture(t,null);await f.store.close()
 const probe=child(t,`const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});const started=Date.now();const store=await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});process.send({type:'ready',elapsed:Date.now()-started,healthy:store.healthy});await store.close()`,[f.dbPath,f.instanceId],
  "import {isMainThread} from 'node:worker_threads';if(!isMainThread)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10500)")
 const result=await probe.message('ready');assert.ok(result.elapsed>=10500);assert.equal(result.healthy,true);assert.equal((await probe.exited).code,0)
})

for(const mode of ['exit','error'])test(`原生worker在ready前${mode}仍明确拒绝，不永久等待`,async t=>{
 const f=await fixture(t,null);await f.store.close()
 const preload="import {isMainThread} from 'node:worker_threads';if(!isMainThread){"+(mode==='exit'?"process.exit(0)":"throw new Error('startup-worker-failure')")+'}'
 const probe=child(t,`const {openExecutionStore}=await import(${JSON.stringify(moduleUrl)});try{await openExecutionStore({dbPath:process.argv[1],instanceId:process.argv[2]});process.send({type:'result',unexpected:true})}catch(error){process.send({type:'result',code:error.code,message:error.message})}`,[f.dbPath,f.instanceId],preload)
 const result=await probe.message('result');assert.equal(result.unexpected,undefined)
 if(mode==='exit')assert.equal(result.code,'STORE_UNAVAILABLE');else assert.match(result.message,/startup-worker-failure/)
 assert.equal((await probe.exited).code,0)
})
import { migrateContinuousExecution } from '../scripts/migrate-continuous-execution.mjs'

test('v6到v7移除领取截止，检查零写并完整保留来源和执行数据', async t => {
  const f = await fixture(t)
  await f.store.command(command('runtime.maintenance.change', {active:true,expectedRevision:0,maintenanceId:'continuous',actorId:'owner',reason:'migration'}))
  await f.store.command(command('runtime.maintenance.seal', {expectedRevision:1,maintenanceId:'continuous',actorId:'owner',reason:'seal'}))
  await f.store.close()
  const db=new DatabaseSync(f.dbPath)
  const current=db.prepare("SELECT sql FROM sqlite_master WHERE name='execution_runs'").get().sql
  const cols=db.prepare('PRAGMA table_info(execution_runs)').all().map(x=>'"'+x.name+'"').join(',')
  const prior=current.replace('CREATE TABLE execution_runs','CREATE TABLE prior_runs').replace('claim_count INTEGER','max_claims INTEGER NOT NULL DEFAULT 3 CHECK(max_claims>0),claim_count INTEGER').replace('CHECK(claim_count>=0)','CHECK(claim_count>=0 AND claim_count<=max_claims)')
  db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;DROP INDEX execution_events_kind_seq');db.exec(prior)
  db.exec(`INSERT INTO prior_runs(${cols}) SELECT ${cols} FROM execution_runs;DROP TABLE execution_runs;ALTER TABLE prior_runs RENAME TO execution_runs;CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id) WHERE status NOT IN ('succeeded','failed','cancelled');PRAGMA user_version=6;UPDATE execution_meta SET schema_version=6;COMMIT;PRAGMA foreign_keys=ON`)
  const check=migrateContinuousExecution(db,{mode:'check'});assert.equal(check.writes,0)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,6)
  const result=migrateContinuousExecution(db,{mode:'execute'});assert.equal(result.verified,true);assert.deepEqual(result.baseline,check.baseline)
  assert.ok(!db.prepare('PRAGMA table_info(execution_runs)').all().some(x=>x.name==='max_claims'))
  db.prepare('UPDATE execution_runs SET claim_count=500 WHERE run_id=?').run('run')
  assert.equal(db.prepare('SELECT claim_count FROM execution_runs').get().claim_count,500)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  db.close()
  await rejects(f.open(), 'STORE_SCHEMA_MISMATCH')
  const indexMigration = new DatabaseSync(f.dbPath)
  const indexCheck = migrateExecutionEventsIndex(indexMigration, { mode: 'check' })
  assert.equal(indexCheck.writes, 0)
  assert.equal(migrateExecutionEventsIndex(indexMigration, { mode: 'execute' }).verified, true)
  indexMigration.close()
  await f.open();assert.equal((await f.query()).run.claimCount,500)
})

for(const variant of ['clean','receipt','stage','run','undrained','effect','source','lease','requirement','authorization','control','condition','external','fence'])test(`工程准备未落计划的Owner受管重评：${variant}`,async t=>{
 const f=await fixture(t,null),send=(kind,args,id)=>f.store.command(command(kind,args,id))
 await send('task.accept',{taskId:'task',requirementRef:'sha256/requirement.json',requirementRevision:1,sessionId:'owner',criteria:['按文档开发'],sourceKey:'source',eventKey:'created'})
 await send('message.receive',{runId:'source-run',sourceKey:'source',sourceVersion:1,actorId:'requester',conversationId:'g',body:'按文档开发'})
 await send('message.split',{runId:'source-run',units:[{unitId:'unit'}]})
 await send('message.accept',{runId:'source-run',unitId:'unit',commands:[{commandId:'create-task',kind:'create',args:{taskId:'task'}}]})
 const msg=(await send('message.command.claim',{commandId:'create-task'})).result.command
 await send('message.command.complete',{commandId:'create-task',leaseEpoch:msg.leaseEpoch,result:{taskId:'task'}})
 const claim=(await send('task.owner.claim',{taskId:'task',turnId:'prepare',expectedLeaseEpoch:0})).result
 const binding={taskId:'task',turnId:'prepare',leaseEpoch:claim.leaseEpoch}
 await send('task.owner.sessionBound',{...binding,sessionId:'owner'},variant==='receipt'?'owner-plan:prepare':undefined)
 await send('task.owner.candidate',{...binding,decision:{action:'advance',summary:'准备工程',evidenceRefs:[],planChange:{kind:'initialize',stages:[{workflowId:variant==='external'?'task-data-change':'task-engineering',gate:'none',sourceCondition:{sourceKey:'source',sourceVersion:1,sourceQuote:variant==='condition'?'错误原文':'按文档开发',objective:variant==='condition'?'错误原文':'按文档开发'}}]}}})
 await send('task.owner.accept',binding)
 await send('task.owner.action.fail',{...binding,reason:'128'})
 if(['stage','run','undrained','effect','authorization','fence'].includes(variant)){
  await f.store.close()
  const db=new DatabaseSync(f.dbPath)
  try{
   if(variant==='stage')db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,gate,status,attempt) VALUES('task',1,'old',0,'task-investigation','none','invalidated',1)").run()
   if(variant==='fence')db.prepare("UPDATE task_owners SET input_fence_revision=input_fence_revision+1 WHERE task_id='task'").run()
   if(variant==='authorization')db.prepare("UPDATE task_owners SET authorization_revision=authorization_revision+1 WHERE task_id='task'").run()
   if(['run','undrained','effect'].includes(variant)){
    const now=new Date().toISOString()
    db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,created_at,updated_at) VALUES('prior','task','task-investigation',?,'sha256/requirement.json','succeeded',?,?)").run(d,now,now)
    if(['undrained','effect'].includes(variant))db.prepare("INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status,drained) VALUES('prior-node','prior','n','1','code',0,1,'sha256/requirement.json',?,'succeeded',0)").run(d)
    if(variant==='effect')db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('effect','operation','prior','prior-node','n',1,?,?,'{}','[]','test','succeeded',?,?)").run(d,d,now,now)
   }
  }finally{db.close()}
  await f.open()
 }
 const owner=await f.store.query({kind:'task.owner',taskId:'task'})
 const {executionDigest}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
 const args={taskId:'task',eventKey:'reassess',payloadRef:'sha256/recovery.json',expectedOwnerRevision:owner.revision,expectedLeaseEpoch:owner.leaseEpoch+(variant==='lease'?1:0),expectedRequirementRevision:variant==='requirement'?2:1,expectedControlRevision:(await f.store.query({kind:'task.plan',taskId:'task'})).task.controlRevision+(variant==='control'?1:0),sources:[{sourceKey:'source',sourceVersion:variant==='source'?2:1,actorId:'requester',bodyDigest:executionDigest('按文档开发')}],requestDigest:d}
 if(variant!=='clean'){
  await assert.rejects(send('task.owner.reassess',args,'reassess'),/TASK_OWNER_REASSESS|TASK_AUTHORIZATION_SOURCE_STALE|TASK_OWNER_DISCARD_UNSAFE/)
  assert.equal((await f.store.query({kind:'task.owner',taskId:'task'})).status,'blocked')
 }else{
  const result=await send('task.owner.reassess',args,'reassess')
  assert.equal(result.result.discardedTurnId,'prepare')
  assert.equal((await f.store.query({kind:'task.owner',taskId:'task'})).status,'pending')
  assert.equal((await send('task.owner.reassess',args,'reassess')).replayed,true)
  assert.deepEqual(await f.store.query({kind:'run.list',taskId:'task'}),[])
 }
})

test('provider暂态恢复沿用退避且重启后最多三次', async t => {
  const f = await fixture(t), n = await f.claim(); await f.drain(n)
  await f.store.command(command('node.commit', { ...identity(n), inputDigest: d, outcome: 'waiting', evidenceRefs: [], waitReason: { kind: 'recovery', reference: 'EXECUTION_PROVIDER_TRANSIENT' } }))
  const state = await f.query(), args = { runId: 'run', runRevision: state.run.revision, nodeRunId: n.nodeRunId, generation: n.generation, leaseEpoch: n.leaseEpoch, inputDigest: d, errorCode: 'EXECUTION_PROVIDER_TRANSIENT' }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const admitted = (await f.store.command(command('run.recovery.admit', args))).result
    assert.equal(admitted.attempt, attempt)
    assert.ok(Date.parse(admitted.nextRetryAt) > Date.now())
    if (attempt < 3) await rejects(f.store.command(command('run.recovery.admit', args)), 'RECOVERY_RETRY_DEFERRED')
    await f.store.close()
    const db = new DatabaseSync(f.dbPath)
    try { db.prepare("UPDATE execution_events SET payload=json_set(payload,'$.nextRetryAt','2000-01-01T00:00:00.000Z') WHERE kind='run.recovery.admitted'").run() } finally { db.close() }
    await f.open()
  }
  await rejects(f.store.command(command('run.recovery.admit', args)), 'RECOVERY_RETRY_LIMIT')
  assert.equal((await f.query()).run.status, 'waiting')
})

for (const variant of ['valid', 'revision', 'lease', 'digest', 'session', 'output', 'undrained', 'effect']) test(`旧未提交错误受管重分类CAS：${variant}`, async t => {
  const f = await fixture(t, creation([plan('one', 'agent')])), n = await f.claim()
  await f.store.command(command('node.sessionBound', { ...identity(n), sessionId: n.sessionId })); await f.drain(n)
  await f.store.command(command('node.commit', { ...identity(n), inputDigest: d, outcome: 'waiting', evidenceRefs: [], waitReason: { kind: 'recovery', reference: 'execution_no_submission' } }))
  const state = await f.query(), args = { runId: 'run', runRevision: state.run.revision, nodeRunId: n.nodeRunId, generation: n.generation, leaseEpoch: n.leaseEpoch, inputDigest: d, sessionId: n.sessionId, evidenceRef: 'sha256/provider-proof.json' }
  if (variant === 'revision') args.runRevision--
  if (variant === 'lease') args.leaseEpoch++
  if (variant === 'digest') args.inputDigest = changedDigest
  if (variant === 'session') args.sessionId = 'foreign'
  if (['output', 'undrained', 'effect'].includes(variant)) {
    const db = new DatabaseSync(f.dbPath)
    try {
      if (variant === 'output') db.prepare("UPDATE execution_nodes SET output_ref='sha256/submitted.json' WHERE node_run_id=?").run(n.nodeRunId)
      if (variant === 'undrained') db.prepare('UPDATE execution_nodes SET drained=0 WHERE node_run_id=?').run(n.nodeRunId)
      if (variant === 'effect') db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('prior-effect','operation','run',?,'one',1,?,'digest','{}','[]','fixture','succeeded','now','now')").run(n.nodeRunId,d)
    } finally { db.close() }
  }
  const cmd = command('node.failure.reclassify', { ...args, previousCode: 'execution_no_submission', code: 'EXECUTION_PROVIDER_TRANSIENT' })
  if (variant !== 'valid') { await rejects(f.store.command(cmd), 'NODE_FAILURE_RECLASSIFICATION_NOT_ADMITTED'); assert.equal((await f.query()).nodes[0].waitReason.reference, 'execution_no_submission'); return }
  assert.equal((await f.store.command(cmd)).result.reclassified, true)
  const after = await f.query(); assert.equal(after.nodes[0].waitReason.reference, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal(after.nodes[0].leaseEpoch, n.leaseEpoch); assert.equal(after.run.revision, state.run.revision + 1)
  assert.equal((await f.store.command(cmd)).result.reclassified, true)
})

for(const scenario of ['restarted','running-reserved','stale-revision','same-lease']) test(`受管工程会话换绑CAS ${scenario}`,async t=>{
  const f=await fixture(t,creation([plan('one','agent')]))
  let n=await f.claim()
  await f.store.command(command('node.sessionBound',{...identity(n),sessionId:n.sessionId}))
  await f.store.close();await f.open()
  if(scenario==='running-reserved'||scenario==='same-lease'){
    await f.drain(n);await f.store.command(command('run.recover',{runId:'run'}));n=await f.claim('one',1,1)
  }
  await f.store.command(command('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'repair',actorId:'owner',reason:'migration'}))
  const state=await f.query(),node=state.nodes[0]
  const args={runId:'run',runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,sessionId:node.sessionId,nextSessionId:'execution-child',lastInputLease:1,evidenceRef:'sha256/ownership.json',maintenance:{maintenanceId:'repair',revision:1}}
  if(scenario==='stale-revision')args.runRevision--
  if(scenario==='same-lease')args.lastInputLease=node.leaseEpoch
  if(['stale-revision','same-lease'].includes(scenario)){await rejects(f.store.command(command('node.session.rebind',args)),'NODE_SESSION_REBIND_NOT_ADMITTED');return}
  const cmd=command('node.session.rebind',args)
  await f.store.command(cmd)
  assert.equal((await f.store.command(cmd)).replayed,true)
  const after=await f.query()
  assert.equal(after.nodes[0].sessionId,'execution-child');assert.equal(after.nodes[0].status,'ready');assert.equal(after.nodes[0].drained,true)
  assert.equal(after.nodes[0].nodeRunId,node.nodeRunId);assert.equal(after.run.generation,state.run.generation)
})

test('维护中受管会话换绑要求维护CAS且不放行业务claim',async t=>{
  const f=await fixture(t,creation([plan('one','agent')])),n=await f.claim()
  await f.store.command(command('node.sessionBound',{...identity(n),sessionId:n.sessionId}))
  await f.store.close();await f.open()
  await f.store.command(command('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'repair',actorId:'owner',reason:'归属修复'}))
  const state=await f.query(),node=state.nodes[0]
  const args={runId:'run',runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,sessionId:node.sessionId,nextSessionId:'execution-child',lastInputLease:1,evidenceRef:'sha256/ownership.json'}
  await rejects(f.store.command(command('node.session.rebind',args)),'RUNTIME_MAINTENANCE_STALE')
  await rejects(f.store.command(command('node.session.rebind',{...args,maintenance:{maintenanceId:'repair',revision:0}})),'RUNTIME_MAINTENANCE_STALE')
  await f.store.command(command('node.session.rebind',{...args,maintenance:{maintenanceId:'repair',revision:1}}))
  assert.equal((await f.query()).nodes[0].drained,true)
  await rejects(f.claim('one',1,1),'RUNTIME_MAINTENANCE_ACTIVE')
})
