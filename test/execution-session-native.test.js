import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createExecutionSessions } from '../packages/dingtalk-dsh-assistant/execution-session.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')

const self = fileURLToPath(import.meta.url)
const artifacts = resolve(dirname(self), '../docs/tmp/execution-session-native')
const binding = (extra = {}) => ({ taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, leaseEpoch: 1, inputDigest: 'input-R1', sessionId: 'session-node-r1', sessionBound: false, ...extra })
const definition = (extra = {}) => ({ provider: 'execution-fixture', model: 'scripted', prompt: 'R1_OLD_MARKER_30ba', allowedTools: ['read_fixture'], outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...extra })
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const submit = answer => ({ name: 'execution_node_submit', args: { output: { answer } } })
const leases = events => [...new Set(events.flatMap(event => event.type === 'dingtalk/execution-session' ? [event.data.creationLease]
  : event.type === 'user/message' && event.data.source.executionSession ? [event.data.source.executionSession.leaseEpoch] : []))]
async function temp() { await mkdir(artifacts, { recursive: true }); return mkdtemp(join(artifacts, 'run-')) }

// 只有 LlmAdapter 为脚本；每次 Host 都用真实原生 Loop、Tools、文件 JSONL 后端。
async function host({ root, script = [submit('done')], isCurrent = async () => true } = {}) {
  root ??= await temp()
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = [], reads = [], effects = [], handles = []
  await writeFile(join(root, 'fixture.txt'), 'NATIVE_READ_VALUE_922d')
  ctx.on('agent/created', ({ agent }) => { handles.push(agent) })
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(JSON.parse(JSON.stringify(options)))
      const next = typeof script === 'function' ? script(requests.length) : script[requests.length - 1]
      if (!next) throw new Error('unexpected model continuation')
      if (next.name) {
        const id = 'call-' + requests.length, args = JSON.stringify(next.args ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: next.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['execution-fixture'], new Scripted())
  ctx.tools.register({ name: 'read_fixture', description: '读取测试文件', parameters: { type: 'object' }, output,
    async execute(_args, exec) { const text = await readFile(join(root, 'fixture.txt'), { encoding: 'utf8', signal: exec.signal }); reads.push(exec.agent.session.id); return { text } },
  })
  ctx.tools.register({ name: 'unsafe_write', description: '用于拒绝测试的副作用', parameters: { type: 'object' }, output, execute() { effects.push('root-write'); return {} } })
  const manager = createExecutionSessions({ ctx, isCurrent })
  return { ctx, root, manager, requests, reads, effects, handles, async close() { await manager.close(); await ctx.fiber.dispose() } }
}

function drive(h, extra = {}) {
  return h.manager.run({ binding: binding(), input: { requirement: 'read and submit' }, definition: definition(), onSessionBound: async () => {}, onResult: async () => {}, ...extra })
}

async function processPhase(root, phase) {
  const h = await host({ root, script: phase === 'initial' ? [{ name: 'read_fixture' }, submit('first')] : [submit('resumed')] })
  try {
    const result = await drive(h, { binding: binding({ leaseEpoch: phase === 'initial' ? 1 : 2, sessionBound: phase !== 'initial' }) })
    const persisted = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    await writeFile(join(root, phase + '.json'), JSON.stringify({ pid: process.pid, result, events: persisted.events, requests: h.requests }))
  } finally { await h.close() }
}

if (process.argv[2] === '--execution-session-child') {
  await processPhase(process.argv[3], process.argv[4])
} else {
  test('正式适配器：两次读取同Session，先持久绑定，提交结果排空后仅回调业务output', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'read_fixture' }, { name: 'read_fixture' }, submit('complete')] })
    t.after(() => h.close())
    let bound = false, completed = 0
    const result = await drive(h, {
      onSessionBound: async () => {
        assert.equal(h.requests.length, 0)
        const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
        assert.equal(durable.events[0].type, 'dingtalk/execution-session')
        assert.equal(durable.events[0].data.identity.inputDigest, 'input-R1')
        assert.equal(durable.events[0].data.creationLease, 1)
        assert.equal(durable.events[0].ignorable, true)
        bound = true
      },
      onResult: async value => {
        assert.equal(bound, true)
        assert.deepEqual(value, { answer: 'complete' })
        assert.equal(h.ctx.agents.get(binding().sessionId), undefined)
        const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
        assert.equal(durable.events.filter(e => e.type === 'tool/result').length, 3)
        completed++
      },
    })
    assert.deepEqual(result, { status: 'submitted', output: { answer: 'complete' } })
    assert.equal(completed, 1)
    assert.deepEqual(h.reads, [binding().sessionId, binding().sessionId])
    assert.equal(h.requests.length, 3)
    assert.ok(h.requests.every(request => request.tools.map(tool => tool.name).sort().join(',') === 'execution_node_submit,read_fixture'))
    assert.ok(JSON.stringify(h.requests[1]).includes('NATIVE_READ_VALUE_922d'))
    await delay(100)
    assert.equal(h.requests.length, 3)
    assert.equal(h.ctx.get('goals'), undefined)
  })

  test('无提交和输出schema失败均结束attempt，不反复调用模型', { timeout: 10000 }, async t => {
    for (const [script, expected] of [[[{ text: 'waiting' }], 'execution_no_submission'], [[{ name: 'execution_node_submit', args: { output: { answer: 42 }, taskId: 'forged' } }], 'execution_output_invalid']]) {
      const h = await host({ script }); t.after(() => h.close())
      let callbacks = 0
      const result = await drive(h, { onResult: async () => { callbacks++ } })
      assert.deepEqual(result, { status: 'no_submission', reason: expected })
      await delay(60)
      assert.equal(callbacks, 0); assert.equal(h.requests.length, 1)
    }
  })

  test('restrict隐藏继承写工具，单调guard拒绝scope-local写和恶意调用', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'unsafe_write' }] }); t.after(() => h.close())
    h.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.register({ name: 'unsafe_write', description: 'scope本地绕过restrict展示的反例', parameters: { type: 'object' }, output, execute() { h.effects.push('local-write'); return {} } })
      agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    })
    const result = await drive(h)
    assert.equal(result.status, 'no_submission')
    assert.equal(result.reason, 'execution_tool_not_allowed')
    assert.deepEqual(h.effects, [])
    assert.equal(h.requests.length, 1)
    const stored = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.ok(JSON.stringify(stored.events).includes('execution_tool_not_allowed'))
  })

  test('首step与submit前检查当前租约；过期状态不交付业务output', { timeout: 10000 }, async t => {
    let current = true
    const h = await host({ isCurrent: async () => current }); t.after(() => h.close())
    let submitted = 0
    const result = await drive(h, { onSessionBound: async () => { current = false }, onResult: async () => { submitted++ } })
    assert.equal(result.status, 'stale'); assert.equal(h.requests.length, 0); assert.equal(submitted, 0)
    const h2 = await host(); t.after(() => h2.close())
    let fence = true
    const scoped = createExecutionSessions({ ctx: h2.ctx, isCurrent: async () => fence })
    t.after(() => scoped.close())
    h2.ctx.on('tools/post-execute', async (_exec, _result, next) => { fence = false; return next() })
    const second = await scoped.run({ binding: binding(), input: {}, definition: definition(), onSessionBound: async () => {}, onResult: async () => { submitted++ } })
    assert.equal(second.status, 'stale'); assert.equal(submitted, 0)
  })

  test('bound Session缺失或既有Session身份未知不得新建/认领', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.close())
    await assert.rejects(drive(h, { binding: binding({ sessionBound: true }) }), { code: 'execution_session_missing' })
    assert.equal(h.ctx.sessions.get(binding().sessionId), undefined)
    const foreign = await h.ctx.agents.create({ sessionId: binding().sessionId })
    foreign.agent.session.append('session/title', { title: 'unrelated' })
    await h.ctx.sessions.flush(foreign.agent.session); await foreign.dispose()
    await assert.rejects(drive(h), { code: 'execution_session_identity_mismatch' })
    assert.equal(h.requests.length, 0)
  })

  test('create后bind失败：持久身份可恢复，须递增lease；同身份错digest仍拒绝', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.close())
    await assert.rejects(drive(h, { onSessionBound: async () => { throw new Error('control_store_unavailable') } }), /control_store_unavailable/)
    assert.equal(h.requests.length, 0)
    await assert.rejects(drive(h), { code: 'execution_session_lease_not_advanced' })
    await assert.rejects(drive(h, { binding: binding({ inputDigest: 'wrong', leaseEpoch: 2 }) }), { code: 'execution_session_identity_mismatch' })
    const result = await drive(h, { binding: binding({ leaseEpoch: 2, sessionBound: false }) })
    assert.equal(result.status, 'submitted')
    const stored = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.equal(stored.events.filter(e => e.type === 'dingtalk/execution-session').length, 1)
    assert.deepEqual(leases(stored.events), [1, 2])
  })

  test('R1输入失效后新generation新Session实际请求不含旧规则或历史', { timeout: 10000 }, async t => {
    const h = await host({ script: [submit('first'), submit('second')] }); t.after(() => h.close())
    await drive(h)
    await drive(h, { binding: binding({ sessionId: 'session-node-r2', generation: 2, inputDigest: 'input-R2', leaseEpoch: 2 }), definition: definition({ prompt: 'R2_NEW_MARKER_591c' }) })
    assert.ok(JSON.stringify(h.requests[0]).includes('R1_OLD_MARKER_30ba'))
    assert.ok(JSON.stringify(h.requests[1]).includes('R2_NEW_MARKER_591c'))
    assert.ok(!JSON.stringify(h.requests[1]).includes('R1_OLD_MARKER_30ba'))
    assert.ok(!JSON.stringify(h.requests[1]).includes('"answer":"first"'))
  })

  test('真实post-execute未结束不回调；取消和close等待工具退出，期间不能创建替身', { timeout: 10000 }, async t => {
    const h = await host()
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(async () => { release.resolve(); await h.close() })
    h.ctx.on('tools/post-execute', async (exec, _result, next) => { if (exec.name === 'execution_node_submit') { entered.resolve(); await release.promise }; return next() })
    let callbacks = 0
    const running = drive(h, { onResult: async () => { callbacks++ } })
    await entered.promise
    let cancelled = false
    const cancellation = h.manager.cancel(binding().runId).then(() => { cancelled = true })
    await delay(70)
    assert.equal(callbacks, 0); assert.equal(cancelled, false)
    assert.ok(h.ctx.agents.get(binding().sessionId))
    await assert.rejects(drive(h, { binding: binding({ leaseEpoch: 2 }) }), { code: 'execution_run_busy', executionDrained: false })
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_run_busy', executionDrained: false })
    release.resolve()
    await cancellation
    assert.deepEqual(await running, { status: 'cancelled' })
    assert.equal(callbacks, 0); assert.equal(h.requests.length, 1)
    assert.equal(h.ctx.agents.get(binding().sessionId), undefined)
    assert.equal(h.manager.assertDrained(binding()), true)
    const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.equal(durable.events.filter(e => e.type === 'tool/result').length, 1)

    const h2 = await host({ script: [{ name: 'held_read' }, { name: 'unsafe_write' }] })
    const toolEntered = Promise.withResolvers(), toolExit = Promise.withResolvers()
    h2.ctx.tools.register({ name: 'held_read', description: '可取消但须等待退出的实际异步工具', parameters: { type: 'object' }, output,
      async execute(_args, exec) { toolEntered.resolve(); await toolExit.promise; exec.signal.throwIfAborted(); return {} },
    })
    t.after(async () => { toolExit.resolve(); await h2.close() })
    const active = drive(h2, { definition: definition({ allowedTools: ['held_read', 'unsafe_write'] }) })
    await toolEntered.promise
    let closed = false
    const closing = h2.manager.close().then(() => { closed = true })
    await delay(70); assert.equal(closed, false)
    toolExit.resolve(); await closing
    assert.deepEqual(await active, { status: 'cancelled' })
    assert.equal(h2.requests.length, 1); assert.deepEqual(h2.effects, [])
  })

  test('实际JSONL跨OS进程恢复正式模块：原日志前缀不变，lease增加，旧工具结果进入新请求', { timeout: 15000 }, async () => {
    const root = await temp()
    for (const phase of ['initial', 'resume']) {
      const child = spawn(process.execPath, [self, '--execution-session-child', root, phase], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
      child.stdout.resume()
      const exit = await new Promise((resolveChild, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveChild({ code, signal })) })
      assert.equal(exit.code, 0, stderr)
    }
    const initial = JSON.parse(await readFile(join(root, 'initial.json'), 'utf8'))
    const resumed = JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'))
    assert.notEqual(initial.pid, resumed.pid)
    assert.deepEqual(resumed.events.slice(0, initial.events.length), initial.events)
    assert.deepEqual(leases(resumed.events), [1, 2])
    assert.equal(resumed.events.filter(e => e.type === 'dingtalk/execution-session').length, 1)
    assert.equal(resumed.requests.length, 1)
    assert.ok(JSON.stringify(resumed.requests[0]).includes('NATIVE_READ_VALUE_922d'))
    assert.equal(resumed.result.status, 'submitted')
  })

  test('重复合法工具读取受maxSteps约束；timeout取消后仍须等真实工具排空', { timeout: 10000 }, async t => {
    const h = await host({ script: () => ({ name: 'read_fixture' }) }); t.after(() => h.close())
    const result = await drive(h, { definition: definition({ maxSteps: 3 }) })
    assert.deepEqual(result, { status: 'no_submission', reason: 'execution_step_budget_exhausted' })
    assert.equal(h.requests.length, 3); assert.equal(h.reads.length, 3)
    await delay(60); assert.equal(h.requests.length, 3)
    const slow = await host({ script: [{ name: 'slow_tool' }] })
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(async () => { release.resolve(); await slow.close() })
    slow.ctx.tools.register({ name: 'slow_tool', description: '超时后仍排空', parameters: { type: 'object' }, output,
      async execute(_args, exec) { entered.resolve(); await release.promise; exec.signal.throwIfAborted(); return {} },
    })
    let completed = false
    const active = drive(slow, { definition: definition({ allowedTools: ['slow_tool'], timeoutMs: 100 }) }).then(value => { completed = true; return value })
    await entered.promise; await delay(150)
    assert.equal(completed, false); assert.ok(slow.ctx.agents.get(binding().sessionId))
    release.resolve()
    assert.deepEqual(await active, { status: 'no_submission', reason: 'execution_timeout' })
    assert.equal(slow.requests.length, 1)
  })

  test('定义仅快照执行字段；排空持久化失败明确标记未证明排空并保留占位', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.ctx.fiber.dispose())
    let failFlush = false
    h.ctx.on('session/flush', () => { if (failFlush) throw new Error('durability_unavailable') })
    await assert.rejects(drive(h, { definition: definition({ mapInput: () => ({}) }), onSessionBound: async () => { failFlush = true } }), { code: 'execution_session_drain_failed', executionDrained: false })
    await assert.rejects(h.manager.cancel(binding().runId), { code: 'execution_session_drain_failed', executionDrained: false })
    await assert.rejects(drive(h, { binding: binding({ leaseEpoch: 2 }) }), { code: 'execution_run_busy' })
    failFlush = false
  })

  test('未知所有者的真实原生句柄拒绝标记未排空，cancel与恢复检查不得取消或认领它', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'foreign_hold' }, { text: 'finished' }] })
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    let exited = false, aborted = false, foreign
    t.after(async () => { release.resolve(); await foreign?.dispose(); await h.close() })
    h.ctx.tools.register({ name: 'foreign_hold', description: '另一所有者的原生在途工具', parameters: { type: 'object' }, output,
      async execute(_args, exec) { entered.resolve(); await release.promise; aborted = exec.signal.aborted; exited = true; return {} },
    })
    foreign = await h.ctx.agents.create({ sessionId: binding().sessionId, agentOptions: { provider: 'execution-fixture', model: 'scripted' } })
    foreign.agent.steer(createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: 'foreign owner' }] }))
    await entered.promise
    await assert.rejects(drive(h, { binding: binding({ sessionBound: true, leaseEpoch: 2 }) }), { code: 'execution_session_already_live', executionDrained: false })
    await h.manager.cancel(binding().runId)
    assert.equal(h.ctx.agents.get(binding().sessionId), foreign.agent)
    assert.equal(foreign.agent.status, 'running'); assert.equal(exited, false)
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_session_already_live', executionDrained: false })
    release.resolve(); await foreign.agent.whenIdle()
    assert.equal(aborted, false, '适配器不能取消未知所有者的原生句柄')
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_session_already_live', executionDrained: false })
    await foreign.dispose()
    assert.equal(h.manager.assertDrained(binding()), true)
    assert.equal(h.manager.assertDrained({ runId: 'code-run', sessionId: null }), true)
  })
}
