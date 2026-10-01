import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerMessageImpact } from '../packages/dingtalk-dsh-assistant/message-ledger.js'
import { validateTaskPlanSchema } from '../packages/dingtalk-dsh-assistant/execution-task-plan.js'

const reject = code => { throw new Error(code) }
const scalar = (db,sql) => Object.values(db.prepare(sql).get())[0]
const audit = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{
  const hash=createHash('sha256');let count=0
  for(const row of db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).iterate()){
    if(name==='message_items'&&row.kind==='impact')continue
    if(name==='execution_meta')delete row.schema_version
    if(name==='task_plan_stages')delete row.source_condition
    hash.update(JSON.stringify(row));hash.update('\n');count++
  }
  return [name,{count,sha256:hash.digest('hex')}]
}))
function integrity(db){
  if(scalar(db,'PRAGMA integrity_check')!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)reject('MIGRATION_INTEGRITY_FAILED')
}
export function verifyMessageImpact(db,{baseline}={}){
  if(scalar(db,'PRAGMA user_version')!==6||scalar(db,'SELECT schema_version FROM execution_meta WHERE singleton=1')!==6)reject('MIGRATION_SCHEMA_MISMATCH')
  integrity(db);validateTaskPlanSchema(db,{sourceConditions:true})
  const sources=db.prepare('SELECT run_id,body FROM message_runs').all()
  for(const row of sources){
    const source=JSON.parse(row.body),item=db.prepare("SELECT body FROM message_items WHERE kind='impact' AND run_id=? AND item_id=?").get(row.run_id,'impact:'+row.run_id)
    if(!item)reject('MIGRATION_IMPACT_MISSING')
    const impact=JSON.parse(item.body)
    if(impact.runId!==row.run_id||impact.sourceVersion!==source.sourceVersion)reject('MIGRATION_IMPACT_INVALID')
  }
  const current=audit(db)
  if(baseline)for(const [name,value] of Object.entries(baseline))if(JSON.stringify(current[name])!==JSON.stringify(value))reject('MIGRATION_READBACK_FAILED')
  return {version:6,sources:sources.length,baseline:current,verified:true}
}
// 调用方必须持有 runtime 原生独占 owner 锁；CLI 在下方自行获取，部署 checker 可复用已持有的锁。
export function migrateMessageImpact(db,{path,mode}){
  if(!['check','execute'].includes(mode))reject('MIGRATION_MODE_INVALID')
  const version=scalar(db,'PRAGMA user_version'),meta=scalar(db,'SELECT schema_version FROM execution_meta WHERE singleton=1')
  if(version!==meta||![5,6].includes(version))reject('MIGRATION_SCHEMA_MISMATCH')
  integrity(db)
  const baseline=audit(db),sourceRows=db.prepare('SELECT body FROM message_runs ORDER BY rowid').all()
  if(version===6){const verified=verifyMessageImpact(db,{baseline});return {...verified,mode,status:'already-migrated',fromVersion:6,toVersion:6,writable:false}}
  if(mode==='check')return {mode,fromVersion:version,toVersion:6,writable:false,sources:sourceRows.length,baseline}
  if(!isAbsolute(path??''))reject('MIGRATION_PATH_INVALID')
  const backupPath=path+'.pre-impact-v6-'+randomUUID()+'.sqlite'
  db.prepare('VACUUM INTO ?').run(backupPath)
  const backup=new DatabaseSync(backupPath,{readOnly:true})
  try{if(JSON.stringify(audit(backup))!==JSON.stringify(baseline)||scalar(backup,'PRAGMA integrity_check')!=='ok')reject('MIGRATION_BACKUP_INVALID')}finally{backup.close()}
  try{
    db.exec('BEGIN IMMEDIATE')
    if(scalar(db,'PRAGMA user_version')!==5||JSON.stringify(audit(db))!==JSON.stringify(baseline))reject('MIGRATION_SOURCE_CHANGED')
    for(const row of sourceRows)registerMessageImpact(db,JSON.parse(row.body),new Date().toISOString())
    if(!db.prepare('PRAGMA table_info(task_plan_stages)').all().some(column=>column.name==='source_condition'))
      db.exec('ALTER TABLE task_plan_stages ADD COLUMN source_condition TEXT CHECK(source_condition IS NULL OR json_valid(source_condition))')
    db.exec('PRAGMA user_version=6; UPDATE execution_meta SET schema_version=6 WHERE singleton=1')
    verifyMessageImpact(db,{baseline});db.exec('COMMIT')
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
  const reopened=new DatabaseSync(path,{readOnly:true})
  try{verifyMessageImpact(reopened,{baseline})}finally{reopened.close()}
  return {mode,version:6,sources:sourceRows.length,backupPath,baseline,verified:true}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [, , mode, path] = process.argv
  if(!['--check','--execute'].includes(mode)||!isAbsolute(path??'')||!existsSync(path)||!statSync(path).isFile()){
    console.error('用法: node scripts/migrate-message-impact.js --check|--execute <absolute-db-path>');process.exitCode=2
  }else{
    let owner,db
    try{
      if(mode==='--execute'){owner=new DatabaseSync(path+'.owner.sqlite');owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')}
      // 普通只读连接也可能创建 WAL；离线 immutable 连接保证 --check 零写。
      if(mode==='--check'&&existsSync(path+'-wal')&&statSync(path+'-wal').size>0)reject('MIGRATION_CHECK_REQUIRES_OFFLINE_CHECKPOINT')
      db=new DatabaseSync(mode==='--check'?pathToFileURL(path).href+'?immutable=1':path,{readOnly:mode==='--check'})
      console.log(JSON.stringify(migrateMessageImpact(db,{path,mode:mode.slice(2)})))
    }finally{db?.close();if(owner){try{owner.exec('ROLLBACK')}catch{}owner.close()}}
  }
}
