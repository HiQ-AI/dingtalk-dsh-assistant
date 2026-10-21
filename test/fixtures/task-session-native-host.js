import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openResidentStore } from '../../packages/dingtalk-dsh-assistant/store.js'
import { openTaskSessionService } from '../../packages/dingtalk-dsh-assistant/task-session-service.js'

// Use one installed native composition, including its real preset and process providers.
// No manager, agent, persistence, filesystem, shell, or control-store implementation is mocked.
export const nativeShell = process.platform === 'win32' ? 'pwsh' : 'bash'
let profile, native, Context, Loader, LlmAdapter, profileError
try {
  profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')))
  native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  Context = profile('@deepseek-ai/cordis').Context
  Loader = profile('@deepseek-ai/cordis-plugin-loader').default
  LlmAdapter = native('@deepseek-ai/dsh-llm').LlmAdapter
  for (const name of ['agent-preset-registry', 'workspace', 'fs-local', 'tool-fs', 'tool-' + nativeShell, nativeShell + '-local', 'subprocess-local']) native.resolve('@deepseek-ai/dsh-' + name)
} catch (error) { profileError = error }
export const available = !profileError
export const reason = profileError ? 'Full native profile required: install the resident profile or set DSH_NATIVE_TEST_PROFILE to its package.json; ' + profileError.message.split('\n')[0] : undefined
const modulePath = name => pathToFileURL(native.resolve('@deepseek-ai/dsh-' + name)).href
const row = (name, config) => ({ name: modulePath(name), ...(config ? { config } : {}) })

export async function nativeTaskHost(root, decide, options = {}) {
  if (!available) throw new Error(reason)
  const ctx = new Context(), requests = [], auxiliaryRequests = [], sent = [], readbacks = [], toolResults = []
  const h = { ctx, requests, auxiliaryRequests, sent, readbacks, toolResults, root }
  let closing
  h.close = () => closing ??= (async () => { try { await h.service?.close() } finally { try { await h.residentStore?.close() } finally { await ctx.fiber.dispose() } } })()
  try {
  ctx.baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = createRequire(profile.resolve('@deepseek-ai/dsh-agent-preset-registry'))('@deepseek-ai/cordis-plugin-group').default
  await ctx.loader.root.update([
    row('agent'), row('session'), row('session-projection'),
    row('system-prompt', { includeRuntimeContext: false, includeHarnessIdentity: false }),
    row('llm'), row('tools'), row('user-approval', { policy: 'never' }),
    ...(options.promoteOnTimeout ? [row('jobs-local'), row('tool-jobs')] : []),
    row('subprocess-local'), row('sandbox-local'), row('sandbox-policy', { mode: 'workspace-write', workspaceRoot: root }), row(nativeShell + '-sandbox', { cwd: root }),
    row('permission-presets', { defaultPreset: 'workspace-write', presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } }),
    row('session-title', { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 }), row('session-persistence-jsonl', { root: join(root, 'legacy-sessions'), compression: 'none' }),
    row('storage'), row('storage-json', { root: join(root, 'storage') }), row('storage-domain', { backend: 'json' }),
    row('workspace'), row('agent-loop', { agents: [], maxParallelToolCalls: 4 }),
    ...(options.skillDirs ? [row('skill')] : []),
    row('agent-preset-registry', { default: 'native-test' }),
    ...(options.resident ? [row('credentials-local', { path: join(root, 'credentials.json'), watch: false }), row('attachment-local', { dshHome: join(root, 'attachment-home') }),
      row('agent-default-model', { provider: 'native-task-test', model: 'controlled' })] : []),
  ])
  await ctx.loader.await()
  assert.ok(ctx.agents && ctx.agentPresets && ctx.workspaceRegistry, 'Native composition failed to activate')
  await ctx.plugin({ inject: ['agentPresets'], async *apply(child) {
    yield await child.agentPresets.register({ id: 'native-test', plugins: [{ name: 'cordis:group', group: true,
      isolate: { fs: true, workingDirectory: true, shellEnv: true }, config: [
      row('fs-local', { cwd: root }), row('working-directory', { defaultDirectory: root }),
      row('shell-env'), row('tool-fs'), row('tool-' + nativeShell, { enableRunInBackground: options.promoteOnTimeout === true, promoteOnTimeout: options.promoteOnTimeout === true }),
      ...(options.fsObservationPolicy ? [row('fs-observation-policy')] : []),
      ...(options.skillDirs ? [row('skill-filesystem', { includeDefaultRoots: false, customSkillDirs: options.skillDirs, watch: false }), row('tool-skill')] : []),
    ] }] })
  } })
  assert.equal((await ctx.agentPresets.resolve()).broken, undefined)
  let sequence = 0
  class ScriptedModel extends LlmAdapter {
    resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: ['low'].map(id => ({ id, name: id })), defaultEffort: 'low' } } }
    async *stream(request) {
      // Topic summary maintenance is an independent model invocation, not an
      // owner/executor step. Keep its real requests separately so scripted
      // fault counters cannot consume a business step on this auxiliary call.
      let auxiliary = false
      try { auxiliary = latestInput(request).requestId?.startsWith('coord-summary-') === true } catch {}
      ;(auxiliary ? auxiliaryRequests : requests).push(structuredClone(request))
      const calls = contextReadCalls(request) ?? (auxiliary ? topicTaskCalls(request) : await decide(request, h))
      for (const [index, call] of calls.entries()) {
        const id = `native-call-${++sequence}`, args = JSON.stringify(call.args)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      }
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(options.modelProviders ?? ['native-task-test'], new ScriptedModel())
  ctx.on('tools/result', (exec, result) => toolResults.push({ name: exec.name, sessionId: exec.agent?.id, result: structuredClone(result) }))
  if (options.resident) return h
  h.residentStore = await openResidentStore(ctx.storageDomain)
  await h.residentStore.subscribe({ groupId: 'native-group', name: '真实服务测试群', responsibility: '处理明确交办给测试助手的工作' })
  await h.residentStore.setAgentNames(['测试助手'])
  const legacy = {
    getAgentConfig: () => ({ workspaceDir: root, provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', agentNames: ['测试助手'], ...options.agentConfig }),
    getGroup: groupId => h.residentStore.getGroup(groupId),
  }
  h.service = await (options.serviceFactory ?? openTaskSessionService)({ ctx, legacy, residentStore: h.residentStore, ...(options.store ? { store: options.store } : {}),
    config: { workspaceDir: root, dbPath: join(root, 'dynamic.db'), instanceId: 'native-test', initialize: options.initialize !== false, ownerActorId: 'native-user', webActorId: 'native-user', provider: 'native-task-test', ...options.config },
    notifications: options.notifications ?? {
      async send(notification) { sent.push(structuredClone(notification)); return { messageId: 'native-notification-' + sent.length } },
      async readback(notification) { readbacks.push(structuredClone(notification)); return { messageId: notification.ack.messageId, visible: true } },
    },
  })
  h.query = (kind, args = {}) => h.service.store.query({ kind, ...args })
  return h
  } catch (error) { await h.close(); throw error }
}

export function modelToolValues(request) {
  const definitions = Object.assign({}, ...request.messages.flatMap(message => (message.content ?? []).flatMap(part => {
    if (part.type !== 'text') return []
    try { return [JSON.parse(part.text).contentIndex ?? {}] } catch { return [] }
  })))
  const inline = value => value && typeof value === 'object' ? value.contentRef && Object.hasOwn(definitions, value.contentRef)
    ? definitions[value.contentRef] : Array.isArray(value) ? value.map(inline) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)])) : value
  return request.messages.filter(message => message.role === 'tool').flatMap(message => message.content ?? []).filter(part => part.type === 'text')
    .flatMap(part => { try { return [inline(JSON.parse(part.text))] } catch { return [] } })
}

export function latestInput(request) {
  // Scripted models understand the same inline dictionary as a real model.
  // Deferred catalogues remain references and must be read with the model tool.
  const definitions = Object.assign({}, ...request.messages.flatMap(message => (message.content ?? []).flatMap(part => {
    if (part.type !== 'text') return []
    try { return [JSON.parse(part.text).contentIndex ?? {}] } catch { return [] }
  })))
  const inline = value => value && typeof value === 'object' ? value.contentRef && Object.hasOwn(definitions, value.contentRef)
    ? definitions[value.contentRef] : Array.isArray(value) ? value.map(inline) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)])) : value
  for (const message of request.messages.toReversed()) {
    if (message.role !== 'user') continue
    for (const part of message.content ?? []) {
      if (part.type !== 'text') continue
      try { const parsed = JSON.parse(part.text); if (parsed.task || parsed.sources || parsed.contextReadRequired) return resolveContextInput(request, inline(parsed)) } catch (error) { if (error.contextReads) throw error }
      const topicLine = part.text.split('\n').find(line => line.startsWith('Topic 请求：'))
      if (topicLine) return JSON.parse(topicLine.slice('Topic 请求：'.length))
    }
  }
  throw new Error('No native coordinator input found')
}

// Scripted decisions must observe overflow through the same admitted tool as a
// real model. Only contextPath fields are expanded; ordinary contentRef bodies
// remain explicit references for the individual test's judgment.
function resolveContextInput(request, input) {
  const pages = modelToolValues(request), pending = new Map()
  const read = (contentRef, path = '') => {
    let offset = 0, text = '', entries = [], kind
    while (true) {
      // JSON indexes omit offset; the page range follows from entry count and
      // its nextOffset (or totalEntries for the final page).
      const page = pages.findLast(page => page.contentRef === contentRef && page.path === path && (page.format === 'json-index' ? (page.nextOffset ?? page.totalEntries) - page.entries.length : page.offset) === offset)
      if (!page) {
        const args = { contentRef, path, offset, limit: 16000 }
        pending.set(JSON.stringify(args), args)
        return undefined
      }
      if (page.format === 'json-index') { entries.push(...page.entries); kind = page.valueKind }
      else text += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    if (kind) {
      const value = kind === 'array' ? [] : {}
      for (const entry of entries) value[entry.key] = entry.valueRef ? read(entry.valueRef.contentRef) : entry.value
      return value
    }
    const page = pages.findLast(page => page.contentRef === contentRef && page.path === path)
    return page.format === 'text' ? text : JSON.parse(text)
  }
  const visit = value => value && typeof value === 'object'
    ? value.contextPath ? read(input.contextRef, value.contextPath)
      : Array.isArray(value) ? value.map(visit) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    : value
  const resolved = input.contextReadRequired && !input.task && !input.sources ? read(input.contextRef) : visit(input)
  if (pending.size) throw Object.assign(new Error('Native context requires explicit tool reads'), { contextReads: [...pending.values()].slice(0, 4) })
  return resolved
}

export function contextReadCalls(request) {
  try { latestInput(request); return undefined }
  catch (error) { if (error.contextReads) return error.contextReads.map(args => ({ name: 'model_content_read', args })); throw error }
}

let contextSequence = 0
export function* contextReadResponse(request) {
  const calls = contextReadCalls(request)
  if (!calls) return false
  for (const [index, call] of calls.entries()) {
    const id = 'context-read-' + ++contextSequence, args = JSON.stringify(call.args)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
  return true
}

export async function waitUntil(read, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out: ' + description)
}

// Custom fault-injection adapters must answer maintenance in its own session
// before advancing any owner/executor fault counter.
export function* topicSummaryResponse(request, audit) {
  let input
  try { input = latestInput(request) } catch { return false }
  if (!input.requestId?.startsWith('coord-summary-')) return false
  audit.push(structuredClone(request))
  const call = topicTaskCalls(request)[0], id = 'summary-' + input.requestId, args = JSON.stringify(call.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
  return true
}

// Script model decisions only; routing, validation and durable topic state remain real.
export function topicTaskCalls(request, { title = '原消息交办', objective } = {}) {
  const input = latestInput(request), names = request.tools.map(tool => tool.name)
  if (input.requestId?.startsWith('coord-summary-')) return [{ name: 'group_topic_summary_submit', args: {
    requestId: input.requestId, topicId: input.topicId, summary: title,
  } }]
  if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId, routes: input.messages.map(message => ({
    messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
    units: [{ unitKey: 'request', summary: title, sourceRefs: [{ quote: message.text }], topics: [{ newTopicKey: message.messageId, title }] }],
  })) } }]
  if (names.includes('group_decision_submit')) {
    const basisUnitRefs = input.messages.map(({ unitId, unitRevision }) => ({ unitId, unitRevision }))
    const text = objective ?? input.messages.map(message => message.text).join('\n')
    return [{ name: 'group_decision_submit', args: { requestId: input.requestId, topicId: input.topicId, revision: input.revision, decision: {
      basisMessageIds: [...new Set(input.messages.map(message => message.messageId))], basisUnitRefs,
      actions: [{ kind: 'new-task', title, objective: text, acceptanceCriteria: ['完成原消息要求并核验证据'], topicRefs: [{ topicId: input.topicId, revision: input.revision }], basisUnitRefs,
        dispatchAssessment: { businessObject: title, agentDeliverable: text, externalFollowup: [], sourceUnitRefs: basisUnitRefs, workflowRefs: [], workflowReason: '当前没有专用流程' } }], reply: '收到，已交办任务。', replyReview: { kind: 'confirmation', reviewedOutboundIds: [], sameMatterOutboundIds: [], replaceOutboundIds: [] },
    } } }]
  }
}
