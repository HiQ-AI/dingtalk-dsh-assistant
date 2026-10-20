import test from 'node:test'
import assert from 'node:assert/strict'
import { latestExecutionRoundTiming } from '../packages/dingtalk-dsh-assistant/task-execution-timeline.js'

const at = minute => new Date(Date.UTC(2026, 9, 20, 0, minute)).toISOString()
const segment = (leaseEpoch, from, to, state = to == null ? 'running' : 'closed') =>
  ({ leaseEpoch, startedAt: at(from), endedAt: to == null ? null : at(to), state })
const execution = segments => ({ leaseEpoch: 2, status: 'running', drained: false, timeline: { complete: false, segments } })

test('latest claim spans all its activity segments without accumulating previous claims or queue gaps', () => {
 const current = execution([segment(1, 0, 10), segment(2, 20, 22), segment(2, 22, null)])
 assert.deepEqual(latestExecutionRoundTiming(current), { startedAt: at(20), endedAt: null, active: true })
 for (const status of ['succeeded', 'failed', 'cancelled', 'stale', 'queued']) {
  assert.deepEqual(latestExecutionRoundTiming({ ...current, status, drained: true,
   timeline: { segments: [segment(1, 0, 10), segment(2, 20, 22), segment(2, 22, 25)] } }),
   { startedAt: at(20), endedAt: at(25), active: false })
 }
})

test('missing, unknown, reversed or discontinuous round evidence never falls back to older runs or update timestamps', () => {
 for (const value of [
  {}, { leaseEpoch: 0 }, execution([]), execution([segment(1, 0, 10)]),
  execution([segment(2, 20, null, 'unknown')]), execution([segment(2, 20, 19)]),
  execution([segment(2, 20, 21), segment(2, 22, 23)]),
  execution([{ ...segment(2, 20, 21), startedAt: 'bad' }]),
  execution([{ ...segment(2, 20, 21), endedAt: null }]),
  { ...execution([segment(2, 20, null)]), recovering: true },
  { ...execution([segment(2, 20, null)]), drained: true },
  { ...execution([segment(2, 20, null)]), status: 'failed' },
 ]) assert.equal(latestExecutionRoundTiming({ ...value, updatedAt: at(30), createdAt: at(0), progressReview: { checkedAt: at(29) } }), null)
})
