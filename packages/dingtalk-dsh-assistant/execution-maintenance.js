import { executionError } from './execution-artifacts.js'

// 同步调用于控制账事务中；使用既有事件账持久化，不引入第二份运行状态。
export function maintenanceState(db) {
  const row = db.prepare("SELECT payload FROM execution_events WHERE kind='runtime.maintenance.changed' ORDER BY seq DESC LIMIT 1").get()
  const state = row ? JSON.parse(row.payload) : { active: false, revision: 0, maintenanceId: null }
  return { ...state, phase: state.phase ?? (state.active ? 'draining' : 'inactive') }
}

export function maintenanceStatus(db, processIncarnation) {
  const state = maintenanceState(db)
  const count = sql => db.prepare(sql).get().n
  const busy = {
    nodes: count("SELECT count(*) n FROM execution_nodes WHERE current=1 AND (status='running' OR drained=0)"),
    owners: count("SELECT count(*) n FROM task_owners WHERE status='running'"),
    effects: count("SELECT count(*) n FROM execution_effects WHERE state IN ('starting','executing','unknown')"),
    messages: count("SELECT count(*) n FROM message_items WHERE (kind IN ('node','command') AND json_extract(body,'$.status')='running') OR (kind='agent-execution' AND (json_extract(body,'$.status')='running' OR json_extract(body,'$.drained')=0)) OR (kind='notification' AND json_extract(body,'$.status') IN ('sending','acknowledged','unknown')) OR (kind='notification-operation' AND json_extract(body,'$.status') IN ('in_flight','unknown'))")
      + count("SELECT count(*) n FROM message_groups WHERE json_extract(body,'$.coordinator.status') IN ('running','committed')"),
  }
  const drained = Object.values(busy).every(value => value === 0)
  return { ...state, busy, drained, processIncarnation,
    stopPermitted: state.active && state.phase === 'stopping' && drained && !!processIncarnation && state.sealedIncarnation === processIncarnation,
    resumePermitted: state.active && state.phase === 'stopping' && drained && !!processIncarnation && state.sealedIncarnation !== processIncarnation }
}

const dispatchCommands = new Set(['node.claim', 'task.owner.claim', 'effect.begin', 'run.recovery.admit',
  'message.coordinator.claim', 'message.agent.begin', 'message.node.claim', 'message.command.claim', 'message.notification.claim', 'message.notification.operation.claim'])
export function assertMaintenanceDispatch(db, kind) {
  if (dispatchCommands.has(kind) && maintenanceState(db).active) throw executionError('RUNTIME_MAINTENANCE_ACTIVE')
}

export function reduceMaintenanceCommand(db, command, context) {
  if (!['runtime.maintenance.change','runtime.maintenance.seal','runtime.maintenance.resume'].includes(command.kind)) return null
  const a = command.args
  const changing = command.kind === 'runtime.maintenance.change'
  const fields = ['expectedRevision','maintenanceId','actorId','reason', ...(changing ? ['active'] : [])]
  if (!a || Object.keys(a).some(key => !fields.includes(key))
    || changing && typeof a.active !== 'boolean' || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0
    || ['maintenanceId','actorId','reason'].some(key => typeof a[key] !== 'string' || !a[key].trim() || a[key].length > 4096)) throw executionError('RUNTIME_MAINTENANCE_INVALID')
  const current = maintenanceState(db)
  if (!changing) {
    if (!current.active || current.revision !== a.expectedRevision || current.maintenanceId !== a.maintenanceId || current.actorId !== a.actorId) throw executionError('RUNTIME_MAINTENANCE_STALE')
    if (!context.processIncarnation) throw executionError('RUNTIME_MAINTENANCE_INCARNATION_REQUIRED')
    const status = maintenanceStatus(db, context.processIncarnation)
    if (!status.drained) throw executionError('RUNTIME_MAINTENANCE_NOT_DRAINED')
    const sealing = command.kind === 'runtime.maintenance.seal'
    if (sealing ? current.phase !== 'draining' : !status.resumePermitted) throw executionError('RUNTIME_MAINTENANCE_SEALED')
    const next = { ...current, active: sealing, phase: sealing ? 'stopping' : 'inactive', revision: current.revision + 1,
      reason: a.reason, changedAt: context.now, ...(sealing ? { sealedIncarnation: context.processIncarnation } : { resumedIncarnation: context.processIncarnation }) }
    context.emitEvent('runtime.maintenance.changed', next)
    return next
  }
  if (current.phase === 'stopping') throw executionError('RUNTIME_MAINTENANCE_SEALED')
  if (current.revision !== a.expectedRevision || current.active === a.active
    || !a.active && (current.maintenanceId !== a.maintenanceId || current.actorId !== a.actorId)) throw executionError('RUNTIME_MAINTENANCE_STALE')
  const next = { active: a.active, phase: a.active ? 'draining' : 'inactive', revision: current.revision + 1, maintenanceId: a.maintenanceId,
    actorId: a.actorId, reason: a.reason, changedAt: context.now }
  context.emitEvent('runtime.maintenance.changed', next)
  return next
}
