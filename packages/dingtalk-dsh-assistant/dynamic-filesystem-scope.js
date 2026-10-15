import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const scopes = new AsyncLocalStorage(), installations = new Map()
// Host FS 合同：这些检查在发布文件内容之前拒绝。IO、权限、沙箱及取消
// 可能发生在提交之后，不能由错误码推断没有效果，也不按错误文案分类。
const filePreconditions = new Set(['FS_NOT_OBSERVED', 'FS_STALE_VERSION', 'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY', 'FS_NOT_REGULAR_FILE', 'FS_NOT_TEXT', 'FS_TOO_LARGE', 'FS_EDIT_NOT_FOUND', 'FS_AMBIGUOUS_EDIT'])
export const isNativeFilePrecondition = (toolName, error) => ['edit', 'write'].includes(toolName) && filePreconditions.has(error?.code)
const fail = () => { throw Object.assign(new Error('TASK_FILESYSTEM_SCOPE_FORBIDDEN'), { code: 'TASK_FILESYSTEM_SCOPE_FORBIDDEN' }) }
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
async function canonical(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonical(parent), relative(parent, path))
  }
}
async function check(path, scope) {
  if (!isAbsolute(path)) fail()
  const protectedPaths = [...scope.protectedPaths, ...await Promise.all(scope.protectedPaths.map(canonical))]
  const checkOne = value => {
    if (protectedPaths.some(path => inside(path, value))) fail()
    if (inside(scope.tasksRoot, value) && !inside(scope.taskRoot, value)) fail()
    if (inside(join(scope.taskRoot, '.dsh'), value)) fail()
  }
  checkOne(resolve(path)); checkOne(await canonical(resolve(path)))
}

/** Guard the managed task files on the actual public native FS capability.
 * This is a file-tool boundary, not an OS sandbox for arbitrary authorized shell programs.
 */
export function guardTaskFileSystem(service, { taskRoot, executionRoot, tasksRoot, protectedPaths = [] }) {
  if (!service?.resolve || !service?.processPath) throw new Error('TASK_FILESYSTEM_SCOPE_UNAVAILABLE')
  const policy = { taskRoot: resolve(taskRoot), executionRoot: resolve(executionRoot), tasksRoot: resolve(tasksRoot), protectedPaths: [...protectedPaths, join(dirname(tasksRoot), '.dsh')].map(path => resolve(path)) }
  const key = service.identity ?? service
  let installed = installations.get(key)
  if (!installed) {
    installed = { refs: 0, methods: [] }
    const methods = ['resolve','lstat','stat','readText','streamText','readBytes','readByteRange','listDir','writeText','editText']
    for (const name of methods) {
      if (typeof service[name] !== 'function') continue
      const original = service[name]
      const wrapped = async function (...args) {
        const scope = scopes.getStore()
        if (!scope) return original.apply(this, args)
        if (scope.readOnly && ['writeText','editText'].includes(name)) fail()
        if (name === 'resolve') {
          const path = resolve(args[1]?.cwd ?? scope.executionRoot, args[0])
          await check(path, scope)
          const target = await original.apply(this, args)
          await check(service.processPath(target), scope)
          return target
        }
        if (name === 'lstat') await check(resolve(args[1]?.cwd ?? scope.executionRoot, args[0]), scope)
        else await check(service.processPath(args[0]), scope)
        return original.apply(this, args)
      }
      service[name] = wrapped
      installed.methods.push({ name, original })
    }
    installations.set(key, installed)
  }
  installed.refs++
  let closed = false
  return {
    async preflight(args, { requiresExistingFile = false } = {}) {
      const paths = []
      const walk = value => {
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
          if (['path','file_path','filePath','filepath','cwd','workdir','directory'].includes(key) && typeof item === 'string') paths.push(item)
          else if (key === 'paths' && Array.isArray(item)) paths.push(...item.filter(path => typeof path === 'string'))
          else if (item && typeof item === 'object') walk(item)
        }
      }
      walk(args)
      for (const path of paths) await check(resolve(policy.executionRoot, path), policy)
      // This is a Host pre-dispatch rejection, not an assertion that a named tool is pure.
      // A missing/non-file read target cannot be corrected by dispatching a file read.
      // Do not apply this to write tools: creating new files remains supported.
      if (requiresExistingFile && typeof args?.file_path === 'string') {
        const target = resolve(policy.executionRoot, args.file_path)
        let info
        try { info = await stat(target) }
        catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
          throw Object.assign(new Error('TASK_FILE_NOT_FOUND: ' + target), { code: 'TASK_FILE_NOT_FOUND' })
        }
        if (!info.isFile()) throw Object.assign(new Error('TASK_FILE_NOT_REGULAR: ' + target), { code: 'TASK_FILE_NOT_REGULAR' })
      }
    },
    run(action, { readOnly = false } = {}) { if (closed) fail(); return scopes.run({ ...policy, readOnly }, action) },
    close() { if (closed) return; closed = true; if (--installed.refs) return
      for (const { name, original } of installed.methods) service[name] = original
      installations.delete(key)
    },
  }
}
