import { readFile, open, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkResidentStorage } from '../../../../scripts/check-resident-storage.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const assert = (value, reason) => { if (!value) throw new Error(reason) }
export function prepareReconciliation(document, manifest) {
  assert(manifest.approvalRef && manifest.groupId && manifest.coordination.length === 5 && manifest.outbounds.length === 1, 'EXACT_APPROVED_SCOPE_REQUIRED')
  const next = structuredClone(document), group = next.tables.groups[manifest.groupId]
  assert(group, 'GROUP_NOT_FOUND')
  assert(Object.values(next.tables.tasks).filter(task => task.groupId === manifest.groupId).every(task => task.state === 'completed'), 'ACTIVE_TASKS_PRESENT')
  for (const change of manifest.coordination) {
    const current = group.coordinationRequests[change.id]
    assert(current?.status === 'pending' && current.updatedAt === change.expectedUpdatedAt, 'COORDINATION_CHANGED')
    assert(change.evidenceMessageIds?.length || change.topicId, 'COORDINATION_EVIDENCE_REQUIRED')
    for (const id of change.evidenceMessageIds ?? []) {
      const source = group.messages.find(item => item.messageId === id)
      assert(source?.routingStatus === 'routed' && ['delivered', 'skipped'].includes(source.agentDeliveryStatus), 'SOURCE_NOT_SETTLED')
    }
    if (change.topicId) {
      const topic = group.topics.find(item => item.topicId === change.topicId)
      assert(topic && topic.processedRevision === topic.revision && topic.revision > change.oldRevision, 'TOPIC_NOT_SUPERSEDED')
    }
    Object.assign(current, { status: 'superseded', supersedeReason: `operator-approved-cutover:${manifest.approvalRef};${change.reason}`, updatedAt: manifest.decidedAt })
  }
  for (const change of manifest.outbounds) {
    const item = group.outbox.find(item => item.outboundId === change.id)
    const successor = group.outbox.find(item => item.outboundId === change.completionOutboundId)
    assert(item?.status === 'pending' && hash(item.text) === change.textSha256 && item.sendStartedAt === change.expectedSendStartedAt, 'OUTBOUND_CHANGED')
    assert(successor?.status === 'sent' && successor.deliveredMessageId && item.taskIds?.some(id => successor.taskIds?.includes(id)), 'COMPLETION_EVIDENCE_REQUIRED')
    Object.assign(item, { status: 'superseded', supersededAt: manifest.decidedAt, supersededReason: `operator-approved-no-resend:${manifest.approvalRef};${change.reason}` })
  }
  assert(checkResidentStorage(next).ok, 'RESULT_SCHEMA_INVALID')
  return next
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: 'string' }, manifest: { type: 'string' }, backup: { type: 'string' }, 'runtime-pid': { type: 'string' }, 'runtime-port': { type: 'string' }, 'scheduled-task': { type: 'string' }, check: { type: 'boolean' }, execute: { type: 'boolean' } } })
  assert(values.check !== values.execute && values.source && values.manifest, 'CHECK_OR_EXECUTE_REQUIRED')
  const source = resolve(values.source), bytes = await readFile(source), manifest = JSON.parse(await readFile(resolve(values.manifest), 'utf8'))
  assert(hash(bytes) === manifest.expectedSha256, 'SOURCE_HASH_CHANGED')
  const next = prepareReconciliation(JSON.parse(bytes), manifest)
  const resultBytes = Buffer.from(JSON.stringify(next))
  const summary = { sourceSha256: hash(bytes), resultSha256: hash(resultBytes), coordination: manifest.coordination.length, outbounds: manifest.outbounds.length }
  if (values.check) { console.log(JSON.stringify({ ...summary, status: 'CHECK_PASS', writes: 0 })); return }
  assert(values.backup && values['runtime-pid'] && values['runtime-port'] && values['scheduled-task'], 'STOPPED_RUNTIME_AND_BACKUP_REQUIRED')
  const probe = fileURLToPath(new URL('../../../../scripts/check-workflow-quiescence.ps1', import.meta.url))
  const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', probe, '-RuntimePid', values['runtime-pid'], '-RuntimePort', values['runtime-port'], '-ScheduledTaskName', values['scheduled-task']], { windowsHide: true, timeout: 15000 })
  assert(JSON.parse(stdout).stopped === true, 'RUNTIME_NOT_STOPPED')
  const backup = await open(resolve(values.backup), 'wx')
  try { await backup.writeFile(bytes); await backup.sync() } finally { await backup.close() }
  assert(hash(await readFile(resolve(values.backup))) === hash(bytes), 'BACKUP_READBACK_FAILED')
  const temporary = `${source}.${randomUUID()}.reconcile.tmp`, file = await open(temporary, 'wx')
  try { await file.writeFile(resultBytes); await file.sync() } finally { await file.close() }
  assert(hash(await readFile(source)) === hash(bytes), 'SOURCE_CHANGED_BEFORE_COMMIT')
  await rename(temporary, source)
  assert(hash(await readFile(source)) === hash(resultBytes), 'RESULT_READBACK_FAILED')
  console.log(JSON.stringify({ ...summary, status: 'RECONCILED' }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
