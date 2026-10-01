import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'message-agent-')), options={dbPath:join(dir,'control.sqlite'),instanceId:randomUUID()}
 let store=await openExecutionStore({...options,initialize:true})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 const call=(kind,args)=>store.command({id:randomUUID(),kind:'message.'+kind,args})
 await call('receive',{runId:'m',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'a',body:'查询',context:{sourceMessageId:'incoming'}})
 await call('split',{runId:'m',units:[{unitId:'u'}]})
 await call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'answer',args:{}}]})
 const claim=()=>call('command.claim',{commandId:'c'})
 const command=(await claim()).result.command
 const input={commandId:'c',commandLeaseEpoch:command.leaseEpoch,inputVersion:1,inputDigest:'a'.repeat(64),inputRef:'input-1',sessionId:'s',toolPolicyDigest:'b'.repeat(64),mode:'read-only'}
 const execution=(await call('agent.begin',input)).result.execution
 return {get store(){return store},call,claim,input,execution,reopen:async()=>{await store.close();store=await openExecutionStore(options)}}
}
const binding=e=>({commandId:e.commandId,commandLeaseEpoch:e.commandLeaseEpoch,leaseEpoch:e.leaseEpoch,inputVersion:e.inputVersion,inputDigest:e.inputDigest,sessionId:e.sessionId})
const rejects=(promise,code)=>assert.rejects(promise,e=>e.code===code)

test('消息 Agent 持久结果缓存，旧租约拒绝且不建立 Task',async t=>{
 const f=await fixture(t),b=binding(f.execution)
 await rejects(f.call('command.complete',{commandId:'c',leaseEpoch:1,result:{}}),'MESSAGE_AGENT_NOT_DRAINED')
 await rejects(f.call('agent.complete',{...b,inputDigest:'c'.repeat(64),drained:true,resultRef:'out',result:{reply:'好'}}),'MESSAGE_AGENT_STALE')
 await f.call('agent.bind',b)
 await f.call('agent.complete',{...b,drained:true,resultRef:'out',result:{reply:'好'}})
 await f.reopen()
 const c=(await f.claim()).result.command
 const cached=(await f.call('agent.begin',{...f.input,commandLeaseEpoch:c.leaseEpoch})).result
 assert.equal(cached.cached,true);assert.equal(cached.execution.resultRef,'out')
 await f.call('command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:cached.execution.result})
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(state.commands[0].status,'applied');assert.equal(state.executions.length,1)
 assert.equal(state.commands[0].args.taskId,undefined)
})

test('等待补充排空、来源约束、同会话版本递增和迟到输出隔离',async t=>{
 const f=await fixture(t),b=binding(f.execution)
 await f.call('agent.wait',{...b,drained:true,conversationId:'g',request:{requestId:'q',question:'哪个环境',permittedActors:['a']}})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 await rejects(f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'e',answer:'uat2'}),'MESSAGE_AGENT_RESUME_REQUIRED')
 const resume={commandId:'c',requestId:'q',eventId:'e',actorId:'a',conversationId:'g',answer:'uat2',inputVersion:2,inputDigest:'c'.repeat(64),inputRef:'input-2'}
 await rejects(f.call('agent.resume',{...resume,conversationId:'other'}),'MESSAGE_AGENT_RESUME_FORBIDDEN')
 await rejects(f.call('agent.resume',{...resume,actorId:'other'}),'MESSAGE_AGENT_RESUME_FORBIDDEN')
 await f.call('agent.resume',resume)
 const c=(await f.claim()).result.command
 const e=(await f.call('agent.begin',{...f.input,...resume,commandLeaseEpoch:c.leaseEpoch})).result.execution
 assert.equal(e.sessionId,'s');assert.equal(e.leaseEpoch,2);assert.equal(e.inputHistory.length,1)
 await rejects(f.call('agent.complete',{...b,drained:true,resultRef:'old',result:{}}),'MESSAGE_AGENT_STALE')
})

test('取消须等待会话排空才能允许维护',async t=>{
 const f=await fixture(t)
 await f.call('agent.cancel',{commandId:'c',expectedLeaseEpoch:1,reason:'user_cancelled'})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,false)
 await f.call('agent.drained',{commandId:'c',leaseEpoch:1,sessionId:'s'})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'cancelled')
})

test('进程中断仅恢复已登记只读 Agent，并保持会话身份',async t=>{
 const f=await fixture(t)
 await f.reopen()
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'interrupted')
 const c=(await f.claim()).result.command
 const e=(await f.call('agent.begin',{...f.input,commandLeaseEpoch:c.leaseEpoch})).result.execution
 assert.equal(e.leaseEpoch,2);assert.equal(e.sessionId,'s')
})

test('来源编辑撤权仍须真实 drain，旧输出不得提交',async t=>{
 const f=await fixture(t)
 await f.call('receive',{runId:'m2',sourceKey:'m',sourceVersion:2,conversationId:'g',actorId:'a',body:'新的要求'})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,false)
 await assert.rejects(f.call('agent.complete',{...binding(f.execution),drained:true,resultRef:'out',result:{}}))
 await f.call('agent.drained',{commandId:'c',leaseEpoch:1,sessionId:'s'})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'superseded')
})

test('维护期间不能 begin，取消进程中断恢复为 cancelled',async t=>{
 const f=await fixture(t)
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'m',actorId:'host',reason:'deploy',active:true}})
 await rejects(f.call('agent.begin',f.input),'RUNTIME_MAINTENANCE_ACTIVE')
 await f.call('agent.cancel',{commandId:'c',expectedLeaseEpoch:1,reason:'cancel'})
 await f.reopen()
 const r=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(r.commands[0].status,'cancelled');assert.equal(r.units[0].status,'applied')
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
})

test('未登记 Agent 的旧 answer 命令中断保持 unknown',async t=>{
 const f=await fixture(t)
 await f.call('receive',{runId:'legacy-run',sourceKey:'legacy-run',sourceVersion:1,conversationId:'g',actorId:'a',body:'old'})
 await f.call('split',{runId:'legacy-run',units:[{unitId:'legacy'}]})
 await f.call('accept',{runId:'legacy-run',unitId:'legacy',commands:[{commandId:'legacy-c',kind:'answer',args:{}}]})
 await f.call('command.claim',{commandId:'legacy-c'})
 await f.reopen()
 const r=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal((await f.store.query({kind:'message.run',runId:'legacy-run'})).commands[0].status,'unknown')
})

async function failedReadOnly(t) {
 const f=await fixture(t)
 const result={status:'blocked',reason:'execution_tool_failed',reply:'读取失败'}
 await f.call('agent.fail',{...binding(f.execution),drained:true,error:'execution_tool_failed',result})
 await f.call('command.complete',{commandId:'c',leaseEpoch:1,result})
 return {...f,args:{commandId:'c',expectedInputVersion:1,expectedInputDigest:'a'.repeat(64),expectedLeaseEpoch:1,sourceVersion:1,expectedRunRevision:0,retryKey:'repair-1',reason:'已修复读取权限合同',inputVersion:2,inputDigest:'c'.repeat(64),inputRef:'input-2',sessionId:'new-session',toolPolicyDigest:'d'.repeat(64)}}
}
test('只读answer原命令受控重试保留旧失败及送达回执，新attempt独立通知且租约递增',async t=>{
 const f=await failedReadOnly(t)
 const {createWorkflowNotifications}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 let sends=0
 const adapter={canDisclose:async()=>true,send:async()=>({messageId:'out-'+(++sends)}),readback:async n=>({messageId:n.ack.messageId})}
 const notifier=createWorkflowNotifications({store:f.store,adapter})
 await notifier.flush()
 const [old]=await f.store.query({kind:'message.notifications',states:['delivered']})
 const before=JSON.stringify(old)
 const retried=(await f.call('command.retry.readonly',f.args)).result
 assert.equal(retried.execution.status,'ready');assert.equal(retried.execution.drained,true)
 assert.equal(retried.command.readonlyRetryHistory[0].result.reason,'execution_tool_failed')
 assert.equal(retried.execution.attemptHistory[0].sessionId,'s')
 assert.equal((await f.call('command.retry.readonly',f.args)).result.cached,true)
 await rejects(f.call('command.retry.readonly',{...f.args,inputDigest:'e'.repeat(64)}),'MESSAGE_READONLY_RETRY_CONFLICT')
 const next=(await f.claim()).result.command
 const e=(await f.call('agent.begin',{...f.input,...f.args,mode:'read-only',commandLeaseEpoch:next.leaseEpoch})).result.execution
 assert.equal(next.leaseEpoch,2);assert.equal(e.leaseEpoch,2)
 await rejects(f.call('agent.complete',{...binding(f.execution),drained:true,resultRef:'late',result:{}}),'MESSAGE_AGENT_STALE')
 await f.call('agent.complete',{...binding(e),drained:true,resultRef:'new-result',result:{status:'completed',reply:'查询完成'}})
 await f.call('command.complete',{commandId:'c',leaseEpoch:next.leaseEpoch,result:{status:'completed',reply:'查询完成'}})
 await notifier.flush();await notifier.flush()
 const notices=await f.store.query({kind:'message.notifications',states:['delivered']})
 assert.equal(sends,2);assert.equal(notices.length,2)
 assert.equal(JSON.stringify(notices.find(n=>n.id===old.id)),before)
 assert.ok(notices.some(n=>n.eventKey==='action.reply:c:receipt:input:2'))
})
for(const field of ['sourceVersion','expectedRunRevision','expectedInputVersion','expectedLeaseEpoch','expectedInputDigest'])test(`只读重试拒绝CAS漂移 ${field}`,async t=>{
 const f=await failedReadOnly(t)
 await rejects(f.call('command.retry.readonly',{...f.args,[field]:field==='expectedInputDigest'?'f'.repeat(64):99}),'MESSAGE_READONLY_RETRY_FORBIDDEN')
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).inputVersion,1)
})
test('只读重试拒绝未知通知及已更新来源',async t=>{
 const f=await failedReadOnly(t)
 await f.call('notification.prepare',{runId:'m',commandId:'c',notificationId:'unknown',eventKey:'old-receipt',payload:{text:'读取失败',phase:'receipt',conversationId:'g'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const n=(await f.call('notification.claim',{notificationId:'unknown'})).result.notification
 await f.call('notification.fail',{notificationId:'unknown',leaseEpoch:n.leaseEpoch,error:'ACK_LOST'})
 await rejects(f.call('command.retry.readonly',f.args),'MESSAGE_READONLY_RETRY_FORBIDDEN')
 await f.call('receive',{runId:'m2',sourceKey:'m',sourceVersion:2,conversationId:'g',actorId:'a',body:'新要求'})
 await assert.rejects(f.call('command.retry.readonly',f.args))
})
test('成功或未排空的answer不可当读取失败重试',async t=>{
 const f=await fixture(t)
 const args={commandId:'c',expectedInputVersion:1,expectedInputDigest:'a'.repeat(64),expectedLeaseEpoch:1,sourceVersion:1,expectedRunRevision:0,retryKey:'x',reason:'repair',inputVersion:2,inputDigest:'c'.repeat(64),inputRef:'i2',sessionId:'s2',toolPolicyDigest:'d'.repeat(64)}
 await rejects(f.call('command.retry.readonly',args),'MESSAGE_READONLY_RETRY_FORBIDDEN')
 await f.call('agent.complete',{...binding(f.execution),drained:true,resultRef:'out',result:{status:'completed',reply:'完成'}})
 await f.call('command.complete',{commandId:'c',leaseEpoch:1,result:{status:'completed',reply:'完成'}})
 await rejects(f.call('command.retry.readonly',args),'MESSAGE_READONLY_RETRY_FORBIDDEN')
})

for(const priorVersion of [1,2])test(`通知扫描第${priorVersion}代旧失败快照与下一代完成并发时不得占用新代次回执`,async t=>{
 const f=await failedReadOnly(t)
 const {createWorkflowNotifications}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 async function attempt(args,success){
  await f.call('command.retry.readonly',args)
  const command=(await f.claim()).result.command
  const entry=(await f.call('agent.begin',{...f.input,...args,mode:'read-only',commandLeaseEpoch:command.leaseEpoch})).result.execution
  const result=success?{status:'answered',reply:'第三次查询完成'}:{status:'blocked',reason:'execution_tool_failed',reply:'第二次读取失败'}
  await f.call(success?'agent.complete':'agent.fail',{...binding(entry),drained:true,resultRef:'result-'+args.inputVersion,result,...(success?{}:{error:'execution_tool_failed'})})
  await f.call('command.complete',{commandId:'c',leaseEpoch:command.leaseEpoch,result})
 }
 if(priorVersion===2)await attempt(f.args,false)
 let crossed=false;const sent=[]
 const store={command:arg=>f.store.command(arg),query:async arg=>{
  const result=await f.store.query(arg)
  if(arg.kind==='message.run'&&arg.runId==='m'&&!crossed){
   crossed=true
   assert.equal(result.commands[0].result.inputVersion,priorVersion)
   await attempt({...f.args,expectedInputVersion:priorVersion,expectedInputDigest:priorVersion===1?'a'.repeat(64):f.args.inputDigest,expectedLeaseEpoch:priorVersion,retryKey:'repair-final',inputVersion:priorVersion+1,inputDigest:'e'.repeat(64),inputRef:'input-final',sessionId:'final-session'},true)
  }
  return result
 }}
 const notifier=createWorkflowNotifications({store,adapter:{canDisclose:async()=>true,send:async n=>{sent.push(n.payload.text);return{messageId:'sent-'+sent.length}},readback:async n=>({messageId:n.ack.messageId})}})
 await assert.rejects(notifier.flush())
 assert.equal(crossed,true);assert.deepEqual(sent,[])
 await notifier.flush();await notifier.flush()
 assert.equal(sent.length,1);assert.match(sent[0],/第三次查询完成/)
 const notices=await f.store.query({kind:'message.notifications',states:['delivered']})
 assert.equal(notices[0].eventKey,`action.reply:c:receipt:input:${priorVersion+1}`)
 assert.equal(notices[0].payload.fact.commandInputVersion,priorVersion+1)
 assert.equal(notices[0].payload.fact.commandLeaseEpoch,priorVersion+1)
})
