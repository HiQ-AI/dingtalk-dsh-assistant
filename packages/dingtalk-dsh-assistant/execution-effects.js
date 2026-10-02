import { createHash, randomUUID } from 'node:crypto'

// 受信 Host 内部 reducer：事务、命令回执及认证入口归 ControlStore/适配器。
// 每张许可只授予一次 dispatchEligible；可信未发送证明可在新lease恢复同效果。
// 本模块不启动进程、不发网络请求、不声称 OS 隔离。
const ACTIVE = ['starting', 'executing', 'unknown']
const TERMINAL = ['succeeded', 'failed']
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }) }
const text = (value, name) => {
  if (typeof value !== 'string' || !value || value !== value.trim()) fail('effect_invalid_argument', name)
  return value
}
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('effect_invalid_argument', name)
  return value
}
const object = (value, name) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('effect_invalid_argument', name)
  return value
}
const stable = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(stable)
  object(value, 'JSON value')
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}
const encode = value => JSON.stringify(stable(value))
const digest = value => createHash('sha256').update(encode(value)).digest('hex')
const strings = (value, name) => {
  if (!Array.isArray(value) || !value.length) fail('effect_invalid_argument', name)
  return [...new Set(value.map(item => text(item, name)))].sort()
}
const changed = result => ({ result, dispatchEligible: false })

const COLUMNS = {
  execution_effects: ['effect_id', 'kind', 'run_id', 'node_run_id', 'node_id', 'generation', 'input_digest', 'definition_digest', 'definition_json', 'resource_keys_json', 'authorization_ref', 'request_id', 'launch_nonce', 'state', 'dispatch_lease_epoch', 'dispatch_safety_epoch', 'identity_json', 'result_json', 'created_at', 'updated_at'],
  execution_approvals: ['request_id', 'effect_id', 'approver_ids_json', 'decision', 'decided_by', 'decision_source', 'revoked', 'revoked_by', 'revoke_source', 'created_at', 'updated_at'],
  execution_resource_holds: ['resource_key', 'effect_id'],
  execution_effect_observations: ['receipt_id', 'effect_id', 'payload_digest', 'payload_json', 'created_at'],
  execution_safety_fences: ['scope', 'scope_key', 'epoch', 'reason', 'created_at'],
}

export function installEffectsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_effects (
      effect_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('operation','job')),
      run_id TEXT NOT NULL REFERENCES execution_runs(run_id),
      node_run_id TEXT NOT NULL REFERENCES execution_nodes(node_run_id), node_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>=0), input_digest TEXT NOT NULL,
      definition_digest TEXT NOT NULL, definition_json TEXT NOT NULL, resource_keys_json TEXT NOT NULL,
      authorization_ref TEXT, request_id TEXT UNIQUE, launch_nonce TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','starting','executing','unknown','succeeded','failed')),
      dispatch_lease_epoch INTEGER, dispatch_safety_epoch INTEGER, identity_json TEXT, result_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK((authorization_ref IS NULL) != (request_id IS NULL)),
      CHECK((kind='job' AND launch_nonce IS NOT NULL) OR (kind='operation' AND launch_nonce IS NULL))
    );
    CREATE INDEX IF NOT EXISTS execution_effects_run ON execution_effects(run_id,state);
    CREATE TABLE IF NOT EXISTS execution_approvals (
      request_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE REFERENCES execution_effects(effect_id),
      approver_ids_json TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected')),
      decided_by TEXT, decision_source TEXT, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
      revoked_by TEXT, revoke_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_resource_holds (
      resource_key TEXT PRIMARY KEY, effect_id TEXT NOT NULL REFERENCES execution_effects(effect_id)
    );
    CREATE INDEX IF NOT EXISTS execution_holds_effect ON execution_resource_holds(effect_id);
    CREATE TABLE IF NOT EXISTS execution_effect_observations (
      receipt_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL REFERENCES execution_effects(effect_id),
      payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_safety_fences (
      scope TEXT NOT NULL CHECK(scope IN ('global','run','resource','principal')), scope_key TEXT NOT NULL,
      epoch INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,scope_key)
    );
  `)
}

export function validateEffectsSchema(db) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
    if (columns.some(column => !existing.has(column))) fail('effect_schema_invalid', table)
  }
  // 严格启动不能用 CREATE 补齐，也不能把漏掉的占用当作空闲。
  for (const row of db.prepare('SELECT * FROM execution_effects').all()) {
    const held = db.prepare('SELECT resource_key FROM execution_resource_holds WHERE effect_id=? ORDER BY resource_key').all(row.effect_id).map(item => item.resource_key)
    const expected = ACTIVE.includes(row.state) ? JSON.parse(row.resource_keys_json) : []
    if (encode(held) !== encode(expected)) fail('effect_resource_invariant', row.effect_id)
    if (row.request_id && !db.prepare('SELECT 1 FROM execution_approvals WHERE request_id=? AND effect_id=?').get(row.request_id, row.effect_id)) fail('effect_approval_invariant', row.effect_id)
  }
}

function effectRow(db, id) {
  const row = db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(text(id, 'effectId'))
  if (!row) fail('effect_not_found')
  return row
}

function effectDto(row) {
  return {
    effectId: row.effect_id, kind: row.kind, runId: row.run_id, nodeRunId: row.node_run_id, nodeId: row.node_id,
    generation: row.generation, inputDigest: row.input_digest, definitionDigest: row.definition_digest,
    definition: JSON.parse(row.definition_json), resourceKeys: JSON.parse(row.resource_keys_json),
    authorizationRef: row.authorization_ref, requestId: row.request_id, launchNonce: row.launch_nonce,
    state: row.state, dispatchLeaseEpoch: row.dispatch_lease_epoch, dispatchSafetyEpoch: row.dispatch_safety_epoch,
    identity: row.identity_json ? JSON.parse(row.identity_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  }
}

function approvalRow(db, id) {
  const row = db.prepare('SELECT * FROM execution_approvals WHERE request_id=?').get(text(id, 'requestId'))
  if (!row) fail('approval_not_found')
  return row
}

function approvalDto(row) {
  return { requestId: row.request_id, effectId: row.effect_id, approverIds: JSON.parse(row.approver_ids_json),
    decision: row.decision, decidedBy: row.decided_by, decisionSource: row.decision_source,
    revoked: !!row.revoked, revokedBy: row.revoked_by, revokeSource: row.revoke_source,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

function approvalNoticeLifecycle(db, effect) {
  const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(effect.run_id)
  const node = db.prepare('SELECT * FROM execution_nodes WHERE node_run_id=?').get(effect.node_run_id)
  const task = run?.task_id && db.prepare('SELECT t.status,c.state FROM business_tasks t JOIN task_controls c USING(task_id) WHERE task_id=?').get(run.task_id)
  const invalid = !run || run.stop_requested || ['succeeded','failed','cancelled'].includes(run.status)
    || run.generation !== effect.generation || !node || !node.current || node.generation !== effect.generation
    || node.input_digest !== effect.input_digest || task && (['cancelling','cancelled'].includes(task.state) || ['succeeded','completed','cancelling','cancelled'].includes(task.status))
    || task && !db.prepare("SELECT 1 FROM task_plan_stages WHERE task_id=? AND plan_revision=(SELECT plan_revision FROM business_tasks WHERE task_id=?) AND run_id=? AND status='running'").get(run.task_id, run.task_id, run.run_id)
  return { invalid: !!invalid, paused: !!run?.pause_requested || !!task && task.state !== 'active' }
}

function approvalNotice(db, requestId) {
  const row = db.prepare(`SELECT payload FROM execution_events WHERE kind IN
    ('approval.notice.prepare','approval.notice.send','approval.notice.receipt','approval.notice.delivered','approval.notice.recalled','approval.notice.unsent')
    AND json_extract(payload,'$.requestId')=? ORDER BY seq DESC LIMIT 1`).get(text(requestId, 'requestId'))
  if (!row) return null
  const notice = JSON.parse(row.payload), approval = approvalRow(db, requestId)
  const effect = effectRow(db, notice.effectId)
  if (approval.effect_id !== notice.effectId || effect.request_id !== requestId
    || !JSON.parse(approval.approver_ids_json).includes(notice.approverActorId)) fail('approval_notice_identity_conflict')
  if (notice.status === 'waiting-reply' && (approval.decision !== 'pending' || approval.revoked || effect.state !== 'prepared' || approvalNoticeLifecycle(db, effect).invalid))
    return { ...notice, status: 'recall-required' }
  return notice
}

function approvalNoticeCommand(db, args, context, action) {
  const fields = {
    prepare: ['requestId','effectId','recipientUserId','approverActorId','text'],
    send: ['requestId','noticeDigest'], receipt: ['requestId','noticeDigest','openTaskId'],
    unsent: ['requestId','noticeDigest','proof'],
    delivered: ['requestId','noticeDigest','conversationId','messageId','openTaskId','sentAt'],
    recalled: ['requestId','noticeDigest','conversationId','messageId','recalledAt'],
  }[action]
  const required = action === 'delivered' ? fields.slice(0, 4) : action === 'recalled' ? fields.slice(0, 4) : fields
  if (Object.keys(args).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(args, key))) fail('effect_invalid_argument')
  const requestId = text(args.requestId, 'requestId'), approval = approvalRow(db, requestId)
  const effect = effectRow(db, approval.effect_id), pending = approval.decision === 'pending' && !approval.revoked && effect.state === 'prepared'
  const previous = approvalNotice(db, requestId)
  let notice
  if (action === 'prepare') {
    const frozen = Object.fromEntries(fields.map(key => [key, text(args[key], key)]))
    if (frozen.text.length > 24000 || frozen.effectId !== approval.effect_id || effect.request_id !== requestId
      || !JSON.parse(approval.approver_ids_json).includes(frozen.approverActorId)) fail('approval_notice_identity_conflict')
    const noticeDigest = digest(frozen)
    if (previous) {
      if (previous.digest !== noticeDigest) fail('approval_notice_identity_conflict')
      return changed({ notice: previous, applied: false })
    }
    if (!pending) fail('approval_notice_not_pending')
    notice = { ...frozen, digest: noticeDigest, status: 'prepared', createdAt: context.now, updatedAt: context.now, delivery: {} }
  } else {
    if (!previous) fail('approval_notice_not_found')
    if (text(args.noticeDigest, 'noticeDigest') !== previous.digest) fail('approval_notice_identity_conflict')
    if (action === 'send') {
      if (previous.status !== 'prepared') return changed({ notice: previous, applied: false })
      if (!pending) fail('approval_notice_not_pending')
      const lifecycle = approvalNoticeLifecycle(db, effect)
      if (lifecycle.invalid || lifecycle.paused) return changed({ notice: previous, applied: false })
      notice = { ...previous, status: 'unknown', updatedAt: context.now }
    } else if (action === 'unsent') {
      const proof = object(args.proof, 'proof')
      const proofFields = ['kind','idempotencyKey','serverErrorCode','errorMessage','traceId']
      if (Object.keys(proof).some(key => !proofFields.includes(key)) || proofFields.some(key => typeof proof[key] !== 'string')) fail('approval_notice_unsent_not_proven')
      const key = `workflow-approval:${requestId}:${previous.digest}`
      const expectedError = `sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is ${key.length}.`
      if (proof.kind !== 'dws-uuid-rejected' || proof.idempotencyKey !== key || key.length <= 128
        || proof.serverErrorCode !== '1001' || proof.errorMessage !== expectedError || !/^[a-zA-Z0-9]{16,128}$/.test(proof.traceId)
        || previous.unsentProof?.traceId === proof.traceId || previous.status !== 'unknown' || Object.keys(previous.delivery).length || !pending) fail('approval_notice_unsent_not_proven')
      notice = { ...previous, status: 'prepared', updatedAt: context.now, unsentProof: { ...proof } }
    } else if (action === 'receipt') {
      const openTaskId = text(args.openTaskId, 'openTaskId')
      if (previous.delivery.openTaskId && previous.delivery.openTaskId !== openTaskId) fail('approval_notice_delivery_conflict')
      if (previous.status !== 'unknown') {
        if (previous.delivery.openTaskId === openTaskId) return changed({ notice: previous, applied: false })
        fail('approval_notice_send_required')
      }
      if (previous.delivery.openTaskId === openTaskId) return changed({ notice: previous, applied: false })
      notice = { ...previous, updatedAt: context.now, delivery: { ...previous.delivery, openTaskId } }
    } else if (action === 'delivered') {
      const delivery = { conversationId: text(args.conversationId, 'conversationId'), messageId: text(args.messageId, 'messageId') }
      if (args.openTaskId !== undefined) delivery.openTaskId = text(args.openTaskId, 'openTaskId')
      if (args.sentAt !== undefined) {
        if (!Number.isFinite(Date.parse(text(args.sentAt, 'sentAt')))) fail('effect_invalid_argument', 'sentAt')
        delivery.sentAt = args.sentAt
      }
      if (Object.entries(delivery).some(([key, value]) => previous.delivery[key] !== undefined && previous.delivery[key] !== value)) fail('approval_notice_delivery_conflict')
      if (['waiting-reply','recall-required','recalled'].includes(previous.status)) return changed({ notice: previous, applied: false })
      if (previous.status !== 'unknown') fail('approval_notice_send_required')
      // Web 决定可与外发竞争；真实发送回执必须保留，随后明确撤回。
      notice = { ...previous, status: pending && !approvalNoticeLifecycle(db, effect).invalid ? 'waiting-reply' : 'recall-required', updatedAt: context.now, delivery: { ...previous.delivery, ...delivery } }
    } else {
      if (text(args.conversationId, 'conversationId') !== previous.delivery.conversationId
        || text(args.messageId, 'messageId') !== previous.delivery.messageId) fail('approval_notice_delivery_conflict')
      if (previous.status === 'recalled') return changed({ notice: previous, applied: false })
      if (pending && !approvalNoticeLifecycle(db, effect).invalid || previous.status !== 'recall-required') fail('approval_notice_recall_not_required')
      const recalledAt = args.recalledAt ?? context.now
      if (!Number.isFinite(Date.parse(text(recalledAt, 'recalledAt')))) fail('effect_invalid_argument', 'recalledAt')
      notice = { ...previous, status: 'recalled', updatedAt: context.now, recalledAt }
    }
  }
  context.emitEvent(`approval.notice.${action}`, notice)
  return { result: { notice, applied: true }, dispatchEligible: action === 'send' }
}

function prepare(db, args, context) {
  const effectId = text(args.effectId, 'effectId')
  if (!['operation', 'job'].includes(args.kind)) fail('effect_invalid_argument', 'kind')
  const approval = args.approval == null ? null : {
    requestId: text(args.approval.requestId, 'requestId'), approverIds: strings(args.approval.approverIds, 'approverIds'),
  }
  const authorizationRef = args.authorizationRef == null ? null : text(args.authorizationRef, 'authorizationRef')
  if ((!approval && !authorizationRef) || (approval && authorizationRef)) fail('effect_authorization_basis_required')
  const definition = object(args.definition, 'definition')
  text(definition.adapterId, 'definition.adapterId')
  text(definition.adapterVersion, 'definition.adapterVersion')
  text(definition.principalId, 'definition.principalId')
  const identity = {
    effectId, kind: args.kind, runId: text(args.runId, 'runId'), nodeId: text(args.nodeId, 'nodeId'),
    generation: integer(args.generation, 'generation'), inputDigest: text(args.inputDigest, 'inputDigest'),
    definition, resourceKeys: strings(args.resourceKeys, 'resourceKeys'), approval, authorizationRef,
  }
  const identityDigest = digest(identity)
  const existing = db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(effectId)
  if (existing) {
    if (existing.definition_digest !== identityDigest) fail('effect_identity_conflict')
    return changed({ effect: effectDto(existing), created: false })
  }
  const { node } = context.assertDispatchAllowed({ ...identity, leaseEpoch: integer(args.leaseEpoch, 'leaseEpoch') })
  if (approval && db.prepare('SELECT 1 FROM execution_approvals WHERE request_id=?').get(approval.requestId)) fail('approval_identity_conflict')
  db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,
    definition_digest,definition_json,resource_keys_json,authorization_ref,request_id,launch_nonce,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(
    effectId, identity.kind, identity.runId, text(node.nodeRunId, 'nodeRunId'), identity.nodeId, identity.generation,
    identity.inputDigest, identityDigest, encode(definition), encode(identity.resourceKeys), authorizationRef,
    approval?.requestId ?? null, identity.kind === 'job' ? randomUUID() : null, context.now, context.now,
  )
  if (approval) db.prepare(`INSERT INTO execution_approvals(request_id,effect_id,approver_ids_json,created_at,updated_at)
    VALUES(?,?,?,?,?)`).run(approval.requestId, effectId, encode(approval.approverIds), context.now, context.now)
  context.emitEvent('effect.prepared', { effectId, runId: identity.runId, nodeRunId: node.nodeRunId })
  return changed({ effect: effectDto(effectRow(db, effectId)), created: true })
}

function begin(db, args, context) {
  const row = effectRow(db, args.effectId)
  // 历史成功回执、未知状态和已开始的重复命令一律不产生第二张许可。
  if (row.state !== 'prepared') return changed({ effect: effectDto(row), started: false })
  const leaseEpoch = integer(args.leaseEpoch, 'leaseEpoch')
  const expectedSafetyEpoch = integer(args.expectedSafetyEpoch, 'expectedSafetyEpoch')
  const { node } = context.assertDispatchAllowed({ runId: row.run_id, nodeId: row.node_id,
    generation: row.generation, leaseEpoch, inputDigest: row.input_digest })
  if (node.nodeRunId !== row.node_run_id) fail('effect_node_identity_changed')
  const safetyEpoch = db.prepare('SELECT safety_epoch FROM execution_meta WHERE singleton=1').get()?.safety_epoch
  if (safetyEpoch !== expectedSafetyEpoch) fail('effect_safety_epoch_stale')
  const resources = JSON.parse(row.resource_keys_json)
  const principalId = JSON.parse(row.definition_json).principalId
  const scopes = [['global', '*'], ['run', row.run_id], ['principal', principalId], ...resources.map(key => ['resource', key])]
  const fence = db.prepare('SELECT 1 FROM execution_safety_fences WHERE scope=? AND scope_key=?')
  if (scopes.some(([scope, key]) => fence.get(scope, key))) fail('effect_safety_revoked')
  if (row.request_id) {
    const approval = approvalRow(db, row.request_id)
    if (approval.revoked || approval.decision !== 'approved') fail('effect_approval_required')
  }
  const hold = db.prepare('SELECT effect_id FROM execution_resource_holds WHERE resource_key=?')
  if (resources.some(key => hold.get(key))) fail('effect_resource_busy')
  for (const key of resources) db.prepare('INSERT INTO execution_resource_holds VALUES(?,?)').run(key, row.effect_id)
  const state = row.kind === 'job' ? 'starting' : 'executing'
  db.prepare('UPDATE execution_effects SET state=?, dispatch_lease_epoch=?, dispatch_safety_epoch=?, updated_at=? WHERE effect_id=?')
    .run(state, leaseEpoch, safetyEpoch, context.now, row.effect_id)
  context.emitEvent('effect.started', { effectId: row.effect_id, kind: row.kind, runId: row.run_id, state })
  return { result: { effect: effectDto(effectRow(db, row.effect_id)), started: true }, dispatchEligible: true }
}

function rearmUnsent(db, args, context) {
  const row = effectRow(db, args.effectId), definition = JSON.parse(row.definition_json)
  const observation = row.result_json && JSON.parse(row.result_json), proof = object(args.proof, 'proof')
  text(args.proofRef, 'proofRef'); text(args.observationRef, 'observationRef')
  if (row.state !== 'failed' || row.kind !== 'operation' || definition.adapterId !== 'github-pr'
    || definition.adapterVersion !== '1' || definition.action !== 'pr'
    || observation?.evidenceRef !== args.observationRef || observation.status !== 'failed'
    || observation.result?.phase !== 'preflight' || observation.result.mutationAttempted !== false
    || !['PR_CONNECTION_FAILED', 'PR_PREFLIGHT_NOT_SENT'].includes(observation.result.reason)
    || proof.mutationAttempted !== false || proof.operationKey !== definition.payload.operationKey
    || proof.preparedDigest !== definition.payload.digest || !['PR_CONNECTION_FAILED', 'PR_PREFLIGHT_NOT_SENT'].includes(proof.reason)) fail('effect_unsent_recovery_not_proven')
  const { node } = context.assertDispatchAllowed({ runId: row.run_id, nodeId: row.node_id,
    generation: row.generation, leaseEpoch: integer(args.leaseEpoch, 'leaseEpoch'), inputDigest: row.input_digest })
  if (node.nodeRunId !== row.node_run_id || row.dispatch_lease_epoch >= args.leaseEpoch
    || db.prepare('SELECT 1 FROM execution_resource_holds WHERE effect_id=?').get(row.effect_id)) fail('effect_unsent_recovery_not_proven')
  const scopes = [['global', '*'], ['run', row.run_id], ['principal', definition.principalId],
    ...JSON.parse(row.resource_keys_json).map(key => ['resource', key])]
  if (scopes.some(([scope, key]) => db.prepare('SELECT 1 FROM execution_safety_fences WHERE scope=? AND scope_key=?').get(scope, key))) fail('effect_safety_revoked')
  if (row.request_id) {
    const approval = approvalRow(db, row.request_id)
    if (approval.revoked || approval.decision !== 'approved') fail('effect_approval_required')
  }
  db.prepare("UPDATE execution_effects SET state='prepared',updated_at=? WHERE effect_id=?").run(context.now, row.effect_id)
  context.emitEvent('effect.unsent-rearmed', { effectId: row.effect_id, runId: row.run_id,
    leaseEpoch: args.leaseEpoch, observationRef: args.observationRef, proofRef: args.proofRef })
  return changed({ effect: effectDto(effectRow(db, row.effect_id)), rearmed: true })
}

function recordIdentity(db, args, context) {
  const row = effectRow(db, args.effectId)
  if (row.kind !== 'job' || !ACTIVE.includes(row.state)) fail('job_identity_not_expected')
  const value = object(args.identity, 'identity')
  const identity = { pid: integer(value.pid, 'pid'), bootId: text(value.bootId, 'bootId'),
    createdAt: text(value.createdAt, 'createdAt'), nonce: text(value.nonce, 'nonce') }
  if (!identity.pid || identity.nonce !== row.launch_nonce) fail('job_identity_mismatch')
  const encoded = encode(identity)
  if (row.identity_json) {
    if (row.identity_json !== encoded) fail('job_identity_conflict')
    return changed({ effect: effectDto(row), recorded: false })
  }
  // identity 是适配器的观测记录，不是 OS 进程存活/权限证明；unknown 不因此重获发送权。
  db.prepare('UPDATE execution_effects SET identity_json=?, updated_at=? WHERE effect_id=?').run(encoded, context.now, row.effect_id)
  context.emitEvent('effect.identity-observed', { effectId: row.effect_id, runId: row.run_id })
  return changed({ effect: effectDto(effectRow(db, row.effect_id)), recorded: true })
}

function observe(db, args, context) {
  const row = effectRow(db, args.effectId)
  const receiptId = text(args.receiptId, 'receiptId')
  if (!['unknown', ...TERMINAL].includes(args.status)) fail('effect_invalid_argument', 'status')
  const observation = { effectId: row.effect_id, status: args.status, evidenceRef: text(args.evidenceRef, 'evidenceRef'), result: args.result ?? null }
  const payloadDigest = digest(observation)
  const previous = db.prepare('SELECT * FROM execution_effect_observations WHERE receipt_id=?').get(receiptId)
  if (previous) {
    if (previous.effect_id !== row.effect_id || previous.payload_digest !== payloadDigest) fail('effect_receipt_conflict')
    return changed({ effect: effectDto(row), observed: false })
  }
  if (row.state === 'prepared') fail('effect_not_started')
  if (TERMINAL.includes(row.state) && row.result_json !== encode(observation)) fail('effect_terminal_conflict')
  db.prepare('INSERT INTO execution_effect_observations VALUES(?,?,?,?,?)').run(receiptId, row.effect_id, payloadDigest, encode(observation), context.now)
  if (!TERMINAL.includes(row.state)) {
    db.prepare('UPDATE execution_effects SET state=?, result_json=?, updated_at=? WHERE effect_id=?')
      .run(args.status, encode(observation), context.now, row.effect_id)
    if (TERMINAL.includes(args.status)) db.prepare('DELETE FROM execution_resource_holds WHERE effect_id=?').run(row.effect_id)
    context.emitEvent('effect.observed', { effectId: row.effect_id, runId: row.run_id, state: args.status, receiptId })
  }
  // 不校验当前generation：迟到外部效果仍需入账，不能被旧节点失效吞掉。
  return changed({ effect: effectDto(effectRow(db, row.effect_id)), observed: true })
}

function approval(db, args, context, revoke) {
  const row = approvalRow(db, args.requestId)
  const actorId = text(args.actorId, 'actorId')
  if (args.comment !== undefined && (typeof args.comment !== 'string' || args.comment.length > 2000)) fail('effect_invalid_argument', 'comment')
  if (!JSON.parse(row.approver_ids_json).includes(actorId)) fail('approval_actor_forbidden')
  if (!['web', 'dingtalk'].includes(args.source)) fail('effect_invalid_argument', 'source')
  if (revoke) {
    if (row.revoked) return changed({ approval: approvalDto(row), applied: false })
    db.prepare('UPDATE execution_approvals SET revoked=1, revoked_by=?, revoke_source=?, updated_at=? WHERE request_id=?')
      .run(actorId, args.source, context.now, row.request_id)
  } else {
    if (!['approved', 'rejected'].includes(args.decision)) fail('effect_invalid_argument', 'decision')
    // pending请求也可先撤销；持久tombstone阻止晚到approve产生Grant。
    if (row.revoked || row.decision !== 'pending') return changed({ approval: approvalDto(row), applied: false })
    db.prepare('UPDATE execution_approvals SET decision=?, decided_by=?, decision_source=?, updated_at=? WHERE request_id=?')
      .run(args.decision, actorId, args.source, context.now, row.request_id)
  }
  if (!revoke && args.decision === 'rejected') {
    const effect = effectRow(db, row.effect_id)
    const payload = JSON.parse(effect.definition_json).payload
    if (effect.state === 'prepared' && payload?.workflowKind === 'data-change'
      && payload.stage === 'approval-gate' && payload.intent?.approvalSource === 'assistant') {
      // 真人驳回关闭尚未发送的审批门禁，不处理任何在途外部写入。
      const observation = { effectId: effect.effect_id, status: 'failed',
        evidenceRef: `plugin-approval:${row.request_id}`, result: { reason: 'approval_rejected', mutationAttempted: false } }
      db.prepare('INSERT INTO execution_effect_observations VALUES(?,?,?,?,?)')
        .run(`approval-rejected:${row.request_id}`, effect.effect_id, digest(observation), encode(observation), context.now)
      db.prepare("UPDATE execution_effects SET state='failed', result_json=?, updated_at=? WHERE effect_id=?")
        .run(encode(observation), context.now, effect.effect_id)
      db.prepare('DELETE FROM execution_resource_holds WHERE effect_id=?').run(effect.effect_id)
      context.emitEvent('effect.observed', { effectId: effect.effect_id, runId: effect.run_id,
        state: 'failed', receiptId: `approval-rejected:${row.request_id}` })
    }
  }
  context.emitEvent(revoke ? 'approval.revoked' : 'approval.decided', { requestId: row.request_id, effectId: row.effect_id, actorId, source: args.source,
    ...(!revoke ? { decision: args.decision, comment: (args.comment ?? '').trim() } : {}) })
  return changed({ approval: approvalDto(approvalRow(db, row.request_id)), applied: true })
}

function revokeSafety(db, args, context) {
  if (!['global', 'run', 'resource', 'principal'].includes(args.scope)) fail('effect_invalid_argument', 'scope')
  const key = text(args.key, 'key')
  const reason = text(args.reason, 'reason')
  if (args.scope === 'global' && key !== '*') fail('effect_invalid_argument', 'global key must be *')
  const existing = db.prepare('SELECT epoch FROM execution_safety_fences WHERE scope=? AND scope_key=?').get(args.scope, key)
  if (existing) return changed({ applied: false, epoch: existing.epoch })
  db.prepare('UPDATE execution_meta SET safety_epoch=safety_epoch+1 WHERE singleton=1').run()
  const epoch = db.prepare('SELECT safety_epoch FROM execution_meta WHERE singleton=1').get()?.safety_epoch
  if (!Number.isSafeInteger(epoch)) fail('effect_safety_state_missing')
  db.prepare('INSERT INTO execution_safety_fences VALUES(?,?,?,?,?)').run(args.scope, key, epoch, reason, context.now)
  context.emitEvent('safety.revoked', { scope: args.scope, key, epoch, reason })
  return changed({ applied: true, epoch })
}

/** command={id,kind,args}；必须由ControlStore在同一个同步写事务内调用。 */
export function reduceEffectCommand(db, command, context) {
  const handlers = {
    'effect.prepare': prepare, 'effect.begin': begin, 'effect.rearmUnsent': rearmUnsent, 'effect.identity': recordIdentity, 'effect.observe': observe,
    'approval.decide': (db, args, context) => approval(db, args, context, false),
    'approval.revoke': (db, args, context) => approval(db, args, context, true), 'safety.revoke': revokeSafety,
    ...Object.fromEntries(['prepare','send','receipt','delivered','recalled','unsent'].map(action =>
      [`approval.notice.${action}`, (db, args, context) => approvalNoticeCommand(db, args, context, action)])),
  }
  const handler = handlers[command.kind]
  if (!Object.hasOwn(handlers, command.kind)) return null
  object(command.args, 'args')
  if (!context || typeof context.assertDispatchAllowed !== 'function' || typeof context.emitEvent !== 'function') fail('effect_context_required')
  text(context.now, 'context.now')
  return handler(db, command.args, context)
}

export function queryEffects(db, query) {
  const args = query.args ?? query
  if (query.kind === 'effect.get') return effectDto(effectRow(db, args.effectId))
  if (query.kind === 'effect.list') return db.prepare('SELECT * FROM execution_effects WHERE run_id=? ORDER BY created_at,effect_id').all(text(args.runId, 'runId')).map(effectDto)
  if (query.kind === 'approval.get') return approvalDto(approvalRow(db, args.requestId))
  if (query.kind === 'approval.execution-proof') {
    const approval = approvalRow(db, args.requestId), gate = effectRow(db, approval.effect_id)
    const execute = effectRow(db, args.executeEffectId), payload = JSON.parse(execute.definition_json).payload
    if (approval.decision !== 'approved' || approval.revoked || !approval.decided_by
      || !JSON.parse(approval.approver_ids_json).includes(approval.decided_by)
      || gate.state !== 'succeeded' || execute.state !== 'succeeded' || gate.run_id !== execute.run_id
      || gate.generation !== execute.generation || payload?.stage !== 'execute-task'
      || payload.approvalRequestId !== approval.request_id) fail('approval_execution_not_proven')
    const decided = db.prepare("SELECT seq,payload FROM execution_events WHERE kind='approval.decided' AND json_extract(payload,'$.requestId')=? ORDER BY seq LIMIT 1").get(approval.request_id)
    const started = db.prepare("SELECT seq FROM execution_events WHERE kind='effect.started' AND json_extract(payload,'$.effectId')=? ORDER BY seq LIMIT 1").get(execute.effect_id)
    const observed = db.prepare("SELECT seq FROM execution_events WHERE kind='effect.observed' AND json_extract(payload,'$.effectId')=? AND json_extract(payload,'$.state')='succeeded' ORDER BY seq LIMIT 1").get(execute.effect_id)
    const decision = decided && JSON.parse(decided.payload)
    if (!decided || !started || !observed || decided.seq >= started.seq || started.seq >= observed.seq
      || decision.decision !== 'approved' || decision.effectId !== gate.effect_id
      || decision.actorId !== approval.decided_by || decision.source !== approval.decision_source) fail('approval_execution_not_proven')
    return { approval: approvalDto(approval), gateEffectId: gate.effect_id, executeEffectId: execute.effect_id,
      approvedSequence: decided.seq, executionStartedSequence: started.seq, executionSucceededSequence: observed.seq }
  }
  if (query.kind === 'approval.notice') return approvalNotice(db, args.requestId)
  if (query.kind === 'approval.list') {
    const limit = args.limit ?? 200
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('effect_invalid_argument', 'limit')
    return db.prepare("SELECT * FROM execution_approvals ORDER BY (decision='pending') DESC,created_at DESC,request_id DESC LIMIT ?").all(limit).map(approvalDto)
  }
  if (query.kind === 'safety.get') return {
    epoch: db.prepare('SELECT safety_epoch FROM execution_meta WHERE singleton=1').get()?.safety_epoch,
    fences: db.prepare('SELECT scope,scope_key AS key,epoch,reason FROM execution_safety_fences ORDER BY epoch').all().map(row => ({ ...row })),
  }
  return null
}

/** starting且尚无进程identity也必须unknown；占用一直保留到可信终态观测。 */
export function recoverEffects(db, context) {
  const rows = db.prepare("SELECT * FROM execution_effects WHERE state IN ('starting','executing') ORDER BY effect_id").all()
  for (const row of rows) {
    db.prepare("UPDATE execution_effects SET state='unknown', updated_at=? WHERE effect_id=?").run(context.now, row.effect_id)
    context.emitEvent('effect.recovery-required', { effectId: row.effect_id, runId: row.run_id, previousState: row.state })
  }
  return { recovered: rows.map(row => row.effect_id) }
}

export function assertRunEffectsDrained(db, runId) {
  if (db.prepare("SELECT 1 FROM execution_effects WHERE run_id=? AND state IN ('starting','executing','unknown') LIMIT 1").get(runId)) fail('run_effects_not_drained')
}

export function assertNodeEffectsSettled(db, { runId, nodeRunId }) {
  if (db.prepare("SELECT 1 FROM execution_effects WHERE run_id=? AND node_run_id=? AND state NOT IN ('succeeded','failed') LIMIT 1")
    .get(runId, nodeRunId)) fail('node_effects_not_settled')
}
