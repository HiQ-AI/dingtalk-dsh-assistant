import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRetiredWorkflowsDrained,readOnlyWorkflowOwnerContract,retiredWorkflowIds } from '../packages/dingtalk-dsh-assistant/task-readonly-workflows.js'

test('旧可执行流程全部退出；历史材料产物读取合同仍保留',async()=>{
 const readonly=await import('../packages/dingtalk-dsh-assistant/task-readonly-workflows.js')
 const general=await import('../packages/dingtalk-dsh-assistant/task-general-workflow.js')
 const task=await import('../packages/dingtalk-dsh-assistant/task-workflow.js')
 for(const key of ['createReadOnlyTaskWorkflows','createLegacyReadOnlyTaskWorkflows'])assert.equal(readonly[key],undefined)
 for(const key of ['createGeneralTaskWorkflow','createGeneralIntakeWorkflow','createHistoricalGeneralCapabilityStepWorkflow','createLegacyGeneralCapabilityStepWorkflow'])assert.equal(general[key],undefined)
 for(const key of ['createAnalysisTaskWorkflow','createLegacyAnalysisTaskWorkflow'])assert.equal(task[key],undefined)
 assert.equal(typeof task.createEngineeringTaskWorkflow,'function')
 assert.equal(typeof general.createGeneralMarkdownWriteCapability,'function')
 const context={state:{run:{requirementRef:'old'}},artifacts:{read:async()=>({materials:[{id:'source'}]})},output:{summary:'无法确认创建人',evidenceIds:['source'],limitations:['审计材料不足']}}
 assert.equal(await readOnlyWorkflowOwnerContract.validateCompletion(context),true)
 assert.equal(await readOnlyWorkflowOwnerContract.validateCompletion({...context,output:{...context.output,evidenceIds:['invented']}}),false)
})
test('存量已终态定义不影响启动，但任何旧活动引用阻止切换',()=>{
 for(const workflowId of [...retiredWorkflowIds,'task-investigation','task-general-capability']){
  const record={workflowId,definitionVersion:'1',digest:'d'}
  assert.doesNotThrow(()=>assertRetiredWorkflowsDrained({records:[record],activeDefinitions:new Set()}))
  assert.throws(()=>assertRetiredWorkflowsDrained({records:[record],activeDefinitions:new Set([`${workflowId}:d`])}),{code:'WORKFLOW_CUTOVER_ACTIVE_REFERENCES'})
 }
 assert.throws(()=>assertRetiredWorkflowsDrained({records:[],activeDefinitions:new Set(),pendingStages:[{workflowId:'task-general-intake',workflowDigest:null}]}),{code:'WORKFLOW_CUTOVER_ACTIVE_REFERENCES'})
})
test('新的共享调查和授权写阶段可以原身份恢复',()=>{
 const records=[{workflowId:'task-investigation',definitionVersion:'3',digest:'i'},{workflowId:'task-general-capability',definitionVersion:'4',digest:'w'}]
 assert.doesNotThrow(()=>assertRetiredWorkflowsDrained({records,currentDefinitions:records.map(record=>({id:record.workflowId,version:record.definitionVersion})),activeDefinitions:new Set(['task-investigation:i','task-general-capability:w'])}))
})

test('调查v5切换拒绝v4活动引用，终态历史无需套用新完成合同',()=>{
 const records=[{workflowId:'task-investigation',definitionVersion:'4',digest:'old'}]
 const currentDefinitions=[{id:'task-investigation',version:'5'}]
 assert.throws(()=>assertRetiredWorkflowsDrained({records,currentDefinitions,activeDefinitions:new Set(['task-investigation:old'])}),{code:'WORKFLOW_CUTOVER_ACTIVE_REFERENCES'})
 assert.doesNotThrow(()=>assertRetiredWorkflowsDrained({records,currentDefinitions,activeDefinitions:new Set()}))
})

test('正式Host启动遇到旧待执行阶段时拒绝切换，保留原冻结计划且不执行节点',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {openExecutionStore}=await import('../packages/dingtalk-dsh-assistant/execution-store.js')
 const {openExecutionArtifacts}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
 const {createExecutionController,defineExecutionWorkflow}=await import('../packages/dingtalk-dsh-assistant/execution-controller.js')
 const {openWorkflowService}=await import('../packages/dingtalk-dsh-assistant/workflow-service.js')
 const root=await mkdtemp(join(tmpdir(),'retired-workflow-gate-')),dbPath=join(root,'control.db'),artifactDirectory=join(root,'artifacts')
 t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await openExecutionStore({dbPath,instanceId:'retired-test',initialize:true}),artifacts=await openExecutionArtifacts({directory:artifactDirectory,initialize:true})
 const frozen={id:'task-analysis',version:'1',nodes:[{id:'old',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>{throw Error('OLD_EXECUTION_MUST_NOT_RUN')}}]}
 const controller=createExecutionController({store,artifacts,workflows:[frozen]})
 const definition=defineExecutionWorkflow(frozen)
 await store.command({id:'definition',kind:'workflow.register',args:{workflowId:frozen.id,definitionVersion:'1',config:{provider:'test',model:'test'},digest:definition.digest}})
 await controller.createTaskPlan({commandId:'plan',taskId:'old-task',stages:[{stageId:'first',workflowId:frozen.id,input:{}}]})
 const before=await store.query({kind:'task.plan',taskId:'old-task'})
 await controller.close();await store.close()
 await assert.rejects(openWorkflowService({ctx:{},config:{groupIds:['g'],ownerActorId:'owner',dbPath,artifactDirectory,instanceId:'retired-test'},legacy:{getAgentConfig:()=>({provider:'test',model:'test'})},judge:async()=>{throw Error('MODEL_MUST_NOT_RUN')},taskOwnerSessions:{async close(){}}}),{code:'WORKFLOW_CUTOVER_ACTIVE_REFERENCES'})
 const readback=await openExecutionStore({dbPath,instanceId:'retired-test'})
 try{assert.deepEqual(await readback.query({kind:'task.plan',taskId:'old-task'}),before);assert.equal((await readback.query({kind:'run.list',limit:200})).length,0)}finally{await readback.close()}
})
