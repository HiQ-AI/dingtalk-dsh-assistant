import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { messageProcessingProjection } from '../packages/dingtalk-dsh-assistant/observer-message-projection.js'
import { createObserverGroupPages } from '../packages/dingtalk-dsh-assistant/observer-group-pages.js'

test('待判投影不被旧完成戳覆盖，理由与 CAS 身份可见', () => {
  const message = { messageId: 'm', messageVersion: 2, routingStatus: 'needs-context', routingHold: { messageVersion: 2, epoch: 3, reason: '取消范围不明确', createdAt: '2026-01-01T00:00:00Z' } }
  const source = { routed: false, processingCompleted: { at: '2026-01-01T00:00:00Z' } }
  const result = messageProcessingProjection(message, [], source, [])
  assert.equal(result.processingState, 'needs_clarification')
  assert.equal(result.processingConclusion, '取消范围不明确')
  assert.equal(result.processingCompletedAt, null)
  assert.equal(result.processingFacts.sourceState, 'unsettled')
  assert.deepEqual(result.routingHold, { messageVersion: 2, epoch: 3 })
})

test('待判理由和范围变更更新分页索引', async t => {
  const base = { groupId: 'g', routingRevision: 1, topics: [], outbox: [], messages: [{ messageId: 'm', messageVersion: 1, sequence: 1, occurredAt: '2026-01-01T00:00:00Z', routingStatus: 'needs-context', routingHold: { messageVersion: 1, epoch: 0, reason: '范围未知' } }] }
  let group = base
  const page = createObserverGroupPages({ readGroup: () => group, readSources: async () => [], readRequests: () => [], isOwnNotification: () => false })
  t.after(() => page.close())
  page.update({ group }); await page.ready()
  const before = await page('g', { filter: 'needs_clarification' })
  assert.equal(before.total, 1)
  group = { ...base, routingRevision: 2, messages: [{ ...base.messages[0], routingHold: { messageVersion: 1, epoch: 1, reason: '范围未知', scope: ['t'] } }] }
  page.update({ previous: base, group }); await page.ready()
  const after = await page('g', { filter: 'needs_clarification' })
  assert.notEqual(after.revision, before.revision)
  assert.deepEqual(after.items[0].routingHold, { messageVersion: 1, epoch: 1, scope: ['t'] })
})

test('待判 HTTP 操作限本地身份、显式确认及 CAS 身份', async t => {
  const calls = []
  const server = createServer((req, res) => handleRequest(req, res, { async updateMessageRoutingHold(input) { calls.push(input); if (input.epoch === 0) throw new Error('topic_routing_hold_stale'); return { status: input.resume ? 'resumed' : 'scope-updated' } } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/config/groups/g/messages/m/routing-hold`
  const post = (body, origin = 'http://127.0.0.1:3080') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  assert.equal((await post({ messageVersion: 1, epoch: 1, resume: true }, 'https://example.invalid')).status, 403)
  assert.equal((await post({ messageVersion: 1, epoch: 1, scope: ['t'] })).status, 400)
  assert.equal((await post({ messageVersion: 1, epoch: 1, scope: ['t'], confirmClosedScope: true, resume: true })).status, 400)
  assert.equal((await post({ messageVersion: 1, epoch: 0, resume: true })).status, 409)
  assert.equal((await post({ messageVersion: 1, epoch: 1, scope: ['t'], confirmClosedScope: true })).status, 200)
  assert.equal((await post({ messageVersion: 1, epoch: 1, resume: true })).status, 200)
  assert.deepEqual(calls.at(-2), { groupId: 'g', messageId: 'm', messageVersion: 1, epoch: 1, scope: ['t'] })
  assert.deepEqual(calls.at(-1), { groupId: 'g', messageId: 'm', messageVersion: 1, epoch: 1, resume: true })
})
