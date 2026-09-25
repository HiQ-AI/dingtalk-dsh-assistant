// 业务任务与执行 Run 的阶段账同属控制库事务，模型不能直接写入。
import { assertRunEffectsDrained } from './execution-effects.js'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const name = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) fail('TASK_PLAN_ID_INVALID')
  return value
}
const reference = value => {
  if (typeof value !== 'string' || !value || value.length > 4096 || /^[a-zA-Z]+:/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) fail('TASK_PLAN_REF_INVALID')
  return value
}
const hash = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('TASK_PLAN_DIGEST_INVALID')
  return value
}
const exact = (value, allowed) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) fail('TASK_PLAN_ARGUMENT_INVALID')
}
const natural = value => {
  if (!Number.isSafeInteger(value) || value < 1) fail('TASK_PLAN_REVISION_INVALID')
  return value
}
const stageDto = row => ({
  stageId: row.stage_id, position: row.position, workflowId: row.workflow_id, workflowDigest: row.workflow_digest,
  unavailableReason: row.unavailable_reason,
  requirementRef: row.requirement_ref, predecessorOutputRef: row.predecessor_output_ref,
  gate: row.gate, status: row.status, attempt: row.attempt,
  runId: row.run_id, outputRef: row.output_ref, evidenceRefs: JSON.parse(row.evidence_refs),
  confirmedOutputRef: row.confirmed_output_ref,
})
const taskDto = row => row && ({
  taskId: row.task_id, requirementRevision: row.requirement_revision, planRevision: row.plan_revision,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
})
const stageRows = (db, taskId, revision) => db.prepare(
  'SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position'
).all(taskId, revision)
const taskRow = (db, taskId) => db.prepare('SELECT * FROM business_tasks WHERE task_id=?').get(taskId)
const activeStage = rows => rows.find(stage => !['succeeded', 'invalidated'].includes(stage.status))

export function installTaskPlanSchema(db) {
  db.exec(`
    CREATE TABLE business_tasks(
      task_id TEXT PRIMARY KEY, requirement_revision INTEGER NOT NULL CHECK(requirement_revision>0),
      plan_revision INTEGER NOT NULL CHECK(plan_revision>0),
      status TEXT NOT NULL CHECK(status IN ('active','waiting_confirmation','succeeded','blocked')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE task_plan_stages(
      task_id TEXT NOT NULL REFERENCES business_tasks(task_id),
      plan_revision INTEGER NOT NULL CHECK(plan_revision>0),stage_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position>=0),workflow_id TEXT NOT NULL,
      workflow_digest TEXT,unavailable_reason TEXT,requirement_ref TEXT,predecessor_output_ref TEXT,
      gate TEXT NOT NULL CHECK(gate IN ('none','confirmation')),
      status TEXT NOT NULL CHECK(status IN ('ready','waiting_confirmation','running','succeeded','invalidated','blocked')),
      attempt INTEGER NOT NULL CHECK(attempt>0),run_id TEXT,
      output_ref TEXT,evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
      confirmed_output_ref TEXT,
      PRIMARY KEY(task_id,plan_revision,stage_id),UNIQUE(task_id,plan_revision,position),
      UNIQUE(task_id,plan_revision,run_id)
    ) STRICT;
    CREATE INDEX task_plan_stages_current ON task_plan_stages(task_id,plan_revision,status);
  `)
}

export function validateTaskPlanSchema(db) {
  for (const sql of [
    'SELECT task_id,requirement_revision,plan_revision,status,created_at,updated_at FROM business_tasks LIMIT 0',
    'SELECT task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,unavailable_reason,requirement_ref,predecessor_output_ref,gate,status,attempt,run_id,output_ref,evidence_refs,confirmed_output_ref FROM task_plan_stages LIMIT 0',
  ]) db.prepare(sql).all()
  const invalid = db.prepare(`SELECT t.task_id FROM business_tasks t
    LEFT JOIN task_plan_stages s ON s.task_id=t.task_id AND s.plan_revision=t.plan_revision
    GROUP BY t.task_id HAVING COUNT(s.stage_id)=0`).all()
  if (invalid.length) fail('TASK_PLAN_INVARIANT_FAILED')
}

export function queryTaskPlan(db, query) {
  if (query?.kind === 'task.plans.pending') {
    exact(query, ['kind', 'limit', 'beforeSequenceId'])
    const limit = query.limit ?? 100, before = query.beforeSequenceId ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || !Number.isSafeInteger(before) || before < 1) fail('TASK_PLAN_QUERY_INVALID')
    return db.prepare("SELECT rowid AS sequence_id,* FROM business_tasks WHERE rowid<? AND status<>'succeeded' ORDER BY rowid DESC LIMIT ?")
      .all(before, limit).map(row => ({ ...taskDto(row), sequenceId: row.sequence_id }))
  }
  if (query?.kind !== 'task.plan') return undefined
  exact(query, ['kind', 'taskId'])
  const taskId = name(query.taskId), task = taskRow(db, taskId)
  if (!task) return null
  return { task: taskDto(task), stages: stageRows(db, taskId, task.plan_revision).map(stageDto) }
}

function validateStages(stages) {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 32) fail('TASK_PLAN_STAGES_INVALID')
  const ids = new Set()
  stages.forEach((stage, index) => {
    exact(stage, ['stageId', 'workflowId', 'workflowDigest', 'unavailableReason', 'requirementRef', 'gate'])
    name(stage.stageId); name(stage.workflowId)
    if (stage.unavailableReason === null) {
      if (stage.workflowDigest !== null) hash(stage.workflowDigest)
      else if (index === 0 || stage.workflowId !== 'task-engineering') fail('TASK_STAGE_WORKFLOW_UNRESOLVED')
    } else {
      if (index === 0 || stage.workflowDigest !== null || typeof stage.unavailableReason !== 'string'
        || !stage.unavailableReason.trim() || stage.unavailableReason.length > 4096) fail('TASK_STAGE_CAPABILITY_INVALID')
    }
    if (stage.requirementRef !== null) reference(stage.requirementRef)
    if (ids.has(stage.stageId) || !['none', 'confirmation'].includes(stage.gate)
      || (index === 0 && stage.gate !== 'none')) fail('TASK_PLAN_STAGES_INVALID')
    ids.add(stage.stageId)
  })
}

function insertStages(db, taskId, revision, stages, previous = [], affectedFrom = 0) {
  stages.forEach((stage, position) => {
    const old = previous[position]
    const retained = position < affectedFrom && old && old.stage_id === stage.stageId
      && old.workflow_id === stage.workflowId && old.workflow_digest === stage.workflowDigest
      && old.requirement_ref === stage.requirementRef && old.gate === stage.gate
      && old.unavailable_reason === stage.unavailableReason && old.status === 'succeeded'
    if (position < affectedFrom && !retained) fail('TASK_PLAN_PREFIX_INVALID')
    if (!retained && (position === 0 ? stage.requirementRef === null : stage.requirementRef !== null)) fail('TASK_STAGE_INPUT_NOT_BOUND')
    db.prepare(`INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,unavailable_reason,requirement_ref,predecessor_output_ref,gate,status,attempt,run_id,output_ref,evidence_refs,confirmed_output_ref)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, revision, stage.stageId, position, stage.workflowId,
      stage.workflowDigest, stage.unavailableReason, stage.requirementRef, retained ? old.predecessor_output_ref : null, stage.gate,
      retained ? 'succeeded' : position === affectedFrom ? (stage.unavailableReason ? 'blocked' : stage.gate === 'confirmation' ? 'waiting_confirmation' : 'ready') : 'blocked',
      retained ? old.attempt : old?.stage_id === stage.stageId ? old.attempt + 1 : 1,
      retained ? old.run_id : null, retained ? old.output_ref : null,
      retained ? old.evidence_refs : '[]', retained ? old.confirmed_output_ref : null)
  })
}

export function reduceTaskPlanCommand(db, command, { now }) {
  const a = command.args
  if (command.kind === 'task.plan.extend') {
    exact(a, ['taskId', 'expectedPlanRevision', 'requirementRevision', 'stages'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.expectedPlanRevision) || task.status === 'succeeded'
      || a.requirementRevision !== task.requirement_revision + 1) fail('TASK_PLAN_STALE')
    const old = stageRows(db, taskId, task.plan_revision)
    if (!old.length || old.length + a.stages.length > 32) fail('TASK_PLAN_STAGES_INVALID')
    validateStages([...old.map(row => ({ stageId: row.stage_id, workflowId: row.workflow_id,
      workflowDigest: row.workflow_digest, unavailableReason: row.unavailable_reason,
      requirementRef: row.requirement_ref, gate: row.gate })), ...a.stages])
    if (a.stages.some(stage => stage.requirementRef !== null)) fail('TASK_STAGE_INPUT_NOT_BOUND')
    for (const [index, stage] of a.stages.entries()) {
      db.prepare(`INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,unavailable_reason,requirement_ref,gate,status,attempt)
        VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(taskId, task.plan_revision, stage.stageId, old.length + index,
        stage.workflowId, stage.workflowDigest, stage.unavailableReason, null, stage.gate, 'blocked')
    }
    db.prepare('UPDATE business_tasks SET requirement_revision=?,updated_at=? WHERE task_id=?')
      .run(a.requirementRevision, now, taskId)
    return { status: 'applied', taskId, planRevision: task.plan_revision, appendedStageIds: a.stages.map(stage => stage.stageId) }
  }
  if (command.kind === 'task.plan.adopt') {
    exact(a, ['taskId', 'runId', 'stageId'])
    const taskId = name(a.taskId), runId = name(a.runId), stageId = name(a.stageId)
    if (taskRow(db, taskId)) fail('TASK_PLAN_EXISTS')
    const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=? AND task_id=?').get(runId, taskId)
    if (!run || run.status !== 'succeeded' || db.prepare("SELECT run_id FROM execution_runs WHERE task_id=? AND run_id<>? AND status NOT IN ('succeeded','failed','cancelled')").get(taskId, runId)
      || db.prepare("SELECT input_id FROM execution_inputs WHERE run_id=? AND status='pending'").get(runId)) fail('TASK_LEGACY_ADOPTION_UNSAFE')
    const current = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(runId)
    const last = current.at(-1)
    if (!last || current.some(node => node.status !== 'succeeded' || !node.drained)
      || !last.output_ref || !JSON.parse(last.evidence_refs).length) fail('TASK_LEGACY_ADOPTION_UNSAFE')
    assertRunEffectsDrained(db, runId)
    db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,status,created_at,updated_at) VALUES(?,1,1,'succeeded',?,?)")
      .run(taskId, now, now)
    db.prepare(`INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,unavailable_reason,
      requirement_ref,predecessor_output_ref,gate,status,attempt,run_id,output_ref,evidence_refs,confirmed_output_ref)
      VALUES(?,1,?,0,?,?,NULL,?,NULL,'none','succeeded',1,?,?,?,NULL)`)
      .run(taskId, stageId, run.workflow_id, run.workflow_digest, run.requirement_ref, runId, last.output_ref, last.evidence_refs)
    return { status: 'applied', taskId, planRevision: 1, stageId, outputRef: last.output_ref }
  }
  if (command.kind === 'task.plan.create') {
    exact(a, ['taskId', 'requirementRevision', 'stages'])
    const taskId = name(a.taskId); natural(a.requirementRevision); validateStages(a.stages)
    if (taskRow(db, taskId)) fail('TASK_PLAN_EXISTS')
    // 已有单 Run 任务由显式迁移接管；不能在仍有活动 Run 时另建控制计划。
    if (db.prepare('SELECT run_id FROM execution_runs WHERE task_id=? LIMIT 1').get(taskId)) fail('TASK_PLAN_LEGACY_RUN_EXISTS')
    db.prepare("INSERT INTO business_tasks(task_id,requirement_revision,plan_revision,status,created_at,updated_at) VALUES(?,?,1,'active',?,?)")
      .run(taskId, a.requirementRevision, now, now)
    insertStages(db, taskId, 1, a.stages)
    return { status: 'applied', taskId, planRevision: 1 }
  }
  if (command.kind === 'task.plan.confirm') {
    exact(a, ['taskId', 'planRevision', 'stageId', 'outputRef'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.planRevision)) fail('TASK_PLAN_STALE')
    const row = stageRows(db, taskId, task.plan_revision).find(stage => stage.stage_id === name(a.stageId))
    if (!row || row.status !== 'waiting_confirmation' || row.gate !== 'confirmation') fail('TASK_CONFIRMATION_NOT_WAITING')
    reference(a.outputRef)
    const prior = stageRows(db, taskId, task.plan_revision).filter(stage => stage.position < row.position)
    if (prior.some(stage => stage.status !== 'succeeded') || prior.at(-1)?.output_ref !== a.outputRef) fail('TASK_CONFIRMATION_OUTPUT_STALE')
    db.prepare("UPDATE task_plan_stages SET status='ready',confirmed_output_ref=? WHERE task_id=? AND plan_revision=? AND stage_id=?")
      .run(a.outputRef, taskId, task.plan_revision, row.stage_id)
    db.prepare("UPDATE business_tasks SET status='active',updated_at=? WHERE task_id=?").run(now, taskId)
    return { status: 'applied', taskId, stageId: row.stage_id }
  }
  if (command.kind === 'task.stage.input.bind') {
    exact(a, ['taskId', 'planRevision', 'stageId', 'predecessorOutputRef', 'requirementRef', 'workflowId', 'workflowDigest'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.planRevision)) fail('TASK_PLAN_STALE')
    const rows = stageRows(db, taskId, task.plan_revision)
    const row = rows.find(stage => stage.stage_id === name(a.stageId))
    if (!row || row.position === 0 || row.status !== 'ready' || row.requirement_ref !== null) fail('TASK_STAGE_INPUT_BIND_CONFLICT')
    reference(a.predecessorOutputRef); reference(a.requirementRef)
    const predecessor = rows[row.position - 1]
    if (predecessor.status !== 'succeeded' || predecessor.output_ref !== a.predecessorOutputRef
      || (row.gate === 'confirmation' && row.confirmed_output_ref !== a.predecessorOutputRef)) fail('TASK_STAGE_PREDECESSOR_STALE')
    if (row.workflow_digest === null) {
      if (row.workflow_id !== 'task-engineering' || !name(a.workflowId).startsWith('task-engineering-')) fail('TASK_STAGE_WORKFLOW_UNRESOLVED')
      hash(a.workflowDigest)
    } else if (a.workflowId !== undefined || a.workflowDigest !== undefined) fail('TASK_STAGE_WORKFLOW_CONFLICT')
    db.prepare('UPDATE task_plan_stages SET requirement_ref=?,predecessor_output_ref=?,workflow_id=?,workflow_digest=? WHERE task_id=? AND plan_revision=? AND stage_id=?')
      .run(a.requirementRef, a.predecessorOutputRef, a.workflowId ?? row.workflow_id, a.workflowDigest ?? row.workflow_digest,
        taskId, task.plan_revision, row.stage_id)
    return { status: 'applied', taskId, stageId: row.stage_id, requirementRef: a.requirementRef }
  }
  if (command.kind === 'task.stage.complete') {
    exact(a, ['taskId', 'planRevision', 'stageId', 'runId'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.planRevision)) fail('TASK_PLAN_STALE')
    const rows = stageRows(db, taskId, task.plan_revision), row = rows.find(stage => stage.stage_id === name(a.stageId))
    if (!row || row.status !== 'running' || row.run_id !== name(a.runId)) fail('TASK_STAGE_NOT_RUNNING')
    const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(row.run_id)
    if (!run || run.status !== 'succeeded' || run.task_id !== taskId || run.workflow_digest !== row.workflow_digest) fail('TASK_STAGE_RUN_INCOMPLETE')
    const last = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position DESC LIMIT 1').get(row.run_id)
    if (!last || last.status !== 'succeeded' || !last.output_ref || !last.drained) fail('TASK_STAGE_OUTPUT_MISSING')
    const evidenceRefs = JSON.parse(last.evidence_refs)
    if (!evidenceRefs.length) fail('TASK_STAGE_EVIDENCE_MISSING')
    db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref=?,evidence_refs=? WHERE task_id=? AND plan_revision=? AND stage_id=?")
      .run(last.output_ref, last.evidence_refs, taskId, task.plan_revision, row.stage_id)
    const next = rows[row.position + 1]
    if (next) {
      const status = next.unavailable_reason ? 'blocked' : next.gate === 'confirmation' ? 'waiting_confirmation' : 'ready'
      db.prepare('UPDATE task_plan_stages SET status=? WHERE task_id=? AND plan_revision=? AND stage_id=?')
        .run(status, taskId, task.plan_revision, next.stage_id)
      db.prepare('UPDATE business_tasks SET status=?,updated_at=? WHERE task_id=?')
        .run(next.unavailable_reason ? 'blocked' : next.gate === 'confirmation' ? 'waiting_confirmation' : 'active', now, taskId)
    } else db.prepare("UPDATE business_tasks SET status='succeeded',updated_at=? WHERE task_id=?").run(now, taskId)
    return { status: 'applied', taskId, stageId: row.stage_id, outputRef: last.output_ref, nextStageId: next?.stage_id ?? null }
  }
  if (command.kind === 'task.stage.block') {
    exact(a, ['taskId', 'planRevision', 'stageId', 'runId'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.planRevision)) fail('TASK_PLAN_STALE')
    const row = stageRows(db, taskId, task.plan_revision).find(stage => stage.stage_id === name(a.stageId))
    if (!row || row.status !== 'running' || row.run_id !== name(a.runId)) fail('TASK_STAGE_NOT_RUNNING')
    const run = db.prepare('SELECT status FROM execution_runs WHERE run_id=? AND task_id=?').get(row.run_id, taskId)
    if (!run || !['failed', 'cancelled'].includes(run.status)) fail('TASK_STAGE_RUN_NOT_TERMINAL')
    db.prepare("UPDATE task_plan_stages SET status='blocked' WHERE task_id=? AND plan_revision=? AND stage_id=?")
      .run(taskId, task.plan_revision, row.stage_id)
    db.prepare("UPDATE business_tasks SET status='blocked',updated_at=? WHERE task_id=?").run(now, taskId)
    return { status: 'applied', taskId, stageId: row.stage_id, runStatus: run.status }
  }
  if (command.kind === 'task.plan.revise') {
    exact(a, ['taskId', 'expectedPlanRevision', 'requirementRevision', 'affectedFrom', 'stages'])
    const taskId = name(a.taskId), task = taskRow(db, taskId)
    if (!task || task.plan_revision !== natural(a.expectedPlanRevision) || a.requirementRevision < task.requirement_revision) fail('TASK_PLAN_STALE')
    natural(a.requirementRevision); validateStages(a.stages)
    const old = stageRows(db, taskId, task.plan_revision), affectedFrom = a.affectedFrom
    if (!Number.isSafeInteger(affectedFrom) || affectedFrom < 0 || affectedFrom >= a.stages.length || affectedFrom > old.length) fail('TASK_PLAN_IMPACT_INVALID')
    if (old.some(stage => stage.status === 'running')) fail('TASK_STAGE_STILL_RUNNING')
    // 已有外部效果必须先由 ExecutionRun 排空/对账；当前修订只允许成功前缀后继续。
    if (old.slice(affectedFrom).some(stage => stage.run_id && !['succeeded', 'blocked'].includes(stage.status))) fail('TASK_STAGE_RECONCILIATION_REQUIRED')
    if (old.slice(0, affectedFrom).some(stage => stage.status !== 'succeeded')) fail('TASK_PLAN_PREFIX_INVALID')
    const revision = task.plan_revision + 1
    insertStages(db, taskId, revision, a.stages, old, affectedFrom)
    db.prepare('UPDATE business_tasks SET requirement_revision=?,plan_revision=?,status=?,updated_at=? WHERE task_id=?')
      .run(a.requirementRevision, revision, a.stages[affectedFrom].unavailableReason ? 'blocked'
        : a.stages[affectedFrom].gate === 'confirmation' ? 'waiting_confirmation' : 'active', now, taskId)
    return { status: 'applied', taskId, planRevision: revision, retainedStageIds: old.slice(0, affectedFrom).map(stage => stage.stage_id) }
  }
  return null
}

// 与 run.create 在同一事务内调用；失败则 Run 和阶段状态均回滚。
export function bindRunToTaskStage(db, binding, run) {
  exact(binding, ['planRevision', 'stageId', 'attempt'])
  const task = taskRow(db, run.taskId), rows = task && stageRows(db, run.taskId, task.plan_revision)
  const row = rows?.find(stage => stage.stage_id === name(binding.stageId))
  if (!task || task.plan_revision !== natural(binding.planRevision) || task.status !== 'active'
    || !row || row.status !== 'ready' || row.attempt !== natural(binding.attempt)
    || row.requirement_ref === null || row.unavailable_reason !== null
    || row.workflow_id !== run.workflowId || row.workflow_digest !== run.workflowDigest
    || row.requirement_ref !== run.requirementRef
    || rows.some(stage => stage.position < row.position && stage.status !== 'succeeded')
    || (row.position > 0 && row.predecessor_output_ref !== rows[row.position - 1].output_ref)
    || activeStage(rows)?.stage_id !== row.stage_id) fail('TASK_STAGE_START_CONFLICT')
  db.prepare("UPDATE task_plan_stages SET status='running',run_id=? WHERE task_id=? AND plan_revision=? AND stage_id=?")
    .run(run.runId, run.taskId, task.plan_revision, row.stage_id)
}
