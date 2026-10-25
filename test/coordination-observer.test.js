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
