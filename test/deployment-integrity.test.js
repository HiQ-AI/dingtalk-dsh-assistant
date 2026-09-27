import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { verifyDeploymentBackup, verifyDeploymentWeb, verifyArtifactClosure } from '../scripts/deployment-integrity.mjs'

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
