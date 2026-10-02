import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createDwsAdapter, normalizeApprovalNoticeText } from '../../../../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { createNodeDwsRunner } from '../../../../packages/dingtalk-dsh-assistant/dws-runner.js'
const { values: args } = parseArgs({ options: Object.fromEntries(['request-id','task-id','db','profile','output','cwd'].map(key => [key, { type: 'string' }])) })
for (const key of ['request-id','task-id','db','profile','output','cwd']) assert(args[key], `${key} required`)
const read = async route => { const response = await fetch(`http://127.0.0.1:18998${route}`); assert.equal(response.status, 200); return response.json() }
const requests = await read('/state/authorizations'), request = requests.find(row => row.requestId === args['request-id'])
assert(request); assert.equal(request.taskId, args['task-id']); assert.equal(request.decision, 'pending'); assert.equal(request.status, 'waiting-reply')
const notice = request.notification
assert.equal(notice.status, 'waiting-reply'); assert(notice.delivery.openTaskId); assert(notice.delivery.messageId); assert(request.approverIds.includes(notice.approverActorId))
const db = new DatabaseSync(args.db, { readOnly: true })
let events, approval
try {
  approval = db.prepare('SELECT decision,effect_id FROM execution_approvals WHERE request_id=?').get(request.requestId)
  assert.equal(approval.decision, 'pending'); assert.equal(approval.effect_id, notice.effectId)
  events = db.prepare("SELECT seq,kind,payload FROM execution_events WHERE kind IN ('approval.notice.prepare','approval.notice.send','approval.notice.receipt','approval.notice.delivered','approval.notice.unsent','approval.notice.recalled') AND json_extract(payload,'$.requestId')=? ORDER BY seq").all(request.requestId).map(row => ({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) }))
  assert.equal(events.filter(row => row.kind === 'approval.notice.delivered').length, 1)
  assert.equal(events.filter(row => row.kind === 'approval.notice.unsent').length, 1)
} finally { db.close() }
const adapter = createDwsAdapter({ enabled: true, profile: args.profile, runner: createNodeDwsRunner({ cwd: args.cwd }) })
const message = await adapter.readMessage(notice.delivery.conversationId, notice.delivery.messageId)
const rendered = normalizeApprovalNoticeText
// 已送达消息可原位更新展示；原生冻结通知仍保留最初发送内容供审计。
assert.equal(rendered(message.text), rendered(request.text))
const messages = await adapter.readConversation(notice.delivery.conversationId, { start: new Date(Date.parse(notice.delivery.sentAt ?? notice.createdAt) - 30000).toISOString(), end: new Date().toISOString() })
const occurrences = messages.filter(row => typeof row.text === 'string' && rendered(row.text) === rendered(request.text))
assert.equal(occurrences.length, 1)
const health = await read('/health'), maintenance = await read('/runtime/maintenance'), detail = await read(`/state/tasks/${args['task-id']}/detail`)
assert.equal(health.status, 'ok'); assert.equal(health.inboundProcessing, true); assert.equal(maintenance.active, false)
await writeFile(args.output, JSON.stringify({ request, approval, events, message, occurrences: occurrences.length, health, maintenance, detail }, null, 2))
console.log(JSON.stringify({ requestId: request.requestId, decision: request.decision, noticeStatus: notice.status, messageId: message.messageId, occurrences: occurrences.length, health: health.status, maintenanceActive: maintenance.active }))
