import assert from 'node:assert/strict'
import test from 'node:test'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createTaskSessionObservability, createTaskObservationQueue } from '../packages/dingtalk-dsh-assistant/task-session-observability.js'

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

const turn = () => new Promise(resolve => setImmediate(resolve))
const burst = count => Array.from({ length: count }, (_, step) => [
  event(2 + step * 2, 'step/start', { step }),
  event(3 + step * 2, 'assistant/message', { step, usage: { inputTokens: 2, outputTokens: 1 } }),
]).flat()
function trackedStorage(beforePut) {
  const backend = storage()
  return { async open(...args) {
    const domain = await backend.open(...args)
    return { ...domain, table(name) {
      const table = domain.table(name)
      return { ...table, async put(key, value) { await beforePut(name, key, value); return table.put(key, value) } }
    } }
  } }
}

test('ordered observation bursts reuse the real resident batcher with identical durable projection and fewer writes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: time })
  const inputs = burst(80)
  inputs.push(inputs.at(-1), event(0, 'step/start'), event(900, 'not-a-performance-event'))
  const exercise = async batched => {
    let writes = 0
    const store = await openResidentStore(trackedStorage((name, key) => { if (name === 'scheduler' && key.startsWith('performance:')) writes++ }))
    const view = createTaskSessionObservability({ ...options(store), observedSince: new Date(time).toISOString() })
    const called = [], errors = []
    const observe = (s, e) => { called.push(e.seq); return view.observe(s, e) }
    if (batched) {
      const queue = createTaskObservationQueue({ observe, onError: error => errors.push(error) })
      for (const e of inputs) assert.equal(queue.enqueue(session, e), true)
      assert.deepEqual(called, [], 'delivery remains deferred from the native emitter')
      await queue.close(); assert.equal(queue.pending, 0)
    } else for (const e of inputs) await observe(session, e)
    const result = { writes, called, errors, performance: view.listPerformance(), activities: view.listActivities() }
    await store.close(); return result
  }
  const serial = await exercise(false), batched = await exercise(true)
  assert.deepEqual(batched.called, serial.called)
  assert.deepEqual(batched.performance, serial.performance)
  assert.deepEqual(batched.activities, serial.activities)
  assert.deepEqual(batched.errors, [])
  assert.equal(batched.performance.rows[0].modelCalls, 80)
  assert.ok(serial.writes >= 80)
  assert.ok(batched.writes <= 4)
  assert.ok(batched.writes * 8 < serial.writes)
  t.diagnostic(JSON.stringify({ serialWrites: serial.writes, batchedWrites: batched.writes, acceptedEvents: inputs.length }))
})

test('close joins accepted arrivals during a write, is idempotent and admits no writes after closure', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), first = Promise.withResolvers(), second = Promise.withResolvers()
  const calls = [], completed = [], progress = []
  const queue = createTaskObservationQueue({ observe: async value => {
    calls.push(value)
    if (value === 1) { entered.resolve(); await first.promise } else await second.promise
    completed.push(value)
  }, onProgress: value => progress.push(value) })
  queue.enqueue(1); await entered.promise
  queue.enqueue(2)
  const closing = queue.close(); let closed = false
  closing.then(() => { closed = true })
  assert.equal(queue.close(), closing)
  assert.equal(queue.enqueue(3), false)
  await turn(); assert.equal(closed, false); assert.deepEqual(calls, [1]); assert.equal(queue.pending, 2)
  first.resolve(); await turn()
  assert.deepEqual(calls, [1, 2]); assert.equal(closed, false); assert.equal(queue.pending, 1)
  second.resolve(); await closing
  assert.deepEqual(completed, [1, 2]); assert.deepEqual(progress, [1, 0]); assert.equal(queue.pending, 0)
  assert.equal(queue.enqueue(4), false); await turn(); assert.deepEqual(calls, [1, 2])
})

test('write failures are reported in input order after the whole batch settles and remaining observations still drain', { timeout: 5000 }, async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(), reported = [], called = []
  const a = Object.assign(Error('first write failed'), { code: 'FIRST' }), b = Error('second write failed')
  const queue = createTaskObservationQueue({ observe: value => { called.push(value); return value === 1 ? first.promise : value === 2 ? second.promise : Promise.resolve() },
    onError: error => reported.push(error) })
  queue.enqueue(1); queue.enqueue(2); await turn(); queue.enqueue(3)
  const closing = queue.close(); let closed = false; closing.then(() => { closed = true })
  second.reject(b); await turn(); assert.deepEqual(reported, []); assert.equal(closed, false)
  first.reject(a); await closing
  assert.deepEqual(called, [1, 2, 3]); assert.deepEqual(reported, [a, b]); assert.equal(queue.pending, 0)
  const unhandled = createTaskObservationQueue({ observe: () => Promise.reject(a) })
  unhandled.enqueue(1); await assert.rejects(unhandled.close(), error => error === a)
  const synchronous = createTaskObservationQueue({ observe: () => { throw a } })
  synchronous.enqueue(1); await assert.rejects(synchronous.close(), error => error === a)
})

test('failed real resident batches retain failure evidence and retry without loss or double counting', async () => {
  const failure = Error('controlled durable write failure'), errors = []
  let fail = true
  const store = await openResidentStore(trackedStorage((name, key) => {
    if (fail && name === 'scheduler' && key.startsWith('performance:')) throw failure
  }))
  const view = createTaskSessionObservability(options(store)), inputs = burst(8)
  const queue = createTaskObservationQueue({ observe: (s, e) => view.observe(s, e), onError: error => errors.push(error) })
  inputs.forEach(e => queue.enqueue(session, e)); await queue.close()
  assert.equal(errors.length, inputs.length); assert.ok(errors.every(error => error === failure))
  assert.equal(view.listPerformance().rows.length, 0)
  fail = false
  const retry = createTaskObservationQueue({ observe: (s, e) => view.observe(s, e) })
  inputs.forEach(e => retry.enqueue(session, e)); await retry.close()
  assert.equal(view.listPerformance().rows[0].modelCalls, 8)
  const replay = createTaskObservationQueue({ observe: (s, e) => view.observe(s, e) })
  inputs.forEach(e => replay.enqueue(session, e)); await replay.close()
  assert.equal(view.listPerformance().rows[0].modelCalls, 8)
  await store.close()
})

test('a burst larger than one batch retains FIFO across sessions and all accepted records', async () => {
  const called = [], released = []
  const queue = createTaskObservationQueue({ observe: async (session, index) => { called.push([session, index]); released.push(index) } })
  for (let i = 0; i < 600; i++) queue.enqueue(i % 2 ? 'b' : 'a', i)
  await queue.close()
  assert.deepEqual(called, Array.from({ length: 600 }, (_, i) => [i % 2 ? 'b' : 'a', i]))
  assert.deepEqual(released, Array.from({ length: 600 }, (_, i) => i)); assert.equal(queue.pending, 0)
})

test('interleaved real session partitions retain the serial reference projection and activity order', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: time })
  const sessions = [session, { id: 'second-session', firstLiveSeq: 2 }]
  const inputs = burst(8).map((e, index) => [sessions[Math.floor(index / 2) % 2], e])
  const exercise = async batched => {
    const store = await openResidentStore(storage())
    const view = createTaskSessionObservability({ ...options(store),
      resolveSessionIdentity: id => sessions.some(s => s.id === id) ? { taskId: 'current-task', groupId: 'g', role: id === session.id ? 'owner' : 'execution' } : null })
    const called = [], observe = (s, e) => { called.push([s.id, e.seq]); return view.observe(s, e) }
    if (batched) {
      const queue = createTaskObservationQueue({ observe })
      inputs.forEach(args => queue.enqueue(...args)); await queue.close()
    } else for (const args of inputs) await observe(...args)
    const result = { called, performance: view.listPerformance(), activities: view.listActivities() }
    await store.close(); return result
  }
  assert.deepEqual(await exercise(true), await exercise(false))
})

test('close also waits for asynchronous error reporting rather than returning at zero IO count', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), report = Promise.withResolvers(), error = Error('write rejected')
  const queue = createTaskObservationQueue({ observe: () => Promise.reject(error), onError: async value => {
    assert.equal(value, error); entered.resolve(); await report.promise
  } })
  queue.enqueue(1)
  const closing = queue.close(); let closed = false; closing.then(() => { closed = true })
  await entered.promise; assert.equal(queue.pending, 0)
  await turn(); assert.equal(closed, false)
  report.resolve(); await closing; assert.equal(closed, true)
})
