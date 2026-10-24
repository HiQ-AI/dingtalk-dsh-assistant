import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { freezeCoordinationMembers } from '../packages/dingtalk-dsh-assistant/coordination-task-commands.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-correction-'))
  const store = await openDynamicTaskStore({ dbPath: join(root, 'tasks.db'), instanceId: 'artifact-correction', initialize: true, webActorId: 'u' })
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ id, kind, args: JSON.parse(JSON.stringify(args)) })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const sourceId = 'original'
  await command('source.record', { sourceId, groupId: 'g', messageId: 'real-message', actorId: 'u', text: 'A then B then C', timestamp: '2026-10-24T00:00:00Z', channel: 'dingtalk' })
  const reserved = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'g', original: 'A then B then C', actorId: 'u', sourceRefs: [sourceId], reservationId: 'reservation', reservationGeneration: 1, sourceMessageId: 'real-message' })).result.source
  const proposal = { members: ['A', 'B', 'C'].map((key, index) => ({ action: 'new-task', creationKey: key,
    title: key, objective: key, requirements: ['original output constraint'], afterTaskIds: index ? [[ 'A' ], [ 'B' ]][index - 1] : [] })) }
  const coordinationId = 'coordination-correction'
  const members = freezeCoordinationMembers({ coordinationId, proposal, tasks: new Map(), source: { ...reserved, sourceId, groupId: 'g', actorId: 'u', unitRevision: 1 }, ownerActorId: 'u' })
  for (const member of members) member.requiresTrigger = false
  await command('coordination.accept', { coordinationId, sourceId: reserved.id, fence: reserved.fence, members })
  await command('coordination.apply', { instructionId: members[0].instructionId, expectedRevision: 1 })
  const taskId = members[0].taskId, binding = (await command('task.claim', { taskId })).result.binding
  await command('task.wait', { binding, action: 'blocked', summary: 'sandbox startup failed', question: 'repair exact root', humanRequest: { requestId: 'help', audience: 'operator', reason: 'repair', attemptedActions: [] } })
  await command('task.drained', { binding })
  const before = await query('task.list'), graph = await query('coordination.get', { coordinationId })
  const correction = { coordinationId, revision: 1, artifactRoot: join(root, 'tasks', coordinationId, 'outputs'), reason: 'Use the formal unified team artifact root', actorId: 'u' }
  async function respond(value = correction, overrides = {}) {
    const id = 'technical-' + randomUUID()
    await command('source.record', { sourceId: id, groupId: 'g', messageId: id, actorId: overrides.actorId ?? 'u', text: 'User requires the formal unified root; other requirements and dependencies unchanged.', timestamp: '', channel: overrides.channel ?? 'web', requestIdentity: overrides.missingProof ? {} : { artifactScopeCorrection: value } })
    return command('task.human.respond', { taskId, requestId: 'help', sourceId: id, expectedRequirementRevision: 1, expectedControlRevision: 1, artifactScopeCorrection: value })
  }
  return { store, command, query, before, graph, correction, respond, taskId, members, coordinationId }
}

test('trusted original technical reply records one team correction without completing or starting successors', async t => {
  const f = await fixture(t)
  await f.respond()
  const after = await f.query('task.list')
  for (const before of f.before) {
    const current = after.find(task => task.taskId === before.taskId)
    for (const key of ['sessionId', 'requirementRevision', 'controlRevision', 'contextRevision', 'runSequence', 'requirements', 'coordinationHold']) assert.deepEqual(current[key], before[key], key)
    assert.equal(current.status, 'active')
  }
  const state = await f.query('coordination.get', { coordinationId: f.coordinationId })
  assert.deepEqual(state.members, f.graph.members)
  assert.equal(state.coordination.artifactScopeCorrection.artifactRoot, f.correction.artifactRoot)
  assert.equal(state.coordination.history.at(-1).kind, 'artifact-scope-correction')
  assert.equal((await f.query('task.get', { taskId: f.taskId })).humanRequests[0].status, 'answered')
  assert.equal((await f.query('task.events')).events.length, 0)
  for (const member of f.members.slice(1)) assert.equal((await f.query('wake.list', { taskId: member.taskId })).length, 0)
})

for (const variant of ['wrong-owner', 'stale', 'outside-root', 'private', 'missing-source-proof']) test(`artifact correction rejects ${variant} and retains original graph`, async t => {
  const f = await fixture(t), input = structuredClone(f.correction)
  if (variant === 'wrong-owner') input.actorId = 'other'
  if (variant === 'stale') input.revision = 2
  if (variant === 'outside-root') input.artifactRoot = join(tmpdir(), 'outside')
  await assert.rejects(f.respond(input, variant === 'private' ? { channel: 'private' } : variant === 'missing-source-proof' ? { missingProof: true } : {}))
  assert.deepEqual(await f.query('coordination.get', { coordinationId: f.coordinationId }), f.graph)
  assert.equal((await f.query('task.get', { taskId: f.taskId })).humanRequests[0].status, 'waiting-reply')
})
