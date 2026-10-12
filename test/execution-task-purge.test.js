import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {approvedPurgeTaskIds} from '../packages/dingtalk-dsh-assistant/execution-task-purge.js'
const hash='a'.repeat(64),ref=taskId=>`tasks/${taskId}/sha256-${hash}.json`
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'dsh-purge-contract-')),dbPath=join(dir,'control.sqlite')
 const store=await openExecutionStore({dbPath,instanceId:'purge-test',initialize:true});let sequence=0
 const cmd=(kind,args,id=`command-${++sequence}`)=>store.command({id,kind,args})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 await cmd('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'purge-maintenance',actorId:'owner',reason:'isolated test'})
 for(const taskId of [...approvedPurgeTaskIds,'unrelated']){
  await cmd('task.plan.create',{taskId,requirementRevision:1,stages:[{stageId:'stage-1',workflowId:'old',workflowDigest:hash,unavailableReason:null,requirementRef:ref(taskId),gate:'none'}]})
  await cmd('task.owner.init',{taskId,sessionId:`session-${taskId}`,criteria:['original requirement'],sourceKey:'original'})
  await cmd('run.create',{taskId,runId:`run-${taskId}`,workflowId:'old',workflowDigest:hash,requirementRef:ref(taskId),nodes:[{nodeId:'apply',nodeVersion:'1',executor:'code',inputRef:ref(taskId),inputDigest:hash}],stageBinding:{planRevision:1,stageId:'stage-1',attempt:1,expectedControlRevision:1}})
 }
 return {dir,dbPath,store,cmd,args:{tasks:approvedPurgeTaskIds.map(taskId=>({taskId,expectedControlRevision:1})),actorId:'owner',reason:'authorized four-task migration'}}
}
test('exact four-task purge removes current and archived records and preserves requirement code and unrelated task',async t=>{
 const f=await fixture(t),before=await f.store.query({kind:'task.plan',taskId:'unrelated'})
 const file=join(f.dir,'uncommitted-source.js');await writeFile(file,'retained code')
 const preview=await f.store.query({kind:'task.execution.purge.check',...f.args});assert.equal(preview.runCount,4)
 assert.equal((await f.store.query({kind:'run.list',taskId:approvedPurgeTaskIds[0]})).length,1)
 const receipt=await f.cmd('task.execution.purge',f.args,'purge-four');assert.equal(receipt.result.cleanupPending,true)
 await assert.rejects(f.cmd('runtime.maintenance.change',{active:false,expectedRevision:1,maintenanceId:'purge-maintenance',actorId:'owner',reason:'must finish cleanup first'}),{code:'TASK_PURGE_CLEANUP_PENDING'})
 for(const taskId of approvedPurgeTaskIds){
  assert.equal((await f.store.query({kind:'run.list',taskId,includeArchived:true})).length,0)
  const plan=await f.store.query({kind:'task.plan',taskId});assert.equal(plan.task.requirementRef,ref(taskId));assert.equal(plan.task.controlState,'paused');assert.equal(plan.stages.length,0)
  assert.ok(await f.store.query({kind:'task.execution.purge.cleanup',taskId}))
  await f.cmd('task.execution.purge.files-complete',{taskId});assert.equal(await f.store.query({kind:'task.execution.purge.cleanup',taskId}),null)
 }
 assert.equal(await readFile(file,'utf8'),'retained code');assert.deepEqual(await f.store.query({kind:'task.plan',taskId:'unrelated'}),before)
 assert.equal((await f.cmd('task.execution.purge',f.args,'purge-four')).replayed,true)
})
test('scope and stale-control rejection leave every task intact',async t=>{
 const f=await fixture(t)
 for(const tasks of [f.args.tasks.slice(1),[...f.args.tasks.slice(1),{taskId:'unrelated',expectedControlRevision:1}]])await assert.rejects(f.cmd('task.execution.purge',{...f.args,tasks}),{code:'TASK_PURGE_SCOPE_INVALID'})
 await assert.rejects(f.cmd('task.execution.purge',{...f.args,tasks:f.args.tasks.map((item,i)=>i?item:{...item,expectedControlRevision:2})}),{code:'TASK_PURGE_CONTROL_STALE'})
 for(const taskId of approvedPurgeTaskIds)assert.equal((await f.store.query({kind:'run.list',taskId})).length,1)
})
test('nested real delivery receipts become minimal idempotency rows without retaining execution evidence',async t=>{
 const f=await fixture(t),taskId=approvedPurgeTaskIds[0],state=await f.store.query({kind:'run',runId:`run-${taskId}`})
 const db=new DatabaseSync(f.dbPath)
 try{
  db.prepare('INSERT INTO message_workflows(digest,body) VALUES(?,?)').run(hash,JSON.stringify({config:{taskId,repoId:'dataset-web',head:'codex/existing'}}))
  for(const action of ['commit','push','pr'])db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,result_json,created_at,updated_at) VALUES(?,'operation',?,?,'apply',1,?,?,?,'[]','authorization','succeeded',?,'now','now')`).run(`effect-${action}`,state.run.runId,state.nodes[0].nodeRunId,hash,hash,JSON.stringify({action}),JSON.stringify({result:action==='pr'?{url:'https://github.com/HiQ-AI/dataset-web/pull/370',head:'codex/existing'}:{commitId:'b'.repeat(40)}}))
 }finally{db.close()}
 await f.cmd('task.execution.purge',f.args)
 const ledger=await f.store.query({kind:'task.delivery.ledger',taskId});assert.equal(ledger.length,3);assert.ok(ledger.every(row=>row.branch==='codex/existing'&&row.repository==='dataset-web'));assert.equal(ledger.find(row=>row.action==='pr').externalId,'https://github.com/HiQ-AI/dataset-web/pull/370')
 const check=new DatabaseSync(f.dbPath,{readOnly:true});try{assert.equal(check.prepare('SELECT count(*) n FROM execution_effects').get().n,0);assert.equal(check.prepare('SELECT count(*) n FROM execution_nodes WHERE run_id=?').get(state.run.runId).n,0)}finally{check.close()}
})
test('foreign events receipts and group messages that reference a purged task remain intact',async t=>{
 const f=await fixture(t),taskId=approvedPurgeTaskIds[0],runId='run-'+taskId
 const db=new DatabaseSync(f.dbPath)
 try{
  const payload=JSON.stringify({taskId:'unrelated',runId:'run-unrelated',evidenceRefs:[taskId,runId]})
  db.prepare('INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES(?,?,?,?)').run('foreign-command','node.succeed',payload,'now')
  db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?)').run('foreign-command','a'.repeat(64),payload,'now')
  db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run('raw-message','raw-message',1,JSON.stringify({runId:'raw-message',body:'Reference '+taskId+' and '+runId}))
  db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run('foreign-notice','raw-message','notification',JSON.stringify({id:'foreign-notice',payload:{fact:{taskId:'unrelated'},text:'Reference '+taskId},status:'delivered'}))
 }finally{db.close()}
 await f.cmd('task.execution.purge',f.args)
 const check=new DatabaseSync(f.dbPath,{readOnly:true});try{
  assert.equal(check.prepare('SELECT count(*) n FROM execution_events WHERE command_id=?').get('foreign-command').n,1)
  assert.equal(check.prepare('SELECT count(*) n FROM execution_receipts WHERE command_id=?').get('foreign-command').n,1)
  assert.equal(check.prepare('SELECT count(*) n FROM message_items WHERE item_id=?').get('foreign-notice').n,1)
  assert.match(check.prepare('SELECT body FROM message_runs WHERE run_id=?').get('raw-message').body,/Reference/)
 }finally{check.close()}
})
