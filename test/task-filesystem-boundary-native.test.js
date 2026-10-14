import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
const decision = action => ({name:'task_session_submit',args:{decision:{action,summary:'资料检查已结束。',evidence:[],limitations:[]}}})
test('native file capability rejects other-task absolute paths, symlinks, and host control data before operation dispatch', {skip:!available?reason:false,timeout:30000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'task-file-boundary-'))
  let host,step=0
  t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
  const privatePath=join(root,'tasks','other-task','materials','private.txt')
  await mkdir(join(root,'tasks','other-task','materials'),{recursive:true})
  await writeFile(privatePath,'OTHER_TASK_PRIVATE_MARKER')
  await mkdir(join(root,'control-real'))
  await symlink(join(root,'control-real'),join(root,'control-alias'),'dir')
  host=await nativeTaskHost(root,async(request,h)=>{
    const input=latestInput(request), names=request.tools.map(tool=>tool.name)
    const topicCalls=topicTaskCalls(request,{title:'读取本任务资料'})
    if(topicCalls)return topicCalls
    if(names.includes('task_delegate')){
      if(!input.executions.length){if(!h.delegated){h.delegated=true;return[{name:'task_delegate',args:{key:'read',objective:'仅读取本任务资料'}}]}return[decision('wait')]}
      return[decision('complete')]
    }
    const execution=(await h.query('execution.list'))[0]
    const work=join(root,'tasks',execution.taskId)
    if(step===0){await symlink(privatePath,join(work,'alias.txt'));await writeFile(join(work,'own.txt'),'OWN_TASK_ALLOWED');step++;return[{name:'read',args:{file_path:privatePath}}]}
    if(step++===1)return[{name:'read',args:{file_path:join(work,'alias.txt')}}]
    if(step===3)return[{name:'read',args:{file_path:join(root,'control-real','dynamic.db')}}]
    if(step===4)return[{name:'read',args:{file_path:join(work,'missing-file.txt')}}]
    if(step===5)return[{name:'read',args:{file_path:work}}]
    if(step===6)return[{name:'read',args:{file_path:join(work,'own.txt')}}]
    return[{name:'execution_submit',args:{output:{status:'completed',summary:'本任务资料已读取，越界资料被拒绝。',evidence:[],limitations:[],artifacts:[]}}}]
  }, {config:{dbPath:join(root,'control-alias','dynamic.db')}})
  await host.service.ingest({groupId:'native-group',messageId:'boundary-message',senderOpenDingTalkId:'native-user',text:'测试助手，仅读取本任务资料。',occurredAt:'2026-10-13T11:00:00Z',timestamp:'2026-10-13T11:00:00Z'})
  await waitUntil(async()=> (await host.query('task.list'))[0]?.status==='completed','file denial correction completes')
  await host.service.whenIdle()
  const denied=host.toolResults.filter(item=>item.name==='read'&&item.result.isError)
  assert.equal(denied.length,5)
  assert.equal(denied.filter(item=>JSON.stringify(item.result).includes('TASK_FILESYSTEM_SCOPE_FORBIDDEN')).length,3)
  assert.ok(JSON.stringify(denied).includes('TASK_FILE_NOT_FOUND'))
  assert.ok(JSON.stringify(denied).includes('TASK_FILE_NOT_REGULAR'))
  assert.ok(!JSON.stringify(host.requests).includes('OTHER_TASK_PRIVATE_MARKER'))
  assert.ok(JSON.stringify(host.requests).includes('OWN_TASK_ALLOWED'))
  assert.ok(!(await host.query('operation.list')).some(item=>item.state==='unknown'),'pre-dispatch denials must not become unknown writes')
})
