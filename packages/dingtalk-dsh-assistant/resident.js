import { createServer } from 'node:http'
import { applyResidentCorsHeaders, handleRequest, residentErrorStatus } from './http.js'
import { openResidentStore } from './store.js'
import { openResidentRuntime } from './runtime.js'
import { installFakeLlm } from './fake-llm.js'
import { createDwsAdapter } from './dws-adapter.js'
import { createNodeDwsRunner } from './dws-runner.js'
import { normalizeHistoryMessage, startDwsBridge } from './dws-bridge.js'
import { inspectEnvironment } from './environment.js'
import { createTaskSheetSyncService } from './task-sheet-sync.js'
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { tmpdir } from 'node:os'
import { openExecutionStore } from './execution-store.js'
import { openWorkflowService } from './workflow-service.js'
import { createTrustedWorkflowPlatforms } from './workflow-trusted-platforms.js'
import { notificationOpenTaskId, sameDeliveredText, sendWorkflowNotification } from './workflow-notifications.js'
import { readWorkflowSeal, workflowSealPath, inspectLegacyDrain } from './workflow-cutover.js'
import { join, resolve } from 'node:path'

export const name = 'dingtalk-dsh-assistant'
export const inject = ['storage', 'storageDomain', 'agents', 'agentDefaultModel', 'agentPresets', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionProjections', 'tools', 'subagents', 'goals', 'llm', 'systemPrompt', 'attachments', 'dingtalkTaskWorkflowPlatformClients']

export async function verifyResidentWorkflowSeal(ctx, workflowConfig) {
  const domain = ctx.storageDomain
  const backendName = domain.config?.routes?.dingtalk_dsh_assistant ?? domain.config?.backend
  const backend = ctx.storage?.backend.get(backendName)
  if (!backend?.root) throw new Error('workflow_seal_storage_path_unavailable')
  const sealPath = workflowSealPath(join(resolve(backend.root), 'dingtalk_dsh_assistant.json'))
  const seal = await readWorkflowSeal({ sealPath })
  if (seal) {
    if (!workflowConfig || seal.groupIds.some(id => !workflowConfig.groupIds?.includes(id))) throw new Error('workflow_sealed_group_configuration_required')
    if (resolve(workflowConfig.dbPath) !== resolve(seal.dbPath) || workflowConfig.instanceId !== seal.instanceId) throw new Error('workflow_seal_instance_mismatch')
    if (seal.phase !== 'active') throw new Error('workflow_cutover_requires_offline_resume')
  }
  if (workflowConfig && (!seal || workflowConfig.groupIds.some(id => !seal.groupIds.includes(id)))) throw new Error('workflow_group_seal_required')
  return { seal, sealPath }
}

export async function verifyWorkflowActivation(store, control, groupIds) {
  for (const groupId of groupIds) {
    const state = await control.query({ kind: 'message.group', conversationId: groupId })
    if (state?.state !== 'active' || state.engine !== 'workflow' || !state.legacySealRef) throw new Error(`workflow_group_not_activated:${groupId}`)
    const group = store.getGroup(groupId)
    if (!group) throw new Error(`workflow_group_not_subscribed:${groupId}`)
    const report = inspectLegacyDrain({ unit: { name: 'dingtalk_dsh_assistant', version: 9 }, tables: {
      groups: { [groupId]: { ...group, groupId } },
      tasks: Object.fromEntries(store.listTasks().map((task, index) => [task.taskId ?? index, task])),
    } }, [groupId])
    if (!report.ready) throw Object.assign(new Error(`workflow_legacy_not_drained:${groupId}`), { details: report.issues })
  }
}

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
  if ((config.taskProvenanceMigrations?.length ?? 0) > 0 || (config.taskContinuationMigrations?.length ?? 0) > 0) throw new Error('legacy_task_migrations_removed:use_offline_topic_storage_migration')
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 18998
  if (config.fakeModel === true) installFakeLlm(ctx)
  const { seal, sealPath } = await verifyResidentWorkflowSeal(ctx, config.workflow)
  const store = await openResidentStore(ctx.storageDomain)
  const workflowConfig = config.workflow
  if (workflowConfig) {
    if (!Array.isArray(workflowConfig.groupIds) || !workflowConfig.groupIds.length || !workflowConfig.ownerActorId || !workflowConfig.artifactDirectory) throw new Error('workflow_configuration_incomplete')
    const control = await openExecutionStore({ dbPath: workflowConfig.dbPath, instanceId: workflowConfig.instanceId })
    try {
      await verifyWorkflowActivation(store, control, workflowConfig.groupIds)
      for (const groupId of workflowConfig.groupIds) {
        const group = await control.query({ kind: 'message.group', conversationId: groupId })
        if (group.legacySealRef !== seal.sealRef) throw new Error('workflow_group_seal_mismatch')
      }
    } finally { await control.close() }
  }
  const configuredProxyUrl = store.getProxyUrl?.() ?? config.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? ''
  if (store.getProxyUrl?.() === undefined && configuredProxyUrl) await store.setProxyUrl(configuredProxyUrl)
  applyProxyEnvironment(configuredProxyUrl)
  const dwsConfig = config.dws ?? {}
  const runtime = await openResidentRuntime(ctx, store, process.cwd(), {
    agentPreset: config.agentPreset ?? 'standard',
    agentWorkspaceDir: config.agentWorkspaceDir,
    resumeTimeoutMs: config.resumeTimeoutMs ?? 10_000,
    maxConcurrentTasks: config.maxConcurrentTasks ?? 5,
    maxGoalRounds: config.maxGoalRounds ?? 24,
    supervisorIntervalMs: config.supervisorIntervalMs ?? 5_000,
    workflowGroupIds: workflowConfig?.groupIds ?? [],
  })
  runtime.setCurrentDwsProfile(dwsConfig.profile)
  const updateAgentConfig = runtime.updateAgentConfig
  runtime.updateAgentConfig = async (next) => {
    const result = await updateAgentConfig(next)
    applyProxyEnvironment(result.proxyUrl)
    return result
  }
  await configureResidentGroups(runtime, config.groups)
  for (const migration of config.humanBlockerReplyMigrations ?? []) await runtime.migrateHumanBlockerReply(migration)
  const dwsRunner = createNodeDwsRunner({ executable: dwsConfig.executable ?? 'dws', cwd: tmpdir() })
  const taskSheetSync = createTaskSheetSyncService({ store, runner: dwsRunner, profile: dwsConfig.profile, logger: ctx.logger })
  runtime.getTaskSheetSyncState = taskSheetSync.getState
  runtime.inspectTaskSheet = ({ documentUrl }) => taskSheetSync.inspect(documentUrl)
  runtime.updateTaskSheetSyncConfig = taskSheetSync.updateConfig
  runtime.runTaskSheetSync = () => taskSheetSync.run('manual')
  const dwsAdapter = createDwsAdapter({
    enabled: dwsConfig.enabled === true,
    writesAuthorized: dwsConfig.writesAuthorized === true,
    profile: dwsConfig.profile,
    runner: dwsRunner,
  })
  const trustedPlatforms = workflowConfig?.platforms ? createTrustedWorkflowPlatforms({
    config: workflowConfig.platforms, clients: ctx.get?.('dingtalkTaskWorkflowPlatformClients'),
    ownerActorId: workflowConfig.ownerActorId,
  }) : null
  const workflow = workflowConfig ? await openWorkflowService({ ctx, config: { ...workflowConfig, profile: dwsConfig.profile }, legacy: runtime,
    external: workflowConfig.platforms ? trustedPlatforms : ctx.get?.('dingtalkTaskWorkflowExternal'),
    generalCapabilities: ctx.get?.('dingtalkTaskGeneralCapabilities') ?? [],
    generalCompletionCheck: ctx.get?.('dingtalkTaskGeneralCompletionCheck'),
    generalCompletionIdentity: ctx.get?.('dingtalkTaskGeneralCompletionIdentity'),
    readMessage: (groupId, messageId) => dwsAdapter.readMessage(groupId, messageId),
    readResource: (groupId, messageId, resource) => dwsAdapter.readMessageResource(groupId, messageId, resource),
    notifications: {
      canDisclose: async notification => workflowConfig.groupIds.includes(notification.payload.conversationId) && notification.disclosure.conversationId === notification.payload.conversationId,
      send: notification => sendWorkflowNotification(dwsAdapter, notification),
      recall: async ({ messageId }) => dwsAdapter.recallMessage(messageId),
      readbackRecall: async ({ conversationId, messageId, ack }) => {
        if ((ack?.recallStatus ?? ack?.result?.recallStatus) !== 'SUCCESS') return undefined
        const now = new Date()
        const local = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
        const start = local(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
        const end = local(new Date(now.getTime() + 60 * 60 * 1000))
        const messages = await dwsAdapter.readConversation(conversationId, { start, end })
        if (messages.some(item => item.messageId === messageId)) return undefined
        return { messageId, conversationId, recallStatus: 'SUCCESS', observedAt: now.toISOString(), queryStart: start, queryEnd: end, ack }
      },
      readback: async notification => {
        const ack = notification.ack
        let messageId = ack?.messageId ?? ack?.result?.messageId
        const openTaskId = notificationOpenTaskId(ack)
        if (!messageId && openTaskId) {
          const result = await dwsRunner.run(dwsAdapter.compileSendStatus(openTaskId))
          if (result.exitCode !== 0) return undefined
          const status = JSON.parse(result.stdout)
          const conversationId = status.messageRef?.openConversationId ?? status.result?.openConversationId
          if (status.result?.sendStatus !== 'SUCCESS' || conversationId !== notification.payload.conversationId) return undefined
          messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
        }
        if (!messageId) return undefined
        const observed = await dwsAdapter.readMessage(notification.payload.conversationId, messageId)
        if (!sameDeliveredText(observed.text, notification.payload.text, !!notification.payload.sourceMessageId) || (observed.conversationId && observed.conversationId !== notification.payload.conversationId)) return undefined
        return { messageId, conversationId: notification.payload.conversationId, observedAt: new Date().toISOString() }
      },
    },
  }) : null
  if (workflow) {
    const legacyIngest = runtime.ingest
    runtime.ingest = async message => {
      const currentSeal = await readWorkflowSeal({ sealPath, conversationId: message.groupId })
      if (currentSeal?.blockLegacy && !workflow.isGroup(message.groupId)) throw new Error('workflow_sealed_group_legacy_ingest_forbidden')
      return workflow.isGroup(message.groupId) ? workflow.ingest(message) : legacyIngest(message)
    }
    runtime.listTaskView = async () => [...runtime.listTasks(), ...await workflow.tasks()]
    runtime.getWorkflowState = runId => workflow.state(runId)
    runtime.reprocessWorkflowMessage = runId => {
      if (!workflowConfig.webActorId) throw new Error('workflow_web_actor_not_configured')
      return workflow.reprocessMessage(runId, { channel: 'web', actorId: workflowConfig.webActorId })
    }
    runtime.getWorkflowMailboxes = () => workflow.mailboxes()
    runtime.prepareWorkflowNotificationOperation = args => workflow.prepareWorkflowNotificationOperation(args)
    runtime.executeWorkflowNotificationOperation = args => workflow.executeWorkflowNotificationOperation(args)
    runtime.reconcileWorkflowNotificationOperation = args => workflow.reconcileWorkflowNotificationOperation(args)
    runtime.listWorkflowTopics = groupId => workflow.topics(groupId)
    runtime.getWorkflowTopicContext = args => workflow.topicContext(args)
    runtime.getWorkflowCatalog = () => workflow.catalog()
    runtime.isWorkflowTask = taskId => workflow.isTask(taskId)
    runtime.submitWorkflowTask = args => {
      if (!workflowConfig.webActorId) throw new Error('WORKFLOW_WEB_ACTOR_FORBIDDEN')
      return workflow.submitWebTask(args, { channel: 'web', actorId: workflowConfig.webActorId })
    }
    runtime.resumeWorkflowRequest = args => {
      if (!workflowConfig.webActorId) throw new Error('workflow_web_actor_not_configured')
      return workflow.resumeRequest(args, { channel: 'web', actorId: workflowConfig.webActorId })
    }
    const legacyDecideAuthorization = runtime.decideAuthorization
    runtime.decideAuthorization = async args => {
      if (!await workflow.isApprovalRequest(args.requestId)) return legacyDecideAuthorization(args)
      if (!workflowConfig.webActorId) throw new Error('WORKFLOW_WEB_ACTOR_FORBIDDEN')
      return workflow.decideApproval({ requestId: args.requestId, decision: args.decision,
        eventId: `web:${args.requestId}:${args.decision}` }, { channel: 'web', actorId: workflowConfig.webActorId })
    }
    const legacyListAuthorizations = runtime.listAuthorizationRequests
    runtime.listAuthorizationRequests = async () => [...legacyListAuthorizations(), ...await workflow.listApprovalRequests()]
    const legacyCreateTask = runtime.createTask
    runtime.createTask = args => workflow.isGroup(args.groupId) ? Promise.reject(new Error('workflow_group_use_message_input')) : legacyCreateTask(args)
    const taskFailures = await workflow.recoverExecutionTasks()
    for (const failure of taskFailures) ctx.logger.warn(`workflow recovery ${failure.scope}: ${failure.code}${failure.runId ? ` (${failure.runId})` : ''}`)
  }
  const recoverWorkflow = () => workflow.recover().then(result => {
    for (const failure of result.failures) ctx.logger.warn(`workflow recovery ${failure.scope}: ${failure.code}${failure.runId ? ` (${failure.runId})` : ''}`)
  }).catch(error => ctx.logger.warn(error.message))
  if (workflow) void recoverWorkflow()
  const workflowTimer = workflow ? setInterval(recoverWorkflow, 5000) : null
  workflowTimer?.unref()
  runtime.setGroupMessageReader(async (groupId, messageId) => {
    const message = await dwsAdapter.readMessage(groupId, messageId)
    return { ...normalizeHistoryMessage(message, groupId), resourceRefs: message.resourceRefs ?? [] }
  })
  runtime.setGroupResourceReader(async (groupId, messageId, resource) => {
    const value = await dwsAdapter.readMessageResource(groupId, messageId, resource)
    if (!value.image) return value
    const imageRefs = await ctx.attachments.saveImages([value.image])
    return { imageRefs }
  })
  await runtime.recoverInterruptedDecisions()
  const initialEnvironment = await inspectEnvironment({ runner: dwsRunner, profile: dwsConfig.profile })
  let dwsBridgeHealth = dwsConfig.enabled === true ? { healthy: false, groups: [] } : undefined
  const stopDws = dwsConfig.enabled === true
    ? startDwsBridge({
      runtime,
      adapter: dwsAdapter,
      logger: ctx.logger,
      humanUserId: dwsConfig.humanUserId,
      currentDwsUserName: initialEnvironment.dws.user,
      humanPollIntervalMs: dwsConfig.humanPollIntervalMs ?? 30_000,
      onHealthChange: (health) => { dwsBridgeHealth = health },
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
  const server = createServer((request, response) => {
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
  runtime.reconcileCompletedNotifications().catch((error) => ctx.logger.warn(error instanceof Error ? error.stack : String(error)))
  runtime.recoverInterruptedDecisions().catch((error) => ctx.logger.warn(error instanceof Error ? error.stack : String(error)))
  taskSheetSync.schedule()

  ctx.effect(() => {
    return async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await taskSheetSync.close()
      await stopDws()
      if (workflowTimer) clearInterval(workflowTimer)
      await workflow?.close()
      await runtime.close()
    }
  })
}
