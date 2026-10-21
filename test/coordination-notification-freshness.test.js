import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { deliverTaskNotification } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { taskNotificationOutbound } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'

async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const directory = await mkdtemp(join(tmpdir(), 'coordination-freshness-'))
  const options = { dbPath: join(directory, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(options), sends = 0
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  await command('task.create', { taskId: 'A', groupId: 'group', request: '原业务目标' })
  const source = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'group', original: '9点查询A' })).result.source
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'query', members: [], readOnly: true })
  await command('coordination.schedule.create', { coordinationId: 'query', scheduleId: 'schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, action: { kind: 'read-query', taskIds: ['A'] },
    target: { conversationId: 'group', recipientIds: ['stable-member'] } })
  t.mock.timers.tick(3600000)
  const occurrence = (await command('coordination.schedule.scan')).result.occurrences[0]
  const job = (await command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await command('coordination.job.read', { jobId: job.id, fence: job.fence })
  const notification = (await command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const refreshArgs = { occurrenceId: occurrence.id, expectedNotificationId: notification.id, expectedResultVersion: 1,
    expectedInstanceControlRevision: 1, expectedDeliveryControlRevision: 1 }
  const notifications = {
    canDisclose: async () => true,
    send: async candidate => { sends++; return { messageId: `fake:${candidate.id}` } },
    readback: async candidate => ({ messageId: `fake:${candidate.id}`, visible: true, deliveryStatus: 'delivered' }),
  }
  return { options, command, query, occurrence, notification, refreshArgs,
    expire: () => t.mock.timers.tick(300001),
    refresh: (args = {}, id) => command('coordination.notification.refresh', { ...refreshArgs, ...args }, id),
    notificationById: id => query('notification.get', { notificationId: id }),
    occurrenceNow: async () => (await query('coordination.occurrence.list'))[0],
    deliver: candidate => deliverTaskNotification({ notification: candidate, notifications, command }),
    get sends() { return sends },
    async close() { await store.close() },
    async restart() { await store.close(); store = await openDynamicTaskStore(options) },
  }
}

test('expired unpermitted candidate atomically supersedes with a fresh read and immutable old payload', async t => {
  const f = await fixture(t)
  const originalPayload = structuredClone(f.notification.payload)
  await f.command('task.supplement', { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'new-fact', text: '新的材料', request: '原业务目标\n新的材料' })
  const taskBeforeRefresh = await f.query('task.get', { taskId: 'A' })
  f.expire()
  const fresh = (await f.refresh()).result.notification
  const old = await f.notificationById(f.notification.id), occurrence = await f.occurrenceNow()
  assert.equal(old.state, 'superseded'); assert.equal(old.supersededBy, fresh.id)
  assert.deepEqual(old.payload, originalPayload)
  assert.equal(occurrence.resultVersion, 2); assert.equal(occurrence.notificationId, fresh.id)
  assert.equal(occurrence.result.results[0].contextRevision, 1)
  assert.equal(occurrence.resultHistory.length, 1)
  assert.equal(occurrence.resultHistory[0].result.results[0].contextRevision, 0)
  assert.notEqual(fresh.payload.fact.resultDigest, old.payload.fact.resultDigest)
  assert.notEqual(occurrence.result.observedAt, occurrence.resultHistory[0].result.observedAt)
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), taskBeforeRefresh)
  assert.equal(taskNotificationOutbound(old).status, 'superseded')
  assert.equal(taskNotificationOutbound(old).supersededByOutboundId, fresh.id)
  await f.deliver(f.notification) // stale outbox candidate still carries the old prepared snapshot
  assert.equal(f.sends, 0)
  await f.deliver(fresh)
  assert.equal(f.sends, 1)
})

test('permit wins: starting, recovered unknown and delivered candidates cannot be refreshed or resent', async t => {
  const f = await fixture(t)
  const permit = await f.command('notification.start', { notificationId: f.notification.id }, 'permit-original')
  assert.equal(permit.dispatchEligible, true)
  f.expire()
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  await f.restart()
  assert.equal((await f.notificationById(f.notification.id)).state, 'unknown')
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id }, 'permit-original')).dispatchEligible, false)
  await f.deliver(await f.notificationById(f.notification.id)) // readback only; never invokes send
  assert.equal(f.sends, 0)
  assert.equal((await f.notificationById(f.notification.id)).state, 'delivered')
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  assert.equal((await f.query('notification.list')).length, 1)
})

test('refresh wins: old payload and old outbox identity remain permanently unsendable after restart', async t => {
  const f = await fixture(t)
  f.expire()
  const fresh = (await f.refresh()).result.notification
  await f.restart()
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, false)
  await f.deliver(f.notification)
  assert.equal(f.sends, 0)
  await f.deliver(fresh)
  assert.equal(f.sends, 1)
  await f.deliver(await f.notificationById(fresh.id))
  assert.equal(f.sends, 1)
})

test('cancellation wins before refresh and prevents all new send permits', async t => {
  const f = await fixture(t)
  f.expire()
  await f.command('coordination.occurrence.cancel', { occurrenceId: f.occurrence.id, expectedControlRevision: 1 })
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  assert.equal((await f.command('notification.start', { notificationId: f.notification.id })).dispatchEligible, false)
  await f.deliver(f.notification)
  assert.equal(f.sends, 0)
  assert.equal((await f.query('notification.list')).length, 1)
})

test('freshness threshold, expected versions and replay preserve one immutable replacement identity', async t => {
  const f = await fixture(t)
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_RESULT_FRESH' })
  f.expire()
  for (const args of [{ expectedResultVersion: 2 }, { expectedInstanceControlRevision: 2 }, { expectedDeliveryControlRevision: 2 }])
    await assert.rejects(f.refresh(args), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  const first = await f.refresh({}, 'frozen-refresh-command')
  const replay = await f.refresh({}, 'frozen-refresh-command')
  assert.equal(replay.replayed, true)
  assert.equal(replay.result.notification.id, first.result.notification.id)
  assert.equal((await f.occurrenceNow()).resultVersion, 2)
  assert.equal((await f.query('notification.list')).length, 2)
  await assert.rejects(f.refresh(), { code: 'DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED' })
  await assert.rejects(f.command('notification.prepare', { notificationId: 'duplicate-event', kind: 'coordination', requirementRevision: 1,
    payload: first.result.notification.payload }), { code: 'DYNAMIC_NOTIFICATION_EVENT_CONFLICT' })
})

test('SIGKILL after atomic supersede but before outbox creation recovers the new frozen identity only', async t => {
  const f = await fixture(t)
  f.expire()
  const fixedNow = Date.now()
  await f.close()
  const moduleUrl = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const script = `import { mock } from 'node:test'; import { openDynamicTaskStore } from ${JSON.stringify(moduleUrl)};
    mock.timers.enable({apis:['Date'],now:Number(process.argv[3])});
    const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
    await store.command({id:'refresh-before-kill',kind:'coordination.notification.refresh',args:JSON.parse(process.argv[2])});
    process.stdout.write('refreshed'); setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(f.options), JSON.stringify(f.refreshArgs), String(fixedNow)], { stdio: ['ignore','pipe','pipe'] })
  const exited = once(child, 'exit')
  t.after(() => child.kill('SIGKILL'))
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
    exited.then(([code, signal]) => { throw new Error(`child exited before refresh: ${code}/${signal}`) }),
  ])
  assert.equal(ready, 'refreshed')
  child.kill('SIGKILL'); assert.deepEqual(await exited, [null, 'SIGKILL'])
  await f.restart()
  const occurrence = await f.occurrenceNow()
  const fresh = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  assert.equal(occurrence.resultVersion, 2)
  assert.equal(fresh.id, occurrence.notificationId)
  assert.equal((await f.notificationById(f.notification.id)).supersededBy, fresh.id)
  assert.deepEqual((await f.notificationById(f.notification.id)).payload, f.notification.payload)
  await f.deliver(f.notification); assert.equal(f.sends, 0)
  await f.deliver(fresh); assert.equal(f.sends, 1)
  assert.equal((await f.query('notification.list')).length, 2)
})
