import {receiptOwnerSql} from '../packages/dingtalk-dsh-assistant/task-archive.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { freezeCoordinationMembers } from '../packages/dingtalk-dsh-assistant/coordination-task-commands.js'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-archive-'))
  const config = { dbPath: join(root, 'tasks.sqlite'), instanceId: 'archive-test', initialize: true }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args = {}, id = `command-${++sequence}`) => store.command({ id, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const inspect = run => {
    const db = new DatabaseSync(config.dbPath, { readOnly: true })
    try { return run(db) } finally { db.close() }
  }
  const mutate = run => {
    const db = new DatabaseSync(config.dbPath)
    try { return run(db) } finally { db.close() }
  }
  const create = async taskId => {
    await command('task.create', { taskId, groupId: 'g', ownerActorId: 'u', request: `Synthetic outcome ${taskId}` })
    return (await command('task.claim', { taskId })).result
  }
  const finish = async (taskId, id = `complete-${taskId}`) => {
    const task = await query('task.get', { taskId })
    const binding = task.drained
      ? (await command('task.claim', { taskId, force: true })).result.binding
      : await query('task.binding', { taskId })
    const wakeIds = (await query('wake.list', { taskId }))
      .filter(wake => wake.state === 'claimed' && wake.leaseEpoch === binding.leaseEpoch).map(wake => wake.id)
    if (wakeIds.length) await command('wake.ack', { binding, wakeIds })
    const args = { binding, summary: 'Synthetic accepted result', result: { evidence: ['fixture:verified'] } }
    const receipt = await command('task.complete', args, id)
    await command('task.drained', { binding })
    return { receipt, args, id }
  }
  const execution = async binding => {
    const row = (await command('execution.dispatch', { binding, key: 'proof', prompt: 'Synthetic proof', input: { objective: 'Synthetic proof' } })).result.execution
    return { row, binding: (await command('execution.claim', { executionId: row.executionId })).result.binding }
  }
  return { root, config, get store(){return store}, command, query, inspect, mutate, create, finish, execution,
    async restart() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }) } }
}

async function decisions(f, taskId) {
  const result = []
  let before
  do {
    const page = await f.query('task.decisions', { taskId, limit: 1, ...(before === undefined ? {} : { before }) })
    result.push(...page.decisions)
    before = page.nextBefore
  } while (before !== null)
  return result
}

test('explicit archive moves owned history; completion alone stays active and archive remains readable', async t => {
  const f = await fixture(t), owner = await f.create('A')
  await f.command('task.wait', { binding: owner.binding, action: 'wait', summary: 'First observation', evidence: ['fixture:first'] }, 'decision-first')
  await f.command('task.wait', { binding: owner.binding, action: 'wait', summary: 'Second observation', evidence: ['fixture:second'] }, 'decision-second')
  const execution = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding: execution.binding, key: 'write', definition: { tool: 'write' }, resourceKeys: [] })).result.operation
  await f.command('operation.start', { binding: execution.binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding: execution.binding, operationId: operation.operationId, state: 'succeeded', result: { receipt: 'fixture:effect-once' } })
  await f.command('execution.result', { binding: execution.binding, output: { summary: 'Synthetic file verified' } })
  await f.command('execution.drained', { binding: execution.binding })
  const completed = await f.finish('A')
  await f.create('B'); await f.finish('B')
  const history = await decisions(f, 'A')
  const events = (await f.query('task.events', { after: 0, limit: 100 })).events.filter(event => event.taskId === 'A')
  assert.ok((await f.query('task.list')).some(task => task.taskId === 'A'))
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM dynamic_archived_tasks').get().n), 0)
  const originalReceipt = f.inspect(db => db.prepare('SELECT rowid AS sequence,digest FROM dynamic_receipts WHERE id=?').get(completed.id))

  const args = { taskId: 'A', actorId: 'operator' }
  const archived = (await f.command('task.archive', args, 'archive-A')).result.task
  assert.ok(archived.archivedAt)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_tasks WHERE id='A'").get().n), 0)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_archived_tasks WHERE id='A'").get().n), 1)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_executions WHERE json_extract(body,'$.taskId')='A'").get().n), 0)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM dynamic_archived_executions WHERE id=?').get(execution.row.executionId).n), 1)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM dynamic_archived_operations WHERE id=?').get(operation.operationId).n), 1)
  assert.ok(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_archived_wakes WHERE json_extract(body,'$.taskId')='A'").get().n) > 0)
  assert.deepEqual((await f.query('task.list')).map(task => task.taskId), ['B'])
  assert.equal((await f.query('task.index')).items.some(task => task.taskId === 'A'), false)
  assert.equal((await f.query('execution.index')).items.some(item => item.taskId === 'A'), false)
  assert.equal((await f.query('task.get', { taskId: 'A' })).request, 'Synthetic outcome A')
  assert.equal((await f.query('execution.get', { executionId: execution.row.executionId })).result.payload.output.summary, 'Synthetic file verified')
  assert.deepEqual((await f.query('execution.list', { taskId: 'A' })).map(item => item.executionId), [execution.row.executionId])
  assert.deepEqual(await decisions(f, 'A'), history)
  assert.deepEqual((await f.query('task.events', { after: 0, limit: 100 })).events.filter(event => event.taskId === 'A'), events)
  assert.deepEqual(f.inspect(db => db.prepare('SELECT rowid AS sequence,digest FROM dynamic_receipts WHERE id=?').get(completed.id)), originalReceipt)
  const receiptHeader = f.inspect(db => JSON.parse(db.prepare('SELECT body FROM dynamic_receipts WHERE id=?').get(completed.id).body))
  assert.equal(receiptHeader.archivedTaskId, 'A')
  assert.equal(receiptHeader.result, undefined)
  assert.equal((await f.command('task.archive', args, 'archive-A')).replayed, true)
  assert.equal((await f.command('task.archive', args)).result.task.archivedAt, archived.archivedAt)
  await f.restart()
  const replay = await f.command('task.complete', completed.args, completed.id)
  assert.equal(replay.replayed, true)
  assert.equal(replay.dispatchEligible, false)
  assert.equal(replay.result.task.request, 'Synthetic outcome A')
  assert.deepEqual(await decisions(f, 'A'), history)
  await assert.rejects(f.command('task.reopen', { taskId: 'A', request: 'New target' }), { code: 'DYNAMIC_TASK_ARCHIVED_CONFLICT' })
})

test('archive transaction rollback leaves the original task and history usable', async t => {
  const f = await fixture(t), owner = await f.create('A'), execution = await f.execution(owner.binding)
  await f.command('execution.result', { binding: execution.binding, output: { verified: true } })
  await f.command('execution.drained', { binding: execution.binding })
  const completed = await f.finish('A')
  f.mutate(db => db.exec("CREATE TRIGGER reject_archive_fixture BEFORE DELETE ON dynamic_tasks WHEN OLD.id='A' BEGIN SELECT RAISE(ABORT,'archive_fixture_failure'); END"))
  await assert.rejects(f.command('task.archive', { taskId: 'A', actorId: 'operator' }, 'archive-retry'), /archive_fixture_failure/)
  assert.equal((await f.query('task.get', { taskId: 'A' })).archivedAt, undefined)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_tasks WHERE id='A'").get().n), 1)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_archived_tasks WHERE id='A'").get().n), 0)
  assert.equal((await f.query('receipt.get', { id: completed.id })).result.task.request, 'Synthetic outcome A')
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_receipts WHERE id='archive-retry'").get().n), 0)
  f.mutate(db => db.exec('DROP TRIGGER reject_archive_fixture'))
  await f.command('task.archive', { taskId: 'A', actorId: 'operator' }, 'archive-retry')
  assert.ok((await f.query('task.get', { taskId: 'A' })).archivedAt)
})

test('archived prerequisite keeps its original completion receipt and event available to coordination after restart', async t => {
  const f = await fixture(t)
  for (const taskId of ['A', 'B']) await f.command('task.create', { taskId, groupId: 'g', ownerActorId: 'u', request: `Synthetic outcome ${taskId}` })
  const source = (await f.command('coordination.reserve', { unitId: 'source', revision: 1, groupId: 'g', actorId: 'u', original: 'Continue B after A is accepted' })).result.source
  const tasks = new Map((await f.query('task.list')).map(task => [task.taskId, task]))
  const proposal = coordinationProposalSchema.parse({ kind: 'arrangement', members: [
    { action: 'task-observe', taskId: 'A', inputVersion: 1, runSequence: 1 },
    { action: 'task-continue', taskId: 'B', inputVersion: 1, runSequence: 1, progressImpact: 'preserve', impactReason: 'Continue original result', context: 'A accepted', afterTaskIds: ['A'] },
  ] })
  const members = freezeCoordinationMembers({ coordinationId: 'c', proposal, tasks, source: { ...source, sourceId: source.id, unitRevision: source.revision, actorId: 'u' } })
  await f.command('coordination.accept', { coordinationId: 'c', sourceId: source.id, fence: source.fence, members })
  const completed = await f.finish('A')
  await f.command('task.archive', { taskId: 'A', actorId: 'operator' })
  await f.restart()
  await f.command('coordination.observe.reconcile', { coordinationId: 'c' })
  const state = await f.query('coordination.get', { coordinationId: 'c' })
  const observed = state.members.find(member => member.observation)
  assert.equal(observed.state, 'fulfilled')
  assert.equal(observed.completionProof.taskDecisionReceiptId, completed.id)
  assert.notEqual(state.members.find(member => member.taskId === 'B').waitingReason?.code, 'waiting_dependency')
  const occurrenceArgs = { coordinationId: 'c', trigger: { triggerKind: 'business-event', eventSource: 'task-decision-receipt', eventId: `task-decision:${completed.id}`, actionId: members[1].instructionId },
    action: { kind: 'task-command', instructionIds: [members[1].instructionId] }, target: { conversationId: 'g', recipientIds: [], summaryOnly: true } }
  await f.command('coordination.occurrence.accept', occurrenceArgs)
  await f.restart()
  await f.command('coordination.occurrence.accept', occurrenceArgs)
  assert.equal((await f.query('coordination.occurrence.list')).length, 1)
  assert.equal((await f.query('task.get', { taskId: 'A' })).status, 'completed')
})

test('archive attempt retains unknown external operation and its durable resource ownership', async t => {
  const f = await fixture(t), owner = await f.create('A'), execution = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding: execution.binding, key: 'uncertain', definition: { tool: 'write' }, resourceKeys: ['fixture:effect'] })).result.operation
  const startArgs = { binding: execution.binding, operationId: operation.operationId }
  await f.command('operation.start', startArgs, 'start-once')
  await f.restart()
  assert.equal((await f.query('operation.get', { operationId: operation.operationId })).state, 'unknown')
  await assert.rejects(f.command('task.archive', { taskId: 'A', actorId: 'operator' }), { code: 'DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT' })
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM dynamic_operations WHERE id=?').get(operation.operationId).n), 1)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM dynamic_archived_operations WHERE id=?').get(operation.operationId).n), 0)
  assert.equal((await f.query('resource.list')).length, 1)
  const replay = await f.command('operation.start', startArgs, 'start-once')
  assert.equal(replay.replayed, true)
  assert.equal(replay.dispatchEligible, false)
  assert.equal((await f.query('operation.get', { operationId: operation.operationId })).state, 'unknown')
})

test('archiving retains prepared notification control so recovery cannot lose an unsent effect', async t => {
  const f = await fixture(t)
  await f.create('A'); await f.finish('A')
  await f.command('notification.prepare', { notificationId: 'pending-notice', taskId: 'A', requirementRevision: 1, kind: 'status', payload: { conversationId: 'g', text: 'Synthetic pending result' } })
  await f.command('task.archive', { taskId: 'A', actorId: 'operator' })
  await f.restart()
  const pending = (await f.query('notification.list')).find(item => item.id === 'pending-notice')
  assert.ok(pending)
  assert.equal(pending.state, 'prepared')
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_notifications WHERE id='pending-notice'").get().n), 1)
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM dynamic_archived_notifications WHERE id='pending-notice'").get().n), 0)
})


test('archived receipt headers never replay or paginate as missing full history',async t=>{
 const f=await fixture(t);await f.create('A');const completed=await f.finish('A')
 await f.command('task.archive',{taskId:'A',actorId:'operator'})
 f.mutate(db=>db.prepare('DELETE FROM dynamic_archived_receipts WHERE id=?').run(completed.id))
 await assert.rejects(f.query('receipt.get',{id:completed.id}),{code:'DYNAMIC_ARCHIVE_RECEIPT_MISSING'})
 await assert.rejects(f.command('task.complete',completed.args,completed.id),{code:'DYNAMIC_ARCHIVE_RECEIPT_MISSING'})
 await assert.rejects(f.query('task.decisions',{taskId:'A'}),{code:'DYNAMIC_ARCHIVE_RECEIPT_MISSING'})
})

test('unchanged maintenance does not grow receipts or rewrite the database',async t=>{
 const f=await fixture(t),reader=new DatabaseSync(join(f.root,'tasks.sqlite'),{readOnly:true})
 try{
  const before=reader.prepare('PRAGMA data_version').get().data_version
  const count=reader.prepare('SELECT count(*) n FROM dynamic_receipts').get().n
  for(let n=0;n<25;n++)await f.store.maintain({kind:'coordination.schedule.scan'})
  assert.equal(reader.prepare('SELECT count(*) n FROM dynamic_receipts').get().n,count)
  assert.equal(reader.prepare('PRAGMA data_version').get().data_version,before)
 }finally{reader.close()}
})


test('archive owner and immutable event lookups use the task and sequence indexes',async t=>{
 const f=await fixture(t)
 const plans=f.inspect(db=>({
  receipts:db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM dynamic_receipts WHERE ${receiptOwnerSql}=?`).all('A'),
  events:db.prepare("EXPLAIN QUERY PLAN SELECT id FROM dynamic_archived_task_events WHERE json_extract(body,'$.taskId')=?").all('A'),
  feed:db.prepare('EXPLAIN QUERY PLAN SELECT sequence FROM dynamic_archived_task_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(0,10),
 }))
 assert(plans.receipts.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('dynamic_receipt_owner')))
 assert(plans.events.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('dynamic_archived_task_events_task')))
 assert(plans.feed.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('INTEGER PRIMARY KEY')))
})
