import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { blockTaskDecisionForUnavailableMedia, buildDecisionPrompt, buildLeafSourceEnvelope, groupDecisionJsonSchema, shouldRecheckTaskAssociation, validateGroupDecision } from './decision.js'
import { parseTaskCheckpoint, parseTaskResult } from './task-result.js'

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
const isGoalRoundLimitExhausted = (goal) => Number.isInteger(goal?.roundsStarted)
  && Number.isInteger(goal?.maxGoalRounds)
  && goal.roundsStarted >= goal.maxGoalRounds
  && (goal.phase === 'blocked' || goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed'))
const withHumanBlockerHistory = (task, blocker) => {
  const history = task.humanBlockerHistory ?? []
  const index = history.findIndex((item) => item.requestId === blocker.requestId)
  return index < 0 ? [...history, blocker] : history.map((item, current) => current === index ? blocker : item)
}
const activityDetail = (event) => {
  if (event.type === 'tool/call') return { tool: event.data?.name ?? 'unknown', ...(event.data?.callId ? { callId: event.data.callId } : {}) }
  if (event.type === 'tool/result') return { tool: event.data?.name ?? 'unknown', isError: event.data?.isError === true, ...(event.data?.message?.source?.callId ? { callId: event.data.message.source.callId } : {}) }
  if (event.type === 'turn/end') return { status: event.data?.status ?? 'unknown' }
  if (event.type === 'goal/change') return { phase: event.data?.goal?.phase ?? event.data?.phase ?? 'unknown' }
  return { contentBlocks: event.data?.message?.content?.length ?? 0 }
}

export async function openResidentRuntime(ctx, store, cwd, { agentPreset = 'standard', agentWorkspaceDir, resumeTimeoutMs = 10_000, maxConcurrentTasks = 5, maxGoalRounds = 24, supervisorIntervalMs = 5_000 } = {}) {
  const residentHandles = new Map(), leafHandles = new Map(), leafTaskBySession = new Map(), pausedRecoveryCounts = new Map(), resultRecoveryCounts = new Map(), tails = new Map(), inflightMessages = new Map(), pendingGroupDecisions = new Map()
  const agentPresets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  const attachments = ctx.get?.('attachments') ?? ctx.attachments
  const recoveryIssues = [], subscriptionListeners = new Set(), unsubscriptionListeners = new Set(), outboxListeners = new Set(), humanBlockerListeners = new Set(), authorizationDecisionListeners = new Set(), bufferedOutboxEvents = []
  let taskTail = Promise.resolve(), activityTail = Promise.resolve(), supervisorTimer, currentDwsUserName = ''
  let groupMessageRecaller
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
  const resumeGoalAfterResolution = (handle, goal) => {
    let resumable = goal
    if (isGoalRoundLimitExhausted(resumable)) {
      resumable = ctx.goals.edit(handle.agent, goalRef(resumable), { maxGoalRounds: resumable.maxGoalRounds + maxGoalRounds })
    }
    if (resumable?.phase === 'blocked' || resumable?.phase === 'paused' || (resumable?.phase === 'active' && resumable.activation === 'disarmed')) {
      return ctx.goals.resume(handle.agent, goalRef(resumable))
    }
    return resumable
  }
  const ensureLeafDescriptor = (handle, task) => {
    const ownEvents = handle.agent.session.events.slice(handle.agent.session.meta?.seedLength ?? 0)
    if (ownEvents.some((event) => event.type === 'subagent/descriptor')) return
    handle.agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'dingtalk-dsh-assistant',
      label: leafDisplayName(task.title ?? task.objective),
      agentProvider: agentOptions.provider,
      agentModel: agentOptions.model,
    }))
  }
  const residentSetup = (groupId) => async (agentCtx) => {
    if (agentPresets === undefined) throw new Error('agent_presets_required')
    const preset = await agentPresets.mount(agentCtx, agentPreset)
    if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error(`resident_agent_preset_invalid:${preset.id}`)
    configureResident(agentCtx, groupId)
  }
  function configureResident(agentCtx, groupId) {
    installSelection(agentCtx)
    agentCtx.tools.restrict({ deny: ['get_goal', 'create_goal', 'update_goal'] })
    agentCtx.systemPrompt.section({ name: 'tool:goal', order: 114, text: '' })
    registerResidentDecisionTool(agentCtx, groupId)
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
          .map((task) => ({ taskId: task.taskId, objective: task.title ?? task.objective, state: task.state, archived: Boolean(task.archivedAt) }))
        return `## 本群全部任务关联索引\n\n${active.length === 0 ? '无。' : JSON.stringify(active)}`
      },
    })
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-decision-protocol', order: 41,
      text: () => `## 群消息决策协议

收到以 \`[GROUP_MESSAGE_STEER]\` 开头的群消息信封或 \`[GROUP_DECISION_RECHECK]\` 复核请求时，必须通过 \`group_decision_submit\` 提交结构化判断，不得用 assistant 文本输出 JSON。每个信封携带一个判断请求 ID；处理完成一个或多个请求后即可调用工具，不需要等待 turn 结束。你可以在一次工具调用中提交多个 submission，也可以让一个 submission 覆盖多个 requestIds。由你结合完整上下文判断消息相关、部分相关或无关：共享一个业务判断的请求放在同一 submission，独立事项分别提交；Runtime 不替你按顺序、关键词或固定窗口分组。每个 pending request ID 必须且只能成功提交一次。\`[GROUP_DECISION_RECHECK]\` 是已有判断的内部复核，只提交它自己的请求 ID，不与新群消息请求合并。

Decision 仅回答使用 \`{"actions":[],"reply":"..."}\`，忽略为 \`{"actions":[],"reason":"原因"}\`，涉及任务时使用 \`{"actions":[...],"reply":"最多一条群回复，可为空"}\`。Decision 顶层不允许 kind 字段。一个 Decision 可以同时对应多个 Task，\`actions\` 中每项可为 task-proposal、new-task、task-context 或 task-reopen；不得为了只返回一个动作而遗漏其他相关 Task。群回复统一放在顶层 \`reply\`，不得给每个动作分别回复。

每次收到新消息时，检查其内容是否与当前 Session 上下文中的近期回复冲突；如有冲突，及时撤回本主会话发送的错误消息并订正。不得撤回真人或其他系统消息。

\`title\` 是不超过 120 字的简洁任务名，只概括被授权的事项，不得包含消息信封、发送人、完成状态或未经核验的根因。\`objective/context\` 用于主会话选路、动作授权和可观测记录，不得在其中编造或强化根因、完成度、方案优劣或排除性结论；叶子还会收到 Runtime 从原始群消息生成的独立来源证据信封并自行核验。

新建任务必须提供至少一条 \`acceptanceCriteria\`；修订目标时也可更新 \`acceptanceCriteria\` 和 \`stageTasks\`。验收标准只描述当前目标可核验的完成条件，不得按开发、分析、部署等任务类型绑定固定模板，也不得扩大消息授权范围。

当前消息明确指名或提及已配置的 Agent 名称/别名、以 \`cc:\` 开头，或者明确确认了主会话此前提出的“是否需要我处理”询问，并且事项属于本群职责且形成可验证目标时，才允许选择 new-task。未明确指名、但你判断事项应形成任务时，必须选择 task-proposal，并在群里询问“这个事项是否需要我处理？”，暂不创建 Task；收到肯定答复后再结合原消息及其后补充选择 new-task。${currentDwsUserName ? `仅提及当前 DWS 登录人“${currentDwsUserName}”不能单独构成 Agent 的建任务、回复或执行授权。` : ''}同事间讨论、事实陈述或未形成可验证目标的内容不得创建任务；与现有任务相关时只做任务关联或补充上下文，并按下方节制原则简短确认。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。

任务目标必须忠实保留消息中的动作范围，不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务。诊断任务的完成条件只能是核验现状、定位根因、给出证据与建议；只有消息明确要求修复、修改、处理问题或实施方案时，new-task 或 task-proposal 的 objective 才能包含变更动作。后续消息可能明确扩大或收窄同一任务的动作范围；此时仍关联原 Task，并在 task-context 或 task-reopen 中填写修订后的累计完整 objective。普通事实补充不得填写 objective。是否明确指名只决定直接处理还是先询问，不构成扩大任务授权。

消息附带的图片属于当前消息正文，必须先阅读图片，再结合固定主会话中的前后消息和“本群全部任务关联索引”判断关联性。queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断；任务状态只决定关联后的动作，不得成为忽略关联的理由。不得仅因文字部分没有指名、图片没有文字摘要或后续消息较短就选择忽略；紧邻图片的补充说明应优先与该图片共同理解。群友对根因、状态或外部因素的未经核验判断，只要与已有任务相关，就是需要核验的新增线索，不得以“尚未核验”为由忽略。已存在任务的新增事实应优先关联已有任务，而不是创建重复任务。对已完成任务的结果提出回滚、撤回、还原、纠正或补做，属于原任务的结果纠正，必须返回 task-reopen 唤起原 Task，不得只做自然语言承诺，也不得创建新 Task；只有与原目标不同的独立可执行目标才创建新任务并保留历史关联。

判断使用已有任务还是新建任务时，必须进行整体语义判断：结合当前消息的前后文、引用关系、连续消息构成的信息组、当时讨论与执行场景，以及候选任务的目标、动作范围、状态、历史触发和已记录上下文，判断新消息是在补充、修订、纠正或延续原目标，还是提出了不同的独立目标。不得根据某几个关键词、词面重合、标题相似或单一字段直接决定复用已有任务或新建任务；关键词只能作为查找候选任务的线索，不能代替关联结论。无法从现有上下文可靠区分时，不得猜测创建重复任务，应先结合近期消息继续核对，确有阻塞再向原提出人询问必要信息。

图片、文档、文件、链接或其他外部资源如果承载任务目标、范围、对象、输入数据或验收要求，必须先通过当前可用工具完整读取。任何任务所需资源无法访问、下载、解析或读取不完整时，必须选择 answer，明确告诉对方未获取到的具体信息以及需要重新提供的内容；此时不得选择 new-task、task-context 或 task-reopen，也不得先创建或推进 Task。只有确认缺失资源与任务无关，或对方补齐必要信息后，才继续任务关联与准入判断。不得假设资源内容、不得用文件名、链接标题、缩略图或消息中的零散文字替代未读取的正文。

状态边界必须严格遵守：running 或 waiting（包括阻塞中）的 Task 收到新增信息时只能返回 task-context，继续同一执行轮次；不得返回 task-reopen，不得清空 blocker 或增加轮次。只有 completed Task（包括已归档展示）才允许 task-reopen 并初始化下一执行轮次。

同事或其 AI 助理发送的回复、任务回执和状态通知都是正常群消息，必须进入本协议由你结合引用消息、上下文和任务索引判断，不得按固定文案或发送者在模型外预先过滤。若消息只是对已完成通知的自动回执，没有提出新事实、问题、纠正或执行要求，应选择 ignore；只有确实需要向群里补充新信息时才选择 answer，不要回复“无需重复创建任务”之类没有新增价值的确认。

### 群聊回复节制原则

理解消息、关联任务和回复群聊是三个独立决定。每条消息都必须完成任务关联和近期消息冲突检查。以下情况允许 reply 非空：消息明确要求 Agent 立即回答且当前已有可核验答案；必须询问一个只有原提出人才能补充且确实阻塞任务的信息；Task 产生新的最终结果、明确失败结果或需要真人行动的结论；需要订正或撤回本主会话此前发送的错误消息；已创建或正在处理的 Task 收到新的执行线索、补充信息或处理要求时，简短确认已收到并会继续处理。

过程确认和信息确认必须简短，只确认已收到、已关联 Task 或将继续处理，不得复述、改写或逐项罗列对方提供的信息，不得虚构进度、结果或完成时间。给活动 Task 补充 IP、库名、schema、文件、截图、字段范围或其他执行线索时，应返回简短确认；叶子已在执行且当前消息作为 task-context 转交时，也应简短确认会结合补充信息继续处理。

以下情况必须 reply 为空或选择 ignore：同事之间的讨论、确认、纠正或短句接龙且未明确要求 Agent 回答，也与本 Agent 的 Task 无关；没有新增信息，只是复述已有结论或重复确认任务仍在进行；仅因消息提及当前 DWS 登录人姓名。

同一事项短时间内连续出现的文本、文件、图片和补充说明属于一个信息组。文件或图片前后的短句不得分别追问；信息仍可能继续补充时先静默关联，只有信息组稳定后仍存在真正阻塞，才能一次性询问。同一 Task 在上一条群通知之后没有产生新结果、真实阻塞或必要订正时，不得再次发状态通知。

发送前必须执行回复节制门禁：确认回复只表达“已收到并会继续处理”这一必要状态，使用一句短句，不得重复对方提供的信息；结果、阻塞、提问或订正回复只保留同事必须知道的新事实、必须回答的问题或明确行动。

上述提交协议仅用于 \`[GROUP_MESSAGE_STEER]\` 群消息信封，此时除 \`group_decision_submit\` 外不得调用任务工具。用户在 Web 主会话中直接要求创建、续接或查询任务时，使用本会话提供的 DSH 原生任务工具；主会话只负责沟通协调，实际执行由 Runtime 创建的独立叶子会话完成。`,
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
  function createPendingGroupDecision({ groupId, messageId, sequence, message, imageRefs, kind = 'message' }) {
    const requestId = randomUUID()
    let resolve, reject
    const promise = new Promise((resolvePending, rejectPending) => { resolve = resolvePending; reject = rejectPending })
    promise.catch(() => undefined)
    pendingGroupDecisions.set(requestId, { requestId, groupId, messageId, sequence, message, imageRefs, kind, resolve, reject })
    return { requestId, promise }
  }
  function rejectPendingGroupDecision(requestId, error) {
    const pending = pendingGroupDecisions.get(requestId)
    if (pending === undefined) return
    pendingGroupDecisions.delete(requestId)
    pending.reject(error)
  }
  function rejectUnsubmittedGroupDecisionWhenIdle(agent, requestId, groupId, messageId) {
    agent.whenIdle().then(() => rejectPendingGroupDecision(requestId, new Error(`group_decision_not_submitted:${groupId}:${messageId}`)))
      .catch((error) => rejectPendingGroupDecision(requestId, error))
  }
  function assertResidentToolSession(exec, groupId) {
    const expected = residentHandles.get(groupId)?.agent?.session?.id
    if (expected === undefined || String(exec.agent?.session?.id) !== String(expected)) throw new Error(`resident_tool_wrong_session:${groupId}`)
  }
  function registerResidentDecisionTool(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_decision_submit',
      description: 'Submit one or more completed group-message decisions at the current step. The model decides which pending request IDs share one decision; the Runtime validates ownership and commits each shared decision once.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['submissions'], properties: {
          submissions: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['requestIds', 'decision'], properties: {
              requestIds: { type: 'array', items: { type: 'string' } },
              decision: groupDecisionJsonSchema,
            },
          } },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['acceptedRequestIds'], properties: { acceptedRequestIds: { type: 'array', items: { type: 'string' } } } },
        render: (_args, out) => [{ type: 'text', text: `已接收 ${out.acceptedRequestIds.length} 个群消息判断请求。` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        if (args.submissions.length === 0 || args.submissions.some((submission) => submission.requestIds.length === 0)) throw new Error('group_decision_submission_empty')
        if (args.submissions.some((submission) => submission.requestIds.some((requestId) => requestId.trim() === ''))) throw new Error('group_decision_request_invalid')
        const requestIds = args.submissions.flatMap((submission) => submission.requestIds)
        if (new Set(requestIds).size !== requestIds.length) throw new Error('group_decision_request_duplicate')
        const pendings = requestIds.map((requestId) => pendingGroupDecisions.get(requestId))
        if (pendings.some((pending) => pending === undefined)) throw new Error('group_decision_request_unknown')
        if (pendings.some((pending) => pending.groupId !== groupId)) throw new Error('group_decision_request_wrong_group')
        if (args.submissions.some((submission) => submission.requestIds.some((requestId) => pendingGroupDecisions.get(requestId).kind === 'recheck') && submission.requestIds.length !== 1)) throw new Error('group_decision_recheck_must_submit_alone')
        const validated = args.submissions.map((submission) => ({
          requestIds: [...submission.requestIds],
          decision: validateGroupDecision(submission.decision),
          requests: submission.requestIds.map((requestId) => pendingGroupDecisions.get(requestId)).sort((left, right) => left.sequence - right.sequence),
        }))
        for (const submission of validated) {
          let resolveCommitted, rejectCommitted
          const committed = new Promise((resolve, reject) => { resolveCommitted = resolve; rejectCommitted = reject })
          committed.catch(() => undefined)
          const ownerRequestId = submission.requests[0].requestId
          const result = { decision: submission.decision, requestIds: submission.requestIds, ownerRequestId, requests: submission.requests, committed, resolveCommitted, rejectCommitted }
          for (const pending of submission.requests) {
            pendingGroupDecisions.delete(pending.requestId)
            pending.resolve(result)
          }
        }
        return { acceptedRequestIds: requestIds }
      },
    })
  }
  function registerResidentTaskTools(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_task_create',
      description: 'Create a durable group task and let the DSH Runtime start an independent leaf Session. Use only for an explicit Web-user direction within this group responsibility.',
      parameters: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, objective: { type: 'string' }, sourceMessageId: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } } }, required: ['title', 'objective', 'sourceMessageId', 'acceptanceCriteria'] },
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
          const created = await store.createTask({ groupId, sourceMessageId, title: args.title, objective, requesterName: source?.senderName, requesterOpenDingTalkId: source?.senderOpenDingTalkId, occurredAt: source?.occurredAt, acceptanceCriteria: args.acceptanceCriteria })
          await pumpTasks()
          return { created: created.created, task: store.getTask(created.task.taskId) }
        })
        return { created: result.created, taskId: result.task.taskId, state: result.task.state, childSessionId: result.task.childSessionId }
      },
    })
    agentCtx.tools.register({
      name: 'group_task_context_append',
      description: 'Append raw user wording or a stable verified fact to an active task. Do not add coordinator conclusions about cause, completion, or solution.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, context: { type: 'string' }, objective: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, stageTasks: { type: 'array', items: { type: 'string' } } }, required: ['taskId', 'context'] },
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
          task = await appendTaskContextInternal(task, context, undefined, args.objective, args.acceptanceCriteria, args.stageTasks)
          return { accepted: true, taskId: task.taskId, state: task.state }
        })
      },
    })
    agentCtx.tools.register({
      name: 'group_task_reopen',
      description: 'Reopen a completed task with raw user wording or a stable verified fact. Do not add coordinator conclusions about cause, completion, or solution.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, context: { type: 'string' }, objective: { type: 'string' }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, stageTasks: { type: 'array', items: { type: 'string' } } }, required: ['taskId', 'context'] },
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
          const reopened = await reopenCompletedTaskInternal(task, context, undefined, args.objective, args.acceptanceCriteria, args.stageTasks)
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
        return { tasks: store.listTasks().filter((task) => task.groupId === groupId).map(({ taskId, title, objective, state, childSessionId, waitingReason, completion }) => ({
          taskId, objective: title ?? objective, state, childSessionId,
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
  async function reviewCompletedTaskResult(task, result) {
    const handle = residentHandles.get(task.groupId)
    if (handle === undefined) throw new Error(`resident_not_active:${task.groupId}`)
    await handle.agent.whenIdle()
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[TASK_COMPLETION_REVIEW]\nTask ID: ${task.taskId}\n执行轮次：${task.runSequence ?? 1}\n当前有效目标：${task.objective}\n本轮验收标准：${JSON.stringify(task.acceptanceCriteria ?? [task.objective])}\n本轮阶段任务：${JSON.stringify(task.stageTasks ?? [])}\n本轮完成结果：${JSON.stringify({ summary: result.summary, evidence: result.evidence, artifacts: result.artifacts, delivery: result.delivery })}\n\n这是 Host 发给主会话的内部完成验收，不得回复群聊、不得写入发信箱。判断本轮证据是否覆盖当前有效目标和全部验收标准，尤其是最近新增或修订的范围。历史目标已经完成不代表新增范围完成；结果明确承认某项目未完成、缺少证据或尚未验证时必须拒绝。只输出严格 JSON：通过 {"accepted":true,"reason":"..."}；拒绝 {"accepted":false,"reason":"具体缺口"}。` }],
      source: { kind: 'coordinator' },
    }))
    await handle.agent.whenIdle()
    const reply = handle.agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    let review
    try { review = JSON.parse(reply) } catch (error) { throw new Error(`task_completion_review_invalid_json:${task.taskId}`, { cause: error }) }
    if (typeof review !== 'object' || review === null || typeof review.accepted !== 'boolean' || typeof review.reason !== 'string' || review.reason.trim() === '' || Object.keys(review).some((key) => key !== 'accepted' && key !== 'reason')) throw new Error(`task_completion_review_invalid_schema:${task.taskId}`)
    return review
  }
  const createResident = async (_groupId, options) => ({ handle: await ctx.agents.create(options) })

  const isSyntheticTaskSource = (sourceMessageId) => typeof sourceMessageId === 'string' && /^(?:web(?:-reopen)?:|recovery:)/u.test(sourceMessageId)

  function resolveTaskNotificationTrigger(task) {
    const current = { sourceMessageId: task.sourceMessageId, requesterName: task.requesterName, requesterOpenDingTalkId: task.requesterOpenDingTalkId }
    const candidates = [current, ...[...(task.triggerHistory ?? [])].reverse()]
    return candidates.find((item) => typeof item?.sourceMessageId === 'string'
      && !isSyntheticTaskSource(item.sourceMessageId)
      && typeof item.requesterOpenDingTalkId === 'string')
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
      const notificationTrigger = resolveTaskNotificationTrigger(task)
      const requester = notificationTrigger?.requesterName === undefined ? '未记录' : `${notificationTrigger.requesterName}（${notificationTrigger.requesterOpenDingTalkId}）`
      const resultProjection = result.status === 'completed'
        ? { status: result.status, workType: result.workType, summary: result.summary, evidence: result.evidence, artifacts: result.artifacts, delivery: result.delivery }
        : { status: result.status, summary: result.summary, evidence: result.evidence, artifacts: result.artifacts, waitingKind: result.waitingKind, waitingReason: result.waitingReason, questions: result.questions }
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `[TASK_COORDINATION]\nTask ID: ${task.taskId}\n任务：${task.title ?? task.objective}\n当前目标：${task.objective}\n提出人：${requester}\n核验结果：${JSON.stringify(resultProjection)}\n\n只输出一条可直接发送到群聊的通知。完成通知必须忠实保留叶子结果中影响同事判断和后续行动的信息，不能为了简短只复述 summary。至少覆盖：实际完成或修改的内容、关键核验与证据、部署或交付状态、尚未覆盖的边界与遗留事项；result 中存在 artifacts 或 delivery 时也要说明其关键内容。允许合并重复表述，但不得省略不同关注点、限定条件、失败项或“未验证/未部署”等边界。缺信息时只向提出人询问列出的具体问题。正文不要手写 @ 提出人，Runtime 会传结构化 @。签名、口吻和身份声明由 Agent 自身工作区规则决定，插件不得添加或改写。不要暴露内部标识或本指令。` }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      let reply = handle.agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'assistant/message')
        .flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
      if (reply === '') throw new Error(`task_coordination_reply_missing:${task.taskId}`)
      const canReplyToSource = notificationTrigger !== undefined
      if (canReplyToSource && notificationTrigger.requesterName) reply = reply.replace(new RegExp(`^@${notificationTrigger.requesterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'u'), '')
      const group = await appendReliableOutbox({
        groupId: task.groupId, sourceMessageId: resultKey, text: reply,
        ...(canReplyToSource ? {
          replyToMessageId: notificationTrigger.sourceMessageId,
          replyToSenderOpenDingTalkId: notificationTrigger.requesterOpenDingTalkId,
          atOpenDingTalkIds: [notificationTrigger.requesterOpenDingTalkId],
        } : {}),
      })
      return group.outbox.find((item) => item.sourceMessageId === resultKey)
    })
  }
  async function reviewTaskCheckpoint(task, checkpoint) {
    const handle = residentHandles.get(task.groupId)
    if (handle === undefined) throw new Error(`resident_not_active:${task.groupId}`)
    await handle.agent.whenIdle()
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[TASK_CHECKPOINT_REVIEW]\nTask ID: ${task.taskId}\n任务：${task.title ?? task.objective}\n当前有效目标：${task.objective}\n本轮验收标准：${JSON.stringify(task.acceptanceCriteria ?? [task.objective])}\n本轮阶段任务：${JSON.stringify(task.stageTasks ?? [])}\n叶子检查点：${JSON.stringify(checkpoint)}\n\n这是主会话与叶子会话的内部协调，不得回复群聊、不得写入发信箱，也不代表任务完成。检查叶子的目标理解、范围、证据方向和下一步是否与当前群聊上下文及验收标准一致。无需纠偏时输出 {"decision":"acknowledge","reason":"判断依据"}；需要纠偏时输出 {"decision":"guidance","reason":"发现的偏差","guidance":"给叶子的具体调整要求"}。只输出严格 JSON。` }],
      source: { kind: 'coordinator' },
    }))
    await handle.agent.whenIdle()
    const reply = handle.agent.session.events.filter((event) => event.seq >= firstSeq && event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content).filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    let review
    try { review = JSON.parse(reply) } catch (error) { throw new Error(`task_checkpoint_review_invalid_json:${task.taskId}`, { cause: error }) }
    if (typeof review !== 'object' || review === null || !['acknowledge', 'guidance'].includes(review.decision) || typeof review.reason !== 'string' || review.reason.trim() === '' || Object.keys(review).some((key) => !['decision', 'reason', 'guidance'].includes(key))) throw new Error(`task_checkpoint_review_invalid_schema:${task.taskId}`)
    if (review.decision === 'guidance' && (typeof review.guidance !== 'string' || review.guidance.trim() === '')) throw new Error(`task_checkpoint_guidance_missing:${task.taskId}`)
    if (review.decision === 'acknowledge' && review.guidance !== undefined) throw new Error(`task_checkpoint_guidance_unexpected:${task.taskId}`)
    return { decision: review.decision, reason: review.reason.trim(), ...(review.guidance ? { guidance: review.guidance.trim() } : {}) }
  }
  async function resumeResident(group) {
    if (residentHandles.has(group.groupId)) return residentHandles.get(group.groupId)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(group.residentSessionId), agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
    if (group.residentAgentPreset !== agentPreset) {
      await store.updateGroup({ groupId: group.groupId, residentAgentPreset: agentPreset })
    }
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
        resumeGoalAfterResolution(handle, ctx.goals.get(handle.agent))
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
    const checkpoints = task.checkpoints ?? []
    if (checkpoints[0]?.kind !== 'plan-confirmed') throw new Error(`task_checkpoint_plan_required:${taskId}`)
    if (checkpoints.length < 2) throw new Error(`task_checkpoints_insufficient:${taskId}`)
    if ((checkpoints.at(-1)?.remainingItems?.length ?? 0) > 0) throw new Error(`task_checkpoints_remaining:${taskId}`)
    const review = await withoutInitiator(() => reviewCompletedTaskResult(task, result))
    if (!review.accepted) {
      await followupTaskInternal(task, `[TASK_RESULT_REJECTED]\n当前完成结果未通过最新目标验收：${review.reason}\n\n继续执行当前有效目标，补齐缺失实现与证据后再提交 completed。不得重复提交上一轮结论。`)
      throw new Error(`task_result_objective_not_covered:${taskId}:${review.reason}`)
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
  async function submitTaskResult(taskId, value) {
    const result = parseTaskResult(value)
    if (result.status !== 'completed') return serializeTasks(() => submitTaskResultInternal(taskId, result))
    const prepared = await serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined || task.state === 'queued' || task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
      const handle = leafHandles.get(taskId)
      if (handle === undefined) throw new Error(`task_leaf_not_active:${taskId}`)
      const goal = ctx.goals.get(handle.agent)
      if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
      const checkpoints = task.checkpoints ?? []
      if (checkpoints[0]?.kind !== 'plan-confirmed') throw new Error(`task_checkpoint_plan_required:${taskId}`)
      if (checkpoints.length < 2) throw new Error(`task_checkpoints_insufficient:${taskId}`)
      if ((checkpoints.at(-1)?.remainingItems?.length ?? 0) > 0) throw new Error(`task_checkpoints_remaining:${taskId}`)
      return { task, handle, lastCheckpointId: checkpoints.at(-1).checkpointId }
    })
    const review = await withoutInitiator(() => reviewCompletedTaskResult(prepared.task, result))
    if (!review.accepted) {
      await followupTaskInternal(prepared.task, `[TASK_RESULT_REJECTED]\n当前完成结果未通过最新目标验收：${review.reason}\n\n继续执行当前有效目标，补齐缺失实现与证据后再提交 completed。不得重复提交上一轮结论。`)
      throw new Error(`task_result_objective_not_covered:${taskId}:${review.reason}`)
    }
    const completed = await serializeTasks(async () => {
      const current = store.getTask(taskId)
      if (current === undefined || current.state === 'queued' || current.state === 'completed') throw new Error(`task_not_active:${taskId}`)
      if (current.runSequence !== prepared.task.runSequence || current.objective !== prepared.task.objective || current.checkpoints?.at(-1)?.checkpointId !== prepared.lastCheckpointId) throw new Error(`task_result_context_changed:${taskId}`)
      const goal = ctx.goals.get(prepared.handle.agent)
      if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
      if (goal.phase !== 'complete') ctx.goals.complete(prepared.handle.agent, goalRef(goal))
      return store.updateTask(taskId, (task) => ({ ...task, state: 'completed', completion: result.summary, result, waitingKind: undefined, waitingReason: undefined }))
    })
    await withoutInitiator(() => coordinateTaskResult(completed, result))
    prepared.handle.agent.whenIdle().then(async () => {
      if (leafHandles.get(taskId) !== prepared.handle) return
      leafHandles.delete(taskId); leafTaskBySession.delete(String(prepared.handle.agent.session.id)); await prepared.handle.dispose()
    }).catch(() => undefined)
    await serializeTasks(() => withoutInitiator(() => pumpTasks()))
    return completed
  }
  async function submitTaskCheckpointInternal(taskId, value) {
    const checkpoint = parseTaskCheckpoint(value)
    const { submitted, reviewTask } = await serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined || task.state !== 'running') throw new Error(`task_not_running:${taskId}`)
      if (!leafHandles.has(taskId)) throw new Error(`task_leaf_not_active:${taskId}`)
      if ((task.checkpoints?.length ?? 0) === 0 && checkpoint.kind !== 'plan-confirmed') throw new Error(`task_checkpoint_plan_required:${taskId}`)
      if (checkpoint.kind === 'plan-confirmed' && checkpoint.remainingItems.length < 2) throw new Error(`task_checkpoint_plan_insufficient:${taskId}`)
      if (checkpoint.kind === 'stage-completed' && (!checkpoint.stageTask || !(task.stageTasks ?? []).includes(checkpoint.stageTask))) throw new Error(`task_checkpoint_stage_invalid:${taskId}`)
      const previousRemainingItems = task.checkpoints?.at(-1)?.remainingItems ?? []
      if (checkpoint.kind === 'stage-completed') {
        const completesCurrentItem = checkpoint.completedItems.length === 1 && checkpoint.completedItems[0] === previousRemainingItems[0]
        const keepsRemainingOrder = checkpoint.remainingItems.length === Math.max(0, previousRemainingItems.length - 1) && checkpoint.remainingItems.every((item, index) => item === previousRemainingItems[index + 1])
        if (!completesCurrentItem || !keepsRemainingOrder) throw new Error(`task_checkpoint_must_advance_one:${taskId}:${previousRemainingItems[0] ?? 'none'}`)
      } else if (checkpoint.kind !== 'plan-confirmed' && (checkpoint.remainingItems.length !== previousRemainingItems.length || checkpoint.remainingItems.some((item, index) => item !== previousRemainingItems[index]))) {
        throw new Error(`task_checkpoint_progress_requires_stage_completed:${taskId}`)
      }
      const submitted = { ...checkpoint, checkpointId: `checkpoint-${randomUUID()}`, submittedAt: new Date().toISOString() }
      const reviewTask = await store.updateTask(taskId, (current) => ({ ...current, checkpoints: [...(current.checkpoints ?? []), submitted], updatedAt: new Date().toISOString() }))
      return { submitted, reviewTask }
    })
    const review = await withoutInitiator(() => reviewTaskCheckpoint(reviewTask, checkpoint))
    await serializeTasks(async () => {
      const current = store.getTask(taskId)
      if (current?.runSequence !== reviewTask.runSequence) throw new Error(`task_checkpoint_run_changed:${taskId}`)
      await store.updateTask(taskId, (task) => ({
        ...task,
        checkpoints: (task.checkpoints ?? []).map((item) => item.checkpointId === submitted.checkpointId ? { ...item, coordinatorDecision: review.decision, coordinatorReason: review.reason, ...(review.guidance ? { guidance: review.guidance } : {}), reviewedAt: new Date().toISOString() } : item),
        updatedAt: new Date().toISOString(),
      }))
    })
    return { accepted: true, taskId, checkpointId: submitted.checkpointId, coordinatorDecision: review.decision, reason: review.reason, ...(review.guidance ? { guidance: review.guidance } : {}) }
  }
  const listAuthorizationRequests = () => store.listTasks().flatMap((task) => {
    const requests = new Map()
    for (const blocker of [...(task.humanBlockerHistory ?? []), ...(task.humanBlocker ? [task.humanBlocker] : [])]) requests.set(blocker.requestId, blocker)
    return [...requests.values()].map((blocker) => ({
      ...blocker, taskId: task.taskId, groupId: task.groupId, objective: task.title ?? task.objective,
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
    resumeGoalAfterResolution(handle, goal)
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
      if (inheritedPreset !== agentPreset) throw new Error(`leaf_agent_preset_invalid:${inheritedPreset ?? 'none'}`)
      installSelection(agentCtx)
      agentCtx.systemPrompt.section({
        name: 'group-task-blocking-policy', order: 45,
        text: () => `## 群任务执行与完成规则

你必须通过 submit_task_result 结束任务；自然语言总结、Goal complete 或 turn end 都不构成 Task 完成。

### 工作区 Skill 的通用执行边界

根据当前任务现场与已注入描述命中任何适用 Skill 时，必须加载并遵循其完整说明。一旦加载 Skill，不得在尚未完成其资格判断、必要操作、验证与读回，或依据 Skill 说明明确判定本次无需操作之前，静默返回业务主线。没有满足执行条件时不得为了完成 Task 硬凑 Skill 产物。

Task objective 限制的是业务动作范围，包括业务代码、业务数据、部署环境、外部系统和对外操作。适用的工作区规则，或由工作区规则授权且由 Skill 明确要求的内部维护动作不视为扩大 Task objective，但必须严格限制在该规则和 Skill 声明的内部目录、数据类型和操作边界内，不得借此修改未获授权的业务代码、业务数据、环境或外部系统。Runtime 不指定或绑定任何具体 Skill，是否适用及如何执行以当前注入的 Skill 描述和完整说明为准。

### 与主会话的内部检查点

开始执行后必须先把当前目标拆成至少 2 个可核验检查点，并立即通过 submit_task_checkpoint 提交 plan-confirmed；remainingItems 逐项写入这些检查点。收到 TASK_OBJECTIVE_REVISED 后，必须根据修订后的完整目标重新提交 plan-confirmed，新的 remainingItems 是当前执行轮次的最新有效检查点清单。后续每完成一个有验收意义的检查点时单独提交一次 stage-completed：completedItems 必须且只能填写当前 remainingItems 的第一项，新 remainingItems 必须仅移除该第一项，不得一次批量完成多项。发现目标或范围冲突、证据缺口会影响验收、风险发生实质变化时继续提交对应 checkpoint，但不得在非 stage-completed 事件中改变 remainingItems。完成任务前必须逐项提交至 remainingItems 为空，不能从计划或未完成的检查点直接跳到 completed。提交 stage-completed 时，stageTask 必须逐字填写当前执行轮次阶段任务中的对应项，供 Host 计算业务进度。不要按时间周期汇报，不要提交普通命令进度、工具日志、等待流水线、重试或无新事实的状态。checkpoint 只用于内部协调，不会发送到群聊，也不代替 submit_task_result。主会话返回 guidance 时必须据此调整；若 guidance 与 Task objective 的授权边界冲突，提交 scope-conflict checkpoint，不得自行扩大授权。

### 任务授权边界

Task objective 是本任务的动作授权上限，必须逐字尊重其中的动作范围。若 objective 只要求“看看、查一下、排查、分析、核对、监控”或其他诊断/观察工作，你只能读取、核验、定位根因并提交证据和建议，不得修改代码或数据、提交 PR、合并、构建、部署、执行修复方案，也不得因为发现了明确根因就自行扩大为修复。只有 objective 明确包含修复、修改、实施、合并、发布或执行等变更动作时，才能进行对应变更；配置的任务流程引导和完成证据要求也不得扩大该授权。

### 配置的任务流程引导

${store.getTaskExecutionGuidance?.() || '未配置额外流程引导；按任务目标、工作区规则和当前现场自主推进。'}

### 配置的完成证据要求

${store.getTaskEvidenceGuidance?.() || '提交能够独立核验目标已完成的当前证据；不得只用自然语言声称完成。'}

### 当前执行轮次验收标准

${task.acceptanceCriteria?.length ? task.acceptanceCriteria.map((item) => `- ${item}`).join('\n') : `- ${task.objective}`}

### 当前执行轮次阶段任务

${task.stageTasks?.length ? task.stageTasks.map((item) => `- ${item}`).join('\n') : '- 完成并验证当前轮目标。'}

### 群聊后续关联上下文

${task.relatedContexts?.length ? task.relatedContexts.map((item) => `- ${item}`).join('\n') : '暂无。'}

### 已持久化的真人批复

${(task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').length
  ? (task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').map((item) => `- ${item.decision ?? 'answered'}｜${item.category}｜${item.requestedAction}｜答复：${item.reply ?? '未记录'}`).join('\n')
  : '暂无。'}

完成结果提交后由 Runtime 完整交给 resident 主会话，再由主会话判断如何通知原群任务负责人。群聊消息的发送、回复、编辑、更正和撤回均由 resident 主会话判断；叶子只提交业务结果、结论、证据、未验证项和置信边界，不得判断、建议或申请撤回/编辑/更正任何群消息，不得提供消息处置目标或 messageId。群聊通知只有 Runtime 这一个出口：叶子会话不得调用 DWS 或其他消息工具向来源群发送、回复、编辑或撤回任务进度、阻塞或完成通知，也不得把自行发送群通知作为完成证据；叶子只允许读取群消息用于业务核验，并通过 submit_task_result 提交结构化结果。

### 阻塞规则

除以下两类情况外，不得暂停或阻塞 Goal，也不得提交 waiting：
1. \`waitingKind=information\`：只有原任务提出人才能补充的目标、完成条件或必要业务信息不明确；必须提供具体 questions。
2. \`waitingKind=human-intervention\`：已经取得证据且自身无法解决的操作红线、网络中断、磁盘不足、资源不足、意外事件或必须真人确认的处置方案；必须提供 blockerCategory、risk、evidence、attemptedActions 和 requestedAction。risk 单独说明执行该操作可能造成的具体影响；操作红线使用 blockerCategory=redline，并把完整操作范围和不在授权内的事项写入 requestedAction；Runtime 只发送这一条阻塞审批消息。

代码错误、命令失败、可重试波动、普通不确定性、实现困难、正在正常运行但耗时较长的外部流水线，或 Goal 轮数即将/已经耗尽时，继续诊断、监控或由 Host 续接 Goal，不得 waiting。Goal 轮数是 Host 的执行预算，不是需要真人处理的业务阻塞。不要直接使用 Goal 工具标记 blocked；合法等待统一通过 submit_task_result 交给 Host 路由。`,
      })
      agentCtx.tools.register({
        name: 'submit_task_checkpoint',
        description: 'Submit an event-driven internal checkpoint to the resident coordinator and receive acknowledgement or corrective guidance. This never sends a group message.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['plan-confirmed', 'stage-completed', 'scope-conflict', 'evidence-gap', 'risk-changed'] }, stageTask: { type: 'string' }, summary: { type: 'string' },
          completedItems: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, remainingItems: { type: 'array', items: { type: 'string' } },
          nextStep: { type: 'string' }, needsCoordinatorDecision: { type: 'boolean' },
        }, required: ['kind', 'summary', 'completedItems', 'evidence', 'remainingItems', 'nextStep', 'needsCoordinatorDecision'] },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            accepted: { type: 'boolean', const: true }, taskId: { type: 'string' }, checkpointId: { type: 'string' }, coordinatorDecision: { type: 'string', enum: ['acknowledge', 'guidance'] }, reason: { type: 'string' }, guidance: { type: 'string' },
          }, required: ['accepted', 'taskId', 'checkpointId', 'coordinatorDecision', 'reason'] },
          render: (_args, out) => [{ type: 'text', text: out.coordinatorDecision === 'guidance' ? `Coordinator guidance: ${out.guidance}` : `Checkpoint acknowledged: ${out.reason}` }],
        },
        execute: async (args, exec) => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error(`task_checkpoint_wrong_session:${task.taskId}`)
          return submitTaskCheckpointInternal(task.taskId, args)
        },
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
          const updated = await submitTaskResult(task.taskId, args)
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
    if (task.state === 'running' && !isGoalRoundLimitExhausted(existing) && (
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
          if (isGoalRoundLimitExhausted(before)) {
            const reason = `DSH leaf Goal已耗尽执行轮数（${before.roundsStarted}/${before.maxGoalRounds}），但Task仍为running，已停止自动续接。`
            await submitTaskResultInternal(task.taskId, {
              status: 'waiting', waitingKind: 'human-intervention', summary: reason,
              evidence: [`Task ${task.taskId}`, `Session ${task.childSessionId}`, `Goal ${before.id} ${before.phase}/${before.activation ?? 'none'}`, `Goal rounds ${before.roundsStarted}/${before.maxGoalRounds}`, `Agent status ${handle.agent.status}`], artifacts: [], waitingReason: reason,
              blockerCategory: 'unexpected', risk: '任务执行已经中断，但若继续保留running状态会造成看板误报并占用并发名额。', attemptedActions: ['等待Goal Driver在既定轮数内完成任务'], requestedAction: '请检查叶子会话最后一次失败原因，处理外部依赖后引用本阻塞消息回复是否恢复任务。',
            })
            results.push({ taskId: task.taskId, ok: false, waiting: true, exhausted: true, agentStatus: handle.agent.status })
            continue
          }
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
        replaceTaskGoalObjective(task, handle)
        const running = await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running', reopenContext: undefined }))
        await followupTaskInternal(running, `[TASK_REOPEN]\n执行轮次：${task.runSequence}\n当前有效目标：${task.objective}\n本轮验收标准：${JSON.stringify(task.acceptanceCriteria)}\n本轮阶段任务：${JSON.stringify(task.stageTasks)}\n\n${task.reopenContext}\n\n这是独立的新执行轮次。历史轮次只供参考，不得把旧结果当成本轮完成证据；请独立核验当前事实，并在当前有效目标与原始来源消息的授权范围内重新提交可核验结果。`)
      } else {
        await createLeaf(task)
        await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running' }))
      }
      available -= 1
    }
  }
  function withRevisedObjective(current, objective, trigger) {
    const revised = typeof objective === 'string' ? objective.trim() : ''
    if (revised === '' || revised === current.objective) return current
    return {
      ...current,
      objective: revised,
      objectiveHistory: [...(current.objectiveHistory ?? []), {
        objective: current.objective,
        revisedAt: new Date().toISOString(),
        ...(trigger?.sourceMessageId ? { sourceMessageId: trigger.sourceMessageId } : {}),
      }],
    }
  }

  function normalizeRunPlan(objective, acceptanceCriteria, stageTasks) {
    const clean = (values) => Array.isArray(values) ? values.map((item) => String(item).trim()).filter(Boolean) : []
    const criteria = clean(acceptanceCriteria)
    const stages = clean(stageTasks)
    return { acceptanceCriteria: criteria.length > 0 ? criteria : [objective], stageTasks: stages.length > 0 ? stages : ['完成并验证当前轮目标'] }
  }

  function replaceTaskGoalObjective(task, handle) {
    const goal = ctx.goals.get(handle.agent)
    if (goal !== undefined && goal.phase !== 'complete') ctx.goals.complete(handle.agent, goalRef(goal))
    ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
  }

  async function reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks) {
    if (task.state !== 'completed') throw new Error(`task_not_completed:${task.taskId}`)
    const effectiveObjective = typeof objective === 'string' && objective.trim() !== '' ? objective.trim() : task.objective
    const nextRunSequence = (task.runSequence ?? 1) + 1
    const nextRunPlan = normalizeRunPlan(effectiveObjective, acceptanceCriteria, stageTasks)
    const queued = await store.updateTask(task.taskId, (current) => {
      const initialTrigger = { sourceMessageId: current.sourceMessageId, ...(current.requesterName ? { requesterName: current.requesterName } : {}), ...(current.requesterOpenDingTalkId ? { requesterOpenDingTalkId: current.requesterOpenDingTalkId } : {}) }
      const messageTrigger = trigger && !isSyntheticTaskSource(trigger.sourceMessageId) ? trigger : undefined
      const triggerHistory = (current.triggerHistory ?? [initialTrigger]).filter((item) => !isSyntheticTaskSource(item.sourceMessageId))
      const nextHistory = messageTrigger && !triggerHistory.some((item) => item.sourceMessageId === messageTrigger.sourceMessageId) ? [...triggerHistory, messageTrigger] : triggerHistory
      const retainedTrigger = messageTrigger ?? [...triggerHistory].reverse().find((item) => typeof item.requesterOpenDingTalkId === 'string')
      const { requesterName: _requesterName, requesterOpenDingTalkId: _requesterOpenDingTalkId, ...withoutCurrentRequester } = current
      return withRevisedObjective({
        ...withoutCurrentRequester,
        ...(retainedTrigger ? { sourceMessageId: retainedTrigger.sourceMessageId, ...(retainedTrigger.requesterName ? { requesterName: retainedTrigger.requesterName } : {}), ...(retainedTrigger.requesterOpenDingTalkId ? { requesterOpenDingTalkId: retainedTrigger.requesterOpenDingTalkId } : {}) } : {}),
        triggerHistory: nextHistory,
        state: 'queued',
        runSequence: nextRunSequence,
        runStartedAt: new Date().toISOString(),
        acceptanceCriteria: nextRunPlan.acceptanceCriteria,
        stageTasks: nextRunPlan.stageTasks,
        runHistory: [...(current.runHistory ?? []), {
          runSequence: current.runSequence ?? 1, startedAt: current.runStartedAt ?? current.createdAt, endedAt: new Date().toISOString(),
          sourceMessageId: current.sourceMessageId, objective: current.objective, childSessionId: current.childSessionId,
          ...(current.requesterName ? { requesterName: current.requesterName } : {}), ...(current.requesterOpenDingTalkId ? { requesterOpenDingTalkId: current.requesterOpenDingTalkId } : {}),
          acceptanceCriteria: current.acceptanceCriteria ?? [current.objective], stageTasks: current.stageTasks ?? ['完成并验证当前轮目标'], checkpoints: current.checkpoints ?? [], ...(current.result ? { result: current.result } : {}),
        }],
        relatedContexts: [...(current.relatedContexts ?? []), context],
        lastCompletedResult: current.result,
        completion: undefined,
        result: undefined,
        waitingKind: undefined,
        waitingReason: undefined,
        lastWaitingResult: undefined,
        checkpoints: [],
        humanBlocker: undefined,
        reopenContext: context,
        archivedAt: undefined,
        completionSequence: (current.completionSequence ?? 0) + 1,
      }, effectiveObjective, messageTrigger)
    })
    await pumpTasks()
    return store.getTask(queued.taskId)
  }
  async function appendTaskContextInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks) {
    if (task.state === 'completed') return reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks)
    const previousObjective = task.objective
    const previousAcceptance = JSON.stringify(task.acceptanceCriteria ?? [task.objective])
    const previousStages = JSON.stringify(task.stageTasks ?? ['完成并验证当前轮目标'])
    if (task.state === 'waiting' && task.waitingKind === 'information') {
      const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
      const goal = ctx.goals.get(handle.agent)
      resumeGoalAfterResolution(handle, goal)
      task = await store.updateTask(task.taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined }))
    }
    task = await store.updateTask(task.taskId, (current) => {
      const revised = withRevisedObjective({ ...current, relatedContexts: [...(current.relatedContexts ?? []), context], updatedAt: new Date().toISOString() }, objective, trigger)
      if (acceptanceCriteria === undefined && stageTasks === undefined && revised.objective === current.objective) return revised
      return { ...revised, ...normalizeRunPlan(revised.objective, acceptanceCriteria ?? revised.acceptanceCriteria, stageTasks ?? revised.stageTasks) }
    })
    const runPlanChanged = JSON.stringify(task.acceptanceCriteria) !== previousAcceptance || JSON.stringify(task.stageTasks) !== previousStages
    if ((task.objective !== previousObjective || runPlanChanged) && task.state === 'running') {
      const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
      replaceTaskGoalObjective(task, handle)
    }
    if (task.state === 'running' || task.state === 'waiting') {
      const scope = task.objective !== previousObjective || runPlanChanged ? `[TASK_OBJECTIVE_REVISED]\n当前有效目标：${task.objective}\n原目标：${previousObjective}\n本轮验收标准：${JSON.stringify(task.acceptanceCriteria)}\n本轮阶段任务：${JSON.stringify(task.stageTasks)}\n\n` : ''
      await followupTaskInternal(task, `${scope}${context}`)
    }
    return task
  }
  async function followupTaskInternal(task, text) {
    const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
    handle.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'coordinator' } }))
    return { task, accepted: true }
  }
  const disposeObserver = typeof ctx.on === 'function' ? ctx.on('session/event', (session, event) => {
    const taskId = leafTaskBySession.get(String(session.id))
    if (taskId === undefined || !PROJECTED_EVENTS.has(event.type) || typeof store.recordActivity !== 'function') return
    const occurredAt = typeof event.time === 'number' ? new Date(event.time).toISOString() : typeof event.time === 'string' ? event.time : undefined
    activityTail = activityTail.then(() => store.recordActivity({ taskId, sessionId: String(session.id), eventKey: `${String(session.id)}:${event.seq}`, type: event.type, detail: activityDetail(event), occurredAt })).catch(() => undefined)
  }) : undefined
  for (const group of store.listGroups()) {
    try {
      await resumeResident(group)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('corrupt session log') || detail.includes('history unavailable')) {
        const replacementSessionId = `${residentSessionId(group.groupId)}-${randomUUID().slice(0, 8)}`
        const { handle } = await createResident(group.groupId, { sessionId: SessionId(replacementSessionId), meta: { cwd: agentWorkspace, agentPreset, replacedCorruptSessionId: group.residentSessionId }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
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
    listTaskTimings: store.listTaskTimings ?? (() => []),
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
    registerGroupMessageRecaller(recaller) {
      if (typeof recaller !== 'function') throw new Error('group_message_recaller_invalid')
      groupMessageRecaller = recaller
      return () => { if (groupMessageRecaller === recaller) groupMessageRecaller = undefined }
    },
    listAuthorizationRequests,
    getAuthorizationRequest,
    ingest: (message) => {
      const inflightKey = `${message.groupId}\u0000${message.messageId}`
      const existing = inflightMessages.get(inflightKey)
      if (existing !== undefined) return existing
      const operation = (async () => {
        const ingested = await store.ingest(message)
        const persisted = store.getGroup(message.groupId)?.messages.find((item) => item.messageId === message.messageId)
        if (ingested.duplicate && ['steered', 'delivered', 'decision-failed', 'skipped'].includes(persisted?.agentDeliveryStatus)) return ingested
        const accepted = ingested.duplicate ? { ...ingested, duplicate: false, recovered: true, sequence: persisted.sequence } : ingested
        const handle = residentHandles.get(message.groupId)
        try {
          if (handle === undefined) throw new Error(`resident_not_active:${message.groupId}`)
          const images = Array.isArray(message.images) ? message.images : []
          if (images.length > 0 && attachments === undefined) throw new Error('dsh_attachments_required')
          const imageRefs = images.length === 0 ? [] : await attachments.saveImages(images.map((image) => ({ data: image.data, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })))
          const decisionPrompt = buildDecisionPrompt({ messageId: message.messageId, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable })
          const pending = createPendingGroupDecision({ groupId: message.groupId, messageId: message.messageId, sequence: accepted.sequence, message, imageRefs })
          const content = [
            { type: 'text', text: `[GROUP_MESSAGE_STEER]\n判断请求 ID：${pending.requestId}\n${decisionPrompt.replace(/^\[GROUP_DECISION\]\n\n/u, '')}` },
            ...imageRefs.map((attachment) => ({ type: 'image', attachment })),
          ]
          try { handle.agent.steer(createUserMessage({ content, source: { kind: 'user' } })) }
          catch (error) { rejectPendingGroupDecision(pending.requestId, error); throw error }
          rejectUnsubmittedGroupDecisionWhenIdle(handle.agent, pending.requestId, message.groupId, message.messageId)
          await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'steered' })
          const submitted = await pending.promise
          if (submitted.ownerRequestId !== pending.requestId) {
            await submitted.committed
            return { ...accepted, decision: submitted.decision, decisionRequestIds: submitted.requestIds, decisionOwnerRequestId: submitted.ownerRequestId, group: store.getGroup(message.groupId) }
          }
          try {
            let decision = submitted.decision
            const decisionMessages = submitted.requests.map((request) => request.message)
            const unavailableMedia = decisionMessages.flatMap((item) => Array.isArray(item.mediaUnavailable) ? item.mediaUnavailable : [])
            decision = blockTaskDecisionForUnavailableMedia(decision, unavailableMedia)
            const groupBeforeDecision = store.getGroup(message.groupId)
            const previousMessage = groupBeforeDecision?.messages.find((item) => item.sequence === accepted.sequence - 1)
            const activeTaskCount = store.listTasks().filter((task) => task.groupId === message.groupId).length
            if ('reason' in decision && shouldRecheckTaskAssociation({ activeTaskCount, hasImage: submitted.requests.some((request) => request.imageRefs.length > 0), previousMessage, occurredAt: message.occurredAt })) {
              const recheck = createPendingGroupDecision({ groupId: message.groupId, messageId: message.messageId, sequence: accepted.sequence, message, imageRefs, kind: 'recheck' })
              handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[GROUP_DECISION_RECHECK]\n判断请求 ID：${recheck.requestId}\n关联复核：你刚才选择了 ignore。请重新对照“本群全部任务关联索引”和紧邻消息判断。图片、图片后的短说明，以及群友提出的未经核验根因/状态判断，都可能是已有任务需要核验的新增线索；相关时必须返回 task-context。只有确认与全部历史及当前任务无关且不存在消息冲突时才能 ignore。\n\n${buildDecisionPrompt({ messageId: message.messageId, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable }).replace(/^\[GROUP_DECISION\]\n\n/u, '')}` }], source: { kind: 'coordinator' } }))
              rejectUnsubmittedGroupDecisionWhenIdle(handle.agent, recheck.requestId, message.groupId, message.messageId)
              const rechecked = await recheck.promise
              decision = rechecked.decision
              rechecked.resolveCommitted()
            }
            decision = blockTaskDecisionForUnavailableMedia(decision, unavailableMedia)
            const result = await serialize(message.groupId, async () => {
              if ('reason' in decision) {
                await Promise.all(submitted.requests.map((request) => store.markMessageAgentDelivery({ groupId: message.groupId, messageId: request.messageId, status: 'delivered' })))
                return { ...accepted, decision, group: store.getGroup(message.groupId) }
              }
              const tasks = []
              const trigger = { sourceMessageId: message.messageId, ...(message.senderName ? { requesterName: message.senderName } : {}), ...(message.senderOpenDingTalkId ? { requesterOpenDingTalkId: message.senderOpenDingTalkId } : {}), ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}) }
              const sourceEnvelope = decisionMessages.map((source) => buildLeafSourceEnvelope({ messageId: source.messageId, message: source.text, senderName: source.senderName, senderOpenDingTalkId: source.senderOpenDingTalkId, occurredAt: source.occurredAt, quotedMessage: source.quotedMessage, mediaUnavailable: source.mediaUnavailable })).join('\n\n')
              for (const action of decision.actions) {
                let task
                if (action.kind === 'new-task') task = await serializeTasks(async () => { const result = await store.createTask({ groupId: message.groupId, sourceMessageId: message.messageId, title: action.title, objective: action.objective, requesterName: message.senderName, requesterOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, acceptanceCriteria: action.acceptanceCriteria, stageTasks: action.stageTasks, relatedContexts: [sourceEnvelope] }); await pumpTasks(); return store.getTask(result.task.taskId) })
                else if (action.kind === 'task-context') {
                  task = store.getTask(action.taskId)
                  if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_context_target_invalid:${action.taskId}`)
                  task = await serializeTasks(() => appendTaskContextInternal(task, sourceEnvelope, trigger, action.objective, action.acceptanceCriteria, action.stageTasks))
                } else if (action.kind === 'task-reopen') {
                  task = store.getTask(action.taskId)
                  if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_reopen_target_invalid:${action.taskId}`)
                  task = await serializeTasks(() => reopenCompletedTaskInternal(task, sourceEnvelope, trigger, action.objective, action.acceptanceCriteria, action.stageTasks))
                }
                if (task !== undefined) tasks.push(task)
              }
              const group = !('reply' in decision) || decision.reply.trim() === ''
                ? store.getGroup(message.groupId)
                : await appendReliableOutbox({ groupId: message.groupId, sourceMessageId: message.messageId, text: decision.reply })
              await Promise.all(submitted.requests.map((request) => store.markMessageAgentDelivery({ groupId: message.groupId, messageId: request.messageId, status: 'delivered' })))
              return { ...accepted, decision, group, tasks, ...(tasks.length === 1 ? { task: tasks[0] } : {}) }
            })
            submitted.resolveCommitted()
            return result
          } catch (error) {
            submitted.rejectCommitted(error)
            throw error
          }
        } catch (error) {
          const current = store.getGroup(message.groupId)?.messages.find((item) => item.messageId === message.messageId)
          if (current?.agentDeliveryStatus === 'pending') await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'failed', error: error instanceof Error ? error.message : String(error) })
          else if (current?.agentDeliveryStatus === 'steered') await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'decision-failed', error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      })()
      inflightMessages.set(inflightKey, operation)
      operation.finally(() => { if (inflightMessages.get(inflightKey) === operation) inflightMessages.delete(inflightKey) }).catch(() => undefined)
      return operation
    },
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
      for (const task of tasks) await store.resolveAlerts?.({ taskId: task.taskId, fingerprintPrefix: 'dws-consumer-' })
    },
    inspectRunningTasks,
    migrateTaskProvenance: store.migrateTaskProvenance,
    migrateTaskContinuation: ({ taskId, context }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task?.state === 'running') return task
      if (task?.state !== 'waiting') throw new Error(`task_continuation_migration_invalid:${taskId}`)
      const handle = leafHandles.get(taskId) ?? await resumeLeaf(task)
      const goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'complete') ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
      else resumeGoalAfterResolution(handle, goal)
      const running = await store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, humanBlocker: current.humanBlocker ? { ...current.humanBlocker, status: 'answered', reply: 'Runtime判定无需真人介入，已转为持续执行。' } : undefined }))
      await followupTaskInternal(running, `[TASK_CONTEXT]\n${context}\n\n以上内容是恢复任务所需的来源事实，不代表任何根因或排除性判断已经成立。请按当前现场独立核验；外部流水线仍在正常运行时持续监控，Goal轮数由Host续接，不得因此提交human-intervention。`)
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
      resumeGoalAfterResolution(handle, goal)
      const answered = { ...task.humanBlocker, fingerprint: task.humanBlocker.fingerprint ?? humanBlockerFingerprint(task.humanBlocker.category, task.humanBlocker.requestedAction), status: 'answered', reply, decision }
      const running = await store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, humanBlocker: answered, humanBlockerHistory: withHumanBlockerHistory(current, answered) }))
      await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${requestId}\nDecision: ${decision}\nReply: ${reply}\n\nContinue the same task only within the approved scope. Re-check current state before acting.`)
      return running
    }),
    createTask: (request) => serializeTasks(async () => { const result = await store.createTask(request); await pumpTasks(); return { ...result, task: store.getTask(result.task.taskId) } }),
    appendTaskContext: ({ taskId, context, objective, acceptanceCriteria, stageTasks, sourceMessageId, requesterName, requesterOpenDingTalkId, occurredAt }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const trigger = sourceMessageId ? { sourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) } : undefined
      return appendTaskContextInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks)
    }),
    reopenTask: ({ taskId, context, objective, acceptanceCriteria, stageTasks, sourceMessageId, requesterName, requesterOpenDingTalkId, occurredAt }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const effectiveSourceMessageId = sourceMessageId ?? `web-reopen:${createHash('sha256').update(`${taskId}\n${context}\n${objective ?? task.objective}`).digest('hex')}`
      const trigger = { sourceMessageId: effectiveSourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) }
      return reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks)
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
    renameTask: ({ taskId, title }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const normalized = typeof title === 'string' ? title.trim() : ''
      if (normalized === '') throw new Error('task_title_required')
      return store.updateTask(taskId, (current) => ({ ...current, title: normalized, updatedAt: new Date().toISOString() }))
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
      resumeGoalAfterResolution(handle, goal)
      return store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined }))
    }),
    followupTask: ({ taskId, text }) => serializeTasks(async () => {
      const task = store.getTask(taskId); if (task === undefined || (task.state !== 'running' && task.state !== 'waiting')) throw new Error(`task_not_active:${taskId}`)
      return followupTaskInternal(task, text)
    }),
    submitTaskResult: ({ taskId, result }) => submitTaskResult(taskId, result),
    subscribe: ({ groupId, name, responsibility = '' }) => serialize(groupId, async () => {
      const existing = store.getGroup(groupId); if (existing !== undefined) return { created: false, group: existing }
      const sessionId = residentSessionId(groupId), { handle } = await createResident(groupId, { sessionId: SessionId(sessionId), meta: { cwd: agentWorkspace, agentPreset }, agentOptions, setup: residentSetup(groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
      applyFullAccess(handle)
      try {
        const result = await store.subscribe({ groupId, name, responsibility, residentSessionId: sessionId, residentAgentPreset: agentPreset }); residentHandles.set(groupId, handle)
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
            const { handle } = await createResident(group.groupId, { sessionId: SessionId(sessionId), seed, meta: { cwd: nextWorkspace, agentPreset, seedLength: seed.length }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
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
      for (const requestId of [...pendingGroupDecisions.keys()]) rejectPendingGroupDecision(requestId, new Error('resident_runtime_closed'))
      const all = [...leafHandles.values(), ...residentHandles.values()]
      await ctx.subagents.drainContinuableDescendants(all.map((handle) => handle.agent))
      await Promise.all(all.map((handle) => handle.dispose()))
      leafHandles.clear(); residentHandles.clear(); leafTaskBySession.clear(); await activityTail; await store.close()
    },
  }
}
