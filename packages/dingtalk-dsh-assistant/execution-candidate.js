import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpath, lstat, readdir, open, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

const MAX_FILE = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_FILES = 10000
const verifiedReceipts = new WeakSet()
const fail = code => { throw executionError(code) }
async function candidateDirectory(gitDirectory) {
  const directory = join(gitDirectory, `candidate-${randomUUID()}`)
  await mkdir(directory)
  return directory
}
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)
// 固定 argv、禁止 shell；清除调用进程的 Git 目录/配置注入。
async function git(repository, args, { input, index, limit = MAX_TOTAL } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' })
  if (index) env.GIT_INDEX_FILE = index
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['--no-pager', '-c', 'core.longpaths=true', '-C', repository, ...args], { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let length = 0, stderr = '', overflow = false
    const timer = setTimeout(() => { overflow = true; child.kill() }, 30000)
    child.stdout.on('data', bytes => { length += bytes.length; if (length > limit) { overflow = true; child.kill() } else chunks.push(bytes) })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(0, 2048) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (overflow) reject(executionError('CANDIDATE_GIT_LIMIT')); else if (code) reject(executionError('CANDIDATE_GIT_FAILED', stderr)); else resolveResult(Buffer.concat(chunks)) })
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
async function identity(repository) {
  if (typeof repository !== 'string' || !repository) fail('CANDIDATE_REPOSITORY_INVALID')
  const root = await realpath(repository)
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).toString().trim())
  if (root !== top) fail('CANDIDATE_REPOSITORY_ROOT_REQUIRED')
  const gitDirectory = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).toString().trim())
  // 本适配器不运行 hooks/filter。配置了执行型扩展的仓库不准入，不能默默绕过。
  const config = (await git(root, ['config', '--null', '--list'])).toString()
  for (const entry of config.split('\0')) {
    const [key, ...rest] = entry.split('\n'), value = rest.join('\n')
    if (/^(core\.hooksPath|core\.attributesFile|extensions\.partialClone)$/i.test(key) || (/^core\.fsmonitor$/i.test(key) && value !== 'false')) fail('CANDIDATE_UNSUPPORTED_GIT_EXTENSION')
  }
  const common = await realpath(resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).toString().trim()))
  try { if ((await readdir(join(common, 'hooks'))).some(name => !name.endsWith('.sample'))) fail('CANDIDATE_HOOKS_UNSUPPORTED') } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { repository: root, gitDirectory }
}
function pathValid(path) { return typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.' || part.toLowerCase() === '.git') && !/[:\0\r\n]/.test(path) }
async function filesInTree(repository, tree) {
  if (!oid(tree)) fail('CANDIDATE_TREE_INVALID')
  if ((await git(repository, ['cat-file', '-t', tree])).toString().trim() !== 'tree') fail('CANDIDATE_TREE_INVALID')
  const raw = await git(repository, ['cat-file', 'tree', tree])
  if (createHash(tree.length === 40 ? 'sha1' : 'sha256').update(`tree ${raw.length}\0`).update(raw).digest('hex') !== tree) fail('CANDIDATE_TREE_INVALID')
  const records = (await git(repository, ['ls-tree', '-rz', '--long', tree])).toString('utf8').split('\0').filter(Boolean)
  if (records.length > MAX_FILES) fail('CANDIDATE_FILE_LIMIT')
  let total = 0
  return records.map(record => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record)
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !pathValid(match[5])) fail('CANDIDATE_ENTRY_UNSUPPORTED')
    const size = Number(match[4]); total += size
    if (!Number.isSafeInteger(size) || size > MAX_FILE || total > MAX_TOTAL) fail('CANDIDATE_BYTE_LIMIT')
    return Object.freeze({ path: match[5], mode: match[1], oid: match[3], size })
  })
}
export async function freezeCandidate({ repository, baseCommit, generation, requirementDigest }) {
  const repo = await identity(repository)
  if (!oid(baseCommit) || !Number.isSafeInteger(generation) || generation < 1 || !/^[a-f0-9]{64}$/i.test(requirementDigest)) fail('CANDIDATE_IDENTITY_INVALID')
  if ((await git(repo.repository, ['cat-file', '-t', baseCommit])).toString().trim() !== 'commit') fail('CANDIDATE_BASE_INVALID')
  await filesInTree(repo.repository, (await git(repo.repository, ['rev-parse', `${baseCommit}^{tree}`])).toString().trim())
  const tracked = (await git(repo.repository, ['ls-files', '--stage', '-z'])).toString().split('\0').filter(Boolean)
  const modes = new Map()
  for (const record of tracked) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(record)
    if (!match || match[2] !== '0' || !['100644', '100755'].includes(match[1])) fail('CANDIDATE_INDEX_UNSUPPORTED')
    modes.set(match[3], match[1])
  }
  const paths = [...new Set([...modes.keys(), ...(await git(repo.repository, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean)])].sort()
  if (paths.length > MAX_FILES) fail('CANDIDATE_FILE_LIMIT')
  const attributes = (await git(repo.repository, ['check-attr', '-z', '--stdin', 'filter'], { input: Buffer.from(paths.join('\0') + '\0') })).toString().split('\0')
  for (let i = 2; i < attributes.length; i += 3) if (!['unspecified', 'unset'].includes(attributes[i])) fail('CANDIDATE_UNSUPPORTED_GIT_EXTENSION')
  const directory = await candidateDirectory(repo.gitDirectory), index = join(directory, 'index'), blobs = []
  try {
    await git(repo.repository, ['read-tree', '--empty'], { index })
    let total = 0; const entries = []
    for (const path of paths) {
      if (!pathValid(path)) fail('CANDIDATE_PATH_INVALID')
      const full = join(repo.repository, path)
      let metadata
      try { metadata = await lstat(full) } catch (error) { if (error.code === 'ENOENT' && modes.has(path)) continue; throw error }
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail('CANDIDATE_ENTRY_UNSUPPORTED')
      // 每一级路径都禁止链接，避免通过父目录越出受管仓库。
      let parent = repo.repository
      for (const part of path.split('/').slice(0, -1)) { parent = join(parent, part); if ((await lstat(parent)).isSymbolicLink()) fail('CANDIDATE_ENTRY_UNSUPPORTED') }
      total += metadata.size; if (metadata.size > MAX_FILE || total > MAX_TOTAL) fail('CANDIDATE_BYTE_LIMIT')
      const file = await open(full, 'r'); let bytes
      try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.size !== metadata.size || opened.ino !== metadata.ino) fail('CANDIDATE_FILE_CHANGED')
        const buffer = Buffer.alloc(metadata.size + 1); let length = 0
        while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
        const after = await file.stat()
        if (length !== metadata.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('CANDIDATE_FILE_CHANGED')
        bytes = buffer.subarray(0, length)
      } finally { await file.close() }
      // 固定已经校验的字节副本，batch只读这些副本，不再次读取可变工作文件。
      const frozenPath = join(directory, `blob-${blobs.length}`)
      const hash = createHash(baseCommit.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      await writeFile(frozenPath, bytes, { flag: 'wx' })
      blobs.push({ path: frozenPath, hash })
      const mode = process.platform === 'win32' ? (modes.get(path) ?? '100644') : (metadata.mode & 0o111 ? '100755' : '100644')
      entries.push(`${mode} ${hash}\t${path}\0`)
    }
    if (blobs.length) {
      const input = Buffer.from(blobs.map(blob => JSON.stringify(blob.path.replaceAll('\\', '/'))).join('\n') + '\n')
      const hashes = (await git(repo.repository, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input, limit: MAX_FILES * 66 })).toString().trim().split('\n')
      if (hashes.length !== blobs.length || hashes.some((hash, index) => hash !== blobs[index].hash)) fail('CANDIDATE_BLOB_INVALID')
    }
    await git(repo.repository, ['update-index', '-z', '--index-info'], { index, input: Buffer.from(entries.join('')) })
    const tree = (await git(repo.repository, ['write-tree'], { index })).toString().trim()
    const payload = { version: 1, ...repo, baseCommit, tree, generation, requirementDigest }
    const candidate = Object.freeze({ ...payload, digest: executionDigest(payload) })
    await readCandidate(candidate)
    return candidate
  } finally {
    await unlink(index).catch(error => { if (error.code !== 'ENOENT') throw error })
    for (const blob of blobs) await unlink(blob.path)
    await rmdir(directory)
  }
}
export async function readCandidate(candidate) {
  if (!candidate || Object.keys(candidate).sort().join(',') !== 'baseCommit,digest,generation,gitDirectory,repository,requirementDigest,tree,version') fail('CANDIDATE_IDENTITY_INVALID')
  const { digest, ...payload } = candidate
  if (executionDigest(payload) !== digest || payload.version !== 1 || !Number.isSafeInteger(payload.generation) || payload.generation < 1 || !/^[a-f0-9]{64}$/i.test(payload.requirementDigest) || !oid(payload.baseCommit)) fail('CANDIDATE_DIGEST_INVALID')
  const repo = await identity(payload.repository)
  if (repo.gitDirectory !== payload.gitDirectory || repo.repository !== payload.repository) fail('CANDIDATE_REPOSITORY_MISMATCH')
  if ((await git(repo.repository, ['cat-file', '-t', payload.baseCommit])).toString().trim() !== 'commit') fail('CANDIDATE_BASE_INVALID')
  const files = Object.freeze(await filesInTree(repo.repository, payload.tree)), byPath = new Map(files.map(file => [file.path, file]))
  const directory = await candidateDirectory(repo.gitDirectory), index = join(directory, 'index')
  try {
    await git(repo.repository, ['read-tree', payload.tree], { index })
    const attributes = (await git(repo.repository, ['check-attr', '--cached', '-z', '--stdin', 'filter'], { index, input: Buffer.from(files.map(file => file.path).join('\0') + '\0') })).toString().split('\0')
    for (let i = 2; i < attributes.length; i += 3) if (!['unspecified', 'unset'].includes(attributes[i])) fail('CANDIDATE_UNSUPPORTED_GIT_EXTENSION')
  } finally { await unlink(index).catch(error => { if (error.code !== 'ENOENT') throw error }); await rmdir(directory) }
  let loaded
  async function loadBlobs() {
    const unique = [...new Map(files.map(file => [file.oid, file])).values()]
    if (!unique.length) return new Map()
    const output = await git(repo.repository, ['cat-file', '--batch'], { input: Buffer.from(unique.map(file => file.oid).join('\n') + '\n'), limit: MAX_TOTAL + MAX_FILES * 128 })
    const result = new Map(); let offset = 0
    for (const file of unique) {
      const end = output.indexOf(10, offset)
      if (end < offset || end - offset > 100) fail('CANDIDATE_BLOB_INVALID')
      const header = output.subarray(offset, end).toString('ascii')
      if (header !== `${file.oid} blob ${file.size}`) fail('CANDIDATE_BLOB_INVALID')
      offset = end + 1
      if (offset + file.size >= output.length || output[offset + file.size] !== 10) fail('CANDIDATE_BLOB_INVALID')
      const bytes = output.subarray(offset, offset + file.size)
      const actual = createHash(file.oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (actual !== file.oid) fail('CANDIDATE_BLOB_INVALID')
      result.set(file.oid, bytes); offset += file.size + 1
    }
    if (offset !== output.length) fail('CANDIDATE_BLOB_INVALID')
    return result
  }
  return Object.freeze({ candidate: Object.freeze({ ...payload, digest }), files, async readFile(path) {
    const file = byPath.get(path); if (!file) fail('CANDIDATE_FILE_NOT_FOUND')
    const bytes = (await (loaded ??= loadBlobs())).get(file.oid)
    if (!bytes || bytes.length !== file.size) fail('CANDIDATE_BLOB_INVALID')
    // 调用方不能修改下一检查器读到的冻结字节。
    return Buffer.from(bytes)
  } })
}
export async function verifyCandidate({ candidate, checks, signal }) {
  signal?.throwIfAborted()
  const snapshot = await readCandidate(candidate)
  if (!Array.isArray(checks) || !checks.length || checks.length > 32 || new Set(checks.map(check => check.id)).size !== checks.length) fail('CANDIDATE_CHECKS_INVALID')
  checks = checks.map(check => ({ id: check.id, version: check.version, run: check.run }))
  const results = []
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || !check.id || typeof check.version !== 'string' || !check.version || typeof check.run !== 'function') fail('CANDIDATE_CHECKS_INVALID')
    let result
    signal?.throwIfAborted()
    try { result = await check.run(Object.freeze({ files: snapshot.files, readFile: snapshot.readFile, candidateDigest: snapshot.candidate.digest }), { signal }) }
    catch (error) { if (error.executionDrained === false) throw error; result = { passed: false, log: String(error?.message ?? error) } }
    signal?.throwIfAborted()
    if (!result || typeof result.passed !== 'boolean' || typeof result.log !== 'string' || Buffer.byteLength(result.log) > 65536) fail('CANDIDATE_CHECK_RESULT_INVALID')
    results.push(Object.freeze({ id: check.id, version: check.version, passed: result.passed, log: result.log }))
  }
  const payload = { version: 1, candidateDigest: snapshot.candidate.digest, checks: results, passed: results.every(result => result.passed) }
  const receipt = Object.freeze({ ...payload, checks: Object.freeze(results), digest: executionDigest(payload) })
  verifiedReceipts.add(receipt)
  return receipt
}
export async function assertVerifiedCandidate({ candidate, verification, requiredChecks }) {
  if (!verification || !verifiedReceipts.has(verification) || !verification.passed || verification.candidateDigest !== candidate?.digest) fail('CANDIDATE_VERIFICATION_UNTRUSTED')
  if (!Array.isArray(requiredChecks) || !requiredChecks.length || requiredChecks.length !== verification.checks.length || new Set(requiredChecks.map(check => check.id)).size !== requiredChecks.length) fail('CANDIDATE_REQUIRED_CHECKS_MISMATCH')
  for (const check of requiredChecks) if (!verification.checks.some(actual => actual.id === check.id && actual.version === check.version && actual.passed)) fail('CANDIDATE_REQUIRED_CHECKS_MISMATCH')
  return readCandidate(candidate)
}
