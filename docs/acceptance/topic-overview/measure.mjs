// Synthetic query comparison only. No service, credentials or production data.
// node docs/acceptance/topic-overview/measure.mjs > /tmp/topic-query-measurement.json
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { installObserverPagination, observerPage } from '../../../packages/dingtalk-dsh-assistant/observer-pagination.js'

const dir = await mkdtemp(join(tmpdir(), 'topic-query-')), path = join(dir, 'synthetic.sqlite')
let db = new DatabaseSync(path)
for (const table of ['tasks', 'executions', 'wakes', 'coordination_sources', 'sources', 'notifications', 'coordination'])
  db.exec(`CREATE TABLE dynamic_${table}(id TEXT PRIMARY KEY,body TEXT)`)
for (const table of ['tasks', 'executions', 'wakes', 'notifications', 'receipts'])
  db.exec(`CREATE TABLE dynamic_archived_${table}(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT)`)
installObserverPagination(db, { migrate: true })
const hidden = 'synthetic-history-'.repeat(4000), insert = db.prepare('INSERT INTO dynamic_tasks VALUES (?,?)')
for (let i = 0; i < 120; i++) {
  const taskId = 'task-' + String(i).padStart(3, '0')
  insert.run(taskId, JSON.stringify({ taskId, groupId: 'test', title: '合成任务 ' + i, status: 'active', control: 'active', drained: true,
    updatedAt: '2026-10-30T00:00:00Z', topicRefs: [{ topicId: 'topic' }], ...(i % 2 ? { archivedAt: '2026-10-30' } : {}),
    objective: hidden, request: hidden, completion: { result: { summary: hidden } }, dialogue: [{ text: hidden }] }))
}
db.exec("INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks WHERE json_extract(body,'$.archivedAt') IS NOT NULL; DELETE FROM dynamic_tasks WHERE json_extract(body,'$.archivedAt') IS NOT NULL;")
db.close()
function reader(database) {
  const stats = { statements: 0, bodyBytes: 0, bodyRows: 0 }
  const observed = { prepare(sql) {
    const statement = database.prepare(sql)
    return {
      get(...args) { stats.statements++; return statement.get(...args) },
      all(...args) {
        stats.statements++; const rows = statement.all(...args)
        if (sql.includes(' AS body')) { stats.bodyRows += rows.length; stats.bodyBytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.body ?? ''), 0) }
        return rows
      },
    }
  } }
  return summary => {
    Object.assign(stats, { statements: 0, bodyBytes: 0, bodyRows: 0 })
    const start = performance.now()
    const page = observerPage(observed, { collection: 'tasks', groupId: 'test', topicId: 'topic', archived: 'all', offset: 50, limit: 10, summary }, 'synthetic')
    const queryMs = performance.now() - start, serializeStart = performance.now(), json = JSON.stringify(page)
    return { queryMs, serializeMs: performance.now() - serializeStart, responseBytes: Buffer.byteLength(json), ...stats }
  }
}
const samples = { firstConnection: { before: [], after: [] }, repeated: { before: [], after: [] } }
for (let i = 0; i < 8; i++) for (const mode of i % 2 ? ['after', 'before'] : ['before', 'after']) {
  db = new DatabaseSync(path)
  samples.firstConnection[mode].push(reader(db)(mode === 'after'))
  db.close()
}
db = new DatabaseSync(path); const read = reader(db)
read(false); read(true) // explicit warm-up, reported separately from samples
for (let i = 0; i < 40; i++) for (const mode of i % 2 ? ['after', 'before'] : ['before', 'after'])
  samples.repeated[mode].push(read(mode === 'after'))
db.close()
const summarize = rows => Object.fromEntries(Object.keys(rows[0]).map(key => {
  const values = rows.map(row => row[key]).sort((a, b) => a - b)
  return [key, { min: values[0], median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) }]
}))
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, taskCount: 120, live: 60, archived: 60, pageSize: 10, offset: 50 },
  method: 'Same synthetic SQLite database; alternate full task page and summary page. Eight fresh connections per variant (OS cache not flushed), then two warm-ups and forty alternating reads per variant. Query includes SQL/projection/JSON.parse; response stringify measured separately. No network/model/render timing or production latency claim.',
  summary: Object.fromEntries(Object.entries(samples).map(([kind, variants]) => [kind, Object.fromEntries(Object.entries(variants).map(([mode, rows]) => [mode, summarize(rows)]))])), samples }, null, 2))
await rm(dir, { recursive: true })
