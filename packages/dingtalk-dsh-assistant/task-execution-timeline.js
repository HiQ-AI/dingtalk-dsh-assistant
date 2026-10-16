import { executionSessionTitle } from './session-workspaces.js'

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
const positive = value => Number.isSafeInteger(value) && value >= 1

// The current service uses this stable completion receipt ID. Reopen wakes and
// immutable receipts supply lifecycle facts; never infer them from summaries.
export async function readTaskLifecycle(task, wakes, getReceipt) {
  const history = []
  for (const wake of wakes.filter(item => item.taskId === task.taskId && item.kind === 'task.reopen')) {
    const revision = wake.payload?.requirementRevision, id = wake.wakeId || wake.id
    if (!positive(revision) || revision < 2 || typeof id !== 'string' || !id.startsWith('wake:')) {
      history.push({ invalid: true }); continue
    }
    const opened = (await getReceipt(id.slice(5)))?.result?.task
    const previous = (await getReceipt(`complete:${task.taskId}:${revision - 1}`))?.result?.task
    const validOpen = opened?.taskId === task.taskId && opened.requirementRevision === revision
      && opened.controlRevision === wake.payload.controlRevision && opened.status === 'active' && opened.completion === null
      && positive(opened.runSequence) && opened.runSequence > 1 && revision <= task.requirementRevision
    const validPrevious = previous?.taskId === task.taskId && previous.requirementRevision === revision - 1
      && previous.status === 'completed' && previous.completion?.requirementRevision === revision - 1
      && validOpen && previous.runSequence === opened.runSequence - 1
    history.push(validOpen ? { sequence: opened.runSequence, at: timestamp(wake.createdAt),
      completedAt: validPrevious ? timestamp(previous.completion.at) : null } : { invalid: true })
  }
  return projectTaskLifecycle(task, history)
}

export function projectTaskLifecycle(task, history = []) {
  const startedAt = timestamp(task.createdAt)
  const terminal = task.status === 'completed' || task.status === 'cancelled' || task.control === 'cancelled'
  const endedAt = timestamp(task.status === 'completed' ? task.completion?.at : task.cancelledAt)
  const segments = [], events = []
  let complete = !!startedAt && positive(task.runSequence) && !history.some(item => item.invalid)
  let start = startedAt, sequence = 1, lastClosed = null
  if (startedAt) events.push({ kind: 'created', at: startedAt, sequence: 1 })
  const entries = history.filter(item => positive(item.sequence) && item.sequence > 1)
    .sort((a, b) => a.sequence - b.sequence)
  const seen = new Set()
  const close = (finish, seq, status) => {
    if (!start || !finish || Date.parse(finish) < Date.parse(start)) { complete = false; return }
    segments.push({ id: `task:${seq}`, sequence: seq, startedAt: start, endedAt: finish, active: false, status,
      label: status === 'completed' ? seq === 1 ? '已完成' : '重开后完成' : seq === 1 ? '已取消' : '重开后取消' })
    lastClosed = finish
  }
  for (const entry of entries) {
    if (seen.has(entry.sequence) || entry.sequence > task.runSequence) { complete = false; continue }
    seen.add(entry.sequence)
    if (entry.sequence !== sequence + 1) { complete = false; start = null }
    close(timestamp(entry.completedAt), entry.sequence - 1, 'completed')
    if (timestamp(entry.completedAt)) events.push({ kind: 'completed', at: entry.completedAt, sequence: entry.sequence - 1 })
    const reopenAt = timestamp(entry.at)
    if (reopenAt) events.push({ kind: 'reopened', at: reopenAt, sequence: entry.sequence })
    start = reopenAt && (!lastClosed || Date.parse(reopenAt) >= Date.parse(lastClosed))
      && (!entry.completedAt || Date.parse(reopenAt) >= Date.parse(entry.completedAt)) ? reopenAt : null
    if (!start) complete = false
    sequence = entry.sequence
  }
  if (sequence !== task.runSequence) { complete = false; start = null; if (positive(task.runSequence)) sequence = task.runSequence }
  if (terminal) {
    close(endedAt, sequence, task.status === 'completed' ? 'completed' : 'cancelled')
    if (endedAt) events.push({ kind: task.status === 'completed' ? 'completed' : 'cancelled', at: endedAt, sequence })
  } else if (start) {
    segments.push({ id: `task:${sequence}`, sequence, startedAt: start, endedAt: null, active: true,
      status: 'running', label: sequence === 1 ? '处理中' : '重开后处理中' })
  }
  return { startedAt, endedAt, active: !terminal, status: task.status, complete, segments, events }
}
// Read-only projection. Wakes are durable business milestones, never tool-log activity
// or a source for inferred start/end times. No final result is interpreted as history.
export function projectTaskTimeline(task, executions, wakes, lifecycle) {
  const rows = new Map()
  for (const execution of executions.filter(item => item.taskId === task.taskId)) {
    const rowId = execution.sessionId || execution.executionId
    const row = rows.get(rowId) ?? { id: rowId, title: executionSessionTitle(execution), status: execution.status, complete: true, segments: [], milestones: [] }
    row.complete &&= execution.timeline?.complete === true
    row.status = execution.status
    for (const [index, segment] of (execution.timeline?.segments ?? []).entries()) {
      const startedAt = timestamp(segment.startedAt), endedAt = timestamp(segment.endedAt)
      const active = segment.state === 'running' && execution.status === 'running' && !execution.drained && !execution.recovering
      if (!startedAt || segment.state === 'unknown' || (!endedAt && !active) || endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
        row.complete = false
        continue
      }
      row.segments.push({ id: `${execution.executionId}:${index}`, startedAt, endedAt, active,
        label: segment.activity, status: active ? 'running' : 'recorded' })
    }
    row.milestones.push(...wakes.filter(wake => wake.taskId === task.taskId && wake.kind === 'execution.stage.progress'
      && wake.payload?.executionId === execution.executionId && timestamp(wake.payload.recordedAt))
      .map(wake => ({ id: wake.wakeId || wake.id, at: wake.payload.recordedAt, summary: wake.payload.summary })))
    rows.set(rowId, row)
  }
  const human = { id: 'human', title: '人工介入', complete: true, segments: [], milestones: [] }
  for (const request of task.humanRequests ?? []) {
    const startedAt = timestamp(request.createdAt)
    const active = request.status === 'waiting-reply' && task.status !== 'completed' && task.status !== 'cancelled' && task.control !== 'cancelled'
    const endedAt = timestamp(request.status === 'answered' ? request.answeredAt
      : request.status === 'superseded' ? request.supersededAt
        : request.status === 'cancelled' ? request.cancelledAt : request.status === 'closed' ? request.closedAt : null)
    if (!startedAt || !active && !endedAt || endedAt && Date.parse(endedAt) < Date.parse(startedAt)) { human.complete = false; continue }
    human.segments.push({ id: request.requestId, startedAt, endedAt, active, status: request.status,
      label: ({ 'waiting-reply': '等待处理', answered: '已答复', superseded: '已失效', cancelled: '已取消', closed: '已关闭' })[request.status] || request.status,
      description: request.question })
  }
  return { version: 1, task: lifecycle || projectTaskLifecycle(task), executions: [...rows.values()], human }
}
