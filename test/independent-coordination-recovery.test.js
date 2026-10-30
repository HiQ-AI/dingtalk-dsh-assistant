import test from 'node:test'
import assert from 'node:assert/strict'
import { currentCoordinationFixture as fixture } from './fixtures/current-coordination-contracts.js'
import { createPlatformSchedules } from '../packages/dingtalk-dsh-assistant/platform-schedule.js'
import { createPlatformNotifier } from '../packages/dingtalk-dsh-assistant/platform-notification.js'
import { fixedUnitRequestId, platformScheduleSessionId, platformTaskPage } from '../packages/dingtalk-dsh-assistant/fixed-topics.js'

// Adapter unit tests use a deterministic Schedule service double. Native rc2
// creation/delivery is covered separately by fixed-topics-native.test.js.
async function platform(t, { sourceTime = '2026-10-21T00:00:00Z', tasks = [] } = {}) {
  const f = await fixture(t), native = new Map(), persisted = new Set(), agents = [], listeners = new Map()
  let clock = Date.parse('2026-10-21T00:00:00Z'), creates = 0, bridge
  const text = '一小时后汇报本群结果'
  await f.resident.ingest({ groupId: 'group', messageId: 'platform-origin', text,
    senderOpenDingTalkId: 'author', occurredAt: sourceTime ?? '' })
  await f.resident.routeMessages({ groupId: 'group', routeId: 'platform-route',
    routingRevision: f.resident.getGroup('group').routingRevision,
    routes: [{ messageId: 'platform-origin', messageVersion: 1, units: [{
      unitKey: 'report', summary: '一次汇报', sourceRefs: [{ quote: text }], topics: [],
      fixedTopic: 'agent-platform', reason: '平台工作汇报',
    }] }] })
  const message = f.resident.getGroup('group').messages.find(item => item.messageId === 'platform-origin'), unit = message.units[0]
  const binding = { groupId: 'group', messageId: message.messageId, messageVersion: message.messageVersion,
    unitId: unit.unitId, unitRevision: unit.unitRevision, requestId: fixedUnitRequestId('group', message, unit), timezone: 'Asia/Shanghai' }
  const input = { title: '一次工作汇报', prompt: '汇报本群已核验成果', at: '2026-10-21T01:00:00Z' }
  const schedule = {
    catalog: async () => [...native.values()].map(value => structuredClone(value)),
    create: async (sessionId, args) => {
      creates++
      const record = { id: `native-${creates}`, sessionId, kind: 'at', status: 'active',
        scheduledAt: args.at, prompt: args.prompt, title: args.title }
      native.set(record.id, record)
      return structuredClone(record)
    },
  }
  const ctx = {
    on(event, handler) { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); return () => set.delete(handler) },
    get: name => name === 'schedule' ? schedule : name === 'sessionController' ? {} : undefined,
    sessionPersistence: { stat: async id => persisted.has(id) },
    sessionProjections: { stateOf: () => 'preset' },
    sessions: { flush: async session => { persisted.add(session.id); return true } },
    agents: {
      withoutInitiator: run => run(),
      async create(options) {
        const tools = new Map(), hooks = new Map(), sections = []
        const agentCtx = {
          get: name => name === 'agentPresets' ? { mount: async () => ({ id: 'preset' }) }
            : name === 'permissionPresets' ? { set(session, value) { agent.permission = value } } : undefined,
          tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
          on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event) },
          systemPrompt: { section(section) { sections.push(section); return () => {} } },
        }
        const agent = { ctx: agentCtx, session: { id: options.sessionId, append() {} }, cancel() {}, whenIdle: async () => {} }
        const handle = { agent, tools, hooks, sections, async dispose() {} }
        agents.push(handle)
        await options.setup(agentCtx, agent)
        for (const fn of listeners.get('agent/created') ?? []) await fn({ agent })
        return handle
      },
    },
  }
  const open = () => bridge = createPlatformSchedules({ ctx, store: f.resident, root: f.root, now: () => clock,
    legacy: { getAgentConfig: () => ({ agentPreset: 'preset' }) }, readTasks: async group => { assert.equal(group, 'group'); return tasks },
    appendOutbox: async args => { await args.preflight?.(); return f.resident.appendOutbox(args) } })
  open()
  t.after(() => bridge.close())
  return { ...f, native, agents, binding, input, message, unit, ctx,
    get creates() { return creates }, get bridge() { return bridge },
    get sessionId() { return platformScheduleSessionId(binding.requestId) },
    setNow: value => { clock = value },
    async restart() { await bridge.close(); await f.reopen(); open() },
    tool(name, args) { const latest = agents.at(-1); return latest.tools.get(name).execute(args, { agent: latest.agent }) },
  }
}

for (const field of ['group', 'task', 'source', 'event']) test(`current public Topic reply rejects internal ${field} identity before notification acceptance`, async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding)
  const context = await f.context()
  const value = { group: 'group', task: 'A', source: 'source', event: context.eventIds[0] }[field]
  const request = f.submission(context, { reply: `内部编号：${value}`, atOpenDingTalkIds: ['author'] })
  await assert.rejects(f.submit(request), { code: 'GROUP_REPLY_INTERNAL_DETAILS' })
  assert.deepEqual(await f.query('notification.list'), [])
  assert.ok(await f.context(), '拒绝正文不能提前消费事实')
  await f.submit(f.submission(await f.context(), { reply: '核验完成，请查看验收说明。', atOpenDingTalkIds: ['author'] }))
  assert.equal((await f.query('notification.list')).length, 1)
})

test('current source context keeps exact author and full quote available after a bounded catalogue read', async t => {
  const f = await fixture(t), quote = { messageId: 'quoted', content: '验收说明 https://example.org/pull/123\n' + 'evidence '.repeat(300) }
  await f.command('source.record', { sourceId: 'quoted-source', groupId: 'group', messageId: 'quoted-message', version: 1,
    actorId: 'original-author', channel: 'im', text: '继续核验', quote })
  const sources = await f.query('topic.fact.sources', { sourceIds: ['quoted-source'] })
  assert.equal(sources[0].actorId, 'original-author')
  const full = await f.query('source.get', { sourceId: 'quoted-source' })
  assert.deepEqual(full.quote, quote)
  await f.reopen()
  assert.deepEqual((await f.query('source.get', { sourceId: 'quoted-source' })).quote, quote)
})

test('missing quote stays missing and a later source version cannot fill it from unrelated context', async t => {
  const f = await fixture(t)
  await f.command('source.record', { sourceId: 'v1', groupId: 'group', messageId: 'same', version: 1, actorId: 'author', text: '继续', quote: null })
  await f.command('source.record', { sourceId: 'v2', groupId: 'group', messageId: 'same', version: 2, actorId: 'author', text: '继续', quote: { messageId: 'different', content: '新证据' } })
  await f.reopen()
  assert.equal((await f.query('source.get', { sourceId: 'v1' })).quote, null)
  assert.equal((await f.query('source.get', { sourceId: 'v2' })).quote.content, '新证据')
})

test('recovery retains already frozen Topic text even when a later template would produce different wording', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.finish(binding)
  await f.submit(f.submission(await f.context(), { reply: '原冻结说明 [验收](https://example.org/acceptance)', atOpenDingTalkIds: ['author'] }, 'frozen'))
  const [notice] = await f.query('notification.list')
  await f.command('task.drained', { binding }); await f.reopen(); await f.handler.recover()
  assert.deepEqual(await f.query('notification.get', { notificationId: notice.id }), notice)
  assert.equal(f.resident.getGroup('group').outbox[0].text, notice.payload.text)
  assert.equal((await f.query('notification.list')).length, 1)
})

test('platform query applies the working timezone without fabricating missing completion timestamps', () => {
  const tasks = [{ taskId: 'A', groupId: 'group', state: 'completed', title: 'A' },
    { taskId: 'B', groupId: 'group', state: 'completed', completedAt: '2026-10-20T16:30:00Z' }]
  const all = platformTaskPage(tasks, {}, { groupId: 'group', timezone: 'Asia/Shanghai', now: Date.parse('2026-10-21T00:00:00Z') })
  assert.equal(all.items.find(item => item.taskId === 'A').completedAt, null)
  const today = platformTaskPage(tasks, { day: 'today' }, { groupId: 'group', timezone: 'Asia/Shanghai', now: Date.parse('2026-10-21T00:00:00Z') })
  assert.deepEqual(today.items.map(item => item.taskId), ['B']); assert.equal(today.range.localDate, '2026-10-21')
})

for (const state of ['prepared', 'starting', 'unknown', 'delivered']) test(`accepted one-shot time is immutable and cannot rewrite existing ${state} delivery evidence`, async t => {
  const f = await platform(t)
  const accepted = await f.bridge.submit(f.binding, f.input)
  await f.historical([['notifications', 'previous-notice', { kind: 'coordination', state,
    ...(state === 'prepared' ? {} : { sendPermit: { notificationId: 'previous-notice' }, dispatchToken: 'old-token' }),
    payload: { text: '旧通知正文', conversationId: 'group', fact: { coordinationId: 'history', eventId: state } } }]])
  const notice = await f.query('notification.get', { notificationId: 'previous-notice' })
  await assert.rejects(f.bridge.submit(f.binding, { ...f.input, at: '2026-10-21T02:00:00Z' }), /platform_schedule_identity_conflict/)
  assert.equal(f.creates, 1); assert.equal(f.resident.getPlatformSchedule(f.sessionId).scheduleId, accepted.scheduleId)
  assert.deepEqual(await f.query('notification.get', { notificationId: 'previous-notice' }), notice)
  assert.deepEqual(await f.query('task.list'), [])
})

for (const nativeState of ['active', 'inactive', 'deleted', 'completed']) test(`schedule recovery preserves accepted ${nativeState} identity and never creates a replacement`, async t => {
  const f = await platform(t)
  const first = await f.bridge.submit(f.binding, f.input)
  if (nativeState === 'deleted') f.native.delete(first.scheduleId)
  else if (nativeState === 'completed') await f.resident.updatePlatformSchedule(f.sessionId, { outcome: 'replied', completedAt: '2026-10-21T01:00:01Z' })
  else f.native.get(first.scheduleId).status = nativeState
  await f.restart()
  const result = await f.bridge.submit(f.binding, f.input)
  assert.equal(f.creates, 1); assert.equal(result.scheduleId, first.scheduleId)
  assert.deepEqual(await f.query('task.list'), [])
  if (nativeState === 'deleted') assert.equal(result.status, 'cancelled')
  if (nativeState === 'inactive') assert.equal(result.status, 'triggered')
})

for (const field of ['taskIds', 'members', 'conditionalMembers']) test(`platform reply rejects business-effect field ${field} before any outbox write`, async t => {
  const f = await platform(t), notify = createPlatformNotifier({ store: f.resident, root: f.root, appendOutbox: args => f.resident.appendOutbox(args) })
  await assert.rejects(notify({ groupId: 'group', outboundId: 'invalid-business-effect', message: f.message, unit: f.unit, sessionId: 'platform',
    decision: { text: '一次提醒', atOpenDingTalkIds: ['author'], [field]: ['A'] } }))
  assert.equal(f.resident.getGroup('group').outbox.length, 0)
  assert.deepEqual(await f.query('task.list'), [])
})

for (const [name, patch, error] of [
  ['missing-offset', { at: '2026-10-21T01:00:00' }, /time_requires_offset/],
  ['invalid-date', { at: '2026-02-30T01:00:00Z' }, /time_invalid/],
  ['empty-title', { title: '' }, /schedule_invalid/],
  ['empty-prompt', { prompt: ' ' }, /schedule_invalid/],
]) test(`invalid platform schedule ${name} creates no session, binding or native record`, async t => {
  const f = await platform(t)
  await assert.rejects(f.bridge.submit(f.binding, { ...f.input, ...patch }), error)
  assert.equal(f.creates, 0); assert.equal(f.agents.length, 0)
  assert.equal(f.resident.getPlatformSchedule(f.sessionId), undefined)
})

test('scheduled query requires all requested pages before accepting a result and never reads another group', async t => {
  const tasks = Array.from({ length: 3 }, (_, n) => ({ taskId: `A${n}`, title: `工作${n}`, state: 'completed', groupId: 'group' }))
  tasks.push({ taskId: 'private-other-group', groupId: 'other', state: 'completed' })
  const f = await platform(t, { tasks })
  await f.bridge.submit(f.binding, f.input); f.setNow(Date.parse(f.input.at))
  const page = await f.tool('platform_task_query', { limit: 1 })
  assert.equal(page.total, 3)
  await assert.rejects(f.tool('platform_reply_submit', { text: '所有工作已核验', atOpenDingTalkIds: ['author'] }), /pages_unread/)
  assert.equal(f.resident.getGroup('group').outbox.length, 0)
  for (let offset = 1; offset < 3; offset++) await f.tool('platform_task_query', { offset, limit: 1 })
  const delivered = await f.tool('platform_reply_submit', { text: '三项工作已核验', atOpenDingTalkIds: ['author'] })
  assert.equal(delivered.status, 'accepted'); assert.equal(f.resident.getGroup('group').outbox.length, 1)
  assert.equal(f.resident.getPlatformSchedule(f.sessionId).outcome, 'replied')
})

for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { state: 'other' }, { day: 'not-a-day' }, { day: '2026-02-30' }])
test(`current query context rejects invalid bounds before reading work: ${JSON.stringify(args)}`, () => {
  assert.throws(() => platformTaskPage([], args, { groupId: 'group', timezone: 'Asia/Shanghai', now: Date.parse('2026-10-21T00:00:00Z') }), /platform_task_/)
})

for (const delay of [17_000, 900_001]) test(`late processing ${delay}ms keeps the original instant and never rolls a past report into tomorrow`, async t => {
  const f = await platform(t), due = '2026-10-21T00:03:00Z'
  f.setNow(Date.parse('2026-10-21T00:00:00Z') + delay)
  const result = await f.bridge.submit(f.binding, { ...f.input, at: due })
  if (delay < 180_000) {
    assert.equal(result.status, 'scheduled'); assert.equal([...f.native.values()][0].scheduledAt, due.replace('00Z', '00.000Z'))
  } else {
    assert.equal(result.status, 'expired'); assert.equal(f.creates, 0)
    assert.equal(f.resident.getPlatformSchedule(f.sessionId), undefined)
  }
  assert.equal(f.resident.getGroup('group').messages.find(item => item.messageId === 'platform-origin').occurredAt, '2026-10-21T00:00:00Z')
})

test('a source without a timestamp is rejected at admission rather than inventing timing evidence', async t => {
  const f = await fixture(t), before = f.resident.getGroup('group')
  await assert.rejects(f.resident.ingest({ groupId: 'group', messageId: 'missing-time', text: '过去时间的提醒',
    senderOpenDingTalkId: 'author' }), error => error.issues?.some(issue => issue.path.includes('occurredAt')))
  assert.deepEqual(f.resident.getGroup('group'), before)
  assert.deepEqual(await f.query('task.list'), [])
})

test('failed native creation retains the accepted binding for one exact retry without creating business work', async t => {
  const f = await platform(t), schedule = f.ctx.get('schedule'), create = schedule.create
  let attempts = 0
  schedule.create = async (...args) => { if (++attempts === 1) throw new Error('temporary native create failure'); return create(...args) }
  await assert.rejects(f.bridge.submit(f.binding, f.input), /temporary native/)
  assert.ok(f.resident.getPlatformSchedule(f.sessionId)); assert.equal(f.creates, 0)
  await f.restart()
  const result = await f.bridge.submit(f.binding, f.input)
  assert.equal(result.status, 'scheduled'); assert.equal(f.creates, 1); assert.equal(f.agents.length, 1)
  assert.deepEqual(await f.query('task.list'), [])
})

test('native create committed before its local acknowledgement is recovered without a second native record', async t => {
  const f = await platform(t), update = f.resident.updatePlatformSchedule
  let lost = false
  f.resident.updatePlatformSchedule = async (id, patch) => {
    if (patch.scheduleId && !lost) { lost = true; throw new Error('lost local acknowledgement') }
    return update(id, patch)
  }
  await assert.rejects(f.bridge.submit(f.binding, f.input), /lost local acknowledgement/)
  assert.equal(f.creates, 1); assert.equal(f.resident.getPlatformSchedule(f.sessionId).scheduleId, undefined)
  f.resident.updatePlatformSchedule = update
  await f.restart()
  const recovered = await f.bridge.submit(f.binding, f.input)
  assert.equal(f.creates, 1); assert.equal(recovered.scheduleId, [...f.native.keys()][0])
  assert.equal(f.resident.getPlatformSchedule(f.sessionId).scheduleId, recovered.scheduleId)
})

test('duplicate platform admission freezes one native record and original request identity', async t => {
  const f = await platform(t)
  const [first, duplicate] = await Promise.all([f.bridge.submit(f.binding, f.input), f.bridge.submit(f.binding, f.input)])
  assert.equal(first.scheduleId, duplicate.scheduleId); assert.equal(f.creates, 1)
  assert.equal(f.resident.getPlatformSchedule(f.sessionId).messageId, f.binding.messageId)
  assert.equal(f.resident.getPlatformSchedule(f.sessionId).unitId, f.binding.unitId)
  assert.equal(f.agents[0].agent.permission, 'danger-full-access')
})

test('lost Task supplement acknowledgement recovers its receipt without creating another input or wake', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'A', groupId: 'group', request: 'A' })
  const args = { taskId: 'A', messageId: 'extra', text: '补充验收说明', expectedRequirementRevision: 1, expectedControlRevision: 1 }
  await f.command('task.supplement', args, 'committed-input')
  const before = await f.query('task.get', { taskId: 'A' }), wakes = await f.query('wake.list')
  await f.reopen()
  assert.equal((await f.command('task.supplement', args, 'committed-input')).replayed, true)
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), before); assert.deepEqual(await f.query('wake.list'), wakes)
})

test('Owner provider failure backoff survives restart instead of reactivating the retired planner budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') })
  const f = await fixture(t)
  let binding = await f.create()
  for (const delay of [5000, 10000, 20000]) {
    await f.command('task.provider-failure', { binding, failure: { code: 'TRANSIENT' } })
    await f.command('task.drained', { binding }); await f.reopen()
    await assert.rejects(f.command('task.claim', { taskId: 'A' }), { code: 'DYNAMIC_TASK_PROVIDER_RETRY_NOT_DUE' })
    t.mock.timers.tick(delay + 1)
    binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  }
  assert.equal((await f.query('task.get', { taskId: 'A' })).providerRecovery.attempts, 3)
  assert.deepEqual(await f.query('coordination.source.list'), [])
})

test('stale source version cannot create a native schedule or deliver a later reply', async t => {
  const f = await platform(t)
  await f.bridge.submit(f.binding, f.input)
  await f.resident.ingest({ groupId: 'group', messageId: 'platform-origin', messageVersion: 2,
    text: '更新的时间要求', senderOpenDingTalkId: 'author', occurredAt: '2026-10-21T00:00:00Z' })
  await assert.rejects(f.bridge.submit(f.binding, f.input), /source_stale/)
  await assert.rejects(f.tool('platform_reply_submit', { text: '旧结果', atOpenDingTalkIds: ['author'] }), /source_stale/)
  assert.equal(f.creates, 1); assert.equal(f.resident.getGroup('group').outbox.length, 0)
  assert.deepEqual(await f.query('task.list'), [])
})

test('Owner clarification recovery keeps one pending fact and original question without a duplicate send', async t => {
  const f = await fixture(t), binding = await f.create()
  await f.command('task.wait', { binding, action: 'blocked', summary: '缺验收条件', question: '请明确验收环境',
    humanRequest: { requestId: 'question', audience: 'requester', reason: '需要环境', attemptedActions: [] }, topicFacts: true }, 'question-fact')
  await f.command('task.drained', { binding })
  await f.reopen(); await f.handler.recover(); await f.handler.recover()
  const pending = await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId })
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'needs-input')
  assert.equal((await f.query('task.get', { taskId: 'A' })).humanRequests[0].question, '请明确验收环境')
  assert.deepEqual(await f.query('notification.list'), [])
  await f.submit(f.submission(await f.context(), { reply: '请明确验收环境', atOpenDingTalkIds: ['author'] }))
  await f.handler.recover(); assert.equal((await f.query('notification.list')).length, 1)
})
