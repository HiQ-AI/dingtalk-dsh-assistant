import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { summarizeTimeSlots } from '../packages/dingtalk-dsh-assistant/coordination-time.js'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

test('offset proposal persists a canonical due time and one slot across restart and repeated scans', async t => {
  const proposal = coordinationProposalSchema.parse({kind:'schedule',timezone:'Asia/Shanghai',
    rule:{kind:'once',at:'2026-10-21T09:00:00+08:00'},taskIds:['A'],recipientIds:[],interpretation:'synthetic'})
  const f = await fixture(t, proposal.rule)
  const schedule = (await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.rule.at, '2026-10-21T01:00:00.000Z')
  assert.equal(schedule.nextDueAt, schedule.rule.at)
  await f.restart()
  f.tick(3600000)
  const occurrence = (await f.scan()).result.occurrences[0]
  assert.equal(occurrence.plannedAt, schedule.rule.at)
  assert.equal((await f.scan()).result.occurrences.length, 0)
  await f.restart()
  assert.equal((await f.scan()).result.occurrences.length, 0)
  assert.equal((await f.occurrences()).length, 1)
})

async function fixture(t, rule = { kind: 'once', at: '2026-10-21T01:00:00.000Z' }) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const directory = await mkdtemp(join(tmpdir(), 'coordination-schedule-'))
  const config = { dbPath: join(directory, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(config)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  await command('task.create', { taskId: 'A', groupId: 'group', request: 'A' })
  const source = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'group', original: '查询A' })).result.source
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'query', members: [], readOnly: true })
  await command('coordination.schedule.create', { coordinationId: 'query', scheduleId: 'schedule', timezone: 'Asia/Shanghai', rule,
    action: { kind: 'read-query', taskIds: ['A'] }, target: { conversationId: 'group', recipientIds: ['first'] } })
  return { command, query,
    tick: milliseconds => t.mock.timers.tick(milliseconds),
    change: args => command('coordination.schedule.change', { scheduleId: 'schedule', ...args }),
    scan: () => command('coordination.schedule.scan'),
    occurrences: () => query('coordination.occurrence.list'),
    jobs: () => query('coordination.job.list'),
    async restart() { await store.close(); store = await openDynamicTaskStore(config) },
    async claim(occurrence) { return (await command('coordination.job.claim', { jobId: occurrence.jobId })).result.job },
  }
}

test('future-only revision preserves an accepted occurrence and its frozen target across restart', async t => {
  const f = await fixture(t)
  f.tick(3600000)
  const original = (await f.scan()).result.occurrences[0]
  await f.change({ expectedRevision: 1, target: { conversationId: 'group', recipientIds: ['second'] } })
  await f.restart()
  const job = await f.claim(original)
  const result = await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })
  assert.equal(result.result.occurrence.acceptedScheduleRevision, 1)
  assert.deepEqual(result.result.occurrence.target.recipientIds, ['first'])
  assert.equal((await f.scan()).result.occurrences.length, 0)
})

test('a started occurrence keeps its accepted revision while a future rule and recipient change is committed', async t => {
  const f = await fixture(t, { kind: 'daily', time: '09:00' })
  f.tick(3600000)
  const occurrence = (await f.scan()).result.occurrences[0]
  const job = await f.claim(occurrence)
  await f.change({ expectedRevision: 1, rule: { kind: 'daily', time: '10:00' }, target: { conversationId: 'group', recipientIds: ['second'] } })
  const result = await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })
  assert.equal(result.result.occurrence.acceptedScheduleRevision, 1)
  assert.equal(result.result.occurrence.plannedAt, '2026-10-21T01:00:00.000Z')
  assert.deepEqual(result.result.occurrence.target.recipientIds, ['first'])
})

test('explicit same-slot replacement transfers current pointer and permanently fences the old occurrence', async t => {
  const f = await fixture(t)
  f.tick(3600000)
  const original = (await f.scan()).result.occurrences[0]
  const changed = await f.change({ expectedRevision: 1, scope: 'unstarted', target: { conversationId: 'group', recipientIds: ['second'] } })
  const replacement = changed.result.replacements[0]
  assert.equal(replacement.slotId, original.slotId)
  assert.equal(replacement.replacementOf, original.id)
  assert.equal(replacement.acceptedScheduleRevision, 2)
  await assert.rejects(f.claim(original), { code: 'DYNAMIC_COORDINATION_CANCELLED' })
  const job = await f.claim(replacement)
  const read = await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })
  assert.deepEqual(read.result.occurrence.target.recipientIds, ['second'])
  await f.restart()
  assert.equal((await f.scan()).result.occurrences.length, 0)
  const records = await f.occurrences()
  assert.equal(records.find(o => o.id === original.id).replacedBy, replacement.id)
  assert.equal(records.filter(o => o.actionState === 'succeeded').length, 1)
})

test('explicit reschedule preserves replacement chain and cannot run before the new slot', async t => {
  const f = await fixture(t)
  f.tick(3600000)
  const original = (await f.scan()).result.occurrences[0]
  const changed = await f.change({ expectedRevision: 1, scope: 'unstarted', replacementPlannedAt: '2026-10-21T02:00:00.000Z' })
  const replacement = changed.result.replacements[0]
  assert.notEqual(replacement.slotId, original.slotId)
  await assert.rejects(f.claim(replacement), { code: 'DYNAMIC_COORDINATION_NOT_DUE' })
  f.tick(3600000)
  assert.equal((await f.scan()).result.occurrences.length, 0)
  await f.claim(replacement)
  await assert.rejects(f.change({ expectedRevision: 2, scope: 'unstarted', replacementPlannedAt: '2026-10-21T03:00:00.000Z' }), { code: 'DYNAMIC_COORDINATION_SLOT_CONSUMED' })
})

test('pause retains due cursor and resume coalesces offline periods under the original misfire policy', async t => {
  const f = await fixture(t, { kind: 'daily', time: '09:00' })
  await f.change({ expectedRevision: 1, state: 'paused' })
  f.tick(2 * 86400000 + 3600000)
  assert.equal((await f.scan()).result.occurrences.length, 0)
  await f.change({ expectedRevision: 2, state: 'active' })
  const occurrence = (await f.scan()).result.occurrences[0]
  assert.equal(occurrence.plannedAt, '2026-10-23T01:00:00.000Z')
  assert.equal(occurrence.merged, 2)
  assert.deepEqual(occurrence.mergedRange, { from: '2026-10-21T01:00:00.000Z', through: '2026-10-23T01:00:00.000Z' })
  await f.claim(occurrence)
})

test('coordination cancellation stops new due instances and prevents already claimed read results', async t => {
  const f = await fixture(t)
  f.tick(3600000)
  const occurrence = (await f.scan()).result.occurrences[0]
  const job = await f.claim(occurrence)
  await f.command('coordination.cancel', { coordinationId: 'query', expectedRevision: 1 })
  await assert.rejects(f.command('coordination.job.read', { jobId: job.id, fence: job.fence }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  assert.equal((await f.scan()).result.occurrences.length, 0)
  await assert.rejects(f.claim(occurrence), { code: 'DYNAMIC_COORDINATION_CANCELLED' })
})

test('one waiting backlog is retained while active work or unknown delivery prevents overlapping execution', async t => {
  const f = await fixture(t, { kind: 'daily', time: '09:00' })
  f.tick(3600000)
  const first = (await f.scan()).result.occurrences[0]
  const firstJob = await f.claim(first)
  await f.command('coordination.job.read', { jobId: firstJob.id, fence: firstJob.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: first.id })).result.notification
  const permit = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: permit.dispatchToken, state: 'unknown' })
  f.tick(86400000)
  const second = (await f.scan()).result.occurrences[0]
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_COORDINATION_OVERLAP' })
  f.tick(86400000)
  const third = (await f.scan()).result.occurrences[0]
  assert.deepEqual(third.mergedOccurrenceIds, [second.id])
  assert.equal((await f.jobs()).find(j => j.occurrenceId === second.id).state, 'superseded')
  await f.command('notification.reconcile', { notificationId: notification.id, state: 'delivered', receipt: { messageId: 'fake-confirmed' }, evidenceRef: 'isolated-test-proof' })
  await f.claim(third)
})

test('expired one-time schedule terminates visibly; multi-year offline coalescing has an exact count', async t => {
  const f = await fixture(t)
  f.tick(7200000)
  const expired = (await f.scan()).result.occurrences[0]
  assert.equal(expired.actionState, 'expired')
  const schedule = (await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.state, 'completed'); assert.equal(schedule.outcome, 'expired')
  const summary = summarizeTimeSlots({ kind: 'daily', time: '09:00' }, 'Asia/Shanghai', Date.parse('2024-01-01T01:00:00Z'), Date.parse('2026-01-01T01:00:00Z'))
  assert.deepEqual(summary, { latest: '2026-01-01T01:00:00.000Z', count: 732 })
})
