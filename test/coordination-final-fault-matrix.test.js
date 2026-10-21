import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import {openIndependentCoordination} from '../packages/dingtalk-dsh-assistant/independent-coordination-service.js'

async function fixture(t, instant='2026-10-21T00:00:00Z') {
  t.mock.timers.enable({apis:['Date'],now:Date.parse(instant)})
  const directory=await mkdtemp(join(tmpdir(),'coordination-final-fault-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'fault-matrix',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  const reserve=async unitId=>(await command('coordination.reserve',{unitId,revision:1,groupId:'group',original:`original ${unitId}`})).result.source
  const member=(coord,id,taskId,dependencies=[])=>({instructionId:id,taskId,dependencies,progressImpact:'preserve',command:{
    id:`coordination-command:${coord}:${id}`,kind:'task.supplement',args:{taskId,expectedRequirementRevision:1,expectedControlRevision:1,
      messageId:id,text:`material ${id}`,request:`${taskId}\nmaterial ${id}`}}})
  const arrange=async(coord,members,extra={})=>{const source=await reserve(coord);return command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:coord,members,...extra})}
  const task=taskId=>command('task.create',{taskId,groupId:'group',request:taskId})
  async function schedule(rule={kind:'once',at:'2026-10-21T01:00:00.000Z'},timezone='Asia/Shanghai') {
    await task('A');await arrange('query',[],{readOnly:true})
    return command('coordination.schedule.create',{scheduleId:'schedule',coordinationId:'query',timezone,rule,
      action:{kind:'read-query',taskIds:['A']},target:{conversationId:'group',recipientIds:[]}})
  }
  return {options,command,query,reserve,member,arrange,task,schedule,
    async restart(){await store.close();store=await openDynamicTaskStore(options)},
    async restartFenced(){await assert.rejects(store.close(),{code:'DYNAMIC_STORE_FENCED'});store=await openDynamicTaskStore(options)}}
}

// Finite transaction write boundaries: before/after each independently stored
// domain row. This is not a claim to enumerate every machine instruction.
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

for(const table of ['dynamic_coordination_members','dynamic_coordination','dynamic_coordination_sources'])
for(const when of ['before','after'])test(`T03 acceptance rollback at ${table} ${when} preserves reserved source and zero Task effects`,async t=>{
  const f=await fixture(t);await f.task('A');const source=await f.reserve('unit')
  const input={sourceId:source.id,fence:1,coordinationId:'batch',members:[f.member('batch','a','A')]}
  const injected=failWrite(t,table,when)
  try{await assert.rejects(f.command('coordination.accept',input),/injected/)}finally{injected.restore()}
  assert.equal(injected.fired(),true);await f.restart()
  assert.equal((await f.query('coordination.source',{unitId:'unit',revision:1})).state,'reserved')
  assert.deepEqual(await f.query('coordination.list'),[]);assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision??0,0)
  await f.command('coordination.accept',input)
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).members.length,1)
})

for(const table of ['dynamic_coordination_occurrences','dynamic_coordination_slots','dynamic_coordination_jobs','dynamic_coordination_schedules'])
for(const when of ['before','after'])test(`T23 due scan rollback at ${table} ${when} keeps occurrence and cursor atomic`,async t=>{
  const f=await fixture(t);await f.schedule();t.mock.timers.tick(3600000)
  const before=(await f.query('coordination.schedule.list'))[0],injected=failWrite(t,table,when)
  try{await assert.rejects(f.command('coordination.schedule.scan'),/injected/)}finally{injected.restore()}
  assert.equal(injected.fired(),true);await f.restart()
  assert.deepEqual(await f.query('coordination.occurrence.list'),[]);assert.deepEqual(await f.query('coordination.job.list'),[])
  assert.deepEqual((await f.query('coordination.schedule.list'))[0],before)
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,1)
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
})

for(const when of ['before','after'])test(`T03 T23 due scan COMMIT ${when} acknowledgement failure reconciles exact original command`,async t=>{
  const f=await fixture(t);await f.schedule();t.mock.timers.tick(3600000)
  const original=DatabaseSync.prototype.exec;let fired=false
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(sql){
    if(sql==='COMMIT'&&!fired){fired=true;if(when==='before')throw new Error('injected commit before')
      const value=original.call(this,sql);throw Object.assign(new Error('injected commit acknowledgement after'),{value})}
    return original.call(this,sql)
  })
  try{await assert.rejects(f.command('coordination.schedule.scan',{},'exact-scan-identity'),{code:'DYNAMIC_COMMIT_ACK_UNKNOWN'})}finally{mock.mock.restore()}
  await f.restart()
  assert.equal((await f.query('coordination.occurrence.list')).length,when==='after'?1:0)
  const reconciled=await f.command('coordination.schedule.scan',{},'exact-scan-identity')
  assert.equal(reconciled.replayed===true,when==='after')
  assert.equal(reconciled.result.occurrences.length,1)
  assert.equal((await f.query('coordination.occurrence.list')).length,1)
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
})

for(const first of ['left','right'])test(`T07 cross-coordination opposing dependency producers: ${first} wins and reverse cycle rolls back`,async t=>{
  const f=await fixture(t);await f.task('A');await f.task('B')
  const left=await f.reserve('left'),right=await f.reserve('right')
  // Parent A/B roots exist in the opposite coordination, so both proposed
  // arrangements can legally reference stable instructions before racing changes.
  await f.command('coordination.accept',{sourceId:left.id,fence:1,coordinationId:'left',members:[f.member('left','a','A')]})
  await f.command('coordination.accept',{sourceId:right.id,fence:1,coordinationId:'right',members:[f.member('right','b','B')]})
  const changes={left:await f.reserve('left-change'),right:await f.reserve('right-change')}
  const actions={left:()=>f.command('coordination.change',{sourceId:changes.left.id,fence:1,coordinationId:'left',expectedRevision:1,
    change:{action:'reorder',dependencies:[{instructionId:'a',afterInstructionIds:['b']}]}}),
    right:()=>f.command('coordination.change',{sourceId:changes.right.id,fence:1,coordinationId:'right',expectedRevision:1,
      change:{action:'reorder',dependencies:[{instructionId:'b',afterInstructionIds:['a']}]}})}
  const order=first==='left'?['left','right']:['right','left'],results=await Promise.allSettled(order.map(name=>actions[name]()))
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'DYNAMIC_COORDINATION_CYCLE')
  await f.restart();assert.equal((await f.query('coordination.get',{coordinationId:order[0]})).coordination.revision,2)
  assert.equal((await f.query('coordination.get',{coordinationId:order[1]})).coordination.revision,1)
})

test('T18 second supported writer refuses live owner and expired incarnation rejects coordination writes',async t=>{
  const f=await fixture(t);await assert.rejects(openDynamicTaskStore(f.options),{code:'DYNAMIC_STORE_ALREADY_OPEN'})
  const external=new DatabaseSync(f.options.dbPath)
  // Administrative fault injection models owner takeover, not an assertion that
  // SQLite is a sandbox against arbitrary code already authorized to the file.
  external.prepare("UPDATE dynamic_meta SET value='999999999:fault-takeover' WHERE key='owner'").run();external.close()
  await assert.rejects(f.reserve('stale-writer'),{code:'DYNAMIC_STORE_FENCED'})
  await assert.rejects(f.command('coordination.schedule.scan'),{code:'DYNAMIC_STORE_FENCED'})
  await f.restartFenced();assert.deepEqual(await f.query('coordination.list'),[])
})

test('T08 cancelled arrangement cannot be resurrected by old apply or recovered wake and does not cancel original Task',async t=>{
  const f=await fixture(t);await f.task('A');await f.arrange('batch',[f.member('batch','a','A')])
  const wakesBefore=await f.query('wake.list',{taskId:'A'})
  await f.command('coordination.cancel',{coordinationId:'batch',expectedRevision:1});await f.restart()
  await assert.rejects(f.command('coordination.apply',{instructionId:'a',expectedRevision:1}),{code:'DYNAMIC_COORDINATION_REVISION_STALE'})
  const task=await f.query('task.get',{taskId:'A'});assert.equal(task.status,'active');assert.equal(task.control,'active')
  assert.deepEqual(await f.query('wake.list',{taskId:'A'}),wakesBefore)
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).members[0].state,'cancelled')
})

test('T32 forward jump coalesces latest slot and backward clock plus restart cannot repeat accepted UTC slot',async t=>{
  const f=await fixture(t,'2026-10-20T00:00:00Z');await f.schedule({kind:'daily',time:'09:00'})
  t.mock.timers.setTime(Date.parse('2026-10-25T01:00:00Z'))
  const accepted=(await f.command('coordination.schedule.scan')).result.occurrences
  assert.equal(accepted.length,1);assert.equal(accepted[0].plannedAt,'2026-10-25T01:00:00.000Z');assert.ok(accepted[0].merged>0)
  t.mock.timers.setTime(Date.parse('2026-10-22T01:00:00Z'));await f.restart()
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
  t.mock.timers.setTime(Date.parse('2026-10-25T01:00:00Z'))
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
  assert.equal((await f.query('coordination.occurrence.list')).length,1)
})

test('T50 actual dispatcher stops unapplied tail after mid-batch version conflict without compensation',async t=>{
  const f=await fixture(t);for(const id of ['A','B','C'])await f.task(id)
  await f.arrange('batch',['A','B','C'].map(id=>f.member('batch',id,id)),{allTogether:true})
  const applied=[],errors=[]
  const service=openIndependentCoordination({config:{},residentStore:{listSourceDispatchOwnership:()=>[]},query:f.query,command:f.command,
    planner:{close(){}},onApplied:async member=>{applied.push(member.id);if(member.id==='A')await f.command('task.revise',{taskId:'B',request:'concurrent new goal'})},
    onError:(_id,error)=>errors.push(error.code)})
  t.after(()=>service.close());await service.recoverGroup('group')
  assert.deepEqual(applied,['A']);assert.ok(errors.includes('DYNAMIC_COORDINATION_VERSION_STALE'))
  const state=await f.query('coordination.get',{coordinationId:'batch'})
  assert.deepEqual(state.members.map(m=>m.state),['applied','ready','ready'])
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision,1)
  assert.equal((await f.query('task.get',{taskId:'C'})).contextRevision??0,0)
  assert.equal(state.coordination.lifecycleState,'needs_attention')
})

test('T39 execution failure and notification failure remain separate while an independent member still receives its input',async t=>{
  const f=await fixture(t);await f.task('A');await f.task('B');await f.arrange('batch',[f.member('batch','a','A'),f.member('batch','b','B')])
  await f.command('coordination.apply',{instructionId:'a',expectedRevision:1})
  const owner=(await f.command('task.claim',{taskId:'A'})).result.binding
  const execution=(await f.command('execution.dispatch',{binding:owner,key:'failing-work',prompt:'work',input:{}})).result.execution
  const binding=(await f.command('execution.claim',{executionId:execution.id})).result.binding
  await f.command('execution.result',{binding,error:{code:'ISOLATED_BUSINESS_FAILURE',message:'expected test failure'}})
  await f.command('execution.drained',{binding})
  await f.command('task.wait',{binding:owner,action:'blocked',summary:'specific failed evidence needs resolution'})
  const notice=(await f.command('notification.prepare',{notificationId:'batch-failure',kind:'coordination',requirementRevision:1,
    payload:{conversationId:'group',text:'A business failure',fact:{coordinationId:'batch',eventId:'failure'}}})).result.notification
  const permit=(await f.command('notification.start',{notificationId:notice.id})).result.notification
  await f.command('notification.receipt',{notificationId:notice.id,dispatchToken:permit.dispatchToken,state:'failed',error:{phase:'send',message:'isolated delivery failure'}})
  await f.command('coordination.apply',{instructionId:'b',expectedRevision:1});await f.command('coordination.aggregate',{coordinationId:'batch'});await f.restart()
  assert.equal((await f.query('execution.get',{executionId:execution.id})).status,'failed')
  assert.equal((await f.query('notification.get',{notificationId:notice.id})).state,'failed')
  assert.equal((await f.query('task.get',{taskId:'B'})).contextRevision,1)
  assert.equal((await f.query('task.get',{taskId:'A'})).lastDecision.action,'blocked')
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).coordination.lifecycleState,'needs_attention')
})

test('T40 concurrent manual and recovery continuation share a new input identity and both claims respect dependency lock gate',async t=>{
  const f=await fixture(t);await f.task('A');await f.task('B')
  const owner=(await f.command('task.claim',{taskId:'B'})).result.binding
  const execution=(await f.command('execution.dispatch',{binding:owner,key:'old-work',prompt:'old work',input:{},resourceKeys:['shared']})).result.execution
  const binding=(await f.command('execution.claim',{executionId:execution.id})).result.binding
  await f.command('execution.result',{binding,output:{summary:'previous input only'}});await f.command('execution.drained',{binding})
  await f.arrange('batch',[f.member('batch','a','A'),f.member('batch','b','B',['a'])])
  const args={binding:owner,executionId:execution.id,key:'same-authorized-continuation',prompt:'new constrained work',input:{version:2}}
  await Promise.all([f.command('execution.continue',args,'manual-continue'),f.command('execution.continue',args,'recovery-continue')])
  assert.equal((await f.query('execution.get',{executionId:execution.id})).inputVersion,2)
  const claims=await Promise.allSettled([f.command('execution.claim',{executionId:execution.id}),f.command('execution.claim',{executionId:execution.id})])
  assert.ok(claims.every(r=>r.status==='rejected'&&r.reason.code==='DYNAMIC_COORDINATION_WAITING'))
  assert.deepEqual(await f.query('resource.list'),[]);await f.restart()
  assert.equal((await f.query('execution.get',{executionId:execution.id})).inputVersion,2)
  assert.deepEqual(await f.query('resource.list'),[])
})

for(const first of ['cancel','permit'])test(`T43 known-not-sent retry settles original attempt and races cancellation via same permit: ${first} first`,async t=>{
  const f=await fixture(t);await f.arrange('query',[],{readOnly:true})
  const notice=(await f.command('notification.prepare',{notificationId:'retry-notice',kind:'coordination',requirementRevision:1,
    payload:{conversationId:'group',text:'frozen quoted coordination',sourceMessageId:'source',actorId:'actor',fact:{coordinationId:'query',eventId:'acceptance'}}})).result.notification
  const firstPermit=(await f.command('notification.start',{notificationId:notice.id})).result.notification
  const guardError={category:'api',code:1,origin:'mcp_gateway',operation:'chat/get_conversation_info',reason:'topic_quote_guard_unavailable',retryable:true,
    message:'无法确认引用回复目标是否属于话题圈，已阻止发送'}
  await f.command('notification.receipt',{notificationId:notice.id,dispatchToken:firstPermit.dispatchToken,state:'failed',nextAttemptAt:new Date(Date.now()+60000).toISOString(),
    error:{phase:'send',exitCode:1,stdout:'',stderr:JSON.stringify({error:guardError}),knownNotSent:true,retryable:true}})
  t.mock.timers.tick(60001);await f.command('notification.retry',{notificationId:notice.id})
  const actions={cancel:()=>f.command('coordination.cancel',{coordinationId:'query',expectedRevision:1}),permit:()=>f.command('notification.start',{notificationId:notice.id},'retry-permit')}
  const order=first==='cancel'?['cancel','permit']:['permit','cancel'],results=await Promise.all(order.map(name=>actions[name]()))
  assert.equal(results[order.indexOf('permit')].dispatchEligible,first==='permit')
  await f.restart();const current=await f.query('notification.get',{notificationId:notice.id})
  assert.equal(current.sendAttemptCount,first==='permit'?2:1)
  assert.equal(current.payloadDigest,notice.payloadDigest)
  assert.equal((await f.command('notification.start',{notificationId:notice.id})).dispatchEligible,false)
  assert.equal((await f.query('notification.list')).length,1)
})
