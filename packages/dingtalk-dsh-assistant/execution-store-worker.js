import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { installEffectsSchema, validateEffectsSchema, reduceEffectCommand, recoverEffects,
  queryEffects, assertRunEffectsDrained, assertNodeEffectsSettled } from './execution-effects.js'

import { installMessageSchema, validateMessageSchema, reduceMessageCommand, recoverMessages, queryMessages, assertMessageTaskUnfenced } from './message-ledger.js'
import { installTaskPlanSchema, validateTaskPlanSchema, reduceTaskPlanCommand, queryTaskPlan, bindRunToTaskStage } from './execution-task-plan.js'

const SCHEMA_VERSION = 2
const APPLICATION_ID = 0x44534845
let db, owner, healthy = true
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }) }
const scalar = row => Object.values(row)[0]
const serializeError = e => ({ code: e.code ?? 'STORE_ERROR', message: e.message, sqliteCode: e.errcode ?? null })
const text = (v, name) => { if (typeof v !== 'string' || !v.trim() || v.length > 4096) fail('INVALID_ARGUMENT', name); return v }
const integer = (v, name, minimum = 0) => { if (!Number.isSafeInteger(v) || v < minimum) fail('INVALID_ARGUMENT', name); return v }
const digest = (v, name) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('INVALID_DIGEST', name); return v }
function object(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('INVALID_ARGUMENT')
  return value
}
function ref(value, name) {
  text(value, name)
  if (isAbsolute(value) || /^[a-zA-Z]+:/.test(value) || value.split(/[\\/]/).some(p => p === '..' || p === '' || p === '.')) fail('INVALID_ARTIFACT_REF', name)
  return value
}
function refs(values) {
  if (!Array.isArray(values) || values.length > 128) fail('INVALID_EVIDENCE_REFS')
  values.forEach(v => ref(v, 'evidenceRef'))
  return values
}
function inputPair(value, required) {
  if (value.inputRef === null && value.inputDigest === null && !required) return
  ref(value.inputRef, 'inputRef'); digest(value.inputDigest, 'inputDigest')
}
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  fail('INVALID_ARGUMENT')
}
function runDto(r) {
  return r && { runId: r.run_id, taskId: r.task_id, workflowId: r.workflow_id, workflowDigest: r.workflow_digest,
    requirementRef: r.requirement_ref, revision: r.revision, generation: r.generation, status: r.status,
    stopRequested: !!r.stop_requested, pauseRequested: !!r.pause_requested, recoveryReason: r.recovery_reason, maxClaims: r.max_claims, claimCount: r.claim_count,
    createdAt: r.created_at, updatedAt: r.updated_at }
}
function nodeDto(n) {
  return { nodeRunId: n.node_run_id, runId: n.run_id, nodeId: n.node_id, nodeVersion: n.node_version,
    executor: n.executor, position: n.position, generation: n.generation, leaseEpoch: n.lease_epoch,
    inputRef: n.input_ref, inputDigest: n.input_digest, status: n.status, sessionId: n.session_id,
    sessionBound: !!n.session_bound, drained: !!n.drained, drainEvidenceRef: n.drain_evidence_ref,
    outputRef: n.output_ref, evidenceRefs: JSON.parse(n.evidence_refs), waitReason: n.wait_reason ? JSON.parse(n.wait_reason) : null }
}
const getRun = runId => { text(runId, 'runId'); const r = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(runId); if (!r) fail('RUN_NOT_FOUND'); return r }
const nodes = runId => db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(runId)
const pendingInputs = runId => db.prepare("SELECT * FROM execution_inputs WHERE run_id=? AND status='pending' ORDER BY seq").all(runId)
const terminalRun = r => ['succeeded', 'failed', 'cancelled'].includes(r.status)
function currentNode(a) {
  const n = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND node_id=? AND current=1').get(text(a.runId, 'runId'), text(a.nodeId, 'nodeId'))
  if (!n) fail('NODE_NOT_FOUND')
  if (n.generation !== integer(a.generation, 'generation', 1) || n.lease_epoch !== integer(a.leaseEpoch, 'leaseEpoch')) fail('NODE_STALE')
  return n
}
function activeRun(a, { allowFence = false, allowPause = false } = {}) {
  const r = getRun(a.runId)
  if (r.stop_requested || terminalRun(r)) fail('RUN_NOT_ACTIVE')
  if (r.pause_requested && !allowPause) fail('RUN_PAUSED')
  if (!allowFence) assertMessageTaskUnfenced(db, r.task_id)
  if (!allowFence && pendingInputs(r.run_id).length) fail('INPUT_PENDING')
  return r
}
function assertDispatchAllowed(a) {
  const r = activeRun(a)
  const n = currentNode(a)
  if (n.input_digest !== a.inputDigest || n.status !== 'running' || n.drained) fail('NODE_NOT_DISPATCHABLE')
  return { run: runDto(r), node: nodeDto(n) }
}
function emitEvent(commandId, kind, payload, now) {
  db.prepare('INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES(?,?,?,?)').run(commandId, kind, JSON.stringify(payload), now)
}
function context(commandId, now) {
  return { now, assertDispatchAllowed, emitEvent: (kind, payload) => emitEvent(commandId, kind, payload, now) }
}
function rollback(connection = db) { try { connection.exec('ROLLBACK') } catch { /* SQLite 错误可能已自动回滚。 */ } }

function install() {
  db.exec(`
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};
    CREATE TABLE execution_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL, safety_epoch INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,workflow_id TEXT NOT NULL,
      workflow_digest TEXT NOT NULL,requirement_ref TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),max_claims INTEGER NOT NULL CHECK(max_claims>0),
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count>=0 AND claim_count<=max_claims),
      status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','succeeded','failed','cancelling','cancelled')),
      stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),recovery_reason TEXT,
      pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id)
      WHERE status NOT IN ('succeeded','failed','cancelled');
    CREATE TABLE execution_nodes(node_run_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
      node_id TEXT NOT NULL,node_version TEXT NOT NULL,executor TEXT NOT NULL CHECK(executor IN ('code','agent','wait','operation')),
      position INTEGER NOT NULL CHECK(position>=0),generation INTEGER NOT NULL CHECK(generation>0),
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),current INTEGER NOT NULL DEFAULT 1 CHECK(current IN (0,1)),
      input_ref TEXT,input_digest TEXT,
      status TEXT NOT NULL CHECK(status IN ('blocked','ready','running','waiting','succeeded','failed','superseded','cancelled')),
      session_id TEXT,session_bound INTEGER NOT NULL DEFAULT 0 CHECK(session_bound IN (0,1)),
      drained INTEGER NOT NULL DEFAULT 1 CHECK(drained IN (0,1)),drain_evidence_ref TEXT,
      output_ref TEXT,evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),wait_reason TEXT,
      UNIQUE(run_id,node_id,generation),CHECK((input_ref IS NULL)=(input_digest IS NULL))) STRICT;
    CREATE UNIQUE INDEX execution_current_node ON execution_nodes(run_id,node_id) WHERE current=1;
    CREATE UNIQUE INDEX execution_current_position ON execution_nodes(run_id,position) WHERE current=1;
    CREATE UNIQUE INDEX execution_running_run ON execution_nodes(run_id) WHERE current=1 AND status='running';
    CREATE TABLE execution_inputs(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
      input_id TEXT NOT NULL,source_key TEXT NOT NULL,requirement_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','applied','ignored')),accepted_at TEXT NOT NULL,applied_at TEXT,
      UNIQUE(run_id,input_id),UNIQUE(run_id,source_key)) STRICT;
    CREATE TABLE execution_receipts(command_id TEXT PRIMARY KEY,payload_digest TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),created_at TEXT NOT NULL) STRICT;
    CREATE TABLE execution_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT,kind TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)),created_at TEXT NOT NULL) STRICT;
  `)
  db.prepare('INSERT INTO execution_meta(singleton,instance_id,schema_version) VALUES(1,?,?)').run(workerData.instanceId, SCHEMA_VERSION)
  installEffectsSchema(db)
  installMessageSchema(db)
  installTaskPlanSchema(db)
}
function validate(connection) {
  if (scalar(connection.prepare('PRAGMA application_id').get()) !== APPLICATION_ID) fail('STORE_APPLICATION_MISMATCH')
  if (scalar(connection.prepare('PRAGMA user_version').get()) !== SCHEMA_VERSION) fail('STORE_SCHEMA_MISMATCH')
  const meta = connection.prepare('SELECT instance_id,schema_version,safety_epoch FROM execution_meta WHERE singleton=1').get()
  if (!meta || meta.instance_id !== workerData.instanceId) fail('STORE_INSTANCE_MISMATCH')
  if (meta.schema_version !== SCHEMA_VERSION) fail('STORE_SCHEMA_MISMATCH')
  const integrity = connection.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || scalar(integrity[0]) !== 'ok') fail('STORE_INTEGRITY_FAILED')
  if (connection.prepare('PRAGMA foreign_key_check').all().length) fail('STORE_FOREIGN_KEY_FAILED')
  for (const sql of [
    'SELECT run_id,task_id,workflow_id,workflow_digest,requirement_ref,revision,generation,max_claims,claim_count,status,stop_requested,pause_requested,recovery_reason,created_at,updated_at FROM execution_runs LIMIT 0',
    'SELECT node_run_id,run_id,node_id,node_version,executor,position,generation,lease_epoch,current,input_ref,input_digest,status,session_id,session_bound,drained,drain_evidence_ref,output_ref,evidence_refs,wait_reason FROM execution_nodes LIMIT 0',
    'SELECT seq,run_id,input_id,source_key,requirement_ref,status,accepted_at,applied_at FROM execution_inputs LIMIT 0',
    'SELECT command_id,payload_digest,result,created_at FROM execution_receipts LIMIT 0',
    'SELECT seq,command_id,kind,payload,created_at FROM execution_events LIMIT 0',
  ]) connection.prepare(sql).all()
  const bad = connection.prepare(`SELECT node_run_id FROM execution_nodes WHERE
    (status IN ('ready','running') AND (input_ref IS NULL OR input_digest IS NULL))
    OR (session_bound=1 AND session_id IS NULL)
    OR (lease_epoch>0 AND drained=1 AND drain_evidence_ref IS NULL)`).all()
  // running+drained 在确认退出和提交结果之间是合法持久检查点。
  if (bad.length) fail('STORE_INVARIANT_FAILED')
  validateEffectsSchema(connection)
  validateMessageSchema(connection)
  validateTaskPlanSchema(connection)
}
function configure() {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;')
  const settings = { journalMode: scalar(db.prepare('PRAGMA journal_mode').get()),
    synchronous: scalar(db.prepare('PRAGMA synchronous').get()), foreignKeys: scalar(db.prepare('PRAGMA foreign_keys').get()) }
  if (settings.journalMode !== 'wal' || settings.synchronous !== 2 || settings.foreignKeys !== 1) fail('STORE_CONFIG_REJECTED')
  return settings
}
function recover() {
  const now = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    const active = db.prepare("SELECT node_run_id,run_id FROM execution_nodes WHERE current=1 AND status='running'").all()
    const reason = JSON.stringify({ kind: 'recovery', reference: 'controller-restarted' })
    db.prepare("UPDATE execution_nodes SET status='waiting',wait_reason=? WHERE current=1 AND status='running'").run(reason)
    for (const row of active) {
      db.prepare("UPDATE execution_runs SET status=CASE WHEN stop_requested=1 THEN 'cancelling' ELSE 'waiting' END,recovery_reason=CASE WHEN pause_requested=1 THEN recovery_reason ELSE 'controller-restarted' END,updated_at=? WHERE run_id=?").run(now, row.run_id)
      emitEvent(null, 'node.recovery', { nodeRunId: row.node_run_id }, now)
    }
    recoverEffects(db, context(null, now))
    recoverMessages(db)
    db.exec('COMMIT')
  } catch (cause) { rollback(); throw cause }
}

function addNode(runId, plan, position, generation, status) {
  db.prepare(`INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), runId, plan.nodeId, plan.nodeVersion, plan.executor, position, generation, plan.inputRef, plan.inputDigest, status)
}
function coreCommand(command, now) {
  const a = command.args
  if (command.kind === 'run.create') {
    object(a, ['runId', 'taskId', 'workflowId', 'workflowDigest', 'requirementRef', 'nodes', 'maxClaims', 'stageBinding'], ['runId', 'taskId', 'workflowId', 'workflowDigest', 'requirementRef', 'nodes'])
    for (const key of ['runId', 'taskId', 'workflowId']) text(a[key], key)
    digest(a.workflowDigest, 'workflowDigest'); ref(a.requirementRef, 'requirementRef')
    if (!Array.isArray(a.nodes) || !a.nodes.length || a.nodes.length > 128) fail('INVALID_NODE_PLAN')
    const ids = new Set()
    a.nodes.forEach((n, i) => {
      object(n, ['nodeId', 'nodeVersion', 'executor', 'inputRef', 'inputDigest'])
      text(n.nodeId, 'nodeId'); text(n.nodeVersion, 'nodeVersion')
      if (ids.has(n.nodeId) || !['code', 'agent', 'wait', 'operation'].includes(n.executor)) fail('INVALID_NODE_PLAN')
      ids.add(n.nodeId); inputPair(n, i === 0)
    })
    if (db.prepare('SELECT run_id FROM execution_runs WHERE run_id=?').get(a.runId)) fail('RUN_EXISTS')
    if (db.prepare("SELECT run_id FROM execution_runs WHERE task_id=? AND status NOT IN ('succeeded','failed','cancelled')").get(a.taskId)) fail('TASK_ALREADY_RUNNING')
    const plannedTask = db.prepare('SELECT task_id FROM business_tasks WHERE task_id=?').get(a.taskId)
    if (plannedTask && !a.stageBinding) fail('TASK_STAGE_BINDING_REQUIRED')
    if (!plannedTask && a.stageBinding) fail('TASK_PLAN_NOT_FOUND')
    if (a.stageBinding) bindRunToTaskStage(db, a.stageBinding, {
      taskId: a.taskId, runId: a.runId, workflowId: a.workflowId,
      workflowDigest: a.workflowDigest, requirementRef: a.requirementRef,
    })
    const maxClaims = integer(a.maxClaims ?? a.nodes.length * 3, 'maxClaims', 1)
    db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,max_claims,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)")
      .run(a.runId, a.taskId, a.workflowId, a.workflowDigest, a.requirementRef, maxClaims, now, now)
    a.nodes.forEach((n, i) => addNode(a.runId, n, i, 1, i === 0 ? 'ready' : 'blocked'))
    return { status: 'applied', run: runDto(getRun(a.runId)) }
  }
  if (command.kind === 'input.accept') {
    object(a, ['runId', 'inputId', 'sourceKey', 'requirementRef', 'expectedRevision'], ['runId', 'inputId', 'sourceKey', 'requirementRef'])
    text(a.inputId, 'inputId'); text(a.sourceKey, 'sourceKey'); ref(a.requirementRef, 'requirementRef')
    const old = db.prepare('SELECT * FROM execution_inputs WHERE run_id=? AND source_key=?').get(a.runId, a.sourceKey)
    if (old) {
      if (old.requirement_ref !== a.requirementRef) fail('INPUT_SOURCE_CONFLICT')
      return { status: 'applied', inputId: old.input_id, seq: old.seq, accepted: false }
    }
    const r = activeRun(a, { allowFence: true, allowPause: true })
    if (a.expectedRevision !== undefined && r.revision !== integer(a.expectedRevision, 'expectedRevision')) fail('REVISION_CONFLICT')
    if (a.expectedRevision !== undefined && pendingInputs(a.runId).length) fail('INPUT_PENDING')
    if (db.prepare('SELECT input_id FROM execution_inputs WHERE run_id=? AND input_id=?').get(a.runId, a.inputId)) fail('INPUT_ID_CONFLICT')
    const inserted = db.prepare("INSERT INTO execution_inputs(run_id,input_id,source_key,requirement_ref,status,accepted_at) VALUES(?,?,?,?,'pending',?)")
      .run(a.runId, a.inputId, a.sourceKey, a.requirementRef, now)
    return { status: 'applied', inputId: a.inputId, seq: Number(inserted.lastInsertRowid), accepted: true }
  }
  if (command.kind === 'input.apply') {
    object(a, ['runId', 'inputIds', 'expectedRevision', 'requirementRef', 'nodes'])
    ref(a.requirementRef, 'requirementRef')
    const r = activeRun(a, { allowFence: true })
    if (r.revision !== integer(a.expectedRevision, 'expectedRevision')) fail('REVISION_CONFLICT')
    const inputs = pendingInputs(r.run_id)
    if (!Array.isArray(a.inputIds) || !a.inputIds.length || a.inputIds.length > inputs.length
      || a.inputIds.some((id, i) => id !== inputs[i].input_id) || a.requirementRef !== inputs[a.inputIds.length - 1].requirement_ref) fail('INPUT_BATCH_CONFLICT')
    const current = nodes(r.run_id)
    if (!Array.isArray(a.nodes) || !a.nodes.length) fail('INVALID_NODE_PLAN')
    const first = current.findIndex(n => n.node_id === a.nodes[0].nodeId)
    if (first < 0 || a.nodes.length !== current.length - first || current.slice(0, first).some(n => n.status !== 'succeeded')) fail('INPUT_NODE_SUFFIX_REQUIRED')
    a.nodes.forEach((n, i) => {
      object(n, ['nodeId', 'inputRef', 'inputDigest'])
      if (n.nodeId !== current[first + i].node_id) fail('INPUT_NODE_SUFFIX_REQUIRED')
      inputPair(n, i === 0)
    })
    if (current.slice(first).some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    const generation = r.generation + 1
    for (let i = first; i < current.length; i++) {
      const n = current[i], replacement = a.nodes[i - first]
      db.prepare("UPDATE execution_nodes SET current=0,status='superseded' WHERE node_run_id=?").run(n.node_run_id)
      addNode(r.run_id, { nodeId: n.node_id, nodeVersion: n.node_version, executor: n.executor, ...replacement }, n.position, generation, i === first ? 'ready' : 'blocked')
    }
    for (const id of a.inputIds) db.prepare("UPDATE execution_inputs SET status='applied',applied_at=? WHERE run_id=? AND input_id=?").run(now, r.run_id, id)
    db.prepare("UPDATE execution_runs SET requirement_ref=?,revision=revision+1,generation=?,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.requirementRef, generation, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.pause') {
    object(a, ['runId', 'reason']); text(a.reason, 'reason')
    const r = activeRun(a, { allowFence: true, allowPause: true })
    if (!r.pause_requested) db.prepare("UPDATE execution_runs SET pause_requested=1,status='waiting',revision=revision+1,recovery_reason='pause_requested',updated_at=? WHERE run_id=?").run(now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.paused') {
    object(a, ['runId'])
    const r = getRun(a.runId)
    if (!r.pause_requested || r.stop_requested || terminalRun(r)) fail('RUN_NOT_PAUSING')
    if (nodes(r.run_id).some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET status='ready',wait_reason=NULL WHERE run_id=? AND current=1 AND (status='running' OR (status='waiting' AND json_extract(wait_reason,'$.reference')='controller-restarted'))").run(r.run_id)
    db.prepare("UPDATE execution_runs SET status='waiting',recovery_reason='user_pause',updated_at=? WHERE run_id=?").run(now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.resume') {
    object(a, ['runId'])
    const r = getRun(a.runId)
    if (!r.pause_requested || r.stop_requested || terminalRun(r) || r.recovery_reason !== 'user_pause') fail('RUN_NOT_USER_PAUSED')
    if (nodes(r.run_id).some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    const ready = nodes(r.run_id).some(n => n.status === 'ready')
    db.prepare('UPDATE execution_runs SET pause_requested=0,status=?,revision=revision+1,recovery_reason=?,updated_at=? WHERE run_id=?')
      .run(ready || pendingInputs(r.run_id).length ? 'queued' : 'waiting', ready ? null : 'recovery-required', now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.stop') {
    object(a, ['runId', 'reason'])
    text(a.reason, 'reason')
    const r = getRun(a.runId)
    if (terminalRun(r)) return { status: 'applied', run: runDto(r) }
    db.prepare("UPDATE execution_runs SET stop_requested=1,status='cancelling',revision=revision+1,recovery_reason=?,updated_at=? WHERE run_id=?").run(a.reason, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.stopped') {
    object(a, ['runId'])
    const r = getRun(a.runId)
    if (!r.stop_requested || r.status !== 'cancelling') fail('RUN_NOT_CANCELLING')
    if (nodes(r.run_id).some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET status='cancelled' WHERE run_id=? AND current=1 AND status NOT IN ('succeeded','failed')").run(r.run_id)
    db.prepare("UPDATE execution_inputs SET status='ignored',applied_at=? WHERE run_id=? AND status='pending'").run(now, r.run_id)
    db.prepare("UPDATE execution_runs SET status='cancelled',updated_at=? WHERE run_id=?").run(now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.recover') {
    object(a, ['runId'])
    const r = activeRun(a)
    if (r.claim_count >= r.max_claims) fail('EXECUTION_BUDGET_EXHAUSTED')
    const recovering = nodes(r.run_id).filter(n => n.status === 'waiting' && n.wait_reason && JSON.parse(n.wait_reason).kind === 'recovery')
    if (!recovering.length) fail('RUN_NOT_RECOVERING')
    if (recovering.some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    for (const n of recovering) {
      const exhausted = JSON.parse(n.wait_reason).reference === 'EXECUTION_BUDGET_EXHAUSTED'
      db.prepare("UPDATE execution_nodes SET status='ready',wait_reason=NULL,lease_epoch=lease_epoch+? WHERE node_run_id=?")
        .run(exhausted ? 1 : 0, n.node_run_id)
    }
    db.prepare("UPDATE execution_runs SET status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?").run(now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.migrate-index') {
    object(a, ['runId', 'expectedRevision', 'fromDigest', 'toDigest', 'nodeRunId', 'inputRef', 'inputDigest'])
    digest(a.fromDigest, 'fromDigest'); digest(a.toDigest, 'toDigest'); ref(a.inputRef, 'inputRef'); digest(a.inputDigest, 'inputDigest')
    const r = activeRun(a)
    if (r.revision !== integer(a.expectedRevision, 'expectedRevision') || r.workflow_digest !== a.fromDigest || a.fromDigest === a.toDigest) fail('WORKFLOW_MIGRATION_CONFLICT')
    const current = nodes(r.run_id), index = current.findIndex(n => n.node_id === 'index-files')
    if (index < 0 || current[index].node_run_id !== a.nodeRunId || current[index].node_version !== '1'
      || current[index].status !== 'waiting' || !current[index].drained || current[index].executor !== 'code'
      || !['ENGINEERING_INDEX_CAPACITY_EXCEEDED', 'controller-restarted'].includes(JSON.parse(current[index].wait_reason ?? 'null')?.reference)
      || current.slice(0, index).some(n => n.status !== 'succeeded') || current.slice(index + 1).some(n => n.status !== 'blocked' || n.lease_epoch !== 0)
      || current.find(n => n.node_id === 'select-files')?.node_version !== '1'
      || current.find(n => n.node_id === 'validate-selection')?.node_version !== '1') fail('WORKFLOW_MIGRATION_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET node_version='2',input_ref=?,input_digest=?,status='ready',wait_reason=NULL WHERE node_run_id=?")
      .run(a.inputRef, a.inputDigest, a.nodeRunId)
    db.prepare("UPDATE execution_nodes SET node_version='2' WHERE run_id=? AND current=1 AND node_id IN ('select-files','validate-selection','read-files')").run(r.run_id)
    db.prepare("UPDATE execution_runs SET workflow_digest=?,revision=revision+1,max_claims=max_claims+?,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toDigest, r.claim_count >= r.max_claims ? current.length * 3 : 0, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.migrate-read') {
    object(a, ['runId', 'expectedRevision', 'fromDigest', 'toDigest', 'nodeRunId', 'inputRef', 'inputDigest'])
    digest(a.fromDigest, 'fromDigest'); digest(a.toDigest, 'toDigest'); ref(a.inputRef, 'inputRef'); digest(a.inputDigest, 'inputDigest')
    if (command.id !== `migrate-read:${a.runId}:${a.toDigest}`) fail('WORKFLOW_MIGRATION_COMMAND_INVALID')
    const r = activeRun(a), current = nodes(r.run_id), index = current.findIndex(n => n.node_id === 'read-files')
    if (r.revision !== integer(a.expectedRevision, 'expectedRevision') || r.workflow_digest !== a.fromDigest || a.fromDigest === a.toDigest
      || index < 0 || current[index].node_run_id !== a.nodeRunId || current[index].node_version !== '1'
      || current[index].status !== 'waiting' || !current[index].drained || current[index].executor !== 'code'
      || !['controller-restarted', 'TASK_CONTEXT_TOO_LARGE'].includes(JSON.parse(current[index].wait_reason ?? 'null')?.reference)
      || current.slice(0, index).some(n => n.status !== 'succeeded')
      || current.slice(index + 1).some(n => n.status !== 'blocked' || n.lease_epoch !== 0)
      || pendingInputs(r.run_id).length) fail('WORKFLOW_MIGRATION_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET node_version='2',input_ref=?,input_digest=?,status='ready',wait_reason=NULL WHERE node_run_id=?")
      .run(a.inputRef, a.inputDigest, a.nodeRunId)
    db.prepare("UPDATE execution_runs SET workflow_digest=?,revision=revision+1,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toDigest, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.index-budget') {
    object(a, ['runId', 'workflowDigest'])
    digest(a.workflowDigest, 'workflowDigest')
    if (command.id !== `index-budget:${a.runId}:${a.workflowDigest}`) fail('WORKFLOW_BUDGET_COMMAND_INVALID')
    const r = activeRun(a), current = nodes(r.run_id), index = current.findIndex(n => n.node_id === 'index-files')
    const migrated = db.prepare('SELECT command_id FROM execution_receipts WHERE command_id=?').get(`migrate-index:${a.runId}:${a.workflowDigest}`)
    if (!migrated || r.workflow_digest !== a.workflowDigest || r.claim_count !== r.max_claims || index < 0
      || current[index].node_version !== '2' || current[index].status !== 'waiting' || !current[index].drained
      || JSON.parse(current[index].wait_reason ?? 'null')?.reference !== 'EXECUTION_BUDGET_EXHAUSTED'
      || current.slice(0, index).some(n => n.status !== 'succeeded') || current.slice(index + 1).some(n => n.status !== 'blocked' || n.lease_epoch !== 0)) fail('WORKFLOW_BUDGET_EXTENSION_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    // 预算耗尽的领取命令已有持久回执；推进代次，避免下次领取复用其命令 ID。
    db.prepare("UPDATE execution_nodes SET lease_epoch=lease_epoch+1,status='ready',wait_reason=NULL WHERE node_run_id=?").run(current[index].node_run_id)
    db.prepare("UPDATE execution_runs SET max_claims=max_claims+?,revision=revision+1,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(current.length * 3, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.index-budget-lease') {
    object(a, ['runId', 'workflowDigest'])
    digest(a.workflowDigest, 'workflowDigest')
    if (command.id !== `index-budget-lease:${a.runId}:${a.workflowDigest}`) fail('WORKFLOW_BUDGET_COMMAND_INVALID')
    const r = activeRun(a), current = nodes(r.run_id), index = current.findIndex(n => n.node_id === 'index-files')
    const budget = db.prepare('SELECT result FROM execution_receipts WHERE command_id=?').get(`index-budget:${a.runId}:${a.workflowDigest}`)
    const node = current[index]
    const staleClaim = node && db.prepare('SELECT result FROM execution_receipts WHERE command_id=?')
      .get(`claim:${node.node_run_id}:${node.lease_epoch + 1}`)
    if (!budget || JSON.parse(budget.result)?.status !== 'applied' || !node || r.workflow_digest !== a.workflowDigest
      || r.status !== 'queued' || r.claim_count >= r.max_claims || node.node_version !== '2' || node.status !== 'ready' || !node.drained
      || JSON.parse(staleClaim?.result ?? 'null')?.status !== 'budget_exhausted'
      || current.slice(0, index).some(n => n.status !== 'succeeded') || current.slice(index + 1).some(n => n.status !== 'blocked' || n.lease_epoch !== 0)) fail('WORKFLOW_BUDGET_LEASE_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare('UPDATE execution_nodes SET lease_epoch=lease_epoch+1 WHERE node_run_id=?').run(node.node_run_id)
    db.prepare('UPDATE execution_runs SET revision=revision+1,updated_at=? WHERE run_id=?').run(now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.replan-direct') {
    object(a, ['runId', 'expectedRevision', 'fromDigest', 'toDigest', 'inputRef', 'inputDigest', 'nodes'])
    digest(a.fromDigest, 'fromDigest'); digest(a.toDigest, 'toDigest'); ref(a.inputRef, 'inputRef'); digest(a.inputDigest, 'inputDigest')
    if (command.id !== `replan-direct:${a.runId}:${a.toDigest}`) fail('WORKFLOW_MIGRATION_COMMAND_INVALID')
    const r = activeRun(a), current = nodes(r.run_id)
    if (r.revision !== integer(a.expectedRevision, 'expectedRevision') || r.generation !== 1 || r.workflow_digest !== a.fromDigest || a.fromDigest === a.toDigest
      || current.length < 4 || current[0].node_id !== 'prepare-generation' || current[1].node_id !== 'prepare-workspace'
      || current.slice(0, 2).some(n => n.status !== 'succeeded') || current.slice(2).some(n => !n.drained)
      || !current.some(n => n.status === 'waiting' && JSON.parse(n.wait_reason ?? 'null')?.reference === 'EDIT_PREPARED_INVALID')
      || pendingInputs(r.run_id).length) fail('WORKFLOW_MIGRATION_UNSAFE')
    if (!Array.isArray(a.nodes) || a.nodes.length < 4 || a.nodes.length > 32
      || a.nodes[0]?.nodeId !== 'prepare-generation' || a.nodes[1]?.nodeId !== 'prepare-workspace'
      || a.nodes[2]?.nodeId !== 'inspect-and-propose') fail('INVALID_NODE_PLAN')
    a.nodes.forEach((node, index) => {
      object(node, ['nodeId', 'nodeVersion', 'executor', 'inputRef', 'inputDigest'])
      text(node.nodeId, 'nodeId'); text(node.nodeVersion, 'nodeVersion')
      if (!['code', 'agent'].includes(node.executor) || (index === 0) !== (node.inputRef !== null)) fail('INVALID_NODE_PLAN')
      inputPair(node, index === 0)
    })
    if (a.nodes[0].inputRef !== a.inputRef || a.nodes[0].inputDigest !== a.inputDigest
      || !db.prepare('SELECT digest FROM message_workflows WHERE digest=?').get(a.toDigest)
      || new Set(a.nodes.map(node => node.nodeId)).size !== a.nodes.length
      || db.prepare("SELECT effect_id FROM execution_effects WHERE run_id=? AND node_id<>'prepare-workspace' LIMIT 1").get(r.run_id)) fail('WORKFLOW_MIGRATION_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET current=0,status='superseded' WHERE run_id=? AND current=1").run(r.run_id)
    a.nodes.forEach((node, index) => addNode(r.run_id, node, index, r.generation + 1, index === 0 ? 'ready' : 'blocked'))
    // 单次迁移补足新节点的领取次数，仍保留有限上限与原始 claim_count。
    db.prepare("UPDATE execution_runs SET workflow_digest=?,revision=revision+1,generation=generation+1,max_claims=max_claims+?,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toDigest, a.nodes.length * 3, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'run.workflow.reissue-repository') {
    object(a, ['runId', 'expectedRevision', 'fromDigest', 'toDigest', 'toWorkflowId', 'requirementRef', 'inputRef', 'inputDigest', 'nodes'])
    digest(a.fromDigest, 'fromDigest'); digest(a.toDigest, 'toDigest'); text(a.toWorkflowId, 'toWorkflowId')
    ref(a.requirementRef, 'requirementRef'); ref(a.inputRef, 'inputRef'); digest(a.inputDigest, 'inputDigest')
    if (command.id !== `reissue-repository:${a.runId}:${a.toDigest}`) fail('WORKFLOW_MIGRATION_COMMAND_INVALID')
    const r = activeRun(a), current = nodes(r.run_id)
    const oldRecord = db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(a.fromDigest)
    const nextRecord = db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(a.toDigest)
    const oldConfig = oldRecord && JSON.parse(oldRecord.body).config, nextConfig = nextRecord && JSON.parse(nextRecord.body).config
    const apply = current.find(n => n.node_id === 'apply-changes'), inspect = current.find(n => n.node_id === 'inspect-and-propose')
    if (r.status !== 'waiting' || r.revision !== integer(a.expectedRevision, 'expectedRevision')
      || r.workflow_digest !== a.fromDigest || a.fromDigest === a.toDigest || r.workflow_id === a.toWorkflowId
      || !oldConfig || !nextConfig || oldConfig.kind !== 'engineering' || nextConfig.kind !== 'engineering'
      || oldConfig.runId !== r.run_id || nextConfig.runId !== r.run_id || oldConfig.taskId !== r.task_id || nextConfig.taskId !== r.task_id
      || (oldConfig.repoId === nextConfig.repoId && (!['6', '7'].includes(JSON.parse(oldRecord.body).definitionVersion)
        || JSON.parse(nextRecord.body).definitionVersion !== '8'
        || JSON.parse(apply?.wait_reason ?? 'null')?.reference !== 'ENGINEERING_NO_CHANGES_PROPOSED'))
      || oldConfig.ownerActorId !== nextConfig.ownerActorId
      || oldConfig.sourceCommandId !== nextConfig.sourceCommandId || !inspect || inspect.status !== 'succeeded'
      || !apply || apply.status !== 'waiting' || !['ENGINEERING_EDIT_SCOPE_MISMATCH', 'ENGINEERING_NO_CHANGES_PROPOSED'].includes(JSON.parse(apply.wait_reason ?? 'null')?.reference)
      || current.some(n => !n.drained) || pendingInputs(r.run_id).length
      || db.prepare("SELECT effect_id FROM execution_effects WHERE run_id=? AND node_id<>'prepare-workspace' LIMIT 1").get(r.run_id)) fail('WORKFLOW_REISSUE_UNSAFE')
    if (!Array.isArray(a.nodes) || a.nodes.length < 4 || a.nodes.length > 32
      || a.nodes[0]?.nodeId !== 'prepare-generation' || a.nodes[1]?.nodeId !== 'prepare-workspace'
      || a.nodes[2]?.nodeId !== 'inspect-and-propose' || new Set(a.nodes.map(node => node.nodeId)).size !== a.nodes.length) fail('INVALID_NODE_PLAN')
    a.nodes.forEach((node, index) => {
      object(node, ['nodeId', 'nodeVersion', 'executor', 'inputRef', 'inputDigest'])
      text(node.nodeId, 'nodeId'); text(node.nodeVersion, 'nodeVersion')
      if (!['code', 'agent'].includes(node.executor) || (index === 0) !== (node.inputRef !== null)) fail('INVALID_NODE_PLAN')
      inputPair(node, index === 0)
    })
    if (a.nodes[0].inputRef !== a.inputRef || a.nodes[0].inputDigest !== a.inputDigest
      || JSON.parse(nextRecord.body).workflowId !== a.toWorkflowId) fail('WORKFLOW_REISSUE_UNSAFE')
    assertRunEffectsDrained(db, r.run_id)
    db.prepare("UPDATE execution_nodes SET current=0,status='superseded' WHERE run_id=? AND current=1").run(r.run_id)
    a.nodes.forEach((node, index) => addNode(r.run_id, node, index, r.generation + 1, index === 0 ? 'ready' : 'blocked'))
    db.prepare("UPDATE execution_runs SET workflow_id=?,workflow_digest=?,requirement_ref=?,revision=revision+1,generation=generation+1,max_claims=max_claims+?,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toWorkflowId, a.toDigest, a.requirementRef, a.nodes.length * 3, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'node.claim') {
    object(a, ['runId', 'nodeId', 'expectedGeneration', 'expectedLeaseEpoch'])
    const r = activeRun(a)
    const n = currentNode({ ...a, generation: a.expectedGeneration, leaseEpoch: a.expectedLeaseEpoch })
    if (n.status !== 'ready' || !n.drained || !n.input_ref || !n.input_digest) fail('NODE_NOT_READY')
    if (nodes(r.run_id).some(other => other.position < n.position && other.status !== 'succeeded')) fail('NODE_PREDECESSOR_INCOMPLETE')
    if (r.claim_count >= r.max_claims) {
      const waitReason = { kind: 'recovery', reference: 'EXECUTION_BUDGET_EXHAUSTED' }
      db.prepare("UPDATE execution_nodes SET status='waiting',wait_reason=? WHERE node_run_id=?").run(JSON.stringify(waitReason), n.node_run_id)
      db.prepare("UPDATE execution_runs SET status='waiting',recovery_reason='EXECUTION_BUDGET_EXHAUSTED',updated_at=? WHERE run_id=?").run(now, r.run_id)
      return { status: 'budget_exhausted', run: runDto(getRun(r.run_id)) }
    }
    const sessionId = n.executor === 'agent' ? (n.session_id ?? randomUUID()) : null
    db.prepare("UPDATE execution_nodes SET status='running',lease_epoch=lease_epoch+1,session_id=?,drained=0,drain_evidence_ref=NULL WHERE node_run_id=?").run(sessionId, n.node_run_id)
    db.prepare("UPDATE execution_runs SET status='running',claim_count=claim_count+1,updated_at=? WHERE run_id=?").run(now, r.run_id)
    return { status: 'applied', binding: nodeDto(db.prepare('SELECT * FROM execution_nodes WHERE node_run_id=?').get(n.node_run_id)), runRevision: r.revision }
  }
  if (command.kind === 'node.sessionBound') {
    object(a, ['runId', 'nodeId', 'generation', 'leaseEpoch', 'sessionId'])
    activeRun(a, { allowFence: true })
    const n = currentNode(a)
    if (n.executor !== 'agent' || n.status !== 'running' || n.drained || n.session_id !== a.sessionId) fail('SESSION_BINDING_CONFLICT')
    db.prepare('UPDATE execution_nodes SET session_bound=1 WHERE node_run_id=?').run(n.node_run_id)
    return { status: 'applied' }
  }
  if (command.kind === 'node.drained') {
    object(a, ['runId', 'nodeId', 'generation', 'leaseEpoch', 'evidenceRef'])
    ref(a.evidenceRef, 'evidenceRef')
    const n = currentNode(a)
    if (n.lease_epoch === 0) fail('NODE_NOT_CLAIMED')
    if (n.drained && n.drain_evidence_ref !== a.evidenceRef) fail('DRAIN_EVIDENCE_CONFLICT')
    db.prepare('UPDATE execution_nodes SET drained=1,drain_evidence_ref=? WHERE node_run_id=?').run(a.evidenceRef, n.node_run_id)
    return { status: 'applied' }
  }
  if (command.kind === 'node.commit') {
    object(a, ['runId', 'nodeId', 'generation', 'leaseEpoch', 'inputDigest', 'outcome', 'outputRef', 'evidenceRefs', 'waitReason', 'nextInput'],
      ['runId', 'nodeId', 'generation', 'leaseEpoch', 'inputDigest', 'outcome', 'evidenceRefs'])
    const r = activeRun(a), n = currentNode(a)
    digest(a.inputDigest, 'inputDigest'); refs(a.evidenceRefs)
    if (!['succeeded', 'waiting', 'failed'].includes(a.outcome)) fail('INVALID_NODE_OUTCOME')
    if (n.status !== 'running' || n.input_digest !== a.inputDigest) fail('NODE_STALE')
    if (!n.drained) fail('NODE_NOT_DRAINED')
    if (a.outcome === 'succeeded' && n.executor === 'agent' && !n.session_bound) fail('SESSION_NOT_BOUND')
    if (a.outputRef !== undefined) ref(a.outputRef, 'outputRef')
    if (a.outcome === 'succeeded') {
      ref(a.outputRef, 'outputRef')
      if (a.waitReason !== undefined) fail('INVALID_WAIT_REASON')
      assertNodeEffectsSettled(db, { runId: r.run_id, nodeRunId: n.node_run_id })
    } else {
      object(a.waitReason, ['kind', 'reference'])
      if (!['input', 'external', 'approval', 'retry', 'recovery'].includes(a.waitReason.kind)) fail('INVALID_WAIT_REASON')
      text(a.waitReason.reference, 'waitReason.reference')
      if (a.nextInput !== undefined) fail('UNEXPECTED_NEXT_INPUT')
    }
    const next = nodes(r.run_id).find(other => other.position === n.position + 1)
    if (a.outcome === 'succeeded' && next) {
      object(a.nextInput, ['nodeId', 'inputRef', 'inputDigest'])
      if (a.nextInput.nodeId !== next.node_id || next.status !== 'blocked') fail('NEXT_NODE_CONFLICT')
      inputPair(a.nextInput, true)
      db.prepare("UPDATE execution_nodes SET input_ref=?,input_digest=?,status='ready' WHERE node_run_id=?").run(a.nextInput.inputRef, a.nextInput.inputDigest, next.node_run_id)
    } else if (a.outcome === 'succeeded' && a.nextInput !== undefined) fail('UNEXPECTED_NEXT_INPUT')
    if ((a.outcome === 'succeeded' && !next) || a.outcome === 'failed') assertRunEffectsDrained(db, r.run_id)
    db.prepare('UPDATE execution_nodes SET status=?,output_ref=?,evidence_refs=?,wait_reason=? WHERE node_run_id=?')
      .run(a.outcome, a.outputRef ?? null, JSON.stringify(a.evidenceRefs), a.waitReason ? JSON.stringify(a.waitReason) : null, n.node_run_id)
    const status = a.outcome === 'succeeded' ? (next ? 'queued' : 'succeeded') : a.outcome
    db.prepare('UPDATE execution_runs SET status=?,updated_at=? WHERE run_id=?').run(status, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  return null
}

function command(value) {
  if (!healthy) fail('STORE_UNAVAILABLE')
  object(value, ['id', 'kind', 'args'])
  text(value.id, 'command.id'); text(value.kind, 'command.kind')
  if (!value.args || Object.getPrototypeOf(value.args) !== Object.prototype) fail('INVALID_ARGUMENT')
  const hash = createHash('sha256').update(canonical({ kind: value.kind, args: value.args })).digest('hex')
  const now = new Date().toISOString()
  try {
    db.exec('BEGIN IMMEDIATE')
    const prior = db.prepare('SELECT * FROM execution_receipts WHERE command_id=?').get(value.id)
    if (prior) {
      if (prior.payload_digest !== hash) fail('COMMAND_ID_CONFLICT')
      db.exec('COMMIT')
      return { replayed: true, dispatchEligible: false, result: JSON.parse(prior.result) }
    }
    const core = coreCommand(value, now)
    const plan = core === null ? reduceTaskPlanCommand(db, value, context(value.id, now)) : null
    const effect = core === null && plan === null
      ? (reduceMessageCommand(db, value, context(value.id, now)) ?? reduceEffectCommand(db, value, context(value.id, now))) : null
    if (core === null && plan === null && effect === null) fail('UNKNOWN_COMMAND')
    const result = core ?? plan ?? effect.result
    db.prepare('INSERT INTO execution_receipts(command_id,payload_digest,result,created_at) VALUES(?,?,?,?)').run(value.id, hash, JSON.stringify(result), now)
    emitEvent(value.id, value.kind, result, now)
    db.exec('COMMIT')
    return { replayed: false, dispatchEligible: effect?.dispatchEligible === true, result }
  } catch (cause) {
    rollback()
    if (cause.code === 'ERR_SQLITE_ERROR') healthy = false
    throw cause
  }
}
function query(value) {
  if (value?.kind === 'run.list') {
    const limit = integer(value.limit ?? 100, 'limit', 1); if (limit > 200) fail('INVALID_ARGUMENT')
    const before = integer(value.beforeSequenceId ?? Number.MAX_SAFE_INTEGER, 'beforeSequenceId', 1)
    if (value.activeOnly !== undefined && typeof value.activeOnly !== 'boolean') fail('INVALID_ARGUMENT')
    return db.prepare("SELECT rowid AS sequence_id,* FROM execution_runs WHERE rowid<? AND (? IS NULL OR task_id=?) AND (?=0 OR (status NOT IN ('succeeded','failed','cancelled') AND pause_requested=0)) ORDER BY rowid DESC LIMIT ?")
      .all(before, value.taskId ? text(value.taskId, 'taskId') : null, value.taskId ?? null, value.activeOnly ? 1 : 0, limit)
      .map(row => ({ ...runDto(row), sequenceId: row.sequence_id }))
  }
  if (value?.kind === 'run') {
    object(value, ['kind', 'runId', 'includeHistory'], ['kind', 'runId'])
    if (value.includeHistory !== undefined && typeof value.includeHistory !== 'boolean') fail('INVALID_ARGUMENT')
    text(value.runId, 'runId')
    const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(value.runId)
    const inputs = db.prepare('SELECT * FROM execution_inputs WHERE run_id=? ORDER BY seq').all(value.runId).map(i => ({
      inputId: i.input_id, sourceKey: i.source_key, requirementRef: i.requirement_ref, seq: i.seq, status: i.status,
      acceptedAt: i.accepted_at, appliedAt: i.applied_at,
    }))
    return { run: runDto(run) ?? null, nodes: nodes(value.runId).map(nodeDto), inputs,
      pendingInputCount: inputs.filter(i => i.status === 'pending').length,
      ...(value.includeHistory ? { nodeHistory: db.prepare('SELECT * FROM execution_nodes WHERE run_id=? ORDER BY generation,position').all(value.runId).map(nodeDto) } : {}) }
  }
  if (value?.kind === 'receipt') {
    object(value, ['kind', 'commandId']); text(value.commandId, 'commandId')
    const r = db.prepare('SELECT result FROM execution_receipts WHERE command_id=?').get(value.commandId)
    return r ? { replayed: true, dispatchEligible: false, result: JSON.parse(r.result) } : null
  }
  const planResult = queryTaskPlan(db, value)
  if (planResult !== undefined) return planResult
  const messageResult = queryMessages(db, value)
  if (messageResult !== undefined) return messageResult
  const result = queryEffects(db, value)
  if (result === null || result === undefined) fail('UNKNOWN_QUERY')
  return result
}

try {
  const requestedPath = resolve(workerData.dbPath)
  const dbPath = existsSync(requestedPath) ? realpathSync(requestedPath) : join(realpathSync(dirname(requestedPath)), basename(requestedPath))
  if (!workerData.initialize && (!existsSync(dbPath) || !statSync(dbPath).isFile() || statSync(dbPath).size === 0)) fail('STORE_DATABASE_MISSING')
  // 独立 SQLite 文件持有 OS 文件锁；控制库仍能正常逐事务 COMMIT。
  // 不删除锁文件、不靠 PID/端口。恶意替换锁文件不属于同实例合作进程保护范围。
  try {
    owner = new DatabaseSync(dbPath + '.owner.sqlite')
    owner.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;')
  } catch (cause) {
    if (cause.errcode === 5 || cause.errcode === 6) fail('STORE_OWNER_LOCKED')
    throw cause
  }
  if (workerData.initialize) {
    closeSync(openSync(dbPath, 'wx'))
    db = new DatabaseSync(dbPath)
    configure()
    db.exec('BEGIN IMMEDIATE')
    try { install(); db.exec('COMMIT') } catch (cause) { rollback(); throw cause }
  } else {
    const readOnly = new DatabaseSync(dbPath, { readOnly: true })
    try { validate(readOnly) } finally { readOnly.close() }
    db = new DatabaseSync(dbPath)
    validate(db)
  }
  const settings = configure()
  validate(db)
  recover()
  parentPort.postMessage({ type: 'ready', info: { dbPath, instanceId: workerData.instanceId, schemaVersion: SCHEMA_VERSION,
    ...settings, lockStrategy: 'separate-sqlite-begin-exclusive', execPath: process.execPath,
    nodeVersion: process.version, sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version } })
  parentPort.on('message', request => {
    try {
      let value
      if (request.action === 'command') value = command(request.value)
      else if (request.action === 'query') value = query(request.value)
      else if (request.action === 'close') {
        db.close(); rollback(owner); owner.close(); value = { closed: true }
      } else fail('INVALID_REQUEST')
      parentPort.postMessage({ type: 'response', requestId: request.requestId, value })
      if (request.action === 'close') parentPort.close()
    } catch (cause) {
      if (cause.code === 'ERR_SQLITE_ERROR') healthy = false
      parentPort.postMessage({ type: 'response', requestId: request.requestId, error: serializeError(cause), unhealthy: !healthy })
    }
  })
} catch (cause) {
  try { db?.close() } catch { /* 保留启动原错误。 */ }
  try { owner?.close() } catch { /* OS 锁随连接/进程结束释放。 */ }
  parentPort.postMessage({ type: 'fatal', error: serializeError(cause) })
  parentPort.close()
}
