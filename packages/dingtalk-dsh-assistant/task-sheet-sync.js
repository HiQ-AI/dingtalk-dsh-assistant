import { randomUUID } from 'node:crypto'
import { acceptedTaskStageOutputs, taskOutcomeLabel, taskBoardProgress } from './task-progress.js'

export const TASK_SHEET_SYNC_INTERVAL_MS = 180_000
export const TASK_SHEET_COLUMNS = ['任务名称', '来源群', '发起人', '当前状态', '当前阶段', '已完成 / 总阶段', '最近进展', '等待原因', '执行结果', '创建时间', '更新时间', '本轮开始时间', '执行轮次', '任务 ID']

const stateOrder = new Map(['queued', 'running', 'waiting', 'completed'].map((state, index) => [state, index]))
const stateLabel = { queued: '待执行', running: '执行中', waiting: '等待中', completed: '已完成' }
const limit = (value, maximum = 240) => {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim()
  return text.length <= maximum ? text : `${text.slice(0, maximum - 4)}…已截断`
}
const current = (task, value) => value && value.inputVersion === task.inputVersion && value.runSequence === (task.runSequence ?? 1)
const formatTime = (value) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : ''

export function taskStageProjection(task) {
  if (task.engine === 'workflow-v2') {
    const { stages } = taskBoardProgress(task)
    return { currentStage: task.state === 'completed' ? '' : limit(stages.find(stage => !stage.completed)?.title), progress: `${stages.filter(stage => stage.completed).length} / ${stages.length}`, recentProgress: limit(stages.findLast(stage => stage.completed)?.title) }
  }
  if (task.plan) {
    const completedIds = new Set(acceptedTaskStageOutputs(task).map(checkpoint => checkpoint.stageOutput.stageId))
    const stages = task.plan.stages
    return { currentStage: task.state === 'completed' ? '' : limit(stages.find(stage => !completedIds.has(stage.stageId))?.title), progress: `${completedIds.size} / ${stages.length}`, recentProgress: limit((task.checkpoints ?? []).filter(item => current(task, item)).at(-1)?.summary) }
  }
  const checkpoints = (task.checkpoints ?? []).filter((item) => current(task, item))
  const planIndex = checkpoints.findLastIndex((item) => item.kind === 'plan-confirmed' && ['acknowledge', 'guidance'].includes(item.coordinatorDecision))
  if (planIndex < 0) return { currentStage: '', progress: '未制定计划', recentProgress: limit(checkpoints.at(-1)?.summary) }
  const plan = checkpoints[planIndex]
  const stages = plan.remainingItems?.length ? plan.remainingItems : (task.stageTasks ?? [])
  const latest = checkpoints.at(-1)
  const remaining = latest?.remainingItems ?? stages
  const remainingSet = new Set(remaining.filter((item) => stages.includes(item)))
  const completed = stages.filter((item) => !remainingSet.has(item)).length
  return {
    currentStage: task.state === 'completed' ? '' : limit(stages.find((item) => remainingSet.has(item))),
    progress: stages.length ? `${completed} / ${stages.length}` : '未制定计划',
    recentProgress: limit(latest?.summary),
  }
}

export function buildTaskSheetSnapshot({ tasks, groups, snapshotAt = new Date().toISOString(), batchId = randomUUID() }) {
  const groupsById = new Map(groups.map((group) => [group.groupId, group]))
  const selected = tasks.filter((task) => !task.archivedAt).sort((left, right) =>
    (stateOrder.get(left.state) ?? 99) - (stateOrder.get(right.state) ?? 99)
      || String(right.updatedAt).localeCompare(String(left.updatedAt))
      || left.taskId.localeCompare(right.taskId))
  const rows = selected.map((task) => {
    const stage = taskStageProjection(task)
    const result = task.engine === 'workflow-v2' ? { summary: task.result } : current(task, task.result) ? task.result : undefined
    return [
      limit(task.title || task.objective, 160), limit(groupsById.get(task.groupId)?.name || task.groupId, 120), limit(task.requesterName, 80), taskOutcomeLabel(task) ?? stateLabel[task.state] ?? task.state,
      stage.currentStage, stage.progress, stage.recentProgress, limit(task.waitingReason), limit(result?.summary), formatTime(task.createdAt), formatTime(task.updatedAt), formatTime(task.runStartedAt), String(task.runSequence ?? 1), task.taskId,
    ]
  })
  const meta = [`数据截至 ${formatTime(snapshotAt)}｜任务 ${rows.length}｜每 3 分钟全量同步｜批次 ${batchId}`, ...Array(TASK_SHEET_COLUMNS.length - 1).fill('')]
  return { snapshotAt, batchId, taskCount: rows.length, values: [meta, TASK_SHEET_COLUMNS, ...rows] }
}

function csvCell(value) {
  let text = String(value ?? '')
  if (text.startsWith('=') || text.startsWith('+') || text.startsWith('-') || text.startsWith('@')) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
export const snapshotToCsv = (snapshot) => snapshot.values.map((row) => row.map(csvCell).join(',')).join('\r\n')

function parseJson(result, operation) {
  if (result.exitCode !== 0) throw new Error(result.stderr || `task_sheet_${operation}_exit_${result.exitCode}`)
  try { return JSON.parse(result.stdout) } catch (cause) { throw new Error(`task_sheet_${operation}_invalid_json`, { cause }) }
}
const profileArgs = (profile) => profile ? ['--profile', profile] : []
const cellValues = (data) => data?.data?.cells?.map((row) => row.map((cell) => String(cell?.value ?? ''))) ?? []

export function createTaskSheetSyncService({ store, runner, profile, intervalMs = TASK_SHEET_SYNC_INTERVAL_MS, now = () => new Date(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = console }) {
  let timer
  let running

  async function inspect(node) {
    const resource = parseJson(await runner.run(['drive', 'info', '--node', node, ...profileArgs(profile), '--format', 'json']), 'resource')
    const item = resource.result ?? resource.data ?? resource
    if (item.contentType !== 'ALIDOC' || item.extension !== 'axls') throw new Error('task_sheet_resource_must_be_axls')
    const sheets = parseJson(await runner.run(['sheet', '+list-sheets', '--node', item.nodeId, ...profileArgs(profile), '--format', 'json']), 'sheets')
    return { nodeId: item.nodeId, name: item.name, sheets: sheets.data?.sheets ?? sheets.sheets ?? [] }
  }

  async function perform(trigger = 'manual') {
    const config = store.getTaskSheetSyncConfig()
    if (!config?.enabled) throw new Error('task_sheet_sync_disabled')
    const attemptedAt = now().toISOString()
    await store.setTaskSheetSyncStatus({ state: 'running', trigger, lastAttemptAt: attemptedAt, lastError: undefined })
    try {
      const info = parseJson(await runner.run(['sheet', 'info', '--node', config.nodeId, '--sheet-id', config.sheetId, ...profileArgs(profile), '--format', 'json']), 'info')
      if (info.id !== config.sheetId || info.mergedRanges?.length) throw new Error(info.mergedRanges?.length ? 'task_sheet_merged_cells_not_supported' : 'task_sheet_target_changed')
      const snapshot = buildTaskSheetSnapshot({ tasks: structuredClone(await (store.listTaskView?.() ?? store.listTasks())), groups: structuredClone(store.listGroups()), snapshotAt: attemptedAt })
      if (snapshot.values.length > info.rowCount || TASK_SHEET_COLUMNS.length > info.columnCount) throw new Error('task_sheet_capacity_exceeded')
      const operations = JSON.stringify([
        { toolName: 'range clear', input: { 'sheet-id': config.sheetId, range: `A1:N${info.rowCount}`, type: 'content' } },
        { toolName: 'csv-put', input: { 'sheet-id': config.sheetId, 'start-cell': 'A1', csv: snapshotToCsv(snapshot), 'auto-convert': false } },
      ])
      if (operations.length > 24_000) throw new Error('task_sheet_command_too_large')
      let writeError
      try {
        const receipt = parseJson(await runner.run(['sheet', 'batch-update', '--node', config.nodeId, '--operations', operations, '--yes', ...profileArgs(profile), '--format', 'json']), 'write')
        if (receipt.success !== true || receipt.results?.some((item) => item.success !== true)) throw new Error('task_sheet_write_incomplete')
      } catch (cause) { writeError = cause }
      const readback = parseJson(await runner.run(['sheet', '+read', '--node', config.nodeId, '--sheet-id', config.sheetId, '--range', `A1:N${info.rowCount}`, ...profileArgs(profile), '--format', 'json']), 'readback')
      if (readback.data?.hasMore || readback.data?.complete !== true) throw new Error('task_sheet_readback_incomplete')
      const actual = cellValues(readback)
      const expected = snapshot.values.map((row) => row.map(String))
      for (let row = 0; row < expected.length; row += 1) for (let column = 0; column < expected[row].length; column += 1) {
        const wanted = expected[row][column]
        const got = actual[row]?.[column] ?? ''
        if (got !== wanted && got !== `'${wanted}`) throw writeError ?? new Error(`task_sheet_readback_mismatch:${row + 1}:${column + 1}`)
      }
      if (actual.slice(expected.length).some((row) => row.some((value) => value !== ''))) throw writeError ?? new Error('task_sheet_old_tail_remains')
      const status = { state: 'success', trigger, lastAttemptAt: attemptedAt, lastSuccessAt: now().toISOString(), snapshotAt: snapshot.snapshotAt, batchId: snapshot.batchId, taskCount: snapshot.taskCount, lastError: undefined }
      await store.setTaskSheetSyncStatus(status)
      return { ...status, documentUrl: config.documentUrl, sheetTitle: config.sheetTitle }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await store.setTaskSheetSyncStatus({ state: 'failed', trigger, lastAttemptAt: attemptedAt, lastError: message })
      throw cause
    }
  }

  function run(trigger = 'manual') {
    if (running) return Promise.resolve({ state: 'skipped', reason: 'task_sheet_sync_already_running' })
    running = perform(trigger).finally(() => { running = undefined })
    return running
  }
  function schedule() {
    if (timer) clearIntervalImpl(timer)
    timer = undefined
    if (!store.getTaskSheetSyncConfig()?.enabled) return
    run('startup').catch((error) => logger.warn(error instanceof Error ? error.stack : String(error)))
    timer = setIntervalImpl(() => run('timer').catch((error) => logger.warn(error instanceof Error ? error.stack : String(error))), intervalMs)
    timer.unref?.()
  }
  async function updateConfig(input) {
    const checked = await inspect(input.documentUrl)
    const sheet = checked.sheets.find((item) => item.sheetId === input.sheetId)
    if (!sheet) throw new Error('task_sheet_sheet_not_found')
    if (running) await running
    const config = await store.setTaskSheetSyncConfig({ enabled: input.enabled === true, documentUrl: input.documentUrl, nodeId: checked.nodeId, documentName: checked.name, sheetId: sheet.sheetId, sheetTitle: sheet.title, intervalMs })
    schedule()
    return config
  }
  async function close() { if (timer) clearIntervalImpl(timer); timer = undefined; if (running) await running.catch(() => undefined) }
  return { inspect, run, schedule, updateConfig, close, getState: () => ({ config: store.getTaskSheetSyncConfig(), status: store.getTaskSheetSyncStatus() }) }
}
