import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { summarizeTimeSlots } from '../packages/dingtalk-dsh-assistant/coordination-time.js'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'

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

async function fixture(t, rule = { kind: 'once', at: '2026-10-21T01:00:00.000Z' }, action = { kind: 'read-query', taskIds: ['A'] }) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const directory = await mkdtemp(join(tmpdir(), 'coordination-schedule-'))
  const config = { dbPath: join(directory, 'task.sqlite'), instanceId: 'test', initialize: true }
  let store = await openDynamicTaskStore(config)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = randomUUID()) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  if (action.kind !== 'message-reminder') await command('task.create', { taskId: 'A', groupId: 'group', request: 'A' })
  const source = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'group', original: action.text ?? '查询A',
    reservationId: 'source-reservation', reservationGeneration: 1, sourceMessageId: 'source-message', actorId: 'source-actor', sourceRefs: ['authenticated-source'] })).result.source
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'query', members: [], readOnly: true })
  await command('coordination.schedule.create', { coordinationId: 'query', scheduleId: 'schedule', timezone: 'Asia/Shanghai', rule,
    action, target: { conversationId: 'group', recipientIds: ['first'] } })
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

test('a pure reminder freezes its original text without any Task and reuses one notification after restart', async t => {
  const action = { kind: 'message-reminder', text: '提醒你查看云端专家的开发进度。' }
  const f = await fixture(t, undefined, action)
  assert.deepEqual(await f.query('task.list'), [])
  await f.restart(); f.tick(3600000)
  const occurrence = (await f.scan()).result.occurrences[0]
  const replay = await f.command('coordination.occurrence.accept', { coordinationId: 'query', trigger: occurrence.trigger,
    action, target: occurrence.target })
  assert.equal(replay.result.replayed, true)
  await assert.rejects(f.command('coordination.occurrence.accept', { coordinationId: 'query', trigger: occurrence.trigger,
    action: { ...action, text: '未授权的其他提醒。' }, target: occurrence.target }), { code: 'DYNAMIC_COORDINATION_TRIGGER_CONFLICT' })
  const job = await f.claim(occurrence)
  await assert.rejects(f.command('coordination.job.read', { jobId: job.id, fence: job.fence }), { code: 'DYNAMIC_COORDINATION_ACTION_INVALID' })
  const result = (await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence }, 'remind-once')).result
  assert.deepEqual(result.occurrence.result, { ...action, plannedAt: occurrence.plannedAt })
  assert.equal(result.occurrence.deliveryState, 'pending', '正文准备完成不等于发送成功')
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  assert.equal(notification.payload.text, action.text)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, ['first'])
  assert.equal(notification.payload.sourceMessageId, 'source-message')
  assert.equal(notification.payload.actorId, 'source-actor')
  const commands = [], adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async args => {
    commands.push(args); return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'isolated-send' } }) }
  } } })
  await sendWorkflowNotification(adapter, notification)
  assert.deepEqual(commands[0].slice(0, 3), ['chat', 'message', 'reply'])
  assert.equal(commands[0][commands[0].indexOf('--ref-msg-id') + 1], 'source-message')
  assert.equal(commands[0][commands[0].indexOf('--ref-sender') + 1], 'source-actor')
  assert.equal(commands[0][commands[0].indexOf('--at-open-dingtalk-ids') + 1], 'first')
  assert.equal(commands[0][commands[0].indexOf('--content') + 1], action.text)
  await f.restart()
  const repeated = await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence }, 'remind-once')
  assert.deepEqual(repeated.result.occurrence.result, result.occurrence.result)
  assert.deepEqual((await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification, notification)
  assert.equal((await f.query('notification.list')).length, 1)
  const permit = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: permit.dispatchToken,
    state: 'delivered', receipt: { messageId: 'synthetic-reminder' } })
  await f.restart(); f.tick(86400000)
  assert.deepEqual((await f.scan()).result.occurrences, [])
  assert.equal((await f.query('coordination.schedule.list'))[0].state, 'completed')
  assert.deepEqual(await f.query('task.list'), [])
})

test('rescheduling a pending reminder supersedes the old slot and sends only the replacement text', async t => {
  const action = { kind: 'message-reminder', text: '查看云端专家的开发进度。' }
  const f = await fixture(t, undefined, action)
  f.tick(3600000)
  const original = (await f.scan()).result.occurrences[0]
  const replacementText = '查看云端专家的开发进度并记录待办。'
  const source = (await f.command('coordination.reserve', { unitId: 'correction-unit', revision: 1, groupId: 'group', original: '稍后提醒',
    reservationId: 'correction-reservation', reservationGeneration: 1, sourceMessageId: 'correction-message', actorId: 'source-actor', sourceRefs: ['correction-source'] })).result.source
  await f.command('coordination.change', { coordinationId: 'query', expectedRevision: 1, sourceId: source.id, fence: source.fence,
    change: { action: 'schedule', scheduleChange: { scheduleId: 'schedule', expectedRevision: 1, scope: 'unstarted',
      replacementPlannedAt: '2026-10-21T01:20:00.000Z', action: { ...action, text: replacementText } } } })
  const replacement = (await f.occurrences()).find(item => item.id !== original.id)
  await assert.rejects(f.claim(original), { code: 'DYNAMIC_COORDINATION_CANCELLED' })
  await assert.rejects(f.claim(replacement), { code: 'DYNAMIC_COORDINATION_NOT_DUE' })
  await f.restart(); f.tick(1200000)
  const job = await f.claim(replacement)
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: replacement.id })).result.notification
  assert.equal(notification.payload.text, replacementText)
  assert.equal(notification.payload.sourceMessageId, 'correction-message', '订正后的提醒引用最新接纳来源')
  assert.equal(notification.payload.actorId, 'source-actor')
  assert.equal((await f.query('notification.list')).length, 1)
  assert.deepEqual((await f.scan()).result.occurrences, [])
})

test('a periodic reminder waits for unknown delivery and cancellation stops its next claimed job', async t => {
  const f = await fixture(t, { kind: 'daily', time: '09:00' }, { kind: 'message-reminder', text: '查看进度。' })
  f.tick(3600000)
  const first = (await f.scan()).result.occurrences[0]
  const firstJob = await f.claim(first)
  await f.command('coordination.job.remind', { jobId: firstJob.id, fence: firstJob.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: first.id })).result.notification
  const permit = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: permit.dispatchToken, state: 'unknown' })
  await f.restart(); f.tick(86400000)
  const second = (await f.scan()).result.occurrences[0]
  await assert.rejects(f.claim(second), { code: 'DYNAMIC_COORDINATION_OVERLAP' })
  await f.command('notification.reconcile', { notificationId: notification.id, state: 'delivered',
    receipt: { messageId: 'synthetic-confirmed' }, evidenceRef: 'isolated-test-proof' })
  const secondJob = await f.claim(second)
  await f.change({ expectedRevision: 1, state: 'cancelled' })
  await assert.rejects(f.command('coordination.job.remind', { jobId: secondJob.id, fence: secondJob.fence }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  assert.deepEqual((await f.scan()).result.occurrences, [])
  assert.equal((await f.query('notification.list')).length, 1)
})

test('cancelling a reminder with an unknown send does not grant a new send or hide the uncertainty', async t => {
  const f = await fixture(t, undefined, { kind: 'message-reminder', text: '查看进度。' })
  f.tick(3600000)
  const occurrence = (await f.scan()).result.occurrences[0]
  const job = await f.claim(occurrence)
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const permit = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: permit.dispatchToken, state: 'unknown' })
  await f.change({ expectedRevision: 1, state: 'cancelled' })
  await f.restart()
  const after = (await f.query('notification.list'))[0]
  assert.equal(after.state, 'unknown'); assert.equal(after.dispatchToken, permit.dispatchToken)
  assert.equal((await f.occurrences())[0].deliveryState, 'unknown')
  assert.equal((await f.command('notification.start', { notificationId: notification.id })).dispatchEligible, false)
})

test('an expired reminder is reported without creating an overdue reminder notification', async t => {
  const f = await fixture(t, undefined, { kind: 'message-reminder', text: '查看云端专家的开发进度。' })
  f.tick(4500001)
  const occurrence = (await f.scan()).result.occurrences[0]
  assert.equal(occurrence.actionState, 'expired'); assert.deepEqual(await f.jobs(), [])
  const summary = (await f.command('coordination.aggregate', { coordinationId: 'query' })).result.notification
  assert.match(summary.payload.text, /已过期，本次未执行/)
  assert.match(summary.payload.text, /提醒内容：查看云端专家的开发进度。/)
  await assert.rejects(f.command('coordination.notification.freeze', { occurrenceId: occurrence.id }), { code: 'DYNAMIC_COORDINATION_JOB_STALE' })
  await f.restart(); f.tick(86400000)
  assert.deepEqual((await f.scan()).result.occurrences, [])
})

test('a reminder rejects attached task effects and cannot become a conditional task command', async t => {
  const f = await fixture(t)
  for (const action of [{ kind: 'message-reminder', text: '查看进度。', taskIds: ['A'] },
    { kind: 'message-reminder', text: '查看进度。', onIncomplete: { kind: 'task-command', instructionIds: [] } }])
    await assert.rejects(f.change({ expectedRevision: 1, action }), { code: 'DYNAMIC_COORDINATION_ACTION_INVALID' })
  await assert.rejects(f.change({ expectedRevision: 1, action: { kind: 'message-reminder', text: '  ' } }), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  await assert.rejects(f.change({ expectedRevision: 1, action: { kind: 'read-query', taskIds: ['A'],
    onIncomplete: { kind: 'message-reminder', text: '查看进度。' } } }), { code: 'DYNAMIC_COORDINATION_CONDITIONAL_SCOPE_INVALID' })
  const schedule = (await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.revision, 1)
  assert.deepEqual(schedule.action, { kind: 'read-query', taskIds: ['A'] })
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

for (const delayMs of [0,17000,900000,900001]) test(`late one-time acceptance preserves original slot and existing grace boundary: delayMs=${delayMs}`,async t=>{
  const plannedAt='2026-10-21T00:00:00.000Z'
  const f=await fixture(t,{kind:'once',at:plannedAt})
  // Model processing may finish at the due instant; scanning can also be delayed.
  f.tick(delayMs)
  await f.restart()
  const occurrence=(await f.scan()).result.occurrences[0]
  assert.equal(occurrence.plannedAt,plannedAt)
  assert.equal(occurrence.actionState,delayMs>900000?'expired':'waiting')
  const schedule=(await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.rule.at,plannedAt);assert.equal(schedule.nextDueAt,null)
  if(delayMs>900000) {
    assert.equal(schedule.outcome,'expired');assert.deepEqual(await f.jobs(),[])
    const summary=(await f.command('coordination.aggregate',{coordinationId:'query'})).result
    assert.match(summary.notification.payload.text,/已过期，本次未执行/)
  } else {
    const job=await f.claim(occurrence)
    await f.command('coordination.job.read',{jobId:job.id,fence:job.fence})
    const notification=(await f.command('coordination.notification.freeze',{occurrenceId:occurrence.id})).result.notification
    const permit=(await f.command('notification.start',{notificationId:notification.id})).result.notification
    await f.command('notification.receipt',{notificationId:notification.id,dispatchToken:permit.dispatchToken,state:'delivered',receipt:{messageId:'synthetic-delivery'}})
    await f.restart()
    const replay=(await f.command('coordination.notification.freeze',{occurrenceId:occurrence.id})).result.notification
    assert.equal(replay.id,notification.id);assert.equal(replay.state,'delivered')
  }
  await f.restart();f.tick(86400000)
  assert.equal((await f.scan()).result.occurrences.length,0)
  assert.equal((await f.occurrences()).length,1)
})

for (const [plannedAt,expectedState] of [['2026-10-20T23:59:43.000Z','waiting'],['2026-10-20T23:44:59.000Z','expired']]) test(`one-time creation already late preserves due instant and scan outcome: ${expectedState}`,async t=>{
  const f=await fixture(t,{kind:'once',at:plannedAt})
  const schedule=(await f.query('coordination.schedule.list'))[0]
  assert.equal(schedule.nextDueAt,plannedAt)
  await f.restart()
  const occurrence=(await f.scan()).result.occurrences[0]
  assert.equal(occurrence.actionState,expectedState);assert.equal(occurrence.plannedAt,schedule.rule.at)
  if(expectedState==='waiting') {
    const job=await f.claim(occurrence)
    assert.equal((await f.command('coordination.job.read',{jobId:job.id,fence:job.fence})).result.job.state,'completed')
  } else assert.deepEqual(await f.jobs(),[])
  await f.restart();assert.equal((await f.scan()).result.occurrences.length,0)
})
