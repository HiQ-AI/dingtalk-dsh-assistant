import {createTaskOwnerController} from '../../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import {createTaskWorkflowContracts} from '../../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
export function requireControl(t,f){if(typeof f.controller.controlNode==='function')return true;t.skip('BLOCKED / not run: public controller.controlNode is not installed in this isolated test snapshot');return false}
export async function nodeBinding(f,nodeId='verify'){
 const state=await f.controller.state(f.runId),plan=await f.controller.taskPlan(f.taskId),node=state.nodes.find(n=>n.nodeId===nodeId)
 if(!node)throw Error('Fixture node unavailable: '+nodeId)
 return {taskId:f.taskId,runId:f.runId,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,expectedRequirementRevision:plan.task.requirementRevision,expectedControlRevision:plan.task.controlRevision,source:'operator',actorId:'fixture-operator',reason:'Original task controls its actual isolated work'}
}
export async function control(f,action,{commandId,nodeId,reason,outputRef,evidenceRefs=[],...overrides}={}){
 if(typeof f.controller.controlNode!=='function')throw Object.assign(Error('Public controller.controlNode unavailable'),{code:'CONTROL_ADAPTER_BLOCKED'})
 return f.controller.controlNode({...await nodeBinding(f,nodeId),action,commandId,outputRef,evidenceRefs,...(reason?{reason}:{}),...overrides})
}
export async function saveActual(f,value){const state=await f.controller.state(f.runId);return f.artifacts.put(value,{reference:state.run.requirementRef})}
async function controlRun(f,action,commandId){
 if(typeof f.controller.controlRun!=='function')return action==='stop'?f.controller.pause({commandId,runId:f.runId,reason:'Original task stops this step'}):f.controller.resume({commandId,runId:f.runId})
 const plan=await f.controller.taskPlan(f.taskId);return f.controller.controlRun({commandId,taskId:f.taskId,runId:f.runId,action,source:'operator',actorId:'fixture-operator',reason:'Original task '+action+' current execution',expectedRequirementRevision:plan.task.requirementRevision,expectedControlRevision:plan.task.controlRevision})
}
export const stop=(f,commandId='session-stop')=>controlRun(f,'stop',commandId)
export const continueRun=(f,commandId='session-continue')=>controlRun(f,'continue',commandId)
export async function bindOriginalRequirement(f,requirement){
 const owner=createTaskOwnerController({ctx:{},store:f.store,artifacts:f.artifacts,controller:f.controller,modelConfig:()=>({}),advanceTask:async()=>{},authorizeStages:async()=>false,sessionRunner:{async run(){throw Error('No model run is needed merely to bind the real fixture requirement')},async close(){}}})
 const initial=await owner.ensure({taskId:f.taskId,sourceKey:'fixture-original',criteria:requirement.acceptanceCriteria,origin:{}})
 const goal=await f.artifacts.put(requirement,{taskId:f.taskId}),plan=await f.controller.taskPlan(f.taskId)
 await f.store.command({id:'bind-original',kind:'task.requirement.bind-legacy',args:{taskId:f.taskId,expectedRequirementRevision:plan.task.requirementRevision,requirementRef:goal.ref,sessionId:initial.sessionId,criteria:requirement.acceptanceCriteria,sourceKey:'fixture-original',eventKey:'bind-original'}})
 await owner.close();return goal
}
export async function applyRequirementDifference(f,{requirement,stages,input,stageId,predecessorOutputRef}){
 const prior=await f.controller.taskPlan(f.taskId),goal=await f.artifacts.put(requirement,{taskId:f.taskId})
 await f.store.command({id:'new-requirement',kind:'task.requirement.update',args:{taskId:f.taskId,expectedRequirementRevision:prior.task.requirementRevision,requirementRef:goal.ref,eventKey:'new-requirement'}})
 let plan=await f.controller.taskPlan(f.taskId)
 await f.controller.reviseTaskPlan({commandId:'only-difference',taskId:f.taskId,expectedPlanRevision:prior.task.planRevision,expectedControlRevision:plan.task.controlRevision,requirementRevision:plan.task.requirementRevision,affectedFrom:1,stages})
 plan=await f.controller.taskPlan(f.taskId)
 await f.controller.confirmTaskStage({commandId:'confirm-difference',taskId:f.taskId,planRevision:plan.task.planRevision,stageId,outputRef:predecessorOutputRef})
 await f.controller.bindTaskStageInput({commandId:'bind-difference',taskId:f.taskId,planRevision:plan.task.planRevision,stageId,predecessorOutputRef,input})
 return f.controller.advanceTaskPlan(f.taskId)
}
export async function attemptOriginalCompletion(f,requirement){
 const helpers=createTaskWorkflowContracts({controller:f.controller,store:f.store,artifacts:f.artifacts})
 const owner=createTaskOwnerController({ctx:{},store:f.store,artifacts:f.artifacts,controller:f.controller,modelConfig:()=>({}),advanceTask:async()=>{},authorizeStages:async()=>false,authorizeCompletion:async({taskId,decision})=>helpers.authorizeCompletion({taskId,decision,requirement,plan:await f.controller.taskPlan(taskId)}),readDeliveryManifest:helpers.readDeliveryManifest,readStageArtifacts:helpers.readStageArtifacts,
 sessionRunner:{async close(){},async run({input,onSessionBound,onCandidate}){await onSessionBound();const ref=input.stages[0].outputRef;const decision={action:'complete',summary:'Attempt completion against the actual original goal',evidenceRefs:[ref],assessments:input.acceptanceItems.map(item=>({itemId:item.itemId,status:'satisfied',evidenceRefs:[ref]}))};await onCandidate(decision);return {status:'submitted',decision}}}})
 try{await owner.ensure({taskId:f.taskId,sourceKey:'fixture-original',criteria:requirement.acceptanceCriteria,origin:{}});return await owner.drive(f.taskId)}finally{await owner.close()}
}
