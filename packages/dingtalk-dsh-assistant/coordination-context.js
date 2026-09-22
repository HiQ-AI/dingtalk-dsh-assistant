import { fingerprint } from './topic-model.js'
import { z } from 'zod'
const projections = new WeakMap()

// 只读取 DSH 当前 surface 上的工具结果；原始事件日志、压缩摘要和模型复述不构成正文可见证明。
export function visibleToolOutputs(agent) {
  const session = agent?.session
  const generation = session?.surface && `${session.surface.replaceGeneration}:${session.surface.nodes.length}`
  const previous = session && projections.get(session)
  if (generation !== undefined && previous?.generation === generation) return previous.outputs
  const outputs = []
  const messages = agent?.session?.deriveMessages?.() ?? []
  const calls = new Map(messages.flatMap((message) => message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => [block.id, block.name]))
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-result' || block.isError || !['group_task_prompt_get', 'group_task_review_context_get', 'group_decision_context_get', 'group_topic_context_get'].includes(calls.get(block.toolCallId))) continue
      const text = (block.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
      try { outputs.push(JSON.parse(text)) } catch { /* 非 JSON 工具结果不能证明结构化内容身份。 */ }
    }
  }
  if (session && generation !== undefined) projections.set(session, { generation, outputs })
  return outputs
}

export const promptContent = ({ id, name, description, prompt, revision }) => ({ id, name, description, prompt, revision })
export function visiblePromptRefs(agent, prompts) {
  const visible = new Set(visibleToolOutputs(agent).flatMap((out) => out.prompts ?? []).filter((item) => typeof item.prompt === 'string').map((item) => fingerprint(promptContent(item))))
  return prompts.filter((prompt) => visible.has(fingerprint(promptContent(prompt)))).map(({ id, revision }) => ({ id, revision }))
}

export function visibleSectionLength(agent, text) {
  const pages = visibleToolOutputs(agent).filter((out) => typeof out.text === 'string' && Number.isInteger(out.offset) && Number.isInteger(out.nextOffset)
    && out.nextOffset > out.offset && text.slice(out.offset, out.nextOffset) === out.text)
  let offset = 0
  while (true) {
    const next = Math.max(offset, ...pages.filter((page) => page.offset <= offset).map((page) => page.nextOffset))
    if (next === offset) return offset
    offset = next
  }
}

export function visibleCoordinatorText(agent, text) {
  return agent?.session?.deriveMessages?.().some((message) => message.role === 'user' && message.source?.kind === 'coordinator'
    && message.content?.some((part) => part.type === 'text' && part.text === text)) ?? false
}

// 仅在同一请求的首包内去重；原 section 保持完整，分页及当前 surface 校验仍读取原文。
export function compactSectionValue(request, section, value) {
  request.inlineMaterials ??= new Map()
  const visit = (item, path) => {
    const text = JSON.stringify(item)
    if (text && text.length >= 120) {
      const digest = fingerprint(text)
      const previous = request.inlineMaterials.get(digest)
      if (previous && previous.section !== section && previous.text === text) return {
        materialRef: { requestId: request.requestId, section: previous.section, path: previous.path, contentFingerprint: digest },
      }
      if (!previous) request.inlineMaterials.set(digest, { section, path, text })
    }
    if (Array.isArray(item)) return item.map((entry, index) => visit(entry, [...path, index]))
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, [...path, key])]))
    return item
  }
  return visit(value, [])
}

const manifestInputSchema = z.object({
  requestId: z.string().min(1),
  materials: z.array(z.object({
    id: z.string().min(1), version: z.number().int().positive(), text: z.string().optional(), missingReason: z.string().min(1).optional(),
    pages: z.array(z.object({ offset: z.number().int().nonnegative(), text: z.string() }).strict()).default([]),
  }).strict()),
}).strict()

// 只描述当前请求已取得的材料；不补抓网络，也不把有摘要等同于正文已读取。
export function buildMaterialManifest(value) {
  const { requestId, materials } = manifestInputSchema.parse(value)
  if (new Set(materials.map(item => item.id)).size !== materials.length) throw new Error('material_manifest_duplicate_identity')
  const entries = materials.map(item => {
    if (item.text === undefined) {
      if (item.pages.length) throw new Error('material_manifest_page_without_source')
      return { id: item.id, version: item.version, status: 'missing', missingReason: item.missingReason ?? 'material_unavailable', complete: false, readRanges: [] }
    }
    if (item.missingReason) throw new Error('material_manifest_conflicting_availability')
    const ranges = item.pages.map(page => {
      if (page.offset > item.text.length || item.text.slice(page.offset, page.offset + page.text.length) !== page.text) throw new Error('material_manifest_page_mismatch')
      return { start: page.offset, end: page.offset + page.text.length }
    }).filter(range => range.end > range.start).sort((a, b) => a.start - b.start)
    const merged = []
    for (const range of ranges) {
      const last = merged.at(-1)
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
      else merged.push({ ...range })
    }
    const nextOffset = merged[0]?.start === 0 ? merged[0].end : 0
    const complete = nextOffset === item.text.length
    return { id: item.id, version: item.version, contentFingerprint: fingerprint(item.text), totalChars: item.text.length, readChars: merged.reduce((sum, range) => sum + range.end - range.start, 0), readRanges: merged, nextOffset, complete, status: complete ? 'complete' : 'partial' }
  })
  return { requestId, manifestFingerprint: fingerprint(entries), complete: entries.every(item => item.complete), entries }
}
