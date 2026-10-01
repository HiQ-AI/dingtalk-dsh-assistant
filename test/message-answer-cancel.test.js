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

async function fixture(t,{actor='a',group='g',quoted=true,count=1,queued=true,coordinatorSessions}={}) {
 const dir=await mkdtemp(join(tmpdir(),'answer-cancel-'))
 const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:randomUUID(),initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
 const controller=createExecutionController({store,artifacts,delivery:{execute:async()=>{throw new Error('unexpected effect')}},workflows:[],readTools:['read-topic-sources','read-predecessor-artifact','organize-topic-sources','read-task-message-resource']})
 let service
 t.after(async()=>{await service?.close();await controller.close();await store.close();await rm(dir,{recursive:true,force:true})})
 service=await openWorkflowService({ctx:{},config:{groupIds:['g','other'],ownerActorId:'owner',artifactDirectory:join(dir,'artifacts')},
  legacy:{getAgentConfig:()=>({provider:'test',model:'test'}),getGroup:id=>({groupId:id,messages:[]})},
  execution:{store,artifacts,controller},
  coordinatorSessions:coordinatorSessions??{async close(){},async run(){throw new Error('预置命令无需语义重判')}},taskOwnerSessions:{async close(){}},messageAgentSessions:{async close(){},async cancel(){throw new Error('waiting must not cancel live session')}}})

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
 return {store,service,artifacts,call}
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
})



async function clarification(f) {
 const state=await f.store.query({kind:'message.run',runId:'cancel'})
 const targets=[]
 for(const commandId of ['answer0','answer1']) {
  const execution=await f.store.query({kind:'message.agent.execution',commandId})
  targets.push({commandId,runId:'source',sourceVersion:1,inputVersion:execution.inputVersion,inputDigest:execution.inputDigest})
 }
 const snapshot=await f.artifacts.put({runId:'cancel',revision:state.run.revision,sourceVersion:1,actorId:state.run.actorId,conversationId:state.run.conversationId,unitId:'cancel-unit',targets})
 await f.call('wait',{runId:'cancel',unitId:'cancel-unit',nodeId:'coordinator',reason:'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED',request:{requestId:'choose',kind:'needs_clarification',reason:'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED',question:'停止哪个查询？',permittedActors:['a'],needs:[{resourceRef:snapshot.ref,reason:'message-answer-cancel-snapshot'}]}})
}
async function selected(f) {
 await f.call('accept',{runId:'cancel',unitId:'cancel-unit',commands:[{commandId:'cancel-selected',kind:'cancel_answer',args:{arguments:{commandId:'answer1'},binding:{disposition:'new'},taskId:null,replyPolicy:'none'}}]})
 await f.service.messages.commandSettled('cancel')
}

test('多事项澄清的身份限制保留，选定一项仅取消该项，重派不重复',async t=>{
 const f=await fixture(t,{count:2,queued:false})
 await clarification(f)
 for(const actorId of ['owner','other'])await assert.rejects(f.call('wake',{runId:'cancel',requestId:'choose',eventId:'bad-'+actorId,actorId,answer:'停止查询1'}))
 await f.call('wake',{runId:'cancel',requestId:'choose',eventId:'choice',actorId:'a',answer:'停止查询1，查询0继续'})
 await selected(f)
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer1'})).status,'cancelled')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
 await f.service.messages.commandSettled('cancel')
 const final=await f.store.query({kind:'message.run',runId:'cancel'})
 assert.equal(final.commands.length,1);assert.equal(final.commands[0].status,'applied')
})

test('澄清期间目标输入版本变化，旧精确候选不能授权取消',async t=>{
 const f=await fixture(t,{count:2,queued:false})
 await clarification(f)
 await f.call('agent.resume',{commandId:'answer1',requestId:'q1',eventId:'target-input-update',actorId:'a',conversationId:'g',answer:'uat2',inputVersion:2,inputDigest:'c'.repeat(64),inputRef:'new-input'})
 await f.call('wake',{runId:'cancel',requestId:'choose',eventId:'choice',actorId:'a',answer:'停止查询1'})
 await selected(f)
 assert.equal((await f.store.query({kind:'message.run',runId:'cancel'})).commands[0].status,'rejected')
 const target=await f.store.query({kind:'message.agent.execution',commandId:'answer1'})
 assert.equal(target.status,'ready');assert.equal(target.inputVersion,2)
})



test('常驻协调跨turn澄清同群唤醒原取消事项，不自锁且精确取消已选项', {timeout:10000}, async t=>{
 let question, turns=0
 const coordinatorSessions={async close(){},async run(args){
  turns++
  await args.onSessionBound()
  const decisions=args.input.sources.map(source=>{
   const selected=source.requests.some(request=>request.status==='resolved')
   const action=source.runId==='choice-source'
    ? {intent:'clarification',arguments:{runId:'cancel',requestId:question.id,answer:source.body},dependsOn:[]}
    : {intent:'cancel_answer',arguments:{commandId:selected?'answer1':'answer0'},dependsOn:[]}
   return {runId:source.runId,reason:'取消指定问答',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding:{disposition:'new',candidateId:null},intent:{kind:'intent',actions:[action],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}}]}
  })
  await args.onCandidate({decisions});return {status:'submitted'}
 }}
 const f=await fixture(t,{count:2,queued:false,coordinatorSessions})
 const first=await f.service.messages.process('cancel')
 question=first.requests.find(request=>request.status==='pending')
 assert.equal(question.reason,'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED')
 assert.ok(question.needs.some(need=>need.reason==='message-answer-cancel-snapshot'))
 await f.service.messages.receive({runId:'choice-source',sourceKey:'choice-source',sourceVersion:1,actorId:'a',conversationId:'g',body:'停止查询1，查询0继续',context:{quoteRefs:[]}},{process:false})
 await f.service.messages.process('choice-source')
 await f.service.messages.process('cancel')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer1'})).status,'cancelled')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'answer0'})).status,'waiting_user')
 const done=await f.service.messages.state('cancel')
 assert.equal(done.commands.length,1);assert.equal(done.commands[0].status,'applied')
 assert.equal(done.requests.find(request=>request.id===question.id).answer,'停止查询1，查询0继续')
 assert.equal(turns,3)
})
