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

test('Owner reorder clarification remains visible as an outstanding reason but never overrides terminal facts',()=>{
  const assessment={id:'assessment',state:'needs_clarification',summary:'是否允许保留已发生的页面改动？',evidence:['existing execution log']}
  const result=snapshot([{...member('A','applied'),reorderAssessment:assessment}])
  assert.equal(result.state,'needs_attention')
  assert.equal(result.members[0].blocker,assessment.summary)
  assert.deepEqual(result.members[0].reorderAssessment.evidence,assessment.evidence)
  for(const state of ['fulfilled','cancelled'])assert.equal(snapshot([{...member('A',state),reorderAssessment:assessment}]).members[0].blocker,null)
})

test('pending members stay outstanding while recurring templates are not unexecuted business work', () => {
  const template = {...member('A','template'),recurringTemplateScheduleId:'daily',waitingReason:{code:'target_version_changed'}}
  const build = coordination => coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active',...coordination},
    members:[template],tasks:[{taskId:'A',status:'active',lastDecision:{action:'blocked',summary:'unrelated historical blocker'}}],schedules:[{id:'daily',revision:1,state:'active'}],occurrences:[],jobs:[]})
  assert.deepEqual(build({}).remainingInstructionIds,[])
  assert.equal(build({}).state,'active')
  const pending = build({pendingClarifications:[{clarificationId:'ambiguous',question:'哪一个？'}]})
  assert.equal(pending.state,'needs_attention')
  assert.deepEqual(pending.outstanding.clarificationIds,['ambiguous'])
  const cancelled=build({state:'cancelled',pendingClarifications:[{clarificationId:'ambiguous',question:'哪一个？'}]})
  assert.equal(cancelled.state,'cancelled');assert.deepEqual(cancelled.outstanding.clarificationIds,[])
})

test('fulfilled and individually cancelled members report partial completion and retain distinct member facts', () => {
  const result = snapshot([member('A','fulfilled'),member('B','cancelled')])
  assert.equal(result.state,'partially_completed')
  assert.equal(result.fulfilled,1)
  assert.deepEqual(result.members.map(m=>m.state),['fulfilled','cancelled'])
})

test('a recurring authorization blocked at trigger remains visible as outstanding with its actual reason', () => {
  const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[],tasks:[],
    schedules:[{id:'daily',state:'active',revision:1}],occurrences:[{id:'slot',actionState:'blocked',deliveryState:'none',failureReason:'authorization_changed'}],
    jobs:[{id:'job',state:'blocked',waitingReason:'authorization_changed'}]})
  assert.equal(result.state,'needs_attention');assert.deepEqual(result.outstanding.occurrenceIds,['slot'])
  assert.equal(result.occurrences[0].failureReason,'authorization_changed');assert.equal(result.jobs[0].failureReason,'authorization_changed')
})

test('a past recurring slot retains its own fulfillment without releasing current-version dependencies', () => {
  const old={...member('A','fulfilled'),recurringOccurrenceId:'yesterday',waitingReason:{code:'target_version_changed'},completionProof:{commandId:'old-proof'}}
  const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[old],tasks:[],
    schedules:[{id:'daily',state:'active',revision:1}],occurrences:[],jobs:[]})
  assert.equal(result.state,'active');assert.equal(result.members[0].state,'fulfilled')
  assert.deepEqual(result.remainingInstructionIds,[])
  assert.deepEqual(result.members[0].completionProof,{commandId:'old-proof'})
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
