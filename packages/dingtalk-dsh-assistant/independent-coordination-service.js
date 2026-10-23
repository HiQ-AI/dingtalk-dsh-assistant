import { createIndependentCoordinationPlanner, coordinationModelSelection, coordinationProposalSchema, coordinationContextSchema } from './independent-coordination-planner.js'
import { freezeCoordinationMembers } from './coordination-task-commands.js'
import { stableId } from './topic-model.js'
import { localSlot, validateTimeRule } from './coordination-time.js'
import { selectCoordinationInstructions, assertCoordinationHandoffProof, coordinationOrdinalInstructionIds } from './coordination-changes.js'
import { coordinationSnapshot, formatCoordinationSnapshot, formatCoordinationAcceptance } from './coordination-summary.js'
import { assertGroupReply } from './group-message.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const clone = value => JSON.parse(JSON.stringify(value))

/** One Host-owned queue for independent source units; Topic is never its parent. */
export function openIndependentCoordination({ ctx, root, getWorkspaceDir, getModelSelection, agentPreset, config = {}, residentStore, query, command,
  ownerActorId, onApplied, onError, onRecovered = () => {}, onHandoff = () => {}, onChanged = () => {}, planner: suppliedPlanner }) {
  coordinationModelSelection(config)
  const observations = new Map(), catalogObservations = new Map(), arrangementObservations = new Map(), running = new Map(), admissions = new Set()
  let closed = false
  const ownership = request => residentStore.getSourceDispatchOwnership(request.groupId, request.unitId, request.unitRevision)
  const assertOwned = request => {
    const current = ownership(request)
    if (!current || current.dispatchOwner !== 'coordination' || current.generation !== request.generation || current.frozen) fail('COORDINATION_SOURCE_FENCED')
    return current
  }
  const isFrozen = async () => config.mode === 'frozen' || (await query('coordination.runtime'))?.mode === 'frozen'
  /** 只用持久来源与送达回执关联引用；作者决定可关联事项，收件人始终来自已保存日程。 */
  async function quotedReminderContext({ groupId, messageId, messageVersion, actorId }) {
    if (!actorId || !messageId || !Number.isSafeInteger(messageVersion)) return null
    const sources = await query('source.list', { groupId })
    if (sources.some(item => item.messageId === messageId && item.version > messageVersion)) return null
    const source = sources.find(item => item.messageId === messageId && item.version === messageVersion && item.actorId === actorId)
    if (!source?.quote?.messageId) return null
    const notices = (await query('notification.list', { state: 'delivered' })).filter(item => item.kind === 'coordination'
      && item.payload.conversationId === groupId && item.receipt?.messageId === source.quote.messageId)
    if (notices.length !== 1) return null
    const notice = notices[0], coordinationId = notice.payload.fact?.coordinationId
    if (!coordinationId || notice.payload.actorId !== actorId || !sources.some(item => item.messageId === notice.payload.sourceMessageId && item.actorId === actorId)) return null
    const state = await query('coordination.get', { coordinationId })
    if (!state || state.coordination.groupId !== groupId || state.coordination.state !== 'active' || state.coordination.memberIds.length) return null
    const origin = (await query('coordination.source.list', { groupId })).find(item => item.id === state.coordination.sourceId)
    if (!origin || origin.actorId !== actorId || origin.state !== 'accepted') return null
    const schedules = (await query('coordination.schedule.list', { coordinationId })).filter(item => item.state === 'active')
    if (schedules.length !== 1 || schedules[0].action.kind !== 'message-reminder' || schedules[0].target.conversationId !== groupId) return null
    const { history: _history, ...schedule } = schedules[0]
    return clone({ quotedMessageId: source.quote.messageId, notificationId: notice.id, coordinationId,
      coordinationRevision: state.coordination.revision, schedule,
      source: { messageId: origin.sourceMessageId, actorId: origin.actorId, unitId: origin.unitId, unitRevision: origin.revision, text: origin.original } })
  }
  async function context(request, args = {}) {
    assertOwned(request)
    const parsed = coordinationContextSchema.safeParse(args)
    if (!parsed.success) fail('COORDINATION_CONTEXT_RANGE')
    args = parsed.data
    const offset = args.offset ?? 0, limit = args.limit ?? 20, sourceOffset = args.sourceOffset ?? 0, arrangementSourceOffset = args.arrangementSourceOffset ?? 0,
      arrangementOffset = args.arrangementOffset ?? 0, memberOffset = args.memberOffset ?? 0
    const group = residentStore.getGroup(request.groupId), snapshot = request.sourceSnapshot
    const quotedReminder = await quotedReminderContext({ groupId: request.groupId, messageId: snapshot.messageId,
      messageVersion: snapshot.messageVersion, actorId: snapshot.actorId })
    const taskCatalog = !quotedReminder || args.offset !== undefined || args.limit !== undefined || args.taskIds?.length > 0
    const arrangementCatalog = !quotedReminder || args.arrangementOffset !== undefined
    const tasks = taskCatalog ? (await query('task.list', { groupId: request.groupId })).filter(t => !t.archivedAt) : []
    const page = tasks.slice(offset, offset + limit)
    const full = (args.taskIds ?? []).map(id => {
      const task = tasks.find(t => t.taskId === id)
      if (!task) fail('COORDINATION_TASK_SCOPE')
      const observed = observations.get(request.reservationId) ?? new Map()
      observations.set(request.reservationId, observed); observed.set(id, clone(task))
      return { taskId: id, title: task.title, objective: task.objective, request: task.request, requirements: task.requirements,
        requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0, controlRevision: task.controlRevision,
        runSequence: task.runSequence, status: task.status, control: task.control, completion: task.completion ?? null }
    })
    const arrangementContexts = await Promise.all((args.coordinationIds ?? (quotedReminder ? [quotedReminder.coordinationId] : [])).map(async coordinationId => {
      const state = await query('coordination.get', { coordinationId })
      if (!state || state.coordination.groupId !== request.groupId) fail('COORDINATION_ARRANGEMENT_SCOPE')
      const observed = arrangementObservations.get(request.reservationId) ?? new Map()
      arrangementObservations.set(request.reservationId, observed); observed.set(coordinationId, clone(state))
      const original = residentStore.listSourceDispatchOwnership(request.groupId).find(entry => entry.coordinationId === coordinationId
        && (args.arrangementSourceUnitId === undefined ? !quotedReminder || coordinationId !== quotedReminder.coordinationId
          || entry.unitId === quotedReminder.source.unitId && entry.unitRevision === quotedReminder.source.unitRevision
          : entry.unitId === args.arrangementSourceUnitId && entry.unitRevision === args.arrangementSourceUnitRevision))
      if (args.arrangementSourceUnitId !== undefined && !original) fail('COORDINATION_ARRANGEMENT_SOURCE_SCOPE')
      const schedules = await query('coordination.schedule.list', { coordinationId })
      const occurrences = await query('coordination.occurrence.list', { coordinationId })
      observed.set(coordinationId, clone({ ...state, schedules, occurrences }))
      const originalText = original?.sourceSnapshot.unitText ?? ''
      const ordinalIds=coordinationOrdinalInstructionIds(state)
      return { coordination: { id: state.coordination.id, revision: state.coordination.revision, state: state.coordination.state,
        memberIds: state.coordination.memberIds.slice(memberOffset, memberOffset + 100), question: state.coordination.question,
        pendingClarifications: state.coordination.pendingClarifications ?? [],
        ordinalSelectionRequiresClarification: !state.coordination.sourceOrder && (state.coordination.hadPartialClarifications === true || !!state.coordination.pendingClarifications?.length),
        sourceOrder: state.coordination.sourceOrder?.slice(memberOffset, memberOffset + 100).map(slot=>({...slot,quote:slot.quote.slice(0,2000),quoteTruncated:slot.quote.length>2000})),
        sourceOrderTotal: state.coordination.sourceOrder?.length ?? 0,
        ordinalAppendRequiresClarification: state.coordination.sourceOrderAppendGap === true,
        sourceOrderTruncated: memberOffset > 0 || (state.coordination.sourceOrder?.length ?? 0) > memberOffset + 100,
        nextSourceOrderOffset: (state.coordination.sourceOrder?.length ?? 0) > memberOffset + 100 ? memberOffset + 100 : null,
        history: (state.coordination.history ?? []).slice(-20).map(entry => ({ sourceId: entry.sourceId, revision: entry.revision,
          oldRevision: entry.oldRevision, reason: entry.reason, original: entry.original?.slice(0, 2000), at: entry.at })),
        historyTruncated: (state.coordination.history?.length ?? 0) > 20 },
        source: original ? { unitText: originalText.slice(arrangementSourceOffset, arrangementSourceOffset + 16000), messageId: original.sourceSnapshot.messageId,
          unitId: original.unitId, unitRevision: original.unitRevision, actorId: original.sourceSnapshot.actorId,
          occurredAt: original.sourceSnapshot.occurredAt ?? null,
          sourceRefs: original.sourceSnapshot.sourceRefs, sourceOffset: arrangementSourceOffset,
          nextSourceOffset: arrangementSourceOffset + 16000 < originalText.length ? arrangementSourceOffset + 16000 : null,
          truncated: arrangementSourceOffset > 0 || originalText.length > arrangementSourceOffset + 16000 } : null,
        members: state.coordination.memberIds.slice(memberOffset, memberOffset + 100).map((id, index) => {
          const member = state.members.find(member => member.id === id)
          return { instructionId: id, ordinal: state.coordination.sourceOrder?.find(slot=>slot.instructionIds.includes(id))?.ordinal ?? (state.coordination.sourceOrder || !ordinalIds.includes(id) ? null : ordinalIds.indexOf(id) + 1), taskId: member.taskId, state: member.state, control: member.control ?? 'active',
            original: (member.original ?? '').slice(0, 2000), originalTruncated: (member.original?.length ?? 0) > 2000,
            dependencies: member.dependencies, effectiveVersion: member.effectiveVersion ?? null,
            waitingReason: member.waitingReason, originalCommandId: member.command.id }
        }), memberOffset, membersTotal: state.coordination.memberIds.length,
        nextMemberOffset: memberOffset + 100 < state.coordination.memberIds.length ? memberOffset + 100 : null,
        membersTruncated: memberOffset > 0 || state.coordination.memberIds.length > memberOffset + 100,
        schedules: schedules.slice(-20), schedulesTruncated: schedules.length > 20,
        occurrences: occurrences.slice(-20), occurrencesTruncated: occurrences.length > 20 }
    }))
    const recipientMap = new Map()
    const visibleRecipients = new Set([snapshot.actorId, ...arrangementContexts.flatMap(item => item.schedules.flatMap(schedule => schedule.target.recipientIds))])
    for (const message of group.messages) if (message.senderOpenDingTalkId && (!quotedReminder || taskCatalog || arrangementCatalog || visibleRecipients.has(message.senderOpenDingTalkId)))
      recipientMap.set(message.senderOpenDingTalkId, { recipientId: message.senderOpenDingTalkId, name: message.senderName ?? '',
        evidenceRef: message.messageId, observedAt: message.occurredAt })
    const sourceText = snapshot.text ?? ''
    const arrangements = arrangementCatalog ? (await query('coordination.list', { groupId: request.groupId })).reverse() : []
    const dispatchSources = residentStore.listSourceDispatchOwnership(request.groupId)
    const unresolved = arrangementCatalog ? dispatchSources.filter(r => r.semanticState === 'needs_clarification') : []
    const currentTime = new Date().toISOString(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    // 钉钉来源没有浏览器时区；提供真实工作时区，并保持来源时间与处理时间各自独立。
    const result = clone({ reservationId: request.reservationId, generation: request.generation, groupId: request.groupId, currentTime,
      timeContext: { timeZone, source: 'host-working-timezone', currentLocal: localSlot(currentTime, timeZone),
        sourceLocal: Number.isFinite(Date.parse(snapshot.occurredAt ?? '')) ? localSlot(snapshot.occurredAt, timeZone) : null },
      source: { messageId: snapshot.messageId, messageVersion: snapshot.messageVersion, sourceRefs: snapshot.sourceRefs,
        occurredAt: snapshot.occurredAt ?? null,
        actorId: snapshot.actorId, unitId: request.unitId, unitRevision: request.unitRevision,
        unitText: snapshot.unitText, original: sourceText.slice(sourceOffset, sourceOffset + 16000),
        sourceOffset, nextSourceOffset: sourceOffset + 16000 < sourceText.length ? sourceOffset + 16000 : null,
        truncated: sourceOffset > 0 || sourceText.length > sourceOffset + 16000 },
      tasks: page.map(t => ({ taskId: t.taskId, title: t.title,
        objectivePreview: (t.objective ?? '').slice(0, 300), status: t.status, control: t.control,
        inputVersion: t.requirementRevision, runSequence: t.runSequence })),
      ...(taskCatalog ? { total: tasks.length, offset, nextOffset: offset + limit < tasks.length ? offset + limit : null, hasMore: offset + limit < tasks.length } : {}),
      taskContexts: full, recipients: [...recipientMap.values()].slice(-100), recipientsTruncated: recipientMap.size > 100,
      arrangements: arrangements.slice(arrangementOffset, arrangementOffset + 20).map(arrangement => ({
        id: arrangement.id, revision: arrangement.revision, lifecycleState: arrangement.lifecycleState ?? arrangement.state,
        state: arrangement.state, memberCount: arrangement.memberIds.length, sourceId: arrangement.sourceId,
        question: arrangement.question, createdAt: arrangement.createdAt,
        sourcePreview: dispatchSources.find(entry => entry.coordinationId === arrangement.id)?.sourceSnapshot.unitText?.slice(0, 400),
        actorId: dispatchSources.find(entry => entry.coordinationId === arrangement.id)?.sourceSnapshot.actorId })), arrangementContexts,
      ...(arrangementCatalog ? { arrangementOffset, arrangementsTotal: arrangements.length, arrangementsHasMore: arrangementOffset + 20 < arrangements.length,
        nextArrangementOffset: arrangementOffset + 20 < arrangements.length ? arrangementOffset + 20 : null } : {}),
      unresolved: unresolved.slice(-20).map(entry => ({ reservationId: entry.reservationId, unitId: entry.unitId, unitRevision: entry.unitRevision,
        coordinationId: entry.coordinationId, question: entry.clarification, sourcePreview: entry.sourceSnapshot.unitText?.slice(0, 400) })),
      unresolvedTruncated: unresolved.length > 20,
      ...(quotedReminder ? { quotedReminder, catalogsDeferred: { tasks: !taskCatalog, arrangements: !arrangementCatalog,
        recipients: !taskCatalog && !arrangementCatalog } } : {}),
      allowedActions: ['arrangement','schedule','clarify','reject','change','resolve','query','schedule-change','occurrence-control'], limitations: ['同群；收件人目录仅含有来源证据的已观察成员，缺失或重名必须澄清。'] })
    const catalog = catalogObservations.get(request.reservationId) ?? new Set()
    catalogObservations.set(request.reservationId, catalog)
    for (const task of page) catalog.add(task.taskId)
    return result
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
  async function finishHandoff(request, ledger) {
    const freezeId = ledger.handoffProof?.freezeId ?? `handoff:${request.reservationId}:${request.generation}`
    if (!ledger.frozen) {
      await command('coordination.source.freezeHandoff', { sourceId: ledger.id, fence: ledger.fence, freezeId },
        `coordination-freeze-handoff:${request.reservationId}:${request.generation}`)
    }
    // A lost acknowledgement must be reconciled at the exact original identity.
    // In particular no failed/unknown command is interpreted as an empty queue.
    const authoritative = await query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
    const proof = assertCoordinationHandoffProof(request, authoritative, freezeId)
    const arrangements = await query('coordination.list', { groupId: request.groupId })
    if (arrangements.some(arrangement => arrangement.sourceId === authoritative.id && arrangement.memberIds.length > 0)) fail('COORDINATION_HANDOFF_UNSAFE')
    let resident = ownership(request)
    if (resident.dispatchOwner === 'coordination') {
      if (resident.generation !== request.generation) fail('COORDINATION_SOURCE_FENCED')
      if (!resident.frozen) {
        if (resident.semanticState !== 'rejected') await updateResident(request, 'rejected')
        await residentStore.beginSourceDispatchHandoff({ groupId: request.groupId, unitId: request.unitId, unitRevision: request.unitRevision,
          expectedGeneration: request.generation, freezeId, reason: authoritative.rejectionReason })
      }
      const rechecked = await query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
      assertCoordinationHandoffProof(request, rechecked, freezeId)
      if (JSON.stringify(rechecked.handoffProof) !== JSON.stringify(proof)) fail('COORDINATION_HANDOFF_UNSAFE')
      resident = await residentStore.completeSourceDispatchHandoff({ groupId: request.groupId, unitId: request.unitId, unitRevision: request.unitRevision,
        expectedGeneration: request.generation, proof })
    }
    if (resident.dispatchOwner !== 'legacy-topic' || resident.generation !== proof.generation + 1
      || resident.handoff?.proof?.dynamicSourceId !== authoritative.id) fail('COORDINATION_HANDOFF_UNSAFE')
    await command('coordination.source.completeHandoff', { sourceId: authoritative.id, fence: authoritative.fence, handoffProof: proof },
      `coordination-complete-handoff:${request.reservationId}:${proof.generation}`)
    onRecovered(request.reservationId)
    // The Host schedules the legacy router outside this queue; awaiting a nested
    // recoverGroup on the same group would deadlock the persistent handoff.
    try { Promise.resolve(onHandoff(request.groupId)).catch(error => onError(request.reservationId, error)) }
    catch (error) { onError(request.reservationId, error) }
    return { status: 'handed_back', reservationId: request.reservationId, generation: resident.generation }
  }
  async function reject(request, ledger, reason) {
    if (ledger.state !== 'rejected') await command('coordination.source.reject', { sourceId: ledger.id, fence: ledger.fence, reason },
      `coordination-reject:${request.reservationId}:${request.generation}`)
    const current = await query('coordination.source', { unitId: request.unitId, revision: request.unitRevision })
    return finishHandoff(request, current)
  }
  async function checkObservedTasks(request, proposal) {
    const observed = observations.get(request.reservationId) ?? new Map()
    if (proposal.kind === 'schedule' && proposal.actionKind === 'message-reminder') {
      if (!proposal.reminderText?.trim() || proposal.taskIds?.length || proposal.members?.length || proposal.conditionalMembers?.length) fail('COORDINATION_REMINDER_INVALID')
      return observed
    }
    if (proposal.reminderText !== undefined) fail('COORDINATION_REMINDER_INVALID')
    const directoryOnly = proposal.kind === 'schedule' && (proposal.actionKind ?? 'read-query') === 'read-query' && !proposal.conditionalMembers?.length
    const targetIds = proposal.kind === 'schedule' && (proposal.actionKind ?? 'read-query') === 'read-query'
      ? proposal.taskIds ?? [] : (proposal.members ?? []).filter(member => member.action !== 'new-task').map(member => member.taskId)
    if (proposal.kind === 'schedule' && proposal.actionKind !== 'task-command' && !targetIds.length) fail('COORDINATION_QUERY_TARGET_REQUIRED')
    for (const id of targetIds) {
      const previous = observed.get(id), current = await query('task.get', { taskId: id })
      if (!previous && !(directoryOnly && catalogObservations.get(request.reservationId)?.has(id))) fail('COORDINATION_CONTEXT_REQUIRED')
      if (!current || current.groupId !== request.groupId || current.archivedAt) fail('COORDINATION_TASK_SCOPE')
      // 纯查询只冻结目标身份，到时读取最新事实；任何附带任务动作仍须完整合同与版本检查。
      if (!directoryOnly && ['requirementRevision','controlRevision','runSequence','contextRevision'].some(key => (previous[key] ?? 0) !== (current[key] ?? 0))) fail('DYNAMIC_TASK_REVISION_STALE')
    }
    return observed
  }
  async function freezeProposal(request, proposal, coordinationId, source, extra = {}) {
    const observed = await checkObservedTasks(request, proposal)
    const taskCommand = proposal.kind === 'arrangement' || proposal.kind === 'schedule' && proposal.actionKind === 'task-command'
    const conditionalProposal = proposal.kind === 'schedule' ? proposal.conditionalMembers : undefined
    if (conditionalProposal && (proposal.actionKind !== 'read-query' || conditionalProposal.some(member => member.action !== 'task-continue'
      || member.progressImpact !== 'preserve' || !proposal.taskIds?.includes(member.taskId)))) fail('COORDINATION_CONDITIONAL_SCOPE_INVALID')
    // A completed query target is never reopened by a conditional continue.
    const conditional = conditionalProposal?.filter(member => observed.get(member.taskId)?.status !== 'completed')
    if (taskCommand && !proposal.members?.length && !proposal.pendingClarifications?.length) fail('COORDINATION_TASK_COMMAND_MEMBERS_REQUIRED')
    const members = taskCommand || conditional ? freezeCoordinationMembers({ coordinationId,
      proposal: conditional ? { ...proposal, members: conditional } : proposal, tasks: observed, source, ownerActorId, ...extra }) : []
    let schedule
    if (proposal.kind === 'schedule') {
      validateTimeRule(proposal.rule, proposal.timezone)
      if (proposal.rule.kind === 'once' && Date.parse(proposal.rule.at) <= Date.now()) {
        const sourceTime = new Date(request.sourceSnapshot.occurredAt ?? NaN).getTime()
        if (!Number.isFinite(sourceTime) || Date.parse(proposal.rule.at) < Math.floor(sourceTime / 1000) * 1000) fail('DYNAMIC_COORDINATION_TIME_PAST')
      }
      const known = new Set((await context(request, { offset: 0 })).recipients.map(recipient => recipient.recipientId))
      if (proposal.recipientIds.some(id => !known.has(id))) fail('COORDINATION_RECIPIENT_UNRESOLVED')
      schedule = { scheduleId: `schedule:${coordinationId}`, timezone: proposal.timezone, rule: proposal.rule,
        action: proposal.actionKind === 'message-reminder' ? { kind: 'message-reminder', text: proposal.reminderText }
          : taskCommand ? { kind: 'task-command', instructionIds: members.filter(member => !member.observation).map(member => member.instructionId) }
          : { kind: 'read-query', taskIds: proposal.taskIds, ...(conditional?.length ? { onIncomplete: { kind: 'task-command', instructionIds: members.map(member => member.instructionId) } } : {}) },
        target: { conversationId: request.groupId, recipientIds: proposal.recipientIds } }
    }
    return { members, schedule }
  }
  async function acceptanceText(proposal, memberCount, result = {}) {
    const schedule = proposal?.kind === 'schedule-change' ? result.schedule
      ?? (await query('coordination.schedule.list', { coordinationId: proposal.coordinationId })).find(item => item.id === proposal.scheduleId) : undefined
    const occurrence = proposal?.kind === 'occurrence-control' ? result.occurrence
      ?? await query('coordination.occurrence.get', { occurrenceId: proposal.occurrenceId }) : undefined
    return formatCoordinationAcceptance(proposal, { memberCount, schedule, occurrence })
  }
  // 只校验会公开的文字；提案解释、版本和关联身份仍按原合同保留在内部。
  function publicIdentityIds(request, proposal = {}) {
    const source = request.sourceSnapshot, observed = [...(arrangementObservations.get(request.reservationId)?.values() ?? [])]
    return [request.groupId, request.unitId, request.reservationId, source.messageId, source.actorId,
      proposal.coordinationId, proposal.scheduleId, proposal.occurrenceId, ...(proposal.recipientIds ?? []),
      ...observed.flatMap(state => [state.coordination.id, ...(state.schedules ?? []).map(item => item.id), ...(state.occurrences ?? []).map(item => item.id)]),
      ...residentStore.getGroup(request.groupId).messages.map(message => message.senderOpenDingTalkId)]
  }
  function assertProposalPublicText(request, proposal) {
    const publicProposal = proposal.kind === 'resolve' ? proposal.resolution : proposal
    const ids = [...publicIdentityIds(request, proposal), ...(publicProposal.pendingClarifications ?? []).map(item => item.clarificationId)]
    for (const text of [publicProposal.question, publicProposal.reminderText, ...(publicProposal.pendingClarifications ?? []).map(item => item.question)])
      assertGroupReply(text, ids)
  }
  async function submitChange(request, proposal, source, ledger) {
    const observed = arrangementObservations.get(request.reservationId)?.get(proposal.coordinationId)
    if (!observed) fail('COORDINATION_ARRANGEMENT_CONTEXT_REQUIRED')
    const state = await query('coordination.get', { coordinationId: proposal.coordinationId })
    if (state.coordination.groupId !== request.groupId) fail('COORDINATION_ARRANGEMENT_SCOPE')
    if (state.coordination.revision !== proposal.expectedRevision || observed.coordination.revision !== proposal.expectedRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
    let change
    if (proposal.kind === 'change') {
      change = clone(proposal.change)
      if (['pause','resume','cancel'].includes(change.action)) {
        if (change.selectors.length) change.instructionIds = selectCoordinationInstructions(state, change.selectors)
        delete change.selectors
      } else if (change.action === 'append') {
        const frozen = await freezeProposal(request, { kind: 'arrangement', ...change }, proposal.coordinationId, source,
          { instructionRevision: proposal.expectedRevision + 1, existingMembers: state.members })
        change.members = frozen.members
      } else if (change.action === 'reorder') {
        for (const dependency of change.dependencies) {
          selectCoordinationInstructions(state, [{ instructionId: dependency.instructionId }])
          for (const id of dependency.afterInstructionIds) selectCoordinationInstructions(state, [{ instructionId: id }])
        }
      }
    } else if (proposal.kind === 'resolve') {
      const partial = proposal.clarificationIds !== undefined
      if (!partial && state.coordination.state !== 'needs_clarification'
        || partial && !state.coordination.pendingClarifications?.length) fail('COORDINATION_CLARIFICATION_ALREADY_RESOLVED')
      if (partial && (proposal.resolution.kind !== 'arrangement' || proposal.resolution.pendingClarifications.length)) fail('COORDINATION_PARTIAL_RESOLUTION_INVALID')
      const frozen = await freezeProposal(request, proposal.resolution, proposal.coordinationId, source,
        { instructionRevision: proposal.expectedRevision + 1, existingMembers: state.members })
      change = { action: partial ? 'resolve-members' : 'resolve', ...(partial ? { clarificationIds: proposal.clarificationIds } : {}), members: frozen.members, readOnly: proposal.resolution.kind === 'schedule',
        ...(frozen.schedule ? { schedule: frozen.schedule } : {}), proposal: proposal.resolution }
      if (partial && state.coordination.sourceOrder) change.resolvedClarifications = frozen.members.map((member,index)=>({instructionId:member.instructionId,
        clarificationId:proposal.resolution.members[index].resolvesClarificationId ?? (proposal.clarificationIds.length===1 ? proposal.clarificationIds[0] : undefined)}))
    } else if (proposal.kind === 'schedule-change') {
      const schedule = observed.schedules.find(schedule => schedule.id === proposal.scheduleId)
      if (!schedule || schedule.revision !== proposal.expectedScheduleRevision) fail('COORDINATION_SCHEDULE_CONTEXT_REQUIRED')
      const scheduleChange = { scheduleId: proposal.scheduleId, expectedRevision: proposal.expectedScheduleRevision, scope: proposal.scope }
      for (const key of ['state','rule','timezone','replacementPlannedAt']) if (proposal[key] !== undefined) scheduleChange[key] = clone(proposal[key])
      if (proposal.recipientIds) {
        const known = new Set((await context(request, { offset: 0 })).recipients.map(recipient => recipient.recipientId))
        if (proposal.recipientIds.some(id => !known.has(id))) fail('COORDINATION_RECIPIENT_UNRESOLVED')
        scheduleChange.target = { conversationId: request.groupId, recipientIds: proposal.recipientIds }
      }
      change = { action: 'schedule', scheduleChange, reason: proposal.reason }
    } else {
      const occurrence = observed.occurrences.find(occurrence => occurrence.id === proposal.occurrenceId)
      if (!occurrence || occurrence.instanceControlRevision !== proposal.expectedControlRevision) fail('COORDINATION_OCCURRENCE_CONTEXT_REQUIRED')
      change = { action: 'occurrence', occurrenceControl: { occurrenceId: proposal.occurrenceId,
        expectedControlRevision: proposal.expectedControlRevision, control: proposal.control }, reason: proposal.reason }
    }
    assertGroupReply(await acceptanceText(proposal, proposal.resolution?.members?.length, {
      schedule: observed.schedules?.find(item => item.id === proposal.scheduleId),
      occurrence: observed.occurrences?.find(item => item.id === proposal.occurrenceId),
    }), publicIdentityIds(request, proposal))
    const receipt = await command('coordination.change', { sourceId: ledger.id, fence: ledger.fence,
      coordinationId: proposal.coordinationId, expectedRevision: proposal.expectedRevision, change, proposal: clone(proposal) },
    `coordination-change:${request.reservationId}:${request.generation}`)
    await onChanged(receipt.result)
    const pending = proposal.kind === 'resolve' && proposal.clarificationIds === undefined ? receipt.result.coordination.pendingClarifications ?? [] : []
    await updateResident(request, pending.length ? 'needs_clarification' : 'accepted', { coordinationId: proposal.coordinationId, settled: !pending.length,
      ...(pending.length ? {clarification:pending.map(item=>item.question).join('；')} : {}) })
    await prepareSummary(request, proposal.coordinationId, `accepted:${request.reservationId}`, await acceptanceText(proposal,proposal.resolution?.members?.length, receipt.result),
      proposal.kind === 'resolve' ? {} : { noticeKind: 'control', sourceAcceptanceId: ledger.id })
    return { status: pending.length ? 'partially_accepted' : 'accepted', coordinationId: proposal.coordinationId, revision: receipt.result.coordination.revision }
  }
  async function submit(request, proposal) {
    assertOwned(request)
    if (await isFrozen()) fail('COORDINATION_RUNTIME_FROZEN')
    proposal = coordinationProposalSchema.parse(proposal)
    assertProposalPublicText(request, proposal)
    const { source, ledger } = await ensureSource(request)
    const coordinationId = stableId('coordination', `${request.groupId}:${request.unitId}:${request.unitRevision}:${request.generation}`)
    if (proposal.kind === 'reject') return reject(request, ledger, proposal.reason)
    if (proposal.kind === 'query') {
      const snapshots = []
      for (const id of proposal.coordinationIds) {
        if (!arrangementObservations.get(request.reservationId)?.has(id)) fail('COORDINATION_ARRANGEMENT_CONTEXT_REQUIRED')
        const state = await query('coordination.get', { coordinationId: id })
        if (!state || state.coordination.groupId !== request.groupId) fail('COORDINATION_ARRANGEMENT_SCOPE')
        const schedules = await query('coordination.schedule.list', { coordinationId: id })
        const occurrences = await query('coordination.occurrence.list', { coordinationId: id })
        const occurrenceIds = new Set(occurrences.map(item => item.id))
        snapshots.push(coordinationSnapshot({ ...state, tasks: await query('task.list', { groupId: request.groupId }), schedules, occurrences,
          jobs: (await query('coordination.job.list')).filter(job => occurrenceIds.has(job.occurrenceId)) }))
      }
      const recipientNames = new Map(residentStore.getGroup(request.groupId).messages
        .filter(message => message.senderOpenDingTalkId && message.senderName).map(message => [message.senderOpenDingTalkId, message.senderName]))
      const answerText = snapshots.map(snapshot => formatCoordinationSnapshot(snapshot, { requesterId: source.actorId, recipientNames })).join('\n\n')
      assertGroupReply(answerText, publicIdentityIds(request, proposal))
      const frozenProposal = { ...proposal, answerText, snapshots }
      await command('coordination.accept', { sourceId: ledger.id, fence: ledger.fence, coordinationId, members: [], readOnly: true,
        proposal: frozenProposal }, `coordination-accept:${request.reservationId}:${request.generation}`)
      await updateResident(request, 'accepted', { coordinationId, settled: true })
      await prepareSummary(request, coordinationId, `accepted:${request.reservationId}`, answerText)
      return { status: 'accepted', coordinationId, snapshots }
    }
    if (['change','resolve','schedule-change','occurrence-control'].includes(proposal.kind)) return submitChange(request, proposal, source, ledger)
    if (proposal.kind === 'clarify') {
      await command('coordination.source.clarify', { sourceId: ledger.id, fence: ledger.fence, coordinationId,
        question: proposal.question, candidates: proposal.candidates }, `coordination-clarify:${request.reservationId}:${request.generation}`)
      await updateResident(request, 'needs_clarification', { coordinationId, clarification: proposal.question })
      await prepareSummary(request, coordinationId, `clarification:${request.reservationId}`, proposal.question)
      return { status: 'needs_clarification', coordinationId, question: proposal.question }
    }
    const { members, schedule } = await freezeProposal(request, proposal, coordinationId, source)
    // Persist the complete semantic proposal before accepting it; recovery never
    // asks a model to reinterpret already accepted business contents.
    await command('coordination.accept', { sourceId: ledger.id, fence: ledger.fence, coordinationId,
      members, readOnly: proposal.kind === 'schedule', proposal: clone(proposal), allTogether: proposal.allTogether ?? false,
      pendingClarifications: proposal.pendingClarifications ?? [],
      ...(proposal.sourceOrder ? {sourceOrder:proposal.sourceOrder} : {}),
      ...(schedule ? { schedule } : {}) },
    `coordination-accept:${request.reservationId}:${request.generation}`)
    const pending = proposal.pendingClarifications ?? []
    await updateResident(request, pending.length ? 'needs_clarification' : 'accepted', { coordinationId, settled: !pending.length,
      ...(pending.length ? { clarification: pending.map(item => item.question).join('；') } : {}) })
    await prepareSummary(request, coordinationId, `accepted:${request.reservationId}`, await acceptanceText(proposal, members.length))
    return { status: pending.length ? 'partially_accepted' : 'accepted', coordinationId, memberIds: members.map(m => m.instructionId), pendingClarifications: pending }
  }
  async function prepareSummary(request, coordinationId, eventId, text, fact = {}) {
    const notificationId = `coordination:${coordinationId}:${eventId}`
    // 通知正文已冻结；恢复不能用新版本文案重写旧 payload 或再次申请发送。
    if (await query('notification.get', { notificationId })) return
    assertGroupReply(text, [...publicIdentityIds(request), coordinationId, eventId, notificationId])
    const snapshot = request.sourceSnapshot
    await command('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
      payload: { kind: 'coordination', conversationId: request.groupId, text, atOpenDingTalkIds: [], replyKind: 'substantive',
        sourceMessageId: snapshot.messageId, actorId: snapshot.actorId,
        fact: { coordinationId, eventId, sourceUnitId: request.unitId, sourceUnitRevision: request.unitRevision, ...fact } } }, `prepare:${notificationId}`)
  }
  const planner = suppliedPlanner ?? createIndependentCoordinationPlanner({ ctx, root, getWorkspaceDir, getModelSelection, agentPreset, config, context, submit,
    isCurrent: request => { try { assertOwned(request); return true } catch { return false } } })
  async function acceptMemberTrigger(groupId, coordination, state, member) {
    if (coordination.allTogether && coordination.pendingClarifications?.length) return
    if (member.control === 'paused' || member.control === 'cancelled') return
    const schedules = await query('coordination.schedule.list', { coordinationId: coordination.id })
    if (schedules.some(schedule => [schedule.action, ...(schedule.history ?? []).map(revision => revision.action).filter(Boolean)]
      .some(action => (action.kind === 'task-command' ? action : action.onIncomplete)?.instructionIds.includes(member.id)))) return
    const occurrences = await query('coordination.occurrence.list', { coordinationId: coordination.id })
    if (occurrences.some(occurrence => occurrence.action.kind === 'task-command' && occurrence.action.instructionIds.includes(member.id))) return
    let trigger
    if (!member.dependencies.length) {
      const source = member.command.args.originalSource
      if (!source?.unitId || !source?.unitRevision) fail('COORDINATION_TRIGGER_SOURCE_REQUIRED')
      trigger = { triggerKind: 'message', sourceUnitId: source.unitId, sourceUnitRevision: source.unitRevision, actionId: member.id }
    } else {
      const proofs = []
      for (const id of member.dependencies) {
        const parent = state.members.find(candidate => candidate.id === id)
        if (!parent?.completionProof || parent.state !== 'fulfilled' || ['paused','cancelled'].includes(parent.control)) return
        const task = await query('task.get', { taskId: parent.taskId }), proof = parent.completionProof
        if (task.status !== 'completed' || task.completion?.commandId !== proof.commandId
          || ['requirementRevision','controlRevision','runSequence'].some(key => task[key] !== proof[key])
          || (task.contextRevision ?? 0) !== proof.contextRevision) return
        proofs.push(proof)
      }
      const latest = proofs.sort((a,b) => b.sequence - a.sequence)[0]
      trigger = { triggerKind: 'business-event', eventSource: latest.eventSource ?? 'task-ledger', eventId: latest.eventId, actionId: member.id }
    }
    await command('coordination.occurrence.accept', { coordinationId: coordination.id, trigger,
      action: { kind: 'task-command', instructionIds: [member.id] }, target: { conversationId: groupId, recipientIds: [], summaryOnly: true } })
  }
  async function dispatch(groupId) {
    for (const coordination of await query('coordination.list', { groupId })) {
      if (coordination.state !== 'active') continue
      await command('coordination.observe.reconcile', { coordinationId: coordination.id })
      const state = await query('coordination.get', { coordinationId: coordination.id })
      for (const member of state.members) {
        if (member.observation) continue
        if (['applied','fulfilled'].includes(member.state) && !member.hostHandoffAt) {
          await onApplied(member)
          await command('coordination.member.handoff', { instructionId: member.id }, `coordination-handoff:${member.id}`)
          continue
        }
        if (member.state !== 'ready') continue
        if (member.reorderAssessment && ['pending','needs_clarification'].includes(member.reorderAssessment.state)) continue
        try {
          if (member.requiresTrigger) {
            await acceptMemberTrigger(groupId, coordination, state, member)
            continue
          }
          if (member.eligible === false) continue
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
        const frozen = await isFrozen()
        for (const entry of residentStore.listSourceDispatchOwnership(groupId)) {
          if (entry.dispatchOwner !== 'coordination') {
            if (entry.dispatchOwner === 'legacy-topic' && entry.handoff?.proof) {
              try {
                const ledger = await query('coordination.source', { unitId: entry.unitId, revision: entry.unitRevision })
                if (ledger?.dispatchOwner === 'coordination' && ledger.frozen)
                  await finishHandoff({ ...entry, generation: entry.handoff.proof.generation, groupId }, ledger)
                else if (ledger?.dispatchOwner === 'legacy-topic' && ledger.fence === entry.generation
                  && ledger.id === entry.handoff.proof.dynamicSourceId) onRecovered(entry.reservationId)
              } catch (error) { onError(entry.reservationId, error) }
            }
            continue
          }
          const request = { ...entry, groupId }
          try {
            const { ledger } = entry.frozen ? { ledger: await query('coordination.source', { unitId: entry.unitId, revision: entry.unitRevision }) }
              : await ensureSource(request)
            if (ledger.state === 'rejected') {
              await finishHandoff(request, ledger)
            } else if (ledger.resolvedBy) {
              await updateResident(request, 'accepted', { coordinationId: ledger.coordinationId, settled: true })
            } else if (ledger.state === 'accepted') {
              const pending = ledger.pendingClarifications ?? []
              await updateResident(request, pending.length ? 'needs_clarification' : 'accepted', { coordinationId: ledger.coordinationId, settled: !pending.length,
                ...(pending.length ? { clarification: pending.map(item => item.question).join('；') } : {}) })
              const state = await query('coordination.get', { coordinationId: ledger.coordinationId })
              const proposal = ledger.acceptedProposal ?? state.coordination.proposal
              if (['change','resolve','schedule-change','occurrence-control'].includes(proposal?.kind)) await onChanged({ coordination: state.coordination, members: state.members })
              await prepareSummary(request, ledger.coordinationId, `accepted:${request.reservationId}`,
                await acceptanceText(proposal, proposal?.resolution?.members?.length ?? proposal?.members?.length ?? state.members.length), ['change','schedule-change','occurrence-control'].includes(proposal?.kind)
                  ? { noticeKind: 'control', sourceAcceptanceId: ledger.id } : {})
            } else if (ledger.state === 'needs_clarification') {
              await updateResident(request, 'needs_clarification', { coordinationId: ledger.coordinationId, clarification: ledger.question })
              await prepareSummary(request, ledger.coordinationId, `clarification:${request.reservationId}`, ledger.question)
            } else if (ledger.state === 'reserved' && !frozen && config.enabled === true && !admissions.has(entry.reservationId)
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
            const settled = await query('coordination.source', { unitId: entry.unitId, revision: entry.unitRevision })
            if (settled && (settled.resolvedBy || ['accepted','needs_clarification'].includes(settled.state))) onRecovered(entry.reservationId)
          } catch (error) { onError(entry.reservationId, error) }
        }
        if (!frozen) {
          await dispatch(groupId)
          for (const coordination of await query('coordination.list', { groupId })) {
            try { await command('coordination.aggregate', { coordinationId: coordination.id }) }
            catch (error) { onError(coordination.id, error) }
          }
        }
      })().finally(() => running.delete(groupId))
      running.set(groupId, work); return work
    },
    context, submit, quotedReminderContext,
    async whenIdle() { await Promise.allSettled([...running.values()]) },
    async close() { closed = true; await planner.close?.(); await Promise.allSettled([...running.values()]) },
  }
}
