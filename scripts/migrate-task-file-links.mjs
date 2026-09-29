// 终态任务文件收纳：任务目录为新入口，旧普通路径保留同文件硬链接，冻结证据不改写。
import { lstat, readdir, readFile, rename, link, unlink, open, copyFile, mkdir, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join, relative, isAbsolute, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkedTaskDirectory } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'

const fail = code => { throw new Error(code) }
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const inside = (root, path) => { const rel = relative(root, path); return !rel || !rel.startsWith('..') && !isAbsolute(rel) }
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
async function ancestors(path) {
  const entry = await exists(path)
  if (entry) return checkedTaskDirectory(path)
  if (dirname(path) !== path) return ancestors(dirname(path))
}
async function files(path, excluded) {
  if (excluded.has(resolve(path))) return []
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) fail('MIGRATION_LINK_REJECTED')
  if (entry.isFile()) return [path]
  if (!entry.isDirectory()) fail('MIGRATION_SPECIAL_FILE_REJECTED')
  await checkedTaskDirectory(path)
  const result = []
  for (const name of (await readdir(path)).sort()) result.push(...await files(join(path, name), excluded))
  return result
}

/** --check 不创建目录、探针或日志；计划显式列出终态任务授权范围。 */
export async function checkMigration(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.entries) || !plan.entries.length) fail('MIGRATION_PLAN_INVALID')
  const mappings = [], sources = new Set(), destinations = new Set()
  for (const entry of plan.entries) {
    if (!isAbsolute(entry.source ?? '') || !isAbsolute(entry.destination ?? '')) fail('MIGRATION_PATH_INVALID')
    const source = resolve(entry.source), destination = resolve(entry.destination)
    if (parse(source).root.toLowerCase() !== parse(destination).root.toLowerCase() || inside(source, destination) || inside(destination, source)) fail('MIGRATION_PATH_OVERLAP_OR_VOLUME')
    await checkedTaskDirectory(dirname(source)); const destinationAncestor = await ancestors(dirname(destination))
    const destinationDevice = String((await lstat(destinationAncestor, { bigint: true })).dev)
    if (await exists(destination)) fail('MIGRATION_DESTINATION_EXISTS')
    const directory = (await lstat(source)).isDirectory()
    const excluded = new Set()
    for (const value of entry.exclude ?? []) {
      if (!directory || typeof value !== 'string' || isAbsolute(value) || !value || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) fail('MIGRATION_EXCLUSION_INVALID')
      excluded.add(resolve(source, value))
    }
    for (const path of await files(source, excluded)) {
      const target = directory ? join(destination, relative(source, path)) : destination
      if (destinations.has(path.toLowerCase()) || destinations.has(target.toLowerCase()) || sources.has(target.toLowerCase())) fail('MIGRATION_DUPLICATE_PATH')
      sources.add(path.toLowerCase()); destinations.add(target.toLowerCase())
      const stat = await lstat(path, { bigint: true })
      if (String(stat.dev) !== destinationDevice) fail('MIGRATION_VOLUME_MISMATCH')
      mappings.push({ source: path, destination: target, sha256: await hash(path), bytes: Number(stat.size), device: String(stat.dev), inode: String(stat.ino) })
    }
  }
  const result = { version: 1, mappings, files: mappings.length, bytes: mappings.reduce((sum, file) => sum + file.bytes, 0) }
  const fingerprint = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  if (plan.expectedManifestDigest && plan.expectedManifestDigest !== fingerprint) fail('MIGRATION_REVIEWED_MANIFEST_CHANGED')
  return { ...result, manifestDigest: fingerprint }
}
async function verify(file, path) {
  await checkedTaskDirectory(dirname(path))
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== file.bytes || await hash(path) !== file.sha256) fail('MIGRATION_FILE_CHANGED')
  return stat
}
export async function verifyMigration(journal) {
  for (const file of journal.mappings) {
    const a = await verify(file, file.source), b = await verify(file, file.destination)
    if (a.ino !== b.ino || a.dev !== b.dev || a.nlink < 2n) fail('MIGRATION_HARDLINK_MISMATCH')
  }
  return { files: journal.files, bytes: journal.bytes, verified: true }
}
/** 独立普通副本，不以硬链接冒充灾难恢复备份。 */
export async function backupMigration(plan, directory) {
  const checked = await checkMigration(plan)
  if (!isAbsolute(directory ?? '') || plan.entries.some(entry => inside(resolve(entry.source), resolve(directory))
    || inside(resolve(directory), resolve(entry.source)) || inside(resolve(entry.destination), resolve(directory))
    || inside(resolve(directory), resolve(entry.destination)))) fail('MIGRATION_BACKUP_SCOPE_INVALID')
  await checkedTaskDirectory(dirname(directory), true)
  await mkdir(directory) // 新目录专用；已有或残留备份不覆盖。
  await checkedTaskDirectory(directory)
  const unique = [...new Map(checked.mappings.map(file => [file.source, file])).values()], mappings = []
  for (const [index, file] of unique.entries()) {
    const before = await verify(file, file.source)
    if (String(before.dev) !== file.device || String(before.ino) !== file.inode) fail('MIGRATION_SOURCE_REPLACED')
    const backup = join(directory, `${String(index + 1).padStart(8, '0')}.bin`)
    await copyFile(file.source, backup, constants.COPYFILE_EXCL)
    const copied = await verify(file, backup)
    if (copied.ino === before.ino && copied.dev === before.dev) fail('MIGRATION_BACKUP_NOT_INDEPENDENT')
    const after = await verify(file, file.source)
    if (after.ino !== before.ino || after.dev !== before.dev) fail('MIGRATION_SOURCE_REPLACED')
    const mode = Number(copied.mode & 0o777n)
    await chmod(backup, mode | 0o200) // Git对象常为只读；仅临时开放独立副本以fsync。
    const handle = await open(backup, 'r+')
    try { await handle.sync() } finally { await handle.close(); await chmod(backup, mode) }
    mappings.push({ source: file.source, backup, sha256: file.sha256, bytes: file.bytes, sourceDevice: file.device, sourceInode: file.inode })
  }
  const manifestPath = join(directory, 'backup-manifest.json'), manifest = { version: 1, migrationManifestDigest: checked.manifestDigest,
    files: mappings.length, bytes: mappings.reduce((sum, file) => sum + file.bytes, 0), mappings }
  const handle = await open(manifestPath, 'wx')
  try { await handle.writeFile(JSON.stringify(manifest, null, 2)); await handle.sync() } finally { await handle.close() }
  return verifyMigrationBackup(manifestPath)
}
export async function verifyMigrationBackup(manifestPath) {
  if (!isAbsolute(manifestPath ?? '')) fail('MIGRATION_BACKUP_MANIFEST_INVALID')
  await checkedTaskDirectory(dirname(manifestPath))
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) fail('MIGRATION_BACKUP_MANIFEST_INVALID')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.mappings) || manifest.files !== manifest.mappings.length
    || manifest.bytes !== manifest.mappings.reduce((sum, file) => sum + file.bytes, 0)) fail('MIGRATION_BACKUP_MANIFEST_INVALID')
  for (const [index, file] of manifest.mappings.entries()) {
    if (file.backup !== join(dirname(manifestPath), `${String(index + 1).padStart(8, '0')}.bin`)) fail('MIGRATION_BACKUP_MANIFEST_INVALID')
    const stat = await verify(file, file.backup)
    if (String(stat.dev) === file.sourceDevice && String(stat.ino) === file.sourceInode) fail('MIGRATION_BACKUP_NOT_INDEPENDENT')
  }
  return { manifestPath, files: manifest.files, bytes: manifest.bytes, verified: true }
}
/** 可处理 rename 成功但 link 尚未执行的崩溃点；冲突或内容变化一律停止。 */
export async function rollbackMigration(journal) {
  for (const file of [...journal.mappings].reverse()) {
    const source = await exists(file.source), destination = await exists(file.destination)
    if (!destination) { if (!source) fail('MIGRATION_BOTH_MISSING'); await verify(file, file.source); continue }
    const b = await verify(file, file.destination)
    if (!source) { await checkedTaskDirectory(dirname(file.source)); await rename(file.destination, file.source); continue }
    const a = await verify(file, file.source)
    if (a.ino !== b.ino || a.dev !== b.dev) fail('MIGRATION_ROLLBACK_CONFLICT')
    await unlink(file.destination)
  }
  return { rolledBack: true, files: journal.files }
}
export async function executeMigration(plan, journalPath) {
  const journal = await checkMigration(plan)
  if (!isAbsolute(journalPath ?? '') || journal.mappings.some(file => inside(dirname(file.destination), journalPath) || inside(dirname(file.source), journalPath))) fail('MIGRATION_JOURNAL_SCOPE_INVALID')
  await checkedTaskDirectory(dirname(journalPath), true)
  const handle = await open(journalPath, 'wx')
  try { await handle.writeFile(JSON.stringify(journal, null, 2)); await handle.sync() } finally { await handle.close() }
  try {
    for (const file of journal.mappings) {
      const stat = await verify(file, file.source)
      if (String(stat.dev) !== file.device || String(stat.ino) !== file.inode) fail('MIGRATION_SOURCE_REPLACED')
      await checkedTaskDirectory(dirname(file.destination), true)
      if (await exists(file.destination)) fail('MIGRATION_DESTINATION_EXISTS')
      await rename(file.source, file.destination)
      await link(file.destination, file.source)
    }
    return await verifyMigration(journal)
  } catch (error) {
    try { await rollbackMigration(journal) } catch (rollback) { error.message += `; rollback: ${rollback.message}; journal: ${journalPath}` }
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, inputPath, journalPath] = process.argv.slice(2)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const result = mode === '--verify-backup' ? await verifyMigrationBackup(resolve(inputPath))
    : mode === '--backup' ? await backupMigration(input, journalPath)
    : mode === '--check' ? await checkMigration(input)
    : mode === '--execute' ? await executeMigration(input, journalPath)
      : mode === '--rollback' ? await rollbackMigration(input)
        : mode === '--verify' ? await verifyMigration(input) : fail('MIGRATION_MODE_INVALID')
  console.log(JSON.stringify(result))
}
