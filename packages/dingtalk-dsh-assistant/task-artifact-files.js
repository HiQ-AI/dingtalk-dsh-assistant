import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, open, link, unlink } from 'node:fs/promises'
import { isAbsolute, resolve, join, relative, dirname, sep, extname } from 'node:path'
import { canonicalExecutionJson, executionDigest, executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(`TASK_ARTIFACT_${code}`) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 180
  && !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(value) && !/[. ]$/u.test(value)
  && value !== '.' && value !== '..' && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(value)
const identity = value => safeName(value) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
const mediaTypes = { '.md': 'text/markdown', '.txt': 'text/plain', '.sql': 'application/sql',
  '.csv': 'text/csv', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }

// 每一层都检查；仅检查最终 realpath 会漏掉根目录上方的 junction。
async function checkedDirectory(path, create = false) {
  const parent = dirname(path)
  if (parent !== path) await checkedDirectory(parent, create)
  let info = await lstat(path).catch(error => { if (error.code === 'ENOENT' && create) return null; throw error })
  if (!info) {
    await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error })
    info = await lstat(path)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('SCOPE_DENIED')
  const actual = await realpath(path)
  if (relative(path, actual) !== '') fail('SCOPE_DENIED')
  return path
}

async function readRegular(path, maxBytes) {
  await checkedDirectory(dirname(path))
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) fail('SCOPE_DENIED')
  if (before.size > maxBytes) fail('CAPACITY_EXCEEDED')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('FILE_CHANGED')
    const chunks = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (!bytesRead) break
      total += bytesRead
      if (total > maxBytes) fail('CAPACITY_EXCEEDED')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const bytes = Buffer.concat(chunks, total)
    const afterOpen = await handle.stat(), after = await lstat(path)
    await checkedDirectory(dirname(path))
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || afterOpen.mtimeMs !== opened.mtimeMs
      || afterOpen.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size) fail('FILE_CHANGED')
    return bytes
  } finally { await handle.close() }
}

async function publish(path, bytes) {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null
    await checkedDirectory(dirname(path))
    await link(temporary, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await readRegular(path, bytes.length)).equals(bytes)) fail('CONFLICT')
  } finally {
    await handle?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

/** Host 提供根及授权来源；文件描述符只含元数据，原字节保存在受管目录。 */
export function createTaskArtifactFiles({ root, maxFileBytes = 20 * 1024 * 1024,
  maxBatchBytes = 50 * 1024 * 1024, maxFiles = 20, getTaskDirectories }) {
  if (typeof root !== 'string' || !isAbsolute(root)
    || getTaskDirectories !== undefined && typeof getTaskDirectories !== 'function'
    || [maxFileBytes, maxBatchBytes, maxFiles].some(value => !Number.isSafeInteger(value) || value <= 0)) fail('CONFIG_INVALID')
  const configuredRoot = resolve(root)
  async function artifactDirectory(file) {
    const directories = await getTaskDirectories?.(file.taskId)
    const base = directories == null ? configuredRoot : directories.outputs
    if (typeof base !== 'string' || !isAbsolute(base)) fail('CONFIG_INVALID')
    return join(resolve(base), file.taskId, file.artifactId)
  }
  function binding(input) {
    const { taskId, requirementRevision, producer, role, fileName } = input ?? {}
    if (!identity(taskId) || !Number.isSafeInteger(requirementRevision) || requirementRevision < 1
      || !producer || !identity(producer.runId) || !identity(producer.nodeRunId)
      || typeof producer.outputRef !== 'string' || !producer.outputRef.trim() || producer.outputRef.length > 1024
      || !safeName(role) || !safeName(fileName) || fileName.toLowerCase() === 'descriptor.json') fail('INPUT_INVALID')
    return { version: 1, taskId, requirementRevision,
      producer: { runId: producer.runId, nodeRunId: producer.nodeRunId, outputRef: producer.outputRef }, role, fileName }
  }
  function descriptor(input, bytes) {
    return describeIdentity({ ...input, size: bytes.length, sha256: hash(bytes) })
  }
  function describeIdentity(input) {
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileBytes
      || input.size > maxBatchBytes || !hex(input.sha256)) fail('DESCRIPTOR_INVALID')
    const base = { ...binding(input), mediaType: mediaTypes[extname(input.fileName).toLowerCase()] ?? 'application/octet-stream',
      size: input.size, sha256: input.sha256 }
    const artifactId = executionDigest(base)
    return { ...base, artifactId, fileRef: `${base.taskId}/${artifactId}/${base.fileName}` }
  }
  async function resolveFile(file) {
    binding(file)
    if (!hex(file.artifactId) || !hex(file.sha256) || !Number.isSafeInteger(file.size)
      || file.size < 0 || file.size > maxFileBytes) fail('DESCRIPTOR_INVALID')
    const directory = await artifactDirectory(file)
    await checkedDirectory(directory)
    const stored = JSON.parse((await readRegular(join(directory, 'descriptor.json'), 16384)).toString('utf8'))
    if (canonicalExecutionJson(stored) !== canonicalExecutionJson(file)) fail('DESCRIPTOR_MISMATCH')
    const path = join(directory, file.fileName), bytes = await readRegular(path, maxFileBytes)
    if (canonicalExecutionJson(descriptor(file, bytes)) !== canonicalExecutionJson(stored)) fail('DIGEST_MISMATCH')
    return { ...stored, directory, path }
  }
  async function register(input) {
    binding(input)
    if (!Buffer.isBuffer(input.bytes) && !(input.bytes instanceof Uint8Array)) fail('BYTES_REQUIRED')
    const bytes = Buffer.from(input.bytes)
    if (bytes.length > maxFileBytes || bytes.length > maxBatchBytes) fail('CAPACITY_EXCEEDED')
    const file = descriptor(input, bytes), directory = await artifactDirectory(file)
    await checkedDirectory(directory, true)
    await publish(join(directory, file.fileName), bytes)
    await publish(join(directory, 'descriptor.json'), Buffer.from(canonicalExecutionJson(file)))
    await resolveFile(file)
    return file
  }
  async function importBytes(input, verifyDigest) {
    binding(input)
    if (typeof input.sourceRoot !== 'string' || !isAbsolute(input.sourceRoot)
      || typeof input.relativePath !== 'string' || !input.relativePath || isAbsolute(input.relativePath)
      || input.relativePath.includes(':') || input.relativePath.split(/[\\/]/u).some(part => !safeName(part))
      || verifyDigest && !hex(input.expectedSha256)) fail('SOURCE_INVALID')
    const sourceRoot = resolve(input.sourceRoot), path = resolve(sourceRoot, input.relativePath)
    const scope = relative(sourceRoot, path)
    if (!scope || scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)) fail('SCOPE_DENIED')
    await checkedDirectory(sourceRoot)
    const bytes = await readRegular(path, maxFileBytes)
    if (verifyDigest && hash(bytes) !== input.expectedSha256) fail('SOURCE_DIGEST_MISMATCH')
    return bytes
  }
  async function prepareImport(input) { return descriptor(input, await importBytes(input, false)) }
  async function importFile(input) { return register({ ...input, bytes: await importBytes(input, true) }) }
  async function validateManifest(files, { taskId, requirementRevision } = {}) {
    if (!identity(taskId) || !Number.isSafeInteger(requirementRevision) || requirementRevision < 1
      || !Array.isArray(files) || files.length === 0 || files.length > maxFiles) fail('MANIFEST_INVALID')
    const seen = new Set(), verified = []
    let total = 0
    for (const file of files) {
      if (!file || file.taskId !== taskId || file.requirementRevision !== requirementRevision) fail('MANIFEST_SCOPE_DENIED')
      if (seen.has(file.artifactId)) fail('MANIFEST_DUPLICATE')
      seen.add(file.artifactId)
      await resolveFile(file)
      total += file.size
      if (total > maxBatchBytes) fail('CAPACITY_EXCEEDED')
      verified.push(structuredClone(file))
    }
    return verified
  }
  async function inspect(input) {
    binding(input)
    if (!Buffer.isBuffer(input.bytes) && !(input.bytes instanceof Uint8Array)) fail('BYTES_REQUIRED')
    const bytes = Buffer.from(input.bytes)
    if (bytes.length > maxFileBytes || bytes.length > maxBatchBytes) fail('CAPACITY_EXCEEDED')
    const file = descriptor(input, bytes)
    try { await resolveFile(file); return file }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  return { register, importFile, prepareImport, describeIdentity, resolve: resolveFile, validateManifest, inspect }
}
