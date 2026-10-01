import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'
import { createMessageCoordinator } from '../packages/dingtalk-dsh-assistant/message-coordinator.js'

async function fixture(t, onTurn, handlers = {}) {
 const dir=await mkdtemp(join(tmpdir(),'native-coordination-'))
 const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:'coordination',initialize:true})
 const turns=[]
 const coordinator=createMessageCoordinator({store,context:{agentNames:()=>['助手'],candidates:async()=>({cards:[],total:0,catalogRevision:'empty'}),facts:async()=>({}),validateActions:async()=>({kind:'accepted'})},modelConfig:async()=>({provider:'script',model:'script'}),sessionRunner:{async close(){},async run(args){
  turns.push(args);await args.onSessionBound();await onTurn(args);return {status:'submitted'}
 }}})
 const workflow=createMessageWorkflow({store,coordinator,handlers})
 t.after(async()=>{await workflow.close();await store.close();await rm(dir,{recursive:true,force:true})})
 return {store,workflow,turns,async receive(id,group='g'){await workflow.receive({runId:id,sourceKey:id,sourceVersion:1,actorId:'user',conversationId:group,body:id,context:{}},{process:false})}}
}
const quiet=args=>args.onCandidate({decisions:args.input.sources.map(source=>({runId:source.runId,reason:'背景无需回应',units:[]}))})
const answer=args=>args.onCandidate({decisions:args.input.sources.map(source=>({runId:source.runId,reason:'明确查询',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,binding:{disposition:'new',candidateId:null},intent:{kind:'intent',actions:[{intent:'answer',arguments:{objective:source.body},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'result'}}]}))})

test('同群只有一个原生flight，新增来源立即入账并在当前turn完成后接续',async t=>{
 const started=Promise.withResolvers(),release=Promise.withResolvers()
 const f=await fixture(t,async args=>{if(args.input.sources[0]?.runId==='first'){started.resolve();await release.promise}await quiet(args)})
 await f.receive('first');const first=f.workflow.process('first');await started.promise
 await f.receive('second');const second=f.workflow.process('second')
 assert.equal((await f.workflow.state('second')).run.body,'second')
 assert.equal(f.turns.length,1)
 release.resolve();await Promise.all([first,second])
 assert.deepEqual(f.turns.map(turn=>turn.input.sources.map(source=>source.runId)),[['first'],['second']])
 assert.equal(f.turns[0].binding.sessionId,f.turns[1].binding.sessionId)
 assert.equal((await f.workflow.state('second')).run.status,'settled')
})

test('不同群原生会话独立：群A模型等待时群B可完成',async t=>{
 const started=Promise.withResolvers(),release=Promise.withResolvers()
 const f=await fixture(t,async args=>{if(args.binding.conversationId==='A'){started.resolve();await release.promise}await quiet(args)})
 await f.receive('first','A');const first=f.workflow.process('first');await started.promise
 try{await f.receive('second','B');await f.workflow.process('second');assert.equal((await f.workflow.state('second')).run.status,'settled');assert.equal(f.turns.length,2);assert.notEqual(f.turns[0].binding.sessionId,f.turns[1].binding.sessionId)}finally{release.resolve();await first}
})

test('协调已交付的长执行不占同群会话，后续消息继续完成',async t=>{
 const calls=[]
 const f=await fixture(t,answer,{answer:async(_action,info)=>{calls.push(info.run.runId);return info.run.runId==='long'?{executionPending:true}:{reply:'已完成'}}})
 await f.receive('long');await f.workflow.process('long')
 assert.equal((await f.workflow.state('long')).commands[0].status,'running')
 await f.receive('short');await f.workflow.process('short')
 assert.equal((await f.workflow.state('short')).commands[0].status,'applied')
 assert.deepEqual(calls,['long','short'])
 await f.workflow.recover();assert.deepEqual(calls,['long','short'])
})

test('编辑来源使旧claim失效，原session重新取得新版本且不产生旧命令',async t=>{
 let f
 f=await fixture(t,async args=>{
  if(args.input.sources[0]?.sourceVersion===1){
   await f.workflow.receive({runId:'edited',sourceKey:'original',sourceVersion:2,actorId:'user',conversationId:'g',body:'更正后',context:{}},{process:false})
   await assert.rejects(quiet(args),error=>error.code==='MESSAGE_STALE')
   throw Object.assign(new Error('MESSAGE_STALE'),{code:'MESSAGE_STALE'})
  }
  await quiet(args)
 })
 await f.receive('original');await f.workflow.process('original')
 assert.equal(f.turns.length,2)
 assert.equal(f.turns[1].input.sources[0].sourceVersion,2)
 assert.equal((await f.workflow.state('original')).commands.length,0)
 assert.equal((await f.workflow.state('edited')).run.status,'settled')
})
