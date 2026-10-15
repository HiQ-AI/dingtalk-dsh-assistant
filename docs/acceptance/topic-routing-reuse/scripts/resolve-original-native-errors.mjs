import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const mode = process.argv[2]
if (!['--check', '--apply'].includes(mode)) throw new Error('require --check or --apply')
const taskId = 'task-4c4780a541c5ea7c51024975de5f121d'
const humanRequestId = 'human-5e84e76b64942acdbe3b15d6d33f1730d77f89ca962df70ebe041c4d4567a7b5'
const ids = ['operation-d00a661cc36bc0273e26a716090954b4ef8df1fb', 'operation-e132cbbdc8560bd3e65c41f0095013cf8e8f0835']
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const db = new DatabaseSync('D:/baibu-agent/.dsh/task-sessions.sqlite', { readOnly: true })
let operations, task
try {
  task = db.prepare('SELECT body FROM dynamic_tasks WHERE id=?').get(taskId)
  task = JSON.parse(task.body)
  const all = db.prepare('SELECT body FROM dynamic_operations').all().map(row => JSON.parse(row.body))
  operations = ids.map(id => all.find(item => item.operationId === id))
} finally { db.close() }
if (operations.some(item => !item || item.taskId !== taskId || item.definition.toolName !== 'mcp__bytebase__get_schema')) throw new Error('ORIGINAL_SCOPE_CHANGED')
const request = task.humanRequests.find(item => item.requestId === humanRequestId)
if (!request || request.audience !== 'operator' || !['waiting-reply', 'answered'].includes(request.status)) throw new Error('HUMAN_REQUEST_CHANGED')
const body = {
  requestId: 'native-error-operator-resolution-20261015-v1',
  reply: '按操作人本次明确请求，仅核验并结算两次原生DATABASE_NOT_FOUND：operation-d00a661cc36bc0273e26a716090954b4ef8df1fb、operation-e132cbbdc8560bd3e65c41f0095013cf8e8f0835。保留原调用身份、精确错误及绑定只读调查，将已结束请求记为failed并保留partialEffectsPossible；不登记成功、noEffect或猜测同步效果，不重放Bytebase API。UAT结构兼容已由既有直连只读工具核验，停止使用Bytebase；本地dataset读取正常，403仅是GitHub rulesets/protection API。解除后沿原execution/session继续规则接口核对与部署准备，本答复不构成提交、推送、改PR、构建或部署的精确批准。',
  expectedRequirementRevision: request.requirementRevision,
  expectedControlRevision: request.controlRevision,
  nativeFailureResolutions: operations.map(item => ({ operationId: item.operationId, expectedOperationDigest: hash(item.state === 'failed' && item.result.operatorSourceId ? item.result.previousObservation : item) })),
}
const base = `http://127.0.0.1:18998/tasks/${taskId}/human-requests/${humanRequestId}/reply`
const post = async suffix => {
  const response = await fetch(base + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, result }))
  return result
}
if (mode === '--check') console.log(JSON.stringify(await post('/check'), null, 2))
else {
  if (request.status === 'waiting-reply') await post('/check')
  const result = await post('')
  console.log(JSON.stringify({ applied: true, taskId: result.taskId, status: result.status, operations: ids, replayedApi: false }, null, 2))
}
