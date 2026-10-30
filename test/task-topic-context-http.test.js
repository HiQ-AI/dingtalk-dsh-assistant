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
  store.setTaskSessionReader({ listTaskPage: async()=>({items:[{taskId:'native-task',groupId:'g',title:'当前任务',state:'waiting',inputVersion:3,topicRefs:[{topicId,revision}]}],total:1,offset:0,limit:1,nextOffset:null}), listTasks: () => [{ taskId: 'native-task', groupId: 'g', title: '当前任务', state: 'waiting', inputVersion: 3, topicRefs: [{ topicId, revision }] }], getTask: () => null })
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

test('topic overview keeps history behind explicit disclosures and uses narrow reads', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("new URLSearchParams({ groupId: selection.groupId, view: 'overview' })"))
  assert.ok(source.includes("open ? React.createElement(TopicRecords"))
  assert.ok(source.includes("archived: 'all', view: 'summary'"))
  assert.ok(!source.includes("read('/state/topics?offset=0&limit=100')"))
})

test('overview projection never touches message/decision history and respects group identity', async t => {
  const forbidden = () => { throw new Error('overview touched history') }
  const topics = Array.from({ length: 23 }, (_, n) => ({ topicId: 'topic-' + n, groupId: 'g', title: '话题' + n,
    status: 'active', revision: 3, summaryRevision: 3, processedRevision: 2, summary: '摘要'.repeat(500), updatedAt: '2026-10-30T00:00:00Z',
    get entries() { return forbidden() }, get decisions() { return forbidden() }, get openQuestions() { return forbidden() } }))
  const requested = []
  const runtime = {
    listTopics: groupId => topics.filter(topic => !groupId || topic.groupId === groupId),
    getTopic: (groupId, id) => topics.find(topic => topic.groupId === groupId && topic.topicId === id),
    getTopicContext: forbidden, listTasks: forbidden, getTopicTasksPage: forbidden,
    listTaskView: async options => { requested.push(options); return { items: [], total: 0, offset: options.offset, limit: options.limit, nextOffset: null } },
    getWorkflowTopicById: async id => id === 'legacy' ? { topicId: id, conversationId: 'g', title: '历史话题' } : null,
  }
  const server = createServer((req, res) => handleRequest(req, res, runtime))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const first = await (await fetch(base + '/state/topics?view=overview&limit=10')).json()
  assert.equal(first.topics.length, 10); assert.equal(first.total, 23)
  assert(first.topics.every(topic => topic.summary.length <= 240 && !('processing' in topic)))
  const second = await (await fetch(base + '/state/topics?view=overview&offset=10&limit=10&pageRevision=' + first.revision)).json()
  assert.equal(second.topics.length, 10); assert(!second.topics.some(topic => first.topics.some(prior => prior.topicId === topic.topicId)))
  const detail = await (await fetch(base + '/state/topics/topic-0?groupId=g&view=overview')).json()
  assert.equal(detail.topic.summary.length, 1000); assert.equal(detail.messages, undefined)
  assert.equal((await fetch(base + '/state/topics/topic-0?groupId=other&view=overview')).status, 404)
  assert.equal((await fetch(base + '/state/topics/legacy?groupId=other&view=overview')).status, 404)
  assert.equal((await fetch(base + '/state/topics/legacy?groupId=g&view=overview')).status, 200)
  await fetch(base + '/state/tasks?groupId=g&topicId=topic-0&archived=all&offset=10&limit=10&view=summary')
  assert.deepEqual(requested[0], { groupId: 'g', topicId: 'topic-0', archived: 'all', offset: 10, limit: 10, state: undefined, revision: undefined, summary: true })
  assert.equal((await fetch(base + '/state/tasks?limit=10&view=invalid')).status, 400)
  assert.equal((await fetch(base + '/state/tasks?view=summary')).status, 400)
})

test('decision history selects newest page before projection, retains older records and rejects stale pages', async t => {
  let reads = 0
  const topic = { topicId: 't', groupId: 'g', revision: 31, updatedAt: '2026-10-30T00:00:00Z',
    decisions: Array.from({ length: 31 }, (_, i) => ({ decisionId: 'd' + i, get decision() { reads++; return { reason: '判断' + i } } })) }
  const server = createServer((req, res) => handleRequest(req, res, { getTopic: (group, id) => group === 'g' && id === 't' ? topic : null,
    getTopicContext: () => { throw new Error('decision history read messages') } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/state/topics/t/decisions`
  const first = await (await fetch(base + '?groupId=g&limit=10')).json()
  assert.equal(reads, 10); assert.equal(first.total, 31); assert.equal(first.items[0].decisionId, 'd30')
  const last = await (await fetch(base + '?groupId=g&offset=30&limit=10&pageRevision=' + first.revision)).json()
  assert.equal(reads, 11); assert.equal(last.items[0].decisionId, 'd0'); assert.equal(last.nextOffset, null)
  topic.updatedAt = '2026-10-30T01:00:00Z'
  assert.equal((await fetch(base + '?groupId=g&offset=10&pageRevision=' + first.revision)).status, 409)
  topic.updatedAt = '2026-10-30T00:00:00Z'
  topic.decisions = topic.decisions.map(item => item.decisionId === 'd0' ? { ...item, status: 'completed' } : item)
  assert.equal((await fetch(base + '?groupId=g&offset=10&pageRevision=' + first.revision)).status, 409, 'status-only resident writes also invalidate the page')
  assert.equal((await fetch(base + '?groupId=other')).status, 404)
  assert.equal((await fetch(base)).status, 400)
  assert.equal((await fetch(base + '?groupId=g&limit=101')).status, 400)
})


test('topic reconciliation HTTP enforces local origin, strict body and separate zero-write check; merged topics remain audit-readable',async t=>{
 const calls=[], topics=[{topicId:'current',groupId:'g',title:'原话题',revision:2,processedRevision:2,status:'active',summary:'',summaryRevision:0,entries:[],decisions:[]},
  {topicId:'retired',groupId:'g',title:'旧Web重复话题',revision:2,processedRevision:2,status:'closed',mergedInto:'current',summary:'',summaryRevision:0,entries:[],decisions:[]}]
 const runtime={listTopics:()=>topics,reconcileWebTaskTopics:async args=>{calls.push(args);return args.checkOnly?{writes:0,expectedDigest:'a'.repeat(64)}:{mergedTopicIds:['retired']}},
  getTopic:(_g,id)=>topics.find(topic=>topic.topicId===id),getTopicContext:async()=>({topic:topics[1],messages:[],total:0})}
 const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const base=`http://127.0.0.1:${server.address().port}`
 const post=(suffix,body,origin)=>fetch(base+'/runtime/task-topics/reconcile'+suffix,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
 assert.equal((await post('/check',{groupId:'g'},'https://outside.invalid')).status,403);assert.equal(calls.length,0)
 assert.equal((await post('/check',{groupId:'g',actorId:'forged'})).status,400);assert.equal(calls.length,0)
 const check=await post('/check',{groupId:'g'});assert.equal(check.status,200);assert.equal((await check.json()).writes,0);assert.equal(calls[0].checkOnly,true)
 assert.equal((await post('',{groupId:'g',requestId:'merge',expectedDigest:'a'.repeat(64)})).status,200);assert.equal(calls[1].checkOnly,false)
 assert.equal((await (await fetch(base+'/state/topics')).json()).total,1)
 assert.equal((await (await fetch(base+'/state/topics?includeMerged=true')).json()).total,2)
 const history=await fetch(base+'/state/topics/retired?groupId=g');assert.equal(history.status,200);assert.equal((await history.json()).topic.mergedInto,'current')
})
