import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'message-ledger-'));const options={dbPath:join(dir,'control.sqlite'),instanceId:randomUUID()}
 let store=await openExecutionStore({...options,initialize:true})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 return {get store(){return store},call:(kind,args,id=randomUUID())=>store.command({id,kind:'message.'+kind,args}),reopen:async()=>{await store.close();store=await openExecutionStore(options)}}
}
const receive=(runId='m',extra={})=>({runId,sourceKey:runId,sourceVersion:1,conversationId:'g',actorId:'a',body:'do this',...extra})
const bad=(p,code)=>assert.rejects(p,e=>e.code===code)
test('人工重处理仅允许无业务命令的旧消息，保留旧请求并生成有序新版本',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{context:{sourceMessageId:'original'}}))
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,reason:'old context',request:{requestId:'q',kind:'needs_clarification',question:'old?',permittedActors:['a']}})
 const result=await f.call('reprocess',{runId:'m',newRunId:'m-replay'})
 assert.equal(result.result.run.sourceVersion,2)
 assert.equal(result.result.run.context.replayOfSequenceId,1)
 assert.equal(result.result.run.context.occurredAt,(await f.store.query({kind:'message.run',runId:'m'})).run.createdAt)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).requests[0].status,'superseded')
 assert.equal((await f.store.query({kind:'message.source',sourceKey:'m'})).runId,'m-replay')
 const second=await f.call('reprocess',{runId:'m-replay',newRunId:'m-replay-2'})
 assert.equal(second.result.run.context.occurredAt,result.result.run.context.occurredAt)
 assert.equal(second.result.run.context.replayOf,'m')
 await bad(f.call('reprocess',{runId:'m',newRunId:'again'}),'MESSAGE_STALE')
 await f.call('receive',receive('effect'))
 await f.call('split',{runId:'effect',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'effect',unitId:'u',commands:[{commandId:'effect-command',kind:'create',args:{}}]})
 await bad(f.call('reprocess',{runId:'effect',newRunId:'effect-replay'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
})
test('人工重处理重新分配节点预算，旧版本消耗不阻断新版本关联节点',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{maxClaims:2,maxInputTokens:100,maxOutputTokens:100}}))
 await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',estimatedInputTokens:80,maxOutputTokens:50,input:{}})
 const replay=(await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run
 assert.deepEqual(replay.budgetBaseline,{claims:1,input_tokens:80,output_tokens:50})
 await f.call('split',{runId:'m-replay',units:[{unitId:'u'}]})
 const claim=(await f.call('node.claim',{runId:'m-replay',unitId:'u',nodeId:'R',estimatedInputTokens:80,maxOutputTokens:50,input:{}})).result.node
 assert.equal(claim.nodeId,'R')
})
test('旧版第五次重处理因预算耗尽时仅补一次无副作用恢复机会',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{sourceVersion:5}))
 await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 const next=(await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run
 assert.equal(next.sourceVersion,6)
 await f.call('attention',{runId:'m-replay',reason:'recovery_exhausted'})
 await bad(f.call('reprocess',{runId:'m-replay',newRunId:'m-replay-2'}),'MESSAGE_REPROCESS_EXHAUSTED')
})
test('第六版只在S因上下文等待且无业务命令时允许一次确定性状态查询重处理',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{sourceVersion:6}))
 const claim=(await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{}})).result.node
 await f.call('node.complete',{runId:'m',nodeRunId:claim.nodeRunId,leaseEpoch:claim.leaseEpoch,output:{output:{kind:'needs_context',reason:'历史范围',needs:[]}}})
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',reason:'历史范围',request:{requestId:'context',kind:'needs_context',needs:[]}})
 assert.equal((await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run.sourceVersion,7)
 await bad(f.call('reprocess',{runId:'m-replay',newRunId:'m-replay-2'}),'MESSAGE_REPROCESS_EXHAUSTED')
})
test('消息账同库持久化、幂等、全部事项归宿和重启未知命令',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',expectedRevision:0,units:[{unitId:'u'},{unitId:'v'}]})
 const accept={runId:'m',unitId:'u',expectedRevision:0,commands:[{commandId:'c',kind:'query',args:{}}]}
 await f.call('accept',accept,'accept');assert.equal((await f.call('accept',accept,'accept')).replayed,true)
 const claim=await f.call('command.claim',{commandId:'c'});assert.equal(claim.dispatchEligible,true)
 await f.reopen();assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'unknown')
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).run.status,'pending')
})
test('源屏障在任务创建前冻结派发，解开仅对应输入',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('receive',receive('stop',{barriers:[{barrierId:'b',targetSourceKey:'m'}]}))
 await f.call('split',{runId:'m',expectedRevision:0,units:[{unitId:'u'}]});await f.call('accept',{runId:'m',unitId:'u',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{}}]})
 await bad(f.call('command.claim',{commandId:'c'}),'MESSAGE_INPUT_PENDING')
 await f.call('barrier.resolve',{runId:'stop',barrierId:'b',resolution:'query'})
 assert.equal((await f.call('command.claim',{commandId:'c'})).dispatchEligible,true)
})
test('纠正begin立即撤权，旧结果和旧命令都不能继续',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',expectedRevision:0,units:[{unitId:'u'}]})
 const n=(await f.call('node.claim',{runId:'m',unitId:'u',nodeId:'I',expectedRevision:0,input:{}})).result.node
 await f.call('correction.begin',{runId:'m',expectedRevision:0,correctionId:'fix',reason:'wrong'})
 await bad(f.call('node.complete',{runId:'m',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,expectedRevision:0,output:{}}),'MESSAGE_STALE')
 await f.call('correction.publish',{runId:'m',expectedRevision:1,correctionId:'fix',units:[{unitId:'u2'}]})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).units.find(u=>u.id==='u').status,'superseded')
})
test('累计预算跨编辑和重启保留，陈旧编辑不能覆盖',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{maxClaims:1}}))
 await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,input:{}})
 await f.call('receive',receive('m2',{sourceKey:'m',sourceVersion:2,policy:{maxClaims:1}}));await f.reopen()
 await bad(f.call('node.claim',{runId:'m2',unitId:'$',nodeId:'S',expectedRevision:0,input:{}}),'MESSAGE_BUDGET_EXHAUSTED')
 assert.equal((await f.store.query({kind:'message.run',runId:'m2'})).budget.claims,1)
})
test('澄清请求身份、角色和首终态，重复答复不增加窗口',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('wait',{runId:'m',nodeId:'S',request:{requestId:'q',permittedActors:['a']}})
 await bad(f.call('wake',{runId:'m',requestId:'q',actorId:'b',eventId:'e',answer:'yes'}),'MESSAGE_ACTOR_FORBIDDEN')
 const x=await f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'e',answer:'yes'})
 const y=await f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'e2',answer:'no'})
 assert.equal(x.result.run.deadline,y.result.run.deadline);assert.equal(y.result.request.answer,'yes')
})
test('源屏障穿透到业务node领取及效果许可前置检查',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',expectedRevision:0,units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]})
 await f.store.command({id:'new-task',kind:'run.create',args:{runId:'business',taskId:'task',workflowId:'w',workflowDigest:'a'.repeat(64),requirementRef:'sha256/in',nodes:[{nodeId:'n',nodeVersion:'1',executor:'code',inputRef:'sha256/in',inputDigest:'a'.repeat(64)}]}})
 await f.call('receive',receive('stop',{barriers:[{barrierId:'b',targetSourceKey:'m'}]}))
 await bad(f.store.command({id:'claim',kind:'node.claim',args:{runId:'business',nodeId:'n',expectedGeneration:1,expectedLeaseEpoch:0}}),'MESSAGE_INPUT_PENDING')
 await f.call('barrier.resolve',{runId:'stop',barrierId:'b',resolution:'query'})
 assert.equal((await f.store.command({id:'claim',kind:'node.claim',args:{runId:'business',nodeId:'n',expectedGeneration:1,expectedLeaseEpoch:0}})).result.binding.runId,'business')
})
test('消息命令失败保持unknown不能冒充成功，有限历史查询和工作流固定定义',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]});await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{}}]})
 const c=(await f.call('command.claim',{commandId:'c'})).result.command;await f.call('command.fail',{commandId:'c',leaseEpoch:c.leaseEpoch,error:'transport'})
 assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'unknown')
 await bad(f.call('command.claim',{commandId:'c'}),'MESSAGE_COMMAND_NOT_READY')
 assert.equal((await f.store.query({kind:'message.list',conversationId:'g',limit:1})).length,1)
 await bad(f.store.query({kind:'message.list',limit:1000}),'MESSAGE_INVALID_LIMIT')
 const args={workflowId:'w',definitionVersion:'1',config:{provider:'p',model:'m'},digest:'d'}
 await f.store.command({id:'w',kind:'workflow.register',args});assert.deepEqual(await f.store.query({kind:'workflow.list'}),[args])
 await f.store.command({id:'w2',kind:'workflow.register',args:{...args,digest:'d2',config:{provider:'p',model:'new'}}});assert.equal((await f.store.query({kind:'workflow.list'})).length,2)
})

test('单元重关联不影响另一个单元，纠正额度耗尽撤权并待处理',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'},{unitId:'v'}]})
 const n=(await f.call('node.claim',{runId:'m',unitId:'u',nodeId:'R',input:{}})).result.node
 await f.call('relink',{runId:'m',unitId:'u',expectedRevision:0,reason:'different target'})
 await bad(f.call('node.complete',{runId:'m',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,output:{}}),'MESSAGE_NODE_STALE')
 await f.call('accept',{runId:'m',unitId:'v',expectedRevision:0,commands:[],outcome:'ignored'})
 await f.call('relink',{runId:'m',unitId:'u',expectedRevision:0,reason:'again'})
 await bad(f.call('node.claim',{runId:'m',unitId:'u',nodeId:'R',input:{}}),'MESSAGE_NEEDS_ATTENTION')
})
test('无回执只读状态查询的参数错误仅可受控重试一次，创建命令不可重试',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'status',kind:'status',args:{}}]})
 const first=(await f.call('command.claim',{commandId:'status'})).result.command
 await f.call('command.fail',{commandId:'status',leaseEpoch:first.leaseEpoch,error:'INVALID_ARGUMENT'})
 await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 await f.call('command.retry.readonly',{commandId:'status'})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).run.status,'pending')
 const next=(await f.call('command.claim',{commandId:'status'})).result.command
 assert.equal(next.leaseEpoch,first.leaseEpoch+1)
 await f.call('command.fail',{commandId:'status',leaseEpoch:next.leaseEpoch,error:'INVALID_ARGUMENT'})
 await bad(f.call('command.retry.readonly',{commandId:'status'}),'MESSAGE_READONLY_RETRY_FORBIDDEN')
 await f.call('receive',receive('create'));await f.call('split',{runId:'create',units:[{unitId:'create-unit'}]})
 await f.call('accept',{runId:'create',unitId:'create-unit',commands:[{commandId:'new-task',kind:'create',args:{}}]})
 const creation=(await f.call('command.claim',{commandId:'new-task'})).result.command
 await f.call('command.fail',{commandId:'new-task',leaseEpoch:creation.leaseEpoch,error:'INVALID_ARGUMENT'})
 await bad(f.call('command.retry.readonly',{commandId:'new-task'}),'MESSAGE_READONLY_RETRY_FORBIDDEN')
})
test('token預留在失败与重启后不清零，未知usage保守计费',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{maxInputTokens:100,maxOutputTokens:100}}))
 const n=(await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:80,maxOutputTokens:50})).result.node
 await f.call('node.fail',{runId:'m',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,error:'network'})
 await f.reopen();await bad(f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:80,maxOutputTokens:50}),'MESSAGE_BUDGET_EXHAUSTED')
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).budget.input_tokens,80)
})
test('切换水位后的消息缓冲，激活原子解缓冲，abort不双发',async t=>{
 const f=await fixture(t)
 await f.call('group.begin',{conversationId:'g',expectedEpoch:0,legacySealRef:'sha256/seal'})
 await f.call('receive',receive());assert.equal((await f.store.query({kind:'message.run',runId:'m'})).run.status,'buffered')
 await bad(f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{}}),'MESSAGE_ENGINE_NOT_ACTIVE')
 await f.call('group.activate',{conversationId:'g',expectedEpoch:0,legacySealRef:'sha256/seal'})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).run.status,'pending')
 await f.call('group.begin',{conversationId:'g',expectedEpoch:1,legacySealRef:'sha256/seal2'})
 await bad(f.call('group.activate',{conversationId:'g',expectedEpoch:1,legacySealRef:'sha256/seal2'}),'MESSAGE_GROUP_NOT_DRAINED')
 await f.call('receive',receive('m2'));await f.call('group.abort',{conversationId:'g',expectedEpoch:1})
 assert.equal((await f.store.query({kind:'message.run',runId:'m2'})).run.status,'buffered')
})
test('通知ACK和读回分离，发送中崩溃进入unknown，禁止盲重发',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]});await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]})
 const c=(await f.call('command.claim',{commandId:'c'})).result.command;await f.call('command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:{text:'done'}})
 await f.call('notification.prepare',{runId:'m',notificationId:'n',commandId:'c',payload:{text:'done'},disclosure:{conversationId:'g',authorizationRef:'same-group'}})
 const n=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 await f.reopen();await bad(f.call('notification.claim',{notificationId:'n'}),'MESSAGE_NOTIFICATION_NOT_READY')
 assert.equal((await f.store.query({kind:'message.notifications'}))[0].status,'unknown')
 await f.call('notification.readback',{notificationId:'n',leaseEpoch:n.leaseEpoch,evidence:{messageId:'out-1',text:'done'}})
 assert.equal((await f.store.query({kind:'message.notifications'})).length,0)
})
test('重拆保留严格相同已执行事项，不重复消费业务命令',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u',goal:'read'},{unitId:'v',goal:'write'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]});const c=(await f.call('command.claim',{commandId:'c'})).result.command;await f.call('command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:{}})
 await f.call('correction.begin',{runId:'m',expectedRevision:0,correctionId:'fix',unitIds:['v'],reason:'split wrong'})
 await f.call('correction.publish',{runId:'m',expectedRevision:1,correctionId:'fix',units:[{unitId:'u',goal:'read',preservedUnitId:'u'},{unitId:'v2',goal:'changed'}]})
 const s=await f.store.query({kind:'message.run',runId:'m'});assert.equal(s.units.find(u=>u.id==='u').status,'applied');assert.equal(s.commands[0].status,'applied');assert.equal(s.commands.length,1)
})
test('在途命令撤权后的迟到完成不能覆盖unknown，超额恢复持久待处理',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]});await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{}}]})
 const c=(await f.call('command.claim',{commandId:'c'})).result.command
 await f.call('correction.begin',{runId:'m',correctionId:'correction',reason:'bad target'})
 await bad(f.call('command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:{}}),'MESSAGE_COMMAND_STALE')
 assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'unknown')
 await f.call('recover',{runId:'m'});await f.call('recover',{runId:'m'});assert.equal((await f.call('recover',{runId:'m'})).result.run.status,'needs_attention')
})

test('已解决澄清的冲突无权答复仍拒绝，不能读取终态后绕过actor检查',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('wait',{runId:'m',nodeId:'S',request:{requestId:'q',permittedActors:['a']}})
 await f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'e',answer:'secret answer'})
 await bad(f.call('wake',{runId:'m',requestId:'q',actorId:'outsider',eventId:'e2',answer:'no'}),'MESSAGE_ACTOR_FORBIDDEN')
})
test('消息历史有界游标分页不遗漏更早来源',async t=>{
 const f=await fixture(t);for(let i=0;i<5;i++)await f.call('receive',receive('m'+i))
 const first=await f.store.query({kind:'message.list',limit:2}),second=await f.store.query({kind:'message.list',limit:2,beforeSequenceId:first.at(-1).sequenceId}),third=await f.store.query({kind:'message.list',limit:2,beforeSequenceId:second.at(-1).sequenceId})
 assert.deepEqual([...first,...second,...third].map(r=>r.runId),['m4','m3','m2','m1','m0'])
})
test('Task未创建时引用撤销/修订直接作用源命令，不创建旧需求Task',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]});await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{taskId:'task',arguments:{objective:'old'}}}]})
 await f.call('receive',receive('control',{barriers:[{barrierId:'b',targetSourceKey:'m'}]}))
 const args={taskId:'task',actorId:'a',sourceRunId:'control'}
 await f.call('task.control',{...args,action:'revise',arguments:{objective:'new'}})
 assert.equal((await f.store.query({kind:'message.task',taskId:'task'})).command.args.arguments.objective,'new')
 await f.call('task.control',{...args,action:'pause'});await bad(f.call('command.claim',{commandId:'c'}),'MESSAGE_COMMAND_NOT_READY')
 await f.call('task.control',{...args,action:'resume'});await f.call('task.control',{...args,action:'cancel'})
 assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'cancelled')
 assert.deepEqual(await f.store.query({kind:'run.list'}),[])
 await bad(f.call('task.control',{...args,action:'resume'}),'MESSAGE_TASK_ALREADY_DISPATCHED')
})
test('澄清通知经真实回读绑定请求，已答请求禁止再派发且重复引用可定位终态',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('wait',{runId:'m',nodeId:'S',request:{requestId:'q',kind:'needs_clarification',permittedActors:['a'],question:'which'}})
 const args={runId:'m',notificationId:'n',requestId:'q',payload:{text:'which'},disclosure:{conversationId:'g',authorizationRef:'same-group'}}
 await f.call('notification.prepare',args);const n=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 await f.call('notification.sent',{notificationId:'n',leaseEpoch:n.leaseEpoch,ack:{messageId:'out'}})
 await f.call('notification.readback',{notificationId:'n',leaseEpoch:n.leaseEpoch,evidence:{messageId:'out'}})
 await f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'reply',answer:'first'})
 const located=await f.store.query({kind:'message.requestByReply',conversationId:'g',messageId:'out'});assert.equal(located.request.status,'resolved');assert.equal(located.run.runId,'m')
 assert.equal(await f.store.query({kind:'message.requestByReply',conversationId:'another',messageId:'out'}),null)
})
test('settled但屏障未释放的崩溃检查点仍进入恢复；编辑原子转移所有旧屏障',async t=>{
 const f=await fixture(t);await f.call('receive',receive('A'));await f.call('receive',receive('B',{barriers:[{barrierId:'b',targetSourceKey:'A'}]}));await f.call('split',{runId:'B',units:[{unitId:'u'}]});await f.call('accept',{runId:'B',unitId:'u',commands:[],outcome:'ignored'})
 await f.reopen();assert.ok((await f.store.query({kind:'message.pending'})).some(r=>r.runId==='B'))
 await f.call('receive',receive('B2',{sourceKey:'B',sourceVersion:2}))
 const old=await f.store.query({kind:'message.run',runId:'B'}),next=await f.store.query({kind:'message.run',runId:'B2'})
 assert.equal(old.barriers.length,0);assert.ok(next.barriers.some(b=>b.id==='b'&&b.ownerRunId==='B2'&&b.targetSourceKey==='A'&&b.previousOwnerRunId==='B'))
 await f.call('barrier.resolve',{runId:'B2',barrierId:'b',resolution:'new-version-control-applied'})
})
test('不可变材料首次落账后复用，TOCTOU正文变化与超限拒绝',async t=>{
 const f=await fixture(t);await f.call('receive',receive());const args={runId:'m',resourceRef:'attachment',material:{text:'original',sourceVersion:1}}
 await f.call('material.record',args);await f.call('material.record',args)
 assert.deepEqual(await f.store.query({kind:'message.material',runId:'m',resourceRef:'attachment'}),args.material)
 await bad(f.call('material.record',{...args,material:{text:'changed',sourceVersion:1}}),'MESSAGE_MATERIAL_CONFLICT')
 await bad(f.call('material.record',{...args,resourceRef:'large',material:{text:'中'.repeat(30000)}}),'MESSAGE_MATERIAL_INVALID')
})
test('话题归属和命令同事务接纳，跨群证据或归属冲突整次回滚',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'},{unitId:'v'}]})
 const topic={topicId:'topic',conversationId:'g',sourceRunId:'m',unitId:'u',title:'topic',facts:[{kind:'constraint',text:'do this',sourceRefs:[{sourceKey:'m',sourceVersion:1,text:'do this'}]}]}
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}],topic})
 const result=await f.store.query({kind:'message.topic',topicId:'topic'});assert.equal(result.facts[0].actorId,'a');assert.equal((await f.store.query({kind:'message.topic.source',sourceKey:'m'}))[0].topicId,'topic')
 assert.deepEqual((await f.store.query({kind:'message.topic.bindings',conversationId:'g'})).map(item=>({sourceKey:item.sourceKey,topicId:item.topic.topicId})),[{sourceKey:'m',topicId:'topic'}])
 const badTopic={...topic,unitId:'v',conversationId:'another'}
 await bad(f.call('accept',{runId:'m',unitId:'v',commands:[{commandId:'bad',kind:'create',args:{}}],topic:badTopic}),'MESSAGE_TOPIC_SCOPE_MISMATCH')
 const state=await f.store.query({kind:'message.run',runId:'m'});assert.equal(state.commands.length,1);assert.equal(state.units.find(u=>u.id==='v').status,'pending');assert.equal(state.units.find(u=>u.id==='u').topicId,'topic')
})

test('源编辑取消未启动命令零Task；修订暂停命令不默认恢复',async t=>{
 const f=await fixture(t)
 for(const suffix of ['cancel','revise']){
 const source='source-'+suffix,original='original-'+suffix,unit='unit-'+suffix,command='command-'+suffix,task='task-'+suffix
 await f.call('receive',receive(original,{sourceKey:source}));await f.call('split',{runId:original,expectedRevision:0,units:[{unitId:unit}]});await f.call('accept',{runId:original,unitId:unit,expectedRevision:0,commands:[{commandId:command,kind:'create',args:{taskId:task,arguments:{objective:'old'}}}]})
 if(suffix==='revise')await f.call('task.control',{taskId:task,action:'pause',actorId:'a',sourceRunId:original})
 const edit='edit-'+suffix;await f.call('receive',receive(edit,{sourceKey:source,sourceVersion:2,body:'changed'}))
 const result=await f.call('task.control',{taskId:task,action:suffix,actorId:'a',sourceRunId:edit,...(suffix==='revise'?{arguments:{objective:'new'}}:{})})
 assert.equal(result.result.command.status,suffix==='cancel'?'cancelled':'paused')
 if(suffix==='revise'){assert.equal(result.result.command.args.arguments.objective,'new');assert.equal(result.result.command.args.sourceInputRunId,edit)}
 }
 assert.deepEqual(await f.store.query({kind:'run.list'}),[])
})
