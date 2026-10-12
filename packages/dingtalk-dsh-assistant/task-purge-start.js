import {executionDigest,executionError} from './execution-artifacts.js'
import {approvedPurgeTaskIds} from './execution-task-purge.js'
const fail=code=>{throw executionError(code)}
// A maintenance handoff to the existing prepare/plan machinery; it never releases global dispatch.
export async function preparePurgedEngineeringRun({request,actorId,store,controller,artifacts,stageContracts,origin,refreshAcceptance}){
 const {taskId,requestId,expectedRequirementRevision,expectedControlRevision}=request
 if(!approvedPurgeTaskIds.includes(taskId))fail('TASK_PURGE_START_SCOPE_INVALID')
 const maintenance=await store.query({kind:'runtime.maintenance'})
 if(!maintenance.active||!maintenance.drained)fail('TASK_PURGE_NOT_DRAINED')
 for(const id of approvedPurgeTaskIds)if(await store.query({kind:'task.execution.purge.cleanup',taskId:id}))fail('TASK_PURGE_CLEANUP_PENDING')
 const commandId='purge-start:'+executionDigest([actorId,taskId,requestId])
 const stageId='stage-v22-'+executionDigest(commandId).slice(0,12)
 let plan=await controller.taskPlan(taskId)
 if(!plan||plan.task.requirementRevision!==expectedRequirementRevision)fail('TASK_REQUIREMENT_STALE')
 const existing=plan.stages.find(stage=>stage.stageId===stageId)
 if(existing?.runId){
  if(!request.checkOnly)await refreshAcceptance?.({runId:existing.runId,requestId:commandId+':acceptance'})
  plan=await controller.taskPlan(taskId)
  const current=plan.stages.find(stage=>stage.stageId===stageId)
  return {taskId,runId:current.runId,workflowVersion:controller.workflowDefinition(current.workflowId,current.workflowDigest).version,requirementRevision:plan.task.requirementRevision,controlRevision:plan.task.controlRevision,controlState:plan.task.controlState,replayed:true}
 }
 const resumed=await store.query({kind:'receipt',commandId:commandId+':resume'})
 if(plan.task.planRevision!==0&&!existing||!resumed&&(plan.task.controlState!=='paused'||plan.task.controlRevision!==expectedControlRevision))fail('TASK_CONTROL_STALE')
 if(request.checkOnly)return {taskId,canPrepare:true,globalDispatchReleased:false}
 if(!existing){
  if((await store.query({kind:'run.list',taskId,includeArchived:true})).length)fail('TASK_PURGE_START_NOT_EMPTY')
  const requirement=await artifacts.read(plan.task.requirementRef)
  const stage={stageId,workflowId:'task-engineering',gate:'none',attempt:1}
  const prepared=await stageContracts.prepare({taskId,stage,stageIndex:0,plan:{...plan,stages:[stage]},requirement,origin,executionPlanRevision:1})
  if(controller.workflowDefinition(prepared.workflowId).version!=='22')fail('TASK_PURGE_START_WORKFLOW_INVALID')
  await controller.controlTask({commandId:commandId+':resume',taskId,intent:'resume',expectedControlRevision})
  plan=await controller.taskPlan(taskId)
  await controller.initializeTaskPlan({commandId:commandId+':plan',taskId,expectedRequirementRevision,expectedControlRevision:plan.task.controlRevision,stages:[{stageId,workflowId:prepared.workflowId,input:prepared.input,gate:'none'}]})
 }
 // Maintenance blocks node admission throughout this brief active-plan preparation.
 plan=await controller.advanceTaskPlan(taskId)
 const runId=plan.stages.find(stage=>stage.stageId===stageId)?.runId
 if(!runId)fail('TASK_PURGE_START_RUN_MISSING')
 if(plan.task.controlState==='active')await controller.controlTask({commandId:commandId+':pause',taskId,intent:'pause',expectedControlRevision:plan.task.controlRevision})
 plan=await controller.advanceTaskPlan(taskId)
 const state=await controller.state(runId)
 if(plan.task.controlState!=='paused'||state.nodes.some(node=>node.status==='running'||node.sessionBound))fail('TASK_PURGE_START_NOT_PAUSED')
 return {taskId,runId,workflowVersion:'22',requirementRevision:plan.task.requirementRevision,controlRevision:plan.task.controlRevision,controlState:plan.task.controlState,globalDispatchReleased:false}
}
