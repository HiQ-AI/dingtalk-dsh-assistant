import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { spawnSync } from 'node:child_process'
import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { assertTaskRunScope,createTaskRunScope } from '../packages/dingtalk-dsh-assistant/execution-task-run-scope.js'
import { assertMaintenanceDispatch,maintenanceState } from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'
const d='a'.repeat(64), ref='sha256/input.json', cmd=(kind,args)=>({id:randomUUID(),kind,args})
async function fixture(t,arm=true,withChild=false){
 const root=await mkdtemp(join(tmpdir(),'single-task-scope-')),dbPath=join(root,'control.sqlite'),instanceId=randomUUID()
 let store=await openExecutionStore({dbPath,instanceId,initialize:true})
 for(const taskId of ['one','two'])await store.command(cmd('run.create',{runId:taskId+'-run',taskId,workflowId:'engineering',workflowDigest:d,requirementRef:ref,nodes:[...(withChild?[{nodeId:'prepare',nodeVersion:'1',executor:'code',inputRef:ref,inputDigest:d}]:[]),{nodeId:'commit',nodeVersion:'1',executor:'code',inputRef:ref,inputDigest:d}]}))
 await store.close()
 const db=new DatabaseSync(dbPath),now=new Date().toISOString()
 for(const taskId of ['one','two']){
  db.prepare('INSERT INTO business_tasks VALUES(?,1,?,1,1,?,?,?)').run(taskId,ref,'active',now,now)
  db.prepare('INSERT INTO task_controls VALUES(?,1,?)').run(taskId,'paused')
  db.prepare(`INSERT INTO task_plan_stages(task_id,plan_revision,stage_id,position,workflow_id,workflow_digest,requirement_ref,gate,status,attempt,run_id) VALUES(?,1,'stage-1',0,'engineering',?,?, 'none','running',1,?)`).run(taskId,d,ref,taskId+'-run')
 }
 db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)').run('source','source',1,JSON.stringify({runId:'source',status:'settled',conversationId:'group'}))
 db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run('source-command','source','command',JSON.stringify({kind:'create',args:{taskId:'one'}}))
 db.prepare('INSERT INTO message_workflows VALUES(?,?)').run(d,JSON.stringify({config:{kind:'engineering',taskId:'one',runId:'one-run',repositoryIdentity:{remote:'https://github.com/owner/repo.git',githubRepository:'owner/repo'},head:'codex/one',uatBranch:'feature/uat3-base'}}))
 db.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)').run('runtime.maintenance.changed',JSON.stringify({active:true,phase:'stopping',revision:1,maintenanceId:'maintenance',actorId:'actor',sealedIncarnation:'old-incarnation'}),now)
 db.close();store=await openExecutionStore({dbPath,instanceId});t.after(()=>store.close())
 const args={taskId:'one',runId:'one-run',expectedRequirementRevision:1,expectedControlRevision:1,groupId:'group',allowedEffects:['workspace','edit','external','commit','push','pr','progress'],expectedRevision:1,maintenanceId:'maintenance',actorId:'actor',reason:'explicit test user authorization'}
 if(arm)await store.command(cmd('runtime.maintenance.task-run',args));return {root,dbPath,instanceId,store,args}
}
test('real worker CAS scope admits only one of two concurrent task controls and node claims',async t=>{
 const f=await fixture(t)
 const results=await Promise.allSettled(['one','two'].map(taskId=>f.store.command(cmd('task.control.resume',{taskId,expectedControlRevision:1}))))
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'TASK_RUN_SCOPE_DISPATCH_DENIED')
 const claims=await Promise.allSettled(['one','two'].map(taskId=>f.store.command(cmd('node.claim',{runId:taskId+'-run',nodeId:'commit',expectedGeneration:1,expectedLeaseEpoch:0}))))
 assert.equal(claims[0].status,'fulfilled');assert.equal(claims[1].reason.code,'TASK_RUN_SCOPE_DISPATCH_DENIED')
 await assert.rejects(f.store.command(cmd('runtime.maintenance.task-run',f.args)),e=>e.code==='RUNTIME_MAINTENANCE_STALE')
})
test('persisted scope denies new process incarnation, late unrelated owner/input, and preserves maintenance recovery',async t=>{
 const f=await fixture(t);await f.store.close();const db=new DatabaseSync(f.dbPath);t.after(()=>db.close());const scope=maintenanceState(db).taskRunScope
 assert.ok(scope);assert.throws(()=>assertMaintenanceDispatch(db,cmd('node.claim',{runId:'one-run',nodeId:'commit'}),'restarted'),/TASK_RUN_SCOPE_REARM_REQUIRED/)
 assert.doesNotThrow(()=>assertMaintenanceDispatch(db,cmd('runtime.maintenance.change',{active:true}),'restarted'))
 for(const kind of ['message.coordinator.claim','message.agent.begin','message.command.claim','message.node.claim','task.plan.extend','task.plan.revise','run.create'])assert.throws(()=>assertTaskRunScope(db,cmd(kind,{taskId:'one'}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
 assert.throws(()=>assertTaskRunScope(db,cmd('task.owner.claim',{taskId:'two'}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
 assert.doesNotThrow(()=>assertTaskRunScope(db,cmd('task.owner.claim',{taskId:'one'}),scope,scope.processIncarnation))
})
test('effect gate rejects merge/deploy/production operations, foreign run and branch; allows exact local and Git actions',async t=>{
 const f=await fixture(t);await f.store.close();const db=new DatabaseSync(f.dbPath);t.after(()=>db.close());const scope=maintenanceState(db).taskRunScope
 const effect=(action,nodeId,payload={})=>cmd('effect.prepare',{runId:'one-run',nodeId,definition:{action,payload}})
 for(const action of ['merge','deploy','sql','database','message','file','artifact'])assert.throws(()=>assertTaskRunScope(db,effect(action,'commit'),scope,scope.processIncarnation),/TASK_RUN_SCOPE_EFFECT_DENIED/)
 assert.doesNotThrow(()=>assertTaskRunScope(db,effect('commit','commit',{remote:scope.remote,ref:'refs/heads/'+scope.head}),scope,scope.processIncarnation))
 assert.doesNotThrow(()=>assertTaskRunScope(db,effect('external','run-local-acceptance',{workflowKind:'local-acceptance',taskId:'one',runId:'one-run'}),scope,scope.processIncarnation))
 assert.throws(()=>assertTaskRunScope(db,effect('external','run-local-acceptance',{workflowKind:'data-change',taskId:'one',runId:'one-run'}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_EFFECT_DENIED/)
 assert.doesNotThrow(()=>assertTaskRunScope(db,effect('push','push',{remote:scope.remote,ref:'refs/heads/'+scope.head}),scope,scope.processIncarnation))
 assert.throws(()=>assertTaskRunScope(db,effect('push','push',{remote:scope.remote,ref:'refs/heads/main'}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_EFFECT_DENIED/)
 assert.throws(()=>assertTaskRunScope(db,{...effect('commit','commit'),args:{...effect('commit','commit').args,runId:'two-run'}},scope,scope.processIncarnation),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
})
test('persisted notification provenance restricts original task and group; forged facts and operations denied',async t=>{
 const f=await fixture(t);await f.store.close();const db=new DatabaseSync(f.dbPath);t.after(()=>db.close());const scope=maintenanceState(db).taskRunScope
 // Durable report columns are inspected so fixture inserts the actual schema, not an alternate notifier.
 db.prepare("INSERT INTO task_owners(task_id,session_id,status,updated_at) VALUES('one','owner-session','idle',?)").run(new Date().toISOString())
 db.prepare("INSERT INTO task_owner_turns(turn_id,task_id,lease_epoch,event_watermark,requirement_revision,plan_revision,control_revision,authorization_revision,input_fence_revision,status,application_status,created_at,updated_at) VALUES('turn','one',1,1,1,1,1,1,0,'accepted','applied',?,?)").run(new Date().toISOString(),new Date().toISOString())
 const columns=db.prepare('PRAGMA table_info(task_reports)').all().map(x=>x.name)
 const row={report_id:'report',task_id:'one',turn_id:'turn',report_type:'progress',facts_json:'[]',created_at:new Date().toISOString(),sequence_id:1,body:'progress'}
 db.prepare('INSERT INTO task_reports('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(k=>row[k]??''))
 const put=(id,taskId,group)=>db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run(id,'source','notification',JSON.stringify({payload:{phase:'owner:report',conversationId:group,fact:{taskId}}}))
 put('yes','one','group');put('wrong-task','two','group');put('wrong-group','one','another')
 assert.doesNotThrow(()=>assertTaskRunScope(db,cmd('message.notification.claim',{notificationId:'yes'}),scope,scope.processIncarnation))
 for(const id of ['wrong-task','wrong-group','missing'])assert.throws(()=>assertTaskRunScope(db,cmd('message.notification.claim',{notificationId:id}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_NOTIFICATION_DENIED/)
 assert.throws(()=>assertTaskRunScope(db,cmd('message.notification.operation.claim',{operationId:'x'}),scope,scope.processIncarnation),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
})

test('actual new Node process observes persisted scope and cannot dispatch; late event cannot open unrelated task',async t=>{
 const f=await fixture(t);await f.store.close()
 const source=`import {openExecutionStore} from ${JSON.stringify(new URL('../packages/dingtalk-dsh-assistant/execution-store.js',import.meta.url).href)};
const s=await openExecutionStore(${JSON.stringify({dbPath:f.dbPath,instanceId:f.instanceId})});
try{const state=await s.query({kind:'runtime.maintenance'});if(!state.taskRunScope)throw Error('scope lost');
await s.command({id:'restart-claim',kind:'node.claim',args:{runId:'one-run',nodeId:'commit',expectedGeneration:1,expectedLeaseEpoch:0}});throw Error('unexpected dispatch')}
catch(e){if(e.code!=='TASK_RUN_SCOPE_REARM_REQUIRED')throw e;process.stdout.write(e.code)}finally{await s.close()}`
 const childScript=join(f.root,'restart.mjs');await writeFile(childScript,source)
 const result=spawnSync(process.execPath,[childScript],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/TASK_RUN_SCOPE_REARM_REQUIRED/)
 const s=await openExecutionStore({dbPath:f.dbPath,instanceId:f.instanceId});t.after(()=>s.close())
 await assert.rejects(s.command(cmd('message.node.claim',{runId:'late-unrelated'})),e=>e.code==='TASK_RUN_SCOPE_DISPATCH_DENIED')
 await assert.rejects(s.command(cmd('task.plan.extend',{taskId:'one'})),e=>e.code==='TASK_RUN_SCOPE_DISPATCH_DENIED')
 const m=await s.query({kind:'runtime.maintenance'});await s.command(cmd('runtime.maintenance.change',{active:true,expectedRevision:m.revision,maintenanceId:'stop-scoped',actorId:'actor',reason:'end limited permit'}))
 await assert.rejects(s.command(cmd('node.claim',{runId:'one-run',nodeId:'commit',expectedGeneration:1,expectedLeaseEpoch:0})),e=>e.code==='RUNTIME_MAINTENANCE_ACTIVE')
})
test('scoped PR executes --draft and verifies real adapter readback; non-draft receipt is refused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'scope-draft-pr-')),script=join(root,'gh.cjs'),state=join(root,'state.json'),sha='a'.repeat(40)
 await writeFile(state,JSON.stringify({sha,creates:0}))
 await writeFile(script,`const fs=require('node:fs');const[file,...a]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file)),v=k=>a[a.indexOf(k)+1];
if(a[0]==='api'&&a.includes('--paginate'))console.log(JSON.stringify([s.pr?[{number:1,html_url:s.pr.url,state:'open',head:{sha:s.sha,ref:s.pr.headRefName},base:{ref:s.pr.baseRefName},body:s.pr.body,draft:s.pr.isDraft}]:[]]));
else if(a[0]==='api')console.log(JSON.stringify({object:{sha:s.sha}}));
else if(a[1]==='view')console.log(JSON.stringify(s.pr));
else if(a[1]==='create'){s.creates++;s.args=a;s.pr={number:1,url:'https://github.com/owner/repo/pull/1',state:'OPEN',headRefOid:s.sha,headRefName:v('--head'),baseRefName:v('--base'),body:fs.readFileSync(v('--body-file'),'utf8'),isDraft:a.includes('--draft')};fs.writeFileSync(file,JSON.stringify(s));console.log(s.pr.url)}else process.exit(2);`)
 const adapter=createGithubPullRequests({repository:root,repo:'owner/repo',head:'codex/one',base:'feature/uat3-base',ghCommand:{executable:process.execPath,args:[script,state]}})
 const p=adapter.prepare({runId:'one-run',generation:1,requirementDigest:d,commitId:sha,title:'review',body:'review'})
 assert.equal((await adapter.execute(p,{requireDraft:true})).status,'succeeded');let saved=JSON.parse(await readFile(state,'utf8'));assert.ok(saved.args.includes('--draft'));assert.equal(saved.creates,1)
 assert.equal((await adapter.execute(p,{requireDraft:true})).status,'succeeded');saved=JSON.parse(await readFile(state,'utf8'));assert.equal(saved.creates,1)
 saved.pr.isDraft=false;await writeFile(state,JSON.stringify(saved));await assert.rejects(adapter.reconcile(p,{requireDraft:true}),e=>e.code==='PR_DRAFT_REQUIRED')
})

test('real worker refuses an unauthorized effect prepared before scope activation and an atomic stop beats later claim',async t=>{
 const f=await fixture(t);await f.store.close();const db=new DatabaseSync(f.dbPath),now=new Date().toISOString(),n=db.prepare("SELECT node_run_id FROM execution_nodes WHERE run_id='one-run'").get()
 db.prepare(`INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('old-deploy','operation','one-run',?,'commit',1,?,?,?,'[]','old-grant','prepared',?,?)`).run(n.node_run_id,d,d,JSON.stringify({action:'deploy',payload:{taskId:'one'}}),now,now)
 db.close();const s=await openExecutionStore({dbPath:f.dbPath,instanceId:f.instanceId});t.after(()=>s.close())
 await assert.rejects(s.command(cmd('effect.begin',{effectId:'old-deploy',leaseEpoch:1,expectedSafetyEpoch:0})),e=>e.code==='TASK_RUN_SCOPE_EFFECT_DENIED')
 const m=await s.query({kind:'runtime.maintenance'})
 const results=await Promise.allSettled([s.command(cmd('runtime.maintenance.change',{active:true,expectedRevision:m.revision,maintenanceId:'close-scope',actorId:'actor',reason:'operator stop'})),s.command(cmd('node.claim',{runId:'one-run',nodeId:'commit',expectedGeneration:1,expectedLeaseEpoch:0}))])
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'RUNTIME_MAINTENANCE_ACTIVE')
 assert.equal((await s.query({kind:'runtime.maintenance'})).taskRunScope,undefined)
})

test('retired HTTP task-run denies all inputs; historical store retains atomic scoped grant and CAS',async t=>{
 const f=await fixture(t,false)
 let calls=0
 const grant=async request=>{const {requestId,...a}=request;const receipt=await f.store.command({id:'http:'+requestId,kind:'runtime.maintenance.task-run',args:{...a,actorId:'actor'}});return {receipt,state:await f.store.query({kind:'runtime.maintenance'})}}
 const runtime={getWorkflowMaintenance:()=>f.store.query({kind:'runtime.maintenance'}),runScopedWorkflowTask:async()=>{calls++;assert.fail('retired scoped grant')}}
 const server=createServer((req,res)=>handleRequest(req,res,runtime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const {actorId,...a}=f.args,body={...a,requestId:'approved-scope'},url=`http://127.0.0.1:${server.address().port}/runtime/maintenance/task-run`
 const post=(b,origin='http://127.0.0.1:3080')=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(b)})
 assert.equal((await post(body,'https://evil.invalid')).status,410)
 assert.equal((await post({...body,actorId:'spoof'})).status,410)
 assert.equal((await post({...body,allowedEffects:['deploy']})).status,410)
 assert.equal((await post({...body,allTasks:true})).status,410)
 assert.equal((await post(body)).status,410);assert.equal(calls,0);const granted=await grant(body);assert.equal(granted.state.taskRunScope.taskId,'one');assert.equal(granted.state.taskRunPermitted,true);assert.equal(granted.state.dispatchRestricted,true)
 assert.equal((await post(body)).status,410)
 assert.equal((await grant(body)).state.taskRunScope.taskId,'one')
 assert.equal((await post({...body,requestId:'stale-scope'})).status,410)
 await assert.rejects(grant({...body,requestId:'stale-scope'}),/STALE|CONFLICT/)
 assert.equal(calls,0)
})

test('completed original run binds only Owner/progress and denies every execution or unrelated dispatch',async t=>{
 const f=await fixture(t,false);await f.store.close();const db=new DatabaseSync(f.dbPath)
 db.prepare("UPDATE task_controls SET state='active' WHERE task_id='one'").run()
 db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='one'").run()
 db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref='sha256/final.json' WHERE task_id='one'").run()
 db.prepare("UPDATE execution_runs SET status='succeeded' WHERE run_id='one-run'").run()
 db.prepare("UPDATE execution_nodes SET status='succeeded',output_ref='sha256/final.json',drained=1 WHERE run_id='one-run'").run()
 const args={...f.args,allowedEffects:['progress']}
 assert.throws(()=>createTaskRunScope(db,{...args,allowedEffects:['progress','commit']},'new-host'),/TASK_RUN_SCOPE_STALE/)
 assert.throws(()=>createTaskRunScope(db,{...args,groupId:'foreign'},'new-host'),/TASK_RUN_SCOPE_GROUP_UNPROVEN/)
 const scope=createTaskRunScope(db,args,'new-host');assert.deepEqual(scope.allowedEffects,['progress']);assert.deepEqual(scope.nodeIds,[])
 assert.doesNotThrow(()=>assertTaskRunScope(db,cmd('task.owner.claim',{taskId:'one'}),scope,'new-host'))
 for(const command of [
  cmd('node.claim',{runId:'one-run',nodeId:'commit'}),cmd('task.owner.claim',{taskId:'two'}),cmd('task.owner.retry',{taskId:'two'}),
  cmd('message.coordinator.claim',{}),cmd('message.command.claim',{}),cmd('message.notification.claim',{notificationId:'none'}),cmd('run.create',{taskId:'one'}),
  cmd('effect.begin',{effectId:'none'}),cmd('effect.rearmUnsent',{effectId:'none'}),cmd('run.recovery.admit',{runId:'one-run'}),cmd('run.workflow.checkpoint',{runId:'one-run'}),cmd('task.control.resume',{taskId:'one'}),
  cmd('task.plan.extend',{taskId:'one'}),cmd('effect.prepare',{runId:'one-run',nodeId:'commit',definition:{action:'commit',payload:{remote:scope.remote,ref:'refs/heads/'+scope.head}}}),
 ])assert.throws(()=>assertTaskRunScope(db,command,scope,'new-host'),/TASK_RUN_SCOPE_DISPATCH_DENIED|TASK_RUN_SCOPE_EFFECT_DENIED/)
 assert.throws(()=>assertTaskRunScope(db,cmd('task.owner.claim',{taskId:'one'}),scope,'another-host'),/TASK_RUN_SCOPE_REARM_REQUIRED/)
 db.close()
 const reopened=await openExecutionStore({dbPath:f.dbPath,instanceId:f.instanceId});t.after(()=>reopened.close())
 const grant=(await reopened.command(cmd('runtime.maintenance.task-run',args))).result
 assert.deepEqual(grant.taskRunScope.nodeIds,[]);assert.deepEqual(grant.taskRunScope.allowedEffects,['progress'])
 await assert.rejects(reopened.command(cmd('node.claim',{runId:'one-run',nodeId:'commit',expectedGeneration:1,expectedLeaseEpoch:0})),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
 await assert.rejects(reopened.command(cmd('task.owner.claim',{taskId:'two',turnId:'other',expectedLeaseEpoch:0})),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
 await reopened.command(cmd('task.owner.init',{taskId:'one',sessionId:'owner-one',criteria:['fixture original delivery'],sourceKey:'source'}))
 await reopened.command(cmd('task.owner.event',{taskId:'one',eventKey:'fixture-success',eventType:'workflow.succeeded'}))
 const claim=(await reopened.command(cmd('task.owner.claim',{taskId:'one',turnId:'original-owner',expectedLeaseEpoch:0}))).result
 assert.equal(claim.turnId,'original-owner');assert.equal((await reopened.query({kind:'run',runId:'one-run'})).run.status,'succeeded')
 const failure="Cannot read properties of undefined (reading 'id')"
 await reopened.command(cmd('task.owner.release',{taskId:'one',turnId:'original-owner',leaseEpoch:1,reason:failure}))
 const before=await reopened.query({kind:'task.owner',taskId:'one'})
 const retry={taskId:'one',eventKey:'original-recovery',payloadRef:'sha256/recovery.json',expectedOwnerRevision:before.revision,expectedLeaseEpoch:before.leaseEpoch,expectedRequirementRevision:1,expectedControlRevision:1,expectedLastFailure:failure}
 await assert.rejects(reopened.command(cmd('task.owner.retry',{...retry,expectedOwnerRevision:before.revision-1})),/TASK_OWNER_RETRY_STALE/)
 const scoped=await reopened.query({kind:'runtime.maintenance'})
 await reopened.command(cmd('runtime.maintenance.change',{active:true,expectedRevision:scoped.revision,maintenanceId:'retry-held',actorId:'actor',reason:'fixture verify no scope retry'}))
 await assert.rejects(reopened.command(cmd('task.owner.retry',retry)),/TASK_OWNER_RETRY_FORBIDDEN/)
 const held=await reopened.query({kind:'runtime.maintenance'})
 await reopened.command(cmd('runtime.maintenance.task-run',{...args,expectedRevision:held.revision,maintenanceId:held.maintenanceId}))
 const recovered=(await reopened.command(cmd('task.owner.retry',retry))).result
 assert.equal(recovered.status,'pending')
 const after=await reopened.query({kind:'task.owner',taskId:'one'})
 assert.equal(after.sessionId,before.sessionId);assert.equal(after.processedWatermark,before.processedWatermark)
 assert.equal((await reopened.query({kind:'run',runId:'one-run'})).run.status,'succeeded')
 const next=(await reopened.command(cmd('task.owner.claim',{taskId:'one',turnId:'completion-retry',expectedLeaseEpoch:1}))).result
 assert.equal(next.turnId,'completion-retry')
 await reopened.command(cmd('task.owner.sessionBound',{taskId:'one',turnId:'completion-retry',leaseEpoch:2,sessionId:'owner-one'}))
 const wait={action:'wait',summary:'fixture old approval wait',evidenceRefs:[],condition:{kind:'approval',missing:'fixture approval',responsibleParty:'fixture owner',resumeWhen:'fixture review',evidenceRefs:[]}}
 await reopened.command(cmd('task.owner.candidate',{taskId:'one',turnId:'completion-retry',leaseEpoch:2,decision:wait}))
 await reopened.command(cmd('task.owner.accept',{taskId:'one',turnId:'completion-retry',leaseEpoch:2}))
 await reopened.command(cmd('task.owner.applied',{taskId:'one',turnId:'completion-retry',leaseEpoch:2}))
 const waiting=await reopened.query({kind:'task.owner',taskId:'one'})
 assert.equal(waiting.status,'idle');assert.equal(waiting.lastFailure,null);assert.equal(waiting.processedWatermark,waiting.eventWatermark)
 const review={...retry,eventKey:'reevaluate-existing-maintenance',expectedOwnerRevision:waiting.revision,expectedLeaseEpoch:waiting.leaseEpoch,expectedLastFailure:null}
 const current=await reopened.query({kind:'runtime.maintenance'})
 await reopened.command(cmd('runtime.maintenance.change',{active:true,expectedRevision:current.revision,maintenanceId:'wait-held',actorId:'actor',reason:'fixture wait scope restriction'}))
 await assert.rejects(reopened.command(cmd('task.owner.retry',review)),/TASK_OWNER_RETRY_FORBIDDEN/)
 const waitHeld=await reopened.query({kind:'runtime.maintenance'})
 await reopened.command(cmd('runtime.maintenance.task-run',{...args,expectedRevision:waitHeld.revision,maintenanceId:waitHeld.maintenanceId}))
 await assert.rejects(reopened.command(cmd('task.owner.retry',{...review,expectedLastFailure:'TASK_OWNER_NO_DECISION'})),/TASK_OWNER_RETRY_STALE/)
 assert.equal((await reopened.command(cmd('task.owner.retry',review))).result.status,'pending')
 const reviewed=await reopened.query({kind:'task.owner',taskId:'one'})
 assert.equal(reviewed.sessionId,waiting.sessionId);assert.equal(reviewed.processedWatermark,waiting.processedWatermark)
 assert.deepEqual((await reopened.query({kind:'task.owner',taskId:'one'})).decision,wait)
 assert.equal((await reopened.query({kind:'run',runId:'one-run'})).run.status,'succeeded')

});

test('retired HTTP owner retry rejects exact failure, null failure and forged identity without runtime calls',async t=>{
 const calls=[]
 const server=createServer((req,res)=>handleRequest(req,res,{retryWorkflowOwner:async args=>{calls.push(args);return {schemaTestOnly:true}}}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const url=`http://127.0.0.1:${server.address().port}/tasks/one/retry-owner`,failure="Cannot read properties of undefined (reading 'id')"
 const body={retryKey:'original-recovery',reason:'recover exact definition',expectedOwnerRevision:220,expectedLeaseEpoch:70,expectedRequirementRevision:2,expectedControlRevision:50,expectedLastFailure:failure}
 const send=(value,origin='http://127.0.0.1:3080')=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)})
 assert.equal((await send(body,'https://foreign.invalid')).status,410);assert.equal((await send({...body,actorId:'forged'})).status,410)
 assert.equal((await send(body)).status,410);assert.equal((await send({...body,expectedLastFailure:null})).status,410);assert.equal(calls.length,0)
})

test('Owner binding block recovers once only for successful scoped child receipts',async t=>{
 const f=await fixture(t,false,true);await f.store.close();const db=new DatabaseSync(f.dbPath)
 db.prepare("UPDATE task_controls SET state='active' WHERE task_id='one'").run();db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='one'").run()
 db.prepare("UPDATE task_plan_stages SET status='succeeded',output_ref='sha256/final.json' WHERE task_id='one'").run();db.prepare("UPDATE execution_runs SET status='succeeded' WHERE run_id='one-run'").run()
 db.prepare("UPDATE execution_nodes SET status='succeeded',output_ref=CASE WHEN node_id='prepare' THEN 'sha256/child.json' ELSE 'sha256/final.json' END,drained=1 WHERE run_id='one-run'").run();db.close()
 const store=await openExecutionStore({dbPath:f.dbPath,instanceId:f.instanceId});t.after(()=>store.close());const args={...f.args,allowedEffects:['progress']};await store.command(cmd('runtime.maintenance.task-run',args))
 await store.command(cmd('task.owner.init',{taskId:'one',sessionId:'owner-one',criteria:['actual fixture delivery'],sourceKey:'source'}))
 const block=async(key,ref)=>{await store.command(cmd('task.owner.event',{taskId:'one',eventKey:key,eventType:'system.recovery'}));const o=await store.query({kind:'task.owner',taskId:'one'});const c=(await store.command(cmd('task.owner.claim',{taskId:'one',turnId:key,expectedLeaseEpoch:o.leaseEpoch}))).result;await store.command(cmd('task.owner.sessionBound',{taskId:'one',turnId:key,leaseEpoch:c.leaseEpoch,sessionId:'owner-one'}));const decision={action:'block',summary:'fixture receipt binding failed',evidenceRefs:[ref],condition:{kind:'execution',missing:'receipt binding',responsibleParty:'Host',resumeWhen:'correct reference',evidenceRefs:[ref]}};await store.command(cmd('task.owner.candidate',{taskId:'one',turnId:key,leaseEpoch:c.leaseEpoch,decision}));await store.command(cmd('task.owner.accept',{taskId:'one',turnId:key,leaseEpoch:c.leaseEpoch}));await store.command(cmd('task.owner.applied',{taskId:'one',turnId:key,leaseEpoch:c.leaseEpoch}));return store.query({kind:'task.owner',taskId:'one'})}
 const retry=o=>({taskId:'one',eventKey:'recover-binding-'+o.leaseEpoch,payloadRef:'sha256/recovery.json',expectedOwnerRevision:o.revision,expectedLeaseEpoch:o.leaseEpoch,expectedRequirementRevision:1,expectedControlRevision:1,expectedLastFailure:null})
 const foreign=await block('foreign-block','sha256/foreign.json');await assert.rejects(store.command(cmd('task.owner.retry',retry(foreign))),/TASK_OWNER_RETRY_FORBIDDEN/)
 const original=await block('binding-block','sha256/child.json'),before=original.processedWatermark
 const recovered=(await store.command(cmd('task.owner.retry',retry(original)))).result;assert.equal(recovered.status,'pending');assert.equal(recovered.bindingRecovery.runId,'one-run');assert.equal(recovered.bindingRecovery.turnId,'binding-block')
 const after=await store.query({kind:'task.owner',taskId:'one'});assert.equal(after.sessionId,original.sessionId);assert.equal(after.processedWatermark,before);assert.deepEqual(after.decision,original.decision)
 const again=await block('binding-block-again','sha256/child.json');await assert.rejects(store.command(cmd('task.owner.retry',retry(again))),/TASK_OWNER_RETRY_FORBIDDEN/)
 assert.equal((await store.query({kind:'run',runId:'one-run'})).run.status,'succeeded')
 await assert.rejects(store.command(cmd('node.claim',{runId:'one-run',nodeId:'prepare',expectedGeneration:1,expectedLeaseEpoch:0})),/TASK_RUN_SCOPE_DISPATCH_DENIED/)
})
