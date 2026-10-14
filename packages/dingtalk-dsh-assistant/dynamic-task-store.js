import { quotedSendRejectionProof } from './group-message.js'
import { stableTaskResourceIdentity } from './task-message-projections.js'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'

// This ledger belongs to the trusted Host. None of its write commands are model tools.
// SQLite transactions commit command receipts and causal wakes together, before dispatch.
const VERSION = 1
const APPLICATION = 0x44535453
const livePaths = new Set()
const terminalOperations = new Set(['succeeded', 'failed', 'cancelled'])
const terminalExecutions = new Set(['succeeded', 'failed', 'cancelled', 'stale'])
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
export async function openDynamicTaskStore({ dbPath, instanceId, initialize = false, legacyDbPath, ingressEpoch } = {}) {
  if (!isAbsolute(dbPath ?? '') || !text(instanceId, 'instanceId') || typeof initialize !== 'boolean'
    || legacyDbPath !== undefined && !isAbsolute(legacyDbPath)) fail('DYNAMIC_STORE_OPTIONS_INVALID')
  const configuredIngressEpoch = ingressEpoch === undefined ? null : ingressTimestamp(ingressEpoch, false)
  if (ingressEpoch !== undefined && !configuredIngressEpoch) fail('DYNAMIC_INGRESS_EPOCH_INVALID', 'ingressEpoch must be an ISO timestamp with a timezone.')
  let boundIngressEpoch = null
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
  const all = (table, where = '', args = []) => db.prepare(`SELECT body FROM ${table} ${where}`).all(...args).map(row => JSON.parse(row.body))
  const get = (table, id, optional = false) => {
    const row = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(text(id, 'id'))
    if (!row && !optional) fail('DYNAMIC_NOT_FOUND', `${table}:${id}`)
    return row ? JSON.parse(row.body) : null
  }
  const put = (table, value) => db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id, canonical(value))
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
    requirementRevision: task.claimRequirementRevision ?? task.requirementRevision, controlRevision: task.claimControlRevision ?? task.controlRevision,
    leaseEpoch: task.leaseEpoch, sessionBound: task.sessionBound })
  const executionBinding = execution => ({ kind: 'task-execution', taskId: execution.taskId, executionId: execution.executionId,
    requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision, inputDigest: execution.inputDigest,
    sessionId: execution.sessionId, sessionBound: execution.sessionBound, leaseEpoch: execution.leaseEpoch, inputVersion: execution.inputVersion, inputHistory: execution.inputHistory })
  const currentTask = (binding, { active = true, current = true } = {}) => {
    record(binding)
    const task = get('dynamic_tasks', binding.taskId)
    if (binding.kind !== 'task-session' || binding.sessionId !== task.sessionId || binding.leaseEpoch !== task.leaseEpoch || task.drained) fail('DYNAMIC_TASK_LEASE_STALE')
    if (current && task.recovering) fail('DYNAMIC_TASK_LEASE_STALE')
    if (current && (binding.requirementRevision !== task.requirementRevision || binding.controlRevision !== task.controlRevision)) fail('DYNAMIC_TASK_REVISION_STALE')
    if (active && (task.control !== 'active' || task.status !== 'active')) fail('DYNAMIC_TASK_NOT_ACTIVE')
    return task
  }
  const boundExecution = binding => {
    record(binding)
    const execution = get('dynamic_executions', binding.executionId)
    if (binding.kind !== 'task-execution' || binding.taskId !== execution.taskId || binding.sessionId !== execution.sessionId
      || binding.leaseEpoch !== execution.leaseEpoch || binding.requirementRevision !== execution.requirementRevision
      || binding.controlRevision !== execution.controlRevision || binding.inputDigest !== execution.inputDigest || binding.inputVersion !== execution.inputVersion) fail('DYNAMIC_EXECUTION_LEASE_STALE')
    return execution
  }
  const executionCurrent = execution => {
    const task = get('dynamic_tasks', execution.taskId)
    return !execution.recovering && task.status === 'active' && task.control === 'active' && execution.requirementRevision === task.requirementRevision
      && execution.controlRevision === task.controlRevision && !execution.cancelRequested
  }
  const blockers = taskId => ({
    executions: execs(taskId).filter(item => !item.drained || !terminalExecutions.has(item.status)),
    operations: ops(taskId).filter(item => !terminalOperations.has(item.state)),
    legacy: legacy(),
  })
  const assertNoLegacy = taskId => { if (legacy().length) fail('DYNAMIC_LEGACY_EFFECT_UNRESOLVED') }
  const assertClear = taskId => { const value = blockers(taskId); if (Object.values(value).some(items => items.length)) fail('DYNAMIC_TASK_NOT_QUIESCENT', canonical(value)) }
  const assertScope = binding => {
    if (binding?.kind === 'task-session') return currentTask(binding)
    const execution = boundExecution(binding)
    if (execution.drained || execution.status !== 'running' || !executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
    return get('dynamic_tasks', execution.taskId)
  }
  const release = holder => db.prepare('DELETE FROM dynamic_resource_locks WHERE holder=?').run(holder)
  const lock = (keys, holder) => {
    for (const resourceKey of keys) {
      const prior = db.prepare('SELECT holder FROM dynamic_resource_locks WHERE resource_key=?').get(resourceKey)
      if (prior && prior.holder !== holder) fail('DYNAMIC_RESOURCE_BUSY', resourceKey)
    }
    for (const resourceKey of keys) db.prepare('INSERT OR IGNORE INTO dynamic_resource_locks(resource_key,holder) VALUES (?,?)').run(resourceKey, holder)
  }
  const transaction = fn => {
    if (closed || !healthy) fail('DYNAMIC_STORE_CLOSED')
    db.exec('BEGIN IMMEDIATE')
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
    }
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
        CREATE UNIQUE INDEX dynamic_execution_key ON dynamic_executions(json_extract(body,'$.taskId'),json_extract(body,'$.key'));
        CREATE UNIQUE INDEX dynamic_operation_key ON dynamic_operations(json_extract(body,'$.taskId'),json_extract(body,'$.key'));
        CREATE UNIQUE INDEX dynamic_notification_revision ON dynamic_notifications(json_extract(body,'$.taskId'),json_extract(body,'$.requirementRevision')) WHERE json_extract(body,'$.kind')='completion';
        `)
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('instanceId', instanceId)
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('initToken', marker.initToken)
      if (configuredIngressEpoch) db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (?,?)').run('ingressEpoch', configuredIngressEpoch)
      db.exec('COMMIT')
    } else if (version !== VERSION || db.prepare('PRAGMA application_id').get().application_id !== APPLICATION) fail('DYNAMIC_SCHEMA_INVALID')
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
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('DYNAMIC_STORE_CORRUPT')
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
    try {
      const previous = db.prepare('SELECT value FROM dynamic_meta WHERE key=\'owner\'').get()?.value
      if (previous) {
        const pid = Number(previous.split(':')[0])
        let alive = true
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
        if (alive) fail('DYNAMIC_STORE_ALREADY_OPEN')
      }
      db.prepare('INSERT INTO dynamic_meta(key,value) VALUES (\'owner\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(incarnation)
      // Recovery never authorizes a second send. Tool/process state must first be drained or reconciled.
      for (const operation of ops()) if (operation.state === 'starting') { operation.state = 'unknown'; operation.recoveryReason = 'host_restart'; put('dynamic_operations', operation) }
      for (const notification of all('dynamic_notifications')) if (notification.state === 'starting') { notification.state = 'unknown'; put('dynamic_notifications', notification) }
      for (const execution of all('dynamic_executions')) if (!execution.drained) { execution.recovering = true; put('dynamic_executions', execution) }
      for (const task of all('dynamic_tasks')) if (!task.drained) { task.recovering = true; saveTask(task) }
      for (const group of all('dynamic_groups')) if (!group.drained) { group.recovering = true; put('dynamic_groups', group) }
      importLegacy()
      for (const operation of ops()) if (['starting','unknown'].includes(operation.state)) {
        const held = db.prepare('SELECT resource_key FROM dynamic_resource_locks WHERE holder=? ORDER BY resource_key').all(operation.operationId).map(item => item.resource_key)
        if (digest(held) !== digest(operation.resourceKeys)) fail('DYNAMIC_RESOURCE_INVARIANT')
      }
      db.exec('COMMIT')
      if (!marker) { marker = { version: 1, instanceId, phase: 'initialized', initToken: initToken ?? randomUUID(), ingressEpoch: boundIngressEpoch };
        if (!initToken) db.prepare("INSERT INTO dynamic_meta(key,value) VALUES ('initToken',?)").run(marker.initToken)
        durableMarker(markerPath, marker, true)
      } else if (marker.phase !== 'initialized') { marker.phase = 'initialized'; durableMarker(markerPath, marker) }
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
  } catch (error) {
    try { if (db?.isTransaction) db.exec('ROLLBACK'); db?.prepare("DELETE FROM dynamic_meta WHERE key='owner' AND value=?").run(incarnation) } catch {}
    db?.close(); livePaths.delete(pathKey); throw error
  }

  function reduce(kind, a, commandId) {
    const stamp = now()
    if (kind === 'task.create') {
      const taskId = text(a.taskId, 'taskId')
      if (get('dynamic_tasks', taskId, true)) fail('DYNAMIC_TASK_EXISTS')
      const task = { id: taskId, taskId, sessionId: `task-session-${randomUUID()}`, groupId: a.groupId ?? null,
        sourceRefs: a.sourceRefs ?? [], topicRefs: a.topicRefs ?? [], appliedOperations: a.operationId ? [a.operationId] : [], runSequence: 1, ownerActorId: a.ownerActorId ?? null, title: a.title ?? a.objective ?? a.request ?? taskId,
        objective: a.objective ?? a.request ?? '', request: a.request ?? a.objective ?? '', requirements: a.requirements ?? [], metadata: a.metadata ?? {},
        requirementRevision: 1, controlRevision: 1, status: 'active', control: 'active', leaseEpoch: 0, sessionBound: false, drained: true,
        createdAt: stamp, updatedAt: stamp }
      text(task.request, 'request'); array(task.sourceRefs); array(task.requirements)
      saveTask(task); wake(taskId, 'task.created', { sourceRefs: task.sourceRefs }, `wake:${commandId}`)
      return changed({ task })
    }
    if (kind === 'task.revise' || kind === 'task.reopen' || kind === 'task.control') {
      const task = get('dynamic_tasks', a.taskId)
      if (kind === 'task.revise' || kind === 'task.reopen') {
        if (a.expectedRequirementRevision !== undefined && a.expectedRequirementRevision !== task.requirementRevision
          || a.expectedControlRevision !== undefined && a.expectedControlRevision !== task.controlRevision) fail('DYNAMIC_TASK_REVISION_STALE')
        if (kind === 'task.reopen') {
          if (task.status !== 'completed' || !task.drained || blockers(task.taskId).operations.length) fail('DYNAMIC_TASK_NOT_QUIESCENT')
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
        if (a.control === 'cancelled') task.status = 'cancelled'
      }
      if (a.topicRefs !== undefined) task.topicRefs = clone(array(a.topicRefs))
      if (a.operationId) task.appliedOperations = [...new Set([...(task.appliedOperations ?? []), text(a.operationId, 'operationId')])]
      for (const execution of execs(task.taskId)) if (!terminalExecutions.has(execution.status)) {
        execution.cancelRequested = true
        if (execution.drained) execution.status = 'stale'
        put('dynamic_executions', execution)
      }
      for (const operation of ops(task.taskId)) if (operation.state === 'prepared') { operation.state = 'cancelled'; put('dynamic_operations', operation) }
      saveTask(task); wake(task.taskId, kind, { requirementRevision: task.requirementRevision, controlRevision: task.controlRevision }, `wake:${commandId}`)
      return changed({ task })
    }
    if (kind === 'task.claim') {
      const task = get('dynamic_tasks', a.taskId)
      if (!task.drained) fail('DYNAMIC_TASK_BUSY')
      task.leaseEpoch++; task.drained = false; task.recovering = false
      task.claimRequirementRevision = task.requirementRevision; task.claimControlRevision = task.controlRevision
      const pending = wakes(task.taskId).filter(item => item.state !== 'acked')
      if (!pending.length && !a.force) fail('DYNAMIC_TASK_NO_WAKE')
      for (const item of pending) { item.state = 'claimed'; item.leaseEpoch = task.leaseEpoch; put('dynamic_wakes', item) }
      saveTask(task)
      return { result: { task, binding: bindingOf(task), wakeIds: pending.map(item => item.id), wakes: pending }, dispatchEligible: true }
    }
    if (kind === 'task.sessionBound' || kind === 'task.drained') {
      const task = currentTask(a.binding, { active: false, current: false })
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
      const task = currentTask(a.binding, { active: false, current: false })
      const ids = array(a.wakeIds)
      for (const id of ids) {
        const item = get('dynamic_wakes', id)
        if (item.taskId !== task.taskId || item.leaseEpoch !== task.leaseEpoch || !['claimed','acked'].includes(item.state)) fail('DYNAMIC_WAKE_CLAIM_STALE')
        item.state = 'acked'; item.ackedAt = stamp; put('dynamic_wakes', item)
      }
      return changed({ wakeIds: ids })
    }
    if (kind === 'task.wait') {
      const task = currentTask(a.binding, { active: false })
      task.lastDecision = { action: a.action ?? 'wait', summary: text(a.summary, 'summary'), decision: a.decision ?? null, question: a.question ?? a.decision?.question ?? null,
        evidence: a.evidence ?? [], limitations: a.limitations ?? [], requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, at: stamp }
      saveTask(task); return changed({ task })
    }
    if (kind === 'task.complete') {
      const task = currentTask(a.binding)
      assertClear(task.taskId)
      task.status = 'completed'; task.completion = { summary: text(a.summary, 'summary'), result: a.result ?? null, at: stamp,
        requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, leaseEpoch: task.leaseEpoch }
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
      assertNoLegacy(task.taskId)
      const key = text(a.key, 'key')
      const payload = { prompt: text(a.prompt, 'prompt'), input: a.input ?? {}, definition: a.definition ?? null, resourceKeys: a.resourceKeys ?? [] }
      const dispatchDigest = digest({ requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, ...payload })
      const prior = execs(task.taskId).find(item => item.key === key)
      if (prior) {
        if (prior.dispatchDigest !== dispatchDigest) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
        return changed({ execution: prior })
      }
      const executionId = a.executionId ?? randomUUID()
      if (get('dynamic_executions', executionId, true)) fail('DYNAMIC_EXECUTION_EXISTS')
      const execution = { id: executionId, executionId, taskId: task.taskId, key, ...clone(payload), dispatchDigest, inputDigest: digest(payload.input),
        requirementRevision: task.requirementRevision, controlRevision: task.controlRevision, sessionId: `task-execution-${randomUUID()}`,
        status: 'queued', inputVersion: 1, inputHistory: [], results: [], leaseEpoch: 0, sessionBound: false, drained: true, cancelRequested: false, createdAt: stamp, updatedAt: stamp }
      put('dynamic_executions', execution)
      return changed({ execution })
    }
    if (kind === 'execution.continue') {
      const task = currentTask(a.binding), execution = get('dynamic_executions', a.executionId)
      if (execution.taskId !== task.taskId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID')
      if (!execution.drained || execution.leaseEpoch === 0) fail('DYNAMIC_EXECUTION_BUSY')
      assertNoLegacy(task.taskId)
      if (a.definition?.recoveryReadOnly !== true && ops(task.taskId).some(item => item.executionId === execution.executionId && !terminalOperations.has(item.state))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      const key = text(a.key, 'key')
      const payload = { prompt: text(a.prompt, 'prompt'), input: a.input ?? {} }
      const continuationDigest = digest({ ...payload, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision })
      const previous = (execution.continuations ?? []).find(item => item.key === key)
      if (previous) {
        if (previous.digest !== continuationDigest) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
        return changed({ execution })
      }
      execution.inputHistory.push({ inputVersion: execution.inputVersion, inputDigest: execution.inputDigest,
        requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision })
      if (execution.result) execution.results.push(execution.result)
      execution.result = null; execution.inputVersion++; execution.inputDigest = digest(payload.input)
      execution.prompt = payload.prompt; execution.input = clone(payload.input)
      execution.definition = { ...execution.definition, recoveryReadOnly: a.definition?.recoveryReadOnly === true }
      execution.requirementRevision = task.requirementRevision; execution.controlRevision = task.controlRevision
      execution.cancelRequested = false; execution.status = 'queued'; execution.updatedAt = stamp
      execution.continuations = [...(execution.continuations ?? []), { key, digest: continuationDigest, inputVersion: execution.inputVersion }]
      put('dynamic_executions', execution); return changed({ execution })
    }
    if (kind === 'execution.claim') {
      const execution = get('dynamic_executions', a.executionId)
      assertNoLegacy(execution.taskId)
      if (!execution.drained || terminalExecutions.has(execution.status)) fail('DYNAMIC_EXECUTION_BUSY')
      if (!executionCurrent(execution)) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
      if (!execution.definition?.recoveryReadOnly && ops(execution.taskId).some(item => item.executionId === execution.executionId && ['starting','unknown'].includes(item.state))) fail('DYNAMIC_OPERATION_UNRESOLVED')
      execution.leaseEpoch++; execution.status = 'running'; execution.drained = false; execution.recovering = false
      execution.updatedAt = stamp; put('dynamic_executions', execution)
      return { result: { execution, binding: executionBinding(execution) }, dispatchEligible: true }
    }
    if (kind === 'execution.sessionBound' || kind === 'execution.drained' || kind === 'execution.result' || kind === 'execution.cancel') {
      const execution = kind === 'execution.cancel' && a.binding?.kind === 'task-session' ? (() => {
        const task = currentTask(a.binding, { active: false }); const item = get('dynamic_executions', a.executionId)
        if (item.taskId !== task.taskId) fail('DYNAMIC_EXECUTION_SCOPE_INVALID'); return item
      })() : boundExecution(a.binding)
      if (kind === 'execution.sessionBound') execution.sessionBound = true
      if (kind === 'execution.cancel') { execution.cancelRequested = true; if (execution.drained) execution.status = 'cancelled' }
      if (kind === 'execution.drained') {
        execution.drained = true; execution.recovering = false
        if (execution.cancelRequested && !terminalExecutions.has(execution.status)) execution.status = 'cancelled'
        else if (execution.status === 'running' && !execution.result) execution.status = 'queued'
      }
      if (kind === 'execution.result') {
        const payload = { output: a.output ?? null, error: a.error ?? null }
        if (execution.result && digest(execution.result.payload) !== digest(payload)) fail('DYNAMIC_EXECUTION_RESULT_CONFLICT')
        if (!execution.result) {
          const current = executionCurrent(execution)
          execution.result = { payload, current, requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
            leaseEpoch: execution.leaseEpoch, inputVersion: execution.inputVersion, receivedAt: stamp }
          execution.status = current ? a.error ? 'failed' : 'succeeded' : 'stale'
          wake(execution.taskId, 'execution.result', { executionId: execution.executionId, current }, `execution-result:${execution.executionId}:${execution.inputVersion}`)
        }
      }
      execution.updatedAt = stamp; put('dynamic_executions', execution)
      return changed({ execution, current: execution.result?.current ?? executionCurrent(execution) })
    }
    if (kind === 'operation.prepare') {
      const task = assertScope(a.binding)
      assertNoLegacy(task.taskId)
      const key = text(a.key, 'key'), definition = clone(record(a.definition))
      const resourceKeys = [...new Set(array(a.resourceKeys ?? []).map(value => text(value, 'resourceKey')))].sort()
      const specificationDigest = digest({ definition, resourceKeys, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision })
      const prior = ops(task.taskId).find(item => item.key === key)
      if (prior) {
        if (prior.specificationDigest !== specificationDigest) fail('DYNAMIC_OPERATION_KEY_CONFLICT')
        return changed({ operation: prior })
      }
      const operationId = a.operationId ?? randomUUID()
      if (get('dynamic_operations', operationId, true)) fail('DYNAMIC_OPERATION_EXISTS')
      const operation = { id: operationId, operationId, taskId: task.taskId, executionId: a.binding.executionId ?? null,
        key, definition, resourceKeys, specificationDigest, requirementRevision: task.requirementRevision, controlRevision: task.controlRevision,
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
      wake(operation.taskId, 'operation.not_dispatched', { operationId: operation.operationId }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.start') {
      const task = assertScope(a.binding), operation = get('dynamic_operations', a.operationId)
      if (operation.taskId !== task.taskId || operation.executionId !== (a.binding.executionId ?? null)
        || operation.requirementRevision !== task.requirementRevision || operation.controlRevision !== task.controlRevision) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      assertNoLegacy(task.taskId)
      if (operation.state !== 'prepared') return changed({ operation })
      // Native preflight is advisory: the final fence and transition must share one SQLite transaction.
      if (ops().some(item => item.state === 'unknown')) fail('DYNAMIC_OPERATION_UNRESOLVED')
      lock(operation.resourceKeys, operation.operationId)
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
    if (kind === 'operation.reconcile-stopped') {
      const task = currentTask(a.binding), operation = get('dynamic_operations', a.operationId), proof = record(a.proof)
      const execution = get('dynamic_executions', operation.executionId)
      if (operation.taskId !== task.taskId || operation.state !== 'unknown' || digest(operation) !== proof.operationDigest
        || proof.kind !== 'legacy-host-drained-partial' || proof.operationId !== operation.operationId
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
      operation.evidenceRef = `host-stopped-readback:${operation.operationId}:${digest(proof)}`
      operation.result = { reconciled: true, partialEffectsPossible: true, previousObservation, proof,
        instruction: 'The original operation was stopped and may have partial effects. Review the recorded readback before further work. This is not success or authorization to replay.' }
      put('dynamic_operations', operation); release(operation.operationId)
      wake(task.taskId, 'operation.reconciled', { operationId: operation.operationId, state: 'failed', partialEffectsPossible: true }, `wake:${commandId}`)
      return changed({ operation })
    }
    if (kind === 'operation.reconcile-job') {
      const task = currentTask(a.binding), operation = get('dynamic_operations', a.operationId)
      if (operation.taskId !== task.taskId) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      const job = operation.job, execution = get('dynamic_executions', operation.executionId)
      if (!execution.drained || execution.recovering || operation.state !== 'unknown' || !job || job.owner !== operation.ownerBinding.sessionId
        || !['completed','failed','killed'].includes(job.status) || !Number.isFinite(job.finishedAt)) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      operation.state = job.status === 'completed' ? 'succeeded' : 'failed'
      operation.result = { jobReceipt: clone(job), previousObservation: clone(operation.result ?? null), reconciled: true, partialEffectsPossible: job.status !== 'completed' }
      operation.evidenceRef = `native-job:${operation.operationId}:${digest(job)}`
      operation.updatedAt = stamp; put('dynamic_operations', operation); release(operation.operationId)
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
      if (terminalOperations.has(operation.state)) release(operation.operationId)
      wake(operation.taskId, 'operation.result', { operationId: operation.operationId, state: operation.state }, `wake:${commandId}`)
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
      const task = a.kind === 'topic-reply' ? null : get('dynamic_tasks', a.taskId), id = text(a.notificationId, 'notificationId')
      if (!['question','status','topic-reply'].includes(a.kind)) fail('DYNAMIC_ARGUMENT_INVALID', 'kind')
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
    if (kind === 'notification.retry') {
      const notification = get('dynamic_notifications', a.notificationId)
      const proof = notification.deliveryError?.phase === 'send' && quotedSendRejectionProof(notification.deliveryError, { groupId: notification.payload.conversationId, replyToMessageId: notification.payload.sourceMessageId, replyToSenderOpenDingTalkId: notification.payload.actorId, idempotencyKey: notification.id })
      if (notification.ack || notification.receipt || !proof || notification.state !== 'failed' || notification.deliveryError?.knownNotSent !== true || notification.deliveryError?.retryable !== true
        || Date.parse(notification.nextAttemptAt ?? '') > Date.now()) return changed({ notification })
      notification.state = 'prepared'; notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.ack' || kind === 'notification.diagnostic') {
      const notification = get('dynamic_notifications', a.notificationId)
      if (kind === 'notification.ack') {
        if (a.dispatchToken !== notification.dispatchToken || notification.state !== 'starting') fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
        notification.ack = clone(a.ack ?? null); notification.receipt = clone(a.ack ?? null)
      } else {
        if (!['unknown', 'starting'].includes(notification.state)) return changed({ notification })
        if (a.error) notification.lastReadbackError = clone(record(a.error))
        notification.readbackAttemptCount = (notification.readbackAttemptCount ?? 0) + 1
        notification.nextAttemptAt = text(a.nextAttemptAt, 'nextAttemptAt')
      }
      notification.updatedAt = stamp
      put('dynamic_notifications', notification); return changed({ notification })
    }
    if (kind === 'notification.start' || kind === 'notification.receipt' || kind === 'notification.delivered' || kind === 'notification.reconcile') {
      const notification = get('dynamic_notifications', a.notificationId)
      if (kind === 'notification.start') {
        if (notification.state !== 'prepared') return changed({ notification })
        const task = notification.kind === 'topic-reply' ? null : get('dynamic_tasks', notification.taskId)
        if (notification.kind === 'question' && (notification.requirementRevision !== task.requirementRevision || task.status !== 'active' || task.control !== 'active')) {
          notification.state = 'failed'; notification.reason = 'stale_question'; notification.updatedAt = stamp
          put('dynamic_notifications', notification); return changed({ notification })
        }
        assertNoLegacy(task?.taskId)
        notification.sendAttemptCount = (notification.sendAttemptCount ?? 0) + 1
        notification.state = 'starting'; notification.dispatchToken = randomUUID(); notification.updatedAt = stamp
        put('dynamic_notifications', notification); return { result: { notification }, dispatchEligible: true }
      }
      const state = kind === 'notification.delivered' ? 'delivered' : a.state
      if (!['delivered','failed','unknown'].includes(state)) fail('DYNAMIC_ARGUMENT_INVALID', 'state')
      if (kind === 'notification.reconcile') text(a.evidenceRef, 'evidenceRef')
      else if (a.dispatchToken !== notification.dispatchToken || notification.state !== 'starting') fail('DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED')
      if (['delivered','failed'].includes(notification.state)) return changed({ notification })
      if (a.phase === 'readback') notification.readbackAttemptCount = (notification.readbackAttemptCount ?? 0) + 1
      if (a.nextAttemptAt) notification.nextAttemptAt = text(a.nextAttemptAt, 'nextAttemptAt')
      if (state === 'delivered') notification.nextAttemptAt = null
      if (a.error) notification.deliveryError = clone(record(a.error))
      notification.state = state; notification.receipt = a.receipt ?? null; notification.evidenceRef = a.evidenceRef ?? null; notification.updatedAt = stamp
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
        timestamp: eventTimestamp, initialRouteDecision: a.routeDecision === undefined ? null : clone(record(a.routeDecision)) }
      if (revisionBasis) source.admissionSourceId = revisionBasis.sourceId
      if (a.requestIdentity !== undefined) source.requestIdentity = clone(record(a.requestIdentity))
      integer(source.version, 'version'); array(source.resources)
      // The enclosing command transaction durably records this negative receipt.
      // Rejected history must never enter the pending-source / group routing queue.
      if (epochGated && !eventTimestamp) return changed({ ignored: true, reason: 'invalid-ingress-timestamp', source: null })
      if (epochGated && Date.parse(eventTimestamp) < Date.parse(boundIngressEpoch)) return changed({ ignored: true, reason: 'before-ingress-epoch', source: null })
      if (prior) {
        const { routed: _routed, routeReceipt: _receipt, routeDecision: _decision, routePreparedAt: _prepared, ...previous } = prior
        if (digest(previous) !== digest(source)) fail('DYNAMIC_SOURCE_CONFLICT')
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
    if (kind === 'source.routed') {
      const source = get('dynamic_sources', a.sourceId)
      if (source.routed && digest(source.routeReceipt) !== digest(a.receipt)) fail('DYNAMIC_SOURCE_ROUTE_CONFLICT')
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
    async command(command) {
      record(command); const id = text(command.id, 'id'), kind = text(command.kind, 'kind'), args = record(command.args ?? {})
      const requestDigest = digest({ kind, args })
      return clone(transaction(() => {
        const previous = db.prepare('SELECT digest,body FROM dynamic_receipts WHERE id=?').get(id)
        if (previous) {
          if (previous.digest !== requestDigest) fail('DYNAMIC_COMMAND_ID_CONFLICT')
          return { ...JSON.parse(previous.body), replayed: true, dispatchEligible: false }
        }
        const value = { ...reduce(kind, args, id), replayed: false }
        db.prepare('INSERT INTO dynamic_receipts(id,digest,body) VALUES (?,?,?)').run(id, requestDigest, canonical(value))
        return value
      }))
    },
    async query(q) {
      if (closed) fail('DYNAMIC_STORE_CLOSED')
      record(q)
      let value
      if (q.kind === 'ingress.policy') value = { instanceId, ingressEpoch: boundIngressEpoch }
      else if (q.kind === 'task.get') value = get('dynamic_tasks', q.taskId, true)
      else if (q.kind === 'task.list') value = all('dynamic_tasks').filter(item => !q.groupId || item.groupId === q.groupId)
      else if (q.kind === 'task.blockers') value = blockers(q.taskId)
      else if (q.kind === 'task.binding') value = bindingOf(get('dynamic_tasks', q.taskId))
      else if (q.kind === 'execution.get') value = get('dynamic_executions', q.executionId, true)
      else if (q.kind === 'execution.list') value = q.taskId ? execs(q.taskId) : all('dynamic_executions')
      else if (q.kind === 'execution.binding') value = executionBinding(get('dynamic_executions', q.executionId))
      else if (q.kind === 'execution.current') { const e = boundExecution(q.binding); value = !e.drained && e.status === 'running' && executionCurrent(e) }
      else if (q.kind === 'operation.get') value = get('dynamic_operations', q.operationId, true)
      else if (q.kind === 'operation.list') value = ops(q.taskId)
      else if (q.kind === 'wake.list') value = wakes(q.taskId).filter(item => !q.state || item.state === q.state)
      else if (q.kind === 'notification.get') value = get('dynamic_notifications', q.notificationId, true)
      else if (q.kind === 'notification.list') value = all('dynamic_notifications').filter(item => (!q.taskId || item.taskId === q.taskId) && (!q.state || item.state === q.state))
      else if (q.kind === 'legacy.list') value = all('dynamic_legacy_blockers')
      else if (q.kind === 'resource.list') value = db.prepare('SELECT resource_key AS resourceKey,holder FROM dynamic_resource_locks ORDER BY resource_key').all()
      else if (q.kind === 'source.get') value = get('dynamic_sources', q.sourceId, true)
      else if (q.kind === 'source.list') value = all('dynamic_sources').filter(item => (!q.groupId || item.groupId === q.groupId) && (!q.unrouted || !item.routed) && (!q.status || (q.status === 'routed' ? !!item.routed : !item.routed)))
      else if (q.kind === 'group.get') value = get('dynamic_groups', q.groupId, true)
      else if (q.kind === 'group.list') value = all('dynamic_groups')
      else if (q.kind === 'receipt.get') { const row = db.prepare('SELECT body FROM dynamic_receipts WHERE id=?').get(q.id); value = row ? JSON.parse(row.body) : null }
      else if (q.kind === 'recovery.pending') value = { tasks: all('dynamic_tasks').filter(item => !item.drained),
        groups: all('dynamic_groups').filter(item => !item.drained), executions: all('dynamic_executions').filter(item => !item.drained || item.status === 'queued'),
        operations: ops().filter(item => !terminalOperations.has(item.state)), notifications: all('dynamic_notifications').filter(item => !['delivered','failed'].includes(item.state)), legacy: legacy() }
      else fail('DYNAMIC_QUERY_UNKNOWN', q.kind)
      return clone(value)
    },
    async close() {
      if (closed) return
      try { if (healthy) transaction(() => db.prepare('DELETE FROM dynamic_meta WHERE key=\'owner\' AND value=?').run(incarnation));
        else db.prepare("DELETE FROM dynamic_meta WHERE key='owner' AND value=?").run(incarnation) }
      finally { closed = true; db.close(); livePaths.delete(pathKey) }
    },
  })
}
