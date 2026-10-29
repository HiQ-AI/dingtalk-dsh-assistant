import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { createFixedTopicHandler } from '../packages/dingtalk-dsh-assistant/fixed-topic-handler.js'
import { FIXED_TOPICS, fixedUnitRequestId, platformTaskPage } from '../packages/dingtalk-dsh-assistant/fixed-topics.js'
import { topicRouteSubmissionSchema } from '../packages/dingtalk-dsh-assistant/decision.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { normalizeHistoryMessage } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import { createFixedTopicPages } from '../packages/dingtalk-dsh-assistant/observer-fixed-topic-pages.js'
import { messageProcessingProjection } from '../packages/dingtalk-dsh-assistant/observer-message-projection.js'
import { correctOutOfScope } from '../packages/dingtalk-dsh-assistant/fixed-topic-correction.js'

async function fixture(t, { tasks = [], decide = async () => {}, timezone = 'Asia/Shanghai', readMentioned, snapshot = { tables: {}, global: null } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fixed-topic-'))
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'fixed-topic-test' })
  const store = await openResidentStore(facility)
  await store.subscribe({ groupId: 'g', responsibility: '修复UPR业务', timezone })
  const created = [], errors = [], replies = [], sections = []
  const ctx = { agents: { async create(options) {
    const tools = new Map(), hooks = new Map(); let pending = Promise.resolve()
    const agent = { session: { id: options.sessionId }, steer(message) { pending = Promise.resolve().then(() => decide({ message, tools, exec: { agent } })) }, whenIdle: () => pending, cancel() {} }
    const record = { options, tools }; created.push(record)
    await options.setup({
      get: name => name === 'agentPresets' ? { mount: async () => ({ id: 'preset' }) } : undefined,
      tools: { register(tool) { tools.set(tool.name, tool) }, restrict(value) { record.allowed = value.allow }, guard(fn) { record.guard = fn } },
      on: (event, fn) => hooks.set(event, fn), systemPrompt: { section: section => sections.push(section) },
    })
    return { agent, async dispose() {} }
  } } }
  const handler = createFixedTopicHandler({ ctx, store, root, legacy: { getAgentConfig: () => ({ agentPreset: 'preset' }) },
    now: () => Date.parse('2026-10-28T00:30:00Z'), readTasks: async groupId => { assert.equal(groupId, 'g'); return tasks },
    readMentioned, onError: (_group, error) => errors.push(error),
    appendOutbox: async args => { replies.push(args); return store.appendOutbox(args) },
  })
  t.after(async () => { await handler.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return { store, handler, created, errors, replies, sections, async route(text, units, extra = {}) {
    await store.ingest({ groupId: 'g', messageId: 'm', text, occurredAt: '2026-10-28T00:00:00Z', senderOpenDingTalkId: 'actor', ...extra })
    const args = topicRouteSubmissionSchema.parse({ requestId: 'r', routes: [{ messageId: 'm', messageVersion: 1, units }] })
    return store.routeMessages({ groupId: 'g', routeId: 'r', routingRevision: 0, routes: args.routes })
  } }
}
const unit = (key, quote, fixedTopic) => ({ unitKey: key, summary: key, sourceRefs: [{ quote }], topics: [], fixedTopic, reason: '语义分类' })

test('manual correction assigns all 416–422 to out-of-scope silently, preserving audit, sent replies and existing tasks across restart', async t => {
  const snapshot = { tables: {}, global: null }, f = await fixture(t, { snapshot, readMentioned: async () => { throw new Error('must not read mentions') } })
  const texts = ['你们的cortex还能用吗', '我用Claude，还能用', '客户端似乎噶了', '间隔一会儿重试几次', '又复活了，神奇',
    '鹏哥那套好像有个优先使用号池里上次对话的账号，你前面用的账号用量满了', '没你的事，不是找你']
  for (const [i, text] of texts.entries()) await f.store.ingest({ groupId: 'g', messageId: `m${416 + i}`, text, occurredAt: '2026-10-29T05:09:00Z',
    ...(i === 6 ? { quotedMessage: { messageId: 'old-reply', content: '你需要重试什么？' } } : {}) })
  const routed = await f.store.routeMessages({ groupId: 'g', routeId: 'old-route', routingRevision: 0,
    routes: texts.map((_, i) => ({ messageId: `m${416 + i}`, messageVersion: 1,
      topics: i === 3 ? [{ newTopicKey: 'retry', title: '重试对象待确认' }] : [], reason: '旧分类' })) })
  const topicId = routed.topicIdsByKey.retry
  await f.store.acceptTopicDecision({ groupId: 'g', topicId, revision: 1, decisionId: 'old-decision', decision: { actions: [], reason: '旧判断', reply: '你需要重试什么？' } })
  await f.store.completeTopicDecision({ groupId: 'g', topicId, decisionId: 'old-decision' })
  await f.store.appendOutbox({ groupId: 'g', outboundId: 'old-reply', sourceMessageId: 'm419', text: '你需要重试什么？' })
  await f.store.acknowledge({ groupId: 'g', outboundId: 'old-reply', deliveredMessageId: 'sent-old-reply' })
  await f.store.markMessageAgentDelivery({ groupId: 'g', messageId: 'm421', status: 'decision-failed', error: 'dws_mentions_read_incomplete' })
  const task = { taskId: 'task-existing', groupId: 'g', state: 'running', topicRefs: [{ topicId: 'unrelated', revision: 1 }] }
  f.store.setTaskSessionReader({ listTasks: () => [task] })
  const before = structuredClone(f.store.getGroup('g')), taskBefore = structuredClone(task)
  const args = { groupId: 'g', requestId: 'manual-416-422', routingRevision: 1, reason: '用户明确纠正：同事间工具账号讨论，全部属于职责外话题。保持沉默。',
    messages: texts.map((_, i) => ({ messageId: `m${416 + i}`, messageVersion: 1 })) }
  const receipt = await f.store.correctFixedTopicClassification(args)
  const corrected = structuredClone(f.store.getGroup('g'))
  assert.equal(receipt.kind, 'manual-fixed-topic-correction')
  assert.deepEqual(receipt.closedTopicIds, [topicId])
  assert.equal(receipt.sources.find(item => item.messageId === 'm421').agentDeliveryError, 'dws_mentions_read_incomplete')
  assert.deepEqual(corrected.outbox, before.outbox)
  assert.deepEqual(corrected.topics[0].decisions, before.topics[0].decisions)
  assert.deepEqual(corrected.routeHistory.slice(0, -1), before.routeHistory)
  assert.equal(corrected.topics[0].entries.at(-1).action, 'remove')
  assert.equal(corrected.topics[0].processedRevision, corrected.topics[0].revision)
  assert.deepEqual(task, taskBefore)
  for (const message of corrected.messages) {
    const active = message.units.filter(unit => message.activeUnitRefs.some(ref => ref.unitId === unit.unitId && ref.unitRevision === unit.unitRevision))
    assert.equal(active.length, 1); assert.equal(active[0].fixedTopic, 'out-of-scope'); assert.ok(active[0].fixedTopicHandledAt)
    const projected = messageProcessingProjection(message, corrected.topics, { routed: false }, [])
    assert.equal(projected.processingState, 'processed'); assert.equal(projected.processingBasis, 'manual-fixed-topic-correction')
    assert.equal(projected.processingConclusion, args.reason)
    assert.equal(message.replyTopicId, undefined)
  }
  assert.deepEqual(await f.store.correctFixedTopicClassification(args), receipt)
  assert.deepEqual(f.store.getGroup('g'), corrected)
  await f.store.markMessageAgentDelivery({ groupId: 'g', messageId: 'm421', status: 'decision-failed', error: 'late-old-error' })
  assert.equal(f.store.getGroup('g').messages[5].agentDeliveryStatus, 'delivered')
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.equal(f.created.length, 0); assert.equal(f.replies.length, 0); assert.deepEqual(f.errors, [])
  await f.store.close()
  const restarted = await fixture(t, { snapshot, readMentioned: async () => { throw new Error('must not replay') } })
  assert.deepEqual(await restarted.store.correctFixedTopicClassification(args), receipt)
  restarted.handler.schedule('g'); await restarted.handler.whenIdle()
  const page = await restarted.store.listFixedTopicMessagesPage({ groupId: 'g', topicId: 'out-of-scope' })
  assert.equal(page.total, 7); assert.ok(page.items.every(item => item.state === 'silent' && item.manualCorrection.requestId === args.requestId))
  await restarted.store.ingest({ groupId: 'g', messageId: 'm421', text: texts[5], occurredAt: '2026-10-29T05:09:00Z', senderName: '补全发送人', mentionedAgent: true })
  restarted.handler.schedule('g'); await restarted.handler.whenIdle()
  assert.equal(restarted.store.getGroup('g').messages[5].routingStatus, 'routed', 'late metadata cannot undo explicit silence')
  assert.equal(restarted.replies.length, 0); assert.equal(restarted.created.length, 0); assert.deepEqual(restarted.errors, [])
  await restarted.store.ingest({ groupId: 'g', messageId: 'm421', text: '新增业务请求', messageVersion: 3, occurredAt: '2026-10-29T05:09:00Z' })
  assert.equal(restarted.store.getGroup('g').messages[5].routingStatus, 'pending', 'changed source content still needs routing')
})

test('manual fixed correction rejects stale/busy batches atomically and preserves topics with existing tasks', async t => {
  const f = await fixture(t)
  await f.route('业务', [{ unitKey: 'business', summary: '业务', sourceRefs: [{ quote: '业务' }], topics: [{ newTopicKey: 'b', title: '业务' }] }])
  const topicId = f.store.getGroup('g').topics[0].topicId
  const args = { groupId: 'g', requestId: 'correction', routingRevision: 1, reason: '人工纠正', messages: [{ messageId: 'm', messageVersion: 1 }] }
  const before = structuredClone(f.store.getGroup('g'))
  await assert.rejects(f.store.correctFixedTopicClassification({ ...args, messages: [...args.messages, { messageId: 'missing', messageVersion: 1 }] }), /FIXED_TOPIC_CORRECTION_STALE/)
  assert.deepEqual(f.store.getGroup('g'), before)
  await f.store.acceptTopicDecision({ groupId: 'g', topicId, revision: 1, decisionId: 'pending', decision: { actions: [], reason: 'pending' } })
  await assert.rejects(f.store.correctFixedTopicClassification(args), /FIXED_TOPIC_CORRECTION_BUSY/)
  await f.store.completeTopicDecision({ groupId: 'g', topicId, decisionId: 'pending' })
  await f.store.appendOutbox({ groupId: 'g', outboundId: 'sending', sourceMessageId: 'm', text: 'existing' })
  await assert.rejects(f.store.correctFixedTopicClassification(args), /FIXED_TOPIC_CORRECTION_BUSY/)
  await f.store.acknowledge({ groupId: 'g', outboundId: 'sending' })
  const archived = structuredClone(f.store.getGroup('g'))
  archived.topics[0].decisions[0].operations = [{ operationId: 'historical-task', actionIndex: 0, taskId: 'task-archived', status: 'applied' }]
  const { groupId: _groupId, ...input } = args
  assert.equal(correctOutOfScope(archived, input, []).group.topics[0].status, 'active', 'durable task audit retains an archived task topic absent from the hot cache')
  const task = { groupId: 'g', taskId: 'task-existing', state: 'running', topicRefs: [{ topicId, revision: 1 }] }
  f.store.setTaskSessionReader({ listTasks: () => [task] })
  await f.store.correctFixedTopicClassification(args)
  assert.equal(f.store.getGroup('g').topics[0].status, 'active', 'existing task topic is retained')
  await assert.rejects(f.store.correctFixedTopicClassification({ ...args, reason: 'different request' }), /FIXED_TOPIC_CORRECTION_IDENTITY_CONFLICT/)
  assert.equal(task.state, 'running')
})

test('fixed reply queued behind a manual correction cannot prepare an outbox entry', async t => {
  const f = await fixture(t, { readMentioned: async () => true })
  await f.route('天气', [unit('weather', '天气', 'out-of-scope')])
  const append = f.store.appendOutbox
  f.store.appendOutbox = async args => {
    await f.store.correctFixedTopicClassification({ groupId: 'g', requestId: 'during-send', reason: '人工确认保持沉默', routingRevision: 1,
      messages: [{ messageId: 'm', messageVersion: 1 }] })
    return append(args)
  }
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.equal(f.store.getGroup('g').outbox.length, 0)
  assert.deepEqual(f.errors, [], 'superseded reply must not fail unrelated in-flight sources through the group error callback')
  assert.equal(f.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
})

test('plugin ensures durable fixed topics for existing/new groups, idempotently before any message', async t => {
  const snapshot = { tables: {}, global: null }, first = await fixture(t, { snapshot })
  await Promise.all(Array.from({ length: 5 }, () => first.store.subscribe({ groupId: 'new', responsibility: '' })))
  for (const id of ['g', 'new']) {
    assert.deepEqual(first.store.listFixedTopics(id).map(item => item.topicId), FIXED_TOPICS.map(item => item.topicId))
    assert.equal(first.store.getGroup(id).messages.length, 0)
    assert.equal(first.store.getGroup(id).topics.length, 0)
    assert.equal(snapshot.tables.groups[id].fixedTopics.length, 2, 'stored before the first message')
  }
  const preserved = structuredClone(snapshot.tables.groups.new.fixedTopics)
  await first.store.close()
  delete snapshot.tables.groups.g.fixedTopics // upgrade an already subscribed group
  const upgraded = await fixture(t, { snapshot })
  assert.equal(snapshot.tables.groups.g.fixedTopics.length, 2)
  assert.deepEqual(upgraded.store.listFixedTopics('new'), preserved)
  const stable = structuredClone(snapshot.tables.groups.g.fixedTopics)
  await upgraded.store.close()
  const again = await fixture(t, { snapshot })
  assert.deepEqual(again.store.listFixedTopics('g'), stable)
  assert.equal(again.store.listTopics().length, 0)
})

test('fixed topic pages survive restart, expose pending/failure/silence/reply independently, and never create business topics', async t => {
  const snapshot = { tables: {}, global: null }, f = await fixture(t, { snapshot })
  for (const { topicId } of FIXED_TOPICS) assert.equal((await f.store.listFixedTopicMessagesPage({ topicId })).total, 0)
  await f.route('天气', [unit('outside', '天气', 'out-of-scope')], { mentionedAgent: true })
  const page = () => f.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope', groupId: 'g' })
  const first = await page(); assert.equal(first.items[0].state, 'pending')
  await f.store.markMessageAgentDelivery({ groupId: 'g', messageId: 'm', status: 'decision-failed', error: 'dws_mentions_read_incomplete' })
  assert.equal((await page()).items[0].state, 'failed')
  assert.equal((await page()).items[0].error, 'dws_mentions_read_incomplete')
  await assert.rejects(f.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope', groupId: 'g', revision: first.revision }), { code: 'OBSERVER_PAGE_STALE' })
  f.handler.schedule('g'); await f.handler.whenIdle()
  const prepared = (await page()).items[0]
  assert.equal(prepared.state, 'replied'); assert.equal(prepared.reply.status, 'pending'); assert.equal(prepared.error, undefined)
  await f.store.acknowledge({ groupId: 'g', outboundId: prepared.reply.outboundId, deliveredMessageId: 'ding-reply' })
  await f.store.close()
  const reopened = await fixture(t, { snapshot })
  const restored = await reopened.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope' })
  assert.equal(restored.items[0].reply.deliveredMessageId, 'ding-reply')
  await reopened.store.ingest({ groupId: 'g', messageId: 'm', messageVersion: 2, text: '天气', occurredAt: '2026-10-28T00:00:00Z', senderName: '补全发送人' })
  assert.equal((await reopened.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope' })).items[0].reply.deliveredMessageId, 'ding-reply', 'enrichment preserves the explicit unit/reply association')
  assert.equal(reopened.store.listTopics().length, 0)
  assert.equal(reopened.replies.length, 0, 'reading/restarting the observer does not replay messages')
  const silent = await fixture(t)
  await silent.route('天气', [unit('outside', '天气', 'out-of-scope')], { mentionedAgent: false })
  silent.handler.schedule('g'); await silent.handler.whenIdle()
  assert.equal((await silent.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope' })).items[0].state, 'silent')
})

test('fixed topic reads select stable metadata pages without scanning messages or reading other bodies', async () => {
  let readOnly = false, bodyReads = 0
  const raw = Array.from({ length: 205 }, (_, i) => ({ messageId: `m${i}`, messageVersion: 1, sequence: i + 1, occurredAt: '2026-10-29T00:00:00Z',
    get text() { bodyReads++; assert(i >= 185 && i < 195); return `body${i}` },
    units: [{ unitId: `u${i}`, unitRevision: 1, fixedTopic: 'out-of-scope', summary: '天气', sourceRanges: [{ quote: '天气' }] }], activeUnitRefs: [{ unitId: `u${i}`, unitRevision: 1 }] }))
  const messages = new Proxy(raw, { get(target, key) { if (readOnly && !/^\d+$/.test(String(key))) throw new Error('GET scanned all messages'); return Reflect.get(target, key) } })
  const group = { groupId: 'g', messages, outbox: [] }, empty = { groupId: 'empty', messages: [], outbox: [] }
  const pages = createFixedTopicPages(id => id === 'g' ? group : empty)
  pages.update(group); pages.update(empty); assert.equal(bodyReads, 0); readOnly = true
  const page = await pages.page({ topicId: 'out-of-scope', offset: 10, limit: 10 })
  assert.equal(page.total, 205); assert.equal(page.items.length, 10); assert.equal(bodyReads, 10); assert.equal(page.nextOffset, 20)
  assert.equal(new Set(page.items.map(item => item.id)).size, 10); assert.equal(page.items[0].messageId, 'm194')
  assert.equal((await pages.page({ topicId: 'out-of-scope', groupId: 'empty' })).total, 0)
  assert.equal((await pages.page({ topicId: 'agent-platform' })).total, 0)
  await assert.rejects(pages.page({ topicId: 'out-of-scope', limit: 101 }), { code: 'OBSERVER_PAGE_INVALID' })
  pages.remove('g'); assert.equal((await pages.page({ topicId: 'out-of-scope' })).total, 0)
})

for (const mentionedAgent of [true, false, undefined]) test('out-of-scope fixed route respects native mention and duplicate identity: ' + mentionedAgent, async t => {
  const f = await fixture(t, { readMentioned: async () => false })
  await f.route('@助理帮我买咖啡', [unit('outside', '@助理帮我买咖啡', 'out-of-scope')], { mentionedAgent })
  f.handler.schedule('g'); f.handler.schedule('g'); await f.handler.whenIdle()
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.equal(f.created.length, 0)
  assert.equal(f.replies.length, mentionedAgent === true ? 1 : 0)
  if (mentionedAgent) { assert.equal(f.replies[0].text, '这个不是我负责哦'); assert.equal(f.replies[0].replyToMessageId, 'm'); assert.equal(f.replies[0].replyToSenderOpenDingTalkId, 'actor') }
  assert.equal(f.store.getGroup('g').topics.length, 0)
  assert.equal(f.store.getGroup('g').messages[0].agentDeliveryStatus, 'delivered')
  assert.deepEqual(f.errors, [])
})

test('native mention lookup used when event metadata is absent', async t => {
  let lookups = 0
  const f = await fixture(t, { readMentioned: async (groupId, message) => { lookups++; assert.equal(groupId, 'g'); assert.equal(message.messageId, 'm'); return true } })
  await f.route('请看天气', [unit('outside', '请看天气', 'out-of-scope')])
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.equal(lookups, 1); assert.equal(f.replies.length, 1)
})

for (const state of ['running', 'completed']) test('platform readonly session queries all pages including archived, submits once: ' + state, async t => {
  const tasks = Array.from({ length: 103 }, (_, i) => ({ taskId: `t${String(i).padStart(3, '0')}`, title: '本群任务' + i, groupId: 'g', state, completedAt: '2026-10-27T10:00:00Z', archivedAt: i % 2 ? '2026-10-27T11:00:00Z' : null }))
  tasks.push({ taskId: 'secret', title: '其他群不可见', groupId: 'other', state })
  let seen = 0
  const f = await fixture(t, { tasks, decide: async ({ tools, exec }) => {
    assert.deepEqual([...tools.keys()].sort(), ['platform_reply_submit', 'platform_task_query'])
    let args = { state, ...(state === 'completed' ? { day: 'yesterday' } : {}), limit: 40 }
    do {
      const page = tools.get('platform_task_query').execute(args, exec)
      seen += page.items.length
      if (page.hasMore) await assert.rejects(tools.get('platform_reply_submit').execute({ text: '未读完不能宣称全部' }, exec), /platform_task_pages_unread/)
      assert.equal(page.timezone, 'Asia/Shanghai')
      if (state === 'completed') { assert.equal(page.range.localDate, '2026-10-27'); assert.equal(page.range.endExclusive, '2026-10-28 00:00:00') }
      args = page.nextCall?.arguments
    } while (args)
    await tools.get('platform_reply_submit').execute({ text: `本群有${seen}项。` }, exec)
  } })
  await f.route('现在有哪些任务', [unit('platform', '现在有哪些任务', 'agent-platform')])
  f.handler.schedule('g'); await f.handler.whenIdle(); f.handler.schedule('g'); await f.handler.whenIdle()
  assert.deepEqual(f.errors, []); assert.equal(seen, 103); assert.equal(f.created.length, 1); assert.equal(f.replies.length, 1)
  assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.getGroup('g').topics.length, 0)
  assert.deepEqual(f.created[0].allowed, ['platform_task_query', 'platform_reply_submit'])
  for (const name of ['task_wake', 'task_create', 'pwsh', 'write', 'group_decision_submit']) assert.equal(f.created[0].guard({ name }), 'platform_query_readonly')
})

test('platform empty list and explicit management boundary need no business task', async t => {
  const f = await fixture(t, { decide: async ({ tools, exec }) => {
    const page = tools.get('platform_task_query').execute({ state: 'running' }, exec)
    assert.equal(page.total, 0); assert.equal(page.hasMore, false); assert.equal(page.complete, true)
    await assert.rejects(tools.get('platform_reply_submit').execute({ text: '' }, exec), /platform_reply_empty/)
    await tools.get('platform_reply_submit').execute({ text: '当前没有执行中任务。这里只能查询，不能取消任务。' }, exec)
  } })
  await f.route('取消所有任务并告诉我运行列表', [unit('platform', '取消所有任务并告诉我运行列表', 'agent-platform')])
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.deepEqual(f.errors, []); assert.equal(f.replies.length, 1); assert.equal(f.store.listTasks().length, 0)
  assert.ok(f.sections.some(section => section.text.includes('没有创建、补充、唤醒、取消、完成')))
})

test('mixed source units keep business topic pending while fixed units finish', async t => {
  const f = await fixture(t, { decide: async ({ tools, exec }) => tools.get('platform_reply_submit').execute({ text: '本群列表暂无记录。' }, exec) })
  await f.route('查任务；买咖啡；修复UPR', [unit('platform', '查任务；', 'agent-platform'), unit('outside', '买咖啡；', 'out-of-scope'),
    { unitKey: 'business', summary: '修复UPR', sourceRefs: [{ quote: '修复UPR' }], topics: [{ newTopicKey: 'upr', title: 'UPR修复' }] }])
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.deepEqual(f.errors, []); assert.equal(f.replies.length, 1)
  const group = f.store.getGroup('g')
  assert.equal(group.topics.length, 1); assert.equal(group.topics[0].title, 'UPR修复'); assert.equal(group.topics[0].processedRevision, 0)
  assert.equal(group.messages[0].agentDeliveryStatus, 'pending')
  assert.equal(group.messages[0].units.filter(unit => unit.fixedTopicHandledAt).length, 2)
})

test('frozen outbox survives restart gap without starting another platform session', async t => {
  const f = await fixture(t)
  await f.route('昨天完成列表', [unit('platform', '昨天完成列表', 'agent-platform')])
  const message = f.store.getGroup('g').messages[0], source = message.units[0]
  const id = fixedUnitRequestId('g', message, source)
  await f.store.appendOutbox({ groupId: 'g', outboundId: id, sourceMessageId: id, text: '原冻结答复', topicRefs: [], replyToMessageId: 'm', replyToSenderOpenDingTalkId: 'actor' })
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.deepEqual(f.errors, []); assert.equal(f.created.length, 0); assert.equal(f.replies[0].text, '原冻结答复'); assert.equal(f.store.getGroup('g').outbox.length, 1)
})

test('local yesterday crosses UTC midnight and DST safely', () => {
  const tasks = [
    { taskId: 'a', groupId: 'g', state: 'completed', completedAt: '2026-10-27T16:00:00Z' },
    { taskId: 'b', groupId: 'g', state: 'completed', completedAt: '2026-10-28T15:59:59Z' },
    { taskId: 'c', groupId: 'g', state: 'completed', completedAt: '2026-10-28T16:00:00Z' },
  ]
  const page = platformTaskPage(tasks, { state: 'completed', day: 'yesterday' }, { groupId: 'g', timezone: 'Asia/Shanghai', now: Date.parse('2026-10-28T16:01:00Z') })
  assert.deepEqual(page.items.map(task => task.taskId), ['a', 'b']); assert.equal(page.range.localDate, '2026-10-28')
  const dst = platformTaskPage([{ taskId: 'dst', groupId: 'g', state: 'completed', completedAt: '2026-11-02T04:59:00Z' }], { day: 'yesterday' }, { groupId: 'g', timezone: 'America/New_York', now: Date.parse('2026-11-02T06:00:00Z') })
  assert.equal(dst.total, 1); assert.equal(dst.range.localDate, '2026-11-01')
})

test('fixed route values are stable and cannot also claim business effects', () => {
  assert.deepEqual(FIXED_TOPICS.map(topic => topic.title), ['职责外话题', '职责内Agent平台相关'])
  assert.throws(() => topicRouteSubmissionSchema.parse({ requestId: 'r', routes: [{ messageId: 'm', messageVersion: 1, units: [{ ...unit('bad', 'x', 'agent-platform'), topics: [{ newTopicKey: 'bad', title: 'bad' }] }] }] }))
})

for (const scenario of ['found', 'absent', 'cursor-stalled']) test('native mention lookup matches exact group/message and paginates: ' + scenario, async () => {
  let calls = 0
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async args => {
    calls++; assert.ok(args.includes('list-mentions')); assert.ok(args.includes('g'))
    return { exitCode: 0, stdout: JSON.stringify({ success: true, result: { items: calls === 1 ? [{ msgId: 'm', openConversationId: 'other' }] : scenario === 'found' ? [{ msgId: 'm', openConversationId: 'g' }] : [], hasMore: calls === 1 || scenario === 'cursor-stalled', nextCursor: 'next' } }) }
  } } })
  const pending = adapter.isMessageMentioned('g', 'm', '2026-10-28T00:00:00Z')
  if (scenario === 'cursor-stalled') await assert.rejects(pending, /cursor_stalled/)
  else assert.equal(await pending, scenario === 'found')
  assert.equal(calls, 2)
})

test('native mention metadata survives event/history normalization without text inference', () => {
  const event = normalizeHistoryMessage({ conversationId: 'g', messageId: 'm', text: '@助理', isInAtList: false })
  assert.equal(event.mentionedAgent, false)
  assert.equal(normalizeHistoryMessage({ conversationId: 'g', messageId: 'm', isInAtList: true }).mentionedAgent, true)
})

test('native mention lookup reads grouped DWS messages across pages with exact source identity', async () => {
  const cursors = []
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async args => {
    const cursor = args[args.indexOf('--cursor') + 1]; cursors.push(cursor)
    return { exitCode: 0, stdout: JSON.stringify({ success: true, result: { conversationMessagesList: cursor === '0'
      ? [{ openConversationId: 'other', messages: [{ openMessageId: 'm' }] }, { openConversationId: 'g', messages: [{ messageId: 'other' }] }]
      : [{ openConversationId: 'g', messages: [{ openMessageId: 'm', messageId: 'm', conversationId: 'g' }] }], hasMore: cursor === '0', nextCursor: 'next' } }) }
  } } })
  assert.equal(await adapter.isMessageMentioned('g', 'm', '2026-10-28T00:00:00Z'), true)
  assert.deepEqual(cursors, ['0', 'next'])
})

test('documented empty terminal mention page settles a fixed unit silently, without replay or a task', async t => {
  let calls = 0
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => {
    calls++
    return { exitCode: 0, stdout: JSON.stringify({ success: true, error: null, decryptCandidateCount: 0, decryptAllowedCount: 0,
      decryptedCount: 0, decryptFailedCount: 0, result: { hasMore: false, nextCursor: 'terminal-cursor' } }) }
  } } })
  const f = await fixture(t, { readMentioned: (groupId, message) => adapter.isMessageMentioned(groupId, message.messageId, message.occurredAt) })
  await f.route('天气', [unit('outside', '天气', 'out-of-scope')])
  f.handler.schedule('g'); await f.handler.whenIdle()
  f.handler.schedule('g'); await f.handler.whenIdle()
  assert.equal(calls, 1); assert.equal(f.errors.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.created.length, 0)
  assert.equal((await f.store.listFixedTopicMessagesPage({ topicId: 'out-of-scope', groupId: 'g' })).items[0].state, 'silent')
})

test('mention lookup rejects failed, malformed, undecrypted and incomplete pages instead of treating them as empty', async () => {
  const empty = { conversationMessagesList: [], hasMore: false }
  const matched = { conversationMessagesList: [{ openConversationId: 'g', messages: [{ openMessageId: 'm' }] }], hasMore: false }
  const invalid = [null, { success: false, result: empty }, { success: true, error: { reason: 'failed' }, result: empty },
    { success: true, result: { hasMore: true, nextCursor: 'next' } }, { success: true, result: { conversationMessagesList: [] } },
    { success: true, result: { conversationMessagesList: null, hasMore: false } }, { result: { hasMore: false } },
    { success: true, result: { conversationMessagesList: [{ openConversationId: 'g' }], hasMore: false } },
    { success: true, partial: true, result: matched }, { success: true, decryptFailedCount: 1, result: matched },
    { success: true, decryptFailures: [{ reason: 'decrypt_failed' }], result: empty },
    { success: true, result: { ...empty, failedCount: 1 } }]
  for (const value of invalid) {
    const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(value) }) } })
    await assert.rejects(adapter.isMessageMentioned('g', 'm', '2026-10-28T00:00:00Z'), /dws_mentions_read_incomplete/, JSON.stringify(value))
  }
  const adapter = createDwsAdapter({ enabled: true, runner: { run: async () => ({ exitCode: 0, stdout: JSON.stringify({ success: true, result: { ...empty, hasMore: true } }) }) } })
  await assert.rejects(adapter.isMessageMentioned('g', 'm', '2026-10-28T00:00:00Z'), /dws_mentions_cursor_missing/)
})

test('user timezone-only settings update persists and group timezone takes priority', async t => {
  const { setup } = await import('./fixtures/runtime-mixed.js')
  const h = await setup(t)
  const saved = await h.runtime.updateAgentConfig({ timezone: 'America/New_York' })
  assert.equal(saved.timezone, 'America/New_York')
  assert.equal(h.runtime.getAgentConfig().timezone, 'America/New_York')
  assert.equal(h.store.getTimezone(), 'America/New_York')
  await assert.rejects(h.runtime.updateAgentConfig({ timezone: 'not-a-zone' }), RangeError)
  await h.store.updateGroup({ groupId: 'g', timezone: 'Asia/Shanghai' })
  assert.equal(h.store.getGroup('g').timezone, 'Asia/Shanghai')
})
