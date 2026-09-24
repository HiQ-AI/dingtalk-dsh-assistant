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
    emitEvent: (kind, payload) => db.prepare('INSERT INTO test_events VALUES(?,?)').run(kind, JSON.stringify(payload)),
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
