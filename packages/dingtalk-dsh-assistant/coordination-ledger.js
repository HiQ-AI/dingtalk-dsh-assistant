import { assertTaskContextSemantics } from './task-input-contract.js'
import { freezeCoordinationSourceOrder } from './coordination-changes.js'

// Trusted Host adapter. All callbacks share the TaskStore connection and transaction.
export const coordinationSchema = `
CREATE TABLE dynamic_coordination(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_members(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE UNIQUE INDEX coordination_source_unit ON dynamic_coordination_sources(json_extract(body,'$.unitId'),json_extract(body,'$.revision'));
CREATE UNIQUE INDEX IF NOT EXISTS coordination_notification_event ON dynamic_notifications(json_extract(body,'$.payload.fact.coordinationId'),json_extract(body,'$.payload.fact.eventId')) WHERE json_extract(body,'$.kind')='coordination';
CREATE TABLE IF NOT EXISTS dynamic_task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE IF NOT EXISTS dynamic_coordination_consumers(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
`

export function coordinationLedger({ get, put, all, fail, text, integer, array, record, clone, digest, apply, now, validateOwner, triggerState = () => ({ eligible: true }), notifyTask = () => {} }) {
  const version = task => ({ requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0,
    controlRevision: task.controlRevision, runSequence: task.runSequence })
  const current = member => {
    const task = get('dynamic_tasks', member.taskId)
    const expected = member.effectiveVersion ?? member.preconditionVersion
    return ['requirementRevision','controlRevision','runSequence'].every(key => version(task)[key] === expected[key])
      && (member.effectiveVersion && !member.observation ? (task.contextRevision ?? 0) >= expected.contextRevision : (task.contextRevision ?? 0) === expected.contextRevision)
  }
  const fulfilled = member => {
    if (['paused','cancelled'].includes(member.control) || ['cancelled','superseded'].includes(member.state)
      || get('dynamic_coordination', member.coordinationId).state !== 'active') return false
    if (!member.completionReceipt || !member.completionProof || !current(member)) return false
    const task = get('dynamic_tasks', member.taskId)
    const proof = member.completionProof
    return task.status === 'completed' && task.completion?.commandId === proof.commandId
      && (member.observation || task.completion.instructionIds?.includes(member.id))
      && ['requirementRevision','controlRevision','runSequence'].every(key => proof[key] === version(task)[key])
      && proof.contextRevision >= member.effectiveVersion.contextRevision
  }
  const waiting = member => member.dependencies.filter(id => !fulfilled(get('dynamic_coordination_members', id)))
  const taskMembers = taskId => all('dynamic_coordination_members').filter(m => !m.observation && m.taskId === taskId
    && !['cancelled','superseded','fulfilled','template'].includes(m.state)
    && get('dynamic_coordination', m.coordinationId).state !== 'cancelled')
  const scope = (taskId, inputVersion) => {
    const task = get('dynamic_tasks', taskId)
    return { kind: 'instruction-scope', taskId, inputVersion, ...version(task),
      instructionIds: taskMembers(taskId).filter(current).map(m => m.id).sort(), boundAt: now() }
  }
  const gate = execution => {
    const bound = execution.instructionScope
    if (bound && (bound.taskId !== execution.taskId || bound.inputVersion !== execution.inputVersion)) fail('DYNAMIC_COORDINATION_COVERAGE_STALE')
    for (const member of taskMembers(execution.taskId)) {
      const existing = member.existingInputs?.some(input => input.executionId === execution.executionId && input.inputVersion === execution.inputVersion)
      if (existing && !bound?.instructionIds.includes(member.id)) continue
      const batch = get('dynamic_coordination', member.coordinationId)
      if (batch.allTogether && batch.pendingClarifications?.length) fail('DYNAMIC_COORDINATION_WAITING', member.id)
      if (!current(member)) {
        if (bound?.instructionIds.includes(member.id)) fail('DYNAMIC_COORDINATION_COVERAGE_STALE', member.id)
        continue
      }
      if (!['paused','cancelled'].includes(member.control) && member.reorderAssessment?.state === 'assessed'
        && member.reorderAssessment.decision === 'continue_existing'
        && member.reorderExistingInputs?.some(input => input.executionId === execution.executionId && input.inputVersion === execution.inputVersion)) continue
      if (member.reorderAssessment?.state === 'pending' || member.reorderAssessment?.state === 'needs_clarification' || member.control === 'paused' || member.control === 'cancelled' || !triggerState(member.id).eligible || waiting(member).length || member.state !== 'applied') fail('DYNAMIC_COORDINATION_WAITING', member.id)
      if (!bound?.instructionIds.includes(member.id)) fail('DYNAMIC_COORDINATION_COVERAGE_STALE', member.id)
    }
  }
  const view = member => {
    const coordination = get('dynamic_coordination', member.coordinationId), dependencies = waiting(member)
    const trigger = triggerState(member.id)
      const reason = coordination.allTogether && coordination.pendingClarifications?.length ? 'waiting_batch_clarification'
      : coordination.state === 'cancelled' || member.control === 'cancelled' || ['cancelled','superseded'].includes(member.state) ? 'cancelled'
      : member.reorderAssessment && ['pending','needs_clarification'].includes(member.reorderAssessment.state) ? `reorder_${member.reorderAssessment.state}`
      : member.control === 'paused' ? 'paused' : !current(member) ? 'target_version_changed'
      : member.observation && member.state !== 'fulfilled' ? 'waiting_completion_proof'
      : dependencies.length ? 'waiting_dependency' : !trigger.eligible ? trigger.reason : null
    return { ...member, eligible: coordination.state === 'active' && member.state === 'ready' && reason === null,
      waitingReason: reason === null ? null : { code: reason, dependencyInstructionIds: dependencies } }
  }
  const claimScope = execution => {
    const bound = execution.instructionScope ?? { kind: 'existing', taskId: execution.taskId,
      inputVersion: execution.inputVersion, instructionIds: [], boundAt: now() }
    const task = get('dynamic_tasks', execution.taskId)
    return { ...bound, acceptedVersion: bound.acceptedVersion ?? {
      requirementRevision: bound.requirementRevision ?? execution.requirementRevision,
      contextRevision: bound.contextRevision ?? null, controlRevision: bound.controlRevision ?? execution.controlRevision,
      runSequence: bound.runSequence ?? task.runSequence }, ...version(task),
      effectiveInstructions: bound.instructionIds.map(id => get('dynamic_coordination_members', id))
        .filter(m => m.state === 'applied' && current(m))
        .map(m => ({ instructionId: m.id, effectiveVersion: clone(m.effectiveVersion), commandId: m.command.id })) }
  }
  function reconcileObservation(member) {
    if (!member.observation || ['cancelled','superseded'].includes(member.state) || member.control === 'cancelled') return
    const task = get('dynamic_tasks', member.taskId), completion = task.completion
    const receipt = completion?.commandId ? get('dynamic_receipts', completion.commandId, true) : null
    const decision = receipt?.taskDecision
    const valid = current(member) && task.status === 'completed' && decision?.decision?.action === 'complete'
      && decision.taskId === task.taskId && decision.id === completion.commandId
      && ['requirementRevision','controlRevision','contextRevision','runSequence'].every(key => decision[key] === version(task)[key]
        && completion[key] === version(task)[key])
    member.state = valid ? 'fulfilled' : 'observing'
    if (valid) {
      member.completionReceipt = completion.commandId
      member.completionProof = { eventId: receipt.completionEvent?.id ?? `task-decision:${decision.id}`,
        eventSource: receipt.completionEvent ? 'task-ledger' : 'task-decision-receipt', sequence: receipt.completionEvent?.sequence ?? 0,
        commandId: decision.id, taskDecisionReceiptId: decision.id, ...version(task) }
    } else { delete member.completionReceipt; delete member.completionProof }
    put('dynamic_coordination_members', member)
  }
  function activateMember(member, source, coordination, revision = coordination.revision) {
    if (member.observation) return reconcileObservation(member)
    if (!member.dependencies.length || !member.existingInputs.length) return
    member.reorderAssessment = { id: `initial-order:${source.id}:${member.id}`, sourceId: source.id, revision,
      state: 'pending', afterInstructionIds: member.dependencies, original: source.original, requestedAt: now() }
    put('dynamic_coordination_members', member)
    notifyTask(member.taskId, {coordinationId:coordination.id,instructionId:member.id,sourceId:source.id,original:source.original,
      assessment:clone(member.reorderAssessment),instruction:'首次顺序安排涉及正在运行的任务。只读评估既有输入与后续依赖，不停止或重启工作，不追溯承诺顺序；不清楚则需澄清。'})
  }
  function prepareMember(input, id, source) {
    record(input)
    const taskId = text(input.taskId, 'taskId'), instructionId = text(input.instructionId, 'instructionId')
    let task = get('dynamic_tasks', taskId, true)
    if (input.createCommand) {
      const creation = clone(record(input.createCommand))
      if (task || creation.id !== `coordination-create:${id}:${instructionId}` || creation.kind !== 'task.create'
        || creation.args?.taskId !== taskId || creation.args.groupId !== source.groupId || creation.args.ownerActorId !== source.actorId
        || creation.args.coordinationHold?.coordinationId !== id || creation.args.coordinationHold?.instructionId !== instructionId) fail('DYNAMIC_COORDINATION_CREATE_INVALID')
      apply(creation); task = get('dynamic_tasks', taskId)
    }
    if (!task || task.groupId !== source.groupId) fail('DYNAMIC_COORDINATION_SCOPE')
    if (input.observation === true) {
      const envelope = clone(record(input.command)), args = envelope.args
      if (input.createCommand || envelope.kind !== 'coordination.observe' || envelope.id !== `coordination-command:${id}:${instructionId}`
        || args?.taskId !== taskId || (input.dependencies ?? []).length || get('dynamic_coordination_members', instructionId, true)
        || args.expectedRequirementRevision !== task.requirementRevision || args.expectedControlRevision !== task.controlRevision
        || args.expectedContextRevision !== (task.contextRevision ?? 0) || args.expectedRunSequence !== task.runSequence)
        fail('DYNAMIC_COORDINATION_OBSERVATION_INVALID')
      return { id: instructionId, coordinationId: id, taskId, observation: true, original: source.original,
        preconditionVersion: version(task), effectiveVersion: version(task), command: envelope, commandDigest: digest(envelope),
        dependencies: [], state: 'observing', existingInputs: [] }
    }
    if (!['preserve','replan'].includes(input.progressImpact)) fail('DYNAMIC_COORDINATION_IMPACT_REQUIRED')
    const envelope = clone(record(input.command))
    if (envelope.id !== `coordination-command:${id}:${instructionId}` || envelope.args?.taskId !== taskId) fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
    assertTaskContextSemantics({ ...envelope.args, progressImpact: input.progressImpact })
    if (!['task.supplement','task.revise','task.reopen','task.control','task.coordination.input','task.coordination.start'].includes(envelope.kind)
      || input.progressImpact === 'preserve' && ['task.revise','task.reopen'].includes(envelope.kind)
      || input.progressImpact === 'replan' && envelope.kind === 'task.supplement') fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
    if (get('dynamic_coordination_members', instructionId, true)) fail('DYNAMIC_COORDINATION_MEMBER_EXISTS')
    return { id: instructionId, coordinationId: id, taskId, requiresTrigger: input.requiresTrigger === true, original: source.original, progressImpact: input.progressImpact,
      preconditionVersion: version(task), ...(input.impactReason ? { impactReason: text(input.impactReason, 'impactReason') } : {}),
      command: envelope, commandDigest: digest(envelope), dependencies: array(input.dependencies ?? []), state: 'ready',
      ...(input.createCommand ? { createCommand: clone(input.createCommand) } : {}),
      existingInputs: all('dynamic_executions').filter(e => e.taskId === taskId && e.status === 'running' && !e.drained)
        .map(e => ({ executionId: e.executionId, inputVersion: e.inputVersion, leaseEpoch: e.leaseEpoch })) }
  }
  function checkGraph(overrides) {
    const graph = new Map([...all('dynamic_coordination_members'), ...overrides].map(m => [m.id,m]))
    const edges = new Map()
    for (const m of graph.values()) if (graphMemberActive(m)) {
      const parents = edges.get(m.taskId) ?? new Set()
      const dependencies = ['pending','needs_clarification'].includes(m.reorderAssessment?.state)
        ? m.reorderAssessment.afterInstructionIds : m.dependencies
      for (const id of dependencies) {
        const parent = graph.get(id)
        if (!parent) fail('DYNAMIC_COORDINATION_DEPENDENCY_MISSING')
        if (get('dynamic_tasks', parent.taskId).groupId !== get('dynamic_tasks', m.taskId).groupId) fail('DYNAMIC_COORDINATION_SCOPE')
        parents.add(parent.taskId)
      }
      edges.set(m.taskId, parents)
    }
    const seen = new Set(), stack = new Set()
    const visit = id => { if (stack.has(id)) fail('DYNAMIC_COORDINATION_CYCLE'); if (seen.has(id)) return
      stack.add(id); for (const parent of edges.get(id) ?? []) visit(parent); stack.delete(id); seen.add(id) }
    for (const id of edges.keys()) visit(id)
  }
  function graphMemberActive(member) {
    // Retain inactive records for stable dependency references and audit, but
    // their retired constraints cannot participate in the effective graph.
    return !['cancelled','superseded'].includes(member.state) && member.control !== 'cancelled'
      && get('dynamic_coordination',member.coordinationId,true)?.state !== 'cancelled'
  }
  function instantiateRecurring({ coordinationId, occurrenceId, inputs }) {
    const coordination = get('dynamic_coordination', coordinationId)
    const source = get('dynamic_coordination_sources', coordination.sourceId)
    if (coordination.state !== 'active' || source.frozen || source.dispatchOwner !== 'coordination'
      || source.fence !== coordination.sourceFence) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
    const members = inputs.map(input => prepareMember(input, coordinationId, source))
    checkGraph(members)
    for (const member of members) {
      member.recurringOccurrenceId = occurrenceId
      member.templateInstructionId = inputs.find(input => input.instructionId === member.id).templateInstructionId
      const template = get('dynamic_coordination_members', member.templateInstructionId)
      member.original = template.original
      member.materializationSourceId = source.id
      member.authorizationSourceRefs = clone(template.command.args.sourceRefs ?? [])
      put('dynamic_coordination_members', member)
      coordination.memberIds.push(member.id)
    }
    put('dynamic_coordination', coordination)
    return members
  }
  function command(kind, a) {
    if (kind === 'coordination.observe.reconcile') {
      const coordination = get('dynamic_coordination', a.coordinationId)
      for (const id of coordination.memberIds) reconcileObservation(get('dynamic_coordination_members', id))
      return { coordination }
    }
    if (kind === 'coordination.reserve') {
      const unitId = text(a.unitId, 'unitId'), revision = integer(a.revision, 'revision')
      const id = digest({ unitId, revision }), previous = get('dynamic_coordination_sources', id, true)
      if (previous) {
        if (previous.original !== a.original || previous.groupId !== a.groupId) fail('DYNAMIC_COORDINATION_SOURCE_CONFLICT')
        if (a.reservationId !== undefined && (previous.reservationId !== a.reservationId || previous.reservationGeneration !== a.reservationGeneration)) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
        return { source: previous }
      }
      const source = { id, unitId, revision, fence: 1, dispatchOwner: 'coordination', state: 'reserved',
        groupId: text(a.groupId, 'groupId'), original: text(a.original, 'original'), settled: false, createdAt: now(),
        ...(a.reservationId !== undefined ? { reservationId: text(a.reservationId, 'reservationId'), reservationGeneration: integer(a.reservationGeneration, 'reservationGeneration'),
          actorId: text(a.actorId, 'actorId'), sourceRefs: clone(array(a.sourceRefs)), sourceMessageId: text(a.sourceMessageId, 'sourceMessageId') } : {}) }
      put('dynamic_coordination_sources', source); return { source }
    }
    if (kind.startsWith('coordination.source.')) {
      const source = get('dynamic_coordination_sources', a.sourceId)
      if (source.fence !== a.fence || source.dispatchOwner !== 'coordination') fail('DYNAMIC_COORDINATION_SOURCE_STALE')
      if (kind === 'coordination.source.freezeHandoff') {
        if (source.state !== 'rejected') fail('DYNAMIC_COORDINATION_SOURCE_STALE')
        if (all('dynamic_coordination').some(c => c.sourceId === source.id)) fail('DYNAMIC_COORDINATION_HANDOFF_UNSAFE')
        source.frozen = true
        source.handoffProof = { kind: 'coordination.no-commands', reservationId: source.reservationId,
          generation: source.reservationGeneration, unitId: source.unitId, unitRevision: source.revision,
          freezeId: text(a.freezeId, 'freezeId'), dynamicSourceId: source.id, commandCount: 0, unknownCount: 0, checkedAt: now() }
        put('dynamic_coordination_sources', source); return { source, handoffProof: source.handoffProof }
      }
      if (kind === 'coordination.source.completeHandoff') {
        if (!source.frozen || digest(source.handoffProof) !== digest(a.handoffProof)) fail('DYNAMIC_COORDINATION_HANDOFF_UNSAFE')
        source.fence++; source.dispatchOwner = 'legacy-topic'; source.settled = false
        put('dynamic_coordination_sources', source); return { source }
      }
      if (source.frozen || source.state === 'accepted') fail('DYNAMIC_COORDINATION_SOURCE_STALE')
      if (kind === 'coordination.source.failed') {
        source.attemptCount = (source.attemptCount ?? 0) + 1; source.lastError = text(a.code, 'code')
        source.nextRetryAt = source.attemptCount < 3 ? new Date(Date.parse(now()) + [5000,60000][source.attemptCount - 1]).toISOString() : null
      } else if (kind === 'coordination.source.reject') {
        source.state = 'rejected'; source.rejectionReason = text(a.reason, 'reason')
      } else if (kind === 'coordination.source.clarify') {
        if (!['reserved','needs_clarification'].includes(source.state)) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
        source.state = 'needs_clarification'; source.question = text(a.question, 'question'); source.candidates = clone(array(a.candidates ?? []))
        source.coordinationId = text(a.coordinationId, 'coordinationId')
        const existing = get('dynamic_coordination', source.coordinationId, true)
        if (existing && (existing.sourceId !== source.id || existing.state !== 'needs_clarification')) fail('DYNAMIC_COORDINATION_EXISTS')
        put('dynamic_coordination', { id: source.coordinationId, revision: 1, sourceId: source.id, sourceFence: source.fence,
          groupId: source.groupId, topicRefs: [], memberIds: [], state: 'needs_clarification', question: source.question, createdAt: existing?.createdAt ?? now() })
      } else fail('DYNAMIC_COMMAND_UNKNOWN', kind)
      put('dynamic_coordination_sources', source); return { source }
    }
    if (kind === 'coordination.accept') {
      const source = get('dynamic_coordination_sources', a.sourceId)
      if (source.fence !== a.fence || source.dispatchOwner !== 'coordination' || source.state !== 'reserved' || source.frozen) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
      const id = text(a.coordinationId, 'coordinationId')
      const replacing = get('dynamic_coordination', id, true)
      if (replacing && (replacing.state !== 'needs_clarification' || replacing.revision !== a.replaceClarificationRevision)) fail('DYNAMIC_COORDINATION_EXISTS')
      if (array(a.members).length > 100) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
      const members = a.members.map(input => prepareMember(input, id, source))
      checkGraph(members)
      const pending = clone(array(a.pendingClarifications ?? []))
      if (pending.length > 100 || new Set(pending.map(item => text(item.clarificationId, 'clarificationId'))).size !== pending.length) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
      pending.forEach(item => { text(item.question, 'question'); array(item.candidates ?? []) })
      const sourceOrder = freezeCoordinationSourceOrder(a.sourceOrder,source,members,pending)
      if (!members.length && !pending.length && a.readOnly !== true || new Set(members.map(m => m.id)).size !== members.length
        || new Set(members.map(m => m.taskId)).size !== members.length
        || new Set(members.map(m => m.command.id)).size !== members.length) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
      const graph = new Map([...all('dynamic_coordination_members'), ...members].map(m => [m.id, m]))
      const visited = new Set()
      const visit = (id, stack = new Set()) => {
        if (stack.has(id)) fail('DYNAMIC_COORDINATION_CYCLE')
        if (visited.has(id)) return
        const member = graph.get(id)
        if (!member) fail('DYNAMIC_COORDINATION_DEPENDENCY_MISSING')
        if (!graphMemberActive(member)) { visited.add(id); return }
        stack.add(id)
        for (const parent of member.dependencies) {
          if (!graph.has(parent)) fail('DYNAMIC_COORDINATION_DEPENDENCY_MISSING')
          if (get('dynamic_tasks', graph.get(parent).taskId).groupId !== source.groupId) fail('DYNAMIC_COORDINATION_SCOPE')
          visit(parent, stack)
        }
        stack.delete(id)
        visited.add(id)
      }
      members.forEach(m => visit(m.id))
      // Dependencies from separate arrangements may use different instruction
      // identities for the same task; instruction-only cycle checks miss A↔B.
      const taskEdges = new Map()
      for (const member of graph.values()) if (graphMemberActive(member)) {
        const parents = taskEdges.get(member.taskId) ?? new Set()
        member.dependencies.forEach(id => parents.add(graph.get(id).taskId))
        taskEdges.set(member.taskId, parents)
      }
      const taskVisited = new Set(), taskVisiting = new Set()
      const visitTask = taskId => {
        if (taskVisiting.has(taskId)) fail('DYNAMIC_COORDINATION_CYCLE')
        if (taskVisited.has(taskId)) return
        taskVisiting.add(taskId)
        for (const parent of taskEdges.get(taskId) ?? []) visitTask(parent)
        taskVisiting.delete(taskId); taskVisited.add(taskId)
      }
      for (const taskId of taskEdges.keys()) visitTask(taskId)
      const coordination = { id, revision: replacing ? replacing.revision + 1 : 1, sourceId: source.id, groupId: source.groupId, topicRefs: a.topicRefs ?? [],
        sourceFence: source.fence, memberIds: members.map(m => m.id), state: 'active', createdAt: now(),
        history: replacing ? [...(replacing.history ?? []), { revision: replacing.revision, sourceId: replacing.sourceId, reason: 'clarification-resolved', at: now() }] : [],
        ...(a.proposal ? { proposal: clone(record(a.proposal)) } : {}), allTogether: a.allTogether === true,
        pendingClarifications: pending, hadPartialClarifications: pending.length > 0, pendingSourceId: pending.length ? source.id : null }
      if (sourceOrder) coordination.sourceOrder = sourceOrder
      members.forEach(m => put('dynamic_coordination_members', m))
      put('dynamic_coordination', coordination)
      members.forEach(member => activateMember(member, source, coordination))
      if (replacing) {
        const old = get('dynamic_coordination_sources', replacing.sourceId)
        old.state = 'accepted'; old.resolvedBy = source.id; old.coordinationId = id; old.settled = true; put('dynamic_coordination_sources', old)
      }
      source.state = 'accepted'; source.coordinationId = id; source.settled = !pending.length
      source.pendingClarifications = clone(pending); put('dynamic_coordination_sources', source)
      source.acceptedProposal = clone(a.proposal ?? {}); source.acceptedRevision = coordination.revision; source.acceptedKind = replacing ? 'resolve' : 'arrangement'
      put('dynamic_coordination_sources', source)
      return { coordination, members }
    }
    if (kind === 'coordination.apply') {
      const member = get('dynamic_coordination_members', a.instructionId)
      const coordination = get('dynamic_coordination', member.coordinationId)
      const source = get('dynamic_coordination_sources', coordination.sourceId)
      if (source.frozen || source.dispatchOwner !== 'coordination' || source.fence !== coordination.sourceFence) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
      if (coordination.revision !== a.expectedRevision || coordination.state !== 'active') fail('DYNAMIC_COORDINATION_REVISION_STALE')
      if (member.observation) fail('DYNAMIC_COORDINATION_OBSERVATION_READ_ONLY')
      if (member.reorderAssessment && ['pending','needs_clarification'].includes(member.reorderAssessment.state)) return { member, waiting: ['owner_assessment'] }
      if (member.state === 'applied') return { member }
      if (member.state !== 'ready' || !current(member)) fail('DYNAMIC_COORDINATION_VERSION_STALE')
      const dependencies = waiting(member)
      if (coordination.allTogether && coordination.pendingClarifications?.length) return { member, waiting: ['waiting_batch_clarification'] }
      if (dependencies.length) return { member, waiting: dependencies }
      if (member.control === 'paused' || member.control === 'cancelled' || !triggerState(member.id).eligible) return { member, waiting: [member.control ?? triggerState(member.id).reason] }
      // The outer TaskStore receipt commits the frozen command and task mutation together.
      const receipt = apply(member.command)
      member.state = 'applied'; member.receipt = receipt; member.effectiveVersion = version(get('dynamic_tasks', member.taskId))
      put('dynamic_coordination_members', member); return { member }
    }
    if (kind === 'coordination.member.handoff') {
      const member = get('dynamic_coordination_members', a.instructionId)
      if (!['applied','fulfilled'].includes(member.state)) fail('DYNAMIC_COORDINATION_VERSION_STALE')
      member.hostHandoffAt ??= now(); put('dynamic_coordination_members', member); return { member }
    }
    if (kind === 'coordination.reorder.assess') {
      const task = validateOwner(a.binding), member = get('dynamic_coordination_members', a.instructionId)
      const coordination = get('dynamic_coordination', member.coordinationId), pending = member.reorderAssessment
      if (member.taskId !== task.taskId || !pending || pending.id !== a.assessmentId || pending.state !== 'pending'
        || coordination.state !== 'active' || member.control === 'cancelled' || member.control === 'paused'
        || coordination.revision < pending.revision || !current(member)) fail('DYNAMIC_COORDINATION_ASSESSMENT_STALE')
      if (!['continue_existing','safe_point','needs_clarification'].includes(a.decision)) fail('DYNAMIC_COORDINATION_ASSESSMENT_INVALID')
      const evidence = array(a.evidence)
      if (!evidence.length || evidence.some(item => typeof item !== 'string' || !item.trim())) fail('DYNAMIC_COORDINATION_ASSESSMENT_EVIDENCE_REQUIRED')
      const executions = all('dynamic_executions').filter(item => item.taskId === task.taskId)
      const active = executions.filter(item => !item.drained || !['succeeded','failed','cancelled','stale'].includes(item.status))
      if (a.decision === 'safe_point' && (active.length || all('dynamic_operations').some(item => item.taskId === task.taskId
        && !['succeeded','failed','cancelled'].includes(item.state)))) fail('DYNAMIC_COORDINATION_SAFE_POINT_UNPROVEN')
      pending.state = a.decision === 'needs_clarification' ? 'needs_clarification' : 'assessed'
      pending.decision = a.decision; pending.summary = text(a.summary, 'summary'); pending.evidence = clone(evidence)
      pending.ownerBinding = clone(a.binding); pending.decidedAt = now()
      if (a.decision !== 'needs_clarification') {
        member.dependencies = pending.afterInstructionIds
        member.reorderExistingInputs = a.decision === 'continue_existing' ? active.map(item => ({executionId:item.executionId,inputVersion:item.inputVersion})) : []
        checkGraph([member])
      }
      put('dynamic_coordination_members', member)
      ;(coordination.history ??= []).push({eventId:`${pending.id}:${member.id}`,kind:'owner-reorder-assessment',instructionId:member.id,
        sourceId:pending.sourceId,revision:coordination.revision,decision:a.decision,summary:pending.summary,evidence:clone(evidence),at:now()})
      put('dynamic_coordination',coordination)
      return {member,coordination,alreadyStarted:a.decision === 'continue_existing',futureInputsGated:a.decision !== 'needs_clarification'}
    }
    if (kind === 'coordination.change') {
      const source = get('dynamic_coordination_sources', a.sourceId), coordination = get('dynamic_coordination', a.coordinationId)
      if (source.fence !== a.fence || source.state !== 'reserved' || source.frozen || source.dispatchOwner !== 'coordination'
        || coordination.groupId !== source.groupId || coordination.revision !== a.expectedRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      const change = record(a.change), reason = text(a.reason ?? source.original, 'reason')
      if (change.action === 'resolve-members') {
        const pending = coordination.pendingClarifications ?? [], ids = array(change.clarificationIds)
        if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !pending.some(item => item.clarificationId === id))) fail('DYNAMIC_COORDINATION_CLARIFICATION_STALE')
        const added = array(change.members).map(input => prepareMember(input, coordination.id, source))
        if (!added.length) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
        if (coordination.sourceOrder) {
          const assignments = array(change.resolvedClarifications ?? [])
          if (assignments.length !== added.length || assignments.some(item => !ids.includes(item.clarificationId)
            || !added.some(member => member.id === item.instructionId))
            || new Set(assignments.map(item => item.instructionId)).size !== added.length
            || ids.some(id => !assignments.some(item => item.clarificationId === id))) fail('DYNAMIC_COORDINATION_CLARIFICATION_STALE')
          for (const slot of coordination.sourceOrder) if (ids.includes(slot.clarificationId)) {
            slot.instructionIds = assignments.filter(item => item.clarificationId === slot.clarificationId).map(item => item.instructionId)
            slot.resolvedBy = source.id
          }
        }
        checkGraph(added); added.forEach(m => { put('dynamic_coordination_members', m); activateMember(m, source, coordination, coordination.revision + 1) }); coordination.memberIds.push(...added.map(m => m.id))
        coordination.pendingClarifications = pending.filter(item => !ids.includes(item.clarificationId))
        const original = get('dynamic_coordination_sources', coordination.pendingSourceId)
        original.pendingClarifications = clone(coordination.pendingClarifications); original.settled = !original.pendingClarifications.length
        if (original.settled) original.resolvedBy = source.id
        put('dynamic_coordination_sources', original)
      } else if (change.action === 'resolve') {
        if (coordination.state !== 'needs_clarification') fail('DYNAMIC_COORDINATION_REVISION_STALE')
        const result = command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: coordination.id,
          replaceClarificationRevision: coordination.revision, members: change.members ?? [], readOnly: change.readOnly === true, proposal: change.proposal,
          pendingClarifications: change.proposal?.pendingClarifications ?? [], allTogether: change.proposal?.allTogether === true,
          ...(change.proposal?.sourceOrder ? {sourceOrder:change.proposal.sourceOrder} : {}) })
        const accepted = get('dynamic_coordination_sources', source.id)
        accepted.acceptedProposal = clone(a.proposal ?? change.proposal ?? {}); accepted.acceptedKind = 'resolve'; put('dynamic_coordination_sources', accepted)
        return result
      }
      if (coordination.state === 'needs_clarification' || coordination.state === 'cancelled') fail('DYNAMIC_COORDINATION_REVISION_STALE')
      const selected = array(change.instructionIds ?? coordination.memberIds)
      if (selected.some(id => !coordination.memberIds.includes(id))) fail('DYNAMIC_COORDINATION_SCOPE')
      const members = selected.map(id => get('dynamic_coordination_members', id)), affected = []
      if (change.action === 'resolve-members') {
        // Added members and clarification resolution were committed above, in
        // the same transaction as this source acceptance and revision update.
      } else if (['pause','resume','cancel'].includes(change.action)) {
        for (const member of members) {
          member.control = change.action === 'pause' ? 'paused' : change.action === 'cancel' ? 'cancelled' : 'active'
          if (change.action === 'cancel' && member.state === 'ready') member.state = 'cancelled'
          put('dynamic_coordination_members', member)
          const crossed = ['applied','fulfilled'].includes(member.state)
          affected.push({ instructionId: member.id, alreadyApplied: crossed, completionProof: member.completionProof ?? null })
          if (crossed && member.state !== 'fulfilled') notifyTask(member.taskId, { coordinationId: coordination.id, instructionId: member.id,
            control: member.control, sourceId: source.id, original: source.original, instruction: '协调安排已修改；先核验已发生效果与本次指令范围，不能把撤销安排等同取消原任务或重放业务。' })
        }
        if (change.action === 'cancel' && change.instructionIds === undefined) coordination.state = 'cancelled'
      } else if (change.action === 'append') {
        const added = array(change.members).map(input => prepareMember(input, coordination.id, source))
        if (!added.length) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
        const appendedOrder = freezeCoordinationSourceOrder(change.sourceOrder, source, added, [])
        if (coordination.sourceOrder) {
          if (appendedOrder && !coordination.sourceOrderAppendGap) {
            const offset = coordination.sourceOrder.length
            coordination.sourceOrder.push(...appendedOrder.map(slot=>({...slot,localOrdinal:slot.ordinal,ordinal:offset+slot.ordinal})))
          } else {
            coordination.sourceOrderAppendGap = true
            if (appendedOrder) (coordination.unmappedAppendSources ??= []).push({sourceId:source.id,slots:appendedOrder})
          }
        }
        for (const member of added) for (const oldId of coordination.memberIds) {
          const old = get('dynamic_coordination_members', oldId)
          if (old.taskId === member.taskId && old.control === 'cancelled') { old.state = 'superseded'; put('dynamic_coordination_members', old) }
        }
        checkGraph(added); added.forEach(m => { put('dynamic_coordination_members', m); activateMember(m, source, coordination, coordination.revision + 1) }); coordination.memberIds.push(...added.map(m => m.id))
      } else if (change.action === 'reorder') {
        const changed = array(change.dependencies).map(item => {
          if (!coordination.memberIds.includes(item.instructionId)) fail('DYNAMIC_COORDINATION_SCOPE')
          const member = get('dynamic_coordination_members', item.instructionId)
          if (member.state !== 'ready') {
            if (member.state !== 'applied' || !current(member)) fail('DYNAMIC_COORDINATION_ALREADY_STARTED')
            member.reorderAssessment = {id:`reorder:${source.id}:${member.id}`,sourceId:source.id,revision:coordination.revision+1,
              state:'pending',afterInstructionIds:array(item.afterInstructionIds),original:source.original,requestedAt:now()}
            member.reorderExistingInputs = []
            notifyTask(member.taskId,{coordinationId:coordination.id,instructionId:member.id,sourceId:source.id,original:source.original,
              assessment:clone(member.reorderAssessment),instruction:'先只读评估已运行工作与新顺序。用task_coordination_reorder_assess提交证据：既有输入继续但后续输入受依赖约束、已证实安全点，或需澄清。评估前不修订目标、不取消或重启执行；不能追溯声称已有严格顺序。'})
            return member
          }
          member.dependencies = array(item.afterInstructionIds); return member
        })
        checkGraph(changed.map(m => m.reorderAssessment?.state === 'pending' ? {...m,dependencies:m.reorderAssessment.afterInstructionIds} : m))
        changed.forEach(m => put('dynamic_coordination_members', m))
      } else if (!['schedule','occurrence'].includes(change.action)) fail('DYNAMIC_ARGUMENT_INVALID', 'change.action')
      ;(coordination.history ??= []).push({ eventId: source.id, sourceId: source.id, original: source.original,
        oldRevision: coordination.revision, revision: coordination.revision + 1, change: clone(change), reason, at: now() })
      coordination.revision++; coordination.sourceId = source.id; coordination.sourceFence = source.fence
      if (change.proposal) coordination.proposal = clone(change.proposal)
      put('dynamic_coordination', coordination)
      source.state = 'accepted'; source.coordinationId = coordination.id; source.acceptedProposal = clone(a.proposal ?? change.proposal ?? {})
      source.acceptedRevision = coordination.revision; source.acceptedKind = 'change'; put('dynamic_coordination_sources', source)
      return { coordination, affected }
    }
    if (kind === 'coordination.cancel') {
      const coordination = get('dynamic_coordination', a.coordinationId)
      if (coordination.revision !== a.expectedRevision) fail('DYNAMIC_COORDINATION_REVISION_STALE')
      coordination.revision++; coordination.state = 'cancelled'
      for (const id of coordination.memberIds) {
        const member = get('dynamic_coordination_members', id)
        if (member.state === 'ready') { member.state = 'cancelled'; put('dynamic_coordination_members', member) }
      }
      put('dynamic_coordination', coordination); return { coordination }
    }
    fail('DYNAMIC_COMMAND_UNKNOWN', kind)
  }
  const coverage = taskId => taskMembers(taskId).filter(m => m.state === 'applied' && current(m)).map(m => m.id).sort()
  return { command, gate, coverage, scope, claimScope, view, waiting, current, version, instantiateRecurring }
}
