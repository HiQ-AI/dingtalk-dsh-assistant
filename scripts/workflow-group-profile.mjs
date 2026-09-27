import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'

/** YAML 仅解析，不执行 !!js；只替换目标 sequence，其他字节保持原样。 */
export function planWorkflowGroupEnrollment(source, yaml, { instanceId, dbPath, groupIds, conversationId }) {
  const fail = () => { throw Object.assign(new Error('CUTOVER_PROFILE_INVALID'), { code: 'CUTOVER_PROFILE_INVALID' }) }
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
  const parse = text => {
    const stack = [], sequences = [], workflows = []
    const document = yaml.load(text, { schema, listener(event, state) {
      if (event === 'open') stack.push(state.position)
      else { const start = stack.pop(); if (state.kind === 'sequence') sequences.push({ start, end: state.position, value: state.result }) }
    } })
    const walk = (value, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (value.instanceId === instanceId && typeof value.dbPath === 'string' && resolve(value.dbPath) === resolve(dbPath) && Array.isArray(value.groupIds)) workflows.push(value)
      for (const child of Object.values(value)) walk(child, seen)
    }
    walk(document)
    if (workflows.length !== 1) fail()
    return { document, workflow: workflows[0], sequences }
  }
  const before = parse(source), expected = [...groupIds, conversationId]
  if (!isDeepStrictEqual(before.workflow.groupIds, groupIds)) fail()
  const spans = before.sequences.filter(item => item.value === before.workflow.groupIds)
  if (spans.length !== 1) fail()
  const { start, end } = spans[0]
  // JSON flow sequence 是原生 YAML；保留解析器吞入的换行/缩进，避免影响后续字段。
  const original = source.slice(start, end), leading = /^\s*/.exec(original)[0], trailing = /\s*$/.exec(original)[0]
  const updated = source.slice(0, start) + leading + JSON.stringify(expected) + trailing + source.slice(end)
  const after = parse(updated)
  if (!isDeepStrictEqual(after.workflow.groupIds, expected)) fail()
  delete before.workflow.groupIds; delete after.workflow.groupIds
  if (!isDeepStrictEqual(before.document, after.document)) fail()
  return updated
}
