import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planWorkflowMigration, migrateWorkflowStorage } from '../scripts/migrate-workflow-storage.mjs'
import { residentDomainSpec as v8 } from '../packages/dingtalk-dsh-assistant/storage-v8-schema.js'
import { checkResidentStorage } from '../scripts/check-resident-storage.mjs'

const at = '2026-09-22T00:00:00Z'
function fixture(state = 'running') {
  return { unit: { name: v8.name, version: 8 }, global: null, tables: {
    groups: { g: { groupId: 'g', responsibility: '', residentSessionId: 'resident-g', nextSequence: 1, messages: [], outbox: [], routingRevision: 0, topics: [], routeHistory: [], taskReservations: [], coordinationRequests: { old: { status: 'pending', attempt: 1 } } } },
    tasks: { t: { taskId: 't', groupId: 'g', topicRefs: [{ topicId: 'topic', revision: 1 }], inputVersion: 1, runSequence: 1, objective: '核验', acceptanceCriteria: ['验收'], stageTasks: ['执行'], state, childSessionId: 'old-leaf', createdAt: at, updatedAt: at } },
    scheduler: { runtime: { tasks: [] } }, alerts: {}, activities: {},
  } }
}

test('迁移活动任务隔离旧会话并保存原事实，候选计划不得冒充确认', () => {
  const source = fixture(), before = structuredClone(source), result = planWorkflowMigration(source)
  assert.equal(result.report.ready, true)
  assert.deepEqual(source, before)
  assert.deepEqual(result, planWorkflowMigration(source))
  const task = result.document.tables.tasks.t
  assert.equal(task.state, 'waiting'); assert.equal(task.waitingKind, 'system')
  assert.equal(task.inputVersion, 2); assert.notEqual(task.childSessionId, 'old-leaf')
  assert.equal(task.migrationReview.status, 'required'); assert.equal(task.migrationReview.candidate.status, 'historical-unverified')
  assert.equal(task.plan, undefined)
  assert.deepEqual(task.executionEvents.at(-1).snapshot, before.tables.tasks.t)
  assert.equal(result.document.tables.groups.g.coordinationRequests.old.status, 'superseded')
  assert.equal(checkResidentStorage(result.document).ok, true)
})

test('历史终态仅有一致版本的完成证据才算成功，文本不能证明取消', () => {
  const source = fixture('completed'), task = source.tables.tasks.t
  task.completion = '已取消：历史文字'
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'legacy-unknown')
  task.result = { status: 'completed', inputVersion: 1, runSequence: 1, summary: '完成', evidence: ['结果'] }
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'legacy-unknown')
  task.executionEvents = [{ kind: 'task-completed', inputVersion: 1, runSequence: 1, at }]
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'succeeded')
  task.executionEvents[0].inputVersion = 2
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'legacy-unknown')
  task.executionEvents = [{ kind: 'task-cancelled', runSequence: 1, at }]
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'cancelled')
})

test('未知表、剥字段及未结投递不允许迁移写入', () => {
  for (const mutate of [
    source => { source.tables.unknown = {} },
    source => { source.tables.tasks.t.unrecognized = '不可丢弃' },
    source => { source.tables.groups.g.outbox.push({ outboundId: 'o', sourceMessageId: 'm', text: '尚未对账', status: 'pending' }) },
    source => { source.tables.groups.g.taskReservations.push({ taskId: 't' }) },
  ]) { const source = fixture(); mutate(source); assert.equal(planWorkflowMigration(source).report.ready, false) }
})

test('已应用取消操作必须匹配当前轮次和版本，旧轮取消不能污染重开结果', () => {
  const source = fixture('completed'), task = source.tables.tasks.t
  task.inputVersion = 2; task.appliedOperations = ['cancel-op']
  const action = { kind: 'task-cancel', taskId: 't', inputVersion: 1, runSequence: 1 }
  source.tables.groups.g.topics.push({ topicId: 'topic', groupId: 'g', title: '事项', revision: 1, processedRevision: 1, status: 'closed', summary: '', summaryRevision: 0, openQuestions: [], entries: [], createdAt: at, updatedAt: at,
    decisions: [{ decisionId: 'cancel', revision: 1, decision: { actions: [action] }, fingerprint: 'f', status: 'completed', operations: [{ actionIndex: 0, operationId: 'cancel-op', status: 'applied' }], outboundId: 'outbound', createdAt: at, updatedAt: at }] })
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'cancelled')
  task.runSequence = 2
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'legacy-unknown')
  task.runSequence = 1; task.inputVersion = 3
  assert.equal(planWorkflowMigration(source).document.tables.tasks.t.outcome, 'legacy-unknown')
})

test('真实 SDK v8→v9：check 零写、源不变、独立读回、拒绝覆盖与错误版本', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'v8'))
  const source = join(root, 'v8', `${v8.name}.json`), target = join(root, 'v9', `${v8.name}.json`)
  await writeFile(source, JSON.stringify(fixture()))
  const before = await readFile(source, 'utf8')
  assert.equal((await migrateWorkflowStorage({ source, target, check: true })).ready, true)
  await assert.rejects(stat(join(root, 'v9')), { code: 'ENOENT' })
  const result = await migrateWorkflowStorage({ source, target })
  assert.equal(result.verified, true); assert.equal(result.sourceUnchanged, true)
  assert.equal(await readFile(source, 'utf8'), before)
  assert.equal(checkResidentStorage(JSON.parse(await readFile(target, 'utf8'))).ok, true)
  await assert.rejects(migrateWorkflowStorage({ source, target }), /target_exists/)
  await assert.rejects(migrateWorkflowStorage({ source, target: source }), /independent/)
  assert.throws(() => planWorkflowMigration({ ...fixture(), unit: { name: v8.name, version: 9 } }), /must_be_v8/)
})
