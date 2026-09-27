import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { stripVTControlCharacters } from 'node:util'

const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const artifactName = /^sha256-[a-f0-9]{64}\.json$/
function collectArtifactRefs(value, refs, key = '', parent = null, depth = 0) {
  if (depth > 128) fail('BACKUP_ARTIFACT_CAPACITY')
  if (typeof value === 'string') {
    const referenceField = /(?:Ref|Refs|_ref|_refs)$/.test(key) || key === 'evidenceIds'
      || key === 'ref' && parent?.digest === value.slice(7, -5)
    if (referenceField && artifactName.test(value)) refs.add(value)
    // 控制账的JSON容器及序列化引用列；正文/日志/用户文本不解析为引用。
    else if (/^(?:body|payload|args|result|config)$|_refs$/.test(key) && /^[\[{]/.test(value)) {
      let parsed; try { parsed = JSON.parse(value) } catch { return }
      collectArtifactRefs(parsed, refs, key, parent, depth + 1)
    }
  } else if (Array.isArray(value)) for (const child of value) collectArtifactRefs(child, refs, key, parent, depth + 1)
  else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) collectArtifactRefs(child, refs, childKey, value, depth + 1)
}
export async function verifyArtifactClosure(directory, initialRefs, { maxArtifacts = 100000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const pending = new Set(initialRefs), visited = new Set(); let bytesRead = 0
  for (const ref of pending) {
    if (visited.has(ref)) continue
    if (!artifactName.test(ref)) fail('BACKUP_ARTIFACT_INVALID')
    if (visited.size >= maxArtifacts) fail('BACKUP_ARTIFACT_CAPACITY')
    const path = join(directory, ref)
    let info; try { info = await lstat(path) } catch { fail('BACKUP_ARTIFACT_MISSING') }
    if (!info.isFile() || info.isSymbolicLink()) fail('BACKUP_ARTIFACT_INVALID')
    if (bytesRead + info.size > maxBytes) fail('BACKUP_ARTIFACT_CAPACITY')
    const bytes = await readFile(path); bytesRead += bytes.length
    if (bytesRead > maxBytes) fail('BACKUP_ARTIFACT_CAPACITY')
    if (`sha256-${hash(bytes)}.json` !== ref) fail('BACKUP_ARTIFACT_INVALID')
    let value; try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('BACKUP_ARTIFACT_INVALID') }
    visited.add(ref); collectArtifactRefs(value, pending)
  }
  return { artifactRefs: visited.size, artifactBytes: bytesRead }
}
const profileFiles = ['cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml']
async function files(root, prefix = '') {
  const result = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) fail('BACKUP_LINK_UNSAFE')
    if (entry.isDirectory()) result.push(...await files(root, path))
    else if (entry.isFile()) result.push(path)
    else fail('BACKUP_FILE_UNSAFE')
  }
  return result.sort()
}
function databaseProof(db) {
  if (db.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok')
    || db.prepare('PRAGMA foreign_key_check').all().length) fail('BACKUP_DATABASE_INVALID')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  const refs = new Set(), proofs = []
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
    for (const row of rows) collectArtifactRefs(row, refs)
    proofs.push({ name, rows: rows.length, digest: hash(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())) })
  }
  return { tables: proofs, refs: [...refs].sort() }
}

/** 只写本轮备份目录内的一致SQLite副本；源文件及运行库均只读。 */
export async function verifyDeploymentBackup({ runtime, domain, profile, backupRoot }) {
  const manifest = []
  async function compare(source, target, label) {
    if (!(await lstat(source)).isFile() || !(await lstat(target)).isFile()) fail('BACKUP_FILE_UNSAFE')
    const sourceBytes = await readFile(source), targetBytes = await readFile(target)
    if (hash(sourceBytes) !== hash(targetBytes)) fail('BACKUP_COPY_MISMATCH')
    manifest.push({ path: label, bytes: sourceBytes.length, sha256: hash(sourceBytes) })
  }
  for (const [source, target, label] of [[domain,join(backupRoot,'domain'),'domain'], [join(runtime,'artifacts'),join(backupRoot,'runtime/artifacts'),'runtime/artifacts']]) {
    const sourceFiles = await files(source), targetFiles = await files(target)
    if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) fail('BACKUP_FILE_SET_MISMATCH')
    for (const path of sourceFiles) await compare(join(source,path),join(target,path),`${label}/${path}`)
  }
  for (const entry of await readdir(runtime, { withFileTypes: true })) if (entry.isFile()) await compare(join(runtime,entry.name),join(backupRoot,'runtime',entry.name),`runtime/${entry.name}`)
  for (const name of profileFiles) {
    try { await lstat(join(profile,name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    await compare(join(profile,name),join(backupRoot,'profile',name),`profile/${name}`)
  }
  const sourceDb = new DatabaseSync(join(runtime,'control.sqlite'), { readOnly: true })
  const restoredPath = join(backupRoot,'runtime','verified-control.sqlite')
  let original
  try { original = databaseProof(sourceDb); await backup(sourceDb, restoredPath) } finally { sourceDb.close() }
  const restoredDb = new DatabaseSync(restoredPath, { readOnly: true })
  let restored
  try { restored = databaseProof(restoredDb) } finally { restoredDb.close() }
  if (JSON.stringify(original) !== JSON.stringify(restored)) fail('BACKUP_DATABASE_READBACK_MISMATCH')
  const closure = await verifyArtifactClosure(join(backupRoot,'runtime/artifacts'), restored.refs)
  return { verified: true, manifest, database: { restoreFile: 'runtime/verified-control.sqlite',
    sha256: hash(await readFile(restoredPath)), tables: restored.tables, ...closure } }
}

/** 凭据只在内存交换，错误不包含启动URL、cookie或日志内容。 */
export async function verifyDeploymentWeb(logPath, fetchImpl = fetch) {
  const healthResponse = await fetchImpl('http://127.0.0.1:18998/health', { signal: AbortSignal.timeout(10000) })
  if (!healthResponse.ok) fail('DEPLOY_HEALTH_UNAVAILABLE')
  const health = await healthResponse.json()
  if (!['ok','degraded'].includes(health.status)) fail('DEPLOY_HEALTH_UNAVAILABLE')
  if (health.recoveryIssueCount !== 0) fail('DEPLOY_RECOVERY_ISSUES')
  const log = stripVTControlCharacters(await readFile(logPath,'utf8'))
  const urls = (log.match(/https?:\/\/[^\s<>]+:3080[^\s<>]*/g) ?? []).flatMap(value => { try { return [new URL(value)] } catch { return [] } })
  const url = urls.filter(value => value.protocol === 'http:' && value.hostname === '127.0.0.1' && value.port === '3080' && value.searchParams.has('token')).at(-1)
  if (!url) fail('DEPLOY_WEB_CREDENTIAL_UNAVAILABLE')
  const exchange = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  if (exchange.status !== 303 || exchange.headers.get('location') !== '/') fail('DEPLOY_WEB_AUTH_FAILED')
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';',1)[0]).join('; ')
  if (!cookie) fail('DEPLOY_WEB_AUTH_FAILED')
  const web = await fetchImpl(new URL('/',url), { redirect: 'manual', headers: { cookie }, signal: AbortSignal.timeout(10000) })
  if (web.status !== 200 || !(await web.text()).match(/<!doctype html|<html[\s>]/i)) fail('DEPLOY_WEB_READBACK_FAILED')
  return { recoveryIssueCount: 0, authenticatedWebStatus: 200, tokenExchangeStatus: 303,
    controlHealth: health.status, inboundProcessing: health.inboundProcessing === true, credentialPrinted: false }
}
