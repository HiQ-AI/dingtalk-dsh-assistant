import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
const h='a'.repeat(64),ref=`tasks/one/sha256-${h}.json`
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'dsh-reset-owner-history-')),options={dbPath:join(dir,'control.sqlite'),instanceId:'owner-reset-test'}
 let store=await openExecutionStore({...options,initialize:true}),i=0
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 const command=(kind,args)=>store.command({id:`cmd-${++i}`,kind,args})
 await command('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'test-reset',actorId:'owner',reason:'isolated reset owner test'})
 await command('task.accept',{taskId:'one',requirementRef:ref,requirementRevision:1,sessionId:'owner-one',criteria:['original requirement'],sourceKey:'source-one',eventKey:'create-one'})
 await command('task.plan.initialize',{taskId:'one',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'stage-1',workflowId:'work',workflowDigest:h,unavailableReason:null,requirementRef:ref,gate:'none'}]})
 await command('task.control.pause',{taskId:'one',expectedControlRevision:1})
 let plan=await store.query({kind:'task.plan',taskId:'one'})
 if(plan.task.controlState==='pausing')await command('task.control.settle',{taskId:'one',expectedControlRevision:plan.task.controlRevision})
 const controlRevision=(await store.query({kind:'task.plan',taskId:'one'})).task.controlRevision
 await store.close()
 const db=new DatabaseSync(options.dbPath),now=new Date().toISOString()
 db.prepare("INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,decision_json,status,application_status,created_at,updated_at) VALUES('history-one','one',1,1,1,1,3,1,0,?,'accepted','applied',?,?)").run(JSON.stringify({action:'wait',summary:'historical applied decision',evidenceRefs:[]}),now,now)
 db.prepare("UPDATE task_owners SET status='idle',processed_watermark=event_watermark WHERE task_id='one'").run();db.close()
 store=await openExecutionStore(options)
 const reset=()=>command('task.execution.reset',{taskId:'one',actorId:'owner',expectedControlRevision:controlRevision,reason:'reset preserves applied history'})
 return {reset,get store(){return store},async reopen(){await store.close();store=await openExecutionStore(options)},async edit(fn){await store.close();const db=new DatabaseSync(options.dbPath);try{fn(db)}finally{db.close()}},async read(){await store.close();const db=new DatabaseSync(options.dbPath,{readOnly:true});try{return {turn:{...db.prepare("SELECT status,application_status FROM task_owner_turns WHERE turn_id='history-one'").get()},corrections:db.prepare("SELECT count(*) n FROM execution_events WHERE kind='task.execution.reset.owner-schema-corrected'").get().n}}finally{db.close()}}}
}
test('reset with real applied Owner history remains valid after reopening store',async t=>{
 const f=await fixture(t);await f.reset();await f.reopen()
 assert.equal((await f.store.query({kind:'task.plan',taskId:'one'})).task.controlState,'paused')
 const value=await f.read();assert.deepEqual(value.turn,{status:'accepted',application_status:'applied'});assert.equal(value.corrections,0)
})
test('formal startup repairs only exact prior reset-produced historical state once, preserves applied fact',async t=>{
 const f=await fixture(t),receipt=await f.reset()
 await f.edit(db=>db.prepare("UPDATE task_owner_turns SET status='superseded',updated_at=? WHERE turn_id='history-one'").run(receipt.result.archivedAt))
 await f.reopen();await f.reopen()
 const value=await f.read();assert.deepEqual(value.turn,{status:'accepted',application_status:'applied'});assert.equal(value.corrections,1)
})
test('unrelated Owner schema error is not bypassed by reset compatibility repair',async t=>{
 const f=await fixture(t);await f.reset()
 await f.edit(db=>db.prepare("UPDATE task_owner_turns SET status='superseded',updated_at='2000-01-01T00:00:00Z' WHERE turn_id='history-one'").run())
 await assert.rejects(f.reopen(),{code:'TASK_OWNER_INVARIANT_FAILED'})
})
