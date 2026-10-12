import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import {approvedPurgeTaskIds} from '../packages/dingtalk-dsh-assistant/execution-task-purge.js'
import {preparePurgedEngineeringRun} from '../packages/dingtalk-dsh-assistant/task-purge-start.js'
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'purged-run-start-'))
 const store=await openExecutionStore({dbPath:join(root,'control.sqlite'),instanceId:'test',initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
 let executions=0,preparations=0,sequence=0
 const node={id:'prepare',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>{executions++;throw Error('MUST_NOT_EXECUTE_UNDER_MAINTENANCE')}}
 const controller=createExecutionController({store,artifacts,workflows:[{id:'old',version:'1',nodes:[node]},{id:'fresh-engineering',version:'22',nodes:[node]}]})
 t.after(async()=>{await controller.close();await store.close();await rm(root,{recursive:true,force:true})})
 const cmd=(kind,args,id='command-'+(++sequence))=>store.command({id,kind,args})
 await cmd('runtime.maintenance.change',{active:true,expectedRevision:0,maintenanceId:'maintenance',actorId:'owner',reason:'isolated start test'})
 for(const taskId of approvedPurgeTaskIds){await controller.createTaskPlan({commandId:'old-plan-'+taskId,taskId,stages:[{stageId:'old-stage',workflowId:'old',input:{request:'original requirement'}}]});await cmd('task.owner.init',{taskId,sessionId:'owner-'+taskId,criteria:['original requirement'],sourceKey:'original'})}
 await cmd('task.execution.purge',{tasks:approvedPurgeTaskIds.map(taskId=>({taskId,expectedControlRevision:1})),actorId:'owner',reason:'authorized purge'})
 const request={taskId:approvedPurgeTaskIds[0],requestId:'fresh-v22',expectedRequirementRevision:1,expectedControlRevision:2,checkOnly:false}
 const dependencies={actorId:'owner',store,controller,artifacts,origin:{},stageContracts:{async prepare({requirement}){preparations++;return {workflowId:'fresh-engineering',input:requirement}}}}
 return {store,controller,cmd,request,dependencies,get executions(){return executions},get preparations(){return preparations}}
}

test('cleared original task prepares one paused run and repeats reuse it without releasing other tasks',async t=>{
 const f=await fixture(t)
 for(const taskId of approvedPurgeTaskIds)await f.cmd('task.execution.purge.files-complete',{taskId})
 assert.equal((await f.store.query({kind:'run.list',taskId:f.request.taskId})).length,0)
 const result=await preparePurgedEngineeringRun({...f.dependencies,request:f.request})
 assert.equal(result.workflowVersion,'22');assert.equal(result.controlState,'paused');assert.equal(result.globalDispatchReleased,false)
 const retry=await preparePurgedEngineeringRun({...f.dependencies,request:f.request})
 assert.equal(retry.runId,result.runId);assert.equal(retry.replayed,true);assert.equal(f.preparations,1)
 assert.equal((await f.store.query({kind:'run.list',taskId:f.request.taskId})).length,1)
 for(const taskId of approvedPurgeTaskIds.slice(1)){const plan=await f.controller.taskPlan(taskId);assert.equal(plan.task.controlState,'paused');assert.equal(plan.task.controlRevision,2);assert.equal(plan.stages.length,0)}
 const state=await f.controller.state(result.runId);assert.equal(state.run.status,'waiting');assert.equal(state.nodes[0].status,'ready');assert.equal(f.executions,0)
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).active,true)
})

test('pending physical cleanup or an unauthorized task never prepares fresh files or a run',async t=>{
 const f=await fixture(t)
 await assert.rejects(preparePurgedEngineeringRun({...f.dependencies,request:f.request}),{code:'TASK_PURGE_CLEANUP_PENDING'})
 await assert.rejects(preparePurgedEngineeringRun({...f.dependencies,request:{...f.request,taskId:'task-outside-authorized-four'}}),{code:'TASK_PURGE_START_SCOPE_INVALID'})
 assert.equal(f.preparations,0);assert.equal(f.executions,0)
})

for (const selectedTaskId of approvedPurgeTaskIds.slice(1)) test('selected authorized task '+selectedTaskId+' alone prepares a paused fresh run',async t=>{
 const f=await fixture(t)
 for(const taskId of approvedPurgeTaskIds)await f.cmd('task.execution.purge.files-complete',{taskId})
 const request={...f.request,taskId:selectedTaskId}
 const result=await preparePurgedEngineeringRun({...f.dependencies,request})
 const retry=await preparePurgedEngineeringRun({...f.dependencies,request})
 assert.equal(result.taskId,selectedTaskId);assert.equal(result.controlState,'paused');assert.equal(retry.runId,result.runId);assert.equal(f.preparations,1);assert.equal(f.executions,0)
 for(const taskId of approvedPurgeTaskIds.filter(id=>id!==selectedTaskId)){
  const plan=await f.controller.taskPlan(taskId)
  assert.equal(plan.task.controlState,'paused');assert.equal(plan.task.controlRevision,2);assert.equal(plan.stages.length,0)
  assert.equal((await f.store.query({kind:'run.list',taskId})).length,0)
 }
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).active,true)
})
