import { createIndependentCoordinationPlanner, coordinationModelSelection } from './independent-coordination-planner.js'
import { freezeCoordinationMembers } from './coordination-task-commands.js'
import { stableId } from './topic-model.js'
import { validateTimeRule } from './coordination-time.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const clone = value => JSON.parse(JSON.stringify(value))

/** One Host-owned queue for independent source units; Topic is never its parent. */
export function openIndependentCoordination({ ctx, root, agentPreset, config = {}, residentStore, query, command,
  ownerActorId, onApplied, onError, planner: suppliedPlanner }) {
  coordinationModelSelection(config)
  const observations = new Map(), running = new Map(), admissions = new Set()
  let closed = false
  const ownership = request => residentStore.getSourceDispatchOwnership(request.groupId, request.unitId, request.unitRevision)
  const assertOwned = request => {
    const current = ownership(request)
    if (!current || current.dispatchOwner !== 'coordination' || current.generation !== request.generation || current.frozen) fail('COORDINATION_SOURCE_FENCED')
    return current
  }
  async function context(request, args = {}) {
    assertOwned(request)
    const offset = args.offset ?? 0, limit = args.limit ?? 20, sourceOffset = args.sourceOffset ?? 0
    if (![offset, sourceOffset].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (args.taskIds?.length ?? 0) > 8) fail('COORDINATION_CONTEXT_RANGE')
    const tasks = (await query('task.list', { groupId: request.groupId })).filter(t => !t.archivedAt)
    const full = (args.taskIds ?? []).map(id => {
      const task = tasks.find(t => t.taskId === id)
      if (!task) fail('COORDINATION_TASK_SCOPE')
      const observed = observations.get(request.reservationId) ?? new Map()
      observations.set(request.reservationId, observed); observed.set(id, clone(task))
      return { taskId: id, title: task.title, objective: task.objective, request: task.request, requirements: task.requirements,
        requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0, controlRevision: task.controlRevision,
        runSequence: task.runSequence, status: task.status, control: task.control, completion: task.completion ?? null }
    })
    const group = residentStore.getGroup(request.groupId), snapshot = request.sourceSnapshot
    const recipientMap = new Map()
    for (const message of group.messages) if (message.senderOpenDingTalkId)
      recipientMap.set(message.senderOpenDingTalkId, { recipientId: message.senderOpenDingTalkId, name: message.senderName ?? '',
        evidenceRef: message.messageId, observedAt: message.occurredAt })
    const sourceText = snapshot.text ?? ''
    return { reservationId: request.reservationId, generation: request.generation, groupId: request.groupId,
      source: { messageId: snapshot.messageId, messageVersion: snapshot.messageVersion, sourceRefs: snapshot.sourceRefs,
        actorId: snapshot.actorId, unitId: request.unitId, unitRevision: request.unitRevision,
        unitText: snapshot.unitText, original: sourceText.slice(sourceOffset, sourceOffset + 16000),
        sourceOffset, nextSourceOffset: sourceOffset + 16000 < sourceText.length ? sourceOffset + 16000 : null,
        truncated: sourceOffset > 0 || sourceText.length > sourceOffset + 16000 },
      tasks: tasks.slice(offset, offset + limit).map(t => ({ taskId: t.taskId, title: t.title,
        objectivePreview: (t.objective ?? '').slice(0, 300), status: t.status, control: t.control,
        inputVersion: t.requirementRevision, runSequence: t.runSequence })),
      total: tasks.length, offset, nextOffset: offset + limit < tasks.length ? offset + limit : null, hasMore: offset + limit < tasks.length,
      taskContexts: full, recipients: [...recipientMap.values()].slice(-100), recipientsTruncated: recipientMap.size > 100,
      arrangements: (await query('coordination.list', { groupId: request.groupId })).slice(-20),
      unresolved: residentStore.listSourceDispatchOwnership(request.groupId).filter(r => r.semanticState === 'needs_clarification').slice(-20),
      allowedActions: ['arrangement','schedule','clarify'], limitations: ['同群；收件人目录仅含有来源证据的已观察成员，缺失或重名必须澄清。'] }
  }
  async function ensureSource(request) {
    const snapshot = request.sourceSnapshot
    const source = (await query('source.list', { groupId: request.groupId })).find(s => s.messageId === snapshot.messageId && s.version === snapshot.messageVersion)
    if (!source || !source.actorId || source.actorId !== snapshot.actorId) fail('COORDINATION_AUTHENTICATED_SOURCE_REQUIRED')
    const receipt = await command('coordination.reserve', { unitId: request.unitId, revision: request.unitRevision,
      groupId: request.groupId, original: snapshot.unitText || snapshot.text, reservationId: request.reservationId,
      reservationGeneration: request.generation, actorId: source.actorId, sourceRefs: [source.sourceId],
      sourceMessageId: source.messageId }, `coordination-reserve:${request.reservationId}:${request.generation}`)
    const current = await query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
    return { source: { ...source, unitId: request.unitId, unitRevision: request.unitRevision }, ledger: current ?? receipt.result.source }
  }
  async function updateResident(request, semanticState, extra = {}) {
    return residentStore.updateSourceDispatch({ groupId: request.groupId, unitId: request.unitId, unitRevision: request.unitRevision,
      expectedGeneration: request.generation, semanticState, ...extra })
  }
  async function submit(request, proposal) {
    assertOwned(request)
    const { source, ledger } = await ensureSource(request)
    const coordinationId = stableId('coordination', `${request.groupId}:${request.unitId}:${request.unitRevision}:${request.generation}`)
    if (proposal.kind === 'clarify') {
      await command('coordination.source.clarify', { sourceId: ledger.id, fence: ledger.fence, coordinationId,
        question: proposal.question, candidates: proposal.candidates }, `coordination-clarify:${request.reservationId}:${request.generation}`)
      await updateResident(request, 'needs_clarification', { coordinationId, clarification: proposal.question })
      await prepareSummary(request, coordinationId, `clarification:${request.reservationId}`, proposal.question)
      return { status: 'needs_clarification', coordinationId, question: proposal.question }
    }
    const observed = observations.get(request.reservationId) ?? new Map()
    const targetIds = proposal.kind === 'schedule' ? proposal.taskIds : proposal.members.map(m => m.taskId)
    for (const id of targetIds) {
      const previous = observed.get(id), current = await query('task.get', { taskId: id })
      if (!previous) fail('COORDINATION_CONTEXT_REQUIRED')
      if (!current || current.groupId !== request.groupId || current.archivedAt) fail('COORDINATION_TASK_SCOPE')
      if (['requirementRevision','controlRevision','runSequence','contextRevision'].some(key => (previous[key] ?? 0) !== (current[key] ?? 0))) fail('DYNAMIC_TASK_REVISION_STALE')
    }
    const members = proposal.kind === 'arrangement' ? freezeCoordinationMembers({ coordinationId, proposal, tasks: observed, source, ownerActorId }) : []
    let schedule
    if (proposal.kind === 'schedule') {
      validateTimeRule(proposal.rule, proposal.timezone)
      if (proposal.rule.kind === 'once' && Date.parse(proposal.rule.at) <= Date.now()) fail('DYNAMIC_COORDINATION_TIME_PAST')
      const known = new Set((await context(request)).recipients.map(r => r.recipientId))
      if (proposal.recipientIds.some(id => !known.has(id))) fail('COORDINATION_RECIPIENT_UNRESOLVED')
      schedule = { scheduleId: `schedule:${coordinationId}`, timezone: proposal.timezone, rule: proposal.rule,
        action: { kind: 'read-query', taskIds: proposal.taskIds }, target: { conversationId: request.groupId, recipientIds: proposal.recipientIds } }
    }
    // Persist the complete semantic proposal before accepting it; recovery never
    // asks a model to reinterpret already accepted business contents.
    const accepted = await command('coordination.accept', { sourceId: ledger.id, fence: ledger.fence, coordinationId,
      members, readOnly: proposal.kind === 'schedule', proposal: clone(proposal), allTogether: proposal.allTogether ?? false,
      ...(schedule ? { schedule } : {}) },
    `coordination-accept:${request.reservationId}:${request.generation}`)
    await updateResident(request, 'accepted', { coordinationId, settled: true })
    await prepareSummary(request, coordinationId, `accepted:${request.reservationId}`,
      proposal.kind === 'schedule' ? `已记录时间安排：${proposal.interpretation}（${proposal.timezone}）。到期读取事实，动作结果与通知送达分别记录。`
        : `已记录 ${members.length} 项原任务安排；接纳不表示业务完成。`)
    return { status: 'accepted', coordinationId, memberIds: members.map(m => m.instructionId) }
  }
  async function prepareSummary(request, coordinationId, eventId, text) {
    const notificationId = `coordination:${coordinationId}:${eventId}`
    const snapshot = request.sourceSnapshot
    await command('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
      payload: { kind: 'coordination', conversationId: request.groupId, text, atOpenDingTalkIds: [], replyKind: 'substantive',
        sourceMessageId: snapshot.messageId, actorId: snapshot.actorId,
        fact: { coordinationId, eventId, sourceUnitId: request.unitId, sourceUnitRevision: request.unitRevision } } }, `prepare:${notificationId}`)
  }
  const planner = suppliedPlanner ?? createIndependentCoordinationPlanner({ ctx, root, agentPreset, config, context, submit,
    isCurrent: request => { try { assertOwned(request); return true } catch { return false } } })
  async function dispatch(groupId) {
    for (const coordination of await query('coordination.list', { groupId })) {
      if (coordination.state !== 'active') continue
      const state = await query('coordination.get', { coordinationId: coordination.id })
      for (const member of state.members) {
        if (['applied','fulfilled'].includes(member.state) && !member.hostHandoffAt) {
          await onApplied(member)
          await command('coordination.member.handoff', { instructionId: member.id }, `coordination-handoff:${member.id}`)
          continue
        }
        if (member.state !== 'ready' || member.eligible === false) continue
        try {
          const receipt = await command('coordination.apply', { instructionId: member.id, expectedRevision: coordination.revision })
          if (receipt.result.member?.state === 'applied') {
            await onApplied(receipt.result.member)
            await command('coordination.member.handoff', { instructionId: member.id }, `coordination-handoff:${member.id}`)
          }
        } catch (error) {
          onError(coordination.id, error)
          // A version conflict during dispatch preserves already applied members.
          // Stop the rest of this batch without implicit compensation.
          break
        }
      }
    }
  }
  return {
    async recoverGroup(groupId) {
      if (closed) return
      if (running.has(groupId)) return running.get(groupId)
      const work = (async () => {
        for (const entry of residentStore.listSourceDispatchOwnership(groupId)) {
          if (entry.dispatchOwner !== 'coordination' || entry.frozen) continue
          const request = { ...entry, groupId }
          try {
            const { ledger } = await ensureSource(request)
            if (ledger.state === 'accepted') {
              await updateResident(request, 'accepted', { coordinationId: ledger.coordinationId, settled: true })
              const state = await query('coordination.get', { coordinationId: ledger.coordinationId })
              const proposal = state.coordination.proposal
              await prepareSummary(request, ledger.coordinationId, `accepted:${request.reservationId}`,
                proposal?.kind === 'schedule' ? `已记录时间安排：${proposal.interpretation}（${proposal.timezone}）。到期读取事实，动作结果与通知送达分别记录。`
                  : `已记录 ${state.members.length} 项原任务安排；接纳不表示业务完成。`)
            } else if (ledger.state === 'needs_clarification') {
              await updateResident(request, 'needs_clarification', { coordinationId: ledger.coordinationId, clarification: ledger.question })
              await prepareSummary(request, ledger.coordinationId, `clarification:${request.reservationId}`, ledger.question)
            } else if (ledger.state === 'reserved' && config.enabled === true && !admissions.has(entry.reservationId)
              && (ledger.attemptCount ?? 0) < 3 && (!ledger.nextRetryAt || Date.parse(ledger.nextRetryAt) <= Date.now())) {
              admissions.add(entry.reservationId)
              try { await planner.plan(request) }
              catch (error) {
                const current = await query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
                if (current?.state === 'reserved' && !current.frozen)
                  await command('coordination.source.failed', { sourceId: ledger.id, fence: ledger.fence, code: error.code ?? error.message })
                throw error
              } finally { admissions.delete(entry.reservationId) }
            }
          } catch (error) { onError(entry.reservationId, error) }
        }
        await dispatch(groupId)
      })().finally(() => running.delete(groupId))
      running.set(groupId, work); return work
    },
    context, submit,
    async whenIdle() { await Promise.allSettled([...running.values()]) },
    async close() { closed = true; await planner.close?.(); await Promise.allSettled([...running.values()]) },
  }
}
