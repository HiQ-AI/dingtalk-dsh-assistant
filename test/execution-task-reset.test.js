import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {createExecutionController} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
const h='a'.repeat(64),ref=id=>`tasks/${id}/sha256-${h}.json`
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'dsh-execution-reset-'))
 const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:'reset-test',initialize:true})
 let seq=0
 const cmd=(kind,args,id=`test-${++seq}`)=>store.command({id,kind,args})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 await cmd('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'reset-maintenance',actorId:'owner',reason:'isolated reset test'})
 async function task(taskId){
  await cmd('task.plan.create',{taskId,requirementRevision:1,stages:[{stageId:'stage-1',workflowId:'old-workflow',workflowDigest:h,unavailableReason:null,requirementRef:ref(taskId),gate:'none'}]})
  await cmd('run.create',{taskId,runId:`old-${taskId}`,workflowId:'old-workflow',workflowDigest:h,requirementRef:ref(taskId),nodes:[{nodeId:'prepare-workspace',nodeVersion:'1',executor:'code',inputRef:ref(taskId),inputDigest:h}],stageBinding:{planRevision:1,stageId:'stage-1',attempt:1,expectedControlRevision:1}})
  await cmd('task.control.pause',{taskId,expectedControlRevision:1})
  await cmd('run.pause',{runId:`old-${taskId}`,reason:'isolated test pause'})
  await cmd('run.paused',{runId:`old-${taskId}`})
  await cmd('task.control.settle',{taskId,expectedControlRevision:2})
 }
 const args=id=>({taskId:id,actorId:'owner',expectedControlRevision:3,reason:'restart retained requirement and code'})
 return {store,cmd,task,args,dir}
}
test('preview is read only; reset archives current run, preserves requirement/code, isolates other tasks',async t=>{
 const f=await fixture(t);await f.task('one');await f.task('two')
 const file=join(f.dir,'preserved-source.js');await writeFile(file,'uncommitted development changes')
 const before=await f.store.query({kind:'task.plan',taskId:'one'})
 const checked=await f.store.query({kind:'task.execution.reset.check',...f.args('one')})
 assert.deepEqual(checked.archivedRunIds,['old-one']);assert.equal(checked.physicallyDeletesFiles,false)
 assert.deepEqual(await f.store.query({kind:'task.plan',taskId:'one'}),before)
 const receipt=await f.cmd('task.execution.reset',f.args('one'),'reset-one')
 assert.equal(receipt.result.newRunId,null)
 assert.equal((await f.store.query({kind:'task.plan',taskId:'one'})).task.requirementRef,ref('one'))
 assert.equal((await f.store.query({kind:'task.plan',taskId:'one'})).task.controlState,'paused')
 assert.equal((await f.store.query({kind:'task.plan',taskId:'one'})).task.planRevision,0)
 assert.equal((await f.store.query({kind:'run.list',taskId:'one'})).length,0)
 assert.equal((await f.store.query({kind:'run.list',taskId:'one',includeArchived:true})).length,1)
 assert.equal((await f.store.query({kind:'run',runId:'old-one'})).run.status,'cancelled')
 assert.equal((await f.store.query({kind:'run',runId:'old-two'})).run.recoveryReason,'user_pause')
 assert.equal(await readFile(file,'utf8'),'uncommitted development changes')
 const replay=await f.cmd('task.execution.reset',f.args('one'),'reset-one');assert.equal(replay.replayed,true)
 await assert.rejects(f.cmd('task.execution.reset',f.args('one'),'second-click'),{code:'TASK_RESET_CONTROL_STALE'})
 await assert.rejects(f.cmd('task.execution.reset',{...f.args('one'),reason:'different'},'reset-one'),{code:'COMMAND_ID_CONFLICT'})
})
for(const version of ['20','21','24','25','26']) test('new simplified run is bound to same task, stays paused until explicitly resumed, invalid cross-task reset rolls back v'+version,async t=>{
 const f=await fixture(t);await f.task('one')
 const next={taskId:'one',runId:'new-one',workflowId:'new-workflow',workflowDigest:'b'.repeat(64),requirementRef:ref('one'),nodes:[{nodeId:'prepare-generation',nodeVersion:'1',executor:'code',inputRef:ref('one'),inputDigest:h},{nodeId:'inspect-and-propose',nodeVersion:'20',executor:'agent',inputRef:null,inputDigest:null},{nodeId:'apply-changes',nodeVersion:'8',executor:'agent',inputRef:null,inputDigest:null}]}
 await f.cmd('workflow.register',{workflowId:next.workflowId,digest:next.workflowDigest,definitionVersion:version,config:{taskId:'one',runId:'new-one'}})
 await assert.rejects(f.cmd('task.execution.reset',{...f.args('one'),newRun:{...next,requirementRef:ref('another')}},'invalid'),{code:'TASK_RESET_NEW_RUN_INVALID'})
 assert.equal((await f.store.query({kind:'run',runId:'old-one'})).run.recoveryReason,'user_pause')
 await f.cmd('task.execution.reset',{...f.args('one'),newRun:next},'new-reset')
 const state=await f.store.query({kind:'run',runId:'new-one'}),plan=await f.store.query({kind:'task.plan',taskId:'one'})
 assert.equal(state.run.pauseRequested,true);assert.equal(state.run.recoveryReason,'user_pause')
 assert.equal(plan.task.controlState,'paused');assert.equal(plan.stages[0].runId,'new-one');assert.equal(plan.stages[0].gate,'none')
 assert.deepEqual((await f.store.query({kind:'run.list',taskId:'one'})).map(r=>r.runId),['new-one'])
 assert.equal(state.nodes.some(n=>n.nodeId==='validate-proposal'),false)
})

test('controller reset admission validates before freezing and never refreezes a receipt replay',async t=>{
 const f=await fixture(t);await f.task('one')
 const snapshots=[],controller=createExecutionController({store:f.store,artifacts:{},sessions:{async close(){}},workflows:[],configuration:{async snapshot(args){snapshots.push(args)}}})
 const next={taskId:'one',runId:'new-one',workflowId:'new-workflow',workflowDigest:'b'.repeat(64),requirementRef:ref('one'),nodes:[{nodeId:'prepare-generation',nodeVersion:'1',executor:'code',inputRef:ref('one'),inputDigest:h}]}
 await f.cmd('workflow.register',{workflowId:next.workflowId,digest:next.workflowDigest,definitionVersion:'26',config:{taskId:'one',runId:'new-one'}})
 const args={...f.args('one'),newRun:next,requestDigest:h}
 await assert.rejects(controller.resetTaskExecution({commandId:'invalid-reset',args:{...args,newRun:{...next,requirementRef:ref('another')}}}),{code:'TASK_RESET_NEW_RUN_INVALID'})
 assert.deepEqual(snapshots,[])
 const result=await controller.resetTaskExecution({commandId:'accepted-reset',args})
 assert.deepEqual(snapshots,[{runId:'new-one',workflowId:'new-workflow'}])
 assert.deepEqual(await controller.resetTaskExecution({commandId:'accepted-reset',args}),result)
 await assert.rejects(controller.resetTaskExecution({commandId:'accepted-reset',args:{...args,requestDigest:'c'.repeat(64)}}),{code:'COMMAND_ID_CONFLICT'})
 assert.equal(snapshots.length,1)
 await controller.close()
})
