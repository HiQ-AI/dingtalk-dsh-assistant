import { lstatSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
const yaml = createRequire('D:/dsh_home/profiles/web/package.json')('yaml')
const defaults = { sourceRoot: 'D:/baibu-agent/task-session-runtime-clean', targetRoot: 'D:/baibu-agent', profilePath: 'D:/dsh_home/profiles/web/cordis.patch.yml', workspacePath: 'D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116/workspace.json', expectedPid: 46748 }
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Error(code) }
const normalize = value => value.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase()
function settings(options = {}) {
  const paths = { ...defaults, ...options }
  for (const key of ['sourceRoot','targetRoot','profilePath','workspacePath']) if (!isAbsolute(paths[key])) fail('MIGRATION_ABSOLUTE_PATH_REQUIRED')
  if (normalize(paths.sourceRoot) === normalize(paths.targetRoot) || !Number.isSafeInteger(paths.expectedPid) || paths.expectedPid < 1) fail('MIGRATION_ARGUMENT_INVALID')
  return paths
}
function exited(pid) { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
function mapPath(value, paths) {
  if (typeof value !== 'string') return value
  const old = normalize(paths.sourceRoot), input = normalize(value)
  if (input !== old && !input.startsWith(old + '/')) return value
  const suffix = value.slice(paths.sourceRoot.length), backslash = value.includes('\\')
  return (backslash ? paths.targetRoot.replaceAll('/', '\\') : paths.targetRoot.replaceAll('\\', '/')) + suffix
}
function tree(root) {
  const entries = []
  function walk(path) {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) fail('MIGRATION_REPARSE_POINT')
    const name = relative(root, path).replaceAll('\\', '/')
    if (info.isDirectory()) { entries.push({ relative: name, type: 'directory' }); for (const item of readdirSync(path)) walk(join(path, item)) }
    else if (info.isFile()) entries.push({ relative: name, type: 'file', bytes: info.size, sha256: hash(readFileSync(path)) })
    else fail('MIGRATION_SPECIAL_FILE')
  }
  for (const bucket of ['.dsh','tasks','session-workspaces']) if (existsSync(join(root, bucket))) walk(join(root, bucket))
  return entries
}
function rootSafe(path) {
  let current = resolve(path)
  while (true) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('MIGRATION_REPARSE_POINT'); const parent = resolve(current, '..'); if (parent === current) break; current = parent }
}
function transformedJson(path, mutate) {
  const original = readFileSync(path), value = JSON.parse(original.toString('utf8')); mutate(value)
  const next = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  return { beforeSha256: hash(original), afterSha256: hash(next), bytes: next }
}
function transformedProfile(path, paths) {
  const original = readFileSync(path)
  const doc = yaml.parseDocument(original.toString('utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (doc.errors.length) fail('MIGRATION_PROFILE_INVALID')
  let changes = 0
  yaml.visit(doc, { Scalar(_key, node) { if (typeof node.value === 'string') { const next = mapPath(node.value, paths); if (next !== node.value) { node.value = next; changes++ } } } })
  const bytes = changes ? Buffer.from(String(doc)) : original
  return { beforeSha256: hash(original), afterSha256: hash(bytes), changes, bytes }
}
function snapshotDatabase(path, paths) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('MIGRATION_DATABASE_CORRUPT')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dynamic_%' ORDER BY name").all()
    const hashes = Object.fromEntries(tables.map(({ name }) => [name, hash(JSON.stringify(db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()))]))
    const changes = [], executionRows = {}
    for (const row of db.prepare('SELECT id,body FROM dynamic_executions ORDER BY id').all()) {
      executionRows[row.id] = hash(row.body)
      const value = JSON.parse(row.body), protectedPaths = value.definition?.protectedPaths
      if (!Array.isArray(protectedPaths)) continue
      const next = protectedPaths.map(item => mapPath(item, paths))
      if (JSON.stringify(next) === JSON.stringify(protectedPaths)) continue
      const oldDb = join(paths.sourceRoot, '.dsh', 'task-sessions.sqlite')
      const allowed = new Set([oldDb, oldDb + '-wal', oldDb + '-shm', oldDb + '.initialized'].map(normalize))
      if (protectedPaths.some(item => mapPath(item, paths) !== item && !allowed.has(normalize(item)))) fail('MIGRATION_PROTECTED_PATH_UNEXPECTED')
      value.definition.protectedPaths = next
      changes.push({ id: row.id, beforeSha256: hash(row.body), afterSha256: hash(JSON.stringify(value)), protectedPaths: next })
    }
    return { hashes, changes, executionRows }
  } finally { db.close() }
}
export function checkMigration(options = {}) {
  const paths = settings(options)
  for (const path of [paths.sourceRoot, paths.targetRoot, paths.profilePath, paths.workspacePath]) rootSafe(path)
  const entries = tree(paths.sourceRoot), moves = []
  for (const bucket of ['.dsh','tasks','session-workspaces']) {
    const source = join(paths.sourceRoot, bucket), target = join(paths.targetRoot, bucket)
    if (!existsSync(source)) fail('MIGRATION_SOURCE_BUCKET_MISSING')
    const names = bucket === '.dsh' ? [''] : readdirSync(source)
    for (const name of names) { const destination = name ? join(target, name) : target; rootSafe(destination); if (existsSync(destination)) fail('MIGRATION_TARGET_COLLISION'); moves.push({ source: name ? join(source, name) : source, target: destination }) }
  }
  const edits = []
  for (const entry of entries.filter(item => item.type === 'file')) {
    const old = join(paths.sourceRoot, entry.relative), target = join(paths.targetRoot, entry.relative)
    let change
    let kind
    if (entry.relative.startsWith('tasks/.session-routes/') && entry.relative.endsWith('.json')) { kind = 'route'; change = transformedJson(old, value => { value.cwd = mapPath(value.cwd, paths) }) }
    else if (/^tasks\/[^/]+\/materials\/source-[^/]+\.json$/u.test(entry.relative)) { kind = 'material'; change = transformedJson(old, value => {
      value.path = mapPath(value.path, paths)
      for (const resource of value.resources ?? []) { if (resource.path !== undefined) resource.path = mapPath(resource.path, paths); if (resource.value?.image?.path !== undefined) resource.value.image.path = mapPath(resource.value.image.path, paths) }
    }) }
    if (change && change.beforeSha256 !== change.afterSha256) edits.push({ kind, source: old, target, ...change })
  }
  const profile = transformedProfile(paths.profilePath, paths)
  const workspace = transformedJson(paths.workspacePath, value => { for (const row of Object.values(value.tables?.workspaces ?? {})) if (row.path !== undefined) row.path = mapPath(row.path, paths) })
  if (paths.expectedProfileSha256 && profile.beforeSha256 !== paths.expectedProfileSha256) fail('MIGRATION_PROFILE_HASH_MISMATCH')
  if (paths.expectedWorkspaceSha256 && workspace.beforeSha256 !== paths.expectedWorkspaceSha256) fail('MIGRATION_WORKSPACE_HASH_MISMATCH')
  edits.push({ kind: 'profile', source: paths.profilePath, target: paths.profilePath, ...profile }, { kind: 'workspace', source: paths.workspacePath, target: paths.workspacePath, ...workspace })
  const database = snapshotDatabase(join(paths.sourceRoot, '.dsh', 'task-sessions.sqlite'), paths)
  const pidExited = exited(paths.expectedPid)
  return { version: 1, writes: 0, paths, pidExited, ready: pidExited, entries, moves,
    edits: edits.map(({ bytes, ...entry }) => entry), database }
}
export function migrateMetadataAndFiles(plan) {
  const fresh = checkMigration(plan.paths)
  if (!fresh.pidExited) fail('MIGRATION_RUNTIME_STILL_ALIVE')
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail('MIGRATION_PLAN_CHANGED')
  const receipt = { moved: [], edited: [], database: null, nativeLogsUnchanged: false }
  try {
    for (const move of plan.moves) { mkdirSync(resolve(move.target, '..'), { recursive: true }); renameSync(move.source, move.target); receipt.moved.push(move) }
    for (const edit of plan.edits) {
      if (hash(readFileSync(edit.target)) !== edit.beforeSha256) fail('MIGRATION_EDIT_CAS_FAILED')
      let transformed
      if (edit.kind === 'profile') transformed = transformedProfile(edit.target, plan.paths)
      else transformed = transformedJson(edit.target, value => {
        if (edit.kind === 'route') value.cwd = mapPath(value.cwd, plan.paths)
        else if (edit.kind === 'workspace') { for (const row of Object.values(value.tables?.workspaces ?? {})) if (row.path !== undefined) row.path = mapPath(row.path, plan.paths) }
        else if (edit.kind === 'material') {
          value.path = mapPath(value.path, plan.paths)
          for (const resource of value.resources ?? []) { if (resource.path !== undefined) resource.path = mapPath(resource.path, plan.paths); if (resource.value?.image?.path !== undefined) resource.value.image.path = mapPath(resource.value.image.path, plan.paths) }
        } else fail('MIGRATION_EDIT_KIND_INVALID')
      })
      if (transformed.afterSha256 !== edit.afterSha256) fail('MIGRATION_EDIT_PLAN_CHANGED')
      writeFileSync(edit.target, transformed.bytes)
      if (hash(readFileSync(edit.target)) !== edit.afterSha256) fail('MIGRATION_EDIT_READBACK_FAILED')
      receipt.edited.push({ path: edit.target, beforeSha256: edit.beforeSha256, afterSha256: edit.afterSha256 })
    }
    const databasePath = join(plan.paths.targetRoot, '.dsh', 'task-sessions.sqlite'), db = new DatabaseSync(databasePath)
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const change of plan.database.changes) {
        const row = db.prepare('SELECT body FROM dynamic_executions WHERE id=?').get(change.id)
        if (!row || hash(row.body) !== change.beforeSha256) fail('MIGRATION_DATABASE_CAS_FAILED')
        const value = JSON.parse(row.body); value.definition.protectedPaths = change.protectedPaths
        const body = JSON.stringify(value)
        if (hash(body) !== change.afterSha256) fail('MIGRATION_DATABASE_PLAN_CHANGED')
        db.prepare('UPDATE dynamic_executions SET body=? WHERE id=?').run(body, change.id)
      }
      db.exec('COMMIT')
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('MIGRATION_DATABASE_CORRUPT')
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error } finally { db.close() }
    const after = snapshotDatabase(databasePath, plan.paths)
    for (const [name, digest] of Object.entries(plan.database.hashes)) if (name !== 'dynamic_executions' && after.hashes[name] !== digest) fail('MIGRATION_HISTORY_CHANGED')
    if (Object.keys(after.executionRows).length !== Object.keys(plan.database.executionRows).length) fail('MIGRATION_EXECUTION_SET_CHANGED')
    for (const [id, digest] of Object.entries(plan.database.executionRows)) if (after.executionRows[id] !== (plan.database.changes.find(change => change.id === id)?.afterSha256 ?? digest)) fail('MIGRATION_EXECUTION_READBACK_FAILED')
    const editedTargets = new Set(plan.edits.map(edit => resolve(edit.target)))
    for (const entry of plan.entries.filter(item => item.type === 'file')) {
      const target = join(plan.paths.targetRoot, entry.relative)
      if (/^\.dsh\/task-sessions\.sqlite(?:-wal|-shm)?$/u.test(entry.relative) || editedTargets.has(resolve(target))) continue
      if (hash(readFileSync(target)) !== entry.sha256) fail(entry.relative.endsWith('.jsonl') ? 'MIGRATION_NATIVE_LOG_CHANGED' : 'MIGRATION_FILE_READBACK_FAILED')
    }
    receipt.database = { quickCheck: 'ok', protectedPathRows: plan.database.changes.map(({ id, beforeSha256, afterSha256 }) => ({ id, beforeSha256, afterSha256 })), historicalTablesUnchanged: true }
    receipt.nativeLogsUnchanged = true
    return receipt
  } catch (error) { error.migrationReceipt = receipt; throw error }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--check') fail('MIGRATION_CHECK_ONLY_CLI')
    const plan = checkMigration()
    console.log(JSON.stringify({ writes: 0, ready: plan.ready, pidExited: plan.pidExited, files: plan.entries.filter(item => item.type === 'file').length, moves: plan.moves.length, metadataEdits: plan.edits.length, protectedPathRows: plan.database.changes.length }))
  } catch (error) { console.error(/^MIGRATION_[A-Z_]+$/u.test(error.message) ? error.message : 'MIGRATION_CHECK_FAILED'); process.exitCode = 1 }
}
