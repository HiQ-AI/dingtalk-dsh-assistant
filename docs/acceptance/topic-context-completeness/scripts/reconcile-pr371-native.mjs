import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {readLiveEffect,readLivePr,validateEffect,observed} from './recover-pr371-once.mjs';
import {executionDigest,openExecutionArtifacts} from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js';
import {openExecutionStore} from '../../../../packages/dingtalk-dsh-assistant/execution-store.js';
import {createExecutionDelivery} from '../../../../packages/dingtalk-dsh-assistant/execution-delivery.js';
import {createGithubPullRequests} from '../../../../packages/dingtalk-dsh-assistant/execution-pr.js';
import {maintenanceStatus} from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js';
import {verifyDeploymentBackup} from '../../../../scripts/deployment-integrity.mjs';
const root='D:/dsh_home/workflows/runtime-v2',profile='D:/dsh_home/profiles/web',domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116';
export const evidence=new URL('../../../tmp/pr371-native-incident/',import.meta.url);
export const incidentScope='pr371-native-recovery';
const fail=code=>{throw Error(code)};
export async function manifest(){const m=JSON.parse(await readFile(new URL('../round-32/pr371-recovery-manifest.json',import.meta.url),'utf8'));if(executionDigest(m)!=='ad79714e913609b66b9b24298dff97bcf2704319ea6cfaf2fb9466c682d47242')fail('INCIDENT_MANIFEST_DRIFT');return m;}
export function validateGate(snapshot,m){
 validateEffect({...snapshot.effect,state:'unknown'},m);
 if(!['unknown','succeeded'].includes(snapshot.effect.state)||snapshot.busy.nodes||snapshot.busy.owners||snapshot.busy.messages||snapshot.otherEffects.length)fail('INCIDENT_EXECUTION_NOT_DRAINED');
 if(snapshot.nodes.some(n=>!n.drained||n.status==='running'))fail('INCIDENT_NODE_NOT_DRAINED');
 const current=snapshot.nodes.find(n=>n.node_id==='create-pr');
 if(!current||current.node_run_id!==snapshot.effect.node_run_id||current.generation!==1||current.input_digest!==snapshot.effect.input_digest)fail('INCIDENT_NODE_IDENTITY_DRIFT');
 if(!['waiting','ready'].includes(current.status)||snapshot.nodes.filter(n=>n.status==='waiting').some(n=>n!==current))fail('INCIDENT_NODE_STATE_INVALID');
 if(current.status==='waiting' && JSON.parse(current.wait_reason??'{}').reference!=='DELIVERY_RECONCILIATION_REQUIRED')fail('INCIDENT_WAIT_REASON_INVALID');
 if(!['waiting','queued'].includes(snapshot.run.status)||snapshot.run.generation!==1||snapshot.run.pause_requested||snapshot.run.stop_requested)fail('INCIDENT_RUN_STATE_INVALID');
 if(snapshot.controlState!=='active'||snapshot.pendingInputCount)fail('INCIDENT_TASK_CONTROL_INVALID');
 return snapshot;
}
export function snapshot(m){const db=new DatabaseSync(root+'/control.sqlite',{readOnly:true});try{db.exec('BEGIN');const state=maintenanceStatus(db);return validateGate({effect:db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(m.effectId),run:db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(m.runId),nodes:db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1').all(m.runId),controlState:db.prepare('SELECT state FROM task_controls WHERE task_id=(SELECT task_id FROM execution_runs WHERE run_id=?)').get(m.runId)?.state,pendingInputCount:db.prepare("SELECT count(*) n FROM execution_inputs WHERE run_id=? AND status='pending'").get(m.runId).n,busy:state.busy,maintenance:state,otherEffects:db.prepare("SELECT effect_id FROM execution_effects WHERE state IN ('starting','executing','unknown') AND effect_id<>?").all(m.effectId),instanceId:db.prepare('SELECT instance_id FROM execution_meta').get().instance_id},m)}finally{db.close()}}
export async function checkObserved(m,readPr=readLivePr){let result;try{result=JSON.parse(await readFile(new URL('../round-32/pr371-recovery-result.json',import.meta.url),'utf8'))}catch(e){if(e.code==='ENOENT')fail('INCIDENT_PR_RECOVERY_NOT_OBSERVED');throw e}if(result.status!=='observed'||result.effectId!==m.effectId||result.preparedDigest!==m.prepared.digest||result.operationKey!==m.operationKey||!observed(await readPr(),m))fail('INCIDENT_PR_RECOVERY_NOT_OBSERVED');}
export async function nativeRecover({store,artifacts,m,readPr,readSnapshot,maintenanceId,actorId,reconcilePr}){
 const before=validateGate(await readSnapshot(),m);if(!before.maintenance.active||before.maintenance.maintenanceId!==maintenanceId||before.maintenance.actorId!==actorId)fail('INCIDENT_MAINTENANCE_DRIFT');
 const p=m.prepared,adapter=createGithubPullRequests({repository:p.repository,repo:p.repo,base:p.base,head:p.head,previousPullRequest:p.previousPullRequest});
 const delivery=createExecutionDelivery({store,artifacts,authorize:async()=>fail('INCIDENT_DISPATCH_FORBIDDEN'),prAdapter:{reconcile:async prepared=>{if(executionDigest(prepared)!==executionDigest(p)||!observed(await readPr(),m))fail('INCIDENT_PR_DRIFT');return reconcilePr?reconcilePr(prepared):adapter.reconcile(prepared)}}});
 // This gateway has no execute method. Only durable native observations can close the held effect.
 const effect=await delivery.reconcile(m.effectId);if(effect.state!=='succeeded')fail('INCIDENT_RECONCILE_UNKNOWN');
 const run=await store.query({kind:'run',runId:m.runId});if(run.nodes.some(n=>!n.drained)||run.pendingInputCount)fail('INCIDENT_RUN_DRIFT');
 if(run.run.status==='waiting')await store.command({id:'pr371-incident-recover:'+m.prepared.digest,kind:'run.recover',args:{runId:m.runId}});
 else if(run.run.status!=='queued')fail('INCIDENT_RUN_DRIFT');
 let state=await store.query({kind:'runtime.maintenance'});
 if(state.phase==='draining')await store.command({id:'pr371-incident-seal:'+m.prepared.digest,kind:'runtime.maintenance.seal',args:{maintenanceId,actorId,expectedRevision:state.revision,reason:'PR371精确远端成功已原生对账，排队后封存安装'}});
 state=await store.query({kind:'runtime.maintenance'});if(state.phase!=='stopping'||!state.drained)fail('INCIDENT_SEAL_FAILED');
 return {effectId:m.effectId,effectState:effect.state,runId:m.runId,runStatus:(await store.query({kind:'run',runId:m.runId})).run.status,maintenance:state,remoteEditAttempts:0};
}
export async function main(mode){if(!['--check','--snapshot','--readback','--reconcile'].includes(mode))fail('INCIDENT_ARGUMENT_INVALID');const m=await manifest();
 await checkObserved(m);const state=snapshot(m);
 if(mode!=='--reconcile')return {mode,writes:0,ready:true,effectState:state.effect.state,runStatus:state.run.status,maintenance:state.maintenance,complete:state.effect.state==='succeeded'&&state.run.status==='queued'&&state.maintenance.phase==='stopping'};
 const auth=JSON.parse(await readFile(new URL('execution-plan.json',evidence),'utf8'));if(auth.scope!==incidentScope||auth.manifestDigest!==executionDigest(m))fail('INCIDENT_AUTHORIZATION_REQUIRED');
 const offline=JSON.parse(await readFile(new URL('offline.json',evidence),'utf8'));
 if(offline.effectId!==m.effectId||offline.manifestDigest!==executionDigest(m))fail('INCIDENT_OFFLINE_PROOF_INVALID');
 if(state.effect.state!=='unknown'||state.run.status!=='waiting'||state.maintenance.phase!=='draining')fail('INCIDENT_PARTIAL_NATIVE_PROGRESS_READBACK_REQUIRED');
 await verifyDeploymentBackup({runtime:root,domain,profile,backupRoot:offline.backup});
 const store=await openExecutionStore({dbPath:root+'/control.sqlite',instanceId:state.instanceId});
 try{return await nativeRecover({store,artifacts:await openExecutionArtifacts({directory:root+'/artifacts'}),m,readPr:readLivePr,readSnapshot:()=>snapshot(m),maintenanceId:offline.maintenanceId,actorId:state.maintenance.actorId})}finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv[2]).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1});
