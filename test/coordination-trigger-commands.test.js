import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t, { rule = { kind: 'once', at: '2026-10-21T01:00:00.000Z' } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'retired-trigger-'))
  const config = { dbPath: join(directory, 'task.sqlite'), instanceId: 'test', initialize: true, webActorId: 'operator' }
  let store = await openDynamicTaskStore(config)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  for (const id of ['A', 'B', 'C']) await command('task.create', { taskId: id, groupId: 'group', request: id, ownerActorId: 'requester' })
  const frozen = { id: 'original-command', kind: 'task.supplement', args: { taskId: 'B',
    expectedRequirementRevision: 1, expectedControlRevision: 1, messageId: 'original-input', text: 'Original authorized continuation', request: 'B with original context' } }
  await store.close()
  const db = new DatabaseSync(config.dbPath)
  const put = (table, id, body) => db.prepare('INSERT INTO dynamic_' + table + '(id,body) VALUES (?,?)').run(id, JSON.stringify({ id, ...body }))
  try {
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    put('coordination', 'batch', { groupId: 'group', state: 'active', revision: 1, memberIds: ['B'], sourceId: 'old-source' })
    put('coordination_sources', 'old-source', { groupId: 'group', state: 'accepted', dispatchOwner: 'coordination', unitId: 'old-unit', revision: 1,
      sourceMessageId: 'original-message', original: 'Original timed continuation request', coordinationId: 'batch' })
    put('coordination_members', 'B', { coordinationId: 'batch', taskId: 'B', state: 'ready', requiresTrigger: true, dependencies: ['A'], command: frozen })
    put('coordination_schedules', 'schedule', { coordinationId: 'batch', revision: 1, state: 'active', timezone: 'Asia/Shanghai', rule,
      nextDueAt: '2026-10-21T01:00:00.000Z', action: { kind: 'task-command', instructionIds: ['B'] }, target: { conversationId: 'group', recipientIds: ['original-recipient'] } })
    put('coordination_occurrences', 'occurrence', { coordinationId: 'batch', scheduleId: 'schedule', acceptedScheduleRevision: 1, plannedAt: '2026-10-21T01:00:00.000Z',
      slotId: 'original-slot', actionState: 'pending', deliveryState: 'pending', action: { kind: 'task-command', instructionIds: ['B'] }, jobId: 'job' })
    put('coordination_jobs', 'job', { coordinationId: 'batch', occurrenceId: 'occurrence', state: 'pending', fence: 1 })
  } finally { db.close() }
  store = await openDynamicTaskStore({ ...config, initialize: false })
  return { command, query, frozen, config,
    task: taskId => query('task.get', { taskId }),
    owner: async taskId => (await command('task.claim', { taskId })).result.binding,
    async restart() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }) } }
}
const currentInput = (f, id, extra = {}) => ({ ...f.frozen.args, messageId: id, text: 'Current explicit input ' + id, ...extra })

test('retired once trigger cannot dispatch itself; an explicit current input reaches the original Task once', async t => {
  const f = await fixture(t), before = await f.task('B')
  const schedule = (await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.retirement.kind, 'feature-removed')
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
  assert.deepEqual(await f.query('execution.list', { taskId: 'B' }), [])
  const args = currentInput(f, 'current')
  await f.command('task.supplement', args, 'current-input')
  assert.equal((await f.command('task.supplement', args, 'current-input')).replayed, true)
  const after = await f.task('B')
  assert.equal(after.contextRevision, 1); assert.equal(after.sessionId, before.sessionId)
  assert.equal((await f.query('task.list')).length, 3)
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
})

test('retired daily template cannot manufacture slot commands, while distinct current inputs keep their exact identities', async t => {
  const f = await fixture(t, { rule: { kind: 'daily', time: '09:00' } })
  const history = await f.query('coordination.occurrence.list')
  for (const id of ['current-first', 'current-second']) {
    await f.command('task.supplement', currentInput(f, id), id)
    await f.restart()
    assert.deepEqual(await f.query('coordination.occurrence.list'), history)
  }
  const task = await f.task('B')
  assert.equal(task.contextRevision, 2)
  assert.deepEqual(task.supplements.map(item => item.id), ['current-first', 'current-second'])
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
})

test('a weekly historical authorization cannot rebase a frozen Task command onto a changed requirement', async t => {
  const f = await fixture(t, { rule: { kind: 'weekly', weekdays: [1], time: '09:00' } })
  await f.command('task.revise', { taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Changed goal' })
  await assert.rejects(f.command(f.frozen.kind, f.frozen.args, f.frozen.id), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  assert.equal((await f.task('B')).contextRevision ?? 0, 0)
  assert.equal((await f.task('B')).request, 'Changed goal')
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
  assert.deepEqual((await f.query('coordination.get', { coordinationId: 'batch' })).members[0].command, f.frozen)
})

test('current source edits never overwrite the original historical request or frozen recipient identity', async t => {
  const f = await fixture(t)
  const originalSource = (await f.query('coordination.source.list'))[0]
  const originalSchedule = (await f.query('coordination.schedule.list'))[0]
  await f.command('task.supplement', currentInput(f, 'change', { request: 'B with newly supplied context' }))
  await f.restart()
  assert.deepEqual((await f.query('coordination.source.list'))[0], originalSource)
  assert.deepEqual((await f.query('coordination.schedule.list'))[0], originalSchedule)
  assert.equal(originalSource.original, 'Original timed continuation request')
  assert.deepEqual(originalSchedule.target.recipientIds, ['original-recipient'])
  assert.equal((await f.task('B')).request, 'B with newly supplied context')
})

test('current replan commands advance only their frozen expected revision and never replay a second revision change', async t => {
  const f = await fixture(t)
  const first = { taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Current second requirement' }
  await f.command('task.revise', first, 'current-replan')
  await f.restart()
  assert.equal((await f.command('task.revise', first, 'current-replan')).replayed, true)
  assert.equal((await f.task('B')).requirementRevision, 2)
  await assert.rejects(f.command('task.revise', { ...first, request: 'Third under old scope' }, 'different-stale-command'), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('task.revise', { ...first, expectedRequirementRevision: 2, request: 'Explicit third requirement' }, 'new-replan')
  assert.equal((await f.task('B')).requirementRevision, 3)
  assert.equal((await f.query('task.list')).length, 3)
})

test('lost supplement acknowledgement is recovered by its original command and message identity without duplicate feedback', async t => {
  const f = await fixture(t), owner = await f.owner('B')
  const execution = (await f.command('execution.dispatch', { binding: owner, key: 'original', prompt: 'Current work' })).result.execution
  await f.command('execution.claim', { executionId: execution.id })
  const args = currentInput(f, 'lost-ack')
  const receipt = await f.command('task.supplement', args, 'lost-ack-command')
  await f.restart()
  const recovered = await f.command('task.supplement', args, 'lost-ack-command')
  assert.equal(recovered.replayed, true)
  assert.equal(recovered.result.task.contextRevision, receipt.result.task.contextRevision)
  const current = await f.query('execution.get', { executionId: execution.id })
  assert.equal(current.feedback.length, 1); assert.equal(current.feedback[0].id, 'lost-ack')
  assert.equal((await f.task('B')).contextRevision, 1)
})

test('lost commit acknowledgement preserves the original replan receipt after restart and refuses changed content under its id', async t => {
  const f = await fixture(t)
  const args = { taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Accepted revised goal' }
  const committed = await f.command('task.revise', args, 'replan-ack-lost')
  await f.restart()
  const durable = await f.query('receipt.get', { id: 'replan-ack-lost' })
  assert.equal(durable.result.task.requirementRevision, committed.result.task.requirementRevision)
  assert.equal((await f.command('task.revise', args, 'replan-ack-lost')).replayed, true)
  await assert.rejects(f.command('task.revise', { ...args, request: 'Changed content' }, 'replan-ack-lost'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  assert.equal((await f.task('B')).requirementRevision, 2)
})

test('current human prerequisite blocks Owner admission until a real answer arrives, then continues the original Task', async t => {
  const f = await fixture(t), owner = await f.owner('B')
  await f.command('task.wait', { binding: owner, summary: 'Need approval', question: 'Proceed with this prepared change?', humanRequest: { requestId: 'approval', audience: 'operator' } })
  await f.command('task.drained', { binding: owner })
  await assert.rejects(f.command('task.claim', { taskId: 'B' }), { code: 'DYNAMIC_HUMAN_RESPONSE_REQUIRED' })
  assert.deepEqual(await f.query('execution.list', { taskId: 'B' }), [])
  await f.command('source.record', { sourceId: 'answer', groupId: 'group', messageId: 'answer-message', actorId: 'operator', channel: 'web', text: 'Approved this change' })
  await f.command('task.human.respond', { taskId: 'B', requestId: 'approval', expectedRequirementRevision: 1, expectedControlRevision: 1, sourceId: 'answer' })
  const resumed = await f.owner('B')
  assert.equal(resumed.taskId, owner.taskId); assert.equal(resumed.sessionId, owner.sessionId)
  assert.equal((await f.task('B')).humanRequests[0].status, 'answered')
  assert.equal((await f.query('task.list')).length, 3)
})

test('a frozen old control revision is rejected after pause and resume without rewriting its request', async t => {
  const f = await fixture(t)
  await f.command('task.control', { taskId: 'B', expectedControlRevision: 1, control: 'paused' })
  await f.command('task.control', { taskId: 'B', expectedControlRevision: 2, control: 'active' })
  await assert.rejects(f.command(f.frozen.kind, f.frozen.args, f.frozen.id), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  assert.equal((await f.task('B')).controlRevision, 3)
  assert.equal((await f.task('B')).request, 'B')
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
})

test('a retired ready template cannot re-enter immediate dispatch or gate a new Owner execution', async t => {
  const f = await fixture(t)
  const old = await f.query('coordination.get', { coordinationId: 'batch' })
  assert.equal(old.members[0].state, 'ready'); assert.equal(old.members[0].eligible, false)
  assert.deepEqual(old.members[0].dependencies, ['A'])
  const owner = await f.owner('B')
  const execution = (await f.command('execution.dispatch', { binding: owner, key: 'current', prompt: 'Current authorized work' })).result.execution
  assert.deepEqual(execution.instructionScope.instructionIds, [])
  await f.command('execution.claim', { executionId: execution.id })
  assert.equal((await f.query('execution.get', { executionId: execution.id })).status, 'running')
  assert.deepEqual(await f.query('coordination.get', { coordinationId: 'batch' }), old)
  assert.equal(await f.query('receipt.get', { id: f.frozen.id }), null)
})

test('current message revisions remain distinct sources and stable command retries cannot duplicate their task input', async t => {
  const f = await fixture(t)
  for (const version of [1, 2]) {
    const sourceId = 'message-version-' + version
    const source = { sourceId, groupId: 'group', messageId: 'one-message', version, actorId: 'requester', text: 'Input version ' + version }
    await f.command('source.record', source, 'record-' + version)
    const args = currentInput(f, sourceId, { sourceRefs: ['message-version-1', ...(version === 2 ? ['message-version-2'] : [])] })
    await f.command('task.supplement', args, 'apply-' + version)
    assert.equal((await f.command('task.supplement', args, 'apply-' + version)).replayed, true)
    assert.equal((await f.query('source.get', { sourceId })).version, version)
  }
  await f.restart()
  assert.equal((await f.task('B')).contextRevision, 2)
  assert.deepEqual((await f.task('B')).sourceRefs, ['message-version-1', 'message-version-2'])
  assert.equal((await f.query('coordination.occurrence.list')).length, 1, 'Current message inputs do not manufacture legacy occurrences')
})

test('one completion event persists once and cannot dispatch other Tasks without their explicit current commands', async t => {
  const f = await fixture(t), binding = await f.owner('A')
  const args = { binding, summary: 'Actual result A', result: { evidence: ['A-proof'] } }
  const completed = await f.command('task.complete', args, 'completed-A')
  assert.equal((await f.command('task.complete', args, 'completed-A')).replayed, true)
  assert.equal((await f.query('task.events')).events.length, 1)
  for (const taskId of ['B', 'C']) {
    assert.equal((await f.task(taskId)).contextRevision ?? 0, 0)
    const input = currentInput(f, 'explicit-' + taskId, { taskId, text: 'Review original result ' + completed.completionEvent.id, request: taskId })
    await f.command('task.supplement', input, 'apply-' + taskId)
    assert.equal((await f.command('task.supplement', input, 'apply-' + taskId)).replayed, true)
    assert.equal((await f.task(taskId)).contextRevision, 1)
  }
  assert.equal((await f.query('task.events')).events.length, 1)
})

test('claimed current execution rechecks its exact Task authority before effects and rejects foreign Owner cancellation', async t => {
  const f = await fixture(t), a = await f.owner('A'), b = await f.owner('B')
  const execution = (await f.command('execution.dispatch', { binding: b, key: 'B-work', prompt: 'Original B scope' })).result.execution
  const scope = (await f.command('execution.claim', { executionId: execution.id })).result.binding
  await assert.rejects(f.command('execution.cancel', { binding: a, executionId: execution.id }), { code: 'DYNAMIC_EXECUTION_SCOPE_INVALID' })
  await f.command('task.revise', { taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'New B scope' })
  await assert.rejects(f.command('operation.prepare', { binding: scope, key: 'old-write', definition: { toolName: 'write' }, resourceKeys: [] }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  assert.deepEqual(await f.query('operation.list', { taskId: 'B' }), [])
  assert.equal((await f.task('B')).request, 'New B scope')
})

test('pause and resume fence old work while an explicit current Owner reuses the same drained execution', async t => {
  const f = await fixture(t), oldOwner = await f.owner('B')
  const execution = (await f.command('execution.dispatch', { binding: oldOwner, key: 'work', prompt: 'Original work' })).result.execution
  const oldScope = (await f.command('execution.claim', { executionId: execution.id })).result.binding
  await f.command('task.control', { taskId: 'B', expectedControlRevision: 1, control: 'paused' })
  await f.command('task.control', { taskId: 'B', expectedControlRevision: 2, control: 'active' })
  await f.command('execution.drained', { binding: oldScope })
  await f.command('task.drained', { binding: oldOwner })
  const owner = await f.owner('B')
  const resumed = (await f.command('execution.continue', { binding: owner, executionId: execution.id, key: 'explicit-resume', prompt: 'Current continuation' })).result.execution
  assert.equal(resumed.id, execution.id); assert.equal(resumed.inputVersion, 2); assert.equal(resumed.controlRevision, 3)
  assert.equal(resumed.inputHistory[0].controlRevision, 1)
  await assert.rejects(f.command('execution.result', { binding: oldScope, output: { summary: 'Old late result' } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
  assert.equal((await f.task('B')).control, 'active')
})

test('historical recurring identities survive current revisions and repeated recovery without new slots or notifications', async t => {
  const f = await fixture(t, { rule: { kind: 'daily', time: '09:00' } })
  const schedule = (await f.query('coordination.schedule.list'))[0], occurrence = (await f.query('coordination.occurrence.list'))[0]
  const before = await f.task('B')
  await f.command('task.revise', { taskId: 'B', expectedRequirementRevision: 1, expectedControlRevision: 1, request: 'Current revised delivery' })
  for (let i = 0; i < 2; i++) {
    await f.restart()
    assert.deepEqual((await f.query('coordination.schedule.list'))[0], schedule)
    assert.deepEqual((await f.query('coordination.occurrence.list'))[0], occurrence)
    assert.equal((await f.query('coordination.occurrence.list')).length, 1)
    assert.deepEqual(await f.query('notification.list'), [])
  }
  assert.equal((await f.task('B')).sessionId, before.sessionId)
  assert.equal((await f.task('B')).requirementRevision, 2)
  assert.deepEqual((await f.query('coordination.get', { coordinationId: 'batch' })).members[0].command, f.frozen)
})
