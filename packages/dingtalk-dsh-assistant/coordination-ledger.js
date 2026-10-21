import { assertTaskContextSemantics } from './task-input-contract.js'

// Trusted Host adapter. All callbacks share the TaskStore connection and transaction.
export const coordinationSchema = `
CREATE TABLE dynamic_coordination(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE dynamic_coordination_members(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE UNIQUE INDEX coordination_source_unit ON dynamic_coordination_sources(json_extract(body,'$.unitId'),json_extract(body,'$.revision'));
`

export function coordinationLedger({ get, put, all, fail, text, integer, array, record, clone, digest, apply, now }) {
  const version = task => ({ requirementRevision: task.requirementRevision, contextRevision: task.contextRevision ?? 0,
    controlRevision: task.controlRevision, runSequence: task.runSequence })
  const current = member => {
    const task = get('dynamic_tasks', member.taskId)
    return digest(version(task)) === digest(member.effectiveVersion ?? member.preconditionVersion)
  }
  const fulfilled = member => {
    if (!member.completionReceipt || !current(member)) return false
    const task = get('dynamic_tasks', member.taskId)
    return task.status === 'completed'
  }
  const waiting = member => member.dependencies.filter(id => !fulfilled(get('dynamic_coordination_members', id)))
  const gate = taskId => {
    for (const member of all('dynamic_coordination_members').filter(m => m.taskId === taskId && !['cancelled','superseded','fulfilled'].includes(m.state))) {
      if (!current(member) || waiting(member).length || member.state !== 'applied') fail('DYNAMIC_COORDINATION_WAITING', member.id)
    }
  }
  function command(kind, a) {
    if (kind === 'coordination.reserve') {
      const unitId = text(a.unitId, 'unitId'), revision = integer(a.revision, 'revision')
      const id = digest({ unitId, revision }), previous = get('dynamic_coordination_sources', id, true)
      if (previous) {
        if (previous.original !== a.original || previous.groupId !== a.groupId) fail('DYNAMIC_COORDINATION_SOURCE_CONFLICT')
        return { source: previous }
      }
      const source = { id, unitId, revision, fence: 1, dispatchOwner: 'coordination', state: 'reserved',
        groupId: text(a.groupId, 'groupId'), original: text(a.original, 'original'), settled: false, createdAt: now() }
      put('dynamic_coordination_sources', source); return { source }
    }
    if (kind === 'coordination.accept') {
      const source = get('dynamic_coordination_sources', a.sourceId)
      if (source.fence !== a.fence || source.dispatchOwner !== 'coordination' || source.state !== 'reserved') fail('DYNAMIC_COORDINATION_SOURCE_STALE')
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
        if (!['task.supplement','task.revise','task.reopen','task.control'].includes(envelope.kind)
          || envelope.args?.taskId !== task.taskId || typeof envelope.id !== 'string') fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        if (input.progressImpact === 'preserve' && ['task.revise','task.reopen'].includes(envelope.kind)) fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        if (input.progressImpact === 'replan' && envelope.kind === 'task.supplement') fail('DYNAMIC_COORDINATION_COMMAND_INVALID')
        const member = { id: instructionId, coordinationId: id, taskId: task.taskId,
          original: source.original, progressImpact: input.progressImpact, preconditionVersion: version(task),
          command: envelope, commandDigest: digest(envelope), dependencies: array(input.dependencies ?? []), state: 'ready' }
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
        memberIds: members.map(m => m.id), state: 'active', createdAt: now() }
      members.forEach(m => put('dynamic_coordination_members', m))
      put('dynamic_coordination', coordination)
      source.state = 'accepted'; source.coordinationId = id; put('dynamic_coordination_sources', source)
      return { coordination, members }
    }
    if (kind === 'coordination.apply') {
      const member = get('dynamic_coordination_members', a.instructionId)
      const coordination = get('dynamic_coordination', member.coordinationId)
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
  const coverage = taskId => all('dynamic_coordination_members').filter(m => m.taskId === taskId && m.state === 'applied' && current(m)).map(m => m.id).sort()
  return { command, gate, coverage }
}
