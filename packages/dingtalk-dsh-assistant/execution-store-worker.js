import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { maintenanceStatus, assertMaintenanceDispatch, reduceMaintenanceCommand } from './execution-maintenance.js'
import { installEffectsSchema, validateEffectsSchema, reduceEffectCommand, recoverEffects,
  queryEffects, assertRunEffectsDrained, assertNodeEffectsSettled } from './execution-effects.js'

import { installMessageSchema, validateMessageSchema, reduceMessageCommand, recoverMessages, queryMessages, assertMessageTaskUnfenced, registerMessageAcceptance, isBusinessTaskTerminal, readCurrentTaskSource } from './message-ledger.js'
import { installTaskPlanSchema, validateTaskPlanSchema, reduceTaskPlanCommand, queryTaskPlan, bindRunToTaskStage } from './execution-task-plan.js'
import { installTaskOwnerSchema, validateTaskOwnerSchema, reduceTaskOwnerCommand,
  queryTaskOwner, recoverTaskOwners } from './task-owner-store.js'
import { transientRecoveryReasons, recoveryRetryDelayMs } from './execution-recovery-policy.js'
import { acceptanceCriteriaSchema } from './task-input-contract.js'
import { executionDigest, parseArtifactReference } from './execution-artifacts.js'

const SCHEMA_VERSION = 8
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
    stopRequested: !!r.stop_requested, pauseRequested: !!r.pause_requested, recoveryReason: r.recovery_reason, claimCount: r.claim_count,
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
function nodeInputHistory(nodeRunId) {
  const row = db.prepare("SELECT payload FROM execution_events WHERE kind='node.continue' AND json_extract(payload,'$.nodeRunId')=? ORDER BY seq DESC LIMIT 1").get(nodeRunId)
  return row ? JSON.parse(row.payload) : { inputVersion: 1, inputHistory: [] }
}
const terminalRun = r => ['succeeded', 'failed', 'cancelled'].includes(r.status)
function currentNode(a) {
  const n = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND node_id=? AND current=1').get(text(a.runId, 'runId'), text(a.nodeId, 'nodeId'))
  if (!n) fail('NODE_NOT_FOUND')
  if (n.generation !== integer(a.generation, 'generation', 1) || n.lease_epoch !== integer(a.leaseEpoch, 'leaseEpoch')) fail('NODE_STALE')
  return n
}
function activeRun(a, { allowFence = false, allowPause = false, allowMessageFence = false } = {}) {
  const r = getRun(a.runId)
  if (r.stop_requested || terminalRun(r)) fail('RUN_NOT_ACTIVE')
  if (r.pause_requested && !allowPause) fail('RUN_PAUSED')
  if (!allowFence&&!allowMessageFence) assertMessageTaskUnfenced(db, r.task_id)
  if (!allowFence && pendingInputs(r.run_id).length) fail('INPUT_PENDING')
  return r
}
function assertTaskDispatchAllowed(r) {
  const task = db.prepare(`SELECT t.plan_revision,t.status,c.state AS control_state
    FROM business_tasks t JOIN task_controls c ON c.task_id=t.task_id WHERE t.task_id=?`).get(r.task_id)
  if (!task) return
  if (task.control_state !== 'active' || task.status !== 'active'
    || !db.prepare(`SELECT 1 FROM task_plan_stages WHERE task_id=? AND plan_revision=?
      AND run_id=? AND status='running'`).get(r.task_id, task.plan_revision, r.run_id)) fail('TASK_DISPATCH_BLOCKED')
}
// 续行只针对已定位的 agent 可纠正问题；未知工具、身份和存储故障不能自动重放。
function inspectNodeRecovery(runId) {
  const r = getRun(runId), current = nodes(runId), candidate = current.find(n => ['waiting', 'failed'].includes(n.status))
  const base = { repairable: false, mode: 'resume-agent', reason: 'node-not-recoverable',
    runRevision: r.revision, generation: r.generation, evidenceRefs: [] }
  if (!candidate) return base
  const n = candidate, wait = JSON.parse(n.wait_reason ?? 'null')
  const record = db.prepare("SELECT payload FROM execution_events WHERE kind='node.failure' AND json_extract(payload,'$.nodeRunId')=? AND json_extract(payload,'$.leaseEpoch')=? ORDER BY seq DESC LIMIT 1").get(n.node_run_id, n.lease_epoch)
  const failure = record ? JSON.parse(record.payload).failure : { code: wait?.reference, phase: 'execution', targetNodeId: n.node_id }
  const detail = { ...base, nodeId: n.node_id, nodeRunId: n.node_run_id, leaseEpoch: n.lease_epoch, inputDigest: n.input_digest,
    evidenceRefs: [...new Set([n.output_ref, ...JSON.parse(n.evidence_refs)].filter(Boolean))], failure }
  if (typeof failure?.code !== 'string') return detail
  const problemKey = executionDigest({ nodeRunId: n.node_run_id, inputDigest: n.input_digest,
    code: failure.code, phase: failure.phase, targetNodeId: failure.targetNodeId })
  detail.problemKey = problemKey
  const correctable = ['AGENT_WORK_BLOCKED', 'NO_NODE_SUBMISSION', 'execution_no_submission', 'execution_step_budget_exhausted', 'execution_timeout',
    'QUERY_ARGUMENT_INVALID', 'QUERY_NOT_FOUND', 'QUERY_LIMIT_INVALID', 'QUERY_TIMEOUT', 'QUERY_CAPACITY'].includes(failure.code)
    || ['output-validation', 'output-admission'].includes(failure.phase)
      && ['NODE_SCHEMA_INVALID', 'INVALID_JSON_VALUE', 'INVALID_JSON_OBJECT', 'AGENT_WORK_RESULT_INVALID',
        'AGENT_WORK_EVIDENCE_INVALID', 'AGENT_WORK_COVERAGE_INCOMPLETE', 'QUERY_EVIDENCE_INVALID', 'GROUP_REPLY_INTERNAL_DETAILS'].includes(failure.code)
  if (!correctable) return { ...detail, reason: 'failure-requires-implementation-repair' }
  if (n.executor !== 'agent' || !n.session_bound || !n.session_id || !n.input_digest || !n.input_ref
    || !['failed', 'waiting'].includes(r.status) || wait?.kind !== 'recovery' || failure.code !== wait.reference
    || r.pause_requested || r.stop_requested || pendingInputs(runId).length || current.some(node => !node.drained)
    || current.slice(0, n.position).some(node => node.status !== 'succeeded')
    || current.slice(n.position + 1).some(node => node.status !== 'blocked' || node.lease_epoch !== 0)
    || db.prepare('SELECT 1 FROM execution_effects WHERE node_run_id=? LIMIT 1').get(n.node_run_id)
    || db.prepare("SELECT 1 FROM execution_effects WHERE run_id=? AND state NOT IN ('succeeded','failed') LIMIT 1").get(runId)) return detail
  const task = db.prepare('SELECT t.*,c.state AS control_state FROM business_tasks t JOIN task_controls c USING(task_id) WHERE t.task_id=?').get(r.task_id)
  const stages = task && db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position').all(r.task_id, task.plan_revision)
  const stage = stages?.find(item => item.run_id === runId)
  if (!task || task.control_state !== 'active' || !['active', 'blocked'].includes(task.status)
    || task.plan_requirement_revision !== task.requirement_revision || !stage || !['running', 'blocked'].includes(stage.status)
    || stage.workflow_digest !== r.workflow_digest || stage.requirement_ref !== r.requirement_ref || stage.output_ref
    || stages.slice(0, stage.position).some(item => item.status !== 'succeeded')
    || stages.slice(stage.position + 1).some(item => item.run_id || !['ready','waiting_confirmation','blocked'].includes(item.status))) return { ...detail, reason: 'task-plan-not-current' }
  try { assertMessageTaskUnfenced(db, r.task_id) } catch (error) { return { ...detail, reason: error.code } }
  if (maintenanceStatus(db, workerData.processIncarnation).active) return { ...detail, reason: 'runtime-maintenance' }
  if (stage.source_condition) {
    const condition = JSON.parse(stage.source_condition), source = readCurrentTaskSource(db, condition.sourceKey, { taskId: r.task_id })
    if (!source || source.status === 'superseded' || source.sourceVersion !== condition.sourceVersion
      || !source.body.includes(condition.sourceQuote) || !condition.sourceQuote.includes(condition.objective)
      || condition.requiredActorId && source.actorId !== condition.requiredActorId) return { ...detail, reason: 'task-source-not-current' }
  }
  if (db.prepare("SELECT 1 FROM execution_events WHERE kind='node.resume' AND json_extract(payload,'$.problemKey')=? LIMIT 1").get(problemKey))
    return { ...detail, reason: 'strategy-change-required' }
  return { ...detail, repairable: true, reason: failure.code }
}
function assertDispatchAllowed(a) {
  const r = activeRun(a)
  assertTaskDispatchAllowed(r)
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
      generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count>=0),
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
    CREATE INDEX execution_events_kind_seq ON execution_events(kind,seq);
  `)
  db.prepare('INSERT INTO execution_meta(singleton,instance_id,schema_version) VALUES(1,?,?)').run(workerData.instanceId, SCHEMA_VERSION)
  installEffectsSchema(db)
  installMessageSchema(db)
  installTaskPlanSchema(db)
  installTaskOwnerSchema(db)
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
    'SELECT run_id,task_id,workflow_id,workflow_digest,requirement_ref,revision,generation,claim_count,status,stop_requested,pause_requested,recovery_reason,created_at,updated_at FROM execution_runs LIMIT 0',
    'SELECT node_run_id,run_id,node_id,node_version,executor,position,generation,lease_epoch,current,input_ref,input_digest,status,session_id,session_bound,drained,drain_evidence_ref,output_ref,evidence_refs,wait_reason FROM execution_nodes LIMIT 0',
    'SELECT seq,run_id,input_id,source_key,requirement_ref,status,accepted_at,applied_at FROM execution_inputs LIMIT 0',
    'SELECT command_id,payload_digest,result,created_at FROM execution_receipts LIMIT 0',
    'SELECT seq,command_id,kind,payload,created_at FROM execution_events LIMIT 0',
  ]) connection.prepare(sql).all()
  const eventIndex = connection.prepare("PRAGMA index_list('execution_events')").all()
    .find(index => index.name === 'execution_events_kind_seq')
  const eventColumns = connection.prepare("PRAGMA index_info('execution_events_kind_seq')").all()
  if (!eventIndex || eventIndex.unique !== 0 || eventIndex.partial !== 0 || eventIndex.origin !== 'c'
    || eventColumns.length !== 2 || eventColumns[0].name !== 'kind' || eventColumns[1].name !== 'seq')
    fail('STORE_SCHEMA_MISMATCH')
  const bad = connection.prepare(`SELECT node_run_id FROM execution_nodes WHERE
    (status IN ('ready','running') AND (input_ref IS NULL OR input_digest IS NULL))
    OR (session_bound=1 AND session_id IS NULL)
    OR (lease_epoch>0 AND drained=1 AND drain_evidence_ref IS NULL)`).all()
  // running+drained 在确认退出和提交结果之间是合法持久检查点。
  if (bad.length) fail('STORE_INVARIANT_FAILED')
  validateEffectsSchema(connection)
  validateMessageSchema(connection)
  validateTaskPlanSchema(connection,{sourceConditions:true})
  validateTaskOwnerSchema(connection)
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
    recoverTaskOwners(db)
    db.exec('COMMIT')
  } catch (cause) { rollback(); throw cause }
}

function addNode(runId, plan, position, generation, status) {
  db.prepare(`INSERT INTO execution_nodes(node_run_id,run_id,node_id,node_version,executor,position,generation,input_ref,input_digest,status)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), runId, plan.nodeId, plan.nodeVersion, plan.executor, position, generation, plan.inputRef, plan.inputDigest, status)
}
function coreCommand(command, now, consumption = {}) {
  const a = command.args
  if (command.kind === 'run.create') {
    object(a, ['runId', 'taskId', 'workflowId', 'workflowDigest', 'requirementRef', 'nodes', 'stageBinding'], ['runId', 'taskId', 'workflowId', 'workflowDigest', 'requirementRef', 'nodes'])
    for (const key of ['runId', 'taskId', 'workflowId']) text(a[key], key)
    assertMessageTaskUnfenced(db,a.taskId,{...consumption,allowRelatedProcessing:consumption.ownerTurnId?'plan':false})
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
    db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)")
      .run(a.runId, a.taskId, a.workflowId, a.workflowDigest, a.requirementRef, now, now)
    a.nodes.forEach((n, i) => addNode(a.runId, n, i, 1, i === 0 ? 'ready' : 'blocked'))
    return { status: 'applied', run: runDto(getRun(a.runId)) }
  }
  if (command.kind === 'input.accept') {
    object(a, ['runId', 'inputId', 'sourceKey', 'requirementRef', 'expectedRevision', 'repair', 'readonlyRecovery'], ['runId', 'inputId', 'sourceKey', 'requirementRef'])
    text(a.inputId, 'inputId'); text(a.sourceKey, 'sourceKey'); ref(a.requirementRef, 'requirementRef')
    const old = db.prepare('SELECT * FROM execution_inputs WHERE run_id=? AND source_key=?').get(a.runId, a.sourceKey)
    if (old) {
      if (old.requirement_ref !== a.requirementRef) fail('INPUT_SOURCE_CONFLICT')
      return { status: 'applied', inputId: old.input_id, seq: old.seq, accepted: false }
    }
    const r = a.readonlyRecovery ? getRun(a.runId) : activeRun(a, { allowFence: true, allowPause: true })
    if (a.expectedRevision !== undefined && r.revision !== integer(a.expectedRevision, 'expectedRevision')) fail('REVISION_CONFLICT')
    if (a.expectedRevision !== undefined && pendingInputs(a.runId).length) fail('INPUT_PENDING')
    if (a.readonlyRecovery) {
      const v = a.readonlyRecovery
      object(v, ['taskId','stageId','nodeRunId','generation','inputDigest','requirementRevision','controlRevision','planRevision','reasonRef'])
      ref(v.reasonRef, 'reasonRef')
      const task = db.prepare('SELECT t.*,c.state,c.control_revision FROM business_tasks t JOIN task_controls c USING(task_id) WHERE t.task_id=?').get(v.taskId)
      const stage = task && db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND stage_id=?').get(v.taskId, task.plan_revision, v.stageId)
      const current = nodes(r.run_id), first = current[0]
      if (a.repair || !task || task.state !== 'active' || task.plan_requirement_revision !== task.requirement_revision
        || task.requirement_revision !== v.requirementRevision
        || task.control_revision !== v.controlRevision || task.plan_revision !== v.planRevision
        || !stage || !['running','blocked'].includes(stage.status) || stage.run_id !== r.run_id || stage.output_ref
        || r.task_id !== v.taskId || r.workflow_id !== 'task-investigation' || !['waiting','failed'].includes(r.status) || r.stop_requested || r.pause_requested
        || r.generation !== v.generation || r.revision !== a.expectedRevision || pendingInputs(r.run_id).length
        || !first || first.node_run_id !== v.nodeRunId || first.input_digest !== v.inputDigest
        || first.node_id !== 'investigate' || !['failed','waiting'].includes(first.status)
        || current.some(n => !n.drained || n.status === 'succeeded')
        || db.prepare('SELECT 1 FROM execution_effects WHERE run_id=? LIMIT 1').get(r.run_id)) fail('INVESTIGATION_RETRY_FORBIDDEN')
      db.prepare("UPDATE execution_runs SET status='waiting' WHERE run_id=?").run(r.run_id)
      db.prepare("UPDATE business_tasks SET status='active' WHERE task_id=?").run(v.taskId)
      db.prepare("UPDATE task_plan_stages SET status='running' WHERE task_id=? AND plan_revision=? AND stage_id=?").run(v.taskId, v.planRevision, v.stageId)
      emitEvent(command.id, 'investigation.retry.accepted', { ...v, runId: r.run_id, nextGeneration: r.generation + 1 }, now)
    }
    if (a.repair) {
      object(a.repair, ['taskId', 'stageId', 'runId', 'generation', 'runRevision', 'requirementRevision', 'contextRef', 'workflowDigest'])
      ref(a.repair.contextRef, 'contextRef')
      digest(a.repair.workflowDigest, 'workflowDigest')
      const task = db.prepare('SELECT t.requirement_revision,t.plan_revision,c.state FROM business_tasks t JOIN task_controls c USING(task_id) WHERE t.task_id=?').get(a.repair.taskId)
      const stage = task && db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND stage_id=?').get(a.repair.taskId, task.plan_revision, a.repair.stageId)
      if (a.expectedRevision !== a.repair.runRevision || pendingInputs(r.run_id).length || !task || task.state !== 'active' || task.requirement_revision !== a.repair.requirementRevision
        || r.task_id !== a.repair.taskId || r.run_id !== a.repair.runId || r.generation !== a.repair.generation || r.revision !== a.repair.runRevision
        || r.status !== 'waiting' || !stage || stage.status !== 'running' || stage.run_id !== r.run_id
        || stage.workflow_id !== r.workflow_id || stage.workflow_digest !== r.workflow_digest || a.repair.workflowDigest !== r.workflow_digest
        || nodes(r.run_id).some(node => !node.drained)
        || db.prepare("SELECT effect_id FROM execution_effects WHERE run_id=? AND state NOT IN ('succeeded','failed') LIMIT 1").get(r.run_id)) fail('WORKFLOW_REPAIR_NOT_ADMITTED')
      emitEvent(command.id, 'workflow.repair.accepted', { ...a.repair, runId: r.run_id, nextGeneration: r.generation + 1 }, now)
      db.prepare('UPDATE business_tasks SET plan_requirement_revision=requirement_revision WHERE task_id=?').run(a.repair.taskId)
    }
    if (db.prepare('SELECT input_id FROM execution_inputs WHERE run_id=? AND input_id=?').get(a.runId, a.inputId)) fail('INPUT_ID_CONFLICT')
    const inserted = db.prepare("INSERT INTO execution_inputs(run_id,input_id,source_key,requirement_ref,status,accepted_at) VALUES(?,?,?,?,'pending',?)")
      .run(a.runId, a.inputId, a.sourceKey, a.requirementRef, now)
    return { status: 'applied', inputId: a.inputId, seq: Number(inserted.lastInsertRowid), accepted: true, ...(a.readonlyRecovery ? { readonlyRecoveryReasonRef: a.readonlyRecovery.reasonRef } : {}) }
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
  if (command.kind === 'run.recovery.admit') {
    object(a, ['runId','runRevision','nodeRunId','generation','leaseEpoch','inputDigest','errorCode'])
    const r = activeRun(a), current = nodes(r.run_id), waiting = current.filter(n => n.status === 'waiting'), n = waiting[0]
    assertTaskDispatchAllowed(r)
    if (r.status !== 'waiting' || r.revision !== a.runRevision || r.generation !== a.generation || waiting.length !== 1
      || n.node_run_id !== a.nodeRunId || n.lease_epoch !== a.leaseEpoch || n.input_digest !== a.inputDigest
      || JSON.parse(n.wait_reason ?? 'null')?.reference !== a.errorCode || !transientRecoveryReasons.includes(a.errorCode)
      || current.some(node => !node.drained) || pendingInputs(r.run_id).length) fail('RECOVERY_RETRY_NOT_ADMITTED')
    assertRunEffectsDrained(db, r.run_id)
    const key = createHash('sha256').update(canonical({runId:r.run_id,generation:r.generation,nodeRunId:n.node_run_id,inputDigest:n.input_digest,errorCode:a.errorCode})).digest('hex')
    const prior = db.prepare("SELECT payload FROM execution_events WHERE kind='run.recovery.admitted' AND json_extract(payload,'$.key')=? ORDER BY seq DESC LIMIT 1").get(key)
    const last = prior ? JSON.parse(prior.payload) : null, attempt = (last?.attempt ?? 0) + 1
    if (last && Date.parse(now) < Date.parse(last.nextRetryAt)) fail('RECOVERY_RETRY_DEFERRED')
    const nextRetryAt = new Date(Date.parse(now) + recoveryRetryDelayMs(attempt)).toISOString()
    emitEvent(command.id, 'run.recovery.admitted', {...a,key,attempt,nextRetryAt}, now)
    return {admitted:true,attempt,nextRetryAt}
  }
  if (command.kind === 'run.recover') {
    object(a, ['runId'])
    const r = activeRun(a)
    const recovering = nodes(r.run_id).filter(n => n.status === 'waiting' && n.wait_reason && JSON.parse(n.wait_reason).kind === 'recovery')
    if (!recovering.length) fail('RUN_NOT_RECOVERING')
    if (recovering.some(n => !n.drained)) fail('NODE_NOT_DRAINED')
    assertRunEffectsDrained(db, r.run_id)
    for (const n of recovering) {
      db.prepare("UPDATE execution_nodes SET status='ready',wait_reason=NULL WHERE node_run_id=?")
        .run(n.node_run_id)
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
    db.prepare("UPDATE execution_runs SET workflow_digest=?,revision=revision+1,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toDigest, now, r.run_id)
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
    if (!Array.isArray(a.nodes) || a.nodes.length < 4
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
    // 重新编排保留实际领取统计，不限制新节点推进。
    db.prepare("UPDATE execution_runs SET workflow_digest=?,revision=revision+1,generation=generation+1,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toDigest, now, r.run_id)
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
    const reissuePrefix = ['11', '12', '13', '14', '15', '16'].includes(JSON.parse(nextRecord.body).definitionVersion)
      ? ['prepare-generation', 'define-local-acceptance', 'plan-local-acceptance', 'prepare-workspace', 'inspect-and-propose']
      : ['prepare-generation', 'prepare-workspace', 'inspect-and-propose']
    if (!Array.isArray(a.nodes) || a.nodes.length <= reissuePrefix.length
      || reissuePrefix.some((nodeId, index) => a.nodes[index]?.nodeId !== nodeId)
      || new Set(a.nodes.map(node => node.nodeId)).size !== a.nodes.length) fail('INVALID_NODE_PLAN')
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
    db.prepare("UPDATE execution_runs SET workflow_id=?,workflow_digest=?,requirement_ref=?,revision=revision+1,generation=generation+1,status='queued',recovery_reason=NULL,updated_at=? WHERE run_id=?")
      .run(a.toWorkflowId, a.toDigest, a.requirementRef, now, r.run_id)
    return { status: 'applied', run: runDto(getRun(r.run_id)) }
  }
  if (command.kind === 'node.continue') {
    object(a, ['runId','nodeId','generation','leaseEpoch','inputDigest','expectedInputVersion','inputRef','nextInputDigest','expectedOutputRef','eventId','answerDigest'])
    const r=activeRun(a),n=currentNode(a),history=nodeInputHistory(n.node_run_id)
    ref(a.inputRef,'inputRef');digest(a.nextInputDigest,'nextInputDigest');text(a.eventId,'eventId');digest(a.answerDigest,'answerDigest')
    if(r.status!=='waiting'||n.status!=='waiting'||n.executor!=='agent'||!n.session_bound||!n.drained
      ||n.input_digest!==a.inputDigest||n.output_ref!==a.expectedOutputRef||history.inputVersion!==a.expectedInputVersion
      ||JSON.parse(n.wait_reason??'null')?.reference!=='AGENT_WORK_NEEDS_INPUT'
      ||pendingInputs(r.run_id).length||db.prepare('SELECT 1 FROM execution_effects WHERE run_id=? LIMIT 1').get(r.run_id))fail('NODE_CONTINUATION_STALE')
    assertTaskDispatchAllowed(r)
    db.prepare("UPDATE execution_nodes SET input_ref=?,input_digest=?,status='ready',wait_reason=NULL,output_ref=NULL,evidence_refs='[]' WHERE node_run_id=?").run(a.inputRef,a.nextInputDigest,n.node_run_id)
    db.prepare("UPDATE execution_runs SET status='queued',revision=revision+1,recovery_reason=NULL,updated_at=? WHERE run_id=?").run(now,r.run_id)
    return {nodeRunId:n.node_run_id,inputVersion:history.inputVersion+1,inputHistory:[...history.inputHistory,{inputVersion:history.inputVersion,inputDigest:n.input_digest}],eventId:a.eventId,answerDigest:a.answerDigest,expectedOutputRef:a.expectedOutputRef}
  }
  if (command.kind === 'node.resume') {
    object(a, ['runId','expectedRevision','nodeRunId','generation','leaseEpoch','inputDigest','contextRef','problemKey','workflowDigest','sources',
      'expectedRequirementRevision','expectedPlanRevision','expectedControlRevision'])
    ref(a.contextRef, 'contextRef'); digest(a.problemKey, 'problemKey'); digest(a.workflowDigest, 'workflowDigest'); digest(a.inputDigest, 'inputDigest')
    const r = getRun(a.runId), recovery = inspectNodeRecovery(a.runId)
    const task = db.prepare('SELECT t.*,c.control_revision FROM business_tasks t JOIN task_controls c USING(task_id) WHERE t.task_id=?').get(r.task_id)
    if (!recovery.repairable || recovery.problemKey !== a.problemKey || r.workflow_digest !== a.workflowDigest
      || r.revision !== a.expectedRevision || recovery.nodeRunId !== a.nodeRunId || recovery.generation !== a.generation
      || recovery.leaseEpoch !== a.leaseEpoch || recovery.inputDigest !== a.inputDigest
      || task?.requirement_revision !== a.expectedRequirementRevision || task?.plan_revision !== a.expectedPlanRevision
      || task?.control_revision !== a.expectedControlRevision) fail('NODE_RECOVERY_NOT_ADMITTED', recovery.reason)
    if (!Array.isArray(a.sources)) fail('NODE_RECOVERY_SOURCE_INVALID')
    for (const frozen of a.sources) {
      object(frozen, ['sourceKey','sourceVersion','actorId','bodyDigest'])
      const source = readCurrentTaskSource(db, frozen.sourceKey, { taskId: r.task_id })
      if (!source || source.status === 'superseded' || source.sourceVersion !== frozen.sourceVersion
        || source.actorId !== frozen.actorId || executionDigest(source.body) !== frozen.bodyDigest) fail('NODE_RECOVERY_SOURCE_INVALID')
    }
    const n = nodes(a.runId).find(node => node.node_run_id === a.nodeRunId)
    db.prepare("UPDATE execution_nodes SET status='ready',output_ref=NULL,evidence_refs='[]',wait_reason=NULL WHERE node_run_id=?").run(n.node_run_id)
    db.prepare("UPDATE execution_runs SET status='queued',revision=revision+1,recovery_reason=NULL,updated_at=? WHERE run_id=?").run(now, r.run_id)
    db.prepare("UPDATE task_plan_stages SET status='running' WHERE task_id=? AND plan_revision=(SELECT plan_revision FROM business_tasks WHERE task_id=?) AND run_id=?").run(r.task_id, r.task_id, r.run_id)
    db.prepare("UPDATE business_tasks SET status='active',updated_at=? WHERE task_id=?").run(now, r.task_id)
    return { status: 'applied', runId: r.run_id, taskId: r.task_id, nodeRunId: n.node_run_id, generation: n.generation,
      inputDigest: n.input_digest, nextLeaseEpoch: n.lease_epoch + 1, previousRunRevision: r.revision, contextRef: a.contextRef, problemKey: recovery.problemKey,
      failure: recovery.failure, previousOutputRef: n.output_ref, evidenceRefs: recovery.evidenceRefs }
  }
  if (command.kind === 'node.claim') {
    object(a, ['runId', 'nodeId', 'expectedGeneration', 'expectedLeaseEpoch'])
    const r = activeRun(a)
    assertTaskDispatchAllowed(r)
    const n = currentNode({ ...a, generation: a.expectedGeneration, leaseEpoch: a.expectedLeaseEpoch })
    if (n.status !== 'ready' || !n.drained || !n.input_ref || !n.input_digest) fail('NODE_NOT_READY')
    if (nodes(r.run_id).some(other => other.position < n.position && other.status !== 'succeeded')) fail('NODE_PREDECESSOR_INCOMPLETE')
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
    object(a, ['runId', 'nodeId', 'generation', 'leaseEpoch', 'inputDigest', 'outcome', 'outputRef', 'evidenceRefs', 'waitReason', 'nextInput', 'failure'],
      ['runId', 'nodeId', 'generation', 'leaseEpoch', 'inputDigest', 'outcome', 'evidenceRefs'])
    // 已领取执行的真实结果按原 generation/input 入账；新消息只阻挡后继领取，不能制造重复执行。
    const r = activeRun(a,{allowMessageFence:true}), n = currentNode(a)
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
    if (a.failure !== undefined) {
      object(a.failure, ['code','phase','targetNodeId'])
      for (const key of ['code','phase','targetNodeId']) text(a.failure[key], key)
      if (a.outcome === 'succeeded' || a.failure.code !== a.waitReason.reference) fail('INVALID_NODE_FAILURE')
      emitEvent(command.id, 'node.failure', { nodeRunId: n.node_run_id, leaseEpoch: n.lease_epoch, failure: a.failure }, now)
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
  object(value, ['id', 'kind', 'args','inputCommandId','ownerTurnId'],['id','kind','args'])
  text(value.id, 'command.id'); text(value.kind, 'command.kind')
  if (!value.args || Object.getPrototypeOf(value.args) !== Object.prototype) fail('INVALID_ARGUMENT')
  if (value.kind === 'task.plan.accept') fail('UNKNOWN_COMMAND')
  const consumption=Object.fromEntries(['inputCommandId','ownerTurnId'].filter(key=>value[key]!==undefined).map(key=>[key,text(value[key],key)]))
  if(Object.keys(consumption).length&&!['run.create','task.owner.accept','task.owner.applied','task.plan.initialize','task.plan.extend','task.plan.create',
    'task.plan.confirm','task.plan.revise','task.stage.input.bind'].includes(value.kind))fail('MESSAGE_INPUT_CONSUMPTION_FORBIDDEN')
  const hash = createHash('sha256').update(canonical({ kind: value.kind, args: value.args,...consumption })).digest('hex')
  const now = new Date().toISOString()
  try {
    db.exec('BEGIN IMMEDIATE')
    const prior = db.prepare('SELECT * FROM execution_receipts WHERE command_id=?').get(value.id)
    if (prior) {
      if (prior.payload_digest !== hash) fail('COMMAND_ID_CONFLICT')
      db.exec('COMMIT')
      return { replayed: true, dispatchEligible: false, result: JSON.parse(prior.result) }
    }
    assertMaintenanceDispatch(db, value.kind)
    // 与 message 的接纳和 command 领取使用同一持久输入守卫；读取和取消本身不被拦住。
    if (['task.accept','task.owner.accept','task.owner.applied','task.plan.initialize','task.plan.extend',
      'task.plan.create','task.plan.confirm','task.plan.revise','task.stage.input.bind','task.stage.complete'].includes(value.kind)) {
      let taskId=value.args.taskId
      if(!taskId&&value.args.turnId)taskId=db.prepare('SELECT task_id FROM task_owner_turns WHERE turn_id=?').get(value.args.turnId)?.task_id
      if(value.kind==='task.owner.accept'){
        const currentOwner=db.prepare('SELECT lease_epoch,current_turn_id FROM task_owners WHERE task_id=?').get(taskId)
        if(currentOwner&&(currentOwner.lease_epoch!==value.args.leaseEpoch||currentOwner.current_turn_id!==value.args.turnId))fail('TASK_OWNER_LEASE_STALE')
      }
      const settlingStopped=value.kind==='task.stage.complete'&&db.prepare('SELECT state FROM task_controls WHERE task_id=?').get(taskId)?.state!=='active'
      if(taskId&&!settlingStopped)assertMessageTaskUnfenced(db,taskId,{...consumption,
        ...(['task.owner.accept','task.owner.applied'].includes(value.kind)?{ownerTurnId:value.args.turnId}:{}),
        allowRelatedProcessing:['task.owner.accept','task.owner.applied'].includes(value.kind)?'owner':value.kind.startsWith('task.plan.')||value.kind==='task.stage.input.bind'&&consumption.ownerTurnId?'plan':false})
    }
    if (value.kind === 'task.owner.claim') assertMessageTaskUnfenced(db, value.args.taskId, { allowRelatedProcessing: 'owner' })
    let combined = reduceMaintenanceCommand(db, value, { ...context(value.id, now), processIncarnation: workerData.processIncarnation })
    if (['task.accept','task.plan.create','run.create'].includes(value.kind) && taskDeleted(value.args.taskId)) fail('TASK_DELETED')
    if (value.kind === 'task.delete') {
      object(value.args, ['taskId','actorId','expectedControlRevision'])
      const checked = inspectTaskDeletion(value.args)
      for (const table of ['task_reports','task_owner_turns','task_events','task_acceptance_items','task_owners','task_plan_stages','task_controls'])
        db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(value.args.taskId)
      for (const runId of checked.runIds) {
        db.prepare('DELETE FROM execution_inputs WHERE run_id=?').run(runId)
        db.prepare('DELETE FROM execution_nodes WHERE run_id=?').run(runId)
        db.prepare('DELETE FROM execution_runs WHERE run_id=?').run(runId)
      }
      db.prepare('DELETE FROM business_tasks WHERE task_id=?').run(value.args.taskId)
      combined = { ...checked, deletedAt: now }
    } else if (value.kind === 'task.archive') {
      object(value.args, ['taskId', 'actorId'])
      const { taskId, actorId } = value.args
      text(taskId, 'taskId'); text(actorId, 'actorId')
      const origin = taskOrigin(taskId)
      if (!origin) fail('WORKFLOW_TASK_NOT_FOUND')
      if (origin.channel === 'web' && origin.run.actorId !== actorId) fail('WORKFLOW_TASK_FORBIDDEN')
      const family = taskFamily(taskId)
      if (!family) fail('WORKFLOW_TASK_NOT_FOUND')
      for (const member of family.taskIds) assertTaskDrained(member, actorId, 'TASK_ARCHIVE')
      const prior = db.prepare("SELECT payload FROM execution_events WHERE kind='task.archive' ORDER BY seq DESC").all()
        .map(row => JSON.parse(row.payload)).find(event => canonical(event.taskIds ?? [event.taskId]) === canonical(family.taskIds))
      combined = prior ?? { taskId, taskIds: family.taskIds, archivedAt: now, actorId }
    } else if (value.kind === 'task.web-input.prepare') {
      object(value.args, ['eventId', 'actorId', 'request', 'input'])
      const { eventId, actorId, request, input } = value.args
      const old = webTaskEvent(eventId)
      if (old) {
        if (old.actorId !== actorId || canonical(old.request) !== canonical(request)) fail('MESSAGE_WEB_EVENT_CONFLICT')
        combined = { event: old }
      } else {
        const origin = taskOrigin(request.taskId)
        if (origin?.channel !== 'web' || origin.run.actorId !== actorId) fail('WORKFLOW_TASK_FORBIDDEN')
        if (taskFamily(request.taskId)?.latestTaskId !== request.taskId) fail('TASK_EXECUTION_STALE')
        if (!['context', 'cancel', 'confirm-stage'].includes(request.action)) fail('WORKFLOW_WEB_ACTION_UNSUPPORTED')
        const task = db.prepare('SELECT * FROM business_tasks WHERE task_id=?').get(request.taskId)
        const count = db.prepare('SELECT COUNT(*) AS n FROM execution_runs WHERE task_id=?').get(request.taskId).n
        const control = db.prepare('SELECT * FROM task_controls WHERE task_id=?').get(request.taskId)
        if (request.action === 'confirm-stage') {
          object(request, ['action', 'taskId', 'requestId', 'requirementRevision', 'controlRevision', 'planRevision', 'runSequence', 'stageId', 'outputRef', 'confirmationText'])
          text(request.requestId, 'requestId'); text(request.confirmationText, 'confirmationText')
          if (request.confirmationText.length > 16000 || input !== null) fail('TASK_CONFIRMATION_INVALID')
          if (request.requirementRevision !== task.requirement_revision || request.runSequence !== count) fail('REVISION_CONFLICT')
          if (request.planRevision !== task.plan_revision) fail('TASK_PLAN_STALE')
          if (request.controlRevision !== control.control_revision || control.state !== 'active' || task.status !== 'waiting_confirmation') fail('TASK_CONTROL_STALE')
          const stages = db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position').all(request.taskId, task.plan_revision)
          const index = stages.findIndex(stage => stage.stage_id === request.stageId)
          const stage = stages[index], previous = stages.slice(0, index)
          if (!stage || stage.status !== 'waiting_confirmation' || stage.gate !== 'confirmation') fail('TASK_CONFIRMATION_NOT_WAITING')
          if (!previous.length || previous.some(item => item.status !== 'succeeded') || previous.at(-1).output_ref !== request.outputRef) fail('TASK_CONFIRMATION_OUTPUT_STALE')
        } else if (request.inputVersion !== task.requirement_revision + 1 || request.runSequence !== count) fail('REVISION_CONFLICT')
        if (request.action === 'context' && isBusinessTaskTerminal(db, request.taskId)) fail('RUN_TERMINAL')
        combined = { event: { id: eventId, channel: 'web', actorId, request, input, status: 'pending', expectedControlRevision: control.control_revision } }
      }
    } else if (value.kind === 'task.web-input.finish') {
      object(value.args, ['eventId', 'result', 'error'], ['eventId'])
      const event = webTaskEvent(value.args.eventId)
      if (!event) fail('TASK_WEB_EVENT_NOT_FOUND')
      combined = { event: event.status === 'pending' ? { ...event, status: value.args.error ? 'rejected' : 'accepted',
        result: value.args.result ?? null, error: value.args.error ?? null } : event }
    } else if (value.kind === 'task.web-rerun.accept') {
      object(value.args, ['taskId', 'rerunOfTaskId', 'actorId', 'request', 'requirementRef', 'criteria', 'sourceKey'])
      const { taskId, rerunOfTaskId, actorId, request, requirementRef, criteria, sourceKey } = value.args
      for (const field of [taskId, rerunOfTaskId, actorId, sourceKey]) text(field, 'web source')
      if (taskId === rerunOfTaskId || !sourceKey.startsWith('web-rerun:')) fail('TASK_WEB_SOURCE_INVALID')
      const priorOrigin = taskOrigin(rerunOfTaskId)
      if (!priorOrigin) fail('WORKFLOW_TASK_NOT_FOUND')
      const family = taskFamily(rerunOfTaskId)
      if (family?.latestTaskId !== rerunOfTaskId) fail('TASK_EXECUTION_STALE')
      for (const member of family.taskIds) assertTaskDrained(member, actorId, 'TASK_RERUN_SOURCE')
      const previousRuns = db.prepare('SELECT run_id,status FROM execution_runs WHERE task_id=? ORDER BY rowid DESC').all(rerunOfTaskId)
      const previousTask = db.prepare('SELECT t.status,c.state FROM business_tasks t JOIN task_controls c ON c.task_id=t.task_id WHERE t.task_id=?').get(rerunOfTaskId)
      if (previousRuns.length ? previousRuns[0].run_id !== request.expectedRunId
        : request.expectedRunId !== null || previousTask?.state !== 'cancelled') fail('TASK_RERUN_SOURCE_CHANGED')
      if (previousTask && previousTask.status !== 'succeeded' && previousTask.state !== 'cancelled'
        || previousRuns.some(run => !['succeeded', 'failed', 'cancelled'].includes(run.status))) fail('TASK_RERUN_SOURCE_CHANGED')
      const created = reduceTaskPlanCommand(db, { kind: 'task.plan.accept', args: { taskId, requirementRef, requirementRevision: 1 } }, context(value.id, now))
      const sessionId = `owner-${createHash('sha256').update(taskId).digest('hex').slice(0, 40)}`
      reduceTaskOwnerCommand(db, { kind: 'task.owner.init', args: { taskId, sessionId, criteria, sourceKey } }, context(value.id, now))
      const event = reduceTaskOwnerCommand(db, { kind: 'task.owner.event', args: { taskId, eventKey: sourceKey, eventType: 'task.created', payloadRef: requirementRef } }, context(value.id, now))
      const source = { channel: 'web', sourceKey, sourceVersion: 1, runId: sourceKey, conversationId: `web:${actorId}`,
        actorId, body: request.objective, status: 'accepted', createdAt: now, context: {},
        reportChannel: 'web', externalMessaging: false, rerunOfTaskId, request }
      combined = { ...created, taskId, rerunOfTaskId, source, ownerSessionId: sessionId, eventSeq: event.eventSeq }
    } else if (value.kind === 'task.accept') {
      object(value.args, ['taskId', 'requirementRef', 'requirementRevision', 'sessionId', 'criteria', 'sourceKey', 'eventKey'])
      const { taskId, requirementRef, requirementRevision, sessionId, criteria, sourceKey, eventKey } = value.args
      const created = reduceTaskPlanCommand(db, { kind: 'task.plan.accept', args: { taskId, requirementRef, requirementRevision } }, context(value.id, now))
      reduceTaskOwnerCommand(db, { kind: 'task.owner.init', args: { taskId, sessionId, criteria, sourceKey } }, context(value.id, now))
      const event = reduceTaskOwnerCommand(db, { kind: 'task.owner.event', args: { taskId, eventKey, eventType: 'task.created', payloadRef: requirementRef } }, context(value.id, now))
      registerMessageAcceptance(db,taskId,requirementRevision,now)
      combined = { ...created, ownerSessionId: sessionId, eventSeq: event.eventSeq }
    } else if (value.kind === 'task.requirement.bind-legacy') {
      object(value.args, ['taskId', 'expectedRequirementRevision', 'requirementRef',
        'sessionId', 'criteria', 'sourceKey', 'eventKey'])
      const { taskId, expectedRequirementRevision, requirementRef, sessionId, criteria,
        sourceKey, eventKey } = value.args
      const bound = reduceTaskPlanCommand(db, { kind: 'task.requirement.bind-legacy', args: {
        taskId, expectedRequirementRevision, requirementRef } }, context(value.id, now))
      if (!db.prepare('SELECT 1 FROM task_owners WHERE task_id=?').get(taskId))
        reduceTaskOwnerCommand(db, { kind: 'task.owner.init', args: {
          taskId, sessionId, criteria, sourceKey } }, context(value.id, now))
      const event = reduceTaskOwnerCommand(db, { kind: 'task.owner.event', args: {
        taskId, eventKey, eventType: 'task.recovered', payloadRef: requirementRef } }, context(value.id, now))
      combined = { ...bound, eventSeq: event.eventSeq }
    } else if (value.kind === 'task.owner.reassess') {
      const a=object(value.args,['taskId','eventKey','payloadRef','expectedOwnerRevision','expectedLeaseEpoch','expectedRequirementRevision','expectedControlRevision','sources','requestDigest'])
      const task=db.prepare('SELECT t.*,c.state,c.control_revision FROM business_tasks t JOIN task_controls c USING(task_id) WHERE task_id=?').get(a.taskId)
      const owner=db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(a.taskId)
      if(!task||!owner||owner.revision!==a.expectedOwnerRevision||owner.lease_epoch!==a.expectedLeaseEpoch
        ||task.requirement_revision!==a.expectedRequirementRevision||task.control_revision!==a.expectedControlRevision)fail('TASK_OWNER_REASSESS_STALE')
      ref(a.payloadRef,'payloadRef');digest(a.requestDigest,'requestDigest')
      const invalidRepair=owner.last_failure==='WORKFLOW_REPAIR_NOT_ADMITTED' ? db.prepare("SELECT * FROM task_owner_turns WHERE task_id=? AND lease_epoch=? AND status='accepted' AND application_status='blocked' AND json_extract(decision_json,'$.action')='repairCurrentStage'").get(a.taskId,owner.lease_epoch) : null
      const rejectedSourcePlan=owner.last_failure==='TASK_STAGE_SOURCE_CONDITION_INVALID' ? db.prepare("SELECT * FROM task_owner_turns WHERE task_id=? AND lease_epoch=? AND status='accepted' AND application_status='blocked' AND json_extract(decision_json,'$.action')='advance'").get(a.taskId,owner.lease_epoch) : null
      const rejectedAction=invalidRepair??rejectedSourcePlan
      const externalRuns=db.prepare("SELECT * FROM execution_runs WHERE task_id=? AND workflow_id<>'task-investigation'").all(a.taskId)
      const handedOffRuns=new Set()
      for(const run of externalRuns.filter(run=>run.workflow_id==='task-data-change'&&run.status==='cancelled'&&run.stop_requested)){
        const historical=db.prepare('SELECT * FROM execution_effects WHERE run_id=?').all(run.run_id)
        const gate=historical.find(effect=>effect.node_id==='approval-gate'),created=historical.find(effect=>effect.node_id==='create-issue')
        const closed=gate?.result_json&&JSON.parse(gate.result_json),proof=closed?.result?.result,view=proof?.view,pack=view?.prepared?.package
        const handoffEvent=db.prepare("SELECT event_key FROM task_events WHERE task_id=? AND event_type='approval.channel.changed' AND payload_ref IS NOT NULL").all(a.taskId).find(event=>{
          const receipt=db.prepare('SELECT result FROM execution_receipts WHERE command_id=?').get(`${event.event_key}:stop`)
          const stopped=receipt&&JSON.parse(receipt.result).run
          return stopped?.runId===run.run_id&&stopped.taskId===a.taskId&&stopped.requirementRef===run.requirement_ref&&stopped.generation===run.generation
            &&stopped.stopRequested&&JSON.parse(stopped.recoveryReason??'null')?.kind==='approval-channel-handoff'
        })
        if(historical.length!==2||!gate||!created||created.state!=='succeeded'||gate.state!=='failed'
          ||closed.result?.reason!=='APPROVAL_CHANNEL_SUPERSEDED'||closed.status!=='failed'||closed.effectId!==gate.effect_id||proof?.kind!=='data-change-approval-handoff'
          ||proof.taskId!==a.taskId||proof.originalRunId!==run.run_id||proof.originalGeneration!==run.generation||proof.originalRequirementRef!==run.requirement_ref
          ||proof.effectId!==gate.effect_id||proof.nodeRunId!==gate.node_run_id||proof.inputDigest!==gate.input_digest||proof.effectDigest!==executionDigest(JSON.parse(gate.definition_json))
          ||!pack||!handoffEvent
          ||db.prepare('SELECT 1 FROM execution_nodes WHERE run_id=? AND drained=0').get(run.run_id))continue
        if(!historical.every(effect=>effect.result_json&&db.prepare('SELECT 1 FROM execution_effect_observations WHERE effect_id=? AND payload_json=? AND payload_digest=?').get(effect.effect_id,effect.result_json,executionDigest(JSON.parse(effect.result_json)))))continue
        const createdResult=JSON.parse(created.result_json)
        if(createdResult.effectId!==created.effect_id||createdResult.status!=='succeeded'||createdResult.result?.result?.issueId!==view.issue?.id)continue
        const resume=externalRuns.find(next=>next.workflow_id==='task-data-change-approval-resume'&&next.status==='succeeded'
          &&db.prepare("SELECT 1 FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND run_id=? AND status='succeeded'").get(a.taskId,task.plan_revision,next.run_id)
          &&db.prepare("SELECT 1 FROM execution_nodes WHERE run_id=? AND node_id='freeze-existing-issue' AND current=1 AND status='succeeded' AND drained=1 AND output_ref IS NOT NULL").get(next.run_id)
          &&db.prepare("SELECT definition_json FROM execution_effects WHERE run_id=? AND node_id='execute-task' AND state='succeeded'").all(next.run_id).some(effect=>{
            const intent=JSON.parse(effect.definition_json).payload?.intent
            return intent&&intent.issueId===view.issue?.id&&intent.planId===view.plan?.id&&intent.sheetId===view.sheet?.id
              &&intent.applySqlSha256===pack.applySqlSha256&&intent.packageDigest===pack.validation?.packageDigest&&canonical(intent.target)===canonical(pack.target)
          }))
        if(resume)handedOffRuns.add(run.run_id)
      }
      const completedExternal=externalRuns.length>0 && (()=>{
        const stages=db.prepare("SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND status<>'invalidated'").all(a.taskId,task.plan_revision)
        if(!stages.length||stages.some(stage=>stage.status!=='succeeded'||!stage.output_ref||!stage.run_id))return false
        for(const run of externalRuns){
          if(handedOffRuns.has(run.run_id))continue
          const stage=stages.find(stage=>stage.run_id===run.run_id)
          if(!['task-data-change','task-data-change-approval-resume'].includes(run.workflow_id)||run.status!=='succeeded'
            ||!stage||stage.workflow_id!==run.workflow_id||stage.workflow_digest!==run.workflow_digest||stage.requirement_ref!==run.requirement_ref
            ||db.prepare("SELECT 1 FROM execution_nodes WHERE run_id=? AND current=1 AND (status<>'succeeded' OR drained=0)").get(run.run_id))return false
          const condition=stage.source_condition&&JSON.parse(stage.source_condition)
          const source=condition&&a.sources?.find(source=>source.sourceKey===condition.sourceKey&&source.sourceVersion===condition.sourceVersion)
          const current=source&&readCurrentTaskSource(db,source.sourceKey,{taskId:a.taskId})
          if(!current||!condition.sourceQuote||!current.body.includes(condition.sourceQuote)||condition.requiredActorId&&condition.requiredActorId!==current.actorId)return false
        }
        const effects=db.prepare('SELECT e.* FROM execution_effects e JOIN execution_runs r USING(run_id) WHERE r.task_id=?').all(a.taskId)
        if(!effects.length)return false
        for(const effect of effects){
          if(handedOffRuns.has(effect.run_id))continue
          const node=db.prepare('SELECT * FROM execution_nodes WHERE node_run_id=?').get(effect.node_run_id)
          const result=effect.result_json&&JSON.parse(effect.result_json)
          if(effect.state!=='succeeded'||!node||node.run_id!==effect.run_id||node.node_id!==effect.node_id||!node.current
            ||node.generation!==effect.generation||node.input_digest!==effect.input_digest||node.status!=='succeeded'||!node.drained
            ||result?.effectId!==effect.effect_id||result.status!=='succeeded'||!result.evidenceRef
            ||!db.prepare('SELECT 1 FROM execution_effect_observations WHERE effect_id=? AND payload_json=? AND payload_digest=?').get(effect.effect_id,effect.result_json,executionDigest(result)))return false
          if(effect.request_id){
            const approval=db.prepare('SELECT * FROM execution_approvals WHERE request_id=? AND effect_id=?').get(effect.request_id,effect.effect_id)
            if(!approval||approval.decision!=='approved'||approval.revoked||!JSON.parse(approval.approver_ids_json).includes(approval.decided_by))return false
          }
        }
        return true
      })()
      if(task.state!=='active'||db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND requirement_revision=? AND plan_revision=? AND status='accepted' AND application_status='applied' AND json_extract(decision_json,'$.action')='complete' LIMIT 1").get(a.taskId,task.requirement_revision,task.plan_revision)||!['idle','blocked'].includes(owner.status)||owner.current_turn_id
        ||db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND turn_id<>? AND (status IN ('running','candidate') OR application_status IN ('pending','blocked'))").get(a.taskId,rejectedAction?.turn_id??'')
        ||rejectedSourcePlan&&db.prepare('SELECT 1 FROM execution_receipts WHERE command_id=?').get(`owner-plan:${rejectedSourcePlan.turn_id}`)
        ||!db.prepare("SELECT 1 FROM execution_runs WHERE task_id=? AND workflow_id='task-investigation' AND status IN ('failed','waiting','succeeded')").get(a.taskId)
        ||db.prepare('SELECT * FROM execution_runs WHERE task_id=?').all(a.taskId).some(run=>!handedOffRuns.has(run.run_id)
          &&(!['failed','waiting','succeeded'].includes(run.status)||run.workflow_id!=='task-investigation'&&!completedExternal))
        ||db.prepare("SELECT 1 FROM execution_nodes n JOIN execution_runs r USING(run_id) WHERE r.task_id=? AND (n.drained=0 OR n.status IN ('running','unknown'))").get(a.taskId)
        ||db.prepare("SELECT 1 FROM execution_inputs i JOIN execution_runs r USING(run_id) WHERE r.task_id=? AND i.status='pending'").get(a.taskId)
        ||!completedExternal&&db.prepare('SELECT 1 FROM execution_effects e JOIN execution_runs r USING(run_id) WHERE r.task_id=?').get(a.taskId)
        ||!completedExternal&&db.prepare("SELECT 1 FROM task_plan_stages WHERE task_id=? AND workflow_id<>'task-investigation' AND status<>'invalidated'").get(a.taskId))fail('TASK_OWNER_REASSESS_FORBIDDEN')
      if(!Array.isArray(a.sources)||!a.sources.length)fail('TASK_AUTHORIZATION_SOURCE_STALE')
      for(const source of a.sources){
        object(source,['sourceKey','sourceVersion','actorId','bodyDigest'])
        const current=readCurrentTaskSource(db,source.sourceKey,{taskId:a.taskId})
        if(!current||current.status==='superseded'||current.sourceVersion!==source.sourceVersion||current.actorId!==source.actorId
          ||createHash('sha256').update(canonical(current.body)).digest('hex')!==source.bodyDigest)fail('TASK_AUTHORIZATION_SOURCE_STALE')
      }
      if(rejectedAction)reduceTaskOwnerCommand(db,{kind:'task.owner.discard',args:{taskId:a.taskId,turnId:rejectedAction.turn_id,leaseEpoch:rejectedAction.lease_epoch,reason:owner.last_failure}},context(value.id,now))
      const event=reduceTaskOwnerCommand(db,{kind:'task.owner.event',args:{taskId:a.taskId,eventKey:a.eventKey,eventType:'system.recovery',payloadRef:a.payloadRef}},context(value.id,now))
      combined={status:'pending',taskId:a.taskId,eventSeq:event.eventSeq,ownerRevision:owner.revision+1+(rejectedAction?1:0),sessionId:owner.session_id,requestDigest:a.requestDigest,...(rejectedAction?{discardedTurnId:rejectedAction.turn_id}:{})}
    } else if (value.kind === 'task.authorization.repair') {
      const a = object(value.args, ['taskId','expectedRequirementRevision','expectedRequirementRef','requirementRef','eventKey','payloadRef','sources','requestDigest'])
      const task = db.prepare('SELECT requirement_ref,requirement_revision FROM business_tasks WHERE task_id=?').get(a.taskId)
      if (!task || task.requirement_ref !== a.expectedRequirementRef || task.requirement_revision !== a.expectedRequirementRevision) fail('TASK_REQUIREMENT_STALE')
      ref(a.payloadRef, 'payloadRef'); digest(a.requestDigest, 'requestDigest')
      if (!Array.isArray(a.sources) || !a.sources.length) fail('TASK_AUTHORIZATION_SOURCE_STALE')
      for (const source of a.sources) {
        object(source, ['sourceKey','sourceVersion','actorId','bodyDigest'])
        const current = readCurrentTaskSource(db, source.sourceKey, { taskId: a.taskId })
        if (!current || current.status === 'superseded' || current.sourceVersion !== source.sourceVersion || current.actorId !== source.actorId
          || createHash('sha256').update(canonical(current.body)).digest('hex') !== source.bodyDigest) fail('TASK_AUTHORIZATION_SOURCE_STALE')
      }
      if (db.prepare("SELECT 1 FROM task_owners WHERE task_id=? AND status='running'").get(a.taskId)
        || db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND status='accepted' AND application_status='pending'").get(a.taskId)
        || db.prepare("SELECT 1 FROM execution_runs WHERE task_id=? AND (workflow_id<>'task-investigation' OR status NOT IN ('waiting','failed','succeeded'))").get(a.taskId)
        || db.prepare("SELECT 1 FROM execution_nodes n JOIN execution_runs r USING(run_id) WHERE r.task_id=? AND (n.drained=0 OR n.status IN ('running','unknown'))").get(a.taskId)
        || db.prepare("SELECT 1 FROM execution_inputs i JOIN execution_runs r USING(run_id) WHERE r.task_id=? AND i.status='pending'").get(a.taskId)
        || db.prepare('SELECT 1 FROM execution_effects e JOIN execution_runs r USING(run_id) WHERE r.task_id=?').get(a.taskId)
        || db.prepare("SELECT 1 FROM task_plan_stages WHERE task_id=? AND workflow_id<>'task-investigation' AND status<>'invalidated'").get(a.taskId)) fail('TASK_AUTHORIZATION_REPAIR_NOT_DRAINED')
      const updated = reduceTaskPlanCommand(db, { kind: 'task.requirement.update', args: { taskId:a.taskId,
        expectedRequirementRevision:a.expectedRequirementRevision, requirementRef:a.requirementRef } }, context(value.id, now))
      const event = reduceTaskOwnerCommand(db, { kind: 'task.owner.event', args: { taskId:a.taskId, eventKey:a.eventKey,
        eventType:'authorization.projection.repaired', payloadRef:a.payloadRef } }, context(value.id, now))
      combined = { ...updated, eventSeq:event.eventSeq, oldRequirementRef:a.expectedRequirementRef, requestDigest:a.requestDigest }
    } else if (value.kind === 'task.requirement.update') {
      object(value.args, ['taskId', 'expectedRequirementRevision', 'requirementRef', 'eventKey', 'payloadRef'],
        ['taskId', 'expectedRequirementRevision', 'requirementRef', 'eventKey'])
      const { taskId, expectedRequirementRevision, requirementRef, eventKey, payloadRef } = value.args
      if (db.prepare('SELECT 1 FROM task_events WHERE event_key=?').get(eventKey)) fail('TASK_OWNER_EVENT_CONFLICT')
      // 只有真实待处理的人工结构化修订能替换验收；普通上下文追加保持原验收。
      const webEventId = eventKey.startsWith('web:') ? eventKey.slice(4) : null
      const webEvent = webEventId ? webTaskEvent(webEventId) ?? queryMessages(db, { kind: 'message.web-task', eventId: webEventId }) : null
      const revision = webEvent?.request?.requirement
      if (revision) {
        const sourceKey = `web-context:${webEventId}`
        if (webEvent.status !== 'pending' || webEvent.request.action !== 'context' || webEvent.request.taskId !== taskId
          || webEvent.request.inputVersion !== expectedRequirementRevision + 1
          || !acceptanceCriteriaSchema.safeParse(revision.acceptanceCriteria).success
          || !webEvent.input || webEvent.input.request !== revision.objective || webEvent.input.objective !== revision.objective
          || canonical(webEvent.input?.acceptanceCriteria) !== canonical(revision.acceptanceCriteria)
          || webEvent.input?.authorization?.channel !== 'web' || webEvent.input.authorization.sourceKey !== sourceKey
          || webEvent.input.authorization.actorId !== webEvent.actorId
          || webEvent.input.authorization.requestId !== webEvent.request.requestId
          || !webEvent.input.scope?.sourceKeys?.includes(sourceKey)
          || parseArtifactReference(requirementRef).digest !== executionDigest(webEvent.input)) fail('TASK_WEB_REQUIREMENT_INVALID')
      }
      const updated = reduceTaskPlanCommand(db, { kind: 'task.requirement.update', args: { taskId, expectedRequirementRevision, requirementRef } }, context(value.id, now))
      if (revision) {
        const sourceKey = `web-context:${webEventId}`
        const itemPrefix = `acceptance-${expectedRequirementRevision + 1}-${executionDigest(sourceKey).slice(0, 24)}`
        db.prepare('UPDATE task_acceptance_items SET active=0 WHERE task_id=? AND active=1').run(taskId)
        for (const [index, criterion] of revision.acceptanceCriteria.entries())
          db.prepare('INSERT INTO task_acceptance_items(task_id,item_id,criterion,source_key) VALUES(?,?,?,?)')
            .run(taskId, `${itemPrefix}-${index + 1}`, criterion, sourceKey)
      }
      const event = reduceTaskOwnerCommand(db, { kind: 'task.owner.event', args: { taskId, eventKey, eventType: 'intent.received', payloadRef: payloadRef ?? requirementRef } }, context(value.id, now))
      combined = { ...updated, eventSeq: event.eventSeq }
    }
    const core = combined ?? coreCommand(value, now,consumption)
    const plan = core === null ? reduceTaskPlanCommand(db, value, context(value.id, now)) : null
    const ownerResult = core === null && plan === null ? reduceTaskOwnerCommand(db, value, context(value.id, now)) : null
    const effect = core === null && plan === null && ownerResult === null
      ? (reduceMessageCommand(db, value, context(value.id, now)) ?? reduceEffectCommand(db, value, context(value.id, now))) : null
    if (core === null && plan === null && ownerResult === null && effect === null) fail('UNKNOWN_COMMAND')
    const result = core ?? plan ?? ownerResult ?? effect.result
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
const nodeTimes = new Map(), claimedNodes = new Map(), runAttempts = new Map()
let timingWatermark = 0
function refreshNodeTimes() {
  let rows
  do {
    rows = db.prepare("SELECT seq,kind,payload,created_at FROM execution_events WHERE seq>? AND kind IN ('node.claim','node.commit') ORDER BY seq LIMIT 1000").all(timingWatermark)
    for (const row of rows) {
      const result = JSON.parse(row.payload)
      if (row.kind === 'node.claim' && result.binding) {
        const node = result.binding
        claimedNodes.set(node.runId, node.nodeRunId)
        const timing = { nodeRunId: node.nodeRunId, leaseEpoch: node.leaseEpoch, startedAt: row.created_at, completedAt: null }
        nodeTimes.set(node.nodeRunId, timing)
        const attempts = runAttempts.get(node.runId) ?? []
        attempts.push(timing)
        runAttempts.set(node.runId, attempts)
      } else if (row.kind === 'node.commit' && result.run) {
        const timing = nodeTimes.get(claimedNodes.get(result.run.runId))
        if (timing) timing.completedAt = row.created_at
        claimedNodes.delete(result.run.runId)
      }
      timingWatermark = row.seq
    }
  } while (rows.length === 1000)
  timingWatermark = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM execution_events').get().seq
}
function timedNodeDto(node) {
  const timing = nodeTimes.get(node.node_run_id)
  return { ...nodeDto(node), startedAt: timing?.leaseEpoch === node.lease_epoch ? timing.startedAt : null,
    completedAt: timing?.leaseEpoch === node.lease_epoch ? timing.completedAt : null }
}
function taskOrigin(taskId, latest = false) {
  const row = db.prepare("SELECT payload FROM execution_events WHERE kind='task.web-rerun.accept' AND json_extract(payload,'$.taskId')=? ORDER BY seq LIMIT 1").get(taskId)
  if (row) {
    const event = JSON.parse(row.payload)
    return { channel: 'web', rerunOfTaskId: event.rerunOfTaskId, run: event.source,
      command: { kind: 'web-rerun', commandId: event.source.sourceKey, args: { taskId,
        arguments: { objective: event.source.request.objective, repositoryId: event.source.request.repositoryId,
          uatEnvironment: event.source.request.uatEnvironment } } } }
  }
  return queryMessages(db, { kind: latest ? 'message.task.latest' : 'message.task', taskId })
}
function webTaskEvent(eventId) {
  const row = db.prepare("SELECT payload FROM execution_events WHERE kind IN ('task.web-input.prepare','task.web-input.finish') AND json_extract(payload,'$.event.id')=? ORDER BY seq DESC LIMIT 1").get(eventId)
  return row ? JSON.parse(row.payload).event : null
}
// 从持久接受事件解析完整重执行关系，不能由最近一页 run 推断任务归属。
function taskFamilies() {
  const ids = db.prepare('SELECT task_id FROM business_tasks UNION SELECT task_id FROM task_owners UNION SELECT task_id FROM execution_runs').all().map(row => row.task_id)
  const known = new Set(ids), parents = new Map(), accepted = new Map()
  for (const row of db.prepare("SELECT seq,payload FROM execution_events WHERE kind='task.web-rerun.accept' ORDER BY seq").all()) {
    const event = JSON.parse(row.payload)
    if (!known.has(event.taskId) || !known.has(event.rerunOfTaskId) || parents.has(event.taskId)) fail('TASK_FAMILY_INVALID')
    parents.set(event.taskId, event.rerunOfTaskId); accepted.set(event.taskId, row.seq)
  }
  const groups = new Map()
  for (const taskId of ids) {
    const visited = new Set(); let root = taskId
    while (parents.has(root)) {
      if (visited.has(root)) fail('TASK_FAMILY_INVALID')
      visited.add(root); root = parents.get(root)
    }
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(taskId)
  }
  return [...groups].map(([rootTaskId, members]) => {
    const taskIds = members.sort((a, b) => a === rootTaskId ? -1 : b === rootTaskId ? 1 : accepted.get(a) - accepted.get(b))
    return { rootTaskId, taskIds, latestTaskId: taskIds.at(-1) }
  })
}
function taskFamily(taskId) {
  return taskFamilies().find(family => family.taskIds.includes(taskId)) ?? null
}
function assertTaskDrained(taskId, actorId, code) {
  const origin = taskOrigin(taskId)
  if (!origin) fail('WORKFLOW_TASK_NOT_FOUND')
  if (origin.channel === 'web' && origin.run.actorId !== actorId) fail('WORKFLOW_TASK_FORBIDDEN')
  const task = db.prepare('SELECT t.*,c.state AS control_state FROM business_tasks t JOIN task_controls c USING(task_id) WHERE task_id=?').get(taskId)
  const owner = db.prepare('SELECT task_id FROM task_owners WHERE task_id=?').get(taskId)
    ? queryTaskOwner(db, { kind: 'task.owner', taskId }) : null
  const ownerComplete = owner?.decision?.action === 'complete' && owner.applicationStatus === 'applied'
    && task?.plan_requirement_revision === task?.requirement_revision && owner.eventWatermark === owner.processedWatermark
  const runs = db.prepare('SELECT run_id,status FROM execution_runs WHERE task_id=?').all(taskId)
  const completed = task ? task.control_state === 'cancelled'
    || task.control_state === 'active' && (owner ? ownerComplete : task.status === 'succeeded')
    : runs.length > 0 && runs.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))
  if (owner?.status === 'running' || !completed) fail(`${code}_NOT_COMPLETED`)
  for (const run of runs) {
    if (!['succeeded', 'failed', 'cancelled'].includes(run.status)
      || db.prepare("SELECT 1 FROM execution_nodes WHERE run_id=? AND (status='running' OR (lease_epoch>0 AND drained=0)) LIMIT 1").get(run.run_id)) fail(`${code}_NOT_DRAINED`)
    assertRunEffectsDrained(db, run.run_id)
  }
}
function taskDeleted(taskId) {
  if (!taskId) return null
  return db.prepare("SELECT payload FROM execution_events WHERE kind='task.delete' ORDER BY seq DESC").all()
    .map(row => JSON.parse(row.payload)).find(item => item.taskId === taskId) ?? null
}
function inspectTaskDeletion({ taskId, actorId, expectedControlRevision }) {
  text(taskId,'taskId'); text(actorId,'actorId')
  const task = db.prepare('SELECT * FROM business_tasks JOIN task_controls USING(task_id) WHERE task_id=?').get(taskId)
  if (!task) fail('WORKFLOW_TASK_NOT_FOUND')
  if (task.control_revision !== expectedControlRevision) fail('TASK_DELETE_STALE')
  if (task.state !== 'cancelled') fail('TASK_DELETE_NOT_CANCELLED')
  assertTaskDrained(taskId,actorId,'TASK_DELETE')
  if (taskFamily(taskId)?.taskIds.length !== 1) fail('TASK_DELETE_DEPENDENCY')
  if (db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND (status IN ('running','candidate') OR application_status IN ('pending','blocked'))").get(taskId)
    || db.prepare("SELECT 1 FROM execution_inputs JOIN execution_runs USING(run_id) WHERE task_id=? AND execution_inputs.status='pending'").get(taskId)) fail('TASK_DELETE_NOT_DRAINED')
  if (db.prepare('SELECT 1 FROM execution_effects JOIN execution_runs USING(run_id) WHERE task_id=?').get(taskId)) fail('TASK_DELETE_EFFECTS')
  const commands = db.prepare("SELECT body FROM message_items WHERE kind='command'").all().map(row => JSON.parse(row.body))
  const commandIds = new Set(commands.filter(command => command.result?.taskId === taskId || command.args?.taskId === taskId).map(command => command.commandId))
  const notices = db.prepare("SELECT body FROM message_items WHERE kind='notification'").all().map(row => JSON.parse(row.body))
  if (notices.some(notice => !['delivered','superseded','failed'].includes(notice.status)
    && (commandIds.has(notice.commandId) || notice.payload?.fact?.taskId === taskId || notice.taskId === taskId))) fail('TASK_DELETE_NOTIFICATION_PENDING')
  const prefix = `tasks/${taskId}/`
  const references = db.prepare('SELECT requirement_ref AS ref FROM business_tasks WHERE task_id<>? UNION ALL SELECT requirement_ref FROM execution_runs WHERE task_id<>? UNION ALL SELECT predecessor_output_ref FROM task_plan_stages WHERE task_id<>? UNION ALL SELECT input_ref FROM execution_nodes JOIN execution_runs USING(run_id) WHERE task_id<>? UNION ALL SELECT execution_inputs.requirement_ref FROM execution_inputs JOIN execution_runs USING(run_id) WHERE task_id<>?').all(taskId,taskId,taskId,taskId,taskId)
  if (references.some(row => row.ref?.startsWith(prefix))) fail('TASK_DELETE_DEPENDENCY')
  return { taskId, actorId, controlRevision: expectedControlRevision,
    runIds: db.prepare('SELECT run_id FROM execution_runs WHERE task_id=?').all(taskId).map(row => row.run_id),
    retained: ['source-messages','command-receipts','audit-events','artifact-files','native-sessions'] }
}
function query(value) {
  if (value?.kind === 'node.recovery') { object(value, ['kind','runId']); return inspectNodeRecovery(value.runId) }
  if (value?.kind === 'node.recovery-context') {
    object(value, ['kind','nodeRunId','inputDigest','leaseEpoch'])
    const row = db.prepare("SELECT payload FROM execution_events WHERE kind='node.resume' AND json_extract(payload,'$.nodeRunId')=? AND json_extract(payload,'$.inputDigest')=? AND json_extract(payload,'$.nextLeaseEpoch')<=? ORDER BY seq DESC LIMIT 1")
      .get(text(value.nodeRunId, 'nodeRunId'), digest(value.inputDigest, 'inputDigest'), integer(value.leaseEpoch, 'leaseEpoch', 1))
    return row ? JSON.parse(row.payload) : null
  }
  if (value?.kind === 'task.delete.check') return inspectTaskDeletion(value)
  if (value?.kind === 'task.deleted') return taskDeleted(value.taskId)
  if (value?.kind === 'task.viewRevision') {
    object(value, ['kind', 'taskId'])
    const taskId = text(value.taskId, 'taskId')
    const plan = queryTaskPlan(db, { kind: 'task.plan', taskId })
    const owner = queryTaskOwner(db, { kind: 'task.owner', taskId })
    const currentRuns = plan && new Set(plan.stages.map(stage => stage.runId))
    const runs = db.prepare('SELECT * FROM execution_runs WHERE task_id=? ORDER BY rowid').all(taskId)
      .filter(row => !currentRuns || currentRuns.has(row.run_id))
      .map(row => ({ ...runDto(row), nodes: nodes(row.run_id).map(nodeDto),
        effects: queryEffects(db, { kind: 'effect.list', runId: row.run_id }) }))
    // 单个原生查询内读取全部版本依据；不包含随时钟变化的累计耗时。
    return createHash('sha256').update(canonical({ plan, owner, runs, family: taskFamily(taskId) })).digest('hex')
  }
  if (value?.kind === 'task.family') return taskFamily(text(value.taskId, 'taskId'))
  if (value?.kind === 'task.families') return taskFamilies()
  if (value?.kind === 'task.catalog') return db.prepare('SELECT task_id FROM business_tasks UNION SELECT task_id FROM task_owners UNION SELECT task_id FROM execution_runs').all()
    .filter(row => value.taskId === undefined || row.task_id === text(value.taskId, 'taskId')).map(row => ({
    taskId: row.task_id, runs: db.prepare('SELECT rowid AS sequence_id,* FROM execution_runs WHERE task_id=? ORDER BY rowid DESC').all(row.task_id)
      .map(run => ({ ...runDto(run), sequenceId: run.sequence_id }))
  }))
  if(value?.kind==='node.input-history')return nodeInputHistory(text(value.nodeRunId,'nodeRunId'))
  if(value?.kind==='node.binding-history')return db.prepare("SELECT payload FROM execution_events WHERE kind='node.claim' AND json_extract(payload,'$.binding.nodeRunId')=? ORDER BY seq").all(text(value.nodeRunId,'nodeRunId')).map(row=>JSON.parse(row.payload).binding)
  if (value?.kind === 'runtime.maintenance') return maintenanceStatus(db, workerData.processIncarnation)
  if (['workflow.repair.context', 'engineering.repair.context'].includes(value?.kind)) {
    const row = db.prepare("SELECT payload FROM execution_events WHERE kind IN ('workflow.repair.accepted','engineering.repair.accepted') AND json_extract(payload,'$.runId')=? AND json_extract(payload,'$.nextGeneration')=? ORDER BY seq DESC LIMIT 1").get(value.runId, value.generation)
    return row ? JSON.parse(row.payload) : null
  }
  if (value?.kind === 'task.archives') return db.prepare("SELECT payload FROM execution_events WHERE kind='task.archive' ORDER BY seq").all().flatMap(row => {
    const event = JSON.parse(row.payload)
    return (event.taskIds ?? [event.taskId]).map(taskId => ({ taskId, archivedAt: event.archivedAt, actorId: event.actorId }))
  })
  if (value?.kind === 'task.web-input') return webTaskEvent(value.eventId)
  if (value?.kind === 'task.stageConfirmation') {
    if (taskOrigin(value.taskId)?.channel !== 'web') return null
    const task = db.prepare('SELECT t.*,c.state AS control_state,c.control_revision FROM business_tasks t JOIN task_controls c ON c.task_id=t.task_id WHERE t.task_id=?').get(value.taskId)
    if (!task || task.control_state !== 'active' || task.status !== 'waiting_confirmation') return null
    const stages = db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position').all(value.taskId, task.plan_revision)
    const index = stages.findIndex(stage => !['succeeded', 'invalidated'].includes(stage.status))
    const stage = stages[index], previous = stages.slice(0, index)
    if (!stage || stage.status !== 'waiting_confirmation' || stage.gate !== 'confirmation'
      || !previous.length || previous.some(item => item.status !== 'succeeded') || !previous.at(-1).output_ref) return null
    return { requirementRevision: task.requirement_revision, controlRevision: task.control_revision,
      planRevision: task.plan_revision, runSequence: db.prepare('SELECT COUNT(*) AS n FROM execution_runs WHERE task_id=?').get(value.taskId).n,
      stageId: stage.stage_id, outputRef: previous.at(-1).output_ref }
  }
  if (value?.kind === 'task.web-inputs.pending') return db.prepare("SELECT DISTINCT json_extract(payload,'$.event.id') AS id FROM execution_events WHERE kind='task.web-input.prepare'").all()
    .map(row => webTaskEvent(row.id)).filter(event => event.status === 'pending')
  if (value?.kind === 'task.origin') return taskOrigin(value.taskId, value.latest === true)
  if (value?.kind === 'task.source') {
    return readCurrentTaskSource(db, value.sourceKey)
  }
  if (value?.kind === 'task.executionTiming') {
    object(value, ['kind', 'taskId']); text(value.taskId, 'taskId')
    refreshNodeTimes()
    const sampledAt = new Date().toISOString(), now = Date.parse(sampledAt), intervals = []
    let complete = true, running = false
    const taskRuns = db.prepare('SELECT run_id FROM execution_runs WHERE task_id=?').all(value.taskId)
    for (const run of taskRuns) {
      const attempts = runAttempts.get(run.run_id) ?? []
      const claimed = db.prepare('SELECT node_run_id,status,lease_epoch FROM execution_nodes WHERE run_id=? AND lease_epoch>0').all(run.run_id)
      if (claimed.some(node => !attempts.some(attempt => attempt.nodeRunId === node.node_run_id))) complete = false
      for (const attempt of attempts) {
        const active = !attempt.completedAt && claimed.some(node => node.node_run_id === attempt.nodeRunId && node.lease_epoch === attempt.leaseEpoch && node.status === 'running')
        const start = Date.parse(attempt.startedAt), end = active ? now : Date.parse(attempt.completedAt)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { complete = false; continue }
        running ||= active
        intervals.push([start, end])
      }
    }
    intervals.sort((a, b) => a[0] - b[0])
    let elapsedMs = 0, previousEnd = -Infinity
    for (const [start, end] of intervals) {
      elapsedMs += Math.max(0, end - Math.max(start, previousEnd))
      previousEnd = Math.max(previousEnd, end)
    }
    return { elapsedMs, sampledAt, running, complete }
  }
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
    refreshNodeTimes()
    return { run: runDto(run) ?? null, nodes: nodes(value.runId).map(timedNodeDto), inputs,
      pendingInputCount: inputs.filter(i => i.status === 'pending').length,
      ...(value.includeHistory ? { nodeHistory: db.prepare('SELECT * FROM execution_nodes WHERE run_id=? ORDER BY generation,position').all(value.runId).map(timedNodeDto) } : {}) }
  }
  if (value?.kind === 'receipt') {
    object(value, ['kind', 'commandId']); text(value.commandId, 'commandId')
    const r = db.prepare('SELECT result FROM execution_receipts WHERE command_id=?').get(value.commandId)
    return r ? { replayed: true, dispatchEligible: false, result: JSON.parse(r.result) } : null
  }
  const planResult = queryTaskPlan(db, value)
  if (planResult !== undefined) return planResult
  const ownerResult = queryTaskOwner(db, value)
  if (ownerResult !== undefined) return ownerResult
  const messageResult = queryMessages(db, value)
  if (messageResult !== undefined) return messageResult
  const result = queryEffects(db, value)
  if (value?.kind === 'approval.notice') return result
  if (result !== null && ['approval.get', 'approval.list'].includes(value?.kind)) {
    const approvals = Array.isArray(result) ? result : [result]
    const comments = new Map()
    const byRequest = new Map(approvals.map(item => [item.requestId, item]))
    for (const row of db.prepare("SELECT payload FROM execution_events WHERE kind='approval.decided' AND json_extract(payload,'$.requestId') IN (SELECT value FROM json_each(?)) ORDER BY seq")
      .all(JSON.stringify(approvals.map(item => item.requestId)))) {
      const event = JSON.parse(row.payload)
      const approval = byRequest.get(event.requestId)
      if (!comments.has(event.requestId) && approval.effectId === event.effectId
        && approval.decision === event.decision && approval.decidedBy === event.actorId
        && approval.decisionSource === event.source && typeof event.comment === 'string' && event.comment.trim())
        comments.set(event.requestId, event.comment)
    }
    const withComment = item => comments.has(item.requestId) ? { ...item, comment: comments.get(item.requestId) } : item
    return Array.isArray(result) ? approvals.map(withComment) : withComment(result)
  }

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
