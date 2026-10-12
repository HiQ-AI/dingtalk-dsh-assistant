import { executionDigest, executionError } from './execution-artifacts.js'

/** Internal maintenance provenance; never a synthetic DingTalk message or completion decision. */
export function createTaskMaintenanceConstraint({ store, artifacts, controller, webActorId, taskAccess, recordFact }) {
  return async function apply(request, identity) {
    if (identity?.channel !== 'web' || !webActorId || identity.actorId !== webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const { taskId, requestId, text, expectedRequirementRevision, expectedControlRevision, evidenceRefs } = request
    if (![taskId, requestId, text].every(value => typeof value === 'string' && value.trim())
      || !Array.isArray(evidenceRefs) || !evidenceRefs.length || evidenceRefs.some(ref => typeof ref !== 'string')) throw executionError('TASK_MAINTENANCE_CONSTRAINT_INVALID')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const commandId = 'maintenance-constraint:' + executionDigest([identity.actorId, taskId, requestId])
    const requestDigest = executionDigest(request)
    const prior = await store.query({ kind: 'receipt', commandId: 'owner-event:topic-fact:' + commandId })
    if (prior) {
      const [event] = await store.query({ kind: 'task.owner.events', taskId, afterSequenceId: prior.result.eventSeq - 1, limit: 1 })
      const payload = event && await artifacts.read(event.payloadRef)
      if (payload?.repairSource?.requestDigest !== requestDigest) throw executionError('TASK_MAINTENANCE_CONSTRAINT_CONFLICT')
      return { accepted: true, replayed: true, sourceRef: payload.repairSource.sourceRef, eventSeq: prior.result.eventSeq }
    }
    const maintenance = await store.query({ kind: 'runtime.maintenance' })
    const scope = maintenance.taskRunScope
    if (maintenance.active || maintenance.phase !== 'task-scoped' || scope?.taskId !== taskId) throw executionError('TASK_MAINTENANCE_CONSTRAINT_SCOPE_REQUIRED')
    const plan = await controller.taskPlan(taskId)
    const stage = plan?.stages.find(stage => stage.runId === scope.runId)
    if (!plan || plan.task.controlState !== 'active' || plan.task.requirementRevision !== expectedRequirementRevision
      || plan.task.controlRevision !== expectedControlRevision || scope.requirementRevision !== expectedRequirementRevision
      || !stage || stage.status !== 'succeeded' || !stage.outputRef) throw executionError('TASK_MAINTENANCE_CONSTRAINT_STALE')
    const state = await controller.state(scope.runId)
    if (state.run.status !== 'succeeded' || state.nodes.some(node => node.status !== 'succeeded' || !node.drained)) throw executionError('TASK_MAINTENANCE_CONSTRAINT_NOT_COMPLETE')
    const owner = await store.query({ kind: 'task.owner', taskId })
    if (!owner || !['idle', 'blocked'].includes(owner.status)) throw executionError('TASK_MAINTENANCE_CONSTRAINT_OWNER_BUSY')
    const requirement = await artifacts.read(plan.task.requirementRef)
    const sources = []
    for (const frozen of requirement.sourceInstructions ?? []) {
      const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
      if (!current || current.status === 'superseded' || current.sourceVersion !== frozen.sourceVersion
        || current.actorId !== frozen.actorId || current.conversationId !== origin.run.conversationId || current.body !== frozen.text) throw executionError('TASK_AUTHORIZATION_SOURCE_STALE')
      sources.push({ sourceKey: frozen.sourceKey, sourceVersion: frozen.sourceVersion, actorId: frozen.actorId, text: frozen.text })
    }
    if (!sources.length) throw executionError('TASK_AUTHORIZATION_SOURCE_STALE')
    const known = new Set([plan.task.requirementRef, stage.outputRef, ...state.nodes.flatMap(node => [node.outputRef, ...(node.evidenceRefs ?? [])].filter(Boolean))])
    if (!evidenceRefs.includes(plan.task.requirementRef) || !evidenceRefs.includes(stage.outputRef)
      || evidenceRefs.some(ref => !known.has(ref))) throw executionError('TASK_MAINTENANCE_CONSTRAINT_EVIDENCE_SCOPE')
    const source = await artifacts.put({ kind: 'engineering-maintenance-constraint', version: 1, taskId, requestId,
      actorId: identity.actorId, channel: 'internal-maintenance', text, requestDigest, requirementRef: plan.task.requirementRef,
      runId: scope.runId, stageId: stage.stageId, evidenceRefs, sources }, { taskId })
    await recordFact({ taskId, binding: {}, arguments: { kind: 'constraint', text } }, {
      commandId, binding: { taskId }, run: { conversationId: origin.run.conversationId, sourceKey: source.ref, actorId: identity.actorId },
      repairSource: { kind: 'engineering-maintenance', sourceRef: source.ref, requestDigest, taskId, evidenceRefs, sources },
    })
    const receipt = await store.query({ kind: 'receipt', commandId: 'owner-event:topic-fact:' + commandId })
    return { accepted: true, replayed: false, sourceRef: source.ref, eventSeq: receipt.result.eventSeq }
  }
}
