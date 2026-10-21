import { assertTaskContextSemantics } from './task-input-contract.js'
import { stableId } from './topic-model.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
/** Freeze once from the exact Task versions actually read in this decision window. */
export function freezeCoordinationMembers({ coordinationId, proposal, tasks, source, ownerActorId, instructionRevision, existingMembers = [] }) {
  const keyOf = member => member.action === 'new-task' ? member.creationKey : member.taskId
  if (new Set(proposal.members.map(keyOf)).size !== proposal.members.length) fail('COORDINATION_TASK_DUPLICATE')
  const ids = new Map(existingMembers.filter(m => !['cancelled','superseded'].includes(m.control ?? m.state)).map(m => [m.taskId,m.id]))
  proposal.members.forEach((m, index) => ids.set(keyOf(m), `${coordinationId}:member:${index + 1}${instructionRevision ? `:revision:${instructionRevision}` : ''}`))
  return proposal.members.map(input => {
    const instructionId = ids.get(keyOf(input)), commandId = `coordination-command:${coordinationId}:${instructionId}`
    const dependencies = (input.afterTaskIds ?? []).map(id => ids.get(id) ?? fail('COORDINATION_DEPENDENCY_TARGET_MISSING'))
    if (input.action === 'task-observe') {
      const task = tasks.get(input.taskId)
      if (!task || task.groupId !== source.groupId || task.archivedAt) fail('COORDINATION_TASK_SCOPE')
      if (input.inputVersion !== task.requirementRevision || input.runSequence !== task.runSequence) fail('DYNAMIC_TASK_REVISION_STALE')
      return { instructionId, taskId: task.taskId, observation: true, progressImpact: 'preserve', dependencies: [],
        command: { id: commandId, kind: 'coordination.observe', args: { taskId: task.taskId,
          expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision,
          expectedContextRevision: task.contextRevision ?? 0, expectedRunSequence: task.runSequence } } }
    }
    if (input.action === 'new-task') {
      if (!input.creationKey?.trim() || !input.title?.trim() || !input.objective?.trim() || !input.requirements?.length) fail('COORDINATION_CREATE_CONTRACT_REQUIRED')
      const taskId = stableId('task', `${coordinationId}:${input.creationKey}`)
      const origin = { sourceId: source.sourceId, actorId: source.actorId, unitId: source.unitId, unitRevision: source.unitRevision }
      return { instructionId, taskId, requiresTrigger: true, progressImpact: 'replan', impactReason: input.impactReason,
        dependencies, createCommand: { id: `coordination-create:${coordinationId}:${instructionId}`, kind: 'task.create',
          args: { taskId, groupId: source.groupId, ownerActorId: source.actorId, title: input.title, objective: input.objective,
            request: [input.objective, proposal.commonContext, input.context].filter(Boolean).join('\n\n'), requirements: input.requirements,
            sourceRefs: [source.sourceId], coordinationHold: { coordinationId, instructionId }, metadata: { channel: 'coordination', originalSource: origin } } },
        command: { id: commandId, kind: 'task.coordination.start', args: { taskId, expectedRequirementRevision: 1, expectedControlRevision: 1,
          coordinationId, instructionId, originalSource: origin, sourceRefs: [source.sourceId] } } }
    }
    const task = tasks.get(input.taskId)
    if (!task || task.groupId !== source.groupId || task.archivedAt) fail('COORDINATION_TASK_SCOPE')
    if (input.inputVersion !== task.requirementRevision || input.runSequence !== task.runSequence) fail('DYNAMIC_TASK_REVISION_STALE')
    assertTaskContextSemantics({ progressImpact: input.progressImpact,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.requirements !== undefined ? { acceptanceCriteria: input.requirements } : {}) })
    if (input.action === 'task-cancel' && ![task.ownerActorId, ownerActorId].includes(source.actorId)) fail('COORDINATION_CONTROL_FORBIDDEN')
    if (input.action === 'task-reopen' && task.status !== 'completed') fail('COORDINATION_REOPEN_STATE_INVALID')
    if (input.action === 'task-reopen' && (!task.drained || input.progressImpact !== 'replan')) fail('COORDINATION_REOPEN_STATE_INVALID')
    if (task.control === 'paused' && !['task-continue','task-cancel'].includes(input.action)) fail('COORDINATION_CONTINUE_REQUIRED')
    if (input.action !== 'task-reopen' && input.action !== 'task-cancel' && (task.status !== 'active' || task.control === 'cancelled')) fail('COORDINATION_REOPEN_REQUIRED')
    const text = [proposal.commonContext, input.context].filter(Boolean).join('\n\n')
    const args = { taskId: task.taskId, expectedRequirementRevision: task.requirementRevision,
      expectedControlRevision: task.controlRevision, progressImpact: input.progressImpact,
      action: input.action === 'task-reopen' ? 'reopen' : input.action === 'task-cancel' ? 'cancel' : input.action === 'task-continue' ? 'continue' : 'supplement',
      text, request: `${task.request}\n\n[协调补充 ${instructionId}]\n${text}`,
      sourceRefs: [...new Set([...(task.sourceRefs ?? []), source.sourceId])],
      ...(ownerActorId ? { authorizedOwnerActorId: ownerActorId } : {}),
      originalSource: { sourceId: source.sourceId, actorId: source.actorId, unitId: source.unitId, unitRevision: source.unitRevision },
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.requirements !== undefined ? { requirements: input.requirements } : {}) }
    return { instructionId, taskId: task.taskId, requiresTrigger: true, progressImpact: input.progressImpact, impactReason: input.impactReason,
      dependencies,
      command: { id: commandId, kind: 'task.coordination.input', args } }
  })
}
