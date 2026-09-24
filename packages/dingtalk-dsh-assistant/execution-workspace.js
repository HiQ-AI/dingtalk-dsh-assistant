import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, lstat, mkdir, readdir, open, readFile, rename } from 'node:fs/promises'
import { isAbsolute, join, dirname, relative, parse } from 'node:path'
import { canonicalExecutionJson, executionDigest, executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(code) }
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
async function noLinks(path) {
  let current = parse(path).root
  for (const part of relative(current, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) fail('WORKSPACE_LINK_UNSUPPORTED')
  }
}
function git(directory, args) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' })
    const child = spawn('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-C', directory, ...args], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; let size = 0, errorText = '', failure
    const stop = code => { failure ??= executionError(code); child.kill() }
    const timer = setTimeout(() => stop('WORKSPACE_GIT_TIMEOUT'), 30000)
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 64 * 1024 * 1024) stop('WORKSPACE_GIT_LIMIT'); else chunks.push(bytes) })
    child.stderr.on('data', bytes => { errorText = (errorText + bytes).slice(0, 2048) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code) reject(executionError('WORKSPACE_GIT_FAILED', errorText)); else resolve(Buffer.concat(chunks)) })
  })
}
const text = async (directory, args) => (await git(directory, args)).toString('utf8').trim()
async function admit(repository) {
  await noLinks(repository)
  if (await realpath(await text(repository, ['rev-parse', '--show-toplevel'])) !== repository || await text(repository, ['rev-parse', '--show-object-format']) !== 'sha1') fail('WORKSPACE_SOURCE_INVALID')
  const gitDirectory = join(repository, '.git')
  if (!(await lstat(gitDirectory)).isDirectory()) fail('WORKSPACE_SOURCE_STANDALONE_REQUIRED')
  await noLinks(gitDirectory)
  const config = (await git(repository, ['config', '--local', '--null', '--list'])).toString()
  for (const entry of config.split('\0').filter(Boolean)) {
    const key = entry.split('\n')[0]
    if (/^(?:include|includeif|filter|url|extensions|uploadpack)\.|^core\.(?:hookspath|attributesfile|fsmonitor|sshcommand|gitproxy|worktree)|^remote\..*\.(?:uploadpack|receivepack|promisor)$/i.test(key)) fail('WORKSPACE_UNSUPPORTED_CONFIG')
  }
  const hooks = await readdir(join(gitDirectory, 'hooks')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (hooks.some(name => !name.endsWith('.sample'))) fail('WORKSPACE_HOOKS_UNSUPPORTED')
  for (const path of ['objects/info/alternates', 'info/grafts', 'shallow']) {
    try { await lstat(join(gitDirectory, path)); fail('WORKSPACE_UNSUPPORTED_OBJECT_SOURCE') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
async function manifest(repository, baseCommit) {
  if (await text(repository, ['cat-file', '-t', baseCommit]) !== 'commit') fail('WORKSPACE_BASE_INVALID')
  const tree = await text(repository, ['rev-parse', `${baseCommit}^{tree}`])
  const records = (await git(repository, ['ls-tree', '-rz', '--long', tree])).toString('utf8').split('\0').filter(Boolean)
  if (records.length > 10000) fail('WORKSPACE_FILE_LIMIT')
  let size = 0; const names = new Set()
  const files = records.map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/s.exec(record)
    if (!match) fail('WORKSPACE_ENTRY_UNSUPPORTED')
    const path = match[4], parts = path.split('/'), folded = path.toLowerCase()
    if (parts.some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()) || /[. ]$|[\\:\0-\x1f<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || names.has(folded)) fail('WORKSPACE_PATH_UNSUPPORTED')
    names.add(folded); size += Number(match[3])
    if (Number(match[3]) > 16 * 1024 * 1024 || size > 64 * 1024 * 1024) fail('WORKSPACE_BYTE_LIMIT')
    // 固定原始tree；不读取源工作目录，也不启动属性过滤器。
    if (parts.at(-1) === '.gitattributes') fail('WORKSPACE_ATTRIBUTES_UNSUPPORTED')
    return { path, oid: match[2], size: Number(match[3]) }
  })
  return { tree, files }
}
async function writeExclusive(path, value) {
  const file = await open(path, 'wx')
  try { await file.writeFile(canonicalExecutionJson(value)); await file.sync() } finally { await file.close() }
}
async function checkedPaths(directory, prefix = '') {
  const paths = []
  for (const name of await readdir(join(directory, prefix))) {
    if (!prefix && name === '.git') continue
    const path = prefix ? `${prefix}/${name}` : name, info = await lstat(join(directory, path))
    if (info.isSymbolicLink()) fail('WORKSPACE_CHECKOUT_MISMATCH')
    if (info.isDirectory()) paths.push(...await checkedPaths(directory, path))
    else if (info.isFile()) paths.push(path)
    else fail('WORKSPACE_CHECKOUT_MISMATCH')
  }
  return paths
}

// 受信Host专用：execute只能由控制账一次性permit后调用，不是模型工具。
export async function createManagedWorkspaces({ root, sourceRepository }) {
  for (const value of [root, sourceRepository]) if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) fail('WORKSPACE_SCOPE_INVALID')
  await noLinks(root); await noLinks(sourceRepository)
  root = await realpath(root); sourceRepository = await realpath(sourceRepository)
  const rootRelative = relative(sourceRepository, root)
  if (!(await lstat(root)).isDirectory() || (!isAbsolute(rootRelative) && rootRelative.split(/[\\/]/)[0] !== '..')) fail('WORKSPACE_SCOPE_INVALID')
  await admit(sourceRepository)
  const destination = (runId, generation) => join(root, `ws-${executionDigest({ runId, generation })}`, 'repository')
  function validate(prepared) {
    if (!prepared || Object.keys(prepared).sort().join(',') !== 'action,baseCommit,baseTree,digest,directory,generation,requirementDigest,root,runId,sourceRepository,version') fail('WORKSPACE_PREPARED_INVALID')
    const { digest, ...body } = prepared
    if (digest !== executionDigest(body) || prepared.version !== 1 || prepared.action !== 'workspace' || prepared.root !== root || prepared.sourceRepository !== sourceRepository || typeof prepared.runId !== 'string' || !prepared.runId || prepared.runId.length > 256 || !Number.isSafeInteger(prepared.generation) || prepared.generation < 1 || !/^[a-f0-9]{64}$/.test(prepared.requirementDigest) || !oid(prepared.baseCommit) || !oid(prepared.baseTree) || prepared.directory !== destination(prepared.runId, prepared.generation)) fail('WORKSPACE_PREPARED_INVALID')
  }
  async function prepare({ runId, generation, requirementDigest, baseCommit }) {
    const body = { version: 1, action: 'workspace', root, sourceRepository, runId, generation, requirementDigest, baseCommit, baseTree: '0'.repeat(40), directory: destination(runId, generation) }
    validate({ ...body, digest: executionDigest(body) })
    await admit(sourceRepository)
    body.baseTree = (await manifest(sourceRepository, baseCommit)).tree
    return Object.freeze({ ...body, digest: executionDigest(body) })
  }
  const success = prepared => ({ status: 'succeeded', directory: prepared.directory, baseCommit: prepared.baseCommit, baseTree: prepared.baseTree, preparedDigest: prepared.digest })
  async function reconcile(prepared) {
    validate(prepared)
    try {
      await noLinks(dirname(prepared.directory))
      for (const name of ['metadata.json', 'initialized.json']) {
        const path = join(dirname(prepared.directory), name); await noLinks(path)
        if (canonicalExecutionJson(JSON.parse(await readFile(path, 'utf8'))) !== canonicalExecutionJson(prepared)) fail('WORKSPACE_IDENTITY_CONFLICT')
      }
      await admit(prepared.directory)
      if (await text(prepared.directory, ['rev-parse', 'HEAD']) !== prepared.baseCommit || await text(prepared.directory, ['rev-parse', 'HEAD^{tree}']) !== prepared.baseTree) fail('WORKSPACE_BASE_CONFLICT')
      return success(prepared)
    } catch (error) { if (error.code === 'ENOENT') return { status: 'unknown', directory: prepared.directory, reason: 'workspace_initialization_incomplete' }; throw error }
  }
  async function execute(prepared) {
    validate(prepared); await noLinks(root); await admit(sourceRepository)
    const base = await manifest(sourceRepository, prepared.baseCommit)
    if (base.tree !== prepared.baseTree) fail('WORKSPACE_BASE_CONFLICT')
    const container = dirname(prepared.directory)
    await mkdir(container) // EEXIST是冲突，不能接管、reset或删除。
    await writeExclusive(join(container, 'metadata.json'), prepared)
    // Git for Windows旧版本clone将绝对GIT_DIR传给index-pack，深目录触发内部MAX_PATH。
    // 在最终受管目录初始化并定向fetch固定基线，仍不共享对象/硬链接或复制源工作目录。
    await mkdir(prepared.directory)
    await git(prepared.directory, ['init', '--template='])
    await git(prepared.directory, ['config', 'core.longpaths', 'true'])
    await git(prepared.directory, ['fetch', '--no-tags', '--', sourceRepository, prepared.baseCommit])
    await git(prepared.directory, ['-c', 'core.autocrlf=false', 'checkout', '--detach', prepared.baseCommit])
    if (await text(prepared.directory, ['rev-parse', 'HEAD']) !== prepared.baseCommit) fail('WORKSPACE_BASE_CONFLICT')
    if (canonicalExecutionJson((await checkedPaths(prepared.directory)).sort()) !== canonicalExecutionJson(base.files.map(file => file.path).sort())) fail('WORKSPACE_CHECKOUT_MISMATCH')
    for (const file of base.files) {
      const path = join(prepared.directory, file.path); await noLinks(path)
      const bytes = await readFile(path)
      if (bytes.length !== file.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.oid) fail('WORKSPACE_CHECKOUT_MISMATCH')
    }
    const pending = join(container, 'initialized.pending')
    await writeExclusive(pending, prepared); await rename(pending, join(container, 'initialized.json'))
    return reconcile(prepared)
  }
  return { prepare, execute, reconcile }
}
