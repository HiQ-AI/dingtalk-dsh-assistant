import { readFile, access, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateDataset, modelInput, scoreScenario, summarize } from './score.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function packageIdentity(entry) {
  let directory = dirname(entry)
  while (true) {
    try {
      const bytes = await readFile(join(directory, 'package.json'))
      const manifest = JSON.parse(bytes)
      return { name: manifest.name, version: manifest.version, manifestSha256: sha(bytes) }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('package_manifest_not_found')
    directory = parent
  }
}
async function main() {
const args = process.argv.slice(2)
const flags = new Set(['--check', '--allow-paid', '--provider-budget-cap-confirmed', '--offline-contract'])
const values = new Map()
for (let i = 0; i < args.length; i++) {
  const key = args[i]
  if (!key.startsWith('--') || values.has(key)) throw new Error(`invalid_argument:${key}`)
  if (flags.has(key)) values.set(key, true)
  else {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing_argument:${key}`)
    values.set(key, args[++i])
  }
}
const allowed = new Set([...flags, '--dataset', '--profile', '--config', '--split', '--budget-usd', '--max-call-usd', '--scenario'])
for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown_argument:${key}`)
const datasetPath = resolve(values.get('--dataset') ?? 'docs/acceptance/topic-routing-quality/fixtures/scenarios.json')
const profilePath = values.get('--profile') && resolve(values.get('--profile'))
const configPath = values.get('--config') && resolve(values.get('--config'))
const split = values.get('--split') ?? 'holdout'
if (!profilePath || !configPath || !['development', 'holdout'].includes(split)) throw new Error('profile_config_and_valid_split_required')
const budget = Number(values.get('--budget-usd')), perCall = Number(values.get('--max-call-usd'))
if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(perCall) || perCall <= 0 || budget < perCall) throw new Error('explicit_positive_budget_required')
const [datasetBytes, configBytes] = await Promise.all([readFile(datasetPath), readFile(configPath)])
await access(profilePath)
const scenarios = JSON.parse(datasetBytes), dataset = validateDataset(scenarios), config = JSON.parse(configBytes)
if (!config.provider || !config.model || !config.providerConfig || !config.credentialsHome || !config.providerConfig.baseURL || !config.providerConfig.apiKeyEnv || !Array.isArray(config.providerConfig.models) || !config.providerConfig.models.some(model => model.id === config.model)) throw new Error('provider_model_config_credentials_home_required')
if (JSON.stringify(config.providerConfig).match(/"(?:apiKey|token|password|secret)"\s*:/i)) throw new Error('inline_credentials_forbidden')
const sources = ['packages/dingtalk-dsh-assistant/task-topic-coordinator.js', 'packages/dingtalk-dsh-assistant/topic-runtime.js',
  'packages/dingtalk-dsh-assistant/decision.js', 'packages/dingtalk-dsh-assistant/topic-model.js',
  'packages/dingtalk-dsh-assistant/store.js', 'packages/dingtalk-dsh-assistant/task-session-service.js',
  'packages/dingtalk-dsh-assistant/dynamic-task-store.js', 'packages/dingtalk-dsh-assistant/coordination-sessions.js',
  'test/fixtures/task-session-native-host.js', 'docs/acceptance/topic-routing-quality/scripts/run.mjs',
  'docs/acceptance/topic-routing-quality/scripts/score.mjs', 'pnpm-lock.yaml']
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async path => [path, sha(await readFile(path))])))
const binding = { datasetSha256: sha(datasetBytes), datasetCanonicalSha256: dataset.digest, sourceSha256,
  configSha256: sha(configBytes), provider: config.provider, model: config.model, profileSha256: sha(await readFile(profilePath)), split,
  maxStreams: Math.floor(budget / perCall), budgetUsd: budget, estimatedMaxCallUsd: perCall,
  budgetBoundary: '调用数乘预估单价不是美元硬上限；需提供商独立硬限额', datasetReview: 'pending' }
const selected = scenarios.filter(item => item.split === split && (!values.has('--scenario') || item.id === values.get('--scenario')))
if (!selected.length) throw new Error('empty_selection')
const issues = selected.flatMap(scenario => fixtureIssues(scenario).map(code => ({ id: scenario.id, code })))
const requireProfile = createRequire(pathToFileURL(profilePath))
for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-credentials-local']) requireProfile.resolve(name)
const baseEntry = requireProfile.resolve('@deepseek-ai/dsh-base')
const providerEntry = createRequire(baseEntry).resolve('@deepseek-ai/dsh-llm-pi-ai')
binding.resolvedPackages = await Promise.all([packageIdentity(baseEntry), packageIdentity(providerEntry)])
binding.profileLocks = {}
for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
  try { binding.profileLocks[name] = sha(await readFile(join(dirname(profilePath), name))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (!values.has('--offline-contract')) {
  const providerModule = await import(pathToFileURL(providerEntry))
  if (!providerModule.supportedProtocols().includes(config.providerConfig.api)) throw new Error('provider_api_protocol_required')
  providerModule.Config({ providers: { [config.provider]: config.providerConfig } })
}
if (values.has('--check')) {
  console.log(JSON.stringify({ mode: 'check', paidCalls: 0, liveAuthorized: false, scenarios: selected.length, issues, binding }))
  if (issues.length) process.exitCode = 1
} else {
  if (issues.length) throw new Error(`fixtures_not_executable:${JSON.stringify(issues)}`)
  const offline = values.has('--offline-contract')
  if (!offline && (!values.has('--allow-paid') || !values.has('--provider-budget-cap-confirmed'))) throw new Error('paid_model_forbidden_without_explicit_budget_and_provider_cap')
  const output = await runLive(selected, config, profilePath, binding, { offline })
  console.log(JSON.stringify(output))
  if (output.failures.length || output.results.length !== selected.length) process.exitCode = 1
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()

export function fixtureIssues(scenario) {
  const input = scenario.input, issues = []
  if (input.tasks.length > 1) issues.push('fixture_multiple_tasks_unavailable')
  if (input.tasks.some(task => !['running', 'waiting'].includes(task.state) || !task.ownerActorId)) issues.push('fixture_task_state_or_owner_unavailable')
  if (new Set(input.tasks.map(task => task.ownerActorId)).size > 1) issues.push('fixture_multiple_task_owners_unavailable')
  if (input.initialRoutingHold) {
    const hold = input.initialRoutingHold, first = input.messages.find(item => item.messageId === hold.messageId)
    const incoming = input.events?.find(event => event.kind === 'ingest' && event.quotedMessageId === hold.messageId)
    const reply = input.messages.find(item => item.messageId === incoming?.messageId)
    const events = input.events ?? []
    const recoveryIndex = events.indexOf(incoming)
    if (events.some((event, index) => event.kind === 'ingest' && !input.messages.some(message => message.messageId === event.messageId) || event.kind === 'observe-hold' && (event.messageId !== hold.messageId || event.previousEpoch !== hold.epoch || index >= recoveryIndex || events[index - 1]?.kind !== 'ingest' || events[index - 1].quotedMessageId) || !['ingest', 'observe-hold', 'observe-recovery'].includes(event.kind))) issues.push('fixture_hold_events_invalid')
    if (!first || hold.messageVersion !== 1 || hold.epoch !== 0 || !hold.reason || !reply || reply.replyToMessageId !== hold.messageId || incoming.quotedMessageId !== hold.messageId || !input.events.some(event => event.kind === 'observe-recovery' && event.messageId === hold.messageId && event.previousEpoch === hold.epoch)) issues.push('fixture_hold_sequence_invalid')
  } else if (scenario.category === 'needs-context-recovery' && input.messages.length > 1) issues.push('fixture_hold_sequence_missing')
  return issues
}

export async function runScenario(scenario, config, profilePath, binding, options = {}) {
  const result = await runLive([scenario], config, profilePath, binding, options)
  return result
}

async function runLive(selected, config, profilePath, binding, { offline = false } = {}) {
  const native = await import('../../../../test/fixtures/task-session-native-host.js')
  const { openTaskSessionService } = await import('../../../../packages/dingtalk-dsh-assistant/task-session-service.js')
  const { resolveTopicMessages } = await import('../../../../packages/dingtalk-dsh-assistant/store.js')
  const { taskBoardState } = await import('../../../../packages/dingtalk-dsh-assistant/task-message-projections.js')
  const profile = native.loadNativeTestProfile(profilePath)
  if (!profile.available) throw new Error(profile.reason)
  const requireProfile = createRequire(pathToFileURL(profilePath))
  const requireBase = createRequire(requireProfile.resolve('@deepseek-ai/dsh-base'))
  const load = (name, require = requireProfile) => import(pathToFileURL(require.resolve(name)))
  let streams = 0
  const results = [], failures = [], wire = [], cleanups = []
  for (const scenario of selected) {
    const input = modelInput(scenario)
    const root = await mkdtemp(join(tmpdir(), 'topic-quality-'))
    let host
    try {
      const fixtureProblems = fixtureIssues(scenario)
      if (fixtureProblems.length) throw new Error(fixtureProblems.join(','))
      const observedRequests = [], activeOwners = new Set()
      const taskSessions = {
        async run({ submit }) {
          if (input.tasks[0]?.state !== 'running') {
            await submit({ action: 'wait', summary: '隔离评估等待', evidence: [], limitations: [] })
            return { status: 'submitted' }
          }
          const gate = Promise.withResolvers()
          activeOwners.add(gate)
          try { await gate.promise; return { status: 'cancelled' } } finally { activeOwners.delete(gate) }
        },
        async cancel() { for (const gate of activeOwners) gate.resolve() },
        async close() { for (const gate of activeOwners) gate.resolve() },
      }
      const decide = request => {
        const calls = native.topicTaskCalls(request)
        if (request.tools.some(tool => tool.name === 'group_decision_submit')) {
          Object.assign(calls[0].args.decision, { actions: [], reason: '隔离合同回归不执行任务' })
          delete calls[0].args.decision.reply
          delete calls[0].args.decision.replyToMessageId
          delete calls[0].args.decision.replyReview
        }
        return calls
      }
      host = await native.nativeTaskHost(root, offline ? decide : () => { throw new Error('scripted_model_forbidden') }, {
        nativeProfile: profile,
        agentConfig: { provider: offline ? 'native-task-test' : config.provider, model: offline ? 'controlled' : config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) },
        config: { provider: offline ? 'native-task-test' : config.provider, webActorId: input.tasks[0]?.ownerActorId ?? 'evaluation-owner', ownerActorId: input.tasks[0]?.ownerActorId ?? 'evaluation-owner' },
        serviceFactory: options => openTaskSessionService({ ...options, taskSessions }),
      })
      if (!offline) {
        await host.ctx.plugin((await load('@deepseek-ai/dsh-credentials-local')).default, { dshHome: config.credentialsHome, watch: false })
        await host.ctx.plugin((await load('@deepseek-ai/dsh-llm-pi-ai', requireBase)).default, { providers: { [config.provider]: config.providerConfig } })
        await host.ctx.loader.await()
      }
      host.ctx.on('llm/stream', (request, next) => {
        if (!offline && (request.provider !== config.provider || request.model !== config.model)) throw new Error('unexpected_model')
        if (!offline && ++streams > binding.maxStreams) throw new Error('estimated_budget_exhausted')
        observedRequests.push(structuredClone(request))
        wire.push({ scenarioId: scenario.id, promptSha256: sha(JSON.stringify({ system: request.system, messages: request.messages })), schemaSha256: sha(JSON.stringify(request.tools)), provider: request.provider, model: request.model })
        return next()
      })
      await host.residentStore.updateGroup({ groupId: 'native-group', responsibility: input.group.responsibility })
      const actualToExpected = new Map(), topicIds = new Map(), taskIds = new Map(), foreignTopicIds = new Set(), groupIds = new Map([[input.group.id, 'native-group']])
      for (const topic of input.topics) {
        if (!groupIds.has(topic.groupId)) {
          const foreignGroup = `evaluation-foreign-${groupIds.size}`
          await host.residentStore.subscribe({ groupId: foreignGroup, responsibility: '隔离群历史资料' })
          groupIds.set(topic.groupId, foreignGroup)
        }
        const groupId = groupIds.get(topic.groupId), messageId = `seed-${topic.id}`
        await host.residentStore.ingest({ groupId, messageId, text: topic.summary, senderOpenDingTalkId: 'seed-owner', senderName: '历史记录', sourceKind: 'internal', occurredAt: '2026-01-01T00:00:00Z' })
        const seedSourceId = `im:${sha(JSON.stringify([groupId, messageId, 1]))}`
        await host.service.store.command({ kind: 'source.record', id: `source:${seedSourceId}`, args: { sourceId: seedSourceId, groupId, messageId, version: 1, actorId: 'seed-owner', senderName: '历史记录', text: topic.summary, timestamp: '2026-01-01T00:00:00Z' } })
        const receipt = await host.residentStore.routeMessages({ groupId, routeId: `seed-${topic.id}`, routingRevision: host.residentStore.getGroup(groupId).routingRevision,
          routes: [{ messageId, messageVersion: 1, topics: [{ newTopicKey: topic.id, title: topic.title }] }] })
        const realId = receipt.topicIdsByKey[topic.id]
        if (groupId === 'native-group') { topicIds.set(topic.id, realId); actualToExpected.set(realId, topic.id) }
        else foreignTopicIds.add(realId)
        const group = host.residentStore.getGroup(groupId), refs = group.messages.find(item => item.messageId === messageId).activeUnitRefs
        await host.residentStore.acceptTopicDecision({ groupId, topicId: realId, revision: 1, decisionId: `seed-decision-${topic.id}`, decision: { basisMessageIds: [messageId], basisUnitRefs: refs, actions: [], reason: '合成历史记录', topicUpdate: { summary: topic.summary } } })
        await host.residentStore.completeTopicDecision({ groupId, topicId: realId, decisionId: `seed-decision-${topic.id}` })
      }
      for (const task of input.tasks) {
        const topicId = topicIds.get(task.topicId)
        if (!topicId) throw new Error('fixture_task_topic_unavailable')
        const created = await host.service.createTask({ groupId: 'native-group', requestId: `seed-task-${task.id}`, title: task.title ?? task.objective.slice(0, 60), objective: task.objective,
          topicRefs: [{ topicId, revision: host.residentStore.getTopic('native-group', topicId).revision }] })
        taskIds.set(created.taskId, task.id)
      }
      if (input.tasks.some(task => task.state === 'running')) {
        await native.waitUntil(async () => {
          const tasks = await Promise.all([...taskIds.keys()].map(taskId => host.query('task.get', { taskId })))
          return tasks.every(task => taskBoardState(task) === 'running')
        }, '隔离任务进入运行态', 10000)
      } else await host.service.whenIdle()
      for (const [actualId, expectedId] of taskIds) {
        const task = await host.query('task.get', { taskId: actualId })
        const expected = input.tasks.find(item => item.id === expectedId)
        if (task.ownerActorId !== expected.ownerActorId || taskBoardState(task) !== expected.state) throw new Error('fixture_task_state_mismatch')
      }
      const sourceFor = message => ({ groupId: 'native-group', messageId: message.messageId, text: message.text, senderOpenDingTalkId: message.senderId,
        senderName: message.senderId, sourceKind: 'dingtalk', occurredAt: '2026-10-13T10:00:00Z', ...(message.replyToMessageId ? { quotedMessage: { messageId: message.replyToMessageId, content: input.messages.find(item => item.messageId === message.replyToMessageId)?.text ?? '' } } : {}) })
      let recoveryEvidence = null
      if (input.initialRoutingHold) {
        const hold = input.initialRoutingHold, first = input.messages.find(item => item.messageId === hold.messageId)
        await host.residentStore.ingest(sourceFor(first))
        await host.residentStore.routeMessages({ groupId: 'native-group', routeId: 'seed-hold', routingRevision: host.residentStore.getGroup('native-group').routingRevision,
          routes: [{ messageId: hold.messageId, messageVersion: hold.messageVersion, deferred: { reason: hold.reason } }] })
        const observed = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === hold.messageId)
        if (observed.routingHold?.epoch !== hold.epoch) throw new Error('fixture_hold_epoch_mismatch')
        await host.service.ingest(sourceFor(first))
        let observedUnrelatedHold = false
        for (const event of input.events ?? []) {
          if (event.kind === 'ingest') await host.service.ingest(sourceFor(input.messages.find(item => item.messageId === event.messageId)))
          if (event.kind === 'observe-hold') {
            const preceding = input.events.slice(0, input.events.indexOf(event)).findLast(item => item.kind === 'ingest')
            await native.waitUntil(async () => {
              const group = host.residentStore.getGroup('native-group')
              const message = group.messages.find(item => item.messageId === preceding.messageId)
              const source = (await host.query('source.list')).find(item => item.messageId === preceding.messageId)
              const topics = group.topics.filter(topic => topic.entries.some(entry => entry.messageId === preceding.messageId))
              return message?.routingStatus === 'routed' && source?.processingPending === true && !source.processingCompleted && topics.length > 0
                && topics.every(topic => !topic.decisions.some(decision => decision.decision.basisMessageIds?.includes(preceding.messageId)))
            }, '无关来源已路由并被待判屏障阻止决策', 20000)
            const held = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === hold.messageId)
            if (held.routingStatus !== 'needs-context' || held.routingHold?.epoch !== hold.epoch) throw new Error('fixture_unrelated_message_resumed_hold')
            observedUnrelatedHold = true
          }
        }
        const recovered = host.residentStore.getGroup('native-group').messages.find(item => item.messageId === hold.messageId)
        if (recovered.routingEpoch <= hold.epoch) throw new Error('fixture_recovery_not_observed')
        recoveryEvidence = { messageId: hold.messageId, messageVersion: hold.messageVersion, previousEpoch: hold.epoch, recoveredEpoch: recovered.routingEpoch, observedUnrelatedHold }
      } else for (const message of input.messages) await host.service.ingest(sourceFor(message))
      await native.waitUntil(async () => {
        const messages = host.residentStore.getGroup('native-group').messages.filter(message => input.messages.some(item => item.messageId === message.messageId))
        const sources = await host.query('source.list')
        return messages.length === input.messages.length && messages.every(message => {
          const source = sources.find(item => item.messageId === message.messageId)
          return source && (message.routingStatus === 'needs-context' ? !source.processingCompleted : !!source.processingCompleted)
        })
      }, '来源到达业务终态', 20000)
      const group = host.residentStore.getGroup('native-group'), messages = group.messages.filter(message => input.messages.some(item => item.messageId === message.messageId))
      if (messages.length !== input.messages.length) throw new Error('incomplete_source_observation')
      if (messages.some(message => message.routingStatus !== 'needs-context' && (message.routingStatus !== 'routed' || !['delivered', 'skipped'].includes(message.agentDeliveryStatus)))) throw new Error('business_terminal_not_observed')
      const sources = await host.query('source.list')
      if (messages.some(message => {
        const source = sources.find(item => item.messageId === message.messageId)
        if (!source) return true
        return message.routingStatus === 'needs-context' ? !!source.processingCompleted : !source.processingCompleted
      })) throw new Error('source_terminal_not_observed')
      const observedContent = JSON.stringify({ requests: observedRequests, tools: host.toolResults })
      if ([...foreignTopicIds].some(id => observedContent.includes(id))) throw new Error('foreign_topic_leaked')
      const observation = collectObservation({ group, input, actualToExpected, taskIds, requests: observedRequests, toolResults: host.toolResults, native, resolveTopicMessages })
      observation.seededForeignTopics = foreignTopicIds.size
      observation.recovery = recoveryEvidence
      observation.seededTasks = input.tasks.map(task => ({ id: task.id, ownerActorId: task.ownerActorId, state: task.state }))
      results.push(offline ? { id: scenario.id, observation, modelQuality: 'not-measured' } : { ...scoreScenario(scenario, observation), observation })
    } catch (error) {
      failures.push({ id: scenario.id, code: error.code ?? error.message, ...(offline ? { stack: error.stack } : {}) })
    } finally {
      await host?.close()
      await rm(root, { recursive: true, force: true })
      let absent = false
      try { await access(root) } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error }
      cleanups.push({ id: scenario.id, absent })
      if (!absent) throw new Error('isolated_directory_cleanup_failed')
    }
    if (streams >= binding.maxStreams) break
  }
  return { mode: offline ? 'offline-contract' : 'live', binding, streams, wire, results, failures, cleanups,
    summary: !offline && results.length ? summarize(results) : null,
    limitation: '脚本模型不计语义分数；真实评估的人工语义审核及草稿标注不足均不可视作通过。' }
}

export function collectObservation({ group, input, actualToExpected, taskIds, requests, toolResults, native, resolveTopicMessages }) {
  const routes = [], actions = [], candidates = new Set(), seenToolNames = new Set()
  for (const topic of group.topics) {
    for (const item of resolveTopicMessages(group, topic.topicId, topic.revision).filter(item => input.messages.some(message => message.messageId === item.messageId))) {
      for (const range of item.sourceRanges ?? []) routes.push({ messageId: item.messageId, source: item._sourceMessageText.slice(range.start, range.end), topic: actualToExpected.get(topic.topicId) ?? `new:${topic.topicId}` })
    }
    for (const decision of topic.decisions.filter(record => record.decision.basisMessageIds?.some(id => input.messages.some(message => message.messageId === id)))) {
      if (decision.status !== 'completed' || decision.operations?.some(operation => operation.status !== 'applied')) throw new Error('decision_terminal_not_observed')
      for (const action of decision.decision.actions) actions.push({ kind: action.kind, ...(action.taskId ? { taskId: taskIds.get(action.taskId) ?? action.taskId } : {}) })
    }
  }
  for (const request of requests) {
    for (const tool of request.tools ?? []) seenToolNames.add(tool.name)
    let item
    try { item = native.latestInput(request) } catch { continue }
    for (const topic of [...(item.topics ?? []), ...(item.relatedTopics ?? []), ...(item.recalledTopics ?? [])]) if (actualToExpected.has(topic.topicId)) candidates.add(actualToExpected.get(topic.topicId))
    for (const result of native.modelToolValues(request)) for (const topic of result.topics ?? []) if (actualToExpected.has(topic.topicId)) candidates.add(actualToExpected.get(topic.topicId))
  }
  for (const event of toolResults) {
    const result = event.result?.value
    if (event.name === 'group_topic_list') for (const topic of result?.topics ?? []) if (actualToExpected.has(topic.topicId)) candidates.add(actualToExpected.get(topic.topicId))
  }
  return { routeStatus: group.messages.some(message => input.messages.some(item => item.messageId === message.messageId) && message.routingStatus === 'needs-context') ? 'needs-context' : 'routed',
    routes, actions, candidates: [...candidates], requestTools: [...seenToolNames] }
}
