import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isolationBinding, isolationDigest, hasRestartIsolation } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { openDynamicTaskStore, pendingTaskHumanReview } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { projectTaskTimeline, latestExecutionRoundTiming } from '../packages/dingtalk-dsh-assistant/task-execution-timeline.js'

test('正常初始化与重启不触发全库完整性审计，任务身份保持', async t => {
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    assert.doesNotMatch(sql, /PRAGMA\s+(?:quick_check|integrity_check|foreign_key_check)/iu)
    return prepare.call(this, sql)
  })
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'retained', request: '保留原任务' })
  const before = await f.query({ kind: 'task.get', taskId: 'retained' })
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'task.get', taskId: 'retained' }), before)
})

test('执行后端固定于创建定义，续办及重启不改派；CLI反馈不伪称原生模型准入', async t => {
  const f = await fixture(t), owner = await f.task()
  await assert.rejects(f.command('execution.dispatch', { binding: owner.binding, key: 'invalid', prompt: '核验', definition: { executionBackend: 'other' } }), { code: 'TASK_EXECUTION_BACKEND_INVALID' })
  assert.equal((await f.query({ kind: 'execution.list' })).length, 0)
  for (const backend of [undefined, 'dsh', 'claude-code']) {
    const key = backend ?? 'historical'
    const dispatched = (await f.command('execution.dispatch', { binding: owner.binding, key, prompt: '核验', ...(backend ? { definition: { executionBackend: backend } } : {}) })).result.execution
    const binding = (await f.command('execution.claim', { executionId: dispatched.executionId })).result.binding
    assert.equal(dispatched.claudeSessionMode, backend === 'claude-code' ? 'interactive-team-v1' : undefined)
    assert.equal(binding.claudeSessionMode, dispatched.claudeSessionMode)
    await assert.rejects(f.command('execution.result', { binding: { ...binding, claudeSessionMode: 'forged-mode' }, output: {} }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
    await f.command('execution.feedback', { binding: owner.binding, executionId: dispatched.executionId, messageId: key, text: '核对同一版本' })
    await f.command('execution.feedbackConsumed', { binding, messageId: key, sequence: 3 })
    await f.command('execution.result', { binding, output: {}, feedbackVersion: 1 })
    await f.command('execution.drained', { binding })
    const next = (await f.command('execution.continue', { binding: owner.binding, executionId: dispatched.executionId, key: `${key}-next`, prompt: '继续核验', definition: { executionBackend: backend === 'claude-code' ? 'dsh' : 'claude-code' } })).result.execution
    assert.equal(next.definition.executionBackend, backend)
    assert.equal(next.sessionId, dispatched.sessionId)
    assert.equal(next.inputVersion, 2)
    assert.equal(next.claudeSessionMode, dispatched.claudeSessionMode)
    const feedback = next.feedback[0]
    assert.equal(feedback.consumptionMeaning, backend === 'claude-code' ? 'claude-cli-input-admission' : 'native-model-step-admission')
    assert.equal(!!feedback.modelStepEnteredAt, backend !== 'claude-code')
    assert.equal(!!feedback.cliInputAdmittedAt, backend === 'claude-code')
  }
  const before = await f.query({ kind: 'execution.list' })
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'execution.list' })).map(item => [item.sessionId, item.definition.executionBackend]), before.map(item => [item.sessionId, item.definition.executionBackend]))
})

test('running supplement preserves the runner, persists once and fences old completion', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const before = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  const args = { taskId: 'task', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'branch-reminder', text: '开发分支别搞错了', request: '原目标\n开发分支别搞错了' }
  await f.command('task.supplement', args, 'supplement-one')
  assert.equal((await f.command('task.supplement', args, 'supplement-one')).replayed, true)
  await f.command('task.supplement', args, 'same-identity-new-command')
  await assert.rejects(f.command('task.supplement', { ...args, text: '不同消息' }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
  const task = await f.query({ kind: 'task.get', taskId: 'task' })
  const after = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(task.requirementRevision, 1)
  for (const key of ['executionId', 'sessionId', 'leaseEpoch', 'inputVersion', 'status', 'cancelRequested']) assert.equal(after[key], before[key])
  assert.equal(after.feedback.length, 1); assert.equal(after.feedback[0].consumedAt, null)
  await assert.rejects(f.command('execution.claim', { executionId: binding.executionId }), { code: 'DYNAMIC_EXECUTION_BUSY' })
  await assert.rejects(f.command('execution.result', { binding, output: {} }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: '旧结论' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('execution.feedbackConsumed', { binding, messageId: 'branch-reminder', sequence: 20 })
  await assert.rejects(f.command('execution.result', { binding, output: {}, feedbackVersion: 0 }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await f.command('execution.result', { binding, output: {}, feedbackVersion: 1 })
  await f.command('execution.drained', { binding })
  await f.reopen()
  const restored = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(restored.feedback.length, 1); assert.equal(restored.feedback[0].sequence, 20)
  assert.ok(restored.feedback[0].consumedAt); assert.equal(restored.result.payload.output !== null, true)
})

test('coordinator feedback deduplicates identity, survives restart and retains cancel and requirement fences', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { binding: owner.binding, executionId: binding.executionId, messageId: 'clarification', text: '内置通知仍在授权范围内' }
  await f.command('execution.feedback', args, 'feedback-one')
  await f.command('execution.feedback', args, 'feedback-retry')
  await assert.rejects(f.command('execution.feedback', { ...args, text: '不同说明' }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
  await f.reopen()
  const restored = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(restored.feedback.length, 1); assert.equal(restored.feedback[0].consumedAt, null)
  await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  await assert.rejects(f.command('execution.feedbackConsumed', { binding, messageId: 'clarification', sequence: 9 }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await f.command('execution.result', { binding, output: {}, feedbackVersion: 1 }).catch(error => assert.equal(error.code, 'DYNAMIC_EXECUTION_FEEDBACK_PENDING'))
  assert.equal((await f.query({ kind: 'execution.current', binding })), false)
})

test('pending feedback blocks task completion even after executor reports failure and drains', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.feedback', { binding: owner.binding, executionId: binding.executionId, messageId: 'late', text: '核对新事实' })
  await f.command('execution.result', { binding, error: { code: 'transport_failed' } })
  await f.command('execution.drained', { binding })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: '不能漏掉输入' }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await f.command('task.revise', { taskId: 'task', request: '真正目标变化' })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).requirementRevision, 2)
})

test('peer messages reach queued teammates once, retain provenance and fence completion until model admission', async t => {
  const f = await fixture(t), owner = await f.task(), source = await f.execution(owner.binding, 'source')
  const recipient = (await f.command('execution.dispatch', { binding: owner.binding, key: 'recipient', prompt: 'Review', input: { objective: '核验候选', context: '只读当前版本' } })).result.execution
  const args = { binding: source, executionId: recipient.executionId, targetInputVersion: 1, key: 'candidate-ready', message: '候选已写入，核验 v1 的原始测试结果。' }
  const first = (await f.command('execution.peerMessage', args, 'peer-first')).result
  assert.equal(first.received, true); assert.equal(first.feedback.id, `peer:${source.executionId}:1:candidate-ready`)
  assert.equal(first.feedback.sourceExecutionId, source.executionId); assert.equal(first.feedback.sourceInputVersion, 1)
  assert.equal(first.feedback.sourceLeaseEpoch, source.leaseEpoch); assert.equal(first.feedback.consumedAt, null)
  assert.equal((await f.command('execution.peerMessage', args, 'peer-first')).replayed, true)
  assert.deepEqual((await f.command('execution.peerMessage', args)).result.feedback, first.feedback)
  await assert.rejects(f.command('execution.peerMessage', { ...args, message: '改为直接部署' }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
  const beforeClaim = await f.query({ kind: 'execution.get', executionId: recipient.executionId })
  assert.equal(beforeClaim.status, 'queued'); assert.equal(beforeClaim.leaseEpoch, 0); assert.equal(beforeClaim.feedback.length, 1)
  const target = (await f.command('execution.claim', { executionId: recipient.executionId })).result.binding
  await assert.rejects(f.command('execution.result', { binding: target, output: {}, feedbackVersion: 1 }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: '不能漏读队友消息' }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await f.command('execution.feedbackConsumed', { binding: target, messageId: first.feedback.id, sequence: 9 })
  assert.ok((await f.command('execution.peerMessage', args)).result.feedback.consumedAt)
  await assert.rejects(f.command('execution.result', { binding: target, output: {}, feedbackVersion: 0 }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await f.command('execution.result', { binding: target, output: { summary: '核验完成' }, feedbackVersion: 1 })
  await f.command('execution.drained', { binding: target })
  await f.reopen()
  const persisted = (await f.query({ kind: 'execution.get', executionId: recipient.executionId })).feedback
  assert.equal(persisted.length, 1); assert.equal(persisted[0].sequence, 9)
  assert.equal(persisted[0].consumptionMeaning, 'native-model-step-admission')
  await f.command('execution.drained', { binding: source })
  const resumed = (await f.command('execution.claim', { executionId: source.executionId })).result.binding
  const retry = (await f.command('execution.peerMessage', { ...args, binding: resumed })).result
  assert.equal(retry.received, true); assert.deepEqual(retry.feedback, persisted[0])
  assert.equal(retry.feedback.sourceLeaseEpoch, source.leaseEpoch, 'a retried delivery retains its original sending lease')
})

test('peer messages and live team reads enforce source identity and task scope without exposing feedback', async t => {
  const f = await fixture(t), owner = await f.task(), source = await f.execution(owner.binding, 'source')
  const initial = await f.query({ kind: 'execution.team', binding: source })
  assert.equal(initial.executions.length, 1)
  const target = await f.execution(owner.binding, 'target'), foreignOwner = await f.task('foreign'), foreign = await f.execution(foreignOwner.binding)
  const args = { binding: source, executionId: target.executionId, targetInputVersion: 1, key: 'facts', message: '只传递证据，不改变职责或授权。' }
  for (const changes of [{ targetInputVersion: 0 }, { targetInputVersion: undefined }, { key: 'x'.repeat(201) }, { message: 'x'.repeat(10001) }])
    await assert.rejects(f.command('execution.peerMessage', { ...args, ...changes }), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  await f.command('execution.peerMessage', args)
  const team = await f.query({ kind: 'execution.team', binding: source })
  assert.equal(team.taskId, 'task'); assert.equal(team.executionId, source.executionId)
  assert.deepEqual(team.executions.map(item => item.executionId), [source.executionId, target.executionId])
  assert.ok(team.executions.every(item => item.inputVersion === 1 && item.objective === 'Inspect target' && !Object.hasOwn(item, 'feedback')))
  const another = await f.execution(owner.binding, 'another')
  await assert.rejects(f.command('execution.peerMessage', { ...args, executionId: another.executionId }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
  await assert.rejects(f.command('execution.peerMessage', { ...args, executionId: foreign.executionId }), { code: 'DYNAMIC_EXECUTION_SCOPE_INVALID' })
  await assert.rejects(f.command('execution.peerMessage', { ...args, executionId: source.executionId }), { code: 'DYNAMIC_EXECUTION_SCOPE_INVALID' })
  for (const binding of [{ ...source, leaseEpoch: source.leaseEpoch + 1 }, { ...source, taskId: 'foreign' }, { ...source, inputVersion: 2 }]) {
    await assert.rejects(f.command('execution.peerMessage', { ...args, binding }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
    await assert.rejects(f.query({ kind: 'execution.team', binding }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
  }
  await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  await assert.rejects(f.command('execution.peerMessage', { ...args, key: 'late' }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await assert.rejects(f.query({ kind: 'execution.team', binding: source }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
})

test('finished peer recipients stay finished and cannot be awakened by coordination messages', async t => {
  const f = await fixture(t), owner = await f.task(), source = await f.execution(owner.binding, 'source'), target = await f.execution(owner.binding, 'target')
  await f.command('execution.result', { binding: target, output: { summary: '完成' } })
  await f.command('execution.drained', { binding: target })
  const before = await f.query({ kind: 'execution.get', executionId: target.executionId }), wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  const result = (await f.command('execution.peerMessage', { binding: source, executionId: target.executionId, targetInputVersion: 1, key: 'late', message: '请补充核查。' })).result
  assert.deepEqual(result, { received: false, executionId: target.executionId, sessionId: target.sessionId, reason: 'recipient_finished' })
  assert.deepEqual(await f.query({ kind: 'execution.get', executionId: target.executionId }), before)
  assert.deepEqual(await f.query({ kind: 'wake.list', taskId: 'task' }), wakes)
})

test('continued recipients reject stale peer goals and ignore old peer inboxes while preserving owner feedback', async t => {
  const f = await fixture(t), owner = await f.task(), source = await f.execution(owner.binding, 'source'), target = await f.execution(owner.binding, 'target')
  const args = { binding: source, executionId: target.executionId, targetInputVersion: 1, key: 'original-goal', message: '核对原候选。' }
  const peer = (await f.command('execution.peerMessage', args)).result.feedback
  await f.command('execution.feedback', { binding: owner.binding, executionId: target.executionId, messageId: 'owner-note', text: '保留原授权和操作证据。' })
  await f.command('execution.result', { binding: target, error: { code: 'transport_failed' } })
  await f.command('execution.drained', { binding: target })
  await f.command('execution.continue', { binding: owner.binding, executionId: target.executionId, key: 'next', prompt: 'Continue', input: { objective: '核对新候选' } })
  const next = (await f.command('execution.claim', { executionId: target.executionId })).result.binding
  assert.equal(next.inputVersion, 2)
  assert.deepEqual((await f.command('execution.peerMessage', args)).result.feedback, peer, 'an old key rereads its original delivery without forwarding it to the new goal')
  await assert.rejects(f.command('execution.peerMessage', { ...args, key: 'new-stale-message' }), { code: 'DYNAMIC_EXECUTION_INPUT_STALE' })
  await assert.rejects(f.command('execution.peerMessage', { ...args, targetInputVersion: 2 }), { code: 'DYNAMIC_FEEDBACK_ID_CONFLICT' })
  await assert.rejects(f.command('execution.feedbackConsumed', { binding: next, messageId: peer.id, sequence: 11 }), { code: 'DYNAMIC_FEEDBACK_PROOF_INVALID' })
  await assert.rejects(f.command('execution.result', { binding: next, output: {}, feedbackVersion: 0 }), { code: 'DYNAMIC_EXECUTION_FEEDBACK_PENDING' })
  await f.command('execution.feedbackConsumed', { binding: next, messageId: 'owner-note', sequence: 12 })
  await f.command('execution.result', { binding: next, output: {}, feedbackVersion: 1 })
  await f.command('execution.drained', { binding: next })
  await f.command('execution.result', { binding: source, output: {} })
  await f.command('execution.drained', { binding: source })
  await f.command('task.complete', { binding: owner.binding, summary: '当前目标已完成；旧轮队友消息仅保留历史。' })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'completed')
  assert.equal((await f.query({ kind: 'execution.get', executionId: target.executionId })).feedback.find(item => item.id === peer.id).consumedAt, null)
})

test('tasks admit more than ten execution identities while retries and continuation preserve their identities', async t => {
  const f = await fixture(t), owner = await f.task(), args = index => ({ binding: owner.binding, key: `member-${index}`, prompt: 'Work', input: { objective: `职责 ${index}` } })
  const executions = []
  for (let index = 0; index < 12; index++) executions.push((await f.command('execution.dispatch', args(index))).result.execution)
  assert.equal(new Set(executions.map(item => item.executionId)).size, 12)
  assert.equal(new Set(executions.map(item => item.sessionId)).size, 12)
  assert.equal((await f.command('execution.dispatch', args(11))).result.execution.executionId, executions[11].executionId)
  await assert.rejects(f.command('execution.dispatch', { ...args(11), input: { objective: '不同职责' } }), { code: 'DYNAMIC_DISPATCH_KEY_CONFLICT' })
  for (const execution of executions) {
    const binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
    await f.command('execution.result', { binding, output: { summary: '本轮职责完成' } })
    await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: '尚未排空' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
    await f.command('execution.drained', { binding })
  }
  const first = executions[0]
  const continued = (await f.command('execution.continue', { binding: owner.binding, executionId: first.executionId, key: 'next', prompt: 'Continue', input: { objective: '完成同一职责下一步' } })).result.execution
  assert.equal(continued.executionId, first.executionId); assert.equal(continued.inputVersion, 2); assert.equal(continued.sessionId, first.sessionId)
  const next = (await f.command('execution.claim', { executionId: first.executionId })).result.binding
  await f.command('execution.result', { binding: next, output: { summary: '后续职责完成' } })
  await f.command('execution.drained', { binding: next })
  await f.command('task.complete', { binding: owner.binding, summary: '完整目标已核验' })
  const before = await f.query({ kind: 'execution.list', taskId: 'task' })
  assert.equal(before.length, 12)
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'execution.list', taskId: 'task' }), before)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'completed')
})

test('timeline records activity switches, independent parallel leases and continuation gaps without duplicating stage events', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-16T00:00:00Z') })
  const f = await fixture(t), owner = await f.task(), first = await f.execution(owner.binding, '查询信息')
  t.mock.timers.tick(1000)
  const second = await f.execution(owner.binding, '修改配置')
  const args = { binding: first, summary: '查询完成，开始核对差异', evidence: ['query-proof'], sequence: 1, activity: '排查差异' }
  await f.command('execution.progressReported', args, 'activity-one')
  await f.command('execution.progressReported', args, 'activity-one')
  const firstReport = (await f.query({ kind: 'execution.get', executionId: first.executionId })).stageProgress
  assert.equal(firstReport.activity, '排查差异')
  assert.equal(firstReport.inputVersion, first.inputVersion)
  assert.equal(firstReport.leaseEpoch, first.leaseEpoch)
  t.mock.timers.tick(2000)
  await f.command('execution.result', { binding: first, output: { summary: '不可倒推的最终摘要' } })
  await f.command('execution.drained', { binding: first })
  await f.command('execution.result', { binding: second, output: {} })
  await f.command('execution.drained', { binding: second })
  t.mock.timers.tick(5000)
  await f.command('execution.continue', { binding: owner.binding, executionId: first.executionId, key: 'verify', prompt: '验证修复', input: { objective: '验证修复' } })
  const resumed = (await f.command('execution.claim', { executionId: first.executionId })).result.binding
  t.mock.timers.tick(1000)
  await f.command('execution.progressReported', { binding: resumed, summary: '开始验证', evidence: [], sequence: 1, activity: '验证修复' })
  t.mock.timers.tick(1000)
  await f.command('execution.drained', { binding: resumed })
  const executions = await f.query({ kind: 'execution.list', taskId: 'task' }), wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  const timeline = projectTaskTimeline((await f.query({ kind: 'task.get', taskId: 'task' })), executions, wakes)
  assert.equal(timeline.executions.length, 2)
  const segments = timeline.executions[0].segments
  assert.equal(segments.length, 4)
  assert.equal(segments[0].endedAt, segments[1].startedAt)
  assert.equal(Date.parse(segments[2].startedAt) - Date.parse(segments[1].endedAt), 5000)
  assert.equal(segments[3].label, '验证修复')
  assert.equal(timeline.executions[0].milestones.length, 2)
  const milestones = timeline.executions[0].milestones
  assert.deepEqual(milestones[0].evidence, ['query-proof'])
  assert.equal(milestones[0].activity, '排查差异')
  assert.equal(milestones[0].inputVersion, first.inputVersion)
  assert.equal(milestones[0].leaseEpoch, first.leaseEpoch)
  assert.equal(milestones[1].activity, '验证修复')
  assert.equal(milestones[1].inputVersion, resumed.inputVersion)
  assert.equal(milestones[1].leaseEpoch, resumed.leaseEpoch)
  assert.ok(Date.parse(timeline.executions[1].segments[0].startedAt) < Date.parse(segments[1].endedAt))
  assert.equal(timeline.executions[0].complete, true)
  assert.equal(JSON.stringify(timeline).includes('不可倒推的最终摘要'), false)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: first.executionId })).timeline.segments, executions[0].timeline.segments)
  const restoredTimeline = projectTaskTimeline(await f.query({ kind: 'task.get', taskId: 'task' }), await f.query({ kind: 'execution.list', taskId: 'task' }), await f.query({ kind: 'wake.list', taskId: 'task' }))
  assert.deepEqual(restoredTimeline.executions[0].milestones, milestones)
})

test('timeline restart leaves an unknown interval rather than inventing an end; later claims collect only observed history', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.reopen()
  const interrupted = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(interrupted.timeline.segments[0].state, 'unknown')
  assert.equal(interrupted.timeline.segments[0].endedAt, null)
  const projected = projectTaskTimeline({ taskId: 'task' }, [interrupted], [])
  assert.equal(projected.executions[0].segments.length, 0)
  assert.equal(projected.executions[0].complete, false)
  await f.command('execution.drained', { binding })
  await f.command('execution.claim', { executionId: binding.executionId })
  const resumed = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(resumed.timeline.complete, false)
  assert.equal(resumed.timeline.segments.length, 2)
  assert.equal(resumed.timeline.segments[1].state, 'running')
})

test('timeline pause/resume leaves a real gap and task completion remains an owner decision', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-16T00:00:00Z') })
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  t.mock.timers.tick(1000)
  await f.command('task.control', { taskId: 'task', control: 'paused' })
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).timeline.segments[0].state, 'running')
  t.mock.timers.tick(2000)
  await f.command('execution.drained', { binding })
  await f.command('task.drained', { binding: owner.binding })
  t.mock.timers.tick(5000)
  await f.command('task.control', { taskId: 'task', control: 'active' })
  const nextOwner = (await f.command('task.claim', { taskId: 'task', force: true })).result.binding
  await f.command('execution.continue', { binding: nextOwner, executionId: binding.executionId, key: 'resume', prompt: '继续核对', input: {} })
  const next = (await f.command('execution.claim', { executionId: binding.executionId })).result.binding
  t.mock.timers.tick(1000)
  await f.command('execution.result', { binding: next, output: {} })
  await f.command('execution.drained', { binding: next })
  const execution = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(Date.parse(execution.timeline.segments[1].startedAt) - Date.parse(execution.timeline.segments[0].endedAt), 5000)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'active')
  await f.command('task.complete', { binding: nextOwner, summary: '统筹确认' })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'completed')
})

test('human timeline uses task-owned request lifecycle times and preserves distinct terminal meanings', () => {
  const startedAt = '2026-10-16T00:00:00Z', endedAt = '2026-10-16T00:01:00Z'
  const humanRequests = [
    { requestId: 'a', status: 'answered', createdAt: startedAt, answeredAt: endedAt },
    { requestId: 'b', status: 'superseded', createdAt: startedAt, supersededAt: endedAt },
    { requestId: 'c', status: 'cancelled', createdAt: startedAt, cancelledAt: endedAt },
    { requestId: 'd', status: 'closed', createdAt: startedAt, closedAt: endedAt },
    { requestId: 'e', status: 'waiting-reply', createdAt: startedAt },
    { requestId: 'missing', status: 'answered', createdAt: startedAt },
  ]
  const result = projectTaskTimeline({ taskId: 't', humanRequests }, [{ taskId: 'other', sessionId: 'unrelated' }], [{ taskId: 'other', kind: 'execution.stage.progress', payload: { recordedAt: startedAt } }])
  assert.equal(result.executions.length, 0)
  assert.deepEqual(result.human.segments.map(segment => segment.label), ['已答复', '已失效', '已取消', '已关闭', '等待处理'])
  assert.equal(result.human.segments[4].active, true)
  assert.equal(result.human.complete, false)
  assert.equal(projectTaskTimeline({ taskId: 'empty' }, [], []).human.segments.length, 0)
  const terminal = projectTaskTimeline({ taskId: 't', status: 'completed', humanRequests: [humanRequests[4]] }, [], [])
  assert.equal(terminal.human.segments.length, 0)
  assert.equal(terminal.human.complete, false)
})

test('a specific objection after delivery reopens the original task without replaying completed execution', async t => {
  const f = await fixture(t), owner = await f.task(), executor = await f.execution(owner.binding)
  await f.command('execution.result', { binding: executor, output: { summary: '方案文件已交付，技术审核待定' } })
  await f.command('execution.drained', { binding: executor })
  await f.command('task.complete', { binding: owner.binding, summary: '方案文件已交付，技术审核待定' })
  await f.command('task.drained', { binding: owner.binding })
  const before = await f.query({ kind: 'task.get', taskId: 'task' })
  const prior = await f.query({ kind: 'execution.list', taskId: 'task' })
  // Scripted admission of a concrete objection; this does not test model intent recognition.
  await f.command('task.reopen', { taskId: 'task', request: '原方案要求手工搬运数据，这与直接上传原文件的要求冲突；请核查并修订方案。',
    expectedRequirementRevision: before.requirementRevision, expectedControlRevision: before.controlRevision })
  const after = await f.query({ kind: 'task.get', taskId: 'task' })
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.runSequence, before.runSequence + 1)
  assert.equal(after.status, 'active')
  assert.deepEqual(await f.query({ kind: 'execution.list', taskId: 'task' }), prior)
  assert.equal((await f.query({ kind: 'operation.list' })).length, 0)
  assert.equal((await f.query({ kind: 'task.list' })).length, 1)
})

for (const drainAt of ['before-review', 'during-review', 'after-review']) test(`native drain preserves a result wake consumed ${drainAt}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('task.wait', { binding: owner.binding, action: 'wait', summary: 'Wait for original execution' })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await f.command('task.drained', { binding: owner.binding })
  await f.command('execution.result', { binding, output: { summary: 'Original result' } })
  const resultId = `execution-result:${binding.executionId}:${binding.inputVersion}`
  const drainedId = `execution-drained:${binding.executionId}:${binding.inputVersion}`
  if (drainAt === 'before-review') await f.command('execution.drained', { binding })
  const review = (await f.command('task.claim', { taskId: 'task' })).result
  assert.ok(review.wakeIds.includes(resultId))
  if (drainAt === 'during-review') await f.command('execution.drained', { binding })
  await f.command('task.wait', { binding: review.binding, action: 'wait', summary: 'Result observed before native drain' })
  await f.command('wake.ack', { binding: review.binding, wakeIds: review.wakeIds })
  await f.command('task.drained', { binding: review.binding })
  if (drainAt === 'after-review') await f.command('execution.drained', { binding })
  // Different command IDs and restart must not duplicate or re-arm the drain wake.
  await f.command('execution.drained', { binding })
  await f.reopen()
  const wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  assert.equal(wakes.filter(wake => wake.id === resultId).length, 1)
  assert.equal(wakes.filter(wake => wake.id === drainedId).length, drainAt === 'before-review' ? 0 : 1)
  if (drainAt !== 'before-review') {
    const next = (await f.command('task.claim', { taskId: 'task' })).result
    assert.deepEqual(next.wakeIds, [drainedId])
    assert.equal(next.wakes[0].kind, 'execution.result')
    assert.equal(next.wakes[0].payload.drained, true)
    assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).drained, true)
    await f.command('wake.ack', { binding: next.binding, wakeIds: next.wakeIds })
    await f.command('execution.drained', { binding })
    assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).find(wake => wake.id === drainedId).state, 'acked')
  }
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'active', 'drain cannot complete the task or replay an execution')
  assert.equal((await f.query({ kind: 'execution.list', taskId: 'task' })).length, 1)
})

for (const invalidated of ['cancelled', 'stale']) test(`native drain cannot wake an Owner for a ${invalidated} result`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.result', { binding, output: {} })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await f.command('task.drained', { binding: owner.binding })
  await f.command('task.claim', { taskId: 'task' })
  if (invalidated === 'cancelled') await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  else await f.command('task.revise', { taskId: 'task', request: 'Changed objective' })
  await f.command('execution.drained', { binding })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).some(wake => wake.id === `execution-drained:${binding.executionId}:${binding.inputVersion}`), false)
})

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dynamic-task-ledger-'))
  const config = { dbPath: join(root, 'dynamic.sqlite'), instanceId: 'fixture', initialize: true, ...options }
  let store = await openDynamicTaskStore(config), sequence = 0
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const command = (kind, args, id = `command-${++sequence}`) => store.command({ id, kind, args })
  const query = args => store.query(args)
  async function task(taskId = 'task') {
    await command('task.create', { taskId, request: 'Deliver the requested outcome' })
    return (await command('task.claim', { taskId })).result
  }
  async function execution(binding, key = 'inspect') {
    const value = (await command('execution.dispatch', { binding, key, prompt: 'Inspect target', input: { objective: 'Inspect target' } })).result.execution
    return (await command('execution.claim', { executionId: value.executionId })).result.binding
  }
  return { root, config, command, query, task, execution, async reopen() { await store.close(); store = await openDynamicTaskStore({ ...config, initialize: false }); return store } }
}

test('every coordinator decision retains its explanation across replacement, retry, completion and restart', async t => {
  const f = await fixture(t), owner = await f.task()
  const first = { binding: owner.binding, action: 'wait', summary: '首次发现对象偏离，已要求原执行回到目标文件', evidence: ['log:12'], limitations: ['尚未确认反馈落实'] }
  await f.command('task.wait', first, 'review-first')
  const firstPage = await f.query({ kind: 'task.decisions', taskId: 'task', limit: 1 })
  assert.equal(firstPage.decisions[0].decision.summary, first.summary)
  assert.equal(firstPage.decisions[0].sessionId, owner.binding.sessionId)
  assert.equal(firstPage.decisions[0].triggers[0].wakeId, owner.wakeIds[0])
  assert.equal((await f.command('task.wait', first, 'review-first')).replayed, true)
  await assert.rejects(f.command('task.wait', { ...first, summary: '覆盖历史' }, 'review-first'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await f.command('task.wait', { ...first, summary: '已核对目标文件，继续等待最终结果', evidence: ['log:22'] }, 'review-second')
  const page = await f.query({ kind: 'task.decisions', taskId: 'task', limit: 1 })
  assert.equal(page.decisions[0].id, 'review-second')
  assert.ok(page.nextBefore)
  const other = await f.task('other')
  await f.command('task.wait', { binding: other.binding, action: 'wait', summary: '其他任务' })
  await f.command('task.complete', { binding: owner.binding, summary: '完整目标已核验', result: { action: 'complete', summary: '完整目标已核验', evidence: ['final:30'], limitations: ['未部署'] } }, 'review-complete')
  const older = await f.query({ kind: 'task.decisions', taskId: 'task', before: page.nextBefore, limit: 1 })
  assert.deepEqual(older.decisions, firstPage.decisions, 'newer inserts cannot shift cursor pagination or replace a decision')
  assert.equal(older.nextBefore, null)
  const beforeRestart = await f.query({ kind: 'task.decisions', taskId: 'task' })
  assert.deepEqual(beforeRestart.decisions.map(x => x.id), ['review-complete', 'review-second', 'review-first'])
  assert.deepEqual(beforeRestart.decisions[0].decision.limitations, ['未部署'])
  assert.deepEqual(beforeRestart.decisions[2].decision.evidence, ['log:12'])
  await f.reopen()
  assert.deepEqual(await f.query({ kind: 'task.decisions', taskId: 'task' }), beforeRestart)
  for (const args of [{ limit: 0 }, { limit: 101 }, { before: -1 }, { before: 1.5 }])
    await assert.rejects(f.query({ kind: 'task.decisions', taskId: 'task', ...args }), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  await assert.rejects(f.query({ kind: 'task.decisions', taskId: 'missing' }), { code: 'DYNAMIC_NOT_FOUND' })
})

test('human-wait decisions preserve evidence and progress wake identity without changing human wait', async t => {
  const f = await fixture(t), owner = await f.task()
  await f.command('task.wake', { taskId: 'task', kind: 'execution.progress.review', payload: { executionId: 'original-execution', inputVersion: 2, leaseEpoch: 3, lastSequence: 42 } })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await f.command('task.drained', { binding: owner.binding })
  const next = (await f.command('task.claim', { taskId: 'task' })).result
  await f.command('task.wait', { binding: next.binding, action: 'blocked', summary: '缺少必要业务信息', question: '需要哪一个版本？', evidence: ['source:4'], limitations: ['不能自行选版本'],
    humanRequest: { requestId: 'question', audience: 'requester', reason: '两个有效版本', attemptedActions: ['已核对来源'] } })
  const page = await f.query({ kind: 'task.decisions', taskId: 'task' })
  assert.equal(page.decisions.length, 1)
  assert.deepEqual(page.decisions[0].triggers, [{ wakeId: next.wakeIds[0], kind: 'execution.progress.review', executionId: 'original-execution', inputVersion: 2, leaseEpoch: 3, lastSequence: 42 }])
  assert.deepEqual(page.decisions[0].decision.evidence, ['source:4'])
  assert.equal(page.decisions[0].decision.question, '需要哪一个版本？')
  assert.equal(page.decisions[0].decision.audience, 'requester')
  assert.deepEqual(page.decisions[0].decision.attemptedActions, ['已核对来源'])
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).humanRequests[0].status, 'waiting-reply')
})

test('a failed decision receipt rolls back both latest state and history, then retries exactly once', async t => {
  const f = await fixture(t), owner = await f.task()
  await f.command('task.wait', { binding: owner.binding, action: 'wait', summary: '原判断保留' }, 'original-decision')
  const before = await f.query({ kind: 'task.decisions', taskId: 'task' })
  const db = new DatabaseSync(f.config.dbPath)
  try {
    db.exec("CREATE TRIGGER fail_decision_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='failed-decision' BEGIN SELECT RAISE(ABORT,'injected decision receipt failure'); END")
    const args = { binding: owner.binding, action: 'wait', summary: '下一轮判断' }
    await assert.rejects(f.command('task.wait', args, 'failed-decision'), /injected decision receipt failure/)
    assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).lastDecision.summary, '原判断保留')
    assert.deepEqual(await f.query({ kind: 'task.decisions', taskId: 'task' }), before)
    db.exec('DROP TRIGGER fail_decision_receipt')
    await f.command('task.wait', args, 'failed-decision')
    await f.command('task.wait', args, 'failed-decision')
    assert.equal((await f.query({ kind: 'task.decisions', taskId: 'task' })).decisions.length, 2)
  } finally { db.close() }
})

test('task dialogue persists idempotently without broadcasting text and serializes on the original owner lease', async t => {
  const f = await fixture(t, { webActorId: 'web-user' }), owner = await f.task(), execution = await f.execution(owner.binding)
  const args = { taskId: 'task', requestId: 'one', actorId: 'web-user', text: '现在进度怎样？' }
  const sent = await f.command('task.dialogue.add', args)
  assert.equal(sent.result.message.reply, null)
  await f.command('task.dialogue.add', args)
  await assert.rejects(f.command('task.dialogue.add', { ...args, text: 'different' }), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await assert.rejects(f.command('task.dialogue.add', { ...args, actorId: 'spoof' }), { code: 'TASK_SESSION_WEB_ACTOR_REQUIRED' })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: '旧结论' }), { code: 'DYNAMIC_TASK_DIALOGUE_PENDING' })
  assert.equal((await f.query({ kind: 'execution.get', executionId: execution.executionId })).feedback, undefined)
  await f.command('task.wait', { binding: owner.binding, summary: '等待', action: 'wait' })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await f.command('task.drained', { binding: owner.binding })
  await f.command('task.wake', { taskId: 'task', kind: 'normal-work' })
  const claimed = (await f.command('task.claim', { taskId: 'task', dialogue: true })).result
  assert.equal(claimed.binding.sessionId, owner.binding.sessionId)
  assert.equal(claimed.binding.requirementRevision, owner.binding.requirementRevision)
  assert.deepEqual(claimed.wakes.map(wake => wake.kind), ['task.dialogue'])
  await assert.rejects(f.command('task.claim', { taskId: 'task', dialogue: true }), { code: 'DYNAMIC_TASK_BUSY' })
  await f.command('task.dialogue.add', { ...args, requestId: 'two', text: '目标变化是否需要先澄清？' })
  await f.command('task.dialogue.reply', { binding: claimed.binding, messageId: 'one', reply: '原执行尚在处理，未完成。' })
  assert.ok((await f.query({ kind: 'wake.list', taskId: 'task' })).some(item => item.kind === 'normal-work' && item.state === 'pending'))
  await f.command('task.drained', { binding: claimed.binding })
  await f.reopen()
  const restored = await f.query({ kind: 'task.get', taskId: 'task' })
  assert.equal(restored.dialogue.length, 2)
  assert.match(restored.dialogue[0].reply, /未完成/)
  assert.equal(restored.dialogue[1].reply, null)
  assert.equal(restored.sessionId, owner.binding.sessionId)
  const next = (await f.command('task.claim', { taskId: 'task', dialogue: true })).result
  assert.equal(next.wakes[0].payload.messageId, 'two')
  await assert.rejects(f.command('task.dialogue.reply', { binding: owner.binding, messageId: 'two', reply: '旧租约冒充回复' }), { code: 'DYNAMIC_TASK_LEASE_STALE' })
  await assert.rejects(f.command('task.dialogue.reply', { binding: next.binding, messageId: 'one', reply: '重复处理已回复消息' }), { code: 'DYNAMIC_WAKE_CLAIM_STALE' })
})

test('legacy persisted English names remain stable across continuation and reopen; no implicit migration',async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding,'legacy-check')
 await f.command('execution.result',{binding,output:{done:true}})
 await f.command('execution.drained',{binding})
 // Emulate a record written by the previously deployed naming policy, in this isolated fixture only.
 const db=new DatabaseSync(f.config.dbPath)
 db.prepare("UPDATE dynamic_executions SET body=json_set(body,'$.title',?) WHERE id=?").run('legacy-check',binding.executionId);db.close()
 await f.command('execution.continue',{binding:owner.binding,executionId:binding.executionId,key:'next',prompt:'Continue',input:{title:'新的中文建议',objective:'Verify API'}})
 assert.equal((await f.query({kind:'execution.get',executionId:binding.executionId})).title,'legacy-check')
 await f.reopen()
 assert.equal((await f.query({kind:'execution.get',executionId:binding.executionId})).title,'legacy-check')
})


test('nonterminal stage reports persist and wake once without completing the execution', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { binding, summary: '已定位差异，正在验证修复边界。', evidence: ['fixture-proof'], sequence: 1 }
  const first = await f.command('execution.progressReported', args, 'stage-report-one')
  assert.equal((await f.command('execution.progressReported', args, 'stage-report-one')).replayed, true)
  const execution = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(execution.status, 'running'); assert.equal(execution.drained, false); assert.equal(execution.result, undefined)
  assert.equal(execution.stageProgress.summary, args.summary)
  const wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  assert.equal(wakes.filter(item => item.kind === 'execution.stage.progress').length, 1)
  assert.equal(wakes.find(item => item.id === first.result.wakeId).payload.inputVersion, binding.inputVersion)
  await assert.rejects(f.command('execution.progressReported', { ...args, summary: 'late' }), { code: 'DYNAMIC_EXECUTION_PROGRESS_STALE' })
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress.summary, args.summary)
})

test('stage plan is optional, validates before writing and persists across reports and restart in one input round', async t => {
  const f = await fixture(t), owner = await f.task()
  let binding = await f.execution(owner.binding)
  const report = (sequence, fields = {}) => f.command('execution.progressReported', { binding, summary: '核对当前证据', evidence: [], sequence, ...fields })
  await report(1)
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress.plan, undefined)
  for (const plan of ['', '   ', 123, ['读取证据'], 'a'.repeat(4001)]) await assert.rejects(report(2, { plan }), { code: 'DYNAMIC_EXECUTION_PROGRESS_INVALID' })
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress.sequence, 1)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.stage.progress').length, 1)
  const plan = '1. 只读冻结候选\n2. 核对两个原始断言'
  await report(2, { plan: `  ${plan}  ` })
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress.plan, plan)
  await f.command('execution.drained', { binding })
  binding = (await f.command('execution.claim', { executionId: binding.executionId })).result.binding
  assert.equal(binding.inputVersion, 1, '同输入的恢复 claim 不产生新计划轮次')
  const retained = await report(3, { activity: '核对断言' })
  assert.equal(retained.result.execution.stageProgress.plan, plan)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).find(item => item.wakeId === retained.result.wakeId).payload.plan, plan)
  await report(4, { plan: '新增证据冲突；先核对同一候选版本。' })
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress.plan, '新增证据冲突；先核对同一候选版本。')
})

test('stage reports reject forged input/lease, superseded requirements and cancellation', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const report = changes => f.command('execution.progressReported', { binding, summary: '阶段事实', evidence: [], sequence: 1, ...changes })
  for (const changes of [{ leaseEpoch: binding.leaseEpoch + 1 }, { inputVersion: binding.inputVersion + 1 }, { taskId: 'other' }]) {
    await assert.rejects(report({ binding: { ...binding, ...changes } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
  }
  await f.command('task.revise', { taskId: 'task', expectedRequirementRevision: 1, request: '新要求' })
  await assert.rejects(report({}), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await f.command('task.control', { taskId: 'task', control: 'cancelled', expectedControlRevision: 1 })
  await assert.rejects(report({}), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.stage.progress').length, 0)
})

test('stage reporting after continuation accepts only the new input and lease', async t => {
  const f = await fixture(t), owner = await f.task(), old = await f.execution(owner.binding)
  await f.command('execution.progressReported', { binding: old, summary: '原回合阶段证据', evidence: [], sequence: 1, plan: '原回合只读核对' })
  await f.command('execution.result', { binding: old, output: { summary: '原回合结果' } })
  await f.command('execution.drained', { binding: old })
  await f.command('execution.continue', { binding: owner.binding, executionId: old.executionId, key: 'next', prompt: '继续验证', input: { objective: '继续验证' } })
  const binding = (await f.command('execution.claim', { executionId: old.executionId })).result.binding
  const continued = await f.query({ kind: 'execution.get', executionId: old.executionId })
  assert.equal(continued.stageProgress.inputVersion, old.inputVersion, '续办保留原报告的真实轮次，不冒充本轮成果')
  assert.equal(continued.stageProgress.leaseEpoch, old.leaseEpoch)
  assert.equal(continued.stageProgress.plan, '原回合只读核对', '原计划只随原报告保留，尚未变成本轮计划')
  assert.notEqual(continued.stageProgress.inputVersion, continued.inputVersion)
  assert.notEqual(continued.stageProgress.leaseEpoch, continued.leaseEpoch)
  await assert.rejects(f.command('execution.progressReported', { binding: old, summary: '延迟旧报告', evidence: [], sequence: 2 }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
  await f.command('execution.progressReported', { binding, summary: '新回合证据', evidence: [], sequence: 1 })
  const freshStage = (await f.query({ kind: 'execution.get', executionId: binding.executionId })).stageProgress
  assert.equal(freshStage.inputVersion, binding.inputVersion)
  assert.equal(freshStage.plan, undefined, '新输入轮次首次省略计划不能自动继承旧计划')
})

test('active blockers never re-inject recursive execution inputs or historical results', async t => {
  const f = await fixture(t), owner = await f.task()
  const raw = { objective: 'Current goal', previousExecutions: [{ input: { previousExecutions: [{ secret: 'recursive-input' }] } }], context: 'large-context'.repeat(2000) }
  const execution = (await f.command('execution.dispatch', { binding: owner.binding, key: 'blocker', prompt: 'Inspect', input: raw })).result.execution
  const blockers = await f.query({ kind: 'task.blockers', taskId: 'task' })
  assert.equal(blockers.executions.length, 1)
  assert.equal(blockers.executions[0].executionId, execution.executionId)
  assert.equal(blockers.executions[0].input.objective, raw.objective)
  assert.equal(blockers.executions[0].input.previousExecutions, undefined)
  assert.equal(blockers.executions[0].input.context, undefined)
  assert.equal(blockers.executions[0].results, undefined)
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: execution.executionId })).input, raw, 'ledger remains lossless')
  t.diagnostic(JSON.stringify({ scope: 'owner active blocker executions, UTF-8 JSON bytes', beforeBytes: Buffer.byteLength(JSON.stringify([execution])), afterBytes: Buffer.byteLength(JSON.stringify(blockers.executions)) }))
})

test('continued and recovering blockers keep current result and unknown operation evidence without recursive history', async t => {
  const f = await fixture(t), owner = await f.task()
  let execution, binding
  for (let version = 1; version <= 5; version++) {
    const args = { binding: owner.binding, key: 'version-' + version, prompt: 'goal', input: { objective: 'goal-' + version,
      previousExecutions: execution ? [execution] : [], context: 'old-input'.repeat(1000), recoveryReadOnly: true, readbackOperationId: 'unresolved' } }
    execution = (await f.command(version === 1 ? 'execution.dispatch' : 'execution.continue', { ...args, ...(execution ? { executionId: execution.executionId } : {}) })).result.execution
    binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
    await f.command('execution.result', { binding, output: { evidence: ['UNKNOWN_EFFECT: never replay'], version } })
    const [blocker] = (await f.query({ kind: 'task.blockers', taskId: 'task' })).executions
    assert.equal(blocker.result.payload.output.version, version)
    assert.equal(blocker.input.previousExecutions, undefined); assert.equal(blocker.results, undefined)
    assert.equal(blocker.input.recoveryReadOnly, true); assert.equal(blocker.input.readbackOperationId, 'unresolved')
    assert.match(JSON.stringify(blocker.result), /UNKNOWN_EFFECT/)
    if (version < 5) await f.command('execution.drained', { binding })
    execution = await f.query({ kind: 'execution.get', executionId: execution.executionId })
  }
  assert.equal(execution.results.length, 4, 'all historical results remain in ledger')
  const other = await f.execution(owner.binding, 'uncertain-write')
  const operation = (await f.command('operation.prepare', { binding: other, key: 'write', definition: { tool: 'write', input: { boundary: 'UNKNOWN_EFFECT: verify original target' } }, resourceKeys: ['restricted-target'] })).result.operation
  await f.command('operation.start', { binding: other, operationId: operation.operationId })
  await f.reopen()
  const blockers = await f.query({ kind: 'task.blockers', taskId: 'task' })
  const blocker = blockers.executions.find(item => item.executionId === execution.executionId)
  assert.equal(blocker.recovering, true)
  assert.equal(blocker.result.payload.output.version, 5)
  assert.equal(blocker.input.previousExecutions, undefined)
  assert.equal(blockers.operations[0].state, 'unknown')
  assert.deepEqual(blockers.operations[0].definition, operation.definition)
  assert.deepEqual(blockers.operations[0].resourceKeys, ['restricted-target'])
})

test('dispatch is durable and idempotent; execution IDs are independent and owner claims are single flight', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'one'), b = await f.execution(owner.binding, 'two')
  assert.notEqual(a.executionId, b.executionId)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.ok(!Object.hasOwn(a, 'runId'))
  await assert.rejects(f.command('execution.claim', { executionId: a.executionId }), { code: 'DYNAMIC_EXECUTION_BUSY' })
  await assert.rejects(f.command('task.claim', { taskId: 'task' }), { code: 'DYNAMIC_TASK_BUSY' })
  const args = { binding: owner.binding, key: 'same', prompt: 'stable', input: {} }
  const first = await f.command('execution.dispatch', args, 'stable-command')
  assert.deepEqual((await f.command('execution.dispatch', args, 'stable-command')).result, first.result)
  assert.equal((await f.command('execution.dispatch', args, 'stable-command')).dispatchEligible, false)
  assert.equal((await f.command('execution.dispatch', args)).result.execution.executionId, first.result.execution.executionId)
  await assert.rejects(f.command('execution.dispatch', { ...args, input: { changed: true } }), { code: 'DYNAMIC_DISPATCH_KEY_CONFLICT' })
  await assert.rejects(f.command('execution.dispatch', { ...args, prompt: 'changed' }, 'stable-command'), { code: 'DYNAMIC_COMMAND_ID_CONFLICT' })
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: a.executionId })).recovering, true)
  assert.equal((await f.query({ kind: 'recovery.pending' })).executions.length, 3)
})

test('a late result is audited and wakes atomically without accepting an obsolete requirement', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('task.revise', { taskId: 'task', expectedRequirementRevision: 1, request: 'New requirement' })
  const result = await f.command('execution.result', { binding, output: { answer: 'old result' } })
  assert.equal(result.result.current, false)
  assert.equal(result.result.execution.status, 'stale')
  const wakes = await f.query({ kind: 'wake.list', taskId: 'task' })
  assert.equal(wakes.filter(item => item.kind === 'execution.result').length, 1)
  await f.command('execution.result', { binding, output: { answer: 'old result' } })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.state === 'pending').length, 2)
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result.payload.output.answer, 'old result')
})

test('cancel fences tools immediately and completion waits for physical drain and unresolved operations', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.result', { binding, output: { done: true } })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
  await f.command('execution.drained', { binding })
  await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  assert.equal(await f.query({ kind: 'execution.current', binding }), false)
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
  await assert.rejects(f.command('task.control', { taskId: 'task', control: 'active' }), { code: 'DYNAMIC_TASK_TERMINAL' })
})

test('continuation retains execution/session identity and versions inputs across requirement revisions', async t => {
  const f = await fixture(t), owner = await f.task(), first = await f.execution(owner.binding)
  await f.command('execution.result', { binding: first, output: { version: 1 } })
  await f.command('execution.drained', { binding: first })
  await f.command('task.revise', { taskId: 'task', request: 'Continue with new requirement' })
  await f.command('task.drained', { binding: owner.binding })
  const nextOwner = (await f.command('task.claim', { taskId: 'task' })).result
  await f.command('execution.continue', { binding: nextOwner.binding, executionId: first.executionId, key: 'next', prompt: 'Second goal', input: { objective: 'Second goal' } })
  const next = (await f.command('execution.claim', { executionId: first.executionId })).result.binding
  assert.equal((await f.query({ kind: 'execution.get', executionId: first.executionId })).title, 'inspect')
  await f.reopen()
  assert.equal((await f.query({ kind: 'execution.get', executionId: first.executionId })).title, 'inspect')
  assert.equal(next.sessionId, first.sessionId)
  assert.equal(next.inputVersion, 2)
  assert.equal(next.requirementRevision, 2)
  assert.equal(next.inputHistory[0].inputDigest, first.inputDigest)
  await assert.rejects(f.command('execution.result', { binding: first, output: { late: true } }), { code: 'DYNAMIC_EXECUTION_LEASE_STALE' })
})

test('generic operations persist before dispatch, unknown never replays, locks survive restart and reconciliation releases them', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'one'), b = await f.execution(owner.binding, 'two')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key, definition: { tool: 'write', input: 'same' }, resourceKeys: ['repo:main'] })).result.operation
  const first = await prepare(a, 'write-a'), second = await prepare(b, 'write-b')
  assert.equal((await f.command('operation.start', { binding: a, operationId: first.operationId }, 'start-a')).dispatchEligible, true)
  assert.equal((await f.command('operation.start', { binding: a, operationId: first.operationId }, 'start-a')).dispatchEligible, false)
  await assert.rejects(f.command('operation.start', { binding: b, operationId: second.operationId }), { code: 'DYNAMIC_RESOURCE_BUSY' })
  await f.reopen()
  assert.equal((await f.query({ kind: 'operation.get', operationId: first.operationId })).state, 'unknown')
  await assert.rejects(f.command('operation.start', { binding: a, operationId: first.operationId }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await assert.rejects(f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'succeeded', result: {} }), { code: 'DYNAMIC_OPERATION_RECONCILIATION_REQUIRED' })
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { receipt: 'confirmed' }, evidenceRef: 'proof/external-receipt' })
  assert.equal((await f.query({ kind: 'resource.list' })).length, 0)
  await f.command('execution.drained', { binding: b })
  const resumed = (await f.command('execution.claim', { executionId: b.executionId })).result.binding
  assert.equal((await f.command('operation.start', { binding: resumed, operationId: second.operationId })).dispatchEligible, true)
})

test('current execution consumes ordinary success and failure receipts; only stage and final results wake its coordinator', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('wake.ack', { binding: owner.binding, wakeIds: owner.wakeIds })
  await f.command('task.drained', { binding: owner.binding })
  for (const state of ['succeeded', 'failed']) {
    const { operation } = (await f.command('operation.prepare', { binding, key: state, definition: { toolName: 'arbitrary_native_capability' }, resourceKeys: ['fixture-resource'] })).result
    await f.command('operation.start', { binding, operationId: operation.operationId })
    const args = { binding, operationId: operation.operationId, state, result: { receipt: state } }
    await f.command('operation.settle', args, `settle-${state}`)
    await f.command('operation.settle', args, `settle-${state}`)
    assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, state)
    assert.equal((await f.query({ kind: 'resource.list' })).length, 0)
  }
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task', state: 'pending' })).length, 0)
  await assert.rejects(f.command('task.claim', { taskId: 'task' }), { code: 'DYNAMIC_TASK_NO_WAKE' })
  await f.command('execution.progressReported', { binding, sequence: 1, summary: '阶段核验已完成，继续处理后续项。', evidence: ['original-tool-receipts'] }, 'stage-boundary')
  const stage = (await f.command('task.claim', { taskId: 'task' })).result
  assert.deepEqual(stage.wakes.map(item => item.kind), ['execution.stage.progress'])
  await f.command('wake.ack', { binding: stage.binding, wakeIds: stage.wakeIds })
  await f.command('task.drained', { binding: stage.binding })
  const result = { binding, output: { summary: '阶段及最终证据已核实' } }
  await f.command('execution.result', result, 'final-result')
  await f.command('execution.drained', { binding })
  await f.command('execution.result', result, 'final-result')
  const final = (await f.command('task.claim', { taskId: 'task' })).result
  assert.deepEqual(final.wakes.map(item => item.kind), ['execution.result'])
  assert.equal(final.task.sessionId, owner.task.sessionId)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).some(item => item.kind === 'operation.result'), false)
})

test('unknown, cancellation, reconciliation and independently owned operation results retain causal wakes', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const start = async (scope, key) => {
    const operation = (await f.command('operation.prepare', { binding: scope, key, definition: { toolName: 'arbitrary_native_capability' }, resourceKeys: [] })).result.operation
    await f.command('operation.start', { binding: scope, operationId: operation.operationId })
    return operation.operationId
  }
  const unknown = await start(binding, 'uncertain')
  await f.command('operation.settle', { binding, operationId: unknown, state: 'unknown', result: { receiptLost: true } }, 'uncertain-result')
  const cancelled = await start(binding, 'cancelled')
  await f.command('operation.settle', { binding, operationId: cancelled, state: 'cancelled' }, 'cancelled-result')
  const independent = await start(owner.binding, 'independent')
  await f.command('operation.settle', { binding: owner.binding, operationId: independent, state: 'succeeded' }, 'independent-result')
  await f.command('operation.reconcile', { operationId: unknown, state: 'failed', result: { observed: true }, evidenceRef: 'original-receipt' }, 'reconciled-result')
  const operationWakes = (await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'operation.result')
  assert.deepEqual(operationWakes.map(item => [item.payload.operationId, item.payload.state]), [[unknown, 'unknown'], [cancelled, 'cancelled'], [independent, 'succeeded'], [unknown, 'failed']])
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'operation.result'), operationWakes)
})

for (const boundary of ['drained', 'terminal', 'revised', 'cancelled', 'continued']) test(`late operation result still wakes after its original consumer is ${boundary}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding, key: 'late', definition: { toolName: 'arbitrary_native_capability' }, resourceKeys: [] })).result.operation
  await f.command('operation.start', { binding, operationId: operation.operationId })
  if (boundary === 'drained' || boundary === 'continued') await f.command('execution.drained', { binding })
  if (boundary === 'terminal') await f.command('execution.result', { binding, output: { summary: '结果已提交' } })
  if (boundary === 'revised') await f.command('task.revise', { taskId: 'task', request: 'Changed requirement' })
  if (boundary === 'cancelled') await f.command('execution.cancel', { binding })
  if (boundary === 'continued') {
    await f.command('execution.continue', { binding: owner.binding, executionId: binding.executionId, key: 'readback', prompt: 'Read back original operation', input: { objective: 'Inspect' }, definition: { recoveryReadOnly: true } })
    const next = (await f.command('execution.claim', { executionId: binding.executionId })).result.binding
    assert.equal(next.sessionId, binding.sessionId)
    assert.equal(next.inputVersion, binding.inputVersion + 1)
    assert.equal(next.leaseEpoch, binding.leaseEpoch + 1)
  }
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'succeeded', result: { originalReceipt: true } }, 'late-result')
  const resultWakes = (await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'operation.result')
  assert.equal(resultWakes.length, 1)
  assert.equal(resultWakes[0].payload.operationId, operation.operationId)
  assert.deepEqual((await f.query({ kind: 'operation.get', operationId: operation.operationId })).dispatchBinding, binding)
})

test('restart after a consumed tool receipt preserves its identity and recovers through one terminal execution wake', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding, key: 'original', definition: { toolName: 'arbitrary_native_capability' }, resourceKeys: ['fixture-resource'] })).result.operation
  await f.command('operation.start', { binding, operationId: operation.operationId }, 'original-start')
  const settled = await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'succeeded', result: { originalReceipt: true } }, 'original-settle')
  await f.reopen()
  assert.equal((await f.query({ kind: 'recovery.pending' })).executions[0].executionId, binding.executionId)
  assert.deepEqual(await f.query({ kind: 'operation.get', operationId: operation.operationId }), settled.result.operation)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).some(item => item.kind === 'operation.result'), false)
  await f.command('execution.drained', { binding })
  const resumed = (await f.command('execution.claim', { executionId: binding.executionId })).result.binding
  assert.equal(resumed.sessionId, binding.sessionId)
  assert.equal(resumed.inputVersion, binding.inputVersion)
  assert.equal((await f.command('operation.start', { binding, operationId: operation.operationId }, 'original-start')).dispatchEligible, false)
  const result = { binding: resumed, output: { summary: '使用原持久回执完成恢复' } }
  await f.command('execution.result', result, 'recovered-result')
  await f.reopen()
  await f.command('execution.result', result, 'recovered-result')
  const wakes = (await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result')
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].payload.executionId, binding.executionId)
})

test('business completion creates a unique notification atomically; uncertain delivery does not restart business or resend', async t => {
  const f = await fixture(t), owner = await f.task()
  const done = await f.command('task.complete', { binding: owner.binding, summary: 'Verified done', notification: { destination: 'group-1', text: 'Done' } }, 'complete')
  assert.equal(done.result.task.status, 'completed')
  const notificationId = done.result.notification.notificationId
  const started = await f.command('notification.start', { notificationId })
  assert.equal(started.dispatchEligible, true)
  await f.reopen()
  assert.equal((await f.query({ kind: 'notification.get', notificationId })).state, 'unknown')
  assert.equal((await f.command('notification.start', { notificationId })).dispatchEligible, false)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).status, 'completed')
  await f.command('notification.reconcile', { notificationId, state: 'delivered', evidenceRef: 'proof/notification', receipt: { messageId: 'actual' } })
  assert.equal((await f.query({ kind: 'notification.list' })).length, 1)
})

test('notification timing separates acknowledgement from verified delivery and freezes both facts', async t => {
  const f = await fixture(t), owner = await f.task()
  const done = await f.command('task.complete', { binding: owner.binding, summary: 'done', notification: { destination: 'g', text: 'done' } })
  const notificationId = done.result.notification.notificationId
  const start = (await f.command('notification.start', { notificationId })).result.notification
  await f.command('notification.ack', { notificationId, dispatchToken: start.dispatchToken, ack: { messageId: 'ack' } })
  const acknowledged = await f.query({ kind: 'notification.get', notificationId })
  assert.match(acknowledged.ackedAt, /^20/)
  assert.equal(acknowledged.deliveredAt, undefined)
  await f.command('notification.receipt', { notificationId, dispatchToken: start.dispatchToken, phase: 'readback', state: 'unknown' })
  await f.command('notification.diagnostic', { notificationId, nextAttemptAt: '2099-01-01T00:00:00Z' })
  assert.equal((await f.query({ kind: 'notification.get', notificationId })).ackedAt, acknowledged.ackedAt)
  await f.command('notification.reconcile', { notificationId, state: 'delivered', evidenceRef: 'proof', receipt: { messageId: 'verified' } })
  const delivered = await f.query({ kind: 'notification.get', notificationId })
  assert.match(delivered.deliveredAt, /^20/)
  await f.command('notification.reconcile', { notificationId, state: 'delivered', evidenceRef: 'same-proof' })
  assert.equal((await f.query({ kind: 'notification.get', notificationId })).deliveredAt, delivered.deliveredAt)
  assert.equal((await f.query({ kind: 'notification.get', notificationId })).ackedAt, acknowledged.ackedAt)
})

test('message stages retain observed intervals, interrupted opens and shared identity without content across restart', async t => {
  const f = await fixture(t)
  for (const sourceId of ['first', 'second']) await f.command('source.record', { sourceId, groupId: 'g', messageId: sourceId, actorId: 'a', text: 'private' })
  const stage = { spanId: 'shared-turn', stage: 'turn', requestId: 'decision', sessionId: 'session', attempt: 0,
    startedAt: '2026-10-26T01:00:00.000Z', completedAt: null, shared: true, text: 'secret', token: 'secret' }
  const receipt = await f.command('source.stage', { sourceId: 'first', stage })
  assert.equal(receipt.result.source, undefined)
  assert.equal(JSON.stringify(receipt).includes('secret'), false)
  assert.equal(JSON.stringify(receipt).includes('private'), false)
  const open = (await f.query({ kind: 'source.get', sourceId: 'first' })).stages[0]
  assert.equal(open.quality, 'open')
  assert.equal(open.text, undefined)
  assert.equal(open.token, undefined)
  await f.reopen()
  assert.equal((await f.query({ kind: 'source.get', sourceId: 'first' })).stages[0].completedAt, null)
  const finished = { ...stage, completedAt: '2026-10-26T01:00:01.000Z' }
  for (const sourceId of ['first', 'second']) await f.command('source.stage', { sourceId, stage: finished })
  await f.command('source.stage', { sourceId: 'first', stage: finished })
  const saved = (await f.query({ kind: 'source.get', sourceId: 'first' })).stages
  assert.equal(saved.length, 1)
  assert.equal(saved[0].quality, 'observed')
  assert.equal(saved[0].spanId, (await f.query({ kind: 'source.get', sourceId: 'second' })).stages[0].spanId)
  await assert.rejects(f.command('source.stage', { sourceId: 'first', stage: { ...finished, completedAt: '2026-10-26T02:00:00Z' } }), { code: 'DYNAMIC_SOURCE_STAGE_CONFLICT' })
  await assert.rejects(f.command('source.stage', { sourceId: 'first', stage: { ...finished, spanId: 'invalid', startedAt: 'not-a-time' } }), { code: 'DYNAMIC_SOURCE_STAGE_INVALID' })
  const negative = { ...finished, spanId: 'clock-reversed', completedAt: '2026-10-26T00:59:59.000Z' }
  await f.command('source.stage', { sourceId: 'first', stage: { ...negative, completedAt: null } })
  assert.equal((await f.query({ kind: 'source.get', sourceId: 'first' })).stages.find(item => item.spanId === negative.spanId).quality, 'open')
  await f.command('source.stage', { sourceId: 'first', stage: negative })
  await f.reopen()
  const anomaly = (await f.query({ kind: 'source.get', sourceId: 'first' })).stages.find(item => item.spanId === negative.spanId)
  assert.equal(anomaly.quality, 'negative')
  assert.equal(anomaly.startedAt, negative.startedAt)
  assert.equal(anomaly.completedAt, negative.completedAt)

})

test('source timing preserves first received and routed facts across idempotent replay', async t => {
  const f = await fixture(t)
  const args = { sourceId: 'timed-source', groupId: 'timed-group', messageId: 'timed-message', actorId: 'timed-user', text: 'timed',
    receivedAt: '2026-10-26T01:00:00.000Z' }
  await f.command('source.record', args, 'timed-record')
  await f.command('source.record', { ...args, receivedAt: '2026-10-26T02:00:00.000Z' }, 'timed-replay')
  const before = (await f.query({ kind: 'source.get', sourceId: args.sourceId }))
  assert.equal(before.receivedAt, args.receivedAt)
  assert.equal(before.routedAt, undefined)
  await f.command('source.routed', { sourceId: args.sourceId, receipt: { routeId: 'timed-route' } }, 'timed-route')
  const after = await f.query({ kind: 'source.get', sourceId: args.sourceId })
  assert.equal(after.receivedAt, args.receivedAt)
  assert.match(after.routedAt, /^20/)
  await f.command('source.routed', { sourceId: args.sourceId, receipt: { routeId: 'timed-route' } }, 'timed-route-replay')
  assert.equal((await f.query({ kind: 'source.get', sourceId: args.sourceId })).routedAt, after.routedAt)
  const historical = { sourceId: 'legacy-source', groupId: args.groupId, messageId: 'legacy-message', actorId: args.actorId, text: 'legacy' }
  await f.command('source.record', historical)
  await f.command('source.record', { ...historical, receivedAt: args.receivedAt })
  assert.equal((await f.query({ kind: 'source.get', sourceId: historical.sourceId })).receivedAt, undefined)
})

test('source route decisions are immutable and group sessions reclaim pending sources after restart', async t => {
  const f = await fixture(t)
  const args = { sourceId: 'source-1', groupId: 'group-1', messageId: 'msg-1', actorId: 'user-1', senderName: '真实作者', text: 'Do the work' }
  await f.command('source.record', args)
  await f.command('source.record', args)
  const group = (await f.command('group.claim', { groupId: 'group-1' })).result
  assert.deepEqual(group.sourceIds, ['source-1'])
  await f.command('source.routePrepared', { sourceId: 'source-1', decision: { actions: [{ kind: 'create', taskId: 'task-1' }] } })
  await assert.rejects(f.command('source.routePrepared', { sourceId: 'source-1', decision: { actions: [{ kind: 'ignore' }] } }), { code: 'DYNAMIC_SOURCE_ROUTE_CONFLICT' })
  await f.command('group.drained', { binding: group.binding })
  await f.reopen()
  const next = (await f.command('group.claim', { groupId: 'group-1' })).result
  assert.equal(next.binding.sessionId, group.binding.sessionId)
  assert.equal(next.binding.leaseEpoch, 2)
  assert.equal(next.sources[0].routeDecision.actions[0].taskId, 'task-1')
  await f.command('source.routed', { sourceId: 'source-1', receipt: { taskId: 'task-1' } })
  assert.equal((await f.query({ kind: 'source.list', groupId: 'group-1', status: 'pending' })).length, 0)
})

test('legacy unresolved effects and undrained native sessions become read-only blockers, never dynamic jobs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-legacy-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const legacyDbPath = join(directory, 'legacy.sqlite'), old = new DatabaseSync(legacyDbPath)
  old.exec(`CREATE TABLE execution_runs(run_id TEXT,task_id TEXT); CREATE TABLE execution_effects(effect_id TEXT,run_id TEXT,state TEXT,resource_keys_json TEXT);
    CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,session_id TEXT,status TEXT,drained INTEGER);
    INSERT INTO execution_runs VALUES ('run','task'); INSERT INTO execution_effects VALUES ('effect','run','unknown','["repo:legacy"]');
    INSERT INTO execution_nodes VALUES ('node','run','old-session','running',0);`)
  old.close()
  const f = await fixture(t, { legacyDbPath }), owner = await f.task()
  assert.equal((await f.query({ kind: 'legacy.list' })).length, 2)
  await assert.rejects(f.execution(owner.binding), { code: 'DYNAMIC_LEGACY_EFFECT_UNRESOLVED' })
  await assert.rejects(f.command('task.complete', { binding: owner.binding, summary: 'Done' }), { code: 'DYNAMIC_TASK_NOT_QUIESCENT' })
  const readback = new DatabaseSync(legacyDbPath, { readOnly: true })
  assert.equal(readback.prepare('SELECT state FROM execution_effects').get().state, 'unknown')
  readback.close()
  assert.equal((await f.query({ kind: 'execution.list' })).length, 0)
})


test('result and wake roll back together on a failed SQLite write and the same command remains safely retryable', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_result_wake BEFORE INSERT ON dynamic_wakes BEGIN SELECT RAISE(ABORT,'injected wake failure'); END;")
  await assert.rejects(f.command('execution.result', { binding, output: { done: true } }, 'atomic-result'), /injected wake failure/)
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result, undefined)
  assert.equal(await f.query({ kind: 'receipt.get', id: 'atomic-result' }), null)
  inspect.exec('DROP TRIGGER reject_result_wake'); inspect.close()
  await f.command('execution.result', { binding, output: { done: true } }, 'atomic-result')
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
})

test('initialization marker rejects database loss and an accidental initialize flag cannot create a replacement ledger', async t => {
  const f = await fixture(t)
  await f.task()
  const reopened = await f.reopen(); await reopened.close()
  for (const suffix of ['', '-wal', '-shm']) await rm(f.config.dbPath + suffix, { force: true })
  await assert.rejects(openDynamicTaskStore(f.config), { code: 'DYNAMIC_STORE_LOST' })
})

test('question and status notifications are idempotent, independently durable, and obsolete questions never send', async t => {
  const f = await fixture(t), owner = await f.task()
  const args = { notificationId: 'question:task:1', taskId: 'task', requirementRevision: 1, kind: 'question', payload: { text: 'Which target?' } }
  await f.command('notification.prepare', args)
  await f.command('notification.prepare', args)
  await assert.rejects(f.command('notification.prepare', { ...args, payload: { text: 'Different question' } }), { code: 'DYNAMIC_NOTIFICATION_ID_CONFLICT' })
  await f.command('notification.prepare', { ...args, notificationId: 'status:task:1', kind: 'status', payload: { text: 'Working' } })
  await f.command('task.revise', { taskId: 'task', request: 'Target clarified', expectedControlRevision: 1 })
  assert.equal((await f.command('notification.start', { notificationId: args.notificationId })).dispatchEligible, false)
  assert.equal((await f.query({ kind: 'notification.get', notificationId: args.notificationId })).reason, 'stale_question')
  assert.equal((await f.command('notification.start', { notificationId: 'status:task:1' })).dispatchEligible, true)
  await f.command('task.control', { taskId: 'task', control: 'paused' })
  await assert.rejects(f.command('task.revise', { taskId: 'task', request: 'stale control input', expectedControlRevision: 1 }), { code: 'DYNAMIC_TASK_REVISION_STALE' })
})

test('unclean process restart fences started operations and retains result/wake receipts without replay', async t => {
  const { spawnSync } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'dynamic-process-crash-'))
  let store
  t.after(async () => { try { await store?.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const dbPath = join(directory, 'state.sqlite'), module = new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js', import.meta.url).href
  const script = `import {openDynamicTaskStore} from ${JSON.stringify(module)};
    const s=await openDynamicTaskStore({dbPath:${JSON.stringify(dbPath)},instanceId:'child',initialize:true});
    let i=0; const c=(kind,args)=>s.command({id:'c'+ ++i,kind,args});
    await c('task.create',{taskId:'task',request:'do work'}); const owner=(await c('task.claim',{taskId:'task'})).result.binding;
    const e=(await c('execution.dispatch',{binding:owner,key:'one',prompt:'work',input:{}})).result.execution;
    const b=(await c('execution.claim',{executionId:e.executionId})).result.binding;
    const op=(await c('operation.prepare',{binding:b,key:'write',definition:{tool:'write'},resourceKeys:['shared']})).result.operation;
    await c('operation.start',{binding:b,operationId:op.operationId}); console.log(JSON.stringify({executionId:e.executionId,operationId:op.operationId})); process.exit(0);`
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const identities = JSON.parse(child.stdout.trim())
  store = await openDynamicTaskStore({ dbPath, instanceId: 'child' })
  assert.equal((await store.query({ kind: 'operation.get', operationId: identities.operationId })).state, 'unknown')
  assert.equal((await store.query({ kind: 'execution.get', executionId: identities.executionId })).recovering, true)
  assert.equal((await store.query({ kind: 'resource.list' }))[0].resourceKey, 'shared')
  assert.equal((await store.query({ kind: 'receipt.get', id: 'c6' })).dispatchEligible, true)
})


test('an explicit Web routing intent is recorded atomically with its original source and cannot be reinterpreted', async t => {
  const f = await fixture(t)
  const args = { sourceId: 'web-source', groupId: 'group', messageId: 'web-request', actorId: 'user', channel: 'web', text: 'create directly',
    routeDecision: { actions: [{ action: 'create', requestId: 'stable-request', objective: 'Do the requested work' }] } }
  await f.command('source.record', args)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'source.get', sourceId: args.sourceId })).routeDecision, args.routeDecision)
  await f.command('source.record', args)
  await assert.rejects(f.command('source.record', { ...args, routeDecision: { actions: [{ action: 'ignore' }] } }), { code: 'DYNAMIC_SOURCE_CONFLICT' })
  await assert.rejects(f.command('source.routePrepared', { sourceId: args.sourceId, decision: { actions: [] } }), { code: 'DYNAMIC_SOURCE_ROUTE_CONFLICT' })
})

test('dispatch rollback before durable receipt creates no orphan, and lost post-commit acknowledgement replays one identity', async t => {
  const f = await fixture(t), owner = await f.task()
  const args = { binding: owner.binding, key: 'crash-window', prompt: 'Inspect without duplication', input: {} }
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_dispatch_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='dispatch-crash' BEGIN SELECT RAISE(ABORT,'injected dispatch receipt failure'); END;")
  await assert.rejects(f.command('execution.dispatch', args, 'dispatch-crash'), /injected dispatch receipt failure/)
  assert.equal((await f.query({ kind: 'execution.list' })).length, 0)
  assert.equal(await f.query({ kind: 'receipt.get', id: 'dispatch-crash' }), null)
  inspect.exec('DROP TRIGGER reject_dispatch_receipt'); inspect.close()
  const accepted = await f.command('execution.dispatch', args, 'dispatch-crash')
  await f.reopen()
  const repeated = await f.command('execution.dispatch', args, 'dispatch-crash')
  assert.equal(repeated.result.execution.executionId, accepted.result.execution.executionId)
  assert.equal((await f.query({ kind: 'execution.list' })).length, 1)
})

test('result receipt failure rolls back both result and wake; post-commit restart retains one result/wake pair', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { binding, output: { summary: 'Persist the observation once' } }
  const inspect = new DatabaseSync(f.config.dbPath)
  inspect.exec("CREATE TRIGGER reject_result_receipt BEFORE INSERT ON dynamic_receipts WHEN NEW.id='result-crash' BEGIN SELECT RAISE(ABORT,'injected result receipt failure'); END;")
  await assert.rejects(f.command('execution.result', args, 'result-crash'), /injected result receipt failure/)
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result, undefined)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 0)
  inspect.exec('DROP TRIGGER reject_result_receipt'); inspect.close()
  await f.command('execution.result', args, 'result-crash')
  await f.reopen()
  await f.command('execution.result', args, 'result-crash')
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(item => item.kind === 'execution.result').length, 1)
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: binding.executionId })).result.payload.output, args.output)
})

test('未知操作保持原记录，但不全局阻断另一原生调用', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'writer-a'), b = await f.execution(owner.binding, 'writer-b')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key,
    definition: { toolName: 'concurrency_safe_write' }, resourceKeys: [] })).result.operation
  const first = await prepare(a, 'a'), second = await prepare(b, 'b')
  await f.command('operation.start', { binding: a, operationId: first.operationId })
  await f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'unknown', result: { lostReceipt: true } })
  assert.equal((await f.command('operation.start', { binding: b, operationId: second.operationId }, 'pending-native-start')).dispatchEligible, true)
  assert.equal((await f.query({ kind: 'operation.get', operationId: second.operationId })).state, 'starting')
  assert.equal((await f.query({ kind: 'operation.get', operationId: first.operationId })).state, 'unknown')
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { confirmed: true }, evidenceRef: 'verified-external-receipt' })
  assert.equal((await f.command('operation.start', { binding: b, operationId: second.operationId }, 'pending-native-start')).dispatchEligible, false)
})

test('a definitively refused prepared request can be retired by its exact binding/key without clearing unknown writes', async t => {
  const f = await fixture(t), owner = await f.task(), a = await f.execution(owner.binding, 'a'), b = await f.execution(owner.binding, 'b')
  const prepare = async (binding, key) => (await f.command('operation.prepare', { binding, key, definition: { toolName: 'write' }, resourceKeys: [] })).result.operation
  const first = await prepare(a, 'first'), second = await prepare(b, 'second')
  await f.command('operation.start', { binding: a, operationId: first.operationId })
  await assert.rejects(f.command('operation.cancelPrepared', { binding: a, operationId: first.operationId, key: 'first', reason: 'not-started' }), { code: 'DYNAMIC_OPERATION_ALREADY_DISPATCHED' })
  await f.command('operation.settle', { binding: a, operationId: first.operationId, state: 'unknown' })
  const cancel = { binding: b, operationId: second.operationId, key: 'second', reason: 'atomic-start-refused' }
  for (const override of [{binding:a}, {key:'other-request'}, {binding:{...b,leaseEpoch:b.leaseEpoch+1}}])
    await assert.rejects(f.command('operation.cancelPrepared', {...cancel,...override}), { code: 'DYNAMIC_OPERATION_SCOPE_STALE' })
  await assert.rejects(f.command('operation.cancelPrepared', { binding: a, operationId: first.operationId, key: 'first', reason: 'not-started' }), { code: 'DYNAMIC_OPERATION_ALREADY_DISPATCHED' })
  await f.command('operation.cancelPrepared', cancel, 'cancel-exact-prepared')
  await f.command('operation.cancelPrepared', cancel, 'cancel-exact-prepared')
  assert.equal((await f.query({ kind: 'operation.get', operationId: second.operationId })).state, 'cancelled')
  assert.equal((await f.query({ kind: 'operation.get', operationId: first.operationId })).state, 'unknown')
  await f.command('operation.reconcile', { operationId: first.operationId, state: 'succeeded', result: { verified: true }, evidenceRef: 'trusted-receipt' })
  assert.equal((await f.query({ kind: 'task.blockers', taskId: 'task' })).operations.length, 0)
})

test('原操作对账拒绝缺失/外来证据，调查续办保留unknown并可调用原生能力', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operationId='unknown-effect'
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh'},resourceKeys:[]})
  await f.command('operation.start',{binding,operationId})
  await assert.rejects(f.command('operation.job',{binding,operationId,job:{jobId:'foreign',owner:'foreign-session',startedAt:1,status:'completed',finishedAt:2}}),{code:'DYNAMIC_JOB_RECEIPT_INVALID'})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{reason:'missing receipt'}})
  await assert.rejects(f.command('operation.reconcile-job',{binding:owner.binding,operationId}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  await f.command('execution.result',{binding,output:{status:'blocked'}})
  await f.command('execution.drained',{binding})
  const args={binding:owner.binding,executionId:binding.executionId,key:'readback',prompt:'Inspect without replay',input:{},definition:{recoveryReadOnly:true}}
  await f.command('execution.continue',args)
  const next=(await f.command('execution.claim',{executionId:binding.executionId})).result.binding
  await f.command('operation.prepare',{binding:next,operationId:'investigation',key:'investigation',definition:{toolName:'pwsh'}})
  assert.equal((await f.command('operation.start',{binding:next,operationId:'investigation'})).dispatchEligible,true)
  assert.equal((await f.query({kind:'operation.get',operationId})).state,'unknown')
})

test('terminal job receipt cannot reconcile an undrained execution; successful reconciliation preserves unknown evidence', async t => {
  const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='drain-proof'
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh'},resourceKeys:['host-native-operation']})
  await f.command('operation.start',{binding,operationId})
  await f.command('operation.job',{binding,operationId,job:{jobId:'original-job',owner:binding.sessionId,startedAt:1,status:'killed',finishedAt:2}})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{reason:'cancelled-with-partial-effects'}})
  await assert.rejects(f.command('operation.reconcile-job',{binding:owner.binding,operationId}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  await f.command('execution.result',{binding,output:{status:'blocked'}})
  await f.command('execution.drained',{binding})
  const value=(await f.command('operation.reconcile-job',{binding:owner.binding,operationId})).result.operation
  assert.equal(value.state,'failed');assert.equal(value.result.partialEffectsPossible,true)
  assert.equal(value.result.previousObservation.reason,'cancelled-with-partial-effects')
  assert.equal((await f.query({kind:'resource.list'})).length,0)
})


test('verified legacy stop closes only failed with retained unknown audit and never creates a replacement execution', async t => {
  const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='legacy-stop'
  const hash = value => createHash('sha256').update(JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item)).digest('hex')
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:['host-native-operation']})
  await f.command('operation.start',{binding,operationId})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',resultDigest:'original-result',isError:true}})
  await f.command('execution.result',{binding,output:{status:'blocked'}});await f.command('execution.drained',{binding})
  await f.command('execution.continue',{binding:owner.binding,executionId:binding.executionId,key:'readback',prompt:'Read evidence',input:{readbackOperationId:operationId},definition:{recoveryReadOnly:true}})
  const readBinding=(await f.command('execution.claim',{executionId:binding.executionId})).result.binding
  await f.command('execution.result',{binding:readBinding,output:{status:'completed'}});await f.command('execution.drained',{binding:readBinding})
  const original=await f.query({kind:'operation.get',operationId})
  const proof={kind:'legacy-host-drained-partial',operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
    callId:'call',resultDigest:'original-result',argumentsDigest:'args',partialEffectsPossible:true,
    observations:[{executionId:binding.executionId,sessionId:binding.sessionId,inputVersion:2}]}
  await assert.rejects(f.command('operation.reconcile-stopped',{binding:owner.binding,operationId,proof:{...proof,observations:[]}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  const value=(await f.command('operation.reconcile-stopped',{binding:owner.binding,operationId,proof})).result.operation
  assert.equal(value.state,'failed');assert.equal(value.result.partialEffectsPossible,true)
  assert.deepEqual(value.result.previousObservation,original)
  assert.equal((await f.query({kind:'execution.list'})).length,1)
  assert.equal((await f.query({kind:'resource.list'})).length,0)
})

test('网页读取正式对账保留原unknown记录，原执行可续办且不生成或重放操作', async t => {
 const f=await fixture(t), owner=await f.task(), binding=await f.execution(owner.binding), operationId='web-read'
 const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex')
 await f.command('operation.prepare',{binding,operationId,key:'original-read',definition:{toolName:'web_fetch',argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName:'web_fetch',resultDigest:'result',isError:true}})
 await f.command('execution.result',{binding,output:{status:'completed'}});await f.command('execution.drained',{binding})
 const original=await f.query({kind:'operation.get',operationId})
 const proof={kind:'native-web-read-failed',operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
  callId:'call',toolName:'web_fetch',argumentsDigest:'args',resultDigest:'result',resultSequence:3,turnEndSequence:4}
 const continueArgs={binding:owner.binding,executionId:binding.executionId,key:'continue',prompt:'Continue original work',input:{objective:'original'},definition:{}}
 await assert.rejects(f.command('execution.continue',continueArgs),{code:'DYNAMIC_OPERATION_UNRESOLVED'})
 for(const patch of [{operationDigest:'wrong'},{sessionId:'wrong'},{toolName:'pwsh'},{resultDigest:'wrong'},{turnEndSequence:3},{resultSequence:-1}])
  await assert.rejects(f.command('operation.reconcile-web-read',{binding:owner.binding,operationId,proof:{...proof,...patch}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
 const value=(await f.command('operation.reconcile-web-read',{binding:owner.binding,operationId,proof},'reconcile-web')).result.operation
 assert.equal(value.state,'failed');assert.deepEqual(value.result.previousObservation,original)
 assert.equal((await f.command('operation.reconcile-web-read',{binding:owner.binding,operationId,proof},'reconcile-web')).result.operation.state,'failed')
 const continued=(await f.command('execution.continue',continueArgs)).result.execution
 assert.equal(continued.executionId,binding.executionId)
 assert.equal((await f.query({kind:'operation.list'})).length,1)
 assert.equal((await f.query({kind:'execution.list'})).length,1)
})

async function humanWaiting(f, requestId = 'human-request') {
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'Resolve the original task' })
  const owner = (await f.command('task.claim', { taskId: 'human-task' })).result
  const args = { binding: owner.binding, action: 'blocked', summary: '等待有权人员补充', question: '请选择目标环境', humanRequest: { requestId, audience: 'requester', reason: '缺少目标环境', attemptedActions: ['已读取原始交办及当前环境配置'] } }
  await f.command('task.wait', args)
  await f.command('task.drained', { binding: owner.binding })
  return { owner, args, respond: { taskId: 'human-task', requestId, sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 } }
}
async function humanSource(f, actorId = 'owner', groupId = 'g') {
  await f.command('source.record', { sourceId: 'human-answer', groupId, messageId: 'reply-original', actorId, text: '仅在 UAT3 执行已说明的修改', channel: actorId === 'web-user' ? 'web' : 'im' })
}

async function isolatedRestartLedger(t, drained) {
 const f = await fixture(t, { webActorId: 'web-user' })
 await f.command('task.create', { taskId: 'restart-task', groupId: 'g', ownerActorId: 'web-user', request: 'Continue without replay' })
 const owner = (await f.command('task.claim', { taskId: 'restart-task' })).result
 const binding = await f.execution(owner.binding, 'original-job'), operationId = 'original-isolated-operation'
 await f.command('execution.sessionBound', { binding })
 await f.command('operation.prepare', { binding, operationId, key: 'original-producer', definition: { toolName: 'pwsh', argumentsDigest: 'args' }, resourceKeys: ['local-source'] })
 await f.command('operation.start', { binding, operationId })
 await f.command('operation.job', { binding, operationId, job: { jobId: 'original-job', owner: binding.sessionId, startedAt: 1, status: 'running' } })
 const readback = (await f.command('execution.dispatch', { binding: owner.binding, key: 'investigate', prompt: 'Read actual effects',
  definition: { recoveryReadOnly: true }, input: { readbackOperationId: operationId } })).result.execution
 const readBinding = (await f.command('execution.claim', { executionId: readback.executionId })).result.binding
 await f.command('execution.result', { binding: readBinding, output: { observed: true } })
 await f.command('execution.drained', { binding: readBinding })
 if (drained) {
  await f.command('execution.result', { binding, output: { status: 'blocked', reason: 'effects unknown' } })
  await f.command('execution.drained', { binding })
 } else await f.command('execution.cancel', { binding })
 await f.command('task.wait', { binding: owner.binding, action: 'blocked', summary: 'Unknown job; inspect isolation', question: 'Confirm original scoped isolation only',
  humanRequest: { requestId: 'restart-human', audience: 'operator', reason: 'Host restart', attemptedActions: ['Bound investigation completed'] } })
 await f.command('task.drained', { binding: owner.binding })
 await f.reopen()
 const operation = await f.query({ kind: 'operation.get', operationId })
 const challenge = isolationBinding(operation, 'original-call')
 const proof = { kind: 'native-host-restart-isolated', ...challenge, callSequence: 2, registeredSequence: 3, commandDigest: isolationDigest('original-command'), exitStatus: 'unknown', noReplay: true, partialEffectsPossible: true,
  observations: [{ executionId: readback.executionId, sessionId: readback.sessionId, inputVersion: 1, callId: 'observed', sequence: 5 }],
  isolation: { kind: 'native-job-durable-isolation', receiptId: 'isolation', issuer: 'trusted-range-owner', fenceRef: 'retired-range', hostExitRef: 'host-fatal',
   originalHostExited: true, durableFence: true, managedRangeEmpty: true, externalWritersExcluded: true, activeWriterCount: 0,
   observedAt: '2026-10-27T09:00:00Z', binding: challenge } }
 const source = { sourceId: 'restart-operator-source', groupId: 'g', messageId: 'restart-operator-reply', actorId: 'web-user', channel: 'web', text: 'Confirm isolation; retain unknown; no replay',
  requestIdentity: { humanRequestId: 'restart-human', nativeRestartResolutions: [{ operationId, expectedOperationDigest: proof.operationDigest, expectedIsolationDigest: isolationDigest(proof.isolation) }] } }
 const confirm = { taskId: binding.taskId, requestId: 'restart-human', expectedRequirementRevision: 1, expectedControlRevision: 1, source, resolutions: [{ operationId, proof }] }
 return { ...f, owner, binding, operationId, operation, proof, source, confirm, readback }
}

for (const drained of [true, false]) test(`operator restart isolation retains unknown and is durable/idempotent without replay: drained=${drained}`, async t => {
 const f = await isolatedRestartLedger(t, drained)
 const result = await f.command('task.human.resolve-failures', f.confirm, 'confirm-isolation')
 assert.equal(result.result.request.status, 'answered')
 let audited = await f.query({ kind: 'operation.get', operationId: f.operationId })
 const { recoverySettlement, ...original } = audited
 assert.deepEqual(original, f.operation)
 assert.equal(hasRestartIsolation(audited), true)
 assert.equal(audited.state, 'unknown'); assert.equal(audited.job.status, 'running'); assert.equal(audited.result, f.operation.result)
 assert.equal((await f.query({ kind: 'task.blockers', taskId: f.binding.taskId })).operations.length, 0)
 if (!drained) {
  const ref = { operationId: audited.operationId, auditDigest: isolationDigest(recoverySettlement) }
  await assert.rejects(f.command('execution.drained', { binding: f.binding, isolationAuditRefs: [{ ...ref, auditDigest: 'stale' }] }), { code: 'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT' })
  await f.command('execution.drained', { binding: f.binding, isolationAuditRefs: [ref] })
  const execution = await f.query({ kind: 'execution.get', executionId: f.binding.executionId })
  assert.equal(execution.drained, true); assert.equal(execution.recovering, false)
  assert.equal(execution.result, undefined, 'drain does not invent an execution or tool result')
  assert.deepEqual(execution.recoveryDrainAudit.refs, [ref])
 }
 const wakes = await f.query({ kind: 'wake.list' })
 assert.equal((await f.command('task.human.resolve-failures', f.confirm, 'confirm-isolation')).replayed, true)
 await f.reopen()
 assert.equal((await f.command('task.human.resolve-failures', f.confirm, 'confirm-isolation')).replayed, true)
 audited = await f.query({ kind: 'operation.get', operationId: f.operationId })
 assert.equal(hasRestartIsolation(audited), true)
 assert.equal((await f.query({ kind: 'wake.list' })).length, wakes.length)
 assert.equal((await f.query({ kind: 'resource.list' })).length, 0)
 const owner = (await f.command('task.claim', { taskId: f.binding.taskId, force: true })).result.binding
 await f.command('execution.continue', { binding: owner, executionId: f.binding.executionId, key: 'safe-next-step', prompt: 'Continue with isolated source excluded', input: {} })
 const next = (await f.command('execution.claim', { executionId: f.binding.executionId })).result.binding
 assert.notEqual((await f.command('operation.start', { binding: next, operationId: f.operationId })).dispatchEligible, true)
 await assert.rejects(f.command('operation.prepare', { binding: next, operationId: 'alias-replay', key: 'new-key-same-producer', definition: { toolName: 'pwsh', commandDigest: f.proof.commandDigest, argumentsDigest: 'changed-description' } }), { code: 'DYNAMIC_ISOLATED_OPERATION_REPLAY_FORBIDDEN' })
 assert.equal((await f.query({ kind: 'operation.list' })).length, 1)
})

for (const [name, alter] of Object.entries({
 'stale digest': a => { a.resolutions[0].proof.operationDigest = 'stale' },
 'foreign job': a => { a.resolutions[0].proof.isolation.binding.jobId = 'foreign' },
 'residual source': a => { a.resolutions[0].proof.isolation.activeWriterCount = 1 },
 'foreign task': a => { a.resolutions[0].proof.taskId = 'foreign' },
 'foreign investigator': a => { a.resolutions[0].proof.observations[0].executionId = 'foreign' },
 'untrusted operator': a => { a.source.actorId = 'other' },
 'new revision': a => { a.expectedControlRevision = 99 },
})) test(`operator restart isolation rolls back all effects for ${name}`, async t => {
 const f = await isolatedRestartLedger(t, false), args = structuredClone(f.confirm)
 alter(args)
 const sourceCount = (await f.query({ kind: 'source.list' })).length, wakeCount = (await f.query({ kind: 'wake.list' })).length
 await assert.rejects(f.command('task.human.resolve-failures', args))
 assert.deepEqual(await f.query({ kind: 'operation.get', operationId: f.operationId }), f.operation)
 assert.equal((await f.query({ kind: 'source.list' })).length, sourceCount)
 assert.equal((await f.query({ kind: 'wake.list' })).length, wakeCount)
 assert.equal((await f.query({ kind: 'task.get', taskId: f.binding.taskId })).humanRequests[0].status, 'waiting-reply')
 assert.ok((await f.query({ kind: 'resource.list' })).length > 0)
})

test('human request freezes the question and resumes the same task from its authorized original source idempotently', async t => {
  const f = await fixture(t), { owner, args, respond } = await humanWaiting(f)
  const waiting = await f.query({ kind: 'task.get', taskId: 'human-task' })
  assert.equal(waiting.humanRequests[0].status, 'waiting-reply')
  assert.equal(waiting.humanRequests[0].question, args.question)
  assert.deepEqual(waiting.humanRequests[0].attemptedActions, ['已读取原始交办及当前环境配置'])
  await humanSource(f)
  const first = await f.command('task.human.respond', respond, 'stable-human-response')
  assert.equal(first.result.request.status, 'answered')
  assert.equal(first.result.request.reply, '仅在 UAT3 执行已说明的修改')
  assert.equal(first.result.request.actorId, 'owner')
  assert.equal(first.result.task.sessionId, owner.task.sessionId)
  assert.equal(first.result.task.lastDecision, null)
  assert.deepEqual(first.result.task.sourceRefs, ['human-answer'])
  assert.equal(first.result.task.requirementRevision, 1)
  assert.deepEqual((await f.command('task.human.respond', respond, 'stable-human-response')).result, first.result)
  await assert.rejects(f.command('task.human.respond', respond), { code: 'DYNAMIC_HUMAN_REQUEST_STALE' })
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'human-task' })).filter(wake => wake.kind === 'human.responded').length, 1)
  await f.reopen()
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'answered')
})

for (const testCase of ['other-actor','other-group','stale-requirement','stale-control','not-drained','revised','cancelled','completed']) test(`human response rejects an invalid or superseded request: ${testCase}`, async t => {
  const f = await fixture(t), { owner, respond } = await humanWaiting(f)
  await humanSource(f, testCase === 'other-actor' ? 'outsider' : 'owner', testCase === 'other-group' ? 'other' : 'g')
  if (testCase === 'stale-requirement') respond.expectedRequirementRevision = 2
  if (testCase === 'stale-control') respond.expectedControlRevision = 2
  if (testCase === 'not-drained') await f.command('task.claim', { taskId: 'human-task', dialogue: true, force: true })
  if (testCase === 'revised') { await f.command('task.revise', { taskId: 'human-task', request: 'new requirement' }); respond.expectedRequirementRevision = 2 }
  if (testCase === 'cancelled') { await f.command('task.control', { taskId: 'human-task', control: 'cancelled' }); respond.expectedControlRevision = 2 }
  if (testCase === 'completed') {
    await f.command('task.human.respond', respond)
    const claim = (await f.command('task.claim', { taskId: 'human-task' })).result
    await f.command('task.complete', { binding: claim.binding, summary: '已按合法答复完成' })
  }
  await assert.rejects(f.command('task.human.respond', respond))
  if (['revised','cancelled'].includes(testCase)) assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'superseded')
})

test('群业务答复先只读复核，保存完整条件和审计，解除后独立轮恢复且重放不重复唤醒', async t => {
  const f = await fixture(t), { owner } = await humanWaiting(f)
  await assert.rejects(f.command('task.claim', { taskId: 'human-task', force: true }), { code: 'DYNAMIC_HUMAN_RESPONSE_REQUIRED' })
  await humanSource(f, 'business-owner')
  const accepted = { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'accepted-answer', text: '已确认', sourceRefs: ['human-answer'] }
  await f.command('task.supplement', accepted, 'accept-answer')
  await f.reopen()
  const task = await f.query({ kind: 'task.get', taskId: 'human-task' })
  assert.equal(task.humanRequests[0].status, 'waiting-reply')
  const candidate = pendingTaskHumanReview(task, await f.query({ kind: 'wake.list', taskId: 'human-task' }))
  assert.deepEqual(candidate.sourceIds, ['human-answer'])
  const review = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
  assert.equal(review.binding.sessionId, owner.binding.sessionId)
  assert.deepEqual(review.wakes.map(wake => wake.kind), ['task.supplement'])
  for (const kind of ['execution.dispatch', 'execution.continue', 'execution.feedback', 'task.complete'])
    await assert.rejects(f.command(kind, { binding: review.binding }), { code: 'DYNAMIC_HUMAN_REVIEW_READ_ONLY' })
  const resolve = { binding: review.binding, requestId: candidate.requestId, sourceId: 'human-answer',
    reason: '业务负责人针对原环境问题明确答复，只允许 UAT3 执行已说明的修改', evidence: ['原交办确认该成员负责环境范围', '原文：仅在 UAT3 执行已说明的修改'] }
  await assert.rejects(f.command('task.human.resolve', { ...resolve, sourceId: 'forged' }), { code: 'DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID' })
  await assert.rejects(f.command('task.human.resolve', { ...resolve, binding: owner.binding }), { code: 'DYNAMIC_TASK_LEASE_STALE' })
  await assert.rejects(f.command('task.human.resolve', { ...resolve, evidence: [] }), { code: 'DYNAMIC_ARGUMENT_INVALID' })
  const resolved = await f.command('task.human.resolve', resolve, 'resolve-review')
  assert.equal(resolved.result.request.reply, '仅在 UAT3 执行已说明的修改')
  assert.equal(resolved.result.request.actorId, 'business-owner')
  assert.equal(resolved.result.request.resolution.reason, resolve.reason)
  assert.equal((await f.command('task.human.resolve', resolve, 'resolve-review')).replayed, true)
  await assert.rejects(f.command('execution.dispatch', { binding: review.binding }), { code: 'DYNAMIC_HUMAN_REVIEW_READ_ONLY' })
  await f.command('task.wait', { binding: review.binding, summary: resolve.reason, evidence: resolve.evidence })
  await f.command('wake.ack', { binding: review.binding, wakeIds: review.wakeIds })
  await f.command('task.drained', { binding: review.binding })
  await f.reopen()
  const resumed = (await f.command('task.claim', { taskId: 'human-task' })).result
  assert.equal(resumed.humanReview, undefined)
  assert.equal(resumed.wakes.filter(item => item.kind === 'human.responded').length, 1)
  assert.ok(resumed.wakes.some(item => item.kind === 'task.created'), '旧工作唤醒未被复核消费')
  assert.equal(resumed.task.humanRequests[0].resolution.leaseEpoch, review.binding.leaseEpoch)
  assert.equal((await f.query({ kind: 'task.decisions', taskId: 'human-task' })).decisions[0].decision.summary, resolve.reason)
  assert.equal(resumed.task.requirementRevision, 1)
})

test('待答事实追问原子保存引用答复，原问题保留且崩溃恢复不重复答复', async t => {
  const f = await fixture(t), { owner } = await humanWaiting(f)
  await f.command('source.record', { sourceId: 'fact-question', groupId: 'g', messageId: 'fact-message', actorId: 'owner', text: '方案没确认，你前面改动的是什么？' })
  await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'fact-context', text: '追问已经实施的范围，不是批准', sourceRefs: ['fact-question'] })
  const review = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
  const source = await f.query({ kind: 'source.get', sourceId: 'fact-question' })
  const args = { binding: review.binding, action: 'wait', summary: '此前修复了导入覆盖；当前编辑持久化仍待方案确认。',
    evidence: ['已核对原结果和对应提交'], limitations: [], humanReply: { requestId: review.humanReview.requestId, sourceId: source.sourceId,
      notification: { conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId,
        sourceId: source.sourceId, sourceVersion: source.version, replyToMessageId: source.messageId,
        replyToSenderOpenDingTalkId: source.actorId, atOpenDingTalkIds: [source.actorId], text: '此前修复了导入覆盖；当前编辑持久化仍待方案确认。' } } }
  for (const invalid of [
    { ...args, binding: owner.binding }, { ...args, action: 'complete' }, { ...args, evidence: [] },
    { ...args, humanReply: { ...args.humanReply, sourceId: 'forged' } },
    { ...args, humanReply: { ...args.humanReply, requestId: 'another-request' } },
    { ...args, humanReply: { ...args.humanReply, notification: { ...args.humanReply.notification, conversationId: 'other-group' } } },
    { ...args, humanReply: { ...args.humanReply, notification: { ...args.humanReply.notification, sourceVersion: source.version + 1 } } },
    { ...args, humanReply: { ...args.humanReply, notification: { ...args.humanReply.notification, replyToMessageId: 'another-message' } } },
    { ...args, humanReply: { ...args.humanReply, notification: { ...args.humanReply.notification, atOpenDingTalkIds: ['someone-else'] } } },
  ]) await assert.rejects(f.command('task.wait', invalid))
  assert.equal((await f.query({ kind: 'notification.list' })).length, 0)
  const saved = (await f.command('task.wait', args, 'fact-reply')).result
  assert.equal(saved.task.humanRequests[0].status, 'waiting-reply')
  assert.equal(saved.task.humanRequests[0].question, '请选择目标环境')
  assert.equal(saved.task.humanRequests.length, 1)
  assert.equal(saved.task.lastDecision.replySourceId, source.sourceId)
  assert.equal(saved.notification.payload.sourceMessageId, 'fact-message')
  assert.equal((await f.command('task.wait', args, 'fact-reply')).replayed, true)
  await assert.rejects(f.command('task.wait', args), { code: 'DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID' })
  for (const kind of ['execution.dispatch', 'execution.continue', 'execution.feedback', 'task.complete'])
    await assert.rejects(f.command(kind, { binding: review.binding }), { code: 'DYNAMIC_HUMAN_REVIEW_READ_ONLY' })
  await f.reopen() // 模拟落账成功、wake.ack 之前退出。
  await f.command('task.drained', { binding: await f.query({ kind: 'task.binding', taskId: 'human-task' }) })
  const task = await f.query({ kind: 'task.get', taskId: 'human-task' })
  assert.equal(pendingTaskHumanReview(task, await f.query({ kind: 'wake.list', taskId: 'human-task' })), null)
  assert.equal(task.humanRequests[0].followupReplies.length, 1)
  assert.equal((await f.query({ kind: 'notification.list' })).length, 1)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'human-task' })).filter(item => item.kind === 'human.responded').length, 0)
  await assert.rejects(f.command('task.claim', { taskId: 'human-task', force: true }), { code: 'DYNAMIC_HUMAN_RESPONSE_REQUIRED' })
  await humanSource(f)
  await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'real-answer', text: '现在正式回答原问题', sourceRefs: ['fact-question', 'human-answer'] })
  const next = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
  assert.deepEqual(next.humanReview.sourceIds, ['human-answer'])
  await f.command('task.human.resolve', { binding: next.binding, requestId: next.humanReview.requestId, sourceId: 'human-answer',
    reason: '新消息回答原环境问题', evidence: ['原文仅允许 UAT3'] })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'answered')
  assert.equal((await f.query({ kind: 'task.decisions', taskId: 'human-task' })).decisions.filter(item => item.decision.replySourceId).length, 1)
})

for (const batched of [true, false]) test(`多来源事实追问逐条处置不吞消息，无关来源只消费一次：同一唤醒=${batched}`, async t => {
  const f = await fixture(t)
  await humanWaiting(f)
  const sourceIds = ['first-question', 'second-question', 'unrelated-question']
  for (const sourceId of sourceIds) await f.command('source.record', { sourceId, groupId: 'g', messageId: sourceId, actorId: 'owner', text: sourceId })
  for (const [index, refs] of (batched ? [sourceIds] : sourceIds.map((_, index) => sourceIds.slice(0, index + 1))).entries())
    await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
      messageId: `batch-${index}`, text: '新增待核对来源', sourceRefs: refs })
  for (let index = 0; index < sourceIds.length; index++) {
    const review = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
    assert.deepEqual(review.humanReview.sourceIds, sourceIds.slice(index))
    const source = await f.query({ kind: 'source.get', sourceId: sourceIds[index] })
    const args = { binding: review.binding, action: 'wait', summary: index < 2 ? '已核对本条追问，原问题仍待答' : '该来源与原事项无关，保存判断', evidence: ['对应原文与已有结果'] }
    if (index < 2) args.humanReply = { requestId: review.humanReview.requestId, sourceId: source.sourceId,
      notification: { conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId,
        sourceId: source.sourceId, sourceVersion: source.version, replyToMessageId: source.messageId,
        replyToSenderOpenDingTalkId: source.actorId, atOpenDingTalkIds: [source.actorId], text: args.summary } }
    await f.command('task.wait', args)
    const ack = (await f.command('wake.ack', { binding: review.binding, wakeIds: review.wakeIds })).result
    if (index < 2) assert.ok(ack.remainingWakeIds.length > 0)
    else assert.equal(ack.remainingWakeIds, undefined)
    await f.command('task.drained', { binding: review.binding })
    await f.reopen()
  }
  const task = await f.query({ kind: 'task.get', taskId: 'human-task' }), wakes = await f.query({ kind: 'wake.list', taskId: 'human-task' })
  assert.equal(task.humanRequests[0].status, 'waiting-reply')
  assert.deepEqual(task.humanRequests[0].followupReplies.map(item => item.sourceId), sourceIds.slice(0, 2))
  assert.equal((await f.query({ kind: 'notification.list' })).length, 2)
  assert.equal(pendingTaskHumanReview(task, wakes), null)
  assert.equal(wakes.filter(item => item.kind === 'task.supplement' && item.state !== 'acked').length, 0)
})

for (const interrupted of ['crash', 'provider-failure', 'tool-limit', 'resolved-before-drain']) test(`群待答复核恢复不丢来源及下一轮事件：${interrupted}`, async t => {
  const f = await fixture(t)
  await humanWaiting(f)
  await humanSource(f, 'business-owner')
  await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
    messageId: 'recover-answer', text: '环境答复', sourceRefs: ['human-answer'] })
  const review = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
  if (interrupted === 'provider-failure') await f.command('task.provider-failure', { binding: review.binding,
    failure: { code: 'TASK_SESSION_PROVIDER_TRANSIENT', phase: 'provider' } })
  if (interrupted === 'tool-limit') {
    await f.command('task.provider-failure', { binding: review.binding, failure: { code: 'TASK_SESSION_PROVIDER_TRANSIENT', phase: 'provider' } })
    await f.command('task.wait', { binding: review.binding, action: 'blocked',
      summary: '复核工具调用失败，等待新有效输入', limitations: ['DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID'], reviewFailureCode: 'DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID' })
  }
  if (interrupted === 'resolved-before-drain') await f.command('task.human.resolve', { binding: review.binding,
    requestId: review.humanReview.requestId, sourceId: 'human-answer', reason: '已核对业务角色和 UAT3 条件', evidence: ['原文仅允许 UAT3'] })
  await f.reopen()
  const recovering = await f.query({ kind: 'task.get', taskId: 'human-task' })
  assert.equal(recovering.recovering, true)
  await f.command('task.drained', { binding: await f.query({ kind: 'task.binding', taskId: 'human-task' }) })
  const task = await f.query({ kind: 'task.get', taskId: 'human-task' }), wakes = await f.query({ kind: 'wake.list', taskId: 'human-task' })
  assert.ok(review.wakeIds.every(id => wakes.some(item => item.id === id && item.state !== 'acked')))
  if (interrupted === 'tool-limit') {
    assert.equal(task.humanRequests[0].reviewFailures[0].code, 'DYNAMIC_HUMAN_REVIEW_SOURCE_INVALID')
    assert.equal(task.providerRecovery.attempts, 1, '工具失败不能抹掉既有模型重试预算')
    assert.equal(pendingTaskHumanReview(task, wakes), null)
    for (const [sourceId, fields] of [['summary-only', {}], ['old', { timestamp: '2020-01-01T00:00:00Z' }], ['web', { channel: 'web' }]]) {
      if (sourceId !== 'summary-only') await f.command('source.record', { sourceId, groupId: 'g', messageId: sourceId, actorId: 'owner', text: '非新候选', ...fields })
      const current = await f.query({ kind: 'task.get', taskId: 'human-task' })
      await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
        messageId: sourceId, text: '不构成新的有效候选', sourceRefs: [...current.sourceRefs, ...(sourceId === 'summary-only' ? [] : [sourceId])] })
      assert.equal(pendingTaskHumanReview(await f.query({ kind: 'task.get', taskId: 'human-task' }), await f.query({ kind: 'wake.list', taskId: 'human-task' })), null)
    }
    await f.command('source.record', { sourceId: 'clarified', groupId: 'g', messageId: 'clarified', actorId: 'owner', text: '确认该成员负责环境答复' })
    await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: 1, expectedControlRevision: 1,
      messageId: 'clarification', text: '确认该成员负责环境答复', sourceRefs: ['human-answer', 'clarified'] })
    const next = pendingTaskHumanReview(await f.query({ kind: 'task.get', taskId: 'human-task' }), await f.query({ kind: 'wake.list', taskId: 'human-task' }))
    assert.deepEqual(new Set(next.sourceIds), new Set(['human-answer', 'clarified']))
    return
  }
  if (interrupted === 'provider-failure') {
    assert.equal(task.providerRecovery.attempts, 1)
    assert.deepEqual(pendingTaskHumanReview(task, wakes).sourceIds, ['human-answer'])
    await assert.rejects(f.command('task.claim', { taskId: 'human-task', humanReview: true }), { code: 'DYNAMIC_TASK_PROVIDER_RETRY_NOT_DUE' })
    return
  }
  const next = (await f.command('task.claim', { taskId: 'human-task', ...(interrupted === 'crash' ? { humanReview: true } : {}) })).result
  assert.equal(next.binding.sessionId, review.binding.sessionId)
  assert.equal(next.binding.leaseEpoch, review.binding.leaseEpoch + 1)
  if (interrupted === 'crash') assert.deepEqual(next.humanReview.sourceIds, ['human-answer'])
  else {
    assert.equal(next.humanReview, undefined)
    assert.equal(next.wakes.filter(item => item.kind === 'human.responded').length, 1)
    assert.equal(next.task.humanRequests[0].reply, '仅在 UAT3 执行已说明的修改')
  }
})

for (const variant of ['unrelated', 'old', 'future', 'other-group', 'web', 'operator']) test(`待答复核保留等待且不空转：${variant}`, async t => {
  const f = await fixture(t), { owner } = await humanWaiting(f)
  if (variant === 'operator') {
    await f.command('task.revise', { taskId: 'human-task', request: '技术问题' })
    const next = (await f.command('task.claim', { taskId: 'human-task' })).result
    await f.command('task.wait', { binding: next.binding, summary: '等待技术修复', question: '恢复配置', humanRequest: { requestId: 'operator', audience: 'operator' } })
    await f.command('task.drained', { binding: next.binding })
  }
  const current = await f.query({ kind: 'task.get', taskId: 'human-task' })
  await f.command('source.record', { sourceId: 'candidate', groupId: variant === 'other-group' ? 'elsewhere' : 'g',
    messageId: 'candidate', actorId: 'owner', text: '另外一件事', channel: variant === 'web' ? 'web' : 'im',
    ...(variant === 'old' ? { timestamp: '2020-01-01T00:00:00Z' } : variant === 'future' ? { timestamp: '2099-01-01T00:00:00Z' } : {}) })
  await f.command('task.supplement', { taskId: 'human-task', expectedRequirementRevision: current.requirementRevision,
    expectedControlRevision: current.controlRevision, messageId: 'supplement', text: '另外一件事', sourceRefs: ['candidate'] })
  if (variant === 'unrelated') {
    const review = (await f.command('task.claim', { taskId: 'human-task', humanReview: true })).result
    await f.command('task.wait', { binding: review.binding, summary: '来源未回答原环境问题，保留原问题', evidence: ['另外一件事'] })
    await f.command('wake.ack', { binding: review.binding, wakeIds: review.wakeIds })
    await f.command('task.drained', { binding: review.binding })
    await f.reopen()
  }
  await assert.rejects(f.command('task.claim', { taskId: 'human-task', humanReview: true }), { code: 'DYNAMIC_HUMAN_REVIEW_NOT_PENDING' })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests.at(-1).status, 'waiting-reply')
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'human-task' })).filter(item => item.kind === 'human.responded').length, 0)
})

test('human request requires an explicit stable identity and accepts only configured web actor without impersonation', async t => {
  const f = await fixture(t, { webActorId: 'web-user' }), { owner, respond } = await humanWaiting(f)
  const fresh = await f.task('other-task')
  await assert.rejects(f.command('task.wait', { binding: fresh.binding, summary: 'ask', question: 'who?' }), { code: 'DYNAMIC_HUMAN_REQUEST_REQUIRED' })
  await humanSource(f, 'web-user')
  const result = await f.command('task.human.respond', respond)
  assert.equal(result.result.request.actorId, 'web-user')
  assert.equal(result.result.task.ownerActorId, 'owner')
})

test('waiting human request identities conflict on changed questions and an answer never reconciles unknown operations', async t => {
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'original task' })
  const { binding } = (await f.command('task.claim', { taskId: 'human-task' })).result
  const execution = await f.execution(binding)
  const operation = (await f.command('operation.prepare', { binding: execution, key: 'original-write', definition: { toolName: 'write' }, resourceKeys: ['repo:unknown'] })).result.operation
  await f.command('operation.start', { binding: execution, operationId: operation.operationId })
  await f.command('operation.settle', { binding: execution, operationId: operation.operationId, state: 'unknown', result: { uncertain: true } })
  await f.command('execution.drained', { binding: execution })
  const args = { binding, summary: '等待人工判断', question: '确认目标', humanRequest: { requestId: 'stable-question', audience: 'requester' } }
  await f.command('task.wait', args)
  await f.command('task.wait', args)
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests.length, 1)
  await assert.rejects(f.command('task.wait', { ...args, question: '其他目标' }), { code: 'DYNAMIC_HUMAN_REQUEST_CONFLICT' })
  await f.command('task.drained', { binding })
  await humanSource(f)
  await f.command('task.human.respond', { taskId: 'human-task', requestId: 'stable-question', sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'unknown')
  assert.equal((await f.query({ kind: 'resource.list' })).length, 1)
})

test('execution progress review is durable and idempotent without changing results, unknown effects or locks', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const operation = (await f.command('operation.prepare', { binding, key: 'uncertain', definition: { toolName: 'pwsh' }, resourceKeys: ['repo:original'] })).result.operation
  await f.command('operation.start', { binding, operationId: operation.operationId })
  await f.command('operation.settle', { binding, operationId: operation.operationId, state: 'unknown', result: { uncertain: true } })
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: 12, lastActivityAt: '2026-10-14T09:00:00Z', newEventCount: 3, changed: true, records: ['must not persist actual log text'] } }
  const first = await f.command('execution.progressReviewed', args, 'progress-slot-one')
  assert.equal(first.result.execution.status, 'running')
  assert.equal(first.result.execution.drained, false)
  assert.equal(first.result.execution.result, undefined)
  assert.equal(first.result.execution.progressReview.lastSequence, 12)
  assert.equal(first.result.execution.progressReview.records, undefined)
  assert.deepEqual((await f.command('execution.progressReviewed', args, 'progress-slot-one')).result, first.result)
  assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(wake => wake.kind === 'execution.progress.review').length, 1)
  assert.equal((await f.query({ kind: 'operation.get', operationId: operation.operationId })).state, 'unknown')
  assert.equal((await f.query({ kind: 'resource.list' })).length, 1)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, first.result.execution.progressReview)
})

for (const field of ['executionId', 'inputVersion', 'leaseEpoch', 'inputDigest']) test(`progress review rejects a foreign execution identity field: ${field}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: -1, lastActivityAt: null, newEventCount: 0, changed: false } }
  args[field] = typeof args[field] === 'number' ? args[field] + 1 : 'foreign'
  await assert.rejects(f.command('execution.progressReviewed', args))
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, undefined)
})

test('an unchanged or unreadable execution observation wakes review without claiming success; continuation clears the old review clock', async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  const args = { executionId: binding.executionId, inputVersion: binding.inputVersion, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    observation: { lastSequence: -1, lastActivityAt: null, newEventCount: 0, changed: false, readError: 'NATIVE_LOG_UNAVAILABLE' } }
  const result = await f.command('execution.progressReviewed', args)
  assert.equal(result.result.execution.progressReview.changed, false)
  assert.equal(result.result.execution.progressReview.readError, 'NATIVE_LOG_UNAVAILABLE')
  assert.equal(result.result.execution.status, 'running')
  assert.equal(result.result.execution.result, undefined)
  assert.ok((await f.query({ kind: 'wake.list', taskId: 'task' })).some(wake => wake.kind === 'execution.progress.review' && wake.payload.executionId === binding.executionId))
  await f.command('execution.result', { binding, output: { summary: 'actual completed result' } })
  await f.command('execution.drained', { binding })
  await assert.rejects(f.command('execution.progressReviewed', args), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await f.command('execution.continue', { binding: owner.binding, executionId: binding.executionId, key: 'follow-up', prompt: 'follow-up', input: {} })
  assert.equal((await f.query({ kind: 'execution.get', executionId: binding.executionId })).progressReview, null)
})

const providerFailure = binding => ({ code: 'EXECUTION_PROVIDER_TRANSIENT', phase: 'provider', message: 'fetch failed',
  providerError: { code: 'TRANSPORT', message: 'fetch failed' },
  terminal: { sessionId: binding.sessionId, inputVersion: binding.inputVersion, endSeq: 12, reason: 'error' } })

test('provider recovery persists bounded backoff, history and session identity across restart without human escalation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(t), owner = await f.task()
  let binding = await f.execution(owner.binding)
  const first = structuredClone(binding)
  await f.command('execution.sessionBound', { binding })
  for (let attempt = 0; attempt < 4; attempt++) {
    await f.command('execution.result', { binding, error: providerFailure(binding) })
    let e = await f.query({ kind: 'execution.get', executionId: binding.executionId })
    assert.equal(e.result.payload.error.providerError.code, 'TRANSPORT')
    assert.equal(e.status, attempt < 3 ? 'queued' : 'failed')
    assert.equal(e.timeline.segments.length, attempt + 1)
    assert.ok(e.timeline.segments.every(segment => segment.state === 'closed' && segment.endedAt))
    if (attempt === 3) {
      assert.equal(e.providerRecovery.attempts, 3); assert.equal(e.providerRecovery.exhausted, true)
      assert.equal((await f.query({ kind: 'wake.list', taskId: 'task' })).filter(w => w.kind === 'execution.result').length, 1)
      await f.command('execution.drained', { binding }); break
    }
    await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
    await f.command('execution.drained', { binding })
    await assert.rejects(f.command('execution.claim', { executionId: binding.executionId }), { code: 'DYNAMIC_EXECUTION_RECOVERY_PENDING' })
    if (attempt === 0) await assert.rejects(f.command('task.wait', { binding: owner.binding, summary: 'Ask operator', question: 'Restore model' }), { code: 'DYNAMIC_PROVIDER_TECHNICAL_WAIT' })
    await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_RETRY_NOT_DUE' })
    assert.equal(Date.parse(e.providerRecovery.nextAttemptAt) - Date.now(), 5000 * 2 ** attempt)
    if (attempt === 0) { await f.reopen(); assert.deepEqual((await f.query({ kind: 'execution.get', executionId: binding.executionId })).providerRecovery, e.providerRecovery) }
    t.mock.timers.setTime(Date.parse(e.providerRecovery.nextAttemptAt))
    await f.command('execution.retry-provider', { binding }, `retry-${attempt}`)
    assert.equal((await f.command('execution.retry-provider', { binding }, `retry-${attempt}`)).replayed, true)
    e = (await f.command('execution.claim', { executionId: binding.executionId })).result.execution
    assert.equal(e.timeline.segments.at(-1).state, 'running')
    assert.equal(Date.parse(e.timeline.segments.at(-1).startedAt) - Date.parse(e.timeline.segments.at(-2).endedAt), 5000 * 2 ** attempt)
    binding = await f.query({ kind: 'execution.binding', executionId: e.executionId })
    assert.equal(binding.sessionId, first.sessionId); assert.equal(binding.executionId, first.executionId)
    assert.equal(binding.inputDigest, first.inputDigest); assert.equal(binding.inputVersion, attempt + 2)
    assert.equal(e.results.length, attempt + 1)
  }
})

for (const variant of ['revised', 'paused', 'cancelled', 'unknown-effect']) test(`provider cold review after requirement update preserves recovery boundaries: ${variant}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(t), owner = await f.task()
  let binding = await f.execution(owner.binding)
  for (let attempt = 0; attempt < 4; attempt++) {
    await f.command('execution.sessionBound', { binding })
    await f.command('execution.result', { binding, error: providerFailure(binding) })
    await f.command('execution.drained', { binding })
    const e = await f.query({ kind: 'execution.get', executionId: binding.executionId })
    if (attempt === 3) break
    t.mock.timers.setTime(Date.parse(e.providerRecovery.nextAttemptAt))
    await f.command('execution.retry-provider', { binding })
    binding = (await f.command('execution.claim', { executionId: binding.executionId })).result.binding
  }
  await f.command('task.revise', { taskId: 'task', request: 'Network restored; review current requirements' })
  const before = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  await assert.rejects(f.command('execution.review-provider', { binding }), { code: 'DYNAMIC_EXECUTION_RETRY_NOT_DUE' })
  if (variant === 'paused' || variant === 'cancelled') await f.command('task.control', { taskId: 'task', control: variant })
  if (variant === 'unknown-effect') {
    const db = new DatabaseSync(f.config.dbPath)
    const operation = { operationId: 'uncertain', taskId: 'task', executionId: binding.executionId, state: 'unknown', resourceKeys: [] }
    db.prepare('INSERT INTO dynamic_operations (id, body) VALUES (?, ?)').run(operation.operationId, JSON.stringify(operation)); db.close()
  }
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextReviewAt))
  await f.reopen()
  if (variant !== 'revised') {
    await assert.rejects(f.command('execution.review-provider', { binding }), { code: variant === 'unknown-effect' ? 'DYNAMIC_OPERATION_UNRESOLVED' : 'DYNAMIC_EXECUTION_NOT_CURRENT' })
    return
  }
  const reviewed = await f.command('execution.review-provider', { binding }, 'revised-review')
  assert.equal((await f.command('execution.review-provider', { binding }, 'revised-review')).replayed, true)
  assert.equal(reviewed.result.execution.status, 'failed')
  assert.equal(reviewed.result.execution.inputVersion, before.inputVersion)
  assert.equal(reviewed.result.execution.sessionId, before.sessionId)
  assert.equal(reviewed.result.execution.providerRecovery.attempts, 3)
  assert.equal(reviewed.result.execution.providerRecovery.reviewAttempts, 1)
  const wake = (await f.query({ kind: 'wake.list', taskId: 'task' })).find(item => item.id === reviewed.result.wakeId)
  assert.equal(wake.payload.executionRequirementRevision, 1)
  assert.equal(wake.payload.requirementRevision, 2)
  assert.equal(wake.payload.retryNotBefore, before.providerRecovery.retryNotBefore)
  assert.equal(Date.parse(wake.payload.reviewedAt), Date.now())
  await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
})

for (const variant of ['missing-proof', 'foreign-proof', 'permanent', 'unknown-effect', 'cancelled']) test(`provider automatic recovery rejects ${variant}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.sessionBound', { binding })
  const error = providerFailure(binding)
  if (variant === 'missing-proof') delete error.terminal
  if (variant === 'foreign-proof') error.terminal.sessionId = 'other-session'
  if (variant === 'permanent') { error.code = 'EXECUTION_PROVIDER_FAILED'; error.providerError = { code: 'INVALID_CREDENTIAL', message: 'invalid credential' } }
  if (variant === 'unknown-effect') {
    await f.command('operation.prepare', { binding, operationId: 'effect', key: 'effect', definition: { effectClass: 'write' } })
    await f.command('operation.start', { binding, operationId: 'effect' })
  }
  if (variant === 'cancelled') await f.command('execution.cancel', { binding })
  await f.command('execution.result', { binding, error })
  await f.command('execution.drained', { binding })
  const e = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(e.providerRecovery, undefined)
  assert.ok(['failed', 'stale'].includes(e.status))
  await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
})

for (const control of ['paused', 'cancelled', 'revised']) test(`provider backoff cannot resume after task ${control}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.sessionBound', { binding })
  await f.command('execution.result', { binding, error: providerFailure(binding) })
  await f.command('execution.drained', { binding })
  const before = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  if (control === 'revised') await f.command('task.revise', { taskId: 'task', request: 'Updated requirement' })
  else await f.command('task.control', { taskId: 'task', control })
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextAttemptAt) + 1)
  await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  const after = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  assert.equal(after.inputVersion, 1); assert.equal(after.leaseEpoch, 1)
  assert.equal(after.result.payload.error.message, 'fetch failed')
})

for (const changeInput of [false, true]) test(`requester answer must be consumed by owner before provider recovery: changeInput=${changeInput}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(t)
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'Original task' })
  const owner = (await f.command('task.claim', { taskId: 'human-task' })).result
  const binding = await f.execution(owner.binding)
  await f.command('execution.sessionBound', { binding })
  await f.command('execution.result', { binding, error: providerFailure(binding) })
  await f.command('execution.drained', { binding })
  const before = await f.query({ kind: 'execution.get', executionId: binding.executionId })
  await f.command('task.wait', { binding: owner.binding, summary: 'Required business input', question: 'Which target?',
    humanRequest: { requestId: 'business-input', audience: 'requester', reason: 'Required target' } })
  await f.command('task.drained', { binding: owner.binding })
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextAttemptAt))
  await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_EXECUTION_NOT_CURRENT' })
  await humanSource(f)
  await f.command('task.human.respond', { taskId: 'human-task', requestId: 'business-input', sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  await assert.rejects(f.command('execution.retry-provider', { binding }), { code: 'DYNAMIC_OWNER_INPUT_PENDING' })
  const nextOwner = (await f.command('task.claim', { taskId: 'human-task' })).result
  let continued
  if (changeInput) {
    continued = (await f.command('execution.continue', { binding: nextOwner.binding, executionId: binding.executionId, key: 'actual-answer',
      prompt: 'Use authenticated UAT3 target', input: { objective: 'Use UAT3 target' } })).result.execution
    assert.equal(continued.input.objective, 'Use UAT3 target'); assert.equal(continued.providerRecovery.nextAttemptAt, null)
  } else {
    await f.command('task.wait', { binding: nextOwner.binding, summary: 'Answer reviewed; original goal remains valid' })
    await f.command('wake.ack', { binding: nextOwner.binding, wakeIds: nextOwner.wakeIds })
    continued = (await f.command('execution.retry-provider', { binding })).result.execution
  }
  assert.equal(continued.executionId, binding.executionId); assert.equal(continued.sessionId, binding.sessionId)
  assert.equal(continued.inputVersion, 2); assert.equal(continued.providerRecovery.attempts, 1)
})

for (const category of ['credentials', 'quota', 'configuration', 'unclassified']) test(`provider operator intervention needs concrete native action evidence: ${category}`, async t => {
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding)
  await f.command('execution.sessionBound', { binding })
  await f.command('execution.result', { binding, error: { code: 'EXECUTION_PROVIDER_FAILED', phase: 'provider',
    providerError: { code: category === 'credentials' ? 'AUTH' : category === 'quota' ? 'QUOTA' : category === 'configuration' ? 'NO_ADAPTER' : 'PI_AI_ERROR', message: 'Native diagnosis' },
    recovery: { category, retryable: false } } })
  await f.command('execution.drained', { binding })
  const request = { binding: owner.binding, summary: 'Specific provider action', question: 'Handle diagnosed provider condition', humanRequest: { requestId: 'action', audience: 'operator' } }
  if (category === 'unclassified') await assert.rejects(f.command('task.wait', request), { code: 'DYNAMIC_PROVIDER_TECHNICAL_WAIT' })
  else assert.equal((await f.command('task.wait', request)).result.task.humanRequests.length, 1)
})

for(const mode of ['legacy','write','shadow']) test('job读取缺失旧账恢复只允许历史原生读取: '+mode,async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='job-read'
 const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex')
 await f.command('operation.prepare',{binding,operationId,key:'job-read',definition:{toolName:'job_output',argumentsDigest:'args',
  effectClass:mode==='write'?'write':'unknown',...(mode==='shadow'?{nativeJobRead:false}:{})},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName:'job_output',resultDigest:'result',isError:true}})
 await f.command('execution.result',{binding,output:{status:'blocked'}});await f.command('execution.drained',{binding})
 const original=await f.query({kind:'operation.get',operationId})
 const proof={kind:'native-job-read-missing',operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
  callId:'call',toolName:'job_output',argumentsDigest:'args',resultDigest:'result',resultSequence:3,turnEndSequence:4,jobId:'pwsh-7',noEffect:true}
 if(mode!=='legacy'){
  await assert.rejects(f.command('operation.reconcile-job-read',{binding:owner.binding,operationId,proof}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  return
 }
 for(const patch of [{operationDigest:'wrong'},{toolName:'job_kill'},{jobId:''},{noEffect:false},{resultDigest:'wrong'},{turnEndSequence:3}])
  await assert.rejects(f.command('operation.reconcile-job-read',{binding:owner.binding,operationId,proof:{...proof,...patch}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
 const result=(await f.command('operation.reconcile-job-read',{binding:owner.binding,operationId,proof})).result.operation
 assert.equal(result.state,'failed');assert.equal(result.result.noEffect,true);assert.deepEqual(result.result.previousObservation,original)
 assert.equal((await f.query({kind:'operation.list'})).length,1)
})

for(const toolName of ['edit','write']) test('文件前置拒绝旧账精确对账保留审计并允许原执行续办: '+toolName,async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='file-precondition'
 const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex')
 await f.command('operation.prepare',{binding,operationId,key:'file',definition:{toolName,argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName,resultDigest:'result',isError:true}})
 await f.command('execution.result',{binding,output:{status:'blocked'}});await f.command('execution.drained',{binding})
 const original=await f.query({kind:'operation.get',operationId})
 const proof={kind:'native-file-precondition-failed',operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
  callId:'call',toolName,argumentsDigest:'args',resultDigest:'result',resultSequence:3,turnEndSequence:4,errorCode:'FS_NOT_OBSERVED',noEffect:true}
 for(const patch of [{operationDigest:'wrong'},{sessionId:'wrong'},{toolName:'pwsh'},{errorCode:'FS_IO_ERROR'},{noEffect:false},{resultDigest:'wrong'},{turnEndSequence:3},{resultSequence:-1}])
  await assert.rejects(f.command('operation.reconcile-file-precondition',{binding:owner.binding,operationId,proof:{...proof,...patch}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
 const result=(await f.command('operation.reconcile-file-precondition',{binding:owner.binding,operationId,proof})).result.operation
 assert.equal(result.state,'failed');assert.equal(result.result.noEffect,true);assert.deepEqual(result.result.previousObservation,original)
 const continued=(await f.command('execution.continue',{binding:owner.binding,executionId:binding.executionId,key:'continue',prompt:'Read and correct',input:{objective:'original'},definition:{}})).result.execution
 assert.equal(continued.executionId,binding.executionId);assert.equal((await f.query({kind:'operation.list'})).length,1)
})

test('investigated terminal error retains unknown audit and partial effects without replay', async t => {
  const f=await fixture(t,{webActorId:'web-user'});await f.command('task.create',{taskId:'task',groupId:'g',request:'original'})
  const owner=(await f.command('task.claim',{taskId:'task'})).result,binding=await f.execution(owner.binding),operationId='native-error'
  const hash = value => createHash('sha256').update(JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item)).digest('hex')
  await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'mcp__bytebase__get_schema',argumentsDigest:'args'},resourceKeys:['host-native-operation']})
  await f.command('operation.start',{binding,operationId})
  await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName:'mcp__bytebase__get_schema',resultDigest:'original-result',isError:true}})
  await f.command('execution.result',{binding,output:{status:'blocked'}});await f.command('execution.drained',{binding})
  await f.command('execution.continue',{binding:owner.binding,executionId:binding.executionId,key:'readback',prompt:'Read evidence',input:{readbackOperationId:operationId},definition:{recoveryReadOnly:true}})
  const readBinding=(await f.command('execution.claim',{executionId:binding.executionId})).result.binding
  await f.command('execution.result',{binding:readBinding,output:{status:'completed'}});await f.command('execution.drained',{binding:readBinding})
  const original=await f.query({kind:'operation.get',operationId})
  const proof={kind:'native-investigated-failure',toolName:'mcp__bytebase__get_schema',resultSequence:3,turnEndSequence:5,operationId,operationDigest:hash(original),taskId:binding.taskId,executionId:binding.executionId,sessionId:binding.sessionId,
    callId:'call',resultDigest:'original-result',argumentsDigest:'args',partialEffectsPossible:true,
    observations:[{executionId:binding.executionId,sessionId:binding.sessionId,inputVersion:2}]}
  await f.command('task.wait',{binding:owner.binding,summary:'原生错误待操作人结算',question:'结算此操作',humanRequest:{requestId:'resolution-request',audience:'operator'}})
  await f.command('task.drained',{binding:owner.binding})
  const sourceCount=(await f.query({kind:'source.list'})).length,wakeCount=(await f.query({kind:'wake.list'})).length
  const atomicSource={sourceId:'atomic-source',groupId:'g',messageId:'atomic-reply',actorId:'web-user',channel:'web',text:'仅结算指定失败',
    requestIdentity:{humanRequestId:'resolution-request',nativeFailureResolutions:[{operationId,expectedOperationDigest:proof.operationDigest}]}}
  const atomic={taskId:binding.taskId,requestId:'resolution-request',source:atomicSource,expectedRequirementRevision:1,expectedControlRevision:1,
    resolutions:[{operationId,proof},{operationId:'missing-second',proof}]}
  await assert.rejects(f.command('task.human.resolve-failures',atomic),{code:'DYNAMIC_NOT_FOUND'})
  assert.deepEqual(await f.query({kind:'operation.get',operationId}),original,'second failure rolls back first release')
  assert.equal((await f.query({kind:'source.list'})).length,sourceCount,'source is rolled back too')
  assert.equal((await f.query({kind:'wake.list'})).length,wakeCount,'no partial wake')
  assert.equal((await f.query({kind:'task.get',taskId:binding.taskId})).humanRequests[0].status,'waiting-reply')
  await f.command('source.record',{sourceId:'operator-source',groupId:'g',messageId:'operator-reply',actorId:'web-user',channel:'web',text:'仅结算原失败，部分效果保留',
    requestIdentity:{humanRequestId:'resolution-request',nativeFailureResolutions:[{operationId,expectedOperationDigest:proof.operationDigest}]}})
  const resolution={taskId:binding.taskId,operatorSourceId:'operator-source',operatorActorId:'web-user',humanRequestId:'resolution-request',expectedRequirementRevision:1,expectedControlRevision:1}
  await assert.rejects(f.command('operation.resolve-investigated-failure',{...resolution,expectedControlRevision:99,operationId,proof}),{code:'DYNAMIC_OPERATION_OPERATOR_RESOLUTION_REQUIRED'})
  await assert.rejects(f.command('operation.resolve-investigated-failure',{...resolution,operationId,proof:{...proof,observations:[]}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  for(const patch of [{resultDigest:'wrong'},{toolName:'pwsh'},{turnEndSequence:3},{partialEffectsPossible:false}])
    await assert.rejects(f.command('operation.resolve-investigated-failure',{...resolution,operationId,proof:{...proof,...patch}}),{code:'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT'})
  const value=(await f.command('operation.resolve-investigated-failure',{...resolution,operationId,proof})).result.operation
  assert.equal(value.state,'failed');assert.equal(value.result.partialEffectsPossible,true)
  assert.deepEqual(value.result.previousObservation,original)
  assert.equal(value.result.noEffect,undefined)
  assert.equal(value.result.previousObservation.result.isError,true)
  assert.equal((await f.query({kind:'execution.list'})).length,1)
  assert.equal((await f.query({kind:'resource.list'})).length,0)
})


test('archive retains durable task and execution history, refuses live tasks and never cancels them', async t => {
  const f = await fixture(t)
  const owner = await f.task()
  await assert.rejects(f.command('task.archive', { taskId: 'task', actorId: 'operator' }), { code: 'DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT' })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'task' })).control, 'active')
  await f.command('task.complete', { binding: owner.binding, summary: 'Verified done' })
  await assert.rejects(f.command('task.archive', { taskId: 'task', actorId: 'operator' }), { code: 'DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT' })
  await f.command('task.drained', { binding: owner.binding })
  const archived = (await f.command('task.archive', { taskId: 'task', actorId: 'operator' })).result.task
  assert.ok(archived.archivedAt); assert.equal(archived.archivedBy, 'operator')
  assert.equal(archived.completion.summary, 'Verified done')
  assert.equal((await f.command('task.archive', { taskId: 'task', actorId: 'operator' })).result.task.archivedAt, archived.archivedAt)
  await f.reopen()
  assert.deepEqual((await f.query({ kind: 'task.list' }))[0], archived)
})


test('cancelled and drained tasks may be archived without changing cancellation or execution history', async t => {
  const f = await fixture(t), owner = await f.task()
  await f.command('task.control', { taskId: 'task', control: 'cancelled' })
  await f.command('task.drained', { binding: owner.binding })
  const task = (await f.command('task.archive', { taskId: 'task', actorId: 'operator' })).result.task
  assert.equal(task.control, 'cancelled'); assert.ok(task.archivedAt)
})

test('archived lifecycle rejects reopen and concurrent pending-wake admission; unarchived tasks still reopen', async t => {
  const f = await fixture(t)
  for (const taskId of ['archived', 'normal']) {
    const owner = await f.task(taskId)
    await f.command('task.complete', { binding: owner.binding, summary: 'Done' })
    await f.command('task.drained', { binding: owner.binding })
  }
  await f.command('wake.enqueue', { taskId: 'archived', kind: 'new-message', payload: { fixture: true } })
  const [archive, claim] = await Promise.allSettled([
    f.command('task.archive', { taskId: 'archived', actorId: 'operator' }),
    f.command('wake.claim', { taskId: 'archived' }),
  ])
  assert.equal(archive.status, 'fulfilled'); assert.equal(claim.status, 'rejected'); assert.equal(claim.reason.code, 'DYNAMIC_TASK_ARCHIVED_CONFLICT')
  for (const kind of ['task.reopen', 'task.revise', 'task.claim', 'task.control'])
    await assert.rejects(f.command(kind, { taskId: 'archived', request: 'new message', control: 'active' }), { code: 'DYNAMIC_TASK_ARCHIVED_CONFLICT' })
  const before = await f.query({ kind: 'task.get', taskId: 'archived' })
  await f.reopen()
  await assert.rejects(f.command('task.reopen', { taskId: 'archived', request: 'after restart' }), { code: 'DYNAMIC_TASK_ARCHIVED_CONFLICT' })
  assert.deepEqual(await f.query({ kind: 'task.get', taskId: 'archived' }), before)
  const [reopened, racingArchive] = await Promise.allSettled([f.command('task.reopen', { taskId: 'normal', request: 'authorized follow-up' }), f.command('task.archive', { taskId: 'normal', actorId: 'operator' })])
  assert.equal(reopened.status, 'fulfilled'); assert.equal(racingArchive.status, 'rejected'); assert.equal(racingArchive.reason.code, 'DYNAMIC_TASK_ARCHIVE_NOT_QUIESCENT')
  const normal = await f.query({ kind: 'task.get', taskId: 'normal' })
  assert.equal(normal.status, 'active'); assert.equal(normal.archivedAt, undefined)
})

test('新续办步骤使用新请求键但保留原执行，会拒绝旧键改目标且不增加执行', async t => {
 const f=await fixture(t),owner=await f.task(),first=await f.execution(owner.binding)
 await f.command('execution.result',{binding:first,output:{done:true}});await f.command('execution.drained',{binding:first})
 const args={binding:owner.binding,executionId:first.executionId,key:'verify-build',prompt:'Verify build',input:{objective:'Verify build'}}
 await f.command('execution.continue',args)
 const second=(await f.command('execution.claim',{executionId:first.executionId})).result.binding
 await f.command('execution.result',{binding:second,output:{done:true}});await f.command('execution.drained',{binding:second})
 assert.equal((await f.command('execution.continue',args)).result.execution.inputVersion,2)
 const next={...args,prompt:'Inspect newly supplied connection',input:{objective:'Inspect newly supplied connection'}}
 await assert.rejects(f.command('execution.continue',next),{code:'DYNAMIC_DISPATCH_KEY_CONFLICT'})
 const continued=(await f.command('execution.continue',{...next,key:'inspect-new-connection'})).result.execution
 assert.equal(continued.executionId,first.executionId);assert.equal(continued.sessionId,first.sessionId);assert.equal(continued.inputVersion,3)
 assert.equal((await f.query({kind:'execution.list'})).length,1)
})

test('Web operator notice recall is exact, single-flight, durable and independent of the committed answer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(t, { webActorId: 'web-user' })
  await f.command('task.create', { taskId: 'human-task', groupId: 'g', ownerActorId: 'owner', request: 'Original task' })
  const { binding } = (await f.command('task.claim', { taskId: 'human-task' })).result
  await f.command('task.wait', { binding, summary: '等待技术处理', question: '恢复工具', humanRequest: { requestId: 'operator', audience: 'operator' } })
  await f.command('task.drained', { binding })
  for (const [notificationId, audience] of [['private', 'operator'], ['group', 'requester']]) {
    await f.command('notification.prepare', { notificationId, taskId: 'human-task', requirementRevision: 1,
      kind: 'question', payload: { humanRequestId: 'operator', audience, text: '恢复工具' } })
    if (audience === 'operator') {
      const started = await f.command('notification.start', { notificationId })
      await f.command('notification.receipt', { notificationId, dispatchToken: started.result.notification.dispatchToken,
        state: 'delivered', receipt: { messageId: 'exact-private', conversationId: 'self-private', senderActorId: 'operator' } })
    }
  }
  await assert.rejects(f.command('notification.recall.start', { notificationId: 'private' }), { code: 'DYNAMIC_NOTIFICATION_RECALL_NOT_REQUIRED' })
  await humanSource(f, 'web-user')
  await f.command('task.human.respond', { taskId: 'human-task', requestId: 'operator', sourceId: 'human-answer', expectedRequirementRevision: 1, expectedControlRevision: 1 })
  await assert.rejects(f.command('notification.recall.start', { notificationId: 'group' }), { code: 'DYNAMIC_NOTIFICATION_RECALL_NOT_REQUIRED' })
  const claimed = await f.command('notification.recall.start', { notificationId: 'private' })
  assert.equal(claimed.dispatchEligible, true)
  assert.equal((await f.command('notification.recall.start', { notificationId: 'private' })).dispatchEligible, false)
  await f.reopen()
  assert.equal((await f.command('notification.recall.start', { notificationId: 'private' })).dispatchEligible, false)
  t.mock.timers.tick(300001)
  const recovered = await f.command('notification.recall.start', { notificationId: 'private' })
  await assert.rejects(f.command('notification.recall.result', { notificationId: 'private', token: claimed.result.notification.recall.token, state: 'recalled', evidenceRef: 'stale' }), { code: 'DYNAMIC_NOTIFICATION_RECALL_STALE' })
  await f.command('notification.recall.result', { notificationId: 'private', token: recovered.result.notification.recall.token,
    state: 'failed', error: { message: 'platform recall window exceeded' }, nextAttemptAt: new Date(Date.now() + 5000).toISOString() })
  assert.equal((await f.query({ kind: 'task.get', taskId: 'human-task' })).humanRequests[0].status, 'answered')
  await f.reopen()
  assert.equal((await f.query({ kind: 'notification.get', notificationId: 'private' })).recall.state, 'failed')
  t.mock.timers.tick(5001)
  const retry = await f.command('notification.recall.start', { notificationId: 'private' })
  await f.command('notification.recall.result', { notificationId: 'private', token: retry.result.notification.recall.token, state: 'recalled', evidenceRef: 'complete-private-absence' })
  assert.equal((await f.command('notification.recall.start', { notificationId: 'private' })).dispatchEligible, false)
})

test('execution timing counts claims only, freezes on result/drain and accumulates continuation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const f = await fixture(t), owner = await f.task()
  const execution = (await f.command('execution.dispatch', { binding: owner.binding, key: 'timing', prompt: 'Inspect', input: {} })).result.execution
  const read = () => f.query({ kind: 'execution.get', executionId: execution.executionId })
  const round = async () => latestExecutionRoundTiming(await read())
  assert.deepEqual(execution.runTiming, { recorded: true, elapsedMs: 0, startedAt: null })
  assert.equal(await round(), null)
  t.mock.timers.tick(60_000)
  let binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
  assert.equal(Date.parse((await read()).runTiming.startedAt), Date.now())
  const firstStart = (await round()).startedAt
  assert.deepEqual(await round(), { startedAt: firstStart, endedAt: null, active: true })
  t.mock.timers.tick(500)
  await f.command('execution.progressReported', { binding, sequence: 1, summary: '已核对', evidence: [], activity: '继续检查' })
  await f.command('execution.feedback', { binding: owner.binding, executionId: execution.executionId, messageId: 'timing-feedback', text: '继续原目标' })
  await f.command('execution.feedbackConsumed', { binding, messageId: 'timing-feedback', sequence: 2 })
  assert.equal((await round()).startedAt, firstStart, 'stage feedback and messages never start a new round')
  t.mock.timers.tick(2000)
  await f.command('execution.result', { binding, output: { done: true }, feedbackVersion: 1 })
  const fixed = (await read()).runTiming
  const firstRound = await round()
  assert.equal(Date.parse(firstRound.endedAt) - Date.parse(firstRound.startedAt), 2500)
  assert.equal(firstRound.active, false)
  assert.deepEqual(fixed, { recorded: true, elapsedMs: 2500, startedAt: null })
  t.mock.timers.tick(30_000)
  await f.command('execution.drained', { binding })
  assert.deepEqual((await read()).runTiming, fixed)
  assert.deepEqual(await round(), firstRound)
  await f.command('execution.continue', { binding: owner.binding, executionId: execution.executionId, key: 'next', prompt: 'Continue', input: {} })
  t.mock.timers.tick(90_000)
  assert.deepEqual((await read()).runTiming, fixed)
  assert.deepEqual(await round(), firstRound, 'queued continuation does not invent a new start')
  binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
  assert.notEqual((await round()).startedAt, firstStart)
  assert.equal((await round()).active, true)
  t.mock.timers.tick(1500)
  await f.command('execution.drained', { binding })
  assert.deepEqual((await read()).runTiming, { recorded: true, elapsedMs: 4000, startedAt: null })
  assert.equal(Date.parse((await round()).endedAt) - Date.parse((await round()).startedAt), 1500, 'drain without result closes just this round')
  t.mock.timers.tick(30_000)
  binding = (await f.command('execution.claim', { executionId: execution.executionId })).result.binding
  t.mock.timers.tick(1000)
  await f.command('execution.cancel', { binding })
  t.mock.timers.tick(500)
  await f.command('execution.drained', { binding })
  assert.deepEqual((await read()).runTiming, { recorded: true, elapsedMs: 5500, startedAt: null })
  assert.equal((await read()).status, 'cancelled')
  const cancelledRound = await round()
  assert.equal(Date.parse(cancelledRound.endedAt) - Date.parse(cancelledRound.startedAt), 1500)
  await f.reopen()
  assert.equal((await read()).runTiming.elapsedMs, 5500)
  assert.deepEqual(await round(), cancelledRound)
})

test('execution timing never guesses legacy or interrupted intervals; terminal before restart stays fixed', async t => {
  const f = await fixture(t), owner = await f.task()
  const active = await f.execution(owner.binding, 'interrupted')
  const finished = await f.execution(owner.binding, 'finished')
  await f.command('execution.result', { binding: finished, output: { done: true } })
  const fixed = (await f.query({ kind: 'execution.get', executionId: finished.executionId })).runTiming
  const legacy = await f.execution(owner.binding, 'legacy')
  const db = new DatabaseSync(f.config.dbPath)
  db.prepare("UPDATE dynamic_executions SET body=json_remove(body,'$.runTiming','$.timeline') WHERE id=?").run(legacy.executionId)
  db.close()
  await f.command('execution.result', { binding: legacy, output: {} })
  await f.command('execution.drained', { binding: legacy })
  await f.command('execution.continue', { binding: owner.binding, executionId: legacy.executionId, key: 'legacy-next', prompt: 'Continue', input: {} })
  await f.command('execution.claim', { executionId: legacy.executionId })
  assert.equal((await f.query({ kind: 'execution.get', executionId: legacy.executionId })).runTiming, undefined)
  const legacyTimeline = (await f.query({ kind: 'execution.get', executionId: legacy.executionId })).timeline
  assert.equal(legacyTimeline.complete, false)
  assert.equal(legacyTimeline.segments.length, 1, 'collect only the newly observed claim, never the missing original run')
  assert.equal(latestExecutionRoundTiming(await f.query({ kind: 'execution.get', executionId: legacy.executionId })).active, true)
  await f.reopen()
  const interrupted = await f.query({ kind: 'execution.get', executionId: active.executionId })
  assert.equal(interrupted.runTiming.recorded, false)
  assert.equal(interrupted.runTiming.startedAt, null)
  assert.equal(latestExecutionRoundTiming(interrupted), null)
  await f.command('execution.drained', { binding: active })
  await f.command('execution.claim', { executionId: active.executionId })
  assert.equal((await f.query({ kind: 'execution.get', executionId: active.executionId })).runTiming.recorded, false)
  assert.equal(latestExecutionRoundTiming(await f.query({ kind: 'execution.get', executionId: active.executionId })).active, true)
  assert.deepEqual((await f.query({ kind: 'execution.get', executionId: finished.executionId })).runTiming, fixed)
})

test('failed round freezes at its first result, not at repeated receipt, drain or restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const f = await fixture(t), owner = await f.task(), binding = await f.execution(owner.binding, 'failed-timing')
  const round = async () => latestExecutionRoundTiming(await f.query({ kind: 'execution.get', executionId: binding.executionId }))
  const startedAt = (await round()).startedAt
  t.mock.timers.tick(3500)
  const args = { binding, error: { code: 'PERMANENT_FAILURE' } }
  await f.command('execution.result', args)
  const failed = await round()
  assert.deepEqual(failed, { startedAt, endedAt: new Date(Date.now()).toISOString(), active: false })
  assert.equal(Date.parse(failed.endedAt) - Date.parse(startedAt), 3500)
  t.mock.timers.tick(10000)
  await f.command('execution.result', args)
  await f.command('execution.drained', { binding })
  await f.reopen()
  assert.deepEqual(await round(), failed)
})


test('cancelled Host-interrupted task reopens only into bound readonly recovery, then audit permits business without replay', async t => {
 const f=await isolatedRestartLedger(t,false)
 await f.command('task.control',{taskId:f.binding.taskId,control:'cancelled',expectedControlRevision:1})
 const original=await f.query({kind:'operation.get',operationId:f.operationId})
 assert.equal((await f.query({kind:'task.get',taskId:f.binding.taskId})).restartRecoveryEligible,true)
 const reopened=(await f.command('task.reopen',{taskId:f.binding.taskId,request:'Resume stopped deployment task',expectedRequirementRevision:1,expectedControlRevision:2})).result.task
 assert.equal(reopened.control,'active');assert.equal(reopened.requirementRevision,2);assert.equal(reopened.controlRevision,3)
 assert.deepEqual(reopened.restartRecoveryOperations,[f.operationId])
 const owner=(await f.command('task.claim',{taskId:f.binding.taskId})).result
 await assert.rejects(f.command('execution.dispatch',{binding:owner.binding,key:'business',prompt:'write'}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 await assert.rejects(f.command('execution.dispatch',{binding:owner.binding,key:'foreign-read',prompt:'inspect',definition:{recoveryReadOnly:true},input:{readbackOperationId:'other'}}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 await assert.rejects(f.command('operation.prepare',{binding:owner.binding,operationId:'owner-write',key:'owner-write',definition:{toolName:'pwsh'}}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 const probe=(await f.command('execution.dispatch',{binding:owner.binding,key:'bound-probe',prompt:'fixed readonly probe',definition:{recoveryReadOnly:true},input:{readbackOperationId:f.operationId}})).result.execution
 const pb=(await f.command('execution.claim',{executionId:probe.executionId})).result.binding
 await f.command('execution.result',{binding:pb,output:{observed:true}});await f.command('execution.drained',{binding:pb})
 await f.command('task.wait',{binding:owner.binding,action:'blocked',summary:'Confirm scoped isolation',question:'Confirm audit',humanRequest:{requestId:'after-stop',audience:'operator',reason:'Host restart',attemptedActions:['Bound investigation']}})
 await f.command('task.drained',{binding:owner.binding})
 const confirm=structuredClone(f.confirm);confirm.requestId='after-stop';confirm.expectedRequirementRevision=2;confirm.expectedControlRevision=3;confirm.source.requestIdentity.humanRequestId='after-stop'
 await f.command('task.human.resolve-failures',confirm)
 const audited=await f.query({kind:'operation.get',operationId:f.operationId});assert.equal(audited.state,'unknown');assert.equal(audited.result,original.result)
 assert.deepEqual({...audited,recoverySettlement:undefined},{...original,recoverySettlement:undefined})
 const next=(await f.command('task.claim',{taskId:f.binding.taskId})).result
 assert.equal((await f.command('execution.dispatch',{binding:next.binding,key:'new-step',prompt:'new authorized business step'})).result.execution.status,'queued')
})


test('maintenance-cancelled drained task reopens explicitly without replaying execution', async t => {
 const f=await fixture(t),owner=await f.task()
 const binding=await f.execution(owner.binding,'completed-before-maintenance')
 await f.command('execution.result',{binding,output:{delivered:true}})
 await f.command('execution.drained',{binding})
 const original=await f.query({kind:'execution.get',executionId:binding.executionId})
 await f.command('task.wait',{binding:owner.binding,action:'wait',summary:'No interrupted operations'})
 await f.command('task.drained',{binding:owner.binding})
 await f.command('task.control',{taskId:'task',control:'cancelled',expectedControlRevision:1})
 assert.equal((await f.query({kind:'task.get',taskId:'task'})).restartRecoveryEligible,true)
 await assert.rejects(f.command('task.reopen',{taskId:'task',request:'Resume',expectedRequirementRevision:1,expectedControlRevision:1}),{code:'DYNAMIC_TASK_REVISION_STALE'})
 const args={taskId:'task',request:'Explicitly resume after deployment',expectedRequirementRevision:1,expectedControlRevision:2}
 const reopened=await f.command('task.reopen',args,'maintenance-reopen')
 assert.equal(reopened.result.task.status,'active');assert.equal(reopened.result.task.runSequence,2)
 assert.deepEqual(reopened.result.task.restartRecoveryOperations,[])
 assert.equal((await f.command('task.reopen',args,'maintenance-reopen')).replayed,true)
 assert.deepEqual(await f.query({kind:'execution.get',executionId:binding.executionId}),original)
 await f.reopen()
 assert.deepEqual(await f.query({kind:'execution.get',executionId:binding.executionId}),original)
})

test('maintenance reopen with a terminal native identity failure stays readonly until formal audit',async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='historical-identity-error'
 await f.command('execution.sessionBound',{binding})
 await f.command('operation.prepare',{binding,operationId,key:'original-call',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'original-call',toolName:'pwsh',resultDigest:'original-digest',isError:true,errorCode:'execution_background_identity_missing'}})
 await f.command('execution.result',{binding,output:{blocked:true}});await f.command('execution.drained',{binding})
 await f.command('task.wait',{binding:owner.binding,action:'wait',summary:'Preserve failure for audit'});await f.command('task.drained',{binding:owner.binding})
 await f.command('task.control',{taskId:'task',control:'cancelled',expectedControlRevision:1})
 const original=await f.query({kind:'operation.get',operationId})
 assert.equal((await f.query({kind:'task.get',taskId:'task'})).restartRecoveryEligible,true)
 const reopened=(await f.command('task.reopen',{taskId:'task',request:'Reconcile only',expectedRequirementRevision:1,expectedControlRevision:2})).result.task
 assert.deepEqual(reopened.restartRecoveryOperations,[operationId]);assert.deepEqual(await f.query({kind:'operation.get',operationId}),original)
 const current=(await f.command('task.claim',{taskId:'task'})).result
 await assert.rejects(f.command('execution.dispatch',{binding:current.binding,key:'business',prompt:'must not replay'}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 await assert.rejects(f.command('execution.dispatch',{binding:current.binding,key:'wrong-readback',prompt:'inspect',definition:{recoveryReadOnly:true},input:{readbackOperationId:'other'}}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 const readback=(await f.command('execution.dispatch',{binding:current.binding,key:'bound-readback',prompt:'inspect existing evidence',definition:{recoveryReadOnly:true},input:{readbackOperationId:operationId}})).result.execution
 assert.equal(readback.status,'queued');assert.equal((await f.query({kind:'operation.list'})).length,1)
 await f.reopen()
 assert.deepEqual(await f.query({kind:'operation.get',operationId}),original)
})

test('maintenance reopen reconciles finished cancelled job receipts without inventing success or replay',async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='finished-cancelled-job'
 await f.command('execution.sessionBound',{binding})
 await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 const job={jobId:'original-job',owner:binding.sessionId,startedAt:1,finishedAt:2,status:'completed',cancelled:true,detail:'exit code: 1'}
 await f.command('operation.job',{binding,operationId,job})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName:'pwsh',isError:false,jobReceipt:job,cancelled:true}})
 await f.command('execution.result',{binding,output:{blocked:true}});await f.command('execution.drained',{binding})
 await f.command('task.wait',{binding:owner.binding,action:'wait',summary:'Keep receipt facts'});await f.command('task.drained',{binding:owner.binding})
 await f.command('task.control',{taskId:'task',control:'cancelled',expectedControlRevision:1})
 const original=await f.query({kind:'operation.get',operationId})
 assert.equal((await f.query({kind:'task.get',taskId:'task'})).restartRecoveryEligible,true)
 await f.command('task.reopen',{taskId:'task',request:'Reconcile existing receipts only',expectedRequirementRevision:1,expectedControlRevision:2})
 const current=(await f.command('task.claim',{taskId:'task'})).result
 await assert.rejects(f.command('execution.dispatch',{binding:current.binding,key:'write',prompt:'do not replay'}),{code:'DYNAMIC_RESTART_RECOVERY_READ_ONLY'})
 assert.deepEqual(await f.query({kind:'operation.get',operationId}),original)
 const reconciled=(await f.command('operation.reconcile-job',{binding:current.binding,operationId})).result.operation
 assert.equal(reconciled.state,'cancelled');assert.equal(reconciled.result.partialEffectsPossible,true)
 assert.deepEqual(reconciled.result.jobReceipt,job);assert.deepEqual(reconciled.result.previousObservation,original.result)
 assert.equal((await f.query({kind:'execution.list'})).length,1)
 assert.equal((await f.command('execution.dispatch',{binding:current.binding,key:'new-business',prompt:'new authorized step'})).result.execution.status,'queued')
})

for(const failure of ['running-writer','unknown-error','missing-digest','foreign-session','foreign-task']) test('maintenance reopen rejects insufficient recovery evidence: '+failure,async t=>{
 const f=await fixture(t),owner=await f.task(),binding=await f.execution(owner.binding),operationId='unproven'
 await f.command('execution.sessionBound',{binding})
 await f.command('operation.prepare',{binding,operationId,key:'original',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'call',toolName:'pwsh',isError:true,
  errorCode:failure==='unknown-error'?'OTHER_FAILURE':'execution_background_identity_missing',...(failure==='missing-digest'?{}:{resultDigest:'digest'})}})
 if(failure!=='running-writer'){await f.command('execution.result',{binding,output:{blocked:true}});await f.command('execution.drained',{binding})}
 await f.command('task.wait',{binding:owner.binding,action:'wait',summary:'Preserve unknown'});await f.command('task.drained',{binding:owner.binding})
 await f.command('task.control',{taskId:'task',control:'cancelled',expectedControlRevision:1})
 if(failure==='foreign-session'||failure==='foreign-task'){
  const db=new DatabaseSync(f.config.dbPath),op=JSON.parse(db.prepare('SELECT body FROM dynamic_operations WHERE id=?').get(operationId).body)
  op.dispatchBinding[failure==='foreign-task'?'taskId':'sessionId']='foreign';db.prepare('UPDATE dynamic_operations SET body=? WHERE id=?').run(JSON.stringify(op),operationId);db.close()
 }
 assert.notEqual((await f.query({kind:'task.get',taskId:'task'})).restartRecoveryEligible,true)
 await assert.rejects(f.command('task.reopen',{taskId:'task',request:'Must remain stopped',expectedRequirementRevision:1,expectedControlRevision:2}),{code:'DYNAMIC_TASK_NOT_QUIESCENT'})
 assert.equal((await f.query({kind:'operation.get',operationId})).state,'unknown')
})

test('maintenance reopen retains an audited unknown Host job beside a native failure',async t=>{
 const f=await isolatedRestartLedger(t,true)
 await f.command('task.human.resolve-failures',f.confirm)
 const retained=await f.query({kind:'operation.get',operationId:f.operationId})
 const owner=(await f.command('task.claim',{taskId:f.binding.taskId})).result,binding=await f.execution(owner.binding,'native-error'),operationId='later-native-error'
 await f.command('execution.sessionBound',{binding})
 await f.command('operation.prepare',{binding,operationId,key:'native-error',definition:{toolName:'pwsh',argumentsDigest:'args'},resourceKeys:[]})
 await f.command('operation.start',{binding,operationId})
 await f.command('operation.settle',{binding,operationId,state:'unknown',result:{callId:'error-call',toolName:'pwsh',isError:true,resultDigest:'digest',errorCode:'execution_background_identity_missing'}})
 await f.command('execution.result',{binding,output:{blocked:true}});await f.command('execution.drained',{binding})
 await f.command('task.wait',{binding:owner.binding,action:'wait',summary:'Historical audit only'});await f.command('task.drained',{binding:owner.binding})
 await f.command('task.control',{taskId:f.binding.taskId,control:'cancelled',expectedControlRevision:1})
 const reopened=(await f.command('task.reopen',{taskId:f.binding.taskId,request:'Close historical native failure only',expectedRequirementRevision:1,expectedControlRevision:2})).result.task
 assert.deepEqual(reopened.restartRecoveryOperations,[operationId])
 assert.deepEqual(await f.query({kind:'operation.get',operationId:f.operationId}),retained)
 assert.equal(retained.state,'unknown');assert.equal(retained.job.status,'running');assert.equal(hasRestartIsolation(retained),true)
})
