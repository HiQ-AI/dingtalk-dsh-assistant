import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { platformTaskPage } from '../packages/dingtalk-dsh-assistant/fixed-topics.js'
import { groupNotificationRouting, finalNotificationRouting, prepareGroupNotification } from '../packages/dingtalk-dsh-assistant/group-notification.js'
import { COORDINATION_RETIRED_REASON } from '../packages/dingtalk-dsh-assistant/coordination-retirement.js'
import { assertCoordinationHandoffProof, freezeCoordinationSourceOrder, selectCoordinationInstructions } from '../packages/dingtalk-dsh-assistant/coordination-changes.js'

// Source revision/transaction guarantees now run through Route -> Topic -> Task
// Owner. Retired ordinal/DAG/barrier/reminder-edit algorithms remain audit data;
// they are not simulated as if still executable.
function facility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'current-source-changes' })
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'source-changes-')), snapshot = { tables: {}, global: null }
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'changes', initialize: true }
  let store = await openDynamicTaskStore(options), resident = await openResidentStore(facility(snapshot)), tasks = []
  const refresh = async () => {
    tasks = (await store.query({ kind: 'task.list' })).map(task => ({ ...task, inputVersion: task.requirementRevision,
      state: task.status === 'completed' ? 'completed' : task.control === 'cancelled' ? 'cancelled' : task.control === 'paused' || task.drained ? 'waiting' : 'running',
      completedAt: task.completion?.at ?? null }))
    resident.setTaskSessionReader({ getTask: id => tasks.find(task => task.taskId === id), listTasks: () => tasks })
  }
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const command = async (kind, args, id = randomUUID()) => { const result = await store.command({ kind, args, id }); await refresh(); return result }
  await resident.subscribe({ groupId: 'group' }); await resident.subscribe({ groupId: 'other' })
  for (const taskId of ['A','B']) await command('task.create', { taskId, groupId: 'group', ownerActorId: 'author', title: taskId, request: 'Original ' + taskId })
  const message = (id, text, extra = {}) => resident.ingest({ groupId: 'group', messageId: id, text, messageVersion: 1,
    occurredAt: '2026-10-21T00:00:00Z', senderName: 'Author', senderOpenDingTalkId: 'author', ...extra })
  const route = (id, target = { newTopicKey: id, title: 'Matter ' + id }, extra = {}) => {
    const current = resident.getGroup('group').messages.find(item => item.messageId === id)
    return resident.routeMessages({ groupId: 'group', routeId: randomUUID(), routingRevision: resident.getGroup('group').routingRevision,
      routes: [{ messageId: id, messageVersion: current.messageVersion, topics: [typeof target === 'string' ? { topicId: target } : target], ...extra }] })
  }
  const topic = async (id, text = id) => { await message(id, text); return (await route(id)).topicIdsByKey[id] }
  const candidate = (topicId, decisionId, extra = {}) => ({ groupId: 'group', topicId, revision: resident.getTopic('group', topicId).revision,
    decisionId, decision: { actions: [], reason: 'Current context checked' }, ...extra })
  const durable = () => {
    const db = new DatabaseSync(options.dbPath, { readOnly: true })
    try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({
      name, rows: db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all() })) } finally { db.close() }
  }
  t.after(async () => { await resident.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { snapshot, options, query, command, refresh, message, route, topic, candidate, durable,
    get resident() { return resident }, get tasks() { return tasks },
    async restart() { await resident.close(); await store.close(); store = await openDynamicTaskStore(options); resident = await openResidentStore(facility(snapshot)); await refresh() },
    async seedHistory(rows) {
      await store.close(); const db = new DatabaseSync(options.dbPath)
      try {
        db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
        for (const [table, records] of Object.entries(rows)) for (const row of records)
          db.prepare('INSERT INTO dynamic_' + table + '(id,body) VALUES (?,?)').run(row.id, JSON.stringify(row))
      } finally { db.close() }
      store = await openDynamicTaskStore(options); await refresh()
    } }
}

test('quoted follow-up keeps complete original and quote independently across duplicate ingestion and restart', async t => {
  const f = await fixture(t), text = 'Move the reminder earlier; keep the same audience.\nAlso retain the delivery link.'
  await f.message('follow-up', text, { quotedMessage: { messageId: 'delivered', content: 'Earlier notice', senderName: 'Recipient' } })
  const id = (await f.route('follow-up')).topicIdsByKey['follow-up'], first = f.resident.getTopicContext({ groupId: 'group', topicId: id })
  await f.message('follow-up', text); await f.restart()
  const context = f.resident.getTopicContext({ groupId: 'group', topicId: id })
  assert.deepEqual(context, first); assert.equal(context.messages[0].text, text)
  assert.equal(context.messages[0].quotedMessage.content, 'Earlier notice')
  assert.deepEqual(await f.query('execution.list'), []); assert.deepEqual(await f.query('notification.list'), [])
  assert.deepEqual(f.resident.listSourceDispatchOwnership('group'), [])
})
test('quote replacement never carries another quoted message author or text into current context', async t => {
  const f = await fixture(t)
  await f.message('reply', 'Follow up', { quotedMessage: { messageId: 'old', content: 'Old body', senderName: 'Old author' } })
  await f.message('reply', 'Follow up', { quotedMessage: { messageId: 'new', content: '' } })
  const current = f.resident.getGroup('group').messages[0]
  assert.equal(current.quotedMessage.messageId, 'new'); assert.equal(current.quotedMessage.content, '')
  assert.equal(current.quotedMessage.senderName, undefined)
})
for (const variant of ['different author','without quote','attachment','several pending inputs'])
test('ordinary Topic routing remains available without automatic coordinator takeover: ' + variant, async t => {
  const f = await fixture(t), extra = variant === 'different author' ? { senderOpenDingTalkId: 'reviewer' }
    : variant === 'attachment' ? { imageRefs: [{ id: 'proof', mediaType: 'image/png' }] } : {}
  await f.message('follow-up', 'Current business change', extra)
  if (variant === 'several pending inputs') await f.message('another', 'Separate discussion')
  const id = (await f.route('follow-up')).topicIdsByKey['follow-up']
  const context = f.resident.getTopicContext({ groupId: 'group', topicId: id })
  assert.equal(context.messages[0].text, 'Current business change')
  assert.deepEqual(f.resident.listSourceDispatchOwnership('group'), [])
  if (variant === 'attachment') assert.equal(context.messages[0].imageRefs[0].id, 'proof')
  if (variant === 'different author') assert.equal(context.messages[0].senderOpenDingTalkId, 'reviewer')
  assert.deepEqual(await f.query('notification.list'), []); assert.deepEqual(await f.query('execution.list'), [])
})
for (const race of ['source edit','new input','attachment enrichment'])
test('stale Topic decision cannot consume evidence after ' + race, async t => {
  const f = await fixture(t), topicId = await f.topic('original'), input = f.candidate(topicId, 'before-race')
  if (race === 'source edit') await f.message('original', 'Corrected requirement', { messageVersion: 2 })
  else if (race === 'new input') await f.message('new-input', 'Additional requirement')
  else await f.message('original', 'original', { imageRefs: [{ id: 'new-image', mediaType: 'image/png' }] })
  const before = f.durable()
  assert.equal((await f.resident.acceptTopicDecision(input)).status, 'routing-required')
  assert.equal(f.resident.getTopic('group', topicId).decisions.length, 0); assert.deepEqual(f.durable(), before)
  await f.route(race === 'new input' ? 'new-input' : 'original', topicId)
  assert.equal((await f.resident.acceptTopicDecision(input)).status, 'topic-stale')
})
test('source enrichment retains old immutable evidence while new version remains separately reviewable', async t => {
  const f = await fixture(t), topicId = await f.topic('source', 'Original request')
  const before = f.resident.getTopicContext({ groupId: 'group', topicId, revision: 1 })
  await f.message('source', 'Revised request', { messageVersion: 2 }); await f.route('source', topicId); await f.restart()
  assert.deepEqual(f.resident.getTopicContext({ groupId: 'group', topicId, revision: 1 }).messages, before.messages)
  assert.equal(f.resident.getTopicContext({ groupId: 'group', topicId }).messages[0].text, 'Revised request')
})
test('repeated short phrase is rejected and distinct full source quotes preserve exact spans across restart', async t => {
  const f = await fixture(t), text = 'A review; A review'
  await f.message('multi', text)
  const unit = { unitKey: 'first', summary: 'First reference', sourceRefs: [{ quote: 'A review' }],
    topics: [{ newTopicKey: 'first', title: 'First matter' }], reason: 'Separate referenced item' }
  await assert.rejects(f.route('multi', {}, { units: [unit] }), error => error.issues.some(issue => issue.code === 'topic_unit_source_ambiguous'))
  assert.equal(f.resident.listTopics('group').length, 0)
  await f.route('multi', {}, { replyTopic: { newTopicKey: 'first' }, units: [
    { ...unit, sourceRefs: [{ quote: 'A review;' }] },
    { ...unit, unitKey: 'second', sourceRefs: [{ quote: ' A review' }], topics: [{ newTopicKey: 'second', title: 'Second matter' }] },
  ] })
  await f.restart()
  const units = f.resident.getGroup('group').messages[0].units
  assert.deepEqual(units.map(item => item.sourceRanges), [[{ start: 0, end: 9, quote: 'A review;' }], [{ start: 9, end: 18, quote: ' A review' }]])
  assert.deepEqual(await f.query('execution.list'), [])
})
for (const invalid of ['missing quote','duplicate whole-message reference','uncovered body'])
test('invalid current source coverage creates no Topic decision or business effect: ' + invalid, async t => {
  const f = await fixture(t); await f.message('source', 'Alpha; Beta')
  const sourceRefs = invalid === 'missing quote' ? [{ quote: 'Absent phrase' }]
    : invalid === 'duplicate whole-message reference' ? [{ wholeMessage: true },{ wholeMessage: true }] : [{ quote: 'Alpha' }]
  await assert.rejects(f.route('source', {}, { units: [{ unitKey: 'part', summary: 'Part', sourceRefs,
    topics: [{ newTopicKey: 'part', title: 'Part' }], reason: 'Candidate' }] }), error => error.issues.length > 0)
  assert.equal(f.resident.listTopics('group').length, 0)
  assert.deepEqual(await f.query('execution.list'), []); assert.deepEqual(await f.query('notification.list'), [])
})
const participants = [
  { messageId: 'request', senderOpenDingTalkId: 'requester' }, { messageId: 'review', senderOpenDingTalkId: 'reviewer' },
  { messageId: 'follow-up', senderOpenDingTalkId: 'later-author' }, { messageId: 'internal', senderOpenDingTalkId: 'internal-only', sourceKind: 'internal' },
]
test('current final delivery keeps explicit recipients independent from follow-up author and quoted provenance', () => {
  const routing = finalNotificationRouting(participants, { replyToMessageId: 'follow-up', atOpenDingTalkIds: ['requester','reviewer','requester'] })
  assert.deepEqual(routing.recipients, ['requester','reviewer']); assert.equal(routing.target.senderOpenDingTalkId, 'later-author')
  const reply = prepareGroupNotification({ groupId: 'group', text: '[Result](https://example.invalid/result)', atOpenDingTalkIds: routing.recipients, signature: 'Example assistant' })
  assert.deepEqual(reply.atOpenDingTalkIds, ['requester','reviewer']); assert.equal(reply.replyToMessageId, undefined)
  assert.match(reply.text, /\[Result\]\(https:\/\/example.invalid\/result\)/)
})
for (const [name, decision, error] of [
  ['unknown quote', { replyToMessageId: 'missing' }, 'group_reply_target_not_in_topic'],
  ['unknown identity', { atOpenDingTalkIds: ['unknown'] }, 'group_reply_recipient_not_in_topic'],
  ['internal identity', { atOpenDingTalkIds: ['internal-only'] }, 'group_reply_recipient_not_in_topic'],
  ['implicit unrelated quote author', { replyToMessageId: 'follow-up', atOpenDingTalkIds: ['requester'] }, 'group_reply_quote_author_not_in_recipients'],
  ['unspecified audience', {}, 'group_reply_routing_required'],
]) test('current notification context rejects ' + name + ' without guessing', () => {
  assert.throws(() => groupNotificationRouting(participants, decision), new RegExp(error))
})
for (const boundary of ['after decision accepted','after Task supplement applied'])
test('lost acknowledgement at ' + boundary + ' resumes original operation identity once after restart', async t => {
  const f = await fixture(t), topicId = await f.topic('change', 'Add acceptance evidence')
  const input = f.candidate(topicId, 'change-once', { expectedTaskVersions: [{ taskId: 'A', inputVersion: 1, runSequence: 1 }],
    decision: { basisMessageIds: ['change'], actions: [{ kind: 'task-context', taskId: 'A', context: 'Include acceptance evidence' }] } })
  const accepted = await f.resident.acceptTopicDecision(input), operation = accepted.record.operations[0]
  const args = { taskId: 'A', messageId: 'change', text: 'Include acceptance evidence', expectedRequirementRevision: 1,
    expectedControlRevision: 1, operationId: operation.operationId, topicRefs: [{ topicId, revision: 1 }] }
  if (boundary === 'after Task supplement applied') await f.command('task.supplement', args, operation.operationId)
  await f.restart()
  const repeated = await f.resident.acceptTopicDecision(input)
  assert.equal(repeated.status, 'duplicate'); assert.deepEqual(repeated.record.operations[0], operation)
  await f.command('task.supplement', args, operation.operationId)
  assert.equal((await f.command('task.supplement', args, operation.operationId)).replayed, true)
  await f.resident.updateTopicDecision({ groupId: 'group', topicId, decisionId: input.decisionId, patch: { operations: [{ ...operation, status: 'applied' }] } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId, decisionId: input.decisionId }); await f.restart()
  const task = await f.query('task.get', { taskId: 'A' })
  assert.equal(task.contextRevision, 1); assert.equal(task.requirementRevision, 1); assert.equal(task.supplements.length, 1)
  assert.deepEqual(task.appliedOperations, [operation.operationId])
  assert.equal((await f.query('wake.list', { taskId: 'A' })).filter(wake => wake.kind === 'task.supplement').length, 1)
  assert.deepEqual(await f.query('execution.list'), []); assert.deepEqual(await f.query('notification.list'), [])
})
test('accepted Topic operation cannot complete early or be rebound to a different action', async t => {
  const f = await fixture(t), topicId = await f.topic('change')
  const input = f.candidate(topicId, 'fixed-identity', { expectedTaskVersions: [{ taskId: 'A', inputVersion: 1 }],
    decision: { actions: [{ kind: 'task-context', taskId: 'A', context: 'Material' }] } })
  await f.resident.acceptTopicDecision(input)
  await assert.rejects(f.resident.completeTopicDecision({ groupId: 'group', topicId, decisionId: input.decisionId }), /topic_decision_operations_pending/)
  await assert.rejects(f.resident.acceptTopicDecision({ ...input, decision: { actions: [] } }), /topic_decision_identity_conflict/)
  assert.equal((await f.query('task.get', { taskId: 'A' })).contextRevision ?? 0, 0)
})
for (const change of ['missing task','other group','new requirement','new run'])
test('current Topic snapshot rejects target ' + change + ' before reserving or applying work', async t => {
  const f = await fixture(t), topicId = await f.topic('change')
  let taskId = 'A', runSequence = 1
  if (change === 'missing task') taskId = 'missing'
  if (change === 'other group') { taskId = 'foreign'; await f.command('task.create', { taskId, groupId: 'other', request: 'Other group' }) }
  if (change === 'new requirement') await f.command('task.revise', { taskId, expectedRequirementRevision: 1, request: 'Updated goal' })
  if (change === 'new run') runSequence = 99
  const before = f.durable(), input = f.candidate(topicId, 'stale', { expectedTaskVersions: [{ taskId, inputVersion: 1, runSequence }],
    decision: { actions: [{ kind: 'task-context', taskId, context: 'Stale material' }] } })
  assert.equal((await f.resident.acceptTopicDecision(input)).status, 'task-stale')
  assert.deepEqual(f.durable(), before); assert.deepEqual(f.resident.getGroup('group').taskReservations, [])
})
test('two Topics cannot concurrently own a shared Task change and stale revision cannot win after release', async t => {
  const f = await fixture(t), first = await f.topic('first'), second = await f.topic('second')
  const extra = { expectedTaskVersions: [{ taskId: 'A', inputVersion: 1 }] }
  assert.equal((await f.resident.acceptTopicDecision(f.candidate(first, 'one', extra))).status, 'accepted')
  assert.equal((await f.resident.acceptTopicDecision(f.candidate(second, 'two', extra))).status, 'task-busy')
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: first, decisionId: 'one' })
  await f.command('task.revise', { taskId: 'A', expectedRequirementRevision: 1, request: 'Explicit new goal' })
  assert.equal((await f.resident.acceptTopicDecision(f.candidate(second, 'two', extra))).status, 'task-stale')
})
for (const invalid of ['no task version','duplicate task action'])
test('current multi-action decision rejects ' + invalid + ' atomically', async t => {
  const f = await fixture(t), topicId = await f.topic('change'), action = { kind: 'task-context', taskId: 'A', context: 'Material' }
  const input = f.candidate(topicId, 'invalid', { expectedTaskVersions: invalid === 'no task version' ? [] : [{ taskId: 'A', inputVersion: 1 }],
    decision: { actions: invalid === 'no task version' ? [action] : [action, action] } })
  await assert.rejects(f.resident.acceptTopicDecision(input), new RegExp(invalid === 'no task version' ? 'topic_task_version_required' : 'topic_task_action_duplicate'))
  assert.equal(f.resident.getTopic('group', topicId).decisions.length, 0)
  assert.deepEqual(f.resident.getGroup('group').taskReservations, [])
})
test('supplement targets a stable task ID without changing other task or recreating its execution', async t => {
  const f = await fixture(t), beforeB = await f.query('task.get', { taskId: 'B' })
  const binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  const execution = (await f.command('execution.dispatch', { binding, key: 'work', prompt: 'Original execution' })).result.execution
  const args = { taskId: 'A', messageId: 'additional-material', text: 'New acceptance material', expectedRequirementRevision: 1, expectedControlRevision: 1 }
  await f.command('task.supplement', args); await f.command('task.supplement', args)
  const current = await f.query('execution.get', { executionId: execution.id })
  assert.equal(current.inputVersion, execution.inputVersion); assert.equal(current.feedback.length, 1)
  assert.deepEqual(await f.query('task.get', { taskId: 'B' }), beforeB)
  await assert.rejects(f.command('task.supplement', { ...args, text: 'Different material under the same identity' }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
})
for (const control of ['paused','cancelled'])
test('current Task ' + control + ' rejects stale material without changing its control or neighboring Task', async t => {
  const f = await fixture(t); await f.command('task.control', { taskId: 'A', control, expectedControlRevision: 1 })
  const before = await f.query('task.list')
  await assert.rejects(f.command('task.supplement', { taskId: 'A', messageId: 'late', text: 'Old material', expectedRequirementRevision: 1, expectedControlRevision: 1 }), { code: 'DYNAMIC_TASK_NOT_ACTIVE' })
  assert.deepEqual(await f.query('task.list'), before); assert.deepEqual(await f.query('execution.list'), [])
})
test('read-only current task catalog pages 205 matching Tasks without cross-group rows, wakes or mutation', async t => {
  const f = await fixture(t)
  for (let index = 0; index < 203; index++) await f.command('task.create', { taskId: 'current-' + index.toString().padStart(3, '0'), groupId: 'group', request: 'Current task ' + index })
  await f.command('task.create', { taskId: 'foreign', groupId: 'other', request: 'Other group private task' })
  const before = f.durable(), context = { groupId: 'group', timezone: 'Asia/Shanghai', now: Date.parse('2026-10-21T00:00:00Z') }
  const pages = [0,100,200].map(offset => platformTaskPage(f.tasks, { offset, limit: 100 }, context))
  assert.deepEqual(pages.map(page => page.items.length), [100,100,5]); assert.ok(pages.every(page => page.total === 205))
  assert.equal(new Set(pages.flatMap(page => page.items.map(task => task.taskId))).size, 205)
  assert.equal(pages.at(-1).hasMore, false); assert.equal(pages.at(-1).nextCall, null)
  assert.throws(() => platformTaskPage(f.tasks, { limit: 101 }, context), /platform_task_query_invalid/)
  assert.deepEqual(f.durable(), before); assert.deepEqual(await f.query('notification.list'), [])
})
test('current aggregate query uses actual Owner completion and local calendar day without inventing delivery or completion', async t => {
  const f = await fixture(t), binding = (await f.command('task.claim', { taskId: 'A' })).result.binding
  await f.command('task.complete', { binding, summary: 'Verified business result', result: { evidence: ['actual-proof'] } })
  const completed = await f.query('task.get', { taskId: 'A' }), before = f.durable()
  const page = platformTaskPage(f.tasks, { state: 'completed', day: 'today' }, { groupId: 'group', timezone: 'Asia/Shanghai', now: Date.parse(completed.completion.at) })
  assert.deepEqual(page.items.map(task => task.taskId), ['A'])
  assert.equal(page.items[0].completedAt, completed.completion.at); assert.deepEqual(f.durable(), before)
  assert.deepEqual(await f.query('notification.list'), [])
})
for (const allTogether of [false,true])
test('historical partial clarification and ordinal append survive upgrade without replaying retired allTogether=' + allTogether, async t => {
  const f = await fixture(t), before = await f.query('task.list'), original = 'A first; ask about B; appended C'
  const source = { id: 'old-source', groupId: 'group', unitId: 'old-unit', revision: 1, state: 'needs_clarification', dispatchOwner: 'coordination',
    original, coordinationId: 'old-batch', question: 'Which acceptance criterion applies to B?' }
  const sourceOrder = [{ ordinal: 1, start: 0, end: 7, quote: 'A first', instructionIds: ['a'] },
    { ordinal: 2, start: 9, end: 20, quote: 'ask about B', clarificationId: 'b-question' },
    { ordinal: 3, start: 22, end: 32, quote: 'appended C', instructionIds: ['c'], appendedBy: 'append-source' }]
  const batch = { id: 'old-batch', groupId: 'group', state: 'partially-accepted', revision: 3, allTogether, sourceOrder,
    memberIds: ['a','b','c'], pendingMembers: [{ clarificationId: 'b-question', original: 'ask about B' }], clarificationSourceIds: ['old-source','answer-source'] }
  const members = [
    { id: 'a', coordinationId: batch.id, taskId: 'A', state: 'applied', command: { id: 'old-a' }, receipt: { accepted: true } },
    { id: 'b', coordinationId: batch.id, taskId: 'B', state: 'waiting', dependencies: [{ instructionId: 'a', proof: 'recorded-proof' }] },
    { id: 'c', coordinationId: batch.id, taskId: 'A', state: 'paused', original: 'appended C' },
  ]
  await f.seedHistory({ coordination_sources: [source], coordination: [batch], coordination_members: members })
  let historical = await f.query('coordination.get', { coordinationId: batch.id })
  assert.deepEqual(historical.coordination.sourceOrder, sourceOrder); assert.deepEqual(historical.coordination.pendingMembers, batch.pendingMembers)
  assert.deepEqual(historical.members.map(member => member.state), ['applied','waiting','paused'])
  assert.ok(historical.members.every(member => member.eligible === false))
  assert.equal((await f.query('coordination.source.list'))[0].question, source.question)
  await f.restart(); assert.deepEqual(await f.query('coordination.get', { coordinationId: batch.id }), historical)
  assert.deepEqual(await f.query('task.list'), before); assert.deepEqual(await f.query('coordination.job.list'), [])
  assert.deepEqual(await f.query('notification.list'), []); assert.equal(await f.query('receipt.get', { id: 'old-a' }), null)
})
test('historical observed prerequisite and recurring child identity preserve recorded evidence without manufacturing current completion', async t => {
  const f = await fixture(t), before = await f.query('task.list')
  const observer = { id: 'observation', coordinationId: 'old', taskId: 'A', state: 'waiting', inputVersion: 1, runSequence: 1,
    observation: { policy: 'wait', controlRevision: 1, completion: { claimed: true } } }
  const child = { id: 'child', coordinationId: 'old', taskId: 'B', state: 'ready', periodic: { scheduleId: 'cycle', occurrenceId: 'tick' },
    dependencies: [{ instructionId: observer.id, expectedInputVersion: 1, completionProof: 'historical-only' }] }
  await f.seedHistory({ coordination: [{ id: 'old', groupId: 'group', state: 'active', revision: 2, memberIds: [observer.id,child.id] }],
    coordination_members: [observer,child], coordination_schedules: [{ id: 'cycle', coordinationId: 'old', state: 'active', cursor: 7, rule: { kind: 'interval', everyMs: 60000 } }] })
  const saved = await f.query('coordination.get', { coordinationId: 'old' })
  assert.deepEqual(saved.members[0].observation, observer.observation); assert.deepEqual(saved.members[1].periodic, child.periodic)
  assert.deepEqual(saved.members[1].dependencies, child.dependencies); assert.ok(saved.members.every(member => member.eligible === false))
  await f.restart(); assert.deepEqual(await f.query('task.list'), before)
  assert.deepEqual(await f.query('coordination.occurrence.list'), []); assert.deepEqual(await f.query('coordination.job.list'), [])
  assert.deepEqual((await f.query('task.events')).events, [])
})
for (const currentVersion of [1,2])
test('retirement settles exact historical source ownership without consuming a newer source version: ' + currentVersion, async t => {
  const f = await fixture(t); await f.topic('old-message', 'Old question'); await f.resident.close()
  const at = '2026-10-21T00:00:00Z', unit = { unitId: 'old-unit', unitRevision: currentVersion, unitKey: 'source', summary: 'Source unit', sourceRanges: [{ start: 0, end: 3, quote: currentVersion === 1 ? 'Old' : 'Rev' }], dispatchOwner: currentVersion === 1 ? 'coordination' : 'legacy-topic' }
  const group = f.snapshot.tables.groups.group
  group.messages = [{ messageId: 'old-message', messageVersion: currentVersion, text: currentVersion === 1 ? 'Old question' : 'Revised business requirement',
    occurredAt: at, sequence: 1, routingStatus: 'routed', agentDeliveryStatus: 'pending', units: [unit], activeUnitRefs: [{ unitId: unit.unitId, unitRevision: currentVersion }] }]
  group.topics[0].entries = group.topics[0].entries.map(entry => ({ ...entry, unitId: 'old-unit', unitRevision: currentVersion, messageVersion: currentVersion }))
  group.sourceDispatchOwnership = [{ reservationId: 'reservation', unitId: 'old-unit', unitRevision: 1, generation: 1, dispatchOwner: 'coordination',
    semanticState: 'needs_clarification', settled: false, clarification: 'Original question', sourceSnapshot: { messageId: 'old-message', messageVersion: 1 }, history: [], createdAt: at, updatedAt: at }]
  await f.restart()
  const retirement = { kind: 'feature-removed', reason: COORDINATION_RETIRED_REASON, at }
  await f.resident.retireIndependentCoordination(retirement)
  const settled = structuredClone(f.resident.getGroup('group'))
  await f.resident.retireIndependentCoordination(retirement); await f.restart()
  assert.deepEqual(f.resident.getGroup('group'), settled); assert.equal(settled.sourceDispatchOwnership[0].settled, true)
  assert.equal(settled.sourceDispatchOwnership[0].clarification, 'Original question')
  assert.equal(settled.messages[0].agentDeliveryStatus, currentVersion === 1 ? 'delivered' : 'pending')
  assert.deepEqual(await f.query('execution.list'), []); assert.deepEqual(await f.query('notification.list'), [])
})

// Unchanged pure compatibility checks for interpreting historical source proofs.
test('unknown effect evidence cannot satisfy the explicit handoff proof', () => {
  const reservation = { reservationId: 'r', generation: 1, unitId: 'u', unitRevision: 1 }
  const source = { id: 's', state: 'rejected', dispatchOwner: 'coordination', frozen: true, reservationGeneration: 1,
    handoffProof: { kind: 'coordination.no-commands', dynamicSourceId: 's', reservationId: 'r', generation: 1, unitId: 'u', unitRevision: 1,
      freezeId: 'freeze', commandCount: 0, unknownCount: 1, checkedAt: new Date().toISOString() } }
  assert.throws(() => assertCoordinationHandoffProof(reservation, source, 'freeze'), { code: 'COORDINATION_HANDOFF_UNSAFE' })
})

test('source slot contracts reject duplicate, overlapping and out-of-range indices and retain genuine multi-target ambiguity', () => {
  const source={id:'source',unitId:'unit',revision:1,original:'甲；乙'}
  const member={id:'A'},pending=[{clarificationId:'B'}]
  const entries=[{ordinal:1,start:0,end:1,quote:'甲',memberIndex:0},{ordinal:2,start:2,end:3,quote:'乙',clarificationId:'B'}]
  const build=value=>freezeCoordinationSourceOrder(value,source,[member],pending)
  assert.equal(build(entries)[0].coordinateSpace,'source-unit-original:utf16')
  for(const bad of [
    [{...entries[0],end:20,quote:'甲；乙'},entries[1]],
    [entries[0],{...entries[1],ordinal:1}],
    [entries[0],{...entries[1],start:0,end:1,quote:'甲'}],
    [entries[0],{...entries[1],memberIndex:0,clarificationId:undefined}],
  ])assert.throws(()=>build(bad),{code:'COORDINATION_SOURCE_ORDER_INVALID'})
  assert.throws(()=>selectCoordinationInstructions({coordination:{memberIds:['A','B'],sourceOrder:[{ordinal:1,instructionIds:['A','B']}]}},[{ordinal:1}]),
    {code:'COORDINATION_CHANGE_ORDINAL_NEEDS_CLARIFICATION'})
})
