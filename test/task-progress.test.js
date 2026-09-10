import assert from 'node:assert/strict'
import test from 'node:test'
import { taskProgressSnapshot } from '../packages/dingtalk-dsh-assistant/task-progress.js'

const task = () => ({ taskId: 'task-1', groupId: 'g1', inputVersion: 2, runSequence: 3, state: 'running', objective: '发布', stageTasks: ['SQL', '后端', '前端'], checkpoints: [
  { checkpointId: 'c1', inputVersion: 2, runSequence: 3, kind: 'stage-completed', stageTask: 'SQL', summary: 'SQL已执行', submittedAt: '2026-09-10T07:25:00Z', coordinatorDecision: 'acknowledge', reviewedAt: '2026-09-10T07:25:01Z', evidence: ['工单DONE'] },
  { checkpointId: 'c-old', inputVersion: 1, runSequence: 3, kind: 'stage-completed', stageTask: '后端', coordinatorDecision: 'acknowledge' },
], humanBlockerHistory: [{ requestId: 'approval-1', runSequence: 3, status: 'answered', decision: 'approved', requestedAction: '执行工单891', reply: '批准', decidedAt: '2026-09-10T07:19:10Z', replyMessageId: 'reply-1' }] })

test('快照只确认当前版本事实，批准保留原始引用且不授权新对象', () => {
  const original = task()
  const snapshot = taskProgressSnapshot(original, { snapshotAt: '2026-09-10T08:00:00Z' })
  assert.equal(snapshot.confirmedStages.length, 1)
  assert.equal(snapshot.currentStage, '后端')
  assert.equal(snapshot.confirmedStages[0].observedAt, '2026-09-10T07:25:00Z')
  assert.equal(snapshot.confirmedStages[0].externalVerifiedAt, null)
  assert.equal(snapshot.approvals[0].sourceRef, 'reply-1')
  assert.equal(snapshot.approvals[0].coversNewOperation, false)
  assert.equal(snapshot.approvals[0].requestedAction, '执行工单891')
  assert.deepEqual(original, task())
  assert.equal(taskProgressSnapshot(original).revision, snapshot.revision)
})

test('等待报告立即可见，settled后移出pending，不把报告当核验', () => {
  const original = task()
  original.executionEvents = [{ kind: 'task-report-received', submissionId: 'sub1', inputVersion: 2, runSequence: 3, at: '2026-09-10T07:30:00Z', status: 'input-wait', reportType: 'result', value: { summary: 'Pod Ready', evidence: ['HTTP200'] } }]
  assert.equal(taskProgressSnapshot(original).pendingReports[0].verification, 'reported-unreviewed')
  original.executionEvents.push({ kind: 'task-report-settled', submissionId: 'sub1', status: 'accepted', inputVersion: 2, runSequence: 3, at: '2026-09-10T07:31:00Z' })
  assert.equal(taskProgressSnapshot(original).pendingReports.length, 0)
  assert.equal(taskProgressSnapshot(original).result, null)
})

test('大量历史正文保持有界，旧轮批准不进入当前授权摘要', () => {
  const original = task()
  original.checkpoints = Array.from({ length: 100 }, (_, i) => ({ ...original.checkpoints[0], checkpointId: `c${i}`, summary: '文'.repeat(10000), evidence: Array(20).fill('证'.repeat(10000)) }))
  original.humanBlockerHistory.push({ requestId: 'old', runSequence: 2, status: 'answered', decision: 'approved', requestedAction: '旧SQL' })
  const snapshot = taskProgressSnapshot(original)
  assert.equal(snapshot.omitted.confirmedStages, 97)
  assert.equal(snapshot.omitted.historicalApprovals, 1)
  assert.ok(JSON.stringify(snapshot).length < 24000)
  assert.equal(snapshot.approvals.some((value) => value.approvalId === 'old'), false)
})

test('修订显式保留的已审阶段可见，仍标原inputVersion，不复活未保留证据', () => {
  const original = task()
  original.topicRefs = [{ topicId: 'topic1', revision: 3 }]
  original.inputVersion = 3
  original.executionEvents = [{ kind: 'input-revised', inputVersion: 3, retainedCheckpointIds: ['c1'] }]
  const snapshot = taskProgressSnapshot(original)
  assert.equal(snapshot.confirmedStages.length, 1)
  assert.equal(snapshot.confirmedStages[0].inputVersion, 2)
  assert.equal(snapshot.confirmedStages[0].retainedForInputVersion, 3)
  assert.equal(snapshot.currentStage, '后端')
  assert.deepEqual(snapshot.topicRefs, original.topicRefs)
})

test('同state等待原因、Topic或活动事实变化使revision失效，纯读取时间不改变revision', () => {
  const original = task()
  original.waitingReason = '等待审批'
  const before = taskProgressSnapshot(original, { snapshotAt: '2026-09-10T08:00:00Z' })
  assert.equal(taskProgressSnapshot(original, { snapshotAt: '2026-09-10T09:00:00Z' }).revision, before.revision)
  original.waitingReason = '等待生产核验'
  const changed = taskProgressSnapshot(original)
  assert.equal(changed.state, before.state)
  assert.notEqual(changed.revision, before.revision)
  original.topicRefs = [{ topicId: 'topic1', revision: 4 }]
  assert.notEqual(taskProgressSnapshot(original).revision, changed.revision)
  const topicRevision = taskProgressSnapshot(original).revision
  original.activityProjection = { lastSyncedAt: '2026-09-10T09:01:00Z', latestOccurredAt: '2026-09-10T09:00:30Z', truncated: false }
  assert.notEqual(taskProgressSnapshot(original).revision, topicRevision)
})
