import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskCheckpoint, parseTaskResult, taskCheckpointJsonSchema, taskResultJsonSchema, storedTaskCheckpointBaseSchema } from '../packages/dingtalk-dsh-assistant/task-result.js'

test('诊断允许受影响阶段但拒绝推进字段与计划评估，历史存储不受影响', () => {
  const diagnostic = { inputVersion: 1, runSequence: 1, submissionId: 's1', kind: 'risk-changed', stageId: 'stage1', stageTask: '部署', summary: '发现风险', nextStep: '等待核对' }
  assert.equal(parseTaskCheckpoint(diagnostic).stageTask, '部署')
  assert.throws(() => parseTaskCheckpoint({ ...diagnostic, completedItems: ['部署'] }), /completedItems/)
  assert.throws(() => parseTaskCheckpoint({ ...diagnostic, workflowAssessment: { promptRefs: [] } }), /task_checkpoint_invalid/)
  assert.equal(storedTaskCheckpointBaseSchema.parse({ ...diagnostic, completedItems: ['旧记录'] }).completedItems[0], '旧记录')
  assert.equal(taskCheckpointJsonSchema.oneOf?.length ?? taskCheckpointJsonSchema.anyOf.length, 5)
  assert.equal(taskResultJsonSchema.oneOf.length, 3)
})

test('Task checkpoint只接受事件驱动的结构化内部同步', () => {
  const checkpoint = { inputVersion: 1, runSequence: 1, kind: 'stage-completed', stageTask: '核验接口', summary: '已完成接口核验', completedItems: ['读取实现'], evidence: ['runtime.js:303'], remainingItems: ['验证异常路径'], nextStep: '运行回归测试', needsCoordinatorDecision: false }
  assert.deepEqual(parseTaskCheckpoint(checkpoint), checkpoint)
  assert.throws(() => parseTaskCheckpoint({ ...checkpoint, kind: 'heartbeat' }))
  assert.throws(() => parseTaskCheckpoint({ ...checkpoint, extra: true }))
})

test('Task completed结果要求非空summary与至少一条evidence', () => {
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'completed', workType: 'non-development', summary: 'done', evidence: [], artifacts: [] }))
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'completed', workType: 'non-development', summary: ' ', evidence: ['ok'], artifacts: [] }))
  assert.deepEqual(parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] }), { inputVersion: 1, runSequence: 1, status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] })
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [], internal: { learningSignals: [] } }))
})

test('开发任务证据由配置引导而非插件固化具体平台字段', () => {
  const base = { inputVersion: 1, runSequence: 1, status: 'completed', workType: 'development', summary: 'released', evidence: ['verified'], artifacts: [] }
  assert.equal(parseTaskResult(base).summary, 'released')
  assert.equal(parseTaskResult({ ...base, delivery: { pipeline: 'success #1', runtime: ['pod Ready'] } }).delivery.pipeline, 'success #1')
})

test('Task waiting结果要求明确waitingReason且拒绝多余字段', () => {
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', summary: 'need input', evidence: [], artifacts: [] }))
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'missing file', questions: ['Which file?'], extra: true }))
  assert.equal(parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'missing file', questions: ['Which file?'] }).waitingReason, 'missing file')
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', waitingKind: 'human-intervention', summary: 'network down', evidence: [], artifacts: [], waitingReason: 'offline', blockerCategory: 'network', requestedAction: 'restore network' }))
  const intervention = parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', waitingKind: 'human-intervention', summary: 'network down', evidence: ['connection refused'], artifacts: [], waitingReason: 'offline', blockerCategory: 'network', risk: '任务持续中断，可能延误交付。', attemptedActions: ['retried twice'], requestedAction: 'confirm network recovery' })
  assert.equal(intervention.blockerCategory, 'network')
  assert.equal(intervention.risk, '任务持续中断，可能延误交付。')
  assert.throws(() => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', waitingKind: 'human-intervention', summary: 'Goal 24轮耗尽', evidence: ['流水线仍在运行'], artifacts: [], waitingReason: '构建仍在正常运行', blockerCategory: 'resource', risk: '提前结束会误报', attemptedActions: ['已监控'], requestedAction: '请恢复任务继续只读监控' }), /task_waiting_requires_real_human_action/)
})

test('叶子回执必须声明执行输入版本和轮次，不能由 Runtime 猜测', () => {
  const result = { status: 'completed', summary: 'done', evidence: ['verified'] }
  assert.throws(() => parseTaskResult(result))
  assert.throws(() => parseTaskResult({ ...result, inputVersion: 1 }))
  assert.throws(() => parseTaskResult({ ...result, inputVersion: 0, runSequence: 1 }))
  assert.throws(() => parseTaskCheckpoint({ kind: 'plan-confirmed', summary: '确认', nextStep: '执行' }))
})

test('叶子回执错误只报告匹配类型的字段问题', () => {
  assert.throws(
    () => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'completed', summary: '', evidence: [], artifacts: [] }),
    (error) => error.message.startsWith('task_result_invalid:') && error.message.includes('summary') && !error.message.includes('invalid_union'),
  )
  assert.throws(
    () => parseTaskResult({ inputVersion: 1, runSequence: 1, status: 'waiting', summary: '等待' }),
    /"path":"waitingKind"/,
  )
})
