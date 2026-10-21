import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coordination-'))
  const options = { dbPath: join(dir, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ kind, args, id })
  const query = q => store.query(q)
  const task = async id => command('task.create', { taskId: id, groupId: 'group', request: id })
  const reserve = async (id = 'unit') => (await command('coordination.reserve', { unitId: id, revision: 1, groupId: 'group', original: '先 A 后 B' })).result.source
  const member = (id, dependencies = []) => ({ instructionId: id, taskId: id, progressImpact: 'preserve', dependencies,
    command: { id: `coordination-command:batch:${id}`, kind: 'task.supplement', args: { taskId: id, expectedRequirementRevision: 1, expectedControlRevision: 1,
      messageId: `input:${id}`, text: '补充材料', request: `${id}\n补充材料` } } })
  return { options, command, query, task, reserve, member,
    async reopen() { await store.close(); store = await openDynamicTaskStore(options) },
    async close() { await store.close() },
    async migrate() { store = await openDynamicTaskStore({ ...options, migrate: true }) } }
}

test('source reservation and fixed member apply survive restart without replaying task mutation', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  assert.deepEqual(await f.reserve(), source)
  const args = { sourceId: source.id, fence: source.fence, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] }
  await f.command('coordination.accept', args)
  const receipt = await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  assert.equal(receipt.result.member.state, 'applied')
  await f.reopen()
  assert.equal((await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })).result.member.state, 'applied')
  assert.equal((await f.query({ kind: 'task.get', taskId: 'A' })).contextRevision, 1)
  assert.deepEqual((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.waiting, ['A'])
  await assert.rejects(f.command('task.supplement', { ...f.member('A').command.args, text: 'changed' }, 'coordination-command:batch:A'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
})

test('dependency gate rejects claim before resource acquisition and cancellation does not cancel task', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const owner = (await f.command('task.claim', { taskId: 'B' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding: owner, key: 'B-work', prompt: 'work', input: {}, resourceKeys: ['shared'] })).result.execution
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await assert.rejects(f.command('execution.claim', { executionId: execution.executionId }), { code: 'DYNAMIC_COORDINATION_WAITING' })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
  await f.command('coordination.cancel', { coordinationId: 'batch', expectedRevision: 1 })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'B' })).control, 'active')
  await f.command('execution.claim', { executionId: execution.executionId })
})

test('scope, impact and cycles reject the complete batch before any member exists', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  const accept = members => f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members })
  await assert.rejects(accept([f.member('A', ['B']), f.member('B', ['A'])]), { code: 'DYNAMIC_COORDINATION_CYCLE' })
  await assert.rejects(accept([{ ...f.member('A'), progressImpact: 'unknown' }]), { code: 'DYNAMIC_COORDINATION_IMPACT_REQUIRED' })
  await f.command('task.create', { taskId: 'foreign', groupId: 'other', request: 'foreign' })
  await assert.rejects(accept([f.member('foreign')]), { code: 'DYNAMIC_COORDINATION_SCOPE' })
  assert.deepEqual(await f.query({ kind: 'coordination.list' }), [])
})

test('six fixed members recover after the third apply; later conflict reports partial effects without compensation', async t => {
  const f = await fixture(t)
  const ids = ['A','B','C','D','E','F']
  for (const id of ids) await f.task(id)
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: ids.map(id => f.member(id)) })
  for (const id of ids.slice(0,3)) await f.command('coordination.apply', { instructionId: id, expectedRevision: 1 })
  await f.reopen()
  for (const id of ids.slice(0,4)) await f.command('coordination.apply', { instructionId: id, expectedRevision: 1 })
  await f.command('task.revise', { taskId: 'E', request: 'concurrent new goal' })
  await assert.rejects(f.command('coordination.apply', { instructionId: 'E', expectedRevision: 1 }), { code: 'DYNAMIC_COORDINATION_VERSION_STALE' })
  const batch = await f.query({ kind: 'coordination.get', coordinationId: 'batch' })
  assert.deepEqual(batch.members.map(m => m.state), ['applied','applied','applied','applied','ready','ready'])
  for (const id of ids.slice(0,4)) assert.equal((await f.query({ kind: 'task.get', taskId: id })).contextRevision, 1)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'F' })).contextRevision ?? 0, 0)
})

test('formal current Owner completion releases B; reopening A invalidates its old proof', async t => {
  const f = await fixture(t)
  await f.task('A'); await f.task('B')
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding: owner, summary: 'A accepted', result: { evidence: ['proof:A'] } })
  assert.equal((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.member.state, 'applied')
  await f.command('task.drained', { binding: owner })
  await f.command('task.reopen', { taskId: 'A', request: 'A changed' })
  const bOwner = (await f.command('task.claim', { taskId: 'B' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding: bOwner, key: 'B-work', prompt: 'B', input: {}, resourceKeys: ['shared'] })).result.execution
  await assert.rejects(f.command('execution.claim', { executionId: execution.executionId }), { code: 'DYNAMIC_COORDINATION_WAITING' })
  assert.deepEqual(await f.query({ kind: 'resource.list' }), [])
})

test('v1 migration requires opt in, validates identity and preserves history atomically', async t => {
  const f = await fixture(t)
  await f.task('history'); await f.close()
  const db = new DatabaseSync(f.options.dbPath)
  db.exec('DROP TABLE dynamic_coordination; DROP TABLE dynamic_coordination_sources; DROP TABLE dynamic_coordination_members; DROP TABLE dynamic_coordination_schedules; DROP TABLE dynamic_coordination_occurrences; DROP TABLE dynamic_coordination_slots; DROP TABLE dynamic_coordination_jobs; PRAGMA user_version=1')
  db.close()
  await assert.rejects(openDynamicTaskStore(f.options), { code: 'DYNAMIC_MIGRATION_REQUIRED' })
  await assert.rejects(openDynamicTaskStore({ ...f.options, instanceId: 'wrong', migrate: true }), { code: 'DYNAMIC_INITIALIZATION_MARKER_INVALID' })
  await f.migrate()
  assert.equal((await f.query({ kind: 'task.get', taskId: 'history' })).taskId, 'history')
  assert.deepEqual(await f.query({ kind: 'coordination.list' }), [])
})

async function querySchedule(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const f = await fixture(t)
  await f.task('A')
  const source = await f.reserve()
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'query', members: [], readOnly: true })
  await f.command('coordination.schedule.create', { coordinationId: 'query', scheduleId: 'schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, action: { kind: 'read-query', taskIds: ['A'] },
    target: { conversationId: 'group', recipientIds: ['member-id'] } })
  t.mock.timers.tick(3600000)
  return f
}

test('due scan is durable, read-query observes current facts without changing Task, no Topic required', async t => {
  const f = await querySchedule(t)
  const before = await f.query({ kind: 'task.get', taskId: 'A' })
  const first = await f.command('coordination.schedule.scan', {})
  assert.equal(first.result.occurrences.length, 1)
  assert.equal((await f.command('coordination.schedule.scan', {})).result.occurrences.length, 0)
  await f.reopen()
  const occurrence = (await f.query({ kind: 'coordination.occurrence.list' }))[0]
  const claim = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.read', { jobId: claim.id, fence: claim.fence })
  assert.deepEqual(await f.query({ kind: 'task.get', taskId: 'A' }), before)
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  assert.equal(notification.taskId, null)
  assert.equal(notification.payload.fact.occurrenceId, occurrence.id)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, ['member-id'])
  assert.equal((await f.query({ kind: 'coordination.occurrence.list' }))[0].deliveryState, 'pending')
})

test('cancel before permit prevents send; permit before cancel becomes unknown after restart and never replays', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.read', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const permit = await f.command('notification.start', { notificationId: notification.id }, 'send-permit')
  assert.equal(permit.dispatchEligible, true)
  await f.command('coordination.occurrence.cancel', { occurrenceId: occurrence.id, expectedControlRevision: 1 })
  await f.reopen()
  assert.equal((await f.query({ kind: 'notification.get', notificationId: notification.id })).state, 'unknown')
  assert.equal((await f.command('notification.start', { notificationId: notification.id }, 'send-permit')).dispatchEligible, false)
  assert.equal((await f.command('notification.start', { notificationId: notification.id })).dispatchEligible, false)
})

test('cancel wins send-permit CAS and stale query worker cannot publish after lease reclaim', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  const first = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  t.mock.timers.tick(60001)
  const second = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await assert.rejects(f.command('coordination.job.read', { jobId: first.id, fence: first.fence }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  await f.command('coordination.job.read', { jobId: second.id, fence: second.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  await f.command('coordination.occurrence.cancel', { occurrenceId: occurrence.id, expectedControlRevision: 1 })
  assert.equal((await f.command('notification.start', { notificationId: notification.id })).dispatchEligible, false)
})

test('SIGKILL after job claim recovers the same occurrence and preserves the lease instead of inventing success', async t => {
  const f = await querySchedule(t)
  const occurrence = (await f.command('coordination.schedule.scan', {})).result.occurrences[0]
  await f.close()
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const script = `import { openDynamicTaskStore } from ${JSON.stringify(moduleUrl)};
    const store = await openDynamicTaskStore(JSON.parse(process.argv[1]));
    await store.command({id:'crash-claim',kind:'coordination.job.claim',args:{jobId:process.argv[2]}});
    process.stdout.write('claimed'); setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(f.options), occurrence.jobId], { stdio: ['ignore','pipe','pipe'] })
  const exited = once(child, 'exit')
  t.after(() => child.kill('SIGKILL'))
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
    exited.then(([code, signal]) => { throw new Error(`child exited before claim: ${code}/${signal}`) }),
  ])
  assert.equal(ready, 'claimed')
  child.kill('SIGKILL')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  await f.reopen()
  assert.equal((await f.command('coordination.schedule.scan', {})).result.occurrences.length, 0)
  const recovered = await f.query({ kind: 'coordination.occurrence.list' })
  assert.equal(recovered.length, 1); assert.equal(recovered[0].id, occurrence.id)
  assert.equal(recovered[0].actionState, 'running')
  const job = (await f.query({ kind: 'coordination.job.list' }))[0]
  assert.equal(job.attempt, 1); assert.equal(job.state, 'running'); assert.equal(job.result, undefined)
})
