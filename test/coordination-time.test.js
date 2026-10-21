import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTimeSlot, validateTimeRule } from '../packages/dingtalk-dsh-assistant/coordination-time.js'

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
