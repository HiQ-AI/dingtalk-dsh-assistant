import assert from 'node:assert/strict'
import test from 'node:test'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'

function setup(t, suppliedTopics) {
  const topics = suppliedTopics ?? [
    { topicId: 'a', title: '导出报表', summary: '处理导出超时', revision: 1 },
    { topicId: 'b', title: '权限核对', summary: '报表导出权限', revision: 2 },
    { topicId: 'c', title: '超时排查', summary: '接口响应慢', revision: 3 },
    { topicId: 'd', title: '无关事项', summary: '日常工作', revision: 1 },
  ]
  const store = { listTopics: () => topics }
  const tools = new Map()
  const coordinator = createTopicCoordinator({ store, getAgent: () => ({}), assertSession() {}, isClosing: () => false })
  coordinator.register({ tools: { register(tool) { tools.set(tool.name, tool) } } }, 'g')
  t.after(() => coordinator.close())
  return { topics, list: (args) => tools.get('group_topic_list').execute(args, { groupId: 'g' }) }
}

test('多词召回按命中数排序并给出逐字段依据，分页稳定', async t => {
  const { list } = setup(t)
  const first = await list({ queries: ['导出', '超时', '导出'], limit: 1 })
  assert.deepEqual(first.queries, ['导出', '超时'])
  assert.equal(first.total, 3)
  assert.equal(first.topics[0].topicId, 'a')
  assert.deepEqual(first.topics[0].matchedQueries, [
    { query: '导出', fields: ['title', 'summary'] },
    { query: '超时', fields: ['summary'] },
  ])
  const second = await list({ queries: ['导出', '超时', '导出'], offset: first.nextOffset, limit: 1 })
  const third = await list({ queries: ['导出', '超时', '导出'], offset: second.nextOffset, limit: 1 })
  assert.deepEqual([second.topics[0].topicId, third.topics[0].topicId], ['b', 'c'])
  assert.equal(third.hasMore, false)
})

test('原目录和整串查询语义不变，错误的多词请求拒绝', async t => {
  const { list } = setup(t)
  assert.deepEqual((await list({ limit: 2 })).topics.map(topic => topic.topicId), ['a', 'b'])
  assert.equal((await list({ query: '导出 超时' })).total, 0)
  assert.equal((await list({ queries: ['不存在'] })).total, 0)
  for (const args of [
    { queries: [] }, { queries: [' '] }, { queries: ['a'.repeat(33)] },
    { queries: ['a', 'b', 'c', 'd', 'e', 'f'] }, { query: '导出', queries: ['超时'] },
  ]) await assert.rejects(list(args), /topic_query_invalid/)
})

test('大目录仅投影请求页，多词查询仍按排序分页', async t => {
  let reads = 0
  const topics = Array.from({ length: 2000 }, (_, index) => ({ get topicId() { reads++; return `t${index}` }, title: '数据库导出', summary: index === 1999 ? '查询超时' : '', revision: 1 }))
  const { list } = setup(t, topics)
  const page = await list({ offset: 1000, limit: 5 })
  assert.equal(page.total, 2000)
  assert.deepEqual(page.topics.map(topic => topic.topicId), ['t1000', 't1001', 't1002', 't1003', 't1004'])
  assert.equal(reads, 5)
  reads = 0
  const search = await list({ queries: ['导出', '超时'], limit: 5 })
  assert.equal(search.total, 2000)
  assert.equal(search.topics[0].topicId, 't1999')
  assert.equal(reads, 5)
})

test('首包保留引用优先并召回目录首屏之外的历史候选', async t => {
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'topic-test' })
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'g', responsibility: '处理测试任务' })
  await store.setAgentNames(['助理'])
  const ingest = (messageId, extra = {}) => store.ingest({ groupId: 'g', messageId, text: messageId, senderOpenDingTalkId: 'user', occurredAt: '2026-09-07T00:00:00Z', ...extra })
  await ingest('seed'); await ingest('reference')
  const refs = Array.from({ length: 80 }, (_, index) => ({ newTopicKey: `topic-${index}`, title: index === 79 ? '数据库导出超时' : `历史事项${index}`, relationship: 'affected', reason: '历史关系' }))
  const routed = await store.routeMessages({ groupId: 'g', routeId: 'seed', routingRevision: 0, routes: [
    { messageId: 'seed', messageVersion: 1, topics: refs, effectOwner: { newTopicKey: 'topic-0' } },
    { messageId: 'reference', messageVersion: 1, topics: [{ newTopicKey: 'quoted', title: '用户引用事项' }] },
  ] })
  const sent = [], errors = []
  const agent = { session: { snapshotEvents: () => [] }, steer(message) { sent.push(message.content[0].text) }, whenIdle: () => new Promise(() => {}) }
  const coordinator = createTopicCoordinator({ store, getAgent: () => agent, assertSession() {}, serializeTasks: fn => fn(), isClosing: () => false, reviewCandidates: () => [], onError(_group, error) { errors.push(error) } })
  t.after(async () => { await coordinator.close(); await store.close() })
  await ingest('current', { text: `请排查数据库导出超时 管理 测试 ${'额外词语 '.repeat(10000)}`, quotedMessage: { messageId: 'reference', content: '引用事项' } })
  const OriginalSegmenter = Intl.Segmenter
  let segmentsRead = 0, charsSegmented = 0
  Intl.Segmenter = class {
    constructor(...args) { this.inner = new OriginalSegmenter(...args) }
    segment(text) {
      charsSegmented += text.length
      const inner = this.inner.segment(text)
      return { *[Symbol.iterator]() { for (const item of inner) { segmentsRead++; yield item } } }
    }
  }
  try { await coordinator.schedule('g') } finally { Intl.Segmenter = OriginalSegmenter }
  assert.ok(segmentsRead <= 20, `分词迭代超出预算: ${segmentsRead}`)
  assert.ok(charsSegmented <= 4000, `分词输入超出预算: ${charsSegmented}`)
  assert.deepEqual(errors, [])
  const envelope = JSON.parse(sent.find(text => text.startsWith('[GROUP_TOPIC_ROUTE]')).split('\n').find(line => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length))
  const target = routed.topicIdsByKey['topic-79']
  assert.equal(envelope.relatedTopics[0].topicId, routed.topicIdsByKey.quoted)
  assert.deepEqual(envelope.relatedTopics[0].recallSources, ['reference'])
  assert.equal(envelope.topics.some(topic => topic.topicId === target), false)
  assert.ok(envelope.recalledTopics.some(topic => topic.topicId === target && topic.matchedQueries.length > 0))
  assert.ok(JSON.stringify(envelope.topics).length + JSON.stringify(envelope.recalledTopics).length <= 5000)
})
