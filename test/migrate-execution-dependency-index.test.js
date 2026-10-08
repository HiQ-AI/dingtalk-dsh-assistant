import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { migrateExecutionDependencyIndex } from '../scripts/migrate-execution-dependency-index.mjs'

test('必要依赖索引8到9零业务变更、check零写、可重启且重复迁移幂等', async t => {
 const root=await mkdtemp(join(tmpdir(),'dependency-migration-')), path=join(root,'control.sqlite')
 t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await openExecutionStore({dbPath:path,instanceId:'dependency-migration',initialize:true})
 await store.command({id:'maintenance',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'migration',actorId:'owner',reason:'migration'}})
 await store.command({id:'seal',kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'migration',actorId:'owner',reason:'migration'}})
 await store.close()
 const db=new DatabaseSync(path)
 try {
  db.exec("DROP INDEX execution_one_active_task; CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id) WHERE status NOT IN ('succeeded','failed','cancelled'); PRAGMA user_version=8; UPDATE execution_meta SET schema_version=8")
  const check=migrateExecutionDependencyIndex(db,{mode:'check'})
  assert.equal(check.writes,0);assert.equal(db.prepare('PRAGMA user_version').get().user_version,8)
  const migrated=migrateExecutionDependencyIndex(db,{mode:'execute'})
  assert.deepEqual(migrated.baseline,check.baseline)
  assert.equal(migrateExecutionDependencyIndex(db,{mode:'execute'}).alreadyMigrated,true)
  const insert=db.prepare("INSERT INTO execution_runs(run_id,task_id,workflow_id,workflow_digest,requirement_ref,status,recovery_reason,created_at,updated_at) VALUES(?,?, 'test', ?, 'ref', 'waiting', ?, 'now','now')")
  insert.run('ordinary','task', 'a'.repeat(64),null)
  assert.throws(()=>insert.run('other','task','a'.repeat(64),null),/UNIQUE/)
  db.prepare("UPDATE execution_runs SET recovery_reason='stage-dependency' WHERE run_id='ordinary'").run()
  insert.run('other','task','a'.repeat(64),null)
  assert.throws(()=>insert.run('third','task','a'.repeat(64),'anything-else'),/UNIQUE/)
  db.prepare("DELETE FROM execution_runs WHERE task_id='task'").run()
 } finally {db.close()}
 const reopened=await openExecutionStore({dbPath:path,instanceId:'dependency-migration'})
 await reopened.close()
})
