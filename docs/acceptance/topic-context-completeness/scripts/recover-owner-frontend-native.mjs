import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createConnection} from 'node:net';
import {pathToFileURL} from 'node:url';
import {executionDigest,openExecutionArtifacts} from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js';
import {openExecutionStore} from '../../../../packages/dingtalk-dsh-assistant/execution-store.js';
import {maintenanceStatus} from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js';
import {readTaskOwnerStageArtifacts} from '../../../../packages/dingtalk-dsh-assistant/task-owner-controller.js';
import {verifyDeploymentBackup} from '../../../../scripts/deployment-integrity.mjs';
const root='D:/dsh_home/workflows/runtime-v2',profile='D:/dsh_home/profiles/web',domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116';
export const manifestDigest='3139d2a37fd546d6a780a71e47c70bed30a0eb21286505600797f1ddb4591132';
export const evidence=new URL('../../../tmp/post-merge-local-check-incident/',import.meta.url);
export const eventKey='owner-engineering-evidence:'+manifestDigest;
const fail=code=>{throw Error(code)},same=(a,b)=>executionDigest(a)===executionDigest(b);
export async function manifest(){const m=JSON.parse(await readFile(new URL('../round-34/owner-frontend-recovery-manifest.json',import.meta.url),'utf8'));if(executionDigest(m)!==manifestDigest)fail('RECOVERY_MANIFEST_DRIFT');return m;}
export function validate(snapshot,m){
 if(!snapshot.maintenance.drained||Object.values(snapshot.maintenance.busy).some(Boolean))fail('RECOVERY_NOT_DRAINED');
 if(snapshot.controls.some(c=>c.state!=='active')||snapshot.controls.length!==2||snapshot.pendingInputs)fail('RECOVERY_CONTROL_DRIFT');
 if(!same(snapshot.stages,m.stages)||snapshot.stages.length!==3||snapshot.stages.some(s=>s.status!=='succeeded'||!s.output_ref))fail('RECOVERY_STAGE_DRIFT');
 const expectedOwner=m.owner;
 if(snapshot.event){
  if(snapshot.event.event_type!=='workflow.evidence.available'||snapshot.event.task_id!==m.owner.task_id||snapshot.event.payload_ref!==null||snapshot.owner.status!=='pending'||snapshot.owner.owner_epoch!==expectedOwner.owner_epoch||snapshot.owner.lease_epoch!==expectedOwner.lease_epoch||snapshot.owner.event_watermark!==snapshot.event.seq||snapshot.owner.processed_watermark!==expectedOwner.processed_watermark||snapshot.owner.revision!==expectedOwner.revision+1||snapshot.owner.failure_count!==0||snapshot.owner.last_failure!==null)fail('RECOVERY_OWNER_PROGRESS_DRIFT');
 }else if(!same(snapshot.owner,expectedOwner)||expectedOwner.status!=='blocked'||expectedOwner.last_failure!=='TASK_OWNER_BLOCK_CONFLICT')fail('RECOVERY_OWNER_DRIFT');
 if(!same(snapshot.frontRun,m.frontRun)||!same(snapshot.frontEffects,m.frontEffects)||snapshot.frontEffects.some(e=>e.state!=='succeeded'))fail('RECOVERY_FRONT_IDENTITY_DRIFT');
 const waiting=m.frontNodes.find(n=>n.node_id==='verify-candidate');
 if(!waiting||waiting.status!=='waiting'||waiting.output_ref!==null||JSON.parse(waiting.wait_reason).reference!=='NODE_EXECUTION_FAILED')fail('RECOVERY_MANIFEST_NODE_INVALID');
 const recovered=snapshot.frontStatus==='queued';
 if(recovered&&!snapshot.event)fail('RECOVERY_ORDER_DRIFT');
 if(!['waiting','queued'].includes(snapshot.frontStatus))fail('RECOVERY_FRONT_STATUS_DRIFT');
 const expectedNodes=m.frontNodes.map(n=>n.node_id==='verify-candidate'&&recovered?{...n,status:'ready',wait_reason:null}:n);
 if(!same(snapshot.frontNodes,expectedNodes)||snapshot.frontNodes.some(n=>!n.drained)||snapshot.frontRun.generation!==1||snapshot.frontRun.stop_requested||snapshot.frontRun.pause_requested)fail('RECOVERY_FRONT_NODE_DRIFT');
 return {ownerDone:!!snapshot.event,frontDone:recovered};
}
export function snapshot(m){const db=new DatabaseSync(root+'/control.sqlite',{readOnly:true});try{db.exec('BEGIN');return {
 instanceId:db.prepare('SELECT instance_id FROM execution_meta').get().instance_id,maintenance:maintenanceStatus(db),
 owner:db.prepare('SELECT task_id,status,owner_epoch,lease_epoch,event_watermark,processed_watermark,revision,failure_count,last_failure FROM task_owners WHERE task_id=?').get(m.owner.task_id),
 event:db.prepare('SELECT seq,task_id,event_type,payload_ref FROM task_events WHERE event_key=?').get(eventKey),
 stages:db.prepare('SELECT stage_id,workflow_id,status,run_id,output_ref,evidence_refs FROM task_plan_stages WHERE task_id=? ORDER BY position').all(m.owner.task_id),
 controls:db.prepare('SELECT state FROM task_controls WHERE task_id IN (?,?)').all(m.owner.task_id,m.frontRun.task_id),
 pendingInputs:db.prepare("SELECT count(*) n FROM execution_inputs WHERE run_id IN (?,?) AND status='pending'").get(m.frontRun.run_id,m.stages[0].run_id).n,
 frontRun:db.prepare('SELECT run_id,task_id,workflow_id,workflow_digest,generation,revision,stop_requested,pause_requested FROM execution_runs WHERE run_id=?').get(m.frontRun.run_id),
 frontStatus:db.prepare('SELECT status FROM execution_runs WHERE run_id=?').get(m.frontRun.run_id).status,
 frontNodes:db.prepare('SELECT node_run_id,node_id,generation,input_digest,status,output_ref,drained,wait_reason FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(m.frontRun.run_id),
 frontEffects:db.prepare('SELECT effect_id,definition_digest,state FROM execution_effects WHERE run_id=? ORDER BY effect_id').all(m.frontRun.run_id),
 };}finally{db.close()}}
export async function verifyProof(m){const db=new DatabaseSync(root+'/control.sqlite',{readOnly:true});let state,records;try{db.exec('BEGIN');const row=db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(m.stages[0].run_id);state={run:{runId:row.run_id,taskId:row.task_id,status:row.status,workflowId:row.workflow_id,workflowDigest:row.workflow_digest},nodes:db.prepare('SELECT node_id,status,output_ref FROM execution_nodes WHERE run_id=? AND current=1').all(row.run_id).map(n=>({nodeId:n.node_id,status:n.status,outputRef:n.output_ref}))};records=db.prepare('SELECT body FROM message_workflows').all().map(r=>JSON.parse(r.body));}finally{db.close()}
 const stages=m.stages.map(s=>({stageId:s.stage_id,status:s.status,runId:s.run_id,workflowId:s.workflow_id,outputRef:s.output_ref,evidenceRefs:JSON.parse(s.evidence_refs)}));
 const proof=await readTaskOwnerStageArtifacts({taskId:m.owner.task_id,stages,controller:{state:async()=>state},store:{query:async q=>{if(q.kind!=='workflow.list')fail('RECOVERY_QUERY_FORBIDDEN');return records}},artifacts:{read:async ref=>JSON.parse(await readFile(root+'/artifacts/'+ref,'utf8'))}});
 const diagnostic=JSON.parse(await readFile(new URL('../round-34/frontend-current-state.json',import.meta.url),'utf8'));
 if(executionDigest(diagnostic)!==m.diagnosticDigest||!diagnostic.waitingReason?.includes('ls-remote --refs -- https://github.com/HiQ-AI/dataset-web.git refs/heads/feature/uat2-base'))fail('RECOVERY_DIAGNOSTIC_DRIFT');
 return proof;
}
export async function nativeRecover({store,m,readSnapshot,verifyEvidence}){
 let s=await readSnapshot();let progress=validate(s,m);
 if(!s.maintenance.active||s.maintenance.phase!=='stopping')fail('RECOVERY_MAINTENANCE_REQUIRED');
 await verifyEvidence();
 if(!progress.ownerDone)await store.command({id:eventKey,kind:'task.owner.event',args:{taskId:m.owner.task_id,eventKey,eventType:'workflow.evidence.available'}});
 s=await readSnapshot();progress=validate(s,m);
 if(!progress.frontDone)await store.command({id:'frontend-verify-readonly-recover:'+manifestDigest,kind:'run.recover',args:{runId:m.frontRun.run_id}});
 s=await readSnapshot();progress=validate(s,m);if(!progress.ownerDone||!progress.frontDone)fail('RECOVERY_INCOMPLETE');
 return {complete:true,ownerStatus:s.owner.status,frontStatus:s.frontStatus,generation:s.frontRun.generation,remoteWrites:0,maintenance:s.maintenance};
}
async function closedPort(port){return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();reject(Error('RECOVERY_PROCESS_LISTENING'))});socket.once('error',e=>e.code==='ECONNREFUSED'?resolve():reject(e));socket.once('timeout',()=>{socket.destroy();reject(Error('RECOVERY_PORT_UNCONFIRMED'))})})}
export async function main(mode){if(!['--check','--snapshot','--readback','--reconcile'].includes(mode))fail('RECOVERY_ARGUMENT_INVALID');const m=await manifest(),s=snapshot(m),progress=validate(s,m);await verifyProof(m);
 if(mode!=='--reconcile')return {mode,writes:0,ready:true,...progress,complete:progress.ownerDone&&progress.frontDone&&s.maintenance.active&&s.maintenance.phase==='stopping',maintenance:s.maintenance};
 if(!s.maintenance.active||s.maintenance.phase!=='stopping')fail('RECOVERY_MAINTENANCE_REQUIRED');
 const plan=JSON.parse(await readFile(new URL('execution-plan.json',evidence),'utf8')),offline=JSON.parse(await readFile(new URL('offline.json',evidence),'utf8'));
 if(plan.scope!=='post-merge-local-check'||plan.manifestDigest!==manifestDigest||offline.manifestDigest!==manifestDigest||offline.maintenanceId!==s.maintenance.maintenanceId)fail('RECOVERY_PLAN_DRIFT');
 await Promise.all([closedPort(3080),closedPort(18998)]);
 if(!progress.ownerDone&&!progress.frontDone)await verifyDeploymentBackup({runtime:root,domain,profile,backupRoot:offline.backup});
 const store=await openExecutionStore({dbPath:root+'/control.sqlite',instanceId:s.instanceId});try{return await nativeRecover({store,m,readSnapshot:()=>snapshot(m),verifyEvidence:()=>verifyProof(m)})}finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv[2]).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1});
