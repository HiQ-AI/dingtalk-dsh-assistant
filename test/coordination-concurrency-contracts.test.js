import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
  const directory=await mkdtemp(join(tmpdir(),'coordination-races-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'isolated-races',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original A'})
  const source=(await command('coordination.reserve',{unitId:'unit',revision:1,groupId:'group',original:'query A'})).result.source
  await command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'query',readOnly:true,members:[]})
  await command('coordination.schedule.create',{coordinationId:'query',scheduleId:'schedule',timezone:'Asia/Shanghai',
    rule:{kind:'once',at:'2026-10-21T01:00:00.000Z'},action:{kind:'read-query',taskIds:['A']},target:{conversationId:'group',recipientIds:['old']}})
  t.mock.timers.tick(3600000)
  const occurrence=(await command('coordination.schedule.scan')).result.occurrences[0]
  return {command,query,occurrence,expire:()=>t.mock.timers.tick(300001),async restart(){await store.close();store=await openDynamicTaskStore(options)},
    async notification(){const job=(await command('coordination.job.claim',{jobId:occurrence.jobId})).result.job
      await command('coordination.job.read',{jobId:job.id,fence:job.fence})
      return (await command('coordination.notification.freeze',{occurrenceId:occurrence.id})).result.notification}}
}

const permutations=values=>values.length ? values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(rest=>[v,...rest])) : [[]]

// These are simultaneous producers to one authoritative writer, not a claim that
// SQLite admits competing unowned writers. Enumerate all submission orders.
for(const order of permutations(['change','scan','claim'])) test(`slot replacement, repeat scan and first claim linearize: ${order.join('/')}`,async t=>{
  const f=await fixture(t)
  const actions={change:()=>f.command('coordination.schedule.change',{scheduleId:'schedule',expectedRevision:1,scope:'unstarted',target:{conversationId:'group',recipientIds:['new']}}),
    scan:()=>f.command('coordination.schedule.scan'),claim:()=>f.command('coordination.job.claim',{jobId:f.occurrence.jobId})}
  const results=await Promise.allSettled(order.map(name=>actions[name]()))
  const byName=Object.fromEntries(order.map((name,i)=>[name,results[i]]))
  assert.equal(byName.scan.status,'fulfilled')
  assert.equal(byName.scan.value.result.occurrences.length,0)
  assert.equal([byName.change,byName.claim].filter(r=>r.status==='fulfilled').length,1)
  if(byName.change.status==='fulfilled') {
    assert.equal(byName.claim.reason.code,'DYNAMIC_COORDINATION_CANCELLED')
    const replacement=byName.change.value.result.replacements[0]
    assert.equal(replacement.replacementOf,f.occurrence.id)
    await f.command('coordination.job.claim',{jobId:replacement.jobId})
  } else assert.equal(byName.change.reason.code,'DYNAMIC_COORDINATION_SLOT_CONSUMED')
  await f.restart()
  const occurrences=await f.query('coordination.occurrence.list')
  assert.equal(occurrences.filter(o=>o.actionState==='running').length,1)
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
})

for(const first of ['cancel','permit']) test(`concurrent cancellation and permit: ${first} first`,async t=>{
  const f=await fixture(t),notification=await f.notification()
  const actions={cancel:()=>f.command('coordination.occurrence.cancel',{occurrenceId:f.occurrence.id,expectedControlRevision:1}),
    permit:()=>f.command('notification.start',{notificationId:notification.id},'original-permit')}
  const order=first==='cancel'?['cancel','permit']:['permit','cancel']
  const results=await Promise.all(order.map(name=>actions[name]()))
  assert.equal(results[order.indexOf('permit')].dispatchEligible,first==='permit')
  await f.restart()
  assert.equal((await f.command('notification.start',{notificationId:notification.id},'original-permit')).dispatchEligible,false)
  assert.equal((await f.command('notification.start',{notificationId:notification.id})).dispatchEligible,false)
  const current=await f.query('coordination.occurrence.list')
  assert.equal(current[0].deliveryState,first==='permit'?'unknown':'cancelled')
})

for(const first of ['refresh','permit']) test(`concurrent stale-result replacement and permit: ${first} first`,async t=>{
  const f=await fixture(t),notification=await f.notification();f.expire()
  const actions={refresh:()=>f.command('coordination.notification.refresh',{occurrenceId:f.occurrence.id,expectedNotificationId:notification.id,
    expectedResultVersion:1,expectedInstanceControlRevision:1,expectedDeliveryControlRevision:1}),
    permit:()=>f.command('notification.start',{notificationId:notification.id})}
  const order=first==='refresh'?['refresh','permit']:['permit','refresh']
  const results=await Promise.allSettled(order.map(name=>actions[name]()))
  const byName=Object.fromEntries(order.map((name,i)=>[name,results[i]]))
  assert.equal(byName.permit.status,'fulfilled')
  assert.equal(byName.permit.value.dispatchEligible,first==='permit')
  if(first==='permit') {assert.equal(byName.refresh.status,'rejected');assert.equal(byName.refresh.reason.code,'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED')}
  else assert.equal(byName.refresh.status,'fulfilled')
  await f.restart()
  const candidates=await f.query('notification.list')
  assert.equal(candidates.length,first==='refresh'?2:1)
  assert.equal((await f.command('notification.start',{notificationId:notification.id})).dispatchEligible,false)
})
