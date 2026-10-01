import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createGroupCoordinatorSessions } from '../packages/dingtalk-dsh-assistant/group-coordinator-session.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const decision = { kind: 'no_action', reason: '人际闲聊' }
const decisionSchema = { type: 'object', properties: { kind: { type: 'string' }, reason: { type: 'string' } }, required: ['kind', 'reason'], additionalProperties: false }
async function host(root) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const id = `call-${requests.length}`, name = requests.length === 1 ? 'read_material' : 'group_coordinator_submit'
      const args = JSON.stringify(name === 'read_material' ? { ref: 'file' } : { decision })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['group-fixture'], new Scripted())
  let lease = 1
  const sessions = createGroupCoordinatorSessions({ ctx, isCurrent: async b => b.leaseEpoch === lease })
  return { ctx, requests, sessions, setLease(n) { lease = n }, async close() { await sessions.close(); await ctx.fiber.dispose() } }
}

test('原生群会话同轮读取材料后提交，跨轮恢复同一session并保留历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let reads = 0, candidates = 0
  const terminalResults = []
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'group_coordinator_submit') terminalResults.push(result.concludesTurn === true) })
  const run = leaseEpoch => h.sessions.run({ binding: { conversationId: 'group', sessionId: 'group-session', turnId: `turn-${leaseEpoch}`, leaseEpoch, sessionBound: leaseEpoch > 1 },
    input: { messages: [{ actorId: 'user', text: '核对材料后按已有任务推进' }] }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async value => { candidates++; assert.deepEqual(value, decision) },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取授权材料', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async ({ ref }) => { assert.equal(ref, 'file'); reads++; return { text: '真实材料内容' } } }] })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.equal(reads, 1); assert.equal(candidates, 2)
  assert.deepEqual(terminalResults, [true, true])
  const persisted = await h.ctx.sessionPersistence.inspect('group-session')
  assert.equal(persisted.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 1)
  assert.equal(persisted.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
  assert.equal(h.requests.length, 3)
  await assert.rejects(run(2), /LEASE_NOT_ADVANCED/)
})

test('原生群会话候选任务版本过期可反馈并重新提交，不新建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { if (++submissions === 1) throw Object.assign(Error('TASK_VERSION_STALE'), { code: 'TASK_VERSION_STALE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 2)
  assert.equal(h.requests.length, 3)
})


test('群逻辑会话跨原生宿主重启恢复，禁止注入写工具', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tool = { name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }
  const args = { binding: { conversationId: 'g', sessionId: 'restart-session', turnId: 'first', leaseEpoch: 1, sessionBound: false }, input: { message: '先审查' }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    readTools: [tool], onSessionBound: async () => {}, onCandidate: async () => {} }
  const first = await host(root)
  assert.equal((await first.sessions.run(args)).status, 'submitted')
  await first.close()
  const second = await host(root); t.after(() => second.close()); second.setLease(2)
  const next = { ...args, binding: { ...args.binding, turnId: 'second', leaseEpoch: 2, sessionBound: true }, input: { message: '原需求补充' } }
  await assert.rejects(second.sessions.run({ ...next, readTools: [{ ...tool, effectClass: 'write' }] }), /READ_TOOL_REQUIRED/)
  assert.equal((await second.sessions.run(next)).status, 'submitted')
  const saved = await second.ctx.sessionPersistence.inspect('restart-session')
  assert.equal(saved.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 1)
  assert.equal(saved.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
})


for (const stop of ['cancel', 'close']) test(`同群会话互斥，${stop}等待原生工具排空后释放会话`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const started = Promise.withResolvers()
  const args = { binding: { conversationId: 'g', sessionId: 'cancel-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async () => { throw Error('不得提交') },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async (_args, exec) => {
        started.resolve()
        await new Promise((resolve, reject) => { if (exec.signal.aborted) reject(exec.signal.reason); else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true }) })
        return {}
      } }] }
  const running = h.sessions.run(args)
  await started.promise
  await assert.rejects(h.sessions.run(args), /GROUP_COORDINATOR_BUSY/)
  if (stop === 'close') await h.sessions.close()
  else await h.sessions.cancel('g')
  assert.equal((await running).status, 'cancelled')
  assert.equal(h.ctx.agents.get('cancel-session'), undefined)
})

test('来源版本过期结束旧claim，不在旧来源上反复提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { submissions++; throw Object.assign(Error('MESSAGE_STALE'), { code: 'MESSAGE_STALE' }) } })
  assert.equal(result.status, 'stale'); assert.equal(result.reason, 'MESSAGE_STALE'); assert.equal(submissions, 1)
  assert.equal(h.requests.length, 2)
})


test('原生会话超过32次合法反馈仍可继续提交，不设自造步数上限', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-unbounded-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const result = await h.sessions.run({ binding: { conversationId: 'group', sessionId: 'unbounded', turnId: 'turn', leaseEpoch: 1, sessionBound: false },
    input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {},
    onCandidate: async () => { if (++submissions <= 33) throw Object.assign(new Error('合并重复动作'), { code: 'GROUP_COORDINATOR_EXISTING_TASK_REQUIRES_UPDATE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 34)
})
