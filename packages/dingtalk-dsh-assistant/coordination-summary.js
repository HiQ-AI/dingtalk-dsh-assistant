import { assertGroupReply } from './group-message.js'

// Read authoritative facts and persist a bounded cross-task view. Delivery is a
// separate obligation; neither a receipt nor a released lock proves completion.
export function coordinationSnapshot({ coordination, members, tasks, schedules, occurrences, jobs }) {
  const items = members.map(m => {
    const task = tasks.find(t => t.taskId === m.taskId)
    const blocked = task?.status === 'active' && !['fulfilled','cancelled','superseded','template'].includes(m.state)
      && m.control !== 'cancelled' && task?.lastDecision?.action === 'blocked'
    return { instructionId: m.id, taskId: m.taskId, title: task?.title ?? task?.objective ?? task?.request ?? '', observation: m.observation === true,
      requirement: m.observation ? '只观察原任务当前版本的正式完成，不追加要求或唤醒任务' : m.command.args.text ?? m.command.args.request ?? task?.objective ?? '',
      ...(m.recurringTemplateScheduleId ? { authorizationTemplateScheduleId: m.recurringTemplateScheduleId } : {}),
      state: m.state === 'template' ? 'template' : m.recurringOccurrenceId && ['fulfilled','superseded'].includes(m.state) ? m.state : m.waitingReason?.code === 'target_version_changed' ? 'version_changed' : m.state === 'fulfilled' ? 'fulfilled' : m.control === 'cancelled' ? 'cancelled' : m.control === 'paused' ? 'paused' : m.state,
      control: m.control ?? 'active',
      effectiveVersion: m.effectiveVersion ?? null, waitingReason: m.waitingReason ?? null,
      ...(m.reorderAssessment ? {reorderAssessment:{id:m.reorderAssessment.id,state:m.reorderAssessment.state,
        decision:m.reorderAssessment.decision ?? null,summary:m.reorderAssessment.summary ?? null,evidence:m.reorderAssessment.evidence ?? []}} : {}),
      commandId: m.command.id, receiptRef: m.receipt ? m.command.id : null, completionProof: m.completionProof ?? null,
      blocker: m.waitingReason?.code === 'target_version_changed' ? null : m.reorderAssessment?.state === 'needs_clarification' && !['cancelled','fulfilled','superseded'].includes(m.state)
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
  if (coordination.state === 'cancelled') state = coordination.retirement?.kind === 'observation-only' ? 'cancelled' : fulfilled ? 'partially_completed' : 'cancelled'
  else if (coordination.state === 'needs_clarification' || pendingClarifications.length) state = 'needs_attention'
  else if (failed) state = fulfilled ? 'partially_completed' : 'needs_attention'
  else if (!activePlan && !unsettled && !remaining.length && (items.length || occurrences.length || schedules.length))
    state = cancelled || occurrences.some(o => o.cancelledAt || o.actionState === 'cancelled')
      ? fulfilled || occurrences.some(o => o.actionState === 'succeeded' && !o.cancelledAt) ? 'partially_completed' : 'cancelled' : 'completed'
  else if (!items.length && !schedules.length && !occurrences.length) state = 'needs_attention'
  return { coordinationId: coordination.id, revision: coordination.revision, state, members: items, pendingClarifications,
    fulfilled, remainingInstructionIds: remaining.map(m => m.instructionId),
    schedules: schedules.map(s => ({ scheduleId: s.id, revision: s.revision, state: s.state, nextDueAt: s.nextDueAt, outcome: s.outcome ?? null,
      ...(s.action?.kind === 'message-reminder' ? { reminderText: s.action.text } : {}),
      timezone: s.timezone ?? null, rule: s.rule ?? null, recipientIds: s.target?.recipientIds ?? [] })),
    occurrences: occurrences.map(o => ({ occurrenceId: o.id, scheduleId: o.scheduleId ?? null, plannedAt: o.plannedAt ?? null,
      cancelledAt: o.cancelledAt ?? null, ...(o.paused ? { paused: true } : {}),
      recipientIds: o.target?.recipientIds ?? [],
      ...(o.action?.kind === 'task-command' ? { actionKind: o.action.kind, instructionIds: o.action.instructionIds } : {}),
      actionState: o.actionState, deliveryState: o.deliveryState,
      failureReason: o.failureReason ?? null,
      resultRef: o.result ? `${o.id}:result:${o.resultVersion ?? 1}` : null, notificationId: o.notificationId ?? null })),
    jobs: jobs.map(j => ({ jobId: j.id, state: j.state, failureReason: j.failureReason ?? j.waitingReason ?? null })),
    outstanding: { instructionIds: remaining.map(m => m.instructionId), clarificationIds: coordination.state === 'cancelled' ? [] : pendingClarifications.map(p => p.clarificationId), occurrenceIds: occurrences.filter(o => !o.cancelledAt && ['waiting','running','blocked'].includes(o.actionState)
      || ['pending','unknown'].includes(o.deliveryState)).map(o => o.id), activeScheduleIds: schedules.filter(s => ['active','paused'].includes(s.state)).map(s => s.id) } }
}

/** 自动通知只比较业务变化；完整快照仍用于审计和发送前版本校验。 */
export function coordinationNotificationState(snapshot) {
  const failure = reason => typeof reason === 'string' ? reason : reason?.code ?? null
  return { state: snapshot.state,
    members: snapshot.members.map(member => ({ instructionId: member.instructionId, taskId: member.taskId,
      title: member.title ?? null, requirement: member.requirement, state: member.state, control: member.control,
      blocked: Boolean(member.blocker), waitingReason: failure(member.waitingReason),
      clarification: member.reorderAssessment?.state === 'needs_clarification' ? member.reorderAssessment.summary : null })),
    pendingClarifications: snapshot.pendingClarifications,
    schedules: snapshot.schedules.map(schedule => ({ scheduleId: schedule.scheduleId, state: schedule.state,
      nextDueAt: schedule.nextDueAt ?? null, reminderText: schedule.reminderText ?? null, timezone: schedule.timezone,
      rule: schedule.rule, recipientIds: schedule.recipientIds })),
    occurrences: snapshot.occurrences.map(occurrence => ({ occurrenceId: occurrence.occurrenceId, scheduleId: occurrence.scheduleId,
      plannedAt: occurrence.plannedAt, cancelled: Boolean(occurrence.cancelledAt), paused: Boolean(occurrence.paused),
      actionState: occurrence.actionState, deliveryState: occurrence.deliveryState, failure: failure(occurrence.failureReason),
      recipientIds: occurrence.recipientIds })),
    jobs: snapshot.jobs.map(job => ({ jobId: job.jobId, state: job.state, failure: failure(job.failureReason) })) }
}

const statusLabels = { active: '进行中', completed: '已完成', partially_completed: '部分完成', needs_attention: '需要处理',
  needs_clarification: '还需要补充信息', cancelled: '已取消', paused: '已暂停', ready: '等待处理', observing: '等待原事项完成',
  applied: '已接收，尚未完成', fulfilled: '已完成', template: '按约定周期处理', superseded: '已由新安排替代', version_changed: '当前状态需重新核对',
  waiting: '等待执行', running: '执行中', succeeded: '已执行', failed: '未能完成', blocked: '暂时受阻', expired: '已过期，本次未执行' }
const statusText = state => statusLabels[state] ?? '状态待核实'
const sentence = value => { const text = String(value ?? '').trim(); return text ? /[。！？!?]$/u.test(text) ? text : `${text}。` : '' }
const body = value => String(value ?? '').trim().replace(/。+$/u, '')
const cancellationDeliveryText = occurrence => occurrence?.deliveryState === 'unknown' ? '之前的通知是否送达尚未确认。'
  : occurrence?.deliveryState === 'delivered' ? '之前的通知已经送达，取消不会撤回已发消息。' : ''
const workingTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const zoneLabel = (timeZone, instant = new Date()) => timeZone === 'Asia/Shanghai' ? '北京时间'
  : new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'long' }).formatToParts(instant).find(item => item.type === 'timeZoneName').value

/** 群内只展示工作时区的时间；同一单次约定不重复列出 UTC 和“下次时间”。 */
export function formatCoordinationTime(instant, timeZone = workingTimeZone()) {
  if (!instant || !Number.isFinite(Date.parse(instant))) return ''
  const date = new Date(instant), parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(item => [item.type, item.value]))
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}${parts.second === '00' ? '' : `:${parts.second}`}（${zoneLabel(timeZone, date)}）`
}

export function formatCoordinationTiming(rule, timezone, timeZone = workingTimeZone()) {
  if (!rule) return ''
  if (rule.kind === 'once') return formatCoordinationTime(rule.at, timeZone)
  // 周期时间属于约定的当地钟点，不能直接贴上另一时区；下次具体时刻另按工作时区显示。
  return `${rule.kind === 'daily' ? '每天' : `每周${'日一二三四五六'[rule.weekday]}`} ${rule.time}（${zoneLabel(timezone ?? timeZone)}）`
}

const reasonLabels = {
  authorization_changed: '相关授权已变化，暂时无法继续', target_version_changed: '当前状态需重新核对',
  waiting_batch_clarification: '还需要补充安排信息', waiting_dependency: '需要先完成前面的事项',
  dependency_pending: '需要先完成前面的事项', paused: '安排已暂停', cancelled: '安排已取消',
  waiting_trigger: '尚未满足约定的执行条件', trigger_paused: '安排已暂停', trigger_cancelled: '安排已取消', trigger_superseded: '已由新安排替代',
  waiting_completion_proof: '还在等待完成结果', reorder_pending: '正在核对调整后的处理顺序', reorder_needs_clarification: '调整处理顺序还需要补充信息',
  DYNAMIC_COORDINATION_RECURRING_AUTHORIZATION_STALE: '相关授权已变化，暂时无法继续',
  DYNAMIC_COORDINATION_RECURRING_TASK_STATE_CHANGED: '任务状态已变化，需要核对后继续',
}
// 技术失败码和诊断对象用于账本核查，不作为正文直接输出或 JSON.stringify。
const reasonText = reason => reason ? reasonLabels[typeof reason === 'string' ? reason : reason.code] ?? '处理遇到问题，原因仍需核查' : ''

/** 接纳与修改只说明已保存的业务安排，不输出提案解释、内部编号或实现协议。 */
export function formatCoordinationAcceptance(proposal, { memberCount = 0, schedule, occurrence, timeZone = workingTimeZone() } = {}) {
  if (proposal?.kind === 'resolve') return formatCoordinationAcceptance(proposal.resolution, { memberCount, timeZone })
  if (proposal?.kind === 'query') return proposal.answerText
  if (proposal?.pendingClarifications?.length) return `${memberCount ? '已记录明确的安排。' : ''}${proposal.pendingClarifications.map(item => sentence(item.question)).join('')}`
  if (proposal?.kind === 'schedule') {
    const timing = formatCoordinationTiming(proposal.rule, proposal.timezone, timeZone)
    return proposal.actionKind === 'message-reminder' ? sentence(`已安排提醒：${timing}，${body(proposal.reminderText)}`)
      : sentence(`已安排在${timing}${proposal.actionKind === 'task-command' ? '处理这些事项' : '查看进度'}`)
  }
  if (proposal?.kind === 'schedule-change') {
    const reminder = schedule?.action?.kind === 'message-reminder', subject = reminder ? '提醒' : '安排'
    const detail = reminder ? `：${body(schedule.action.text)}` : ''
    // 丢失确认后的恢复可能读到后来再次调整的计划，只说明当前事实，不能混用旧动作与新时间。
    if (schedule?.revision > proposal.expectedScheduleRevision + 1) return sentence(`这项${subject}后来又有调整，目前${schedule.state === 'active'
      ? `安排在${formatCoordinationTiming(schedule.rule, schedule.timezone, timeZone)}` : statusText(schedule.state)}${detail}`)
    if (proposal.state === 'cancelled') return sentence(`已取消这项${subject}的后续安排${detail}`)
    if (proposal.state === 'paused') return sentence(`已暂停这项${subject}${detail}`)
    if (proposal.rule || proposal.replacementPlannedAt || proposal.timezone) {
      const rule = proposal.replacementPlannedAt ? { kind: 'once', at: proposal.replacementPlannedAt } : proposal.rule ?? schedule?.rule
      return sentence(`已将${subject}时间改为${formatCoordinationTiming(rule, schedule?.timezone ?? proposal.timezone, timeZone)}${detail}`)
    }
    if (proposal.state === 'active') return sentence(`已恢复这项${subject}${detail}`)
    return sentence(`已更新这项${subject}${proposal.recipientIds ? '的通知对象' : ''}${detail}`)
  }
  if (proposal?.kind === 'occurrence-control') {
    const subject = occurrence?.action?.kind === 'message-reminder' ? '提醒' : '安排'
    if (occurrence?.instanceControlRevision > proposal.expectedControlRevision + 1) return sentence(`这次${subject}后来又有调整，目前${occurrence.cancelledAt ? '已取消'
      : occurrence.paused ? '已暂停' : statusText(occurrence.actionState)}`)
      + (occurrence.cancelledAt ? cancellationDeliveryText(occurrence) : '')
    return sentence(`已${{ pause: '暂停', resume: '恢复', cancel: '取消' }[proposal.control]}本次${subject}`)
      + (proposal.control === 'cancel' ? cancellationDeliveryText(occurrence) : '')
  }
  if (proposal?.kind === 'change') return sentence({ pause: '已暂停所选安排', resume: '已恢复所选安排', cancel: '已取消所选安排',
    append: '已补充新的安排', reorder: '已更新处理顺序' }[proposal.change.action])
  return '已记录你的安排。'
}

/** 复用权威快照，但只选业务内容展示；审计身份、版本、回执和收件人标识仍留在账本。 */
export function formatCoordinationSnapshot(snapshot, { timeZone = workingTimeZone(), requesterId, recipientNames = new Map() } = {}) {
  const lines = []
  for (const member of snapshot.members) {
    let detail = member.state === 'version_changed' ? '' : member.blocker || reasonText(member.waitingReason)
    // 历史诊断保留在快照；含内部身份的阻塞原因改成明确的待核查说明，不截取拼接残句。
    if (detail && member.blocker) try { assertGroupReply(member.blocker, [snapshot.coordinationId, member.instructionId, member.taskId, member.commandId, member.receiptRef]) }
    catch (error) { if (error.code !== 'GROUP_REPLY_INTERNAL_DETAILS') throw error; detail = reasonText(member.waitingReason) || '处理暂时受阻，具体原因还需核查' }
    lines.push(`${sentence(`${body(member.observation ? member.title : member.requirement) || '这项工作'}：${statusText(member.state)}`)}${sentence(detail)}`)
  }
  if (snapshot.state !== 'cancelled') lines.push(...snapshot.pendingClarifications.map(item => sentence(item.question)))
  const schedules = new Map(snapshot.schedules.map(item => [item.scheduleId, item]))
  for (const schedule of snapshot.schedules) {
    if (schedule.rule?.kind === 'once' && snapshot.occurrences.some(item => item.scheduleId === schedule.scheduleId
      && Date.parse(item.plannedAt) === Date.parse(schedule.rule.at))) continue
    const subject = schedule.reminderText ? `提醒内容：${body(schedule.reminderText)}` : '定时安排'
    const timing = formatCoordinationTiming(schedule.rule, schedule.timezone, timeZone)
    const state = schedule.state === 'active' ? '已安排' : statusText(schedule.state)
    const recipients = [...new Set((schedule.recipientIds ?? []).map(id => id === requesterId ? '你' : recipientNames.get(id)?.trim() || '指定人员'))]
    lines.push(`${sentence(subject)}${timing ? sentence(`时间：${timing}`) : ''}${sentence(state)}${schedule.state === 'active' && schedule.rule?.kind !== 'once' && schedule.nextDueAt ? sentence(`下次时间：${formatCoordinationTime(schedule.nextDueAt, timeZone)}`) : ''}${schedule.state === 'active' ? sentence(recipients.length ? `到时在本群通知${recipients.join('、')}` : '通知会发到本群') : ''}`)
  }
  if (snapshot.occurrences.length > 20) lines.push('以下是最近 20 次执行情况。')
  for (const occurrence of snapshot.occurrences.slice(-20)) {
    const schedule = schedules.get(occurrence.scheduleId), reminder = Boolean(schedule?.reminderText)
    const timing = formatCoordinationTime(occurrence.plannedAt, timeZone)
    const subject = `${timing ? `原定于${timing}的` : '本次'}${reminder ? '提醒' : '安排'}`
    let state = occurrence.cancelledAt ? '已取消' : occurrence.paused ? '已暂停' : statusText(occurrence.actionState)
    if (!occurrence.cancelledAt && occurrence.actionState === 'succeeded') state = occurrence.deliveryState === 'delivered'
      ? reminder ? '已送达' : '已执行，结果已送达' : occurrence.deliveryState === 'failed'
        ? reminder ? '通知发送失败，送达情况需要核查' : '已执行，但结果通知发送失败，送达情况需要核查' : occurrence.deliveryState === 'unknown'
          ? reminder ? '是否送达尚未确认' : '已执行，结果通知是否送达尚未确认' : occurrence.deliveryState === 'pending'
            ? reminder ? '正在等待发送' : '已执行，正在等待发送结果' : '已执行'
    if (!occurrence.cancelledAt && occurrence.actionState === 'succeeded' && occurrence.actionKind === 'task-command') {
      // 命令接纳与通知送达都不是 Task 的正式完成证明。
      const members = occurrence.instructionIds.map(id => snapshot.members.find(member => member.instructionId === id))
      const completed = members.length > 0 && members.every(member => member?.state === 'fulfilled' && member.completionProof)
      state = completed ? '对应任务已正式完成' : '已接纳处理要求，任务尚未正式完成'
    }
    const delivery = occurrence.cancelledAt ? cancellationDeliveryText(occurrence) : ''
    lines.push(`${sentence(`${subject}${state}`)}${reminder ? sentence(`提醒内容：${body(schedule.reminderText)}`) : ''}${delivery}${!occurrence.cancelledAt ? sentence(reasonText(occurrence.failureReason)) : ''}`)
  }
  // 执行记录已说明失败时，不再重复列一次作业及其内部失败码。
  if (!snapshot.occurrences.some(item => item.failureReason)) for (const job of snapshot.jobs.filter(item => item.failureReason).slice(-20))
    lines.push(`${sentence(`安排${statusText(job.state)}`)}${sentence(reasonText(job.failureReason))}`)
  return lines.join('\n') || sentence(snapshot.state === 'needs_attention' ? '这项安排还需要补充信息' : `这项安排${statusText(snapshot.state)}`)
}
