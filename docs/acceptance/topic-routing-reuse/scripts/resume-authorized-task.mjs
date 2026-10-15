import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { taskModelInput, executionModelInput } from '../../../../packages/dingtalk-dsh-assistant/model-context.js'

const mode = process.argv[2]
if (!['--check', '--apply', '--readback'].includes(mode)) throw new Error('require --check, --apply or --readback')
const correction = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null
if (mode !== '--readback' && !correction) throw new Error('require exact correction JSON file')
const taskId = 'task-4c4780a541c5ea7c51024975de5f121d'
const humanRequestId = correction?.humanRequestId ?? 'human-82f82c9a2a9785f4155ec84c4a0e71708c0ee840050cc924d6b8fc9f38eb0a29'
const executionId = 'bdb7b510-4a09-4cd3-9a06-8ac8dda42608'
const authorizationSourceId = 'im:db8aff36986c204958b55aa8e5a7c5611f84f2fb71c8cca59126b36ad588e166'
const db = new DatabaseSync('D:/baibu-agent/.dsh/task-sessions.sqlite', { readOnly: true })
let task, execution, sources, operations, wakes
try {
  task = JSON.parse(db.prepare('SELECT body FROM dynamic_tasks WHERE id=?').get(taskId).body)
  execution = JSON.parse(db.prepare('SELECT body FROM dynamic_executions WHERE id=?').get(executionId).body)
  sources = task.sourceRefs.map(id => JSON.parse(db.prepare('SELECT body FROM dynamic_sources WHERE id=?').get(id).body))
  operations = db.prepare('SELECT body FROM dynamic_operations').all().map(row => JSON.parse(row.body)).filter(item => item.taskId === taskId)
  wakes = db.prepare("SELECT body FROM dynamic_wakes WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(taskId).map(row => JSON.parse(row.body))
} finally { db.close() }
const originalRequest = task.humanRequests.find(item => item.requestId === humanRequestId)
const authorization = sources.find(item => item.sourceId === authorizationSourceId)
if (authorization?.text !== '部署到uat' || authorization.actorId !== originalRequest?.actorId && originalRequest?.actorId !== undefined) throw new Error('ORIGINAL_AUTHORIZATION_CHANGED')
if (task.taskId !== taskId || execution.taskId !== taskId || execution.sessionId !== 'task-execution-9b11f09e-1ede-4e07-8e66-a9d104bdbbf6') throw new Error('ORIGINAL_IDENTITY_CHANGED')
const snapshot = {
  taskId, taskSessionId: task.sessionId, status: task.status, drained: task.drained,
  leaseEpoch: task.leaseEpoch, runSequence: task.runSequence,
  requirementRevision: task.requirementRevision, controlRevision: task.controlRevision,
  originalRequest: { requestId: humanRequestId, status: originalRequest.status, reply: originalRequest.reply },
  waiting: task.humanRequests.filter(item => item.status === 'waiting-reply').map(item => ({ requestId: item.requestId, reason: item.reason, question: item.question })),
  execution: { executionId, sessionId: execution.sessionId, inputVersion: execution.inputVersion, status: execution.status, drained: execution.drained, objective: execution.input?.objective, sourceIds: execution.input?.sources?.map(item => item.sourceId), summary: execution.result?.payload?.output?.summary },
  unknownOperations: operations.filter(item => item.state === 'unknown').map(item => item.operationId),
  wakeCounts: Object.fromEntries([...new Set(wakes.map(item => item.kind))].map(kind => [kind, wakes.filter(item => item.kind === kind).length])),
  recentWakes: wakes.slice(-8).map(item => ({ wakeId: item.wakeId, kind: item.kind, state: item.state, createdAt: item.createdAt })),
  recentOperations: operations.slice(-6).map(item => ({ operationId: item.operationId, state: item.state, toolName: item.definition?.toolName, createdAt: item.createdAt, updatedAt: item.updatedAt })),
}
if (mode === '--readback') console.log(JSON.stringify(snapshot, null, 2))
else {
  if (task.requirementRevision !== 4 || task.controlRevision !== 2 || !task.drained || !execution.drained || snapshot.unknownOperations.length) throw new Error('ORIGINAL_STATE_CHANGED')
  if (originalRequest.status !== 'waiting-reply') throw new Error('ORIGINAL_REQUEST_NOT_WAITING')
  const owner = taskModelInput({ task, sources }).sources
  const executor = executionModelInput({ task: { ...task, authorizationSourceId: task.metadata.authorizationSourceId }, sources }, { executionId }).sources
  if (![owner, executor].every(items => items.some(item => item.sourceId === authorizationSourceId))) throw new Error('AUTHORIZATION_NOT_VISIBLE')
  const { requestId, reply, expectedRequirementRevision, expectedControlRevision } = correction
  if (typeof requestId !== 'string' || !requestId || typeof reply !== 'string' || !reply.trim()
    || expectedRequirementRevision !== task.requirementRevision || expectedControlRevision !== task.controlRevision) throw new Error('CORRECTION_INVALID')
  const body = { requestId, reply, expectedRequirementRevision, expectedControlRevision }
  if (mode === '--check') console.log(JSON.stringify({ writes: 0, snapshot, ownerSourceIds: owner.map(item => item.sourceId), executionSourceIds: executor.map(item => item.sourceId), reply: body.reply }, null, 2))
  else {
    const response = await fetch(`http://127.0.0.1:18998/tasks/${taskId}/human-requests/${humanRequestId}/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(JSON.stringify({ status: response.status, value }))
    console.log(JSON.stringify({ taskId: value.taskId, requestId, accepted: true, businessResult: 'pending independent readback' }))
  }
}
