import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
  && !/[.]$/u.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

/** 由 Host 固定根目录；模型仅提供 Markdown 内容，文件名由 Task 和节点身份派生。 */
export function createTaskMarkdownFileAdapter({ root }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw executionError('TASK_MARKDOWN_CONFIG_INVALID')
  const configuredRoot = resolve(root)
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (body.action !== 'file' || body.version !== 1 || !identity(body.taskId) || !identity(body.runId)
      || !identity(body.nodeRunId) || !Number.isSafeInteger(body.generation) || body.generation < 0
      || !hex(body.requirementDigest) || !hex(body.contentDigest) || !hex(body.operationId)
      || typeof body.content !== 'string' || !body.content.trim() || Buffer.byteLength(body.content, 'utf8') > 12000
      || body.contentDigest !== sha256(Buffer.from(body.content, 'utf8'))
      || body.operationId !== executionDigest({ taskId: body.taskId, runId: body.runId,
        nodeRunId: body.nodeRunId, generation: body.generation, requirementDigest: body.requirementDigest,
        contentDigest: body.contentDigest })
      || body.resourceKey !== `file:${body.taskId}:${body.operationId}` || digest !== executionDigest(body))
      throw executionError('TASK_MARKDOWN_PREPARED_INVALID')
  }
  async function directory(taskId, create = false) {
    if (create) await mkdir(configuredRoot, { recursive: true })
    const rootStat = await lstat(configuredRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!rootStat) return null
    if (rootStat.isSymbolicLink()) throw executionError('TASK_MARKDOWN_ROOT_INVALID')
    const base = await realpath(configuredRoot)
    const stat = await lstat(base)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw executionError('TASK_MARKDOWN_ROOT_INVALID')
    const taskDirectory = join(base, taskId)
    if (create) await mkdir(taskDirectory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const taskStat = await lstat(taskDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!taskStat) return null
    if (!taskStat.isDirectory() || taskStat.isSymbolicLink() || relative(base, taskDirectory).startsWith('..'))
      throw executionError('TASK_MARKDOWN_SCOPE_DENIED')
    return taskDirectory
  }
  async function current(prepared) {
    validate(prepared)
    const parent = await directory(prepared.taskId)
    if (!parent) return null
    const path = join(parent, `${prepared.operationId}.md`)
    const fileStat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!fileStat) return null
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw executionError('TASK_MARKDOWN_CONFLICT')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (opened.dev !== fileStat.dev || opened.ino !== fileStat.ino || opened.size > 12000)
        throw executionError('TASK_MARKDOWN_CONFLICT')
      const bytes = await handle.readFile()
      const after = await lstat(path)
      if (after.dev !== opened.dev || after.ino !== opened.ino || sha256(bytes) !== prepared.contentDigest)
        throw executionError('TASK_MARKDOWN_CONFLICT')
      return { path, taskId: prepared.taskId, operationId: prepared.operationId,
        contentDigest: prepared.contentDigest, bytes: bytes.length }
    } finally { await handle.close() }
  }
  function prepare({ input, binding }) {
    if (!input || Object.keys(input).length !== 1 || typeof input.content !== 'string')
      throw executionError('TASK_MARKDOWN_INPUT_INVALID')
    const contentDigest = sha256(Buffer.from(input.content, 'utf8'))
    const body = { version: 1, action: 'file', taskId: binding.taskId, runId: binding.runId,
      nodeRunId: binding.nodeRunId, generation: binding.generation,
      requirementDigest: binding.requirementDigest, content: input.content, contentDigest,
      operationId: executionDigest({ taskId: binding.taskId, runId: binding.runId,
        nodeRunId: binding.nodeRunId, generation: binding.generation,
        requirementDigest: binding.requirementDigest, contentDigest }) }
    body.resourceKey = `file:${body.taskId}:${body.operationId}`
    const prepared = { ...body, digest: executionDigest(body) }
    validate(prepared)
    return prepared
  }
  async function reconcile(prepared) {
    const result = await current(prepared)
    return result ? { status: 'succeeded', result, evidenceRef: `${prepared.resourceKey}:${result.contentDigest}` }
      : { status: 'failed', reason: 'TASK_MARKDOWN_NOT_FOUND' }
  }
  async function execute(prepared) {
    validate(prepared)
    const existing = await current(prepared)
    if (existing) return reconcile(prepared)
    const parent = await directory(prepared.taskId, true)
    const path = join(parent, `${prepared.operationId}.md`)
    const temporary = join(parent, `.pending-${prepared.operationId}-${randomUUID()}`)
    let handle
    try {
      handle = await open(temporary, 'wx')
      await handle.writeFile(prepared.content, 'utf8'); await handle.sync()
      await handle.close(); handle = null
      await link(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // 竞争或回执丢失只接受原操作的完整内容，绝不覆盖。
      if (!await current(prepared)) throw executionError('TASK_MARKDOWN_CONFLICT')
    } finally {
      await handle?.close()
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    return reconcile(prepared)
  }
  return { prepare, execute, reconcile }
}
