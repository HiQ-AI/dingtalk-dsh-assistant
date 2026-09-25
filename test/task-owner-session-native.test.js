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
import { createTaskOwnerSessions } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const decision = { action: 'advance', summary: '启动已登记的第一阶段', evidenceRefs: [] }

async function host(root) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false,
    compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const id = `call-${requests.length}`, args = JSON.stringify({ decision })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'task_owner_submit', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'task_owner_submit', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['owner-fixture'], new Scripted())
  let currentLease = 1
  const sessions = createTaskOwnerSessions({ ctx, isCurrent: async binding => binding.leaseEpoch === currentLease })
  return { ctx, sessions, requests, setLease(value) { currentLease = value },
    async close() { await sessions.close(); await ctx.fiber.dispose() } }
}

test('同一个业务 Task 的原生 Owner 会话跨唤醒复用并持久记录候选', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  const taskId = 'task-1', sessionId = 'owner-task-1', seen = []
  const run = leaseEpoch => h.sessions.run({ binding: { taskId, sessionId,
    turnId: `turn-${leaseEpoch}`, leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 },
    input: { taskId, eventWatermark: leaseEpoch }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => { seen.push(`bound-${leaseEpoch}`) },
    onCandidate: async value => { seen.push(`candidate-${leaseEpoch}`); assert.deepEqual(value, decision) } })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.deepEqual(seen, ['bound-1', 'candidate-1', 'bound-2', 'candidate-2'])
  const saved = await h.ctx.sessionPersistence.inspect(sessionId)
  assert.equal(saved.events.filter(event => event.type === 'dingtalk/task-owner-session').length, 1)
  assert.equal(saved.events.filter(event => event.type === 'user/message').length, 2)
  assert.equal(h.requests.length, 2)
  assert.ok(h.requests.every(request => request.tools.map(tool => tool.name).join(',') === 'task_owner_submit'))
})

test('已绑定的负责人会话缺失时拒绝另建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  h.setLease(2)
  await assert.rejects(h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'missing-session',
    turnId: 'turn-2', leaseEpoch: 2, ownerEpoch: 1, sessionBound: true },
    input: { taskId: 'task-1' }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => {}, onCandidate: async () => {} }),
  { code: 'TASK_OWNER_SESSION_MISSING' })
  assert.equal(h.requests.length, 0)
})

test('会话存储读故障原样阻断，不能伪装为可重建的缺失', async () => {
  const ctx = { agents: { get: () => null }, sessions: { get: () => null },
    sessionPersistence: { inspect: async () => { throw Object.assign(new Error('disk-read-failed'), { code: 'EIO' }) } } }
  const sessions = createTaskOwnerSessions({ ctx, isCurrent: async () => true })
  await assert.rejects(sessions.run({ binding: { taskId: 'task-1', sessionId: 'session-1',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: true }, input: {},
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => {} }), { code: 'EIO' })
  await sessions.close()
})
