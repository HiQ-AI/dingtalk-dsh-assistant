import { executionDigest } from './execution-artifacts.js'
import { nameSession } from './session-workspaces.js'
import { sourceInterpretationInstructions } from './agent-work.js'
import { groupReplyInstructions, assertGroupReply } from './workflow-notifications.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const ownerExecutionInstructions = '你是这个Task持续负责推进与解决问题的执行负责人。阶段是可调用的受管操作，不是遇到失败就结束责任的固定路线。先判断失败是否影响用户目标；工具能力不足不是用户缺资料。currentExecution给出Host核验的当前恢复能力：repairable=true时，先用task_owner_read_artifact读诊断，再提交repairCurrentStage及原样repairBinding，summary写具体原因和改变后的做法，不能只写重试。resume-agent会带着该方向在原节点会话继续；domain修复按领域合同准备产物。reason=strategy-change-required表示同一输入和同一错误已恢复过，应结合原目标换可行路径或重规划未完成部分，不能改措辞原样重试。没有可用修复动作时诊断真实实现/依赖缺口，保留系统责任；只在确需业务选择、真实权限或人工批准时请求用户。重复无效候选只结束当前思考轮，退避后仍由你在同一会话修正；下轮先读此前拒绝，不再提交相同动作。审批与未知外部效果等待既有事件/对账，不换身份重发。无需为每次阅读、搜索或思考增加阶段；只安排实际需要的受管操作，最终完成仍逐项用真实证据验收。'

const IDENTITY_EVENT = 'dingtalk/task-owner-session'
const SUBMIT = 'task_owner_submit'
const fail = code => Object.assign(new Error(code), { code })
const notDrained = code => Object.assign(fail(code), { taskOwnerDrained: false })
const copy = value => structuredClone(value)
const ownerFileDeliveryInstructions = '若goal含fileDelivery，必须逐项完成其中files的角色、名称和格式，并核对当前requirementRevision。文件交付仍属于同一个业务Task。尚无产物时，先完成必要调查，再用task-general-capability阶段的capabilityStep指定write-task-file，input仅含{role,fileName,content}，按Host提供的scope.artifactFiles精确授权生成真实UTF-8文本；仅支持md/txt/sql/csv/json，最多64KiB。含capabilityStep时，本轮planChange.stages只能有一个阶段（appendStages同样只能一项）；已有计划的前序阶段必须全部成功，不得将写入或导入与发送放在同轮计划中。生成或导入成功并核验证据后，下一轮才追加群文件交付阶段，保留各阶段的gate。每件产物均需真实登记及读回证明，不用write-task-markdown的哈希名称代替指定文件。已成功阶段提供完整artifact描述符后，再安排task-group-file-delivery阶段；Host会从当前任务已核验阶段选择产物、绑定来源群与账号，Owner不得指定任意本地路径或改群。已有图片、Office、PDF等二进制可先用task-general-capability阶段的import-task-file登记，input严格含{role,fileName,relativePath}；relativePath必须在Host generalFileRead.root/readablePaths与当前scope.readableFiles的双重白名单内，文件名保留真实扩展名。Host只读来源后冻结大小和SHA256，不由Owner猜摘要或提供sourceRoot；登记回读后的artifactFiles才交发送阶段。这不是生成器：未有真实源文件时须用可用生成器产出或明确缺能力。二进制仅使用真实受信来源并已登记的artifactFiles，不能用文字换扩展名伪造，也不能编造artifactId；缺少真实生成或受信导入路径、或缺少登记证明时block并说明缺少哪件产物。产物已生成、发送ACK、文字通知和文件消息送达是不同事实；只有每个必交文件都取得精确消息及下载大小/SHA256核验，才能complete，正文报告不能替代附件。未知发送或部分送达先等待原效果对账，不重建交付阶段、不换身份重发；已发文件不因完成摘要失败再发。'

const stageSchema = { type: 'object', properties: {
  workflowId: { type: 'string' }, gate: { type: 'string', enum: ['none', 'confirmation'] },
  sourceCondition: { type: 'object', properties: {
    sourceKey: { type: 'string' }, sourceVersion: { type: 'integer' }, sourceQuote: { type: 'string' },
    objective: { type: 'string' }, requiredActorId: { type: 'string' },
  }, required: ['sourceKey', 'sourceVersion', 'sourceQuote', 'objective'], additionalProperties: false },
  capabilityStep: { type: 'object', properties: {
    capabilityId: { type: 'string' }, input: { type: 'object' }, expectedEvidence: { type: 'string' },
  }, required: ['capabilityId', 'input', 'expectedEvidence'], additionalProperties: false },
}, required: ['workflowId', 'gate'], additionalProperties: false }
const assessmentSchema = { type: 'object', properties: {
  itemId: { type: 'string' }, status: { type: 'string', enum: ['satisfied'] },
  evidenceRefs: { type: 'array', items: { type: 'string' } },
}, required: ['itemId', 'status', 'evidenceRefs'], additionalProperties: false }
const planChangeSchema = { type: 'object', properties: {
  kind: { type: 'string', enum: ['initialize', 'append', 'replaceSuffix'] },
  stages: { type: 'array', items: stageSchema }, affectedFrom: { type: 'integer' },
}, required: ['kind', 'stages'], additionalProperties: false }
export const ownerDecisionSchema = { type: 'object', properties: {
  action: { type: 'string', enum: ['advance', 'wait', 'complete', 'block', 'repairCurrentStage'] },
  repair: { type: 'object', properties: { stageId: { type: 'string' }, runId: { type: 'string' }, generation: { type: 'integer' }, runRevision: { type: 'integer' }, requirementRevision: { type: 'integer' } }, required: ['stageId', 'runId', 'generation', 'runRevision', 'requirementRevision'], additionalProperties: false },
  condition: { type: 'object', properties: {
    kind: { type: 'string', enum: ['business-input', 'approval', 'capability', 'permission', 'execution'] },
    missing: { type: 'string' }, responsibleParty: { type: 'string' }, resumeWhen: { type: 'string' },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  }, required: ['kind', 'missing', 'responsibleParty', 'resumeWhen', 'evidenceRefs'], additionalProperties: false },
  summary: { type: 'string' },
  evidenceRefs: { type: 'array', items: { type: 'string' } },
  appendStages: { type: 'array', items: stageSchema },
  planChange: planChangeSchema,
  assessments: { type: 'array', items: assessmentSchema },
}, required: ['action', 'summary', 'evidenceRefs'], additionalProperties: false }
assertSupportedJsonSchema(ownerDecisionSchema)

function assertBinding(binding) {
  if (!binding || typeof binding.taskId !== 'string' || !binding.taskId
    || typeof binding.sessionId !== 'string' || !binding.sessionId
    || typeof binding.turnId !== 'string' || !binding.turnId
    || !Number.isSafeInteger(binding.leaseEpoch) || binding.leaseEpoch < 1
    || !Number.isSafeInteger(binding.ownerEpoch) || binding.ownerEpoch < 1
    || typeof binding.sessionBound !== 'boolean') throw fail('TASK_OWNER_BINDING_INVALID')
}

function validateHistory(events, binding) {
  const identities = events.filter(event => event.type === IDENTITY_EVENT)
  if (identities.length !== 1 || identities[0].data?.version !== 1
    || identities[0].data.taskId !== binding.taskId
    || identities[0].data.sessionId !== binding.sessionId
    || identities[0].data.ownerEpoch !== binding.ownerEpoch) throw fail('TASK_OWNER_SESSION_IDENTITY_MISMATCH')
  const leases = [identities[0].data.creationLease, ...events.flatMap(event => event.type === 'user/message' ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : [])
    .filter(message => message.source?.kind === 'coordinator' && message.source.taskOwner?.sessionId === binding.sessionId)
    .map(message => message.source.taskOwner.leaseEpoch)]
  if (leases.some(lease => !Number.isSafeInteger(lease) || lease < 1 || lease >= binding.leaseEpoch))
    throw fail('TASK_OWNER_SESSION_LEASE_NOT_ADVANCED')
}

/** 原生会话只提出本任务的决定；计划、验收和外部效果由 Host 接纳。 */
export function createTaskOwnerSessions({ ctx, isCurrent, getWorkspaceDir }) {
  if (typeof isCurrent !== 'function') throw fail('TASK_OWNER_CURRENT_CHECK_REQUIRED')
  const entries = new Map()
  let closed = false

  async function current(entry) {
    if (closed || entry.cancelled) return false
    if (!await isCurrent(entry.binding)) { entry.stale = true; return false }
    return !closed && !entry.cancelled
  }

  async function drain(entry) {
    return entry.draining ??= (async () => {
      try {
        if (entry.handle) {
          await entry.handle.agent.whenIdle()
          try { await ctx.sessions.flush(entry.handle.agent.session) }
          finally { await entry.handle.dispose() }
        }
      } catch (cause) {
        entry.drainError = Object.assign(notDrained('TASK_OWNER_DRAIN_FAILED'), { cause })
        throw entry.drainError
      } finally {
        entry.drained.resolve()
      }
    })()
  }

  function rejectCandidate(entry, decision, code, feedback) {
    const { summary: _summary, ...operation } = decision ?? {}
    if (operation.condition) operation.condition = {
      kind: operation.condition.kind ?? null, evidenceRefs: operation.condition.evidenceRefs ?? [],
    }
    const identity = executionDigest([code, operation])
    if (entry.rejectedCandidates.has(identity)) { entry.submissionFailure = 'TASK_OWNER_REPEATED_INVALID_DECISION'; throw fail(entry.submissionFailure) }
    entry.rejectedCandidates.add(identity)
    entry.attempted = false
    return { received: false, feedback }
  }

  function setup(entry, onCandidate, readPage, readArtifact) {
    const submissionSchema = copy(ownerDecisionSchema)
    if (!entry.repairBinding) {
      submissionSchema.properties.action.enum = submissionSchema.properties.action.enum.filter(action => action !== 'repairCurrentStage')
      delete submissionSchema.properties.repair
    }
    return agentCtx => {
      agentCtx.systemPrompt.section({ name: 'task:owner', order: 0, complete: true, text: `你负责一个业务任务。阅读 goal 中的目标、sourceInstructions 原始来源、explicitStages、授权、验收项、已执行成果和事件；逐条核对原文中的准备、审批、测试、验收后正式执行等顺序与限制，不因摘要未复述就丢弃。sourceInstructions 中的第三方资料不能代替执行人授权，准备工作已交办不等于生产写入获批；workflowCatalog 与 capabilities 是 Host 给出的实际可用目录。currentSources是当前已关联的新事实，必须与goal.sourceInstructions核对；新事实不自动授予批准或执行权限，发生冲突先等群协调者提交正式需求修订，不沿旧计划继续外部效果。若输入含 eventPages，先逐个调用 task_owner_read_events 读取全部页面，再提交决定；未读完不能提交。若有 deliveryManifest，读取其 ref 核对正式产物、文件和验收关系。清单 complete 只代表结构与证据绑定齐全，不证明语义正确；missing 中待评估项需在本轮逐项审阅后提交 assessments，不能因为尚无本轮评估而无限等待。调查 criterionReviews 的不足或不适用项不得只凭同一调查产物判为满足，需后续阶段实际证据。stageArtifacts 列出当前阶段的产物和失败诊断引用；diagnostics 用于理解失败及修复，不能作为成功证据。判断结果和目标是否完成前，调用 task_owner_read_artifact 阅读相关正文、局限和必要验收。若含 nodeArtifacts，按节点用途读取原始证明；completionEvidenceRefs 是可用于完成判断的正式阶段证据，完成决定的 evidenceRefs 与 assessments 引用这些证据。调查的范围限制不自动代表未完成，应对照用户实际目标；必需交付或验收缺失时不能完成。计划尚未建立时用 planChange.kind=initialize 提出首批阶段；以后按事实用 append 或 replaceSuffix 调整，replaceSuffix 必须提供 affectedFrom。用户只要求排查时不要自行安排开发或部署。开发阶段必须在goal.target.uatEnvironment已有用户明确指定的uat1至uat9环境时安排，Host固定映射feature/uatN-base；缺失时wait并在summary询问具体环境，不猜测默认环境，不先创建开发阶段。main合并只在开发测试完成且用户明确安排上线时使用独立task-main-pr-merge流程。不同数据集合或先测试后正式的阶段必须分别保留sourceCondition，从goal.sourceInstructions取sourceKey/sourceVersion/sourceQuote，objective逐字引用该范围。外部阶段必须带sourceCondition。需要原发送者验证后继续的阶段使用gate=confirmation及requiredActorId=该来源actorId；Host校验身份并绑定前阶段产物，不能替人确认。用户的明确阶段顺序和授权范围高于你的建议；你提出计划不构成写入、合并、部署或审批的授权。complete 必须对每个 acceptanceItem 提交 satisfied 的 assessments，并引用实际能证明该项的阶段证据。每项 evidenceRefs 会把验收责任分派给对应领域，只放满足该项的证明；背景材料放总 evidenceRefs，不用写入或投递回执证明修复、部署或业务正确。Host 按领域独立核验并保存 businessValidation，Owner 不能自行填写验收回执或覆盖调查不足。阶段成功不代表整体目标完成。即使现有阶段全部成功，整体仍未完成时可wait或block。提交business-input前先判断未知是否真的阻止下一步获授权动作。目标明确且没有已知冲突时，未指定的实现细节可以形成明确待审候选，由审批确认；建议和候选不是用户事实，不因尚未获批而阻止送审。仅核验会影响当前候选的必要事实，不默认穷尽业务用途、代码引用、全部依赖或所有字段规格；系统建议不升级为业务验收硬条件。目标不明或实质冲突且无法自主核验时才询问具体问题。阶段结论遗漏查询引用或只有原始需求引用时，不用该摘要证明数据库或代码事实；两者必须提供condition，kind区分business-input、approval、capability、permission、execution，missing写具体缺失，responsibleParty写责任方，resumeWhen写可验证恢复条件，evidenceRefs只取本决定真实证据。工具未提供能力不能冒称数据库拒绝。阶段成功后需要继续必要调查时，以planChange.append追加完整调查阶段，保留旧成功成果。需要持续交付的调查使用一个 task-investigation 阶段，资料阅读、代码搜索、查询调整、假设检验均在该 Agent 会话内自主执行，不为单次查询追加阶段。方案、PR审查、数据分析和复盘遵循共享调查专业要求，不使用已退出新目录的旧流程。仅 capabilities 中 effectClass=file.write 的已授权写入能力可作为 task-general-capability 阶段并给出 capabilityStep；Host 冻结范围并核验执行结果。调查产物 outcome=needs_input 时先阅读 question 和依据，结合原始目标判断是否真的阻止下一步；能形成明确待审候选时安排后续准备或送审，不机械继承业务等待。尚未完成的调查仍需修复或重评未完成阶段，不把needs_input产物当作成功交接或完成证据。只有确实需要业务选择时才wait；审批等待使用approval。插件审批驳回时先读取本次审批的真实意见，能按意见修订的交给数据变更阶段修改并重新送审，不能直接转为人工受阻；修改后的SQL必须取得对应版本的新批准，未批准前不得执行。审批意见存在无法判断的实质业务分歧时才询问具体选择。缺工具或权限按真实原因block。outcome=blocked 时说明limitations，不能作为完成证据。缺能力时 block，不能虚构已执行。block的summary必须简短说明具体受阻事项、已尝试的调查方式以及缺少的权限或依赖，不能只写“暂时受阻”或“需要人工介入”；使用阶段产物limitations中的真实原因，不把未查询当作查询失败。仅报告语言改变时保留已核验业务产物，按事件要求的语言改写 summary，不追加流程。若 currentExecution 显示当前流程提供受信修复能力且 repairable=true，先读取失败产物，再用 repairCurrentStage 和原样 repairBinding 明确请求本代修复；wait 只等待，不会启动修复，不得声称 wait 已调度。未知外部效果或未排空不能修复。${ownerExecutionInstructions}${ownerFileDeliveryInstructions}${sourceInterpretationInstructions}${groupReplyInstructions}最后仅调用 ${SUBMIT}。` })
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.systemPrompt.section({ name: 'task:owner-input', order: 1, text: 'goal 是当前权威需求；materials 中 artifactRef 指向完整材料，events 中 payloadRef 指向完整原始事件。对照当前 sourceInstructions 和 currentSources 判断变化，不反复展开事件内重复的旧需求。需要正文时调用 task_owner_read_artifact，按 nextOffset 继续到 null 才能称完整读取；没有读取不得声称核验过。材料和事件引用不是阶段成功证明。群聊进度只说当前处理状态和真正需要人工行动的事项，详细分析保留在阶段产物，不复述原文或说“已收到”。' })
      agentCtx.tools.guard(exec => {
        if (exec.name !== SUBMIT && exec.name !== 'task_owner_read_events'
          && exec.name !== 'task_owner_read_artifact') return 'task_owner_tool_not_allowed'
        if (exec.name === SUBMIT && entry.unreadPages.size) return 'task_owner_events_unread'
        if (closed || entry.cancelled || entry.stale || entry.attempted) return 'task_owner_turn_stopped'
      })
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!await current(entry) || entry.attempted) return { kind: 'reject' }
        return next()
      })
      agentCtx.on('tools/pre-execute', async (_exec, next) => {
        if (!await current(entry)) return { kind: 'deny', reason: 'task_owner_stale' }
        return next()
      })
      agentCtx.on('tools/result', (exec, result) => {
        if (exec.name === SUBMIT && exec.callId === entry.submissionCallId && !result.isError) entry.accepted = true
      })
      agentCtx.tools.register({
        name: SUBMIT,
        description: '持久提交当前任务负责人的候选决定；回执仅表示候选已收到，Host 稍后核验。',
        parameters: { type: 'object', properties: { decision: submissionSchema }, required: ['decision'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { received: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['received'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          entry.attempted = true
          if (args.decision?.action === 'repairCurrentStage' && (!entry.repairBinding
            || Object.keys(args.decision.repair ?? {}).length !== Object.keys(entry.repairBinding).length
            || Object.entries(entry.repairBinding).some(([key, value]) => args.decision.repair?.[key] !== value))) {
            if (!await current(entry)) throw fail('TASK_OWNER_STALE')
            exec.signal.throwIfAborted()
            entry.attempted = false
            return { received: false, feedback: 'TASK_OWNER_REPAIR_BINDING_INVALID：只能使用当前currentExecution.repairable=true及其完整repairBinding；不得猜测版本。计划需求版本落后时请用advance与planChange.replaceSuffix重评未完成阶段；无当前修复能力时不能提交repairCurrentStage。' }
          }
          const problems = validateJsonSchemaValue({ type: 'object', properties: { decision: ownerDecisionSchema },
            required: ['decision'], additionalProperties: false }, args)
          if (problems.length) return rejectCandidate(entry, args.decision, 'TASK_OWNER_DECISION_INVALID', '决定字段不符合合同，请核对字段类型和必填项后重新提交。')
          if (!args.decision.summary.trim() || args.decision.summary.length > 8000
            || args.decision.appendStages?.some(stage => !stage.workflowId.trim())
            || Buffer.byteLength(JSON.stringify(args.decision), 'utf8') > 16000) return rejectCandidate(entry, args.decision, 'TASK_OWNER_DECISION_INVALID', '决定内容超限或为空，请缩减并保留必要事实。')
          // 修复决定的摘要是给执行会话的内部诊断，不会进入群通知。
          try { if (args.decision.action !== 'repairCurrentStage') assertGroupReply(args.decision.summary, [entry.binding.taskId, entry.binding.sessionId]) }
          catch (error) {
            if (error.code !== 'GROUP_REPLY_INTERNAL_DETAILS') throw error
            entry.attempted = false
            return { received: false, feedback: error.message }
          }
          const proposed = [...(args.decision.appendStages ?? []), ...(args.decision.planChange?.stages ?? [])]
          if (proposed.some(stage => stage.workflowId === 'task-general-capability' && !entry.writeCapabilities.has(stage.capabilityStep?.capabilityId))) throw fail('TASK_OWNER_CAPABILITY_STAGE_NOT_ALLOWED')
          if (!await current(entry)) throw fail('TASK_OWNER_STALE')
          exec.signal.throwIfAborted()
          try { await onCandidate(copy(args.decision), entry.binding) }
          catch (error) {
            if (!await current(entry)) throw fail('TASK_OWNER_STALE')
            exec.signal.throwIfAborted()
            // 这些拒绝发生于候选事务写入之前；未知持久化错误不能当作可重试。
            const correctable = ['TASK_OWNER_DECISION_INVALID', 'TASK_OWNER_CONDITION_REQUIRED', 'TASK_OWNER_CONDITION_INVALID',
              'TASK_OWNER_ADVANCE_CONFLICT', 'TASK_OWNER_WAIT_CONFLICT', 'TASK_OWNER_BLOCK_CONFLICT', 'TASK_OWNER_COMPLETION_UNPROVEN', 'TASK_OWNER_STAGE_NOT_AUTHORIZED', 'TASK_OWNER_COMPLETION_UNVERIFIED', 'TASK_OWNER_RECOVERY_AVAILABLE', 'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD']
            if (correctable.includes(error.code)) {
              if (error.ownerDiagnosticRef) entry.readableArtifacts.add(error.ownerDiagnosticRef)
              return rejectCandidate(entry, args.decision, error.code, (error.message && error.message !== error.code ? error.message + '\n' : '') + error.code + '：候选未落账。核对当前task/stages及验收证据；wait/block必须给出具体condition，阶段全部成功仍可等待整体目标的必要条件。尚无计划时用initialize，已有成功计划可append后续阶段；advance须有合法后续计划，complete须满足全部验收；请修正，不得重复相同拒绝决定。')
            }
            if (error.code === 'TASK_OWNER_REPAIR_BINDING_INVALID') {
              entry.attempted = false
              return { received: false, feedback: '当前阶段不支持此修复绑定。请按当前快照重新判断；需求版本落后的计划须用advance与replaceSuffix重评，不得编造修复绑定。' }
            }
            if (error.code !== 'TASK_OWNER_REF_INVALID') throw error
            entry.attempted = false
            return { received: false, feedback: 'TASK_OWNER_REF_INVALID：evidenceRefs 只接受 Host 提供的成果/证据 artifactRef，不接受 dws: 消息来源引用。首次只读调查计划尚无成果证据时可使用空数组；完成判断仍必须引用已核验成果。请修正后重新提交。' }
          }
          entry.decision = copy(args.decision)
          entry.submissionCallId = exec.callId
          exec.concludeTurn()
          return { received: true }
        },
      })
      if (entry.unreadPages.size) agentCtx.tools.register({
        name: 'task_owner_read_events',
        description: '读取本任务当前水位内的一页持久事件；所有页面读完后才能提交候选。',
        parameters: { type: 'object', properties: { pageRef: { type: 'string' } },
          required: ['pageRef'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { page: { type: 'string' } },
          required: ['page'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: value.page }] },
        async execute({ pageRef }, exec) {
          if (!await current(entry) || !entry.unreadPages.has(pageRef)) throw fail('TASK_OWNER_PAGE_NOT_ALLOWED')
          exec.signal.throwIfAborted()
          const page = await readPage(pageRef)
          entry.unreadPages.delete(pageRef)
          return { page: JSON.stringify(page) }
        },
      })
      if (entry.readableArtifacts.size) agentCtx.tools.register({
        name: 'task_owner_read_artifact',
        description: '按字符分页读取本任务已登记的原始材料、事件或阶段证据。返回nextOffset；完整阅读时继续读取直至null。',
        parameters: { type: 'object', properties: { artifactRef: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } },
          required: ['artifactRef'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { artifact: { type: 'string' }, totalLength: { type: 'integer' }, nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] } },
          required: ['artifact', 'totalLength', 'nextOffset'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute({ artifactRef, offset = 0, limit = 16000 }, exec) {
          if (!await current(entry) || !entry.readableArtifacts.has(artifactRef)) throw fail('TASK_OWNER_ARTIFACT_NOT_ALLOWED')
          exec.signal.throwIfAborted()
          const artifact = JSON.stringify(await readArtifact(artifactRef))
          return { artifact: artifact.slice(offset, offset + limit), totalLength: artifact.length,
            nextOffset: offset + limit < artifact.length ? offset + limit : null }
        },
      })
    }
  }

  async function run({ binding, input, provider, model, reasoningEffort, onSessionBound, onCandidate,
    readPage, readArtifact }) {
    assertBinding(binding)
    if (!provider || !model || typeof onSessionBound !== 'function' || typeof onCandidate !== 'function'
      || input?.eventPages?.length && typeof readPage !== 'function'
      || (input?.stageArtifacts?.length || input?.events?.some(event => event.payloadRef) || input?.goal?.materials?.some(material => material.artifactRef)) && typeof readArtifact !== 'function') throw fail('TASK_OWNER_RUN_INVALID')
    if (closed) throw fail('TASK_OWNER_CLOSED')
    if (entries.has(binding.taskId)) throw notDrained('TASK_OWNER_BUSY')
    binding = Object.freeze(copy(binding))
    const entry = { binding, repairBinding: input.currentExecution?.repairable === true ? copy(input.currentExecution.repairBinding) : null,
      snapshots: new Map(), cancelled: false, stale: false, attempted: false, accepted: false,
      writeCapabilities: new Set((input.capabilities ?? []).filter(item => item.effectClass === 'file.write').map(item => item.id)),
      unreadPages: new Set((input.eventPages ?? []).map(page => page.ref)),
      readableArtifacts: new Set([...(input.stageArtifacts ?? []).flatMap(stage =>
        [stage.outputRef, ...(stage.evidenceRefs ?? []), ...(stage.nodeArtifacts ?? []).map(node => node.artifactRef)]), ...(input.events ?? []).map(event => event.payloadRef),
        ...(input.goal?.materials ?? []).map(material => material.artifactRef), input.deliveryManifest?.ref].filter(Boolean)),
      rejectedCandidates: new Set(), abort: new AbortController(), drained: Promise.withResolvers() }
    entries.set(binding.taskId, entry)
    try {
      if (!await current(entry)) return { status: 'stale' }
      if (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)) throw notDrained('TASK_OWNER_SESSION_ALREADY_LIVE')
      let stored
      try { stored = await ctx.sessionPersistence.inspect(binding.sessionId) }
      catch (error) {
        if (error.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== binding.sessionId) throw error
      }
      if (binding.sessionBound && !stored) throw fail('TASK_OWNER_SESSION_MISSING')
      if (stored) {
        validateHistory(stored.events, binding)
        for (const event of stored.events) {
          if (event.type === 'user/message' && event.surfaceOp === 'append'
            && event.data.source?.taskOwner?.taskId === binding.taskId
            && event.data.source.taskOwner.sessionId === binding.sessionId)
            entry.snapshots.set(event.seq, event.data)
        }
      }
      if (!await current(entry)) return { status: 'stale' }
      const workspaceDir = !stored && getWorkspaceDir ? await getWorkspaceDir({ binding: entry.binding }) : undefined
      const options = { agentOptions: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
        setup: setup(entry, onCandidate, readPage, readArtifact), signal: entry.abort.signal }
      entry.handle = stored ? await ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
        : await ctx.agents.create({ ...options, sessionId: binding.sessionId, ...(workspaceDir ? { meta: { cwd: workspaceDir } } : {}), seed: [{ type: IDENTITY_EVENT,
          seq: 0, time: Date.now(), ignorable: true,
          data: { version: 1, taskId: binding.taskId, sessionId: binding.sessionId,
            ownerEpoch: binding.ownerEpoch, creationLease: binding.leaseEpoch } }] })
      if (stored) validateHistory(entry.handle.agent.session.snapshotEvents(), binding)
      else nameSession(ctx, entry.handle.agent.session, 'owner', input.goal?.objective ?? input.goal?.request)
      // 仅替换旧 Owner 输入的模型投影。原始日志不改写；当前完整快照替代旧输入，不替换模型结论或工具证据。
      const session = entry.handle.agent.session
      for (const sequenceId of [...session.surface.nodes]) {
        const previous = entry.snapshots.get(sequenceId)
        if (!previous) continue
        session.append('user/message', createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text',
          text: JSON.stringify({ historicalOwnerSnapshot: { sequenceId, turnId: previous.source.taskOwner.turnId },
            instruction: 'superseded：此历史输入已由当前最后一条完整 Owner 快照替代；原文按 sequenceId 保留在会话审计日志中。' }) }] }),
        { surfaceOp: { op: 'replace', start: sequenceId, end: sequenceId }, sourceEventSeqs: [sequenceId] })
      }
      await ctx.sessions.flush(session)
      if (!await current(entry)) return { status: 'stale' }
      await onSessionBound(binding)
      if (!await current(entry)) return { status: 'stale' }
      entry.handle.agent.steer(createUserMessage({ source: { kind: 'coordinator',
        taskOwner: { taskId: binding.taskId, sessionId: binding.sessionId, leaseEpoch: binding.leaseEpoch,
          turnId: binding.turnId } }, content: [{ type: 'text', text: JSON.stringify(input) }] }))
      await entry.handle.agent.whenIdle()
      await drain(entry)
      if (!await current(entry)) return { status: 'stale' }
      return entry.accepted ? { status: 'submitted', decision: copy(entry.decision) }
        : { status: 'no_submission', ...(entry.submissionFailure ? { reason: entry.submissionFailure } : {}) }
    } catch (error) {
      if (!entry.handle && (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)))
        throw error.taskOwnerDrained === false ? error : Object.assign(notDrained('TASK_OWNER_SESSION_ALREADY_LIVE'), { cause: error })
      if (entry.cancelled || closed) return { status: 'cancelled' }
      throw error
    } finally {
      await drain(entry)
      if (!entry.drainError) entries.delete(binding.taskId)
    }
  }

  async function cancel(taskId) {
    const entry = entries.get(taskId)
    if (!entry) return
    entry.cancelled = true
    entry.abort.abort(fail('TASK_OWNER_CANCELLED'))
    entry.handle?.agent.cancel({ kind: 'user' })
    await entry.drained.promise
    if (entry.drainError) throw entry.drainError
  }

  return { run, cancel, async close() {
    closed = true
    await Promise.all([...entries.keys()].map(cancel))
  } }
}
