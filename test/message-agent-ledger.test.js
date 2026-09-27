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
 await call('receive',{runId:'m',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'a',body:'查询'})
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
