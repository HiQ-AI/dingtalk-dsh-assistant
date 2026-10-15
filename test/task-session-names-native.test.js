import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
const call=(name,args)=>({name,args})
test('真实任务链路：执行短名称持久化、原生标题一致，续办保留名称且看板完整', {skip: !available ? reason : false, timeout:30000}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'execution-names-native-'));let host,delegated=false,continued=false
 t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
 host=await nativeTaskHost(root,async request=>{
  const topic=topicTaskCalls(request);if(topic)return topic
  if(!request.tools.some(x=>x.name==='task_delegate'))return [call('execution_submit',{output:{status:'completed',summary:'只读核对完成',evidence:[],limitations:[],artifacts:[]}})]
  const input=latestInput(request)
  if(!delegated){delegated=true;return [call('task_delegate',{key:'核对配置',objective:'完整调查目标'.repeat(100)}),call('task_delegate',{key:'核对日志',objective:'读取日志核对'})]}
  const original=input.executions.find(x=>x.key==='核对配置')
  if(original?.drained && !continued){continued=true;return [call('task_delegate',{executionId:original.executionId,key:'续办名称不得替换原名',objective:'继续核对原目标'})]}
  const done=continued && input.executions.length===2 && input.executions.every(x=>x.drained) && original.inputVersion===2
  return [call('task_session_submit',{decision:{action:done?'complete':'wait',summary:done?'核对完成':'等待执行排空',evidence:[],limitations:[]}})]
 })
 const created=await host.service.createTask({groupId:'native-group',requestId:'names',objective:'核对配置和日志并复核配置'})
 await host.service.whenIdle()
 const executions=await host.query('execution.list',{taskId:created.taskId})
 assert.equal(executions.length,2);assert.equal(continued,true)
 const original=executions.find(x=>x.key==='核对配置');assert.equal(original.inputVersion,2);assert.equal(original.title,'核对配置')
 for(const execution of executions){
  const session=await inspectSession(host.ctx.sessionPersistence,execution.sessionId)
  assert.equal(session.events.findLast(x=>x.type==='session/title').data.title,execution.title)
 }
 const board=(await host.service.boardTasks())[0]
 assert.equal(board.executionSessions.length,2);assert.equal(board.executionSessions.find(x=>x.sessionId===original.sessionId).title,'核对配置')
 await host.close()
 host=await nativeTaskHost(root,async()=>{throw Error('Unexpected model turn while reading persisted names')},{initialize:false})
 const restored=(await host.service.boardTasks())[0]
 assert.deepEqual(restored.executionSessions,board.executionSessions)
})
