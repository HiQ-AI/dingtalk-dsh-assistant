import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkResidentStorage } from '../scripts/check-resident-storage.mjs'

const task = () => ({ taskId: 'task1', groupId: 'group1', topicRefs: [{ topicId: 'topic1', revision: 1 }], inputVersion: 1, objective: 'fixture', state: 'running', childSessionId: 'session1', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' })
const document = () => ({ unit: { name: 'dingtalk_dsh_assistant', version: 7 }, global: null, tables: { tasks: { task1: task() }, groups: {}, scheduler: {}, alerts: {}, activities: {} } })

test('v7旧记录和新增扩展字段都通过，预检不改输入', () => {
  const legacy = document()
  const before = structuredClone(legacy)
  assert.equal(checkResidentStorage(legacy).ok, true)
  assert.deepEqual(legacy, before)
  const current = document()
  current.tables.tasks.task1.activityProjection = { lastSyncedAt: '2026-09-10T00:00:00Z', truncated: true, sessions: { session1: { lastSeq: 501 } } }
  current.tables.tasks.task1.stagePlan = [{ stageId: 'stage1', title: '核验' }]
  current.tables.tasks.task1.executionEvents = [{ kind: 'task-report-received', submissionId: 'report1' }, { kind: 'task-report-notified', submissionId: 'report1' }]
  const result = checkResidentStorage(current)
  assert.equal(result.ok, true)
  assert.equal(result.strippedFields, 0)
  assert.deepEqual(result.extensions, { activityProjection: 1, stagePlan: 1, coordinationRequests: 0, reportEvents: 2 })
})

test('Schema剥字段或类型不合法必须失败，结果只含计数不含业务正文', () => {
  const unknown = document()
  unknown.tables.tasks.task1.credential = 'sensitive-fixture'
  assert.equal(checkResidentStorage(unknown).ok, false)
  assert.equal(checkResidentStorage(unknown).strippedFields, 1)
  unknown.tables.tasks.task1.inputVersion = 'sensitive-fixture'
  const invalid = checkResidentStorage(unknown)
  assert.equal(invalid.invalidRecords, 1)
  assert.equal(JSON.stringify(invalid).includes('sensitive-fixture'), false)
})

test('CLI要求--check，实跑前后文件字节相同', t => {
  const directory = mkdtempSync(join(tmpdir(), 'resident-storage-check-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, 'input.json')
  const bytes = JSON.stringify(document())
  writeFileSync(source, bytes)
  const script = fileURLToPath(new URL('../scripts/check-resident-storage.mjs', import.meta.url))
  const denied = spawnSync(process.execPath, [script, '--source', source], { encoding: 'utf8' })
  assert.equal(denied.status, 1)
  const accepted = spawnSync(process.execPath, [script, '--check', '--source', source], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).ok, true)
  assert.equal(readFileSync(source, 'utf8'), bytes)
  assert.equal(accepted.stdout.includes(source), false)
})
