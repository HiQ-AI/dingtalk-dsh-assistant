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

async function fixture(t, { tasks = [], decide = async () => {}, timezone = 'Asia/Shanghai', readMentioned } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fixed-topic-'))
  const snapshot = { tables: {}, global: null }
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
