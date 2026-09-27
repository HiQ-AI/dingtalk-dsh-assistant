import { DatabaseSync } from 'node:sqlite'
import { readFileSync,readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceStatus } from '../../../../packages/dingtalk-dsh-assistant/execution-maintenance.js'
import { verifyDeploymentBackup, verifyDeploymentWeb, checkpointDeploymentDatabase } from '../../../../scripts/deployment-integrity.mjs'
const root='D:/dsh_home/workflows/runtime-v2',db=new DatabaseSync(root+'/control.sqlite',{readOnly:true})
const hash=b=>createHash('sha256').update(b).digest('hex'),digest=v=>hash(JSON.stringify(v))
const [mode,arg,source,installed]=process.argv.slice(2)
try {
 if(mode==='checkpoint'){
  const probe = () => {
   const result=spawnSync('pwsh',['-NoProfile','-File',fileURLToPath(new URL('../../../../scripts/check-workflow-quiescence.ps1',import.meta.url)),'-RuntimePid',arg,'-RuntimePort','18998','-ScheduledTaskName','DSH Web Local'],{encoding:'utf8',windowsHide:true})
   if(result.status!==0)throw Error('CHECKPOINT_STOP_PROBE_FAILED')
   return JSON.parse(result.stdout)
  }
  console.log(JSON.stringify(await checkpointDeploymentDatabase({dbPath:root+'/control.sqlite',instanceId:'dsh-web-runtime-v2-20260924',probeStopped:probe})))
 }else if(mode==='backup-verify'){
  console.log(JSON.stringify(await verifyDeploymentBackup({ runtime:root,domain:'D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116',profile:'D:/dsh_home/profiles/web',backupRoot:arg })))
 }else if(mode==='web'){
  console.log(JSON.stringify(await verifyDeploymentWeb(arg)))
 }else if(mode==='maintenance'){
  db.exec('BEGIN');try{console.log(JSON.stringify(maintenanceStatus(db)))}finally{db.exec('ROLLBACK')}
 }else if(mode==='lock'){
  const owner=new DatabaseSync(root+'/control.sqlite.owner.sqlite')
  try{owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');console.log('LOCKED');process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve))}
  finally{try{owner.exec('ROLLBACK')}catch{}owner.close()}
 }else if(mode==='snapshot'||mode==='verify') {
  db.exec('BEGIN')
  const tasks=db.prepare('SELECT task_id FROM business_tasks UNION SELECT task_id FROM execution_runs ORDER BY task_id').all().map(x=>x.task_id)
  const nodes=db.prepare('SELECT * FROM execution_nodes WHERE current=0 ORDER BY node_run_id').all().map(r=>({id:r.node_run_id,digest:digest(r)}))
  const runs=db.prepare("SELECT * FROM execution_runs WHERE status IN ('succeeded','failed','cancelled') ORDER BY run_id").all().map(r=>({id:r.run_id,digest:digest(r)}))
  const domain=JSON.parse(readFileSync('D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116/dingtalk_dsh_assistant.json','utf8'))
  const legacy=Object.entries(domain.tables?.tasks??{}).map(([id,row])=>({id,digest:digest(row)}))
  if(mode==='snapshot') {
   const maintenance=maintenanceStatus(db),{nodes:busyNodes,owners:busyOwners,effects,messages}=maintenance.busy
   if(!maintenance.drained)throw Error(`DEPLOY_NOT_DRAINED:nodes=${busyNodes},owners=${busyOwners},effects=${effects},messages=${messages}`)
   console.log(JSON.stringify({tasks,nodes,runs,legacy,maintenance}))
  }else{
   const old=JSON.parse(readFileSync(arg,'utf8'))
   if(old.tasks.some(id=>!tasks.includes(id)))throw Error('DEPLOY_TASK_IDENTITY_LOST')
   for(const [name,rows]of Object.entries({nodes,runs,legacy}))for(const item of old[name]){
    if(rows.find(x=>x.id===item.id)?.digest!==item.digest)throw Error('DEPLOY_HISTORY_CHANGED:'+name+':'+item.id)
   }
   console.log(JSON.stringify({verified:true,tasks:old.tasks.length,oldNodes:old.nodes.length,oldRuns:old.runs.length,legacy:old.legacy.length}))
  }
  db.exec('ROLLBACK')
 }else if(mode==='package'){
  const contents=spawnSync('tar',['-tf',arg],{encoding:'utf8',windowsHide:true});if(contents.status!==0)throw Error('PACKAGE_UNREADABLE')
  const names=contents.stdout.trim().split(/\r?\n/)
  const files=readdirSync(source).filter(f=>f.endsWith('.js')||f==='cordis.patch.yml'||f==='package.json')
  for(const file of files){
   if(names.filter(x=>x==='package/'+file).length!==1)throw Error('PACKAGE_FILE_MISSING:'+file)
   const packed=spawnSync('tar',['-xOf',arg,'package/'+file],{windowsHide:true,maxBuffer:32*1024*1024})
   if(packed.status!==0)throw Error('PACKAGE_EXTRACT_FAILED')
   const expected=readFileSync(join(source,file));const same=(a,b)=>file==='package.json'?JSON.stringify(JSON.parse(a))===JSON.stringify(JSON.parse(b)):hash(a)===hash(b)
   if(!same(packed.stdout,expected))throw Error('PACKAGE_SOURCE_MISMATCH:'+file)
   if(installed&&!same(readFileSync(join(installed,file)),expected))throw Error('INSTALLED_SOURCE_MISMATCH:'+file)
  }
  if(names.some(n=>n.endsWith('.js')&&!files.includes(n.slice('package/'.length))))throw Error('PACKAGE_UNEXPECTED_SOURCE')
  console.log(JSON.stringify({verifiedFiles:files.length,sha256:hash(readFileSync(arg))}))
 }else throw Error('INVALID_MODE')
}catch(error){console.error(error.message);process.exitCode=1}finally{db.close()}
