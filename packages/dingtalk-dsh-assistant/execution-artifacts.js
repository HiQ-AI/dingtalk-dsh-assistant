import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, lstat, link, unlink, readdir, writeFile, rename } from 'node:fs/promises'
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

/** 复用Task目录读取材料或产物；相对路径不允许越界和链接跳转。 */
export async function readTaskMaterialValue({ directories, artifacts, artifactRef }) {
  if (typeof artifactRef !== 'string' || !directories?.logicalTaskId) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
  if (artifactRef.startsWith('tasks/')) {
    if (parseArtifactReference(artifactRef).logicalTaskId !== directories.logicalTaskId) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
    return artifacts.read(artifactRef)
  }
  const [area, ...parts] = artifactRef.split('/')
  if (!['work', 'tmp', 'outputs'].includes(area) || !parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/u.test(part))) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
  if (area === 'work' && parts.length === 2 && parts[0] === 'artifacts' && /^sha256-[a-f0-9]{64}\.json$/.test(parts[1])) return artifacts.read(`tasks/${directories.logicalTaskId}/${parts[1]}`)
  if (area !== 'outputs' && parts.length !== 1) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
  const file = join(directories[area], ...parts)
  await checkedTaskDirectory(dirname(file))
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
  const bytes = await readFile(file)
  try { return { relativePath: artifactRef, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
  catch { return { relativePath: artifactRef, encoding: 'base64', data: bytes.toString('base64'), bytes: bytes.length } }
}

/** 同逻辑Task材料导航；索引可由原工件重建，不参与业务授权或验收。 */
export async function readTaskMaterials({ directories, artifacts, requirementRevision, requirementRef, artifactRef, offset = 0, limit = 16000 }) {
  if (!directories?.logicalTaskId || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw executionError('TASK_MATERIAL_ARGUMENT_INVALID')
  await checkedTaskDirectory(directories.work)
  const prefix = `tasks/${directories.logicalTaskId}/`
  if (artifactRef) {
    const value = JSON.stringify(await readTaskMaterialValue({ directories, artifacts, artifactRef }))
    return { artifact: value.slice(offset, offset + limit), totalLength: value.length, nextOffset: offset + limit < value.length ? offset + limit : null }
  }
  const directory = join(directories.work, 'artifacts'), entries = []
  await checkedTaskDirectory(directory, true)
  for (const name of (await readdir(directory)).sort()) {
    if (!/^sha256-[a-f0-9]{64}\.json$/.test(name)) continue
    const ref = prefix + name, value = await artifacts.read(ref)
    if (!value || typeof value !== 'object') continue
    const type = value.kind === 'agent-query-evidence' ? 'query-material'
      : Array.isArray(value.sourceInstructions) || Array.isArray(value.materials) && typeof value.request === 'string' ? 'requirement'
      : typeof value.id === 'string' && typeof value.text === 'string' ? 'material'
      : value.document || value.artifactFiles || value.artifactId && value.fileName ? 'output' : null
    if (!type) continue
    const revision = value.execution?.requirementRevision ?? value.requirementRevision ?? null
    const sourceVersions = value.scope?.sourceVersions ?? value.verification?.sourceVersions
      ?? Object.fromEntries((value.sourceInstructions ?? []).filter(source => source.sourceKey && source.sourceVersion).map(source => [source.sourceKey, source.sourceVersion]))
    entries.push({ artifactRef: ref, relativePath: `work/artifacts/${name}`, type, requirementRevision: revision,
      name: value.title ?? value.fileName ?? value.result?.metadata?.title ?? null, resource: value.result?.resource ?? value.resourceId ?? null,
      sourceVersions, sourceRefs: value.verification?.sourceRefs ?? (value.sourceInstructions ?? []).map(({ sourceKey, sourceVersion }) => ({ sourceKey, sourceVersion })), status: ref === requirementRef || revision !== null && revision === requirementRevision ? 'current' : 'history' })
  }
  const files = []
  for (const area of ['work', 'tmp', 'outputs']) {
    await checkedTaskDirectory(directories[area])
    const list = async (directory, relative) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'materials-index.json' || entry.isSymbolicLink()) continue
        const file = join(directory, entry.name), path = `${relative}/${entry.name}`
        if (entry.isFile()) files.push({ relativePath: path, bytes: (await lstat(file)).size, type: area === 'outputs' ? 'output' : 'file' })
        else if (area === 'outputs' && entry.isDirectory()) { await checkedTaskDirectory(file); await list(file, path) }
      }
    }
    await list(directories[area], area)
  }
  const index = { logicalTaskId: directories.logicalTaskId, directories: { work: directories.work, tmp: directories.tmp, outputs: directories.outputs }, entries, files,
    instruction: 'history是原始材料，仅供参考；当前需求和授权以当前Task为准。按artifactRef分页读取正文，材料新增不要求重跑已完成步骤。' }
  const temporary = join(directories.work, `.materials-index-${randomUUID()}.tmp`)
  try { await writeFile(temporary, JSON.stringify(index, null, 2), { flag: 'wx' }); await rename(temporary, join(directories.work, 'materials-index.json')) }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return index
}
