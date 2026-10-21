import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t,{daily=false}={}) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
  const directory=await mkdtemp(join(tmpdir(),'conditional-query-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'conditional-test',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original goal'})
  await command('source.record',{sourceId:'source-message',groupId:'group',messageId:'message',actorId:'actor',text:'query then continue A only if incomplete',timestamp:'2026-10-21T00:00:00.000Z'})
  const source=(await command('coordination.reserve',{unitId:'unit',revision:1,groupId:'group',original:'query then continue A only if incomplete'})).result.source
  const member={instructionId:'A',taskId:'A',requiresTrigger:true,progressImpact:'preserve',dependencies:[],command:{id:'coordination-command:conditional:A',kind:'task.coordination.input',
    args:{taskId:'A',action:'continue',expectedRequirementRevision:1,expectedControlRevision:1,progressImpact:'preserve',text:'continue original goal',request:'original goal\ncontinue original goal',
      originalSource:{sourceId:'source-message',actorId:'actor',unitId:'unit',unitRevision:1},sourceRefs:[]}}}
  await command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'conditional',members:[member],schedule:{scheduleId:'schedule',timezone:'Asia/Shanghai',
    rule:daily?{kind:'daily',time:'09:00'}:{kind:'once',at:'2026-10-21T01:00:00.000Z'},
    action:{kind:'read-query',taskIds:['A'],onIncomplete:{kind:'task-command',instructionIds:['A']}},target:{conversationId:'group',recipientIds:[]}}})
  return {command,query,tick:ms=>t.mock.timers.tick(ms),
    async due(){t.mock.timers.tick(3600000);return (await command('coordination.schedule.scan')).result.occurrences[0]},
    async run(occurrence){const job=(await command('coordination.job.claim',{jobId:occurrence.jobId})).result.job;return command('coordination.job.read',{jobId:job.id,fence:job.fence})},
    async restart(){await store.close();store=await openDynamicTaskStore(options)}}
}

test('conditional query records fresh facts before applying the explicitly authorized original continuation once',async t=>{
  const f=await fixture(t),before=await f.query('task.get',{taskId:'A'})
  assert.equal((await f.command('coordination.apply',{instructionId:'A',expectedRevision:1})).result.member.state,'ready')
  const occurrence=await f.due(),result=(await f.run(occurrence)).result
  assert.equal(result.occurrence.result.results[0].contextRevision,0)
  assert.equal(result.occurrence.result.conditionalCommands.results.length,1)
  const after=await f.query('task.get',{taskId:'A'})
  assert.equal(after.contextRevision,1);assert.equal(after.requirementRevision,before.requirementRevision);assert.equal(after.runSequence,before.runSequence)
  await f.restart()
  assert.equal((await f.command('coordination.schedule.scan')).result.occurrences.length,0)
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision,1)
})

test('completed at trigger skips the conditional action and never reopens the original Task',async t=>{
  const f=await fixture(t)
  const binding=(await f.command('task.claim',{taskId:'A'})).result.binding
  await f.command('task.complete',{binding,summary:'formal business acceptance',result:{evidence:['isolated-proof']}})
  const before=await f.query('task.get',{taskId:'A'}),result=(await f.run(await f.due())).result
  assert.deepEqual(result.occurrence.result.conditionalCommands.skipped.map(s=>s.reason),['already_completed'])
  assert.deepEqual(await f.query('task.get',{taskId:'A'}),before)
  assert.equal((await f.query('coordination.get',{coordinationId:'conditional'})).members[0].state,'superseded')
})

test('daily conditional continuation gets distinct per-slot identities within the same authorization',async t=>{
  const f=await fixture(t,{daily:true})
  const first=(await f.run(await f.due())).result.occurrence
  // Delivery is an independent obligation; settle the isolated fake receipt so
  // the next periodic slot can start under the serial overlap contract.
  const notification=(await f.command('coordination.notification.freeze',{occurrenceId:first.id})).result.notification
  const permitted=(await f.command('notification.start',{notificationId:notification.id})).result.notification
  await f.command('notification.receipt',{notificationId:notification.id,dispatchToken:permitted.dispatchToken,state:'delivered',messageId:'fake-message'})
  f.tick(86400000)
  const second=(await f.command('coordination.schedule.scan')).result.occurrences[0]
  const result=(await f.run(second)).result.occurrence
  assert.notEqual(result.action.onIncomplete.instructionIds[0],first.action.onIncomplete.instructionIds[0])
  assert.equal((await f.query('task.get',{taskId:'A'})).contextRevision,2)
})

test('changed target scope blocks the conditional write rather than rebasing an old authorization',async t=>{
  const f=await fixture(t)
  await f.command('task.revise',{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,request:'changed goal'})
  const blocked=(await f.run(await f.due())).result
  assert.equal(blocked.job.state,'blocked')
  assert.equal(blocked.job.waitingReason,'DYNAMIC_COORDINATION_VERSION_STALE')
  assert.equal(blocked.occurrence.result.conditionalCommands.results.length,0)
  assert.equal((await f.query('task.get',{taskId:'A'})).request,'changed goal')
})
