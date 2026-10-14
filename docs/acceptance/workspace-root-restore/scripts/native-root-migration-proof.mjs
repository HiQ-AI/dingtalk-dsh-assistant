import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { nativeTaskHost, latestInput, topicTaskCalls, nativeShell } from '../../../../test/fixtures/task-session-native-host.js'
import { installTaskSessionPersistence } from '../../../../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { planNativeRelocations, applyNativeRelocations } from './native-session-relocation.mjs'
import { inspectSession } from '../../../../packages/dingtalk-dsh-assistant/session-persistence.js'
/** 调用方先停写并确认sourceSessionDirectory是原session原生日志目录。阶段目录留给独立核验后清理。 */
export async function relocateNativeSession({ persistence, sessionId, cwd, sourceSessionDirectory, stagingDirectory }) {
 const source=await inspectSession(persistence,sessionId)
 const eventDigest=createHash('sha256').update(JSON.stringify(source.events)).digest('hex')
 if(source.meta.id!==sessionId)throw Error('NATIVE_RELOCATION_ID_MISMATCH')
 await mkdir(dirname(stagingDirectory),{recursive:true})
 await rename(sourceSessionDirectory,stagingDirectory)
 const writer=await persistence.create({...source.meta,cwd},{inheritedEventCount:source.inheritedEventCount})
 try{await writer.append(source.events);await writer.flush()}finally{await writer.close()}
 const migrated=await inspectSession(persistence,sessionId)
 if(migrated.meta.cwd!==cwd||createHash('sha256').update(JSON.stringify(migrated.events)).digest('hex')!==eventDigest)throw Error('NATIVE_RELOCATION_READBACK_MISMATCH')
 return {sessionId,oldCwd:source.meta.cwd,cwd,eventCount:source.events.length,eventDigest,stagingDirectory}
}

async function main(){
const base=await mkdtemp(join(tmpdir(),'native-root-migration-')),oldRoot=join(base,'old'),newRoot=join(base,'new')
await mkdir(oldRoot);await mkdir(newRoot)
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const finish=(action,question)=>({name:'task_session_submit',args:{decision:{action,summary:'隔离迁移验证',evidence:[],limitations:[],...(question?{question}:{})}}})
let oldHost,newHost,probe
const steps=new Map()
const call=(name,args)=>({name,args})
const output=()=>call('execution_submit',{output:{status:'completed',summary:'已实际核对',evidence:[],limitations:[],artifacts:[]}})
try {
 oldHost=await nativeTaskHost(oldRoot,async (request,host)=>{
  const topic=topicTaskCalls(request);if(topic)return topic
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')){
   if(!input.executions.length)return [call('task_delegate',{key:'first-check',objective:'核对材料'}),finish('wait')]
   if(input.executions.some(item=>item.status!=='succeeded'))return [finish('wait')]
   return [finish('wait','请提供补充核验信息')]
  }
  const execution=(await host.query('execution.list'))[0],agent=host.ctx.agents.get(execution.sessionId)
  const subdir=join(oldRoot,'tasks',execution.taskId,'subdir');await mkdir(subdir,{recursive:true})
  agent.session.append('working-directory/change',{cwd:subdir})
  return [output()]
 })
 const task=await oldHost.service.createTask({groupId:'native-group',requestId:'create',objective:'同会话迁根验证',context:'必须保留历史摘要'})
 await oldHost.service.whenIdle()
 const executions=await oldHost.query('execution.list')
 assert.ok(executions.every(item=>item.status==='succeeded'),JSON.stringify({executions:executions.map(item=>({status:item.status,result:item.result})),failures:(await oldHost.service.recover()).failures}))
 const logs=await Promise.all([task.sessionId,...executions.map(item=>item.sessionId)].map(sessionId=>inspectSession(oldHost.ctx.sessionPersistence,sessionId)))
 const saved=logs[0]
 const before=digest(saved.events),stored=await oldHost.query('task.get',{taskId:task.taskId})
 assert.equal(stored.drained,true)
 await oldHost.close();oldHost=null
 await mkdir(join(oldRoot,'legacy-sessions'),{recursive:true})
 const relocationPlan=await planNativeRelocations({taskDataRoot:oldRoot,sourceRoot:oldRoot,targetRoot:newRoot,globalRoot:join(oldRoot,'legacy-sessions')})
 await cp(join(oldRoot,'dynamic.db'),join(newRoot,'dynamic.db'))
 const db=new DatabaseSync(join(newRoot,'dynamic.db'))
 const receiptRows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%receipt%'").all().map(row=>({name:row.name,rows:db.prepare(`SELECT * FROM ${row.name}`).all()}))
 const receiptDigest=digest(receiptRows)
 for(const row of db.prepare('SELECT id,body FROM dynamic_executions').all()){
  const body=JSON.parse(row.body),inputDigest=body.inputDigest
  body.definition.protectedPaths=body.definition.protectedPaths.map(path=>path.startsWith(oldRoot)?newRoot+path.slice(oldRoot.length):path)
  db.prepare('UPDATE dynamic_executions SET body=? WHERE id=?').run(JSON.stringify(body),row.id)
  assert.equal(JSON.parse(db.prepare('SELECT body FROM dynamic_executions WHERE id=?').get(row.id).body).inputDigest,inputDigest)
 }
 assert.equal(digest(receiptRows.map(row=>({name:row.name,rows:db.prepare(`SELECT * FROM ${row.name}`).all()}))),receiptDigest)
 db.close()
 await cp(join(oldRoot,'tasks',task.taskId),join(newRoot,'tasks',task.taskId),{recursive:true})
 const materials=join(newRoot,'tasks',task.taskId,'materials')
 for(const name of await readdir(materials)) if(name.startsWith('source-')&&name.endsWith('.json')){
  const file=join(materials,name),value=JSON.parse(await readFile(file,'utf8'))
  value.path=join(materials,name)
  for(const resource of value.resources){if(resource.path){resource.path=join(materials,resource.path.split(/[\\/]/u).at(-1));if(resource.value?.image)resource.value.image.path=resource.path}}
  await writeFile(file,JSON.stringify(value))
 }
 probe=await nativeTaskHost(newRoot,async()=>[],{resident:true})
 const centralId='central-coordination-proof'
 const central=probe.ctx.sessionPersistence
 const initial=await central.create({...saved.meta,id:centralId,cwd:join(oldRoot,'session-workspaces','消息归类')})
 try{await initial.append(saved.events);await initial.flush()}finally{await initial.close()}
 const centralRoot=join(newRoot,'legacy-sessions')
 let sourceSessionDirectory
 for(const entry of await readdir(centralRoot,{recursive:true,withFileTypes:true}))if(entry.isFile()&&entry.name==='session.v4.jsonl'){
  const file=join(entry.parentPath,entry.name),header=JSON.parse((await readFile(file,'utf8')).split('\n')[0])
  if(header.id===centralId)sourceSessionDirectory=entry.parentPath
 }
 assert.ok(sourceSessionDirectory)
 const centralProof=await relocateNativeSession({persistence:central,sessionId:centralId,cwd:join(newRoot,'session-workspaces','消息归类'),sourceSessionDirectory,stagingDirectory:join(base,'staging',centralId)})
 assert.equal(centralProof.eventDigest,before)
 await probe.close();probe=null
 const relocationProofs=await applyNativeRelocations(relocationPlan,{sourceRoot:oldRoot,targetRoot:newRoot,stagingRoot:join(base,'module-stage')})
 const cwd=join(newRoot,'tasks',task.taskId)
 let resumedCwd
 newHost=await nativeTaskHost(newRoot,async(request,host)=>{
  const topic=topicTaskCalls(request);if(topic)return topic
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')){
   const agent=host.ctx.agents.get(input.task.sessionId);resumedCwd=agent.session.header.cwd
   if(input.executions.some(item=>item.inputVersion===2&&item.status==='succeeded'))return [finish('complete')]
   const key='owner:'+input.task.leaseEpoch,step=steps.get(key)??0;steps.set(key,step+1)
   return step===0?[call('task_delegate',{key:'resume-check',executionId:executions[0].executionId,objective:'迁根后核对新材料'})]:[finish('wait')]
  }
  const execution=(await host.query('execution.list'))[0],agent=host.ctx.agents.get(execution.sessionId)
  const key='exec:'+execution.leaseEpoch,step=steps.get(key)??0;steps.set(key,step+1)
  assert.equal(host.ctx.sessionProjections.stateOf(agent.session,'workingDirectory'),join(cwd,'subdir'))
  if(step===0)return [call(nativeShell,{command:nativeShell==='pwsh'?'(Get-Location).Path':'pwd',description:'隔离迁根后的实际目录核对'})]
  if(step===1)return [call('read',{file_path:input.materialPaths[0]})]
  return [output()]
 },{initialize:false})
 const pending=(await newHost.service.listAuthorizationRequests()).find(item=>item.status==='waiting-reply')
 await newHost.service.respondHumanRequest({taskId:task.taskId,humanRequestId:pending.requestId,requestId:'reply-new-root',reply:'补充核验信息已提供',expectedRequirementRevision:pending.requirementRevision,expectedControlRevision:pending.controlRevision})
 await newHost.service.whenIdle()
 const completed=await newHost.query('task.get',{taskId:task.taskId})
 const finalLog=await inspectSession(newHost.ctx.sessionPersistence,task.sessionId)
 assert.equal(completed.status,'completed');assert.equal(completed.sessionId,task.sessionId);assert.equal(resumedCwd,cwd)
 assert.equal(digest(finalLog.events.slice(0,saved.events.length)),before)
 const afterExecution=(await newHost.query('execution.list'))[0]
 assert.equal(afterExecution.sessionId,executions[0].sessionId);assert.equal(afterExecution.inputVersion,2);assert.equal(afterExecution.status,'succeeded')
 const executionLog=await inspectSession(newHost.ctx.sessionPersistence,afterExecution.sessionId)
 assert.equal(digest(executionLog.events.slice(0,logs[1].events.length)),digest(logs[1].events))
 assert.ok(newHost.toolResults.some(item=>item.name===nativeShell&&!item.result.isError&&JSON.stringify(item.result).includes(newRoot.split('\\').join('\\\\'))))
 assert.ok(newHost.toolResults.some(item=>item.name==='read'&&!item.result.isError))
 console.log(JSON.stringify({pass:true,taskId:task.taskId,sessionId:task.sessionId,eventCount:saved.events.length,eventDigest:before,newCwd:resumedCwd,finalStatus:completed.status,leaseBefore:stored.leaseEpoch,leaseAfter:completed.leaseEpoch,oldRoot,newRoot,executionSessionId:afterExecution.sessionId,executionInputVersionBefore:executions[0].inputVersion,executionInputVersionAfter:afterExecution.inputVersion,originalExecutionEvents:logs[1].events.length,receiptDigest,actualPwdAndRead:true,centralRelocation:centralProof,relocationProofs}))
}finally{await oldHost?.close();await newHost?.close();await probe?.close()}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main()
