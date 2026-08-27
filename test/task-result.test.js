import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskCheckpoint, parseTaskResult } from '../packages/dingtalk-dsh-assistant/task-result.js'

test('Task checkpoint只接受事件驱动的结构化内部同步', () => {
  const checkpoint = { kind: 'stage-completed', stageTask: '核验接口', summary: '已完成接口核验', completedItems: ['读取实现'], evidence: ['runtime.js:303'], remainingItems: ['验证异常路径'], nextStep: '运行回归测试', needsCoordinatorDecision: false }
  assert.deepEqual(parseTaskCheckpoint(checkpoint), checkpoint)
  assert.throws(() => parseTaskCheckpoint({ ...checkpoint, kind: 'heartbeat' }))
  assert.throws(() => parseTaskCheckpoint({ ...checkpoint, extra: true }))
})

test('Task completed结果要求非空summary与至少一条evidence', () => {
  assert.throws(() => parseTaskResult({ status: 'completed', workType: 'non-development', summary: 'done', evidence: [], artifacts: [] }))
  assert.throws(() => parseTaskResult({ status: 'completed', workType: 'non-development', summary: ' ', evidence: ['ok'], artifacts: [] }))
  assert.deepEqual(parseTaskResult({ status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] }), { status: 'completed', workType: 'non-development', summary: 'done', evidence: ['verified'], artifacts: [] })
})

test('开发任务证据由配置引导而非插件固化具体平台字段', () => {
  const base = { status: 'completed', workType: 'development', summary: 'released', evidence: ['verified'], artifacts: [] }
  assert.equal(parseTaskResult(base).summary, 'released')
  assert.equal(parseTaskResult({ ...base, delivery: { pipeline: 'success #1', runtime: ['pod Ready'] } }).delivery.pipeline, 'success #1')
})

test('Task waiting结果要求明确waitingReason且拒绝多余字段', () => {
  assert.throws(() => parseTaskResult({ status: 'waiting', summary: 'need input', evidence: [], artifacts: [] }))
  assert.throws(() => parseTaskResult({ status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'missing file', questions: ['Which file?'], extra: true }))
  assert.equal(parseTaskResult({ status: 'waiting', waitingKind: 'information', summary: 'need input', evidence: [], artifacts: [], waitingReason: 'missing file', questions: ['Which file?'] }).waitingReason, 'missing file')
  assert.throws(() => parseTaskResult({ status: 'waiting', waitingKind: 'human-intervention', summary: 'network down', evidence: [], artifacts: [], waitingReason: 'offline', blockerCategory: 'network', requestedAction: 'restore network' }))
  const intervention = parseTaskResult({ status: 'waiting', waitingKind: 'human-intervention', summary: 'network down', evidence: ['connection refused'], artifacts: [], waitingReason: 'offline', blockerCategory: 'network', risk: '任务持续中断，可能延误交付。', attemptedActions: ['retried twice'], requestedAction: 'confirm network recovery' })
  assert.equal(intervention.blockerCategory, 'network')
  assert.equal(intervention.risk, '任务持续中断，可能延误交付。')
  assert.throws(() => parseTaskResult({ status: 'waiting', waitingKind: 'human-intervention', summary: 'Goal 24轮耗尽', evidence: ['流水线仍在运行'], artifacts: [], waitingReason: '构建仍在正常运行', blockerCategory: 'resource', risk: '提前结束会误报', attemptedActions: ['已监控'], requestedAction: '请恢复任务继续只读监控' }), /task_waiting_requires_real_human_action/)
})
