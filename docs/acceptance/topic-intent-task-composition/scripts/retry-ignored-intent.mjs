import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'

const [mode, dbPath, instanceId, runId] = process.argv.slice(2)
if (!['--check', '--execute'].includes(mode) || !isAbsolute(dbPath ?? '') || !instanceId || !runId)
  throw new Error('USAGE: --check|--execute <absolute-db> <instance-id> <run-id>')

function inspect() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (db.prepare('SELECT instance_id FROM execution_meta').get()?.instance_id !== instanceId) throw new Error('INSTANCE_MISMATCH')
    const row = db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
    if (!row) throw new Error('RUN_NOT_FOUND')
    const run = JSON.parse(row.body)
    const current = db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(run.sourceKey)
    if (current?.current_version !== run.sourceVersion || !['settled', 'waiting'].includes(run.status)) throw new Error('SOURCE_NOT_CURRENT')
    const items = db.prepare('SELECT kind,body FROM message_items WHERE run_id=?').all(runId).map(row => ({ ...JSON.parse(row.body), tableKind: row.kind }))
    const units = items.filter(item => item.tableKind === 'unit')
    if (units.length !== 1 || !['ignored', 'pending'].includes(units[0].status) || !units[0].topicId
      || items.some(item => item.tableKind === 'command' || item.tableKind === 'notification')) throw new Error('EFFECT_MAY_EXIST')
    const topic = JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(units[0].topicId)?.body ?? 'null')
    if (!topic || topic.processedRevision > topic.inputRevision) throw new Error('TOPIC_REVISION_INVALID')
    return { run, unit: units[0], topic }
  } finally { db.close() }
}

const prior = inspect()
console.log(JSON.stringify({ mode, runId, unitId: prior.unit.id, topicId: prior.topic.topicId,
  sourceVersion: prior.run.sourceVersion, topicInputRevision: prior.topic.inputRevision, writes: mode === '--check' ? 0 : 1 }))
if (mode === '--execute') {
  const store = await openExecutionStore({ dbPath, instanceId })
  try {
    await store.command({ id: `retry-ignored-intent:${runId}:${prior.topic.inputRevision}`, kind: 'message.topic.intent.retry',
      args: { runId, unitId: prior.unit.id, expectedRevision: prior.run.revision } })
  } finally { await store.close() }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const topic = JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(prior.topic.topicId).body)
    const unit = JSON.parse(db.prepare("SELECT body FROM message_items WHERE item_id=? AND kind='unit'").get(`unit:${prior.unit.id}`).body)
    console.log(JSON.stringify({ mode: 'readback', runId, topicInputRevision: topic.inputRevision, unitStatus: unit.status }))
  } finally { db.close() }
}
