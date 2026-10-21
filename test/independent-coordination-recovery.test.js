import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openIndependentCoordination } from '../packages/dingtalk-dsh-assistant/independent-coordination-service.js'

const clone = value => JSON.parse(JSON.stringify(value))
async function fixture(t, { enabled = false, planner, failApplyAck = false, failResidentAcceptance = false, authenticated = true, actorId = 'author' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'independent-recovery-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'independent-test', initialize: true }
  let store = await openDynamicTaskStore(options), service
  const entry = { reservationId: 'reservation', generation: 1, unitId: 'unit', unitRevision: 1, dispatchOwner: 'coordination',
    semanticState: 'reserved', settled: false, frozen: false,
    sourceSnapshot: { messageId: 'message', messageVersion: 1, actorId, unitText: '继续 A；稍后查询进度', text: '继续 A；稍后查询进度', sourceRefs: [] } }
  const errors = [], handoffs = [], commands = []
  const residentStore = {
    getSourceDispatchOwnership: () => clone(entry),
    listSourceDispatchOwnership: () => [clone(entry)],
    getGroup: () => ({ messages: [{ messageId: 'message', senderOpenDingTalkId: 'author', senderName: 'author', occurredAt: new Date().toISOString() }] }),
    async updateSourceDispatch(args) {
      assert.equal(args.expectedGeneration, entry.generation, 'resident adapter enforces CAS')
      if (failResidentAcceptance && args.semanticState === 'accepted') {
        failResidentAcceptance = false
        throw Object.assign(new Error('injected crash before resident acceptance receipt'), { code: 'INJECTED_RESIDENT_ACK_LOSS' })
      }
      Object.assign(entry, clone(args)); return clone(entry)
    },
  }
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const command = async (kind, args, id = randomUUID()) => {
    commands.push(kind)
    const receipt = await store.command({ kind, args, id })
    if (kind === 'coordination.apply' && failApplyAck) {
      failApplyAck = false
      throw Object.assign(new Error('injected lost acknowledgement after apply commit'), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN' })
    }
    return receipt
  }
  if (authenticated) await command('source.record', { sourceId: 'source', groupId: 'group', messageId: 'message', version: 1,
    actorId: 'author', text: entry.sourceSnapshot.text, timestamp: new Date().toISOString() })
  await command('task.create', { taskId: 'A', groupId: 'group', ownerActorId: 'task-owner', request: 'original A', requirements: ['A accepted'] })
  const open = () => service = openIndependentCoordination({ config: enabled ? { enabled: true, provider: 'test', model: 'test' } : {},
    residentStore, query, command, ownerActorId: 'configured-owner', planner: planner ?? { plan: async () => {}, close: async () => {} },
    onApplied: async member => { handoffs.push(member.id) }, onError: (id, error) => errors.push({ id, code: error.code ?? error.message }) })
  open()
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  const request = () => ({ ...clone(entry), groupId: 'group' })
  const arrangement = (action = 'task-context') => ({ kind: 'arrangement', commonContext: '', allTogether: false,
    members: [{ taskId: 'A', action, inputVersion: 1, runSequence: 1, progressImpact: 'preserve', impactReason: 'only extra context', context: 'additional material', afterTaskIds: [] }] })
  const schedule = () => ({ kind: 'schedule', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600000).toISOString() },
    taskIds: ['A'], recipientIds: ['author'], interpretation: 'one hour later' })
  return { entry, errors, handoffs, commands, query, command, request, arrangement, schedule,
    get service() { return service },
    async observe() { await service.context(request(), { taskIds: ['A'] }) },
    async restart() { await service.close(); await store.close(); store = await openDynamicTaskStore(options); open() } }
}

for (const invalid of ['recipient','timezone','past','rule']) test(`invalid schedule ${invalid} has zero semantic acceptance or resident settlement`, async t => {
  const f = await fixture(t)
  await f.observe()
  const proposal = f.schedule()
  if (invalid === 'recipient') proposal.recipientIds = ['unknown-member']
  if (invalid === 'timezone') proposal.timezone = 'Missing/Timezone'
  if (invalid === 'past') proposal.rule.at = '2000-01-01T00:00:00.000Z'
  if (invalid === 'rule') proposal.rule = { kind: 'daily', time: '25:77' }
  await assert.rejects(f.service.submit(f.request(), proposal))
  assert.equal(f.commands.includes('coordination.accept'), false)
  assert.deepEqual(await f.query('coordination.list'), [])
  assert.deepEqual(await f.query('coordination.schedule.list'), [])
  assert.equal(f.entry.semanticState, 'reserved'); assert.equal(f.entry.settled, false)
})

test('accept plus schedule creation is one ledger transaction and an invalid direct schedule rolls both back', async t => {
  const f = await fixture(t)
  const source = (await f.command('coordination.reserve', { unitId: 'direct', revision: 1, groupId: 'group', original: 'query A' })).result.source
  await assert.rejects(f.command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'direct-coordination', members: [], readOnly: true,
    schedule: { scheduleId: 'direct-schedule', timezone: 'Bad/Zone', rule: f.schedule().rule,
      action: { kind: 'read-query', taskIds: ['A'] }, target: { conversationId: 'group', recipientIds: [] } } }))
  assert.deepEqual(await f.query('coordination.list'), [])
  assert.deepEqual(await f.query('coordination.schedule.list'), [])
  assert.equal((await f.query('coordination.source', { unitId: 'direct', revision: 1 })).state, 'reserved')
})

test('accept commit before resident acknowledgement recovers the same schedule and frozen summary without another model', async t => {
  const f = await fixture(t, { failResidentAcceptance: true })
  await f.observe()
  await assert.rejects(f.service.submit(f.request(), f.schedule()), { code: 'INJECTED_RESIDENT_ACK_LOSS' })
  assert.equal(f.entry.semanticState, 'reserved')
  const before = await f.query('coordination.list'), schedules = await f.query('coordination.schedule.list')
  assert.equal(before.length, 1); assert.equal(schedules.length, 1)
  assert.deepEqual(await f.query('notification.list'), [])
  await f.restart()
  await f.service.recoverGroup('group')
  assert.equal(f.entry.semanticState, 'accepted'); assert.equal(f.entry.settled, true)
  assert.deepEqual((await f.query('coordination.schedule.list')).map(s => s.id), schedules.map(s => s.id))
  const notifications = await f.query('notification.list')
  assert.equal(notifications.length, 1)
  await f.service.recoverGroup('group')
  assert.deepEqual((await f.query('notification.list')).map(n => n.id), notifications.map(n => n.id))
  assert.equal(f.commands.filter(kind => kind === 'coordination.accept').length, 1)
})

test('apply commit with lost acknowledgement recovers only the missing Host handoff without replaying task mutation', async t => {
  const f = await fixture(t, { failApplyAck: true })
  await f.observe()
  await f.service.submit(f.request(), f.arrangement())
  await f.service.recoverGroup('group')
  const coordination = (await f.query('coordination.list'))[0]
  let member = (await f.query('coordination.get', { coordinationId: coordination.id })).members[0]
  assert.equal(member.state, 'applied'); assert.equal(member.hostHandoffAt, undefined)
  assert.equal((await f.query('task.get', { taskId: 'A' })).contextRevision, 1)
  assert.deepEqual(f.handoffs, [])
  await f.restart()
  await f.service.recoverGroup('group')
  member = (await f.query('coordination.get', { coordinationId: coordination.id })).members[0]
  assert.ok(member.hostHandoffAt)
  assert.deepEqual(f.handoffs, [member.id])
  await f.service.recoverGroup('group')
  assert.deepEqual(f.handoffs, [member.id])
  assert.equal((await f.query('task.get', { taskId: 'A' })).contextRevision, 1)
  assert.equal(f.commands.filter(kind => kind === 'coordination.apply').length, 1)
})

test('planner failures honor durable retry times and three-attempt budget across restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  let attempts = 0
  const f = await fixture(t, { enabled: true, planner: { plan: async () => { attempts++; throw Object.assign(new Error('temporary model failure'), { code: 'TEST_MODEL_TRANSIENT' }) }, close: async () => {} } })
  await f.service.recoverGroup('group')
  await f.service.recoverGroup('group')
  assert.equal(attempts, 1)
  t.mock.timers.tick(5000)
  await f.service.recoverGroup('group')
  assert.equal(attempts, 2)
  await f.restart()
  await f.service.recoverGroup('group')
  assert.equal(attempts, 2)
  t.mock.timers.tick(60000)
  await f.service.recoverGroup('group')
  assert.equal(attempts, 3)
  t.mock.timers.tick(86400000)
  await f.service.recoverGroup('group')
  assert.equal(attempts, 3)
  const source = await f.query('coordination.source', { unitId: 'unit', revision: 1 })
  assert.equal(source.attemptCount, 3); assert.equal(source.nextRetryAt, null)
  assert.equal(source.state, 'reserved'); assert.equal(f.entry.settled, false)
  assert.deepEqual(await f.query('coordination.list'), [])
})

test('stale reservation fence, missing authenticated source and unauthorized task cancellation produce no accepted work', async t => {
  const f = await fixture(t)
  await f.observe()
  const stale = f.request()
  f.entry.generation++
  await assert.rejects(f.service.submit(stale, f.arrangement()), { code: 'COORDINATION_SOURCE_FENCED' })
  f.entry.generation--
  await assert.rejects(f.service.submit(f.request(), f.arrangement('task-cancel')), { code: 'COORDINATION_CONTROL_FORBIDDEN' })
  assert.deepEqual(await f.query('coordination.list'), [])
  assert.equal((await f.query('task.get', { taskId: 'A' })).control, 'active')
  const missing = await fixture(t, { authenticated: false })
  await missing.observe()
  await assert.rejects(missing.service.submit(missing.request(), missing.arrangement()), { code: 'COORDINATION_AUTHENTICATED_SOURCE_REQUIRED' })
  assert.deepEqual(await missing.query('coordination.list'), [])
})

test('clarification recovery freezes one real coordination notification and preserves unsettled exclusive ownership', async t => {
  const f = await fixture(t, { failResidentAcceptance: false })
  await f.service.submit(f.request(), { kind: 'clarify', question: 'Which of the two A tasks?', candidates: ['A','other A'] })
  assert.equal(f.entry.semanticState, 'needs_clarification'); assert.equal(f.entry.settled, false)
  const before = await f.query('notification.list')
  assert.equal(before.length, 1)
  await f.restart()
  await f.service.recoverGroup('group')
  assert.deepEqual((await f.query('notification.list')).map(n => n.id), before.map(n => n.id))
  assert.equal(f.entry.dispatchOwner, 'coordination'); assert.equal(f.entry.settled, false)
  assert.equal((await f.query('coordination.list'))[0].state, 'needs_clarification')
})
