import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { checkedTaskDirectory, taskFilePath } from './session-workspaces.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)

/** A coordination owns one formal outputs container, not a synthetic business Task. */
export async function coordinationArtifactScope(root, { coordinationId, memberTaskIds }) {
  if (!isAbsolute(root ?? '') || !identity(coordinationId) || !Array.isArray(memberTaskIds) || !memberTaskIds.length
    || memberTaskIds.some(id => !identity(id)) || new Set(memberTaskIds).size !== memberTaskIds.length) fail('TASK_ARTIFACT_SCOPE_INVALID')
  const artifactRoot = taskFilePath(root, coordinationId, 'outputs')
  await checkedTaskDirectory(artifactRoot, true)
  return Object.freeze({ version: 1, ownerId: coordinationId, coordinationId, artifactRoot, memberTaskIds: Object.freeze([...memberTaskIds]) })
}

/** A cancelled arrangement cannot silently discard an immutable native session binding. */
export function assertTaskArtifactScopePresent(ctx, session, scope) {
  const policy = ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy
  if (typeof policy?.bindArtifactRoot !== 'function') return
  const projections = ctx.get?.('sessionProjections') ?? ctx.sessionProjections
  const old = projections?.stateOf(session, 'sandboxArtifactRoot')
  if (!scope && old) fail('TASK_ARTIFACT_PERSISTED_SCOPE_REQUIRES_REVIEW')
}

/** Bind the native durable per-session policy API; never replace shared service methods. */
export async function bindTaskArtifactScope(ctx, { root, scope, taskId, session }) {
  if (!scope || scope.version !== 1 || !identity(taskId) || !scope.memberTaskIds?.includes(taskId)
    || !identity(scope.coordinationId) || scope.ownerId !== scope.coordinationId
    || scope.artifactRoot !== taskFilePath(root, scope.coordinationId, 'outputs')
    || !session || !identity(session.id)) fail('TASK_ARTIFACT_BINDING_INVALID')
  await checkedTaskDirectory(scope.artifactRoot)
  const policy = ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy
  if (typeof policy?.bindArtifactRoot !== 'function') fail('TASK_ARTIFACT_POLICY_API_REQUIRED')
  const bound = policy.bindArtifactRoot(session, { ownerId: scope.ownerId, artifactRoot: scope.artifactRoot })
  const resolved = policy.resolve({ session })
  if (bound.ownerId !== scope.ownerId || bound.artifactRoot !== scope.artifactRoot
    || bound.sessionCwd !== session.header.cwd || resolved.workspaceRoot !== scope.artifactRoot
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(resolved.mode)) fail('TASK_ARTIFACT_POLICY_BINDING_MISMATCH')
  return bound
}

const taskCommand = action => action?.kind === 'task-command' ? action : action?.kind === 'read-query' ? action.onIncomplete : undefined

// Recurrence changes instruction/slot identity, never the coordination's artifact owner.
// Only persisted, frozen existing-Task commands can establish this stable membership.
async function recurringArtifactMembers(coordination, members, active, schedules, query) {
  const unsupported = () => fail('TASK_ARTIFACT_RECURRING_SCOPE_UNSUPPORTED')
  const templates = new Map(), stable = active.filter(member => !member.templateInstructionId && !member.recurringOccurrenceId)
  for (const schedule of schedules.filter(item => item.rule?.kind !== 'once')) {
    if (schedule.coordinationId !== coordination.id || !['daily', 'weekly'].includes(schedule.rule?.kind)) unsupported()
    const definitions = [...(schedule.history ?? []), schedule]
    let taskIds
    for (const definition of definitions) {
      const action = taskCommand(definition.action)
      if (!action) continue
      if (action.kind !== 'task-command' || !Array.isArray(action.instructionIds) || !action.instructionIds.length
        || new Set(action.instructionIds).size !== action.instructionIds.length
        || action.frozenInstructions?.length !== action.instructionIds.length) unsupported()
      const selected = action.instructionIds.map(id => {
        const template = members.find(member => member.id === id)
        const frozen = action.frozenInstructions.find(item => item.instructionId === id)
        if (!template || !frozen || template.state !== 'template' || template.observation || template.createCommand
          || template.coordinationId !== coordination.id || template.recurringTemplateScheduleId !== schedule.id
          || template.templateInstructionId || template.recurringOccurrenceId
          || template.command?.kind !== 'task.coordination.input'
          || !['supplement', 'continue', 'reopen', 'cancel'].includes(template.command.args?.action)
          || template.command.args.taskId !== template.taskId || frozen.taskId !== template.taskId
          || template.command.id !== `coordination-command:${coordination.id}:${template.id}`
          || template.commandDigest !== frozen.commandDigest || !isDeepStrictEqual(template.command, frozen.command)) unsupported()
        templates.set(template.id, { template, schedule, definitions })
        return template
      })
      const nextIds = selected.map(member => member.taskId).sort()
      if (new Set(nextIds).size !== nextIds.length || taskIds && !isDeepStrictEqual(taskIds, nextIds)) unsupported()
      taskIds = nextIds
    }
  }
  if (stable.some(member => member.recurringTemplateScheduleId)) unsupported()
  for (const { template } of templates.values()) {
    const target = await query('task.get', { taskId: template.taskId })
    if (!target || target.groupId !== coordination.groupId) unsupported()
    // Retain cancelled/historical templates as part of the immutable logical team.
    if (!stable.some(member => member.id === template.id)) stable.push(template)
  }
  for (const member of active.filter(item => item.templateInstructionId || item.recurringOccurrenceId)) {
    const entry = templates.get(member.templateInstructionId)
    if (!entry || !member.recurringOccurrenceId || member.createCommand
      || member.coordinationId !== coordination.id || member.taskId !== entry.template.taskId) unsupported()
    const occurrence = await query('coordination.occurrence.get', { occurrenceId: member.recurringOccurrenceId })
    const accepted = entry.definitions.find(item => item.revision === occurrence?.acceptedScheduleRevision)
    const original = taskCommand(occurrence?.templateAction), materialized = taskCommand(occurrence?.action)
    const frozen = materialized?.frozenInstructions?.find(item => item.instructionId === member.id)
    if (!occurrence || occurrence.coordinationId !== coordination.id || occurrence.scheduleId !== entry.schedule.id
      || !accepted || !isDeepStrictEqual(original, taskCommand(accepted.action))
      || member.id !== `${entry.template.id}:slot:${occurrence.slotId}`
      || !original?.instructionIds?.includes(entry.template.id) || !materialized?.instructionIds?.includes(member.id)
      || frozen?.taskId !== member.taskId || frozen.commandDigest !== member.commandDigest
      || !isDeepStrictEqual(frozen.command, member.command)
      || member.command?.kind !== entry.template.command.kind || member.command.args?.action !== entry.template.command.args.action
      || !isDeepStrictEqual(member.authorizationSourceRefs, entry.template.command.args.sourceRefs ?? [])) unsupported()
  }
  return stable
}

export async function resolveTaskArtifactScope({ root, task, query }) {
  const candidates = []
  for (const coordination of await query('coordination.list', { groupId: task.groupId })) {
    if (coordination.state === 'cancelled') continue
    const state = await query('coordination.get', { coordinationId: coordination.id })
    let active = state.members.filter(member => !member.observation && member.control !== 'cancelled'
      && !['cancelled', 'superseded', 'template'].includes(member.state))
    if (active.some(member => member.taskId === task.taskId)) {
      const schedules = await query('coordination.schedule.list', { coordinationId: coordination.id })
      if (schedules.some(schedule => schedule.rule?.kind !== 'once'))
        active = await recurringArtifactMembers(coordination, state.members, active, schedules, query)
      else if (active.some(member => member.templateInstructionId || member.recurringOccurrenceId)) fail('TASK_ARTIFACT_RECURRING_SCOPE_UNSUPPORTED')
      candidates.push({ coordination, active })
    }
  }
  if (!candidates.length) return null
  if (candidates.length !== 1) fail('TASK_ARTIFACT_COORDINATION_AMBIGUOUS')
  const { coordination, active } = candidates[0]
  if (new Set(active.map(member => member.taskId)).size !== active.length) fail('TASK_ARTIFACT_COORDINATION_AMBIGUOUS')
  const scope = await coordinationArtifactScope(root, { coordinationId: coordination.id, memberTaskIds: active.map(member => member.taskId) })
  const correction = coordination.artifactScopeCorrection
  if (!correction) return scope
  if (typeof correction.sourceId !== 'string' || correction.coordinationId !== coordination.id
    || correction.artifactRoot !== scope.artifactRoot || correction.revision > coordination.revision) fail('TASK_ARTIFACT_CORRECTION_INVALID')
  const source = await query('source.get', { sourceId: correction.sourceId })
  const tasks = await Promise.all(active.map(member => query('task.get', { taskId: member.taskId })))
  const owners = new Set(tasks.map(item => item?.ownerActorId).filter(Boolean))
  const recorded = source?.requestIdentity?.artifactScopeCorrection
  if (!source || source.channel !== 'web' || !source.actorId || tasks.some(item => !item?.ownerActorId)
    || owners.size !== 1 || !owners.has(source.actorId) || correction.actorId !== source.actorId
    || recorded?.coordinationId !== coordination.id || recorded.artifactRoot !== scope.artifactRoot
    || recorded.actorId !== source.actorId || recorded.reason !== correction.reason || recorded.revision !== correction.revision) fail('TASK_ARTIFACT_CORRECTION_SOURCE_INVALID')
  return Object.freeze({ ...scope, authorizationSource: Object.freeze({ sourceId: source.sourceId,
    actorId: source.actorId, recordedAt: correction.recordedAt, reason: correction.reason }) })
}
