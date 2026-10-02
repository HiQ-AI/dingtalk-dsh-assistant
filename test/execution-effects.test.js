import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {
  installEffectsSchema, validateEffectsSchema, reduceEffectCommand, queryEffects, recoverEffects,
  assertRunEffectsDrained, assertNodeEffectsSettled,
} from '../packages/dingtalk-dsh-assistant/execution-effects.js'

function fixture(file = ':memory:') {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE execution_meta(singleton INTEGER PRIMARY KEY, safety_epoch INTEGER NOT NULL);
    INSERT INTO execution_meta VALUES(1,0);
    CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, stop_requested INTEGER NOT NULL);
    INSERT INTO execution_runs VALUES('run',1,0);
    CREATE TABLE execution_nodes(node_run_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES execution_runs,
      node_id TEXT NOT NULL, generation INTEGER NOT NULL, lease_epoch INTEGER NOT NULL, input_digest TEXT NOT NULL,
      status TEXT NOT NULL, current INTEGER NOT NULL, drained INTEGER NOT NULL);
    INSERT INTO execution_nodes VALUES('node-run','run','node',1,1,'input','running',1,0);
    CREATE TABLE execution_inputs(input_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE test_events(kind TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE execution_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL);
  `)
  installEffectsSchema(db)
  const context = contextFor(db)
  let commandId = 0
  return {
    db, context,
    command: (kind, args) => transaction(db, () => reduceEffectCommand(db, { id: `command-${++commandId}`, kind, args }, context)),
    get: effectId => queryEffects(db, { kind: 'effect.get', effectId }),
    approvals: requestId => queryEffects(db, { kind: 'approval.get', requestId }),
  }
}

function contextFor(db) {
  return {
    now: '2026-09-23T00:00:00.000Z',
    assertDispatchAllowed({ runId, nodeId, generation, leaseEpoch, inputDigest }) {
      const run = db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(runId)
      const node = db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND node_id=? AND current=1').get(runId, nodeId)
      const reject = code => { throw Object.assign(new Error(code), { code }) }
      if (!run || !node) reject('node_missing')
      if (run.stop_requested) reject('run_stopped')
      if (run.generation !== generation || node.generation !== generation) reject('generation_stale')
      if (node.lease_epoch !== leaseEpoch) reject('lease_stale')
      if (node.input_digest !== inputDigest) reject('input_stale')
      if (node.status !== 'running' || node.drained) reject('node_not_running')
      if (db.prepare("SELECT 1 FROM execution_inputs WHERE run_id=? AND status='pending'").get(runId)) reject('input_fenced')
      return { run, node: { nodeRunId: node.node_run_id } }
    },
    emitEvent(kind, payload) {
      db.prepare('INSERT INTO test_events VALUES(?,?)').run(kind, JSON.stringify(payload))
      db.prepare('INSERT INTO execution_events(kind,payload) VALUES(?,?)').run(kind, JSON.stringify(payload))
    },
  }
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = operation(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}

const prepared = (effectId = 'operation', extra = {}) => ({
  effectId, kind: 'operation', runId: 'run', nodeId: 'node', generation: 1, leaseEpoch: 1, inputDigest: 'input',
  definition: { adapterId: 'synthetic', adapterVersion: '1', principalId: 'owner', target: 'synthetic-target', args: { value: 1 } },
  resourceKeys: ['resource:a'], authorizationRef: 'task-grant:synthetic', ...extra,
})
const beginArgs = (effectId = 'operation', extra = {}) => ({ effectId, leaseEpoch: 1, expectedSafetyEpoch: 0, ...extra })
const receipt = (effectId = 'operation', status = 'succeeded', extra = {}) => ({ effectId, receiptId: `receipt-${effectId}`,
  status, evidenceRef: 'synthetic-observation:1', result: { actualWrites: 1 }, ...extra })
const request = id => ({ authorizationRef: undefined, approval: { requestId: id, approverIds: ['owner', 'reviewer'] } })
const decide = (id, decision = 'approved', extra = {}) => ({ requestId: id, actorId: 'owner', source: 'web', decision, ...extra })
const code = expected => error => error.code === expected

const noticeArgs = { requestId: 'private-request', effectId: 'private-effect', recipientUserId: 'ding-user', approverActorId: 'owner', text: '请审核实际执行方案，引用此消息回复同意或拒绝。' }

test('只有绑定通知摘要的明确平台uuid拒绝证明可恢复未发送通知', t => {
  const f = fixture(); t.after(() => f.db.close())
  const requestId = `external:${'c'.repeat(64)}`
  f.command('effect.prepare', prepared('private-effect', request(requestId)))
  const notice = f.command('approval.notice.prepare', { ...noticeArgs, requestId }).result.notice
  const args = { requestId, noticeDigest: notice.digest }
  const idempotencyKey = `workflow-approval:${requestId}:${notice.digest}`
  const proof = { kind: 'dws-uuid-rejected', idempotencyKey, serverErrorCode: '1001', errorMessage: `sendPersonalMessageByServerPush error: Length of filed: 'uuid' cannot greater than 128 but actual is ${idempotencyKey.length}.`, traceId: '213126b217909445212943537e0564' }
  f.command('approval.notice.send', args)
  for (const badProof of [{ ...proof, serverErrorCode: '500' }, { ...proof, errorMessage: 'not found' }, { ...proof, traceId: '' }, { ...proof, idempotencyKey: `${idempotencyKey}x` }, { ...proof, kind: 'local-uuid-rejected' }])
    assert.throws(() => f.command('approval.notice.unsent', { ...args, proof: badProof }), code('approval_notice_unsent_not_proven'))
  assert.equal(f.command('approval.notice.unsent', { ...args, proof }).result.notice.status, 'prepared')
  assert.deepEqual(queryEffects(f.db, { kind: 'approval.notice', requestId }).unsentProof, proof)
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, true)
  assert.throws(() => f.command('approval.notice.unsent', { ...args, proof }), code('approval_notice_unsent_not_proven'))
  f.command('approval.notice.receipt', { ...args, openTaskId: 'actual-send-receipt' })
  assert.throws(() => f.command('approval.notice.unsent', { ...args, proof }), code('approval_notice_unsent_not_proven'))
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId }).status, 'unknown')
})

test('私聊审批冻结真实请求和审批身份，只有持久发送意图首次允许外发', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('private-effect', request('private-request')))
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId: 'private-request' }), null)
  assert.throws(() => f.command('approval.notice.prepare', { ...noticeArgs, approverActorId: 'foreign' }), code('approval_notice_identity_conflict'))
  assert.throws(() => f.command('approval.notice.prepare', { ...noticeArgs, effectId: 'foreign' }), code('approval_notice_identity_conflict'))
  const notice = f.command('approval.notice.prepare', noticeArgs).result.notice
  const args = { requestId: notice.requestId, noticeDigest: notice.digest }
  assert.equal(notice.status, 'prepared')
  assert.equal(f.command('approval.notice.prepare', noticeArgs).result.applied, false)
  assert.throws(() => f.command('approval.notice.prepare', { ...noticeArgs, text: '替换方案' }), code('approval_notice_identity_conflict'))
  const delivered = { ...args, conversationId: 'private-conversation', messageId: 'private-message' }
  assert.throws(() => f.command('approval.notice.delivered', delivered), code('approval_notice_send_required'))
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, true)
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, false)
  assert.equal(f.command('approval.notice.receipt', { ...args, openTaskId: 'open-task' }).result.notice.status, 'unknown')
  assert.equal(f.command('approval.notice.receipt', { ...args, openTaskId: 'open-task' }).result.applied, false)
  assert.throws(() => f.command('approval.notice.receipt', { ...args, openTaskId: 'different' }), code('approval_notice_delivery_conflict'))
  assert.equal(f.command('approval.notice.delivered', delivered).result.notice.status, 'waiting-reply')
  assert.equal(f.command('approval.notice.delivered', delivered).result.applied, false)
  assert.throws(() => f.command('approval.notice.delivered', { ...delivered, messageId: 'different' }), code('approval_notice_delivery_conflict'))
  assert.throws(() => f.command('approval.notice.recalled', delivered), code('approval_notice_recall_not_required'))
  f.command('approval.decide', decide('private-request'))
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId: 'private-request' }).status, 'recall-required')
  assert.equal(f.command('approval.notice.recalled', delivered).result.notice.status, 'recalled')
  assert.equal(f.command('approval.notice.recalled', delivered).result.applied, false)
})

test('Web决定与私聊发送竞争时保留真实回执并要求撤回，不重新发送', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('private-effect', request('private-request')))
  const notice = f.command('approval.notice.prepare', noticeArgs).result.notice
  const args = { requestId: notice.requestId, noticeDigest: notice.digest }
  f.command('approval.notice.send', args)
  f.command('approval.decide', decide('private-request', 'rejected'))
  f.command('approval.notice.receipt', { ...args, openTaskId: 'open-task' })
  const result = f.command('approval.notice.delivered', { ...args, conversationId: 'conversation', messageId: 'message' })
  assert.equal(result.result.notice.status, 'recall-required')
  assert.equal(result.result.notice.delivery.openTaskId, 'open-task')
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, false)
  assert.equal(f.approvals('private-request').decision, 'rejected')
})

for (const lifecycle of ['pause','stop','generation']) test(`私聊通知生命周期围栏：${lifecycle}`, t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('private-effect', request('private-request')))
  const notice = f.command('approval.notice.prepare', noticeArgs).result.notice
  const args = { requestId: notice.requestId, noticeDigest: notice.digest }
  if (lifecycle === 'pause') { f.db.exec('ALTER TABLE execution_runs ADD COLUMN pause_requested INTEGER DEFAULT 0'); f.db.exec('UPDATE execution_runs SET pause_requested=1') }
  else if (lifecycle === 'stop') f.db.exec('UPDATE execution_runs SET stop_requested=1')
  else f.db.exec('UPDATE execution_runs SET generation=2')
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, false)
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId: args.requestId }).status, 'prepared')
  f.db.exec('UPDATE execution_runs SET generation=1,stop_requested=0')
  if (lifecycle === 'pause') f.db.exec('UPDATE execution_runs SET pause_requested=0')
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, true)
  f.db.exec('UPDATE execution_runs SET stop_requested=1')
  f.command('approval.notice.receipt', { ...args, openTaskId: 'late-open-task' })
  const delivered = { ...args, conversationId: 'conversation', messageId: 'message' }
  assert.equal(f.command('approval.notice.delivered', delivered).result.notice.status, 'recall-required')
  assert.equal(f.command('approval.notice.recalled', delivered).result.notice.status, 'recalled')
})

test('Task暂停保留已送私聊，取消要求撤回且保持真实回执', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.db.exec(`ALTER TABLE execution_runs ADD COLUMN task_id TEXT;
    UPDATE execution_runs SET task_id='task';
    CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY,status TEXT,plan_revision INTEGER);
    INSERT INTO business_tasks VALUES('task','active',1);
    CREATE TABLE task_controls(task_id TEXT PRIMARY KEY,state TEXT);
    INSERT INTO task_controls VALUES('task','active');
    CREATE TABLE task_plan_stages(task_id TEXT,plan_revision INTEGER,run_id TEXT,status TEXT);
    INSERT INTO task_plan_stages VALUES('task',1,'run','running');`)
  f.command('effect.prepare', prepared('private-effect', request('private-request')))
  const notice = f.command('approval.notice.prepare', noticeArgs).result.notice
  const args = { requestId: notice.requestId, noticeDigest: notice.digest }
  f.db.exec("UPDATE task_controls SET state='paused'; UPDATE business_tasks SET status='paused'")
  assert.equal(f.command('approval.notice.send', args).dispatchEligible, false)
  f.db.exec("UPDATE task_controls SET state='active'; UPDATE business_tasks SET status='active'")
  f.command('approval.notice.send', args)
  const delivered = { ...args, conversationId: 'conversation', messageId: 'message' }
  f.command('approval.notice.delivered', delivered)
  f.db.exec("UPDATE task_controls SET state='paused'; UPDATE business_tasks SET status='paused'")
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId: args.requestId }).status, 'waiting-reply')
  f.db.exec("UPDATE task_controls SET state='cancelling'; UPDATE business_tasks SET status='cancelling'")
  assert.equal(queryEffects(f.db, { kind: 'approval.notice', requestId: args.requestId }).status, 'recall-required')
  assert.equal(f.command('approval.notice.recalled', delivered).result.notice.status, 'recalled')
})

test('正式worker私聊通知意图重启后保持unknown，同command回放与新command均不重派', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-execution-effects-'))
  let store
  t.after(async () => { await store?.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const options = { dbPath: path.join(directory, 'control.sqlite'), instanceId: 'synthetic-notices' }
  store = await openExecutionStore({ ...options, initialize: true })
  const command = (id, kind, args) => store.command({ id, kind, args }).catch(error => { error.message = `${kind}: ${error.message}`; throw error })
  const inputDigest = 'a'.repeat(64)
  await command('create', 'run.create', { runId: 'run', taskId: 'task', workflowId: 'synthetic', workflowDigest: 'b'.repeat(64), requirementRef: 'synthetic/requirement.json', nodes: [{ nodeId: 'node', nodeVersion: '1', executor: 'code', inputRef: 'synthetic/input.json', inputDigest }] })
  await command('claim', 'node.claim', { runId: 'run', nodeId: 'node', expectedGeneration: 1, expectedLeaseEpoch: 0 })
  const effectArgs = prepared('private-effect', { ...request('private-request'), inputDigest })
  delete effectArgs.authorizationRef
  await command('effect', 'effect.prepare', effectArgs)
  assert.equal(await store.query({ kind: 'approval.notice', requestId: 'private-request' }), null)
  const notice = (await command('prepare', 'approval.notice.prepare', noticeArgs)).result.notice
  const args = { requestId: notice.requestId, noticeDigest: notice.digest }
  await command('maintenance-start', 'runtime.maintenance.change', { expectedRevision: 0, maintenanceId: 'test-maintenance', actorId: 'owner', reason: 'verify notice gate', active: true })
  await assert.rejects(command('maintenance-send', 'approval.notice.send', args), code('RUNTIME_MAINTENANCE_ACTIVE'))
  assert.equal((await store.query({ kind: 'approval.notice', requestId: args.requestId })).status, 'prepared')
  await command('maintenance-end', 'runtime.maintenance.change', { expectedRevision: 1, maintenanceId: 'test-maintenance', actorId: 'owner', reason: 'verified', active: false })
  assert.equal((await command('send', 'approval.notice.send', args)).dispatchEligible, true)
  await command('receipt', 'approval.notice.receipt', { ...args, openTaskId: 'open-task' })
  await store.close()
  store = await openExecutionStore(options)
  assert.equal((await store.query({ kind: 'approval.notice', requestId: 'private-request' })).delivery.openTaskId, 'open-task')
  assert.equal((await command('send', 'approval.notice.send', args)).dispatchEligible, false)
  assert.equal((await command('new-send', 'approval.notice.send', args)).dispatchEligible, false)
  assert.equal((await command('delivered', 'approval.notice.delivered', { ...args, conversationId: 'conversation', messageId: 'message' })).result.notice.status, 'waiting-reply')
})

test('SQLite效果身份唯一、参数换序幂等、不同kind或payload不可复用ID', t => {
  const f = fixture(); t.after(() => f.db.close())
  assert.equal(f.command('effect.prepare', prepared()).result.created, true)
  assert.equal(f.command('effect.prepare', prepared('operation', { leaseEpoch: 99 })).result.created, false,
    '已准备的同一业务身份不因投递/lease变化再创建')
  assert.throws(() => f.command('effect.prepare', prepared('operation', { kind: 'job' })), code('effect_identity_conflict'))
  assert.throws(() => f.command('effect.prepare', prepared('operation', { definition: { ...prepared().definition, args: { value: 2 } } })), code('effect_identity_conflict'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_effects').get().n, 1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 0)
  validateEffectsSchema(f.db)
})

test('无授权依据和伪authorized=true拒绝；ref仅记录受信Host依据', t => {
  const f = fixture(); t.after(() => f.db.close())
  assert.throws(() => f.command('effect.prepare', prepared('none', { authorizationRef: undefined, authorized: true })), code('effect_authorization_basis_required'))
  assert.throws(() => f.command('effect.prepare', prepared('blank', { authorizationRef: '' })), code('effect_invalid_argument'))
  assert.throws(() => f.command('effect.prepare', prepared('both', { approval: { requestId: 'r', approverIds: ['owner'] } })), code('effect_authorization_basis_required'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_effects').get().n, 0)
})

test('待真人审批效果可只读列出，不将已批准效果误作待审批', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('human-gate', { ...request('release-gate') }))
  assert.deepEqual(queryEffects(f.db, { kind: 'approval.list', limit: 10 }).map(item => [item.requestId, item.decision]),
    [['release-gate', 'pending']])
  f.command('approval.decide', decide('release-gate'))
  assert.equal(queryEffects(f.db, { kind: 'approval.list', limit: 10 })[0].decision, 'approved')
  assert.throws(() => queryEffects(f.db, { kind: 'approval.list', limit: 0 }), code('effect_invalid_argument'))
})

test('首次begin与资源占用同事务，重复begin无第二次许可或事件', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  assert.equal(f.command('effect.begin', beginArgs()).dispatchEligible, true)
  assert.equal(f.command('effect.begin', beginArgs()).dispatchEligible, false)
  assert.equal(f.get('operation').state, 'executing')
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM test_events WHERE kind='effect.started'").get().n, 1)
  assert.deepEqual(f.db.prepare('SELECT resource_key FROM execution_resource_holds').all().map(row => row.resource_key), ['resource:a'])
  assert.throws(() => assertRunEffectsDrained(f.db, 'run'), code('run_effects_not_drained'))
  validateEffectsSchema(f.db)
})

test('准备审批不持长锁，多资源请求冲突时无部分占用', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('approved-later', { ...request('approval'), resourceKeys: ['resource:a', 'resource:b'] }))
  f.command('effect.prepare', prepared('first', { resourceKeys: ['resource:b'] }))
  assert.equal(f.command('effect.begin', beginArgs('first')).dispatchEligible, true)
  f.command('approval.decide', decide('approval'))
  assert.throws(() => f.command('effect.begin', beginArgs('approved-later')), code('effect_resource_busy'))
  assert.equal(f.get('approved-later').state, 'prepared')
  assert.equal(f.db.prepare("SELECT 1 FROM execution_resource_holds WHERE resource_key='resource:a'").get(), undefined)
  f.command('effect.observe', receipt('first'))
  assert.equal(f.command('effect.begin', beginArgs('approved-later')).dispatchEligible, true)
  validateEffectsSchema(f.db)
})

test('同request Web和钉钉首终态生效，后到拒绝/批准都不能覆盖', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('approve-first', request('a')))
  assert.equal(f.command('approval.decide', decide('a')).result.applied, true)
  assert.equal(f.command('approval.decide', decide('a', 'rejected', { source: 'dingtalk' })).result.applied, false)
  assert.equal(f.approvals('a').decision, 'approved')
  assert.equal(f.approvals('a').decisionSource, 'web')
  f.command('effect.prepare', prepared('reject-first', request('b')))
  assert.equal(f.command('approval.decide', decide('b', 'rejected', { source: 'dingtalk' })).result.applied, true)
  assert.equal(f.command('approval.decide', decide('b')).result.applied, false)
  assert.equal(f.approvals('b').decision, 'rejected')
  assert.throws(() => f.command('effect.begin', beginArgs('reject-first')), code('effect_approval_required'))
})

test('actor白名单守卫，先撤销后批准tombstone持久且未知request不可冻结', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('operation', request('a')))
  for (const kind of ['approval.decide', 'approval.revoke']) {
    assert.throws(() => f.command(kind, decide('a', 'approved', { actorId: 'outsider' })), code('approval_actor_forbidden'))
  }
  assert.throws(() => f.command('approval.revoke', decide('unknown')), code('approval_not_found'))
  assert.equal(f.command('approval.revoke', decide('a', 'approved', { source: 'dingtalk' })).result.applied, true)
  assert.equal(f.command('approval.decide', decide('a')).result.applied, false)
  assert.equal(f.approvals('a').revoked, true)
  assert.equal(f.approvals('a').decision, 'pending')
  assert.throws(() => f.command('effect.begin', beginArgs()), code('effect_approval_required'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 0)
})

test('撤销已发许可的审批不释放在途占用；仍需真实结果对账', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('operation', request('a')))
  f.command('approval.decide', decide('a'))
  f.command('effect.begin', beginArgs())
  f.command('approval.revoke', decide('a'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 1)
  assert.equal(f.command('effect.begin', beginArgs()).dispatchEligible, false)
  f.command('effect.observe', receipt())
  assertRunEffectsDrained(f.db, 'run')
})

test('开始时重验generation/lease/input/stop/输入屏障及当前节点身份', t => {
  const mutations = [
    ["UPDATE execution_runs SET generation=2", 'generation_stale'],
    ["UPDATE execution_nodes SET lease_epoch=2", 'lease_stale'],
    ["UPDATE execution_nodes SET input_digest='new-input'", 'input_stale'],
    ["UPDATE execution_runs SET stop_requested=1", 'run_stopped'],
    ["INSERT INTO execution_inputs VALUES('input','run','pending')", 'input_fenced'],
    ["UPDATE execution_nodes SET drained=1", 'node_not_running'],
    ["UPDATE execution_nodes SET current=0; INSERT INTO execution_nodes VALUES('replacement','run','node',1,1,'input','running',1,0)", 'effect_node_identity_changed'],
  ]
  for (const [sql, expected] of mutations) {
    const f = fixture(); t.after(() => f.db.close())
    f.command('effect.prepare', prepared())
    f.db.exec(sql)
    assert.throws(() => f.command('effect.begin', beginArgs()), code(expected))
    assert.equal(f.get('operation').state, 'prepared')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 0)
  }
})

test('全局安全版本与scope守卫权威读取，不依赖旧Task投影', t => {
  for (const [scope, key] of [['global', '*'], ['run', 'run'], ['resource', 'resource:a'], ['principal', 'owner']]) {
    const f = fixture(); t.after(() => f.db.close())
    f.command('effect.prepare', prepared())
    assert.equal(f.command('safety.revoke', { scope, key, reason: 'explicit-revoke' }).result.epoch, 1)
    assert.equal(f.command('safety.revoke', { scope, key, reason: 'duplicate-revoke' }).result.applied, false)
    assert.throws(() => f.command('effect.begin', beginArgs()), code('effect_safety_epoch_stale'))
    assert.throws(() => f.command('effect.begin', beginArgs('operation', { expectedSafetyEpoch: 1 })), code('effect_safety_revoked'))
    assert.equal(f.get('operation').state, 'prepared')
  }
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  f.command('safety.revoke', { scope: 'resource', key: 'other-resource', reason: 'unrelated' })
  assert.equal(f.command('effect.begin', beginArgs('operation', { expectedSafetyEpoch: 1 })).dispatchEligible, true,
    '无关scope不冻结此效果，但调用方必须读取最新安全版本')
})

test('job先持久starting/nonce且未回写进程身份，重开SQLite后unknown不重派', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-execution-effects-'))
  let currentDb
  t.after(() => {
    currentDb?.close()
    const actual = fs.realpathSync(directory)
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()))
    assert.match(path.basename(actual), /^dsh-execution-effects-[a-zA-Z0-9]+$/)
    fs.rmSync(actual, { recursive: true, force: true })
  })
  const filename = path.join(directory, 'control.sqlite')
  const original = fixture(filename)
  currentDb = original.db
  original.command('effect.prepare', prepared('job', { kind: 'job' }))
  const start = original.command('effect.begin', beginArgs('job'))
  assert.equal(start.dispatchEligible, true)
  assert.equal(start.result.effect.state, 'starting')
  assert.ok(start.result.effect.launchNonce)
  assert.equal(start.result.effect.identity, null)
  original.db.close()
  currentDb = null
  const db = new DatabaseSync(filename)
  currentDb = db
  db.exec('PRAGMA foreign_keys=ON')
  validateEffectsSchema(db)
  const context = contextFor(db)
  transaction(db, () => recoverEffects(db, context))
  const recovered = queryEffects(db, { kind: 'effect.get', effectId: 'job' })
  assert.equal(recovered.state, 'unknown')
  assert.equal(recovered.launchNonce, start.result.effect.launchNonce)
  assert.equal(db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 1)
  const repeat = transaction(db, () => reduceEffectCommand(db, { id: 'new-host', kind: 'effect.begin', args: beginArgs('job') }, context))
  assert.equal(repeat.dispatchEligible, false)
  assert.throws(() => assertRunEffectsDrained(db, 'run'), code('run_effects_not_drained'))
  transaction(db, () => reduceEffectCommand(db, { id: 'observed', kind: 'effect.observe', args: receipt('job') }, context))
  assert.equal(queryEffects(db, { kind: 'effect.get', effectId: 'job' }).state, 'succeeded')
  assertRunEffectsDrained(db, 'run')
})

test('job进程身份须与持久nonce匹配，unknown登记身份也不重派', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('job', { kind: 'job' }))
  f.command('effect.begin', beginArgs('job'))
  transaction(f.db, () => recoverEffects(f.db, f.context))
  const identity = { pid: 12345, bootId: 'synthetic-boot', createdAt: '2026-09-23T00:00:00Z', nonce: f.get('job').launchNonce }
  assert.throws(() => f.command('effect.identity', { effectId: 'job', identity: { ...identity, nonce: 'wrong' } }), code('job_identity_mismatch'))
  assert.equal(f.command('effect.identity', { effectId: 'job', identity }).result.recorded, true)
  assert.equal(f.command('effect.identity', { effectId: 'job', identity }).result.recorded, false)
  assert.throws(() => f.command('effect.identity', { effectId: 'job', identity: { ...identity, pid: 54321 } }), code('job_identity_conflict'))
  assert.equal(f.get('job').state, 'unknown')
  assert.equal(f.command('effect.begin', beginArgs('job')).dispatchEligible, false)
})

test('unknown持锁至终态观测，旧代真实回执仍入账且重复不释放别人的锁', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  f.command('effect.begin', beginArgs())
  f.command('effect.observe', receipt('operation', 'unknown', { receiptId: 'uncertain' }))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 1)
  f.db.exec('UPDATE execution_runs SET generation=2,stop_requested=1')
  assert.equal(f.command('effect.observe', receipt()).result.observed, true)
  assert.equal(f.get('operation').state, 'succeeded')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 0)
  assert.equal(f.command('effect.observe', receipt()).result.observed, false)
  assert.equal(f.command('effect.begin', beginArgs()).dispatchEligible, false)
  assert.throws(() => f.command('effect.observe', receipt('operation', 'failed')), code('effect_receipt_conflict'))
  assert.throws(() => f.command('effect.observe', receipt('operation', 'failed', { receiptId: 'contradiction' })), code('effect_terminal_conflict'))
  validateEffectsSchema(f.db)
})

test('未开始效果不能被伪观测为完成，节点成功不能遗漏prepared效果', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  assert.throws(() => f.command('effect.observe', receipt()), code('effect_not_started'))
  assertRunEffectsDrained(f.db, 'run')
  assert.throws(() => assertNodeEffectsSettled(f.db, { runId: 'run', nodeRunId: 'node-run' }), code('node_effects_not_settled'))
  f.command('effect.begin', beginArgs())
  f.command('effect.observe', receipt())
  assertNodeEffectsSettled(f.db, { runId: 'run', nodeRunId: 'node-run' })
})

test('事件写入失败回滚开始与资源，正式接口没有故障注入参数', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  const brokenContext = { ...f.context, emitEvent() { throw new Error('synthetic event sink failure') } }
  assert.throws(() => transaction(f.db, () => reduceEffectCommand(f.db,
    { id: 'failed-transaction', kind: 'effect.begin', args: beginArgs() }, brokenContext)), /synthetic event sink failure/)
  assert.equal(f.get('operation').state, 'prepared')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n, 0)
  assert.equal(f.command('effect.begin', beginArgs()).dispatchEligible, true)
})

test('严格schema检查不创建缺表且拒绝丢失未决资源占用', t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared())
  f.command('effect.begin', beginArgs())
  f.db.exec('DELETE FROM execution_resource_holds')
  assert.throws(() => validateEffectsSchema(f.db), code('effect_resource_invariant'))
  f.db.exec('DROP TABLE execution_effect_observations')
  assert.throws(() => validateEffectsSchema(f.db), code('effect_schema_invalid'))
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='execution_effect_observations'").get(), undefined)
})

test('正式worker同库：重投历史begin只回读，重开unknown阻止取消完成直到效果对账', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-execution-effects-'))
  let store
  t.after(async () => {
    await store?.close()
    const actual = fs.realpathSync(directory)
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()))
    assert.match(path.basename(actual), /^dsh-execution-effects-[a-zA-Z0-9]+$/)
    fs.rmSync(actual, { recursive: true, force: true })
  })
  const options = { dbPath: path.join(directory, 'control.sqlite'), instanceId: 'synthetic-effects' }
  store = await openExecutionStore({ ...options, initialize: true })
  const command = (id, kind, args) => store.command({ id, kind, args })
  const inputDigest = 'a'.repeat(64)
  await command('create', 'run.create', { runId: 'run', taskId: 'task', workflowId: 'synthetic', workflowDigest: 'b'.repeat(64),
    requirementRef: 'synthetic/requirement.json', nodes: [{ nodeId: 'node', nodeVersion: '1', executor: 'code', inputRef: 'synthetic/input.json', inputDigest }] })
  await command('claim', 'node.claim', { runId: 'run', nodeId: 'node', expectedGeneration: 1, expectedLeaseEpoch: 0 })
  await command('prepare', 'effect.prepare', prepared('job', { kind: 'job', inputDigest }))
  const started = await command('begin', 'effect.begin', beginArgs('job'))
  assert.equal(started.dispatchEligible, true)
  const duplicate = await command('begin', 'effect.begin', beginArgs('job'))
  assert.equal(duplicate.replayed, true)
  assert.equal(duplicate.result.started, true, '历史业务回执保留，但不能把它当新派发许可')
  assert.equal(duplicate.dispatchEligible, false)
  await store.close()
  store = await openExecutionStore(options)
  assert.equal((await store.query({ kind: 'effect.get', effectId: 'job' })).state, 'unknown')
  assert.equal((await command('begin', 'effect.begin', beginArgs('job'))).dispatchEligible, false)
  assert.equal((await command('new-begin', 'effect.begin', beginArgs('job'))).dispatchEligible, false)
  await command('stop', 'run.stop', { runId: 'run', reason: 'synthetic cancellation' })
  await command('drained', 'node.drained', { runId: 'run', nodeId: 'node', generation: 1, leaseEpoch: 1, evidenceRef: 'synthetic/no-process-was-launched' })
  await assert.rejects(command('stopped-before-observation', 'run.stopped', { runId: 'run' }), code('run_effects_not_drained'))
  const observation = await command('observed', 'effect.observe', receipt('job', 'failed', { result: { adapterObserved: 'synthetic-not-started' } }))
  assert.equal(observation.dispatchEligible, false)
  assert.equal(observation.result.effect.state, 'failed')
  const final = await command('stopped-after-observation', 'run.stopped', { runId: 'run' })
  assert.equal(final.result.run.status, 'cancelled')
  assert.equal(store.healthy, true)
})

test('PR完整未发送收据仅在新lease允许同效果恢复，旧观察保留且安全围栏生效',()=>{
 const f=fixture();const payload={operationKey:'a'.repeat(64),digest:'b'.repeat(64)}
 f.command('effect.prepare',prepared('pr',{definition:{adapterId:'github-pr',adapterVersion:'1',principalId:'owner',action:'pr',payload}}))
 f.command('effect.begin',beginArgs('pr'))
 f.command('effect.observe',receipt('pr','failed',{result:{status:'failed',phase:'preflight',mutationAttempted:false,reason:'PR_CONNECTION_FAILED'}}))
 const args={effectId:'pr',leaseEpoch:2,observationRef:'synthetic-observation:1',proofRef:'sha256/proof',proof:{operationKey:payload.operationKey,preparedDigest:payload.digest,mutationAttempted:false,reason:'PR_PREFLIGHT_NOT_SENT'}}
 assert.throws(()=>f.command('effect.rearmUnsent',args),code('lease_stale'))
 f.db.exec("UPDATE execution_nodes SET lease_epoch=2")
 assert.throws(()=>f.command('effect.rearmUnsent',{...args,proof:{...args.proof,operationKey:'other'}}),code('effect_unsent_recovery_not_proven'))
 assert.equal(f.command('effect.rearmUnsent',args).result.effect.state,'prepared')
 assert.equal(f.command('effect.begin',beginArgs('pr',{leaseEpoch:2})).dispatchEligible,true)
 f.command('effect.observe',receipt('pr','failed',{receiptId:'receipt-pr-next',result:{status:'failed',phase:'preflight',mutationAttempted:false,reason:'PR_CONNECTION_FAILED'}}))
 f.db.exec("UPDATE execution_nodes SET lease_epoch=3")
 f.command('safety.revoke',{scope:'run',key:'run',reason:'人工撤销'})
 assert.throws(()=>f.command('effect.rearmUnsent',{...args,leaseEpoch:3}),code('effect_safety_revoked'))
 assert.equal(f.get('pr').state,'failed');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_effect_observations').get().n,2)
 f.db.close()
})

for(const scenario of ['unknown','sent','permission','foreign'])test(`PR不允许无可信未发送证明恢复：${scenario}`,()=>{
 const f=fixture();const payload={operationKey:'a'.repeat(64),digest:'b'.repeat(64)}
 f.command('effect.prepare',prepared('pr',{definition:{adapterId:'github-pr',adapterVersion:'1',principalId:'owner',action:'pr',payload}}))
 f.command('effect.begin',beginArgs('pr'))
 f.command('effect.observe',receipt('pr',scenario==='unknown'?'unknown':'failed',{result:{status:scenario==='unknown'?'unknown':'failed',phase:'preflight',mutationAttempted:scenario==='sent',reason:scenario==='permission'?'PR_PERMISSION_DENIED':'PR_CONNECTION_FAILED'}}))
 f.db.exec("UPDATE execution_nodes SET lease_epoch=2")
 assert.throws(()=>f.command('effect.rearmUnsent',{effectId:'pr',leaseEpoch:2,observationRef:scenario==='foreign'?'different':'synthetic-observation:1',proofRef:'sha256/proof',proof:{operationKey:payload.operationKey,preparedDigest:payload.digest,mutationAttempted:false,reason:'PR_PREFLIGHT_NOT_SENT'}}),code('effect_unsent_recovery_not_proven'))
 assert.equal(f.get('pr').state,scenario==='unknown'?'unknown':'failed');f.db.close()
})

for (const scenario of ['approved-order','late-approval','wrong-actor','revoked','cross-run','unknown-effect','failed-effect','wrong-request','wrong-generation','unauthorized-actor']) test(`原生批准与执行成功序列必须同一绑定：${scenario}`, t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('proof-gate', request('proof-approval')))
  f.command('approval.decide', decide('proof-approval'))
  f.command('effect.begin', beginArgs('proof-gate'))
  f.command('effect.observe', receipt('proof-gate'))
  f.command('effect.prepare', prepared('proof-execute', { definition: { adapterId: 'synthetic', adapterVersion: '1', principalId: 'owner', target: 'synthetic-target', payload: { stage: 'execute-task', approvalRequestId: 'proof-approval' } } }))
  f.command('effect.begin', beginArgs('proof-execute'))
  f.command('effect.observe', receipt('proof-execute'))
  const decision = f.db.prepare("SELECT seq,payload FROM execution_events WHERE kind='approval.decided'").get()
  if (scenario === 'late-approval') {
    f.db.prepare('DELETE FROM execution_events WHERE seq=?').run(decision.seq)
    f.db.prepare("INSERT INTO execution_events(kind,payload) VALUES('approval.decided',?)").run(decision.payload)
  }
  if (scenario === 'wrong-actor') f.db.prepare("UPDATE execution_events SET payload=json_set(payload,'$.actorId','other') WHERE kind='approval.decided'").run()
  if (scenario === 'unauthorized-actor') {
    f.db.prepare("UPDATE execution_events SET payload=json_set(payload,'$.actorId','other') WHERE kind='approval.decided'").run()
    f.db.prepare("UPDATE execution_approvals SET decided_by='other'").run()
  }
  if (scenario === 'revoked') f.command('approval.revoke', decide('proof-approval'))
  if (scenario === 'cross-run') {
    f.db.prepare("INSERT INTO execution_runs VALUES('another-run',1,0)").run()
    f.db.prepare("UPDATE execution_effects SET run_id='another-run' WHERE effect_id='proof-execute'").run()
  }
  if (scenario === 'unknown-effect') f.db.prepare("UPDATE execution_effects SET state='unknown' WHERE effect_id='proof-execute'").run()
  if (scenario === 'failed-effect') f.db.prepare("UPDATE execution_effects SET state='failed' WHERE effect_id='proof-execute'").run()
  if (scenario === 'wrong-request') f.db.prepare("UPDATE execution_effects SET definition_json=json_set(definition_json,'$.payload.approvalRequestId','another-approval') WHERE effect_id='proof-execute'").run()
  if (scenario === 'wrong-generation') f.db.prepare("UPDATE execution_effects SET generation=2 WHERE effect_id='proof-execute'").run()
  const read = () => queryEffects(f.db, { kind: 'approval.execution-proof', requestId: 'proof-approval', executeEffectId: 'proof-execute' })
  if (scenario === 'approved-order') {
    const proof = read()
    assert.equal(proof.gateEffectId, 'proof-gate'); assert.equal(proof.executeEffectId, 'proof-execute')
    assert.equal(proof.approval.decidedBy, 'owner')
    assert.ok(proof.approvedSequence < proof.executionStartedSequence)
    assert.ok(proof.executionStartedSequence < proof.executionSucceededSequence)
  } else assert.throws(read, code('approval_execution_not_proven'))
})

for (const scenario of ['delivered','recalled','late','missing','wrong-actor','wrong-digest','wrong-message']) test(`原生执行证明保留批准前实际呈现而不编造材料：${scenario}`, t => {
  const f = fixture(); t.after(() => f.db.close())
  f.command('effect.prepare', prepared('proof-gate', request('proof-approval')))
  let notice
  if (scenario !== 'missing') {
    notice = f.command('approval.notice.prepare', { ...noticeArgs, requestId: 'proof-approval', effectId: 'proof-gate', text: '永久删除该列全部数据' }).result.notice
    f.command('approval.notice.send', { requestId: 'proof-approval', noticeDigest: notice.digest })
    if (scenario !== 'late') f.command('approval.notice.delivered', { requestId: 'proof-approval', noticeDigest: notice.digest,
      conversationId: 'private', messageId: 'delivered-message' })
  }
  f.command('approval.decide', decide('proof-approval'))
  if (scenario === 'late') f.command('approval.notice.delivered', { requestId: 'proof-approval', noticeDigest: notice.digest,
    conversationId: 'private', messageId: 'delivered-message' })
  if (scenario === 'recalled') f.command('approval.notice.recalled', { requestId: 'proof-approval', noticeDigest: notice.digest,
    conversationId: 'private', messageId: 'delivered-message' })
  f.command('effect.begin', beginArgs('proof-gate')); f.command('effect.observe', receipt('proof-gate'))
  f.command('effect.prepare', prepared('proof-execute', { definition: { adapterId: 'synthetic', adapterVersion: '1', principalId: 'owner', target: 'synthetic-target', payload: { stage: 'execute-task', approvalRequestId: 'proof-approval' } } }))
  f.command('effect.begin', beginArgs('proof-execute')); f.command('effect.observe', receipt('proof-execute'))
  if (scenario === 'wrong-actor') f.db.exec("UPDATE execution_events SET payload=json_set(payload,'$.approverActorId','other') WHERE kind='approval.notice.delivered'")
  if (scenario === 'wrong-digest') f.db.exec("UPDATE execution_events SET payload=json_set(payload,'$.text','捏造告知') WHERE kind='approval.notice.delivered'")
  if (scenario === 'wrong-message') f.db.exec("UPDATE execution_events SET payload=json_remove(payload,'$.delivery.messageId') WHERE kind='approval.notice.delivered'")
  const read = () => queryEffects(f.db, { kind: 'approval.execution-proof', requestId: 'proof-approval', executeEffectId: 'proof-execute' })
  if (scenario.startsWith('wrong-')) assert.throws(read, /approval_presentation_not_proven|approval_notice_identity_conflict/)
  else {
    const proof = read()
    if (['missing','late'].includes(scenario)) assert.equal(proof.presentation, undefined)
    else {
      assert.equal(proof.presentation.text, '永久删除该列全部数据')
      assert.equal(proof.presentation.delivery.messageId, 'delivered-message')
      assert.ok(proof.presentation.deliveredSequence < proof.approvedSequence)
    }
  }
})
