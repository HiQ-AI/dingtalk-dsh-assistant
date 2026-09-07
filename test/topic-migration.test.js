import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { residentDomainSpec, openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { planTopicMigration, migrateTopicStorage } from '../scripts/migrate-topic-storage.js'
import { taskResultSchema } from '../packages/dingtalk-dsh-assistant/task-result.js'
import { fingerprint } from '../packages/dingtalk-dsh-assistant/topic-model.js'

const at = '2026-09-07T00:00:00.000Z'
function fixture() {
  const task = { taskId: 'task-old', groupId: 'g', sourceMessageId: 'm', title: '历史任务', objective: '验证历史任务', state: 'completed', childSessionId: 'session-task-old',
    requesterName: '甲', requesterOpenDingTalkId: 'od-a', triggerHistory: [{ sourceMessageId: 'm' }], messageHistory: [{ messageId: 'm', text: '原文', occurredAt: at }],
    relatedContexts: ['人工补充内容'], runSequence: 1, result: { status: 'completed', summary: '已完成', workType: 'non-development', evidence: ['已验证'], artifacts: [] }, createdAt: at, updatedAt: at }
  return { unit: { name: 'dingtalk_dsh_assistant', version: 6 }, global: null, tables: {
    groups: { g: { groupId: 'g', responsibility: '', residentSessionId: 'session-g', nextSequence: 2,
      messages: [{ messageId: 'm', sequence: 1, text: '原文', occurredAt: at, senderName: '甲', senderOpenDingTalkId: 'od-a', agentDeliveryStatus: 'delivered' }],
      outbox: [{ outboundId: 'outbound-old', sourceMessageId: 'task-result:task-old:completed', text: '已完成', status: 'sent', deliveredMessageId: 'channel-old' }] } },
    scheduler: { runtime: { tasks: [] } }, tasks: { 'task-old': task }, alerts: {}, activities: {},
  } }
}

test('v6迁移保留执行状态和渠道回执、Topic基线确定且移除所有Task消息副本', () => {
  const source = fixture(), first = planTopicMigration(source), again = planTopicMigration(source)
  assert.equal(first.report.ready, true)
  assert.deepEqual(first, again)
  assert.equal(source.unit.version, 6)
  const task = first.document.tables.tasks['task-old'], group = first.document.tables.groups.g
  assert.equal(task.result.inputVersion, 1)
  assert.equal(task.state, 'completed')
  for (const field of ['sourceMessageId', 'triggerHistory', 'messageHistory', 'relatedContexts']) assert.equal(field in task, false)
  assert.equal(group.topics[0].migrationBaseline, true)
  assert.equal(group.messages[1].sourceKind, 'internal')
  assert.equal(group.messages[1].senderOpenDingTalkId, undefined)
  assert.equal(group.outbox[0].outboundId, 'outbound-old')
  assert.equal(group.outbox[0].deliveredMessageId, 'channel-old')
  assert.equal(group.outbox[0].status, 'sent')
})

test('来源缺失、正文冲突和未对账提交失败明确阻止迁移', () => {
  for (const [change, expected] of [
    [(source) => { source.tables.tasks['task-old'].triggerHistory.push({ sourceMessageId: 'missing' }) }, 'missing-message'],
    [(source) => { source.tables.tasks['task-old'].messageHistory[0].text = '冲突正文' }, 'conflicting-message-copy'],
    [(source) => { source.tables.groups.g.messages[0].agentDeliveryStatus = 'decision-commit-failed' }, 'unreconciled-commit'],
  ]) {
    const source = fixture(); change(source)
    const plan = planTopicMigration(source)
    assert.equal(plan.report.ready, false)
    assert.ok(plan.report.issues.some((issue) => issue.type === expected))
    assert.equal(JSON.stringify(plan.report).includes('原文'), false)
    assert.equal(JSON.stringify(plan.report).includes('冲突正文'), false)
  }
})

test('仅Task快照存在的历史原文迁回Message，Web输入没有伪造钉钉身份', () => {
  const source = fixture()
  source.tables.groups.g.messages = []
  const task = source.tables.tasks['task-old']
  const recovered = planTopicMigration(source)
  assert.equal(recovered.report.ready, true)
  assert.equal(recovered.document.tables.groups.g.messages[0].sourceKind, 'migration')
  task.sourceMessageId = 'web:manual'; task.triggerHistory = []; task.messageHistory = []; task.relatedContexts = []
  const web = planTopicMigration(source)
  assert.equal(web.report.ready, true)
  assert.equal(web.document.tables.groups.g.messages[0].sourceKind, 'web')
  assert.equal(web.document.tables.groups.g.messages[0].senderOpenDingTalkId, undefined)
})

test('真实SDK JSON迁移check零写、独立目标读回、重复运行与旧版本回退可读', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-topic-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'v6'), targetRoot = join(root, 'v7')
  await mkdir(sourceRoot)
  const source = join(sourceRoot, 'dingtalk_dsh_assistant.json'), target = join(targetRoot, 'dingtalk_dsh_assistant.json')
  await writeFile(source, JSON.stringify(fixture(), null, 2))
  const original = await readFile(source, 'utf8')
  const checked = await migrateTopicStorage({ source, target, check: true })
  assert.equal(checked.ready, true)
  await assert.rejects(stat(targetRoot), { code: 'ENOENT' })
  const migrated = await migrateTopicStorage({ source, target })
  assert.equal(migrated.verified, true)
  assert.equal((await migrateTopicStorage({ source, target })).written, false)
  assert.equal(await readFile(source, 'utf8'), original)
  const backend = new JsonStorageBackend(targetRoot)
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => backend } } }, { backend: 'json' })
  const store = await openResidentStore(facility)
  assert.equal(store.getTask('task-old').topicRefs.length, 1)
  assert.equal(store.getGroup('g').outbox[0].deliveredMessageId, 'channel-old')
  assert.equal(store.getGroup('g').outbox[0].resultFingerprint, fingerprint(taskResultSchema.parse(store.getTask('task-old').result)))
  await store.close(); await backend.close()
  const oldBackend = new JsonStorageBackend(sourceRoot)
  await assert.rejects(oldBackend.kv.open({ name: residentDomainSpec.name, version: 7, tables: Object.keys(residentDomainSpec.tables), hasGlobal: false }), { code: 'version-mismatch' })
  const old = await oldBackend.kv.open({ name: residentDomainSpec.name, version: 6, tables: Object.keys(residentDomainSpec.tables), hasGlobal: false })
  assert.equal((await old.loadAll()).tables.tasks['task-old'].sourceMessageId, 'm')
  await old.close(); await oldBackend.close()
})

test('已发v6等待通知匹配当前结果时补指纹并保留原业务键，新问题不会命中旧回执', () => {
  const source = fixture(), task = source.tables.tasks['task-old'], group = source.tables.groups.g
  task.state = 'waiting'
  task.result = { status: 'waiting', waitingKind: 'information', summary: '还缺参数', evidence: [], artifacts: [], waitingReason: '需要补充参数', questions: ['导出哪个月份？'] }
  const key = `task-result:task-old:waiting:${createHash('sha256').update(task.result.waitingReason).digest('hex').slice(0, 16)}`
  group.outbox = [{ outboundId: 'sent-question', sourceMessageId: key, status: 'sent', deliveredMessageId: 'channel-question', text: '导出哪个月份？' }]
  const migrated = planTopicMigration(source)
  assert.equal(migrated.report.ready, true)
  const result = taskResultSchema.parse(migrated.document.tables.tasks['task-old'].result)
  const receipt = migrated.document.tables.groups.g.outbox.find((outbound) => outbound.taskIds?.includes(task.taskId) && outbound.resultFingerprint === fingerprint(result))
  assert.ok(receipt)
  assert.equal(receipt.sourceMessageId, key)
  assert.equal(receipt.outboundId, 'sent-question')
  assert.equal(receipt.deliveredMessageId, 'channel-question')
  assert.equal(receipt.status, 'sent')
  const next = taskResultSchema.parse({ ...result, questions: ['导出哪些部门？'] })
  assert.notEqual(fingerprint(next), receipt.resultFingerprint)
  assert.equal(migrated.document.tables.groups.g.outbox.some((outbound) => outbound.resultFingerprint === fingerprint(next)), false)
})

test('不匹配当前结果的旧通知和不存在通知的任务不生成猜测指纹', () => {
  const source = fixture(), task = source.tables.tasks['task-old'], group = source.tables.groups.g
  task.state = 'waiting'
  task.result = { status: 'waiting', waitingKind: 'information', summary: '新问题', evidence: [], artifacts: [], waitingReason: '新的原因', questions: ['新问题是什么？'] }
  group.outbox.push({ outboundId: 'old-wait', sourceMessageId: 'task-result:task-old:waiting:not-matching-current-reason', text: '旧问题', status: 'sent' })
  const migrated = planTopicMigration(source)
  assert.equal(migrated.report.ready, true)
  assert.equal(migrated.document.tables.groups.g.outbox.every((outbound) => outbound.resultFingerprint === undefined), true)
  group.outbox = []
  const absent = planTopicMigration(source)
  assert.deepEqual(absent.document.tables.groups.g.outbox, [])
})
