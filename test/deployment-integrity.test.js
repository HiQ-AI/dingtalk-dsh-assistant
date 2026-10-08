import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, cp, readFile, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyDeploymentTaskDirectory, checkDeploymentTaskDirectory, verifyDeploymentBackup, reverifyDeploymentBackup, verifyDeploymentWeb, verifyArtifactClosure } from '../scripts/deployment-integrity.mjs'

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'deployment-proof-')),runtime=join(root,'runtime'),domain=join(root,'domain'),profile=join(root,'profile'),backupRoot=join(root,'backup')
  for(const path of [runtime,domain,profile,join(runtime,'artifacts'),backupRoot])await mkdir(path,{recursive:true})
  const artifact=Buffer.from('{"result":true}'),ref=`sha256-${createHash('sha256').update(artifact).digest('hex')}.json`
  await writeFile(join(runtime,'artifacts',ref),artifact);await writeFile(join(domain,'domain.json'),'{}');await writeFile(join(profile,'cordis.patch.yml'),'a: 1')
  const db=new DatabaseSync(join(runtime,'control.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY,output_ref TEXT)');db.prepare('INSERT INTO records VALUES(1,?)').run(ref)
  await cp(runtime,join(backupRoot,'runtime'),{recursive:true});await cp(domain,join(backupRoot,'domain'),{recursive:true});await cp(profile,join(backupRoot,'profile'),{recursive:true})
  return {root,runtime,domain,profile,backupRoot,db,ref}
}
test('备份验证包含WAL最新提交、全文件清单、完整性及工件引用',async t=>{
  const f=await fixture();t.after(()=>f.db.close())
  const proof=await verifyDeploymentBackup(f)
  assert.equal(proof.verified,true);assert.equal(proof.database.artifactRefs,1)
  const restored=new DatabaseSync(join(f.backupRoot,proof.database.restoreFile),{readOnly:true})
  try{assert.equal(restored.prepare('SELECT output_ref FROM records WHERE id=1').get().output_ref,f.ref)}finally{restored.close()}
  assert.ok(proof.manifest.some(item=>item.path.endsWith('control.sqlite-wal')))
})
for (const change of ['none','profile','backup','domain','new-domain','new-artifact','wal']) test(`失败启动只读复核原备份：${change}`,async t=>{
  const f=await fixture();t.after(()=>f.db.close())
  const proof=await verifyDeploymentBackup(f)
  await writeFile(join(f.backupRoot,'manifest.json'),JSON.stringify(proof))
  if(change==='profile')await writeFile(join(f.profile,'package.json'),'{"new":"installation"}')
  if(change==='backup')await writeFile(join(f.backupRoot,'profile/cordis.patch.yml'),'changed')
  if(change==='domain')await writeFile(join(f.domain,'domain.json'),'changed')
  if(change==='new-domain')await writeFile(join(f.domain,'new.json'),'{}')
  if(change==='new-artifact')await writeFile(join(f.runtime,'artifacts/new.json'),'{}')
  if(change==='wal')await writeFile(join(f.backupRoot,'runtime/verified-control.sqlite-wal'),'transaction')
  if(['none','profile'].includes(change))assert.equal((await reverifyDeploymentBackup(f)).writes,0)
  else await assert.rejects(reverifyDeploymentBackup(f),/BACKUP_(COPY_MISMATCH|SOURCE_CHANGED|SOURCE_FILE_SET_CHANGED|DATABASE_SIDECAR_INVALID)/)
})

test('备份WAL破损和工件缺失均拒绝',async t=>{
  const f=await fixture();t.after(()=>f.db.close())
  await writeFile(join(f.backupRoot,'runtime','control.sqlite-wal'),'corrupt')
  await assert.rejects(verifyDeploymentBackup(f),/BACKUP_COPY_MISMATCH/)
  const g=await fixture();t.after(()=>g.db.close())
  await writeFile(join(g.backupRoot,'runtime/artifacts','unexpected.json'),'{}')
  await assert.rejects(verifyDeploymentBackup(g),/BACKUP_FILE_SET_MISMATCH/)
})
for(const broken of ['missing','corrupt',null])test(`数据库到工件闭包回读：${broken??'完整重复引用'}`,async t=>{
 const f=await fixture();t.after(()=>f.db.close())
 const child=Buffer.from('{"result":"child"}'),childRef=`sha256-${createHash('sha256').update(child).digest('hex')}.json`
 const parent=Buffer.from(JSON.stringify({outputRef:childRef,evidenceRefs:[childRef],text:`sha256-${'f'.repeat(64)}.json`,description:JSON.stringify({outputRef:`sha256-${'e'.repeat(64)}.json`})}))
 const parentRef=`sha256-${createHash('sha256').update(parent).digest('hex')}.json`
 await writeFile(join(f.runtime,'artifacts',parentRef),parent)
 if(broken!=='missing')await writeFile(join(f.runtime,'artifacts',childRef),broken==='corrupt'?'{}':child)
 f.db.prepare('UPDATE records SET output_ref=?').run(parentRef)
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true})
 if(broken)await assert.rejects(verifyDeploymentBackup(f),broken==='missing'?/BACKUP_ARTIFACT_MISSING/:/BACKUP_ARTIFACT_INVALID/)
 else assert.equal((await verifyDeploymentBackup(f)).database.artifactRefs,2)
})
test('引用闭包按内容去重且数量/字节超限显式拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'artifact-closure-'))
 const put=async value=>{const bytes=Buffer.from(JSON.stringify(value)),ref=`sha256-${createHash('sha256').update(bytes).digest('hex')}.json`;await writeFile(join(root,ref),bytes);return ref}
 const child=await put({result:true}),parent=await put({evidenceRefs:[child,child]})
 assert.equal((await verifyArtifactClosure(root,[parent,parent])).artifactRefs,2)
 await assert.rejects(verifyArtifactClosure(root,[parent],{maxArtifacts:1}),/BACKUP_ARTIFACT_CAPACITY/)
 await assert.rejects(verifyArtifactClosure(root,[parent],{maxBytes:1}),/BACKUP_ARTIFACT_CAPACITY/)
})
test('HTTP正常但恢复报错或认证失败不得部署ready，凭据不出现在结果',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deployment-web-')),log=join(root,'web.log')
  await writeFile(log,'http://127.0.0.1:3080/?token=secret-token')
  let calls=0
  await assert.rejects(verifyDeploymentWeb(log,async()=>{calls++;return Response.json({status:'degraded',recoveryIssueCount:1})}),/DEPLOY_RECOVERY_ISSUES/)
  assert.equal(calls,1)
  const health=()=>Response.json({recoveryIssueCount:0,status:'degraded',inboundProcessing:false})
  await assert.rejects(verifyDeploymentWeb(log,async(url)=>String(url).includes('/health')?health():new Response(null,{status:401})),/DEPLOY_WEB_AUTH_FAILED/)
  const proof=await verifyDeploymentWeb(log,async(url,options)=>{
    if(String(url).includes('/health'))return health()
    if(new URL(url).searchParams.has('token'))return new Response(null,{status:303,headers:{location:'/', 'set-cookie':'dsh=secret-cookie; Path=/'}})
    assert.equal(options.headers.cookie,'dsh=secret-cookie');return new Response('<!doctype html><html></html>')
  })
  assert.equal(proof.authenticatedWebStatus,200);assert.equal(proof.inboundProcessing,false);assert.equal(JSON.stringify(proof).includes('secret'),false)
})

async function taskFixture(t) {
 const f=await fixture();t.after(()=>f.db.close())
 const taskDirectory=join(f.root,'workspace/tasks'),artifactDirectory=join(taskDirectory,'family-1/work/artifacts')
 await mkdir(artifactDirectory,{recursive:true});await mkdir(join(taskDirectory,'family-1/outputs'),{recursive:true})
 const bytes=Buffer.from(JSON.stringify({outputRef:f.ref})),name=`sha256-${createHash('sha256').update(bytes).digest('hex')}.json`,ref=`tasks/family-1/${name}`
 await writeFile(join(artifactDirectory,name),bytes);await writeFile(join(taskDirectory,'family-1/outputs/report.md'),'交付物')
 f.db.prepare('UPDATE records SET output_ref=?').run(ref)
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true});await cp(taskDirectory,join(f.backupRoot,'tasks'),{recursive:true})
 return {...f,taskDirectory,taskRef:ref,name}
}
test('任务目录check拒绝漏参/错误根且不写业务数据或工件',async t=>{
 const f=await taskFixture(t),dbPath=join(f.runtime,'control.sqlite')
 const before=await readFile(dbPath),beforeWal=await readFile(`${dbPath}-wal`),entries=await readdir(f.taskDirectory,{recursive:true})
 await assert.rejects(checkDeploymentTaskDirectory({dbPath}),/BACKUP_TASK_DIRECTORY_REQUIRED/)
 await assert.rejects(checkDeploymentTaskDirectory({dbPath,taskDirectory:'relative'}),/BACKUP_TASK_DIRECTORY_INVALID/)
 const wrongRoot=join(f.root,'wrong-tasks');await mkdir(wrongRoot)
 await assert.rejects(checkDeploymentTaskDirectory({dbPath,taskDirectory:wrongRoot}),/BACKUP_ARTIFACT_MISSING/)
 const result=await checkDeploymentTaskDirectory({dbPath,taskDirectory:f.taskDirectory})
 assert.equal(result.writes,0);assert.equal(result.taskArtifactRefs,1)
 assert.deepEqual(await readFile(dbPath),before);assert.deepEqual(await readFile(`${dbPath}-wal`),beforeWal)
 assert.deepEqual(await readdir(f.taskDirectory,{recursive:true}),entries)
})
test('新旧引用闭包与全部任务交付物均进入备份，缺根不能静默成功',async t=>{
 const f=await taskFixture(t)
 await assert.rejects(verifyArtifactClosure(join(f.runtime,'artifacts'),[f.taskRef]),/BACKUP_TASK_DIRECTORY_REQUIRED/)
 const proof=await verifyDeploymentBackup(f)
 assert.equal(proof.database.artifactRefs,2)
 assert.ok(proof.manifest.some(item=>item.path==='tasks/family-1/outputs/report.md'))
 await writeFile(join(f.backupRoot,'manifest.json'),JSON.stringify(proof))
 assert.equal((await reverifyDeploymentBackup(f)).writes,0)
 await assert.rejects(reverifyDeploymentBackup({...f,taskDirectory:undefined}),/BACKUP_TASK_DIRECTORY_REQUIRED/)
 await writeFile(join(f.taskDirectory,'family-1/outputs/new.md'),'新增')
 await assert.rejects(reverifyDeploymentBackup(f),/BACKUP_SOURCE_FILE_SET_CHANGED/)
})
test('新任务引用不会被数据库采集忽略，缺少任务备份拒绝',async t=>{
 const f=await taskFixture(t)
 await assert.rejects(verifyDeploymentBackup({...f,taskDirectory:undefined}),/BACKUP_TASK_DIRECTORY_REQUIRED/)
})
test('任务根中的junction不纳入备份，任务ref不能穿越',async t=>{
 const f=await taskFixture(t),outside=join(f.root,'outside')
 await mkdir(outside);await symlink(outside,join(f.taskDirectory,'escape'),'junction')
 await assert.rejects(checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory}),/BACKUP_LINK_UNSAFE/)
 await assert.rejects(verifyArtifactClosure(join(f.runtime,'artifacts'),[`tasks/../${f.name}`],{taskDirectory:f.taskDirectory}),/BACKUP_ARTIFACT_INVALID/)
})

test('工程源码副本的node_modules明确排除，复制不遍历链接且其他文件完整核验',async t=>{
 const f=await taskFixture(t),repo=join(f.taskDirectory,'family-1/work/engineering','a'.repeat(24),`ws-${'b'.repeat(64)}`,'repository')
 const modules=join(repo,'node_modules'),outside=join(f.root,'external-dependencies')
 await mkdir(modules,{recursive:true});await mkdir(outside)
 await writeFile(join(outside,'not-a-task.txt'),'不能复制的共享依赖')
 await symlink(outside,join(modules,'dependency'),'junction')
 await writeFile(join(repo,'package.json'),'{}');await writeFile(join(repo,'source.js'),'source')
 const nested=join(repo,'packages/web');await mkdir(nested,{recursive:true});await symlink(outside,join(nested,'node_modules'),'junction')
 const checked=await checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory})
 assert.equal(checked.taskBackupExclusions.length,2)
 const backupRoot=join(f.root,'filtered-backup');await mkdir(backupRoot)
 for(const name of ['runtime','domain','profile'])await cp(f[name],join(backupRoot,name),{recursive:true})
 const copied=await copyDeploymentTaskDirectory({taskDirectory:f.taskDirectory,destination:join(backupRoot,'tasks')})
 assert.deepEqual(copied.taskBackupExclusions,checked.taskBackupExclusions)
 const paths=await readdir(join(backupRoot,'tasks'),{recursive:true})
 assert.equal(paths.some(path=>path.includes('node_modules')),false)
 assert.equal(paths.some(path=>path.endsWith('source.js')),true)
 const proof=await verifyDeploymentBackup({...f,backupRoot})
 assert.deepEqual(proof.taskBackupExclusions,checked.taskBackupExclusions)
 await writeFile(join(backupRoot,'manifest.json'),JSON.stringify(proof))
 await writeFile(join(outside,'dependency-change.txt'),'可再生依赖变化')
 assert.equal((await reverifyDeploymentBackup({...f,backupRoot})).verified,true)
 await mkdir(join(f.taskDirectory,'family-1/outputs/node_modules'))
 await symlink(outside,join(f.taskDirectory,'family-1/outputs/node_modules/unsafe'),'junction')
 await assert.rejects(checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory}),/BACKUP_LINK_UNSAFE/)
})

test('schema6部署在同一owner锁内迁移，其他owner拒绝且历史证明可独立回读',async t=>{
  const { PassThrough }=await import('node:stream')
  const { openExecutionStore }=await import('../packages/dingtalk-dsh-assistant/execution-store.js')
  const { holdDeploymentOwnerLock }=await import('../docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs')
  const { verifyMessageImpact }=await import('../scripts/migrate-message-impact.js')
  const root=await mkdtemp(join(tmpdir(),'deploy-impact-')),dbPath=join(root,'control.sqlite')
  const store=await openExecutionStore({dbPath,instanceId:'deploy-impact-test',initialize:true})
  await store.command({id:'receive',kind:'message.receive',args:{runId:'source',sourceKey:'source',sourceVersion:1,conversationId:'g',actorId:'a',body:'原始消息不可改写'}})
  await store.close()
  const setup=new DatabaseSync(dbPath)
  setup.exec("DELETE FROM message_items WHERE kind='impact'; PRAGMA user_version=5; UPDATE execution_meta SET schema_version=5")
  setup.prepare('INSERT INTO execution_events(kind,payload,created_at) VALUES(?,?,?)').run('runtime.maintenance.changed',JSON.stringify({active:true,phase:'stopping',maintenanceId:'deploy-test'}),new Date().toISOString())
  setup.close()
  const input=new PassThrough(),lines=[]
  let migrated
  const ready=new Promise(resolve=>{migrated=resolve})
  const running=holdDeploymentOwnerLock({dbPath,input,writeLine:line=>{lines.push(line);if(line!=='LOCKED')migrated()}})
  assert.deepEqual(lines,['LOCKED'])
  const rival=new DatabaseSync(dbPath+'.owner.sqlite')
  assert.throws(()=>rival.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'),/locked/)
  await assert.rejects(holdDeploymentOwnerLock({dbPath,input:new PassThrough(),writeLine:()=>{}}),/locked/)
  input.write('migrate-message-impact\n')
  await ready
  const proof=JSON.parse(lines[1]);assert.equal(proof.verified,true)
  assert.throws(()=>rival.exec('BEGIN EXCLUSIVE'),/locked/)
  const readback=new DatabaseSync(dbPath,{readOnly:true})
  assert.equal(verifyMessageImpact(readback,{baseline:proof.baseline}).verified,true)
  assert.match(readback.prepare('SELECT body FROM message_runs').get().body,/原始消息不可改写/)
  readback.close()
  input.end();await running
  rival.exec('BEGIN EXCLUSIVE; ROLLBACK');rival.close()
})

test('必要依赖索引部署持owner锁迁移并独立回读原数据',async t=>{
 const {PassThrough}=await import('node:stream')
 const {openExecutionStore}=await import('../packages/dingtalk-dsh-assistant/execution-store.js')
 const {holdDeploymentOwnerLock}=await import('../docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs')
 const {verifyExecutionDependencyIndex}=await import('../scripts/migrate-execution-dependency-index.mjs')
 const root=await mkdtemp(join(tmpdir(),'deploy-dependency-')),dbPath=join(root,'control.sqlite')
 t.after(async()=>{const {rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true})})
 const store=await openExecutionStore({dbPath,instanceId:'deploy-dependency',initialize:true})
 await store.command({id:'enter',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'test',actorId:'owner',reason:'test'}})
 await store.command({id:'seal',kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'test',actorId:'owner',reason:'test'}})
 await store.close()
 const setup=new DatabaseSync(dbPath)
 setup.exec("DROP INDEX execution_one_active_task; CREATE UNIQUE INDEX execution_one_active_task ON execution_runs(task_id) WHERE status NOT IN ('succeeded','failed','cancelled'); PRAGMA user_version=8; UPDATE execution_meta SET schema_version=8")
 setup.close()
 const input=new PassThrough(),lines=[];let received
 const ready=new Promise(resolve=>{received=resolve})
 const running=holdDeploymentOwnerLock({dbPath,input,writeLine:line=>{lines.push(line);if(line!=='LOCKED')received()}})
 const rival=new DatabaseSync(dbPath+'.owner.sqlite')
 assert.throws(()=>rival.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'),/locked/)
 input.write(JSON.stringify({command:'migrate-execution-dependency-index',expectedStoppedPid:2147483647})+'\n')
 await ready
 const proof=JSON.parse(lines[1]);assert.equal(proof.version,9);assert.equal(proof.verified,true)
 const readback=new DatabaseSync(dbPath,{readOnly:true})
 assert.equal(verifyExecutionDependencyIndex(readback,{baseline:proof.baseline}).verified,true)
 readback.close();assert.throws(()=>rival.exec('BEGIN EXCLUSIVE'),/locked/)
 input.end();await running;rival.exec('BEGIN EXCLUSIVE; ROLLBACK');rival.close()
})

test('Adapter专用包检查零写并核对provider实际解析，旧副本与源漂移拒绝',async()=>{
  const {execFileSync}=await import('node:child_process')
  const {verifyAdapterPackage}=await import('../docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs')
  const root=await mkdtemp(join(tmpdir(),'adapter-deploy-')),staging=join(root,'staging'),source=join(root,'source'),profile=join(root,'profile')
  await mkdir(join(staging,'package/lib'),{recursive:true})
  const manifest={name:'@deepseek-ai/dsh-llm-pi-ai',version:'1.0.0',main:'lib/index.js'}
  await writeFile(join(staging,'package/package.json'),JSON.stringify(manifest))
  await writeFile(join(staging,'package/lib/index.js'),'export const nativeStop=true')
  await cp(join(staging,'package'),source,{recursive:true})
  await writeFile(join(source,'not-packed.ts'),'源码不应进入打包清单对比')
  const packagePath=join(root,'adapter.tgz')
  execFileSync('tar',['-czf',packagePath,'-C',staging,'package/package.json','package/lib/index.js'],{windowsHide:true})
  const before=await readdir(root,{recursive:true})
  assert.equal(verifyAdapterPackage({packagePath,sourceRoot:source}).verified,true)
  assert.deepEqual(await readdir(root,{recursive:true}),before)
  await mkdir(join(profile,'node_modules/dsh-codex-connect/lib'),{recursive:true})
  await writeFile(join(profile,'package.json'),'{}')
  await writeFile(join(profile,'node_modules/dsh-codex-connect/package.json'),JSON.stringify({name:'dsh-codex-connect',main:'lib/index.js'}))
  await writeFile(join(profile,'node_modules/dsh-codex-connect/lib/index.js'),'')
  await cp(source,join(profile,'node_modules/@deepseek-ai/dsh-llm-pi-ai'),{recursive:true})
  assert.equal(verifyAdapterPackage({packagePath,sourceRoot:source,profileRoot:profile}).verified,true)
  const nested=join(profile,'node_modules/dsh-codex-connect/node_modules/@deepseek-ai/dsh-llm-pi-ai')
  await cp(source,nested,{recursive:true});await writeFile(join(nested,'lib/index.js'),'export const nativeStop=false')
  // fresh process avoids Node resolver缓存，模拟全新启动后provider选择另一依赖副本。
  const checker=new URL('../docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs',import.meta.url).href
  const code=`import {verifyAdapterPackage} from ${JSON.stringify(checker)};verifyAdapterPackage(${JSON.stringify({packagePath,sourceRoot:source,profileRoot:profile})})`
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',code],{stdio:'pipe'}),/ADAPTER_PROVIDER_RESOLUTION_MISMATCH/)
  await writeFile(join(source,'lib/index.js'),'source changed')
  assert.throws(()=>verifyAdapterPackage({packagePath,sourceRoot:source}),/ADAPTER_SOURCE_MISMATCH/)
})

for(const mode of ['purged','ordinary-delete','no-delete','live-task','live-run','corrupt'])test(`历史任务工件备份按明确清理记录校验：${mode}`,async t=>{
 const f=await fixture();t.after(()=>f.db.close());
 const taskDirectory=join(f.root,'tasks');await mkdir(taskDirectory);
 const taskId='task-old',bytes=Buffer.from('{"old":true}'),ref=`tasks/${taskId}/sha256-${createHash('sha256').update(bytes).digest('hex')}.json`;
 f.db.exec('CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT); CREATE TABLE business_tasks(task_id TEXT); CREATE TABLE execution_runs(task_id TEXT)');
 f.db.prepare('UPDATE records SET output_ref=?').run(ref);
 if(mode!=='no-delete')f.db.prepare('INSERT INTO execution_events VALUES(1,?,?)').run('task.delete',JSON.stringify({taskId,deletedAt:'2026-10-01T10:06:24.526Z',...(mode==='ordinary-delete'?{retained:['artifact-files']}:{reason:'explicit-user-terminal-history-cleanup'})}));
 if(mode==='live-task')f.db.prepare('INSERT INTO business_tasks VALUES(?)').run(taskId);
 if(mode==='live-run')f.db.prepare('INSERT INTO execution_runs VALUES(?)').run(taskId);
 if(mode==='corrupt'){await mkdir(join(taskDirectory,taskId,'work/artifacts'),{recursive:true});await writeFile(join(taskDirectory,taskId,'work/artifacts',ref.split('/')[2]),'{}')}
 const args={dbPath:join(f.runtime,'control.sqlite'),taskDirectory};
 if(mode!=='purged')return assert.rejects(checkDeploymentTaskDirectory(args),mode.startsWith('live')?/BACKUP_PURGED_TASK_STILL_PRESENT/:mode==='corrupt'?/BACKUP_ARTIFACT_INVALID/:/BACKUP_ARTIFACT_MISSING/);
 const check=await checkDeploymentTaskDirectory(args);assert.deepEqual(check.purgedTasks,[taskId]);assert.equal(check.writes,0);
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true});await cp(taskDirectory,join(f.backupRoot,'tasks'),{recursive:true});
 const proof=await verifyDeploymentBackup({...f,taskDirectory});assert.deepEqual(proof.database.purgedArtifactRefs,[ref]);
 await writeFile(join(f.backupRoot,'manifest.json'),JSON.stringify(proof));
 const verified=await reverifyDeploymentBackup({...f,taskDirectory});assert.deepEqual(verified.purgedArtifactRefs,[ref]);assert.equal(verified.writes,0);
});

for(const known of [true,false])test(`已清理任务的原生阶段回执界定旧节点引用，不猜测run身份：${known}`,async t=>{
 const {plannedStageRunId}=await import('../packages/dingtalk-dsh-assistant/execution-controller.js');const f=await fixture();t.after(()=>f.db.close());
 f.db.exec('CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT);CREATE TABLE business_tasks(task_id TEXT);CREATE TABLE execution_runs(task_id TEXT);CREATE TABLE execution_receipts(command_id TEXT,result TEXT)');
 const taskId='task-old';f.db.prepare('INSERT INTO execution_events VALUES(1,?,?)').run('task.delete',JSON.stringify({taskId,reason:'explicit-user-terminal-history-cleanup'}));
 const runId=known?plannedStageRunId(taskId,1,'stage-1',1):'run-unknown';
 f.db.prepare('INSERT INTO execution_receipts VALUES(?,?)').run(`stage-start:${taskId}:1:stage-1:1`,JSON.stringify({historyRemoved:true}));
 const orphan='sha256-'+createHash('sha256').update('{"removed":true}').digest('hex')+'.json';
 f.db.prepare('INSERT INTO execution_receipts VALUES(?,?)').run('node-claim-old',JSON.stringify({binding:{runId,inputRef:orphan}}));
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true});
 if(!known)return assert.rejects(verifyDeploymentBackup(f),/BACKUP_ARTIFACT_MISSING/);
 const proof=await verifyDeploymentBackup(f);assert.equal(proof.database.artifactRefs,1);
 await writeFile(join(f.backupRoot,'manifest.json'),JSON.stringify(proof));assert.equal((await reverifyDeploymentBackup(f)).writes,0);
});

for(const known of [true,false])test(`已清理直派任务只接受同一命令摘要的Task与Run：${known}`,async t=>{
 const {executionDigest}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js');const f=await fixture();t.after(()=>f.db.close());
 f.db.exec('CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT);CREATE TABLE business_tasks(task_id TEXT);CREATE TABLE execution_runs(task_id TEXT);CREATE TABLE execution_receipts(command_id TEXT,result TEXT)');
 const digest=executionDigest('msg-source:u0:0:0'),taskId=`task-${digest.slice(0,32)}`;
 f.db.prepare('INSERT INTO execution_events VALUES(1,?,?)').run('task.delete',JSON.stringify({taskId,reason:'explicit-user-terminal-history-cleanup'}));
 f.db.prepare('INSERT INTO execution_receipts VALUES(?,?)').run('dispatch:msg-source:u0:0:0',JSON.stringify({historyRemoved:known}));
 f.db.prepare('INSERT INTO execution_receipts VALUES(?,?)').run('node-claim-old',JSON.stringify({binding:{runId:`run-${digest.slice(0,40)}`,inputRef:'sha256-'+ 'f'.repeat(64)+'.json'}}));
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true});
 if(!known)return assert.rejects(verifyDeploymentBackup(f),/BACKUP_ARTIFACT_MISSING/);
 assert.equal((await verifyDeploymentBackup(f)).database.artifactRefs,1);
});

for(const purged of [true,false])test(`历史消息候选只按已清理Task排除工件根：${purged}`,async t=>{
 const f=await fixture();t.after(()=>f.db.close());
 f.db.exec('CREATE TABLE execution_events(seq INTEGER PRIMARY KEY,kind TEXT,payload TEXT);CREATE TABLE business_tasks(task_id TEXT);CREATE TABLE execution_runs(task_id TEXT);CREATE TABLE message_items(kind TEXT,body TEXT)');
 if(purged)f.db.prepare('INSERT INTO execution_events VALUES(1,?,?)').run('task.delete',JSON.stringify({taskId:'task-old',reason:'explicit-user-terminal-history-cleanup'}));
 f.db.prepare('INSERT INTO message_items VALUES(?,?)').run('node',JSON.stringify({input:{candidates:[{taskId:'task-old',resultRef:'sha256-'+ 'e'.repeat(64)+'.json'}]}}));
 await cp(f.runtime,join(f.backupRoot,'runtime'),{recursive:true});
 if(!purged)return assert.rejects(verifyDeploymentBackup(f),/BACKUP_ARTIFACT_MISSING/);
 assert.equal((await verifyDeploymentBackup(f)).database.artifactRefs,1);
});

for(const location of ['checks/verify-Ab12cD','checks/verify-Ab12cD/packages/web'])test(`Host检查目录可再生依赖排除但源码产物保留：${location}`,async t=>{
 const f=await taskFixture(t),base=join(f.taskDirectory,'family-1/work/engineering','a'.repeat(24)),dir=join(base,location),outside=join(f.root,'dependencies')
 await mkdir(dir,{recursive:true});await mkdir(outside);await writeFile(join(outside,'dependency'),'regenerable')
 await symlink(outside,join(dir,'node_modules'),'junction')
 await writeFile(join(dir,'source.js'),'source');await writeFile(join(dir,'result.json'),'result')
 const checked=await checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory});assert.equal(checked.writes,0)
 const dest=join(f.root,'copied-tasks');await copyDeploymentTaskDirectory({taskDirectory:f.taskDirectory,destination:dest})
 const paths=await readdir(dest,{recursive:true});assert.equal(paths.some(p=>p.includes('node_modules')),false)
 assert.equal(paths.some(p=>p.endsWith('source.js')),true);assert.equal(paths.some(p=>p.endsWith('result.json')),true)
 await writeFile(join(f.taskDirectory,'family-1/work/artifacts',f.name),'corrupt')
 await assert.rejects(checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory}),/BACKUP_ARTIFACT_INVALID/)
})
for(const location of ['checks/verify-Ab12cD/dist','checks/verify-Ab12cD/source-link','checks/verify-other/node_modules','checks/not-verify/node_modules','outputs/verify-Ab12cD/node_modules'])test(`非Host依赖路径链接仍拒绝：${location}`,async t=>{
 const f=await taskFixture(t),path=join(f.taskDirectory,'family-1/work/engineering','a'.repeat(24),location),outside=join(f.root,'outside')
 await mkdir(join(path,'..'),{recursive:true});await mkdir(outside);await symlink(outside,path,'junction')
 await assert.rejects(checkDeploymentTaskDirectory({dbPath:join(f.runtime,'control.sqlite'),taskDirectory:f.taskDirectory}),/BACKUP_LINK_UNSAFE/)
})
