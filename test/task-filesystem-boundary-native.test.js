import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, nativeShell, latestInput, topicTaskCalls, waitUntil } from './fixtures/task-session-native-host.js'
const decision = action => ({name:'task_session_submit',args:{decision:{action,summary:'资料检查已结束。',evidence:[],limitations:[]}}})
test('动态执行沿原生文件权限读取已授权路径和原任务日志，不再安装插件文件边界', { ...({skip:!available?reason:false,timeout:30000}), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root=await mkdtemp(join(tmpdir(),'task-file-boundary-'))
  let host,step=0
  t.after(async()=>{await host?.close();await rm(root,{recursive:true,force:true})})
  const privatePath=join(root,'tasks','other-task','materials','private.txt')
  await t.beginBusiness()
  await t.step(async () => mkdir(join(root,'tasks','other-task','materials'),{recursive:true}))
  await t.step(async () => writeFile(privatePath,'OTHER_TASK_PRIVATE_MARKER'))
  await t.step(async () => mkdir(join(root,'control-real')))
  await t.step(async () => symlink(join(root,'control-real'),join(root,'control-alias'),process.platform==='win32'?'junction':'dir'))
  host=await t.step(async () => nativeTaskHost(root,async(request,h)=>{
    const input=latestInput(request), names=request.tools.map(tool=>tool.name)
    const topicCalls=topicTaskCalls(request,{title:'读取本任务资料'})
    if(topicCalls)return topicCalls
    if(names.includes('task_delegate')){
      if(!input.executions.length){if(!h.delegated){h.delegated=true;return[{name:'task_delegate',args:{key:'read',objective:'仅读取本任务资料'}}]}return[decision('wait')]}
      return[decision('complete')]
    }
    const execution=(await h.query('execution.list'))[0]
    const work=join(root,'tasks',execution.taskId)
    if(step===0){await link(privatePath,join(work,'alias.txt'));await writeFile(join(work,'own.txt'),'OWN_TASK_ALLOWED');await writeFile(join(work,'.dsh','fixture.log'),'OWN_LOG_ALLOWED');step++;return[{name:'read',args:{file_path:privatePath}}]}
    if(step++===1)return[{name:'read',args:{file_path:join(work,'alias.txt')}}]
    if(step===3)return[{name:'read',args:{file_path:join(work,'.dsh','fixture.log')}}]
    if(step===4)return[{name:'read',args:{file_path:join(work,'missing-file.txt')}}]
    if(step===5)return[{name:'read',args:{file_path:work}}]
    if(step===6)return[{name:'read',args:{file_path:join(work,'own.txt')}}]
    return[{name:'execution_submit',args:{output:{status:'completed',summary:'已授权路径及原任务日志按原生能力读取。',evidence:[],limitations:[],artifacts:[]}}}]
  }, {config:{dbPath:join(root,'control-alias','dynamic.db')}}))
  await t.step(async () => host.service.ingest({groupId:'native-group',messageId:'boundary-message',senderOpenDingTalkId:'native-user',text:'测试助手，读取已授权文件及原任务日志。',occurredAt:'2026-10-13T11:00:00Z',timestamp:'2026-10-13T11:00:00Z'}))
  await t.step(async () => waitUntil(async()=> (await host.query('task.list'))[0]?.status==='completed','file denial correction completes'))
  await t.step(async () => host.service.whenIdle())
  const denied=host.toolResults.filter(item=>item.name==='read'&&item.result.isError)
  assert.equal(denied.length,2)
  assert.ok(!JSON.stringify(denied).includes('TASK_FILESYSTEM_SCOPE_FORBIDDEN'))
  assert.ok(JSON.stringify(host.requests).includes('OTHER_TASK_PRIVATE_MARKER'))
  assert.ok(JSON.stringify(host.requests).includes('OWN_LOG_ALLOWED'))
  assert.ok(JSON.stringify(host.requests).includes('OWN_TASK_ALLOWED'))
  assert.ok(!(await t.step(async () => host.query('operation.list'))).some(item=>item.state==='unknown'),'pre-dispatch denials must not become unknown writes')
}))

test('已有未知记录及旧全局锁不阻断原生GitHub CLI查询，原未知操作保持', { ...({skip:!available?reason:false,timeout:30000}), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-native-github-'))
  let host, step = 0
  t.after(async () => { await host?.close(); await rm(root, {recursive:true,force:true}) })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async request => {
    const calls = topicTaskCalls(request)
    if (calls) return calls
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!input.executions.length) return [{ name:'task_delegate', args:{ key:'github-read', objective:'按原生能力核对GitHub CLI', readOnly:true } }, decision('wait')]
      return [decision('wait')]
    }
    if (step++ === 0) {
      const [execution] = await host.query('execution.list')
      const binding = await host.query('execution.binding', { executionId: execution.executionId })
      const command = (kind, args, id) => host.service.store.command({kind,args,id})
      await command('operation.prepare', {binding,operationId:'prior-unknown',key:'prior-unknown',definition:{toolName:'web_fetch'},resourceKeys:['host-native-operation']}, 'fixture-prepare')
      await command('operation.start', {binding,operationId:'prior-unknown'}, 'fixture-start')
      await command('operation.settle', {binding,operationId:'prior-unknown',state:'unknown',result:{partial:true}}, 'fixture-unknown')
      return [{ name:nativeShell, args:{command:'gh --version',description:'核对GitHub CLI版本',timeout_ms:10000} }]
    }
    return [{name:'execution_submit',args:{output:{status:'completed',summary:'GitHub CLI通过原生终端查询成功。',evidence:['原生命令回执'],limitations:[],artifacts:[]}}}]
  }))
  await t.step(async () => host.service.ingest({groupId:'native-group',messageId:'native-github-request',senderOpenDingTalkId:'native-user',text:'测试助手，核对GitHub CLI是否可通过原生终端查询。',occurredAt:new Date().toISOString()}))
  await t.step(async () => host.service.whenIdle())
  const [execution] = await t.step(async () => host.query('execution.list'))
  assert.equal(execution.status, 'succeeded', JSON.stringify(host.service.listAlerts()))
  const result = host.toolResults.find(item => item.name === nativeShell)
  assert.equal(result.result.isError, false, JSON.stringify(result.result))
  assert.match(JSON.stringify(result.result), /gh version/)
  assert.equal((await t.step(async () => host.query('operation.get', {operationId:'prior-unknown'}))).state, 'unknown')
  assert.equal((await t.step(async () => host.query('resource.list')))[0].resourceKey, 'host-native-operation')
  assert.ok((await t.step(async () => host.query('operation.list'))).filter(item => item.id !== 'prior-unknown').every(item => item.resourceKeys.length === 0))
}))
