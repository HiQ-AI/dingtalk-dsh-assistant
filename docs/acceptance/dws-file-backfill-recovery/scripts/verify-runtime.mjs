import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
// 原冲突证据不入库；参数指向本轮只读保存的 conflicts.json，正文只在内存比较。
const conflicts = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.equal(conflicts.length, 1)
const db = new DatabaseSync('D:/dsh_home/workflows/runtime-v2/control.sqlite', { readOnly: true })
let message
try {
  const original = conflicts[0].prior
  const rows = db.prepare('SELECT body,source_version FROM message_runs WHERE source_key=?').all(original.sourceKey)
  assert.equal(rows.length, 1, '文件展示差异不得新增来源版本或重复消息运行')
  const stored = JSON.parse(rows[0].body)
  assert.equal(rows[0].source_version, original.sourceVersion)
  assert.equal(stored.body, original.body, '保留原始正文')
  assert.equal(stored.actorId, original.actorId)
  assert.equal(stored.runId, original.runId)
  message = { sourceVersions: rows.length, sourceVersion: stored.sourceVersion, bodyPreserved: true, actorPreserved: true, runPreserved: true }
} finally { db.close() }
const health = await fetch('http://127.0.0.1:18998/health').then(r => r.json())
assert.equal(health.status, 'ok')
assert.equal(health.recoveryIssueCount, 0)
assert.equal(health.inboundProcessing, true)
const groups = health.dwsBridge.groups.map(g => ({ listener: g.listener.state, backfill: g.backfill.state, error: g.backfill.lastError ?? null }))
for (const group of groups) { assert.equal(group.listener, 'ready'); assert.equal(group.backfill, 'ok'); assert.equal(group.error, null) }
const maintenance = await fetch('http://127.0.0.1:18998/runtime/maintenance').then(r => r.json())
assert.equal(maintenance.active, false)
const anonymousWebStatus = (await fetch('http://127.0.0.1:3080/')).status
assert.equal(anonymousWebStatus, 401)
const result = { checkedAt: new Date().toISOString(), message, health: health.status, recoveryIssueCount: 0,
  inboundProcessing: true, groups, humanReplies: health.dwsBridge.humanReplies.state, maintenanceActive: false, anonymousWebStatus }
await writeFile(process.argv[3], JSON.stringify(result, null, 2), { flag: 'wx' })
console.log(JSON.stringify(result, null, 2))
