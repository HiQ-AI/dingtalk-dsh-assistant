import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareMessageContext } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { messageTimestamp, normalizeHistoryMessage } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import { isDirectedTaskRequest } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

test('群协调来源保留完整长正文、附件身份及独立发送者，不施加旧阶段字节限制', async () => {
  const body = '先执行两条，找我验证通过，再刷69条；行业审核保留。'.repeat(1000)
  const history = [{ sourceKey: 'file-source', sourceVersion: 2, actorId: 'other', text: '已有审核表', attachments: [{ resourceRef: 'file-id', name: '审核.xlsx' }] }]
  const snapshot = await prepareMessageContext({ sourceKey: 'now', sourceVersion: 1, body, actorId: 'requester', conversationId: 'group', context: { directedToAgent: true } }, { history: async () => history, splitBackground: async ({ history }) => history })
  assert.equal(snapshot.source.text, body)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 8000)
  assert.equal(snapshot.replyObligation.required, true)
  assert.equal(snapshot.history[0].actorId, 'other')
  assert.equal(snapshot.history[0].attachments[0].resourceRef, 'file-id')
})

test('来源时间统一epoch并保留文件消息准确fileId', () => {
  assert.equal(messageTimestamp('2026-09-30 17:15:14'), messageTimestamp('2026-09-30T09:15:14Z'))
  assert.equal(messageTimestamp('2026-09-30T17:49:43.607+08:00'), 1790761783607)
  const history = normalizeHistoryMessage({ messageId: 'm', createTime: '2026-09-30 17:15:14', text: '[文件] 审核.xlsx fileId: exact' }, 'group')
  assert.equal(history.occurredAt, '2026-09-30T09:15:14.000Z')
  assert.deepEqual(history.resourceRefs, [{ type: 'fileId', resourceId: 'exact', name: '审核.xlsx' }])
})

test('身份准入不限50字窗口，也不把对第三人的点名变成助手交办', () => {
  assert.equal(isDirectedTaskRequest('小小鹏你在嘛，现在帮忙看一下第一个sheet页，70条数据集的审核状态', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('小小鹏，' + '要求'.repeat(80) + '写完脚本，然后小鹏审批', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('@其他人 处理以上需求', ['小小鹏']), false)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

async function historyFixture(t, inspect, legacyMessages = [], beforeCommand) {
  const root = await mkdtemp(join(tmpdir(), 'message-history-repair-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'history-repair', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [] })
  let service, serial = 0
  t.after(async () => { await service?.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = async (kind, args) => (await store.command({ id: `history-${++serial}`, kind, args })).result
  const receive = async (runId, options = {}) => {
    const { quiet = true, ...value } = options
    const source = { runId, sourceKey: runId, sourceVersion: 1, conversationId: 'group', actorId: 'owner', body: '先别管它',
      context: { occurredAt: '2026-10-02T00:00:00.000Z', quoteRefs: [], attachments: [] }, ...value }
    await command('message.receive', source)
    if (quiet) await command('message.quiet', { runId, body: source.body })
    return source
  }
  service = await openWorkflowService({ ctx: {}, config: { groupIds: ['group', 'other'], ownerActorId: 'owner' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: id => ({ groupId: id, messages: id === 'group' ? legacyMessages : [] }) },
    execution: { store: beforeCommand ? { ...store, command: async value => { await beforeCommand(value, store); return store.command(value) } } : store, artifacts, controller }, taskOwnerSessions: { close: async () => {} },
    readResource: async (_group, _message, resource) => ({ text: `附件正文:${resource.resourceId}`, complete: true }),
    coordinatorSessions: { close: async () => {}, async run(args) {
      await args.onSessionBound()
      const decisions = await inspect(args, { store, receive, command })
      await args.onCandidate(decisions ?? { decisions: args.input.sources.map(source => ({ runId: source.runId, reason: '历史上下文验证', units: [] })) })
      return { status: 'submitted' }
    } } })
  return { service, store, receive, command }
}

test('历史超过200条仍能逐页补读，去重编辑版本并保留同时间戳前文和引用身份', async t => {
  const legacy = Array.from({ length: 40 }, (_, i) => ({ messageId: `legacy-${i}`, text: `旧历史${i}`, senderOpenDingTalkId: 'legacy-owner',
    occurredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), ...(i === 0 ? { resourceRefs: [{ type: 'fileId', resourceId: 'legacy-file', name: 'old.xlsx' }] } : {}) }))
  const legacyRef = `dws:${executionDigest(['', 'group', 'legacy-0'])}`
  let checked = false
  const f = await historyFixture(t, async ({ input, readTools }) => {
    const source = input.sources.find(s => s.runId === 'current')
    if (!source) return
    checked = true
    assert.equal(source.context.history.length, 30)
    assert.ok(source.context.omissions.some(o => o.reason === 'history_window' && o.omittedCount > 200))
    assert.ok(source.context.history.some(s => s.sourceKey === 'same-time'))
    assert.deepEqual(source.context.history.filter(s => s.sourceKey === 'edited').map(s => s.sourceVersion), [2])
    assert.equal(source.context.quotes[0].actorId, 'quoted-owner')
    assert.equal(source.context.quotes[0].occurredAt, '2026-10-02T00:00:00.000Z')
    const read = readTools.find(tool => tool.name === 'group_coordinator_read_material')
    const history = readTools.find(tool => tool.name === 'group_coordinator_read_history')
    await assert.rejects(read.execute({ runId: source.runId, resourceRef: legacyRef }), { code: 'GROUP_COORDINATOR_MATERIAL_FORBIDDEN' })
    await assert.rejects(history.execute({ runId: 'outside', cursor: null }), { code: 'GROUP_COORDINATOR_SOURCE_FORBIDDEN' })
    const all = [...source.context.history]
    let cursor = source.context.historyCursor
    while (cursor) {
      const page = await history.execute({ runId: source.runId, cursor })
      assert.equal(page.authority, 'historical_context_only')
      all.push(...page.messages); cursor = page.nextCursor
    }
    assert.equal(new Set(all.map(item => item.sourceKey)).size, all.length)
    assert.ok(all.some(item => item.sourceKey === 'history-0'))
    assert.ok(all.some(item => item.sourceKey === legacyRef && item.actorId === 'legacy-owner'))
    assert.ok(!all.some(item => ['other-group', 'future', 'after-watermark'].includes(item.sourceKey)))
    const old = await read.execute({ runId: source.runId, resourceRef: legacyRef })
    assert.equal(old.ready, true); assert.match(old.data.resources[0].text, /附件正文:legacy-file/u)
    const attachment = await read.execute({ runId: source.runId, resourceRef: 'legacy-file' })
    assert.equal(attachment.ready, true)
    await assert.rejects(read.execute({ runId: source.runId, resourceRef: 'other-group' }), { code: 'GROUP_COORDINATOR_MATERIAL_FORBIDDEN' })
    await assert.rejects(read.execute({ runId: source.runId, resourceRef: 'after-watermark' }), { code: 'GROUP_COORDINATOR_MATERIAL_FORBIDDEN' })
    const refreshed = await readTools.find(tool => tool.name === 'group_coordinator_read_tasks').execute({})
    assert.equal(refreshed.sources.find(item => item.runId === source.runId).context.history.length, 30)
    await assert.rejects(read.execute({ runId: source.runId, resourceRef: legacyRef }), { code: 'GROUP_COORDINATOR_MATERIAL_FORBIDDEN' })
  }, legacy)
  for (let i = 0; i < 230; i++) await f.receive(`history-${i}`, { context: { occurredAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() } })
  await f.receive('edit-v1', { sourceKey: 'edited' })
  await f.receive('edit-v2', { sourceKey: 'edited', sourceVersion: 2 })
  await f.receive('same-time')
  await f.receive('quoted', { actorId: 'quoted-owner' })
  await f.receive('other-group', { conversationId: 'other' })
  await f.receive('future', { context: { occurredAt: '2026-10-03T00:00:00.000Z' } })
  await f.receive('current', { quiet: false, body: '按前面的要求继续', context: { occurredAt: '2026-10-02T00:00:00.000Z', quoteRefs: [{ sourceKey: 'quoted' }], attachments: [] } })
  await f.receive('after-watermark')
  await f.service.messages.process('current')
  assert.equal(checked, true)
})

test('历史来源在工具读取后被编辑，旧游标与本轮提交均拒绝', async t => {
  let checks = 0
  const f = await historyFixture(t, async args => {
    const source = args.input.sources.find(s => s.runId === 'current')
    if (!source || checks++) return
    const history = args.readTools.find(tool => tool.name === 'group_coordinator_read_history')
    await history.execute({ runId: source.runId, cursor: null })
    await f.receive('changed-v2', { sourceKey: 'changed', sourceVersion: 2 })
    await assert.rejects(history.execute({ runId: source.runId, cursor: source.context.historyCursor }), { code: 'GROUP_COORDINATOR_SOURCE_STALE' })
    await assert.rejects(args.onCandidate({ decisions: [{ runId: source.runId, reason: '过期历史', units: [] }] }), { code: 'GROUP_COORDINATOR_SOURCE_STALE' })
  })
  await f.receive('changed-v1', { sourceKey: 'changed' })
  await f.receive('current', { quiet: false, body: '继续' })
  await f.service.messages.process('current')
  assert.ok(checks >= 1)
})

test('窗口外legacy来源经分页登记后可作为澄清已核查依据', async t => {
  const legacy = Array.from({ length: 40 }, (_, i) => ({ messageId: `legacy-${i}`, text: `历史${i}`, senderOpenDingTalkId: 'owner', occurredAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }))
  const f = await historyFixture(t, async ({ input, readTools }) => {
    const source = input.sources.find(s => s.runId === 'clarify')
    if (!source) return
    const page = await readTools.find(tool => tool.name === 'group_coordinator_read_history').execute({ runId: source.runId, cursor: source.context.historyCursor })
    const old = page.messages[0]
    return { decisions: [{ runId: source.runId, reason: '历史未指定表名', units: [{ spans: [{ start: 0, end: source.body.length }], goalText: source.body,
      binding: { disposition: 'new', candidateId: null }, intent: { kind: 'needs_clarification', reason: 'required_parameter_missing',
        question: '查询哪张表？', missingField: '表名', blockedAction: '查询表', checkedSourceRefs: [source.sourceKey, old.sourceKey] } }] }] }
  }, legacy)
  await f.receive('clarify', { quiet: false, body: '查询之前说的表' })
  await f.service.messages.process('clarify')
  assert.equal((await f.service.messages.state('clarify')).requests.filter(request => request.status === 'pending').length, 1)
})

test('legacy缺少时间和来源序列时明确报告省略，不能把无法证明早于当前消息的内容当作前文', async t => {
  const legacy = [{ messageId: 'unknown-order', text: '未知先后的内容' }]
  let checked = false
  const f = await historyFixture(t, async ({ input }) => {
    const source = input.sources.find(s => s.runId === 'current')
    checked = true
    assert.deepEqual(source.context.history, [])
    assert.ok(source.context.omissions.some(item => item.reason === 'history_order_unknown' && item.omittedCount === 1))
  }, legacy)
  await f.receive('current', { quiet: false, body: '继续前文' })
  await f.service.messages.process('current')
  assert.equal(checked, true)
})

test('历史在最后异步校验后编辑，提交事务拒绝旧决定且不落任何命令', async t => {
  let armed = false, rejected = false, submissions = 0
  const f = await historyFixture(t, async args => {
    const source = args.input.sources.find(item => item.runId === 'current')
    if (!source || rejected) return
    armed = true
    const decision = { decisions: [{ runId: source.runId, reason: '将当前补充并入话题', units: [{ spans: [{ start: 0, end: source.body.length }], goalText: source.body,
      binding: { disposition: 'conversation', candidateId: null }, intent: { kind: 'intent',
        actions: [{ intent: 'fact', arguments: { kind: 'fact', text: source.body }, dependsOn: [] }],
        constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' } }] }] }
    await assert.rejects(args.onCandidate(decision), { code: 'GROUP_COORDINATOR_SOURCE_STALE' })
    rejected = true
    const state = await f.store.query({ kind: 'message.run', runId: source.runId })
    assert.equal(state.commands.length, 0)
    assert.equal(state.units.length, 0)
  }, [], async (value, store) => {
    if (value.kind !== 'message.coordinator.commit' || !armed) return
    armed = false; submissions++
    assert.ok(value.args.historySourceVersions.some(ref => ref.sourceKey === 'race-source' && ref.sourceVersion === 1))
    // 此处已经生成提交参数并完成最后validateHistory，下一步才进入真实SQLite事务。
    await store.command({ id: 'history-race-edit', kind: 'message.receive', args: {
      runId: 'race-source-v2', sourceKey: 'race-source', sourceVersion: 2, conversationId: 'group', actorId: 'owner', body: '先别管它',
      context: { occurredAt: '2026-10-02T00:00:00.000Z', attachments: [], quoteRefs: [] } } })
    await store.command({ id: 'history-race-quiet', kind: 'message.quiet', args: { runId: 'race-source-v2', body: '先别管它' } })
  })
  await f.receive('race-source-v1', { sourceKey: 'race-source' })
  await f.receive('current', { quiet: false, body: '补充前面的约束' })
  await f.service.messages.process('current')
  assert.equal(submissions, 1)
  assert.equal(rejected, true)
  assert.equal((await f.service.messages.state('current')).commands.length, 0)
})

test('初始30条内legacy附件无需先分页即可按登记身份读取真实正文', async t => {
  const legacy = [{ messageId: 'legacy-attached', text: '参考表格', occurredAt: '2026-10-01T00:00:00.000Z', senderOpenDingTalkId: 'owner',
    resourceRefs: [{ type: 'fileId', resourceId: 'initial-file', name: 'initial.xlsx' }] }]
  let read = false
  const f = await historyFixture(t, async ({ input, readTools }) => {
    const source = input.sources.find(item => item.runId === 'current')
    const ref = source.context.history[0].attachments[0].resourceRef
    const result = await readTools.find(tool => tool.name === 'group_coordinator_read_material').execute({ runId: source.runId, resourceRef: ref })
    assert.equal(result.ready, true)
    assert.match(result.data.resources[0].text, /附件正文:initial-file/u)
    read = true
  }, legacy)
  await f.receive('current', { quiet: false, body: '按表格继续' })
  await f.service.messages.process('current')
  assert.equal(read, true)
})
