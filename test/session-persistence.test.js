import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSession, inboxHasPending } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

test('session inspection opens a read-only handle and closes it after reading', async () => {
  const calls = [], header = { id: 'fixture' }, events = [{ seq: 0, type: 'plugin:dingtalk/fixture', data: {} }]
  const value = await inspectSession({ async open(id, access) {
    calls.push(['open', id, access])
    return { header, inheritedEventCount: 1,
      async read() { calls.push(['read']); return { events } },
      async close() { calls.push(['close']) },
    }
  } }, 'fixture')
  assert.deepEqual(value, { meta: header, inheritedEventCount: 1, events })
  assert.deepEqual(calls, [['open', 'fixture', 'read'], ['read'], ['close']])
})

test('session inspection closes its handle when the read fails', async () => {
  const failure = new Error('storage read failure')
  let closed = 0
  await assert.rejects(inspectSession({ async open() { return {
    async read() { throw failure }, async close() { closed++ },
  } } }, 'fixture'), error => error === failure)
  assert.equal(closed, 1)
})

test('session inspection preserves an open failure and a close failure', async () => {
  const missing = new Error('missing session'), closeFailure = new Error('close failed')
  await assert.rejects(inspectSession({ async open() { throw missing } }, 'fixture'), error => error === missing)
  await assert.rejects(inspectSession({ async open() { return {
    async read() { return { events: [] } }, async close() { throw closeFailure },
  } } }, 'fixture'), error => error === closeFailure)
})

test('pending inbox detection uses both public queue snapshots', () => {
  assert.equal(inboxHasPending({ nextTurn: [], nextStep: [] }), false)
  assert.equal(inboxHasPending({ nextTurn: [{}], nextStep: [] }), true)
  assert.equal(inboxHasPending({ nextTurn: [], nextStep: [{}] }), true)
})

test('inspection forwards cancellation to both open and read without leaking the handle', async () => {
  const signal = AbortSignal.abort(new Error('cancelled'))
  let closed = false
  await assert.rejects(inspectSession({ async open(id, access, options) {
    assert.equal(id, 'fixture'); assert.equal(access, 'read'); assert.equal(options.signal, signal)
    return { async read(offset, length, options) {
      assert.equal(offset, undefined); assert.equal(length, undefined); assert.equal(options.signal, signal)
      options.signal.throwIfAborted()
    }, async close() { closed = true } }
  } }, 'fixture', { signal }), error => error === signal.reason)
  assert.equal(closed, true)
})
