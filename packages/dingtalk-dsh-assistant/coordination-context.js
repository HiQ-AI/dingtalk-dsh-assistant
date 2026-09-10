import { fingerprint } from './topic-model.js'
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
      if (block.type !== 'tool-result' || block.isError || !['group_task_prompt_get', 'group_task_review_context_get'].includes(calls.get(block.toolCallId))) continue
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
