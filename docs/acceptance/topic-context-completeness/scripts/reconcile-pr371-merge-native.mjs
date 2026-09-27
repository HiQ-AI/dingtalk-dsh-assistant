import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHostPlatformClients} from '../../../../packages/dingtalk-dsh-assistant/platform-host.js';
import {executionDigest,openExecutionArtifacts} from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js';
import {openExecutionStore} from '../../../../packages/dingtalk-dsh-assistant/execution-store.js';
import {createExecutionDelivery} from '../../../../packages/dingtalk-dsh-assistant/execution-delivery.js';
import {createUatMergePlatform} from '../../../../packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js';
import {maintenanceStatus} from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js';
import {verifyDeploymentBackup} from '../../../../scripts/deployment-integrity.mjs';
const root='D:/dsh_home/workflows/runtime-v2',profile='D:/dsh_home/profiles/web',domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116';
export const evidence=new URL('../../../tmp/pr371-merge-native-incident/',import.meta.url);
export const incidentScope='pr371-merge-native-recovery';
const fail=code=>{throw Error(code)};
export async function manifest(){const m=JSON.parse(await readFile(new URL('../round-33/pr371-merge-recovery-manifest.json',import.meta.url),'utf8'));if(executionDigest(m)!=='d58836ef1c7280b1a73e9d56c5006a7f0a6880d29c0256057fae3ee4f6bf532a')fail('INCIDENT_MANIFEST_DRIFT');return m;}
export function validateGate(snapshot,m){
 validateEffect({...snapshot.effect,state:'unknown'},m);
 if(!['unknown','succeeded'].includes(snapshot.effect.state)||snapshot.busy.nodes||snapshot.busy.owners||snapshot.busy.messages||snapshot.otherEffects.length)fail('INCIDENT_EXECUTION_NOT_DRAINED');
 if(snapshot.nodes.some(n=>!n.drained||n.status==='running'))fail('INCIDENT_NODE_NOT_DRAINED');
 const current=snapshot.nodes.find(n=>n.node_id==='execute-merge');
 if(!current||current.node_run_id!==snapshot.effect.node_run_id||current.generation!==1||current.input_digest!==snapshot.effect.input_digest)fail('INCIDENT_NODE_IDENTITY_DRIFT');
 if(!['waiting','ready'].includes(current.status)||snapshot.nodes.filter(n=>n.status==='waiting').some(n=>n!==current))fail('INCIDENT_NODE_STATE_INVALID');
 if(current.status==='waiting' && JSON.parse(current.wait_reason??'{}').reference!=='DELIVERY_RECONCILIATION_REQUIRED')fail('INCIDENT_WAIT_REASON_INVALID');
 if(!['waiting','queued'].includes(snapshot.run.status)||snapshot.run.generation!==1||snapshot.run.pause_requested||snapshot.run.stop_requested)fail('INCIDENT_RUN_STATE_INVALID');
 if(snapshot.controlState!=='active'||snapshot.pendingInputCount)fail('INCIDENT_TASK_CONTROL_INVALID');
 return snapshot;
}
export function snapshot(m){const db=new DatabaseSync(root+'/control.sqlite',{readOnly:true});try{db.exec('BEGIN');const state=maintenanceStatus(db);return validateGate({effect:db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get(m.effectId),run:db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(m.runId),nodes:db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1').all(m.runId),controlState:db.prepare('SELECT state FROM task_controls WHERE task_id=(SELECT task_id FROM execution_runs WHERE run_id=?)').get(m.runId)?.state,pendingInputCount:db.prepare("SELECT count(*) n FROM execution_inputs WHERE run_id=? AND status='pending'").get(m.runId).n,busy:state.busy,maintenance:state,otherEffects:db.prepare("SELECT effect_id FROM execution_effects WHERE state IN ('starting','executing','unknown') AND effect_id<>?").all(m.effectId),instanceId:db.prepare('SELECT instance_id FROM execution_meta').get().instance_id},m)}finally{db.close()}}
export function validateEffect(row,m){
 const payload=JSON.parse(row?.definition_json??'{}').payload;
 if(row?.effect_id!==m.effectId||row.run_id!==m.runId||row.generation!==1||row.node_id!=='execute-merge'||row.node_run_id!==m.nodeRunId||row.input_digest!==m.inputDigest||row.definition_digest!==m.definitionDigest||executionDigest(payload)!==executionDigest(m.prepared))fail('INCIDENT_EFFECT_DRIFT');
 if(payload.workflowKind!=='uat-pr-merge'||payload.operation!=='merge-uat-pr'||payload.expected.pullRequestNumber!==371||payload.expected.headCommitSha!=='3ea89c0d4daf970a5be9b8a7d40e7ec81f2da842'||payload.resourceKey!=='external:uat:HiQ-AI/dataset:dataset:feature/uat3-base')fail('INCIDENT_SCOPE_DRIFT');
}
export async function readAdapter(){
 const require=createRequire('D:/dsh_home/profiles/web/package.json'),yaml=require('js-yaml');
 const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:v=>v})]);
 const doc=yaml.load(await readFile(profile+'/cordis.patch.yml','utf8'),{schema}),matches=[];
 const seen=new Set();const walk=v=>{if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(Array.isArray(v.repositories)&&['dataset','dataset-web'].every(id=>v.repositories.some(r=>r.id===id)))matches.push(v);Object.values(v).forEach(walk)};walk(doc);
 if(matches.length!==1)fail('INCIDENT_CONFIG_AMBIGUOUS');
 const config=matches[0].platforms,policy=JSON.parse(await readFile(root+'/local-acceptance/merge-policy-53a7c3e738db46c0.json','utf8'));
 if(executionDigest(config.uatMerge)!==executionDigest(policy))fail('INCIDENT_POLICY_DRIFT');
 const targets=config.release.targets.filter(t=>t.id==='dataset-uat3-deployment');
 if(targets.length!==1||targets[0].repository!=='HiQ-AI/dataset'||targets[0].branch!=='feature/uat3-base'||targets[0].service!=='dataset')fail('INCIDENT_TARGET_DRIFT');
 const clients=await createHostPlatformClients({secretsDirectory:'D:/baibu-agent/.secrets'});
 // Default host clients deny writes; expose only native reconcile.
 const adapter=createUatMergePlatform({targets:config.release.targets,policies:policy.targets,github:clients.release.github,readLocalEvidence:async()=>fail('INCIDENT_PREFLIGHT_FORBIDDEN')});
 return {reconcile:prepared=>adapter.operationAdapter.reconcile(prepared)};
}
export async function checkObserved(m,adapter){const result=await adapter.reconcile(m.prepared);if(result.status!=='succeeded'||result.operationKey!==m.prepared.operationKey||result.mergeCommitSha!==m.prepared.expected.headCommitSha||result.treeSha!==m.prepared.expected.headTreeSha)fail('INCIDENT_MERGE_NOT_OBSERVED');return result;}
export async function nativeRecover({store,artifacts,m,operationAdapter,readSnapshot,maintenanceId,actorId}){
 const before=validateGate(await readSnapshot(),m);if(!before.maintenance.active||before.maintenance.maintenanceId!==maintenanceId||before.maintenance.actorId!==actorId)fail('INCIDENT_MAINTENANCE_DRIFT');
 const p=m.prepared;
 const delivery=createExecutionDelivery({store,artifacts,authorize:async()=>fail('INCIDENT_DISPATCH_FORBIDDEN'),externalAdapter:{reconcile:async prepared=>{if(executionDigest(prepared)!==executionDigest(p))fail('INCIDENT_PAYLOAD_DRIFT');return checkObserved(m,operationAdapter)}}});
 // This gateway has no execute method. Only durable native observations can close the held effect.
 const effect=await delivery.reconcile(m.effectId);if(effect.state!=='succeeded')fail('INCIDENT_RECONCILE_UNKNOWN');
 const run=await store.query({kind:'run',runId:m.runId});if(run.nodes.some(n=>!n.drained)||run.pendingInputCount)fail('INCIDENT_RUN_DRIFT');
 if(run.run.status==='waiting')await store.command({id:'pr371-merge-incident-recover:'+m.prepared.operationKey,kind:'run.recover',args:{runId:m.runId}});
 else if(run.run.status!=='queued')fail('INCIDENT_RUN_DRIFT');
 let state=await store.query({kind:'runtime.maintenance'});
 if(state.phase==='draining')await store.command({id:'pr371-merge-incident-seal:'+m.prepared.operationKey,kind:'runtime.maintenance.seal',args:{maintenanceId,actorId,expectedRevision:state.revision,reason:'PR371 UAT3 合并已精确原生对账，排队后封存安装'}});
 state=await store.query({kind:'runtime.maintenance'});if(state.phase!=='stopping'||!state.drained)fail('INCIDENT_SEAL_FAILED');
 return {effectId:m.effectId,effectState:effect.state,runId:m.runId,runStatus:(await store.query({kind:'run',runId:m.runId})).run.status,maintenance:state,remoteEditAttempts:0};
}
export async function main(mode){if(!['--check','--snapshot','--readback','--reconcile'].includes(mode))fail('INCIDENT_ARGUMENT_INVALID');const m=await manifest();
 const operationAdapter=await readAdapter();await checkObserved(m,operationAdapter);const state=snapshot(m);
 if(mode!=='--reconcile')return {mode,writes:0,ready:true,effectState:state.effect.state,runStatus:state.run.status,maintenance:state.maintenance,complete:state.effect.state==='succeeded'&&state.run.status==='queued'&&state.maintenance.phase==='stopping'};
 const auth=JSON.parse(await readFile(new URL('execution-plan.json',evidence),'utf8'));if(auth.scope!==incidentScope||auth.manifestDigest!==executionDigest(m))fail('INCIDENT_AUTHORIZATION_REQUIRED');
 const offline=JSON.parse(await readFile(new URL('offline.json',evidence),'utf8'));
 if(offline.effectId!==m.effectId||offline.manifestDigest!==executionDigest(m))fail('INCIDENT_OFFLINE_PROOF_INVALID');
 if(state.effect.state!=='unknown'||state.run.status!=='waiting'||state.maintenance.phase!=='draining')fail('INCIDENT_PARTIAL_NATIVE_PROGRESS_READBACK_REQUIRED');
 await verifyDeploymentBackup({runtime:root,domain,profile,backupRoot:offline.backup});
 const store=await openExecutionStore({dbPath:root+'/control.sqlite',instanceId:state.instanceId});
 try{return await nativeRecover({store,artifacts:await openExecutionArtifacts({directory:root+'/artifacts'}),m,operationAdapter,readSnapshot:()=>snapshot(m),maintenanceId:offline.maintenanceId,actorId:state.maintenance.actorId})}finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv[2]).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1});
