import { coordinationSnapshot } from './coordination-summary.js'
import { quotedSendRejectionProof } from './group-message.js'

const text = value => typeof value === 'string' ? value : null
const texts = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
const code = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,119}$/u.test(value) ? value : null
const bound = values => values.slice(-100)
const collection = values => ({ total: values.length, returned: Math.min(values.length, 100), truncated: values.length > 100 })
const sourceView = source => ({ id: source.id, groupId: source.groupId, original: source.original,
  createdAt: source.createdAt, state: source.state, settled: source.settled === true,
  coordinationId: text(source.coordinationId), acceptedKind: text(source.acceptedKind), acceptedRevision: source.acceptedRevision ?? null,
  question: text(source.question), answerText: text(source.acceptedProposal?.answerText), rejectionReason: text(source.rejectionReason), attemptCount: source.attemptCount ?? 0,
  nextRetryAt: text(source.nextRetryAt), failureCode: source.lastError ? 'coordination_processing_failed' : null })
const proofView = proof => proof ? { eventId: text(proof.eventId), commandId: text(proof.commandId),
  requirementRevision: proof.requirementRevision ?? null, contextRevision: proof.contextRevision ?? null,
  controlRevision: proof.controlRevision ?? null, runSequence: proof.runSequence ?? null } : null

const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
const actionInstructions = action => texts(action?.instructionIds ?? action?.onIncomplete?.instructionIds)
const ruleView = rule => rule ? { kind: text(rule.kind), at: text(rule.at), time: text(rule.time), weekday: rule.weekday ?? null } : null
const lastStamp = values => values.filter(instant).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null
const resultView = (code, label, tone = 'neutral') => ({ code, label, tone })
const reasonLabels = {
  waiting_dependency: '等待前置事项完成', target_version_changed: '任务要求已变化，需要核对',
  DYNAMIC_COORDINATION_VERSION_STALE: '任务版本已变化，需要核对',
  DYNAMIC_COORDINATION_RECURRING_AUTHORIZATION_STALE: '相关授权已变化，需要核对',
  DYNAMIC_COORDINATION_RECURRING_TASK_STATE_CHANGED: '任务状态已变化，需要核对',
}
const failureCode = reason => {
  const value = typeof reason === 'object' ? reason?.code : reason
  return Object.hasOwn(reasonLabels, value) ? value : reason ? 'coordination_trigger_failed' : null
}
function currentProof(member, task) {
  const proof = member.completionProof, version = member.effectiveVersion ?? member.preconditionVersion
  return member.state === 'fulfilled'
    && proof && version && task?.status === 'completed' && task.completion?.commandId === proof.commandId
    && (member.observation || texts(task.completion.instructionIds).includes(member.id))
    && ['requirementRevision', 'controlRevision', 'runSequence'].every(key => proof[key] === task[key] && version[key] === task[key])
    && Number.isSafeInteger(proof.contextRevision) && proof.contextRevision >= version.contextRevision
    && proof.contextRevision === (task.contextRevision ?? 0)
}
function workResult({ schedule, occurrence, members, tasks, executions, coordination, jobs, cancelledBeforeSend }) {
  const reminder = (occurrence?.action ?? schedule?.action)?.kind === 'message-reminder'
  if (occurrence?.deliveryState === 'failed') return resultView('delivery_failed', reminder ? '提醒发送失败' : '结果通知发送失败', 'danger')
  if (occurrence?.deliveryState === 'unknown') return resultView('delivery_unknown', reminder ? '提醒是否送达尚未确认' : '结果通知是否送达尚未确认', 'warning')
  if (occurrence && (!['waiting', 'running', 'succeeded', 'failed', 'blocked', 'expired', 'unknown', 'cancelled', 'superseded'].includes(occurrence.actionState)
    || !['none', 'pending', 'delivered', 'failed', 'unknown', 'cancelled'].includes(occurrence.deliveryState))) return resultView('unknown', '状态未确认', 'warning')
  if (['failed', 'blocked', 'expired', 'unknown'].includes(occurrence?.actionState)) {
    const state = occurrence.actionState, reason = reasonLabels[failureCode(occurrence.failureReason)]
    return resultView(state === 'failed' ? 'action_failed' : state,
      reason ?? { failed: '本次执行失败', blocked: '本次执行受阻', expired: '本次已过期，未执行', unknown: '本次执行结果未确认' }[state], state === 'failed' ? 'danger' : 'warning')
  }
  const unfinished = members.filter(member => !currentProof(member, tasks.find(task => task.taskId === member.taskId))
    && !['cancelled', 'superseded', 'template'].includes(member.state) && member.control !== 'cancelled')
  const blocked = unfinished.some(member => member.waitingReason?.code === 'target_version_changed'
    || member.reorderAssessment?.state === 'needs_clarification'
    || tasks.find(task => task.taskId === member.taskId)?.lastDecision?.action === 'blocked')
  if (blocked) return resultView('blocked', unfinished.some(member => member.waitingReason?.code === 'target_version_changed')
    ? reasonLabels.target_version_changed : '任务调度受阻', 'warning')
  if (occurrence?.actionState === 'running' || jobs.some(job => job.occurrenceId === occurrence?.id && job.state === 'running')
    || unfinished.some(member => executions.some(execution => execution.taskId === member.taskId && execution.status === 'running'
      && !execution.drained && !execution.recovering && texts(execution.instructionScope?.instructionIds).includes(member.id)
      && ['requirementRevision', 'controlRevision', 'runSequence'].every(key => execution.instructionScope[key] === (member.effectiveVersion ?? member.preconditionVersion)?.[key])
      && (execution.instructionScope.contextRevision ?? 0) >= ((member.effectiveVersion ?? member.preconditionVersion)?.contextRevision ?? 0))))
    return resultView('running', '正在执行', 'info')
  if (occurrence?.deliveryState === 'pending') return resultView('delivery_pending', reminder ? '提醒待送达' : '结果通知待送达', 'info')
  if (members.length && members.every(member => currentProof(member, tasks.find(task => task.taskId === member.taskId))))
    return resultView('task_completed', '对应任务已正式完成', 'success')
  if (cancelledBeforeSend) return resultView('cancelled', '后续安排已取消')
  if (occurrence?.deliveryState === 'delivered') return resultView('delivered', reminder ? '提醒已送达' : '结果通知已送达', 'success')
  if (occurrence?.actionState === 'succeeded') return resultView('dispatched', occurrence.action?.kind === 'task-command' ? '任务已调度，尚未正式完成' : '本次查询已执行', 'info')
  if (members.some(member => currentProof(member, tasks.find(task => task.taskId === member.taskId))))
    return resultView('partially_completed', '部分任务已正式完成', 'info')
  if (!['active', 'paused', 'cancelled', 'completed', 'needs_clarification'].includes(schedule?.state ?? 'active')
    || !['active', 'cancelled', 'needs_clarification'].includes(coordination.state)
    || members.some(member => !['ready', 'applied', 'fulfilled', 'cancelled', 'superseded', 'template', 'observing'].includes(member.state)
      || !['active', 'paused', 'cancelled'].includes(member.control ?? 'active'))) return resultView('unknown', '状态未确认', 'warning')
  if (occurrence?.cancelledAt || coordination.state === 'cancelled' || schedule?.state === 'cancelled'
    || members.length && members.every(member => member.control === 'cancelled' || member.state === 'cancelled'))
    return resultView('cancelled', '后续安排已取消')
  if (occurrence?.paused || schedule?.state === 'paused' || members.length && members.every(member => member.control === 'paused'))
    return resultView('paused', '后续安排已暂停')
  if (schedule?.state === 'active' && instant(schedule.nextDueAt)) return resultView('scheduled', '已安排触发', 'info')
  if (schedule && !occurrence) return resultView('no_occurrence', '无触发记录')
  if (unfinished.some(member => member.state === 'applied')) return resultView('dispatched', '任务已调度，尚未正式完成', 'info')
  if (occurrence?.actionState === 'waiting' || unfinished.some(member => ['ready', 'observing'].includes(member.state)))
    return resultView('waiting', '等待处理')
  return resultView('unknown', '状态未确认', 'warning')
}

// This reader receives only query, never a command capability or raw runtime DTO.
export function createCoordinationObserver(query) {
  async function readWork(groupId) {
    const [coordinations, schedules, occurrences, jobs, notifications, sources, executions] = await Promise.all([
      query('coordination.list', { groupId }), query('coordination.schedule.list'), query('coordination.occurrence.list'),
      query('coordination.job.list'), query('notification.list'), query('coordination.source.list'), query('execution.list'),
    ])
    const entities = []
    for (const coordination of coordinations) {
      const { members } = await query('coordination.get', { coordinationId: coordination.id })
      const tasks = (await Promise.all([...new Set(members.map(member => member.taskId))].map(taskId => query('task.get', { taskId })))).filter(Boolean)
      const ownSchedules = schedules.filter(schedule => schedule.coordinationId === coordination.id)
      const ownOccurrences = occurrences.filter(occurrence => occurrence.coordinationId === coordination.id)
      const covered = new Set()
      const add = (kind, id, schedule, entityOccurrences, entityMembers) => {
        entityMembers.forEach(member => covered.add(member.id))
        const occurrenceIds = new Set(entityOccurrences.map(occurrence => occurrence.id))
        const entityJobs = jobs.filter(job => occurrenceIds.has(job.occurrenceId))
        const candidates = entityOccurrences.filter(item => item.actionState !== 'superseded' && !item.replacedBy && !item.mergedInto)
          .sort((a, b) => Date.parse(a.plannedAt ?? a.acceptedAt) - Date.parse(b.plannedAt ?? b.acceptedAt) || a.id.localeCompare(b.id))
        // A queued future slot must not erase the last actual delivery/execution result.
        const selected = candidates.filter(item => !['waiting', 'cancelled'].includes(item.actionState)).at(-1) ?? candidates.at(-1)
        const notification = selected ? notifications.find(item => item.id === selected.notificationId) : null
        const cancelledBeforeSend = notification?.state === 'failed' && notification.reason === 'coordination_cancelled'
          && !notification.sendPermit && !(notification.sendAttemptCount > 0) && !notification.ack && !notification.receipt
        // A denied permit is cancellation, not a send failure; real terminal effects survive later control changes.
        const occurrence = selected && !cancelledBeforeSend && ['delivered', 'failed', 'unknown'].includes(notification?.state)
          ? { ...selected, deliveryState: notification.state } : selected
        const ids = new Set(actionInstructions(occurrence?.action))
        const currentMembers = occurrence && ids.size ? entityMembers.filter(member => ids.has(member.id))
          : entityMembers.filter(member => member.state !== 'template' && !member.recurringOccurrenceId)
        const result = workResult({ schedule, occurrence, members: currentMembers, tasks, executions, coordination, jobs: entityJobs, cancelledBeforeSend })
        const state = coordination.state === 'cancelled' ? 'cancelled' : schedule?.state
          ?? (occurrence?.cancelledAt ? 'cancelled' : occurrence?.paused ? 'paused'
            : currentMembers.length && currentMembers.every(member => member.control === 'paused') ? 'paused'
            : currentMembers.length && currentMembers.every(member => member.control === 'cancelled' || member.state === 'cancelled') ? 'cancelled' : 'active')
        const recurrence = text(schedule?.rule?.kind)
        const planLabel = { active: recurrence && recurrence !== 'once' ? '周期计划已启用' : '安排已启用', paused: '后续安排已暂停',
          cancelled: '后续安排已取消', completed: '单次计划已结束', needs_clarification: '计划需要补充信息' }[state] ?? '计划状态未确认'
        const triggerAt = state === 'active' ? instant(schedule?.nextDueAt) : null
        const canSendRetry = notification?.state === 'failed' && !notification.ack && !notification.receipt
          && notification.deliveryError?.knownNotSent === true && notification.deliveryError?.retryable === true
          && quotedSendRejectionProof(notification.deliveryError, { groupId: notification.payload?.conversationId,
            replyToMessageId: notification.payload?.sourceMessageId, replyToSenderOpenDingTalkId: notification.payload?.actorId, idempotencyKey: notification.id })
        const sendRetryAt = state !== 'cancelled' && !occurrence?.cancelledAt && canSendRetry ? instant(notification.nextAttemptAt) : null
        const readbackAt = ['unknown', 'starting'].includes(notification?.state) ? instant(notification.nextAttemptAt) : null
        const nextLabel = [triggerAt ? '已安排下次触发' : '无后续触发安排',
          sendRetryAt ? '已安排重试发送' : readbackAt ? '已安排核实送达' : '无重试安排'].join('；')
        const sourceHistory = sources.filter(source => source.coordinationId === coordination.id)
        const fulfilled = currentMembers.filter(member => currentProof(member, tasks.find(task => task.taskId === member.taskId))).length
        const pendingMembers = currentMembers.filter(member => !currentProof(member, tasks.find(task => task.taskId === member.taskId))
          && !['cancelled', 'superseded', 'template'].includes(member.state) && member.control !== 'cancelled')
        const blockedCount = pendingMembers.filter(member => member.waitingReason?.code === 'target_version_changed'
          || member.reorderAssessment?.state === 'needs_clarification' || tasks.find(task => task.taskId === member.taskId)?.lastDecision?.action === 'blocked').length
        const snap = coordinationSnapshot({ coordination, members: entityMembers, tasks, schedules: schedule ? [schedule] : [], occurrences: entityOccurrences, jobs: entityJobs })
        const title = text(schedule?.action?.text ?? occurrence?.action?.text)
          ?? (kind === 'trigger' ? occurrence?.action?.kind === 'read-query' ? '条件触发查询' : '条件触发任务调度'
            : currentMembers.map(member => text(tasks.find(task => task.taskId === member.taskId)?.title) ?? text(member.command?.args?.text)).filter(Boolean).join('、'))
        const updatedAt = lastStamp([coordination.createdAt, ...sourceHistory.map(source => source.createdAt),
          ...entityOccurrences.flatMap(item => [item.acceptedAt, item.cancelledAt]), ...entityJobs.map(item => item.updatedAt),
          ...(schedule?.history ?? []).map(item => item.changedAt),
          notification?.updatedAt, ...currentMembers.map(member => tasks.find(task => task.taskId === member.taskId)?.updatedAt)])
        entities.push({ work: { id, kind, coordinationId: coordination.id, groupId: coordination.groupId, title: title || '任务调度', updatedAt,
          result, plan: { state, label: planLabel, recurrence, timezone: text(schedule?.timezone), rule: ruleView(schedule?.rule) },
          nextStep: { triggerAt, sendRetryAt, readbackAt, label: nextLabel },
          counts: { total: currentMembers.length, fulfilled, blocked: blockedCount, waiting: pendingMembers.length - blockedCount },
          scheduleId: text(schedule?.id), occurrenceId: text(occurrence?.id) },
          members: snap.members.map(item => {
            const member = entityMembers.find(member => member.id === item.instructionId), task = tasks.find(task => task.taskId === item.taskId)
            const validProof = Boolean(currentProof(member, task))
            return { instructionId: item.instructionId, taskId: item.taskId, title: text(task?.title),
              state: item.state === 'fulfilled' && !validProof ? 'version_changed' : item.state, taskState: text(task?.status),
              control: item.control, dependencies: texts(member.dependencies), requirement: text(item.requirement),
              observation: member.observation === true, progressImpact: text(member.progressImpact), impactReason: text(member.impactReason),
              waitingReason: item.waitingReason ? { code: code(item.waitingReason.code), dependencyInstructionIds: texts(item.waitingReason.dependencyInstructionIds) } : null,
              blocker: text(item.blocker), reorderAssessment: item.reorderAssessment ? { id: text(item.reorderAssessment.id),
                state: text(item.reorderAssessment.state), decision: text(item.reorderAssessment.decision), summary: text(item.reorderAssessment.summary), evidence: texts(item.reorderAssessment.evidence) } : null,
              decision: task?.lastDecision ? { action: text(task.lastDecision.action), summary: text(task.lastDecision.summary),
                evidence: texts(task.lastDecision.evidence), limitations: texts(task.lastDecision.limitations), at: text(task.lastDecision.at ?? task.lastDecision.createdAt) } : null,
              completionProof: validProof ? proofView(item.completionProof) : null, completionProofCurrent: validProof,
              historicalCompletionProof: !validProof ? proofView(item.completionProof) : null }
          }),
          history: { sources: sourceHistory.map(sourceView), changes: (coordination.history ?? []).map(item => ({ sourceId: text(item.sourceId),
            revision: item.revision ?? null, reason: text(item.reason), action: text(item.change?.action ?? item.action ?? item.kind), at: text(item.at) })).concat((schedule?.history ?? []).map(item => ({
            sourceId: null, revision: item.revision ?? null, reason: text(item.reason), action: 'schedule-revision', at: text(item.changedAt),
            scheduleId: schedule.id, state: text(item.state), timezone: text(item.timezone), rule: ruleView(item.rule), nextDueAt: text(item.nextDueAt),
          }))).sort((a, b) => String(a.at).localeCompare(String(b.at))),
          occurrences: entityOccurrences.map(item => ({ occurrenceId: item.id, scheduleId: text(item.scheduleId), plannedAt: text(item.plannedAt),
            cancelledAt: text(item.cancelledAt), paused: item.paused === true, actionKind: text(item.action?.kind), actionState: text(item.actionState),
            deliveryState: text(item.deliveryState), failureCode: failureCode(item.failureReason), replacementOf: text(item.replacementOf),
            replacedBy: text(item.replacedBy), mergedInto: text(item.mergedInto) })),
          jobs: entityJobs.map(item => ({ jobId: item.id, occurrenceId: item.occurrenceId, state: item.state, attempt: item.attempt ?? 0,
            failureCode: failureCode(item.failureReason ?? item.waitingReason) })) } })
      }
      for (const schedule of ownSchedules) {
        const entityOccurrences = ownOccurrences.filter(occurrence => occurrence.scheduleId === schedule.id)
        const ids = new Set([schedule.action, ...(schedule.history ?? []).map(item => item.action), ...entityOccurrences.map(item => item.action)].flatMap(actionInstructions))
        add('schedule', 'schedule:' + schedule.id, schedule, entityOccurrences, members.filter(member => ids.has(member.id)
          || member.recurringTemplateScheduleId === schedule.id || entityOccurrences.some(item => item.id === member.recurringOccurrenceId)))
      }
      for (const occurrence of ownOccurrences.filter(item => !item.scheduleId)) {
        const ids = new Set(actionInstructions(occurrence.action))
        add('trigger', 'trigger:' + occurrence.id, null, [occurrence], members.filter(member => ids.has(member.id)))
      }
      const direct = members.filter(member => !covered.has(member.id))
      if (direct.length) add('dispatch', 'dispatch:' + coordination.id, null, [], direct)
    }
    return entities.sort((a, b) => String(b.work.updatedAt).localeCompare(String(a.work.updatedAt)) || a.work.id.localeCompare(b.work.id))
  }
  return {
    async coordinationWork({ groupId, offset = 0, limit = 20 } = {}) {
      if (groupId !== undefined && (typeof groupId !== 'string' || !groupId.trim())
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('coordination_query_invalid')
      const entities = await readWork(groupId)
      return { works: entities.slice(offset, offset + limit).map(item => item.work), total: entities.length, offset, limit, observedAt: new Date().toISOString() }
    },
    async coordinationWorkDetail(workId) {
      if (typeof workId !== 'string' || !/^(schedule|dispatch|trigger):[^\s/\\\u0000-\u001f]{1,1000}$/u.test(workId)) throw new Error('coordination_query_invalid')
      const entity = (await readWork()).find(item => item.work.id === workId)
      if (!entity) return null
      const { work, members, history } = entity
      return { work, members: bound(members), history: Object.fromEntries(Object.entries(history).map(([key, values]) => [key, bound(values)])),
        collections: { members: collection(members), ...Object.fromEntries(Object.entries(history).map(([key, values]) => [key, collection(values)])) }, observedAt: new Date().toISOString() }
    },
    async coordinationSources({ groupId, offset = 0, limit = 20 } = {}) {
      if (groupId !== undefined && (typeof groupId !== 'string' || !groupId.trim())
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('coordination_query_invalid')
      const sources = await query('coordination.source.list', { groupId })
      sources.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id))
      return { sources: sources.slice(offset, offset + limit).map(sourceView), total: sources.length, offset, limit, observedAt: new Date().toISOString() }
    },
    async coordinationSourceDetail(sourceId) {
      const source = (await query('coordination.source.list')).find(item => item.id === sourceId)
      if (!source) return null
      const observedAt = new Date().toISOString()
      if (!source.coordinationId) return { source: sourceView(source), coordination: null, snapshot: null, members: [], observedAt,
        collections: Object.fromEntries(['history', 'members', 'schedules', 'occurrences', 'jobs', 'pendingClarifications'].map(key => [key, collection([])])) }
      const { coordination, members } = await query('coordination.get', { coordinationId: source.coordinationId })
      const tasks = (await Promise.all([...new Set(members.map(member => member.taskId))].map(taskId => query('task.get', { taskId })))).filter(Boolean)
      const schedules = await query('coordination.schedule.list', { coordinationId: coordination.id })
      const occurrences = await query('coordination.occurrence.list', { coordinationId: coordination.id })
      const occurrenceIds = new Set(occurrences.map(item => item.id))
      const jobs = (await query('coordination.job.list')).filter(item => occurrenceIds.has(item.occurrenceId))
      // Compute the authoritative aggregate before bounding presentation collections.
      const snapshot = coordinationSnapshot({ coordination, members, tasks, schedules, occurrences, jobs })
      const history = coordination.history ?? [], clarifications = snapshot.pendingClarifications
      return { source: sourceView(source), coordination: { id: coordination.id, revision: coordination.revision,
        state: coordination.state, createdAt: coordination.createdAt, history: bound(history).map(item => ({
          sourceId: text(item.sourceId), revision: item.revision ?? null, reason: text(item.reason), action: text(item.change?.action ?? item.action ?? item.kind), at: text(item.at) })) },
      snapshot: { state: snapshot.state, fulfilled: snapshot.fulfilled,
        pendingClarifications: bound(clarifications).map(item => ({ clarificationId: text(item.clarificationId), question: text(item.question) })),
        schedules: bound(snapshot.schedules).map(item => ({ scheduleId: item.scheduleId, revision: item.revision, state: item.state,
          nextDueAt: text(item.nextDueAt), timezone: text(item.timezone), reminderText: text(item.reminderText),
          rule: item.rule ? { kind: text(item.rule.kind), at: text(item.rule.at), time: text(item.rule.time), weekday: item.rule.weekday ?? null } : null })),
        occurrences: bound(snapshot.occurrences).map(item => ({ occurrenceId: item.occurrenceId, scheduleId: item.scheduleId,
          plannedAt: item.plannedAt, cancelledAt: item.cancelledAt, paused: item.paused === true,
          actionKind: text(occurrences.find(occurrence => occurrence.id === item.occurrenceId)?.action?.kind), instructionIds: texts(item.instructionIds), actionState: item.actionState,
          deliveryState: item.deliveryState, resultRef: text(item.resultRef),
          failureCode: item.failureReason ? (typeof item.failureReason === 'object' ? code(item.failureReason.code) : null) ?? 'coordination_trigger_failed' : null })),
        jobs: bound(snapshot.jobs).map(item => ({ jobId: item.jobId, state: item.state,
          failureCode: item.failureReason ? (typeof item.failureReason === 'object' ? code(item.failureReason.code) : null) ?? 'coordination_trigger_failed' : null })) },
      members: bound(snapshot.members).map(item => {
        const member = members.find(member => member.id === item.instructionId), task = tasks.find(task => task.taskId === item.taskId)
        const decision = task?.lastDecision
        return { instructionId: item.instructionId, taskId: item.taskId, title: text(task?.title), state: item.state,
          taskState: text(task?.status), control: item.control, dependencies: texts(member.dependencies), requirement: text(item.requirement),
          observation: member.observation === true, progressImpact: text(member.progressImpact), impactReason: text(member.impactReason),
          waitingReason: item.waitingReason ? { code: code(item.waitingReason.code), dependencyInstructionIds: texts(item.waitingReason.dependencyInstructionIds) } : null,
          blocker: text(item.blocker), reorderAssessment: item.reorderAssessment ? { id: text(item.reorderAssessment.id),
            state: text(item.reorderAssessment.state), decision: text(item.reorderAssessment.decision), summary: text(item.reorderAssessment.summary),
            evidence: texts(item.reorderAssessment.evidence) } : null,
          decision: decision ? { action: text(decision.action), summary: text(decision.summary),
            evidence: texts(decision.evidence), limitations: texts(decision.limitations), at: text(decision.at ?? decision.createdAt) } : null,
          completionProof: proofView(item.completionProof) }
      }), observedAt, collections: { history: collection(history), members: collection(members), schedules: collection(schedules),
        occurrences: collection(occurrences), jobs: collection(jobs), pendingClarifications: collection(clarifications) } }
    },
  }
}
