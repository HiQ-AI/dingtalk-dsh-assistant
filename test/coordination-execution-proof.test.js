import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-proof-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'proof-test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ kind, args, id })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const task = taskId => command('task.create', { taskId, groupId: 'group', request: taskId })
  const owner = async taskId => (await command('task.claim', { taskId })).result.binding
  const dispatch = async (binding, key) => (await command('execution.dispatch', { binding, key, prompt: key, input: {}, resourceKeys: ['shared'], instructionIds: [] })).result.execution
  const member = (coordinationId, id, taskId, dependencies = []) => ({ instructionId: id, taskId, dependencies,
    progressImpact: 'preserve', command: { id: `coordination-command:${coordinationId}:${id}`, kind: 'task.supplement',
      args: { taskId, expectedRequirementRevision: 1, expectedControlRevision: 1, messageId: id, text: id, request: `${taskId}\n${id}` } } })
  const arrange = async (coordinationId, members) => {
    const source = (await command('coordination.reserve', { unitId: coordinationId, revision: 1, groupId: 'group', original: coordinationId })).result.source
    return command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId, members })
  }
  return { options, command, query, task, owner, dispatch, member, arrange,
    async reopen() { await store.close(); store = await openDynamicTaskStore(options) } }
}

test('Host binds pending instructions despite caller empty ids; claim waits before locking while Owner controls remain available', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B'); await f.task('unrelated')
  await f.arrange('batch', [f.member('batch','a','A'), f.member('batch','b','B',['a'])])
  const binding = await f.owner('B'), execution = await f.dispatch(binding, 'B-work')
  assert.deepEqual(execution.instructionScope.instructionIds, ['b'])
  assert.equal(execution.instructionScope.inputVersion, 1)
  await assert.rejects(f.command('execution.claim', { executionId: execution.id, instructionIds: [] }), { code: 'DYNAMIC_COORDINATION_WAITING' })
  assert.deepEqual(await f.query('resource.list'), [])
  const unrelated = await f.dispatch(await f.owner('unrelated'), 'independent')
  await f.command('execution.claim', { executionId: unrelated.id })
  assert.equal((await f.query('task.get', { taskId: 'B' })).status, 'active')
})

async function startedReorder(t) {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  await f.arrange('batch',[f.member('batch','a','A'),f.member('batch','b','B')])
  await f.command('coordination.apply',{instructionId:'b',expectedRevision:1})
  const binding = await f.owner('B'), execution = await f.dispatch(binding,'running-before-reorder')
  await f.command('execution.claim',{executionId:execution.id})
  const source = (await f.command('coordination.reserve',{unitId:'change',revision:1,groupId:'group',original:'A finishes before further B work'})).result.source
  await f.command('coordination.change',{sourceId:source.id,fence:source.fence,coordinationId:'batch',expectedRevision:1,
    change:{action:'reorder',dependencies:[{instructionId:'b',afterInstructionIds:['a']}]}})
  const pending=(await f.query('coordination.get',{coordinationId:'batch'})).members.find(m=>m.id==='b')
  return {...f,binding,execution,pending,assess:decision=>f.command('coordination.reorder.assess',{binding,instructionId:'b',
    assessmentId:pending.reorderAssessment.id,decision,summary:'Original effects preserved; future input waits.',evidence:['execution log and operation ledger inspected']})}
}

test('running reorder requests read-only Owner assessment without revising or cancelling; safe point needs Host evidence',async t=>{
  const f=await startedReorder(t)
  const before=await f.query('task.get',{taskId:'B'})
  assert.equal(f.pending.waitingReason.code,'reorder_pending')
  assert.deepEqual(f.pending.dependencies,[])
  assert.equal((await f.query('execution.get',{executionId:f.execution.id})).cancelRequested,false)
  assert.equal((await f.query('coordination.assessments',{taskId:'B'})).length,1)
  await assert.rejects(f.command('task.wait',{binding:f.binding,action:'wait',summary:'skip structured assessment'}),
    {code:'DYNAMIC_COORDINATION_ASSESSMENT_REQUIRED'})
  await assert.rejects(f.command('task.complete',{binding:f.binding,summary:'old Owner cannot close pending reorder'}),
    {code:'DYNAMIC_COORDINATION_ASSESSMENT_REQUIRED'})
  assert.ok((await f.query('wake.list',{taskId:'B'})).some(wake=>wake.kind === 'coordination.changed' && wake.state !== 'acked'))
  await assert.rejects(f.assess('safe_point'),{code:'DYNAMIC_COORDINATION_SAFE_POINT_UNPROVEN'})
  await f.assess('continue_existing')
  const after=await f.query('task.get',{taskId:'B'})
  for(const key of ['requirementRevision','contextRevision','controlRevision','runSequence']) assert.equal(after[key],before[key])
  const binding=await f.query('execution.binding',{executionId:f.execution.id})
  await f.command('execution.drained',{binding})
  // A restart of the exact old input is explicit existing work, not new business scope.
  await f.command('execution.claim',{executionId:f.execution.id})
  await f.command('execution.drained',{binding:await f.query('execution.binding',{executionId:f.execution.id})})
  await f.command('execution.continue',{binding:f.binding,executionId:f.execution.id,key:'later-input',prompt:'next',input:{}})
  await assert.rejects(f.command('execution.claim',{executionId:f.execution.id}),{code:'DYNAMIC_COORDINATION_WAITING'})
  assert.deepEqual(await f.query('resource.list'),[])
})

test('running reorder uncertainty persists clarification instead of pretending strict ordering or cancelling work',async t=>{
  const f=await startedReorder(t)
  await f.assess('needs_clarification')
  await f.reopen()
  const member=(await f.query('coordination.get',{coordinationId:'batch'})).members.find(m=>m.id==='b')
  assert.equal(member.waitingReason.code,'reorder_needs_clarification')
  assert.deepEqual(member.dependencies,[])
  assert.equal((await f.query('execution.get',{executionId:f.execution.id})).cancelRequested,false)
  await assert.rejects(f.assess('continue_existing'),{code:'DYNAMIC_TASK_LEASE_STALE'})
})

test('a second reorder cannot inherit an earlier existing-input exemption',async t=>{
  const f=await startedReorder(t)
  await f.assess('continue_existing')
  const source=(await f.command('coordination.reserve',{unitId:'second-change',revision:1,groupId:'group',original:'重新评估这次顺序'})).result.source
  await f.command('coordination.change',{sourceId:source.id,fence:source.fence,coordinationId:'batch',expectedRevision:2,
    change:{action:'reorder',dependencies:[{instructionId:'b',afterInstructionIds:['a']}]}})
  await f.command('execution.drained',{binding:await f.query('execution.binding',{executionId:f.execution.id})})
  await assert.rejects(f.command('execution.claim',{executionId:f.execution.id}),{code:'DYNAMIC_COORDINATION_WAITING'})
  const member=(await f.query('coordination.get',{coordinationId:'batch'})).members.find(m=>m.id==='b')
  assert.deepEqual(member.reorderExistingInputs,[])
  assert.equal(member.reorderAssessment.state,'pending')
})

test('opposite pending reorder proposals are rejected before either Owner decision',async t=>{
  const f=await startedReorder(t)
  const source=(await f.command('coordination.reserve',{unitId:'opposite',revision:1,groupId:'group',original:'反向顺序'})).result.source
  await assert.rejects(f.command('coordination.change',{sourceId:source.id,fence:source.fence,coordinationId:'batch',expectedRevision:2,
    change:{action:'reorder',dependencies:[{instructionId:'a',afterInstructionIds:['b']}]}}),{code:'DYNAMIC_COORDINATION_CYCLE'})
  assert.equal((await f.query('coordination.get',{coordinationId:'batch'})).coordination.revision,2)
})

test('existing running input remains explicit prior scope, but a new continue input cannot inherit the exemption', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const binding = await f.owner('B'), execution = await f.dispatch(binding, 'already-running')
  await f.command('execution.claim', { executionId: execution.id })
  await f.arrange('batch', [f.member('batch','a','A'), f.member('batch','b','B',['a'])])
  let current = await f.query('execution.binding', { executionId: execution.id })
  await f.command('execution.drained', { binding: current })
  await f.command('execution.claim', { executionId: execution.id })
  const previousInput = await f.query('execution.get', { executionId: execution.id })
  assert.deepEqual(previousInput.instructionScope.instructionIds, [])
  current = await f.query('execution.binding', { executionId: execution.id })
  await f.command('execution.drained', { binding: current })
  const continued = (await f.command('execution.continue', { binding, executionId: execution.id, key: 'new-work', prompt: 'new work', input: {} })).result.execution
  assert.equal(continued.inputVersion, 2)
  assert.deepEqual(continued.instructionScope.instructionIds, ['b'])
  assert.equal(continued.inputHistory.at(-1).instructionScope.inputVersion, 1)
  await assert.rejects(f.command('execution.claim', { executionId: execution.id }), { code: 'DYNAMIC_COORDINATION_WAITING' })
})

test('completion receipt, coverage proof and independent ordered event commit atomically and replay once', async t => {
  const f = await fixture(t)
  await f.task('A')
  await f.arrange('batch', [f.member('batch','a','A')])
  await f.command('coordination.apply', { instructionId: 'a', expectedRevision: 1 })
  const binding = await f.owner('A')
  const args = { binding, summary: 'formal business acceptance', result: { evidence: ['artifact:a'] } }
  const receipt = await f.command('task.complete', args, 'complete-A')
  assert.deepEqual(receipt.taskDecision.instructionCoverage.map(item => item.instructionId), ['a'])
  assert.equal(receipt.taskDecision.runSequence, 1)
  assert.equal(receipt.completionEvent.contextRevision, 1)
  assert.equal(receipt.completionEvent.taskDecisionReceiptId, 'complete-A')
  assert.equal(receipt.completionEvent.sequence, 1)
  assert.equal((await f.command('task.complete', args, 'complete-A')).replayed, true)
  await f.reopen()
  const page = await f.query('task.events', { after: 0 })
  assert.equal(page.events.length, 1)
  assert.deepEqual(page.events[0].instructionCoverage, receipt.taskDecision.instructionCoverage)
  const member = (await f.query('coordination.get', { coordinationId: 'batch' })).members[0]
  assert.equal(member.completionProof.eventId, page.events[0].id)
  const consumed = await f.command('coordination.events.consume', { consumerId: 'dispatcher', expectedCursor: 0 })
  assert.equal(consumed.result.cursor, 1)
  await assert.rejects(f.command('coordination.events.consume', { consumerId: 'dispatcher', expectedCursor: 0 }), { code: 'DYNAMIC_COORDINATION_CURSOR_STALE' })
})

test('event write failure rolls back business completion, instruction fulfillment and receipt', async t => {
  const f = await fixture(t)
  await f.task('A')
  await f.arrange('batch', [f.member('batch','a','A')])
  await f.command('coordination.apply', { instructionId: 'a', expectedRevision: 1 })
  const binding = await f.owner('A'), args = { binding, summary: 'accepted' }
  const db = new DatabaseSync(f.options.dbPath)
  try {
    db.exec("CREATE TRIGGER crash_event BEFORE INSERT ON dynamic_task_events BEGIN SELECT RAISE(ABORT,'injected event write failure'); END")
    await assert.rejects(f.command('task.complete', args, 'complete-atomic'))
    assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'active')
    assert.equal((await f.query('coordination.get', { coordinationId: 'batch' })).members[0].state, 'applied')
    assert.equal(await f.query('receipt.get', { id: 'complete-atomic' }), null)
    assert.deepEqual((await f.query('task.events')).events, [])
    db.exec('DROP TRIGGER crash_event')
    await f.command('task.complete', args, 'complete-atomic')
    assert.equal((await f.query('task.events')).events.length, 1)
  } finally { db.close() }
})

test('consuming an old completion after reopen reads current truth and cannot make B eligible', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  await f.arrange('batch', [f.member('batch','a','A'), f.member('batch','b','B',['a'])])
  await f.command('coordination.apply', { instructionId: 'a', expectedRevision: 1 })
  const binding = await f.owner('A')
  await f.command('task.complete', { binding, summary: 'A complete' })
  await f.command('task.drained', { binding })
  await f.command('task.reopen', { taskId: 'A', request: 'new accepted requirement' })
  await f.reopen()
  const consumed = await f.command('coordination.events.consume', { consumerId: 'dispatcher', expectedCursor: 0 })
  assert.equal(consumed.result.cursor, 1)
  const b = (await f.query('coordination.get', { coordinationId: 'batch' })).members.find(m => m.id === 'b')
  assert.equal(b.eligible, false)
  assert.deepEqual(b.waitingReason, { code: 'waiting_dependency', dependencyInstructionIds: ['a'] })
})

test('compatible context supplements preserve earlier instruction coverage in the current Owner completion', async t => {
  const f = await fixture(t)
  await f.task('A')
  await f.arrange('first', [f.member('first','first-input','A')])
  await f.command('coordination.apply', { instructionId: 'first-input', expectedRevision: 1 })
  await f.arrange('second', [f.member('second','second-input','A')])
  await f.command('coordination.apply', { instructionId: 'second-input', expectedRevision: 1 })
  const binding = await f.owner('A')
  const receipt = await f.command('task.complete', { binding, summary: 'both requirements accepted' })
  assert.deepEqual(receipt.taskDecision.instructionCoverage.map(item => item.instructionId), ['first-input','second-input'])
  assert.equal(receipt.completionEvent.contextRevision, 2)
  assert.equal((await f.query('coordination.get', { coordinationId: 'first' })).members[0].state, 'fulfilled')
})
