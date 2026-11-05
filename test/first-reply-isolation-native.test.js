import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { access, writeFile } from 'node:fs/promises'
import { installEvaluationIsolation, isolatedEffects } from '../docs/acceptance/topic-routing-quality/scripts/first-reply-isolation.mjs'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory, nativeRemove } from './fixtures/native-lifecycle.js'
import { available, reason, nativeTaskHost, latestInput, loadNativeTestProfile, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'

async function installFileTools(host, root) {
  const profile = loadNativeTestProfile(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')
  for (const [name, config] of [['fs-local', { cwd: root }], ['working-directory', { defaultDirectory: root }], ['shell-env', {}], ['tool-fs', {}], ['tool-pwsh', {}]]) {
    const plugin = await import(pathToFileURL(profile.native.resolve(`@deepseek-ai/dsh-${name}`)).href)
    await host.ctx.plugin(plugin.default ?? plugin, config)
  }
  await host.ctx.loader.await()
}

test('首次回复评测拒绝文件与执行工具并隔离业务副作用', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'first-reply-isolation-'))
  const marker = join(root, 'forbidden-marker')
  const outside = await nativeTemporaryDirectory(join(tmpdir(), 'first-reply-outside-'))
  const canary = join(outside, 'canary.txt'), secret = 'isolated-canary-content-72851'
  await writeFile(canary, secret)
  const effects = isolatedEffects()
  let host, control, attempts = 0
  const controlRoot = await nativeTemporaryDirectory(join(tmpdir(), 'first-reply-control-'))
  t.after(async () => { await host?.close(); await control?.close(); await nativeRemove(root, { recursive: true, force: true }); await nativeRemove(controlRoot, { recursive: true, force: true }); await nativeRemove(outside, { recursive: true, force: true }) })
  const ignore = request => {
    const input = latestInput(request)
    return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, units: [], ignoredRefs: [{ quote: message.text, reason: '日常寒暄，无业务交办' }] })) } }]
  }
  control = await t.step(() => nativeTaskHost(controlRoot, ignore))
  await t.step(() => installFileTools(control, controlRoot))
  await t.beginBusiness()
  const read = await t.step(() => control.ctx.tools.execute({ callId: 'control-read', name: 'read', arguments: { file_path: canary }, signal: new AbortController().signal }))
  assert.equal(read.isError, false, JSON.stringify(read))
  assert.ok(JSON.stringify(read).includes(secret))
  await control.close()
  host = await t.step(() => nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit') && attempts++ === 0) return [
      { name: 'read', args: { file_path: canary } },
      { name: 'pwsh', args: { command: `New-Item -ItemType File -Path '${marker}'` } },
    ]
    return ignore(request)
  }, { notifications: effects.notificationAdapter, serviceFactory: options => openTaskSessionService({ ...options, taskSessions: effects.taskSessions }) }))
  await t.step(() => installFileTools(host, root))
  const isolation = installEvaluationIsolation(host.ctx)
  for (const [name, args] of [['read', { file_path: canary }], ['pwsh', { command: `New-Item -ItemType File -Path '${marker}'` }]]) {
    const result = await t.step(() => host.ctx.tools.execute({ callId: `isolated-${name}`, name, arguments: args, signal: new AbortController().signal }))
    assert.equal(result.isError, true)
    assert.ok(isolation.denied.includes(name), `${name} 必须由隔离 guard 拒绝`)
  }
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'isolation-source', text: '大家早上好。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  try {
    await t.step(() => waitUntil(async () => (await host.query('source.list')).some(item => item.messageId === 'isolation-source' && item.processingCompleted), '隔离来源完成', 10000))
  } catch (error) {
    error.message += `; attempts=${attempts}; requests=${host.requests.length}; results=${JSON.stringify(host.toolResults.map(item => ({ name: item.name, isError: item.result.isError, value: item.result.value })))}; denied=${JSON.stringify(isolation.denied)}; group=${JSON.stringify(host.residentStore.getGroup('native-group'))}`
    throw error
  }
  assert.ok(host.requests.length > 0)
  for (const request of host.requests) assert.ok(request.tools.every(tool => isolation.allowed.has(tool.name)))
  for (const name of ['read', 'pwsh']) {
    assert.ok(host.toolResults.some(item => item.name === name && item.result.isError), `${name} 必须被拒绝`)
    assert.ok(isolation.denied.includes(name), `${name} 必须由隔离 guard 拒绝`)
  }
  assert.equal(JSON.stringify(host.requests).includes(secret), false)
  await assert.rejects(access(marker))
  assert.deepEqual(effects.ownerAttempts, [])
  await assert.rejects(() => effects.taskSessions.run({}), /evaluation_owner_forbidden/)
  await effects.taskSessions.cancel({})
  assert.equal(effects.emptyCancels.length, 1)
  assert.deepEqual(effects.notifications, [])
  const source = (await host.query('source.list')).find(item => item.messageId === 'isolation-source')
  assert.ok(source?.processingCompleted)
}))

test('显式模型适配器直接处理协调请求，不自动代读', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'first-reply-adapter-'))
  let host, streams = 0, scriptedCalls = 0
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  const { LlmAdapter } = loadNativeTestProfile(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')
  class DirectAdapter extends LlmAdapter {
    resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      streams++
      const input = latestInput(request)
      const args = JSON.stringify({ requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, units: [], ignoredRefs: [{ quote: message.text, reason: '日常寒暄' }] })) })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'direct-route', name: 'group_topic_route_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'direct-route', name: 'group_topic_route_submit', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  host = await t.step(() => nativeTaskHost(root, () => { scriptedCalls++; throw new Error('unexpected_scripted_model') }, {
    installModelAdapter: ctx => ctx.llm.registerAdapter(['native-task-test'], new DirectAdapter()),
  }))
  await t.beginBusiness()
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'direct-source', text: '大家早上好。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  await t.step(() => waitUntil(async () => (await host.query('source.list')).some(item => item.messageId === 'direct-source' && item.processingCompleted), '直接适配器来源完成', 10000))
  assert.equal(streams, 1)
  assert.equal(scriptedCalls, 0)
  assert.deepEqual(host.toolResults.map(item => item.name), ['group_topic_route_submit'])
}))

test('隔离 Host 将规范任务动作和通知接纳到真实账本', { timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async t => {
  assert.ok(available, reason)
  const root = await nativeTemporaryDirectory(join(tmpdir(), 'first-reply-receipt-'))
  const effects = isolatedEffects()
  let host
  t.after(async () => { await host?.close(); await nativeRemove(root, { recursive: true, force: true }) })
  host = await t.step(() => nativeTaskHost(root, async request => {
    const calls = topicTaskCalls(request, { title: '核对测试报告' })
    if (calls[0]?.name === 'group_decision_submit') calls[0].args.decision.atOpenDingTalkIds = ['native-user']
    return calls
  }, { notifications: effects.notificationAdapter, serviceFactory: options => openTaskSessionService({ ...options, taskSessions: effects.taskSessions }) }))
  installEvaluationIsolation(host.ctx)
  await t.beginBusiness()
  await t.step(() => host.service.ingest({ groupId: 'native-group', messageId: 'receipt-source', text: '请助手核对测试报告并反馈结果。', senderName: '测试用户', senderOpenDingTalkId: 'native-user', sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z' }))
  try {
    await t.step(() => waitUntil(() => effects.notifications.length > 0 && effects.readbacks.length > 0 && effects.ownerAttempts.length > 0 && host.residentStore.getGroup('native-group').outbox.some(item => item.status === 'sent' && item.deliveredMessageId && item.deliveredAt), '隔离通知回执', 10000))
  } catch (error) {
    error.message += `; sends=${effects.notifications.length}; readbacks=${effects.readbacks.length}; ownerAttempts=${effects.ownerAttempts.length}; outboxStatuses=${JSON.stringify(host.residentStore.getGroup('native-group').outbox.map(item => item.status))}`
    throw error
  }
  const group = host.residentStore.getGroup('native-group')
  const decision = group.topics.flatMap(topic => topic.decisions).find(item => item.decision.basisMessageIds?.includes('receipt-source'))
  assert.ok(decision)
  assert.equal(decision.operations.length, 1)
  assert.equal(decision.operations[0].status, 'applied')
  const task = await host.query('task.get', { taskId: decision.operations[0].taskId })
  assert.ok(task)
  assert.ok(group.outbox.some(item => item.decisionId === decision.decisionId && item.status === 'sent' && item.deliveredMessageId === 'isolated-notification-1' && item.deliveredAt))
  assert.ok(effects.ownerAttempts.length > 0)
}))
