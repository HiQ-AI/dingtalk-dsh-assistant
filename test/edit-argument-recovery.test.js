import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController,defineExecutionWorkflow,plannedStageRunId} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
for(const exact of [true,false])test(`effect-free rejected edit resumes original session only with exact Host proof: ${exact}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'edit-recovery-')),store=await openExecutionStore({dbPath:join(root,'control.sqlite'),instanceId:'edit-recovery',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
 let prefix=0,finish=0;const visits=[],schema={type:'object'}
 const workflow={id:'task-engineering-test',version:'21',nodes:[
  {id:'prepare',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:({requirement})=>requirement,execute:async()=>{prefix++;return {plan:{ref:'plan',digest:'a'.repeat(64)}}}},
  {id:'apply-changes',version:'8',executor:'agent',allowedEffects:['read','workspace.edit'],allowedTools:['engineering_repo_inspect','engineering_apply_edits'],provider:'test',model:'test',prompt:'apply current plan',inputSchema:schema,outputSchema:schema,mapInput:({previousOutput})=>previousOutput,
   execute:async({edits})=>{if(!edits.noChange)throw Object.assign(new Error('ENGINEERING_NO_EFFECT_MODIFICATION'),{code:'ENGINEERING_NO_EFFECT_MODIFICATION'});return {status:'succeeded',changeDisposition:'no-change',proof:'test proof'} }},
  {id:'finish',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:({previousOutput})=>previousOutput,execute:async({input})=>{finish++;return input}}
 ]}
 const sessions={async close(){},async cancel(){},async run({binding,input,recoveryContext,onSessionBound,onResult,applyEdits,validateOutput}){
  await onSessionBound();visits.push({binding,input,recoveryContext})
  if(visits.length===1)return {status:'blocked',reason:'execution_tool_failed',failure:{code:'execution_tool_failed',phase:'execution',tool:'engineering_apply_edits',message:exact?'ENGINEERING_NO_EFFECT_MODIFICATION':'UNKNOWN_STORAGE_ERROR'}}
  assert.match(recoveryContext.strategy,/Omit identical replacements/)
  const feedback=await applyEdits({changes:[],replacements:[{path:'x',from:'same',to:'same'}]},new AbortController().signal)
  assert.equal(feedback.received,false);assert.equal(feedback.error.code,'ENGINEERING_NO_EFFECT_MODIFICATION')
  const proof=await applyEdits({changes:[],replacements:[],noChange:{reason:'test',reviewedPaths:['x']}},new AbortController().signal);assert.equal(proof.changeDisposition,'no-change')
  const output={status:'succeeded',summary:'test evidence',planRef:input.plan.ref,effectRefs:[]};await validateOutput(output);await onResult(output);return {status:'submitted'}
 }}
 const controller=createExecutionController({store,artifacts,workflows:[workflow],sessions,delivery:{},readTools:['engineering_repo_inspect']})
 t.after(async()=>{await controller.close();await store.close()})
 const rid=plannedStageRunId('task',1,'stage',1),definition=defineExecutionWorkflow(workflow)
 await store.command({id:'register',kind:'workflow.register',args:{workflowId:workflow.id,digest:definition.digest,definitionVersion:'21',config:{kind:'engineering',taskId:'task',runId:rid}}})
 await controller.createTaskPlan({commandId:'plan',taskId:'task',stages:[{stageId:'stage',workflowId:workflow.id,input:{request:'test'}}]});await controller.advanceTaskPlan('task')
 const before=await controller.whenIdle(rid),recovery=await controller.inspectNodeRecovery(rid)
 assert.equal(recovery.repairable,exact)
 if(!exact){assert.equal(recovery.reason,'edit-rejection-proof-missing');assert.equal(visits.length,1);return}
 await controller.recover({commandId:'recover',runId:rid});const after=await controller.whenIdle(rid)
 assert.equal(after.run.status,'succeeded');assert.equal(prefix,1);assert.equal(finish,1);assert.equal(visits.length,2)
 for(const key of ['nodeRunId','sessionId','inputDigest','generation'])assert.equal(visits[0].binding[key],visits[1].binding[key])
 assert.equal(visits[1].binding.leaseEpoch,visits[0].binding.leaseEpoch+1);assert.equal(before.nodes[0].outputRef,after.nodes[0].outputRef);assert.deepEqual(await store.query({kind:'effect.list',runId:rid}),[])
})
