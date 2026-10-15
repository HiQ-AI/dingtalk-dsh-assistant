import { DatabaseSync } from 'node:sqlite'
import { taskModelInput, executionModelInput } from '../../../../packages/dingtalk-dsh-assistant/model-context.js'

const mode = process.argv[2]
if (!['--check', '--apply', '--readback'].includes(mode)) throw new Error('require --check, --apply or --readback')
const taskId = 'task-4c4780a541c5ea7c51024975de5f121d'
const humanRequestId = 'human-82f82c9a2a9785f4155ec84c4a0e71708c0ee840050cc924d6b8fc9f38eb0a29'
const executionId = 'bdb7b510-4a09-4cd3-9a06-8ac8dda42608'
const authorizationSourceId = 'im:db8aff36986c204958b55aa8e5a7c5611f84f2fb71c8cca59126b36ad588e166'
const requestId = 'authorization-continuity-correction-20261015-v1'
const db = new DatabaseSync('D:/baibu-agent/.dsh/task-sessions.sqlite', { readOnly: true })
let task, execution, sources, operations
try {
  task = JSON.parse(db.prepare('SELECT body FROM dynamic_tasks WHERE id=?').get(taskId).body)
  execution = JSON.parse(db.prepare('SELECT body FROM dynamic_executions WHERE id=?').get(executionId).body)
  sources = task.sourceRefs.map(id => JSON.parse(db.prepare('SELECT body FROM dynamic_sources WHERE id=?').get(id).body))
  operations = db.prepare('SELECT body FROM dynamic_operations').all().map(row => JSON.parse(row.body)).filter(item => item.taskId === taskId)
} finally { db.close() }
const originalRequest = task.humanRequests.find(item => item.requestId === humanRequestId)
const authorization = sources.find(item => item.sourceId === authorizationSourceId)
if (authorization?.text !== '部署到uat' || authorization.actorId !== originalRequest?.actorId && originalRequest?.actorId !== undefined) throw new Error('ORIGINAL_AUTHORIZATION_CHANGED')
if (task.taskId !== taskId || execution.taskId !== taskId || execution.sessionId !== 'task-execution-9b11f09e-1ede-4e07-8e66-a9d104bdbbf6') throw new Error('ORIGINAL_IDENTITY_CHANGED')
const snapshot = {
  taskId, taskSessionId: task.sessionId, status: task.status, drained: task.drained,
  requirementRevision: task.requirementRevision, controlRevision: task.controlRevision,
  originalRequest: { requestId: humanRequestId, status: originalRequest.status, reply: originalRequest.reply },
  waiting: task.humanRequests.filter(item => item.status === 'waiting-reply').map(item => ({ requestId: item.requestId, reason: item.reason, question: item.question })),
  execution: { executionId, sessionId: execution.sessionId, inputVersion: execution.inputVersion, status: execution.status, drained: execution.drained, objective: execution.input?.objective, sourceIds: execution.input?.sources?.map(item => item.sourceId), summary: execution.result?.payload?.output?.summary },
  unknownOperations: operations.filter(item => item.state === 'unknown').map(item => item.operationId),
  recentOperations: operations.slice(-6).map(item => ({ operationId: item.operationId, state: item.state, toolName: item.definition?.toolName, createdAt: item.createdAt, updatedAt: item.updatedAt })),
}
if (mode === '--readback') console.log(JSON.stringify(snapshot, null, 2))
else {
  if (task.requirementRevision !== 4 || task.controlRevision !== 2 || !task.drained || !execution.drained || snapshot.unknownOperations.length) throw new Error('ORIGINAL_STATE_CHANGED')
  if (!['waiting-reply', 'answered'].includes(originalRequest.status)) throw new Error('ORIGINAL_REQUEST_CHANGED')
  const owner = taskModelInput({ task, sources }).sources
  const executor = executionModelInput({ task: { ...task, authorizationSourceId: task.metadata.authorizationSourceId }, sources }, { executionId }).sources
  if (![owner, executor].every(items => items.some(item => item.sourceId === authorizationSourceId))) throw new Error('AUTHORIZATION_NOT_VISIBLE')
  const body = { requestId, expectedRequirementRevision: 4, expectedControlRevision: 2,
    reply: '操作人已明确要求修正重复审批并继续原任务。12:17孙鹏原文“部署到uat”（来源im:db8aff36986c204958b55aa8e5a7c5611f84f2fb71c8cca59126b36ad588e166）仍是本任务有效交办；后续技术恢复答复只限定该次恢复，不撤销已有UAT范围。当前A段的原三文件提交、原开发分支快进推送、更新PR353正文、本地UAT集成和隔离验证属于完成已交办目标的必要步骤，请核对原文、原分支及当前状态后沿原executionId/session继续，不再为这些步骤申请同一批准。按项目规则推进原UAT任务；确有要求最终批准的发布动作，先完成可自行执行的准备和验证，再只说明具体待决动作、已有授权不足之处及新增风险。不得把新SHA或镜像摘要尚未产生当作前置审批理由。原共享环境测试限制继续有效，不运行全仓共享测试、不改生产、不操作真实申请、不强推、不合main、不重发旧通知。摘要先说已完成什么、下一步是什么；只有真实新增缺口才等待。' }
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
