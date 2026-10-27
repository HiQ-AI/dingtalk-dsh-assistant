import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { installSessionSkillRefresh } from '../packages/dingtalk-dsh-assistant/session-skill-refresh.js'

function fixture(seed = []) {
  const session = Session.create('skill-refresh-faults', seed), agent = { session }
  const hooks = new Map(), sections = new Map(), tools = new Map([['skill', {}], ['read', {}]])
  const state = { getCount: 0, body: 'old', root: '/skills/guide', version: 'v1', failResolve: false }
  const definition = () => ({ name: 'guide', provider: 'fixture', resourceBase: { kind: 'directory', path: state.root }, content: state.body })
  const fs = { processPath: x => x, resolve: async x => { if (state.failResolve) throw Error('observation unavailable'); return x },
    contains: (parent, child) => child.startsWith(parent + '/'), stat: async () => ({ version: state.version }) }
  const services = { skills: { get: async () => { state.getCount++; return definition() } }, agentPresets: { serviceFor: () => fs } }
  const ctx = { get: name => services[name], tools: { get: name => tools.get(name) },
    systemPrompt: { context: item => sections.set(item.name, item) }, on: (name, fn) => hooks.set(name, fn) }
  installSessionSkillRefresh(ctx, agent, { cwd: '/', signal: new AbortController().signal })
  const text = () => [...sections.values()].map(item => item.text()).join('\n')
  const step = () => hooks.get('agent/pre-step')({}, async () => ({ kind: 'enter' }))
  async function read(name, path, failed = false) {
    const exec = { name, agent, callId: `read-${session.snapshotEvents().length}`, token: Symbol(), arguments: { name: 'guide' } }
    if (name === 'read') hooks.get('fs/observed')(path, { kind: 'present', version: state.version }, exec)
    const result = { isError: failed, value: name === 'skill' ? definition() : { path }, content: [] }
    const decision = await hooks.get('tools/post-execute')(exec, result, async () => ({ kind: 'accept' }))
    hooks.get('tools/result')(exec, result)
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: exec.callId, isError: failed, content: [] }) }, { surfaceOp: 'append' })
    return decision
  }
  return { agent, state, hooks, tools, text, step, read }
}

test('普通步骤不重复加载技能正文，原生变更通知触发一次核对', async () => {
  const h = fixture()
  await h.read('skill'); await h.step()
  assert.equal(h.state.getCount, 1)
  for (let i = 0; i < 20; i++) await h.step()
  assert.equal(h.state.getCount, 1)
  h.state.body = 'new'; h.hooks.get('skills/change')(); await h.step()
  assert.equal(h.state.getCount, 2)
  assert.match(h.text(), /本会话已读技能或引用有变化/)
  await h.read('skill'); await h.step()
  assert.equal(h.text(), '')
})

test('切换技能根后不继续催读旧引用，旧审计仍可恢复', async () => {
  const h = fixture()
  await h.read('skill'); await h.read('read', '/skills/guide/references/a.md')
  h.state.root = '/new/guide'; await h.read('skill'); await h.step()
  assert.equal(h.text(), '')
  const restored = fixture(h.agent.session.snapshotEvents())
  restored.state.root = h.state.root; await restored.step()
  assert.equal(restored.text(), '')
  assert.equal(restored.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'dingtalk-skill-read').length, 3)
})

test('成功读取后的元数据故障不推翻 read 结果，缺口对下一模型步骤可见', async () => {
  const h = fixture()
  await h.read('skill'); h.state.failResolve = true
  assert.deepEqual(await h.read('read', '/skills/guide/references/a.md'), { kind: 'accept' })
  await h.step()
  assert.match(h.text(), /尚无可核对版本记录/)
})

test('旧会话成功技能调用只生成待核对提示，不冒充新版已读或自动加载正文', async () => {
  const events = [{ type: 'tool/call', data: { name: 'skill', callId: 'old-read', arguments: '{"name":"guide"}' } },
    { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'old-read', isError: false, content: [{ type: 'text', text: 'old result' }] } } }]
  // 原生旧调用仅作为候选名称；本测试用历史视图注入，不伪造当前工具结果。
  const h = fixture()
  const original = h.agent.session.snapshotEvents.bind(h.agent.session)
  h.agent.session.snapshotEvents = () => events
  const ctxHooks = new Map(), sections = []
  installSessionSkillRefresh({ get: name => name === 'skills' ? { get: () => { throw Error('must not autoload') } } : undefined,
    tools: { get: () => ({}) }, systemPrompt: { context: item => sections.push(item) }, on: (name, fn) => ctxHooks.set(name, fn) },
  h.agent, { cwd: '/', signal: new AbortController().signal })
  h.agent.session.snapshotEvents = original
  await ctxHooks.get('agent/pre-step')({}, async () => ({ kind: 'enter' }))
  assert.match(sections[0].text(), /guide/)
  assert.match(sections[0].text(), /尚无可核对版本记录/)
})

test('同名替换及失败结果不形成可信技能读取版本', async () => {
  const h = fixture()
  h.tools.set('skill', {})
  await h.read('skill'); await h.step()
  assert.equal(h.agent.session.snapshotEvents().filter(e => e.data.source?.kind === 'dingtalk-skill-read').length, 0)
  const failed = fixture()
  await failed.read('skill', undefined, true); await failed.step()
  assert.equal(failed.agent.session.snapshotEvents().filter(e => e.data.source?.kind === 'dingtalk-skill-read').length, 0)
})

test('版本摘要之后但原生成功结果落盘前崩溃，恢复时只提示重读', async () => {
  const h = fixture()
  await h.read('skill')
  const incomplete = h.agent.session.snapshotEvents().filter(event => event.type !== 'tool/result')
  const restored = fixture(incomplete)
  await restored.step()
  assert.match(restored.text(), /尚无可核对版本记录/)
  assert.equal(restored.state.getCount, 0)
})
