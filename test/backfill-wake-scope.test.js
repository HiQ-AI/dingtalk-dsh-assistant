import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js';
import {createMessageWorkflow} from '../packages/dingtalk-dsh-assistant/message-workflow.js';
import {createMessageCoordinator} from '../packages/dingtalk-dsh-assistant/message-coordinator.js';
import {startDwsBridge} from '../packages/dingtalk-dsh-assistant/dws-bridge.js';

async function fixture(t,{command=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'backfill-wake-native-'));
 const options={dbPath:join(root,'control.sqlite'),instanceId:randomUUID()};
 const store=await openExecutionStore({...options,initialize:true});let sessions=0,answers=0;
 const call=(kind,args)=>store.command({id:randomUUID(),kind,args});
 const coordinator=createMessageCoordinator({store,context:{candidates:async()=>({cards:[]}),facts:async()=>({}),agentNames:()=>[],groups:async()=>['g']},modelConfig:async()=>({provider:'fixture',model:'fixture'}),sessionRunner:{async run({input,onCandidate}){sessions++;await onCandidate({decisions:input.sources.map(s=>({runId:s.runId,reason:'fixture receipt only',units:[]}))});return {status:'submitted'}},async close(){}}});
 const workflow=createMessageWorkflow({store,coordinator,handlers:{answer:async()=>{answers++;return {reply:'fixture applied'}}}});
 t.after(async()=>{await workflow.close();await store.close();const checked=resolve(root);assert.equal(dirname(checked),resolve(tmpdir()));await rm(checked,{recursive:true,force:true})});
 await workflow.receive({runId:'source',sourceKey:'source',sourceVersion:1,conversationId:'g',actorId:'a',body:'clarify fixture'},{process:false});
 if(command){await call('message.split',{runId:'source',units:[{unitId:'u',goalText:'fixture action',contextNeeds:[]}]});await call('message.accept',{runId:'source',unitId:'u',commands:[{commandId:'action',kind:'answer',args:{}}]});}
 await call('message.wait',{runId:'source',...(command?{unitId:'u'}:{}),nodeId:command?'execute':'coordinator',request:{requestId:'q',kind:'needs_clarification',question:'which?',permittedActors:['a']}});
 // Test fixture injects only the already-validated restricted state into its private ledger.
 // It exercises production assertTaskRunScope, not production scope creation/arming.
 async function scope(){const runtime=await store.query({kind:'runtime.maintenance'});const db=new DatabaseSync(options.dbPath);try{db.prepare('INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES(?,?,?,?)').run('fixture-scope','runtime.maintenance.changed',JSON.stringify({active:false,phase:'task-scoped',revision:1,maintenanceId:'fixture',actorId:'fixture',taskRunScope:{taskId:'allowed-task',runId:'allowed-run',allowedEffects:['edit'],processIncarnation:runtime.processIncarnation,nodeIds:[]}}),new Date().toISOString())}finally{db.close()}}
 async function release(){await call('runtime.maintenance.change',{expectedRevision:1,maintenanceId:'fixture',actorId:'fixture',reason:'fixture release',active:true});await call('runtime.maintenance.change',{expectedRevision:2,maintenanceId:'fixture',actorId:'fixture',reason:'fixture release',active:false});}
 function sql(fn){const db=new DatabaseSync(options.dbPath);try{return fn(db)}finally{db.close()}}
 return {root,store,workflow,scope,release,sql,get sessions(){return sessions},get answers(){return answers}};
}
const answer={runId:'source',requestId:'q',actorId:'a',eventId:'answer',answer:'fixture resolved'};
async function bridge(t,f,{failure=false}={}) {
 const snapshots=[],warnings=[],received=[];const group={groupId:'g',messages:[]};let completed;
 const done=new Promise(resolve=>{completed=resolve});
 const runtime={listGroups:()=>[group],getGroup:()=>group,isWorkflowGroup:()=>true,onGroupSubscribed:()=>()=>{},onOutboxAppended:()=>()=>{},async ingest(m){received.push(m.messageId);if(m.messageId==='answer')return f.workflow.resume(answer);return f.workflow.receive({runId:'next',sourceKey:'next',sourceVersion:1,conversationId:'g',actorId:'a',body:m.text},{process:false})}};
 const adapter={startGroupSubscription(){const lifecycle=new EventEmitter();let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve});setImmediate(()=>lifecycle.emit('ready'));return {lifecycle,stop(){resolveDone()},done}},async readGroupRange(){return {complete:true,messages:[{messageId:'answer',text:'resolved',senderId:'a',createTime:'2026-10-10T00:00:00Z'},{messageId:'next',text:'next receipt',senderId:'a',createTime:'2026-10-10T00:00:01Z'}]}}};
 const stop=startDwsBridge({runtime,adapter,logger:{warn(e){warnings.push(e)}},groupBackfillIntervalMs:0,humanPollIntervalMs:0,outboxRetryIntervalMs:0,onHealthChange(s){snapshots.push(s);if(['ok','failed'].includes(s.groups[0]?.backfill.state))completed()}});
 t.after(stop);await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture backfill timeout')),5000);timer.unref()})]);
 await stop();return {snapshots,warnings,received};
}
test('real wake receipt replay never reacquires coordinator under scope',async t=>{
 const f=await fixture(t);await f.workflow.resume(answer);assert.equal(f.sessions,1);
 await f.scope();const oldClaims=f.sql(db=>db.prepare("SELECT count(*) n FROM execution_events WHERE kind='message.coordinator.claim'").get().n);
 await f.workflow.resume(answer);await f.workflow.resume(answer);
 assert.equal(f.sessions,1);assert.equal(f.sql(db=>db.prepare("SELECT count(*) n FROM execution_events WHERE kind='message.coordinator.claim'").get().n),oldClaims);
 assert.equal(f.sql(db=>db.prepare("SELECT count(*) n FROM execution_events WHERE kind='message.wake'").get().n),1);
});
test('scope deferred durable answer permits following backfill receipt; recovery once after release',async t=>{
 const f=await fixture(t);await f.scope();const r=await f.workflow.resume(answer);
 assert.equal(r.processing,'deferred');assert.equal(r.dispatchDeferred.commandKind,'message.coordinator.claim');
 assert.equal((await f.workflow.state('source')).requests[0].status,'resolved');assert.equal(f.sessions,0);
 const b=await bridge(t,f);assert.deepEqual(b.received,['answer','next']);assert.equal(b.snapshots.at(-1).groups[0].backfill.state,'ok');
 assert.ok(await f.store.query({kind:'message.source',sourceKey:'next'}));
 await f.release();await f.workflow.recover();const count=f.sessions;assert.equal(count,1);await f.workflow.recover();assert.equal(f.sessions,count);
 assert.equal((await f.workflow.state('source')).run.status,'settled');assert.equal((await f.workflow.state('next')).run.status,'settled');
});
test('real command dispatch stays denied, then original handler executes exactly once after release',async t=>{
 const f=await fixture(t,{command:true});await f.scope();const r=await f.workflow.resume(answer);
 assert.equal(r.processing,'deferred');assert.equal(r.dispatchDeferred.commandKind,'message.command.claim');assert.equal(f.answers,0);
 assert.equal((await f.workflow.state('source')).commands[0].status,'pending');
 await f.release();await f.workflow.recover();assert.equal(f.answers,1);await f.workflow.recover();await f.workflow.resume(answer);assert.equal(f.answers,1);
 assert.equal((await f.workflow.state('source')).commands[0].status,'applied');
});
test('real sqlite receipt failure rolls back answer and retains failed backfill gap with diagnostics',async t=>{
 const f=await fixture(t);f.sql(db=>db.exec("CREATE TRIGGER fixture_fail_receipt BEFORE INSERT ON execution_receipts BEGIN SELECT RAISE(ABORT, 'fixture_storage_write_denied'); END"));
 const b=await bridge(t,f);assert.deepEqual(b.received,['answer']);const h=b.snapshots.at(-1);assert.equal(h.healthy,false);assert.equal(h.groups[0].backfill.state,'failed');assert.equal(h.groups[0].backfill.lastErrorMessageId,'answer');assert.equal(h.groups[0].backfill.lastErrorCommandKind,'message.wake');assert.equal(b.warnings.length,1);
 await assert.rejects(f.store.query({kind:'message.pending'}),{code:'STORE_UNAVAILABLE'});await f.store.close();
 assert.equal(f.sql(db=>JSON.parse(db.prepare("SELECT body FROM message_items WHERE item_id='request:q'").get().body).status),'pending');
 assert.equal(f.sql(db=>db.prepare("SELECT count(*) n FROM message_runs WHERE source_key='next'").get().n),0);
 assert.equal(f.sql(db=>db.prepare("SELECT count(*) n FROM execution_receipts WHERE command_id='wake:answer'").get().n),0);
});
