import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const [mode, dbPath, artifactDirectory, instanceId, runId, commandId] = process.argv.slice(2)
if (!['--check', '--execute'].includes(mode) || !isAbsolute(dbPath ?? '') || !isAbsolute(artifactDirectory ?? '')
  || !instanceId || !runId || !commandId) throw new Error('USAGE: --check|--execute <absolute-db> <absolute-artifacts> <instance-id> <run-id> <command-id>')

function inspect() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const meta = db.prepare('SELECT instance_id FROM execution_meta').get()
    if (meta?.instance_id !== instanceId) throw new Error('INSTANCE_MISMATCH')
    const record = db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
    if (!record) throw new Error('RUN_NOT_FOUND')
    const run = JSON.parse(record.body)
    const items = db.prepare('SELECT kind,body FROM message_items WHERE run_id=?').all(runId).map(row => ({ ...JSON.parse(row.body), tableKind: row.kind }))
    const command = items.find(item => item.tableKind === 'command' && item.commandId === commandId)
    if (!command || command.status !== 'unknown' || command.error !== 'WORKFLOW_CLARIFICATION_NOT_FOUND') throw new Error('COMMAND_NOT_ELIGIBLE')
    if (items.filter(item => item.tableKind === 'command').length !== 1 || items.some(item => item.tableKind === 'notification' && item.status === 'delivered')) throw new Error('EFFECT_MAY_EXIST')
    const target = items.find(item => item.tableKind === 'request' && item.id === command.args?.arguments?.requestId)
    if (target?.kind === 'needs_clarification' && target.status === 'pending') throw new Error('CLARIFICATION_MAY_HAVE_APPLIED')
    const unit = items.find(item => item.tableKind === 'unit' && item.id === command.unitId)
    if (!unit || unit.status !== 'accepted' || run.revision !== command.revision) throw new Error('UNIT_STATE_CHANGED')
    return { run, command, unit, target }
  } finally { db.close() }
}

const checked = inspect()
console.log(JSON.stringify({ mode, runId, commandId, status: checked.command.status, error: checked.command.error,
  targetKind: checked.target?.kind ?? null, targetStatus: checked.target?.status ?? null, revision: checked.run.revision }))
if (mode === '--execute') {
  const artifacts = await openExecutionArtifacts({ directory: artifactDirectory })
  const evidence = await artifacts.put({ kind: 'invalid-clarification-recovery', runId, commandId,
    error: checked.command.error, targetKind: checked.target?.kind ?? null, targetStatus: checked.target?.status ?? null,
    reason: '目标请求不是待答 needs_clarification，handler 在外部效果前拒绝；无本命令投递通知。' })
  const store = await openExecutionStore({ dbPath, instanceId })
  try {
    await store.command({ id: `reconcile-invalid-clarification:${commandId}`, kind: 'message.command.reconcile',
      args: { commandId, status: 'failed', evidenceRef: evidence.ref, result: { status: 'failed', reason: checked.command.error } } })
    await store.command({ id: `relink-invalid-clarification:${commandId}`, kind: 'message.relink',
      args: { runId, unitId: checked.unit.id, expectedRevision: checked.run.revision, reason: '最近消息话题候选被截断，重做关联' } })
  } finally { await store.close() }
  const readback = inspectAfter()
  console.log(JSON.stringify({ mode: 'readback', runId, commandStatus: readback.command.status, unitStatus: readback.unit.status,
    routingStatus: readback.run.routingStatus, evidenceRef: evidence.ref }))
}

function inspectAfter() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const run = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId).body)
    const rows = db.prepare('SELECT kind,body FROM message_items WHERE run_id=?').all(runId).map(row => ({ ...JSON.parse(row.body), tableKind: row.kind }))
    return { run, command: rows.find(item => item.tableKind === 'command' && item.commandId === commandId),
      unit: rows.find(item => item.tableKind === 'unit' && item.id === checked.unit.id) }
  } finally { db.close() }
}
