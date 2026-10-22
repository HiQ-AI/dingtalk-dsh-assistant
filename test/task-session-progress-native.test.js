import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { requestSystemText } from './fixtures/session-persistence.js'
import { executionProgressDue } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
const call = (name, args) => ({ name, args })
const submit = action => call('task_session_submit', { decision: { action, summary: action === 'complete' ? '已核验原执行目标及结果' : '按当前执行文档核对职责与证据，继续等待原执行', evidence: [], limitations: [] } })

// 巡检仍只观察原执行；结束后两个独立只读职责满足当前团队完成合同。
function completionReviews(proof) {
  const read = new Set(); let delegated = false
  const roles = ['独立核对证据文件', '独立核对原始要求']
  return {
    execution(input) {
      const index = roles.indexOf(input.objective)
      if (index < 0) return null
      const path = index === 0 ? proof : input.materialPaths[0]
      assert.ok(path)
      if (!read.has(index)) { read.add(index); return [call('read', { file_path: path })] }
      return [call('execution_submit', { output: { status: 'completed', summary: `${roles[index]}已读取原始材料`, evidence: [path], limitations: [], artifacts: [] } })]
    },
    owner(input) {
      if (!input.executions.every(item => item.status === 'succeeded' && item.drained)) return [submit('wait')]
      if (input.executionCount >= 3) return [submit('complete')]
      if (delegated) return [submit('wait')]
      delegated = true
      return [...roles.map((objective, index) => call('task_delegate', { key: `completion-review-${index}`, objective })), submit('wait')]
    },
  }
}

test('execution progress due is exactly ten minutes and respects the current running lifecycle', () => {
  const execution = { status: 'running', drained: false, updatedAt: '2026-10-14T00:00:00Z' }, start = Date.parse(execution.updatedAt)
  assert.equal(executionProgressDue(execution, start + 599999), false)
  assert.equal(executionProgressDue(execution, start + 600000), true)
  assert.equal(executionProgressDue({ ...execution, progressReview: { checkedAt: new Date(start + 600000).toISOString() } }, start + 600000), false)
  for (const extra of [{ status: 'succeeded' }, { drained: true }, { recovering: true }, { cancelRequested: true }]) assert.equal(executionProgressDue({ ...execution, ...extra }, start + 600000), false)
})

test('native execution documents keep each input round and the owner reads the new duty and plan', { skip: !available ? reason : false, timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-round-documents-')), target = join(root, 'proof.txt')
  await writeFile(target, 'ROUND_EVIDENCE_UNCHANGED')
  const steps = new Map(), ownerReads = new Set()
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  let firstIdentity, firstDocument, firstHash, continued = false, completed = false, initialProgressSteps = 0
  const h = await nativeTaskHost(root, async (request, host) => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const [execution] = await host.query('execution.list', { taskId: input.task.taskId })
      if (!execution) return [call('task_delegate', { key: 'document-round-one', objective: 'ROUND_ONE_DUTY：核对当前证据文件', context: '只读proof.txt并报告本轮计划、证据和限制。' }), submit('wait')]
      if (initialProgressSteps === 0) {
        assert.equal(execution.progressReview, undefined, '首次主动读取不依赖十分钟巡检记录')
        initialProgressSteps++
        return [call('task_execution_progress', { executionId: execution.executionId })]
      }
      if (initialProgressSteps === 1) {
        initialProgressSteps++
        const progress = host.toolResults.findLast(item => item.name === 'task_execution_progress')
        assert.ok(progress && !progress.result.isError, '无progressReview时也必须返回合法工具结果')
        assert.equal(progress.result.value.progressReview, undefined)
        return [call('read', { file_path: progress.result.value.document.path })]
      }
      if (initialProgressSteps === 2) {
        initialProgressSteps++
        const read = host.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
        assert.ok(read && !read.result.isError)
        assert.match(JSON.stringify(read.result), /ROUND_ONE_DUTY/)
      }
      if (!execution.drained || execution.status !== 'succeeded') return [submit('wait')]
      const document = input.executions.find(item => item.executionId === execution.executionId)?.document
      assert.ok(document?.path)
      if (!ownerReads.has(execution.inputVersion)) {
        ownerReads.add(execution.inputVersion)
        return [call('read', { file_path: document.path })]
      }
      const read = host.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
      assert.ok(read && !read.result.isError)
      assert.match(JSON.stringify(read.result), new RegExp(`ROUND_${execution.inputVersion}_RESULT`))
      if (!continued) {
        firstIdentity = { executionId: execution.executionId, sessionId: execution.sessionId }
        firstDocument = document.path; firstHash = hash(await readFile(firstDocument)); continued = true
        return [call('task_delegate', { key: 'document-round-two', executionId: execution.executionId,
          objective: 'ROUND_TWO_DUTY：复核交付标识与限制', context: '新职责只读复核proof.txt，不沿用上一轮计划和成果为当前事实。' }), submit('wait')]
      }
      completed = true
      return [submit('complete')]
    }
    const version = input.executionDocument.inputVersion, step = steps.get(version) ?? 0
    steps.set(version, step + 1)
    const [currentExecution] = await host.query('execution.list', { taskId: input.task.taskId })
    assert.equal(input.executionDocument.path, join(root, 'tasks', input.task.taskId, 'outputs', currentExecution.executionId, `round-${version}.md`))
    if (step === 0) return [call('read', { file_path: input.executionDocument.path })]
    if (step === 1) {
      const current = host.toolResults.findLast(item => item.name === 'read' && item.sessionId !== input.task.sessionId)
      assert.match(JSON.stringify(current.result), /尚未报告计划/)
      if (version === 2) assert.doesNotMatch(JSON.stringify(current.result), /ROUND_1_PLAN|ROUND_1_RESULT/)
      return [call('execution_report_progress', { plan: `ROUND_${version}_PLAN：读取proof.txt，核对标识并提交限制。`,
        summary: '已读取本轮职责，准备核对当前证据。', evidence: [input.executionDocument.path], activity: '核对当前证据' })]
    }
    if (step === 2) return [call('read', { file_path: target })]
    if (step === 3) return [call('execution_report_progress', { summary: `ROUND_${version}_PROGRESS：已读到ROUND_EVIDENCE_UNCHANGED。`, evidence: [target], activity: '提交本轮结果' })]
    return [call('execution_submit', { output: { status: 'completed', summary: `ROUND_${version}_RESULT`, evidence: [target], limitations: ['只核对本轮证据，不部署或发送'], artifacts: [] } })]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'round-documents', objective: '沿原执行分两轮核对不同职责，并保留每轮执行文档' })
  await h.service.whenIdle()
  assert.equal(completed, true, JSON.stringify({ alerts: h.service.listAlerts(), errors: h.toolResults.filter(item => item.result.isError) }))
  assert.equal(initialProgressSteps, 3)
  assert.ok(!h.toolResults.some(item => item.name === 'task_execution_progress' && item.result.isError), '文档查询不产生INVALID_TOOL_OUTPUT')
  const [execution] = await h.query('execution.list', { taskId: task.taskId })
  assert.equal((await h.query('execution.list', { taskId: task.taskId })).length, 1)
  assert.equal(execution.definition.executionBackend, 'dsh')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', 'One member can finish after both document rounds are verified')
  assert.deepEqual({ executionId: execution.executionId, sessionId: execution.sessionId }, firstIdentity)
  assert.equal(execution.inputVersion, 2)
  assert.equal(hash(await readFile(firstDocument)), firstHash)
  const secondPath = join(root, 'tasks', task.taskId, 'outputs', execution.executionId, 'round-2.md')
  const first = await readFile(firstDocument, 'utf8'), second = await readFile(secondPath, 'utf8')
  assert.match(first, /ROUND_ONE_DUTY/); assert.match(first, /ROUND_1_PLAN/); assert.match(first, /ROUND_1_RESULT/)
  assert.match(second, /ROUND_TWO_DUTY/); assert.match(second, /ROUND_2_PLAN/); assert.match(second, /ROUND_2_PROGRESS/); assert.match(second, /ROUND_2_RESULT/)
  assert.doesNotMatch(second, /ROUND_1_PLAN|ROUND_1_RESULT/)
  assert.deepEqual([...ownerReads], [1, 2], '统筹通过原生read分别读取两轮实际文档')
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).length, 0, 'Host文档投影和只读验证不产生业务写入')
  await h.service.recover(); await h.service.whenIdle()
  assert.equal(hash(await readFile(firstDocument)), firstHash, '恢复只刷新当前轮，不能改写旧轮字节')
})

for (const humanWait of [false, true]) test(`native progress review reads the current execution document without replaying or bypassing human wait: ${humanWait}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-progress-native-')), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  await writeFile(join(root, 'actual-target.txt'), 'ACTUAL_PROGRESS_DIRECTION_READ_ONLY')
  const reviewers = completionReviews(join(root, 'actual-target.txt'))
  let ownerTurns = 0, executionSteps = 0, reviewSteps = 0, executionId, progressInput
  const h = await nativeTaskHost(root, async request => {
    const names = request.tools.map(tool => tool.name)
    if (!names.includes('task_delegate')) {
      const review = reviewers.execution(latestInput(request)); if (review) return review
      if (++executionSteps === 1) return [call('read', { file_path: join(root, 'actual-target.txt') })]
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原目标真实只读结果', evidence: ['ACTUAL_PROGRESS_DIRECTION_READ_ONLY'], limitations: [], artifacts: [] } })]
    }
    ownerTurns++
    const input = latestInput(request)
    if (ownerTurns === 1) return [call('task_delegate', { key: 'original-read', objective: '读取actual-target.txt实际文件检查只读方向，不修改文件' })]
    if (!input.executions.length) return humanWait ? [call('task_request_human', {
      reason: '后续范围需人工明确', question: '后续是否继续仅核对现有结果？', evidence: [], attemptedActions: ['已委派原只读核对'] })] : [submit('wait')]
    executionId = input.executions[0].executionId
    if (input.executions.every(execution => execution.drained)) return reviewers.owner(input)
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
      if (reviewSteps === 3) {
        const progress = h.toolResults.findLast(item => item.name === 'task_execution_progress')?.result.value
        assert.equal(progress.document.inputVersion, input.executions[0].inputVersion)
        return [call('read', { file_path: progress.document.path })]
      }
      const documentRead = h.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
      assert.ok(documentRead && !documentRead.result.isError, '统筹实际通过原生read读取执行文档')
      assert.match(JSON.stringify(documentRead.result), /本轮小目标/); assert.match(JSON.stringify(documentRead.result), /actual-target\.txt/)
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
  await waitUntil(() => reviewSteps >= 4, 'owner corrects status-only submission and natively reads the current execution document')
  const directionRead = h.toolResults.findLast(item => item.name === 'read' && item.sessionId === progressInput.task.sessionId)
  assert.match(JSON.stringify(directionRead.result), /只读方向/, '小目标从实际执行文档核对，不依赖重复内联正文')
  const result = h.toolResults.findLast(item => item.name === 'task_execution_progress' && !item.result.isError)
  assert.ok(result)
  assert.equal(result.result.value.document.path, join(root, 'tasks', created.taskId, 'outputs', before.executionId, 'round-1.md'))
  assert.equal(result.result.value.document.inputVersion, 1)
  assert.equal(result.result.value.excerpts, undefined, '日常巡检不回灌原始工具日志')
  assert.equal(result.result.value.sessionLogRoot, undefined)
  assert.equal(progressInput.executions[0].document.path, result.result.value.document.path)
  assert.equal((await h.query('execution.list')).length, 1)
  assert.equal((await h.query('execution.get', { executionId })).cancelRequested, false)
  assert.equal((await h.query('execution.get', { executionId })).feedback?.length ?? 0, 0)
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(checked.progressReview.checkedAt) })
  try { await h.service.recover() } finally { t.mock.timers.reset() }
  assert.equal((await h.query('wake.list', { taskId: created.taskId })).filter(wake => wake.kind === 'execution.progress.review').length, 1)
  assert.equal((await h.query('execution.get', { executionId })).progressReview.checkedAt, checked.progressReview.checkedAt)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  const completed = await h.query('execution.list')
  assert.equal(completed.length, 3)
  assert.equal(completed.filter(item => item.key === 'original-read').length, 1, 'completion reviews do not replace or duplicate the inspected execution')
})

for (const detour of [false, true]) test(`scripted progress decision waits for evidence or steers the original execution once: detour=${detour}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-direction-native-')), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  const target = join(root, 'verified-target.txt')
  await writeFile(target, 'VERIFIED_TARGET_UNCHANGED')
  const reviewers = completionReviews(target)
  const extraTarget = join(root, 'unrelated-extra.txt')
  await writeFile(extraTarget, 'UNREQUESTED_EXTRA_CHECK')
  let delegated = false, steps = 0, reviews = 0
  const phases = new Map(), judgments = []
  const h = await nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      const review = reviewers.execution(latestInput(request)); if (review) return review
      steps++
      if (steps === 1) return [call('read', { file_path: target })]
      if (detour && steps === 2) return [call('read', { file_path: extraTarget })]
      if (steps === (detour ? 3 : 2)) return [call('execution_report_progress', { plan: '只读verified-target.txt，核对标识后提交证据，不扩大范围。',
        summary: detour ? '已读取verified-target.txt，也读取了范围外的unrelated-extra.txt；尚未提交结果。' : '已读取verified-target.txt并看到VERIFIED_TARGET_UNCHANGED；尚未提交结果。',
        evidence: [target, ...(detour ? [extraTarget] : [])], activity: '等待提交原核对结果' })]
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '沿原目标核对完成', evidence: ['VERIFIED_TARGET_UNCHANGED'], limitations: [], artifacts: [] } })]
    }
    const policy = requestSystemText(request)
    assert.match(policy, /有必要的新验证不算绕路/)
    assert.match(policy, /方向正常或证据不足时用wait/)
    assert.match(policy, /相同意见尚未消费，或已给出且没有新证据时不重发/)
    const input = latestInput(request)
    if (!delegated) { delegated = true; return [call('task_delegate', { key: 'original-direction', objective: '只核对verified-target.txt后直接报告，不读取其他无关文件' })] }
    if (input.executions.length && input.executions.every(execution => execution.drained && execution.status === 'succeeded')) return reviewers.owner(input)
    const execution = input.executions[0]
    if (!execution || !input.wakes.some(wake => wake.kind === 'execution.progress.review')) return [submit('wait')]
    const review = JSON.stringify(input.wakes.filter(wake => wake.kind === 'execution.progress.review')), phase = phases.get(review) ?? 0
    phases.set(review, phase + 1)
    if (phase === 0) return [call('task_execution_progress', { executionId: execution.executionId })]
    if (phase === 1) {
      const progress = h.toolResults.findLast(item => item.name === 'task_execution_progress')?.result.value
      assert.equal(progress.document.inputVersion, execution.inputVersion)
      return [call('read', { file_path: progress.document.path })]
    }
    if (phase === 2) return [call('task_execution_read', { executionId: execution.executionId })]
    if (phase === 3) return [call('task_decisions_read', { limit: 10 })]
    if (detour && phase === 5) return [call('task_execution_read', { executionId: execution.executionId })]
    // Scripted decisions inspect actual native tool values, not model inference.
    const progress = h.toolResults.findLast(item => item.name === 'task_execution_progress')?.result.value
    const record = h.toolResults.findLast(item => item.name === 'task_execution_read')?.result.value
    const history = h.toolResults.findLast(item => item.name === 'task_decisions_read')?.result.value
    assert.ok(progress && record)
    assert.equal(history.taskId, input.task.taskId)
    assert.ok(history.decisions.length >= reviews + 1, 'each prior owner decision remains available through the actual tool')
    assert.ok(history.decisions.every(item => item.decision.summary && Array.isArray(item.decision.evidence)
      && Array.isArray(item.decision.limitations)))
    for (const previous of judgments) {
      const saved = history.decisions.find(item => item.decision.summary === previous.summary)?.decision
      assert.ok(saved, 'the next inspection reads each previous judgment')
      assert.deepEqual({ action: saved.action, summary: saved.summary, evidence: saved.evidence, limitations: saved.limitations }, previous,
        'the stored judgment retains its explanation and unknowns in addition to Host metadata')
    }
    for (const feedback of record.feedback) {
      assert.equal(feedback.consumedAt, null)
      assert.equal(feedback.modelStepEnteredAt, null)
      assert.equal(feedback.sequence, null)
    }
    const documentRead = h.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
    assert.ok(documentRead && !documentRead.result.isError)
    const documentText = JSON.stringify(documentRead.result)
    assert.match(documentText, /本轮计划/); assert.match(documentText, /VERIFIED_TARGET_UNCHANGED|unrelated-extra\.txt/)
    assert.equal(progress.excerpts, undefined, '统筹日常巡检只拿文档引用，不读原生日志摘录')
    assert.equal(record.document.path, progress.document.path)
    const extraReads = documentText.includes('unrelated-extra.txt') ? 1 : 0
    if (detour && !record.feedback.length) {
      assert.equal(extraReads, 1, '纠偏依据为实际read进入模型的当前文档报告')
      return [call('task_delegate', { executionId: execution.executionId, feedback: true, key: 'direction-same-file',
        objective: '原目标不变：当前执行文档记录读取无关文件，省略额外检查，直接报告目标文件的核对结果。' })]
    }
    if (!detour) assert.equal(extraReads, 0, '一次目标读取及无新报告不足以证明绕路')
    reviews++
    const decision = { action: 'wait', summary: `第${reviews}次巡检：` + (detour
      ? reviews === 1 ? '首次发现无关读取，已向原执行发出纠偏，尚未确认落实' : '原反馈仍待消费且没有新动作，不重复投递'
      : reviews === 1 ? '已读取目标文件，等待原执行结果' : '没有新增结果，不能仅据无新报告判定卡死'),
    evidence: [`executionId=${execution.executionId}`, `document=${progress.document.path}`, `sha256=${progress.document.sha256}`, `offTargetReads=${extraReads}`],
    limitations: ['原执行尚未提交结果；下一检查点为原执行的真实动作与结果，而非反馈回执'] }
    judgments.push(decision)
    return [call('task_session_submit', { decision })]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const created = await h.service.createTask({ groupId: 'native-group', requestId: 'direction-review', objective: '核对文件并简短报告' })
  await waitUntil(() => steps >= (detour ? 4 : 3), 'executor reports its current plan and holds its original native model call')
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
  const history = await h.query('task.decisions', { taskId: created.taskId })
  const savedJudgments = history.decisions.map(item => item.decision).filter(decision => decision.summary.startsWith('第'))
    .map(({ action, summary, evidence, limitations }) => ({ action, summary, evidence, limitations }))
  assert.deepEqual(savedJudgments, judgments.toReversed(), 'both inspections retain their distinct decisions, explanations and limits')
  gate.resolve(); await h.service.whenIdle()
  const after = await h.query('execution.get', { executionId: before.executionId })
  if (detour) assert.ok(after.feedback[0].modelStepEnteredAt, 'advice enters the original native model step')
  assert.equal((await h.query('task.get', { taskId: created.taskId })).status, 'completed')
  assert.equal((await h.query('execution.list')).length, 3)
})
