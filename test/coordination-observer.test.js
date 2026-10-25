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

function workFixture({ members = [], tasks = [], schedules = [], occurrences = [], jobs = [], notifications = [], sources = [], executions = [], coordination = {} } = {}) {
  const batch = { id: 'batch', revision: 1, state: 'active', groupId: 'group', createdAt: '2026-10-25T00:00:00Z', ...coordination }
  return createCoordinationObserver(async (kind, args = {}) => {
    if (kind === 'coordination.list') return !args.groupId || args.groupId === batch.groupId ? [batch] : []
    if (kind === 'coordination.get') return { coordination: batch, members }
    if (kind === 'task.get') return tasks.find(task => task.taskId === args.taskId)
    return { 'coordination.schedule.list': schedules, 'coordination.occurrence.list': occurrences, 'coordination.job.list': jobs,
      'notification.list': notifications, 'coordination.source.list': sources, 'execution.list': executions }[kind] ?? []
  })
}
const workSchedule = (overrides = {}) => ({ id: 'schedule', coordinationId: 'batch', revision: 2, state: 'active', timezone: 'Asia/Shanghai',
  rule: { kind: 'once', at: '2026-10-25T00:00:00Z' }, action: { kind: 'message-reminder', text: 'Synthetic reminder' }, nextDueAt: null, ...overrides })
const workOccurrence = (overrides = {}) => ({ id: 'occurrence', coordinationId: 'batch', scheduleId: 'schedule',
  acceptedAt: '2026-10-25T00:00:01Z', plannedAt: '2026-10-25T00:00:00Z', action: { kind: 'message-reminder', text: 'Synthetic reminder' },
  actionState: 'succeeded', deliveryState: 'failed', ...overrides })
const workMember = (id, overrides = {}) => ({ id, taskId: id, coordinationId: 'batch', state: 'ready', control: 'active',
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

test('work formal completion requires current target version proof and active task alone never proves execution', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const proof = { ...version, commandId: 'complete:A' }
  const task = { ...version, taskId: 'A', status: 'completed', completion: { commandId: 'complete:A', instructionIds: ['A'] } }
  for (const [member, target, expected] of [
    [workMember('A'), { ...task, status: 'active' }, 'waiting'],
    [workMember('A', { state: 'applied' }), { ...task, status: 'active' }, 'dispatched'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version }), task, 'unknown'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof }), task, 'task_completed'],
    [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof, waitingReason: { code: 'target_version_changed' } }), { ...task, runSequence: 2 }, 'blocked'],
  ]) {
    const { works } = await workFixture({ members: [member], tasks: [target] }).coordinationWork()
    assert.equal(works[0].result.code, expected)
  }
  const mixed = await workFixture({ members: [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof }), workMember('B')], tasks: [task, { taskId: 'B', status: 'active' }] }).coordinationWork()
  assert.equal(mixed.works[0].result.code, 'partially_completed'); assert.equal(mixed.works[0].counts.fulfilled, 1)
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
  for (const id of ['%ZZ', 'arbitrary', 'schedule%3A', 'schedule%3A%2Fprivate', 'schedule%3A%00', 'schedule%3Awith%20space'])
    assert.equal((await f.read(`/state/coordination-work/${id}`)).status, 400, id)
  assert.equal((await f.read('/state/coordination-work/schedule%3Amissing')).status, 404)
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

test('work only reports execution with matching instruction and target version, not merely an active task', async () => {
  const version = { requirementRevision: 1, controlRevision: 1, contextRevision: 0, runSequence: 1 }
  const member = workMember('A', { state: 'applied', effectiveVersion: version })
  const execution = { taskId: 'A', status: 'running', drained: false, instructionScope: { ...version, instructionIds: ['A'] } }
  for (const [input, expected] of [[execution, 'running'], [{ ...execution, recovering: true }, 'dispatched'],
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
  assert.equal(detail.work.result.code, 'task_completed')
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
  assert.equal(detail.work.result.code, 'task_completed')
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
    members: [workMember('A', { state: 'fulfilled', effectiveVersion: version, completionProof: proof })],
    tasks: [{ ...version, taskId: 'A', status: 'completed', completion: { commandId: proof.commandId, instructionIds: ['A'] } }],
    occurrences: [workOccurrence({ action: { kind: 'task-command', instructionIds: ['A'] }, deliveryState: 'cancelled', notificationId: 'notice', cancelledAt: '2026-10-25T01:00:00Z' })],
    notifications: [{ id: 'notice', state: 'failed', reason: 'coordination_cancelled' }] })
  const detail = await observer.coordinationWorkDetail('schedule:schedule')
  assert.equal(detail.work.counts.fulfilled, 1)
  assert.equal(detail.members[0].completionProofCurrent, true)
  assert.equal(detail.work.result.code, 'task_completed')
  assert.equal(detail.work.plan.state, 'cancelled')
  assert.equal(detail.work.nextStep.sendRetryAt, null)
})
