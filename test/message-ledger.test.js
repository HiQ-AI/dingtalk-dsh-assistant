import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { reduceMessageCommand } from '../packages/dingtalk-dsh-assistant/message-ledger.js'
import { executeNotificationOperation } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'message-ledger-'));const options={dbPath:join(dir,'control.sqlite'),instanceId:randomUUID()}
 let store=await openExecutionStore({...options,initialize:true})
 t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
 return {get store(){return store},call:(kind,args,id=randomUUID())=>store.command({id,kind:'message.'+kind,args:kind==='node.claim'?{leaseWindowMs:60500,...args}:args}),reopen:async()=>{await store.close();store=await openExecutionStore(options)},
  resumeInNewProcess:async args=>{await store.close();const script=join(dir,'resume.mjs');await writeFile(script,`import {openExecutionStore} from ${JSON.stringify(new URL('../packages/dingtalk-dsh-assistant/execution-store.js',import.meta.url).href)};const store=await openExecutionStore(${JSON.stringify(options)});try{await store.command({id:'resume',kind:'runtime.maintenance.resume',args:${JSON.stringify(args)}})}finally{await store.close()}`);const child=spawnSync(process.execPath,[script],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);store=await openExecutionStore(options)},
  editSnapshot:async edit=>{await store.close();const offline=new DatabaseSync(options.dbPath);try{edit(offline)}finally{offline.close()};store=await openExecutionStore(options)}}
}
const receive=(runId='m',extra={})=>({runId,sourceKey:runId,sourceVersion:1,conversationId:'g',actorId:'a',body:'do this',...extra})
const bad=(p,code)=>assert.rejects(p,e=>e.code===code)

async function echoFixture(t, { acknowledgedOnly = false, evidenceGroup = 'g', barrier = false } = {}) {
 const f=await fixture(t)
 await f.call('receive',receive('outbound'));await f.call('split',{runId:'outbound',units:[{unitId:'out-unit'}]})
 await f.call('accept',{runId:'outbound',unitId:'out-unit',commands:[{commandId:'out-command',kind:'answer',args:{}}]})
 const claim=(await f.call('command.claim',{commandId:'out-command'})).result.command
 await f.call('command.complete',{commandId:'out-command',leaseEpoch:claim.leaseEpoch,result:{reply:'已收到'}})
 await f.call('notification.prepare',{runId:'outbound',notificationId:'out-notice',commandId:'out-command',payload:{text:'已收到',conversationId:'g',sourceMessageId:'source-original'},disclosure:{conversationId:'g',authorizationRef:'outbound'}})
 const notice=(await f.call('notification.claim',{notificationId:'out-notice'})).result.notification
 await f.call('notification.sent',{notificationId:'out-notice',leaseEpoch:notice.leaseEpoch,ack:{messageId:'out-1'}})
 if(!acknowledgedOnly)await f.call('notification.readback',{notificationId:'out-notice',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'out-1',conversationId:evidenceGroup}})
 await f.call('receive',receive('echo',{context:{sourceMessageId:'out-1',...(barrier==='matching'?{quoteRefs:[{sourceKey:'outbound',messageId:'source-original'}]}:{})},policy:{initialWindowMs:45000},
  ...(barrier?{barriers:[{barrierId:barrier==='matching'?`fence-${executionDigest(['echo',1,'outbound'])}`:'edit-fence',targetSourceKey:'outbound'}]}:{})}))
 const node=(await f.call('node.claim',{runId:'echo',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:20,maxOutputTokens:10})).result.node
 return {...f,node, get store(){return f.store}}
}

test('回声隔离同步封存模型节点，迟到成功和失败均不得恢复节点或退还累计预算', async t => {
 const f=await echoFixture(t), before=await f.store.query({kind:'message.run',runId:'echo'})
 const result=await f.call('echo.quarantine',{runId:'echo'},'echo-original-quarantine')
 assert.deepEqual(result.result.nodeRunIds,[f.node.nodeRunId])
 const after=await f.store.query({kind:'message.run',runId:'echo'})
 assert.equal(after.run.status,'superseded');assert.equal(after.run.reason,'outbound_echo')
 assert.equal(after.nodes[0].status,'superseded');assert.equal(after.nodes[0].priorStatus,'running')
 assert.ok(after.nodes[0].completedAt);assert.equal(after.nodes[0].reason,'outbound_echo')
 assert.deepEqual(after.budget,before.budget)
 for(const kind of ['node.complete','node.fail']) await bad(f.call(kind,{runId:'echo',nodeRunId:f.node.nodeRunId,leaseEpoch:f.node.leaseEpoch,output:{},error:'late'}),'MESSAGE_STALE')
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).busy.messages,0)
})

for(const invalid of ['ack-only','foreign-proof','command','notice','barrier'])test(`回声隔离拒绝 ${invalid}，不吞业务命令或发送效果`,async t=>{
 const f=await echoFixture(t,{acknowledgedOnly:invalid==='ack-only',evidenceGroup:invalid==='foreign-proof'?'other':'g',barrier:invalid==='barrier'})
 if(invalid==='command'){
  await f.call('split',{runId:'echo',units:[{unitId:'echo-unit'}]})
  await f.call('accept',{runId:'echo',unitId:'echo-unit',commands:[{commandId:'echo-command',kind:'create',args:{taskId:'business'}}]})
 }
 if(invalid==='notice'){
  await f.call('wait',{runId:'echo',unitId:'$',nodeId:'S',expectedRevision:0,reason:'clarify',request:{requestId:'echo-request',kind:'needs_clarification',question:'请确认',permittedActors:['a']}})
  await f.call('notification.prepare',{runId:'echo',notificationId:'echo-notice',requestId:'echo-request',payload:{text:'已外发候选',conversationId:'g'},disclosure:{conversationId:'g',authorizationRef:'echo'}})
 }
 await bad(f.call('echo.quarantine',{runId:'echo'}),'MESSAGE_ECHO_QUARANTINE_FORBIDDEN')
 assert.notEqual((await f.store.query({kind:'message.run',runId:'echo'})).run.status,'superseded')
 await bad(f.call('echo.reconcile',{runId:'echo',expectedDigest:'invented'}),'MESSAGE_ECHO_NOT_QUARANTINED')
})

async function reopenLegacyEcho(f, mutate = () => {}) {
 await f.call('echo.quarantine',{runId:'echo'},'echo-original-quarantine')
 // 仅在已关闭的一次性测试库恢复旧版本遗留形状；生产修复必须走原生命令。
 await f.editSnapshot(db=>{
  const body=JSON.parse(db.prepare("SELECT body FROM message_items WHERE item_id=?").get(`node:${f.node.nodeRunId}`).body)
  body.status='running';delete body.priorStatus;delete body.reason;delete body.completedAt
  db.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(JSON.stringify(body),`node:${f.node.nodeRunId}`)
  for(const row of db.prepare("SELECT item_id,body FROM message_items WHERE run_id='echo' AND kind='barrier'").all()){
   const barrier=JSON.parse(row.body);barrier.status='pending';delete barrier.resolution;delete barrier.resolvedAt
   db.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(JSON.stringify(barrier),row.item_id)
  }
  mutate(db)
 })
}

test('旧封存回声以精确证明 CAS 原生修复，旧 quarantine receipt 不掩盖遗留节点',async t=>{
 const f=await echoFixture(t);await reopenLegacyEcho(f)
 assert.equal((await f.store.query({kind:'message.run',runId:'echo'})).nodes[0].error,'process_interrupted')
 await f.call('echo.quarantine',{runId:'echo'},'echo-original-quarantine')
 assert.equal((await f.store.query({kind:'message.run',runId:'echo'})).nodes[0].status,'failed')
 const check=await f.store.query({kind:'message.echo.reconciliation',runId:'echo'})
 assert.equal(check.eligible,true);assert.equal(check.alreadyReconciled,false);assert.equal(check.notificationId,'out-notice')
 await bad(f.call('echo.reconcile',{runId:'echo',expectedDigest:'stale'}),'MESSAGE_ECHO_RECONCILE_STALE')
 const args={runId:'echo',expectedDigest:check.expectedDigest},id=`echo-reconcile:echo:${check.expectedDigest}`
 const repaired=await f.call('echo.reconcile',args,id), repeated=await f.call('echo.reconcile',args,id)
 assert.equal(repaired.result.status,'reconciled');assert.deepEqual(repaired.result.nodeRunIds,[f.node.nodeRunId])
 assert.equal(repeated.replayed,true);assert.deepEqual(repeated.result,repaired.result)
 await bad(f.call('echo.reconcile',args),'MESSAGE_ECHO_RECONCILE_STALE')
 const after=await f.store.query({kind:'message.echo.reconciliation',runId:'echo'})
 assert.equal(after.alreadyReconciled,true)
 assert.equal((await f.call('echo.reconcile',{runId:'echo',expectedDigest:after.expectedDigest})).result.status,'already-reconciled')
 assert.deepEqual(await f.store.query({kind:'message.echo.unreconciled'}),[])
})

test('恢复扫描包含已 superseded 的旧回声，跨重启仅收口原节点且不调用模型',async t=>{
 const f=await echoFixture(t);await reopenLegacyEcho(f)
 assert.equal((await f.store.query({kind:'message.pending'})).some(run=>run.runId==='echo'),false)
 assert.equal((await f.store.query({kind:'message.echo.unreconciled'})).length,1)
 for(let pass=0;pass<2;pass++)for(const item of await f.store.query({kind:'message.echo.unreconciled'})){const proof=await f.store.query({kind:'message.echo.reconciliation',runId:item.runId});await f.call('echo.reconcile',{runId:item.runId,expectedDigest:proof.expectedDigest})}
 const state=await f.store.query({kind:'message.run',runId:'echo'})
 assert.equal(state.run.status,'superseded');assert.equal(state.nodes[0].status,'superseded')
 assert.equal(state.nodes[0].priorStatus,'failed');assert.equal(state.commands.length,0)
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).busy.messages,0)
})

for(const barrierOnly of [false,true])test(`旧回声${barrierOnly?'仅遗留屏障':'同时遗留节点和屏障'}原生释放自身引用 fence，被引用来源不变`,async t=>{
 const f=await echoFixture(t,{barrier:'matching'}),source=await f.store.query({kind:'message.run',runId:'outbound'})
 await reopenLegacyEcho(f,db=>{
  if(barrierOnly)db.prepare("UPDATE message_items SET body=json_set(body,'$.status','superseded') WHERE item_id=?").run(`node:${f.node.nodeRunId}`)
 })
 const check=await f.store.query({kind:'message.echo.reconciliation',runId:'echo'})
 assert.equal(check.eligible,true);assert.equal(check.alreadyReconciled,false)
 assert.equal(check.nodeRunIds.length,barrierOnly?0:1);assert.equal(check.barrierIds.length,1)
 assert.equal((await f.store.query({kind:'message.echo.unreconciled'})).length,1)
 const repaired=await f.call('echo.reconcile',{runId:'echo',expectedDigest:check.expectedDigest})
 assert.deepEqual(repaired.result.barrierIds,check.barrierIds)
 const after=await f.store.query({kind:'message.run',runId:'echo'})
 assert.equal(after.barriers[0].status,'resolved');assert.equal(after.barriers[0].resolution,'outbound_echo')
 assert.equal(after.run.status,'superseded');assert.equal(after.run.reason,'outbound_echo')
 assert.deepEqual(await f.store.query({kind:'message.run',runId:'outbound'}),source)
 assert.equal((await f.store.query({kind:'message.echo.reconciliation',runId:'echo'})).alreadyReconciled,true)
})

for(const invalid of ['other-owner','target-task','missing-quote','different-source'])test(`旧回声拒绝不匹配屏障 ${invalid}，不修改被引用来源`,async t=>{
 const f=await echoFixture(t,{barrier:'matching'})
 await reopenLegacyEcho(f,db=>{
  if(invalid==='missing-quote')db.prepare("UPDATE message_runs SET body=json_set(body,'$.context.quoteRefs',json('[]')) WHERE run_id='echo'").run()
  else {
   const field=invalid==='other-owner'?'ownerRunId':invalid==='target-task'?'targetTaskId':'targetSourceKey'
   db.prepare(`UPDATE message_items SET body=json_set(body,'$.${field}','foreign') WHERE run_id='echo' AND kind='barrier'`).run()
  }
 })
 const before=await f.store.query({kind:'message.run',runId:'echo'}),check=await f.store.query({kind:'message.echo.reconciliation',runId:'echo'})
 assert.equal(check.eligible,false);assert.equal(check.reason,'MESSAGE_ECHO_BARRIER_MISMATCH')
 await bad(f.call('echo.reconcile',{runId:'echo',expectedDigest:'forged'}),'MESSAGE_ECHO_BARRIER_MISMATCH')
 assert.deepEqual(await f.store.query({kind:'message.run',runId:'echo'}),before)
})

test('历史 answer 任务仍可回读来源，新普通答复不进入任务候选', async t => {
 const f=await fixture(t)
 for (const [runId,taskId] of [['old','historical-task'],['reply',null]]) {
  await f.call('receive',receive(runId))
  await f.call('split',{runId,units:[{unitId:`${runId}-unit`}]})
  await f.call('accept',{runId,unitId:`${runId}-unit`,commands:[{commandId:`${runId}-command`,kind:'answer',args:{taskId,arguments:taskId?{objective:'旧答复任务'}:{text:'已收到'}}}]})
  const claimed=await f.call('command.claim',{commandId:`${runId}-command`})
  await f.call('command.complete',{commandId:`${runId}-command`,leaseEpoch:claimed.result.command.leaseEpoch,result:taskId?{taskId}:{status:'answered',reply:'已收到'}})
 }
 assert.equal((await f.store.query({kind:'message.task',taskId:'historical-task'})).command.kind,'answer')
 assert.equal((await f.store.query({kind:'message.task.latest',taskId:'historical-task'})).run.runId,'old')
 assert.deepEqual((await f.store.query({kind:'message.task-candidates',conversationId:'g'})).map(item=>item.command.args.taskId),['historical-task'])
})
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
test('错误澄清命令经证据确认无效果并撤销后可重处理，有效果命令仍拒绝',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m'))
 await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'clarification',args:{}}]})
 const claim=await f.call('command.claim',{commandId:'c'})
 await f.call('command.fail',{commandId:'c',leaseEpoch:claim.result.command.leaseEpoch,error:'WORKFLOW_CLARIFICATION_NOT_FOUND'})
 await bad(f.call('reprocess',{runId:'m',newRunId:'early'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 await f.call('command.reconcile',{commandId:'c',status:'failed',evidenceRef:'sha256-evidence.json'})
 await f.call('relink',{runId:'m',unitId:'u',expectedRevision:0,reason:'错误指代'})
 assert.equal((await f.call('reprocess',{runId:'m',newRunId:'safe-replay'})).result.run.sourceVersion,2)
})
test('无效果的忽略意图可仅重判 IB，保留话题和来源版本',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m'));await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('topic.bind',{runId:'m',unitId:'u',expectedRevision:0,binding:{kind:'binding',disposition:'new',candidateId:null},topic:{topicId:'topic',conversationId:'g',sourceRunId:'m',unitId:'u',title:'账号排查',facts:[{kind:'fact',text:'do this',sourceRefs:[{sourceKey:'m',sourceVersion:1,text:'do this'}]}]}})
 await f.call('topic.intent.accept',{runId:'m',topicId:'topic',conversationId:'g',inputRevision:1,decisions:[{unitId:'u',expectedRevision:0,commands:[],outcome:'ignored'}]})
 const retry=await f.call('topic.intent.retry',{runId:'m',unitId:'u',expectedRevision:0})
 assert.equal(retry.result.topic.inputRevision,2)
 assert.equal(retry.result.unit.status,'pending')
 assert.equal(retry.result.run.intentStatus,'intent_rejudging')
 assert.equal((await f.store.query({kind:'message.source',sourceKey:'m'})).sourceVersion,1)
 await f.call('wait',{runId:'m',unitId:'u',nodeId:'IB',expectedRevision:0,reason:'missing material',request:{requestId:'q',kind:'needs_context',needs:[]}})
 const second=await f.call('topic.intent.retry',{runId:'m',unitId:'u',expectedRevision:0})
 assert.equal(second.result.topic.inputRevision,3)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).requests.find(item=>item.id==='q').status,'superseded')
})
test('同话题补充到达时已执行动作保留，剩余待派发动作重新进入意图判断',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('m'))
 await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 const binding={kind:'binding',disposition:'new',candidateId:null}
 await f.call('topic.bind',{runId:'m',unitId:'u',expectedRevision:0,binding,topic:{topicId:'topic',conversationId:'g',sourceRunId:'m',unitId:'u',title:'事项',facts:[]}})
 await f.call('topic.intent.accept',{runId:'m',topicId:'topic',conversationId:'g',inputRevision:1,decisions:[{unitId:'u',expectedRevision:0,commands:[{commandId:'c1',kind:'status',args:{arguments:{scope:'task'}}},{commandId:'c2',kind:'result',args:{arguments:{scope:'task'}}}]}]})
 const claim=await f.call('command.claim',{commandId:'c1'})
 await f.call('command.complete',{commandId:'c1',leaseEpoch:claim.result.command.leaseEpoch,result:{ok:true}})
 await f.call('receive',receive('m2'))
 await f.call('split',{runId:'m2',units:[{unitId:'u2'}]})
 await f.call('topic.bind',{runId:'m2',unitId:'u2',expectedRevision:0,binding,topic:{topicId:'topic',conversationId:'g',sourceRunId:'m2',unitId:'u2',title:'事项',facts:[]}})
 await f.call('topic.refresh',{runId:'m',topicId:'topic',inputRevision:2})
 const old=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(old.commands.find(c=>c.id==='c1').status,'applied')
 assert.equal(old.commands.find(c=>c.id==='c2').status,'superseded')
 assert.equal(old.commands.find(c=>c.id==='c2').priorStatus,'pending')
 assert.equal(old.units[0].status,'pending')
 assert.deepEqual((await f.store.query({kind:'message.topic.units',topicId:'topic'})).map(item=>item.unit.id),['u','u2'])
 await bad(f.call('topic.intent.accept',{runId:'m',topicId:'topic',conversationId:'g',inputRevision:2,decisions:[{unitId:'u',expectedRevision:0,commands:[],outcome:'applied'},{unitId:'u2',expectedRevision:0,commands:[],outcome:'ignored'}]}),'MESSAGE_OUTSTANDING_ACTION_UNRESOLVED')
 await f.call('topic.intent.accept',{runId:'m',topicId:'topic',conversationId:'g',inputRevision:2,decisions:[{unitId:'u',expectedRevision:0,commands:[{commandId:'c2-rejudged',kind:'result',args:{arguments:{scope:'task'}}}]},{unitId:'u2',expectedRevision:0,commands:[],outcome:'ignored'}]})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).commands.find(c=>c.id==='c2-rejudged').status,'pending')
})
test('来源编辑使旧话题约束失效且保留审计事实',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('m',{sourceKey:'source',body:'只用中文'}))
 await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('topic.bind',{runId:'m',unitId:'u',expectedRevision:0,binding:{kind:'binding',disposition:'new',candidateId:null},topic:{topicId:'topic',conversationId:'g',sourceRunId:'m',unitId:'u',title:'语言',facts:[{kind:'constraint',text:'只用中文',sourceRefs:[{sourceKey:'source',sourceVersion:1,text:'只用中文'}]}]}})
 await f.call('receive',receive('edit',{sourceKey:'source',sourceVersion:2,body:'改用英文'}))
 const topic=await f.store.query({kind:'message.topic',topicId:'topic'})
 assert.deepEqual(topic.facts,[])
 const history=await f.store.query({kind:'message.topic.facts',topicId:'topic',status:'invalidated'})
 assert.equal(history.facts[0].text,'只用中文')
 assert.equal(history.facts[0].status,'invalidated')
 assert.ok(history.facts[0].invalidatedAt)
 assert.equal(history.contextRevision,3)
})
test('一千条话题事实跨重启分页完整，同来源跨话题事实互不混入',async t=>{
 const f=await fixture(t),texts=Array.from({length:1000},(_,i)=>`条件${i}`)
 await f.call('receive',receive('many',{body:texts.join('、')}))
 await f.call('split',{runId:'many',units:[{unitId:'many-unit'},{unitId:'other-unit'}]})
 for(let start=0;start<texts.length;start+=30){
  const facts=texts.slice(start,start+30).map(text=>({kind:'constraint',text,sourceRefs:[{sourceKey:'many',sourceVersion:1,text}]}))
  await f.call('topic.upsert',{topicId:'many-topic',conversationId:'g',sourceRunId:'many',unitId:'many-unit',title:'条件',facts})
 }
 const topic=await f.store.query({kind:'message.topic',topicId:'many-topic'})
 assert.equal(topic.facts.length,256);assert.equal(topic.hasMoreFacts,true);assert.equal(topic.contextRevision,1001)
 await bad(f.call('topic.intent.accept',{runId:'many',topicId:'many-topic',conversationId:'g',inputRevision:topic.inputRevision,contextRevision:1000,decisions:[]}), 'MESSAGE_TOPIC_CONTEXT_STALE')
 const sharedFact={kind:'constraint',text:texts[0],sourceRefs:[{sourceKey:'many',sourceVersion:1,text:texts[0]}]}
 await f.call('topic.upsert',{topicId:'other-topic',conversationId:'g',sourceRunId:'many',unitId:'other-unit',title:'其他',facts:[sharedFact]})
 let cursor=0,all=[]
 do {const page=await f.store.query({kind:'message.topic.facts',topicId:'many-topic',cursor,limit:37});all.push(...page.facts);cursor=page.nextCursor;assert.equal(page.total,1000)} while(cursor)
 assert.equal(all.length,1000);assert.equal(new Set(all.map(fact=>fact.id)).size,1000)
 assert.deepEqual(all.map(fact=>fact.text),texts)
 const other=await f.store.query({kind:'message.topic.facts',topicId:'other-topic',status:'all'})
 assert.equal(other.total,1);assert.deepEqual(other.facts.map(fact=>fact.text),[texts[0]])
 assert.equal(other.nextCursor,null)
 await f.reopen()
 assert.equal((await f.store.query({kind:'message.topic.facts',topicId:'many-topic',cursor:0,limit:1})).total,1000)
 assert.equal((await f.store.query({kind:'message.topic.facts',topicId:'other-topic',cursor:0,limit:1})).total,1)
})
test('已认证同任务控制可越过无关归类等待，普通动作与其他发送者不可越权',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('origin'))
 await f.call('split',{runId:'origin',units:[{unitId:'origin-unit'}]})
 const owned={kind:'binding',disposition:'existing',candidateId:'task',taskId:'task'}
 await f.call('topic.bind',{runId:'origin',unitId:'origin-unit',expectedRevision:0,binding:owned,topic:{topicId:'topic',conversationId:'g',sourceRunId:'origin',unitId:'origin-unit',title:'任务',facts:[]}})
 await f.call('topic.intent.accept',{runId:'origin',topicId:'topic',conversationId:'g',inputRevision:1,decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'create-task',kind:'create',args:{taskId:'task'}}]}]})
 const created=await f.call('command.claim',{commandId:'create-task'})
 await f.call('command.complete',{commandId:'create-task',leaseEpoch:created.result.command.leaseEpoch,result:{taskId:'task'}})
 await f.call('receive',receive('unrelated'))
 await f.call('receive',receive('control',{body:'暂停任务 task'}))
 await f.call('split',{runId:'control',units:[{unitId:'control-unit'}]})
 await f.call('topic.bind',{runId:'control',unitId:'control-unit',expectedRevision:0,binding:owned,topic:{topicId:'topic',conversationId:'g',sourceRunId:'control',unitId:'control-unit',title:'任务',facts:[]}})
 const controls=[{unitId:'control-unit',taskId:'task',action:'pause'}]
 assert.equal((await f.call('topic.refresh',{runId:'control',topicId:'topic',inputRevision:2})).result.status,'WAIT_ROUTING')
 assert.equal((await f.call('topic.refresh',{runId:'control',topicId:'topic',inputRevision:2,priorityControls:controls})).result.status,'ready')
 const badDecision={unitId:'control-unit',expectedRevision:0,commands:[{commandId:'other-action',kind:'status',args:{taskId:'task'}}]}
 assert.equal((await f.call('topic.intent.accept',{runId:'control',topicId:'topic',conversationId:'g',inputRevision:2,priorityControls:controls,decisions:[badDecision]})).result.status,'WAIT_ROUTING')
 assert.deepEqual((await f.store.query({kind:'message.topic.units',topicId:'topic'})).map(item=>item.unit.id),['control-unit'])
 assert.equal((await f.store.query({kind:'message.task',taskId:'task'})).run.actorId,'a')
 const accepted=await f.call('topic.intent.accept',{runId:'control',topicId:'topic',conversationId:'g',inputRevision:2,priorityControls:controls,decisions:[{unitId:'control-unit',expectedRevision:0,commands:[{commandId:'pause-task',kind:'pause',args:{taskId:'task'}}]}]})
 assert.equal(accepted.result.status,'accepted')
 assert.equal((await f.call('command.claim',{commandId:'pause-task'})).dispatchEligible,true)
 await f.call('receive',receive('unauthorized',{actorId:'b',body:'取消任务 task'}))
 await f.call('split',{runId:'unauthorized',units:[{unitId:'unauthorized-unit'}]})
 await f.call('topic.bind',{runId:'unauthorized',unitId:'unauthorized-unit',expectedRevision:0,binding:owned,topic:{topicId:'topic',conversationId:'g',sourceRunId:'unauthorized',unitId:'unauthorized-unit',title:'任务',facts:[]}})
 assert.equal((await f.call('topic.refresh',{runId:'unauthorized',topicId:'topic',inputRevision:3,priorityControls:[{unitId:'unauthorized-unit',taskId:'task',action:'cancel'}]})).result.status,'WAIT_ROUTING')
})
test('旧事实命令被拒且通知未尝试发送时允许重处理并封存过期拒绝通知',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{body:'@孙鹏 草稿保存依然有问题'}))
 await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'fact',args:{}}]})
 await f.call('command.reject',{commandId:'c',reason:'旧任务只读'})
 await f.call('notification.prepare',{runId:'m',notificationId:'n',commandId:'c',payload:{text:'过期拒绝'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const replay=(await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run
 assert.equal(replay.sourceVersion,2)
 assert.equal((await f.store.query({kind:'message.notifications',states:['superseded'],limit:10}))[0].status,'superseded')
 await f.call('receive',receive('effect'));await f.call('split',{runId:'effect',units:[{unitId:'u2'}]})
 await f.call('accept',{runId:'effect',unitId:'u2',commands:[{commandId:'c2',kind:'fact',args:{}}]})
 await f.call('command.reject',{commandId:'c2',reason:'旧任务只读'})
 await f.call('notification.prepare',{runId:'effect',notificationId:'n2',commandId:'c2',payload:{text:'曾尝试发送'},disclosure:{conversationId:'g',authorizationRef:'effect'}})
 await f.call('notification.claim',{notificationId:'n2'})
 await bad(f.call('reprocess',{runId:'effect',newRunId:'effect-replay'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
})
test('来源运行重处理后旧澄清通知不得再领取发送',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m'))
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',reason:'范围',request:{requestId:'q',kind:'needs_clarification',question:'请确认',permittedActors:['a']}})
 await f.call('notification.prepare',{runId:'m',notificationId:'n',requestId:'q',payload:{text:'请确认'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 await f.call('reprocess',{runId:'m',newRunId:'m-replay'})
 await bad(f.call('notification.claim',{notificationId:'n'}),'MESSAGE_NOTIFICATION_NOT_READY')
 assert.equal((await f.store.query({kind:'message.notification',notificationId:'n'})).status,'superseded')
})
test('澄清通知已经尝试发送时禁止重处理来源消息',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m'))
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',reason:'范围',request:{requestId:'q',kind:'needs_clarification',question:'请确认',permittedActors:['a']}})
 await f.call('notification.prepare',{runId:'m',notificationId:'n',requestId:'q',payload:{text:'请确认'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 await f.call('notification.claim',{notificationId:'n'})
 await bad(f.call('reprocess',{runId:'m',newRunId:'m-replay'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 assert.equal((await f.store.query({kind:'message.source',sourceKey:'m'})).runId,'m')
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
test('无业务效果的受管重处理不以来源版本充当次数上限',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{sourceVersion:5}))
 await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 const next=(await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run
 assert.equal(next.sourceVersion,6)
 await f.call('attention',{runId:'m-replay',reason:'recovery_exhausted'})
 assert.equal((await f.call('reprocess',{runId:'m-replay',newRunId:'m-replay-2'})).result.run.sourceVersion,7)
})
test('材料等待重处理沿用统一效果守卫而非来源版本例外',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{sourceVersion:6}))
 const claim=(await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{}})).result.node
 await f.call('node.complete',{runId:'m',nodeRunId:claim.nodeRunId,leaseEpoch:claim.leaseEpoch,output:{output:{kind:'needs_context',reason:'历史范围',needs:[]}}})
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',reason:'历史范围',request:{requestId:'context',kind:'needs_context',needs:[]}})
 assert.equal((await f.call('reprocess',{runId:'m',newRunId:'m-replay'})).result.run.sourceVersion,7)
 assert.equal((await f.call('reprocess',{runId:'m-replay',newRunId:'m-replay-2'})).result.run.sourceVersion,8)
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
test('token预留在失败与重启后持续计量，旧累计输入输出上限不再拒绝完整消息',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{maxInputTokens:100,maxOutputTokens:100}}))
 const n=(await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:80,maxOutputTokens:50})).result.node
 await f.call('node.fail',{runId:'m',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,error:'network'})
 await f.reopen();await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:80,maxOutputTokens:50})
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).budget.input_tokens,160)
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
test('承接与结果是不同事件，同事件跨命令只保留一次',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]})
 const claim=(await f.call('command.claim',{commandId:'c'})).result.command
 await f.call('command.complete',{commandId:'c',leaseEpoch:claim.leaseEpoch,result:{text:'done'}})
 const base={runId:'m',commandId:'c',disclosure:{conversationId:'g',authorizationRef:'m'}}
 await f.call('notification.prepare',{...base,notificationId:'accepted',eventKey:'task.accepted:task-1',payload:{text:'任务已接纳',conversationId:'g'}})
 await f.call('notification.prepare',{...base,notificationId:'result',eventKey:'task.result:run-1:1',payload:{text:'分析完成',conversationId:'g'}})
 const equivalent=await f.call('notification.prepare',{...base,notificationId:'accepted-again',eventKey:'task.accepted:task-1',payload:{text:'任务已接纳',conversationId:'g'}})
 assert.equal(equivalent.result.notification.id,'accepted')
 await f.call('receive',receive('second'));await f.call('split',{runId:'second',units:[{unitId:'v'}]})
 await f.call('accept',{runId:'second',unitId:'v',commands:[{commandId:'c2',kind:'query',args:{}}]})
 const another=(await f.call('command.claim',{commandId:'c2'})).result.command
 await f.call('command.complete',{commandId:'c2',leaseEpoch:another.leaseEpoch,result:{}})
 const crossRun=await f.call('notification.prepare',{runId:'second',commandId:'c2',notificationId:'accepted-new-run',eventKey:'task.accepted:task-1',payload:{text:'任务已接纳',conversationId:'g'},disclosure:{conversationId:'g',authorizationRef:'second'}})
 assert.equal(crossRun.result.notification.id,'accepted')
 assert.equal((await f.store.query({kind:'message.notifications',states:['prepared']})).length,2)
 await bad(f.call('notification.prepare',{...base,notificationId:'changed',eventKey:'task.accepted:task-1',payload:{text:'不同事实',conversationId:'g'}}),'MESSAGE_NOTIFICATION_EVENT_CONFLICT')
})
test('撤回与改写补发凭独立证据入账，重复对账幂等且不抹掉原结果',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{context:{sourceMessageId:'in-1'}}));await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]})
 const command=(await f.call('command.claim',{commandId:'c'})).result.command
 await f.call('command.complete',{commandId:'c',leaseEpoch:command.leaseEpoch,result:{text:'材料分析完成'}})
 await f.call('notification.prepare',{runId:'m',commandId:'c',notificationId:'n',eventKey:'task.result:run:1',payload:{text:'材料分析完成',conversationId:'g',sourceMessageId:'in-1'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 await f.call('notification.sent',{notificationId:'n',leaseEpoch:notice.leaseEpoch,ack:{messageId:'out-1'}})
 await f.call('notification.readback',{notificationId:'n',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'out-1',text:'材料分析完成'}})
 const recall={notificationId:'n',messageId:'out-1',recallStatus:'SUCCESS',evidenceRef:'dws-recall-1'}
 await bad(f.call('notification.recall.record',{...recall,evidenceRef:''}),'MESSAGE_RECALL_EVIDENCE_MISMATCH')
 await f.call('notification.recall.record',recall);await f.call('notification.recall.record',recall)
 await bad(f.call('notification.recall.record',{...recall,evidenceRef:'another'}),'MESSAGE_RECALL_EVIDENCE_CONFLICT')
 const replacement={notificationId:'n',replacementId:'replacement-1',messageId:'out-2',body:'材料分析完成，尚未查询账号日志',conversationId:'g',sourceMessageId:'in-1',evidenceRef:'dws-readback-2'}
 await f.call('notification.replacement.record',replacement);await f.call('notification.replacement.record',replacement)
 await bad(f.call('notification.replacement.record',{...replacement,body:'已完成账号查证'}),'MESSAGE_REPLACEMENT_CONFLICT')
 const saved=await f.store.query({kind:'message.notificationReplacement',replacementId:'replacement-1'})
 assert.equal(saved.restoresNotificationId,'n');assert.equal(saved.body,replacement.body)
 assert.equal((await f.store.query({kind:'message.notificationReplacements',notificationId:'n'})).length,1)
 assert.equal((await f.store.query({kind:'message.notification',notificationId:'n'})).recallStatus,'recalled')
 assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'applied')
})
test('受管通知操作预检冻结事实，领取后崩溃只待核对',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{context:{sourceMessageId:'in'}}));await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]})
 const claim=(await f.call('command.claim',{commandId:'c'})).result.command;await f.call('command.complete',{commandId:'c',leaseEpoch:claim.leaseEpoch,result:{}})
 await f.call('notification.prepare',{runId:'m',commandId:'c',notificationId:'n',eventKey:'task.result:run:1',payload:{text:'分析完成',conversationId:'g',sourceMessageId:'in'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 await f.call('notification.sent',{notificationId:'n',leaseEpoch:notice.leaseEpoch,ack:{messageId:'out'}})
 await f.call('notification.readback',{notificationId:'n',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'out'}})
 const prepared=(await f.call('notification.operation.prepare',{operationId:'op',notificationId:'n',type:'recall',reason:'explicit_user',authorizationRef:'user-request'})).result.operation
 await bad(f.call('notification.operation.claim',{operationId:'op',expectedFactDigest:'wrong',authorizationRef:'user-request'}),'MESSAGE_NOTIFICATION_OPERATION_STALE')
 await f.call('notification.operation.claim',{operationId:'op',expectedFactDigest:prepared.snapshot.expectedFactDigest,authorizationRef:'user-request'})
 await f.reopen()
 assert.equal((await f.store.query({kind:'message.notificationOperation',operationId:'op'})).status,'unknown')
 await bad(f.call('notification.operation.claim',{operationId:'op',expectedFactDigest:prepared.snapshot.expectedFactDigest,authorizationRef:'user-request'}),'MESSAGE_NOTIFICATION_OPERATION_STALE')
 await f.call('notification.operation.reconcile',{operationId:'op',messageId:'out',evidenceRef:'dws-list-1',recallStatus:'SUCCESS'})
 const completed=await f.store.query({kind:'message.notificationOperation',operationId:'op'})
 assert.equal(completed.status,'completed')
 const replacement=(await f.call('notification.operation.prepare',{operationId:'restore',notificationId:'n',type:'restore',reason:'correction',authorizationRef:'user-request',body:'分析完成，尚未查账号'})).result.operation
 await f.call('notification.operation.claim',{operationId:'restore',expectedFactDigest:replacement.snapshot.expectedFactDigest,authorizationRef:'user-request'})
 await f.call('notification.operation.result',{operationId:'restore',ack:{messageId:'replacement'}})
 await f.call('notification.operation.reconcile',{operationId:'restore',messageId:'replacement',evidenceRef:'dws-list-2'})
 assert.equal((await f.store.query({kind:'message.notificationReplacement',replacementId:'restore'})).body,'分析完成，尚未查账号')
})
test('补发操作已获发送ACK但回读未到时，重复执行不再次发送',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m'));await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'query',args:{}}]})
 const command=(await f.call('command.claim',{commandId:'c'})).result.command;await f.call('command.complete',{commandId:'c',leaseEpoch:command.leaseEpoch,result:{}})
 await f.call('notification.prepare',{runId:'m',commandId:'c',notificationId:'n',eventKey:'task.result:run:1',payload:{text:'结果',conversationId:'g'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 await f.call('notification.sent',{notificationId:'n',leaseEpoch:notice.leaseEpoch,ack:{messageId:'old'}})
 await f.call('notification.readback',{notificationId:'n',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'old'}})
 await f.call('notification.recall.record',{notificationId:'n',messageId:'old',recallStatus:'SUCCESS',evidenceRef:'old-recall'})
 const op=(await f.call('notification.operation.prepare',{operationId:'op',notificationId:'n',type:'restore',reason:'explicit_user',authorizationRef:'user'})).result.operation
 let sends=0
 const adapter={canDisclose:async()=>true,send:async()=>{sends++;return {messageId:'new'}},readback:async()=>null}
 const after=await executeNotificationOperation({store:f.store,adapter,operationId:'op',expectedFactDigest:op.snapshot.expectedFactDigest,authorizationRef:'user'})
 assert.equal(after.status,'acknowledged');assert.equal(sends,1)
 await assert.rejects(executeNotificationOperation({store:f.store,adapter,operationId:'op',expectedFactDigest:op.snapshot.expectedFactDigest,authorizationRef:'user'}),/MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED/)
 assert.equal(sends,1)
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
test('不可变材料首次落账后复用，大材料完整保留且TOCTOU正文变化拒绝',async t=>{
 const f=await fixture(t);await f.call('receive',receive());const args={runId:'m',resourceRef:'attachment',material:{text:'original',sourceVersion:1}}
 await f.call('material.record',args);await f.call('material.record',args)
 assert.deepEqual(await f.store.query({kind:'message.material',runId:'m',resourceRef:'attachment'}),args.material)
 await bad(f.call('material.record',{...args,material:{text:'changed',sourceVersion:1}}),'MESSAGE_MATERIAL_CONFLICT')
 await f.call('material.record',{...args,resourceRef:'large',material:{text:'中'.repeat(30000)}})
 assert.equal((await f.store.query({kind:'message.material',runId:'m',resourceRef:'large'})).text,'中'.repeat(30000))
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

test('任务 Run 状态变化后原子拒绝旧事实摘要且不写入命令', async t => {
 const f=await fixture(t)
 await f.store.command({id:'version-task-create',kind:'run.create',args:{runId:'version-business',taskId:'version-task',workflowId:'w',workflowDigest:'a'.repeat(64),requirementRef:'sha256/in',nodes:[{nodeId:'n',nodeVersion:'1',executor:'code',inputRef:'sha256/in',inputDigest:'a'.repeat(64)}]}})
 await f.call('receive',receive('version-source'))
 await f.call('split',{runId:'version-source',units:[{unitId:'version-unit'}]})
 await f.call('topic.bind',{runId:'version-source',unitId:'version-unit',expectedRevision:0,binding:{kind:'binding',disposition:'existing',candidateId:'version-task',taskId:'version-task'},topic:{topicId:'version-topic',conversationId:'g',sourceRunId:'version-source',unitId:'version-unit',title:'状态',facts:[]}})
 const oldVersion=await f.store.query({kind:'message.task.version',taskId:'version-task'})
 const topic=await f.store.query({kind:'message.topic',topicId:'version-topic'})
 await f.store.command({id:'version-task-stop',kind:'run.stop',args:{runId:'version-business',reason:'用户取消'}})
 const freshVersion=await f.store.query({kind:'message.task.version',taskId:'version-task'})
 assert.notEqual(freshVersion.hash,oldVersion.hash)
 const acceptance={runId:'version-source',topicId:'version-topic',conversationId:'g',inputRevision:topic.inputRevision,contextRevision:topic.contextRevision,taskFactVersions:[oldVersion],decisions:[{unitId:'version-unit',expectedRevision:0,commands:[{commandId:'version-status-command',kind:'status',args:{taskId:'version-task',arguments:{}}}]}]}
 await bad(f.call('topic.intent.accept',acceptance),'MESSAGE_TASK_FACTS_STALE')
 const rejected=await f.store.query({kind:'message.run',runId:'version-source'})
 assert.deepEqual(rejected.commands,[])
 assert.equal(rejected.units[0].status,'pending')
 assert.equal((await f.store.query({kind:'message.topic',topicId:'version-topic'})).processedRevision,undefined)
 await f.call('topic.intent.accept',{...acceptance,taskFactVersions:[freshVersion]})
 assert.equal((await f.store.query({kind:'message.run',runId:'version-source'})).commands.length,1)
})

test('同批重复事实撤销幂等接纳，矛盾替代整批回滚且零命令',async t=>{
 for(const conflict of [false,true]){
  const f=await fixture(t)
  await f.call('receive',receive('revision-old',{body:'仅排查'}))
  await f.call('split',{runId:'revision-old',units:[{unitId:'revision-old-unit'}]})
  await f.call('topic.bind',{runId:'revision-old',unitId:'revision-old-unit',expectedRevision:0,binding:{kind:'binding',disposition:'conversation',candidateId:null},topic:{topicId:'repeat-revision-topic',conversationId:'g',sourceRunId:'revision-old',unitId:'revision-old-unit',title:'原条件',facts:[{kind:'constraint',text:'仅排查',sourceRefs:[{sourceKey:'revision-old',sourceVersion:1,text:'仅排查'}]}]}})
  await f.call('accept',{runId:'revision-old',unitId:'revision-old-unit',expectedRevision:0,commands:[],outcome:'ignored'})
  const fact=(await f.store.query({kind:'message.topic.facts',topicId:'repeat-revision-topic'})).facts[0]
  await f.call('receive',receive('revision-new',{body:'取消原条件；撤销原条件'}))
  await f.call('split',{runId:'revision-new',units:[{unitId:'revision-A'},{unitId:'revision-B'}]})
  for(const unitId of ['revision-A','revision-B'])await f.call('topic.bind',{runId:'revision-new',unitId,expectedRevision:0,binding:{kind:'binding',disposition:'conversation',candidateId:null},topic:{topicId:'repeat-revision-topic',conversationId:'g',sourceRunId:'revision-new',unitId,title:'原条件',facts:[]}})
  const topic=await f.store.query({kind:'message.topic',topicId:'repeat-revision-topic'})
  const acceptance={runId:'revision-new',topicId:topic.topicId,conversationId:'g',inputRevision:topic.inputRevision,contextRevision:topic.contextRevision,decisions:['revision-A','revision-B'].map((unitId,index)=>({unitId,expectedRevision:0,commands:[{commandId:`revision-command-${index}`,kind:'status',args:{arguments:{}}}],factRevisions:[{factId:fact.id,sourceQuote:conflict&&index===1?'撤销原条件':'取消原条件',scope:'当前话题'}]}))}
  if(conflict)await bad(f.call('topic.intent.accept',acceptance),'MESSAGE_TOPIC_FACT_REVISION_CONFLICT')
  else await f.call('topic.intent.accept',acceptance)
  const state=await f.store.query({kind:'message.run',runId:'revision-new'})
  const active=await f.store.query({kind:'message.topic.facts',topicId:topic.topicId,status:'active'})
  const superseded=await f.store.query({kind:'message.topic.facts',topicId:topic.topicId,status:'superseded'})
  assert.equal(state.commands.length,conflict?0:2)
  assert.equal(active.facts.length,conflict?1:0)
  assert.equal(superseded.facts.length,conflict?0:1)
  if(conflict)assert.ok(state.units.every(unit=>unit.status==='pending'))
 }
})


async function deliveredAnsweredSplitClarification(t, { delivered=true, answered=true, nodeId='S', sending=false, unknown=false, conversationId='g' } = {}) {
 const f=await fixture(t);await f.call('receive',receive('m'))
 await f.call('wait',{runId:'m',unitId:'$',nodeId,request:{requestId:'q',kind:'needs_clarification',question:'如何处理附件？',permittedActors:['a']}})
 await f.call('notification.prepare',{runId:'m',notificationId:'n',requestId:'q',payload:{text:'如何处理附件？',conversationId},disclosure:{conversationId,authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'n'})).result.notification
 if(unknown)await f.call('notification.fail',{notificationId:'n',leaseEpoch:notice.leaseEpoch,error:'发送结果未知'})
 else if(!sending)await f.call('notification.sent',{notificationId:'n',leaseEpoch:notice.leaseEpoch,ack:{messageId:'out'}})
 if(delivered&&!sending&&!unknown)await f.call('notification.readback',{notificationId:'n',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'out'}})
 if(answered)await f.call('wake',{runId:'m',requestId:'q',actorId:'a',eventId:'answer',answer:'只是测试，不处理附件。'})
 await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 return f
}

test('已送达且答复已接纳的全消息澄清可受控恢复，原通知不变，答复继承且重复命令幂等',async t=>{
 const f=await deliveredAnsweredSplitClarification(t)
 const original=await f.store.query({kind:'message.notification',notificationId:'n'})
 const args={runId:'m',newRunId:'m-replay'}
 const first=await f.call('reprocess',args,'recover-resolved')
 assert.equal(first.result.run.sourceVersion,2)
 const next=await f.store.query({kind:'message.run',runId:'m-replay'})
 assert.equal(next.requests.length,1);assert.equal(next.requests[0].status,'resolved')
 assert.equal(next.requests[0].answer,'只是测试，不处理附件。')
 assert.notEqual(next.requests[0].id,'q');assert.equal(next.requests[0].runId,'m-replay')
 assert.deepEqual(await f.store.query({kind:'message.notification',notificationId:'n'}),original)
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).requests[0].status,'resolved')
 assert.equal((await f.call('reprocess',args,'recover-resolved')).replayed,true)
 await f.reopen()
 assert.equal((await f.store.query({kind:'message.run',runId:'m-replay'})).requests[0].answer,next.requests[0].answer)
 await bad(f.call('notification.claim',{notificationId:'n'}),'MESSAGE_NOTIFICATION_NOT_READY')
})

test('仅ACK、发送中、结果未知、尚未答复或单元澄清均不能扩大重处理许可',async t=>{
 for(const variant of [{delivered:false},{sending:true},{unknown:true},{answered:false},{nodeId:'R'}]){
  const f=await deliveredAnsweredSplitClarification(t,variant)
  await bad(f.call('reprocess',{runId:'m',newRunId:'m-replay'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
  assert.equal((await f.store.query({kind:'message.source',sourceKey:'m'})).runId,'m')
 }
})

test('已答复澄清仍不能重放已有业务命令',async t=>{
 const f=await deliveredAnsweredSplitClarification(t)
 await f.call('split',{runId:'m',units:[{unitId:'u'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'answer',args:{}}]})
 await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 await bad(f.call('reprocess',{runId:'m',newRunId:'m-replay'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 assert.equal((await f.store.query({kind:'message.source',sourceKey:'m'})).runId,'m')
})

test('首次模型领取前维护排队不耗执行窗口，旧无节点超时正常恢复',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{initialWindowMs:90000}}));await f.call('activate',{runId:'m'})
 await f.editSnapshot(db=>{const row=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get('m');const r=JSON.parse(row.body);r.createdAt='2020-01-01T00:00:00.000Z';r.deadline=r.createdAt;r.status='needs_attention';r.reason='MESSAGE_DEADLINE_BEFORE_CLAIM:S:$';db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(r),'m')})
 const recovered=(await f.call('recover',{runId:'m'})).result.run
 assert.equal(recovered.status,'pending');assert.equal(recovered.recoveryWindows??0,0)
 const node=(await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',input:{},estimatedInputTokens:0,maxOutputTokens:0})).result.node
 assert.ok(Date.parse(node.startedAt)>Date.parse('2025-01-01'))
})

test('已有模型领取旧账保留真实startedAt，排队墙钟年龄不拒绝恢复',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('node.claim',{runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,input:{},estimatedInputTokens:0,maxOutputTokens:0})
 await f.editSnapshot(db=>{const r=JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get('m').body);delete r.executionStartedAt;db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(r),'m');for(const row of db.prepare("SELECT rowid,body FROM message_items WHERE kind='node'").all()){const n=JSON.parse(row.body);n.startedAt='2020-01-01T00:00:00.000Z';db.prepare('UPDATE message_items SET body=? WHERE rowid=?').run(JSON.stringify(n),row.rowid)}})
 const recovered=(await f.call('recover',{runId:'m'})).result.run;assert.equal(recovered.status,'pending');assert.equal(recovered.executionStartedAt,'2020-01-01T00:00:00.000Z')
})

test('高来源版本42无业务命令已送达纯状态通知允许重处理并保留旧回执',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{sourceVersion:42}));await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 await f.call('notification.prepare',{runId:'m',notificationId:'state',stateFact:{revision:0,status:'needs_attention',reason:'recovery_exhausted',intentStatus:null,phase:'attention'},payload:{phase:'attention',conversationId:'g',text:'系统等待'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'state'})).result.notification
 await bad(f.call('reprocess',{runId:'m',newRunId:'next'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 await f.call('notification.sent',{notificationId:'state',leaseEpoch:notice.leaseEpoch,ack:{messageId:'out'}})
 await bad(f.call('reprocess',{runId:'m',newRunId:'next'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 await f.call('notification.readback',{notificationId:'state',leaseEpoch:notice.leaseEpoch,evidence:{messageId:'out'}})
 const before=await f.store.query({kind:'message.notification',notificationId:'state'})
 assert.equal((await f.call('reprocess',{runId:'m',newRunId:'next'})).result.run.sourceVersion,43)
 assert.deepEqual(await f.store.query({kind:'message.notification',notificationId:'state'}),before)
})

test('维护禁止首个模型领取且不启动执行钟，解除后过期排队来源可首次领取',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{initialWindowMs:90000}}));await f.call('activate',{runId:'m'})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'clock-test',actorId:'owner',reason:'测试维护排队'}})
 const args={runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,input:{},estimatedInputTokens:0,maxOutputTokens:0}
 await bad(f.call('node.claim',args),'RUNTIME_MAINTENANCE_ACTIVE')
 assert.equal((await f.store.query({kind:'message.run',runId:'m'})).run.executionStartedAt,undefined)
 await f.editSnapshot(db=>{const r=JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get('m').body);r.createdAt='2020-01-01T00:00:00.000Z';r.deadline=r.createdAt;db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(r),'m')})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{active:false,expectedRevision:1,maintenanceId:'clock-test',actorId:'owner',reason:'恢复'}})
 assert.equal((await f.call('node.claim',args)).result.node.status,'running')
 assert.ok((await f.store.query({kind:'message.run',runId:'m'})).run.executionStartedAt)
})

test('纯状态通知发送结果unknown仍禁止重处理',async t=>{
 const f=await fixture(t);await f.call('receive',receive());await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
 await f.call('notification.prepare',{runId:'m',notificationId:'state',stateFact:{revision:0,status:'needs_attention',reason:'recovery_exhausted',intentStatus:null,phase:'attention'},payload:{phase:'attention',conversationId:'g',text:'系统等待'},disclosure:{conversationId:'g',authorizationRef:'m'}})
 const notice=(await f.call('notification.claim',{notificationId:'state'})).result.notification
 await f.call('notification.fail',{notificationId:'state',leaseEpoch:notice.leaseEpoch,error:'network'})
 await bad(f.call('reprocess',{runId:'m',newRunId:'next'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
})

test('失败模型长排队恢复按失败lease计数，重复扫描不耗次数，持续失败有界',async t=>{
 const f=await fixture(t);await f.call('receive',receive())
 const args={runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,input:{},estimatedInputTokens:0,maxOutputTokens:0}
 for(let attempt=1;attempt<=3;attempt++){
  const node=(await f.call('node.claim',args)).result.node
  await f.call('node.fail',{runId:'m',nodeRunId:node.nodeRunId,leaseEpoch:node.leaseEpoch,expectedRevision:0,error:'MESSAGE_NODE_TIMEOUT'})
  await f.editSnapshot(db=>{const r=JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get('m').body);r.deadline='2020-01-01T00:00:00.000Z';db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(r),'m')})
  const recovered=(await f.call('recover',{runId:'m'})).result.run
  if(attempt===3){assert.equal(recovered.reason,'recovery_exhausted');break}
  assert.equal(recovered.recoveryWindows,attempt)
  for(let scan=0;scan<3;scan++)assert.equal((await f.call('recover',{runId:'m'})).result.run.recoveryWindows,attempt)
 }
})

test('旧局部判断失败改由协调入口消费同来源版本',async t=>{
 const f=await fixture(t);await f.call('receive',receive())
 await f.call('split',{runId:'m',units:[{unitId:'old-failed-unit'}]})
 await f.call('attention',{runId:'m',unitId:'old-failed-unit',reason:'MESSAGE_DEADLINE_BEFORE_CLAIM:R:old-failed-unit'})
 const binding=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'recovery-turn',sourceRuns:[{runId:'m',sourceVersion:1}]})).result.binding
 await f.call('coordinator.commit',{conversationId:'g',turnId:binding.turnId,leaseEpoch:binding.leaseEpoch,decisions:[{runId:'m',sourceVersion:1,units:[]}]})
 const after=await f.store.query({kind:'message.run',runId:'m'})
 assert.equal(after.run.sourceVersion,1);assert.equal(after.run.status,'settled');assert.equal(after.units[0].status,'superseded')
})

test('节点独立deadline保留提交余量，真实超时与旧lease仍拒绝',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{attemptMs:1,commitReserveMs:5}}))
 const args={leaseWindowMs:6,runId:'m',unitId:'$',nodeId:'S',expectedRevision:0,input:{},estimatedInputTokens:0,maxOutputTokens:0}
 const node=(await f.call('node.claim',args)).result.node
 assert.equal(Date.parse(node.deadline)-Date.parse(node.startedAt),6)
 await new Promise(resolve=>setTimeout(resolve,20))
 await bad(f.call('node.complete',{runId:'m',nodeRunId:node.id,leaseEpoch:node.leaseEpoch,expectedRevision:0,output:{}}),'MESSAGE_DEADLINE_EXCEEDED')
 await f.call('node.fail',{runId:'m',nodeRunId:node.id,leaseEpoch:node.leaseEpoch,expectedRevision:0,error:'MESSAGE_NODE_TIMEOUT'})
 await f.call('recover',{runId:'m'})
 const retry=(await f.call('node.claim',args)).result.node;assert.equal(retry.leaseEpoch,node.leaseEpoch+1)
 await bad(f.call('node.complete',{runId:'m',nodeRunId:node.id,leaseEpoch:node.leaseEpoch,expectedRevision:0,output:{}}),'MESSAGE_NODE_STALE')
})

test('历史policy20秒不能缩短当前Host180秒窗口，超过60秒结果正常落账',async t=>{
 const f=await fixture(t);await f.call('receive',receive('m',{policy:{initialWindowMs:90000,attemptMs:20000}}))
 const captured={leaseWindowMs:180500}
 await f.call('receive',receive('timed',{policy:{attemptMs:20000}}))
 await f.editSnapshot(db=>{
  const start=Date.parse('2026-09-30T00:00:00Z')
  const call=(kind,args,offset)=>reduceMessageCommand(db,{kind:'message.'+kind,args},{now:new Date(start+offset).toISOString()})
  const n=call('node.claim',{runId:'timed',unitId:'$',nodeId:'S',expectedRevision:0,input:{},estimatedInputTokens:0,maxOutputTokens:0,leaseWindowMs:captured.leaseWindowMs},0).result.node
  assert.equal(Date.parse(n.deadline)-start,180500)
  assert.throws(()=>call('node.complete',{runId:'timed',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,expectedRevision:0,output:{}},180501),{code:'MESSAGE_DEADLINE_EXCEEDED'})
  assert.equal(call('node.complete',{runId:'timed',nodeRunId:n.id,leaseEpoch:n.leaseEpoch,expectedRevision:0,output:{}},90000).result.node.status,'succeeded')
 })
})

test('高来源版本42已有业务效果仍拒绝重处理，当前身份不被绕过',async t=>{
 const f=await fixture(t);await f.call('receive',receive('high',{sourceVersion:42}))
 await f.call('split',{runId:'high',units:[{unitId:'high-u'}]})
 await f.call('accept',{runId:'high',unitId:'high-u',commands:[{commandId:'high-c',kind:'create',args:{taskId:'business-task'}}]})
 const claim=(await f.call('command.claim',{commandId:'high-c'})).result.command
 await f.call('command.complete',{commandId:'high-c',leaseEpoch:claim.leaseEpoch,result:{taskId:'business-task'}})
 await bad(f.call('reprocess',{runId:'high',newRunId:'again'}),'MESSAGE_REPROCESS_EFFECT_PENDING')
 assert.equal((await f.store.query({kind:'message.source',sourceKey:'high'})).sourceVersion,42)
})

test('群协调事务保持群session，原子提交并封存旧判断，已提交命令不重判',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('coord-a'))
 await f.call('receive',receive('coord-old'))
 await f.call('split',{runId:'coord-old',units:[{unitId:'old-unit'}]})
 await f.call('accept',{runId:'coord-old',unitId:'old-unit',commands:[{commandId:'old-command',kind:'answer',args:{}}]})
 await f.call('wait',{runId:'coord-a',nodeId:'S',request:{requestId:'old-request',kind:'needs_context'}})
 const before=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.deepEqual(before.sources.map(r=>r.runId),['coord-a'])
 const claimed=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'turn-a',sourceRuns:[{runId:'coord-a',sourceVersion:1}]})).result
 const identity={conversationId:'g',turnId:'turn-a',leaseEpoch:claimed.binding.leaseEpoch}
 await f.call('coordinator.bound',{...identity,sessionId:claimed.binding.sessionId})
 await bad(f.call('coordinator.commit',{...identity,decisions:[{runId:'coord-a',sourceVersion:2,units:[]}]}),'MESSAGE_STALE')
 assert.equal((await f.store.query({kind:'message.request',requestId:'old-request'})).status,'pending')
 const committed=(await f.call('coordinator.commit',{...identity,decisions:[{runId:'coord-a',sourceVersion:1,units:[{unitId:'coord-unit',topic:{topicId:'coord-topic',title:'事项'},commands:[{commandId:'coord-command',kind:'answer',args:{}}]}]}]})).result
 assert.equal(committed.binding.status,'committed')
 assert.equal((await f.store.query({kind:'message.request',requestId:'old-request'})).status,'superseded')
 await bad(f.call('coordinator.release',identity),'MESSAGE_COORDINATOR_NOT_DRAINED')
 await f.call('coordinator.release',{...identity,drained:true})
 await f.reopen()
 const after=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.equal(after.coordinator.sessionId,claimed.binding.sessionId)
 assert.equal(after.coordinator.sessionBound,true)
 assert.deepEqual(after.sources,[])
 assert.equal((await f.store.query({kind:'message.run',runId:'coord-old'})).commands[0].status,'pending')
})

test('群协调等待不重复消费，真实回答后重评且无动作可收口',async t=>{
 const f=await fixture(t);await f.call('receive',receive('coord-wait'))
 const claim=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'wait-turn',sourceRuns:[{runId:'coord-wait',sourceVersion:1}]})).result.binding
 const identity={conversationId:'g',turnId:claim.turnId,leaseEpoch:claim.leaseEpoch}
 await f.call('coordinator.commit',{...identity,decisions:[{runId:'coord-wait',sourceVersion:1,units:[{unitId:'waiting-unit',commands:[],request:{requestId:'coord-request',kind:'needs_clarification',permittedActors:['a']}}]}]})
 await f.call('coordinator.release',{...identity,drained:true})
 assert.deepEqual((await f.store.query({kind:'message.coordinator',conversationId:'g'})).sources,[])
 await f.call('request.resolve',{runId:'coord-wait',requestId:'coord-request',actorId:'a',answer:'不用处理',eventId:'answer'})
 assert.equal((await f.store.query({kind:'message.coordinator',conversationId:'g'})).sources.length,1)
 const next=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:1,turnId:'next',sourceRuns:[{runId:'coord-wait',sourceVersion:1}]})).result.binding
 await f.call('coordinator.commit',{conversationId:'g',turnId:next.turnId,leaseEpoch:next.leaseEpoch,decisions:[{runId:'coord-wait',sourceVersion:1,units:[],reason:'已撤回请求'}]})
 assert.equal((await f.store.query({kind:'message.run',runId:'coord-wait'})).run.status,'settled')
})

test('群协调重启撤销旧lease，同批连续来源共用话题最终版本',async t=>{
 const f=await fixture(t)
 for(const id of ['batch-a','batch-b'])await f.call('receive',receive(id))
 const sourceRuns=['batch-a','batch-b'].map(runId=>({runId,sourceVersion:1}))
 const first=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'interrupted',sourceRuns})).result.binding
 await f.reopen()
 await bad(f.call('coordinator.commit',{conversationId:'g',turnId:first.turnId,leaseEpoch:first.leaseEpoch,decisions:[]}),'MESSAGE_COORDINATOR_STALE')
 const state=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 const next=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:state.coordinator.leaseEpoch,turnId:'batch',sourceRuns})).result.binding
 const decisions=sourceRuns.map((s,i)=>({...s,units:[{unitId:'batch-unit-'+i,topic:{topicId:'batch-topic',title:'连续事项'},commands:[{commandId:'batch-command-'+i,kind:'answer',args:{}}]}]}))
 const result=(await f.call('coordinator.commit',{conversationId:'g',turnId:next.turnId,leaseEpoch:next.leaseEpoch,decisions})).result
 assert.equal(result.commands.length,2)
 assert.deepEqual(result.commands.map(c=>c.topicInputRevision),[2,2])
 assert.equal((await f.call('command.claim',{commandId:'batch-command-0'})).result.command.status,'running')
})

test('群协调维护等待已提交原生会话drain且禁止新claim',async t=>{
 const f=await fixture(t);await f.call('receive',receive('maintenance-coord'))
 const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'maintenance-turn',sourceRuns:[{runId:'maintenance-coord',sourceVersion:1}]})).result.binding
 const identity={conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch}
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).busy.messages,1)
 const maintenance={expectedRevision:0,maintenanceId:'coord-maintenance',actorId:'operator',reason:'test drain'}
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{...maintenance,active:true}})
 await f.call('coordinator.commit',{...identity,decisions:[{runId:'maintenance-coord',sourceVersion:1,units:[]}]})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,false)
 await bad(f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{...maintenance,expectedRevision:1}}),'RUNTIME_MAINTENANCE_NOT_DRAINED')
 await f.call('coordinator.release',{...identity,drained:true})
 assert.equal((await f.store.query({kind:'runtime.maintenance'})).drained,true)
 await bad(f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:1,turnId:'forbidden',sourceRuns:[]}),'RUNTIME_MAINTENANCE_ACTIVE')
})

test('群协调旧话题版本拒绝整批提交且不消费任何来源',async t=>{
 const f=await fixture(t);await f.call('receive',receive('topic-origin'))
 await f.call('split',{runId:'topic-origin',units:[{unitId:'topic-origin-unit'}]})
 await f.call('accept',{runId:'topic-origin',unitId:'topic-origin-unit',commands:[],outcome:'ignored',topic:{topicId:'existing-topic',title:'原事项',conversationId:'g',sourceRunId:'topic-origin',unitId:'topic-origin-unit',facts:[]}})
 await f.call('receive',receive('topic-followup'))
 const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'topic-turn',sourceRuns:[{runId:'topic-followup',sourceVersion:1}]})).result.binding
 const args={conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,decisions:[{runId:'topic-followup',sourceVersion:1,units:[{unitId:'topic-followup-unit',topic:{topicId:'existing-topic',title:'原事项'},commands:[],outcome:'ignored'}]}]}
 await bad(f.call('coordinator.commit',{...args,topicVersions:[{topicId:'existing-topic',inputRevision:0,contextRevision:0}]}),'MESSAGE_TOPIC_STALE')
 assert.equal((await f.store.query({kind:'message.run',runId:'topic-followup'})).units.length,0)
 const topic=await f.store.query({kind:'message.topic',topicId:'existing-topic'})
 await f.call('coordinator.commit',{...args,topicVersions:[{topicId:topic.topicId,inputRevision:topic.inputRevision,contextRevision:topic.contextRevision}]})
 const current=await f.store.query({kind:'message.topic',topicId:'existing-topic'})
 assert.equal(current.processedRevision,current.inputRevision)
})

test('精确消息清理要求全版本闭包并保留其他事项与原始审计',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('cleanup-v1',{sourceKey:'cleanup-source'}))
 await f.call('receive',receive('cleanup-v2',{sourceKey:'cleanup-source',sourceVersion:2}))
 await f.call('receive',receive('keep-source'))
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'cleanup',actorId:'operator',reason:'test',active:true}})
 const args={runIds:['cleanup-v1','cleanup-v2'],sourceKeys:['cleanup-source'],taskIds:[],topicIds:[],maintenanceId:'cleanup',maintenanceRevision:2}
 await bad(f.store.query({kind:'message.batch.cleanup.check',...args}),'MESSAGE_CLEANUP_MAINTENANCE_REQUIRED')
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'cleanup',actorId:'operator',reason:'test'}})
 await bad(f.store.query({kind:'message.batch.cleanup.check',...args,runIds:['cleanup-v2']}),'MESSAGE_CLEANUP_SOURCE_CLOSURE')
 const check=await f.store.query({kind:'message.batch.cleanup.check',...args})
 assert.equal((await f.store.query({kind:'message.run',runId:'cleanup-v1'})).run.runId,'cleanup-v1')
 await bad(f.call('batch.cleanup',{...args,expectedDigest:check.expectedDigest,notificationAuditDigest:'bad'}),'MESSAGE_CLEANUP_AUDIT_STALE')
 await f.call('batch.cleanup',{...args,expectedDigest:check.expectedDigest,notificationAuditDigest:check.notificationAuditDigest})
 await bad(f.store.query({kind:'message.run',runId:'cleanup-v2'}),'MESSAGE_RUN_NOT_FOUND')
 assert.equal((await f.store.query({kind:'message.run',runId:'keep-source'})).run.runId,'keep-source')
})

test('群协调纯Task事件按原群领取，重启和重复事件不产生动作',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('event-origin'))
 await f.call('split',{runId:'event-origin',units:[{unitId:'event-unit'}]})
 await f.call('accept',{runId:'event-origin',unitId:'event-unit',commands:[{commandId:'event-create',kind:'create',args:{taskId:'event-task'}}]})
 // 一次性历史fixture，只构造已存在Task与事件；不使用运行库。
 await f.editSnapshot(db=>{
  db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,plan_requirement_revision,status,created_at,updated_at) VALUES('event-task',1,1,1,'blocked','now','now')").run()
  db.prepare("INSERT INTO task_controls(task_id,control_revision,state) VALUES('event-task',1,'active')").run()
  db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,gate,status,attempt) VALUES('event-task',1,'one',0,'test','none','blocked',1)").run()
  db.prepare("INSERT INTO task_owners(task_id,session_id,status,updated_at) VALUES('event-task','owner-session','idle','now')").run()
  for(const key of ['one','two'])db.prepare("INSERT INTO task_events(task_id,event_key,event_type,created_at) VALUES('event-task',?,'workflow.failed','now')").run(key)
 })
 const state=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 const refs=state.unconsumedTaskEvents.map(({taskId,eventSeq})=>({taskId,eventSeq}))
 assert.equal(refs.length,2)
 assert.deepEqual((await f.store.query({kind:'message.coordinator',conversationId:'other'})).unconsumedTaskEvents,[])
 await bad(f.call('coordinator.claim',{conversationId:'other',expectedLeaseEpoch:0,turnId:'foreign',sourceRuns:[],taskEventRefs:refs}),'MESSAGE_COORDINATOR_EVENT_STALE')
 await bad(f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'fake',sourceRuns:[],taskEventRefs:[{taskId:'event-task',eventSeq:999}]}),'MESSAGE_COORDINATOR_EVENT_STALE')
 await bad(f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'gap',sourceRuns:[],taskEventRefs:[refs[1]]}),'MESSAGE_COORDINATOR_EVENT_GAP')
 await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:0,turnId:'interrupted',sourceRuns:[],taskEventRefs:refs})
 await f.reopen()
 const recovered=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.equal(recovered.unconsumedTaskEvents.length,2)
 const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:recovered.coordinator.leaseEpoch,turnId:'event-only',sourceRuns:[],taskEventRefs:refs})).result.binding
 await bad(f.call('coordinator.commit',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,decisions:[{runId:'invented',units:[]}]}),'MESSAGE_INVALID_DISPOSITION')
 const result=(await f.call('coordinator.commit',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,decisions:[]})).result
 assert.deepEqual(result.commands,[])
 await f.call('coordinator.release',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,drained:true})
 await f.reopen()
 const consumed=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.deepEqual(consumed.unconsumedTaskEvents,[])
 await bad(f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:consumed.coordinator.leaseEpoch,turnId:'repeat',sourceRuns:[],taskEventRefs:refs}),'MESSAGE_COORDINATOR_EVENT_STALE')
})
test('协调约束更正复用原发送人整条范围合同，保留其他条件',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('constraint-origin',{body:'先审批，然后执行'}))
 await f.call('split',{runId:'constraint-origin',units:[{unitId:'constraint-unit'}]})
 await f.call('accept',{runId:'constraint-origin',unitId:'constraint-unit',commands:[],outcome:'ignored',topic:{topicId:'constraint-topic',title:'审批',conversationId:'g',sourceRunId:'constraint-origin',unitId:'constraint-unit',facts:[{kind:'constraint',text:'先审批',sourceRefs:[{sourceKey:'constraint-origin',sourceVersion:1,text:'先审批'}]},{kind:'constraint',text:'执行后验证',sourceRefs:[{sourceKey:'constraint-origin',sourceVersion:1,text:'执行'}]}]}})
 const before=await f.store.query({kind:'message.topic',topicId:'constraint-topic'})
 const fact=before.facts.find(f=>f.text==='先审批')
 for(const [index,actorId,body,scope,allowed] of [[0,'other','整条条件改为主管审批','整条条件',false],[1,'a','仅对任务甲改为主管审批','整条条件',false],[2,'a','整条条件改为主管审批','整条条件',true]]){
  const runId='constraint-change-'+index
  await f.call('receive',receive(runId,{actorId,body}))
  const state=await f.store.query({kind:'message.coordinator',conversationId:'g'})
  const b=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:state.coordinator.leaseEpoch,turnId:'fact-turn-'+index,sourceRuns:[{runId,sourceVersion:1}]})).result.binding
  const topic=await f.store.query({kind:'message.topic',topicId:'constraint-topic'})
  const args={conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,topicVersions:[{topicId:topic.topicId,inputRevision:topic.inputRevision,contextRevision:topic.contextRevision}],decisions:[{runId,sourceVersion:1,units:[{unitId:'fact-change-unit-'+index,topic:{topicId:topic.topicId,title:topic.title,factRevisions:[{factId:fact.id,sourceQuote:body,scope}],facts:[]},commands:[],outcome:'ignored'}]}]}
  if(allowed)await f.call('coordinator.commit',args)
  else await bad(f.call('coordinator.commit',args),'MESSAGE_TOPIC_FACT_REVISION_FORBIDDEN')
  await f.call('coordinator.release',{conversationId:'g',turnId:b.turnId,leaseEpoch:b.leaseEpoch,drained:true})
 }
 const after=await f.store.query({kind:'message.topic',topicId:'constraint-topic'})
 assert.deepEqual(after.facts.map(f=>f.text),['执行后验证'])
})

test('离线原生重放十二来源保留业务原文且不提前派发',async t=>{
 const {buildReplaySources,receiveReplaySources}=await import('../scripts/replay-message-sources.mjs')
 const f=await fixture(t)
 const sources=Array.from({length:12},(_,i)=>({sourceKey:'original-'+i,actorId:'sender',conversationId:'group',body:'业务原文 '+i,context:{occurredAt:12-i,sourceMessageId:'dws-message-'+i,compactPolicy:'送到意图节点',attachments:[{fileId:'file-'+i}]}}))
 const runs=buildReplaySources(sources,'replay-test-round')
 assert.deepEqual(runs.map(r=>r.context.occurredAt),Array.from({length:12},(_,i)=>i+1))
 assert.equal(runs[0].context.compactPolicy,'送到协调输入')
 assert.equal(sources[0].context.compactPolicy,'送到意图节点')
 assert.throws(()=>buildReplaySources([...sources.slice(0,11),sources[0]],'replay-test-round'),{code:'REPLAY_SOURCE_MANIFEST_INVALID'})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'replay',actorId:'operator',reason:'test',active:true}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'replay',actorId:'operator',reason:'test'}})
 await receiveReplaySources(f.store,runs)
 assert.deepEqual(await f.store.query({kind:'task.catalog'}),[])
 for(const run of runs){const state=await f.store.query({kind:'message.run',runId:run.runId});assert.equal(state.commands.length,0);assert.equal(state.nodes.length,0);assert.deepEqual(state.run.context.attachments,run.context.attachments)}
})

for(const status of ['pending','superseded','running','unknown'])test(`精确清理区分未创建Task预分配与未知执行：${status}`,async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('planned'));await f.call('split',{runId:'planned',units:[{unitId:'planned-unit'}]})
 await f.call('accept',{runId:'planned',unitId:'planned-unit',commands:[{commandId:'planned-command',kind:'create',args:{taskId:'phantom-task'}}]})
 await f.call('receive',receive('unrelated'))
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'cleanup',actorId:'operator',reason:'test',active:true}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'cleanup',actorId:'operator',reason:'test'}})
 if(status!=='pending')await f.editSnapshot(db=>{const row=db.prepare("SELECT body FROM message_items WHERE item_id='command:planned-command'").get();const c=JSON.parse(row.body);c.status=status;db.prepare("UPDATE message_items SET body=? WHERE item_id='command:planned-command'").run(JSON.stringify(c))})
 const args={runIds:['planned'],sourceKeys:['planned'],taskIds:['phantom-task'],topicIds:[],maintenanceId:'cleanup',maintenanceRevision:2}
 if(['running','unknown'].includes(status)){await bad(f.store.query({kind:'message.batch.cleanup.check',...args}),'MESSAGE_CLEANUP_COMMAND_PENDING');return}
 const check=await f.store.query({kind:'message.batch.cleanup.check',...args})
 assert.deepEqual(check.plannedTaskIds,['phantom-task']);assert.deepEqual(check.actualTaskIds,[])
 await f.call('batch.cleanup',{...args,expectedDigest:check.expectedDigest,notificationAuditDigest:check.notificationAuditDigest})
 await bad(f.store.query({kind:'message.run',runId:'planned'}),'MESSAGE_RUN_NOT_FOUND')
 assert.equal((await f.store.query({kind:'message.run',runId:'unrelated'})).run.runId,'unrelated')
 assert.equal(await f.store.query({kind:'task.deleted',taskId:'phantom-task'}),null)
})

test('真实Task接纳回执不能降级成预分配，未原生删除时拒绝批次清理',async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('actual'));await f.call('split',{runId:'actual',units:[{unitId:'actual-unit'}]})
 await f.call('accept',{runId:'actual',unitId:'actual-unit',commands:[{commandId:'actual-command',kind:'create',args:{taskId:'actual-task'}}]})
 await f.store.command({id:randomUUID(),kind:'task.accept',args:{taskId:'actual-task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核验'],sourceKey:'actual',eventKey:'accepted'}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'cleanup',actorId:'operator',reason:'test',active:true}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'cleanup',actorId:'operator',reason:'test'}})
 const args={runIds:['actual'],sourceKeys:['actual'],taskIds:['actual-task'],topicIds:[],maintenanceId:'cleanup',maintenanceRevision:2}
 await bad(f.store.query({kind:'message.batch.cleanup.check',...args}),'MESSAGE_CLEANUP_TASK_DELETE_REQUIRED')
})


for(const evidence of ['event','receipt'])test(`清理仅剩历史${evidence}创建证据时仍要求真实删除审计`,async t=>{
 const f=await fixture(t)
 await f.call('receive',receive('historical'));await f.call('split',{runId:'historical',units:[{unitId:'historical-unit'}]})
 await f.call('accept',{runId:'historical',unitId:'historical-unit',commands:[{commandId:'historical-command',kind:'create',args:{taskId:'historical-task'}}]})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'cleanup',actorId:'operator',reason:'test',active:true}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'cleanup',actorId:'operator',reason:'test'}})
 await f.editSnapshot(db=>{
  const result=JSON.stringify({status:'applied',taskId:'historical-task',requirementRevision:1,planRevision:0})
  if(evidence==='event')db.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)').run('task.accept',result,new Date().toISOString())
  else db.prepare('INSERT INTO execution_receipts(command_id,payload_digest,result,created_at) VALUES(?,?,?,?)').run('historical-accept','a'.repeat(64),result,new Date().toISOString())
 })
 await bad(f.store.query({kind:'message.batch.cleanup.check',runIds:['historical'],sourceKeys:['historical'],taskIds:['historical-task'],topicIds:[],maintenanceId:'cleanup',maintenanceRevision:2}),'MESSAGE_CLEANUP_TASK_DELETE_REQUIRED')
})

test('精确清理轮换受影响群会话，保留其他来源群及Task水位并拒绝旧绑定',async t=>{
 const f=await fixture(t)
 const bindings={}
 for(const [runId,conversationId] of [['reset-source','g'],['other-source','other']]){
  await f.call('receive',receive(runId,{conversationId}))
  const b=(await f.call('coordinator.claim',{conversationId,expectedLeaseEpoch:0,turnId:'turn-'+runId,sourceRuns:[{runId,sourceVersion:1}]})).result.binding
  bindings[conversationId]=b
  await f.call('coordinator.bound',b)
  await f.call('coordinator.commit',{...b,decisions:[{runId,sourceVersion:1,units:[]}]})
  await f.call('coordinator.release',{...b,drained:true})
 }
 await f.call('receive',receive('retained-source'))
 await f.call('receive',receive('planned-reset'))
 await f.call('split',{runId:'planned-reset',units:[{unitId:'planned-reset-unit'}]})
 await f.call('accept',{runId:'planned-reset',unitId:'planned-reset-unit',commands:[{commandId:'planned-reset-command',kind:'create',args:{taskId:'planned-reset-task'}}]})
 await f.editSnapshot(db=>{
  const group=JSON.parse(db.prepare("SELECT body FROM message_groups WHERE conversation_id='g'").get().body)
  group.coordinator.taskEventWatermarks={'planned-reset-task':10,'retained-task':20}
  db.prepare("UPDATE message_groups SET body=? WHERE conversation_id='g'").run(JSON.stringify(group))
 })
 const before=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 const other=await f.store.query({kind:'message.coordinator',conversationId:'other'})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.change',args:{expectedRevision:0,maintenanceId:'cleanup',actorId:'operator',reason:'test',active:true}})
 await f.store.command({id:randomUUID(),kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'cleanup',actorId:'operator',reason:'test'}})
 const args={runIds:['reset-source','planned-reset'],sourceKeys:['reset-source','planned-reset'],taskIds:['planned-reset-task'],topicIds:[],maintenanceId:'cleanup',maintenanceRevision:2}
 const check=await f.store.query({kind:'message.batch.cleanup.check',...args})
 const cleaned=(await f.call('batch.cleanup',{...args,expectedDigest:check.expectedDigest,notificationAuditDigest:check.notificationAuditDigest})).result
 const after=await f.store.query({kind:'message.coordinator',conversationId:'g'})
 assert.notEqual(after.coordinator.sessionId,before.coordinator.sessionId)
 assert.equal(after.coordinator.sessionId,cleaned.coordinatorResets[0].sessionId)
 assert.equal(after.coordinator.sessionBound,false)
 assert.equal(after.coordinator.leaseEpoch,before.coordinator.leaseEpoch+1)
 assert.equal(after.coordinator.turnId,null)
 assert.equal(after.coordinator.status,'idle')
 assert.deepEqual(after.coordinator.sources,[])
 assert.deepEqual(after.coordinator.taskEventRefs,[])
 assert.deepEqual(after.coordinator.taskEventWatermarks,{'retained-task':20})
 assert.deepEqual(await f.store.query({kind:'message.coordinator',conversationId:'other'}),other)
 assert.equal((await f.store.query({kind:'message.run',runId:'retained-source'})).run.runId,'retained-source')
 await bad(f.call('coordinator.commit',{...bindings.g,decisions:[]}),'MESSAGE_COORDINATOR_STALE')
 await f.resumeInNewProcess({expectedRevision:2,maintenanceId:'cleanup',actorId:'operator',reason:'test'})
 assert.equal((await f.store.query({kind:'message.coordinator',conversationId:'g'})).coordinator.sessionId,after.coordinator.sessionId)
 const next=(await f.call('coordinator.claim',{conversationId:'g',expectedLeaseEpoch:after.coordinator.leaseEpoch,turnId:'new-context',sourceRuns:[{runId:'retained-source',sourceVersion:1}]})).result.binding
 assert.equal(next.sessionId,after.coordinator.sessionId)
 assert.equal(next.sessionBound,false)
 await bad(f.call('coordinator.commit',{...bindings.g,decisions:[]}),'MESSAGE_COORDINATOR_STALE')
 await f.call('coordinator.release',{...next,drained:true})
})
