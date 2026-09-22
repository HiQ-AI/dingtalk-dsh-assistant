import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { projectPerformanceEvent, listPerformance, performanceProjectionSchema, workflowPerformance, coordinationCosts } from '../packages/dingtalk-dsh-assistant/performance.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const base = Date.parse('2026-09-21T12:00:00+08:00')
const input = (seq, type, time, data = {}, identity = {}) => ({ sessionId: 's1', groupId: 'g', requestId: 'r1', ...identity, event: { seq, type, time: base + time, data: { turn: 1, step: 0, ...data } } })
function facility(seed = new Map()) {
  let writes = 0
  const writtenKeys = []
  const table = name => ({
    get: key => seed.get(`${name}:${key}`),
    entries: () => [...seed.entries()].filter(([key]) => key.startsWith(`${name}:`)).map(([key, value]) => [key.slice(name.length + 1), value])[Symbol.iterator](),
    async put(key, value) { writes++; writtenKeys.push(`${name}:${key}`); seed.set(`${name}:${key}`, residentDomainSpec.tables[name].valueSchema.parse(value)) },
    async delete(key) { seed.delete(`${name}:${key}`) },
    async update(key, transform) { const value = residentDomainSpec.tables[name].valueSchema.parse(transform(seed.get(`${name}:${key}`))); writes++; writtenKeys.push(`${name}:${key}`); seed.set(`${name}:${key}`, value); return value },
  })
  return { seed, writtenKeys, writes: () => writes, storage: { async open() { return { table, close: async () => {} } } } }
}

test('原生usage互斥分项、首流/完成、并行工具累计与并集以及隐私白名单', () => {
  let projection
  const append = value => { projection = projectPerformanceEvent(projection, value).projection }
  append(input(1, 'step/start', 0))
  append(input(2, 'assistant/chunk', 100, { chunk: { type: 'reasoning-delta', text: '凭据SECRET' } }))
  append(input(3, 'assistant/chunk', 200))
  append(input(4, 'assistant/message', 500, { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 }, message: { content: ['SECRET'] } }))
  append(input(5, 'tool/call', 500, { callId: 'a', name: 'secret-name', arguments: 'SECRET' }))
  append(input(6, 'tool/call', 600, { callId: 'b' }))
  append(input(7, 'tool/result', 1000, { message: { source: { callId: 'a' }, content: [{ type: 'tool-result', content: 'SECRET' }] } }))
  append(input(8, 'tool/result', 1100, { message: { source: { callId: 'b' }, content: [{ type: 'tool-result', isError: true }] } }))
  const [row] = listPerformance(projection).rows
  assert.equal(row.usage.totalInputTokens, 1050)
  assert.equal(row.usage.inputTokens, 100)
  assert.equal(row.usage.cacheReadTokens, 900)
  assert.deepEqual(row.contextTokens, { count: 1, sum: 1050, max: 1050, p50: 1050, p95: 1050 })
  assert.equal(row.firstStreamMs.sum, 100)
  assert.equal(row.modelResponseMs.sum, 500)
  assert.equal(row.toolMs.sum, 1000)
  assert.equal(row.toolActiveMs, 600)
  assert.equal(row.combinedActiveMs, 1100)
  assert.equal(row.toolErrors, 1)
  assert.equal(row.usage.missingFields.reasoningTokens, 1)
  assert.doesNotMatch(JSON.stringify(projection), /SECRET|secret-name|arguments|content/)
  assert.deepEqual(performanceProjectionSchema.parse(projection), projection)
})

test('seed不计、同seq与新seq同step替换不计、低seq后到不丢失；缺失usage明确单列', () => {
  let projection
  const append = value => { const result = projectPerformanceEvent(projection, value); projection = result.projection; return result.created }
  assert.equal(append({ ...input(2, 'assistant/message', 0), seedSeq: 3 }), false)
  assert.equal(append(input(10, 'assistant/message', 10)), true)
  assert.equal(append(input(10, 'assistant/message', 10)), false)
  append(input(11, 'assistant/message', 11, { usage: { inputTokens: 999 } }))
  append(input(4, 'assistant/message', 4, { step: 1, interrupted: true }))
  const [row] = listPerformance(projection).rows
  assert.equal(row.modelCalls, 2)
  assert.equal(row.missingUsage, 2)
  assert.equal(row.missingStepStart, 2)
  assert.equal(row.missingFirstStream, 2)
  assert.equal(row.interrupted, 1)
  assert.equal(row.usage.totalInputTokens, 0)
})

test('上海跨午夜区间分别入日；按request和session隔离', () => {
  let projection
  const midnight = Date.parse('2026-09-22T00:00:00+08:00') - base
  for (const value of [input(1, 'step/start', midnight - 100), input(2, 'assistant/message', midnight + 200), input(1, 'assistant/message', midnight + 300, {}, { sessionId: 's2', requestId: 'r2' })]) projection = projectPerformanceEvent(projection, value).projection
  assert.equal(listPerformance(projection, { day: '2026-09-21' }).rows[0].modelActiveMs, 100)
  assert.equal(listPerformance(projection, { day: '2026-09-22', requestId: 'r1' }).rows[0].modelActiveMs, 200)
  assert.equal(listPerformance(projection, { sessionId: 's2' }).rows[0].modelCalls, 1)
})

test('持久聚合超过500条不丢失、重启去重、高频chunk只持久一次', async () => {
  const memory = facility()
  let store = await openResidentStore(memory.storage)
  await store.recordPerformanceEvent(input(0, 'step/start', 0))
  const before = memory.writes()
  await Promise.all(Array.from({ length: 1000 }, (_, index) => store.recordPerformanceEvent(input(index + 1, 'assistant/chunk', index + 1))))
  assert.equal(memory.writes() - before, 1)
  for (let step = 0; step < 501; step++) await store.recordPerformanceEvent(input(step + 1001, 'assistant/message', step + 1001, { step, usage: { inputTokens: 10, outputTokens: 1 } }))
  assert.equal(store.listPerformance().rows[0].modelCalls, 501)
  await store.close()
  store = await openResidentStore(facility(memory.seed).storage)
  await store.recordPerformanceEvent(input(1001, 'assistant/message', 1001))
  await store.recordPerformanceEvent(input(2, 'assistant/chunk', 2))
  assert.equal(store.listPerformance().rows[0].modelCalls, 501)
  assert.equal(store.listPerformance().rows[0].usage.inputTokens, 5010)
  assert.equal(store.listPerformance().coverage, 'observed-events-only')
  await store.close()
})

test('性能HTTP只读端点传递过滤身份并标注观测范围', async t => {
  const calls = []
  const server = createServer((request, response) => handleRequest(request, response, { listPerformance: filter => { calls.push(filter); return { coverage: 'observed-events-only', rows: [] } } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/state/performance?day=2026-09-21&requestId=r1`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).coverage, 'observed-events-only')
  assert.deepEqual(calls, [{ day: '2026-09-21', requestId: 'r1' }])
})

test('任务排队及各类等待由持久边界派生，审阅并行求并集，历史缺少waitingKind不猜测', () => {
  const at = offset => new Date(base + offset).toISOString()
  const task = { taskId: 't', groupId: 'g', stateHistory: [
    { state: 'queued', at: at(0), runSequence: 1 }, { state: 'running', at: at(100), runSequence: 1 },
    { state: 'waiting', waitingKind: 'system', at: at(500), runSequence: 1 },
    { state: 'waiting', waitingKind: 'human-intervention', at: at(700), runSequence: 1 },
    { state: 'waiting', at: at(900), runSequence: 1 }, { state: 'completed', at: at(1000), runSequence: 1 },
  ], executionEvents: [
    { kind: 'task-report-received', submissionId: 'a', status: 'review-wait', at: at(200), runSequence: 1 },
    { kind: 'task-report-received', submissionId: 'b', status: 'review-wait', at: at(300), runSequence: 1 },
    { kind: 'task-report-settled', submissionId: 'a', status: 'failed', at: at(500), runSequence: 1 },
    { kind: 'task-report-settled', submissionId: 'b', status: 'failed', at: at(600), runSequence: 1 },
  ] }
  const result = workflowPerformance({ tasks: [task], groups: [] }, {}, base + 2000), [row] = result.taskWaits
  assert.equal(row.queuedMs, 100); assert.equal(row.runningMs, 400)
  assert.equal(row.systemWaitMs, 200); assert.equal(row.humanWaitMs, 200); assert.equal(row.unknownWaitMs, 100)
  assert.equal(row.reviewWaitMs, 400)
  assert.ok(row.missing.includes('historical-waiting-kind'))
  const filtered = workflowPerformance({ tasks: [task], groups: [] }, { requestId: 'unknown' }, base + 2000)
  assert.deepEqual(filtered.taskWaits, [])
  assert.ok(filtered.missing.includes('task-state-has-no-request-session-submission-link'))
})

test('回复必须已送达且精确引用源消息；回执与实质标签分开，不制造人工确认', () => {
  const group = { groupId: 'g', messages: [{ messageId: 'm', occurredAt: base, text: 'SECRET' }, { messageId: 'unmatched', occurredAt: base }], outbox: [
    { outboundId: 'pending', status: 'pending', replyToMessageId: 'm', deliveredAt: new Date(base + 1).toISOString() },
    { outboundId: 'ack', status: 'sent', replyToMessageId: 'm', deliveredMessageId: 'remote-ack', deliveredAt: new Date(base + 100).toISOString(), replyKind: 'confirmation', text: 'SECRET' },
    { outboundId: 'answer', status: 'sent', replyToMessageId: 'm', deliveredMessageId: 'remote-answer', deliveredAt: new Date(base + 500).toISOString(), replyKind: 'substantive' },
  ] }
  const result = workflowPerformance({ tasks: [], groups: [group] }, {}, base + 1000)
  assert.equal(result.responses[0].firstReplyMs, 100)
  assert.equal(result.responses[0].firstLabeledSubstantiveReplyMs, 500)
  assert.equal(result.responses[1].firstReplyMs, null)
  assert.ok(result.missing.includes('substantive-reply-label-is-not-manual-content-verification'))
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('关闭step清理已配对状态且缺失工具结果明确计数，替换不重计，协调传递仅保留字节数', () => {
  let projection
  const append = value => { projection = projectPerformanceEvent(projection, value).projection }
  append(input(1, 'user/message', 0, { source: { kind: 'coordinator' }, content: [{ type: 'text', text: 'SECRET' }] }))
  append(input(2, 'step/start', 1))
  append(input(3, 'assistant/message', 5, { usage: { inputTokens: 10, outputTokens: 1 } }))
  append(input(4, 'tool/call', 6, { callId: 'orphan' }))
  append(input(5, 'step/end', 7))
  append(input(6, 'assistant/message', 8, { usage: { inputTokens: 99, outputTokens: 1 } }))
  assert.deepEqual(projection.sessions.s1.calls, {})
  assert.deepEqual(projection.sessions.s1.steps, {})
  assert.deepEqual(projection.sessions.s1.completedSteps, { 1: [[0, 0]] })
  const rows = listPerformance(projection).rows
  assert.equal(rows[0].modelCalls, 1); assert.equal(rows[0].missingToolResult, 1)
  const [request] = coordinationCosts(rows).requests
  assert.equal(request.coordinationMessages, 1)
  assert.equal(request.coordinationInputBytes, Buffer.byteLength(JSON.stringify([{ type: 'text', text: 'SECRET' }])))
  assert.doesNotMatch(JSON.stringify(projection), /SECRET/)
})

test('按会话分区持久化，一个会话增加指标不重写其它会话历史', async () => {
  const memory = facility(), store = await openResidentStore(memory.storage)
  await store.recordPerformanceEvent(input(1, 'assistant/message', 1))
  const first = structuredClone(memory.seed.get('scheduler:performance:s1'))
  memory.writtenKeys.length = 0
  await store.recordPerformanceEvent(input(1, 'assistant/message', 1, {}, { sessionId: 's2' }))
  assert.deepEqual(memory.writtenKeys, ['scheduler:performance:s2'])
  assert.deepEqual(memory.seed.get('scheduler:performance:s1'), first)
  assert.equal(store.listPerformance().rows.length, 2)
  assert.equal(store.listPerformance().retention.writePartition, 'session')
  await store.close()
})

test('原生Domain首次写入性能分区并在重启后续写', async () => {
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'performance-native-test' })
  let store = await openResidentStore(facility)
  await store.recordPerformanceEvent(input(1, 'step/start', 0))
  assert.ok(snapshot.tables.scheduler['performance:s1'])
  await store.close()
  store = await openResidentStore(facility)
  await store.recordPerformanceEvent(input(2, 'assistant/message', 100, { usage: { inputTokens: 10, outputTokens: 2 } }))
  assert.equal(store.listPerformance().rows[0].modelCalls, 1)
  await store.close()
})

test('协调队列只采用真实入队和分派边界，同seq不重复，错误身份与逆序时间单列缺失', () => {
  let projection
  const dispatch = input(1, 'dingtalk/coordination-dispatched', 500, { requestId: 'r1', queuedAt: base, dispatchedAt: base + 500 })
  for (const value of [dispatch, dispatch,
    input(2, 'dingtalk/coordination-dispatched', 600, { requestId: 'r1', queuedAt: base + 300, dispatchedAt: base + 600 }),
    input(3, 'dingtalk/coordination-dispatched', 700, { requestId: 'wrong', queuedAt: base, dispatchedAt: base + 700 }),
    input(4, 'dingtalk/coordination-dispatched', 800, { requestId: 'r1', queuedAt: base + 900, dispatchedAt: base + 800 }),
  ]) projection = projectPerformanceEvent(projection, value).projection
  const rows = listPerformance(projection).rows
  assert.deepEqual(rows[0].coordinationQueueMs, { count: 2, sum: 800, max: 500, p50: 300, p95: 500 })
  assert.equal(rows[0].missingCoordinationQueue, 2)
  const [request] = coordinationCosts(rows).requests
  assert.equal(request.queueSamples, 2); assert.equal(request.queueMs, 800); assert.equal(request.missingQueueBoundaries, 2)
})
