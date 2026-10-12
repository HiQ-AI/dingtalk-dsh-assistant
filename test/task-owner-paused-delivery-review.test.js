import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import {createTaskOwnerController,ownerWorkflowObservationType} from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'

import {taskOwnerQueryControlAllowed} from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'

async function fixture(t,{action='complete',unread=false,changeAfterCandidate=false,candidateAcceptance=false,mutateCandidate=false,queryControl=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'paused-owner-review-')),dbPath=join(dir,'control.sqlite')
 let store=await openExecutionStore({dbPath,instanceId:'review',initialize:true}),owner
 t.after(async()=>{await owner?.close();await controller?.close();await store.close()})
 const taskRoot=join(dir,'tasks'),directories={logicalTaskId:'task',...Object.fromEntries(['work','tmp','outputs'].map(area=>[area,join(taskRoot,'task',area)]))}
 for(const area of ['work','tmp','outputs'])await mkdir(directories[area],{recursive:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true,taskWorkspaceRoot:taskRoot,getTaskDirectories:async()=>directories})
 let executions=0,advances=0,turns=0,verifications=0
 const workflow={id:'development',version:'1',nodes:[{id:'develop',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:()=>({}),execute:async()=>{executions++;return {}}}]}
 const controller=createExecutionController({store,artifacts,workflows:[workflow]})
 const requirement={request:'Review already-delivered Draft; keep engineering paused',acceptanceCriteria:['Correct change and tests','Draft PR delivered']}
 await controller.createTaskPlan({commandId:'create',taskId:'task',stages:[{stageId:'development',workflowId:'development',input:requirement}]})
 const createOwner=()=>createTaskOwnerController({ctx:{},store,artifacts,controller,modelConfig:()=>({}),authorizeStages:async()=>true,advanceTask:async()=>{advances++},
  authorizeCompletion:async()=>{throw Error('ordinary completion must not be used')},
  verifyDeliveryReview:async({taskId,decision,manifest,candidate})=>{verifications++;const plan=await controller.taskPlan(taskId);return candidate?{kind:'task-candidate-acceptance',version:1,taskId,requirementRevision:plan.task.requirementRevision,planRevision:plan.task.planRevision,accepted:true,businessCompleted:false,source:'original-owner-delivery-review',reviewRef:decision.evidenceRefs[0],scenarioIds:decision.candidateAcceptance.scenarioIds,evidenceRefs:decision.candidateAcceptance.evidenceRefs,decision}:manifest?{kind:'task-delivery-manifest',version:1,taskId,requirementRevision:plan.task.requirementRevision,planRevision:plan.task.planRevision,complete:true,businessValidation:{status:'accepted',source:'original-owner'},decision}:true},
  sessionRunner:{async close(){},async run({binding,input,readArtifact,onSessionBound,onCandidate}){
   turns++;assert.equal(binding.sessionId,originalSession);assert.equal(input.task.controlState,'paused');assert.ok(input.deliveryReview);assert.equal(input.planReview,undefined)
   await onSessionBound();if(queryControl){
    const nativeOwner=await store.query({kind:'task.owner',taskId:'task'}),nativePlan=await controller.taskPlan('task')
    assert.equal(taskOwnerQueryControlAllowed(nativeOwner,nativePlan,binding),true)
    assert.equal(taskOwnerQueryControlAllowed({...nativeOwner,deliveryReview:null},nativePlan,binding),false)
    assert.equal(taskOwnerQueryControlAllowed(nativeOwner,nativePlan,{...binding,taskId:'other'}),false)
    assert.equal(taskOwnerQueryControlAllowed(nativeOwner,nativePlan,{...binding,requirementRevision:binding.requirementRevision+1}),false)
    assert.equal(taskOwnerQueryControlAllowed(nativeOwner,{...nativePlan,task:{...nativePlan.task,controlRevision:nativePlan.task.controlRevision+1}},binding),false)
   };if(!unread)await readArtifact(input.deliveryReview.payloadRef)
   const evidenceRefs=[input.deliveryReview.payloadRef]
   const decision={action,summary:'Assessed delivered facts',evidenceRefs,...(action==='complete'?{assessments:input.acceptanceItems.map(item=>({itemId:item.itemId,status:'satisfied',evidenceRefs}))}:action==='advance'?{}:{condition:{kind:'capability',missing:'real browser evidence',responsibleParty:'execution host',resumeWhen:'browser capability available',evidenceRefs}})}
   if(candidateAcceptance)decision.candidateAcceptance={scenarioIds:['seven-ui'],evidenceRefs}
   await onCandidate(decision)
   if(mutateCandidate)decision.candidateAcceptance.scenarioIds.push('unreviewed')
   if(changeAfterCandidate)await store.command({id:'later-input',kind:'task.owner.event',args:{taskId:'task',eventKey:'later-input',eventType:'intent.received'}})
   return {status:'submitted',decision}
  }}})
 owner=createOwner();const initialized=await owner.ensure({taskId:'task',sourceKey:'source',criteria:requirement.acceptanceCriteria,origin:{}}),originalSession=initialized.sessionId
 await store.command({id:'requirement',kind:'task.requirement.bind-legacy',args:{taskId:'task',expectedRequirementRevision:1,requirementRef:(await artifacts.put(requirement,{taskId:'task'})).ref,sessionId:originalSession,criteria:requirement.acceptanceCriteria,sourceKey:'source',eventKey:'bind'}})
 await store.command({id:'initial-claim',kind:'task.owner.claim',args:{taskId:'task',turnId:'original-turn',expectedLeaseEpoch:0}})
 await store.command({id:'initial-bound',kind:'task.owner.sessionBound',args:{taskId:'task',turnId:'original-turn',leaseEpoch:1,sessionId:originalSession}})
 await store.command({id:'initial-candidate',kind:'task.owner.candidate',args:{taskId:'task',turnId:'original-turn',leaseEpoch:1,decision:{action:'wait',summary:'Original Owner already assessed',evidenceRefs:[],condition:{kind:'capability',missing:'external facts',responsibleParty:'execution host',resumeWhen:'facts available',evidenceRefs:[]}}}})
 await store.command({id:'initial-accept',kind:'task.owner.accept',args:{taskId:'task',turnId:'original-turn',leaseEpoch:1}})
 await store.command({id:'initial-applied',kind:'task.owner.applied',args:{taskId:'task',turnId:'original-turn',leaseEpoch:1}})
 await store.command({id:'pause',kind:'task.control.pause',args:{taskId:'task',expectedControlRevision:1}})
 const factsRef=(await artifacts.put({kind:'verified-delivered-engineering-facts',taskId:'task',pr:{isDraft:true}},{taskId:'task'})).ref
 const review=()=>store.command({id:'owner-delivery-review:requested',kind:'task.owner.delivery-review',args:{taskId:'task',eventKey:'requested',payloadRef:factsRef,expectedRequirementRevision:1,expectedControlRevision:2,actorId:'authorized-web-actor',reason:'Assess delivered facts only'}})
 return {review,owner,controller,store,query:q=>store.query(q),originalSession,factsRef,counts:()=>({executions,advances,turns,verifications}),restart:async()=>{await owner.close();await store.close();store=await openExecutionStore({dbPath,instanceId:'review'});owner=createOwner();return store.query({kind:'task.owner',taskId:'task'})}}
}
test('plain pause never dispatches; reserved review cannot be forged with a generic event',async t=>{
 const f=await fixture(t);assert.equal(await f.owner.drive('task'),null);assert.equal((await f.store.query({kind:'task.owners.pending'})).length,0)
 await assert.rejects(f.store.command({id:'forged',kind:'task.owner.event',args:{taskId:'task',eventKey:'forged',eventType:'delivery.review.requested',payloadRef:f.factsRef}}),{code:'TASK_OWNER_DELIVERY_REVIEW_EVENT_RESERVED'})
 assert.deepEqual(f.counts(),{executions:0,advances:0,turns:0,verifications:0})
})
for(const action of ['complete','wait','block'])test(`authorized paused original Owner ${action} preserves engineering and survives restart`,async t=>{
 const f=await fixture(t,{action});const before=await f.controller.taskPlan('task');await f.review()
 assert.equal((await f.store.query({kind:'task.owners.pending'})).length,1)
 assert.equal((await f.owner.drive('task')).status,'accepted');assert.deepEqual(await f.owner.applyPending(),[])
 const after=await f.controller.taskPlan('task');assert.deepEqual(after,before)
 const read=await f.restart();assert.equal(read.sessionId,f.originalSession);assert.equal(read.decision.action,action);assert.equal(read.applicationStatus,'applied');assert.ok(read.deliveryReview)
 assert.equal(f.counts().executions,0);assert.equal(f.counts().advances,0);assert.equal(f.counts().turns,1)
})
test('paused review cannot advance engineering',async t=>{const f=await fixture(t,{action:'advance'});await f.review();await assert.rejects(f.owner.drive('task'),{code:'TASK_OWNER_DELIVERY_REVIEW_READ_ONLY'});assert.equal(f.counts().advances,0)})
test('complete requires Owner actually reading reviewed facts',async t=>{const f=await fixture(t,{unread:true});await f.review();await assert.rejects(f.owner.drive('task'),{code:'TASK_OWNER_COMPLETION_UNVERIFIED'});assert.equal(f.counts().verifications,0)})
test('changed input invalidates review and accepted candidate',async t=>{const f=await fixture(t,{changeAfterCandidate:true});await f.review();await assert.rejects(f.owner.drive('task'),/STALE/);assert.equal((await f.store.query({kind:'task.owner',taskId:'task'})).deliveryReview,null);assert.equal(f.counts().advances,0)})

test('waiting semantics preserve approval/input events and actual failures; repeated observation never loops',async()=>{
 const stage={stageId:'s',status:'running',runId:'run',workflowId:'engineering',evidenceRefs:[]},events=new Map()
 for(const [reason,kind,expected] of [['PLUGIN_APPROVAL_PENDING','recovery','workflow.waiting'],['AGENT_WORK_NEEDS_INPUT','recovery','workflow.waiting'],['authorization','approval','workflow.waiting'],['dependency-running','input','workflow.waiting'],['CASE_PARAMETERS_INVALID','recovery','workflow.failed']]){
  const node={status:'waiting',waitReason:{kind,reference:reason},nodeRunId:'n',nodeId:'n',generation:1,leaseEpoch:1,drained:true,evidenceRefs:[]}
  assert.equal(ownerWorkflowObservationType(stage,[node]),expected)
  const owner=createTaskOwnerController({ctx:{},artifacts:{put:async payload=>({ref:JSON.stringify(payload)})},store:{query:async()=>({eventWatermark:1}),command:async cmd=>{events.set(cmd.args.eventKey,cmd.args.eventType);return {result:{status:'applied'}}}},controller:{taskPlan:async()=>({task:{planRevision:1},stages:[stage]}),state:async()=>({nodes:[node]})},modelConfig:()=>({}),advanceTask:async()=>{},authorizeStages:async()=>false,sessionRunner:{close:async()=>{}}})
  await owner.observe('task');const size=events.size;await owner.observe('task');assert.equal(events.size,size);assert.ok([...events.values()].includes(expected));await owner.close()
 }
 assert.equal(ownerWorkflowObservationType(stage,[{status:'failed',waitReason:{kind:'recovery',reference:'PLUGIN_APPROVAL_PENDING'}}]),'workflow.failed')
 assert.equal(ownerWorkflowObservationType({...stage,status:'waiting_confirmation'},[]),'workflow.confirmation.required')
})


test('explicit candidate acceptance persists without completing task, executing or changing requirement',async t=>{
 const f=await fixture(t,{action:'wait',candidateAcceptance:true});const before=await f.controller.taskPlan('task');await f.review()
 const accepted=await f.owner.drive('task');assert.ok(accepted.candidateAcceptanceRef);assert.equal(accepted.deliveryManifestRef,undefined)
 assert.equal(accepted.decision.action,'wait');assert.deepEqual(await f.owner.applyPending(),[])
 assert.deepEqual(await f.controller.taskPlan('task'),before);assert.equal((await f.store.query({kind:'task.owner.delivery-manifest',taskId:'task'})),null)
 const binding=await f.store.query({kind:'task.owner.candidate-acceptance',taskId:'task'});assert.equal(binding.ref,accepted.candidateAcceptanceRef)
 await f.restart();assert.deepEqual(await f.query({kind:'task.owner.candidate-acceptance',taskId:'task'}),binding)
 assert.equal(f.counts().executions,0);assert.equal(f.counts().advances,0)
})
test('candidate acceptance needs actual fact read and immutable submitted decision',async t=>{
 const unread=await fixture(t,{action:'wait',candidateAcceptance:true,unread:true});await unread.review()
 await assert.rejects(unread.owner.drive('task'),{code:'TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED'})
 const mutated=await fixture(t,{action:'wait',candidateAcceptance:true,mutateCandidate:true});await mutated.review()
 await assert.rejects(mutated.owner.drive('task'),{code:'TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED'})
 assert.equal(await mutated.store.query({kind:'task.owner.candidate-acceptance',taskId:'task'}),null)
})
test('plain wait cannot attach a forged candidate acceptance reference',async t=>{
 const f=await fixture(t,{action:'wait'});await f.review();await f.owner.drive('task')
 assert.equal(await f.store.query({kind:'task.owner.candidate-acceptance',taskId:'task'}),null)
})

test('candidate acceptance does not survive a newer requirement fence and cannot accompany block',async t=>{
 const changed=await fixture(t,{action:'wait',candidateAcceptance:true,changeAfterCandidate:true});await changed.review()
 await assert.rejects(changed.owner.drive('task'),/STALE/);assert.equal(await changed.query({kind:'task.owner.candidate-acceptance',taskId:'task'}),null)
 const blocked=await fixture(t,{action:'block',candidateAcceptance:true});await blocked.review()
 await assert.rejects(blocked.owner.drive('task'),{code:'TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED'})
})

 test('native paused delivery review permits current read-only query control without opening ordinary paused owners',async t=>{const f=await fixture(t,{queryControl:true});await f.review();const accepted=await f.owner.drive('task');assert.equal(accepted.decision.action,'complete');assert.equal(f.counts().executions,0);assert.equal(f.counts().advances,0)})
