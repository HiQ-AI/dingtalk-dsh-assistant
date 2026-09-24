import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, link, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

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

export async function openExecutionArtifacts({ directory, initialize = false }) {
  if (typeof directory !== 'string' || !directory) throw executionError('ARTIFACT_DIRECTORY_REQUIRED')
  const root = resolve(directory)
  if (initialize) await mkdir(root, { recursive: true })
  if (!(await stat(root)).isDirectory()) throw executionError('ARTIFACT_DIRECTORY_INVALID')
  const target = ref => {
    if (!/^sha256-[a-f0-9]{64}\.json$/.test(ref)) throw executionError('ARTIFACT_REFERENCE_INVALID')
    return join(root, ref)
  }
  async function read(ref) {
    const bytes = await readFile(target(ref))
    if (`sha256-${createHash('sha256').update(bytes).digest('hex')}.json` !== ref) throw executionError('ARTIFACT_DIGEST_MISMATCH')
    return JSON.parse(bytes.toString('utf8'))
  }
  async function put(value) {
    const bytes = Buffer.from(canonicalExecutionJson(value))
    const digest = createHash('sha256').update(bytes).digest('hex'), ref = `sha256-${digest}.json`
    const temporary = join(root, `.pending-${randomUUID()}`)
    let file
    try {
      file = await open(temporary, 'wx')
      await file.writeFile(bytes); await file.sync(); await file.close(); file = null
      // 完整文件才公开内容地址；link是原生no-replace，竞争写同内容不会读到半文件。
      await link(temporary, target(ref))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await read(ref) // 已存在的内容必须真实完整，绝不悄悄覆盖坏工件。
    } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    return { ref, digest }
  }
  return { put, read, root }
}
