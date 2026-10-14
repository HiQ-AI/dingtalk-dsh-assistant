import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectLedger } from './inspect-quiescent-ledger.mjs'

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
