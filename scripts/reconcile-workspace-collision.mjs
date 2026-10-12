import {readFile} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {executionDigest,openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {queryEffects} from '../packages/dingtalk-dsh-assistant/execution-effects.js'
import {maintenanceStatus} from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import {createManagedWorkspaces} from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import {createExecutionDelivery} from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
const fail=code=>{throw Error(code)}
export function validateCollisionBinding(effect,scope){
 if(!effect||effect.runId!==scope.runId||effect.effectId!==scope.effectId||effect.kind!=='operation'
  ||effect.definition?.action!=='workspace'||effect.definition.adapterId!=='managed-workspace'||effect.definition.adapterVersion!=='1'
  ||effect.nodeId!=='prepare-workspace'||!['unknown','failed'].includes(effect.state))fail('WORKSPACE_RECOVERY_SCOPE_INVALID')
 if(effect.state==='failed'&&(effect.result?.result?.reason!=='WORKSPACE_PREPARATION_ADDRESS_COLLISION'||effect.result.result.mutationAttempted!==false))fail('WORKSPACE_RECOVERY_NOT_COLLISION')
}
function snapshot(proposal){
 const db=new DatabaseSync(proposal.dbPath,{readOnly:true});db.exec('BEGIN')
 try{
  const maintenance=maintenanceStatus(db),effects=proposal.effects.map(scope=>{
   const effect=queryEffects(db,{kind:'effect.get',effectId:scope.effectId});validateCollisionBinding(effect,scope)
   const run=db.prepare('SELECT task_id,generation FROM execution_runs WHERE run_id=?').get(scope.runId)
   const node=db.prepare('SELECT status,drained FROM execution_nodes WHERE node_run_id=?').get(effect.nodeRunId)
   if(run?.task_id!==scope.taskId||run.generation!==effect.generation||!node?.drained||node.status==='running')fail('WORKSPACE_RECOVERY_RUN_CHANGED')
   const task=db.prepare('SELECT t.requirement_revision,t.plan_revision,c.control_revision FROM business_tasks t JOIN task_controls c USING(task_id) WHERE t.task_id=?').get(scope.taskId)
   if(!task)fail('WORKSPACE_RECOVERY_SCOPE_INVALID')
   const state=db.prepare('SELECT revision,generation FROM execution_runs WHERE run_id=?').get(scope.runId)
   const current=db.prepare('SELECT node_run_id,generation,lease_epoch,input_digest FROM execution_nodes WHERE node_run_id=?').get(effect.nodeRunId)
   return {...effect,terminalBinding:{taskId:scope.taskId,runId:scope.runId,runRevision:state.revision,nodeRunId:current.node_run_id,generation:current.generation,leaseEpoch:current.lease_epoch,inputDigest:current.input_digest,effectId:effect.effectId,expectedRequirementRevision:task.requirement_revision,expectedPlanRevision:task.plan_revision,expectedControlRevision:task.control_revision}}
  })
  return {maintenance,effects,instanceId:db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get().instance_id}
 }finally{db.close()}
}
export async function reconcileWorkspaceCollisions({proposalPath,mode,expectedProofDigest,expectedMaintenanceId,expectedMaintenanceRevision}){
 const proposal=JSON.parse(await readFile(proposalPath,'utf8'))
 if(!['check','apply','finalize'].includes(mode)||!['dbPath','artifactDirectory','taskWorkspaceRoot'].every(key=>isAbsolute(proposal[key]??''))
  ||!Array.isArray(proposal.effects)||!proposal.effects.length||proposal.effects.length>10||new Set(proposal.effects.map(x=>x.effectId)).size!==proposal.effects.length)fail('WORKSPACE_RECOVERY_ARGUMENTS_INVALID')
 const before=snapshot(proposal),observations=[]
 for(const effect of before.effects){
  const p=effect.definition.payload,adapter=await createManagedWorkspaces({root:p.root,sourceRepository:p.sourceRepository,...(p.targetCommit?{targetCommit:p.targetCommit,taskBase:p.taskBase}:{})})
  const observation=await adapter.reconcile(p)
  if(observation.status!=='failed'||observation.reason!=='WORKSPACE_PREPARATION_ADDRESS_COLLISION'||observation.mutationAttempted!==false)fail('WORKSPACE_RECOVERY_NOT_PROVEN')
  observations.push({effectId:effect.effectId,taskId:proposal.effects.find(x=>x.effectId===effect.effectId).taskId,runId:effect.runId,generation:effect.generation,inputDigest:effect.inputDigest,dispatchLeaseEpoch:effect.dispatchLeaseEpoch,definitionDigest:executionDigest(effect.definition),terminalBinding:effect.terminalBinding,observation})
 }
 const proof={kind:'workspace-collision-reconciliation-proof',instanceId:before.instanceId,observations},digest=executionDigest(proof)
 if(mode==='check')return {mode,writes:0,proof,digest,maintenance:before.maintenance}
 if(expectedProofDigest!==digest)fail('WORKSPACE_RECOVERY_PROOF_CHANGED')
 if(before.maintenance.maintenanceId!==expectedMaintenanceId||before.maintenance.revision!==expectedMaintenanceRevision||!before.maintenance.active||before.maintenance.phase!=='draining'||before.maintenance.busy.nodes||before.maintenance.busy.owners||before.maintenance.busy.messages
  ||before.maintenance.busy.effects!==before.effects.filter(x=>x.state==='unknown').length)fail('WORKSPACE_RECOVERY_MAINTENANCE_REQUIRED')
 if(mode==='finalize'){
  const terminalResults=[]
  for(const entry of observations){
   const {taskId,...binding}=entry.terminalBinding
   const response=await fetch(`http://127.0.0.1:18998/tasks/${encodeURIComponent(entry.taskId)}/execution-control`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:3080'},body:JSON.stringify({requestId:`workspace-terminal:${entry.effectId}:${entry.terminalBinding.leaseEpoch}`,action:'reconcile-failure',reason:'Read back original no-mutation workspace collision and record failed terminal state without replay',...binding,maintenanceId:expectedMaintenanceId,maintenanceRevision:expectedMaintenanceRevision}),signal:AbortSignal.timeout(30000)})
   const result=await response.json()
   if(!response.ok)fail(result.error??'WORKSPACE_TERMINAL_HOST_REJECTED')
   const detailResponse=await fetch(`http://127.0.0.1:18998/state/tasks/${encodeURIComponent(entry.taskId)}/detail`,{signal:AbortSignal.timeout(15000)}),detail=await detailResponse.json()
   if(!detailResponse.ok||result.state?.run?.status!=='failed'||result.state.nodes.find(n=>n.nodeRunId===entry.terminalBinding.nodeRunId)?.status!=='failed'||detail.plan.stages.find(s=>s.runId===entry.runId)?.status!=='blocked')fail('WORKSPACE_TERMINAL_READBACK_FAILED')
   terminalResults.push({taskId:entry.taskId,runId:entry.runId,nodeRunId:entry.terminalBinding.nodeRunId,status:'failed',stageStatus:'blocked'})
  }
  return {mode,digest,terminalResults,writer:'existing-host-store'}
 }
 const store=await openExecutionStore({dbPath:proposal.dbPath,instanceId:before.instanceId})
 try{
  const fresh=snapshot(proposal)
  if(fresh.maintenance.revision!==before.maintenance.revision||fresh.maintenance.maintenanceId!==before.maintenance.maintenanceId)fail('WORKSPACE_RECOVERY_MAINTENANCE_CHANGED')
  const artifacts=await openExecutionArtifacts({directory:proposal.artifactDirectory,taskWorkspaceRoot:proposal.taskWorkspaceRoot})
  const delivery=createExecutionDelivery({store,artifacts,authorize:async()=>fail('WORKSPACE_RECOVERY_DISPATCH_FORBIDDEN'),workspaceAdapter:{reconcile:async payload=>{
   const entry=observations.find(item=>item.observation.preparedDigest===payload.digest)
   if(!entry)fail('WORKSPACE_RECOVERY_PAYLOAD_CHANGED')
   const adapter=await createManagedWorkspaces({root:payload.root,sourceRepository:payload.sourceRepository,...(payload.targetCommit?{targetCommit:payload.targetCommit,taskBase:payload.taskBase}:{})})
   const actual=await adapter.reconcile(payload)
   if(executionDigest(actual)!==executionDigest(entry.observation))fail('WORKSPACE_RECOVERY_PROOF_CHANGED')
   return actual
  }}})
  for(const entry of observations){
   const effect=await store.query({kind:'effect.get',effectId:entry.effectId})
   if(effect.inputDigest!==entry.inputDigest||effect.dispatchLeaseEpoch!==entry.dispatchLeaseEpoch||executionDigest(effect.definition)!==entry.definitionDigest)fail('WORKSPACE_RECOVERY_BINDING_CHANGED')
   const result=await delivery.reconcile(entry.effectId)
   if(result.state!=='failed'||result.result?.result?.mutationAttempted!==false)fail('WORKSPACE_RECOVERY_READBACK_FAILED')

  }
  return {mode,digest,observations:observations.map(x=>({effectId:x.effectId,state:'failed',reason:x.observation.reason})),maintenance:await store.query({kind:'runtime.maintenance'})}
 }finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [mode,proposalPath,expectedProofDigest,expectedMaintenanceId,revision,...extra]=process.argv.slice(2);if(extra.length)fail('WORKSPACE_RECOVERY_ARGUMENTS_INVALID');console.log(JSON.stringify(await reconcileWorkspaceCollisions({mode,proposalPath,expectedProofDigest,expectedMaintenanceId,expectedMaintenanceRevision:revision===undefined?undefined:Number(revision)})).replace(/[^\x00-\x7F]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')))}catch(error){console.error(error.message);process.exitCode=1}
}
