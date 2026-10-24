import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinationArtifactScope, bindTaskArtifactScope, resolveTaskArtifactScope, assertTaskArtifactScopePresent } from '../packages/dingtalk-dsh-assistant/task-artifact-scope.js'
import { taskWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-policy-'))
  const bindings = new Map()
  const policy = {
    bindArtifactRoot(session, value) {
      const binding = { ...value, sessionCwd: session.header.cwd }
      const previous = bindings.get(session.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw Object.assign(new Error('changed'), { code: 'BINDING_CHANGED' })
      bindings.set(session.id, binding)
      return binding
    },
    resolve({ session, mode = 'workspace-write' } = {}) {
      const binding = session && bindings.get(session.id)
      return { mode, sessionId: session?.id, workspaceRoot: binding?.artifactRoot ?? session?.header.cwd ?? root }
    },
  }
  t.after(() => rm(root, { recursive: true, force: true }))
  const scope = await coordinationArtifactScope(root, { coordinationId: 'coordination-one', memberTaskIds: ['task-a', 'task-b', 'task-c'] })
  const sessions = []
  for (const taskId of scope.memberTaskIds) {
    const session = { id: 'session-' + taskId, header: { cwd: await taskWorkspace(root, taskId) } }
    await bindTaskArtifactScope({ sandboxPolicy: policy, tools: { guard: () => {} } }, { root, scope, taskId, session })
    sessions.push(session)
  }
  return { root, policy, bindings, scope, sessions }
}


test('one trusted coordination binds the same root while preserving native session cwd', async t => {
  const f = await fixture(t)
  for (const session of f.sessions) {
    const resolved = f.policy.resolve({ session })
    assert.equal(resolved.workspaceRoot, f.scope.artifactRoot)
    assert.equal(resolved.sessionId, session.id)
    assert.equal(resolved.mode, 'workspace-write')
    assert.notEqual(session.header.cwd, resolved.workspaceRoot)
    assert.equal(f.policy.resolve({ session, mode: 'read-only' }).mode, 'read-only')
  }
  assert.equal(f.policy.resolve({ session: { id: 'other', header: { cwd: f.root } } }).workspaceRoot, f.root)
})

test('binding rejects foreign tasks, arbitrary roots and changed sessions', async t => {
  const f = await fixture(t), session = f.sessions[0]
  await assert.rejects(bindTaskArtifactScope({ sandboxPolicy: f.policy, tools: { guard: () => {} } }, { root: f.root, scope: f.scope, taskId: 'foreign', session }), { code: 'TASK_ARTIFACT_BINDING_INVALID' })
  const next = await coordinationArtifactScope(f.root, { coordinationId: 'coordination-two', memberTaskIds: ['task-a'] })
  await assert.rejects(bindTaskArtifactScope({ sandboxPolicy: f.policy, tools: { guard: () => {} } }, { root: f.root, scope: next, taskId: 'task-a', session }), { code: 'BINDING_CHANGED' })
  assert.equal(await resolveTaskArtifactScope({ root: f.root, task: { taskId: 'task-a', groupId: 'missing' }, query: async () => [] }), null)
})

test('cancelled arrangements cannot drop a durable native artifact binding and fall back to full access', async t => {
  const f = await fixture(t)
  const ctx = { sandboxPolicy: f.policy, sessionProjections: { stateOf: session => f.bindings.get(session.id) } }
  assert.throws(() => assertTaskArtifactScopePresent(ctx, f.sessions[0], null), { code: 'TASK_ARTIFACT_PERSISTED_SCOPE_REQUIRES_REVIEW' })
  assert.doesNotThrow(() => assertTaskArtifactScopePresent(ctx, f.sessions[0], f.scope))
  assert.doesNotThrow(() => assertTaskArtifactScopePresent(ctx, { id: 'unbound' }, null))
})

test('all team members receive the same authenticated correction source without changing their Task versions', async t => {
  const f = await fixture(t)
  const sourceId = 'web:correction', actorId = 'operator'
  const correction = { coordinationId: f.scope.coordinationId, revision: 1, artifactRoot: f.scope.artifactRoot, reason: '只纠正测试产物布局', actorId }
  const coordination = { id: f.scope.coordinationId, revision: 1, state: 'active', artifactScopeCorrection: { ...correction, sourceId, recordedAt: '2026-10-24T00:00:00Z' } }
  const tasks = f.scope.memberTaskIds.map(taskId => ({ taskId, groupId: 'group', ownerActorId: actorId, requirementRevision: 1, contextRevision: 0 }))
  const query = async (kind, args) => kind === 'coordination.list' ? [coordination] : kind === 'coordination.get'
    ? { members: tasks.map(task => ({ taskId: task.taskId, state: 'ready' })) }
    : kind === 'coordination.schedule.list' ? [] : kind === 'task.get' ? tasks.find(task => task.taskId === args.taskId)
    : { sourceId, actorId, channel: 'web', requestIdentity: { artifactScopeCorrection: correction } }
  for (const task of tasks) {
    const scope = await resolveTaskArtifactScope({ root: f.root, task, query })
    assert.equal(scope.artifactRoot, f.scope.artifactRoot)
    assert.deepEqual(scope.authorizationSource, { sourceId, actorId, recordedAt: '2026-10-24T00:00:00Z', reason: correction.reason })
    assert.equal(task.contextRevision, 0)
    assert.equal(task.requirementRevision, 1)
  }
  correction.actorId = 'foreign'
  await assert.rejects(resolveTaskArtifactScope({ root: f.root, task: tasks[0], query }), { code: 'TASK_ARTIFACT_CORRECTION_SOURCE_INVALID' })
})
