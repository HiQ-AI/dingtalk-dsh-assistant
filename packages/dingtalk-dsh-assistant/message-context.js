import { createHash } from 'node:crypto'
import { z } from 'zod'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const span = z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
const need = z.strictObject({ resourceRef: z.string().min(1), reason: z.string().min(1) })
const wait = z.strictObject({ kind: z.enum(['needs_context', 'needs_clarification']), reason: z.string().min(1), needs: z.array(need).default([]), question: z.string().optional() })
const argumentText = z.string().trim().min(1)
const actionArguments = z.strictObject({ objective: argumentText.optional(), workflowId: z.enum(['task-analysis', 'task-engineering']).optional(), repositoryId: argumentText.optional(), acceptanceCriteria: z.array(argumentText).optional(), runId: argumentText.optional(), scope: z.enum(['conversation', 'task']).optional(), resultRef: argumentText.optional(), requestId: argumentText.optional(), answer: argumentText.optional(), kind: z.enum(['fact', 'constraint']).optional(), text: argumentText.optional() })
const actionSchema = z.strictObject({ intent: z.enum(['no_action', 'fact', 'answer', 'research', 'create', 'revise', 'pause', 'cancel', 'resume', 'status', 'result', 'reopen', 'approval', 'clarification']), arguments: actionArguments, dependsOn: z.array(z.number().int().nonnegative()) }).superRefine((action, ctx) => {
  const required = ['create', 'research', 'reopen'].includes(action.intent) ? ['objective', 'workflowId'] : action.intent === 'revise' ? ['objective'] : action.intent === 'clarification' ? ['runId', 'requestId', 'answer'] : []
  if (action.arguments.workflowId === 'task-engineering') required.push('repositoryId')
  for (const key of required) if (!action.arguments[key]) ctx.addIssue({ code: 'custom', path: ['arguments', key], message: `${action.intent} requires ${key}` })
})
export const messageSchemas = {
  S: z.union([wait, z.strictObject({ kind: z.literal('split'), units: z.array(z.strictObject({ spans: z.array(span).min(1), goalText: z.string().min(1), constraints: z.array(z.string()), contextNeeds: z.array(need) })).min(1).max(8), sharedConstraints: z.array(z.string()), coverage: z.array(z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(), role: z.enum(['unit', 'constraint', 'background', 'no_action']) })).min(1) })]),
  R: z.union([wait, z.strictObject({ kind: z.literal('binding'), disposition: z.enum(['existing', 'new', 'context-only', 'conversation', 'unresolved']), candidateId: z.string().nullable(), evidence: z.array(z.string()).min(1) })]),
  I: z.union([wait, z.strictObject({ kind: z.literal('intent'), actions: z.array(actionSchema).min(1).max(8), constraints: z.array(z.string()), requiredExecutionMaterials: z.array(z.string()), replyPolicy: z.enum(['none', 'receipt', 'result']) }), z.strictObject({ kind: z.enum(['needs_relink', 'needs_resegmentation']), reason: z.string().min(1) })]),
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
  const segments = Array.from(snapshot.source.text.matchAll(/[^\n。！？；!?;]+[\n。！？；!?;]*|[\n。！？；!?;]+/gu), (match, index) => ({ id: `fragment-${index}`, start: match.index, end: match.index + match[0].length, text: match[0] }))
  return { snapshotId: snapshot.snapshotId, source: snapshot.source, sourceEdit: snapshot.sourceEdit, sourceLength: snapshot.source.text.length, segments, background: snapshot.history, quotes: snapshot.quotes, attachments: snapshot.attachments.map(item => pick(item, ['resourceRef', 'name', 'purpose', 'state'])), policy: snapshot.policy, actorPermissions: snapshot.actorPermissions, omissions: snapshot.omissions }
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
  return candidates.map(candidate => {
    const card = pick(candidate, ['candidateId', 'engine', 'topicId', 'taskId', 'runId', 'resultRef', 'title', 'goal', 'entityKeys', 'scope', 'state', 'relevantTime', 'explicitReferenceMatches', 'distinguishingFacts', 'sourceRefs', 'versions'])
    const omissions = []
    // 标题只是召回线索，不能挤占稳定身份和关键判别事实。截掉的字段显式留缺口。
    for (const [key, size] of [['title', 32], ['goal', 64]]) {
      if (typeof card[key] !== 'string') continue
      if (key === 'title' && card.title === card.goal) { delete card.title; continue }
      if (Array.from(card[key]).length > size) { omissions.push({ field: key, length: card[key].length, hash: digest(card[key]) }); card[key] = Array.from(card[key]).slice(0, size).join('') }
    }
    return omissions.length ? { ...card, omissions } : card
  })
}

// Host 的 binding.target 是派发时使用的同一身份卡副本，模型只需一份完整关联结果。
// 此投影不裁剪目标字段、原文、约束或事实；稳定身份仍保留在 binding 顶层。
export function intentContext(base, binding, facts) {
  const { target, ...identity } = binding
  return { ...base, binding: { ...target, ...identity }, facts }
}
