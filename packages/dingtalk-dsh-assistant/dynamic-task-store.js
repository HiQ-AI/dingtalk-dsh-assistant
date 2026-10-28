import {observerWorkMetadata} from './observer-work-index.js'
import { installObserverPagination, observerPage, observerGroupQuery } from './observer-pagination.js'
import { createTaskLedgerDetails } from './task-ledger-details.js'
import { executionSessionTitle } from './session-workspaces.js'
import { checkTaskStoreIntegrity } from './task-store-integrity.js'
import { createStartupMetrics } from './startup-metrics.js'
import { operationBlocksRecovery, hasRestartIsolation, isolationBinding, validIsolationReceipt } from './native-restart-isolation.js'
import { quotedSendRejectionProof } from './group-message.js'
import { taskNotificationRecovery } from './notification-delivery.js'
import { isNativeFilePrecondition } from './dynamic-filesystem-scope.js'
import { taskExecutionContext } from './execution-context.js'
import { stableTaskResourceIdentity } from './task-message-projections.js'
import { createExecutionResourceCatalog } from './execution-resource-catalog.js'
import { DatabaseSync } from 'node:sqlite'
import { coordinationSchema, coordinationLedger } from './coordination-ledger.js'
import { scheduleSchema, coordinationSchedules } from './coordination-schedules.js'
import { assertTaskContextSemantics } from './task-input-contract.js'
import { migrationStateDigest } from './coordination-migration-state.js'
import { coordinationSnapshot, coordinationNotificationState, formatCoordinationSnapshot } from './coordination-summary.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { isAbsolute, dirname, basename } from 'node:path'

// This ledger belongs to the trusted Host. None of its write commands are model tools.
// SQLite transactions commit command receipts and causal wakes together, before dispatch.
const VERSION = 2
const APPLICATION = 0x44535453
const livePaths = new Set()
const terminalOperations = new Set(['succeeded', 'failed', 'cancelled'])
const terminalExecutions = new Set(['succeeded', 'failed', 'cancelled', 'stale'])
const currentFeedback = (execution, item) => item.requirementRevision === execution.requirementRevision
  && item.controlRevision === execution.controlRevision && (!item.sourceExecutionId || item.inputVersion === execution.inputVersion)
/** 只让问题创建后接纳的新群来源进入一次只读复核；执行结果和普通定时唤醒不能解除等待。 */
export function pendingTaskHumanReview(task, wakes) {
  const request = task?.humanRequests?.findLast(item => item.status === 'waiting-reply')
  if (request?.audience !== 'requester' || request.requirementRevision !== task.requirementRevision
    || request.controlRevision !== task.controlRevision) return null
  const replied = new Set((request.followupReplies ?? []).map(item => item.sourceId))
  const pending = wakes.filter(item => item.state !== 'acked' && item.kind === 'task.supplement'
    && item.payload?.humanRequestId === request.requestId && item.payload.sourceIds?.some(id => !replied.has(id)))
  if (!pending.length) return null
  const failed = request.reviewFailures?.at(-1)
  if (failed && pending.every(item => failed.wakeIds.includes(item.id))) return null
  return { requestId: request.requestId, sourceIds: [...new Set(pending.flatMap(item => item.payload.sourceIds).filter(id => !replied.has(id)))],
    wakeIds: pending.map(item => item.id) }
}
const fail = (code, detail = code) => { throw Object.assign(new Error(detail), { code }) }
const text = (value, name) => typeof value === 'string' && value.trim() && value.length <= 1000000 ? value : fail('DYNAMIC_ARGUMENT_INVALID', name)
const record = value => value && Object.getPrototypeOf(value) === Object.prototype ? value : fail('DYNAMIC_ARGUMENT_INVALID')
const array = value => Array.isArray(value) ? value : fail('DYNAMIC_ARGUMENT_INVALID')
const integer = (value, name) => Number.isSafeInteger(value) && value >= 1 ? value : fail('DYNAMIC_ARGUMENT_INVALID', name)
const canonical = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  record(value)
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const changed = result => ({ result, dispatchEligible: false })
// Host-owned active intervals only. Never reconstruct legacy/restarted intervals.
function stopExecutionTiming(execution, stamp) {
  const segment = execution.timeline?.segments.at(-1)
  if (segment?.state === 'running') {
    if (Date.parse(stamp) >= Date.parse(segment.startedAt)) { segment.endedAt = stamp; segment.state = 'closed' }
    else { segment.state = 'unknown'; execution.timeline.complete = false }
  }
  const timing = execution.runTiming
  if (!timing?.startedAt) return
  const delta = Date.parse(stamp) - Date.parse(timing.startedAt)
  if (!Number.isFinite(delta) || delta < 0) timing.recorded = false
  else timing.elapsedMs += delta
  timing.startedAt = null
}
// Only trusted envelope fields reach this parser. Do not infer dates from message text,
// or let Date.parse interpret a missing timezone / a numeric string as a calendar date.
export function ingressTimestamp(value, allowMilliseconds = true) {
  let milliseconds
  if (allowMilliseconds && (typeof value === 'number' || typeof value === 'string' && /^-?\d+$/.test(value))) {
    milliseconds = Number(value)
    if (!Number.isSafeInteger(milliseconds)) return null
  } else {
    if (typeof value !== 'string') return null
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    if (!match) return null
    const [, year, month, day, hour, minute, second] = match.map(Number)
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null
    milliseconds = Date.parse(value)
  }
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8640000000000000) return null
  return new Date(milliseconds).toISOString()
}
function durableMarker(path, value, initial = false) {
  const target = initial ? path : `${path}.${randomUUID()}.pending`
  const fd = openSync(target, 'wx', 0o600)
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  if (!initial) renameSync(target, path)
  if (process.platform !== 'win32') { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
}


/** New-instance initialization is explicit. An ingress epoch can only be bound to a new ledger.
 * legacyDbPath is an offline, read-only inspection API, not a production compatibility path. */
export async function openDynamicTaskStore({ dbPath, instanceId, initialize = false, migrate = false, migrationExpectedDigest, paginationMigrate = false, legacyDbPath, ingressEpoch, webActorId, resourceCatalog: configuredResourceCatalog, startupObserver, detailRoot } = {}) {
  const startup = createStartupMetrics(startupObserver)
  if (migrationExpectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(migrationExpectedDigest)) fail('DYNAMIC_ARGUMENT_INVALID', 'migrationExpectedDigest')
  if (!isAbsolute(dbPath ?? '') || !text(instanceId, 'instanceId') || typeof initialize !== 'boolean'
    || legacyDbPath !== undefined && !isAbsolute(legacyDbPath)) fail('DYNAMIC_STORE_OPTIONS_INVALID')
  const configuredIngressEpoch = ingressEpoch === undefined ? null : ingressTimestamp(ingressEpoch, false)
  if (ingressEpoch !== undefined && !configuredIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_INVALID', 'ingressEpoch must be an ISO timestamp with a timezone.')
  let boundIngressEpoch = null
  let resourceCatalog = createExecutionResourceCatalog(configuredResourceCatalog)
  const existed = existsSync(dbPath), markerPath = `${dbPath}.initialized`
  let marker
  if (existsSync(markerPath)) {
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { fail('DYNAMIC_INITIALIZATION_MARKER_INVALID') }
    if (!marker || marker.version !== 1 || marker.instanceId !== instanceId || !marker.initToken || !['initializing','initialized'].includes(marker.phase)
      || marker.ingressEpoch != null && ingressTimestamp(marker.ingressEpoch, false) !== marker.ingressEpoch) fail('DYNAMIC_INITIALIZATION_MARKER_INVALID')
    if (!existed) fail('DYNAMIC_STORE_LOST', 'The initialized database is missing; restore or explicitly reconcile it instead of creating an empty ledger.')
  }
  if (!existed && !initialize) fail('DYNAMIC_STORE_MISSING')
  const pathKey = existed ? realpathSync(dbPath) : dbPath
  if (livePaths.has(pathKey)) fail('DYNAMIC_STORE_ALREADY_OPEN')
  livePaths.add(pathKey)
  let db, closed = false, healthy = true
  const incarnation = `${process.pid}:${randomUUID()}`
  const now = () => new Date().toISOString()
  const details = createTaskLedgerDetails(detailRoot ?? (basename(dirname(dbPath)) === '.dsh' ? dirname(dirname(dbPath)) : dirname(dbPath)))
  let detailReadCache, detailReadCacheBytes = 0
  const decode = (body, table, id) => {
    const key = `${table}:${id ?? ''}:${body}`
    if (detailReadCache?.has(key)) return JSON.parse(detailReadCache.get(key))
    const value = details.decode(JSON.parse(body), { table, ...(id === undefined ? {} : { id }) })
    if (detailReadCache && detailReadCache.size < 256) {
      const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded) + Buffer.byteLength(key)
      if (detailReadCacheBytes + bytes <= 8 * 1024 * 1024) { detailReadCache.set(key, encoded); detailReadCacheBytes += bytes }
    }
    return value
  }
  const encode = (table, value, hint) => {
    const compact = details.encode(table, value, hint)
    if (compact._hostDetail) db.exec('PRAGMA user_version=3') // Older binaries must reject externalized rows.
    return canonical(compact)
  }
  const receiptHint = args => {
    if (args.binding?.taskId || args.taskId) return { taskId: args.binding?.taskId ?? args.taskId }
    if (args.coordinationId) return { coordinationId: args.coordinationId }
    if (args.notificationId) { const n = get('dynamic_notifications', args.notificationId, true); return { taskId: n?.taskId, coordinationId: n?.payload?.fact?.coordinationId } }
    if (args.operationId) return { taskId: get('dynamic_operations', args.operationId, true)?.taskId }
    if (args.executionId) return { taskId: get('dynamic_executions', args.executionId, true)?.taskId }
    if (args.instructionId) { const m = get('dynamic_coordination_members', args.instructionId, true); return { coordinationId: m?.coordinationId } }
    return {}
  }
  const all = (table, where = '', args = []) => db.prepare(`SELECT body FROM ${table} ${where}`).all(...args).map(row => decode(row.body, table))
  const get = (table, id, optional = false) => {
    const row = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(text(id, 'id'))
    if (!row && !optional) fail('DYNAMIC_NOT_FOUND', `${table}:${id}`)
    return row ? decode(row.body, table, id) : null
  }
  const put = (table, value) => {
    const prior = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(value.id)
    if (prior && canonical(decode(prior.body, table, value.id)) === canonical(value)) return
    db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id, encode(table, value))
  }
  const saveTask = task => { task.updatedAt = now(); put('dynamic_tasks', task); return task }
  const execs = taskId => all('dynamic_executions', 'WHERE json_extract(body,\'$.taskId\')=? ORDER BY rowid', [taskId])
  const ops = taskId => all('dynamic_operations', taskId ? 'WHERE json_extract(body,\'$.taskId\')=? ORDER BY rowid' : 'ORDER BY rowid', taskId ? [taskId] : [])
  const wakes = taskId => all('dynamic_wakes', taskId ? 'WHERE json_extract(body,\'$.taskId\')=? ORDER BY rowid' : 'ORDER BY rowid', taskId ? [taskId] : [])
  const legacy = () => all('dynamic_legacy_blockers').filter(item => !item.resolved)
  const wake = (taskId, kind, payload, key) => {
    const id = key ?? randomUUID()
    if (get('dynamic_wakes', id, true)) return id
    put('dynamic_wakes', { id, wakeId: id, taskId, kind, payload: clone(payload), state: 'pending', leaseEpoch: null, createdAt: now() })
    return id
  }
  const bindingOf = task => ({ kind: 'task-session', taskId: task.taskId, sessionId: task.sessionId,
    contextRevision: task.claimContextRevision ?? task.contextRevision ?? 0,
    requirementRevision: task.claimRequirementRevision ?? task.requirementRevision, controlRevision: task.claimControlRevision ?? task.controlRevision,
    leaseEpoch: task.leaseEpoch, sessionBound: task.sessionBound })
  const executionBinding = execution => ({ kind: 'task-execution', taskId: execution.taskId, executionId: execution.executionId,
    requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision, inputDigest: execution.inputDigest,
    sessionId: execution.sessionId, sessionBound: execution.sessionBound, leaseEpoch: execution.leaseEpoch, inputVersion: execution.inputVersion,
    ...(execution.claudeSessionMode ? { claudeSessionMode: execution.claudeSessionMode } : {}),
    // Attribution is Host-owned ledger evidence, not a native session identity extension.
    inputHistory: execution.inputHistory.map(({ inputVersion, inputDigest, requirementRevision, controlRevision }) =>
      ({ inputVersion, inputDigest, requirementRevision, controlRevision })) })
  const matchesExecutionBinding = (execution, binding) => binding?.kind === 'task-execution' && !!execution
    && ['taskId', 'executionId', 'sessionId', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'inputDigest', 'inputVersion', 'claudeSessionMode']
      .every(key => binding[key] === execution[key])
  const currentTask = (binding, { active = true, current = true, allowHumanReview = false } = {}) => {
    record(binding)
    const task = get('dynamic_tasks', binding.taskId)
    if (binding.kind !== 'task-session' || binding.sessionId !== task.sessionId || binding.leaseEpoch !== task.leaseEpoch || task.drained) fail('DYNAMIC_TASK_LEASE_STALE')
    if (current && task.recovering) fail('DYNAMIC_TASK_LEASE_STALE')
    if (current && (binding.requirementRevision !== task.requirementRevision || binding.controlRevision !== task.controlRevision
      || (binding.contextRevision ?? 0) !== (task.contextRevision ?? 0))) fail('DYNAMIC_TASK_REVISION_STALE')
    if (active && (task.archivedAt || task.control !== 'active' || task.status !== 'active')) fail('DYNAMIC_TASK_NOT_ACTIVE')
    if (!allowHumanReview && task.humanReviewLease === binding.leaseEpoch) fail('DYNAMIC_HUMAN_REVIEW_READ_ONLY')
    return task
  }
  const boundExecution = binding => {
    record(binding)
    const execution = get('dynamic_executions', binding.executionId)
    if (!matchesExecutionBinding(execution, binding)) fail('DYNAMIC_EXECUTION_LEASE_STALE')
    return execution
  }
  const executionCurrent = execution => {
    const task = get('dynamic_tasks', execution.taskId)
    return !task.archivedAt && !execution.recovering && task.status === 'active' && task.control === 'active' && execution.requirementRevision === task.requirementRevision
      && execution.controlRevision === task.controlRevision && !execution.cancelRequested
  }
  const blockers = taskId => ({
    executions: executionViews(execs(taskId).filter(item => !item.drained || !terminalExecutions.has(item.status))).map(taskExecutionContext),
    operations: ops(taskId).filter(item => operationBlocksRecovery(item)),
    legacy: legacy(),
  })
  const restartReopenEligible = task => {
    if (task.status !== 'cancelled' || task.control !== 'cancelled' || !task.drained || task.archivedAt) return false
    const executions = execs(task.taskId)
    const unresolved = ops(task.taskId).filter(operationBlocksRecovery)
    const interrupted = operation => operation.state === 'unknown' && operation.recoveryReason === 'host_restart'
              && operation.result == null && ['running','stopping'].includes(operation.job?.status) && ['pwsh','bash'].includes(operation.definition?.toolName)
              && executions.some(execution => execution.executionId === operation.executionId && execution.sessionBound && execution.cancelRequested
                && operation.job.owner === execution.sessionId && operation.dispatchBinding?.sessionId === execution.sessionId)
    const terminalIdentityFailure = operation => operation.state === 'unknown'
      && operation.result?.isError === true && operation.result.errorCode === 'execution_background_identity_missing'
      && ['pwsh','bash'].includes(operation.definition?.toolName) && operation.result.toolName === operation.definition.toolName
      && typeof operation.result.callId === 'string' && !!operation.result.callId
      && typeof operation.result.resultDigest === 'string' && !!operation.result.resultDigest
      && executions.some(execution => execution.executionId === operation.executionId && execution.sessionBound
        && execution.drained && terminalExecutions.has(execution.status)
        && operation.dispatchBinding?.taskId === task.taskId && operation.dispatchBinding.executionId === execution.executionId
        && operation.dispatchBinding.sessionId === execution.sessionId)
    const terminalJobObservation = operation => operation.state === 'unknown'
      && ['pwsh','bash'].includes(operation.definition?.toolName)
      && ['completed','failed','killed'].includes(operation.job?.status) && Number.isFinite(operation.job.finishedAt)
      && operation.result?.jobReceipt?.jobId === operation.job.jobId
      && executions.some(execution => execution.executionId === operation.executionId && execution.sessionBound
        && execution.drained && terminalExecutions.has(execution.status) && operation.job.owner === execution.sessionId
        && operation.dispatchBinding?.taskId === task.taskId && operation.dispatchBinding.executionId === execution.executionId
        && operation.dispatchBinding.sessionId === execution.sessionId)
    // Explicit reopen never resumes an old execution. Outstanding observations
    // keep the existing bound-readback-only gate until the operator audits them.
    return unresolved.every(operation => interrupted(operation) || terminalIdentityFailure(operation) || terminalJobObservation(operation))
      && executions.every(execution => execution.drained && terminalExecutions.has(execution.status)
        || execution.cancelRequested && execution.recovering
          && unresolved.some(operation => operation.executionId === execution.executionId && interrupted(operation)))
  }
  const restartRecoveryPending = task => (task.restartRecoveryOperations ?? []).filter(id => { const operation = get('dynamic_operations', id, true); return operation && operationBlocksRecovery(operation) })
  const assertRestartRecoveryDispatch = (task, a) => {
    const pending = restartRecoveryPending(task)
    if (pending.length && !(a.definition?.recoveryReadOnly === true && a.definition.executionBackend !== 'claude-code' && pending.includes(a.input?.readbackOperationId))) fail('DYNAMIC_RESTART_RECOVERY_READ_ONLY')
  }
  const assertNoLegacy = taskId => { if (legacy().length) fail('DYNAMIC_LEGACY_EFFECT_UNRESOLVED') }
  const assertClear = taskId => { const value = blockers(taskId); if (Object.values(value).some(items => items.length)) fail('DYNAMIC_TASK_NOT_QUIESCENT', canonical(value)) }
  const assertScope = binding => {
    if (binding?.kind === 'task-session') return currentTask(binding)
    const execution = boundExecution(binding)
    if (execution.drained || execution.status !== 'running' || !executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
    return get('dynamic_tasks', execution.taskId)
  }
  const release = holder => db.prepare('DELETE FROM dynamic_resource_locks WHERE holder=?').run(holder)
  const resourceKeys = value => resourceCatalog.keys(value)
  // 升级前请求摘要不含phase。按原字段和原键验证其既有收据，绝不补写历史摘要或重新执行。
  const resourceRequestMatches = (storedDigest, payload, previous) => {
    if (storedDigest === digest(payload)) return true
    if (previous.resourcePhase !== undefined || payload.resourcePhase !== resourceCatalog.executionPhase(previous)
      || digest(payload.resourceKeys) !== digest(resourceKeys(previous.resourceKeys))) return false
    const { resourcePhase: _phase, ...original } = payload
    return storedDigest === digest({ ...original, resourceKeys: previous.resourceKeys ?? [] })
  }
  const executionHolder = execution => `execution:${execution.executionId}`
  const assertOperationResources = (execution, keys) => {
    const declared = resourceKeys(execution?.resourceKeys)
    if (execution) resourceCatalog.phase(resourceCatalog.executionPhase(execution), keys)
    if (keys.some(key => !declared.includes(key) && (declared.length || resourceCatalog.publication(key)))) fail('DYNAMIC_RESOURCE_SCOPE_EXPANSION')
  }
  const heldKeys = holder => resourceKeys(db.prepare('SELECT resource_key FROM dynamic_resource_locks WHERE holder=? ORDER BY resource_key').all(holder).map(row => row.resource_key))
  const resourceOwners = () => {
    const owners = new Map()
    for (const { resource_key, holder } of db.prepare('SELECT resource_key,holder FROM dynamic_resource_locks').all()) {
      const [key] = resourceKeys([resource_key])
      if (!owners.has(key)) owners.set(key, new Set())
      owners.get(key).add(holder)
    }
    return owners
  }
  // 会话终态不证明外部效果排空；后台作业和 unknown 必须沿原操作对账。
  const releaseExecution = executionId => {
    if (!executionId) return
    const execution = get('dynamic_executions', executionId, true)
    if (!execution?.resourceLease || !execution.drained || ops(execution.taskId).some(operation => operation.executionId === executionId && operationBlocksRecovery(operation))) return
    release(executionHolder(execution))
    execution.resourceLease = null
    put('dynamic_executions', execution)
  }
  const releaseOperation = operation => { release(operation.operationId); releaseExecution(operation.executionId) }
  // 每次读取一份实时锁快照，在内存投影全部执行；不跨请求缓存，也不逐执行/资源查库。
  const executionViews = executions => {
    const owners = resourceOwners()
    return executions.map(execution => {
      if (!execution) return execution
      const keys = resourceKeys(execution.resourceKeys), holder = executionHolder(execution)
      const held = keys.filter(key => owners.get(key)?.has(holder)).length
      const blocking = keys.flatMap(resourceKey => [...(owners.get(resourceKey) ?? [])]
        .filter(owner => owner !== holder).map(owner => ({ resourceKey, holder: owner })))
      const state = !keys.length ? 'none' : held === keys.length && !blocking.length ? 'held'
        : blocking.length && (held || !terminalExecutions.has(execution.status)) ? 'waiting'
          : terminalExecutions.has(execution.status) ? 'released' : 'available'
      return { ...execution, resourcePhase: resourceCatalog.executionPhase(execution), resources: { state, keys, holder: held ? holder : null, blocking } }
    })
  }
  const lock = (keys, holder) => {
    const owners = resourceOwners()
    for (const resourceKey of resourceKeys(keys)) {
      if ([...(owners.get(resourceKey) ?? [])].some(prior => prior !== holder)) fail('DYNAMIC_RESOURCE_BUSY', resourceKey)
    }
    for (const resourceKey of resourceKeys(keys)) db.prepare('INSERT OR IGNORE INTO dynamic_resource_locks(resource_key,holder) VALUES (?,?)').run(resourceKey, holder)
  }
  const transaction = fn => {
    if (closed || !healthy) fail('DYNAMIC_STORE_CLOSED')
    db.exec('BEGIN IMMEDIATE')
    detailReadCache = new Map(); detailReadCacheBytes = 0
    let committing = false
    try {
      const owner = db.prepare('SELECT value FROM dynamic_meta WHERE key=\'owner\'').get()?.value
      if (owner !== incarnation) fail('DYNAMIC_STORE_FENCED')
      const value = fn(); committing = true; db.exec('COMMIT'); return value
    } catch (error) {
      if (committing) healthy = false
      if (db.isTransaction) db.exec('ROLLBACK')
      if (committing) throw Object.assign(new Error('DYNAMIC_COMMIT_ACK_UNKNOWN'), { code: 'DYNAMIC_COMMIT_ACK_UNKNOWN', cause: error })
      throw error
    } finally { detailReadCache = undefined }
  }
  const importLegacy = () => {
    if (!legacyDbPath) return
    if (!existsSync(legacyDbPath)) fail('DYNAMIC_LEGACY_STORE_MISSING')
    const old = new DatabaseSync(legacyDbPath, { readOnly: true })
    try {
      const has = table => !!old.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)
      if (has('task_events')) for (const event of old.prepare("SELECT * FROM task_events WHERE event_type='native.recorded'").all()) {
        const id = `legacy-native:${digest({ path: realpathSync(legacyDbPath), taskId: event.task_id })}`
        if (get('dynamic_legacy_blockers', id, true)) continue
        put('dynamic_legacy_blockers', { id, kind: 'owner-native-evidence', taskId: event.task_id, state: 'unreviewed', resourceKeys: [], resolved: false, evidenceRef: event.payload_ref, source: realpathSync(legacyDbPath), importedAt: now() })
      }
      if (has('execution_nodes')) for (const node of old.prepare("SELECT * FROM execution_nodes WHERE drained=0").all()) {
        const id = `legacy-node:${digest({ path: realpathSync(legacyDbPath), nodeRunId: node.node_run_id })}`
        if (get('dynamic_legacy_blockers', id, true)) continue
        const taskId = has('execution_runs') ? old.prepare('SELECT task_id FROM execution_runs WHERE run_id=?').get(node.run_id)?.task_id ?? null : null
        put('dynamic_legacy_blockers', { id, kind: 'native-session', nodeRunId: node.node_run_id, sessionId: node.session_id, taskId, state: node.status, resourceKeys: [], resolved: false, source: realpathSync(legacyDbPath), importedAt: now() })
      }
      if (!has('execution_effects')) return
      for (const effect of old.prepare("SELECT * FROM execution_effects WHERE state NOT IN ('succeeded','failed')").all()) {
        const id = `legacy:${digest({ path: realpathSync(legacyDbPath), effectId: effect.effect_id })}`
        if (get('dynamic_legacy_blockers', id, true)) continue
        const taskId = has('execution_runs') ? old.prepare('SELECT task_id FROM execution_runs WHERE run_id=?').get(effect.run_id)?.task_id ?? null : null
        const resourceKeys = JSON.parse(effect.resource_keys_json ?? '[]')
        put('dynamic_legacy_blockers', { id, effectId: effect.effect_id, taskId, state: effect.state, resourceKeys, resolved: false, source: realpathSync(legacyDbPath), importedAt: now() })
        if (['starting','executing','unknown'].includes(effect.state)) lock(resourceKeys, id)
      }
    } finally { old.close() }
  }
  try {
    const fresh = !existed && !marker
    if (fresh) { marker = { version: 1, instanceId, phase: 'initializing', initToken: randomUUID(), ingressEpoch: configuredIngressEpoch }; durableMarker(markerPath, marker, true) }
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    if (version === 0 && !tables.length && initialize && fresh) {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
        PRAGMA application_id=${APPLICATION}; PRAGMA user_version=${VERSION};
        CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        ${['tasks','executions','operations','wakes','notifications','legacy_blockers','sources','groups'].map(name => `CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)));`).join('\n')}
        CREATE TABLE dynamic_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)));
        CREATE TABLE dynamic_resource_locks(resource_key TEXT PRIMARY KEY,holder TEXT NOT NULL);
        ${coordinationSchema}
        ${scheduleSchema}
        CREATE UNIQUE INDEX dynamic_execution_key ON dynamic_executions(json_extract(body,'$.taskId'),json_extract(body,'$.key'));
        CREATE UNIQUE INDEX dynamic_operation_key ON dynamic_operations(json_extract(body,'$.taskId'),json_extract(body,'$.key'));
        CREATE UNIQUE INDEX dynamic_notification_revision ON dynamic_notifications(json_extract(body,'$.taskId'),json_extract(body,'$.requirementRevision')) WHERE json_extract(body,'$.kind')='completion';
        `)
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('instanceId', instanceId)
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('initToken', marker.initToken)
      if (configuredIngressEpoch) db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('ingressEpoch', configuredIngressEpoch)
      db.exec('COMMIT')
    } else if (![1, VERSION, 3].includes(version) || db.prepare('PRAGMA application_id').get().application_id !== APPLICATION) fail('DYNAMIC_SCHEMA_INVALID')
    if (version === 1 && !migrate) fail('DYNAMIC_MIGRATION_REQUIRED', 'Offline v1 to v2 migration requires explicit migrate=true after draining writers.')
    const stagedMigration = db.prepare("SELECT value FROM dynamic_meta WHERE key='detailMigration'").get()?.value
    if (stagedMigration && JSON.parse(stagedMigration).complete !== true) fail('DYNAMIC_DETAIL_MIGRATION_INCOMPLETE')
    const initToken = db.prepare("SELECT value FROM dynamic_meta WHERE key='initToken'").get()?.value
    if (marker && initToken !== marker.initToken) fail('DYNAMIC_INITIALIZATION_MARKER_MISMATCH')
    const requiredTables = ['meta','tasks','executions','operations','wakes','notifications','legacy_blockers','sources','groups','receipts','resource_locks'].map(name => `dynamic_${name}`)
    if (requiredTables.some(table => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) fail('DYNAMIC_SCHEMA_INVALID')
    // Fail closed on an unexpected schema or a different installation's file.
    if (db.prepare('SELECT value FROM dynamic_meta WHERE key=\'instanceId\'').get()?.value !== instanceId) fail('DYNAMIC_INSTANCE_MISMATCH')
    boundIngressEpoch = db.prepare("SELECT value FROM dynamic_meta WHERE key='ingressEpoch'").get()?.value ?? null
    if (boundIngressEpoch !== null && ingressTimestamp(boundIngressEpoch, false) !== boundIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_INVALID', 'The persisted ingress epoch is invalid.')
    // Check before owner recovery, legacy inspection, or any task / operation mutation.
    // An initialize flag must never retrofit an epoch onto an old ledger.
    if (configuredIngressEpoch && !boundIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_UNBOUND', 'This ledger was initialized without an ingress epoch; use a new database path for clean ingress.')
    if (boundIngressEpoch !== configuredIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_MISMATCH', 'The configured ingress epoch must match the epoch bound to this ledger.')
    if ((marker?.ingressEpoch ?? null) !== boundIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_MARKER_MISMATCH', 'The database and its initialization marker must bind the same ingress epoch.')
    await startup.measure('task-store.integrity', () => checkTaskStoreIntegrity(dbPath))
    const recoveryStarted = performance.now()
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
    try {
      const previous = db.prepare('SELECT value FROM dynamic_meta WHERE key=\'owner\'').get()?.value
      if (previous) {
        const pid = Number(previous.split(':')[0])
        let alive = true
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
        if (alive) fail('DYNAMIC_STORE_ALREADY_OPEN')
      }
      if (version === 1) {
        // Identity and ingress bindings have already been validated; an active old
        // writer is rejected above. DDL and capability bump roll back together.
        if (all('dynamic_tasks').some(task => !task.drained) || all('dynamic_groups').some(group => !group.drained) || all('dynamic_executions').some(execution => !execution.drained)
          || ops().some(operation => operationBlocksRecovery(operation))
          || all('dynamic_notifications').some(notification => ['starting','unknown'].includes(notification.state))) fail('DYNAMIC_MIGRATION_NOT_QUIESCENT')
        if (migrationExpectedDigest !== undefined && migrationStateDigest(db) !== migrationExpectedDigest) fail('DYNAMIC_MIGRATION_STATE_CHANGED')
        db.exec(coordinationSchema)
        db.exec(scheduleSchema)
        db.exec(`PRAGMA user_version=${VERSION}`)
      }
      for (const table of ['coordination','coordination_sources','coordination_members','coordination_schedules','coordination_occurrences','coordination_slots','coordination_jobs','task_events','coordination_consumers']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`dynamic_${table}`)) fail('DYNAMIC_SCHEMA_INVALID')
      }
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (\'owner\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(incarnation)
      const savedCatalog = db.prepare("SELECT value FROM dynamic_meta WHERE key='executionResourceCatalog'").get()?.value
      resourceCatalog = createExecutionResourceCatalog(configuredResourceCatalog, savedCatalog ? JSON.parse(savedCatalog) : null)
      if (resourceCatalog.snapshot) db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('executionResourceCatalog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(canonical(resourceCatalog.snapshot))
      // 决策沿原命令收据追加保存；索引只服务按任务分页，不把历史数组塞进每轮任务快照。
      db.exec(`CREATE INDEX IF NOT EXISTS dynamic_receipt_decision_task
        ON dynamic_receipts(json_extract(body,'$.taskDecision.taskId')) WHERE json_type(body,'$.taskDecision')='object'`)
      db.exec(`CREATE INDEX IF NOT EXISTS dynamic_pending_source_sender
        ON dynamic_sources(json_extract(body,'$.groupId'),json_extract(body,'$.actorId'))
        WHERE coalesce(json_extract(body,'$.routed'),0)=0 AND json_type(body,'$.processingCompleted') IS NULL`)
      // Recovery never authorizes a second send. Tool/process state must first be drained or reconciled.
      const startupOperations = all('dynamic_operations', "WHERE coalesce(json_extract(body,'$.state'),'') NOT IN ('succeeded','failed','cancelled')")
      const startupExecutions = db.prepare('SELECT body FROM dynamic_executions').all().map(row => JSON.parse(row.body))
      for (const operation of startupOperations) if (operation.state === 'starting') { operation.state = 'unknown'; operation.recoveryReason = 'host_restart'; put('dynamic_operations', operation) }
      const blockingExecutions = new Set(startupOperations.filter(operationBlocksRecovery).map(operation => JSON.stringify([operation.taskId, operation.executionId])))
      for (const notification of all('dynamic_notifications', "WHERE json_extract(body,'$.state')='starting'")) { notification.state = 'unknown'; put('dynamic_notifications', notification) }
      for (const execution of all('dynamic_executions', "WHERE coalesce(json_extract(body,'$.drained'),0)=0")) {
        execution.recovering = true
        const segment = execution.timeline?.segments.at(-1)
        if (segment?.state === 'running') { segment.state = 'unknown'; execution.timeline.complete = false }
        if (execution.runTiming?.startedAt) { execution.runTiming.recorded = false; execution.runTiming.startedAt = null }
        put('dynamic_executions', execution)
      }
      // Records written before instruction attribution existed remain an explicit
      // existing input; neither restart nor a later arrangement grants coverage.
      for (const execution of all('dynamic_executions', "WHERE coalesce(json_type(body,'$.instructionScope'),'null')='null'")) {
        execution.instructionScope = { kind: 'existing', taskId: execution.taskId, inputVersion: execution.inputVersion,
          requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
          runSequence: get('dynamic_tasks', execution.taskId).runSequence, contextRevision: null, instructionIds: [], boundAt: now() }
        put('dynamic_executions', execution)
      }
      for (const task of all('dynamic_tasks', "WHERE coalesce(json_extract(body,'$.drained'),0)=0")) { task.recovering = true; saveTask(task) }
      for (const group of all('dynamic_groups')) if (!group.drained) { group.recovering = true; put('dynamic_groups', group) }
      importLegacy()
      // 旧版活动执行未取得资源锁，不能在升级恢复时伪造此前已串行的保证。
      for (const execution of startupExecutions) {
        const keys = resourceKeys(execution.resourceKeys), held = heldKeys(executionHolder(execution))
        if (execution.resourceLease) {
          if (digest(held) !== digest(keys)) fail('DYNAMIC_RESOURCE_INVARIANT')
        } else if (held.length || keys.length && (!execution.drained || blockingExecutions.has(JSON.stringify([execution.taskId, execution.executionId])))) {
          fail('DYNAMIC_EXECUTION_RESOURCE_UNGUARDED')
        }
      }
      for (const operation of startupOperations) if (['starting','unknown'].includes(operation.state) && operationBlocksRecovery(operation)) {
        const held = heldKeys(operation.resourceHolder ?? operation.operationId)
        const keys = resourceKeys(operation.resourceKeys)
        if (operation.resourceHolder ? keys.some(key => !held.includes(key)) : digest(held) !== digest(keys)) fail('DYNAMIC_RESOURCE_INVARIANT')
      }
      installObserverPagination(db, { migrate: !existed || paginationMigrate })
      db.exec('COMMIT')
      if (!marker) { marker = { version: 1, instanceId, phase: 'initialized', initToken: initToken ?? randomUUID(), ingressEpoch: boundIngressEpoch };
        if (!initToken) db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('initToken',?)").run(marker.initToken)
        durableMarker(markerPath, marker, true)
      } else if (marker.phase !== 'initialized') { marker.phase = 'initialized'; durableMarker(markerPath, marker) }
      startup.record('task-store.recovery', recoveryStarted, 'ok', { operations: startupOperations.length, executions: startupExecutions.length })
    } catch (error) { startup.record('task-store.recovery', recoveryStarted, 'failed'); if (db.isTransaction) db.exec('ROLLBACK'); throw error }
  } catch (error) {
    try { if (db?.isTransaction) db.exec('ROLLBACK'); db?.prepare("DELETE FROM dynamic_meta WHERE key='owner' AND value=?").run(incarnation) } catch {}
    db?.close(); details.close(); livePaths.delete(pathKey); throw error
  }

  const coordination = coordinationLedger({ get, put, all, fail, text, integer, array, record, clone, digest, now,
    validateOwner: binding => currentTask(binding),
    triggerState: id => schedules.memberTriggerState(id),
    notifyTask: (taskId, payload) => wake(taskId, 'coordination.changed', payload, `coordination-change:${payload.sourceId}:${payload.instructionId}`),
    apply(command) {
      const requestDigest = digest({ kind: command.kind, args: command.args })
      const previous = db.prepare('SELECT digest,body FROM dynamic_receipts WHERE id=?').get(command.id)
      if (previous) {
        if (previous.digest !== requestDigest) fail('DYNAMIC_COMMAND_ID_CONFLICT')
        return decode(previous.body, 'dynamic_receipts', command.id)
      }
      const value = { ...reduce(command.kind, command.args, command.id), replayed: false }
      db.prepare('INSERT INTO dynamic_receipts(id,digest,body) VALUES (?,?,?)').run(command.id, requestDigest, encode('dynamic_receipts', value, { ...receiptHint(command.args), id: command.id }))
      return value
    } })
  const schedules = coordinationSchedules({ get, put, all, fail, text, integer, array, record, clone, digest, now,
    instantiateInstructions: input => coordination.instantiateRecurring(input),
    dispatchInstruction: ({ instructionId }) => {
      const member = get('dynamic_coordination_members', instructionId)
      return coordination.command('coordination.apply', { instructionId, expectedRevision: get('dynamic_coordination', member.coordinationId).revision })
    },
    readCommandReceipt: command => {
      const row = db.prepare('SELECT digest,body FROM dynamic_receipts WHERE id=?').get(command.id)
      if (!row) return null
      if (row.digest !== digest({ kind: command.kind, args: command.args })) fail('DYNAMIC_COMMAND_ID_CONFLICT')
      return decode(row.body, 'dynamic_receipts', command.id)
    } })
  const taskEvents = (after = 0, limit = 100) => {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DYNAMIC_ARGUMENT_INVALID')
    const rows = db.prepare('SELECT sequence,body FROM dynamic_task_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit + 1)
    const events = rows.slice(0, limit).map(row => ({ ...decode(row.body, 'dynamic_task_events'), sequence: row.sequence }))
    return { events, nextCursor: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit }
  }
  const controlNotice = payload => {
    const fact = payload.fact
    if (fact?.noticeKind !== 'control' || !fact.sourceAcceptanceId) return false
    const source = get('dynamic_coordination_sources', fact.sourceAcceptanceId, true)
    return source?.state === 'accepted' && source.coordinationId === fact.coordinationId
      && ['change','resolve'].includes(source.acceptedKind)
      && ['change','schedule-change','occurrence-control'].includes(source.acceptedProposal?.kind)
  }
  function currentCoordinationSnapshot(item) {
    const members = item.memberIds.map(id => coordination.view(get('dynamic_coordination_members', id)))
    const occurrences = schedules.list('occurrences').filter(o => o.coordinationId === item.id)
    const occurrenceIds = new Set(occurrences.map(o => o.id))
    return coordinationSnapshot({ coordination: item, members, tasks: all('dynamic_tasks'),
      schedules: schedules.list('schedules').filter(s => s.coordinationId === item.id), occurrences,
      jobs: schedules.list('jobs').filter(j => occurrenceIds.has(j.occurrenceId)) })
  }
  const hasCoordinationNotificationWork = snapshot => snapshot.members.some(member => !member.observation)
    || snapshot.occurrences.some(occurrence => !occurrence.cancelledAt
      && (['failed','expired','blocked'].includes(occurrence.actionState) || occurrence.deliveryState === 'failed'))
  function reduce(kind, a, commandId) {
    const stamp = now()
    if (kind === 'coordination.aggregate') {
      const item = get('dynamic_coordination', a.coordinationId)
      const snapshot = currentCoordinationSnapshot(item)
      const snapshotDigest = digest(snapshot), changedSnapshot = item.aggregateDigest !== snapshotDigest
      const significanceDigest = digest(coordinationNotificationState(snapshot))
      item.lifecycleState = snapshot.state; item.aggregateSnapshot = snapshot; item.aggregateDigest = snapshotDigest
      let notification
      let prior = item.summaryNotificationId ? get('dynamic_notifications', item.summaryNotificationId, true) : null
      // 只有已送达摘要才抑制同一业务状态；发送中/未知由下方 prior 门禁防重，不能冒充送达。
      if (prior?.state === 'delivered' && prior.payload.fact.significanceDigest)
        item.lastNotifiedSignificanceDigest = prior.payload.fact.significanceDigest
      const notificationWork = hasCoordinationNotificationWork(snapshot)
      if (!notificationWork && prior?.state === 'prepared' && !prior.sendPermit) {
        prior.state = 'superseded'; prior.retirement = { reason: 'coordination-observation-only', at: stamp }
        put('dynamic_notifications', prior)
      }
      if (prior?.state === 'prepared' && !prior.sendPermit && prior.payload.fact.snapshotDigest !== snapshotDigest) {
        prior.state = 'superseded'; prior.retirement = { reason: 'coordination-facts-changed', at: stamp }; put('dynamic_notifications', prior)
        item.summaryNotificationId = null; item.lastNotifiedDigest = null; prior = null
      }
      const failedOccurrences = snapshot.occurrences.filter(occurrence => !occurrence.cancelledAt && (['failed','expired','blocked'].includes(occurrence.actionState) || occurrence.deliveryState === 'failed'))
      const shouldNotify = notificationWork && !['needs_clarification','cancelled'].includes(item.state)
        && ['completed','partially_completed','needs_attention'].includes(snapshot.state)
        && item.lastNotifiedSignificanceDigest !== significanceDigest
        && item.lastNotifiedDigest !== snapshotDigest
      if (shouldNotify && !prior?.state?.match(/^(starting|unknown|prepared)$/)) {
        item.summaryRevision = (item.summaryRevision ?? 0) + 1
        const notificationId = `coordination:${item.id}:summary:${item.summaryRevision}`
        notification = reduce('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
          payload: { kind: 'coordination', replyKind: 'substantive', conversationId: item.groupId,
            atOpenDingTalkIds: [...new Set(failedOccurrences.flatMap(occurrence => occurrence.recipientIds))],
            text: formatCoordinationSnapshot(snapshot),
            fact: { coordinationId: item.id, eventId: `summary:${item.summaryRevision}`, snapshotDigest, significanceDigest, summaryRevision: item.summaryRevision } } }, commandId).result.notification
        item.summaryNotificationId = notification.id; item.lastNotifiedDigest = snapshotDigest
      }
      put('dynamic_coordination', item); return changed({ coordination: item, snapshot, changed: changedSnapshot, ...(notification ? { notification } : {}) })
    }
    if (kind === 'coordination.runtime.set') {
      if (!['active','frozen'].includes(a.mode)) fail('DYNAMIC_ARGUMENT_INVALID')
      const runtime = { mode: a.mode, changedAt: stamp, reason: text(a.reason, 'reason') }
      db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('coordinationRuntime',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(canonical(runtime))
      return changed({ runtime })
    }
    const runtimeMode = db.prepare("SELECT value FROM dynamic_meta WHERE key='coordinationRuntime'").get()?.value
    if (runtimeMode && JSON.parse(runtimeMode).mode === 'frozen' && ['coordination.accept','coordination.apply','coordination.source.retry','coordination.source.reconsiderContext','coordination.schedule.scan','coordination.job.claim','coordination.job.command'].includes(kind)) fail('DYNAMIC_COORDINATION_FROZEN')
    if (kind === 'coordination.events.consume') {
      const consumerId = text(a.consumerId, 'consumerId'), previous = get('dynamic_coordination_consumers', consumerId, true)
      if ((previous?.cursor ?? 0) !== a.expectedCursor) fail('DYNAMIC_COORDINATION_CURSOR_STALE')
      const page = taskEvents(a.expectedCursor, a.limit ?? 100), changedTaskIds = new Set(page.events.map(event => event.taskId))
      const reconciledMembers = []
      for (const member of all('dynamic_coordination_members')) {
        if (!changedTaskIds.has(member.taskId) && !member.dependencies.some(id => changedTaskIds.has(get('dynamic_coordination_members', id).taskId))) continue
        const projected = coordination.view(member)
        member.waitingReason = projected.waitingReason; member.lastReconciledSequence = page.nextCursor
        put('dynamic_coordination_members', member); reconciledMembers.push(projected)
      }
      put('dynamic_coordination_consumers', { id: consumerId, cursor: page.nextCursor, updatedAt: stamp })
      return changed({ ...page, cursor: page.nextCursor, reconciledMembers })
    }
    if (kind === 'coordination.notification.freeze') {
      const occurrence = schedules.read('occurrences', a.occurrenceId)
      if (occurrence.cancelledAt || occurrence.actionState !== 'succeeded') fail('DYNAMIC_COORDINATION_JOB_STALE')
      if (occurrence.notificationId) return changed({ notification: get('dynamic_notifications', occurrence.notificationId) })
      occurrence.resultVersion ??= 1
      const notificationId = `coordination:${occurrence.coordinationId}:${occurrence.id}:result:${occurrence.resultVersion}`
      // 提醒沿已接纳来源回复，复用任务的原生引用与提及；已冻结通知在上方直接返回，不改写历史 payload。
      const source = occurrence.action.kind === 'message-reminder'
        ? get('dynamic_coordination_sources', get('dynamic_coordination', occurrence.coordinationId).sourceId, true) : null
      const reply = source?.sourceMessageId && source.actorId && source.groupId === occurrence.target.conversationId
        ? { sourceMessageId: source.sourceMessageId, actorId: source.actorId } : {}
      const notification = reduce('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
        payload: { kind: 'coordination', replyKind: 'substantive', conversationId: occurrence.target.conversationId, atOpenDingTalkIds: occurrence.target.recipientIds,
          ...reply,
          text: occurrence.action.kind === 'message-reminder' ? occurrence.result.text : JSON.stringify(occurrence.result), fact: { coordinationId: occurrence.coordinationId, eventId: `${occurrence.id}:result:${occurrence.resultVersion}`,
            occurrenceId: occurrence.id, instanceControlRevision: occurrence.instanceControlRevision,
            deliveryControlRevision: occurrence.deliveryControlRevision, resultVersion: occurrence.resultVersion, resultDigest: digest(occurrence.result) } } }, commandId)
      occurrence.notificationId = notificationId; put('dynamic_coordination_occurrences', occurrence)
      return notification
    }
    if (kind === 'coordination.notification.refresh') {
      const occurrence = schedules.read('occurrences', a.occurrenceId)
      if (occurrence.action.kind !== 'read-query') fail('DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED')
      const old = get('dynamic_notifications', a.expectedNotificationId)
      if (occurrence.notificationId !== old.id || occurrence.resultVersion !== a.expectedResultVersion
        || occurrence.instanceControlRevision !== a.expectedInstanceControlRevision || occurrence.deliveryControlRevision !== a.expectedDeliveryControlRevision
        || occurrence.cancelledAt || occurrence.actionState !== 'succeeded' || get('dynamic_coordination', occurrence.coordinationId).state === 'cancelled'
        || old.state !== 'prepared' || old.sendPermit || old.ack || old.receipt || old.supersededBy) fail('DYNAMIC_COORDINATION_REFRESH_NOT_ALLOWED')
      if (Date.parse(stamp) - Date.parse(occurrence.result.observedAt) < (occurrence.freshnessWindowMs ?? 300000)) fail('DYNAMIC_COORDINATION_RESULT_FRESH')
      ;(occurrence.resultHistory ??= []).push({ resultVersion: occurrence.resultVersion, notificationId: old.id, result: clone(occurrence.result) })
      occurrence.result = schedules.snapshot(occurrence); occurrence.resultVersion++
      const notificationId = `coordination:${occurrence.coordinationId}:${occurrence.id}:result:${occurrence.resultVersion}`
      old.state = 'superseded'; old.supersededBy = notificationId; old.updatedAt = stamp
      put('dynamic_notifications', old)
      occurrence.notificationId = notificationId; put('dynamic_coordination_occurrences', occurrence)
      const prepared = reduce('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
        payload: { ...clone(old.payload), text: JSON.stringify(occurrence.result), fact: { ...clone(old.payload.fact),
          eventId: `${occurrence.id}:result:${occurrence.resultVersion}`, resultVersion: occurrence.resultVersion,
          resultDigest: digest(occurrence.result) } } }, commandId)
      return prepared
    }
    if (/^coordination\.(schedule\.|job\.|occurrence\.)/.test(kind)) return changed(schedules.command(kind, a))
    if (kind.startsWith('coordination.')) {
      const result = coordination.command(kind, a)
      if (kind === 'coordination.accept' && a.schedule) {
        result.schedule = schedules.command('coordination.schedule.create', { ...record(a.schedule), coordinationId: result.coordination.id }).schedule
      }
      if (kind === 'coordination.change') {
        if (result.coordination.state === 'cancelled') schedules.cancelCoordination(result.coordination.id)
        if (a.change.action === 'schedule') {
          const existing = schedules.read('schedules', a.change.scheduleChange.scheduleId)
          if (existing.coordinationId !== result.coordination.id) fail('DYNAMIC_COORDINATION_SCOPE')
          result.schedule = schedules.command('coordination.schedule.change', a.change.scheduleChange).schedule
        }
        if (a.change.action === 'occurrence') {
          const existing = schedules.read('occurrences', a.change.occurrenceControl.occurrenceId)
          if (existing.coordinationId !== result.coordination.id) fail('DYNAMIC_COORDINATION_SCOPE')
          result.occurrence = schedules.command('coordination.occurrence.control', a.change.occurrenceControl).occurrence
        }
        if (a.change.action === 'resolve' && a.change.schedule) result.schedule = schedules.command('coordination.schedule.create', { ...a.change.schedule, coordinationId: result.coordination.id }).schedule
      }
      if (kind === 'coordination.cancel') schedules.cancelCoordination(a.coordinationId)
      return changed(result)
    }
    if (kind === 'task.coordination.input') {
      const task = get('dynamic_tasks', a.taskId)
      if (task.requirementRevision !== a.expectedRequirementRevision || task.controlRevision !== a.expectedControlRevision) fail('DYNAMIC_TASK_REVISION_STALE')
      assertTaskContextSemantics({ progressImpact: a.progressImpact, ...(a.objective !== undefined ? { objective: a.objective } : {}),
        ...(a.requirements !== undefined ? { acceptanceCriteria: a.requirements } : {}) })
      const origin = record(a.originalSource), admitted = get('dynamic_sources', origin.sourceId)
      if (admitted.groupId !== task.groupId || admitted.actorId !== origin.actorId) fail('DYNAMIC_COORDINATION_SCOPE')
      if (!['supplement','continue','reopen','cancel'].includes(a.action)) fail('DYNAMIC_ARGUMENT_INVALID')
      if (a.action === 'cancel') {
        if (![task.ownerActorId, a.authorizedOwnerActorId].includes(origin.actorId)) fail('DYNAMIC_COORDINATION_CONTROL_FORBIDDEN')
        return reduce('task.control', { ...a, control: 'cancelled', reason: a.text }, commandId)
      }
      if (a.action === 'reopen') {
        if (a.progressImpact !== 'replan') fail('DYNAMIC_COORDINATION_IMPACT_REQUIRED')
        return reduce('task.reopen', a, commandId)
      }
      let expectedControlRevision = a.expectedControlRevision
      if (task.control === 'paused') {
        if (a.action !== 'continue') fail('DYNAMIC_TASK_NOT_ACTIVE')
        reduce('task.control', { taskId: a.taskId, expectedControlRevision, control: 'active' }, `${commandId}:resume`)
        expectedControlRevision++
      }
      return reduce(a.progressImpact === 'preserve' ? 'task.supplement' : 'task.revise',
        { ...a, expectedControlRevision, messageId: commandId }, commandId)
    }
    if (kind === 'task.create') {
      const taskId = text(a.taskId, 'taskId')
      if (get('dynamic_tasks', taskId, true)) fail('DYNAMIC_TASK_EXISTS')
      const task = { id: taskId, taskId, sessionId: `task-session-${randomUUID()}`, groupId: a.groupId ?? null,
        sourceRefs: a.sourceRefs ?? [], topicRefs: a.topicRefs ?? [], appliedOperations: a.operationId ? [a.operationId] : [], runSequence: 1, ownerActorId: a.ownerActorId ?? null, title: a.title ?? a.objective ?? a.request ?? taskId,
        objective: a.objective ?? a.request ?? '', request: a.request ?? a.objective ?? '', requirements: a.requirements ?? [], metadata: a.metadata ?? {},
        requirementRevision: 1, controlRevision: 1, status: 'active', control: 'active', leaseEpoch: 0, sessionBound: false, drained: true,
        humanRequests: [], ...(a.coordinationHold ? { coordinationHold: clone(record(a.coordinationHold)) } : {}), createdAt: stamp, updatedAt: stamp }
      text(task.request, 'request'); array(task.sourceRefs); array(task.requirements)
      saveTask(task); if (!task.coordinationHold) wake(taskId, 'task.created', { sourceRefs: task.sourceRefs }, `wake:${commandId}`)
      return changed({ task })
    }
    if (kind === 'task.coordination.start') {
      const task = get('dynamic_tasks', a.taskId)
      if (task.requirementRevision !== a.expectedRequirementRevision || task.controlRevision !== a.expectedControlRevision
        || task.coordinationHold?.coordinationId !== a.coordinationId || task.coordinationHold?.instructionId !== a.instructionId) fail('DYNAMIC_TASK_REVISION_STALE')
      const admitted = get('dynamic_sources', a.originalSource.sourceId)
      if (admitted.groupId !== task.groupId || admitted.actorId !== task.ownerActorId) fail('DYNAMIC_COORDINATION_SCOPE')
      task.coordinationHold = null; saveTask(task)
      const wakeId = wake(task.taskId, 'task.created', { sourceRefs: task.sourceRefs, instructionId: a.instructionId }, `wake:${commandId}`)
      return changed({ task, wakeId })
    }
    if (kind === 'task.archive') {
      const task = get('dynamic_tasks', a.taskId)
      text(a.actorId, 'actorId')
      if (task.archivedAt) return changed({ task })
      // Archive is a view lifecycle change; never cancel or drain a live session.
      if (task.status !== 'completed' && task.control !== 'cancelled' || !task.drained) fail('DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT')
      if (Object.values(blockers(task.taskId)).some(items => items.length)) fail('DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT')
      task.archivedAt = stamp; task.archivedBy = a.actorId
      saveTask(task)
      return changed({ task })
    }
    if (kind === 'task.dialogue.add') {
      const task = get('dynamic_tasks', a.taskId)
      const id = text(a.requestId, 'requestId'), message = text(a.text, 'text').trim()
      if (!webActorId || a.actorId !== webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
      const prior = task.dialogue?.find(item => item.id === id)
      if (prior) {
        if (prior.text !== message || prior.actorId !== a.actorId) fail('DYNAMIC_COMMAND_ID_CONFLICT')
        return changed({ message: prior })
      }
      if (task.archivedAt || task.status !== 'active' || task.control !== 'active') fail('DYNAMIC_TASK_NOT_ACTIVE')
      if (!message || message.length > 10000 || id.length > 200) fail('DYNAMIC_ARGUMENT_INVALID')
      const entry = { id, text: message, actorId: a.actorId, receivedAt: stamp, reply: null }
      ;(task.dialogue ??= []).push(entry)
      saveTask(task)
      wake(task.taskId, 'task.dialogue', { messageId: id }, `dialogue:${task.taskId}:${id}`)
      return changed({ task, message: entry })
    }
    if (kind === 'task.dialogue.reply') {
      const task = currentTask(a.binding)
      const message = task.dialogue?.find(item => item.id === a.messageId)
      const claimed = wakes(task.taskId).some(item => item.kind === 'task.dialogue' && item.payload.messageId === a.messageId
        && item.state === 'claimed' && item.leaseEpoch === a.binding.leaseEpoch)
      if (!message || !claimed) fail('DYNAMIC_WAKE_CLAIM_STALE')
      const reply = text(a.reply, 'reply').trim()
      if (!reply || reply.length > 20000) fail('DYNAMIC_ARGUMENT_INVALID')
      if (message.reply && message.reply !== reply) fail('DYNAMIC_COMMAND_ID_CONFLICT')
      message.reply = reply; message.repliedAt ??= stamp
      for (const item of wakes(task.taskId)) if (item.kind === 'task.dialogue' && item.payload.messageId === a.messageId
        && item.leaseEpoch === a.binding.leaseEpoch) { item.state = 'acked'; item.ackedAt = stamp; put('dynamic_wakes', item) }
      saveTask(task)
      return changed({ task, message })
    }
    if (kind === 'task.supplement') {
      const task = get('dynamic_tasks', a.taskId)
      const messageId = text(a.messageId, 'messageId'), message = text(a.text, 'text')
      const prior = task.supplements?.find(item => item.id === messageId)
      if (prior) {
        if (prior.text !== message) fail('DYNAMIC_FEEDBACK_ID_CONFLICT')
        return changed({ task })
      }
      if (task.archivedAt || task.status !== 'active' || task.control !== 'active') fail('DYNAMIC_TASK_NOT_ACTIVE')
      if (a.expectedRequirementRevision !== task.requirementRevision || a.expectedControlRevision !== task.controlRevision) fail('DYNAMIC_TASK_REVISION_STALE')
      const request = task.humanRequests?.findLast(item => item.status === 'waiting-reply' && item.audience === 'requester')
      const reviewSources = request ? (a.sourceRefs ?? []).filter(id => !(task.sourceRefs ?? []).includes(id)).map(id => get('dynamic_sources', id))
        .filter(source => source.groupId === task.groupId && source.channel === 'im'
          && Date.parse(source.timestamp) >= Date.parse(request.createdAt) && Date.parse(source.timestamp) <= Date.parse(stamp)) : []
      task.contextRevision = (task.contextRevision ?? 0) + 1
      for (const field of ['request', 'sourceRefs', 'topicRefs']) if (a[field] !== undefined) task[field] = clone(a[field])
      if (a.operationId) task.appliedOperations = [...new Set([...(task.appliedOperations ?? []), a.operationId])]
      ;(task.supplements ??= []).push({ id: messageId, text: message, receivedAt: stamp, contextRevision: task.contextRevision })
      // 待答来源先由统筹核对；不能把未经确认的摘要提前反馈给仍在运行的执行。
      for (const execution of execs(task.taskId)) if (!task.humanRequests?.some(item => item.status === 'waiting-reply') && !terminalExecutions.has(execution.status) && executionCurrent(execution)) {
        execution.feedback ??= []
        execution.feedback.push({ id: messageId, text: message, requirementRevision: task.requirementRevision,
          controlRevision: task.controlRevision, inputVersion: execution.inputVersion, receivedAt: stamp, consumedAt: null })
        put('dynamic_executions', execution)
      }
      saveTask(task); wake(task.taskId, kind, { messageId, contextRevision: task.contextRevision,
        ...(reviewSources.length ? { humanRequestId: request.requestId, sourceIds: reviewSources.map(source => source.sourceId) } : {}) }, `wake:${commandId}`)
      return changed({ task })
    }
    if (kind === 'execution.peerMessage') {
      const source = boundExecution(a.binding), task = assertScope(a.binding)
      const execution = get('dynamic_executions', a.executionId)
      if (execution.taskId !== task.taskId || execution.executionId === source.executionId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID')
      const key = text(a.key, 'key'), message = text(a.message, 'message'), targetInputVersion = integer(a.targetInputVersion, 'targetInputVersion')
      if (key.length > 200 || message.length > 10000) fail('DYNAMIC_ARGUMENT_INVALID')
      const id = `peer:${source.executionId}:${source.inputVersion}:${key}`
      for (const recipient of execs(task.taskId)) {
        const prior = recipient.feedback?.find(item => item.id === id)
        if (!prior) continue
        if (recipient.executionId !== execution.executionId || prior.text !== message || prior.inputVersion !== targetInputVersion
          || prior.sourceExecutionId !== source.executionId || prior.sourceInputVersion !== source.inputVersion) fail('DYNAMIC_FEEDBACK_ID_CONFLICT')
        return changed({ received: true, executionId: execution.executionId, sessionId: execution.sessionId, feedback: prior })
      }
      if (targetInputVersion !== execution.inputVersion) fail('DYNAMIC_EXECUTION_INPUT_STALE')
      if (terminalExecutions.has(execution.status)) return changed({ received: false, executionId: execution.executionId,
        sessionId: execution.sessionId, reason: 'recipient_finished' })
      if (!executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      const feedback = { id, text: message, sourceExecutionId: source.executionId, sourceInputVersion: source.inputVersion,
        sourceLeaseEpoch: source.leaseEpoch, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision,
        inputVersion: execution.inputVersion, receivedAt: stamp, consumedAt: null }
      ;(execution.feedback ??= []).push(feedback)
      put('dynamic_executions', execution)
      return changed({ received: true, executionId: execution.executionId, sessionId: execution.sessionId, feedback })
    }
    if (kind === 'execution.feedback') {
      const task = currentTask(a.binding), execution = get('dynamic_executions', a.executionId)
      if (execution.taskId !== task.taskId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID')
      if (!executionCurrent(execution) || terminalExecutions.has(execution.status)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      const id = text(a.messageId, 'messageId'), message = text(a.text, 'text')
      execution.feedback ??= []
      const prior = execution.feedback.find(item => item.id === id)
      if (prior && prior.text !== message) fail('DYNAMIC_FEEDBACK_ID_CONFLICT')
      if (!prior) execution.feedback.push({ id, text: message, requirementRevision: task.requirementRevision,
        controlRevision: task.controlRevision, inputVersion: execution.inputVersion, receivedAt: stamp, consumedAt: null })
      put('dynamic_executions', execution)
      return changed({ execution, feedback: execution.feedback.find(item => item.id === id) })
    }
    if (kind === 'execution.feedbackConsumed') {
      const execution = boundExecution(a.binding)
      if (!executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      const feedback = execution.feedback?.find(item => item.id === a.messageId)
      if (!feedback || !currentFeedback(execution, feedback)
        || !Number.isSafeInteger(a.sequence) || a.sequence < 0) fail('DYNAMIC_FEEDBACK_PROOF_INVALID')
      feedback.consumedAt ??= stamp; feedback.sequence ??= a.sequence
      if (execution.definition?.executionBackend === 'claude-code') {
        feedback.cliInputAdmittedAt ??= feedback.consumedAt
        feedback.consumptionMeaning = 'claude-cli-input-admission'
      } else {
        feedback.modelStepEnteredAt ??= feedback.consumedAt
        feedback.consumptionMeaning = 'native-model-step-admission'
      }
      put('dynamic_executions', execution)
      return changed({ feedback })
    }
    if (kind === 'task.revise' || kind === 'task.reopen' || kind === 'task.control') {
      const task = get('dynamic_tasks', a.taskId)
      if (task.archivedAt) fail('DYNAMIC_TASK_ARCHIVED_CONFLICT')
      if (kind === 'task.revise' || kind === 'task.reopen') {
        if (a.expectedRequirementRevision !== undefined && a.expectedRequirementRevision !== task.requirementRevision
          || a.expectedControlRevision !== undefined && a.expectedControlRevision !== task.controlRevision) fail('DYNAMIC_TASK_REVISION_STALE')
        if (kind === 'task.reopen') {
          const unresolved = blockers(task.taskId).operations
          if (restartReopenEligible(task)) {
            task.restartRecoveryOperations = unresolved.map(operation => operation.operationId)
          } else if (task.status !== 'completed' || !task.drained || unresolved.length) fail('DYNAMIC_TASK_NOT_QUIESCENT')
          task.status = 'active'; task.control = 'active'; task.controlRevision++; task.runSequence = (task.runSequence ?? 1) + 1; task.completion = null
        } else if (task.status === 'completed' || task.control === 'cancelled') fail('DYNAMIC_TASK_TERMINAL')
        task.requirementRevision++
        for (const field of ['request','objective','title','requirements','sourceRefs','topicRefs']) if (a[field] !== undefined) task[field] = clone(a[field])
        if (a.request !== undefined) text(a.request, 'request')
      } else {
        if (a.expectedControlRevision !== undefined && a.expectedControlRevision !== task.controlRevision) fail('DYNAMIC_TASK_REVISION_STALE')
        if (!['active','paused','cancelled'].includes(a.control)) fail('DYNAMIC_ARGUMENT_INVALID', 'control')
        if (task.status === 'completed' || task.control === 'cancelled' && a.control !== 'cancelled') fail('DYNAMIC_TASK_TERMINAL')
        task.controlRevision++; task.control = a.control
        if (a.control === 'cancelled') { task.status = 'cancelled'; task.cancelledAt ??= stamp }
      }
      if (a.topicRefs !== undefined) task.topicRefs = clone(array(a.topicRefs))
      if (a.operationId) task.appliedOperations = [...new Set([...(task.appliedOperations ?? []), text(a.operationId, 'operationId')])]
      for (const request of task.humanRequests ?? []) if (request.status === 'waiting-reply') { request.status = 'superseded'; request.supersededAt = stamp }
      for (const execution of execs(task.taskId)) if (!terminalExecutions.has(execution.status)) {
        execution.cancelRequested = true
        if (execution.drained) execution.status = 'stale'
        put('dynamic_executions', execution)
      }
      for (const operation of ops(task.taskId)) if (operation.state === 'prepared') {
        operation.state = 'cancelled'; put('dynamic_operations', operation); releaseOperation(operation)
      }
      saveTask(task); wake(task.taskId, kind, { requirementRevision: task.requirementRevision, controlRevision: task.controlRevision }, `wake:${commandId}`)
      return changed({ task })
    }
    if (kind === 'task.claim') {
      const task = get('dynamic_tasks', a.taskId)
      if (task.archivedAt) fail('DYNAMIC_TASK_ARCHIVED_CONFLICT')
      if (!task.drained) fail('DYNAMIC_TASK_BUSY')
      if (task.providerRecovery?.requirementRevision === task.requirementRevision
        && (!task.providerRecovery.nextAttemptAt || Date.parse(stamp) < Date.parse(task.providerRecovery.nextAttemptAt))) fail('DYNAMIC_TASK_PROVIDER_RETRY_NOT_DUE')
      const humanReview = a.humanReview === true ? pendingTaskHumanReview(task, wakes(task.taskId)) : null
      if (a.humanReview === true && !humanReview) fail('DYNAMIC_HUMAN_REVIEW_NOT_PENDING')
      if (task.humanRequests?.some(item => item.status === 'waiting-reply') && !humanReview && a.dialogue !== true) fail('DYNAMIC_HUMAN_RESPONSE_REQUIRED')
      task.leaseEpoch++; task.drained = false; task.recovering = false
      task.humanReviewLease = humanReview ? task.leaseEpoch : null
      task.claimRequirementRevision = task.requirementRevision; task.claimControlRevision = task.controlRevision
      task.claimContextRevision = task.contextRevision ?? 0
      if (task.providerRecovery) {
        // Consume every admission before entering native runtime. A different
        // runtime fault must not reuse an already due provider timer in a hot loop.
        task.providerRecovery = { ...task.providerRecovery, requirementRevision: task.requirementRevision,
          nextAttemptAt: null, suspended: true, admission: { kind: task.providerRecovery.requirementRevision !== task.requirementRevision ? 'new-input' : 'scheduled', leaseEpoch: task.leaseEpoch, at: stamp } }
      }
      let pending = wakes(task.taskId).filter(item => item.state !== 'acked')
      // Dialogue uses the same owner/lease queue, one message per turn. Ordinary
      // execution wakes remain pending so a conversation cannot consume their work.
      if (a.dialogue === true) pending = pending.filter(item => item.kind === 'task.dialogue').slice(0, 1)
      else if (humanReview) pending = pending.filter(item => humanReview.wakeIds.includes(item.id))
      else pending = pending.filter(item => item.kind !== 'task.dialogue')
      if (!pending.length && !a.force) fail('DYNAMIC_TASK_NO_WAKE')
      for (const item of pending) { item.state = 'claimed'; item.leaseEpoch = task.leaseEpoch; put('dynamic_wakes', item) }
      saveTask(task)
      return { result: { task, binding: bindingOf(task), wakeIds: pending.map(item => item.id), wakes: pending,
        ...(humanReview ? { humanReview } : {}) }, dispatchEligible: true }
    }
    if (kind === 'task.sessionBound' || kind === 'task.drained') {
      const task = currentTask(a.binding, { active: false, current: false, allowHumanReview: true })
      if (kind === 'task.sessionBound') task.sessionBound = true
      else { task.drained = true; task.recovering = false }
      saveTask(task); return changed({ task })
    }
    if (kind === 'task.wake' || kind === 'wake.enqueue') {
      const task = get('dynamic_tasks', a.taskId)
      const wakeId = wake(task.taskId, a.kind ?? 'task.wake', a.payload ?? {}, a.key ?? `wake:${commandId}`)
      return changed({ wakeId })
    }
    if (kind === 'wake.claim') return reduce('task.claim', a, commandId)
    if (kind === 'wake.ack') {
      const task = currentTask(a.binding, { active: false, current: false, allowHumanReview: true })
      const ids = array(a.wakeIds), acknowledged = [], remaining = []
      const request = task.humanRequests?.findLast(item => item.status === 'waiting-reply')
      const partialReply = task.humanReviewLease === a.binding.leaseEpoch
        && request?.followupReplies?.some(item => item.leaseEpoch === a.binding.leaseEpoch)
      const replied = new Set((request?.followupReplies ?? []).map(item => item.sourceId))
      for (const id of ids) {
        const item = get('dynamic_wakes', id)
        if (item.taskId !== task.taskId || item.leaseEpoch !== task.leaseEpoch || !['claimed','acked'].includes(item.state)) fail('DYNAMIC_WAKE_CLAIM_STALE')
        // 一次事实答复只处置指定来源；同一唤醒或其他唤醒里的未答追问继续走原队列。
        if (partialReply && item.payload?.humanRequestId === request.requestId && item.payload.sourceIds?.some(sourceId => !replied.has(sourceId))) {
          remaining.push(id); continue
        }
        item.state = 'acked'; item.ackedAt = stamp; put('dynamic_wakes', item)
        acknowledged.push(id)
      }
      return changed({ wakeIds: acknowledged, ...(remaining.length ? { remainingWakeIds: remaining } : {}) })
    }
    if (kind === 'task.wait') {
      const task = currentTask(a.binding, { active: false, allowHumanReview: true })
      if (task.humanReviewLease === a.binding.leaseEpoch && (a.question?.trim() || a.decision?.question?.trim())) fail('DYNAMIC_HUMAN_REVIEW_READ_ONLY')
      let notification = null
      if (a.humanReply) {
        if (task.humanReviewLease !== a.binding.leaseEpoch || a.action !== 'wait' || a.reviewFailureCode !== undefined) fail('DYNAMIC_HUMAN_REVIEW_READ_ONLY')
        const review = pendingTaskHumanReview(task, wakes(task.taskId).filter(item => item.state === 'claimed' && item.leaseEpoch === a.binding.leaseEpoch))
        if (!review || review.requestId !== a.humanReply.requestId || !review.sourceIds.includes(a.humanReply.sourceId)) fail('DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID')
        const request = task.humanRequests.find(item => item.requestId === review.requestId)
        const source = get('dynamic_sources', a.humanReply.sourceId), payload = clone(record(a.humanReply.notification))
        if (task.status !== 'active' || task.control !== 'active' || source.groupId !== task.groupId || source.channel !== 'im'
          || !task.sourceRefs.includes(source.sourceId) || !(Date.parse(source.timestamp) >= Date.parse(request.createdAt) && Date.parse(source.timestamp) <= Date.parse(stamp))) fail('DYNAMIC_HUMAN_RESPONSE_FORBIDDEN')
        if (payload.conversationId !== source.groupId || payload.sourceMessageId !== source.messageId || payload.actorId !== source.actorId
          || payload.sourceId !== source.sourceId || payload.sourceVersion !== source.version || payload.replyToMessageId !== source.messageId
          || payload.replyToSenderOpenDingTalkId !== source.actorId || digest(payload.atOpenDingTalkIds ?? []) !== digest([source.actorId])) fail('DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID')
        const evidence = array(a.evidence).map(item => text(item, 'evidence'))
        if (!evidence.length) fail('DYNAMIC_ARGUMENT_INVALID', 'evidence')
        const id = `human-followup:${task.taskId}:${request.requestId}:${source.sourceId}`
        // 答复与待答状态在同一事务落账；发送前崩溃也不重跑同一追问或重新生成通知。
        notification = { id, notificationId: id, kind: 'status', taskId: task.taskId, requirementRevision: task.requirementRevision,
          payload, state: 'prepared', createdAt: stamp, updatedAt: stamp }
        put('dynamic_notifications', notification)
        ;(request.followupReplies ??= []).push({ sourceId: source.sourceId, notificationId: id,
          sessionId: a.binding.sessionId, leaseEpoch: a.binding.leaseEpoch, recordedAt: stamp })
      }
      if (a.reviewFailureCode !== undefined) {
        if (task.humanReviewLease !== a.binding.leaseEpoch || a.action !== 'blocked') fail('DYNAMIC_HUMAN_REVIEW_NOT_PENDING')
        const claimed = wakes(task.taskId).filter(item => item.state === 'claimed' && item.leaseEpoch === a.binding.leaseEpoch && item.payload?.humanRequestId)
        const request = task.humanRequests.find(item => item.requestId === claimed[0]?.payload.humanRequestId)
        if (!request) fail('DYNAMIC_HUMAN_REQUEST_STALE')
        // 工具错误不是空回复：保存真实错误并停在当前输入，不消费来源，也不定时重试。
        ;(request.reviewFailures ??= []).push({ code: text(a.reviewFailureCode, 'reviewFailureCode'),
          contextRevision: task.contextRevision ?? 0, leaseEpoch: a.binding.leaseEpoch, recordedAt: stamp,
          sourceIds: [...new Set(claimed.flatMap(item => item.payload.sourceIds))], wakeIds: claimed.map(item => item.id) })
      }
      if (task.humanReviewLease !== a.binding.leaseEpoch && all('dynamic_coordination_members').some(member=>member.taskId === task.taskId && member.reorderAssessment?.state === 'pending'
        && member.control !== 'cancelled' && get('dynamic_coordination',member.coordinationId).state === 'active'
        && coordination.current(member))) fail('DYNAMIC_COORDINATION_ASSESSMENT_REQUIRED')
      const question = a.question ?? a.decision?.question ?? null
      if (typeof question === 'string' && question.trim()) {
        const executions = execs(task.taskId).filter(executionCurrent)
        const providerWait = executions.some(item => ['EXECUTION_PROVIDER_TRANSIENT','EXECUTION_PROVIDER_FAILED'].includes(item.result?.payload.error?.code))
        const actionable = executions.some(item => item.result?.payload.error
          && (['credentials','quota','configuration'].includes(item.result.payload.error.recovery?.category)
            || !['EXECUTION_PROVIDER_TRANSIENT','EXECUTION_PROVIDER_FAILED'].includes(item.result.payload.error.code)))
          || ops(task.taskId).some(item => item.state === 'unknown')
        if (a.humanRequest?.audience !== 'requester' && providerWait && !actionable) fail('DYNAMIC_PROVIDER_TECHNICAL_WAIT')
        if (!a.humanRequest) fail('DYNAMIC_HUMAN_REQUEST_REQUIRED')
        const requestId = text(a.humanRequest.requestId, 'requestId')
        const audience = a.humanRequest.audience ?? 'operator'
        if (!['operator', 'requester'].includes(audience)) fail('DYNAMIC_ARGUMENT_INVALID', 'audience')
        const request = { requestId, audience, status: 'waiting-reply', question: question.trim(), reason: text(a.humanRequest.reason ?? question.trim(), 'reason'),
          waitingReason: text(a.humanRequest.waitingReason ?? a.summary, 'waitingReason'), objective: task.objective, evidence: clone(a.evidence ?? []),
          attemptedActions: clone(array(a.humanRequest.attemptedActions ?? [])),
          requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, createdAt: stamp }
        task.humanRequests ??= []
        const previous = task.humanRequests.find(item => item.requestId === requestId)
        if (previous && (previous.status !== 'waiting-reply' || digest({ ...previous, createdAt: null }) !== digest({ ...request, createdAt: null }))) fail('DYNAMIC_HUMAN_REQUEST_CONFLICT')
        if (!previous) {
          for (const item of task.humanRequests) if (item.status === 'waiting-reply') { item.status = 'superseded'; item.supersededAt = stamp }
          task.humanRequests.push(request)
        }
      }
      task.lastDecision = { action: a.action ?? 'wait', summary: text(a.summary, 'summary'), decision: a.decision ?? null, question: a.question ?? a.decision?.question ?? null,
        evidence: a.evidence ?? [], limitations: a.limitations ?? [], ...(a.humanReply ? { replySourceId: a.humanReply.sourceId } : {}),
        requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, at: stamp }
      if (a.reviewFailureCode === undefined) task.providerRecovery = null
      saveTask(task); return changed({ task, ...(notification ? { notification } : {}) })
    }
    if (kind === 'task.provider-failure') {
      const task = currentTask(a.binding, { active: false, current: false, allowHumanReview: true })
      const attempts = (task.providerRecovery?.attempts ?? 0) + 1
      const delays = [5000, 10000, 20000, 600000, 1800000, 3600000]
      task.providerRecovery = { attempts, failure: clone(record(a.failure)), requirementRevision: a.binding.requirementRevision,
        nextAttemptAt: attempts <= delays.length ? new Date(Date.parse(stamp) + delays[attempts - 1]).toISOString() : null,
        suspended: attempts > delays.length }
      saveTask(task); return changed({ task })
    }
    if (kind === 'task.human.resolve-failures') {
      const resolutions = array(a.resolutions)
      if (!resolutions.length || resolutions.length > 8 || new Set(resolutions.map(item => item.operationId)).size !== resolutions.length) fail('DYNAMIC_ARGUMENT_INVALID', 'resolutions')
      // One outer command transaction owns source, all releases and the human answer.
      // Any stale second item or competing reply rolls back every prior write/wake.
      reduce('source.record', record(a.source), `${commandId}:source`)
      for (const resolution of resolutions) reduce(resolution.proof?.kind === 'native-host-restart-isolated' ? 'operation.record-restart-isolation' : 'operation.resolve-investigated-failure', {
        ...a, ...resolution, operatorSourceId: a.source.sourceId, humanRequestId: a.requestId,
      }, `${commandId}:${resolution.operationId}`)
      const result = reduce('task.human.respond', { ...a, sourceId: a.source.sourceId }, `${commandId}:reply`)
      reduce('source.routed', { sourceId: a.source.sourceId, receipt: [{ taskId: a.taskId, humanRequestId: a.requestId }] }, `${commandId}:routed`)
      return result
    }
    if (kind === 'task.human.resolve' || kind === 'task.human.respond') {
      const reviewed = kind === 'task.human.resolve'
      const task = reviewed ? currentTask(a.binding, { allowHumanReview: true }) : get('dynamic_tasks', text(a.taskId, 'taskId'))
      if (reviewed && task.humanReviewLease !== a.binding.leaseEpoch) fail('DYNAMIC_HUMAN_REVIEW_NOT_PENDING')
      const review = reviewed ? pendingTaskHumanReview(task, wakes(task.taskId).filter(item => item.state === 'claimed' && item.leaseEpoch === a.binding.leaseEpoch)) : null
      if (reviewed && (!review || review.requestId !== a.requestId || !review.sourceIds.includes(a.sourceId))) fail('DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID')
      if (!reviewed && (a.expectedRequirementRevision !== task.requirementRevision || a.expectedControlRevision !== task.controlRevision)) fail('DYNAMIC_TASK_REVISION_STALE')
      if (task.status !== 'active' || task.control !== 'active') fail('DYNAMIC_TASK_NOT_ACTIVE')
      if (!reviewed && (!task.drained || task.recovering)) fail('DYNAMIC_TASK_BUSY')
      const request = (task.humanRequests ?? []).find(item => item.requestId === text(a.requestId, 'requestId'))
      if (!request || request.status !== 'waiting-reply' || request.requirementRevision !== task.requirementRevision || request.controlRevision !== task.controlRevision) fail('DYNAMIC_HUMAN_REQUEST_STALE')
      const source = get('dynamic_sources', text(a.sourceId, 'sourceId'))
      const notice = a.notificationId ? get('dynamic_notifications', a.notificationId, true) : null
      const privateReply = (request.audience ?? 'operator') === 'operator' && source.channel === 'private' && notice?.state === 'delivered' && notice.taskId === task.taskId
        && notice.payload.audience === 'operator' && notice.payload.humanRequestId === request.requestId
        && notice.receipt?.senderActorId === source.actorId && notice.receipt.messageId === source.quote?.messageId
        && notice.receipt.conversationId === source.quote?.conversationId
      const webReply = source.channel === 'web' && typeof webActorId === 'string' && webActorId.trim() && source.actorId === webActorId
      const requesterReply = request.audience === 'requester' && source.actorId === task.ownerActorId
      const reviewedReply = reviewed && request.audience === 'requester' && source.channel === 'im'
        && task.sourceRefs.includes(source.sourceId) && Date.parse(source.timestamp) >= Date.parse(request.createdAt)
        && Date.parse(source.timestamp) <= Date.parse(stamp)
      if (source.groupId !== task.groupId || !(reviewed ? reviewedReply : webReply || privateReply || requesterReply)) fail('DYNAMIC_HUMAN_RESPONSE_FORBIDDEN')
      if (reviewed) {
        const evidence = array(a.evidence).map(item => text(item, 'evidence'))
        if (!evidence.length) fail('DYNAMIC_ARGUMENT_INVALID', 'evidence')
        request.resolution = { reason: text(a.reason, 'reason'), evidence, sessionId: a.binding.sessionId,
          leaseEpoch: a.binding.leaseEpoch, recordedAt: stamp }
      }
      const correction = a.artifactScopeCorrection
      if (correction) {
        const coordination = get('dynamic_coordination', text(correction.coordinationId, 'coordinationId'))
        const members = all('dynamic_coordination_members').filter(member => member.coordinationId === coordination.id
          && !member.observation && member.control !== 'cancelled' && !['cancelled', 'superseded', 'template'].includes(member.state))
        if (!coordination || coordination.groupId !== task.groupId || coordination.state !== 'active'
          || coordination.revision !== correction.revision || !members.some(member => member.taskId === task.taskId)
          || members.some(member => get('dynamic_tasks', member.taskId).ownerActorId !== task.ownerActorId)) fail('TASK_ARTIFACT_CORRECTION_SCOPE')
        if (!webReply || request.audience !== 'operator' || source.actorId !== task.ownerActorId || correction.actorId !== source.actorId
          || canonical(source.requestIdentity?.artifactScopeCorrection ?? null) !== canonical(correction)) fail('TASK_ARTIFACT_CORRECTION_SCOPE')
        if (!isAbsolute(correction.artifactRoot) || basename(correction.artifactRoot) !== 'outputs'
          || basename(dirname(correction.artifactRoot)) !== correction.coordinationId
          || basename(dirname(dirname(correction.artifactRoot))) !== 'tasks') fail('TASK_ARTIFACT_CORRECTION_ROOT')
        coordination.artifactScopeCorrection = { ...clone(correction), sourceId: source.sourceId, recordedAt: stamp }
        ;(coordination.history ??= []).push({ kind: 'artifact-scope-correction', sourceId: source.sourceId,
          revision: coordination.revision, artifactRoot: correction.artifactRoot, recordedAt: stamp })
        put('dynamic_coordination', coordination)
      }
      const reply = text(source.text, 'reply')
      request.status = 'answered'; request.reply = reply; request.sourceId = source.sourceId; request.actorId = source.actorId; request.answeredAt = stamp
      request.replyChannel = source.channel === 'web' ? 'web' : privateReply ? 'private' : 'dingtalk'
      task.sourceRefs = [...new Set([...task.sourceRefs, source.sourceId])]; task.lastDecision = null
      if (a.topicRefs !== undefined) task.topicRefs = clone(array(a.topicRefs))
      if (a.operationId) task.appliedOperations = [...new Set([...(task.appliedOperations ?? []), text(a.operationId, 'operationId')])]
      saveTask(task)
      const wakeId = wake(task.taskId, 'human.responded', { requestId: request.requestId, sourceId: source.sourceId }, `wake:${commandId}`)
      return changed({ task, request, wakeId })
    }
    if (kind === 'task.complete') {
      const task = currentTask(a.binding)
      if (all('dynamic_coordination_members').some(member=>member.taskId === task.taskId
        && ['pending','needs_clarification'].includes(member.reorderAssessment?.state) && member.control !== 'cancelled'
        && get('dynamic_coordination',member.coordinationId).state === 'active' && coordination.current(member))) fail('DYNAMIC_COORDINATION_ASSESSMENT_REQUIRED')
      if (task.coordinationHold) fail('DYNAMIC_COORDINATION_WAITING')
      if (task.dialogue?.some(item => !item.reply)) fail('DYNAMIC_TASK_DIALOGUE_PENDING')
      if (execs(task.taskId).some(execution => (execution.feedback ?? []).some(item => !item.consumedAt && currentFeedback(execution, item)
        && item.requirementRevision === task.requirementRevision && item.controlRevision === task.controlRevision))) fail('DYNAMIC_EXECUTION_FEEDBACK_PENDING')
      assertClear(task.taskId)
      const instructionIds = coordination.coverage(task.taskId)
      for (const id of instructionIds) if (coordination.waiting(get('dynamic_coordination_members', id)).length) fail('DYNAMIC_COORDINATION_WAITING', id)
      task.status = 'completed'; task.completion = { summary: text(a.summary, 'summary'), result: a.result ?? null, at: stamp,
        commandId, instructionIds, runSequence: task.runSequence, contextRevision: task.contextRevision ?? 0,
        requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, leaseEpoch: task.leaseEpoch }
      for (const request of task.humanRequests ?? []) if (request.status === 'waiting-reply') { request.status = 'superseded'; request.supersededAt = stamp }
      task.providerRecovery = null
      saveTask(task)
      let notification = null
      if (a.notification !== undefined && a.notification !== null) {
        const id = `completion:${task.taskId}:${task.requirementRevision}`
        notification = { id, notificationId: id, kind: 'completion', taskId: task.taskId, requirementRevision: task.requirementRevision, state: 'prepared',
          payload: clone(a.notification), createdAt: stamp, updatedAt: stamp }
        put('dynamic_notifications', notification)
      }
      return changed({ task, notification })
    }
    if (kind === 'execution.dispatch') {
      const task = currentTask(a.binding)
      assertRestartRecoveryDispatch(task, a)
      assertNoLegacy(task.taskId)
      const key = text(a.key, 'key')
      if (a.definition?.executionBackend !== undefined && !['dsh', 'claude-code'].includes(a.definition.executionBackend)) fail('TASK_EXECUTION_BACKEND_INVALID')
      const prior = execs(task.taskId).find(item => item.key === key)
      const keys = resourceCatalog.keys(a.resourceKeys, !prior || prior.resourcePhase !== undefined)
      const payload = { prompt: text(a.prompt, 'prompt'), input: a.input ?? {}, definition: a.definition ?? null,
        resourceKeys: keys, resourcePhase: resourceCatalog.phase(a.resourcePhase ?? (prior && prior.resourcePhase === undefined ? resourceCatalog.executionPhase(prior) : undefined), keys) }
      const dispatchDigest = digest({ requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, ...payload })
      if (prior) {
        if (!resourceRequestMatches(prior.dispatchDigest, { requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, ...payload }, prior)) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
        return changed({ execution: prior })
      }
      const executionId = a.executionId ?? randomUUID()
      if (get('dynamic_executions', executionId, true)) fail('DYNAMIC_EXECUTION_EXISTS')
      const instructionScope = coordination.scope(task.taskId, 1)
      const execution = { id: executionId, executionId, taskId: task.taskId, key, ...clone(payload), instructionScope, instructionIds: instructionScope.instructionIds, title: executionSessionTitle({ input: payload.input, key }), dispatchDigest, inputDigest: digest(payload.input),
        requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, sessionId: `task-execution-${randomUUID()}`,
        ...(payload.definition?.executionBackend === 'claude-code' ? { claudeSessionMode: 'interactive-team-v1' } : {}),
        status: 'queued', inputVersion: 1, inputHistory: [], results: [], leaseEpoch: 0, sessionBound: false, drained: true, cancelRequested: false, createdAt: stamp, updatedAt: stamp,
        runTiming: { recorded: true, elapsedMs: 0, startedAt: null }, timeline: { version: 1, complete: true, segments: [] } }
      put('dynamic_executions', execution)
      return changed({ execution })
    }
    if (kind === 'execution.continue') {
      const task = currentTask(a.binding), execution = get('dynamic_executions', a.executionId)
      assertRestartRecoveryDispatch(task, a)
      if (execution.taskId !== task.taskId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID')
      if (!execution.drained || execution.leaseEpoch === 0) fail('DYNAMIC_EXECUTION_BUSY')
      const replyClaimed = wakes(task.taskId).some(item => item.kind === 'human.responded' && item.state === 'claimed' && item.leaseEpoch === task.leaseEpoch)
      if (execution.providerRecovery?.nextAttemptAt && !replyClaimed) fail('DYNAMIC_EXECUTION_RECOVERY_PENDING')
      assertNoLegacy(task.taskId)
      if (a.definition?.recoveryReadOnly !== true && ops(task.taskId).some(item => item.executionId === execution.executionId && operationBlocksRecovery(item))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      const key = text(a.key, 'key')
      const previous = (execution.continuations ?? []).find(item => item.key === key)
      const keys = a.resourceKeys === undefined ? resourceKeys(previous?.resourceKeys ?? execution.resourceKeys) : resourceCatalog.keys(a.resourceKeys, !previous || previous.resourcePhase !== undefined)
      const payload = { prompt: text(a.prompt, 'prompt'), input: a.input ?? {}, resourceKeys: keys,
        resourcePhase: resourceCatalog.phase(a.resourcePhase ?? resourceCatalog.executionPhase(previous ?? execution), keys) }
      const continuationDigest = digest({ ...payload, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision })
      if (previous) {
        if (!resourceRequestMatches(previous.digest, { ...payload, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision }, previous)) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
        return changed({ execution })
      }
      if ((digest(payload.resourceKeys) !== digest(resourceKeys(execution.resourceKeys)) || payload.resourcePhase !== resourceCatalog.executionPhase(execution)) && (execution.resourceLease
        || ops(execution.taskId).some(operation => operation.executionId === execution.executionId && operationBlocksRecovery(operation)))) fail('DYNAMIC_EXECUTION_RESOURCES_HELD')
      if (execution.result?.payload.error?.code === 'EXECUTION_PROVIDER_TRANSIENT' && execution.providerRecovery?.exhausted) {
        if (Date.parse(stamp) < Date.parse(execution.providerRecovery.retryNotBefore)) fail('DYNAMIC_PROVIDER_COOLDOWN_REQUIRED')
        execution.providerRecovery.coldAttempts = (execution.providerRecovery.coldAttempts ?? 0) + 1
      }
      execution.inputHistory.push({ inputVersion: execution.inputVersion, inputDigest: execution.inputDigest,
        requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision, instructionScope: clone(execution.instructionScope) })
      if (execution.result) execution.results.push(execution.result)
      execution.result = null; execution.progressReview = null; execution.inputVersion++; execution.inputDigest = digest(payload.input)
      execution.instructionScope = coordination.scope(task.taskId, execution.inputVersion)
      execution.instructionIds = execution.instructionScope.instructionIds
      execution.title ||= executionSessionTitle(execution)
      execution.prompt = payload.prompt; execution.input = clone(payload.input)
      execution.resourceKeys = payload.resourceKeys
      execution.resourcePhase = payload.resourcePhase
      if (execution.providerRecovery) execution.providerRecovery = { ...execution.providerRecovery, nextAttemptAt: null, nextReviewAt: null, activeInputVersion: null }
      execution.definition = { ...execution.definition, recoveryReadOnly: a.definition?.recoveryReadOnly === true }
      execution.requirementRevision = task.requirementRevision; execution.controlRevision = task.controlRevision
      execution.cancelRequested = false; execution.status = 'queued'; execution.updatedAt = stamp
      execution.continuations = [...(execution.continuations ?? []), { key, digest: continuationDigest, inputVersion: execution.inputVersion, resourceKeys: payload.resourceKeys, resourcePhase: payload.resourcePhase }]
      put('dynamic_executions', execution); return changed({ execution })
    }
    if (kind === 'execution.retry-provider') {
      const execution = boundExecution(a.binding)
      const task = get('dynamic_tasks', execution.taskId)
      if (!execution.drained || execution.recovering || !executionCurrent(execution)
        || execution.status !== 'queued' || !execution.providerRecovery?.nextAttemptAt || task.humanRequests?.some(item => item.status === 'waiting-reply')) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      if (wakes(task.taskId).some(item => item.kind === 'human.responded' && item.state !== 'acked')) fail('DYNAMIC_OWNER_INPUT_PENDING')
      assertNoLegacy(task.taskId)
      if (ops(task.taskId).some(item => item.executionId === execution.executionId && operationBlocksRecovery(item))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      if (Date.parse(stamp) < Date.parse(execution.providerRecovery.nextAttemptAt)) fail('DYNAMIC_EXECUTION_RETRY_NOT_DUE')
      execution.inputHistory.push({ inputVersion: execution.inputVersion, inputDigest: execution.inputDigest,
        requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision, instructionScope: clone(execution.instructionScope) })
      execution.results.push(execution.result)
      execution.result = null; execution.progressReview = null; execution.inputVersion++
      execution.instructionScope = coordination.scope(task.taskId, execution.inputVersion)
      execution.instructionIds = execution.instructionScope.instructionIds
      execution.status = 'queued'; execution.providerRecovery.nextAttemptAt = null
      execution.providerRecovery.activeInputVersion = execution.inputVersion
      execution.updatedAt = stamp; put('dynamic_executions', execution)
      return changed({ execution })
    }
    if (kind === 'execution.review-provider') {
      const execution = boundExecution(a.binding)
      const task = get('dynamic_tasks', execution.taskId)
      // 复核只唤醒当前统筹，不接纳旧需求的执行结果或自动重跑旧输入。
      if (!execution.drained || execution.recovering || task.archivedAt || task.status !== 'active' || task.control !== 'active'
        || execution.controlRevision !== task.controlRevision || execution.cancelRequested || execution.status !== 'failed'
        || !execution.providerRecovery?.nextReviewAt || task.humanRequests?.some(item => item.status === 'waiting-reply')) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      if (Date.parse(stamp) < Date.parse(execution.providerRecovery.nextReviewAt)) fail('DYNAMIC_EXECUTION_RETRY_NOT_DUE')
      if (ops(task.taskId).some(item => item.executionId === execution.executionId && operationBlocksRecovery(item))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      const reviews = (execution.providerRecovery.reviewAttempts ?? 0) + 1
      if (reviews > 3) fail('DYNAMIC_PROVIDER_REVIEW_LIMIT')
      execution.providerRecovery.reviewAttempts = reviews
      execution.providerRecovery.nextReviewAt = reviews < 3 ? new Date(Date.parse(stamp) + [1_800_000, 3_600_000][reviews - 1]).toISOString() : null
      execution.providerRecovery.reviewedAt = stamp
      execution.result.recovery = { ...execution.result.recovery, decision: 'review-ready', reviewAttempts: reviews, nextReviewAt: execution.providerRecovery.nextReviewAt }
      put('dynamic_executions', execution)
      const wakeId = wake(execution.taskId, 'execution.provider.review', { executionId: execution.executionId,
        reviewedAt: stamp, retryNotBefore: execution.providerRecovery.retryNotBefore,
        executionRequirementRevision: execution.requirementRevision, requirementRevision: task.requirementRevision,
        instruction: '通用模型/传输故障的冷却已结束，以本事件reviewedAt及retryNotBefore为准。先核对原失败、当前需求、操作账和恢复条件；需求版本变化时必须重新判断原小目标是否适用，再用原executionId受管续办当前要求，不自动重跑旧输入。不重放成功或未知效果；不得仅因短重试耗尽要求人工恢复服务。' }, `wake:${commandId}`)
      return changed({ execution, wakeId })
    }
    if (kind === 'execution.provider-recovery-blocked') {
      const execution = boundExecution(a.binding)
      if (!execution.providerRecovery?.nextAttemptAt && !execution.providerRecovery?.nextReviewAt) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      execution.providerRecovery.blocked = { code: text(a.code, 'code'), at: stamp }
      execution.providerRecovery.nextAttemptAt = null
      execution.providerRecovery.nextReviewAt = null
      execution.result.recovery = { ...execution.result.recovery, decision: 'blocked', blocked: clone(execution.providerRecovery.blocked), nextAttemptAt: null }
      execution.status = 'failed'; execution.updatedAt = stamp
      put('dynamic_executions', execution)
      const wakeId = wake(execution.taskId, 'execution.recovery.blocked', { executionId: execution.executionId, code: a.code,
        instruction: '自动恢复证据未通过核验，原始失败与效果记录保留。先调查原生终态、会话归属或未知效果，不重放操作，不据此推断凭据失效。' }, `wake:${commandId}`)
      return changed({ execution, wakeId })
    }
    if (kind === 'execution.progressReviewed') {
      const execution = get('dynamic_executions', text(a.executionId, 'executionId'))
      if (execution.inputVersion !== a.inputVersion || execution.leaseEpoch !== a.leaseEpoch || execution.inputDigest !== a.inputDigest) fail('DYNAMIC_EXECUTION_LEASE_STALE')
      if (execution.status !== 'running' || execution.drained || execution.recovering || execution.cancelRequested || !executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      const observation = record(a.observation)
      if (!Number.isSafeInteger(observation.lastSequence) || observation.lastSequence < -1
        || !Number.isSafeInteger(observation.newEventCount) || observation.newEventCount < 0 || typeof observation.changed !== 'boolean'
        || observation.lastActivityAt !== null && (typeof observation.lastActivityAt !== 'string' || !Number.isFinite(Date.parse(observation.lastActivityAt)))
        || observation.readError !== undefined && (typeof observation.readError !== 'string' || !observation.readError.trim())) fail('DYNAMIC_ARGUMENT_INVALID')
      execution.progressReview = { checkedAt: stamp, lastSequence: observation.lastSequence, lastActivityAt: observation.lastActivityAt,
        newEventCount: observation.newEventCount, changed: observation.changed, ...(observation.readError === undefined ? {} : { readError: observation.readError }) }
      put('dynamic_executions', execution)
      const wakeId = wake(execution.taskId, 'execution.progress.review', { executionId: execution.executionId, inputVersion: execution.inputVersion,
        leaseEpoch: execution.leaseEpoch, lastSequence: observation.lastSequence,
        instruction: '对照最新整体目标、范围、验收条件和受托目标核查实际行动；首次确认偏离即纠偏，跟进先前反馈的实际落实。保存方向判断、依据及下一必要结果，不能只复述运行状态。' }, `wake:${commandId}`)
      return changed({ execution, wakeId })
    }
    if (kind === 'execution.claim') {
      const execution = get('dynamic_executions', a.executionId)
      if (get('dynamic_tasks', execution.taskId).coordinationHold) fail('DYNAMIC_COORDINATION_WAITING')
      if (runtimeMode && JSON.parse(runtimeMode).mode === 'frozen' && execution.instructionScope?.instructionIds?.length) fail('DYNAMIC_COORDINATION_FROZEN')
      coordination.gate(execution)
      assertNoLegacy(execution.taskId)
      if (execution.result || execution.providerRecovery?.nextAttemptAt) fail('DYNAMIC_EXECUTION_RECOVERY_PENDING')
      if (!execution.drained || terminalExecutions.has(execution.status)) fail('DYNAMIC_EXECUTION_BUSY')
      if (!executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      if (!execution.definition?.recoveryReadOnly && ops(execution.taskId).some(item => item.executionId === execution.executionId && ['starting','unknown'].includes(item.state) && operationBlocksRecovery(item))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      // 同一事务全取或全不取，禁止持有部分资源后等待另一部分。
      const keys = resourceKeys(execution.resourceKeys)
      resourceCatalog.phase(resourceCatalog.executionPhase(execution), keys)
      lock(keys, executionHolder(execution))
      execution.instructionScope = coordination.claimScope(execution)
      if (keys.length) execution.resourceLease ??= { acquiredAt: stamp }
      execution.leaseEpoch++; execution.status = 'running'; execution.drained = false; execution.recovering = false
      // Legacy history stays explicitly incomplete; collect only this new, observed lease.
      execution.timeline ??= { version: 1, complete: false, segments: [] }
      execution.timeline.segments.push({ startedAt: stamp, endedAt: null, state: 'running', activity: executionSessionTitle(execution),
        inputVersion: execution.inputVersion, leaseEpoch: execution.leaseEpoch })
      if (execution.runTiming?.recorded) execution.runTiming.startedAt = stamp
      execution.updatedAt = stamp; put('dynamic_executions', execution)
      return { result: { execution, binding: executionBinding(execution) }, dispatchEligible: true }
    }
    if (kind === 'execution.progressReported') {
      const execution = boundExecution(a.binding)
      if (execution.drained || execution.status !== 'running' || !executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      const summary = text(a.summary, 'summary').trim(), evidence = array(a.evidence)
      if (summary.length > 2000 || evidence.length > 4 || evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) fail('DYNAMIC_EXECUTION_PROGRESS_INVALID')
      if (a.activity !== undefined && (typeof a.activity !== 'string' || !a.activity.trim() || a.activity.length > 120)) fail('DYNAMIC_EXECUTION_PROGRESS_INVALID')
      if (a.plan !== undefined && (typeof a.plan !== 'string' || !a.plan.trim() || a.plan.length > 4000)) fail('DYNAMIC_EXECUTION_PROGRESS_INVALID')
      const sequence = integer(a.sequence, 'sequence')
      if (execution.stageProgress?.inputVersion === execution.inputVersion && execution.stageProgress?.leaseEpoch === execution.leaseEpoch && sequence <= execution.stageProgress.sequence) fail('DYNAMIC_EXECUTION_PROGRESS_STALE')
      const plan = a.plan?.trim() ?? (execution.stageProgress?.inputVersion === execution.inputVersion ? execution.stageProgress.plan : undefined)
      const report = { summary, evidence: clone(evidence), ...(a.activity === undefined ? {} : { activity: a.activity.trim() }), ...(plan === undefined ? {} : { plan }), sequence, recordedAt: stamp, inputVersion: execution.inputVersion,
        leaseEpoch: execution.leaseEpoch, requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision }
      execution.stageProgress = report
      // A result summary describes the past, so never use it to infer a timed activity.
      // Only an explicit current activity starts a new segment at the Host timestamp.
      if (a.activity !== undefined) {
        const segment = execution.timeline?.segments.at(-1)
        if (segment?.state === 'running' && segment.activity !== a.activity.trim()) {
          if (Date.parse(stamp) >= Date.parse(segment.startedAt)) { segment.endedAt = stamp; segment.state = 'closed' }
          else { segment.state = 'unknown'; execution.timeline.complete = false }
          execution.timeline.segments.push({ startedAt: stamp, endedAt: null, state: 'running', activity: a.activity.trim(),
            inputVersion: execution.inputVersion, leaseEpoch: execution.leaseEpoch })
        }
      }
      put('dynamic_executions', execution)
      const wakeId = wake(execution.taskId, 'execution.stage.progress', { executionId: execution.executionId, ...report }, `execution-stage:${commandId}`)
      return changed({ execution, wakeId })
    }
    if (kind === 'execution.sessionBound' || kind === 'execution.drained' || kind === 'execution.result' || kind === 'execution.cancel') {
      const execution = kind === 'execution.cancel' && a.binding?.kind === 'task-session' ? (() => {
        const task = currentTask(a.binding, { active: false }); const item = get('dynamic_executions', a.executionId)
        if (item.taskId !== task.taskId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID'); return item
      })() : boundExecution(a.binding)
      if (kind === 'execution.sessionBound') execution.sessionBound = true
      if (kind === 'execution.cancel') { execution.cancelRequested = true; if (execution.drained) execution.status = 'cancelled' }
      if (kind === 'execution.drained') {
        if (a.isolationAuditRefs !== undefined) {
          const refs = array(a.isolationAuditRefs)
          if (!refs.length || new Set(refs.map(item => item.operationId)).size !== refs.length || refs.some(ref => {
            const operation = get('dynamic_operations', ref.operationId, true)
            return !operation || operation.executionId !== execution.executionId || operation.taskId !== execution.taskId
              || operation.dispatchBinding?.sessionId !== execution.sessionId || !hasRestartIsolation(operation)
              || digest(operation.recoverySettlement) !== ref.auditDigest
          })) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
          execution.recoveryDrainAudit = { kind: 'host-restart-isolated', refs: clone(refs), recordedAt: stamp }
        }
        const wasDrained = execution.drained
        stopExecutionTiming(execution, stamp)
        execution.drained = true; execution.recovering = false
        if (execution.cancelRequested && !terminalExecutions.has(execution.status)) execution.status = 'cancelled'
        else if (execution.status === 'running' && !execution.result) execution.status = 'queued'
        // An Owner may already have consumed the result while native drain was
        // still pending. Preserve that result wake and give the proven drain a
        // stable follow-up; an unclaimed result will read the drained state itself.
        const resultWake = get('dynamic_wakes', `execution-result:${execution.executionId}:${execution.inputVersion}`, true)
        if (!wasDrained && execution.result?.current && terminalExecutions.has(execution.status) && executionCurrent(execution)
          && resultWake && resultWake.state !== 'pending')
          wake(execution.taskId, 'execution.result', { executionId: execution.executionId, current: true, drained: true },
            `execution-drained:${execution.executionId}:${execution.inputVersion}`)
      }
      if (kind === 'execution.result') {
        if (!a.error && (a.feedbackVersion ?? 0) !== (execution.feedback ?? []).filter(item => currentFeedback(execution, item)).length) fail('DYNAMIC_EXECUTION_FEEDBACK_PENDING')
        if (!a.error && (execution.feedback ?? []).some(item => currentFeedback(execution, item) && !item.consumedAt)) fail('DYNAMIC_EXECUTION_FEEDBACK_PENDING')
        const payload = { output: a.output ?? null, error: a.error ?? null }
        if (execution.result && digest(execution.result.payload) !== digest(payload)) fail('DYNAMIC_EXECUTION_RESULT_CONFLICT')
        if (!execution.result) {
          stopExecutionTiming(execution, stamp)
          const current = executionCurrent(execution)
          execution.result = { payload, current, requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
            leaseEpoch: execution.leaseEpoch, inputVersion: execution.inputVersion,
            instructionScope: clone(execution.instructionScope), receivedAt: stamp }
          execution.status = current ? a.error ? 'failed' : 'succeeded' : 'stale'
          // Only native terminal evidence can admit provider recovery. Preserve the
          // original failure and successful effects; unresolved operations go to reconciliation.
          const terminal = a.error?.terminal
          const recoverable = current && a.error?.code === 'EXECUTION_PROVIDER_TRANSIENT'
            && terminal?.sessionId === execution.sessionId && terminal.inputVersion === execution.inputVersion
            && terminal.reason === 'error' && Number.isSafeInteger(terminal.endSeq) && terminal.endSeq >= 0
            && execution.sessionBound && !ops(execution.taskId).some(item => item.executionId === execution.executionId && operationBlocksRecovery(item))
            && !get('dynamic_tasks', execution.taskId).humanRequests?.some(item => item.status === 'waiting-reply')
          const attempts = execution.providerRecovery?.attempts ?? 0
          if (recoverable && attempts < 3) {
            execution.status = 'queued'
            execution.providerRecovery = { attempts: attempts + 1, nextAttemptAt: new Date(Date.parse(stamp) + 5000 * 2 ** attempts).toISOString(),
              failureInputVersion: execution.inputVersion, terminal: clone(terminal) }
          } else {
            if (recoverable) {
              const coldAttempts = execution.providerRecovery?.coldAttempts ?? 0
              const reviewAttempts = execution.providerRecovery?.reviewAttempts ?? 0
              const retryNotBefore = new Date(Date.parse(stamp) + [600_000, 1_800_000, 3_600_000][Math.min(Math.max(coldAttempts, reviewAttempts), 2)]).toISOString()
              execution.providerRecovery = { ...execution.providerRecovery, exhausted: true, nextAttemptAt: null, coldAttempts, retryNotBefore,
                terminal: clone(terminal), nextReviewAt: reviewAttempts < 3 && coldAttempts < 3 ? retryNotBefore : null }
            }
            wake(execution.taskId, 'execution.result', { executionId: execution.executionId, current }, `execution-result:${execution.executionId}:${execution.inputVersion}`)
          }
          if (a.error?.phase === 'provider') execution.result.recovery = { decision: execution.providerRecovery?.nextAttemptAt ? 'scheduled'
            : recoverable ? 'exhausted' : 'not-admitted', attempts: execution.providerRecovery?.attempts ?? 0,
            maxAttempts: 3, nextAttemptAt: execution.providerRecovery?.nextAttemptAt ?? null,
            coldAttempts: execution.providerRecovery?.coldAttempts ?? 0, retryNotBefore: execution.providerRecovery?.retryNotBefore ?? null,
            reviewAttempts: execution.providerRecovery?.reviewAttempts ?? 0,
            nextReviewAt: execution.providerRecovery?.nextReviewAt ?? null }
          if (!a.error && execution.providerRecovery) {
            execution.result.recovery = { decision: 'recovered', attempts: execution.providerRecovery.attempts, maxAttempts: 3, nextAttemptAt: null }
            execution.providerRecovery = null
          }
        }
      }
      execution.updatedAt = stamp; put('dynamic_executions', execution)
      releaseExecution(execution.executionId)
      return changed({ execution: get('dynamic_executions', execution.executionId), current: execution.result?.current ?? executionCurrent(execution) })
    }
    if (kind === 'operation.prepare') {
      const task = assertScope(a.binding)
      assertNoLegacy(task.taskId)
      const key = text(a.key, 'key'), definition = clone(record(a.definition))
      if (definition.commandDigest && ops(task.taskId).some(operation => hasRestartIsolation(operation)
        && operation.definition.toolName === definition.toolName && operation.recoverySettlement.proof.commandDigest === definition.commandDigest))
        fail('DYNAMIC_ISOLATED_OPERATION_REPLAY_FORBIDDEN')
      const keys = resourceKeys(a.resourceKeys)
      const execution = a.binding.executionId ? get('dynamic_executions', a.binding.executionId) : null
      const restartPending = restartRecoveryPending(task)
      if (restartPending.length && !(execution?.definition?.recoveryReadOnly === true && restartPending.includes(execution.input?.readbackOperationId))) fail('DYNAMIC_RESTART_RECOVERY_READ_ONLY')
      assertOperationResources(execution, keys)
      const specificationDigest = digest({ definition, resourceKeys: keys, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision })
      const prior = ops(task.taskId).find(item => item.key === key)
      if (prior) {
        if (prior.specificationDigest !== specificationDigest) fail('DYNAMIC_OPERATION_KEY_CONFLICT')
        return changed({ operation: prior })
      }
      const operationId = a.operationId ?? randomUUID()
      if (get('dynamic_operations', operationId, true)) fail('DYNAMIC_OPERATION_EXISTS')
      const operation = { id: operationId, operationId, taskId: task.taskId, executionId: a.binding.executionId ?? null,
        key, definition, resourceKeys: keys, ...(execution?.resourceKeys?.length ? { resourceHolder: executionHolder(execution) } : {}), specificationDigest, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision,
        ownerBinding: clone(a.binding), state: 'prepared', authorizationRef: a.authorizationRef ?? null, createdAt: stamp, updatedAt: stamp }
      put('dynamic_operations', operation); return changed({ operation })
    }
    if (kind === 'operation.cancelPrepared') {
      const operation = get('dynamic_operations', a.operationId)
      if (digest(record(a.binding)) !== digest(operation.ownerBinding) || text(a.key, 'key') !== operation.key) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      if (operation.state === 'cancelled') return changed({ operation })
      if (operation.state !== 'prepared') fail('DYNAMIC_OPERATION_ALREADY_DISPATCHED')
      operation.state = 'cancelled'; operation.result = { notDispatched: true, reason: text(a.reason, 'reason') }; operation.updatedAt = stamp
      put('dynamic_operations', operation)
      releaseOperation(operation)
      wake(operation.taskId, 'operation.not_dispatched', { operationId: operation.operationId }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.start') {
      const task = assertScope(a.binding), operation = get('dynamic_operations', a.operationId)
      if (operation.taskId !== task.taskId || operation.executionId !== (a.binding.executionId ?? null)
        || operation.requirementRevision !== task.requirementRevision || operation.controlRevision !== task.controlRevision) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      assertNoLegacy(task.taskId)
      if (operation.state !== 'prepared') return changed({ operation })
      assertOperationResources(a.binding.executionId ? boundExecution(a.binding) : null, resourceKeys(operation.resourceKeys))
      if (operation.resourceHolder) {
        const execution = boundExecution(a.binding)
        if (!execution.resourceLease || digest(heldKeys(operation.resourceHolder)) !== digest(resourceKeys(execution.resourceKeys))) fail('DYNAMIC_RESOURCE_INVARIANT')
        // 升级后发现多个旧别名持有者时保留双方记录，但不能继续产生相冲突的新效果。
        lock(execution.resourceKeys, operation.resourceHolder)
      } else lock(operation.resourceKeys, operation.operationId)
      operation.state = 'starting'; operation.dispatchBinding = clone(a.binding); operation.updatedAt = stamp
      put('dynamic_operations', operation)
      return { result: { operation }, dispatchEligible: true }
    }
    if (kind === 'operation.job') {
      const operation = get('dynamic_operations', a.operationId), job = record(a.job)
      if (digest(a.binding) !== digest(operation.dispatchBinding ?? {}) || job.owner !== operation.ownerBinding.sessionId
        || !['starting', 'unknown'].includes(operation.state) || typeof job.jobId !== 'string'
        || !['running', 'stopping', 'completed', 'failed', 'killed'].includes(job.status)
        || operation.job && (operation.job.jobId !== job.jobId || operation.job.startedAt !== job.startedAt)) fail('DYNAMIC_JOB_RECEIPT_INVALID')
      if (operation.job && ['completed','failed','killed'].includes(operation.job.status) && digest(operation.job) !== digest(job)) fail('DYNAMIC_JOB_RECEIPT_INVALID')
      operation.job = clone(job); operation.updatedAt = stamp; put('dynamic_operations', operation)
      return changed({ operation })
    }
    if (kind === 'operation.reconcile-web-read' || kind === 'operation.reconcile-file-precondition' || kind === 'operation.reconcile-job-read') {
      const task = currentTask(a.binding), operation = get('dynamic_operations', a.operationId), proof = record(a.proof)
      const execution = get('dynamic_executions', operation.executionId)
      const filePrecondition = kind === 'operation.reconcile-file-precondition'
      const jobRead = kind === 'operation.reconcile-job-read'
      if (operation.taskId !== task.taskId || operation.state !== 'unknown' || digest(operation) !== proof.operationDigest
        || proof.kind !== (jobRead ? 'native-job-read-missing' : filePrecondition ? 'native-file-precondition-failed' : 'native-web-read-failed') || proof.operationId !== operation.operationId
        || proof.taskId !== task.taskId || proof.executionId !== execution.executionId || proof.sessionId !== execution.sessionId
        || !execution.drained || execution.recovering || operation.result?.isError !== true || operation.result.cancelled === true
        || proof.toolName !== operation.definition.toolName
        || (jobRead ? operation.definition.toolName !== 'job_output' || operation.definition.nativeJobRead !== undefined
          || operation.definition.effectClass !== 'unknown'
          || typeof proof.jobId !== 'string' || !proof.jobId || proof.noEffect !== true
          : filePrecondition ? !isNativeFilePrecondition(operation.definition.toolName, { code: proof.errorCode }) || proof.noEffect !== true
          || operation.result.errorCode && operation.result.errorCode !== proof.errorCode
          : !['web_fetch', 'web_search'].includes(operation.definition.toolName)
            || operation.definition.effectClass !== undefined && !['read', 'pure'].includes(operation.definition.effectClass))
        || proof.callId !== operation.result.callId || proof.resultDigest !== operation.result.resultDigest
        || proof.argumentsDigest !== operation.definition.argumentsDigest
        || !Number.isSafeInteger(proof.resultSequence) || proof.resultSequence < 0
        || !Number.isSafeInteger(proof.turnEndSequence) || proof.turnEndSequence <= proof.resultSequence) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      const previousObservation = clone(operation)
      operation.state = 'failed'; operation.updatedAt = stamp
      operation.evidenceRef = `${jobRead ? 'native-job-read' : filePrecondition ? 'native-file-precondition' : 'native-web-read'}:${operation.operationId}:${digest(proof)}`
      operation.result = { reconciled: true, previousObservation, proof,
        ...(filePrecondition ? { noEffect: true, errorCode: proof.errorCode } : {}),
        ...(jobRead ? { noEffect: true } : {}),
        instruction: jobRead ? 'The original native job read rejected a missing job before reading output. Retain the failed receipt; do not replay the job or its producer command.'
          : filePrecondition ? 'The original file mutation was rejected before publication. Read the current file and correct the request within the original authorization. This is not success or automatic replay.'
          : 'The original web read returned an error and its native turn ended. This is not success and does not replay the request.' }
      put('dynamic_operations', operation); releaseOperation(operation)
      wake(task.taskId, 'operation.reconciled', { operationId: operation.operationId, state: 'failed' }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.reconcile-stopped' || kind === 'operation.resolve-investigated-failure') {
      const investigated = kind === 'operation.resolve-investigated-failure'
      const task = investigated ? get('dynamic_tasks', a.taskId) : currentTask(a.binding)
      const operation = get('dynamic_operations', a.operationId), proof = record(a.proof)
      const execution = get('dynamic_executions', operation.executionId)
      if (investigated) {
        const source = get('dynamic_sources', a.operatorSourceId), request = task.humanRequests?.find(item => item.requestId === a.humanRequestId)
        if (typeof webActorId !== 'string' || !webActorId.trim() || source.channel !== 'web' || source.actorId !== webActorId || source.groupId !== task.groupId
          || task.status !== 'active' || task.control !== 'active' || !task.drained || task.recovering
          || source.requestIdentity?.humanRequestId !== a.humanRequestId
          || !source.requestIdentity.nativeFailureResolutions?.some(item => item.operationId === operation.operationId && item.expectedOperationDigest === proof.operationDigest)
          || request?.status !== 'waiting-reply' || request.audience !== 'operator'
          || request.requirementRevision !== task.requirementRevision || request.controlRevision !== task.controlRevision
          || task.requirementRevision !== a.expectedRequirementRevision || task.controlRevision !== a.expectedControlRevision)
          fail('DYNAMIC_OPERATION_OPERATOR_RESOLUTION_REQUIRED')
      }
      if (operation.taskId !== task.taskId || operation.state !== 'unknown' || digest(operation) !== proof.operationDigest
        || proof.kind !== (investigated ? 'native-investigated-failure' : 'legacy-host-drained-partial')
        || investigated && (operation.result?.isError !== true || operation.result.cancelled === true
          || proof.toolName !== operation.definition.toolName
          || !Number.isSafeInteger(proof.resultSequence) || proof.resultSequence < 0
          || !Number.isSafeInteger(proof.turnEndSequence) || proof.turnEndSequence <= proof.resultSequence) || proof.operationId !== operation.operationId
        || proof.taskId !== task.taskId || proof.executionId !== execution.executionId || proof.sessionId !== execution.sessionId
        || !execution.drained || execution.recovering || proof.partialEffectsPossible !== true
        || proof.callId !== operation.result?.callId || proof.resultDigest !== operation.result?.resultDigest
        || proof.argumentsDigest !== operation.definition.argumentsDigest || !Array.isArray(proof.observations) || !proof.observations.length
        || proof.observations.some(observation => {
          const readback = get('dynamic_executions', observation.executionId, true)
          return !readback || readback.taskId !== task.taskId || readback.sessionId !== observation.sessionId
            || !readback.drained || readback.recovering || readback.status !== 'succeeded'
            || readback.definition?.recoveryReadOnly !== true || readback.input?.readbackOperationId !== operation.operationId
            || readback.inputVersion !== observation.inputVersion
        })) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      const previousObservation = clone(operation)
      operation.state = 'failed'; operation.updatedAt = stamp
      operation.evidenceRef = `${investigated ? 'native-investigated-failure' : 'host-stopped-readback'}:${operation.operationId}:${digest(proof)}`
      operation.result = { reconciled: true, partialEffectsPossible: true, previousObservation, proof,
        ...(investigated ? { operatorSourceId: a.operatorSourceId, humanRequestId: a.humanRequestId } : {}),
        instruction: investigated ? 'The original native call returned an error and its turn ended. Bound read-only investigation completed; partial effects remain possible. Retain the failed receipt and limitations. This is not success, noEffect, permission to replay, or authorization for new effects.' : 'The original operation was stopped and may have partial effects. Review the recorded readback before further work. This is not success or authorization to replay.' }
      put('dynamic_operations', operation); releaseOperation(operation)
      wake(task.taskId, 'operation.reconciled', { operationId: operation.operationId, state: 'failed', partialEffectsPossible: true }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.record-restart-isolation') {
      const task = get('dynamic_tasks', a.taskId), operation = get('dynamic_operations', a.operationId), proof = record(a.proof)
      const execution = get('dynamic_executions', operation.executionId), source = get('dynamic_sources', a.operatorSourceId)
      const request = task.humanRequests?.find(item => item.requestId === a.humanRequestId)
      if (typeof webActorId !== 'string' || !webActorId.trim() || source.channel !== 'web' || source.actorId !== webActorId
        || source.groupId !== task.groupId || source.requestIdentity?.humanRequestId !== a.humanRequestId
        || !source.requestIdentity.nativeRestartResolutions?.some(item => item.operationId === operation.operationId && item.expectedOperationDigest === proof.operationDigest
          && item.expectedIsolationDigest === digest(proof.isolation))
        || task.status !== 'active' || task.control !== 'active' || !task.drained || task.recovering
        || request?.status !== 'waiting-reply' || request.audience !== 'operator'
        || request.requirementRevision !== task.requirementRevision || request.controlRevision !== task.controlRevision
        || a.expectedRequirementRevision !== task.requirementRevision || a.expectedControlRevision !== task.controlRevision)
        fail('DYNAMIC_OPERATION_OPERATOR_RESOLUTION_REQUIRED')
      if (operation.taskId !== task.taskId || operation.state !== 'unknown' || operation.recoveryReason !== 'host_restart'
        || operation.result != null || operation.recoverySettlement || digest(operation) !== proof.operationDigest
        || proof.kind !== 'native-host-restart-isolated' || proof.operationId !== operation.operationId
        || proof.taskId !== task.taskId || proof.executionId !== execution.executionId || proof.sessionId !== execution.sessionId
        || operation.dispatchBinding?.sessionId !== execution.sessionId || operation.job?.owner !== execution.sessionId
        || !['running', 'stopping'].includes(operation.job?.status) || operation.job.finishedAt !== undefined
        || !execution.drained && !execution.recovering || !['pwsh', 'bash'].includes(operation.definition?.toolName)
        || proof.argumentsDigest !== operation.definition.argumentsDigest || proof.exitStatus !== 'unknown'
        || proof.partialEffectsPossible !== true || proof.noReplay !== true || typeof proof.callId !== 'string'
        || !Number.isSafeInteger(proof.callSequence) || proof.callSequence < 0
        || !Number.isSafeInteger(proof.registeredSequence) || proof.registeredSequence <= proof.callSequence
        || !validIsolationReceipt(proof.isolation, isolationBinding(operation, proof.callId))
        || !Array.isArray(proof.observations) || !proof.observations.length
        || proof.observations.some(observation => {
          const readback = get('dynamic_executions', observation.executionId, true)
          return !readback || readback.taskId !== task.taskId || readback.sessionId !== observation.sessionId
            || readback.status !== 'succeeded' || !readback.drained || readback.recovering
            || readback.definition?.recoveryReadOnly !== true || readback.input?.readbackOperationId !== operation.operationId
            || readback.inputVersion !== observation.inputVersion || Date.parse(readback.updatedAt) < Date.parse(operation.updatedAt)
        })) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      // This adds an audit decision, never an outcome, exit code or tool result.
      operation.recoverySettlement = { kind: 'host-restart-isolated', exitStatus: 'unknown', partialEffectsPossible: true,
        noReplay: true, operatorSourceId: a.operatorSourceId, humanRequestId: a.humanRequestId, recordedAt: stamp, proof: clone(proof) }
      if (!hasRestartIsolation(operation)) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      put('dynamic_operations', operation); releaseOperation(operation)
      wake(task.taskId, 'operation.isolation-audited', { operationId: operation.operationId, state: 'unknown', exitStatus: 'unknown', noReplay: true }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.reconcile-job') {
      const task = currentTask(a.binding), operation = get('dynamic_operations', a.operationId)
      if (operation.taskId !== task.taskId) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      const job = operation.job, execution = get('dynamic_executions', operation.executionId)
      if (!execution.drained || execution.recovering || operation.state !== 'unknown' || !job || job.owner !== operation.ownerBinding.sessionId
        || !['completed','failed','killed'].includes(job.status) || !Number.isFinite(job.finishedAt)) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      operation.state = job.cancelled === true ? 'cancelled' : job.status === 'completed' ? 'succeeded' : 'failed'
      operation.result = { jobReceipt: clone(job), previousObservation: clone(operation.result ?? null), reconciled: true, partialEffectsPossible: job.cancelled === true || job.status !== 'completed' }
      operation.evidenceRef = `native-job:${operation.operationId}:${digest(job)}`
      operation.updatedAt = stamp; put('dynamic_operations', operation); releaseOperation(operation)
      wake(task.taskId, 'operation.reconciled', { operationId: operation.operationId, state: operation.state }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.settle' || kind === 'operation.reconcile') {
      const operation = get('dynamic_operations', a.operationId)
      if (!['succeeded','failed','unknown','cancelled'].includes(a.state)) fail('DYNAMIC_ARGUMENT_INVALID', 'state')
      if (kind === 'operation.reconcile') text(a.evidenceRef, 'evidenceRef')
      else {
        if (!a.binding || digest(a.binding) !== digest(operation.dispatchBinding ?? {})) fail('DYNAMIC_OPERATION_LEASE_STALE')
      }
      if (terminalOperations.has(operation.state)) {
        if (a.state !== operation.state || digest(a.result ?? null) !== digest(operation.result ?? null)) fail('DYNAMIC_OPERATION_RESULT_CONFLICT')
        return changed({ operation })
      }
      if (operation.state === 'prepared' || operation.state === 'unknown' && kind !== 'operation.reconcile') fail('DYNAMIC_OPERATION_RECONCILIATION_REQUIRED')
      operation.state = a.state; operation.result = a.result ?? null; operation.evidenceRef = a.evidenceRef ?? null; operation.updatedAt = stamp
      put('dynamic_operations', operation)
      if (terminalOperations.has(operation.state)) releaseOperation(operation)
      const execution = operation.executionId ? get('dynamic_executions', operation.executionId, true) : null
      // 当前原执行会消费普通工具回执；统筹在执行终态或明确进度事件醒来。
      // 未知效果、对账、独立操作及失去原消费方的迟到结果仍须可靠唤醒。
      const executionConsumesResult = kind === 'operation.settle' && ['succeeded', 'failed'].includes(operation.state)
        && matchesExecutionBinding(execution, operation.dispatchBinding) && execution.status === 'running'
        && !execution.drained && executionCurrent(execution)
      if (!executionConsumesResult) wake(operation.taskId, 'operation.result', { operationId: operation.operationId, state: operation.state }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'legacy.import') {
      const id = text(a.id, 'id')
      const prior = get('dynamic_legacy_blockers', id, true)
      if (prior) return changed({ blocker: prior })
      const blocker = { id, kind: a.kind ?? 'external-operation', taskId: a.taskId ?? null, source: text(a.source, 'source'),
        state: a.state ?? 'unknown', resourceKeys: a.resourceKeys ?? [], resolved: false, evidenceRef: a.evidenceRef ?? null, importedAt: stamp }
      put('dynamic_legacy_blockers', blocker); lock(blocker.resourceKeys, id); return changed({ blocker })
    }
    if (kind === 'legacy.resolve') {
      const item = get('dynamic_legacy_blockers', a.id)
      text(a.evidenceRef, 'evidenceRef')
      if (!['succeeded','failed','not_started'].includes(a.outcome)) fail('DYNAMIC_ARGUMENT_INVALID', 'outcome')
      item.resolved = true; item.evidenceRef = a.evidenceRef; item.outcome = a.outcome; item.resolvedAt = stamp
      put('dynamic_legacy_blockers', item); release(item.id); return changed({ blocker: item })
    }
    if (kind === 'notification.prepare') {
      const task = ['topic-reply','coordination'].includes(a.kind) ? null : get('dynamic_tasks', a.taskId), id = text(a.notificationId, 'notificationId')
      if (!['question','status','topic-reply','coordination'].includes(a.kind)) fail('DYNAMIC_ARGUMENT_INVALID', 'kind')
      if (a.kind === 'coordination') {
        const fact = record(a.payload?.fact), coordination = get('dynamic_coordination', fact.coordinationId)
        text(fact.eventId, 'eventId')
        const sameEvent = all('dynamic_notifications').find(n => n.id !== id && n.kind === 'coordination'
          && n.payload.fact.coordinationId === fact.coordinationId && n.payload.fact.eventId === fact.eventId)
        if (sameEvent) fail('DYNAMIC_NOTIFICATION_EVENT_CONFLICT')
        if (a.payload.conversationId !== coordination.groupId || coordination.state === 'cancelled' && !controlNotice(a.payload)) fail('DYNAMIC_COORDINATION_SCOPE')
        if (fact.occurrenceId) {
          const occurrence = schedules.read('occurrences', fact.occurrenceId)
          if (occurrence.coordinationId !== coordination.id || occurrence.actionState !== 'succeeded' || occurrence.cancelledAt
            || fact.resultDigest !== digest(occurrence.result) || fact.instanceControlRevision !== occurrence.instanceControlRevision
            || fact.deliveryControlRevision !== occurrence.deliveryControlRevision
            || digest(a.payload.atOpenDingTalkIds ?? []) !== digest(occurrence.target.recipientIds)) fail('DYNAMIC_COORDINATION_JOB_STALE')
        }
      }
      integer(a.requirementRevision, 'requirementRevision')
      if (a.kind === 'topic-reply' && (!Array.isArray(a.payload?.fact?.topicRefs) || !a.payload.fact.topicRefs.length)) fail('DYNAMIC_ARGUMENT_INVALID', 'topicRefs')
      const body = { taskId: task?.taskId ?? null, requirementRevision: a.requirementRevision, kind: a.kind, payload: clone(record(a.payload)) }
      const prior = get('dynamic_notifications', id, true)
      if (prior) { if (prior.payloadDigest !== digest(body)) fail('DYNAMIC_NOTIFICATION_ID_CONFLICT'); return changed({ notification: prior }) }
      const notification = { id, notificationId: id, ...body, payloadDigest: digest(body), state: 'prepared', createdAt: stamp, updatedAt: stamp }
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.rejectBeforeSend') {
      const notification = get('dynamic_notifications', a.notificationId), error = notification.deliveryError
      const proof = notification.state === 'unknown' && !notification.ack && !notification.receipt && error?.phase === 'send'
        ? quotedSendRejectionProof(error, { groupId: notification.payload.conversationId, replyToMessageId: notification.payload.sourceMessageId,
          replyToSenderOpenDingTalkId: notification.payload.actorId, idempotencyKey: notification.id }) : undefined
      if (!proof) return changed({ notification })
      notification.sendAttemptCount ??= 1
      notification.state = 'failed'; notification.deliveryError = { ...error, knownNotSent: true, retryable: true, reason: proof.reason, origin: proof.origin, operation: proof.operation, proof }
      notification.nextAttemptAt = new Date(Date.now() + 60000).toISOString(); notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.retireUnsent') {
      const notification = get('dynamic_notifications', a.notificationId)
      if (notification.state !== 'failed' || notification.ack || notification.receipt || notification.deliveryError?.knownNotSent !== true) fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
      if (!['superseded', 'task-terminal', 'confirmation-reassessment-required'].includes(a.reason)) fail('DYNAMIC_ARGUMENT_INVALID', 'reason')
      if (a.reason === 'task-terminal') {
        if (!a.taskIds?.length || a.taskIds.some(id => { const task = get('dynamic_tasks', id); return task.status === 'active' && task.control !== 'cancelled' })) fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
      }
      notification.retirement = { reason: a.reason, taskIds: a.taskIds ?? [], evidenceRef: text(a.evidenceRef, 'evidenceRef'), at: stamp }
      notification.deliveryError = { ...notification.deliveryError, retryable: false }; notification.nextAttemptAt = null; notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.recovery.start') {
      const notification = get('dynamic_notifications', text(a.notificationId, 'notificationId'))
      const recovery = taskNotificationRecovery(notification)
      if (a.expectedToken !== recovery.expectedToken) throw Object.assign(new Error('DYNAMIC_NOTIFICATION_RECOVERY_STALE'), { code: 'DYNAMIC_NOTIFICATION_RECOVERY_STALE', statusCode: 409 })
      if (!recovery.action) throw Object.assign(new Error('TASK_NOTIFICATION_RECOVERY_FORBIDDEN'), { code: 'TASK_NOTIFICATION_RECOVERY_FORBIDDEN', statusCode: 409 })
      // Consume the CAS even when a readback leaves the delivery state unchanged.
      notification.recoveryToken = randomUUID(); notification.nextAttemptAt = null; notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.retry') {
      const notification = get('dynamic_notifications', a.notificationId)
      const proof = notification.deliveryError?.phase === 'send' && quotedSendRejectionProof(notification.deliveryError, { groupId: notification.payload.conversationId, replyToMessageId: notification.payload.sourceMessageId, replyToSenderOpenDingTalkId: notification.payload.actorId, idempotencyKey: notification.id })
      if (notification.retirement || notification.recall || notification.ack || notification.receipt || !proof || notification.state !== 'failed' || notification.deliveryError?.knownNotSent !== true || notification.deliveryError?.retryable !== true
        || Date.parse(notification.nextAttemptAt ?? '') > Date.now()) return changed({ notification })
      notification.state = 'prepared'; notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.ack' || kind === 'notification.diagnostic') {
      const notification = get('dynamic_notifications', a.notificationId)
      if (kind === 'notification.ack') {
        if (a.dispatchToken !== notification.dispatchToken || notification.state !== 'starting') fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
        notification.ack = clone(a.ack ?? null); notification.receipt = clone(a.ack ?? null); notification.ackedAt ??= stamp
      } else {
        if (!['unknown', 'starting'].includes(notification.state)) return changed({ notification })
        if (a.error) notification.lastReadbackError = clone(record(a.error))
        notification.readbackAttemptCount = (notification.readbackAttemptCount ?? 0) + 1
        notification.nextAttemptAt = text(a.nextAttemptAt, 'nextAttemptAt')
      }
      notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.recall.start' || kind === 'notification.recall.result') {
      const notification = get('dynamic_notifications', text(a.notificationId, 'notificationId'))
      const task = get('dynamic_tasks', notification.taskId)
      const request = task.humanRequests?.find(item => item.requestId === notification.payload.humanRequestId)
      if (notification.kind !== 'question' || notification.payload.audience !== 'operator'
        || request?.status !== 'answered' || request.replyChannel !== 'web' || notification.state !== 'delivered'
        || !notification.receipt?.messageId || !notification.receipt?.conversationId || !notification.receipt?.senderActorId)
        fail('DYNAMIC_NOTIFICATION_RECALL_NOT_REQUIRED')
      const previous = notification.recall
      if (kind === 'notification.recall.start') {
        if (previous?.state === 'recalled' || Date.parse(previous?.nextAttemptAt ?? '') > Date.parse(stamp)) return changed({ notification })
        notification.recall = { ...previous, state: 'starting', token: randomUUID(), attempts: (previous?.attempts ?? 0) + 1,
          nextAttemptAt: new Date(Date.parse(stamp) + 300000).toISOString(), updatedAt: stamp }
        put('dynamic_notifications', notification)
        return { result: { notification }, dispatchEligible: true }
      }
      if (!previous || previous.token !== a.token || previous.state !== 'starting') fail('DYNAMIC_NOTIFICATION_RECALL_STALE')
      if (!['recalled', 'failed'].includes(a.state)) fail('DYNAMIC_ARGUMENT_INVALID', 'state')
      notification.recall = { ...previous, state: a.state, updatedAt: stamp,
        nextAttemptAt: a.state === 'failed' ? text(a.nextAttemptAt, 'nextAttemptAt') : null,
        error: a.state === 'failed' ? clone(record(a.error)) : null,
        ...(a.state === 'recalled' ? { evidenceRef: text(a.evidenceRef, 'evidenceRef'), ...(a.proof ? { proof: clone(record(a.proof)) } : {}) } : {}) }
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.start' || kind === 'notification.receipt' || kind === 'notification.delivered' || kind === 'notification.reconcile') {
      const notification = get('dynamic_notifications', a.notificationId)
      if (kind === 'notification.start') {
        if (notification.state !== 'prepared') return changed({ notification })
        if (notification.kind === 'coordination' && runtimeMode && JSON.parse(runtimeMode).mode === 'frozen') return changed({ notification })
        if (notification.kind === 'coordination') {
          const fact = notification.payload.fact, coordination = get('dynamic_coordination', fact.coordinationId)
          // 只有账本已确认被后续来源补全的旧回复才失效；未知发送不会重新进入此许可分支。
          const source = fact.sourceUnitId ? get('dynamic_coordination_sources', digest({ unitId: fact.sourceUnitId, revision: fact.sourceUnitRevision }), true) : null
          if (source?.resolvedBy) {
            notification.state = 'superseded'; notification.retirement = { reason: 'coordination-source-resolved', resolvedBy: source.resolvedBy, at: stamp }
            notification.updatedAt = stamp; put('dynamic_notifications', notification); return changed({ notification })
          }
          const accepted = source?.acceptedProposal
          const initialSchedule = accepted?.kind === 'schedule' || accepted?.kind === 'resolve' && accepted.resolution?.kind === 'schedule'
          // 此类来源只创建 revision=1 的计划；从原接纳事实判断，避免改写历史通知 payload 破坏幂等回放。
          if (fact.eventId.startsWith('accepted:') && !fact.occurrenceId && initialSchedule
            && schedules.read('schedules', `schedule:${coordination.id}`, true)?.revision > 1) {
            notification.state = 'superseded'; notification.retirement = { reason: 'coordination-schedule-changed', at: stamp }
            notification.updatedAt = stamp; put('dynamic_notifications', notification); return changed({ notification })
          }
          if (!fact.occurrenceId && /^(?:clarification|accepted):/u.test(fact.eventId)) {
            const originId = source?.sourceRefs?.[0]
            const origin = originId && db.prepare('SELECT rowid AS sequence,body FROM dynamic_sources WHERE id=?').get(originId)
            if (origin) {
              const admitted = JSON.parse(origin.body)
              // 按准入账本顺序拦住已收到的后续消息，不依赖同秒消息或客户端时钟。
              // 抛出暂缓信号使事务回滚：不能缓存本次 start ID，也不能消耗发送次数。
              const pending = db.prepare(`SELECT id FROM dynamic_sources WHERE rowid>?
                AND json_extract(body,'$.groupId')=? AND json_extract(body,'$.actorId')=?
                AND (coalesce(json_extract(body,'$.routed'),0)=0 OR json_extract(body,'$.processingPending')=1)
                AND json_type(body,'$.processingCompleted') IS NULL LIMIT 1`).get(origin.sequence, admitted.groupId, admitted.actorId)
              if (pending) fail('DYNAMIC_NOTIFICATION_SOURCE_PENDING')
            }
          }
          // 在发送许可同一事务内回读摘要事实，取消本次安排不能被尚未运行的聚合扫描绕过。
          const summarySnapshot = fact.snapshotDigest ? currentCoordinationSnapshot(coordination) : null
          if (summarySnapshot && !hasCoordinationNotificationWork(summarySnapshot)) {
            notification.state = 'superseded'; notification.retirement = { reason: 'coordination-observation-only', at: stamp }
            put('dynamic_notifications', notification); return changed({ notification })
          }
          if (summarySnapshot && fact.snapshotDigest !== digest(summarySnapshot)) {
            notification.state = 'superseded'; notification.retirement = { reason: 'coordination-facts-changed', at: stamp }
            put('dynamic_notifications', notification); return changed({ notification })
          }
          const occurrence = fact.occurrenceId ? schedules.read('occurrences', fact.occurrenceId) : null
          if (notification.supersededBy || coordination.state === 'cancelled' && !controlNotice(notification.payload) || occurrence && (occurrence.cancelledAt
            || occurrence.notificationId !== notification.id || occurrence.resultVersion !== fact.resultVersion || digest(occurrence.result) !== fact.resultDigest
            || occurrence.instanceControlRevision !== fact.instanceControlRevision || occurrence.deliveryControlRevision !== fact.deliveryControlRevision)) {
            notification.state = 'failed'; notification.reason = 'coordination_cancelled'; put('dynamic_notifications', notification)
            return changed({ notification })
          }
          // Freshness must hold at the permit transaction, not depend on an asynchronous scan winning first.
          if (occurrence?.action.kind === 'read-query' && !notification.sendPermit
            && Date.parse(stamp) - Date.parse(occurrence.result.observedAt) >= (occurrence.freshnessWindowMs ?? 300000)) fail('DYNAMIC_NOTIFICATION_RECOVERY_STALE')
        }
        const task = ['topic-reply','coordination'].includes(notification.kind) ? null : get('dynamic_tasks', notification.taskId)
        const request = notification.kind === 'question' && task.humanRequests?.find(item => item.requestId === notification.payload.humanRequestId)
        if (notification.kind === 'question' && (notification.requirementRevision !== task.requirementRevision || task.status !== 'active' || task.control !== 'active'
          || !request || request.status !== 'waiting-reply' || request.requirementRevision !== task.requirementRevision
          || request.controlRevision !== task.controlRevision || (request.audience ?? 'operator') !== notification.payload.audience)) {
          notification.state = 'failed'; notification.reason = 'stale_question'; notification.updatedAt = stamp
          put('dynamic_notifications', notification); return changed({ notification })
        }
        assertNoLegacy(task?.taskId)
        notification.sendAttemptCount = (notification.sendAttemptCount ?? 0) + 1
        notification.state = 'starting'; notification.dispatchToken = randomUUID(); notification.updatedAt = stamp
        notification.sendStartedAt = stamp
        notification.sendPermit = { notificationId: notification.id, payloadDigest: notification.payloadDigest ?? digest(notification.payload),
          attempt: notification.sendAttemptCount, fence: notification.dispatchToken,
          ...(notification.kind === 'coordination' ? notification.payload.fact : {}) }
        put('dynamic_notifications', notification); return { result: { notification }, dispatchEligible: true }
      }
      const state = kind === 'notification.delivered' ? 'delivered' : a.state
      if (!['delivered','failed','unknown'].includes(state)) fail('DYNAMIC_ARGUMENT_INVALID', 'state')
      if (kind === 'notification.reconcile') text(a.evidenceRef, 'evidenceRef')
      else if (a.dispatchToken !== notification.dispatchToken || notification.state !== 'starting') fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
      if (['delivered','failed'].includes(notification.state)) return changed({ notification })
      if (a.phase === 'readback') notification.readbackAttemptCount = (notification.readbackAttemptCount ?? 0) + 1
      if (a.nextAttemptAt) notification.nextAttemptAt = text(a.nextAttemptAt, 'nextAttemptAt')
      if (state === 'delivered') { notification.nextAttemptAt = null; notification.deliveredAt ??= stamp }
      if (a.error) notification.deliveryError = clone(record(a.error))
      notification.state = state; notification.receipt = a.receipt ?? null; notification.evidenceRef = a.evidenceRef ?? null; notification.updatedAt = stamp
      if (notification.kind === 'coordination' && notification.payload.fact.occurrenceId) {
        const occurrence = schedules.read('occurrences', notification.payload.fact.occurrenceId)
        occurrence.deliveryState = state
        put('dynamic_coordination_occurrences', occurrence)
        if (state === 'delivered' && occurrence.scheduleId) {
          const schedule = schedules.read('schedules', occurrence.scheduleId)
          if (schedule.rule.kind === 'once' && schedule.state === 'active') { schedule.state = 'completed'; put('dynamic_coordination_schedules', schedule) }
        }
      }
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'source.record' || kind === 'source.acceptHistory' || kind === 'source.captureRevision') {
      const sourceId = text(a.sourceId, 'sourceId'), prior = get('dynamic_sources', sourceId, true)
      const explicitHistory = kind === 'source.acceptHistory'
      const revisionBasis = kind === 'source.captureRevision' ? get('dynamic_sources', text(a.admissionSourceId, 'admissionSourceId')) : null
      if (revisionBasis && (revisionBasis.groupId !== a.groupId || revisionBasis.messageId !== a.messageId || revisionBasis.actorId !== a.actorId || a.version <= revisionBasis.version)) fail('DYNAMIC_SOURCE_REVISION_CONFLICT')
      if (explicitHistory && a.authorizationRef !== `message-retry:${a.groupId}:${a.messageId}:${a.version ?? 1}`) fail('DYNAMIC_SOURCE_AUTHORIZATION_REQUIRED')
      const channel = a.channel ?? 'im', epochGated = !explicitHistory && !revisionBasis && boundIngressEpoch !== null && channel !== 'web'
      if ((explicitHistory || revisionBasis) && !ingressTimestamp(a.timestamp ?? a.occurredAt)) fail('DYNAMIC_SOURCE_TIMESTAMP_REQUIRED')
      const eventTimestamp = epochGated ? ingressTimestamp(a.timestamp ?? a.occurredAt) : a.timestamp ?? a.occurredAt ?? prior?.timestamp ?? stamp
      const source = { id: sourceId, sourceId, groupId: text(a.groupId, 'groupId'), messageId: text(a.messageId, 'messageId'),
        version: a.version ?? 1, actorId: text(a.actorId, 'actorId'), senderName: a.senderName ?? null, channel, text: a.text ?? '', quote: a.quote ?? null, resources: a.resources ?? [],
        timestamp: eventTimestamp, ...(a.receivedAt !== undefined ? { receivedAt: text(a.receivedAt, 'receivedAt') } : {}), initialRouteDecision: a.routeDecision === undefined ? null : clone(record(a.routeDecision)) }
      if (a.receivedAt !== undefined && !ingressTimestamp(a.receivedAt)) fail('DYNAMIC_SOURCE_TIMESTAMP_REQUIRED')
      if (revisionBasis) source.admissionSourceId = revisionBasis.sourceId
      if (a.requestIdentity !== undefined) source.requestIdentity = clone(record(a.requestIdentity))
      integer(source.version, 'version'); array(source.resources)
      // The enclosing command transaction durably records this negative receipt.
      // Rejected history must never enter the pending-source / group routing queue.
      if (epochGated && !eventTimestamp) return changed({ ignored: true, reason: 'invalid-ingress-timestamp', source: null })
      if (epochGated && Date.parse(eventTimestamp) < Date.parse(boundIngressEpoch)) return changed({ ignored: true, reason: 'before-ingress-epoch', source: null })
      if (prior) {
        const { routed: _routed, routedAt: _routedAt, receivedAt: _receivedAt, routeReceipt: _receipt, routeDecision: _decision, routePreparedAt: _prepared, processingCompleted: _processing, processingHistory: _history, processingPending: _pending, activeUnitRefs: _activeRefs, stages: _stages, ...previous } = prior
        const { receivedAt: _incomingReceivedAt, ...incoming } = source
        if (digest(previous) !== digest(incoming)) fail('DYNAMIC_SOURCE_CONFLICT')
        return changed({ source: prior })
      }
      if (source.initialRouteDecision) { source.routeDecision = clone(source.initialRouteDecision); source.routePreparedAt = stamp }
      put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'source.enrich') {
      const source = get('dynamic_sources', a.sourceId)
      if (stableTaskResourceIdentity(source.resources) !== stableTaskResourceIdentity(array(a.resources))) fail('DYNAMIC_SOURCE_CONFLICT')
      source.resources = clone(a.resources)
      put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'source.routePrepared') {
      const source = get('dynamic_sources', a.sourceId)
      if (source.routeDecision && digest(source.routeDecision) !== digest(a.decision)) fail('DYNAMIC_SOURCE_ROUTE_CONFLICT')
      source.routeDecision = clone(record(a.decision)); source.routePreparedAt ??= stamp
      put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'source.stage') {
      const source = get('dynamic_sources', a.sourceId), value = record(a.stage)
      const stage = { spanId: text(value.spanId, 'spanId'), stage: text(value.stage, 'stage'),
        requestId: text(value.requestId, 'requestId'), attempt: integer(value.attempt + 1, 'attempt') - 1,
        startedAt: text(value.startedAt, 'startedAt'), completedAt: value.completedAt ?? null,
        quality: value.completedAt ? 'observed' : 'open', shared: value.shared === true,
        ...(value.sessionId ? { sessionId: text(value.sessionId, 'sessionId') } : {}),
        ...(value.phase !== undefined ? { phase: value.phase } : {}),
        ...(value.loopDelayMs !== undefined ? { loopDelayMs: value.loopDelayMs } : {}) }
      if (stage.phase !== undefined && (stage.stage !== 'ingress' || !['source-read', 'resource-read', 'image-save', 'resident-store', 'source-record'].includes(stage.phase))
        || stage.loopDelayMs !== undefined && (stage.stage !== 'ingress' || stage.phase !== undefined || typeof stage.loopDelayMs !== 'number' || !Number.isFinite(stage.loopDelayMs) || stage.loopDelayMs < 0)) fail('DYNAMIC_SOURCE_STAGE_INVALID')
      if (!['ingress', 'queue', 'turn', 'host', 'send', 'readback'].includes(stage.stage)
        || !ingressTimestamp(stage.startedAt) || stage.completedAt !== null && !ingressTimestamp(stage.completedAt)) fail('DYNAMIC_SOURCE_STAGE_INVALID')
      if (stage.completedAt !== null && Date.parse(stage.completedAt) < Date.parse(stage.startedAt)) stage.quality = 'negative'
      source.stages ??= []
      const previous = source.stages.find(item => item.spanId === stage.spanId)
      if (previous) {
        const { completedAt: _end, quality: _quality, ...identity } = previous
        const { completedAt: _nextEnd, quality: _nextQuality, ...incoming } = stage
        if (digest(identity) !== digest(incoming) || previous.completedAt && previous.completedAt !== stage.completedAt) fail('DYNAMIC_SOURCE_STAGE_CONFLICT')
        if (!previous.completedAt && stage.completedAt) Object.assign(previous, stage)
      } else source.stages.push(stage)
      put('dynamic_sources', source); return changed({ sourceId: source.sourceId, stage })
    }
    if (kind === 'source.processingStarted') {
      const source = get('dynamic_sources', a.sourceId), refs = array(a.activeUnitRefs)
      if (source.version !== a.messageVersion) fail('DYNAMIC_SOURCE_REVISION_CONFLICT')
      const identity = refs => refs.map(ref => `${text(ref.unitId, 'unitId')}:${integer(ref.unitRevision, 'unitRevision')}`).sort()
      const previous = source.activeUnitRefs ?? source.processingCompleted?.activeUnitRefs
      if (new Set(identity(refs)).size !== refs.length) fail('DYNAMIC_SOURCE_PROCESSING_INCOMPLETE')
      if (!previous || digest(identity(previous)) !== digest(identity(refs)) || a.legacyPending === true && source.processingCompleted) {
        if (source.processingCompleted) (source.processingHistory ??= []).push(source.processingCompleted)
        delete source.processingCompleted
        source.processingPending = true
        source.activeUnitRefs = clone(refs)
      }
      put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'source.processingCompleted') {
      const source = get('dynamic_sources', a.sourceId)
      if (source.version !== a.messageVersion) fail('DYNAMIC_SOURCE_REVISION_CONFLICT')
      const units = array(a.units), refs = array(a.activeUnitRefs)
      integer(a.routingRevision, 'routingRevision')
      const key = unit => `${text(unit.unitId, 'unitId')}:${integer(unit.unitRevision, 'unitRevision')}`
      if (new Set(refs.map(key)).size !== refs.length || digest(refs.map(key).sort()) !== digest(units.map(key).sort()))
        fail('DYNAMIC_SOURCE_PROCESSING_INCOMPLETE')
      const unitIds = refs.map(unit => digest({ unitId: unit.unitId, revision: unit.unitRevision }))
      const coordinated = new Map(db.prepare('SELECT body FROM dynamic_coordination_sources WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(unitIds)).map(row => decode(row.body, 'dynamic_coordination_sources')).filter(item => item.sourceRefs?.includes(source.sourceId))
        .map(item => [`${item.unitId}:${item.revision}`, item]))
      for (const unit of units) {
        const ledger = coordinated.get(key(unit))
        if (unit.dispatchOwner === 'coordination') {
          if (!ledger || ledger.groupId !== source.groupId || ledger.sourceMessageId !== source.messageId
            || !(ledger.resolvedBy || ['accepted', 'needs_clarification'].includes(ledger.state))) fail('DYNAMIC_SOURCE_PROCESSING_INCOMPLETE')
        } else if (unit.dispatchOwner !== 'legacy-topic' || unit.processingComplete !== true
          || ledger && ledger.dispatchOwner !== 'legacy-topic') fail('DYNAMIC_SOURCE_PROCESSING_INCOMPLETE')
      }
      // 完成本轮语义判定不等于业务 settled；已提出澄清的来源也不能永久阻塞其他回复。
      if (source.activeUnitRefs && digest(source.activeUnitRefs.map(key).sort()) !== digest(refs.map(key).sort())) fail('DYNAMIC_SOURCE_PROCESSING_INCOMPLETE')
      if (source.processingCompleted && digest(source.processingCompleted.activeUnitRefs.map(key).sort()) !== digest(refs.map(key).sort())) {
        (source.processingHistory ??= []).push(source.processingCompleted)
        delete source.processingCompleted
      }
      source.processingCompleted ??= { at: stamp, routingRevision: a.routingRevision, activeUnitRefs: clone(refs) }
      source.processingPending = false
      put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'source.routed') {
      const source = get('dynamic_sources', a.sourceId)
      if (a.supersededByVersion !== undefined) {
        const version = integer(a.supersededByVersion, 'supersededByVersion')
        const replacement = db.prepare(`SELECT id FROM dynamic_sources WHERE json_extract(body,'$.groupId')=?
          AND json_extract(body,'$.messageId')=? AND json_extract(body,'$.actorId')=? AND json_extract(body,'$.version')=? LIMIT 1`)
          .get(source.groupId, source.messageId, source.actorId, version)
        if (version <= source.version || !replacement) fail('DYNAMIC_SOURCE_REVISION_CONFLICT')
        // Retiring an obsolete version is not evidence that its semantic processing completed.
        source.processingPending = false
      }
      if (source.routed && digest(source.routeReceipt) !== digest(a.receipt)) fail('DYNAMIC_SOURCE_ROUTE_CONFLICT')
      if (!source.routed) source.routedAt = stamp
      source.routed = true; source.routeReceipt = clone(a.receipt); put('dynamic_sources', source); return changed({ source })
    }
    if (kind === 'group.claim') {
      const groupId = text(a.groupId, 'groupId')
      const group = get('dynamic_groups', groupId, true) ?? { id: groupId, groupId, sessionId: `group-session-${randomUUID()}`, leaseEpoch: 0, sessionBound: false, drained: true }
      if (!group.drained) fail('DYNAMIC_GROUP_BUSY')
      group.leaseEpoch++; group.drained = false; group.recovering = false; put('dynamic_groups', group)
      const sources = all('dynamic_sources').filter(item => item.groupId === groupId && !item.routed)
      return { result: { group, sources, sourceIds: sources.map(item => item.sourceId), binding: { kind: 'group-session', groupId, sessionId: group.sessionId, leaseEpoch: group.leaseEpoch, sessionBound: group.sessionBound } }, dispatchEligible: true }
    }
    if (kind === 'group.sessionBound' || kind === 'group.drained') {
      const binding = record(a.binding), group = get('dynamic_groups', binding.groupId)
      if (binding.kind !== 'group-session' || binding.sessionId !== group.sessionId || binding.leaseEpoch !== group.leaseEpoch || group.drained) fail('DYNAMIC_GROUP_LEASE_STALE')
      if (kind === 'group.sessionBound') group.sessionBound = true
      else { group.drained = true; group.recovering = false }
      put('dynamic_groups', group); return changed({ group })
    }
    fail('DYNAMIC_COMMAND_UNKNOWN', kind)
  }

  return Object.freeze({
    info: Object.freeze({ dbPath, instanceId, version: VERSION, ingressEpoch: boundIngressEpoch }),
    get healthy() { return !closed && healthy },
    async maintain({ kind, args = {} }) {
      if (!['coordination.aggregate','coordination.observe.reconcile','coordination.schedule.scan'].includes(kind)) fail('DYNAMIC_MAINTENANCE_KIND_INVALID')
      record(args)
      return clone(transaction(() => ({ ...reduce(kind, args, `maintenance:${randomUUID()}`), replayed: false })))
    },
    async command(command) {
      record(command); const id = text(command.id, 'id'), kind = text(command.kind, 'kind'), args = record(command.args ?? {})
      const requestDigest = digest({ kind, args })
      return clone(transaction(() => {
        const previous = db.prepare('SELECT digest,body FROM dynamic_receipts WHERE id=?').get(id)
        if (previous) {
          if (previous.digest !== requestDigest) fail('DYNAMIC_COMMAND_ID_CONFLICT')
          return { ...decode(previous.body, 'dynamic_receipts', id), replayed: true, dispatchEligible: false }
        }
        // 与任务状态在同一事务保存完整决定；失败命令不留伪决定，同一命令重试不重复追加。
        const recordsDecision = ['task.wait', 'task.complete', 'task.dialogue.reply'].includes(kind)
        const triggers = recordsDecision ? wakes(args.binding.taskId).filter(w => w.state === 'claimed' && w.leaseEpoch === args.binding.leaseEpoch)
          .map(w => ({ wakeId: w.wakeId, kind: w.kind, ...Object.fromEntries(['executionId', 'inputVersion', 'leaseEpoch', 'lastSequence'].filter(key => w.payload?.[key] !== undefined).map(key => [key, w.payload[key]])) })) : []
        const value = { ...reduce(kind, args, id), replayed: false }
        if (recordsDecision) {
          const decision = kind === 'task.wait' ? { ...value.result.task.lastDecision,
            ...(args.audience || args.humanRequest ? { audience: args.audience ?? args.humanRequest.audience ?? 'operator' } : {}),
            ...(args.attemptedActions || args.humanRequest ? { attemptedActions: args.attemptedActions ?? args.humanRequest.attemptedActions ?? [] } : {}) }
            : kind === 'task.complete' ? { action: 'complete', summary: args.summary, evidence: [], limitations: [], ...args.result }
              : args.decision ?? { action: 'wait', summary: args.reply, evidence: [], limitations: [] }
          value.taskDecision = { id, taskId: args.binding.taskId, sessionId: args.binding.sessionId,
            leaseEpoch: args.binding.leaseEpoch, requirementRevision: args.binding.requirementRevision,
            controlRevision: args.binding.controlRevision, contextRevision: args.binding.contextRevision ?? 0,
            runSequence: value.result.task.runSequence,
            recordedAt: now(), triggers, decision: clone(decision) }
          if (kind === 'task.complete') {
            const task = get('dynamic_tasks', args.binding.taskId)
            const instructionCoverage = task.completion.instructionIds.map(instructionId => {
              const member = get('dynamic_coordination_members', instructionId)
              return { instructionId, commandId: member.command.id, effectiveVersion: clone(member.effectiveVersion),
                assessmentReceiptId: id, assessmentKind: 'current-owner-completion' }
            })
            value.taskDecision.instructionCoverage = instructionCoverage
            const event = { id: `task-completed:${id}`, eventVersion: 1, kind: 'task.completed', taskId: task.taskId,
              commandId: id, taskDecisionReceiptId: id, ...coordination.version(task),
              instructionCoverage, result: clone(task.completion.result), recordedAt: now() }
            const inserted = db.prepare('INSERT INTO dynamic_task_events(id,body) VALUES (?,?)').run(event.id, encode('dynamic_task_events', event))
            value.completionEvent = { ...event, sequence: Number(inserted.lastInsertRowid) }
            for (const coverage of instructionCoverage) {
              const member = get('dynamic_coordination_members', coverage.instructionId)
              member.completionReceipt = id
              member.completionProof = { eventId: event.id, sequence: Number(inserted.lastInsertRowid), commandId: id,
                taskDecisionReceiptId: id, ...coordination.version(task) }
              member.state = 'fulfilled'; put('dynamic_coordination_members', member)
            }
          }
        }
        db.prepare('INSERT INTO dynamic_receipts(id,digest,body) VALUES (?,?,?)').run(id, requestDigest, encode('dynamic_receipts', value, { ...receiptHint(args), id }))
        return value
      }))
    },
    async query(q) {
      if (closed) fail('DYNAMIC_STORE_CLOSED')
      record(q)
      let value
      if(q.kind==='observer.work-metadata')return observerWorkMetadata(db,q)
      if(q.kind==='observer.revision')return `${incarnation}:${db.prepare('SELECT total_changes() n').get().n}`
      if(['observer.group-version','observer.group-metadata','observer.message-contexts'].includes(q.kind))return observerGroupQuery(db,q,decode)
      if (q.kind === 'observer.page') return observerPage(db, q, incarnation, (table,id) => get(table,id))
      if (['task.index','execution.index','coordination.index'].includes(q.kind)) {
        const table = { 'task.index': 'dynamic_tasks', 'execution.index': 'dynamic_executions', 'coordination.index': 'dynamic_coordination' }[q.kind]
        const conditions = [], params = []
        if (q.taskId) { conditions.push("json_extract(body,'$.taskId')=?"); params.push(q.taskId) }
        if (q.groupId) { conditions.push("json_extract(body,'$.groupId')=?"); params.push(q.groupId) }
        const limit = q.limit ?? 100, after = q.after ?? 0
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0) fail('DYNAMIC_ARGUMENT_INVALID')
        conditions.push('rowid>?'); params.push(after, limit + 1)
        const names = ['id','taskId','executionId','groupId','status','state','control','drained','recovering','createdAt','updatedAt','archivedAt',
          'requirementRevision','contextRevision','controlRevision','runSequence','sessionId','sessionBound','leaseEpoch','inputVersion','inputDigest',
          'sourceId','revision','nextDueAt','aggregateDigest']
        const projection = names.flatMap(name => [`'${name}'`, `json_extract(body,'$.${name}')`]).join(',')
        const rows = db.prepare(`SELECT rowid AS sequence,json_object(${projection},'title',substr(json_extract(body,'$.title'),1,400),
          'lastDecision',json_object('action',json_extract(body,'$.lastDecision.action'),'summary',substr(json_extract(body,'$.lastDecision.summary'),1,400)),
          'detailStorage',CASE WHEN json_type(body,'$._hostDetail')='object' THEN 'external' ELSE 'inline' END) body
          FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY rowid LIMIT ?`).all(...params)
        const items = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.body), sequence: row.sequence }))
        return { items, nextAfter: rows.length > limit ? items.at(-1).sequence : null }
      }
      if (q.kind === 'ingress.policy') value = { instanceId, ingressEpoch: boundIngressEpoch }
      else if (q.kind === 'coordination.runtime') value = JSON.parse(db.prepare("SELECT value FROM dynamic_meta WHERE key='coordinationRuntime'").get()?.value ?? '{"mode":"active"}')
      else if (q.kind === 'coordination.assessments') value = all('dynamic_coordination_members').filter(m => m.taskId === q.taskId
        && m.control !== 'cancelled' && get('dynamic_coordination',m.coordinationId).state === 'active'
        && coordination.current(m)
        && ['pending','needs_clarification'].includes(m.reorderAssessment?.state)).map(m => ({instructionId:m.id,coordinationId:m.coordinationId,...m.reorderAssessment}))
      else if (q.kind === 'coordination.list') value = all('dynamic_coordination').filter(c => !q.groupId || c.groupId === q.groupId)
      else if (q.kind === 'coordination.get') value = { coordination: get('dynamic_coordination', q.coordinationId),
        members: all('dynamic_coordination_members').filter(m => m.coordinationId === q.coordinationId).map(coordination.view) }
      else if (q.kind === 'coordination.consumer.get') value = get('dynamic_coordination_consumers', q.consumerId, true)
      else if (q.kind === 'task.events') value = taskEvents(q.after ?? 0, q.limit ?? 100)
      else if (q.kind === 'coordination.source') value = get('dynamic_coordination_sources', digest({ unitId: q.unitId, revision: q.revision }), true)
      else if (q.kind === 'coordination.source.list') value = all('dynamic_coordination_sources').filter(s => !q.groupId || s.groupId === q.groupId)
      else if (q.kind === 'coordination.schedule.list') value = schedules.list('schedules').filter(s => !q.coordinationId || s.coordinationId === q.coordinationId)
      else if (q.kind === 'coordination.occurrence.list') value = schedules.list('occurrences').filter(o => !q.coordinationId || o.coordinationId === q.coordinationId)
      else if (q.kind === 'coordination.occurrence.get') value = schedules.read('occurrences', q.occurrenceId)
      else if (q.kind === 'coordination.job.list') value = schedules.list('jobs')
      else if (q.kind === 'task.get') value = get('dynamic_tasks', q.taskId, true)
      else if (q.kind === 'task.decisions') {
        get('dynamic_tasks', q.taskId)
        const before = q.before ?? Number.MAX_SAFE_INTEGER, limit = q.limit ?? 20
        if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DYNAMIC_ARGUMENT_INVALID')
        const rows = db.prepare(`SELECT rowid AS sequence,id,body FROM dynamic_receipts
          WHERE json_type(body,'$.taskDecision')='object' AND json_extract(body,'$.taskDecision.taskId')=? AND rowid<?
          ORDER BY rowid DESC LIMIT ?`).all(q.taskId, before, limit + 1)
        const decisions = rows.slice(0, limit).map(row => ({ ...decode(row.body, 'dynamic_receipts', row.id).taskDecision, sequence: row.sequence }))
        value = { taskId: q.taskId, decisions, nextBefore: rows.length > limit ? decisions.at(-1).sequence : null }
      }
      else if (q.kind === 'task.list') value = all('dynamic_tasks').filter(item => !q.groupId || item.groupId === q.groupId)
      else if (q.kind === 'task.blockers') value = blockers(q.taskId)
      else if (q.kind === 'task.binding') value = bindingOf(get('dynamic_tasks', q.taskId))
      else if (q.kind === 'execution.get') value = executionViews([get('dynamic_executions', q.executionId, true)])[0]
      else if (q.kind === 'execution.list') value = executionViews(q.taskId ? execs(q.taskId) : all('dynamic_executions'))
      else if (q.kind === 'execution.binding') value = executionBinding(get('dynamic_executions', q.executionId))
      else if (q.kind === 'execution.current') { const e = boundExecution(q.binding); value = !e.drained && e.status === 'running' && executionCurrent(e) }
      else if (q.kind === 'execution.team') {
        const source = boundExecution(q.binding), task = assertScope(q.binding)
        value = { taskId: task.taskId, executionId: source.executionId, executions: execs(task.taskId).map(execution => ({
          executionId: execution.executionId, sessionId: execution.sessionId, inputVersion: execution.inputVersion,
          requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
          title: executionSessionTitle(execution), status: execution.status, objective: execution.input?.objective ?? '',
          context: execution.input?.context ?? '', resourceKeys: execution.resourceKeys ?? [],
          result: execution.result ?? null, stageProgress: execution.stageProgress ?? null,
        })) }
      }
      else if (q.kind === 'execution.resources') {
        // 身份与资源在同一次账本查询中核验，续办前的租约不能读取新的持锁证明。
        const execution = boundExecution(q.binding)
        assertScope(q.binding)
        const { resources } = executionViews([execution])[0]
        value = { taskId: execution.taskId, executionId: execution.executionId, sessionId: execution.sessionId,
          requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
          inputVersion: execution.inputVersion, leaseEpoch: execution.leaseEpoch, resourcePhase: resourceCatalog.executionPhase(execution), resources }
      }
      else if (q.kind === 'operation.get') value = get('dynamic_operations', q.operationId, true)
      else if (q.kind === 'operation.list') value = ops(q.taskId)
      else if (q.kind === 'wake.list') value = wakes(q.taskId).filter(item => !q.state || item.state === q.state)
      else if (q.kind === 'notification.get') value = get('dynamic_notifications', q.notificationId, true)
      else if (q.kind === 'notification.list') value = all('dynamic_notifications').filter(item => (!q.taskId || item.taskId === q.taskId) && (!q.groupId || item.payload?.conversationId === q.groupId) && (!q.state || item.state === q.state))
      else if (q.kind === 'legacy.list') value = all('dynamic_legacy_blockers')
      else if (q.kind === 'resource.list') value = db.prepare('SELECT resource_key AS resourceKey,holder FROM dynamic_resource_locks ORDER BY resource_key').all()
      else if (q.kind === 'resource.catalog') value = resourceCatalog.snapshot
      else if (q.kind === 'source.get') value = get('dynamic_sources', q.sourceId, true)
      else if (q.kind === 'source.list') value = all('dynamic_sources').filter(item => (!q.groupId || item.groupId === q.groupId) && (!q.unrouted || !item.routed) && (!q.status || (q.status === 'routed' ? !!item.routed : !item.routed)))
      else if (q.kind === 'group.get') value = get('dynamic_groups', q.groupId, true)
      else if (q.kind === 'group.list') value = all('dynamic_groups')
      else if (q.kind === 'receipt.get') { const row = db.prepare('SELECT body FROM dynamic_receipts WHERE id=?').get(q.id); value = row ? decode(row.body, 'dynamic_receipts', q.id) : null }
      else if (q.kind === 'recovery.pending') value = { tasks: all('dynamic_tasks', "WHERE coalesce(json_extract(body,'$.drained'),0)=0"),
        groups: all('dynamic_groups').filter(item => !item.drained), executions: all('dynamic_executions', "WHERE coalesce(json_extract(body,'$.drained'),0)=0 OR json_extract(body,'$.status')='queued'"),
        operations: all('dynamic_operations', "WHERE coalesce(json_extract(body,'$.state'),'') NOT IN ('succeeded','failed','cancelled')").filter(item => operationBlocksRecovery(item)), notifications: all('dynamic_notifications', "WHERE coalesce(json_extract(body,'$.state'),'') NOT IN ('delivered','failed')"), legacy: legacy() }
      else fail('DYNAMIC_QUERY_UNKNOWN', q.kind)
      if (q.kind === 'task.get' && value && restartReopenEligible(value)) value = { ...value, restartRecoveryEligible: true }
      if (q.kind === 'task.list') value = value.map(task => restartReopenEligible(task) ? { ...task, restartRecoveryEligible: true } : task)
      return clone(value)
    },
    async close() {
      if (closed) return
      try { if (healthy) transaction(() => db.prepare('DELETE FROM dynamic_meta WHERE key=\'owner\' AND value=?').run(incarnation));
        else db.prepare("DELETE FROM dynamic_meta WHERE key='owner' AND value=?").run(incarnation) }
      finally { closed = true; db.close(); details.close(); livePaths.delete(pathKey) }
    },
  })
}
