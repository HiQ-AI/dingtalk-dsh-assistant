import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskSheetSnapshot, createTaskSheetSyncService, snapshotToCsv, TASK_SHEET_SYNC_INTERVAL_MS } from '../packages/dingtalk-dsh-assistant/task-sheet-sync.js'

const task = (patch = {}) => ({ taskId: 'task-1', groupId: 'g1', inputVersion: 1, runSequence: 1, title: '核验任务', objective: '完成核验', state: 'running', requesterName: '张三', createdAt: '2026-09-14T01:00:00Z', updatedAt: '2026-09-14T02:00:00Z', runStartedAt: '2026-09-14T01:10:00Z', stageTasks: ['准备', '验证'], checkpoints: [{ checkpointId: 'p1', kind: 'plan-confirmed', inputVersion: 1, runSequence: 1, coordinatorDecision: 'acknowledge', remainingItems: ['准备', '验证'], summary: '计划确认' }, { checkpointId: 'p2', kind: 'stage-completed', inputVersion: 1, runSequence: 1, coordinatorDecision: 'acknowledge', remainingItems: ['验证'], summary: '准备完成' }], ...patch })

test('表格快照只含未归档任务并按看板状态和更新时间排序', () => {
  const snapshot = buildTaskSheetSnapshot({ tasks: [task(), task({ taskId: 'queued', state: 'queued', title: '=危险标题' }), task({ taskId: 'done', state: 'completed', updatedAt: '2026-09-14T03:00:00Z', result: { inputVersion: 1, runSequence: 1, status: 'completed', summary: '完成' } }), task({ taskId: 'archived', archivedAt: '2026-09-14T04:00:00Z' })], groups: [{ groupId: 'g1', name: '研发群' }], snapshotAt: '2026-09-14T04:00:00Z', batchId: 'batch-1' })
  assert.equal(snapshot.taskCount, 3)
  assert.deepEqual(snapshot.values.slice(2).map((row) => row[13]), ['queued', 'task-1', 'done'])
  assert.deepEqual(snapshot.values[3].slice(0, 8), ['核验任务', '研发群', '张三', '执行中', '验证', '1 / 2', '准备完成', ''])
  assert.match(snapshotToCsv(snapshot), /'=危险标题/)
})

test('同步使用一次严格事务覆盖完整工作表并独立回读', async () => {
  const statuses = []
  const store = {
    config: { enabled: true, documentUrl: 'https://alidocs.dingtalk.com/i/nodes/node', nodeId: 'node', documentName: '任务表', sheetId: 'sheet', sheetTitle: 'Sheet1', intervalMs: TASK_SHEET_SYNC_INTERVAL_MS },
    getTaskSheetSyncConfig() { return this.config }, getTaskSheetSyncStatus: () => statuses.at(-1) ?? { state: 'idle' }, setTaskSheetSyncStatus: async (value) => { statuses.push({ ...(statuses.at(-1) ?? {}), ...value }); return statuses.at(-1) },
    listTasks: () => [task()], listGroups: () => [{ groupId: 'g1', name: '研发群' }],
  }
  let csv
  const calls = []
  const runner = { async run(args) {
    calls.push(args)
    if (args[1] === 'info') return { exitCode: 0, stdout: JSON.stringify({ id: 'sheet', rowCount: 200, columnCount: 40, mergedRanges: [] }), stderr: '' }
    if (args[1] === 'batch-update') { const operations = JSON.parse(args[args.indexOf('--operations') + 1]); csv = operations[1].input.csv; return { exitCode: 0, stdout: JSON.stringify({ success: true, results: [{ success: true }, { success: true }] }), stderr: '' } }
    if (args[1] === '+read') {
      const rows = csv.split('\r\n').map((line) => line.split(',').map((value) => ({ value: value.replace(/^'(?=[=+\-@])/, '') })))
      while (rows.length < 200) rows.push(Array(14).fill(0).map(() => ({ value: '' })))
      return { exitCode: 0, stdout: JSON.stringify({ data: { complete: true, hasMore: false, cells: rows } }), stderr: '' }
    }
    throw new Error(`unexpected:${args.join(' ')}`)
  } }
  const service = createTaskSheetSyncService({ store, runner, now: () => new Date('2026-09-14T04:00:00Z') })
  const result = await service.run()
  assert.equal(result.state, 'success')
  assert.equal(result.taskCount, 1)
  const write = calls.find((args) => args[1] === 'batch-update')
  const operations = JSON.parse(write[write.indexOf('--operations') + 1])
  assert.deepEqual(operations.map((item) => item.toolName), ['range clear', 'csv-put'])
  assert.equal(operations[0].input.range, 'A1:N200')
  assert.ok(write.includes('--yes'))
  assert.equal(statuses.at(-1).state, 'success')
})

test('并发触发单飞且定时周期固定为三分钟', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const store = { getTaskSheetSyncConfig: () => ({ enabled: true, nodeId: 'node', sheetId: 'sheet' }), getTaskSheetSyncStatus: () => ({ state: 'idle' }), setTaskSheetSyncStatus: async () => undefined, listTasks: () => [], listGroups: () => [] }
  const runner = { async run(args) { if (args[1] === 'info') { await pending; return { exitCode: 1, stdout: '', stderr: 'stop' } } throw new Error('unexpected') } }
  let interval
  const service = createTaskSheetSyncService({ store, runner, setIntervalImpl: (_callback, value) => { interval = value; return { unref() {} } }, clearIntervalImpl: () => undefined, logger: { warn() {} } })
  service.schedule()
  const skipped = await service.run()
  assert.deepEqual(skipped, { state: 'skipped', reason: 'task_sheet_sync_already_running' })
  assert.equal(interval, 180000)
  release()
})
