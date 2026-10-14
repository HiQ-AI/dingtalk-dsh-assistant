import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { available, reason, nativeTaskHost } from './fixtures/task-session-native-host.js'
import { createTaskSessions, isTaskProviderTransient } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { registerTaskSessionPersistence } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { taskWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
const overloaded = { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: {"clientRequestId":"fixture","httpStatus":200}]' }
const decision = { action: 'wait', summary: '保留原任务继续处理', evidence: [], limitations: [] }

test('task provider transient classifier only accepts the exact verified provider errors', () => {
  assert.ok(isTaskProviderTransient(overloaded))
  assert.ok(isTaskProviderTransient({ code: 'TRANSPORT', message: 'fetch failed' }))
  for (const value of [{ ...overloaded, code: 'OTHER' }, { ...overloaded, message: 'overloaded' }, { code: 'TRANSPORT', message: 'permission denied' }, { code: 'PI_AI_ERROR', message: 'Codex error: invalid account' }]) assert.equal(isTaskProviderTransient(value), false)
})

for (const trailing of [false, true]) test(`native owner provider error keeps the same session and submitted decisions take priority: trailing=${trailing}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-native-'))
  const h = await nativeTaskHost(root, async () => [], { resident: true })
  const cwd = join(root, 'tasks', 'task-provider'); await mkdir(cwd, { recursive: true })
  const manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  let requests = 0, submitted = 0
  class Provider extends LlmAdapter {
    async *stream() {
      requests++
      if (requests === 1 && !trailing) { yield { type: 'finish', reason: { kind: 'error', failure: overloaded } }; return }
      const args = JSON.stringify({ decision })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'submit-' + requests, name: 'task_session_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'submit-' + requests, name: 'task_session_submit', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['task-provider-fixture'], new Provider())
  const binding = { kind: 'task-session', taskId: 'task-provider', sessionId: 'provider-session', leaseEpoch: 1, sessionBound: false }
  const run = extra => manager.run({ binding: { ...binding, ...extra }, input: { task: { title: '原任务', objective: '继续原任务' } }, provider: 'task-provider-fixture', model: 'fixture',
    agentPreset: 'native-test', onSessionBound: async () => {
      if (!trailing) return
      const session = h.ctx.sessions.get(binding.sessionId), snapshot = session.snapshotEvents.bind(session)
      session.snapshotEvents = () => {
        const events = snapshot()
        return events.some(event => event.type === 'turn/end') ? [...events, { type: 'turn/end', seq: events.at(-1).seq + 1,
          data: { reason: { kind: 'error', error: overloaded } } }] : events
      }
    }, submit: async () => { submitted++; return { accepted: true } } })
  if (!trailing) {
    await assert.rejects(run(), error => error.code === 'TASK_SESSION_PROVIDER_TRANSIENT' && error.providerError.code === 'PI_AI_ERROR')
    assert.equal(submitted, 0)
    assert.equal((await run({ leaseEpoch: 2, sessionBound: true })).status, 'submitted')
    const log = await inspectSession(h.ctx.sessionPersistence, binding.sessionId)
    assert.equal(log.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
    assert.deepEqual([...new Set(log.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).map(event => event.data.source.taskSession.leaseEpoch))], [1, 2])
  } else {
    assert.equal((await run()).status, 'submitted')
  }
  assert.equal(submitted, 1)
})

async function providerServiceHost(root, { legacyNoSubmission = false, transient = true, failFirst = true, initialize = true } = {}) {
  let requests = 0
  const h = await nativeTaskHost(root, async () => [], { initialize, config: { retryIntervalMs: 100 }, agentConfig: { provider: 'service-provider-fixture' },
    serviceFactory: async options => {
      class Provider extends LlmAdapter {
        async *stream() {
          requests++
          if (failFirst && requests === 1) {
            yield { type: 'finish', reason: { kind: 'error', failure: transient ? overloaded : { code: 'PI_AI_ERROR', message: 'Invalid account configuration' } } }; return
          }
          const args = JSON.stringify({ decision: { ...decision, action: 'complete' } })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: 'service-submit-' + requests, name: 'task_session_submit', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'service-submit-' + requests, name: 'task_session_submit', arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
      }
      options.ctx.llm.registerAdapter(['service-provider-fixture'], new Provider())
      if (legacyNoSubmission) {
        const manager = createTaskSessions({ ctx: options.ctx, isCurrent: async () => true,
          getWorkspaceDir: ({ binding }) => taskWorkspace(root, binding.taskId),
          registerPersistence: value => registerTaskSessionPersistence(options.ctx, value) })
        options.taskSessions = { ...manager, async run(args) {
          try { return await manager.run(args) }
          catch (error) { if (error.code === 'TASK_SESSION_PROVIDER_TRANSIENT') return { status: 'no_submission' }; throw error }
        } }
      }
      return openTaskSessionService(options)
    } })
  return Object.assign(h, { providerRequests: () => requests })
}

test('service retries a transient native owner with its claimed wake and same session after cooldown', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-service-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const h = await providerServiceHost(root); hosts.push(h)
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'provider-once', objective: 'continue the same native task' })
  await h.service.whenIdle()
  const first = await h.query('task.get', { taskId: task.taskId })
  assert.equal(first.lastDecision?.action === 'blocked', false)
  assert.equal(h.providerRequests(), 1)
  assert.ok((await h.query('wake.list', { taskId: task.taskId })).some(wake => wake.state === 'claimed'))
  const failure = (await h.service.recover()).failures.find(item => item.id === task.taskId)
  assert.equal(failure.code, 'TASK_SESSION_PROVIDER_TRANSIENT')
  await new Promise(resolve => setTimeout(resolve, Math.max(0, failure.retryAfter - Date.now()) + 20))
  await h.service.recover(); await h.service.whenIdle()
  const completed = await h.query('task.get', { taskId: task.taskId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, first.sessionId)
  assert.equal(completed.leaseEpoch, 2)
  assert.equal(h.providerRequests(), 2)
  assert.equal((await h.query('execution.list')).length, 0)
  assert.equal((await h.query('notification.list')).length, 0)
})

for (const transient of [true, false]) test(`restart recovers only a legacy acknowledged no-submission with exact transient native proof: ${transient}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-legacy-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const first = await providerServiceHost(root, { legacyNoSubmission: true, transient }); hosts.push(first)
  const created = await first.service.createTask({ groupId: 'native-group', requestId: 'legacy-provider', objective: 'resume preserved original task' })
  await first.service.whenIdle()
  const blocked = await first.query('task.get', { taskId: created.taskId })
  assert.equal(blocked.lastDecision.action, 'blocked')
  assert.ok(blocked.lastDecision.limitations.includes('TASK_SESSION_NO_SUBMISSION'))
  assert.ok((await first.query('wake.list', { taskId: created.taskId })).every(wake => wake.state === 'acked'))
  await first.close()
  const next = await providerServiceHost(root, { initialize: false, failFirst: false }); hosts.push(next)
  await next.service.recover(); await next.service.whenIdle()
  const restored = await next.query('task.get', { taskId: created.taskId })
  assert.equal(restored.sessionId, blocked.sessionId)
  assert.equal(restored.status, transient ? 'completed' : 'active')
  assert.equal(next.providerRequests(), transient ? 1 : 0)
  assert.equal((await next.query('task.list')).length, 1)
  assert.equal((await next.query('execution.list')).length, 0)
  assert.equal((await next.query('notification.list')).length, 0)
})
