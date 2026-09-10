import { z } from 'zod'

// DSH 只执行 JSON Schema 子集。精确约束始终由原 Zod 校验；不维护另一份字段契约。
const annotations = ['description', 'title', 'default', 'examples']
const scalarValues = (node) => node && ('const' in node ? [node.const] : node.enum)
const exclusive = (left, right) => {
  if (left.type !== right.type) return Boolean(left.type && right.type)
  if (left.type !== 'object') {
    const a = scalarValues(left), b = scalarValues(right)
    return Boolean(a && b && !a.some(value => b.includes(value)))
  }
  return Object.keys(left.properties ?? {}).some(key => {
    const a = scalarValues(left.properties[key]), b = scalarValues(right.properties?.[key])
    return left.required?.includes(key) && right.required?.includes(key) && a && b && !a.some(value => b.includes(value))
  }) || left.additionalProperties === false && right.required?.some(key => !(key in (left.properties ?? {})))
    || right.additionalProperties === false && left.required?.some(key => !(key in (right.properties ?? {})))
}
function union(branches) {
  const unique = [...new Map(branches.map(branch => [JSON.stringify(branch), branch])).values()]
  if (unique.length === 1) return project(unique[0])
  if (unique.every((branch, i) => unique.slice(i + 1).every(other => exclusive(branch, other)))) return { oneOf: unique.map(project) }
  if (unique.every(branch => branch.type === 'object')) {
    const keys = [...new Set(unique.flatMap(branch => Object.keys(branch.properties ?? {})))]
    return { type: 'object', additionalProperties: unique.some(branch => branch.additionalProperties !== false),
      required: (unique[0].required ?? []).filter(key => unique.every(branch => branch.required?.includes(key))),
      properties: Object.fromEntries(keys.map(key => [key, union(unique.flatMap(branch => branch.properties?.[key] ? [branch.properties[key]] : []))])),
      description: '联合分支字段投影；完整互斥、数量与语义约束由工具执行时同源 Zod 校验。' }
  }
  if (unique.every(branch => branch.type === 'array')) {
    const items = unique.filter(branch => branch.maxItems !== 0).flatMap(branch => branch.items && branch.items !== false ? [branch.items] : [{}])
    return { type: 'array', ...(items.length ? { items: union(items) } : {}), description: '数组长度约束由执行时同源 Zod 校验。' }
  }
  if (unique.every(branch => branch.type === unique[0].type) && unique[0].type) {
    const values = unique.map(scalarValues)
    return { type: unique[0].type, ...(values.every(Boolean) ? { enum: [...new Set(values.flat())] } : {}) }
  }
  return { description: '联合值；完整类型约束由执行时同源 Zod 校验。' }
}
function project(node) {
  const branches = node.oneOf ?? node.anyOf
  if (branches) return union(branches)
  const output = Object.fromEntries(annotations.filter(key => key in node).map(key => [key, node[key]]))
  for (const key of ['type', 'enum', 'const', 'required']) if (key in node) output[key] = node[key]
  if (node.properties) output.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, project(value)]))
  if ('additionalProperties' in node) output.additionalProperties = typeof node.additionalProperties === 'boolean' ? node.additionalProperties : true
  if (node.items && node.items !== false) output.items = project(node.items)
  const enforcedLater = Object.fromEntries(Object.entries(node).filter(([key]) => ![...annotations, '$schema', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items'].includes(key)))
  if (Object.keys(enforcedLater).length) output.description = `${output.description ?? ''} 执行时约束：${JSON.stringify(enforcedLater)}`.trim()
  return output
}
export function toToolJsonSchema(schema) {
  // JSON roundtrip 移除 Zod 非枚举的 ~standard 元属性，避免 DSH 拒绝整个节点。
  return project(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input', override: ({ zodSchema, jsonSchema }) => {
    // Zod 4 的空 tuple 输入投影只含 prefixItems:[]；补入其自身固定长度，避免联合 actions 丢失 item 契约。
    if (zodSchema.def?.type === 'tuple' && !zodSchema.def.rest) jsonSchema.maxItems = zodSchema.def.items.length
  } }))))
}
