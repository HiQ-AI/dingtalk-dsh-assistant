import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createCoordinationSessions, coordinationTools, createCoordinationStepGate } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'
import { createConversationRouterSessions } from '../packages/dingtalk-dsh-assistant/conversation-router-session.js'
import { createConversationRouter, runNativeTriage } from '../packages/dingtalk-dsh-assistant/conversation-router.js'
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
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.agentLoop
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
  return { ctx, store, snapshot, manager, start, disposed, errors, presented, stats: () => ({ modelCalls, engineeringWrites, submitCalls }) }
}

const resultEvents = agent => agent.session.snapshotEvents().filter(event => event.type === 'tool/result')

for (const phase of ['triage-create', 'triage', 'router']) test(`原生 ${phase} 关闭取消活动工具并恢复原来源`, { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-router-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  new JsonlSessionPersistence(h.ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  const started = Promise.withResolvers(), stopped = Promise.withResolvers()
  let block = true
  h.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'router_source_read' && block) {
      started.resolve()
      await new Promise((resolve, reject) => {
        const cancel = () => { stopped.resolve(); reject(exec.signal.reason) }
        if (exec.signal.aborted) cancel()
        else exec.signal.addEventListener('abort', cancel, { once: true })
      })
    }
    return next()
  })
  class StopModel extends LlmAdapter {
    async *stream(options) {
      const triage = options.tools.some(tool => tool.name === 'triage_submit')
      const name = block && (triage ? phase === 'triage' : phase === 'router') ? 'router_source_read' : triage ? 'triage_submit' : 'router_submit'
      const args = JSON.stringify(name === 'router_source_read' ? { sourceId: 'source-stop', offset: 0 }
        : triage ? { needsProcessing: true, reply: null }
          : { actions: [{ kind: 'new-task', sourceIds: ['source-stop'], title: '处理事项', objective: '处理测试事项' }], continuity: [], reply: null })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: name, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: name, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['router-stop-fixture'], new StopModel())
  await h.store.subscribe({ groupId: 'stop', responsibility: '测试关闭恢复' })
  await h.store.ingest({ groupId: 'stop', messageId: 'stop-message', text: '处理测试事项', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-stop', groupId: 'stop', messageId: 'stop-message', version: 1, actorId: 'actor', text: '处理测试事项' }
  const processed = [], applications = []
  const create = (ctx = h.ctx) => createConversationRouter({ ctx, store: h.store, workspaceRoot: root, agentPreset: 'test',
    selection: { provider: 'router-stop-fixture', model: 'fixture' }, readSources: async () => processed.length ? [] : [source],
    readSource: async () => source, readTasks: async () => [], readTask: async () => undefined,
    sourceProcessed: async value => { processed.push(value) }, applyRouterAction: async value => { applications.push(value); return { accepted: true } },
    prepareReply: async () => { throw new Error('unexpected_reply') }, isOwnSource: async () => false })
  const creating = { sessions: h.ctx.sessions, agents: { async create({ signal }) {
    started.resolve()
    await new Promise(resolve => signal.addEventListener('abort', () => { stopped.resolve(); resolve() }, { once: true }))
    signal.throwIfAborted()
  } } }
  const first = create(phase === 'triage-create' ? creating : h.ctx), running = first.schedule('stop')
  const result = running.catch(error => error)
  await started.promise
  const before = h.store.getRouterState('stop')
  if (phase === 'router') assert.equal(before.active.inputs[0].sourceRef.sourceId, source.sourceId)
  await first.close()
  await stopped.promise
  assert.equal((await result).code, 'ROUTER_CLOSED')
  const pending = h.store.getRouterState('stop')
  assert.deepEqual(pending.failures ?? [], [])
  assert.equal(processed.length, 0)
  assert.equal(applications.length, 0)
  if (phase === 'router') assert.equal(pending.active.batchId, before.active.batchId)
  else assert.equal(pending.triage.length, 0)
  block = false
  const second = create()
  try { await second.schedule('stop') } finally { await second.close() }
  assert.equal(processed.length, 1)
  assert.equal(applications.length, 1)
  assert.equal(applications[0].sourceRefs[0].sourceId, source.sourceId)
  assert.deepEqual(h.store.getRouterState('stop').failures ?? [], [])
})

test('原生首筛提交静默或处理意图并持久入队', { timeout: 10000 }, async t => {
  const h = await setup(t)
  const root = await mkdtemp(join(tmpdir(), 'native-router-triage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  let needsProcessing = false
  class TriageModel extends LlmAdapter {
    async *stream() {
      const args = JSON.stringify({ needsProcessing, reply: null }), id = `triage-${needsProcessing}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'triage_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'triage_submit', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['router-triage-fixture'], new TriageModel())
  for (const messageId of ['silent', 'work']) {
    await h.store.ingest({ groupId: 'g', messageId, text: '测试内容', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
    const source = { sourceId: `source-${messageId}`, groupId: 'g', messageId, version: 1, actorId: 'actor', text: '测试内容' }
    const receipt = await runNativeTriage({ ctx: h.ctx, store: h.store, groupId: 'g', source, workspaceRoot: root,
      agentPreset: 'native-test', selection: { provider: 'router-triage-fixture', model: 'fixture' }, isOwnSource: async () => false })
    assert.equal(receipt.disposition.needsProcessing, needsProcessing)
    needsProcessing = true
  }
  assert.deepEqual(h.store.getRouterState('g').queue.map(item => item.id), ['source-work'])
})

test('原生首筛与 Router 提交直接任务候选', { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-router-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mounted = []
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => { mounted.push(id); return { id } } })
  h.ctx.on('session/flush', () => {})
  class RouterModel extends LlmAdapter {
    async *stream(options) {
      const triage = options.tools.some(tool => tool.name === 'triage_submit')
      const payload = options.messages.flatMap(message => message.role === 'user' ? (message.content ?? []) : []).filter(block => block.type === 'text')
        .map(block => { try { return JSON.parse(block.text) } catch { return null } }).find(item => item?.context?.responsibility === '负责项目支持')
      assert.equal(payload.context.conversationType, 'group')
      assert.deepEqual(payload.context.agentNames, ['助手'])
      const name = triage ? 'triage_submit' : 'router_submit'
      const args = JSON.stringify(triage ? { needsProcessing: true, reply: null } : {
        actions: [{ kind: 'new-task', sourceIds: ['source-work'], title: '处理事项', objective: '处理测试事项' }], continuity: [], reply: null })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: name, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: name, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['router-run-fixture'], new RouterModel())
  await h.store.subscribe({ groupId: 'router-native', responsibility: '负责项目支持' })
  await h.store.setAgentNames(['助手'])
  await h.store.ingest({ groupId: 'router-native', messageId: 'work', text: '处理测试事项', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-work', groupId: 'router-native', messageId: 'work', version: 1, actorId: 'actor', text: '处理测试事项' }
  const applications = [], processed = []
  let selectionReads = 0, presetReads = 0
  const router = createConversationRouter({ ctx: h.ctx, store: h.store, workspaceRoot: root, agentPreset: () => `native-test-${++presetReads}`,
    selection: () => { selectionReads++; return { provider: 'router-run-fixture', model: 'fixture' } }, readSources: async () => processed.length ? [] : [source],
    readSource: async ({ sourceId }) => sourceId === source.sourceId ? source : undefined, readTasks: async () => [], readTask: async () => undefined,
    sourceProcessed: async args => { processed.push(args) }, applyRouterAction: async args => { applications.push(args); return { accepted: true } },
    prepareReply: async () => { throw new Error('unexpected_reply') }, isOwnSource: async () => false })
  t.after(() => router.close())
  await router.schedule('router-native')
  assert.equal(applications.length, 1)
  assert.equal(applications[0].action.kind, 'new-task')
  assert.deepEqual(applications[0].sourceRefs, [{ sourceId: 'source-work', messageId: 'work', messageVersion: 1 }])
  assert.equal(processed[0].phase, 'router')
  assert.equal(h.store.getRouterState('router-native').generation, 2)
  assert.deepEqual(mounted, ['native-test-1', 'native-test-2', 'native-test-3'])
  assert.equal(selectionReads, 3)
})

test('原生首筛仅接受可见审阅并固定回复来源', { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-reply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  let step = 0
  class ReplyModel extends LlmAdapter {
    async *stream() {
      const name = step++ ? 'triage_submit' : 'router_reply_review_get'
      if (step === 3) assert.equal(h.store.getRouterState('reply-native').triage.length, 0)
      const args = JSON.stringify(name === 'triage_submit' ? { needsProcessing: false, reply: step === 2 ? 'source-reply' : '收到', review: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } : {})
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: `reply-${step}`, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `reply-${step}`, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['reply-fixture'], new ReplyModel())
  await h.store.subscribe({ groupId: 'reply-native' })
  await h.store.ingest({ groupId: 'reply-native', messageId: 'm', text: '你好', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-reply', groupId: 'reply-native', messageId: 'm', version: 1, actorId: 'actor', text: '你好' }
  const receipt = await runNativeTriage({ ctx: h.ctx, store: h.store, groupId: 'reply-native', source, workspaceRoot: root,
    agentPreset: 'test', selection: { provider: 'reply-fixture', model: 'fixture' }, isOwnSource: async () => false })
  assert.equal(receipt.replyStatus, 'pending')
  assert.equal(receipt.disposition.replyReview.review.kind, 'confirmation')
  assert.deepEqual(receipt.sourceRef, { sourceId: 'source-reply', messageId: 'm', messageVersion: 1 })
  const calls = [], processed = []
  const prepareReply = async args => {
    calls.push(args)
    if (calls.length === 1) throw new Error('reply_prepare_failed')
    return { notificationId: `router-reply:${args.operationId}`, status: 'retired' }
  }
  prepareReply.reviewContract = 1
  const router = createConversationRouter({ ctx: h.ctx, store: h.store, workspaceRoot: root, agentPreset: 'test',
    selection: { provider: 'reply-fixture', model: 'fixture' }, readSources: async () => [], readSource: async () => source,
    readTasks: async () => [], readTask: async () => undefined, sourceProcessed: async args => processed.push(args),
    applyRouterAction: async () => assert.fail('unexpected task action'), prepareReply, isOwnSource: async () => false })
  t.after(() => router.close())
  await assert.rejects(router.schedule('reply-native'), /reply_prepare_failed/)
  const failure = h.store.getRouterState('reply-native').failures[0]
  assert.equal(failure.status, 'failed')
  await router.schedule('reply-native')
  assert.equal(calls.length, 1, '当前版本失败必须等待显式重试')
  await h.store.ingest({ groupId: 'reply-native', messageId: 'm', messageVersion: 2, text: '更新', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:01Z' })
  await assert.rejects(h.store.routerRetryFailure({ groupId: 'reply-native', messageId: 'm', messageVersion: 1,
    phase: failure.phase, requestId: failure.requestId, token: failure.retryToken }), /MESSAGE_RETRY_STALE/)
  await router.schedule('reply-native')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], calls[0], '退役仅复用原回复身份与审阅')
  assert.equal(h.store.getRouterState('reply-native').triage[0].replyStatus, 'applied')
  assert.deepEqual(h.store.getRouterState('reply-native').failures, [])
  assert.equal(processed.length, 1)
})

test('原生 Router 回复绑定模型指定来源和可见审阅', { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-router-reply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  h.ctx.on('session/flush', () => {})
  let step = 0
  class ReplyModel extends LlmAdapter {
    async *stream() {
      const calls = [
        ['triage_submit', { needsProcessing: true, reply: null }],
        ['router_submit', { actions: [], continuity: [], reply: null }],
        ['router_reply_review_get', { sourceId: 'source-reply' }],
        ['router_submit', { actions: [], continuity: [], reply: { sourceId: 'source-reply', text: '回复', atOpenDingTalkIds: ['unknown'], review: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }],
        ['router_submit', { actions: [], continuity: [], reply: { sourceId: 'source-reply', text: '回复', replyToMessageId: 'm2', atOpenDingTalkIds: ['actor'], review: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }],
        ['router_submit', { actions: [{ kind: 'new-task', sourceIds: ['source-reply'], title: '新任务', objective: '处理请求' }], continuity: [], reply: { sourceId: 'source-reply', text: 'source-other', review: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }],
        ['router_submit', { actions: [{ kind: 'new-task', sourceIds: ['source-reply'], title: '新任务', objective: '处理请求' }], continuity: [], reply: { sourceId: 'source-reply', text: 'source-other', replyToMessageId: 'm2', atOpenDingTalkIds: ['actor', 'actor2'], review: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] } } }],
        ['router_submit', { actions: [], continuity: [], reply: { sourceId: 'source-reply', text: '回复', replyToMessageId: 'm2', atOpenDingTalkIds: ['actor', 'actor2'], review: { kind: 'substantive', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] }, completion: { factId: 'fact', taskId: 'task', artifactIds: ['artifact'] } } }],
      ]
      const [name, value] = calls[step++]
      const args = JSON.stringify(value)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: `router-reply-${step}`, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `router-reply-${step}`, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['router-reply-fixture'], new ReplyModel())
  await h.store.subscribe({ groupId: 'router-reply-native' })
  await h.store.ingest({ groupId: 'router-reply-native', messageId: 'm', text: '你好', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-reply', groupId: 'router-reply-native', messageId: 'm', version: 1, actorId: 'actor', text: '你好' }
  await h.store.ingestHistory({ groupId: 'router-reply-native', messageId: 'm2', text: '参与核对', senderOpenDingTalkId: 'actor2', occurredAt: '2026-11-06T00:00:01Z' })
  const source2 = { sourceId: 'source-other', groupId: 'router-reply-native', messageId: 'm2', version: 1, actorId: 'actor2', text: '参与核对' }
  const file = { artifact: { artifactId: 'artifact', requirementRevision: 1, taskId: 'task' }, caption: '结果' }
  const body = { factId: 'fact', groupId: 'router-reply-native', kind: 'completed', result: { artifactFiles: [file] }, sourceIds: ['source-reply', 'source-other'], taskId: 'task', taskVersion: { requirementRevision: 1 } }
  const fact = { ...body, factDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
  const replies = [], processed = []
  const prepareReply = async args => { replies.push(args); if (replies.length === 1) throw new Error('reply_before_prepare'); return { notificationId: 'notification', status: 'retired' } }
  prepareReply.reviewContract = 1
  const router = createConversationRouter({ ctx: h.ctx, store: h.store, workspaceRoot: root, agentPreset: 'test',
    selection: { provider: 'router-reply-fixture', model: 'fixture' }, readSources: async () => processed.length ? [] : [source],
    readSource: async ({ sourceId }) => sourceId === source.sourceId ? source : source2, readTasks: async () => [], readTask: async () => null,
    sourceProcessed: async args => { processed.push(args) }, applyRouterAction: async () => { throw new Error('unexpected_action') },
    prepareReply, isOwnSource: async () => false })
  t.after(() => router.close())
  await router.schedule('router-reply-native')
  assert.equal(replies.length, 0)
  await h.store.routerEnqueueFact({ groupId: 'router-reply-native', fact })
  await assert.rejects(router.schedule('router-reply-native'), /reply_before_prepare/)
  assert.equal(h.store.getRouterState('router-reply-native').failures[0].status, 'failed')
  await router.schedule('router-reply-native')
  assert.equal(replies.length, 1)
  await h.store.ingest({ groupId: 'router-reply-native', messageId: 'm2', messageVersion: 2, text: '参与核对（更新）', senderOpenDingTalkId: 'actor2', occurredAt: '2026-11-06T00:00:02Z' })
  await router.schedule('router-reply-native')
  assert.equal(replies.length, 2)
  assert.deepEqual(replies[1], replies[0])
  assert.deepEqual(h.store.getRouterState('router-reply-native').failures, [])
  assert.deepEqual(replies[0].sourceRef, { sourceId: 'source-reply', messageId: 'm', messageVersion: 1 })
  assert.equal(replies[0].replyKind, 'substantive')
  assert.deepEqual(replies[0].notificationRouting, { replyToMessageId: 'm2', replyToSenderOpenDingTalkId: 'actor2',
    atOpenDingTalkIds: ['actor', 'actor2'], sourceRefs: [
      { sourceId: 'source-reply', messageId: 'm', messageVersion: 1, actorId: 'actor' },
      { sourceId: 'source-other', messageId: 'm2', messageVersion: 1, actorId: 'actor2' },
    ] })
  assert.deepEqual(replies[0].completion, { factId: 'fact', factDigest: fact.factDigest, taskId: 'task', taskVersion: fact.taskVersion, files: [file] })
  assert.equal(processed[0].phase, 'router')
})

test('已知未执行重审后以原决议完成来源，不重放已成功动作', { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  h.ctx.on('session/flush', () => {})
  const dependency = { taskId: 'task-a', requirementRevision: 1, contextRevision: 0, controlRevision: 1, runSequence: 1 }
  let step = 0
  class RetryModel extends LlmAdapter {
    async *stream() {
      const rejected = h.store.getRouterState('retry-native').decisions.flatMap(item => item.applications).find(item => item.status === 'rejected')
      const calls = [
        ['triage_submit', { needsProcessing: true, reply: null }],
        ['router_task_get', { taskId: 'task-a' }],
        ['router_submit', { actions: [{ kind: 'new-task', sourceIds: ['source-retry'], title: '后续', objective: '后续', dependencies: [dependency] }], continuity: [], reply: null }],
        ['router_task_get', { taskId: 'task-a' }],
        ['router_submit', { actions: [{ ...rejected?.action, retryOfOperationId: rejected?.operationId, sourceIds: ['source-retry'] }], continuity: [], reply: null }],
      ]
      const [name, value] = calls[step++]
      const args = JSON.stringify(value)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: `retry-${step}`, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `retry-${step}`, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['retry-fixture'], new RetryModel())
  await h.store.subscribe({ groupId: 'retry-native' })
  await h.store.ingest({ groupId: 'retry-native', messageId: 'm', text: '先甲再乙', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-retry', groupId: 'retry-native', messageId: 'm', version: 1, actorId: 'actor', text: '先甲再乙' }
  const applied = [], processed = []
  const router = createConversationRouter({ ctx: h.ctx, store: h.store, workspaceRoot: root, agentPreset: 'test',
    selection: { provider: 'retry-fixture', model: 'fixture' }, readSources: async () => processed.length ? [] : [source],
    readSource: async () => source, readTasks: async () => [], readTask: async () => ({ task: { ...dependency, status: 'completed', drained: true }, executions: [], operations: [] }),
    sourceProcessed: async args => { processed.push(args) }, applyRouterAction: async args => {
      applied.push(args)
      return applied.length === 1 ? { status: 'known-not-applied', code: 'DYNAMIC_ROUTER_DEPENDENCY_STALE', operationId: args.operationId, commandId: `router-operation:${args.operationId}` } : { accepted: true }
    }, prepareReply: async () => {}, isOwnSource: async () => false })
  t.after(() => router.close())
  await router.schedule('retry-native')
  assert.equal(applied.length, 2)
  assert.equal(applied[0].action.taskId, applied[1].action.taskId)
  assert.notEqual(applied[0].operationId, applied[1].operationId)
  assert.equal(processed.length, 1)
  assert.equal(processed[0].decisionId, applied[0].decisionId)
})

test('原生 Router 跨换代激活已持久安排', { timeout: 10000 }, async t => {
  const h = await setup(t), root = await mkdtemp(join(tmpdir(), 'native-arrangement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  h.ctx.provide('agentPresets', { mount: async (_ctx, id) => ({ id }) })
  h.ctx.on('session/flush', () => {})
  const task = { taskId: 'task-a', requirementRevision: 1, contextRevision: 1, controlRevision: 1, runSequence: 1 }
  let step = 0, ready = false
  class ArrangementModel extends LlmAdapter {
    async *stream() {
      const saved = h.store.getRouterState('arrangement-native').arrangements?.[0]
      const arrangementId = saved?.arrangementId
      const rejected = h.store.getRouterState('arrangement-native').decisions.flatMap(item => item.applications).find(item => item.status === 'rejected')
      const calls = [
        ['triage_submit', { needsProcessing: true, reply: null }],
        ['router_submit', { actions: [], arrangements: [{ sourceIds: ['source-a'], title: '乙', objective: '完成乙', dependsOnTaskIds: ['task-a'] }], continuity: [], reply: null }],
        ['router_source_read', { sourceId: 'source-a', offset: 0 }],
        ['router_task_get', { taskId: 'task-a' }],
        ['router_submit', { actions: [{ kind: 'new-task', arrangementId, sourceIds: ['source-a'], dependencies: [task] }], continuity: [], reply: null }],
        ['router_source_read', { sourceId: 'source-a', offset: 0 }],
        ['router_task_get', { taskId: 'task-a' }],
        ['router_submit', { actions: [{ ...rejected?.action, arrangementId, retryOfOperationId: rejected?.operationId, sourceIds: ['source-a'] }], continuity: [], reply: null }],
      ]
      const [name, value] = calls[step++] ?? (() => { throw new Error('unexpected_model_turn') })()
      const args = JSON.stringify(value)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: `${name}-${step}`, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${name}-${step}`, name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  h.ctx.llm.registerAdapter(['arrangement-fixture'], new ArrangementModel())
  await h.store.subscribe({ groupId: 'arrangement-native' })
  await h.store.ingest({ groupId: 'arrangement-native', messageId: 'm', text: '先做甲再做乙', senderOpenDingTalkId: 'actor', occurredAt: '2026-11-06T00:00:00Z' })
  const source = { sourceId: 'source-a', groupId: 'arrangement-native', messageId: 'm', version: 1, actorId: 'actor', text: '先做甲再做乙' }
  const applications = [], processed = []
  const router = createConversationRouter({ ctx: h.ctx, store: h.store, workspaceRoot: root, agentPreset: 'test',
    selection: { provider: 'arrangement-fixture', model: 'fixture' }, readSources: async () => processed.length ? [] : [source],
    readSource: async () => source, readTasks: async () => [task], readTask: async () => ({ task: { ...task, status: ready ? 'completed' : 'active', drained: ready }, executions: [], operations: [] }),
    sourceProcessed: async args => { processed.push(args) }, applyRouterAction: async args => {
      applications.push(args)
      return applications.length === 1 ? { status: 'known-not-applied', code: 'DYNAMIC_ROUTER_DEPENDENCY_STALE', operationId: args.operationId, commandId: `router-operation:${args.operationId}` } : { accepted: true }
    },
    prepareReply: async () => { throw new Error('unexpected_reply') }, isOwnSource: async () => false })
  t.after(() => router.close())
  await router.schedule('arrangement-native')
  const saved = h.store.getRouterState('arrangement-native').arrangements[0]
  assert.equal(saved.status, 'waiting')
  ready = true
  await router.schedule('arrangement-native')
  assert.equal(applications.length, 2)
  assert.equal(applications[0].action.taskId, saved.taskId)
  assert.equal(applications[1].action.taskId, saved.taskId)
  assert.notEqual(applications[0].operationId, applications[1].operationId)
  assert.equal(h.store.getRouterState('arrangement-native').arrangements[0].status, 'accepted')
  const completedSteps = step
  await router.recover()
  await router.recover()
  assert.equal(step, completedSteps)
  assert.equal(applications.length, 2)
})

test('原生 Router 候选持久检查和 maintenance 内换代', { timeout: 10000 }, async t => {
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false })
  new LlmRuntime(ctx)
  new ToolRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  let binding = { groupId: 'g', conversationType: 'group', conversationId: 'g', generation: 1, lease: 1, sessionId: 'native-router-1' }
  const create = value => ctx.agentLoop.createAgent(ctx, { sessionId: value.sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const manager = createConversationRouterSessions({ ctx, create, resume: create, isCurrent: value => JSON.stringify(value) === JSON.stringify(binding) })
  t.after(async () => { await manager.close(); await ctx.fiber.dispose() })
  await assert.rejects(manager.prepare({ binding }), /NOT_DURABLE/)
  let flushes = 0
  ctx.on('session/flush', () => { flushes++ })
  await manager.prepare({ binding })
  await manager.activate({ newBinding: binding })
  const oldBinding = binding
  const candidate = { ...binding, generation: 2, lease: undefined, sessionId: 'native-router-2' }
  await manager.prepare({ binding: candidate })
  const next = { ...candidate, lease: 2 }
  await manager.withIdle({ binding }, async () => { binding = next })
  await manager.activate({ oldBinding, newBinding: next })
  assert.equal(ctx.sessions.get(oldBinding.sessionId), undefined)
  assert.ok(ctx.sessions.get(next.sessionId))
  assert.equal(flushes, 2)
})

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
  assert.notEqual(resultEvents(agent)[0].data.message.isError, true)
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
  assert.equal(results[0].data.message.isError, true)
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
  assert.equal(resultEvents(agent)[0].data.message.isError, true)
  assert.ok(JSON.stringify(resultEvents(agent)[0]).includes('coordination_tool_outside_role'))
})

test('首step前路由抢占保留已claim消息，并自动续行且请求等待不能提前结束', { timeout: 10000 }, async t => {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  const { installFakeLlm } = await import('../packages/dingtalk-dsh-assistant/fake-llm.js')
  installFakeLlm(ctx)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.agentLoop
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
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.agentLoop
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
