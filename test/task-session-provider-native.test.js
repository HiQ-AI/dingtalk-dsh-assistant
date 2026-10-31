import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { available, reason, nativeTaskHost, topicSummaryResponse, topicTaskCalls, waitUntil, latestInput } from './fixtures/task-session-native-host.js'
import { createTaskSessions, isTaskProviderTransient } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { installTaskSessionPersistence } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { taskWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
const overloaded = { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: {"clientRequestId":"fixture","httpStatus":200}]' }
const decision = { action: 'wait', summary: '保留原任务继续处理', evidence: [], limitations: [] }

test('task provider transient classifier only accepts the exact verified provider errors', () => {
  assert.ok(isTaskProviderTransient(overloaded))
  assert.ok(isTaskProviderTransient({ code: 'TRANSPORT', message: 'fetch failed' }))
  for (const value of [{ ...overloaded, code: 'OTHER' }, { ...overloaded, message: 'overloaded' }, { code: 'TRANSPORT', message: 'permission denied' }, { code: 'PI_AI_ERROR', message: 'Codex error: invalid account' }]) assert.equal(isTaskProviderTransient(value), false)
})

for (const trailing of [false, true]) test(`native owner provider error keeps the same session and submitted decisions take priority: trailing=${trailing}`, { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-native-'))
  const h = await nativeTaskHost(root, async () => [], { resident: true })
  await t.beginBusiness()

  const cwd = join(root, 'tasks', 'task-provider'); await t.step(async () => mkdir(cwd, { recursive: true }))
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
    await t.step(async () => assert.rejects(run(), error => error.code === 'TASK_SESSION_PROVIDER_TRANSIENT' && error.providerError.code === 'PI_AI_ERROR'))
    assert.equal(submitted, 0)
    assert.equal((await t.step(async () => run({ leaseEpoch: 2, sessionBound: true }))).status, 'submitted')
    const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, binding.sessionId))
    assert.equal(log.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
    assert.deepEqual([...new Set(log.events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).map(event => event.data.source.taskSession.leaseEpoch))], [1, 2])
  } else {
    assert.equal((await t.step(async () => run())).status, 'submitted')
  }
  assert.equal(submitted, 1)
}))

async function providerServiceHost(root, { legacyNoSubmission = false, transient = true, failFirst = true, initialize = true, failCount = 1, noSubmission = false } = {}) {
  let requests = 0
  const h = await nativeTaskHost(root, async () => [], { initialize, config: { retryIntervalMs: 100, provider: 'service-provider-fixture' }, agentConfig: { provider: 'service-provider-fixture' },
    serviceFactory: async options => {
      class Provider extends LlmAdapter {
        resolveModel(provider, model) { return { provider, id: model, name: model,
          reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' } } }
        async *stream(request) {
          if (yield* topicSummaryResponse(request, h.auxiliaryRequests)) return
          if (noSubmission && !request.tools.some(tool => tool.name === 'task_session_submit')) {
            const input = latestInput(request), args = JSON.stringify({ requestId: input.requestId, topicId: input.topicId, title: '核对任务技术恢复' })
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'title-' + input.requestId, name: 'group_topic_title_submit', arguments: args } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
          }
          requests++
          if (failFirst && requests <= failCount) {
            if (noSubmission) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
              yield { type: 'finish', reason: { kind: 'stop' } }; return
            }
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
        // The legacy-result adapter still uses today's real Host writer boundary.
        // Without runOwned it fails before any model turn, not at no-submission.
        const persistence = await installTaskSessionPersistence(options.ctx, { root })
        options.persistence = persistence
        const manager = createTaskSessions({ ctx: options.ctx, isCurrent: async () => true,
          withPersistenceWriter: (binding, action) => persistence.runOwned(binding, action),
          getWorkspaceDir: ({ binding }) => taskWorkspace(root, binding.taskId),
          registerPersistence: value => persistence.register(value) })
        options.taskSessions = { ...manager, async run(args) {
          try { return await manager.run(args) }
          catch (error) { if (error.code === 'TASK_SESSION_PROVIDER_TRANSIENT') return { status: 'no_submission' }; throw error }
        } }
      }
      return openTaskSessionService(options)
    } })
  return Object.assign(h, { providerRequests: () => requests })
}

test('stale owner no-submission drains and resumes the same session with the supplement without technical backoff', { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owner-stale-context-'))
  const evidence = join(root, 'evidence.txt')
  await t.beginBusiness()
  await t.step(async () => writeFile(evidence, 'verified existing artifact'))
  let h, injected = false, firstSession
  t.after(async () => { try { await h?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  h = await t.step(async () => nativeTaskHost(root, async request => {
    const topicCalls = topicTaskCalls(request); if (topicCalls) return topicCalls
    const input = latestInput(request)
    firstSession ??= input.task.sessionId
    assert.equal(input.task.sessionId, firstSession)
    if (!injected) return [{ name: 'read', args: { file_path: evidence } }]
    assert.equal((await h.query('task.get', { taskId: input.task.taskId })).contextRevision, 1)
    assert.ok(input.wakes.some(wake => wake.kind === 'task.supplement'))
    return [{ name: 'task_session_submit', args: { decision: { action: 'complete', summary: '已按补充核对已有证据', evidence: [evidence], limitations: [] } } }]
  }, { config: { retryIntervalMs: 60000 } }))
  h.ctx.on('tools/post-execute', async (exec, result, next) => {
    const outcome = await next()
    if (exec.name === 'read' && !result.isError && !injected) {
      injected = true
      const task = (await h.query('task.list'))[0]
      await h.service.store.command({ id: 'supplement-after-read', kind: 'task.supplement', args: { taskId: task.taskId,
        expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision,
        messageId: 'supplement-after-read', text: '只核对已有证据，不重复操作', request: task.request + '\n只核对已有证据，不重复操作' } })
    }
    return outcome
  })
  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'stale-owner', objective: '读取已有证据并确认结果' }))
  // 不调用 recover、不等待一分钟退避：原上下文排空后须由既有队列直接接续。
  await t.step(async () => h.service.whenIdle())
  const task = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(task.status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(task.sessionId, firstSession)
  assert.equal(task.leaseEpoch, 2)
  assert.equal(task.providerRecovery ?? null, null)
  assert.equal(h.toolResults.filter(result => result.name === 'read' && !result.result.isError).length, 1, '已成功读取不会在续办中重放')
  assert.ok((await t.step(async () => h.query('wake.list', { taskId: task.taskId }))).every(wake => wake.state === 'acked'))
  assert.deepEqual(h.service.listAlerts().filter(alert => alert.taskId === task.taskId), [])
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
  const events = (await t.step(async () => inspectSession(h.ctx.sessionPersistence, task.sessionId))).events
  assert.equal(events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.deepEqual(events.filter(event => event.type === 'user/message' && event.data.source?.taskSession).map(event => event.data.source.taskSession.leaseEpoch), [1, 2])
}))

test('service retries a transient native owner with its claimed wake and same session after cooldown', { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-service-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const h = await providerServiceHost(root);
  await t.beginBusiness()
 hosts.push(h)
  const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'provider-once', objective: 'continue the same native task' }))
  await t.step(async () => h.service.whenIdle())
  const first = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal(first.lastDecision?.action === 'blocked', false)
  assert.equal(h.providerRequests(), 1)
  assert.ok((await t.step(async () => h.query('wake.list', { taskId: task.taskId }))).some(wake => wake.state === 'claimed'))
  const failure = (await t.step(async () => h.service.recover())).failures.find(item => item.id === task.taskId)
  assert.equal(failure.code, 'TASK_SESSION_PROVIDER_TRANSIENT')
  await t.step(async () => new Promise(resolve => setTimeout(resolve, Math.max(0, failure.retryAfter - Date.now()) + 20)))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  const completed = await t.step(async () => h.query('task.get', { taskId: task.taskId }))
  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, first.sessionId)
  assert.equal(completed.leaseEpoch, 2)
  assert.equal(h.providerRequests(), 2)
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('notification.list'))).length, 0)
}))

for (const restart of [false, true]) test(`normal empty owner completion resumes automatically with the same session and wake: restart=${restart}`, { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-empty-owner-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  let h = await providerServiceHost(root, { noSubmission: true });
  await t.beginBusiness()
 hosts.push(h)
  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'empty-owner', objective: 'review retained results and submit a decision' }))
  await t.step(async () => h.service.whenIdle())
  const first = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.ok(first.providerRecovery)
  assert.equal(first.providerRecovery.failure.code, 'TASK_SESSION_NO_SUBMISSION')
  assert.equal(first.providerRecovery.failure.phase, 'decision')
  assert.equal(first.lastDecision?.action === 'blocked', false)
  assert.equal(first.drained, true)
  assert.equal(first.humanRequests.length, 0)
  const wakes = await t.step(async () => h.query('wake.list', { taskId: first.taskId }))
  assert.ok(wakes.some(wake => wake.state === 'claimed'))
  if (restart) {
    await t.step(async () => h.close())
    h = await t.step(async () => providerServiceHost(root, { initialize: false, failFirst: false })); hosts.push(h)
    assert.deepEqual((await t.step(async () => h.query('task.get', { taskId: first.taskId }))).providerRecovery, first.providerRecovery)
    await t.step(async () => h.service.recover())
  }
  // 不调用恢复接口或补充输入：由真实定时器到期自动续原会话。
  await t.step(async () => waitUntil(async () => (await h.query('task.get', { taskId: first.taskId })).status === 'completed', 'automatic empty decision recovery', 15000))
  await t.step(async () => h.service.whenIdle())
  const completed = await t.step(async () => h.query('task.get', { taskId: first.taskId }))
  assert.equal(completed.sessionId, first.sessionId)
  assert.equal(completed.leaseEpoch, 2)
  assert.equal(completed.providerRecovery, null)
  assert.equal(h.providerRequests(), restart ? 1 : 2)
  assert.deepEqual((await t.step(async () => h.query('wake.list', { taskId: first.taskId }))).map(wake => wake.id), wakes.map(wake => wake.id))
  assert.ok((await t.step(async () => h.query('wake.list', { taskId: first.taskId }))).every(wake => wake.state === 'acked'))
  const log = await t.step(async () => inspectSession(h.ctx.sessionPersistence, first.sessionId))
  assert.equal(log.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 0)
  assert.equal((await t.step(async () => h.query('notification.list'))).length, 0)
}))

for (const transient of [true, false]) test(`restart recovers only a legacy acknowledged no-submission with exact transient native proof: ${transient}`, { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-provider-legacy-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  await t.beginBusiness()
  const first = await t.step(async () => providerServiceHost(root, { legacyNoSubmission: true, transient })); hosts.push(first)
  const created = await t.step(async () => first.service.createTask({ groupId: 'native-group', requestId: 'legacy-provider', objective: 'resume preserved original task' }))
  await t.step(async () => first.service.whenIdle())
  const blocked = await t.step(async () => first.query('task.get', { taskId: created.taskId }))
  assert.equal(blocked.lastDecision.action, 'blocked')
  assert.ok(blocked.lastDecision.limitations.includes('TASK_SESSION_NO_SUBMISSION'))
  assert.ok((await t.step(async () => first.query('wake.list', { taskId: created.taskId }))).every(wake => wake.state === 'acked'))
  await t.step(async () => first.close())
  const next = await t.step(async () => providerServiceHost(root, { initialize: false, failFirst: false })); hosts.push(next)
  await t.step(async () => next.service.recover()); await t.step(async () => next.service.whenIdle())
  const restored = await t.step(async () => next.query('task.get', { taskId: created.taskId }))
  assert.equal(restored.sessionId, blocked.sessionId)
  assert.equal(restored.status, transient ? 'completed' : 'active')
  assert.equal(next.providerRequests(), transient ? 1 : 0)
  assert.equal((await t.step(async () => next.query('task.list'))).length, 1)
  assert.equal((await t.step(async () => next.query('execution.list'))).length, 0)
  assert.equal((await t.step(async () => next.query('notification.list'))).length, 0)
}))

for (const noSubmission of [false, true]) test(`owner technical failures have a durable bounded budget across leases and restart; later real input preserves a recovery entrance: noSubmission=${noSubmission}`, { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'owner-provider-budget-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  let h = await providerServiceHost(root, { failCount: 20, noSubmission });
  await t.beginBusiness()
 hosts.push(h)
  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'owner-budget', objective: 'Original task' }))
  await t.step(async () => h.service.whenIdle())
  const sessionId = (await t.step(async () => h.query('task.get', { taskId: created.taskId }))).sessionId
  for (let failure = 1; failure <= 7; failure++) {
    const task = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
    assert.equal(task.providerRecovery.attempts, failure)
    assert.equal(task.humanRequests.length, 0)
    if (failure === 7) break
    if (failure === 3) {
      await t.step(async () => h.close()); h = await t.step(async () => providerServiceHost(root, { initialize: false, failCount: 20, noSubmission })); hosts.push(h)
      const restored = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
      assert.deepEqual(restored.providerRecovery, task.providerRecovery)
    }
    t.mock.timers.setTime(Date.parse(task.providerRecovery.nextAttemptAt) + 1)
    await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  }
  const suspended = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(suspended.providerRecovery.suspended, true); assert.equal(suspended.providerRecovery.nextAttemptAt, null)
  const count = h.providerRequests()
  for (let tick = 0; tick < 4; tick++) { t.mock.timers.setTime(Date.now() + 3600000); await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle()) }
  assert.equal(h.providerRequests(), count)
  await t.step(async () => h.close()); h = await t.step(async () => providerServiceHost(root, { initialize: false, failFirst: false })); hosts.push(h)
  await t.step(async () => h.service.store.command({ id: 'actual-followup', kind: 'task.revise', args: { taskId: created.taskId, request: 'Actual new user followup after availability restored' } }))
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  const restored = await t.step(async () => h.query('task.get', { taskId: created.taskId }))
  assert.equal(restored.sessionId, sessionId); assert.equal(restored.status, 'completed'); assert.equal(restored.humanRequests.length, 0)
  assert.equal(h.providerRequests(), 1)
}))

for (const newInput of [true, false]) test(`owner recovery admission cannot hot-loop on non-provider runtime failure: newInput=${newInput}`, { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'owner-single-admission-')), hosts = []
  t.after(async () => { for (const h of hosts.toReversed()) await h.close(); await rm(root, { recursive: true, force: true }) })
  const h = await providerServiceHost(root, { failFirst: false });
  await t.beginBusiness()
 hosts.push(h)
  // Establish the suspended state through real Host commands, not a patched database.
  await t.step(async () => h.service.store.command({ id: 'create-suspended', kind: 'task.create', args: { taskId: 'suspended', groupId: 'native-group', request: 'Original task' } }))
  for (let attempt = 1; attempt <= (newInput ? 7 : 1); attempt++) {
    const binding = (await t.step(async () => h.service.store.command({ id: 'claim-' + attempt, kind: 'task.claim', args: { taskId: 'suspended' } }))).result.binding
    await t.step(async () => h.service.store.command({ id: 'provider-' + attempt, kind: 'task.provider-failure', args: { binding, failure: { code: 'TASK_SESSION_PROVIDER_TRANSIENT', providerError: overloaded } } }))
    await t.step(async () => h.service.store.command({ id: 'drain-' + attempt, kind: 'task.drained', args: { binding } }))
    if (attempt < (newInput ? 7 : 1)) t.mock.timers.setTime(Date.parse((await t.step(async () => h.query('task.get', { taskId: 'suspended' }))).providerRecovery.nextAttemptAt) + 1)
  }
  if (newInput) await t.step(async () => h.service.store.command({ id: 'new-input', kind: 'task.revise', args: { taskId: 'suspended', request: 'Actual new user input' } }))
  else t.mock.timers.setTime(Date.parse((await t.step(async () => h.query('task.get', { taskId: 'suspended' }))).providerRecovery.nextAttemptAt) + 1)
  let admissions = 0
  const agents = h.ctx.agents, originalCreate = agents.create.bind(agents)
  agents.create = () => { admissions++; throw Object.assign(new Error('Injected native persistence/create fault'), { code: 'TEST_NON_PROVIDER_RUNTIME' }) }
  t.after(() => { agents.create = originalCreate })
  await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle())
  assert.equal(admissions, 1)
  for (let tick = 0; tick < 4; tick++) { await t.step(async () => h.service.recover()); await t.step(async () => h.service.whenIdle()) }
  assert.equal(admissions, 1)
  const current = await t.step(async () => h.query('task.get', { taskId: 'suspended' }))
  assert.equal(current.providerRecovery.requirementRevision, newInput ? 2 : 1)
  assert.equal(current.providerRecovery.suspended, true)
  assert.equal(current.providerRecovery.admission.kind, newInput ? 'new-input' : 'scheduled')
  assert.equal(h.providerRequests(), 0)
}))
