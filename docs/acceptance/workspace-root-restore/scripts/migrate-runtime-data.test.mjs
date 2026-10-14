import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { checkMigration, migrateMetadataAndFiles } from './migrate-runtime-data.mjs'
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'runtime-migration-')),sourceRoot=join(root,'old'),targetRoot=join(root,'new'),profilePath=join(root,'profile.yml'),workspacePath=join(root,'workspace.json')
 t.after(()=>rm(root,{recursive:true,force:true}))
 for(const dir of [join(sourceRoot,'.dsh','resident'),join(sourceRoot,'tasks','.session-routes'),join(sourceRoot,'tasks','task-a','materials'),join(sourceRoot,'tasks','task-a','.dsh','sessions','old-cwd'),join(sourceRoot,'session-workspaces','话题决策'),join(targetRoot,'tasks','unrelated'),join(targetRoot,'session-workspaces','消息问答')])await mkdir(dir,{recursive:true})
 await writeFile(join(sourceRoot,'.dsh','resident','state.json'),JSON.stringify({history:'PRESERVE_HISTORY'}))
 const oldDb=join(sourceRoot,'.dsh','task-sessions.sqlite'),db=new DatabaseSync(oldDb)
 db.exec('CREATE TABLE dynamic_executions(id TEXT PRIMARY KEY,body TEXT);CREATE TABLE dynamic_receipts(id TEXT PRIMARY KEY,body TEXT)')
 const execution={executionId:'e',definition:{protectedPaths:[oldDb,oldDb+'-wal',oldDb+'-shm',oldDb+'.initialized']},input:{materialPaths:[join(sourceRoot,'tasks','task-a','materials','source-a.json')]},inputDigest:'UNCHANGED_INPUT_DIGEST',dispatchDigest:'UNCHANGED_DISPATCH_DIGEST'}
 db.prepare('INSERT INTO dynamic_executions VALUES (?,?)').run('e',JSON.stringify(execution));db.prepare('INSERT INTO dynamic_receipts VALUES (?,?)').run('r',JSON.stringify({original:execution}));db.close()
 await writeFile(join(sourceRoot,'tasks','.session-routes','route.json'),JSON.stringify({taskId:'task-a',sessionId:'s',cwd:join(sourceRoot,'tasks','task-a')}))
 const png=join(sourceRoot,'tasks','task-a','materials','image.png');await writeFile(png,'fixture-image-bytes')
 await writeFile(join(sourceRoot,'tasks','task-a','materials','source-a.json'),JSON.stringify({path:join(sourceRoot,'tasks','task-a','materials','source-a.json'),text:'ORIGINAL_BUSINESS_TEXT',resources:[{path:png,sha256:'UNCHANGED',value:{image:{path:png}}}]}))
 const nativeLog=JSON.stringify({type:'session',id:'s',cwd:join(sourceRoot,'tasks','task-a')})+'\n'+JSON.stringify({type:'user/message',data:{text:'ORIGINAL_NATIVE_FACT'}})
 await writeFile(join(sourceRoot,'tasks','task-a','.dsh','sessions','old-cwd','session.v4.jsonl'),nativeLog)
 await writeFile(profilePath,`- id: fixture\n  config:\n    root: '${sourceRoot.replaceAll('\\','/')}/.dsh/resident'\n    workspaceDir: '${sourceRoot.replaceAll('\\','/')}'\n    secret: FIXTURE_SECRET_MUST_NOT_APPEAR_IN_PLAN\n    disabled: !!js '!ctx.get("fixture")'\n`)
 await writeFile(workspacePath,JSON.stringify({tables:{workspaces:{'same-id':{path:join(sourceRoot,'tasks','task-a'),sessionIds:['s'],title:'unchanged'}}},history:{path:'not-a-current-workspace'}}))
 const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0)
 return {sourceRoot,targetRoot,profilePath,workspacePath,expectedPid:child.pid,nativeLog,execution}
}
test('check is read-only and the exact offline data migration keeps native and historical facts unchanged',async t=>{
 const f=await fixture(t),options={...f};delete options.nativeLog;delete options.execution
 const profileBefore=await readFile(f.profilePath),plan=checkMigration(options)
 assert.equal(plan.writes,0);assert.equal(plan.ready,true)
 assert.equal(JSON.stringify(plan).includes('FIXTURE_SECRET'),false)
 assert.equal(JSON.stringify(plan).includes('ORIGINAL_BUSINESS_TEXT'),false)
 assert.deepEqual(await readFile(f.profilePath),profileBefore)
 const receipt=migrateMetadataAndFiles(plan)
 assert.equal(receipt.nativeLogsUnchanged,true)
 assert.equal(await readFile(join(f.targetRoot,'tasks','task-a','.dsh','sessions','old-cwd','session.v4.jsonl'),'utf8'),f.nativeLog)
 const db=new DatabaseSync(join(f.targetRoot,'.dsh','task-sessions.sqlite'),{readOnly:true})
 const migrated=JSON.parse(db.prepare('SELECT body FROM dynamic_executions').get().body),history=JSON.parse(db.prepare('SELECT body FROM dynamic_receipts').get().body)
 assert.equal(migrated.definition.protectedPaths[0],join(f.targetRoot,'.dsh','task-sessions.sqlite'))
 assert.deepEqual(migrated.input,f.execution.input);assert.equal(migrated.inputDigest,f.execution.inputDigest);assert.equal(migrated.dispatchDigest,f.execution.dispatchDigest);assert.deepEqual(history.original,f.execution);db.close()
 const manifest=JSON.parse(await readFile(join(f.targetRoot,'tasks','task-a','materials','source-a.json'),'utf8'))
 assert.equal(manifest.text,'ORIGINAL_BUSINESS_TEXT');assert.equal(manifest.resources[0].sha256,'UNCHANGED');assert.ok(manifest.path.startsWith(f.targetRoot))
 const workspace=JSON.parse(await readFile(f.workspacePath,'utf8'));assert.equal(workspace.tables.workspaces['same-id'].path,join(f.targetRoot,'tasks','task-a'));assert.deepEqual(workspace.tables.workspaces['same-id'].sessionIds,['s'])
 assert.match(await readFile(f.profilePath,'utf8'),/FIXTURE_SECRET_MUST_NOT_APPEAR_IN_PLAN/)
 assert.equal((await readFile(f.profilePath,'utf8')).includes(f.sourceRoot.replaceAll('\\','/')),false)
})
for(const scenario of ['live-pid','collision','profile-drift'])test(`migration refuses ${scenario} before moving data`,async t=>{
 const f=await fixture(t),options={...f};delete options.nativeLog;delete options.execution
 if(scenario==='live-pid')options.expectedPid=process.pid
 if(scenario==='collision')await mkdir(join(f.targetRoot,'tasks','task-a'))
 if(scenario==='collision'){assert.throws(()=>checkMigration(options),/TARGET_COLLISION/);return}
 const plan=checkMigration(options)
 if(scenario==='profile-drift')await writeFile(f.profilePath,'[]\n')
 assert.throws(()=>migrateMetadataAndFiles(plan),/RUNTIME_STILL_ALIVE|PLAN_CHANGED/)
 assert.ok((await readFile(join(f.sourceRoot,'tasks','.session-routes','route.json'),'utf8')).includes('task-a'))
})
