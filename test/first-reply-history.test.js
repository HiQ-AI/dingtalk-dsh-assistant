import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readBoundedHistoricalSources } from '../docs/acceptance/topic-routing-quality/scripts/first-reply-bounded.mjs'
import { installBoundedTopicGuard, isolatedEffects, redactCredential, redactCredentialValue } from '../docs/acceptance/topic-routing-quality/scripts/first-reply-isolation.mjs'
import { readHistoricalFirstReply } from '../docs/acceptance/topic-routing-quality/scripts/first-reply-history.mjs'

const user = value => ({ type: 'user/message', data: { content: [{ text: `Topic 请求：${JSON.stringify(value)}\n说明` }] } })
const result = value => ({ type: 'tool/result', data: { message: { content: [{ text: JSON.stringify(value) }] } } })
const assistant = label => ({ type: 'assistant/message', data: { usage: { inputTokens: 1 }, stream: [{ type: 'tool-call-chunks', time0: 1, dt: [], args: [label] }] } })

test('历史提取限定指定请求，排除同会话后续工具结果与流', async t => {
  const root = await mkdtemp(join(tmpdir(), 'first-reply-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const residentPath = join(root, 'resident.json'), decisionSessionPath = join(root, 'decision.jsonl'), routeSessionPath = join(root, 'route.jsonl')
  const messages = [773, 774, 778, 780, 783].map(sequence => ({ sequence, messageId: `message-${sequence}` }))
  const group = { messages, outbox: [], topics: [{ topicId: 'topic', decisions: [{ decisionId: 'decision', revision: 1, decision: { basisMessageIds: ['message-773'] } }] }], routeHistory: [{ routeId: 'route', audit: { messageId: 'message-773' } }] }
  await writeFile(residentPath, JSON.stringify({ tables: { groups: { group } } }))
  const save = (path, events) => writeFile(path, events.map(event => JSON.stringify(event)).join('\n'))
  await save(decisionSessionPath, [user({ requestId: 'decision', topicId: 'topic', revision: 1, messages: [] }), result({ replyReview: { candidates: [] }, marker: 'correct' }), assistant('correct'), user({ requestId: 'later', topicId: 'topic', revision: 1 }), result({ replyReview: { candidates: [] }, marker: 'later' }), assistant('later')])
  await save(routeSessionPath, [user({ requestId: 'route', messages: [] }), result({ marker: 'route' }), assistant('route'), user({ requestId: 'later-route' }), result({ marker: 'later' }), assistant('later')])
  const snapshot = await readHistoricalFirstReply({ residentPath, decisionSessionPath, routeSessionPath, sequence: 773 })
  assert.deepEqual(snapshot.results.map(item => item.marker), ['correct'])
  assert.deepEqual(snapshot.assistantStreams.map(item => item.stream[0].args[0]), ['correct'])
  assert.deepEqual(snapshot.route.results.map(item => item.marker), ['route'])
  assert.deepEqual(snapshot.route.assistantStreams.map(item => item.stream[0].args[0]), ['route'])
  await save(decisionSessionPath, [user({ requestId: 'decision', topicId: 'topic', revision: 1, messages: [] }), result({ replyReview: { candidates: [] } }), { type: 'assistant/message', data: { stream: [{ type: 'tool-call-chunks', time0: 1, dt: [1], args: ['incomplete'] }] } }])
  await assert.rejects(() => readHistoricalFirstReply({ residentPath, decisionSessionPath, routeSessionPath, sequence: 773 }), /historical_stream_invalid/)
})

test('历史来源只保留有证资源身份并拒绝身份和时间冲突', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bounded-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'source.db'), db = new DatabaseSync(path)
  db.exec('CREATE TABLE dynamic_sources (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
  const source = { id: 's', sourceId: 's', groupId: 'g', messageId: 'm', version: 1, actorId: 'a', text: 'text', routedAt: '2026-01-01T00:00:00Z', quote: { text: 'quote' }, resources: [{ type: 'file', fileId: 'f', download: { url: 'later' } }] }
  const save = () => db.prepare('INSERT OR REPLACE INTO dynamic_sources VALUES (?, ?)').run(source.sourceId, JSON.stringify(source))
  const fixture = { input: { occurredAt: '2026-01-02T00:00:00Z' }, group: { groupId: 'g', topics: [{ entries: [{ messageId: 'm', messageVersion: 1 }] }], messages: [{ messageId: 'm', messageVersion: 1, senderOpenDingTalkId: 'a', text: 'text', occurredAt: '2026-01-01T00:00:00Z' }], outbox: [] } }
  save()
  const [result] = readBoundedHistoricalSources(path, fixture)
  assert.deepEqual(result.resources, [{ type: 'file', fileId: 'f' }])
  assert.deepEqual(result.quote, source.quote)
  assert.equal(result.timestamp, undefined)
  source.resources = [{ type: 'file', download: { url: 'unproven' } }]; save()
  assert.throws(() => readBoundedHistoricalSources(path, fixture), /bounded_source_resource_identity_unverified/)
  source.resources = []; source.actorId = 'other'; save()
  assert.throws(() => readBoundedHistoricalSources(path, fixture), /bounded_source_historical_evidence_missing/)
  source.actorId = 'a'; save(); fixture.group.messages[0].occurredAt = 'invalid'
  assert.throws(() => readBoundedHistoricalSources(path, fixture), /bounded_source_message_invalid/)
  db.close()
})

test('隔离空会话取消可记录，Owner运行始终禁止', async () => {
  const effects = isolatedEffects()
  await effects.taskSessions.cancel('task')
  assert.equal(effects.emptyCancels.length, 1)
  await assert.rejects(() => effects.taskSessions.run({ taskId: 'task' }), /evaluation_owner_forbidden/)
  assert.equal(effects.ownerAttempts.length, 1)
})

test('凭据脱敏保留非敏感错误及 JSON 格式', () => {
  const secret = 'synthetic-"key\\value'
  const message = `gateway error ${secret}; code=AUTH`
  assert.equal(redactCredential(message, secret), 'gateway error [REDACTED]; code=AUTH')
  const sanitized = JSON.parse(redactCredential(JSON.stringify({ reason: { failure: { message, code: 'AUTH' } } }), secret, true))
  assert.equal(sanitized.reason.failure.message, 'gateway error [REDACTED]; code=AUTH')
  assert.equal(sanitized.reason.failure.code, 'AUTH')
  const encodedMessage = `gateway error ${JSON.stringify(secret).slice(1, -1)}; code=AUTH`
  const finish = redactCredentialValue({ reason: { failure: { message: encodedMessage, code: 'AUTH' } } }, secret)
  assert.equal(finish.reason.failure.message, 'gateway error [REDACTED]; code=AUTH')
  const evidence = JSON.parse(JSON.stringify(redactCredentialValue({ finish, error: encodedMessage }, secret)))
  assert.equal(evidence.error, 'gateway error [REDACTED]; code=AUTH')
})

test('隔离 guard 仅接受同一可信请求实际可见的目标短引用', () => {
  let guard
  installBoundedTopicGuard({ tools: { guard: fn => { guard = fn } } }, { groupId: 'g', targetTopicId: 'target' })
  const requestId = 'coord-route-test', suffix = createHash('sha256').update(`g:${requestId}`).digest('hex').slice(0, 24)
  const events = [{ type: 'plugin:dingtalk/coordination', data: { groupId: 'g', requestId, role: 'route' } }]
  const envelope = { requestId, topics: [{ topicId: 'target', shortRef: 'visible' }, { topicId: 'other', shortRef: 'foreign' }], relatedTopics: [], recalledTopics: [] }
  const messages = [{ role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `[GROUP_TOPIC_ROUTE]\nTopic 请求：${JSON.stringify(envelope)}\n说明` }] }]
  const session = { id: `session-coordination-${suffix}-12345678`, snapshotEvents: () => events, deriveMessages: () => messages }
  const check = topicId => guard({ name: 'group_topic_context_get', arguments: { topicId }, agent: { session } })
  assert.equal(check('visible'), undefined)
  assert.equal(check('target'), undefined)
  assert.equal(check('foreign'), 'bounded_historical_topic_details_unavailable')
  assert.equal(check(undefined), undefined)
  messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'group_topic_list' }] }, { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify({ topics: [{ topicId: 'target', shortRef: 'searched' }] }) }] })
  assert.equal(check('searched'), undefined)
  messages[2].isError = true
  assert.equal(check('searched'), 'bounded_historical_topic_details_unavailable')
  messages[0].source.kind = 'user'
  assert.equal(check('visible'), 'bounded_historical_topic_details_unavailable')
  messages[0].source.kind = 'coordinator'
  session.id = 'session-coordination-other-12345678'
  assert.equal(check('visible'), 'bounded_historical_topic_details_unavailable')
  const decisionId = 'coord-decision-test'
  events[0].data = { groupId: 'g', requestId: decisionId, role: 'decision' }
  session.id = `session-coordination-${createHash('sha256').update(`g:${decisionId}`).digest('hex').slice(0, 24)}-12345678`
  const decision = topicId => ({ role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `[GROUP_TOPIC_DECISION]\nTopic 请求：${JSON.stringify({ requestId: decisionId, topicId })}\n说明` }] })
  messages.splice(0, messages.length, decision('target'))
  assert.equal(check(undefined), undefined)
  messages.push(decision('other'))
  assert.equal(check(undefined), 'bounded_historical_topic_details_unavailable')
  messages[1].source.kind = 'user'
  assert.equal(check(undefined), undefined)
  messages[0].source.kind = 'user'
  assert.equal(check(undefined), 'bounded_historical_topic_details_unavailable')
})
