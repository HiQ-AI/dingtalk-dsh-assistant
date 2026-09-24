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
