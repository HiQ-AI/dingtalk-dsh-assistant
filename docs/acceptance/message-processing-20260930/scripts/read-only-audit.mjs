// 只读现场审计：原库仅使用 SQLite readOnly；通知探针使用内存替身，不发送消息。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { splitContext, messageSchemas, validateExecutionMaterialRefs } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'
import { prepareMessageRequest } from '../../../../packages/dingtalk-dsh-assistant/message-model.js'
import { createWorkflowNotifications } from '../../../../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import { isDirectedTaskRequest } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

const [dbPath, installedDirectory, outputPath] = process.argv.slice(2)
if (!dbPath || !installedDirectory || !outputPath) throw new Error('需要参数：控制库、已安装包目录、输出文件')
const db = new DatabaseSync(dbPath, { readOnly: true })
const runRows = db.prepare('SELECT rowid AS seq, body FROM message_runs').all()
  .map(row => ({ seq: row.seq, ...JSON.parse(row.body) }))
const messages = runRows.filter(run => run.seq >= 109 && run.seq <= 115)
assert.equal(messages.length, 7)
const items = run => db.prepare('SELECT kind, body FROM message_items WHERE run_id=?').all(run.runId)
  .map(row => ({ itemKind: row.kind, ...JSON.parse(row.body) }))
const numbered = number => messages.find(run => run.seq === number)
const byteEvidence = [114, 115].map(number => {
  const run = numbered(number), input = splitContext(run.snapshot), prepared = prepareMessageRequest('S', input)
  assert.equal(run.reason, `MESSAGE_CONTEXT_CAPACITY:S:$:${prepared.inputBytes}/8000`)
  assert.equal(items(run).length, 0)
  return { seq: number, sourceChars: run.body.length, systemBytes: Buffer.byteLength(prepared.system),
    totalBytes: prepared.inputBytes, limit: run.policy.nodeInputByteLimits.S, retryVersion: run.capacityRetryVersion,
    fields: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])) }
})
const requestRun = numbered(113), requestItems = items(requestRun)
const relation = requestItems.find(item => item.itemKind === 'node' && item.nodeId === 'R')
const request = requestItems.find(item => item.itemKind === 'request')
const invalidReferenceAccepted = messageSchemas.R.safeParse(relation.output.output).success
assert.equal(invalidReferenceAccepted, true)
assert.equal(JSON.stringify(relation.input).includes(request.needs[0].resourceRef), false)
assert.doesNotThrow(() => validateExecutionMaterialRefs('R', relation.output.output, relation.input))
const unsupportedRef = { requestId: request.id, status: request.status, kind: request.kind,
  resourceRef: request.needs[0].resourceRef, existsInModelInput: false, acceptedBySchemaAndReferenceValidator: true,
  omittedCandidates: relation.input.omittedCandidateCount }
const query = numbered(111), queryItems = items(query)
const queryTopic = JSON.parse(db.prepare('SELECT body FROM message_topics WHERE topic_id=?')
  .get(queryItems.find(item => item.itemKind === 'unit').topicId).body)
const queryRouting = queryItems.filter(item => item.itemKind === 'node').map(item => ({ node: item.nodeId,
  status: item.status, page: item.input.candidatePage, omitted: item.input.omittedCandidateCount,
  candidates: item.input.candidates?.length, disposition: item.output?.output?.disposition,
  startedAt: item.startedAt, completedAt: item.completedAt }))
assert.equal(queryRouting.filter(item => item.node === 'R').length, 8)
assert.equal(queryRouting.filter(item => ['I', 'IB'].includes(item.node)).length, 0)
const futureFile = numbered(109)
assert.equal(query.snapshot.history.some(item => item.sourceKey === futureFile.sourceKey), true)
assert.equal(futureFile.context.occurredAt >= query.context.occurredAt, false)
assert.ok(futureFile.context.occurredAt > Date.parse(query.context.occurredAt.replace(' ', 'T') + '+08:00'))
const chronology = { querySourceTime: query.context.occurredAt, laterFileSourceTime: futureFile.context.occurredAt,
  rawComparisonExcludesLaterFile: false, normalizedComparisonExcludesLaterFile: true,
  laterFileIsPresentInEarlierSnapshot: true }
const quietRun = numbered(112), quietNodes = items(quietRun).filter(item => item.itemKind === 'node')
assert.equal(quietNodes[0].output.output.kind, 'no_action')
assert.ok(quietRun.context.compactPolicy.includes('必须回复'))
assert.equal(Object.hasOwn(quietNodes[0].input, 'policy'), false)
const pendingRouting = db.prepare(`SELECT r.rowid seq FROM message_runs r JOIN message_sources s
  ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
  WHERE json_extract(r.body,'$.conversationId')=? AND json_extract(r.body,'$.status') NOT IN ('buffered','alias','superseded')
  AND NOT (json_extract(r.body,'$.status')='settled' AND (json_extract(r.body,'$.reason')='message_quiet'
    OR (json_extract(r.body,'$.routingStatus')='routing_complete' AND json_extract(r.body,'$.intentStatus')='processed')))
  AND (NOT EXISTS (SELECT 1 FROM message_items i WHERE i.run_id=r.run_id AND i.kind='unit')
    OR EXISTS (SELECT 1 FROM message_items i LEFT JOIN message_topic_bindings b ON b.unit_id=json_extract(i.body,'$.id')
      WHERE i.run_id=r.run_id AND i.kind='unit' AND json_extract(i.body,'$.status')!='superseded' AND b.unit_id IS NULL))
  ORDER BY r.rowid`).all(query.conversationId).map(row => row.seq)
const taskCountToday = db.prepare("SELECT count(*) AS n FROM business_tasks WHERE created_at >= '2026-09-29T16:00:00Z'").get().n
const messageEvidence = messages.map(run => {
  const records = items(run)
  return { seq: run.seq, runId: run.runId, messageId: run.context.sourceMessageId,
    occurredAt: run.context.occurredAt, receivedAt: run.createdAt, status: run.status, routingStatus: run.routingStatus,
    intentStatus: run.intentStatus, reason: run.reason,
    counts: Object.fromEntries(['node', 'unit', 'command', 'notification', 'request'].map(kind =>
      [kind, records.filter(item => item.itemKind === kind).length])) }
})
db.close()

// 运行真实通知函数，store.command 只把准备动作写入内存数组。
async function notificationProbe({ requests = [], commands = [], status = 'waiting' } = {}) {
  const writes = [], reportReads = []
  const run = { runId: 'probe', sourceKey: 'probe-source', conversationId: 'probe-group', actorId: 'probe-user', status,
    context: { sourceMessageId: 'probe-message' } }
  const store = { async query(query) {
    if (query.kind === 'message.list') return [run]
    if (query.kind === 'message.run') return { run, requests, commands }
    if (query.kind === 'message.notification') return null
    if (query.kind === 'task.owner.reports') { reportReads.push(query); return [] }
    throw new Error(`非预期查询 ${query.kind}`)
  }, async command(command) { writes.push(command); return { result: {} } } }
  await createWorkflowNotifications({ store, controller: {}, artifacts: {} }).flush()
  return { prepared: writes.length, ownerReportReads: reportReads.length }
}
const notificationEvidence = {
  internalWait: await notificationProbe({ requests: [{ id: 'request', status: 'pending', kind: 'needs_context', reason: 'internal resource unavailable' }] }),
  systemFailure: await notificationProbe({ status: 'needs_attention' }),
  humanClarification: await notificationProbe({ requests: [{ id: 'request', revision: 0, status: 'pending', kind: 'needs_clarification', question: '必要信息' }] }),
  acceptedTaskWithNone: await notificationProbe({ commands: [{ commandId: 'task-command', kind: 'create', status: 'applied', args: { replyPolicy: 'none' }, result: { taskId: 'task', reply: '已承接' } }] }),
}
assert.equal(notificationEvidence.internalWait.prepared, 0)
assert.equal(notificationEvidence.systemFailure.prepared, 0)
assert.equal(notificationEvidence.humanClarification.prepared, 1)
assert.equal(notificationEvidence.acceptedTaskWithNone.prepared, 0)
assert.equal(notificationEvidence.acceptedTaskWithNone.ownerReportReads, 0)
const sourceDirectory = fileURLToPath(new URL('../../../../packages/dingtalk-dsh-assistant/', import.meta.url))
const codeHashes = []
for (const file of ['message-workflow.js', 'message-context.js', 'message-model.js', 'message-ledger.js', 'workflow-service.js', 'workflow-notifications.js', 'dws-bridge.js']) {
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  const source = await hash(`${sourceDirectory}/${file}`), installed = await hash(`${installedDirectory}/${file}`)
  codeHashes.push({ file, source, installed, equal: source === installed })
}
const evidence = { checkedAt: new Date().toISOString(), mode: 'read-only-db-and-memory-only-probes', codeHashes,
  messages: messageEvidence,
  byteEvidence, unsupportedRef, queryRouting, queryTopic, pendingRouting, chronology, taskCountToday,
  notificationEvidence, namedRequestRecognition: [111, 114, 115].map(seq => ({ seq,
    recognized: isDirectedTaskRequest(numbered(seq).body, ['小小鹏', '孙鹏']) })),
  fileResourcesPersisted: [109, 110].map(seq => ({ seq, attachmentCount: numbered(seq).context.attachments.length })),
  greeting: { seq: 112, result: quietNodes[0].output.output, groupRequiresReply: true, groupRuleInSplitInput: false } }
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ outputPath, messageCount: messages.length, assertions: 'passed', pendingRouting,
  byteEvidence: byteEvidence.map(({ seq, totalBytes, limit }) => ({ seq, totalBytes, limit })),
  notificationEvidence, taskCountToday, installedMatchesMain: codeHashes.every(item => item.equal) }, null, 2))
