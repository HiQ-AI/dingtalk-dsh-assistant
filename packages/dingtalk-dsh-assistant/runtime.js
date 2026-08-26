import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { buildDecisionPrompt, isExplicitAgentDirection, parseGroupDecision, shouldRecheckTaskAssociation } from './decision.js'
import { parseTaskResult } from './task-result.js'

const PROJECTED_EVENTS = new Set(['assistant/message', 'tool/call', 'tool/result', 'turn/end', 'goal/change'])
const SessionId = (id) => id
const createUserMessage = (input) => Object.freeze({ ...structuredClone(input), id: randomUUID(), role: 'user' })
const leafDisplayName = (objective) => {
  const normalized = objective.trim().replace(/\s+/gu, ' ')
  const heading = normalized.split(/[：:；;]/u, 1)[0] || normalized
  return heading.length <= 20 ? heading : `${heading.slice(0, 19)}…`
}
const installModelSelection = (agentCtx, selection) => {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return { ...withoutInheritedEffort, provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
  })
  return () => { disposeAssembly(); disposeRequest() }
}
export const residentSessionId = (groupId) => `session-group-${createHash('sha256').update(groupId).digest('hex').slice(0, 24)}`
const goalRef = (goal) => ({ id: goal.id, revision: goal.revision })
const normalizeApprovalScope = (value) => value.trim().replace(/\s+/gu, ' ')
const humanBlockerFingerprint = (category, requestedAction) => createHash('sha256')
  .update(JSON.stringify({ category, requestedAction: normalizeApprovalScope(requestedAction) }))
  .digest('hex')
const withHumanBlockerHistory = (task, blocker) => {
  const history = task.humanBlockerHistory ?? []
  const index = history.findIndex((item) => item.requestId === blocker.requestId)
  return index < 0 ? [...history, blocker] : history.map((item, current) => current === index ? blocker : item)
}
const activityDetail = (event) => {
  if (event.type === 'tool/call') return { tool: event.data?.name ?? 'unknown' }
  if (event.type === 'tool/result') return { tool: event.data?.name ?? 'unknown', isError: event.data?.isError === true }
  if (event.type === 'turn/end') return { status: event.data?.status ?? 'unknown' }
  if (event.type === 'goal/change') return { phase: event.data?.goal?.phase ?? event.data?.phase ?? 'unknown' }
  return { contentBlocks: event.data?.message?.content?.length ?? 0 }
}

export async function openResidentRuntime(ctx, store, cwd, { agentWorkspaceDir, resumeTimeoutMs = 10_000, maxConcurrentTasks = 5, maxGoalRounds = 24, supervisorIntervalMs = 5_000 } = {}) {
  const residentHandles = new Map(), leafHandles = new Map(), leafTaskBySession = new Map(), pausedRecoveryCounts = new Map(), resultRecoveryCounts = new Map(), tails = new Map()
  const agentPresets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  const attachments = ctx.get?.('attachments') ?? ctx.attachments
  const recoveryIssues = [], subscriptionListeners = new Set(), unsubscriptionListeners = new Set(), outboxListeners = new Set(), humanBlockerListeners = new Set(), authorizationDecisionListeners = new Set(), bufferedOutboxEvents = []
  let taskTail = Promise.resolve(), activityTail = Promise.resolve(), supervisorTimer, currentDwsUserName = ''
  let taskConcurrencyLimit = store.getMaxConcurrentTasks?.() ?? maxConcurrentTasks
  if (store.getMaxConcurrentTasks?.() === undefined) await store.setMaxConcurrentTasks?.(taskConcurrencyLimit)
  const selection = ctx.agentDefaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const installSelection = (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const applyFullAccess = (handle) => {
    const permissionPresets = agentPresets?.serviceFor?.(handle.agent, 'permissionPresets')
      ?? handle.agent.ctx?.get?.('permissionPresets')
      ?? handle.agent.ctx?.permissionPresets
    if (permissionPresets === undefined) throw new Error('permission_presets_required')
    permissionPresets.set(handle.agent.session, 'danger-full-access')
  }
  const ensureLeafDescriptor = (handle, task) => {
    const ownEvents = handle.agent.session.events.slice(handle.agent.session.meta?.seedLength ?? 0)
    if (ownEvents.some((event) => event.type === 'subagent/descriptor')) return
    handle.agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'dingtalk-dsh-assistant',
      label: leafDisplayName(task.objective),
      agentProvider: agentOptions.provider,
      agentModel: agentOptions.model,
    }))
  }
  const residentSetup = (groupId) => async (agentCtx) => {
    if (agentPresets === undefined) throw new Error('agent_presets_required')
    const preset = await agentPresets.mount(agentCtx, 'standard')
    if (preset?.id !== undefined && preset.id !== 'standard') throw new Error(`resident_agent_preset_invalid:${preset.id}`)
    installSelection(agentCtx)
    registerResidentTaskTools(agentCtx, groupId)
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-responsibility', order: 40,
      text: () => {
        const group = store.getGroup(groupId)
        return `## 钉钉群聊常驻会话\n\n- 群名称：${group?.name || '未设置'}\n- 群 ID：${groupId}\n\n### 会话职责\n\n${group?.responsibility || '未设置职责。仅保留上下文，不主动承接任务。'}`
      },
    })
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-task-index', order: 42,
      text: () => {
        const active = store.listTasks().filter((task) => task.groupId === groupId)
          .map((task) => ({ taskId: task.taskId, objective: task.objective, state: task.state, archived: Boolean(task.archivedAt) }))
        return `## 本群全部任务关联索引\n\n${active.length === 0 ? '无。' : JSON.stringify(active)}`
      },
    })
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-decision-protocol', order: 41,
      text: () => `## 群消息决策协议

收到以 \`[GROUP_DECISION]\` 开头的群消息信封时，只输出一个严格 JSON 对象：
- 回答：\`{"kind":"answer","reply":"..."}\`
- 新任务：\`{"kind":"new-task","objective":"...","reply":"..."}\`
- 补充任务：\`{"kind":"task-context","taskId":"...","context":"...","reply":"..."}\`；只需静默补充上下文、不需要回复群聊时，\`reply\` 使用空字符串
- 重开任务：\`{"kind":"task-reopen","taskId":"...","context":"...","reply":"..."}\`；只需静默重开任务、不需要回复群聊时，\`reply\` 使用空字符串
- 忽略：\`{"kind":"ignore","reason":"..."}\`

只有当前消息明确指名或提及已配置的 Agent 名称/别名${currentDwsUserName ? `，或明确指名当前 DWS 登录人“${currentDwsUserName}”` : ''}，或以 \`cc:\` 开头，并且事项属于本群职责且形成可验证的执行或持续跟踪目标时，才允许选择新任务。职责相关但未明确指名时可以回答，不得创建任务。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。

任务目标必须忠实保留消息中的动作范围，不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务。诊断任务的完成条件只能是核验现状、定位根因、给出证据与建议；只有消息明确要求修复、修改、处理问题或实施方案时，new-task 的 objective 才能包含变更动作。是否明确指名只决定能否建 Task，不构成扩大任务授权。

消息附带的图片属于当前消息正文，必须先阅读图片，再结合固定主会话中的前后消息和“本群全部任务关联索引”判断关联性。queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断；任务状态只决定关联后的动作，不得成为忽略关联的理由。不得仅因文字部分没有指名、图片没有文字摘要或后续消息较短就选择忽略；紧邻图片的补充说明应优先与该图片共同理解。群友对根因、状态或外部因素的未经核验判断，只要与已有任务相关，就是需要核验的新增线索，不得以“尚未核验”为由忽略。已存在任务的新增事实应优先关联已有任务，而不是创建重复任务。对已完成任务的结果提出回滚、撤回、还原、纠正或补做，属于原任务的结果纠正，必须返回 task-reopen 唤起原 Task，不得只做自然语言承诺，也不得创建新 Task；只有与原目标不同的独立可执行目标才创建新任务并保留历史关联。

上述 JSON 协议仅用于 \`[GROUP_DECISION]\` 群消息信封，此时不得调用任务工具。用户在 Web 主会话中直接要求创建、续接或查询任务时，使用本会话提供的 DSH 原生任务工具；主会话只负责沟通协调，实际执行由 Runtime 创建的独立叶子会话完成。`,
    })
  }
  const serialize = (key, operation) => {
    const current = (tails.get(key) ?? Promise.resolve()).then(operation, operation)
    tails.set(key, current)
    const cleanup = () => { if (tails.get(key) === current) tails.delete(key) }
    current.then(cleanup, cleanup)
    return current
  }
  const serializeTasks = (operation) => {
    const current = taskTail.then(operation, operation)
    taskTail = current.catch(() => undefined)
    return current
  }
  function assertResidentToolSession(exec, groupId) {
    const expected = residentHandles.get(groupId)?.agent?.session?.id
    if (expected === undefined || String(exec.agent?.session?.id) !== String(expected)) throw new Error(`resident_tool_wrong_session:${groupId}`)
  }
  function registerResidentTaskTools(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_task_create',
      description: 'Create a durable group task and let the DSH Runtime start an independent leaf Session. Use only for an explicit Web-user direction within this group responsibility.',
      parameters: { type: 'object', additionalProperties: false, properties: { objective: { type: 'string' }, sourceMessageId: { type: 'string' } }, required: ['objective'] },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          created: { type: 'boolean' }, taskId: { type: 'string' }, state: { type: 'string' }, childSessionId: { type: 'string' },
        }, required: ['created', 'taskId', 'state', 'childSessionId'] },
        render: (_args, out) => [{ type: 'text', text: `群任务${out.created ? '已创建' : '已存在'}：${out.taskId}（${out.state}）` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        const objective = args.objective.trim()
        if (objective === '') throw new Error('task_objective_required')
        const source = typeof args.sourceMessageId === 'string' ? store.getGroup(groupId)?.messages.find((message) => message.messageId === args.sourceMessageId) : undefined
        if (args.sourceMessageId !== undefined && source === undefined) throw new Error(`task_source_message_not_found:${args.sourceMessageId}`)
        const sourceMessageId = source?.messageId ?? `web:${createHash('sha256').update(`${groupId}\n${objective}`).digest('hex')}`
        const result = await serializeTasks(async () => {
          const created = await store.createTask({ groupId, sourceMessageId, objective, requesterName: source?.senderName, requesterOpenDingTalkId: source?.senderOpenDingTalkId })
          await pumpTasks()
          return { created: created.created, task: store.getTask(created.task.taskId) }
        })
        return { created: result.created, taskId: result.task.taskId, state: result.task.state, childSessionId: result.task.childSessionId }
      },
    })
    agentCtx.tools.register({
      name: 'group_task_context_append',
      description: 'Append new context to an active task belonging to this resident group Session.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, context: { type: 'string' } }, required: ['taskId', 'context'] },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', const: true }, taskId: { type: 'string' }, state: { type: 'string' } }, required: ['accepted', 'taskId', 'state'] },
        render: (_args, out) => [{ type: 'text', text: `任务上下文已补充：${out.taskId}` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        const context = args.context.trim()
        if (context === '') throw new Error('task_context_required')
        return serializeTasks(async () => {
          let task = store.getTask(args.taskId)
          if (task === undefined || task.groupId !== groupId) throw new Error(`task_context_target_invalid:${args.taskId}`)
          task = await appendTaskContextInternal(task, context)
          return { accepted: true, taskId: task.taskId, state: task.state }
        })
      },
    })
    agentCtx.tools.register({
      name: 'group_task_reopen',
      description: 'Reopen a completed task in this resident group, restore its original leaf Session and Goal, and append a correction, rollback, or follow-up execution instruction.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, context: { type: 'string' } }, required: ['taskId', 'context'] },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', const: true }, taskId: { type: 'string' }, state: { type: 'string' } }, required: ['accepted', 'taskId', 'state'] },
        render: (_args, out) => [{ type: 'text', text: `已重新打开原任务：${out.taskId}（${out.state}）` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        const context = args.context.trim()
        if (context === '') throw new Error('task_reopen_context_required')
        return serializeTasks(async () => {
          const task = store.getTask(args.taskId)
          if (task === undefined || task.groupId !== groupId) throw new Error(`task_reopen_target_invalid:${args.taskId}`)
          const reopened = await reopenCompletedTaskInternal(task, context)
          return { accepted: true, taskId: reopened.taskId, state: reopened.state }
        })
      },
    })
    agentCtx.tools.register({
      name: 'group_task_list',
      description: 'List durable tasks belonging to this resident group Session.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          taskId: { type: 'string' }, objective: { type: 'string' }, state: { type: 'string' }, childSessionId: { type: 'string' },
          waitingReason: { type: 'string' }, completion: { type: 'string' },
        }, required: ['taskId', 'objective', 'state', 'childSessionId'] } } }, required: ['tasks'] },
        render: (_args, out) => [{ type: 'text', text: out.tasks.length === 0 ? '本群暂无任务。' : out.tasks.map((task) => `${task.taskId}｜${task.state}｜${task.objective}`).join('\n') }],
      },
      execute: async (_args, exec) => {
        assertResidentToolSession(exec, groupId)
        return { tasks: store.listTasks().filter((task) => task.groupId === groupId).map(({ taskId, objective, state, childSessionId, waitingReason, completion }) => ({
          taskId, objective, state, childSessionId,
          ...(waitingReason === undefined ? {} : { waitingReason }),
          ...(completion === undefined ? {} : { completion }),
        })) }
      },
    })
  }
  const withoutInitiator = (operation) => typeof ctx.agents.withoutInitiator === 'function' ? ctx.agents.withoutInitiator(operation) : operation()
  async function resolveAgentWorkspace(workspaceDir = '') {
    const workspace = workspaceDir.trim() || cwd
    if (!path.isAbsolute(workspace)) throw new Error('agent_workspace_must_be_absolute')
    const workspaceStat = await stat(workspace).catch(() => undefined)
    if (!workspaceStat?.isDirectory()) throw new Error(`agent_workspace_not_directory:${workspace}`)
    return workspace
  }
  let agentWorkspace = await resolveAgentWorkspace(store.getAgentWorkspaceDir?.() ?? agentWorkspaceDir ?? '')
  if (store.getAgentWorkspaceDir?.() !== agentWorkspace) await store.setAgentWorkspaceDir?.(agentWorkspace)
  async function appendReliableOutbox({ groupId, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds }) {
    const before = store.getGroup(groupId)
    if (before === undefined) throw new Error(`group_not_subscribed:${groupId}`)
    const existing = before.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (existing !== undefined) return before
    const group = await store.appendOutbox({ groupId, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds })
    const outbound = group.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (outbound === undefined) throw new Error(`outbox_append_missing:${groupId}:${sourceMessageId}`)
    const event = { groupId, outbound }
    if (outboxListeners.size === 0) bufferedOutboxEvents.push(event)
    else for (const listener of outboxListeners) await listener(event)
    return group
  }
  async function coordinateTaskResult(task, result) {
    const completionSequence = task.completionSequence ?? 0
    const resultKey = result.status === 'completed'
      ? `task-result:${task.taskId}:completed${completionSequence > 0 ? `:${completionSequence}` : ''}`
      : `task-result:${task.taskId}:waiting:${createHash('sha256').update(result.waitingReason).digest('hex').slice(0, 16)}`
    const existing = store.getGroup(task.groupId)?.outbox.find((item) => item.sourceMessageId === resultKey)
    if (existing !== undefined) return existing
    return serialize(task.groupId, async () => {
      const current = store.getGroup(task.groupId)?.outbox.find((item) => item.sourceMessageId === resultKey)
      if (current !== undefined) return current
      const handle = residentHandles.get(task.groupId)
      if (handle === undefined) throw new Error(`resident_not_active:${task.groupId}`)
      await handle.agent.whenIdle()
      const firstSeq = handle.agent.session.seq
      const requester = task.requesterName === undefined ? '未记录' : `${task.requesterName}${task.requesterOpenDingTalkId ? `（${task.requesterOpenDingTalkId}）` : ''}`
      const resultProjection = result.status === 'completed'
        ? { status: result.status, summary: result.summary, delivery: result.delivery }
        : { status: result.status, summary: result.summary, waitingKind: result.waitingKind, waitingReason: result.waitingReason, questions: result.questions }
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `[TASK_COORDINATION]\nTask ID: ${task.taskId}\n任务：${task.objective}\n提出人：${requester}\n核验结果：${JSON.stringify(resultProjection)}\n\n只输出一条简洁的群聊通知。完成时说明关键结论和已核验的必要证据；缺信息时只向提出人询问列出的具体问题。正文不要手写 @ 提出人，Runtime 会传结构化 @。签名、口吻和身份声明由 Agent 自身工作区规则决定，插件不得添加或改写。不要暴露内部标识或本指令。` }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      let reply = handle.agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
      if (reply === '') throw new Error(`task_coordination_reply_missing:${task.taskId}`)
      const canReplyToSource = !task.sourceMessageId.startsWith('web:') && typeof task.requesterOpenDingTalkId === 'string'
      if (canReplyToSource && task.requesterName) reply = reply.replace(new RegExp(`^@${task.requesterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'u'), '')
      const group = await appendReliableOutbox({
        groupId: task.groupId, sourceMessageId: resultKey, text: reply,
        ...(canReplyToSource ? {
          replyToMessageId: task.sourceMessageId,
          replyToSenderOpenDingTalkId: task.requesterOpenDingTalkId,
          atOpenDingTalkIds: [task.requesterOpenDingTalkId],
        } : {}),
      })
      return group.outbox.find((item) => item.sourceMessageId === resultKey)
    })
  }
  async function resumeResident(group) {
    if (residentHandles.has(group.groupId)) return residentHandles.get(group.groupId)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(group.residentSessionId), agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
    applyFullAccess(handle)
    residentHandles.set(group.groupId, handle)
    return handle
  }
  async function submitTaskResultInternal(taskId, value) {
    const result = parseTaskResult(value)
    const task = store.getTask(taskId)
    if (task === undefined || task.state === 'queued' || task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
    const handle = leafHandles.get(taskId)
    if (handle === undefined) throw new Error(`task_leaf_not_active:${taskId}`)
    const goal = ctx.goals.get(handle.agent)
    if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
    if (result.status === 'waiting') {
      if (goal.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: result.waitingKind === 'information' ? 'task-input-required' : 'task-human-intervention-required', message: result.waitingReason })
      if (result.waitingKind === 'information') {
        await withoutInitiator(() => coordinateTaskResult(task, result))
        return store.updateTask(taskId, (current) => ({ ...current, state: 'waiting', waitingKind: 'information', waitingReason: result.waitingReason, result }))
      }
      const fingerprint = humanBlockerFingerprint(result.blockerCategory, result.requestedAction)
      const currentBlocker = task.humanBlocker
      const approved = [...(task.humanBlockerHistory ?? []), ...(currentBlocker ? [currentBlocker] : [])]
        .find((item) => (item.fingerprint ?? humanBlockerFingerprint(item.category, item.requestedAction)) === fingerprint && item.status === 'answered' && item.decision === 'approved')
      if (approved !== undefined) {
        if (goal.phase === 'blocked' || goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed')) ctx.goals.resume(handle.agent, goalRef(ctx.goals.get(handle.agent)))
        const running = await store.updateTask(taskId, (current) => ({
          ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: result, result: undefined,
          humanBlocker: approved, humanBlockerHistory: withHumanBlockerHistory(current, approved), updatedAt: new Date().toISOString(),
        }))
        await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${approved.requestId}\nDecision: approved\nReply: ${approved.reply ?? '已批准'}\n\nThis exact controlled-action scope was already approved. Continue the same task only within that approved scope; do not request approval again.`)
        return running
      }
      if (currentBlocker !== undefined
        && (currentBlocker.fingerprint ?? humanBlockerFingerprint(currentBlocker.category, currentBlocker.requestedAction)) === fingerprint
        && currentBlocker.status !== 'answered') return task
      const requestId = `blocker-${randomUUID()}`
      const blocker = { requestId, fingerprint, category: result.blockerCategory, requestedAction: result.requestedAction, status: 'pending-send', waitingReason: result.waitingReason, risk: result.risk, evidence: result.evidence, attemptedActions: result.attemptedActions, createdAt: new Date().toISOString() }
      const waiting = await store.updateTask(taskId, (current) => ({
        ...current, state: 'waiting', waitingKind: 'human-intervention', waitingReason: result.waitingReason, result,
        humanBlocker: blocker,
      }))
      for (const listener of humanBlockerListeners) await listener({ task: waiting, result })
      return store.getTask(taskId)
    }
    if (goal.phase !== 'complete') ctx.goals.complete(handle.agent, goalRef(goal))
    await withoutInitiator(() => coordinateTaskResult(task, result))
    const completed = await store.updateTask(taskId, (current) => ({ ...current, state: 'completed', completion: result.summary, result, waitingKind: undefined, waitingReason: undefined }))
    handle.agent.whenIdle().then(async () => {
      if (leafHandles.get(taskId) !== handle) return
      leafHandles.delete(taskId); leafTaskBySession.delete(String(handle.agent.session.id)); await handle.dispose()
    }).catch(() => undefined)
    await withoutInitiator(() => pumpTasks())
    return completed
  }
  const listAuthorizationRequests = () => store.listTasks().flatMap((task) => {
    const requests = new Map()
    for (const blocker of [...(task.humanBlockerHistory ?? []), ...(task.humanBlocker ? [task.humanBlocker] : [])]) requests.set(blocker.requestId, blocker)
    return [...requests.values()].map((blocker) => ({
      ...blocker, taskId: task.taskId, groupId: task.groupId, objective: task.objective,
      waitingReason: blocker.waitingReason ?? task.waitingReason, risk: blocker.risk ?? task.result?.risk, evidence: blocker.evidence ?? task.result?.evidence ?? [], attemptedActions: blocker.attemptedActions ?? task.result?.attemptedActions ?? [],
      createdAt: blocker.createdAt ?? blocker.sentAt ?? task.updatedAt ?? task.createdAt, taskState: task.state,
    }))
  })
  const getAuthorizationRequest = (requestId) => listAuthorizationRequests().find((request) => request.requestId === requestId)
  async function reissueAuthorizationInternal({ requestId, reason }) {
    const task = store.listTasks().find((item) => item.humanBlocker?.requestId === requestId)
    if (task?.state !== 'waiting' || task.waitingKind !== 'human-intervention') throw new Error(`authorization_request_not_pending:${requestId}`)
    const blocker = task.humanBlocker
    if (blocker.status !== 'pending-send' && blocker.status !== 'waiting-reply') throw new Error(`authorization_request_not_pending:${requestId}`)
    const now = new Date().toISOString(), nextRequestId = `blocker-${randomUUID()}`
    const superseded = {
      ...blocker, status: 'superseded', supersededAt: now, supersededBy: nextRequestId,
      supersedeReason: reason?.trim() || '按当前统一授权审批逻辑重新提交',
      recallStatus: blocker.messageId ? 'pending' : 'not-required',
    }
    const replacement = {
      requestId: nextRequestId, fingerprint: blocker.fingerprint ?? humanBlockerFingerprint(blocker.category, blocker.requestedAction),
      category: blocker.category, requestedAction: blocker.requestedAction, status: 'pending-send',
      waitingReason: blocker.waitingReason ?? task.waitingReason, risk: blocker.risk, evidence: blocker.evidence,
      attemptedActions: blocker.attemptedActions, createdAt: now, formatVersion: 3,
    }
    const waiting = await store.updateTask(task.taskId, (current) => ({
      ...current, humanBlocker: replacement,
      humanBlockerHistory: withHumanBlockerHistory({ ...current, humanBlockerHistory: withHumanBlockerHistory(current, superseded) }, replacement),
      updatedAt: now,
    }))
    const oldAuthorization = getAuthorizationRequest(requestId)
    for (const listener of authorizationDecisionListeners) await listener({ authorization: oldAuthorization, task: waiting })
    for (const listener of humanBlockerListeners) await listener({ task: waiting, result: waiting.result })
    return { taskId: task.taskId, supersededRequestId: requestId, request: getAuthorizationRequest(nextRequestId) }
  }
  async function decideAuthorizationInternal({ requestId, decision, comment, source, quotedMessageId, replyMessageId }) {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error(`authorization_decision_invalid:${decision}`)
    const task = store.listTasks().find((item) => item.humanBlocker?.requestId === requestId)
    if (task === undefined) {
      const historical = getAuthorizationRequest(requestId)
      if (historical?.status === 'answered' && historical.decision === decision) return historical
      throw new Error(`authorization_request_not_pending:${requestId}`)
    }
    const blocker = task.humanBlocker
    if (blocker.status === 'answered') {
      if (blocker.decision === decision) return getAuthorizationRequest(requestId)
      throw new Error(`authorization_decision_conflict:${requestId}:${blocker.decision}`)
    }
    if (source === 'dingtalk' && blocker.messageId !== quotedMessageId) throw new Error(`human_blocker_reply_mismatch:${task.taskId}:${requestId}`)
    const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
    const goal = ctx.goals.get(handle.agent)
    const reply = comment?.trim() || (decision === 'approved' ? '批准' : '拒绝')
    const answered = {
      ...blocker, fingerprint: blocker.fingerprint ?? humanBlockerFingerprint(blocker.category, blocker.requestedAction), status: 'answered', decision, reply,
      decisionSource: source, decidedAt: new Date().toISOString(), ...(replyMessageId ? { replyMessageId } : {}),
      ...(blocker.messageId && source === 'web' ? { recallStatus: 'pending' } : { recallStatus: 'not-required' }),
    }
    const running = await store.updateTask(task.taskId, (current) => ({
      ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined,
      humanBlocker: answered, humanBlockerHistory: withHumanBlockerHistory(current, answered),
    }))
    await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${requestId}\nDecision: ${decision}\nReply: ${reply}\nSource: ${source}\n\nContinue the same task only within the approved scope. For a rejected decision, do not perform the controlled action. Re-check current state before acting.`)
    if (goal?.phase === 'blocked' || goal?.phase === 'paused' || (goal?.phase === 'active' && goal.activation === 'disarmed')) ctx.goals.resume(handle.agent, goalRef(goal))
    const authorization = getAuthorizationRequest(requestId)
    for (const listener of authorizationDecisionListeners) await listener({ authorization, task: running })
    return authorization
  }
  function leafSetup(task) {
    return (agentCtx) => {
      const parent = residentHandles.get(task.groupId)?.agent
      if (parent === undefined) throw new Error(`resident_not_active:${task.groupId}`)
      if (agentPresets === undefined) throw new Error('agent_presets_required')
      const inheritedPreset = agentPresets.composeFrom(agentCtx, parent.ctx)
      if (inheritedPreset !== 'standard') throw new Error(`leaf_agent_preset_invalid:${inheritedPreset ?? 'none'}`)
      installSelection(agentCtx)
      agentCtx.systemPrompt.section({
        name: 'group-task-blocking-policy', order: 45,
        text: () => `## 群任务执行与完成规则

你必须通过 submit_task_result 结束任务；自然语言总结、Goal complete 或 turn end 都不构成 Task 完成。

### 任务授权边界

Task objective 是本任务的动作授权上限，必须逐字尊重其中的动作范围。若 objective 只要求“看看、查一下、排查、分析、核对、监控”或其他诊断/观察工作，你只能读取、核验、定位根因并提交证据和建议，不得修改代码或数据、提交 PR、合并、构建、部署、执行修复方案，也不得因为发现了明确根因就自行扩大为修复。只有 objective 明确包含修复、修改、实施、合并、发布或执行等变更动作时，才能进行对应变更；配置的任务流程引导和完成证据要求也不得扩大该授权。

### 配置的任务流程引导

${store.getTaskExecutionGuidance?.() || '未配置额外流程引导；按任务目标、工作区规则和当前现场自主推进。'}

### 配置的完成证据要求

${store.getTaskEvidenceGuidance?.() || '提交能够独立核验目标已完成的当前证据；不得只用自然语言声称完成。'}

### 群聊后续关联上下文

${task.relatedContexts?.length ? task.relatedContexts.map((item) => `- ${item}`).join('\n') : '暂无。'}

### 已持久化的真人批复

${(task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').length
  ? (task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').map((item) => `- ${item.decision ?? 'answered'}｜${item.category}｜${item.requestedAction}｜答复：${item.reply ?? '未记录'}`).join('\n')
  : '暂无。'}

完成结果提交后由 Runtime 交给 resident 主会话，再由主会话通知原群任务负责人。

### 阻塞规则

除以下两类情况外，不得暂停或阻塞 Goal，也不得提交 waiting：
1. \`waitingKind=information\`：只有原任务提出人才能补充的目标、完成条件或必要业务信息不明确；必须提供具体 questions。
2. \`waitingKind=human-intervention\`：已经取得证据且自身无法解决的操作红线、网络中断、磁盘不足、资源不足、意外事件或必须真人确认的处置方案；必须提供 blockerCategory、risk、evidence、attemptedActions 和 requestedAction。risk 单独说明执行该操作可能造成的具体影响；操作红线使用 blockerCategory=redline，并把完整操作范围和不在授权内的事项写入 requestedAction；Runtime 只发送这一条阻塞审批消息。

代码错误、命令失败、可重试波动、普通不确定性、实现困难、正在正常运行但耗时较长的外部流水线，或 Goal 轮数即将/已经耗尽时，继续诊断、监控或由 Host 续接 Goal，不得 waiting。Goal 轮数是 Host 的执行预算，不是需要真人处理的业务阻塞。不要直接使用 Goal 工具标记 blocked；合法等待统一通过 submit_task_result 交给 Host 路由。`,
      })
      agentCtx.tools.register({
        name: 'submit_task_result',
        description: 'Submit a verified business-task result. Host validation decides Task state.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          status: { type: 'string', enum: ['completed', 'waiting'] }, workType: { type: 'string', enum: ['development', 'non-development'] }, waitingKind: { type: 'string', enum: ['information', 'human-intervention'] }, summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } }, artifacts: { type: 'array', items: { type: 'string' } }, waitingReason: { type: 'string' },
          questions: { type: 'array', items: { type: 'string' } }, blockerCategory: { type: 'string', enum: ['redline', 'network', 'disk', 'resource', 'unexpected', 'human-decision'] },
          risk: { type: 'string' }, attemptedActions: { type: 'array', items: { type: 'string' } }, requestedAction: { type: 'string' },
          delivery: { type: 'object', additionalProperties: true },
        }, required: ['status', 'summary', 'evidence', 'artifacts'] },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', const: true }, taskId: { type: 'string' }, state: { type: 'string' } }, required: ['accepted', 'taskId', 'state'] },
          render: (_args, out) => [{ type: 'text', text: `Task result accepted: ${out.taskId} -> ${out.state}` }],
        },
        execute: async (args, exec) => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error(`task_result_wrong_session:${task.taskId}`)
          const updated = await serializeTasks(() => submitTaskResultInternal(task.taskId, args))
          return { accepted: true, taskId: task.taskId, state: updated.state }
        },
      })
    }
  }
  async function attachGoal(task, handle, creating) {
    leafHandles.set(task.taskId, handle); leafTaskBySession.set(String(handle.agent.session.id), task.taskId)
    const existing = ctx.goals.get(handle.agent)
    if (existing === undefined) {
      if (!creating) throw new Error(`task_goal_missing:${task.taskId}`)
      ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds }); return
    }
    if (task.state === 'running' && (
      existing.phase === 'paused'
      || existing.phase === 'blocked'
      || (existing.phase === 'active' && existing.activation === 'disarmed')
    )) ctx.goals.resume(handle.agent, goalRef(existing))
  }
  async function createLeaf(task) {
    const parent = residentHandles.get(task.groupId)?.agent
    if (parent === undefined) throw new Error(`resident_not_active:${task.groupId}`)
    const handle = await ctx.agents.create({
      sessionId: SessionId(task.childSessionId),
      meta: { cwd: agentWorkspace, parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions, setup: leafSetup(task), signal: AbortSignal.timeout(resumeTimeoutMs),
    })
    try { ensureLeafDescriptor(handle, task); applyFullAccess(handle); await attachGoal(task, handle, true); return handle } catch (error) {
      leafHandles.delete(task.taskId); leafTaskBySession.delete(task.childSessionId); await handle.dispose(); throw error
    }
  }
  async function resumeLeaf(task) {
    if (leafHandles.has(task.taskId)) return leafHandles.get(task.taskId)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(task.childSessionId), agentOptions, setup: leafSetup(task), signal: AbortSignal.timeout(resumeTimeoutMs) })
    ensureLeafDescriptor(handle, task); applyFullAccess(handle)
    await attachGoal(task, handle, false); return handle
  }
  async function restartPausedLeaf(task, previous, attempt) {
    const replacementSessionId = `session-${task.taskId}-${randomUUID().slice(0, 8)}`
    const replacementTask = { ...task, childSessionId: replacementSessionId }
    const replacement = await createLeaf(replacementTask)
    try {
      await store.updateTask(task.taskId, (current) => ({ ...current, childSessionId: replacementSessionId, updatedAt: new Date().toISOString() }))
    } catch (error) {
      leafHandles.set(task.taskId, previous)
      leafTaskBySession.delete(replacementSessionId)
      leafTaskBySession.set(task.childSessionId, task.taskId)
      await replacement.dispose()
      throw error
    }
    leafTaskBySession.delete(task.childSessionId)
    await previous.dispose()
    await store.recordAlert({ taskId: task.taskId, fingerprint: `leaf-paused-restarted:${attempt}`, detail: `Replaced paused DSH leaf Session ${task.childSessionId} with ${replacementSessionId}`, status: 'resolved' })
    return replacement
  }
  async function inspectRunningTasks() {
    return serializeTasks(async () => {
      const results = []
      for (const listed of store.listTasks().filter((task) => task.state === 'running')) {
        let task = store.getTask(listed.taskId)
        if (task?.state !== 'running') continue
        let handle = leafHandles.get(task.taskId)
        const registered = ctx.agents.get?.(SessionId(task.childSessionId))
        let sessionRecovered = false
        let goalRecovered = false
        try {
          if (handle === undefined || registered !== handle.agent) {
            if (registered !== undefined) throw new Error(`leaf_session_identity_mismatch:${task.childSessionId}`)
            if (handle !== undefined) {
              leafHandles.delete(task.taskId)
              leafTaskBySession.delete(task.childSessionId)
            }
            handle = await resumeLeaf(task)
            sessionRecovered = true
            await store.recordAlert({ taskId: task.taskId, fingerprint: 'leaf-session-recovered', detail: `Recovered DSH leaf Session ${task.childSessionId}`, status: 'resolved' })
          }
          const before = ctx.goals.get(handle.agent)
          if (before?.phase === 'paused' || before?.phase === 'blocked' || before?.phase === 'complete') {
            if (handle.agent.status !== 'idle') {
              results.push({ taskId: task.taskId, ok: true, deferred: true, sessionRecovered, goalRecovered: false, agentStatus: handle.agent.status })
              continue
            }
            if (before.phase === 'complete' && (resultRecoveryCounts.get(task.taskId) ?? 0) === 0) {
              resultRecoveryCounts.set(task.taskId, 1)
              ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
              await followupTaskInternal(task, `你刚才结束了执行轮次，但尚未调用 submit_task_result，因此 Task 仍未完成。请按照系统提示中的任务流程引导和完成证据要求继续工作，取得可独立核验的结果后调用 submit_task_result；不要只输出自然语言总结。`)
              await store.recordAlert({ taskId: task.taskId, fingerprint: 'leaf-result-submission-requested', detail: `Requested structured result from completed DSH leaf Session ${task.childSessionId}`, status: 'resolved' })
              results.push({ taskId: task.taskId, ok: true, resultRequested: true, sessionRecovered, goalRecovered: true, agentStatus: handle.agent.status })
              continue
            }
            const attempt = (pausedRecoveryCounts.get(task.taskId) ?? 0) + 1
            pausedRecoveryCounts.set(task.taskId, attempt)
            if (attempt <= 2) {
              handle = await restartPausedLeaf(task, handle, attempt)
              task = store.getTask(task.taskId)
              sessionRecovered = true
              goalRecovered = true
            } else {
              const reason = `DSH leaf Session连续${attempt}次在未提交结构化结果时进入${before.phase}，自动重建两次后仍未恢复。`
              await submitTaskResultInternal(task.taskId, {
                status: 'waiting', waitingKind: 'human-intervention', summary: reason,
                evidence: [`Task ${task.taskId}`, `Session ${task.childSessionId}`, `Goal ${before.id} ${before.phase}/${before.activation ?? 'none'}`], artifacts: [], waitingReason: reason,
                blockerCategory: 'unexpected', risk: '任务载体持续不可用，任务无法继续执行且可能延误交付。', attemptedActions: ['自动重建叶子会话两次并恢复同一Task Goal'], requestedAction: '请检查 DSH Agent/Goal 运行状态后引用本阻塞消息回复处置意见。',
              })
              results.push({ taskId: task.taskId, ok: false, waiting: true, error: reason })
              continue
            }
          } else if (before === undefined || before.phase !== 'active' || before.activation !== 'armed') {
            if (handle.agent.status !== 'idle') {
              results.push({ taskId: task.taskId, ok: true, deferred: true, sessionRecovered, goalRecovered: false, agentStatus: handle.agent.status })
              continue
            }
            await attachGoal(task, handle, false)
            goalRecovered = true
            await store.recordAlert({ taskId: task.taskId, fingerprint: `leaf-goal-recovered:${before?.phase ?? 'missing'}:${before?.activation ?? 'missing'}`, detail: `Recovered DSH Goal for Session ${task.childSessionId} from ${before?.phase ?? 'missing'}/${before?.activation ?? 'missing'}`, status: 'resolved' })
          }
          const live = ctx.agents.get?.(SessionId(task.childSessionId))
          const goal = ctx.goals.get(handle.agent)
          if (live !== handle.agent) throw new Error(`leaf_session_not_registered:${task.childSessionId}`)
          if (goal?.phase !== 'active' || goal.activation !== 'armed') throw new Error(`leaf_goal_not_running:${task.childSessionId}:${goal?.phase ?? 'missing'}:${goal?.activation ?? 'missing'}`)
          await store.resolveAlerts?.({ taskId: task.taskId, fingerprintPrefix: 'running-task-inspection-failed:' })
          results.push({ taskId: task.taskId, ok: true, sessionRecovered, goalRecovered, agentStatus: handle.agent.status })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          await store.recordAlert({ taskId: task.taskId, fingerprint: `running-task-inspection-failed:${detail}`, detail })
          results.push({ taskId: task.taskId, ok: false, error: detail })
        }
      }
      return results
    })
  }
  async function pumpTasks() {
    const tasks = store.listTasks()
    let available = taskConcurrencyLimit - tasks.filter((task) => task.state === 'running' || task.state === 'waiting').length
    for (const task of tasks.filter((item) => item.state === 'queued')) {
      if (available <= 0) break
      if (!residentHandles.has(task.groupId)) throw new Error(`resident_not_active:${task.groupId}`)
      if (task.reopenContext) {
        const handle = await resumeLeaf(task)
        const goal = ctx.goals.get(handle.agent)
        if (goal?.phase === 'complete') ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
        else if (goal?.phase === 'blocked' || goal?.phase === 'paused' || (goal?.phase === 'active' && goal.activation === 'disarmed')) ctx.goals.resume(handle.agent, goalRef(goal))
        const running = await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running', reopenContext: undefined }))
        await followupTaskInternal(running, `[TASK_REOPEN]\n${task.reopenContext}\n\n这是对同一任务已完成结果的纠正、回滚或补做要求。继续使用原 Task 和原叶子会话，严格按本次补充范围处理并重新提交可核验结果。`)
      } else {
        await createLeaf(task)
        await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running' }))
      }
      available -= 1
    }
  }
  async function reopenCompletedTaskInternal(task, context, trigger) {
    if (task.state !== 'completed') throw new Error(`task_not_completed:${task.taskId}`)
    const queued = await store.updateTask(task.taskId, (current) => {
      const initialTrigger = { sourceMessageId: current.sourceMessageId, ...(current.requesterName ? { requesterName: current.requesterName } : {}), ...(current.requesterOpenDingTalkId ? { requesterOpenDingTalkId: current.requesterOpenDingTalkId } : {}) }
      const triggerHistory = current.triggerHistory ?? [initialTrigger]
      const nextHistory = trigger && !triggerHistory.some((item) => item.sourceMessageId === trigger.sourceMessageId) ? [...triggerHistory, trigger] : triggerHistory
      const { requesterName: _requesterName, requesterOpenDingTalkId: _requesterOpenDingTalkId, ...withoutCurrentRequester } = current
      return {
        ...withoutCurrentRequester,
        ...(trigger ? { sourceMessageId: trigger.sourceMessageId, ...(trigger.requesterName ? { requesterName: trigger.requesterName } : {}), ...(trigger.requesterOpenDingTalkId ? { requesterOpenDingTalkId: trigger.requesterOpenDingTalkId } : {}) } : {}),
        triggerHistory: nextHistory,
        state: 'queued',
        relatedContexts: [...(current.relatedContexts ?? []), context],
        lastCompletedResult: current.result,
        completion: undefined,
        result: undefined,
        waitingKind: undefined,
        waitingReason: undefined,
        reopenContext: context,
        archivedAt: undefined,
        completionSequence: (current.completionSequence ?? 0) + 1,
      }
    })
    await pumpTasks()
    return store.getTask(queued.taskId)
  }
  async function appendTaskContextInternal(task, context, trigger) {
    if (task.state === 'completed') return reopenCompletedTaskInternal(task, context, trigger)
    if (task.state === 'waiting' && task.waitingKind === 'information') {
      const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
      const goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'blocked' || goal?.phase === 'paused') ctx.goals.resume(handle.agent, goalRef(goal))
      task = await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined }))
    }
    task = await store.updateTask(task.taskId, (current) => ({ ...current, relatedContexts: [...(current.relatedContexts ?? []), context], updatedAt: new Date().toISOString() }))
    if (task.state === 'running' || task.state === 'waiting') await followupTaskInternal(task, context)
    return task
  }
  async function followupTaskInternal(task, text) {
    const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'coordinator' } }))
    return { task, accepted: true }
  }
  const disposeObserver = typeof ctx.on === 'function' ? ctx.on('session/event', (session, event) => {
    const taskId = leafTaskBySession.get(String(session.id))
    if (taskId === undefined || !PROJECTED_EVENTS.has(event.type) || typeof store.recordActivity !== 'function') return
    activityTail = activityTail.then(() => store.recordActivity({ taskId, sessionId: String(session.id), eventKey: `${String(session.id)}:${event.seq}`, type: event.type, detail: activityDetail(event) })).catch(() => undefined)
  }) : undefined
  for (const group of store.listGroups()) {
    try {
      await resumeResident(group)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('corrupt session log') || detail.includes('history unavailable')) {
        const replacementSessionId = `${residentSessionId(group.groupId)}-${randomUUID().slice(0, 8)}`
        const handle = await ctx.agents.create({ sessionId: SessionId(replacementSessionId), meta: { cwd: agentWorkspace, replacedCorruptSessionId: group.residentSessionId }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
        applyFullAccess(handle)
        await store.updateGroup({ groupId: group.groupId, residentSessionId: replacementSessionId })
        residentHandles.set(group.groupId, handle)
        recoveryIssues.push({ groupId: group.groupId, residentSessionId: replacementSessionId, replacedSessionId: group.residentSessionId, error: detail, recovered: true })
      } else {
        recoveryIssues.push({ groupId: group.groupId, residentSessionId: group.residentSessionId, error: detail })
      }
    }
  }
  for (const task of store.listTasks().filter((item) => item.state === 'running' || item.state === 'waiting')) {
    if (!residentHandles.has(task.groupId)) continue
    try { await resumeLeaf(task) } catch (error) { recoveryIssues.push({ groupId: task.groupId, taskId: task.taskId, childSessionId: task.childSessionId, error: error instanceof Error ? error.message : String(error) }) }
  }
  await serializeTasks(pumpTasks)
  if (supervisorIntervalMs > 0) {
    supervisorTimer = setInterval(() => { inspectRunningTasks().catch(() => undefined) }, supervisorIntervalMs)
    supervisorTimer.unref?.()
  }
  return {
    getGroup: store.getGroup, listGroups: store.listGroups, getTask: store.getTask, listTasks: store.listTasks, listAlerts: store.listAlerts,
    markMessageAgentDelivery: store.markMessageAgentDelivery, markMessagesAgentDelivery: store.markMessagesAgentDelivery,
    hydrateGroupHistory: ({ groupId }) => serialize(groupId, async () => {
      const group = store.getGroup(groupId)
      if (group === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const handle = residentHandles.get(groupId)
      if (handle === undefined) throw new Error(`resident_not_active:${groupId}`)
      const messages = [...group.messages].sort((left, right) => left.sequence - right.sequence)
      const blocks = messages.map((message) => {
        const lines = [
          `消息 ${message.sequence}`,
          `发送者：${message.senderName ?? '未知'}`,
          `发送者OpenDingTalkId：${message.senderOpenDingTalkId ?? '未知'}`,
          `时间：${new Date(message.occurredAt).toISOString()}`,
          `内容：${message.text}`,
        ]
        if (message.quotedMessage?.messageId) lines.push(`引用消息ID：${message.quotedMessage.messageId}`)
        return lines.join('\n')
      })
      await handle.agent.whenIdle()
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[GROUP_HISTORY_IMPORT]\n以下是当前群聊今天已接收的历史消息，仅用于恢复新常驻会话的群聊上下文。不要回复群聊、不要创建或续接任务，也不要重新执行历史请求。\n\n${blocks.join('\n\n')}` }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const completed = handle.agent.session.events.some((event) => event.seq >= firstSeq && event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
      if (!completed) throw new Error(`group_history_import_failed:${groupId}`)
      return { groupId, residentSessionId: group.residentSessionId, imported: messages.length }
    }),
    hasGroupConfiguration: store.hasGroupConfiguration, initializeGroupConfiguration: store.initializeGroupConfiguration,
    listActivities: store.listActivities ?? (() => []), flushActivities: () => activityTail,
    listRecoveryIssues: () => recoveryIssues.map((issue) => ({ ...issue })),
    onGroupSubscribed(listener) { subscriptionListeners.add(listener); return () => subscriptionListeners.delete(listener) },
    onGroupUnsubscribed(listener) { unsubscriptionListeners.add(listener); return () => unsubscriptionListeners.delete(listener) },
    onOutboxAppended(listener) {
      outboxListeners.add(listener)
      const buffered = bufferedOutboxEvents.splice(0)
      for (const event of buffered) Promise.resolve(listener(event)).catch(() => undefined)
      return () => outboxListeners.delete(listener)
    },
    onHumanBlockerRequested(listener) { humanBlockerListeners.add(listener); return () => humanBlockerListeners.delete(listener) },
    onAuthorizationDecided(listener) { authorizationDecisionListeners.add(listener); return () => authorizationDecisionListeners.delete(listener) },
    listAuthorizationRequests,
    getAuthorizationRequest,
    ingest: (message) => serialize(message.groupId, async () => {
      const ingested = await store.ingest(message)
      const persisted = store.getGroup(message.groupId)?.messages.find((item) => item.messageId === message.messageId)
      if (ingested.duplicate && ['delivered', 'skipped'].includes(persisted?.agentDeliveryStatus)) return ingested
      const accepted = ingested.duplicate ? { ...ingested, duplicate: false, recovered: true, sequence: persisted.sequence } : ingested
      const handle = residentHandles.get(message.groupId)
      try {
        if (handle === undefined) throw new Error(`resident_not_active:${message.groupId}`)
        await handle.agent.whenIdle(); const firstSeq = handle.agent.session.seq
        const images = Array.isArray(message.images) ? message.images : []
        if (images.length > 0 && attachments === undefined) throw new Error('dsh_attachments_required')
        const imageRefs = images.length === 0 ? [] : await attachments.saveImages(images.map((image) => ({ data: image.data, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })))
        const content = [
          { type: 'text', text: buildDecisionPrompt({ sequence: accepted.sequence, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable }) },
          ...imageRefs.map((attachment) => ({ type: 'image', attachment })),
        ]
        handle.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        const reply = handle.agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'assistant/message').flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('')
        if (reply === '') throw new Error(`resident_reply_missing:${message.groupId}:${message.messageId}`)
        let decision = parseGroupDecision(reply)
        await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'delivered' })
        const groupBeforeDecision = store.getGroup(message.groupId)
        const previousMessage = groupBeforeDecision?.messages.find((item) => item.sequence === accepted.sequence - 1)
        const activeTaskCount = store.listTasks().filter((task) => task.groupId === message.groupId).length
        if (decision.kind === 'ignore' && shouldRecheckTaskAssociation({ activeTaskCount, hasImage: imageRefs.length > 0, previousMessage, occurredAt: message.occurredAt })) {
          const recheckSeq = handle.agent.session.seq
          handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[GROUP_DECISION]\n\n关联复核：你刚才选择了 ignore。请重新对照“本群全部任务关联索引”和紧邻消息判断。图片、图片后的短说明，以及群友提出的未经核验根因/状态判断，都可能是已有任务需要核验的新增线索；相关时必须返回 task-context，只有确认与全部历史及当前任务无关时才能 ignore。\n\n${buildDecisionPrompt({ sequence: accepted.sequence, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable }).replace(/^\[GROUP_DECISION\]\n\n/u, '')}` }], source: { kind: 'coordinator' } }))
          await handle.agent.whenIdle()
          const rechecked = handle.agent.session.events.filter((event) => event.seq >= recheckSeq && event.type === 'assistant/message').flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('')
          if (rechecked !== '') decision = parseGroupDecision(rechecked)
        }
        if (decision.kind === 'new-task' && !isExplicitAgentDirection(message.text, [...(store.getAgentNames?.() ?? []), currentDwsUserName]) && imageRefs.length === 0) decision = { kind: 'answer', reply: decision.reply }
        if (decision.kind === 'ignore') return { ...accepted, decision, group: store.getGroup(message.groupId) }
        let task
        const trigger = { sourceMessageId: message.messageId, ...(message.senderName ? { requesterName: message.senderName } : {}), ...(message.senderOpenDingTalkId ? { requesterOpenDingTalkId: message.senderOpenDingTalkId } : {}), ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}) }
        if (decision.kind === 'new-task') task = await serializeTasks(async () => { const result = await store.createTask({ groupId: message.groupId, sourceMessageId: message.messageId, objective: decision.objective, requesterName: message.senderName, requesterOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt }); await pumpTasks(); return store.getTask(result.task.taskId) })
        else if (decision.kind === 'task-context') {
          task = store.getTask(decision.taskId)
          if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_context_target_invalid:${decision.taskId}`)
          task = await serializeTasks(() => appendTaskContextInternal(task, decision.context, trigger))
        }
        else if (decision.kind === 'task-reopen') {
          task = store.getTask(decision.taskId)
          if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_reopen_target_invalid:${decision.taskId}`)
          task = await serializeTasks(() => reopenCompletedTaskInternal(task, decision.context, trigger))
        }
        const group = decision.reply.trim() === ''
          ? store.getGroup(message.groupId)
          : await appendReliableOutbox({ groupId: message.groupId, sourceMessageId: message.messageId, text: decision.reply })
        return { ...accepted, decision, group, task }
      } catch (error) {
        const current = store.getGroup(message.groupId)?.messages.find((item) => item.messageId === message.messageId)
        if (current?.agentDeliveryStatus === 'pending') await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }),
    async recoverPendingMessages() {
      const pending = store.listGroups().flatMap((group) => (group.messages ?? [])
        .filter((message) => message.agentDeliveryStatus === 'pending')
        .map((message) => ({ ...message, groupId: group.groupId })))
        .sort((left, right) => left.groupId.localeCompare(right.groupId) || left.sequence - right.sequence)
      const results = []
      for (const message of pending) {
        try { results.push({ messageId: message.messageId, status: 'recovered', result: await this.ingest(message) }) }
        catch (error) { results.push({ messageId: message.messageId, status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
      }
      return results
    },
    backfill: (messages) => {
      if (!Array.isArray(messages)) throw new Error('backfill_messages_required')
      const groupIds = new Set(messages.map((message) => message.groupId))
      if (groupIds.size !== 1) throw new Error('backfill_single_group_required')
      const groupId = messages[0]?.groupId
      if (groupId === undefined) return { accepted: 0, duplicates: 0, total: 0 }
      return serialize(groupId, async () => {
        let accepted = 0; let duplicates = 0; let enriched = 0
        for (const message of messages) {
          const result = await store.ingest(message)
          if (result.duplicate) { duplicates += 1; if (result.enriched) enriched += 1 }
          else { accepted += 1; await store.markMessageAgentDelivery({ groupId, messageId: message.messageId, status: 'skipped' }) }
        }
        return { accepted, duplicates, enriched, total: messages.length, group: store.getGroup(groupId) }
      })
    },
    acknowledge: store.acknowledge, reportCarrierIssue: store.recordAlert,
    resolveGroupCarrierIssues: async ({ groupId }) => {
      const tasks = store.listTasks().filter((task) => task.groupId === groupId)
      for (const task of tasks) await store.resolveAlerts?.({ taskId: task.taskId, fingerprintPrefix: 'dws-consumer-exit:' })
    },
    inspectRunningTasks,
    migrateTaskProvenance: store.migrateTaskProvenance,
    migrateTaskContinuation: ({ taskId, context }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task?.state === 'running') return task
      if (task?.state !== 'waiting') throw new Error(`task_continuation_migration_invalid:${taskId}`)
      const handle = leafHandles.get(taskId) ?? await resumeLeaf(task)
      let goal = ctx.goals.get(handle.agent)
      if (goal && goal.roundsStarted >= goal.maxGoalRounds && (goal.phase === 'blocked' || goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed'))) {
        goal = ctx.goals.edit(handle.agent, goalRef(goal), { maxGoalRounds: goal.maxGoalRounds + maxGoalRounds })
      }
      if (goal?.phase === 'blocked' || goal?.phase === 'paused' || (goal?.phase === 'active' && goal.activation === 'disarmed')) ctx.goals.resume(handle.agent, goalRef(goal))
      else if (goal?.phase === 'complete') ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
      const running = await store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, humanBlocker: current.humanBlocker ? { ...current.humanBlocker, status: 'answered', reply: 'Runtime判定无需真人介入，已转为持续执行。' } : undefined }))
      await followupTaskInternal(running, `[TASK_CONTEXT]\n${context}\n\n这是群聊对当前任务补充的高价值线索。先按当前现场核验，不要重复进行已被该线索排除的宽泛根因搜索。外部流水线仍在正常运行时持续监控；Goal轮数由Host续接，不得因此提交human-intervention。`)
      return running
    }),
    recordHumanBlockerDelivery: ({ taskId, requestId, openTaskId, conversationId, messageId, sentAt, formatVersion }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task?.humanBlocker?.requestId !== requestId) throw new Error(`human_blocker_not_found:${taskId}:${requestId}`)
      return store.updateTask(taskId, (current) => {
        const blocker = { ...current.humanBlocker, status: current.humanBlocker.status === 'answered' ? 'answered' : 'waiting-reply', openTaskId, conversationId, messageId, sentAt: sentAt ?? new Date().toISOString(), formatVersion, ...(current.humanBlocker.status === 'answered' ? { recallStatus: 'pending' } : {}) }
        return { ...current, humanBlocker: blocker, humanBlockerHistory: withHumanBlockerHistory(current, blocker) }
      })
    }),
    resolveHumanBlocker: ({ taskId, requestId, quotedMessageId, replyMessageId, reply, decision }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task?.state !== 'waiting' || task.waitingKind !== 'human-intervention' || task.humanBlocker?.requestId !== requestId || task.humanBlocker.messageId !== quotedMessageId) throw new Error(`human_blocker_reply_mismatch:${taskId}:${requestId}`)
      if (task.humanBlocker.category === 'redline' && decision !== 'approved' && decision !== 'rejected') throw new Error(`redline_decision_required:${taskId}:${requestId}`)
      if (task.humanBlocker.replyMessageId === replyMessageId) return task
      if (decision === undefined) throw new Error(`authorization_decision_required:${taskId}:${requestId}`)
      await decideAuthorizationInternal({ requestId, decision, comment: reply, source: 'dingtalk', quotedMessageId, replyMessageId })
      return store.getTask(taskId)
    }),
    decideAuthorization: (request) => serializeTasks(() => decideAuthorizationInternal({ ...request, source: request.source ?? 'web' })),
    reissueAuthorization: (request) => serializeTasks(() => reissueAuthorizationInternal(request)),
    recordAuthorizationRecall: ({ requestId, status, error }) => serializeTasks(async () => {
      if (status !== 'recalled' && status !== 'failed') throw new Error(`authorization_recall_status_invalid:${status}`)
      const task = store.listTasks().find((item) => item.humanBlocker?.requestId === requestId || item.humanBlockerHistory?.some((blocker) => blocker.requestId === requestId))
      if (task === undefined) throw new Error(`authorization_request_not_found:${requestId}`)
      const original = task.humanBlocker?.requestId === requestId ? task.humanBlocker : task.humanBlockerHistory.find((blocker) => blocker.requestId === requestId)
      const blocker = { ...original, recallStatus: status, ...(status === 'recalled' ? { recalledAt: new Date().toISOString() } : { recallError: error || 'unknown' }) }
      return store.updateTask(task.taskId, (current) => ({
        ...current, ...(current.humanBlocker?.requestId === requestId ? { humanBlocker: blocker } : {}),
        humanBlockerHistory: withHumanBlockerHistory(current, blocker),
      }))
    }),
    migrateHumanBlockerReply: ({ taskId, requestId, reply, decision }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task?.humanBlocker?.requestId === requestId && task.humanBlocker.status === 'answered' && task.humanBlocker.decision === decision) return task
      if (task?.state !== 'waiting' || task.waitingKind !== 'human-intervention' || task.humanBlocker?.requestId !== requestId) throw new Error(`human_blocker_migration_mismatch:${taskId}:${requestId}`)
      if (task.humanBlocker.category === 'redline' && decision !== 'approved' && decision !== 'rejected') throw new Error(`redline_decision_required:${taskId}:${requestId}`)
      const handle = leafHandles.get(taskId) ?? await resumeLeaf(task), goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'blocked' || goal?.phase === 'paused' || (goal?.phase === 'active' && goal.activation === 'disarmed')) ctx.goals.resume(handle.agent, goalRef(goal))
      const answered = { ...task.humanBlocker, fingerprint: task.humanBlocker.fingerprint ?? humanBlockerFingerprint(task.humanBlocker.category, task.humanBlocker.requestedAction), status: 'answered', reply, decision }
      const running = await store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, humanBlocker: answered, humanBlockerHistory: withHumanBlockerHistory(current, answered) }))
      await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${requestId}\nDecision: ${decision}\nReply: ${reply}\n\nContinue the same task only within the approved scope. Re-check current state before acting.`)
      return running
    }),
    createTask: (request) => serializeTasks(async () => { const result = await store.createTask(request); await pumpTasks(); return { ...result, task: store.getTask(result.task.taskId) } }),
    appendTaskContext: ({ taskId, context, sourceMessageId, requesterName, requesterOpenDingTalkId, occurredAt }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const trigger = sourceMessageId ? { sourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) } : undefined
      return appendTaskContextInternal(task, context, trigger)
    }),
    reopenTask: ({ taskId, context, sourceMessageId, requesterName, requesterOpenDingTalkId, occurredAt }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const trigger = sourceMessageId ? { sourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) } : undefined
      return reopenCompletedTaskInternal(task, context, trigger)
    }),
    reconcileCompletedNotifications: () => serializeTasks(async () => {
      const repaired = []
      for (const task of store.listTasks().filter((item) => item.state === 'completed' && item.result?.status === 'completed' && item.lastCompletedResult?.status === 'completed')) {
        let current = task
        if ((current.completionSequence ?? 0) === 0) current = await store.updateTask(current.taskId, (item) => ({ ...item, completionSequence: 1 }))
        const resultKey = `task-result:${current.taskId}:completed:${current.completionSequence}`
        if (store.getGroup(current.groupId)?.outbox.some((item) => item.sourceMessageId === resultKey)) continue
        await coordinateTaskResult(current, current.result)
        repaired.push({ taskId: current.taskId, sourceMessageId: resultKey })
      }
      return repaired
    }),
    archiveTask: ({ taskId }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      if (task.state !== 'completed') throw new Error(`task_not_completed:${taskId}`)
      if (task.archivedAt) return task
      return store.updateTask(taskId, (current) => ({ ...current, archivedAt: new Date().toISOString() }))
    }),
    waitTask: ({ taskId, reason }) => serializeTasks(async () => {
      const task = store.getTask(taskId); if (task?.state !== 'running') throw new Error(`task_not_running:${taskId}`)
      const handle = leafHandles.get(taskId) ?? await resumeLeaf(task), goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: 'task-input-required', message: reason })
      return store.updateTask(taskId, (current) => ({ ...current, state: 'waiting', waitingKind: 'information', waitingReason: reason }))
    }),
    resumeTask: ({ taskId }) => serializeTasks(async () => {
      const task = store.getTask(taskId); if (task?.state !== 'waiting') throw new Error(`task_not_waiting:${taskId}`)
      const handle = leafHandles.get(taskId) ?? await resumeLeaf(task), goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'blocked' || goal?.phase === 'paused') ctx.goals.resume(handle.agent, goalRef(goal))
      return store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined }))
    }),
    followupTask: ({ taskId, text }) => serializeTasks(async () => {
      const task = store.getTask(taskId); if (task === undefined || (task.state !== 'running' && task.state !== 'waiting')) throw new Error(`task_not_active:${taskId}`)
      return followupTaskInternal(task, text)
    }),
    submitTaskResult: ({ taskId, result }) => serializeTasks(() => submitTaskResultInternal(taskId, result)),
    subscribe: ({ groupId, name, responsibility = '' }) => serialize(groupId, async () => {
      const existing = store.getGroup(groupId); if (existing !== undefined) return { created: false, group: existing }
      const sessionId = residentSessionId(groupId), handle = await ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: agentWorkspace }, agentOptions, setup: residentSetup(groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
      applyFullAccess(handle)
      try {
        const result = await store.subscribe({ groupId, name, responsibility, residentSessionId: sessionId }); residentHandles.set(groupId, handle)
        for (const listener of subscriptionListeners) listener(result.group)
        return result
      } catch (error) { await handle.dispose(); throw error }
    }),
    updateGroup: (request) => serialize(request.groupId, () => store.updateGroup(request)),
    getAgentConfig: () => ({
      agentNames: store.getAgentNames?.() ?? [], workspaceDir: agentWorkspace, provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, proxyUrl: store.getProxyUrl?.() ?? '',
      taskExecutionGuidance: store.getTaskExecutionGuidance?.() ?? '', taskEvidenceGuidance: store.getTaskEvidenceGuidance?.() ?? '', maxConcurrentTasks: taskConcurrencyLimit,
    }),
    updateAgentConfig: ({ agentNames, workspaceDir, model, reasoningEffort, proxyUrl, taskExecutionGuidance, taskEvidenceGuidance, maxConcurrentTasks: nextMaxConcurrentTasksInput }) => serializeTasks(async () => {
      if (agentNames !== undefined && !Array.isArray(agentNames)) throw new Error('agent_names_must_be_array')
      const nextAgentNames = agentNames === undefined ? (store.getAgentNames?.() ?? []) : [...new Set(agentNames.map((name) => name.trim()).filter(Boolean))]
      const namesChanged = JSON.stringify(nextAgentNames) !== JSON.stringify(store.getAgentNames?.() ?? [])
      const nextWorkspace = workspaceDir === undefined ? agentWorkspace : await resolveAgentWorkspace(workspaceDir)
      const nextSelection = {
        provider: selection.provider,
        model: model === undefined ? selection.model : model.trim(),
        ...(reasoningEffort === undefined ? (selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) : reasoningEffort === '' ? {} : { reasoningEffort }),
      }
      if (nextSelection.model === '') throw new Error('agent_model_required')
      const workspaceChanged = nextWorkspace !== agentWorkspace
      const selectionChanged = nextSelection.model !== selection.model || nextSelection.reasoningEffort !== selection.reasoningEffort
      const nextProxyUrl = proxyUrl === undefined ? (store.getProxyUrl?.() ?? '') : proxyUrl.trim()
      if (nextProxyUrl !== '' && !/^https?:\/\//i.test(nextProxyUrl)) throw new Error('agent_proxy_url_invalid')
      const proxyChanged = nextProxyUrl !== (store.getProxyUrl?.() ?? '')
      const nextTaskExecutionGuidance = taskExecutionGuidance === undefined ? (store.getTaskExecutionGuidance?.() ?? '') : taskExecutionGuidance.trim()
      const nextTaskEvidenceGuidance = taskEvidenceGuidance === undefined ? (store.getTaskEvidenceGuidance?.() ?? '') : taskEvidenceGuidance.trim()
      const guidanceChanged = nextTaskExecutionGuidance !== (store.getTaskExecutionGuidance?.() ?? '') || nextTaskEvidenceGuidance !== (store.getTaskEvidenceGuidance?.() ?? '')
      const nextMaxConcurrentTasks = nextMaxConcurrentTasksInput === undefined ? taskConcurrencyLimit : nextMaxConcurrentTasksInput
      if (!Number.isInteger(nextMaxConcurrentTasks) || nextMaxConcurrentTasks < 1 || nextMaxConcurrentTasks > 50) throw new Error('agent_max_concurrent_tasks_invalid')
      const concurrencyChanged = nextMaxConcurrentTasks !== taskConcurrencyLimit
      const resultConfig = () => ({ agentNames: store.getAgentNames?.() ?? [], workspaceDir: agentWorkspace, ...selection, proxyUrl: nextProxyUrl, taskExecutionGuidance: store.getTaskExecutionGuidance?.() ?? '', taskEvidenceGuidance: store.getTaskEvidenceGuidance?.() ?? '', maxConcurrentTasks: taskConcurrencyLimit })
      if (!workspaceChanged && !selectionChanged && !proxyChanged && !guidanceChanged && !namesChanged && !concurrencyChanged) return resultConfig()
      if ((workspaceChanged || selectionChanged) && store.listTasks().some((task) => task.state === 'running' || task.state === 'waiting' || task.state === 'queued')) throw new Error('agent_config_has_active_tasks')
      const replacements = []
      try {
        if (workspaceChanged) {
          for (const group of store.listGroups()) {
            const previous = residentHandles.get(group.groupId)
            if (previous === undefined) throw new Error(`resident_not_active:${group.groupId}`)
            await previous.agent.whenIdle()
            const seed = [...previous.agent.session.events]
            const sessionId = `${residentSessionId(group.groupId)}-${randomUUID().slice(0, 8)}`
            const handle = await ctx.agents.create({ sessionId: SessionId(sessionId), seed, meta: { cwd: nextWorkspace, seedLength: seed.length }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
            applyFullAccess(handle)
            replacements.push({ group, previous, handle, sessionId })
          }
          await store.setAgentWorkspaceDir(nextWorkspace)
          for (const item of replacements) await store.updateGroup({ groupId: item.group.groupId, residentSessionId: item.sessionId })
          agentWorkspace = nextWorkspace
          for (const item of replacements) { residentHandles.set(item.group.groupId, item.handle); await item.previous.dispose() }
        }
        if (selectionChanged) {
          await ctx.agentDefaultModel.saveSelection(nextSelection)
          selection.provider = nextSelection.provider; selection.model = nextSelection.model
          if (nextSelection.reasoningEffort === undefined) delete selection.reasoningEffort
          else selection.reasoningEffort = nextSelection.reasoningEffort
        }
        if (proxyChanged) await store.setProxyUrl(nextProxyUrl)
        if (namesChanged) await store.setAgentNames(nextAgentNames)
        if (guidanceChanged) await store.setTaskGuidance({ taskExecutionGuidance: nextTaskExecutionGuidance, taskEvidenceGuidance: nextTaskEvidenceGuidance })
        if (concurrencyChanged) {
          await store.setMaxConcurrentTasks(nextMaxConcurrentTasks)
          taskConcurrencyLimit = nextMaxConcurrentTasks
          await pumpTasks()
        }
        return resultConfig()
      } catch (error) { await Promise.all(replacements.map((item) => item.handle.dispose())); throw error }
    }),
    unsubscribe: ({ groupId }) => serialize(groupId, async () => {
      if (store.listTasks().some((task) => task.groupId === groupId && (task.state === 'running' || task.state === 'waiting' || task.state === 'queued'))) throw new Error(`group_has_active_tasks:${groupId}`)
      const handle = residentHandles.get(groupId)
      if (handle !== undefined) { await handle.dispose(); residentHandles.delete(groupId) }
      const result = await store.removeGroup({ groupId })
      for (const listener of unsubscriptionListeners) listener({ groupId })
      return result
    }),
    setCurrentDwsUserName: (value) => { currentDwsUserName = typeof value === 'string' ? value.trim() : '' },
    async close() {
      if (supervisorTimer !== undefined) clearInterval(supervisorTimer)
      if (typeof disposeObserver === 'function') disposeObserver()
      const all = [...leafHandles.values(), ...residentHandles.values()]
      await ctx.subagents.drainContinuableDescendants(all.map((handle) => handle.agent))
      await Promise.all(all.map((handle) => handle.dispose()))
      leafHandles.clear(); residentHandles.clear(); leafTaskBySession.clear(); await activityTail; await store.close()
    },
  }
}
