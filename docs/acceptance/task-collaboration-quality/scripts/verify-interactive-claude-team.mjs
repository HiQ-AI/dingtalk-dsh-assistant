// 真实认证、模型与 PTY；只访问本轮隔离任务库，不操作现场任务。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createClaudeExecutionSessions, claudeExecutionLogPath } from '../../../../packages/dingtalk-dsh-assistant/claude-execution-session.js'
import { openDynamicTaskStore } from '../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { dynamicExecutionOutputSchema } from '../../../../packages/dingtalk-dsh-assistant/task-session-service.js'
import { taskWorkspace, materializeExecutionDocument } from '../../../../packages/dingtalk-dsh-assistant/session-workspaces.js'

const option = flag => process.argv[process.argv.indexOf(flag) + 1]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item))
const powershellCommand = "Write-Output 'DSH_CLAUDE_PTY_OK'"
const inside = (root, path) => { const part = relative(root, path); return !!part && !part.startsWith('..') && !isAbsolute(part) }
assert.ok(process.argv.includes('--consumer') && process.argv.includes('--output'), '--consumer package.json --output fresh-directory required')
const consumerPath = resolve(option('--consumer')), root = resolve(option('--output'))
assert.ok(inside(resolve('docs/tmp'), root), 'output must be inside docs/tmp')
const consumer = createRequire(consumerPath)
const { Context } = consumer('@deepseek-ai/cordis')
const { LocalSubprocessRuntime } = consumer('@deepseek-ai/dsh-subprocess-local')
assert.equal(dynamicExecutionOutputSchema.type, 'object')
if (process.argv.includes('--check')) {
  console.log('PASS: isolated path/schema/real consumer resolution; no writes, CLI or model calls')
} else {
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  await mkdir(root)
  const sourcePaths = ['packages/dingtalk-dsh-assistant/claude-execution-session.js', 'packages/dingtalk-dsh-assistant/dynamic-task-store.js', 'packages/dingtalk-dsh-assistant/session-workspaces.js', 'docs/acceptance/task-collaboration-quality/scripts/verify-interactive-claude-team.mjs']
  const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(path))])))
  const result = { wrapperPid: process.pid, startedAt: new Date().toISOString(), sources, deadlineMsPerRound: 600000, rounds: [], launches: [], status: 'FAIL' }
  const ctx = new Context(); new LocalSubprocessRuntime(ctx)
  const store = await openDynamicTaskStore({ dbPath: join(root, 'isolated.sqlite'), instanceId: 'interactive-team-live', initialize: true })
  let sequence = 0, workspace, manager
  const command = (kind, args) => store.command({ id: `live-${++sequence}`, kind, args })
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const real = ctx.subprocess
  const subprocess = {
    resolveExecutable: (...args) => real.resolveExecutable(...args),
    spawn: spec => real.spawn(spec),
    async spawnTerminal(spec) {
      assert.ok(!spec.argv.includes('-p') && !spec.argv.includes('--print'))
      const arg = flag => { const i = spec.argv.indexOf(flag); return i < 0 ? null : spec.argv[i + 1] }
      assert.equal(arg('--setting-sources'), 'user')
      assert.equal(arg('--system-prompt-snapshot'), 'off')
      assert.ok(!spec.argv.some(value => String(value).includes('skip-permissions')))
      const settings = JSON.parse(arg('--settings'))
      assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1')
      result.launches.push({ sessionId: arg('--session-id'), resume: arg('--resume'), interactive: true })
      const handle = await real.spawnTerminal(spec)
      void handle.done.then(outcome => { result.launches.at(-1).pid = handle.pid; result.launches.at(-1).outcome = outcome })
      return handle
    },
  }
  const frozen = []
  try {
    await command('task.create', { taskId: 'interactive-team-live', request: '隔离验证交互 Claude Lead 创建两个原生队友并协调核算，无业务操作' })
    const owner = (await command('task.claim', { taskId: 'interactive-team-live' })).result.binding
    workspace = await taskWorkspace(root, owner.taskId)
    manager = createClaudeExecutionSessions({ ctx: { subprocess }, isCurrent: binding => query('execution.current', { binding }), getWorkspaceDir: async () => workspace })
    const prompt = '这是用户明确授权的隔离 Agent Teams 验收。你是交互式 team lead。请用 Agent 工具 subagent_type=dsh-worker 创建两个原生队友，分别名为 calc 和 check（不得普通前台subagent），calc 计算37乘19，check 独立核算并通过 SendMessage 与 calc 和你沟通一次结论。不要使用 Bash、写文件、Web 或外部会话；不需要另建DSH执行。用 execution_report_progress 报告职责和结果。等待两人明确报告703，然后用 SendMessage shutdown_request 让两人结束并确认团队排空，再调用 execution_submit，output.status=completed，summary包含703，evidence给出实际团队消息证据，artifacts可空，limitations说明无业务验证。队友停止后不要重复shutdown，不要自行退出CLI，Host负责退出。'
    const execution = (await command('execution.dispatch', { binding: owner, key: 'lead', prompt, input: { objective: '交互Lead创建calc/check两个原生队友并完成协作、排空、提交' }, definition: { executionBackend: 'claude-code' } })).result.execution
    for (let round = 1; round <= 2; round++) {
      if (round === 2) await command('execution.continue', { binding: owner, executionId: execution.executionId, key: 'verify-second-round', prompt: `第二轮仅由lead只读复核上一轮703结论及两位队员的执行文档，不再创建队友。另用原生PowerShell工具精确执行一次 ${powershellCommand} 验证Windows命令通路，不得执行其他命令。报告计划和复核结果，再execution_submit completed，summary包含703、命令输出和本轮指令标记DSH_RESUME_INSTRUCTION_R31（此标记只在本轮definition.prompt提供）；不要自行退出。`, input: { objective: '原会话续办、保留第一轮文档及Windows原生命令门禁' } })
      const claimed = (await command('execution.claim', { executionId: execution.executionId })).result
      const { binding } = claimed
      const document = await materializeExecutionDocument(root, claimed.execution)
      let progressSequence = 0, timedOut = false, cancelError
      const heartbeat = setInterval(() => console.log(JSON.stringify({ round, phase: 'waiting' })), 30000)
      const timer = setTimeout(() => { timedOut = true; void manager.cancel(binding.executionId).catch(error => { cancelError = error.message }) }, result.deadlineMsPerRound)
      let outcome
      try {
        outcome = await manager.run({ binding, input: { ...claimed.execution.input, executionDocument: document }, definition: { ...claimed.execution.definition, prompt: claimed.execution.prompt, outputSchema: dynamicExecutionOutputSchema },
          onSessionBound: () => command('execution.sessionBound', { binding }),
          onNativeExecution: async event => {
            if (event.toolName === 'PowerShell') {
              assert.equal(round, 2); assert.equal(event.arguments.command, powershellCommand)
              const key = `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${event.callId}`, operationId = `operation-${digest(key).slice(0, 40)}`
              if (event.phase === 'started') {
                await command('operation.prepare', { binding, operationId, key, definition: { toolName: event.toolName, argumentsDigest: digest(event.arguments), effectClass: event.effectClass }, authorizationRef: `task:${binding.taskId}:requirement:${binding.requirementRevision}`, resourceKeys: [] })
                assert.equal((await command('operation.start', { binding, operationId })).dispatchEligible, true)
              } else {
                assert.equal(event.result.isError, false); assert.match(JSON.stringify(event.result.content), /DSH_CLAUDE_PTY_OK/)
                await command('operation.settle', { binding, operationId, state: 'succeeded', result: { callId: event.callId, toolName: event.toolName, isError: false, resultDigest: digest(event.result.content) } })
              }
              return { operationId }
            }
            assert.equal(event.toolName, 'Read', 'fixture permits native Read only')
            assert.ok(inside(workspace, resolve(event.arguments.file_path)), 'fixture read must stay within task workspace')
            return { readOnly: true }
          },
          onProgress: async args => {
            const receipt = await command('execution.progressReported', { binding, summary: args.summary, evidence: args.evidence, ...(args.plan === undefined ? {} : { plan: args.plan }), ...(args.activity === undefined ? {} : { activity: args.activity }), sequence: ++progressSequence })
            return { recorded: true, document: await materializeExecutionDocument(root, receipt.result.execution) }
          },
          readTeam: () => query('execution.team', { binding }), readResources: () => query('execution.resources', { binding }),
          readFeedback: async () => (await query('execution.get', { executionId: binding.executionId })).feedback,
          onFeedbackConsumed: proof => command('execution.feedbackConsumed', { binding, ...proof }),
          onResult: (output, proof) => command('execution.result', { binding, output, ...proof }),
        })
      } finally { clearTimeout(timer); clearInterval(heartbeat) }
      assert.equal(timedOut, false, cancelError ?? 'model deadline exceeded')
      assert.equal(outcome.status, 'submitted'); assert.equal(outcome.output.status, 'completed')
      assert.match(outcome.output.summary, /703/)
      manager.assertDrained(binding)
      await command('execution.drained', { binding })
      const current = await query('execution.get', { executionId: execution.executionId })
      const finalDocument = await materializeExecutionDocument(root, current)
      const progress = await manager.readProgress({ execution: current })
      const events = (await readFile(claudeExecutionLogPath(workspace, execution.executionId), 'utf8')).trim().split('\n').map(JSON.parse).filter(event => event.binding.inputVersion === round)
      const spawns = events.filter(event => event.type === 'hook' && event.data.tool_name === 'Agent' && event.data.tool_response?.status === 'teammate_spawned')
      if (round === 1) {
        assert.equal(spawns.length, 2, 'must prove exactly two native teammates')
        assert.equal(progress.memberDocuments.length, 2)
        const messages = events.filter(event => event.type === 'hook' && event.data.hook_event_name === 'PostToolUse' && event.data.tool_name === 'SendMessage')
        for (const member of progress.memberDocuments) assert.ok(messages.some(event => event.data.agent_id === member.agentId && JSON.stringify(event.data.tool_input).includes('703')), 'each teammate must actually communicate its result')
        result.teamMessages = messages.map(event => ({ agentId: event.data.agent_id, input: event.data.tool_input, result: event.data.tool_response }))
        const transcriptPath = events.find(event => event.type === 'hook' && event.data.transcript_path)?.data.transcript_path
        const transcript = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse)
        result.receivedTeamMessages = transcript.filter(event => event.type === 'attachment' && event.attachment?.origin?.kind === 'peer').map(event => event.attachment)
        for (const member of progress.memberDocuments) assert.ok(result.receivedTeamMessages.some(value => value.origin.from === member.name && JSON.stringify(value).includes('703')), 'lead must actually receive each teammate result')
        for (const member of progress.memberDocuments) { const path = join(workspace, member.relativePath); frozen.push({ path, sha256: sha(await readFile(path)) }) }
      }
      if (round === 2) { assert.match(outcome.output.summary, /DSH_RESUME_INSTRUCTION_R31/); const operations = await query('operation.list', { taskId: binding.taskId }); assert.equal(operations.length, 1); assert.equal(operations[0].state, 'succeeded'); result.operations = operations }
      for (const item of frozen) assert.equal(sha(await readFile(item.path)), item.sha256, 'prior round changed')
      frozen.push({ path: finalDocument.path, sha256: sha(await readFile(finalDocument.path)) })
      result.rounds.push({ round, binding, status: 'PASS', progressSequence, members: progress.memberDocuments, output: outcome.output, drained: current.drained })
      await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
      console.log(JSON.stringify({ round, status: 'PASS', members: progress.memberDocuments.length }))
    }
    assert.equal(result.launches[0].sessionId, result.launches[1].resume)
    result.status = 'PASS'
  } catch (error) { result.failure = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    await manager?.close().catch(error => { result.cleanupError = error.message; result.status = 'FAIL'; process.exitCode = 1 })
    await store.close(); await ctx.fiber.dispose()
    result.completedAt = new Date().toISOString()
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ status: result.status, failure: result.failure, output: root }))
  }
}
