import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil, contextReadResponse, topicSummaryResponse } from './fixtures/task-session-native-host.js'
const call = (name, args) => ({ name, args })
const toolText = value => typeof value === 'string' ? value : value && typeof value === 'object' ? Object.values(value).map(toolText).join('\n') : ''
const submit = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })

function completionReviews(proof) {
  const read = new Set(); let delegated = false
  const roles = ['独立核对阶段证据', '独立核对原始要求']
  return {
    execution(input) {
      const index = roles.indexOf(input.objective)
      if (index < 0) return null
      const path = index === 0 ? proof : input.materialPaths[0]
      assert.ok(path)
      if (!read.has(index)) { read.add(index); return [call('read', { file_path: path })] }
      return [call('execution_submit', { output: { status: 'completed', summary: `${roles[index]}已读取原始材料`, evidence: [path], limitations: [], artifacts: [] } })]
    },
    owner(input, summary) {
      if (!input.executions.every(item => item.status === 'succeeded' && item.drained)) return [submit('wait', '等待独立核对结果')]
      if (input.executionCount >= 3) return [submit('complete', summary)]
      if (delegated) return [submit('wait', '等待独立核对结果')]
      delegated = true
      return [...roles.map((objective, index) => call('task_delegate', { key: `completion-review-${index}`, objective })), submit('wait', '已安排独立核对')]
    },
  }
}

test('integrated stage evidence survives same-session provider recovery with new version binding and no duplicate operation', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'integrated-stage-provider-')), gate = Promise.withResolvers()
  const proof = join(root, 'proof.txt'); await writeFile(proof, 'INTEGRATED_STAGE_PROOF')
  const reviewers = completionReviews(proof)
  let steps = 0, sequence = 0
  const ownerInputs = [], documentReads = new Map()
  // 统筹配置优先于默认 Agent 配置；两者必须进入同一恢复测试 provider。
  const h = await nativeTaskHost(root, async () => [], { config: { provider: 'integrated-stage-provider' }, agentConfig: { provider: 'integrated-stage-provider' }, serviceFactory: async options => {
    class Provider extends LlmAdapter {
      // 原生统筹预检按实际能力解析推理深度；恢复夹具也须声明其支持的 low。
      resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' } } }
      async *stream(request) {
        if (yield* topicSummaryResponse(request, h.auxiliaryRequests)) return
          if (yield* contextReadResponse(request)) return
        let calls
        if (request.tools.some(tool => tool.name === 'task_delegate')) {
          const input = latestInput(request); ownerInputs.push(input)
          if (!input.executions.length) calls = [call('task_delegate', { key: 'original', objective: 'Read original proof and report confirmed stages' }), submit('wait', '等待原执行')]
          else if (input.executions.every(item => item.drained && item.status === 'succeeded')) calls = reviewers.owner(input, '已核对最终只读结果')
          else if (input.wakes.some(item => item.kind === 'execution.stage.progress')) {
            const member = input.executions[0], key = member.inputVersion
            if (!documentReads.has(key)) { documentReads.set(key, null); calls = [call('read', { file_path: member.document.path })] }
            else {
              const read = h.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
              assert.ok(read && !read.result.isError)
              const text = toolText(read.result)
              assert.match(text, /已核对第一阶段证据|恢复后已复核原证据/)
              assert.ok(text.includes(proof))
              documentReads.set(key, { path: member.document.path, text })
              calls = [submit('wait', '已读取本轮执行文档核对阶段证据，继续原目标')]
            }
          } else calls = [submit('wait', '等待受管恢复')]
        } else {
          const review = reviewers.execution(latestInput(request))
          if (review) calls = review
          else {
          const step = steps++
          if (step === 2) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'fixture server temporarily unavailable' } } }; return }
          if (step === 0 || step === 3) calls = [call('read', { file_path: proof })]
          else if (step === 1 || step === 4) calls = [call('execution_report_progress', { summary: step === 1 ? '已核对第一阶段证据' : '恢复后已复核原证据', evidence: [proof] })]
          else { await gate.promise; calls = [call('execution_submit', { output: { status: 'completed', summary: '只读证据核验完成', evidence: [proof], limitations: [], artifacts: [] } })] }
          }
        }
        for (const [index, tool] of calls.entries()) {
          const id = 'integrated-' + ++sequence, args = JSON.stringify(tool.args)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: tool.name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: tool.name, arguments: args } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    options.ctx.llm.registerAdapter(['integrated-stage-provider'], new Provider())
    return openTaskSessionService(options)
  } })
  t.after(async () => { gate.resolve(); try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'integrated-stage-provider', objective: '仅核对原证据并报告阶段事实' })
  await h.service.whenIdle()
  const [before] = await h.query('execution.list')
  if (!before) {
    const current = await h.query('task.get', { taskId: task.taskId })
    const log = await inspectSession(h.ctx.sessionPersistence, current.sessionId).catch(error => ({ error: error.message }))
    assert.fail('Owner never delegated: ' + JSON.stringify({ ownerInputs: ownerInputs.length, providerRecovery: current.providerRecovery,
      alerts: h.service.listAlerts(), native: log?.error ?? log?.events?.filter(event => ['agent/end', 'request/end', 'step/end'].includes(event.type)).slice(-5) }))
  }
  assert.equal(before.stageProgress.inputVersion, 1)
  assert.deepEqual(before.stageProgress.evidence, [proof])
  assert.equal(before.providerRecovery.attempts, 1)
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextAttemptAt) + 1)
  await h.service.recover()
  await waitUntil(() => steps >= 6 && documentReads.get(2)?.text.includes('恢复后已复核原证据'), 'owner natively reads the recovered round document')
  const after = await h.query('execution.get', { executionId: before.executionId })
  assert.equal(after.sessionId, before.sessionId); assert.equal(after.inputVersion, 2)
  assert.equal(after.status, 'running'); assert.equal(after.drained, false)
  assert.equal(after.stageProgress.inputVersion, 2); assert.equal(after.stageProgress.leaseEpoch, after.leaseEpoch)
  assert.equal(after.results[0].payload.error.code, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).length, 0, 'reads and internal reports do not create business effects')
  const input = ownerInputs.findLast(input => input.executions[0]?.document?.inputVersion === 2)
  assert.equal(input.executions[0].inputDigest, undefined, 'full native record is available through the catalog')
  assert.equal(input.executions[0].stageProgress, undefined, '阶段正文由执行文档承载，不重复内联')
  assert.ok(documentReads.get(2).text.includes(proof))
  assert.match(documentReads.get(2).text, /恢复后已复核原证据/)
  assert.notEqual(documentReads.get(1).path, documentReads.get(2).path)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), toolErrors: h.toolResults.filter(item => item.result?.isError).map(({ name, result }) => ({ name, error: result.error })) }))
  const completed = await h.query('execution.list')
  assert.equal(completed.length, 3)
  assert.equal(completed.find(item => item.key === 'original').executionId, before.executionId)
})

for (const humanWait of [false, true]) test(`native nonterminal stage report continues execution and updates owner summary; human wait=${humanWait}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-stage-report-')), gate = Promise.withResolvers()
  await writeFile(join(root, 'stage-proof.txt'), 'ACTUAL_STAGE_PROOF')
  const reviewers = completionReviews(join(root, 'stage-proof.txt'))
  let ownerCalls = 0, executionCalls = 0, stageOwnerInput, stageEvidence, stageSummary, stageDocumentRead = false
  const h = await nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      const review = reviewers.execution(latestInput(request)); if (review) return review
      const step = ++executionCalls
      if (step === 1 || step === 3) return [call('read', { file_path: join(root, 'stage-proof.txt') })]
      if (step === 2) {
        assert.match(JSON.stringify(request.messages), /ACTUAL_STAGE_PROOF/)
        assert.ok(request.tools.some(tool => tool.name === 'execution_report_progress'))
        return [call('execution_report_progress', { summary: '已核对样例差异，继续验证修复边界。', evidence: [join(root, 'stage-proof.txt')], activity: '验证修复边界' })]
      }
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行验证完成', evidence: ['ACTUAL_STAGE_PROOF'], limitations: [], artifacts: [] } })]
    }
    ownerCalls++
    const input = latestInput(request)
    if (ownerCalls === 1) return [call('task_delegate', { key: 'verify', objective: '读取样例证据并继续验证，不修改文件' })]
    if (input.wakes.some(wake => wake.kind === 'execution.result') && input.executions.every(item => item.drained)) return reviewers.owner(input, '已核对原执行的最终结果。')
    if (humanWait && !input.task.humanRequests?.some(item => item.status === 'answered')) return [call('task_request_human', { reason: '测试后续范围需原操作人明确', question: '是否继续原只读验证？', evidence: [], attemptedActions: ['已委派原只读验证'] })]
    if (input.wakes.some(wake => wake.kind === 'execution.stage.progress')) {
      stageOwnerInput = input
      const wake = input.wakes.find(wake => wake.kind === 'execution.stage.progress')
      const member = input.executions.find(item => item.executionId === wake.payload.executionId)
      assert.equal(member.document.inputVersion, member.inputVersion)
      if (!stageDocumentRead) { stageDocumentRead = true; return [call('read', { file_path: member.document.path })] }
      const read = h.toolResults.findLast(item => item.name === 'read' && item.sessionId === input.task.sessionId)
      assert.ok(read && !read.result.isError)
      const text = toolText(read.result)
      stageSummary = '已核对样例差异，继续验证修复边界。'; stageEvidence = join(root, 'stage-proof.txt')
      assert.ok(text.includes(stageSummary)); assert.ok(text.includes(stageEvidence))
      assert.match(text, /验证修复边界/)
      return [submit('wait', '已核对阶段证据，正在验证整体修复边界。')]
    }
    return [submit('wait', '已安排核对，等待执行进展。')]
  })
  t.after(async () => { gate.resolve(); try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'stage-report', objective: '核对样例差异并验证原执行范围' })
  await waitUntil(() => executionCalls >= 4 && ownerCalls >= 2, 'execution reports a stage then reads again and continues running')
  const [execution] = await h.query('execution.list')
  assert.equal(execution.status, 'running'); assert.equal(execution.drained, false); assert.equal(execution.result, undefined)
  assert.match(execution.stageProgress.summary, /样例差异/)
  assert.equal(execution.stageProgress.activity, '验证修复边界')
  assert.equal(execution.timeline.segments.at(-1).activity, '验证修复边界')
  const timeline = (await h.service.taskDetail(task.taskId)).timeline
  assert.equal(timeline.executions[0].segments.at(-1).label, '验证修复边界')
  assert.equal(timeline.executions[0].milestones.length, 1)
  assert.equal(timeline.executions[0].milestones[0].activity, '验证修复边界')
  assert.deepEqual(timeline.executions[0].milestones[0].evidence, [join(root, 'stage-proof.txt')])
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).some(item => item.definition?.toolName === 'execution_report_progress'), false, 'internal reporting must not be an external business operation')
  if (humanWait) {
    assert.equal(stageOwnerInput, undefined, 'stage wake cannot bypass the real human request')
    const current = await h.query('task.get', { taskId: task.taskId }), question = current.humanRequests[0]
    await h.service.respondHumanRequest({ taskId: task.taskId, humanRequestId: question.requestId, requestId: 'stage-human-answer', reply: '继续原只读验证，不增加写入', expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision })
  }
  await waitUntil(async () => (await h.query('task.get', { taskId: task.taskId })).lastDecision?.summary === '已核对阶段证据，正在验证整体修复边界。', 'owner persists a new overall progress summary before execution completion')
  assert.ok(stageOwnerInput)
  const wake = stageOwnerInput.wakes.find(item => item.kind === 'execution.stage.progress')
  assert.equal(wake.payload.executionId, execution.executionId); assert.equal(wake.payload.sequence, execution.stageProgress.sequence)
  assert.equal(wake.payload.evidence, undefined, 'notification does not duplicate the current execution evidence')
  assert.equal(wake.payload.reportRef.format, 'json', '文档投影省略阶段正文时仍保留原始报告的诊断引用')
  assert.equal(typeof wake.payload.reportRef.contentRef, 'string')
  assert.equal(typeof wake.payload.reportRef.path, 'string')
  assert.equal(stageEvidence, join(root, 'stage-proof.txt'))
  assert.equal(stageSummary, execution.stageProgress.summary)
  const visibleExecution = stageOwnerInput.executions.find(item => item.executionId === execution.executionId)
  assert.equal(visibleExecution.stageProgress, undefined, '当前阶段正文只在执行文档中读取')
  assert.equal(visibleExecution.document.inputVersion, execution.inputVersion)
  assert.equal(visibleExecution.document.path, join(root, 'tasks', task.taskId, 'outputs', execution.executionId, 'round-1.md'))
  assert.equal(visibleExecution.inputVersion, execution.inputVersion)
  assert.equal(visibleExecution.leaseEpoch, execution.leaseEpoch)
  assert.equal(visibleExecution.inputDigest, undefined, 'the native identity digest remains in the catalog rather than the default status row')
  assert.equal((await h.query('execution.get', { executionId: execution.executionId })).status, 'running')
  assert.ok((await h.service.taskDetail(task.taskId)).lastDecision.at)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify({ alerts: h.service.listAlerts(), toolErrors: h.toolResults.filter(item => item.result?.isError).map(({ name, result }) => ({ name, error: result.error })) }))
  const completed = await h.query('execution.list')
  assert.equal(completed.length, 3)
  assert.equal(completed.filter(item => item.key === 'verify').length, 1, 'stage report must not spawn or restart the inspected execution')
  assert.equal(completed.find(item => item.key === 'verify').inputVersion, 1)
})
