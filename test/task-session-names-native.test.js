import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
const call=(name,args)=>({name,args})
for (const continuationTitle of ['English continuation title', '重新核对日志']) test(`真实任务链路：可选中文短名、原生标题一致，续办不改名：${continuationTitle}`,  {skip: !available ? reason : false, timeout:30000}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-names-native-'));let host,delegated=false,continued=false,automaticTitles=0
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
 host=await nativeTaskHost(root,async request=>{
  const topic=topicTaskCalls(request);if(topic)return topic
  if(!request.tools.some(x=>x.name==='task_delegate'))return [call('execution_submit',{output:{status:'completed',summary:'只读核对完成',evidence:[],limitations:[],artifacts:[]}})]
  const input=latestInput(request)
  if(!delegated){delegated=true;return [call('task_delegate',{key:'inspect-config',title:'核对配置',objective:'Inspect the configuration and report actual evidence. '.repeat(30)}),call('task_delegate',{key:'read-logs',objective:'Read logs and report actual evidence'}),call('task_delegate',{key:'verify-api',title:'english-api-name',objective:'Verify API behavior'}),call('task_delegate',{key:'inspect-long',objective:'核对完整中文业务目标并保留全部证据和边界。'.repeat(20)})]}
  const original=input.executions.find(x=>x.key==='read-logs')
  if(original?.drained && !continued){continued=true;return [call('task_delegate',{executionId:original.executionId,key:'continue-config',title:continuationTitle,objective:'Continue checking the configuration'})]}
  const done=continued && input.executions.length===4 && input.executions.every(x=>x.drained) && original.inputVersion===2
  return [call('task_session_submit',{decision:{action:done?'complete':'wait',summary:done?'核对完成':'等待执行排空',evidence:[],limitations:[]}})]
 })
 host.ctx.sessionTitle.register({id:'english-title-provider',automatic:'all-prompts',async generate(){automaticTitles++;return {title:'Automatic English Title',messageSeqs:[]}}})
 const created=await host.service.createTask({groupId:'native-group',requestId:'names',objective:'核对配置和日志并复核配置'})
 await host.service.whenIdle()
 const executions=await host.query('execution.list',{taskId:created.taskId})
 assert.equal(executions.length,4);assert.equal(continued,true)
 const original=executions.find(x=>x.key==='read-logs');assert.equal(original.inputVersion,2);assert.equal(original.title,'read-logs');assert.equal(original.input.title,'read-logs')
 assert.deepEqual(executions.map(x=>x.title).sort(),['核对配置','read-logs','verify-api','inspect-long'].sort())
 assert.equal(automaticTitles,0,'native rename pins titles without any auxiliary generation call')
 for(const execution of executions){
  const session=await inspectSession(host.ctx.sessionPersistence,execution.sessionId)
  assert.equal(session.events.findLast(x=>x.type==='session/title').data.title,execution.title)
  assert.equal(session.events.findLast(x=>x.type==='session/title').data.source.kind,'user')
 }
 const board=(await host.service.boardTasks())[0]
 assert.equal(board.executionSessions.length,4);assert.equal(board.executionSessions.find(x=>x.sessionId===original.sessionId).title,'read-logs')
 await host.close()
 host=await nativeTaskHost(root,async()=>{throw Error('Unexpected model turn while reading persisted names')},{initialize:false})
 const restored=(await host.service.boardTasks())[0]
 assert.deepEqual(restored.executionSessions,board.executionSessions)
 for(const execution of executions){const session=await inspectSession(host.ctx.sessionPersistence,execution.sessionId);assert.equal(session.events.findLast(x=>x.type==='session/title').data.title,execution.title)}
})
