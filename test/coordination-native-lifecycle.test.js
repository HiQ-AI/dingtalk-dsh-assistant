import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createCoordinationSessions, coordinationTools, createCoordinationStepGate } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'

const requireGoal = createRequire(import.meta.resolve('@deepseek-ai/dsh-goal'))
const { SessionProjectionRegistry } = requireGoal('@deepseek-ai/dsh-session-projection')
const flush = () => new Promise(resolve => setImmediate(resolve))
const request = { requestId: 'coord-route-native-lifecycle', groupId: 'g', messages: [{ messageId: 'message-native', messageVersion: 1, text: '原生路由测试' }] }
const routes = [{ messageId: 'message-native', messageVersion: 1, topics: [{ newTopicKey: 'native-topic', title: '原生验证' }] }]

// 模型输出使用确定性适配器；AgentLoop、作用域工具注册/限制、工具waterfall、Session与Store均为真实实现。
async function setup(t, { snapshot = { tables: {}, global: null }, illegalFirst = false, localWrite = false, postGate } = {}) {
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'native-coordination-test' })
  const store = await openResidentStore(facility)
  if (!store.getGroup('g')) {
    await store.subscribe({ groupId: 'g', responsibility: '原生生命周期验证' })
    await store.ingest({ groupId: 'g', messageId: 'message-native', text: '原生路由测试', occurredAt: '2026-09-21T12:00:00Z' })
  }
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false })
  new LlmRuntime(ctx)
  new ToolRuntime(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  let modelCalls = 0, engineeringWrites = 0, submitCalls = 0, active = true
  const presented = [], disposed = [], errors = []
  class ScriptedModel extends LlmAdapter {
    async *stream(options) {
      modelCalls++
      presented.push(options.tools?.map(tool => tool.name) ?? [])
      const name = illegalFirst && modelCalls === 1 ? 'pwsh' : 'group_topic_route_submit'
      if (modelCalls > (illegalFirst ? 2 : 1)) throw new Error('unexpected_extra_model_step')
      const id = 'native-call-' + modelCalls, argumentsJson = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['native-coordination-fixture'], new ScriptedModel())
  const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  ctx.tools.register({ name: 'pwsh', description: '禁止的工程写能力', parameters: { type: 'object' }, output, execute() { engineeringWrites++; return { executed: true } } })
  ctx.tools.register({ name: 'group_topic_route_submit', description: '原生提交工具', parameters: { type: 'object' }, output,
    async execute(_args, exec) {
      manager.assert(exec.agent, request.groupId, request.requestId)
      submitCalls++
      const result = await store.routeMessages({ groupId: 'g', routeId: request.requestId, routingRevision: 0, routes })
      active = false
      manager.finish(request)
      return { accepted: true, routeId: result.routeId }
    },
  })
  if (postGate) ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name === 'group_topic_route_submit') { postGate.entered.resolve(); await postGate.release.promise }
    return next()
  })
  const manager = createCoordinationSessions({ isCurrent: () => active, onError: error => errors.push(error), create: async entry => {
    const handle = await loop.createAgent(ctx, { sessionId: entry.sessionId, agentOptions: { provider: 'native-coordination-fixture', model: 'fixture' }, setup(agentCtx) {
      // 原生restrict只过滤继承工具；scope自己的工具必须再用不可放宽的guard约束。
      agentCtx.tools.restrict({ allow: ['group_topic_route_submit'] })
      if (localWrite) agentCtx.tools.register({ name: 'pwsh', description: 'scope本地写能力', parameters: { type: 'object' }, output, execute() { engineeringWrites++; return { executed: true } } })
      const allowed = new Set(coordinationTools(entry.role))
      agentCtx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'coordination_tool_outside_role')
      agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, () => active))
    } })
    return { agent: handle.agent, async dispose() {
      disposed.push({ status: handle.agent.status, events: structuredClone(handle.agent.session.snapshotEvents()) })
      await handle.dispose()
    } }
  } })
  t.after(async () => { postGate?.release.resolve(); await manager.close(); await store.close(); await ctx.fiber.dispose() })
  const start = () => manager.dispatch(request, { ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '只执行此路由请求' }] }), id: 'message-' + request.requestId })
  return { store, snapshot, manager, start, disposed, errors, presented, stats: () => ({ modelCalls, engineeringWrites, submitCalls }) }
}

const resultEvents = agent => agent.session.snapshotEvents().filter(event => event.type === 'tool/result')

test('真实AgentLoop提交后post-execute尚未结束不能dispose，成功结果落Session后停止额外模型轮', { timeout: 10000 }, async t => {
  const postGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  const h = await setup(t, { postGate })
  const agent = await h.start()
  await postGate.entered.promise
  await flush(); await flush()
  assert.equal(h.store.getGroup('g').routeHistory.length, 1, '业务已接纳')
  assert.equal(resultEvents(agent).length, 0, '真实post-execute仍占有工具结果')
  assert.equal(h.disposed.length, 0, '禁止以setImmediate替代工具结果边界')
  postGate.release.resolve()
  await agent.whenIdle()
  await h.manager.close()
  assert.equal(h.stats().modelCalls, 1)
  assert.equal(resultEvents(agent).length, 1)
  assert.notEqual(resultEvents(agent)[0].data.message.content[0].isError, true)
  assert.equal(h.disposed.length, 1)
  assert.equal(h.disposed[0].status, 'idle')
  assert.equal(h.disposed[0].events.filter(event => event.type === 'tool/result').length, 1)
  const restored = Session.fromRestore(agent.session.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), JSON.parse(JSON.stringify(agent.session.header)))
  assert.equal(restored.snapshotEvents().filter(event => event.type === 'tool/result').length, 1)
  assert.deepEqual(h.errors, [])
})

test('真实工具allowlist既不向模型呈现pwsh也拒绝恶意调用，随后合法提交仅一次', { timeout: 10000 }, async t => {
  const h = await setup(t, { illegalFirst: true })
  const agent = await h.start()
  await agent.whenIdle()
  await h.manager.close()
  assert.equal(h.stats().engineeringWrites, 0)
  assert.equal(h.stats().modelCalls, 2)
  assert.equal(h.stats().submitCalls, 1)
  assert.ok(h.presented.every(names => !names.includes('pwsh')))
  const results = resultEvents(agent)
  assert.equal(results.length, 2)
  assert.equal(results[0].data.message.content[0].isError, true)
  assert.equal(h.store.listTopics('g').length, 1)
})

test('真实Store序列化重开和新AgentLoop恢复同请求，已接纳业务效果不重复', { timeout: 10000 }, async t => {
  const first = await setup(t)
  const agent = await first.start()
  await agent.whenIdle(); await first.manager.close()
  const before = structuredClone(first.store.getGroup('g'))
  const restored = await setup(t, { snapshot: JSON.parse(JSON.stringify(first.snapshot)) })
  const reopenedBefore = structuredClone(restored.store.getGroup('g'))
  const resumed = await restored.start()
  await resumed.whenIdle(); await restored.manager.close()
  assert.equal(restored.stats().submitCalls, 1, '模型重提进入真实Store幂等检查')
  assert.equal(restored.store.listTopics('g').length, 1)
  assert.equal(restored.store.getGroup('g').routeHistory.length, 1)
  assert.deepEqual(restored.store.getGroup('g'), reopenedBefore)
  assert.deepEqual(JSON.parse(JSON.stringify(restored.store.listTopics('g'))), JSON.parse(JSON.stringify(before.topics)))
})


test('原生scope-local工程工具可绕过restrict展示但不能绕过单调guard执行', { timeout: 10000 }, async t => {
  const h = await setup(t, { illegalFirst: true, localWrite: true })
  const agent = await h.start()
  await agent.whenIdle(); await h.manager.close()
  assert.equal(h.stats().engineeringWrites, 0)
  assert.equal(h.stats().submitCalls, 1)
  assert.equal(h.stats().modelCalls, 2)
  assert.equal(resultEvents(agent)[0].data.message.content[0].isError, true)
  assert.ok(JSON.stringify(resultEvents(agent)[0]).includes('coordination_tool_outside_role'))
})

test('首step前路由抢占保留已claim消息，并自动续行且请求等待不能提前结束', { timeout: 10000 }, async t => {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  const { installFakeLlm } = await import('../packages/dingtalk-dsh-assistant/fake-llm.js')
  installFakeLlm(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const routeEntered = Promise.withResolvers(), routeRelease = Promise.withResolvers()
  class RouteModel extends LlmAdapter {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'route-yield', name: 'group_topic_route_submit', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'route-yield', name: 'group_topic_route_submit', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['native-route-yield'], new RouteModel())
  ctx.tools.register({ name: 'group_topic_route_submit', description: '原生路由结果边界', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) { manager.finish(manager.identity(exec.agent).request); return { accepted: true } },
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name === 'group_topic_route_submit') { routeEntered.resolve(); await routeRelease.promise }
    return next()
  })
  let held = false
  const manager = createCoordinationSessions({ isCurrent: () => true, onError: error => { throw error }, create: async entry => loop.createAgent(ctx, {
    sessionId: entry.sessionId, agentOptions: { provider: entry.role === 'route' ? 'native-route-yield' : 'fake-resident', model: 'fixture' }, setup(agentCtx) {
      const gate = createCoordinationStepGate(entry, () => true)
      agentCtx.on('agent/pre-step', async (event, next) => {
        if (entry.role === 'review' && !held) { held = true; entered.resolve(); await release.promise }
        return gate(event, next)
      })
    },
  }) })
  t.after(async () => { release.resolve(); routeRelease.resolve(); await manager.close(); await ctx.fiber.dispose() })
  const review = { groupId: 'g', requestId: 'coord-checkpoint-yield', kind: 'checkpoint' }
  const message = { ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '必须恢复的审阅消息' }] }), id: 'yielded-message' }
  const agent = await manager.dispatch(review, message)
  let settled = false
  const settlement = manager.whenSettled(review).then(() => { settled = true })
  await entered.promise
  const routing = manager.dispatch({ groupId: 'g', requestId: 'coord-route-priority' }, { ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '新入站' }] }), id: 'priority-route-message' })
  release.resolve()
  const routeAgent = await routing
  await routeEntered.promise
  await flush()
  assert.equal(settled, false, '路由抢占属于公平等待，不能让monitor启动失败重试')
  assert.equal(resultEvents(routeAgent).length, 0, '路由工具仍在post-execute边界')
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id).length, 0)
  assert.equal(agent.inbox.nextStep.filter(item => item.id === message.id).length, 1, 'pre-step已claim的消息不能在yield时消失')
  routeRelease.resolve()
  await settlement
  assert.equal(settled, true)
  assert.equal(manager.get('g', review), agent)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id).length, 1)
  assert.equal(agent.inbox.nextStep.length, 0)
})

test('审阅句柄尚在创建时入站路由排队，审阅首个模型step也必须先让路', { timeout: 10000 }, async t => {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  const { installFakeLlm } = await import('../packages/dingtalk-dsh-assistant/fake-llm.js')
  installFakeLlm(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const creating = Promise.withResolvers(), release = Promise.withResolvers(), order = []
  const manager = createCoordinationSessions({ isCurrent: () => true, onError: error => { throw error }, create: async entry => {
    if (entry.role === 'review') { creating.resolve(); await release.promise }
    return loop.createAgent(ctx, { sessionId: entry.sessionId, agentOptions: { provider: 'fake-resident', model: 'fixture' }, setup(agentCtx) {
      const gate = createCoordinationStepGate(entry, () => true)
      agentCtx.on('agent/pre-step', (event, next) => gate(event, () => { order.push(entry.role); return next() }))
    } })
  } })
  t.after(async () => { release.resolve(); await manager.close(); await ctx.fiber.dispose() })
  const message = (id) => ({ ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: id }] }), id })
  const reviewPending = manager.dispatch({ groupId: 'g', requestId: 'coord-checkpoint-creating', kind: 'checkpoint' }, message('review-creating'))
  await creating.promise
  const routePending = manager.dispatch({ groupId: 'g', requestId: 'coord-route-during-create' }, message('route-during-create'))
  release.resolve()
  const routeAgent = await routePending
  await routeAgent.whenIdle()
  await reviewPending
  assert.equal(order[0], 'route', '创建中的审阅不能越过已排队的新入站路由')
})
