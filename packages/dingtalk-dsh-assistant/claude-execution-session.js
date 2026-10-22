import { appendFile, lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { safeNotificationDetail } from './notification-delivery.js'
import { checkedTaskDirectory } from './session-workspaces.js'

const NATIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch']
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
const IDENTITY = ['taskId', 'executionId', 'sessionId', 'inputVersion', 'inputDigest', 'requirementRevision', 'controlRevision', 'leaseEpoch']
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const copy = value => structuredClone(value)
const failure = (code, message = code) => Object.assign(new Error(message), { code })
const same = (a, b, keys = IDENTITY) => keys.every(key => a?.[key] === b?.[key])
const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const string = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength })

export function claudeExecutionLogPath(workspaceDir, executionId) {
  if (!isAbsolute(workspaceDir) || !/^[a-zA-Z0-9_-]+$/.test(executionId)) throw failure('claude_execution_path_invalid')
  return join(workspaceDir, 'outputs', executionId, 'claude-events.jsonl')
}

function providerSession(binding) {
  const value = binding.sessionId?.replace(/^task-execution-/, '')
  if (binding.kind !== 'task-execution' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw failure('claude_execution_identity_invalid')
  return value
}

async function readRecords(path) {
  let text
  try { await checkedLog(path); text = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  if (text && !text.endsWith('\n')) throw failure('claude_execution_log_incomplete')
  try { return text.split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { throw failure('claude_execution_log_invalid') }
}

async function checkedLog(path, create = false) {
  await checkedTaskDirectory(dirname(path), create)
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw failure('claude_execution_log_path_invalid')
}

function assertHistory(records, binding) {
  let sequence = 0, priorStart
  for (const event of records) {
    if (event.provider !== 'claude-code' || !same(event.binding, binding, ['taskId', 'executionId', 'sessionId'])) throw failure('claude_execution_history_identity_mismatch')
    if (event.sequence !== ++sequence) throw failure('claude_execution_history_sequence_invalid')
    if (event.type === 'start') {
      if (!Number.isSafeInteger(event.binding.inputVersion) || !Number.isSafeInteger(event.binding.leaseEpoch)
        || event.binding.inputVersion < 1 || event.binding.leaseEpoch < 1 || event.binding.inputVersion > binding.inputVersion
        || event.binding.leaseEpoch > binding.leaseEpoch || priorStart && (event.binding.inputVersion < priorStart.inputVersion || event.binding.leaseEpoch <= priorStart.leaseEpoch)) throw failure('claude_execution_history_generation_invalid')
      const expected = event.binding.inputVersion === binding.inputVersion ? binding : binding.inputHistory?.find(value => value.inputVersion === event.binding.inputVersion)
      if (!expected || !same(event.binding, expected, ['inputVersion', 'inputDigest', 'requirementRevision', 'controlRevision'])) throw failure('claude_execution_history_input_mismatch')
      priorStart = event.binding
    } else if (!priorStart || !same(event.binding, priorStart)) throw failure('claude_execution_history_generation_invalid')
  }
  if (records.length && records.at(-1).type !== 'drained') throw Object.assign(failure('claude_execution_recovery_unresolved'), { executionDrained: false })
  const previous = records.findLast(event => event.type === 'start')
  if (previous && (previous.binding.inputVersion > binding.inputVersion || previous.binding.inputVersion === binding.inputVersion && previous.binding.inputDigest !== binding.inputDigest)) throw failure('claude_execution_history_input_mismatch')
}

// CLI 原生工具仍由 CLI 执行；permission MCP 是实际派发前的 Host 门禁。
export function createClaudeExecutionSessions({ ctx, isCurrent, getWorkspaceDir }) {
  const entries = new Map(), drainedBindings = new Map()
  let closed = false
  const current = async entry => !entry.cancelled && !closed && await isCurrent(entry.binding)
  const record = (entry, type, data = {}) => {
    const event = { sequence: ++entry.sequence, time: new Date().toISOString(), provider: 'claude-code', binding: entry.binding, type, data }
    const writing = entry.writing.then(async () => { await checkedLog(entry.path); await appendFile(entry.path, JSON.stringify(event) + '\n', 'utf8') })
    entry.writing = writing
    return writing.then(() => event)
  }
  const requireCurrent = async entry => { if (!await current(entry)) throw failure('claude_execution_binding_stale') }
  const allFeedback = async entry => await entry.options.readFeedback?.() ?? []
  const feedbackDigest = values => hash(values.map(({ consumedAt, sequence, cliInputAdmittedAt, modelStepEnteredAt, consumptionMeaning, ...item }) => item))
  const readFeedback = async entry => (await allFeedback(entry)).filter(item => !item.consumedAt)

  async function observedCall(entry, callId, name, args) {
    if (typeof callId !== 'string' || !callId) throw failure('claude_execution_tool_identity_missing')
    if (!entry.calls.has(callId)) await new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(failure('claude_execution_stopping')) }
      const timer = setTimeout(() => { cleanup(); reject(failure('claude_execution_tool_unobserved')) }, 10000)
      const done = () => { cleanup(); resolve() }
      const cleanup = () => { clearTimeout(timer); entry.controller.signal.removeEventListener('abort', abort); entry.callWaiters.get(callId)?.delete(done) }
      if (!entry.callWaiters.has(callId)) entry.callWaiters.set(callId, new Set())
      entry.callWaiters.get(callId).add(done)
      entry.controller.signal.addEventListener('abort', abort, { once: true })
      if (entry.controller.signal.aborted) abort()
    })
    const call = entry.calls.get(callId)
    if (call?.name !== name || hash(call.input) !== hash(args)) throw failure('claude_execution_tool_identity_mismatch')
    return call
  }

  async function requireFeedbackReview(entry, { callId, receipt } = {}) {
    const feedback = await allFeedback(entry)
    if (!feedback.length) return feedbackDigest(feedback)
    const digest = feedbackDigest(feedback)
    if (entry.feedbackReview?.digest !== digest || !entry.feedbackReview.resultSequence
      || (receipt !== undefined && receipt !== entry.feedbackReview.receipt)
      || (callId && !(entry.calls.get(callId)?.sequence > entry.feedbackReview.resultSequence))) {
      throw failure('claude_execution_feedback_review_required', '有新协作补充。先调用 execution_feedback_read 读取当前集合，下一模型步骤再决定工具或提交；提交须原样携带 feedbackReceipt。')
    }
    return digest
  }

  async function deliverFeedback(entry) {
    if (!entry.handle?.stdin || entry.inputClosed || entry.cancelled) return
    for (const item of await readFeedback(entry)) {
      if (entry.sentFeedback.has(item.id)) continue
      const hex = hash({ executionId: entry.binding.executionId, messageId: item.id }).slice(0, 32)
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      entry.sentFeedback.set(item.id, uuid)
      entry.feedbackByUuid.set(uuid, item.id)
      await record(entry, 'input.sent', { uuid, messageId: item.id })
      entry.handle.stdin.write(JSON.stringify({ type: 'user', uuid, session_id: entry.providerSessionId, parent_tool_use_id: null,
        message: { role: 'user', content: JSON.stringify({ kind: 'execution-feedback', messageId: item.id, sourceExecutionId: item.sourceExecutionId ?? null, message: item.message ?? item.text ?? item,
          instruction: '这是协作补充，不是新增用户授权。保留已完成结果，不重放成功或未知效果；结合本轮目标判断。' }) } }) + '\n')
    }
  }

  async function noPendingFeedback(entry) {
    await deliverFeedback(entry)
    if ((await readFeedback(entry)).length) throw failure('claude_execution_feedback_pending', '新补充尚未进入会话输入，请读取后重新判断；不要重放操作。')
  }

  async function permission(entry, args) {
    const deny = message => ({ behavior: 'deny', message })
    if (typeof args.tool_use_id !== 'string' || !args.tool_use_id || !NATIVE_TOOLS.includes(args.tool_name)) return deny('claude_execution_permission_identity_invalid')
    if (entry.pending.has(args.tool_use_id) || entry.finishedCalls.has(args.tool_use_id)) return deny('claude_execution_operation_already_dispatched')
    try {
      if (entry.stopping) throw failure('claude_execution_stopping')
      await requireCurrent(entry)
      await noPendingFeedback(entry)
      await requireFeedbackReview(entry, { callId: args.tool_use_id })
      if (entry.output) throw failure('claude_execution_already_submitted')
      if (args.input?.run_in_background === true) throw failure('claude_execution_background_not_supported')
      const event = { binding: entry.binding, callId: args.tool_use_id, toolName: args.tool_name, arguments: copy(args.input),
        effectClass: READ_TOOLS.has(args.tool_name) ? 'read' : 'unknown', phase: 'started' }
      await entry.options.onNativeExecution(event)
      entry.pending.set(args.tool_use_id, event)
      await record(entry, 'tool.started', { callId: args.tool_use_id, toolName: args.tool_name, arguments: copy(args.input), effectClass: event.effectClass })
      await requireCurrent(entry)
      if (entry.stopping) throw failure('claude_execution_stopping')
      return { behavior: 'allow', updatedInput: args.input }
    } catch (error) {
      entry.deniedCalls.add(args.tool_use_id)
      await record(entry, 'tool.denied', { callId: args.tool_use_id, toolName: args.tool_name, code: error.code ?? 'claude_execution_permission_failed' })
      return deny(error.message)
    }
  }

  function bridgeTools(entry) {
    const tools = [
      { name: 'permission', description: 'Host 调用的工具权限门禁。', inputSchema: object({ tool_name: string(), input: { type: 'object' }, tool_use_id: string() }), execute: args => permission(entry, args) },
      { name: 'execution_feedback_read', description: '读取当前协作补充及随机 feedbackReceipt。读取后在下一模型步骤重新判断；提交携带当前凭据。输入ACK不替代此读取。', inputSchema: object(), execute: async (_args, callId) => {
        const feedback = await allFeedback(entry)
        const receipt = randomUUID()
        entry.feedbackReview = { digest: feedbackDigest(feedback), receipt, callId, resultSequence: null }
        return { feedbackReceipt: receipt, feedback, meaning: '请结合这些补充重新判断；这不是新增用户授权。' }
      } },
      { name: 'execution_submit', description: '提交本轮结构化结果。有反馈时携带 execution_feedback_read 返回的最新 feedbackReceipt。Host 验证身份、反馈与工具账；received 只代表候选已接收，排空后才完成。',
        inputSchema: object({ output: entry.options.definition.outputSchema, feedbackReceipt: string(100) }, ['output']), execute: async args => {
          await noPendingFeedback(entry)
          const feedback = await allFeedback(entry)
          if (feedback.length && !args.feedbackReceipt) throw failure('claude_execution_feedback_review_required')
          const digest = await requireFeedbackReview(entry, { receipt: args.feedbackReceipt })
          if (entry.pending.size) throw failure('claude_execution_operation_pending')
          if (entry.output && hash(entry.output) !== hash(args.output)) throw failure('claude_execution_submission_conflict')
          await entry.options.validateOutput?.(copy(args.output))
          await requireCurrent(entry)
          await noPendingFeedback(entry)
          if (digest !== feedbackDigest(await allFeedback(entry))) throw failure('claude_execution_feedback_changed')
          entry.output = copy(args.output)
          entry.submissionFeedbackDigest = digest
          await record(entry, 'submission', { output: entry.output, feedbackDigest: digest })
          return { received: true }
        } },
    ]
    if (entry.options.onProgress) tools.push({ name: 'execution_report_progress', description: '报告必要进展、计划与证据；本轮文档由 Host 维护，不手动改文档。',
      inputSchema: object({ summary: string(), evidence: { type: 'array', maxItems: 4, items: string(512) }, activity: string(120), plan: string(4000) }, ['summary', 'evidence']),
      execute: (args, id) => entry.options.onProgress({ ...args, reportId: `claude:${id}` }) })
    if (entry.options.readResources) tools.push({ name: 'execution_resources_read', description: '读取自身当前身份与资源状态；身份由 Host 绑定。', inputSchema: object(), execute: () => entry.options.readResources() })
    if (entry.options.readTeam) tools.push({ name: 'execution_team_read', description: '按需读取同任务成员及本轮文档入口；优先读文档，不轮询。', inputSchema: object(), execute: () => entry.options.readTeam() })
    if (entry.options.sendMessage) tools.push({ name: 'execution_send_message', description: '向同任务成员发送必要、合并的协作信息。先查成员版本；稳定 key 去重，不广播、不扩权、终态不复活。',
      inputSchema: object({ executionId: string(), targetInputVersion: { type: 'integer', minimum: 1 }, key: string(200), message: string(10000) }), execute: args => entry.options.sendMessage(args) })
    return tools
  }

  async function startBridge(entry) {
    const token = randomUUID(), expected = Buffer.from(`Bearer ${token}`), tools = bridgeTools(entry), receipts = new Map()
    const server = createServer(async (request, response) => {
      const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      const actual = Buffer.from(String(request.headers.authorization ?? ''))
      if (request.method !== 'POST' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(403, { error: 'forbidden' })
      let body
      try {
        let bytes = 0; const parts = []
        for await (const part of request) { bytes += part.length; if (bytes > 2 * 1024 * 1024) throw failure('claude_execution_mcp_request_too_large'); parts.push(part) }
        body = JSON.parse(Buffer.concat(parts).toString('utf8'))
        if (body.jsonrpc !== '2.0') throw failure('claude_execution_mcp_protocol_invalid')
        if (body.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dsh-execution', version: '1' } } })
        if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') { response.writeHead(202); return response.end() }
        if (body.method === 'ping') return reply(200, { jsonrpc: '2.0', id: body.id, result: {} })
        if (body.method === 'tools/list') return reply(200, { jsonrpc: '2.0', id: body.id, result: { tools: tools.map(({ execute, ...tool }) => tool) } })
        if (body.method !== 'tools/call') throw failure('claude_execution_mcp_method_invalid')
        const key = String(body.id), digest = hash(body.params)
        if (receipts.has(key)) {
          const prior = receipts.get(key)
          if (prior.digest !== digest) throw failure('claude_execution_mcp_id_conflict')
          return reply(200, await prior.promise)
        }
        const promise = (async () => {
          try {
            const tool = tools.find(item => item.name === body.params?.name)
            if (!tool) throw failure('claude_execution_mcp_tool_invalid')
            const args = body.params.arguments ?? {}, problems = validateJsonSchemaValue(tool.inputSchema, args)
            if (problems.length) throw failure('claude_execution_tool_input_invalid', problems.join('; '))
            if (entry.stopping) throw failure('claude_execution_stopping')
            const callId = tool.name === 'permission' ? args.tool_use_id : body.params._meta?.['claudecode/toolUseId']
            await observedCall(entry, callId, tool.name === 'permission' ? args.tool_name : `mcp__dsh__${tool.name}`, tool.name === 'permission' ? args.input : args)
            await requireCurrent(entry)
            const result = await tool.execute(args, callId)
            await record(entry, 'bridge.result', { name: tool.name, requestId: key, result })
            return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }
          } catch (error) {
            await record(entry, 'bridge.error', { name: body.params?.name, code: error.code ?? 'claude_execution_bridge_failed' })
            return { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }
          }
        })()
        entry.bridgeCalls.add(promise)
        promise.finally(() => entry.bridgeCalls.delete(promise)).catch(() => {})
        receipts.set(key, { digest, promise })
        reply(200, await promise)
      } catch (error) { reply(400, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: error.code ?? 'invalid request' } }) }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    entry.server = server
    return { mcpServers: { dsh: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }
  }

  async function receive(entry, value) {
    if (value.session_id && value.session_id !== entry.providerSessionId) throw failure('claude_execution_provider_session_mismatch')
    const persisted = await record(entry, 'cli', value)
    if (value.type === 'system' && value.subtype === 'init') {
      if (value.permissionMode !== 'default' && value.permissionMode !== 'manual' || !value.mcp_servers?.some(server => server.name === 'dsh' && server.status === 'connected')) throw failure('claude_execution_startup_contract_invalid')
      if (value.tools?.some(name => !NATIVE_TOOLS.includes(name) && !name.startsWith('mcp__dsh__'))) throw failure('claude_execution_unexpected_tool')
      entry.initialized = true
      await entry.options.onSessionBound?.()
      await record(entry, 'session.bound', { providerSessionId: entry.providerSessionId })
    }
    if (value.type === 'user' && entry.feedbackByUuid.has(value.uuid) && !value.message?.content?.some?.(block => block.type === 'tool_result')) {
      const messageId = entry.feedbackByUuid.get(value.uuid)
      const event = await record(entry, 'input.ack', { uuid: value.uuid, messageId, cliSequence: persisted.sequence })
      await entry.options.onFeedbackConsumed?.({ messageId, sequence: event.sequence })
      entry.feedbackByUuid.delete(value.uuid)
    }
    if (value.type === 'user' && Array.isArray(value.message?.content)) for (const result of value.message.content.filter(item => item.type === 'tool_result')) {
      if (entry.feedbackReview?.callId === result.tool_use_id && !result.is_error) entry.feedbackReview.resultSequence = persisted.sequence
      const event = entry.pending.get(result.tool_use_id)
      if (event) {
        if (event.toolName === 'Bash' && value.tool_use_result?.backgroundTaskId) throw failure('claude_execution_background_not_supported')
        await entry.options.onNativeExecution({ ...event, phase: 'settled', cancelled: entry.cancelled,
          result: { isError: result.is_error === true, content: typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content } })
        await record(entry, 'tool.settled', { callId: result.tool_use_id, toolName: event.toolName, result })
        entry.pending.delete(result.tool_use_id); entry.finishedCalls.add(result.tool_use_id)
      }
      if (entry.output && result.tool_use_id && !result.is_error) {
        const call = entry.calls.get(result.tool_use_id)
        if (call?.name === 'mcp__dsh__execution_submit') entry.accepted = true
      }
    }
    if (value.type === 'assistant') for (const call of value.message?.content ?? []) if (call.type === 'tool_use') {
      entry.calls.set(call.id, { ...call, sequence: persisted.sequence })
      for (const resolve of entry.callWaiters.get(call.id) ?? []) resolve()
      entry.callWaiters.delete(call.id)
    }
    if (value.type === 'result') {
      entry.terminal = value
      await deliverFeedback(entry)
      if (!(await readFeedback(entry)).length) { entry.inputClosed = true; entry.handle.stdin.end() }
    }
  }

  async function run(options) {
    const { binding, definition } = options
    if (closed) throw failure('claude_execution_closed')
    if (!ctx.subprocess?.spawn || !ctx.subprocess?.resolveExecutable) throw failure('claude_execution_subprocess_unavailable')
    if (typeof options.onNativeExecution !== 'function') throw failure('claude_execution_operation_gate_required')
    if (entries.has(binding.executionId)) throw failure('claude_execution_already_running')
    assertSupportedJsonSchema(definition.outputSchema)
    const cwd = await getWorkspaceDir({ binding, input: options.input }), path = claudeExecutionLogPath(cwd, binding.executionId), sessionId = providerSession(binding)
    const history = await readRecords(path)
    assertHistory(history, binding)
    const resume = history.some(event => event.type === 'session.bound')
    if (binding.sessionBound && !resume) throw failure('claude_execution_bound_history_missing')
    if (history.findLast(event => event.type === 'start')?.binding.leaseEpoch === binding.leaseEpoch) throw failure('claude_execution_already_dispatched')
    await checkedLog(path, true)
    const entry = { binding: copy(binding), providerSessionId: sessionId, path, cwd, options, sequence: history.at(-1)?.sequence ?? 0, writing: Promise.resolve(),
      pending: new Map(), finishedCalls: new Set(), deniedCalls: new Set(), calls: new Map(), callWaiters: new Map(), controller: new AbortController(), bridgeCalls: new Set(), sentFeedback: new Map(), feedbackByUuid: new Map(), cancelled: false }
    entries.set(binding.executionId, entry); drainedBindings.delete(binding.executionId)
    let resolveDone
    entry.done = new Promise(resolve => { resolveDone = resolve })
    try {
      await requireCurrent(entry)
      await record(entry, 'start', { providerSessionId: sessionId, input: copy(options.input), resumed: resume })
      const config = await startBridge(entry)
      const settings = { disableAllHooks: true, permissions: { ask: NATIVE_TOOLS, allow: bridgeTools(entry).filter(tool => tool.name !== 'permission').map(tool => `mcp__dsh__${tool.name}`) }, sandbox: { autoAllowBashIfSandboxed: false } }
      const executable = await ctx.subprocess.resolveExecutable('claude')
      await requireCurrent(entry)
      const argv = [executable, '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages',
        '--permission-mode', 'default', '--tools', NATIVE_TOOLS.join(','), '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--permission-prompt-tool', 'mcp__dsh__permission',
        '--settings', JSON.stringify(settings), '--setting-sources', '', '--disable-slash-commands', '--append-system-prompt', definition.prompt +
          '\n这是受管执行。使用 execution_submit 提交结构化结果；进度与协作用 dsh MCP 工具。禁止后台任务、子代理和修改Host执行日志/执行文档；提交后不再执行工具。新反馈以独立输入准入，不代表新增授权。',
        ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])]
      entry.handle = await ctx.subprocess.spawn({ argv, cwd, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 3000 })
      await requireCurrent(entry)
      if (!entry.handle.stdin || !entry.handle.stdout || !entry.handle.stderr) throw failure('claude_execution_stream_unavailable')
      let streamFailure
      const consume = async () => {
        const lines = createInterface({ input: entry.handle.stdout, crlfDelay: Infinity })
        for await (const line of lines) {
          if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw failure('claude_execution_line_too_large')
          let value; try { value = JSON.parse(line) } catch { throw failure('claude_execution_stream_invalid') }
          await receive(entry, value)
        }
      }
      const consuming = consume().catch(error => { streamFailure = error; entry.handle.terminate() })
      const stderr = (async () => { for await (const chunk of entry.handle.stderr) await record(entry, 'stderr', { text: chunk.toString('utf8').slice(0, 8000) }) })()
      entry.handle.stdin.on('error', error => { streamFailure ??= error; entry.handle.terminate() })
      const initialUuid = randomUUID()
      await record(entry, 'input.sent', { uuid: initialUuid, initial: true })
      entry.handle.stdin.write(JSON.stringify({ type: 'user', uuid: initialUuid, session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: JSON.stringify({ input: options.input, ...(options.recoveryContext ? { recoveryContext: options.recoveryContext } : {}) }) } }) + '\n')
      await deliverFeedback(entry)
      const outcome = await entry.handle.done
      await consuming; await stderr
      if (streamFailure) throw streamFailure
      await record(entry, 'exit', outcome)
      if (entry.pending.size) throw failure('claude_execution_operation_unresolved')
      if (!entry.cancelled && (!entry.initialized || !entry.terminal)) throw failure('claude_execution_terminal_missing')
      if (entry.accepted && !(await readFeedback(entry)).length && entry.submissionFeedbackDigest === feedbackDigest(await allFeedback(entry))
        && entry.terminal?.is_error !== true && outcome.exitCode === 0 && await current(entry)) {
        entry.result = { status: 'submitted', output: copy(entry.output) }
      } else entry.result = { status: entry.cancelled ? 'cancelled' : !await current(entry) ? 'stale' : 'no_submission', reason: 'claude_execution_no_submission',
        ...(entry.terminal?.is_error ? { failure: { code: 'claude_execution_cli_error', message: String(entry.terminal.result ?? entry.terminal.subtype).slice(0, 2000) } } : {}) }
    } catch (error) { entry.error = error }
    finally {
      try {
        entry.stopping = true
        entry.controller.abort()
        entry.handle?.terminate()
        if (entry.server) { entry.server.closeAllConnections(); await new Promise(resolve => entry.server.close(resolve)) }
        await Promise.all([...entry.bridgeCalls])
        if (entry.handle && await entry.handle.waitForExit(AbortSignal.timeout(30000)) !== true) throw failure('claude_execution_drain_timeout')
        for (const [callId, event] of entry.pending) {
          await entry.options.onNativeExecution({ ...event, phase: 'settled', cancelled: true, result: { isError: true, content: [] } })
          await record(entry, 'tool.unknown', { callId, toolName: event.toolName, reason: 'managed-process-drained-without-tool-result' })
          entry.pending.delete(callId)
        }
        await entry.writing
        await record(entry, 'drained', { submitted: entry.result?.status === 'submitted', ...(entry.error ? { error: entry.error.code ?? 'claude_execution_failed' } : {}) })
        drainedBindings.set(binding.executionId, entry.binding); entries.delete(binding.executionId)
      } catch (error) { entry.drainError = Object.assign(error, { executionDrained: false }); entry.error = entry.drainError }
      resolveDone()
    }
    if (entry.error) throw entry.error
    if (entry.result.status === 'submitted') {
      // 结果提交与反馈到达竞争仍由最终回读裁决；CLI退出不是提交依据。
      await noPendingFeedback(entry)
      if (entry.submissionFeedbackDigest !== feedbackDigest(await allFeedback(entry))) throw failure('claude_execution_feedback_changed')
      if (!await current(entry)) return { status: 'stale' }
      await options.onResult?.(copy(entry.result.output), { feedbackVersion: (await allFeedback(entry)).length })
    }
    return entry.result
  }

  async function cancel(executionId) {
    const entry = entries.get(typeof executionId === 'string' ? executionId : executionId.executionId)
    if (!entry) return
    entry.cancelled = true; entry.controller.abort(); entry.handle?.terminate()
    await entry.done
    if (entry.drainError) throw entry.drainError
  }

  function assertDrained(binding) {
    const entry = entries.get(binding.executionId)
    if (entry) throw entry.drainError ?? Object.assign(failure('claude_execution_not_drained'), { executionDrained: false })
    if (!same(drainedBindings.get(binding.executionId), binding)) throw Object.assign(failure('claude_execution_drain_proof_missing'), { executionDrained: false })
  }

  async function recoverDrained({ binding, input = {} }) {
    if (entries.has(binding.executionId)) return assertDrained(binding)
    const cwd = await getWorkspaceDir({ binding, input }), records = await readRecords(claudeExecutionLogPath(cwd, binding.executionId))
    assertHistory(records, binding)
    if (!records.length && binding.sessionBound) throw Object.assign(failure('claude_execution_bound_history_missing'), { executionDrained: false })
    if (records.length && !same(records.at(-1).binding, binding)) throw Object.assign(failure('claude_execution_drain_identity_mismatch'), { executionDrained: false })
    drainedBindings.set(binding.executionId, copy(binding))
  }

  async function executionRecords(execution) {
    const binding = { ...execution, kind: 'task-execution' }, cwd = await getWorkspaceDir({ binding, input: execution.input ?? {} })
    await entries.get(execution.executionId)?.writing
    const records = await readRecords(claudeExecutionLogPath(cwd, execution.executionId))
    if (records.some(event => !same(event.binding, binding, ['taskId', 'executionId', 'sessionId']))) throw failure('claude_execution_history_identity_mismatch')
    return records
  }

  return {
    run, cancel, assertDrained, recoverDrained,
    async feedback(executionId) { const entry = entries.get(executionId); if (entry) await deliverFeedback(entry) },
    async readProgress({ execution }) {
      const records = await executionRecords(execution), currentRecords = records.filter(event => same(event.binding, execution))
      const calls = new Set(currentRecords.filter(event => event.type === 'tool.started').map(event => event.data.callId))
      for (const event of currentRecords.filter(event => ['tool.settled', 'tool.unknown'].includes(event.type))) calls.delete(event.data.callId)
      const previousSequence = execution.progressReview?.lastSequence ?? -1, lastSequence = currentRecords.at(-1)?.sequence ?? -1
      const newEvents = currentRecords.filter(event => event.sequence > previousSequence)
      return { kind: 'execution-progress', provider: 'claude-code', taskId: execution.taskId, sessionId: execution.sessionId, inputDigest: execution.inputDigest,
        executionId: execution.executionId, inputVersion: execution.inputVersion, leaseEpoch: execution.leaseEpoch,
        lastSequence, previousSequence, newEventCount: newEvents.length, changed: newEvents.length > 0, hasNewEvents: newEvents.length > 0,
        lastActivityAt: currentRecords.at(-1)?.time ?? null, pendingToolCallCount: calls.size,
        pendingToolCalls: currentRecords.filter(event => event.type === 'tool.started' && calls.has(event.data.callId)).slice(-8).map(event => ({ callId: event.data.callId, toolName: event.data.toolName, sequence: event.sequence, time: event.time, digest: hash(event.data) })), pendingToolCallsTruncated: calls.size > 8,
        excerpts: newEvents.slice(-8).map(event => { const raw = JSON.stringify(event.data), safe = JSON.stringify(safeNotificationDetail(event.data)); return { sequence: event.sequence, time: event.time, type: event.type, preview: safe.slice(0, 640), digest: hash(event.data), truncated: safe.length > 640 || raw.length > 640 } }),
        limitations: ['有新事件不证明业务推进；未结束调用不证明进程仍运行。', 'CLI 输入 ACK 只证明会话输入准入，不证明模型理解或业务完成。'] }
    },
    async readOperationContext({ operation }) {
      const binding = operation.dispatchBinding
      if (!binding) return null
      const records = await executionRecords(binding)
      const callId = operation.result?.callId ?? operation.key?.split(':').at(-1)
      if (operation.key !== `native:${binding.executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${callId}`) return null
      const started = records.find(event => event.type === 'tool.started' && event.data.callId === callId && same(event.binding, binding))
      if (!started || started.data.toolName !== operation.definition?.toolName || hash(started.data.arguments) !== operation.definition.argumentsDigest) return null
      const settled = records.find(event => event.type === 'tool.settled' && event.data.callId === callId && same(event.binding, binding))
      return { provider: 'claude-code', binding: started.binding, toolName: started.data.toolName, arguments: started.data.arguments, result: settled?.data.result ?? null,
        limitations: ['仅提供实际CLI调用材料；未知效果不得据此自动结清或重放。'] }
    },
    async close() { closed = true; await Promise.all([...entries.keys()].map(cancel)) },
  }
}
