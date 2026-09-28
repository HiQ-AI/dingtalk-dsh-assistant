import { createHash, randomUUID } from 'node:crypto'
import { readFile, open, rename, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from './execution-store.js'
import { openExecutionArtifacts } from './execution-artifacts.js'
import { maintenanceStatus } from './execution-maintenance.js'

const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const values = value => Object.values(value ?? {})
const verifiedSnapshots = new Map()
const text = value => { if (typeof value !== 'string' || !value.trim()) fail('CUTOVER_INVALID_ARGUMENT'); return value }
const absolute = value => { if (!isAbsolute(text(value))) fail('CUTOVER_ABSOLUTE_PATH_REQUIRED'); return resolve(value) }
export const workflowSealPath = legacyPath => join(dirname(absolute(legacyPath)), 'dingtalk_dsh_assistant.workflow-seal.json')
async function optionalJson(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function verifySnapshot(snapshotPath, expectedDigest, scope, validate) {
  const stamp = async () => { const s = await stat(snapshotPath); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
  const identity = await stamp(), key = JSON.stringify([snapshotPath, expectedDigest, scope])
  const cached = verifiedSnapshots.get(key)
  if (cached?.identity === identity) return cached.verified
  const entry = { identity, verified: undefined }
  entry.verified = (async () => {
    const bytes = await readFile(snapshotPath)
    if (digest(bytes) !== expectedDigest || await stamp() !== identity) fail('CUTOVER_SNAPSHOT_MISMATCH')
    validate(JSON.parse(bytes))
  })()
  verifiedSnapshots.set(key, entry)
  try { await entry.verified } catch (error) {
    if (verifiedSnapshots.get(key) === entry) verifiedSnapshots.delete(key)
    throw error
  }
}
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
  const enrollments = journal.enrollments ?? []
  if (!Array.isArray(enrollments) || enrollments.some(e => !e || !['sealed', 'active'].includes(e.phase) || typeof e.conversationId !== 'string')) fail('CUTOVER_SEAL_INVALID')
  const allGroups = [...journal.groupIds, ...enrollments.map(e => e.conversationId)]
  if (new Set(allGroups).size !== allGroups.length) fail('CUTOVER_SEAL_INVALID')
  if (conversationId && !allGroups.includes(conversationId)) return null
  const snapshotPath = absolute(journal.snapshotPath)
  await verifySnapshot(snapshotPath, journal.legacySha256, journal.groupIds, document => {
    const report = inspectLegacyDrain(document, journal.groupIds)
    if (!report.ready) fail('CUTOVER_SEAL_NOT_DRAINED', report)
  })
  if (enrollments.length) {
    const sealRefs = Object.fromEntries(journal.groupIds.map(id => [id, `sha256:${journal.legacySha256}`]))
    for (const enrollment of enrollments) {
      await verifySnapshot(absolute(enrollment.snapshotPath), enrollment.legacySha256, enrollment.conversationId,
        document => inspectEmptyLegacyGroup(document, enrollment.conversationId))
      sealRefs[enrollment.conversationId] = `sha256:${enrollment.legacySha256}`
    }
    return { blockLegacy: true, phase: journal.phase === 'active' && enrollments.every(e => e.phase === 'active') ? 'active' : 'sealed',
      conversationId, groupIds: allGroups, instanceId: journal.instanceId, dbPath: journal.dbPath,
      sealRef: conversationId ? sealRefs[conversationId] : `sha256:${journal.legacySha256}`, sealRefs, journalId: journal.journalId }
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

/** 新群接入不承担历史迁移；即使消息已结束，也必须拒绝。 */
export function inspectEmptyLegacyGroup(document, conversationId) {
  const report = inspectLegacyDrain(document, [conversationId])
  const group = values(document.tables.groups).find(g => g.groupId === conversationId)
  const collections = ['messages', 'outbox', 'topics', 'taskReservations', 'coordinationRequests', 'routeHistory']
  if (!report.ready || !group || collections.some(key => values(group[key]).length)
    || (group.nextSequence ?? 1) !== 1 || (group.routingRevision ?? 0) !== 0
    || values(document.tables.tasks).some(t => t.groupId === conversationId)) fail('CUTOVER_NEW_GROUP_NOT_EMPTY', report)
  return report
}

/** 现有 seal 的受控扩展。planProfile 是 CLI 注入的纯 YAML 变换，不读取或执行配置代码。 */
export async function enrollEmptyWorkflowGroup({ legacyPath, journalPath, dbPath, artifactDirectory, instanceId,
  groupIds, profilePath, expectedProfileSha256, planProfile, check, probeStopped }) {
  legacyPath = absolute(legacyPath); journalPath = absolute(journalPath); dbPath = absolute(dbPath)
  artifactDirectory = absolute(artifactDirectory); profilePath = absolute(profilePath)
  if (journalPath !== workflowSealPath(legacyPath) || groupIds?.length !== 1 || !groupIds[0]
    || !/^[a-f0-9]{64}$/.test(expectedProfileSha256 ?? '') || typeof planProfile !== 'function') fail('CUTOVER_INVALID_ARGUMENT')
  const conversationId = groupIds[0]
  const stopped = await probeStopped()
  const assertStopped = value => { if (!value?.stopped || value.pidPresent !== false || value.listenerPresent !== false || value.autostartDisabled !== true) fail('CUTOVER_RUNTIME_NOT_STOPPED', value) }
  assertStopped(stopped)
  const journalBytes = await readFile(journalPath), journal = JSON.parse(journalBytes)
  const seal = await readWorkflowSeal({ sealPath: journalPath })
  if (!seal || journal.phase !== 'active' || journal.instanceId !== instanceId || journal.dbPath !== dbPath
    || journal.legacyPath !== legacyPath || journal.artifactDirectory !== artifactDirectory) fail('CUTOVER_JOURNAL_CONFLICT')
  let enrollment = journal.enrollments?.find(e => e.conversationId === conversationId)
  if (journal.groupIds.includes(conversationId) || journal.enrollments?.some(e => e.phase !== 'active' && e !== enrollment)) fail('CUTOVER_ENROLLMENT_CONFLICT')
  const bytes = await readFile(legacyPath), legacySha256 = digest(bytes)
  inspectEmptyLegacyGroup(JSON.parse(bytes), conversationId)
  const source = await readFile(profilePath, 'utf8'), profileHash = digest(source)
  let updated
  if (enrollment) {
    if (enrollment.profilePath !== profilePath || enrollment.profileBeforeSha256 !== expectedProfileSha256
      || enrollment.legacySha256 !== legacySha256) fail('CUTOVER_ENROLLMENT_CONFLICT')
    if (profileHash === enrollment.profileAfterSha256) updated = source
    else if (profileHash === enrollment.profileBeforeSha256) updated = planProfile(source, seal.groupIds.filter(id => id !== conversationId), conversationId)
    else fail('CUTOVER_PROFILE_CHANGED')
    if (digest(updated) !== enrollment.profileAfterSha256) fail('CUTOVER_PROFILE_CHANGED')
  } else {
    if (profileHash !== expectedProfileSha256) fail('CUTOVER_PROFILE_CHANGED')
    updated = planProfile(source, seal.groupIds, conversationId)
  }
  // 停机后必须已 checkpoint；immutable 避免只读预检创建 WAL/SHM。
  try { if ((await stat(`${dbPath}-wal`)).size > 0) fail('CUTOVER_DATABASE_NOT_CHECKPOINTED') } catch (e) { if (e.code !== 'ENOENT') throw e }
  const dbUrl = pathToFileURL(dbPath); dbUrl.searchParams.set('immutable', '1')
  const db = new DatabaseSync(dbUrl.href, { readOnly: true })
  let maintenance
  try {
    if (db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id !== instanceId) fail('CUTOVER_INSTANCE_MISMATCH')
    maintenance = maintenanceStatus(db)
    if (!maintenance.active || maintenance.phase !== 'stopping' || !maintenance.drained) fail('CUTOVER_MAINTENANCE_REQUIRED')
    if (db.prepare("SELECT count(*) n FROM message_runs WHERE json_extract(body,'$.conversationId')=?").get(conversationId).n) fail('CUTOVER_NATIVE_GROUP_NOT_EMPTY')
    const native = db.prepare('SELECT body FROM message_groups WHERE conversation_id=?').get(conversationId)
    if (!enrollment && native) fail('CUTOVER_NATIVE_GROUP_EXISTS')
  } finally { db.close() }
  if (check) return { status: 'CHECK_PASS', writes: 0, conversationId, legacySha256, profileBeforeSha256: expectedProfileSha256,
    profileAfterSha256: digest(updated), maintenanceId: maintenance.maintenanceId, enrollmentPhase: enrollment?.phase ?? null }
  const store = await openExecutionStore({ dbPath, instanceId })
  try {
    const status = await store.query({ kind: 'runtime.maintenance' })
    if (!status.active || status.phase !== 'stopping' || !status.drained || status.maintenanceId !== maintenance.maintenanceId) fail('CUTOVER_MAINTENANCE_REQUIRED')
    assertStopped(await probeStopped())
    if (digest(await readFile(legacyPath)) !== legacySha256 || digest(await readFile(journalPath)) !== digest(journalBytes)
      || digest(await readFile(profilePath)) !== profileHash) fail('CUTOVER_INPUT_CHANGED')
    let group = await store.query({ kind: 'message.group', conversationId })
    if (!enrollment && group) fail('CUTOVER_NATIVE_GROUP_EXISTS')
    if (!enrollment) {
      const enrollmentId = randomUUID(), snapshotPath = `${journalPath}.enrollment-${enrollmentId}.json`
      await durableWrite(snapshotPath, bytes, true)
      enrollment = { enrollmentId, conversationId, phase: 'sealed', snapshotPath, legacySha256, profilePath,
        profileBeforeSha256: expectedProfileSha256, profileAfterSha256: digest(updated), maintenanceId: maintenance.maintenanceId,
        sealedAt: new Date().toISOString() }
      journal.enrollments = [...(journal.enrollments ?? []), enrollment]
      await durableWrite(journalPath, JSON.stringify(journal, null, 2))
    }
    const legacySealRef = `sha256:${legacySha256}`
    if (group?.engine !== 'workflow') {
      const args = { conversationId, expectedEpoch: 0, legacySealRef }
      await store.command({ id: `${enrollment.enrollmentId}:begin`, kind: 'message.group.begin', args })
      await store.command({ id: `${enrollment.enrollmentId}:activate`, kind: 'message.group.activate', args })
      group = await store.query({ kind: 'message.group', conversationId })
    }
    if (group.state !== 'active' || group.engine !== 'workflow' || group.epoch !== 1 || group.legacySealRef !== legacySealRef) fail('CUTOVER_GROUP_READBACK_FAILED')
    if (digest(await readFile(profilePath)) !== profileHash) fail('CUTOVER_PROFILE_CHANGED')
    if (source !== updated) await durableWrite(profilePath, updated)
    if (digest(await readFile(profilePath)) !== enrollment.profileAfterSha256) fail('CUTOVER_PROFILE_CHANGED')
    enrollment.phase = 'active'; enrollment.activatedAt ??= new Date().toISOString()
    await durableWrite(journalPath, JSON.stringify(journal, null, 2))
    return { status: 'ACTIVATED', conversationId, seal: await readWorkflowSeal({ sealPath: journalPath }), profileSha256: enrollment.profileAfterSha256 }
  } finally { await store.close() }
}
