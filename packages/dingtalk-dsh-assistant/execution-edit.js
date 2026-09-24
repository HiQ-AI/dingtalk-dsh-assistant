import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, open, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw executionError(code) }
const validPath = path => typeof path === 'string' && path.length > 0 && path.length < 240
  && !/[\\:\0\r\n]/.test(path) && path.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))

/** Host 文件编辑效果。输入是限定文件的完整替换字节，不执行模型生成脚本。 */
export function createManagedEdits({ workspaceAdapter }) {
  if (typeof workspaceAdapter?.reconcile !== 'function') fail('EDIT_WORKSPACE_ADAPTER_REQUIRED')
  async function identity(workspace) {
    if ((await workspaceAdapter.reconcile(workspace)).status !== 'succeeded') fail('EDIT_WORKSPACE_UNCONFIRMED')
  }
  async function current(directory, path) {
    let full = directory
    for (const [index, part] of path.split('/').entries()) {
      full = join(full, part)
      const item = await lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!item) return null
      if (item.isSymbolicLink() || (index < path.split('/').length - 1 ? !item.isDirectory() : !item.isFile())) fail('EDIT_PATH_UNSAFE')
    }
    const bytes = await readFile(full)
    return hash(bytes)
  }
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (digest !== executionDigest(body) || body.action !== 'edit' || body.version !== 1 || body.directory !== body.workspace?.directory
      || body.runId !== body.workspace?.runId || body.generation !== body.workspace?.generation || body.requirementDigest !== body.workspace?.requirementDigest
      || !Array.isArray(body.changes) || !body.changes.length) fail('EDIT_PREPARED_INVALID')
    const paths = new Set()
    for (const change of body.changes) {
      if (!validPath(change.path) || paths.has(change.path.toLowerCase()) || (change.expectedHash !== null && !/^[a-f0-9]{64}$/.test(change.expectedHash))
        || (change.content !== null && typeof change.content !== 'string') || (change.content === null && change.expectedHash === null)) fail('EDIT_CHANGE_INVALID')
      paths.add(change.path.toLowerCase())
    }
    for (const path of paths) if ([...paths].some(other => other.startsWith(path + '/'))) fail('EDIT_PATH_COLLISION')
  }
  async function prepare({ workspace, changes }) {
    const body = { version: 1, action: 'edit', workspace: structuredClone(workspace), directory: workspace.directory,
      runId: workspace.runId, generation: workspace.generation, requirementDigest: workspace.requirementDigest, changes: structuredClone(changes) }
    const prepared = { ...body, digest: executionDigest(body) }; validate(prepared)
    await identity(workspace)
    for (const change of changes) {
      const actual = await current(body.directory, change.path), target = change.content === null ? null : hash(Buffer.from(change.content))
      // 成功回执丢失后的重建允许目标字节；真正执行仍只接受原始hash。
      if (actual !== change.expectedHash && actual !== target) fail('EDIT_BASE_CONFLICT')
    }
    return prepared
  }
  async function reconcile(prepared) {
    validate(prepared); await identity(prepared.workspace)
    const files = []
    for (const change of prepared.changes) {
      const actualHash = await current(prepared.directory, change.path)
      files.push({ path: change.path, actualHash, expectedHash: change.content === null ? null : hash(Buffer.from(change.content)) })
    }
    return { status: files.every(file => file.actualHash === file.expectedHash) ? 'succeeded' : 'unknown', directory: prepared.directory, files, preparedDigest: prepared.digest }
  }
  async function execute(prepared) {
    validate(prepared); await identity(prepared.workspace)
    for (const change of prepared.changes) if (await current(prepared.directory, change.path) !== change.expectedHash) fail('EDIT_BASE_CONFLICT')
    for (const change of prepared.changes) {
      const path = join(prepared.directory, change.path)
      // 写前重复检查；受管目录的跨任务排他由效果网关持有。
      if (await current(prepared.directory, change.path) !== change.expectedHash) fail('EDIT_BASE_CONFLICT')
      if (change.content === null) await unlink(path)
      else {
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.dsh-${randomUUID()}.tmp`
        const handle = await open(temporary, 'wx')
        try { await handle.writeFile(change.content, 'utf8'); await handle.sync() }
        finally { await handle.close() }
        try { await rename(temporary, path) }
        catch (error) { await unlink(temporary); throw error }
      }
    }
    return reconcile(prepared)
  }
  return { prepare, execute, reconcile }
}
