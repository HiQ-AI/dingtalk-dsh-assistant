import { nameSession } from './session-workspaces.js'
import { groupReplyInstructions, assertGroupReply } from './workflow-notifications.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const IDENTITY_EVENT = 'dingtalk/task-owner-session'
const SUBMIT = 'task_owner_submit'
const fail = code => Object.assign(new Error(code), { code })
const notDrained = code => Object.assign(fail(code), { taskOwnerDrained: false })
const copy = value => structuredClone(value)
const ownerFileDeliveryInstructions = '若goal含fileDelivery，必须逐项完成其中files的角色、名称和格式，并核对当前requirementRevision。文件交付仍属于同一个业务Task。尚无产物时，先完成必要调查，再用task-general-capability阶段的capabilityStep指定write-task-file，input仅含{role,fileName,content}，按Host提供的scope.artifactFiles精确授权生成真实UTF-8文本；仅支持md/txt/sql/csv/json，最多64KiB。每件产物均需真实登记及读回证明，不用write-task-markdown的哈希名称代替指定文件。已成功阶段提供完整artifact描述符后，再安排task-group-file-delivery阶段；Host会从当前任务已核验阶段选择产物、绑定来源群与账号，Owner不得指定任意本地路径或改群。已有图片、Office、PDF等二进制可先用task-general-capability阶段的import-task-file登记，input严格含{role,fileName,relativePath}；relativePath必须在Host generalFileRead.root/readablePaths与当前scope.readableFiles的双重白名单内，文件名保留真实扩展名。Host只读来源后冻结大小和SHA256，不由Owner猜摘要或提供sourceRoot；登记回读后的artifactFiles才交发送阶段。这不是生成器：未有真实源文件时须用可用生成器产出或明确缺能力。二进制仅使用真实受信来源并已登记的artifactFiles，不能用文字换扩展名伪造，也不能编造artifactId；缺少真实生成或受信导入路径、或缺少登记证明时block并说明缺少哪件产物。产物已生成、发送ACK、文字通知和文件消息送达是不同事实；只有每个必交文件都取得精确消息及下载大小/SHA256核验，才能complete，正文报告不能替代附件。未知发送或部分送达先等待原效果对账，不重建交付阶段、不换身份重发；已发文件不因完成摘要失败再发。'

const stageSchema = { type: 'object', properties: {
  workflowId: { type: 'string' }, gate: { type: 'string', enum: ['none', 'confirmation'] },
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
        clearTimeout(entry.timer)
        entry.drained.resolve()
      }
    })()
  }

  function setup(entry, onCandidate, readPage, readArtifact) {
    return agentCtx => {
      agentCtx.systemPrompt.section({ name: 'task:owner', order: 0, complete: true, text: `你负责一个业务任务。阅读 goal 中的目标、explicitStages、授权、验收项、已执行成果和事件；workflowCatalog 与 capabilities 是 Host 给出的实际可用目录。若输入含 eventPages，先逐个调用 task_owner_read_events 读取全部页面，再提交决定；未读完不能提交。若有 deliveryManifest，读取其 ref 核对正式产物、文件和验收关系。清单 complete 只代表结构与证据绑定齐全，不证明语义正确；missing 中待评估项需在本轮逐项审阅后提交 assessments，不能因为尚无本轮评估而无限等待。调查 criterionReviews 的不足或不适用项不得只凭同一调查产物判为满足，需后续阶段实际证据。stageArtifacts 列出当前阶段的产物和失败诊断引用；diagnostics 用于理解失败及修复，不能作为成功证据。判断结果和目标是否完成前，调用 task_owner_read_artifact 阅读相关正文、局限和必要验收。若含 nodeArtifacts，按节点用途读取原始证明；completionEvidenceRefs 是可用于完成判断的正式阶段证据，完成决定的 evidenceRefs 与 assessments 引用这些证据。调查的范围限制不自动代表未完成，应对照用户实际目标；必需交付或验收缺失时不能完成。计划尚未建立时用 planChange.kind=initialize 提出首批阶段；以后按事实用 append 或 replaceSuffix 调整，replaceSuffix 必须提供 affectedFrom。用户只要求排查时不要自行安排开发或部署。开发阶段必须在goal.target.uatEnvironment已有用户明确指定的uat1至uat9环境时安排，Host固定映射feature/uatN-base；缺失时wait并在summary询问具体环境，不猜测默认环境，不先创建开发阶段。main合并只在开发测试完成且用户明确安排上线时使用独立task-main-pr-merge流程。用户的明确阶段顺序和授权范围高于你的建议；你提出计划不构成写入、合并、部署或审批的授权。complete 必须对每个 acceptanceItem 提交 satisfied 的 assessments，并引用实际能证明该项的阶段证据。每项 evidenceRefs 会把验收责任分派给对应领域，只放满足该项的证明；背景材料放总 evidenceRefs，不用写入或投递回执证明修复、部署或业务正确。Host 按领域独立核验并保存 businessValidation，Owner 不能自行填写验收回执或覆盖调查不足。阶段成功不代表整体目标完成。需要持续交付的调查使用一个 task-investigation 阶段，资料阅读、代码搜索、查询调整、假设检验均在该 Agent 会话内自主执行，不为单次查询追加阶段。方案、PR审查、数据分析和复盘遵循共享调查专业要求，不使用已退出新目录的旧流程。仅 capabilities 中 effectClass=file.write 的已授权写入能力可作为 task-general-capability 阶段并给出 capabilityStep；Host 冻结范围并核验执行结果。调查产物 outcome=needs_input 时 wait 并询问 question，outcome=blocked 时 block 并说明 limitations，两者均不能作为 completed 的证据。缺能力时 block，不能虚构已执行。仅报告语言改变时保留已核验业务产物，按事件要求的语言改写 summary，不追加流程。若 currentExecution 显示当前流程提供受信修复能力且 repairable=true，先读取失败产物，再用 repairCurrentStage 和原样 repairBinding 明确请求本代修复；wait 只等待，不会启动修复，不得声称 wait 已调度。未知外部效果或未排空不能修复。${ownerFileDeliveryInstructions}${groupReplyInstructions}最后仅调用 ${SUBMIT}。` })
      agentCtx.tools.restrict({ allow: [] })
      agentCtx.tools.guard(exec => {
        if (exec.name !== SUBMIT && exec.name !== 'task_owner_read_events'
          && exec.name !== 'task_owner_read_artifact') return 'task_owner_tool_not_allowed'
        if (exec.name === SUBMIT && entry.unreadPages.size) return 'task_owner_events_unread'
        if (closed || entry.cancelled || entry.stale || entry.attempted) return 'task_owner_turn_stopped'
      })
      agentCtx.on('agent/pre-step', async (_event, next) => {
        if (!await current(entry) || entry.attempted || entry.steps >= entry.maxSteps) return { kind: 'reject' }
        entry.steps++
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
        parameters: { type: 'object', properties: { decision: ownerDecisionSchema }, required: ['decision'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { received: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['received'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          entry.attempted = true
          const problems = validateJsonSchemaValue({ type: 'object', properties: { decision: ownerDecisionSchema },
            required: ['decision'], additionalProperties: false }, args)
          if (problems.length) throw fail('TASK_OWNER_DECISION_INVALID')
          if (!args.decision.summary.trim() || args.decision.summary.length > 8000
            || args.decision.evidenceRefs.length > 64 || args.decision.appendStages?.length > 16
            || args.decision.planChange?.stages?.length > 16
            || args.decision.assessments?.length > 32
            || args.decision.appendStages?.some(stage => !stage.workflowId.trim())
            || Buffer.byteLength(JSON.stringify(args.decision), 'utf8') > 16000) throw fail('TASK_OWNER_DECISION_INVALID')
          try { assertGroupReply(args.decision.summary, [entry.binding.taskId, entry.binding.sessionId]) }
          catch (error) {
            if (error.code !== 'GROUP_REPLY_INTERNAL_DETAILS') throw error
            entry.attempted = false
            return { received: false, feedback: error.message }
          }
          const proposed = [...(args.decision.appendStages ?? []), ...(args.decision.planChange?.stages ?? [])]
          if (proposed.some(stage => stage.workflowId === 'task-general-capability' && !entry.writeCapabilities.has(stage.capabilityStep?.capabilityId))) throw fail('TASK_OWNER_CAPABILITY_STAGE_NOT_ALLOWED')
          if (!await current(entry)) throw fail('TASK_OWNER_STALE')
          exec.signal.throwIfAborted()
          await onCandidate(copy(args.decision), entry.binding)
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
        description: '读取本任务已成功阶段的真实产物或证据正文。',
        parameters: { type: 'object', properties: { artifactRef: { type: 'string' } },
          required: ['artifactRef'], additionalProperties: false },
        output: { schema: { type: 'object', properties: { artifact: { type: 'string' } },
          required: ['artifact'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: value.artifact }] },
        async execute({ artifactRef }, exec) {
          if (!await current(entry) || !entry.readableArtifacts.has(artifactRef)) throw fail('TASK_OWNER_ARTIFACT_NOT_ALLOWED')
          exec.signal.throwIfAborted()
          const artifact = JSON.stringify(await readArtifact(artifactRef))
          if (Buffer.byteLength(artifact, 'utf8') > 64 * 1024) throw fail('TASK_OWNER_ARTIFACT_CAPACITY')
          return { artifact }
        },
      })
    }
  }

  async function run({ binding, input, provider, model, reasoningEffort, onSessionBound, onCandidate,
    readPage, readArtifact, timeoutMs = 120000 }) {
    assertBinding(binding)
    if (!provider || !model || typeof onSessionBound !== 'function' || typeof onCandidate !== 'function'
      || input?.eventPages?.length && typeof readPage !== 'function'
      || input?.stageArtifacts?.length && typeof readArtifact !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2147483647) throw fail('TASK_OWNER_RUN_INVALID')
    if (closed) throw fail('TASK_OWNER_CLOSED')
    if (entries.has(binding.taskId)) throw notDrained('TASK_OWNER_BUSY')
    binding = Object.freeze(copy(binding))
    const entry = { binding, cancelled: false, stale: false, attempted: false, accepted: false, steps: 0,
      maxSteps: input.eventPages?.length ? 64 : 8,
      writeCapabilities: new Set((input.capabilities ?? []).filter(item => item.effectClass === 'file.write').map(item => item.id)),
      unreadPages: new Set((input.eventPages ?? []).map(page => page.ref)),
      readableArtifacts: new Set((input.stageArtifacts ?? []).flatMap(stage =>
        [stage.outputRef, ...(stage.evidenceRefs ?? [])].filter(Boolean))),
      abort: new AbortController(), drained: Promise.withResolvers() }
    entries.set(binding.taskId, entry)
    entry.timer = setTimeout(() => {
      entry.abort.abort(fail('TASK_OWNER_TIMEOUT'))
      entry.handle?.agent.cancel({ kind: 'user' })
    }, timeoutMs)
    try {
      if (!await current(entry)) return { status: 'stale' }
      if (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)) throw notDrained('TASK_OWNER_SESSION_ALREADY_LIVE')
      let stored
      try { stored = await ctx.sessionPersistence.inspect(binding.sessionId) }
      catch (error) {
        if (error.name !== 'SessionPersistenceNotFoundError' || error.sessionId !== binding.sessionId) throw error
      }
      if (binding.sessionBound && !stored) throw fail('TASK_OWNER_SESSION_MISSING')
      if (stored) validateHistory(stored.events, binding)
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
      await ctx.sessions.flush(entry.handle.agent.session)
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
        : { status: 'no_submission' }
    } catch (error) {
      if (!entry.handle && (ctx.agents.get(binding.sessionId) || ctx.sessions.get(binding.sessionId)))
        throw error.taskOwnerDrained === false ? error : Object.assign(notDrained('TASK_OWNER_SESSION_ALREADY_LIVE'), { cause: error })
      if (entry.cancelled || closed) return { status: 'cancelled' }
      if (entry.abort.signal.aborted) return { status: 'no_submission', reason: 'TASK_OWNER_TIMEOUT' }
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
