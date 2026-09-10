import { fingerprint } from './topic-model.js'

const text = (value, limit = 600) => typeof value === 'string' ? value.slice(0, limit) : undefined
const evidence = (values) => (values ?? []).slice(0, 3).map((value) => text(value, 300))
const at = (value) => Number.isFinite(Date.parse(value)) ? value : undefined

// 关联索引保持轻量；只有直接查询和审阅才装配此有界事实投影。
// Store 读取时间不是外部系统核验时间，批准原文也不是新对象的强类型授权。
export function taskProgressSnapshot(task, { snapshotAt = new Date().toISOString(), maxItems = 3 } = {}) {
  const limit = Math.max(1, Math.min(10, Number.isInteger(maxItems) ? maxItems : 3))
  const runSequence = task.runSequence ?? 1
  const current = (value) => value.inputVersion === task.inputVersion && value.runSequence === runSequence
  const revision = [...(task.executionEvents ?? [])].reverse().find(event => event.kind === 'input-revised' && event.inputVersion === task.inputVersion)
  const retained = new Set(revision?.retainedCheckpointIds ?? [])
  const currentCheckpoint = value => current(value) || value.runSequence === runSequence && retained.has(value.checkpointId)
  const checkpoints = task.checkpoints ?? []
  const confirmed = checkpoints.filter((value) => currentCheckpoint(value) && value.kind === 'stage-completed' && ['acknowledge', 'guidance'].includes(value.coordinatorDecision))
  const checkpointFact = (value) => ({
    sourceRef: value.checkpointId, inputVersion: value.inputVersion, runSequence: value.runSequence,
    observedAt: at(value.submittedAt), reviewedAt: at(value.reviewedAt), verification: value.coordinatorDecision ? `coordinator-${value.coordinatorDecision}` : 'reported-unreviewed',
    kind: value.kind, stageTask: text(value.completedItems?.[0] ?? value.stageTask), summary: text(value.summary), evidence: evidence(value.evidence),
    externalVerifiedAt: null,
    retainedForInputVersion: retained.has(value.checkpointId) ? task.inputVersion : undefined,
  })
  const reports = new Map()
  for (const event of task.executionEvents ?? []) {
    if (event.kind === 'task-report-received') reports.set(event.submissionId, { ...event })
    if (event.kind === 'task-report-settled' && reports.has(event.submissionId)) reports.set(event.submissionId, { ...reports.get(event.submissionId), ...event, value: reports.get(event.submissionId).value, receivedAt: reports.get(event.submissionId).receivedAt ?? reports.get(event.submissionId).at })
  }
  const pending = [...reports.values()].filter((value) => ['pending', 'input-wait', 'review-wait'].includes(value.status) && current(value))
  const approvalMap = new Map((task.humanBlockerHistory ?? []).map((value) => [value.requestId, value]))
  if (task.humanBlocker) approvalMap.set(task.humanBlocker.requestId, task.humanBlocker)
  const approvals = [...approvalMap.values()].sort((a, b) => (Date.parse(a.decidedAt ?? a.createdAt) || 0) - (Date.parse(b.decidedAt ?? b.createdAt) || 0))
  const currentApprovals = approvals.filter((value) => value.runSequence === undefined || value.runSequence === runSequence)
  const result = task.result && current(task.result) ? task.result : undefined
  const events = task.executionEvents ?? []
  const resultEvent = [...events].reverse().find((event) => current(event) && event.kind === 'task-report-received' && event.reportType === 'result')
  const projection = {
    taskId: task.taskId, groupId: task.groupId, inputVersion: task.inputVersion, runSequence,
    topicRefs: (task.topicRefs ?? []).map(ref => ({ topicId: ref.topicId, revision: ref.revision })),
    snapshotAt,
    state: task.state, stateObservedAt: at([...task.stateHistory ?? []].reverse().find((event) => event.runSequence === runSequence && event.state === task.state)?.at),
    objective: text(task.objective),
    confirmedStages: confirmed.slice(-limit).map(checkpointFact),
    currentStage: text((task.stageTasks ?? []).find((stage) => !confirmed.some((checkpoint) => (checkpoint.completedItems ?? [checkpoint.stageTask]).includes(stage)))),
    recentCheckpoints: checkpoints.filter(currentCheckpoint).slice(-limit).map(checkpointFact),
    pendingReports: pending.slice(-limit).map((value) => ({ submissionId: value.submissionId, sourceRef: value.submissionId, inputVersion: value.inputVersion, runSequence: value.runSequence, observedAt: at(value.receivedAt ?? value.at), status: value.status, reportType: value.reportType, summary: text(value.value?.summary), evidence: evidence(value.value?.evidence), verification: 'reported-unreviewed', externalVerifiedAt: null })),
    approvals: currentApprovals.slice(-limit).map((value) => ({ approvalId: value.requestId, runSequence: value.runSequence ?? null, status: value.status, decision: value.decision, requestedAction: text(value.requestedAction), reply: text(value.reply), observedAt: at(value.decidedAt ?? value.createdAt), decisionSource: value.decisionSource, sourceRef: value.replyMessageId ?? value.messageId ?? value.requestId, binding: 'unverified-use-original-request', coversNewOperation: false })),
    blocker: task.humanBlocker && ['pending-send', 'waiting-reply'].includes(task.humanBlocker.status) ? { approvalId: task.humanBlocker.requestId, observedAt: at(task.humanBlocker.createdAt), reason: text(task.humanBlocker.waitingReason ?? task.waitingReason), requestedAction: text(task.humanBlocker.requestedAction) } : task.waitingReason ? { reason: text(task.waitingReason) } : null,
    result: result ? { status: result.status, summary: text(result.summary), evidence: evidence(result.evidence), sourceRef: resultEvent?.submissionId ?? `task:${task.taskId}:result`, observedAt: at(resultEvent?.at), externalVerifiedAt: null, verification: 'stored-result-not-independent-verification' } : null,
    activityProjection: task.activityProjection ? { lastSyncedAt: task.activityProjection.lastSyncedAt, latestOccurredAt: task.activityProjection.latestOccurredAt, latestEventKey: task.activityProjection.latestEventKey, truncated: task.activityProjection.truncated, retainedLimit: 500 } : null,
    omitted: { confirmedStages: Math.max(0, confirmed.length - limit), checkpoints: Math.max(0, checkpoints.filter(currentCheckpoint).length - limit), pendingReports: Math.max(0, pending.length - limit), approvals: Math.max(0, currentApprovals.length - limit), historicalApprovals: approvals.length - currentApprovals.length },
    boundaries: ['snapshotAt 仅为读取时间；observedAt 为原记录时间。', 'evidence 是叶子提交的证据引用，未在此查询独立核验外部状态。', '批准仅对应原请求和原轮次，不能据此批准新 SQL、资源或操作。', '字符串为有界摘要；完整正文在 sourceRef 对应的原记录中。'],
  }
  // 超预算只移出完整条目，保留引用和 omitted；不截断 JSON 或伪造完整上下文。
  const collections = ['recentCheckpoints', 'confirmedStages', 'pendingReports', 'approvals']
  while (JSON.stringify(projection).length > 12000) {
    const key = collections.reduce((largest, candidate) => JSON.stringify(projection[candidate]).length > JSON.stringify(projection[largest]).length ? candidate : largest)
    if (projection[key].length === 0) break
    projection[key].shift()
    projection.omitted[key === 'recentCheckpoints' ? 'checkpoints' : key] += 1
  }
  projection.hasMore = Object.values(projection.omitted).some((count) => count > 0)
  const { snapshotAt: _snapshotAt, ...visibleFacts } = projection
  projection.revision = fingerprint(visibleFacts)
  return projection
}
