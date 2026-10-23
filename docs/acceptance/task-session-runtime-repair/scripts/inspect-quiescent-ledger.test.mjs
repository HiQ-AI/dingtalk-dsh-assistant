import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, mkdir, writeFile, readFile, copyFile, link, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectLedger } from './inspect-quiescent-ledger.mjs'
import { openDynamicTaskStore } from '../../../../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

test('offline deployment refuses a live owner and unfinished rounds, accepts retained dead-owner metadata without changing unknown facts', async t => {
 const root=await mkdtemp(join(tmpdir(),'task-deploy-proof-')),path=join(root,'ledger.sqlite')
 const db=new DatabaseSync(path)
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','groups','operations','notifications'])db.exec(`CREATE TABLE dynamic_${name}(body TEXT)`)
 db.prepare('INSERT INTO dynamic_meta VALUES (?,?)').run('owner',`${process.pid}:live`)
 db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({state:'unknown'}))
 assert.throws(()=>inspectLedger(path,root,true,process.pid),/DEPLOY_OWNER_NOT_RELEASED/)
 const child=spawnSync(process.execPath,['-e',''],{windowsHide:true})
 assert.equal(child.status,0)
 db.prepare('UPDATE dynamic_meta SET value=? WHERE key=?').run(`${child.pid}:stale`,'owner')
 const proof=inspectLedger(path,root,true,child.pid)
 assert.equal(proof.ownerReleased,false);assert.equal(proof.ownerProcessExited,true);assert.equal(proof.staleOwner,true)
 assert.equal(proof.unknownOperations,1)
 assert.equal(db.prepare('SELECT value FROM dynamic_meta WHERE key=?').get('owner').value,`${child.pid}:stale`)
 assert.equal(JSON.parse(db.prepare('SELECT body FROM dynamic_operations').get().body).state,'unknown')
 db.prepare('INSERT INTO dynamic_tasks VALUES (?)').run(JSON.stringify({taskId:'busy',drained:false}))
 assert.throws(()=>inspectLedger(path,root,true,child.pid),/DEPLOY_NOT_DRAINED/)
})

async function unstartedFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'task-unstarted-proof-')),path=join(root,'ledger.sqlite'),db=new DatabaseSync(path)
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','groups','operations','notifications'])db.exec(`CREATE TABLE dynamic_${name}(body TEXT)`)
 const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0)
 db.prepare('INSERT INTO dynamic_meta VALUES (?,?)').run('owner',`${child.pid}:retained`)
 const task={taskId:'task-a',sessionId:'owner-a',sessionBound:true,drained:false,leaseEpoch:29,requirementRevision:1,controlRevision:1}
 db.prepare('INSERT INTO dynamic_tasks VALUES (?)').run(JSON.stringify(task))
 db.prepare('INSERT INTO dynamic_executions VALUES (?)').run(JSON.stringify({taskId:'task-a',drained:true,status:'succeeded'}))
 db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({state:'unknown'}))
 const directory=join(root,'tasks','task-a','.dsh','sessions','owner-a');await mkdir(directory,{recursive:true})
 const log=join(directory,'session.v4.jsonl')
 const events=[{type:'session',id:'owner-a'},{type:'plugin:dingtalk/task-session',seq:0,data:{taskId:'task-a',sessionId:'owner-a'}},
 {type:'user/message',seq:1,data:{source:{taskSession:{taskId:'task-a',sessionId:'owner-a',leaseEpoch:28}}}},
 {type:'turn/start',seq:2},{type:'turn/end',seq:3},{type:'session/end-seed',seq:4}]
 const save=()=>writeFile(log,events.map(JSON.stringify).join('\n'))
 await save()
 return {root,path,db,pid:child.pid,task,events,save,log}
}

test('a provably unstarted task claim is quiescent but remains undrained and unchanged; offline requires exact dead owner',async t=>{
 const f=await unstartedFixture(t),before=f.db.prepare('SELECT body FROM dynamic_tasks').get().body
 const online=inspectLedger(f.path,f.root)
 assert.equal(online.candidateOnly,true);assert.equal(online.quiescent,true);assert.equal(online.drained,false)
 assert.deepEqual(online.unstartedTaskClaims[0],{taskId:'task-a',sessionId:'owner-a',leaseEpoch:29,requirementRevision:1,controlRevision:1,previousInputLeaseEpoch:28,previousTurnEndSequence:3,lastNativeSequence:4,currentLeaseInputAbsent:true})
 assert.throws(()=>inspectLedger(f.path,f.root,true),/EXPECTED_OWNER_PID_REQUIRED/)
 assert.throws(()=>inspectLedger(f.path,f.root,true,process.pid),/OWNER_NOT_RELEASED/)
 const proof=inspectLedger(f.path,f.root,true,f.pid)
 assert.equal(proof.candidateOnly,false);assert.equal(proof.ownerProcessExited,true);assert.equal(proof.unknownOperations,1)
 assert.equal(f.db.prepare('SELECT body FROM dynamic_tasks').get().body,before)
})

for(const invalid of ['current-user','current-inbox','unfinished-turn','unfinished-tool','previous-not-ended','busy-execution','busy-group','starting-operation','starting-notification'])test(`unstarted claim exception rejects ${invalid}`,async t=>{
 const f=await unstartedFixture(t)
 if(invalid==='current-user')f.events.push({type:'user/message',seq:5,data:{source:{taskSession:{sessionId:'owner-a',leaseEpoch:29}}}})
 if(invalid==='current-inbox')f.events.push({type:'agent/inbox/spliced',seq:5,data:{inserted:[{source:{taskSession:{sessionId:'owner-a',leaseEpoch:29}}}]}})
 if(invalid==='unfinished-turn')f.events.push({type:'turn/start',seq:5})
 if(invalid==='unfinished-tool')f.events.splice(4,0,{type:'tool/call',seq:2.5,data:{callId:'unfinished'}})
 if(invalid==='previous-not-ended')f.events.push({type:'user/message',seq:5,data:{source:{taskSession:{sessionId:'owner-a',leaseEpoch:28}}}})
 if(invalid==='busy-execution')f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify({drained:false}))
 if(invalid==='busy-group')f.db.prepare('INSERT INTO dynamic_groups VALUES (?)').run(JSON.stringify({drained:false}))
 if(invalid==='starting-operation')f.db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({state:'starting'}))
 if(invalid==='starting-notification')f.db.prepare('INSERT INTO dynamic_notifications VALUES (?)').run(JSON.stringify({state:'starting'}))
 await f.save()
 assert.throws(()=>inspectLedger(f.path,f.root,true,f.pid))
})

async function cliFixture(t) {
 const root=await mkdtemp(join(tmpdir(),'task-cli-deploy-')),path=join(root,'ledger.sqlite'),db=new DatabaseSync(path)
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','groups','operations','notifications'])db.exec(`CREATE TABLE dynamic_${name}(body TEXT)`)
 const uuid='0a123456-1234-4234-8234-123456789abc'
 const prior={inputVersion:1,inputDigest:'a'.repeat(64),requirementRevision:1,controlRevision:1}
 const row={taskId:'task-cli',executionId:'execution-cli',sessionId:`task-execution-${uuid}`,definition:{executionBackend:'claude-code'},
  status:'succeeded',drained:true,sessionBound:true,inputVersion:2,inputDigest:'b'.repeat(64),requirementRevision:2,controlRevision:1,leaseEpoch:3,inputHistory:[prior]}
 const native={taskId:'task-native',executionId:'execution-native',sessionId:'native-session',drained:true,sessionBound:true,status:'succeeded'}
 db.prepare('INSERT INTO dynamic_executions VALUES (?)').run(JSON.stringify(native))
 db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({operationId:'unknown-original',state:'unknown'}))
 const nativeDirectory=join(root,'tasks',native.taskId,'.dsh','sessions',native.sessionId)
 await mkdir(nativeDirectory,{recursive:true})
 await writeFile(join(nativeDirectory,'session.v4.jsonl'),[{type:'session',id:native.sessionId},{type:'turn/start',seq:0},{type:'turn/end',seq:1}].map(JSON.stringify).join('\n'))
 const directory=join(root,'tasks',row.taskId,'outputs',row.executionId),log=join(directory,'claude-events.jsonl')
 await mkdir(directory,{recursive:true})
 const binding={kind:'task-execution',taskId:row.taskId,executionId:row.executionId,sessionId:row.sessionId,
  inputVersion:row.inputVersion,inputDigest:row.inputDigest,requirementRevision:row.requirementRevision,controlRevision:row.controlRevision,leaseEpoch:row.leaseEpoch}
 const events=[]
 const add=(type,generation,data={})=>events.push({sequence:events.length+1,provider:'claude-code',binding:structuredClone(generation),type,data})
 const first={...binding,...prior,leaseEpoch:1}
 add('start',first,{providerSessionId:uuid,resumed:false});add('session.bound',first,{providerSessionId:uuid})
 add('tool.started',first,{callId:'unknown-tool',toolName:'Write'});add('tool.unknown',first,{callId:'unknown-tool'})
 add('drained',first);add('start',binding,{providerSessionId:uuid,resumed:true});add('session.bound',binding,{providerSessionId:uuid})
 add('cli',binding,{type:'result',session_id:uuid});add('drained',binding)
 const save=async()=>{db.prepare("DELETE FROM dynamic_executions WHERE json_extract(body,'$.executionId')='execution-cli'").run();db.prepare('INSERT INTO dynamic_executions VALUES (?)').run(JSON.stringify(row));await writeFile(log,events.map(JSON.stringify).join('\n')+'\n')}
 await save()
 return {root,path,db,row,events,log,directory,save}
}

test('interactive Claude mode is bound to every log generation; legacy history remains readable',async t=>{
 const f=await cliFixture(t)
 assert.equal(inspectLedger(f.path,f.root).drained,true)
 f.row.claudeSessionMode='interactive-team-v1'
 await f.save()
 assert.throws(()=>inspectLedger(f.path,f.root),/DEPLOY_CLAUDE_LOG_IDENTITY/)
 for(const event of f.events)event.binding.claudeSessionMode=f.row.claudeSessionMode
 await f.save()
 assert.equal(inspectLedger(f.path,f.root).drained,true)
 f.row.claudeSessionMode='unsupported'
 await f.save()
 assert.throws(()=>inspectLedger(f.path,f.root),/DEPLOY_CLAUDE_SESSION_MODE_INVALID/)
})

test('mixed native and Claude histories verify independently and keep unknown facts unchanged',async t=>{
 const f=await cliFixture(t),before=await readFile(f.log),beforeRows=f.db.prepare('SELECT body FROM dynamic_executions').all()
 const proof=inspectLedger(f.path,f.root)
 assert.equal(proof.quiescent,true);assert.equal(proof.drained,true);assert.equal(proof.verifiedSessions,2);assert.equal(proof.unknownOperations,1)
 assert.deepEqual(await readFile(f.log),before);assert.deepEqual(f.db.prepare('SELECT body FROM dynamic_executions').all(),beforeRows)
 assert.equal(JSON.parse(f.db.prepare('SELECT body FROM dynamic_operations').get().body).state,'unknown')
 // 运维助手会被原样复制到 launchers；独立副本不依赖仓库 adapter 或 node_modules。
 const standalone=join(f.root,'inspect-quiescent-ledger.mjs')
 await copyFile(new URL('./inspect-quiescent-ledger.mjs',import.meta.url),standalone)
 const result=spawnSync(process.execPath,[standalone,f.path,f.root],{encoding:'utf8',windowsHide:true})
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).verifiedSessions,2)
})

for(const invalid of ['missing-log','partial-json','bad-json','empty-log','sequence-gap','duplicate-sequence','provider','logical-session','provider-uuid','nested-session',
 'task-id','execution-id','input-digest','missing-history','duplicate-history','old-requirement','old-control','future-input','higher-lease','reused-lease','unfinished-prior',
 'unbound','not-drained','binding-current','binding-mid-round','unknown-backend','null-backend','path-escape'])test(`Claude deployment proof rejects ${invalid}`,async t=>{
 const f=await cliFixture(t)
 if(invalid==='sequence-gap')f.events[1].sequence++
 if(invalid==='duplicate-sequence')f.events[1].sequence=1
 if(invalid==='provider')f.events[1].provider='dsh'
 if(invalid==='logical-session')f.events[1].binding.sessionId='task-execution-ffffffff-ffff-ffff-ffff-ffffffffffff'
 if(invalid==='provider-uuid')f.events[0].data.providerSessionId='ffffffff-ffff-ffff-ffff-ffffffffffff'
 if(invalid==='nested-session')f.events.at(-2).data.session_id='ffffffff-ffff-ffff-ffff-ffffffffffff'
 if(invalid==='task-id')f.events[1].binding.taskId='another-task'
 if(invalid==='execution-id')f.events[1].binding.executionId='another-execution'
 if(invalid==='input-digest')f.events[0].binding.inputDigest='c'.repeat(64)
 if(invalid==='missing-history')f.row.inputHistory=[]
 if(invalid==='duplicate-history')f.row.inputHistory.push({...f.row.inputHistory[0]})
 if(invalid==='old-requirement')f.events[0].binding.requirementRevision++
 if(invalid==='old-control')f.events[0].binding.controlRevision++
 if(invalid==='future-input')f.events[0].binding.inputVersion=3
 if(invalid==='higher-lease')f.events[0].binding.leaseEpoch=4
 if(invalid==='reused-lease')for(const event of f.events.slice(5))event.binding.leaseEpoch=1
 if(invalid==='unfinished-prior')f.events[4].type='exit'
 if(invalid==='unbound')for(const event of f.events.filter(event=>event.type==='session.bound'))event.type='cli'
 if(invalid==='not-drained')f.events.at(-1).type='exit'
 if(invalid==='binding-current')f.row.leaseEpoch=4
 if(invalid==='binding-mid-round')f.events[1].binding.leaseEpoch=2
 if(invalid==='unknown-backend')f.row.definition.executionBackend='other'
 if(invalid==='null-backend')f.row.definition.executionBackend=null
 if(invalid==='path-escape')f.row.taskId='../escape'
 await f.save()
 if(invalid==='missing-log')await rm(f.log)
 if(invalid==='partial-json')await writeFile(f.log,'{"sequence":1')
 if(invalid==='bad-json')await writeFile(f.log,'not-json\n')
 if(invalid==='empty-log')await writeFile(f.log,'')
 assert.throws(()=>inspectLedger(f.path,f.root),/DEPLOY_|ENOENT/)
 assert.equal(JSON.parse(f.db.prepare('SELECT body FROM dynamic_operations').get().body).state,'unknown')
})

test('a queued adjacent Claude continuation uses the same drained lease without starting or rewriting it',async t=>{
 const f=await cliFixture(t)
 f.row.inputHistory.push({inputVersion:2,inputDigest:f.row.inputDigest,requirementRevision:2,controlRevision:1})
 Object.assign(f.row,{status:'queued',inputVersion:3,inputDigest:'c'.repeat(64),requirementRevision:3})
 await f.save();const before=await readFile(f.log)
 const proof=inspectLedger(f.path,f.root)
 assert.equal(proof.drained,true)
 assert.deepEqual(proof.unstartedCliExecutions,[{executionId:f.row.executionId,sessionId:f.row.sessionId,inputVersion:3,leaseEpoch:3,previousInputVersion:2,previousDrainedSequence:9,currentInputStartAbsent:true}])
 assert.deepEqual(await readFile(f.log),before)
})

for(const invalid of ['wrong-digest','missing-intermediate-history','new-lease','current-start','not-queued','cancelled-without-request','stale-without-request'])test(`queued Claude continuation rejects ${invalid}`,async t=>{
 const f=await cliFixture(t)
 f.row.inputHistory.push({inputVersion:2,inputDigest:f.row.inputDigest,requirementRevision:2,controlRevision:1})
 Object.assign(f.row,{status:'queued',inputVersion:3,inputDigest:'c'.repeat(64),requirementRevision:3})
 if(invalid==='wrong-digest')f.row.inputHistory[1].inputDigest='d'.repeat(64)
 if(invalid==='missing-intermediate-history')f.row.inputVersion=4
 if(invalid==='new-lease')f.row.leaseEpoch=4
 if(invalid==='current-start')f.events.push({...structuredClone(f.events[5]),sequence:10,binding:{...f.events[5].binding,inputVersion:3,inputDigest:f.row.inputDigest,requirementRevision:3}})
 if(invalid==='not-queued')f.row.status='succeeded'
 if(invalid==='cancelled-without-request')f.row.status='cancelled'
 if(invalid==='stale-without-request')f.row.status='stale'
 await f.save();assert.throws(()=>inspectLedger(f.path,f.root),/DEPLOY_CLAUDE_/)
})

for(const state of ['queued','cancelled','stale'])test(`real Store repeated unstarted Claude continuation preserves proof when ${state}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'store-cli-deploy-')),path=join(root,'ledger.sqlite')
 const store=await openDynamicTaskStore({dbPath:path,instanceId:'checker-contract',initialize:true})
 t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
 let sequence=0
 const command=(kind,args)=>store.command({id:`case-${++sequence}`,kind,args})
 const taskId='task.valid-id'
 await command('task.create',{taskId,request:'isolated deployment contract'})
 const owner=(await command('task.claim',{taskId})).result.binding
 const created=(await command('execution.dispatch',{binding:owner,key:'first',prompt:'first input',input:{value:1},definition:{executionBackend:'claude-code'}})).result.execution
 const binding=(await command('execution.claim',{executionId:created.executionId})).result.binding
 await command('execution.sessionBound',{binding})
 await command('execution.result',{binding,output:{status:'completed',summary:'synthetic proof',evidence:[],limitations:[],artifacts:[]}})
 await command('execution.drained',{binding})
 const uuid=binding.sessionId.slice('task-execution-'.length)
 const events=[{type:'start',data:{providerSessionId:uuid,resumed:false}},{type:'session.bound',data:{providerSessionId:uuid}},{type:'drained',data:{}}]
   .map((event,index)=>({...event,provider:'claude-code',sequence:index+1,binding}))
 const directory=join(root,'tasks',taskId,'outputs',created.executionId),log=join(directory,'claude-events.jsonl')
 await mkdir(directory,{recursive:true});await writeFile(log,events.map(JSON.stringify).join('\n')+'\n')
 for(const version of [2,3])await command('execution.continue',{binding:owner,executionId:created.executionId,key:`round-${version}`,prompt:`input ${version}`,input:{value:version}})
 if(state==='cancelled')await command('execution.cancel',{binding:owner,executionId:created.executionId})
 if(state==='stale')await command('task.revise',{taskId,request:'changed scope',expectedRequirementRevision:owner.requirementRevision})
 await command('task.drained',{binding:owner})
 const row=await store.query({kind:'execution.get',executionId:created.executionId})
 assert.equal(row.status,state);assert.equal(row.inputVersion,3);assert.equal(row.leaseEpoch,binding.leaseEpoch);assert.equal(row.drained,true)
 const before=await readFile(log),proof=inspectLedger(path,root)
 assert.equal(proof.drained,true);assert.equal(proof.unstartedCliExecutions[0].previousInputVersion,1);assert.equal(proof.unstartedCliExecutions[0].inputVersion,3)
 assert.deepEqual(await readFile(log),before)
})

for(const kind of ['hardlink','ancestor-link'])test(`Claude journal ${kind} is rejected without changing target bytes`,async t=>{
 const f=await cliFixture(t),before=await readFile(f.log)
 let target
 if(kind==='hardlink') {target=join(f.root,'original-journal');await rename(f.log,target);await link(target,f.log)}
 else {const source=join(f.root,'tasks',f.row.taskId),outside=join(f.root,'original-task');await rename(source,outside);await symlink(outside,source,process.platform==='win32'?'junction':'dir');target=join(outside,'outputs',f.row.executionId,'claude-events.jsonl')}
 assert.throws(()=>inspectLedger(f.path,f.root),/DEPLOY_CLAUDE_LOG_PATH_INVALID/)
 assert.deepEqual(await readFile(target),before)
})
