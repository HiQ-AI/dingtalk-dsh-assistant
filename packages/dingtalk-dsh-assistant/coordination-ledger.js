import { assertTaskContextSemantics } from './task-input-contract.js'

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

export function coordinationLedger({ get, put, all, fail, text, integer, array, record, clone, digest, apply, now }) {
  const version = task => ({ requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0,
    controlRevision: task.controlRevision, runSequence: task.runSequence })
  const current = member => {
    const task = get('dynamic_tasks', member.taskId)
    const expected = member.effectiveVersion ?? member.preconditionVersion
    return ['requirementRevision','controlRevision','runSequence'].every(key => version(task)[key] === expected[key])
      && (member.effectiveVersion ? (task.contextRevision ?? 0) >= expected.contextRevision : (task.contextRevision ?? 0) === expected.contextRevision)
  }
  const fulfilled = member => {
    if (!member.completionReceipt || !member.completionProof || !current(member)) return false
    const task = get('dynamic_tasks', member.taskId)
    const proof = member.completionProof
    return task.status === 'completed' && task.completion?.commandId === proof.commandId
      && task.completion.instructionIds?.includes(member.id)
      && ['requirementRevision','controlRevision','runSequence'].every(key => proof[key] === version(task)[key])
      && proof.contextRevision >= member.effectiveVersion.contextRevision
  }
  const waiting = member => member.dependencies.filter(id => !fulfilled(get('dynamic_coordination_members', id)))
  const taskMembers = taskId => all('dynamic_coordination_members').filter(m => m.taskId === taskId
    && !['cancelled','superseded','fulfilled'].includes(m.state)
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
      if (!current(member)) {
        if (bound?.instructionIds.includes(member.id)) fail('DYNAMIC_COORDINATION_COVERAGE_STALE', member.id)
        continue
      }
      if (waiting(member).length || member.state !== 'applied') fail('DYNAMIC_COORDINATION_WAITING', member.id)
      if (!bound?.instructionIds.includes(member.id)) fail('DYNAMIC_COORDINATION_COVERAGE_STALE', member.id)
    }
  }
  const view = member => {
    const coordination = get('dynamic_coordination', member.coordinationId), dependencies = waiting(member)
    const reason = coordination.state === 'cancelled' || ['cancelled','superseded'].includes(member.state) ? 'cancelled'
      : !current(member) ? 'target_version_changed' : dependencies.length ? 'waiting_dependency' : null
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
  function command(kind, a) {
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
      if (get('dynamic_coordination', id, true)) fail('DYNAMIC_COORDINATION_EXISTS')
      if (array(a.members).length > 100) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
      const members = a.members.map(input => {
        record(input)
        const task = get('dynamic_tasks', text(input.taskId, 'taskId'))
        if (task.groupId !== source.groupId) fail('DYNAMIC_COORDINATION_SCOPE')
        if (!['preserve','replan'].includes(input.progressImpact)) fail('DYNAMIC_COORDINATION_IMPACT_REQUIRED')
        const envelope = clone(record(input.command))
        const instructionId = text(input.instructionId, 'instructionId')
        if (envelope.id !== `coordination-command:${id}:${instructionId}`) fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        assertTaskContextSemantics({ ...envelope.args, progressImpact: input.progressImpact })
        if (!['task.supplement','task.revise','task.reopen','task.control','task.coordination.input'].includes(envelope.kind)
          || envelope.args?.taskId !== task.taskId || typeof envelope.id !== 'string') fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        if (input.progressImpact === 'preserve' && ['task.revise','task.reopen'].includes(envelope.kind)) fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        if (input.progressImpact === 'replan' && envelope.kind === 'task.supplement') fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        const member = { id: instructionId, coordinationId: id, taskId: task.taskId,
          original: source.original, progressImpact: input.progressImpact, preconditionVersion: version(task),
          ...(input.impactReason ? { impactReason: text(input.impactReason, 'impactReason') } : {}),
          command: envelope, commandDigest: digest(envelope), dependencies: array(input.dependencies ?? []), state: 'ready',
          existingInputs: all('dynamic_executions').filter(e => e.taskId === task.taskId && e.status === 'running' && !e.drained)
            .map(e => ({ executionId: e.executionId, inputVersion: e.inputVersion, leaseEpoch: e.leaseEpoch })) }
        if (get('dynamic_coordination_members', member.id, true)) fail('DYNAMIC_COORDINATION_MEMBER_EXISTS')
        return member
      })
      if (!members.length && a.readOnly !== true || new Set(members.map(m => m.id)).size !== members.length
        || new Set(members.map(m => m.taskId)).size !== members.length
        || new Set(members.map(m => m.command.id)).size !== members.length) fail('DYNAMIC_COORDINATION_MEMBERS_INVALID')
      const graph = new Map([...all('dynamic_coordination_members').filter(m => !['cancelled','superseded'].includes(m.state)), ...members].map(m => [m.id, m]))
      const visited = new Set()
      const visit = (id, stack = new Set()) => {
        if (stack.has(id)) fail('DYNAMIC_COORDINATION_CYCLE')
        if (visited.has(id)) return
        const member = graph.get(id)
        if (!member) fail('DYNAMIC_COORDINATION_DEPENDENCY_MISSING')
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
      for (const member of graph.values()) {
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
      const coordination = { id, revision: 1, sourceId: source.id, groupId: source.groupId, topicRefs: a.topicRefs ?? [],
        sourceFence: source.fence, memberIds: members.map(m => m.id), state: 'active', createdAt: now(),
        ...(a.proposal ? { proposal: clone(record(a.proposal)) } : {}), allTogether: a.allTogether === true }
      members.forEach(m => put('dynamic_coordination_members', m))
      put('dynamic_coordination', coordination)
      source.state = 'accepted'; source.coordinationId = id; put('dynamic_coordination_sources', source)
      return { coordination, members }
    }
    if (kind === 'coordination.apply') {
      const member = get('dynamic_coordination_members', a.instructionId)
      const coordination = get('dynamic_coordination', member.coordinationId)
      const source = get('dynamic_coordination_sources', coordination.sourceId)
      if (source.frozen || source.dispatchOwner !== 'coordination' || source.fence !== coordination.sourceFence) fail('DYNAMIC_COORDINATION_SOURCE_STALE')
      if (coordination.revision !== a.expectedRevision || coordination.state !== 'active') fail('DYNAMIC_COORDINATION_REVISION_STALE')
      if (member.state === 'applied') return { member }
      if (member.state !== 'ready' || !current(member)) fail('DYNAMIC_COORDINATION_VERSION_STALE')
      const dependencies = waiting(member)
      if (dependencies.length) return { member, waiting: dependencies }
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
  return { command, gate, coverage, scope, claimScope, view, waiting, current, version }
}
