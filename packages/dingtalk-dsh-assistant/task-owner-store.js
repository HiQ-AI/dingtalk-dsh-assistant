// Task Owner 的事件、租约和决定与执行账共用 SQLite 单写事务。
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) fail('TASK_OWNER_ID_INVALID')
  return value
}
const ref = value => {
  if (typeof value !== 'string' || !value || value.length > 4096 || /^[a-zA-Z]+:/.test(value)
    || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) fail('TASK_OWNER_REF_INVALID')
  return value
}
const revision = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('TASK_OWNER_REVISION_INVALID')
  return value
}
const exact = (value, allowed, required = allowed) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('TASK_OWNER_ARGUMENT_INVALID')
}
const json = value => JSON.stringify(value)
const decision = value => {
  exact(value, ['action', 'summary', 'evidenceRefs', 'appendStages', 'assessments'], ['action', 'summary', 'evidenceRefs'])
  if (!['advance', 'wait', 'complete', 'block'].includes(value.action)
    || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000
    || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 128) fail('TASK_OWNER_DECISION_INVALID')
  value.evidenceRefs.forEach(ref)
  if (value.assessments !== undefined) {
    if (value.action !== 'complete' || !Array.isArray(value.assessments) || !value.assessments.length || value.assessments.length > 32)
      fail('TASK_OWNER_DECISION_INVALID')
    for (const item of value.assessments) {
      exact(item, ['itemId', 'status', 'evidenceRefs'])
      id(item.itemId)
      if (item.status !== 'satisfied' || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length)
        fail('TASK_OWNER_DECISION_INVALID')
      item.evidenceRefs.forEach(ref)
    }
  }
  if (value.appendStages !== undefined) {
    if (value.action !== 'advance' || !Array.isArray(value.appendStages) || !value.appendStages.length || value.appendStages.length > 32)
      fail('TASK_OWNER_DECISION_INVALID')
    for (const stage of value.appendStages) {
      exact(stage, ['workflowId', 'gate', 'capabilityStep'], ['workflowId', 'gate'])
      id(stage.workflowId)
      if (!['none', 'confirmation'].includes(stage.gate)) fail('TASK_OWNER_DECISION_INVALID')
      if (stage.capabilityStep !== undefined) {
        if (stage.workflowId !== 'task-general-capability' || stage.gate !== 'none') fail('TASK_OWNER_DECISION_INVALID')
        exact(stage.capabilityStep, ['capabilityId', 'input', 'expectedEvidence'])
        id(stage.capabilityStep.capabilityId)
        if (!stage.capabilityStep.input || Object.getPrototypeOf(stage.capabilityStep.input) !== Object.prototype
          || typeof stage.capabilityStep.expectedEvidence !== 'string' || !stage.capabilityStep.expectedEvidence.trim()
          || json(stage.capabilityStep).length > 8000) fail('TASK_OWNER_DECISION_INVALID')
      } else if (stage.workflowId === 'task-general-capability') fail('TASK_OWNER_DECISION_INVALID')
    }
  }
  return value
}
const task = (db, taskId) => {
  const row = db.prepare(`SELECT t.task_id,t.requirement_revision,t.plan_revision,t.status AS plan_status,
    c.control_revision,c.state AS control_state FROM business_tasks t
    JOIN task_controls c ON c.task_id=t.task_id WHERE t.task_id=?`).get(id(taskId))
  if (!row) fail('TASK_OWNER_TASK_NOT_FOUND')
  return row
}
const owner = (db, taskId) => {
  const row = db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(id(taskId))
  if (!row) fail('TASK_OWNER_NOT_FOUND')
  return row
}
const ownerDto = (db, row) => {
  if (!row) return null
  const current = row.current_turn_id
    ? db.prepare('SELECT * FROM task_owner_turns WHERE turn_id=?').get(row.current_turn_id)
    : db.prepare("SELECT * FROM task_owner_turns WHERE task_id=? AND status='accepted' ORDER BY rowid DESC LIMIT 1").get(row.task_id)
  const t = task(db, row.task_id)
  return { taskId: row.task_id, sessionId: row.session_id, sessionBound: !!row.session_bound,
    ownerEpoch: row.owner_epoch,
    status: row.status, leaseEpoch: row.lease_epoch, eventWatermark: row.event_watermark,
    processedWatermark: row.processed_watermark, revision: row.revision,
    failureCount: row.failure_count, lastFailure: row.last_failure,
    requirementRevision: t.requirement_revision, planRevision: t.plan_revision,
    controlRevision: t.control_revision, authorizationRevision: row.authorization_revision,
    inputFenceRevision: row.input_fence_revision,
    turnId: row.current_turn_id, candidate: current?.candidate_json ? JSON.parse(current.candidate_json) : null,
    decision: current?.decision_json ? JSON.parse(current.decision_json) : null,
    applicationStatus: current?.application_status ?? null }
}
const versions = (db, row) => {
  const t = task(db, row.task_id)
  return { requirementRevision: t.requirement_revision, planRevision: t.plan_revision,
    controlRevision: t.control_revision, authorizationRevision: row.authorization_revision,
    inputFenceRevision: row.input_fence_revision }
}
const turn = (db, args) => {
  const o = owner(db, args.taskId)
  const t = db.prepare('SELECT * FROM task_owner_turns WHERE turn_id=? AND task_id=?').get(id(args.turnId), o.task_id)
  if (!t || o.current_turn_id !== t.turn_id || o.lease_epoch !== revision(args.leaseEpoch)) fail('TASK_OWNER_LEASE_STALE')
  return { owner: o, turn: t }
}

export function installTaskOwnerSchema(db) {
  db.exec(`
    CREATE TABLE task_owners(task_id TEXT PRIMARY KEY REFERENCES business_tasks(task_id),
      session_id TEXT NOT NULL UNIQUE,session_bound INTEGER NOT NULL DEFAULT 0 CHECK(session_bound IN (0,1)),
      owner_epoch INTEGER NOT NULL DEFAULT 1 CHECK(owner_epoch>0),
      status TEXT NOT NULL CHECK(status IN ('pending','running','idle','blocked')),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),last_failure TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
      event_watermark INTEGER NOT NULL DEFAULT 0 CHECK(event_watermark>=0),
      processed_watermark INTEGER NOT NULL DEFAULT 0 CHECK(processed_watermark>=0),
      current_turn_id TEXT,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      authorization_revision INTEGER NOT NULL DEFAULT 1 CHECK(authorization_revision>0),
      input_fence_revision INTEGER NOT NULL DEFAULT 0 CHECK(input_fence_revision>=0),
      updated_at TEXT NOT NULL,CHECK(processed_watermark<=event_watermark)) STRICT;
    CREATE TABLE task_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES task_owners(task_id),event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,payload_ref TEXT,created_at TEXT NOT NULL,
      handled_at TEXT,turn_id TEXT,UNIQUE(task_id,seq)) STRICT;
    CREATE INDEX task_events_pending ON task_events(task_id,seq) WHERE handled_at IS NULL;
    CREATE TABLE task_acceptance_items(task_id TEXT NOT NULL REFERENCES task_owners(task_id),
      item_id TEXT NOT NULL,criterion TEXT NOT NULL,source_key TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      PRIMARY KEY(task_id,item_id)) STRICT;
    CREATE TABLE task_owner_turns(turn_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES task_owners(task_id),
      lease_epoch INTEGER NOT NULL CHECK(lease_epoch>0),event_watermark INTEGER NOT NULL,
      requirement_revision INTEGER NOT NULL,plan_revision INTEGER NOT NULL,
      control_revision INTEGER NOT NULL,authorization_revision INTEGER NOT NULL,
      input_fence_revision INTEGER NOT NULL,snapshot_ref TEXT,
      candidate_json TEXT CHECK(candidate_json IS NULL OR json_valid(candidate_json)),
      decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
      status TEXT NOT NULL CHECK(status IN ('running','candidate','accepted','superseded','released')),
      application_status TEXT CHECK(application_status IN ('pending','applied','discarded','blocked')),
      application_failures INTEGER NOT NULL DEFAULT 0 CHECK(application_failures>=0),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE task_reports(report_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES task_owners(task_id),
      turn_id TEXT NOT NULL REFERENCES task_owner_turns(turn_id),report_type TEXT NOT NULL,
      facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),created_at TEXT NOT NULL) STRICT;
  `)
}

export function validateTaskOwnerSchema(db) {
  for (const sql of [
    'SELECT task_id,session_id,session_bound,owner_epoch,status,failure_count,last_failure,lease_epoch,event_watermark,processed_watermark,current_turn_id,revision,authorization_revision,input_fence_revision FROM task_owners LIMIT 0',
    'SELECT seq,task_id,event_key,event_type,payload_ref,handled_at,turn_id FROM task_events LIMIT 0',
    'SELECT task_id,item_id,criterion,source_key,active FROM task_acceptance_items LIMIT 0',
    'SELECT turn_id,task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,candidate_json,decision_json,status,application_status,application_failures FROM task_owner_turns LIMIT 0',
    'SELECT report_id,task_id,turn_id,report_type,facts_json FROM task_reports LIMIT 0',
  ]) db.prepare(sql).all()
  if (db.prepare(`SELECT task_id FROM task_owners WHERE processed_watermark>event_watermark
    OR (status='running' AND current_turn_id IS NULL)
    OR (session_bound=1 AND session_id='') LIMIT 1`).get()) fail('TASK_OWNER_INVARIANT_FAILED')
  if (db.prepare(`SELECT turn_id FROM task_owner_turns WHERE
    (status='accepted' AND (decision_json IS NULL OR application_status IS NULL))
    OR (status<>'accepted' AND application_status IS NOT NULL) LIMIT 1`).get()) fail('TASK_OWNER_INVARIANT_FAILED')
}

export function reduceTaskOwnerCommand(db, command, { now }) {
  const a = command.args
  if (command.kind === 'task.owner.init') {
    exact(a, ['taskId', 'sessionId', 'criteria', 'sourceKey']); task(db, a.taskId); id(a.sessionId); id(a.sourceKey)
    if (!Array.isArray(a.criteria) || !a.criteria.length || a.criteria.length > 16
      || a.criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) fail('TASK_OWNER_CRITERIA_INVALID')
    const existing = db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(a.taskId)
    if (existing) {
      if (existing.session_id !== a.sessionId) fail('TASK_OWNER_SESSION_CONFLICT')
      return { status: 'existing', owner: ownerDto(db, existing) }
    }
    db.prepare(`INSERT INTO task_owners(task_id,session_id,status,updated_at) VALUES(?,?,'pending',?)`)
      .run(a.taskId, a.sessionId, now)
    for (const [index, criterion] of a.criteria.entries())
      db.prepare('INSERT INTO task_acceptance_items(task_id,item_id,criterion,source_key) VALUES(?,?,?,?)')
        .run(a.taskId, `acceptance-${index + 1}`, criterion, a.sourceKey)
    return { status: 'applied', owner: ownerDto(db, owner(db, a.taskId)) }
  }
  if (command.kind === 'task.owner.acceptance.extend') {
    exact(a, ['taskId', 'itemId', 'criterion', 'sourceKey', 'eventKey'])
    owner(db, a.taskId); id(a.itemId); id(a.sourceKey); id(a.eventKey)
    if (typeof a.criterion !== 'string' || !a.criterion.trim() || a.criterion.length > 2000)
      fail('TASK_OWNER_CRITERIA_INVALID')
    const prior = db.prepare('SELECT * FROM task_acceptance_items WHERE task_id=? AND item_id=?').get(a.taskId, a.itemId)
    if (prior) {
      if (prior.criterion !== a.criterion || prior.source_key !== a.sourceKey) fail('TASK_OWNER_ACCEPTANCE_CONFLICT')
      return { status: 'existing', itemId: a.itemId }
    }
    db.prepare('INSERT INTO task_acceptance_items(task_id,item_id,criterion,source_key) VALUES(?,?,?,?)')
      .run(a.taskId, a.itemId, a.criterion, a.sourceKey)
    const eventSeq = Number(db.prepare(`INSERT INTO task_events(task_id,event_key,event_type,payload_ref,created_at)
      VALUES(?,?,'intent.received',NULL,?)`).run(a.taskId, a.eventKey, now).lastInsertRowid)
    db.prepare("UPDATE task_owners SET event_watermark=?,status=CASE WHEN status IN ('idle','blocked') THEN 'pending' ELSE status END,input_fence_revision=input_fence_revision+1,revision=revision+1,updated_at=? WHERE task_id=?")
      .run(eventSeq, now, a.taskId)
    return { status: 'applied', itemId: a.itemId }
  }
  if (command.kind === 'task.owner.replace-session') {
    exact(a, ['taskId', 'expectedLeaseEpoch', 'newSessionId', 'reason'])
    const o = owner(db, a.taskId)
    if (o.lease_epoch !== revision(a.expectedLeaseEpoch) || o.status === 'running'
      || !o.session_bound || a.reason !== 'SESSION_NOT_FOUND') fail('TASK_OWNER_REPLACEMENT_CONFLICT')
    id(a.newSessionId)
    if (a.newSessionId === o.session_id) fail('TASK_OWNER_REPLACEMENT_CONFLICT')
    db.prepare(`UPDATE task_owners SET session_id=?,session_bound=0,owner_epoch=owner_epoch+1,
      status='pending',failure_count=0,last_failure=NULL,revision=revision+1,updated_at=? WHERE task_id=?`)
      .run(a.newSessionId, now, o.task_id)
    const eventSeq = Number(db.prepare(`INSERT INTO task_events(task_id,event_key,event_type,payload_ref,created_at)
      VALUES(?,?,'session.replaced',NULL,?)`).run(o.task_id, a.newSessionId, now).lastInsertRowid)
    db.prepare('UPDATE task_owners SET event_watermark=? WHERE task_id=?').run(eventSeq, o.task_id)
    return { status: 'replaced', taskId: o.task_id, sessionId: a.newSessionId, ownerEpoch: o.owner_epoch + 1 }
  }
  if (command.kind === 'task.owner.event') {
    exact(a, ['taskId', 'eventKey', 'eventType', 'payloadRef'], ['taskId', 'eventKey', 'eventType'])
    const o = owner(db, a.taskId); id(a.eventKey); id(a.eventType)
    if (a.payloadRef !== undefined && a.payloadRef !== null) ref(a.payloadRef)
    const prior = db.prepare('SELECT * FROM task_events WHERE event_key=?').get(a.eventKey)
    if (prior) {
      if (prior.task_id !== a.taskId || prior.event_type !== a.eventType || prior.payload_ref !== (a.payloadRef ?? null))
        fail('TASK_OWNER_EVENT_CONFLICT')
      return { status: 'existing', eventSeq: prior.seq }
    }
    const eventSeq = Number(db.prepare('INSERT INTO task_events(task_id,event_key,event_type,payload_ref,created_at) VALUES(?,?,?,?,?)')
      .run(a.taskId, a.eventKey, a.eventType, a.payloadRef ?? null, now).lastInsertRowid)
    const fence = ['intent.received', 'source.corrected', 'control.changed', 'approval.resolved'].includes(a.eventType) ? 1 : 0
    const authorization = a.eventType === 'authorization.changed' ? 1 : 0
    db.prepare("UPDATE task_owners SET event_watermark=?,status=CASE WHEN status IN ('idle','blocked') THEN 'pending' ELSE status END,failure_count=CASE WHEN status='blocked' THEN 0 ELSE failure_count END,last_failure=CASE WHEN status='blocked' THEN NULL ELSE last_failure END,revision=revision+1,input_fence_revision=input_fence_revision+?,authorization_revision=authorization_revision+?,updated_at=? WHERE task_id=?")
      .run(eventSeq, fence, authorization, now, o.task_id)
    return { status: 'applied', eventSeq }
  }
  if (command.kind === 'task.owner.claim') {
    exact(a, ['taskId', 'turnId', 'expectedLeaseEpoch', 'snapshotRef'], ['taskId', 'turnId', 'expectedLeaseEpoch'])
    const o = owner(db, a.taskId); id(a.turnId); revision(a.expectedLeaseEpoch)
    if (a.snapshotRef !== undefined && a.snapshotRef !== null) ref(a.snapshotRef)
    if (o.lease_epoch !== a.expectedLeaseEpoch || o.status === 'running' || o.status === 'blocked'
      || o.processed_watermark === o.event_watermark) fail('TASK_OWNER_NOT_CLAIMABLE')
    const v = versions(db, o), epoch = o.lease_epoch + 1
    db.prepare(`INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,
      requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,
      snapshot_ref,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'running',?,?)`)
      .run(a.turnId, a.taskId, epoch, o.event_watermark, v.requirementRevision, v.planRevision,
        v.controlRevision, v.authorizationRevision, v.inputFenceRevision, a.snapshotRef ?? null, now, now)
    db.prepare("UPDATE task_owners SET status='running',lease_epoch=?,current_turn_id=?,revision=revision+1,updated_at=? WHERE task_id=?")
      .run(epoch, a.turnId, now, a.taskId)
    return { status: 'applied', turnId: a.turnId, leaseEpoch: epoch, eventWatermark: o.event_watermark,
      sessionId: o.session_id, sessionBound: !!o.session_bound, ownerEpoch: o.owner_epoch, versions: v }
  }
  if (command.kind === 'task.owner.sessionBound') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch', 'sessionId'])
    const { owner: o, turn: t } = turn(db, a)
    if (t.status !== 'running' || o.session_id !== id(a.sessionId)) fail('TASK_OWNER_BIND_CONFLICT')
    db.prepare('UPDATE task_owners SET session_bound=1,updated_at=? WHERE task_id=?').run(now, o.task_id)
    return { status: 'applied', sessionId: o.session_id, leaseEpoch: o.lease_epoch }
  }
  if (command.kind === 'task.owner.candidate') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch', 'decision'])
    const { turn: t } = turn(db, a)
    if (t.status !== 'running') fail('TASK_OWNER_CANDIDATE_CONFLICT')
    db.prepare("UPDATE task_owner_turns SET candidate_json=?,status='candidate',updated_at=? WHERE turn_id=?")
      .run(json(decision(a.decision)), now, t.turn_id)
    return { status: 'received', turnId: t.turn_id }
  }
  if (command.kind === 'task.owner.accept') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch'])
    const { owner: o, turn: t } = turn(db, a)
    if (t.status !== 'candidate' || !t.candidate_json || !o.session_bound) fail('TASK_OWNER_ACCEPT_CONFLICT')
    const v = versions(db, o)
    if (o.event_watermark !== t.event_watermark || v.requirementRevision !== t.requirement_revision
      || v.planRevision !== t.plan_revision || v.controlRevision !== t.control_revision
      || v.authorizationRevision !== t.authorization_revision || v.inputFenceRevision !== t.input_fence_revision)
      fail('TASK_OWNER_CANDIDATE_STALE')
    const chosen = JSON.parse(t.candidate_json)
    const currentTask = task(db, o.task_id)
    const activeStage = db.prepare(`SELECT status FROM task_plan_stages WHERE task_id=? AND plan_revision=?
      AND status<>'succeeded' AND status<>'invalidated' ORDER BY position LIMIT 1`)
      .get(o.task_id, currentTask.plan_revision)
    if (currentTask.control_state !== 'active') fail('TASK_OWNER_CONTROL_BLOCKED')
    if (chosen.appendStages?.some(stage => stage.workflowId === 'task-general-capability')
      && currentTask.plan_status !== 'succeeded') fail('TASK_OWNER_ADVANCE_CONFLICT')
    if (chosen.action === 'complete') {
      if (currentTask.plan_status !== 'succeeded' || chosen.appendStages !== undefined) fail('TASK_OWNER_COMPLETION_UNPROVEN')
      const stages = db.prepare('SELECT workflow_id,status,output_ref,evidence_refs FROM task_plan_stages WHERE task_id=? AND plan_revision=?')
        .all(o.task_id, currentTask.plan_revision)
      if (!stages.length || stages.some(stage => stage.status !== 'succeeded' || !stage.output_ref
        || !Array.isArray(JSON.parse(stage.evidence_refs)) || !JSON.parse(stage.evidence_refs).length))
        fail('TASK_OWNER_COMPLETION_UNPROVEN')
      const items = db.prepare('SELECT item_id FROM task_acceptance_items WHERE task_id=? AND active=1 ORDER BY rowid')
        .all(o.task_id).map(row => row.item_id)
      const assessments = chosen.assessments ?? []
      const knownEvidence = new Set(stages.flatMap(stage => [stage.output_ref, ...JSON.parse(stage.evidence_refs)]))
      if (stages.every(stage => stage.workflow_id === 'task-general-intake')
        || !items.length || assessments.length !== items.length
        || new Set(assessments.map(item => item.itemId)).size !== items.length
        || assessments.some(item => !items.includes(item.itemId)
          || item.evidenceRefs.some(evidence => !knownEvidence.has(evidence)))
        || chosen.evidenceRefs.some(evidence => !knownEvidence.has(evidence)))
        fail('TASK_OWNER_COMPLETION_UNPROVEN')
    } else if (chosen.action === 'advance' && (currentTask.plan_status === 'succeeded'
      || !['ready', 'running'].includes(activeStage?.status))) {
      const generalStep = chosen.appendStages?.length === 1
        && chosen.appendStages[0].workflowId === 'task-general-capability'
        && chosen.appendStages[0].capabilityStep
        && db.prepare(`SELECT 1 FROM task_plan_stages WHERE task_id=? AND plan_revision=?
          AND workflow_id IN ('task-general-intake','task-general-capability') LIMIT 1`)
          .get(o.task_id, currentTask.plan_revision)
      const continuation = currentTask.plan_status === 'succeeded' && chosen.appendStages?.length
        && (generalStep || db.prepare(`SELECT 1 FROM task_events WHERE task_id=? AND seq>? AND seq<=?
          AND event_type='intent.received' LIMIT 1`).get(o.task_id, o.processed_watermark, t.event_watermark))
      if (!continuation) fail('TASK_OWNER_ADVANCE_CONFLICT')
    } else if (chosen.action === 'wait' && !['ready', 'running', 'waiting_confirmation'].includes(activeStage?.status)) {
      fail('TASK_OWNER_WAIT_CONFLICT')
    } else if (chosen.action === 'block' && !['ready', 'running', 'waiting_confirmation', 'blocked'].includes(activeStage?.status)) {
      fail('TASK_OWNER_BLOCK_CONFLICT')
    }
    db.prepare("UPDATE task_owner_turns SET decision_json=candidate_json,status='accepted',application_status='pending',updated_at=? WHERE turn_id=?")
      .run(now, t.turn_id)
    db.prepare('UPDATE task_events SET handled_at=?,turn_id=? WHERE task_id=? AND seq<=? AND handled_at IS NULL')
      .run(now, t.turn_id, o.task_id, t.event_watermark)
    db.prepare("UPDATE task_owners SET status='idle',processed_watermark=?,current_turn_id=NULL,failure_count=0,last_failure=NULL,revision=revision+1,updated_at=? WHERE task_id=?")
      .run(t.event_watermark, now, o.task_id)
    db.prepare('INSERT INTO task_reports(report_id,task_id,turn_id,report_type,facts_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(`owner:${t.turn_id}`, o.task_id, t.turn_id, chosen.action, json({ summary: chosen.summary, evidenceRefs: chosen.evidenceRefs }), now)
    return { status: 'accepted', taskId: o.task_id, turnId: t.turn_id, decision: chosen,
      eventWatermark: t.event_watermark, reportId: `owner:${t.turn_id}`, applicationStatus: 'pending' }
  }
  if (command.kind === 'task.owner.applied') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch'], ['taskId', 'turnId'])
    const t = db.prepare('SELECT * FROM task_owner_turns WHERE task_id=? AND turn_id=?').get(id(a.taskId), id(a.turnId))
    if (!t || t.status !== 'accepted') fail('TASK_OWNER_ACTION_NOT_FOUND')
    if (a.leaseEpoch !== undefined && revision(a.leaseEpoch) !== t.lease_epoch) fail('TASK_OWNER_LEASE_STALE')
    if (t.application_status === 'applied') return { status: 'applied', taskId: a.taskId, turnId: a.turnId }
    db.prepare("UPDATE task_owner_turns SET application_status='applied',updated_at=? WHERE turn_id=?")
      .run(now, t.turn_id)
    return { status: 'applied', taskId: a.taskId, turnId: a.turnId }
  }
  if (command.kind === 'task.owner.discard') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch'])
    const t = db.prepare('SELECT * FROM task_owner_turns WHERE task_id=? AND turn_id=?').get(id(a.taskId), id(a.turnId))
    if (!t || t.status !== 'accepted' || revision(a.leaseEpoch) !== t.lease_epoch) fail('TASK_OWNER_ACTION_NOT_FOUND')
    if (t.application_status === 'discarded') return { status: 'discarded', taskId: a.taskId, turnId: a.turnId }
    if (t.application_status !== 'pending') fail('TASK_OWNER_ACTION_ALREADY_APPLIED')
    const o = owner(db, a.taskId), v = versions(db, o)
    if (o.event_watermark === t.event_watermark && v.requirementRevision === t.requirement_revision
      && v.planRevision === t.plan_revision && v.controlRevision === t.control_revision
      && v.authorizationRevision === t.authorization_revision && v.inputFenceRevision === t.input_fence_revision)
      fail('TASK_OWNER_ACTION_STILL_CURRENT')
    db.prepare("UPDATE task_owner_turns SET application_status='discarded',updated_at=? WHERE turn_id=?").run(now, t.turn_id)
    db.prepare("UPDATE task_owners SET status='pending',revision=revision+1,updated_at=? WHERE task_id=?").run(now, o.task_id)
    return { status: 'discarded', taskId: a.taskId, turnId: a.turnId }
  }
  if (command.kind === 'task.owner.action.fail') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch', 'reason'])
    const t = db.prepare('SELECT * FROM task_owner_turns WHERE task_id=? AND turn_id=?').get(id(a.taskId), id(a.turnId))
    if (!t || t.status !== 'accepted' || t.application_status !== 'pending'
      || revision(a.leaseEpoch) !== t.lease_epoch
      || typeof a.reason !== 'string' || !a.reason || a.reason.length > 200)
      fail('TASK_OWNER_ACTION_NOT_FOUND')
    const failures = t.application_failures + 1
    db.prepare('UPDATE task_owner_turns SET application_failures=?,application_status=?,updated_at=? WHERE turn_id=?')
      .run(failures, failures >= 3 ? 'blocked' : 'pending', now, t.turn_id)
    if (failures >= 3) db.prepare("UPDATE task_owners SET status='blocked',last_failure=?,revision=revision+1,updated_at=? WHERE task_id=?")
      .run(a.reason, now, a.taskId)
    return { status: failures >= 3 ? 'blocked' : 'retry', failureCount: failures }
  }
  if (command.kind === 'task.owner.release') {
    exact(a, ['taskId', 'turnId', 'leaseEpoch', 'reason'], ['taskId', 'turnId', 'leaseEpoch'])
    const { owner: o, turn: t } = turn(db, a)
    if (!['running', 'candidate'].includes(t.status)) fail('TASK_OWNER_RELEASE_CONFLICT')
    if (a.reason !== undefined && (typeof a.reason !== 'string' || !a.reason || a.reason.length > 200))
      fail('TASK_OWNER_ARGUMENT_INVALID')
    const counted = a.reason && a.reason !== 'TASK_OWNER_CANDIDATE_STALE'
    const failures = o.failure_count + (counted ? 1 : 0)
    db.prepare("UPDATE task_owner_turns SET status='released',updated_at=? WHERE turn_id=?").run(now, t.turn_id)
    db.prepare("UPDATE task_owners SET status=?,failure_count=?,last_failure=?,current_turn_id=NULL,revision=revision+1,updated_at=? WHERE task_id=?")
      .run(failures >= 3 ? 'blocked' : 'pending', failures, a.reason ?? null, now, o.task_id)
    return { status: failures >= 3 ? 'blocked' : 'released', taskId: o.task_id, failureCount: failures }
  }
  return null
}

export function queryTaskOwner(db, query) {
  if (query?.kind === 'task.owner.acceptance') {
    exact(query, ['kind', 'taskId'])
    return db.prepare('SELECT item_id,criterion,source_key FROM task_acceptance_items WHERE task_id=? AND active=1 ORDER BY rowid')
      .all(id(query.taskId)).map(row => ({ itemId: row.item_id, criterion: row.criterion, sourceKey: row.source_key }))
  }
  if (query?.kind === 'task.owners.list') {
    exact(query, ['kind', 'limit', 'beforeSequenceId'], ['kind'])
    const limit = query.limit ?? 100, before = query.beforeSequenceId ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before) || before < 1)
      fail('TASK_OWNER_ARGUMENT_INVALID')
    return db.prepare('SELECT rowid AS sequence_id,* FROM task_owners WHERE rowid<? ORDER BY rowid DESC LIMIT ?')
      .all(before, limit).map(row => ({ ...ownerDto(db, row), sequenceId: row.sequence_id }))
  }
  if (query?.kind === 'task.owner') {
    exact(query, ['kind', 'taskId'])
    return ownerDto(db, db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(id(query.taskId)))
  }
  if (query?.kind === 'task.owners.pending') {
    exact(query, ['kind', 'limit', 'beforeSequenceId'], ['kind'])
    const limit = query.limit ?? 100, before = query.beforeSequenceId ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before) || before < 1)
      fail('TASK_OWNER_ARGUMENT_INVALID')
    return db.prepare(`SELECT rowid AS sequence_id,* FROM task_owners WHERE rowid<?
      AND status='pending' AND processed_watermark<event_watermark ORDER BY rowid DESC LIMIT ?`)
      .all(before, limit).map(row => ({ ...ownerDto(db, row), sequenceId: row.sequence_id }))
  }
  if (query?.kind === 'task.owner.actions.pending') {
    exact(query, ['kind', 'limit', 'afterSequenceId'], ['kind'])
    const limit = query.limit ?? 100, after = query.afterSequenceId ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TASK_OWNER_ARGUMENT_INVALID')
    revision(after)
    return db.prepare(`SELECT rowid AS sequence_id,* FROM task_owner_turns WHERE rowid>?
      AND status='accepted' AND application_status='pending' ORDER BY rowid LIMIT ?`)
      .all(after, limit).map(row => ({ taskId: row.task_id, turnId: row.turn_id,
        leaseEpoch: row.lease_epoch, eventWatermark: row.event_watermark,
        requirementRevision: row.requirement_revision, planRevision: row.plan_revision,
        controlRevision: row.control_revision, authorizationRevision: row.authorization_revision,
        inputFenceRevision: row.input_fence_revision,
        decision: JSON.parse(row.decision_json), sequenceId: row.sequence_id }))
  }
  if (query?.kind === 'task.owner.events') {
    exact(query, ['kind', 'taskId', 'afterSequenceId', 'limit'], ['kind', 'taskId'])
    const limit = query.limit ?? 100, after = query.afterSequenceId ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('TASK_OWNER_ARGUMENT_INVALID')
    revision(after)
    return db.prepare(`SELECT seq,event_key,event_type,payload_ref,created_at,handled_at,turn_id
      FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?`).all(id(query.taskId), after, limit)
      .map(row => ({ eventSeq: row.seq, eventKey: row.event_key, eventType: row.event_type,
        payloadRef: row.payload_ref, createdAt: row.created_at, handledAt: row.handled_at, turnId: row.turn_id }))
  }
  if (query?.kind === 'task.owner.reports') {
    exact(query, ['kind', 'taskId'])
    return db.prepare(`SELECT r.*,t.application_status FROM task_reports r
      JOIN task_owner_turns t ON t.turn_id=r.turn_id WHERE r.task_id=? ORDER BY r.created_at,r.report_id`).all(id(query.taskId))
      .map(row => ({ reportId: row.report_id, taskId: row.task_id, turnId: row.turn_id,
        reportType: row.report_type, applicationStatus: row.application_status,
        triggerTypes: db.prepare('SELECT DISTINCT event_type FROM task_events WHERE turn_id=?')
          .all(row.turn_id).map(event => event.event_type),
        facts: JSON.parse(row.facts_json), createdAt: row.created_at }))
  }
  return undefined
}

export function recoverTaskOwners(db) {
  const active = db.prepare("SELECT task_id,current_turn_id FROM task_owners WHERE status='running'").all()
  for (const row of active) {
    db.prepare("UPDATE task_owner_turns SET status='superseded' WHERE turn_id=? AND status IN ('running','candidate')")
      .run(row.current_turn_id)
    db.prepare("UPDATE task_owners SET status='pending',current_turn_id=NULL,lease_epoch=lease_epoch+1,revision=revision+1 WHERE task_id=?")
      .run(row.task_id)
  }
  return { recovered: active.length }
}
