import { acceptanceCriteriaSchema, taskTitleSchema } from './task-input-contract.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const argumentStrings = value => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(argumentStrings) : []
const referencesId = (value, id) => {
  let offset = value.indexOf(id)
  while (offset !== -1) {
    if (!/[A-Za-z0-9_+/-]/u.test(value[offset - 1] ?? '') && !/[A-Za-z0-9_+/-]/u.test(value[offset + id.length] ?? '')) return true
    offset = value.indexOf(id, offset + 1)
  }
  return false
}
// 仅匹配参数中实际写出的完整附件身份，不从业务语义推断材料依赖。
export function referencedResourceIds(value, attachments) {
  const strings = argumentStrings(value)
  return [...new Set(attachments.flatMap(attachment => [attachment.resourceRef, attachment.fileId, attachment.source?.resourceId]
    .filter(ref => typeof ref === 'string' && ref && strings.some(text => referencesId(text, ref)))))]
}
const materialRestriction = /禁止|不得|不能|不允许|仅限|只准|必须|除非|未经|不要|暂停|取消/u
function takeUtf8(text, maxBytes) {
  let result = '', bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    result += character; bytes += size
  }
  return result
}
export function projectMaterialText(text, maxBytes = 2400) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, complete: true, restrictions: text.split(/[。！？；\n]/u).filter(clause => /禁止|不得|仅限|只准|未经/u.test(clause)).map(clause => clause.trim()).filter(Boolean) }
  const clauses = []
  const chunkLimit = Math.min(400, Math.floor(maxBytes / 2))
  for (const match of text.matchAll(/[^。！？；\n]+[。！？；\n]*/gu)) {
    let chunk = '', offset = match.index
    for (const character of match[0]) {
      if (chunk && Buffer.byteLength(chunk) + Buffer.byteLength(character) > chunkLimit) {
        clauses.push({ offset, text: chunk })
        const overlap = Array.from(chunk).slice(-8).join('')
        offset += chunk.length - overlap.length; chunk = overlap
      }
      chunk += character
    }
    if (chunk) clauses.push({ offset, text: chunk })
  }
  const protectedClauses = clauses.filter(clause => materialRestriction.test(clause.text))
  const protectedBytes = Buffer.byteLength(protectedClauses.map(clause => clause.text).join(''))
  if (protectedBytes > maxBytes) return { capacityExceeded: true, reason: 'MATERIAL_REQUIRED_RESTRICTIONS_TOO_LARGE', resourceHash: digest(text) }
  const chosen = protectedClauses.length ? [...protectedClauses] : []
  for (const clause of [clauses[0], clauses.at(-1)]) {
    if (!clause || chosen.some(item => item.offset === clause.offset)) continue
    if (Buffer.byteLength(chosen.map(item => item.text).join('')) + Buffer.byteLength(clause.text) <= maxBytes) chosen.push(clause)
  }
  if (!chosen.length) chosen.push({ offset: 0, text: takeUtf8(text, maxBytes) })
  chosen.sort((a, b) => a.offset - b.offset)
  return { text: chosen.map(item => item.text).join(''), complete: false, originalBytes: Buffer.byteLength(text), resourceHash: digest(text), excerpts: chosen.map(item => ({ offset: item.offset, bytes: Buffer.byteLength(item.text) })), restrictions: chosen.filter(item => /禁止|不得|仅限|只准|未经/u.test(item.text)).map(item => item.text.trim()) }
}
const span = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
const need = z.strictObject({ resourceRef: z.string().min(1), reason: z.string().min(1) })
const wait = z.strictObject({ kind: z.enum(['needs_context', 'needs_clarification']), reason: z.string().min(1), needs: z.array(need).default([]), question: z.string().optional() })
// 当前协调提交专用；历史分阶段记录继续使用原 wait 合同。
export const coordinatorClarificationSchema = z.strictObject({
  kind: z.literal('needs_clarification'),
  reason: z.enum(['target_conflict', 'scope_conflict', 'required_parameter_missing', 'no_actionable_target']),
  question: z.string().trim().min(1), missingField: z.string().trim().min(1), blockedAction: z.string().trim().min(1),
  checkedSourceRefs: z.array(z.string().min(1)).min(1),
})
const argumentText = z.string().trim().min(1)
export const messageAnswerArguments = z.strictObject({ objective: argumentText })
export const fileDeliveryArguments = z.strictObject({ sourceQuote: argumentText,
  files: z.array(z.strictObject({ role: argumentText, fileName: argumentText })).min(1).max(20) })
export const taskWorkflowCatalog = Object.freeze([
  { id: 'task-group-file-delivery', label: '群聊文件交付', purpose: '将当前需求必交文件逐件发送到原任务群，下载核验原字节后才完成', mode: 'delivery' },
  { id: 'task-engineering', label: '代码开发', purpose: '承接明确开发目标，由Owner读取来源确定仓库与uat1至uat9环境；缺少参数时在工程准备前只询问该参数，禁止默认环境或main', mode: 'engineering' },
  { id: 'task-uat-deployment', label: 'UAT 部署', purpose: '将已合入UAT分支的精确提交部署到UAT环境', mode: 'external' },
  { id: 'task-main-pr-merge', label: '上线合并 main', purpose: 'UAT及业务验收完成并获上线批准后，独立合并精确PR至main', mode: 'external' },
  { id: 'task-uat-pr-merge', label: 'UAT PR 合并', purpose: '核验精确 PR 和必要检查后合并至 UAT 分支并回读来源', mode: 'external' },
  { id: 'task-production-release', label: '生产发布', purpose: '生产发布', mode: 'external' },
  { id: 'task-data-change', label: '数据变更', purpose: '数据变更', mode: 'external' },
  { id: 'task-data-change-approval-resume', label: '已有工单审批', purpose: '仅接续同任务已核验的未执行工单，按当前指令提交插件人工审批', mode: 'external' },
  { id: 'task-uat-rebuild', label: 'UAT 同提交重建', purpose: 'UAT同提交重建', mode: 'external' },
])
const externalWorkflowIds = taskWorkflowCatalog.filter(item => item.mode === 'external').map(item => item.id)
const stageAuthorizationSchema = z.union([
  z.strictObject({ workflowId: z.enum(externalWorkflowIds), sourceQuote: argumentText, objective: argumentText, gate: z.enum(['none', 'confirmation']) }),
  z.strictObject({ workflowId: z.enum(taskWorkflowCatalog.filter(item => item.mode !== 'external').map(item => item.id)), sourceQuote: argumentText, objective: argumentText.optional(), gate: z.enum(['none', 'confirmation']).optional() }),
])
const actionArguments = z.strictObject({ title: taskTitleSchema.optional(), fileDelivery: fileDeliveryArguments.optional(), objective: argumentText.optional(), workflowId: z.enum(taskWorkflowCatalog.map(item => item.id)).optional(), repositoryId: argumentText.optional(), uatEnvironment: z.enum(['uat1', 'uat2', 'uat3', 'uat4', 'uat5', 'uat6', 'uat7', 'uat8', 'uat9']).optional(), targetId: argumentText.optional(), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), pullRequestNumber: z.number().int().positive().optional(), headCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), releaseTag: z.string().regex(/^v\d{8}-[1-9]\d*$/).optional(), changeRef: argumentText.optional(), acceptanceCriteria: acceptanceCriteriaSchema.optional(), explicitStages: z.array(argumentText).max(8).optional(), stageAuthorizations: z.array(stageAuthorizationSchema).max(8).optional(), runId: argumentText.optional(), scope: z.enum(['conversation', 'task']).optional(), resultRef: argumentText.optional(), requestId: argumentText.optional(), answer: argumentText.optional(), decision: z.enum(['approved', 'rejected']).optional(), language: z.enum(['zh-CN', 'en-US']).optional(), kind: z.enum(['fact', 'constraint']).optional(), text: argumentText.optional() })
export const taskActionRequirements = Object.freeze({ create: ['objective'], research: ['objective'], reopen: ['objective'], revise: ['objective'],
  report: ['language'], clarification: ['runId', 'requestId', 'answer'], approval: ['requestId', 'decision'] })
const taskActionSchema = z.strictObject({ intent: z.enum(['no_action', 'fact', 'research', 'create', 'revise', 'report', 'pause', 'cancel', 'resume', 'status', 'result', 'reopen', 'approval', 'clarification']), arguments: actionArguments, dependsOn: z.array(z.number().int().nonnegative()) }).superRefine((action, ctx) => {
  const required = [...(taskActionRequirements[action.intent] ?? [])]
  if (externalWorkflowIds.includes(action.arguments.workflowId)
    && !action.arguments.stageAuthorizations?.some(item => item.workflowId === action.arguments.workflowId))
    ctx.addIssue({ code: 'custom', path: ['arguments', 'stageAuthorizations'], message: '外部 workflowId 必须提供对应完整阶段授权；objective逐字引用原文，gate明确none或confirmation' })
  for (const key of required) if (!action.arguments[key]) ctx.addIssue({ code: 'custom', path: ['arguments', key], message: `${action.intent} requires ${key}` })
})
const actionSchema = z.union([
  z.strictObject({ intent: z.literal('cancel_answer'), arguments: z.strictObject({ commandId: argumentText }), dependsOn: z.array(z.number().int().nonnegative()) }),
  z.strictObject({ intent: z.literal('answer'), arguments: messageAnswerArguments, dependsOn: z.array(z.number().int().nonnegative()) }),
  taskActionSchema,
])
const factRevisions = z.array(z.strictObject({ factId: z.string().min(1), sourceQuote: z.string().min(1), scope: z.string().min(1) })).max(32).optional()
export const messageSchemas = {
  material: z.strictObject({ kind: z.literal('material_facts'), complete: z.boolean(), facts: z.array(z.strictObject({ quote: z.string().min(1), kind: z.enum(['object', 'time', 'quantity', 'condition', 'restriction', 'revision', 'fact', 'uncertain']) })).max(24), reason: z.string() }),
  S: z.union([wait, z.strictObject({ kind: z.literal('no_action'), reason: z.string().min(1), coverage: z.array(span).min(1) }), z.strictObject({ kind: z.literal('split'), units: z.array(z.strictObject({ spans: z.array(span).min(1), goalText: z.string().min(1), constraints: z.array(z.string()), contextNeeds: z.array(need) })).min(1).max(8), sharedConstraints: z.array(z.string()), coverage: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(), role: z.enum(['unit', 'constraint', 'background', 'no_action']) })).min(1) })]),
  R: z.union([wait, z.strictObject({ kind: z.literal('binding'), queryScope: z.literal('agent_tasks').optional(), assessments: z.array(z.strictObject({ candidateId: z.string().min(1), relation: z.enum(['related', 'independent']), reason: z.string().min(1), sourceQuote: z.string().min(1) })).optional(), disposition: z.enum(['existing', 'new', 'context-only', 'conversation', 'unresolved']), candidateId: z.string().nullable(), evidence: z.array(z.string()).min(1) }), z.strictObject({ kind: z.literal('continue_candidates'), reason: z.string().min(1), evidence: z.array(z.string()).min(1), assessments: z.array(z.strictObject({ candidateId: z.string().min(1), relation: z.enum(['related', 'independent']), reason: z.string().min(1), sourceQuote: z.string().min(1) })).optional() }), z.strictObject({ kind: z.literal('no_action'), reason: z.string().min(1), sourceQuote: z.string().min(1) })]),
  I: z.union([wait, z.strictObject({ kind: z.literal('intent'), actions: z.array(actionSchema).min(1).max(8), constraints: z.array(z.string()), requiredExecutionMaterials: z.array(z.string()), replyPolicy: z.enum(['none', 'receipt', 'result']) }), z.strictObject({ kind: z.enum(['needs_relink', 'needs_resegmentation']), reason: z.string().min(1) })]),
  IB: z.union([wait, z.strictObject({ kind: z.literal('topic_intents'), decisions: z.array(z.strictObject({ unitId: z.string().min(1), intent: z.union([z.strictObject({ kind: z.literal('intent'), actions: z.array(actionSchema).min(1).max(8), constraints: z.array(z.string()), factRevisions, requiredExecutionMaterials: z.array(z.string()), replyPolicy: z.enum(['none', 'receipt', 'result']) }), z.strictObject({ kind: z.enum(['needs_relink', 'needs_resegmentation']), reason: z.string().min(1) }), wait]) })).min(1).max(32) })]),
}

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
export async function prepareMessageContext(run, context = {}) {
  const source = { sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, text: run.body, actorId: run.actorId, conversationId: run.conversationId }
  const history = (await context.history?.(run) ?? []).filter(item => item.delivered !== false && item.sourceKey !== run.sourceKey && (run.seq === undefined || item.seq === undefined || item.seq < run.seq)).slice(-30)
  // history/quotes are local snapshots only. Remote retrieval belongs to material work.
  const localQuotes = await Promise.all((run.context?.quoteRefs ?? []).map(async ref => await context.localQuote?.(ref, run) ?? ref))
  const quotes = localQuotes.map(ref => {
    if (typeof ref === 'string') return { sourceKey: ref, missing: true }
    if (ref.conversationId && ref.conversationId !== run.conversationId && !ref.readScope?.includes(run.actorId)) return { sourceKey: ref.sourceKey, missing: true, reason: 'read_scope_denied' }
    return { ...pick(ref, ['sourceKey', 'sourceVersion', 'text', 'bindings', 'readScope', 'disclosureScope', 'attachments']), missing: !ref.text }
  })
  const approved = history.filter(item => item.conversationId === undefined || item.conversationId === run.conversationId || item.readScope?.includes(run.actorId))
  const necessary = await context.splitBackground?.({ run, history: approved })
  const data = { source, sourceEdit: run.context?.editOf ?? null, historyManifest: approved.map(item => pick(item, ['sourceKey', 'sourceVersion', 'seq', 'bindings'])), history: Array.isArray(necessary) ? necessary : necessary?.messages ?? [], quotes, attachments: run.context?.attachments ?? [], policy: run.context?.compactPolicy ?? '', replyObligation: getReplyObligation(run), agentNames: context.agentNames?.() ?? run.context?.agentNames ?? [], actorPermissions: run.context?.actorPermissions ?? [], omissions: necessary?.omissions ?? (necessary === undefined && approved.length ? [{ reason: 'background_not_projected', sourceKeys: approved.map(item => item.sourceKey) }] : []) }
  return { ...data, snapshotId: digest(data) }
}

export function splitContext(snapshot) {
  const segments = Array.from(snapshot.source.text.matchAll(/[^\n。！？；!?;]+[\n。！？；!?;]*|[\n。！？；!?;]+/gu), (match, index) => ({ id: `fragment-${index}`, start: match.index, end: match.index + match[0].length }))
  const historyIds = new Map(snapshot.historyManifest.map((item, index) => [item.sourceKey, `h${index + 1}`]))
  const omitted = snapshot.omissions.flatMap(item => item.reason === 'background_budget' ? [historyIds.get(item.sourceKey) ?? item.sourceKey] : item.reason === 'background_not_projected' ? item.sourceKeys.map(key => historyIds.get(key) ?? key) : [item])
  // S 接收最小回应责任；业务准入与执行授权由 Host 独立核验。
  return { ...(snapshot.replyObligation ? { replyObligation: snapshot.replyObligation } : {}), snapshotId: snapshot.snapshotId, source: snapshot.source, sourceEdit: snapshot.sourceEdit, sourceLength: snapshot.source.text.length, segments, background: snapshot.history.map(item => ({ ...item, originalSourceKey: item.sourceKey, sourceKey: historyIds.get(item.sourceKey) ?? item.sourceKey })), quotes: snapshot.quotes, attachments: snapshot.attachments.map(item => pick(item, ['resourceRef', 'name', 'purpose', 'state'])), actorPermissions: snapshot.actorPermissions, omissions: omitted }
}
export function validateSplit(output, text) {
  if (!['split', 'no_action'].includes(output.kind)) return output
  const covered = new Uint8Array(text.length)
  for (const range of [...output.coverage, ...(output.units ?? []).flatMap(unit => unit.spans)]) {
    if (range.end > text.length || range.start >= range.end) throw new Error('MESSAGE_SOURCE_SPAN_INVALID')
  }
  for (const range of output.coverage) covered.fill(1, range.start, range.end)
  if (covered.some(value => !value)) throw new Error(`MESSAGE_SOURCE_COVERAGE_INCOMPLETE:sourceLength=${text.length};firstUncovered=${covered.findIndex(value => !value)}`)
  return output
}
export function unitContext(snapshot, unit) {
  const unitText = unit.spans.map(span => snapshot.source.text.slice(span.start, span.end)).join('\n')
  const unitDirected = snapshot.replyObligation?.required === true && (unitText === snapshot.source.text || (snapshot.agentNames ?? []).some(name => name && unitText.includes(name)))
  const aliases = new Map((snapshot.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
  return { ...(snapshot.replyObligation ? { replyObligation: { ...snapshot.replyObligation, required: unitDirected } } : {}), agentNames: snapshot.agentNames ?? [], groupResponsibility: snapshot.policy ?? '', snapshotId: snapshot.snapshotId, sourceEdit: snapshot.sourceEdit, actorId: snapshot.source.actorId, conversationId: snapshot.source.conversationId, sourceKey: snapshot.source.sourceKey, sourceVersion: snapshot.source.sourceVersion, text: unit.spans.map(span => snapshot.source.text.slice(span.start, span.end)).join('\n'), sourceSpans: unit.spans, sourceSegments: unit.spans.map(span => snapshot.source.text.slice(span.start, span.end)), goalText: unit.goalText, constraints: unit.constraints, sharedConstraints: unit.sharedConstraints ?? [], referenceSources: snapshot.quotes, executionMaterialRefs: [...[...(snapshot.attachments ?? []), ...[...(snapshot.history ?? []), ...(snapshot.quotes ?? [])].flatMap(item => item.attachments ?? [])].map(item => item.resourceRef), ...(unit.contextNeeds ?? []).map(item => aliases.get(item.resourceRef) ?? item.resourceRef)] }
}
export function candidateCards(candidates) {
  if (candidates.length > 10000) throw new Error('MESSAGE_CANDIDATE_CAPACITY')
  return candidates.map((candidate, index) => {
    const card = pick(candidate, ['candidateId', 'engine', 'topicId', 'taskId', 'runId', 'resultRef', 'title', 'topicTitle', 'summary', 'goal', 'historyRef', 'detailRef', 'entityKeys', 'scope', 'state', 'relevantTime', 'explicitReferenceMatches', 'distinguishingFacts', 'sourceRefs', 'versions'])
    const omissions = []
    // 未被本次引用的历史来源只参与 Host 召回，不重复塞进 R 的身份卡。
    if (card.sourceRefs?.length) {
      const explicit = new Set(card.explicitReferenceMatches ?? [])
      const omitted = card.sourceRefs.filter(ref => !explicit.has(ref)).length
      card.sourceRefs = card.sourceRefs.filter(ref => explicit.has(ref))
      if (omitted) omissions.push({ field: 'sourceRefs', count: omitted })
    }
    // 标题只是召回线索；目标原文由可回读的 detailRef 投影，不截掉尾部限制。
    for (const [key, size] of [['title', 32]]) {
      if (typeof card[key] !== 'string') continue
      if (key === 'title' && card.title === card.goal) { delete card.title; continue }
      if (Array.from(card[key]).length > size) { omissions.push({ field: key, length: card[key].length, hash: digest(card[key]) }); card[key] = Array.from(card[key]).slice(0, size).join('') }
    }
    if (card.detailRef && typeof card.goal === 'string') {
      const projection = projectMaterialText(card.goal, 520)
      if (!projection.capacityExceeded && !projection.complete) {
        omissions.push({ field: 'goal', length: card.goal.length, hash: projection.resourceHash, resourceRef: card.detailRef })
        card.goal = projection.text
      }
    }
    if (card.detailRef && Array.isArray(card.distinguishingFacts)) {
      card.distinguishingFacts = card.distinguishingFacts.map((fact, factIndex) => {
        const projection = projectMaterialText(fact, 420)
        if (projection.capacityExceeded) return fact
        if (!projection.complete) omissions.push({ field: `distinguishingFacts[${factIndex}]`, length: fact.length, hash: projection.resourceHash, resourceRef: card.detailRef })
        return projection.text
      })
    }
    return omissions.length ? { ...card, omissions } : card
  })
}

// Host 的 binding.target 是派发时使用的同一身份卡副本，模型只需一份完整关联结果。
// 此投影不裁剪目标字段、原文、约束或事实；稳定身份仍保留在 binding 顶层。
export function intentContext(base, binding, facts, responsibility = '', candidates = [], resolvedEvidence = [], { sharedTopic = false } = {}) {
  const { target, ...identity } = binding
  const summaries = candidates.slice(0,4).map(item => pick(item,['candidateId','engine','taskId','title','state','relevantTime']))
  const effectiveFacts = facts?.topic?.facts ? { ...facts, topic: { ...facts.topic, facts: facts.topic.facts.filter(fact => fact.status !== 'invalidated') } } : facts
  const scopedFacts = sharedTopic && effectiveFacts?.topic ? { ...effectiveFacts, topic: { topicId: effectiveFacts.topic.topicId, contextRevision: effectiveFacts.topic.contextRevision ?? effectiveFacts.topic.revision } } : effectiveFacts
  const executionMaterialRefs = [...new Set([base.sourceKey, ...(base.executionMaterialRefs ?? []),
    ...(base.referenceSources ?? []).map(item => item.sourceKey),
    ...(base.material?.resources ?? []).map(item => item.resourceRef),
    ...resolvedEvidence.flatMap(item => (item.needs ?? []).map(need => need.resourceRef)),
    binding.historyRef, binding.detailRef, target?.historyRef, target?.detailRef,
    ...(effectiveFacts?.topic?.facts ?? []).flatMap(fact => (fact.sourceRefs ?? []).map(ref => ref.sourceKey)),
  ].filter(ref => typeof ref === 'string' && ref.length > 0))]
  return { ...base, executionMaterialRefs, binding: { ...target, ...identity }, facts: scopedFacts, ...(resolvedEvidence.length ? { resolvedEvidence } : {}), ...(binding.disposition === 'conversation' ? { candidates: summaries } : {}), ...(responsibility ? { groupResponsibility: responsibility } : {}) }
}

// IB 共用完全相同的任务事实；每个事项只保留自身原有事实的引用。
export function shareTopicContext(input) {
  const sharedTasks = {}
  const reference = task => {
    if (!task || typeof task !== 'object' || !task.taskId) return task
    const ref = `task-facts:${digest(task)}`
    sharedTasks[ref] = task
    return { taskId: task.taskId, ...(task.factVersion === undefined ? {} : { factVersion: task.factVersion }), ref }
  }
  const units = input.units.map(unit => {
    const facts = unit.input.facts
    if (!facts) return { ...unit, input: { ...unit.input } }
    return { ...unit, input: { ...unit.input, facts: { ...facts,
      ...(facts.task ? { task: reference(facts.task) } : {}),
      ...(Array.isArray(facts.tasks) ? { tasks: facts.tasks.map(reference) } : {}),
      ...(Array.isArray(facts.topicTasks?.tasks) ? { topicTasks: { ...facts.topicTasks, tasks: facts.topicTasks.tasks.map(reference) } } : {}),
    } } }
  })
  const material = value => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(material)
    const result = { ...value }
    if (Array.isArray(value.resources)) result.resources = value.resources.map(material)
    if (typeof value.resourceRef === 'string' && value.resourceRef.startsWith('workflow-task-history:') && typeof value.text === 'string') {
      try {
        const task = JSON.parse(value.text), ref = `task-facts:${digest(task)}`
        if (task?.taskId && value.resourceRef === `workflow-task-history:${task.taskId}`
          && JSON.stringify(task) === value.text && Object.hasOwn(sharedTasks, ref)) {
          delete result.text
          result.taskFactsRef = ref
        }
      } catch { /* 非原生完整 JSON 保留原文。 */ }
    }
    return result
  }
  for (const unit of units) if (unit.input.resolvedEvidence) unit.input = { ...unit.input,
    resolvedEvidence: unit.input.resolvedEvidence.map(evidence => ({ ...evidence, answer: material(evidence.answer) })) }
  const topic = input.sharedTopic
  const sharedTopic = topic?.facts ? { ...topic, facts: topic.facts.map(fact => {
    const result = { ...fact }, sources = topic.sources ?? []
    const matches = (fact.sourceRefs ?? []).map(ref => sources.flatMap((source, index) =>
      source.sourceKey === ref.sourceKey && source.sourceVersion === ref.sourceVersion ? [index] : []))
    if (matches.length === 1 && matches[0].length === 1 && typeof fact.text === 'string'
      && sources[matches[0][0]].text === fact.text) { delete result.text; result.textFromSource = true }
    if (matches.length && matches.every(indexes => indexes.length === 1)
      && fact.sourceRefs.every(ref => Object.keys(ref).length === 2 && Object.hasOwn(ref, 'sourceKey') && Object.hasOwn(ref, 'sourceVersion'))) {
      delete result.sourceRefs
      result.sourceIndexes = matches.map(indexes => indexes[0])
    }
    if (typeof fact.actorId === 'string' && fact.actorId.length && fact.actorId === topic.actorId) {
      delete result.actorId; result.actorFromTopic = true
    }
    return result
  }) } : topic
  const responsibility = units[0]?.input.groupResponsibility
  const sharedResponsibility = typeof responsibility === 'string' && responsibility.length > 0 && units.every(unit => unit.input.groupResponsibility === responsibility)
  const projected = units.map(unit => {
    if (!sharedResponsibility) return unit
    const { groupResponsibility, ...rest } = unit.input
    return { ...unit, input: rest }
  })
  return { ...input, ...(Object.keys(sharedTasks).length ? { sharedTasks } : {}), units: projected,
    ...(sharedTopic ? { sharedTopic } : {}), ...(sharedResponsibility ? { groupResponsibility: responsibility } : {}) }
}

// 材料引用由 Host 提供；模型描述的查询目标不能变成启动前依赖。
export function validateExecutionMaterialRefs(stage, output, input) {
  const validate = (intent, context) => {
    if (intent.kind !== 'intent') return
    const sourceTexts = context?.sourceSegments ?? [context?.text]
    for (const action of intent.actions) for (const authorization of action.arguments.stageAuthorizations ?? []) {
      if (externalWorkflowIds.includes(authorization.workflowId)
        && (typeof authorization.objective !== 'string' || !authorization.objective.trim() || !['none', 'confirmation'].includes(authorization.gate)))
        throw new Error('MESSAGE_STAGE_AUTHORIZATION_INVALID:外部阶段授权objective和gate必填；objective逐字引用sourceQuote，gate明确none或confirmation，不代替插件真人审批')
      if (!sourceTexts.some(text => typeof text === 'string' && text.includes(authorization.sourceQuote))
        || authorization.objective && !authorization.sourceQuote.includes(authorization.objective))
        throw new Error('MESSAGE_STAGE_AUTHORIZATION_INVALID:stageAuthorizations.sourceQuote必须逐字连续引用当前事项原文；objective必须逐字连续引用该sourceQuote中的片段，不得概括、改写或拼接')
    }
    const known = new Set(context?.executionMaterialRefs ?? [])
    if (intent.requiredExecutionMaterials.some(ref => !known.has(ref)))
      throw new Error('MESSAGE_EXECUTION_MATERIAL_REF_INVALID:requiredExecutionMaterials只能选当前事项executionMaterialRefs；查询资源及待取得证据写入目标或acceptanceCriteria')
  }
  if (stage === 'I') validate(output, input)
  if (stage === 'IB' && output.kind === 'topic_intents') for (const decision of output.decisions)
    validate(decision.intent, input.units.find(unit => unit.unitId === decision.unitId)?.input)
}

// 点名只建立回应义务，不授予生产执行权限，也不要求创建 Task。
export function getReplyObligation(run) {
  const context = run.context ?? {}
  return { required: context.directedToAgent === true, reason: context.directedToAgent === true ? 'direct_agent_address' : 'no_direct_address', sourceKey: run.sourceKey, sourceVersion: run.sourceVersion }
}

export function validateContextRequests(stage, output, input) {
  if (!['S', 'R'].includes(stage)) return
  const known = new Set([input.source?.sourceKey, input.sourceKey, ...(input.executionMaterialRefs ?? [])].filter(Boolean))
  for (const key of ['quotes', 'referenceSources', 'background', 'recentMessages', 'attachments', 'candidates']) for (const item of input[key] ?? []) {
    for (const field of ['sourceKey', 'resourceRef', 'historyRef', 'detailRef']) if (item[field]) known.add(item[field])
    for (const resource of item.attachments ?? []) if (resource.resourceRef) known.add(resource.resourceRef)
  }
  for (const omitted of input.omissions ?? []) if (typeof omitted === 'string') known.add(omitted)
  for (const ref of input.availableResourceRefs ?? []) known.add(ref)
  const needs = [...(output.kind === 'needs_context' ? output.needs : []), ...(output.units ?? []).flatMap(unit => unit.contextNeeds ?? [])]
  if (needs.some(need => !known.has(need.resourceRef))) throw new Error('MESSAGE_CONTEXT_RESOURCE_REF_INVALID:只能使用当前输入的精确资源键；候选翻页使用continue_candidates')
  if (stage === 'R' && output.kind === 'no_action' && input.replyObligation?.required === true) throw new Error('MESSAGE_SCOPE_PROOF_INVALID:Host已确认当前消息明确指向助手，不可当作人际闲聊静默退出；请正常关联交办事项')
  if (stage === 'R' && output.kind === 'no_action' && !(input.sourceSegments ?? [input.text]).some(text => text === output.sourceQuote)) throw new Error('MESSAGE_SCOPE_PROOF_INVALID:静默退出必须引用当前事项连续原文')
  if (output.kind === 'continue_candidates' && !input.candidateContinuation) throw new Error('MESSAGE_CANDIDATE_CONTINUATION_UNAVAILABLE')
  if (output.kind === 'binding' && output.disposition === 'conversation' && output.queryScope !== 'agent_tasks') throw new Error('MESSAGE_CONVERSATION_SCOPE_REQUIRED')
  if (output.assessments) {
    const ids = new Set((input.candidates ?? []).map(item => item.candidateId))
    const texts = [...(input.sourceSegments ?? [input.text]), ...(input.referenceSources ?? []).map(item => item.text)].filter(text => typeof text === 'string')
    if (new Set(output.assessments.map(item => item.candidateId)).size !== output.assessments.length
      || output.assessments.some(item => !ids.has(item.candidateId) || !texts.some(text => text.includes(item.sourceQuote)))) throw new Error('MESSAGE_SCOPE_PROOF_INVALID')
  }
}
