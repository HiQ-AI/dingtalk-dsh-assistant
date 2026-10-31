import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'
import { createTaskSessions, taskSessionModelSelection } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

test('task model defaults and explicit selection preserve the execution selection', () => {
  const execution = { provider: 'native-task-test', model: 'controlled', reasoningEffort: 'high' }
  for (const value of [undefined, '', '  ']) assert.deepEqual(taskSessionModelSelection(execution, value), { ...execution, provider: 'openai-codex', model: 'gpt-6-astra' })
  assert.deepEqual(taskSessionModelSelection(execution, '  explicit-model  '), { ...execution, provider: 'openai-codex', model: 'explicit-model' })
  assert.equal(taskSessionModelSelection(execution, 'astra').model, 'astra', 'no guessed alias resolution')
  for (const value of [null, false, 1, {}, []]) assert.throws(() => taskSessionModelSelection(execution, value), { code: 'TASK_SESSION_MODEL_INVALID' })
  assert.deepEqual(taskSessionModelSelection(execution, 'custom', '  explicit-provider  '), { ...execution, provider: 'explicit-provider', model: 'custom' })
  for (const value of [null, false, 1, {}, []]) assert.throws(() => taskSessionModelSelection(execution, undefined, value), { code: 'TASK_SESSION_PROVIDER_INVALID' })
  assert.equal(execution.model, 'controlled')
})

test('native create and resume use the current exact task model on the original session; missing model never creates or resumes',
  { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'task-model-native-'))
    const h = await nativeTaskHost(root, async () => [{ name: 'task_session_submit', args: {
      decision: { action: 'wait', summary: '等待原任务', evidence: [], limitations: [] },
    } }], { resident: true })
    await t.beginBusiness()

    const cwd = join(root, 'tasks', 'model-task'); await t.step(async () => mkdir(cwd, { recursive: true }))
    const manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
    t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
    const originalResolve = h.ctx.llm.resolveCallConfig.bind(h.ctx.llm), resolutions = []
    h.ctx.llm.resolveCallConfig = async (config, signal) => {
      const { provider, model } = config
      resolutions.push([provider, model])
      if (model === 'missing') throw new Error('fixture unknown exact model')
      return originalResolve(config, signal)
    }
    let bound = 0
    const run = (model, leaseEpoch, sessionBound = true, sessionId = 'original-model-session', provider = 'native-task-test', reasoningEffort) => manager.run({
      binding: { kind: 'task-session', taskId: 'model-task', sessionId, leaseEpoch, sessionBound },
      provider, model, reasoningEffort, agentPreset: 'native-test', input: { task: { title: '原任务', objective: '核对模型' }, wakes: [] },
      onSessionBound: async () => { bound++ }, submit: async () => ({ accepted: true }),
    })
    assert.equal((await t.step(async () => run('controlled', 1, false))).status, 'submitted')
    assert.equal((await t.step(async () => run('gpt-6-astra', 2))).status, 'submitted')
    assert.equal((await t.step(async () => run('explicit-model', 3))).status, 'submitted')
    assert.deepEqual(h.requests.map(request => request.model), ['controlled', 'gpt-6-astra', 'explicit-model'])
    const before = await t.step(async () => inspectSession(h.ctx.sessionPersistence, 'original-model-session'))
    assert.equal(before.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
    for (const [sessionId, stored] of [['original-model-session', true], ['never-created', false]]) {
      await t.step(async () => assert.rejects(run('missing', 4, stored, sessionId), { code: 'TASK_SESSION_MODEL_UNAVAILABLE' }))
    }
    await t.step(async () => assert.rejects(run('controlled', 4, true, 'original-model-session', 'missing-provider'), { code: 'TASK_SESSION_MODEL_UNAVAILABLE' }))
    await t.step(async () => assert.rejects(run('controlled', 4, true, 'original-model-session', 'native-task-test', 'high'), { code: 'TASK_SESSION_REASONING_EFFORT_UNSUPPORTED' }))
    assert.equal(bound, 3); assert.equal(h.requests.length, 3)
    assert.deepEqual((await t.step(async () => inspectSession(h.ctx.sessionPersistence, 'original-model-session'))).events, before.events)
    assert.equal(h.ctx.sessions.get('never-created'), undefined)
    assert.ok(resolutions.some(([,model]) => model === 'missing'))
  }))

for (const configured of [undefined, 'explicit-owner']) test(`native service isolates task model from delegated execution: ${configured ?? 'old config'}`,
  { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'task-model-service-'))
    let h, delegated = false
    t.after(async () => { try { await h?.close() } finally { await rm(root, { recursive: true, force: true }) } })
    await t.beginBusiness()
    h = await t.step(async () => nativeTaskHost(root, async request => {
      const call = (name, args) => ({ name, args })
      if (request.tools.some(tool => tool.name === 'task_delegate')) {
        const input = latestInput(request)
        const done = input.executions.some(item => item.status === 'succeeded' && item.drained)
        const calls = delegated ? [] : [call('task_delegate', { key: 'model-proof', objective: '核对独立执行模型' })]
        delegated = true
        return [...calls, call('task_session_submit', { decision: { action: done ? 'complete' : 'wait', summary: '核对实际结果', evidence: [], limitations: [] } })]
      }
      return [call('execution_submit', { output: { status: 'completed', summary: '已核对', evidence: [], limitations: [], artifacts: [] } })]
    }, { config: { provider: configured === undefined ? undefined : 'explicit-provider', ...(configured === undefined ? {} : { model: configured }) },
      modelProviders: ['native-task-test', 'openai-codex', 'explicit-provider'] }))
    const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'model-isolation', objective: '核对统筹与执行模型' }))
    await t.step(async () => h.service.whenIdle())
    assert.equal((await t.step(async () => h.query('task.get', { taskId: task.taskId }))).status, 'completed', JSON.stringify(h.service.listAlerts()))
    const owners = h.requests.filter(request => request.tools.some(tool => tool.name === 'task_delegate'))
    const executions = h.requests.filter(request => request.tools.some(tool => tool.name === 'execution_submit'))
    assert.ok(owners.length >= 2, 'includes resume after execution completion')
    assert.ok(owners.every(request => request.model === (configured ?? 'gpt-6-astra') && request.provider === (configured === undefined ? 'openai-codex' : 'explicit-provider')))
    assert.ok(executions.length > 0)
    assert.ok(executions.every(request => request.model === 'controlled' && request.provider === 'native-task-test'))
  }))
