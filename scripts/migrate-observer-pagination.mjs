import {installTaskArchive,archiveTaskRows} from '../packages/dingtalk-dsh-assistant/task-archive.js'
import { installObserverLegacyExecutionPages } from '../packages/dingtalk-dsh-assistant/observer-legacy-execution-pages.js'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { installObserverPagination,installObserverArchivePagination } from '../packages/dingtalk-dsh-assistant/observer-pagination.js'
import { installObserverTracePages } from '../packages/dingtalk-dsh-assistant/observer-trace-pages.js'

// Deliberately separate from HTTP/startup. Run only against a stopped, backed-up ledger.
const args = process.argv.slice(2), apply = args.includes('--apply')
const value = key => { const i=args.indexOf(key);return i<0?undefined:args[i+1] }
const target = value('--database')
if(!target)throw new Error('Usage: --database <offline.sqlite> [--apply --backup <consistent-backup.sqlite> --expected-sha256 <digest>]')
const path=resolve(target), expected=value('--expected-sha256'), backup=value('--backup')
const hash=async file=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex')}
const noWal=()=>{try{if(statSync(`${path}-wal`).size)throw new Error('OBSERVER_MIGRATION_REQUIRES_OFFLINE_CHECKPOINT')}catch(cause){if(cause.code!=='ENOENT')throw cause}}
noWal()
if(apply){
 if(!backup||!expected||! /^[a-f0-9]{64}$/u.test(expected)||resolve(backup)===path)throw new Error('OBSERVER_MIGRATION_BACKUP_REQUIRED')
 if(await hash(backup)!==expected||await hash(path)!==expected)throw new Error('OBSERVER_MIGRATION_BACKUP_MISMATCH')
}
const db=new DatabaseSync(path,{readOnly:!apply})
let ownerLock
try{
 const dynamic=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dynamic_meta'").get()
 if(!dynamic){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_runs'").get()||!existsSync(path+'.owner.sqlite'))throw new Error('OBSERVER_MIGRATION_OWNER_SCHEMA_UNSUPPORTED')
  ownerLock=new DatabaseSync(path+'.owner.sqlite',{readOnly:true});ownerLock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE')
 }
 if(apply)db.exec('BEGIN EXCLUSIVE')
 if(dynamic&&db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value)throw new Error('OBSERVER_MIGRATION_ACTIVE_OWNER')
 noWal()
 let archivedTasks=0
 if(dynamic&&apply){
  if(db.prepare('PRAGMA user_version').get().user_version===3&&db.prepare("SELECT value FROM dynamic_meta WHERE key='taskArchiveSchema'").get()?.value!=='1')throw new Error('DYNAMIC_SCHEMA_INVALID')
  installTaskArchive(db,{indexes:true})
 }
 let ready=dynamic?installObserverPagination(db,{migrate:apply}):installObserverTracePages(db,{migrate:apply})
 if(!dynamic&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='business_tasks'").get())ready=installObserverLegacyExecutionPages(db,{migrate:apply})&&ready
 if(dynamic&&apply){
  installObserverArchivePagination(db)
  let after=''
  for(;;){
   const rows=db.prepare("SELECT id FROM dynamic_tasks WHERE id>? AND coalesce(json_type(body,'$.archivedAt'),'null')!='null' ORDER BY id LIMIT 100").all(after)
   if(!rows.length)break
   for(const row of rows){archiveTaskRows(db,row.id);archivedTasks++}
   after=rows.at(-1).id
  }
 }
 if(apply)db.exec('COMMIT')
 process.stdout.write(JSON.stringify({ready,applied:apply,requiresOfflineMigration:!ready,archivedTasks})+'\n')
}catch(cause){if(db.isTransaction)db.exec('ROLLBACK');throw cause}finally{db.close();if(ownerLock?.isTransaction)ownerLock.exec('ROLLBACK');ownerLock?.close()}
