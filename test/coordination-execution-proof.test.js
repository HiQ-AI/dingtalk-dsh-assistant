import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'owner-execution-proof-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'proof-test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ kind, args, id })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const task = taskId => command('task.create', { taskId, groupId: 'group', request: taskId })
  const owner = async taskId => (await command('task.claim', { taskId })).result.binding
  const dispatch = async (binding, key, resourceKeys = ['shared']) => (await command('execution.dispatch', { binding, key, prompt: key, input: {}, resourceKeys })).result.execution
  const start = async execution => (await command('execution.claim', { executionId: execution.id })).result.binding
  const finish = async binding => {
    await command('execution.result', { binding, output: { summary: 'Observed result', evidence: ['isolated-proof'] } })
    await command('execution.drained', { binding })
  }
  return { options, command, query, task, owner, dispatch, start, finish,
    async reopen() { await store.close(); store = await openDynamicTaskStore({ ...options, initialize: false }) } }
}

test('a review execution result cannot finish the delivery Task after restart', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'delivery', groupId: 'group',
    request: '先方案评审，然后开发，开发完部署UAT', requirements: ['评审', '开发', '部署UAT'] })
  const binding = await f.owner('delivery'), execution = await f.dispatch(binding, 'review-only')
  await f.command('execution.claim', { executionId: execution.id })
  const executionBinding = await f.query('execution.binding', { executionId: execution.id })
  await f.command('execution.result', { binding: executionBinding, output: { summary: '仅方案评审完成', evidence: ['review-proof'] } })
  await f.command('execution.drained', { binding: executionBinding })
  await f.command('task.wait', { binding, action: 'wait', summary: '开发和UAT尚待交付', evidence: ['review-proof'], limitations: [] })
  await f.reopen()
  const task = await f.query('task.get', { taskId: 'delivery' })
  assert.equal(task.status, 'active')
  assert.equal(task.completion, undefined)
  assert.deepEqual(task.requirements, ['评审', '开发', '部署UAT'])
})

test('current Owner completion waits for queued execution and actual resource drain without blocking unrelated work', async t => {
  const f = await fixture(t)
  for (const id of ['A', 'B', 'unrelated']) await f.task(id)
  const a = await f.dispatch(await f.owner('A'), 'A-work'), aScope = await f.start(a)
  const bOwner = await f.owner('B'), b = await f.dispatch(bOwner, 'B-work')
  await assert.rejects(f.start(b), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await assert.rejects(f.command('task.complete', { binding: bOwner, summary: 'premature' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
  assert.equal((await f.query('resource.list')).length, 1)
  const independent = await f.dispatch(await f.owner('unrelated'), 'independent', [])
  await f.start(independent)
  await f.finish(aScope)
  await f.start(b)
  assert.equal((await f.query('execution.get', { executionId: b.id })).status, 'running')
  assert.equal((await f.query('task.get', { taskId: 'B' })).status, 'active')
})

test('a changed requirement invalidates the old Owner but preserves its running execution evidence until drained', async t => {
  const f = await fixture(t); await f.task('A')
  const binding = await f.owner('A'), execution = await f.dispatch(binding, 'original'), scope = await f.start(execution)
  await f.command('task.revise', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Changed accepted requirement' })
  await assert.rejects(f.command('task.wait', { binding, summary: 'old result' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await assert.rejects(f.command('task.complete', { binding, summary: 'old completion' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  const current = await f.query('execution.get', { executionId: execution.id })
  assert.equal(current.cancelRequested, true); assert.equal(current.drained, false)
  assert.equal((await f.query('resource.list')).length, 1)
  const late = await f.command('execution.result', { binding: scope, output: { summary: 'Old scoped result' } })
  assert.equal(late.result.current, false)
  await f.command('execution.drained', { binding: scope })
  assert.deepEqual(await f.query('resource.list'), [])
  assert.equal((await f.query('task.get', { taskId: 'A' })).request, 'Changed accepted requirement')
})

test('uncertain business ordering is a durable Owner question without cancelling an already running input', async t => {
  const f = await fixture(t); await f.task('A')
  const binding = await f.owner('A'), execution = await f.dispatch(binding, 'running')
  await f.start(execution)
  await f.command('task.wait', { binding, action: 'wait', summary: 'Need a precise dependency decision', question: 'Which deliverable is required first?',
    humanRequest: { requestId: 'ordering', audience: 'requester' }, evidence: ['Current input inspected'], limitations: ['Order unconfirmed'] })
  const before = await f.query('execution.get', { executionId: execution.id })
  assert.equal(before.cancelRequested, false)
  await f.command('task.drained', { binding }); await f.reopen()
  const task = await f.query('task.get', { taskId: 'A' })
  assert.equal(task.status, 'active'); assert.equal(task.humanRequests[0].status, 'waiting-reply')
  assert.equal(task.humanRequests[0].question, 'Which deliverable is required first?')
  assert.equal((await f.query('execution.get', { executionId: execution.id })).cancelRequested, false)
  await assert.rejects(f.command('task.claim', { taskId: 'A' }), { code: 'DYNAMIC_HUMAN_RESPONSE_REQUIRED' })
})

test('a second accepted requirement cannot inherit an earlier Owner lease or execution input authority', async t => {
  const f = await fixture(t); await f.task('A')
  const first = await f.owner('A'), execution = await f.dispatch(first, 'first'), scope = await f.start(execution)
  await f.finish(scope)
  await f.command('task.revise', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Second goal' })
  await f.command('task.drained', { binding: first })
  const second = await f.owner('A')
  await f.command('task.revise', { taskId: 'A', expectedRequirementRevision: 2, expectedControlRevision: 1, request: 'Third goal' })
  await assert.rejects(f.command('execution.continue', { binding: first, executionId: execution.id, key: 'stale-first', prompt: 'wrong' }), { code: 'DYNAMIC_TASK_LEASE_STALE' })
  await assert.rejects(f.command('execution.continue', { binding: second, executionId: execution.id, key: 'stale-second', prompt: 'wrong' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  assert.equal((await f.query('execution.get', { executionId: execution.id })).inputVersion, 1)
})

test('opposite resource requests fail atomically without partial locks or changing either task requirement', async t => {
  const f = await fixture(t); await f.task('A'); await f.task('B')
  const a = await f.dispatch(await f.owner('A'), 'a', ['first', 'second'])
  const b = await f.dispatch(await f.owner('B'), 'b', ['second', 'first'])
  const scope = await f.start(a)
  await assert.rejects(f.start(b), { code: 'DYNAMIC_RESOURCE_BUSY' })
  const locks = await f.query('resource.list')
  assert.equal(locks.length, 2); assert.equal(new Set(locks.map(lock => lock.holder)).size, 1)
  assert.equal((await f.query('execution.get', { executionId: b.id })).leaseEpoch, 0)
  await f.finish(scope); await f.start(b)
  assert.equal((await f.query('task.get', { taskId: 'B' })).requirementRevision, 1)
})

test('continuing the same execution freezes the old input proof and does not accept its old result for the new input', async t => {
  const f = await fixture(t); await f.task('A')
  const owner = await f.owner('A'), execution = await f.dispatch(owner, 'first'), scope = await f.start(execution)
  await f.finish(scope)
  const previous = await f.query('execution.get', { executionId: execution.id })
  const continued = (await f.command('execution.continue', { binding: owner, executionId: execution.id, key: 'second', prompt: 'Next authorized input', input: { revision: 2 } })).result.execution
  assert.equal(continued.id, execution.id); assert.equal(continued.inputVersion, 2)
  assert.deepEqual(continued.inputHistory[0].instructionScope, previous.instructionScope)
  assert.deepEqual(continued.results[0], previous.result)
  await assert.rejects(f.command('execution.result', { binding: scope, output: { summary: 'Late old result' } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
  assert.equal((await f.query('execution.get', { executionId: execution.id })).result, null)
})

test('a current context supplement preserves the running input and requires a fresh Owner view before any decision', async t => {
  const f = await fixture(t); await f.task('A')
  const owner = await f.owner('A'), execution = await f.dispatch(owner, 'running')
  await f.start(execution)
  await f.command('task.supplement', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'clarified', text: 'Keep the current operation and use this evidence', request: 'A with clarification' })
  const current = await f.query('execution.get', { executionId: execution.id })
  assert.equal(current.status, 'running'); assert.equal(current.cancelRequested, false); assert.equal(current.inputVersion, 1)
  assert.equal(current.feedback[0].text, 'Keep the current operation and use this evidence')
  await assert.rejects(f.command('task.complete', { binding: owner, summary: 'Old context' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('task.drained', { binding: owner })
  const fresh = await f.owner('A')
  assert.equal(fresh.contextRevision, 1); assert.equal(fresh.requirementRevision, 1)
  assert.equal((await f.query('task.list')).length, 1)
})

test('cancelling one execution preserves its evidence and other members while requiring real drain before unlock', async t => {
  const f = await fixture(t); await f.task('A')
  const owner = await f.owner('A'), first = await f.dispatch(owner, 'first', ['one']), other = await f.dispatch(owner, 'other', ['two'])
  const firstScope = await f.start(first), otherScope = await f.start(other)
  await f.command('execution.cancel', { binding: owner, executionId: first.id })
  assert.equal((await f.query('resource.list')).length, 2)
  assert.equal((await f.query('execution.get', { executionId: other.id })).cancelRequested, false)
  await f.command('execution.drained', { binding: firstScope })
  assert.equal((await f.query('resource.list')).length, 1)
  await f.finish(otherScope)
  assert.equal((await f.query('execution.get', { executionId: first.id })).status, 'cancelled')
  assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'active')
})

test('queued old input cannot claim resources after control cancellation and its original scope remains audit', async t => {
  const f = await fixture(t); await f.task('A')
  const owner = await f.owner('A'), execution = await f.dispatch(owner, 'queued')
  await f.command('task.control', { taskId: 'A', expectedControlRevision: 1, control: 'cancelled' })
  const after = await f.query('execution.get', { executionId: execution.id })
  assert.deepEqual(after.instructionScope, execution.instructionScope)
  assert.equal(after.cancelRequested, true); assert.equal(after.status, 'stale')
  await assert.rejects(f.start(execution), { code: 'DYNAMIC_EXECUTION_BUSY' })
  assert.deepEqual(await f.query('resource.list'), [])
})

test('Owner completion receipt and ordered event commit atomically and replay once without legacy instruction coverage', async t => {
  const f = await fixture(t); await f.task('A')
  const binding = await f.owner('A'), args = { binding, summary: 'Actual accepted delivery', result: { evidence: ['artifact:A'] } }
  const receipt = await f.command('task.complete', args, 'complete-A')
  assert.equal(receipt.taskDecision.runSequence, 1)
  assert.deepEqual(receipt.taskDecision.decision.evidence, ['artifact:A'])
  assert.deepEqual(receipt.taskDecision.instructionCoverage, [])
  assert.equal(receipt.completionEvent.taskDecisionReceiptId, 'complete-A')
  assert.equal(receipt.completionEvent.requirementRevision, 1)
  assert.equal((await f.command('task.complete', args, 'complete-A')).replayed, true)
  await f.reopen()
  const page = await f.query('task.events', { after: 0 })
  assert.equal(page.events.length, 1)
  assert.deepEqual(page.events[0], receipt.completionEvent)
  assert.equal((await f.query('task.get', { taskId: 'A' })).completion.commandId, 'complete-A')
  assert.deepEqual(await f.query('notification.list'), [], 'Business completion does not itself claim delivery')
})

test('event write failure rolls back business completion and receipt while retaining the original active task', async t => {
  const f = await fixture(t); await f.task('A')
  const binding = await f.owner('A'), args = { binding, summary: 'Accepted actual result' }
  const before = await f.query('task.get', { taskId: 'A' })
  const db = new DatabaseSync(f.options.dbPath)
  try {
    db.exec("CREATE TRIGGER crash_event BEFORE INSERT ON dynamic_task_events BEGIN SELECT RAISE(ABORT,'injected event write failure'); END")
    await assert.rejects(f.command('task.complete', args, 'complete-atomic'), /injected event write failure/)
    assert.deepEqual(await f.query('task.get', { taskId: 'A' }), before)
    assert.equal(await f.query('receipt.get', { id: 'complete-atomic' }), null)
    assert.deepEqual((await f.query('task.events')).events, [])
    db.exec('DROP TRIGGER crash_event')
    await f.command('task.complete', args, 'complete-atomic')
    assert.equal((await f.query('task.events')).events.length, 1)
  } finally { db.close() }
})

test('an old completion remains historical after reopen and cannot complete a new requirement or another task', async t => {
  const f = await fixture(t); await f.task('A'); await f.task('B')
  const binding = await f.owner('A')
  const original = await f.command('task.complete', { binding, summary: 'A original completed' })
  await f.command('task.drained', { binding })
  await f.command('task.reopen', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'New accepted requirement' })
  await f.reopen()
  const task = await f.query('task.get', { taskId: 'A' })
  assert.equal(task.status, 'active'); assert.equal(task.completion, null); assert.equal(task.requirementRevision, 2)
  assert.deepEqual((await f.query('task.events')).events, [original.completionEvent])
  assert.equal((await f.query('task.get', { taskId: 'B' })).status, 'active')
  assert.deepEqual(await f.query('execution.list', { taskId: 'B' }), [])
  await assert.rejects(f.command('task.complete', { binding, summary: 'Stale completion' }), { code: 'DYNAMIC_TASK_LEASE_STALE' })
})

test('compatible context supplements preserve their exact source evidence in the current Owner completion', async t => {
  const f = await fixture(t); await f.task('A')
  for (const messageId of ['first-input', 'second-input']) await f.command('task.supplement', {
    taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, messageId, text: messageId, request: 'A with both inputs',
  })
  const binding = await f.owner('A')
  const receipt = await f.command('task.complete', { binding, summary: 'Both current inputs accepted', result: { evidence: ['first-input', 'second-input'] } })
  assert.equal(receipt.completionEvent.contextRevision, 2)
  assert.equal(receipt.taskDecision.contextRevision, 2)
  assert.deepEqual(receipt.completionEvent.result.evidence, ['first-input', 'second-input'])
  const task = await f.query('task.get', { taskId: 'A' })
  assert.deepEqual(task.supplements.map(item => item.id), ['first-input', 'second-input'])
  assert.equal(task.requirementRevision, 1); assert.equal(task.runSequence, 1)
})
