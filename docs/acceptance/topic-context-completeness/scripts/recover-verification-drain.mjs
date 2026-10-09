import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import yaml from 'js-yaml'
import { executionDigest, openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { maintenanceStatus } from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import { queryEffects } from '../../../../packages/dingtalk-dsh-assistant/execution-effects.js'
import { queryTaskPlan } from '../../../../packages/dingtalk-dsh-assistant/execution-task-plan.js'
import { queryTaskOwner } from '../../../../packages/dingtalk-dsh-assistant/task-owner-store.js'
import { assertEchoDisposeWitness } from './recover-quarantined-echo.mjs'
import { bootstrapProfile } from '../../../../scripts/bootstrap-workflow-maintenance.mjs'

const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..')
const sourceRoot=join(workspace,'packages/dingtalk-dsh-assistant')
const profilePath='D:/dsh_home/profiles/web/cordis.patch.yml'
const dbPath='D:/dsh_home/workflows/runtime-v2/control.sqlite'
const taskId='task-83c651ebdbdb77584a06d1fcb6b9e255'
const runId='run-01a4fc72219b513a3f78e7cdb5be55699e448d6b63b97d3a65f8fcf60dc4d03f'
const nodeRunId='b96e85bf-6b4c-4c19-b7ed-97bbce3a6ce8'
const hash=x=>createHash('sha256').update(x).digest('hex')
const fail=code=>{throw Object.assign(new Error(code),{code})}
const camel=o=>o&&Object.fromEntries(Object.entries(o).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]))
const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:x=>x})])
const privatePath=p=>{if(!p||!resolve(p).startsWith(join(workspace,'docs/tmp')+sep))fail('DRAIN_PRIVATE_PATH_REQUIRED');return resolve(p)}
const preservedNodes=nodes=>nodes.map(n=>Object.fromEntries(['nodeRunId','runId','nodeId','nodeVersion','executor','position','generation','leaseEpoch','inputRef','inputDigest','status','sessionId','sessionBound','drained','drainEvidenceRef','outputRef','evidenceRefs','waitReason'].map(k=>[k,n[k]??null])))
async function sourceFiles(){
 const names=(await readdir(sourceRoot)).filter(n=>n.endsWith('.js')).sort()
 return Promise.all(names.map(async name=>({name,sha256:hash(await readFile(join(sourceRoot,name)))})))
}
function snapshot(db){
 const run=camel(db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(runId))
 const nodes=db.prepare('SELECT * FROM execution_nodes WHERE run_id=? AND current=1 ORDER BY position').all(runId).map(r=>({...camel(r),drained:!!r.drained,sessionBound:!!r.session_bound,evidenceRefs:JSON.parse(r.evidence_refs),waitReason:r.wait_reason?JSON.parse(r.wait_reason):null}))
 const pendingInputCount=db.prepare("SELECT count(*) n FROM execution_inputs WHERE run_id=? AND status='pending'").get(runId).n
 return {run,nodes,pendingInputCount}
}
export function assertVerificationDrainScope(current,maintenance,manifest,after=false){
 const node=current.nodes.find(n=>n.nodeRunId===manifest.nodeRunId)
 if(manifest.taskId!==taskId||manifest.runId!==runId||manifest.nodeRunId!==nodeRunId||!node||current.run.runId!==runId||current.run.status!=='waiting'||current.run.stopRequested||current.run.pauseRequested||current.pendingInputCount)fail('DRAIN_TASK_SCOPE_CHANGED')
 if(node.executor!=='code'||node.status!=='waiting'||node.nodeId!=='verify-candidate'||node.generation!==manifest.generation||node.leaseEpoch!==manifest.leaseEpoch||node.inputDigest!==manifest.inputDigest||node.inputRef!==manifest.inputRef||node.outputRef!==manifest.outputRef)fail('DRAIN_NODE_CAS_CHANGED')
 if(current.run.workflowDigest!==manifest.workflowDigest||current.run.revision!==manifest.runRevision||current.run.requirementRef!==manifest.requirementRef)fail('DRAIN_RUN_CAS_CHANGED')
 if(node.drained!==after||node.waitReason?.reference!==(after?'external-check-interrupted':'controller-restarted'))fail('DRAIN_WAIT_CHANGED')
 if(!maintenance.active||maintenance.phase!=='draining'||maintenance.maintenanceId!==manifest.maintenanceId||maintenance.revision!==manifest.maintenanceRevision||maintenance.busy.nodes!==(after?0:1)||maintenance.busy.owners||maintenance.busy.effects||maintenance.busy.messages)fail('DRAIN_MAINTENANCE_CHANGED')
 if(executionDigest(preservedNodes(current.nodes.filter(n=>n.nodeRunId!==manifest.nodeRunId)))!==manifest.otherNodesDigest)fail('DRAIN_PREFIX_CHANGED')
 return node
}
export function verificationDrainEligible(current,maintenance){
 const node=current.nodes.find(n=>n.nodeRunId===nodeRunId)
 return !!(current.run?.runId===runId&&current.run.status==='waiting'&&!current.run.stopRequested&&!current.run.pauseRequested&&!current.pendingInputCount
  &&node?.nodeId==='verify-candidate'&&node.executor==='code'&&node.status==='waiting'&&!node.drained&&node.generation===6&&node.leaseEpoch===1&&node.waitReason?.reference==='controller-restarted'
  &&maintenance.busy.nodes===1&&!maintenance.busy.owners&&!maintenance.busy.effects&&!maintenance.busy.messages)
}
async function inspect(profileSource,manifest,after=false,preview=false){
 const config=yaml.load(profileSource,{schema}).flatMap(e=>e.insert??[e]).find(e=>e.name==='@zzusp/dingtalk-dsh-assistant/resident').config.workflow
 const db=new DatabaseSync(dbPath,{readOnly:true});db.exec('BEGIN')
 try{
  const current=snapshot(db),maintenance=maintenanceStatus(db)
  if(preview&&!verificationDrainEligible(current,maintenance))return {eligibleRecovery:false,maintenance}
  const instanceId=db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get().instance_id
  const record=db.prepare('SELECT body FROM message_workflows WHERE json_extract(body,\'$.digest\')=?').all(current.run.workflowDigest).map(r=>JSON.parse(r.body)).find(r=>r.config?.runId===runId&&r.config.taskId===taskId)
  if(!record)fail('DRAIN_WORKFLOW_MISSING')
  const effects=queryEffects(db,{kind:'effect.list',runId}),effectsDigest=executionDigest(effects),taskPlanDigest=executionDigest(queryTaskPlan(db,{kind:'task.plan',taskId}))
  if(manifest){assertVerificationDrainScope(current,maintenance,manifest,after);if(instanceId!==manifest.instanceId||effectsDigest!==manifest.effectsDigest||taskPlanDigest!==manifest.taskPlanDigest)fail('DRAIN_EFFECTS_OR_STORE_CHANGED')}
  const artifacts=await openExecutionArtifacts({directory:join(dirname(dbPath),'artifacts'),taskWorkspaceRoot:'D:/baibu-agent'})
  if(after){
   const node=current.nodes.find(n=>n.nodeRunId===nodeRunId),evidence=await artifacts.read(node.drainEvidenceRef)
   const receipt=db.prepare('SELECT result FROM execution_receipts WHERE command_id=?').get(`process-drained:${nodeRunId}:${manifest.leaseEpoch}`)
   if(!receipt||evidence.kind!=='external-check-drain-proof'||evidence.sourcePackageSha256!==manifest.packageSha256||evidence.drained!==true||evidence.binding.nodeRunId!==nodeRunId||evidence.binding.inputDigest!==manifest.inputDigest||evidence.binding.leaseEpoch!==manifest.leaseEpoch)fail('DRAIN_RECEIPT_CHANGED')
   return {current,maintenance,node,receipt:JSON.parse(receipt.result)}
  }
  const store={command:()=>fail('DRAIN_CHECK_WRITE_FORBIDDEN'),query:async q=>{
   if(q.kind==='workflow.list')return [record]
   if(q.kind==='run')return snapshot(db)
   if(q.kind.startsWith('effect.'))return queryEffects(db,q)
   if(q.kind==='task.plan')return queryTaskPlan(db,q)
   if(q.kind.startsWith('task.owner.'))return queryTaskOwner(db,q)
   if(q.kind==='node.process-claim'){
    const row=db.prepare("SELECT payload,created_at FROM execution_events WHERE kind='node.claim' AND json_extract(payload,'$.binding.nodeRunId')=? AND json_extract(payload,'$.binding.leaseEpoch')=? ORDER BY seq DESC LIMIT 1").get(q.nodeRunId,q.leaseEpoch)
    return row?{binding:JSON.parse(row.payload).binding,claimedAt:row.created_at,recoveredAt:db.prepare("SELECT created_at FROM execution_events WHERE kind='node.recovery' AND json_extract(payload,'$.nodeRunId')=? AND created_at>=? ORDER BY seq LIMIT 1").get(q.nodeRunId,row.created_at)?.created_at}:null
   }
   fail('DRAIN_UNEXPECTED_QUERY')
  }}
  // 仅保留已注册命令路径；新代码不写入安装目录，不改变旧工厂摘要。
  let source=await readFile(join(sourceRoot,'workflow-engineering.js'),'utf8')
  source=source.replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve(sourceRoot,p)).href}'`).replace("new URL('./execution-task-command.js', import.meta.url)","new URL('file:///D:/dsh_home/profiles/web/node_modules/@zzusp/dingtalk-dsh-assistant/execution-task-command.js')")
  const {createEngineeringRegistry}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
  const registry=createEngineeringRegistry({repositories:config.repositories,ownerActorId:config.ownerActorId,author:config.gitAuthor,modelConfig:()=>fail('DRAIN_MODEL_FORBIDDEN')})
  await registry.restore(store,artifacts)
  const node=current.nodes.find(n=>n.nodeRunId===nodeRunId),scope=await registry.externalProcessScope({state:current,node})
  if(!scope)fail('DRAIN_UNTRUSTED_CHECK')
  const proof=await scope.inspect();if(proof.drained!==true)fail('DRAIN_OS_PROCESS_STILL_PRESENT')
  return {current,maintenance,instanceId,effectsDigest,taskPlanDigest,node,binding:scope.binding,proof}
 }finally{db.close()}
}
async function main(){
 const [mode,manifestArg,directoryOrPackage,packageSha]=process.argv.slice(2),manifestPath=privatePath(manifestArg)
 if(!['preview','capture','check','repair'].includes(mode))fail('DRAIN_MODE_INVALID')
 const original=await readFile(profilePath,'utf8')
 if(mode==='capture'||mode==='preview'){
  if(!/^[a-f0-9]{64}$/.test(packageSha??'')||hash(await readFile(directoryOrPackage))!==packageSha)fail('DRAIN_PACKAGE_CHANGED')
  const x=await inspect(original,undefined,false,mode==='preview'),n=x.node
  if(x.eligibleRecovery===false){console.log(JSON.stringify({eligibleRecovery:false,writes:0,reason:'DRAIN_INCIDENT_NOT_CURRENT',maintenanceId:x.maintenance.maintenanceId,maintenanceRevision:x.maintenance.revision,profileSha256:hash(original)}));return}
  const manifest={taskId,runId,nodeRunId,instanceId:x.instanceId,dbPath,profileSha256:hash(original),packagePath:resolve(directoryOrPackage),packageSha256:packageSha,sourceFiles:await sourceFiles(),maintenanceId:x.maintenance.maintenanceId,maintenanceRevision:x.maintenance.revision,initialRevision:x.maintenance.revision,generation:n.generation,leaseEpoch:n.leaseEpoch,inputDigest:n.inputDigest,inputRef:n.inputRef,outputRef:n.outputRef,workflowDigest:x.current.run.workflowDigest,runRevision:x.current.run.revision,requirementRef:x.current.run.requirementRef,otherNodesDigest:executionDigest(preservedNodes(x.current.nodes.filter(n=>n.nodeRunId!==nodeRunId))),effectsDigest:x.effectsDigest}
  if(mode==='preview'&&!x.maintenance.active){
   assertVerificationDrainScope(x.current,{...x.maintenance,active:true,phase:'draining'},manifest)
  }else assertVerificationDrainScope(x.current,x.maintenance,manifest)
  manifest.taskPlanDigest=x.taskPlanDigest
  if(mode==='preview'){console.log(JSON.stringify({eligibleRecovery:true,needsMaintenance:!x.maintenance.active,writes:0,taskId,runId,maintenanceId:x.maintenance.maintenanceId,maintenanceRevision:x.maintenance.revision,profileSha256:manifest.profileSha256,packageSha256:packageSha}));return}
  await writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx'})
  console.log(JSON.stringify({captured:true,manifestPath,taskId,runId,maintenanceRevision:manifest.maintenanceRevision}));return
 }
 const c=JSON.parse(await readFile(manifestPath,'utf8')),directory=privatePath(directoryOrPackage)
 if(hash(await readFile(c.packagePath))!==c.packageSha256||executionDigest(await sourceFiles())!==executionDigest(c.sourceFiles))fail('DRAIN_SOURCE_CHANGED')
 let profileSource=original,record
 if(mode==='check'){if(hash(original)!==c.profileSha256)fail('DRAIN_PROFILE_CHANGED')}
 else{
  record=JSON.parse(await readFile(join(directory,'recovery.json'),'utf8'))
  if(record.runId!==runId||record.instanceId!==c.instanceId||record.originalSha256!==c.profileSha256||record.incidentHash.toLowerCase()!==hash(await readFile(manifestPath)))fail('DRAIN_WITNESS_SCOPE_CHANGED')
  assertEchoDisposeWitness(record,JSON.parse(await readFile(join(directory,'bootstrap-ready.json'),'utf8')),JSON.parse(await readFile(join(directory,'bootstrap-disposed.json'),'utf8')),original,yaml)
  profileSource=bootstrapProfile(original,'enable',yaml);if(hash(profileSource)!==c.profileSha256)fail('DRAIN_PROFILE_CHANGED')
 }
 if(mode==='repair'){
  const db=new DatabaseSync(dbPath,{readOnly:true});let alreadyDrained
  try{alreadyDrained=!!db.prepare('SELECT drained FROM execution_nodes WHERE node_run_id=?').get(nodeRunId)?.drained}finally{db.close()}
  if(alreadyDrained){
   const x=await inspect(profileSource,c,true)
   const readback={receipt:x.receipt,evidenceRef:x.node.drainEvidenceRef,taskId,runId,nodeRunId,maintenance:x.maintenance,prefixPreserved:true,effectsUnchanged:true,inputRef:c.inputRef,workflowDigest:c.workflowDigest,generation:c.generation,dispatched:false}
   try{await writeFile(join(directory,'repair-readback.json'),JSON.stringify(readback,null,2),{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}
   console.log(JSON.stringify({replayed:true,drained:true,dispatched:false,evidenceRef:x.node.drainEvidenceRef}));return
  }
 }
 const before=await inspect(profileSource,c)
 if(mode==='check'){console.log(JSON.stringify({check:{eligible:true,taskId,runId,nodeRunId,method:before.proof.method,processes:0,prefixPreserved:true},writes:0}));return}
 const store=await openExecutionStore({dbPath,instanceId:c.instanceId})
 try{
  const current=await store.query({kind:'run',runId});assertVerificationDrainScope(current,await store.query({kind:'runtime.maintenance'}),c)
  if(executionDigest(await store.query({kind:'effect.list',runId}))!==c.effectsDigest)fail('DRAIN_EFFECTS_CHANGED')
  const fresh=await inspect(profileSource,c)
  const artifacts=await openExecutionArtifacts({directory:join(dirname(dbPath),'artifacts'),taskWorkspaceRoot:'D:/baibu-agent'})
  const evidence=await artifacts.put({kind:'external-check-drain-proof',binding:fresh.binding,...fresh.proof,maintenanceId:c.maintenanceId,sourcePackageSha256:c.packageSha256},{reference:c.inputRef})
  const receipt=await store.command({id:`process-drained:${nodeRunId}:${c.leaseEpoch}`,kind:'node.drained',args:{runId,nodeId:'verify-candidate',generation:c.generation,leaseEpoch:c.leaseEpoch,evidenceRef:evidence.ref,expectedInputDigest:c.inputDigest}})
  const after=await store.query({kind:'run',runId}),maintenance=await store.query({kind:'runtime.maintenance'})
  assertVerificationDrainScope(after,maintenance,c,true)
  if(executionDigest(await store.query({kind:'effect.list',runId}))!==c.effectsDigest)fail('DRAIN_EFFECTS_CHANGED')
  await artifacts.read(evidence.ref)
  await writeFile(join(directory,'repair-readback.json'),JSON.stringify({receipt,evidenceRef:evidence.ref,taskId,runId,nodeRunId,maintenance,prefixPreserved:true,effectsUnchanged:true,inputRef:c.inputRef,workflowDigest:c.workflowDigest,generation:c.generation,dispatched:false},null,2),{flag:'wx'})
  console.log(JSON.stringify({recovered:true,drained:true,status:after.run.status,dispatched:false,evidenceRef:evidence.ref}))
 }finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.code??'DRAIN_RECOVERY_FAILED');process.exitCode=1})
