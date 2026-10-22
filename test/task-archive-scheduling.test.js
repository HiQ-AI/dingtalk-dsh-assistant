import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

test('topic coordination list selection omits archived tasks while direct historical reads stay available', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/task-topic-coordinator.js', import.meta.url), 'utf8')
  const start = source.indexOf('  store = new Proxy('), end = source.indexOf('\n  let closed', start)
  assert.ok(start >= 0 && end > start, '读取完整的多行存储代理，而非仅首行')
  const rows = [{ taskId: 'old', archivedAt: 'now' }, { taskId: 'current' }]
  const selected = runInNewContext(`(()=>{let store=input;${source.slice(start, end)};return store})()`, { input: { listTasks: () => rows, getTask: id => rows.find(row => row.taskId === id) } })
  assert.deepEqual(selected.listTasks().map(task => task.taskId), ['current'])
  assert.equal(selected.getTask('old').archivedAt, 'now')
})

test('background recovery and pending wakes never run archived tasks, normal continuation still runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'archive-scheduling-'))
  let service, sequence = 0
  const turns = [], noop = async () => {}
  const open = initialize => openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } },
    config: { dbPath: join(root, 'fixture.sqlite'), instanceId: 'archive-schedule-fixture', initialize, workspaceDir: root, webActorId: 'owner' },
    residentStore: { listGroups: () => [], listTopics: () => [], getGroup: () => undefined }, legacy: { getGroup: () => undefined, getAgentConfig: () => ({ workspaceDir: root }) },
    persistence: { register: noop, close: noop },
    taskSessions: { close: noop, cancel: noop, run: async ({ binding, submit }) => { turns.push(binding.taskId); await submit({ action: 'complete', summary: 'Fixture completed', evidence: [], limitations: [] }) } }, executionSessions: { close: noop, cancel: noop, run: async () => { throw new Error('No fixture execution should run') } } })
  service = await open(true)
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args) => service.store.command({ id: `fixture-${++sequence}`, kind, args })
  for (const taskId of ['archived', 'normal']) {
    await command('task.create', { taskId, request: 'fixture-only' })
    const { binding } = (await command('task.claim', { taskId })).result
    await command('task.complete', { binding, summary: 'Done' }); await command('task.drained', { binding })
  }
  await service.archiveTask({ taskId: 'archived' })
  await command('wake.enqueue', { taskId: 'archived', kind: 'late-new-message' })
  await assert.rejects(command('task.reopen', { taskId: 'archived', request: 'late source' }), { code: 'DYNAMIC_TASK_ARCHIVED_CONFLICT' })
  await command('task.reopen', { taskId: 'normal', request: 'normal follow-up' })
  await service.recover(); await service.whenIdle()
  assert.deepEqual(turns, ['normal'])
  const archived = await service.taskDetail('archived')
  assert.equal(archived.status, 'completed'); assert.equal(archived.drained, true); assert.ok(archived.archivedAt)
  await service.close(); service = await open(false)
  await service.recover(); await service.whenIdle()
  assert.deepEqual(turns, ['normal']); assert.equal((await service.taskDetail('archived')).archivedAt, archived.archivedAt)
})
