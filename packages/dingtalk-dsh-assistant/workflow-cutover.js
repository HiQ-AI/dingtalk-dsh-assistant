import { createHash, randomUUID } from 'node:crypto'
import { readFile, open, rename, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from './execution-store.js'
import { openExecutionArtifacts } from './execution-artifacts.js'

const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const values = value => Object.values(value ?? {})
const verifiedSnapshots = new Map()
const text = value => { if (typeof value !== 'string' || !value.trim()) fail('CUTOVER_INVALID_ARGUMENT'); return value }
const absolute = value => { if (!isAbsolute(text(value))) fail('CUTOVER_ABSOLUTE_PATH_REQUIRED'); return resolve(value) }
export const workflowSealPath = legacyPath => join(dirname(absolute(legacyPath)), 'dingtalk_dsh_assistant.workflow-seal.json')
async function optionalJson(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function durableWrite(path, bytes, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`
  const file = await open(target, 'wx')
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  if (!exclusive) await rename(target, path)
}

/** 不修改旧状态。任何未结消息/事项/决策/投递/人工请求均阻止切换。 */
export function inspectLegacyDrain(document, groupIds) {
  if (document?.unit?.name !== 'dingtalk_dsh_assistant' || document.unit.version !== 9 || !document.tables) fail('CUTOVER_LEGACY_SCHEMA_REQUIRED')
  const issues = [], groups = values(document.tables.groups), selected = new Set(groupIds)
  const issue = (kind, groupId, id) => issues.push({ kind, groupId, id })
  for (const id of selected) if (!groups.some(g => g.groupId === id)) issue('group-missing', id, id)
  for (const group of groups.filter(g => selected.has(g.groupId))) {
    for (const m of group.messages ?? []) {
      if (m.routingStatus !== 'routed') issue('message-routing-unsettled', group.groupId, m.messageId)
      if (!['delivered', 'skipped'].includes(m.agentDeliveryStatus)) issue('message-decision-unsettled', group.groupId, m.messageId)
    }
    for (const o of group.outbox ?? []) {
      if (o.status === 'pending' || o.recallStatus === 'requested') issue('outbox-unsettled', group.groupId, o.outboundId)
      if (o.status === 'sent' && o.readbackRequired && !o.deliveredMessageId) issue('outbox-readback-missing', group.groupId, o.outboundId)
    }
    for (const reservation of group.taskReservations ?? []) issue('task-reservation-unsettled', group.groupId, reservation.reservationId ?? reservation.taskId)
    for (const [id, request] of Object.entries(group.coordinationRequests ?? {})) if (!['completed', 'superseded'].includes(request.status)) issue('coordination-unsettled', group.groupId, id)
    for (const topic of group.topics ?? []) for (const decision of topic.decisions ?? []) if (!['completed', 'rejected'].includes(decision.status)) issue('topic-decision-unsettled', group.groupId, decision.decisionId)
  }
  for (const task of values(document.tables.tasks).filter(t => selected.has(t.groupId))) {
    if (task.state !== 'completed') issue('task-active', task.groupId, task.taskId)
    if (task.humanBlocker && !['answered', 'superseded'].includes(task.humanBlocker.status)) issue('human-request-unsettled', task.groupId, task.humanBlocker.requestId)
    if (task.stopRequest && task.stopRequest.status !== 'settled') issue('stop-unsettled', task.groupId, task.taskId)
    for (const n of task.notificationIntents ?? []) if (!['delivered', 'superseded'].includes(n.status)) issue('task-notification-unsettled', task.groupId, n.intentId)
  }
  for (const scheduler of values(document.tables.scheduler)) for (const task of scheduler.tasks ?? []) if (!task.groupId || selected.has(task.groupId)) issue('embedded-scheduler-task', task.groupId, task.taskId)
  return { ready: issues.length === 0, groupIds: [...selected], issues }
}

/** resident 在旧入口注册及每次入站前检查；sealed 已经阻旧写，不能等 active 才阻。 */
export async function readWorkflowSeal({ sealPath, conversationId }) {
  const journal = await optionalJson(absolute(sealPath))
  if (!journal) return null
  if (journal.version !== 1 || !['sealed', 'active'].includes(journal.phase) || !Array.isArray(journal.groupIds)) fail('CUTOVER_SEAL_INVALID')
  if (conversationId && !journal.groupIds.includes(conversationId)) return null
  const snapshotPath = absolute(journal.snapshotPath)
  const stamp = async () => { const s = await stat(snapshotPath); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
  const identity = await stamp(), key = `${snapshotPath}:${journal.legacySha256}:${JSON.stringify(journal.groupIds)}`
  if (verifiedSnapshots.get(key) !== identity) {
    const snapshot = await readFile(snapshotPath)
    if (digest(snapshot) !== journal.legacySha256 || await stamp() !== identity) fail('CUTOVER_SNAPSHOT_MISMATCH')
    const report = inspectLegacyDrain(JSON.parse(snapshot), journal.groupIds)
    if (!report.ready) fail('CUTOVER_SEAL_NOT_DRAINED', report)
    verifiedSnapshots.set(key, identity)
  }
  return { blockLegacy: true, phase: journal.phase, conversationId, groupIds: journal.groupIds, instanceId: journal.instanceId,
    dbPath: journal.dbPath, sealRef: `sha256:${journal.legacySha256}`, journalId: journal.journalId }
}

/** probeStopped 必须做当前 OS PID/端口/自启任务检查；CLI 固定为本地 PowerShell 只读探测。 */
export async function cutoverWorkflow({ legacyPath, journalPath, dbPath, artifactDirectory, instanceId, groupIds, check, probeStopped }) {
  legacyPath = absolute(legacyPath); journalPath = absolute(journalPath); dbPath = absolute(dbPath); artifactDirectory = absolute(artifactDirectory)
  if (journalPath.toLowerCase() !== workflowSealPath(legacyPath).toLowerCase()) fail('CUTOVER_FIXED_SEAL_PATH_REQUIRED')
  text(instanceId)
  if (!Array.isArray(groupIds) || !groupIds.length || groupIds.some(id => typeof id !== 'string' || !id) || new Set(groupIds).size !== groupIds.length) fail('CUTOVER_GROUPS_REQUIRED')
  if (new Set([legacyPath.toLowerCase(), journalPath.toLowerCase(), dbPath.toLowerCase()]).size !== 3) fail('CUTOVER_PATH_COLLISION')
  const bytes = await readFile(legacyPath), legacySha256 = digest(bytes), report = inspectLegacyDrain(JSON.parse(bytes), groupIds)
  const stopped = await probeStopped()
  if (!stopped || stopped.stopped !== true || stopped.pidPresent !== false || stopped.listenerPresent !== false || stopped.autostartDisabled !== true) fail('CUTOVER_RUNTIME_NOT_STOPPED', stopped)
  if (!report.ready) fail('CUTOVER_LEGACY_NOT_DRAINED', report)
  let journal = await optionalJson(journalPath)
  if (journal && (journal.legacySha256 !== legacySha256 || journal.instanceId !== instanceId || journal.dbPath !== dbPath || JSON.stringify(journal.groupIds) !== JSON.stringify(groupIds))) fail('CUTOVER_JOURNAL_CONFLICT')
  let exists = false
  try { exists = (await stat(dbPath)).isFile() } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (exists) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      if (db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id !== instanceId) fail('CUTOVER_INSTANCE_MISMATCH')
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='message_meta'").get()) fail('CUTOVER_OFFLINE_SCHEMA_UPGRADE_REQUIRED')
    } finally { db.close() }
  }
  if (check) return { status: 'CHECK_PASS', writes: 0, legacySha256, report, stopped, databaseExists: exists, journalPhase: journal?.phase ?? null }
  // 二次读取确认预检期间未发生旧账写入；检查之后仍依赖已禁用自启的停机窗口。
  if (digest(await readFile(legacyPath)) !== legacySha256) fail('CUTOVER_LEGACY_CHANGED')
  const stoppedAgain = await probeStopped()
  if (!stoppedAgain.stopped || stoppedAgain.pidPresent || stoppedAgain.listenerPresent || !stoppedAgain.autostartDisabled) fail('CUTOVER_RUNTIME_RESTARTED')
  await mkdir(dirname(journalPath), { recursive: true })
  if (!journal) {
    const snapshotPath = `${journalPath}.legacy-snapshot.json`
    try { await durableWrite(snapshotPath, bytes, true) } catch (e) { if (e.code !== 'EEXIST' || digest(await readFile(snapshotPath)) !== legacySha256) throw e }
    journal = { version: 1, journalId: randomUUID(), phase: 'sealed', groupIds, legacyPath, legacySha256, snapshotPath,
      dbPath, artifactDirectory, instanceId, stopped: stoppedAgain, sealedAt: new Date().toISOString() }
    await durableWrite(journalPath, JSON.stringify(journal, null, 2), true)
  }
  // journal 是旧入口的拒写依据，必须先于控制库接管落盘。崩溃后复用同一 journalId/命令 ID。
  await mkdir(dirname(dbPath), { recursive: true })
  const store = await openExecutionStore({ dbPath, instanceId, initialize: !exists })
  try {
    await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
    for (const conversationId of groupIds) {
      let group = await store.query({ kind: 'message.group', conversationId })
      if (!group || group.engine !== 'workflow') {
        const expectedEpoch = group?.epoch ?? 0
        const args = { conversationId, expectedEpoch, legacySealRef: `sha256:${legacySha256}` }
        await store.command({ id: `${journal.journalId}:${conversationId}:begin`, kind: 'message.group.begin', args })
        await store.command({ id: `${journal.journalId}:${conversationId}:activate`, kind: 'message.group.activate', args })
        group = await store.query({ kind: 'message.group', conversationId })
      }
      if (group.state !== 'active' || group.engine !== 'workflow' || group.legacySealRef !== `sha256:${legacySha256}`) fail('CUTOVER_GROUP_READBACK_FAILED')
    }
    journal = { ...journal, phase: 'active', activatedAt: journal.activatedAt ?? new Date().toISOString() }
    await durableWrite(journalPath, JSON.stringify(journal, null, 2))
    const verified = await readWorkflowSeal({ sealPath: journalPath, conversationId: groupIds[0] })
    return { status: 'ACTIVATED', seal: verified, groupIds, legacySha256 }
  } finally { await store.close() }
}
