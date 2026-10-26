import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { createCoordinationObserver } from '../packages/dingtalk-dsh-assistant/coordination-observer.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-observer-'))
  const dbPath = join(directory, 'task.sqlite')
  const store = await openDynamicTaskStore({ dbPath, instanceId: 'observer-test', initialize: true })
  const observer = createCoordinationObserver((kind, args = {}) => store.query({ kind, ...args }))
  const server = createServer((request, response) => handleRequest(request, response, observer))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args = {}) => store.command({ id: randomUUID(), kind, args })
  const reserve = async (unitId, groupId = 'group') => (await command('coordination.reserve', { unitId, revision: 1, groupId, original: `Synthetic input ${unitId}` })).result.source
  const member = (id, dependencies = []) => ({ instructionId: id, taskId: id, progressImpact: 'preserve', dependencies,
    command: { id: `coordination-command:batch:${id}`, kind: 'task.supplement', args: { taskId: id, expectedRequirementRevision: 1,
      expectedControlRevision: 1, messageId: `input:${id}`, text: `Requirement ${id}`, request: `${id} requirement` } } })
  const read = async path => { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return { status: response.status, body: await response.json() } }
  const durableState = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({ name,
      rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() })) } finally { db.close() }
  }
  return { store, observer, command, reserve, member, read, durableState }
}

test('source-driven real SQLite HTTP view includes unattached, rejected and dependent accepted inputs without writes', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const accepted = await f.reserve('accepted'), reserved = await f.reserve('reserved'), rejected = await f.reserve('rejected')
  await f.reserve('foreign', 'other')
  await f.command('coordination.source.reject', { sourceId: rejected.id, fence: 1, reason: 'Not a supported arrangement' })
  await f.command('coordination.accept', { sourceId: accepted.id, fence: 1, coordinationId: 'batch', members: [{ ...f.member('A'), impactReason: 'Preserve the authorized objective' }, f.member('B', ['A'])],
    proposal: { answerText: 'Recorded business answer', secret: 'must-not-leak', actorId: 'private-actor', prompt: 'private-prompt' } })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const before = f.durableState()
  const listing = await f.read('/state/coordination-sources?groupId=group&offset=0&limit=2')
  assert.equal(listing.status, 200); assert.equal(listing.body.total, 3); assert.equal(listing.body.sources.length, 2)
  assert.ok(listing.body.observedAt)
  const detail = await f.read(`/state/coordination-sources/${accepted.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.members[0].state, 'applied')
  assert.equal(detail.body.members[0].progressImpact, 'preserve')
  assert.equal(detail.body.members[0].impactReason, 'Preserve the authorized objective')
  assert.equal(detail.body.members[0].observation, false)
  assert.equal(detail.body.source.answerText, 'Recorded business answer')
  assert.equal(detail.body.members[0].completionProof, null)
  assert.notEqual(detail.body.snapshot.state, 'completed', 'accepted command is not formal completion')
  assert.deepEqual(detail.body.members[1].dependencies, ['A'])
  assert.equal(detail.body.members[1].waitingReason.code, 'waiting_dependency')
  assert.equal(detail.body.members[1].requirement, 'Requirement B')
  assert.equal(detail.body.collections.members.truncated, false)
  assert.equal((await f.read(`/state/coordination-sources/${reserved.id}`)).body.coordination, null)
  assert.equal((await f.read(`/state/coordination-sources/${rejected.id}`)).body.source.rejectionReason, 'Not a supported arrangement')
  const serialized = JSON.stringify(detail.body)
  for (const secret of ['must-not-leak', 'private-actor', 'private-prompt', 'acceptedProposal', 'sourceRefs', 'workspaceDir', 'command"', 'receipt"']) assert.ok(!serialized.includes(secret), secret)
  assert.deepEqual(f.durableState(), before, 'GET must not append receipts, mutate members or change any durable table')
  const owner = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.wait', { binding: owner, action: 'blocked', summary: 'Waiting for authorized access', evidence: ['recorded-proof'], limitations: ['Not verified externally'] })
  const blocked = await f.observer.coordinationSourceDetail(accepted.id)
  assert.equal(blocked.members[0].blocker, 'Waiting for authorized access')
  assert.deepEqual(blocked.members[0].decision.evidence, ['recorded-proof'])
  assert.deepEqual(blocked.members[0].decision.limitations, ['Not verified externally'])
  assert.ok(blocked.members[0].decision.at)
  await f.command('task.complete', { binding: owner, summary: 'Completed A', result: { evidence: ['proof:A'] } })
  await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })
  const refreshed = await f.observer.coordinationSourceDetail(accepted.id)
  assert.equal(refreshed.members[0].state, 'fulfilled')
  assert.ok(refreshed.members[0].completionProof.commandId)
  assert.equal(refreshed.members[1].state, 'applied')
})

test('real clarification and scheduled delivery keep action success separate from task completion', async t => {
  const f = await fixture(t), clarification = await f.reserve('clarification')
  await f.command('coordination.source.clarify', { sourceId: clarification.id, fence: 1, coordinationId: 'question', question: 'Which target?' })
  const clarified = await f.observer.coordinationSourceDetail(clarification.id)
  assert.equal(clarified.source.question, 'Which target?'); assert.equal(clarified.snapshot.state, 'needs_attention')
  const source = await f.reserve('reminder')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'reminder', members: [], readOnly: true })
  await f.command('coordination.schedule.create', { coordinationId: 'reminder', scheduleId: 'schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString() }, action: { kind: 'message-reminder', text: 'Synthetic reminder' },
    target: { conversationId: 'group', recipientIds: ['private-recipient'] } })
  const occurrence = (await f.command('coordination.schedule.scan')).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const detail = await f.observer.coordinationSourceDetail(source.id)
  assert.equal(detail.snapshot.schedules[0].reminderText, 'Synthetic reminder')
  assert.equal(detail.snapshot.occurrences[0].actionKind, 'message-reminder')
  assert.equal(detail.snapshot.occurrences[0].actionState, 'succeeded')
  assert.equal(detail.snapshot.occurrences[0].deliveryState, 'pending')
  assert.equal(detail.snapshot.occurrences[0].resultRef, `${occurrence.id}:result:1`)
  assert.notEqual(detail.snapshot.state, 'completed')
  assert.equal(detail.snapshot.jobs[0].state, 'completed')
  assert.ok(!JSON.stringify(detail).includes('private-recipient'))
  assert.ok(!JSON.stringify(detail).includes('recipientIds'))
})

test('detail truncation is explicit and aggregate computation includes records outside presentation bounds', async t => {
  const f = await fixture(t), source = await f.reserve('bounded')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'bounded', members: [], readOnly: true })
  const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 60000).toISOString()
  for (let index = 0; index < 101; index++) await f.command('coordination.schedule.create', { coordinationId: 'bounded', scheduleId: `schedule-${index}`,
    timezone: 'Asia/Shanghai', rule: { kind: 'once', at }, action: { kind: 'message-reminder', text: 'Synthetic reminder' },
    target: { conversationId: 'group', recipientIds: [] } })
  const detail = await f.observer.coordinationSourceDetail(source.id)
  assert.equal(detail.snapshot.schedules.length, 100)
  assert.deepEqual(detail.collections.schedules, { total: 101, returned: 100, truncated: true })
  assert.equal(detail.snapshot.state, 'active')
})

test('reorder assessment is projected as a recorded decision and freeform failures use a neutral flag', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const accepted = await f.reserve('reorder-original'), failed = await f.reserve('failed')
  await f.command('coordination.source.failed', { sourceId: failed.id, fence: 1, code: 'freeform diagnostic from internal path' })
  await f.command('coordination.accept', { sourceId: accepted.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B')] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const reorder = await f.reserve('reorder')
  await f.command('coordination.change', { sourceId: reorder.id, fence: 1, coordinationId: 'batch', expectedRevision: 1,
    change: { action: 'reorder', reason: 'Synthetic reorder request', dependencies: [{ instructionId: 'A', afterInstructionIds: ['B'] }] } })
  const pending = (await f.store.query({ kind: 'coordination.get', coordinationId: 'batch' })).members[0].reorderAssessment
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('coordination.reorder.assess', { binding, instructionId: 'A', assessmentId: pending.id,
    decision: 'needs_clarification', summary: 'Recorded reorder question', evidence: ['Recorded evidence'] })
  const detail = await f.observer.coordinationSourceDetail(reorder.id)
  assert.equal((await f.observer.coordinationSourceDetail(failed.id)).source.failureCode, 'coordination_processing_failed')
  assert.deepEqual(detail.members[0].reorderAssessment, { id: pending.id, state: 'needs_clarification', decision: 'needs_clarification', summary: 'Recorded reorder question', evidence: ['Recorded evidence'] })
  assert.ok(!JSON.stringify(detail).includes('ownerBinding'))
})

test('observation and replan expose only their recorded safe scalar impact fields', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const source = await f.reserve('impact')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [
    { instructionId: 'A', taskId: 'A', observation: true, dependencies: [], command: { id: 'coordination-command:batch:A', kind: 'coordination.observe',
      args: { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, expectedContextRevision: 0, expectedRunSequence: 1 } } },
    { ...f.member('B'), progressImpact: 'replan', impactReason: 'Recorded requirement change',
      command: { ...f.member('B').command, kind: 'task.revise' } },
  ] })
  const detail = await f.observer.coordinationSourceDetail(source.id)
  assert.equal(detail.source.answerText, null)
  assert.equal(detail.members[0].observation, true)
  assert.equal(detail.members[0].progressImpact, null)
  assert.equal(detail.members[1].progressImpact, 'replan')
  assert.equal(detail.members[1].impactReason, 'Recorded requirement change')
})

test('identifier-like raw diagnostics are never echoed as source, occurrence or job failure codes', async () => {
  const observer = createCoordinationObserver(async kind => {
    if (kind === 'coordination.source.list') return [{ id: 'source', groupId: 'group', original: 'Synthetic input',
      createdAt: '2026-10-25T00:00:00Z', state: 'accepted', settled: true, coordinationId: 'batch', lastError: 'PrivateDiagnostic123' }]
    if (kind === 'coordination.get') return { coordination: { id: 'batch', revision: 1, state: 'active' }, members: [] }
    if (kind === 'coordination.occurrence.list') return [
      { id: 'raw', actionState: 'failed', deliveryState: 'none', failureReason: 'PrivateOccurrenceDiagnostic123' },
      { id: 'structured', actionState: 'failed', deliveryState: 'none', failureReason: { code: 'DYNAMIC_COORDINATION_TIME_INVALID' } },
    ]
    if (kind === 'coordination.job.list') return [
      { id: 'raw-job', occurrenceId: 'raw', state: 'failed', failureReason: 'PrivateJobDiagnostic123' },
      { id: 'structured-job', occurrenceId: 'structured', state: 'failed', failureReason: { code: 'DYNAMIC_COORDINATION_TIME_INVALID' } },
    ]
    return []
  })
  const detail = await observer.coordinationSourceDetail('source')
  assert.equal(detail.source.failureCode, 'coordination_processing_failed')
  assert.equal(detail.snapshot.occurrences[0].failureCode, 'coordination_trigger_failed')
  assert.equal(detail.snapshot.jobs[0].failureCode, 'coordination_trigger_failed')
  assert.equal(detail.snapshot.occurrences[1].failureCode, 'DYNAMIC_COORDINATION_TIME_INVALID')
  assert.equal(detail.snapshot.jobs[1].failureCode, 'DYNAMIC_COORDINATION_TIME_INVALID')
  assert.ok(!JSON.stringify(detail).includes('Private'))
})

test('HTTP validates paging, filters and paths, returns missing/unsupported and never exposes raw read failures', async t => {
  const f = await fixture(t)
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=1.5', 'groupId=', 'unknown=1', 'limit=1&limit=2'])
    assert.equal((await f.read(`/state/coordination-sources?${query}`)).status, 400, query)
  assert.equal((await f.read('/state/coordination-sources/missing')).status, 404)
  assert.equal((await f.read('/state/coordination-sources/%ZZ')).status, 400)
  assert.equal((await f.read('/state/coordination-sources/missing?limit=1')).status, 400)
  await assert.rejects(f.observer.coordinationSources({ limit: 0 }), /coordination_query_invalid/u)
  const server = createServer((request, response) => handleRequest(request, response, {}))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const suffix of ['', '/missing']) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/state/coordination-sources${suffix}`)).status, 503)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

function workFixture({ members = [], tasks = [], schedules = [], occurrences = [], jobs = [], notifications = [], sources = [], executions = [], coordination = {}, receipts } = {}) {
  const batch = { id: 'batch', revision: 1, state: 'active', groupId: 'group', createdAt: '2026-10-25T00:00:00Z', ...coordination }
  return createCoordinationObserver(async (kind, args = {}) => {
    if (kind === 'coordination.list') return !args.groupId || args.groupId === batch.groupId ? [batch] : []
    if (kind === 'coordination.get') return { coordination: batch, members }
    if (kind === 'task.get') return tasks.find(task => task.taskId === args.taskId)
    if (kind === 'receipt.get') return receipts ? receipts.get(args.id) ?? null : members.find(member => member.command?.id === args.id)?.receipt ?? null
    return { 'coordination.schedule.list': schedules, 'coordination.occurrence.list': occurrences, 'coordination.job.list': jobs,
      'notification.list': notifications, 'coordination.source.list': sources, 'execution.list': executions }[kind] ?? []
  })
}
const workSchedule = (overrides = {}) => ({ id: 'schedule', coordinationId: 'batch', revision: 2, state: 'active', timezone: 'Asia/Shanghai',
  rule: { kind: 'once', at: '2026-10-25T00:00:00Z' }, action: { kind: 'message-reminder', text: 'Synthetic reminder' }, nextDueAt: null, ...overrides })
const workOccurrence = (overrides = {}) => ({ id: 'occurrence', coordinationId: 'batch', scheduleId: 'schedule',
  acceptedAt: '2026-10-25T00:00:01Z', plannedAt: '2026-10-25T00:00:00Z', action: { kind: 'message-reminder', text: 'Synthetic reminder' },
  actionState: 'succeeded', deliveryState: 'failed', ...overrides })
const workMember = (id, overrides = {}) => ({ effectiveVersion: { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }, id, taskId: id, coordinationId: 'batch', state: 'ready', control: 'active',
  dependencies: [], command: { id: `command:${id}`, args: { text: `Requirement ${id}` } }, ...overrides })

test('work HTTP uses durable schedule identity across changes and preserves exact failed delivery without SQLite writes', async t => {
  const f = await fixture(t), source = await f.reserve('reminder-work')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [], readOnly: true })
  const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString()
  await f.command('coordination.schedule.create', { coordinationId: 'batch', scheduleId: 'schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at }, action: { kind: 'message-reminder', text: 'Synthetic reminder' }, target: { conversationId: 'group', recipientIds: ['private-recipient'] } })
  const change = await f.reserve('reminder-change')
  await f.command('coordination.change', { sourceId: change.id, fence: 1, coordinationId: 'batch', expectedRevision: 1,
    change: { action: 'schedule', reason: 'Recorded adjustment', scheduleChange: { scheduleId: 'schedule', expectedRevision: 1, state: 'active' } } })
  const occurrence = (await f.command('coordination.schedule.scan')).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const started = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: started.dispatchToken, state: 'failed' })
  const before = f.durableState()
  const list = await f.read('/state/coordination-work?groupId=group&limit=1')
  assert.equal(list.status, 200); assert.equal(list.body.total, 1)
  const work = list.body.works[0]
  assert.equal(work.id, 'schedule:schedule'); assert.equal(work.result.label, '提醒发送失败')
  assert.equal(work.plan.state, 'active'); assert.equal(work.nextStep.triggerAt, null)
  assert.equal(work.nextStep.sendRetryAt, null); assert.match(work.nextStep.label, /无后续触发安排；无重试安排/)
  const detail = await f.read('/state/coordination-work/schedule%3Aschedule')
  assert.equal(detail.status, 200); assert.equal(detail.body.history.sources.length, 2)
  assert.equal(detail.body.history.jobs[0].occurrenceId, occurrence.id)
  assert.equal(detail.body.history.jobs[0].state, 'completed')
  assert.deepEqual(f.durableState(), before)
  assert.doesNotMatch(JSON.stringify(detail.body), /private-recipient|payload|sendPermit|dispatchToken|deliveryError/)
})

for (const [actionState, deliveryState, expected] of [
  ['succeeded', 'failed', 'delivery_failed'], ['succeeded', 'unknown', 'delivery_unknown'], ['succeeded', 'pending', 'delivery_pending'],
  ['succeeded', 'delivered', 'delivered'], ['failed', 'none', 'action_failed'], ['blocked', 'none', 'blocked'],
  ['expired', 'none', 'expired'], ['unknown', 'none', 'unknown'], ['alien-state', 'none', 'unknown'],
]) test(`work outcome preserves actual ${actionState}/${deliveryState} across active paused cancelled plan controls`, async () => {
  for (const state of ['active', 'paused', 'cancelled']) {
    const observer = workFixture({ schedules: [workSchedule({ state, rule: { kind: 'daily', time: '09:00' }, nextDueAt: '2026-10-26T01:00:00Z' })],
      occurrences: [workOccurrence({ actionState, deliveryState })], jobs: [{ id: 'job', occurrenceId: 'occurrence', state: 'completed' }] })
    const { works } = await observer.coordinationWork()
    assert.equal(works[0].result.code, expected)
    assert.equal(works[0].plan.state, state)
    assert.equal(Boolean(works[0].nextStep.triggerAt), state === 'active')
  }
})

test('work grouping separates mixed direct batches and non-time triggers while retaining schedule templates and instances', async () => {
  const members = [workMember('template', { state: 'template', recurringTemplateScheduleId: 'schedule' }),
    workMember('instantiated', { recurringOccurrenceId: 'occurrence', templateInstructionId: 'template' }), workMember('direct-A'), workMember('direct-B'), workMember('triggered')]
  const observer = workFixture({ members, schedules: [workSchedule({ action: { kind: 'task-command', instructionIds: ['template'] } })],
    occurrences: [workOccurrence({ action: { kind: 'task-command', instructionIds: ['instantiated'] }, actionState: 'waiting', deliveryState: 'none' }),
      workOccurrence({ id: 'event', scheduleId: null, triggerKind: 'business-event', action: { kind: 'task-command', instructionIds: ['triggered'] } })],
    sources: [{ id: 'source', coordinationId: 'batch', state: 'accepted', acceptedKind: 'change' }, { id: 'unattached', state: 'rejected' }] })
  const { works, total } = await observer.coordinationWork()
  assert.equal(total, 3)
  assert.deepEqual(works.map(work => work.kind).sort(), ['dispatch', 'schedule', 'trigger'])
  const direct = await observer.coordinationWorkDetail('dispatch:batch')
  assert.deepEqual(direct.members.map(member => member.instructionId), ['direct-A', 'direct-B'])
  const schedule = await observer.coordinationWorkDetail('schedule:schedule')
  assert.deepEqual(schedule.members.map(member => member.instructionId), ['template', 'instantiated'])
  assert.equal(schedule.history.sources.length, 1)
  assert.equal((await observer.coordinationWork({ groupId: 'other' })).total, 0)
})

test('work dispatch requires a command receipt while formal target proof never establishes dispatch', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const proof = { ...version, commandId: 'complete:A' }
  const task = { ...version, taskId: 'A', status: 'completed', completion: { commandId: 'complete:A', instructionIds: ['A'] } }
  for (const [member, target, expected] of [
    [workMember('A'), { ...task, status: 'active' }, 'pending'],
    [workMember('A', { state: 'applied', receipt: { result: { task: { taskId: 'A', requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 } } } }), { ...task, status: 'active' }, 'dispatched'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version }), task, 'unknown'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof }), task, 'unknown'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof, waitingReason: { code: 'target_version_changed' } }), { ...task, runSequence: 2 }, 'stale'],
  ]) {
    const { works } = await workFixture({ members: [member], tasks: [target] }).coordinationWork()
    assert.equal(works[0].result.code, expected)
  }
  const mixed = await workFixture({ members: [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof }), workMember('B')], tasks: [task, { taskId: 'B', status: 'active' }] }).coordinationWork()
  assert.equal(mixed.works[0].result.code, 'unknown'); assert.equal(mixed.works[0].counts.fulfilled, 0)
})

test('work notification retry and delivery readback are distinct persisted next steps, never source planning retry', async () => {
  const timestamp = '2026-10-26T00:00:00Z'
  const notification = { id: 'notice', state: 'unknown', nextAttemptAt: timestamp, payload: { conversationId: 'group', sourceMessageId: 'message', actorId: 'actor' } }
  const base = { schedules: [workSchedule()], occurrences: [workOccurrence({ deliveryState: 'unknown', notificationId: 'notice' })],
    sources: [{ id: 'source', coordinationId: 'batch', nextRetryAt: timestamp, attemptCount: 1 }] }
  let { works } = await workFixture({ ...base, notifications: [notification] }).coordinationWork()
  assert.equal(works[0].nextStep.readbackAt, timestamp); assert.equal(works[0].nextStep.sendRetryAt, null)
  const error = { phase: 'send', exitCode: 1, stdout: '', knownNotSent: true, retryable: true,
    stderr: JSON.stringify({ error: { category: 'api', code: 1, origin: 'mcp_gateway', operation: 'chat/get_conversation_info',
      reason: 'topic_quote_guard_unavailable', retryable: true, message: '无法确认引用回复目标是否属于话题圈，已阻止发送' } }) }
  ;({ works } = await workFixture({ ...base, notifications: [{ ...notification, state: 'failed', deliveryError: error }] }).coordinationWork())
  assert.equal(works[0].nextStep.sendRetryAt, timestamp); assert.equal(works[0].nextStep.readbackAt, null)
  ;({ works } = await workFixture({ ...base, notifications: [{ ...notification, state: 'failed', deliveryError: { ...error, stderr: 'untrusted diagnostic' } }] }).coordinationWork())
  assert.equal(works[0].nextStep.sendRetryAt, null); assert.equal(works[0].nextStep.readbackAt, null)
})

test('work full-collection result precedes bounded history and superseded replacements never duplicate schedule rows', async () => {
  const occurrences = Array.from({ length: 101 }, (_, index) => workOccurrence({ id: `occurrence-${index}`, actionState: 'superseded',
    replacedBy: `occurrence-${index + 1}`, plannedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }))
  occurrences[0] = workOccurrence({ id: 'effective', plannedAt: '2025-12-31T00:00:00Z', failureReason: 'PrivateInternalPath' })
  const observer = workFixture({ schedules: [workSchedule()], occurrences })
  const detail = await observer.coordinationWorkDetail('schedule:schedule')
  assert.equal(detail.work.result.code, 'delivery_failed')
  assert.equal(detail.work.occurrenceId, 'effective')
  assert.deepEqual(detail.collections.occurrences, { total: 101, returned: 100, truncated: true })
  assert.equal(detail.history.occurrences.length, 100)
  assert.equal((await observer.coordinationWork()).total, 1)
  assert.doesNotMatch(JSON.stringify(detail), /PrivateInternalPath/)
})

test('work HTTP validates paging IDs and unavailable readers without disclosing diagnostics', async t => {
  const f = await fixture(t)
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=1.5', 'offset=9007199254740992', 'groupId=', 'unexpected=1', 'offset=0&offset=1'])
    assert.equal((await f.read(`/state/coordination-work?${query}`)).status, 400, query)
  for (const id of ['%ZZ', 'arbitrary', 'schedule%3A'])
    assert.equal((await f.read(`/state/coordination-work/${id}`)).status, 400, id)
  for (const id of ['schedule%3A%2Fprivate', 'schedule%3A%00', 'schedule%3Awith%20space', 'schedule%3Amissing'])
    assert.equal((await f.read('/state/coordination-work/' + id)).status, 404)
  assert.equal((await f.read('/state/coordination-work/schedule%3Amissing?limit=1')).status, 400)
  await assert.rejects(f.observer.coordinationWork({ limit: 0 }), /coordination_query_invalid/)
  const server = createServer((request, response) => handleRequest(request, response, { coordinationWork: async () => { throw new Error('PrivateDatabasePath') } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const suffix of ['', '/schedule%3Amissing']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/state/coordination-work${suffix}`)
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'coordination_observer_unavailable' })
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('work cancellation of a later queued slot cannot hide a prior failed effect and notification recovery truth wins', async () => {
  const observer = workFixture({ schedules: [workSchedule({ state: 'cancelled', rule: { kind: 'daily', time: '09:00' } })], occurrences: [
    workOccurrence({ id: 'prior-failed' }), workOccurrence({ id: 'later-cancelled', plannedAt: '2026-10-26T00:00:00Z', actionState: 'cancelled', deliveryState: 'none', cancelledAt: '2026-10-25T12:00:00Z' }),
  ] })
  const { works } = await observer.coordinationWork()
  assert.equal(works[0].occurrenceId, 'prior-failed'); assert.equal(works[0].result.code, 'delivery_failed')
  const recovered = await workFixture({ schedules: [workSchedule()], occurrences: [workOccurrence({ deliveryState: 'pending', notificationId: 'notification' })],
    notifications: [{ id: 'notification', state: 'unknown' }] }).coordinationWork()
  assert.equal(recovered.works[0].result.code, 'delivery_unknown')
})

test('work dispatch result ignores target execution state and scope when the command receipt exists', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const member = workMember('A', { state: 'applied', effectiveVersion: version, receipt: { result: { task: { taskId: 'A', requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 } } } })
  const execution = { taskId: 'A', status: 'running', drained: false, instructionScope: { ...version, instructionIds: ['A'] } }
  for (const [input, expected] of [[execution, 'dispatched'], [{ ...execution, recovering: true }, 'dispatched'],
    [{ ...execution, instructionScope: { ...version, instructionIds: ['other'] } }, 'dispatched'],
    [{ ...execution, instructionScope: { ...version, runSequence: 2, instructionIds: ['A'] } }, 'dispatched']]) {
    const { works } = await workFixture({ members: [member], tasks: [{ ...version, taskId: 'A', status: 'active' }], executions: [input] }).coordinationWork()
    assert.equal(works[0].result.code, expected)
  }
})

test('work schedule without occurrences only promises actual nextDue and paused cursor is not an active promise', async () => {
  for (const [state, nextDueAt, expected] of [['active', null, 'no_occurrence'], ['active', '2026-10-26T00:00:00Z', 'scheduled'],
    ['paused', '2026-10-26T00:00:00Z', 'paused'], ['cancelled', null, 'cancelled']]) {
    const { works } = await workFixture({ schedules: [workSchedule({ state, nextDueAt })] }).coordinationWork()
    assert.equal(works[0].result.code, expected)
    assert.equal(Boolean(works[0].nextStep.triggerAt), expected === 'scheduled')
  }
})

test('real SQLite direct dispatch completion is version-proven and survives a read without writes', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'A', groupId: 'group', request: 'A' })
  const source = await f.reserve('direct-proof')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A')] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  assert.equal((await f.observer.coordinationWork()).works[0].result.code, 'dispatched')
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding, summary: 'Completed A', result: { evidence: ['proof:A'] } })
  const before = f.durableState()
  const detail = await f.observer.coordinationWorkDetail('dispatch:batch')
  assert.equal(detail.work.result.code, 'dispatched')
  assert.equal(detail.work.counts.fulfilled, 1); assert.ok(detail.members[0].completionProof.commandId)
  assert.deepEqual(f.durableState(), before)
})

test('real SQLite cancellation preserves known failed notification as primary result without changing the state machine', async t => {
  const f = await fixture(t)
  const source = await f.reserve('cancel-failed-reminder')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'cancel-failed', members: [], readOnly: true })
  const occurrence = (await f.command('coordination.schedule.create', { coordinationId: 'cancel-failed', scheduleId: 'cancel-failed-schedule', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString() }, action: { kind: 'message-reminder', text: 'Synthetic cancellation failure' },
    target: { conversationId: 'group', recipientIds: ['recipient'] } }).then(() => f.command('coordination.schedule.scan'))).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  const started = (await f.command('notification.start', { notificationId: notification.id })).result.notification
  await f.command('notification.receipt', { notificationId: notification.id, dispatchToken: started.dispatchToken, state: 'failed', error: { phase: 'send', knownNotSent: true, retryable: false } })
  const beforeCancel = await f.observer.coordinationWorkDetail('schedule:cancel-failed-schedule')
  assert.equal(beforeCancel.work.result.code, 'delivery_failed')
  await f.command('coordination.schedule.change', { scheduleId: 'cancel-failed-schedule', expectedRevision: 1, state: 'cancelled' })
  const afterCancel = await f.observer.coordinationWorkDetail('schedule:cancel-failed-schedule')
  assert.equal(afterCancel.work.plan.state, 'cancelled')
  assert.equal(afterCancel.work.result.code, 'delivery_failed')
  assert.equal(afterCancel.history.occurrences[0].deliveryState, 'cancelled')
})

test('accepted coordination with no members and no schedule does not invent a work row', async t => {
  const f = await fixture(t), source = await f.reserve('empty-work')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'empty-work', members: [], readOnly: true })
  const list = await f.observer.coordinationWork()
  assert.equal(list.total, 0)
  assert.deepEqual(list.works, [])
})

test('work members do not expose stale completion proof as current and schedule history includes safe revisions', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const observer = workFixture({ members: [workMember('A', { state: 'fulfilled', effectiveVersion: version,
    completionProof: { ...version, commandId: 'old-proof' } })], tasks: [{ taskId: 'A', status: 'completed', ...version,
    completion: { commandId: 'new-proof', instructionIds: ['A'] } }], schedules: [workSchedule({ action: { kind: 'task-command', instructionIds: ['A'] }, history: [{ revision: 1, state: 'active', changedAt: '2026-10-24T00:00:00Z',
    reason: 'rescheduled', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: '2026-10-24T01:00:00Z' }, nextDueAt: '2026-10-24T01:00:00Z' }] })] })
  const detail = await observer.coordinationWorkDetail('schedule:schedule')
  assert.equal(detail.members[0].state, 'version_changed')
  assert.equal(detail.members[0].completionProof, null)
  assert.equal(detail.members[0].completionProofCurrent, false)
  assert.equal(detail.members[0].historicalCompletionProof.commandId, 'old-proof')
  const revision = detail.history.changes.find(item => item.action === 'schedule-revision')
  assert.equal(revision.scheduleId, 'schedule'); assert.equal(revision.rule.at, '2026-10-24T01:00:00Z')
  assert.equal(revision.nextDueAt, '2026-10-24T01:00:00Z')
})

for (const control of ['coordination-cancel', 'cancel', 'pause']) test(`real fulfilled member remains formally complete after ${control}`, async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'A', groupId: 'group', request: 'A' })
  const source = await f.reserve('cancel-after-complete')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A')] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding, summary: 'Completed A', result: { evidence: ['proof:A'] } })
  if (control === 'coordination-cancel') await f.command('coordination.cancel', { coordinationId: 'batch', expectedRevision: 1 })
  else {
    const change = await f.reserve('control-member')
    await f.command('coordination.change', { sourceId: change.id, fence: 1, coordinationId: 'batch', expectedRevision: 1,
      change: { action: control, instructionIds: ['A'] } })
  }
  const detail = await f.observer.coordinationWorkDetail('dispatch:batch')
  assert.equal(detail.work.result.code, 'dispatched')
  assert.equal(detail.work.counts.fulfilled, 1)
  assert.equal(detail.members[0].completionProofCurrent, true)
  const task = await f.store.query({ kind: 'task.get', taskId: 'A' })
  assert.equal(task.status, 'completed')
  assert.equal(detail.members[0].completionProof.commandId, task.completion.commandId)

})

test('unknown raw schedule state is not reported as a no-trigger record without an actual effect', async () => {
  const observer = workFixture({ schedules: [workSchedule({ state: 'future-state', nextDueAt: null })] })
  const { works } = await observer.coordinationWork()
  assert.equal(works[0].result.code, 'unknown')
  assert.equal(works[0].result.label, '状态未确认')
  const concrete = workFixture({ schedules: [workSchedule({ state: 'future-state', nextDueAt: null })],
    occurrences: [workOccurrence({ actionState: 'succeeded', deliveryState: 'failed' })] })
  assert.equal((await concrete.coordinationWork()).works[0].result.code, 'delivery_failed')
})


test('unknown raw coordination or member state stays unconfirmed without overriding a concrete delivery result', async () => {
  for (const input of [
    { coordination: { state: 'future-state' }, schedules: [workSchedule()] },
    { members: [workMember('A', { state: 'future-state' }), workMember('B')] },
    { members: [workMember('A', { control: 'future-state' })] },
    { schedules: [workSchedule({ state: 'future-state' })], occurrences: [workOccurrence({ actionState: 'waiting', deliveryState: 'none' })] },
  ]) assert.equal((await workFixture(input).coordinationWork()).works[0].result.code, 'unknown')
  const concrete = workFixture({ coordination: { state: 'future-state' }, schedules: [workSchedule({ state: 'future-state' })],
    occurrences: [workOccurrence({ deliveryState: 'delivered' })] })
  assert.equal((await concrete.coordinationWork()).works[0].result.code, 'delivered')
})


test('real cancellation before send is not a failed send when notification start denies the permit', async t => {
  const f = await fixture(t), source = await f.reserve('cancel-before-send')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'cancel-unsent', members: [], readOnly: true })
  await f.command('coordination.schedule.create', { coordinationId: 'cancel-unsent', scheduleId: 'cancel-unsent-plan', timezone: 'Asia/Shanghai',
    rule: { kind: 'once', at: new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString() }, action: { kind: 'message-reminder', text: 'Never sent' },
    target: { conversationId: 'group', recipientIds: [] } })
  const occurrence = (await f.command('coordination.schedule.scan')).result.occurrences[0]
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('coordination.job.remind', { jobId: job.id, fence: job.fence })
  const notification = (await f.command('coordination.notification.freeze', { occurrenceId: occurrence.id })).result.notification
  await f.command('coordination.schedule.change', { scheduleId: 'cancel-unsent-plan', expectedRevision: 1, state: 'cancelled' })
  const pendingCancellation = await f.observer.coordinationWorkDetail('schedule:cancel-unsent-plan')
  assert.equal(pendingCancellation.work.result.code, 'cancelled')
  assert.equal((await f.store.query({ kind: 'notification.get', notificationId: notification.id })).sendPermit, undefined)
  const denied = await f.command('notification.start', { notificationId: notification.id })
  assert.equal(denied.dispatchEligible, false)
  assert.equal(denied.result.notification.state, 'failed')
  assert.equal(denied.result.notification.reason, 'coordination_cancelled')
  assert.equal(denied.result.notification.sendPermit, undefined)
  assert.equal(denied.result.notification.sendAttemptCount ?? 0, 0)
  const before = f.durableState(), detail = await f.observer.coordinationWorkDetail('schedule:cancel-unsent-plan')
  assert.equal(detail.work.result.code, 'cancelled')
  assert.equal(detail.work.nextStep.sendRetryAt, null)
  assert.deepEqual(f.durableState(), before)
})


test('cancelled unsent result notice cannot erase current formal completion of a scheduled task', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const proof = { ...version, commandId: 'complete:A' }
  const observer = workFixture({ schedules: [workSchedule({ state: 'cancelled', action: { kind: 'task-command', instructionIds: ['A'] } })],
    members: [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof, receipt: { result: { task: { taskId: 'A', requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 } } } })],
    tasks: [{ ...version, taskId: 'A', status: 'completed', completion: { commandId: proof.commandId, instructionIds: ['A'] } }],
    occurrences: [workOccurrence({ action: { kind: 'task-command', instructionIds: ['A'] }, deliveryState: 'cancelled', notificationId: 'notice', cancelledAt: '2026-10-25T01:00:00Z', result: { results: [{ instructionId: 'A', commandId: 'command:A' }] } })],
    notifications: [{ id: 'notice', state: 'failed', reason: 'coordination_cancelled' }] })
  const detail = await observer.coordinationWorkDetail('schedule:schedule')
  assert.equal(detail.work.counts.fulfilled, 1)
  assert.equal(detail.members[0].completionProofCurrent, true)
  assert.equal(detail.work.result.code, 'dispatched')
  assert.equal(detail.work.plan.state, 'cancelled')
  assert.equal(detail.work.nextStep.sendRetryAt, null)
})

test('real dependency relation waits for all formal prerequisites, stays pending without receipt and records dispatch once', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B', 'C']) await f.command('task.create', { taskId, groupId: 'group', title: `Synthetic ${taskId}`, request: taskId })
  const source = await f.reserve('relations-all')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch',
    members: [f.member('A'), f.member('B', ['A', 'C']), f.member('C')] })
  const relation = async () => (await f.observer.coordinationWorkDetail('dispatch:batch')).relations.find(item => item.target.taskId === 'B')
  assert.equal((await relation()).state, 'waiting')
  assert.equal((await f.observer.coordinationWorkDetail('dispatch:batch')).work.result.code, 'waiting')
  assert.equal((await relation()).condition, 'all')
  assert.equal((await relation()).prerequisites.filter(item => !item.fulfilled).length, 2)
  for (const taskId of ['A', 'C']) {
    await f.command('coordination.apply', { instructionId: taskId, expectedRevision: 1 })
    const binding = (await f.command('task.claim', { taskId })).result.binding
    await f.command('task.complete', { binding, summary: `Accepted ${taskId}` })
    await f.command('task.drained', { binding })
    assert.equal((await relation()).state, taskId === 'A' ? 'waiting' : 'pending')
  }
  assert.equal((await f.observer.coordinationWorkDetail('dispatch:batch')).work.result.code, 'pending')
  assert.equal((await relation()).dispatch.receipt, 'absent')
  const first = await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })
  await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })
  const before = f.durableState(), dispatched = await relation()
  assert.equal(dispatched.state, 'dispatched')
  assert.equal(dispatched.dispatch.receipt, 'accepted')
  assert.equal(dispatched.dispatch.commandId, 'coordination-command:batch:B')
  assert.equal(dispatched.target.title, 'Synthetic B')
  assert.deepEqual(dispatched.prerequisites.map(item => item.title), ['Synthetic A', 'Synthetic C'])
  assert.equal(first.result.member.receipt.result.task.taskId, 'B')
  assert.equal((await f.store.query({ kind: 'task.get', taskId: 'B' })).contextRevision, 1)
  assert.deepEqual(f.durableState(), before)
  const binding = (await f.command('task.claim', { taskId: 'B' })).result.binding
  await f.command('task.complete', { binding, summary: 'B complete, not a dispatch proof' })
  assert.deepEqual((await relation()).dispatch, dispatched.dispatch)
  await f.command('task.drained', { binding })
  await f.command('task.reopen', { taskId: 'A', request: 'Changed A goal' })
  const changed = await relation()
  assert.equal(changed.state, 'dispatched', 'recorded acceptance survives later prerequisite version changes')
  assert.equal(changed.prerequisites[0].state, 'stale')
  assert.equal(changed.prerequisites[0].fulfilled, false)
})

test('real event-backed chain resolves prerequisite titles outside each trigger entity without leaking frozen commands', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B', 'C']) await f.command('task.create', { taskId, groupId: 'group', title: `Synthetic chain ${taskId}`, request: taskId })
  const source = await f.reserve('cross-trigger-chain')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch',
    members: [f.member('A'), f.member('B', ['A']), f.member('C', ['B'])] })
  let completed
  for (const taskId of ['A', 'B', 'C']) {
    const trigger = completed ? { triggerKind: 'business-event', eventSource: 'task-ledger', eventId: completed.completionEvent.id, actionId: taskId }
      : { triggerKind: 'message', sourceUnitId: 'cross-trigger-chain', sourceUnitRevision: 1, actionId: taskId }
    const occurrence = (await f.command('coordination.occurrence.accept', { coordinationId: 'batch', trigger,
      action: { kind: 'task-command', instructionIds: [taskId] }, target: { conversationId: 'group', recipientIds: [], summaryOnly: true } })).result.occurrence
    const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
    await f.command('coordination.job.command', { jobId: job.id, fence: job.fence })
    const detail = await f.observer.coordinationWorkDetail('trigger:' + occurrence.id)
    assert.equal(detail.members.length, 1)
    assert.equal(detail.relations[0].state, 'dispatched')
    assert.equal(detail.relations[0].target.title, `Synthetic chain ${taskId}`)
    if (completed) {
      assert.equal(detail.relations[0].trigger.eventId, completed.completionEvent.id)
      assert.equal(detail.relations[0].prerequisites[0].taskId, completed.taskDecision.taskId)
      assert.equal(detail.relations[0].prerequisites[0].title, `Synthetic chain ${completed.taskDecision.taskId}`)
    }
    assert.doesNotMatch(JSON.stringify(detail.relations), /commandDigest|dispatchToken|sendPermit|frozenInstructions/)
    const binding = (await f.command('task.claim', { taskId })).result.binding
    completed = await f.command('task.complete', { binding, summary: `Completed ${taskId}` })
    await f.command('task.drained', { binding })
  }
  const before = f.durableState()
  const detail = await f.observer.taskCoordination('B', 'group')
  assert.equal(detail.relations.length, 1)
  assert.equal(detail.relations[0].prerequisites[0].taskId, 'A')
  assert.equal(detail.relations[0].dispatch.status, 'dispatched')
  assert.deepEqual(f.durableState(), before)
})

for (const identity of ['schedule/with/slash', 'schedule with space', 'schedule\\with\\backslash', 'schedule-' + 'x'.repeat(1100), 'schedule:\u0000record']) {
  test(`legal durable identity survives encoded HTTP list-detail roundtrip (${identity.length} bytes)`, async t => {
    const f = await fixture(t), source = await f.reserve('opaque-id')
    await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [], readOnly: true })
    await f.command('coordination.schedule.create', { coordinationId: 'batch', scheduleId: identity, timezone: 'Asia/Shanghai',
      rule: { kind: 'daily', time: '09:00' }, action: { kind: 'message-reminder', text: 'Synthetic identity fixture' },
      target: { conversationId: 'group', recipientIds: [] } })
    const before = f.durableState()
    const listing = await f.read('/state/coordination-work?groupId=group')
    assert.equal(listing.body.works[0].id, 'schedule:' + identity)
    const detail = await f.read('/state/coordination-work/' + encodeURIComponent(listing.body.works[0].id))
    assert.equal(detail.status, 200)
    assert.equal(detail.body.work.id, listing.body.works[0].id)
    assert.deepEqual(f.durableState(), before)
  })
}

test('real rejected stale command has no receipt and is not misreported as successful or failed dispatch', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const source = await f.reserve('stale-target')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('B')] })
  await f.command('task.revise', { taskId: 'B', request: 'New target' })
  await assert.rejects(f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 }), { code: 'DYNAMIC_COORDINATION_VERSION_STALE' })
  const detail = await f.observer.coordinationWorkDetail('dispatch:batch')
  assert.equal(detail.relations[0].state, 'stale')
  assert.equal(detail.relations[0].dispatch.receipt, 'absent')
  assert.equal(await f.store.query({ kind: 'receipt.get', id: 'coordination-command:batch:B' }), null)
})

test('relation projection keeps paused cancelled stale and recorded failure guards separate from target completion', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const parent = workMember('A', { state: 'fulfilled', effectiveVersion: version, completionReceipt: 'complete:A', completionProof: { ...version, commandId: 'complete:A' } })
  const target = workMember('B', { dependencies: ['A'] })
  const a = { ...version, taskId: 'A', title: 'Synthetic A', status: 'completed', completion: { commandId: 'complete:A', instructionIds: ['A'] } }
  for (const control of ['paused', 'cancelled']) {
    const observer = workFixture({ members: [{ ...parent, control }, target], tasks: [a, { taskId: 'B', status: 'completed' }] })
    const relation = (await observer.taskCoordination('B', 'group')).relations[0]
    assert.equal(relation.prerequisites[0].state, control)
    assert.equal(relation.prerequisites[0].fulfilled, false)
    assert.equal(relation.state, 'waiting')
    assert.equal(relation.dispatch.receipt, 'absent')
  }
  for (const state of ['failed', 'blocked', 'unknown']) {
    const observer = workFixture({ members: [parent, target], tasks: [a, { taskId: 'B', status: 'completed' }],
      occurrences: [workOccurrence({ scheduleId: null, action: { kind: 'task-command', instructionIds: ['B'] }, actionState: state, deliveryState: 'none', failureReason: 'sensitive raw failure' })] })
    const relation = (await observer.taskCoordination('B', 'group')).relations[0]
    assert.equal(relation.state, state)
    assert.equal(relation.dispatch.reason, 'coordination_trigger_failed')
    assert.equal(relation.dispatch.receipt, 'absent')
    assert.doesNotMatch(JSON.stringify(relation), /sensitive raw failure/)
  }
})

test('real task detail HTTP includes named prerequisite relations from the service read DTO without writes or runs', async t => {
  const f = await fixture(t)
  const { openTaskSessionService } = await import('../packages/dingtalk-dsh-assistant/task-session-service.js')
  const workspace = await mkdtemp(join(tmpdir(), 'coordination-task-detail-'))
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', title: `Synthetic task detail ${taskId}`, request: taskId })
  const source = await f.reserve('task-detail-dependency')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  const forbidden = async () => { throw new Error('Read-only detail must never run a model or send') }
  const noop = async () => {}
  const sessions = { run: forbidden, cancel: forbidden, close: noop }
  const residentStore = { getGroup: () => ({ groupId: 'group', messages: [] }), listGroups: () => [], listTopics: () => [] }
  const service = await openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } },
    config: { dbPath: f.store.info.dbPath, workspaceDir: workspace, instanceId: 'observer-test' },
    legacy: { getAgentConfig: () => ({ workspaceDir: workspace }), getGroup: residentStore.getGroup }, residentStore,
    store: f.store, persistence: { register: noop, close: noop }, taskSessions: sessions, executionSessions: sessions, claudeExecutionSessions: sessions })
  const server = createServer((request, response) => handleRequest(request, response, { getTaskSessionDetail: id => service.taskDetail(id) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const before = f.durableState()
    const response = await fetch(`http://127.0.0.1:${server.address().port}/state/tasks/B/detail`)
    assert.equal(response.status, 200)
    const detail = await response.json()
    assert.equal(detail.coordination.condition, 'all')
    assert.equal(detail.coordination.relations[0].state, 'waiting')
    assert.equal(detail.coordination.relations[0].prerequisites[0].title, 'Synthetic task detail A')
    assert.equal(detail.coordination.relations[0].prerequisites[0].taskHref, '/state/tasks/A/detail')
    assert.equal(detail.coordination.relations[0].target.taskId, 'B')
    assert.deepEqual(f.durableState(), before)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await service.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('real cross-coordination prerequisite remains resolvable under a group-filtered read', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', title: `Synthetic cross ${taskId}`, request: taskId })
  const parent = await f.reserve('cross-parent')
  await f.command('coordination.accept', { sourceId: parent.id, fence: 1, coordinationId: 'batch', members: [f.member('A')] })
  const source = await f.reserve('cross-child'), b = f.member('B', ['A'])
  b.command.id = 'coordination-command:child:B'
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'child', members: [b] })
  const waiting = await f.observer.taskCoordination('B', 'group')
  assert.equal(waiting.relations[0].prerequisites[0].title, 'Synthetic cross A')
  assert.equal(waiting.relations[0].state, 'waiting')
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding, summary: 'A accepted' })
  assert.equal((await f.observer.taskCoordination('B', 'group')).relations[0].state, 'pending')
  assert.equal((await f.observer.coordinationWork({ groupId: 'group', limit: 1 })).total, 2)
})

test('relations aggregate the complete collection before bounding and cannot use a proof without its formal receipt', async () => {
  const members = Array.from({ length: 101 }, (_, index) => workMember('M' + index, { receipt: { result: { task: { taskId: 'M' + index, requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 } } } }))
  members[0].receipt = null
  const observer = workFixture({ members })
  const detail = await observer.coordinationWorkDetail('dispatch:batch')
  assert.equal(detail.relations.length, 100)
  assert.deepEqual(detail.collections.relations, { total: 101, returned: 100, truncated: true })
  assert.equal(detail.work.result.code, 'pending')
  assert.equal(detail.work.counts.fulfilled, 100)
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const withoutReceipt = workFixture({
    members: [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: { ...version, commandId: 'complete:A' } }), workMember('B', { dependencies: ['A'] })],
    tasks: [{ ...version, taskId: 'A', status: 'completed', completion: { commandId: 'complete:A', instructionIds: ['A'] } }],
  })
  assert.equal((await withoutReceipt.taskCoordination('B', 'group')).relations[0].prerequisites[0].fulfilled, false)
})

test('dispatch receipt ownership comes from the frozen command lookup, never a same-task embedded receipt', async () => {
  const version = { requirementRevision: 1, contextRevision: 2, controlRevision: 1, runSequence: 1 }
  const accepted = { result: { task: { taskId: 'B', ...version } } }
  const member = workMember('B', { effectiveVersion: version, state: 'applied', command: { id: 'current:B', args: {} }, receipt: accepted })
  for (const recorded of [
    { instructionId: 'another', commandId: 'current:B', receipt: accepted },
    { instructionId: 'B', commandId: 'old:B', receipt: accepted },
    { instructionId: 'B', commandId: 'current:B', receipt: accepted },
  ]) {
    const observer = workFixture({ members: [member], receipts: new Map([['old:B', accepted]]),
      occurrences: [workOccurrence({ scheduleId: null, action: { kind: 'task-command', instructionIds: ['B'] }, deliveryState: 'none', result: { results: [recorded] } })] })
    assert.equal((await observer.taskCoordination('B', 'group')).relations[0].state, 'unknown')
  }
  for (const key of ['requirementRevision', 'controlRevision', 'contextRevision', 'runSequence']) {
    const observer = workFixture({ members: [member], receipts: new Map([['current:B', { result: { task: { taskId: 'B', ...version, [key]: version[key] + 1 } } }]]) })
    const relation = (await observer.taskCoordination('B', 'group')).relations[0]
    assert.equal(relation.state, 'unknown', key)
    assert.equal(relation.dispatch.receipt, 'absent')
  }
  const valid = workFixture({ members: [member], receipts: new Map([['current:B', accepted]]),
    tasks: [{ taskId: 'B', ...version, requirementRevision: 99, status: 'completed' }] })
  assert.equal((await valid.taskCoordination('B', 'group')).relations[0].state, 'dispatched', 'later task changes do not erase historical exact-command acceptance')
})

test('relation-first title and aggregate retain stale or pending targets alongside an already dispatched prerequisite', async () => {
  const version = { requirementRevision: 1, contextRevision: 0, controlRevision: 1, runSequence: 1 }
  const a = workMember('A', { state: 'fulfilled', completionReceipt: 'complete:A', completionProof: { ...version, commandId: 'complete:A' },
    receipt: { result: { task: { taskId: 'A', ...version } } } })
  const b = workMember('B', { dependencies: ['A'] })
  for (const completed of [false, true]) {
    const observer = workFixture({ members: [a, b], tasks: [{ taskId: 'A', ...version, title: 'Synthetic A',
      status: completed ? 'completed' : 'active', completion: { commandId: 'complete:A', instructionIds: ['A'] } }, { taskId: 'B', title: 'Synthetic B' }] })
    const work = (await observer.coordinationWork()).works[0]
    assert.equal(work.result.code, completed ? 'pending' : 'stale')
    assert.match(work.title, /Synthetic A → Synthetic B/)
    assert.equal(work.counts.fulfilled, 1)
    assert.equal(work.relations[0].state, 'dispatched')
    assert.equal(work.relations[1].state, completed ? 'pending' : 'stale')
  }
})

test('trigger relation occurrence scope cannot borrow a later failure from another trigger entity', async () => {
  const target = workMember('B')
  const action = { kind: 'task-command', instructionIds: ['B'] }
  const first = workOccurrence({ id: 'first', scheduleId: null, action, actionState: 'cancelled', deliveryState: 'cancelled',
    cancelledAt: '2026-10-25T01:00:00Z', acceptedAt: '2026-10-25T00:00:00Z' })
  const second = workOccurrence({ id: 'second', scheduleId: null, action, actionState: 'failed', deliveryState: 'none', acceptedAt: '2026-10-25T02:00:00Z' })
  const observer = workFixture({ members: [target], occurrences: [first, second] })
  const older = await observer.coordinationWorkDetail('trigger:first')
  assert.equal(older.work.occurrenceId, 'first')
  assert.equal(older.relations[0].dispatch.occurrenceId, 'first')
  assert.equal(older.work.result.code, 'cancelled')
  const newer = await observer.coordinationWorkDetail('trigger:second')
  assert.equal(newer.work.result.code, 'dispatch_failed')
  assert.equal(newer.relations[0].dispatch.occurrenceId, 'second')
})

for (const [code, state, nextStep] of [
  ['waiting_trigger', 'blocked', '等待已接纳的触发条件满足后调度'],
  ['trigger_paused', 'paused', '调度已暂停，等待明确恢复'],
  ['trigger_cancelled', 'cancelled', '本安排不再下发后续指令'],
  ['trigger_superseded', 'stale', '核对已变化的任务版本和授权'],
]) test(`unreleased trigger guard ${code} cannot become an outstanding ready dispatch`, async () => {
  const observer = workFixture({ members: [workMember('B', { requiresTrigger: true, waitingReason: { code }, dependencies: [] })] })
  const relation = (await observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.state, state)
  assert.equal(relation.dispatch.status, state)
  assert.equal(relation.dispatch.reason, code)
  assert.equal(relation.dispatch.nextStep, nextStep)
  assert.equal(relation.prerequisites.length, 0)
  assert.equal(relation.dispatch.receipt, 'absent')
})

test('a durable command receipt cannot turn a cancelled older trigger into a successful dispatch', async () => {
  const version = { requirementRevision: 1, contextRevision: 0, controlRevision: 1, runSequence: 1 }
  const accepted = { result: { task: { taskId: 'B', ...version } } }
  const target = workMember('B', { state: 'applied', receipt: accepted })
  const action = { kind: 'task-command', instructionIds: ['B'] }
  const first = workOccurrence({ id: 'first', scheduleId: null, action, actionState: 'cancelled', deliveryState: 'cancelled',
    cancelledAt: '2026-10-25T01:00:00Z', acceptedAt: '2026-10-25T00:00:00Z' })
  const second = workOccurrence({ id: 'second', scheduleId: null, action, actionState: 'succeeded', deliveryState: 'none',
    acceptedAt: '2026-10-25T02:00:00Z', result: { results: [{ instructionId: 'B', commandId: 'command:B', receipt: accepted }] } })
  const observer = workFixture({ members: [target], tasks: [{ taskId: 'B', updatedAt: '2026-10-25T03:00:00Z' }], occurrences: [first, second], receipts: new Map([['command:B', accepted]]) })
  assert.equal((await observer.coordinationWorkDetail('trigger:first')).relations[0].state, 'cancelled')
  assert.equal((await observer.coordinationWorkDetail('trigger:second')).relations[0].state, 'dispatched')
  assert.equal((await observer.taskCoordination('B', 'group')).relations[0].dispatch.occurrenceId, 'second')
  for (const record of [{ instructionId: 'other', commandId: 'command:B' }, { instructionId: 'B', commandId: 'other' }]) {
    const mismatch = workFixture({ members: [target], occurrences: [{ ...second, result: { results: [record] } }], receipts: new Map([['command:B', accepted]]) })
    assert.equal((await mismatch.taskCoordination('B', 'group')).relations[0].state, 'unknown')
  }
})

test('official blocked prerequisite decision cannot release a dependent relation or create a dispatch receipt', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const source = await f.reserve('blocked-prerequisite')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.wait', { binding, action: 'blocked', summary: 'Synthetic recorded blocker', evidence: ['synthetic-proof'], limitations: [] })
  const attempt = await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })
  assert.deepEqual(attempt.result.waiting, ['A'])
  const before = f.durableState(), relation = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.state, 'waiting')
  assert.equal(relation.prerequisites[0].fulfilled, false)
  assert.equal(relation.dispatch.receipt, 'absent')
  assert.equal(await f.store.query({ kind: 'receipt.get', id: 'coordination-command:batch:B' }), null)
  assert.deepEqual(f.durableState(), before)
})

for (const control of ['paused', 'cancelled']) test(`official task ${control} on A preserves the formal gate against dispatching B`, async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const source = await f.reserve('task-control-prerequisite')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  await f.command('task.control', { taskId: 'A', expectedControlRevision: 1, control })
  assert.deepEqual((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 1 })).result.waiting, ['A'])
  const relation = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.prerequisites[0].fulfilled, false)
  assert.equal(relation.state, 'stale', 'the stored task control revision invalidates the accepted prerequisite version')
  assert.equal(relation.dispatch.receipt, 'absent')
})

for (const action of ['pause', 'cancel']) test(`official prerequisite instruction ${action} cannot release B despite a retained formal completion proof`, async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'group', request: taskId })
  const source = await f.reserve('member-control-prerequisite')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('A'), f.member('B', ['A'])] })
  await f.command('coordination.apply', { instructionId: 'A', expectedRevision: 1 })
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding, summary: 'A formally completed before control' })
  const change = await f.reserve('member-control')
  await f.command('coordination.change', { sourceId: change.id, fence: 1, coordinationId: 'batch', expectedRevision: 1, change: { action, instructionIds: ['A'] } })
  assert.deepEqual((await f.command('coordination.apply', { instructionId: 'B', expectedRevision: 2 })).result.waiting, ['A'])
  const relation = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.state, 'waiting')
  assert.equal(relation.prerequisites[0].state, action === 'pause' ? 'paused' : 'cancelled')
  assert.ok(relation.prerequisites[0].proof.commandId, 'retained formal proof remains evidence, not release authorization')
  assert.equal(relation.prerequisites[0].fulfilled, false)
  assert.equal(relation.dispatch.receipt, 'absent')
})

test('official duplicate trigger and command receipts preserve one relation and one target mutation', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const source = await f.reserve('duplicate-trigger')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [{ ...f.member('B'), requiresTrigger: true }] })
  const waiting = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(waiting.state, 'blocked')
  assert.equal(waiting.dispatch.reason, 'waiting_trigger')
  const args = { coordinationId: 'batch', trigger: { triggerKind: 'message', sourceUnitId: 'duplicate-trigger', sourceUnitRevision: 1, actionId: 'B' },
    action: { kind: 'task-command', instructionIds: ['B'] }, target: { conversationId: 'group', recipientIds: [], summaryOnly: true } }
  const occurrence = (await f.command('coordination.occurrence.accept', args)).result.occurrence
  const duplicate = await f.command('coordination.occurrence.accept', args)
  assert.equal(duplicate.result.replayed, true)
  assert.equal(duplicate.result.occurrence.id, occurrence.id)
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  const command = { id: 'exact-trigger-command', kind: 'coordination.job.command', args: { jobId: job.id, fence: job.fence } }
  await f.store.command(command)
  const before = (await f.observer.coordinationWorkDetail('trigger:' + occurrence.id)).relations[0]
  assert.equal(before.state, 'dispatched')
  const replay = await f.store.command(command)
  assert.equal(replay.replayed, true)
  assert.deepEqual((await f.observer.coordinationWorkDetail('trigger:' + occurrence.id)).relations[0], before)
  assert.equal((await f.store.query({ kind: 'task.get', taskId: 'B' })).contextRevision, 1)
  assert.equal((await f.store.query({ kind: 'coordination.occurrence.list' })).length, 1)
})

test('official occurrence command rejection rolls back without inventing failed dispatch evidence', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const source = await f.reserve('rejected-occurrence-command')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('B')] })
  const occurrence = (await f.command('coordination.occurrence.accept', { coordinationId: 'batch',
    trigger: { triggerKind: 'message', sourceUnitId: 'rejected-occurrence-command', sourceUnitRevision: 1, actionId: 'B' },
    action: { kind: 'task-command', instructionIds: ['B'] }, target: { conversationId: 'group', recipientIds: [], summaryOnly: true } })).result.occurrence
  const job = (await f.command('coordination.job.claim', { jobId: occurrence.jobId })).result.job
  await f.command('task.revise', { taskId: 'B', request: 'Changed frozen target' })
  await assert.rejects(f.command('coordination.job.command', { jobId: job.id, fence: job.fence }), { code: 'DYNAMIC_COORDINATION_VERSION_STALE' })
  const detail = await f.observer.coordinationWorkDetail('trigger:' + occurrence.id)
  assert.equal(detail.relations[0].state, 'stale')
  assert.equal(detail.relations[0].dispatch.reason, 'target_version_changed')
  assert.equal(detail.relations[0].dispatch.receipt, 'absent')
  assert.equal(await f.store.query({ kind: 'receipt.get', id: 'coordination-command:batch:B' }), null)
  const raw = await f.store.query({ kind: 'coordination.occurrence.get', occurrenceId: occurrence.id })
  assert.notEqual(raw.actionState, 'failed', 'failed command transaction has no durable failure record to project')
})

test('task relation selection follows occurrence attempt time instead of work updatedAt or entity ID order', async () => {
  const version = { requirementRevision: 1, contextRevision: 0, controlRevision: 1, runSequence: 1 }
  const accepted = { result: { task: { taskId: 'B', ...version } } }
  const member = workMember('B', { state: 'applied', effectiveVersion: version, command: { id: 'command:B', args: {} } })
  const action = { kind: 'task-command', instructionIds: ['B'] }
  const oldWork = workOccurrence({ id: 'first', scheduleId: null, action, actionState: 'cancelled', deliveryState: 'cancelled',
    cancelledAt: '2026-10-25T01:00:00Z', acceptedAt: '2026-10-25T01:00:00Z' })
  const newWork = workOccurrence({ id: 'second', scheduleId: null, action, actionState: 'succeeded', deliveryState: 'none',
    acceptedAt: '2026-10-25T02:00:00Z', result: { results: [{ instructionId: 'B', commandId: 'command:B', receipt: accepted }] } })
  for (const [oldId, newId] of [['first', 'second'], ['z-old', 'a-new']]) for (const reverse of [false, true]) {
    const occurrences = [{ ...oldWork, id: oldId }, { ...newWork, id: newId }]
    if (reverse) occurrences.reverse()
    const observer = workFixture({ members: [member], tasks: [{ taskId: 'B', title: 'B', updatedAt: '2026-10-25T03:00:00Z' }],
      occurrences, receipts: new Map([['command:B', accepted]]) })
    const relation = (await observer.taskCoordination('B', 'group')).relations[0]
    assert.equal(relation.dispatch.occurrenceId, newId)
    assert.equal(relation.state, 'dispatched')
    assert.equal((await observer.coordinationWorkDetail('trigger:' + oldId)).relations[0].state, 'cancelled')
  }
})

test('official cancelled trigger followed by successful trigger stays successful on task detail after target update', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T01:00:00Z') })
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const source = await f.reserve('attempt-order')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('B')] })
  const args = { coordinationId: 'batch', action: { kind: 'task-command', instructionIds: ['B'] }, target: { conversationId: 'group', recipientIds: [], summaryOnly: true } }
  const first = (await f.command('coordination.occurrence.accept', { ...args,
    trigger: { triggerKind: 'message', sourceUnitId: 'attempt-order', sourceUnitRevision: 1, actionId: 'first' } })).result.occurrence
  await f.command('coordination.occurrence.control', { occurrenceId: first.id, expectedControlRevision: 1, control: 'cancel' })
  t.mock.timers.tick(3600000)
  const second = (await f.command('coordination.occurrence.accept', { ...args,
    trigger: { triggerKind: 'message', sourceUnitId: 'attempt-order', sourceUnitRevision: 1, actionId: 'second' } })).result.occurrence
  t.mock.timers.tick(3600000)
  const job = (await f.command('coordination.job.claim', { jobId: second.jobId })).result.job
  await f.command('coordination.job.command', { jobId: job.id, fence: job.fence })
  const target = await f.store.query({ kind: 'task.get', taskId: 'B' })
  assert.equal(target.updatedAt, '2026-10-25T03:00:00.000Z')
  const before = f.durableState(), relation = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.dispatch.occurrenceId, second.id)
  assert.equal(relation.state, 'dispatched')
  assert.equal((await f.observer.coordinationWorkDetail('trigger:' + first.id)).relations[0].state, 'cancelled')
  assert.deepEqual(f.durableState(), before)
})

test('official later cancelled trigger is current without erasing an earlier accepted command', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T01:00:00Z') })
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'B', groupId: 'group', request: 'B' })
  const source = await f.reserve('success-before-cancellation')
  await f.command('coordination.accept', { sourceId: source.id, fence: 1, coordinationId: 'batch', members: [f.member('B')] })
  const args = { coordinationId: 'batch', action: { kind: 'task-command', instructionIds: ['B'] }, target: { conversationId: 'group', recipientIds: [], summaryOnly: true } }
  const first = (await f.command('coordination.occurrence.accept', { ...args,
    trigger: { triggerKind: 'message', sourceUnitId: 'success-before-cancellation', sourceUnitRevision: 1, actionId: 'first' } })).result.occurrence
  const job = (await f.command('coordination.job.claim', { jobId: first.jobId })).result.job
  await f.command('coordination.job.command', { jobId: job.id, fence: job.fence })
  t.mock.timers.tick(3600000)
  const second = (await f.command('coordination.occurrence.accept', { ...args,
    trigger: { triggerKind: 'message', sourceUnitId: 'success-before-cancellation', sourceUnitRevision: 1, actionId: 'second' } })).result.occurrence
  await f.command('coordination.occurrence.control', { occurrenceId: second.id, expectedControlRevision: 1, control: 'cancel' })
  t.mock.timers.tick(3600000)
  await f.command('task.supplement', { taskId: 'B', messageId: 'later-update', expectedRequirementRevision: 1, expectedControlRevision: 1, text: 'Later synthetic target update' })
  const before = f.durableState(), relation = (await f.observer.taskCoordination('B', 'group')).relations[0]
  assert.equal(relation.dispatch.occurrenceId, second.id)
  assert.equal(relation.state, 'cancelled')
  assert.equal(relation.dispatch.receipt, 'absent', 'the cancelled attempt did not record command acceptance')
  const earlier = (await f.observer.coordinationWorkDetail('trigger:' + first.id)).relations[0]
  assert.equal(earlier.state, 'dispatched', 'later cancellation and task update do not erase the earlier acceptance')
  assert.equal(earlier.dispatch.receipt, 'accepted')
  assert.ok(await f.store.query({ kind: 'receipt.get', id: 'coordination-command:batch:B' }))
  assert.deepEqual(f.durableState(), before)
})
