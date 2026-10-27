import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { listPerformance } from './performance.js'
import { normalizeReplySignature } from './group-reply-format.js'
import { taskModelConfig, taskModelSelection } from './task-model-config.js'

const retired = () => { throw Object.assign(new Error('WORKFLOW_RETIRED'), { code: 'WORKFLOW_RETIRED' }) }
const validateExecutionBackend = value => {
  if (!['dsh', 'claude-code'].includes(value)) throw new Error('agent_execution_backend_invalid')
  return value
}
/** Group transport/configuration facade. It has no legacy task scheduler, stage engine or Owner. */
export async function openTaskResidentRuntime(ctx, store, cwd, { agentWorkspaceDir, agentPreset = 'standard', agentReplySignature, maxConcurrentTasks = 5, taskSessionModel = {}, coordinationModel = {}, executionBackend = 'dsh' } = {}) {
  const initialExecutionBackend = validateExecutionBackend(store.getExecutionBackend?.() ?? executionBackend)
  const initialSignature = normalizeReplySignature(store.getReplySignature?.() ?? agentReplySignature)
  const resolveAgentWorkspace = async value => {
    if (typeof value !== 'string') throw new Error('agent_workspace_must_be_absolute')
    const directory = value.trim() || cwd
    if (!isAbsolute(directory)) throw new Error('agent_workspace_must_be_absolute')
    const normalized = resolve(directory)
    if (!(await stat(normalized).catch(() => undefined))?.isDirectory()) throw new Error('agent_workspace_not_directory')
    return normalized
  }
  const root = await resolveAgentWorkspace(store.getAgentWorkspaceDir?.() ?? agentWorkspaceDir ?? '')
  if (store.getAgentWorkspaceDir?.() !== root) await store.setAgentWorkspaceDir(root)
  if (store.getReplySignature?.() === undefined && agentReplySignature !== undefined) await store.setReplySignature(initialSignature)
  const subscribed = new Set(), unsubscribed = new Set(), issues = new Map()
  const listen = listeners => listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const noListener = () => () => {}
  // Keep transport messages (including their cursor timestamps) and configuration, but
  // never expose historical task state to the HTTP board or DWS replay/approval loops.
  const groupView = group => group && ({ ...group, messages: group.messages.filter(message => !api.isOwnNotification?.({ ...message, groupId: group.groupId })), taskReservations: [] })
  let configSaving = false
  let closed = false, profile = '', groupReader, resourceReader
  const selection = () => ctx.agentDefaultModel.currentSelection()
  const taskSelection = () => taskModelConfig(store.getTaskSessionModelConfig?.() ?? taskSessionModel)
  const coordinationSelection = () => taskModelConfig(store.getCoordinationModelConfig?.() ?? coordinationModel)
  const getAgentConfig = () => ({ agentNames: store.getAgentNames?.() ?? [], agentPreset, workspaceDir: store.getAgentWorkspaceDir?.() ?? root, ...selection(),
    taskSessionModel: taskSelection(),
    coordinationModel: coordinationSelection(),
    executionBackend: store.getExecutionBackend?.() ?? initialExecutionBackend,
    replySignature: store.getReplySignature?.() ?? initialSignature,
    proxyUrl: store.getProxyUrl?.() ?? '', maxConcurrentTasks: store.getMaxConcurrentTasks?.() ?? maxConcurrentTasks })
  const api = {
    taskSessionNotifications: true,
    getAgentConfig,
    async getTaskModelOptions({ provider, model }) {
      const providers = ctx.llm.listProviders().map(({ id, name }) => ({ id, name }))
      let models = [], info
      try {
        models = await ctx.llm.listModels(provider || taskSelection().provider)
        if (model) info = await ctx.llm.resolveModelInfo(provider || taskSelection().provider, model)
      } catch {
        return { providers, models: models.map(({ id, name }) => ({ id, name })), reasoning: null, available: false,
          modelError: '模型或提供方不可用，请核对精确模型 ID 或选择其他提供方。' }
      }
      return { providers, models: models.map(({ id, name }) => ({ id, name })), reasoning: info?.reasoning ?? null, available: !!info }
    },
    async updateAgentConfig(input) {
      if (closed) throw new Error('resident_runtime_closed')
      if (configSaving) throw new Error('AGENT_CONFIG_SAVE_BUSY')
      configSaving = true
      try {
        if (['taskPrompts','taskPromptsVersion','leafSessionPrompt','workflowVariables','workflowBindings'].some(key => Object.hasOwn(input,key))) retired()
        const patch = {}
        if (Object.hasOwn(input, 'executionBackend')) patch.executionBackend = validateExecutionBackend(input.executionBackend)
        if (input.workspaceDir !== undefined) {
          patch.agentWorkspaceDir = await resolveAgentWorkspace(input.workspaceDir)
          // Agent cwd may change for future coordination plans. Existing task files,
          // leases and native logs remain rooted at their original durable location.
          patch.taskWorkspaceDir = store.getTaskWorkspaceDir?.() ?? root
        }
        if (input.agentNames !== undefined) {
          if (!Array.isArray(input.agentNames) || input.agentNames.some(name => typeof name !== 'string')) throw new Error('agent_names_must_be_array')
          patch.agentNames = [...new Set(input.agentNames.map(name => name.trim()).filter(Boolean))]
        }
        if (input.replySignature !== undefined) patch.replySignature = normalizeReplySignature(input.replySignature)
        if (input.maxConcurrentTasks !== undefined) {
          if (!Number.isSafeInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 1 || input.maxConcurrentTasks > 50) throw new Error('agent_max_concurrent_tasks_invalid')
          patch.maxConcurrentTasks = input.maxConcurrentTasks
        }
        if (input.proxyUrl !== undefined) {
          if (typeof input.proxyUrl !== 'string' || input.proxyUrl && !/^https?:\/\//i.test(input.proxyUrl)) throw new Error('agent_proxy_url_invalid')
          patch.proxyUrl = input.proxyUrl.trim()
        }
        if (input.taskSessionModel !== undefined) patch.taskSessionModel = taskModelConfig(input.taskSessionModel)
        if (input.coordinationModel !== undefined) patch.coordinationModel = taskModelConfig(input.coordinationModel)
        const old = selection(), changesDefault = input.provider !== undefined || input.model !== undefined || input.reasoningEffort !== undefined
        if (input.model !== undefined && typeof input.model !== 'string') throw new Error('agent_model_required')
        if (input.reasoningEffort !== undefined && typeof input.reasoningEffort !== 'string') throw new Error('agent_reasoning_effort_invalid')
        if (input.provider !== undefined && (typeof input.provider !== 'string' || !input.provider.trim())) throw new Error('agent_provider_required')
        const proposedSelection = { provider: input.provider === undefined ? old.provider : input.provider.trim(), model: input.model === undefined ? old.model : input.model.trim() }
        if (!proposedSelection.model) throw new Error('agent_model_required')
        const effort = input.reasoningEffort === undefined ? old.reasoningEffort : input.reasoningEffort
        if (effort) proposedSelection.reasoningEffort = effort
        // Preflight the complete requested state before either independent store is written.
        if (changesDefault) await ctx.llm.resolveCallConfig(proposedSelection)
        if (patch.taskSessionModel || input.reasoningEffort !== undefined) await ctx.llm.resolveCallConfig(taskModelSelection(proposedSelection, patch.taskSessionModel ?? taskSelection()))
        if (patch.coordinationModel || input.reasoningEffort !== undefined) await ctx.llm.resolveCallConfig(taskModelSelection(proposedSelection, patch.coordinationModel ?? coordinationSelection()))
        try {
          if (changesDefault) await ctx.agentDefaultModel.saveSelection(proposedSelection)
          if (Object.keys(patch).length) await store.setAgentSettings(patch)
          const saved = getAgentConfig()
          const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
          if (changesDefault && (saved.provider !== proposedSelection.provider || saved.model !== proposedSelection.model || (saved.reasoningEffort || '') !== (proposedSelection.reasoningEffort || ''))
            || Object.entries(patch).some(([key,value]) => !equal(key === 'agentWorkspaceDir' ? saved.workspaceDir
              : key === 'taskWorkspaceDir' ? store.getTaskWorkspaceDir?.() : saved[key],value))) throw new Error('AGENT_CONFIG_READBACK_MISMATCH')
          return saved
        } catch (cause) {
          // No blind compensation: native profile and resident storage have no shared transaction.
          let readback
          try { readback = getAgentConfig() } catch {}
          throw Object.assign(new Error('AGENT_CONFIG_SAVE_FAILED'), { cause, readback })
        }
      } finally { configSaving = false }
    },
    hasGroupConfiguration: store.hasGroupConfiguration,
    initializeGroupConfiguration: store.initializeGroupConfiguration,
    getGroup: id => groupView(store.getGroup(id)), listGroups: () => store.listGroups().map(groupView),
    updateGroup: async input => groupView(await store.updateGroup(input)),
    async subscribe(input) {
      if (closed) throw new Error('resident_runtime_closed')
      if (typeof input.groupId !== 'string' || !input.groupId.trim()) throw new Error('group_id_required')
      const saved = await store.subscribe({ ...input, residentSessionId: `group-history-${randomUUID()}` })
      const result = { ...saved, group: groupView(saved.group) }
      if (result.created) for (const listener of subscribed) await listener(result.group)
      return result
    },
    async unsubscribe({ groupId }) {
      const tasks = await api.listTaskView?.() ?? []
      if (tasks.some(task => task.groupId === groupId && !['completed','cancelled'].includes(task.state))) throw new Error('group_has_active_tasks')
      const result = await store.removeGroup({ groupId })
      for (const listener of unsubscribed) await listener({ groupId })
      return result
    },
    onGroupSubscribed: listen(subscribed), onGroupUnsubscribed: listen(unsubscribed),
    onOutboxAppended: noListener, onHumanBlockerRequested: noListener, onAuthorizationDecided: noListener,
    listTasks: () => [], getTask: () => undefined,
    listTopics: store.listTopics, getTopic: store.getTopic, getTopicContext: store.getTopicContext,
    listTaskTimings: () => [], listPerformance: filter => listPerformance(undefined, filter),
    listActivities: () => [], listAlerts: () => [],
    listRecoveryIssues: () => [...issues.values()],
    getActivityAuditStatus: () => ({ total: 0, pending: 0, audited: 0, unavailable: [] }),
    listAuthorizationRequests: () => [], getAuthorizationRequest: () => undefined,
    setCurrentDwsProfile: value => { profile = value }, getCurrentDwsProfile: () => profile,
    setGroupMessageReader: reader => { groupReader = reader }, setGroupResourceReader: reader => { resourceReader = reader },
    readGroupMessage: (groupId, messageId) => groupReader?.(groupId, messageId),
    readGroupResource: (groupId, messageId, resource) => resourceReader?.(groupId, messageId, resource),
    markMessageAgentDelivery: store.markMessageAgentDelivery, markMessagesAgentDelivery: store.markMessagesAgentDelivery,
    async backfill(messages) {
      let accepted = 0
      for (const message of messages) {
        if (!store.getGroup(message.groupId)) continue
        const result = await store.ingest(message)
        if (result.duplicate) continue
        accepted++
        await store.routeMessages({ groupId: message.groupId, routeId: `history:${message.messageId}`, routingRevision: store.getGroup(message.groupId).routingRevision, routes: [{ messageId: message.messageId, messageVersion: result.message?.messageVersion ?? 1, topics: [], reason: '历史背景导入，不执行旧请求' }] })
        await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'skipped' })
      }
      return { accepted, backgroundOnly: true }
    },
    hydrateGroupHistory: async ({ groupId }) => { const group = store.getGroup(groupId); if (!group) throw new Error('group_not_subscribed'); return { historyOnly: true, topics: store.listTopics(groupId), messages: group.messages.length } },
    recoverInterruptedDecisions: async () => [],
    reportCarrierIssue: async issue => { issues.set(issue.fingerprint ?? issue.groupId ?? randomUUID(), { ...issue, kind: 'transport' }) },
    resolveGroupCarrierIssues: async ({ groupId }) => { for (const [key, issue] of issues) if (issue.groupId === groupId) issues.delete(key) },
    // The bridge must never resend an unresolved historical outbox item after cutover.
    prepareOutbound: retired,
    beginOutboundSend: retired, acknowledge: retired, recordOutboundDeliveryAttempt: retired,
    recordOutboundReadbackAttempt: retired, completeOutboundReplacement: retired,
    registerGroupMessageRecaller: noListener,
    isWorkflowGroup: () => false,
    async close() { if (closed) return; closed = true; subscribed.clear(); unsubscribed.clear(); await store.close() },
  }
  return api
}
