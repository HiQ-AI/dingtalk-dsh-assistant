import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { listPerformance } from './performance.js'

const retired = () => { throw Object.assign(new Error('WORKFLOW_RETIRED'), { code: 'WORKFLOW_RETIRED' }) }
/** Group transport/configuration facade. It has no legacy task scheduler, stage engine or Owner. */
export async function openTaskResidentRuntime(ctx, store, cwd, { agentWorkspaceDir, agentPreset = 'standard', maxConcurrentTasks = 5 } = {}) {
  const root = resolve(store.getAgentWorkspaceDir?.() ?? agentWorkspaceDir ?? cwd)
  if (!isAbsolute(root) || !(await stat(root)).isDirectory()) throw new Error('agent_workspace_not_directory')
  if (store.getAgentWorkspaceDir?.() !== root) await store.setAgentWorkspaceDir(root)
  const subscribed = new Set(), unsubscribed = new Set(), issues = new Map()
  const listen = listeners => listener => { listeners.add(listener); return () => listeners.delete(listener) }
  const noListener = () => () => {}
  // Keep transport messages (including their cursor timestamps) and configuration, but
  // never expose historical task state to the HTTP board or DWS replay/approval loops.
  const groupView = group => group && ({ ...group, messages: group.messages.filter(message => !api.isOwnNotification?.({ ...message, groupId: group.groupId })), taskReservations: [] })
  let closed = false, profile = '', groupReader, resourceReader
  const selection = () => ctx.agentDefaultModel.currentSelection()
  const getAgentConfig = () => ({ agentNames: store.getAgentNames?.() ?? [], agentPreset, workspaceDir: root, ...selection(),
    proxyUrl: store.getProxyUrl?.() ?? '', maxConcurrentTasks: store.getMaxConcurrentTasks?.() ?? maxConcurrentTasks })
  const api = {
    taskSessionNotifications: true,
    getAgentConfig,
    async updateAgentConfig(input) {
      if (closed) throw new Error('resident_runtime_closed')
      if (Object.hasOwn(input, 'replySignature')) throw new Error('agent_reply_signature_removed')
      if (['taskPrompts','taskPromptsVersion','leafSessionPrompt','workflowVariables','workflowBindings'].some(key => Object.hasOwn(input,key))) retired()
      if (input.workspaceDir !== undefined && resolve(input.workspaceDir) !== root) throw new Error('task_workspace_change_requires_offline_migration')
      if (input.agentNames !== undefined) {
        if (!Array.isArray(input.agentNames) || input.agentNames.some(name => typeof name !== 'string')) throw new Error('agent_names_must_be_array')
        await store.setAgentNames([...new Set(input.agentNames.map(name => name.trim()).filter(Boolean))])
      }
      if (input.maxConcurrentTasks !== undefined) {
        if (!Number.isSafeInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 1 || input.maxConcurrentTasks > 50) throw new Error('agent_max_concurrent_tasks_invalid')
        await store.setMaxConcurrentTasks(input.maxConcurrentTasks)
      }
      if (input.proxyUrl !== undefined) {
        if (typeof input.proxyUrl !== 'string' || input.proxyUrl && !/^https?:\/\//i.test(input.proxyUrl)) throw new Error('agent_proxy_url_invalid')
        await store.setProxyUrl(input.proxyUrl.trim())
      }
      if (input.model !== undefined || input.reasoningEffort !== undefined) {
        const old = selection(), model = input.model === undefined ? old.model : input.model.trim()
        if (!model) throw new Error('agent_model_required')
        const next = { provider: old.provider, model }
        const effort = input.reasoningEffort === undefined ? old.reasoningEffort : input.reasoningEffort
        if (effort) next.reasoningEffort = effort
        await ctx.agentDefaultModel.saveSelection(next)
      }
      return getAgentConfig()
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
