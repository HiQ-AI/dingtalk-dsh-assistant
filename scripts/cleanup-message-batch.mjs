import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { inspectMessageBatchCleanup } from '../packages/dingtalk-dsh-assistant/message-ledger.js'
const fail=code=>{throw Error(code)}
const [mode,path]=process.argv.slice(2)
if(!['--check','--execute'].includes(mode)||!path)fail('CLEANUP_ARGUMENTS_INVALID')
const m=JSON.parse(await readFile(path,'utf8'))
const alive=()=>{try{process.kill(m.expectedPid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}
if(!Number.isSafeInteger(m.expectedPid)||m.expectedPid<1||!m.notificationAuditPath||!m.instanceId)fail('CLEANUP_MANIFEST_INVALID')
const db=new DatabaseSync(m.dbPath,{readOnly:true})
let checked
try{db.exec('BEGIN');if(db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id!==m.instanceId)fail('CLEANUP_INSTANCE_CHANGED');checked=inspectMessageBatchCleanup(db,m)}finally{db.close()}
if(mode==='--check'){
 console.log(JSON.stringify({eligible:true,writes:0,oldProcessAlive:alive(),...checked}));process.exit(0)
}
if(alive())fail('CLEANUP_OLD_PROCESS_ALIVE')
// 撤回依据必须先独立保存并读回；不是数据库备份。
const audit=await readFile(m.notificationAuditPath,'utf8')
const parsed=JSON.parse(audit)
if(JSON.stringify(parsed)!==JSON.stringify(checked.sentNotifications)||m.expectedDigest!==checked.expectedDigest||m.notificationAuditDigest!==checked.notificationAuditDigest)fail('CLEANUP_AUDIT_MISMATCH')
const store=await openExecutionStore({dbPath:m.dbPath,instanceId:m.instanceId})
try{
 const fresh=await store.query({kind:'message.batch.cleanup.check',...m})
 if(fresh.expectedDigest!==checked.expectedDigest)fail('CLEANUP_STATE_CHANGED')
 const receipt=await store.command({id:`message-cleanup:${createHash('sha256').update(JSON.stringify(m)).digest('hex')}`,kind:'message.batch.cleanup',args:m})
 const remaining=await store.query({kind:'message.pending'})
 if(remaining.some(r=>m.runIds.includes(r.runId)))fail('CLEANUP_READBACK_FAILED')
 console.log(JSON.stringify({receipt,remainingSelected:0,notificationAuditPath:m.notificationAuditPath}))
}finally{await store.close()}
