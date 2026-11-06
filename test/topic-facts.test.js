import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Session } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { createTopicFactHandler } from '../packages/dingtalk-dsh-assistant/topic-facts.js'
import { createTopicCoordinator } from '../packages/dingtalk-dsh-assistant/topic-runtime.js'
import { replyTopicForMessage } from '../packages/dingtalk-dsh-assistant/topic-model.js'
import { projectTaskNotification } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'
import { deliverTaskNotification } from '../packages/dingtalk-dsh-assistant/notification-delivery.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'
import { verifyTaskNotificationReadback } from '../packages/dingtalk-dsh-assistant/task-notification-readback.js'

async function fixture(t, { signature = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'topic-facts-')), snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'isolated' })
  const resident = await openResidentStore(facility)
  const config = { dbPath: join(root, 'facts.sqlite'), instanceId: 'fact-test' }
  let ledger = await openDynamicTaskStore({ ...config, initialize: true }), sequence = 0
  t.after(async () => { await ledger.close(); await resident.close(); await rm(root, { recursive: true, force: true }) })
  const query = (kind, args = {}) => ledger.query({ kind, ...args })
  const commit = (kind, args = {}, id = `cmd-${++sequence}`) => ledger.command({ id, kind, args })
  await resident.subscribe({ groupId: 'group' })
  await resident.ingest({ groupId: 'group', messageId: 'origin', text: '请核对两个结果', senderOpenDingTalkId: 'user', occurredAt: new Date().toISOString() })
  await resident.routeMessages({ groupId: 'group', routeId: 'route', routingRevision: 0, routes: [{ messageId: 'origin', messageVersion: 1,
    topics: [{ newTopicKey: 'existing', title: '核对结果' }] }] })
  const topicId = resident.listTopics('group')[0].topicId
  await resident.acceptTopicDecision({ groupId: 'group', topicId, revision: 1, decisionId: 'user-decision',
    decision: { basisMessageIds: ['origin'], actions: [], reason: '记录需求', topicUpdate: { summary: '等待结果' } } })
  await resident.completeTopicDecision({ groupId: 'group', topicId, decisionId: 'user-decision' })
  await commit('source.record', { sourceId: 'source', groupId: 'group', messageId: 'origin', actorId: 'user', text: '请核对两个结果' })
  const handler = createTopicFactHandler({ residentStore: resident, query, commit, signature: () => signature,
    onNotification: notification => projectTaskNotification({ residentStore: resident, notification }) })
  const context = () => handler.context('group', resident.getTopic('group', topicId))
  const submission = (ctx, id, reply) => ({ requestId: id, groupId: 'group', topicId, revision: resident.getTopic('group', topicId).revision,
    factContext: ctx, decision: { actions: [], topicUpdate: { summary: '已核对结果' }, reason: '有新结论', ...(reply ? { reply, replyToMessageId: 'origin', atOpenDingTalkIds: ['user'] } : {}) } })
  const submit = (request, options) => handler.submit(request, Object.fromEntries(['requestId', 'topicId', 'revision', 'decision'].map(key => [key, request[key]])), options)
  async function task(taskId, sourceIds = ['source']) {
    await commit('task.create', { taskId, groupId: 'group', ownerActorId: 'user', title: '核对结果', request: '核对结果', sourceRefs: sourceIds,
      topicRefs: [{ topicId, revision: 1 }], replyBindings: [{ groupId: 'group', topicId, sourceIds }] })
    return (await commit('task.claim', { taskId })).result.binding
  }
  const finish = (binding, summary = '检查通过', id = `complete-${binding.taskId}`) => commit('task.complete', {
    binding, summary, result: { summary, evidence: ['可回查的结果'], limitations: ['尚未部署'] }, topicFacts: true,
  }, id)
  return { root, resident, config, query, commit, handler, context, submission, submit, task, finish, topicId,
    async reopen() { await ledger.close(); ledger = await openDynamicTaskStore(config) } }
}

test('旧已接纳未投影决定不重新裁决，迁移明确阻断并保留原决定', async t => {
  const f = await fixture(t), binding = await f.task('legacy-accepted')
  await f.finish(binding)
  const original = f.resident.applyTopicFactSummary
  f.resident.applyTopicFactSummary = async () => { throw new Error('projection-interrupted') }
  try { await assert.rejects(f.submit(f.submission(await f.context(), 'accepted-decision')), /projection-interrupted/) }
  finally { f.resident.applyTopicFactSummary = original }
  const [legacy] = await f.query('router.fact.legacy-unsettled')
  assert.equal(legacy.state, 'accepted')
  assert.equal(legacy.decisionId, 'accepted-decision')
  await assert.rejects(f.commit('router.fact.migrateLegacy', { factId: legacy.id }), { code: 'DYNAMIC_ROUTER_LEGACY_FACT_BLOCKED' })
  assert.deepEqual(await f.query('topic.fact.get', { factId: legacy.id }), legacy)
  assert.deepEqual(await f.query('router.fact.pending'), [])
})

test('旧待投事实按原任务决定和来源迁移，历史账保持不变', async t => {
  const f = await fixture(t), binding = await f.task('legacy-migrate')
  await f.finish(binding)
  const [legacy] = await f.query('router.fact.legacy-unsettled')
  const receipt = await f.query('receipt.get', { id: legacy.commandId })
  const wakes = await f.query('wake.list', { taskId: 'legacy-migrate', state: 'claimed' })
  await f.commit('wake.ack', { binding, wakeIds: wakes.map(wake => wake.id) })
  await f.commit('task.drained', { binding })
  await f.commit('task.archive', { taskId: 'legacy-migrate', actorId: 'user' })
  const refs = await f.query('source.taskRefs', { groupId: 'group', sourceIds: ['source'] })
  assert.deepEqual(refs.map(({ sourceId, messageId, version, taskId }) => ({ sourceId, messageId, version, taskId })),
    [{ sourceId: 'source', messageId: 'origin', version: 1, taskId: 'legacy-migrate' }])
  assert.ok(refs[0].archivedAt)
  assert.deepEqual(await f.query('source.taskRefs', { groupId: 'other', sourceIds: ['source'] }), [])
  const migrated = await f.commit('router.fact.migrateLegacy', { factId: legacy.id }, `migrate:${legacy.id}`)
  const fact = migrated.result.fact.fact
  assert.equal(fact.factId, `legacy-router:${legacy.id}`)
  assert.deepEqual(fact.sourceIds, legacy.sourceIds)
  assert.equal(fact.taskVersion.controlRevision, receipt.taskDecision.controlRevision)
  assert.equal(fact.taskVersion.requirementRevision, legacy.requirementRevision)
  assert.deepEqual(await f.query('topic.fact.get', { factId: legacy.id }), legacy)
  await f.reopen()
  assert.deepEqual(await f.query('source.taskRefs', { groupId: 'group', sourceIds: ['source'] }), refs)
  assert.equal((await f.commit('router.fact.migrateLegacy', { factId: legacy.id }, `migrate:${legacy.id}`)).replayed, true)
  assert.deepEqual((await f.query('router.fact.get', { factId: fact.factId })).fact, fact)
})

test('ordinary Topic final result shares the whole-group contract and persists it across recovery', async t => {
  const f = await fixture(t, { signature: '助手代回' }), binding = await f.task('all-result')
  await f.finish(binding)
  const submission = f.submission(await f.context(), 'all-result-reply', '请大家查看[验收说明](https://example.org/acceptance)。')
  delete submission.decision.atOpenDingTalkIds; delete submission.decision.replyToMessageId
  submission.decision.atAll = true
  await f.submit(submission); await f.reopen(); await f.handler.recover()
  const [notice] = await f.query('notification.list'), [outbound] = f.resident.getGroup('group').outbox
  assert.equal(notice.payload.atAll, true); assert.equal(outbound.atAll, true)
  assert.deepEqual(notice.payload.atOpenDingTalkIds, []); assert.equal(notice.payload.sourceMessageId, undefined)
  const calls = []
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async args => { calls.push(args); return { exitCode: 0, stdout: '{"success":true}' } } } })
  await sendWorkflowNotification(adapter, notice)
  assert.ok(calls[0].includes('--at-all')); assert.ok(!calls[0].includes('--ref-msg-id'))
  assert.match(calls[0][calls[0].indexOf('--markdown') + 1], /\[验收说明\]\(https:\/\/example.org\/acceptance\)/)
})

test('最终文字与附件同批冻结，逐件有序发送，重启只核对未知项且不重发已送项', async t => {
  const f = await fixture(t), binding = await f.task('delivery-task')
  const artifactFiles = [1, 2].map(index => ({ artifact: { artifactId: String(index).repeat(64), taskId: 'delivery-task', requirementRevision: 1,
    fileName: `acceptance-${index}.png`, size: 8, sha256: 'a'.repeat(64) }, caption: `验收项${index}` }))
  await f.commit('task.complete', { binding, summary: 'UAT验收通过', result: { summary: 'UAT验收通过', evidence: [], limitations: [], artifactFiles }, topicFacts: true })
  assert.equal((await f.query('notification.list')).length, 0, '执行和Task完成不提前群发截图')
  const ctx = await f.context()
  assert.equal(ctx.input.facts[0].files.length, 2)
  await f.submit(f.submission(ctx, 'final-result', '已完成页面调整，UAT验收通过，截图对应两个验收项。'))
  const notices = await f.query('notification.list')
  assert.equal(notices.length, 3)
  const [summary, first, second] = notices
  assert.match(summary.payload.text, /acceptance-1.png：验收项1/)
  assert.equal(first.payload.deliveryId, summary.id); assert.equal(first.payload.afterNotificationId, summary.id)
  assert.equal(second.payload.afterNotificationId, first.id)
  assert.equal(first.payload.sourceMessageId, undefined, '文件不另引用或重复@')
  assert.equal((await f.commit('notification.start', { notificationId: first.id })).dispatchEligible, false)
  const sends = new Map(); let firstReadable = false
  const notifications = {
    send: async n => { sends.set(n.id, (sends.get(n.id) ?? 0) + 1); return { openTaskId: `send-${n.id}` } },
    readback: async n => n.id === first.id && !firstReadable ? undefined : { messageId: `message-${n.id}`, conversationId: 'group' },
  }
  const deliver = async id => deliverTaskNotification({ notification: await f.query('notification.get', { notificationId: id }), notifications, command: f.commit })
  await deliver(summary.id); await deliver(first.id)
  assert.equal((await f.query('notification.get', { notificationId: first.id })).state, 'unknown')
  assert.equal((await f.commit('notification.start', { notificationId: second.id })).dispatchEligible, false)
  await f.reopen(); firstReadable = true
  await f.commit('notification.diagnostic', { notificationId: first.id, nextAttemptAt: '2000-01-01T00:00:00Z' })
  await deliver(summary.id); await deliver(first.id); await deliver(second.id)
  assert.deepEqual([...sends.values()], [1, 1, 1])
  assert.ok((await f.query('notification.list')).every(n => n.state === 'delivered' && n.receipt.messageId))
  assert.equal((await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId })).length, 0)
})

test('完成与事实同事务，回复失败不影响完成；重启复用结论、沉默也消费事件', async t => {
  const f = await fixture(t), a = await f.task('alpha'), b = await f.task('beta')
  await assert.rejects(f.commit('task.complete', { binding: a, summary: 'invalid', topicFacts: true,
    replyBindings: [{ groupId: 'other', topicId: f.topicId, sourceIds: ['source'] }] }), { code: 'TOPIC_REPLY_SOURCE_INVALID' })
  assert.equal((await f.query('task.get', { taskId: 'alpha' })).status, 'active')
  await Promise.all([f.finish(a), f.finish(b)])
  assert.equal((await f.query('notification.list')).length, 0)
  assert.ok((await f.query('task.list')).every(task => task.status === 'completed'))
  await f.reopen()
  const ctx = await f.context()
  assert.equal(ctx.eventIds.length, 2)
  const sub = f.submission(ctx, 'fact-decision', '两个结果均已核对，尚未部署。')
  const apply = f.resident.applyTopicFactSummary
  f.resident.applyTopicFactSummary = async () => { throw new Error('projection interruption') }
  await assert.rejects(f.submit(sub), /projection interruption/)
  assert.equal((await f.query('notification.list')).length, 1, '回复意图已随处理结论落库')
  assert.equal(await f.context(), null)
  f.resident.applyTopicFactSummary = apply
  await f.reopen(); await f.handler.recover(); await f.handler.recover()
  assert.equal(f.resident.getGroup('group').outbox.length, 1)
  assert.equal(f.resident.getTopic('group', f.topicId).summary, '已核对结果')
  assert.equal((await f.finish(a)).replayed, true)
  const [notice] = await f.query('notification.list')
  assert.deepEqual(notice.payload.taskIds, ['alpha', 'beta'])
  assert.deepEqual(notice.payload.coveredEventIds, ctx.eventIds)
  let sends = 0
  const notifications = { send: async () => { sends++; throw new Error('transport uncertain') }, readback: async () => ({ messageId: 'dingtalk-result', visible: true }) }
  await assert.rejects(deliverTaskNotification({ notification: notice, command: f.commit, notifications }), /transport uncertain/)
  await f.reopen()
  await f.commit('notification.recovery.start', { notificationId: notice.id,
    expectedToken: (await import('../packages/dingtalk-dsh-assistant/notification-delivery.js')).taskNotificationRecovery(await f.query('notification.get', { notificationId: notice.id })).expectedToken })
  await deliverTaskNotification({ notification: await f.query('notification.get', { notificationId: notice.id }), command: f.commit, notifications })
  const delivered = await f.query('notification.get', { notificationId: notice.id })
  assert.equal(sends, 1, 'unknown仅回查，不重新生成或发送')
  assert.equal(delivered.payload.text, notice.payload.text)
  await projectTaskNotification({ residentStore: f.resident, notification: delivered })
  assert.equal(f.resident.getGroup('group').outbox[0].deliveredMessageId, 'dingtalk-result')
  const later = await f.task('later'); await f.finish(later, '新增核对结论')
  const next = await f.context(), silent = f.submission(next, 'silent')
  assert.equal(next.input.replies.length, 1)
  await f.submit(silent); await f.reopen(); await f.handler.recover()
  assert.equal(await f.context(), null)
  assert.equal((await f.query('notification.list')).length, 1)
})

for (const contextReference of [true, false]) test('事实回复保留多人原生提及并在冻结时消除引用叠加 contextReference=' + contextReference, async t => {
  const f = await fixture(t, { signature: '验收助理' })
  const additions = [{ messageId: 'review', actorId: 'open-reviewer', senderName: '测试成员甲', text: '我来验收，请把核验结果也同步给我。' },
    ...Array.from({ length: 10 }, (_, i) => ({ messageId: `progress-${i}`, actorId: 'open-helper', senderName: '测试成员甲一',
      text: i === 9 ? '访问条件已恢复，完成后把截图发群里。' : '补充核验材料。' })),
    { messageId: 'unresolved', senderName: '测试成员甲', text: '仅有显示名的历史信息。' }]
  for (const item of additions) {
    await f.resident.ingest({ groupId: 'group', messageId: item.messageId, senderOpenDingTalkId: item.actorId,
      senderName: item.senderName, text: item.text, occurredAt: new Date().toISOString() })
    if (item.actorId) await f.commit('source.record', { sourceId: `source-${item.messageId}`, groupId: 'group', ...item })
  }
  await f.resident.routeMessages({ groupId: 'group', routeId: 'context-route', routingRevision: f.resident.getGroup('group').routingRevision,
    routes: additions.map(item => ({ messageId: item.messageId, messageVersion: 1, topics: [{ topicId: f.topicId }] })) })
  const revision = f.resident.getTopic('group', f.topicId).revision
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision, decisionId: 'context-decision',
    decision: { actions: [], reason: '保留原始需求、验收约定及同事推进材料', topicUpdate: { summary: '按原需求核验，验收人需要同步结果；后续同事提供截图要求和访问条件。' } } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'context-decision' })
  const binding = await f.task('check', ['source-progress-9'])
  await f.finish(binding)
  const ctx = await f.context()
  assert.deepEqual(ctx.input.sources.map(source => source.actorId), ['open-helper'], 'fact trigger alone would pick the wrong recipient')
  assert.ok(ctx.input.originMessages.some(message => message.messageId === 'origin' && message.senderOpenDingTalkId === 'user'))
  assert.ok(ctx.input.originMessages.some(message => message.messageId === 'review' && message.senderOpenDingTalkId === 'open-reviewer'))
  assert.ok(!ctx.input.recentMessages.some(message => message.messageId === 'origin'))
  assert.ok(ctx.metrics.contextBytes <= 22 * 1024)
  const markdown = '## 核验完成\n\n- 环境：UAT\n\n- 已验证：[PR 101](https://example.com/client/pull/101)、[PR 102](https://example.com/server/pull/102)\n\n截图与结果已整理。'
  const sub = f.submission(ctx, 'selected-audience', markdown)
  sub.decision.reason = '原需求人接收交付，验收人明确要求同步；后续材料提供者不自动替换或加入收件人。'
  sub.decision.atOpenDingTalkIds = ['user', 'open-reviewer', 'user']
  if (contextReference) sub.decision.replyToMessageId = 'progress-9'
  else delete sub.decision.replyToMessageId
  for (const patch of [{ atOpenDingTalkIds: undefined, reply: '@测试成员甲 核验完成。' },
    { atOpenDingTalkIds: ['测试成员甲'] }, { atOpenDingTalkIds: ['untrusted-id'] }, { replyToMessageId: 'unresolved' }]) {
    await assert.rejects(f.submit({ ...sub, decision: { ...sub.decision, ...patch } }))
    assert.equal((await f.query('notification.list')).length, 0)
  }
  await f.submit(sub)
  const [notice] = await f.query('notification.list')
  assert.equal(notice.payload.sourceId, undefined)
  assert.equal(notice.payload.sourceMessageId, undefined)
  assert.equal(notice.payload.actorId, undefined)
  assert.deepEqual(notice.payload.atOpenDingTalkIds, ['user', 'open-reviewer'])
  assert.equal(notice.payload.text, markdown + '\n\n- 验收助理', 'Freeze the complete linked Markdown and configured signature')
  await f.reopen(); await f.handler.recover()
  const persisted = await f.query('notification.get', { notificationId: notice.id })
  assert.deepEqual(persisted.payload, notice.payload)
  const commands = []
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { run: async args => {
    commands.push(args); return { exitCode: 0, stdout: JSON.stringify({ sendReceipt: { openTaskId: 'send-operation' } }) }
  } } })
  const observed = { messageId: 'sent-result', conversationId: 'group', text: notice.payload.text,
    atOpenDingTalkIds: ['user', 'open-reviewer'] }
  assert.equal(verifyTaskNotificationReadback(persisted, { ...observed, atOpenDingTalkIds: ['user', 'open-reviewer', 'open-helper'] }, { acknowledgedMessageId: 'sent-result' }), undefined)
  assert.equal(verifyTaskNotificationReadback(persisted, { ...observed, atOpenDingTalkIds: undefined, text: '@测试成员甲 ' + observed.text }, { acknowledgedMessageId: 'sent-result' }), undefined)
  await deliverTaskNotification({ notification: persisted, command: f.commit, notifications: {
    send: notification => sendWorkflowNotification(adapter, notification),
    readback: notification => verifyTaskNotificationReadback(notification, observed, { acknowledgedMessageId: 'sent-result' }),
  } })
  assert.equal(commands.length, 1)
  const args = commands[0], argument = key => args[args.indexOf(key) + 1]
  assert.equal(argument('--group'), 'group')
  assert.equal(args.includes('--ref-msg-id'), false)
  assert.equal(args.includes('--ref-sender'), false)
  assert.ok(args.includes('+messages-send'))
  assert.equal(argument('--as'), 'user')
  assert.equal(argument('--at-open-dingtalk-ids'), 'user,open-reviewer')
  assert.equal(argument('--msg-type'), 'markdown')
  assert.equal(argument('--markdown'), '<@user> <@open-reviewer>\n\n' + markdown + '\n\n- 验收助理')
  assert.equal(args.includes('--text'), false, 'The DWS plain-text branch loses Markdown rendering')
  assert.equal(argument('--format'), 'json', 'Output serialization is independent of the Markdown message type')
  assert.equal(args.includes('--at-all'), false)
  assert.equal(args.includes('--at-user-ids'), false)
  const delivered = await f.query('notification.get', { notificationId: notice.id })
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.receipt.mentionVerification, 'verified')
  await projectTaskNotification({ residentStore: f.resident, notification: delivered })
  const outbound = f.resident.getGroup('group').outbox[0]
  assert.equal(outbound.replyToMessageId, undefined)
  assert.deepEqual(outbound.atOpenDingTalkIds, ['user', 'open-reviewer'])
})

test('旧事实请求不能覆盖已到达补充或任务新版本，新结论允许再回复', async t => {
  const f = await fixture(t), a = await f.task('alpha')
  await f.finish(a)
  const ctx = await f.context(), sub = f.submission(ctx, 'stale', '已完成。')
  await f.resident.ingest({ groupId: 'group', messageId: 'supplement', text: '先不要部署', senderOpenDingTalkId: 'user', occurredAt: new Date().toISOString() })
  assert.equal((await f.submit(sub)).status, 'topic-stale')
  await f.resident.routeMessages({ groupId: 'group', routeId: 'supplement-route', routingRevision: f.resident.getGroup('group').routingRevision,
    routes: [{ messageId: 'supplement', messageVersion: 1, topics: [{ topicId: f.topicId }] }] })
  assert.equal((await f.submit(sub)).status, 'topic-stale')
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision: 2, decisionId: 'supplement-decision',
    decision: { actions: [], reason: '保留限制', topicUpdate: { summary: '先不要部署' } } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'supplement-decision' })
  const current = await f.context()
  assert.ok(current.input.recentMessages.some(item => item.text.includes('先不要部署')))
  const reply = f.submission(current, 'fresh', '已核对，按补充要求保持未部署。')
  await f.submit(reply)
  const later = await f.task('beta'); await f.finish(later, '第二项也核对完成')
  const followup = f.submission(await f.context(), 'later', '第二项已核对完成。')
  await f.submit(followup)
  assert.equal((await f.query('notification.list')).length, 2)
})

test('事实提交在群锁内复验材料，过期或未读不消费事实及通知', async t => {
  const f = await fixture(t), binding = await f.task('preflight-task')
  await f.finish(binding)
  const ctx = await f.context(), sub = f.submission(ctx, 'preflight-result')
  const before = f.resident.getTopic('group', f.topicId)
  const expectedQuestions = JSON.stringify(before.openQuestions)
  let enter, release, checks = 0
  const entered = new Promise(resolve => { enter = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const holder = f.resident.commitTopicFactDecision({ groupId: 'group', topicId: f.topicId,
    revision: before.revision, expectedSummary: before.summary, commit: async () => {
      enter()
      await blocked
      return { status: 'held' }
    } })
  await entered
  // 先排队真实的同版本材料变更，再排队提交，验证回调没有提前在锁外运行。
  const changed = f.resident.applyTopicFactSummary({ groupId: 'group', topicId: f.topicId,
    revision: before.revision, expectedSummary: before.summary, requestId: 'changed-context',
    decision: { topicUpdate: { openQuestions: ['禁止上线'] } } })
  const pending = f.submit(sub, { preflight: () => {
    checks++
    return JSON.stringify(f.resident.getTopic('group', f.topicId).openQuestions) === expectedQuestions
  } })
  try { assert.equal(checks, 0) } finally { release() }
  await holder
  await changed
  assert.equal((await pending).status, 'topic-stale')
  assert.equal(checks, 1)
  assert.equal(f.resident.getTopic('group', f.topicId).revision, before.revision)
  assert.equal(f.resident.getTopic('group', f.topicId).summary, before.summary)
  assert.equal((await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId })).length, 1)
  assert.deepEqual(await f.query('notification.list'), [])
  assert.deepEqual(f.resident.getGroup('group').outbox, [])

  await assert.rejects(f.submit(sub, { preflight: () => { throw new Error('topic_decision_context_unread') } }), /topic_decision_context_unread/)
  assert.equal((await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId })).length, 1)
  assert.deepEqual(await f.query('notification.list'), [])
  assert.deepEqual(f.resident.getGroup('group').outbox, [])

  const current = await f.context(), fresh = f.submission(current, 'fresh-preflight-result', '已核对，保持未上线。')
  fresh.decision.topicUpdate = { summary: '已核对，保持未上线', openQuestions: ['禁止上线'] }
  assert.equal((await f.submit(fresh, { preflight: () => {
    checks++
    return JSON.stringify(f.resident.getTopic('group', f.topicId).openQuestions) === JSON.stringify(current.input.openQuestions)
  } })).status, 'accepted')
  assert.equal(checks, 2)
  assert.deepEqual(await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId }), [])
  assert.equal((await f.query('notification.list')).length, 1)
  assert.equal(f.resident.getGroup('group').outbox.length, 1)
})

test('事实轮拒绝任何任务动作，引用已送达回复能反查 Topic', async t => {
  const f = await fixture(t), a = await f.task('alpha'); await f.finish(a)
  const texts = [], tools = new Map(), actions = []
  const coordinator = createTopicCoordinator({ store: f.resident, taskFacts: f.handler, workflowPromptsEnabled: false,
    getAgent: () => ({ steer: message => texts.push(message.content[0].text), whenIdle: () => new Promise(() => {}) }),
    assertSession() {}, serializeTasks: run => run(), applyAction: action => actions.push(action), appendOutbox: () => {},
    reviewCandidates: () => [], validateReplyReview() {}, onError: error => { throw error }, isClosing: () => false })
  t.after(() => coordinator.close())
  coordinator.register({ tools: { register: tool => tools.set(tool.name, tool) } }, 'group')
  await Promise.all([coordinator.schedule('group'), coordinator.schedule('group')])
  const envelopes = () => texts.map(text => JSON.parse(text.split('\n').find(line => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length)))
  const [request] = envelopes()
  assert.equal(envelopes().length, 1)
  assert.equal(request.trigger, 'task-facts')
  const submit = decision => tools.get('group_decision_submit').execute({ requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision })
  const decision = { actions: [], topicUpdate: { summary: '结果已核验' }, reason: '新结果', reply: '核对完成。', replyToMessageId: 'origin', atOpenDingTalkIds: ['user'] }
  assert.equal((await submit({ ...decision, actions: [{ kind: 'new-task' }] })).status, 'invalid-arguments')
  assert.equal((await submit(decision)).status, 'accepted')
  assert.equal(actions.length, 0)
  const [notice] = await f.query('notification.list')
  await projectTaskNotification({ residentStore: f.resident, notification: { ...notice, state: 'delivered', receipt: { messageId: 'quoted-delivery' } } })
  await f.resident.ingest({ groupId: 'group', messageId: 'followup', text: '这个结果还有一个问题', senderOpenDingTalkId: 'user',
    quotedMessage: { messageId: 'quoted-delivery', content: '核对完成。' }, occurredAt: new Date().toISOString() })
  await coordinator.schedule('group')
  const route = envelopes().find(value => value.messages?.some(item => item.messageId === 'followup'))
  assert.deepEqual(route.messages[0].quotedReply, { topicId: f.topicId, taskIds: ['alpha'], coveredEventIds: request.facts.map(f => f.eventId) })
  assert.ok(route.relatedTopics.some(topic => topic.topicId === f.topicId))
})

test('事实轮旧摘要必须读完当前表面的未汇总材料后才能消费', async t => {
  const f = await fixture(t), binding = await f.task('unsummarized-task')
  await f.resident.ingest({ groupId: 'group', messageId: 'scope-delta', text: '只核查不部署。' + '保留全部约束。'.repeat(3000),
    senderOpenDingTalkId: 'user', occurredAt: new Date().toISOString() })
  await f.resident.routeMessages({ groupId: 'group', routeId: 'scope-route', routingRevision: f.resident.getGroup('group').routingRevision,
    routes: [{ messageId: 'scope-delta', messageVersion: 1, topics: [{ topicId: f.topicId }] }] })
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision: 2, decisionId: 'scope-accepted',
    decision: { basisMessageIds: ['scope-delta'], actions: [], reason: '仅接纳核查，不批准实施或部署' } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'scope-accepted' })
  await f.finish(binding)
  const session = Session.create('fact-unsummarized-surface'), tools = new Map(), texts = [], actions = []
  const agent = { session, steer(message) { texts.push(message.content[0].text); session.append('user/message', message, { surfaceOp: 'append' }) }, whenIdle: () => new Promise(() => {}) }
  const coordinator = createTopicCoordinator({ store: f.resident, taskFacts: f.handler, workflowPromptsEnabled: false,
    getAgent: () => agent, assertSession() {}, serializeTasks: run => run(), applyAction: action => actions.push(action), appendOutbox() {},
    reviewCandidates: () => [], validateReplyReview() {}, onError: error => { throw error }, isClosing: () => false })
  t.after(() => coordinator.close())
  await coordinator.schedule('group')
  const request = JSON.parse(texts.find(text => text.startsWith('[GROUP_TOPIC_DECISION]')).split('\n').find(line => line.startsWith('Topic 请求：')).slice('Topic 请求：'.length))
  assert.equal(request.trigger, 'task-facts')
  assert.equal(request.revision, 2)
  assert.equal(request.summaryRevision, 1)
  assert.equal(request.hasUnsummarized, true)
  coordinator.register({ tools: { register: tool => tools.set(tool.name, tool) } }, 'group', request)
  const submit = () => tools.get('group_decision_submit').execute({ requestId: request.requestId, topicId: request.topicId, revision: request.revision,
    decision: { actions: [], topicUpdate: { summary: '只读核查已完成，未实施或部署' }, reason: '结果与受理范围一致', reply: '只读核查完成，未实施或部署。', atOpenDingTalkIds: ['user'] } })
  const assertPending = async () => {
    assert.equal((await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId })).length, 1)
    assert.deepEqual(await f.query('notification.list'), [])
    assert.deepEqual(f.resident.getGroup('group').outbox, [])
  }
  const contextRequired = offset => ({ status: 'context-required', error: 'topic_decision_context_unread',
    nextCall: { name: 'group_decision_context_get', arguments: { requestId: request.requestId, section: 'summary', offset } } })
  const first = await submit()
  assert.deepEqual(first, contextRequired(0))
  await assertPending()
  const read = args => tools.get('group_decision_context_get').execute(args)
  const visible = result => {
    const id = `fact-read-${session.snapshotEvents().length}`
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: `assistant-${id}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'tool-call', id, name: 'group_decision_context_get', arguments: '{}' }] } }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, message: { ...createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] }), id: `result-${id}` } }, { surfaceOp: 'append' })
  }
  const args = first.nextCall.arguments, pages = []
  let page = await tools.get(first.nextCall.name).execute(args), lastOffset = 0
  assert.equal(page.hasMore, true)
  while (page.hasMore) {
    pages.push(page.text)
    visible(page)
    lastOffset = page.nextOffset
    page = await read({ ...args, offset: lastOffset })
  }
  pages.push(page.text)
  assert.ok(JSON.parse(pages.join('')).unsummarized.decisions.some(record => record.decision.reason === '仅接纳核查，不批准实施或部署'))
  const missing = await submit()
  assert.deepEqual(missing, contextRequired(lastOffset))
  await assertPending()
  visible({ ...page, requestId: 'another-fact-request' })
  const wrongRequest = await submit()
  assert.deepEqual(wrongRequest, contextRequired(lastOffset))
  await assertPending()
  visible(await tools.get(wrongRequest.nextCall.name).execute(wrongRequest.nextCall.arguments))
  assert.equal((await submit()).status, 'accepted')
  assert.deepEqual(await f.query('topic.fact.pending', { groupId: 'group', topicId: f.topicId }), [])
  assert.equal((await f.query('notification.list')).length, 1)
  assert.equal(f.resident.getGroup('group').outbox.length, 1)
  assert.equal(f.resident.getTopic('group', f.topicId).summaryRevision, 2)
  assert.deepEqual(actions, [])
})

test('默认事实上下文使用有界 SQL 投影，长执行材料不进入判断', async t => {
  const f = await fixture(t)
  const many = '执行全文不应加载'.repeat(100000)
  await f.commit('source.record', { sourceId: 'long-source', groupId: 'group', messageId: 'long', actorId: 'user', text: many })
  const a = await f.task('alpha', ['long-source']), b = await f.task('beta')
  await f.finish(a, many); await f.finish(b, many)
  await f.task('related-active')
  const prepare = DatabaseSync.prototype.prepare, statements = []
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) { statements.push(sql); return prepare.call(this, sql) })
  const ctx = await f.context()
  assert.equal(statements.length, 4)
  assert.ok(statements.every(sql => /LIMIT\s+\d+/i.test(sql) && !/SELECT\s+(?:\*|body)\s+FROM/i.test(sql)))
  assert.ok(ctx.input.tasks.some(task => task.taskId === 'related-active'))
  assert.ok(ctx.metrics.queryResultBytes < 40 * 1024)
  assert.ok(ctx.metrics.contextBytes <= 22 * 1024)
  assert.ok(!JSON.stringify(ctx.input).includes(many))
  t.diagnostic(JSON.stringify({ ...ctx.metrics, sourceBytes: Buffer.byteLength(many), measuredStatements: statements.length }))
})

test('历史归属只取有效来源，移除与合并记录不广播历史 topicRefs', () => {
  const message = { messageId: 'm', messageVersion: 1, sequence: 1 }
  const entry = { messageId: 'm', messageVersion: 1, unitId: 'u', unitRevision: 1, action: 'add', revision: 1, effectOwner: true }
  const group = { messages: [message], topics: [{ topicId: 'old', revision: 2, entries: [entry, { ...entry, action: 'remove', revision: 2 }] },
    { topicId: 'current', revision: 1, entries: [entry] }] }
  assert.equal(replyTopicForMessage(group, message), 'current')
  group.topics[0].mergedInto = 'current'
  assert.equal(replyTopicForMessage(group, { ...message, replyTopicId: 'old' }), 'current')
  assert.equal(replyTopicForMessage(group, { ...message, replyTopicId: 'deleted' }), null)
})

for (const answeredBeforeDecision of [true, false]) test(`旧问题失效不会吞掉混合完成事实：接纳前答复=${answeredBeforeDecision}`, async t => {
  const f = await fixture(t), question = await f.task('question'), done = await f.task('done')
  const artifactFiles = [{ artifact: { artifactId: 'd'.repeat(64), taskId: 'done', requirementRevision: 1, fileName: 'acceptance.png', size: 8, sha256: 'a'.repeat(64) }, caption: '验收结果' }]
  await f.commit('task.complete', { binding: done, summary: '核对完成', result: { summary: '核对完成', artifactFiles }, topicFacts: true })
  await f.commit('task.wait', { binding: question, action: 'wait', summary: '等待日期', question: '请确认日期', topicFacts: true,
    humanRequest: { requestId: 'date', audience: 'requester', reason: '缺少日期' } })
  await f.commit('task.drained', { binding: question })
  const answer = async () => {
    await f.commit('source.record', { sourceId: 'answer', groupId: 'group', messageId: 'answer-message', actorId: 'user', text: '明日', channel: 'im' })
    await f.commit('task.human.respond', { taskId: 'question', requestId: 'date', sourceId: 'answer', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  }
  const before = await f.context()
  if (answeredBeforeDecision) {
    await answer()
    assert.equal((await f.submit(f.submission(before, 'stale-question', '结果已完成，请确认日期。'))).status, 'topic-stale')
  }
  const context = await f.context()
  if (answeredBeforeDecision) assert.equal(context.input.facts.find(fact => fact.kind === 'needs-input').questionState, 'resolved')
  await f.submit(f.submission(context, 'mixed-result', '另一项核对完成。'))
  const [notice, fileNotice] = await f.query('notification.list')
  assert.equal(fileNotice.payload.deliveryId, notice.id)
  if (!answeredBeforeDecision) await answer()
  const started = await f.commit('notification.start', { notificationId: notice.id })
  if (answeredBeforeDecision) assert.equal(started.dispatchEligible, true)
  else {
    assert.equal(started.result.notification.state, 'superseded')
    assert.equal((await f.query('notification.get', { notificationId: fileNotice.id })).state, 'superseded')
    assert.deepEqual(started.result.topicFacts.map(fact => fact.taskId), ['done'])
    await f.reopen()
    const retry = await f.context()
    assert.notEqual(retry.generation, context.generation)
    assert.deepEqual(retry.eventIds, context.input.facts.filter(fact => fact.taskId === 'done').map(fact => fact.eventId))
    await f.submit(f.submission(retry, 'retained-result', '另一项核对完成。'))
    assert.equal((await f.commit('topic.fact.projected', { factId: retry.eventIds[0], decisionId: 'mixed-result' }, 'late-old-projection')).result.status, 'superseded')
    assert.deepEqual(await f.query('topic.fact.projections'), [], '同一事件重排后投影新决定，不能重放旧投影收据')
    await f.reopen()
    assert.deepEqual(await f.handler.recover(), [])
    const current = (await f.query('notification.list')).find(item => item.id !== notice.id && !item.payload.artifact)
    const currentFile = (await f.query('notification.list')).find(item => item.payload.deliveryId === current.id && item.payload.artifact)
    assert.equal(currentFile.state, 'prepared')
    assert.equal((await f.commit('notification.start', { notificationId: current.id })).dispatchEligible, true)
    assert.equal((await f.query('task.get', { taskId: 'done' })).status, 'completed')
  }
})

test('待处理事实阻止取消订阅，单条投影故障不阻断其余恢复', async t => {
  const f = await fixture(t), a = await f.task('first')
  const runtime = await openTaskResidentRuntime({ agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } }, f.resident, f.root)
  runtime.hasPendingTopicFacts = groupId => f.query('topic.fact.unsettled', { groupId })
  await f.finish(a)
  await assert.rejects(runtime.unsubscribe({ groupId: 'group' }), /group_has_pending_topic_facts/)
  const apply = f.resident.applyTopicFactSummary
  f.resident.applyTopicFactSummary = async () => { throw new Error('projection temporarily unavailable') }
  await assert.rejects(f.submit(f.submission(await f.context(), 'first-result', '第一项已完成。')), /projection temporarily unavailable/)
  await assert.rejects(runtime.unsubscribe({ groupId: 'group' }), /group_has_pending_topic_facts/)
  const b = await f.task('second'); await f.finish(b)
  await assert.rejects(f.submit(f.submission(await f.context(), 'second-result', '第二项已完成。')), /projection temporarily unavailable/)
  f.resident.applyTopicFactSummary = async decision => {
    if (decision.requestId === 'first-result') throw new Error('projection temporarily unavailable')
    return apply(decision)
  }
  assert.equal((await f.handler.recover()).length, 1)
  assert.equal(f.resident.getGroup('group').outbox.length, 1, '故障事实不阻断其他已接纳回复的恢复')
  f.resident.applyTopicFactSummary = apply
  assert.deepEqual(await f.handler.recover(), [])
  assert.equal(f.resident.getGroup('group').outbox.length, 2)
  assert.equal(await f.query('topic.fact.unsettled', { groupId: 'group' }), false)
})

test('归档后仍以有界投影提供待处理任务状态和已送达回复', async t => {
  const f = await fixture(t), a = await f.task('archived')
  await f.finish(a); await f.commit('task.drained', { binding: a })
  await f.commit('task.archive', { taskId: a.taskId, actorId: 'operator' })
  const ctx = await f.context()
  assert.ok(ctx.input.tasks[0].archivedAt)
  await f.submit(f.submission(ctx, 'archived-result', '结果已核验。'))
  const [notice] = await f.query('notification.list')
  await deliverTaskNotification({ notification: notice, command: f.commit,
    notifications: { send: async () => ({ messageId: 'archived-delivery' }), readback: async () => ({ messageId: 'archived-delivery', visible: true }) } })
  // Archive a second completed task together with its already delivered reply.
  const b = await f.task('later'); await f.finish(b); await f.commit('task.drained', { binding: b })
  await f.submit(f.submission(await f.context(), 'later-result', '新增结果已核验。'))
  const second = (await f.query('notification.list')).find(item => item.id !== notice.id)
  await deliverTaskNotification({ notification: second, command: f.commit,
    notifications: { send: async () => ({ messageId: 'later-delivery' }), readback: async () => ({ messageId: 'later-delivery', visible: true }) } })
  await f.commit('task.archive', { taskId: b.taskId, actorId: 'operator' })
  const replies = await f.query('topic.fact.replies', { groupId: 'group', topicId: f.topicId })
  assert.deepEqual(new Set(replies.map(reply => reply.deliveredMessageId)), new Set(['archived-delivery', 'later-delivery']))
})


test('Topic coordination freezes its selected responsible participant, not the requester, and correlates the pending question', async t => {
  const f = await fixture(t), binding = await f.task('coordination'), other = await f.task('unrelated')
  await f.resident.ingest({ groupId: 'group', messageId: 'infra-context', text: '我负责环境，可提供已有验证入口', senderOpenDingTalkId: 'infra-owner', occurredAt: new Date().toISOString() })
  await f.resident.routeMessages({ groupId: 'group', routeId: 'infra-context-route', routingRevision: f.resident.getGroup('group').routingRevision,
    routes: [{ messageId: 'infra-context', messageVersion: 1, topics: [{ topicId: f.topicId }] }] })
  const revision = f.resident.getTopic('group', f.topicId).revision
  await f.resident.acceptTopicDecision({ groupId: 'group', topicId: f.topicId, revision, decisionId: 'infra-context-noted', decision: { basisMessageIds: ['infra-context'], actions: [], reason: '上下文成员职责', topicUpdate: { summary: '环境负责人可提供入口' } } })
  await f.resident.completeTopicDecision({ groupId: 'group', topicId: f.topicId, decisionId: 'infra-context-noted' })
  await f.commit('task.wait', { binding, action: 'blocked', summary: '业务成果已完成，当前路线的环境搭建不能推进原验收', question: '请确认可复用的现有验证入口，或接受当前证据边界',
    evidence: ['原目标只要求业务修改；实际工具正在搭建额外环境'], attemptedActions: ['已保留现有修改与验证结果'], audience: 'topic', topicFacts: true,
    humanRequest: { requestId: 'route-choice', audience: 'topic', reason: '需要归属话题协调路线' } })
  await f.commit('task.drained', { binding })
  const context = await f.context(), fact = context.input.facts.find(item => item.taskId === 'coordination')
  assert.equal((await f.query('topic.fact.get', { factId: fact.eventId })).humanRequestId, 'route-choice'); assert.equal(fact.audience, 'topic'); assert.match(fact.question, /验证入口/)
  const request = f.submission(context, 'coordinate-with-infra', '请环境负责人提供已有验证入口；保留当前业务成果。')
  delete request.decision.replyToMessageId; request.decision.atOpenDingTalkIds = ['infra-owner']
  await f.submit(request)
  const notice = (await f.query('notification.list')).find(item => item.payload.humanRequests?.length)
  assert.deepEqual(notice.payload.atOpenDingTalkIds, ['infra-owner']); assert.equal(!!notice.payload.atAll, false)
  assert.deepEqual(notice.payload.humanRequests, [{ taskId: 'coordination', requestId: 'route-choice' }])
  assert.equal((await f.query('task.get', { taskId: 'unrelated' })).control, 'active')
  await f.finish(other, '无关任务正常完成')
  assert.equal((await f.query('task.get', { taskId: 'unrelated' })).status, 'completed')
  await f.reopen(); assert.equal((await f.query('task.get', { taskId: 'coordination' })).humanRequests[0].audience, 'topic')
})
