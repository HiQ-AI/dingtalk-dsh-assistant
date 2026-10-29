import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, mkdir, writeFile, readFile, copyFile, link, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectLedger, inspectCurrentControl } from './inspect-quiescent-ledger.mjs'
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

test('ordinary package control checks current ownership, drain and effects without historic logs', async t => {
 const { inspectCurrentControl } = await import('./inspect-quiescent-ledger.mjs')
 const { path, db } = await unstartedFixture(t)
 db.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(`${process.pid}:current`)
 for (const name of ['tasks','executions','groups']) db.exec(`DELETE FROM dynamic_${name}`)
 db.prepare('INSERT INTO dynamic_tasks VALUES (?)').run(JSON.stringify({taskId:'old',sessionBound:true,sessionId:'missing-history',drained:true}))
 assert.equal(inspectCurrentControl(path,'online',process.pid).scope,'current-control')
 assert.throws(()=>inspectCurrentControl(path,'offline',process.pid),/OWNER_NOT_RELEASED/)
 assert.throws(()=>inspectCurrentControl(path,'online',1),/OWNER_IDENTITY/)
 assert.throws(()=>inspectCurrentControl(path,'bad',process.pid),/MODE_INVALID/)
 for (const name of ['tasks','executions','groups']) {
  db.prepare(`INSERT INTO dynamic_${name} VALUES (?)`).run(JSON.stringify({drained:false}))
  assert.throws(()=>inspectCurrentControl(path,'online',process.pid),/NOT_DRAINED/)
  db.exec(`DELETE FROM dynamic_${name} WHERE json_extract(body,'$.drained')=0`)
 }
 for (const name of ['operations','notifications']) {
  db.prepare(`INSERT INTO dynamic_${name} VALUES (?)`).run(JSON.stringify({state:'starting'}))
  assert.throws(()=>inspectCurrentControl(path,'online',process.pid),/STARTING_EFFECT/)
  db.exec(`DELETE FROM dynamic_${name}`)
  db.prepare(`INSERT INTO dynamic_${name} VALUES (?)`).run(JSON.stringify({state:'unknown'}))
 }
 const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0)
 db.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(`${child.pid}:stale`)
 const proof=inspectCurrentControl(path,'offline',child.pid)
 assert.equal(proof.staleOwner,true);assert.equal(proof.unknownOperations,1);assert.equal(proof.unknownNotifications,1)
 assert.equal(db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get().value,`${child.pid}:stale`)
})

test('ordinary deployment selects current controls while maintenance retains historical audit and captured child identities', async () => {
 const source = await readFile(new URL('./deploy-task-session-native.ps1', import.meta.url), 'utf8')
 assert.match(source, /\$ledgerProof=if\(\$RestartMaintenanceProposal\).*\$agentWorkspace.*\$controlMode=if\(\$ResumeNativeDispose\)\{'offline'\}else\{'online'\};RunNode @\(\$ledger,'current-control',\$db,\$controlMode/)
 assert.match(source, /\$offlineArgs=if\(\$RestartMaintenanceProposal\).*\$agentWorkspace.*else\{@\(\$ledger,'current-control',\$db,'offline'/)
 assert.ok(source.indexOf('$originalDescendants=@(Descendants $original)') < source.indexOf('$signaler=Start-Process'))
 assert.match(source, /foreach\(\$child in \$originalDescendants\)/)
 assert.match(source, /TestCapturedProcess \$child \$remaining/)
 assert.equal((source.match(/@\(Descendants /g)??[]).length,1,'no ParentPID rediscovery after stopping')
})

test('resume validates original stop evidence, rejects mismatched package and live captured children', async t => {
 const root=await mkdtemp(join(tmpdir(),'deploy-resume-test-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const script=new URL('./deploy-task-session-native.ps1',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')
 const fixture=join(root,'check.ps1')
 await writeFile(fixture, `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($name in @('TextHash','TestCapturedProcess','AssertCapturedTree')){. ([scriptblock]::Create($ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true).Extent.Text))}
$block=$ast.Find({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Extent.Text.StartsWith('if($ResumeNativeDispose){') -and $a.Extent.Text.Contains('$savedControl=')},$true).Extent.Text
$ResumeNativeDispose=$true;$ExpectedPid=123;$ExpectedPackageSha256='package';$ExpectedProfileSha256='profile';$EvidenceDirectory='${root.replaceAll("'","''")}'
$control=@{pid=123;packageSha256='package';profileSha256='profile';creationDate='2026-10-28T08:00:00'}
$signal=@{targetPid=123;signalSent='CTRL_C_EVENT'}
$failure=@{phase='native-dispose';error='DEPLOY_NATIVE_NOT_QUIESCENT'}
function Get-Content($path){if($path.EndsWith('control.json')){$control|ConvertTo-Json}elseif($path.EndsWith('signal.json')){$signal|ConvertTo-Json}elseif($path.EndsWith('failure.json')){$failure|ConvertTo-Json}else{@{ProcessId=456;ParentProcessId=123;Name='worker';CreationDate='2026-10-28T08:00:00'}|ConvertTo-Json}}
function PortOwners{ @() };function Descendants{ @() };function Test-Path { $capturedPresent }
function Get-CimInstance { if($childAlive){[pscustomobject]@{ProcessId=456;Name='worker';CreationDate=[datetime]'2026-10-28T08:00:00'}} }
. ([scriptblock]::Create($block));if(-not$original.CreationDate){throw 'VALID_RESUME_REJECTED'}
$original=$null;$control.packageSha256='changed'
try { . ([scriptblock]::Create($block));throw 'MISMATCH_ACCEPTED' } catch { if($_.Exception.Message-ne'DEPLOY_RESUME_EVIDENCE_MISMATCH'){throw} }
$control.packageSha256='package';$capturedPresent=$true;$childAlive=$true
try { . ([scriptblock]::Create($block));throw 'CHILD_ACCEPTED' } catch { if($_.Exception.Message-ne'DEPLOY_RESUME_CHILD_PROCESS_REMAINS'){throw} }
$childAlive=$false;$original=[pscustomobject]@{ProcessId=123;CreationDate=[datetime]'2026-10-28T08:00:00'}
try { . ([scriptblock]::Create($block));throw 'OWNER_ACCEPTED' } catch { if($_.Exception.Message-ne'DEPLOY_RESUME_PROCESS_REMAINS'){throw} }
'RESUME_GATES_PASS'
`)
 const result=spawnSync('pwsh',['-NoProfile','-File',fixture],{encoding:'utf8',windowsHide:true})
 assert.equal(result.status,0,result.stdout+result.stderr)
 assert.match(result.stdout,/RESUME_GATES_PASS/)
})

async function drainMaintenanceFixture(t) {
 const f=await unstartedFixture(t)
 for(const table of ['tasks','executions','operations'])f.db.exec(`DELETE FROM dynamic_${table}`)
 const execution={taskId:'task-a',executionId:'exec-a',sessionId:'owner-a',requirementRevision:1,controlRevision:1,
  inputVersion:1,inputDigest:'original-input',leaseEpoch:3,sessionBound:true,cancelRequested:true,status:'running',drained:false}
 f.db.prepare('INSERT INTO dynamic_tasks VALUES (?)').run(JSON.stringify({taskId:'task-a',control:'active',drained:true}))
 f.db.prepare('INSERT INTO dynamic_executions VALUES (?)').run(JSON.stringify(execution))
 f.db.prepare('INSERT INTO dynamic_operations VALUES (?)').run(JSON.stringify({operationId:'effect-a',state:'unknown',executionId:'exec-a'}))
 f.db.exec('CREATE TABLE dynamic_receipts(id TEXT,body TEXT)')
 f.db.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(`${process.pid}:current`)
 f.events.splice(0,f.events.length,{type:'session',id:execution.sessionId},
  {type:'plugin:dingtalk/execution-session',seq:0,data:{version:2,identity:execution}},
  {type:'user/message',seq:1,data:{source:{executionSession:execution}}},
  {type:'turn/start',seq:2},{type:'turn/end',seq:3,data:{status:'blocked'}})
 await f.save()
 const intent={schema:'native-drain-maintenance-v1',expectedHost:{pid:process.pid,creationDate:'2026-10-29T00:00:00Z',commandLineSha256:'a'.repeat(64)},
  operatorApproval:{kind:'explicit-stop-deploy-resume',authorizedAt:'2026-10-29T01:00:00Z',sourceRef:'operator-message'},
  executions:[{executionId:'exec-a',cancelResponse:{statusCode:400,observedAt:'2026-10-29T01:05:00Z',body:{error:'execution_process_drain_failed'}}}]}
 const freeze=()=>inspectCurrentControl(f.path,'online',process.pid,{workspace:f.root,proposal:intent,freeze:true}).maintenance.proposal
 const proposal=freeze(),options={workspace:f.root,proposal}
 return {...f,execution,intent,proposal,options,freeze}
}

test('drain maintenance freezes a terminal cancelled execution and preserves unknown, rows and logs through offline proof',async t=>{
 const f=await drainMaintenanceFixture(t),before=f.db.prepare('SELECT body FROM dynamic_executions').all(),log=await readFile(f.log)
 assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid),/DEPLOY_NOT_DRAINED/)
 const proof=inspectCurrentControl(f.path,'online',process.pid,f.options)
 assert.equal(proof.drained,false);assert.equal(proof.quiescent,false);assert.equal(proof.maintenanceReady,true);assert.equal(proof.maintenance.writes,0)
 assert.equal(proof.unknownOperations,1);assert.equal(proof.maintenance.retained[0].binding.leaseEpoch,3)
 assert.deepEqual(inspectCurrentControl(f.path,'online',process.pid,f.options),proof)
 assert.throws(()=>inspectCurrentControl(f.path,'offline',process.pid,f.options),/OWNER_NOT_RELEASED/)
 // The OS gate still requires the exact approved owner to exit. Use an already exited child for offline proof.
 f.db.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(`${f.pid}:current`)
 const offlineOptions={...f.options,proposal:{...f.proposal,expectedHost:{...f.proposal.expectedHost,pid:f.pid}}}
 const offline=inspectCurrentControl(f.path,'offline',f.pid,offlineOptions)
 assert.equal(offline.drained,false);assert.equal(offline.quiescent,true);assert.equal(offline.maintenance.ledgerDigest,proof.maintenance.ledgerDigest)
 assert.throws(()=>inspectCurrentControl(f.path,'offline',f.pid,{...offlineOptions,freeze:true}),/FREEZE_REQUIRES_LIVE_OWNER/)
 assert.deepEqual(f.db.prepare('SELECT body FROM dynamic_executions').all(),before);assert.deepEqual(await readFile(f.log),log)
 assert.equal(JSON.parse(f.db.prepare('SELECT body FROM dynamic_operations').get().body).state,'unknown')
})

test('drain maintenance rejects changed controls, new commands and changed native input or terminal evidence',async t=>{
 const f=await drainMaintenanceFixture(t)
 const oldProposal={...f.proposal};delete oldProposal.controlDigestFormat
 assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid,{...f.options,proposal:oldProposal}),/DIGEST_FORMAT/)
 f.db.prepare('INSERT INTO dynamic_receipts VALUES (?,?)').run('new-command','{}')
 assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid,f.options),/CONTROL_CHANGED/)
 f.db.exec('DELETE FROM dynamic_receipts')
 f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify({...f.execution,leaseEpoch:4}))
 assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid,f.options),/CONTROL_CHANGED/)
 assert.throws(f.freeze,/INPUT_IDENTITY/)
 f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify(f.execution))
 f.events.push({type:'turn/start',seq:4});await f.save()
 assert.throws(f.freeze,/TERMINAL_MISSING/)
 f.events.pop();f.events.at(-1).data.status='aborted';await f.save()
 assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid,f.options),/EVIDENCE_CHANGED/)
})

test('drain maintenance binds the consumed execution input through feedback and inbox removal in a terminal native turn',async t=>{
 const f=await drainMaintenanceFixture(t)
 const executionSession={sessionId:'owner-a',inputVersion:4,inputDigest:'original-input',leaseEpoch:4,requirementRevision:2,controlRevision:1}
 f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify({...f.execution,...executionSession}))
 const input={role:'user',source:{kind:'coordinator',executionSession}}
 const feedback={role:'user',source:{kind:'coordinator',executionFeedback:{executionId:'exec-a',messageId:'feedback-a'}}}
 // Actual native order: enqueue, start, consume bound input, later feedback, remove inbox, terminal turn.
 f.events.splice(2,Infinity,
  {seq:1,type:'agent/inbox/spliced',data:{inserted:[input]}},
  {seq:2,type:'turn/start'}, {seq:3,type:'step/start'},
  {seq:4,type:'user/message',data:input},
  {seq:5,type:'user/message',data:{role:'user',source:{kind:'runtime-context',form:'snapshot'}}},
  {seq:12,type:'agent/inbox/spliced',data:{inserted:[feedback]}},
  {seq:14,type:'agent/inbox/spliced',data:{removedCount:1,inserted:[]}},
  {seq:15,type:'turn/end',data:{reason:{kind:'blocked'}}})
 for(const consumed of [false,true]){
  if(consumed)f.events.splice(-2,0,{seq:13,type:'user/message',data:feedback})
  await f.save()
  const original=await readFile(f.log),proposal=f.freeze(),options={workspace:f.root,proposal}
  const proof=inspectCurrentControl(f.path,'online',process.pid,options)
  assert.equal(proof.drained,false);assert.equal(proof.maintenanceReady,true)
  assert.equal(proof.maintenance.retained[0].binding.inputDigest,executionSession.inputDigest)
  assert.equal(proof.maintenance.retained[0].terminalSequence,15)
  assert.equal(proof.maintenance.writes,0);assert.equal(proof.unknownOperations,1)
  // Changing feedback (not just its execution input) still invalidates the frozen native evidence.
  feedback.source.executionFeedback.messageId='changed-feedback'
  await f.save();assert.throws(()=>inspectCurrentControl(f.path,'online',process.pid,options),/EVIDENCE_CHANGED/)
  feedback.source.executionFeedback.messageId='feedback-a';await f.save()
  assert.deepEqual(await readFile(f.log),original)
 }
})

test('drain maintenance still rejects missing or changed bindings and all post-terminal input or work',async t=>{
 const f=await drainMaintenanceFixture(t),original=structuredClone(f.events)
 original.at(-1).seq=5
 const feedback={role:'user',source:{kind:'coordinator',executionFeedback:{executionId:'exec-a',messageId:'feedback-a'}}}
 for(const [name,mutate,error] of [
  ['feedback without execution input',events=>{events[2].data=feedback},/INPUT_IDENTITY/],
  ['later mismatched input',events=>events.splice(-1,0,{seq:4,type:'user/message',data:{source:{executionSession:{...f.execution,leaseEpoch:4}}}}),/INPUT_IDENTITY/],
  ['malformed latest input',events=>events.splice(-1,0,{seq:4,type:'user/message',data:{source:{executionSession:null}}}),/INPUT_IDENTITY/],
  ['late bound input',events=>events.push({seq:6,type:'user/message',data:{source:{executionSession:f.execution}}}),/TERMINAL_MISSING/],
  ['late inbox input',events=>events.push({seq:6,type:'agent/inbox/spliced',data:{inserted:[{source:{executionSession:f.execution}}]}}),/TERMINAL_MISSING/],
  ['late feedback',events=>events.push({seq:6,type:'user/message',data:feedback}),/TERMINAL_MISSING/],
  ['late inbox feedback',events=>events.push({seq:6,type:'agent/inbox/spliced',data:{inserted:[feedback]}}),/TERMINAL_MISSING/],
  ['late tool',events=>events.push({seq:6,type:'tool/call'}),/TERMINAL_MISSING/],
  ['late job',events=>events.push({seq:6,type:'job/registered'}),/TERMINAL_MISSING/],
  ['unfinished turn',events=>events.push({seq:6,type:'turn/start'}),/TERMINAL_MISSING/],
 ]){
  f.events.splice(0,Infinity,...structuredClone(original));mutate(f.events);await f.save()
  assert.throws(f.freeze,error,name)
 }
})

test('large maintenance ledger freezes under a 96 MiB heap and keeps complete control and unknown digests',async t=>{
 const f=await drainMaintenanceFixture(t)
 const payload=JSON.stringify({state:'unknown',data:'x'.repeat(256*1024)})
 const operation=f.db.prepare('INSERT INTO dynamic_operations VALUES (?)'),receipt=f.db.prepare('INSERT INTO dynamic_receipts VALUES (?,?)')
 f.db.exec('BEGIN')
 for(let i=0;i<1024;i++){operation.run(payload);receipt.run(`receipt-${i}`,payload)}
 f.db.exec('COMMIT')
 const intentPath=join(f.root,'intent.json');await writeFile(intentPath,JSON.stringify(f.intent))
 const started=Date.now(),script=`
import { readFileSync, statSync } from 'node:fs';
import { inspectCurrentControl } from ${JSON.stringify(new URL('./inspect-quiescent-ledger.mjs',import.meta.url).href)};
const [db,workspace,owner,intentFile]=process.argv.slice(1);
const proposal=JSON.parse(readFileSync(intentFile,'utf8'));
const frozen=inspectCurrentControl(db,'online',Number(owner),{workspace,proposal,freeze:true}).maintenance.proposal;
const proof=inspectCurrentControl(db,'online',Number(owner),{workspace,proposal:frozen});
console.log(JSON.stringify({bytes:statSync(db).size,maxRssKiB:process.resourceUsage().maxRSS,format:frozen.controlDigestFormat,
 operations:proof.maintenance.tables.operations,receipts:proof.maintenance.tables.dynamic_receipts,unknown:proof.maintenance.unknownOperations,
 compactBytes:JSON.stringify(proof).length,drained:proof.drained}));
`
 const result=spawnSync(process.execPath,['--max-old-space-size=96','--input-type=module','-e',script,f.path,f.root,String(process.pid),intentPath],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024})
 assert.equal(result.status,0,result.stderr)
 const proof=JSON.parse(result.stdout)
 assert.ok(proof.bytes>512*1024*1024);assert.equal(proof.operations.count,1025);assert.equal(proof.receipts.count,1024)
 assert.equal(proof.unknown.count,1025);assert.equal(proof.drained,false);assert.equal(proof.format,'sqlite-row-stream-v1')
 assert.ok(proof.compactBytes<10000,'proof contains bounded aggregate digests rather than every unknown row')
 t.diagnostic(JSON.stringify({...proof,elapsedMs:Date.now()-started,heapLimitMiB:96}))
})

test('captured process tree excludes reused ParentPIDs and validates saved ancestry and exact live identities',async t=>{
 const root=await mkdtemp(join(tmpdir(),'process-identity-ps-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const script=new URL('./deploy-task-session-native.ps1',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fixture=join(root,'check.ps1')
 await writeFile(fixture,`
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($name in @('TextHash','TestCapturedProcess','AssertCapturedTree','Descendants')){. ([scriptblock]::Create($ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true).Extent.Text))}
function Process($id,$parent,$hour,$name){[pscustomobject]@{ProcessId=$id;ParentProcessId=$parent;CreationDate=([datetime]'2026-01-01T00:00:00Z').AddHours($hour);Name=$name;CommandLine=$name+' command';ExecutablePath='/example/'+$name}}
$original=Process 100 1 10 'host';$child=Process 200 100 11 'worker';$grandchild=Process 300 200 12 'leaf'
$unrelated=Process 400 100 3 'unrelated';$unrelatedChild=Process 401 400 13 'unrelated-child'
$inventory=@($original,$child,$grandchild,$unrelated,$unrelatedChild)
function Get-CimInstance { $inventory }
$captured=@(Descendants $original)
if(($captured.ProcessId-join',')-ne'200,300'){throw 'PID_REUSE_INCLUDED'}
if(-not(TestCapturedProcess $captured[0] $child)){throw 'SAME_PROCESS_MISSED'}
$reused=Process 200 999 14 'new-owner'
if(TestCapturedProcess $captured[0] $reused){throw 'REUSED_PID_IS_ORIGINAL'}
foreach($field in @('Name','ExecutablePath','CommandLine')){
 $changed=$child.PSObject.Copy();$changed.$field='different'
 try{TestCapturedProcess $captured[0] $changed;throw 'IDENTITY_DRIFT_ACCEPTED'}catch{if($_.Exception.Message-ne'DEPLOY_PROCESS_IDENTITY_CHANGED'){throw}}
}
foreach($case in @('missing-parent','duplicate','cycle','older-child')){
 $invalid=@($captured|ForEach-Object {$_.PSObject.Copy()})
 if($case-eq'missing-parent'){$invalid[1].ParentProcessId=999}
 if($case-eq'duplicate'){$invalid+= $invalid[0].PSObject.Copy()}
 if($case-eq'cycle'){$invalid[0].ParentProcessId=300}
 if($case-eq'older-child'){$invalid[1].CreationDate=$original.CreationDate}
 try{AssertCapturedTree $original $invalid;throw 'BAD_CHAIN_ACCEPTED'}catch{if($_.Exception.Message-ne'DEPLOY_PROCESS_TREE_INVALID'){throw}}
}
$inventory=@($original,$child,$child)
try{Descendants $original;throw 'DUPLICATE_CAPTURE_ACCEPTED'}catch{if($_.Exception.Message-ne'DEPLOY_PROCESS_TREE_INVALID'){throw}}
'PROCESS_IDENTITY_PASS'
`)
 const result=spawnSync('pwsh',['-NoProfile','-File',fixture],{encoding:'utf8',windowsHide:true})
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PROCESS_IDENTITY_PASS/)
})

test('drain maintenance refuses missing cancellation proof, other active work or a different session',async t=>{
 const f=await drainMaintenanceFixture(t)
 f.intent.executions[0].cancelResponse.statusCode=200;assert.throws(f.freeze,/CANCEL_RECEIPT/)
 f.intent.executions[0].cancelResponse.statusCode=400
 f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify({...f.execution,cancelRequested:false}))
 assert.throws(f.freeze,/EXECUTION_IDENTITY/)
 f.db.prepare('UPDATE dynamic_executions SET body=?').run(JSON.stringify(f.execution))
 f.db.prepare('INSERT INTO dynamic_groups VALUES (?)').run('{"drained":false}');assert.throws(f.freeze,/ACTIVE_WORK/)
 f.db.exec('DELETE FROM dynamic_groups')
 f.events[1].data.identity={...f.execution,sessionId:'another-session'};await f.save();assert.throws(f.freeze,/SESSION_IDENTITY/)
})

test('drain cutover gates execute in PowerShell and reject changed Host, proposal, children, ports and autostart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'drain-cutover-ps-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const script=new URL('./deploy-task-session-native.ps1',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fixture=join(root,'check.ps1')
 await writeFile(fixture,`
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($name in @('TextHash','TestCapturedProcess','AssertCapturedTree','AssertDrainMaintenanceIdentity','AssertDrainMaintenanceProcessesExited','PortOwners')){. ([scriptblock]::Create($ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name-eq$name},$true).Extent.Text))}
function Get-NetTCPConnection { throw 'PORT_PROBE_DENIED' }
try{PortOwners 3080;throw 'PORT_FAILURE_IGNORED'}catch{if($_.Exception.Message-ne'PORT_PROBE_DENIED'){throw}}
$ExpectedPid=123;$original=[pscustomobject]@{ProcessId=123;CreationDate=[datetime]'2026-10-29T00:00:00Z';CommandLine='target-host'}
$DrainFailureMaintenanceProposal='proposal';$drainMaintenanceHash='fixed';$actualHash='fixed'
$drainMaintenance=@{expectedHost=@{pid=123;creationDate='2026-10-29T00:00:00Z';commandLineSha256=(TextHash 'target-host')}}
function Hash { $actualHash };function Get-CimInstance($class,[string]$Filter) { if($hostAlive-and$Filter-eq'ProcessId=123'){$original}elseif($childAlive-and$Filter-eq'ProcessId=456'){[pscustomobject]@{ProcessId=456;CreationDate=$original.CreationDate}} }
function Get-Process { if($hostAlive){[pscustomobject]@{Id=123}} };function PortOwners { if($portAlive){@(123)}else{@()} }
function Descendants { throw 'POST_STOP_REDISCOVERY_FORBIDDEN' }
function Get-ScheduledTask { [pscustomobject]@{Settings=@{Enabled=$autostart}} };function RunNode { $script:verified=$true;'{}' }
$originalDescendants=@([pscustomobject]@{ProcessId=456;ParentProcessId=123;CreationDate=$original.CreationDate})
$gate=$ast.Find({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Extent.Text.StartsWith('if($DrainFailureMaintenanceProposal){') -and $a.Extent.Text.Contains('AssertDrainMaintenanceProcessesExited') -and $a.Extent.Text.Contains('$offlineProof=RunNode')},$true).Extent.Text
. ([scriptblock]::Create($gate));if(-not$verified){throw 'OFFLINE_GATE_MISSING'}
foreach($case in @('childAlive','hostAlive','portAlive','autostart')){
 Set-Variable $case $true
 try{. ([scriptblock]::Create($gate));throw 'PROCESS_ACCEPTED'}catch{if($_.Exception.Message-notin@('DEPLOY_CHILD_PROCESS_REMAINS','DEPLOY_MAINTENANCE_PROCESS_REMAINS')){throw}}
 Set-Variable $case $false
}
$actualHash='changed';try{AssertDrainMaintenanceIdentity;throw 'CHANGED_PROPOSAL_ACCEPTED'}catch{if($_.Exception.Message-ne'DEPLOY_MAINTENANCE_PROPOSAL_CHANGED'){throw}}
$actualHash='fixed';$original.CommandLine='another-host'
try{AssertDrainMaintenanceIdentity;throw 'CHANGED_HOST_ACCEPTED'}catch{if($_.Exception.Message-ne'DEPLOY_MAINTENANCE_HOST_CHANGED'){throw}}
'DRAIN_CUTOVER_GATES_PASS'
`)
 const result=spawnSync('pwsh',['-NoProfile','-File',fixture],{encoding:'utf8',windowsHide:true})
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/DRAIN_CUTOVER_GATES_PASS/)
})
