import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { executionProgressDue } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
const call = (name, args) => ({ name, args })
const submit = action => call('task_session_submit', { decision: { action, summary: action === 'complete' ? '已核验原执行目标及结果' : '按真实日志核对方向，继续等待原执行', evidence: [], limitations: [] } })

test('execution progress due is exactly ten minutes and respects the current running lifecycle', () => {
  const execution = { status: 'running', drained: false, updatedAt: '2026-10-14T00:00:00Z' }, start = Date.parse(execution.updatedAt)
  assert.equal(executionProgressDue(execution, start + 599999), false)
  assert.equal(executionProgressDue(execution, start + 600000), true)
  assert.equal(executionProgressDue({ ...execution, progressReview: { checkedAt: new Date(start + 600000).toISOString() } }, start + 600000), false)
  for (const extra of [{ status: 'succeeded' }, { drained: true }, { recovering: true }, { cancelRequested: true }]) assert.equal(executionProgressDue({ ...execution, ...extra }, start + 600000), false)
})

for (const humanWait of [false, true]) test(`native progress review reads actual tool records without replaying or bypassing human wait: ${humanWait}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-progress-native-')), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  await writeFile(join(root, 'actual-target.txt'), 'ACTUAL_PROGRESS_DIRECTION_READ_ONLY')
  let ownerTurns = 0, executionSteps = 0, reviewSteps = 0, executionId, progressInput
  const h = await nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (!names.includes('task_delegate')) {
      if (++executionSteps === 1) return [call('read', { file_path: join(root, 'actual-target.txt') })]
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原目标真实只读结果', evidence: ['ACTUAL_PROGRESS_DIRECTION_READ_ONLY'], limitations: [], artifacts: [] } })]
    }
    ownerTurns++
    const input = latestInput(request)
    if (ownerTurns === 1) return [call('task_delegate', { key: 'original-read', objective: '读取实际文件检查只读方向，不修改文件' })]
    if (!input.executions.length) return humanWait ? [call('task_request_human', {
      reason: '后续范围需人工明确', question: '后续是否继续仅核对现有结果？', evidence: [], attemptedActions: ['已委派原只读核对'] })] : [submit('wait')]
    executionId = input.executions[0].executionId
    if (input.executions.every(execution => execution.drained)) return [submit('complete')]
    if (humanWait && !input.task.humanRequests?.some(item => item.status === 'answered')) return [call('task_request_human', {
      reason: '原执行运行中，后续范围需人工明确', question: '后续是否继续仅核对现有结果？', evidence: [], attemptedActions: ['已委派原只读核对'] })]
    if (input.wakes.some(wake => wake.kind === 'execution.progress.review')) {
      progressInput = input
      reviewSteps++
      if (reviewSteps === 1) return [submit('wait')]
      if (reviewSteps === 2) {
        assert.match(JSON.stringify(request.messages), /TASK_EXECUTION_PROGRESS_REVIEW_REQUIRED/)
        return [call('task_execution_progress', { executionId })]
      }
      assert.match(JSON.stringify(request.messages), /actual-target\.txt/)
      return [submit('wait')]
    }
    return [submit('wait')]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'progress-native', objective: '核对执行的真实动作和方向' })
  await waitUntil(() => ownerTurns >= 2 && executionSteps >= 2, 'owner waiting while the actual read execution remains running')
  const [before] = await h.query('execution.list')
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(before.updatedAt) + 599999 })
  try { await h.service.recover() } finally { t.mock.timers.reset() }
  assert.equal((await h.query('execution.get', { executionId: before.executionId })).progressReview, undefined)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(before.updatedAt) + 600000 })
  try { await h.service.recover() } finally { t.mock.timers.reset() }
  const checked = await h.query('execution.get', { executionId: before.executionId })
  assert.ok(checked.progressReview)
  assert.equal(checked.status, 'running')
  assert.equal(checked.drained, false)
  assert.equal(checked.progressReview.readError, undefined, JSON.stringify({ expected: { executionId: before.executionId, inputVersion: before.inputVersion, leaseEpoch: before.leaseEpoch, inputDigest: before.inputDigest, sessionId: before.sessionId },
    inputs: (await inspectSession(h.ctx.sessionPersistence, before.sessionId)).events.filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, source: event.data.source })) }))
  assert.ok(checked.progressReview.lastSequence >= 0)
  if (humanWait) {
    assert.equal(ownerTurns, 2)
    const task = await h.query('task.get', { taskId: created.taskId }), request = task.humanRequests[0]
    assert.equal(request.status, 'waiting-reply')
    await h.service.respondHumanRequest({ taskId: task.taskId, humanRequestId: request.requestId, requestId: 'progress-human-reply', reply: '仅核对原有结果，不追加写入', expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision })
  }
  await waitUntil(() => reviewSteps >= 3, 'owner corrects status-only submission and reads actual progress records')
  assert.ok(progressInput.executions[0].input.objective.includes('只读方向'))
  const result = h.toolResults.findLast(item => item.name === 'task_execution_progress' && !item.result.isError)
  assert.ok(result)
  assert.match(JSON.stringify(result.result), /tool\/call/)
  assert.match(JSON.stringify(result.result), /actual-target\.txt/)
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal((await h.query('execution.get', { executionId })).cancelRequested, false)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(checked.progressReview.checkedAt) })
  try { await h.service.recover() } finally { t.mock.timers.reset() }
  assert.equal((await h.query('wake.list', { taskId: created.taskId })).filter(wake => wake.kind === 'execution.progress.review').length, 1)
  assert.equal((await h.query('execution.get', { executionId })).progressReview.checkedAt, checked.progressReview.checkedAt)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal((await h.query('execution.list')).length, 1)
})
