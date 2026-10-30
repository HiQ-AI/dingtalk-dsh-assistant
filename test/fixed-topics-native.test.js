import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { fixedUnitRequestId } from '../packages/dingtalk-dsh-assistant/fixed-topics.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createFixedTopicHandler } from '../packages/dingtalk-dsh-assistant/fixed-topic-handler.js'

function fixedReplyModel(category) {
  let queried = false, submitted = false
  return request => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: {
      requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion,
        units: [{ unitKey: 'fixed-request', summary: '固定类别问询', sourceRefs: [{ quote: message.text }], topics: [], fixedTopic: category,
          reason: '按问询事项归入固定类别', ...(category === 'out-of-scope' ? { outOfScopeHelp: true } : {}) }] })),
    } }]
    assert.ok(request.tools.some(tool => tool.name === 'platform_task_query'))
    if (!queried) { queried = true; return [{ name: 'platform_task_query', args: { state: 'completed' } }] }
    if (submitted) return []
    submitted = true
    return [{ name: 'platform_reply_submit', args: { text: '约定时间已过，现补报本群工作成果：当前范围没有已完成任务。' } }]
  }
}
const fixedMessage = { groupId: 'native-group', messageId: 'platform-request', senderOpenDingTalkId: 'native-user',
  text: '测试助手，请说明今天的工作成果', occurredAt: '2026-10-28T00:00:00Z', mentionedAgent: true }

for (const category of ['agent-platform', 'out-of-scope']) test(`fixed ${category} reply reaches the real outbound ledger and readback without a business Topic`, { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-outbound-native-'))
  let h
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, fixedReplyModel(category))
  await h.service.ingest(fixedMessage); await h.service.whenIdle()
  await h.service.recover(); await h.service.whenIdle()
  const [notification] = await h.query('notification.list')
  assert.ok(notification, JSON.stringify(h.toolResults))
  assert.equal(notification.kind, 'fixed-topic-reply')
  assert.equal(notification.state, 'delivered')
  assert.equal(notification.payload.fact.fixedTopic, category)
  assert.deepEqual(notification.payload.topicRefs, [])
  assert.equal(notification.taskId, null)
  assert.equal(h.sent.length, 1); assert.equal(h.readbacks.length, 1)
  const group = h.residentStore.getGroup(fixedMessage.groupId), message = group.messages[0], unit = message.units[0]
  assert.equal(notification.id, fixedUnitRequestId(group.groupId, message, unit))
  assert.equal(notification.payload.sourceMessageId, fixedMessage.messageId)
  assert.equal(notification.payload.sourceVersion, 1)
  assert.equal(notification.payload.actorId, fixedMessage.senderOpenDingTalkId)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, [fixedMessage.senderOpenDingTalkId])
  assert.deepEqual(group.topics, []); assert.deepEqual(await h.query('task.list'), [])
  assert.equal(group.outbox.length, 1); assert.equal(group.outbox[0].status, 'sent')
  assert.ok(unit.fixedTopicHandledAt)
  const command = (args, id) => h.service.store.command({ kind: 'notification.prepare', id, args })
  const prepare = { notificationId: notification.id, taskId: null, requirementRevision: 1, kind: notification.kind, payload: notification.payload }
  await assert.rejects(command({ ...prepare, kind: 'topic-reply', payload: { ...notification.payload, fact: { topicRefs: [] } } }, 'empty-business-topic'), { code: 'DYNAMIC_ARGUMENT_INVALID', message: 'topicRefs' })
  const changes = [p => { p.fact.fixedTopic = 'invented-category' }, p => { p.actorId = 'other-actor' }, p => { p.conversationId = 'other-group' },
    p => { p.sourceVersion = 2 }, p => { p.fact.unitRevision++ }, p => { p.topicRefs = [{ topicId: 'invented-topic', revision: 1 }] }, p => { p.taskIds = ['invented-task'] }]
  for (const [index, change] of changes.entries()) {
    const payload = structuredClone(notification.payload); change(payload)
    await assert.rejects(command({ ...prepare, payload }, `invalid-fixed-source-${index}`), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  }
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.sent.length, 1)
})

test('restart resumes a frozen fixed reply after outbox commit and before notification prepare, without regenerating or resending it', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-outbound-restart-'))
  let h
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  const ledger = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
  t.after(() => ledger.close())
  h = await nativeTaskHost(root, fixedReplyModel('agent-platform'), { store: { ...ledger, command: input => {
    if (input.kind === 'notification.prepare') throw Object.assign(new Error('injected_prepare_failure'), { code: 'injected_prepare_failure' })
    return ledger.command(input)
  } } })
  await h.service.ingest(fixedMessage); await h.service.whenIdle()
  const [frozen] = h.residentStore.getGroup(fixedMessage.groupId).outbox
  assert.ok(frozen); assert.equal(frozen.status, 'pending')
  assert.equal(h.sent.length, 0); assert.deepEqual(await h.query('notification.list'), [])
  assert.equal(h.residentStore.getGroup(fixedMessage.groupId).messages[0].units[0].fixedTopicHandledAt, undefined)
  await h.close(); await ledger.close()
  h = await nativeTaskHost(root, () => { assert.fail('frozen reply must not invoke a model again') }, { initialize: false })
  await h.service.recover(); await h.service.whenIdle()
  const [notification] = await h.query('notification.list')
  assert.equal(notification.id, frozen.outboundId); assert.equal(notification.state, 'delivered')
  assert.equal(notification.payload.text, frozen.text)
  assert.equal(h.sent.length, 1); assert.equal(h.readbacks.length, 1)
  assert.equal(h.residentStore.getGroup(fixedMessage.groupId).outbox.length, 1)
  assert.deepEqual(await h.query('task.list'), [])
  await h.close()
  h = await nativeTaskHost(root, () => { assert.fail('delivered fixed reply must not regenerate') }, { initialize: false })
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.sent.length, 0); assert.equal(h.readbacks.length, 0)
  assert.equal((await h.query('notification.list')).length, 1)
})

test('native platform tools coexist with preset tools and full access stays session-local', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'platform-native-'))
  let h, store, handler, step = 0
  t.after(async () => { await handler?.close(); await store?.close(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, 'probe.txt'), 'native-platform-read')
  const errors = [], modes = []
  h = await nativeTaskHost(root, request => {
    const names = request.tools.map(tool => tool.name)
    for (const name of ['read', 'write', 'platform_task_query', 'platform_reply_submit']) assert.ok(names.includes(name), name)
    if (step++ === 0) return [{ name: 'read', args: { file_path: join(root, 'probe.txt') } }, { name: 'platform_task_query', args: { state: 'completed', day: 'today' } }]
    return [{ name: 'platform_reply_submit', args: { text: '约定时间已过，现补报：本群当前范围没有完成记录。' } }]
  }, { resident: true })
  h.ctx.on('tools/result', exec => modes.push(h.ctx.permissionPresets.current(exec.agent.session)))
  h.ctx.on('agent/error', event => errors.push(event.error))
  const ordinary = await h.ctx.agents.create({ sessionId: 'ordinary-session' })
  assert.equal(h.ctx.permissionPresets.current(ordinary.agent.session), 'workspace-write')
  store = await openResidentStore(h.ctx.storageDomain)
  await store.subscribe({ groupId: 'test-group', timezone: 'Asia/Shanghai' })
  const text = '八点十分汇报今天工作成果'
  await store.ingest({ groupId: 'test-group', messageId: 'test-message', text, occurredAt: '2026-10-28T00:00:00Z', senderOpenDingTalkId: 'test-actor' })
  await store.routeMessages({ groupId: 'test-group', routeId: 'test-route', routingRevision: 0, routes: [{ messageId: 'test-message', messageVersion: 1,
    units: [{ unitKey: 'report', summary: '工作汇报', sourceRefs: [{ quote: text }], topics: [], fixedTopic: 'agent-platform', reason: '平台汇报' }] }] })
  handler = createFixedTopicHandler({ ctx: h.ctx, store, root, legacy: { getAgentConfig: () => ({ agentPreset: 'native-test' }) },
    models: { provider: 'native-task-test', model: 'controlled' }, now: () => Date.parse('2026-10-28T00:30:00Z'),
    readTasks: async () => [], appendOutbox: args => store.appendOutbox(args), onError: (_group, error) => errors.push(error) })
  handler.schedule('test-group'); await handler.whenIdle(); handler.schedule('test-group'); await handler.whenIdle()
  assert.deepEqual(errors, [], JSON.stringify({ requests: h.requests.length, results: h.toolResults, errors: errors.map(error => error?.message) }))
  assert.equal(h.requests.length, 2)
  assert.deepEqual(h.toolResults.map(item => [item.name, item.result.isError === true]).sort(), [['platform_reply_submit', false], ['platform_task_query', false], ['read', false]])
  assert.ok(modes.length === 3 && modes.every(mode => mode === 'danger-full-access'))
  assert.equal(h.ctx.permissionPresets.current(ordinary.agent.session), 'workspace-write')
  assert.equal(store.getGroup('test-group').outbox.length, 1)
  assert.equal(store.listTasks().length, 0)
  await ordinary.dispose()
})

test('rc2 native schedule tool remains visible and reports its delegated-session boundary truthfully', { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')))
  let schedulePath, toolPath
  try { schedulePath = profile.resolve('@deepseek-ai/dsh-schedule'); toolPath = profile.resolve('@deepseek-ai/dsh-tool-schedule') }
  catch { t.skip('This check requires the installed rc2 native schedule service and tool package'); return }
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  const root = await mkdtemp(join(tmpdir(), 'platform-schedule-native-'))
  let h, handle, step = 0
  t.after(async () => { await handle?.dispose(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, request => {
    assert.ok(request.tools.some(tool => tool.name === 'schedule_create'))
    return step++ === 0 ? [{ name: 'schedule_create', args: { title: '工作汇报', prompt: '汇报当前工作成果', after_seconds: 600 } }] : []
  }, { resident: true })
  for (const name of ['session-query', 'typert-registry']) { const module = await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-' + name))); await h.ctx.plugin(module.default ?? module) }
  const controllerRoot = dirname(profile.resolve('@deepseek-ai/dsh-api-session-controller'))
  const { ApiSessionAgentController } = await import(pathToFileURL(join(controllerRoot, 'types', 'agent.js')))
  h.ctx.provide('sessionController', new ApiSessionAgentController(h.ctx))
  const schedule = await import(pathToFileURL(schedulePath)), tool = await import(pathToFileURL(toolPath))
  await h.ctx.plugin(schedule.default ?? schedule, {})
  await h.ctx.plugin(tool.default ?? tool)
  handle = await h.ctx.agents.create({ sessionId: 'schedule-platform-session', meta: { cwd: root, origin: 'subagent', delegationDepth: 1 },
    agentOptions: { provider: 'native-task-test', model: 'controlled' }, setup: async (agentCtx, agent) => {
      await agentCtx.get('agentPresets').mount(agentCtx, 'native-test')
      agentCtx.get('permissionPresets').set(agent.session, 'danger-full-access')
    } })
  handle.agent.steer({ id: 'schedule-probe', role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify({ task: { title: '检查当前会话的原生调度边界' } }) }] })
  await handle.agent.whenIdle()
  assert.equal(h.toolResults[0].name, 'schedule_create')
  assert.match(JSON.stringify(h.toolResults[0].result), /subagent_session/)
  assert.deepEqual(await h.ctx.schedule.list({ sessionId: handle.agent.session.id }), [])
})
