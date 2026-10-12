import { randomUUID } from 'node:crypto'
import { executionError } from './execution-artifacts.js'
import { maintenanceStatus } from './execution-maintenance.js'
const fail=code=>{throw executionError(code)}
// Irreversible maintenance scope approved for this four-task migration only.
export const approvedPurgeTaskIds=Object.freeze(['task-83c651ebdbdb77584a06d1fcb6b9e255','task-1edb9931ffe6ecd4efc0a3949376d66f','task-5c4b495243ce147b3d6e32279fe9715f','task-f559fc2e93230cf2cdcd61c8ad51dc35'])
const json=value=>value?JSON.parse(value):{}
export function inspectExecutionPurge(db,args,incarnation){
 const maintenance=maintenanceStatus(db,incarnation)
 if(!maintenance.active||!maintenance.drained)fail('TASK_PURGE_NOT_DRAINED')
 if(!Array.isArray(args.tasks)||args.tasks.length!==approvedPurgeTaskIds.length||new Set(args.tasks.map(t=>t.taskId)).size!==args.tasks.length||args.tasks.some(t=>!approvedPurgeTaskIds.includes(t.taskId)))fail('TASK_PURGE_SCOPE_INVALID')
 const tasks=args.tasks.map(input=>{
  const task=db.prepare('SELECT b.*,c.state,c.control_revision FROM business_tasks b JOIN task_controls c USING(task_id) WHERE task_id=?').get(input.taskId)
  if(!task)fail('TASK_PURGE_NOT_FOUND')
  if(task.control_revision!==input.expectedControlRevision)fail('TASK_PURGE_CONTROL_STALE')
  if(db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND application_status='pending'").get(input.taskId))fail('TASK_PURGE_NOT_DRAINED')
  const runs=db.prepare('SELECT * FROM execution_runs WHERE task_id=?').all(input.taskId)
  for(const run of runs){
   if(db.prepare("SELECT 1 FROM execution_nodes WHERE run_id=? AND (status='running' OR drained=0)").get(run.run_id)
    ||db.prepare("SELECT 1 FROM execution_effects WHERE run_id=? AND state NOT IN ('prepared','succeeded','failed')").get(run.run_id))fail('TASK_PURGE_NOT_DRAINED')
  }
  const requirementRef=task.requirement_ref??db.prepare('SELECT requirement_ref FROM task_plan_stages WHERE task_id=? ORDER BY plan_revision DESC,position LIMIT 1').get(input.taskId)?.requirement_ref
  if(!requirementRef)fail('TASK_PURGE_REQUIREMENT_MISSING')
  return {taskId:input.taskId,requirementRef,controlRevision:task.control_revision,runIds:runs.map(r=>r.run_id)}
 })
 return {tasks,runCount:tasks.reduce((n,t)=>n+t.runIds.length,0),preservesRequirements:true,preservesCode:true,preservesOriginalMessages:true,archivesExecutionHistory:false}
}
export function reduceExecutionPurge(db,args,{now,processIncarnation}){
 const checked=inspectExecutionPurge(db,args,processIncarnation)
 const taskIds=new Set(checked.tasks.map(t=>t.taskId)),runIds=new Set(checked.tasks.flatMap(t=>t.runIds))
 const nodeIds=new Set(db.prepare('SELECT node_run_id,run_id FROM execution_nodes').all().filter(n=>runIds.has(n.run_id)).map(n=>n.node_run_id))
 db.exec(`CREATE TABLE IF NOT EXISTS task_delivery_ledger(task_id TEXT NOT NULL,repository TEXT NOT NULL,branch TEXT NOT NULL,action TEXT NOT NULL,external_id TEXT NOT NULL,base TEXT,operation_key TEXT,task_base TEXT,PRIMARY KEY(task_id,repository,branch,action,external_id)) STRICT`)
 db.exec(`CREATE TABLE IF NOT EXISTS task_purge_cleanup(task_id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body))) STRICT`)
 const effects=db.prepare('SELECT * FROM execution_effects').all().filter(e=>runIds.has(e.run_id)),effectIds=new Set(effects.map(e=>e.effect_id))
 for(const effect of effects){
  const definition=json(effect.definition_json),receipt=json(effect.result_json),result=receipt.result??receipt
  if(effect.state!=='succeeded'||!['commit','push','pr'].includes(definition.action))continue
  const prepared=definition.prepared??definition.payload??definition
  const run=db.prepare('SELECT workflow_digest FROM execution_runs WHERE run_id=?').get(effect.run_id)
  const saved=json(db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(run.workflow_digest)?.body).config??{}
  const repository=saved.repoId??prepared.repository??prepared.githubRepository??result.repo??result.repository??''
  const branch=saved.head??prepared.branch??prepared.head??result.head??''
  const externalId=result.url??result.prUrl??result.commitId??result.commitSha??result.remoteSha
  if(typeof externalId!=='string'||!externalId)fail('TASK_PURGE_DELIVERY_ID_MISSING')
  const taskId=checked.tasks.find(t=>t.runIds.includes(effect.run_id)).taskId
  if(typeof externalId==='string'&&externalId)db.prepare('INSERT OR IGNORE INTO task_delivery_ledger VALUES(?,?,?,?,?,?,?,?)').run(taskId,String(repository),String(branch),definition.action,externalId,prepared.base??result.base??null,prepared.operationKey??null,saved.taskBase??saved.input?.baseCommit??null)
 }
 for(const task of checked.tasks){
  const nodes=db.prepare('SELECT session_id,input_ref,output_ref,evidence_refs FROM execution_nodes WHERE run_id IN (SELECT run_id FROM execution_runs WHERE task_id=?)').all(task.taskId)
  const owners=db.prepare('SELECT session_id FROM task_owners WHERE task_id=?').all(task.taskId)
  const sessions=[...new Set([...nodes,...owners].map(n=>n.session_id).filter(Boolean))]
  db.prepare('INSERT OR REPLACE INTO task_purge_cleanup VALUES(?,?)').run(task.taskId,JSON.stringify({requirementRef:task.requirementRef}))
  db.prepare('DELETE FROM task_reports WHERE task_id=?').run(task.taskId)
  db.prepare('DELETE FROM task_owner_turns WHERE task_id=?').run(task.taskId)
  db.prepare('DELETE FROM task_events WHERE task_id=?').run(task.taskId)
  db.prepare('DELETE FROM task_plan_stages WHERE task_id=?').run(task.taskId)
  db.prepare("UPDATE task_owners SET session_id=?,session_bound=0,owner_epoch=owner_epoch+1,status='idle',current_turn_id=NULL,event_watermark=0,processed_watermark=0,failure_count=0,last_failure=NULL,lease_epoch=lease_epoch+1,revision=revision+1,updated_at=? WHERE task_id=?").run(`owner-${randomUUID()}`,now,task.taskId)
  db.prepare("UPDATE business_tasks SET requirement_ref=?,plan_revision=0,plan_requirement_revision=0,status='pending',updated_at=? WHERE task_id=?").run(task.requirementRef,now,task.taskId)
  db.prepare("UPDATE task_controls SET state='paused',control_revision=control_revision+1 WHERE task_id=?").run(task.taskId)
 }
 for(const effectId of effectIds){
  for(const table of ['execution_resource_holds','execution_effect_observations','execution_approvals'])db.prepare(`DELETE FROM ${table} WHERE effect_id=?`).run(effectId)
  db.prepare('DELETE FROM execution_effects WHERE effect_id=?').run(effectId)
 }
 for(const runId of runIds){
  db.prepare("DELETE FROM execution_safety_fences WHERE scope='run' AND scope_key=?").run(runId)
  db.prepare('DELETE FROM execution_inputs WHERE run_id=?').run(runId)
  db.prepare('DELETE FROM execution_nodes WHERE run_id=?').run(runId)
  db.prepare('DELETE FROM execution_runs WHERE run_id=?').run(runId)
 }
 // Original human source messages and task-creation commands remain the canonical origin.
 const preservedKinds=new Set(['task.web-rerun.accept'])
 const owned=(kind,payload)=>{
  const taskId=payload.taskId??payload.task?.taskId??payload.binding?.taskId??payload.run?.taskId??payload.effect?.taskId
  if(taskId!==undefined)return taskIds.has(taskId)
  if(kind.startsWith('message.notification.'))return ownedNotificationIds.has(payload.notification?.id??payload.notificationId??payload.operation?.notificationId)
  if(kind==='task.execution.purge')return Array.isArray(payload.taskIds)&&payload.taskIds.length===taskIds.size&&payload.taskIds.every(id=>taskIds.has(id))
  if(!/^(run|node|input|effect|approval|job)[.]/.test(kind))return false
  const runId=payload.runId??payload.binding?.runId??payload.run?.runId??payload.node?.runId??payload.effect?.runId
  const nodeId=payload.nodeRunId??payload.binding?.nodeRunId??payload.node?.nodeRunId
  const effectId=payload.effectId??payload.effect?.effectId??payload.request?.effectId
  return runIds.has(runId)||nodeIds.has(nodeId)||effectIds.has(effectId)
 }
 const ownedNotificationIds=new Set()
 for(const item of db.prepare("SELECT item_id,kind,body FROM message_items WHERE kind='notification'").all()){
  const body=json(item.body)
  if(taskIds.has(body.payload?.fact?.taskId)){ownedNotificationIds.add(body.id);db.prepare('DELETE FROM message_items WHERE item_id=?').run(item.item_id)}
 }
 for(const item of db.prepare("SELECT item_id,kind,body FROM message_items WHERE kind IN ('notification-operation','agent-execution')").all()){
  const body=json(item.body)
  if(item.kind==='notification-operation'?ownedNotificationIds.has(body.notificationId):taskIds.has(body.binding?.taskId))db.prepare('DELETE FROM message_items WHERE item_id=?').run(item.item_id)
 }
 const removedCommands=new Set()
 for(const event of db.prepare('SELECT seq,command_id,kind,payload FROM execution_events').all()){
  if(preservedKinds.has(event.kind)||event.kind.startsWith('runtime.'))continue
  if(owned(event.kind,json(event.payload))){db.prepare('DELETE FROM execution_events WHERE seq=?').run(event.seq);if(event.command_id)removedCommands.add(event.command_id)}
 }
 // Receipts are owned by their originating command, never by an incidental reference in arbitrary JSON.
 for(const commandId of removedCommands)db.prepare('DELETE FROM execution_receipts WHERE command_id=?').run(commandId)
 for(const workflow of db.prepare('SELECT digest,body FROM message_workflows').all())if(taskIds.has(json(workflow.body).config?.taskId)&&!db.prepare('SELECT 1 FROM execution_runs WHERE workflow_digest=?').get(workflow.digest)&&!db.prepare('SELECT 1 FROM task_plan_stages WHERE workflow_digest=?').get(workflow.digest))db.prepare('DELETE FROM message_workflows WHERE digest=?').run(workflow.digest)
 return {taskIds:[...taskIds],runCount:checked.runCount,cleanupPending:true,preservesRequirements:true,preservesCode:true,preservesOriginalMessages:true,archivesExecutionHistory:false,purgedAt:now}
}
export function queryPurgeCleanup(db,taskId){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_purge_cleanup'").get())return null
 const row=db.prepare('SELECT body FROM task_purge_cleanup WHERE task_id=?').get(taskId)
 return row?json(row.body):null
}