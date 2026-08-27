import { createServer } from 'node:http'
import { handleRequest } from './http.js'
import { openResidentStore } from './store.js'
import { openResidentRuntime } from './runtime.js'
import { installFakeLlm } from './fake-llm.js'
import { createDwsAdapter } from './dws-adapter.js'
import { createNodeDwsRunner } from './dws-runner.js'
import { normalizeHistoryMessage, startDwsBridge } from './dws-bridge.js'
import { inspectEnvironment } from './environment.js'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { tmpdir } from 'node:os'

export const name = 'dingtalk-dsh-assistant'
export const inject = ['storageDomain', 'agents', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'subagents', 'goals', 'llm', 'systemPrompt', 'attachments']

function applyProxyEnvironment(proxyUrl) {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (proxyUrl) process.env[name] = proxyUrl
    else delete process.env[name]
  }
  if (proxyUrl) {
    if (!process.env.NO_PROXY && !process.env.no_proxy) process.env.NO_PROXY = '127.0.0.1,localhost'
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } else {
    setGlobalDispatcher(new Agent())
  }
}

export async function configureResidentGroups(runtime, groups = []) {
  if (runtime.hasGroupConfiguration()) {
    for (const group of groups) {
      const existing = runtime.getGroup(group.groupId)
      if (existing !== undefined && !existing.name && typeof group.name === 'string') await runtime.updateGroup({ groupId: group.groupId, name: group.name })
    }
    return
  }
  if (!Array.isArray(groups)) throw new Error('dingtalk_groups_must_be_array')
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || typeof group.groupId !== 'string' || group.groupId.trim() === '') throw new Error('dingtalk_group_id_required')
    await runtime.subscribe({ groupId: group.groupId, name: typeof group.name === 'string' ? group.name : undefined, responsibility: typeof group.responsibility === 'string' ? group.responsibility : '' })
  }
  await runtime.initializeGroupConfiguration()
}

export async function apply(ctx, config = {}) {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 18998
  if (config.fakeModel === true) installFakeLlm(ctx)
  const store = await openResidentStore(ctx.storageDomain)
  const configuredProxyUrl = store.getProxyUrl?.() ?? config.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? ''
  if (store.getProxyUrl?.() === undefined && configuredProxyUrl) await store.setProxyUrl(configuredProxyUrl)
  applyProxyEnvironment(configuredProxyUrl)
  const runtime = await openResidentRuntime(ctx, store, process.cwd(), {
    agentPreset: config.agentPreset ?? 'standard',
    agentWorkspaceDir: config.agentWorkspaceDir,
    resumeTimeoutMs: config.resumeTimeoutMs ?? 10_000,
    maxConcurrentTasks: config.maxConcurrentTasks ?? 5,
    maxGoalRounds: config.maxGoalRounds ?? 24,
    supervisorIntervalMs: config.supervisorIntervalMs ?? 5_000,
  })
  const updateAgentConfig = runtime.updateAgentConfig
  runtime.updateAgentConfig = async (next) => {
    const result = await updateAgentConfig(next)
    applyProxyEnvironment(result.proxyUrl)
    return result
  }
  await configureResidentGroups(runtime, config.groups)
  for (const migration of config.humanBlockerReplyMigrations ?? []) await runtime.migrateHumanBlockerReply(migration)
  for (const migration of config.taskProvenanceMigrations ?? []) await runtime.migrateTaskProvenance(migration)
  for (const migration of config.taskContinuationMigrations ?? []) await runtime.migrateTaskContinuation(migration)
  const dwsConfig = config.dws ?? {}
  const dwsRunner = createNodeDwsRunner({ executable: dwsConfig.executable ?? 'dws', cwd: tmpdir() })
  const dwsAdapter = createDwsAdapter({
    enabled: dwsConfig.enabled === true,
    writesAuthorized: dwsConfig.writesAuthorized === true,
    profile: dwsConfig.profile,
    runner: dwsRunner,
  })
  const initialEnvironment = await inspectEnvironment({ runner: dwsRunner, profile: dwsConfig.profile })
  runtime.setCurrentDwsUserName(initialEnvironment.dws.user)
  const stopDws = dwsConfig.enabled === true ? startDwsBridge({ runtime, adapter: dwsAdapter, logger: ctx.logger, humanUserId: dwsConfig.humanUserId, currentDwsUserName: initialEnvironment.dws.user, humanPollIntervalMs: dwsConfig.humanPollIntervalMs ?? 30_000 }) : async () => undefined
  runtime.inspectEnvironment = async () => {
    const environment = await inspectEnvironment({ runner: dwsRunner, profile: dwsConfig.profile })
    runtime.setCurrentDwsUserName(environment.dws.user)
    return environment
  }
  runtime.searchGroups = async (query) => {
    if (typeof query !== 'string' || query.trim().length < 2) throw new Error('group_search_query_too_short')
    const result = await dwsRunner.run(['chat', '+chat-search', '--query', query.trim(), '--limit', '20', '--profile', dwsConfig.profile, '--format', 'json'])
    if (result.exitCode !== 0) throw new Error(result.stderr || `dws_group_search_exit_${result.exitCode}`)
    const value = JSON.parse(result.stdout)
    return { complete: value.complete === true, groups: (value.chats ?? []).map((chat) => ({ groupId: chat.openConversationId, name: chat.title ?? chat.name, memberCount: chat.memberCount })) }
  }
  runtime.backfillGroup = async ({ groupId, start, end }) => {
    if (runtime.getGroup(groupId) === undefined) throw new Error(`group_not_subscribed:${groupId}`)
    const history = await dwsAdapter.readGroupRange(groupId, { start, end })
    const ordered = [...history.messages].sort((left, right) => String(left.createTime ?? '').localeCompare(String(right.createTime ?? '')))
    return runtime.backfill(ordered.map((message) => normalizeHistoryMessage(message, groupId)))
  }
  const server = createServer((request, response) => {
    handleRequest(request, response, runtime, {
      testApiEnabled: config.testApiEnabled === true,
      transport: dwsConfig.enabled === true ? 'dws' : 'fake-dws',
      outboundAuthorized: dwsConfig.writesAuthorized === true,
      modelMode: config.fakeModel === true ? 'fake' : 'real',
    }).catch((error) => {
      ctx.logger.warn(error instanceof Error ? error.stack : String(error))
      if (!response.headersSent) response.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': 'http://127.0.0.1:3080',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ...(config.testApiEnabled === true && error instanceof Error ? { stack: error.stack } : {}),
      }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      ctx.logger.info(`DingTalk group assistant listening on http://${host}:${port}`)
      resolve()
    })
  })
  runtime.reconcileCompletedNotifications().catch((error) => ctx.logger.warn(error instanceof Error ? error.stack : String(error)))
  runtime.recoverPendingMessages().catch((error) => ctx.logger.warn(error instanceof Error ? error.stack : String(error)))

  ctx.effect(() => {
    return async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await stopDws()
      await runtime.close()
    }
  })
}
