import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'

const dbPath = 'D:/dsh_home/workflows/runtime-v2/control.sqlite'
const groupId = 'cidq+PGRQW098/2Qh23wrl/ZQ=='
const plan = [
  { runId: 'msg-replay-273afb529d756a6cddd2a9cf8a2cfe435371e1e4', topicId: 'topic-review-issues-20260924', title: '审核问题进度与关联任务' },
  { runId: 'msg-replay-f84b15fe977c139d7634c1f3bd47858e467ca502', topicId: 'topic-review-issues-20260924', title: '审核问题进度与关联任务' },
  { runId: 'msg-replay-5a9f4b1669951cbcf057f252e7b1340ba24ed5f7', topicId: 'topic-dataset-normalization-20260924', title: '数据集合并归一化计算回归' },
]
const mode = process.argv[2]
if (!['--check', '--apply'].includes(mode)) throw new Error('usage: node backfill-topics.mjs --check|--apply')

function inspect(db, item) {
  const row = db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(item.runId)
  if (!row) throw new Error(`run_not_found:${item.runId}`)
  const run = JSON.parse(row.body)
  if (run.conversationId !== groupId || !['settled', 'waiting'].includes(run.status)) throw new Error(`run_not_safe:${item.runId}`)
  const commands = db.prepare("SELECT count(*) AS n FROM message_items WHERE run_id=? AND kind='command'").get(item.runId).n
  if (commands) throw new Error(`run_has_commands:${item.runId}`)
  const units = db.prepare("SELECT body FROM message_items WHERE run_id=? AND kind='unit' ORDER BY rowid").all(item.runId).map(row => JSON.parse(row.body))
  if (units.length !== 1 || !['pending', 'ignored'].includes(units[0].status)) throw new Error(`unit_not_safe:${item.runId}`)
  const unit = units[0]
  const bound = db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(unit.id)
  if (bound && bound.topic_id !== item.topicId) throw new Error(`topic_conflict:${item.runId}`)
  const text = unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n')
  if (!text.trim() || !run.body.includes(text)) throw new Error(`source_invalid:${item.runId}`)
  return { run, unit, text, alreadyBound: !!bound }
}

const reader = new DatabaseSync(dbPath, { readOnly: true })
const instanceId = reader.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id
if (!instanceId) throw new Error('store_instance_missing')
const checked = plan.map(item => ({ ...item, ...inspect(reader, item) }))
reader.close()
console.log(JSON.stringify({ mode, checked: checked.map(({ runId, topicId, alreadyBound }) => ({ runId, topicId, alreadyBound })) }))
if (mode === '--check') process.exit(0)

const store = await openExecutionStore({ dbPath, instanceId })
try {
  for (const item of checked) {
    if (item.alreadyBound) continue
    const topic = await store.query({ kind: 'message.topic', topicId: item.topicId })
    const args = { topicId: item.topicId, conversationId: groupId, sourceRunId: item.runId, unitId: item.unit.id,
      title: item.title, ...(topic ? { expectedRevision: topic.revision } : {}),
      facts: [{ kind: 'fact', text: item.text, sourceRefs: [{ sourceKey: item.run.sourceKey, sourceVersion: item.run.sourceVersion, text: item.text }] }] }
    await store.command({ id: `topic-backfill:${item.runId}`, kind: 'message.topic.upsert', args })
  }
} finally { await store.close() }
