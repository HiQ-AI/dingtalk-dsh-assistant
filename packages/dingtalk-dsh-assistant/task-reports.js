import { fingerprint, stableId } from './topic-model.js'

export const deterministicReviewFailure = (error) => /^(?:topic_context_(?:budget_exceeded|metadata_too_large)|task_review_envelope_too_large|route_context_budget_exceeded)(?::|$)/u.test(error ?? '')

// 只有明确由报告内容导致的缺口才交回叶子修订；基础设施及未知错误停止推进。
const businessRejections = new Set([
  'task_checkpoint_rejected', 'task_result_objective_not_covered', 'task_waiting_not_required',
  'task_worktree_result_mismatch', 'task_checkpoints_insufficient', 'task_checkpoints_remaining',
  'task_checkpoint_plan_required', 'task_workflow_plan_rejected', 'task_workflow_assessment_required',
  'task_checkpoint_plan_insufficient', 'task_checkpoint_plan_stage_duplicate',
  'task_workflow_assessment_refs_invalid', 'task_workflow_inapplicable_prompt_invalid',
  'task_workflow_exception_basis_invalid', 'task_workflow_assessment_plan_only',
  'task_checkpoint_stage_invalid', 'task_checkpoint_progress_requires_stage_completed', 'task_checkpoint_must_advance_one',
])
const staleReportErrors = new Set([
  'task_checkpoint_review_superseded',
  'task_input_version_stale', 'task_checkpoint_run_changed', 'task_checkpoint_context_changed',
  'task_result_context_changed', 'task_review_context_changed', 'task_workflow_plan_stale', 'task_prompt_selection_stale',
])
export function classifyTaskReportError(error) {
  const code = String(error?.message ?? error ?? '').split(':', 1)[0]
  if (code === 'task_input_pending') return 'input-wait'
  if (staleReportErrors.has(code)) return 'history-only'
  return businessRejections.has(code) ? 'rejected' : 'failed'
}

export const taskReportReceiptSchema = { type: 'object', additionalProperties: false, properties: {
  contractVersion: { type: 'integer', const: 2 }, received: { type: 'boolean', const: true }, taskId: { type: 'string' }, submissionId: { type: 'string' },
  reviewStatus: { type: 'string', enum: ['pending', 'approved', 'rejected', 'stale', 'failed'] },
  applicationStatus: { type: 'string', enum: ['pending', 'applied', 'superseded', 'blocked'] },
  nextAction: { type: 'string', enum: ['wait-for-resolution', 'continue', 'revise-report', 'review-current-input', 'repair-system'] },
  instruction: { type: 'string' }, result: { type: 'object', additionalProperties: true }, error: { type: 'string' },
}, required: ['contractVersion', 'received', 'taskId', 'submissionId', 'reviewStatus', 'applicationStatus', 'nextAction', 'instruction'] }

const receiptStates = {
  'input-wait': ['pending', 'pending', 'wait-for-resolution'],
  'review-wait': ['pending', 'pending', 'wait-for-resolution'],
  'history-only': ['stale', 'superseded', 'review-current-input'],
  accepted: ['approved', 'applied', 'continue'],
  rejected: ['rejected', 'blocked', 'revise-report'],
  failed: ['failed', 'blocked', 'repair-system'],
}
export function taskReportReceipt(taskId, report) {
  const state = receiptStates[report.status]
  if (!state) throw new Error(`task_report_status_invalid:${report.status}`)
  const [reviewStatus, applicationStatus, nextAction] = state
  return {
    contractVersion: 2, received: true, taskId, submissionId: report.submissionId, reviewStatus, applicationStatus, nextAction,
    instruction: reviewStatus === 'pending' ? '报告已保存，尚未批准阶段推进或任务完成。等待 Runtime 事件通知，不重复提交，不继续依赖该批准的动作。'
      : reviewStatus === 'stale' ? '已保存为历史事实，不推进当前目标；核对当前版本及可复用证据，不重复执行已完成的业务写入。'
        : reviewStatus === 'failed' ? '报告处理发生系统故障，保持阻塞。由 Host 或维护者修复后按原报告身份显式恢复，不进行业务返工。'
          : reviewStatus === 'rejected' ? '报告未获批准；按具体缺口修订，形成新报告。' : '报告审阅及应用完成；按处理结果继续。此回执不证明外部通知已送达。',
    ...(report.receipt ? { result: report.receipt } : {}), ...(report.error ? { error: report.error } : {}),
  }
}

// 报告持久化在既有 executionEvents；业务完成判定仍由 Runtime 原有校验执行。
export function taskReports(task) {
  const reports = new Map()
  for (const event of task.executionEvents ?? []) {
    if (event.kind === 'task-report-received') reports.set(event.submissionId, event)
    if (event.kind === 'task-report-notified' && reports.has(event.submissionId)) reports.set(event.submissionId, { ...reports.get(event.submissionId), notifiedAt: event.at })
    if (event.kind === 'task-report-settled' && reports.has(event.submissionId)) {
      reports.set(event.submissionId, { ...reports.get(event.submissionId), error: undefined, receipt: undefined, notifiedAt: undefined, ...event, kind: 'task-report-received' })
    }
  }
  return [...reports.values()]
}

export function createTaskReportQueue({ store, serialize, hasPendingInput, execute, suspend, notify, onError, isClosing }) {
  const runs = new Map()
  const urgent = new Map()
  const requested = new Set()
  const pending = report => ['input-wait', 'review-wait'].includes(report.status)
  const diagnostic = report => report.reportType === 'checkpoint' && ['scope-conflict', 'evidence-gap', 'risk-changed'].includes(report.value.kind)
  const receipt = taskReportReceipt
  async function settle(taskId, report, status, extra = {}) {
    await serialize(() => store.updateTask(taskId, current => ({ ...current,
      executionEvents: [...(current.executionEvents ?? []), { kind: 'task-report-settled', submissionId: report.submissionId,
        inputVersion: report.inputVersion, runSequence: report.runSequence, status, at: new Date().toISOString(), ...extra }],
    })))
  }
  const needsNotification = report => (['accepted', 'rejected', 'failed'].includes(report.status) || report.status === 'history-only' && report.staleReview) && !report.notifiedAt
  const matchesCurrent = (task, report) => report.inputVersion === task.inputVersion && report.runSequence === task.runSequence
  async function process(taskId, report) {
    let task = store.getTask(taskId)
    if (!matchesCurrent(task, report) && report.status !== 'history-only' && (pending(report) || needsNotification(report) || report.status === 'failed')) {
      await settle(taskId, report, 'history-only', { staleReview: pending(report) || needsNotification(report) })
      report = taskReports(store.getTask(taskId)).find(item => item.submissionId === report.submissionId)
    }
    if (pending(report)) {
      if (!matchesCurrent(task, report) || task.state === 'completed') {
        await settle(taskId, report, 'history-only', { staleReview: true })
        report = taskReports(store.getTask(taskId)).find(item => item.submissionId === report.submissionId)
      } else {
        if (hasPendingInput(task) && !diagnostic(report)) {
          if (report.status !== 'input-wait') await settle(taskId, report, 'input-wait')
          return
        }
        let status, result, error
        try {
          result = await execute(taskId, report.reportType, report.value, { recoveryError: report.recoveryError, submissionId: report.submissionId })
          status = result?.accepted === false ? 'rejected' : 'accepted'
        } catch (cause) {
          error = String(cause.message ?? cause).slice(0, 1600)
          status = classifyTaskReportError(cause)
        }
        task = store.getTask(taskId)
        if (status === 'accepted' && !matchesCurrent(task, report)) status = 'history-only'
        await settle(taskId, report, status, { ...(status === 'history-only' ? { staleReview: true } : {}), ...(result ? { receipt: result } : {}), ...(error ? { error } : {}) })
        report = taskReports(store.getTask(taskId)).find(item => item.submissionId === report.submissionId)
      }
    }
    if (isClosing() || !needsNotification(report)) return
    // notify 必须先把稳定身份通知持久化；失败保留待通知终态，恢复不能再次执行报告。
    if (await notify(store.getTask(taskId), report) === false) return
    await serialize(() => store.updateTask(taskId, current => ({ ...current, executionEvents: [
      ...(current.executionEvents ?? []), { kind: 'task-report-notified', submissionId: report.submissionId, at: new Date().toISOString() },
    ] })))
  }
  function start(taskId) {
    if (isClosing()) return
    requested.add(taskId)
    if (runs.has(taskId)) return
    const run = (async () => {
      do {
        requested.delete(taskId)
        const visited = new Set()
        while (!isClosing()) {
          const task = store.getTask(taskId)
          if (!task) return
          const report = taskReports(task).find(item => !visited.has(item.submissionId) && !urgent.has(`${taskId}:${item.submissionId}`) && !(pending(item) && diagnostic(item)) && (pending(item) || needsNotification(item) || item.status === 'failed' && !matchesCurrent(task, item)))
          if (!report) break
          visited.add(report.submissionId)
          await process(taskId, report)
        }
      } while (!isClosing() && requested.has(taskId))
    })().catch(error => { requested.delete(taskId); onError(error) }).finally(() => {
      runs.delete(taskId)
      if (requested.has(taskId) && !isClosing()) start(taskId)
    })
    runs.set(taskId, run)
  }
  // 风险/证据诊断可中断正在等待的计划审阅；普通阶段仍保持每Task串行。
  function startDiagnostic(taskId, report) {
    const key = `${taskId}:${report.submissionId}`
    if (isClosing() || urgent.has(key) || !pending(report) || !diagnostic(report)) return
    const run = process(taskId, report).catch(onError).finally(() => { urgent.delete(key); start(taskId) })
    urgent.set(key, run)
  }
  return {
    async submit(taskId, reportType, value) {
      const report = await serialize(async () => {
        const task = store.getTask(taskId)
        if (!task) throw new Error(`task_not_found:${taskId}`)
        if (task.state === 'waiting' && task.waitingKind === 'system') throw new Error(`task_system_waiting:${taskId}`)
        const { submissionId: suppliedId, ...body } = value
        const digest = fingerprint({ reportType, body })
        const submissionId = suppliedId ?? stableId('report', `${taskId}:${digest}`)
        const existing = taskReports(task).find(item => item.submissionId === submissionId)
        if (existing) {
          if (existing.digest !== digest) throw new Error(`task_report_identity_conflict:${submissionId}`)
          return existing
        }
        if (value.runSequence > task.runSequence || value.inputVersion > task.inputVersion) throw new Error(`task_input_version_stale:${taskId}`)
        const knownRun = value.runSequence === task.runSequence || task.runHistory?.some(run => run.runSequence === value.runSequence && value.inputVersion <= run.inputVersion)
        if (!knownRun) throw new Error(`task_report_unknown_run:${taskId}`)
        const historical = value.runSequence !== task.runSequence || value.inputVersion !== task.inputVersion || task.state === 'completed'
        const report = { kind: 'task-report-received', submissionId, digest, reportType, value: body,
          inputVersion: body.inputVersion, runSequence: body.runSequence, at: new Date().toISOString(),
          status: historical ? 'history-only' : hasPendingInput(task) ? 'input-wait' : 'review-wait' }
        await store.updateTask(taskId, current => ({ ...current, executionEvents: [...(current.executionEvents ?? []), report] }))
        return report
      })
      if (pending(report)) {
        await suspend(store.getTask(taskId))
        if (diagnostic(report)) startDiagnostic(taskId, report)
        else start(taskId)
      }
      if (needsNotification(report)) start(taskId)
      return receipt(taskId, report)
    },
    recover(task) { for (const report of taskReports(task)) startDiagnostic(task.taskId, report); start(task.taskId) },
    async retry(taskId, submissionId, { coordinationRequestId } = {}) {
      const report = await serialize(async () => {
        const task = store.getTask(taskId)
        const existing = task && taskReports(task).find(item => item.submissionId === submissionId)
        if (!existing) throw new Error(`task_report_not_found:${submissionId}`)
        if (!matchesCurrent(task, existing) || task.state === 'completed') throw new Error(`task_report_retry_stale:${submissionId}`)
        const recoveryError = coordinationRequestId && task.executionEvents?.findLast(event => event.kind === 'task-report-settled' && event.submissionId === submissionId && event.status === 'failed' && event.error === `topic_request_retry_exhausted:${coordinationRequestId}`)?.error
        const recoverRejectedActiveCheck = recoveryError && existing.status === 'rejected' && existing.error === `task_not_active:${taskId}`
        if (existing.status !== 'failed' && !recoverRejectedActiveCheck) throw new Error(`task_report_retry_requires_failed:${submissionId}`)
        const status = hasPendingInput(task) ? 'input-wait' : 'review-wait'
        await store.updateTask(taskId, current => ({ ...current, executionEvents: [...(current.executionEvents ?? []), {
          kind: 'task-report-settled', submissionId, inputVersion: existing.inputVersion, runSequence: existing.runSequence, status, recoveryError: recoveryError ?? existing.error, at: new Date().toISOString(),
        }] }))
        return taskReports(store.getTask(taskId)).find(item => item.submissionId === submissionId)
      })
      await suspend(store.getTask(taskId))
      if (diagnostic(report)) startDiagnostic(taskId, report)
      else start(taskId)
      return receipt(taskId, report)
    },
    hasPending(task) { return taskReports(task).some(report => (pending(report) || needsNotification(report)) && matchesCurrent(task, report)) },
    hasBlocking(task) { return taskReports(task).some(report => matchesCurrent(task, report) && (pending(report) || needsNotification(report) || report.status === 'failed')) },
    get(taskId, submissionId) {
      const task = store.getTask(taskId)
      const report = task && taskReports(task).find(item => item.submissionId === submissionId)
      return report && receipt(taskId, report)
    },
    async drain() { while (runs.size > 0 || urgent.size > 0) await Promise.allSettled([...runs.values(), ...urgent.values()]) },
  }
}
