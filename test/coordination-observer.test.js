import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { createCoordinationObserver as productionCoordinationObserver } from '../packages/dingtalk-dsh-assistant/coordination-observer.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

// Old view fixtures describe domain records, not SQLite. Adapt their query contract
// to the new narrow read model while preserving every existing outcome assertion.
function createCoordinationObserver(query){
 const metadata=async args=>{
  const coords=await query('coordination.list',args),states=await Promise.all(coords.map(item=>query('coordination.get',{coordinationId:item.id})))
  const members=states.flatMap(state=>state.members),tasks=(await Promise.all([...new Set(members.map(item=>item.taskId))].map(taskId=>query('task.get',{taskId})))).filter(Boolean)
  const receipts=(await Promise.all([...new Set(members.map(item=>item.command?.id).filter(Boolean))].map(async id=>{const value=await query('receipt.get',{id});return value?{...value,id}:null}))).filter(Boolean)
  const [schedules,occurrences,jobs,notifications,sources,executions]=await Promise.all(['coordination.schedule.list','coordination.occurrence.list','coordination.job.list','notification.list','coordination.source.list','execution.list'].map(kind=>query(kind)))
  return {coords,members,tasks,receipts,schedules,occurrences,jobs,notifications,sources,executions}
 }
 return productionCoordinationObserver(async(kind,args={})=>{
  const value=await query(kind,args)
  if(kind==='observer.revision'&&typeof value!=='string')return JSON.stringify(await metadata({}))
  if(kind==='observer.work-metadata'&&!value?.coords)return metadata(args)
  return value
 })
}

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


// The public coordination work pages are gone. Historical rows below are loaded
// directly as upgrade fixtures, never created by a retired production command.
async function fixture(t,{sources=[],members=[],schedules=[],occurrences=[],jobs=[],notifications=[],coords=[],taskState='active'}={}){
  const directory=await mkdtemp(join(tmpdir(),'coordination-audit-')),dbPath=join(directory,'tasks.sqlite')
  const options={dbPath,instanceId:'observer-test',initialize:true}
  let store=await openDynamicTaskStore(options),counter=0
  const command=(kind,args)=>store.command({id:'current-'+(++counter),kind,args})
  for(const taskId of ['A','B']){
    await command('task.create',{taskId,groupId:'group',title:'Task '+taskId,request:'Authorized '+taskId})
    if(taskId==='A'&&taskState==='completed'){
      const binding=(await command('task.claim',{taskId})).result.binding
      await command('task.complete',{binding,summary:'Actual Owner acceptance',result:{evidence:['owner-proof']}})
      await command('task.drained',{binding})
    }else if(taskId==='A'&&taskState!=='active')await command('task.control',{taskId,expectedControlRevision:1,control:taskState,reason:'Explicit user control'})
  }
  const tasksBefore=await store.query({kind:'task.list'})
  await store.close()
  const db=new DatabaseSync(dbPath)
  db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
  const batch={id:'batch',groupId:'group',state:'active',revision:1,memberIds:members.map(row=>row.id)}
  for(const [table,rows] of Object.entries({coordination:[batch,...coords],coordination_sources:sources,coordination_members:members,
    coordination_schedules:schedules,coordination_occurrences:occurrences,coordination_jobs:jobs,notifications}))
    for(const row of rows)db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(row.id,JSON.stringify(row))
  db.close();store=await openDynamicTaskStore(options)
  const observer=createCoordinationObserver((kind,args={})=>store.query({kind,...args}))
  const server=createServer((request,response)=>handleRequest(request,response,{}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await store.close();await rm(directory,{recursive:true,force:true})})
  const read=async path=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`);return{status:response.status,body:await response.json()}}
  const durableState=()=>{
    const db=new DatabaseSync(dbPath,{readOnly:true})
    try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>({
      name,rows:db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()}))}finally{db.close()}
  }
  return{store,observer,command,read,durableState,tasksBefore,query:(kind,args={})=>store.query({kind,...args}),
    async restart(){await store.close();store=await openDynamicTaskStore(options)}}
}
const historicalSource=(state,extra={})=>({id:'source-'+state,groupId:'group',unitId:'unit-'+state,revision:1,dispatchOwner:'coordination',state,
  sourceMessageId:'original',original:'Full original request',coordinationId:'batch',question:'Recorded question',...extra})
const historicalMember=(id,extra={})=>({id,taskId:id,coordinationId:'batch',state:'ready',dependencies:[],command:{id:'historical-'+id,kind:'task.supplement',args:{text:'Recorded material'}},...extra})
const withoutRetirement=row=>{const{retirement,...rest}=row;return rest}

for(const state of ['reserved','rejected','accepted','needs_clarification'])
test(`historical ${state} source stays intact and group scoped without dispatching or revealing it over retired HTTP`,async t=>{
  const source=historicalSource(state,state==='rejected'?{rejectionReason:'Recorded rejection'}:{})
  const foreign={...historicalSource('accepted'),id:'foreign',unitId:'foreign',groupId:'other',original:'Other group private text'}
  const f=await fixture(t,{sources:[source,foreign],members:[historicalMember('A'),historicalMember('B',{dependencies:['A']})]})
  const before=f.durableState(),[saved]=await f.query('coordination.source.list',{groupId:'group'})
  assert.deepEqual(withoutRetirement(saved),source);assert.equal(saved.retirement.previousState,state)
  const detail=await f.query('coordination.get',{coordinationId:'batch'})
  assert.deepEqual(detail.members[1].dependencies,['A']);assert.ok(detail.members.every(member=>member.eligible===false))
  assert.deepEqual(await f.query('task.list'),f.tasksBefore)
  assert.deepEqual(await f.read('/state/coordination-sources?groupId=group'),{status:410,body:{error:'INDEPENDENT_COORDINATION_RETIRED'}})
  assert.deepEqual(f.durableState(),before)
})

test('read-only historical coordination index keeps real bounded pagination and all record identities',async t=>{
  const coords=Array.from({length:204},(_,index)=>({id:'coord-'+index,groupId:'group',state:'active',revision:1}))
  const f=await fixture(t,{coords}),before=f.durableState(),items=[];let after=0
  do{const page=await f.query('coordination.index',{groupId:'group',limit:100,after});assert.ok(page.items.length<=100);items.push(...page.items);after=page.nextAfter}while(after!==null)
  assert.equal(items.length,205);assert.equal(new Set(items.map(item=>item.id)).size,205)
  await assert.rejects(f.query('coordination.index',{limit:101}),{code:'DYNAMIC_ARGUMENT_INVALID'})
  assert.deepEqual(f.durableState(),before)
})

test('recorded reorder assessment and evidence survive retirement without changing Task revisions',async t=>{
  const assessment={id:'assess',state:'needs_clarification',summary:'Recorded question',decision:'needs_clarification',evidence:['Recorded proof']}
  const member=historicalMember('A',{state:'applied',reorderAssessment:assessment})
  const f=await fixture(t,{members:[member],sources:[historicalSource('accepted',{lastError:'PrivateDiagnostic123'})]})
  const before=f.durableState(),saved=(await f.query('coordination.get',{coordinationId:'batch'})).members[0]
  assert.deepEqual(saved.reorderAssessment,assessment);assert.equal(saved.state,'applied');assert.equal(saved.eligible,false)
  const detail=await f.observer.coordinationSourceDetail('source-accepted')
  assert.equal(detail.source.failureCode,'coordination_processing_failed');assert.doesNotMatch(JSON.stringify(detail),/PrivateDiagnostic123/)
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual(f.durableState(),before)
})

test('historical observation and replan retain recorded impact without reopening or revising linked Tasks',async t=>{
  const members=[historicalMember('A',{observation:true}),historicalMember('B',{progressImpact:'replan',impactReason:'Recorded requirement change'})]
  const f=await fixture(t,{members}),before=f.durableState()
  const saved=(await f.query('coordination.get',{coordinationId:'batch'})).members
  assert.equal(saved[0].observation,true);assert.equal(saved[1].progressImpact,'replan')
  assert.equal(saved[1].impactReason,members[1].impactReason)
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual(await f.query('execution.list'),[])
  assert.deepEqual(f.durableState(),before)
})

for(const path of ['/state/coordination-sources?limit=0&limit=2','/state/coordination-work?groupId=&unknown=1',
  '/state/coordination-sources/%ZZ','/state/coordination-work/missing',
  ...['schedule/with/slash','schedule with space','schedule\\with\\backslash','schedule-'+'x'.repeat(1100),'schedule:\u0000record'].map(id=>'/state/coordination-work/'+encodeURIComponent(id))])
test(`retired HTTP path does not decode or query private history: ${path.length} bytes ${path.slice(0,44)}`,async t=>{
  const f=await fixture(t),before=f.durableState()
  assert.deepEqual(await f.read(path),{status:410,body:{error:'INDEPENDENT_COORDINATION_RETIRED'}})
  assert.deepEqual(f.durableState(),before)
})

for(const control of ['coordination-cancel','cancel','pause'])
test(`historical ${control} cannot erase genuine Owner completion or turn receipt metadata into new work`,async t=>{
  const member=historicalMember('A',{state:'fulfilled',control,completionProof:{commandId:'historical-claim-only',runSequence:1}})
  const f=await fixture(t,{members:[member],taskState:'completed'}),before=f.durableState()
  const task=await f.query('task.get',{taskId:'A'})
  assert.equal(task.status,'completed');assert.equal(task.completion.summary,'Actual Owner acceptance')
  assert.notEqual(task.completion.commandId,member.completionProof.commandId)
  const saved=(await f.query('coordination.get',{coordinationId:'batch'})).members[0]
  assert.deepEqual(saved.completionProof,member.completionProof);assert.equal(saved.eligible,false)
  assert.deepEqual(await f.query('execution.list'),[]);assert.deepEqual(f.durableState(),before)
})

for(const state of ['prepared','starting','failed','unknown','delivered'])
test(`historical ${state} notification preserves actual delivery evidence while retired views stay inaccessible`,async t=>{
  const notice={id:'notice',kind:'coordination',state,payload:{conversationId:'group',text:'Frozen old result',fact:{coordinationId:'batch',eventId:'old'}},
    ...(state==='starting'||state==='unknown'?{dispatchToken:'previous-permit',sendAttemptCount:1,ack:{openTaskId:'accepted'}}:{}),
    ...(state==='delivered'?{receipt:{messageId:'visible-message'}}:{}),...(state==='failed'?{deliveryError:{phase:'send',message:'Recorded failure'}}:{})}
  const f=await fixture(t,{notifications:[notice]}),before=f.durableState(),saved=await f.query('notification.get',{notificationId:'notice'})
  assert.equal(saved.state,state==='prepared'?'superseded':state==='starting'?'unknown':state)
  assert.deepEqual(saved.payload,notice.payload);assert.deepEqual(saved.receipt,notice.receipt);assert.deepEqual(saved.ack,notice.ack)
  assert.deepEqual(await f.read('/state/coordination-work'),{status:410,body:{error:'INDEPENDENT_COORDINATION_RETIRED'}})
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual(f.durableState(),before)
})

for(const taskState of ['active','paused','cancelled'])
test(`historical dependent relation cannot dispatch against a current ${taskState} prerequisite`,async t=>{
  const members=[historicalMember('A',{state:'fulfilled',completionProof:{commandId:'unproven-old-complete'}}),historicalMember('B',{dependencies:['A']})]
  const f=await fixture(t,{members,taskState}),before=f.durableState()
  const saved=await f.query('coordination.get',{coordinationId:'batch'})
  assert.deepEqual(saved.members[1].dependencies,['A']);assert.equal(saved.members[1].eligible,false)
  assert.equal(await f.query('receipt.get',{id:'historical-B'}),null)
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual(await f.query('execution.list'),[])
  assert.deepEqual(f.durableState(),before)
})

for(const state of ['waiting','rejected','cancelled','succeeded'])
test(`historical ${state} occurrence cannot manufacture a current dispatch receipt or Task completion`,async t=>{
  const occurrence={id:'old-trigger',coordinationId:'batch',actionState:state,acceptedCommand:{id:'uncommitted',taskId:'B'},plannedAt:'2026-10-21T00:00:00Z'}
  const f=await fixture(t,{members:[historicalMember('B')],occurrences:[occurrence]}),before=f.durableState()
  assert.deepEqual(await f.query('coordination.occurrence.list'),[occurrence])
  assert.equal(await f.query('receipt.get',{id:'uncommitted'}),null)
  assert.equal((await f.query('task.get',{taskId:'B'})).status,'active')
  assert.deepEqual((await f.query('task.events')).events,[]);assert.deepEqual(f.durableState(),before)
})

test('current Task detail remains readable without restarting models, exposing legacy relations or writing the ledger',async t=>{
  const f=await fixture(t,{members:[historicalMember('A'),historicalMember('B',{dependencies:['A']})]})
  const {openTaskSessionService}=await import('../packages/dingtalk-dsh-assistant/task-session-service.js')
  const workspace=await mkdtemp(join(tmpdir(),'current-task-detail-'))
  const forbidden=async()=>assert.fail('read-only detail must never run a model or send'),noop=async()=>{}
  const sessions={run:forbidden,cancel:forbidden,close:noop}
  const residentStore={getGroup:()=>({groupId:'group',messages:[]}),listGroups:()=>[],listTopics:()=>[]}
  const service=await openTaskSessionService({ctx:{agents:{get(){}},sessions:{get(){}}},config:{dbPath:f.store.info.dbPath,workspaceDir:workspace,instanceId:'observer-test'},
    legacy:{getAgentConfig:()=>({workspaceDir:workspace}),getGroup:residentStore.getGroup},residentStore,store:f.store,
    persistence:{register:noop,close:noop},taskSessions:sessions,executionSessions:sessions,claudeExecutionSessions:sessions})
  const server=createServer((request,response)=>handleRequest(request,response,{getTaskSessionDetail:id=>service.taskDetail(id)}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const before=f.durableState(),response=await fetch(`http://127.0.0.1:${server.address().port}/state/tasks/B/detail`)
    assert.equal(response.status,200);const detail=await response.json()
    assert.equal(detail.taskId,'B');assert.equal(detail.coordination,undefined)
    assert.deepEqual(f.durableState(),before)
  }finally{await new Promise(resolve=>server.close(resolve));await service.close();await rm(workspace,{recursive:true,force:true})}
})

test('cross-group historical coordination index retains only requested group and cannot apply linked members',async t=>{
  const f=await fixture(t,{coords:[{id:'other-batch',groupId:'other',state:'active',revision:1}],members:[historicalMember('A'),historicalMember('B',{coordinationId:'other-batch',dependencies:['A']})]})
  const before=f.durableState(),page=await f.query('coordination.index',{groupId:'group'})
  assert.deepEqual(page.items.map(item=>item.id),['batch'])
  assert.equal((await f.query('coordination.get',{coordinationId:'other-batch'})).members[0].eligible,false)
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual(f.durableState(),before)
})

test('repeated historical reads and cold reopen preserve the same accepted-command audit without duplicate mutations',async t=>{
  const occurrence={id:'old-trigger',coordinationId:'batch',actionState:'succeeded',commandId:'old-accepted',recordedAt:'2026-10-21T00:00:00Z'}
  const f=await fixture(t,{occurrences:[occurrence],members:[historicalMember('B',{state:'applied'})]})
  for(let i=0;i<3;i++){
    assert.deepEqual(await f.query('coordination.occurrence.list'),[occurrence])
    assert.equal((await f.query('task.get',{taskId:'B'})).contextRevision??0,0)
    assert.equal(await f.query('receipt.get',{id:'old-accepted'}),null)
    if(i<2)await f.restart()
  }
})

for(const newest of ['succeeded','cancelled'])
test(`historical trigger chronology preserves both outcomes when newest is ${newest}, without inferring a current Task result`,async t=>{
  const occurrences=['cancelled','succeeded'].map((state,index)=>({id:'trigger-'+index,coordinationId:'batch',actionState:state,
    acceptedAt:state===newest?'2026-10-22T00:00:00Z':'2026-10-21T00:00:00Z',commandId:state==='succeeded'?'old-success':null}))
  const f=await fixture(t,{occurrences}),before=f.durableState()
  assert.deepEqual(await f.query('coordination.occurrence.list'),occurrences)
  assert.deepEqual(await f.query('task.list'),f.tasksBefore);assert.deepEqual((await f.query('task.events')).events,[])
  assert.deepEqual(f.durableState(),before)
})
