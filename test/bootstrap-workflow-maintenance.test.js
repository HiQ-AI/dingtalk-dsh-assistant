import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapProfile, changeBootstrapProfile, sealBootstrapStore, apply } from '../scripts/bootstrap-workflow-maintenance.mjs'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { planProjectLocalAcceptance } from '../scripts/configure-project-local-acceptance.mjs'

const hash=v=>createHash('sha256').update(v).digest('hex')
const source='# private bytes retained\r\n- insert:\r\n    - id: dingtalk-dsh-assistant\r\n      name: "@zzusp/dingtalk-dsh-assistant/resident"\r\n      config:\r\n        private: opaque-fixture\r\n        root: !!js dshHomePath("example")\r\n'

test('bootstrap profile check零写；CAS追加及精确撤销保留原文，漂移拒绝',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bootstrap-profile-')),profile=join(dir,'profile.yml')
 await writeFile(profile,source)
 const checked=await changeBootstrapProfile({profile,expectedSha256:hash(source),mode:'disable',check:true,yaml})
 assert.equal(checked.writes,0);assert.equal(await readFile(profile,'utf8'),source)
  await assert.rejects(changeBootstrapProfile({profile,expectedSha256:'0'.repeat(64),mode:'disable',yaml}),/BOOTSTRAP_PROFILE_CAS/)
 await writeFile(profile+'.local-acceptance.lock','other-writer',{flag:'wx'})
 await assert.rejects(changeBootstrapProfile({profile,expectedSha256:hash(source),mode:'disable',yaml}),/BOOTSTRAP_PROFILE_LOCKED/)
 assert.equal(await readFile(profile+'.local-acceptance.lock','utf8'),'other-writer')
 await unlink(profile+'.local-acceptance.lock')
 const disabled=await changeBootstrapProfile({profile,expectedSha256:hash(source),mode:'disable',yaml})
 const actual=await readFile(profile,'utf8');assert.ok(actual.startsWith(source));assert.equal(hash(actual),disabled.afterSha256)
 assert.throws(()=>bootstrapProfile(actual,'disable',yaml),/BOOTSTRAP_ALREADY_DISABLED/)
 assert.throws(()=>bootstrapProfile(actual+'# drift','enable',yaml),/BOOTSTRAP_FENCE_CHANGED/)
 await changeBootstrapProfile({profile,expectedSha256:disabled.afterSha256,mode:'enable',yaml})
 assert.equal(await readFile(profile,'utf8'),source)
})

test('bootstrap离线使用正式Store enter/seal，owner锁阻挡并发，新进程回读resume',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bootstrap-store-')),dbPath=join(dir,'control.sqlite'),instanceId='bootstrap-fixture'
 let store=await openExecutionStore({dbPath,instanceId,initialize:true})
 const args={openExecutionStore,dbPath,instanceId,maintenanceId:'deploy-fixture',actorId:'owner'}
 await assert.rejects(sealBootstrapStore(args),/STORE_OWNER_LOCKED/)
 await store.close()
 const guard=new DatabaseSync(dbPath+'.owner.sqlite');guard.exec('BEGIN EXCLUSIVE')
 try {await assert.rejects(sealBootstrapStore(args),/STORE_OWNER_LOCKED/)} finally {guard.exec('ROLLBACK');guard.close()}
 const sealed=await sealBootstrapStore(args)
 assert.equal(sealed.mode,'bootstrap-offline');assert.equal(sealed.state.stopPermitted,true)
 store=await openExecutionStore({dbPath,instanceId})
 assert.equal((await store.query({kind:'runtime.maintenance'})).resumePermitted,false)
 await store.close()
 const script=join(dir,'new-host.mjs'),moduleUrl=new URL('../packages/dingtalk-dsh-assistant/execution-store.js',import.meta.url).href
 await writeFile(script,`import {openExecutionStore} from ${JSON.stringify(moduleUrl)};const options=JSON.parse(process.argv[2]);const store=await openExecutionStore(options);try{const before=await store.query({kind:'runtime.maintenance'});await store.command({id:'resume',kind:'runtime.maintenance.resume',args:{expectedRevision:before.revision,maintenanceId:'deploy-fixture',actorId:'owner',reason:'新Host验证完成'}});console.log(JSON.stringify({before,after:await store.query({kind:'runtime.maintenance'})}));}finally{await store.close()}`)
 const child=spawnSync(process.execPath,[script,JSON.stringify({dbPath,instanceId})],{encoding:'utf8',windowsHide:true})
 assert.equal(child.status,0,child.stderr)
 const result=JSON.parse(child.stdout);assert.equal(result.before.resumePermitted,true);assert.equal(result.after.active,false)
 assert.notEqual(result.before.processIncarnation,sealed.state.processIncarnation)
})

test('正式configure修改验收配置仍完整保留末尾禁用屏障，只移除屏障不回滚新配置',()=>{
 const original=source+'        workflow:\r\n          repositories:\r\n            - id: dataset\r\n              managedRoot: D:/fixture\r\n            - id: dataset-web\r\n              managedRoot: D:/fixture\r\n'
 const command={executable:process.execPath,args:['-e','process.exit(0)']}
 const config={version:'test',sharedDataProfilePath:'D:/fixture/shared.json',prepareSteps:[command],service:{executable:process.execPath,args:['server.js','--host','127.0.0.1','--port','{port}'],readyPath:'/ready'},scenarios:[{...command,id:'fixture',description:'fixture'}],cleanup:command,verifyCleanup:command}
 const witnessed=bootstrapProfile(original,'witness',yaml,{evidenceDirectory:'D:/fixture/evidence',expectedPid:123,nonce:randomUUID()})
 const disabled=bootstrapProfile(witnessed,'disable',yaml)
 const planned=planProjectLocalAcceptance(disabled,{dataset:config,'dataset-web':config},yaml)
 const enabled=bootstrapProfile(planned.updated,'enable',yaml)
 assert.ok(!enabled.includes('dsh-bootstrap-maintenance:'));assert.ok(enabled.includes('localAcceptance:'));assert.ok(enabled.includes('opaque-fixture'))
 assert.ok(!enabled.includes('dsh-bootstrap-witness:'))
})

test('完整dispose见证必须ready后精确nonce/PID/entry且确已完成，其他事件零回执',async()=>{
 const evidenceDirectory=await mkdtemp(join(tmpdir(),'bootstrap-witness-')),nonce=randomUUID(),config={evidenceDirectory,expectedPid:process.pid,nonce}
 let listener
 const ctx={on(event,fn){assert.equal(event,'loader/partial-dispose');listener=fn}}
 await assert.rejects(apply(ctx,{...config,expectedPid:process.pid+1}),/BOOTSTRAP_WITNESS_IDENTITY_INVALID/)
 await apply(ctx,config)
 assert.equal(JSON.parse(await readFile(join(evidenceDirectory,'bootstrap-ready.json'),'utf8')).nonce,nonce)
 const entry={options:{id:'dingtalk-dsh-assistant',name:'@zzusp/dingtalk-dsh-assistant/resident',disabled:true},_disposing:0}
 for(const invalid of [{...entry,options:{...entry.options,id:'other'}},{...entry,options:{...entry.options,disabled:false}},{...entry,_disposing:1},{...entry,fiber:{}}])await listener(invalid,{},true)
 await listener(entry,{},false)
 await assert.rejects(readFile(join(evidenceDirectory,'bootstrap-disposed.json')),e=>e.code==='ENOENT')
 await listener(entry,{},true)
 const receipt=JSON.parse(await readFile(join(evidenceDirectory,'bootstrap-disposed.json'),'utf8'))
 assert.deepEqual(receipt,{kind:'disposed',nonce,pid:process.pid,entryId:entry.options.id,moduleName:entry.options.name})
 await listener(entry,{},true)
 assert.deepEqual(JSON.parse(await readFile(join(evidenceDirectory,'bootstrap-disposed.json'),'utf8')),receipt)
})

test('见证自动创建新证据目录；重试仅更新同目录同PID的精确末尾见证',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bootstrap-new-evidence-')),evidenceDirectory=join(root,'new'),config={evidenceDirectory,expectedPid:process.pid,nonce:randomUUID()}
 await apply({on(){}},config)
 assert.equal(JSON.parse(await readFile(join(evidenceDirectory,'bootstrap-ready.json'))).nonce,config.nonce)
 const first=bootstrapProfile(source,'witness',yaml,config),retry={...config,nonce:randomUUID()},second=bootstrapProfile(first,'witness',yaml,retry)
 assert.equal((second.match(/# dsh-bootstrap-witness:/g)??[]).length,1)
 assert.ok(second.includes(retry.nonce));assert.ok(!second.includes(config.nonce))
 for(const changed of [{...retry,expectedPid:process.pid+1},{...retry,evidenceDirectory:root}])assert.throws(()=>bootstrapProfile(first,'witness',yaml,changed),/BOOTSTRAP_WITNESS_CHANGED/)
 assert.throws(()=>bootstrapProfile(first+'# drift','witness',yaml,retry),/BOOTSTRAP_WITNESS_CHANGED/)
})

test('真实Cordis Loader等待完整disposer后才发指定entry见证',async t=>{
 const {Context}=await import('@deepseek-ai/cordis')
 const {default:Loader}=await import('@deepseek-ai/cordis-plugin-loader')
 const {default:witness}=await import('../scripts/bootstrap-workflow-maintenance.mjs')
 const evidenceDirectory=await mkdtemp(join(tmpdir(),'bootstrap-native-')),ctx=new Context()
 await ctx.plugin(Loader)
 let release,started
 const startedPromise=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 t.after(async()=>{release();await ctx.fiber.dispose()})
 // 仅业务插件是可控fixture；Loader事件和见证插件均为真实实现，无运行态连接。
 ctx.loader.import=async()=>({apply(context){context.effect(()=>async()=>{started();await gate})}})
 await ctx.plugin(witness,{evidenceDirectory,expectedPid:process.pid,nonce:randomUUID()})
 const id=await ctx.loader.create({id:'dingtalk-dsh-assistant',name:'@zzusp/dingtalk-dsh-assistant/resident'})
 await ctx.loader.await()
 const pending=ctx.loader.resolve(id).update({disabled:true});await startedPromise
 await assert.rejects(readFile(join(evidenceDirectory,'bootstrap-disposed.json')),e=>e.code==='ENOENT')
 release();await pending
 for(let i=0;i<50;i++){
  try{assert.equal(JSON.parse(await readFile(join(evidenceDirectory,'bootstrap-disposed.json'),'utf8')).entryId,'dingtalk-dsh-assistant');return}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,10))}
 }
 assert.fail('完整dispose后未收到见证')
})
