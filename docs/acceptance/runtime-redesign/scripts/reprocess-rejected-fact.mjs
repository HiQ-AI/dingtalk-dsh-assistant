import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { digest } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'

const args = process.argv.slice(2)
const mode = args[0]
const value = name => args[args.indexOf(name) + 1]
const dbPath = value('--db'), instanceId = value('--instance'), runId = value('--run')
if (!['--check', '--apply'].includes(mode) || !isAbsolute(dbPath ?? '') || !instanceId || !runId)
  throw new Error('用法: node reprocess-rejected-fact.mjs --check|--apply --db <绝对路径> --instance <实例ID> --run <运行ID>')

function inspect() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
    if (!row) throw new Error('目标运行不存在')
    const run = JSON.parse(row.body)
    const current = db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(run.sourceKey)
    const items = db.prepare('SELECT kind,body FROM message_items WHERE run_id=?').all(runId)
    const commands = items.filter(item => item.kind === 'command').map(item => JSON.parse(item.body))
    const notifications = items.filter(item => item.kind === 'notification').map(item => JSON.parse(item.body))
    const valid = run.status === 'settled' && run.sourceVersion < 5 && current?.current_version === run.sourceVersion
      && commands.length > 0 && commands.every(item => item.kind === 'fact' && item.status === 'rejected')
      && notifications.every(item => item.status === 'prepared')
    return { valid, runId, sourceVersion: run.sourceVersion, commandCount: commands.length,
      preparedNotificationCount: notifications.length, attemptedNotificationCount: notifications.filter(item => item.leaseEpoch > 0).length,
      nextRunId: `msg-replay-${digest([run.sourceKey, run.sourceVersion + 1]).slice(0, 40)}` }
  } finally { db.close() }
}

const check = inspect()
console.log(JSON.stringify({ mode, ...check }))
if (!check.valid || check.attemptedNotificationCount) process.exitCode = 2
else if (mode === '--apply') {
  const store = await openExecutionStore({ dbPath, instanceId })
  try {
    await store.command({ id: `reprocess:${runId}:${check.nextRunId}`, kind: 'message.reprocess', args: { runId, newRunId: check.nextRunId } })
  } finally { await store.close() }
  const after = inspect()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const next = db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(check.nextRunId)
    const old = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId).body)
    const notices = db.prepare("SELECT body FROM message_items WHERE run_id=? AND kind='notification'").all(runId).map(item => JSON.parse(item.body))
    if (!next || old.status !== 'superseded' || !notices.every(item => item.status === 'superseded')) throw new Error('重处理后独立回读未通过')
    console.log(JSON.stringify({ applied: true, previousStatus: old.status, nextRunId: check.nextRunId, nextStatus: JSON.parse(next.body).status,
      supersededNotificationCount: notices.length, currentOldValid: after.valid }))
  } finally { db.close() }
}
