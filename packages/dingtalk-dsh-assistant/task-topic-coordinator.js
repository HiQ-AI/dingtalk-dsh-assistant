import { createTopicCoordinator } from './topic-runtime.js'
import { createCoordinationSessions, createCoordinationStepGate, coordinationTools } from './coordination-sessions.js'
import { createCoordinationResourceTools } from './coordination-resources.js'
import { buildReplyReviewCandidates } from './decision.js'
import { sessionWorkspace, nameSession } from './session-workspaces.js'
import { groupReplyInstructions } from './group-message.js'

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const sameStringSet = (a, b) => a.length === b.length && a.every(value => b.includes(value))

// Topic owns routing and decision receipts; this adapter only supplies native request sessions.
export async function openTaskTopicCoordinator({ ctx, store, legacy, root, models, applyAction, appendOutbox, onError = () => {} }) {
  // The original Topic protocol is retained, but retired workflow prompt catalogs
  // must not leak back into the generic task-session boundary.
  store = new Proxy(store, { get(target, key) { return key === 'getTaskPrompts' ? () => [] : key === 'listTasks' ? () => target.listTasks().filter(task => !task.archivedAt) : Reflect.get(target, key) } })
  let closed = false, topics, serial = Promise.resolve()
  const handles = new Set(), dispatches = new Set()
  const report = (groupId, error) => onError(groupId, error)
  const serializeTasks = operation => {
    const result = serial.then(operation)
    serial = result.catch(() => {})
    return result
  }
  const presence = Object.freeze({})
  const sessions = createCoordinationSessions({ eventPrefix: null,
    isCurrent: request => !closed && topics.isCurrentRequest(request),
    onError: error => report(error.coordinationGroupId, error),
    create: async entry => {
      const { request, role, sessionId } = entry
      const agentPreset = legacy.getAgentConfig().agentPreset
      const handle = await ctx.agents.create({ sessionId, seed: [{ type: 'plugin:dingtalk/coordination', seq: 0, time: Date.now(), ignorable: true, data: { groupId: request.groupId, requestId: request.requestId, role } }],
        meta: { cwd: await sessionWorkspace(root, role), origin: 'subagent', delegationDepth: 1, agentPreset },
        agentOptions: typeof models === 'function' ? models() : models,
        setup: async agentCtx => {
          const presets = agentCtx.get('agentPresets')
          if (!presets) throw new Error('agent_presets_required')
          const preset = await presets.mount(agentCtx, agentPreset)
          if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error('coordination_agent_preset_invalid')
          const assert = exec => sessions.assert(exec.agent, request.groupId, request.requestId)
          topics.register(agentCtx, request.groupId, request)
          agentCtx.tools.register({ name: 'group_task_list', description: '分页查询当前群的任务。',
            parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false }, output,
            execute: ({ query = '', offset = 0, limit = 50 }, exec) => {
              assert(exec)
              if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('group_task_page_invalid')
              const needle = query.trim().toLowerCase()
              const tasks = store.listTasks().filter(task => task.groupId === request.groupId && (!needle || `${task.title ?? ''} ${task.objective ?? ''}`.toLowerCase().includes(needle)))
              return { tasks: tasks.slice(offset, offset + limit), total: tasks.length, offset, limit, hasMore: offset + limit < tasks.length }
            } })
          agentCtx.tools.register({ name: 'group_task_context_get', description: '读取当前群任务的完整关联上下文。',
            parameters: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } }, required: ['taskIds'], additionalProperties: false }, output,
            execute: ({ taskIds }, exec) => {
              assert(exec)
              if (!taskIds.length || taskIds.length > 8 || taskIds.some(id => !id.trim()) || new Set(taskIds).size !== taskIds.length) throw new Error('group_task_context_request_invalid')
              return { tasks: taskIds.map(id => {
                const task = store.getTask(id)
                if (!task) throw new Error(`group_task_context_not_found:${id}`)
                if (task.groupId !== request.groupId) throw new Error(`group_task_context_wrong_group:${id}`)
                return task
              }) }
            } })
          for (const tool of createCoordinationResourceTools({ request, assertCurrent: assert,
            readMessage: legacy.readGroupMessage?.bind(legacy) ?? legacy.readMessage?.bind(legacy), readResource: legacy.readGroupResource?.bind(legacy) ?? legacy.readResource?.bind(legacy), readImage: legacy.readImage?.bind(legacy),
          })) agentCtx.tools.register(tool)
          agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, request => topics.isCurrentRequest(request)))
          const allowed = new Set(coordinationTools(role))
          agentCtx.tools.restrict({ allow: [...allowed].filter(name => agentCtx.tools.get(name)) })
          agentCtx.tools.guard(execution => allowed.has(execution.name) ? undefined : 'coordination_tool_outside_role')
          agentCtx.systemPrompt.section({ name: 'dingtalk-group-reply', order: 119, text: groupReplyInstructions })
          agentCtx.systemPrompt.section({ name: 'dingtalk-topic-coordination', order: 120, text: () => {
            const group = store.getGroup(request.groupId)
            return `当前仅处理 ${role} 请求 ${request.requestId}。群职责：${group?.responsibility ?? ''}。收到 [GROUP_TOPIC_ROUTE] 时结合整批原文和已有 Topic，通过 group_topic_route_submit 提交完整归属。归属表示同一讨论目标的延续或实质影响；读取旧资料不构成归属。独立事项可新建 Topic，同一事项追加已有 Topic，多话题归属必须指定唯一 effectOwner。无关噪声可无归属并说明原因。新 title 使用简短对象加事项，不超过30字。收到 [GROUP_TOPIC_DECISION] 后根据固定 Topic 版本及当前增量，通过 group_decision_submit 提交。basisMessageIds 必须包含当前增量原文。已有任务先读取 group_task_list/context；任务动作使用 topicRefs 和当前 inputVersion/runSequence。纯讨论可以 actions:[] 加 reason。routing-required 先完成路由；topic-stale/task-stale 读取当前版本重做判断。accepted 只表示意图持久接受，不表示完成或送达。仅处理原文真实授权，不能把同事间聊天变成交办。当前消息明确指名或提及已配置的 Agent 名称/别名、以 cc: 开头，或者明确确认了此前提出的“是否需要我处理”询问，且属于本群职责并形成可验证目标时，才允许选择 new-task。未明确指名、但判断事项应形成任务时，必须选择 task-proposal，在群里询问“这个事项是否需要我处理？”，暂不创建任务。task-proposal 回复只询问是否交办，不承诺“我会处理”、已开始、已执行或已完成；new-task 的接收确认也不表示执行完成。消息明确 @其他同事且未指向 Agent 时必须忽略，不创建 task-proposal/new-task，也不主动回答；只有后续明确指向 Agent 并直接引用该消息，才视为转交。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。任务目标忠实保留原请求动作范围，不把诊断/观察扩写成修复、实施、发布，不追加未经授权的业务验收。附件只沿本请求明确引用，通过 group_message_get/group_resource_get 读取；读取失败须保留限制，不能猜测正文。`
          } })
        } })
      handles.add(handle)
      const dispose = handle.dispose.bind(handle)
      handle.dispose = async () => { try { await dispose() } finally { handles.delete(handle) } }
      nameSession(ctx, handle.agent.session, role, request.title ?? store.getGroup(request.groupId)?.name)
      const permissions = handle.agent.ctx.get('permissionPresets')
      permissions?.set(handle.agent.session, 'danger-full-access')
      return handle
    },
  })
  function validateReplyReview(review, candidates, { confirmationTaskIds = [] } = {}) {
    if (candidates.length === 0 && review === undefined) return
    if (review === undefined) throw new Error('group_reply_review_required')
    const normalized = {
      ...review,
      reviewedOutboundIds: review.reviewedOutboundIds ?? [],
      sameMatterOutboundIds: review.sameMatterOutboundIds ?? [],
      replaceOutboundIds: review.replaceOutboundIds ?? [],
    }
    for (const [field, ids] of Object.entries({ reviewed: normalized.reviewedOutboundIds, same_matter: normalized.sameMatterOutboundIds, replace: normalized.replaceOutboundIds })) {
      if (new Set(ids).size !== ids.length) throw new Error(`group_reply_review_${field}_duplicate`)
    }
    const candidateIds = candidates.map((candidate) => candidate.outboundId)
    if (!sameStringSet(normalized.reviewedOutboundIds, candidateIds)) throw new Error('group_reply_review_stale')
    const reviewed = new Set(normalized.reviewedOutboundIds)
    if (normalized.sameMatterOutboundIds.some((outboundId) => !reviewed.has(outboundId))) throw new Error('group_reply_review_same_matter_invalid')
    const sameMatter = new Set(normalized.sameMatterOutboundIds)
    if (normalized.replaceOutboundIds.some((outboundId) => !sameMatter.has(outboundId))) throw new Error('group_reply_review_replace_invalid')
    if (normalized.kind === 'substantive' && normalized.replaceOutboundIds.length > 0) throw new Error('group_reply_review_substantive_replace_forbidden')
    if (normalized.kind === 'correction' && normalized.sameMatterOutboundIds.length === 0) throw new Error('group_reply_review_correction_target_required')
    if (normalized.kind !== 'substantive' && !sameStringSet(normalized.replaceOutboundIds, normalized.sameMatterOutboundIds)) throw new Error('group_reply_review_replacement_incomplete')
    if (normalized.kind === 'confirmation' && confirmationTaskIds.length > 0) {
      const taskIds = new Set(confirmationTaskIds)
      const required = candidates.filter((candidate) => candidate.replyKind === 'confirmation' && candidate.taskIds.some((taskId) => taskIds.has(taskId))).map((candidate) => candidate.outboundId)
      if (required.some((outboundId) => !sameMatter.has(outboundId))) throw new Error('group_reply_review_same_task_confirmation_missing')
    }
    return normalized
  }
  topics = createTopicCoordinator({ store,
    getAgent: (groupId, request) => request ? sessions.get(groupId, request) : !closed && store.getGroup(groupId) ? presence : undefined,
    dispatchRequest: (request, message) => {
      const work = sessions.dispatch(request, message)
      dispatches.add(work)
      work.finally(() => dispatches.delete(work)).catch(() => {})
      return work
    },
    waitRequestIdle: request => sessions.whenSettled(request), onRequestFinished: request => sessions.finish(request),
    assertSession: (exec, groupId, request) => sessions.assert(exec.agent, groupId, request?.requestId),
    serializeTasks, applyAction, appendOutbox,
    reviewCandidates: (groupId, currentMessages, focusTaskIds = []) => buildReplyReviewCandidates({ group: store.getGroup(groupId), tasks: store.listTasks().filter(task => task.groupId === groupId), currentMessages, focusTaskIds }),
    validateReplyReview, cancelTask: () => {}, onError: report, isClosing: () => closed,
  })
  return {
    schedule: groupId => topics.schedule(groupId), applyAccepted: (...args) => topics.applyAccepted(...args), recover: () => topics.recover(),
    async retryMessage(groupId, messageId) {
      // 该错误发生在任务写入之前；显式重试仍复用原动作的版本与已应用证据门禁。
      for (const topic of store.getGroup(groupId)?.topics ?? []) for (const record of topic.decisions) {
        const sourceMissing = record.error === 'TASK_TOPIC_SOURCE_VERSION_MISSING'
        const projectedReply = record.error === 'outbox_identity_duplicate' && record.failureOperationId === record.outboundId
          && record.operations.every(operation => operation.status === 'applied')
        if (record.status !== 'blocked' || !sourceMissing && !projectedReply || !record.decision.basisMessageIds.includes(messageId)) continue
        await topics.retryOperation({ groupId, topicId: topic.topicId, decisionId: record.decisionId,
          operationId: record.failureOperationId, resolution: projectedReply ? 'applied' : 'not-applied', reason: '显式重试原消息：重新核验准入来源、原动作版本及原回复身份' })
      }
      return topics.retryMessage(groupId, messageId)
    },
    async whenIdle() {
      await topics.drain()
      while (handles.size || dispatches.size) {
        await Promise.allSettled([...dispatches])
        await Promise.all([...handles].map(handle => handle.agent.whenIdle()))
        await topics.drain()
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await serial
    },
    async close() { closed = true; await topics.close(); await sessions.close(); await serial },
  }
}
