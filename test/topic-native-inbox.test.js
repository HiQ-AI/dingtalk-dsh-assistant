import { inboxHasPending } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { stableId } from '../packages/dingtalk-dsh-assistant/topic-model.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')

async function nativeAgent(t, id, snapshot) {
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const loop = ctx.agentLoop
  t.after(() => ctx.fiber.dispose())
  if (!snapshot) return loop.create(id)
  // 文件快照通过公开 persistence/AgentLoop.resume 边界重建，不导入 driver 私有 Inbox。
  const events = structuredClone(snapshot.events)
  ctx.provide('sessionPersistence')
  ctx.set('sessionPersistence', {
    async open(sessionId, access) {
      assert.equal(sessionId, id)
      assert.equal(access, 'write')
      return {
        header: snapshot.header, inheritedEventCount: 0,
        async read() { return { events: structuredClone(events), eventState: 'detached' } },
        async append(suffix) { events.push(...structuredClone(suffix)) },
        async close() {},
      }
    },
  })
  return (await loop.resume(ctx, { resumeSessionId: id })).agent
}
// 通过公开 pre-step hook 观察原生 driver 的 claim；拒绝后不调模型，也不回填输入。
async function claimAtBoundary(agent, message, enterSurface = false) {
  let claimed = false
  const stop = agent.ctx.on('agent/pre-step', ({ messages }) => {
    assert.deepEqual(messages.map(item => item.id), [message.id])
    claimed = true
    if (enterSurface) for (const item of messages) agent.session.append('user/message', item, { surfaceOp: 'append' })
    return { kind: 'reject' }
  })
  try {
    agent.steer(message)
    await agent.whenIdle()
    assert.equal(claimed, true, '原生 driver 必须实际到达 claim 后的 pre-step 边界')
  } finally { stop() }
}

const input = (version = 1) => ({ id: stableId('message', `task-input:task-fixture:1:${version}`), role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `fixture input version ${version}` }] })
const wasInserted = (session, id) => session.snapshotEvents().some((event) => event.type === 'agent/inbox/spliced' && event.data.inserted.some((message) => message.id === id))
const enteredSurface = (session, id) => session.snapshotEvents().some((event) => event.type === 'user/message' && event.data.id === id)

// 使用原生 Session 和 Inbox。只用隔离文件保存原生 header/events 并 fsync，
// 不冒充真实 profile 的异步 persistence plugin 或真实模型消费。
async function reopen(t, session) {
  const root = await mkdtemp(join(tmpdir(), 'topic-native-inbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'session-snapshot.json')
  const handle = await open(file, 'wx')
  try { await handle.writeFile(JSON.stringify({ header: session.header, events: session.snapshotEvents() })); await handle.sync() } finally { await handle.close() }
  const snapshot = JSON.parse(await readFile(file, 'utf8'))
  return nativeAgent(t, session.id, snapshot)
}

test('原生Inbox插入稳定ID后跨文件重开恢复pending，重试不重复入队', async (t) => {
  const { session, inbox } = await nativeAgent(t, 'session-native-pending'), message = input()
  inbox.append('next-step', message)
  assert.throws(() => inbox.append('next-step', message), /duplicate|already|identity/i)
  const restored = await reopen(t, session)
  assert.equal(restored.inbox.nextStep.length, 1)
  assert.equal(restored.inbox.nextStep[0].id, message.id)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  assert.notEqual(input(2).id, message.id)
})

test('原生Inbox已进入user/message后跨重开无pending，但稳定ID仍可确认曾下发', async (t) => {
  const agent = await nativeAgent(t, 'session-native-consumed'), message = input()
  const { session } = agent
  await claimAtBoundary(agent, message, true)
  const restored = await reopen(t, session)
  assert.equal(inboxHasPending(restored.inbox), false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), true)
  const event = restored.session.snapshotEvents().find((item) => item.type === 'user/message')
  assert.equal(event.data.id, message.id)
  assert.equal(event.data.message, undefined)
})

test('原生Inbox取消保留历史inserted，不能凭此认定输入已消费或仍待执行', async (t) => {
  const { session, inbox } = await nativeAgent(t, 'session-native-canceled'), message = input()
  inbox.append('next-step', message)
  assert.equal(inbox.remove(message.id), true)
  const restored = await reopen(t, session)
  assert.equal(inboxHasPending(restored.inbox), false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  const cancellation = restored.session.snapshotEvents().find((event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
  assert.equal(cancellation.data.removedCount, 1)
  // Native Inbox允许相同ID在取消后再投递；是否重投必须由Task生命周期决定。
  restored.inbox.append('next-step', message)
  assert.equal(restored.inbox.nextStep.length, 1)
})

test('原生Inbox仅claim未进入surface时重开可见差异，不声称叶子已阅读', async (t) => {
  const agent = await nativeAgent(t, 'session-native-claimed'), message = input()
  const { session } = agent
  await claimAtBoundary(agent, message)
  const restored = await reopen(t, session)
  assert.equal(inboxHasPending(restored.inbox), false)
  assert.equal(wasInserted(restored.session, message.id), true)
  assert.equal(enteredSurface(restored.session, message.id), false)
  assert.equal(restored.session.snapshotEvents().some((event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'), false)
})
