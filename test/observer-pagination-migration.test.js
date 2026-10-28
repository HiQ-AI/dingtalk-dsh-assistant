import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,copyFile,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const script=new URL('../scripts/migrate-observer-pagination.mjs',import.meta.url)
test('indexes-only preserves source rows/schema/owner, rejects live or mismatched owners and rolls back failed DDL',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observer-indexes-only-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'ledger.sqlite'),db=new DatabaseSync(path)
 db.exec(`PRAGMA application_id=1146311763;PRAGMA user_version=2;CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO dynamic_meta VALUES('instanceId','fixture'),('initToken','fixture');`)
 for(const name of ['tasks','executions','wakes','coordination_sources','sources','notifications','coordination'])db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
 const body=JSON.stringify({status:'completed',archivedAt:'2026-01-01',groupId:'g'})
 db.prepare('INSERT INTO dynamic_tasks VALUES(?,?)').run('t',body);db.close()
 const run=(...args)=>spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--database',path,'--indexes-only',...args],{encoding:'utf8',timeout:15000})
 const before=await readFile(path);assert.equal(run().status,0);assert.deepEqual(await readFile(path),before)
 let edit=new DatabaseSync(path);edit.prepare("INSERT INTO dynamic_meta VALUES('owner',?)").run(`${process.pid}:live`);edit.close()
 assert.notEqual(run('--apply','--expected-owner',`${process.pid}:live`).status,0)
 const child=spawnSync(process.execPath,['-e',''],{encoding:'utf8'}),stale=`${child.pid}:dead`
 edit=new DatabaseSync(path);edit.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(stale);edit.exec('DROP TABLE dynamic_notifications');edit.close()
 assert.notEqual(run('--apply','--expected-owner','wrong').status,0)
 assert.notEqual(run('--apply','--expected-owner',stale).status,0)
 edit=new DatabaseSync(path);assert.equal(edit.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_task_index'").get(),undefined);edit.exec('CREATE TABLE dynamic_notifications(id TEXT PRIMARY KEY,body TEXT)');edit.close()
 const result=run('--apply','--expected-owner',stale);assert.equal(result.status,0,result.stderr)
 assert.equal(JSON.parse(result.stdout).archivedTasks,0);assert.equal(run('--apply','--expected-owner',stale).status,0)
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('SELECT body FROM dynamic_tasks').get().body,body);assert.equal(check.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get().value,stale);assert.equal(check.prepare('PRAGMA user_version').get().user_version,2);assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='dynamic_archived_tasks'").get(),undefined);check.close()
})
test('offline CLI is read-only by default and requires the exact preserved backup before atomic index migration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observer-offline-migration-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'ledger.sqlite'),backup=join(root,'backup.sqlite'),db=new DatabaseSync(path)
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','wakes','coordination_sources','sources','notifications','coordination'])db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
 db.exec('CREATE TABLE dynamic_receipts(id TEXT PRIMARY KEY,digest TEXT,body TEXT);CREATE TABLE dynamic_task_events(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE,body TEXT)')
 db.close()
 const run=(...args)=>spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--database',path,...args],{encoding:'utf8',timeout:15000})
 const before=await readFile(path)
 assert.equal(run().status,0);assert.deepEqual(await readFile(path),before)
 assert.notEqual(run('--apply').status,0);assert.deepEqual(await readFile(path),before)
 await copyFile(path,backup);const hash=createHash('sha256').update(before).digest('hex')
 const wrong=run('--apply','--backup',backup,'--expected-sha256','0'.repeat(64));assert.notEqual(wrong.status,0);assert.deepEqual(await readFile(path),before)
 const result=run('--apply','--backup',backup,'--expected-sha256',hash)
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ready,true);assert.deepEqual(await readFile(backup),before)
 assert.equal(JSON.parse(run().stdout).ready,true)
 const owner=new DatabaseSync(path);owner.prepare("INSERT INTO dynamic_meta VALUES('owner','synthetic-live-owner')").run();owner.close()
 const owned=await readFile(path);assert.notEqual(run().status,0);assert.deepEqual(await readFile(path),owned)
 await writeFile(path+'-wal','synthetic-uncheckpointed-wal');assert.notEqual(run().status,0)
})
test('legacy trace migration honors the separate process-owner SQLite lock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observer-trace-offline-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'legacy.sqlite'),backup=join(root,'backup.sqlite'),db=new DatabaseSync(path)
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)');db.close()
 const lock=new DatabaseSync(path+'.owner.sqlite');lock.exec('CREATE TABLE guard(id TEXT)');lock.close()
 const run=(...args)=>spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--database',path,...args],{encoding:'utf8',timeout:15000})
 const owner=new DatabaseSync(path+'.owner.sqlite');owner.exec('BEGIN EXCLUSIVE')
 assert.notEqual(run().status,0);owner.exec('ROLLBACK');owner.close()
 assert.equal(run().status,0)
 await copyFile(path,backup);const before=await readFile(path),hash=createHash('sha256').update(before).digest('hex')
 const result=run('--apply','--backup',backup,'--expected-sha256',hash)
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ready,true)
})

test('resident indexes-only requires initialized identity and an unlocked owner file, without backup',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observer-resident-indexes-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'resident.sqlite'),db=new DatabaseSync(path)
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)');db.close()
 const lock=new DatabaseSync(path+'.owner.sqlite');lock.exec('CREATE TABLE guard(id TEXT)');lock.close()
 const run=(...args)=>spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--database',path,'--indexes-only',...args],{encoding:'utf8',timeout:15000})
 assert.notEqual(run('--apply').status,0)
 const init=new DatabaseSync(path);init.exec('PRAGMA application_id=1146308677;PRAGMA user_version=9');init.close()
 const before=await readFile(path),ownerBefore=await readFile(path+'.owner.sqlite');assert.equal(run().status,0);assert.deepEqual(await readFile(path),before);assert.deepEqual(await readFile(path+'.owner.sqlite'),ownerBefore)
 const owner=new DatabaseSync(path+'.owner.sqlite');owner.exec('BEGIN EXCLUSIVE');assert.notEqual(run('--apply').status,0);owner.exec('ROLLBACK');owner.close()
 const result=run('--apply');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).databaseKind,'resident');assert.equal(run('--apply').status,0)
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,9);assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='observer_trace_index'").get());check.close()
})


test('offline migration partitions an existing archive flag and preserves readable command history', async t => {
 const {openDynamicTaskStore}=await import('../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
 const root=await mkdtemp(join(tmpdir(),'observer-archive-migration-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'ledger.sqlite'),backup=join(root,'backup.sqlite'),options={dbPath:path,instanceId:'fixture',initialize:true}
 let store=await openDynamicTaskStore(options),n=0
 const command=(kind,args,id=`c${++n}`)=>store.command({id,kind,args})
 await command('task.create',{taskId:'legacy',request:'Synthetic migration'})
 const {binding}=(await command('task.claim',{taskId:'legacy'})).result
 const completed=await command('task.complete',{binding,summary:'Synthetic done'},'completed')
 await command('task.drained',{binding});await store.close()
 const old=new DatabaseSync(path);old.exec("UPDATE dynamic_tasks SET body=json_set(body,'$.archivedAt','2026-01-01T00:00:00Z','$.archivedBy','fixture') WHERE id='legacy'");old.close()
 const run=(...args)=>spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--database',path,...args],{encoding:'utf8',timeout:15000})
 const liveOwner=`${process.pid}:fixture`,exited=spawnSync(process.execPath,['-e',''],{encoding:'utf8'}),staleOwner=`${exited.pid}:fixture`
 let owner=new DatabaseSync(path);owner.prepare("INSERT INTO dynamic_meta VALUES('owner',?)").run(liveOwner);owner.close()
 await copyFile(path,backup);const liveBytes=await readFile(path),liveHash=createHash('sha256').update(liveBytes).digest('hex')
 const live=run('--apply','--backup',backup,'--expected-sha256',liveHash,'--expected-owner',liveOwner)
 assert.notEqual(live.status,0);assert.match(live.stderr,/OBSERVER_MIGRATION_ACTIVE_OWNER/);assert.deepEqual(await readFile(path),liveBytes)
 owner=new DatabaseSync(path);owner.prepare("UPDATE dynamic_meta SET value=? WHERE key='owner'").run(staleOwner);owner.close()
 await copyFile(path,backup);const hash=createHash('sha256').update(await readFile(path)).digest('hex')
 const before=await readFile(path),wrong=run('--apply','--backup',backup,'--expected-sha256',hash,'--expected-owner','wrong')
 assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/OBSERVER_MIGRATION_OWNER_MISMATCH/);assert.deepEqual(await readFile(path),before)
 assert.equal(run('--expected-owner',staleOwner).status,0);assert.deepEqual(await readFile(path),before)
 assert.notEqual(run('--apply','--expected-owner',staleOwner).status,0)
 const result=run('--apply','--backup',backup,'--expected-sha256',hash,'--expected-owner',staleOwner)
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).archivedTasks,1)
 const check=new DatabaseSync(path,{readOnly:true});assert.equal(check.prepare('SELECT count(*) n FROM dynamic_tasks').get().n,0);assert.equal(check.prepare('SELECT count(*) n FROM dynamic_archived_tasks').get().n,1);assert.equal(check.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get().value,staleOwner);check.close()
 assert.deepEqual(await readFile(backup),before)
 store=await openDynamicTaskStore({...options,initialize:false})
 try{assert.equal((await store.query({kind:'task.get',taskId:'legacy'})).completion.summary,'Synthetic done');assert.deepEqual(await store.command({id:'completed',kind:'task.complete',args:{binding,summary:'Synthetic done'}}),{...completed,replayed:true})}finally{await store.close()}
})
