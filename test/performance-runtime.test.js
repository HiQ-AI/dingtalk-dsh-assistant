import assert from 'node:assert/strict'
import test from 'node:test'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openResidentRuntime } from '../packages/dingtalk-dsh-assistant/runtime.js'

async function setup(t) {
  const values = new Map(), events = new Map(), agents = new Map()
  const table = name => ({ get: key => values.get(`${name}:${key}`), entries: () => [...values].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value])[Symbol.iterator](),
    async put(key, value) { values.set(`${name}:${key}`, value) }, async delete(key) { values.delete(`${name}:${key}`) }, async update(key, transform) { const value = transform(values.get(`${name}:${key}`)); values.set(`${name}:${key}`, value); return value } })
  const store = await openResidentStore({ open: async () => ({ table, close: async () => {} }) })
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }, agents: { get: id => agents.get(id) },
    subagents: { drainContinuableDescendants: async () => {} }, on(name, fn) { events.set(name, fn); return () => events.delete(name) } }
  const runtime = await openResidentRuntime(ctx, store, process.cwd(), { supervisorIntervalMs: 0 })
  t.after(() => runtime.close())
  await store.subscribe({ groupId: 'g', residentSessionId: 'main' })
  return { store, runtime, events, agents }
}

test('运行时观察主会话、叶子和原生二级会话，排除seed且不归属无关会话', async t => {
  const h = await setup(t)
  const task = { taskId: 't', groupId: 'g', childSessionId: 'leaf' }
  h.store.listTasks = () => [task]
  const main = { id: 'main', firstLiveSeq: 5, header: {} }, leaf = { id: 'leaf', firstLiveSeq: 2, header: { parentSession: 'main' } }
  const child = { id: 'secondary', firstLiveSeq: 10, header: { parentSession: 'leaf' } }
  h.agents.set('main', { session: main }); h.agents.set('leaf', { session: leaf })
  const emit = (session, seq) => h.events.get('session/event')(session, { seq, type: 'assistant/message', time: Date.now(), data: { turn: 1, step: seq, usage: { inputTokens: 100, outputTokens: 2 } } })
  emit(main, 4); emit(main, 5); emit(leaf, 1); emit(leaf, 2); emit(child, 9); emit(child, 10); emit({ id: 'unrelated', header: {} }, 1)
  await h.runtime.flushPerformance()
  const rows = h.runtime.listPerformance().rows
  assert.equal(rows.length, 3)
  assert.equal(rows.reduce((sum, row) => sum + row.modelCalls, 0), 3)
  assert.equal(rows.find(row => row.sessionId === 'main').taskId, undefined)
  assert.equal(rows.find(row => row.sessionId === 'secondary').taskId, 't')
})

test('计量写盘失败可见但不从session观察器抛出或阻塞关闭', async t => {
  const h = await setup(t)
  h.store.recordPerformanceEvent = async () => { throw new Error('synthetic performance storage failure') }
  assert.doesNotThrow(() => h.events.get('session/event')({ id: 'main', header: {} }, { seq: 1, type: 'step/start', time: Date.now(), data: { turn: 1, step: 0 } }))
  await h.runtime.flushPerformance()
  assert.equal(h.runtime.listRecoveryIssues().filter(item => item.kind === 'performance-projection').length, 1)
})
