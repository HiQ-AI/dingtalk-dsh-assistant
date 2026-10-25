import { coordinationSnapshot } from './coordination-summary.js'

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

// This reader receives only query, never a command capability or raw runtime DTO.
export function createCoordinationObserver(query) {
  return {
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
