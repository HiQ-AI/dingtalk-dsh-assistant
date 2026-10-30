import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-correction-'))
  const config = { dbPath: join(root, 'tasks.db'), instanceId: 'artifact-correction', initialize: true, webActorId: options.permission ? 'operator' : 'u' }
  let store = await openDynamicTaskStore(config)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = randomUUID()) => store.command({ id, kind, args: JSON.parse(JSON.stringify(args)) })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const sourceId = 'original'
  await command('source.record', { sourceId, groupId: 'g', messageId: 'real-message', actorId: 'u', text: 'A then B then C', timestamp: '2026-10-24T00:00:00Z', channel: 'dingtalk' })
  const coordinationId = 'coordination-correction'
  const members = ['A', 'B', 'C'].map((taskId, index) => ({ id: `member-${taskId}`, taskId, coordinationId,
    state: index ? 'pending' : 'applied', control: 'active', dependencies: index ? [['A'], ['B']][index - 1] : [] }))
  for (const { taskId } of members) await command('task.create', { taskId, groupId: 'g', ownerActorId: 'u',
    request: taskId, sourceRefs: [sourceId], requirements: ['original output constraint'] })
  if (!options.permission) {
    // The retained artifact contract reads an existing team's historical binding;
    // current releases must never recreate it through a retired coordination command.
    await store.close()
    const db = new DatabaseSync(config.dbPath)
    try {
      db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
      db.prepare('INSERT INTO dynamic_coordination(id,body) VALUES (?,?)').run(coordinationId,
        JSON.stringify({ id: coordinationId, groupId: 'g', state: 'active', revision: 1, memberIds: members.map(item => item.id), history: [] }))
      for (const member of members) db.prepare('INSERT INTO dynamic_coordination_members(id,body) VALUES (?,?)').run(member.id, JSON.stringify(member))
    } finally { db.close() }
    store = await openDynamicTaskStore({ ...config, initialize: false })
  }
  const taskId = members[0].taskId, binding = (await command('task.claim', { taskId })).result.binding
  let execution
  if (options.permission) {
    execution = (await command('execution.dispatch', { binding, key: 'publish', prompt: '原发布', definition: { executionBackend: options.backend ?? 'dsh' } })).result.execution
    const executionBinding = (await command('execution.claim', { executionId: execution.executionId })).result.binding
    if (options.operation) await command('operation.prepare', { binding: executionBinding, key: 'pending', definition: { toolName: 'pwsh' } })
    await command('execution.result', { binding: executionBinding, output: { status: 'blocked' } })
    if (!options.undrained) await command('execution.drained', { binding: executionBinding })
  }
  await command('task.wait', { binding, action: 'blocked', summary: 'sandbox startup failed', question: 'repair exact root', humanRequest: { requestId: 'help', audience: 'operator', reason: 'repair', attemptedActions: [] } })
  await command('task.drained', { binding })
  const before = await query('task.list'), graph = options.permission ? null : await query('coordination.get', { coordinationId })
  const otherWakes = await query('wake.list')
  const correction = { coordinationId, revision: 1, artifactRoot: join(root, 'tasks', coordinationId, 'outputs'), reason: 'Use the formal unified team artifact root', actorId: 'u' }
  async function respond(value = correction, overrides = {}) {
    const id = 'technical-' + randomUUID()
    await command('source.record', { sourceId: id, groupId: 'g', messageId: id, actorId: overrides.actorId ?? 'u', text: 'User requires the formal unified root; other requirements and dependencies unchanged.', timestamp: '', channel: overrides.channel ?? 'web', requestIdentity: overrides.missingProof ? {} : { artifactScopeCorrection: value } })
    return command('task.human.respond', { taskId, requestId: 'help', sourceId: id, expectedRequirementRevision: 1, expectedControlRevision: 1, artifactScopeCorrection: value })
  }
  return { store, command, query, before, graph, correction, respond, taskId, members, coordinationId, execution, otherWakes }
}

for (const variant of ['valid', 'wrong-actor', 'untrusted-operator', 'stale-input', 'private', 'missing-source', 'unknown-mode', 'undrained', 'claude', 'operation', 'stale-task']) test(`execution permission correction atomically validates ${variant}`, async t => {
  const f = await fixture(t, { permission: true, backend: variant === 'claude' ? 'claude-code' : 'dsh', undrained: variant === 'undrained', operation: variant === 'operation' })
  const permission = { executionId: f.execution.executionId, expectedInputVersion: variant === 'stale-input' ? 2 : 1,
    mode: variant === 'unknown-mode' ? 'all' : 'danger-full-access', reason: '恢复原发布', actorId: variant === 'wrong-actor' ? 'other' : variant === 'untrusted-operator' ? 'u' : 'operator', requirementRevision: 1, controlRevision: 1 }
  const source = { sourceId: 'permission-source', groupId: 'g', messageId: 'permission-source', actorId: variant === 'untrusted-operator' ? 'u' : 'operator', text: '恢复原发布成员原生完整权限', timestamp: '',
    channel: variant === 'private' ? 'private' : 'web', requestIdentity: { humanRequestId: 'help', ...(variant === 'missing-source' ? {} : { executionPermissionCorrection: permission }) } }
  const args = { taskId: f.taskId, requestId: 'help', sourceId: source.sourceId, source, expectedRequirementRevision: variant === 'stale-task' ? 2 : 1, expectedControlRevision: 1, executionPermissionCorrection: permission }
  const before = await f.query('execution.get', { executionId: f.execution.executionId }), wakes = await f.query('wake.list')
  if (variant !== 'valid') {
    await assert.rejects(f.command('task.human.respond', args, 'permission-reply'))
    assert.deepEqual(await f.query('execution.get', { executionId: f.execution.executionId }), before)
    assert.deepEqual(await f.query('wake.list'), wakes)
    assert.equal(await f.query('source.get', { sourceId: source.sourceId }), null)
    assert.equal((await f.query('task.get', { taskId: f.taskId })).humanRequests[0].status, 'waiting-reply')
    return
  }
  await f.command('task.human.respond', args, 'permission-reply')
  assert.notEqual((await f.query('task.get', { taskId: f.taskId })).ownerActorId, source.actorId)
  const after = await f.query('execution.get', { executionId: f.execution.executionId })
  assert.deepEqual(after.permissionCorrection, { ...permission, sourceId: source.sourceId, recordedAt: after.permissionCorrection.recordedAt })
  for (const key of ['sessionId', 'inputVersion', 'requirementRevision', 'controlRevision', 'status', 'results']) assert.deepEqual(after[key], before[key])
  assert.equal((await f.command('task.human.respond', args, 'permission-reply')).replayed, true)
  await assert.rejects(f.command('task.human.respond', { ...args, executionPermissionCorrection: { ...permission, mode: 'read-only' } }, 'permission-reply'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
})

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
  for (const member of f.members.slice(1)) assert.deepEqual(await f.query('wake.list', { taskId: member.taskId }),
    f.otherWakes.filter(wake => wake.taskId === member.taskId))
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
