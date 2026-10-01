import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { defaultMessagePolicy } from '../packages/dingtalk-dsh-assistant/message-workflow.js'
import { maintenanceStatus } from '../packages/dingtalk-dsh-assistant/execution-maintenance.js'
const fail=code=>{throw Object.assign(Error(code),{code})}
const hash=value=>createHash('sha256').update(value).digest('hex')
const occurredAt=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN
export function buildReplaySources(sources,batchId){
 if(!/^[a-zA-Z0-9-]{8,80}$/.test(batchId??'')||!Array.isArray(sources)||sources.length!==12||new Set(sources.map(s=>s.sourceKey)).size!==12||new Set(sources.map(s=>s.conversationId)).size!==1)fail('REPLAY_SOURCE_MANIFEST_INVALID')
 return sources.map(s=>{
  if(['sourceKey','actorId','conversationId','body'].some(key=>typeof s[key]!=='string'||!s[key])||!s.context?.sourceMessageId||!Number.isFinite(occurredAt(s.context.occurredAt)))fail('REPLAY_SOURCE_INVALID')
  const context=structuredClone(s.context)
  // 该句属于过时编排提示，不是业务原文；保留其余材料和身份。
  if(typeof context.compactPolicy==='string')context.compactPolicy=context.compactPolicy.replaceAll('意图节点','协调输入')
  const suffix=hash(JSON.stringify([batchId,s.sourceKey])).slice(0,32)
  return {runId:`msg-replay-${suffix}`,sourceKey:s.sourceKey,sourceVersion:1,actorId:s.actorId,conversationId:s.conversationId,body:s.body,context,policy:defaultMessagePolicy}
 }).sort((a,b)=>occurredAt(a.context.occurredAt)-occurredAt(b.context.occurredAt)||a.sourceKey.localeCompare(b.sourceKey))
}
export function checkReplayDatabase(db,manifest,runs){
 if(db.prepare('SELECT instance_id FROM execution_meta WHERE singleton=1').get()?.instance_id!==manifest.instanceId)fail('REPLAY_INSTANCE_CHANGED')
 const state=maintenanceStatus(db)
 if(!state.active||state.phase!=='stopping'||!state.drained||state.maintenanceId!==manifest.maintenanceId||state.revision!==manifest.maintenanceRevision)fail('REPLAY_MAINTENANCE_REQUIRED')
 for(const r of runs){
  if(db.prepare('SELECT 1 FROM message_sources WHERE source_key=?').get(r.sourceKey)||db.prepare('SELECT 1 FROM message_runs WHERE run_id=? OR source_key=?').get(r.runId,r.sourceKey))fail('REPLAY_SOURCE_NOT_CLEAN')
  if(db.prepare('SELECT 1 FROM execution_receipts WHERE command_id=?').get(`source-replay:${r.runId}`))fail('REPLAY_RECEIPT_EXISTS')
 }
 return {maintenance:state,taskIds:db.prepare('SELECT task_id FROM business_tasks ORDER BY task_id').all().map(r=>r.task_id)}
}
export async function receiveReplaySources(store,runs){
 const receipts=[]
 for(const args of runs)receipts.push(await store.command({id:`source-replay:${args.runId}`,kind:'message.receive',args}))
 for(const expected of runs){
  const current=await store.query({kind:'message.source',sourceKey:expected.sourceKey})
  const state=await store.query({kind:'message.run',runId:expected.runId})
  if(current?.runId!==expected.runId||current.sourceVersion!==1||state.commands.length||state.nodes.length||state.run.body!==expected.body||state.run.actorId!==expected.actorId)fail('REPLAY_READBACK_FAILED')
 }
 return receipts
}
async function main(){
 const [mode,manifestPath]=process.argv.slice(2)
 if(!['--check','--execute'].includes(mode)||!manifestPath)fail('REPLAY_ARGUMENTS_INVALID')
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
 if(!Number.isSafeInteger(manifest.expectedPid)||manifest.expectedPid<1)fail('REPLAY_PID_REQUIRED')
 const raw=await readFile(manifest.sourcesPath)
 if(hash(raw)!==manifest.sourcesSha256)fail('REPLAY_SOURCE_DIGEST_CHANGED')
 const runs=buildReplaySources(JSON.parse(raw.toString('utf8')),manifest.batchId)
 const alive=()=>{try{process.kill(manifest.expectedPid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}
 const inspect=()=>{const db=new DatabaseSync(manifest.dbPath,{readOnly:true});try{db.exec('BEGIN');return checkReplayDatabase(db,manifest,runs)}finally{db.close()}}
 const checked=inspect()
 if(mode==='--check'){console.log(JSON.stringify({eligible:!alive(),writes:0,oldProcessAlive:alive(),...checked,sources:runs.map(r=>({runId:r.runId,sourceKey:r.sourceKey,sourceVersion:r.sourceVersion,occurredAt:r.context.occurredAt}))}));return}
 if(alive())fail('REPLAY_OLD_PROCESS_ALIVE')
 const store=await openExecutionStore({dbPath:manifest.dbPath,instanceId:manifest.instanceId})
 try{
  inspect() // 取得原生 owner 独占后再次检查；只读连接不执行恢复写入。
  await receiveReplaySources(store,runs)
 }finally{await store.close()}
 const db=new DatabaseSync(manifest.dbPath,{readOnly:true})
 try{
  db.exec('BEGIN')
  const tasks=db.prepare('SELECT task_id FROM business_tasks ORDER BY task_id').all().map(r=>r.task_id)
  if(JSON.stringify(tasks)!==JSON.stringify(checked.taskIds))fail('REPLAY_TASK_CREATED')
  for(const run of runs){const source=db.prepare('SELECT current_version FROM message_sources WHERE source_key=?').get(run.sourceKey);const persisted=db.prepare('SELECT source_key,source_version FROM message_runs WHERE run_id=?').get(run.runId);if(source?.current_version!==1||persisted?.source_key!==run.sourceKey||persisted?.source_version!==1)fail('REPLAY_READBACK_FAILED');const items=db.prepare("SELECT count(*) AS n FROM message_items WHERE run_id=? AND kind IN ('command','node','notification')").get(run.runId);if(items.n)fail('REPLAY_EARLY_DISPATCH')}
  console.log(JSON.stringify({received:runs.length,sourceKeys:runs.map(r=>r.sourceKey),runIds:runs.map(r=>r.runId),taskIds:tasks,commands:0,nodes:0,notifications:0,maintenance:maintenanceStatus(db)}))
 }finally{db.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code??error.message);process.exitCode=1})
