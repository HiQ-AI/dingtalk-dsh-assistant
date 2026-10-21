// Read authoritative facts and persist a bounded cross-task view. Delivery is a
// separate obligation; neither a receipt nor a released lock proves completion.
export function coordinationSnapshot({ coordination, members, tasks, schedules, occurrences, jobs }) {
  const items = members.map(m => {
    const task = tasks.find(t => t.taskId === m.taskId)
    const blocked = task?.status === 'active' && !['fulfilled','cancelled','superseded'].includes(m.state)
      && m.control !== 'cancelled' && task?.lastDecision?.action === 'blocked'
    return { instructionId: m.id, taskId: m.taskId, requirement: m.command.args.text ?? m.command.args.request ?? task?.objective ?? '',
      state: m.waitingReason?.code === 'target_version_changed' ? 'version_changed' : m.state === 'fulfilled' ? 'fulfilled' : m.control === 'cancelled' ? 'cancelled' : m.control === 'paused' ? 'paused' : m.state,
      control: m.control ?? 'active',
      effectiveVersion: m.effectiveVersion ?? null, waitingReason: m.waitingReason ?? null,
      commandId: m.command.id, receiptRef: m.receipt ? m.command.id : null, completionProof: m.completionProof ?? null,
      blocker: blocked ? task.lastDecision.summary : null }
  })
  const fulfilled = items.filter(m => m.state === 'fulfilled').length
  const cancelled = items.filter(m => m.state === 'cancelled').length
  const remaining = items.filter(m => !['fulfilled','cancelled','superseded'].includes(m.state))
  const activePlan = schedules.some(s => ['active','paused','needs_clarification'].includes(s.state))
  const unsettled = occurrences.some(o => ['waiting','running'].includes(o.actionState) || ['pending','unknown'].includes(o.deliveryState))
  const failed = items.some(m => m.blocker || m.waitingReason?.code === 'target_version_changed')
    || occurrences.some(o => ['failed','expired'].includes(o.actionState) || o.deliveryState === 'failed')
  let state = 'active'
  if (coordination.state === 'needs_clarification') state = 'needs_attention'
  else if (coordination.state === 'cancelled') state = fulfilled ? 'partially_completed' : 'cancelled'
  else if (failed) state = fulfilled ? 'partially_completed' : 'needs_attention'
  else if (!activePlan && !unsettled && !remaining.length && (items.length || occurrences.length || schedules.length))
    state = cancelled ? fulfilled ? 'partially_completed' : 'cancelled' : 'completed'
  else if (!items.length && !schedules.length && !occurrences.length) state = 'needs_attention'
  return { coordinationId: coordination.id, revision: coordination.revision, state, members: items,
    fulfilled, remainingInstructionIds: remaining.map(m => m.instructionId),
    schedules: schedules.map(s => ({ scheduleId: s.id, revision: s.revision, state: s.state, nextDueAt: s.nextDueAt, outcome: s.outcome ?? null })),
    occurrences: occurrences.map(o => ({ occurrenceId: o.id, actionState: o.actionState, deliveryState: o.deliveryState,
      resultRef: o.result ? `${o.id}:result:${o.resultVersion ?? 1}` : null, notificationId: o.notificationId ?? null })),
    jobs: jobs.map(j => ({ jobId: j.id, state: j.state, failureReason: j.failureReason ?? null })),
    outstanding: { instructionIds: remaining.map(m => m.instructionId), occurrenceIds: occurrences.filter(o => ['waiting','running'].includes(o.actionState)
      || ['pending','unknown'].includes(o.deliveryState)).map(o => o.id), activeScheduleIds: schedules.filter(s => ['active','paused'].includes(s.state)).map(s => s.id) } }
}
