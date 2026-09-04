import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { blockTaskDecisionForUnavailableMedia, buildDecisionPrompt, buildLeafSourceEnvelope, buildReplyReviewCandidates, groupDecisionJsonSchema, isDirectedToOtherParticipants, isExplicitAgentDirection, replyReviewJsonSchema, shouldRecheckTaskAssociation, validateGroupDecision } from './decision.js'
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
  const residentHandles = new Map(), leafHandles = new Map(), leafTaskBySession = new Map(), pausedRecoveryCounts = new Map(), resultRecoveryCounts = new Map(), tails = new Map(), hydrationTails = new Map(), inflightMessages = new Map(), pendingGroupDecisions = new Map(), pendingGroupDecisionMonitors = new Map(), pendingGroupReplies = new Map(), activeGroupSubmissions = new Set(), activeGroupReplies = new Set(), activeGroupResidentOperations = new Set(), groupReplyAdmissionBarriers = new Map(), groupResidentTransitionBarriers = new Map(), cancellingTasks = new Set(), pendingLeafDisposals = new Set()
  const agentPresets = ctx.get?.('agentPresets') ?? ctx.agentPresets
  const attachments = ctx.get?.('attachments') ?? ctx.attachments
  const recoveryIssues = [], subscriptionListeners = new Set(), unsubscriptionListeners = new Set(), outboxListeners = new Set(), humanBlockerListeners = new Set(), authorizationDecisionListeners = new Set(), bufferedOutboxEvents = []
  let taskTail = Promise.resolve(), configTail = Promise.resolve(), activityTail = Promise.resolve(), supervisorTimer, currentDwsUserName = '', currentDwsProfile = '', runtimeClosing = false, closePromise
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
  const quotedMessageRecoveryPolicy = (owner) => {
    const profileArgument = currentDwsProfile === '' ? '' : ` --profile '${currentDwsProfile.replaceAll("'", "''")}'`
    return `### 引用消息上下文恢复

群消息信封只提供引用消息 ID，因为正常情况下被引用消息已经进入当前会话上下文。收到引用消息 ID 后，先按 ID 在当前可见上下文和本群任务索引中定位；如果不能准确还原正文，说明可能发生消息传递异常、会话恢复或上下文压缩，必须先加载 \`dingtalk-chat\` Skill，再通过 \`pwsh\` 执行 \`dws chat +messages-mget --msg-ids '<消息ID>'${profileArgument} --format json\` 主动读取。必须检查 \`complete\`、\`failedCount\`、\`failures\`、\`foundCount\` 和 \`notFoundMessageIds\`，不能只看命令退出码。

取回的消息如果仍含 \`quotedMessage.messageId\`，继续按该 ID 查询，直到不存在更上游引用；维护已访问 ID 集合，ID 重复代表异常循环，必须停止而不能无限查询。引用链中的图片、文件或其他资源承载目标、范围、对象或验收信息时，按照 \`dingtalk-chat\` Skill 的资源读取流程取得并阅读。完整引用链仅用于恢复当前消息的语义，不自动创建 Task、扩大 objective 或产生修改/发布授权。

本节是“钉钉中已存在、可按消息 ID 恢复的引用消息”的专用规则，优先于通用外部资源缺失规则。任何引用 ID 尚未查询、查询结果不完整、查询失败、未命中或出现循环时，都不得猜测上下文，也不得向群成员回复“请补原问题、正文或截图”。${owner === 'resident' ? '不得调用 group_decision_submit 提交这类群回复；保留工具错误并结束当前 step，让 Runtime 将消息收敛为可重试的 decision-failed。' : '不得用主会话摘要替代原文；通过 submit_task_result 如实提交 waiting 状态和 DWS 读取证据，不得要求群成员重新提供已经存在于钉钉中的消息。'}`
  }
  function configureResident(agentCtx, groupId) {
    installSelection(agentCtx)
    agentCtx.tools.restrict({ deny: ['get_goal', 'create_goal', 'update_goal'] })
    agentCtx.systemPrompt.section({ name: 'tool:goal', order: 114, text: '' })
    registerResidentDecisionTool(agentCtx, groupId)
    registerResidentReplyTool(agentCtx, groupId)
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
          .map((task) => ({ taskId: task.taskId, ...(task.title ? { title: task.title } : {}), objective: task.objective, state: task.state, archived: Boolean(task.archivedAt), messageHistory: task.messageHistory ?? [] }))
        return `## 本群全部任务关联索引\n\n${active.length === 0 ? '无。' : JSON.stringify(active)}`
      },
    })
    agentCtx.systemPrompt.section({
      name: 'dingtalk-group-decision-protocol', order: 41,
      text: () => `## 群消息决策协议

收到以 \`[GROUP_MESSAGE_STEER]\` 开头的群消息信封或 \`[GROUP_DECISION_RECHECK]\` 复核请求时，必须通过 \`group_decision_submit\` 提交结构化判断，不得用 assistant 文本输出 JSON。每个信封携带一个判断请求 ID；处理完成一个或多个请求后即可调用工具，不需要等待 turn 结束。你可以在一次工具调用中提交多个 submission，也可以让一个 submission 覆盖多个 requestIds。由你结合完整上下文判断消息相关、部分相关或无关：共享一个业务判断的请求放在同一 submission，独立事项分别提交；Runtime 不替你按顺序、关键词或固定窗口分组。每个 pending request ID 必须且只能成功提交一次。

任何 submission 的最终有效 Decision 含非空 reply 时，必须语义审阅生成本批回复前已经进入的全部普通 \`[GROUP_MESSAGE_STEER]\` 请求。submission 中已经提交的普通 requestIds 会自动计入已观察集合；工具顶层 \`observedRequestIds\` 只需列出已审阅但不在任何 submission 中、准备在回复后处理的普通 pending 请求，重复列出已提交 ID 也兼容。影响回复的消息必须与对应请求放进同一 submission，并结合这些消息重新生成完整 Decision；无关且已经处理完成的事项放进独立 submission；已审阅但不影响本批回复的请求只列入 \`observedRequestIds\`，Runtime 会保留它们。若工具返回 stale 结果，说明提交前又有新 Steer 到达；下一 step 必须结合 missingRequestIds 对应的新消息重新判断并提交，不能原样重试旧回复。Runtime 只校验观察覆盖，不替你判断相关性。

\`[GROUP_DECISION_RECHECK]\` 是已有判断的内部复核。它可以单独提交，也可以与确实影响本次复核 Decision 的普通消息请求放进同一 submission；不要为了规避回复重生成而把相关消息机械拆开。

Decision 仅回答使用 \`{"actions":[],"reply":"...","replyReview":{...}}\`，忽略为 \`{"actions":[],"reason":"原因"}\`，涉及任务时使用 \`{"actions":[...],"reply":"最多一条群回复，可为空","replyReview":{...}}\`。Decision 顶层不允许 kind 字段；\`replyReview.kind\` 是回复审阅的嵌套字段。一个 Decision 可以同时对应多个 Task，\`actions\` 中每项可为 task-proposal、new-task、task-context、task-reopen 或 task-cancel；不得为了只返回一个动作而遗漏其他相关 Task。每个任务动作必须通过 \`sourceMessageIds\` 列出本动作实际关联的全部消息 ID：既可引用本次正在处理的消息，也可引用本群会话中此前已收到的历史消息；必须包含形成当前动作的全部相关消息，且至少一条来自本次正在处理的消息。同一消息可关联多个 Task，不同 Task 也可选择不同消息集合，不得遗漏此前相关消息，也不得把无关消息机械塞入每个 Task。群回复统一放在顶层 \`reply\`，不得给每个动作分别回复。

[GROUP_DECISION_RESUME] 表示上一段 Agent 活动结束后仍有已进入 Inbox、但尚未提交的判断请求。它不是新的群消息；必须立即结合当前上下文及同一 step 中保留的全部 [GROUP_MESSAGE_STEER] / [GROUP_DECISION_RECHECK]，通过 group_decision_submit 结算其中列出的 pending 请求。

每次收到新消息时，检查其内容是否与当前 Session 上下文中的近期回复冲突；如有冲突，及时撤回本主会话发送的错误消息并订正。不得撤回真人或其他系统消息。

任何非空群回复都必须先审阅消息信封或 TASK_COORDINATION 提供的“历史主会话回复候选”，并填写 \`replyReview\`：\`reviewedOutboundIds\` 必须完整列出全部候选；\`sameMatterOutboundIds\` 只列出经语义判断确属同一事项的候选；\`replaceOutboundIds\` 只列出本次发送前应撤回的旧回复。判断是否同一事项必须综合当前消息与候选来源消息的真实正文、引用正文、任务目标、动作范围、状态、参与人和时间线；引用消息 ID、关键词或词面相似度都只能帮助定位，不能单独作为结论。同一事项已经有等价确认且没有必须补充的新信息时，当前 reply 必须为空或选择 ignore；需要补全确认时，\`kind\` 使用 confirmation，并把同一事项的旧确认全部列入 sameMatterOutboundIds 和 replaceOutboundIds，由 Runtime 先撤回旧消息再发送合并后的最新确认。结果、阻塞或问题答复使用 substantive，replaceOutboundIds 必须为空；订正旧回复使用 correction，并列出要撤回的同事项旧回复。不得填写候选列表之外的 ID。

\`title\` 是不超过 120 字的简洁任务名，只概括被授权的事项，不得包含消息信封、发送人、完成状态或未经核验的根因。\`objective/context\` 用于主会话选路、动作授权和可观测记录，不得在其中编造或强化根因、完成度、方案优劣或排除性结论；叶子还会收到 Runtime 从原始群消息生成的独立来源证据信封并自行核验。

新建任务必须提供至少一条 \`acceptanceCriteria\`；修订目标时也可更新 \`acceptanceCriteria\` 和 \`stageTasks\`。验收标准只描述当前目标可核验的完成条件，不得按开发、分析、部署等任务类型绑定固定模板，也不得扩大消息授权范围。

当前消息明确指名或提及已配置的 Agent 名称/别名、以 \`cc:\` 开头，或者明确确认了主会话此前提出的“是否需要我处理”询问，并且事项属于本群职责且形成可验证目标时，才允许选择 new-task。未明确指名、但你判断事项应形成任务时，必须选择 task-proposal，并在群里询问“这个事项是否需要我处理？”，暂不创建 Task；收到肯定答复后再结合原消息及其后补充选择 new-task。消息明确 @其他同事且未指向 Agent 时，说明问题正在询问这些同事，必须忽略，既不得创建 task-proposal 或 new-task，也不得主动回答；只有后续明确指向 Agent 且直接引用该消息，才视为可验证的转交。${currentDwsUserName ? `仅提及当前 DWS 登录人“${currentDwsUserName}”不能单独构成 Agent 的建任务、回复或执行授权。` : ''}同事间讨论、事实陈述或未形成可验证目标的内容不得创建任务；与现有任务相关时只做任务关联或补充上下文，并按下方节制原则简短确认。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。

任务目标必须忠实保留消息中的动作范围，不得把“看看、查一下、排查、分析、核对、监控”等诊断或观察请求扩写成“修复、修改、实施、合并、发布、执行”等变更任务。诊断任务的完成条件只能是核验现状、定位根因、给出证据与建议；只有消息明确要求修复、修改、处理问题或实施方案时，new-task 或 task-proposal 的 objective 才能包含变更动作。后续消息可能明确扩大或收窄同一任务的动作范围；此时仍关联原 Task，并在 task-context 或 task-reopen 中填写修订后的累计完整 objective。普通事实补充不得填写 objective。是否明确指名只决定直接处理还是先询问，不构成扩大任务授权。

消息附带的图片属于当前消息正文，必须先阅读图片，再结合固定主会话中的前后消息和“本群全部任务关联索引”判断关联性。queued、running、waiting、completed 以及产品展示中的归档任务都必须参与关联判断；任务状态只决定关联后的动作，不得成为忽略关联的理由。不得仅因文字部分没有指名、图片没有文字摘要或后续消息较短就选择忽略；紧邻图片的补充说明应优先与该图片共同理解。群友对根因、状态或外部因素的未经核验判断，只要与已有任务相关，就是需要核验的新增线索，不得以“尚未核验”为由忽略。已存在任务的新增事实应优先关联已有任务，而不是创建重复任务。对已完成任务的结果提出回滚、撤回、还原、纠正或补做，属于原任务的结果纠正，必须返回 task-reopen 唤起原 Task，不得只做自然语言承诺，也不得创建新 Task；只有与原目标不同的独立可执行目标才创建新任务并保留历史关联。

判断使用已有任务还是新建任务时，必须进行整体语义判断：结合当前消息的前后文、引用关系、连续消息构成的信息组、当时讨论与执行场景，以及候选任务的标题、完整目标、动作范围、状态、消息与参与人时间线和已记录上下文，判断新消息是在补充、修订、纠正或延续原目标，还是提出了不同的独立目标。不得根据某几个关键词、词面重合、标题相似或单一字段直接决定复用已有任务或新建任务；关键词只能作为查找候选任务的线索，不能代替关联结论。无法从现有上下文可靠区分时，不得猜测创建重复任务，应先结合近期消息继续核对，确有阻塞再向真正掌握必要信息的相关参与人询问。

图片、文档、文件、链接或其他外部资源如果承载任务目标、范围、对象、输入数据或验收要求，必须先通过当前可用工具完整读取。任何任务所需资源无法访问、下载、解析或读取不完整时，必须选择 answer，明确告诉对方未获取到的具体信息以及需要重新提供的内容；此时不得选择 new-task、task-context 或 task-reopen，也不得先创建或推进 Task。只有确认缺失资源与任务无关，或对方补齐必要信息后，才继续任务关联与准入判断。不得假设资源内容、不得用文件名、链接标题、缩略图或消息中的零散文字替代未读取的正文。

${quotedMessageRecoveryPolicy('resident')}

明确拥有任务授权的群成员说“不要处理、不用做、停止、取消、忽略刚才”等，且结合上下文可以唯一关联到本群 queued、running 或 waiting Task 时，必须返回 task-cancel，reason 忠实保留撤销含义；不得把撤销消息作为 task-context 继续发送给叶子。task-cancel 是撤销执行授权并终止整个 Task，只能用于明确停止原任务，不能从模糊讨论、普通目标收窄或暂缓某一步推断。无法唯一确认目标 Task 时先核对上下文，不得批量取消。

状态边界必须严格遵守：除上述明确撤销使用 task-cancel 外，running 或 waiting（包括阻塞中）的 Task 收到新增信息时只能返回 task-context，继续同一执行轮次；不得返回 task-reopen，不得清空 blocker 或增加轮次。只有 completed Task（包括已归档展示）才允许 task-reopen 并初始化下一执行轮次。

同事或其 AI 助理发送的回复、任务回执和状态通知都是正常群消息，必须进入本协议由你结合引用消息、上下文和任务索引判断，不得按固定文案或发送者在模型外预先过滤。若消息只是对已完成通知的自动回执，没有提出新事实、问题、纠正或执行要求，应选择 ignore；只有确实需要向群里补充新信息时才选择 answer，不要回复“无需重复创建任务”之类没有新增价值的确认。

### 群聊回复节制原则

理解消息、关联任务和回复群聊是三个独立决定。每条消息都必须完成任务关联和近期消息冲突检查。以下情况允许 reply 非空：消息明确要求 Agent 立即回答且当前已有可核验答案；必须询问一个只有相关参与人才能补充且确实阻塞任务的信息；Task 产生新的最终结果、明确失败结果或需要真人行动的结论；需要订正或撤回本主会话此前发送的错误消息；已创建或正在处理的 Task 收到新的执行线索、补充信息或处理要求时，简短确认已收到并会继续处理。

过程确认和信息确认必须简短，只确认已收到、已关联 Task 或将继续处理，不得复述、改写或逐项罗列对方提供的信息，不得虚构进度、结果或完成时间。给活动 Task 补充 IP、库名、schema、文件、截图、字段范围或其他执行线索时，应返回简短确认；叶子已在执行且当前消息作为 task-context 转交时，也应简短确认会结合补充信息继续处理。

task-cancel 成功时只需用一句短句确认任务已停止，不得继续承诺处理。以下情况必须 reply 为空或选择 ignore：同事之间的讨论、确认、纠正或短句接龙且未明确要求 Agent 回答，也与本 Agent 的 Task 无关；没有新增信息，只是复述已有结论或重复确认任务仍在进行；仅因消息提及当前 DWS 登录人姓名。

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
  function mergeReplyReviewCandidates(requests) {
    return [...new Map(requests.flatMap((request) => request.replyReviewCandidates ?? []).map((candidate) => [candidate.outboundId, candidate])).values()]
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
      barrier = { count: 0, promise, resolve }
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
  function holdGroupReplyAdmission(groupId, count) {
    if (count === 0) return []
    let barrier = groupReplyAdmissionBarriers.get(groupId)
    if (barrier === undefined) {
      let resolve
      const promise = new Promise((resolveBarrier) => { resolve = resolveBarrier })
      barrier = { count: 0, promise, resolve }
      groupReplyAdmissionBarriers.set(groupId, barrier)
    }
    barrier.count += count
    return Array.from({ length: count }, () => {
      let released = false
      return () => {
        if (released) return
        released = true
        barrier.count -= 1
        if (barrier.count !== 0) return
        if (groupReplyAdmissionBarriers.get(groupId) === barrier) groupReplyAdmissionBarriers.delete(groupId)
        barrier.resolve()
      }
    })
  }
  function admitGroupSteer(groupId, operation) {
    if (runtimeClosing) throw new Error('resident_runtime_closed')
    const barrier = groupReplyAdmissionBarriers.get(groupId)
    if (barrier === undefined) return operation()
    return barrier.promise.then(() => admitGroupSteer(groupId, operation))
  }
  function createPendingGroupDecision({ groupId, messageId, sequence, message, imageRefs, replyReviewCandidates = [], kind = 'message', baseRequests = [] }) {
    const requestId = randomUUID()
    let resolve, reject
    const promise = new Promise((resolvePending, rejectPending) => { resolve = resolvePending; reject = rejectPending })
    promise.catch(() => undefined)
    let resolveDeliveryRecorded, rejectDeliveryRecorded
    const deliveryRecorded = kind === 'message'
      ? new Promise((resolveDelivery, rejectDelivery) => { resolveDeliveryRecorded = resolveDelivery; rejectDeliveryRecorded = rejectDelivery })
      : Promise.resolve()
    deliveryRecorded.catch(() => undefined)
    const pending = { requestId, groupId, messageId, sequence, message, imageRefs, replyReviewCandidates, kind, baseRequests, resolve, reject, deliveryRecorded, resolveDeliveryRecorded: resolveDeliveryRecorded ?? (() => undefined), rejectDeliveryRecorded: rejectDeliveryRecorded ?? (() => undefined) }
    pendingGroupDecisions.set(requestId, pending)
    return { requestId, promise, deliveryRecorded, resolveDeliveryRecorded: pending.resolveDeliveryRecorded, rejectDeliveryRecorded: pending.rejectDeliveryRecorded }
  }
  function rejectPendingGroupDecision(requestId, error) {
    const pending = pendingGroupDecisions.get(requestId)
    if (pending === undefined) return
    pendingGroupDecisions.delete(requestId)
    pending.reject(error)
  }
  function pendingDecisionsForGroup(groupId) {
    return [...pendingGroupDecisions.values()].filter((pending) => pending.groupId === groupId)
  }
  function ensurePendingGroupDecisionSettlement(agent, groupId) {
    if (pendingGroupDecisionMonitors.has(groupId)) return
    const monitor = (async () => {
      await agent.whenIdle()
      if (runtimeClosing) return
      let remaining = pendingDecisionsForGroup(groupId)
      if (remaining.length === 0) return
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `[GROUP_DECISION_RESUME]\n上一段 Agent 活动已经结束，但以下判断请求仍未提交：${remaining.map((pending) => pending.requestId).join(', ')}。原始群消息或复核信封仍保留在当前 Session 上下文或原生 Inbox；立即结合全部 pending 请求调用 group_decision_submit。本恢复信封不是新的群消息，不得据此创建动作或群回复。` }],
        source: { kind: 'coordinator' },
      }))
      await agent.whenIdle()
      remaining = pendingDecisionsForGroup(groupId)
      for (const pending of remaining) rejectPendingGroupDecision(pending.requestId, new Error(`group_decision_not_submitted:${groupId}:${pending.messageId}`))
    })().catch((error) => {
      for (const pending of pendingDecisionsForGroup(groupId)) rejectPendingGroupDecision(pending.requestId, error)
    }).finally(() => {
      if (pendingGroupDecisionMonitors.get(groupId) === monitor) pendingGroupDecisionMonitors.delete(groupId)
    })
    pendingGroupDecisionMonitors.set(groupId, monitor)
  }
  function createPendingGroupReply({ groupId, sourceMessageId, routingCandidates = [], routingRequired = false, replyReviewCandidates = [], matterSourceMessageIds = [], taskIds = [] }) {
    const requestId = randomUUID()
    let resolve, reject
    const promise = new Promise((resolvePending, rejectPending) => { resolve = resolvePending; reject = rejectPending })
    promise.catch(() => undefined)
    pendingGroupReplies.set(requestId, { requestId, groupId, sourceMessageId, routingCandidates, routingRequired, replyReviewCandidates, matterSourceMessageIds, taskIds, resolve, reject })
    return { requestId, promise }
  }
  function rejectPendingGroupReply(requestId, error) {
    const pending = pendingGroupReplies.get(requestId)
    if (pending === undefined) return
    pendingGroupReplies.delete(requestId)
    pending.reject(error)
  }
  function rejectUnsubmittedGroupReplyWhenIdle(agent, requestId, groupId, sourceMessageId) {
    agent.whenIdle().then(() => rejectPendingGroupReply(requestId, new Error(`group_reply_not_submitted:${groupId}:${sourceMessageId}`)))
      .catch((error) => rejectPendingGroupReply(requestId, error))
  }
  async function waitForActiveGroupSubmissions(groupId) {
    while (true) {
      const active = [...activeGroupSubmissions].filter((submission) => submission.requests.some((request) => request.groupId === groupId))
      if (active.length === 0) return
      await Promise.allSettled(active.map((submission) => submission.committed))
    }
  }
  function assertResidentToolSession(exec, groupId) {
    const expected = residentHandles.get(groupId)?.agent?.session?.id
    if (expected === undefined || String(exec.agent?.session?.id) !== String(expected)) throw new Error(`resident_tool_wrong_session:${groupId}`)
  }
  function registerResidentDecisionTool(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_decision_submit',
      description: 'Submit one or more completed group-message decisions at the current step. Submitted ordinary requestIds count as observed. When any effective decision replies, observedRequestIds adds every other reviewed pending group-message request; observed but unsubmitted requests remain pending for later processing. A stale result means no submission was accepted and must be regenerated with the missing requests.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['submissions'], properties: {
          observedRequestIds: { type: 'array', description: 'Other reviewed ordinary pending request IDs not completed by this call. Submitted ordinary request IDs are counted automatically; duplicates across the two fields are accepted for compatibility.', items: { type: 'string' } },
          submissions: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['requestIds', 'decision'], properties: {
              requestIds: { type: 'array', items: { type: 'string' } },
              decision: groupDecisionJsonSchema,
            },
          } },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['status', 'acceptedRequestIds', 'pendingRequestIds', 'missingRequestIds', 'unexpectedRequestIds'], properties: {
          status: { type: 'string', enum: ['accepted', 'stale', 'review-required'] },
          acceptedRequestIds: { type: 'array', items: { type: 'string' } },
          pendingRequestIds: { type: 'array', items: { type: 'string' } },
          missingRequestIds: { type: 'array', items: { type: 'string' } },
          unexpectedRequestIds: { type: 'array', items: { type: 'string' } },
          reviewError: { type: 'string' },
        } },
        render: (_args, out) => [{ type: 'text', text: out.status === 'stale'
          ? `回复观察快照已变化，本批未提交。缺失请求 ID：${out.missingRequestIds.join(',') || '无'}；异常请求 ID：${out.unexpectedRequestIds.join(',') || '无'}。必须结合新请求重新生成并再次提交；当前共有 ${out.pendingRequestIds.length} 个请求待处理。`
          : out.status === 'review-required'
            ? `历史回复审阅不完整，本批未提交（${out.reviewError}）。请按信封中的历史主会话回复候选补全 replyReview 后重新提交。`
            : `已提交 ${out.acceptedRequestIds.length} 个群消息判断请求；仍有 ${out.pendingRequestIds.length} 个请求待处理。` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        if (args.submissions.length === 0 || args.submissions.some((submission) => submission.requestIds.length === 0)) throw new Error('group_decision_submission_empty')
        if (args.submissions.some((submission) => submission.requestIds.some((requestId) => requestId.trim() === ''))) throw new Error('group_decision_request_invalid')
        const observedRequestIds = args.observedRequestIds ?? []
        if (observedRequestIds.some((requestId) => requestId.trim() === '')) throw new Error('group_decision_observed_request_invalid')
        if (new Set(observedRequestIds).size !== observedRequestIds.length) throw new Error('group_decision_observed_request_duplicate')
        const requestIds = args.submissions.flatMap((submission) => submission.requestIds)
        if (new Set(requestIds).size !== requestIds.length) throw new Error('group_decision_request_duplicate')
        const pendings = requestIds.map((requestId) => pendingGroupDecisions.get(requestId))
        if (pendings.some((pending) => pending === undefined)) throw new Error('group_decision_request_unknown')
        if (pendings.some((pending) => pending.groupId !== groupId)) throw new Error('group_decision_request_wrong_group')
        const observedPendings = observedRequestIds.map((requestId) => pendingGroupDecisions.get(requestId))
        if (observedPendings.some((pending) => pending === undefined)) throw new Error('group_decision_observed_request_unknown')
        if (observedPendings.some((pending) => pending.groupId !== groupId)) throw new Error('group_decision_observed_request_wrong_group')
        if (observedPendings.some((pending) => pending.kind !== 'message')) throw new Error('group_decision_observed_request_not_message')
        if (args.submissions.some((submission) => submission.requestIds.filter((requestId) => pendingGroupDecisions.get(requestId).kind === 'recheck').length > 1)) throw new Error('group_decision_recheck_duplicate')
        let validated
        try {
          validated = args.submissions.map((submission) => ({
            requestIds: [...submission.requestIds],
            requests: submission.requestIds.map((requestId) => pendingGroupDecisions.get(requestId)).sort((left, right) => left.sequence - right.sequence),
            decision: validateGroupDecision(submission.decision),
          })).map((submission) => ({
            ...submission,
            replyReviewCandidates: mergeReplyReviewCandidates(submission.requests.flatMap((request) => [...request.baseRequests, request])),
            decision: blockTaskDecisionForUnavailableMedia(submission.decision, [...new Set(submission.requests
              .flatMap((request) => [...request.baseRequests, request])
              .flatMap((request) => Array.isArray(request.message.mediaUnavailable) ? request.message.mediaUnavailable : []))]),
          })).map((submission) => {
          const currentMessageIds = new Set(submission.requests
            .flatMap((request) => request.kind === 'recheck' ? request.baseRequests : [request])
            .filter((request) => request.kind === 'message')
            .map((request) => request.messageId))
          const persistedMessageIds = new Set((store.getGroup(groupId)?.messages ?? []).map((message) => message.messageId))
          for (const action of submission.decision.actions) {
            if (new Set(action.sourceMessageIds).size !== action.sourceMessageIds.length) throw new Error('task_action_source_message_duplicate')
            if (action.sourceMessageIds.some((messageId) => !persistedMessageIds.has(messageId))) throw new Error('task_action_source_message_invalid')
            if (!action.sourceMessageIds.some((messageId) => currentMessageIds.has(messageId))) throw new Error('task_action_current_source_message_required')
            if (action.kind === 'task-cancel') {
              if (action.reason.trim() === '') throw new Error('task_cancel_reason_required')
              const target = store.getTask(action.taskId)
              if (target === undefined || target.groupId !== groupId) throw new Error(`task_cancel_target_invalid:${action.taskId}`)
              if (target.state === 'completed') throw new Error(`task_not_active:${action.taskId}`)
            }
            if (action.kind === 'new-task' || action.kind === 'task-proposal') {
              const sourceMessages = (store.getGroup(groupId)?.messages ?? []).filter((message) => action.sourceMessageIds.includes(message.messageId))
              const directedAway = sourceMessages.filter((message) => isDirectedToOtherParticipants(message.text, store.getAgentNames?.() ?? []))
              const currentRequests = submission.requests.flatMap((request) => request.kind === 'recheck' ? request.baseRequests : [request]).filter((request) => request.kind === 'message')
              const hasQuotedTransfer = (sourceMessageId) => currentRequests.some((request) => isExplicitAgentDirection(request.message.text, store.getAgentNames?.() ?? []) && request.message.quotedMessage?.messageId === sourceMessageId)
              if (directedAway.some((message) => !hasQuotedTransfer(message.messageId))) throw new Error('task_action_directed_to_other_participants')
            }
          }
          if ('reply' in submission.decision && submission.decision.reply.trim() !== '') {
            submission.decision.replyReview = validateReplyReview(submission.decision.replyReview, submission.replyReviewCandidates, {
              confirmationTaskIds: submission.decision.actions.flatMap((action) => ['task-context', 'task-reopen', 'task-cancel'].includes(action.kind) ? [action.taskId] : []),
            })
          }
          return submission
        })
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('group_reply_review_')) throw error
          const pendingRequestIds = [...pendingGroupDecisions.values()].filter((pending) => pending.groupId === groupId && pending.kind === 'message').sort((left, right) => left.sequence - right.sequence).map((pending) => pending.requestId)
          return { status: 'review-required', acceptedRequestIds: [], pendingRequestIds, missingRequestIds: [], unexpectedRequestIds: [], reviewError: error.message }
        }
        const replying = validated.filter((submission) => 'reply' in submission.decision && submission.decision.reply.trim() !== '')
        const releaseReplyAdmissions = holdGroupReplyAdmission(groupId, replying.length)
        if (replying.length > 0) {
          const currentRequestIds = [...pendingGroupDecisions.values()]
            .filter((pending) => pending.groupId === groupId && pending.kind === 'message')
            .sort((left, right) => left.sequence - right.sequence)
            .map((pending) => pending.requestId)
          const submittedMessageRequestIds = validated.flatMap((submission) => submission.requests
            .filter((pending) => pending.kind === 'message')
            .map((pending) => pending.requestId))
          const observed = new Set([...submittedMessageRequestIds, ...observedRequestIds])
          const current = new Set(currentRequestIds)
          const missing = currentRequestIds.filter((requestId) => !observed.has(requestId))
          const unexpected = [...observed].filter((requestId) => !current.has(requestId))
          if (missing.length > 0 || unexpected.length > 0) {
            for (const release of releaseReplyAdmissions) release()
            return { status: 'stale', acceptedRequestIds: [], pendingRequestIds: currentRequestIds, missingRequestIds: missing, unexpectedRequestIds: unexpected }
          }
        }
        const results = []
        let replyIndex = 0
        for (const submission of validated) {
          let resolveCommitted, rejectCommitted
          const committed = new Promise((resolve, reject) => { resolveCommitted = resolve; rejectCommitted = reject })
          committed.catch(() => undefined)
          const hasReply = 'reply' in submission.decision && submission.decision.reply.trim() !== ''
          let resolveReplyLinearized, rejectReplyLinearized
          const replyLinearized = hasReply ? new Promise((resolve, reject) => { resolveReplyLinearized = resolve; rejectReplyLinearized = reject }) : undefined
          replyLinearized?.catch(() => undefined)
          const releaseReplyAdmission = hasReply ? releaseReplyAdmissions[replyIndex++] : undefined
          let replySettled = false
          const settleReply = (error) => {
            if (!hasReply || replySettled) return
            replySettled = true
            releaseReplyAdmission()
            if (error === undefined) resolveReplyLinearized()
            else rejectReplyLinearized(error)
          }
          const recheckOwner = submission.requests.find((request) => request.kind === 'recheck')
          const ownerRequestId = recheckOwner?.requestId ?? submission.requests[0].requestId
          const result = { decision: submission.decision, requestIds: submission.requestIds, ownerRequestId, requests: submission.requests, committed, resolveCommitted, rejectCommitted, replyLinearized, resolveReplyLinearized: () => settleReply(), rejectReplyLinearized: (error) => settleReply(error) }
          activeGroupSubmissions.add(result)
          committed.finally(() => activeGroupSubmissions.delete(result)).catch(() => undefined)
          results.push(result)
          for (const pending of submission.requests) {
            pendingGroupDecisions.delete(pending.requestId)
            pending.resolve(result)
          }
        }
        const replyOutcomes = await Promise.allSettled(results.flatMap((result) => result.replyLinearized === undefined ? [] : [result.replyLinearized]))
        const failedReply = replyOutcomes.find((outcome) => outcome.status === 'rejected')
        if (failedReply !== undefined) throw failedReply.reason
        const pendingRequestIds = [...pendingGroupDecisions.values()]
          .filter((pending) => pending.groupId === groupId && pending.kind === 'message')
          .sort((left, right) => left.sequence - right.sequence)
          .map((pending) => pending.requestId)
        return { status: 'accepted', acceptedRequestIds: requestIds, pendingRequestIds, missingRequestIds: [], unexpectedRequestIds: [] }
      },
    })
  }
  function registerResidentReplyTool(agentCtx, groupId) {
    agentCtx.tools.register({
      name: 'group_reply_submit',
      description: 'Submit a generated resident-session group notification after reviewing prior resident replies. observedRequestIds must exactly cover every pending group-message request reviewed before the reply; observed requests remain pending for their own later Decision. A stale result means the notification was not accepted and must be regenerated with the missing requests.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['requestId', 'observedRequestIds', 'reply'], properties: {
          requestId: { type: 'string' },
          observedRequestIds: { type: 'array', items: { type: 'string' } },
          reply: { type: 'string' },
          replyReview: replyReviewJsonSchema,
          replyToMessageId: { type: 'string', description: 'Task通知要引用的消息ID，必须来自该Task完整消息时间线。' },
          atOpenDingTalkIds: { type: 'array', items: { type: 'string' }, description: '需要收到本次Task通知的参与人稳定ID，可选择多人，必须来自该Task消息时间线。' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['status', 'acceptedRequestIds', 'pendingRequestIds', 'missingRequestIds', 'unexpectedRequestIds'], properties: {
          status: { type: 'string', enum: ['accepted', 'stale', 'review-required'] },
          acceptedRequestIds: { type: 'array', items: { type: 'string' } },
          pendingRequestIds: { type: 'array', items: { type: 'string' } },
          missingRequestIds: { type: 'array', items: { type: 'string' } },
          unexpectedRequestIds: { type: 'array', items: { type: 'string' } },
          reviewError: { type: 'string' },
        } },
        render: (_args, out) => [{ type: 'text', text: out.status === 'stale'
          ? `群通知观察快照已变化，本次未提交。缺失请求 ID：${out.missingRequestIds.join(',') || '无'}；异常请求 ID：${out.unexpectedRequestIds.join(',') || '无'}。必须结合新请求重新生成后再次提交。`
          : out.status === 'review-required'
            ? `历史回复审阅不完整，本次通知未提交（${out.reviewError}）。请按 TASK_COORDINATION 中的候选补全 replyReview 后重新提交。`
            : `群通知已可靠提交；仍有 ${out.pendingRequestIds.length} 个群消息请求待处理。` }],
      },
      execute: async (args, exec) => {
        assertResidentToolSession(exec, groupId)
        if (args.requestId.trim() === '') throw new Error('group_reply_request_invalid')
        if (args.reply.trim() === '') throw new Error('group_reply_text_required')
        if (args.observedRequestIds.some((requestId) => requestId.trim() === '')) throw new Error('group_reply_observed_request_invalid')
        if (new Set(args.observedRequestIds).size !== args.observedRequestIds.length) throw new Error('group_reply_observed_request_duplicate')
        const pending = pendingGroupReplies.get(args.requestId)
        if (pending === undefined) throw new Error('group_reply_request_unknown')
        if (pending.groupId !== groupId) throw new Error('group_reply_request_wrong_group')
        let replyReview
        try { replyReview = validateReplyReview(args.replyReview, pending.replyReviewCandidates, { confirmationTaskIds: pending.taskIds }) }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('group_reply_review_')) throw error
          const pendingRequestIds = [...pendingGroupDecisions.values()].filter((item) => item.groupId === groupId && item.kind === 'message').sort((left, right) => left.sequence - right.sequence).map((item) => item.requestId)
          return { status: 'review-required', acceptedRequestIds: [], pendingRequestIds, missingRequestIds: [], unexpectedRequestIds: [], reviewError: error.message }
        }
        const routingCandidates = pending.routingCandidates.filter((item) => typeof item.messageId === 'string' && typeof item.senderOpenDingTalkId === 'string')
        const participantIds = new Set(routingCandidates.map((item) => item.senderOpenDingTalkId))
        if (pending.routingRequired && (typeof args.replyToMessageId !== 'string' || args.replyToMessageId.trim() === '')) throw new Error('group_reply_target_required')
        if (pending.routingRequired && (!Array.isArray(args.atOpenDingTalkIds) || args.atOpenDingTalkIds.length === 0)) throw new Error('group_reply_recipients_required')
        if (args.atOpenDingTalkIds !== undefined && !Array.isArray(args.atOpenDingTalkIds)) throw new Error('group_reply_recipient_invalid')
        if (args.atOpenDingTalkIds?.some((id) => typeof id !== 'string' || id.trim() === '')) throw new Error('group_reply_recipient_invalid')
        if (args.atOpenDingTalkIds && new Set(args.atOpenDingTalkIds).size !== args.atOpenDingTalkIds.length) throw new Error('group_reply_recipient_duplicate')
        const replyTarget = typeof args.replyToMessageId === 'string' ? routingCandidates.find((item) => item.messageId === args.replyToMessageId) : routingCandidates.at(-1)
        if (args.replyToMessageId !== undefined && replyTarget === undefined) throw new Error('group_reply_target_not_in_task_history')
        if (args.atOpenDingTalkIds?.some((id) => !participantIds.has(id))) throw new Error('group_reply_recipient_not_in_task_history')
        const observedPendings = args.observedRequestIds.map((requestId) => pendingGroupDecisions.get(requestId))
        if (observedPendings.some((item) => item === undefined)) throw new Error('group_reply_observed_request_unknown')
        if (observedPendings.some((item) => item.groupId !== groupId)) throw new Error('group_reply_observed_request_wrong_group')
        if (observedPendings.some((item) => item.kind !== 'message')) throw new Error('group_reply_observed_request_not_message')
        const [releaseReplyAdmission] = holdGroupReplyAdmission(groupId, 1)
        const currentRequestIds = [...pendingGroupDecisions.values()]
          .filter((item) => item.groupId === groupId && item.kind === 'message')
          .sort((left, right) => left.sequence - right.sequence)
          .map((item) => item.requestId)
        const observed = new Set(args.observedRequestIds)
        const current = new Set(currentRequestIds)
        const missing = currentRequestIds.filter((requestId) => !observed.has(requestId))
        const unexpected = args.observedRequestIds.filter((requestId) => !current.has(requestId))
        if (missing.length > 0 || unexpected.length > 0) {
          releaseReplyAdmission()
          return { status: 'stale', acceptedRequestIds: [], pendingRequestIds: currentRequestIds, missingRequestIds: missing, unexpectedRequestIds: unexpected }
        }
        let resolveReplyLinearized, rejectReplyLinearized
        const replyLinearized = new Promise((resolve, reject) => { resolveReplyLinearized = resolve; rejectReplyLinearized = reject })
        replyLinearized.catch(() => undefined)
        let settled = false
        const settle = (error) => {
          if (settled) return
          settled = true
          releaseReplyAdmission()
          activeGroupReplies.delete(submitted)
          if (error === undefined) resolveReplyLinearized()
          else rejectReplyLinearized(error)
        }
        const selectedRecipients = args.atOpenDingTalkIds ?? (replyTarget ? [replyTarget.senderOpenDingTalkId] : [])
        const submitted = {
          reply: args.reply.trim(),
          ...(replyReview ? { replyReview } : {}),
          matterSourceMessageIds: pending.matterSourceMessageIds,
          taskIds: pending.taskIds,
          ...(replyTarget ? { replyToMessageId: replyTarget.messageId, replyToSenderOpenDingTalkId: replyTarget.senderOpenDingTalkId } : {}),
          ...(selectedRecipients.length > 0 ? { atOpenDingTalkIds: selectedRecipients } : {}),
          replyLinearized, resolveReplyLinearized: () => settle(), rejectReplyLinearized: (error) => settle(error),
        }
        activeGroupReplies.add(submitted)
        pendingGroupReplies.delete(args.requestId)
        pending.resolve(submitted)
        await replyLinearized
        const pendingRequestIds = [...pendingGroupDecisions.values()]
          .filter((item) => item.groupId === groupId && item.kind === 'message')
          .sort((left, right) => left.sequence - right.sequence)
          .map((item) => item.requestId)
        return { status: 'accepted', acceptedRequestIds: [args.requestId], pendingRequestIds, missingRequestIds: [], unexpectedRequestIds: [] }
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
  async function notifyOutboxListener(listener, event) {
    try { await listener(event) }
    catch (error) {
      recoveryIssues.push({
        groupId: event.groupId, sourceMessageId: event.outbound.sourceMessageId, kind: 'outbox-listener',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  async function recallReplacedOutbounds({ groupId, outboundIds, replacementSourceMessageId }) {
    if (outboundIds.length === 0) return
    if (groupMessageRecaller === undefined || store.updateOutboundRecall === undefined) throw new Error('group_message_recaller_required')
    const group = store.getGroup(groupId)
    if (group === undefined) throw new Error(`group_not_subscribed:${groupId}`)
    const replacements = outboundIds.map((outboundId) => {
      const outbound = group.outbox.find((item) => item.outboundId === outboundId)
      if (outbound === undefined) throw new Error(`group_reply_replacement_unknown:${outboundId}`)
      if (outbound.recallStatus === 'recalled') throw new Error(`group_reply_replacement_already_recalled:${outboundId}`)
      if (outbound.status !== 'sent' || !outbound.deliveredMessageId) throw new Error(`group_reply_replacement_not_delivered:${outboundId}`)
      return outbound
    })
    for (const outbound of replacements) {
      const reason = `superseded-by:${replacementSourceMessageId}`
      await store.updateOutboundRecall({ groupId, outboundId: outbound.outboundId, status: 'requested', reason })
      try {
        await groupMessageRecaller({ groupId, messageId: outbound.deliveredMessageId, outbound })
        await store.updateOutboundRecall({ groupId, outboundId: outbound.outboundId, status: 'recalled', reason })
      } catch (error) {
        await store.updateOutboundRecall({ groupId, outboundId: outbound.outboundId, status: 'failed', reason, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }
  }
  async function appendReliableOutbox({ groupId, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, replyKind, matterSourceMessageIds, taskIds, replacesOutboundIds = [], onPersisted }) {
    const before = store.getGroup(groupId)
    if (before === undefined) throw new Error(`group_not_subscribed:${groupId}`)
    const existing = before.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (existing !== undefined) { onPersisted?.(); return before }
    await recallReplacedOutbounds({ groupId, outboundIds: replacesOutboundIds, replacementSourceMessageId: sourceMessageId })
    const group = await store.appendOutbox({ groupId, sourceMessageId, text, replyToMessageId, replyToSenderOpenDingTalkId, atOpenDingTalkIds, replyKind, matterSourceMessageIds, taskIds, replacesOutboundIds })
    const outbound = group.outbox.find((item) => item.sourceMessageId === sourceMessageId)
    if (outbound === undefined) throw new Error(`outbox_append_missing:${groupId}:${sourceMessageId}`)
    onPersisted?.()
    const event = { groupId, outbound }
    if (outboxListeners.size === 0) bufferedOutboxEvents.push(event)
    else for (const listener of outboxListeners) await notifyOutboxListener(listener, event)
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

  function taskMessageSnapshot(message, runSequence) {
    return {
      messageId: message.messageId,
      text: message.text,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      ...(message.senderOpenDingTalkId ? { senderOpenDingTalkId: message.senderOpenDingTalkId } : {}),
      ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
      ...(message.quotedMessage?.messageId ? { quotedMessageId: message.quotedMessage.messageId } : {}),
      ...(runSequence !== undefined ? { runSequence } : {}),
      associatedAt: new Date().toISOString(),
    }
  }

  function mergeTaskMessageHistory(current, messages, runSequence) {
    const known = new Set((current.messageHistory ?? []).map((item) => item.messageId))
    const appended = messages.filter((message) => !known.has(message.messageId)).map((message) => taskMessageSnapshot(message, runSequence))
    return appended.length === 0 ? current.messageHistory : [...(current.messageHistory ?? []), ...appended]
  }

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

  async function cancelTaskInternal(taskId, normalizedReason, sourceMessages = []) {
    try {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      if (task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
      const handle = signalTaskCancellation(taskId)
      if (handle !== undefined) {
        const goal = ctx.goals.get(handle.agent)
        if (goal !== undefined && goal.phase !== 'complete') ctx.goals.complete(handle.agent, goalRef(goal))
      }
      const cancelled = await store.updateTask(taskId, (current) => {
        const messageHistory = mergeTaskMessageHistory(current, sourceMessages, current.runSequence ?? 1)
        return {
          ...current,
          ...(messageHistory ? { messageHistory } : {}),
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
      await pumpTasks()
      return cancelled
    } finally {
      cancellingTasks.delete(taskId)
    }
  }

  function taskNotificationMessages(task) {
    if ((task.messageHistory ?? []).length > 0) return task.messageHistory
    const group = store.getGroup(task.groupId)
    const triggers = [...(task.triggerHistory ?? []), {
      sourceMessageId: task.sourceMessageId,
      ...(task.requesterName ? { requesterName: task.requesterName } : {}),
      ...(task.requesterOpenDingTalkId ? { requesterOpenDingTalkId: task.requesterOpenDingTalkId } : {}),
    }]
    const seen = new Set()
    return triggers.flatMap((trigger) => {
      if (isSyntheticTaskSource(trigger.sourceMessageId) || seen.has(trigger.sourceMessageId)) return []
      seen.add(trigger.sourceMessageId)
      const message = group?.messages?.find((item) => item.messageId === trigger.sourceMessageId)
      if (message !== undefined) return [taskMessageSnapshot(message)]
      return [{
        messageId: trigger.sourceMessageId, text: '',
        ...(trigger.requesterName ? { senderName: trigger.requesterName } : {}),
        ...(trigger.requesterOpenDingTalkId ? { senderOpenDingTalkId: trigger.requesterOpenDingTalkId } : {}),
        ...(trigger.occurredAt !== undefined ? { occurredAt: trigger.occurredAt } : {}),
      }]
    })
  }

  function taskResultOutboxKey(task, result) {
    if (result.status === 'completed') {
      const completionSequence = task.completionSequence ?? 0
      return `task-result:${task.taskId}:completed${completionSequence > 0 ? `:${completionSequence}` : ''}`
    }
    return `task-result:${task.taskId}:waiting:${createHash('sha256').update(result.waitingReason).digest('hex').slice(0, 16)}`
  }

  async function coordinateTaskResultInternal(task, result) {
    const resultKey = taskResultOutboxKey(task, result)
    const existing = store.getGroup(task.groupId)?.outbox.find((item) => item.sourceMessageId === resultKey)
    if (existing !== undefined) return existing
    const handle = residentHandles.get(task.groupId)
    if (handle === undefined) throw new Error(`resident_not_active:${task.groupId}`)
    await handle.agent.whenIdle()
    if (runtimeClosing) throw new Error('resident_runtime_closed')
    const notificationMessages = taskNotificationMessages(task)
    const routingCandidates = notificationMessages.filter((item) => typeof item.senderOpenDingTalkId === 'string')
    const resultProjection = result.status === 'completed'
      ? { status: result.status, workType: result.workType, summary: result.summary, evidence: result.evidence, artifacts: result.artifacts, delivery: result.delivery }
      : { status: result.status, summary: result.summary, evidence: result.evidence, artifacts: result.artifacts, waitingKind: result.waitingKind, waitingReason: result.waitingReason, questions: result.questions }
    const replyReviewCandidates = replyReviewCandidatesFor(task.groupId, notificationMessages, [task.taskId])
    const pending = createPendingGroupReply({
      groupId: task.groupId, sourceMessageId: resultKey, routingCandidates,
      routingRequired: (task.messageHistory ?? []).some((item) => typeof item.senderOpenDingTalkId === 'string'),
      replyReviewCandidates, matterSourceMessageIds: notificationMessages.map((item) => item.messageId), taskIds: [task.taskId],
    })
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `[TASK_COORDINATION]\n回复请求 ID：${pending.requestId}\nTask ID: ${task.taskId}\n任务：${task.title ?? task.objective}\n当前目标：${task.objective}\n任务消息时间线：${JSON.stringify(notificationMessages)}\n核验结果：${JSON.stringify(resultProjection)}\n历史主会话回复候选（必须阅读来源正文后判断同一事项，引用ID只能作为线索）：${JSON.stringify(replyReviewCandidates)}\n\n必须通过 group_reply_submit 提交一条可直接发送到群聊的通知，不得用 assistant 文本直接输出通知。提交前语义审阅当前已经进入的全部普通 GROUP_MESSAGE_STEER：若新消息影响本通知，结合它重新生成；若不影响，保持本结果通知，新消息将在通知可靠提交后继续处理。把已审阅的全部普通 pending 请求 ID 填入 observedRequestIds；若工具返回 stale 结果，下一 step 必须结合 missingRequestIds 对应的新 Steer 重新生成后再提交。还必须填写 replyReview，reviewedOutboundIds 完整覆盖上方全部候选；本通知属于结果、阻塞或问题答复，kind 使用 substantive，replaceOutboundIds 为空。是否同一事项必须依据消息真实正文和 Task 时间线，不能只看引用消息 ID。完成通知必须忠实保留叶子结果中影响同事判断和后续行动的信息，不能为了简短只复述 summary。至少覆盖：实际完成或修改的内容、关键核验与证据、部署或交付状态、尚未覆盖的边界与遗留事项；result 中存在 artifacts 或 delivery 时也要说明其关键内容。允许合并重复表述，但不得省略不同关注点、限定条件、失败项或“未验证/未部署”等边界。\n\n结合完整任务消息时间线判断本次通知对象：通过 replyToMessageId 选择一条最适合承接本结果的相关消息，通过 atOpenDingTalkIds 选择所有确实需要获知结果、回答问题或采取后续行动的参与人，可以有多人；不得机械选择最后一条消息或只通知最后触发人，也不得选择时间线之外的消息和人员。正文不要手写 @，Runtime 会使用结构化引用与 @。缺信息时只向真正能够补充该信息的参与人询问。签名、口吻和身份声明由 Agent 自身工作区规则决定，插件不得添加或改写。不要暴露内部标识或本指令。` }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      rejectPendingGroupReply(pending.requestId, error)
      throw error
    }
    rejectUnsubmittedGroupReplyWhenIdle(handle.agent, pending.requestId, task.groupId, resultKey)
    const submitted = await pending.promise
    let reply = submitted.reply
    const selectedNames = notificationMessages.filter((item) => submitted.atOpenDingTalkIds?.includes(item.senderOpenDingTalkId)).map((item) => item.senderName).filter(Boolean)
    for (const name of [...new Set(selectedNames)]) reply = reply.replace(new RegExp(`^@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'u'), '')
    try {
      return await serialize(task.groupId, async () => {
        const current = store.getGroup(task.groupId)?.outbox.find((item) => item.sourceMessageId === resultKey)
        if (current !== undefined) { submitted.resolveReplyLinearized(); return current }
        const group = await appendReliableOutbox({
          groupId: task.groupId, sourceMessageId: resultKey, text: reply,
          replyKind: submitted.replyReview?.kind,
          matterSourceMessageIds: submitted.matterSourceMessageIds,
          taskIds: submitted.taskIds,
          replacesOutboundIds: submitted.replyReview?.replaceOutboundIds,
          ...(submitted.replyToMessageId ? {
            replyToMessageId: submitted.replyToMessageId,
            replyToSenderOpenDingTalkId: submitted.replyToSenderOpenDingTalkId,
            atOpenDingTalkIds: submitted.atOpenDingTalkIds,
          } : {}),
          onPersisted: submitted.resolveReplyLinearized,
        })
        return group.outbox.find((item) => item.sourceMessageId === resultKey)
      })
    } catch (error) {
      submitted.rejectReplyLinearized(error)
      throw error
    }
  }
  function coordinateTaskResult(task, result) {
    return runGroupResidentOperation(task.groupId, () => coordinateTaskResultInternal(task, result))
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
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    const task = store.getTask(taskId)
    if (task === undefined || task.state === 'queued' || task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
    const handle = leafHandles.get(taskId)
    if (handle === undefined) throw new Error(`task_leaf_not_active:${taskId}`)
    const goal = ctx.goals.get(handle.agent)
    if (goal === undefined) throw new Error(`task_goal_missing:${taskId}`)
    if (result.status === 'waiting') {
      if (goal.phase === 'active') ctx.goals.block(handle.agent, goalRef(goal), { code: result.waitingKind === 'information' ? 'task-input-required' : 'task-human-intervention-required', message: result.waitingReason })
      if (result.waitingKind === 'information') {
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
        await followupTaskInternal(running, `[HUMAN_INTERVENTION_REPLY]\nBlocker request: ${approved.requestId}\nDecision: approved\nReply: ${approved.reply ?? '已人工确认继续'}\n\nA human already confirmed continuation within this exact controlled-action scope. Continue the same task only within that scope; do not request human intervention again.`)
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
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    if (result.status !== 'completed') {
      const waiting = await serializeTasks(() => submitTaskResultInternal(taskId, result))
      if (result.waitingKind === 'information') await withoutInitiator(() => coordinateTaskResult(waiting, result))
      return waiting
    }
    const prepared = await serializeTasks(async () => {
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
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
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
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
    if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
    const { submitted, reviewTask } = await serializeTasks(async () => {
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
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
      if (cancellingTasks.has(taskId)) throw new Error(`task_cancel_pending:${taskId}`)
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
      supersedeReason: reason?.trim() || '按当前统一人工介入逻辑重新提交',
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

${quotedMessageRecoveryPolicy('leaf')}

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

### Task 完整消息与参与人时间线

${task.messageHistory?.length ? JSON.stringify(task.messageHistory) : '暂无结构化消息时间线；仅可使用上方已持久化的来源事实，不得猜测缺失参与人。'}

### 已持久化的人工处理意见

${(task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').length
  ? (task.humanBlockerHistory ?? []).filter((item) => item.status === 'answered').map((item) => `- ${item.decision ?? 'answered'}｜${item.category}｜${item.requestedAction}｜答复：${item.reply ?? '未记录'}`).join('\n')
  : '暂无。'}

完成结果提交后由 Runtime 完整交给 resident 主会话，再由主会话结合 Task 完整时间线判断如何通知原群相关参与人。群聊消息的发送、回复、编辑、更正和撤回均由 resident 主会话判断；叶子只提交业务结果、结论、证据、未验证项和置信边界，不得判断、建议或申请撤回/编辑/更正任何群消息，不得提供消息处置目标或 messageId。群聊通知只有 Runtime 这一个出口：叶子会话不得调用 DWS 或其他消息工具向来源群发送、回复、编辑或撤回任务进度、阻塞或完成通知，也不得把自行发送群通知作为完成证据；叶子只允许读取群消息用于业务核验，并通过 submit_task_result 提交结构化结果。

### 阻塞规则

除以下两类情况外，不得暂停或阻塞 Goal，也不得提交 waiting：
1. \`waitingKind=information\`：只有 Task 相关参与人才能补充的目标、完成条件或必要业务信息不明确；必须提供具体 questions，Runtime 将由主会话根据完整消息时间线选择实际询问对象。
2. \`waitingKind=human-intervention\`：已经取得证据且自身无法解决的操作红线、网络中断、磁盘不足、资源不足、意外事件或必须真人确认的处置方案；必须提供 blockerCategory、risk、evidence、attemptedActions 和 requestedAction。risk 单独说明执行该操作可能造成的具体影响；操作红线使用 blockerCategory=redline，并把完整操作范围和不在授权内的事项写入 requestedAction；Runtime 只发送这一条人工介入消息。

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

  async function reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks, sourceMessages = []) {
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
      const messageHistory = mergeTaskMessageHistory(current, sourceMessages, nextRunSequence)
      const { requesterName: _requesterName, requesterOpenDingTalkId: _requesterOpenDingTalkId, ...withoutCurrentRequester } = current
      return withRevisedObjective({
        ...withoutCurrentRequester,
        ...(retainedTrigger ? { sourceMessageId: retainedTrigger.sourceMessageId, ...(retainedTrigger.requesterName ? { requesterName: retainedTrigger.requesterName } : {}), ...(retainedTrigger.requesterOpenDingTalkId ? { requesterOpenDingTalkId: retainedTrigger.requesterOpenDingTalkId } : {}) } : {}),
        triggerHistory: nextHistory,
        ...(messageHistory ? { messageHistory } : {}),
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
  async function appendTaskContextInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks, sourceMessages = []) {
    if (cancellingTasks.has(task.taskId)) throw new Error(`task_cancel_pending:${task.taskId}`)
    if (task.state === 'completed') return reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks, sourceMessages)
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
      const messageHistory = mergeTaskMessageHistory(current, sourceMessages, current.runSequence ?? 1)
      const revised = withRevisedObjective({ ...current, ...(messageHistory ? { messageHistory } : {}), relatedContexts: [...(current.relatedContexts ?? []), context], updatedAt: new Date().toISOString() }, objective, trigger)
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
    if (cancellingTasks.has(task.taskId)) throw new Error(`task_cancel_pending:${task.taskId}`)
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
    hydrateGroupHistory: ({ groupId }) => serializeHydration(groupId, () => runGroupResidentOperation(groupId, async () => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
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
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `[GROUP_HISTORY_IMPORT]\n以下是当前群聊今天已接收的历史消息，仅用于恢复新常驻会话的群聊上下文。不要回复群聊、不要创建或续接任务，也不要重新执行历史请求。\n\n${blocks.join('\n\n')}` }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const completed = handle.agent.session.events.some((event) => event.seq >= firstSeq && event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
      if (!completed) throw new Error(`group_history_import_failed:${groupId}`)
      return { groupId, residentSessionId: group.residentSessionId, imported: messages.length }
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
    registerGroupMessageRecaller(recaller) {
      if (typeof recaller !== 'function') throw new Error('group_message_recaller_invalid')
      groupMessageRecaller = recaller
      return () => { if (groupMessageRecaller === recaller) groupMessageRecaller = undefined }
    },
    listAuthorizationRequests,
    getAuthorizationRequest,
    ingest: (message, { retryDecisionFailed = false } = {}) => {
      if (runtimeClosing) return Promise.reject(new Error('resident_runtime_closed'))
      const inflightKey = `${message.groupId}\u0000${message.messageId}`
      const existing = inflightMessages.get(inflightKey)
      if (existing !== undefined) return existing
      const operation = (async () => {
        const ingested = await store.ingest(message)
        const persisted = store.getGroup(message.groupId)?.messages.find((item) => item.messageId === message.messageId)
        if (retryDecisionFailed && persisted?.agentDeliveryStatus !== 'decision-failed') throw new Error(`message_not_retryable:${message.messageId}`)
        if (ingested.duplicate && ['steered', 'delivered', 'decision-failed', 'skipped'].includes(persisted?.agentDeliveryStatus) && !(retryDecisionFailed && persisted.agentDeliveryStatus === 'decision-failed')) return ingested
        const accepted = ingested.duplicate ? { ...ingested, duplicate: false, recovered: true, sequence: persisted.sequence } : ingested
        let handle
        let pending, submitted, recheckedSubmission
        try {
          const images = Array.isArray(message.images) ? message.images : []
          if (images.length > 0 && attachments === undefined) throw new Error('dsh_attachments_required')
          const imageRefs = images.length === 0 ? [] : await attachments.saveImages(images.map((image) => ({ data: image.data, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })))
          const replyReviewCandidates = replyReviewCandidatesFor(message.groupId, [message])
          const decisionPrompt = buildDecisionPrompt({ messageId: message.messageId, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable, replyReviewCandidates })
          pending = await admitGroupSteer(message.groupId, () => {
            handle = residentHandles.get(message.groupId)
            if (handle === undefined) throw new Error(`resident_not_active:${message.groupId}`)
            const admitted = createPendingGroupDecision({ groupId: message.groupId, messageId: message.messageId, sequence: accepted.sequence, message, imageRefs, replyReviewCandidates })
            const content = [
              { type: 'text', text: `[GROUP_MESSAGE_STEER]\n判断请求 ID：${admitted.requestId}\n${decisionPrompt.replace(/^\[GROUP_DECISION\]\n\n/u, '')}` },
              ...imageRefs.map((attachment) => ({ type: 'image', attachment })),
            ]
            try { handle.agent.steer(createUserMessage({ content, source: { kind: 'user' } })) }
            catch (error) { rejectPendingGroupDecision(admitted.requestId, error); throw error }
            return admitted
          })
          ensurePendingGroupDecisionSettlement(handle.agent, message.groupId)
          await store.markMessageAgentDelivery({ groupId: message.groupId, messageId: message.messageId, status: 'steered' })
          pending.resolveDeliveryRecorded()
          submitted = await pending.promise
          if (submitted.ownerRequestId !== pending.requestId) {
            await submitted.committed
            return { ...accepted, decision: submitted.decision, decisionRequestIds: submitted.requestIds, decisionOwnerRequestId: submitted.ownerRequestId, group: store.getGroup(message.groupId) }
          }
          await Promise.all(submitted.requests.map((request) => request.deliveryRecorded))
          let decision = submitted.decision
          let decisionRequests = submitted.requests.filter((request) => request.kind === 'message')
          const groupBeforeDecision = store.getGroup(message.groupId)
          const previousMessage = groupBeforeDecision?.messages.find((item) => item.sequence === accepted.sequence - 1)
          const activeTaskCount = store.listTasks().filter((task) => task.groupId === message.groupId).length
          if ('reason' in decision && shouldRecheckTaskAssociation({ activeTaskCount, hasImage: submitted.requests.some((request) => request.imageRefs.length > 0), previousMessage, occurredAt: message.occurredAt })) {
            const recheckReplyReviewCandidates = replyReviewCandidatesFor(message.groupId, decisionRequests.map((request) => request.message))
            const recheck = createPendingGroupDecision({ groupId: message.groupId, messageId: message.messageId, sequence: accepted.sequence, message, imageRefs, replyReviewCandidates: recheckReplyReviewCandidates, kind: 'recheck', baseRequests: decisionRequests })
            handle.agent.steer(createUserMessage({ content: [{ type: 'text', text: `[GROUP_DECISION_RECHECK]\n判断请求 ID：${recheck.requestId}\n关联复核：你刚才选择了 ignore。请重新对照“本群全部任务关联索引”和紧邻消息判断。图片、图片后的短说明，以及群友提出的未经核验根因/状态判断，都可能是已有任务需要核验的新增线索；相关时必须返回 task-context。只有确认与全部历史及当前任务无关且不存在消息冲突时才能 ignore。\n\n${buildDecisionPrompt({ messageId: message.messageId, message: message.text, senderName: message.senderName, senderOpenDingTalkId: message.senderOpenDingTalkId, occurredAt: message.occurredAt, quotedMessage: message.quotedMessage, mediaUnavailable: message.mediaUnavailable, replyReviewCandidates: recheckReplyReviewCandidates }).replace(/^\[GROUP_DECISION\]\n\n/u, '')}` }], source: { kind: 'coordinator' } }))
            ensurePendingGroupDecisionSettlement(handle.agent, message.groupId)
            recheckedSubmission = await recheck.promise
            await Promise.all(recheckedSubmission.requests.map((request) => request.deliveryRecorded))
            decision = recheckedSubmission.decision
            decisionRequests = [...new Map([...decisionRequests, ...recheckedSubmission.requests.filter((request) => request.kind === 'message')]
              .map((request) => [request.messageId, request])).values()].sort((left, right) => left.sequence - right.sequence)
          }
          const decisionMessages = decisionRequests.map((request) => request.message)
          const unavailableMedia = decisionMessages.flatMap((item) => Array.isArray(item.mediaUnavailable) ? item.mediaUnavailable : [])
          decision = blockTaskDecisionForUnavailableMedia(decision, unavailableMedia)
          if (recheckedSubmission !== undefined) submitted.decision = decision
          const result = await serialize(message.groupId, async () => {
            const groupAtCommit = store.getGroup(message.groupId)
            if ('reason' in decision) {
              await Promise.all(decisionRequests.map((request) => store.markMessageAgentDelivery({ groupId: message.groupId, messageId: request.messageId, status: 'delivered' })))
              return { ...accepted, decision, group: store.getGroup(message.groupId) }
            }
            const tasks = []
            for (const action of decision.actions) {
              const sourceMessageIds = action.sourceMessageIds
              if (new Set(sourceMessageIds).size !== sourceMessageIds.length) throw new Error('task_action_source_message_duplicate')
              const sourceMessageIdSet = new Set(sourceMessageIds)
              const sourceMessages = (groupAtCommit?.messages ?? []).filter((source) => sourceMessageIdSet.has(source.messageId))
              if (sourceMessages.length !== sourceMessageIds.length) throw new Error('task_action_source_message_invalid')
              const currentSource = [...sourceMessages].reverse().find((source) => source.senderName && source.senderOpenDingTalkId) ?? sourceMessages.at(-1)
              const trigger = { sourceMessageId: currentSource.messageId, ...(currentSource.senderName ? { requesterName: currentSource.senderName } : {}), ...(currentSource.senderOpenDingTalkId ? { requesterOpenDingTalkId: currentSource.senderOpenDingTalkId } : {}), ...(currentSource.occurredAt !== undefined ? { occurredAt: currentSource.occurredAt } : {}) }
              const sourceEnvelope = sourceMessages.map((source) => buildLeafSourceEnvelope({ messageId: source.messageId, message: source.text, senderName: source.senderName, senderOpenDingTalkId: source.senderOpenDingTalkId, occurredAt: source.occurredAt, quotedMessage: source.quotedMessage, mediaUnavailable: source.mediaUnavailable })).join('\n\n')
              let task
              if (action.kind === 'new-task') task = await serializeTasks(async () => { const result = await store.createTask({ groupId: message.groupId, sourceMessageId: currentSource.messageId, sourceMessageIds: sourceMessages.map((source) => source.messageId), title: action.title, objective: action.objective, requesterName: currentSource.senderName, requesterOpenDingTalkId: currentSource.senderOpenDingTalkId, occurredAt: currentSource.occurredAt, acceptanceCriteria: action.acceptanceCriteria, stageTasks: action.stageTasks, relatedContexts: [sourceEnvelope] }); await pumpTasks(); return store.getTask(result.task.taskId) })
              else if (action.kind === 'task-context') {
                task = store.getTask(action.taskId)
                if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_context_target_invalid:${action.taskId}`)
                task = await serializeTasks(() => appendTaskContextInternal(task, sourceEnvelope, trigger, action.objective, action.acceptanceCriteria, action.stageTasks, sourceMessages))
              } else if (action.kind === 'task-reopen') {
                task = store.getTask(action.taskId)
                if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_reopen_target_invalid:${action.taskId}`)
                task = await serializeTasks(() => reopenCompletedTaskInternal(task, sourceEnvelope, trigger, action.objective, action.acceptanceCriteria, action.stageTasks, sourceMessages))
              } else if (action.kind === 'task-cancel') {
                task = store.getTask(action.taskId)
                if (task === undefined || task.groupId !== message.groupId) throw new Error(`task_cancel_target_invalid:${action.taskId}`)
                if (task.state === 'completed') throw new Error(`task_not_active:${action.taskId}`)
                const reason = action.reason.trim()
                if (reason === '') throw new Error('task_cancel_reason_required')
                signalTaskCancellation(task.taskId)
                task = await serializeTasks(() => cancelTaskInternal(task.taskId, reason, sourceMessages))
              }
              if (task !== undefined) tasks.push(task)
            }
            let group
            if (!('reply' in decision) || decision.reply.trim() === '') group = store.getGroup(message.groupId)
            else {
              const replyTarget = decisionRequests.findLast((request) => typeof request.messageId === 'string'
                && request.messageId.trim() !== ''
                && typeof request.message?.senderOpenDingTalkId === 'string'
                && request.message.senderOpenDingTalkId.trim() !== '')
              group = await appendReliableOutbox({
                groupId: message.groupId, sourceMessageId: message.messageId, text: decision.reply,
                replyKind: decision.replyReview?.kind,
                matterSourceMessageIds: decisionRequests.map((request) => request.messageId),
                taskIds: [...new Set(tasks.map((task) => task.taskId))],
                replacesOutboundIds: decision.replyReview?.replaceOutboundIds,
                ...(replyTarget === undefined ? {} : {
                  replyToMessageId: replyTarget.messageId,
                  replyToSenderOpenDingTalkId: replyTarget.message.senderOpenDingTalkId,
                  atOpenDingTalkIds: [replyTarget.message.senderOpenDingTalkId],
                }),
                onPersisted: () => {
                  submitted.resolveReplyLinearized()
                  recheckedSubmission?.resolveReplyLinearized()
                },
              })
            }
            await Promise.all(decisionRequests.map((request) => store.markMessageAgentDelivery({ groupId: message.groupId, messageId: request.messageId, status: 'delivered' })))
            return { ...accepted, decision, group, tasks, ...(tasks.length === 1 ? { task: tasks[0] } : {}) }
          })
          submitted.resolveCommitted()
          recheckedSubmission?.resolveCommitted()
          return result
        } catch (error) {
          pending?.rejectDeliveryRecorded(error)
          if (pending !== undefined && submitted === undefined) {
            if (pendingGroupDecisions.has(pending.requestId)) rejectPendingGroupDecision(pending.requestId, error)
            else {
              try { submitted = await pending.promise } catch {}
            }
          }
          submitted?.rejectReplyLinearized(error)
          recheckedSubmission?.rejectReplyLinearized(error)
          submitted?.rejectCommitted(error)
          recheckedSubmission?.rejectCommitted(error)
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
    retryDecisionFailedMessage({ groupId, messageId }) {
      const message = store.getGroup(groupId)?.messages.find((item) => item.messageId === messageId)
      if (message === undefined) throw new Error(`message_not_found:${messageId}`)
      return this.ingest({ ...message, groupId }, { retryDecisionFailed: true })
    },
    async recoverInterruptedDecisions() {
      const interrupted = store.listGroups().flatMap((group) => (group.messages ?? [])
        .filter((message) => message.agentDeliveryStatus === 'steered')
        .map((message) => ({ groupId: group.groupId, messageId: message.messageId })))
      const results = []
      for (const message of interrupted) {
        await store.markMessageAgentDelivery({ ...message, status: 'decision-failed', error: 'resident_restarted_before_decision_settled' })
        results.push({ ...message, status: 'recovered' })
      }
      return results
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
      const persistedSource = sourceMessageId ? store.getGroup(task.groupId)?.messages?.find((message) => message.messageId === sourceMessageId) : undefined
      const sourceMessages = !sourceMessageId || isSyntheticTaskSource(sourceMessageId) ? [] : [persistedSource ?? { messageId: sourceMessageId, text: context, ...(requesterName ? { senderName: requesterName } : {}), ...(requesterOpenDingTalkId ? { senderOpenDingTalkId: requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) }]
      return appendTaskContextInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks, sourceMessages)
    }),
    reopenTask: ({ taskId, context, objective, acceptanceCriteria, stageTasks, sourceMessageId, requesterName, requesterOpenDingTalkId, occurredAt }) => serializeTasks(async () => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      const effectiveSourceMessageId = sourceMessageId ?? `web-reopen:${createHash('sha256').update(`${taskId}\n${context}\n${objective ?? task.objective}`).digest('hex')}`
      const trigger = { sourceMessageId: effectiveSourceMessageId, ...(requesterName ? { requesterName } : {}), ...(requesterOpenDingTalkId ? { requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) }
      const persistedSource = sourceMessageId ? store.getGroup(task.groupId)?.messages?.find((message) => message.messageId === sourceMessageId) : undefined
      const sourceMessages = !sourceMessageId || isSyntheticTaskSource(sourceMessageId) ? [] : [persistedSource ?? { messageId: sourceMessageId, text: context, ...(requesterName ? { senderName: requesterName } : {}), ...(requesterOpenDingTalkId ? { senderOpenDingTalkId: requesterOpenDingTalkId } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}) }]
      return reopenCompletedTaskInternal(task, context, trigger, objective, acceptanceCriteria, stageTasks, sourceMessages)
    }),
    reconcileCompletedNotifications: async () => {
      const pending = await serializeTasks(async () => {
        const items = []
        for (const task of store.listTasks().filter((item) => item.state === 'completed' && item.result?.status === 'completed')) {
          let current = task
          if ((current.completionSequence ?? 0) === 0 && current.lastCompletedResult?.status === 'completed') current = await store.updateTask(current.taskId, (item) => ({ ...item, completionSequence: 1 }))
          const resultKey = taskResultOutboxKey(current, current.result)
          const group = store.getGroup(current.groupId)
          if (group !== undefined && !group.outbox.some((item) => item.sourceMessageId === resultKey)) items.push({ task: current, resultKey })
        }
        return items
      })
      const repaired = [], failures = []
      for (const item of pending) {
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
      }
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
    cancelTask: async ({ taskId, reason }) => {
      const task = store.getTask(taskId)
      if (task === undefined) throw new Error(`task_not_found:${taskId}`)
      if (task.state === 'completed') throw new Error(`task_not_active:${taskId}`)
      const normalizedReason = typeof reason === 'string' ? reason.trim() : ''
      if (normalizedReason === '') throw new Error('task_cancel_reason_required')
      signalTaskCancellation(taskId)
      return serializeTasks(() => cancelTaskInternal(taskId, normalizedReason))
    },
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
    subscribe: ({ groupId, name, responsibility = '' }) => serializeConfig(() => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      return serialize(groupId, async () => {
        const existing = store.getGroup(groupId); if (existing !== undefined) return { created: false, group: existing }
        const sessionId = residentSessionId(groupId), { handle } = await createResident(groupId, { sessionId: SessionId(sessionId), meta: { cwd: agentWorkspace, agentPreset }, agentOptions, setup: residentSetup(groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
        applyFullAccess(handle)
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
      taskExecutionGuidance: store.getTaskExecutionGuidance?.() ?? '', taskEvidenceGuidance: store.getTaskEvidenceGuidance?.() ?? '', maxConcurrentTasks: taskConcurrencyLimit,
    }),
    updateAgentConfig: ({ agentNames, workspaceDir, model, reasoningEffort, proxyUrl, taskExecutionGuidance, taskEvidenceGuidance, maxConcurrentTasks: nextMaxConcurrentTasksInput }) => serializeConfig(async () => {
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
      const nextTaskExecutionGuidance = taskExecutionGuidance === undefined ? (store.getTaskExecutionGuidance?.() ?? '') : taskExecutionGuidance.trim()
      const nextTaskEvidenceGuidance = taskEvidenceGuidance === undefined ? (store.getTaskEvidenceGuidance?.() ?? '') : taskEvidenceGuidance.trim()
      const guidanceChanged = nextTaskExecutionGuidance !== (store.getTaskExecutionGuidance?.() ?? '') || nextTaskEvidenceGuidance !== (store.getTaskEvidenceGuidance?.() ?? '')
      const nextMaxConcurrentTasks = nextMaxConcurrentTasksInput === undefined ? taskConcurrencyLimit : nextMaxConcurrentTasksInput
      if (!Number.isInteger(nextMaxConcurrentTasks) || nextMaxConcurrentTasks < 1 || nextMaxConcurrentTasks > 50) throw new Error('agent_max_concurrent_tasks_invalid')
      const concurrencyChanged = nextMaxConcurrentTasks !== taskConcurrencyLimit
      const resultConfig = () => ({ agentNames: store.getAgentNames?.() ?? [], workspaceDir: agentWorkspace, ...selection, proxyUrl: nextProxyUrl, taskExecutionGuidance: store.getTaskExecutionGuidance?.() ?? '', taskEvidenceGuidance: store.getTaskEvidenceGuidance?.() ?? '', maxConcurrentTasks: taskConcurrencyLimit })
      if (!workspaceChanged && !selectionChanged && !proxyChanged && !guidanceChanged && !namesChanged && !concurrencyChanged) return resultConfig()
      if (workspaceChanged || selectionChanged) await serializeTasks(() => {
        if (store.listTasks().some((task) => task.state === 'running' || task.state === 'waiting' || task.state === 'queued')) throw new Error('agent_config_has_active_tasks')
      })
      const groups = workspaceChanged ? store.listGroups() : []
      const releaseResidentTransitions = groups.map((group) => holdGroupResidentTransition(group.groupId))
      const releaseAdmissions = groups.flatMap((group) => holdGroupReplyAdmission(group.groupId, 1))
      const replacements = []
      try {
        if (workspaceChanged) {
          for (const group of groups) {
            await waitForActiveGroupResidentOperations(group.groupId)
            const previous = residentHandles.get(group.groupId)
            if (previous === undefined) throw new Error(`resident_not_active:${group.groupId}`)
            await previous.agent.whenIdle()
            await waitForActiveGroupSubmissions(group.groupId)
            const seed = [...previous.agent.session.events]
            const sessionId = `${residentSessionId(group.groupId)}-${randomUUID().slice(0, 8)}`
            const { handle } = await createResident(group.groupId, { sessionId: SessionId(sessionId), seed, meta: { cwd: nextWorkspace, agentPreset, seedLength: seed.length }, agentOptions, setup: residentSetup(group.groupId), signal: AbortSignal.timeout(resumeTimeoutMs) })
            applyFullAccess(handle)
            replacements.push({ group, previous, handle, sessionId })
          }
        }
        const result = await serializeTasks(async () => {
          if ((workspaceChanged || selectionChanged) && store.listTasks().some((task) => task.state === 'running' || task.state === 'waiting' || task.state === 'queued')) throw new Error('agent_config_has_active_tasks')
          if (selectionChanged) await ctx.agentDefaultModel.saveSelection(nextSelection)
          if (proxyChanged) await store.setProxyUrl(nextProxyUrl)
          if (namesChanged) await store.setAgentNames(nextAgentNames)
          if (guidanceChanged) await store.setTaskGuidance({ taskExecutionGuidance: nextTaskExecutionGuidance, taskEvidenceGuidance: nextTaskEvidenceGuidance })
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
        return result
      } catch (error) {
        if (!workspaceChanged || agentWorkspace !== nextWorkspace) await Promise.all(replacements.map((item) => item.handle.dispose()))
        throw error
      } finally {
        for (const release of releaseAdmissions) release()
        for (const release of releaseResidentTransitions) release()
      }
    }),
    unsubscribe: ({ groupId }) => serializeConfig(async () => {
      if (runtimeClosing) throw new Error('resident_runtime_closed')
      if (store.listTasks().some((task) => task.groupId === groupId && (task.state === 'running' || task.state === 'waiting' || task.state === 'queued'))) throw new Error(`group_has_active_tasks:${groupId}`)
      const handle = residentHandles.get(groupId)
      const releaseResidentTransition = holdGroupResidentTransition(groupId)
      const [releaseAdmission] = holdGroupReplyAdmission(groupId, 1)
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
        releaseAdmission()
        releaseResidentTransition()
      }
    }),
    setCurrentDwsUserName: (value) => { currentDwsUserName = typeof value === 'string' ? value.trim() : '' },
    setCurrentDwsProfile: (value) => { currentDwsProfile = typeof value === 'string' ? value.trim() : '' },
    async close() {
      if (closePromise !== undefined) return closePromise
      runtimeClosing = true
      if (supervisorTimer !== undefined) clearInterval(supervisorTimer)
      if (typeof disposeObserver === 'function') disposeObserver()
      const closingError = new Error('resident_runtime_closed')
      for (const requestId of [...pendingGroupDecisions.keys()]) rejectPendingGroupDecision(requestId, closingError)
      for (const requestId of [...pendingGroupReplies.keys()]) rejectPendingGroupReply(requestId, closingError)
      for (const barrier of groupReplyAdmissionBarriers.values()) barrier.resolve()
      groupReplyAdmissionBarriers.clear()
      for (const submission of activeGroupSubmissions) {
        for (const request of submission.requests) request.rejectDeliveryRecorded(closingError)
      }
      closePromise = serializeConfig(async () => {
        await waitForAllResidentOperations()
        await Promise.allSettled([...inflightMessages.values()])
        await Promise.allSettled([...activeGroupReplies].map((reply) => reply.replyLinearized))
        const all = [...leafHandles.values(), ...residentHandles.values()]
        await ctx.subagents.drainContinuableDescendants(all.map((handle) => handle.agent))
        await Promise.all(all.map((handle) => handle.dispose()))
        await Promise.allSettled([...pendingLeafDisposals])
        leafHandles.clear(); residentHandles.clear(); leafTaskBySession.clear(); await activityTail; await store.close()
      })
      return closePromise
    },
  }
}
