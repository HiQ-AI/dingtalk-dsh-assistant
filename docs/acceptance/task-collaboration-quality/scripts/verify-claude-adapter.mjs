// 真实 CLI + 真实 Host subprocess + 生产 Store；模型响应固定在回环端口，无真实账号调用。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { createClaudeExecutionSessions, claudeExecutionLogPath } from '../../../../packages/dingtalk-dsh-assistant/claude-execution-session.js'
import { openDynamicTaskStore } from '../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { dynamicExecutionOutputSchema } from '../../../../packages/dingtalk-dsh-assistant/task-session-service.js'
import { taskWorkspace, materializeExecutionDocument } from '../../../../packages/dingtalk-dsh-assistant/session-workspaces.js'

const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
if (process.argv.includes('--check')) {
  assert.equal(dynamicExecutionOutputSchema.type, 'object')
  assert.ok(dynamicExecutionOutputSchema.required.includes('evidence'))
  assert.equal(new URL('http://127.0.0.1:1').hostname, '127.0.0.1')
  console.log('PASS: zero-effect configuration/schema check; no CLI, files, server, account or model started')
  process.exit(0)
}
const root = resolve(process.argv[2] ?? `docs/tmp/claude-adapter-native-${Date.now()}`)
const startedAt = Date.now()
const permitted = resolve('docs/tmp')
assert.ok(relative(permitted, root) && !relative(permitted, root).startsWith('..'), 'output must be a fresh docs/tmp child')
await assert.rejects(lstat(root), { code: 'ENOENT' })
await mkdir(root, { recursive: true })
const profile = createRequire(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? 'test/fixtures/native-profile/package.json'))
const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
const { Context } = profile('@deepseek-ai/cordis'), { LocalSubprocessRuntime } = native('@deepseek-ai/dsh-subprocess-local')
const ctx = new Context(); new LocalSubprocessRuntime(ctx)
const store = await openDynamicTaskStore({ dbPath: join(root, 'synthetic.sqlite'), instanceId: 'cli-adapter-probe', initialize: true })
let commandSequence = 0, round = 1, modelCalls = 0, binding, manager
const command = (kind, args, id = `command-${++commandSequence}`) => store.command({ id, kind, args })
const query = (kind, args = {}) => store.query({ kind, ...args })
const trace = [], summaries = [], launches = []
await command('task.create', { taskId: 'cli-contract', request: '仅核对合成目标文件与CLI协议，无业务操作' })
const owner = (await command('task.claim', { taskId: 'cli-contract' })).result.binding
const workspace = await taskWorkspace(root, owner.taskId), target = join(workspace, 'work', 'fixture.txt')
const output = () => ({ status: 'completed', summary: `合成协议第${round}轮已完成`, evidence: ['work/fixture.txt'], limitations: ['未调用真实模型，未执行真实业务'], artifacts: ['work/fixture.txt'] })
const plans = () => [
  ...(round === 1 ? [{ name: 'Write', input: { file_path: target, content: 'synthetic-cli-adapter\n' } }] : []),
  { name: 'Read', input: { file_path: target } },
  { name: 'mcp__dsh__execution_report_progress', input: { summary: '合成文件已写入并独立读取', evidence: ['work/fixture.txt'], plan: '核对原文，读取团队，提交本轮证据', activity: '核对合成结果' } },
  { name: 'mcp__dsh__execution_team_read', input: {} },
  { name: 'mcp__dsh__execution_submit', input: { output: output() } },
]
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url.includes('/messages/count_tokens')) return json(res, { input_tokens: 1 })
    if (!req.url.includes('/messages')) return json(res, {})
    const number = ++modelCalls, step = plans()[number - 1]
    trace.push({ round, number, tools: body.tools?.map(tool => tool.name), bashBackgroundParameterPresent: Object.hasOwn(body.tools?.find(tool => tool.name === 'Bash')?.input_schema?.properties ?? {}, 'run_in_background'), results: body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(item => item.type === 'tool_result') })
    const content = step ? { type: 'tool_use', id: `toolu_r${round}_${number}`, ...step } : { type: 'text', text: 'Synthetic fixture complete.' }
    const message = { id: `msg_r${round}_${number}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    if (!body.stream) return json(res, { ...message, content: [content], stop_reason: step ? 'tool_use' : 'end_turn' })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', { type: 'message_start', message })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: step ? { ...content, input: {} } : { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: step ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } : { type: 'text_delta', text: content.text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    send('message_stop', { type: 'message_stop' }); res.end()
  } catch (error) { trace.push({ serverError: error.message }); res.destroy() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`, real = ctx.subprocess
const subprocess = {
  resolveExecutable: (...args) => real.resolveExecutable(...args),
  spawn(spec) {
    const argument = flag => { const index = spec.argv.indexOf(flag); return index < 0 ? null : spec.argv[index + 1] }
    launches.push({ sessionId: argument('--session-id'), resume: argument('--resume'), backgroundTasksDisabled: spec.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1' })
    assert.equal(spec.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
    return real.spawn({ ...spec, env: { ...spec.env, ANTHROPIC_API_KEY: 'synthetic-not-a-real-key', ANTHROPIC_BASE_URL: base,
      CLAUDE_CONFIG_DIR: join(root, 'isolated-cli-config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  },
}
manager = createClaudeExecutionSessions({ ctx: { subprocess }, isCurrent: value => query('execution.current', { binding: value }), getWorkspaceDir: async () => workspace })
let failure
try {
  const first = (await command('execution.dispatch', { binding: owner, key: 'cli-probe', prompt: '只核对本例合成文件', input: { objective: '合成CLI协议核验' }, definition: { executionBackend: 'claude-code' } })).result.execution
  for (round = 1; round <= 2; round++) {
    modelCalls = 0
    if (round === 2) await command('execution.continue', { binding: owner, executionId: first.executionId, key: 'round-two', prompt: '沿原会话只读核对前轮合成文件', input: { objective: '原会话第二轮核对' } })
    const claimed = (await command('execution.claim', { executionId: first.executionId })).result
    binding = claimed.binding
    let progressSequence = 0
    const document = await materializeExecutionDocument(root, claimed.execution)
    const deadline = setTimeout(() => void manager.cancel(binding.executionId), 30000)
    let result
    try {
      result = await manager.run({ binding, input: { ...claimed.execution.input, executionDocument: document }, definition: { prompt: claimed.execution.prompt, outputSchema: dynamicExecutionOutputSchema },
        onSessionBound: () => command('execution.sessionBound', { binding }),
        onNativeExecution: async event => {
          const key = `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${event.callId}`, operationId = `operation-${digest(key).slice(0, 40)}`
          if (event.effectClass === 'read') return { readOnly: true }
          if (event.phase === 'started') {
            if (round === 1 && event.toolName === 'Write') await assert.rejects(lstat(target), { code: 'ENOENT' })
            await command('operation.prepare', { binding, operationId, key, definition: { toolName: event.toolName, argumentsDigest: digest(event.arguments), effectClass: event.effectClass }, authorizationRef: `task:${binding.taskId}:requirement:${binding.requirementRevision}`, resourceKeys: [] })
            const receipt = await command('operation.start', { binding, operationId }); assert.equal(receipt.dispatchEligible, true)
          } else await command('operation.settle', { binding, operationId, state: event.cancelled || event.result.isError ? 'unknown' : 'succeeded', result: { callId: event.callId, toolName: event.toolName, isError: event.result.isError, resultDigest: digest(event.result.content) } })
        },
        onProgress: async args => { const receipt = await command('execution.progressReported', { binding, summary: args.summary, evidence: args.evidence, plan: args.plan, activity: args.activity, sequence: ++progressSequence }); return { recorded: true, document: await materializeExecutionDocument(root, receipt.result.execution) } },
        readTeam: () => query('execution.team', { binding }), readResources: () => query('execution.resources', { binding }),
        readFeedback: async () => (await query('execution.get', { executionId: binding.executionId })).feedback,
        onFeedbackConsumed: proof => command('execution.feedbackConsumed', { binding, ...proof }),
        onResult: (value, proof) => command('execution.result', { binding, output: value, ...proof }),
      })
    } finally { clearTimeout(deadline) }
    assert.equal(result.status, 'submitted')
    manager.assertDrained(binding)
    await command('execution.drained', { binding })
    const current = await query('execution.get', { executionId: binding.executionId })
    await materializeExecutionDocument(root, current)
    assert.equal(await readFile(target, 'utf8'), 'synthetic-cli-adapter\n')
    summaries.push({ round, status: result.status, modelCalls, executionId: current.executionId, sessionId: current.sessionId, inputVersion: current.inputVersion, drained: current.drained })
  }
  assert.equal(launches[0].sessionId, launches[1].resume)
  assert.equal(launches[0].resume, null); assert.equal(launches[1].sessionId, null)
  assert.ok(trace.filter(item => item.number).every(item => item.bashBackgroundParameterPresent === false), 'disabled background parameter must not be offered to the model')
  const operations = await query('operation.list', { taskId: owner.taskId })
  assert.equal(operations.length, 1); assert.equal(operations[0].state, 'succeeded')
  summaries.push({ operations: operations.map(item => ({ operationId: item.operationId, state: item.state })) })
} catch (error) { failure = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await manager.close().catch(error => { failure ??= { message: error.message } })
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await store.close(); await ctx.fiber.dispose()
  await writeFile(join(root, 'model-protocol.json'), JSON.stringify(trace, null, 2))
  const sources = Object.fromEntries(await Promise.all(['packages/dingtalk-dsh-assistant/claude-execution-session.js', 'packages/dingtalk-dsh-assistant/dynamic-task-store.js', 'docs/acceptance/task-collaboration-quality/scripts/verify-claude-adapter.mjs'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  await writeFile(join(root, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', elapsedMs: Date.now() - startedAt, summaries, launches, sources, failure, boundary: 'Real CLI and Host runtime, synthetic loopback model only; no real account/model/business validation.' }, null, 2))
  console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', summaries, failure, output: relative(process.cwd(), root), journal: binding ? relative(root, claudeExecutionLogPath(workspace, binding.executionId)) : null }))
}
