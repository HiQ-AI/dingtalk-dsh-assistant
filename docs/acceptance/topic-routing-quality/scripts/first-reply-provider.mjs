import { access, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHistoricalFirstReply } from './first-reply-history.mjs'
import { boundedFirstReplyFixture, boundedBenchmarkFirstReplyFixture, readBoundedHistoricalSources, seedBoundedStores } from './first-reply-bounded.mjs'
import { installEvaluationIsolation, installBoundedTopicGuard, isolatedEffects, redactCredential, redactCredentialValue } from './first-reply-isolation.mjs'
import * as native from '../../../../test/fixtures/task-session-native-host.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const values = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
  const at = arg.indexOf('=')
  return [arg.slice(2, at), arg.slice(at + 1)]
}))
for (const key of ['source', 'profile', 'config', 'resident', 'decision-session', 'route-session', 'sequence']) if (!values[key]) throw new Error(`missing_${key}`)
const sequence = Number(values.sequence), source = resolve(values.source), profilePath = resolve(values.profile)
if (![773, 774, 778, 780, 783].includes(sequence)) throw new Error('unsupported_sequence')
const configBytes = await readFile(values.config), config = JSON.parse(configBytes)
const ref = config.providerConfig?.apiKeyEnv
const credential = typeof ref === 'string' ? process.env[ref] : undefined
const redact = text => redactCredential(redactCredential(text, credential), credential, true)
const safeValue = value => redactCredentialValue(value, credential)
if (config.provider !== 'cortex-gateway' || config.model !== 'cortex-cowork' || config.reasoningEffort !== 'low' || !config.providerConfig?.api || !config.providerConfig?.baseURL || !config.providerConfig?.apiKeyEnv || !config.providerConfig.models?.some(model => model.id === config.model)) throw new Error('provider_configuration_mismatch')
if (JSON.stringify(config.providerConfig).match(/"(?:apiKey|token|password|secret|headers)"\s*:/i)) throw new Error('inline_credentials_forbidden')
const paths = [source, profilePath, values.resident, values['decision-session'], values['route-session'], ...(values['related-decision-session'] ? [values['related-decision-session']] : [])]
await Promise.all(paths.map(path => access(path)))
const requireProfile = createRequire(pathToFileURL(profilePath)), baseEntry = requireProfile.resolve('@deepseek-ai/dsh-base')
const providerEntry = createRequire(baseEntry).resolve('@deepseek-ai/dsh-llm-pi-ai')
const provider = await import(pathToFileURL(providerEntry).href)
if (!provider.supportedProtocols().includes(config.providerConfig.api)) throw new Error('provider_api_protocol_required')
provider.Config({ providers: { [config.provider]: config.providerConfig } })
const sourcePaths = ['packages/dingtalk-dsh-assistant/task-topic-coordinator.js', 'packages/dingtalk-dsh-assistant/topic-runtime.js', 'packages/dingtalk-dsh-assistant/decision.js', 'packages/dingtalk-dsh-assistant/topic-model.js', 'packages/dingtalk-dsh-assistant/store.js', 'packages/dingtalk-dsh-assistant/task-session-service.js', 'packages/dingtalk-dsh-assistant/dynamic-task-store.js', 'packages/dingtalk-dsh-assistant/coordination-sessions.js', 'test/fixtures/task-session-native-host.js', 'pnpm-lock.yaml']
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(join(source, path)))])))
const harnessSha256 = sha(await readFile(new URL('../../../../test/fixtures/task-session-native-host.js', import.meta.url)))
const evaluationSha256 = Object.fromEntries(await Promise.all(['first-reply-provider.mjs', 'first-reply-bounded.mjs', 'first-reply-isolation.mjs'].map(async name => [name, sha(await readFile(new URL(name, import.meta.url)))])))
evaluationSha256['task-message-projections.js'] = sha(await readFile(new URL('../../../../packages/dingtalk-dsh-assistant/task-message-projections.js', import.meta.url)))
const binding = { sequence, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, configSha256: sha(configBytes), profileSha256: sha(await readFile(profilePath)), providerModuleSha256: sha(await readFile(providerEntry)), harnessSha256, evaluationSha256, sourceSha256 }
const snapshot = await readHistoricalFirstReply({ residentPath: values.resident, decisionSessionPath: values['decision-session'], routeSessionPath: values['route-session'], relatedDecisionSessionPath: values['related-decision-session'], sequence })
const fixture = (process.argv.includes('--benchmark-related-active') ? boundedBenchmarkFirstReplyFixture : boundedFirstReplyFixture)(snapshot)
if (sequence !== 773 && !values['source-db']) throw new Error('source_db_required')
const historicalSources = sequence === 773 ? [] : readBoundedHistoricalSources(values['source-db'], fixture)
if (sequence !== 773) Object.assign(fixture.scope, { resourceMetadataProjected: true, contentNotReconstructed: true, historicalSourceCount: historicalSources.length, historicalSourceSha256: sha(JSON.stringify(historicalSources)), fixtureSha256: sha(JSON.stringify(fixture)) })
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ mode: 'check', modelCalls: 0, sideEffects: false, binding, scope: fixture.scope }))
} else {
  if (!process.argv.includes('--allow-paid')) throw new Error('paid_model_forbidden')
  if (!values['private-evidence'] || basename(values['private-evidence']) !== values['private-evidence'] || !/^[a-zA-Z0-9._-]+\.json$/.test(values['private-evidence'])) throw new Error('private_evidence_filename_required')
  const evidenceParent = await realpath(new URL('../../../tmp/', import.meta.url))
  const evidenceDir = join(evidenceParent, 'semantic-latency')
  await mkdir(evidenceDir, { recursive: true })
  if (dirname(await realpath(evidenceDir)) !== evidenceParent) throw new Error('private_evidence_directory_invalid')
  const load = path => import(pathToFileURL(join(source, path)).href)
  const profile = native.loadNativeTestProfile(profilePath)
  if (!profile.available) throw new Error('native_profile_unavailable')
  const { residentDomainSpec, openResidentStore } = await load('packages/dingtalk-dsh-assistant/store.js')
  const { openDynamicTaskStore } = await load('packages/dingtalk-dsh-assistant/dynamic-task-store.js')
  const { openTaskSessionService } = await load('packages/dingtalk-dsh-assistant/task-session-service.js')
  const evidence = await open(join(evidenceDir, values['private-evidence']), 'wx', 0o600)
  const root = await mkdtemp(join(tmpdir(), 'first-reply-provider-')), effects = isolatedEffects(), streams = [], toolCalls = [], assistant = []
  const privateEvidence = { binding, scope: fixture.scope, initialTasks: fixture.tasks, requests: [], streamChunks: [], events: [], tools: [], diagnostics: [], error: null }
  let host, terminal, stages
  try {
    host = await native.nativeTaskHost(root, () => { throw new Error('scripted_model_forbidden') }, { resident: true, nativeProfile: profile, installModelAdapter: async ctx => {
      await ctx.plugin(provider.default ?? provider, { providers: { [config.provider]: config.providerConfig } })
      await ctx.loader.await()
      ctx.on('llm/stream', (request, next) => {
        if (request.provider !== config.provider || request.model !== config.model || request.reasoningEffort !== 'low') throw new Error('unexpected_model_selection')
        privateEvidence.requests.push(JSON.parse(JSON.stringify(request)))
        let exposure
        try {
          const input = native.latestInput(request)
          if (input.requestId?.startsWith('coord-route-')) {
            const groups = [input.topics ?? [], input.relatedTopics ?? [], input.recalledTopics ?? []]
            exposure = { topicCounts: groups.map(items => items.length), targetVisible: groups.map(items => items.some(item => item.topicId === fixture.targetTopicId)) }
          }
        } catch {}
        const entry = { session: sha(String(request.sessionId)), promptSha256: sha(JSON.stringify({ system: request.system, messages: request.messages })), schemaSha256: sha(JSON.stringify(request.tools)), ...(exposure ? { exposure } : {}), startedAt: Date.now(), firstChunkMs: null, durationMs: null, chunks: 0, parameterChunks: 0, parameterFirstMs: null, parameterLastMs: null }
        streams.push(entry)
        return (async function* () {
          try {
            for await (const rawChunk of next()) {
              const chunk = rawChunk.type === 'finish' ? safeValue(rawChunk) : rawChunk
              if (entry.firstChunkMs === null) entry.firstChunkMs = Date.now() - entry.startedAt
              entry.chunks++
              privateEvidence.streamChunks.push({ sessionId: request.sessionId, chunk: structuredClone(chunk) })
              if (chunk.type === 'tool-call-delta') {
                entry.parameterChunks++
                entry.parameterFirstMs ??= Date.now() - entry.startedAt
                entry.parameterLastMs = Date.now() - entry.startedAt
              }
              if (chunk.usage !== undefined) entry.usage = structuredClone(chunk.usage)
              yield chunk
            }
          } catch (error) {
            const sanitized = new Error(redact(String(error?.message ?? error)))
            if (typeof error?.code === 'string') sanitized.code = redact(error.code)
            throw sanitized
          } finally { entry.durationMs = Date.now() - entry.startedAt }
        })()
      })
      ctx.on('session/event', (session, event) => {
        try { privateEvidence.events.push({ sessionId: session.id, event: structuredClone(event) }) }
        catch { privateEvidence.diagnostics.push({ code: 'session_event_capture_failed', sessionId: session.id }); return }
        if (event.type !== 'assistant/message') return
        const stream = event.data?.stream
        if (!Array.isArray(stream)) { privateEvidence.diagnostics.push({ code: 'assistant_stream_missing', sessionId: session.id }); return }
        if (stream.some(item => item.type === 'tool-call-chunks' && (!Array.isArray(item.args) || !Array.isArray(item.dt) || item.args.length !== item.dt.length + 1))) {
          privateEvidence.diagnostics.push({ code: 'assistant_stream_invalid', sessionId: session.id })
          return
        }
        assistant.push({ session: sha(String(session.id)), streamSha256: sha(JSON.stringify(stream)), usage: structuredClone(event.data.usage), toolCalls: stream.filter(item => item.type === 'tool-call-chunks').map(item => ({ name: item.name, chunks: item.args.length, durationMs: item.dt.reduce((a, b) => a + b, 0) })) })
      })
      ctx.on('tools/execute', async (execution, next) => {
        const entry = { name: execution.name, session: sha(String(execution.agent?.session?.id)), startedAt: Date.now(), durationMs: null }
        toolCalls.push(entry)
        const privateTool = { sessionId: execution.agent?.session?.id, name: execution.name, arguments: structuredClone(execution.arguments) }
        privateEvidence.tools.push(privateTool)
        try { const result = await next(); entry.isError = result.isError; privateTool.result = structuredClone(result); return result }
        catch (error) { privateTool.error = String(error?.stack ?? error); throw error }
        finally { entry.durationMs = Date.now() - entry.startedAt }
      })
    } })
    installEvaluationIsolation(host.ctx)
    installBoundedTopicGuard(host.ctx, { groupId: fixture.group.groupId, targetTopicId: fixture.targetTopicId })
    const seeded = await seedBoundedStores({ storageDomain: host.ctx.storageDomain, root, fixture, residentDomainSpec, openResidentStore, openDynamicTaskStore, historicalSources })
    host.residentStore = seeded.residentStore
    const legacy = { getAgentConfig: () => ({ workspaceDir: root, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, agentPreset: 'native-test', agentNames: ['测试助手'] }), getGroup: id => host.residentStore.getGroup(id) }
    host.service = await openTaskSessionService({ ctx: host.ctx, legacy, residentStore: host.residentStore, taskSessions: effects.taskSessions, notifications: effects.notificationAdapter, config: { ...seeded.config, initialize: false, workspaceDir: root, provider: config.provider, ownerActorId: fixture.tasks[0].ownerActorId, webActorId: fixture.tasks[0].ownerActorId } })
    await host.service.ingest(fixture.input)
    await native.waitUntil(async () => {
      const sources = await host.service.store.query({ kind: 'source.list' }), group = host.residentStore.getGroup(fixture.group.groupId)
      return sources.some(item => item.messageId === fixture.input.messageId && item.processingCompleted) && group.outbox.some(item => item.status === 'sent' && item.deliveredMessageId?.startsWith('isolated-notification-') && item.deliveredAt)
    }, 'isolated terminal', 180000)
    const group = host.residentStore.getGroup(fixture.group.groupId)
    const sourceRecord = (await host.service.store.query({ kind: 'source.list' })).find(item => item.messageId === fixture.input.messageId)
    stages = (sourceRecord?.stages ?? []).map(item => ({ stage: item.stage, startedAt: item.startedAt, completedAt: item.completedAt, shared: item.shared }))
    const decisions = group.topics.flatMap(topic => topic.decisions).filter(item => item.decision.basisMessageIds?.includes(fixture.input.messageId))
    const record = decisions.length === 1 ? decisions[0] : undefined, actions = record?.decision.actions ?? [], operations = record?.operations ?? []
    const targetTaskIds = new Set(fixture.tasks.map(task => task.taskId))
    const structuralActionAccepted = sequence === 773 ? actions.length === 0 : actions.length === 1 && actions[0].kind === 'task-reopen' && targetTaskIds.has(actions[0].taskId) && operations.some(item => item.actionIndex === 0 && item.taskId === actions[0].taskId && item.status === 'applied')
    terminal = { decisions: decisions.length, decisionStatus: record?.status, structuralActionAccepted, actionKinds: actions.map(item => item.kind), semanticReview: 'pending', streamDiagnostics: privateEvidence.diagnostics.map(item => item.code), realDelivery: false }
  } catch (error) {
    privateEvidence.error = String(error?.stack ?? error)
    console.error('first_reply_evaluation_failed; see private evidence')
    process.exitCode = 1
  } finally {
    try {
      if (host?.residentStore) privateEvidence.group = host.residentStore.getGroup(fixture.group.groupId)
      if (host?.service?.store) {
        const store = host.service.store
        privateEvidence.sources = await store.query({ kind: 'source.list' })
        const records = (privateEvidence.group?.topics ?? []).flatMap(topic => topic.decisions ?? []).filter(record => record.decision?.basisMessageIds?.includes(fixture.input.messageId))
        const taskIds = new Set([...fixture.tasks.map(task => task.taskId), ...records.flatMap(record => record.operations.map(operation => operation.taskId)).filter(Boolean)])
        privateEvidence.finalTasks = await Promise.all([...taskIds].map(async taskId => ({ taskId, task: await store.query({ kind: 'task.get', taskId }) })))
        privateEvidence.operationReceipts = await Promise.all(records.flatMap(record => record.operations).map(async operation => ({ operationId: operation.operationId, receipt: await store.query({ kind: 'receipt.get', id: `topic-operation:${operation.operationId}` }) })))
      }
      privateEvidence.effects = effects
    } catch (error) { privateEvidence.captureError = String(error?.stack ?? error) }
    try { await host?.close() } finally {
      if (terminal) {
        Object.assign(terminal, { sends: effects.notifications.length, readbacks: effects.readbacks.length, ownerRunAttempts: effects.ownerAttempts.length, ownerRunDenied: effects.ownerAttempts.length, actualOwnerExecutions: 0, emptyCancels: effects.emptyCancels.length })
        console.log(JSON.stringify({ binding, scope: fixture.scope, terminal, streams, assistant, toolCalls, stages }))
        process.exitCode = terminal.decisionStatus === 'completed' && terminal.structuralActionAccepted && terminal.sends && terminal.readbacks && (sequence !== 773 || !terminal.ownerRunAttempts) && privateEvidence.diagnostics.length === 0 ? 2 : 1
      }
      try { await evidence.writeFile(JSON.stringify(safeValue(privateEvidence))); await evidence.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}
