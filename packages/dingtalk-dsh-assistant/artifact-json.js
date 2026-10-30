import { createHash } from 'node:crypto'

export function executionError(code, detail = code) { return Object.assign(new Error(detail), { code }) }

// 固定JSON值域与排序；不接受隐式toJSON、undefined、NaN或循环对象。
export function canonicalExecutionJson(value) {
  const seen = new Set()
  const encode = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (!item || typeof item !== 'object' || seen.has(item)) throw executionError('INVALID_JSON_VALUE')
    seen.add(item)
    let result
    if (Array.isArray(item)) result = '[' + Array.from(item, encode).join(',') + ']'
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw executionError('INVALID_JSON_OBJECT')
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}'
    }
    seen.delete(item)
    return result
  }
  return encode(value)
}
export const executionDigest = value => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex')
