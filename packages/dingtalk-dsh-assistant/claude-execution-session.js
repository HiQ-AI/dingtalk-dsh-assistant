import { appendFile, lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { stripVTControlCharacters } from 'node:util'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { safeNotificationDetail } from './notification-delivery.js'
import { checkedTaskDirectory } from './session-workspaces.js'

const NATIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
const TEAM_TOOLS = ['Agent', 'SendMessage', 'ListAgents', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']
const SESSION_MODE = 'interactive-team-v1'
// SubagentStart/Stop 还覆盖 CLI 内部辅助代理，且队友的 agent_type 是动态名称；不订阅未用于本合同的生命周期噪声。
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'TeammateIdle', 'Stop', 'SessionEnd', 'ConfigChange']
const IDENTITY = ['taskId', 'executionId', 'sessionId', 'claudeSessionMode', 'inputVersion', 'inputDigest', 'requirementRevision', 'controlRevision', 'leaseEpoch']
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

export function claudeExecutionMemberDirectory(workspaceDir, execution) {
  const path = claudeExecutionLogPath(workspaceDir, execution.executionId)
  if (!Number.isSafeInteger(execution.inputVersion) || execution.inputVersion < 1 || !Number.isSafeInteger(execution.leaseEpoch) || execution.leaseEpoch < 1) throw failure('claude_execution_identity_invalid')
  return join(dirname(path), `round-${execution.inputVersion}-lease-${execution.leaseEpoch}`)
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

// 交互式 CLI 工具由 CLI 执行；官方 HTTP hooks 是实际派发前的 Host 门禁。
export function createClaudeExecutionSessions({ ctx, isCurrent, getWorkspaceDir }) {
  const entries = new Map(), drainedBindings = new Map()
  let closed = false
  const current = async entry => !entry.cancelled && !closed && await isCurrent(entry.binding)
  const terminate = entry => {
    if (!entry.handle) return Promise.resolve()
    entry.termination ??= Promise.resolve().then(() => entry.handle.terminate())
    // 取消/超时可以只发起；排空错误由 run.finally 和 cancel 统一报告。
    entry.termination.catch(() => {})
    return entry.termination
  }
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
    if (!call.admitted) throw failure('claude_execution_tool_not_admitted')
    return call
  }

  async function requireFeedbackReview(entry, { callId, receipt } = {}) {
    const feedback = await allFeedback(entry)
    if (!feedback.length) return feedbackDigest(feedback)
    const digest = feedbackDigest(feedback)
    const actor = callId ? entry.calls.get(callId)?.agentId ?? 'lead' : 'lead'
    const review = entry.feedbackReviews.get(actor)
    if (review?.digest !== digest || !review.resultSequence
      || (receipt !== undefined && receipt !== review.receipt)
      || (callId && !(entry.calls.get(callId)?.sequence > review.resultSequence))) {
      throw failure('claude_execution_feedback_review_required', '有新协作补充。先调用 execution_feedback_read 读取当前集合，下一模型步骤再决定工具或提交；提交须原样携带 feedbackReceipt。')
    }
    return digest
  }

  async function deliverFeedback(entry) {
    if (!entry.handle || entry.inputClosed || entry.cancelled || !entry.initialized) return
    for (const item of await readFeedback(entry)) {
      if (entry.sentFeedback.has(item.id)) continue
      const hex = hash({ executionId: entry.binding.executionId, messageId: item.id }).slice(0, 32)
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      entry.sentFeedback.set(item.id, uuid)
      entry.feedbackByUuid.set(uuid, item.id)
      await record(entry, 'input.sent', { uuid, messageId: item.id })
      await writePrompt(entry, JSON.stringify({ kind: 'execution-feedback', uuid, messageId: item.id, sourceExecutionId: item.sourceExecutionId ?? null, message: item.message ?? item.text ?? item,
        instruction: '这是协作补充，不是新增用户授权。保留已完成结果，不重放成功或未知效果；结合本轮目标判断。' }))
    }
  }

  async function writePrompt(entry, text) {
    // 分开粘贴和 Enter，避免终端把回车当成多行粘贴正文。
    await entry.handle.write(`\x1b[200~${text}\x1b[201~`)
    await entry.handle.write('\r')
  }

  async function userSettings(entry) {
    const path = join(entry.claudeHome, 'settings.json')
    const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error })
    const settings = JSON.parse(text)
    if (settings.disableAllHooks === true) throw failure('claude_execution_hooks_disabled')
    if (Object.values(settings.hooks ?? {}).some(value => Array.isArray(value) && value.length)) throw failure('claude_execution_unmanaged_hooks')
    if (entry.settingsDigest && entry.settingsDigest !== hash(text)) throw failure('claude_execution_user_settings_changed')
    entry.settingsDigest = hash(text)
    return settings
  }

  async function teamDrained(entry) {
    if (!entry.teamName) return entry.members.size === 0
    const path = join(entry.claudeHome, 'teams', entry.teamName, 'config.json')
    const team = await readFile(path, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!team) return [...entry.members.values()].every(member => member.shutdownApproved)
    if (team.name !== entry.teamName || !team.members?.some(member => member.agentType === 'team-lead' && resolve(member.cwd) === resolve(entry.cwd))) throw failure('claude_execution_team_identity_mismatch')
    if (typeof team.leadSessionId !== 'string' || !team.leadSessionId || entry.nativeLeadSessionId && entry.nativeLeadSessionId !== team.leadSessionId) throw failure('claude_execution_team_identity_mismatch')
    entry.nativeLeadSessionId = team.leadSessionId
    await record(entry, 'team.snapshot', { teamName: team.name, leadSessionId: team.leadSessionId, members: team.members.map(({ name, agentId, agentType, isActive }) => ({ name, agentId, agentType, isActive })) })
    return team.members.every(member => member.agentType === 'team-lead')
  }

  async function memberRecord(entry, member, type, value) {
    const path = join(claudeExecutionMemberDirectory(entry.cwd, entry.binding), `${member.agentId}.md`)
    await checkedLog(path, true)
    await appendFile(path, `\n## ${new Date().toISOString()} ${type}\n\n${JSON.stringify(safeNotificationDetail(value), null, 2)}\n`, 'utf8')
  }

  async function hook(entry, event) {
    if (event.session_id !== entry.providerSessionId || resolve(event.cwd ?? '') !== resolve(entry.cwd)) throw failure('claude_execution_hook_identity_mismatch')
    await userSettings(entry)
    const kind = event.hook_event_name
    if (event.agent_id && !entry.members.has(event.agent_id) && entry.pendingSpawns.size) {
      // 原生队友可在 Agent PostToolUse HTTP 响应完成前启动；只等待已准入的 spawn，不能信任队友自报身份。
      await new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(failure('claude_execution_stopping')) }
        const timer = setTimeout(() => { cleanup(); reject(failure('claude_execution_member_unbound')) }, 10000)
        const cleanup = () => { clearTimeout(timer); entry.memberWaiters.get(event.agent_id)?.delete(done); entry.controller.signal.removeEventListener('abort', abort) }
        if (!entry.memberWaiters.has(event.agent_id)) entry.memberWaiters.set(event.agent_id, new Set())
        entry.memberWaiters.get(event.agent_id).add(done)
        entry.controller.signal.addEventListener('abort', abort, { once: true })
        if (entry.members.has(event.agent_id)) done()
        else if (entry.controller.signal.aborted) abort()
      })
    }
    const member = event.agent_id ? entry.members.get(event.agent_id) : null
    if (event.agent_id && !member) throw failure('claude_execution_member_unbound')
    const persisted = await record(entry, 'hook', event)
    if (member) await memberRecord(entry, member, kind, event)
    if (kind === 'ConfigChange') throw failure('claude_execution_config_change_forbidden')
    if (kind === 'UserPromptSubmit') {
      if (!entry.initialized) {
        entry.initialized = true
        await entry.options.onSessionBound?.()
        await record(entry, 'session.bound', { providerSessionId: entry.providerSessionId, sessionMode: SESSION_MODE })
        await deliverFeedback(entry)
      }
      let feedback; try { feedback = JSON.parse(event.prompt) } catch {}
      if (feedback?.kind === 'execution-feedback' && entry.feedbackByUuid.get(feedback.uuid) === feedback.messageId) {
        await entry.options.onFeedbackConsumed?.({ messageId: feedback.messageId, sequence: persisted.sequence })
        entry.feedbackByUuid.delete(feedback.uuid)
      }
      return {}
    }
    if (kind === 'PreToolUse') {
      const id = event.tool_use_id, name = event.tool_name, args = event.tool_input
      if (!id || !args || entry.calls.has(id)) throw failure('claude_execution_hook_call_invalid')
      entry.calls.set(id, { name, input: copy(args), sequence: persisted.sequence, agentId: event.agent_id ?? null })
      for (const done of entry.callWaiters.get(id) ?? []) done()
      entry.callWaiters.delete(id)
      const deny = reason => ({ hookSpecificOutput: { hookEventName: kind, permissionDecision: 'deny', permissionDecisionReason: reason } })
      try {
        await requireCurrent(entry)
        if (entry.stopping || entry.output) throw failure('claude_execution_stopping')
        if (NATIVE_TOOLS.includes(name)) {
          const decision = await permission(entry, { tool_use_id: id, tool_name: name, input: args })
          if (decision.behavior !== 'allow') return deny(decision.message)
        } else if (name === 'Agent') {
          if (member || args.subagent_type !== 'dsh-worker' || !/^[a-zA-Z0-9_-]+$/.test(args.name ?? '') || args.isolation || args.run_in_background || args.resume || args.mode && !['default', 'dontAsk'].includes(args.mode) || args.team_name && args.team_name !== entry.teamName) throw failure('claude_execution_team_spawn_invalid')
          entry.pendingSpawns.add(id)
        } else if (name === 'SendMessage') {
          const target = args.recipient ?? args.to
          if (!['main', 'team-lead', ...[...entry.members.values()].map(value => value.name)].includes(target)) throw failure('claude_execution_peer_message_forbidden')
          if (member && target === 'team-lead' && (!args.type || args.type === 'message')) throw failure('claude_execution_main_recipient_required', '向当前Lead发送普通汇报请使用SendMessage的to="main"；不要写team-lead命名收件箱。原生shutdown_response仍按关闭协议回复。')
        } else if (!TEAM_TOOLS.includes(name) && !bridgeTools(entry).some(tool => name === `mcp__dsh__${tool.name}` && tool.name !== 'permission')) throw failure('claude_execution_unexpected_tool')
        if (member && name === 'mcp__dsh__execution_submit') throw failure('claude_execution_lead_submit_required')
        entry.calls.get(id).admitted = true
        return { hookSpecificOutput: { hookEventName: kind, permissionDecision: 'allow' } }
      } catch (error) { await record(entry, 'tool.denied', { callId: id, toolName: name, code: error.code }); return deny(error.message) }
    }
    if (kind === 'PostToolUse' || kind === 'PostToolUseFailure') {
      const id = event.tool_use_id, call = await observedCall(entry, id, event.tool_name, event.tool_input)
      if (call.agentId !== (event.agent_id ?? null)) throw failure('claude_execution_tool_member_mismatch')
      const success = kind === 'PostToolUse' && event.tool_response?.isError !== true
      if (event.tool_name === 'Agent' && success) {
        const result = event.tool_response
        if (result?.status !== 'teammate_spawned' || result.is_splitpane || result.tmux_pane_id !== 'in-process' || !/^[\w-]+$/.test(result.team_name ?? '') || !/^[\w-]+$/.test(result.agent_id ?? '')) throw failure('claude_execution_native_team_required')
        if (result.name !== call.input.name || entry.members.has(result.agent_id) || [...entry.members.values()].some(value => value.name === result.name)) throw failure('claude_execution_member_identity_mismatch')
        if (entry.teamName && entry.teamName !== result.team_name) throw failure('claude_execution_team_identity_mismatch')
        entry.teamName = result.team_name
        const value = { agentId: result.agent_id, name: result.name, teamName: result.team_name, responsibility: call.input.prompt }
        entry.members.set(value.agentId, value)
        for (const done of entry.memberWaiters.get(value.agentId) ?? []) done()
        entry.memberWaiters.delete(value.agentId)
        entry.pendingSpawns.delete(id)
        // 在成员活动之前固化原生lead身份，后续不能接受同cwd的另一团队。
        await teamDrained(entry)
        await memberRecord(entry, value, '职责与原生身份', value)
      }
      if (member && event.tool_name === 'SendMessage' && event.tool_input.type === 'shutdown_response' && event.tool_input.approve === true && event.tool_response?.success === true) member.shutdownApproved = true
      if (event.tool_name === 'Agent') entry.pendingSpawns.delete(id)
      await settleToolResult(entry, id, !success, event.tool_response ?? { error: event.error })
      return {}
    }
    if (kind === 'Stop' && !member) {
      if (!entry.accepted || entry.pending.size || !await teamDrained(entry)) return { decision: 'block', reason: '先关闭全部原生队友并等待确认，再通过 execution_submit 提交结构化结果；普通文字不是提交。' }
      entry.terminal = { is_error: false }
      entry.exitTimer = setTimeout(() => {
        void entry.handle.write('\x04').then(() => {
          entry.exitTimer = setTimeout(() => { if (!entry.exited) void entry.handle.write('\x04').catch(error => { entry.error = error; void terminate(entry) }) }, 300)
        }).catch(error => { entry.error = error; void terminate(entry) })
      }, 250)
    }
    return {}
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
      { name: 'execution_feedback_read', description: '读取当前协作补充及随机 feedbackReceipt。读取后在下一模型步骤重新判断；提交携带当前凭据。输入ACK不替代此读取。', inputSchema: object(), execute: async (_args, callId) => {
        const feedback = await allFeedback(entry)
        const receipt = randomUUID()
        entry.feedbackReviews.set(entry.calls.get(callId)?.agentId ?? 'lead', { digest: feedbackDigest(feedback), receipt, callId, resultSequence: null })
        return { feedbackReceipt: receipt, feedback, meaning: '请结合这些补充重新判断；这不是新增用户授权。' }
      } },
      { name: 'execution_submit', description: '提交本轮结构化结果。有反馈时携带 execution_feedback_read 返回的最新 feedbackReceipt。Host 验证身份、反馈与工具账；received 只代表候选已接收，排空后才完成。',
        inputSchema: object({ output: entry.options.definition.outputSchema, feedbackReceipt: string(100) }, ['output']), execute: async args => {
          if (!await teamDrained(entry)) throw failure('claude_execution_teammates_active', '先向所有队友发送 shutdown_request 并等待关闭，再提交。')
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
        if (request.url === '/hooks') {
          const pendingHook = hook(entry, body)
          const hookSettled = pendingHook.catch(() => {})
          entry.bridgeCalls.add(hookSettled)
          try { return reply(200, await pendingHook) }
          catch (error) {
            entry.error ??= error
            await record(entry, 'hook.error', { event: body.hook_event_name, agentId: body.agent_id ?? null, agentType: body.agent_type ?? null, agentTranscriptPath: body.agent_transcript_path ?? null, code: error.code ?? 'claude_execution_hook_failed' })
            setImmediate(() => { void terminate(entry) })
            return reply(409, { error: error.code ?? 'hook_failed' })
          }
          finally { entry.bridgeCalls.delete(hookSettled) }
        }
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
            const callId = body.params._meta?.['claudecode/toolUseId']
            await observedCall(entry, callId, `mcp__dsh__${tool.name}`, args)
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
    entry.hookConfig = { type: 'http', url: `http://127.0.0.1:${server.address().port}/hooks`, headers: { Authorization: `Bearer ${token}` }, timeout: 30, onFailure: 'block' }
    return { mcpServers: { dsh: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }
  }

  async function settleToolResult(entry, callId, isError, response) {
    const result = { tool_use_id: callId, is_error: isError, content: JSON.stringify(response) }
    const persisted = await record(entry, 'hook.result', { callId, result })
    const review = [...entry.feedbackReviews.values()].find(value => value.callId === callId)
    if (review && !isError) review.resultSequence = persisted.sequence
    const event = entry.pending.get(callId)
    if (event) {
      if (['Bash', 'PowerShell'].includes(event.toolName) && response?.backgroundTaskId) throw failure('claude_execution_background_not_supported')
      await entry.options.onNativeExecution({ ...event, phase: 'settled', cancelled: entry.cancelled,
        result: { isError, content: [{ type: 'text', text: result.content }] } })
      await record(entry, 'tool.settled', { callId, toolName: event.toolName, result })
      entry.pending.delete(callId); entry.finishedCalls.add(callId)
    }
    if (entry.output && !isError && entry.calls.get(callId)?.name === 'mcp__dsh__execution_submit') entry.accepted = true
  }

  async function run(options) {
    const { binding, definition } = options
    if (closed) throw failure('claude_execution_closed')
    if (binding.claudeSessionMode !== SESSION_MODE) throw failure('claude_execution_legacy_session_mode', '旧非交互执行不能自动切换为交互式团队；保留原历史与未知效果，先完成原执行收尾。')
    if (!ctx.subprocess?.spawnTerminal || !ctx.subprocess?.spawn || !ctx.subprocess?.resolveExecutable) throw failure('claude_execution_subprocess_unavailable')
    if (typeof options.onNativeExecution !== 'function') throw failure('claude_execution_operation_gate_required')
    if (entries.has(binding.executionId)) throw failure('claude_execution_already_running')
    assertSupportedJsonSchema(definition.outputSchema)
    const cwd = await getWorkspaceDir({ binding, input: options.input }), path = claudeExecutionLogPath(cwd, binding.executionId), sessionId = providerSession(binding)
    const history = await readRecords(path)
    if (history.some(event => event.type === 'start' && (event.binding?.claudeSessionMode !== SESSION_MODE || event.data?.sessionMode !== SESSION_MODE))) throw failure('claude_execution_legacy_session_mode')
    assertHistory(history, binding)
    const resume = history.some(event => event.type === 'session.bound')
    if (binding.sessionBound && !resume) throw failure('claude_execution_bound_history_missing')
    if (history.findLast(event => event.type === 'start')?.binding.leaseEpoch === binding.leaseEpoch) throw failure('claude_execution_already_dispatched')
    await checkedLog(path, true)
    const entry = { binding: copy(binding), providerSessionId: sessionId, path, cwd, options, claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), members: new Map(), memberWaiters: new Map(), pendingSpawns: new Set(), feedbackReviews: new Map(), sequence: history.at(-1)?.sequence ?? 0, writing: Promise.resolve(),
      pending: new Map(), finishedCalls: new Set(), deniedCalls: new Set(), calls: new Map(), callWaiters: new Map(), controller: new AbortController(), bridgeCalls: new Set(), sentFeedback: new Map(), feedbackByUuid: new Map(), cancelled: false }
    entries.set(binding.executionId, entry); drainedBindings.delete(binding.executionId)
    let resolveDone
    entry.done = new Promise(resolve => { resolveDone = resolve })
    try {
      await requireCurrent(entry)
      await record(entry, 'start', { providerSessionId: sessionId, sessionMode: SESSION_MODE, input: copy(options.input), resumed: resume })
      const config = await startBridge(entry)
      const user = await userSettings(entry)
      const settings = { hooks: Object.fromEntries(HOOK_EVENTS.map(name => [name, [{ hooks: [entry.hookConfig] }]])),
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        teammateMode: 'in-process', statusLine: { type: 'command', command: '' },
        enabledPlugins: Object.fromEntries(Object.keys(user.enabledPlugins ?? {}).map(name => [name, false])),
        permissions: { deny: ['EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList'] }, sandbox: { autoAllowBashIfSandboxed: false } }
      const executable = await ctx.subprocess.resolveExecutable('claude')
      await requireCurrent(entry)
      const versionProcess = await ctx.subprocess.spawn({ argv: [executable, '--version'], cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000 })
      entry.preflight = versionProcess
      const versionTimer = setTimeout(() => versionProcess.terminate(), 10000)
      let versionText = ''
      const versionRead = (async () => { for await (const chunk of versionProcess.stdout) versionText += chunk.toString() })()
      const versionErrorRead = (async () => { for await (const _chunk of versionProcess.stderr) {} })()
      const versionOutcome = await versionProcess.done; await versionRead; await versionErrorRead
      clearTimeout(versionTimer)
      const version = /^(\d+)\.(\d+)\.(\d+)/.exec(versionText.trim())
      if (versionOutcome.exitCode !== 0 || !version || Number(version[1]) < 2 || Number(version[1]) === 2 && (Number(version[2]) < 1 || Number(version[2]) === 1 && Number(version[3]) < 309)) throw failure('claude_execution_version_unsupported', '交互式受管团队要求 Claude Code >= 2.1.309（HTTP hook fail-closed 与可刷新 system prompt）。')
      await record(entry, 'cli.version', { version: version[0] })
      await requireCurrent(entry)
      const agents = { 'dsh-worker': { description: 'DSH受管原生团队队友；按Lead本轮派发职责执行。', prompt: '完成Lead派发的本轮职责。普通汇报使用原生SendMessage(to="main", message="正文")送入当前Lead上下文；向其他队友使用其name。不要将普通汇报写到team-lead命名收件箱。不生成子代理，不向外部peer发消息。收到shutdown_request后按原生协议向team-lead回复shutdown_response、原样request_id、approve:true并退出。有新DSH反馈时自己调用execution_feedback_read后再决定工具；Lead代读不算本人复核。所有工具仍须通过Host门禁；不要修改Host日志和执行文档。', tools: [...NATIVE_TOOLS, ...TEAM_TOOLS.filter(name => name !== 'Agent'), 'mcp__dsh__execution_feedback_read'], model: 'inherit' } }
      const argv = [executable, '--permission-mode', 'dontAsk', '--tools', [...NATIVE_TOOLS, ...TEAM_TOOLS].join(','), '--agents', JSON.stringify(agents), '--strict-mcp-config', '--mcp-config', JSON.stringify(config),
        '--settings', JSON.stringify(settings), '--setting-sources', 'user', '--disable-slash-commands', '--system-prompt-snapshot', 'off', '--append-system-prompt', definition.prompt +
          '\n这是DSH受管交互执行，你是本执行的Claude Lead。按任务复杂度自主决定是否创建具名in-process原生队友，不强制数量；Agent的subagent_type必须是dsh-worker，并提供name和具体prompt，队友不再派生代理。给每位队友明确职责，并用原生SendMessage协作。队友向你普通汇报必须使用to="main"，队友之间使用name；不要让队友向team-lead命名收件箱发送普通汇报。禁止向外部peer会话发消息、后台命令、修改Host日志/文档/配置。全部成员工具均经过Host门禁。先关闭所有队友并等待批准，再用execution_submit提交结构化结果。提交后不再执行工具。新反馈不代表新增授权。',
        ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
        JSON.stringify({ input: options.input, ...(options.recoveryContext ? { recoveryContext: options.recoveryContext } : {}) })]
      entry.handle = await ctx.subprocess.spawnTerminal({ argv, cwd, env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, rows: 40, cols: 140, terminalType: 'xterm-256color', graceMs: 3000 })
      void entry.handle.done.then(() => { entry.exited = true }, () => { entry.exited = true })
      await requireCurrent(entry)
      if (!entry.handle.output || !entry.handle.write) throw failure('claude_execution_terminal_unavailable')
      let streamFailure
      const consume = async () => {
        let screen = ''
        for await (const chunk of entry.handle.output) {
          screen = (screen + stripVTControlCharacters(chunk.toString('utf8'))).slice(-16000)
          // 仅接受本执行工作目录的信任提示，不把UI文字当完成或工具结果。
          if (!entry.trusted && screen.toLowerCase().includes(cwd.toLowerCase()) && /[❯>]\s*(?:1[.)]\s*)?Yes, I trust this folder/i.test(screen)) {
            entry.trusted = true; await record(entry, 'workspace.trusted', { cwd }); await entry.handle.write('\r')
          }
        }
      }
      const consuming = consume().catch(error => { streamFailure = error; void terminate(entry) })
      entry.startTimer = setTimeout(() => { if (!entry.initialized) { streamFailure = failure('claude_execution_startup_timeout'); void terminate(entry) } }, 60000)
      await deliverFeedback(entry)
      const outcome = await entry.handle.done
      await consuming
      if (entry.error) throw entry.error
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
        clearTimeout(entry.startTimer); clearTimeout(entry.exitTimer)
        entry.controller.abort()
        entry.preflight?.terminate()
        let terminationFailure
        if (entry.handle) {
          let timer
          try { await Promise.race([terminate(entry), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure('claude_execution_drain_timeout')), 30000) })]) }
          catch (error) { terminationFailure = error }
          finally { clearTimeout(timer) }
        }
        if (entry.server) { entry.server.closeAllConnections(); await new Promise(resolve => entry.server.close(resolve)) }
        await Promise.all([...entry.bridgeCalls])
        if (terminationFailure) throw terminationFailure
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
    entry.cancelled = true; entry.controller.abort(); entry.preflight?.terminate(); void terminate(entry)
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
        memberDocuments: currentRecords.filter(event => event.type === 'hook' && event.data.hook_event_name === 'PostToolUse' && event.data.tool_name === 'Agent' && event.data.tool_response?.status === 'teammate_spawned')
          .map(event => ({ agentId: event.data.tool_response.agent_id, name: event.data.tool_response.name, teamName: event.data.tool_response.team_name,
            relativePath: `outputs/${execution.executionId}/round-${execution.inputVersion}-lease-${execution.leaseEpoch}/${event.data.tool_response.agent_id}.md` })),
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
