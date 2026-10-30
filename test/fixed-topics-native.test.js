import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { available, reason, nativeTaskHost } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createFixedTopicHandler } from '../packages/dingtalk-dsh-assistant/fixed-topic-handler.js'

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
