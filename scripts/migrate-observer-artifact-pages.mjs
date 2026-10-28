import {installObserverArtifactBindings,queryObserverArtifactBinding,putObserverArtifactBinding} from '../packages/dingtalk-dsh-assistant/observer-artifact-bindings.js'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {createReadStream,statSync,existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {openExecutionArtifacts} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
const args=process.argv.slice(2),apply=args.includes('--apply')
const arg=key=>{const index=args.indexOf(key);return index<0?undefined:args[index+1]}
const database=arg('--database'),directory=arg('--artifact-directory'),manifestPath=arg('--manifest')
if(!database||!directory||!manifestPath)throw new Error('Usage: --database <offline.sqlite> --artifact-directory <root> --manifest <reviewed.json> [--task-workspace-root <root>] [--apply --backup <consistent.sqlite> --expected-sha256 <digest>]')
const path=resolve(database),backup=arg('--backup'),expected=arg('--expected-sha256')
const hash=async file=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex')}
const noWal=()=>{try{if(statSync(path+'-wal').size)throw new Error('OBSERVER_MIGRATION_REQUIRES_OFFLINE_CHECKPOINT')}catch(cause){if(cause.code!=='ENOENT')throw cause}}
noWal()
if(apply){if(!backup||!expected||!/^[a-f0-9]{64}$/.test(expected)||resolve(backup)===path)throw new Error('OBSERVER_MIGRATION_BACKUP_REQUIRED');if(await hash(path)!==expected||await hash(backup)!==expected)throw new Error('OBSERVER_MIGRATION_BACKUP_MISMATCH')}
const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
if(!Array.isArray(manifest)||manifest.some(item=>!item||typeof item.ref!=='string'||item.nodeId!==undefined&&(typeof item.nodeId!=='string'||item.nodeId.length>256)))throw new Error('OBSERVER_ARTIFACT_MANIFEST_INVALID')
const db=new DatabaseSync(path,{readOnly:!apply});let ownerLock
try{
 const dynamic=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dynamic_meta'").get()
 if(dynamic){if(db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value)throw new Error('OBSERVER_MIGRATION_ACTIVE_OWNER')}
 else {if(!existsSync(path+'.owner.sqlite'))throw new Error('OBSERVER_MIGRATION_OWNER_SCHEMA_UNSUPPORTED');ownerLock=new DatabaseSync(path+'.owner.sqlite',{readOnly:true});ownerLock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE')}
 db.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');noWal()
 if(apply)installObserverArtifactBindings(db)
 const artifacts=await openExecutionArtifacts({directory,taskWorkspaceRoot:arg('--task-workspace-root'),observerPageBindings:{get:args=>queryObserverArtifactBinding(db,args),put:binding=>putObserverArtifactBinding(db,binding,{replace:args.includes('--rebuild')})}})
 let ready=0
 for(const item of manifest){
  if(apply)await artifacts.indexObserverPages(item.ref,await artifacts.read(item.ref),{nodeId:item.nodeId,context:item.context??{},replace:args.includes('--rebuild'),messageOutput:item.view==='message-query-evidence'?false:!item.nodeId||item.messageOutput===true})
  try{await artifacts.readObserverPage(item.ref,item.view??(item.nodeId?`node:${item.nodeId}`:'message-output'),{limit:2});ready++}catch(cause){if(cause.code!=='OBSERVER_TEXT_MIGRATION_REQUIRED')throw cause}
 }
 if(apply)db.exec('COMMIT')
 process.stdout.write(JSON.stringify({applied:apply,entries:manifest.length,ready,requiresOfflineMigration:ready!==manifest.length})+'\n')
}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();if(ownerLock?.isTransaction)ownerLock.exec('ROLLBACK');ownerLock?.close()}
