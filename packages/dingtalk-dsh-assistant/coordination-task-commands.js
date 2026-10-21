import { assertTaskContextSemantics } from './task-input-contract.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
/** Freeze once from the exact Task versions actually read in this decision window. */
export function freezeCoordinationMembers({ coordinationId, proposal, tasks, source, ownerActorId }) {
  if (new Set(proposal.members.map(m => m.taskId)).size !== proposal.members.length) fail('COORDINATION_TASK_DUPLICATE')
  const ids = new Map(proposal.members.map((m, index) => [m.taskId, `${coordinationId}:member:${index + 1}`]))
  return proposal.members.map(input => {
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
    const instructionId = ids.get(task.taskId), commandId = `coordination-command:${coordinationId}:${instructionId}`
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
    return { instructionId, taskId: task.taskId, progressImpact: input.progressImpact, impactReason: input.impactReason,
      dependencies: input.afterTaskIds.map(id => ids.get(id) ?? fail('COORDINATION_DEPENDENCY_TARGET_MISSING')),
      command: { id: commandId, kind: 'task.coordination.input', args } }
  })
}
