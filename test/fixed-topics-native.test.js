import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, waitUntil } from './fixtures/task-session-native-host.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createFixedTopicHandler } from '../packages/dingtalk-dsh-assistant/fixed-topic-handler.js'
import { createPlatformSchedules } from '../packages/dingtalk-dsh-assistant/platform-schedule.js'
import { sessionWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { taskNotificationRecovery } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { fixedUnitRequestId } from '../packages/dingtalk-dsh-assistant/fixed-topics.js'

async function nativeSchedule(h, t) {
  const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')))
  let schedulePath, toolPath
  try { schedulePath = profile.resolve('@deepseek-ai/dsh-schedule'); toolPath = profile.resolve('@deepseek-ai/dsh-tool-schedule') }
  catch { t.skip('Requires the installed rc2 native schedule service and tools'); return false }
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  for (const name of ['session-query', 'typert-registry']) { const module = await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-' + name))); await h.ctx.plugin(module.default ?? module) }
  const controllerRoot = dirname(profile.resolve('@deepseek-ai/dsh-api-session-controller'))
  const { ApiSessionAgentController } = await import(pathToFileURL(join(controllerRoot, 'types', 'agent.js')))
  const { installModelSelectionProjection } = await import(pathToFileURL(join(controllerRoot, 'types', 'model-selection-projection.js')))
  installModelSelectionProjection(h.ctx)
  h.ctx.provide('sessionController', new ApiSessionAgentController(h.ctx))
  const schedule = await import(pathToFileURL(schedulePath)), tool = await import(pathToFileURL(toolPath))
  await h.ctx.plugin(schedule.default ?? schedule, {})
  await h.ctx.plugin(tool.default ?? tool)
  return true
}

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
    return [{ name: 'platform_reply_submit', args: { atOpenDingTalkIds: ['native-user'], text: '约定时间已过，现补报本群工作成果：当前范围没有已完成任务。' } }]
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
  assert.equal(notification.state, 'delivered', JSON.stringify(await h.service.recover()))
  assert.equal(notification.payload.fact.fixedTopic, category)
  assert.deepEqual(notification.payload.topicRefs, [])
  assert.equal(notification.taskId, null)
  assert.equal(h.sent.length, 1); assert.equal(h.readbacks.length, 1)
  const group = h.residentStore.getGroup(fixedMessage.groupId), message = group.messages[0], unit = message.units[0]
  assert.equal(notification.id, fixedUnitRequestId(group.groupId, message, unit))
  assert.equal(notification.payload.sourceRef.messageId, fixedMessage.messageId)
  assert.equal(notification.payload.sourceMessageId, undefined)
  assert.equal(notification.payload.sourceVersion, 1)
  assert.equal(notification.payload.sourceRef.actorId, fixedMessage.senderOpenDingTalkId)
  assert.equal(notification.payload.actorId, undefined)
  assert.deepEqual(notification.payload.atOpenDingTalkIds, [fixedMessage.senderOpenDingTalkId])
  assert.deepEqual(group.topics, []); assert.deepEqual(await h.query('task.list'), [])
  assert.equal(group.outbox.length, 1); assert.equal(group.outbox[0].status, 'sent')
  assert.ok(unit.fixedTopicHandledAt)
  const command = (args, id) => h.service.store.command({ kind: 'notification.prepare', id, args })
  const prepare = { notificationId: notification.id, taskId: null, requirementRevision: 1, kind: notification.kind, payload: notification.payload }
  await assert.rejects(command({ ...prepare, kind: 'topic-reply', payload: { ...notification.payload, fact: { topicRefs: [] } } }, 'empty-business-topic'), { code: 'DYNAMIC_ARGUMENT_INVALID', message: 'topicRefs' })
  const changes = [p => { p.fact.fixedTopic = 'invented-category' }, p => { p.actorId = 'other-actor' }, p => { p.conversationId = 'other-group' },
    p => { p.sourceVersion = 2 }, p => { p.fact.unitRevision++ }, p => { p.topicRefs = [{ topicId: 'invented-topic', revision: 1 }] }, p => { p.taskIds = ['invented-task'] },
    p => { p.fact.scheduleId = 'invented-schedule'; p.fact.scheduledAt = '2026-10-28T00:00:00.000Z' }]
  for (const [index, change] of changes.entries()) {
    const payload = structuredClone(notification.payload); change(payload)
    await assert.rejects(command({ ...prepare, payload }, `invalid-fixed-source-${index}`), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  }
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(h.sent.length, 1)
})

for (const legacyFrozen of [false, true]) test(`restart resumes a frozen fixed reply before notification prepare without regenerating it: legacy=${legacyFrozen}`, { skip: !available ? reason : false, timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-outbound-restart-'))
  let h
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  const ledger = await openDynamicTaskStore({ dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: true })
  t.after(() => ledger.close())
  h = await nativeTaskHost(root, fixedReplyModel('agent-platform'), { store: { ...ledger, command: input => {
    if (input.kind === 'notification.prepare') throw Object.assign(new Error('injected_prepare_failure'), { code: 'injected_prepare_failure' })
    return ledger.command(input)
  } } })
  if (legacyFrozen) {
    // Reproduce the previous release's durable intent, including its quote and
    // audience. Upgrade must resume this exact intent, not reselect recipients.
    const append = h.residentStore.appendOutbox
    h.residentStore.appendOutbox = ({ sourceRef: _source, ...args }) => append({ ...args,
      replyToMessageId: fixedMessage.messageId, replyToSenderOpenDingTalkId: fixedMessage.senderOpenDingTalkId })
  }
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
  assert.equal(notification.payload.sourceMessageId, legacyFrozen ? fixedMessage.messageId : undefined)
  assert.equal(notification.payload.sourceRef?.messageId, legacyFrozen ? undefined : fixedMessage.messageId)
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
    return [{ name: 'platform_reply_submit', args: { atOpenDingTalkIds: ['test-actor'], text: '约定时间已过，现补报：本群当前范围没有完成记录。' } }]
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
  const root = await mkdtemp(join(tmpdir(), 'platform-schedule-native-'))
  let h, handle, step = 0
  t.after(async () => { await handle?.dispose(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, request => {
    assert.ok(request.tools.some(tool => tool.name === 'schedule_create'))
    return step++ === 0 ? [{ name: 'schedule_create', args: { title: '工作汇报', prompt: '汇报当前工作成果', after_seconds: 600 } }] : []
  }, { resident: true })
  if (!await nativeSchedule(h, t)) return
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

for (const scenario of ['before-due', 'late-bridge', 'superseded']) test('Host native one-shot survives restart, retains child identity, queries fresh facts and delivers once: ' + scenario, { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'platform-due-native-'))
  const restoreLate = scenario === 'late-bridge', superseded = scenario === 'superseded'
  let h, handler, originalTurns = 0, dueTurns = 0, taskTitle = '创建时旧事实', receiptFault = scenario === 'before-due'
  const errors = [], childHeaders = [], taskReads = [], scheduled = { title: '工作汇报', prompt: '汇报本群今天的工作成果' }
  const boot = async (late = false) => {
    h = await nativeTaskHost(root, request => {
      if (request.tools.some(tool => tool.name === 'platform_schedule_submit')) {
        if (originalTurns++ === 0) {
          // Cold Host/preset startup is not part of the reminder's waiting time.
          // Freeze one target at submission, then retry that exact same instant.
          scheduled.at = new Date(Date.now() + 2500).toISOString()
          return [0, 1].map(() => ({ name: 'platform_schedule_submit', args: scheduled }))
        }
        return [{ name: 'platform_reply_submit', args: { atOpenDingTalkIds: ['original-actor'], text: '已安排本次工作汇报。' } }]
      }
      if (!request.tools.some(tool => tool.name === 'platform_task_query')) return []
      if (dueTurns++ === 0) return [{ name: 'platform_task_query', args: { state: 'completed', day: 'today' } }]
      assert.match(JSON.stringify(request.messages), /到期时新事实/)
      return [{ name: 'platform_reply_submit', args: { atOpenDingTalkIds: ['original-actor'], text: '本群当前完成一项：到期时新事实。' } }]
    }, { resident: true })
    h.ctx.on('agent/error', event => errors.push(event.error))
    h.ctx.on('tools/result', exec => { if (exec.name === 'platform_schedule_submit') childHeaders.push(exec.agent.session.header) })
    h.residentStore = await openResidentStore(h.ctx.storageDomain)
    const update = h.residentStore.updatePlatformSchedule
    h.residentStore.updatePlatformSchedule = (id, changes) => {
      if (receiptFault && changes.scheduleId) { receiptFault = false; throw new Error('injected_receipt_write_failure') }
      return update(id, changes)
    }
    if (late) {
      if (!await nativeSchedule(h, t)) return false
      await waitUntil(async () => (await h.ctx.schedule.catalog())[0]?.status === 'inactive', 'native service delivers while bridge is loading')
    }
    handler = createFixedTopicHandler({ ctx: h.ctx, store: h.residentStore, root, legacy: { getAgentConfig: () => ({ agentPreset: 'native-test' }) },
      models: { provider: 'native-task-test', model: 'controlled' }, readTasks: async groupId => {
        taskReads.push({ groupId, title: taskTitle, at: Date.now() })
        return [{ taskId: 'test-task', groupId, title: taskTitle, state: 'completed', completedAt: new Date().toISOString() }]
      },
      appendOutbox: args => h.residentStore.appendOutbox(args), onError: (_group, error) => errors.push(error) })
    return late || nativeSchedule(h, t)
  }
  t.after(async () => { await handler?.close(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  if (!await boot()) return
  await h.residentStore.subscribe({ groupId: 'scheduled-group', timezone: 'Asia/Shanghai' })
  const text = '稍后汇报本群今天工作成果'
  await h.residentStore.ingest({ groupId: 'scheduled-group', messageId: 'scheduled-source', senderOpenDingTalkId: 'original-actor', text, occurredAt: new Date().toISOString() })
  await h.residentStore.routeMessages({ groupId: 'scheduled-group', routeId: 'scheduled-route', routingRevision: 0, routes: [{ messageId: 'scheduled-source', messageVersion: 1,
    units: [{ unitKey: 'scheduled', summary: '定时汇报', sourceRefs: [{ quote: text }], topics: [], fixedTopic: 'agent-platform', reason: '一次平台事项' }] }] })
  handler.schedule('scheduled-group'); await handler.whenIdle()
  assert.deepEqual(errors, [])
  const [record] = await h.ctx.schedule.catalog()
  assert.equal((await h.ctx.schedule.catalog()).length, 1, JSON.stringify(h.toolResults))
  assert.equal(record.status, 'active')
  if (scenario === 'before-due') assert.equal(h.toolResults.filter(item => item.name === 'platform_schedule_submit' && item.result.isError).length, 1)
  assert.ok(childHeaders.length === 2 && childHeaders.every(header => header.origin === 'subagent' && header.delegationDepth === 1))
  const persisted = await h.ctx.sessionPersistence.open(record.sessionId, 'read')
  assert.equal(persisted.header.origin, undefined); assert.equal(persisted.header.delegationDepth ?? 0, 0)
  await persisted.close()
  assert.equal(h.residentStore.getGroup('scheduled-group').outbox.length, 1)
  if (superseded) await h.residentStore.ingest({ groupId: 'scheduled-group', messageId: 'scheduled-source', messageVersion: 2, senderOpenDingTalkId: 'original-actor', text: '撤回之前的汇报要求', occurredAt: new Date().toISOString() })
  taskTitle = '到期时新事实'
  await handler.close(); await h.close()
  if (restoreLate) await waitUntil(() => Date.now() > Date.parse(scheduled.at), 'original target passes while Host is stopped')
  await boot(restoreLate)
  await waitUntil(() => h.residentStore.getPlatformSchedule(record.sessionId)?.outcome === (superseded ? 'superseded' : 'replied'), 'native reminder settles the original group report')
  // The Agent can settle before Schedule's separate inbox flush/status commit.
  // Await that durable boundary too; neither completion stands in for the other.
  await waitUntil(async () => (await h.ctx.schedule.catalog()).find(item => item.id === record.id)?.status === 'inactive', 'original native reminder commits its delivery')
  assert.deepEqual(errors, [])
  const outbox = h.residentStore.getGroup('scheduled-group').outbox
  assert.equal(outbox.length, superseded ? 1 : 2)
  assert.ok(outbox.every(item => item.sourceRef.messageId === 'scheduled-source' && item.sourceRef.actorId === 'original-actor' && !item.replyToMessageId))
  assert.equal((await h.ctx.schedule.catalog())[0].status, 'inactive')
  assert.equal((await h.ctx.schedule.history({ sessionId: record.sessionId, id: record.id, limit: 10 })).records.length, 1)
  assert.ok(taskReads.some(read => read.title === '创建时旧事实' && read.at < Date.parse(scheduled.at)))
  const dueReads = taskReads.filter(read => read.at >= Date.parse(scheduled.at))
  assert.equal(dueReads.length, superseded ? 0 : 1, JSON.stringify(taskReads))
  assert.ok(dueReads.every(read => read.groupId === 'scheduled-group' && read.title === '到期时新事实'))
  const restored = await h.ctx.sessionController.resolveAgent(record.sessionId)
  restored.agent.followup({ id: 'duplicate-delivery-probe', role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER]\n重复送入同一事项' }] })
  await restored.agent.whenIdle()
  assert.equal(dueTurns, superseded ? 0 : 2); assert.equal(h.residentStore.getGroup('scheduled-group').outbox.length, superseded ? 1 : 2)
  assert.equal(h.residentStore.listTasks().length, 0)
})

for (const audience of ['all', 'members']) test(`native due ${audience} report shares final delivery and recovers attachments after cold restart`, { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'platform-scheduled-ledger-'))
  let h, originalTurns = 0, dueTurns = 0, initialize = true, filesReadable = false
  const dwsCalls = [], adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async args => { dwsCalls.push(args); return { exitCode: 0, stdout: '{"success":true}' } } } })
  const sends = [], errors = [], scheduleInput = { title: '工作汇报', prompt: '汇报本群今天完成情况', at: new Date(Date.now() + 2500).toISOString() }
  const route = fixedReplyModel('agent-platform')
  const boot = async () => {
    h = await nativeTaskHost(root, request => {
      if (request.tools.some(tool => tool.name === 'group_topic_route_submit')) return route(request)
      if (request.tools.some(tool => tool.name === 'platform_schedule_submit')) {
        if (originalTurns++ === 0) return [{ name: 'platform_schedule_submit', args: scheduleInput }]
        return [{ name: 'platform_reply_submit', args: { atOpenDingTalkIds: ['native-user'], text: '已安排本次工作汇报。' } }]
      }
      if (!request.tools.some(tool => tool.name === 'platform_task_query')) return []
      if (dueTurns++ === 0) return [{ name: 'platform_task_query', args: { state: 'completed', day: 'today' } }]
      const page = modelToolValues(request).find(value => Array.isArray(value.items) && value.asOf)
      assert.ok(page, 'due report must read real task-service facts')
      assert.ok(Date.parse(page.asOf) >= Date.parse(scheduleInput.at))
      assert.deepEqual(page.items, [])
      return [{ name: 'platform_reply_submit', args: { ...(audience === 'all' ? { atAll: true } : { atOpenDingTalkIds: ['reviewer', 'native-user'] }), replyToMessageId: fixedMessage.messageId,
        text: '本次工作汇报：当前范围没有已完成任务。[验收说明](https://example.org/result)', files: [1, 2].map(index => ({ path: `result-${index}.png`, caption: `核验项${index}` })) } }]
    }, { resident: true })
    h.ctx.on('agent/error', event => errors.push(event.error))
    h.residentStore = await openResidentStore(h.ctx.storageDomain)
    if (initialize) {
      await h.residentStore.subscribe({ groupId: 'native-group', timezone: 'Asia/Shanghai', responsibility: '处理交办给测试助手的工作' })
      await h.residentStore.setAgentNames(['测试助手'])
      await h.residentStore.ingest({ groupId: 'native-group', messageId: 'reviewer-message', senderOpenDingTalkId: 'reviewer', text: '我是验收成员', occurredAt: new Date().toISOString() })
      await h.residentStore.routeMessages({ groupId: 'native-group', routeId: 'reviewer-route', routingRevision: 0, routes: [{ messageId: 'reviewer-message', messageVersion: 1, units: [], ignoredRefs: [{ quote: '我是验收成员', reason: '背景身份' }] }] })
      const directory = await sessionWorkspace(root, 'platform')
      for (const index of [1, 2]) await writeFile(join(directory, `result-${index}.png`), Buffer.from([137,80,78,71,index]))
    }
    const legacy = { getAgentConfig: () => ({ workspaceDir: root, agentPreset: 'native-test', provider: 'native-task-test', model: 'controlled', agentNames: ['测试助手'] }),
      getGroup: id => h.residentStore.getGroup(id) }
    h.service = await openTaskSessionService({ ctx: h.ctx, residentStore: h.residentStore, legacy,
      config: { workspaceDir: root, dbPath: join(root, 'dynamic.db'), instanceId: 'scheduled-native-test', initialize, ownerActorId: 'native-user', provider: 'native-task-test' },
      notifications: {
        async send(notification) { await sendWorkflowNotification(adapter, notification); sends.push(structuredClone(notification)); return { messageId: `delivered-${notification.id}` } },
        async sendFile(notification, file) { assert.equal(file.artifactId, notification.payload.artifact.artifactId); sends.push(structuredClone(notification)); return { messageId: `delivered-${notification.id}` } },
        async readbackFile(notification) { return filesReadable ? { messageId: notification.ack.messageId, visible: true } : undefined },
        async readback(notification) { return { messageId: notification.ack.messageId, visible: true } },
      } })
    h.query = (kind, args = {}) => h.service.store.query({ kind, ...args })
    if (!await nativeSchedule(h, t)) return false
    initialize = false
    await h.service.recover(); await h.service.whenIdle()
    return true
  }
  t.after(async () => { await h?.close(); await rm(root, { recursive: true, force: true }) })
  if (!await boot()) return
  await h.service.ingest({ ...fixedMessage, text: '测试助手，稍后汇报本群今天完成情况', occurredAt: new Date().toISOString() })
  await h.service.whenIdle()
  const [record] = await h.ctx.schedule.catalog(), [confirmation] = await h.query('notification.list')
  assert.equal(record.status, 'active'); assert.equal(confirmation.state, 'delivered')
  assert.equal(sends.length, 1); assert.equal(dueTurns, 0)
  await h.close(); await boot()
  await waitUntil(() => h.residentStore.getPlatformSchedule(record.sessionId)?.outcome === 'replied', 'scheduled report prepared after native cold restore')
    .catch(error => { t.diagnostic(JSON.stringify({ tools: h.toolResults.slice(-4), errors: errors.map(value => value.message) })); throw error })
  await h.service.whenIdle()
  await waitUntil(async () => (await h.query('notification.list')).some(item => item.payload.artifact && item.ack && item.readbackAttemptCount > 0), 'first attachment has its original ACK and unconfirmed readback')
    .catch(async error => { t.diagnostic(JSON.stringify({ recovery: await h.service.recover(), errors: errors.map(value => value.stack) })); throw error })
  const notices = await h.query('notification.list'), report = notices.find(item => item.id !== confirmation.id)
  assert.equal(notices.length, 4); assert.equal(report.kind, 'fixed-topic-reply'); assert.equal(report.state, 'delivered')
  assert.equal(report.payload.fact.scheduleId, record.id); assert.equal(report.payload.fact.scheduledAt, scheduleInput.at)
  assert.equal(report.id, `${confirmation.id}-scheduled-delivery`)
  assert.equal(report.payload.sourceRef.messageId, fixedMessage.messageId); assert.equal(report.payload.sourceRef.actorId, fixedMessage.senderOpenDingTalkId)
  assert.equal(report.payload.sourceMessageId, undefined); assert.equal(report.payload.actorId, undefined)
  assert.deepEqual(report.payload.topicRefs, []); assert.deepEqual(report.payload.atOpenDingTalkIds, audience === 'all' ? [] : ['reviewer', 'native-user']); assert.equal(report.payload.atAll, audience === 'all' ? true : undefined)
  const [firstFile, secondFile] = notices.filter(item => item.payload.artifact)
  assert.ok(['starting', 'unknown'].includes(firstFile.state)); assert.ok(firstFile.ack); assert.equal(secondFile.state, 'prepared')
  assert.equal(firstFile.payload.afterNotificationId, report.id); assert.equal(secondFile.payload.afterNotificationId, firstFile.id)
  assert.equal(firstFile.payload.artifact.taskId, undefined); assert.equal(firstFile.payload.artifact.platformSource.sessionId, record.sessionId)
  assert.match(report.payload.text, /result-1.png：核验项1/); assert.ok(!dwsCalls.at(-1).includes('--ref-msg-id'))
  assert.equal(dwsCalls.at(-1).includes('--at-all'), audience === 'all')
  assert.ok(dwsCalls.at(-1).includes('--markdown'))
  assert.equal(sends.length, 3); assert.equal(dueTurns, 2); assert.deepEqual(errors, [])
  assert.deepEqual(await h.query('task.list'), []); assert.deepEqual(h.residentStore.getGroup(fixedMessage.groupId).topics, [])
  assert.equal((await h.ctx.schedule.catalog()).length, 1)
  assert.equal((await h.ctx.schedule.history({ sessionId: record.sessionId, id: record.id, limit: 10 })).records.length, 1)
  await h.close(); filesReadable = true; await boot()
  const pending = await h.query('notification.get', { notificationId: firstFile.id })
  await h.service.retryNotification({ groupId: fixedMessage.groupId, notificationId: firstFile.id, expectedToken: taskNotificationRecovery(pending).expectedToken })
  await h.service.recover(); await h.service.whenIdle()
  await waitUntil(async () => (await h.query('notification.list')).every(item => item.state === 'delivered'), 'remaining parts read back after restart')
  assert.equal(sends.length, 4); assert.equal(dueTurns, 2)
  assert.equal(new Set(sends.map(item => item.id)).size, 4, 'no already sent item is resent')
  assert.ok((await h.query('notification.list')).every(item => item.state === 'delivered'))
  const deliveredFile = await h.query('notification.get', { notificationId: firstFile.id })
  const echo = await h.service.ingest({ groupId: fixedMessage.groupId, messageId: deliveredFile.receipt.messageId,
    senderOpenDingTalkId: fixedMessage.senderOpenDingTalkId, text: '[file] result-1.png', occurredAt: new Date().toISOString() })
  assert.equal(echo.reason, 'own-notification', 'shared attachment receipts retain existing self-echo filtering')
  await h.close(); await boot(); assert.equal(sends.length, 4); assert.equal(dueTurns, 2)
})

test('Host refuses an expired instant without scheduling tomorrow, while native source binding stays trusted', { skip: !available ? reason : false, timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'platform-expired-native-'))
  let h, bridge
  t.after(async () => { await bridge?.close(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await nativeTaskHost(root, () => [], { resident: true })
  if (!await nativeSchedule(h, t)) return
  h.residentStore = await openResidentStore(h.ctx.storageDomain)
  await h.residentStore.subscribe({ groupId: 'g', timezone: 'Asia/Shanghai' })
  const text = '定点汇报'
  await h.residentStore.ingest({ groupId: 'g', messageId: 'm', senderOpenDingTalkId: 'actor', text, occurredAt: new Date().toISOString() })
  await h.residentStore.routeMessages({ groupId: 'g', routeId: 'r', routingRevision: 0, routes: [{ messageId: 'm', messageVersion: 1,
    units: [{ unitKey: 'u', summary: '定时', sourceRefs: [{ quote: text }], topics: [], fixedTopic: 'agent-platform', reason: '平台事项' }] }] })
  const message = h.residentStore.getGroup('g').messages[0], unit = message.units[0]
  const source = { groupId: 'g', messageId: 'm', messageVersion: 1, unitId: unit.unitId, unitRevision: unit.unitRevision, timezone: 'Asia/Shanghai', requestId: fixedUnitRequestId('g', message, unit) }
  bridge = createPlatformSchedules({ ctx: h.ctx, store: h.residentStore, root, legacy: { getAgentConfig: () => ({ agentPreset: 'native-test' }) },
    readTasks: async () => [], appendOutbox: () => assert.fail('expired request must not send') })
  const args = { title: '工作汇报', prompt: '汇报工作', at: new Date(Date.now() - 60000).toISOString() }
  assert.equal((await bridge.submit(source, args)).status, 'expired')
  assert.deepEqual(await h.ctx.schedule.catalog(), [])
  await assert.rejects(bridge.submit({ ...source, groupId: 'other' }, { ...args, at: new Date(Date.now() + 60000).toISOString() }), /source_stale/)
  await assert.rejects(bridge.submit(source, { ...args, at: '2026-10-30T12:00:00' }), /requires_offset/)
  await assert.rejects(bridge.submit(source, { ...args, at: '2099-02-30T12:00:00+08:00' }), /time_invalid/)
  const future = { ...args, at: new Date(Date.now() + 60000).toISOString() }
  const accepted = await bridge.submit(source, future), [record] = await h.ctx.schedule.catalog()
  assert.equal(accepted.status, 'scheduled')
  await assert.rejects(bridge.submit(source, { ...future, title: '不同事项' }), /identity_conflict/)
  await h.ctx.schedule.delete({ sessionId: record.sessionId, id: record.id })
  assert.equal((await bridge.submit(source, future)).status, 'cancelled')
  assert.deepEqual(await h.ctx.schedule.catalog(), [])
})
