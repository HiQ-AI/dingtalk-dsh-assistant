import assert from 'node:assert/strict'
import test from 'node:test'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createTaskSessionObservability } from '../packages/dingtalk-dsh-assistant/task-session-observability.js'

function storage(seed = new Map()) {
  const table = name => ({ get: key => seed.get(`${name}:${key}`),
    entries: () => [...seed].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value]),
    async put(key, value) { seed.set(`${name}:${key}`, value) }, async delete(key) { seed.delete(`${name}:${key}`) },
    async update(key, transform) { const value = transform(seed.get(`${name}:${key}`)); seed.set(`${name}:${key}`, value); return value } })
  return { async open() { return { table, async close() {} } } }
}
const time = Date.parse('2026-10-14T00:00:00Z')
const event = (seq, type, extra = {}) => ({ seq, type, time: time + seq * 100, data: { turn: 1, step: 0, ...extra } })
const session = { id: 'current-session', firstLiveSeq: 2 }
const options = store => ({ store, activityLimit: 2, listTasks: () => [{ taskId: 'current-task' }],
  resolveSessionIdentity: id => id === session.id ? { taskId: 'current-task', groupId: 'g' } : null })

test('current native observations reuse durable performance deduplication across restart; activities stay bounded and private', async () => {
  const backend = storage(), store = await openResidentStore(backend)
  const view = createTaskSessionObservability(options(store))
  await store.recordPerformanceEvent({ sessionId: 'retired', taskId: 'retired-task', event: event(0, 'assistant/message') })
  assert.deepEqual(await view.observe({ id: 'retired' }, event(4, 'step/start')), { created: false })
  assert.deepEqual(await view.observe(session, event(1, 'step/start')), { created: false })
  await view.observe(session, event(2, 'step/start'))
  await view.observe(session, event(3, 'assistant/chunk', { text: 'SECRET' }))
  const completed = event(4, 'assistant/message', { content: 'SECRET', usage: { inputTokens: 10, outputTokens: 2 } })
  await view.observe(session, completed)
  await view.observe(session, completed)
  assert.equal(view.listActivities().length, 2)
  assert.equal(JSON.stringify(view.listActivities()).includes('SECRET'), false)
  assert.equal(view.listPerformance().rows.length, 1)
  assert.equal(view.listPerformance().rows[0].modelCalls, 1)
  assert.equal(view.listPerformance().workflow, undefined)
  assert.equal(view.listTaskTimings()[0].observedModelSessionMs, 200)
  assert.equal(view.listTaskTimings()[0].waitingMs, null)
  assert.equal(view.getActivityAuditStatus().audited, null)
  await store.close()
  const reopened = await openResidentStore(backend)
  const restarted = createTaskSessionObservability(options(reopened))
  assert.deepEqual(restarted.listActivities(), [])
  assert.equal(restarted.getActivityAuditStatus().status, 'unsupported')
  await restarted.observe(session, completed)
  assert.equal(restarted.listPerformance().rows[0].modelCalls, 1)
  assert.equal(restarted.listPerformance().completeness, 'incomplete')
  await reopened.close()
})

test('missing native measurements are null, never fabricated zero or historical workflow totals', () => {
  const view = createTaskSessionObservability(options({}))
  assert.equal(view.listTaskTimings()[0].observedToolSessionMs, null)
  assert.equal(view.listTaskTimings()[0].runningMs, null)
  assert.equal(view.listPerformance().status, 'unsupported')
  assert.equal(view.getActivityAuditStatus().total, null)
})
