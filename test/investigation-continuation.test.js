import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { createAgentQueryTools } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'

async function fixture(t,{blocked=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'investigation-continuation-'))
 const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:randomUUID(),initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
 let service,controller,evidenceRef
 const bindings=[]
 t.after(async()=>{await service?.close();await controller?.close();await store.close();await rm(dir,{recursive:true,force:true})})
 const read=createAgentQueryTools({artifacts,resolveScope:async({input})=>input.scope,capabilities:[{id:'fixture-read',identity:'v1',effectClass:'read',description:'fixture',parameters:{type:'object'},authorize:async()=>true,execute:async()=>({value:'actual'}),verify:async()=>({passed:true,sourceRefs:['actual-source']})}]})[0]
 const sessions={async run({binding,input,onSessionBound,onResult,validateOutput,classifyOutputError}){
  bindings.push(binding);await onSessionBound()
  if(!evidenceRef)evidenceRef=(await read.execute({binding,input,args:{}})).evidenceRef
  const first=bindings.length===1
  const output={outcome:blocked?'blocked':first?'needs_input':'completed',summary:first?'请补充环境':'已查询',question:!blocked&&first?'哪个环境':'',limitations:blocked?['没有所需能力']:[],evidenceRefs:[evidenceRef]}
  await assert.rejects(validateOutput({...output,evidenceRefs:['actual-source']}),error=>classifyOutputError(error)==='correctable')
  await validateOutput(output)
  await onResult(output)
  return {status:'submitted'}
 },async close(){},async cancel(){},assertDrained(){return true}}
 controller=createExecutionController({store,artifacts,sessions,delivery:{execute:async()=>{throw new Error('unexpected write')}},workflows:[],readTools:['read-topic-sources','read-predecessor-artifact','organize-topic-sources','read-task-message-resource']})
 service=await openWorkflowService({ctx:{},config:{groupIds:['g'],ownerActorId:'owner',webActorId:'owner',artifactDirectory:join(dir,'artifacts')},legacy:{getAgentConfig:()=>({provider:'p',model:'m'}),getGroup:id=>({groupId:id,messages:[]})},execution:{store,artifacts,controller},taskOwnerSessions:{async close(){}},messageAgentSessions:{async close(){}},judge:async()=>{throw new Error('unexpected judge')}})
 const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
 await command('message.receive',{runId:'source',sourceKey:'source',sourceVersion:1,actorId:'a',conversationId:'g',body:'调查问题',policy:{initialWindowMs:45000}})
 await command('message.split',{runId:'source',units:[{unitId:'source-unit'}]})
 await command('message.accept',{runId:'source',unitId:'source-unit',commands:[{commandId:'task-command',kind:'research',args:{taskId:'task',arguments:{objective:'调查问题'},binding:{disposition:'new'}}}]})
 const input={request:'调查问题',constraints:[],acceptanceCriteria:['答复'],scope:{actorId:'a',conversationId:'g',sourceKeys:['source'],resourceIds:[],databaseIds:[],statusIds:[]},context:{},materials:[{id:'source',text:'调查问题'}]}
 await controller.createTaskPlan({commandId:'plan',taskId:'task',stages:[{stageId:'investigation',workflowId:'task-investigation',input}]})
 const plan=await controller.advanceTaskPlan('task'),runId=plan.stages[0].runId
 await controller.whenIdle(runId)
 const claim=(await command('message.command.claim',{commandId:'task-command'})).result.command
 await command('message.command.complete',{commandId:'task-command',leaseEpoch:claim.leaseEpoch,result:{taskId:'task',runId}})
 return {store,artifacts,controller,service,bindings,runId}
}

test('调查 needs_input 原节点等待；Web入口补充沿用同会话且旧lease证据可验',async t=>{
 const f=await fixture(t),before=await f.controller.state(f.runId)
 assert.equal(before.run.status,'waiting');assert.equal(before.nodes[0].status,'waiting')
 assert.equal(before.nodes[1].status,'blocked')
 const task=(await f.service.tasks())[0],request=task.investigationRequest
 assert.equal(request.question,'哪个环境');assert.equal(request.canAnswer,true)
 const answer={runId:f.runId,requestId:request.requestId,eventId:'supplement',answer:'uat2'}
 await assert.rejects(f.service.resumeRequest(answer,{channel:'im',actorId:'other',conversationId:'g'}),/FORBIDDEN/)
 await assert.rejects(f.service.resumeRequest(answer,{channel:'im',actorId:'a',conversationId:'other'}),/FORBIDDEN/)
 await f.service.resumeRequest(answer,{channel:'web',actorId:'owner'});await f.controller.whenIdle(f.runId)
 const after=await f.controller.state(f.runId)
 assert.equal(after.run.status,'succeeded',JSON.stringify(after))
 assert.equal(f.bindings.length,2);assert.equal(f.bindings[1].sessionId,f.bindings[0].sessionId)
 assert.equal(f.bindings[1].nodeRunId,f.bindings[0].nodeRunId);assert.equal(f.bindings[1].generation,f.bindings[0].generation)
 assert.equal(f.bindings[1].inputVersion,2);assert.equal(f.bindings[1].leaseEpoch,2)
 assert.deepEqual(f.bindings[1].inputHistory,[{inputVersion:1,inputDigest:f.bindings[0].inputDigest}])
 await f.service.resumeRequest(answer,{channel:'web',actorId:'owner'});await f.controller.whenIdle(f.runId)
 assert.equal(f.bindings.length,2)
 await assert.rejects(f.service.resumeRequest({...answer,answer:'uat3'},{channel:'web',actorId:'owner'}),/CONFLICT/)
})

test('调查 blocked 为失败，后继节点不能执行或伪装阶段成功',async t=>{
 const f=await fixture(t,{blocked:true}),state=await f.controller.state(f.runId)
 assert.equal(state.run.status,'failed');assert.equal(state.nodes[0].status,'failed');assert.equal(state.nodes[1].status,'blocked')
 assert.equal((await f.artifacts.read(state.nodes[0].outputRef)).outcome,'blocked')
 assert.equal((await f.service.tasks())[0].investigationRequest,null)
})

test('IM 原消息请求可展示问题并沿原调查会话续行',async t=>{
 const f=await fixture(t)
 await f.service.recoverExecutionTasks()
 const source=await f.store.query({kind:'message.run',runId:'source'}),request=source.requests.find(item=>item.nodeId==='investigation')
 assert.ok(request,JSON.stringify(source.requests));assert.equal(request.executionRunId,f.runId)
 await f.service.resumeRequest({runId:'source',requestId:request.id,eventId:'im-supplement',answer:'uat2'}, {channel:'im',actorId:'a',conversationId:'g'})
 await f.controller.whenIdle(f.runId)
 assert.equal((await f.controller.state(f.runId)).run.status,'succeeded')
 assert.equal((await f.store.query({kind:'message.run',runId:'source'})).requests.find(item=>item.id===request.id).status,'resolved')
 assert.equal(f.bindings[1].sessionId,f.bindings[0].sessionId)
})
