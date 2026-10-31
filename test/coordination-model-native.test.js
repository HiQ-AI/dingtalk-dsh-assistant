import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

// Independent planning was removed. Model isolation remains a current contract:
// configuration affects later Topic requests, never an in-flight request or the Owner selection.
test('native Loader model changes affect the next Topic session while active requests and Owner selection stay fixed',
  { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'topic-model-native-'))
    const release = Promise.withResolvers()
t.onCancel(() => release.resolve())

    let h, runtime, held = false, delegated = false
    t.after(async () => { release.resolve(); await h?.service?.close(); if (h) h.service = undefined; await runtime?.close(); if (h) h.residentStore = undefined; await h?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    h = await t.step(async () => nativeTaskHost(root, async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) {
        if (!held) { held = true; await release.promise }
        return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(message => ({
          messageId: message.messageId, messageVersion: message.messageVersion, units: [],
          ignoredRefs: [{ quote: message.text, reason: '仅讨论，无需执行' }],
        })) } }]
      }
      if (names.includes('task_delegate')) {
        const done = input.executions.some(execution => execution.status === 'succeeded' && execution.drained)
        const calls = delegated ? [] : [{ name: 'task_delegate', args: { key: 'selection-isolation', objective: '核对执行模型独立' } }]
        delegated = true
        return [...calls, { name: 'task_session_submit', args: { decision: { action: done ? 'complete' : 'wait', summary: '核对模型边界', evidence: [], limitations: [] } } }]
      }
      if (names.includes('execution_submit')) return [{ name: 'execution_submit', args: { output: { status: 'completed', summary: '已核对', evidence: [], limitations: [], artifacts: [] } } }]
      return topicTaskCalls(request) ?? []
    }, { resident: true }))
    const store = h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
    runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test', taskSessionModel: {
      provider: 'native-task-test', model: 'owner-model', reasoningEffort: 'low',
    } }))
    await t.step(async () => runtime.subscribe({ groupId: 'native-group', name: '模型隔离群' }))
    h.service = await t.step(async () => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: store,
      config: { dbPath: join(root, 'dynamic.db'), instanceId: 'topic-selection', initialize: true, ownerActorId: 'native-user', webActorId: 'native-user' },
      notifications: { async send() { return { messageId: 'isolated' } }, async readback() { return { visible: true, messageId: 'isolated' } } } }))
    const ingest = n => h.service.ingest({ groupId: 'native-group', messageId: 'model-' + n, senderOpenDingTalkId: 'native-user',
      text: '仅讨论，无需执行：' + n, timestamp: new Date().toISOString() })
    const before = runtime.getAgentConfig()
    await t.step(async () => ingest(1))
    await t.step(async () => waitUntil(() => held, 'first Topic routing call', 5000))
    const active = h.requests.find(request => request.tools.some(tool => tool.name === 'group_topic_route_submit'))
    assert.equal(active.model, before.model)
    assert.equal(h.ctx.get('configEditor'), undefined, 'the isolated host does not install a profile editor')
    await t.step(async () => assert.rejects(runtime.updateAgentConfig({ model: 'route-next' }), error => error.message === 'AGENT_CONFIG_SAVE_FAILED'
      && error.cause?.message === 'AGENT_CONFIG_READBACK_MISMATCH'))
    assert.deepEqual(runtime.getAgentConfig(), before, 'without a profile editor the Host cannot claim a persisted model save')
    const entry = [...h.ctx.loader.entries()].find(entry => entry.options.name.includes('dsh-agent-default-model/'))
    assert.ok(entry)
    await t.step(async () => entry.update({ ...entry.options, config: { provider: 'native-task-test', model: 'route-next' } }))
    await t.step(async () => h.ctx.loader.await())
    assert.equal(runtime.getAgentConfig().model, 'route-next')
    assert.equal(active.model, before.model, 'saving configuration cannot rewrite an active native request')
    const saved = runtime.getAgentConfig()
    await t.step(async () => assert.rejects(runtime.updateAgentConfig({ coordinationModel: { provider: 'native-task-test', model: 'retired' }, model: 'must-not-save' }), /INDEPENDENT_COORDINATION_RETIRED/))
    assert.deepEqual(runtime.getAgentConfig(), saved, 'invalid retired settings cannot partially save other model settings')
    release.resolve(); await t.step(async () => h.service.whenIdle())
    await t.step(async () => ingest(2)); await t.step(async () => h.service.whenIdle())
    assert.deepEqual(h.requests.filter(request => request.tools.some(tool => tool.name === 'group_topic_route_submit')).map(request => request.model), [before.model, 'route-next'])
    assert.deepEqual(runtime.getAgentConfig().taskSessionModel, before.taskSessionModel)
    const task = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'selection-isolation', objective: '核对模型边界' }))
    await t.step(async () => h.service.whenIdle())
    assert.equal((await t.step(async () => h.service.store.query({ kind: 'task.get', taskId: task.taskId }))).status, 'completed', JSON.stringify(h.service.listAlerts()))
    const owners = h.requests.filter(request => request.tools.some(tool => tool.name === 'task_delegate'))
    const executors = h.requests.filter(request => request.tools.some(tool => tool.name === 'execution_submit'))
    assert.ok(owners.length >= 2, 'Owner resumes after the actual execution result')
    assert.ok(executors.length)
    assert.ok(owners.every(request => request.provider === 'native-task-test' && request.model === 'owner-model' && request.reasoningEffort === 'low'))
    assert.ok(executors.every(request => request.provider === 'native-task-test' && request.model === 'route-next'))
    assert.ok(h.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
  }))

test('retired coordination settings cannot activate planning while ordinary native Topic routing remains available',
  { ...({ skip: !available ? reason : false, timeout: 15000 }), timeout: nativeLifecycleTimeout(15000) }, nativeLifecycle(15000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-model-disabled-'))
    let h, runtime, plans = 0
    t.after(async () => { await h?.service?.close(); if (h) h.service = undefined; await runtime?.close(); if (h) h.residentStore = undefined; await h?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    h = await t.step(async () => nativeTaskHost(root, request => {
      const input = latestInput(request)
      if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: {
        requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
          ignoredRefs: [{ quote: message.text, reason: '只记录讨论，没有交办' }], units: [] })),
      } }]
      return []
    }, { resident: true }))
    h.ctx.on('session/created', session => { if (session.id.startsWith('independent-')) plans++ })
    const store = h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
    runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' }))
    await t.step(async () => runtime.subscribe({ groupId: 'native-group', name: '隔离配置群' }))
    h.service = await t.step(async () => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: store,
      config: { dbPath: join(root, 'disabled.db'), instanceId: 'coord-disabled', initialize: true, coordination: { enabled: false } },
      notifications: { async send() { assert.fail('讨论不应发送消息') }, async readback() { assert.fail('没有发送不得回读') } } }))
    const before = runtime.getAgentConfig()
    await t.step(async () => assert.rejects(runtime.updateAgentConfig({ coordinationModel: { provider: 'native-task-test', model: 'configured-but-retired', reasoningMode: 'explicit', reasoningEffort: 'low' } }), /INDEPENDENT_COORDINATION_RETIRED/))
    await t.step(async () => h.service.ingest({ groupId: 'native-group', messageId: 'disabled', senderOpenDingTalkId: 'native-user', text: 'A完成后B再讨论，不用处理', timestamp: new Date().toISOString() }))
    await t.step(async () => h.service.whenIdle())
    assert.deepEqual(runtime.getAgentConfig(), before)
    assert.equal(plans, 0); assert.equal(store.listSourceDispatchOwnership('native-group').length, 0)
    assert.ok(h.requests.some(request => request.tools.some(tool => tool.name === 'group_topic_route_submit')))
    assert.equal(store.getGroup('native-group').messages[0].routingStatus, 'routed')
    assert.equal((await t.step(async () => h.service.store.query({ kind: 'task.list' }))).length, 0)
  }))
