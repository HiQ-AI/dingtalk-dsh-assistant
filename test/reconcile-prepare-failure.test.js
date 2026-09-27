import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { incident,validateEvidence } from '../docs/acceptance/topic-context-completeness/scripts/reconcile-prepare-failure.mjs'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'

test('一次性准备失败审计拒绝业务执行、身份错配、残留与未停止进程',()=>{
 const prepared={...incident,generation:1,uatEnvironment:'uat3'}
 const receipt={...incident,uatEnvironment:'uat3',baseUrl:'http://127.0.0.1:63486',passed:false,checks:[],phases:[{id:'prepare',status:'failed'},{id:'cleanup',status:'failed'}],cleanup:{processStopped:true,dataCleaned:false},failureCode:'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED'}
 const audit={namespace:incident.namespace,database:'hiq_editor',readOnly:true,processCount:0,snapshotCount:0,machine:{processCount:0,listenerCount:0}}
 validateEvidence(prepared,receipt,audit)
 for(const change of [r=>r.checks.push({passed:false}),r=>r.phases.push({id:'scenario',status:'failed'}),r=>r.passed=true,r=>r.namespace='other',r=>r.cleanup.processStopped=false]){const r=structuredClone(receipt);change(r);assert.throws(()=>validateEvidence(prepared,r,audit))}
 for(const change of [a=>a.processCount=1,a=>a.snapshotCount=1,a=>a.machine.processCount=1,a=>a.machine.listenerCount=1,a=>a.readOnly=false]){const a=structuredClone(audit);change(a);assert.throws(()=>validateEvidence(prepared,receipt,a))}
})
test('隔离控制库原生对账unknown至failed释放锁，保留历史观察且零业务重发',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'prepare-failure-')),dbPath=join(dir,'control.sqlite')
 const store=await openExecutionStore({dbPath,instanceId:'isolated',initialize:true});t.after(()=>store.close())
 const artifacts=await openExecutionArtifacts({directory:join(dir,'artifacts'),initialize:true})
 await assert.rejects(openExecutionStore({dbPath,instanceId:'isolated'}),{code:'STORE_OWNER_LOCKED'})
 await store.command({id:'create',kind:'run.create',args:{taskId:'task',runId:'run',workflowId:'local',workflowDigest:'a'.repeat(64),requirementRef:'requirement.json',nodes:[{nodeId:'local',nodeVersion:'1',executor:'code',inputRef:'input.json',inputDigest:'b'.repeat(64)}]}})
 const {result:{binding}}=await store.command({id:'claim',kind:'node.claim',args:{runId:'run',nodeId:'local',expectedGeneration:1,expectedLeaseEpoch:0}})
 let sends=0
 const grant=async()=>({principalId:'host',authorizationRef:'test'})
 const gateway=createExecutionDelivery({store,artifacts,authorize:grant,authorizeExternal:grant,externalAdapter:{execute:async()=>{sends++;return{status:'unknown',reason:'cleanup-unconfirmed'}},reconcile:async()=>({status:'failed',reason:'prepare-failed-readback',businessAcceptancePassed:false})}})
 const effect=await gateway.execute({action:'external',binding:{...binding,requirementDigest:'c'.repeat(64)},prepared:{action:'external',runId:'run',generation:1,requirementDigest:'c'.repeat(64),resourceKey:'external:local-acceptance:shared-uat',workflowKind:'local-acceptance'}})
 assert.equal(effect.state,'unknown')
 const raw=new DatabaseSync(dbPath,{readOnly:true})
 const observations=()=>raw.prepare('SELECT * FROM execution_effect_observations WHERE effect_id=?').all(effect.effectId)
 const old=observations();assert.equal(old.length,1)
 const backup=join(dir,'backup.sqlite');raw.prepare('VACUUM INTO ?').run(backup)
 const copy=new DatabaseSync(backup,{readOnly:true});assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');copy.close()
 assert.equal((await gateway.reconcile(effect.effectId)).state,'failed')
 assert.equal((await gateway.reconcile(effect.effectId)).state,'failed')
 assert.equal(sends,1)
 assert.equal(observations().length,2);assert.deepEqual(observations()[0],old[0])
 assert.equal(raw.prepare('SELECT count(*) AS n FROM execution_resource_holds').get().n,0)
 raw.close()
})
