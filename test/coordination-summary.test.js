import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { coordinationSnapshot } from '../packages/dingtalk-dsh-assistant/coordination-summary.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

const member = (id, state) => ({ id, taskId: id, state, control: state === 'cancelled' ? 'cancelled' : 'active',
  command: { id: `command:${id}`, args: { request: `goal:${id}` } } })
const snapshot = members => coordinationSnapshot({ coordination: { id: 'coordination', revision: 2, state: 'active' },
  members, tasks: members.map(m => ({ taskId: m.taskId, status: m.state === 'fulfilled' ? 'completed' : 'active' })),
  schedules: [], occurrences: [], jobs: [] })

test('historical Owner blockers do not override completed or cancelled member facts', () => {
  for (const state of ['fulfilled','cancelled']) {
    const result = coordinationSnapshot({ coordination: { id: 'coordination', revision: 2, state: 'active' },
      members: [member('A',state)], tasks: [{taskId:'A',status:state === 'fulfilled' ? 'completed' : 'active',
        lastDecision:{action:'blocked',summary:'historical blocker'}}], schedules:[],occurrences:[],jobs:[] })
    assert.equal(result.state,state === 'fulfilled' ? 'completed' : 'cancelled')
    assert.equal(result.members[0].blocker,null)
  }
})

test('all individually cancelled members report cancelled rather than zero-result business completion', () => {
  const result = snapshot([member('A','cancelled'),member('B','cancelled')])
  assert.equal(result.state,'cancelled')
  assert.equal(result.fulfilled,0)
  assert.deepEqual(result.remainingInstructionIds,[])
})

test('fulfilled and individually cancelled members report partial completion and retain distinct member facts', () => {
  const result = snapshot([member('A','fulfilled'),member('B','cancelled')])
  assert.equal(result.state,'partially_completed')
  assert.equal(result.fulfilled,1)
  assert.deepEqual(result.members.map(m=>m.state),['fulfilled','cancelled'])
})

test('unsent summary A superseded by active facts B can freeze A again, while an unknown permitted summary keeps its identity', async t => {
  const directory=await mkdtemp(join(tmpdir(),'coordination-summary-'))
  const store=await openDynamicTaskStore({dbPath:join(directory,'tasks.sqlite'),instanceId:'summary-test',initialize:true})
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original goal'})
  const source=(await command('coordination.reserve',{unitId:'unit',revision:1,groupId:'group',original:'extra material'})).result.source
  await command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'coordination',members:[{
    instructionId:'instruction',taskId:'A',progressImpact:'preserve',dependencies:[],command:{id:'coordination-command:coordination:instruction',kind:'task.supplement',
      args:{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,messageId:'material',text:'extra material',request:'goal and material'}}}]})
  const binding=(await command('task.claim',{taskId:'A'})).result.binding
  await command('task.wait',{binding,action:'blocked',summary:'need verified evidence'})
  const first=(await command('coordination.aggregate',{coordinationId:'coordination'})).result.notification
  assert.ok(first)
  await command('task.wait',{binding,action:'wait',summary:'working'})
  await command('coordination.aggregate',{coordinationId:'coordination'})
  assert.equal((await store.query({kind:'notification.get',notificationId:first.id})).state,'superseded')
  await command('task.wait',{binding,action:'blocked',summary:'need verified evidence'})
  const returned=(await command('coordination.aggregate',{coordinationId:'coordination'})).result
  const second=returned.notification
  assert.equal(returned.snapshot.state,'needs_attention')
  assert.ok(second,'the earlier A candidate never received a send permit, so its supersession must not suppress the later A summary')
  assert.notEqual(second.id,first.id)
  assert.equal((await command('notification.start',{notificationId:first.id})).dispatchEligible,false)
  const permitted=(await command('notification.start',{notificationId:second.id})).result.notification
  await command('notification.receipt',{notificationId:second.id,dispatchToken:permitted.dispatchToken,state:'unknown'})
  await command('task.wait',{binding,action:'blocked',summary:'different new evidence missing'})
  const changed=(await command('coordination.aggregate',{coordinationId:'coordination'})).result
  assert.equal(changed.notification,undefined)
  assert.equal(changed.coordination.summaryNotificationId,second.id)
  const frozen=await store.query({kind:'notification.get',notificationId:second.id})
  assert.equal(frozen.state,'unknown')
  assert.equal(frozen.payloadDigest,second.payloadDigest)
  assert.deepEqual((await store.query({kind:'notification.list'})).map(n=>n.id),[first.id,second.id])
})
