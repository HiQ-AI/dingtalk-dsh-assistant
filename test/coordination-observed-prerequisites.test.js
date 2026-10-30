import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { freezeCoordinationMembers } from '../packages/dingtalk-dsh-assistant/coordination-task-commands.js'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'
import { taskBoundaryInstructions } from '../packages/dingtalk-dsh-assistant/task-boundary-instructions.js'

test('single-goal stages preserve one creation envelope or revise the original Task with all ordered requirements', () => {
  const objective = '需求X先方案评审，然后开发，开发完部署UAT'
  const requirements = ['方案评审', '评审后开发', '开发后部署UAT并验证']
  const source = { sourceId: 'source', groupId: 'g', actorId: 'u', unitId: 'unit', unitRevision: 1 }
  const proposal = coordinationProposalSchema.parse({ kind: 'arrangement', members: [
    { action: 'new-task', creationKey: 'X', title: '需求X交付', objective, requirements }] })
  const [created] = freezeCoordinationMembers({ coordinationId: 'one', proposal, tasks: new Map(), source })
  assert.equal(created.createCommand.args.objective, objective)
  assert.deepEqual(created.createCommand.args.requirements, requirements)
  assert.deepEqual(created.dependencies, [])
  const task = { taskId: 'X', groupId: 'g', request: '需求X评审', status: 'active', control: 'active',
    requirementRevision: 1, controlRevision: 1, runSequence: 1 }
  const update = coordinationProposalSchema.parse({ kind: 'arrangement', members: [
    { action: 'task-context', taskId: 'X', inputVersion: 1, runSequence: 1, progressImpact: 'replan',
      impactReason: '补充后续交付', context: objective, objective, requirements }] })
  const [revised] = freezeCoordinationMembers({ coordinationId: 'update', proposal: update, tasks: new Map([['X', task]]), source })
  assert.equal(revised.createCommand, undefined)
  assert.equal(revised.command.args.taskId, 'X')
  assert.equal(revised.command.args.objective, objective)
  assert.deepEqual(revised.command.args.requirements, requirements)
  assert.ok(revised.command.args.request.includes(objective))
  assert.match(taskBoundaryInstructions, /不能凭相同项目名或顺序词合并独立任务/)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'observe-prerequisite-'))
  const options = { dbPath: join(root, 'tasks.db'), instanceId: 'observe-test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ kind, args, id })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  for (const taskId of ['A', 'B']) await command('task.create', { taskId, groupId: 'g', ownerActorId: 'u', request: taskId })
  const owner = async taskId => (await command('task.claim', { taskId, force: true })).result.binding
  const complete = async taskId => {
    const binding = await owner(taskId)
    const receipt = await command('task.complete', { binding, summary: 'Owner正式验收', result: { evidence: ['proof'] } })
    await command('task.drained', { binding })
    return receipt
  }
  return { command, query, owner, complete,
    inject: fn => { const db = new DatabaseSync(options.dbPath); try { fn(db) } finally { db.close() } },
    restart: async () => { await store.close(); store = await openDynamicTaskStore({ ...options, initialize: false }) } }
}

for (const before of [true, false]) test(`reading A completion is side-effect free and cannot wake B: completedBefore=${before}`, async t => {
  const f = await fixture(t)
  if (before) await f.complete('A')
  const original = await f.query('task.get', { taskId: 'A' }), wakes = await f.query('wake.list', { taskId: 'A' })
  const b = await f.query('task.get', { taskId: 'B' }), bWakes = await f.query('wake.list', { taskId: 'B' })
  await f.query('task.decisions', { taskId: 'A' }); await f.query('task.events')
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), original)
  assert.deepEqual(await f.query('wake.list', { taskId: 'A' }), wakes)
  if (!before) await f.complete('A')
  await f.restart()
  const [event] = (await f.query('task.events')).events
  const proof = await f.query('receipt.get', { id: event.taskDecisionReceiptId })
  assert.equal(proof.taskDecision.decision.action, 'complete'); assert.equal(event.taskId, 'A')
  const a = await f.query('task.get', { taskId: 'A' })
  for (const key of ['contextRevision', 'requirementRevision', 'runSequence']) assert.equal(a[key], original[key])
  assert.deepEqual(a.completion.instructionIds, [])
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), b)
  assert.deepEqual(await f.query('wake.list', { taskId: 'B' }), bWakes)
  // A new run invalidates current completion, while the original proof stays historical.
  await f.command('task.reopen', { taskId: 'A', expectedRequirementRevision: a.requirementRevision,
    expectedControlRevision: a.controlRevision, request: 'new A target' })
  const reopened = await f.query('task.get', { taskId: 'A' })
  assert.equal(reopened.completion, null); assert.equal(reopened.status, 'active')
  assert.notEqual(reopened.requirementRevision, proof.taskDecision.requirementRevision)
  assert.notEqual(reopened.runSequence, proof.taskDecision.runSequence)
  assert.deepEqual(await f.query('receipt.get', { id: event.taskDecisionReceiptId }), proof)
  assert.deepEqual(await f.query('wake.list', { taskId: 'B' }), bWakes)
})

test('completed status without its receipt is not fabricated into authoritative completion proof', async t => {
  const f = await fixture(t), receipt = await f.complete('A')
  f.inject(db => db.prepare('DELETE FROM dynamic_receipts WHERE id=?').run(receipt.taskDecision.id))
  const other = await f.query('task.get', { taskId: 'B' }), wakes = await f.query('wake.list', { taskId: 'B' })
  assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'completed')
  assert.equal(await f.query('receipt.get', { id: receipt.taskDecision.id }), null)
  assert.deepEqual((await f.query('task.decisions', { taskId: 'A' })).decisions, [])
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), other)
  assert.deepEqual(await f.query('wake.list', { taskId: 'B' }), wakes)
})

test('legacy completion receipt without an event remains evidence without manufacturing a new completion', async t => {
  const f = await fixture(t), receipt = await f.complete('A'), id = receipt.taskDecision.id
  const legacy = await f.query('receipt.get', { id })
  f.inject(db => {
    const body = structuredClone(legacy); delete body.completionEvent
    db.prepare('UPDATE dynamic_receipts SET body=? WHERE id=?').run(JSON.stringify(body), id)
    db.prepare('DELETE FROM dynamic_task_events WHERE id=?').run(`task-completed:${id}`)
  })
  await f.restart()
  assert.deepEqual((await f.query('receipt.get', { id })).taskDecision, legacy.taskDecision)
  assert.deepEqual((await f.query('task.events')).events, [])
  for (const control of ['paused', 'cancelled']) {
    const b = await f.query('task.get', { taskId: 'B' })
    await f.command('task.control', { taskId: 'B', expectedControlRevision: b.controlRevision, control })
    assert.equal((await f.query('task.get', { taskId: 'B' })).completion, undefined)
    assert.deepEqual((await f.query('task.events')).events, [])
    assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'completed')
  }
})

test('supplementing running B preserves its execution and leaves completion to its Owner', async t => {
  const f = await fixture(t), binding = await f.owner('B')
  const execution = (await f.command('execution.dispatch', { binding, key: 'old', prompt: 'old B', input: {}, resourceKeys: [] })).result.execution
  await f.command('execution.claim', { executionId: execution.id })
  const before = await f.query('task.get', { taskId: 'B' })
  await f.command('task.supplement', { taskId: 'B', messageId: 'next-stage', text: '核验A结果后继续原目标',
    expectedRequirementRevision: 1, expectedControlRevision: 1 })
  const after = await f.query('task.get', { taskId: 'B' }), current = await f.query('execution.get', { executionId: execution.id })
  for (const key of ['sessionId', 'requirementRevision', 'controlRevision', 'runSequence']) assert.deepEqual(after[key], before[key])
  assert.equal(after.contextRevision, (before.contextRevision ?? 0) + 1)
  assert.equal(current.cancelRequested, false)
  assert.deepEqual(current.feedback.map(item => item.text), ['核验A结果后继续原目标'])
  await assert.rejects(f.command('task.complete', { binding, summary: 'skip new context' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('task.drained', { binding })
  const currentBinding = await f.owner('B')
  await assert.rejects(f.command('task.complete', { binding: currentBinding, summary: 'skip active execution' }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  assert.equal((await f.query('task.get', { taskId: 'B' })).completion, undefined)
})

test('continue never silently reopens an already completed B', async t => {
  const f = await fixture(t); await f.complete('B')
  const before = await f.query('task.get', { taskId: 'B' })
  await assert.rejects(f.command('task.supplement', { taskId: 'B', messageId: 'continue', text: '继续原目标',
    expectedRequirementRevision: 1, expectedControlRevision: 1 }), { code: 'DYNAMIC_TASK_NOT_ACTIVE' })
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), before)
})

for (const reason of ['later-stage', 'clarification-answer']) test(`new ${reason} reaches the existing Owner and execution without touching another Task`, async t => {
  const f = await fixture(t), binding = await f.owner('B')
  const originalA = await f.query('task.get', { taskId: 'A' }), originalWakes = await f.query('wake.list', { taskId: 'A' })
  const execution = (await f.command('execution.dispatch', { binding, key: 'old', prompt: 'old B', input: {}, resourceKeys: [] })).result.execution
  await f.command('execution.claim', { executionId: execution.id })
  await f.command('source.record', { sourceId: reason, groupId: 'g', messageId: reason, actorId: 'u',
    text: reason === 'later-stage' ? '增加验收阶段' : '明确B的验收要求', channel: 'im' })
  const args = { taskId: 'B', messageId: reason, text: reason, sourceRefs: [reason],
    expectedRequirementRevision: 1, expectedControlRevision: 1 }
  await f.command('task.supplement', args, reason)
  assert.equal((await f.command('task.supplement', args, reason)).replayed, true)
  const b = await f.query('task.get', { taskId: 'B' }), current = await f.query('execution.get', { executionId: execution.id })
  assert.equal(b.contextRevision, 1); assert.deepEqual(b.sourceRefs, [reason]); assert.equal(b.sessionId, binding.sessionId)
  assert.equal(current.cancelRequested, false); assert.equal(current.feedback.length, 1)
  assert.deepEqual(current.feedback.map(item => item.text), [reason])
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), originalA)
  assert.deepEqual(await f.query('wake.list', { taskId: 'A' }), originalWakes)
})
