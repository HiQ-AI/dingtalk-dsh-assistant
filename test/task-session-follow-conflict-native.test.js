import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, waitUntil } from './fixtures/task-session-native-host.js'
import { createTaskSessions } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { installTaskSessionPersistence } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

test('official session follow reads a cold Host-owned task without acquiring its writer and the Host resumes next lease', { ...({ skip: !available ? reason : false, timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-follow-conflict-'))
  const h = await nativeTaskHost(root, async () => [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '原统筹等待执行结果', evidence: [], limitations: [] } } }], { resident: true })
  await t.beginBusiness()

  const cwd = join(root, 'tasks', 'task-follow'); await t.step(async () => mkdir(cwd, { recursive: true }))
  const persistence = await t.step(async () => installTaskSessionPersistence(h.ctx, { root }))
  const manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd,
    registerPersistence: value => persistence.register(value), withPersistenceWriter: (binding, action) => persistence.runOwned(binding, action) })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const run = (leaseEpoch, sessionBound) => manager.run({ binding: { kind: 'task-session', taskId: 'task-follow', sessionId: 'follow-owner', leaseEpoch, sessionBound },
    provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', input: { task: { title: '原任务', objective: '继续原任务' }, wakes: [] },
    onSessionBound: async () => {}, submit: async () => ({ accepted: true }) })
  assert.equal((await t.step(async () => run(1, false))).status, 'submitted')
  assert.equal(h.ctx.agents.get('follow-owner'), undefined)
  const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')))
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  const queryModule = await t.step(async () => import(pathToFileURL(native.resolve('@deepseek-ai/dsh-session-query')).href))
  await t.step(async () => h.ctx.plugin(queryModule.default ?? queryModule))
  const registryModule = await t.step(async () => import(pathToFileURL(native.resolve('@deepseek-ai/dsh-typert-registry')).href))
  await t.step(async () => h.ctx.plugin(registryModule.default ?? registryModule))
  const modulePath = native.resolve('@deepseek-ai/dsh-api-session-controller'), moduleRoot = dirname(modulePath)
  const { SessionController } = await t.step(async () => import(pathToFileURL(modulePath).href))
  const { ApiSessionAgentController } = await t.step(async () => import(pathToFileURL(join(moduleRoot, 'types', 'agent.js')).href))
  const { SessionHistoryController } = await t.step(async () => import(pathToFileURL(join(moduleRoot, 'types', 'history.js')).href))
  const { installModelSelectionProjection } = await t.step(async () => import(pathToFileURL(join(moduleRoot, 'types', 'model-selection-projection.js')).href))
  installModelSelectionProjection(h.ctx)
  // Invoke the production follow/promote methods directly, avoiding unrelated RPC/file-upload/UI constructor dependencies.
  const receiver = { ctx: h.ctx, agents: new ApiSessionAgentController(h.ctx), promotions: new Set() }
  const diagnostics = []
  h.ctx.on('api-session/error', (_id, message) => diagnostics.push(message))
  receiver.promote = observation => { diagnostics.push('promote'); return SessionController.prototype.promote.call(receiver, observation) }
  receiver.history = new SessionHistoryController(h.ctx, observation => receiver.promote(observation))
  const controller = new AbortController()
  const stream = SessionController.prototype.follow.call(receiver, { address: { kind: 'session', sessionId: 'follow-owner' } }, controller.signal)
  const snapshot = await t.step(async () => stream.next())
  assert.equal(snapshot.value.type, 'snapshot')
  const next = stream.next().catch(() => ({ done: true }))
  await t.step(async () => waitUntil(() => diagnostics.some(message => message.includes('TASK_SESSION_HOST_WRITER_REQUIRED')), 'follow promotion rejected by Host writer ownership'))
  await t.step(async () => Promise.allSettled([...receiver.promotions]))
  assert.equal(h.ctx.agents.get('follow-owner'), undefined)
  assert.equal(h.ctx.sessions.get('follow-owner'), undefined)
  assert.equal((await t.step(async () => run(2, true))).status, 'submitted')
  const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, 'follow-owner'))
  assert.deepEqual([...new Set(log.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).map(event => event.data.source.taskSession.leaseEpoch))], [1,2])
  assert.equal(h.requests.length, 2)
  controller.abort(); await t.step(async () => next); await t.step(async () => stream.return())
}))
