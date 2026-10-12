import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { maintenanceStatus } from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'
const fail=code=>{throw new Error(code)}
export function verifyFailedStoreSessions({maintenance,nodes,failure,sessions}) {
 if(failure?.action!=='query'||failure?.origin!=='rpc-timeout')fail('RELOAD_FAILURE_NOT_READ_TIMEOUT')
 if(!maintenance||['owners','effects','messages'].some(k=>maintenance.busy[k]!==0))fail('RELOAD_OTHER_WORK_ACTIVE')
 if(maintenance.busy.nodes!==nodes.length||!nodes.length)fail('RELOAD_NODE_SET_MISMATCH')
 const proofs=[]
 for(const node of nodes){
  if(node.executor!=='agent'||!node.session_id)fail('RELOAD_NODE_NOT_BOUND_AGENT')
  const events=sessions[node.session_id];if(!Array.isArray(events))fail('RELOAD_SESSION_MISSING')
  const seed=events.find(e=>e.type==='dingtalk/execution-session'), identity=seed?.data?.identity
  const fields={runId:node.run_id,nodeRunId:node.node_run_id,generation:node.generation,inputDigest:node.input_digest,sessionId:node.session_id}
  if(Object.entries(fields).some(([k,v])=>identity?.[k]!==v)||seed.data.creationLease!==node.lease_epoch)fail('RELOAD_SESSION_IDENTITY_MISMATCH')
  const end=events.findLast(e=>e.type==='turn/end')
  if(!end||end!==events.at(-1)||end.data?.reason?.kind!=='error'||end.data.reason.error?.message!=='STORE_UNAVAILABLE'||end.time<Date.parse(failure.at))fail('RELOAD_SESSION_NOT_TERMINATED')
  proofs.push({nodeRunId:node.node_run_id,runId:node.run_id,sessionId:node.session_id,endSeq:end.seq,endTime:end.time})
 }
 return {recoverable:true,proofs,businessWrites:0,recovery:'native-store-open-controller-restarted'}
}
export function inspectFailedStore({dbPath,processIncarnation,failure,sessionPaths}){
 const db=new DatabaseSync(dbPath,{readOnly:true})
 try{
  if(db.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok'))fail('RELOAD_DATABASE_INTEGRITY_FAILED')
  const maintenance=maintenanceStatus(db,processIncarnation)
  const nodes=db.prepare("SELECT * FROM execution_nodes WHERE current=1 AND (status='running' OR drained=0)").all()
  const sessions={},digests={}
  for(const n of nodes){const path=sessionPaths[n.session_id];if(!path)fail('RELOAD_SESSION_MISSING');const bytes=readFileSync(path);sessions[n.session_id]=bytes.toString('utf8').trim().split('\n').map(JSON.parse);digests[n.session_id]=createHash('sha256').update(bytes).digest('hex')}
  return {...verifyFailedStoreSessions({maintenance,nodes,failure,sessions}),maintenance,sessionDigests:digests,nodes:nodes.map(n=>({nodeRunId:n.node_run_id,status:n.status,drained:n.drained}))}
 }finally{db.close()}
}

// Only native commands reconcile drain state after the real Loader disposal proof.
export async function reconcileFailedStoreSessions({store,artifacts,proof,witness,expectedPid,nonce,maintenanceId,actorId}){
 if(!proof.recoverable||witness?.kind!=='disposed'||witness.pid!==expectedPid||witness.nonce!==nonce)fail('RELOAD_DISPOSAL_PROOF_INVALID')
 const before=await store.query({kind:'runtime.maintenance'})
 if(['owners','effects','messages'].some(k=>before.busy[k]!==0))fail('RELOAD_OTHER_WORK_ACTIVE')
 await store.command({id:maintenanceId+':enter',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:before.revision,maintenanceId,actorId,reason:'故障Store已通过同Host Loader完整释放，原终止会话按原租约排空；保留成功前缀，无派发'}})
 for(const bound of proof.proofs){
  const state=await store.query({kind:'run',runId:bound.runId})
  const node=state.nodes.find(n=>n.nodeRunId===bound.nodeRunId)
  if(!node||node.sessionId!==bound.sessionId||node.status!=='waiting'||node.waitReason?.reference!=='controller-restarted')fail('RELOAD_NODE_BINDING_CHANGED')
  const evidence=await artifacts.put({kind:'native-store-failure-session-drain',witness,binding:{runId:bound.runId,nodeRunId:node.nodeRunId,sessionId:node.sessionId,generation:node.generation,leaseEpoch:node.leaseEpoch},terminal:bound,sessionDigest:proof.sessionDigests[bound.sessionId]})
  await store.command({id:maintenanceId+':drain:'+node.nodeRunId+':'+node.leaseEpoch,kind:'node.drained',args:{runId:bound.runId,nodeId:node.nodeId,generation:node.generation,leaseEpoch:node.leaseEpoch,evidenceRef:evidence.ref}})
 }
 const after=await store.query({kind:'runtime.maintenance'})
 if(!after.drained)fail('RELOAD_DRAIN_UNCONFIRMED')
 return {before,after}
}
