import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const [mode, dbPath, artifactDirectory, evidenceDirectory, instanceId] = process.argv.slice(2)
if (!['--check', '--execute'].includes(mode) || [dbPath, artifactDirectory, evidenceDirectory].some(path => !isAbsolute(path ?? '')) || !instanceId)
  throw new Error('USAGE: --check|--execute <absolute-control-db> <absolute-artifacts> <absolute-evidence-dir> <instance-id>')

const conversationId = 'cidq+PGRQW098/2Qh23wrl/ZQ=='
const originals = [
  { id: 'notice-74edac65d11ef0dec18a9846246b8efbd61a7e627386a659f9d0949692116b80', messageId: 'msgmlswzA6Jq31KfnMfJ60aCg==', sourceMessageId: 'msg2DFvyVcXDxIxeGxOi7+hag==' },
  { id: 'notice-acfaf262e183a225ed839d3ea44ef6f9477d4d29b0587075ad90ce0fa30a74ab', messageId: 'msgCn2ppuRX3TSjKkqVPJV26w==', sourceMessageId: 'msg2DFvyVcXDxIxeGxOi7+hag==' },
  { id: 'clarify-111e94b5dbdaafd3c7ff6b65ebefa4a5bdfd91087ee74abefcc3849de8478123', messageId: 'msg/am9Fu4tFMNnkeLjwKLzGA==', sourceMessageId: 'msg7mPEpufwzaJzQWRuGvAWnA==' },
  { id: 'notice-6d25b000b5c82bbc5c4ede091005fcc759d076cbe9e048a571696ca19e815feb', messageId: 'msgMNSYQ4OEjOE1fQ2n4dU3MQ==', sourceMessageId: 'msg7mPEpufwzaJzQWRuGvAWnA==' },
]
const replacements = [
  { id: 'replacement:task-acceptance:20260924', originalId: originals[0].id, messageId: 'msg7qepi5PrVeEHeCMQrqtwtQ==', sourceMessageId: originals[0].sourceMessageId },
  { id: 'replacement:task-result:20260924', originalId: originals[1].id, messageId: 'msgrTakdh3z4T2VDosDoxe/6w==', sourceMessageId: originals[1].sourceMessageId },
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const [detailsBytes, currentBytes] = await Promise.all(['message-details.json', 'conversation-current.json'].map(name => readFile(join(evidenceDirectory, name))))
const details = JSON.parse(detailsBytes), current = JSON.parse(currentBytes)
if (details.complete !== true || details.failedCount !== 0 || details.foundCount !== 6 || details.hasMore === true
  || current.complete !== true || current.hasMore === true || current.failures?.length) throw new Error('DWS_EVIDENCE_INCOMPLETE')
const observed = new Map(details.messages.map(message => [message.messageId, message]))
const visible = new Set(current.messages.map(message => message.messageId))
if (observed.size !== 6) throw new Error('DWS_EVIDENCE_DUPLICATE')
for (const entry of originals) {
  const message = observed.get(entry.messageId)
  if (!message || message.conversationId !== conversationId || message.quotedMessage?.messageId !== entry.sourceMessageId || visible.has(entry.messageId))
    throw new Error(`ORIGINAL_EVIDENCE_MISMATCH:${entry.id}`)
}
for (const entry of replacements) {
  const message = observed.get(entry.messageId)
  if (!message || message.conversationId !== conversationId || message.quotedMessage?.messageId !== entry.sourceMessageId || !visible.has(entry.messageId))
    throw new Error(`REPLACEMENT_EVIDENCE_MISMATCH:${entry.id}`)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
let notices
try {
  if (db.prepare('SELECT instance_id FROM execution_meta').get()?.instance_id !== instanceId) throw new Error('INSTANCE_MISMATCH')
  notices = originals.map(entry => {
    const row = db.prepare('SELECT body FROM message_items WHERE item_id=? AND kind=?').get(`notification:${entry.id}`, 'notification')
    if (!row) throw new Error(`NOTICE_NOT_FOUND:${entry.id}`)
    const notice = JSON.parse(row.body)
    if (!['delivered', 'acknowledged'].includes(notice.status) || notice.payload?.conversationId !== conversationId
      || notice.payload?.sourceMessageId !== entry.sourceMessageId || (notice.evidence?.messageId && notice.evidence.messageId !== entry.messageId))
      throw new Error(`NOTICE_STATE_MISMATCH:${entry.id}`)
    if (notice.status === 'acknowledged' && (!notice.ack?.result?.openTaskId || !Number.isInteger(notice.leaseEpoch)))
      throw new Error(`NOTICE_ACK_MISSING:${entry.id}`)
    return notice
  })
} finally { db.close() }

console.log(JSON.stringify({ mode, dbPath, originalCount: originals.length, replacementCount: replacements.length,
  originalStatuses: notices.map(notice => ({ id: notice.id, status: notice.status, recalled: notice.recallStatus === 'recalled' })),
  evidenceDigests: { details: hash(detailsBytes), current: hash(currentBytes) },
  externalCalls: 0, ledgerWrites: mode === '--check' ? 0 : 7 }))
if (mode !== '--execute') process.exit(0)

const artifacts = await openExecutionArtifacts({ directory: artifactDirectory })
const evidence = await artifacts.put({ kind: 'notification-recovery-reconciliation', conversationId,
  detailsSha256: hash(detailsBytes), currentSha256: hash(currentBytes),
  observedMessages: [...observed.values()].map(({ messageId, conversationId, createTime, quotedMessage, text }) =>
    ({ messageId, conversationId, createTime, quotedMessageId: quotedMessage?.messageId, text })),
  currentlyVisible: [...visible].filter(id => observed.has(id)),
  priorRecallResult: '四条撤回请求此前逐条返回 recallStatus=SUCCESS；本次仅登记已发生事实，不再次调用撤回。',
})
const store = await openExecutionStore({ dbPath, instanceId })
try {
  const acknowledged = notices.find(notice => notice.status === 'acknowledged')
  if (acknowledged) {
    const entry = originals.find(item => item.id === acknowledged.id)
    await store.command({ id: `recovery-readback:${entry.id}`, kind: 'message.notification.readback', args: {
      notificationId: entry.id, leaseEpoch: acknowledged.leaseEpoch,
      evidence: { messageId: entry.messageId, conversationId, observedAt: new Date().toISOString(), evidenceRef: evidence.ref },
    } })
  }
  for (const entry of originals) await store.command({ id: `recovery-recall:${entry.id}`, kind: 'message.notification.recall.record', args: {
    notificationId: entry.id, messageId: entry.messageId, recallStatus: 'SUCCESS', evidenceRef: evidence.ref,
  } })
  for (const entry of replacements) await store.command({ id: `recovery-replacement:${entry.id}`, kind: 'message.notification.replacement.record', args: {
    notificationId: entry.originalId, replacementId: entry.id, messageId: entry.messageId,
    body: observed.get(entry.messageId).text, conversationId, sourceMessageId: entry.sourceMessageId, evidenceRef: evidence.ref,
  } })
} finally { await store.close() }
const verify = new DatabaseSync(dbPath, { readOnly: true })
try {
  const recalled = originals.map(entry => JSON.parse(verify.prepare('SELECT body FROM message_items WHERE item_id=?').get(`notification:${entry.id}`).body))
  const replaced = replacements.map(entry => JSON.parse(verify.prepare('SELECT body FROM message_items WHERE item_id=?').get(`notification-replacement:${entry.id}`).body))
  if (!recalled.every(item => item.recallStatus === 'recalled') || replaced.some((item, index) => item.messageId !== replacements[index].messageId))
    throw new Error('RECONCILIATION_READBACK_FAILED')
  console.log(JSON.stringify({ mode: 'readback', recalled: recalled.length, replaced: replaced.length, evidenceRef: evidence.ref }))
} finally { verify.close() }
