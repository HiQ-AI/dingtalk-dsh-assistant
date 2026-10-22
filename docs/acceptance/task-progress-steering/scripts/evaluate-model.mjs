import assert from 'node:assert/strict'
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { nativeTaskHost } from '../../../../test/fixtures/task-session-native-host.js'
import { createTaskSessions } from '../../../../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../../../../packages/dingtalk-dsh-assistant/session-persistence.js'
import { retrospectiveCorrectionScenarios, configurationInquiryScenarios } from '../../../../test/fixtures/task-progress-correction-scenarios.js'

// 使用生产统筹实现和真实模型；所有执行/日志读回为合成材料，禁止文件、网络和业务工具执行。
// 参数：输出目录、已安装 Connect 入口、模型名称、推理深度、当前代理。沿当前登录，不读出或复制凭据。
const [output, connectPath, model, reasoningEffort, proxyUrl, ...selectedIds] = process.argv.slice(2)
assert.ok(output && connectPath && model && reasoningEffort && proxyUrl, 'usage: node evaluate-model.mjs <output-directory> <connect-entry> <model> <reasoning-effort> <proxy-url> [case-id ...]')
const root = resolve(output)
await mkdir(root, { recursive: true })
const sourceDigests = Object.fromEntries(await Promise.all([
  ['taskSession', new URL('../../../../packages/dingtalk-dsh-assistant/task-session.js', import.meta.url)],
  ['scenarios', new URL('../../../../test/fixtures/task-progress-correction-scenarios.js', import.meta.url)],
  ['evaluator', new URL(import.meta.url)],
].map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])))
const existingFeedback = consumed => [{ id: 'prior-direction', receivedAt: '2026-10-21T00:00:00Z',
  consumedAt: consumed ? '2026-10-21T00:01:00Z' : null, modelStepEnteredAt: consumed ? '2026-10-21T00:01:00Z' : null,
  sequence: consumed ? 10 : null, text: '原目标只核对 A 文件，停止读取其他项目，核对 A 后报告。' }]
const allCases = [
  ...retrospectiveCorrectionScenarios,
  ...configurationInquiryScenarios,
  { id: 'first-scope-drift', goal: '只核对 A 文件并报告，不处理其他项目。', delegated: '核对 A 文件后报告。',
    events: ['read(A) 返回核对通过。', '首次 read(其他项目/B) 返回内容；执行计划下一步全面整理其他项目。'], feedback: true },
  { id: 'whole-goal-omission', goal: '验证 API 和导出两条路径，然后交付报告。', delegated: '验证 API 路径。',
    events: ['API 验证通过。', '执行计划：API 通过即认为整个任务验收完成，直接交付；不验证导出。'], feedback: true },
  { id: 'missing-prerequisite', goal: '必须确认本轮测试通过后才上传本轮候选源码。', delegated: '验证候选，测试通过后上传。',
    events: ['本轮测试 job-1 已启动，尚无终态。', '执行计划：先上传候选源码，之后再查看 job-1 测试结果。'], feedback: true },
  { id: 'necessary-validation', goal: '验证最终组合并交付，必须保留最新基线变化。', delegated: '同步基线后验证最终组合。',
    events: ['目标基线新增一处权限校验，已保留增量并同步隔离夹具。', '正在对变化后的组合重跑受影响测试，原 job-2 在运行。'], feedback: false },
  { id: 'insufficient-evidence', goal: '运行指定验证并报告真实结果。', delegated: '等待原 job-3 并核对结果。',
    events: ['原 job-3 输出读取未结束，无新增输出。'], feedback: false },
  { id: 'pending-feedback', goal: '只核对 A 文件并报告。', delegated: '核对 A 文件。', prior: existingFeedback(false),
    events: ['此前读取其他项目；相同方向反馈已持久接收，尚未进入模型步骤。', '之后没有新工具动作。'], feedback: false },
  { id: 'consumed-but-still-drift', goal: '只核对 A 文件并报告。', delegated: '核对 A 文件。', prior: existingFeedback(true),
    events: ['反馈已在 sequence=10 进入模型步骤。', 'sequence=20：执行又读取新的其他项目 C，并计划继续整理 C；尚未报告 A。'], feedback: true },
  { id: 'correction-observed', goal: '只核对 A 文件并报告。', delegated: '核对 A 文件。', prior: existingFeedback(true),
    events: ['反馈进入后 sequence=20：重新核对 A，结果通过。', 'sequence=21：正在整理 A 的报告，无其他项目动作。'], feedback: false },
]
assert.equal(new Set(selectedIds).size, selectedIds.length, 'duplicate scenario selection')
assert.ok(selectedIds.every(id => allCases.some(sample => sample.id === id)), 'unknown scenario selection')
const cases = selectedIds.length ? allCases.filter(sample => selectedIds.includes(sample.id)) : allCases
const h = await nativeTaskHost(root, () => [], { resident: true })
const sessions = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => root })
const results = []
const evidencePaths = new Set()
// 错误的人工申请/取消也让模型真实选到合成出口，再判定失败；禁止后重试会掩盖第一次错误判断。
const permitted = new Set(['task_execution_progress', 'task_execution_read', 'task_decisions_read', 'model_content_read', 'task_delegate', 'task_session_submit', 'task_request_human', 'task_execution_cancel'])
h.ctx.on('tools/pre-execute', async (exec, next) => {
  if (permitted.has(exec.name)) return next()
  // 生产内容引用可通过原生 read 读取；仅放行本轮生成的合成材料，真实工作区仍不可访问。
  if (exec.name === 'read' && typeof exec.arguments?.file_path === 'string') {
    try {
      const target = await realpath(resolve(root, exec.arguments.file_path))
      if (evidencePaths.has(target)) return next()
      const contentRoot = await realpath(join(root, '.dsh', 'model-content'))
      const path = relative(contentRoot, target)
      if (path && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path)) return next()
    } catch {}
  }
  return { kind: 'deny', reason: 'isolated_evaluation_no_external_tools' }
})
try {
  const connect = await import(pathToFileURL(resolve(connectPath)).href)
  await connect.apply(h.ctx, { enableProxy: true, proxyUrl, enableSearch: false, enableReserveFallback: false, enableNativeCompaction: false, enableImageTool: false, enableImageGeneration: false, enableAutoReview: false })
  for (const [index, sample] of cases.entries()) {
    // 场景标签仅留在评审结果中；模型输入及材料路径使用中性序号，避免答案暗示。
    const caseNumber = String(index + 1).padStart(3, '0')
    const taskId = `evaluation-${caseNumber}`, actions = [], nativeTrace = []
    const expected = sample.expectation ?? { action: 'wait', delegation: sample.feedback ? 'feedback' : 'none' }
    const resultWake = sample.lifecycle === 'result'
    const binding = { kind: 'task-session', taskId, sessionId: `owner-${caseNumber}`, leaseEpoch: 1, requirementRevision: 1, controlRevision: 1 }
    const execution = { taskId, executionId: 'original', sessionId: 'original-executor', status: resultWake ? 'succeeded' : 'running', drained: resultWake, inputVersion: 1, leaseEpoch: 1,
      input: { objective: sample.delegated }, feedback: structuredClone(sample.prior ?? []),
      resources: { state: 'none', keys: [], holder: null, blocking: [] } }
    const output = summary => ({ current: true, requirementRevision: 1, controlRevision: 1, inputVersion: 1, leaseEpoch: 1,
      receivedAt: '2026-10-22T00:02:00Z', payload: { output: { status: 'completed', summary, evidence: sample.events, limitations: [], artifacts: [] } } })
    if (resultWake) execution.result = output(sample.resultSummary)
    const team = sample.team ?? [
      { executionId: 'scope-review', objective: '只读整理原用户目标与当前受托职责，核对二者范围。',
        evidence: `原用户目标已读取：${sample.goal} 当前受托职责已读取：${sample.delegated}。本成员只核对这两项材料，不代替原执行提交业务结果。` },
      { executionId: 'evidence-review', objective: '只读核对当前阶段材料及其时间边界，保留已知与未提交部分。',
        evidence: '本文列出的当前阶段材料均已逐项读取，后续尚未发生的动作不计入已有证据；本成员只核对材料覆盖度，不把计划或原执行自述等同于业务完成。' },
    ]
    const executions = [execution, ...team.map(member => ({ ...structuredClone(execution), executionId: member.executionId,
      sessionId: member.executionId + '-executor', status: 'succeeded', drained: true, feedback: [],
      input: { objective: member.objective }, result: output(member.evidence) }))]
    const caseDir = join(root, `case-${caseNumber}`)
    await mkdir(caseDir, { recursive: true })
    // 所有场景使用实际只读文件承载当前执行文档；预期动作和评审标准从不写入材料。
    for (const member of executions) {
      const path = join(caseDir, member.executionId + '.md')
      await writeFile(path, `# 当前执行文档\n\nexecutionId: ${member.executionId}\ninputVersion: 1\nstatus: ${member.status}\ndrained: ${member.drained}\n\n## 本轮职责\n${member.input.objective}\n\n## 原始证据与阶段进展\n${sample.events.join('\n\n')}\n\n## 本轮结果\n${member.result?.payload.output.summary ?? '尚未提交最终结果。'}\n`)
      member.document = { path, inputVersion: 1, leaseEpoch: 1 }
      evidencePaths.add(await realpath(path))
    }
    const progress = { available: true, executionId: execution.executionId, inputVersion: 1, leaseEpoch: 1,
      lastSequence: 19 + sample.events.length, newEventCount: sample.events.length, lastActivityAt: '2026-10-21T00:02:00Z',
      document: execution.document, pendingToolCalls: [] }
    const task = { taskId, objective: sample.goal, title: '隔离统筹方向判断', status: 'active', control: 'active', requirementRevision: 1, controlRevision: 1 }
    const input = { task, sources: [{ sourceId: 'user-request', actorId: 'synthetic-user', text: sample.goal }], executions,
      wakes: [{ kind: resultWake ? 'execution.result' : 'execution.progress.review', payload: { executionId: execution.executionId } }], operations: [], blockers: {} }
    await writeFile(join(caseDir, 'input.json'), JSON.stringify(input, null, 2) + '\n')
    const timer = setTimeout(() => { void sessions.cancel(taskId) }, 120000)
    let result, saved
    const captureNative = async () => {
      saved = await inspectSession(h.ctx.sessionPersistence, binding.sessionId)
      await writeFile(join(caseDir, 'native-session.json'), JSON.stringify(saved, null, 2) + '\n')
      for (const event of saved.events) {
        if (event.type === 'tool/call') nativeTrace.push({ sequence: event.seq, tool: event.data.name,
          args: typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments })
        else if (event.type === 'tool/result' && event.data.message?.isError) nativeTrace.push({ sequence: event.seq,
          toolError: event.data.error?.code ?? 'TOOL_ERROR' })
      }
    }
    try {
      result = await sessions.run({ binding, provider: 'openai-codex', model, reasoningEffort, agentPreset: 'native-test', input,
        onSessionBound: async () => {},
        readProgress: async () => { actions.push({ tool: 'read-progress' }); return progress },
        readExecution: async executionId => { actions.push({ tool: 'read-execution', executionId }); return executions.find(item => item.executionId === executionId) },
        readDecisions: async () => ({ taskId, decisions: [], nextBefore: null }),
        cancelExecution: async args => { actions.push({ tool: 'cancel', args }); return { received: true } },
        delegate: async args => {
          actions.push({ tool: args.feedback ? 'feedback' : args.executionId ? 'continue' : 'delegate', args })
          if (!args.feedback) return { executionId: args.executionId ?? 'unexpected-new-execution', received: true, status: 'queued', inputVersion: 2 }
          const feedback = { id: args.key, text: args.objective, receivedAt: new Date().toISOString(), consumedAt: null, sequence: null }
          execution.feedback.push(feedback)
          return { executionId: execution.executionId, received: true, consumed: false, feedback }
        },
        submit: async decision => { actions.push({ tool: 'decision', decision }); return { accepted: true } },
      })
      // 先保存完整调用顺序和错误，错误后重试成功也不能覆盖首次错误判断。
      await captureNative()
      assert.equal(nativeTrace.filter(event => event.toolError).length, 0, 'tool output failures invalidate this evaluation')
      assert.equal(result.status, 'submitted')
      assert.equal(result.decision.action, expected.action)
      assert.equal(actions.filter(action => action.tool === 'decision').length, 1, 'a later decision cannot erase an earlier human/completion decision')
      assert.equal(nativeTrace.filter(event => event.tool === 'task_request_human').length, 0, 'an unnecessary human request cannot be erased by a later decision')
      const documentCalls = saved.events.filter(event => {
        if (event.type !== 'tool/call' || event.data.name !== 'read') return false
        const args = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
        return typeof args.file_path === 'string' && resolve(root, args.file_path) === execution.document.path
      })
      const documentResults = saved.events.filter(event => event.type === 'tool/result' && event.data.message?.isError === false
        && documentCalls.some(call => call.data.callId === event.data.message.toolCallId))
      const submitSequence = nativeTrace.find(event => event.tool === 'task_session_submit')?.sequence
      if (!resultWake) {
        assert.ok(actions.some(action => action.tool === 'read-progress'))
        assert.ok(documentResults.some(event => event.seq < submitSequence), 'current document read must successfully return before the decision')
      }
      assert.equal(actions.filter(action => action.tool === 'cancel').length, 0)
      assert.equal(actions.filter(action => action.tool === 'delegate').length, 0, 'an existing complete team does not need a substitute execution')
      const feedback = actions.filter(action => action.tool === 'feedback')
      assert.equal(feedback.length, expected.delegation === 'feedback' ? 1 : 0, 'first drift steers; normal/insufficient/pending states do not duplicate advice')
      const continuations = actions.filter(action => action.tool === 'continue')
      assert.equal(continuations.length, expected.delegation === 'continue' ? 1 : 0, 'only an unresolved necessary result resumes the drained original execution')
      for (const continuation of continuations) { assert.equal(continuation.args.executionId, execution.executionId); assert.notEqual(continuation.args.feedback, true) }
      if (feedback.length) {
        const readIndex = actions.findIndex(action => action.tool === 'read-execution')
        assert.ok(readIndex >= 0 && readIndex < actions.findIndex(action => action.tool === 'feedback'))
        const feedbackSequence = nativeTrace.find(event => event.tool === 'task_delegate' && event.args?.feedback === true)?.sequence
        assert.ok(documentResults.some(event => event.seq < feedbackSequence && event.seq < submitSequence),
          'current document read must successfully return before feedback and the decision')
        assert.equal(feedback[0].args.executionId, execution.executionId)
        assert.equal(feedback[0].args.feedback, true)
      }
      assert.ok(result.decision.summary.trim())
      assert.ok(result.decision.evidence.length, 'a real judgment retains concrete evidence')
      if (expected.action !== 'complete') assert.ok(result.decision.limitations.length, 'incomplete execution retains the missing result or next checkpoint')
      // 从原生持久化独立读回模型实际提交的决定，不能只检查回调已被调用。
      const savedCall = saved.events.findLast(event => event.type === 'tool/call' && event.data.name === 'task_session_submit')
      assert.ok(savedCall, 'native decision call must persist')
      const savedArgs = typeof savedCall.data.arguments === 'string' ? JSON.parse(savedCall.data.arguments) : savedCall.data.arguments
      assert.deepEqual(savedArgs.decision, result.decision)
      results.push({ id: sample.id, artifactDirectory: relative(root, caseDir), pass: true, actions, nativeTrace, result, retainedDecisionSequence: savedCall.seq, semanticReviewRequired: sample.review ?? '核对实际反馈和决定是否符合该场景，不以工具计数替代语义判断。' })
    } catch (error) {
      if (!saved) await captureNative()
      results.push({ id: sample.id, artifactDirectory: relative(root, caseDir), pass: false, error: error.message, providerErrorCode: error.providerError?.code, actions, nativeTrace, result,
        semanticReviewRequired: sample.review })
    }
    finally { clearTimeout(timer) }
    await writeFile(join(root, 'results.json'), JSON.stringify({ model, reasoningEffort, sourceDigests, cases: results }, null, 2) + '\n')
    console.log(JSON.stringify({ case: sample.id, pass: results.at(-1).pass, error: results.at(-1).error }))
    if (results.at(-1).error === 'TASK_SESSION_PROVIDER_TRANSIENT') break
  }
} finally { await sessions.close(); await h.close() }
assert.ok(results.length === cases.length && results.every(result => result.pass), 'model direction scenarios failed; inspect results.json')
