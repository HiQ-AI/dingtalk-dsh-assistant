import { fingerprint } from './topic-model.js'

const text = (value, limit = 600) => typeof value === 'string' ? value.slice(0, limit) : undefined
const evidence = (values) => (values ?? []).slice(0, 3).map((value) => text(value, 300))
const at = (value) => Number.isFinite(Date.parse(value)) ? value : undefined

export const taskOutcome = task => task.outcome ?? (task.state === 'completed' ? 'legacy-unknown' : undefined)
export const taskOutcomeLabel = task => ({ succeeded: '已成功', cancelled: '已取消', failed: '已失败', 'legacy-unknown': '历史结果未知' })[taskOutcome(task)]

export function taskBoardProgress(task) {
  if (task.engine === 'workflow-v2') return { outcome: taskOutcome(task), outcomeLabel: taskOutcomeLabel(task), stages: (task.executionNodes ?? []).map(node => ({ stageId: node.nodeId, title: node.title ?? node.nodeId, completed: node.status === 'succeeded' })) }
  const completed = new Set(acceptedTaskStageOutputs(task).map(item => item.stageOutput.stageId))
  return { outcome: taskOutcome(task), outcomeLabel: taskOutcomeLabel(task), stages: (task.plan?.stages ?? []).map(stage => ({
    stageId: stage.stageId, title: stage.title, completed: completed.has(stage.stageId),
  })) }
}

// 只接受当前版本或 Host 明确保留的证据；文字重命名不改变阶段身份。
export function acceptedTaskStageOutputs(task) {
  if (!task.plan || task.plan.runSequence !== task.runSequence) return []
  const candidates = (task.checkpoints ?? []).filter(checkpoint => {
    const output = checkpoint.stageOutput
    if (checkpoint.kind !== 'stage-completed' || !['acknowledge', 'guidance'].includes(checkpoint.coordinatorDecision) || !output || output.blockers?.length) return false
    if (checkpoint.runSequence !== task.runSequence || output.runSequence !== task.runSequence || checkpoint.inputVersion !== output.inputVersion) return false
    let inputVersion = output.inputVersion, planRevision = output.planRevision
    // 逐次保留链不能跳过中间的撤销；后来的事件不得复活曾失效的旧证据。
    for (const event of task.executionEvents ?? []) {
      if (event.runSequence !== task.runSequence) continue
      if (event.kind === 'input-revised' && event.inputVersion > inputVersion && event.inputVersion <= task.inputVersion) {
        if ((event.previousInputVersion ?? event.inputVersion - 1) !== inputVersion || !event.retainedCheckpointIds?.includes(checkpoint.checkpointId)) return false
        inputVersion = event.inputVersion
      }
      if (event.kind === 'task-plan-adopted' && event.planRevision > planRevision && event.planRevision <= task.plan.revision) {
        if (event.planRevision !== planRevision + 1 || event.inputVersion !== inputVersion || !event.retainedCheckpointIds?.includes(checkpoint.checkpointId)) return false
        planRevision = event.planRevision
      }
    }
    if (inputVersion !== task.inputVersion || planRevision !== task.plan.revision) return false
    return task.plan.stages.some(stage => stage.stageId === output.stageId)
  })
  const acceptedStageIds = new Set()
  for (const stage of task.plan.stages) if (stage.dependsOn.every(id => acceptedStageIds.has(id)) && candidates.some(item => item.stageOutput.stageId === stage.stageId)) acceptedStageIds.add(stage.stageId)
  return candidates.filter(item => acceptedStageIds.has(item.stageOutput.stageId))
}

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
  const confirmed = task.plan ? acceptedTaskStageOutputs(task) : checkpoints.filter((value) => currentCheckpoint(value) && value.kind === 'stage-completed' && ['acknowledge', 'guidance'].includes(value.coordinatorDecision))
  const completedIds = new Set(confirmed.map(value => value.stageOutput?.stageId))
  const stages = task.plan?.stages ?? (task.stageTasks ?? []).map(title => ({ title }))
  const checkpointFact = (value) => ({
    sourceRef: value.checkpointId, inputVersion: value.inputVersion, runSequence: value.runSequence,
    observedAt: at(value.submittedAt), reviewedAt: at(value.reviewedAt), verification: value.coordinatorDecision ? `coordinator-${value.coordinatorDecision}` : 'reported-unreviewed',
    kind: value.kind, stageId: value.stageOutput?.stageId ?? value.stageId, stageTask: text(task.plan?.stages.find(stage => stage.stageId === value.stageOutput?.stageId)?.title ?? value.completedItems?.[0] ?? value.stageTask), summary: text(value.summary), evidence: evidence(value.evidence),
    stageOutput: value.stageOutput,
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
    outcome: taskOutcome(task), outcomeLabel: taskOutcomeLabel(task),
    plan: task.plan,
    objective: text(task.objective),
    confirmedStages: confirmed.slice(-limit).map(checkpointFact),
    currentStage: task.state === 'completed' ? undefined : text(stages.find(stage => task.plan ? !completedIds.has(stage.stageId) : !confirmed.some(checkpoint => (checkpoint.completedItems ?? [checkpoint.stageTask]).includes(stage.title)))?.title),
    completedStageCount: task.plan ? completedIds.size : confirmed.length, totalStageCount: stages.length,
    recentCheckpoints: checkpoints.filter(currentCheckpoint).slice(-limit).map(checkpointFact),
    pendingReports: pending.slice(-limit).map((value) => ({ submissionId: value.submissionId, sourceRef: value.submissionId, inputVersion: value.inputVersion, runSequence: value.runSequence, observedAt: at(value.receivedAt ?? value.at), status: value.status, reportType: value.reportType, summary: text(value.value?.summary), evidence: evidence(value.value?.evidence), verification: 'reported-unreviewed', externalVerifiedAt: null })),
    approvals: currentApprovals.slice(-limit).map((value) => ({ approvalId: value.requestId, runSequence: value.runSequence ?? null, status: value.status, decision: value.decision, requestedAction: text(value.requestedAction), reply: text(value.reply), observedAt: at(value.decidedAt ?? value.createdAt), decisionSource: value.decisionSource, sourceRef: value.replyMessageId ?? value.messageId ?? value.requestId, binding: 'unverified-use-original-request', coversNewOperation: false })),
    blocker: task.humanBlocker && ['pending-send', 'waiting-reply'].includes(task.humanBlocker.status) ? { approvalId: task.humanBlocker.requestId, observedAt: at(task.humanBlocker.createdAt), reason: text(task.humanBlocker.waitingReason ?? task.waitingReason), requestedAction: text(task.humanBlocker.requestedAction) } : task.waitingReason ? { reason: text(task.waitingReason) } : null,
    informationWait: task.state === 'waiting' && task.waitingKind === 'information' ? {
      startedAt: at([...task.stateHistory ?? []].reverse().find(event => event.state === 'waiting' && event.runSequence === runSequence)?.at),
      questions: (task.result?.questions ?? []).slice(0, 3).map(value => text(value, 300)),
      completedStageCount: task.plan ? completedIds.size : confirmed.length, remainingStageCount: Math.max(0, stages.length - (task.plan ? completedIds.size : confirmed.length)),
    } : null,
    result: result ? { status: result.status, summary: text(result.summary), evidence: evidence(result.evidence), sourceRef: resultEvent?.submissionId ?? `task:${task.taskId}:result`, observedAt: at(resultEvent?.at), externalVerifiedAt: null, verification: 'stored-result-not-independent-verification' } : null,
    activityProjection: task.activityProjection ? { lastSyncedAt: task.activityProjection.lastSyncedAt, latestOccurredAt: task.activityProjection.latestOccurredAt, latestEventKey: task.activityProjection.latestEventKey, truncated: task.activityProjection.truncated, retainedLimit: 500 } : null,
    omitted: { confirmedStages: Math.max(0, confirmed.length - limit), checkpoints: Math.max(0, checkpoints.filter(currentCheckpoint).length - limit), pendingReports: Math.max(0, pending.length - limit), approvals: Math.max(0, currentApprovals.length - limit), historicalApprovals: approvals.length - currentApprovals.length },
    boundaries: ['snapshotAt 仅为读取时间；observedAt 为原记录时间。', 'evidence 是叶子提交的证据引用，未在此查询独立核验外部状态。', '批准仅对应原请求和原轮次，不能据此批准新 SQL、资源或操作。', '字符串为有界摘要；完整正文在 sourceRef 对应的原记录中。'],
  }
  if (projection.plan && JSON.stringify(projection.plan).length > 6000) {
    projection.planRef = { taskId: task.taskId, revision: task.plan.revision, inputVersion: task.plan.inputVersion, runSequence: task.plan.runSequence, sourceRef: `task:${task.taskId}:plan:${task.plan.revision}`, complete: false }
    projection.plan = undefined
    projection.omitted.plan = 1
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
  // DSH 工具输出要求是可无损传输的 JSON；可选事实不能以 undefined 泄漏到结果对象。
  return JSON.parse(JSON.stringify(projection))
}
