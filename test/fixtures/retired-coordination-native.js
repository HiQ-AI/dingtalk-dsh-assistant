import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { nativeTaskHost, topicTaskCalls } from './task-session-native-host.js'

// Model only the former on-disk records. Seeding happens while the real Host is
// closed; the current startup transaction, native Owner and delivery code run unchanged.
export async function retiredCoordinationHost(t, { name, tasks = [], rows = {}, decide, notifications } = {}) {
  const root = await mkdtemp(join(tmpdir(), name ?? 'retired-coordination-native-'))
  const requests = []
  const model = async request => {
    requests.push(request)
    if (decide) return decide(request)
    return topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: { decision: {
      action: 'wait', summary: '保留当前任务范围，等待明确后续要求', evidence: [], limitations: [],
    } } }]
  }
  const options = { config: { coordination: { enabled: true, provider: 'native-task-test', model: 'former-selection' } }, ...(notifications ? { notifications } : {}) }
  let host = await nativeTaskHost(root, model, options)
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
  for (const task of tasks) {
    if (task.groupId && task.groupId !== 'native-group' && !host.residentStore.getGroup(task.groupId))
      await host.residentStore.subscribe({ groupId: task.groupId, name: '独立群', responsibility: '核对明确交办' })
    await host.service.store.command({ id: 'seed-task:' + task.taskId, kind: 'task.create', args: {
      groupId: 'native-group', ownerActorId: 'native-user', request: '保留原业务目标', ...task,
    } })
  }
  await host.service.recover(); await host.service.whenIdle()
  const beforeTasks = await host.query('task.list')
  await host.close()
  const db = new DatabaseSync(join(root, 'dynamic.db'))
  try {
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    for (const [table, entries] of Object.entries(rows)) {
      if (!['coordination', 'coordination_sources', 'coordination_members', 'coordination_schedules', 'coordination_occurrences', 'coordination_slots', 'coordination_jobs', 'notifications', 'wakes'].includes(table))
        throw new Error('Unexpected legacy test table: ' + table)
      const insert = db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`)
      for (const entry of entries) insert.run(entry.id, JSON.stringify(entry))
    }
  } finally { db.close() }
  host = await nativeTaskHost(root, model, { ...options, initialize: false })
  return { root, beforeTasks, requests,
    get host() { return host },
    async restart() { await host.close(); host = await nativeTaskHost(root, model, { ...options, initialize: false }); return host },
  }
}
