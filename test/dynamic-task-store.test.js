import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dynamic-task-ledger-'))
  const config = { dbPath: join(root, 'dynamic.sqlite'), instanceId: 'fixture', initialize: true, ...options }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `command-${++sequence}`) => store.command({ id, kind, args })
  const query = args => store.query(args)
  async function task(taskId = 'task') {
    await command('task.create', { taskId, request: 'Deliver the requested outcome' })
    return (await command('task.claim', { taskId })).result
  }
  async function execution(binding, key = 'inspect') {
    const value = (await command('execution.dispatch', { binding, key, prompt: 'Inspect target', input: { objective: 'Inspect target' } })).result.execution
    return (await command('execution.claim', { executionId: value.executionId })).result.binding
  }
  return { root, config, command, query, task, execution, async reopen() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }); return store } }
}

test('dispatch is durable and idempotent; execution IDs are independent and owner claims are single flight', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'one'), b = await f.execution(owner.binding, 'two')
  assert.notEqual(a.executionId, b.executionId)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.ok(!Object.hasOwn(a, 'runId'))
  await assert.rejects(f.command('execution.claim', { executionId: a.executionId }), { code: 'DYNAMIC_EXECUTION_BUSY' })
  await assert.rejects(f.command('task.claim', { taskId: 'task' }), { code: 'DYNAMIC_TASK_BUSY' })
  const args = { binding: owner.binding, key: 'same', prompt: 'stable', input: {} }
  const first = await f.command('execution.dispatch', args, 'stable-command')
  assert.deepEqual((await f.command('execution.dispatch', args, 'stable-command')).result, first.result)
  assert.equal((await f.command('execution.dispatch', args, 'stable-command')).dispatchEligible, false)
  assert.equal((await f.command('execution.dispatch', args)).result.execution.executionId, first.result.execution.executionId)
  await assert.rejects(f.command('execution.dispatch', { ...args, input: { changed: true } }), { code: 'DYNAMIC_DISPATCH_KEY_CONFLICT' })
  await assert.rejects(f.command('execution.dispatch', { ...args, prompt: 'changed' }, 'stable-command'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: a.executionId })).recovering, true)
  assert.equal((await f.query({ kind: 'recovery.pending' })).executions.length, 3)
})

test('a late result is audited and wakes atomically without accepting an obsolete requirement', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('task.revise', { taskId: 'task', expectedRequirementRevision: 1, request: 'New requirement' })
  const result = await f.command('execution.result', { binding, output: { answer: 'old result' } })
  assert.equal(result.result.current, false)
  assert.equal(result.result.execution.status, 'stale')
  const wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  assert.equal(wakes.filter(item => item.kind === 'execution.result').length, 1)
  await f.command('execution.result', { binding, output: { answer: 'old result' } })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.state === 'pending').length, 2)
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result.payload.output.answer, 'old result')
})

test('cancel fences tools immediately and completion waits for physical drain and unresolved operations', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.result', { binding, output: { done: true } })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
  await f.command('execution.drained', { binding })
  await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  assert.equal(await f.query({ kind: 'execution.current', binding }), false)
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await assert.rejects(f.command('task.control', { taskId: 'task', control: 'active' }), { code: 'DYNAMIC_TASK_TERMINAL' })
})

test('continuation retains execution/session identity and versions inputs across requirement revisions', async t => {
  const f = await fixture(t), owner = await f.task(), first = await f.execution(owner.binding)
  await f.command('execution.result', { binding: first, output: { version: 1 } })
  await f.command('execution.drained', { binding: first })
  await f.command('task.revise', { taskId: 'task', request: 'Continue with new requirement' })
  await f.command('task.drained', { binding: owner.binding })
  const nextOwner = (await f.command('task.claim', { taskId: 'task' })).result
  await f.command('execution.continue', { binding: nextOwner.binding, executionId: first.executionId, key: 'next', prompt: 'Second goal', input: { objective: 'Second goal' } })
  const next = (await f.command('execution.claim', { executionId: first.executionId })).result.binding
  assert.equal(next.sessionId, first.sessionId)
  assert.equal(next.inputVersion, 2)
  assert.equal(next.requirementRevision, 2)
  assert.equal(next.inputHistory[0].inputDigest, first.inputDigest)
  await assert.rejects(f.command('execution.result', { binding: first, output: { late: true } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
})

test('generic operations persist before dispatch, unknown never replays, locks survive restart and reconciliation releases them', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'one'), b = await f.execution(owner.binding, 'two')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key, definition: { tool: 'write', input: 'same' }, resourceKeys: ['repo:main'] })).result.operation
  const first = await prepare(a, 'write-a'), second = await prepare(b, 'write-b')
  assert.equal((await f.command('operation.start', { binding: a, operationId: first.operationId }, 'start-a')).dispatchEligible, true)
  assert.equal((await f.command('operation.start', { binding: a, operationId: first.operationId }, 'start-a')).dispatchEligible, false)
  await assert.rejects(f.command('operation.start', { binding: b, operationId: second.operationId }), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.reopen()
  assert.equal((await f.query({ kind: 'operation.get', operationId: first.operationId })).state, 'unknown')
  await assert.rejects(f.command('operation.start', { binding: a, operationId: first.operationId }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await assert.rejects(f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'succeeded', result: {} }), { code: 'DYNAMIC_OPERATION_RECONCILIATION_REQUIRED' })
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { receipt: 'confirmed' }, evidenceRef: 'proof/external-receipt' })
  assert.equal((await f.query({ kind: 'resource.list' })).length, 0)
  await f.command('execution.drained', { binding: b })
  const resumed = (await f.command('execution.claim', { executionId: b.executionId })).result.binding
  assert.equal((await f.command('operation.start', { binding: resumed, operationId: second.operationId })).dispatchEligible, true)
})

test('business completion creates a unique notification atomically; uncertain delivery does not restart business or resend', async t => {
  const f = await fixture(t), owner = await f.task()
  const done = await f.command('task.complete', { binding: owner.binding, summary: 'Verified done', notification: { destination: 'group-1', text: 'Done' } }, 'complete')
  assert.equal(done.result.task.status, 'completed')
  const notificationId = done.result.notification.notificationId
  const started = await f.command('notification.start', { notificationId })
  assert.equal(started.dispatchEligible, true)
  await f.reopen()
  assert.equal((await f.query({ kind: 'notification.get', notificationId })).state, 'unknown')
  assert.equal((await f.command('notification.start', { notificationId })).dispatchEligible, false)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'completed')
  await f.command('notification.reconcile', { notificationId, state: 'delivered', evidenceRef: 'proof/notification', receipt: { messageId: 'actual' } })
  assert.equal((await f.query({ kind: 'notification.list' })).length, 1)
})

test('source route decisions are immutable and group sessions reclaim pending sources after restart', async t => {
  const f = await fixture(t)
  const args = { sourceId: 'source-1', groupId: 'group-1', messageId: 'msg-1', actorId: 'user-1', senderName: '真实作者', text: 'Do the work' }
  await f.command('source.record', args)
  await f.command('source.record', args)
  const group = (await f.command('group.claim', { groupId: 'group-1' })).result
  assert.deepEqual(group.sourceIds, ['source-1'])
  await f.command('source.routePrepared', { sourceId: 'source-1', decision: { actions: [{ kind: 'create', taskId: 'task-1' }] } })
  await assert.rejects(f.command('source.routePrepared', { sourceId: 'source-1', decision: { actions: [{ kind: 'ignore' }] } }), { code: 'DYNAMIC_SOURCE_ROUTE_CONFLICT' })
  await f.command('group.drained', { binding: group.binding })
  await f.reopen()
  const next = (await f.command('group.claim', { groupId: 'group-1' })).result
  assert.equal(next.binding.sessionId, group.binding.sessionId)
  assert.equal(next.binding.leaseEpoch, 2)
  assert.equal(next.sources[0].routeDecision.actions[0].taskId, 'task-1')
  await f.command('source.routed', { sourceId: 'source-1', receipt: { taskId: 'task-1' } })
  assert.equal((await f.query({ kind: 'source.list', groupId: 'group-1', status: 'pending' })).length, 0)
})

test('legacy unresolved effects and undrained native sessions become read-only blockers, never dynamic jobs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-legacy-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const legacyDbPath = join(directory, 'legacy.sqlite'), old = new DatabaseSync(legacyDbPath)
  old.exec(`CREATE TABLE execution_runs(run_id TEXT,task_id TEXT); CREATE TABLE execution_effects(effect_id TEXT,run_id TEXT,state TEXT,resource_keys_json TEXT);
    CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,session_id TEXT,status TEXT,drained INTEGER);
    INSERT INTO execution_runs VALUES ('run','task'); INSERT INTO execution_effects VALUES ('effect','run','unknown','["repo:legacy"]');
    INSERT INTO execution_nodes VALUES ('node','run','old-session','running',0);`)
  old.close()
  const f = await fixture(t, { legacyDbPath }), owner = await f.task()
  assert.equal((await f.query({ kind: 'legacy.list' })).length, 2)
  await assert.rejects(f.execution(owner.binding), { code: 'DYNAMIC_LEGACY_EFFECT_UNRESOLVED' })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
  const readback = new DatabaseSync(legacyDbPath, { readOnly: true })
  assert.equal(readback.prepare('SELECT state FROM execution_effects').get().state, 'unknown')
  readback.close()
  assert.equal((await f.query({ kind: 'execution.list' })).length, 0)
})


test('result and wake roll back together on a failed SQLite write and the same command remains safely retryable', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_result_wake BEFORE INSERT ON dynamic_wakes BEGIN SELECT RAISE(ABORT,'injected wake failure'); END;")
  await assert.rejects(f.command('execution.result', { binding, output: { done: true } }, 'atomic-result'), /injected wake failure/)
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result, undefined)
  assert.equal(await f.query({ kind: 'receipt.get', id: 'atomic-result' }), null)
  inspect.exec('DROP TRIGGER reject_result_wake'); inspect.close()
  await f.command('execution.result', { binding, output: { done: true } }, 'atomic-result')
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
})

test('initialization marker rejects database loss and an accidental initialize flag cannot create a replacement ledger', async t => {
  const f = await fixture(t)
  await f.task()
  const reopened = await f.reopen(); await reopened.close()
  for (const suffix of ['', '-wal', '-shm']) await rm(f.config.dbPath + suffix, { force: true })
  await assert.rejects(openDynamicTaskStore(f.config), { code: 'DYNAMIC_STORE_LOST' })
})

test('question and status notifications are idempotent, independently durable, and obsolete questions never send', async t => {
  const f = await fixture(t), owner = await f.task()
  const args = { notificationId: 'question:task:1', taskId: 'task', requirementRevision: 1, kind: 'question', payload: { text: 'Which target?' } }
  await f.command('notification.prepare', args)
  await f.command('notification.prepare', args)
  await assert.rejects(f.command('notification.prepare', { ...args, payload: { text: 'Different question' } }), { code: 'DYNAMIC_NOTIFICATION_ID_CONFLICT' })
  await f.command('notification.prepare', { ...args, notificationId: 'status:task:1', kind: 'status', payload: { text: 'Working' } })
  await f.command('task.revise', { taskId: 'task', request: 'Target clarified', expectedControlRevision: 1 })
  assert.equal((await f.command('notification.start', { notificationId: args.notificationId })).dispatchEligible, false)
  assert.equal((await f.query({ kind: 'notification.get', notificationId: args.notificationId })).reason, 'stale_question')
  assert.equal((await f.command('notification.start', { notificationId: 'status:task:1' })).dispatchEligible, true)
  await f.command('task.control', { taskId: 'task', control: 'paused' })
  await assert.rejects(f.command('task.revise', { taskId: 'task', request: 'stale control input', expectedControlRevision: 1 }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
})

test('unclean process restart fences started operations and retains result/wake receipts without replay', async t => {
  const { spawnSync } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-process-crash-'))
  let store
  t.after(async () => { try { await store?.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const dbPath = join(directory, 'state.sqlite'), module = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const script = `import {openDynamicTaskStore} from ${JSON.stringify(module)};
    const s=await openDynamicTaskStore({dbPath:${JSON.stringify(dbPath)},instanceId:'child',initialize:true});
    let i=0; const c=(kind,args)=>s.command({id:'c'+ ++i,kind,args});
    await c('task.create',{taskId:'task',request:'do work'}); const owner=(await c('task.claim',{taskId:'task'})).result.binding;
    const e=(await c('execution.dispatch',{binding:owner,key:'one',prompt:'work',input:{}})).result.execution;
    const b=(await c('execution.claim',{executionId:e.executionId})).result.binding;
    const op=(await c('operation.prepare',{binding:b,key:'write',definition:{tool:'write'},resourceKeys:['shared']})).result.operation;
    await c('operation.start',{binding:b,operationId:op.operationId}); console.log(JSON.stringify({executionId:e.executionId,operationId:op.operationId})); process.exit(0);`
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const identities = JSON.parse(child.stdout.trim())
  store = await openDynamicTaskStore({ dbPath, instanceId: 'child' })
  assert.equal((await store.query({ kind: 'operation.get', operationId: identities.operationId })).state, 'unknown')
  assert.equal((await store.query({ kind: 'execution.get', executionId: identities.executionId })).recovering, true)
  assert.equal((await store.query({ kind: 'resource.list' }))[0].resourceKey, 'shared')
  assert.equal((await store.query({ kind: 'receipt.get', id: 'c6' })).dispatchEligible, true)
})


test('an explicit Web routing intent is recorded atomically with its original source and cannot be reinterpreted', async t => {
  const f = await fixture(t)
  const args = { sourceId: 'web-source', groupId: 'group', messageId: 'web-request', actorId: 'user', channel: 'web', text: 'create directly',
    routeDecision: { actions: [{ action: 'create', requestId: 'stable-request', objective: 'Do the requested work' }] } }
  await f.command('source.record', args)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'source.get', sourceId: args.sourceId })).routeDecision, args.routeDecision)
  await f.command('source.record', args)
  await assert.rejects(f.command('source.record', { ...args, routeDecision: { actions: [{ action: 'ignore' }] } }), { code: 'DYNAMIC_SOURCE_CONFLICT' })
  await assert.rejects(f.command('source.routePrepared', { sourceId: args.sourceId, decision: { actions: [] } }), { code: 'DYNAMIC_SOURCE_ROUTE_CONFLICT' })
})

test('dispatch rollback before durable receipt creates no orphan, and lost post-commit acknowledgement replays one identity', async t => {
  const f = await fixture(t), owner = await f.task()
  const args = { binding: owner.binding, key: 'crash-window', prompt: 'Inspect without duplication', input: {} }
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_dispatch_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='dispatch-crash' BEGIN SELECT RAISE(ABORT,'injected dispatch receipt failure'); END;")
  await assert.rejects(f.command('execution.dispatch', args, 'dispatch-crash'), /injected dispatch receipt failure/)
  assert.equal((await f.query({ kind: 'execution.list' })).length, 0)
  assert.equal(await f.query({ kind: 'receipt.get', id: 'dispatch-crash' }), null)
  inspect.exec('DROP TRIGGER reject_dispatch_receipt'); inspect.close()
  const accepted = await f.command('execution.dispatch', args, 'dispatch-crash')
  await f.reopen()
  const repeated = await f.command('execution.dispatch', args, 'dispatch-crash')
  assert.equal(repeated.result.execution.executionId, accepted.result.execution.executionId)
  assert.equal((await f.query({ kind: 'execution.list' })).length, 1)
})

test('result receipt failure rolls back both result and wake; post-commit restart retains one result/wake pair', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { binding, output: { summary: 'Persist the observation once' } }
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_result_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='result-crash' BEGIN SELECT RAISE(ABORT,'injected result receipt failure'); END;")
  await assert.rejects(f.command('execution.result', args, 'result-crash'), /injected result receipt failure/)
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result, undefined)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 0)
  inspect.exec('DROP TRIGGER reject_result_receipt'); inspect.close()
  await f.command('execution.result', args, 'result-crash')
  await f.reopen()
  await f.command('execution.result', args, 'result-crash')
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result.payload.output, args.output)
})

test('native unknown fence is atomic at start even if two operations were prepared before the first became unknown', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'writer-a'), b = await f.execution(owner.binding, 'writer-b')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key,
    definition: { toolName: 'concurrency_safe_write' }, resourceKeys: [] })).result.operation
  const first = await prepare(a, 'a'), second = await prepare(b, 'b')
  await f.command('operation.start', { binding: a, operationId: first.operationId })
  await f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'unknown', result: { lostReceipt: true } })
  await assert.rejects(f.command('operation.start', { binding: b, operationId: second.operationId }, 'pending-native-start'), { code: 'DYNAMIC_OPERATION_UNRESOLVED' })
  assert.equal((await f.query({ kind: 'operation.get', operationId: second.operationId })).state, 'prepared')
  assert.equal(await f.query({ kind: 'receipt.get', id: 'pending-native-start' }), null)
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { confirmed: true }, evidenceRef: 'verified-external-receipt' })
  assert.equal((await f.command('operation.start', { binding: b, operationId: second.operationId }, 'pending-native-start')).dispatchEligible, true)
})

test('a definitively refused prepared request can be retired by its exact binding/key without clearing unknown writes', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'a'), b = await f.execution(owner.binding, 'b')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key, definition: { toolName: 'write' }, resourceKeys: [] })).result.operation
  const first = await prepare(a, 'first'), second = await prepare(b, 'second')
  await f.command('operation.start', { binding: a, operationId: first.operationId })
  await assert.rejects(f.command('operation.cancelPrepared', { binding: a, operationId: first.operationId, key: 'first', reason: 'not-started' }), { code: 'DYNAMIC_OPERATION_ALREADY_DISPATCHED' })
  await f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'unknown' })
  await assert.rejects(f.command('operation.start', { binding: b, operationId: second.operationId }), { code: 'DYNAMIC_OPERATION_UNRESOLVED' })
  const cancel = { binding: b, operationId: second.operationId, key: 'second', reason: 'atomic-start-refused' }
  for (const override of [{binding:a}, {key:'other-request'}, {binding:{...b,leaseEpoch:b.leaseEpoch+1}}])
    await assert.rejects(f.command('operation.cancelPrepared', {...cancel,...override}), { code: 'DYNAMIC_OPERATION_SCOPE_STALE' })
  await assert.rejects(f.command('operation.cancelPrepared', { binding: a, operationId: first.operationId, key: 'first', reason: 'not-started' }), { code: 'DYNAMIC_OPERATION_ALREADY_DISPATCHED' })
  await f.command('operation.cancelPrepared', cancel, 'cancel-exact-prepared')
  await f.command('operation.cancelPrepared', cancel, 'cancel-exact-prepared')
  assert.equal((await f.query({ kind: 'operation.get', operationId: second.operationId })).state, 'cancelled')
  assert.equal((await f.query({ kind: 'operation.get', operationId: first.operationId })).state, 'unknown')
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'trusted-receipt' })
  assert.equal((await f.query({ kind: 'task.blockers', taskId: 'task' })).operations.length, 0)
})

test('job reconciliation rejects absent and foreign proof; readonly continuation preserves unknown and forbids effects', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operationId='unknown-effect'
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh'},resourceKeys:[]})
  await f.command('operation.start',{binding,operationId})
  await assert.rejects(f.command('operation.job',{binding,operationId,job:{jobId:'foreign',owner:'foreign-session',startedAt:1,status:'completed',finishedAt:2}}),{code:'DYNAMIC_JOB_RECEIPT_INVALID'})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{reason:'missing receipt'}})
  await assert.rejects(f.command('operation.reconcile-job',{binding:owner.binding,operationId}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  await f.command('execution.result',{binding,output:{status:'blocked'}})
  await f.command('execution.drained',{binding})
  const args={binding:owner.binding,executionId:binding.executionId,key:'readback',prompt:'Inspect without replay',input:{},definition:{recoveryReadOnly:true}}
  await f.command('execution.continue',args)
  const next=(await f.command('execution.claim',{executionId:binding.executionId})).result.binding
  await f.command('operation.prepare',{binding:next,operationId:'investigation',key:'investigation',definition:{toolName:'pwsh'}})
  await assert.rejects(f.command('operation.start',{binding:next,operationId:'investigation'}),{code:'DYNAMIC_OPERATION_UNRESOLVED'})
  assert.equal((await f.query({kind:'operation.get',operationId})).state,'unknown')
})

test('terminal job receipt cannot reconcile an undrained execution; successful reconciliation preserves unknown evidence', async t => {
  const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='drain-proof'
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh'},resourceKeys:['host-native-operation']})
  await f.command('operation.start',{binding,operationId})
  await f.command('operation.job',{binding,operationId,job:{jobId:'original-job',owner:binding.sessionId,startedAt:1,status:'killed',finishedAt:2}})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{reason:'cancelled-with-partial-effects'}})
  await assert.rejects(f.command('operation.reconcile-job',{binding:owner.binding,operationId}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  await f.command('execution.result',{binding,output:{status:'blocked'}})
  await f.command('execution.drained',{binding})
  const value=(await f.command('operation.reconcile-job',{binding:owner.binding,operationId})).result.operation
  assert.equal(value.state,'failed');assert.equal(value.result.partialEffectsPossible,true)
  assert.equal(value.result.previousObservation.reason,'cancelled-with-partial-effects')
  assert.equal((await f.query({kind:'resource.list'})).length,0)
})


test('verified legacy stop closes only failed with retained unknown audit and never creates a replacement execution', async t => {
  const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='legacy-stop'
  const hash = value => createHash('sha256').update(JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item)).digest('hex')
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:['host-native-operation']})
  await f.command('operation.start',{binding,operationId})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',resultDigest:'original-result',isError:true}})
  await f.command('execution.result',{binding,output:{status:'blocked'}});await f.command('execution.drained',{binding})
  await f.command('execution.continue',{binding:owner.binding,executionId:binding.executionId,key:'readback',prompt:'Read evidence',input:{readbackOperationId:operationId},definition:{recoveryReadOnly:true}})
  const readBinding=(await f.command('execution.claim',{executionId:binding.executionId})).result.binding
  await f.command('execution.result',{binding:readBinding,output:{status:'completed'}});await f.command('execution.drained',{binding:readBinding})
  const original=await f.query({kind:'operation.get',operationId})
  const proof={kind:'legacy-host-drained-partial',operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
    callId:'call',resultDigest:'original-result',argumentsDigest:'args',partialEffectsPossible:true,
    observations:[{executionId:binding.executionId,sessionId:binding.sessionId,inputVersion:2}]}
  await assert.rejects(f.command('operation.reconcile-stopped',{binding:owner.binding,operationId,proof:{...proof,observations:[]}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  const value=(await f.command('operation.reconcile-stopped',{binding:owner.binding,operationId,proof})).result.operation
  assert.equal(value.state,'failed');assert.equal(value.result.partialEffectsPossible,true)
  assert.deepEqual(value.result.previousObservation,original)
  assert.equal((await f.query({kind:'execution.list'})).length,1)
  assert.equal((await f.query({kind:'resource.list'})).length,0)
})

async function humanWaiting(f, requestId = 'human-request') {
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'Resolve the original task' })
  const owner = (await f.command('task.claim', { taskId: 'human-task' })).result
  const args = { binding: owner.binding, action: 'blocked', summary: '等待有权人员补充', question: '请选择目标环境', humanRequest: { requestId, reason: '缺少目标环境', attemptedActions: ['已读取原始交办及当前环境配置'] } }
  await f.command('task.wait', args)
  await f.command('task.drained', { binding: owner.binding })
  return { owner, args, respond: { taskId: 'human-task', requestId, sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 } }
}
async function humanSource(f, actorId = 'owner', groupId = 'g') {
  await f.command('source.record', { sourceId: 'human-answer', groupId, messageId: 'reply-original', actorId, text: '仅在 UAT3 执行已说明的修改', channel: actorId === 'web-user' ? 'web' : 'im' })
}

test('human request freezes the question and resumes the same task from its authorized original source idempotently', async t => {
  const f = await fixture(t), { owner, args, respond } = await humanWaiting(f)
  const waiting = await f.query({ kind: 'task.get', taskId: 'human-task' })
  assert.equal(waiting.humanRequests[0].status, 'waiting-reply')
  assert.equal(waiting.humanRequests[0].question, args.question)
  assert.deepEqual(waiting.humanRequests[0].attemptedActions, ['已读取原始交办及当前环境配置'])
  await humanSource(f)
  const first = await f.command('task.human.respond', respond, 'stable-human-response')
  assert.equal(first.result.request.status, 'answered')
  assert.equal(first.result.request.reply, '仅在 UAT3 执行已说明的修改')
  assert.equal(first.result.request.actorId, 'owner')
  assert.equal(first.result.task.sessionId, owner.task.sessionId)
  assert.equal(first.result.task.lastDecision, null)
  assert.deepEqual(first.result.task.sourceRefs, ['human-answer'])
  assert.equal(first.result.task.requirementRevision, 1)
  assert.deepEqual((await f.command('task.human.respond', respond, 'stable-human-response')).result, first.result)
  await assert.rejects(f.command('task.human.respond', respond), { code: 'DYNAMIC_HUMAN_REQUEST_STALE' })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'human-task' })).filter(wake => wake.kind === 'human.responded').length, 1)
  await f.reopen()
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'answered')
})

for (const testCase of ['other-actor','other-group','stale-requirement','stale-control','not-drained','revised','cancelled','completed']) test(`human response rejects an invalid or superseded request: ${testCase}`, async t => {
  const f = await fixture(t), { owner, respond } = await humanWaiting(f)
  await humanSource(f, testCase === 'other-actor' ? 'outsider' : 'owner', testCase === 'other-group' ? 'other' : 'g')
  if (testCase === 'stale-requirement') respond.expectedRequirementRevision = 2
  if (testCase === 'stale-control') respond.expectedControlRevision = 2
  if (testCase === 'not-drained') await f.command('task.claim', { taskId: 'human-task', force: true })
  if (testCase === 'revised') { await f.command('task.revise', { taskId: 'human-task', request: 'new requirement' }); respond.expectedRequirementRevision = 2 }
  if (testCase === 'cancelled') { await f.command('task.control', { taskId: 'human-task', control: 'cancelled' }); respond.expectedControlRevision = 2 }
  if (testCase === 'completed') {
    const claim = (await f.command('task.claim', { taskId: 'human-task', force: true })).result
    await f.command('task.complete', { binding: claim.binding, summary: 'done' })
  }
  await assert.rejects(f.command('task.human.respond', respond))
  if (['revised','cancelled','completed'].includes(testCase)) assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'superseded')
})

test('human request requires an explicit stable identity and accepts only configured web actor without impersonation', async t => {
  const f = await fixture(t, { webActorId: 'web-user' }), { owner, respond } = await humanWaiting(f)
  const fresh = await f.task('other-task')
  await assert.rejects(f.command('task.wait', { binding: fresh.binding, summary: 'ask', question: 'who?' }), { code: 'DYNAMIC_HUMAN_REQUEST_REQUIRED' })
  await humanSource(f, 'web-user')
  const result = await f.command('task.human.respond', respond)
  assert.equal(result.result.request.actorId, 'web-user')
  assert.equal(result.result.task.ownerActorId, 'owner')
})

test('waiting human request identities conflict on changed questions and an answer never reconciles unknown operations', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'original task' })
  const { binding } = (await f.command('task.claim', { taskId: 'human-task' })).result
  const execution = await f.execution(binding)
  const operation = (await f.command('operation.prepare', { binding: execution, key: 'original-write', definition: { toolName: 'write' }, resourceKeys: ['repo:unknown'] })).result.operation
  await f.command('operation.start', { binding: execution, operationId: operation.operationId })
  await f.command('operation.settle', { binding: execution, operationId: operation.operationId, state: 'unknown', result: { uncertain: true } })
  await f.command('execution.drained', { binding: execution })
  const args = { binding, summary: '等待人工判断', question: '确认目标', humanRequest: { requestId: 'stable-question' } }
  await f.command('task.wait', args)
  await f.command('task.wait', args)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests.length, 1)
  await assert.rejects(f.command('task.wait', { ...args, question: '其他目标' }), { code: 'DYNAMIC_HUMAN_REQUEST_CONFLICT' })
  await f.command('task.drained', { binding })
  await humanSource(f)
  await f.command('task.human.respond', { taskId: 'human-task', requestId: 'stable-question', sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'unknown')
  assert.equal((await f.query({ kind: 'resource.list' })).length, 1)
})

test('execution progress review is durable and idempotent without changing results, unknown effects or locks', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding, key: 'uncertain', definition: { toolName: 'pwsh' }, resourceKeys: ['repo:original'] })).result.operation
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'unknown', result: { uncertain: true } })
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: 12, lastActivityAt: '2026-10-14T09:00:00Z', newEventCount: 3, changed: true, records: ['must not persist actual log text'] } }
  const first = await f.command('execution.progressReviewed', args, 'progress-slot-one')
  assert.equal(first.result.execution.status, 'running')
  assert.equal(first.result.execution.drained, false)
  assert.equal(first.result.execution.result, undefined)
  assert.equal(first.result.execution.progressReview.lastSequence, 12)
  assert.equal(first.result.execution.progressReview.records, undefined)
  assert.deepEqual((await f.command('execution.progressReviewed', args, 'progress-slot-one')).result, first.result)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(wake => wake.kind === 'execution.progress.review').length, 1)
  assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'unknown')
  assert.equal((await f.query({ kind: 'resource.list' })).length, 1)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, first.result.execution.progressReview)
})

for (const field of ['executionId', 'inputVersion', 'leaseEpoch', 'inputDigest']) test(`progress review rejects a foreign execution identity field: ${field}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: -1, lastActivityAt: null, newEventCount: 0, changed: false } }
  args[field] = typeof args[field] === 'number' ? args[field] + 1 : 'foreign'
  await assert.rejects(f.command('execution.progressReviewed', args))
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, undefined)
})

test('an unchanged or unreadable execution observation wakes review without claiming success; continuation clears the old review clock', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: -1, lastActivityAt: null, newEventCount: 0, changed: false, readError: 'NATIVE_LOG_UNAVAILABLE' } }
  const result = await f.command('execution.progressReviewed', args)
  assert.equal(result.result.execution.progressReview.changed, false)
  assert.equal(result.result.execution.progressReview.readError, 'NATIVE_LOG_UNAVAILABLE')
  assert.equal(result.result.execution.status, 'running')
  assert.equal(result.result.execution.result, undefined)
  assert.ok((await f.query({ kind: 'wake.list', taskId: 'task' })).some(wake => wake.kind === 'execution.progress.review' && wake.payload.executionId === binding.executionId))
  await f.command('execution.result', { binding, output: { summary: 'actual completed result' } })
  await f.command('execution.drained', { binding })
  await assert.rejects(f.command('execution.progressReviewed', args), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await f.command('execution.continue', { binding: owner.binding, executionId: binding.executionId, key: 'follow-up', prompt: 'follow-up', input: {} })
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, null)
})
