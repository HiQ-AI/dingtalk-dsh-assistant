import { DatabaseSync } from 'node:sqlite'
import { createHash,randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArtifactReference } from './execution-artifacts.js'
import { checkedTaskDirectory, taskFilePath } from './session-workspaces.js'

const error = code => Object.assign(new Error(code), { code })
const artifactReference = /^(?:tasks\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/)?sha256-[a-f0-9]{64}\.json$/

/** A read-only artifact reader; never opens the old writer, creates directories or repairs data. */
async function readHistoricalArtifact(ref, { artifactDirectory, taskWorkspaceRoot }) {
  const { logicalTaskId, fileName, digest } = parseArtifactReference(ref)
  if (logicalTaskId ? !taskWorkspaceRoot : !artifactDirectory) throw error('LEGACY_ARTIFACT_ROOT_UNAVAILABLE')
  const path = logicalTaskId ? join(taskFilePath(resolve(taskWorkspaceRoot), logicalTaskId, 'work', 'artifacts'), fileName)
    : join(resolve(artifactDirectory), fileName)
  await checkedTaskDirectory(dirname(path))
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw error('LEGACY_ARTIFACT_PATH_INVALID')
  if (entry.size > 16 * 1024 * 1024) throw error('LEGACY_ARTIFACT_TOO_LARGE')
  const bytes = await readFile(path)
  await checkedTaskDirectory(dirname(path))
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw error('ARTIFACT_DIGEST_MISMATCH')
  return JSON.parse(bytes.toString('utf8'))
}

/** Page only immutable run/node metadata. Artifact bodies remain on-demand. */
export function historicalExecutionPage(db,tables,taskId,{offset=0,limit=20}={}){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw error('TASK_EXECUTION_CURSOR_INVALID')
  if(!tables.has('execution_runs'))return {items:[],total:0,offset,limit,nextOffset:null}
  const total=db.prepare('SELECT count(*) n FROM execution_runs WHERE task_id=?').get(taskId).n
  const runs=db.prepare('SELECT run_id,status,created_at,updated_at FROM execution_runs WHERE task_id=? ORDER BY rowid LIMIT ? OFFSET ?').all(taskId,limit,offset)
  const nodes=tables.has('execution_nodes')?db.prepare('SELECT node_run_id,session_id,status,drained,output_ref FROM execution_nodes WHERE run_id=? ORDER BY rowid'):null
  return {items:runs.map(run=>({execution:{executionId:run.run_id,legacyRunId:run.run_id,status:run.status,createdAt:run.created_at,updatedAt:run.updated_at,legacyReadonly:true,sessions:nodes?nodes.all(run.run_id).map(node=>({nodeRunId:node.node_run_id,runId:run.run_id,sessionId:node.session_id,status:node.status,drained:node.drained===1,outputRef:node.output_ref})):[]}})),total,offset,limit,nextOffset:offset+runs.length<total?offset+runs.length:null}
}

/** Read-only compatibility boundary. It never opens the old worker or installs/reconciles its schema. */
export function openTaskSessionHistory(dbPath, options = {}) {
  if (!dbPath) return { list: () => [], get: () => null, read: async () => null, executionPage:async()=>null,close() {} }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let tables
  try { tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)) }
  catch (error) { db.close(); throw error }
  const list = () => {
    const ids = new Set()
    for (const table of ['business_tasks','task_owners','execution_runs']) if (tables.has(table))
      for (const row of db.prepare(`SELECT DISTINCT task_id FROM ${table}`).all()) ids.add(row.task_id)
    return [...ids].map(get)
  }
  const get = taskId => {
    const task = tables.has('business_tasks') ? db.prepare('SELECT * FROM business_tasks WHERE task_id=?').get(taskId) : null
    const owner = tables.has('task_owners') ? db.prepare('SELECT * FROM task_owners WHERE task_id=?').get(taskId) : null
    const runs = tables.has('execution_runs') ? db.prepare('SELECT * FROM execution_runs WHERE task_id=? ORDER BY rowid').all(taskId) : []
    if (!task && !owner && !runs.length) return null
    const originRow = tables.has('message_items') && tables.has('message_runs') ? db.prepare("SELECT r.body AS source,i.body AS command FROM message_items i JOIN message_runs r ON r.run_id=i.run_id WHERE i.kind='command' AND json_extract(i.body,'$.args.taskId')=? ORDER BY i.rowid LIMIT 1").get(taskId) : null
    const origin = originRow ? JSON.parse(originRow.source) : null
    const originalCommand = originRow ? JSON.parse(originRow.command) : null
    const args = originalCommand?.args?.arguments ?? {}
    const reports = tables.has('task_reports') ? db.prepare('SELECT * FROM task_reports WHERE task_id=? ORDER BY rowid').all(taskId)
      .map(row => ({ reportId: row.report_id, type: row.report_type, facts: JSON.parse(row.facts_json), recordedAt: row.created_at })) : []
    const report = reports.at(-1), facts = report?.facts
    const events = tables.has('task_events') ? db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY rowid').all(taskId)
      .map(row => ({ type: row.event_type, evidenceRef: row.payload_ref, recordedAt: row.created_at })) : []
    const control = tables.has('task_controls') ? db.prepare('SELECT state,control_revision FROM task_controls WHERE task_id=?').get(taskId) : null
    return { taskId, title: args.title ?? args.objective ?? `历史任务 ${taskId}`, objective: args.objective ?? origin?.request?.objective ?? '', groupId: origin?.conversationId ?? origin?.source?.conversationId ?? null,
      result: facts ? { status: report.type, summary: facts.summary ?? facts.decision?.summary ?? '', evidence: facts.evidenceRefs ?? [], limitations: facts.limitations ?? [], recordedAt: report.recordedAt } : null, requirementRef: task?.requirement_ref, state: task?.status === 'succeeded' ? 'completed' : control?.state ?? task?.status ?? 'history',
      reports, events,
      requirementRevision: task?.requirement_revision, controlRevision: control?.control_revision, controlState: control?.state,
      legacyReadonly: true, historyOnly: true, createdAt: task?.created_at ?? runs[0]?.created_at,
      updatedAt: task?.updated_at ?? runs.at(-1)?.updated_at,
      session: owner ? { sessionId: owner.session_id, sessionBound: owner.session_bound === 1, status: 'historical', legacyReadonly: true } : null,
      executions: runs.map(run => ({ executionId: run.run_id, legacyRunId: run.run_id, status: run.status, createdAt: run.created_at,
        updatedAt: run.updated_at, legacyReadonly: true, historyOnly: true, requirementRef: run.requirement_ref,
        sessions: tables.has('execution_nodes') ? db.prepare('SELECT * FROM execution_nodes WHERE run_id=? ORDER BY rowid').all(run.run_id)
          .map(node => ({ nodeRunId: node.node_run_id, sessionId: node.session_id, status: node.status, drained: node.drained === 1,
            outputRef: node.output_ref, evidenceRefs: JSON.parse(node.evidence_refs ?? '[]') })) : [] })) }
  }
  async function read(taskId) {
    const task = get(taskId)
    if (!task) return null
    const refs = new Set()
    const add = ref => { if (typeof ref === 'string' && ref) refs.add(ref) }
    const embedded = value => {
      if (typeof value === 'string' && artifactReference.test(value)) add(value)
      else if (Array.isArray(value)) value.forEach(embedded)
      else if (value && typeof value === 'object') Object.values(value).forEach(embedded)
    }
    add(task.requirementRef)
    for (const report of task.reports) embedded(report.facts)
    for (const event of task.events) add(event.evidenceRef)
    for (const execution of task.executions) {
      add(execution.requirementRef)
      for (const session of execution.sessions) { add(session.outputRef); session.evidenceRefs.forEach(add) }
    }
    const artifacts = []
    for (const ref of refs) {
      try { artifacts.push({ ref, status: 'read', value: await readHistoricalArtifact(ref, options) }) }
      catch (cause) { artifacts.push({ ref, status: 'unavailable', reason: cause.code ?? 'LEGACY_ARTIFACT_READ_FAILED' }) }
    }
    const byRef = new Map(artifacts.map(value => [value.ref, value]))
    return { ...task, historicalArtifacts: artifacts,
      requirement: byRef.get(task.requirementRef),
      ...(task.result ? { result: { ...task.result, evidenceDetails: task.result.evidence.map(ref => byRef.get(ref)).filter(Boolean) } } : {}),
      executions: task.executions.map(execution => ({ ...execution,
        sessions: execution.sessions.map(session => ({ ...session, output: byRef.get(session.outputRef), evidence: session.evidenceRefs.map(ref => byRef.get(ref)).filter(Boolean) })),
        result: execution.sessions.toReversed().map(session => byRef.get(session.outputRef)).find(artifact => artifact?.status === 'read')?.value ?? null,
      })) }
  }
  const incarnation=randomUUID()
  const executionPage=(taskId,{revision,...page}={})=>{
    const known=['business_tasks','task_owners','execution_runs'].filter(table=>tables.has(table)).map(table=>`SELECT task_id FROM ${table} WHERE task_id=?`).join(' UNION ')
    if(!known||!db.prepare(known+' LIMIT 1').get(...['business_tasks','task_owners','execution_runs'].filter(table=>tables.has(table)).map(()=>taskId)))return null
    const current=`${incarnation}:${db.prepare('PRAGMA data_version').get().data_version}`
    if(revision&&revision!==current)throw error('OBSERVER_PAGE_STALE')
    const result=historicalExecutionPage(db,tables,taskId,page)
    if(current!==`${incarnation}:${db.prepare('PRAGMA data_version').get().data_version}`)throw error('OBSERVER_PAGE_STALE')
    return {...result,revision:current}
  }
  return { list, get, read, executionPage, close: () => db.close() }
}
