import assert from 'node:assert/strict'
import test from 'node:test'
import { reviseTaskProgress, stagePlanFor, reconcileLegacyStagePlan } from '../packages/dingtalk-dsh-assistant/task-input-revision.js'

const basis = new Set(['m1'])
function task() {
  const current = { taskId: 't1', inputVersion: 3, runSequence: 1, objective: '完成发布', acceptanceCriteria: ['确认结果'], stageTasks: ['准备', 'SQL', '部署'] }
  current.stagePlan = stagePlanFor(current, current.stageTasks)
  current.checkpoints = [{ checkpointId: 'plan', kind: 'plan-confirmed', coordinatorDecision: 'acknowledge', inputVersion: 2, runSequence: 1, completedItems: [] }, ...current.stagePlan.map((stage, i) => ({ checkpointId: `cp${i}`, kind: 'stage-completed', coordinatorDecision: 'acknowledge', inputVersion: 2, runSequence: 1, stageId: stage.stageId, stageTask: stage.title, completedItems: [stage.title], evidence: [`proof${i}`] }))]
  return current
}
const impact = (current, index = 1) => ({ basisMessageIds: ['m1'], reason: '该阶段证据被新事实否定', affectedStageIds: [current.stagePlan[index].stageId] })

test('旧任务按已批准细计划恢复阶段索引，保留历史版本和原报告', () => {
  const current = task()
  delete current.stagePlan
  current.stageTasks = ['完成并验证当前轮目标']
  current.checkpoints = [
    { checkpointId: 'plan', kind: 'plan-confirmed', coordinatorDecision: 'acknowledge', inputVersion: 3, runSequence: 1, remainingItems: ['准备', 'SQL', '部署'] },
    { checkpointId: 'done', kind: 'stage-completed', coordinatorDecision: 'acknowledge', inputVersion: 3, runSequence: 1, stageTask: '完成并验证当前轮目标', completedItems: ['准备'] },
  ]
  const before = structuredClone(current)
  const reconciled = reconcileLegacyStagePlan(current)
  assert.deepEqual(reconciled.stageTasks, ['准备', 'SQL', '部署'])
  assert.deepEqual(current, before)
  const updated = { ...current, ...reconciled }
  assert.equal(reconcileLegacyStagePlan(updated), undefined)
  const revised = reviseTaskProgress(updated, { stageTasks: ['准备', '新SQL', '部署'] }, basis)
  assert.deepEqual(revised.checkpoints.map(item => item.checkpointId), ['done'])
})

test('相同参数和单纯状态询问保留原版本证据，不误触发replan', () => {
  const current = task()
  const result = reviseTaskProgress(current, { objective: current.objective, acceptanceCriteria: [...current.acceptanceCriteria], stageTasks: [...current.stageTasks] }, basis)
  assert.equal(result.scopeChanged, false)
  assert.equal(result.progressImpact, 'preserve')
  assert.deepEqual(result.checkpoints, current.checkpoints)
  assert.ok(result.checkpoints.every(cp => cp.inputVersion === 2))
  assert.deepEqual(reviseTaskProgress(current, {}, basis).checkpoints, current.checkpoints)
})

test('同目标下证据否定仍触发定向重规划，preserve不能覆盖明确影响', () => {
  const current = task()
  const result = reviseTaskProgress(current, { progressImpact: 'preserve', impactEvidence: impact(current) }, basis)
  assert.equal(result.progressImpact, 'replan')
  assert.equal(result.scopeChanged, false)
  assert.deepEqual(result.checkpoints.map(cp => cp.checkpointId), ['cp0'])
  assert.deepEqual(result.affectedStageIds, current.stagePlan.slice(1).map(stage => stage.stageId))
  assert.equal(result.checkpoints[0].inputVersion, 2)
})

test('已接受的历史决策以阶段标题引用影响范围时归一化为稳定阶段ID', () => {
  const current = task()
  const evidence = { ...impact(current), affectedStageIds: ['SQL'] }
  const result = reviseTaskProgress(current, { progressImpact: 'replan', impactEvidence: evidence }, basis)
  assert.deepEqual(result.checkpoints.map(cp => cp.checkpointId), ['cp0'])
  assert.deepEqual(result.affectedStageIds, current.stagePlan.slice(1).map(stage => stage.stageId))
})

test('真实目标变化优先采用明确影响证据，未限定时保守失效全部', () => {
  const current = task()
  const targeted = reviseTaskProgress(current, { objective: '完成新环境发布', impactEvidence: impact(current, 2) }, basis)
  assert.deepEqual(targeted.checkpoints.map(cp => cp.checkpointId), ['cp0', 'cp1'])
  const broad = reviseTaskProgress(current, { acceptanceCriteria: ['不同验收范围'] }, basis)
  assert.equal(broad.checkpoints.length, 0)
})

test('重排或替换阶段按最早差异失效，不能以较晚impact掩盖', () => {
  const current = task()
  const result = reviseTaskProgress(current, { stageTasks: ['SQL', '准备', '部署'], impactEvidence: impact(current, 2) }, basis)
  assert.equal(result.checkpoints.length, 0)
  assert.equal(result.stagePlan[0].stageId, current.stagePlan[1].stageId)
  const appended = reviseTaskProgress(current, { stageTasks: [...current.stageTasks, '验收'] }, basis)
  assert.deepEqual(appended.checkpoints.map(cp => cp.checkpointId), ['cp0', 'cp1', 'cp2'])
  assert.equal(appended.progressImpact, 'replan')
  assert.deepEqual(appended.stagePlan.slice(0, 3), current.stagePlan)
})

test('无依据replan、非法来源、未知阶段或空理由均拒绝', () => {
  const current = task()
  assert.throws(() => reviseTaskProgress(current, { progressImpact: 'replan' }, basis), /task_revision_impact_required/)
  for (const evidence of [{ ...impact(current), basisMessageIds: ['other'] }, { ...impact(current), basisMessageIds: [] }]) assert.throws(() => reviseTaskProgress(current, { impactEvidence: evidence }, basis), /task_revision_basis_invalid/)
  assert.throws(() => reviseTaskProgress(current, { impactEvidence: { ...impact(current), affectedStageIds: ['unknown'] } }, basis), /task_revision_stage_invalid/)
  assert.throws(() => reviseTaskProgress(current, { impactEvidence: { ...impact(current), reason: '' } }, basis), /task_revision_reason_required/)
})

test('拒绝记录、其他run以及空completedItems不能冒充有效受影响阶段', () => {
  const current = task()
  current.checkpoints.push({ ...current.checkpoints[1], checkpointId: 'rejected', coordinatorDecision: 'reject' }, { ...current.checkpoints[1], checkpointId: 'other-run', runSequence: 9 }, { ...current.checkpoints[3], checkpointId: 'empty-affected', completedItems: [] })
  const result = reviseTaskProgress(current, { impactEvidence: impact(current) }, basis)
  assert.deepEqual(result.checkpoints.map(cp => cp.checkpointId), ['cp0'])
  const preserve = reviseTaskProgress(current, {}, basis)
  assert.ok(!preserve.checkpoints.some(cp => ['rejected', 'other-run'].includes(cp.checkpointId)))
})

test('阶段ID可重复恢复且重排稳定，重复标题或冲突ID明确拒绝', () => {
  const current = task()
  assert.deepEqual(stagePlanFor(current, current.stageTasks), current.stagePlan)
  assert.deepEqual(stagePlanFor({ ...current, stagePlan: undefined }, current.stageTasks), current.stagePlan)
  assert.throws(() => stagePlanFor(current, ['准备', '准备']), /stage_titles_invalid/)
  assert.throws(() => stagePlanFor({ ...current, stagePlan: current.stagePlan.map(stage => ({ ...stage, stageId: 'same' })) }, current.stageTasks), /stage_identity_conflict/)
})
