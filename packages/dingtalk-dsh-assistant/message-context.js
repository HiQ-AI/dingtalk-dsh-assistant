import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readOnlyTaskCatalog } from './task-readonly-workflows.js'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
const argumentText = z.string().trim().min(1)
export const taskWorkflowCatalog = Object.freeze([
  { id: 'task-analysis', label: '材料分析', purpose: '已给材料分析', mode: 'read-only' },
  ...readOnlyTaskCatalog.map(({ id, purpose }) => ({ id, label: ({ 'task-investigation': '问题排查', 'task-planning': '方案设计', 'task-pr-review': 'PR 评审', 'task-data-query': '数据口径审查', 'task-retrospective': '任务复盘' })[id], purpose, mode: 'read-only' })),
  { id: 'task-engineering', label: '代码开发', purpose: '登记仓库开发并提交PR', mode: 'engineering' },
  { id: 'task-general', label: '通用任务', purpose: '受控的未固化任务', mode: 'general' },
  { id: 'task-uat-delivery', label: 'UAT 交付', purpose: 'UAT交付', mode: 'external' },
  { id: 'task-production-release', label: '生产发布', purpose: '生产发布', mode: 'external' },
  { id: 'task-data-change', label: '数据变更', purpose: '数据变更', mode: 'external' },
  { id: 'task-uat-rebuild', label: 'UAT 同提交重建', purpose: 'UAT同提交重建', mode: 'external' },
])
const actionArguments = z.strictObject({ objective: argumentText.optional(), workflowId: z.enum(taskWorkflowCatalog.map(item => item.id)).optional(), workflowPlan: z.array(z.strictObject({ workflowId: z.enum(taskWorkflowCatalog.map(item => item.id)), gate: z.enum(['none', 'confirmation']) })).min(1).max(4).optional(), repositoryId: argumentText.optional(), targetId: argumentText.optional(), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), releaseTag: z.string().regex(/^v\d{8}-[1-9]\d*$/).optional(), changeRef: argumentText.optional(), acceptanceCriteria: z.array(argumentText).optional(), runId: argumentText.optional(), scope: z.enum(['conversation', 'task']).optional(), resultRef: argumentText.optional(), requestId: argumentText.optional(), answer: argumentText.optional(), decision: z.enum(['approved', 'rejected']).optional(), kind: z.enum(['fact', 'constraint']).optional(), text: argumentText.optional() })
const actionSchema = z.strictObject({ intent: z.enum(['no_action', 'fact', 'answer', 'research', 'create', 'revise', 'pause', 'cancel', 'resume', 'status', 'result', 'reopen', 'approval', 'clarification']), arguments: actionArguments, dependsOn: z.array(z.number().int().nonnegative()) }).superRefine((action, ctx) => {
  const required = ['create', 'research', 'reopen'].includes(action.intent) ? ['objective', 'workflowId'] : action.intent === 'revise' ? ['objective'] : action.intent === 'clarification' ? ['runId', 'requestId', 'answer'] : action.intent === 'approval' ? ['requestId', 'decision'] : []
  if (action.arguments.workflowId === 'task-engineering') required.push('repositoryId')
  if (action.arguments.workflowPlan && action.arguments.workflowPlan[0].workflowId !== action.arguments.workflowId) ctx.addIssue({ code: 'custom', path: ['arguments', 'workflowPlan'], message: 'workflowPlan must start with workflowId' })
  for (const key of required) if (!action.arguments[key]) ctx.addIssue({ code: 'custom', path: ['arguments', key], message: `${action.intent} requires ${key}` })
})
export const messageSchemas = {
  S: z.union([wait, z.strictObject({ kind: z.literal('split'), units: z.array(z.strictObject({ spans: z.array(span).min(1), goalText: z.string().min(1), constraints: z.array(z.string()), contextNeeds: z.array(need) })).min(1).max(8), sharedConstraints: z.array(z.string()), coverage: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(), role: z.enum(['unit', 'constraint', 'background', 'no_action']) })).min(1) })]),
  R: z.union([wait, z.strictObject({ kind: z.literal('binding'), disposition: z.enum(['existing', 'new', 'context-only', 'conversation', 'unresolved']), candidateId: z.string().nullable(), evidence: z.array(z.string()).min(1) })]),
  I: z.union([wait, z.strictObject({ kind: z.literal('intent'), actions: z.array(actionSchema).min(1).max(8), constraints: z.array(z.string()), requiredExecutionMaterials: z.array(z.string()), replyPolicy: z.enum(['none', 'receipt', 'result']) }), z.strictObject({ kind: z.enum(['needs_relink', 'needs_resegmentation']), reason: z.string().min(1) })]),
  IB: z.union([wait, z.strictObject({ kind: z.literal('topic_intents'), decisions: z.array(z.strictObject({ unitId: z.string().min(1), intent: z.union([z.strictObject({ kind: z.literal('intent'), actions: z.array(actionSchema).min(1).max(8), constraints: z.array(z.string()), requiredExecutionMaterials: z.array(z.string()), replyPolicy: z.enum(['none', 'receipt', 'result']) }), z.strictObject({ kind: z.enum(['needs_relink', 'needs_resegmentation']), reason: z.string().min(1) }), wait]) })).min(1).max(32) })]),
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
    return { ...pick(ref, ['sourceKey', 'sourceVersion', 'text', 'bindings', 'readScope', 'disclosureScope']), missing: !ref.text }
  })
  const approved = history.filter(item => item.conversationId === undefined || item.conversationId === run.conversationId || item.readScope?.includes(run.actorId))
  const necessary = await context.splitBackground?.({ run, history: approved })
  const data = { source, sourceEdit: run.context?.editOf ?? null, historyManifest: approved.map(item => pick(item, ['sourceKey', 'sourceVersion', 'seq', 'bindings'])), history: Array.isArray(necessary) ? necessary : necessary?.messages ?? [], quotes, attachments: run.context?.attachments ?? [], policy: run.context?.compactPolicy ?? '', actorPermissions: run.context?.actorPermissions ?? [], omissions: necessary?.omissions ?? (necessary === undefined && approved.length ? [{ reason: 'background_not_projected', sourceKeys: approved.map(item => item.sourceKey) }] : []) }
  return { ...data, snapshotId: digest(data) }
}

export function splitContext(snapshot) {
  const segments = Array.from(snapshot.source.text.matchAll(/[^\n。！？；!?;]+[\n。！？；!?;]*|[\n。！？；!?;]+/gu), (match, index) => ({ id: `fragment-${index}`, start: match.index, end: match.index + match[0].length }))
  const historyIds = new Map(snapshot.historyManifest.map((item, index) => [item.sourceKey, `h${index + 1}`]))
  const omitted = snapshot.omissions.flatMap(item => item.reason === 'background_budget' ? [historyIds.get(item.sourceKey) ?? item.sourceKey] : item.reason === 'background_not_projected' ? item.sourceKeys.map(key => historyIds.get(key) ?? key) : [item])
  // S 只拆分事项；群职责留在持久快照中，不占用拆分节点的输入预算。
  return { snapshotId: snapshot.snapshotId, source: snapshot.source, sourceEdit: snapshot.sourceEdit, sourceLength: snapshot.source.text.length, segments, background: snapshot.history.map(item => ({ ...item, sourceKey: historyIds.get(item.sourceKey) ?? item.sourceKey })), quotes: snapshot.quotes, attachments: snapshot.attachments.map(item => pick(item, ['resourceRef', 'name', 'purpose', 'state'])), actorPermissions: snapshot.actorPermissions, omissions: omitted }
}
export function validateSplit(output, text) {
  if (output.kind !== 'split') return output
  const covered = new Uint8Array(text.length)
  for (const range of [...output.coverage, ...output.units.flatMap(unit => unit.spans)]) {
    if (range.end > text.length || range.start >= range.end) throw new Error('MESSAGE_SOURCE_SPAN_INVALID')
  }
  for (const range of output.coverage) covered.fill(1, range.start, range.end)
  if (covered.some(value => !value)) throw new Error(`MESSAGE_SOURCE_COVERAGE_INCOMPLETE:sourceLength=${text.length};firstUncovered=${covered.findIndex(value => !value)}`)
  return output
}
export function unitContext(snapshot, unit) {
  return { snapshotId: snapshot.snapshotId, sourceEdit: snapshot.sourceEdit, actorId: snapshot.source.actorId, conversationId: snapshot.source.conversationId, sourceKey: snapshot.source.sourceKey, sourceVersion: snapshot.source.sourceVersion, text: unit.spans.map(span => snapshot.source.text.slice(span.start, span.end)).join('\n'), sourceSpans: unit.spans, goalText: unit.goalText, constraints: unit.constraints, sharedConstraints: unit.sharedConstraints ?? [], referenceSources: snapshot.quotes }
}
export function candidateCards(candidates) {
  if (candidates.length > 8) throw new Error('MESSAGE_CANDIDATE_CAPACITY')
  return candidates.map((candidate, index) => {
    const card = pick(candidate, ['candidateId', 'engine', 'topicId', 'taskId', 'runId', 'resultRef', 'title', 'goal', 'historyRef', 'detailRef', 'entityKeys', 'scope', 'state', 'relevantTime', 'explicitReferenceMatches', 'distinguishingFacts', 'sourceRefs', 'versions'])
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
export function intentContext(base, binding, facts, responsibility = '', candidates = [], resolvedEvidence = []) {
  const { target, ...identity } = binding
  const summaries = candidates.slice(0,4).map(item => pick(item,['candidateId','engine','taskId','title','state','relevantTime']))
  return { ...base, binding: { ...target, ...identity }, facts, ...(resolvedEvidence.length ? { resolvedEvidence } : {}), ...(binding.disposition === 'conversation' ? { candidates: summaries } : {}), ...(responsibility ? { groupResponsibility: responsibility } : {}) }
}
