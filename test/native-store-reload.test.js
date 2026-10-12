import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyFailedStoreSessions} from '../scripts/native-store-reload.mjs'
const node={executor:'agent',run_id:'run',node_run_id:'node',generation:1,input_digest:'digest',session_id:'session',lease_epoch:1}
const seed={type:'dingtalk/execution-session',data:{identity:{runId:'run',nodeRunId:'node',generation:1,inputDigest:'digest',sessionId:'session'},creationLease:1}}
const end={type:'turn/end',seq:5,time:2000,data:{reason:{kind:'error',error:{message:'STORE_UNAVAILABLE'}}}}
const fixture=()=>({maintenance:{busy:{nodes:1,owners:0,effects:0,messages:0}},nodes:[structuredClone(node)],failure:{action:'query',origin:'rpc-timeout',at:new Date(1000).toISOString()},sessions:{session:[structuredClone(seed),structuredClone(end)]}})
test('failed Store session permits native recovery without mutating original run',()=>{const f=fixture(),before=JSON.stringify(f);assert.equal(verifyFailedStoreSessions(f).recoverable,true);assert.equal(JSON.stringify(f),before)})
for(const mode of ['active-session','identity','unknown-effect','owner','write-timeout','lease'])test(`native reload rejects ${mode}`,()=>{const f=fixture();if(mode==='active-session')f.sessions.session.push({type:'turn/start'});if(mode==='identity')f.sessions.session[0].data.identity.nodeRunId='foreign';if(mode==='unknown-effect')f.maintenance.busy.effects=1;if(mode==='owner')f.maintenance.busy.owners=1;if(mode==='write-timeout')f.failure.action='command';if(mode==='lease')f.nodes[0].lease_epoch=2;assert.throws(()=>verifyFailedStoreSessions(f),/RELOAD_/ )})

import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {reconcileFailedStoreSessions} from '../scripts/native-store-reload.mjs'
test('native reopen and node.drained preserve original lease without dispatch or success',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-store-reload-')),dbPath=join(root,'control.sqlite'),instanceId='reload'
 let store=await openExecutionStore({dbPath,instanceId,initialize:true})
 const cmd=(id,kind,args)=>store.command({id,kind,args}),digest='a'.repeat(64)
 await cmd('create','run.create',{runId:'run',taskId:'task',workflowId:'workflow',workflowDigest:digest,requirementRef:'sha256/req.json',nodes:[{nodeId:'inspect',nodeVersion:'1',executor:'agent',inputRef:'sha256/input.json',inputDigest:digest}]})
 const bound=(await cmd('claim','node.claim',{runId:'run',nodeId:'inspect',expectedGeneration:1,expectedLeaseEpoch:0})).result.binding
 await cmd('bound','node.sessionBound',{runId:'run',nodeId:'inspect',generation:1,leaseEpoch:1,sessionId:bound.sessionId})
 await store.close();store=await openExecutionStore({dbPath,instanceId})
 try{
 const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
 const proof={recoverable:true,sessionDigests:{[bound.sessionId]:digest},proofs:[{runId:'run',nodeRunId:bound.nodeRunId,sessionId:bound.sessionId,endSeq:5,endTime:2000}]}
 await assert.rejects(reconcileFailedStoreSessions({store,artifacts,proof,witness:{kind:'ready',pid:1,nonce:'n'},expectedPid:1,nonce:'n'}),/DISPOSAL/)
 const result=await reconcileFailedStoreSessions({store,artifacts,proof,witness:{kind:'disposed',pid:1,nonce:'n'},expectedPid:1,nonce:'n',maintenanceId:'reload',actorId:'owner'})
 assert.equal(result.after.drained,true);assert.equal(result.after.active,true)
 const state=await store.query({kind:'run',runId:'run'})
 assert.equal(state.nodes[0].nodeRunId,bound.nodeRunId);assert.equal(state.nodes[0].leaseEpoch,1);assert.equal(state.nodes[0].drained,true);assert.equal(state.nodes[0].status,'waiting');assert.equal(state.run.claimCount,1)
 }finally{await store.close()}
})
