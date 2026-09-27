import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { queryMessages } from '../../../../packages/dingtalk-dsh-assistant/message-ledger.js'
import { maintenanceStatus } from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { bootstrapProfile } from '../../../../scripts/bootstrap-workflow-maintenance.mjs'
import { verifyDeploymentBackup } from '../../../../scripts/deployment-integrity.mjs'
const runtime='D:/dsh_home/workflows/runtime-v2', profile='D:/dsh_home/profiles/web', domain='D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116'
const instanceId='dsh-web-runtime-v2-20260924',runId='msg-92023445605d174a87e6028d94c579a24ca3012f'
const hash=v=>createHash('sha256').update(v).digest('hex')
const fail=code=>{throw Error(code)}
export function assertEchoDisposeWitness(record,ready,disposed,source,yaml){
 for(const [kind,proof]of [['ready',ready],['disposed',disposed]])if(proof?.kind!==kind||proof.nonce!==record.nonce||proof.pid!==record.pid||proof.entryId!=='dingtalk-dsh-assistant'||proof.moduleName!=='@zzusp/dingtalk-dsh-assistant/resident')fail('ECHO_DISPOSE_WITNESS_INVALID')
 if(hash(source)!==record.fencedSha256||hash(bootstrapProfile(source,'enable',yaml))!==record.originalSha256)fail('ECHO_PROFILE_FENCE_INVALID')
}
export function assertEchoMaintenance(state,record,check){
 if(!state.active||state.phase!=='draining'||state.maintenanceId!==record.maintenanceId||state.revision!==record.maintenanceRevision)fail('ECHO_MAINTENANCE_CHANGED')
 if(state.busy.nodes||state.busy.owners||state.busy.effects||check&&state.busy.messages!==check.runningNodes)fail('ECHO_OTHER_WORK_ACTIVE')
}
export async function verifyEchoBackup(backupRoot,record) {
 const manifest=JSON.parse(await readFile(join(backupRoot,'manifest.json'),'utf8'))
 const expected={runId:record.runId,instanceId:record.instanceId,maintenanceId:record.maintenanceId,maintenanceRevision:record.maintenanceRevision,fencedSha256:record.fencedSha256}
 if(JSON.stringify(manifest.scope)!==JSON.stringify(expected)||manifest.proof?.verified!==true||!Array.isArray(manifest.proof.manifest)||!manifest.proof.manifest.length)fail('ECHO_BACKUP_SCOPE_INVALID')
 for(const item of [...manifest.proof.manifest,{path:'runtime/'+manifest.proof.database.restoreFile.replace(/^runtime\//,''),sha256:manifest.proof.database.sha256}]){
  const path=resolve(backupRoot,item.path)
  if(!path.startsWith(resolve(backupRoot)+sep))fail('ECHO_BACKUP_PATH_INVALID')
  const bytes=await readFile(path)
  if(hash(bytes)!==item.sha256||item.bytes!==undefined&&bytes.length!==item.bytes)fail('ECHO_BACKUP_CHANGED')
 }
 return manifest
}
async function main(){
 const [mode,directory]=process.argv.slice(2)
 if(!['check','repair'].includes(mode))fail('ECHO_MODE_INVALID')
 if(mode==='check'){
  const db=new DatabaseSync(join(runtime,'control.sqlite'),{readOnly:true})
  try{const check=queryMessages(db,{kind:'message.echo.reconciliation',runId});if(!check?.eligible)fail('ECHO_REPAIR_NOT_ELIGIBLE');const maintenance=maintenanceStatus(db);if(maintenance.busy.nodes||maintenance.busy.owners||maintenance.busy.effects||maintenance.busy.messages!==check.nodeRunIds.length)fail('ECHO_OTHER_WORK_ACTIVE');console.log(JSON.stringify({check,maintenance}))}finally{db.close()}
  return
 }
 const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..')
 if(!directory||!resolve(directory).toLowerCase().startsWith(join(workspace,'docs','tmp').toLowerCase()+sep))fail('ECHO_EVIDENCE_PATH_INVALID')
 const record=JSON.parse(await readFile(join(directory,'recovery.json'),'utf8'))
 if(record.runId!==runId||record.instanceId!==instanceId)fail('ECHO_TARGET_CHANGED')
 const source=await readFile(join(profile,'cordis.patch.yml'),'utf8'),yaml=createRequire(pathToFileURL(join(profile,'cordis.patch.yml')))(join(profile,'node_modules/js-yaml'))
 assertEchoDisposeWitness(record,JSON.parse(await readFile(join(directory,'bootstrap-ready.json'),'utf8')),JSON.parse(await readFile(join(directory,'bootstrap-disposed.json'),'utf8')),source,yaml)
 const backupRoot=join(directory,'backup'),owner=new DatabaseSync(join(runtime,'control.sqlite.owner.sqlite'))
 try{
  owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  const db=new DatabaseSync(join(runtime,'control.sqlite'),{readOnly:true})
  try{const check=queryMessages(db,{kind:'message.echo.reconciliation',runId});if(!check?.eligible)fail('ECHO_REPAIR_NOT_ELIGIBLE');assertEchoMaintenance(maintenanceStatus(db),record,{runningNodes:queryMessages(db,{kind:'message.run',runId}).nodes.filter(n=>n.status==='running').length})}finally{db.close()}
  let exists=false;try{await readFile(join(backupRoot,'manifest.json'));exists=true}catch(e){if(e.code!=='ENOENT')throw e}
  if(!exists){
   await mkdir(backupRoot);await mkdir(join(backupRoot,'runtime'));await mkdir(join(backupRoot,'profile'))
   await cp(domain,join(backupRoot,'domain'),{recursive:true,errorOnExist:true,force:false})
   for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.isFile())await cp(join(runtime,entry.name),join(backupRoot,'runtime',entry.name),{errorOnExist:true,force:false})
   await cp(join(runtime,'artifacts'),join(backupRoot,'runtime','artifacts'),{recursive:true,errorOnExist:true,force:false})
   for(const name of ['cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml'])try{await cp(join(profile,name),join(backupRoot,'profile',name),{errorOnExist:true,force:false})}catch(e){if(e.code!=='ENOENT')throw e}
   await writeFile(join(backupRoot,'manifest.json'),JSON.stringify({scope:{runId,instanceId,maintenanceId:record.maintenanceId,maintenanceRevision:record.maintenanceRevision,fencedSha256:record.fencedSha256},proof:await verifyDeploymentBackup({runtime,domain,profile,backupRoot})},null,2),{flag:'wx'})
  }
  await verifyEchoBackup(backupRoot,record)
 }finally{try{owner.exec('ROLLBACK')}finally{owner.close()}}
 // 释放备份锁后仅由原生 Store 重新取得同一 owner 锁；配置 fence 和完整退出证明仍保持。
 if(hash(await readFile(join(profile,'cordis.patch.yml')))!==record.fencedSha256)fail('ECHO_PROFILE_FENCE_INVALID')
 const store=await openExecutionStore({dbPath:join(runtime,'control.sqlite'),instanceId})
 try{
  const check=await store.query({kind:'message.echo.reconciliation',runId})
  if(!check?.eligible)fail('ECHO_REPAIR_NOT_ELIGIBLE')
  assertEchoMaintenance(await store.query({kind:'runtime.maintenance'}),record,{runningNodes:(await store.query({kind:'message.run',runId})).nodes.filter(n=>n.status==='running').length})
  await verifyEchoBackup(backupRoot,record)
  const receipt=await store.command({id:`echo-reconcile:${runId}:${check.expectedDigest}`,kind:'message.echo.reconcile',args:{runId,expectedDigest:check.expectedDigest}})
  const after=await store.query({kind:'message.echo.reconciliation',runId}),state=await store.query({kind:'runtime.maintenance'})
  assertEchoMaintenance(state,record)
  if(!after.alreadyReconciled||!state.drained)fail('ECHO_REPAIR_NOT_DRAINED')
  const result={receipt,after,maintenance:state,backupRoot}
  await writeFile(join(directory,'repair-readback.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
 }finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.code??e.message);process.exitCode=1})
