// 真实模型 + 本分支原生协调器；正式实例仅GET，独立临时账无dispatch/外发入口。
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join, isAbsolute } from 'node:path'
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { createMessageCoordinator } from '../../../../packages/dingtalk-dsh-assistant/message-coordinator.js'
import { createGroupCoordinatorSessions } from '../../../../packages/dingtalk-dsh-assistant/group-coordinator-session.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../../../../packages/dingtalk-dsh-assistant/message-workflow.js'
import { digest } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'

const { values } = parseArgs({ options: { profile: { type: 'string' }, output: { type: 'string' }, case: { type: 'string' }, check: { type: 'boolean' }, run: { type: 'boolean' } } })
assert.ok(isAbsolute(values.profile ?? '') && isAbsolute(values.output ?? ''))
assert.notEqual(values.check === true, values.run === true)
const output = resolve(values.output), requireProfile = createRequire(join(values.profile, 'package.json'))
const provider = await import(pathToFileURL(requireProfile.resolve('dsh-codex-connect')))
const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
if (values.check) { console.log(JSON.stringify({ mode: 'check', writes: 0, nativeProviderAvailable: true, businessDispatch: false, dingtalkTools: false })); process.exit(0) }
await mkdir(output, { recursive: false })
const get = async path => { const r = await fetch(`http://127.0.0.1:18998${path}`, { signal: AbortSignal.timeout(30000) }); assert.equal(r.status, 200); return r.json() }
const [config, state] = await Promise.all([get('/state/agent-config'), get('/state/workflows')])
assert.equal(config.provider, 'openai-codex')
const selection = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
const originals = ['msg-a5e4031a162a8eca4976166e2bf3cf704bee6777', 'msg-afb0ab3c3e6a5c7fd1a573919ea44ae320369347'].map(id => {
 const run = state.messages.find(m => m.runId === id); assert.ok(run, `source missing:${id}`); return run
})
const cases = originals.map((run, i) => ({ id: i ? 'document-development' : 'work-style', originalRunId: run.runId, body: run.body,
 actorId: run.actorId, history: i ? run.snapshot.history.slice(run.snapshot.history.findLastIndex(s => /数据集过程导入导出/u.test(s.text))) : run.snapshot.history.filter(s => /is_deleted|任务已完成/u.test(s.text)).slice(-3),
 policy: run.snapshot.policy.replace('只有已认证任务所有者可以要求执行。', '任务准入由Host根据当前身份、明确交办及同一事项来源核验；不得自行把权限问题转成澄清。'), names: run.snapshot.agentNames }))
cases.push({ id: 'necessary-clarification', body: '小小鹏，请处理导入规则：甲方案保留全部历史结果，乙方案清除全部历史结果。两方案互斥，我还没决定选哪个，请先问我选择后再建开发任务。', actorId: 'requester', history: [], policy: '负责导入导出开发，明确交办由Host准入；目标冲突确实阻止下一步时询问。', names: ['小小鹏'] })
const documentHistory = originals[1].snapshot.history
const documentAt = documentHistory.findLastIndex(source => /数据集过程导入导出/u.test(source.text))
const linked = documentHistory.slice(documentAt).map(source => state.messages.find(run => run.sourceKey === source.sourceKey))
assert.equal(linked.length, 2); assert.ok(linked.every(Boolean), '需要读取文档和点名两条真实来源')
const chainMessages = [originals[0], ...linked, originals[1]]
for (const mode of ['batch', 'sequential']) cases.push({ id: `topic-chain-${mode}`, mode, messages: chainMessages,
 history: [], policy: cases[1].policy, names: cases[1].names })
const sensitive = new Set(originals.flatMap(run => [run.actorId, run.conversationId, ...run.snapshot.history.map(s => s.actorId)]).filter(Boolean))
const redact = value => {
 if (typeof value === 'string') { let text = value; for (const id of sensitive) text = text.replaceAll(id, `identity-${digest(id).slice(0, 10)}`); return text.replace(/(?:https?|dingtalk):[^\s"<>]+/gu, '[redacted-url]') }
 if (Array.isArray(value)) return value.map(redact)
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
 return value
}
const results = []
for (const item of cases.filter(item => !values.case || values.case === item.id || values.case === 'topic-chain' && item.messages)) {
 const temporary = resolve('docs/tmp/clarification-model-replay'); await mkdir(temporary, { recursive: true })
 const local = await mkdtemp(join(temporary, `${item.id}-`)), ctx = new Context(), traces = []
 new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
 new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false }); new LlmRuntime(ctx); new ToolRuntime(ctx)
 ctx.on('tools/result', (exec, result) => traces.push({ kind: 'tool-result', name: exec.name, result }))
 ctx.provide('shell', { sandboxMode: 'workspace-write' }); new ApprovalService(ctx, { policy: 'ask' })
 new PermissionPresetService(ctx, { presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } })
 new JsonlSessionPersistence(ctx, { root: join(local, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
 new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
 const settings = requireProfile('yaml').parse(await readFile(join(values.profile, 'cordis.yml'), 'utf8'))['llm-openai-codex'] ?? {}
 provider.apply(ctx, { ...provider.DEFAULT_OPENAI_CODEX_SETTINGS, ...settings })
 const store = await openExecutionStore({ dbPath: join(local, 'control.sqlite'), instanceId: item.id, initialize: true })
 const native = createGroupCoordinatorSessions({ ctx, isCurrent: async binding => { const s = (await store.query({ kind: 'message.coordinator', conversationId: binding.conversationId })).coordinator; return ['running', 'committed'].includes(s?.status) && s.turnId === binding.turnId && s.leaseEpoch === binding.leaseEpoch } })
 const history = async run => item.messages ? (await store.query({ kind: 'message.list', conversationId: 'isolated-group', limit: 200 }))
  .filter(source => source.sequenceId < run.sequenceId).reverse().map(source => ({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, text: source.body, actorId: source.actorId })) : item.history
 const context = { agentNames: () => item.names, history, splitBackground: async ({ history }) => history,
  candidates: async () => { const topics = await store.query({ kind: 'message.topics', conversationId: 'isolated-group' });
   return { cards: topics.map(topic => ({ candidateId: topic.topicId, topicId: topic.topicId, title: topic.title, summary: topic.summary, goal: topic.summary ?? topic.title, state: 'topic', sourceRefs: topic.facts.flatMap(fact => fact.sourceRefs.map(ref => ref.sourceKey)), distinguishingFacts: topic.facts.slice(-3).map(fact => fact.text) })), total: topics.length, catalogRevision: digest(topics) } },
  facts: async ({ binding }) => ({ ...(binding.topicId ? { topic: await store.query({ kind: 'message.topic', topicId: binding.topicId }) } : {}), actorMayCreate: true, taskAdmission: { allowed: true, reasonCode: 'ISOLATED_ADMISSION_FACT', sourceRefs: item.history.map(s => ({ sourceKey: s.sourceKey, sourceVersion: s.sourceVersion })) }, availableWorkflows: [{ workflowId: 'task-engineering', purpose: '开发任务；Owner在工程准备前确认环境' }], repositories: [{ id: 'dataset', purpose: '数据集导入导出' }] }),
  validateActions: async () => ({ kind: 'accepted' }),
  material: async ({ needs }) => ({ ready: true, data: { resources: await Promise.all(needs.map(async n => ({ resourceRef: n.resourceRef, text: (await store.query({ kind: 'message.source', sourceKey: n.resourceRef }))?.body ?? item.history.find(s => s.sourceKey === n.resourceRef)?.text ?? item.body }))) } }) }
 const coordinator = createMessageCoordinator({ ctx, store, context, modelConfig: async () => selection,
  sessionRunner: { close: () => native.close(), run: async args => { traces.push({ kind: 'input', input: args.input }); return native.run({ ...args, onCandidate: async candidate => { traces.push({ kind: 'candidate', candidate }); try { const accepted = await args.onCandidate(candidate); traces.push({ kind: 'accepted', accepted }); return accepted } catch (error) { traces.push({ kind: 'feedback', code: error.code, message: error.message }); throw error } } }) } } })
 const workflow = createMessageWorkflow({ store, coordinator, context, handlers: {}, judge: async () => { throw Error('LEGACY_MODEL_FORBIDDEN') } })
 const started = Date.now(); let error, readback
 try {
  if (item.messages) {
   const stages = [], runs = []
   for (const [index, message] of item.messages.entries()) {
    const runId = `${item.id}:${index}`
    await workflow.receive({ runId, sourceKey: `replay:${runId}`, sourceVersion: 1, conversationId: 'isolated-group', actorId: message.actorId, body: message.body,
     context: { compactPolicy: item.policy, agentNames: item.names, quoteRefs: [], attachments: [], occurredAt: message.context.occurredAt } }, { process: false })
    runs.push({ runId, originalRunId: message.runId, originalSourceVersion: message.sourceVersion })
    if (item.mode === 'sequential') { await coordinator.process(runId, { dispatch: async () => {} }); stages.push({ index, topics: await store.query({ kind: 'message.topics', conversationId: 'isolated-group' }) }) }
   }
   if (item.mode === 'batch') await coordinator.process(runs[0].runId, { dispatch: async () => {} })
   const sources = await Promise.all(runs.map(run => store.query({ kind: 'message.run', runId: run.runId })))
   const topics = await store.query({ kind: 'message.topics', conversationId: 'isolated-group' })
   const bindings = await store.query({ kind: 'message.topic.bindings', conversationId: 'isolated-group' })
   readback = { runs, sources, topics, bindings, stages }
   assert.equal(topics.length, 1, '四条交办链应复用同话题，不在末轮人为合并')
   assert.equal(bindings.length, 4); assert.equal(new Set(bindings.map(binding => binding.topic.topicId)).size, 1)
   assert.equal(sources.flatMap(source => source.requests).length, 0)
   const creates = sources.flatMap(source => source.commands).filter(command => ['create', 'research'].includes(command.kind))
   assert.equal(creates.length, 1); assert.equal(creates[0].runId, runs[3].runId)
   for (const word of ['数据集', '导入', '导出', '开发']) assert.ok(`${topics[0].title} ${topics[0].summary ?? ''}`.includes(word), `最终展示应包含${word}`)
   assert.ok(topics[0].summary?.trim()); assert.doesNotMatch(JSON.stringify([topics[0].title, topics[0].summary, creates[0].args]), /工单|SQL|生产执行/u)
   if (item.mode === 'sequential') { assert.equal(stages[0].topics.length, 1); assert.notEqual(stages[0].topics[0].title, topics[0].title); for (const stage of stages) assert.equal(stage.topics.length, 1) }
  } else {
  await workflow.receive({ runId: item.id, sourceKey: `replay:${item.id}`, sourceVersion: 1, conversationId: 'isolated-group', actorId: item.actorId, body: item.body, context: { compactPolicy: item.policy, agentNames: item.names, quoteRefs: [], attachments: [] } }, { process: false })
  // 只提交协调决定；完全不调用工作流派发器或任务后端。
  await coordinator.process(item.id, { dispatch: async () => {} })
  readback = await store.query({ kind: 'message.run', runId: item.id })
  if (item.id === 'work-style') { assert.equal(readback.requests.length, 0); assert.ok(readback.commands.every(c => !['create', 'research'].includes(c.kind)), '没有具体新事项时不能虚构专项修复任务') }
  else if (item.id === 'document-development') { assert.equal(readback.requests.length, 0); assert.equal(readback.commands.filter(c => ['create', 'research'].includes(c.kind)).length, 1); assert.doesNotMatch(JSON.stringify(readback.commands.map(c => c.args)), /工单|SQL|生产执行/u, '不得混入旧SQL事项的交付约束') }
  else { assert.equal(readback.requests.length, 1); assert.equal(readback.requests[0].kind, 'needs_clarification'); assert.equal(readback.commands.length, 0) }
  }
 } catch (e) { error = { name: e.name, code: e.code ?? null, message: e.message } }
 finally { const group = await store.query({ kind: 'message.coordinator', conversationId: 'isolated-group' }); if (group.coordinator?.sessionId) { const saved = await ctx.sessionPersistence.inspect(group.coordinator.sessionId); traces.push({ kind: 'native-events', events: saved.events.filter(event => event.type === 'assistant/message').map(event => ({ type: event.type, seq: event.seq, turn: event.data.turn, step: event.data.step, content: event.data.message.content.filter(block => ['tool-call', 'text'].includes(block.type)), usage: event.data.usage })) }) } await workflow.close(); await store.close(); await ctx.fiber.dispose(); await rm(local, { recursive: true, force: true }) }
 const result = { id: item.id, originalRunId: item.originalRunId, ...selection, elapsedMs: Date.now() - started, passed: !error, error,
  boundary: '真实模型及本分支原生协调与持久提交；准入事实受控，业务dispatch为零。历史仅相关快照，非全量生产会话重现。', traces, readback }
 await writeFile(join(output, `${item.id}.json`), JSON.stringify(redact(result), null, 2))
 results.push({ id: item.id, passed: !error, error, elapsedMs: result.elapsedMs }); console.log(JSON.stringify(results.at(-1)))
}
await writeFile(join(output, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), ...selection, externalEffects: 0, results }, null, 2))
if (results.some(r => !r.passed)) process.exitCode = 1
