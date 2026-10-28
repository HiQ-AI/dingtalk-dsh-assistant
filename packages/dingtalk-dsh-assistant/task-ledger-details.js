import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const error = code => { throw Object.assign(new Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const treeFallback = new Error('TASK_DETAIL_TREE_FALLBACK')
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const controlDigest = value => hash(JSON.stringify(sorted(value)))
const segment = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  && !/[.]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
const fields = {
  dynamic_tasks: ['title','objective','request','metadata','requirements','supplements','dialogue','humanRequests','lastDecision','completion','context','materials'],
  dynamic_executions: ['title','input','inputHistory','prompt','definition','results','result','feedback','stageProgress','progressReview'],
  dynamic_operations: ['job','result','definition','dispatchBinding','ownerBinding','recoverySettlement'],
  dynamic_wakes: ['payload'], dynamic_task_events: ['result','instructionCoverage'],
  dynamic_notifications: ['payload'],
  dynamic_coordination: ['proposal','history','aggregateSnapshot'],
  dynamic_coordination_sources: ['original','acceptedProposal','question','history'],
  dynamic_coordination_members: ['receipt','createCommand','original','command','completionProof','reorderAssessment'],
  dynamic_coordination_occurrences: ['result','action','trigger'], dynamic_coordination_jobs: ['result'],
  dynamic_coordination_schedules: ['history','action'],
}
export const detailTables = [...Object.keys(fields), 'dynamic_receipts']

// Control and indexed fields stay in SQLite. These are projections, never authority
// for reading/replaying the original detail: decode restores the verified value.
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]))
const textPreview = value => String(value ?? '').slice(0, 400)
const taskVersion = value => pick(value, ['taskId','requirementRevision','contextRevision','controlRevision','runSequence'])
const resultProof = result => result && ({ results: result.results?.map(v => pick(v, ['instructionId','commandId','reconciled'])),
  ...(result.conditionalCommands ? { conditionalCommands: { results: result.conditionalCommands.results?.map(v => pick(v, ['instructionId','commandId','reconciled'])) } } : {}) })
function projection(key, value, table) {
  if (value === null) return null
  if (key === 'taskDecision') return { taskId: value.taskId, id: value.id }
  if (key === 'completionEvent') return Object.fromEntries(Object.entries(value).filter(([k]) => !['result','instructionCoverage'].includes(k)))
  if (key === 'lastDecision') return { action: value.action, summary: textPreview(value.summary), question: textPreview(String(value.question ?? '').trim()) }
  if (['request','title','objective'].includes(key)) return textPreview(value)
  if (key === 'payload' && table === 'dynamic_notifications') return { ...value, ...(value.text !== undefined ? { text: textPreview(value.text) } : {}) }
  if (key === 'humanRequests') return value.map(v => pick(v, ['requestId','status','createdAt','audience']))
  if (key === 'completion') return { ...pick(value, ['commandId','instructionIds','requirementRevision','contextRevision','controlRevision','runSequence']),
    ...(value.result ? { result: { summary: textPreview(value.result.summary) } } : {}) }
  if (key === 'input') return { title: textPreview(value.title) }
  if (key === 'definition') return pick(value, ['executionBackend','model','provider'])
  if (key === 'command') return { ...pick(value, ['id','kind']), args: { text: textPreview(value.args?.text) } }
  if (key === 'completionProof') return pick(value, ['eventId','commandId','requirementRevision','contextRevision','controlRevision','runSequence'])
  if (key === 'reorderAssessment') return { state: value.state, summary: textPreview(value.summary) }
  if (key === 'action') return { ...pick(value, ['kind','instructionIds','taskIds']), text: textPreview(value.text),
    ...(value.onIncomplete ? { onIncomplete: pick(value.onIncomplete, ['instructionIds']) } : {}) }
  if (key === 'history') return value.map(v => pick(v, ['changedAt']))
  if (key === 'result' && table === 'dynamic_receipts') return value?.task ? { task: taskVersion(value.task) } : {}
  if (key === 'result' && table === 'dynamic_coordination_occurrences') return resultProof(value)
  return undefined
}

function checkedDirectory(path, create, boundary) {
  const ancestry = []
  for (let entry = path;; entry = dirname(entry)) {
    ancestry.push(entry)
    if (entry === boundary || dirname(entry) === entry) break
  }
  for (const entry of ancestry.reverse()) {
    let stat
    try { stat = lstatSync(entry) }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      if (!create) error('TASK_DETAIL_MISSING')
      try { mkdirSync(entry) } catch (e) { if (e.code !== 'EEXIST') throw e }
      stat = lstatSync(entry)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) error('TASK_DETAIL_PATH_UNSAFE')
  }
  // Every component is still checked. Resolve the complete path once instead of
  // resolving every overlapping ancestor (quadratic filesystem probes on Windows).
  if (relative(resolve(path), realpathSync(path)) !== '') error('TASK_DETAIL_PATH_UNSAFE')
}

export function createTaskLedgerDetails(root) {
  if (!isAbsolute(root ?? '')) error('TASK_DETAIL_ROOT_INVALID')
  root = resolve(root)
  // Establish ancestry once; each operation still checks the canonical root and
  // every descendant component, without walking the entire drive repeatedly.
  let rootChecked = false
  function directory(owner, create) {
    if (!owner || !['task','coordination','system'].includes(owner.type) || !segment(owner.id)) error('TASK_DETAIL_OWNER_INVALID')
    if (!rootChecked) { checkedDirectory(root, create); rootChecked = true }
    const path = owner.type === 'task' ? join(root, 'tasks', owner.id, '.dsh', 'ledger-details')
      : owner.type === 'coordination' ? join(root, 'coordinations', owner.id, '.dsh', 'ledger-details')
        : join(root, '.dsh', 'ledger-details', owner.id)
    checkedDirectory(path, create, root)
    return path
  }
  const connections = new Map()
  let active, readScope
  function database(owner, create) {
    const key = JSON.stringify([owner?.type, owner?.id]), checked = !create && readScope?.get(key)
    if (checked && connections.get(checked.path) === checked.entry) return checked.entry.db
    const dir = directory(owner, create), path = join(dir, 'objects.sqlite')
    let stat
    try { stat = lstatSync(path) }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      if (!create) error('TASK_DETAIL_MISSING')
      try { closeSync(openSync(path, 'wx', 0o600)) } catch (e) { if (e.code !== 'EEXIST') throw e }
      stat = lstatSync(path)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) error('TASK_DETAIL_PATH_UNSAFE')
    let entry = connections.get(path)
    if (entry && (entry.ino !== stat.ino || entry.dev !== stat.dev)) error('TASK_DETAIL_PATH_UNSAFE')
    if (entry && create && entry.readOnly) { entry.db.close(); connections.delete(path); entry = null }
    if (!entry) {
      const db = new DatabaseSync(path, { readOnly: !create })
      try {
          db.exec('PRAGMA busy_timeout=5000')
          const application = db.prepare('PRAGMA application_id').get().application_id
          if (application !== 0x44534444 && !(create && stat.size === 0 && application === 0)) error('TASK_DETAIL_CONTAINER_INVALID')
          if (create) {
            db.exec('PRAGMA synchronous=FULL')
            db.exec('PRAGMA application_id=1146307652; CREATE TABLE IF NOT EXISTS objects(digest TEXT PRIMARY KEY,body TEXT NOT NULL)')
          }
          entry = { db, readOnly: !create, ino: stat.ino, dev: stat.dev }; connections.set(path, entry)
      } catch (e) { db.close(); throw e }
      // Bound native handles even when a query spans many task owners.
      if (connections.size > 32) { const [key, old] = connections.entries().next().value; old.db.close(); connections.delete(key) }
    }
    if (!create && readScope) readScope.set(key, { path, entry })
    return entry.db
  }
  function readObject(owner, digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) error('TASK_DETAIL_REFERENCE_INVALID')
    const db = active?.db ?? database(owner, false)
    const row = db.prepare('SELECT body FROM objects WHERE digest=?').get(digest)
    if (!row) error('TASK_DETAIL_MISSING')
    if (Buffer.byteLength(row.body) > 64 * 1024 * 1024 || hash(row.body) !== digest) error('TASK_DETAIL_CORRUPT')
    return JSON.parse(row.body)
  }
  function publish(owner, node) {
    const body = JSON.stringify(node), digest = hash(body), db = active.db
    if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw treeFallback
    db.prepare('INSERT OR IGNORE INTO objects(digest,body) VALUES (?,?)').run(digest, body)
    readObject(owner, digest)
    return { ref: digest }
  }
  function storeValue(owner, value, depth = 0) {
    if (depth > 128) error('TASK_DETAIL_DEPTH_INVALID')
    const size = Buffer.byteLength(JSON.stringify(value))
    if (size <= 2048) return { value }
    // A content-addressed tree shares unchanged history entries and snapshot
    // subtrees. It does not copy native session logs or append whole snapshots.
    const node = Array.isArray(value) && value.length > 128
      ? { type: 'array-chunks', parts: Array.from({ length: Math.ceil(value.length / 128) }, (_, i) => storeValue(owner, value.slice(i * 128, (i + 1) * 128), depth + 1)) }
      : Array.isArray(value) ? { type: 'array', items: value.map(v => storeValue(owner, v, depth + 1)) }
      : value && typeof value === 'object' ? { type: 'object', entries: Object.entries(value).map(([k,v]) => [k, storeValue(owner, v, depth + 1)]) }
        : typeof value === 'string' && value.length > 32768 ? { type: 'string', parts: Array.from({ length: Math.ceil(value.length / 32768) }, (_, i) => storeValue(owner, value.slice(i * 32768, (i + 1) * 32768), depth + 1)) }
          : { type: 'value', value }
    // Count encoded references, not business values. If a fragmented tree would
    // exceed the reader's work budget, use bounded JSON text chunks instead.
    if (++active.treeNodes > 8192) throw treeFallback
    return publish(owner, node)
  }
  function storeJson(owner, value) {
    const text = JSON.stringify(value), parts = []
    for (let i = 0; i < text.length; i += 32768) parts.push(publish(owner, { type: 'value', value: text.slice(i, i + 32768) }))
    return publish(owner, { type: 'json', parts })
  }
  function loadValue(owner, pointer, budget, depth = 0) {
    if (depth > 128) error('TASK_DETAIL_DEPTH_INVALID')
    if (Object.hasOwn(pointer, 'value')) return pointer.value
    if (++budget.nodes > 100000) error('TASK_DETAIL_DEPTH_INVALID')
    const node = readObject(owner, pointer.ref)
    if (node.type === 'value') return node.value
    if (node.type === 'array') return node.items.map(p => loadValue(owner, p, budget, depth + 1))
    if (node.type === 'array-chunks') return node.parts.flatMap(p => loadValue(owner, p, budget, depth + 1))
    if (node.type === 'object') return Object.fromEntries(node.entries.map(([k,p]) => [k, loadValue(owner, p, budget, depth + 1)]))
    if (node.type === 'string') return node.parts.map(p => loadValue(owner, p, budget, depth + 1)).join('')
    if (node.type === 'json') return JSON.parse(node.parts.map(p => loadValue(owner, p, budget, depth + 1)).join(''))
    error('TASK_DETAIL_REFERENCE_INVALID')
  }
  function ownerOf(table, value, hint) {
    const result = value.result ?? {}
    const taskId = hint?.taskId ?? value.taskId ?? value.taskDecision?.taskId ?? result.task?.taskId ?? result.execution?.taskId ?? result.operation?.taskId ?? result.binding?.taskId ?? result.notification?.taskId
    if (taskId) return { type: 'task', id: taskId }
    const coordinationId = hint?.coordinationId ?? value.coordinationId ?? value.payload?.fact?.coordinationId ?? result.notification?.payload?.fact?.coordinationId ?? result.coordination?.id ?? (table === 'dynamic_coordination' ? value.id : null)
    return coordinationId ? { type: 'coordination', id: coordinationId } : { type: 'system', id: 'unassigned' }
  }
  return {
    root,
    // A synchronous store query has no await/yield between selected records.
    // Validate each owner/container once in that read; later queries revalidate.
    readSnapshot(read) {
      const previous = readScope; readScope = new Map()
      try { return read() } finally { readScope = previous }
    },
    encode(table, value, hint) {
      if (Object.hasOwn(value, '_hostDetail')) error('TASK_DETAIL_RESERVED_FIELD')
      const keys = table === 'dynamic_receipts' ? ['result','taskDecision','completionEvent'] : fields[table] ?? []
      const detail = Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]))
      if (!Object.keys(detail).length) return value
      const owner = ownerOf(table, value, hint), compact = { ...value }
      const db = database(owner, true)
      db.exec('BEGIN IMMEDIATE'); active = { db, treeNodes: 0 }
      try {
        for (const key of Object.keys(detail)) { delete compact[key]; const p = projection(key, detail[key], table); if (p !== undefined) compact[key] = p }
        // Root always lives on disk, including small receipts; central rows remain
        // bounded by control metadata rather than carrying an inline second copy.
        let pointer
        db.exec('SAVEPOINT detail_tree')
        try { pointer = storeValue(owner, detail); db.exec('RELEASE detail_tree') }
        catch (e) {
          db.exec('ROLLBACK TO detail_tree; RELEASE detail_tree')
          if (e !== treeFallback) throw e
          pointer = storeJson(owner, detail)
        }
        const id = value.id ?? hint?.id ?? null
        const cleanCompact = JSON.parse(JSON.stringify(compact))
        const ref = publish(owner, { type: 'record', table, id, owner, controlDigest: controlDigest(cleanCompact), data: pointer })
        db.exec('COMMIT')
        return { ...cleanCompact, _hostDetail: { version: 1, table, id, owner, ...ref } }
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e } finally { active = undefined }
    },
    decode(value, expected = {}) {
      const ref = value?._hostDetail
      if (!ref) return value // Legacy inline bodies remain readable.
      if (ref.version !== 1 || !detailTables.includes(ref.table) || expected.table && ref.table !== expected.table
        || (expected.id ?? value.id) !== undefined && ref.id !== (expected.id ?? value.id)) error('TASK_DETAIL_REFERENCE_INVALID')
      const db = database(ref.owner, false)
      active = { db }
      try {
        const record = readObject(ref.owner, ref.ref)
        const { _hostDetail, ...compact } = value
        if (record.type !== 'record' || record.table !== ref.table || record.id !== ref.id
          || record.owner.type !== ref.owner.type || record.owner.id !== ref.owner.id
          || record.controlDigest !== controlDigest(compact)) error('TASK_DETAIL_REFERENCE_INVALID')
        const detail = loadValue(ref.owner, record.data, { nodes: 0 })
        return { ...compact, ...detail }
      } finally { active = undefined }
    },
    close() { for (const entry of connections.values()) entry.db.close(); connections.clear() },
  }
}
