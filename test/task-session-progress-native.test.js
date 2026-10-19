import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { requestSystemText } from './fixtures/session-persistence.js'
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
  assert.equal((await h.query('execution.get', { executionId })).feedback?.length ?? 0, 0)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(checked.progressReview.checkedAt) })
  try { await h.service.recover() } finally { t.mock.timers.reset() }
  assert.equal((await h.query('wake.list', { taskId: created.taskId })).filter(wake => wake.kind === 'execution.progress.review').length, 1)
  assert.equal((await h.query('execution.get', { executionId })).progressReview.checkedAt, checked.progressReview.checkedAt)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal((await h.query('execution.list')).length, 1)
})

for (const detour of [false, true]) test(`scripted progress decision waits for evidence or steers the original execution once: detour=${detour}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-direction-native-')), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  const target = join(root, 'verified-target.txt')
  await writeFile(target, 'VERIFIED_TARGET_UNCHANGED')
  const extraTarget = join(root, 'unrelated-extra.txt')
  await writeFile(extraTarget, 'UNREQUESTED_EXTRA_CHECK')
  let delegated = false, steps = 0, reviews = 0
  const phases = new Map()
  const h = await nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      steps++
      if (steps === 1) return [call('read', { file_path: target })]
      if (detour && steps === 2) return [call('read', { file_path: extraTarget })]
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '沿原目标核对完成', evidence: ['VERIFIED_TARGET_UNCHANGED'], limitations: [], artifacts: [] } })]
    }
    const policy = requestSystemText(request)
    assert.match(policy, /有必要的新验证不算绕路/)
    assert.match(policy, /方向正常或证据不足时用wait/)
    assert.match(policy, /相同意见尚未消费，或已给出且没有新证据时不重发/)
    const input = latestInput(request)
    if (!delegated) { delegated = true; return [call('task_delegate', { key: 'original-direction', objective: '只核对verified-target.txt后直接报告，不读取其他无关文件' })] }
    if (input.executions.length && input.executions.every(execution => execution.drained && execution.status === 'succeeded')) return [submit('complete')]
    const execution = input.executions[0]
    if (!execution || !input.wakes.some(wake => wake.kind === 'execution.progress.review')) return [submit('wait')]
    const review = JSON.stringify(input.wakes.filter(wake => wake.kind === 'execution.progress.review')), phase = phases.get(review) ?? 0
    phases.set(review, phase + 1)
    if (phase === 0) return [call('task_execution_progress', { executionId: execution.executionId })]
    if (phase === 1) return [call('task_execution_read', { executionId: execution.executionId })]
    if (detour && phase === 3) return [call('task_execution_read', { executionId: execution.executionId })]
    // Scripted decisions inspect actual native tool values, not model inference.
    const progress = h.toolResults.findLast(item => item.name === 'task_execution_progress')?.result.value
    const record = h.toolResults.findLast(item => item.name === 'task_execution_read')?.result.value
    assert.ok(progress && record)
    for (const feedback of record.feedback) {
      assert.equal(feedback.consumedAt, null)
      assert.equal(feedback.modelStepEnteredAt, null)
      assert.equal(feedback.sequence, null)
    }
    const extraReads = progress.excerpts.filter(event => event.type === 'tool/call' && event.preview.includes('unrelated-extra.txt'))
    if (detour && !record.feedback.length) {
      assert.equal(extraReads.length, 1, 'scripted decision is backed by an actual off-target read')
      return [call('task_delegate', { executionId: execution.executionId, feedback: true, key: 'direction-same-file',
        objective: '原目标不变：日志显示读取无关文件，省略额外检查，直接报告目标文件的核对结果。' })]
    }
    if (!detour) assert.equal(extraReads.length, 0, 'one requested read and silence do not prove detour')
    reviews++
    return [submit('wait')]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'direction-review', objective: '核对文件并简短报告' })
  await waitUntil(() => steps >= (detour ? 3 : 2), 'executor holds its original native model call')
  await waitUntil(async () => (await h.query('task.get', { taskId: created.taskId })).drained, 'owner submits initial wait before inspection')
  const [before] = await h.query('execution.list')
  for (let round = 1; round <= 2; round++) {
    const current = await h.query('execution.get', { executionId: before.executionId })
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(current.progressReview?.checkedAt ?? current.updatedAt) + 600000 })
    try { await h.service.recover() } finally { t.mock.timers.reset() }
    await waitUntil(async () => reviews === round && (await h.query('task.get', { taskId: created.taskId })).drained, 'original owner finishes progress review').catch(error => {
      error.message += JSON.stringify({ reviews, phases: [...phases], alerts: h.service.listAlerts(), tools: h.toolResults.filter(item => item.result.isError).slice(-3) })
      throw error
    })
  }
  const [checked] = await h.query('execution.list')
  assert.equal((await h.query('task.list')).length, 1)
  assert.equal((await h.query('execution.list')).length, 1)
  for (const key of ['executionId', 'sessionId', 'inputVersion', 'leaseEpoch']) assert.equal(checked[key], before[key])
  assert.equal(checked.cancelRequested, false)
  assert.equal(checked.feedback?.length ?? 0, detour ? 1 : 0, 'second inspection must not repeat pending advice')
  gate.resolve(); await h.service.whenIdle()
  const after = await h.query('execution.get', { executionId: before.executionId })
  if (detour) assert.ok(after.feedback[0].modelStepEnteredAt, 'advice enters the original native model step')
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
})
