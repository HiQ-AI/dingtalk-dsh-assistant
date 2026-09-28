import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectLegacyDrain, readWorkflowSeal, cutoverWorkflow } from '../packages/dingtalk-dsh-assistant/workflow-cutover.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
const clean = () => ({ unit: { name: 'dingtalk_dsh_assistant', version: 9 }, tables: { groups: { g: { groupId: 'g', messages: [], outbox: [], topics: [], taskReservations: [], coordinationRequests: {} } }, tasks: {}, scheduler: {} } })
const stopped = async () => ({ stopped: true, pidPresent: false, listenerPresent: false, autostartDisabled: true })
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'workflow-cutover-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const options={legacyPath:join(root,'legacy.json'),journalPath:join(root,'dingtalk_dsh_assistant.workflow-seal.json'),dbPath:join(root,'control.db'),artifactDirectory:join(root,'artifacts'),instanceId:'instance',groupIds:['g'],probeStopped:stopped}
 await writeFile(options.legacyPath,JSON.stringify(clean()))
 return {root,options}
}
test('离线check零写入；pending Outbox不清除或绕过',async t=>{
 const {root,options}=await fixture(t);const before=await readFile(options.legacyPath)
 assert.equal((await cutoverWorkflow({...options,check:true})).writes,0)
 assert.deepEqual(await readdir(root),['legacy.json'])
 const doc=clean();doc.tables.groups.g.outbox.push({outboundId:'pending',status:'pending'})
 await writeFile(options.legacyPath,JSON.stringify(doc))
 await assert.rejects(cutoverWorkflow({...options,check:false}),e=>e.code==='CUTOVER_LEGACY_NOT_DRAINED'&&e.details.issues[0].kind==='outbox-unsettled')
 assert.deepEqual(await readdir(root),['legacy.json']);assert.equal(before.length>0,true)
})
test('所有旧消息/协调/人工/Task尚未结束都进入准确阻塞清单',()=>{
 const d=clean(),g=d.tables.groups.g;g.messages=[{messageId:'m',routingStatus:'failed',agentDeliveryStatus:'decision-retrying'}];g.coordinationRequests={r:{status:'exhausted'}};d.tables.tasks.t={taskId:'t',groupId:'g',state:'running',humanBlocker:{requestId:'h',status:'waiting-reply'}}
 assert.deepEqual(inspectLegacyDrain(d,['g']).issues.map(i=>i.kind),['message-routing-unsettled','message-decision-unsettled','coordination-unsettled','task-active','human-request-unsettled'])
})
test('进程/监听/自启任一存在拒绝，预检后重启也拒绝',async t=>{
 const {root,options}=await fixture(t)
 await assert.rejects(cutoverWorkflow({...options,probeStopped:async()=>({stopped:false,pidPresent:true,listenerPresent:false,autostartDisabled:true})}),{code:'CUTOVER_RUNTIME_NOT_STOPPED'})
 let calls=0;await assert.rejects(cutoverWorkflow({...options,probeStopped:async()=>++calls===1?stopped():{stopped:false,pidPresent:true,listenerPresent:true,autostartDisabled:true}}),{code:'CUTOVER_RUNTIME_RESTARTED'})
 assert.deepEqual(await readdir(root),['legacy.json'])
})
test('单journal先seal再接管，新库初始化/独立读回/幂等重跑保持旧文件',async t=>{
 const {options}=await fixture(t),before=await readFile(options.legacyPath)
 const result=await cutoverWorkflow(options);assert.equal(result.status,'ACTIVATED')
 const seal=await readWorkflowSeal({sealPath:options.journalPath,conversationId:'g'});assert.equal(seal.blockLegacy,true);assert.equal(seal.phase,'active')
 assert.equal(await readWorkflowSeal({sealPath:options.journalPath,conversationId:'other'}),null)
 const store=await openExecutionStore({dbPath:options.dbPath,instanceId:options.instanceId})
 try { const g=await store.query({kind:'message.group',conversationId:'g'});assert.equal(g.epoch,1);assert.equal(g.engine,'workflow') } finally {await store.close()}
 await cutoverWorkflow(options);assert.deepEqual(await readFile(options.legacyPath),before)
})
test('journal封存后snapshot篡改不接受，不把坏seal当没配置',async t=>{
 const {options}=await fixture(t);await cutoverWorkflow(options)
 const journal=JSON.parse(await readFile(options.journalPath,'utf8'));await writeFile(journal.snapshotPath,'{}')
 await assert.rejects(readWorkflowSeal({sealPath:options.journalPath,conversationId:'g'}),{code:'CUTOVER_SNAPSHOT_MISMATCH'})
})
test('seal之后控制库接管失败仍阻旧入口，释放owner后原journal可续接',async t=>{
 const {options}=await fixture(t)
 const owner=await openExecutionStore({dbPath:options.dbPath,instanceId:options.instanceId,initialize:true})
 try {await assert.rejects(cutoverWorkflow(options),{code:'STORE_OWNER_LOCKED'})} finally {await owner.close()}
 const sealed=await readWorkflowSeal({sealPath:options.journalPath,conversationId:'g'});assert.equal(sealed.phase,'sealed');assert.equal(sealed.blockLegacy,true)
 const before=JSON.parse(await readFile(options.journalPath,'utf8')).journalId
 await cutoverWorkflow(options);assert.equal(JSON.parse(await readFile(options.journalPath,'utf8')).journalId,before)
})

// 使用与实际 profile 相同的 YAML 实现；仅加载解析器，不加载 profile 代码。
const yaml = (await import('node:module')).createRequire(import.meta.url)('js-yaml')
const { createHash } = await import('node:crypto')
const { enrollEmptyWorkflowGroup } = await import('../packages/dingtalk-dsh-assistant/workflow-cutover.js')
const { planWorkflowGroupEnrollment } = await import('../scripts/workflow-group-profile.mjs')
const hash = value => createHash('sha256').update(value).digest('hex')
async function enrolledFixture(t) {
 const f = await fixture(t); await cutoverWorkflow(f.options)
 const original = JSON.parse(await readFile(f.options.journalPath, 'utf8'))
 const doc = clean(); doc.tables.groups.new = { ...structuredClone(doc.tables.groups.g), groupId: 'new', nextSequence: 1 }
 await writeFile(f.options.legacyPath, JSON.stringify(doc))
 const profilePath = join(f.root, 'profile.yml')
 const source = `plugins:\n  resident:\n    workflow:\n      instanceId: instance\n      dbPath: ${JSON.stringify(f.options.dbPath)}\n      groupIds:\n        - g\n      enabled: true\n    runtime: !!js |\n      require('must-not-execute')\n# preserve this comment\n`
 await writeFile(profilePath, source)
 const store = await openExecutionStore({dbPath:f.options.dbPath,instanceId:f.options.instanceId})
 await store.command({id:'maintenance',kind:'runtime.maintenance.change',args:{active:true,expectedRevision:0,maintenanceId:'enroll',actorId:'test',reason:'test'}})
 await store.command({id:'seal',kind:'runtime.maintenance.seal',args:{expectedRevision:1,maintenanceId:'enroll',actorId:'test',reason:'test'}})
 await store.close()
 const options = {...f.options, groupIds:['new'], profilePath, expectedProfileSha256:hash(source),
  planProfile:(source,groupIds,conversationId)=>planWorkflowGroupEnrollment(source,yaml,{instanceId:'instance',dbPath:f.options.dbPath,groupIds,conversationId})}
 return {...f, options, source, original}
}
test('空群接入 check 零写；独立 sealRef/旧 snapshot不变/配置只更新groupIds/幂等',async t=>{
 const f=await enrolledFixture(t), before=await readFile(f.options.journalPath), legacy=await readFile(f.options.legacyPath)
 const files=await readdir(f.root)
 assert.equal((await enrollEmptyWorkflowGroup({...f.options,check:true})).writes,0)
 assert.deepEqual(await readdir(f.root),files); assert.deepEqual(await readFile(f.options.journalPath),before)
 const result=await enrollEmptyWorkflowGroup(f.options)
 assert.equal(result.status,'ACTIVATED');assert.deepEqual(result.seal.groupIds,['g','new'])
 assert.equal(result.seal.sealRefs.g,`sha256:${f.original.legacySha256}`)
 assert.notEqual(result.seal.sealRefs.new,result.seal.sealRefs.g)
 const journal=JSON.parse(await readFile(f.options.journalPath,'utf8'))
 const {enrollments,...old}=journal;assert.deepEqual(old,f.original)
 assert.equal(hash(await readFile(f.original.snapshotPath)),f.original.legacySha256)
 assert.deepEqual(await readFile(f.options.legacyPath),legacy)
 const profile=await readFile(f.options.profilePath,'utf8')
 assert.ok(profile.includes("runtime: !!js |\n      require('must-not-execute')\n# preserve this comment"))
 await enrollEmptyWorkflowGroup(f.options)
 assert.equal((JSON.parse(await readFile(f.options.journalPath,'utf8'))).enrollments.length,1)
 assert.equal((await readWorkflowSeal({sealPath:f.options.journalPath,conversationId:'new'})).sealRef,result.seal.sealRefs.new)
 const concurrent = await Promise.all(Array.from({length:12},()=>readWorkflowSeal({sealPath:f.options.journalPath,conversationId:'new'})))
 assert.ok(concurrent.every(seal=>seal.sealRef===result.seal.sealRefs.new))
 await writeFile(enrollments[0].snapshotPath,'{}')
 await assert.rejects(readWorkflowSeal({sealPath:f.options.journalPath}),{code:'CUTOVER_SNAPSHOT_MISMATCH'})
 await assert.rejects(readWorkflowSeal({sealPath:f.options.journalPath}),{code:'CUTOVER_SNAPSHOT_MISMATCH'})
})
test('接入拒绝历史空壳、profile漂移、在线、控制库持锁；不写journal',async t=>{
 const f=await enrolledFixture(t), before=await readFile(f.options.journalPath), legacy=await readFile(f.options.legacyPath)
 const doc=JSON.parse(legacy);doc.tables.groups.new.routeHistory=[{status:'completed'}]
 await writeFile(f.options.legacyPath,JSON.stringify(doc))
 await assert.rejects(enrollEmptyWorkflowGroup({...f.options,check:true}),{code:'CUTOVER_NEW_GROUP_NOT_EMPTY'})
 await writeFile(f.options.legacyPath,legacy)
 await assert.rejects(enrollEmptyWorkflowGroup({...f.options,expectedProfileSha256:'b'.repeat(64)}),{code:'CUTOVER_PROFILE_CHANGED'})
 await assert.rejects(enrollEmptyWorkflowGroup({...f.options,probeStopped:async()=>({stopped:false})}),{code:'CUTOVER_RUNTIME_NOT_STOPPED'})
 const owner=await openExecutionStore({dbPath:f.options.dbPath,instanceId:f.options.instanceId})
 try {await assert.rejects(enrollEmptyWorkflowGroup(f.options),{code:'STORE_OWNER_LOCKED'})} finally {await owner.close()}
 assert.deepEqual(await readFile(f.options.journalPath),before)
})
test('封存后配置写前中断，旧入口仍封禁；同一journal/命令安全续接',async t=>{
 const f=await enrolledFixture(t)
 // 通过第二次停机探测触发配置冲突，验证前置 CAS 不会落半份 seal。
 let calls=0
 await assert.rejects(enrollEmptyWorkflowGroup({...f.options,probeStopped:async()=>{if(++calls===2)await writeFile(f.options.profilePath,f.source+'# raced\n');return stopped()}}),{code:'CUTOVER_INPUT_CHANGED'})
 await writeFile(f.options.profilePath,f.source)
 await enrollEmptyWorkflowGroup(f.options)
 // 模拟在原生命令及 profile 已落盘、最终 active journal 尚未落盘时中断。
 const journal=JSON.parse(await readFile(f.options.journalPath,'utf8'));journal.enrollments[0].phase='sealed'
 await writeFile(f.options.journalPath,JSON.stringify(journal))
 assert.equal((await readWorkflowSeal({sealPath:f.options.journalPath,conversationId:'new'})).phase,'sealed')
 await enrollEmptyWorkflowGroup(f.options)
 assert.equal((await readWorkflowSeal({sealPath:f.options.journalPath})).phase,'active')
 const store=await openExecutionStore({dbPath:f.options.dbPath,instanceId:f.options.instanceId})
 try {assert.equal((await store.query({kind:'message.group',conversationId:'new'})).epoch,1)} finally {await store.close()}
})



test('checkpoint只在正式停机维护内执行，前后所有业务表摘要不变',async t=>{
 const f=await enrolledFixture(t)
 const {checkpointDeploymentDatabase}=await import('../scripts/deployment-integrity.mjs')
 await assert.rejects(checkpointDeploymentDatabase({dbPath:f.options.dbPath,instanceId:'wrong',probeStopped:stopped}),/CHECKPOINT_INSTANCE_MISMATCH/)
 await assert.rejects(checkpointDeploymentDatabase({dbPath:f.options.dbPath,instanceId:'instance',probeStopped:async()=>({stopped:false})}),/CHECKPOINT_RUNTIME_NOT_STOPPED/)
 const result=await checkpointDeploymentDatabase({dbPath:f.options.dbPath,instanceId:'instance',probeStopped:stopped})
 assert.equal(result.checkpointed,true);assert.equal(result.maintenanceId,'enroll');assert.ok(result.tables.length>0)
 assert.equal((await enrollEmptyWorkflowGroup({...f.options,check:true})).writes,0)
})
test('新群接入必须正式maintenance stopping，且不能绑定其他实例/旧群',async t=>{
 const f=await fixture(t);await cutoverWorkflow(f.options)
 const d=clean();d.tables.groups.new={...structuredClone(d.tables.groups.g),groupId:'new'}
 await writeFile(f.options.legacyPath,JSON.stringify(d))
 const profilePath=join(f.root,'p.yml'),source=`workflow:\n  instanceId: instance\n  dbPath: ${JSON.stringify(f.options.dbPath)}\n  groupIds: [g]\n`
 await writeFile(profilePath,source)
 const options={...f.options,profilePath,expectedProfileSha256:hash(source),groupIds:['new'],planProfile:(source,groupIds,conversationId)=>planWorkflowGroupEnrollment(source,yaml,{instanceId:'instance',dbPath:f.options.dbPath,groupIds,conversationId})}
 await assert.rejects(enrollEmptyWorkflowGroup({...options,check:true}),{code:'CUTOVER_MAINTENANCE_REQUIRED'})
 await assert.rejects(enrollEmptyWorkflowGroup({...options,instanceId:'other'}),{code:'CUTOVER_JOURNAL_CONFLICT'})
 await assert.rejects(enrollEmptyWorkflowGroup({...options,groupIds:['g']}),{code:'CUTOVER_ENROLLMENT_CONFLICT'})
})
test('profile精确sequence修改保留内联/块风格周边字段，并拒绝多workflow或错误群集合',()=>{
 const args={instanceId:'i',dbPath:join(tmpdir(),'c.db'),groupIds:['g'],conversationId:'new'}
 for(const sequence of ['[g]','\n    - g']){
  const source=`workflow:\n  instanceId: i\n  dbPath: ${JSON.stringify(args.dbPath)}\n  groupIds: ${sequence}\n  other: !!js hello\n# end\n`
  const updated=planWorkflowGroupEnrollment(source,yaml,args)
  assert.ok(updated.endsWith('  other: !!js hello\n# end\n'));assert.ok(updated.includes('["g","new"]'))
  assert.throws(()=>planWorkflowGroupEnrollment(source,yaml,{...args,groupIds:['x']}),/CUTOVER_PROFILE_INVALID/)
 }
})
