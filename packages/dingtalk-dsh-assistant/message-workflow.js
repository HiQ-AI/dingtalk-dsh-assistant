import { randomUUID } from 'node:crypto'
import { digest, messageSchemas, prepareMessageContext, splitContext, validateSplit, unitContext, candidateCards, intentContext, projectMaterialText } from './message-context.js'
import { prepareMessageRequest } from './message-model.js'
import { isPassiveTaskProgress, isQuietGroupMessage } from './message-ledger.js'

export const defaultMessagePolicy = Object.freeze({ version: 'message-v2.3', initialWindowMs: 45000, linkedWindowMs: 30000, attemptMs: 20000, commitReserveMs: 500, maxClaims: 21, maxCorrections: 2, concurrency: 2, maxInputTokens: 64000, maxOutputTokens: 12000, nodeInputByteLimits: { S: 8000, R: 14000, I: 18000, IB: 32000 }, recoveryDelaysMs: [5000, 30000] })
const limits = { S: [8000, 2000], R: [14000, 1000], I: [18000, 1500], IB: [32000, 4000] }
const statusQuestion = text => /(?:完成|改完|进度|状态|部署).*[吗？?]/u.test(text) && /(?:审核|任务|问题)/u.test(text)
const investigationConfirmation = request => request.reason === 'COMPLETED_INVESTIGATION_REPORTED_AGAIN'
  || (['I','IB'].includes(request.nodeId) && request.kind === 'needs_clarification'
    && /此前对应任务仅授权排查分析/u.test(String(request.reason)))
const directedStatusQuestion = text => /小小鹏/u.test(text) && statusQuestion(text)
function projectMaterial(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(projectMaterial)
  const result = { ...value }
  if (typeof value.text === 'string') {
    const projected = projectMaterialText(value.text)
    if (projected.capacityExceeded) return projected
    result.text = projected.text
    if (projected.restrictions.length) result.restrictions = projected.restrictions
    if (!projected.complete) result.projection = { complete: false, originalBytes: projected.originalBytes, resourceHash: projected.resourceHash, excerpts: projected.excerpts }
  }
  if (Array.isArray(value.resources)) result.resources = value.resources.map(projectMaterial)
  return result
}
function resolvedMaterialEvidence(requests, unitId) {
  return requests.filter(request => request.unitId === unitId && request.nodeId === 'R' && request.kind === 'needs_context' && request.status === 'resolved')
    .map(request => ({ requestId: request.id, needs: request.needs, answer: projectMaterial(request.answer) }))
}
function statusFollowup(snapshot) {
  const body = snapshot.source.text.trim()
  const previous = snapshot.history.slice(-6).findLast(item => statusQuestion(item.text))
  if (!previous || /^(?:请|帮我|小小鹏).*(?:修复|处理|排查|部署)/u.test(body)) return null
  if (/匹配到.{0,8}(?:个|项)任务/u.test(body)) return { kind: 'count', sourceKey: previous.sourceKey }
  if (snapshot.quotes.length && (body.match(/问题/gu) ?? []).length >= 2) return { kind: 'scope', sourceKey: previous.sourceKey }
  return null
}

/** 无常驻模型会话。每个判断独立、无工具；数据库是恢复和派发的唯一事实源。 */
export function createMessageWorkflow({ store, judge, context = {}, handlers = {}, policy = {}, clock = Date.now }) {
  if (!store?.command || !store?.query || typeof judge !== 'function') throw new Error('MESSAGE_DEPENDENCIES_REQUIRED')
  const config = { ...defaultMessagePolicy, ...policy }, flights = new Map(), routingTails = new Map(), topicFlights = new Map(), topicSchedules = new Set(), controllers = new Set(), queue = []
  let closed = false, occupied = 0, legacyTail = Promise.resolve(), quietReconciled = false
  const cmd = async (kind, args, id = `${kind}:${randomUUID()}`) => (await store.command({ id, kind, args })).result
  const state = runId => store.query({ kind: 'message.run', runId })
  const revision = data => data.run.revision ?? data.run.matterSetRevision ?? 0
  const slot = () => new Promise((resolve, reject) => { if (closed) { reject(new Error('MESSAGE_WORKFLOW_CLOSED')); return }; queue.push({ resolve, reject }); drain() })
  function drain() { while (!closed && occupied < config.concurrency && queue.length) { occupied++; queue.shift().resolve(() => { occupied--; drain() }) } }
  async function receive(input, { process: launch = true } = {}) {
    if (closed) throw new Error('MESSAGE_WORKFLOW_CLOSED')
    if (!input.sourceKey || !Number.isInteger(input.sourceVersion) || !input.actorId || !input.conversationId || typeof input.body !== 'string' || !input.body.length) throw new Error('MESSAGE_INPUT_INVALID')
    const runId = input.runId ?? `msg-${digest([input.sourceKey, input.sourceVersion]).slice(0, 40)}`
    const result = await cmd('message.receive', { ...input, runId, policy: config }, `receive:${runId}`)
    if (launch) void process(runId).catch(() => {})
    return { ...result, runId }
  }
  async function reprocess(runId) {
    const previous=await state(runId)
    const nextVersion=previous.run.sourceVersion+1
    const newRunId=`msg-replay-${digest([previous.run.sourceKey,nextVersion]).slice(0,40)}`
    const result=await cmd('message.reprocess',{runId,newRunId},`reprocess:${runId}:${newRunId}`)
    await process(result.run.runId)
    await waitForTopicFlight(result.run.runId)
    return state(result.run.runId)
  }
  async function waitForTopicFlight(runId) {
    if (!context.bindTopic) return
    const data = await state(runId)
    if ((await store.query({ kind: 'message.routing.pending', conversationId: data.run.conversationId })).length) return
    await Promise.all([...new Set(data.units.map(unit => unit.topicId).filter(Boolean))].map(topicId => topicFlights.get(topicId)).filter(Boolean))
  }
  async function waiting(data, unitId, stage, output) {
    const aliases = new Map((data.run.snapshot?.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
    const needs = (output.needs ?? []).map(need => ({ ...need, resourceRef: aliases.get(need.resourceRef) ?? need.resourceRef }))
    const requestId = digest([data.run.runId, unitId, stage, revision(data), { ...output, needs }])
    if (data.requests.some(request => request.id === requestId && request.status === 'resolved')) {
      return cmd('message.attention', { runId: data.run.runId, reason: `MESSAGE_CONTEXT_UNCHANGED:${stage}:${unitId}` })
    }
    return cmd('message.wait', { runId: data.run.runId, unitId, nodeId: stage, expectedRevision: revision(data), reason: output.reason, request: { requestId, kind: output.kind, question: output.question ?? output.reason, needs, permittedActors: [data.run.actorId] } })
  }
  async function invoke(data, unitId, stage, input, fixedOutput) {
    const runId = data.run.runId, rev = revision(data)
    const prior = data.nodes.find(node => node.unitId === unitId && node.nodeId === stage && ['completed', 'succeeded'].includes(node.status) && (node.revision ?? rev) === rev && (stage !== 'IB' || node.input?.topicInputRevision === input.topicInputRevision))
    if (prior) return prior.output?.output ?? prior.output
    if (data.requests.some(request => request.unitId === unitId && request.nodeId === stage && request.status === 'pending')) return null
    const answers = data.requests.filter(request => request.unitId === unitId && request.nodeId === stage && request.status === 'resolved').map(request => ({ requestId: request.id, question: request.question, answer: projectMaterial(request.answer) }))
    if (answers.some(answer => answer.answer?.resources?.some(resource => resource.capacityExceeded) || answer.answer?.capacityExceeded)) {
      await cmd('message.attention', { runId, reason: `MESSAGE_MATERIAL_CAPACITY:${stage}:${unitId}` }); return null
    }
    const previousFailure = data.nodes.findLast(node => node.unitId === unitId && node.nodeId === stage && node.status === 'failed')?.error
    input = { ...input, ...(answers.length ? { clarificationAnswers: answers } : {}), ...(previousFailure ? { previousFailure } : {}) }
    const inputLimit = data.run.policy.nodeInputByteLimits?.[stage] ?? limits[stage][0]
    const outputLimit = stage === 'IB' ? Math.min(4000, 1500 + Math.max(0, input.units.length - 1) * 600) : limits[stage][1]
    // 代码已确定的产出只留节点账和schema校验，不领取模型容量或并发槽。
    const prepared = fixedOutput ? null : prepareMessageRequest(stage, input)
    const inputBytes = prepared?.inputBytes ?? 0
    if (prepared && inputBytes > inputLimit) { await cmd('message.attention', { runId, reason: `MESSAGE_CONTEXT_CAPACITY:${stage}:${unitId}:${inputBytes}/${inputLimit}` }); return null }
    const release = fixedOutput ? null : await slot()
    let binding, timer, controller
    try {
      if (closed) return null
      const current = await state(runId)
      if (revision(current) !== rev) return null
      const deadline = current.run.deadline
      const remaining = stage === 'IB' ? config.attemptMs : deadline ? Number(new Date(deadline)) - clock() - config.commitReserveMs : config.attemptMs
      if (remaining <= 0) { await cmd('message.attention', { runId, reason: `MESSAGE_DEADLINE_BEFORE_CLAIM:${stage}:${unitId}` }); return null }
      const claimed = await cmd('message.node.claim', { runId, unitId, nodeId: stage, expectedRevision: rev, estimatedInputTokens: prepared ? inputBytes + 256 : 0, maxOutputTokens: prepared ? outputLimit : 0, input: prepared ? { ...input, inputBytes, inputHash: prepared.inputHash, inputReadyAt: clock() } : { deterministic: true, inputHash: digest(input), inputReadyAt: clock() } })
      binding = claimed?.node
      if (!binding) return null
      if (prepared) { controller = new AbortController(); controllers.add(controller) }
      const timeout = prepared ? new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MESSAGE_NODE_TIMEOUT')) }, Math.min(config.attemptMs, remaining)) }) : null
      const response = fixedOutput ? { output: fixedOutput, usage: { inputTokens: 0, outputTokens: 0 } } : await Promise.race([judge({ stage, input, prepared, schema: messageSchemas[stage], signal: controller.signal, maxOutputTokens: outputLimit }), timeout])
      const output = messageSchemas[stage].parse(response.output ?? response)
      if (stage === 'S') validateSplit(output, current.run.body)
      if (stage === 'R' && output.kind === 'binding' && output.candidateId !== null && !input.candidates.some(card => card.candidateId === output.candidateId)) throw new Error('MESSAGE_UNKNOWN_TARGET')
      if (stage === 'I' && output.kind === 'intent' && output.actions.some((action, index) => action.dependsOn.some(dep => dep >= index))) throw new Error('MESSAGE_ACTION_DEPENDENCY_INVALID')
      const usage = response.usage && Number.isSafeInteger(response.usage.inputTokens) && Number.isSafeInteger(response.usage.outputTokens) ? response.usage : undefined
      const committed = await cmd('message.node.complete', { runId, nodeRunId: binding.nodeRunId, leaseEpoch: binding.leaseEpoch, expectedRevision: rev, ...(usage ? { usage } : {}), output: { output, usage: response.usage ?? {}, inputBytes, resultReadyAt: clock() } })
      if (committed?.status === 'stale') return null
      return output
    } catch (error) {
      if (binding) {
        const failure = error.issues ? `MESSAGE_SCHEMA_INVALID:${JSON.stringify(error.issues.slice(0, 8).map(issue => ({ path: issue.path, message: issue.message }))).slice(0, 1200)}` : error.code ?? error.message
        try { await cmd('message.node.fail', { runId, nodeRunId: binding.nodeRunId, leaseEpoch: binding.leaseEpoch, expectedRevision: rev, error: failure, retryAt: new Date(clock() + config.recoveryDelaysMs[0]).toISOString() }) }
        catch (failure) { if (!['MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(failure.code)) throw failure }
      }
      else if (error.code === 'MESSAGE_BUDGET_EXHAUSTED') await cmd('message.attention', { runId, reason: `MESSAGE_BUDGET_EXHAUSTED:${stage}:${unitId}` })
      else if (!['MESSAGE_NODE_NOT_READY', 'MESSAGE_RETRY_NOT_DUE', 'MESSAGE_DEADLINE_EXCEEDED', 'MESSAGE_STALE'].includes(error.code)) throw error
      return null
    } finally { clearTimeout(timer); if (controller) { controller.abort(); controllers.delete(controller) }; release?.() }
  }
  async function unitDrive(runId, unit) {
    if (closed) return
    let data = await state(runId)
    if (unit.status && ['accepted', 'applied', 'ignored', 'rejected', 'superseded'].includes(unit.status)) return
    if (context.bindTopic && unit.topicId && unit.routingBinding) return
    if (data.requests.some(request => request.unitId === unit.unitId && request.status === 'pending')) return
    const snapshot = data.run.snapshot
    const base = unitContext(snapshot, unit)
    if (unit.contextNeeds?.length) {
      const aliases = new Map((snapshot.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
      const needs = unit.contextNeeds.map(need => ({ ...need, resourceRef: aliases.get(need.resourceRef) ?? need.resourceRef }))
      const material = await context.material?.({ run: data.run, unit, nodeId: 'R', needs })
      if (!material?.ready) { await waiting(data, unit.unitId, 'R', { kind: 'needs_context', reason: 'UNIT_MATERIAL_PENDING', needs: unit.contextNeeds }); return }
      base.material = projectMaterial(material.data)
      if (base.material?.resources?.some(resource => resource.capacityExceeded)) { await cmd('message.attention', { runId, reason: `MESSAGE_MATERIAL_CAPACITY:R:${unit.unitId}` }); return }
    }
    const candidateStartedAt = clock()
    const followup = statusFollowup(snapshot)
    const retrieved = await context.candidates?.({ run: data.run, snapshot, unit, explicitSourceKeys: followup ? [followup.sourceKey] : [] }) ?? []
    const rawCandidates = Array.isArray(retrieved) ? retrieved : retrieved.cards
    if (!Array.isArray(rawCandidates) || retrieved.explicitOverflow) { await cmd('message.attention', { runId, reason: `MESSAGE_REFERENCED_CANDIDATES_CAPACITY:R:${unit.unitId}` }); return }
    const candidates = candidateCards(rawCandidates)
    const nearest = snapshot.history.at(-1)
    const recentTopics = nearest && nearest.actorId === data.run.actorId && !data.run.context?.quoteRefs?.length
      && /^这不是让你(?:去)?查/u.test(data.run.body.trim())
      ? rawCandidates.filter(card => card.topicId && card.sourceRefs?.includes(nearest.sourceKey)) : []
    const recentSource = recentTopics.length === 1 ? await store.query({ kind: 'message.source', sourceKey: nearest.sourceKey }) : null
    const recentAt = recentSource?.context?.occurredAt ?? Date.parse(recentSource?.createdAt ?? '')
    const currentAt = data.run.context?.occurredAt ?? Date.parse(data.run.createdAt)
    const fixedRecent = Number.isFinite(recentAt) && Number.isFinite(currentAt) && currentAt >= recentAt && currentAt - recentAt <= 90_000
      ? { kind: 'binding', disposition: 'existing', candidateId: recentTopics[0].candidateId, evidence: ['同一发送人在90秒内紧接该话题消息发出无其他引用的短指代'] } : undefined
    const priorTopic = followup && rawCandidates.find(card => card.topicId && card.sourceRefs?.includes(followup.sourceKey))
    const relationCandidates = [...candidates]
    if (priorTopic) {
      const index = relationCandidates.findIndex(card => card.candidateId === priorTopic.candidateId)
      if (index > 0) relationCandidates.unshift(...relationCandidates.splice(index, 1))
    }
    const relationInput = { ...base, candidates: relationCandidates, candidatePreparationMs: clock() - candidateStartedAt, omittedCandidateCount: Array.isArray(retrieved) ? 0 : Math.max(0, retrieved.total - rawCandidates.length) }
    const answers = data.requests.filter(request => request.unitId === unit.unitId && request.nodeId === 'R' && request.status === 'resolved')
      .map(request => ({ requestId: request.id, question: request.question, answer: projectMaterial(request.answer) }))
    const previousFailure = data.nodes.findLast(node => node.unitId === unit.unitId && node.nodeId === 'R' && node.status === 'failed')?.error
    const projectedInput = { ...relationInput, ...(answers.length ? { clarificationAnswers: answers } : {}), ...(previousFailure ? { previousFailure } : {}) }
    // R 的补取材料作为 clarificationAnswers 在 invoke 才合并；按完整输入计量，保留高优先身份卡。
    const relationLimit = data.run.policy.nodeInputByteLimits?.R ?? limits.R[0]
    while (relationCandidates.length > 1 && prepareMessageRequest('R', projectedInput).inputBytes > relationLimit - 500) {
      const removable = relationCandidates.findLastIndex(card => !card.explicitReferenceMatches?.length && card.candidateId !== priorTopic?.candidateId)
      if (removable < 0) break
      relationCandidates.splice(removable, 1)
      relationInput.omittedCandidateCount++
    }
    const linked = await invoke(data, unit.unitId, 'R', relationInput, fixedRecent ?? (followup ? { kind: 'binding', disposition: 'conversation', candidateId: priorTopic?.candidateId ?? null, evidence: ['前文任务状态问句的范围补充'] } : undefined))
    if (!linked) return
    if (linked.kind !== 'binding' || linked.disposition === 'unresolved') { await waiting(data, unit.unitId, 'R', linked.kind === 'binding' ? { kind: 'needs_clarification', reason: 'MESSAGE_TARGET_UNRESOLVED' } : linked); return }
    const detailRefs = [...new Set(relationCandidates.filter(card => card.candidateId === linked.candidateId || linked.disposition === 'new' && card.explicitReferenceMatches?.length)
      .flatMap(card => card.omissions?.map(omission => omission.resourceRef).filter(Boolean) ?? []))]
    const resolvedRefs = new Set(data.requests.filter(request => request.unitId === unit.unitId && request.nodeId === 'R' && request.status === 'resolved').flatMap(request => request.needs?.map(need => need.resourceRef) ?? []))
    const missingDetails = detailRefs.filter(ref => !resolvedRefs.has(ref))
    if (missingDetails.length) { await waiting(data, unit.unitId, 'R', { kind: 'needs_context', reason: 'CANDIDATE_DETAIL_REQUIRED', needs: missingDetails.map(resourceRef => ({ resourceRef, reason: '核对候选完整目标与判别事实' })) }); return }
    const target = relationCandidates.find(card => card.candidateId === linked.candidateId) ?? null
    let binding = { ...linked, ...target, target, ...(fixedRecent ? { verifiedRecentSourceKey: nearest.sourceKey } : {}) }
    data = await state(runId)
    const facts = await context.facts?.({ run: data.run, snapshot, unit, binding }) ?? {}
    if (context.bindTopic) {
      const topic = await context.bindTopic({ run: data.run, unit, binding, facts })
      if (!topic) { await cmd('message.attention', { runId, reason: `MESSAGE_TOPIC_BINDING_MISSING:${unit.unitId}` }); return }
      await cmd('message.topic.bind', { runId, unitId: unit.unitId, expectedRevision: revision(data), binding: { ...binding, topicId: topic.topicId }, topic }, `topic-bind:${runId}:${unit.unitId}:${revision(data)}`)
      return
    }
    const resolvedEvidence = resolvedMaterialEvidence(data.requests, unit.unitId)
    const fixedIntent = followup ? { kind: 'intent', actions: followup.kind === 'count'
      ? [{ intent: 'fact', arguments: { kind: 'fact', text: base.text }, dependsOn: [] }]
      : [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: followup.kind === 'count' ? 'none' : 'result' } : undefined
    const intent = await invoke(data, unit.unitId, 'I', intentContext(base, binding, facts, snapshot.policy, candidates, resolvedEvidence), fixedIntent)
    if (!intent) return
    if (intent.kind === 'needs_relink') {
      const result = await cmd('message.relink', { runId, unitId: unit.unitId, expectedRevision: revision(data), reason: intent.reason })
      if (result?.run?.status !== 'needs_attention') await unitDrive(runId, unit)
      return
    }
    if (intent.kind === 'needs_resegmentation') { await resegment(runId, intent.reason); return }
    const investigationMatched = binding.engine === 'legacy' && binding.state === 'completed'
      && /仅授权排查分析/u.test(binding.goal ?? '')
      && /(?:依然|仍然|还是|再次|又).*(?:问题|没有|未显示|失败)|(?:问题|没有|未显示|失败).*(?:依然|仍然|还是|再次|又)/u.test(data.run.body)
      && /@孙鹏|小小鹏/u.test(data.run.body)
    if (intent.kind !== 'intent') { await waiting(data, unit.unitId, 'I', intent); return }
    if (intent.actions.some(action => ['create', 'research', 'answer', 'reopen', 'revise', 'pause', 'cancel', 'resume'].includes(action.intent))) {
      intent.requiredExecutionMaterials = [...new Set([...intent.requiredExecutionMaterials, ...resolvedEvidence.flatMap(item => item.needs.map(need => need.resourceRef))])]
      const constraints = resolvedEvidence.flatMap(item => [...(item.answer?.constraints ?? []), ...(item.answer?.restrictions ?? []), ...(item.answer?.resources?.flatMap(resource => resource.restrictions ?? []) ?? [])])
      intent.constraints = [...new Set([...intent.constraints, ...constraints])]
    }
    if (binding.disposition === 'conversation' && intent.actions.every(action => action.intent === 'no_action')
      && /小小鹏/u.test(data.run.body) && /(?:审核|任务).*(?:完成|改完|进度|状态|部署)/u.test(data.run.body)
      && /[吗？?]/u.test(data.run.body)) {
      intent.actions = [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }]
      intent.replyPolicy = 'result'
    }
    if (investigationMatched && !/(?:需要|请|帮忙).{0,20}(?:修复|处理)/u.test(data.run.body)
      && !data.requests.some(request => request.unitId === unit.unitId && investigationConfirmation(request))) {
      await waiting(data, unit.unitId, 'I', { kind: 'needs_clarification', reason: 'COMPLETED_INVESTIGATION_REPORTED_AGAIN',
        question: `这与此前仅完成排查的“${binding.title}”事项一致。现在是否需要我继续实施修复并验证？`, needs: [] })
      return
    }
    if (investigationMatched && data.requests.some(request => request.unitId === unit.unitId && investigationConfirmation(request)
      && request.status === 'resolved' && /^(?:是|需要|请|好|可以|同意|继续|修复)/u.test(String(request.answer).trim()))
      && intent.actions.some(action => ['create', 'research', 'reopen'].includes(action.intent))) {
      binding = { kind: 'binding', disposition: 'new', candidateId: null, evidence: [...(binding.evidence ?? []), `此前排查任务：${binding.taskId}`], priorTaskId: binding.taskId }
    }
    const admission = await context.validateActions?.({ run: data.run, unit, binding, intent, facts, requests: data.requests })
    if (admission && admission.kind !== 'accepted') { await waiting(data, unit.unitId, 'I', admission); return }
    if (intent.requiredExecutionMaterials.length) {
      const needs = intent.requiredExecutionMaterials.map(resourceRef => ({ resourceRef, reason: 'required_execution_material' }))
      const material = await context.material?.({ run: data.run, unit, nodeId: 'execute', needs })
      if (!material?.ready) {
        if (material?.unsupported) await cmd('message.attention', { runId, reason: `MESSAGE_EXECUTION_MATERIAL_UNSUPPORTED:${material.reason ?? intent.requiredExecutionMaterials.join(',')}` })
        else await waiting(data, unit.unitId, 'execute', { kind: 'needs_context', reason: 'REQUIRED_EXECUTION_MATERIAL_PENDING', needs })
        return
      }
    }
    const topic = await context.topicFor?.({ run: data.run, unit, binding, intent, facts })
    if (topic) binding.topicId = topic.topicId
    if (facts.topic?.facts) base.constraints = [...new Set([...base.constraints, ...facts.topic.facts.filter(fact => fact.kind === 'constraint').map(fact => fact.text)])]
    const commands = intent.actions.every(action => action.intent === 'no_action') ? [] : intent.actions.map((action, index) => { const commandId = `${runId}:${unit.unitId}:${revision(data)}:${index}`; return { commandId, kind: action.intent, args: { taskId: binding.target?.taskId ?? (['create', 'research', 'answer'].includes(action.intent) ? `task-${digest(commandId).slice(0, 32)}` : null), arguments: action.arguments, binding, constraints: [...base.constraints, ...base.sharedConstraints, ...intent.constraints], requiredExecutionMaterials: intent.requiredExecutionMaterials, replyPolicy: intent.replyPolicy }, dependsOn: action.dependsOn.map(dep => `${runId}:${unit.unitId}:${revision(data)}:${dep}`) } })
    await cmd('message.accept', { runId, unitId: unit.unitId, expectedRevision: revision(data), commands, ...(topic ? { topic } : {}), ...(commands.length ? {} : { outcome: 'ignored' }) }, `accept:${runId}:${unit.unitId}:${revision(data)}`)
    await dispatch(runId)
  }
  async function resegment(runId, reason) {
    const before = await state(runId)
    if (!before.run.correction) {
      const changed = before.units.filter(unit => !['applied', 'accepted', 'ignored', 'rejected'].includes(unit.status)).map(unit => unit.unitId)
      const begun = await cmd('message.correction.begin', { runId, expectedRevision: revision(before), unitIds: changed, reason })
      if (begun.run.status === 'needs_attention') return
    }
    const current = await state(runId)
    const result = await invoke(current, '$', 'S', { ...splitContext(current.run.snapshot), correctionEvidence: reason })
    if (!result) return
    if (result.kind !== 'split') { await waiting(current, '$', 'S', result); return }
    const semantic = unit => ({ spans: unit.spans, goalText: unit.goalText, constraints: unit.constraints, contextNeeds: unit.contextNeeds, sharedConstraints: unit.sharedConstraints })
    const used = new Set()
    const units = result.units.map((unit, index) => {
      const next = { ...unit, sharedConstraints: result.sharedConstraints }
      const same = before.units.find(previous => !used.has(previous.unitId) && digest(semantic(previous)) === digest(semantic(next)))
      if (same) { used.add(same.unitId); return { ...semantic(same), unitId: same.unitId, ...(['applied', 'accepted', 'ignored', 'rejected'].includes(same.status) ? { preservedUnitId: same.unitId } : {}) } }
      return { ...next, unitId: `${runId}:r${revision(current)}:u${index}` }
    })
    try { await cmd('message.correction.publish', { runId, expectedRevision: revision(current), correctionId: current.run.correction.id, units }) }
    catch (error) { if (error.code !== 'MESSAGE_CORRECTION_EFFECT_PENDING') throw error; await cmd('message.attention', { runId, reason: 'RESEGMENTATION_CHANGES_APPLIED_EFFECT' }); return }
    const published = await state(runId)
    await Promise.all(published.units.filter(unit => unit.status !== 'superseded').map(unit => unitDrive(runId, unit)))
  }
  async function topicDrive(topicId) {
    const topic = await store.query({ kind: 'message.topic', topicId })
    if (!topic || (await store.query({ kind: 'message.routing.pending', conversationId: topic.conversationId })).length) return
    let entries = await store.query({ kind: 'message.topic.units', topicId })
    if (!entries.length) return
    const refreshed = await cmd('message.topic.refresh', { runId: entries[0].run.runId, topicId, inputRevision: topic.inputRevision }, `topic-refresh:${topicId}:${topic.inputRevision}`)
    if (refreshed.status !== 'ready') return refreshed.status
    entries = await store.query({ kind: 'message.topic.units', topicId })
    const prepared = await Promise.all(entries.map(async ({ run, unit }) => {
      const data = await state(run.runId)
      const binding = unit.routingBinding
      if (!binding) throw new Error('MESSAGE_TOPIC_BINDING_MISSING')
      const facts = await context.facts?.({ run, snapshot: run.snapshot, unit, binding }) ?? {}
      const base = unitContext(run.snapshot, unit)
      const answers = data.requests.filter(request => request.unitId === unit.id && request.nodeId === 'IB' && request.status === 'resolved')
        .map(request => ({ requestId: request.id, question: request.question, answer: projectMaterial(request.answer) }))
      return { run, unit, data, binding, facts, base, input: { ...intentContext(base, binding, facts, run.snapshot.policy, [], resolvedMaterialEvidence(data.requests, unit.id)), ...(answers.length ? { clarificationAnswers: answers } : {}) } }
    }))
    // 本次最新来源承担一次 IB 调用账；连续补充不反复消耗最早消息的预算。
    const first = prepared.at(-1)
    const input = { intentRunId: `intent:${topicId}:${topic.inputRevision}`, topicId, topicInputRevision: topic.inputRevision, units: prepared.map(item => ({ unitId: item.unit.id, runId: item.run.runId, actorId: item.run.actorId, input: item.input })) }
    const preserved = first.data.nodes.findLast(node => node.nodeId === 'IB' && node.status === 'succeeded'
      && node.input?.intentRunId === input.intentRunId && node.output?.output?.kind === 'topic_intents')
    const output = preserved?.output.output ?? await invoke(first.data, first.unit.id, 'IB', input)
    if (!output) return
    if (output.kind !== 'topic_intents') { await waiting(first.data, first.unit.id, 'IB', output); return }
    const decisions = output.decisions
    if (decisions.length !== prepared.length || new Set(decisions.map(item => item.unitId)).size !== prepared.length || prepared.some(item => !decisions.some(decision => decision.unitId === item.unit.id))) {
      await cmd('message.attention', { runId: first.run.runId, reason: `MESSAGE_TOPIC_INTENT_COVERAGE:${topicId}` }); return
    }
    const accepted = []
    for (const item of prepared) {
      let intent = decisions.find(decision => decision.unitId === item.unit.id).intent
      if (intent.kind === 'needs_relink') { await cmd('message.relink', { runId: item.run.runId, unitId: item.unit.id, expectedRevision: revision(item.data), reason: intent.reason }); void process(item.run.runId); return }
      if (intent.kind === 'needs_resegmentation') { await resegment(item.run.runId, intent.reason); return }
      if (intent.kind !== 'intent') { await waiting(item.data, item.unit.id, 'IB', intent); return }
      const followup = statusFollowup(item.run.snapshot)
      if (followup) intent = { kind: 'intent', actions: followup.kind === 'count'
        ? [{ intent: 'fact', arguments: { kind: 'fact', text: item.base.text }, dependsOn: [] }]
        : [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: followup.kind === 'count' ? 'none' : 'result' }
      if (item.binding.disposition === 'conversation' && intent.actions.every(action => action.intent === 'no_action')
        && /小小鹏/u.test(item.run.body) && /(?:审核|任务).*(?:完成|改完|进度|状态|部署)/u.test(item.run.body)
        && /[吗？?]/u.test(item.run.body)) intent = { ...intent, actions: [{ intent: 'status', arguments: { scope: 'conversation' }, dependsOn: [] }], replyPolicy: 'result' }
      const investigationMatched = item.binding.engine === 'legacy' && item.binding.state === 'completed'
        && /仅授权排查分析/u.test(item.binding.goal ?? '')
        && /(?:依然|仍然|还是|再次|又).*(?:问题|没有|未显示|失败)|(?:问题|没有|未显示|失败).*(?:依然|仍然|还是|再次|又)/u.test(item.run.body)
        && /@孙鹏|小小鹏/u.test(item.run.body)
      if (investigationMatched && !/(?:需要|请|帮忙).{0,20}(?:修复|处理)/u.test(item.run.body)
        && !item.data.requests.some(request => request.unitId === item.unit.id && investigationConfirmation(request))) {
        await waiting(item.data, item.unit.id, 'IB', { kind: 'needs_clarification', reason: 'COMPLETED_INVESTIGATION_REPORTED_AGAIN',
          question: `这与此前仅完成排查的“${item.binding.title}”事项一致。现在是否需要我继续实施修复并验证？`, needs: [] })
        return
      }
      // 旧引擎的已完成排查没有可续办的 ExecutionRun；确认后在同话题建立新流程任务并保留来源关系。
      const confirmedLegacyContinuation = investigationMatched && item.data.requests.some(request => request.unitId === item.unit.id
        && investigationConfirmation(request) && request.status === 'resolved'
        && /^(?:是|需要|请|好|可以|同意|继续|修复)/u.test(String(request.answer).trim()))
        && intent.actions.some(action => ['create', 'research', 'reopen'].includes(action.intent))
      const actionBinding = confirmedLegacyContinuation
        ? { kind: 'binding', disposition: 'new', candidateId: null, evidence: [...(item.binding.evidence ?? []), `此前排查任务：${item.binding.taskId}`], priorTaskId: item.binding.taskId, topicId }
        : item.binding
      if (intent.actions.some((action, index) => action.dependsOn.some(dep => dep >= index))) throw new Error('MESSAGE_ACTION_DEPENDENCY_INVALID')
      const admission = await context.validateActions?.({ run: item.run, unit: item.unit, binding: actionBinding, intent, facts: item.facts, requests: item.data.requests })
      if (admission && admission.kind !== 'accepted') { await waiting(item.data, item.unit.id, 'IB', admission); return }
      if (intent.requiredExecutionMaterials.length) {
        const needs = intent.requiredExecutionMaterials.map(resourceRef => ({ resourceRef, reason: 'required_execution_material' }))
        const material = await context.material?.({ run: item.run, unit: item.unit, nodeId: 'execute', needs })
        if (!material?.ready) { await waiting(item.data, item.unit.id, 'execute', { kind: 'needs_context', reason: 'REQUIRED_EXECUTION_MATERIAL_PENDING', needs }); return }
      }
      const constraints = [...new Set([...item.base.constraints, ...item.base.sharedConstraints,
        ...(item.facts.topic?.facts ?? []).filter(fact => fact.kind === 'constraint').map(fact => fact.text), ...intent.constraints])]
      const commands = intent.actions.every(action => action.intent === 'no_action') ? [] : intent.actions.map((action, index) => {
        const commandId = `${topicId}:${topic.inputRevision}:${item.unit.id}:${index}`
        return { commandId, kind: action.intent, args: { taskId: actionBinding.target?.taskId ?? (['create', 'research', 'answer'].includes(action.intent) ? `task-${digest(commandId).slice(0, 32)}` : null), arguments: action.arguments, binding: actionBinding, constraints, requiredExecutionMaterials: intent.requiredExecutionMaterials, replyPolicy: intent.replyPolicy }, dependsOn: action.dependsOn.map(dep => `${topicId}:${topic.inputRevision}:${item.unit.id}:${dep}`) }
      })
      const sourceRefs = [{ sourceKey: item.run.sourceKey, sourceVersion: item.run.sourceVersion, text: item.run.body }]
      const topicFacts = [...intent.constraints.map(text => ({ kind: 'constraint', text, sourceRefs })), ...intent.actions.filter(action => action.intent === 'fact').map(action => ({ kind: action.arguments.kind, text: action.arguments.text, sourceRefs }))]
      accepted.push({ unitId: item.unit.id, expectedRevision: revision(item.data), commands, ...(commands.length ? {} : { outcome: 'ignored' }), topicFacts })
    }
    const result = await cmd('message.topic.intent.accept', { runId: first.run.runId, topicId, conversationId: topic.conversationId, inputRevision: topic.inputRevision, decisions: accepted }, `topic-intent-accept:${topicId}:${topic.inputRevision}:${randomUUID()}`)
    if (result.status === 'accepted') await Promise.all(prepared.map(item => dispatch(item.run.runId)))
    return result.status
  }
  async function scheduleTopics(conversationId) {
    if (!context.bindTopic || closed) return
    if ((await store.query({ kind: 'message.routing.pending', conversationId })).length) return
    for (const topic of await store.query({ kind: 'message.topic.pending', conversationId })) {
      if (topicFlights.has(topic.topicId)) {
        const scheduled = topicFlights.get(topic.topicId).then(() => closed ? undefined : scheduleTopics(conversationId))
        topicSchedules.add(scheduled)
        void scheduled.catch(() => {}).finally(() => topicSchedules.delete(scheduled))
        continue
      }
      const entries = await store.query({ kind: 'message.topic.units', topicId: topic.topicId })
      const snapshots = await Promise.all(entries.map(item => state(item.run.runId)))
      if (snapshots.some(data => data.run.status === 'needs_attention' || data.requests.some(request => request.status === 'pending' && entries.some(item => item.unit.id === request.unitId)))) continue
      let retry = false
      const flight = topicDrive(topic.topicId).then(status => { retry = status === 'WAIT_ROUTING' }).catch(async error => {
        retry = ['MESSAGE_TOPIC_STALE', 'MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(error.code)
        if (!closed && !['MESSAGE_TOPIC_STALE', 'MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(error.code)) {
          const entries = await store.query({ kind: 'message.topic.units', topicId: topic.topicId })
          if (entries[0]) await cmd('message.attention', { runId: entries[0].run.runId, reason: `MESSAGE_TOPIC_INTENT_FAILED:${error.code ?? error.message}` })
        }
      }).finally(async () => {
        try {
          if (closed) return
          const latest = await store.query({ kind: 'message.topic', topicId: topic.topicId })
          topicFlights.delete(topic.topicId)
          if (retry || latest?.inputRevision !== topic.inputRevision) {
            const scheduled = scheduleTopics(conversationId)
            topicSchedules.add(scheduled)
            void scheduled.catch(async error => {
              if (!closed && entries[0]) await cmd('message.attention', { runId: entries[0].run.runId, reason: `MESSAGE_TOPIC_SCHEDULE_FAILED:${error.code ?? error.message}` })
            }).finally(() => topicSchedules.delete(scheduled))
          }
        } finally { topicFlights.delete(topic.topicId) }
      })
      topicFlights.set(topic.topicId, flight)
    }
  }
  async function dispatch(runId) {
    const data = await state(runId)
    await Promise.all(data.commands.filter(command => !['applied', 'rejected', 'unknown', 'failed', 'running', 'superseded'].includes(command.status)).map(async command => {
      const action = { intent: command.kind, ...command.args }
      const info = { run: data.run, unit: data.units.find(unit => unit.unitId === command.unitId), binding: command.args.binding, commandId: command.commandId }
      const blocked = command.dependsOn?.find(id => data.commands.find(item => item.commandId === id)?.status === 'rejected')
      const validation = blocked ? { allowed: false, reason: '依赖动作已拒绝' } : await context.validateAction?.(action, info)
      if (validation?.allowed === false) {
        try { await cmd('message.command.reject', { commandId: command.commandId, reason: validation.reason }, `reject:${command.commandId}`) }
        catch (error) { if (!['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_STALE'].includes(error.code)) throw error }
        await dispatch(runId)
        return
      }
      const handler = command.kind === 'no_action' ? async () => ({ outcome: 'ignored' }) : handlers[command.kind]
      if (!handler) {
        await cmd('message.attention', { runId, reason: `UNSUPPORTED_HANDLER:${command.kind}:${command.commandId}` }, `unsupported:${command.commandId}`)
        return
      }
      let receipt
      try { receipt = await store.command({ id: `dispatch:${command.commandId}:${randomUUID()}`, kind: 'message.command.claim', args: { commandId: command.commandId } }) }
      catch (error) { if (['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_DEPENDENCY_PENDING', 'MESSAGE_INPUT_PENDING', 'MESSAGE_STALE'].includes(error.code)) return; throw error }
      if (!receipt.dispatchEligible || !receipt.result?.command) return
      const claimed = receipt.result.command
      try {
        const result = await handler(action, info)
        await cmd('message.command.complete', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, result })
      } catch (error) { await cmd('message.command.fail', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, error: error.code ?? error.message }); return }
      // 回执提交即唤醒其已就绪后继，不能等待同批其它慢动作或下一次恢复轮询。
      await dispatch(runId)
    }))
    const final = await state(runId)
    if (final.units.filter(item => item.status !== 'superseded').length && final.units.filter(item => item.status !== 'superseded').every(item => ['applied', 'ignored', 'rejected'].includes(item.status)) && !final.requests.some(item => item.status === 'pending')) {
      for (const barrier of final.barriers.filter(item => item.status === 'pending')) {
        await cmd('message.barrier.resolve', { runId, barrierId: barrier.id, resolution: 'all_units_applied_or_no_action' }, `barrier:${barrier.id}:resolve`)
        await context.onBarrierResolved?.(barrier, final)
      }
    }
  }
  async function drive(runId) {
    if (closed) return state(runId)
    let data = await state(runId)
    if (!data?.run || ['superseded', 'needs_attention', 'buffered'].includes(data.run.status)) return data
    if (data.run.status === 'settled') { await dispatch(runId); return state(runId) }
    if ((!data.run.context?.quoteRefs?.length || isPassiveTaskProgress(data.run.body)) && isQuietGroupMessage(data.run.body)) {
      const topic = isPassiveTaskProgress(data.run.body) ? await context.passiveTopic?.(data.run) : null
      await cmd('message.quiet', { runId, body: data.run.body, ...(topic ? { topic } : {}) }, `quiet:${runId}`)
      return state(runId)
    }
    if (data.run.correction) { await resegment(runId, data.run.correction.reason); return state(runId) }
    if (!data.run.snapshot) {
      const snapshot = await prepareMessageContext(data.run, context)
      await cmd('message.snapshot', { runId, snapshot }, `snapshot:${runId}`)
      data = await state(runId)
    }
    if (!data.units.length) {
      const followup = statusFollowup(data.run.snapshot)
      const text = data.run.body
      const shortReference = text.length <= 40 && /^这不是让你(?:去)?查/u.test(text.trim())
      const fixed = followup?.kind === 'scope' || directedStatusQuestion(text) || shortReference ? { kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: followup ? `前文状态问句：${data.run.snapshot.history.findLast(item=>item.sourceKey===followup.sourceKey)?.text ?? ''}；补充的问题范围：${text}` : text, constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: text.length, role: 'unit' }] } : undefined
      const result = await invoke(data, '$', 'S', splitContext(data.run.snapshot), fixed)
      if (!result) return state(runId)
      if (result.kind !== 'split') { await waiting(data, '$', 'S', result); return state(runId) }
      await cmd('message.split', { runId, expectedRevision: revision(data), units: result.units.map((unit, index) => ({ ...unit, unitId: `${runId}:u${index}`, sharedConstraints: result.sharedConstraints })) }, `split:${runId}:${revision(data)}`)
      data = await state(runId)
    }
    await Promise.all(data.units.map(unit => unitDrive(runId, unit)))
    await dispatch(runId)
    return state(runId)
  }
  function process(runId) {
    if (closed) return Promise.reject(new Error('MESSAGE_WORKFLOW_CLOSED'))
    if (!flights.has(runId)) {
      const flight = Promise.resolve().then(async () => {
        const data = await state(runId)
        const conversationId = data.run.conversationId
        if (!context.bindTopic) {
          const routed = legacyTail.then(async () => {
            if (data.run.status === 'pending' && !data.run.activatedAt) await cmd('message.activate', { runId }, `activate:${runId}`)
            return drive(runId)
          })
          legacyTail = routed.catch(() => {})
          return routed
        }
        const prior = routingTails.get(conversationId) ?? Promise.resolve()
        const routed = prior.catch(() => {}).then(async () => {
          if (data.run.status === 'pending' && !data.run.activatedAt) await cmd('message.activate', { runId }, `activate:${runId}`)
          const result = await drive(runId)
          await scheduleTopics(conversationId)
          return result
        })
        routingTails.set(conversationId, routed)
        try { return await routed } finally { if (routingTails.get(conversationId) === routed) routingTails.delete(conversationId) }
      }).catch(async error => {
      if (!closed && !['MESSAGE_STALE', 'MESSAGE_NODE_STALE'].includes(error.code)) await cmd('message.attention', { runId, reason: `MESSAGE_CONTEXT_OR_DISPATCH_FAILED:${error.code ?? error.message}` })
      return state(runId)
      }).finally(() => flights.delete(runId))
      flights.set(runId, flight)
    }
    return flights.get(runId)
  }
  async function recover() {
    const pending = await store.query({ kind: 'message.pending' })
    const results = []
    for (const run of pending) {
      results.push(await recoverOne(run))
    }
    if (context.bindTopic) for (const conversationId of new Set(pending.map(run => run.conversationId))) await scheduleTopics(conversationId)
    if (!quietReconciled && context.passiveTopic) {
      const quiet = await store.query({ kind: 'message.quiet.unbound', limit: 200 })
      for (const run of quiet.filter(item => isPassiveTaskProgress(item.body))) {
        const current = await store.query({ kind: 'message.source', sourceKey: run.sourceKey })
        if (current?.runId !== run.runId) continue
        const topic = await context.passiveTopic(run)
        if (topic) results.push(await cmd('message.quiet.topic.bind', { runId: run.runId, topic }, `quiet-topic:${run.runId}:${topic.topicId}`))
      }
      quietReconciled = true
    }
    return results
  }
  async function recoverOne(run) {
      if (run.context?.sourceMessageId && await store.query({ kind: 'message.outboundByMessage', conversationId: run.conversationId, messageId: run.context.sourceMessageId })) {
        try { await cmd('message.echo.quarantine', { runId: run.runId }, `echo-quarantine:${run.runId}`) }
        catch (error) { if (error.code !== 'MESSAGE_ECHO_QUARANTINE_FORBIDDEN') throw error }
        return
      }
      const readonly = await state(run.runId)
      const retryable = readonly.commands.filter(item => ['status', 'result'].includes(item.kind) && item.status === 'unknown' && item.error === 'INVALID_ARGUMENT' && !item.readonlyRetryCount)
      if (retryable.length && (run.status === 'pending' || run.status === 'needs_attention' && run.reason === 'recovery_exhausted')) {
        for (const command of retryable) await cmd('message.command.retry.readonly', { commandId: command.commandId }, `readonly-retry:${command.commandId}`)
        return process(run.runId)
      }
      if (run.status === 'needs_attention') {
        const stage = run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:S:$:') ? 'S' : run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:R:') ? 'R' : run.reason?.startsWith('MESSAGE_CONTEXT_CAPACITY:I:') ? 'I' : null
        const version = stage === 'S' ? 's-compact-v1' : stage === 'R' ? 'r-bounded-cards-v2' : stage === 'I' ? 'i-bounded-facts-v1' : null
        if (!version || run.capacityRetryVersion === version) return
        const retried = await cmd('message.capacity.retry', { runId: run.runId, projectionVersion: version }, `capacity-retry:${run.runId}:${version}`)
        if (!retried?.retry) return
        return process(run.runId)
      }
      const pendingState = await state(run.runId)
      if (pendingState.requests.some(request => request.status === 'pending')) {
        const data = pendingState
        for (const request of data.requests.filter(item => context.material && item.status === 'pending' && item.kind === 'needs_context')) {
          const material = await context.material({ run, unit: data.units.find(unit => unit.unitId === request.unitId), nodeId: request.nodeId, needs: request.needs })
          if (material?.ready) await cmd('message.wake', { runId: run.runId, requestId: request.id, eventId: `material:${request.id}:${digest(material.data ?? {})}`, actorId: run.actorId, answer: material.data ?? {} })
        }
        return process(run.runId)
      }
      if (context.bindTopic && pendingState.run.routingStatus === 'routing_complete') {
        await scheduleTopics(run.conversationId)
        return pendingState
      }
      if (run.activatedAt && Date.parse(run.deadline) <= clock()) {
        try { await cmd('message.recover', { runId: run.runId }) }
        catch (error) { if (['MESSAGE_RECOVERY_EXHAUSTED', 'MESSAGE_NOT_RECOVERABLE'].includes(error.code)) return; throw error }
      }
      return process(run.runId)
  }
  async function resume(input) { const result = await cmd('message.wake', input, `wake:${input.eventId}`); if (result?.run?.runId) { await process(result.run.runId); await waitForTopicFlight(result.run.runId) } return result }
  async function close() { closed = true; for (const controller of controllers) controller.abort(); for (const item of queue.splice(0)) item.reject(new Error('MESSAGE_WORKFLOW_CLOSED')); await Promise.allSettled([...flights.values(), ...topicFlights.values(), ...topicSchedules]) }
  return { receive, reprocess, process, recover, resume, state, close }
}
