import { requestSystemText, findSessionLog, sessionPersistenceFixture } from './fixtures/session-persistence.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { sessionWorkspace, taskDirectories, taskFilePath } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import assert from 'node:assert/strict'
import testRunner, { after } from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createExecutionSessions, inspectLegacyTurnFailure } from '../packages/dingtalk-dsh-assistant/execution-session.js'
import { createAgentQueryTools, verifyAgentEvidence, readExecutedAgentQueryRefs } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { createAgentResourceReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-resources.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { validateAgentWorkResult, agentWorkResultSchema, createInvestigationWorkflow } from '../packages/dingtalk-dsh-assistant/agent-work.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')

// Process fixtures run only the requested phase, without registering the parent suites.
const test = process.argv[2] === '--execution-session-child' ? () => {} : testRunner
const self = fileURLToPath(import.meta.url)
const artifacts = resolve(tmpdir())
const temporaryRoots = new Set()
if (process.argv[2] !== '--execution-session-child') after(async () => {
  for (const root of temporaryRoots) {
    assert.equal(dirname(root), artifacts)
    assert.ok(root.startsWith(join(artifacts, 'dx-')))
    await rm(root, { recursive: true, force: true })
  }
})
const binding = (extra = {}) => ({ taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, leaseEpoch: 1, inputDigest: 'input-R1', sessionId: 'session-node-r1', sessionBound: false, ...extra })
const definition = (extra = {}) => ({ provider: 'execution-fixture', model: 'scripted', prompt: 'R1_OLD_MARKER_30ba', allowedTools: ['read_fixture'], outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...extra })
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const submit = answer => ({ name: 'execution_node_submit', args: { output: { answer } } })
const leases = events => [...new Set(events.flatMap(event => event.type === 'plugin:dingtalk/execution-session' ? [event.data.creationLease]
  : event.type === 'user/message' && event.data.source.executionSession ? [event.data.source.executionSession.leaseEpoch] : []))]
async function temp() {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(artifacts, 'dx-'))
  temporaryRoots.add(root)
  return root
}

// 只有 LlmAdapter 为脚本；每次 Host 都用真实原生 Loop、Tools、文件 JSONL 后端。
async function host({ root, script = [submit('done')], isCurrent = async () => true, repositoryInspect, tools, getWorkspaceDir } = {}) {
  root ??= await temp()
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const requests = [], reads = [], effects = [], handles = []
  await writeFile(join(root, 'fixture.txt'), 'NATIVE_READ_VALUE_922d')
  ctx.on('agent/created', ({ agent }) => { handles.push(agent) })
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { ...await super.resolveModel(provider, model), reasoning: { efforts: [{ id: 'low', name: 'Low' }] } } }
    async *stream(options) {
      requests.push(JSON.parse(JSON.stringify(options)))
      const next = typeof script === 'function' ? script(requests.length) : script[requests.length - 1]
      if (!next) throw new Error('unexpected model continuation')
      if (next.providerFailure) { yield { type: 'finish', reason: { kind: 'error', failure: next.providerFailure } }; return }
      if (Array.isArray(next)) {
        for(const [index,call] of next.entries()) {
          const id=`call-${requests.length}-${index}`,args=JSON.stringify(call.args??{})
          yield {type:'block-start',index,blockType:'tool-call'}
          yield {type:'tool-call-delta',index,id,name:call.name,argumentsDelta:args}
          yield {type:'block-end',index,block:{type:'tool-call',id,name:call.name,arguments:args}}
        }
        yield {type:'finish',reason:{kind:'tool-calls'}}
      } else if (next.name) {
        const id = 'call-' + requests.length, args = JSON.stringify(next.args ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: next.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['execution-fixture'], new Scripted())
  ctx.tools.register({ name: 'read_fixture', description: '读取测试文件', parameters: { type: 'object' }, output,
    async execute(_args, exec) { const text = await readFile(join(root, 'fixture.txt'), { encoding: 'utf8', signal: exec.signal }); reads.push(exec.agent.session.id); return { text } },
  })
  ctx.tools.register({ name: 'unsafe_write', description: '用于拒绝测试的副作用', parameters: { type: 'object' }, output, execute() { effects.push('root-write'); return {} } })
  const manager = createExecutionSessions({ ctx, isCurrent, repositoryInspect, tools, getWorkspaceDir, contentRoot: join(root, 'model-content') })
  return { ctx, root, manager, requests, reads, effects, handles, async close() { await manager.close(); await ctx.fiber.dispose() } }
}


const dynamic = (extra = {}) => ({ kind: 'task-execution', taskId: 'dynamic-task', executionId: 'execution-one', requirementRevision: 1, controlRevision: 1,
  inputVersion: 1, inputHistory: [], inputDigest: 'dynamic-input-v1', sessionId: 'dynamic-session-one', leaseEpoch: 1, sessionBound: false, ...extra })
const dynamicSubmit = answer => ({ name: 'execution_submit', args: { output: { answer } } })
const dynamicDrive = (h, extra = {}) => h.manager.run({ binding: dynamic(), input: { objective: 'Dynamic delegated goal' },
  definition: definition(), onSessionBound: async () => {}, onResult: async () => {}, ...extra })

test('32 continued inputs retire recursive Host snapshots on actual SDK requests and replay', async t => {
  const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
  const root = await temp(), history = [], metrics = []
  let allInputs = 0
  for (let version = 1; version <= 32; version++) {
    const h = await host({ root, script: [dynamicSubmit('preserved-result-' + version)] })
    try {
      const input = { task: { authorizationSourceId: 'authority' }, objective: 'current-goal-' + version, sources: [{ sourceId: 'authority', body: 'AUTHORIZATION: analysis only' }],
        previousExecutions: version < 4 ? [{ input: { previousExecutions: [{ input: { context: ('OLD_RECURSIVE_V' + version).repeat(3000) } }] } }] : [],
        originalOperation: { state: 'unknown', evidenceRef: 'UNKNOWN_EFFECT_EVIDENCE', instruction: 'Never replay' } }
      allInputs += Buffer.byteLength(JSON.stringify(input))
      const b = dynamic({ leaseEpoch: version, inputVersion: version, inputDigest: 'dynamic-input-v' + version, inputHistory: structuredClone(history), sessionBound: version > 1 })
      assert.equal((await dynamicDrive(h, { binding: b, input })).status, 'submitted')
      const request = h.requests[0], hostMessages = request.messages.filter(m => m.source?.executionSession)
      assert.equal(hostMessages.length, 1, 'only the current complete Host snapshot reaches the adapter')
      assert.match(JSON.stringify(request.messages), /AUTHORIZATION: analysis only/)
      assert.match(JSON.stringify(request.messages), /UNKNOWN_EFFECT_EVIDENCE/)
      if (version >= 4) assert.doesNotMatch(JSON.stringify(request.messages), /OLD_RECURSIVE_V/)
      if (version > 1) assert.match(JSON.stringify(request.messages), /preserved-result-1/)
      const stored = await inspectSession(h.ctx.sessionPersistence, b.sessionId)
      const raw = stored.events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).find(message => message.id === hostMessages[0].source.rawHostMessageId)
      assert.ok(raw, 'model message links to the original unmodified Host inbox audit')
      assert.deepEqual(JSON.parse(raw.content[0].text), input)
      assert.notEqual(raw.id, hostMessages[0].id)
      const folded = foldSurface(stored.events)
      const messages = folded.nodes.map(seq => deriveEventMessage(stored.events[seq], folded.projectedMessages)).filter(Boolean)
      assert.equal(messages.filter(m => m.source?.executionSession).length, 1)
      assert.equal(stored.events.filter(e => e.type === 'user/message' && e.data.source?.executionSession).length, version, 'original inputs remain auditable')
      metrics.push({ version, rawInputBytes: Buffer.byteLength(JSON.stringify(input)), currentInputBytes: Buffer.byteLength(hostMessages[0].content[0].text), hostBytes: Buffer.byteLength(JSON.stringify(hostMessages)), messagesBytes: Buffer.byteLength(JSON.stringify(request.messages)), adapterRequestBytes: Buffer.byteLength(JSON.stringify(request)) })
      history.push({ inputVersion: version, inputDigest: b.inputDigest, requirementRevision: 1, controlRevision: 1 })
    } finally { await h.close() }
  }
  t.diagnostic(JSON.stringify({ scope: 'scripted adapter request, UTF-8 JSON bytes; no provider tokens', rawAuditInputTextBytes: allInputs, metrics: metrics.filter(item => item.version <= 5 || item.version === 32) }))
  assert.ok(metrics.slice(3).every(item => item.hostBytes < 2500), 'Host budget includes absolute context paths; use a short physical TEMP/TMP root')
  assert.ok(metrics.at(-1).messagesBytes - metrics[4].messagesBytes < 27 * 550, 'only preserved result history grows, within a per-turn budget')
})

test('upgrade shadows every already stored recursive v1/v2/v3 input without rewriting originals', async t => {
  const { createSystemMessage } = await import('@deepseek-ai/dsh-llm')
  const h = await host({ script: [dynamicSubmit('upgraded')] }); t.after(() => h.close())
  const b = dynamic(), identity = Object.fromEntries(['kind', 'taskId', 'executionId', 'requirementRevision', 'controlRevision', 'inputVersion', 'inputDigest', 'sessionId'].map(key => [key, b[key]]))
  const session = h.ctx.sessions.prepare(b.sessionId, { seed: [{ type: 'plugin:dingtalk/execution-session', seq: 0, time: Date.now(), ignorable: true, data: { version: 2, identity, creationLease: 1 } }] })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('original system') }, { surfaceOp: 'append' })
  const inputHistory = []
  for (let version = 1; version <= 3; version++) {
    const prior = { inputVersion: version, inputDigest: 'dynamic-input-v' + version, requirementRevision: 1, controlRevision: 1 }
    session.append('user/message', createUserMessage({ source: { kind: 'coordinator', executionSession: { sessionId: b.sessionId, leaseEpoch: version, ...prior } },
      content: [{ type: 'text', text: JSON.stringify({ objective: 'old', previousExecutions: [{ input: { previousExecutions: [{ marker: 'LEGACY_RECURSION'.repeat(4000) }] } }] }) }] }), { surfaceOp: 'append' })
    inputHistory.push(prior)
  }
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'INDEPENDENT_AUTHORIZATION_BOUNDARY: no production changes' }] }), { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const writer = await h.ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents()); await writer.close()
  const originals = (await inspectSession(h.ctx.sessionPersistence, b.sessionId)).events
  const result = await dynamicDrive(h, { binding: dynamic({ inputVersion: 4, inputDigest: 'dynamic-input-v4', inputHistory, leaseEpoch: 4, sessionBound: true }),
    input: { objective: 'current', sources: [{ text: 'only analysis' }], originalOperation: { state: 'unknown', evidenceRef: 'uncertain-effect' } } })
  assert.equal(result.status, 'submitted')
  assert.doesNotMatch(JSON.stringify(h.requests[0]), /LEGACY_RECURSION/)
  assert.match(JSON.stringify(h.requests[0]), /INDEPENDENT_AUTHORIZATION_BOUNDARY/)
  assert.equal(h.requests[0].messages.filter(m => m.source?.executionSession).length, 1)
  const saved = await inspectSession(h.ctx.sessionPersistence, b.sessionId)
  assert.deepEqual(saved.events.slice(0, originals.length), originals)
  assert.equal(saved.events.filter(e => e.type === 'developer/message' && e.data.message.source.kind === 'dingtalk-host-context').length, 3)
  t.diagnostic(JSON.stringify({ scope: 'execution Host messages, UTF-8 JSON bytes', beforeBytes: Buffer.byteLength(JSON.stringify(originals.filter(e => e.type === 'user/message' && e.data.source?.executionSession).map(e => e.data))),
    afterBytes: Buffer.byteLength(JSON.stringify(h.requests[0].messages.filter(m => m.source?.executionSession))) }))
})

test('dynamic execution uses independent identities, task-parallel sessions and a generic submit tool', async t => {
  const h = await host({ script: [dynamicSubmit('one'), dynamicSubmit('two')] })
  t.after(() => h.close())
  const results = await Promise.all([dynamicDrive(h), dynamicDrive(h, { binding: dynamic({ executionId: 'execution-two', sessionId: 'dynamic-session-two' }) })])
  assert.deepEqual(results.map(item => item.status), ['submitted','submitted'])
  const event = (await inspectSession(h.ctx.sessionPersistence, dynamic().sessionId)).events.find(item => item.type === 'plugin:dingtalk/execution-session')
  assert.equal(event.data.identity.executionId, 'execution-one')
  assert.equal(event.data.identity.kind, 'task-execution')
  assert.equal(Object.hasOwn(event.data.identity, 'runId'), false)
  assert.match(requestSystemText(h.requests[0]), /动态委派/)
  assert.equal(h.requests[0].tools.some(tool => tool.name === 'execution_node_submit'), false)
  await assert.rejects(dynamicDrive(h, { binding: dynamic({ runId: 'forged' }) }), { code: 'execution_binding_invalid' })
})

test('durable native submit is recollected without another model turn after result callback crash', async t => {
  const root = await temp(), first = await host({ root, script: [dynamicSubmit('persisted')] })
  await assert.rejects(dynamicDrive(first, { onResult: async () => { throw new Error('crash before durable ledger ack') } }), /crash before durable ledger ack/)
  const oldEvents = (await inspectSession(first.ctx.sessionPersistence, dynamic().sessionId)).events
  await first.close()
  const next = await host({ root, script: () => { throw new Error('must not replay tools or model') } })
  t.after(() => next.close())
  const recorded = []
  const result = await dynamicDrive(next, { binding: dynamic({ leaseEpoch: 2, sessionBound: true }), onResult: output => recorded.push(output) })
  assert.equal(result.recovered, true)
  assert.equal(next.requests.length, 0)
  assert.deepEqual(recorded, [{ answer: 'persisted' }])
  assert.deepEqual((await inspectSession(next.ctx.sessionPersistence, dynamic().sessionId)).events, oldEvents)
})

test('continuation preserves native history while new input and requirement revisions remain authenticated', async t => {
  const root = await temp(), first = await host({ root, script: [dynamicSubmit('first')] })
  await dynamicDrive(first)
  const oldEvents = (await inspectSession(first.ctx.sessionPersistence, dynamic().sessionId)).events
  await first.close()
  const next = await host({ root, script: [dynamicSubmit('second')] })
  t.after(() => next.close())
  const binding = dynamic({ leaseEpoch: 2, sessionBound: true, inputVersion: 2, inputDigest: 'dynamic-input-v2', requirementRevision: 2,
    inputHistory: [{ inputVersion: 1, inputDigest: 'dynamic-input-v1', requirementRevision: 1, controlRevision: 1 }] })
  const result = await dynamicDrive(next, { binding, input: { objective: 'New goal' } })
  assert.equal(result.output.answer, 'second')
  assert.match(JSON.stringify(next.requests[0]), /first/)
  const events = (await inspectSession(next.ctx.sessionPersistence, dynamic().sessionId)).events
  assert.deepEqual(events.slice(0, oldEvents.length), oldEvents)
  const third = { ...binding, leaseEpoch: 3, inputHistory: [{ ...binding.inputHistory[0], requirementRevision: 999 }] }
  await assert.rejects(dynamicDrive(next, { binding: third }), { code: 'execution_session_identity_mismatch' })
})

async function nativePreset(h, options = {}) {
  const { createScope, bindScopeParent, scopeOf } = await import('@deepseek-ai/dsh-scope')
  const { z } = await import('zod')
  const standing = createScope(h.ctx, { preset: 'dynamic-native-fixture' })
  standing.ctx.systemPrompt.section({ name: 'fixture:workspace-rules', order: 10, text: 'DYNAMIC_PRESET_WORKSPACE_RULES: preserve authorized constraints.' })
  h.ctx.sessionProjections.register({ key: 'agentPreset', stateSchema: z.union([z.string(), z.null()]), stateVersion: 1,
    init: header => header.agentPreset ?? null, apply: (state, event) => event.type === 'agent-preset/selected' ? event.data.agentPreset : state })
  const mounted = []
  // This narrow preset fixture supplies the permission boundary; full native
  // permission enforcement is exercised by task-session-service-native.
  h.ctx.provide('permissionPresets', { set(session, preset) { assert.equal(preset, 'danger-full-access'); session.append('permission/preset', { preset }) } })
  h.ctx.provide('agentPresets', { serviceFor: (_agent, name) => name === 'subprocess' ? h.ctx.subprocess : undefined,
    async mount(agentCtx, id) { mounted.push(id); bindScopeParent(scopeOf(agentCtx), scopeOf(standing.ctx)); return { id: 'dynamic-native-fixture' } } })
  let delegated = 0
  standing.ctx.tools.register({ name: 'subagent', description: 'Configured native delegation fixture', parameters: { type: 'object' }, output,
    execute() { delegated++; return { started: true } } })
  standing.ctx.tools.register({ name: 'pwsh', description: 'Preset-only native shell fixture', parameters: { type: 'object', properties: {
    run_in_background: { type: 'boolean' }, valid: { type: 'boolean' } }, additionalProperties: false }, output,
    execute: options.execute ?? (() => ({ done: true })) })
  assert.equal(h.ctx.tools.get('pwsh'), undefined)
  return { standing, mounted, delegated: () => delegated }
}

test('原生网页及job只读身份不覆盖显式写效果，同名替换不继承只读身份', async t => {
 for (const name of ['web_fetch','job_output','job_list']) for (const mode of ['write', 'replace']) {
  const h=await host({script:[...(mode==='replace'?[{name:'replace_web',args:{}}]:[]),{name,args:{}},dynamicSubmit('done')]})
  const preset=await nativePreset(h), events=[]
  t.after(async()=>{await h.close();await preset.standing.dispose()})
  const tool={name,description:'Native read identity fixture',parameters:{type:'object'},output,execute:()=>({done:true})}
  const dispose=preset.standing.ctx.tools.register({...tool,...(mode==='write'?{effectClass:'write'}:{})})
  if(mode==='replace')preset.standing.ctx.tools.register({name:'replace_web',description:'Replace fixture definition',parameters:{type:'object'},output,
   execute(){dispose();preset.standing.ctx.tools.register({...tool});return {done:true}}})
  await dynamicDrive(h,{definition:definition({nativeTools:true,allowedTools:[]}),onNativeExecution:async event=>{events.push(event);return {}}})
  const call=events.find(event=>event.phase==='started'&&event.toolName===name)
  assert.ok(call);assert.notEqual(call.effectClass,'read');assert.notEqual(call.effectClass,'pure')
 }
})

test('native preset-only tools and workspace instructions are retained; managed subprocesses drain before result settlement', async t => {
  const h = await host({ script: [{ name: 'pwsh', args: {} }, dynamicSubmit('done')] })
  const { SubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess')
  const trace = []
  class FixtureProcess extends SubprocessRuntime {
    spawn() { trace.push('spawn'); return { done: Promise.resolve({ exitCode: 0 }), terminate: async () => trace.push('terminate'), waitForExit: async () => { await delay(10); trace.push('range-drained') } } }
    async spawnTerminal() { return { terminate: async () => trace.push('terminal-drained') } }
  }
  new FixtureProcess(h.ctx)
  const preset = await nativePreset(h, { execute: async () => { const process = h.ctx.subprocess.spawn({}); await process.done; trace.push('direct-exited'); return { done: true } } })
  t.after(async () => { await h.close(); await preset.standing.dispose() })
  const result = await dynamicDrive(h, { definition: definition({ nativeTools: true, allowedTools: [] }), onNativeExecution: async event => { trace.push(event.phase); return {} },
    onResult: () => trace.push('ledger-result') })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(trace, ['started','spawn','direct-exited','terminate','range-drained','settled','ledger-result'])
  assert.match(requestSystemText(h.requests[0]), /DYNAMIC_PRESET_WORKSPACE_RULES/)
  assert.equal(h.requests[0].tools.some(tool => tool.name === 'pwsh'), true)
  assert.equal(h.requests[0].tools.some(tool => tool.name === 'subagent'), true)
  assert.equal(preset.delegated(), 0)
})

test('dynamic native sessions use configured shell and delegation without a session tool whitelist', async t => {
  const h = await host({ script: [{ name: 'subagent', args: {} }, { name: 'pwsh', args: {} }, dynamicSubmit('done')] })
  const preset = await nativePreset(h)
  const receipts = []
  t.after(async () => { await h.close(); await preset.standing.dispose() })
  const result = await dynamicDrive(h, { definition: definition({ nativeTools: true, recoveryReadOnly: true, allowedTools: ['subagent'] }),
    onNativeExecution: async event => { receipts.push(event); return {} } })
  assert.equal(result.status, 'submitted')
  assert.equal(preset.delegated(), 1)
  assert.deepEqual(receipts.filter(event => event.phase === 'started').map(event => event.toolName), ['subagent', 'pwsh'])
  assert.ok(receipts.every(event => event.binding.executionId === dynamic().executionId))
  assert.match(requestSystemText(h.requests[0]), /动态委派/)
  assert.doesNotMatch(requestSystemText(h.requests[0]), /不能再委派|不能.*子agent/)
  assert.ok(h.requests[0].tools.some(tool => tool.name === 'pwsh'))
})

test('dynamic background requests retain native capability and native errors can be corrected in the same conversation', async t => {
  for (const background of [true, false]) await t.test(String(background), async t => {
    const h = await host({ script: background ? [{ name: 'pwsh', args: { run_in_background: true, valid: true } }, dynamicSubmit('background done')] : [{ name: 'pwsh', args: { valid: false } }, { name: 'pwsh', args: { valid: true } }, dynamicSubmit('corrected')] })
    let executed = 0
    const preset = await nativePreset(h, { execute: args => { executed++; if (!args.valid) throw new Error('known fixture failure'); return { done: true } } })
    t.after(async () => { await h.close(); await preset.standing.dispose() })
    const result = await dynamicDrive(h, { definition: definition({ nativeTools: true, allowedTools: [] }), onNativeExecution: async () => ({}) })
    assert.equal(executed, background ? 1 : 2)
    assert.equal(result.status, 'submitted')
  })
})

test('native process drain failure retains the execution slot and cannot report a settled result', async t => {
  const h = await host({ script: [{ name: 'pwsh', args: {} }] })
  const { SubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess')
  class FixtureProcess extends SubprocessRuntime { spawn() { return { terminate: async () => {}, waitForExit: async () => { throw new Error('range unknown') } } } }
  new FixtureProcess(h.ctx)
  const preset = await nativePreset(h, { execute: () => { h.ctx.subprocess.spawn({}); return { done: true } } })
  t.after(async () => { await h.manager.close().catch(() => {}); await h.ctx.fiber.dispose(); await preset.standing.dispose() })
  let results = 0
  await assert.rejects(dynamicDrive(h, { definition: definition({ nativeTools: true, allowedTools: [] }), onNativeExecution: async () => ({}), onResult: () => results++ }), error => error.executionDrained === false)
  assert.equal(results, 0)
  assert.throws(() => h.manager.assertDrained(dynamic()), error => error.executionDrained === false)
})

test('process tracking handles async terminal allocation and isolates parallel native call ownership', async t => {
  const { trackDynamicProcesses } = await import('../packages/dingtalk-dsh-assistant/dynamic-process-scope.js')
  const { SubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess')
  const ctx = new Context(), trace = []
  class FixtureProcess extends SubprocessRuntime {
    spawn({ id }) { return { terminate: async () => trace.push(`${id}:terminate`), waitForExit: async () => trace.push(`${id}:wait`) } }
    async spawnTerminal({ id }) { await delay(10); return { terminate: async () => trace.push(`${id}:terminal`) } }
  }
  new FixtureProcess(ctx)
  const tracker = trackDynamicProcesses(ctx.subprocess)
  t.after(async () => { await tracker.close(); await ctx.fiber.dispose() })
  await Promise.all([tracker.run(async () => { ctx.subprocess.spawn({ id: 'one' }); ctx.subprocess.spawnTerminal({ id: 'late' }) }),
    tracker.run(async () => { ctx.subprocess.spawn({ id: 'two' }) })])
  assert.deepEqual(trace.sort(), ['late:terminal','one:terminate','one:wait','two:terminate','two:wait'])
})

test('a later foreground drain failure still stops the same executors retained background processes', async t => {
  const h = await host({ script: [{ name: 'pwsh', args: { run_in_background: true } }, { name: 'pwsh', args: {} }] })
  const { SubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess')
  const trace = []
  class FixtureProcess extends SubprocessRuntime {
    spawn({ background }) { return { terminate: async () => trace.push(background ? 'background' : 'foreground'),
      waitForExit: async () => { if (!background) throw new Error('foreground range unknown') } } }
  }
  new FixtureProcess(h.ctx)
  const preset = await nativePreset(h, { execute: args => { h.ctx.subprocess.spawn({ background: args.run_in_background === true }); return { done: true } } })
  t.after(async () => { await h.manager.close().catch(() => {}); await h.ctx.fiber.dispose(); await preset.standing.dispose() })
  await assert.rejects(dynamicDrive(h, { definition: definition({ nativeTools: true, allowedTools: [] }), onNativeExecution: async () => ({}) }), error => error.executionDrained === false)
  assert.deepEqual(trace, ['foreground', 'background'])
})


test('retained process scopes keep services alive between tools and isolate parallel execution cleanup', async t => {
  const { trackDynamicProcesses } = await import('../packages/dingtalk-dsh-assistant/dynamic-process-scope.js')
  const trace = []
  const service = { spawn: ({ id }) => ({ terminate: async () => trace.push(id), waitForExit: async () => trace.push(`${id}:wait`) }) }
  const tracker = trackDynamicProcesses(service), first = tracker.scope(), second = tracker.scope()
  t.after(() => tracker.close())
  await Promise.all([first.run(async () => service.spawn({ id: 'first' })), second.run(async () => service.spawn({ id: 'second' }))])
  assert.deepEqual(trace, [])
  await first.close()
  assert.deepEqual(trace, ['first', 'first:wait'])
  await second.run(async () => assert.deepEqual(trace, ['first', 'first:wait']))
  await second.close()
  assert.deepEqual(trace, ['first', 'first:wait', 'second', 'second:wait'])
  assert.throws(() => first.run(() => {}), error => error.executionDrained === false)
})

test('native recovery validates durable identity and refuses missing bound sessions before releasing a lease', async t => {
  const root = await temp(), first = await host({ root, script: [dynamicSubmit('first')] })
  await dynamicDrive(first); await first.close()
  const next = await host({ root, script: [] }); t.after(() => next.close())
  const proof = await next.manager.recoverDrained({ binding: dynamic({ sessionBound: true }) })
  assert.deepEqual(proof, { drained: true, sessionBound: true })
  await assert.rejects(next.manager.recoverDrained({ binding: dynamic({ taskId: 'wrong', sessionBound: true }) }), { code: 'execution_session_identity_mismatch' })
  await assert.rejects(next.manager.recoverDrained({ binding: dynamic({ sessionId: 'missing-session', sessionBound: true }) }), { code: 'execution_session_missing' })
})

test('unverifiable background job without its native registry cannot report false success', async t => {
  const h = await host({ script: [{ name: 'pwsh', args: {} }, dynamicSubmit('blocked')] })
  const preset = await nativePreset(h, { execute: () => ({ jobId: 'background-build', status: 'running' }) })
  t.after(async () => { await h.close(); await preset.standing.dispose() })
  const receipts = []
  await dynamicDrive(h, { definition: definition({ nativeTools: true, allowedTools: [] }), onNativeExecution: async event => { receipts.push(event); return {} } })
  assert.equal(receipts[1].result.isError, true)
  assert.match(JSON.stringify(receipts[1].result), /DYNAMIC_JOB_REGISTRY_REQUIRED/)
})


test('one failed process termination still attempts cleanup of every other managed handle', async t => {
  const { trackDynamicProcesses } = await import('../packages/dingtalk-dsh-assistant/dynamic-process-scope.js')
  const calls = []
  const service = { spawn: ({ id }) => ({ terminate: async () => { calls.push(id); if (id === 'failure') throw new Error('cannot prove exit') }, waitForExit: async () => calls.push(`${id}:wait`) }) }
  const tracker = trackDynamicProcesses(service); t.after(() => tracker.close())
  await assert.rejects(tracker.run(async () => { service.spawn({ id: 'failure' }); service.spawn({ id: 'success' }) }), error => error.executionDrained === false)
  assert.deepEqual(calls.sort(), ['failure','success','success:wait'])
})


test('configured native preset is chosen once and resume retains the persisted preset without changing permissions', async t => {
  const root = await temp(), first = await host({ root, script: [dynamicSubmit('first')] })
  const one = await nativePreset(first)
  await dynamicDrive(first, { definition: definition({ nativeTools: true, allowedTools: [], agentPreset: 'configured-preset' }), onNativeExecution: async () => ({}) })
  assert.deepEqual(one.mounted, ['configured-preset'])
  await first.close(); await one.standing.dispose()
  const second = await host({ root, script: [dynamicSubmit('second')] }), two = await nativePreset(second)
  t.after(async () => { await second.close(); await two.standing.dispose() })
  const binding = dynamic({ leaseEpoch: 2, sessionBound: true, inputVersion: 2, inputDigest: 'new-input',
    inputHistory: [{ inputVersion: 1, inputDigest: 'dynamic-input-v1', requirementRevision: 1, controlRevision: 1 }] })
  await dynamicDrive(second, { binding, input: { objective: 'Follow-up' }, definition: definition({ nativeTools: true, allowedTools: [], agentPreset: 'changed-config' }), onNativeExecution: async () => ({}) })
  assert.deepEqual(two.mounted, ['dynamic-native-fixture'])
  assert.match(requestSystemText(second.requests[0]), /DYNAMIC_PRESET_WORKSPACE_RULES/)
})

test('anonymous field v12 native failure retains raw diagnostics and derives failure independently of HTTP200', async t => {
  const { fieldV12Error } = await import('./fixtures/execution-provider-field-sample.js')
  const h = await host({ script: [{ providerFailure: fieldV12Error }] }); t.after(() => h.close())
  let outputs = 0
  const result = await dynamicDrive(h, { onResult: () => outputs++ })
  assert.equal(result.status, 'no_submission'); assert.equal(result.reason, 'EXECUTION_PROVIDER_TRANSIENT')
  assert.equal(result.failure.phase, 'provider'); assert.deepEqual(result.failure.providerError, fieldV12Error)
  assert.equal(result.failure.providerError.phase, undefined); assert.equal(result.failure.providerError.status, undefined)
  assert.equal(result.failure.terminal.reason, 'error'); assert.equal(outputs, 0)
  assert.equal(h.manager.assertDrained(dynamic()), true)
})
