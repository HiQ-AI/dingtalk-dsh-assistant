import {readFile,writeFile,mkdir,cp,readdir,stat,statfs} from 'node:fs/promises'
import {resolve,join,sep,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {DatabaseSync} from 'node:sqlite'
import yaml from 'js-yaml'
import {queryMessages} from '../../../../packages/dingtalk-dsh-assistant/message-ledger.js'
import {maintenanceStatus} from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import {openExecutionStore} from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import {sameDeliveredText,notificationOpenTaskId} from '../../../../packages/dingtalk-dsh-assistant/workflow-notifications.js'
import {verifyDeploymentBackup} from '../../../../scripts/deployment-integrity.mjs'
import {assertEchoDisposeWitness,verifyEchoBackup} from './recover-quarantined-echo.mjs'
const exec=promisify(execFile),hash=x=>createHash('sha256').update(x).digest('hex'),fail=code=>{throw Error(code)}
/** 只选择目录，不写入；半成品保留，完整manifest不得绕过验证。 */
export async function selectNoticeBackup(directory){
 let entries;try{entries=await readdir(directory,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return{backupRoot:join(directory,'backup'),complete:false};throw e}
 const names=entries.filter(e=>e.isDirectory()&&/^(?:backup|backup-attempt-[0-9]{3})$/.test(e.name)).map(e=>e.name).sort()
 const completed=[]
 for(const name of names)try{await stat(join(directory,name,'manifest.json'));completed.push(name)}catch(e){if(e.code!=='ENOENT')throw e}
 if(completed.length>1)fail('NOTICE_BACKUP_AMBIGUOUS')
 if(completed.length)return{backupRoot:join(directory,completed[0]),complete:true}
 if(!entries.some(e=>e.name==='backup'))return{backupRoot:join(directory,'backup'),complete:false}
 for(let i=1;i<=999;i++){const name=`backup-attempt-${String(i).padStart(3,'0')}`;if(!entries.some(e=>e.name===name))return{backupRoot:join(directory,name),complete:false}}
 fail('NOTICE_BACKUP_ATTEMPTS_EXHAUSTED')
}
/** 首份证据保留原名，后续回读另存；绝不覆盖原始receipt。 */
export async function appendNoticeEvidence(directory,name,value){
 if(!['delivery-evidence','repair-readback'].includes(name))fail('NOTICE_EVIDENCE_NAME_INVALID')
 let path=join(directory,name+'.json')
 try{await writeFile(path,JSON.stringify(value,null,2),{flag:'wx'})}
 catch(e){if(e.code!=='EEXIST')throw e;path=join(directory,`${name}-${randomUUID()}.json`);await writeFile(path,JSON.stringify(value,null,2),{flag:'wx'})}
 return path
}
export function verifyNoticeEvidence(n,c,status,mget){
 if(n?.id!==c.notificationId||n.runId!==c.runId||n.leaseEpoch!==c.leaseEpoch||!['acknowledged','delivered'].includes(n.status)||notificationOpenTaskId(n.ack)!==c.openTaskId||n.payload?.conversationId!==c.conversationId||n.payload?.sourceMessageId!==c.sourceMessageId)fail('NOTICE_IDENTITY_CHANGED')
 if(status.success!==true||status.openTaskId!==c.openTaskId||status.result?.sendStatus!=='SUCCESS'||status.messageRef?.openMessageId!==c.messageId||status.messageRef?.openConversationId!==c.conversationId)fail('NOTICE_SEND_STATUS_INVALID')
 if(mget.complete!==true||mget.hasMore||mget.partial||mget.failedCount!==0||mget.messages?.length!==1)fail('NOTICE_READBACK_INCOMPLETE')
 const m=mget.messages[0]
 if(m.messageId!==c.messageId||m.conversationId!==c.conversationId||m.quotedMessage?.messageId!==c.sourceMessageId||!sameDeliveredText(m.text,n.payload.text,{sender:m.quotedMessage.sender}))fail('NOTICE_READBACK_MISMATCH')
 if(n.status==='acknowledged'&&hash(JSON.stringify(n))!==c.expectedNoticeDigest)fail('NOTICE_CAS_CHANGED')
 if(n.status==='delivered'&&(n.evidence?.messageId!==c.messageId||n.evidence?.conversationId!==c.conversationId))fail('NOTICE_DELIVERY_CHANGED')
 return{messageId:c.messageId,conversationId:c.conversationId,observedAt:c.proofObservedAt}
}
export function assertNoticeMaintenance(state,c,record,n){
 if(state.busy.nodes||state.busy.owners||state.busy.effects||state.busy.messages!==(n.status==='delivered'?0:1))fail('NOTICE_OTHER_WORK_ACTIVE')
 if(record&&(!state.active||state.phase!=='draining'||state.maintenanceId!==record.maintenanceId||state.revision!==record.maintenanceRevision))fail('NOTICE_MAINTENANCE_CHANGED')
 if(!record&&(state.active||state.revision!==c.initialRevision))fail('NOTICE_INITIAL_CHANGED')
}
/** 批次只接纳明确列出的 ACK；不将其他未知效果归零。 */
export function assertNoticeBatch(state,manifest,notices){
 if(!Array.isArray(manifest.notices)||manifest.notices.length!==2||new Set(manifest.notices.map(n=>n.notificationId)).size!==2)fail('NOTICE_BATCH_INVALID')
 if(!state.active||state.phase!=='draining'||state.maintenanceId!==manifest.maintenanceId||state.revision!==manifest.maintenanceRevision||state.actorId!==manifest.actorId)fail('NOTICE_MAINTENANCE_CHANGED')
 if(notices.length!==2||notices.some((n,i)=>n.id!==manifest.notices[i].notificationId||!['acknowledged','delivered'].includes(n.status)))fail('NOTICE_IDENTITY_CHANGED')
 if(state.busy.nodes||state.busy.owners||state.busy.effects||state.busy.messages!==notices.filter(n=>n.status==='acknowledged').length)fail('NOTICE_OTHER_WORK_ACTIVE')
}
async function batchMain(mode,manifestPath){
 const c=JSON.parse(await readFile(manifestPath,'utf8'))
 if(!Number.isSafeInteger(c.expectedPid)||c.expectedPid<1||!Number.isSafeInteger(c.maintenanceRevision)||!c.instanceId||!c.dbPath||!c.dwsProfile)fail('NOTICE_CONFIG_INVALID')
 const alive=()=>{try{process.kill(c.expectedPid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}
 if(mode==='batch-repair'&&alive())fail('NOTICE_OLD_PROCESS_ALIVE')
 const inspect=()=>{const db=new DatabaseSync(c.dbPath,{readOnly:true});try{db.exec('BEGIN');if(db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id!==c.instanceId)fail('NOTICE_INSTANCE_CHANGED');const notices=c.notices.map(n=>queryMessages(db,{kind:'message.notification',notificationId:n.notificationId}));const state=maintenanceStatus(db);assertNoticeBatch(state,c,notices);return{notices,state}}finally{db.close()}}
 const proof=async(notices)=>Promise.all(notices.map(async(n,i)=>{
  const item={...c.notices[i],proofObservedAt:new Date().toISOString()}
  const run=async args=>{try{return JSON.parse((await exec('dws',[...args,'--profile',c.dwsProfile,'--format','json'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout)}catch{fail('NOTICE_DWS_READ_FAILED')}}
  const status=await run(['chat','+messages-query-send-status','--open-task-id',item.openTaskId])
  const message=await run(['chat','+messages-mget','--msg-ids',item.messageId])
  return{notificationId:n.id,evidence:verifyNoticeEvidence(n,item,status,message)}
 }))
 const initial=inspect(),evidence=await proof(initial.notices)
 if(mode==='--check'){console.log(JSON.stringify({eligible:true,writes:0,expectedPid:c.expectedPid,oldProcessAlive:alive(),maintenance:initial.state,notices:initial.notices.map(n=>({id:n.id,status:n.status,leaseEpoch:n.leaseEpoch,digest:hash(JSON.stringify(n))})),evidence}));return}
 if(alive())fail('NOTICE_OLD_PROCESS_ALIVE')
 // openExecutionStore 原生 owner 独占锁是唯一写入口；不打开 SQL 写连接。
 const store=await openExecutionStore({dbPath:c.dbPath,instanceId:c.instanceId})
 try{
  const current=await Promise.all(c.notices.map(n=>store.query({kind:'message.notification',notificationId:n.notificationId})))
  assertNoticeBatch(await store.query({kind:'runtime.maintenance'}),c,current)
  const fresh=await proof(current),receipts=[]
  for(let i=0;i<current.length;i++)if(current[i].status==='acknowledged')receipts.push(await store.command({id:`notice-delivery-recovery:${current[i].id}:${current[i].leaseEpoch}`,kind:'message.notification.readback',args:{notificationId:current[i].id,leaseEpoch:current[i].leaseEpoch,evidence:fresh[i].evidence}}))
  const after=await Promise.all(c.notices.map(n=>store.query({kind:'message.notification',notificationId:n.notificationId})))
  const state=await store.query({kind:'runtime.maintenance'});assertNoticeBatch(state,c,after)
  if(!state.drained||after.some(n=>n.status!=='delivered'))fail('NOTICE_RECOVERY_NOT_DRAINED')
  const sealed=await store.command({id:`notice-batch-seal:${c.maintenanceId}:${c.maintenanceRevision}`,kind:'runtime.maintenance.seal',args:{expectedRevision:c.maintenanceRevision,maintenanceId:c.maintenanceId,actorId:c.actorId,reason:'独立送达回读完成，封存已排空原生恢复进程'}})
  const maintenance=await store.query({kind:'runtime.maintenance'})
  if(maintenance.phase!=='stopping'||!maintenance.drained||maintenance.sealedIncarnation!==state.processIncarnation)fail('NOTICE_SEAL_INVALID')
  console.log(JSON.stringify({recovered:true,receipts,sealed,maintenance,notices:after.map(n=>({id:n.id,status:n.status,evidence:n.evidence})),next:'关闭恢复工具后，由标准部署新进程以相同维护身份和新revision接续resume'}))
 }finally{await store.close()}
}
async function main(){
 if(['--check','batch-repair'].includes(process.argv[2]))return batchMain(process.argv[2],process.argv[3])
 const[mode,manifest,directory]=process.argv.slice(2),workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),tmp=join(workspace,'docs/tmp')+sep
 if(!['check','repair'].includes(mode)||!manifest||!resolve(manifest).startsWith(tmp)||!directory||!resolve(directory).startsWith(tmp))fail('NOTICE_ARGUMENTS_INVALID')
 const c=JSON.parse(await readFile(manifest,'utf8'))
 for(const key of ['dbPath','profileDirectory','domainDirectory'])if(typeof c[key]!=='string'||!c[key].match(/^[A-Z]:\//))fail('NOTICE_CONFIG_INVALID')
 for(const key of ['runId','notificationId','instanceId','openTaskId','messageId','conversationId','sourceMessageId','dwsProfile','proofObservedAt'])if(typeof c[key]!=='string'||!c[key])fail('NOTICE_CONFIG_INVALID')
 if(!/^[a-f0-9]{64}$/.test(c.expectedNoticeDigest)||!Number.isSafeInteger(c.initialRevision)||!Number.isSafeInteger(c.leaseEpoch))fail('NOTICE_CONFIG_INVALID')
 const runtime=dirname(c.dbPath),profile=c.profileDirectory,domain=c.domainDirectory
 async function evidence(n){
  const run=async args=>{try{return JSON.parse((await exec('dws',[...args,'--profile',c.dwsProfile,'--format','json'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout)}catch{fail('NOTICE_DWS_READ_FAILED')}}
  const status=await run(['chat','+messages-query-send-status','--open-task-id',c.openTaskId]),message=await run(['chat','+messages-mget','--msg-ids',c.messageId])
  return{evidence:verifyNoticeEvidence(n,c,status,message),status,message}
 }
 const db=new DatabaseSync(c.dbPath,{readOnly:true});let n,state
 try{
  if(db.prepare("SELECT instance_id FROM execution_meta WHERE singleton=1").get()?.instance_id!==c.instanceId)fail('NOTICE_INSTANCE_CHANGED')
  n=queryMessages(db,{kind:'message.notification',notificationId:c.notificationId});state=maintenanceStatus(db)
 }finally{db.close()}
 const proof=await evidence(n)
 if(!Number.isFinite(Date.parse(c.proofObservedAt)))fail('NOTICE_PROOF_TIME_INVALID')
 const profileFiles=['cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml']
 const bytes=async path=>{let total=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);total+=e.isDirectory()?await bytes(p):e.isFile()?(await stat(p)).size:0}return total}
 let backupBytes=await bytes(join(runtime,'artifacts'))+await bytes(domain)
 for(const e of await readdir(runtime,{withFileTypes:true}))if(e.isFile())backupBytes+=(await stat(join(runtime,e.name))).size
 for(const name of profileFiles)try{backupBytes+=(await stat(join(profile,name))).size}catch(e){if(e.code!=='ENOENT')throw e}
 const capacity=await statfs(runtime),selection=await selectNoticeBackup(directory)
 const required=(selection.complete?0:backupBytes)+1024**3
 if(capacity.bavail*capacity.bsize<required)fail('NOTICE_BACKUP_CAPACITY')
 if(mode==='check'){assertNoticeMaintenance(state,c,null,n);console.log(JSON.stringify({eligible:true,runId:c.runId,notificationId:c.notificationId,noticeDigest:hash(JSON.stringify(n)),maintenance:state,disk:{backupBytes,requiredBytes:required,freeBytes:capacity.bavail*capacity.bsize},writes:0}));return}
 const record=JSON.parse(await readFile(join(directory,'recovery.json'),'utf8'))
 if(record.runId!==c.runId||record.instanceId!==c.instanceId||record.incidentHash.toLowerCase()!==hash(await readFile(manifest)))fail('NOTICE_RECORD_CHANGED')
 const source=await readFile(join(profile,'cordis.patch.yml'),'utf8')
 assertEchoDisposeWitness(record,JSON.parse(await readFile(join(directory,'bootstrap-ready.json'),'utf8')),JSON.parse(await readFile(join(directory,'bootstrap-disposed.json'),'utf8')),source,yaml)
 assertNoticeMaintenance(state,c,record,n)
 const backupRoot=selection.backupRoot,owner=new DatabaseSync(c.dbPath+'.owner.sqlite')
 try{
  owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  let exists=false;try{await readFile(join(backupRoot,'manifest.json'));exists=true}catch(e){if(e.code!=='ENOENT')throw e}
  if(!exists){
   await mkdir(backupRoot);await mkdir(join(backupRoot,'runtime'));await mkdir(join(backupRoot,'profile'))
   await cp(domain,join(backupRoot,'domain'),{recursive:true,errorOnExist:true,force:false})
   for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.isFile())await cp(join(runtime,entry.name),join(backupRoot,'runtime',entry.name),{errorOnExist:true,force:false})
   await cp(join(runtime,'artifacts'),join(backupRoot,'runtime','artifacts'),{recursive:true,errorOnExist:true,force:false})
   for(const name of ['cordis.patch.yml','cordis.yml','package.json','package-lock.json','settings.yaml','pnpm-lock.yaml'])try{await cp(join(profile,name),join(backupRoot,'profile',name),{errorOnExist:true,force:false})}catch(e){if(e.code!=='ENOENT')throw e}
   await writeFile(join(backupRoot,'manifest.json'),JSON.stringify({scope:{runId:c.runId,instanceId:c.instanceId,maintenanceId:record.maintenanceId,maintenanceRevision:record.maintenanceRevision,fencedSha256:record.fencedSha256},proof:await verifyDeploymentBackup({runtime,domain,profile,backupRoot})}),{flag:'wx'})
  }
  await verifyEchoBackup(backupRoot,record)
 }finally{try{owner.exec('ROLLBACK')}finally{owner.close()}}
 if(hash(await readFile(join(profile,'cordis.patch.yml')))!==record.fencedSha256)fail('NOTICE_FENCE_CHANGED')
 const store=await openExecutionStore({dbPath:c.dbPath,instanceId:c.instanceId})
 try{
  const current=await store.query({kind:'message.notification',notificationId:c.notificationId}),fresh=await evidence(current)
  assertNoticeMaintenance(await store.query({kind:'runtime.maintenance'}),c,record,current)
  await verifyEchoBackup(backupRoot,record)
  const receipt=current.status==='delivered'?{alreadyDelivered:true}:await store.command({id:`notice-delivery-recovery:${c.notificationId}:${c.leaseEpoch}`,kind:'message.notification.readback',args:{notificationId:c.notificationId,leaseEpoch:c.leaseEpoch,evidence:fresh.evidence}})
  const after=await store.query({kind:'message.notification',notificationId:c.notificationId}),maintenance=await store.query({kind:'runtime.maintenance'})
  verifyNoticeEvidence(after,c,fresh.status,fresh.message);assertNoticeMaintenance(maintenance,c,record,after)
  if(after.status!=='delivered'||!maintenance.drained)fail('NOTICE_RECOVERY_NOT_DRAINED')
  const evidencePath=await appendNoticeEvidence(directory,'delivery-evidence',fresh)
  const readbackPath=await appendNoticeEvidence(directory,'repair-readback',{receipt,after,maintenance,backupRoot,evidencePath})
  console.log(JSON.stringify({recovered:true,maintenance,backupRoot,evidencePath,readbackPath}))
 }finally{await store.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{const code=e.code??e.message;console.error(/^(?:NOTICE|ECHO|STORE|MESSAGE)_[A-Z_]+$/.test(code)?code:'NOTICE_RECOVERY_FAILED');process.exitCode=1})
