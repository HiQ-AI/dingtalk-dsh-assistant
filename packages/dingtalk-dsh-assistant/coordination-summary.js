// Read authoritative facts and persist a bounded cross-task view. Delivery is a
// separate obligation; neither a receipt nor a released lock proves completion.
export function coordinationSnapshot({ coordination, members, tasks, schedules, occurrences, jobs }) {
  const items = members.map(m => {
    const task = tasks.find(t => t.taskId === m.taskId)
    const blocked = task?.status === 'active' && !['fulfilled','cancelled','superseded','template'].includes(m.state)
      && m.control !== 'cancelled' && task?.lastDecision?.action === 'blocked'
    return { instructionId: m.id, taskId: m.taskId, observation: m.observation === true,
      requirement: m.observation ? '只观察原任务当前版本的正式完成，不追加要求或唤醒任务' : m.command.args.text ?? m.command.args.request ?? task?.objective ?? '',
      ...(m.recurringTemplateScheduleId ? { authorizationTemplateScheduleId: m.recurringTemplateScheduleId } : {}),
      state: m.state === 'template' ? 'template' : m.recurringOccurrenceId && ['fulfilled','superseded'].includes(m.state) ? m.state : m.waitingReason?.code === 'target_version_changed' ? 'version_changed' : m.state === 'fulfilled' ? 'fulfilled' : m.control === 'cancelled' ? 'cancelled' : m.control === 'paused' ? 'paused' : m.state,
      control: m.control ?? 'active',
      effectiveVersion: m.effectiveVersion ?? null, waitingReason: m.waitingReason ?? null,
      ...(m.reorderAssessment ? {reorderAssessment:{id:m.reorderAssessment.id,state:m.reorderAssessment.state,
        decision:m.reorderAssessment.decision ?? null,summary:m.reorderAssessment.summary ?? null,evidence:m.reorderAssessment.evidence ?? []}} : {}),
      commandId: m.command.id, receiptRef: m.receipt ? m.command.id : null, completionProof: m.completionProof ?? null,
      blocker: m.reorderAssessment?.state === 'needs_clarification' && !['cancelled','fulfilled','superseded'].includes(m.state)
        && m.control !== 'cancelled' ? m.reorderAssessment.summary : blocked ? task.lastDecision.summary : null }
  })
  const fulfilled = items.filter(m => m.state === 'fulfilled').length
  const cancelled = items.filter(m => m.state === 'cancelled').length
  const remaining = items.filter(m => !['fulfilled','cancelled','superseded','template'].includes(m.state))
  const pendingClarifications = coordination.pendingClarifications ?? []
  const activePlan = schedules.some(s => ['active','paused','needs_clarification'].includes(s.state))
  const unsettled = occurrences.some(o => ['waiting','running'].includes(o.actionState) || ['pending','unknown'].includes(o.deliveryState))
  const failed = items.some(m => !['template','fulfilled','superseded'].includes(m.state) && (m.blocker || m.waitingReason?.code === 'target_version_changed'))
    || occurrences.some(o => !o.cancelledAt && (['failed','expired','blocked'].includes(o.actionState) || o.deliveryState === 'failed'))
  let state = 'active'
  if (coordination.state === 'cancelled') state = fulfilled ? 'partially_completed' : 'cancelled'
  else if (coordination.state === 'needs_clarification' || pendingClarifications.length) state = 'needs_attention'
  else if (failed) state = fulfilled ? 'partially_completed' : 'needs_attention'
  else if (!activePlan && !unsettled && !remaining.length && (items.length || occurrences.length || schedules.length))
    state = cancelled || occurrences.some(o => o.cancelledAt || o.actionState === 'cancelled')
      ? fulfilled || occurrences.some(o => o.actionState === 'succeeded' && !o.cancelledAt) ? 'partially_completed' : 'cancelled' : 'completed'
  else if (!items.length && !schedules.length && !occurrences.length) state = 'needs_attention'
  return { coordinationId: coordination.id, revision: coordination.revision, state, members: items, pendingClarifications,
    fulfilled, remainingInstructionIds: remaining.map(m => m.instructionId),
    schedules: schedules.map(s => ({ scheduleId: s.id, revision: s.revision, state: s.state, nextDueAt: s.nextDueAt, outcome: s.outcome ?? null,
      timezone: s.timezone ?? null, rule: s.rule ?? null, recipientIds: s.target?.recipientIds ?? [] })),
    occurrences: occurrences.map(o => ({ occurrenceId: o.id, scheduleId: o.scheduleId ?? null, plannedAt: o.plannedAt ?? null,
      cancelledAt: o.cancelledAt ?? null,
      recipientIds: o.target?.recipientIds ?? [],
      actionState: o.actionState, deliveryState: o.deliveryState,
      failureReason: o.failureReason ?? null,
      resultRef: o.result ? `${o.id}:result:${o.resultVersion ?? 1}` : null, notificationId: o.notificationId ?? null })),
    jobs: jobs.map(j => ({ jobId: j.id, state: j.state, failureReason: j.failureReason ?? j.waitingReason ?? null })),
    outstanding: { instructionIds: remaining.map(m => m.instructionId), clarificationIds: coordination.state === 'cancelled' ? [] : pendingClarifications.map(p => p.clarificationId), occurrenceIds: occurrences.filter(o => !o.cancelledAt && ['waiting','running','blocked'].includes(o.actionState)
      || ['pending','unknown'].includes(o.deliveryState)).map(o => o.id), activeScheduleIds: schedules.filter(s => ['active','paused'].includes(s.state)).map(s => s.id) } }
}

const statusLabels = { active: '进行中', completed: '已完成', partially_completed: '部分完成', needs_attention: '需要处理',
  needs_clarification: '待澄清', cancelled: '已取消', paused: '已暂停', ready: '待派发', observing: '等待原任务完成',
  applied: '已接收', fulfilled: '正式完成', template: '周期授权', superseded: '已替代', version_changed: '目标版本已变化',
  waiting: '等待执行', running: '执行中', succeeded: '动作成功', failed: '失败', blocked: '受阻', expired: '已过期，本次未执行',
  none: '未产生', pending: '待送达', delivered: '已送达', unknown: '送达结果未知，等待核对' }
const statusText = state => statusLabels[state] ?? state
const reasonText = reason => typeof reason === 'string' ? reason : JSON.stringify(reason)
const timeText = (instant, timezone = 'UTC') => instant
  ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(instant))}（${timezone}）` : '无'

// 聊天查询和主动摘要共用同一权威事实格式，避免账本有原因而用户只看到零计数。
export function formatCoordinationSnapshot(snapshot) {
  const lines = [`协调安排 ${snapshot.coordinationId}（版本 ${snapshot.revision}）：${statusText(snapshot.state)}；正式完成 ${snapshot.fulfilled} 项；尚欠 ${snapshot.remainingInstructionIds.length} 项。`]
  for (const member of snapshot.members) lines.push(`${member.taskId} / ${member.instructionId}：${statusText(member.state)}；要求：${member.requirement}；等待原因：${member.blocker ?? (member.waitingReason ? reasonText(member.waitingReason) : '无')}；回执：${member.receiptRef ?? '尚未接收'}；完成证明：${member.completionProof?.commandId ?? '无'}。`)
  lines.push(`待澄清：${snapshot.pendingClarifications.map(item => item.question).join('；') || '无'}；活动计划：${snapshot.outstanding.activeScheduleIds.length}；待结实例：${snapshot.outstanding.occurrenceIds.length}。`)
  for (const schedule of snapshot.schedules) {
    const rule = schedule.rule
    const timing = !rule ? '未记录' : rule.kind === 'once' ? timeText(rule.at, schedule.timezone)
      : `${rule.kind === 'daily' ? '每日' : `每周${'日一二三四五六'[rule.weekday]}`} ${rule.time}（${schedule.timezone}）`
    lines.push(`计划 ${schedule.scheduleId}：${statusText(schedule.state)}；约定时间：${timing}；下次：${timeText(schedule.nextDueAt, schedule.timezone)}；通知对象：${schedule.recipientIds.join('、') || '当前群'}${schedule.outcome ? `；结果：${statusText(schedule.outcome)}` : ''}。`)
  }
  const exceptional = snapshot.occurrences.filter(item => !item.cancelledAt && (['failed','expired','blocked'].includes(item.actionState) || item.deliveryState === 'failed'))
  if (exceptional.length) {
    const expired = exceptional.filter(item => item.actionState === 'expired').length
    lines.push(`异常执行记录 ${exceptional.length} 次，其中过期 ${expired} 次。${expired ? '过期表示错过允许补执行的时间，本次未执行。' : ''}`)
  }
  if (snapshot.occurrences.length > 20) lines.push(`执行记录共 ${snapshot.occurrences.length} 次，以下为最近 20 次。`)
  for (const occurrence of snapshot.occurrences.slice(-20)) lines.push(`执行记录 ${occurrence.occurrenceId}：${statusText(occurrence.actionState)}${occurrence.cancelledAt ? '；已取消本次安排' : ''}；原计划时间：${timeText(occurrence.plannedAt)}；结果通知：${statusText(occurrence.deliveryState)}${occurrence.failureReason ? `；原因：${reasonText(occurrence.failureReason)}` : ''}${occurrence.resultRef ? `；结果记录：${occurrence.resultRef}` : ''}。`)
  for (const job of snapshot.jobs.filter(job => job.failureReason).slice(-20)) lines.push(`作业 ${job.jobId}：${statusText(job.state)}；原因：${reasonText(job.failureReason)}。`)
  return lines.join('\n')
}
