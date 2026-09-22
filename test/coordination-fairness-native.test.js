import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createCoordinationSessions, createCoordinationStepGate } from '../packages/dingtalk-dsh-assistant/coordination-sessions.js'

const requireGoal = createRequire(import.meta.resolve('@deepseek-ai/dsh-goal'))
const { SessionProjectionRegistry } = requireGoal('@deepseek-ai/dsh-session-projection')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('自动续行排队期间finish、版本失效和close均唤醒请求级等待者', { timeout: 10000 }, async t => {
  for (const mode of ['finish', 'supersede', 'close']) await t.test(mode, async () => {
    const a = { groupId: 'g', requestId: 'coord-decision-a' }, b = { groupId: 'g', requestId: 'coord-decision-b' }
    const current = new Set([a, b]), handles = new Map()
    const manager = createCoordinationSessions({ isCurrent: request => current.has(request), onError: error => { throw error }, create: async entry => {
      const idle = Promise.withResolvers(), events = []
      const agent = { inbox: { nextStep: [], nextTurn: [], prepend() {} }, session: { id: entry.sessionId, snapshotEvents: () => events, append(type, data) { events.push({ type, data }) } }, steer(message) { events.push({ type: 'user/message', data: message }) }, whenIdle: () => idle.promise, cancel() { idle.resolve() } }
      handles.set(entry.request, { agent, idle, gate: createCoordinationStepGate(entry, request => current.has(request)) })
      return { agent, async dispose() {} }
    } })
    try {
      await manager.dispatch(a, { id: 'a' })
      let settled = false
      const waiting = manager.whenSettled(a).then(() => { settled = true })
      const first = handles.get(a)
      await first.gate({ agent: first.agent, messages: [] }, () => ({}))
      const second = manager.dispatch(b, { id: 'b' })
      assert.deepEqual(await first.gate({ agent: first.agent, messages: [] }, () => { throw new Error('must yield') }), { kind: 'reject' })
      first.idle.resolve(); await second; await tick()
      assert.equal(settled, false)
      if (mode === 'finish') manager.finish(a)
      if (mode === 'supersede') { current.delete(a); handles.get(b).idle.resolve() }
      if (mode === 'close') await manager.close()
      await waiting
      assert.equal(settled, true)
    } finally { await manager.close() }
  })
})

// 独立原生调度反例：共享 lifecycle 测试专注终态清理，此处核验未终态长轮次的公平性。
test('同群九次无效提交按step让出，工具结果落稳后路由和其他话题先运行且不cancel', { timeout: 10000 }, async t => {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers()
  const otherEntered = Promise.withResolvers(), otherRelease = Promise.withResolvers()
  const current = new Set(), calls = new Map(), agents = new Map(), order = [], errors = []
  let inModel = 0, peak = 0, cancellations = 0
  const request = id => { const value = { groupId: 'g', requestId: id }; current.add(value); return value }
  const a = request('coord-decision-a'), b = request('coord-decision-b'), review = request('coord-checkpoint-review'), route = request('coord-route-new')
  class Model extends LlmAdapter {
    constructor(entry) { super(); this.entry = entry }
    async *stream() {
      inModel++; peak = Math.max(peak, inModel)
      try {
        const key = this.entry.request.requestId, count = (calls.get(key) ?? 0) + 1
        calls.set(key, count); order.push(key)
        assert.ok(count <= 10, '不能因让出丢失提交结果并无限重试')
        const id = `${key}-${count}`, name = 'submit', args = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } finally { inModel-- }
    }
  }
  const manager = createCoordinationSessions({ isCurrent: value => current.has(value), onError: error => errors.push(error), create: async entry => {
    ctx.llm.registerAdapter([entry.sessionId], new Model(entry))
    const handle = await loop.createAgent(ctx, { sessionId: entry.sessionId, agentOptions: { provider: entry.sessionId, model: 'fixture' }, setup(agentCtx) {
      agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, value => current.has(value)))
      agentCtx.tools.register({ name: 'submit', description: '确定性协调提交', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute() {
        const count = calls.get(entry.request.requestId)
        if (entry.request === a && count <= 9) return { accepted: false, error: 'invalid_submission' }
        current.delete(entry.request); manager.finish(entry.request)
        if (!current.size) done.resolve()
        return { accepted: true }
      } })
      agentCtx.on('tools/post-execute', async (_exec, _result, next) => {
        if (entry.request === a && calls.get(a.requestId) === 1) { entered.resolve(); await release.promise }
        if (entry.request === b) { otherEntered.resolve(); await otherRelease.promise }
        return next()
      })
    } })
    let disposing = false
    const cancel = handle.agent.cancel.bind(handle.agent)
    handle.agent.cancel = (...args) => { if (!disposing) cancellations++; return cancel(...args) }
    agents.set(entry.request, handle.agent)
    return { agent: handle.agent, async dispose() { disposing = true; await handle.dispose() } }
  } })
  t.after(async () => { release.resolve(); otherRelease.resolve(); await manager.close(); await ctx.fiber.dispose() })
  const dispatch = value => manager.dispatch(value, createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: value.requestId }] }))
  const first = await dispatch(a)
  let settled = false
  const settlement = manager.whenSettled(a).then(() => { settled = true })
  await entered.promise
  const queued = [dispatch(b), dispatch(review), dispatch(route)]
  await tick(); await tick()
  assert.deepEqual(order, [a.requestId], 'post-execute仍在执行，禁止其他模型进入')
  assert.equal(first.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0)
  assert.equal(settled, false)
  release.resolve()
  await otherEntered.promise
  await tick()
  assert.equal(settled, false, '量子让出后的idle不是请求自主执行结束')
  assert.equal(calls.get(a.requestId), 1)
  assert.equal(first.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 1)
  otherRelease.resolve()
  await Promise.all(queued); await done.promise
  await Promise.all([...agents.values()].map(agent => agent.whenIdle()))
  await settlement
  assert.deepEqual(order.slice(0, 4), [a.requestId, route.requestId, b.requestId, review.requestId])
  assert.equal(calls.get(a.requestId), 10)
  assert.equal(first.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 10)
  assert.equal(peak, 1)
  assert.equal(cancellations, 0)
  assert.deepEqual(errors, [])
})
