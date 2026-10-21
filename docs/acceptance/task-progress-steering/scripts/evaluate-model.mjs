import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeTaskHost } from '../../../../test/fixtures/task-session-native-host.js'
import { createTaskSessions } from '../../../../packages/dingtalk-dsh-assistant/task-session.js'

// 使用生产统筹实现和真实模型；所有执行/日志读回为合成材料，禁止文件、网络和业务工具执行。
// 参数：输出目录、已安装 Connect 入口、模型名称、当前代理。沿当前登录，不读出或复制凭据。
const [output, connectPath, model, proxyUrl] = process.argv.slice(2)
assert.ok(output && connectPath && model && proxyUrl, 'usage: node evaluate-model.mjs <output-directory> <connect-entry> <model> <proxy-url>')
const root = resolve(output)
await mkdir(root, { recursive: true })
const existingFeedback = consumed => [{ id: 'prior-direction', receivedAt: '2026-10-21T00:00:00Z',
  consumedAt: consumed ? '2026-10-21T00:01:00Z' : null, modelStepEnteredAt: consumed ? '2026-10-21T00:01:00Z' : null,
  sequence: consumed ? 10 : null, text: '原目标只核对 A 文件，停止读取其他项目，核对 A 后报告。' }]
const cases = [
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
const h = await nativeTaskHost(root, () => [], { resident: true })
const sessions = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => root })
const results = []
const permitted = new Set(['task_execution_progress', 'task_execution_read', 'task_decisions_read', 'model_content_read', 'task_delegate', 'task_session_submit'])
h.ctx.on('tools/pre-execute', (exec, next) => permitted.has(exec.name) ? next() : { kind: 'deny', reason: 'isolated_evaluation_no_external_tools' })
try {
  const connect = await import(pathToFileURL(resolve(connectPath)).href)
  await connect.apply(h.ctx, { enableProxy: true, proxyUrl, enableSearch: false, enableReserveFallback: false, enableNativeCompaction: false, enableImageTool: false, enableImageGeneration: false, enableAutoReview: false })
  for (const sample of cases) {
    const taskId = `evaluation-${sample.id}`, actions = []
    const binding = { kind: 'task-session', taskId, sessionId: `owner-${sample.id}`, leaseEpoch: 1, requirementRevision: 1, controlRevision: 1 }
    const execution = { taskId, executionId: 'original', sessionId: 'original-executor', status: 'running', drained: false, inputVersion: 1, leaseEpoch: 1,
      input: { objective: sample.delegated }, feedback: structuredClone(sample.prior ?? []) }
    const progress = { available: true, executionId: execution.executionId, inputVersion: 1, leaseEpoch: 1,
      lastSequence: 21, newEventCount: sample.events.length, lastActivityAt: '2026-10-21T00:02:00Z',
      excerpts: sample.events.map((preview, index) => ({ sequence: index + 20, type: 'tool/result', preview })), pendingToolCalls: [] }
    const task = { taskId, objective: sample.goal, title: '隔离统筹方向判断', status: 'active', control: 'active', requirementRevision: 1, controlRevision: 1 }
    const timer = setTimeout(() => { void sessions.cancel(taskId) }, 120000)
    try {
      const result = await sessions.run({ binding, provider: 'openai-codex', model, reasoningEffort: 'medium', agentPreset: 'native-test',
        input: { task, sources: [{ sourceId: 'user-request', actorId: 'synthetic-user', text: sample.goal }],
          executions: [execution], wakes: [{ kind: 'execution.progress.review', payload: { executionId: execution.executionId } }], operations: [], blockers: {} },
        onSessionBound: async () => {},
        readProgress: async () => { actions.push({ tool: 'read-progress' }); return progress },
        readExecution: async () => { actions.push({ tool: 'read-execution' }); return execution },
        readDecisions: async () => ({ decisions: [], nextBefore: null }),
        delegate: async args => {
          assert.equal(args.executionId, execution.executionId)
          assert.equal(args.feedback, true)
          actions.push({ tool: 'feedback', args })
          const feedback = { id: args.key, text: args.objective, receivedAt: new Date().toISOString(), consumedAt: null, sequence: null }
          execution.feedback.push(feedback)
          return { executionId: execution.executionId, received: true, consumed: false, feedback }
        },
        submit: async decision => { actions.push({ tool: 'decision', decision }); return { accepted: true } },
      })
      assert.equal(result.status, 'submitted')
      assert.equal(result.decision.action, 'wait')
      assert.ok(actions.some(action => action.tool === 'read-progress'))
      const feedback = actions.filter(action => action.tool === 'feedback')
      assert.equal(feedback.length, sample.feedback ? 1 : 0, 'first drift steers; normal/insufficient/pending states do not duplicate advice')
      if (feedback.length) assert.ok(actions.findIndex(action => action.tool === 'read-execution') < actions.findIndex(action => action.tool === 'feedback'))
      results.push({ id: sample.id, pass: true, actions, result })
    } catch (error) { results.push({ id: sample.id, pass: false, error: error.message, actions }) }
    finally { clearTimeout(timer) }
    await writeFile(join(root, 'results.json'), JSON.stringify({ model, cases: results }, null, 2) + '\n')
    console.log(JSON.stringify({ case: sample.id, pass: results.at(-1).pass, error: results.at(-1).error }))
    if (results.at(-1).error === 'TASK_SESSION_PROVIDER_TRANSIENT') break
  }
} finally { await sessions.close(); await h.close() }
assert.ok(results.length === cases.length && results.every(result => result.pass), 'model direction scenarios failed; inspect results.json')
