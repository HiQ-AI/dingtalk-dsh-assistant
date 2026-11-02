import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const baseline = process.argv[2]
const moduleUrl = pathToFileURL(resolve('packages/dingtalk-dsh-assistant/dynamic-task-store.js')).href
if (baseline) {
  const source = await readFile(baseline, 'utf8')
  registerHooks({ load(url, context, next) { return url === moduleUrl ? { format: 'module', source, shortCircuit: true } : next(url, context) } })
}
const { openDynamicTaskStore } = await import(moduleUrl)
const root = await mkdtemp(resolve('docs/tmp/plugin-background-blocking/isolated-bench-'))
let store, db
try {
  const dbPath = join(root, 'ledger.sqlite')
  store = await openDynamicTaskStore({ dbPath, instanceId: 'isolated-performance', initialize: true })
  db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  const put = (table, value) => db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(value.id, JSON.stringify(value))
  put('tasks', { id: 'task', taskId: 'task', status: 'completed', drained: true, control: 'active' })
  for (let i = 0; i < 21; i++) put('executions', { id: `e${i}`, executionId: `e${i}`, taskId: 'task', status: i ? 'succeeded' : 'stale', drained: true,
    sessionId: `session-${i}`, sessionBound: true, definition: { executionBackend: 'dsh' }, input: { objective: 'x'.repeat(310000) }, resourceKeys: [] })
  for (let i = 0; i < 1670; i++) put('operations', { id: `o${i}`, operationId: `o${i}`, taskId: 'task', state: i < 3 ? 'unknown' : 'succeeded', result: { proof: 'x'.repeat(4100) } })
  for (let i = 0; i < 270; i++) put('notifications', { id: `n${i}`, state: 'delivered', payload: { text: 'x'.repeat(2400) } })
  for (let i = 0; i < 778; i++) put('sources', { id: `s${i}`, sourceId: `s${i}`, groupId: i % 2 ? 'a' : 'b', routed: true, text: 'x'.repeat(8400) })
  db.exec('COMMIT'); db.close(); db = undefined
  const results = []
  for (let round = 0; round < 3; round++) {
    const parse = JSON.parse; let parsedBytes = 0, parseCalls = 0
    JSON.parse = function (text, ...args) { parsedBytes += Buffer.byteLength(text); parseCalls++; return parse(text, ...args) }
    const start = performance.now(), cpu = process.cpuUsage()
    try {
      const pending = await store.query({ kind: 'recovery.pending' })
      const candidates = []
      for (let scan = 0; scan < 5; scan++) {
        let items = []
        if (baseline) items = await store.query({ kind: 'execution.list' })
        else {
          let after = 0
          do { const page = await store.query({ kind: 'execution.index', after }); items.push(...page.items); after = page.nextAfter } while (after !== null)
        }
        candidates.push(items.filter(e => e.status === 'queued' || e.status === 'running' || e.providerRecovery?.nextReviewAt).map(e => e.executionId))
      }
      const groups = []
      for (const groupId of ['a', 'b']) groups.push((await store.query({ kind: 'source.list', groupId })).map(s => s.sourceId))
      const elapsed = performance.now() - start, used = process.cpuUsage(cpu)
      if (pending.operations.length !== 3 || pending.executions.length || candidates.some(c => c.length) || groups.some(g => g.length !== 389)) throw Error('BACKGROUND_SCAN_SEMANTICS_CHANGED')
      results.push({ round: round + 1, ms: +elapsed.toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2), parsedBytes, parseCalls,
        pendingUnknownOperations: pending.operations.length, executionCandidates: candidates, groupCounts: groups.map(g => g.length) })
    } finally { JSON.parse = parse }
  }
  console.log(JSON.stringify({ version: baseline ? 'baseline' : 'modified', kind: 'isolated-real-store-controlled-data-not-production', results }, null, 2))
} finally { db?.close(); await store?.close(); await rm(root, { recursive: true, force: true }) }
