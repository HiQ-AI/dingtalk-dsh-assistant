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
import { messageSchemas } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { messageSystem } from '../packages/dingtalk-dsh-assistant/message-model.js'

async function fixture(t,{actor='a',group='g',quoted=true,count=1,queued=true,judge}={}) {
 const dir=await mkdtemp(join(tmpdir(),'answer-cancel-'))
 const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:randomUUID(),initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
 const controller=createExecutionController({store,artifacts,delivery:{execute:async()=>{throw new Error('unexpected effect')}},workflows:[],readTools:['read-topic-sources','read-predecessor-artifact','organize-topic-sources','read-task-message-resource']})
 let service
 t.after(async()=>{await service?.close();await controller.close();await store.close();await rm(dir,{recursive:true,force:true})})
 service=await openWorkflowService({ctx:{},config:{groupIds:['g','other'],ownerActorId:'owner',artifactDirectory:join(dir,'artifacts')},
  legacy:{getAgentConfig:()=>({provider:'test',model:'test'}),getGroup:id=>({groupId:id,messages:[]})},
  execution:{store,artifacts,controller},judge:judge??(async()=>{throw new Error('queued action needs no model')}),
  taskOwnerSessions:{async close(){}},messageAgentSessions:{async close(){},async cancel(){throw new Error('waiting must not cancel live session')}}})

 const call=(kind,args)=>store.command({id:randomUUID(),kind:'message.'+kind,args})
 await call('receive',{runId:'source',sourceKey:'source',sourceVersion:1,policy:{initialWindowMs:45000},actorId:'a',conversationId:'g',body:'查询记录'})
 await call('split',{runId:'source',units:Array.from({length:count},(_,i)=>({unitId:'u'+i}))})
 for(let i=0;i<count;i++){
  await call('topic.bind',{runId:'source',unitId:'u'+i,expectedRevision:0,binding:{kind:'binding',disposition:'new',candidateId:null},topic:{topicId:'topic'+i,conversationId:'g',sourceRunId:'source',unitId:'u'+i,title:'查询'+i,facts:[]}})
  await call('accept',{runId:'source',unitId:'u'+i,commands:[{commandId:'answer'+i,kind:'answer',args:{arguments:{objective:'查询'+i},taskId:null}}]})
  const claim=(await call('command.claim',{commandId:'answer'+i})).result.command
  const entry=(await call('agent.begin',{commandId:claim.id,commandLeaseEpoch:claim.leaseEpoch,inputVersion:1,inputDigest:'a'.repeat(64),inputRef:'input',sessionId:'session'+i,toolPolicyDigest:'b'.repeat(64),mode:'read-only'})).result.execution
  await call('agent.wait',{...entry,drained:true,conversationId:'g',request:{requestId:'q'+i,question:'哪个环境',permittedActors:['a']}})
 }
 await call('receive',{runId:'cancel',sourceKey:'cancel',sourceVersion:1,policy:{initialWindowMs:45000},actorId:actor,conversationId:group,body:'取消引用的问题',context:{quoteRefs:quoted?[{sourceKey:'source'}]:[]}})
 await call('split',{runId:'cancel',units:[{unitId:'cancel-unit',spans:[{start:0,end:8}],goalText:'取消引用的问题',constraints:[],contextNeeds:[]}]})
 if(queued)await call('accept',{runId:'cancel',unitId:'cancel-unit',commands:[{commandId:'cancel-command',kind:'cancel_answer',args:{arguments:{commandId:'answer0'},binding:{disposition:'new'},taskId:null,replyPolicy:'none'}}]})
 const process=service.messages.process.bind(service.messages)
 service.messages.process=async id=>{await process(id);for(let i=0;i<100;i++){const data=await store.query({kind:'message.run',runId:id});if(data.requests.some(q=>q.status==='pending')||data.commands.length&&data.commands.every(c=>['applied','rejected','unknown'].includes(c.status)))return data;await new Promise(resolve=>setTimeout(resolve,10))}return store.query({kind:'message.run',runId:id})}
 return {store,service}
}

test('同发送者同群明确引用唯一问答，取消原执行而不建Task',async t=>{
 const f=await fixture(t)
 await f.service.messages.process('cancel')
 const state=await f.store.query({kind:'message.run',runId:'cancel'})
 assert.equal(state.commands[0].status,'applied')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'cancelled')
 assert.deepEqual(await f.store.query({kind:'run.list'}),[])
})

for(const [name,options] of [['其他发送者',{actor:'other'}],['owner不代替原发送者',{actor:'owner'}],['其他群',{group:'other'}],['没有引用',{quoted:false}],['多个事项',{count:2}]])test(`问答取消拒绝${name}，原执行保持等待`,async t=>{
 const f=await fixture(t,options)
 await f.service.messages.process('cancel')
 assert.equal((await f.store.query({kind:'message.run',runId:'cancel'})).commands[0].status,'rejected')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
})

test('取消问答为严格独立合同，模型不得夹带任务或泛化范围',()=>{
 const intent=arguments_=>({kind:'intent',actions:[{intent:'cancel_answer',arguments:arguments_,dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'})
 assert.equal(messageSchemas.I.safeParse(intent({commandId:'answer'})).success,true)
 for(const args of [{},{commandId:'answer',taskId:'task'},{commandId:'answer',scope:'conversation'}])assert.equal(messageSchemas.I.safeParse(intent(args)).success,false)
 assert.match(messageSystem('I'),/没有候选、多个候选尚未澄清或指代不清时needs_clarification/)
})

test('真实意图阶段拿到受信候选；多个事项转澄清且零取消效果',async t=>{
 const seen=[]
 const intent=input=>{seen.push(input.facts.cancellableAnswers);return {kind:'intent',actions:[{intent:'cancel_answer',arguments:{commandId:'answer0'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}
 const judge=async({stage,input})=>stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
  :stage==='IB'?{kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:intent(unit.input)}))}:intent(input)
 const f=await fixture(t,{count:2,queued:false,judge})
 const state=await f.service.messages.process('cancel')
 assert.equal(seen.length,1,JSON.stringify(state));assert.equal(seen[0].length,2)
 assert.equal(state.commands.length,0)
 assert.equal(state.requests[0].reason,'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
})

test('多事项澄清后原发送者选定一项，原生重判只取消该项且重放不重复',async t=>{
 let judgments=0
 const intent=input=>{judgments++;return {kind:'intent',actions:[{intent:'cancel_answer',arguments:{commandId:input.clarificationAnswers?.length?'answer1':'answer0'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}
 const judge=async({stage,input})=>stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
  :stage==='IB'?{kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:intent(unit.input)}))}:intent(input)
 const f=await fixture(t,{count:2,queued:false,judge})
 const state=await f.service.messages.process('cancel'),q=state.requests[0]
 const input={runId:'cancel',requestId:q.id,eventId:'choice',answer:'停止查询1，查询0继续'}
 for(const identity of [{channel:'im',actorId:'owner',conversationId:'g'},{channel:'im',actorId:'a',conversationId:'other'}])await assert.rejects(f.service.resumeRequest(input,identity),/FORBIDDEN/)
 const identity={channel:'im',actorId:'a',conversationId:'g'}
 await f.service.resumeRequest(input,identity)
 await f.service.messages.process('cancel')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer1'})).status,'cancelled')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
 const final=await f.store.query({kind:'message.run',runId:'cancel'}),before=judgments
 assert.equal(final.commands.length,1);assert.equal(final.commands[0].args.arguments.commandId,'answer1')
 await f.service.resumeRequest(input,identity);await f.service.messages.process('cancel')
 assert.equal(judgments,before)
 assert.equal((await f.store.query({kind:'message.run',runId:'cancel'})).commands.length,1)
 await assert.rejects(f.service.resumeRequest({...input,answer:'改为取消查询0'},identity))
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
})

test('澄清期间目标输入版本变更，旧候选许可失效并重新询问',async t=>{
 const intent=input=>({kind:'intent',actions:[{intent:'cancel_answer',arguments:{commandId:input.clarificationAnswers?.length?'answer1':'answer0'},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'})
 const judge=async({stage,input})=>stage==='R'?{kind:'binding',disposition:'new',candidateId:null,evidence:['source']}
  :stage==='IB'?{kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:intent(unit.input)}))}:intent(input)
 const f=await fixture(t,{count:2,queued:false,judge})
 const state=await f.service.messages.process('cancel'),q=state.requests[0]
 await f.store.command({id:randomUUID(),kind:'message.agent.resume',args:{commandId:'answer1',requestId:'q1',eventId:'target-input-update',actorId:'a',conversationId:'g',answer:'uat2',inputVersion:2,inputDigest:'c'.repeat(64),inputRef:'new-input'}})
 await f.service.resumeRequest({runId:'cancel',requestId:q.id,eventId:'choice',answer:'停止查询1'}, {channel:'im',actorId:'a',conversationId:'g'})
 const after=await f.service.messages.process('cancel')
 assert.equal(after.commands.length,0)
 assert.ok(after.requests.some(item=>item.status==='pending'&&item.reason==='MESSAGE_AGENT_CANCEL_TARGET_REQUIRED'))
 const target=await f.store.query({kind:'message.agent.execution',commandId:'answer1'})
 assert.equal(target.status,'ready');assert.equal(target.inputVersion,2)
})
