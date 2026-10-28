import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { readdirSync, readFileSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createTaskLedgerDetails, detailTables } from '../packages/dingtalk-dsh-assistant/task-ledger-details.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { migrateTaskLedgerDetails } from '../scripts/migrate-task-ledger-details.mjs'

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function objectCount(root) {
  return inspect(join(root,'tasks','task','.dsh','ledger-details','objects.sqlite'), db => db.prepare('SELECT count(*) n FROM objects').get().n)
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'task-details-')), dbPath = join(root,'ledger.sqlite')
  let store = await openDynamicTaskStore({ dbPath, detailRoot: root, instanceId:'test', initialize:true })
  t.after(async () => { await store?.close(); await rm(root,{recursive:true,force:true}) })
  return { root, dbPath, get store() { return store }, async close() { await store.close(); store = null },
    async reopen() { store = await openDynamicTaskStore({ dbPath, detailRoot:root, instanceId:'test' }); return store } }
}
function inspect(dbPath, fn) { const db = new DatabaseSync(dbPath,{readOnly:true}); try { return fn(db) } finally { db.close() } }

test('task details live in task directory; receipt replay, decisions and restart restore full verified values', async t => {
  const f = await fixture(t), request = 'synthetic request '.repeat(4000)
  const create = { id:'create',kind:'task.create',args:{taskId:'task',request} }
  await f.store.command(create)
  const owner = (await f.store.command({id:'claim',kind:'task.claim',args:{taskId:'task'}})).result
  const decision = { id:'wait',kind:'task.wait',args:{binding:owner.binding,action:'wait',summary:'evidence '.repeat(3000),evidence:['synthetic:1']} }
  const original = await f.store.command(decision)
  const compact = inspect(f.dbPath,db => JSON.parse(db.prepare("SELECT body FROM dynamic_tasks WHERE id='task'").get().body))
  assert.equal(compact._hostDetail.owner.type,'task'); assert.equal(compact._hostDetail.owner.id,'task')
  assert.equal(compact.request.length,400)
  assert.equal(JSON.stringify(compact).includes(request),false)
  assert.equal((await f.store.query({kind:'task.get',taskId:'task'})).request,request)
  assert.equal((await f.store.query({kind:'task.decisions',taskId:'task'})).decisions[0].decision.summary,decision.args.summary)
  await f.close(); await f.reopen()
  const replay = await f.store.command(decision)
  assert.equal(replay.replayed,true); assert.deepEqual(replay.result,original.result)
  await assert.rejects(f.store.command({...create,args:{taskId:'task',request:'different'}}),{code:'DYNAMIC_COMMAND_ID_CONFLICT'})
  assert.equal(inspect(f.dbPath,db => db.prepare('PRAGMA user_version').get().user_version),3)
})

test('content-addressed trees deduplicate repeated snapshots and unchanged history entries', async t => {
  const f = await fixture(t), codec = createTaskLedgerDetails(f.root)
  const value = {id:'task',taskId:'task',request:'long '.repeat(2000),dialogue:Array.from({length:20},(_,i)=>({id:String(i),text:('item'+i).repeat(1000)}))}
  const first = codec.encode('dynamic_tasks',value), before = objectCount(f.root)
  assert.deepEqual(codec.decode(first,{table:'dynamic_tasks',id:'task'}),value)
  assert.deepEqual(codec.encode('dynamic_tasks',value),first)
  assert.equal(objectCount(f.root),before)
  codec.encode('dynamic_tasks',{...value,dialogue:[...value.dialogue,{id:'next',text:'new '.repeat(2000)}]})
  const after = objectCount(f.root)
  assert.ok(after-before<8,'appending history must reuse old entries, not copy its entire payload')
  codec.close()
})

test('missing/corrupt detail fails closed on query and replay while metadata pages avoid files', async t => {
  const f = await fixture(t), command = {id:'create',kind:'task.create',args:{taskId:'task',request:'private synthetic '.repeat(1000)}}
  await f.store.command(command)
  const raw = inspect(f.dbPath,db => JSON.parse(db.prepare("SELECT body FROM dynamic_receipts WHERE id='create'").get().body))
  const ref = raw._hostDetail, path = join(f.root,'tasks','task','.dsh','ledger-details','objects.sqlite')
  const local = new DatabaseSync(path)
  const saved = local.prepare('SELECT body FROM objects WHERE digest=?').get(ref.ref).body
  local.prepare('UPDATE objects SET body=? WHERE digest=?').run('{}',ref.ref)
  await assert.rejects(f.store.command(command),{code:'TASK_DETAIL_CORRUPT'})
  local.prepare('UPDATE objects SET body=? WHERE digest=?').run(saved,ref.ref)
  local.prepare('DELETE FROM objects WHERE digest=?').run(ref.ref)
  await assert.rejects(f.store.command(command),{code:'TASK_DETAIL_MISSING'})
  // Damage every detail object; the explicit index query must not open any.
  local.exec("UPDATE objects SET body='{}'"); local.close()
  await f.close(); await f.reopen() // Drained history must not be decoded at store startup.
  const page = await f.store.query({kind:'task.index',limit:1})
  assert.equal(page.items[0].taskId,'task')
  await assert.rejects(f.store.query({kind:'task.get',taskId:'task'}),{code:'TASK_DETAIL_CORRUPT'})
  assert.equal(inspect(f.dbPath,db => db.prepare('SELECT count(*) n FROM dynamic_tasks').get().n),1)
})

test('identity substitution and unsafe owner/junction paths are rejected', async t => {
  const f = await fixture(t), codec = createTaskLedgerDetails(f.root)
  const row = codec.encode('dynamic_tasks',{id:'a',taskId:'a',request:'detail'})
  assert.throws(()=>codec.decode(row,{table:'dynamic_tasks',id:'b'}),{code:'TASK_DETAIL_REFERENCE_INVALID'})
  const forged = structuredClone(row); forged._hostDetail.id='b'
  assert.throws(()=>codec.decode(forged,{table:'dynamic_tasks',id:'b'}),{code:'TASK_DETAIL_REFERENCE_INVALID'})
  assert.throws(()=>codec.encode('dynamic_tasks',{id:'bad',taskId:'../escape',request:'detail'}),{code:'TASK_DETAIL_OWNER_INVALID'})
  const outside=join(f.root,'outside'); await mkdir(outside)
  symlinkSync(outside,join(f.root,'tasks','escape'),process.platform==='win32'?'junction':'dir')
  assert.throws(()=>codec.encode('dynamic_tasks',{id:'escape',taskId:'escape',request:'detail'}),{code:'TASK_DETAIL_PATH_UNSAFE'})
  assert.equal(readdirSync(outside).length,0)
  codec.close()
})

test('failed publication rolls back control and receipt; retry does not repeat a committed command', async t => {
  const f=await fixture(t)
  await mkdir(join(f.root,'tasks'))
  writeFileSync(join(f.root,'tasks','task'),'not a directory')
  const command={id:'create',kind:'task.create',args:{taskId:'task',request:'synthetic'}}
  await assert.rejects(f.store.command(command),{code:'TASK_DETAIL_PATH_UNSAFE'})
  assert.equal(inspect(f.dbPath,db=>db.prepare('SELECT count(*) n FROM dynamic_tasks').get().n),0)
  assert.equal(inspect(f.dbPath,db=>db.prepare('SELECT count(*) n FROM dynamic_receipts').get().n),0)
  unlinkSync(join(f.root,'tasks','task'))
  const replies=await Promise.all([f.store.command(command),f.store.command(command)])
  assert.deepEqual(replies.map(r=>r.replayed),[false,true])
})

test('offline migration resumes atomically, preserves source and blocks partial runtime activation',async t=>{
  const f=await fixture(t)
  await f.store.command({id:'create',kind:'task.create',args:{taskId:'task',request:'original '.repeat(10000)}})
  const expected=await f.store.query({kind:'task.get',taskId:'task'})
  await f.close()
  // Build a genuine pre-externalization fixture, including full receipt bodies.
  const legacy=new DatabaseSync(f.dbPath), codec=createTaskLedgerDetails(f.root)
  try {
    for(const table of detailTables) for(const row of legacy.prepare(`SELECT id,body FROM ${table}`).all())
      legacy.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(JSON.stringify(codec.decode(JSON.parse(row.body),{table,id:row.id})),row.id)
    legacy.exec('PRAGMA user_version=2')
  } finally {codec.close();legacy.close()}
  const before=sha(f.dbPath), destination=join(f.root,'converted.sqlite'), detailRoot=join(f.root,'converted-root')
  await mkdir(detailRoot)
  const options={source:f.dbPath,destination,detailRoot,sourceDetailRoot:f.root,offline:true,maxRows:1}
  const first=await migrateTaskLedgerDetails(options)
  assert.equal(first.complete,false)
  await assert.rejects(openDynamicTaskStore({dbPath:destination,detailRoot,instanceId:'test'}),{code:'DYNAMIC_DETAIL_MIGRATION_INCOMPLETE'})
  let next=first
  for(let i=0;i<30&&!next.complete;i++)next=await migrateTaskLedgerDetails({...options,resume:true,maxRows:100})
  assert.equal(next.complete,true);assert.equal(sha(f.dbPath),before)
  assert.ok(readFileSync(destination).length<readFileSync(f.dbPath).length,'new control file must omit old payload pages without VACUUM')
  const migrated=await openDynamicTaskStore({dbPath:destination,detailRoot,instanceId:'test'})
  try{
    const actual=await migrated.query({kind:'task.get',taskId:'task'})
    assert.deepEqual(actual,expected)
    assert.equal((await migrated.command({id:'create',kind:'task.create',args:{taskId:'task',request:expected.request}})).replayed,true)
  }finally{await migrated.close()}
  await f.reopen()
  assert.deepEqual(await f.store.query({kind:'task.get',taskId:'task'}),expected,'original is independently usable for rollback')
})

test('Host maintenance permits only rebuildable coordination inspections and creates no scan receipts',async t=>{
  const f=await fixture(t)
  const before=inspect(f.dbPath,db=>db.prepare('SELECT count(*) n FROM dynamic_receipts').get().n)
  for(let i=0;i<20;i++)await f.store.maintain({kind:'coordination.schedule.scan',args:{}})
  assert.equal(inspect(f.dbPath,db=>db.prepare('SELECT count(*) n FROM dynamic_receipts').get().n),before)
  await assert.rejects(f.store.maintain({kind:'task.create',args:{taskId:'forbidden',request:'x'}}),{code:'DYNAMIC_MAINTENANCE_KIND_INVALID'})
  const scan={id:'explicit-scan',kind:'coordination.schedule.scan',args:{}}
  await f.store.command(scan)
  assert.equal((await f.store.command(scan)).replayed,true,'explicit command API retains its identity contract')
})

test('compact bodies preserve observer trigger keys and page metadata without decoding full histories',async t=>{
  const f=await fixture(t), codec=createTaskLedgerDetails(f.root), sql=new DatabaseSync(':memory:')
  try {
    const task={id:'task',taskId:'task',request:'long request '.repeat(1000),title:'Title',objective:'Goal',status:'active',control:'active',drained:true,
      humanRequests:[{requestId:'question',status:'waiting-reply',createdAt:'2026-10-28T00:00:00Z',question:'detailed question'}],
      lastDecision:{action:'blocked',summary:'long summary '.repeat(1000),question:'Need answer'},
      completion:{commandId:'complete',instructionIds:['member'],result:{summary:'Done',evidence:['proof']}}}
    const compact=codec.encode('dynamic_tasks',task)
    const row=sql.prepare("SELECT json_extract(?,'$.humanRequests[0].requestId') request_id,json_extract(?,'$.humanRequests[0].status') status,json_extract(?,'$.lastDecision.action') action,json_extract(?,'$.completion.commandId') command_id")
      .get(...Array(4).fill(JSON.stringify(compact)))
    assert.deepEqual({...row},{request_id:'question',status:'waiting-reply',action:'blocked',command_id:'complete'})
    assert.deepEqual(codec.decode(compact),task)
    const execution={id:'exec',executionId:'exec',taskId:'task',key:'run',input:{title:'Execution',context:'large '.repeat(2000)},definition:{executionBackend:'claude-code',systemPrompt:'large '.repeat(2000)}}
    const e=codec.encode('dynamic_executions',execution)
    assert.equal(e.input.title,'Execution');assert.equal(e.definition.executionBackend,'claude-code')
    assert.deepEqual(codec.decode(e),execution)
    const receipt=codec.encode('dynamic_receipts',{result:{task:{taskId:'task',requirementRevision:2,contextRevision:3,controlRevision:4,runSequence:1,request:task.request}},replayed:false},{id:'command'})
    assert.deepEqual(receipt.result.task,{taskId:'task',requirementRevision:2,contextRevision:3,controlRevision:4,runSequence:1})
  } finally {codec.close();sql.close()}
})

test('legacy inline rows are readable and only changed records become externalized',async t=>{
  const f=await fixture(t)
  await f.store.command({id:'create',kind:'task.create',args:{taskId:'task',request:'legacy detail'}})
  const original=await f.store.query({kind:'task.get',taskId:'task'})
  await f.close()
  const db=new DatabaseSync(f.dbPath)
  db.prepare("UPDATE dynamic_tasks SET body=? WHERE id='task'").run(JSON.stringify(original));db.close()
  await f.reopen()
  assert.deepEqual(await f.store.query({kind:'task.get',taskId:'task'}),original)
  assert.equal(inspect(f.dbPath,d=>JSON.parse(d.prepare("SELECT body FROM dynamic_tasks WHERE id='task'").get().body)._hostDetail),undefined)
  await f.store.command({id:'claim',kind:'task.claim',args:{taskId:'task'}})
  assert.ok(inspect(f.dbPath,d=>JSON.parse(d.prepare("SELECT body FROM dynamic_tasks WHERE id='task'").get().body)._hostDetail))
})
