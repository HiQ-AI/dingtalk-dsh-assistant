import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

// T03/T23 keep finite SQL fault boundaries against current Task acceptance and
// completion/Topic-fact transactions. Retired DAG scheduling is not resurrected.
async function fixture(t) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
  const directory=await mkdtemp(join(tmpdir(),'current-final-fault-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'fault-matrix',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  const task=taskId=>command('task.create',{taskId,groupId:'group',request:taskId})
  const claim=async taskId=>(await command('task.claim',{taskId})).result.binding
  const dispatch=async(binding,key,resourceKeys=[])=>(await command('execution.dispatch',{binding,key,prompt:key,resourceKeys})).result.execution
  const notice=async()=>(await command('notification.prepare',{notificationId:'notice',kind:'topic-reply',requirementRevision:1,
    payload:{conversationId:'group',text:'Frozen result',sourceMessageId:'source',actorId:'actor',fact:{topicRefs:[{topicId:'topic',revision:1}]}}})).result.notification
  return {options,command,query,task,claim,dispatch,notice,
    async restart(){await store.close();store=await openDynamicTaskStore(options)},
    async close(){await store.close()},async open(){store=await openDynamicTaskStore(options)},
    async restartFenced(){await assert.rejects(store.close(),{code:'DYNAMIC_STORE_FENCED'});store=await openDynamicTaskStore(options)}}
}
function failWrite(t,table,when) {
  const original=DatabaseSync.prototype.prepare;let fired=false
  const mock=t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
    const statement=original.call(this,sql)
    if(!sql.startsWith(`INSERT INTO ${table}(`))return statement
    return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target)
      if(key!=='run')return typeof value==='function'?value.bind(target):value
      return (...args)=>{if(!fired&&when==='before'){fired=true;throw new Error(`injected ${table} before`)}
        const result=value.apply(target,args);if(!fired){fired=true;throw new Error(`injected ${table} after`)}return result}
    }})
  })
  return {restore:()=>mock.mock.restore(),fired:()=>fired}
}
for(const table of ['dynamic_tasks','dynamic_wakes','dynamic_receipts'])
for(const when of ['before','after'])test(`T03 Task acceptance rollback at ${table} ${when} leaves no Task, wake or receipt`,async t=>{
  const f=await fixture(t),input={taskId:'A',groupId:'group',request:'Authorized goal'},injected=failWrite(t,table,when)
  try{await assert.rejects(f.command('task.create',input,'accept-once'),/injected/)}finally{injected.restore()}
  assert.equal(injected.fired(),true);await f.restart()
  assert.equal(await f.query('task.get',{taskId:'A'}),null);assert.deepEqual(await f.query('wake.list'),[])
  assert.equal(await f.query('receipt.get',{id:'accept-once'}),null)
  await f.command('task.create',input,'accept-once')
  assert.equal((await f.command('task.create',input,'accept-once')).replayed,true)
  assert.equal((await f.query('task.list')).length,1);assert.equal((await f.query('wake.list')).length,1)
})
for(const table of ['dynamic_tasks','dynamic_task_events','dynamic_topic_facts','dynamic_receipts'])
for(const when of ['before','after'])test(`T23 completion rollback at ${table} ${when} keeps Task, proof and Topic fact atomic`,async t=>{
  const f=await fixture(t);await f.task('A');const binding=await f.claim('A'),before=await f.query('task.get',{taskId:'A'})
  const input={binding,summary:'Verified result',result:{evidence:['synthetic-proof']},topicFacts:true},injected=failWrite(t,table,when)
  try{await assert.rejects(f.command('task.complete',input,'complete-once'),/injected/)}finally{injected.restore()}
  assert.equal(injected.fired(),true);assert.deepEqual(await f.query('task.get',{taskId:'A'}),before)
  assert.deepEqual((await f.query('task.events')).events,[]);assert.equal(await f.query('receipt.get',{id:'complete-once'}),null)
  const assertNoFacts=()=>{const db=new DatabaseSync(f.options.dbPath,{readOnly:true})
    try{assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dynamic_topic_facts').get().count,0)}finally{db.close()}}
  assertNoFacts();await f.restart();assertNoFacts()
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),{...before,recovering:true})
  assert.deepEqual((await f.query('task.events')).events,[]);assert.equal(await f.query('receipt.get',{id:'complete-once'}),null)
  await assert.rejects(f.command('task.complete',input,'complete-once'),{code:'DYNAMIC_TASK_LEASE_STALE'})
  await f.command('task.drained',{binding});const recoveredInput={...input,binding:await f.claim('A')}
  const result=await f.command('task.complete',recoveredInput,'complete-once')
  assert.equal(result.topicFacts.length,1);assert.equal((await f.command('task.complete',recoveredInput,'complete-once')).replayed,true)
  await f.restart();assert.equal((await f.query('task.get',{taskId:'A'})).status,'completed')
  assert.equal((await f.query('task.events')).events.length,1)
  assert.equal((await f.query('topic.fact.get',{factId:result.topicFacts[0].id})).commandId,'complete-once')
  assert.deepEqual(await f.query('notification.list'),[],'completion records facts without sending')
})
for(const when of ['before','after'])test(`T03 COMMIT ${when} acknowledgement failure reconciles exact original acceptance`,async t=>{
  const f=await fixture(t),original=DatabaseSync.prototype.exec;let fired=false
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(sql){
    if(sql==='COMMIT'&&!fired){fired=true;if(when==='before')throw new Error('injected commit before')
      original.call(this,sql);throw new Error('injected commit acknowledgement after')}
    return original.call(this,sql)
  })
  const args={taskId:'A',groupId:'group',request:'Authorized goal'}
  try{await assert.rejects(f.command('task.create',args,'exact-acceptance'),{code:'DYNAMIC_COMMIT_ACK_UNKNOWN'})}finally{mock.mock.restore()}
  await f.restart();assert.equal((await f.query('task.list')).length,when==='after'?1:0)
  const reconciled=await f.command('task.create',args,'exact-acceptance')
  assert.equal(reconciled.replayed===true,when==='after')
  assert.equal((await f.query('task.list')).length,1);assert.equal((await f.query('wake.list')).length,1)
})
for(const first of ['A','B'])test(`T07 current opposing resource claims acquire all resources or none: ${first} wins`,async t=>{
  const f=await fixture(t),executions={}
  for(const id of ['A','B']){await f.task(id);executions[id]=await f.dispatch(await f.claim(id),id,id==='A'?['left','right']:['right','left'])}
  const order=first==='A'?['A','B']:['B','A'],results=await Promise.allSettled(order.map(id=>f.command('execution.claim',{executionId:executions[id].id})))
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'DYNAMIC_RESOURCE_BUSY')
  const locks=await f.query('resource.list');assert.equal(locks.length,2);assert.equal(new Set(locks.map(lock=>lock.holder)).size,1)
  assert.equal((await f.query('execution.get',{executionId:executions[order[1]].id})).leaseEpoch,0)
  await f.restart();assert.deepEqual(await f.query('resource.list'),locks)
})
test('T18 second supported writer refuses live owner and expired incarnation rejects current Task writes',async t=>{
  const f=await fixture(t);await assert.rejects(openDynamicTaskStore(f.options),{code:'DYNAMIC_STORE_ALREADY_OPEN'})
  const external=new DatabaseSync(f.options.dbPath)
  external.prepare("UPDATE dynamic_meta SET value='999999999:fault-takeover' WHERE key='owner'").run();external.close()
  await assert.rejects(f.task('stale-writer'),{code:'DYNAMIC_STORE_FENCED'})
  await f.restartFenced();assert.deepEqual(await f.query('task.list'),[])
})
test('T08 cancelled queued execution cannot be claimed after restart and does not cancel its Task',async t=>{
  const f=await fixture(t);await f.task('A');const owner=await f.claim('A'),execution=await f.dispatch(owner,'cancelled-work')
  await f.command('execution.cancel',{binding:owner,executionId:execution.id});await f.restart()
  await assert.rejects(f.command('execution.claim',{executionId:execution.id}),{code:'DYNAMIC_EXECUTION_BUSY'})
  assert.equal((await f.query('task.get',{taskId:'A'})).control,'active')
  assert.equal((await f.query('execution.get',{executionId:execution.id})).status,'cancelled');assert.deepEqual(await f.query('resource.list'),[])
})
test('T32 retired periodic cursor and accepted UTC slot remain historical under clock jumps and restart',async t=>{
  const f=await fixture(t);await f.task('A');await f.close();const db=new DatabaseSync(f.options.dbPath)
  const schedule={id:'old-schedule',state:'active',coordinationId:'old',rule:{kind:'daily',time:'09:00'},nextDueAt:'2026-10-22T01:00:00Z'}
  const occurrence={id:'old-slot',scheduleId:schedule.id,plannedAt:'2026-10-21T01:00:00Z',state:'waiting'}
  try{
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    for(const [table,row] of [['dynamic_coordination_schedules',schedule],['dynamic_coordination_occurrences',occurrence]])
      db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?)`).run(row.id,JSON.stringify(row))
  }finally{db.close()}
  await f.open();const task=await f.query('task.get',{taskId:'A'}),saved=await f.query('coordination.schedule.list')
  for(const at of ['2026-10-25T01:00:00Z','2026-10-20T01:00:00Z','2026-10-25T01:00:00Z']){
    t.mock.timers.setTime(Date.parse(at));await f.restart()
    assert.deepEqual(await f.query('coordination.schedule.list'),saved);assert.deepEqual(await f.query('coordination.occurrence.list'),[occurrence])
    assert.deepEqual(await f.query('coordination.job.list'),[]);assert.deepEqual(await f.query('task.get',{taskId:'A'}),task)
  }
})
test('T50 stale Owner cannot dispatch a tail after a revised goal or erase already recorded evidence',async t=>{
  const f=await fixture(t);await f.task('A');const owner=await f.claim('A'),first=await f.dispatch(owner,'first')
  const run=(await f.command('execution.claim',{executionId:first.id})).result.binding
  await f.command('execution.result',{binding:run,output:{summary:'Original verified evidence'}});await f.command('execution.drained',{binding:run})
  const recorded=(await f.query('execution.get',{executionId:first.id})).results
  await f.command('task.revise',{taskId:'A',request:'Changed authorized goal'})
  await assert.rejects(f.dispatch(owner,'stale-tail'),{code:'DYNAMIC_TASK_REVISION_STALE'})
  await f.restart();assert.equal((await f.query('execution.list')).length,1)
  assert.deepEqual((await f.query('execution.get',{executionId:first.id})).results,recorded)
})
test('T39 execution and notification failures stay separate while unrelated work can run',async t=>{
  const f=await fixture(t);await f.task('A');await f.task('B');const owner=await f.claim('A'),execution=await f.dispatch(owner,'failing-work')
  const binding=(await f.command('execution.claim',{executionId:execution.id})).result.binding
  await f.command('execution.result',{binding,error:{code:'ISOLATED_BUSINESS_FAILURE',message:'Synthetic failure'}})
  await f.command('execution.drained',{binding});await f.command('task.wait',{binding:owner,action:'blocked',summary:'Evidence needs resolution'})
  const notice=await f.notice(),permit=(await f.command('notification.start',{notificationId:notice.id})).result.notification
  await f.command('notification.receipt',{notificationId:notice.id,dispatchToken:permit.dispatchToken,state:'failed',error:{phase:'send',message:'Synthetic delivery failure'}})
  const independent=await f.dispatch(await f.claim('B'),'independent')
  assert.equal((await f.command('execution.claim',{executionId:independent.id})).dispatchEligible,true)
  await f.restart();assert.equal((await f.query('execution.get',{executionId:execution.id})).status,'failed')
  assert.equal((await f.query('notification.get',{notificationId:notice.id})).state,'failed')
  assert.equal((await f.query('task.get',{taskId:'A'})).lastDecision.action,'blocked')
})
test('T40 manual and recovery continuation share one input identity and respect actual resource ownership',async t=>{
  const f=await fixture(t);await f.task('A');await f.task('B')
  const owner=await f.claim('B'),execution=await f.dispatch(owner,'old-work',['shared'])
  const binding=(await f.command('execution.claim',{executionId:execution.id})).result.binding
  await f.command('execution.result',{binding,output:{summary:'Previous input only'}});await f.command('execution.drained',{binding})
  const holder=await f.dispatch(await f.claim('A'),'active-work',['shared']);await f.command('execution.claim',{executionId:holder.id})
  const args={binding:owner,executionId:execution.id,key:'same-authorized-continuation',prompt:'New work',input:{version:2}}
  await Promise.all([f.command('execution.continue',args,'manual-continue'),f.command('execution.continue',args,'recovery-continue')])
  assert.equal((await f.query('execution.get',{executionId:execution.id})).inputVersion,2)
  const claims=await Promise.allSettled([f.command('execution.claim',{executionId:execution.id}),f.command('execution.claim',{executionId:execution.id})])
  assert.ok(claims.every(r=>r.status==='rejected'&&r.reason.code==='DYNAMIC_RESOURCE_BUSY'))
  const locks=await f.query('resource.list');await f.restart()
  assert.equal((await f.query('execution.get',{executionId:execution.id})).inputVersion,2);assert.deepEqual(await f.query('resource.list'),locks)
})
for(const first of ['retire','permit'])test(`T43 known-not-sent retry races explicit retirement via same permit: ${first} first`,async t=>{
  const f=await fixture(t),notice=await f.notice(),firstPermit=(await f.command('notification.start',{notificationId:notice.id})).result.notification
  const guardError={category:'api',code:1,origin:'mcp_gateway',operation:'chat/get_conversation_info',reason:'topic_quote_guard_unavailable',retryable:true,
    message:'无法确认引用回复目标是否属于话题圈，已阻止发送'}
  await f.command('notification.receipt',{notificationId:notice.id,dispatchToken:firstPermit.dispatchToken,state:'failed',nextAttemptAt:new Date(Date.now()+60000).toISOString(),
    error:{phase:'send',exitCode:1,stdout:'',stderr:JSON.stringify({error:guardError}),knownNotSent:true,retryable:true}})
  t.mock.timers.tick(60001)
  const retire=()=>f.command('notification.retireUnsent',{notificationId:notice.id,reason:'superseded',evidenceRef:'explicit-reviewed-replacement'})
  if(first==='retire')await retire()
  await f.command('notification.retry',{notificationId:notice.id})
  assert.equal((await f.command('notification.start',{notificationId:notice.id},'retry-permit')).dispatchEligible,first==='permit')
  if(first==='permit')await assert.rejects(retire(),{code:'DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED'})
  await f.restart();const current=await f.query('notification.get',{notificationId:notice.id})
  assert.equal(current.sendAttemptCount,first==='permit'?2:1);assert.equal(current.payloadDigest,notice.payloadDigest)
  assert.equal((await f.command('notification.start',{notificationId:notice.id})).dispatchEligible,false)
  assert.equal((await f.query('notification.list')).length,1)
})
