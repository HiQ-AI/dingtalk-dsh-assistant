import {writeObserverArtifactText,readObserverArtifactText} from './observer-artifact-pages.js'
import {describeTaskNodeOutput} from './node-output-readout.js'
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

export async function openExecutionArtifacts({ directory, initialize = false, taskWorkspaceRoot, getTaskDirectories,observerPageBindings }) {
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
  const localPageBindings=new Map()
  async function indexObserverPages(ref,value,{nodeId,context={},replace=false,messageOutput=nodeId===undefined,strictContext=true}={}) {
    const path=locate(ref)
    const write=async(view,text,extra)=>{const meta=await writeObserverArtifactText(path,view,text,extra,{replace});if(observerPageBindings)await observerPageBindings.put({ref,view,root:meta.bindingRoot});else localPageBindings.set(JSON.stringify([ref,view]),meta.bindingRoot);return meta}
    const outputText=[value?.summary??value?.reply??'本次执行未生成答复正文。',...(value?.limitations?.length?['\n已知限制',...value.limitations]:[])].join('\n')
    if(messageOutput)await write('message-output',outputText)
    if(value?.kind==='agent-query-evidence'){
      const text=[`读取时间：${value.observedAt??'未记录'}`,'来源：',...(value.verification?.sourceRefs??[]),'\n读取结果',typeof value.result==='string'?value.result:JSON.stringify(value.result,null,2)].join('\n')
      await write('message-query-evidence',text,{runId:value.execution?.runId??null})
    }
    if(nodeId){
      if(nodeId==='prepare-workspace'&&!value?.workspace&&!context.workspace||nodeId==='prepare-generation'&&!value?.startingPoint&&!context.startingPoint){if(strictContext)throw executionError('OBSERVER_TEXT_CONTEXT_REQUIRED');return}
      const result=describeTaskNodeOutput({nodeId},value,context)
      await write(`node:${nodeId}`,result.text,{overview:result.overview,documentName:result.document?.name??null,pathOnly:['inspect-and-propose','propose-changes','validate-proposal'].includes(nodeId)&&!(nodeId==='inspect-and-propose'&&value?.document?.markdown&&Array.isArray(value.scopePaths)&&Array.isArray(value.criteria))})
    }
  }
  async function readObserverPage(ref,view,options={}){
    const path=locate(ref),identity=parseArtifactReference(ref)
    if(identity.logicalTaskId)await checkedTaskDirectory(dirname(path))
    const bindingRoot=observerPageBindings?await observerPageBindings.get({ref,view}):localPageBindings.get(JSON.stringify([ref,view]))
    if(!bindingRoot)throw executionError('OBSERVER_TEXT_MIGRATION_REQUIRED')
    const result=await readObserverArtifactText(path,view,{...options,bindingRoot})
    if(identity.logicalTaskId)await checkedTaskDirectory(dirname(path))
    return result
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
    if(scope.observerNodeId||scope.observerMessageOutput===true||value?.kind==='agent-query-evidence')await indexObserverPages(ref,value,{nodeId:scope.observerNodeId,context:scope.observerContext,messageOutput:scope.observerMessageOutput===true,strictContext:false})
    return { ref, digest }
  }
  return { put, read, root, locate, getTaskDirectories,readObserverPage,indexObserverPages }
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
export async function readTaskMaterialIndexPage({ logicalTaskId, names, artifacts, requirementRevision, requirementRef, offset, limit }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw executionError('TASK_MATERIAL_ARGUMENT_INVALID')
  const entries = []
  for (const name of names.slice(offset, offset + limit)) {
    if (!/^sha256-[a-f0-9]{64}\.json$/.test(name)) throw executionError('ARTIFACT_REFERENCE_INVALID')
    const ref = `tasks/${logicalTaskId}/${name}`, value = await artifacts.read(ref)
    if (!value || !(value.kind === 'agent-query-evidence' || Array.isArray(value.sourceInstructions)
      || Array.isArray(value.materials) && typeof value.request === 'string'
      || typeof value.id === 'string' && typeof value.text === 'string'
      || value.document || value.artifactFiles || value.artifactId && value.fileName)) continue
    const revision = value.execution?.requirementRevision ?? value.requirementRevision ?? null
    entries.push({ artifactRef: ref, relativePath: `work/artifacts/${name}`, kind: value.kind ?? 'artifact', requirementRevision: revision,
      status: ref === requirementRef || revision !== null && revision === requirementRevision ? 'current' : 'history' })
  }
  return { logicalTaskId, entries, totalEntries: names.length, nextCursor: offset + limit < names.length ? offset + limit : null,
    instruction: '索引项不证明授权或验收；用artifactRef分页读完整原文。work/tmp单层及outputs产物可沿已登记相对路径读取。' }
}

export async function readTaskMaterials({ directories, artifacts, requirementRevision, requirementRef, artifactRef, offset = 0, limit = 16000, indexOffset, indexLimit = 50, indexState }) {
  if (!directories?.logicalTaskId || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw executionError('TASK_MATERIAL_ARGUMENT_INVALID')
  await checkedTaskDirectory(directories.work)
  const prefix = `tasks/${directories.logicalTaskId}/`
  if (artifactRef) {
    const value = JSON.stringify(await readTaskMaterialValue({ directories, artifacts, artifactRef }))
    return { artifact: value.slice(offset, offset + limit), totalLength: value.length, nextOffset: offset + limit < value.length ? offset + limit : null }
  }
  const directory = join(directories.work, 'artifacts'), entries = []
  await checkedTaskDirectory(directory, true)
  // On-demand entry pagination: only open artifacts in this page. No snapshot-time scan or index rewrite.
  if (indexOffset !== undefined) {
    if (!Number.isSafeInteger(indexOffset) || indexOffset < 0 || !Number.isSafeInteger(indexLimit) || indexLimit < 1 || indexLimit > 100) throw executionError('TASK_MATERIAL_ARGUMENT_INVALID')
    if (indexState && indexState.logicalTaskId && indexState.logicalTaskId !== directories.logicalTaskId) throw executionError('TASK_MATERIAL_SCOPE_INVALID')
    const names = indexState?.names ?? (await readdir(directory)).filter(name => /^sha256-[a-f0-9]{64}\.json$/.test(name)).sort()
    if (indexState && !indexState.names) Object.assign(indexState, { logicalTaskId: directories.logicalTaskId, names })
    // Immutable name list pins pagination across retries/additions. Cursor is an offset in this listing,
    // callers use the Host-frozen listing for a turn (see listMaterials in owner controller).
    return readTaskMaterialIndexPage({ logicalTaskId: directories.logicalTaskId, names, artifacts, requirementRevision, requirementRef, offset: indexOffset, limit: indexLimit })
  }
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
