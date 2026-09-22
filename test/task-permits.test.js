import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskPermits } from '../packages/dingtalk-dsh-assistant/task-permits.js'

test('等待审阅停止推进但排空前不释放，B 先拿许可，A 恢复必须重新排队', () => {
  const permits = createTaskPermits({ limit: () => 1 })
  const a = permits.request('A')
  assert.equal(permits.request('A'), a)
  assert.equal(permits.request('B'), undefined)
  permits.suspend('A')
  assert.equal(permits.has('A'), false)
  assert.equal(permits.request('B'), undefined)
  assert.equal(permits.snapshot().holders.length, 1)
  permits.release(a)
  assert.equal(permits.request('A'), undefined)
  const b = permits.request('B')
  assert.ok(b)
  assert.equal(permits.request('A'), undefined)
  permits.release(b)
  const resumed = permits.request('A')
  assert.ok(resumed)
  assert.notEqual(resumed, a)
  assert.equal(permits.release(a), false, '迟到释放不能删除新许可')
  assert.equal(permits.has('A'), true)
})

test('重复唤醒唯一许可、取消移出队列、缩容不再发放超限许可', () => {
  let limit = 2
  const permits = createTaskPermits({ limit: () => limit })
  const a = permits.request('A'), b = permits.request('B')
  assert.equal(permits.request('A'), a)
  permits.request('cancelled'); permits.request('C'); permits.dequeue('cancelled')
  limit = 1
  permits.release(a)
  assert.equal(permits.request('C'), undefined)
  permits.release(b)
  assert.ok(permits.request('C'))
  assert.deepEqual(permits.snapshot().holders, ['C'])
})
