import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, link, symlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClaudeExecutionSessions, claudeExecutionLogPath } from '../packages/dingtalk-dsh-assistant/claude-execution-session.js'

// 只替换 Claude 可执行文件为固定协议程序；进程范围、管道和 MCP HTTP 均真实运行。
// 不使用真实账户或模型，不把合成协议通过称为 Claude 推理/业务验收。
const profile = createRequire(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? 'test/fixtures/native-profile/package.json'))
let Context, LocalSubprocessRuntime, unavailable
try {
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  ;({ Context } = profile('@deepseek-ai/cordis'))
  ;({ LocalSubprocessRuntime } = native('@deepseek-ai/dsh-subprocess-local'))
} catch (error) { unavailable = error.message }
const options = { skip: unavailable ? `Locked native profile required: ${unavailable}` : false, timeout: 20000 }
const output = { status: 'completed', summary: '已读取合成证据', evidence: ['fixture.txt'], limitations: [], artifacts: [] }
const schema = { type: 'object', properties: { status: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } }, artifacts: { type: 'array', items: { type: 'object' } } }, required: ['status', 'summary', 'evidence', 'limitations', 'artifacts'], additionalProperties: false }
const identity = extra => ({ kind: 'task-execution', taskId: 'cli-task', executionId: randomUUID(), sessionId: `task-execution-${randomUUID()}`,
  requirementRevision: 1, controlRevision: 1, inputVersion: 1, inputDigest: 'synthetic-input-one', inputHistory: [], leaseEpoch: 1, sessionBound: false, ...extra })

async function until(read, label, timeout = 7000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(15) }
  throw new Error(`Timed out: ${label}`)
}
async function exists(path) { try { return await readFile(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

// 代码随每个测试写入其专用目录；没有全局进程、共享端口或真实 Claude 会话。
async function fixtureMain() {
  const { readFile, writeFile, appendFile } = await import('node:fs/promises')
  const { createInterface } = await import('node:readline')
  const { spawn } = await import('node:child_process')
  const { setTimeout: delay } = await import('node:timers/promises')
  const [planPath, ...args] = process.argv.slice(2), plan = JSON.parse(await readFile(planPath, 'utf8'))
  const argument = name => args[args.indexOf(name) + 1]
  const session = argument(args.includes('--resume') ? '--resume' : '--session-id')
  const configuration = JSON.parse(argument('--mcp-config')), server = Object.values(configuration.mcpServers)[0]
  const trace = data => appendFile(plan.trace, JSON.stringify(data) + '\n')
  const emit = data => new Promise(resolve => process.stdout.write(JSON.stringify({ session_id: session, ...data }) + '\n', resolve))
  let sequence = 0, feedbackReceipt
  const rpc = async (method, params) => {
    const response = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
    const text = await response.text()
    const value = text.startsWith('event:') || text.startsWith('data:') ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text)
    await trace({ method, name: params?.name, status: response.status, response: value })
    return value.result
  }
  const inputs = [], readers = []
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => { const input = JSON.parse(line); const reader = readers.shift(); if (reader) reader(input); else inputs.push(input) })
  const nextInput = () => inputs.length ? Promise.resolve(inputs.shift()) : new Promise(resolve => readers.push(resolve))
  const input = await nextInput()
  await trace({ kind: 'input', uuid: input.uuid, text: input.message?.content })
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-cli', version: '1' } })
  await rpc('tools/list', {})
  await emit({ type: 'system', subtype: 'init', session_id: plan.wrongSession ? '00000000-0000-0000-0000-000000000000' : session, claude_code_version: '2.1.212', permissionMode: 'default', mcp_servers: [{ name: 'dsh', status: 'connected' }], tools: [] })
  if (input.uuid) await emit({ ...input, type: 'user', isReplay: true })
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind === 'wait') {
      await trace({ kind: 'waiting', key: step.key })
      for (;;) { try { await readFile(step.path); break } catch (e) { if (e.code !== 'ENOENT') throw e; await delay(10) } }
    } else if (step.kind === 'native') {
      const id = step.id ?? `toolu_${index}`
      if (!step.alreadyEmitted) await emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: step.args }] } })
      const result = await rpc('tools/call', { name: 'permission', arguments: { tool_name: step.name, tool_use_id: id, input: step.args } })
      let decision
      try { decision = JSON.parse(result?.content?.[0]?.text) } catch {}
      if (decision?.behavior === 'allow' && step.write) await writeFile(step.write, step.bytes)
      await trace({ kind: 'native-decision', id, allowed: decision?.behavior === 'allow' })
      if (!step.omitResult) await emit({ type: 'user', ...(step.backgroundReceipt ? { tool_use_result: { backgroundTaskId: 'synthetic-background-task' } } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: decision?.behavior !== 'allow', content: decision?.behavior === 'allow' ? 'synthetic tool completed' : 'synthetic denied' }] } })
    } else if (step.kind === 'tool') {
      const id = step.id ?? `toolu_${index}`
      const args = { ...step.args, ...(step.useFeedbackReceipt ? { feedbackReceipt } : {}) }
      await emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__dsh__${step.name}`, input: args }] } })
      const result = await rpc('tools/call', { name: step.name, arguments: args, _meta: { 'claudecode/toolUseId': id } })
      if (step.name === 'execution_feedback_read' && !result?.isError) feedbackReceipt = JSON.parse(result.content[0].text).feedbackReceipt
      if (!step.omitResult) await emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: result?.isError === true, content: result?.content ?? [] }] } })
    } else if (step.kind === 'ack-input') {
      const next = await nextInput()
      await trace({ kind: 'feedback', uuid: next.uuid, text: next.message?.content })
      await emit({ ...next, type: 'user', isReplay: true })
    } else if (step.kind === 'descendant') {
      const source = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(step.pidPath)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(step.path)},'x'),20)`
      spawn(process.execPath, ['-e', source], { stdio: 'ignore', windowsHide: true })
    } else if (step.kind === 'emit') await emit(step.value)
    else if (step.kind === 'bad-json') process.stdout.write('{broken-json\n')
  }
  if (!plan.omitTerminal) await emit({ type: 'result', subtype: 'success', is_error: false, result: '合成终态，不是 Host 提交证据' })
  lines.close(); process.stdin.destroy()
}

async function harness(t, { steps = [], isCurrent = async () => true, beforeResolve, beforeSpawn, wrapHandle, ...planExtra } = {}) {
  const bucket = resolve('docs/tmp/claude-execution-native-tests')
  await mkdir(bucket, { recursive: true })
  const root = await mkdtemp(join(bucket, 'run-')), tracePath = join(root, 'trace.jsonl'), fixture = join(root, 'fixture.mjs'), planPath = join(root, 'plan.json')
  await writeFile(fixture, `(${fixtureMain.toString()})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1})`)
  const plan = { steps, trace: tracePath, ...planExtra }
  await writeFile(planPath, JSON.stringify(plan))
  const ctx = new Context(); new LocalSubprocessRuntime(ctx)
  const real = ctx.subprocess, spawns = [], effects = [], results = [], progress = [], consumed = [], feedback = []
  const subprocess = { resolveExecutable: async name => { assert.equal(name, 'claude'); await beforeResolve?.(); return process.execPath }, async spawn(spec) {
    spawns.push(structuredClone({ argv: spec.argv, cwd: spec.cwd, env: spec.env }))
    await beforeSpawn?.()
    const handle = real.spawn({ ...spec, argv: [process.execPath, fixture, planPath, ...spec.argv.slice(1)] })
    return wrapHandle ? wrapHandle(handle) : handle
  } }
  const manager = createClaudeExecutionSessions({ ctx: { subprocess }, isCurrent, getWorkspaceDir: async () => root })
  let bound = 0
  const h = { root, manager, spawns, effects, results, progress, consumed, feedback, ctx,
    async setPlan(next) { Object.assign(plan, next); await writeFile(planPath, JSON.stringify(plan)) },
    async trace() { return (await exists(tracePath))?.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) ?? [] },
    run(binding = identity(), extra = {}) { return manager.run({ binding, input: { objective: '合成协议核验' }, title: '合成执行', definition: { nativeTools: true, allowedTools: [], outputSchema: schema, prompt: '只执行合成夹具步骤' },
      onSessionBound: async () => { bound++ }, onNativeExecution: async event => { effects.push(structuredClone(event)); return {} },
      onResult: async (value, proof) => { results.push({ value, proof }); return { accepted: true } }, onProgress: async value => { progress.push(value); return { accepted: true } },
      readResources: async () => ({ resources: [] }), readTeam: async () => ({ executions: [] }), sendMessage: async () => ({ received: true }),
      readFeedback: async () => structuredClone(feedback), onFeedbackConsumed: async proof => { consumed.push(proof); const item = feedback.find(item => item.id === proof.messageId); if (item) item.consumedAt = 'synthetic-host-ack' }, ...extra }) },
    get bound() { return bound },
  }
  t.after(async () => { try { await manager.close().catch(error => { if (error.code !== h.expectedCloseError) throw error }) } finally { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } } })
  return h
}

test('CLI candidate requires Host submit and matching tool result before final acceptance', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_report_progress', args: { summary: '已定位合成证据', evidence: ['fixture.txt'], plan: '只读核对再提交', activity: '读取合成证据' } }, { kind: 'tool', name: 'execution_submit', args: { output } }] })
  const binding = identity(), result = await h.run(binding)
  assert.equal(result.status, 'submitted')
  assert.equal(h.bound, 1); assert.equal(h.progress.length, 1); assert.equal(h.results.length, 1)
  assert.deepEqual(h.results[0].value, output)
  h.manager.assertDrained(binding)
  const argv = h.spawns[0].argv
  assert.equal(argv[argv.indexOf('--session-id') + 1], binding.sessionId.slice('task-execution-'.length))
  assert.equal(argv.includes('--continue'), false); assert.equal(argv.includes('--dangerously-skip-permissions'), false)
  assert.equal(argv.includes('--strict-mcp-config'), true)
  assert.deepEqual(h.spawns[0].env, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, '只提供固定控制参数，不转发整个Host环境')
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
  assert.equal(settings.disableAllHooks, true); assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false)
  const records = (await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records.at(-1).type, 'drained')
  assert.ok(records.every(event => event.provider === 'claude-code' && event.binding.sessionId === binding.sessionId))
  assert.ok(!JSON.stringify(records).includes('Bearer '), '运行令牌不进入持久日志')
})

for (const omitSubmitResult of [false, true]) test(`CLI exit zero cannot replace ${omitSubmitResult ? 'submit tool result' : 'Host submit'}`, options, async t => {
  const h = await harness(t, { steps: omitSubmitResult ? [{ kind: 'tool', name: 'execution_submit', args: { output }, omitResult: true }] : [] })
  const binding = identity(), result = await h.run(binding)
  assert.equal(result.status, 'no_submission'); assert.equal(h.results.length, 0)
  h.manager.assertDrained(binding)
})

test('CLI wrong provider session fails without binding or accepting a result', options, async t => {
  const h = await harness(t, { wrongSession: true })
  const binding = identity()
  await assert.rejects(h.run(binding), { code: 'claude_execution_provider_session_mismatch' })
  assert.equal(h.bound, 0); assert.equal(h.results.length, 0)
  h.manager.assertDrained(binding)
})

test('CLI stale lease before permission denies real file mutation', options, async t => {
  let current = true
  const h = await harness(t, { isCurrent: async () => current })
  const gate = join(h.root, 'release'), target = join(h.root, 'effect.txt')
  await h.setPlan({ steps: [{ kind: 'wait', key: 'permission', path: gate }, { kind: 'native', name: 'Write', args: { file_path: target, content: 'forbidden' }, write: target, bytes: 'forbidden' }] })
  const binding = identity(), running = h.run(binding)
  await until(async () => (await h.trace()).some(item => item.kind === 'waiting'), 'before permission')
  current = false; await writeFile(gate, 'go')
  assert.equal((await running).status, 'stale')
  assert.equal(await exists(target), null); assert.equal(h.effects.length, 0); assert.equal(h.results.length, 0)
  h.manager.assertDrained(binding)
})

test('CLI operation gate failure denies a mutation before the child writes it', options, async t => {
  const h = await harness(t), target = join(h.root, 'effect.txt')
  await h.setPlan({ steps: [{ kind: 'native', name: 'Write', args: { file_path: target, content: 'forbidden' }, write: target, bytes: 'forbidden' }] })
  const attempted = []
  const result = await h.run(identity(), { onNativeExecution: async event => { attempted.push(event.phase); throw Object.assign(new Error('unknown earlier effect'), { code: 'DYNAMIC_OPERATION_UNRESOLVED' }) } })
  assert.equal(result.status, 'no_submission'); assert.equal(await exists(target), null)
  assert.deepEqual(attempted, ['started']); assert.equal(h.results.length, 0)
  assert.ok((await h.trace()).some(item => item.kind === 'native-decision' && item.allowed === false))
})

test('CLI cancellation drains the actual parent and heartbeat descendant before releasing the identity', options, async t => {
  const h = await harness(t), heartbeat = join(h.root, 'heartbeat.txt'), pidPath = join(h.root, 'descendant.pid')
  await h.setPlan({ steps: [{ kind: 'descendant', path: heartbeat, pidPath }, { kind: 'wait', key: 'alive', path: join(h.root, 'never-release') }] })
  const binding = identity(), running = h.run(binding)
  await until(async () => (await exists(heartbeat))?.length >= 2, 'descendant heartbeat')
  assert.throws(() => h.manager.assertDrained(binding), error => error.executionDrained === false)
  await h.manager.cancel(binding.executionId)
  assert.equal((await running).status, 'cancelled'); h.manager.assertDrained(binding)
  const before = await readFile(heartbeat); await delay(100)
  assert.deepEqual(await readFile(heartbeat), before, '排空返回后孙进程不再写入')
  const pid = Number(await readFile(pidPath, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '独立核对受测孙进程已结束')
})

test('CLI original identity resumes explicitly and missing bound history cannot launch a substitute', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }] }), first = identity()
  await h.run(first)
  const next = { ...first, inputVersion: 2, inputDigest: 'synthetic-input-two', leaseEpoch: 2, sessionBound: true,
    inputHistory: [{ inputVersion: 1, inputDigest: first.inputDigest, requirementRevision: 1, controlRevision: 1 }] }
  assert.equal((await h.run(next)).status, 'submitted')
  const argv = h.spawns[1].argv
  assert.equal(argv[argv.indexOf('--resume') + 1], first.sessionId.slice('task-execution-'.length))
  assert.equal(argv.includes('--session-id'), false); assert.equal(argv.includes('--continue'), false)
  const missing = identity({ sessionBound: true })
  await assert.rejects(h.run(missing), { code: 'claude_execution_bound_history_missing' })
  assert.equal(h.spawns.length, 2, '日志缺失不得用新进程替代原会话')
})

test('CLI truncated output fails with zero acceptance and retained diagnostic log', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'bad-json' }] }), binding = identity()
  await assert.rejects(h.run(binding), { code: 'claude_execution_stream_invalid' })
  assert.equal(h.results.length, 0)
  h.manager.assertDrained(binding)
  const log = await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')
  assert.match(log, /claude_execution_stream_invalid/)
})

test('CLI real file mutation is accounted before write and settled after its observed result', options, async t => {
  const h = await harness(t), target = join(h.root, 'effect.txt'), observations = []
  await h.setPlan({ steps: [{ kind: 'native', name: 'Write', args: { file_path: target, content: 'one actual effect' }, write: target, bytes: 'one actual effect' }, { kind: 'tool', name: 'execution_submit', args: { output } }] })
  const result = await h.run(identity(), { onNativeExecution: async event => { observations.push({ phase: event.phase, bytes: (await exists(target))?.toString() ?? null }); return {} } })
  assert.equal(result.status, 'submitted', JSON.stringify({ observations, bridge: (await h.trace()).filter(item => item.method === 'tools/call') }))
  assert.deepEqual(observations, [{ phase: 'started', bytes: null }, { phase: 'settled', bytes: 'one actual effect' }])
  assert.equal(await readFile(target, 'utf8'), 'one actual effect')
})

test('CLI interrupted real mutation retains unknown effect while physical process drain remains provable', options, async t => {
  const h = await harness(t), target = join(h.root, 'effect.txt'), binding = identity()
  await h.setPlan({ steps: [{ kind: 'native', name: 'Write', args: { file_path: target, content: 'effect exists without result' }, write: target, bytes: 'effect exists without result', omitResult: true }, { kind: 'wait', key: 'effect-open', path: join(h.root, 'never-release') }] })
  const run = h.run(binding), rejected = assert.rejects(run, { code: 'claude_execution_operation_unresolved' })
  await until(async () => (await exists(target))?.toString(), 'effect before missing result')
  await h.manager.cancel(binding.executionId); await rejected
  assert.equal(await readFile(target, 'utf8'), 'effect exists without result')
  assert.equal(h.results.length, 0); assert.equal(h.effects.length, 2)
  assert.equal(h.effects[0].phase, 'started'); assert.equal(h.effects[1].phase, 'settled')
  assert.equal(h.effects[1].cancelled, true); assert.equal(h.effects[1].result.isError, true)
  h.manager.assertDrained(binding)
  const log = await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')
  assert.match(log, /tool.unknown/); assert.equal(JSON.parse(log.trim().split('\n').at(-1)).type, 'drained')
})

for (const reviewed of [false, true]) test(`CLI feedback ACK ${reviewed ? 'plus explicit review admits' : 'alone rejects'} final submit`, options, async t => {
  const h = await harness(t), binding = identity(), release = join(h.root, 'review-received')
  await h.setPlan({ steps: [{ kind: 'ack-input' }, ...(reviewed ? [{ kind: 'tool', name: 'execution_feedback_read', id: 'review-one', args: {} }, { kind: 'wait', key: 'review-ready', path: release }] : []), { kind: 'tool', name: 'execution_submit', args: { output }, useFeedbackReceipt: reviewed }] })
  h.feedback.push({ id: 'peer-one', text: '请核对新的证据范围', receivedAt: 'synthetic-time', consumedAt: null })
  const run = h.run(binding)
  if (reviewed) {
    await until(async () => {
      const bytes = await exists(claudeExecutionLogPath(h.root, binding.executionId))
      return bytes?.toString().split('\n').some(line => line && JSON.parse(line).data?.message?.content?.some?.(part => part.type === 'tool_result' && part.tool_use_id === 'review-one'))
    }, 'feedback review tool result persisted')
    await writeFile(release, 'go')
  }
  const result = await run
  assert.equal(h.consumed.length, 1, 'ACK 只登记一次输入准入')
  assert.equal(h.consumed[0].messageId, 'peer-one')
  assert.equal(result.status, reviewed ? 'submitted' : 'no_submission')
  assert.equal(h.results.length, reviewed ? 1 : 0)
  if (reviewed) assert.equal(h.results[0].proof.feedbackVersion, 1)
  else assert.ok((await h.trace()).some(item => item.response?.result?.isError && JSON.stringify(item.response).includes('feedback_review_required')))
})

test('CLI progress uses current lease and the exact stored observation contract', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }] }), binding = identity()
  await h.run(binding)
  const first = await h.manager.readProgress({ execution: binding })
  assert.ok(Number.isSafeInteger(first.lastSequence) && first.lastSequence >= 0)
  assert.ok(Number.isSafeInteger(first.newEventCount) && first.newEventCount > 0)
  assert.equal(first.changed, true); assert.equal(first.pendingToolCallCount, 0)
  const second = await h.manager.readProgress({ execution: { ...binding, progressReview: { lastSequence: first.lastSequence } } })
  assert.equal(second.changed, false); assert.equal(second.newEventCount, 0)
  const otherLease = await h.manager.readProgress({ execution: { ...binding, leaseEpoch: 2 } })
  assert.equal(otherLease.lastSequence, -1); assert.equal(otherLease.newEventCount, 0)
  assert.equal(otherLease.lastActivityAt, null, '旧租约报告不能伪装新执行活动')
})

test('CLI recovery requires a durable drain record and never launches work from an unfinished prefix', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }] }), binding = identity()
  await h.run(binding)
  const path = claudeExecutionLogPath(h.root, binding.executionId), full = await readFile(path, 'utf8')
  const recovery = createClaudeExecutionSessions({ ctx: { subprocess: h.ctx.subprocess }, isCurrent: async () => true, getWorkspaceDir: async () => h.root })
  t.after(() => recovery.close())
  assert.throws(() => recovery.assertDrained(binding), error => error.executionDrained === false)
  await recovery.recoverDrained({ binding: { ...binding, sessionBound: true } }); recovery.assertDrained(binding)
  const crashPrefix = full.split('\n').slice(0, 2).join('\n') + '\n'
  await writeFile(path, crashPrefix)
  const failedRecovery = createClaudeExecutionSessions({ ctx: { subprocess: h.ctx.subprocess }, isCurrent: async () => true, getWorkspaceDir: async () => h.root })
  t.after(() => failedRecovery.close())
  await assert.rejects(failedRecovery.recoverDrained({ binding: { ...binding, sessionBound: true } }), error => error.code === 'claude_execution_recovery_unresolved' && error.executionDrained === false)
  assert.equal(await readFile(path, 'utf8'), crashPrefix, '核验不得改写或补造旧排空事实')
  assert.equal(h.spawns.length, 1, '恢复只有读取，不能创建替代会话')
})

for (const phase of ['resolve', 'spawn']) test(`CLI cancellation during pending ${phase} cannot leave a late process running`, options, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const pause = async () => { entered.resolve(); await release.promise }
  const h = await harness(t, { [phase === 'resolve' ? 'beforeResolve' : 'beforeSpawn']: pause }), binding = identity()
  const run = h.run(binding).then(value => ({ value }), error => ({ error }))
  await entered.promise
  let cancelDone = false
  const cancel = h.manager.cancel(binding.executionId).then(() => { cancelDone = true })
  await delay(25); assert.equal(cancelDone, false, '尚未取得句柄时不能报告已排空')
  release.resolve(); await cancel
  const outcome = await run
  assert.equal(h.results.length, 0); assert.equal(h.bound, 0)
  assert.ok(outcome.value?.status === 'cancelled' || outcome.value?.status === 'stale' || outcome.error?.code === 'claude_execution_binding_stale', JSON.stringify(outcome))
  if (phase === 'resolve') assert.equal(h.spawns.length, 0, '取消后 executable 解析返回不能再派发 CLI')
  h.manager.assertDrained(binding)
  assert.equal(h.ctx.subprocess.live.size, 0, '真实 provider 已释放晚到的进程范围')
})

test('CLI cancellation waits for an already admitted MCP callback to finish', options, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_report_progress', args: { summary: '合成在途回调', evidence: [] } }] }), binding = identity()
  let callbackFinished = false, cancelDone = false
  const run = h.run(binding, { onProgress: async () => { entered.resolve(); await release.promise; callbackFinished = true; return { recorded: true } } })
  await entered.promise
  const cancel = h.manager.cancel(binding.executionId).then(() => { cancelDone = true })
  await delay(40); assert.equal(cancelDone, false, '关闭 HTTP listener 不等于其在途 callback 结束')
  assert.equal(callbackFinished, false)
  release.resolve(); await cancel
  assert.equal((await run).status, 'cancelled'); assert.equal(callbackFinished, true)
  h.manager.assertDrained(binding)
})

test('CLI history from a different session is rejected before spawn and remains unchanged', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }] }), first = identity()
  await h.run(first)
  const path = claudeExecutionLogPath(h.root, first.executionId), original = await readFile(path)
  await assert.rejects(h.run({ ...first, sessionId: `task-execution-${randomUUID()}`, sessionBound: true }), { code: 'claude_execution_history_identity_mismatch' })
  assert.equal(h.spawns.length, 1)
  assert.deepEqual(await readFile(path), original)
})

test('CLI old planned native call cannot use a later feedback read to mutate files', options, async t => {
  const h = await harness(t), binding = identity(), target = join(h.root, 'effect.txt'), release = join(h.root, 'review-received')
  const args = { file_path: target, content: 'old planned effect' }
  await h.setPlan({ steps: [{ kind: 'ack-input' },
    { kind: 'emit', value: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-write', name: 'Write', input: args }] } } },
    { kind: 'tool', name: 'execution_feedback_read', id: 'fresh-review', args: {} }, { kind: 'wait', key: 'review-ready', path: release },
    { kind: 'native', id: 'old-write', alreadyEmitted: true, name: 'Write', args, write: target, bytes: 'old planned effect' }] })
  h.feedback.push({ id: 'new-scope', text: '原方案有误，请先读范围变化', receivedAt: 'synthetic-time', consumedAt: null })
  const run = h.run(binding)
  await until(async () => {
    const bytes = await exists(claudeExecutionLogPath(h.root, binding.executionId))
    return bytes?.toString().split('\n').some(line => line && JSON.parse(line).data?.message?.content?.some?.(part => part.type === 'tool_result' && part.tool_use_id === 'fresh-review'))
  }, 'new review result persisted')
  await writeFile(release, 'go')
  assert.equal((await run).status, 'no_submission')
  assert.equal(h.consumed.length, 1); assert.equal(h.effects.length, 0); assert.equal(await exists(target), null)
  assert.ok((await h.trace()).some(item => item.kind === 'native-decision' && item.id === 'old-write' && !item.allowed))
})

test('CLI repeated native call identity does not replay a successful file effect', options, async t => {
  const h = await harness(t), target = join(h.root, 'effect.txt')
  const args = { file_path: target, content: 'once only' }
  await h.setPlan({ steps: [{ kind: 'native', id: 'one-write', name: 'Write', args, write: target, bytes: 'once only' },
    { kind: 'native', id: 'one-write', name: 'Write', args, write: target, bytes: 'REPLAYED' }] })
  await h.run(identity())
  assert.equal(await readFile(target, 'utf8'), 'once only')
  assert.deepEqual(h.effects.map(event => event.phase), ['started', 'settled'])
  assert.deepEqual((await h.trace()).filter(item => item.kind === 'native-decision').map(item => item.allowed), [true, false])
})

test('CLI executable unavailable before init retries the original UUID with session-id instead of resume', options, async t => {
  let attempts = 0, h
  h = await harness(t, { beforeResolve: async () => { if (++attempts === 1) await h.ctx.subprocess.resolveExecutable('dsh-fixture-nonexistent-claude-executable') }, steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }] })
  const binding = identity()
  await assert.rejects(h.run(binding), /not found|not an executable/)
  assert.equal(h.spawns.length, 0); assert.equal(h.bound, 0); h.manager.assertDrained(binding)
  const retry = { ...binding, leaseEpoch: 2 }
  assert.equal((await h.run(retry)).status, 'submitted')
  const argv = h.spawns[0].argv
  assert.equal(argv.includes('--resume'), false)
  assert.equal(argv[argv.indexOf('--session-id') + 1], binding.sessionId.slice('task-execution-'.length))
  const records = (await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.filter(item => item.type === 'start').map(item => item.data.resumed), [false, false])
})

for (const kind of ['hardlink', 'junction']) test(`CLI journal rejects ${kind} without modifying its target or spawning`, options, async t => {
  const h = await harness(t), binding = identity(), path = claudeExecutionLogPath(h.root, binding.executionId), foreign = join(h.root, 'foreign')
  await mkdir(foreign)
  const target = join(foreign, 'claude-events.jsonl'), original = 'PROTECTED_FOREIGN_JOURNAL\n'
  await writeFile(target, original)
  if (kind === 'hardlink') { await mkdir(dirname(path), { recursive: true }); await link(target, path) }
  else { await mkdir(join(h.root, 'outputs')); await symlink(foreign, dirname(path), 'junction') }
  await assert.rejects(h.run(binding), error => /path|directory|symlink|link|scope/i.test(error.code ?? error.message))
  assert.equal(h.spawns.length, 0); assert.equal(h.bound, 0)
  assert.equal(await readFile(target, 'utf8'), original)
})

test('CLI unproven process drain retains the execution slot and never accepts the result', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'tool', name: 'execution_submit', args: { output } }], wrapHandle: handle => new Proxy(handle, {
    get(target, key) { if (key === 'waitForExit') return async () => false; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value },
  }) }), binding = identity()
  h.expectedCloseError = 'claude_execution_drain_timeout'
  await assert.rejects(h.run(binding), error => error.code === h.expectedCloseError && error.executionDrained === false)
  assert.equal(h.results.length, 0)
  assert.throws(() => h.manager.assertDrained(binding), error => error.executionDrained === false)
  await assert.rejects(h.run(binding), { code: 'claude_execution_already_running' })
  await assert.rejects(h.manager.recoverDrained({ binding }), error => error.executionDrained === false)
  await assert.rejects(h.manager.close(), error => error.code === h.expectedCloseError && error.executionDrained === false)
  const records = (await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.notEqual(records.at(-1).type, 'drained', '不能以CLI成功终态补造受管范围排空')
})

test('CLI structured background receipt is unknown instead of a successful completed operation', options, async t => {
  const h = await harness(t, { steps: [{ kind: 'native', name: 'Bash', args: { command: 'synthetic-foreground-command', run_in_background: false }, backgroundReceipt: true }] }), binding = identity()
  await assert.rejects(h.run(binding), { code: 'claude_execution_background_not_supported' })
  assert.equal(h.results.length, 0)
  assert.equal(h.effects.length, 2)
  assert.equal(h.effects[0].phase, 'started')
  assert.equal(h.effects[1].phase, 'settled'); assert.equal(h.effects[1].cancelled, true); assert.equal(h.effects[1].result.isError, true)
  h.manager.assertDrained(binding)
  const records = (await readFile(claudeExecutionLogPath(h.root, binding.executionId), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(records.some(item => item.type === 'tool.unknown'))
  assert.equal(records.some(item => item.type === 'tool.settled'), false, '后台启动回执不能记为工具已完成')
  assert.equal(records.at(-1).type, 'drained')
})
