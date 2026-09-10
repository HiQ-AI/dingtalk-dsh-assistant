import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { GoalService } from '@deepseek-ai/dsh-goal'
import { apply as installGoalDriver } from '@deepseek-ai/dsh-goal-round-driver'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { Inbox, agentEvents, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { stableId } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { createTaskReportStepGate } from '../packages/dingtalk-dsh-assistant/task-report-step-gate.js'
import { installFakeLlm } from '../packages/dingtalk-dsh-assistant/fake-llm.js'

const requireGoal = createRequire(import.meta.resolve('@deepseek-ai/dsh-goal'))
const { SessionProjectionRegistry } = requireGoal('@deepseek-ai/dsh-session-projection')
const ref = goal => ({ id: goal.id, revision: goal.revision })
const flushJobs = () => new Promise(resolve => setImmediate(resolve))

// 真实 Cordis、GoalService、Goal driver、Session、Inbox；Agent 调度边界由 fixture 驱动。
// 不启动 LLM/工具执行器，不把主动推进 status 的 fixture 声称为模型或真实进程持久化 E2E。
function setup(t, session = Session.create('session-report-native')) {
  const ctx = new Context()
  const followups = []
  const agent = { id: session.id, session, status: 'running',
    followup(message) { followups.push(message); this.inbox.append('next-turn', message) },
  }
  const notifications = {
    inserted(message) { agentEvents(ctx, agent).emit('agent/inbox/inserted', { message }) },
    discarded(message) { agentEvents(ctx, agent).emit('agent/inbox/discarded', { message }) },
    claimed(message) { agentEvents(ctx, agent).emit('agent/inbox/claimed', { message }) },
  }
  agent.inbox = new Inbox(session, notifications)
  ctx.provide('agents')
  ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent], withoutInitiator: callback => callback() })
  ctx.provide('sessions')
  ctx.set('sessions', { async flush() {} })
  new SessionProjectionRegistry(ctx)
  const goals = new GoalService(ctx)
  installGoalDriver(ctx)
  t.after(() => ctx.fiber.dispose())
  const status = value => { agent.status = value; agentEvents(ctx, agent).emit('agent/status', { status: value }) }
  return { ctx, agent, goals, followups, status }
}

test('真实Goal.block在当前step中可调用，idle后driver不启动新轮次', async t => {
  const h = setup(t)
  const created = h.goals.create(h.agent, { objective: '等待报告审阅', maxGoalRounds: 10 })
  h.agent.session.append('turn/start', { turn: 1 })
  h.agent.session.append('step/start', { turn: 1, step: 1 })
  h.agent.session.append('tool/call', { turn: 1, step: 1, callId: 'report-call', name: 'submit_task_checkpoint', arguments: '{}' })
  const blocked = h.goals.block(h.agent, ref(created), { code: 'task-coordination-pending', message: '报告已保存，等待审阅。' })
  assert.equal(blocked.phase, 'blocked')
  assert.equal(blocked.activation, 'disarmed')
  assert.equal(h.agent.status, 'running', 'block只阻止自动Goal续轮，不中断当前工具/step')
  h.status('idle')
  await flushJobs()
  assert.equal(h.followups.length, 0)
  assert.equal(h.goals.get(h.agent).roundsStarted, 0)
})

test('真实Goal恢复加一次稳定Inbox通知，不因重复恢复入队两条结果', async t => {
  const h = setup(t)
  const created = h.goals.create(h.agent, { objective: '继续已审阅阶段' })
  h.goals.block(h.agent, ref(created), { code: 'task-coordination-pending', message: '等待' })
  h.status('idle')
  await flushJobs()
  const id = stableId('message', 'task-report:task-native:submission-1:accepted')
  const deliver = () => {
    const goal = h.goals.get(h.agent)
    if (goal.phase === 'blocked') h.goals.resume(h.agent, ref(goal))
    if (!h.agent.inbox.nextTurn.some(message => message.id === id)) h.agent.inbox.append('next-turn', { ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '[TASK_REPORT_REVIEWED] accepted' }] }), id })
  }
  deliver()
  deliver()
  await flushJobs()
  assert.equal(h.agent.inbox.nextTurn.filter(message => message.id === id).length, 1)
  assert.equal(h.followups.length, 0, '结果消息与自动轮次竞争时driver不额外注入Goal轮次')
  assert.equal(h.goals.get(h.agent).phase, 'active')
  assert.equal(h.goals.get(h.agent).activation, 'armed')
})

test('真实Session重建后blocked保持，pending通知按稳定身份恢复', async t => {
  const h = setup(t)
  const goal = h.goals.create(h.agent, { objective: '恢复报告结果' })
  h.goals.block(h.agent, ref(goal), { code: 'task-coordination-pending', message: '等待审阅' })
  const message = { ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '报告结果' }] }), id: stableId('message', 'durable-report-result') }
  h.agent.inbox.append('next-step', message)
  const snapshot = JSON.parse(JSON.stringify({ header: h.agent.session.header, events: h.agent.session.snapshotEvents() }))
  const restored = setup(t, Session.fromRestore(h.agent.id, snapshot.events, snapshot.header))
  assert.equal(restored.goals.get(restored.agent).phase, 'blocked')
  assert.equal(restored.goals.get(restored.agent).activation, 'disarmed')
  assert.equal(restored.agent.inbox.nextStep[0].id, message.id)
  assert.throws(() => restored.agent.inbox.append('next-step', message), /duplicate|identity|already/)
  restored.status('idle')
  await flushJobs()
  assert.equal(restored.followups.length, 0)
})

test('真实AgentLoop拒绝step并回填Inbox不会空转；结果通知只放行一次模型步骤', async t => {
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false })
  new LlmRuntime(ctx)
  installFakeLlm(ctx)
  ctx.provide('tools')
  ctx.set('tools', {}) // 本用例不调工具，只验证实际AgentLoop的step/Inbox生命周期。
  const goals = new GoalService(ctx)
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const agent = loop.create('session-real-report-loop', { provider: 'fake-resident', model: 'fixture' })
  installGoalDriver(ctx)
  t.after(() => ctx.fiber.dispose())
  let checks = 0
  const gate = createTaskReportStepGate({ isBlocked: () => true, isResolutionMessage: (_agent, message) => message.id === 'resolution-1' })
  ctx.on('agent/pre-step', (...args) => { checks += 1; return gate(...args) })
  const created = goals.create(agent, { objective: '报告等待测试' })
  goals.block(agent, ref(created), { code: 'task-coordination-pending', message: '等待报告结果' })
  agent.steer({ ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '尚不能执行的输入' }] }), id: 'ordinary-1' })
  await agent.whenIdle()
  await flushJobs()
  assert.equal(checks, 1)
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(agent.inbox.nextStep[0].id, 'ordinary-1')
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0)
  agent.steer({ ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: '报告处理结果' }] }), id: 'resolution-1' })
  await agent.whenIdle()
  await flushJobs()
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === 'resolution-1').length, 1)
  assert.equal(agent.status, 'idle')
  assert.ok(checks <= 3, '阻塞后的新step最多一次拒绝，不能无限turn')
})
