import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

function memoryFacility() {
  const values = new Map()
  const table = name => ({ get: key => values.get(`${name}:${key}`),
    entries: () => [...values].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value]),
    async put(key, value) { values.set(`${name}:${key}`, value) }, async delete(key) { values.delete(`${name}:${key}`) },
    async update(key, transform) { const value = transform(values.get(`${name}:${key}`)); values.set(`${name}:${key}`, value); return value } })
  return { async open() { return { table, async close() {} } } }
}

test('topic context HTTP uses real topic decisions and current native task reader without workflow methods', async t => {
  const store = await openResidentStore(memoryFacility())
  await store.subscribe({ groupId: 'g' })
  for (const id of ['m1', 'm2']) await store.ingest({ groupId: 'g', messageId: id, text: `真实来源${id}`, occurredAt: '2026-10-14T00:00:00Z' })
  const routed = await store.routeMessages({ groupId: 'g', routeId: 'route', routingRevision: 0,
    routes: ['m1', 'm2'].map(messageId => ({ messageId, messageVersion: 1, topics: [{ newTopicKey: 'shared', title: '真实话题' }] })) })
  const topicId = routed.topicIdsByKey.shared, revision = store.getTopic('g', topicId).revision
  for (const id of ['d1', 'd2']) {
    await store.acceptTopicDecision({ groupId: 'g', topicId, revision, decisionId: id,
      decision: { basisMessageIds: ['m1', 'm2'], actions: [], reason: `真实判断${id}` } })
    await store.completeTopicDecision({ groupId: 'g', topicId, decisionId: id })
  }
  store.setTaskSessionReader({ listTasks: () => [{ taskId: 'native-task', groupId: 'g', title: '当前任务', state: 'waiting', inputVersion: 3, topicRefs: [{ topicId, revision }] }], getTask: () => null })
  const server = createServer((request, response) => handleRequest(request, response, store))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close() })
  const base = `http://127.0.0.1:${server.address().port}/state/topics/${encodeURIComponent(topicId)}/context`
  const response = await fetch(`${base}?groupId=g&limit=1`)
  assert.equal(response.status, 200)
  const first = await response.json()
  assert.equal(first.current.topicTitle, '真实话题')
  assert.equal(first.current.tasks[0].taskId, 'native-task')
  assert.equal(first.facts[0].text, '真实来源m1')
  assert.equal(first.intentRuns[0].reason, '真实判断d1')
  assert.equal(first.intentRuns[0].carrierRunId, undefined)
  assert.equal(first.nextCursor, 1)
  assert.equal(first.intentNextCursor, 1)
  const next = await (await fetch(`${base}?groupId=g&limit=1&revision=${revision}&cursor=1&intentCursor=1`)).json()
  assert.equal(next.facts[0].text, '真实来源m2')
  assert.equal(next.intentRuns[0].reason, '真实判断d2')
  assert.equal(next.nextCursor, null)
  assert.equal(next.intentNextCursor, null)
  assert.equal((await fetch(base)).status, 400)
  assert.equal((await fetch(`${base}?groupId=other`)).status, 404)
  assert.equal((await fetch(`${base}?groupId=g&revision=${revision + 1}`)).status, 409)
  for (const query of ['cursor=-1', 'intentCursor=1.5', 'limit=101', 'limit=0']) assert.equal((await fetch(`${base}?groupId=g&${query}`)).status, 400)
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/state/workflows/topics/${topicId}/context`)).status, 404)
})

test('topic panel requests generic context with group identity while retaining its existing layout', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('new URLSearchParams({ groupId: selection.groupId })'))
  assert.ok(source.includes('get(`/state/topics/${encodeURIComponent(selection.topicId)}/context?${params}`)'))
  assert.ok(!source.includes('get(`/state/workflows/topics/${encodeURIComponent(selection.topicId)}/context?${params}`)'))
  assert.ok(source.includes("'当前上下文与判断记录'"))
})
