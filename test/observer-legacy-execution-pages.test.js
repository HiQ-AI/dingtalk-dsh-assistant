import {mkdtempSync,rmSync,copyFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {historicalExecutionPage} from '../packages/dingtalk-dsh-assistant/task-session-history.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {installObserverLegacyExecutionPages,observerLegacyFamilyPage,observerLegacyRunPage} from '../packages/dingtalk-dsh-assistant/observer-legacy-execution-pages.js'
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec(`CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY);CREATE TABLE task_owners(task_id TEXT PRIMARY KEY);
 CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,created_at TEXT);
 CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,node_id TEXT,status TEXT,session_bound INTEGER,session_id TEXT,current INTEGER,position INTEGER,evidence_refs TEXT);
 CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT);
 CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT);
 CREATE INDEX message_items_run_kind ON message_items(run_id,kind);
 CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);`)
 installObserverLegacyExecutionPages(db,{migrate:true})
 const task=id=>db.prepare('INSERT INTO business_tasks VALUES(?)').run(id)
 const event=(seq,kind,value)=>db.prepare('INSERT INTO execution_events VALUES(?,?,?)').run(seq,kind,JSON.stringify(value))
 const origin=(id,group='g')=>{
  db.prepare('INSERT INTO message_runs VALUES(?,?)').run(id,JSON.stringify({conversationId:group,actorId:'actor',body:'private history'.repeat(2000)}))
  db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run('cmd:'+id,id,'command',JSON.stringify({kind:'create',args:{taskId:id,arguments:{objective:'long objective'.repeat(1000)}}}))
 }
 return {db,task,event,origin}
}

test('legacy family selection reads only narrow metadata, enforces scope and rejects changes between pages',t=>{
 const {db,task,event,origin}=fixture(t)
 db.exec('BEGIN');task('t0000');origin('t0000')
 for(let i=1;i<1000;i++){
  const id='t'+String(i).padStart(4,'0');task(id)
  event(i,'task.web-rerun.accept',{taskId:id,rerunOfTaskId:'t0000',source:{actorId:i===999?'foreign':'owner',reportChannel:'web',externalMessaging:false,request:{objective:'private full request'.repeat(1000)}}})
 }
 db.exec('COMMIT')
 const statements=[];const observed={prepare(sql){statements.push(sql);return db.prepare(sql)}}
 const options={taskId:'t0000',groupIds:['g'],webActorId:'owner',offset:510,limit:10}
 const page=observerLegacyFamilyPage(observed,options)
 assert.equal(page.total,999);assert.equal(page.selected.length,10);assert.equal(page.selected[0].taskId,'t0488');assert.equal(page.selected[0].executionNumber,489)
 assert.equal(page.rootTaskId,'t0000');assert.equal(page.latestTaskId,'t0998')
 assert(statements.every(sql=>!sql.includes('body')&&!sql.includes('payload')),'GET must not select original source/event bodies')
 const next=observerLegacyFamilyPage(observed,{...options,offset:520,revision:page.revision})
 assert(!next.selected.some(item=>page.selected.some(prior=>prior.taskId===item.taskId)))
 assert.equal(observerLegacyFamilyPage(db,{...options,taskId:'t0999'}),null)
 assert.equal(observerLegacyFamilyPage(db,{...options,groupIds:[]}),null)
 task('new');event(1001,'task.web-rerun.accept',{taskId:'new',rerunOfTaskId:'t0000',source:{actorId:'owner',reportChannel:'web',externalMessaging:false}})
 assert.throws(()=>observerLegacyFamilyPage(observed,{...options,revision:page.revision}),{code:'OBSERVER_PAGE_STALE'})
})

test('legacy run page filters reset archives before LIMIT and reads only selected run node summaries',t=>{
 const {db,task,event,origin}=fixture(t);task('t');origin('t')
 for(let i=0;i<105;i++){
  db.prepare('INSERT INTO execution_runs VALUES(?,?,?,?)').run('r'+i,'t','succeeded','same')
  db.prepare('INSERT INTO execution_nodes VALUES(?,?,?,?,?,?,?,?,?)').run('n'+i,'r'+i,'step','succeeded',i%2,'private-session',1,0,JSON.stringify(['private evidence'.repeat(1000)]))
 }
 event(1,'task.execution.reset',{taskId:'t',archivedRunIds:['r104','r103','r102']})
 let nodeRows=0;const queries=[]
 const observed={prepare(sql){queries.push(sql);const statement=db.prepare(sql);return {get:(...args)=>statement.get(...args),all:(...args)=>{const rows=statement.all(...args);if(sql.includes('FROM execution_nodes'))nodeRows+=rows.length;return rows}}}}
 const args={taskId:'t',groupIds:['g'],webActorId:'owner',limit:10}
 const first=observerLegacyRunPage(observed,args)
 assert.equal(first.total,102);assert.equal(first.runs.length,10);assert.equal(first.runs[0].runId,'r101');assert.equal(nodeRows,10)
 assert(queries.every(sql=>!sql.includes('SELECT *')&&!sql.includes('evidence_refs')&&!sql.includes('payload')&&!sql.includes('body')))
 assert.equal(first.runs[0].nodes[0].sessionId,'private-session');assert.equal(first.runs[1].nodes[0].sessionId,null)
 const all=[...first.runs];let cursor=first.nextCursor
 while(cursor){const page=observerLegacyRunPage(observed,{...args,before:cursor,revision:first.revision});all.push(...page.runs);cursor=page.nextCursor}
 assert.equal(all.length,102);assert.equal(new Set(all.map(run=>run.runId)).size,102)
})

test('legacy execution page does not migrate or mutate an existing unindexed database during GET',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 assert.throws(()=>observerLegacyFamilyPage(db,{taskId:'t',groupIds:[],limit:10}),{code:'OBSERVER_PAGINATION_MIGRATION_REQUIRED'})
 assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get().n,0)
})


test('read-only historical adapter selects ten run records before reading their node references',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec(`CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,session_id TEXT,status TEXT,drained INTEGER,output_ref TEXT,evidence_refs TEXT);`)
 for(let i=0;i<1000;i++){
  db.prepare('INSERT INTO execution_runs VALUES(?,?,?,?,?)').run('r'+i,'t','succeeded','same','same')
  db.prepare('INSERT INTO execution_nodes VALUES(?,?,?,?,?,?,?)').run('n'+i,'r'+i,null,'succeeded',1,'output:'+i,JSON.stringify(['large-body-ref'.repeat(1000)]))
 }
 let runRows=0,nodeRows=0;const statements=[]
 const observed={prepare(sql){statements.push(sql);const statement=db.prepare(sql);return {get:(...args)=>statement.get(...args),all:(...args)=>{const rows=statement.all(...args);if(sql.includes('FROM execution_runs'))runRows+=rows.length;if(sql.includes('FROM execution_nodes'))nodeRows+=rows.length;return rows}}}}
 const page=historicalExecutionPage(observed,new Set(['execution_runs','execution_nodes']),'t',{offset:510,limit:10})
 assert.equal(page.total,1000);assert.equal(runRows,10);assert.equal(nodeRows,10);assert.equal(page.items[0].execution.executionId,'r510')
 assert(statements.every(sql=>!sql.includes('evidence_refs')&&!sql.includes('SELECT *')))
})


test('legacy family index is installed only by explicit offline migration with its preserved backup',t=>{
 const root=mkdtempSync(join(tmpdir(),'legacy-page-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const path=join(root,'legacy.sqlite'),backup=join(root,'backup.sqlite'),db=new DatabaseSync(path)
 db.exec(`CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY);CREATE TABLE task_owners(task_id TEXT PRIMARY KEY);
 CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,created_at TEXT);
 CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,node_id TEXT,status TEXT,session_bound INTEGER,session_id TEXT,current INTEGER,position INTEGER);
 CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT);
 CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT);
 CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);
 INSERT INTO business_tasks VALUES('t');
 INSERT INTO message_runs VALUES('source','{"runId":"source","conversationId":"g"}');
 INSERT INTO message_items VALUES('command','source','command','{"kind":"create","args":{"taskId":"t"}}');`)
 db.close()
 const owner=new DatabaseSync(path+'.owner.sqlite');owner.exec('CREATE TABLE guard(id TEXT)');owner.close()
 const script=new URL('../scripts/migrate-observer-pagination.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')
 const run=(...args)=>spawnSync(process.execPath,[script,'--database',path,...args],{encoding:'utf8',timeout:15000})
 const original=readFileSync(path),sha=createHash('sha256').update(original).digest('hex')
 const inspection=run();assert.equal(inspection.status,0,inspection.stderr);assert.equal(JSON.parse(inspection.stdout).ready,false);assert.deepEqual(readFileSync(path),original)
 copyFileSync(path,backup)
 const result=run('--apply','--backup',backup,'--expected-sha256',sha);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ready,true);assert.deepEqual(readFileSync(backup),original)
 const migrated=new DatabaseSync(path,{readOnly:true});try{assert.equal(observerLegacyFamilyPage(migrated,{taskId:'t',groupIds:['g'],limit:10}).total,1)}finally{migrated.close()}
})


test('legacy family rejects dangling or cyclic accepted parents instead of inventing a root',t=>{
 const {db,task,event,origin}=fixture(t);task('a');origin('a');task('b');origin('b')
 event(1,'task.web-rerun.accept',{taskId:'a',rerunOfTaskId:'missing',source:{actorId:'owner',reportChannel:'web',externalMessaging:false}})
 const q={taskId:'a',groupIds:['g'],webActorId:'owner',limit:10}
 assert.throws(()=>observerLegacyFamilyPage(db,q),{code:'TASK_FAMILY_INVALID'})
 db.prepare('UPDATE execution_events SET payload=? WHERE seq=1').run(JSON.stringify({taskId:'a',rerunOfTaskId:'b',source:{actorId:'owner',reportChannel:'web',externalMessaging:false}}))
 event(2,'task.web-rerun.accept',{taskId:'b',rerunOfTaskId:'a',source:{actorId:'owner',reportChannel:'web',externalMessaging:false}})
 assert.throws(()=>observerLegacyFamilyPage(db,q),{code:'TASK_FAMILY_INVALID'})
})
