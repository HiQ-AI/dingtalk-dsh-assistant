import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {createNotificationRetirementHandler} from '../packages/dingtalk-dsh-assistant/notification-retirement.js'

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'retire-notice-')),dbPath=join(root,'control.sqlite')
 const store=await openExecutionStore({dbPath,instanceId:randomUUID(),initialize:true})
 t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 const call=(kind,args)=>store.command({id:randomUUID(),kind,args})
 await call('message.receive',{runId:'m',sourceKey:'source',sourceVersion:1,conversationId:'g',actorId:'owner',body:'请核查',context:{sourceMessageId:'in'}})
 await call('message.split',{runId:'m',units:[{unitId:'u',goalText:'交付结果'}]})
 await call('message.accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{taskId:'task',replyPolicy:'none'}}]})
 const c=(await call('message.command.claim',{commandId:'c'})).result.command
 await call('task.accept',{taskId:'task',requirementRef:`sha256-${'a'.repeat(64)}.json`,requirementRevision:1,sessionId:'owner',criteria:['交付结果'],sourceKey:'source',eventKey:'created'})
 await call('message.command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:{taskId:'task'}})
 await call('task.owner.claim',{taskId:'task',turnId:'done',expectedLeaseEpoch:0})
 await call('task.owner.sessionBound',{taskId:'task',turnId:'done',leaseEpoch:1,sessionId:'owner'})
 await call('task.owner.candidate',{taskId:'task',turnId:'done',leaseEpoch:1,decision:{action:'block',summary:'需要资料',evidenceRefs:[],condition:{kind:'business-input',missing:'目标',responsibleParty:'交办人',resumeWhen:'提供目标后继续',evidenceRefs:[]}}})
 await call('task.owner.accept',{taskId:'task',turnId:'done',leaseEpoch:1})
 await call('task.owner.applied',{taskId:'task',turnId:'done',leaseEpoch:1})
 const report=(await store.query({kind:'task.owner.reports',taskId:'task'}))[0]
 const edit=fn=>{const db=new DatabaseSync(dbPath);try{fn(db)}finally{db.close()}}
 // 仅此临时合成数据库构造已完成/已送达事实；测试不执行实际业务或渠道。
 edit(db=>{
  const decision={action:'complete',summary:'真实结果完成',evidenceRefs:['proof'],assessments:[{itemId:'acceptance-1',status:'satisfied',evidenceRefs:['proof']}]}
  db.prepare("UPDATE task_owner_turns SET decision_json=? WHERE turn_id='done'").run(JSON.stringify(decision))
  db.prepare("UPDATE task_reports SET report_type='complete' WHERE turn_id='done'").run()
  db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task'").run()
 })
 const base={runId:'m',commandId:'c',leaseEpoch:0,payload:{conversationId:'g',text:'原正文',fact:{taskId:'task'}},disclosure:{conversationId:'g',authorizationRef:'source'}}
 const old={...structuredClone(base),id:'old',status:'prepared',eventKey:'task.started:task',payload:{...base.payload,phase:'task:started'}}
 const kept={...structuredClone(base),id:'kept',status:'delivered',leaseEpoch:1,payload:{...base.payload,phase:'owner:'+report.reportId,text:'已完成'},evidence:{messageId:'actual-message',conversationId:'g'}}
 const save=n=>edit(db=>db.prepare('INSERT INTO message_items(item_id,run_id,kind,body) VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET body=excluded.body').run('notification:'+n.id,n.runId,'notification',JSON.stringify(n)))
 save(old);save(kept)
 const counts={artifacts:0,commands:0}, identity={channel:'web',actorId:'operator'}
 const handler=createNotificationRetirementHandler({store:{query:q=>store.query(q),command:c=>{counts.commands++;return store.command(c)}},artifacts:{put:async()=>{counts.artifacts++;return{ref:'proof-retirement'}}},groups:new Set(['g']),webActorId:'operator'})
 const input={notificationId:'old',supersededByNotificationId:'kept',requestId:'retire-old'}
 return{store,call,edit,save,old,kept,handler,counts,identity,input,read:()=>store.query({kind:'message.notification',notificationId:'old'})}
}
test('read-only preflight, atomic formal retirement, body preservation and idempotent replay without channel',async t=>{
 const f=await fixture(t),snapshot=await f.handler(f.input,f.identity,true)
 assert.deepEqual(f.counts,{artifacts:0,commands:0});assert.equal((await f.read()).status,'prepared')
 const beforePlan=await f.store.query({kind:'task.plan',taskId:'task'})
 const input={...f.input,expectedFactDigest:snapshot.expectedFactDigest},result=await f.handler(input,f.identity)
 assert.equal(result.notification.status,'superseded');assert.equal(result.notification.payload.text,f.old.payload.text)
 assert.equal(result.notification.supersededByOutboundId,'kept');assert.equal(result.notification.retirement.replacementMessageId,'actual-message')
 assert.equal(result.notification.retirement.evidenceRef,'proof-retirement');assert.equal(result.notification.leaseEpoch,0)
 assert.equal((await f.handler(input,f.identity)).replayed,true);assert.deepEqual(f.counts,{artifacts:1,commands:1})
 assert.deepEqual(await f.store.query({kind:'task.plan',taskId:'task'}),beforePlan)
 await assert.rejects(f.handler({...input,expectedFactDigest:'b'.repeat(64)},f.identity),{code:'MESSAGE_NOTIFICATION_RETIRE_CONFLICT'})
})
for(const state of ['sending','acknowledged','unknown','delivered','superseded'])test(`retirement rejects ${state} without a channel call`,async t=>{
 const f=await fixture(t);f.save({...f.old,status:state})
 await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_UNSAFE_DELIVERY'})
 assert.deepEqual(f.counts,{artifacts:0,commands:0});assert.equal((await f.read()).status,state)
})
test('lease/ACK/attempt evidence refuses guessed unsent delivery',async t=>{
 const f=await fixture(t)
 for(const patch of [{leaseEpoch:1},{ack:{openTaskId:'unknown'}},{startedAt:'before'},{deliveryAttemptCount:1},{sendAttemptCount:1},{evidence:{messageId:'m'}},{error:'unknown-send'}]){
  f.save({...f.old,...patch});await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_UNSAFE_DELIVERY'})
 }
 assert.deepEqual(f.counts,{artifacts:0,commands:0})
})
test('wrong actor/group, unrelated or unconfirmed replacement and still-current final conclusion reject',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.handler(f.input,{...f.identity,actorId:'other'},true),{code:'WORKFLOW_NOTIFICATION_FORBIDDEN'})
 f.save({...f.old,payload:{...f.old.payload,conversationId:'other'}});await assert.rejects(f.handler(f.input,f.identity,true),{code:'WORKFLOW_NOTIFICATION_FORBIDDEN'});f.save(f.old)
 for(const patch of [{status:'acknowledged'},{evidence:null},{recallStatus:'recalled'},{payload:{...f.kept.payload,conversationId:'other'}},{payload:{...f.kept.payload,fact:{taskId:'another'}}}]){
  f.save({...f.kept,...patch});await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_REPLACEMENT_UNPROVEN'})
 }
 f.save(f.kept);f.save({...f.old,payload:{...f.kept.payload,text:'当前结论'}})
 await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_STILL_CURRENT'})
 assert.deepEqual(f.counts,{artifacts:0,commands:0})
})
test('CAS covers notification, source and task state; race before transaction cannot retire',async t=>{
 const f=await fixture(t),snapshot=await f.handler(f.input,f.identity,true)
 f.edit(db=>{const row=db.prepare("SELECT body FROM message_runs WHERE run_id='m'").get(),r=JSON.parse(row.body);r.revision++;db.prepare("UPDATE message_runs SET body=? WHERE run_id='m'").run(JSON.stringify(r))})
 await assert.rejects(f.handler({...f.input,expectedFactDigest:snapshot.expectedFactDigest},f.identity),{code:'MESSAGE_NOTIFICATION_RETIRE_STALE'})
 const fresh=await f.handler(f.input,f.identity,true)
 const race=createNotificationRetirementHandler({store:f.store,artifacts:{put:async()=>{f.save({...f.old,payload:{...f.old.payload,text:'changed'}});return{ref:'race-evidence'}}},groups:new Set(['g']),webActorId:'operator'})
 await assert.rejects(race({...f.input,expectedFactDigest:fresh.expectedFactDigest},f.identity),{code:'MESSAGE_NOTIFICATION_RETIRE_STALE'})
 assert.equal((await f.read()).status,'prepared')
})
test('old Owner wait/block is replaced by exact latest completed turn, preserving old report',async t=>{
 const f=await fixture(t)
 f.edit(db=>{
  const row=db.prepare("SELECT * FROM task_owner_turns WHERE turn_id='done'").get(),names=Object.keys(row)
  row.turn_id='earlier';row.decision_json=JSON.stringify({action:'block',summary:'旧等待'})
  db.prepare(`INSERT INTO task_owner_turns(rowid,${names.join(',')}) VALUES (${['?',...names.map(()=>'?')].join(',')})`).run(0,...names.map(k=>row[k]))
  db.prepare('INSERT INTO task_reports VALUES (?,?,?,?,?,?)').run('old-report','task','earlier','block',JSON.stringify({summary:'旧等待'}),'2026-01-01')
 })
 f.save({...f.old,payload:{...f.old.payload,phase:'owner:old-report'}})
 const snapshot=await f.handler(f.input,f.identity,true);assert.equal(snapshot.reason,'owner-conclusion-replaced')
 await f.handler({...f.input,expectedFactDigest:snapshot.expectedFactDigest},f.identity)
 const reports=await f.store.query({kind:'task.owner.reports',taskId:'task'});assert.equal(reports.length,2);assert.equal(reports.find(r=>r.reportId==='old-report').facts.summary,'旧等待')
})
test('old status Run retires but current Run query on completed task refuses retirement',async t=>{
 const f=await fixture(t)
 f.edit(db=>{
  for(const runId of ['previous','current'])db.prepare('INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(runId,'task','test','a'.repeat(64),'proof','succeeded','2026-01-01','2026-01-01')
  const row=db.prepare("SELECT body FROM message_items WHERE item_id='command:c'").get(),c=JSON.parse(row.body);c.kind='status';c.result.runId='current'
  db.prepare("UPDATE message_items SET body=? WHERE item_id='command:c'").run(JSON.stringify(c))
 })
 f.save({...f.old,payload:{...f.old.payload,phase:'receipt'}})
 await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_STILL_CURRENT'})
 f.edit(db=>{const row=db.prepare("SELECT body FROM message_items WHERE item_id='command:c'").get(),c=JSON.parse(row.body);c.result.runId='previous';db.prepare("UPDATE message_items SET body=? WHERE item_id='command:c'").run(JSON.stringify(c))})
 const snapshot=await f.handler(f.input,f.identity,true);assert.equal(snapshot.reason,'execution-result-replaced')
 await f.handler({...f.input,expectedFactDigest:snapshot.expectedFactDigest},f.identity);assert.equal((await f.read()).status,'superseded')
})
for(const sample of [{name:'导入导出旧启动',requirement:10,planRequirement:8},{name:'合并结果旧启动',requirement:13,planRequirement:10}])test(`withdrawn start retires with native pending and stale plan: ${sample.name}`,async t=>{
 const f=await fixture(t)
 f.edit(db=>{db.prepare("UPDATE business_tasks SET status='pending',requirement_revision=?,plan_requirement_revision=? WHERE task_id='task'").run(sample.requirement,sample.planRequirement)})
 const before=await f.store.query({kind:'task.plan',taskId:'task'}),snapshot=await f.handler(f.input,f.identity,true)
 assert.equal(snapshot.reason,'automatic-start-policy-withdrawn');assert.deepEqual(snapshot.facts.policy,{phase:'task:started',automaticNotificationAllowed:false})
 const receipt=await f.handler({...f.input,expectedFactDigest:snapshot.expectedFactDigest},f.identity)
 assert.equal(receipt.notification.status,'superseded');assert.equal(receipt.notification.payload.text,f.old.payload.text)
 assert.equal(receipt.notification.leaseEpoch,0);assert.equal(receipt.notification.retirement.reason,'automatic-start-policy-withdrawn')
 assert.deepEqual(await f.store.query({kind:'task.plan',taskId:'task'}),before)
})
test('policy retirement validates persisted type and applied intent rather than text keywords',async t=>{
 const f=await fixture(t)
 f.edit(db=>db.prepare("UPDATE business_tasks SET status='pending',requirement_revision=10,plan_requirement_revision=8 WHERE task_id='task'").run())
 for(const patch of [{payload:{...f.old.payload,phase:'receipt',text:'任务已开始处理。'}},{eventKey:'task.started:another'},{payload:{...f.old.payload,fact:{taskId:'another'}}}]){
  f.save({...f.old,...patch});await assert.rejects(f.handler(f.input,f.identity,true))
 }
 f.save(f.old)
 f.edit(db=>{const row=db.prepare("SELECT body FROM message_items WHERE item_id='command:c'").get(),c=JSON.parse(row.body);c.kind='status';db.prepare("UPDATE message_items SET body=? WHERE item_id='command:c'").run(JSON.stringify(c))})
 await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_REPLACEMENT_UNPROVEN'})
})
test('native pending wait/block and valid status query are not covered by the withdrawn-start branch',async t=>{
 const f=await fixture(t)
 f.edit(db=>db.prepare("UPDATE business_tasks SET status='pending',requirement_revision=10,plan_requirement_revision=8 WHERE task_id='task'").run())
 for(const phase of ['owner:old-wait','owner:old-block','receipt']){
  f.save({...f.old,payload:{...f.old.payload,phase,text:'任务已开始处理。'}})
  await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_REPLACEMENT_UNPROVEN'})
 }
 assert.deepEqual(f.counts,{artifacts:0,commands:0})
})
test('withdrawn-start CAS still rejects native requirement changes after preflight',async t=>{
 const f=await fixture(t)
 f.edit(db=>db.prepare("UPDATE business_tasks SET status='pending',requirement_revision=10,plan_requirement_revision=8 WHERE task_id='task'").run())
 const snapshot=await f.handler(f.input,f.identity,true)
 f.edit(db=>db.prepare("UPDATE business_tasks SET requirement_revision=11 WHERE task_id='task'").run())
 await assert.rejects(f.handler({...f.input,expectedFactDigest:snapshot.expectedFactDigest},f.identity),{code:'MESSAGE_NOTIFICATION_RETIRE_STALE'})
 assert.equal((await f.read()).status,'prepared')
})
test('unresolved notification operation prevents policy retirement despite prepared lease-zero projection',async t=>{
 const f=await fixture(t)
 f.edit(db=>db.prepare('INSERT INTO message_items(item_id,run_id,kind,body) VALUES (?,?,?,?)').run('notification-operation:uncertain','m','notification-operation',JSON.stringify({id:'uncertain',status:'unknown',snapshot:{notificationId:'old'}})))
 await assert.rejects(f.handler(f.input,f.identity,true),{code:'MESSAGE_NOTIFICATION_RETIRE_UNSAFE_DELIVERY'})
 assert.equal((await f.read()).status,'prepared');assert.deepEqual(f.counts,{artifacts:0,commands:0})
})
