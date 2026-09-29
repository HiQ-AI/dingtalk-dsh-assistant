import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, lstat, link, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { taskFilePath, checkedTaskDirectory } from './session-workspaces.js'

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

/** 新引用自带逻辑任务身份，无索引表，也不扫描其它任务猜测摘要归属。 */
export function parseArtifactReference(ref) {
  const match = typeof ref === 'string' && /^(?:tasks\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/)?(sha256-([a-f0-9]{64})\.json)$/.exec(ref)
  if (!match) throw executionError('ARTIFACT_REFERENCE_INVALID')
  return { logicalTaskId: match[1], fileName: match[2], digest: match[3] }
}

export async function openExecutionArtifacts({ directory, initialize = false, taskWorkspaceRoot, getTaskDirectories }) {
  if (typeof directory !== 'string' || !directory) throw executionError('ARTIFACT_DIRECTORY_REQUIRED')
  const root = resolve(directory)
  if (initialize) await mkdir(root, { recursive: true })
  if (!(await stat(root)).isDirectory()) throw executionError('ARTIFACT_DIRECTORY_INVALID')
  const locate = ref => {
    const { logicalTaskId, fileName } = parseArtifactReference(ref)
    if (!logicalTaskId) return join(root, fileName)
    if (!taskWorkspaceRoot) throw executionError('ARTIFACT_TASK_ROOT_REQUIRED')
    return join(taskFilePath(taskWorkspaceRoot, logicalTaskId, 'work', 'artifacts'), fileName)
  }
  async function read(ref) {
    const path = locate(ref), identity = parseArtifactReference(ref)
    if (identity.logicalTaskId) {
      await checkedTaskDirectory(dirname(path))
      const entry = await lstat(path)
      if (!entry.isFile() || entry.isSymbolicLink()) throw executionError('ARTIFACT_REFERENCE_INVALID')
    }
    const bytes = await readFile(path)
    if (identity.logicalTaskId) await checkedTaskDirectory(dirname(path))
    if (createHash('sha256').update(bytes).digest('hex') !== identity.digest) throw executionError('ARTIFACT_DIGEST_MISMATCH')
    return JSON.parse(bytes.toString('utf8'))
  }
  async function put(value, scope = {}) {
    let logicalTaskId
    if (scope.reference !== undefined && taskWorkspaceRoot) logicalTaskId = parseArtifactReference(scope.reference).logicalTaskId
    else if (scope.taskId && getTaskDirectories) logicalTaskId = (await getTaskDirectories(scope.taskId, scope))?.logicalTaskId
    const bytes = Buffer.from(canonicalExecutionJson(value))
    const digest = createHash('sha256').update(bytes).digest('hex'), fileName = `sha256-${digest}.json`
    const ref = logicalTaskId ? `tasks/${logicalTaskId}/${fileName}` : fileName
    const path = locate(ref), parent = dirname(path)
    if (logicalTaskId) await checkedTaskDirectory(parent, true)
    const temporary = join(parent, `.pending-${randomUUID()}`)
    let file
    try {
      file = await open(temporary, 'wx')
      await file.writeFile(bytes); await file.sync(); await file.close(); file = null
      // 完整文件才公开内容地址；link是原生no-replace，竞争写同内容不会读到半文件。
      if (logicalTaskId) await checkedTaskDirectory(parent)
      await link(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await read(ref) // 已存在的内容必须真实完整，绝不悄悄覆盖坏工件。
    } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    return { ref, digest }
  }
  return { put, read, root, locate, getTaskDirectories }
}
