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
 assert.equal(checked.taskBackupExclusions.length,1)
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
