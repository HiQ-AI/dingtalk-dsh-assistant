import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createMessageAgentController } from '../packages/dingtalk-dsh-assistant/message-agent.js'

const result = (extra={}) => ({outcome:'completed',summary:'查询结果',evidenceRefs:['source'],limitations:[],question:'',...extra})
function runner() {
 const calls=[]
 return {calls,run(args){return new Promise((resolve,reject)=>calls.push({...args,resolve,reject}))},
  async cancel(binding){const call=calls.find(c=>c.binding.sessionId===binding.sessionId);call.resolve({status:'cancelled'})},
  async close(){for(const call of calls)call.resolve({status:'cancelled'})},
  async submit(value,index=calls.length-1){const call=calls[index];await call.onSessionBound();try{await call.onResult(value);call.resolve({status:'submitted'})}catch(error){call.reject(error)}}}
}
async function fixture(t, overrides={}) {
 const dir=await mkdtemp(join(tmpdir(),'message-controller-')),options={dbPath:join(dir,'control.sqlite'),instanceId:randomUUID()}
 let store=await openExecutionStore({...options,initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true}),sessions=runner()
 const call=(kind,args)=>store.command({id:randomUUID(),kind:'message.'+kind,args})
 await call('receive',{runId:'m',sourceKey:'m',sourceVersion:1,conversationId:'g',actorId:'a',body:'查一下'})
 await call('split',{runId:'m',units:[{unitId:'u'}]})
 await call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'answer',args:{}}]})
 const controllers=[]
 const events=[]
 const queryReceipt=ref=>{const seq=events.length,callId=`query-${seq}`;events.push(
  {type:'tool/call',seq,data:{name:'query_fixture',callId}},
  {type:'tool/result',seq:seq+1,sourceEventSeqs:[seq],data:{message:{source:{callId},content:[{type:'tool-result',toolCallId:callId,isError:false,content:[{type:'text',text:JSON.stringify({evidenceRef:ref})}]}]}}})}
 const controller=(extra={})=>{const c=createMessageAgentController({ctx:{sessions:{get:()=>({snapshotEvents:()=>events})}},store,artifacts,tools:[{name:'query_fixture'}],modelConfig:async()=>({provider:'p',model:'m'}),prepareInput:async()=>({request:'查一下',sourceRefs:['source'],scope:{conversationId:'g',actorId:'a'}}),verifyEvidence:async()=>true,ownerActorId:'owner',sessionRunner:sessions,...overrides,...extra});controllers.push(c);return c}
 const claim=async()=>({commandId:'c',commandLeaseEpoch:(await call('command.claim',{commandId:'c'})).result.command.leaseEpoch})
 t.after(async()=>{for(const c of controllers)await c.close().catch(()=>{});await store.close();await rm(dir,{recursive:true,force:true})})
 return {dir,get store(){return store},call,artifacts,sessions,events,queryReceipt,controller,claim,reopen:async()=>{await store.close();store=await openExecutionStore(options)}}
}

test('start 在会话未完成时返回，真实 ledger 承接结果与工具证据',async t=>{
 let verified=0
 const f=await fixture(t,{verifyEvidence:async({refs,binding})=>{verified++;assert.deepEqual(refs,['tool-evidence']);assert.equal(binding.kind,'message-unit');return true}}),c=f.controller()
 f.queryReceipt('tool-evidence')
 assert.deepEqual(await c.start({},await f.claim()),{executionPending:true})
 assert.equal(f.sessions.calls.length,1)
 assert.equal(await c.isCurrent(f.sessions.calls[0].binding),true)
 await f.sessions.submit(result({evidenceRefs:['tool-evidence']}));await c.idle()
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(verified,1);assert.equal(state.commands[0].status,'applied');assert.equal(state.executions[0].status,'succeeded')
 assert.equal((await f.artifacts.read(state.executions[0].resultRef)).summary,'查询结果')
})

test('verifyEvidence 未明确返回 true 则持久失败，不能冒充完成',async t=>{
 const f=await fixture(t,{verifyEvidence:async()=>undefined}),c=f.controller()
 f.queryReceipt('unverified')
 await c.start({},await f.claim());await f.sessions.submit(result({evidenceRefs:['unverified']}));await c.idle()
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(state.executions[0].status,'failed');assert.equal(state.executions[0].error,'AGENT_WORK_EVIDENCE_INVALID')
})

test('问答截短或构造查询引用先反馈纠正，原样引用持久回执后同会话提交',async t=>{
 let reads=0,inspected=0
 const ref=`tasks/task-a/sha256-${'a'.repeat(64)}.json`
 const f=await fixture(t,{verifyEvidence:async({refs})=>{reads++;assert.deepEqual(refs,[ref]);return true}})
 f.queryReceipt(ref)
 const c=f.controller({ctx:{sessions:{get:()=>null},sessionPersistence:{inspect:async id=>{inspected++;assert.equal(id,f.sessions.calls[0].binding.sessionId);return {events:f.events}}}}})
 await c.start({},await f.claim())
 const call=f.sessions.calls[0]
 for(const invalid of [ref.split('/').at(-1),'invented-evidence']) {
  await assert.rejects(call.validateOutput(result({evidenceRefs:[invalid]})),error=>error.code==='AGENT_WORK_EVIDENCE_INVALID'&&call.classifyOutputError(error)==='correctable')
 }
 assert.equal(reads,0)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).executions[0].status,'running')
 await f.sessions.submit(result({evidenceRefs:[ref]}));await c.idle()
 assert.equal(inspected,3);assert.equal(reads,1)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).executions[0].status,'succeeded')
})

test('问答不要求引用所有试探查询，未引用的旧查询不进入当前归属核验',async t=>{
 let verified=0
 const f=await fixture(t,{verifyEvidence:async()=>{verified++;return true}}),c=f.controller()
 f.queryReceipt('old-input-query')
 await c.start({},await f.claim());await f.sessions.submit(result());await c.idle()
 assert.equal(verified,0)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).executions[0].status,'succeeded')
})

test('问答真实查询回执的工件丢失仍按存储故障停止',async t=>{
 const ref=`sha256-${'b'.repeat(64)}.json`,f=await fixture(t)
 f.queryReceipt(ref)
 const c=f.controller({verifyEvidence:async({refs})=>{await f.artifacts.read(refs[0]);return true}})
 await c.start({},await f.claim())
 const call=f.sessions.calls[0]
 await assert.rejects(call.validateOutput(result({evidenceRefs:[ref]})),error=>error.code==='ENOENT'&&call.classifyOutputError(error)==='fatal')
 await f.sessions.submit(result({evidenceRefs:[ref]}));await c.idle()
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(state.executions[0].status,'failed');assert.equal(state.executions[0].error,'ENOENT')
})

test('needs_input 补充沿用会话且递增版本，重复同事件不重复追加',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim());await f.sessions.submit(result({outcome:'needs_input',question:'哪个环境'}));await c.idle()
 let data=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(data.commands[0].status,'waiting');assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 const args={request:data.requests[0],data,identity:{actorId:'a'},eventId:'answer-event',answer:'uat2'}
 await c.resume(args);await c.resume(args)
 await c.start({},await f.claim())
 assert.equal(f.sessions.calls[1].binding.sessionId,f.sessions.calls[0].binding.sessionId)
 assert.equal(f.sessions.calls[1].binding.inputVersion,2);assert.equal(f.sessions.calls[1].input.clarificationAnswers.length,1)
 const history=(await f.store.query({kind:'message.agent.execution',commandId:'c'})).bindingHistory
 assert.deepEqual(history,[{inputVersion:1,inputDigest:f.sessions.calls[0].binding.inputDigest,sessionId:f.sessions.calls[0].binding.sessionId,leaseEpoch:1}])
 await f.sessions.submit(result());await c.idle()
 data=await f.store.query({kind:'message.run',runId:'m'});assert.equal(data.executions[0].status,'succeeded')
})

test('来源失效取消会话并排空，迟到结果不被接纳',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 await f.call('receive',{runId:'m2',sourceKey:'m',sourceVersion:2,conversationId:'g',actorId:'a',body:'新要求'})
 assert.equal(await c.isCurrent(f.sessions.calls[0].binding),false)
 await c.reconcile();await c.idle()
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 await assert.rejects(f.sessions.calls[0].onResult(result()))
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'superseded')
})

test('会话预算终止原因持久化并正常收口命令',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 f.sessions.calls[0].resolve({status:'no_submission',reason:'execution_step_budget_exhausted'});await c.idle()
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(state.executions[0].error,'execution_step_budget_exhausted');assert.equal(state.commands[0].status,'applied')
})

test('结果已落盘但 command 未 complete 的重启仅返回缓存给新 lease',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 const e=await f.store.query({kind:'message.agent.execution',commandId:'c'}),saved=await f.artifacts.put(result())
 await f.call('agent.complete',{...e,drained:true,resultRef:saved.ref,result:{status:'answered',reply:'已查询'}})
 // 模拟结果保存后的进程消失，runner 不提交第二次结果。
 f.sessions.calls[0].resolve({status:'stale'});await c.idle();await f.reopen()
 const next=f.controller({modelConfig:async()=>{throw new Error('缓存不需要模型')}}),claim=await f.claim()
 assert.equal(claim.commandLeaseEpoch,2)
 assert.deepEqual(await next.start({},claim),{status:'answered',reply:'已查询'})
 assert.equal(f.sessions.calls.length,1)
 await f.call('command.complete',{commandId:'c',leaseEpoch:claim.commandLeaseEpoch,result:{status:'answered',reply:'已查询'}})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).commands[0].status,'applied')
})

test('真实原生 Loop 与持久会话完成等待补充后同 session 续行',async t=>{
 const ctx=new Context(),requireLoop=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
 const {SessionProjectionRegistry}=requireLoop('@deepseek-ai/dsh-session-projection')
 new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx)
 new SystemPrompt(ctx,{includeRuntimeContext:false,includeHarnessIdentity:false});new LlmRuntime(ctx);new ToolRuntime(ctx)
 const f=await fixture(t)
 new JsonlSessionPersistence(ctx,{root:join(f.dir,'sessions'),packChunks:false,compression:'none',writeBatchMaxDelayMs:1})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 let calls=0
 class Scripted extends LlmAdapter {
  async *stream(){
   const output=++calls===1?result({outcome:'needs_input',question:'哪个环境'}):result()
   const args=JSON.stringify({output}),id='submit-'+calls
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id,name:'execution_node_submit',argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'execution_node_submit',arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }
 }
 ctx.llm.registerAdapter(['p'],new Scripted())
 const c=f.controller({ctx,tools:[],sessionRunner:undefined})
 try {
  await c.start({},await f.claim());await c.idle()
  const data=await f.store.query({kind:'message.run',runId:'m'})
  assert.equal(data.executions[0].status,'waiting_user');assert.equal(data.executions[0].sessionBound,true)
  await c.resume({request:data.requests[0],data,identity:{actorId:'a'},eventId:'native-answer',answer:'uat2'})
  await c.start({},await f.claim());await c.idle()
  const final=await f.store.query({kind:'message.run',runId:'m'})
  assert.equal(final.executions[0].status,'succeeded');assert.equal(final.commands[0].status,'applied');assert.equal(calls,2)
  const persisted=await ctx.sessionPersistence.inspect(final.executions[0].sessionId)
  const versions=persisted.events.filter(e=>e.type==='user/message').map(e=>e.data.source?.executionSession?.inputVersion).filter(Boolean)
  assert.deepEqual(versions,[1,2])
 } finally {await c.close();await ctx.fiber.dispose()}
})

test('真实工件内容与已登记 inputDigest 不一致时不启动会话',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 f.sessions.calls[0].resolve({status:'stale'});await c.idle();await f.reopen()
 const altered=f.controller({artifacts:{...f.artifacts,read:async()=>({scope:{conversationId:'g',actorId:'a'},request:'changed'})}})
 await assert.rejects(altered.start({},await f.claim()),e=>e.code==='MESSAGE_AGENT_INPUT_CONFLICT')
 assert.equal(f.sessions.calls.length,1)
})

test('公开 cancel 取消正在运行的同会话，完成排空才返回',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 const cancelled=await c.cancel('c','user_cancelled')
 assert.equal(cancelled.execution.status,'cancelled')
 assert.equal(cancelled.execution.sessionId,f.sessions.calls[0].binding.sessionId)
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).commands[0].status,'cancelled')
})

test('公开 cancel 直接结束待补充执行且不得再续行',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim());await f.sessions.submit(result({outcome:'needs_input',question:'哪个环境'}));await c.idle()
 const data=await f.store.query({kind:'message.run',runId:'m'})
 await c.cancel('c','user_cancelled')
 await assert.rejects(c.resume({request:data.requests[0],data,identity:{actorId:'a'},eventId:'late',answer:'uat2'}))
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'cancelled')
})

test('Host selectTools 仅允许注册子集，拒绝未注册能力',async t=>{
 const f=await fixture(t,{tools:[{name:'read_one'},{name:'read_two'}],selectTools:async input=>{assert.equal(input.scope.conversationId,'g');return ['read_one']}}),c=f.controller()
 await c.start({},await f.claim());assert.deepEqual(f.sessions.calls[0].definition.allowedTools,['read_one'])
 await c.cancel('c','done')
 const other=await fixture(t,{tools:[{name:'read_one'}],selectTools:async()=>['write_unknown']}),bad=other.controller()
 await assert.rejects(bad.start({},await other.claim()),e=>e.code==='MESSAGE_AGENT_TOOLS_INVALID')
 assert.equal(other.sessions.calls.length,0)
})

test('取消不能证明排空时保留 busy，不把失败当作取消完成',async t=>{
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 const cancel=f.sessions.cancel
 f.sessions.cancel=async()=>{throw Object.assign(new Error('drain_failed'),{executionDrained:false})}
 await assert.rejects(c.cancel('c','user_cancelled'),/drain_failed/)
 assert.equal((await f.store.query({kind:'message.agent.execution',commandId:'c'})).status,'cancelling')
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,false)
 f.sessions.cancel=cancel
 await c.cancel('c','user_cancelled')
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
})


test('结果结算唤醒在session run释放之后，启动冲突可经真实排空证明取消',async t=>{
 const f=await fixture(t);let released=false,settled=false
 const c=f.controller({sessionRunner:{async run(args){await args.onSessionBound();await args.onResult(result());assert.equal(settled,false);released=true;return {status:'submitted'}},async close(){}},onCommandSettled:async()=>{assert.equal(released,true);settled=true}})
 await c.start({},await f.claim());await c.idle();assert.equal(settled,true)
})

test('未绑定启动冲突保留失败flight，只有原生assertDrained成功才收口取消',async t=>{
 const f=await fixture(t);let safe=false
 const c=f.controller({sessionRunner:{async run(){throw Object.assign(Error('execution_run_busy'),{code:'execution_run_busy',executionDrained:false})},async cancel(){},assertDrained(){if(!safe)throw Object.assign(Error('busy'),{executionDrained:false});return true},async close(){}}})
 await c.start({},await f.claim());await assert.rejects(c.idle(),/execution_run_busy/)
 await assert.rejects(c.cancel('c','cancel'),/busy/)
 let entry=await f.store.query({kind:'message.agent.execution',commandId:'c'});assert.equal(entry.drained,false)
 safe=true;await c.cancel('c','cancel');await c.idle()
 entry=await f.store.query({kind:'message.agent.execution',commandId:'c'});assert.equal(entry.status,'cancelled');assert.equal(entry.drained,true)
})


test('清理链前项失败仍依次关闭后续资源和真实Store，原始错误保留且owner锁释放',async t=>{
 const {closeExecutionResources}=await import('../packages/dingtalk-dsh-assistant/execution.js')
 const root=await mkdtemp(join(tmpdir(),'close-resources-')),options={dbPath:join(root,'control.sqlite'),instanceId:'close-test'}
 t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await openExecutionStore({...options,initialize:true}),order=[],first=Error('session-flight-error'),second=Error('message-close-error')
 await assert.rejects(closeExecutionResources([
  ['messageAgent',async()=>{order.push('messageAgent');throw first}],
  ['messages',async()=>{order.push('messages');throw second}],
  ['taskOwner',async()=>{order.push('taskOwner')}],
  ['execution',()=>closeExecutionResources([['controller',async()=>{order.push('controller');throw Error('controller-close-error')}],['store',async()=>{order.push('store');await store.close()}]])],
  ['runtime',async()=>{order.push('runtime')}],
 ]),error=>{assert.ok(error instanceof AggregateError);assert.equal(error.errors.length,3);assert.equal(error.errors[0].cause,first);assert.equal(error.errors[1].cause,second);return true})
 assert.deepEqual(order,['messageAgent','messages','taskOwner','controller','store','runtime'])
 const reopened=await openExecutionStore(options);await reopened.query({kind:'runtime.maintenance'});await reopened.close()
})


test('问答公开正文不能携带内部绑定，校验失败后可提交业务答复且内部记录保留', async t => {
 const f=await fixture(t),c=f.controller()
 await c.start({},await f.claim())
 const call=f.sessions.calls[0]
 const bad=result({summary:`已查询 ${call.binding.sessionId}`})
 await assert.rejects(call.validateOutput(bad), error=>error.code==='GROUP_REPLY_INTERNAL_DETAILS' && call.classifyOutputError(error)==='correctable')
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).executions[0].status,'running')
 await f.sessions.submit(result({summary:'查询已完成，结果如下。'}));await c.idle()
 const state=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(state.commands[0].result.reply,'查询已完成，结果如下。')
 assert.equal(state.executions[0].sessionId,call.binding.sessionId)
})
