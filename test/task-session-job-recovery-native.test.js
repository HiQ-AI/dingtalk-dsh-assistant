import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeShell, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
const test = (name, fn) => testRunner(name, { timeout: 30000, ...(!available ? { skip: reason } : {}) }, fn)
const call = (name, args) => ({ name, args })
const decide = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })
async function fixture(t, model) {
 const root = await mkdtemp(join(tmpdir(), 'native-job-recovery-'))
 const h = await nativeTaskHost(root, model, { promoteOnTimeout: true })
 t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
 return h
}
test('promoted native shell retains its original process, reads output to terminal and persists the owned job receipt', async t => {
 let step = 0
 const h = await fixture(t, async request => {
  const input = latestInput(request), owner = request.tools.some(tool => tool.name === 'task_delegate')
  if (owner) return !input.executions.length && !input.task.lastDecision ? [call('task_delegate', { key: 'long', objective: 'long' }), decide('wait','waiting')]
   : [decide(input.executions.every(e => e.status === 'succeeded') ? 'complete' : 'wait','verified')]
  if (step++ === 0) return [call(nativeShell, { command: nativeShell === 'pwsh' ? "Write-Output 'before'; Start-Sleep -Milliseconds 400; Set-Content result.txt 'after'; Write-Output 'after'" : "printf 'before\\n'; sleep 0.4; printf 'after\\n' | tee result.txt", timeoutMs: 80, description: 'Promote and retain original command' })]
  assert.match(JSON.stringify(request), /nativeJobReceipt/)
  assert.match(JSON.stringify(request), /after/)
  return [call('execution_submit',{output:{status:'completed',summary:'done',evidence:['actual terminal output'],limitations:[],artifacts:['result.txt']}})]
 })
 const created = await h.service.createTask({groupId:'native-group',requestId:'job-complete',objective:'long task'})
 await h.service.whenIdle()
 const operations = await h.query('operation.list',{taskId:created.taskId})
 assert.equal(operations.length,1)
 assert.equal(operations[0].state,'succeeded')
 assert.ok(operations[0].job, JSON.stringify(h.toolResults)); assert.equal(operations[0].job.status,'completed')
 assert.equal(operations[0].job.owner,(await h.query('execution.list'))[0].sessionId)
 assert.match(operations[0].job.chunks.map(c=>c.text).join(''),/before[\s\S]*after/)
 assert.equal((await readFile(join(h.root,'tasks',created.taskId,'result.txt'),'utf8')).trim(),'after')
 assert.equal(step,2)
})
test('cancelling a promoted native job records terminal cancellation and drains the actual owned process', async t => {
 const h=await fixture(t,async request=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')) return input.executions.length?[decide('wait','waiting')]:[call('task_delegate',{key:'cancel',objective:'cancel'}),decide('wait','waiting')]
  return [call(nativeShell,{command:nativeShell==='pwsh'?"Write-Output 'started'; Start-Sleep -Seconds 30; Set-Content forbidden.txt done":"printf 'started\\n'; sleep 30; printf done > forbidden.txt",timeoutMs:80,description:'Long cancellable process'})]
 })
 const created=await h.service.createTask({groupId:'native-group',requestId:'job-cancel',objective:'cancel task'})
 const operation=await waitUntil(async()=> (await h.query('operation.list')).find(op=>op.job?.status==='running'),'persisted promoted job')
 await h.service.cancelTask({taskId:created.taskId,requestId:'cancel',reason:'Stop owned job'})
 await h.service.whenIdle()
 const after=await h.query('operation.get',{operationId:operation.operationId})
 assert.equal(after.state,'unknown');assert.equal(after.job.cancelled,true)
 assert.ok(['killed','failed'].includes(after.job.status))
 assert.equal((await h.query('execution.list'))[0].drained,true)
 await assert.rejects(readFile(join(h.root,'tasks',created.taskId,'forbidden.txt')), {code:'ENOENT'})
})

test('unknown operation keeps native reads available; owner can investigate readonly but cannot clear missing evidence or replay', async t=>{
 let step=0, ownerRound=0, writes=0, inspectStep=0
 const h=await fixture(t,async(request,host)=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')) {
   if(!input.executions.length) return [call('task_delegate',{key:'unknown',objective:'unknown'}),decide('wait','waiting')]
   if(ownerRound++===0) return [call('task_operation_reconcile',{operationId:input.operations.find(op=>op.state==='unknown').operationId})]
   if(ownerRound===2) {assert.match(JSON.stringify(request),/DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT/);return [call('task_delegate',{key:'inspect',objective:'inspect',executionId:input.executions[0].executionId,readOnly:true}),decide('wait','inspect only')]}
   return [decide('wait','Uncertainty remains; original operation not replayed')]
  }
  if(input.objective==='inspect') {
   const hasRead=inspectStep++>0
   if(!hasRead)return [call('read',{file_path:'evidence.txt'})]
   return [call('execution_submit',{output:{status:'completed',summary:'Read-only receipt',evidence:['read evidence.txt'],limitations:['unknown remains'],artifacts:[]}})]
  }
  if(step++===0){
   const execution=(await host.query('execution.list'))[0],agent=host.ctx.agents.get(execution.sessionId)
   agent.ctx.tools.register({name:'uncertain_native',description:'Simulated external acknowledgement loss',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute(){writes++;throw new Error('lost acknowledgement')}})
   return [call('write',{file_path:'evidence.txt',content:'Read-only receipt'})]
  }
  if(step===2)return [call('uncertain_native',{})]
  if(step===3)return [call('read',{file_path:'evidence.txt'})]
  assert.match(JSON.stringify(request),/Read-only receipt/)
  return [call('execution_submit',{output:{status:'blocked',summary:'unknown',evidence:['read evidence.txt'],limitations:['effect uncertain'],artifacts:[]}})]
 })
 await h.service.createTask({groupId:'native-group',requestId:'uncertain',objective:'inspect unknown'})
 await h.service.whenIdle()
 const ops=await h.query('operation.list'),unknown=ops.filter(op=>op.state==='unknown')
 assert.equal(unknown.length,1);assert.equal(writes,1)
 const execution=(await h.query('execution.list'))[0]
 assert.equal(execution.inputVersion,2);assert.equal(execution.definition.recoveryReadOnly,true)
 assert.ok(h.toolResults.filter(r=>r.name==='read').length>=2, JSON.stringify({execution, results:h.toolResults}))
 assert.ok(h.toolResults.filter(r=>r.name==='read').every(r=>!r.result.isError))
 assert.ok(h.toolResults.some(r=>r.name==='task_operation_reconcile'&&!r.result.isError))
})

test('restart reconciles an original persisted native terminal receipt and resumes the same executor without replay', async t=>{
 const {openDynamicTaskStore}=await import('../packages/dingtalk-dsh-assistant/dynamic-task-store.js')
 const root=await mkdtemp(join(tmpdir(),'native-job-restart-')),hosts=[]
 const store=await openDynamicTaskStore({dbPath:join(root,'dynamic.db'),instanceId:'native-test',initialize:true})
 t.after(async()=>{for(const h of hosts.toReversed())await h.close();await store.close();await rm(root,{recursive:true,force:true})})
 let failSettle=true,step=0
 const wrapped={...store,command:async command=>{
  if(command.kind==='operation.settle'&&failSettle){failSettle=false;throw new Error('Injected loss after durable native job receipt')}
  return store.command(command)
 }}
 const first=await nativeTaskHost(root,async request=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate'))return input.executions.length?[decide('wait','Await original receipt reconciliation')]:[call('task_delegate',{key:'one-command',objective:'original'}),decide('wait','waiting')]
  if(step++===0)return [call(nativeShell,{command:nativeShell==='pwsh'?"Add-Content once.txt once; Start-Sleep -Milliseconds 300; Write-Output done":"printf 'once\\n' >> once.txt; sleep 0.3; printf done",timeoutMs:80,description:'Execute exactly once'})]
  return [call('execution_submit',{output:{status:'blocked',summary:'receipt interrupted',evidence:[],limitations:['reconcile original receipt'],artifacts:[]}})]
 },{store:wrapped,promoteOnTimeout:true});hosts.push(first)
 const created=await first.service.createTask({groupId:'native-group',requestId:'restart',objective:'once'})
 await first.service.whenIdle()
 const before=(await first.query('operation.list'))[0],original=(await first.query('execution.list'))[0]
 assert.equal(before.state,'starting');assert.equal(before.job.status,'completed')
 await first.close();await store.close()
 let ownerStep=0,readStep=0
 const second=await nativeTaskHost(root,async request=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')){
   if(ownerStep++===0){assert.equal(input.operations[0].state,'unknown');return [call('task_operation_reconcile',{operationId:before.operationId})]}
   if(ownerStep===2)return [call('task_delegate',{key:'verify-no-replay',objective:'verify',executionId:original.executionId,readOnly:true}),decide('wait','verify original result')]
   return [decide('wait','verified; task remains under owner control')]
  }
  if(readStep++===0)return [call('read',{file_path:'once.txt'})]
  return [call('execution_submit',{output:{status:'completed',summary:'one original effect',evidence:['read once.txt'],limitations:[],artifacts:['once.txt']}})]
 },{initialize:false,promoteOnTimeout:true});hosts.push(second)
 await second.service.appendTaskContext({taskId:created.taskId,requestId:'inspect-receipt',context:'Inspect the original receipt and verify without replay'})
 await second.service.whenIdle()
 const after=await second.query('operation.get',{operationId:before.operationId}),execution=(await second.query('execution.list'))[0]
 assert.equal(after.state,'succeeded');assert.equal(after.result.reconciled,true)
 assert.equal(execution.executionId,original.executionId);assert.equal(execution.sessionId,original.sessionId)
 assert.equal(execution.inputVersion,2);assert.equal(execution.status,'succeeded')
 assert.equal(await readFile(join(root,'tasks',created.taskId,'once.txt'),'utf8'),process.platform==='win32'?'once\r\n':'once\n')
 assert.equal((await second.query('operation.list')).length,1)
})
