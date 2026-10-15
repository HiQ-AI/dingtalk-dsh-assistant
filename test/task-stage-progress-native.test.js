import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
const call = (name, args) => ({ name, args })
const submit = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })

test('integrated stage evidence survives same-session provider recovery with new version binding and no duplicate operation', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'integrated-stage-provider-')), gate = Promise.withResolvers()
  const proof = join(root, 'proof.txt'); await writeFile(proof, 'INTEGRATED_STAGE_PROOF')
  let steps = 0, sequence = 0
  const ownerInputs = []
  const h = await nativeTaskHost(root, async () => [], { agentConfig: { provider: 'integrated-stage-provider' }, serviceFactory: async options => {
    class Provider extends LlmAdapter {
      async *stream(request) {
        let calls
        if (request.tools.some(tool => tool.name === 'task_delegate')) {
          const input = latestInput(request); ownerInputs.push(input)
          calls = !input.executions.length ? [call('task_delegate', { key: 'original', objective: 'Read original proof and report confirmed stages' }), submit('wait', '等待原执行')]
            : input.executions.every(item => item.drained && item.status === 'succeeded') ? [submit('complete', '已核对最终只读结果')]
            : [submit('wait', input.wakes.some(item => item.kind === 'execution.stage.progress') ? '已核对阶段证据，继续原目标' : '等待受管恢复')]
        } else {
          const step = steps++
          if (step === 2) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'fixture server temporarily unavailable' } } }; return }
          if (step === 0 || step === 3) calls = [call('read', { file_path: proof })]
          else if (step === 1 || step === 4) calls = [call('execution_report_progress', { summary: step === 1 ? '已核对第一阶段证据' : '恢复后已复核原证据', evidence: [proof] })]
          else { await gate.promise; calls = [call('execution_submit', { output: { status: 'completed', summary: '只读证据核验完成', evidence: [proof], limitations: [], artifacts: [] } })] }
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
  assert.equal(before.stageProgress.inputVersion, 1)
  assert.deepEqual(before.stageProgress.evidence, [proof])
  assert.equal(before.providerRecovery.attempts, 1)
  t.mock.timers.setTime(Date.parse(before.providerRecovery.nextAttemptAt) + 1)
  await h.service.recover()
  await waitUntil(() => steps >= 6 && ownerInputs.some(input => input.executions[0]?.stageProgress?.inputVersion === 2), 'recovered stage arrives in indexed owner input')
  const after = await h.query('execution.get', { executionId: before.executionId })
  assert.equal(after.sessionId, before.sessionId); assert.equal(after.inputVersion, 2)
  assert.equal(after.status, 'running'); assert.equal(after.drained, false)
  assert.equal(after.stageProgress.inputVersion, 2); assert.equal(after.stageProgress.leaseEpoch, after.leaseEpoch)
  assert.equal(after.results[0].payload.error.code, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).humanRequests.length, 0)
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).length, 0, 'reads and internal reports do not create business effects')
  const input = ownerInputs.findLast(input => input.executions[0]?.stageProgress?.inputVersion === 2)
  assert.equal(input.executions[0].inputDigest, after.inputDigest)
  assert.deepEqual(input.executions[0].stageProgress.evidence, [proof])
  assert.equal(input.executions[0].stageProgress.summary, '恢复后已复核原证据')
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal((await h.query('execution.list')).length, 1)
})

for (const humanWait of [false, true]) test(`native nonterminal stage report continues execution and updates owner summary; human wait=${humanWait}`, { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-stage-report-')), gate = Promise.withResolvers()
  await writeFile(join(root, 'stage-proof.txt'), 'ACTUAL_STAGE_PROOF')
  let ownerCalls = 0, executionCalls = 0, stageOwnerInput
  const h = await nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      const step = ++executionCalls
      if (step === 1 || step === 3) return [call('read', { file_path: join(root, 'stage-proof.txt') })]
      if (step === 2) {
        assert.match(JSON.stringify(request.messages), /ACTUAL_STAGE_PROOF/)
        assert.ok(request.tools.some(tool => tool.name === 'execution_report_progress'))
        return [call('execution_report_progress', { summary: '已核对样例差异，继续验证修复边界。', evidence: [join(root, 'stage-proof.txt')] })]
      }
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行验证完成', evidence: ['ACTUAL_STAGE_PROOF'], limitations: [], artifacts: [] } })]
    }
    ownerCalls++
    const input = latestInput(request)
    if (ownerCalls === 1) return [call('task_delegate', { key: 'verify', objective: '读取样例证据并继续验证，不修改文件' })]
    if (input.wakes.some(wake => wake.kind === 'execution.result') && input.executions.every(item => item.drained)) return [submit('complete', '已核对原执行的最终结果。')]
    if (humanWait && !input.task.humanRequests?.some(item => item.status === 'answered')) return [call('task_request_human', { reason: '测试后续范围需原操作人明确', question: '是否继续原只读验证？', evidence: [], attemptedActions: ['已委派原只读验证'] })]
    if (input.wakes.some(wake => wake.kind === 'execution.stage.progress')) {
      stageOwnerInput = input
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
  assert.equal((await h.query('operation.list', { taskId: task.taskId })).some(item => item.definition?.toolName === 'execution_report_progress'), false, 'internal reporting must not be an external business operation')
  if (humanWait) {
    assert.equal(stageOwnerInput, undefined, 'stage wake cannot bypass the real human request')
    const current = await h.query('task.get', { taskId: task.taskId }), question = current.humanRequests[0]
    await h.service.respondHumanRequest({ taskId: task.taskId, humanRequestId: question.requestId, requestId: 'stage-human-answer', reply: '继续原只读验证，不增加写入', expectedRequirementRevision: current.requirementRevision, expectedControlRevision: current.controlRevision })
  }
  await waitUntil(async () => (await h.query('task.get', { taskId: task.taskId })).lastDecision?.summary === '已核对阶段证据，正在验证整体修复边界。', 'owner persists a new overall progress summary before execution completion')
  assert.ok(stageOwnerInput)
  const wake = stageOwnerInput.wakes.find(item => item.kind === 'execution.stage.progress')
  assert.equal(wake.payload.executionId, execution.executionId); assert.equal(wake.payload.inputVersion, execution.inputVersion)
  assert.deepEqual(wake.payload.evidence, [join(root, 'stage-proof.txt')])
  const visibleExecution = stageOwnerInput.executions.find(item => item.executionId === execution.executionId)
  assert.deepEqual(visibleExecution.stageProgress.evidence, wake.payload.evidence)
  assert.equal(visibleExecution.stageProgress.summary, execution.stageProgress.summary)
  assert.equal(visibleExecution.inputVersion, execution.inputVersion)
  assert.equal(visibleExecution.leaseEpoch, execution.leaseEpoch)
  assert.equal(visibleExecution.inputDigest, execution.inputDigest)
  assert.equal((await h.query('execution.get', { executionId: execution.executionId })).status, 'running')
  assert.ok((await h.service.taskDetail(task.taskId)).lastDecision.at)
  gate.resolve(); await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal((await h.query('execution.list')).length, 1, 'stage report must not spawn or restart an execution')
})
