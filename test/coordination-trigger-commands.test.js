import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t, { members = ['B'], dependencies = {}, scheduled = true, replan = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const directory = await mkdtemp(join(tmpdir(), 'coordination-trigger-'))
  const config = { dbPath: join(directory, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(config)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  for (const id of ['A','B']) await command('task.create', { taskId: id, groupId: 'group', request: id })
  const source = (await command('coordination.reserve', { unitId: 'source-unit', revision: 1, groupId: 'group', original: '到9点继续原任务' })).result.source
  const target = { conversationId: 'group', recipientIds: ['member-id'] }
  const member = id => ({ instructionId: id, taskId: id, progressImpact: replan ? 'replan' : 'preserve', dependencies: dependencies[id] ?? [],
    command: { id: `coordination-command:batch:${id}`, kind: replan ? 'task.revise' : 'task.supplement', args: { taskId: id,
      expectedRequirementRevision: 1, expectedControlRevision: 1, messageId: `input:${id}`, text: '按原目标继续', request: `${id}\n按原目标继续` } } })
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'batch',
    members: members.map(member), readOnly: members.length === 0,
    ...(scheduled ? { schedule: { scheduleId: 'schedule', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' },
      action: { kind: 'task-command', instructionIds: ['B'] }, target } } : {}) })
  return { command, query, target, tick: value => t.mock.timers.tick(value),
    task: id => query('task.get', { taskId: id }),
    async due() { t.mock.timers.tick(3600000); return (await command('coordination.schedule.scan')).result.occurrences[0] },
    async claim(occurrence) { return (await command('coordination.job.claim', { jobId: occurrence.jobId })).result.job },
    async restart() { await store.close(); store = await openDynamicTaskStore(config) },
  }
}

test('timer defers a frozen original Task command until due and receives it once without a new Task or session', async t => {
  const f = await fixture(t)
  const early = await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })
  assert.equal(early.result.member.state, 'ready')
  assert.equal((await f.task('B')).contextRevision ?? 0, 0)
  const occurrence = await f.due(), job = await f.claim(occurrence)
  const repeatedTrigger = await f.command('coordination.occurrence.accept', { coordinationId: 'batch', trigger: occurrence.trigger,
    action: { kind: 'task-command', instructionIds: ['B'] }, target: f.target })
  assert.equal(repeatedTrigger.result.occurrence.id, occurrence.id)
  assert.equal(repeatedTrigger.result.replayed, true)
  const applied = await f.command('coordination.job.command', { jobId: job.id, fence: job.fence }, 'due-job-command')
  assert.equal(applied.result.job.state, 'completed')
  assert.equal(applied.result.occurrence.actionState, 'succeeded')
  assert.equal(applied.result.occurrence.result.results[0].commandId, 'coordination-command:batch:B')
  assert.equal((await f.task('B')).contextRevision, 1)
  assert.equal((await f.query('task.list')).length, 2)
  assert.equal((await f.query('execution.list')).length, 0)
  assert.equal((await f.task('B')).runSequence, 1)
  await f.restart()
  assert.equal((await f.command('coordination.job.command', { jobId: job.id, fence: job.fence }, 'due-job-command')).replayed, true)
  assert.equal((await f.task('B')).contextRevision, 1)
  assert.ok(await f.query('receipt.get', { id: 'coordination-command:batch:B' }))
})

test('daily accepted authorization freezes a new exact command per slot and recovers without another user confirmation', async t => {
  const f = await fixture(t, { scheduled: false })
  await f.command('coordination.schedule.create', { coordinationId: 'batch', scheduleId: 'recurring', timezone: 'Asia/Shanghai',
    rule: { kind: 'daily', time: '09:00' }, action: { kind: 'task-command', instructionIds: ['B'] }, target: { ...f.target, summaryOnly:true } })
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).members[0].state,'template')
  const first = await f.due(), firstJob = await f.claim(first)
  const applied = await f.command('coordination.job.command',{jobId:firstJob.id,fence:firstJob.fence},'first-slot')
  const firstInstruction = applied.result.occurrence.action.instructionIds[0]
  assert.notEqual(firstInstruction,'B')
  assert.equal((await f.command('coordination.occurrence.accept',{coordinationId:'batch',trigger:first.trigger,
    action:{kind:'task-command',instructionIds:['B']},target:{...f.target,summaryOnly:true}})).result.replayed,true)
  assert.equal((await f.task('B')).contextRevision,1)
  await f.restart()
  assert.equal((await f.command('coordination.job.command',{jobId:firstJob.id,fence:firstJob.fence},'first-slot')).replayed,true)
  await f.command('task.supplement',{taskId:'B',expectedRequirementRevision:1,expectedControlRevision:1,messageId:'compatible',text:'新增材料',request:'B\n新增材料'})
  f.tick(86400000)
  const second = (await f.command('coordination.schedule.scan')).result.occurrences[0], secondJob = await f.claim(second)
  const next = await f.command('coordination.job.command',{jobId:secondJob.id,fence:secondJob.fence})
  const secondInstruction = next.result.occurrence.action.instructionIds[0]
  assert.notEqual(firstInstruction,secondInstruction)
  assert.equal((await f.task('B')).contextRevision,3)
  assert.match((await f.task('B')).request,/新增材料/)
  assert.notEqual(next.result.job.result.results[0].commandId,applied.result.job.result.results[0].commandId)
  assert.equal((await f.query('task.list')).length,2)
  assert.equal((await f.task('B')).runSequence,1)
})

test('weekly command blocks a changed goal instead of extending its old recurring authorization', async t => {
  const f = await fixture(t, { scheduled:false })
  await f.command('coordination.schedule.create',{coordinationId:'batch',scheduleId:'weekly',timezone:'Asia/Shanghai',
    rule:{kind:'weekly',time:'09:00',weekday:3},action:{kind:'task-command',instructionIds:['B']},target:f.target})
  await f.command('task.revise',{taskId:'B',request:'用户另行修改目标'})
  const occurrence = await f.due(), job = await f.claim(occurrence)
  const result = await f.command('coordination.job.command',{jobId:job.id,fence:job.fence})
  assert.equal(result.result.job.state,'blocked')
  assert.equal(result.result.job.waitingReason,'DYNAMIC_COORDINATION_RECURRING_AUTHORIZATION_STALE')
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).members.length,1)
  assert.equal((await f.task('B')).requirementRevision,2)
  assert.equal((await f.task('B')).contextRevision ?? 0,0)
})

test('future schedule edits preserve each slot authorized original text rather than replacing it with the control message', async t => {
  const f=await fixture(t,{scheduled:false})
  await f.command('coordination.schedule.create',{coordinationId:'batch',scheduleId:'daily-edit',timezone:'Asia/Shanghai',
    rule:{kind:'daily',time:'09:00'},action:{kind:'task-command',instructionIds:['B']},target:{...f.target,summaryOnly:true}})
  const source=(await f.command('coordination.reserve',{unitId:'edit',revision:1,groupId:'group',original:'改到10点'})).result.source
  await f.command('coordination.change',{sourceId:source.id,fence:source.fence,coordinationId:'batch',expectedRevision:1,
    change:{action:'schedule',scheduleChange:{scheduleId:'daily-edit',expectedRevision:1,rule:{kind:'daily',time:'10:00'}}}})
  f.tick(7200000)
  const occurrence=(await f.command('coordination.schedule.scan')).result.occurrences[0],job=await f.claim(occurrence)
  await f.command('coordination.job.command',{jobId:job.id,fence:job.fence})
  const child=(await f.query('coordination.get',{coordinationId:'batch'})).members.find(member=>member.recurringOccurrenceId)
  assert.equal(child.original,'到9点继续原任务')
  assert.equal(child.materializationSourceId,source.id)
  assert.equal(child.templateInstructionId,'B')
})

test('recurring replan advances only through its own prior effective target version', async t => {
  const f = await fixture(t,{scheduled:false,replan:true})
  await f.command('coordination.schedule.create',{coordinationId:'batch',scheduleId:'daily-replan',timezone:'Asia/Shanghai',
    rule:{kind:'daily',time:'09:00'},action:{kind:'task-command',instructionIds:['B']},target:{...f.target,summaryOnly:true}})
  for(const elapsed of [3600000,86400000]) {
    f.tick(elapsed)
    const occurrence=(await f.command('coordination.schedule.scan')).result.occurrences[0], job=await f.claim(occurrence)
    assert.equal((await f.command('coordination.job.command',{jobId:job.id,fence:job.fence})).result.job.state,'completed')
  }
  assert.equal((await f.task('B')).requirementRevision,3)
  const state=await f.query('coordination.get',{coordinationId:'batch'})
  assert.deepEqual(state.members.filter(member=>member.recurringOccurrenceId).map(member=>member.command.args.expectedRequirementRevision),[1,2])
  const children=state.members.filter(member=>member.recurringOccurrenceId)
  assert.equal(children[0].state,'superseded')
  assert.equal(children[0].supersededBy,children[1].id)
  const aggregate=(await f.command('coordination.aggregate',{coordinationId:'batch'})).result.snapshot
  assert.equal(aggregate.state,'active')
  assert.ok(!aggregate.remainingInstructionIds.includes(children[0].id))
  await f.command('task.revise',{taskId:'B',request:'计划外新目标'})
  f.tick(86400000)
  const occurrence=(await f.command('coordination.schedule.scan')).result.occurrences[0], job=await f.claim(occurrence)
  assert.equal((await f.command('coordination.job.command',{jobId:job.id,fence:job.fence})).result.job.state,'blocked')
  assert.equal((await f.task('B')).requirementRevision,4)
})

test('per-slot instruction creation and Task effects survive lost acknowledgement under the original frozen identity', async t => {
  const f=await fixture(t,{scheduled:false})
  await f.command('coordination.schedule.create',{coordinationId:'batch',scheduleId:'daily-ack',timezone:'Asia/Shanghai',
    rule:{kind:'daily',time:'09:00'},action:{kind:'task-command',instructionIds:['B']},target:{...f.target,summaryOnly:true}})
  const occurrence=await f.due(), job=await f.claim(occurrence)
  const original=DatabaseSync.prototype.exec
  let armed=true
  const mocked=t.mock.method(DatabaseSync.prototype,'exec',function(sql){
    const result=original.call(this,sql)
    if(sql==='COMMIT'&&armed){armed=false;throw new Error('injected per-slot ACK loss')}
    return result
  })
  await assert.rejects(f.command('coordination.job.command',{jobId:job.id,fence:job.fence},'slot-ack'),{code:'DYNAMIC_COMMIT_ACK_UNKNOWN'})
  mocked.mock.restore();await f.restart()
  const replay=await f.command('coordination.job.command',{jobId:job.id,fence:job.fence},'slot-ack')
  assert.equal(replay.replayed,true)
  assert.equal((await f.task('B')).contextRevision,1)
  const members=(await f.query('coordination.get',{coordinationId:'batch'})).members.filter(member=>member.recurringOccurrenceId)
  assert.equal(members.length,1)
  assert.equal(members[0].command.id,replay.result.job.result.results[0].commandId)
})

test('lost commit acknowledgement is reconciled by the original Task command receipt after restart', async t => {
  const f = await fixture(t)
  const occurrence = await f.due(), job = await f.claim(occurrence)
  const original = DatabaseSync.prototype.exec
  let armed = true
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    const result = original.call(this, sql)
    if (sql === 'COMMIT' && armed) { armed = false; throw new Error('injected lost commit acknowledgement') }
    return result
  })
  await assert.rejects(f.command('coordination.job.command', { jobId: job.id, fence: job.fence }, 'commit-ack-unknown'), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN' })
  mocked.mock.restore()
  await f.restart()
  const receipt = await f.query('receipt.get', { id: 'coordination-command:batch:B' })
  assert.equal(receipt.result.task.contextRevision, 1)
  assert.equal((await f.task('B')).contextRevision, 1)
  const repeated = await f.command('coordination.job.command', { jobId: job.id, fence: job.fence }, 'commit-ack-unknown')
  assert.equal(repeated.replayed, true)
  assert.equal((await f.task('B')).contextRevision, 1)
})

test('due Task command waits for authoritative dependencies and later reuses its frozen command identity', async t => {
  const f = await fixture(t, { members: ['A','B'], dependencies: { B: ['A'] } })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const occurrence = await f.due(), first = await f.claim(occurrence)
  const waiting = await f.command('coordination.job.command', { jobId: first.id, fence: first.fence })
  assert.equal(waiting.result.job.state, 'waiting')
  assert.equal(waiting.result.job.waitingReason, 'waiting_dependency')
  assert.equal((await f.task('B')).contextRevision ?? 0, 0)
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding: owner, summary: 'A验收完成', result: { evidence: ['A-proof'] } })
  const second = await f.claim(occurrence)
  const finished = await f.command('coordination.job.command', { jobId: second.id, fence: second.fence })
  assert.equal(finished.result.job.state, 'completed')
  assert.equal((await f.task('B')).contextRevision, 1)
  assert.equal(finished.result.job.result.results[0].commandId, 'coordination-command:batch:B')
})

test('stale frozen Task version is rejected rather than recomputing expected versions under the same command', async t => {
  const f = await fixture(t)
  await f.command('task.revise', { taskId: 'B', request: '新目标' })
  const occurrence = await f.due(), job = await f.claim(occurrence)
  await assert.rejects(f.command('coordination.job.command', { jobId: job.id, fence: job.fence }), { code: 'DYNAMIC_COORDINATION_VERSION_STALE' })
  assert.equal(await f.query('receipt.get', { id: 'coordination-command:batch:B' }), null)
  assert.equal((await f.task('B')).requirementRevision, 2)
})

test('replacing a future Task-command template cannot return its old ready member to immediate dispatch', async t => {
  const f = await fixture(t)
  await f.command('coordination.schedule.change', { scheduleId: 'schedule', expectedRevision: 1,
    action: { kind: 'read-query', taskIds: ['A'] } })
  const member = (await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.member
  assert.equal(member.state, 'ready')
  assert.equal((await f.task('B')).contextRevision ?? 0, 0)
})

test('message trigger needs no schedule fields and deduplicates each stable source revision/action', async t => {
  const f = await fixture(t, { members: [], scheduled: false })
  const args = { coordinationId: 'batch', trigger: { triggerKind: 'message', sourceUnitId: 'source-unit', sourceUnitRevision: 1, actionId: 'query' },
    action: { kind: 'read-query', taskIds: ['A'] }, target: f.target }
  const first = (await f.command('coordination.occurrence.accept', args)).result.occurrence
  const repeat = await f.command('coordination.occurrence.accept', args)
  assert.equal(repeat.result.occurrence.id, first.id)
  assert.equal(repeat.result.replayed, true)
  for (const key of ['scheduleId','acceptedScheduleRevision','plannedAt','slotId']) assert.equal(Object.hasOwn(first, key), false)
  await assert.rejects(f.command('coordination.occurrence.accept', { ...args, trigger: { ...args.trigger, scheduleId: 'fake' } }), { code: 'DYNAMIC_COORDINATION_TRIGGER_INVALID' })
  await assert.rejects(f.command('coordination.occurrence.accept', { ...args, action: { kind: 'read-query', taskIds: ['B'] } }), { code: 'DYNAMIC_COORDINATION_TRIGGER_CONFLICT' })
  const job = await f.claim(first)
  assert.equal((await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })).result.occurrence.actionState, 'succeeded')
})

test('one authoritative business event may trigger two different actions but never the same action twice', async t => {
  const f = await fixture(t, { members: [], scheduled: false })
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  const completed = await f.command('task.complete', { binding: owner, summary: 'A完成', result: { evidence: ['A'] } })
  const args = { coordinationId: 'batch', trigger: { triggerKind: 'business-event', eventSource: 'task-ledger', eventId: completed.completionEvent.id, actionId: 'query-A' },
    action: { kind: 'read-query', taskIds: ['A'] }, target: f.target }
  const first = (await f.command('coordination.occurrence.accept', args)).result.occurrence
  assert.equal((await f.command('coordination.occurrence.accept', args)).result.occurrence.id, first.id)
  const second = (await f.command('coordination.occurrence.accept', { ...args, trigger: { ...args.trigger, actionId: 'query-B' }, action: { kind: 'read-query', taskIds: ['B'] } })).result.occurrence
  assert.notEqual(first.id, second.id)
  assert.equal((await f.query('coordination.occurrence.list')).length, 2)
  await f.command('task.drained', { binding: owner })
  await f.command('task.reopen', { taskId: 'A', request: 'A变更目标' })
  await assert.rejects(f.claim(first), { code: 'DYNAMIC_COORDINATION_EVENT_STALE' })
})

test('business-event Task command rechecks the source proof after claim and before applying any effect', async t => {
  const f = await fixture(t, { members: ['B'], scheduled: false })
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  const completed = await f.command('task.complete', { binding: owner, summary: 'A完成', result: { evidence: ['A'] } })
  const occurrence = (await f.command('coordination.occurrence.accept', { coordinationId: 'batch',
    trigger: { triggerKind: 'business-event', eventSource: 'task-ledger', eventId: completed.completionEvent.id, actionId: 'continue-B' },
    action: { kind: 'task-command', instructionIds: ['B'] }, target: f.target })).result.occurrence
  const job = await f.claim(occurrence)
  await f.command('task.drained', { binding: owner })
  await f.command('task.reopen', { taskId: 'A', request: 'A出现新要求' })
  await assert.rejects(f.command('coordination.job.command', { jobId: job.id, fence: job.fence }), { code: 'DYNAMIC_COORDINATION_EVENT_STALE' })
  assert.equal((await f.task('B')).contextRevision ?? 0, 0)
  assert.equal(await f.query('receipt.get', { id: 'coordination-command:batch:B' }), null)
})

test('instance pause/resume fences the prior worker and cancelling the arrangement never cancels the Task', async t => {
  const f = await fixture(t)
  const occurrence = await f.due(), first = await f.claim(occurrence)
  await f.command('coordination.occurrence.control', { occurrenceId: occurrence.id, expectedControlRevision: 1, control: 'pause' })
  await assert.rejects(f.claim(occurrence), { code: 'DYNAMIC_COORDINATION_PAUSED' })
  await f.command('coordination.occurrence.control', { occurrenceId: occurrence.id, expectedControlRevision: 2, control: 'resume' })
  const current = await f.claim(occurrence)
  await assert.rejects(f.command('coordination.job.command', { jobId: first.id, fence: first.fence }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  await f.command('coordination.job.command', { jobId: current.id, fence: current.fence })
  await f.command('coordination.schedule.change', { scheduleId: 'schedule', expectedRevision: 1, state: 'cancelled' })
  assert.equal((await f.task('B')).control, 'active')
  assert.equal((await f.task('B')).contextRevision, 1)
})
