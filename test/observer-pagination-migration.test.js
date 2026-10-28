import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,copyFile,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const script=new URL('../scripts/migrate-observer-pagination.mjs',import.meta.url)
test('offline CLI is read-only by default and requires the exact preserved backup before atomic index migration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'observer-offline-migration-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'ledger.sqlite'),backup=join(root,'backup.sqlite'),db=new DatabaseSync(path)
 db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)')
 for(const name of ['tasks','executions','wakes','coordination_sources','sources','notifications','coordination'])db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
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
