import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openIndependentCoordination } from '../packages/dingtalk-dsh-assistant/independent-coordination-service.js'
import { localSlot } from '../packages/dingtalk-dsh-assistant/coordination-time.js'

const clone = value => JSON.parse(JSON.stringify(value))
async function fixture(t, { enabled = false, planner, failApplyAck = false, failResidentAcceptance = false, authenticated = true, actorId = 'author', seedTask = true, legacySummaryText } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'independent-recovery-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'independent-test', initialize: true }
  let store = await openDynamicTaskStore(options), service
  const entry = { reservationId: 'reservation', generation: 1, unitId: 'unit', unitRevision: 1, dispatchOwner: 'coordination',
    semanticState: 'reserved', settled: false, frozen: false,
    sourceSnapshot: { messageId: 'message', messageVersion: 1, actorId, unitText: '继续 A；稍后查询进度', text: '继续 A；稍后查询进度', sourceRefs: [], occurredAt: new Date().toISOString() } }
  const errors = [], recovered = [], handoffs = [], commands = []
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
    if (kind === 'notification.prepare' && legacySummaryText) {
      args = { ...args, payload: { ...args.payload, text: legacySummaryText } }
      legacySummaryText = undefined
    }
    const receipt = await store.command({ kind, args, id })
    if (kind === 'coordination.job.command' && failApplyAck) {
      failApplyAck = false
      throw Object.assign(new Error('injected lost acknowledgement after apply commit'), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN' })
    }
    return receipt
  }
  if (authenticated) await command('source.record', { sourceId: 'source', groupId: 'group', messageId: 'message', version: 1,
    actorId: 'author', text: entry.sourceSnapshot.text, timestamp: new Date().toISOString() })
  if (seedTask) await command('task.create', { taskId: 'A', groupId: 'group', ownerActorId: 'task-owner', request: 'original A', requirements: ['A accepted'] })
  const open = () => service = openIndependentCoordination({ config: enabled ? { enabled: true, provider: 'test', model: 'test' } : {},
    residentStore, query, command, ownerActorId: 'configured-owner', planner: planner ?? { plan: async () => {}, close: async () => {} },
    onApplied: async member => { handoffs.push(member.id) }, onError: (id, error) => errors.push({ id, code: error.code ?? error.message }), onRecovered: id => recovered.push(id) })
  open()
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  const request = () => ({ ...clone(entry), groupId: 'group' })
  const arrangement = (action = 'task-context') => ({ kind: 'arrangement', commonContext: '', allTogether: false,
    members: [{ taskId: 'A', action, inputVersion: 1, runSequence: 1, progressImpact: 'preserve', impactReason: 'only extra context', context: 'additional material', afterTaskIds: [] }] })
  const schedule = () => ({ kind: 'schedule', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600000).toISOString() },
    taskIds: ['A'], recipientIds: ['author'], interpretation: 'one hour later' })
  return { entry, errors, recovered, handoffs, commands, query, command, request, arrangement, schedule,
    get service() { return service },
    async runJobs() {
      for (const job of await query('coordination.job.list')) if (job.state === 'waiting') {
        const claimed = (await command('coordination.job.claim', { jobId: job.id })).result.job
        await command('coordination.job.command', { jobId: claimed.id, fence: claimed.fence })
      }
    },
    async observe() { await service.context(request(), { taskIds: ['A'] }) },
    async restart() { await service.close(); await store.close(); store = await openDynamicTaskStore(options); open() } }
}

test('recovery retains a previously frozen acknowledgement when the current reply template changed', async t => {
  const f = await fixture(t, { legacySummaryText: '已记录 1 项明确安排；另有 1 项待澄清：[other] 另一个是哪项？。明确且独立的成员继续处理。' })
  await f.observe()
  await f.service.submit(f.request(), { ...f.arrangement(), pendingClarifications: [{ clarificationId: 'other', question: '另一个是哪项？', candidates: [] }] })
  const before = await f.query('notification.list')
  await f.restart(); await f.service.recoverGroup('group')
  assert.deepEqual(f.errors, [])
  assert.deepEqual(await f.query('notification.get', { notificationId: before[0].id }), before[0])
  assert.equal(f.commands.filter(kind => kind === 'notification.prepare').length, 1)
})

test('non-browser coordination receives working timezone and original local time without fabricating a missing source time', async t => {
  const f = await fixture(t, { seedTask: false })
  f.entry.sourceSnapshot.occurredAt = '2026-10-23T07:11:51.000Z'
  const context = await f.service.context(f.request())
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(context.timeContext.timeZone, timeZone)
  assert.equal(context.timeContext.source, 'host-working-timezone')
  assert.deepEqual(context.timeContext.sourceLocal, localSlot(f.entry.sourceSnapshot.occurredAt, timeZone))
  assert.deepEqual(context.taskContexts, [])
  delete f.entry.sourceSnapshot.occurredAt
  assert.equal((await f.service.context(f.request())).timeContext.sourceLocal, null)
})

for (const previousState of ['prepared','starting','unknown','delivered'])
  test(`time correction resolves one reminder and preserves ${previousState} send boundary`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T07:11:12.000Z') })
    const f = await fixture(t, { seedTask: false })
    f.entry.sourceSnapshot.unitText = '小小鹏，三点提醒我一下查看云端专家的开发进度'
    await f.service.submit(f.request(), { kind: 'clarify', question: '三点已过，改到几点？', candidates: [] })
    const original = (await f.query('coordination.list'))[0]
    const oldNotification = (await f.query('notification.list'))[0]
    if (previousState !== 'prepared') {
      const started = (await f.command('notification.start', { notificationId: oldNotification.id })).result.notification
      if (previousState !== 'starting') await f.command('notification.receipt', {
        notificationId: oldNotification.id, dispatchToken: started.dispatchToken, state: previousState,
        evidenceRef: 'fixture-send-evidence', receipt: { messageId: 'sent-original' },
      })
    }
    const before = await f.query('notification.list')
    t.mock.timers.tick(39_000)
    Object.assign(f.entry, { reservationId: 'correction', unitId: 'correction-unit', semanticState: 'reserved', settled: false })
    Object.assign(f.entry.sourceSnapshot, { messageId: 'correction-message',
      text: '小小鹏，三点20提醒我一下查看云端专家的开发进度',
      unitText: '小小鹏，三点20提醒我一下查看云端专家的开发进度', occurredAt: new Date().toISOString() })
    await f.command('source.record', { sourceId: 'correction-source', groupId: 'group', messageId: 'correction-message',
      version: 1, actorId: 'author', text: f.entry.sourceSnapshot.text, timestamp: new Date().toISOString() })
    await f.service.context(f.request(), { coordinationIds: [original.id] })
    await f.service.submit(f.request(), { kind: 'resolve', coordinationId: original.id, expectedRevision: 1,
      resolution: { kind: 'schedule', actionKind: 'message-reminder', timezone: 'Asia/Shanghai',
        rule: { kind: 'once', at: '2026-10-23T07:20:00.000Z' }, recipientIds: ['author'],
        reminderText: '提醒你查看云端专家的开发进度。', interpretation: '内部来源订正；由Host判断补执行窗口。' } })
    assert.equal((await f.query('coordination.list')).length, 1)
    const schedules = await f.query('coordination.schedule.list')
    assert.equal(schedules.length, 1)
    assert.equal(schedules[0].nextDueAt, '2026-10-23T07:20:00.000Z')
    assert.equal(schedules[0].action.kind, 'message-reminder')
    assert.deepEqual(await f.query('task.list'), [])
    const originalSource = await f.query('coordination.source', { unitId: 'unit', revision: 1 })
    assert.ok(originalSource.resolvedBy)
    const result = await f.command('notification.start', { notificationId: oldNotification.id })
    assert.equal(result.result.notification.state, previousState === 'prepared' ? 'superseded' : previousState)
    assert.equal(result.dispatchEligible, false)
    if (previousState !== 'prepared') assert.deepEqual(result.result.notification, before[0])
    const accepted = (await f.query('notification.list')).find(item => item.id !== oldNotification.id)
    assert.equal(accepted.payload.text, '已安排提醒：2026-10-23 15:20（Asia/Shanghai），提醒你查看云端专家的开发进度。')
    assert.doesNotMatch(accepted.payload.text, /确认|0 项|clarification|Host|补执行|内部/)
    await f.command('coordination.schedule.change', { scheduleId: schedules[0].id, expectedRevision: 1,
      rule: { kind: 'once', at: '2026-10-23T07:30:00.000Z' } })
    const changedPermit = await f.command('notification.start', { notificationId: accepted.id })
    assert.equal(changedPermit.result.notification.state, 'superseded', 'resolve-created schedule acknowledgement is stale after retiming too')
    assert.equal(changedPermit.dispatchEligible, false)
    await f.restart(); await f.service.recoverGroup('group')
    assert.equal((await f.query('coordination.schedule.list')).length, 1)
    assert.equal((await f.query('notification.list')).length, 2)
  })

for (const previousState of ['prepared','starting','unknown','delivered'])
  test(`accepted reminder retiming retires only unsent acknowledgement: ${previousState}`, async t => {
    const f = await fixture(t, { seedTask: false })
    await f.service.submit(f.request(), { ...f.schedule(), taskIds: [], actionKind: 'message-reminder', reminderText: '提醒查看进度。' })
    const schedule = (await f.query('coordination.schedule.list'))[0]
    const notification = (await f.query('notification.list'))[0]
    if (previousState !== 'prepared') {
      const started = (await f.command('notification.start', { notificationId: notification.id })).result.notification
      if (previousState !== 'starting') await f.command('notification.receipt', { notificationId: notification.id,
        dispatchToken: started.dispatchToken, state: previousState, evidenceRef: 'fixture-evidence' })
    }
    await f.command('coordination.schedule.change', { scheduleId: schedule.id, expectedRevision: 1,
      rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 7200000).toISOString() } })
    await f.restart(); await f.service.recoverGroup('group')
    const permit = await f.command('notification.start', { notificationId: notification.id })
    // 重启把已开始但缺回执的发送恢复成 unknown；改期不能重新授予发送许可。
    assert.equal(permit.result.notification.state, previousState === 'prepared' ? 'superseded' : previousState === 'starting' ? 'unknown' : previousState)
    assert.equal(permit.dispatchEligible, false)
    assert.deepEqual(permit.result.notification.payload, notification.payload, 'recovery must keep the original frozen payload')
    if (previousState === 'prepared') assert.equal(permit.result.notification.retirement.reason, 'coordination-schedule-changed')
    assert.equal((await f.query('notification.list')).length, 1)
  })

for (const field of ['taskIds','members','conditionalMembers'])
  test(`pure reminder rejects task effect field ${field} before acceptance`, async t => {
    const f = await fixture(t)
    const proposal = { ...f.schedule(), actionKind: 'message-reminder', taskIds: [], reminderText: '提醒你查看进度。',
      [field]: field === 'taskIds' ? ['A'] : f.arrangement('task-continue').members }
    await assert.rejects(f.service.submit(f.request(), proposal), { code: 'COORDINATION_REMINDER_INVALID' })
    assert.deepEqual(await f.query('coordination.list'), [])
    assert.deepEqual(await f.query('coordination.schedule.list'), [])
  })

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

test('read-query requires observed directory pages while mutations and conditional actions still require full contracts', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  await f.command('task.create', { taskId: 'foreign', groupId: 'other', request: 'foreign' })
  await assert.rejects(f.service.context(f.request(), { taskIds: ['foreign'] }), { code: 'COORDINATION_TASK_SCOPE' })
  await assert.rejects(f.service.submit(f.request(), f.schedule()), { code: 'COORDINATION_CONTEXT_REQUIRED' })
  const page = await f.service.context(f.request(), { limit: 1 })
  assert.equal(page.tasks.length, 1); assert.equal(page.nextOffset, 1)
  assert.equal(page.taskContexts.length, 0)
  assert.equal(page.source.occurredAt, f.entry.sourceSnapshot.occurredAt); assert.ok(Date.parse(page.currentTime))
  const hidden = ['A','B'].find(id => id !== page.tasks[0].taskId)
  await assert.rejects(f.service.submit(f.request(), { ...f.schedule(), taskIds: [hidden] }), { code: 'COORDINATION_CONTEXT_REQUIRED' })
  await assert.rejects(f.service.context(f.request(), { taskIds: ['foreign'] }), { code: 'COORDINATION_TASK_SCOPE' })
  await f.service.context(f.request(), { offset: page.nextOffset, limit: 1 })
  await assert.rejects(f.service.submit(f.request(), f.arrangement()), { code: 'COORDINATION_CONTEXT_REQUIRED' })
  await assert.rejects(f.service.submit(f.request(), { ...f.schedule(), actionKind: 'read-query', conditionalMembers: f.arrangement('task-continue').members }), { code: 'COORDINATION_CONTEXT_REQUIRED' })
  assert.deepEqual(await f.query('coordination.list'), [])
  const before = await f.query('task.list', { groupId: 'group' })
  await f.service.submit(f.request(), { ...f.schedule(), taskIds: ['A','B'] })
  assert.deepEqual((await f.query('coordination.schedule.list'))[0].action.taskIds, ['A','B'])
  assert.deepEqual(await f.query('task.list', { groupId: 'group' }), before)
})

for (const args of [{ limit: 100 }, { offset: -1 }, { taskIds: Array(9).fill('A') }, { taskIds: 'A' },
  { coordinationIds: Array(5).fill('C') }, { arrangementSourceUnitId: 'unit' }, { unknown: 1 }])
  test(`context contract rejects invalid inputs before any authorization: ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t)
    await assert.rejects(f.service.context(f.request(), args), { code: 'COORDINATION_CONTEXT_RANGE' })
    await assert.rejects(f.service.submit(f.request(), f.schedule()), { code: 'COORDINATION_CONTEXT_REQUIRED' })
    assert.deepEqual(await f.query('coordination.list'), [])
  })

for (const delay of [17_000, 900_001]) test(`processing delay ${delay}ms preserves original message time and delegates misfire to the schedule`, async t => {
  const start = Date.parse('2026-10-22T07:31:45.000Z'), due = '2026-10-22T07:34:45.000Z'
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const f = await fixture(t)
  await f.service.context(f.request())
  const before = await f.query('task.get', { taskId: 'A' })
  t.mock.timers.tick(180_000 + delay)
  await f.service.submit(f.request(), { ...f.schedule(), rule: { kind: 'once', at: due } })
  const schedule = (await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.nextDueAt, due)
  await f.command('coordination.schedule.scan')
  const occurrence = (await f.query('coordination.occurrence.list'))[0]
  assert.equal(occurrence.plannedAt, due)
  assert.equal(occurrence.actionState, delay > 900_000 ? 'expired' : 'waiting')
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), before)
})

test('a past time without a reliable source timestamp remains unaccepted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T07:35:00.000Z') })
  const f = await fixture(t)
  await f.service.context(f.request())
  delete f.entry.sourceSnapshot.occurredAt
  await assert.rejects(f.service.submit(f.request(), { ...f.schedule(), rule: { kind: 'once', at: '2026-10-22T07:34:45.000Z' } }), { code: 'DYNAMIC_COORDINATION_TIME_PAST' })
  assert.deepEqual(await f.query('coordination.schedule.list'), [])
})

test('recovery keeps planning failures during backoff and retires the alert only after durable semantic settlement', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T07:00:00Z') })
  let attempts = 0, f
  f = await fixture(t, { enabled: true, planner: { close: async () => {}, plan: async request => {
    if (++attempts === 1) throw Object.assign(new Error('no submission'), { code: 'COORDINATION_NO_SUBMISSION' })
    return f.service.submit(request, { kind: 'clarify', question: 'Which task?', candidates: ['A','B'] })
  } } })
  await f.service.recoverGroup('group'); await f.service.recoverGroup('group')
  assert.equal(attempts, 1); assert.deepEqual(f.recovered, [])
  assert.equal(f.errors[0].code, 'COORDINATION_NO_SUBMISSION')
  t.mock.timers.tick(5000); await f.service.recoverGroup('group')
  assert.equal(attempts, 2); assert.deepEqual(f.recovered, ['reservation'])
  assert.equal((await f.query('coordination.source', { unitId: 'unit', revision: 1 })).attemptCount, 1)
  assert.equal(f.entry.semanticState, 'needs_clarification')
  assert.equal((await f.query('notification.list')).length, 1)
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
  await assert.rejects(f.runJobs(), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN' })
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
  assert.equal(f.commands.filter(kind => kind === 'coordination.job.command').length, 1)
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
