import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTimeSlot, validateTimeRule, normalizeCoordinationInstant } from '../packages/dingtalk-dsh-assistant/coordination-time.js'

test('proposal instants normalize once while durable scheduling retains canonical UTC identities', () => {
  const at = normalizeCoordinationInstant('2026-10-22T09:00:00+08:00')
  assert.equal(at, '2026-10-22T01:00:00.000Z')
  assert.equal(normalizeCoordinationInstant(at), at)
  assert.equal(nextTimeSlot({kind:'once',at}, 'Asia/Shanghai', Date.parse('2026-10-21T00:00:00Z')), at)
  assert.throws(() => validateTimeRule({kind:'once',at:'2026-10-22T09:00:00+08:00'}, 'Asia/Shanghai'))
  for (const invalid of ['2026-02-30T09:00:00Z','2026-10-22T24:00:00Z','2026-10-22T09:00:60Z',
    '2026-10-22T09:00:00','0000-01-01T00:00:00Z','9999-12-31T23:00:00-02:00','2026-10-22T09:00:00.123Z']) {
    assert.throws(() => normalizeCoordinationInstant(invalid), /COORDINATION_TIME_INVALID/, invalid)
  }
})

test('single UTC slot is never silently shifted or repeated', () => {
  const rule = { kind: 'once', at: '2026-10-22T01:00:00.000Z' }
  assert.equal(nextTimeSlot(rule, 'Asia/Shanghai', Date.parse('2026-10-22T00:59:59Z')), rule.at)
  assert.equal(nextTimeSlot(rule, 'Asia/Shanghai', Date.parse(rule.at)), null)
  assert.throws(() => validateTimeRule({ kind: 'once', at: '9点' }, 'Asia/Shanghai'))
  assert.throws(() => validateTimeRule({ kind: 'daily', time: '25:00' }, 'Asia/Shanghai'))
  assert.throws(() => validateTimeRule({ kind: 'daily', time: '09:00' }, 'Unknown/Place'))
})

test('daily and weekly rules use local wall time', () => {
  assert.equal(nextTimeSlot({ kind: 'daily', time: '09:00' }, 'Asia/Shanghai', Date.parse('2026-10-21T01:00:00Z')), '2026-10-22T01:00:00.000Z')
  assert.equal(nextTimeSlot({ kind: 'weekly', weekday: 4, time: '09:00' }, 'Asia/Shanghai', Date.parse('2026-10-21T01:00:00Z')), '2026-10-22T01:00:00.000Z')
})

test('DST missing wall time skips the day; repeated wall time runs at first UTC occurrence only', () => {
  assert.equal(nextTimeSlot({ kind: 'daily', time: '02:30' }, 'America/New_York', Date.parse('2026-03-08T00:00:00Z')), '2026-03-09T06:30:00.000Z')
  assert.equal(nextTimeSlot({ kind: 'daily', time: '01:30' }, 'America/New_York', Date.parse('2026-11-01T00:00:00Z')), '2026-11-01T05:30:00.000Z')
  assert.equal(nextTimeSlot({ kind: 'daily', time: '01:30' }, 'America/New_York', Date.parse('2026-11-01T05:30:00Z')), '2026-11-02T06:30:00.000Z')
})
