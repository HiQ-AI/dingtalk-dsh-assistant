import { randomUUID } from 'node:crypto'
import { fingerprint, topicDecisionRecovery } from './topic-model.js'
import { createTopicCoordinator } from './topic-runtime.js'
import { createCoordinationSessions, createCoordinationStepGate, coordinationTools } from './coordination-sessions.js'
import { createCoordinationResourceTools } from './coordination-resources.js'
import { buildReplyReviewCandidates } from './decision.js'
import { sessionWorkspace, nameSession } from './session-workspaces.js'
import { groupReplyInstructions } from './group-message.js'
import { createFixedTopicHandler } from './fixed-topic-handler.js'
import { taskBoundaryInstructions } from './task-boundary-instructions.js'

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const sameStringSet = (a, b) => a.length === b.length && a.every(value => b.includes(value))
const taskContinuationInstructions = '先判断当前交付属于哪个 Task，再选择动作。完成表示已交付，不证明用户认可。收到明确关联原交付的具体异议、遗漏指出或纠正时，结合引用和原需求判断是否需要核查或修订；不能仅因没有“请修改”或Task已完成就当纯情绪忽略。确需处理时沿已有原任务接纳，范围限于该异议，不自动开发、重发文件或重放业务操作；纯评价且没有可核实问题或处理诉求时保留话题事实，不一律重开，也不新增统一审批。旧任务完成后的核查、审查修订、返工和重新提测是原交付的增量：completed 用 task-reopen，未完成用 task-context 并明确 progressImpact；保留原 Task、会话和有效证据，只追加新要求，不重放已成功步骤。涉及“已完成的项目”“逐个检查”等批量跟进时，路由和决策都先用 group_task_list 查候选，hasMore=true 按 nextOffset 续读，用 group_task_context_get 逐项核对必要详情、原交付及当前 inputVersion/runSequence，不能把目录摘要当完整正文。未列具体编号、跨多个事项或需要先核查条件，不构成新建总执行任务的理由；将各自范围交回原 Owner，先核验条件，无新评论或已不适用则如实结束，不重复修改或提测。一个 decision.actions 可以分别对多个原 Task 提交动作，每个 taskId 仅一次；唯一 effectOwner 约束事项由哪个 Topic 发起动作，不限制只能操作一个 Task。单事项沿原 Topic；批量事项即使由新协调 Topic 承接，也应操作已查明的原 Task，不能由新 Topic 推导 new-task。仅引用旧资料的独立新交付、查无对应原任务或用户明确要求另建任务时，才选择 new-task；不要将无关任务重开。'

export function taskIndexPage(tasks, offset, limit, query = '') {
  const entries = tasks.map(({ taskId, title, state, inputVersion, runSequence, topicRefs, objective, completion, result }) => ({
    taskId, title, state, inputVersion, runSequence, topicRefs,
    objectivePreview: (objective ?? '').slice(0, 400), resultPreview: (completion?.result?.summary ?? result?.summary ?? '').slice(0, 600) }))
  const snapshotFingerprint = fingerprint(entries)
  const page = []
  const output = () => {
    const nextOffset = offset + page.length, hasMore = nextOffset < tasks.length
    return { tasks: page, total: tasks.length, query, snapshotFingerprint, offset, limit, nextOffset, hasMore,
      nextCall: hasMore ? { name: 'group_task_list', arguments: { query, offset: nextOffset, limit } } : null }
  }
  for (const task of entries.slice(offset, offset + limit)) {
    page.push(task)
    if (Buffer.byteLength(JSON.stringify(output()), 'utf8') <= 12 * 1024) continue
    page.pop()
    if (!page.length) throw new Error('group_task_index_entry_too_large')
    break
  }
  return output()
}

// Topic owns routing and decision receipts; this adapter only supplies native request sessions.
export async function openTaskTopicCoordinator({ ctx, store, legacy, root, models, applyAction, appendOutbox, readFrozenReply, readPlatformTasks, readArchivedTask, readMentioned, validateReply, quotedReminderContext, taskFacts, onRouted = async () => {}, onInputSettled, onStage = async () => {}, onError = () => {} }) {
  const fixedTopics = readPlatformTasks ? createFixedTopicHandler({ ctx, store, legacy, root, models, appendOutbox, readTasks: readPlatformTasks, readMentioned, onSettled: groupId => onInputSettled?.(groupId), onError }) : null
  // The original Topic protocol is retained, but retired workflow prompt catalogs
  // must not leak back into the generic task-session boundary.
  store = new Proxy(store, { get(target, key) {
    if (key === 'acceptTopicDecision' && validateReply) return async args => {
      if (args.decision.reply?.trim()) await validateReply(args)
      return target.acceptTopicDecision(args)
    }
    if (key === 'routeMessages') return async args => {
      if (args.routes.some(route => route.units?.some(unit => unit.dispatchOwner === 'coordination'))
        && !target.getGroup(args.groupId)?.routeHistory.some(record => record.routeId === args.routeId)) throw new Error('coordination_ingress_disabled')
      const request = { groupId: args.groupId, messages: args.routes }
      const stage = target.getGroup(args.groupId)?.routeHistory.some(record => record.routeId === args.routeId) ? null
        : { spanId: `host:route:${args.routeId}:${randomUUID()}`, stage: 'host', requestId: args.routeId, attempt: 0,
          startedAt: new Date().toISOString(), completedAt: null }
      if (stage) await onStage(request, stage)
      try {
        const result = await target.routeMessages(args)
        await onRouted(args.groupId, args.routes.map(route => route.messageId))
        fixedTopics?.schedule(args.groupId)
        return result
      } finally { if (stage) await onStage(request, { ...stage, completedAt: new Date().toISOString() }) }
    }
    return key === 'getTaskPrompts' ? () => [] : key === 'listTasks' ? () => target.listTasks().filter(task => !task.archivedAt) : Reflect.get(target, key)
  } })
  let closed = false, topics, serial = Promise.resolve()
  const handles = new Set(), dispatches = new Set()
  const report = (groupId, error) => onError(groupId, error)
  const serializeTasks = operation => {
    const result = serial.then(operation)
    serial = result.catch(() => {})
    return result
  }
  const presence = Object.freeze({})
  const sessions = createCoordinationSessions({ eventPrefix: null, onStage,
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
          agentCtx.tools.register({ name: 'group_task_list', description: '分页查询当前群未归档任务的最新轻量目录，包含已完成任务；目标和结果仅为摘要，完整正文用 group_task_context_get。同一请求当前可见的已读目录可直接复用，不重复从offset=0读取；hasMore=true 时直接使用nextCall，保留query和limit，不用请求的limit推算偏移。改变query须从offset=0查询；snapshotFingerprint变化表示当前目录已变化，需重新核对关联。',
            parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false }, output,
            execute: ({ query = '', offset = 0, limit = 50 }, exec) => {
              assert(exec)
              if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('group_task_page_invalid')
              const needle = query.trim().toLowerCase()
              const tasks = store.listTasks().filter(task => task.groupId === request.groupId && (!needle || `${task.title ?? ''} ${task.objective ?? ''}`.toLowerCase().includes(needle)))
              return taskIndexPage(tasks, offset, limit, needle)
            } })
          agentCtx.tools.register({ name: 'group_task_context_get', description: '读取当前群任务的完整关联上下文；已归档任务仅返回身份、状态和空 allowedActions，不恢复或执行。',
            parameters: { type: 'object', properties: { taskIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1 } } }, required: ['taskIds'], additionalProperties: false }, output,
            execute: async (args, exec) => {
              assert(exec)
              const taskIds = args?.taskIds
              if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'taskIds') || !Array.isArray(taskIds) || !taskIds.length || taskIds.length > 8 || taskIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(taskIds).size !== taskIds.length)
                return { status: 'invalid-arguments', issues: [{ field: 'taskIds', code: 'group_task_context_request_invalid', message: 'taskIds must contain 1 to 8 distinct nonempty strings' }], nextAction: 'correct-arguments' }
              return { tasks: await Promise.all(taskIds.map(async id => {
                const task = store.getTask(id) ?? await readArchivedTask?.(id)
                if (!task) throw new Error(`group_task_context_not_found:${id}`)
                if (task.groupId !== request.groupId) throw new Error(`group_task_context_wrong_group:${id}`)
                if (task.archivedAt) return { taskId: task.taskId, groupId: task.groupId, title: task.title, state: task.state, archivedAt: task.archivedAt, allowedActions: [] }
                return task
              })) }
            } })
          for (const tool of createCoordinationResourceTools({ request, assertCurrent: assert,
            readMessage: legacy.readGroupMessage?.bind(legacy) ?? legacy.readMessage?.bind(legacy), readResource: legacy.readGroupResource?.bind(legacy) ?? legacy.readResource?.bind(legacy), readImage: legacy.readImage?.bind(legacy),
          })) agentCtx.tools.register(tool)
          agentCtx.on('agent/pre-step', createCoordinationStepGate(entry, request => topics.isCurrentRequest(request)))
          const allowed = new Set(coordinationTools(role))
          agentCtx.tools.restrict({ allow: [...allowed].filter(name => agentCtx.tools.get(name)) })
          agentCtx.tools.guard(execution => allowed.has(execution.name) ? undefined : 'coordination_tool_outside_role')
          agentCtx.systemPrompt.section({ name: 'dingtalk-group-reply', order: 119, text: groupReplyInstructions })
          agentCtx.systemPrompt.section({ name: 'dingtalk-reply-ownership', order: 130, text:
            request.trigger === 'task-facts'
              ? '本轮由已绑定Topic处理任务事实。只判断回复或沉默并更新摘要，不能调用任务动作、路由或把事实当新需求。默认输入是有界摘要和证据引用；只有影响决定的缺口才补读。无需重新总结执行会话，不复述内部标识或逐条日志。'
              : '接收与回复使用同一种Topic。跨Topic消息路由时，在route.replyTopic中从本条topics选一个现有/本批业务Topic负责整体回复，不新建回复专用Topic。Decision输入replyOwnership明确谁回复：其他Topic可执行本事项任务动作，使用reason说明由指定Topic统一回复，不各自发送确认。回复Topic结合整条原文说明本次接纳的事项及真实处理进度，不把其他Topic未处理说成已经执行；后续实质结果仍可回复。' })
          agentCtx.systemPrompt.section({ name: 'dingtalk-task-continuation', order: 121, text: `${taskContinuationInstructions}\n同一请求当前上下文中已读的Task目录可直接复用，不重复读同一查询第一页。group_task_list返回query、snapshotFingerprint和nextCall；续页照用nextCall，改变query从offset=0重新查询，当前目录指纹变化后重新核对。目录和本轮linkedTasks.snapshots均只有有界状态摘要；提交已有任务动作前，按group_task_context_get核对完整目标、授权和版本，不能把摘要当作完整任务合同。group_reply_review_get在固定决策/审阅会话中由Host绑定本请求，{}即可读取，不能填写别的requestIds。${role === 'decision' ? '本决策会话group_topic_context_get可用{}读取Host绑定的当前固定版本。' : '当前会话没有唯一当前Topic；候选摘要足以排除不同业务目标时直接路由，不因关键词相近强读历史。确需历史时原样复制候选readCall.arguments，不得传空参数，不从标题猜topicId。'}` })
          agentCtx.systemPrompt.section({ name: 'dingtalk-task-boundary', order: 123, text: taskBoundaryInstructions })
          if (role === 'decision') agentCtx.systemPrompt.section({ name: 'dingtalk-linked-task-context', order: 124,
            text: '输入linkedTasks只包含Host在本轮话题版本创建时重新读取的本群关联任务状态摘要，不沿用旧会话审批。snapshots含有界标题、状态、版本和结果摘要，不含完整目标或执行正文；需要对已有任务采取动作时按reads中的readCall核对完整上下文。hasMore=true或业务目标指向其他任务时再查询目录；输入未含linkedTasks时使用原查询工具。replyOwnership指定每条来源的回复归属：混合批次推进全部本Topic事项，只确认由本Topic负责回复的来源，其他来源由其replyTopic统一答复。提交前仍由Host校验当前来源、Topic和Task版本；新消息与新授权必须重新判断。' })
          agentCtx.systemPrompt.section({ name: 'dingtalk-task-progress-query', order: 124,
            text: '普通进度询问只读取原任务当前事实并一次答复，不能作为任务补充、恢复、重开、依赖或持续观察；提到多个任务不等于批量执行授权。单项在原Topic用actions:[]和reply回答；涉及多个任务时在对应Topic读取相关任务状态后答复，不创建持续观察任务。明确催办或追加要求才按原文范围选择任务动作，不能仅因问“修复了没”而唤醒Owner。' })
          agentCtx.systemPrompt.section({ name: 'dingtalk-running-input', order: 119,
            text: 'task-context 必须显式填写progressImpact：preserve声明目标、授权、验收和既有证据有效性不变，适用于明确要求推进的提醒、定位信息和事实澄清；仅询问进度不属于任务补充；不要重复附带objective/acceptanceCriteria/stageTasks。replan声明真实目标、验收或证据变化，须根据原文补判，不能因字段遗漏或无法判断就默认replan。收回或改变授权必须authorizationChange=changed并使用replan；明确取消用task-cancel独立路径。缺失分类或preserve与变更字段冲突会被拒绝，原执行保持；先读取来源补判，仍无法判定则不提交任务动作并说明缺口。Host会保留普通补充的原作业并在安全步骤送入；补充受理不代表已进入模型步骤。' })
          agentCtx.systemPrompt.section({ name: 'dingtalk-reply-recipient', order: 121, text: '回复由话题语义决定对象：有真人参与者的非空回复须用 replyToMessageId 选择固定话题内的目标消息，atOpenDingTalkIds 只填写需提醒的参与者，省略或空数组默认提醒目标作者。对本助手同事项回复对象的明确纠正不是业务转派；核对原回复与人员身份后，可用 actions:[] 和 reply 适当沟通，不因此取消或重建任务。身份不明先澄清，不猜测；无需每次纠正都另发消息。' })
          agentCtx.systemPrompt.section({ name: 'dingtalk-topic-coordination', order: 120, text: () => {
            const group = store.getGroup(request.groupId)
            return `当前仅处理 ${role} 请求 ${request.requestId}。群职责：${group?.responsibility ?? ''}。收到 [GROUP_TOPIC_ROUTE] 时结合整批原文和已有 Topic，通过 group_topic_route_submit 提交完整归属。归属表示同一讨论目标的延续或实质影响；读取旧资料不构成归属。独立事项可新建 Topic，同一事项追加已有 Topic，多话题归属必须指定唯一 effectOwner。无关噪声可无归属并说明原因。新 title 使用简短对象加事项，不超过30字。收到 [GROUP_TOPIC_DECISION] 后根据固定 Topic 版本及当前增量，通过 group_decision_submit 提交。每次决策通过 topicUpdate.summary 保存累计话题摘要，概括讨论对象、当前结论、范围和未决事项；纯讨论也要更新，不把任务已创建写成已完成。摘要缺失或不足以理解历史时，先用 group_topic_context_get 读取固定版本原文，不仅复述最新消息。basisMessageIds 必须包含当前增量原文。已有任务先读取 group_task_list/context；任务动作使用 topicRefs 和当前 inputVersion/runSequence。纯讨论可以 actions:[] 加 reason。routing-required 先完成路由；topic-stale/task-stale 读取当前版本重做判断。accepted 只表示意图持久接受，不表示完成或送达。仅处理原文真实授权，不能把同事间聊天变成交办。是否承接由 TopicDecision 结合需求原文、引用、已有任务及前后分工判断，不能只看当前一句。@、点名、cc: 和 personAliases 只提供参与者线索，不能单独证明交办或他人负责，也不能把最后一个 @ 当作事项负责人。先区分需求提出、通知同步、实际分工和明确转交；多人对话逐项核对谁提出什么要求、谁负责什么。上下文已明确交给本助手且属于本群职责、形成可验证目标时，按已有任务状态选择 task-context/task-reopen；查无对应任务才选择 new-task，不因当前只 @ 同事或省略助手称呼而重复索要确认。引用中出现助手名字也不自动授权另一个事项。只有结合上下文仍不能确定是否交办、没有明确其他负责人且确实需要助手承接时，才选择 task-proposal，询问“这个事项是否需要我处理？”，暂不创建任务；普通讨论或无行动目标不自动提议。topicUpdate.summary 记录承接或静默的判断及分工依据，basisMessageIds/basisUnitRefs 引用对应原文，保持可追溯。task-proposal 回复只询问是否交办，不承诺“我会处理”、已开始、已执行或已完成；new-task 的接收确认也不表示执行完成。消息明确 @其他同事或正文点名时，结合原文、引用、personAliases 和任务上下文区分实际负责人、通知收件人、引用信息与同时向本助手求助。话题归属与助手动作分开判断。职责内业务消息即使明确其他人负责、来自其他助手通知或只在引用同事信息，仍保留对应业务 Topic 的完整上下文，不以缺少本助手 Task 为由剥离。不能只因 @ 别人就硬过滤，本助手已有任务的新事实仍归原业务 Topic；明确他人负责且未要求本助手参与，或明确纠正本助手误介入（如“没你的事”“不是找你”）时，用 actions:[]、reason 和 topicUpdate.summary 记录事实，省略 reply，不创建 task-proposal/new-task、不唤醒已有任务、不追问、不主动回答。他人处理进展只作为其报告的业务事实，不能自动作为本助手任务完成证据。同时向本助手提出的诉求仍按原文处理，只有确实超出本群职责才归职责外话题。只有明确转交或新授权才可改变本助手任务范围，信息补充本身不授权重做。personAliases 是已确认的本群人员身份，不是助手别名；仅提到人名不等于指定负责人，不按相似字或昵称推断交办。当前 Agent 名称/别名：${JSON.stringify(store.getAgentNames?.() ?? [])}。任务目标忠实保留原请求动作范围，不把诊断/观察扩写成修复、实施、发布，不追加未经授权的业务验收。附件只沿本请求明确引用，通过 group_message_get/group_resource_get 读取；读取失败须保留限制，不能猜测正文。`
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
  const turns = new Map()
  let timingTail = Promise.resolve()
  const stopTiming = ctx.on?.('session/event', (session, event) => {
    if (!['turn/start', 'turn/end'].includes(event.type)) return
    const entry = sessions.identity({ session })
    if (!entry) return
    const key = String(session.id)
    if (event.type === 'turn/start') turns.set(key, { spanId: `turn:${key}:${event.seq}`, stage: 'turn',
      requestId: entry.request.requestId, sessionId: key, attempt: entry.request.attempt ?? 0,
      startedAt: new Date(event.time).toISOString(), completedAt: null })
    const stage = turns.get(key)
    if (!stage) return
    const value = { ...stage, ...(event.type === 'turn/end' ? { completedAt: new Date(event.time).toISOString() } : {}) }
    timingTail = timingTail.then(() => onStage(entry.request, value)).catch(error => report(entry.request.groupId, error))
    if (event.type === 'turn/end') turns.delete(key)
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
  topics = createTopicCoordinator({ store, workflowPromptsEnabled: false, fixedTopicsEnabled: !!fixedTopics, quotedReminderContext, onInputSettled, taskFacts, readArchivedTask, readFrozenReply,
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
    checkStartupRecovery: async () => {
      const presets = ctx.get('agentPresets')
      if (!presets?.resolve) return false
      const preset = await presets.resolve(legacy.getAgentConfig().agentPreset)
      return !preset.broken
    },
    validateReplyReview, cancelTask: () => {}, onError: report, isClosing: () => closed,
  })
  return {
    schedule: async groupId => { const result = await topics.schedule(groupId); fixedTopics?.schedule(groupId); return result }, applyAccepted: (...args) => topics.applyAccepted(...args), recover: async () => { const result = await topics.recover(); for (const group of store.listGroups()) fixedTopics?.schedule(group.groupId); return result },
    messageProcessingRequests: groupId => topics.messageProcessingRequests(groupId),
    retryMessageRequest: args => topics.retryMessageRequest(args),
    async retryMessageHost({ groupId, messageId, messageVersion, activeUnitRefs, requestId, token }) {
      const validate = () => {
        const group = store.getGroup(groupId), message = group?.messages.find(item => item.messageId === messageId)
        const topic = group?.topics.find(item => !item.mergedInto && item.decisions.some(record => record.decisionId === requestId))
        const record = topic?.decisions.find(item => item.decisionId === requestId)
        const keys = refs => refs.map(ref => JSON.stringify([ref.unitId, ref.unitRevision])).sort()
        if (!message || message.messageVersion !== messageVersion || !Array.isArray(activeUnitRefs)
          || JSON.stringify(keys(message.activeUnitRefs ?? [])) !== JSON.stringify(keys(activeUnitRefs))
          || !record || topic.revision !== record.revision || topic.processedRevision >= record.revision || topicDecisionRecovery(record)?.token !== token
          || !topic.entries.some(entry => entry.messageId === messageId && entry.messageVersion === messageVersion && entry.action === 'add'
            && entry.revision <= record.revision && activeUnitRefs.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision)
            && (!record.decision.basisUnitRefs?.length || record.decision.basisUnitRefs.some(ref => ref.unitId === entry.unitId && ref.unitRevision === entry.unitRevision)))) throw new Error('MESSAGE_RETRY_STALE')
        return { topic, record, recovery: topicDecisionRecovery(record) }
      }
      const { topic, record, recovery } = validate()
      await topics.retryOperation({ groupId, topicId: topic.topicId, decisionId: requestId, operationId: record.failureOperationId,
        resolution: recovery.resolution, reason: '显式恢复原消息已核验的失败操作', validateSnapshot: validate })
      return { status: 'attempted', requestId }
    },
    async retryMessage(groupId, messageId) {
      // 该错误发生在任务写入之前；显式重试仍复用原动作的版本与已应用证据门禁。
      for (const topic of store.getGroup(groupId)?.topics ?? []) for (const record of topic.decisions) {
        const recovery = topicDecisionRecovery(record)
        if (!recovery || !record.decision.basisMessageIds.includes(messageId)) continue
        await topics.retryOperation({ groupId, topicId: topic.topicId, decisionId: record.decisionId,
          operationId: record.failureOperationId, resolution: recovery.resolution, reason: '显式重试原消息：重新核验准入来源、原动作版本及原回复身份' })
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
      await fixedTopics?.whenIdle()
      await serial
      await timingTail
    },
    async close() { closed = true; await fixedTopics?.close(); await topics.close(); await sessions.close(); await serial; await timingTail; stopTiming?.() },
  }
}
