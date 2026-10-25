import { isAbsolute } from 'node:path'
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
    || !['read-only', 'workspace-write'].includes(resolved.mode)) fail('TASK_ARTIFACT_POLICY_BINDING_MISMATCH')
  // Native permission escalation runs after standing-policy resolution; do not widen this binding.
  ctx.tools.guard(exec => exec.agent?.session?.id === session.id && exec.arguments?.sandbox_permissions === 'danger-full-access'
    ? 'task_artifact_scope_escalation_forbidden' : undefined)
  return bound
}

export async function resolveTaskArtifactScope({ root, task, query }) {
  const candidates = []
  for (const coordination of await query('coordination.list', { groupId: task.groupId })) {
    if (coordination.state === 'cancelled') continue
    const state = await query('coordination.get', { coordinationId: coordination.id })
    const active = state.members.filter(member => !member.observation && member.control !== 'cancelled'
      && !['cancelled', 'superseded', 'template'].includes(member.state))
    if (active.some(member => member.taskId === task.taskId)) {
      const schedules = await query('coordination.schedule.list', { coordinationId: coordination.id })
      if (schedules.some(schedule => schedule.rule?.kind !== 'once')) fail('TASK_ARTIFACT_RECURRING_SCOPE_UNSUPPORTED')
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
