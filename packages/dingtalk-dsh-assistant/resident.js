import { createServer } from 'node:http'
import { createStartupMetrics } from './startup-metrics.js'
import { applyResidentCorsHeaders, handleRequest, residentErrorStatus } from './http.js'
import { openResidentStore } from './store.js'
import { openTaskResidentRuntime } from './task-resident-runtime.js'
import { installFakeLlm } from './fake-llm.js'
import { createDwsAdapter } from './dws-adapter.js'
import { createNodeDwsRunner } from './dws-runner.js'
import { normalizeHistoryMessage, startDwsBridge } from './dws-bridge.js'
import { inspectEnvironment } from './environment.js'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { tmpdir } from 'node:os'
import { closeExecutionResources } from './resource-close.js'
import { readTaskNotificationDelivery, readOperatorNotificationDelivery, recallOperatorNotification } from './task-notification-readback.js'
import { openTaskSessionService } from './task-session-service.js'
import { sendWorkflowNotification } from './group-message.js'
import { join, resolve } from 'node:path'

export const name = 'dingtalk-dsh-assistant'
export const inject = ['storage', 'storageDomain', 'credentials', 'agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'tools', 'llm', 'systemPrompt', 'attachments']

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

function taskSessionConfiguration(config) {
  const task = config.taskSessions
  for (const field of ['dbPath', 'instanceId', 'ownerActorId', 'webActorId']) {
    if (typeof task?.[field] !== 'string' || !task[field].trim() || task[field].trim().toLowerCase() === 'null')
      throw Object.assign(new Error(`TASK_SESSION_CONFIGURATION_REQUIRED:${field}`), { code: 'TASK_SESSION_CONFIGURATION_REQUIRED' })
  }
  const epoch = task.ingressEpoch
  if (typeof epoch !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(epoch) || !Number.isFinite(Date.parse(epoch))
    || new Date(epoch.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, 'Z')).toISOString().slice(0, 19) !== epoch.slice(0, 19))
    throw Object.assign(new Error('TASK_SESSION_INGRESS_EPOCH_INVALID'), { code: 'TASK_SESSION_INGRESS_EPOCH_INVALID' })
  return { ...task, ingressEpoch: new Date(epoch).toISOString(), initialize: task.initialize === true }
}

export async function apply(ctx, config = {}) {
  const startup = createStartupMetrics(sample => ctx.logger.info(`startup ${JSON.stringify(sample)}`))
  const activationStarted = performance.now()
  if ((config.taskProvenanceMigrations?.length ?? 0) > 0 || (config.taskContinuationMigrations?.length ?? 0) > 0) throw new Error('legacy_task_migrations_removed:use_offline_topic_storage_migration')
  const taskConfig = taskSessionConfiguration(config)
  if (config.humanBlockerReplyMigrations?.length) throw new Error('legacy_authorization_migration_requires_offline_review')
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 18998
  if (config.fakeModel === true) installFakeLlm(ctx)
  // This store retains group configuration and transport history only; task state is owned by taskSessions.
  const store = await startup.measure('resident.transport-store', () => openResidentStore(ctx.storageDomain))
  const configuredProxyUrl = store.getProxyUrl?.() ?? config.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? ''
  if (store.getProxyUrl?.() === undefined && configuredProxyUrl) await store.setProxyUrl(configuredProxyUrl)
  applyProxyEnvironment(configuredProxyUrl)
  const dwsConfig = config.dws ?? {}
  const runtime = await openTaskResidentRuntime(ctx, store, process.cwd(), {
    agentPreset: config.agentPreset ?? 'standard',
    agentWorkspaceDir: config.agentWorkspaceDir,
    agentReplySignature: config.agentReplySignature,
    taskSessionModel: taskConfig,
    coordinationModel: taskConfig.coordination ?? {},
    executionBackend: taskConfig.executionBackend ?? 'dsh',
    resumeTimeoutMs: config.resumeTimeoutMs ?? 10_000,
    maxConcurrentTasks: config.maxConcurrentTasks ?? 5,
    maxGoalRounds: config.maxGoalRounds ?? 24,
    supervisorIntervalMs: config.supervisorIntervalMs ?? 5_000,
    taskSessionMode: true,
  })
  runtime.setCurrentDwsProfile(dwsConfig.profile)
  const updateAgentConfig = runtime.updateAgentConfig
  runtime.updateAgentConfig = async (next) => {
    const result = await updateAgentConfig(next)
    applyProxyEnvironment(result.proxyUrl)
    return result
  }
  await configureResidentGroups(runtime, config.groups)
  const dwsRunner = createNodeDwsRunner({ executable: dwsConfig.executable ?? 'dws', cwd: tmpdir() })
  const dwsAdapter = createDwsAdapter({
    enabled: dwsConfig.enabled === true,
    writesAuthorized: dwsConfig.writesAuthorized === true,
    profile: dwsConfig.profile,
    runner: dwsRunner,
  })
  const initialEnvironment = await startup.measure('resident.environment', () => inspectEnvironment({ runner: dwsRunner, profile: dwsConfig.profile }))
  const readGroupMessage = async (groupId, messageId) => {
    const message = await dwsAdapter.readMessage(groupId, messageId)
    return { ...normalizeHistoryMessage(message, groupId), resourceRefs: message.resourceRefs ?? [] }
  }
  const readGroupResource = async (groupId, messageId, resource) => {
    const value = await dwsAdapter.readMessageResource(groupId, messageId, resource)
    if (!value.image) return value
    const imageRefs = await ctx.attachments.saveImages([value.image])
    return { imageRefs }
  }
  const tasks = await openTaskSessionService({ ctx, config: { ...taskConfig, operatorUserId: initialEnvironment.dws.userId }, legacy: runtime, residentStore: store,
    startupObserver: sample => ctx.logger.info(`startup ${JSON.stringify(sample)}`),
    readMessage: readGroupMessage,
    readMentioned: (groupId, message) => dwsAdapter.isMessageMentioned(groupId, message.messageId, message.occurredAt),
    readResource: (groupId, messageId, resource) => dwsAdapter.readMessageResource(groupId, messageId, resource),
    notifications: {
      canDisclose: notification => dwsConfig.enabled === true && dwsConfig.writesAuthorized === true
        && (notification.payload.audience === 'operator' || !!runtime.getGroup(notification.payload.conversationId)),
      send: notification => notification.payload.audience === 'operator'
        ? dwsAdapter.sendSelfIntent({ userId: notification.payload.recipientUserId, text: notification.payload.text, idempotencyKey: notification.id,
          taskId: notification.taskId, humanRequestId: notification.payload.humanRequestId })
        : sendWorkflowNotification(dwsAdapter, notification),
      recall: notification => recallOperatorNotification(dwsAdapter, notification),
      readback: notification => notification.payload.audience === 'operator'
        ? readOperatorNotificationDelivery(dwsAdapter, notification)
        : readTaskNotificationDelivery(dwsAdapter, notification, { senderActorId: taskConfig.assistantActorId }),
    },
  })
  const transportIssues = runtime.listRecoveryIssues
  runtime.listAlertPage=tasks.listAlertPage
  runtime.listAlerts = tasks.listAlerts
  runtime.listActivities = tasks.listActivities
  runtime.listTaskTimings = tasks.listTaskTimings
  runtime.listPerformance = tasks.listPerformance
  runtime.getActivityAuditStatus = tasks.getActivityAuditStatus
  runtime.listRecoveryIssues = () => [...transportIssues(), ...tasks.listAlerts().map(alert => ({ kind: 'task-session', ...alert, error: alert.detail }))]
  runtime.ingest = tasks.ingest
  runtime.isOwnNotification = tasks.isOwnNotification
  runtime.listObserverGroups = tasks.listObserverGroups
  runtime.observerGroupPage = tasks.observerGroupPage
  runtime.getTopicTasksPage=options=>tasks.boardTasks({...options,archived:'all'})
  runtime.listTaskView = tasks.boardTasks
  runtime.messageProcessingSources = tasks.messageProcessingSources
  runtime.messageProcessingRequests = tasks.messageProcessingRequests
  runtime.getTaskSessionDetail = tasks.taskDetail
  runtime.getTaskSessionIdentity = tasks.taskIdentity
  runtime.getTaskSessionExecutions = tasks.taskExecutions
  runtime.getTaskSessionDecisions = tasks.taskDecisions
  runtime.coordinationSources = tasks.coordinationSources
  runtime.coordinationSourceDetail = tasks.coordinationSourceDetail
  runtime.coordinationWork = tasks.coordinationWork
  runtime.coordinationWorkDetail = tasks.coordinationWorkDetail
  runtime.retireCoordinationObservation = tasks.retireCoordinationObservation
  runtime.createTask = tasks.createTask
  runtime.appendTaskContext = tasks.appendTaskContext
  runtime.reopenTask = tasks.reopenTask
  runtime.getTaskDialogue = tasks.taskDialogue
  runtime.sendTaskDialogue = tasks.sendTaskDialogue
  runtime.cancelTask = tasks.cancelTask
  runtime.archiveTask = tasks.archiveTask
  runtime.listAuthorizationRequests = tasks.listAuthorizationRequests
  runtime.respondTaskHumanRequest = tasks.respondHumanRequest
  runtime.reconcileWebTaskTopics = tasks.reconcileWebTaskTopics
  runtime.respondTaskPrivateHumanReply = tasks.respondPrivateHumanReply
  runtime.retryDecisionFailedMessage = tasks.retryMessageProcessing
  runtime.retryNotification = tasks.retryNotification
  runtime.isTaskSessionMode = () => true
  const recoverTasks = () => tasks.recover().catch(error => ctx.logger.warn(error.message))
  const taskTimer = setInterval(recoverTasks, config.taskSessions?.recoveryIntervalMs ?? 5000)
  taskTimer.unref()
  let server, stopDws = async () => undefined
  // Register disposal before any transport probe or listener can fail during startup.
  ctx.effect(() => async () => {
    clearInterval(taskTimer)
    try {
      await closeExecutionResources([
        ['server', () => server?.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined],
        ['dws', () => stopDws()],
        ['task-sessions', () => tasks.close()], ['runtime', () => runtime.close()],
      ])
    } catch (error) { ctx.logger.error(error); throw error }
  })
  const recoveryStarted = performance.now()
  void tasks.recover().then(() => startup.record('resident.first-recovery', recoveryStarted), error => {
    startup.record('resident.first-recovery', recoveryStarted, 'failed')
    ctx.logger.warn(error.message)
  })
  runtime.setGroupMessageReader(readGroupMessage)
  runtime.setGroupResourceReader(readGroupResource)
  await runtime.recoverInterruptedDecisions()
  let dwsBridgeHealth = dwsConfig.enabled === true ? { healthy: false, groups: [] } : undefined
  const bridgeStarted = performance.now()
  let bridgeReady = false
  stopDws = dwsConfig.enabled === true
    ? startDwsBridge({
      runtime,
      adapter: dwsAdapter,
      logger: ctx.logger,
      humanUserId: dwsConfig.humanUserId,
      currentDwsUserName: initialEnvironment.dws.user,
      humanPollIntervalMs: dwsConfig.humanPollIntervalMs ?? 30_000,
      onHealthChange: (health) => {
        dwsBridgeHealth = health
        if (health.healthy && !bridgeReady) { bridgeReady = true; startup.record('resident.bridge-ready', bridgeStarted) }
      },
    })
    : async () => undefined
  runtime.getDwsBridgeHealth = () => dwsBridgeHealth ?? { healthy: false, groups: [] }
  runtime.inspectEnvironment = async () => {
    const environment = await inspectEnvironment({ runner: dwsRunner, profile: dwsConfig.profile })
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
  server = createServer((request, response) => {
    handleRequest(request, response, runtime, {
      testApiEnabled: config.testApiEnabled === true,
      transport: dwsConfig.enabled === true ? 'dws' : 'fake-dws',
      outboundAuthorized: dwsConfig.writesAuthorized === true,
      modelMode: config.fakeModel === true ? 'fake' : 'real',
    }).catch((error) => {
      ctx.logger.warn(error instanceof Error ? error.stack : String(error))
      applyResidentCorsHeaders(request, response)
      if (!response.headersSent) response.writeHead(residentErrorStatus(error), {
        'content-type': 'application/json; charset=utf-8',
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
  startup.record('resident.listening', activationStarted)
  runtime.recoverInterruptedDecisions().catch((error) => ctx.logger.warn(error instanceof Error ? error.stack : String(error)))


}
