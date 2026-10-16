import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { readTaskLifecycle, projectTaskLifecycle } from '../packages/dingtalk-dsh-assistant/task-execution-timeline.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

const start = Date.parse('2026-10-16T10:00:00Z'), iso = minute => new Date(start + minute * 60000).toISOString()
async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const root = await mkdtemp(join(tmpdir(), 'task-lifecycle-'))
  const config = { dbPath: join(root, 'control.sqlite'), instanceId: 'lifecycle', initialize: true }
  let store = await openDynamicTaskStore(config), counter = 0
  const command = (kind, args, id = `fixture-${++counter}`) => store.command({ id, kind, args })
  const query = q => store.query(q)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  await command('task.create', { taskId: 't', request: '原任务' })
  const at = minute => t.mock.timers.setTime(Date.parse(iso(minute)))
  async function complete(minute) {
    const binding = (await command('task.claim', { taskId: 't', force: true })).result.binding
    at(minute)
    await command('task.complete', { binding, summary: 'PRIVATE_RESULT_NOT_FOR_TIMELINE' }, `complete:t:${binding.requirementRevision}`)
    await command('task.drained', { binding })
  }
  async function reopen(minute, id = `reopen-${minute}`) {
    at(minute)
    const current = await query({ kind: 'task.get', taskId: 't' })
    return command('task.reopen', { taskId: 't', request: '沿原任务继续', expectedRequirementRevision: current.requirementRevision,
      expectedControlRevision: current.controlRevision }, id)
  }
  const read = async (get = id => query({ kind: 'receipt.get', id })) => readTaskLifecycle(
    await query({ kind: 'task.get', taskId: 't' }), await query({ kind: 'wake.list', taskId: 't' }), get)
  return { root, get store() { return store }, command, query, at, complete, reopen, read, async restart() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }) } }
}

test('multiple completions/reopens retain real intervals and idle gaps through immutable receipts and restart', async t => {
  const f = await fixture(t)
  await f.complete(10); await f.reopen(15, 'open-second')
  await f.complete(25); await f.reopen(30, 'open-third')
  const before = await f.query({ kind: 'task.get', taskId: 't' })
  assert.equal(before.completion, null)
  const life = await f.read()
  assert.equal(life.complete, true)
  assert.deepEqual(life.segments.map(({ startedAt, endedAt, active, label }) => ({ startedAt, endedAt, active, label })), [
    { startedAt: iso(0), endedAt: iso(10), active: false, label: '已完成' },
    { startedAt: iso(15), endedAt: iso(25), active: false, label: '重开后完成' },
    { startedAt: iso(30), endedAt: null, active: true, label: '重开后处理中' },
  ])
  assert.deepEqual(life.events.map(event => event.kind), ['created', 'completed', 'reopened', 'completed', 'reopened'])
  assert.equal(JSON.stringify(life).includes('PRIVATE_RESULT'), false)
  assert.deepEqual(await f.query({ kind: 'task.get', taskId: 't' }), before, 'read projection never writes or schedules the task')
  await f.restart()
  assert.deepEqual(await f.read(), life)
})

test('completed task stays fixed; revision changes do not confuse run sequence or exact completion receipt', async t => {
  const f = await fixture(t)
  await f.command('task.revise', { taskId: 't', request: '新增要求' })
  await f.complete(10)
  await f.reopen(15)
  await f.complete(20)
  const task = await f.query({ kind: 'task.get', taskId: 't' })
  assert.equal(task.runSequence, 2); assert.equal(task.requirementRevision, 3)
  const life = await f.read()
  assert.equal(life.complete, true)
  assert.equal(life.active, false)
  assert.deepEqual(life.segments.map(segment => [segment.startedAt, segment.endedAt]), [[iso(0), iso(10)], [iso(15), iso(20)]])
  assert.equal(life.segments[1].label, '重开后完成')
  f.at(60)
  assert.deepEqual(await f.read(), life)
})

test('missing or foreign completion receipt does not invent a historical endpoint', async t => {
  const f = await fixture(t)
  await f.complete(10); await f.reopen(15)
  for (const replacement of [null, { result: { task: { taskId: 'other', status: 'completed', runSequence: 1, requirementRevision: 1,
    completion: { at: iso(10), requirementRevision: 1 } } } }]) {
    const life = await f.read(id => id === 'complete:t:1' ? replacement : f.query({ kind: 'receipt.get', id }))
    assert.equal(life.complete, false)
    assert.equal(life.segments.length, 1)
    assert.equal(life.segments[0].startedAt, iso(15))
    assert.equal(life.events.some(event => event.kind === 'completed'), false)
  }
  const missingOpen = await f.read(id => id.startsWith('reopen-') ? null : f.query({ kind: 'receipt.get', id }))
  assert.equal(missingOpen.complete, false)
  assert.equal(missingOpen.segments.length, 0)
})

test('duplicate replay never adds lifecycle segments and backward reopen time never paints overlapping periods', async t => {
  const f = await fixture(t)
  await f.complete(10)
  const args = { taskId: 't', request: '继续', expectedRequirementRevision: 1, expectedControlRevision: 1 }
  f.at(15)
  await f.command('task.reopen', args, 'exact-open')
  await f.command('task.reopen', args, 'exact-open')
  assert.equal((await f.read()).segments.length, 2)
  const task = await f.query({ kind: 'task.get', taskId: 't' })
  const backwards = projectTaskLifecycle(task, [{ sequence: 2, at: iso(8), completedAt: iso(10) }])
  assert.equal(backwards.complete, false)
  assert.equal(backwards.segments.length, 1)
  assert.equal(backwards.segments[0].endedAt, iso(10))
})

test('missing reopen history or terminal time remains incomplete; known cancellation uses its own true timestamp', async t => {
  const f = await fixture(t)
  await f.complete(10); await f.reopen(15)
  const task = await f.query({ kind: 'task.get', taskId: 't' })
  assert.equal(projectTaskLifecycle(task).segments.length, 0)
  const missing = projectTaskLifecycle({ ...task, status: 'completed', completion: null }, [{ sequence: 2, at: iso(15), completedAt: iso(10) }])
  assert.equal(missing.complete, false)
  assert.equal(missing.segments.length, 1)
  f.at(20)
  await f.command('task.control', { taskId: 't', control: 'cancelled' })
  const cancelled = await f.read()
  assert.equal(cancelled.complete, true)
  assert.equal(cancelled.segments[1].status, 'cancelled')
  assert.equal(cancelled.segments[1].endedAt, iso(20))
})

test('real detail HTTP reads multiple lifecycle intervals without creating jobs, logs or new state', async t => {
  const f = await fixture(t)
  await f.complete(10); await f.reopen(15); await f.complete(20)
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'lifecycle-http' })
  const residentStore = await openResidentStore(facility), noop = async () => {}
  const legacy = { getAgentConfig: () => ({ workspaceDir: f.root }), getGroup: () => undefined }
  let dispatches = 0
  const sessions = { close: noop, cancel: noop, run: async () => { dispatches++; throw new Error('read must not dispatch') } }
  const service = await openTaskSessionService({ ctx: {}, legacy, residentStore, store: f.store,
    config: { dbPath: f.store.info.dbPath, instanceId: 'lifecycle', workspaceDir: f.root },
    persistence: { close: noop, register: noop }, taskSessions: sessions, executionSessions: sessions, groupSessions: sessions })
  const runtime = { ...legacy, getTaskSessionDetail: id => service.taskDetail(id) }
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => { res.writeHead(500); res.end(error.message) }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/state/tasks/t/detail`
  try {
    const before = await f.query({ kind: 'task.get', taskId: 't' })
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const detail = await response.json()
    assert.equal(detail.timeline.task.complete, true)
    assert.equal(detail.timeline.task.segments.length, 2)
    assert.equal(detail.timeline.task.segments[1].endedAt, iso(20))
    assert.equal(JSON.stringify(detail.timeline).includes('PRIVATE_RESULT'), false)
    assert.deepEqual(await f.query({ kind: 'task.get', taskId: 't' }), before)
    await f.reopen(25)
    const current = await (await fetch(url)).json()
    assert.equal(current.timeline.task.segments.length, 3)
    assert.equal(current.timeline.task.segments[2].startedAt, iso(25))
    assert.equal(current.timeline.task.segments[2].active, true)
    assert.equal(current.timeline.task.events.filter(event => event.kind === 'reopened').length, 2)
    assert.equal(dispatches, 0)
  } finally { await new Promise(resolve => server.close(resolve)); await service.close(); await residentStore.close() }
})
