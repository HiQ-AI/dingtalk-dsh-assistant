import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { buildReplyReviewCandidates, groupDecisionSchema } from './decision.js'
import { boundedTopicContext, createTopicCoordinator } from './topic-runtime.js'
import { resolveTopicMessages, stableId, fingerprint } from './topic-model.js'
import { assertCurrentTaskPrompts, isDiagnosticCheckpoint, parseTaskCheckpoint, parseTaskResult, taskCheckpointJsonSchema, taskResultJsonSchema } from './task-result.js'
import { taskProgressSnapshot } from './task-progress.js'
import { createTaskReportQueue, taskReportReceiptSchema, taskReports } from './task-reports.js'
import { createTaskReportStepGate } from './task-report-step-gate.js'
import { createStatusQueryHandler } from './status-query.js'
import { reviseTaskProgress, stagePlanFor, reconcileLegacyStagePlan, normalizeRunPlan } from './task-input-revision.js'

const PROJECTED_EVENTS = new Set(['assistant/message', 'tool/call', 'tool/result', 'turn/end', 'goal/change'])
const STALE_RESIDENT_REQUEST_PREFIXES = ['[GROUP_TOPIC_ROUTE]', '[GROUP_TOPIC_DECISION]', '[TASK_COORDINATION]', '[TASK_COMPLETION_REVIEW]', '[TASK_CHECKPOINT_REVIEW]', '[GROUP_MESSAGE_STEER]', '[GROUP_DECISION_RECHECK]', '[GROUP_DECISION_RESUME]']
const SessionId = (id) => id
const createUserMessage = (input) => Object.freeze({ ...structuredClone(input), id: randomUUID(), role: 'user' })
const TASK_CONTEXT_REQUEST_LIMIT = 8
const RESIDENT_TASK_INDEX_MAX_CHARS = 16_000
const RESIDENT_TOPIC_INDEX_MAX_CHARS = 16_000
const TASK_MESSAGE_CONTEXT_MAX_CHARS = 40_000
const compactText = (value, limit) => {
  const text = String(value ?? '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
export const buildTaskAssociationIndex = (tasks) => tasks.map((task) => ({
  taskId: task.taskId,
  ...(task.title ? { title: compactText(task.title, 120) } : {}),
  objectiveExcerpt: compactText(task.objective, 120),
  state: task.state,
  archived: Boolean(task.archivedAt),
  topicRefs: task.topicRefs, inputVersion: task.inputVersion, runSequence: task.runSequence,
}))
const buildResidentTaskIndex = (tasks) => {
  const ordered = [...tasks.filter((task) => ['queued', 'running', 'waiting'].includes(task.state)), ...tasks.filter((task) => !['queued', 'running', 'waiting'].includes(task.state)).reverse()]
  const selected = []
  for (const item of buildTaskAssociationIndex(ordered)) {
    if (selected.length > 0 && JSON.stringify([...selected, item]).length > RESIDENT_TASK_INDEX_MAX_CHARS) break
    selected.push(item)
  }
  return { tasks: selected, total: tasks.length, hasMore: selected.length < tasks.length }
}
const boundedRecent = (items, maxChars, maxCount) => {
  const selected = []
  for (const item of [...items].reverse()) {
    if (selected.length >= maxCount || (selected.length > 0 && JSON.stringify([...selected, item]).length > maxChars)) break
    selected.push(item)
  }
  return selected.reverse()
}
const taskAssociationContext = (task) => ({
  taskId: task.taskId,
  ...(task.title ? { title: task.title } : {}),
  objective: task.objective,
  state: task.state,
  archived: Boolean(task.archivedAt),
  ...(task.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
  ...(task.stageTasks ? { stageTasks: task.stageTasks } : {}),
  stagePlan: stagePlanFor(task, task.stageTasks ?? []),
  ...(task.taskPromptRefs ? { taskPromptRefs: task.taskPromptRefs } : {}),
  topicRefs: task.topicRefs, inputVersion: task.inputVersion, runSequence: task.runSequence,
  ...(task.objectiveHistory ? { objectiveHistory: task.objectiveHistory } : {}),
  ...(task.titleHistory ? { titleHistory: task.titleHistory } : {}),
  ...(task.waitingReason ? { waitingReason: task.waitingReason } : {}),
  ...(task.completion ? { completion: task.completion } : {}),
})
const queryFactsSnapshot = task => {
  // 短问答只提供业务事实；工具心跳不应使每个生成中的进度答复失效。
  const { activityProjection: _activity, revision: _revision, ...snapshot } = taskProgressSnapshot(task)
  const { snapshotAt: _readTime, ...facts } = snapshot
  return { ...snapshot, revision: fingerprint(facts) }
}
const discardStaleResidentRequests = (agent) => {
  const inbox = agent?.inbox
  if (inbox === undefined || typeof inbox.remove !== 'function') return 0
  const pending = [...(inbox.nextStep ?? []), ...(inbox.nextTurn ?? [])]
  let removed = 0
  for (const message of pending) {
    const text = (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trimStart()
    if (!STALE_RESIDENT_REQUEST_PREFIXES.some((prefix) => text.startsWith(prefix))) continue
    if (inbox.remove(message.id)) removed += 1
  }
  return removed
}
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
const humanBlockerFingerprint = (taskId, runSequence, category, requestedAction, risk = '') => createHash('sha256')
  .update(JSON.stringify({ taskId, runSequence, category, requestedAction: normalizeApprovalScope(requestedAction), risk: normalizeApprovalScope(risk) }))
  .digest('hex')
const isGoalRoundLimitExhausted = (goal) => Number.isInteger(goal?.roundsStarted)
  && Number.isInteger(goal?.maxGoalRounds)
  && goal.roundsStarted >= goal.maxGoalRounds
  && (goal.phase === 'blocked' || goal.phase === 'paused' || (goal.phase === 'active' && goal.activation === 'disarmed'))
const isAgentUnavailableError = (error) => /(?:agent|session).*unavailable|unavailable.*(?:agent|session)/iu.test(error instanceof Error ? error.message : String(error))
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

export async function openResidentRuntime(ctx, store, cwd, { agentPreset = 'standard', agentWorkspaceDir, resumeTimeoutMs = 10_000, maxConcurrentTasks = 5, maxGoalRounds = 24, supervisorIntervalMs = 5_000, decisionRetryBaseMs = 30_000 } = {}) {
  const residentHandles = new Map(), leafHandles = new Map(), leafTaskBySession = new Map(), pausedRecoveryCounts = new Map(), resultRecoveryCounts = new Map(), tails = new Map(), hydrationTails = new Map(), inflightMessages = new Map(), checkpointReviewRuns = new Map(), activeGroupResidentOperations = new Set(), groupResidentTransitionBarriers = new Map(), cancellingTasks = new Set(), startingTasks = new Set(), pendingLeafDisposals = new Set()
  const agentPresets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  const attachments = ctx.get?.('attachments') ?? ctx.attachments
  const recoveryIssues = [], subscriptionListeners = new Set(), unsubscriptionListeners = new Set(), outboxListeners = new Set(), humanBlockerListeners = new Set(), authorizationDecisionListeners = new Set(), bufferedOutboxEvents = []
  let taskTail = Promise.resolve(), pumpTail = Promise.resolve(), configTail = Promise.resolve(), activityTail = Promise.resolve(), supervisorTimer, runtimeApi, currentDwsProfile = '', runtimeClosing = false, closePromise
  let groupMessageRecaller
  let taskConcurrencyLimit = store.getMaxConcurrentTasks?.() ?? maxConcurrentTasks
  if (store.getMaxConcurrentTasks?.() === undefined) await store.setMaxConcurrentTasks?.(taskConcurrencyLimit)
  if (!Number.isFinite(decisionRetryBaseMs) || decisionRetryBaseMs < 0) throw new Error('decision_retry_base_invalid')
  const selection = ctx.agentDefaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const installSelection = (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const applyPermission = (handle, preset) => {
    const permissionPresets = agentPresets?.serviceFor?.(handle.agent, 'permissionPresets')
      ?? handle.agent.ctx?.get?.('permissionPresets')
      ?? handle.agent.ctx?.permissionPresets
    if (permissionPresets === undefined) throw new Error('permission_presets_required')
    permissionPresets.set(handle.agent.session, preset)
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
    const ownEvents = handle.agent.session.ownEvents()
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
  const quotedMessageRecoveryPolicy = (owner) => {
    const profileArgument = currentDwsProfile === '' ? '' : ` --profile '${currentDwsProfile.replaceAll("'", "''")}'`
    return `### 引用消息上下文恢复

群消息信封只提供引用消息 ID，因为正常情况下被引用消息已经进入当前会话上下文。收到引用消息 ID 后，先按 ID 在当前可见上下文和本群任务索引中定位；如果不能准确还原正文，说明可能发生消息传递异常、会话恢复或上下文压缩，必须先加载 \`dingtalk-chat\` Skill，再通过 \`pwsh\` 执行 \`dws chat +messages-mget --msg-ids '<消息ID>'${profileArgument} --format json\` 主动读取。必须检查 \`complete\`、\`failedCount\`、\`failures\`、\`foundCount\` 和 \`notFoundMessageIds\`，不能只看命令退出码。

取回的消息如果仍含 \`quotedMessage.messageId\`，继续按该 ID 查询，直到不存在更上游引用；维护已访问 ID 集合，ID 重复代表异常循环，必须停止而不能无限查询。引用链中的图片、文件或其他资源承载目标、范围、对象或验收信息时，按照 \`dingtalk-chat\` Skill 的资源读取流程取得并阅读。完整引用链仅用于恢复当前消息的语义，不自动创建 Task、扩大 objective 或产生修改/发布授权。

本节是“钉钉中已存在、可按消息 ID 恢复的引用消息”的专用规则，优先于通用外部资源缺失规则。任何引用 ID 尚未查询、查询结果不完整、查询失败、未命中或出现循环时，都不得猜测上下文，也不得向群成员回复“请补原问题、正文或截图”。${owner === 'resident' ? '不得调用 group_decision_submit 提交这类群回复；保留工具错误并结束当前 step，Runtime 会持久化原消息并自动重新判断。' : '不得用主会话摘要替代原文；通过 submit_task_result 如实提交 waiting 状态和 DWS 读取证据，不得要求群成员重新提供已经存在于钉钉中的消息。'}`
  }
  function configureResident(agentCtx, groupId) {
    installSelection(agentCtx)
    agentCtx.tools.restrict({ deny: ['get_goal', 'create_goal', 'update_goal'] })
    agentCtx.systemPrompt.section({ name: 'tool:goal', order: 114, text: '' })
    registerResidentContextTools(agentCtx, groupId)
    topics.register(agentCtx, groupId)
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
        const taskIndex = buildResidentTaskIndex(store.listTasks().filter((task) => task.groupId === groupId))
        return `## 本群任务关联索引\n\n${taskIndex.total === 0 ? '无。' : JSON.stringify(taskIndex)}\n\n索引只负责召回；需要历史任务时使用 group_task_list 分页搜索。对候选 Task 调用 group_task_context_get，再读取其 Topic 固定版本原文后决定动作。`
      },
    })
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-decision-protocol', order: 41,
      text: () => `## Topic 处理协议

收到 [GROUP_TOPIC_ROUTE] 时先结合该批所有消息和已有 Topic 归类，通过 group_topic_route_submit 提交完整归属；引用、关键词只是候选，必须结合讨论目标、上下文、原始授权和任务状态判断。Topic 归属表示消息延续同一讨论目标（continuation），或实质改变该 Topic 的事实、范围、结论或动作（affected）。为了回答而读取旧分支、PR、任务或其他历史资料不构成归属，应使用 Topic/Task 查询工具获取资料。新消息可创建 Topic 或追加已有 Topic，一条消息确实影响多个话题时，逐项声明 relationship 和 reason，并通过 effectOwner 指定唯一动作主归属；主归属是消息当前直接推动的事项，不是资料来源。无关噪声可无归属，但必须说明原因。新 Topic 的 title 应像任务名称一样简短，只概括可持续归类的共同讨论对象，优先使用“对象 + 事项”的短语并控制在 8–20 字，不复述动作清单、背景、进展、结论或消息原文；细节写入后续 summary。title 不得超过 30 字。

签名、口吻和身份声明由 Agent 自身工作区规则决定。
收到 [GROUP_TOPIC_DECISION] 后读取该 Topic 固定版本与本次增量，用 group_decision_submit 独立提交，不等待 turn 结束。每个提交包含 requestId、topicId、revision 和 decision；decision 必须有 basisMessageIds，至少包含一条当前增量的原始消息。Task 动作使用 topicRefs；已有 Task 动作还需提供当前 inputVersion/runSequence。Task 不保存消息列表，来源统一从 Topic 读取。

routing-required 表示还有未归类输入，先归类再重试；已确认无关的 Topic 不使本 Topic 回复失效。topic-stale/task-stale 表示相关版本改变，读取最新输入重做判断。accepted 只表示业务意图已持久接受；不能声称 Task 已执行完成或消息已送达。

任何 Task 动作需要非空简短确认；纯讨论可以 actions:[] 加 reason。所有非空reply必须声明replyReview.kind，replyReview 的 reviewedOutboundIds 必须完整覆盖 group_reply_review_get 返回的候选。confirmation/correction 按真实同事项选择 sameMatterOutboundIds/replaceOutboundIds；substantive 不撤回旧消息。同 Topic 不意味着所有结论都相同。

通过 topicUpdate 保存 summary/openQuestions/status。摘要不能替代原文，closed Topic 后续可以继续；致谢或无关讨论不能自动重开 Task。共享消息涉及多个 Topic 的同一 Task 动作只在一个 Topic 执行，其他 Topic 关联既有结果，防止重复重开或确认。

Task 完成验收和检查点审阅通过 group_task_review_submit 返回，普通文本不构成审阅。完成审阅通过时必须在同一次提交中准备 Task 通知；Runtime 在 Task 原子完成后才写入 Outbox。等待通知、恢复补发或完成通知草稿失效时通过 group_reply_submit 返回。通知根据固定 Topic 原文选择引用消息和真正需要获知的参与人，保留实际变更、证据、交付状态和未验证边界。

\`title\` 是不超过 120 字的简洁任务名，只概括被授权的事项，不得包含消息信封、发送人、完成状态或未经核验的根因。\`objective/context\` 用于主会话选路、动作授权和可观测记录，不得在其中编造或强化根因、完成度、方案优劣或排除性结论；叶子还会收到 Runtime 从Topic 固定版本生成的独立来源证据并自行核验。task-context 或 task-reopen 修订 objective 时必须同时提交概括新完整目标的 title；普通补充、等待恢复和异常唤醒不得提交 title。

新建任务必须提供至少一条 \`acceptanceCriteria\`；修订目标时也可更新 \`acceptanceCriteria\` 和 \`stageTasks\`。验收标准只描述原始消息明确要求的业务结果、目标环境和限制，不得把主会话建议、历史做法或预计验证步骤扩写成用户要求，也不得按开发、分析、部署等任务类型绑定固定模板。具体处理流程由叶子按插件任务流程索引选择并形成计划；你在计划和完成审阅中通过 group_task_prompt_get 一次批量读取本轮需要的流程，结合固定 Topic 原文检查一致性。

状态追问先读取 group_task_context_get 的 currentFacts，核对报告、批准、证据来源与发生时间；原始报告不等于独立验收。“状态查错了吧”本身不证明实现或数据库有问题，不因此 replan。字段与旧值相同且没有否定证据时保留进展；目标不变但新事实否定阶段时，task-context 必须提供 impactEvidence，填写本次原始 basisMessageIds、具体 reason 和 stagePlan 中真实 affectedStageIds。只使受影响阶段及后续失效，保留原版本有效证据。当前 surface 内仍可见且版本未变的流程与证据正文直接复用，不因 requestId 变化重读。

当前消息明确指名或提及已配置的 Agent 名称/别名、以 \`cc:\` 开头，或者明确确认了主会话此前提出的“是否需要我处理”询问，并且事项属于本群职责且形成可验证目标时，才允许选择 new-task。未明确指名、但你判断事项应形成任务时，必须选择 task-proposal，并在群里询问“这个事项是否需要我处理？”，暂不创建 Task；收到肯定答复后再结合原消息及其后补充选择 new-task。消息明确 @其他同事且未指向 Agent 时，说明问题正在询问这些同事，必须忽略，既不得创建 task-proposal 或 new-task，也不得主动回答；只有后续明确指向 Agent 且直接引用该消息，才视为可验证的转交。同事间讨论、事实陈述或未形成可验证目标的内容不得创建任务；与现有任务相关时只做任务关联或补充上下文，并按下方节制原则简短确认。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。

任务目标必须忠实保留消息中的动作范围，不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务。诊断任务的完成条件只能是核验现状、定位根因、给出证据与建议；只有消息明确要求修复、修改、处理问题或实施方案时，new-task 或 task-proposal 的 objective 才能包含变更动作。后续消息可能明确扩大或收窄同一任务的动作范围；此时仍关联原 Task，并在 task-context 或 task-reopen 中填写修订后的累计完整 objective。普通事实补充不得填写 objective。是否明确指名只决定直接处理还是先询问，不构成扩大任务授权。

消息附带的图片属于当前消息正文，必须先阅读图片，再结合固定主会话中的前后消息和“本群全部任务关联索引”判断关联性。queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断；任务状态只决定关联后的动作，不得成为忽略关联的理由。不得仅因文字部分没有指名、图片没有文字摘要或后续消息较短就选择忽略；紧邻图片的补充说明应优先与该图片共同理解。群友对根因、状态或外部因素的未经核验判断，只要与已有任务相关，就是需要核验的新增线索，不得以“尚未核验”为由忽略。已存在任务的新增事实应优先关联已有任务，而不是创建重复任务。对已完成任务的结果提出回滚、撤回、还原、纠正或补做，属于原任务的结果纠正，必须返回 task-reopen 唤起原 Task，不得只做自然语言承诺，也不得创建新 Task；只有与原目标不同的独立可执行目标才创建新任务并保留历史关联。

判断使用已有任务还是新建任务时，必须进行整体语义判断：结合当前消息的前后文、引用关系、连续消息构成的信息组、当时讨论与执行场景，以及候选任务的标题、完整目标、动作范围、状态、消息与参与人时间线和已记录上下文，判断新消息是在补充、修订、纠正或延续原目标，还是提出了不同的独立目标。不得根据某几个关键词、词面重合、标题相似或单一字段直接决定复用已有任务或新建任务；关键词只能作为查找候选任务的线索，不能代替关联结论。无法从现有上下文可靠区分时，不得猜测创建重复任务，应先结合近期消息继续核对，确有阻塞再向真正掌握必要信息的相关参与人询问。

图片、文档、文件、链接或其他外部资源如果承载任务目标、范围、对象、输入数据或验收要求，必须先通过当前可用工具完整读取。任何任务所需资源无法访问、下载、解析或读取不完整时，必须提交 actions:[] 和非空 reply，明确告诉对方未获取到的具体信息以及需要重新提供的内容；此时不得选择 new-task、task-context 或 task-reopen，也不得先创建或推进 Task。只有确认缺失资源与任务无关，或对方补齐必要信息后，才继续任务关联与准入判断。不得假设资源内容、不得用文件名、链接标题、缩略图或消息中的零散文字替代未读取的正文。

${quotedMessageRecoveryPolicy('resident')}

明确拥有任务授权的群成员说“不要处理、不用做、停止、取消、忽略刚才”等，且结合上下文可以唯一关联到本群 queued、running 或 waiting Task 时，必须返回 task-cancel，reason 忠实保留撤销含义；不得把撤销消息作为 task-context 继续发送给叶子。task-cancel 是撤销执行授权并终止整个 Task，只能用于明确停止原任务，不能从模糊讨论、普通目标收窄或暂缓某一步推断。无法唯一确认目标 Task 时先核对上下文，不得批量取消。

状态边界必须严格遵守：除上述明确撤销使用 task-cancel 外，running 或 waiting（包括阻塞中）的 Task 收到新增信息时只能返回 task-context，继续同一执行轮次；不得返回 task-reopen，不得清空 blocker 或增加轮次。只有 completed Task（包括已归档展示）才允许 task-reopen 并初始化下一执行轮次。

task-context 必须判断对当前检查点的影响：仅补充执行定位信息且不改变目标、验收标准或既有证据有效性时使用 progressImpact=preserve；目标、验收、阶段或证据有效性变化时使用 progressImpact=replan。无法确认时选择 replan，不能为了保留进度忽略新信息。

同事或其 AI 助理发送的回复、任务回执和状态通知都是正常群消息，必须进入本协议由你结合引用消息、上下文和任务索引判断，不得按固定文案或发送者在模型外预先过滤。若消息只是对已完成通知的自动回执，没有提出新事实、问题、纠正或执行要求，应提交 actions:[] 和 reason；只有确实需要向群里补充新信息时才提交非空 reply，不要回复“无需重复创建任务”之类没有新增价值的确认。

### 群聊回复节制原则

理解消息、关联任务和回复群聊是三个独立决定。每个 Topic 的增量都必须完成任务关联和近期回复冲突检查。以下情况允许 reply 非空：消息明确要求 Agent 立即回答且当前已有可核验答案；必须询问一个只有相关参与人才能补充且确实阻塞任务的信息；Task 产生新的最终结果、明确失败结果或需要真人行动的结论；需要订正或撤回本主会话此前发送的错误消息；已创建或正在处理的 Task 收到新的执行线索、补充信息或处理要求时，简短确认已收到并会继续处理。

过程确认和信息确认必须简短，只确认已收到、已关联 Task 或将继续处理，不得复述、改写或逐项罗列对方提供的信息，不得虚构进度、结果或完成时间。给活动 Task 补充 IP、库名、schema、文件、截图、字段范围或其他执行线索时，应返回简短确认；叶子已在执行且当前消息作为 task-context 转交时，也应简短确认会结合补充信息继续处理。

task-cancel 成功时只需用一句短句确认任务已停止，不得继续承诺处理。以下情况必须使用 actions 为空且带 reason 的静默决策，不得保留任务动作或提交 reply：同事之间的讨论、确认、纠正或短句接龙且未明确要求 Agent 回答，也与本 Agent 的 Task 无关；没有新增信息，只是复述已有结论或重复确认任务仍在进行。

同一事项短时间内连续出现的文本、文件、图片和补充说明属于一个信息组。文件或图片前后的短句不得分别追问；信息仍可能继续补充时先静默关联，只有信息组稳定后仍存在真正阻塞，才能一次性询问。同一 Task 在上一条群通知之后没有产生新结果、真实阻塞或必要订正时，不得再次发状态通知。

发送前必须执行回复节制门禁：确认回复只表达“已收到并会继续处理”这一必要状态，使用一句短句，不得重复对方提供的信息；结果、阻塞、提问或订正回复只保留同事必须知道的新事实、必须回答的问题或明确行动。

所有群消息业务动作只能通过 group_decision_submit。Web 人工输入由 Host 可靠接收为 Topic，Resident 不得伪造 Web 输入或绕过原始依据检查。已归类消息需要纠正时，先 group_topic_route_review 申请固定快照，再 group_topic_route_submit 提交完整修订。工具返回 invalid-arguments 时只修正 issues 指定字段；返回 stale 或 superseded 时改用 currentRequest；返回 accepted 且 recovered=true 表示此前提交已落盘，禁止重复执行；返回 request-unavailable 时等待 Host 生成当前请求，不得猜测或重放。`,
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
  const serializeHydration = (groupId, operation) => {
    const current = (hydrationTails.get(groupId) ?? Promise.resolve()).then(operation, operation)
    hydrationTails.set(groupId, current)
    current.finally(() => { if (hydrationTails.get(groupId) === current) hydrationTails.delete(groupId) }).catch(() => undefined)
    return current
  }
  const serializeConfig = (operation) => {
    const current = configTail.then(operation, operation)
    configTail = current.catch(() => undefined)
    return current
  }
  const sameStringSet = (left, right) => left.length === right.length && left.every((item) => right.includes(item))
  function replyReviewCandidatesFor(groupId, currentMessages, focusTaskIds = []) {
    return buildReplyReviewCandidates({
      group: store.getGroup(groupId),
      tasks: store.listTasks().filter((task) => task.groupId === groupId),
      currentMessages,
      focusTaskIds,
    })
  }
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
  function holdGroupResidentTransition(groupId) {
    let barrier = groupResidentTransitionBarriers.get(groupId)
    if (barrier === undefined) {
      let resolve
      const promise = new Promise((resolveBarrier) => { resolve = resolveBarrier })
      barrier = { count: 0, promise, resolve, releaseTopics: topics.pause(groupId) }
      groupResidentTransitionBarriers.set(groupId, barrier)
    }
    barrier.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      barrier.count -= 1
      if (barrier.count !== 0) return
      if (groupResidentTransitionBarriers.get(groupId) === barrier) groupResidentTransitionBarriers.delete(groupId)
      barrier.resolve()
      barrier.releaseTopics()
    }
  }
  function runGroupResidentOperation(groupId, operation) {
    if (runtimeClosing) return Promise.reject(new Error('resident_runtime_closed'))
    const transition = groupResidentTransitionBarriers.get(groupId)
    if (transition !== undefined) return transition.promise.then(() => runGroupResidentOperation(groupId, operation))
    const promise = Promise.resolve().then(() => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      return operation()
    })
    const active = { groupId, promise }
    activeGroupResidentOperations.add(active)
    promise.finally(() => activeGroupResidentOperations.delete(active)).catch(() => undefined)
    return promise
  }
  async function waitForActiveGroupResidentOperations(groupId) {
    while (true) {
      const active = [...activeGroupResidentOperations].filter((operation) => operation.groupId === groupId)
      if (active.length === 0) return
      await Promise.allSettled(active.map((operation) => operation.promise))
    }
  }
  async function waitForAllResidentOperations() {
    while (activeGroupResidentOperations.size > 0) await Promise.allSettled([...activeGroupResidentOperations].map((operation) => operation.promise))
  }
  async function waitForActiveGroupSubmissions(groupId) { await topics.drain(groupId) }
  function assertResidentToolSession(exec, groupId) {
    const expected = residentHandles.get(groupId)?.agent?.session?.id
    if (expected === undefined || String(exec.agent?.session?.id) !== String(expected)) throw new Error(`resident_tool_wrong_session:${groupId}`)
  }
  function registerResidentContextTools(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_task_context_get',
      description: 'Read complete association context for selected task IDs from this resident group. The compact system-prompt task index is recall-only; use this result for final task association decisions.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['taskIds'], properties: {
          taskIds: { type: 'array', items: { type: 'string' } },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['tasks'], properties: {
          tasks: { type: 'array', items: { type: 'object' } },
        } },
        render: (_args, out) => [{ type: 'text', text: `Task 完整关联上下文：${JSON.stringify(out.tasks)}` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        if (args.taskIds.length === 0 || args.taskIds.length > TASK_CONTEXT_REQUEST_LIMIT) throw new Error('group_task_context_request_limit')
        if (args.taskIds.some((taskId) => taskId.trim() === '')) throw new Error('group_task_context_request_invalid')
        if (new Set(args.taskIds).size !== args.taskIds.length) throw new Error('group_task_context_request_duplicate')
        const tasks = args.taskIds.map((taskId) => {
          const task = store.getTask(taskId)
          if (task === undefined) throw new Error(`group_task_context_not_found:${taskId}`)
          if (task.groupId !== groupId) throw new Error(`group_task_context_wrong_group:${taskId}`)
          return { ...taskAssociationContext(task), currentFacts: taskProgressSnapshot(task) }
        })
        return { tasks }
      },
    })
  }
  function registerResidentTaskTools(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_task_list', description: '分页搜索当前群任务及 Topic 版本引用。', parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, out) => [{ type: 'text', text: JSON.stringify(out) }] },
      execute: async ({ query = '', offset = 0, limit = 50 }, exec) => {
        assertResidentToolSession(exec, groupId)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('group_task_page_invalid')
        const normalized = String(query).trim().toLowerCase()
        const all = store.listTasks().filter((task) => task.groupId === groupId && (!normalized || `${task.title ?? ''}\n${task.objective}`.toLowerCase().includes(normalized)))
        return { tasks: all.slice(offset, offset + limit).map(taskAssociationContext), total: all.length, offset, limit, hasMore: offset + limit < all.length }
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
  async function notifyOutboxListener(listener, event) {
    try { await listener(event) }
    catch (error) {
      recoveryIssues.push({
        groupId: event.groupId, sourceMessageId: event.outbound.sourceMessageId, kind: 'outbox-listener',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  async function recallReplacedOutbounds({ groupId, outbound }) {
    const group = store.getGroup(groupId)
    const replacement = group?.outbox.find(item => item.outboundId === outbound.outboundId)
    // 撤回是送达后的独立动作，不能让旧消息阻塞纠正通知。
    if (!replacement?.deliveredMessageId || replacement.status !== 'sent' || replacement.supersededByOutboundId) return
    const targets = new Map(), visiting = new Set()
    const visit = (id) => {
      if (visiting.has(id)) throw new Error('outbox_replacement_cycle')
      if (targets.has(id)) return
      const target = group.outbox.find(item => item.outboundId === id)
      if (!target) throw new Error(`group_reply_replacement_unknown:${id}`)
      visiting.add(id)
      for (const previous of target.replacesOutboundIds ?? []) visit(previous)
      visiting.delete(id); targets.set(id, target)
    }
    for (const id of replacement.replacesOutboundIds ?? []) visit(id)
    if (!targets.size) return
    if (groupMessageRecaller === undefined || store.updateOutboundRecall === undefined) throw new Error('group_message_recaller_required')
    for (const target of targets.values()) {
      if (target.recallStatus === 'recalled') continue
      const lateDelivery = target.recallError === 'replacement_delivery_unknown' && target.deliveredMessageId
      if (target.recallStatus === 'failed' && target.recallAttemptCount && !lateDelivery && !target.recallRetryAt) continue
      if (target.recallRetryAt && Date.parse(target.recallRetryAt) > Date.now()) continue
      const reason = `superseded-by:${replacement.sourceMessageId}`
      if ((target.recallAttemptCount ?? 0) >= 3 && !lateDelivery) {
        if (target.recallStatus !== 'failed' || target.recallRetryAt) await store.updateOutboundRecall({ groupId, outboundId: target.outboundId, status: 'failed', reason, error: target.recallError ?? 'recall_attempts_exhausted' })
        continue
      }
      await store.updateOutboundRecall({ groupId, outboundId: target.outboundId, status: 'requested', reason })
      try {
        const result = await groupMessageRecaller({ groupId, messageId: target.deliveredMessageId, outbound: target })
        if (result?.status === 'not-observed') {
          await store.updateOutboundRecall({ groupId, outboundId: target.outboundId, status: 'failed', reason, error: 'replacement_delivery_unknown' })
        } else await store.updateOutboundRecall({ groupId, outboundId: target.outboundId, status: 'recalled', reason })
      } catch (error) {
        const retryAt = !error.serverErrorCode && (target.recallAttemptCount ?? 0) + 1 < 3 ? new Date(Date.now() + 30_000).toISOString() : undefined
        await store.updateOutboundRecall({ groupId, outboundId: target.outboundId, status: 'failed', reason, error: error instanceof Error ? error.message : String(error), retryAt })
      }
    }
  }
  async function appendReliableOutbox({ groupId, sourceMessageId, outboundId, topicRefs, decisionId, resultFingerprint, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, replyKind, taskIds, replacesOutboundIds = [], onPersisted, preflight }) {
    const before = store.getGroup(groupId)
    if (before === undefined) throw new Error(`group_not_subscribed:${groupId}`)
    const existing = before.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (existing !== undefined) { onPersisted?.(); return before }
    const rejected = preflight?.(before)
    if (rejected) return rejected
    const group = await store.appendOutbox({ groupId, sourceMessageId, outboundId, topicRefs, decisionId, resultFingerprint, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, replyKind, taskIds, replacesOutboundIds, preflight })
    if (group?.status) return group
    const outbound = group.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (outbound === undefined) throw new Error(`outbox_append_missing:${groupId}:${sourceMessageId}`)
    onPersisted?.()
    const event = { groupId, outbound }
    if (outboxListeners.size === 0) bufferedOutboxEvents.push(event)
    else for (const listener of outboxListeners) void notifyOutboxListener(listener, event)
    return group
  }
  async function reviewCompletedTaskResult(task, result) { return topics.requestReview('completion', task, result) }
  async function recordTaskCoordinationEvent(taskId, event) {
    return serializeTasks(() => store.updateTask(taskId, (current) => ({ ...current, executionEvents: [...(current.executionEvents ?? []), event], updatedAt: new Date().toISOString() })))
  }
  const createResident = async (_groupId, options) => ({ handle: await ctx.agents.create(options) })

  function signalTaskCancellation(taskId) {
    cancellingTasks.add(taskId)
    const handle = leafHandles.get(taskId)
    handle?.agent.cancel({ kind: 'user' })
    return handle
  }

  function disposeCancelledLeaf(task, handle) {
    const disposal = Promise.resolve().then(() => handle.dispose()).catch((error) => {
      recoveryIssues.push({
        groupId: task.groupId, taskId: task.taskId, kind: 'task-cancel-dispose',
        error: error instanceof Error ? error.message : String(error),
      })
    })
    pendingLeafDisposals.add(disposal)
    void disposal.finally(() => pendingLeafDisposals.delete(disposal))
  }

  async function cancelTaskInternal(taskId, normalizedReason, topicRefs, operation) {
    try {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      if (task.state === 'completed') { if (operation && task.appliedOperations.includes(operation.operationId)) return task; throw new Error(`task_not_active:${taskId}`) }
      const handle = signalTaskCancellation(taskId)
      if (handle !== undefined) {
        const goal = ctx.goals.get(handle.agent)
        if (goal !== undefined && goal.phase !== 'complete') ctx.goals.complete(handle.agent, goalRef(goal))
      }
      const cancelled = await mutateTask(task, operation, (current) => {
        return {
          ...current,
          ...(topicRefs ? { topicRefs } : {}), inputVersion: current.inputVersion + 1,
          state: 'completed',
          completion: `已取消：${normalizedReason}`,
          result: undefined,
          waitingKind: undefined,
          waitingReason: undefined,
          archivedAt: new Date().toISOString(),
        }
      })
      if (handle !== undefined) {
        if (leafHandles.get(taskId) === handle) leafHandles.delete(taskId)
        leafTaskBySession.delete(String(handle.agent.session.id))
        disposeCancelledLeaf(cancelled, handle)
      }
      void pumpTasks().catch((error) => recoveryIssues.push({ groupId: cancelled.groupId, kind: 'task-pump', error: error.message }))
      return cancelled
    } finally {
      cancellingTasks.delete(taskId)
    }
  }

  function taskResultOutboxKey(task, result) {
    const prior = store.getGroup(task.groupId)?.outbox.find((outbound) => outbound.taskIds?.includes(task.taskId) && outbound.resultFingerprint === fingerprint(result))
    if (prior) return prior.sourceMessageId
    if (result.status === 'completed') {
      const completionSequence = task.completionSequence ?? 0
      return `task-result:${task.taskId}:completed${completionSequence > 0 ? `:${completionSequence}` : ''}`
    }
    return `task-result:${task.taskId}:waiting:${task.runSequence}:${task.inputVersion}:${createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16)}`
  }

  async function coordinateTaskResultInternal(task, result) {
    const resultKey = taskResultOutboxKey(task, result)
    const existing = store.getGroup(task.groupId)?.outbox.find((item) => item.sourceMessageId === resultKey)
    if (existing) return existing
    return topics.requestReply(task, result, resultKey)
  }
  function coordinateTaskResult(task, result) {
    return runGroupResidentOperation(task.groupId, () => coordinateTaskResultInternal(task, result))
  }
  async function reviewTaskCheckpoint(task, checkpoint) {
    if (!isDiagnosticCheckpoint(checkpoint)) {
      assertCurrentTaskPrompts(task, store.getTaskPrompts())
      if (checkpoint.kind === 'plan-confirmed' && !samePromptRefs(checkpoint.workflowAssessment?.promptRefs, task.taskPromptRefs)) throw new Error(`task_workflow_plan_stale:${task.taskId}`)
    }
    return topics.requestReview('checkpoint', task, checkpoint)
  }
  async function discardFailedCheckpoint(taskId, checkpoint, error) {
    return serializeTasks(() => store.updateTask(taskId, (current) => {
      const failed = current.checkpoints?.find((item) => item.checkpointId === checkpoint.checkpointId && !item.coordinatorDecision)
      if (!failed) return current
      return { ...current, checkpoints: current.checkpoints.filter((item) => item !== failed),
        executionEvents: [...(current.executionEvents ?? []), { kind: 'checkpoint-review-failed', checkpoint: failed, error: compactText(error.message, 1000), at: new Date().toISOString() }] }
    }))
  }
  async function persistCheckpointReview(task, checkpoint, review) {
    return serializeTasks(async () => {
      if (cancellingTasks.has(task.taskId)) throw new Error(`task_cancel_pending:${task.taskId}`)
      const current = store.getTask(task.taskId)
      if (current?.inputVersion !== task.inputVersion || current?.runSequence !== task.runSequence) throw new Error(`task_checkpoint_run_changed:${task.taskId}`)
      return updateTaskInput(task.taskId, checkpoint, (value) => {
        assertCheckpointCurrent(value, task, checkpoint)
        const completedTitles = value.checkpoints.filter(item => item.kind === 'stage-completed' && item.coordinatorDecision && item.coordinatorDecision !== 'reject').flatMap(item => item.completedItems)
        const planTitles = [...new Set([...completedTitles, ...checkpoint.remainingItems])]
        return { ...value,
          ...(checkpoint.kind === 'plan-confirmed' && review.decision !== 'reject' ? { stageTasks: planTitles, stagePlan: stagePlanFor(value, planTitles) } : {}),
          checkpoints: (value.checkpoints ?? []).map((item) => item.checkpointId === checkpoint.checkpointId ? { ...item, coordinatorDecision: review.decision, coordinatorReason: review.reason, ...(review.guidance ? { guidance: review.guidance } : {}), reviewedAt: new Date().toISOString() } : item),
          updatedAt: new Date().toISOString(),
        }
      })
    })
  }
  function runCheckpointReview(task, checkpoint) {
    if (checkpoint.coordinatorDecision) return Promise.resolve({ accepted: checkpoint.coordinatorDecision !== 'reject', taskId: task.taskId, checkpointId: checkpoint.checkpointId, coordinatorDecision: checkpoint.coordinatorDecision, reason: checkpoint.coordinatorReason, ...(checkpoint.coordinatorDecision === 'reject' ? { code: 'task_checkpoint_rejected' } : {}) })
    const existing = checkpointReviewRuns.get(checkpoint.checkpointId)
    if (existing) return existing
    const run = (async () => {
      let review
      try {
        review = checkpoint.kind === 'stage-completed' && checkpoint.needsCoordinatorDecision === false && checkpoint.evidence.length > 0
          ? { decision: 'acknowledge', reason: 'Host 已校验阶段顺序、执行版本和非空证据。' }
          : await withoutInitiator(() => reviewTaskCheckpoint(task, checkpoint))
        await persistCheckpointReview(task, checkpoint, review)
      } catch (error) {
        await discardFailedCheckpoint(task.taskId, checkpoint, error)
        throw error
      }
      if (review.decision === 'reject') {
        await followupTaskInternal(task, `[TASK_PLAN_REJECTED]\n当前计划与原始授权或已选任务流程不一致：${review.reason}\n\n重新核对固定 Topic 原文和已选流程；主会话生成的目标或验收标准不能作为流程例外依据。修正后重新提交 plan-confirmed。`, `checkpoint-rejected:${checkpoint.checkpointId}`)
        return { accepted: false, taskId: task.taskId, code: 'task_checkpoint_rejected', checkpointId: checkpoint.checkpointId, reason: review.reason }
      }
      return { accepted: true, taskId: task.taskId, checkpointId: checkpoint.checkpointId, coordinatorDecision: review.decision, reason: review.reason, ...(review.guidance ? { guidance: review.guidance } : {}) }
    })()
    checkpointReviewRuns.set(checkpoint.checkpointId, run)
    run.finally(() => { if (checkpointReviewRuns.get(checkpoint.checkpointId) === run) checkpointReviewRuns.delete(checkpoint.checkpointId) }).catch(() => undefined)
    return run
  }
  async function resumeResident(group) {
    if (residentHandles.has(group.groupId)) return residentHandles.get(group.groupId)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(group.residentSessionId), agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
    discardStaleResidentRequests(handle.agent)
    if (group.residentAgentPreset !== agentPreset) {
      await store.updateGroup({ groupId: group.groupId, residentAgentPreset: agentPreset })
    }
    applyPermission(handle, 'read-only')
    residentHandles.set(group.groupId, handle)
    return handle
  }
  function assertTaskInput(task, value) {
    if (task.inputVersion !== value.inputVersion || task.runSequence !== value.runSequence) throw new Error(`task_input_version_stale:${task.taskId}`)
    if (!isDiagnosticCheckpoint(value) && topics.hasPendingTaskInput(task)) throw new Error(`task_input_pending:${task.taskId}`)
  }
  const samePromptRefs = (left = [], right = []) => JSON.stringify(left) === JSON.stringify(right)
  function assertCheckpointCurrent(current, task, checkpoint) {
    if (current.state !== 'running') throw new Error(`task_not_running:${task.taskId}`)
    if (current.checkpoints?.at(-1)?.checkpointId !== checkpoint.checkpointId) throw new Error(`task_checkpoint_context_changed:${task.taskId}`)
    if (!isDiagnosticCheckpoint(checkpoint)) {
      assertCurrentTaskPrompts(current, store.getTaskPrompts())
      if (!samePromptRefs(current.taskPromptRefs, task.taskPromptRefs)) throw new Error(`task_checkpoint_context_changed:${task.taskId}`)
      if (checkpoint.kind === 'plan-confirmed' && !samePromptRefs(checkpoint.workflowAssessment?.promptRefs, current.taskPromptRefs)) throw new Error(`task_workflow_plan_stale:${task.taskId}`)
    }
  }
  function assertWorkflowPlan(task) {
    assertCurrentTaskPrompts(task, store.getTaskPrompts())
    const plan = [...(task.checkpoints ?? [])].reverse().find((item) => item.kind === 'plan-confirmed')
    if (!plan) throw new Error(`task_checkpoint_plan_required:${task.taskId}`)
    if (plan.runSequence !== task.runSequence || plan.inputVersion !== task.inputVersion && !task.executionEvents?.findLast(event => event.kind === 'input-revised' && event.inputVersion === task.inputVersion)?.retainedCheckpointIds?.includes(plan.checkpointId)) throw new Error(`task_workflow_plan_stale:${task.taskId}`)
    if (plan.coordinatorDecision === 'reject') throw new Error(`task_workflow_plan_rejected:${task.taskId}`)
    if (!plan.coordinatorDecision) throw new Error(`task_checkpoint_review_pending:${task.taskId}`)
    if ((task.taskPromptRefs?.length ?? 0) > 0 && !plan.workflowAssessment) throw new Error(`task_workflow_assessment_required:${task.taskId}`)
    if (plan.workflowAssessment && !samePromptRefs(plan.workflowAssessment.promptRefs, task.taskPromptRefs ?? [])) throw new Error(`task_workflow_plan_stale:${task.taskId}`)
  }
  function updateTaskInput(taskId, value, transform) {
    return store.updateTask(taskId, (current) => { assertTaskInput(current, value); return { ...transform(current), acknowledgedInputVersion: value.inputVersion } })
  }
  async function submitTaskResultInternal(taskId, value) {
    const result = parseTaskResult(value)
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    const task = store.getTask(taskId)
    if (task === undefined || task.state === 'queued' || task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
    assertTaskInput(task, result)
    const handle = leafHandles.get(taskId)
    if (handle === undefined) throw new Error(`task_leaf_not_active:${taskId}`)
    const goal = ctx.goals.get(handle.agent)
    if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
    if (result.status === 'waiting') {
      if (result.waitingKind === 'information') {
        const waiting = await updateTaskInput(taskId, result, (current) => ({ ...current, state: 'waiting', waitingKind: 'information', waitingReason: result.waitingReason, result }))
        if (goal.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: 'task-input-required', message: result.waitingReason })
        return waiting
      }
      const fingerprint = humanBlockerFingerprint(task.taskId, task.runSequence, result.blockerCategory, result.requestedAction, result.risk)
      const currentBlocker = task.humanBlocker
      const approved = [...(task.humanBlockerHistory ?? []), ...(currentBlocker ? [currentBlocker] : [])]
        .find((item) => item.fingerprint === fingerprint && item.runSequence === task.runSequence && item.status === 'answered' && item.decision === 'approved')
      if (approved !== undefined) {
        resumeGoalAfterResolution(handle, ctx.goals.get(handle.agent))
        const running = await updateTaskInput(taskId, result, (current) => ({
          ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: result, result: undefined,
          humanBlocker: approved, humanBlockerHistory: withHumanBlockerHistory(current, approved), updatedAt: new Date().toISOString(),
        }))
        await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${approved.requestId}\nDecision: approved\nReply: ${approved.reply ?? '已人工确认继续'}\n\nA human already confirmed continuation within this exact controlled-action scope. Continue the same task only within that scope; do not request human intervention again.`)
        return running
      }
      if (currentBlocker !== undefined
        && currentBlocker.fingerprint === fingerprint && currentBlocker.runSequence === task.runSequence
        && currentBlocker.status !== 'answered') return task
      const requestId = `blocker-${randomUUID()}`
      const blocker = { requestId, fingerprint, runSequence: task.runSequence, category: result.blockerCategory, requestedAction: result.requestedAction, status: 'pending-send', waitingReason: result.waitingReason, risk: result.risk, evidence: result.evidence, attemptedActions: result.attemptedActions, createdAt: new Date().toISOString() }
      const waiting = await updateTaskInput(taskId, result, (current) => ({
        ...current, state: 'waiting', waitingKind: 'human-intervention', waitingReason: result.waitingReason, result,
        humanBlocker: blocker,
      }))
      if (goal.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: 'task-human-intervention-required', message: result.waitingReason })
      for (const listener of humanBlockerListeners) void Promise.resolve().then(() => listener({ task: waiting, result })).catch((error) => recoveryIssues.push({ groupId: waiting.groupId, taskId, kind: 'human-blocker-notification', error: error.message }))
      return store.getTask(taskId)
    }
    throw new Error('task_completed_requires_review')
  }
  async function submitTaskResult(taskId, value, { recoveryError } = {}) {
    const result = parseTaskResult(value)
    const completionRecovery = result.status === 'completed' && recoveryError?.startsWith('topic_request_retry_exhausted:')
    const recoveredRequestId = completionRecovery ? recoveryError.slice('topic_request_retry_exhausted:'.length) : undefined
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    if (result.status !== 'completed') {
      const waiting = await serializeTasks(() => submitTaskResultInternal(taskId, result))
      if (result.waitingKind === 'information') void withoutInitiator(() => coordinateTaskResult(waiting, result)).catch((error) => recoveryIssues.push({ groupId: waiting.groupId, taskId, kind: 'task-notification', error: error.message }))
      return waiting
    }
    const prepared = await serializeTasks(async () => {
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
      const task = store.getTask(taskId)
      if (task === undefined || task.state !== 'running' && !(completionRecovery && task.state === 'waiting')) throw new Error(`task_not_active:${taskId}`)
      assertTaskInput(task, result)
      const handle = leafHandles.get(taskId)
      if (handle === undefined) throw new Error(`task_leaf_not_active:${taskId}`)
      const goal = ctx.goals.get(handle.agent)
      if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
      const checkpoints = task.checkpoints ?? []
      assertWorkflowPlan(task)
      if (checkpoints.length < 2) throw new Error(`task_checkpoints_insufficient:${taskId}`)
      if (!checkpoints.at(-1)?.coordinatorDecision) throw new Error(`task_checkpoint_review_pending:${taskId}`)
      if ((checkpoints.at(-1)?.remainingItems?.length ?? 0) > 0) throw new Error(`task_checkpoints_remaining:${taskId}`)
      return { task, handle, lastCheckpointId: checkpoints.at(-1).checkpointId, recoveredFromWaiting: completionRecovery && task.state === 'waiting' }
    })
    const reviewAttemptId = randomUUID()
    const reviewEvent = (kind, extra = {}) => recordTaskCoordinationEvent(taskId, { kind, reviewAttemptId, inputVersion: result.inputVersion, runSequence: result.runSequence, at: new Date().toISOString(), ...extra })
    await reviewEvent('completion-review-requested')
    let review
    try {
      review = await withoutInitiator(() => reviewCompletedTaskResult(prepared.task, result))
      await reviewEvent('completion-reviewed', { accepted: review.accepted })
    } catch (error) {
      await reviewEvent('completion-review-failed', { error: compactText(error.message, 1000) })
        .catch((eventError) => recoveryIssues.push({ groupId: prepared.task.groupId, taskId, kind: 'task-notification-telemetry', error: eventError.message }))
      throw error
    }
    if (!review.accepted) {
      await followupTaskInternal(prepared.task, `[TASK_RESULT_REJECTED]\n当前完成结果未通过最新目标验收：${review.reason}\n\n继续执行当前有效目标，补齐缺失实现与证据后再提交 completed。不得重复提交上一轮结论。`, `result-rejected:${taskId}:${fingerprint(result)}`)
      throw new Error(`task_result_objective_not_covered:${taskId}:${review.reason}`)
    }
    const completed = await serializeTasks(async () => {
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
      const current = store.getTask(taskId)
      if (current === undefined || current.state !== prepared.task.state || current.state !== 'running' && !prepared.recoveredFromWaiting) throw new Error(`task_not_active:${taskId}`)
      if (current.inputVersion !== prepared.task.inputVersion || current.runSequence !== prepared.task.runSequence || current.objective !== prepared.task.objective || current.checkpoints?.at(-1)?.checkpointId !== prepared.lastCheckpointId || !samePromptRefs(current.taskPromptRefs ?? [], prepared.task.taskPromptRefs ?? [])) throw new Error(`task_result_context_changed:${taskId}`)
      assertWorkflowPlan(current)
      assertTaskInput(current, result)
      const goal = ctx.goals.get(prepared.handle.agent)
      if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
      const completedAt = new Date().toISOString()
      const completed = await updateTaskInput(taskId, result, (task) => {
        if (task.state !== prepared.task.state || task.state !== 'running' && !prepared.recoveredFromWaiting) throw new Error(`task_not_active:${taskId}`)
        assertWorkflowPlan(task)
        if (task.checkpoints?.at(-1)?.checkpointId !== prepared.lastCheckpointId || !samePromptRefs(task.taskPromptRefs, prepared.task.taskPromptRefs)) throw new Error(`task_result_context_changed:${taskId}`)
        const blocker = prepared.recoveredFromWaiting && task.humanBlocker ? {
          ...task.humanBlocker, status: 'superseded', supersededAt: completedAt, supersedeReason: '原完成报告协调恢复后已完成任务',
          recallStatus: task.humanBlocker.messageId ? 'pending' : 'not-required',
        } : undefined
        return { ...task, acknowledgedInputVersion: result.inputVersion, state: 'completed', completion: result.summary, result, waitingKind: undefined, waitingReason: undefined,
          ...(blocker ? { humanBlocker: undefined, humanBlockerHistory: withHumanBlockerHistory(task, blocker) } : {}),
          executionEvents: [...(task.executionEvents ?? []),
            { kind: 'task-completed', inputVersion: result.inputVersion, runSequence: result.runSequence, at: completedAt }],
        }
      })
      if (goal.phase !== 'complete') ctx.goals.complete(prepared.handle.agent, goalRef(goal))
      return completed
    })
    if (prepared.recoveredFromWaiting && prepared.task.humanBlocker) {
      const authorization = getAuthorizationRequest(prepared.task.humanBlocker.requestId)
      for (const listener of authorizationDecisionListeners) await listener({ authorization, task: completed })
    }
    if (recoveredRequestId) await store.updateCoordinationRequest(completed.groupId, recoveredRequestId, { status: 'completed', nextRetryAt: undefined, lastError: undefined })
    void withoutInitiator(async () => {
      const committed = await runGroupResidentOperation(completed.groupId, () => topics.commitCompletionNotification(review.preparedNotification, completed, result))
      if (committed?.status) {
        await recordTaskCoordinationEvent(taskId, { kind: 'completion-notification-fallback', inputVersion: result.inputVersion, runSequence: result.runSequence, status: committed.status, at: new Date().toISOString() })
        await coordinateTaskResult(completed, result)
        return
      }
      await recordTaskCoordinationEvent(taskId, { kind: 'completion-notification-enqueued', inputVersion: result.inputVersion, runSequence: result.runSequence, outboundId: committed.outboundId, at: new Date().toISOString() })
        .catch((error) => recoveryIssues.push({ groupId: completed.groupId, taskId, kind: 'task-notification-telemetry', error: error.message }))
    }).catch(async (error) => {
      recoveryIssues.push({ groupId: completed.groupId, taskId, kind: 'task-notification', error: error.message })
      await withoutInitiator(() => coordinateTaskResult(completed, result)).catch((fallbackError) => recoveryIssues.push({ groupId: completed.groupId, taskId, kind: 'task-notification-fallback', error: fallbackError.message }))
    })
    const completedRunSequence = completed.runSequence
    prepared.handle.agent.whenIdle().then(async () => {
      const dispose = await serializeTasks(() => {
        const current = store.getTask(taskId)
        if (leafHandles.get(taskId) !== prepared.handle || current?.state !== 'completed' || current.runSequence !== completedRunSequence) return false
        leafHandles.delete(taskId)
        leafTaskBySession.delete(String(prepared.handle.agent.session.id))
        return true
      })
      if (dispose) await prepared.handle.dispose()
    }).catch(() => undefined)
    await withoutInitiator(() => pumpTasks())
    return completed
  }
  async function submitTaskCheckpointInternal(taskId, value) {
    const checkpoint = parseTaskCheckpoint(value)
    const diagnostic = isDiagnosticCheckpoint(checkpoint)
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    const { submitted, reviewTask } = await serializeTasks(async () => {
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
      const task = store.getTask(taskId)
      if (task === undefined || task.state !== 'running') throw new Error(`task_not_running:${taskId}`)
      assertTaskInput(task, checkpoint)
      if (!leafHandles.has(taskId)) throw new Error(`task_leaf_not_active:${taskId}`)
      if (!diagnostic) assertCurrentTaskPrompts(task, store.getTaskPrompts())
      const accepted = task.checkpoints?.find(item => item.checkpointId === stableId('checkpoint', `${taskId}:${fingerprint(checkpoint)}`) && item.coordinatorDecision)
      if (accepted) return { submitted: accepted, reviewTask: task }
      const pendingReview = task.checkpoints?.at(-1)
      let superseded
      if (pendingReview && !pendingReview.coordinatorDecision) {
        const comparable = ({ checkpointId: _checkpointId, submittedAt: _submittedAt, coordinatorDecision: _decision, coordinatorReason: _reason, guidance: _guidance, reviewedAt: _reviewedAt, ...rest }) => rest
        if (JSON.stringify(comparable(pendingReview)) === JSON.stringify(checkpoint)) return { submitted: pendingReview, reviewTask: task }
        if (!diagnostic) throw new Error(`task_checkpoint_review_pending:${taskId}`)
        superseded = pendingReview
      }
      if (checkpoint.kind === 'plan-confirmed' && checkpoint.remainingItems.length < 1) throw new Error(`task_checkpoint_plan_insufficient:${taskId}`)
      if (checkpoint.kind === 'plan-confirmed') {
        const completed = new Set((task.checkpoints ?? []).filter(item => item.kind === 'stage-completed' && ['acknowledge', 'guidance'].includes(item.coordinatorDecision)).flatMap(item => item.completedItems))
        if (new Set(checkpoint.remainingItems).size !== checkpoint.remainingItems.length || checkpoint.remainingItems.some(item => completed.has(item))) throw new Error(`task_checkpoint_plan_stage_duplicate:${taskId}`)
        const refs = task.taskPromptRefs ?? []
        if (refs.length > 0 && !checkpoint.workflowAssessment) throw new Error(`task_workflow_assessment_required:${taskId}`)
        if (checkpoint.workflowAssessment && !samePromptRefs(checkpoint.workflowAssessment.promptRefs, refs)) throw new Error(`task_workflow_assessment_refs_invalid:${taskId}`)
        const selectedIds = new Set(refs.map((ref) => ref.id))
        if ((checkpoint.workflowAssessment?.inapplicableSteps ?? []).some((item) => !selectedIds.has(item.promptId))) throw new Error(`task_workflow_inapplicable_prompt_invalid:${taskId}`)
        const messageIds = new Set(topics.taskMessages(task).map((message) => message.messageId))
        for (const exception of checkpoint.workflowAssessment?.exceptions ?? []) {
          if (new Set(exception.basisMessageIds).size !== exception.basisMessageIds.length || exception.basisMessageIds.some((id) => !messageIds.has(id))) throw new Error(`task_workflow_exception_basis_invalid:${taskId}`)
        }
      } else {
        if (checkpoint.workflowAssessment) throw new Error(`task_workflow_assessment_plan_only:${taskId}`)
        if (!diagnostic) assertWorkflowPlan(task)
      }
      if (checkpoint.kind === 'stage-completed' && (!checkpoint.stageTask || !(task.stageTasks ?? []).includes(checkpoint.stageTask))) throw new Error(`task_checkpoint_stage_invalid:${taskId}`)
      const retained = (task.checkpoints ?? []).filter((item) => item !== superseded)
      const previousRemainingItems = retained.at(-1)?.remainingItems ?? []
      if (diagnostic && checkpoint.completedItems.length) throw new Error(`task_checkpoint_progress_requires_stage_completed:${taskId}`)
      if (checkpoint.kind === 'stage-completed') {
        if (!task.checkpoints?.at(-1)?.coordinatorDecision) throw new Error(`task_checkpoint_review_pending:${taskId}`)
        const completesCurrentItem = checkpoint.completedItems.length === 1 && checkpoint.completedItems[0] === previousRemainingItems[0]
        if (checkpoint.stageTask !== previousRemainingItems[0] || (checkpoint.stageId && checkpoint.stageId !== task.stagePlan?.find(stage => stage.title === previousRemainingItems[0])?.stageId)) throw new Error(`task_checkpoint_stage_invalid:${taskId}`)
        const keepsRemainingOrder = checkpoint.remainingItems.length === Math.max(0, previousRemainingItems.length - 1) && checkpoint.remainingItems.every((item, index) => item === previousRemainingItems[index + 1])
        if (!completesCurrentItem || !keepsRemainingOrder) throw new Error(`task_checkpoint_must_advance_one:${taskId}:${previousRemainingItems[0] ?? 'none'}`)
      } else if (checkpoint.kind !== 'plan-confirmed' && (checkpoint.remainingItems.length !== previousRemainingItems.length || checkpoint.remainingItems.some((item, index) => item !== previousRemainingItems[index]))) {
        throw new Error(`task_checkpoint_progress_requires_stage_completed:${taskId}`)
      }
      const submitted = { ...checkpoint, checkpointId: stableId('checkpoint', `${taskId}:${fingerprint(checkpoint)}`), submittedAt: new Date().toISOString() }
      const reviewTask = await updateTaskInput(taskId, checkpoint, (current) => ({ ...current, acknowledgedInputVersion: checkpoint.inputVersion, checkpoints: [...retained, submitted],
        ...(superseded ? { executionEvents: [...(current.executionEvents ?? []), { kind: 'checkpoint-review-superseded', checkpoint: superseded, at: new Date().toISOString() }] } : {}),
        updatedAt: new Date().toISOString() }))
      if (superseded) topics.invalidateTaskReviews(taskId, 'task_checkpoint_review_superseded')
      return { submitted, reviewTask }
    })
    return runCheckpointReview(reviewTask, submitted)
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
      supersedeReason: reason?.trim() || '按当前统一人工介入逻辑重新提交',
      recallStatus: blocker.messageId ? 'pending' : 'not-required',
    }
    const replacement = {
      requestId: nextRequestId, fingerprint: blocker.fingerprint, runSequence: blocker.runSequence,
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
    const reply = comment?.trim() || (decision === 'approved' ? '批准' : '拒绝')
    const answered = {
      ...blocker, status: 'answered', decision, reply,
      decisionSource: source, decidedAt: new Date().toISOString(), ...(replyMessageId ? { replyMessageId } : {}),
      ...(blocker.messageId && source === 'web' ? { recallStatus: 'pending' } : { recallStatus: 'not-required' }),
    }
    const queued = await store.updateTask(task.taskId, (current) => ({
      ...current, state: 'queued', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined,
      resumeContext: `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${requestId}\nDecision: ${decision}\nReply: ${reply}\nSource: ${source}`,
      humanBlocker: answered, humanBlockerHistory: withHumanBlockerHistory(current, answered),
    }))
    const pumping = pumpTasks()
    if (startingTasks.size === 0) await pumping
    else void pumping.catch((error) => recoveryIssues.push({ groupId: task.groupId, taskId: task.taskId, kind: 'task-pump', error: error.message }))
    const running = store.getTask(queued.taskId)
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
      agentCtx.on('agent/pre-step', createTaskReportStepGate({
        isBlocked: () => { const current = store.getTask(task.taskId); return current && reports.hasBlocking(current) },
        isResolutionMessage: (_agent, message) => {
          if (message.source?.kind !== 'coordinator') return false
          const current = store.getTask(task.taskId)
          if (!current) return false
          if (message.id === stableId('message', `task-input:${current.taskId}:${current.runSequence}:${current.inputVersion}`)) return true
          return taskReports(current).some(report => {
            if (report.runSequence !== current.runSequence || report.inputVersion !== current.inputVersion || !['accepted', 'rejected', 'failed'].includes(report.status)) return false
            const identity = report.receipt?.code === 'task_checkpoint_rejected' ? `checkpoint-rejected:${report.receipt.checkpointId}`
              : report.error?.startsWith('task_result_objective_not_covered:') ? `result-rejected:${task.taskId}:${fingerprint(report.value)}`
                : `task-report:${task.taskId}:${report.submissionId}:${report.status}`
            return message.id === stableId('message', identity)
          })
        },
      }))
      agentCtx.systemPrompt.section({
        name: 'group-task-blocking-policy', order: 45,
        text: () => `## 群任务执行与完成规则

你必须通过 submit_task_result 结束任务；自然语言总结、Goal complete 或 turn end 都不构成 Task 完成。checkpoint/result 的 accepted:true 仅表示报告已持久接收；input-wait/review-wait 时结束当前轮并等待 TASK_REPORT_REVIEWED，不重复提交、不继续依赖该批准的动作。submissionId 标识同一份报告，重试保持不变；有新事实时提交新的报告。

### 工作区 Skill 的通用执行边界

根据当前任务现场与已注入描述命中任何适用 Skill 时，必须加载并遵循其完整说明。一旦加载 Skill，不得在尚未完成其资格判断、必要操作、验证与读回，或依据 Skill 说明明确判定本次无需操作之前，静默返回业务主线。没有满足执行条件时不得为了完成 Task 硬凑 Skill 产物。

${quotedMessageRecoveryPolicy('leaf')}

Task objective 限制的是业务动作范围，包括业务代码、业务数据、部署环境、外部系统和对外操作。适用的工作区规则，或由工作区规则授权且由 Skill 明确要求的内部维护动作不视为扩大 Task objective，但必须严格限制在该规则和 Skill 声明的内部目录、数据类型和操作边界内，不得借此修改未获授权的业务代码、业务数据、环境或外部系统。Runtime 不指定或绑定任何具体 Skill，是否适用及如何执行以当前注入的 Skill 描述和完整说明为准。

### 与主会话的内部检查点

开始执行后把当前目标拆成至少 1 个有验收意义的检查点，并立即通过 submit_task_checkpoint 提交 plan-confirmed。计划必须携带 workflowAssessment：精确列出当前已选流程引用、可复用证据、不适用步骤，以及任何覆盖流程要求的例外；例外必须引用明确提出该要求的原始 basisMessageIds，主会话生成的目标、验收标准或旧摘要不能充当例外依据。若当前目标与流程冲突且原始消息没有明确例外，提交 scope-conflict 或修正计划，不能按扩写目标继续执行。后续按 remainingItems 顺序逐项提交 stage-completed，每次 completedItems 只填本次完成的第一项，不累计历史；阶段提交被拒绝时先纠正并取得确认，再进入下一阶段。Host 会自动校验普通阶段的版本、顺序和非空证据，需要协调判断时再交给主会话。收到新版 TASK_TOPIC_CONTEXT 后，按其中的 progressImpact 处理：preserve 表示保留未受影响的既有进展，replan 表示按修订范围重提计划。范围冲突、证据缺口或风险实质变化时提交对应 checkpoint；即使尚无计划、计划被拒或流程失效也可上报。异常报告 completedItems 必须为空，remainingItems 保持最近已确认进度；若抢占待审计划，原待审项归档且必须重新规划。完成前 remainingItems 必须为空。不要提交命令流水、等待或无新事实的状态；checkpoint 不发送群聊，也不代替 submit_task_result。

### 任务授权边界

Task objective 是本任务的动作授权上限，必须逐字尊重其中的动作范围。若 objective 只要求“看看、查一下、排查、分析、核对、监控”或其他诊断/观察工作，你只能读取、核验、定位根因并提交证据和建议，不得修改代码或数据、提交 PR、合并、构建、部署、执行修复方案，也不得因为发现了明确根因就自行扩大为修复。只有 objective 明确包含修复、修改、实施、合并、发布或执行等变更动作时，才能进行对应变更；配置的叶子会话提示词也不得扩大该授权。

### 叶子会话内置通用规范

你负责执行当前叶子任务，常驻主会话负责沟通协调。以当前目标、原始依据、最新确认和工作区规则确定范围；历史标题、旧结果和流程模板不提供额外授权。

先读当前实现、运行态或原始材料，再作判断。历史分支、库表、环境、版本和结论仅供定位，必须现场复核。结论先给结果再附证据，区分观察、推断和未验证项，并主动检验反例。

把选用流程落实为本任务可验证的阶段和验收项，明确适用步骤、沿用的可核验证据和不适用依据，按下述流程索引及检查点协议推进。目标修订时说明哪些证据仍有效、哪些要重验，保留未受影响的工作；独立目标交主会话判断是否拆分任务。

独立回读文件、PR、流水线、部署、数据或其他实际交付结果；一个层级成功不能替代其他必需层级。用户明确停止或转交时如实交接，不能包装成验收通过。完成前提交本次范围、结果、证据与产物路径、未验证项和必要的简短复盘；按当前工作区规则判断是否需要沉淀经验，不复制敏感数据或把临时事实写成长期规则。

${store.getLeafSessionPrompt?.() ? `### 用户补充的叶子会话提示词\n\n以下内容补充通用规范，不替代任务授权与 Runtime 执行协议。\n\n${store.getLeafSessionPrompt()}` : ''}

### 可用任务流程索引

${(store.getTaskPrompts?.() ?? []).filter((item) => item.enabled).map((item) => `- ${item.id}｜${item.name}｜${item.description}`).join('\n') || '暂无已配置的任务流程；按通用提示词执行。'}

像使用 Skill 一样，根据当前任务、目标、有效授权和剩余阶段语义匹配索引，调用 load_task_prompt 加载匹配流程的正文。一次任务可以组合多个流程，数量不固定；随着工作推进按需补充，重复步骤只执行一次，不预先加载全部流程。加载成功即记入当前组合，无需额外确认选择。流程正文引用其他流程时，仍须判断其是否适用于当前目标，再按索引 ID 加载；引用不扩大授权。

压缩或恢复后，下方会重新注入当前已加载的流程组合；这不是固定任务类型映射。继续根据当前目标和剩余工作核对适用性，缺少的流程按需加载，不再适用的流程通过 select_task_prompts 调整保留集合（允许空集合）。任务目标或授权变化后重新匹配。没有匹配项时按通用规范和任务目标执行，不强套流程。workType 不用于定位具体流程。

### 当前任务流程

${(() => {
  const current = store.getTask(task.taskId) ?? task
  const prompts = new Map((store.getTaskPrompts?.() ?? []).map((item) => [item.id, item]))
  if (!(current.taskPromptRefs?.length > 0)) return '尚未加载适用的任务流程，请根据当前目标和索引按需匹配。'
  return current.taskPromptRefs.map((ref) => {
    const item = prompts.get(ref.id)
    if (!item || !item.enabled) return `- ${ref.id}：流程已停用或删除，请重新选择。`
    return `## ${item.name}（${item.id}｜r${item.revision}）\n\n${item.prompt}`
  }).join('\n\n')
})()}

### 当前执行轮次验收标准

${(store.getTask(task.taskId) ?? task).acceptanceCriteria.map((item) => `- ${item}`).join('\n')}

### 当前执行轮次阶段任务

${stagePlanFor(store.getTask(task.taskId) ?? task, (store.getTask(task.taskId) ?? task).stageTasks).map(item => `- ${item.title}（stageId: ${item.stageId}）`).join('\n')}

### Topic 固定版本输入

${JSON.stringify({ taskId: task.taskId, topicRefs: store.getTask(task.taskId)?.topicRefs ?? task.topicRefs, inputVersion: store.getTask(task.taskId)?.inputVersion ?? task.inputVersion, runSequence: store.getTask(task.taskId)?.runSequence ?? task.runSequence })}

原始消息通过 group_topic_context_get 按 Topic 固定版本读取；返回 nextOffset 或 nextTextOffset 时必须按该游标连续读取，不得猜测未读取的上下文。每个 checkpoint/result 必须带实际使用的 inputVersion/runSequence。Task objective 与验收标准仍是执行边界。

### 当前事实与人工处理意见

${JSON.stringify((({ snapshotAt, objective, topicRefs, taskId, groupId, inputVersion, runSequence, ...facts }) => facts)(queryFactsSnapshot(store.getTask(task.taskId) ?? task)))}

完成结果提交后由 Runtime 完整交给 resident 主会话，再由主会话结合 Task 完整时间线判断如何通知原群相关参与人。群聊消息的发送、回复、编辑、更正和撤回均由 resident 主会话判断；叶子只提交业务结果、结论、证据、未验证项和置信边界，不得判断、建议或申请撤回/编辑/更正任何群消息，不得提供消息处置目标或 messageId。群聊通知只有 Runtime 这一个出口：叶子会话不得调用 DWS 或其他消息工具向来源群发送、回复、编辑或撤回任务进度、阻塞或完成通知，也不得把自行发送群通知作为完成证据；叶子只允许读取群消息用于业务核验，并通过 submit_task_result 提交结构化结果。

### 阻塞规则

除以下两类情况外，不得暂停或阻塞 Goal，也不得提交 waiting：
1. \`waitingKind=information\`：只有 Task 相关参与人才能补充的目标、完成条件或必要业务信息不明确；必须提供具体 questions，Runtime 将由主会话根据完整消息时间线选择实际询问对象。
2. \`waitingKind=human-intervention\`：已经取得证据且自身无法解决的操作红线、网络中断、磁盘不足、资源不足、意外事件或必须真人确认的处置方案；必须提供 blockerCategory、risk、evidence、attemptedActions 和 requestedAction。risk 单独说明执行该操作可能造成的具体影响；操作红线使用 blockerCategory=redline，并把完整操作范围和不在授权内的事项写入 requestedAction；Runtime 只发送这一条人工介入消息。

代码错误、命令失败、可重试波动、普通不确定性、实现困难或正在正常运行但耗时较长的外部流水线，应继续诊断或监控，不得伪装成人工阻塞。不要直接使用 Goal 工具标记 blocked；合法等待统一通过 submit_task_result 交给 Host。Goal 执行轮数耗尽时 Host 会停止自动续接并形成可见的异常介入事项。`,
      })
      agentCtx.tools.register({
        name: 'group_topic_context_get', description: '按 Task 已接纳的固定版本读取原始 Topic 消息。',
        parameters: { type: 'object', additionalProperties: false, properties: { topicId: { type: 'string' }, revision: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, textOffset: { type: 'integer' } }, required: ['topicId', 'revision'] },
        output: { schema: { type: 'object' }, render: (_args, out) => [{ type: 'text', text: JSON.stringify(out) }] },
        execute: (args, exec) => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error('task_topic_wrong_session')
          const current = store.getTask(task.taskId)
          if (!current.topicRefs.some((ref) => ref.topicId === args.topicId && ref.revision === args.revision)) throw new Error('task_topic_not_admitted')
          return boundedTopicContext(store.getTopicContext({ ...args, groupId: current.groupId, limit: args.limit ?? 10 }), { textOffset: args.textOffset ?? 0 })
        },
      })
      agentCtx.tools.register({
        name: 'load_task_prompt', description: '根据任务和目标匹配索引后，按 ID 加载一个流程正文并加入当前组合；可多次加载互补流程，压缩和恢复后按组合重新注入。',
        parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' }, revision: { type: 'integer' } }, required: ['id', 'name', 'description', 'prompt', 'revision'] }, render: (_args, out) => [{ type: 'text', text: `# ${out.name}\n\n${out.prompt}\n\n流程引用：${out.id}@${out.revision}` }] },
        execute: async ({ id }, exec) => serializeTasks(async () => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error(`task_prompt_wrong_session:${task.taskId}`)
          const item = (store.getTaskPrompts?.() ?? []).find((value) => value.id === id && value.enabled)
          if (!item) throw new Error(`task_prompt_not_found:${id}`)
          const inputVersion = store.getTask(task.taskId)?.inputVersion
          await store.updateTask(task.taskId, (value) => {
            if (value.inputVersion !== inputVersion || !['running', 'waiting'].includes(value.state)) throw new Error(`task_prompt_selection_stale:${task.taskId}`)
            const refs = new Map((value.taskPromptRefs ?? []).map((ref) => [ref.id, ref]))
            refs.set(item.id, { id: item.id, revision: item.revision })
            return { ...value, taskPromptRefs: [...refs.values()], executionEvents: [...(value.executionEvents ?? []), { kind: 'task-prompt-loaded', inputVersion, id: item.id, revision: item.revision, at: new Date().toISOString() }], updatedAt: new Date().toISOString() }
          })
          return { id: item.id, name: item.name, description: item.description, prompt: item.prompt, revision: item.revision }
        }),
      })
      agentCtx.tools.register({
        name: 'select_task_prompts', description: '可选：根据当前目标和剩余阶段调整已加载流程的保留集合，移除不再适用项；ids 是完整保留列表，空列表清空。加载流程无需调用本工具。',
        parameters: { type: 'object', additionalProperties: false, properties: { inputVersion: { type: 'integer' }, ids: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['inputVersion', 'ids', 'reason'] },
        output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, taskPromptRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, revision: { type: 'integer' } }, required: ['id', 'revision'] } } }, required: ['taskId', 'taskPromptRefs'] }, render: (_args, out) => [{ type: 'text', text: `当前任务流程已更新：${out.taskPromptRefs.map((ref) => `${ref.id}@${ref.revision}`).join(', ') || '未选择专用流程'}` }] },
        execute: async ({ inputVersion, ids, reason }, exec) => serializeTasks(async () => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error(`task_prompt_wrong_session:${task.taskId}`)
          if (!reason.trim()) throw new Error('task_prompt_selection_reason_required')
          if (new Set(ids).size !== ids.length) throw new Error('task_prompt_selection_duplicate')
          const current = store.getTask(task.taskId)
          if (!current || current.inputVersion !== inputVersion || !['running', 'waiting'].includes(current.state)) throw new Error(`task_prompt_selection_stale:${task.taskId}`)
          const prompts = new Map((store.getTaskPrompts?.() ?? []).filter((item) => item.enabled).map((item) => [item.id, item]))
          const refs = ids.map((id) => {
            const item = prompts.get(id)
            if (!item) throw new Error(`task_prompt_not_found:${id}`)
            if (!(current.executionEvents ?? []).some((event) => event.kind === 'task-prompt-loaded' && event.inputVersion === inputVersion && event.id === id && event.revision === item.revision)) throw new Error(`task_prompt_not_loaded:${id}`)
            return { id, revision: item.revision }
          })
          await store.updateTask(task.taskId, (value) => {
            if (value.inputVersion !== inputVersion || !['running', 'waiting'].includes(value.state)) throw new Error(`task_prompt_selection_stale:${task.taskId}`)
            return { ...value, taskPromptRefs: refs, executionEvents: [...(value.executionEvents ?? []), { kind: 'task-prompts-selected', inputVersion, taskPromptRefs: refs, reason: reason.trim(), at: new Date().toISOString() }], updatedAt: new Date().toISOString() }
          })
          return { taskId: task.taskId, taskPromptRefs: refs }
        }),
      })
      for (const [name, reportType, parse, parameters] of [
        ['submit_task_checkpoint', 'checkpoint', parseTaskCheckpoint, taskCheckpointJsonSchema],
        ['submit_task_result', 'result', parseTaskResult, taskResultJsonSchema],
      ]) agentCtx.tools.register({
        name, description: '持久接纳执行报告。返回等待收据时尚未批准推进或完成；Runtime 处理后主动通知，不重复提交。',
        parameters,
        output: { schema: taskReportReceiptSchema, render: (_args, out) => [{ type: 'text', text: JSON.stringify(out) }] },
        execute: async (args, exec) => {
          if (String(exec.agent?.session.id) !== task.childSessionId) throw new Error(`task_${reportType}_wrong_session:${task.taskId}`)
          if (store.getTask(task.taskId)?.childSessionId !== task.childSessionId) throw new Error('leaf_tool_session_mismatch')
          return reports.submit(task.taskId, reportType, parse(args))
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
    if (task.state === 'running' && !reports.hasBlocking(task) && !isGoalRoundLimitExhausted(existing) && (
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
    try {
      if (runtimeClosing || store.getTask(task.taskId)?.state === 'completed') { handle.agent.cancel({ kind: 'user' }); return handle }
      ensureLeafDescriptor(handle, task); applyPermission(handle, 'danger-full-access'); await attachGoal(task, handle, true); return handle
    } catch (error) {
      leafHandles.delete(task.taskId); leafTaskBySession.delete(task.childSessionId); await handle.dispose(); throw error
    }
  }
  async function resumeLeaf(task) {
    if (leafHandles.has(task.taskId)) return leafHandles.get(task.taskId)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId(task.childSessionId), agentOptions, setup: leafSetup(task), signal: AbortSignal.timeout(resumeTimeoutMs) })
    ensureLeafDescriptor(handle, task); applyPermission(handle, 'danger-full-access')
    await attachGoal(task, handle, false); return handle
  }
  async function restartInactiveLeaf(task, previous, attempt, cause = 'paused') {
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
    await dispatchTaskInput(store.getTask(task.taskId))
    await store.recordAlert({ taskId: task.taskId, fingerprint: `leaf-${cause}-restarted:${attempt}`, detail: `Replaced ${cause} DSH leaf Session ${task.childSessionId} with ${replacementSessionId}`, status: 'resolved' })
    return replacement
  }
  async function inspectRunningTasks() {
    return serializeTasks(async () => {
      const results = []
      for (const listed of store.listTasks().filter((task) => task.state === 'running')) {
        let task = store.getTask(listed.taskId)
        if (task?.state !== 'running') continue
        if (reports.hasBlocking(task)) {
          reports.recover(task)
          results.push({ taskId: task.taskId, ok: true, waiting: 'coordination' })
          continue
        }
        const pendingCheckpoint = task.checkpoints?.at(-1)
        if (pendingCheckpoint && !pendingCheckpoint.coordinatorDecision && !checkpointReviewRuns.has(pendingCheckpoint.checkpointId)) {
          void runCheckpointReview(task, pendingCheckpoint)
            .catch((error) => recoveryIssues.push({ groupId: task.groupId, taskId: task.taskId, kind: 'checkpoint-review-recovery', error: error.message }))
        }
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
            await dispatchTaskInput(task)
            sessionRecovered = true
            await store.recordAlert({ taskId: task.taskId, fingerprint: 'leaf-session-recovered', detail: `Recovered DSH leaf Session ${task.childSessionId}`, status: 'resolved' })
          }
          const before = ctx.goals.get(handle.agent)
          if (isGoalRoundLimitExhausted(before)) {
            const reason = `DSH leaf Goal已耗尽执行轮数（${before.roundsStarted}/${before.maxGoalRounds}），但Task仍为running，已停止自动续接。`
            await submitTaskResultInternal(task.taskId, {
              inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'waiting', waitingKind: 'human-intervention', summary: reason,
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
              await followupTaskInternal(task, `你刚才结束了执行轮次，但尚未调用 submit_task_result，因此 Task 仍未完成。请按照系统提示中的叶子会话提示词继续工作，取得可独立核验的结果后调用 submit_task_result；不要只输出自然语言总结。`)
              await store.recordAlert({ taskId: task.taskId, fingerprint: 'leaf-result-submission-requested', detail: `Requested structured result from completed DSH leaf Session ${task.childSessionId}`, status: 'resolved' })
              results.push({ taskId: task.taskId, ok: true, resultRequested: true, sessionRecovered, goalRecovered: true, agentStatus: handle.agent.status })
              continue
            }
            const attempt = (pausedRecoveryCounts.get(task.taskId) ?? 0) + 1
            pausedRecoveryCounts.set(task.taskId, attempt)
            if (attempt <= 2) {
              handle = await restartInactiveLeaf(task, handle, attempt)
              task = store.getTask(task.taskId)
              sessionRecovered = true
              goalRecovered = true
            } else {
              const reason = `DSH leaf Session连续${attempt}次在未提交结构化结果时进入${before.phase}，自动重建两次后仍未恢复。`
              await submitTaskResultInternal(task.taskId, {
                inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'waiting', waitingKind: 'human-intervention', summary: reason,
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
          } else if (handle.agent.status === 'idle') {
            const identity = `running-idle-recovery:${task.taskId}:${task.runSequence}:${task.inputVersion}`
            try {
              await followupTaskInternal(task, 'Task 仍为 running，但当前叶子执行已停下。继续原任务，先核对当前事实和未完成项，再按当前有效目标完成剩余工作并提交结构化结果。', identity)
              await store.recordAlert({ taskId: task.taskId, fingerprint: 'leaf-idle-continuation-requested', detail: `Requested continuation from idle DSH leaf Session ${task.childSessionId}`, status: 'resolved' })
              results.push({ taskId: task.taskId, ok: true, continuationRequested: true, sessionRecovered, goalRecovered, agentStatus: handle.agent.status })
              continue
            } catch (error) {
              if (!isAgentUnavailableError(error)) throw error
              const attempt = (pausedRecoveryCounts.get(task.taskId) ?? 0) + 1
              pausedRecoveryCounts.set(task.taskId, attempt)
              if (attempt > 2) {
                const reason = `DSH leaf Session连续${attempt}次不可用，自动重建两次后仍未恢复。`
                await submitTaskResultInternal(task.taskId, {
                  inputVersion: task.inputVersion, runSequence: task.runSequence, status: 'waiting', waitingKind: 'human-intervention', summary: reason,
                  evidence: [`Task ${task.taskId}`, `Session ${task.childSessionId}`, `Goal ${before.id} ${before.phase}/${before.activation ?? 'none'}`, error instanceof Error ? error.message : String(error)], artifacts: [], waitingReason: reason,
                  blockerCategory: 'unexpected', risk: '任务载体持续不可用，任务无法继续执行且可能延误交付。', attemptedActions: ['Runtime续执行失败', '自动重建叶子会话两次并恢复同一Task Goal'], requestedAction: '请检查 DSH Agent Registry 与 Session 状态后引用本阻塞消息回复处置意见。',
                })
                results.push({ taskId: task.taskId, ok: false, waiting: true, error: reason })
                continue
              }
              handle = await restartInactiveLeaf(task, handle, attempt, 'unavailable')
              task = store.getTask(task.taskId)
              sessionRecovered = true
              goalRecovered = true
            }
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
  function pumpTasks() {
    const pending = pumpTail.then(pumpTasksInternal, pumpTasksInternal)
    pumpTail = pending.catch(() => undefined)
    return pending
  }
  async function pumpTasksInternal() {
    if (runtimeClosing) return
    const tasks = store.listTasks()
    let available = taskConcurrencyLimit - tasks.filter((task) => task.state === 'running').length - startingTasks.size
    for (const task of tasks.filter((item) => item.state === 'queued')) {
      if (available <= 0) break
      if (store.getTask(task.taskId)?.state !== 'queued') continue
      startingTasks.add(task.taskId)
      available -= 1
      try {
        if (!residentHandles.has(task.groupId)) throw new Error(`resident_not_active:${task.groupId}`)
        if (task.resumeContext) {
          const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
          const running = await store.updateTask(task.taskId, (current) => current.state === 'queued' ? { ...current, state: 'running', resumeContext: undefined } : current)
          if (running.state !== 'running') continue
          resumeGoalAfterResolution(handle, ctx.goals.get(handle.agent))
          await followupTaskInternal(running, `${task.resumeContext}\n\nContinue the same task only within the approved scope. Re-check current state before acting.`)
        } else if (task.reopenContext) {
          const handle = await resumeLeaf(task)
          const running = await store.updateTask(task.taskId, (current) => current.state === 'queued' ? { ...current, state: 'running', reopenContext: undefined } : current)
          if (running.state === 'completed') {
            signalTaskCancellation(task.taskId); leafHandles.delete(task.taskId); leafTaskBySession.delete(task.childSessionId)
            await handle.dispose(); cancellingTasks.delete(task.taskId); continue
          }
          replaceTaskGoalObjective(running, handle)
          await followupTaskInternal(running, `[TASK_REOPEN]\n执行轮次：${task.runSequence}\n当前有效目标：${task.objective}\n本轮验收标准：${JSON.stringify(task.acceptanceCriteria)}\n本轮阶段任务：${JSON.stringify(task.stageTasks)}\n\n${task.reopenContext}\n\n这是独立的新执行轮次。历史轮次只供参考，不得把旧结果当成本轮完成证据；请独立核验当前事实，并在当前有效目标与原始来源消息的授权范围内重新提交可核验结果。`)
        } else {
          const handle = await createLeaf(task)
          if (runtimeClosing) { await handle.dispose(); continue }
          const current = await store.updateTask(task.taskId, (item) => item.state === 'queued' ? { ...item, state: 'running' } : item)
          if (current.state === 'completed') {
            signalTaskCancellation(task.taskId)
            leafHandles.delete(task.taskId); leafTaskBySession.delete(task.childSessionId)
            await handle.dispose(); cancellingTasks.delete(task.taskId)
            continue
          }
        }
        await dispatchTaskInput(store.getTask(task.taskId))
      } catch (error) {
        recoveryIssues.push({ groupId: task.groupId, taskId: task.taskId, kind: 'task-start', error: error.message })
      } finally {
        startingTasks.delete(task.taskId)
        available = taskConcurrencyLimit - store.listTasks().filter((item) => item.state === 'running').length - startingTasks.size
      }
    }
  }
  function withRevisedObjective(current, objective, title, decisionId) {
    const revised = typeof objective === 'string' ? objective.trim() : ''
    const revisedTitle = typeof title === 'string' ? title.trim() : ''
    if (!revised || revised === current.objective) {
      if (revisedTitle) throw new Error('task_title_requires_objective_revision')
      return current
    }
    if (!revisedTitle) throw new Error('task_objective_title_required')
    return { ...current, title: revisedTitle, objective: revised, objectiveHistory: [...(current.objectiveHistory ?? []), {
      objective: current.objective, revisedAt: new Date().toISOString(), topicRefs: current.topicRefs, inputVersion: current.inputVersion, ...(decisionId ? { decisionId } : {}),
    }], titleHistory: [...(current.titleHistory ?? []), {
      title: current.title ?? current.objective, revisedAt: new Date().toISOString(), inputVersion: current.inputVersion, runSequence: current.runSequence, ...(decisionId ? { decisionId } : {}),
    }] }
  }
  function replaceTaskGoalObjective(task, handle) {
    const goal = ctx.goals.get(handle.agent)
    if (goal && goal.phase !== 'complete') ctx.goals.complete(handle.agent, goalRef(goal))
    ctx.goals.create(handle.agent, { objective: task.objective, maxGoalRounds })
  }
  async function mutateTask(task, operation, transform) {
    if (!operation) return store.updateTask(task.taskId, transform)
    const result = await store.applyTaskOperation({ taskId: task.taskId, operationId: operation.operationId,
      expectedInputVersion: operation.inputVersion, expectedRunSequence: operation.runSequence, transform })
    return result.task
  }
  function topicInputText(task) {
    const messages = topics.taskMessages(task)
    const revision = task.executionEvents?.findLast(event => event.kind === 'input-revised' && event.previousInputVersion + 1 === task.inputVersion)
    const progressImpact = revision?.progressImpact ?? (task.checkpoints?.length ? 'preserve' : 'replan')
    return `[TASK_TOPIC_CONTEXT]\nTask 输入：${JSON.stringify({ taskId: task.taskId, inputVersion: task.inputVersion, runSequence: task.runSequence, topicRefs: task.topicRefs, progressImpact })}\n变化说明：${revision?.reason ?? '读取当前系统提示中的有效目标、验收标准、阶段与流程。'}\n原始输入共 ${messages.length} 条；按 group_topic_context_get 读取固定 Topic 版本原文。当前目标、验收和阶段只在系统提示中提供，不重复展开。原文是待核验来源；动作不得超出原始授权。checkpoint/result 必须提交本次 inputVersion 和 runSequence。`
  }
  async function dispatchTaskInput(task) {
    const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
    const id = stableId('message', `task-input:${task.taskId}:${task.runSequence}:${task.inputVersion}`)
    const pending = [...(handle.agent.inbox?.nextStep ?? []), ...(handle.agent.inbox?.nextTurn ?? [])]
    const recorded = pending.some((message) => message.id === id) || handle.agent.session.snapshotEvents().some((event) =>
      event.type === 'user/message' && event.data?.id === id)
    if (!recorded) handle.agent.steer(Object.freeze({ ...createUserMessage({ content: [{ type: 'text', text: topicInputText(task) }, ...boundedRecent(topics.taskMessages(task), TASK_MESSAGE_CONTEXT_MAX_CHARS, 50).flatMap((message) => message.imageRefs ?? []).map((attachment) => ({ type: 'image', attachment }))], source: { kind: 'coordinator' } }), id }))
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    if (sessions?.flush) await sessions.flush(handle.agent.session)
    await store.updateTask(task.taskId, (current) => current.inputVersion === task.inputVersion ? { ...current, dispatchedInputVersion: task.inputVersion } : current)
  }
  async function reopenCompletedTaskInternal(task, context, topicRefs, title, objective, acceptanceCriteria, stageTasks, operation) {
    if (operation && task.appliedOperations.includes(operation.operationId)) { await pumpTasks(); return store.getTask(task.taskId) }
    if (task.state !== 'completed') throw new Error(`task_not_completed:${task.taskId}`)
    const nextObjective = typeof objective === 'string' && objective.trim() ? objective.trim() : task.objective
    const plan = normalizeRunPlan(nextObjective, acceptanceCriteria, stageTasks)
    const stagePlan = stagePlanFor({ taskId: task.taskId, runSequence: task.runSequence + 1 }, plan.stageTasks)
    const queued = await mutateTask(task, operation, (current) => ({
      ...withRevisedObjective(current, nextObjective, title, operation?.decisionId),
      topicRefs, inputVersion: current.inputVersion + 1, state: 'queued', runSequence: current.runSequence + 1, runStartedAt: new Date().toISOString(),
      ...plan,
      runHistory: [...(current.runHistory ?? []), {
        runSequence: current.runSequence, startedAt: current.runStartedAt ?? current.createdAt, endedAt: new Date().toISOString(),
        topicRefs: current.topicRefs, inputVersion: current.inputVersion, title: current.title, objective: current.objective, childSessionId: current.childSessionId,
        acceptanceCriteria: current.acceptanceCriteria, stageTasks: current.stageTasks, taskPromptRefs: current.taskPromptRefs ?? [], checkpoints: current.checkpoints ?? [], ...(current.result ? { result: current.result } : {}),
      }],
      lastCompletedResult: current.result, completion: undefined, result: undefined, waitingKind: undefined, waitingReason: undefined,
      lastWaitingResult: undefined, checkpoints: [], stagePlan, taskPromptRefs: [], humanBlocker: undefined, reopenContext: 'Topic 输入已更新，独立核验新执行轮次并重新选择适用任务流程', archivedAt: undefined,
      completionSequence: (current.completionSequence ?? 0) + 1,
    }))
    await pumpTasks()
    return store.getTask(queued.taskId)
  }
  async function appendTaskContextInternal(task, context, topicRefs, title, objective, acceptanceCriteria, stageTasks, progressImpact, operation, impactEvidence) {
    if (cancellingTasks.has(task.taskId)) throw new Error(`task_cancel_pending:${task.taskId}`)
    if (operation && task.appliedOperations.includes(operation.operationId)) { if (['running', 'waiting'].includes(task.state)) await dispatchTaskInput(task); return task }
    if (task.state === 'completed') throw new Error(`task_not_active:${task.taskId}`)
    const previousPlan = JSON.stringify([task.objective, task.acceptanceCriteria, task.stageTasks])
    task = await mutateTask(task, operation, (current) => {
      const revised = withRevisedObjective(current, objective, title, operation?.decisionId)
      const resumed = current.state === 'waiting' && current.waitingKind === 'information'
      const refs = [...new Map([...current.topicRefs, ...topicRefs].map((ref) => [ref.topicId, ref])).values()]
      const plan = normalizeRunPlan(revised.objective, acceptanceCriteria ?? revised.acceptanceCriteria, stageTasks ?? revised.stageTasks)
      const progress = reviseTaskProgress(current, { objective: revised.objective, ...plan, progressImpact, impactEvidence }, new Set(refs.flatMap(ref => resolveTopicMessages(store.getGroup(task.groupId), ref.topicId, ref.revision)).map(message => message.messageId)))
      return { ...revised, topicRefs: refs, inputVersion: current.inputVersion + 1,
        checkpoints: progress.checkpoints, stagePlan: progress.stagePlan, taskPromptRefs: current.taskPromptRefs,
        executionEvents: [...(current.executionEvents ?? []), { kind: 'input-revised', previousInputVersion: current.inputVersion, inputVersion: current.inputVersion + 1, runSequence: current.runSequence,
          progressImpact: progress.progressImpact, reason: progress.reason, affectedStageIds: progress.affectedStageIds,
          retainedCheckpointIds: progress.checkpoints.map(checkpoint => checkpoint.checkpointId), checkpoints: progress.invalidatedCheckpoints, at: new Date().toISOString() }],
        ...plan,
        ...(resumed ? { state: 'queued', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined,
          resumeContext: '[TASK_CONTEXT_RESUME]\nInformation required by the task is now available.' } : {}),
      }
    })
    if (['running', 'waiting'].includes(task.state)) {
      const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
      if (task.state === 'running') {
        if (JSON.stringify([task.objective, task.acceptanceCriteria, task.stageTasks]) !== previousPlan) replaceTaskGoalObjective(task, handle)
        else resumeGoalAfterResolution(handle, ctx.goals.get(handle.agent))
      }
      await dispatchTaskInput(task)
    } else if (task.state === 'queued') await pumpTasks()
    reports.recover(store.getTask(task.taskId))
    return task
  }
  async function applyTopicAction(groupId, action, receipt, record) {
    const operation = { ...receipt, inputVersion: action.inputVersion, runSequence: action.runSequence, decisionId: record.decisionId }
    if (action.kind === 'task-proposal') return
    if (action.kind === 'new-task') {
      const basis = action.topicRefs.flatMap((ref) => resolveTopicMessages(store.getGroup(groupId), ref.topicId, ref.revision)).findLast((message) => record.decision.basisMessageIds.includes(message.messageId) && message.sourceKind !== 'web' && message.sourceKind !== 'internal')
      const created = await store.createTask({ ...action, groupId, taskId: receipt.taskId, operationId: receipt.operationId, ...(basis?.senderName ? { requesterName: basis.senderName } : {}), ...(basis?.senderOpenDingTalkId ? { requesterOpenDingTalkId: basis.senderOpenDingTalkId } : {}) })
      await pumpTasks()
      return store.getTask(created.task.taskId)
    }
    const task = store.getTask(action.taskId)
    if (!task || task.groupId !== groupId) throw new Error('task_topic_wrong_group')
    if (action.kind === 'task-cancel') return cancelTaskInternal(task.taskId, action.reason, action.topicRefs, operation)
    if (action.kind === 'task-reopen') return reopenCompletedTaskInternal(task, action.context, action.topicRefs, action.title, action.objective, action.acceptanceCriteria, action.stageTasks, operation)
    return appendTaskContextInternal(task, action.context, action.topicRefs, action.title, action.objective, action.acceptanceCriteria, action.stageTasks, action.progressImpact, operation, action.impactEvidence)
  }
  async function submitWebTaskAction(kind, request) {
    if (runtimeClosing) throw new Error('resident_runtime_closed')
    const { requestId, context, taskId, title, objective, acceptanceCriteria, stageTasks, progressImpact, impactEvidence } = request
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('task_request_id_required')
    if (typeof context !== 'string' || !context.trim()) throw new Error('task_context_required')
    const existingTask = taskId ? store.getTask(taskId) : undefined
    if (taskId && !existingTask) throw new Error(`task_not_found:${taskId}`)
    const groupId = request.groupId ?? existingTask?.groupId
    if (!groupId || !store.getGroup(groupId)) throw new Error(`group_not_subscribed:${groupId}`)
    if (existingTask && existingTask.groupId !== groupId) throw new Error('task_wrong_group')
    const task = existingTask
    if (task && (!Array.isArray(request.topicRefs) || !request.topicRefs.length)) throw new Error('task_topic_refs_required')
    const topicRefs = request.topicRefs ?? []
    const action = { kind, ...(task ? { taskId, inputVersion: request.inputVersion, runSequence: request.runSequence, ...(kind === 'task-cancel' ? { reason: context.trim() } : { context: context.trim() }) } : { title, objective, acceptanceCriteria }),
      ...(task && title !== undefined ? { title } : {}), ...(objective !== undefined ? { objective } : {}), ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}), ...(stageTasks !== undefined ? { stageTasks } : {}),
      ...(kind === 'task-context' && progressImpact !== undefined ? { progressImpact } : {}), ...(kind === 'task-context' && impactEvidence !== undefined ? { impactEvidence } : {}),
      topicRefs: topicRefs.length ? topicRefs : [{ topicId: 'web-input', revision: 1 }] }
    groupDecisionSchema.parse({ basisMessageIds: ['web-input'], actions: [action], reply: '' })
    const text = JSON.stringify({ kind, context: context.trim(), ...(taskId ? { taskId } : {}), ...(title ? { title } : {}), ...(objective ? { objective } : {}), ...(acceptanceCriteria ? { acceptanceCriteria } : {}), ...(stageTasks ? { stageTasks } : {}) })
    const release = topics.pause(groupId)
    try {
      const accepted = await store.submitWebTaskInput({ groupId, requestId, text, action, topicRefs })
      if (!['accepted', 'duplicate'].includes(accepted.status)) throw new Error(`task_web_${accepted.status}`)
      const decisionId = accepted.record.decisionId
      await topics.applyAccepted(groupId, accepted.topicId, decisionId)
      const record = store.getTopic(groupId, accepted.topicId).decisions.find((item) => item.decisionId === decisionId)
      if (record.status === 'rejected') throw new Error(`task_web_decision_rejected:${record.error}`)
      if (record.status !== 'completed') return { status: 'accepted', decisionId, topicId: accepted.topicId }
      return store.getTask(record.operations[0].taskId)
    } finally { release() }
  }
  async function followupTaskInternal(task, text, identity) {
    if (cancellingTasks.has(task.taskId)) throw new Error(`task_cancel_pending:${task.taskId}`)
    const handle = leafHandles.get(task.taskId) ?? await resumeLeaf(task)
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'coordinator' } })
    const id = identity ? stableId('message', identity) : message.id
    const exists = [...(handle.agent.inbox?.nextStep ?? []), ...(handle.agent.inbox?.nextTurn ?? [])].some(item => item.id === id) || handle.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.id === id)
    if (!exists) handle.agent.steer(Object.freeze({ ...message, id }))
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    if (sessions?.flush) await sessions.flush(handle.agent.session)
    return { task, accepted: true }
  }
  const disposeObserver = typeof ctx.on === 'function' ? ctx.on('session/event', (session, event) => {
    const taskId = leafTaskBySession.get(String(session.id))
    if (taskId === undefined || !PROJECTED_EVENTS.has(event.type) || typeof store.recordActivity !== 'function') return
    const occurredAt = typeof event.time === 'number' ? new Date(event.time).toISOString() : typeof event.time === 'string' ? event.time : undefined
    activityTail = activityTail.then(() => store.recordActivity({ taskId, sessionId: String(session.id), eventKey: `${String(session.id)}:${event.seq}`, seq: event.seq, type: event.type, detail: activityDetail(event), occurredAt })).catch(error => recoveryIssues.push({ taskId, kind: 'activity-projection', error: error.message }))
  }) : undefined
  const statusQueryTails = new Map()
  const statusQueryAttempts = new Set()
  const llm = ctx.get?.('llm') ?? ctx.llm
  const statusQueries = llm?.stream ? createStatusQueryHandler({
    llm,
    modelConfig: ({ groupId }) => {
      const config = residentHandles.get(groupId)?.agent.session.requestHeader?.()?.config ?? agentOptions
      const { reasoningEffort: _oldEffort, ...base } = config
      return { ...base, ...selection }
    },
    recordEvent: async event => {
      const agent = residentHandles.get(event.groupId)?.agent
      if (!agent) return
      agent.session.append(event.type, event)
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      if (sessions?.flush) await sessions.flush(agent.session)
    },
    commit: ({ request, decision }) => topics.submitReadOnlyDecision(request.groupId, {
      requestId: request.requestId, topicId: request.topicId, revision: request.revision, decision,
    }, request.candidateFingerprint, () => {
      const group = store.getGroup(request.groupId)
      if (!group || request.policyFingerprint !== fingerprint({ responsibility: group.responsibility, agentNames: store.getAgentNames() })) return false
      const currentTasks = store.listTasks().filter(task => task.groupId === request.groupId && task.topicRefs.some(ref => ref.topicId === request.topicId))
      return currentTasks.length === request.taskSnapshots.length && request.taskSnapshots.every(snapshot => {
        const current = currentTasks.find(task => task.taskId === snapshot.taskId)
        return current && queryFactsSnapshot(current).revision === snapshot.revision
      })
    }),
  }) : undefined
  function tryStatusQuery({ groupId, requestId }) {
    const previous = statusQueryTails.get(groupId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      if (runtimeClosing) return false
      const context = topics.getReadOnlyDecisionContext(groupId, requestId)
      if (context.hasOmittedMessages || context.messages.some(message => message.imageRefs?.length || message.quotedMessageId || message.quotedMessage)) return false
      const tasks = store.listTasks().filter(task => task.groupId === groupId && task.topicRefs.some(ref => ref.topicId === context.topicId))
      if (!tasks.length || tasks.length > 3) return false
      const messages = context.messages.filter(message => context.deltaMessageIds.includes(message.messageId))
      if (!messages.length || messages.some(message => ['web', 'internal'].includes(message.sourceKind))) return false
      if (statusQueryAttempts.has(requestId)) return false
      statusQueryAttempts.add(requestId)
      if (statusQueryAttempts.size > 500) statusQueryAttempts.delete(statusQueryAttempts.values().next().value)
      const group = store.getGroup(groupId)
      const result = await statusQueries.handle({ ...context,
        policyFingerprint: fingerprint({ responsibility: group.responsibility, agentNames: store.getAgentNames() }),
        sourceMessages: messages, sourceMessageIds: messages.map(message => message.messageId),
        taskSnapshots: tasks.map(queryFactsSnapshot),
        replyCandidates: context.candidates,
        compactPolicy: { responsibility: group.responsibility, agentNames: store.getAgentNames(), summary: context.summary,
          rule: '只回应本群职责范围内明确交给助理的状态问答，或同一事项后续追问。无法确认准入时交还常驻判断。不得从状态质疑推断执行或重新规划授权。' },
      })
      return result.kind === 'reply'
    })
    statusQueryTails.set(groupId, run)
    run.finally(() => { if (statusQueryTails.get(groupId) === run) statusQueryTails.delete(groupId) }).catch(() => undefined)
    return run
  }
  const topics = createTopicCoordinator({
    store, getAgent: (groupId) => residentHandles.get(groupId)?.agent, assertSession: assertResidentToolSession, serializeTasks,
    applyAction: applyTopicAction, appendOutbox: appendReliableOutbox, reviewCandidates: replyReviewCandidatesFor, validateReplyReview,
    cancelTask: signalTaskCancellation, isClosing: () => runtimeClosing, retryDelayMs: decisionRetryBaseMs,
    ...(statusQueries ? { onDecisionRequest: tryStatusQuery } : {}),
    onInputSettled: groupId => { for (const task of store.listTasks().filter(task => task.groupId === groupId)) reports.recover(task) },
    onError: (groupId, error) => recoveryIssues.push({ groupId, kind: 'topic-processing', error: error.message ?? String(error) }),
  })
  const reports = createTaskReportQueue({
    store, serialize: serializeTasks, hasPendingInput: task => topics.hasPendingTaskInput(task), isClosing: () => runtimeClosing,
    execute: async (taskId, type, value, context) => {
      if (type === 'checkpoint') return submitTaskCheckpointInternal(taskId, value)
      const task = await submitTaskResult(taskId, value, context)
      return { accepted: true, taskId, state: task.state }
    },
    suspend: async task => {
      const handle = leafHandles.get(task.taskId)
      if (!handle) return
      const goal = ctx.goals.get(handle.agent)
      if (goal?.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: 'task-coordination-pending', message: '报告已保存，等待输入接纳或审阅结果。' })
    },
    notify: async (task, report) => {
      if (task.state !== 'running') return
      const handle = leafHandles.get(task.taskId)
      if (!handle) throw new Error('task_report_leaf_unavailable')
      const identity = report.receipt?.code === 'task_checkpoint_rejected' ? `checkpoint-rejected:${report.receipt.checkpointId}`
        : report.error?.startsWith('task_result_objective_not_covered:') ? `result-rejected:${task.taskId}:${fingerprint(report.value)}`
          : `task-report:${task.taskId}:${report.submissionId}:${report.status}`
      const id = stableId('message', identity)
      const exists = [...(handle.agent.inbox?.nextStep ?? []), ...(handle.agent.inbox?.nextTurn ?? [])].some(message => message.id === id)
        || handle.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === id)
      if (!exists) handle.agent.steer({ ...createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: `[TASK_REPORT_REVIEWED]\n${JSON.stringify({ submissionId: report.submissionId, status: report.status, result: report.receipt, error: report.error })}\n只依据本次结果继续；已接收不代表业务完成。不要重复提交同一报告。` }] }), id })
      const sessions = ctx.get?.('sessions') ?? ctx.sessions
      if (sessions?.flush) await sessions.flush(handle.agent.session)
      if (report.status !== 'failed') resumeGoalAfterResolution(handle, ctx.goals.get(handle.agent))
    },
    onError: error => recoveryIssues.push({ kind: 'task-report-processing', error: error.message }),
  })
  for (const group of store.listGroups()) {
    try {
      await store.reconcileMessageDeliveries({ groupId: group.groupId })
      await resumeResident(group)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      recoveryIssues.push({ groupId: group.groupId, residentSessionId: group.residentSessionId, error: detail })
    }
  }
  for (const task of store.listTasks().filter((item) => item.state === 'running' || item.state === 'waiting')) {
    if (!residentHandles.has(task.groupId)) continue
    try {
      const plan = reconcileLegacyStagePlan(task)
      const current = plan ? await store.updateTask(task.taskId, value => ({ ...value, stageTasks: plan.stageTasks, stagePlan: plan.stagePlan,
        executionEvents: [...(value.executionEvents ?? []), { kind: 'stage-plan-reconciled', planCheckpointId: plan.planCheckpointId, previousStageTasks: value.stageTasks, at: new Date().toISOString() }],
      })) : task
      await resumeLeaf(current); await dispatchTaskInput(current); reports.recover(current)
    } catch (error) { recoveryIssues.push({ groupId: task.groupId, taskId: task.taskId, childSessionId: task.childSessionId, error: error instanceof Error ? error.message : String(error) }) }
  }
  await serializeTasks(pumpTasks)
  function recoverDecisionMessages() {
    if (runtimeClosing) return Promise.resolve([])
    return topics.recover()
  }
  if (supervisorIntervalMs > 0) {
    supervisorTimer = setInterval(() => {
      inspectRunningTasks().catch(() => undefined)
      recoverDecisionMessages().catch(() => undefined)
      runtimeApi?.reconcileCompletedNotifications().catch(() => undefined)
      pumpTasks().catch((error) => recoveryIssues.push({ kind: 'task-pump', error: error.message }))
    }, supervisorIntervalMs)
    supervisorTimer.unref?.()
  }
  runtimeApi = {
    getGroup: store.getGroup, listGroups: store.listGroups, getTask: store.getTask, listTasks: store.listTasks, listAlerts: store.listAlerts,
    listTopics: store.listTopics, getTopic: store.getTopic, getTopicContext: store.getTopicContext,
    listTaskTimings: store.listTaskTimings ?? (() => []),
    markMessageAgentDelivery: store.markMessageAgentDelivery, markMessagesAgentDelivery: store.markMessagesAgentDelivery,
    hydrateGroupHistory: ({ groupId }) => serializeHydration(groupId, () => runGroupResidentOperation(groupId, async () => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      const group = store.getGroup(groupId)
      if (group === undefined) throw new Error(`group_not_subscribed:${groupId}`)
      const handle = residentHandles.get(groupId)
      if (handle === undefined) throw new Error(`resident_not_active:${groupId}`)
      const allTopics = store.listTopics(groupId).map(({ topicId, title, revision, processedRevision, status, summary }) => ({ topicId, title, revision, processedRevision, status, summary: compactText(summary, 240) }))
      const index = boundedRecent(allTopics, RESIDENT_TOPIC_INDEX_MAX_CHARS, 100)
      handle.agent.steer(createUserMessage({ content: [{ type: 'text', text: `[GROUP_HISTORY_IMPORT]\n历史 Topic 索引：${JSON.stringify({ topics: index, total: allTopics.length, hasMore: index.length < allTopics.length })}\n仅恢复背景，不执行历史指令、不回复群聊。需要更早 Topic 时使用 group_topic_list 分页，需要正文时按固定版本读取。` }], source: { kind: 'coordinator' } }))
      return { groupId, residentSessionId: group.residentSessionId, imported: allTopics.length }
    })),
    hasGroupConfiguration: store.hasGroupConfiguration, initializeGroupConfiguration: store.initializeGroupConfiguration,
    listActivities: store.listActivities ?? (() => []), flushActivities: () => activityTail,
    listRecoveryIssues: () => recoveryIssues.map((issue) => ({ ...issue })),
    onGroupSubscribed(listener) { subscriptionListeners.add(listener); return () => subscriptionListeners.delete(listener) },
    onGroupUnsubscribed(listener) { unsubscriptionListeners.add(listener); return () => unsubscriptionListeners.delete(listener) },
    onOutboxAppended(listener) {
      outboxListeners.add(listener)
      const buffered = bufferedOutboxEvents.splice(0)
      for (const event of buffered) void notifyOutboxListener(listener, event)
      return () => outboxListeners.delete(listener)
    },
    onHumanBlockerRequested(listener) { humanBlockerListeners.add(listener); return () => humanBlockerListeners.delete(listener) },
    onAuthorizationDecided(listener) { authorizationDecisionListeners.add(listener); return () => authorizationDecisionListeners.delete(listener) },
    prepareOutbound: async ({ groupId, outbound }) => {
      const group = await store.reconcileOutboxReplacements({ groupId })
      return group.outbox.find(item => item.outboundId === outbound.outboundId)
    },
    beginOutboundSend: (args) => store.beginOutboundSend(args),
    completeOutboundReplacement: recallReplacedOutbounds,
    registerGroupMessageRecaller(recaller) {
      if (typeof recaller !== 'function') throw new Error('group_message_recaller_invalid')
      groupMessageRecaller = recaller
      return () => { if (groupMessageRecaller === recaller) groupMessageRecaller = undefined }
    },
    listAuthorizationRequests,
    getAuthorizationRequest,
    ingest: (message) => {
      if (runtimeClosing) return Promise.reject(new Error('resident_runtime_closed'))
      const key = Symbol(`${message.groupId}:${message.messageId}`)
      const operation = (async () => {
        const images = Array.isArray(message.images) ? message.images : []
        if (images.length && !attachments) throw new Error('dsh_attachments_required')
        const imageRefs = images.length ? await attachments.saveImages(images.map(({ data, mediaType, name }) => ({ data, mediaType, ...(name ? { name } : {}) }))) : message.imageRefs
        const result = await store.ingest({ ...message, ...(imageRefs ? { imageRefs } : {}) })
        void topics.schedule(message.groupId)
        const stored = store.getGroup(message.groupId).messages.find((item) => item.messageId === message.messageId)
        return { ...result, accepted: true, processing: stored.routingStatus === 'routed' ? 'routed' : 'pending' }
      })().finally(() => inflightMessages.delete(key))
      inflightMessages.set(key, operation)
      return operation
    },
    retryDecisionFailedMessage: ({ groupId, messageId }) => {
      const group = store.getGroup(groupId)
      if (!group?.messages.some((message) => message.messageId === messageId)) throw new Error(`message_not_found:${messageId}`)
      return topics.retryMessage(groupId, messageId)
    },
    recoverInterruptedDecisions: () => topics.recover(),
    drainTopicOperations: (groupId) => topics.drain(groupId),
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
          else { accepted += 1; await store.routeMessages({ groupId, routeId: `history:${message.messageId}`, routingRevision: store.getGroup(groupId).routingRevision, routes: [{ messageId: message.messageId, messageVersion: 1, topics: [], reason: '历史背景导入，不执行旧请求' }] }); await store.markMessageAgentDelivery({ groupId, messageId: message.messageId, status: 'skipped' }) }
        }
        return { accepted, duplicates, enriched, total: messages.length, group: store.getGroup(groupId) }
      })
    },
    acknowledge: store.acknowledge, recordOutboundDeliveryAttempt: store.recordOutboundDeliveryAttempt, reportCarrierIssue: store.recordAlert,
    resolveGroupCarrierIssues: async ({ groupId }) => {
      const tasks = store.listTasks().filter((task) => task.groupId === groupId)
      for (const task of tasks) await store.resolveAlerts?.({ taskId: task.taskId, fingerprintPrefix: 'dws-consumer-' })
    },
    inspectRunningTasks,
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
      const answered = { ...task.humanBlocker, status: 'answered', reply, decision }
      const running = await store.updateTask(taskId, (current) => ({ ...current, state: 'running', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, humanBlocker: answered, humanBlockerHistory: withHumanBlockerHistory(current, answered) }))
      await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${requestId}\nDecision: ${decision}\nReply: ${reply}\n\nContinue the same task only within the approved scope. Re-check current state before acting.`)
      return running
    }),
    createTask: (request) => submitWebTaskAction('new-task', request),
    appendTaskContext: (request) => submitWebTaskAction('task-context', request),
    reopenTask: (request) => submitWebTaskAction('task-reopen', request),
    reconcileCompletedNotifications: async () => {
      const pending = await serializeTasks(async () => {
        const items = []
        for (const task of store.listTasks().filter((item) => (item.state === 'completed' && item.result?.status === 'completed') || (item.state === 'waiting' && item.result?.waitingKind === 'information'))) {
          let current = task
          if ((current.completionSequence ?? 0) === 0 && current.lastCompletedResult?.status === 'completed') current = await store.updateTask(current.taskId, (item) => ({ ...item, completionSequence: 1 }))
          const resultKey = taskResultOutboxKey(current, current.result)
          const group = store.getGroup(current.groupId)
          if (group !== undefined && !group.outbox.some((item) => item.sourceMessageId === resultKey)) items.push({ task: current, resultKey })
        }
        return items
      })
      const repaired = [], failures = []
      await Promise.all(pending.map(async (item) => {
        try {
          await coordinateTaskResult(item.task, item.task.result)
          repaired.push({ taskId: item.task.taskId, sourceMessageId: item.resultKey })
        } catch (error) {
          failures.push(error)
          recoveryIssues.push({
            groupId: item.task.groupId, taskId: item.task.taskId, sourceMessageId: item.resultKey, kind: 'task-notification-reconcile',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }))
      if (failures.length > 0) throw new AggregateError(failures, `task_notification_reconcile_failed:${failures.map((error) => error instanceof Error ? error.message : String(error)).join('|')}`)
      return repaired
    },
    archiveTask: ({ taskId }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      if (task.state !== 'completed') throw new Error(`task_not_completed:${taskId}`)
      if (task.archivedAt) return task
      return store.updateTask(taskId, (current) => ({ ...current, archivedAt: new Date().toISOString() }))
    }),
    cancelTask: ({ reason, ...request }) => submitWebTaskAction('task-cancel', { ...request, context: reason }),
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
    resumeTask: async ({ taskId }) => {
      const queued = await serializeTasks(async () => {
        const task = store.getTask(taskId)
        if (task?.state !== 'waiting') throw new Error(`task_not_waiting:${taskId}`)
        return store.updateTask(taskId, (current) => ({ ...current, state: 'queued', waitingKind: undefined, waitingReason: undefined, lastWaitingResult: current.result, result: undefined, resumeContext: '[TASK_CONTEXT_RESUME]\nResume requested by the host.' }))
      })
      await pumpTasks()
      return store.getTask(queued.taskId)
    },
    followupTask: ({ text, ...request }) => submitWebTaskAction('task-context', { ...request, context: text }),
    submitTaskResult: ({ taskId, result }) => submitTaskResult(taskId, result),
    getTaskReport: ({ taskId, submissionId }) => reports.get(taskId, submissionId),
    retryTaskReport: async ({ taskId, submissionId, coordinationRequestId }) => {
      const task = store.getTask(taskId)
      const report = task && taskReports(task).find(item => item.submissionId === submissionId)
      if (!report) throw new Error(`task_report_not_found:${submissionId}`)
      if (report.inputVersion !== task.inputVersion || report.runSequence !== task.runSequence || task.state === 'completed') throw new Error(`task_report_retry_stale:${submissionId}`)
      const failedRequestId = report.error?.startsWith('topic_request_retry_exhausted:') ? report.error.slice('topic_request_retry_exhausted:'.length) : coordinationRequestId
      if (failedRequestId) await topics.resetReviewRequest(task.groupId, failedRequestId)
      return reports.retry(taskId, submissionId, { coordinationRequestId: failedRequestId })
    },
    retryCoordinationRequest: ({ groupId, requestId }) => {
      for (const task of store.listTasks().filter(item => item.groupId === groupId)) {
        const failed = task.executionEvents?.findLast(event => event.kind === 'task-report-settled' && event.status === 'failed' && event.error === `topic_request_retry_exhausted:${requestId}`)
        const report = failed && taskReports(task).find(item => item.submissionId === failed.submissionId)
        if (report) return runtimeApi.retryTaskReport({ taskId: task.taskId, submissionId: report.submissionId, coordinationRequestId: requestId })
      }
      return topics.retryRequest(groupId, requestId)
    },
    subscribe: ({ groupId, name, responsibility = '' }) => serializeConfig(() => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      return serialize(groupId, async () => {
        const existing = store.getGroup(groupId); if (existing !== undefined) return { created: false, group: existing }
        const sessionId = residentSessionId(groupId), { handle } = await createResident(groupId, { sessionId: SessionId(sessionId), meta: { cwd: agentWorkspace, agentPreset }, agentOptions, setup: residentSetup(groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
        applyPermission(handle, 'read-only')
        try {
          if (runtimeClosing) throw new Error('resident_runtime_closed')
          const result = await store.subscribe({ groupId, name, responsibility, residentSessionId: sessionId, residentAgentPreset: agentPreset }); residentHandles.set(groupId, handle)
          for (const listener of subscriptionListeners) listener(result.group)
          return result
        } catch (error) { await handle.dispose(); throw error }
      })
    }),
    updateGroup: (request) => serialize(request.groupId, () => store.updateGroup(request)),
    getAgentConfig: () => ({
      agentNames: store.getAgentNames?.() ?? [], workspaceDir: agentWorkspace, provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, proxyUrl: store.getProxyUrl?.() ?? '',
      leafSessionPrompt: store.getLeafSessionPrompt?.() ?? '', taskPrompts: store.getTaskPrompts?.() ?? [], taskPromptsVersion: store.getTaskPromptsVersion?.() ?? 0, maxConcurrentTasks: taskConcurrencyLimit,
    }),
    updateAgentConfig: ({ agentNames, workspaceDir, model, reasoningEffort, proxyUrl, leafSessionPrompt, taskPrompts, taskPromptsVersion, maxConcurrentTasks: nextMaxConcurrentTasksInput }) => serializeConfig(async () => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
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
      const nextLeafSessionPrompt = leafSessionPrompt === undefined ? (store.getLeafSessionPrompt?.() ?? '') : leafSessionPrompt.trim()
      const guidanceChanged = nextLeafSessionPrompt !== (store.getLeafSessionPrompt?.() ?? '')
      const taskPromptsChanged = taskPrompts !== undefined && JSON.stringify(taskPrompts) !== JSON.stringify(store.getTaskPrompts?.() ?? [])
      const nextMaxConcurrentTasks = nextMaxConcurrentTasksInput === undefined ? taskConcurrencyLimit : nextMaxConcurrentTasksInput
      if (!Number.isInteger(nextMaxConcurrentTasks) || nextMaxConcurrentTasks < 1 || nextMaxConcurrentTasks > 50) throw new Error('agent_max_concurrent_tasks_invalid')
      const concurrencyChanged = nextMaxConcurrentTasks !== taskConcurrencyLimit
      const resultConfig = () => ({ agentNames: store.getAgentNames?.() ?? [], workspaceDir: agentWorkspace, ...selection, proxyUrl: nextProxyUrl, leafSessionPrompt: store.getLeafSessionPrompt?.() ?? '', taskPrompts: store.getTaskPrompts?.() ?? [], taskPromptsVersion: store.getTaskPromptsVersion?.() ?? 0, maxConcurrentTasks: taskConcurrencyLimit })
      if (!workspaceChanged && !selectionChanged && !proxyChanged && !guidanceChanged && !taskPromptsChanged && !namesChanged && !concurrencyChanged) return resultConfig()
      if (workspaceChanged || selectionChanged) await serializeTasks(() => {
        if (store.listTasks().some((task) => task.state === 'running' || task.state === 'waiting' || task.state === 'queued')) throw new Error('agent_config_has_active_tasks')
      })
      const groups = workspaceChanged ? store.listGroups() : []
      const releaseResidentTransitions = groups.map((group) => holdGroupResidentTransition(group.groupId))
      const replacements = []
      try {
        if (workspaceChanged) {
          for (const group of groups) {
            await waitForActiveGroupResidentOperations(group.groupId)
            const previous = residentHandles.get(group.groupId)
            if (previous === undefined) throw new Error(`resident_not_active:${group.groupId}`)
            await previous.agent.whenIdle()
            await waitForActiveGroupSubmissions(group.groupId)
            const seed = previous.agent.session.snapshotEvents()
            const sessionId = `${residentSessionId(group.groupId)}-${randomUUID().slice(0, 8)}`
            const { handle } = await createResident(group.groupId, { sessionId: SessionId(sessionId), seed, inheritedEventCount: seed.length, meta: { cwd: nextWorkspace, parentSession: previous.agent.session.id, isSeeded: true, agentPreset }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
            applyPermission(handle, 'read-only')
            replacements.push({ group, previous, handle, sessionId })
          }
        }
        const result = await serializeTasks(async () => {
          if ((workspaceChanged || selectionChanged) && store.listTasks().some((task) => task.state === 'running' || task.state === 'waiting' || task.state === 'queued')) throw new Error('agent_config_has_active_tasks')
          if (selectionChanged) await ctx.agentDefaultModel.saveSelection(nextSelection)
          if (proxyChanged) await store.setProxyUrl(nextProxyUrl)
          if (namesChanged) await store.setAgentNames(nextAgentNames)
          if (guidanceChanged) await store.setLeafSessionPrompt(nextLeafSessionPrompt)
          if (taskPromptsChanged) {
            await store.setTaskPrompts(taskPrompts, taskPromptsVersion)
            for (const task of store.listTasks().filter((item) => ['running', 'waiting'].includes(item.state))) {
              try { assertCurrentTaskPrompts(task, store.getTaskPrompts()); continue } catch { /* 仅使引用已变化流程的审阅失效。 */ }
              const pending = task.checkpoints?.at(-1)
              if (pending && !pending.coordinatorDecision && isDiagnosticCheckpoint(pending)) continue
              if (pending && !pending.coordinatorDecision) {
                await store.updateTask(task.taskId, (current) => ({ ...current, checkpoints: current.checkpoints.filter((item) => item.checkpointId !== pending.checkpointId),
                  executionEvents: [...(current.executionEvents ?? []), { kind: 'checkpoint-review-invalidated', checkpoint: pending, at: new Date().toISOString() }] }))
              }
              topics.invalidateTaskReviews(task.taskId, 'task_prompt_selection_stale')
            }
          }
          if (concurrencyChanged) await store.setMaxConcurrentTasks(nextMaxConcurrentTasks)
          if (workspaceChanged) {
            await store.setAgentWorkspaceDir(nextWorkspace)
            for (const item of replacements) await store.updateGroup({ groupId: item.group.groupId, residentSessionId: item.sessionId })
          }
          if (selectionChanged) {
            selection.provider = nextSelection.provider; selection.model = nextSelection.model
            if (nextSelection.reasoningEffort === undefined) delete selection.reasoningEffort
            else selection.reasoningEffort = nextSelection.reasoningEffort
          }
          if (concurrencyChanged) taskConcurrencyLimit = nextMaxConcurrentTasks
          if (workspaceChanged) {
            agentWorkspace = nextWorkspace
            for (const item of replacements) residentHandles.set(item.group.groupId, item.handle)
          }
          if (concurrencyChanged) await pumpTasks()
          return resultConfig()
        })
        for (const item of replacements) await item.previous.dispose()
        if (guidanceChanged || taskPromptsChanged) {
          const currentPrompts = new Map((store.getTaskPrompts?.() ?? []).filter((item) => item.enabled).map((item) => [item.id, item]))
          for (const task of store.listTasks().filter((item) => item.state === 'running')) {
            const promptSelectionAffected = (task.taskPromptRefs ?? []).some((ref) => currentPrompts.get(ref.id)?.revision !== ref.revision)
            if (!guidanceChanged && !promptSelectionAffected) continue
            const handle = leafHandles.get(task.taskId)
            if (!handle) continue
            handle.agent.steer(createUserMessage({ content: [{ type: 'text', text: `[TASK_PROMPT_CONFIG_UPDATED]\n${promptSelectionAffected ? '当前任务已选流程发生修订、停用或删除；旧计划已失效。' : '叶子通用提示词已更新。'}下一次请求会注入最新配置；保留已完成证据，重新判断当前流程和剩余计划，必要时重新加载流程并提交新的 plan-confirmed。不得用旧计划推进或完成。` }], source: { kind: 'coordinator' } }))
          }
        }
        return result
      } catch (error) {
        if (!workspaceChanged || agentWorkspace !== nextWorkspace) await Promise.all(replacements.map((item) => item.handle.dispose()))
        throw error
      } finally {
        for (const release of releaseResidentTransitions) release()
      }
    }),
    unsubscribe: ({ groupId }) => serializeConfig(async () => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      if (store.listTasks().some((task) => task.groupId === groupId && (task.state === 'running' || task.state === 'waiting' || task.state === 'queued'))) throw new Error(`group_has_active_tasks:${groupId}`)
      const handle = residentHandles.get(groupId)
      const releaseResidentTransition = holdGroupResidentTransition(groupId)
      try {
        await waitForActiveGroupResidentOperations(groupId)
        if (handle !== undefined) await handle.agent.whenIdle()
        await waitForActiveGroupSubmissions(groupId)
        const result = await serialize(groupId, () => serializeTasks(async () => {
          if (store.listTasks().some((task) => task.groupId === groupId && (task.state === 'running' || task.state === 'waiting' || task.state === 'queued'))) throw new Error(`group_has_active_tasks:${groupId}`)
          const removed = await store.removeGroup({ groupId })
          if (residentHandles.get(groupId) === handle) residentHandles.delete(groupId)
          return removed
        }))
        if (handle !== undefined) await handle.dispose()
        for (const listener of unsubscriptionListeners) listener({ groupId })
        return result
      } finally {
        releaseResidentTransition()
      }
    }),
    setCurrentDwsProfile: (value) => { currentDwsProfile = typeof value === 'string' ? value.trim() : '' },
    async close() {
      if (closePromise !== undefined) return closePromise
      runtimeClosing = true
      if (supervisorTimer !== undefined) clearInterval(supervisorTimer)
      if (typeof disposeObserver === 'function') disposeObserver()
      const topicClosing = topics.close()
      closePromise = serializeConfig(async () => {
        await waitForAllResidentOperations()
        await Promise.allSettled([...inflightMessages.values()])
        await topicClosing
        await reports.drain()
        await pumpTail
        const all = [...leafHandles.values(), ...residentHandles.values()]
        await ctx.subagents.drainContinuableDescendants(all.map((handle) => handle.agent))
        await Promise.all(all.map((handle) => handle.dispose()))
        await Promise.allSettled([...pendingLeafDisposals])
        leafHandles.clear(); residentHandles.clear(); leafTaskBySession.clear(); await activityTail; await store.close()
      })
      return closePromise
    },
  }
  return runtimeApi
}
