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
