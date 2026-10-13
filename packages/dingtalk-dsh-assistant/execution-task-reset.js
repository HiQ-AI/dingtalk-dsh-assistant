import { randomUUID } from 'node:crypto'
import { executionError } from './execution-artifacts.js'
import { maintenanceStatus } from './execution-maintenance.js'

const fail = code => { throw executionError(code) }
export function archivedExecutionIds(db, taskId) {
  return new Set(db.prepare("SELECT payload FROM execution_events WHERE kind='task.execution.reset'").all()
    .flatMap(row => { const value=JSON.parse(row.payload); return !taskId || value.taskId===taskId ? value.archivedRunIds : [] }))
}
export function inspectExecutionReset(db, args, incarnation) {
  const task=db.prepare('SELECT b.*,c.state,c.control_revision FROM business_tasks b JOIN task_controls c USING(task_id) WHERE task_id=?').get(args.taskId)
  if(!task) fail('TASK_RESET_NOT_FOUND')
  if(task.state!=='paused'||task.control_revision!==args.expectedControlRevision) fail('TASK_RESET_CONTROL_STALE')
  const maintenance=maintenanceStatus(db,incarnation)
  if(!maintenance.active||!maintenance.drained) fail('TASK_RESET_MAINTENANCE_NOT_DRAINED')
  if(db.prepare("SELECT 1 FROM task_owners WHERE task_id=? AND status='running'").get(args.taskId)
    ||db.prepare("SELECT 1 FROM task_owner_turns WHERE task_id=? AND status='accepted' AND application_status='pending'").get(args.taskId)) fail('TASK_RESET_OWNER_NOT_DRAINED')
  const archived=archivedExecutionIds(db,args.taskId)
  const runs=db.prepare('SELECT run_id FROM execution_runs WHERE task_id=? ORDER BY rowid').all(args.taskId).filter(r=>!archived.has(r.run_id))
  for(const {run_id} of runs){
    if(db.prepare("SELECT 1 FROM execution_nodes WHERE run_id=? AND (status IN ('running','unknown') OR drained=0)").get(run_id)
      ||db.prepare("SELECT 1 FROM execution_inputs WHERE run_id=? AND status='pending'").get(run_id)
      ||db.prepare("SELECT 1 FROM execution_effects WHERE run_id=? AND state NOT IN ('succeeded','failed','rejected')").get(run_id)) fail('TASK_RESET_EXECUTION_NOT_DRAINED')
  }
  const externalEffects=db.prepare('SELECT effect_id,state,definition_json FROM execution_effects WHERE run_id IN (SELECT run_id FROM execution_runs WHERE task_id=?)').all(args.taskId)
    .filter(e=>['commit','push','pr'].includes(JSON.parse(e.definition_json).action))
  if(args.newRun && externalEffects.some(e=>e.state==='succeeded')) fail('TASK_RESET_DELIVERY_ALREADY_PERFORMED')
  const next=args.newRun
  if(next){
    const record=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(next.workflowDigest)
    const saved=record&&JSON.parse(record.body)
    if(!['20','21','24','25','26'].includes(saved?.definitionVersion)||saved.config?.taskId!==args.taskId||saved.config?.runId!==next.runId
      ||saved.workflowId!==next.workflowId||!Array.isArray(next.nodes)||!next.nodes.length
      ||next.nodes.some(n=>n.nodeId==='validate-proposal')||!next.requirementRef?.startsWith(`tasks/${args.taskId}/`)
      ||db.prepare('SELECT 1 FROM execution_runs WHERE run_id=?').get(next.runId)) fail('TASK_RESET_NEW_RUN_INVALID')
    const nodeIds=new Set()
    for(const [index,node] of next.nodes.entries()){
      if(!node.nodeId||nodeIds.has(node.nodeId)||!node.nodeVersion||!['agent','code','operation','wait'].includes(node.executor)
        ||index===0&&(!node.inputRef?.startsWith(`tasks/${args.taskId}/`)||!/^[a-f0-9]{64}$/.test(node.inputDigest??''))) fail('TASK_RESET_NEW_RUN_INVALID')
      nodeIds.add(node.nodeId)
    }
  }
  return {taskId:args.taskId,archivedRunIds:runs.map(r=>r.run_id),requirementRef:task.requirement_ref??db.prepare('SELECT requirement_ref FROM task_plan_stages WHERE task_id=? AND plan_revision=? ORDER BY position LIMIT 1').get(args.taskId,task.plan_revision)?.requirement_ref,
    requirementRevision:task.requirement_revision,planRevision:task.plan_revision,controlRevision:task.control_revision,
    externalEffectIds:externalEffects.map(e=>e.effect_id),preservesRequirements:true,preservesCode:true,preservesEffects:true,physicallyDeletesFiles:false}
}
export function reduceExecutionReset(db,args,{now,processIncarnation,addNode}) {
  const checked=inspectExecutionReset(db,args,processIncarnation), next=args.newRun
  for(const runId of checked.archivedRunIds){
    db.prepare("UPDATE execution_runs SET status=CASE WHEN status IN ('succeeded','failed','cancelled') THEN status ELSE 'cancelled' END,stop_requested=1,pause_requested=0,recovery_reason='execution-archived',revision=revision+1,updated_at=? WHERE run_id=?").run(now,runId)
    db.prepare("UPDATE execution_nodes SET status=CASE WHEN status IN ('succeeded','failed','cancelled') THEN status ELSE 'cancelled' END WHERE run_id=?").run(runId)
  }
  db.prepare("UPDATE task_plan_stages SET status='invalidated' WHERE task_id=? AND plan_revision=?").run(args.taskId,checked.planRevision)
  db.prepare("UPDATE task_owner_turns SET status='superseded',application_status=NULL,updated_at=? WHERE task_id=? AND status IN ('running','candidate')").run(now,args.taskId)
  db.prepare("UPDATE task_events SET handled_at=? WHERE task_id=? AND handled_at IS NULL").run(now,args.taskId)
  db.prepare("UPDATE task_owners SET session_id=?,session_bound=0,owner_epoch=owner_epoch+1,status='idle',failure_count=0,last_failure=NULL,current_turn_id=NULL,processed_watermark=event_watermark,revision=revision+1,updated_at=? WHERE task_id=?").run(`owner-reset-${randomUUID()}`,now,args.taskId)
  db.prepare('UPDATE task_controls SET control_revision=control_revision+1 WHERE task_id=?').run(args.taskId)
  db.prepare('UPDATE business_tasks SET requirement_ref=COALESCE(requirement_ref,?) WHERE task_id=?').run(checked.requirementRef,args.taskId)
  if(next){
    const revision=checked.planRevision+1
    db.prepare("UPDATE business_tasks SET plan_revision=?,plan_requirement_revision=requirement_revision,status='active',updated_at=? WHERE task_id=?").run(revision,now,args.taskId)
    db.prepare("INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,requirement_ref,gate,status,attempt,run_id) VALUES(?,?,?,0,?,?,?,'none','running',1,?)").run(args.taskId,revision,'stage-1',next.workflowId,next.workflowDigest,next.requirementRef,next.runId)
    db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,pause_requested,recovery_reason,created_at,updated_at) VALUES(?,?,?,?,?,'waiting',1,'user_pause',?,?)").run(next.runId,args.taskId,next.workflowId,next.workflowDigest,next.requirementRef,now,now)
    next.nodes.forEach((node,index)=>addNode(next.runId,node,index,1,index?'blocked':'ready'))
  }else db.prepare("UPDATE business_tasks SET plan_revision=0,plan_requirement_revision=0,status='pending',updated_at=? WHERE task_id=?").run(now,args.taskId)
  return {...checked,controlRevision:checked.controlRevision+1,newRunId:next?.runId??null,archivedAt:now,actorId:args.actorId,reason:args.reason,...(args.requestDigest?{requestDigest:args.requestDigest}:{})}
}


// Narrow compatibility repair for the reset transaction's historical Owner state bug.
// All other schema errors remain fatal. No execution or external effect is restarted.
export function inspectResetOwnerSchemaCorrection(db) {
 const invalid=db.prepare("SELECT turn_id,task_id,status,application_status,decision_json,updated_at FROM task_owner_turns WHERE (status='accepted' AND (decision_json IS NULL OR application_status IS NULL)) OR (status<>'accepted' AND application_status IS NOT NULL)").all()
 if(!invalid.length)return []
 const resets=db.prepare("SELECT payload FROM execution_events WHERE kind='task.execution.reset'").all().map(row=>JSON.parse(row.payload))
 if(invalid.some(turn=>turn.status!=='superseded'||!['applied','discarded'].includes(turn.application_status)
   ||turn.application_status==='applied'&&!turn.decision_json
   ||!resets.some(reset=>reset.taskId===turn.task_id&&reset.archivedAt===turn.updated_at)
   ||!db.prepare("SELECT 1 FROM task_owners WHERE task_id=? AND owner_epoch>=2 AND session_id LIKE 'owner-reset-%' AND status<>'running'").get(turn.task_id)))
   throw executionError('TASK_OWNER_INVARIANT_FAILED')
 return invalid
}
export function reconcileResetOwnerSchema(db,now) {
 const affected=inspectResetOwnerSchemaCorrection(db)
 if(!affected.length)return
 db.exec('BEGIN IMMEDIATE')
 try{
  for(const turn of affected){
   if(turn.application_status==='applied')db.prepare("UPDATE task_owner_turns SET status='accepted' WHERE turn_id=? AND status='superseded' AND application_status='applied' AND updated_at=?").run(turn.turn_id,turn.updated_at)
   else db.prepare("UPDATE task_owner_turns SET application_status=NULL WHERE turn_id=? AND status='superseded' AND application_status='discarded' AND updated_at=?").run(turn.turn_id,turn.updated_at)
  }
  db.prepare('INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES(NULL,?,?,?)').run('task.execution.reset.owner-schema-corrected',JSON.stringify({turnIds:affected.map(t=>t.turn_id),preservedAppliedHistory:true,effectsUnchanged:true,executionResumed:false}),now)
  db.exec('COMMIT')
 }catch(error){db.exec('ROLLBACK');throw error}
}
