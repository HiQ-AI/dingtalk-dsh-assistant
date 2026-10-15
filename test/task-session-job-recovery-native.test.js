import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { available, reason, nativeShell, nativeTaskHost, latestInput, waitUntil, modelToolValues } from './fixtures/task-session-native-host.js'
const test = (name, fn) => testRunner(name, { timeout: 30000, ...(!available ? { skip: reason } : {}) }, fn)
const call = (name, args) => ({ name, args })
const decide = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })
async function fixture(t, model) {
 const root = await mkdtemp(join(tmpdir(), 'native-job-recovery-'))
 const h = await nativeTaskHost(root, model, { promoteOnTimeout: true })
 t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
 return h
}
test('native execution consumes serial tool results and wakes the coordinator only for a reported stage and final result', async t => {
 let step = 0, ownerTurns = 0
 const h = await fixture(t, async (request, host) => {
  if (request.tools.some(tool => tool.name === 'task_delegate')) {
   ownerTurns++
   const input = latestInput(request)
   if (!input.executions.length) return [call('task_delegate', { key: 'serial', objective: '完成多个操作并报告阶段成果' }), decide('wait', '执行已开始')]
   return [decide(input.executions.every(item => item.status === 'succeeded') ? 'complete' : 'wait', '已收到阶段或最终成果')]
  }
  const currentStep = step++
  assert.equal((await host.query('wake.list')).filter(item => item.kind === 'operation.result').length, 0, '普通原生工具结果留给原执行，不产生统筹空转唤醒')
  await host.service.recover()
  if (currentStep === 3) await waitUntil(() => ownerTurns === 2, 'coordinator observes the explicit stage report')
  if (currentStep === 2) return [call('execution_report_progress', { summary: '前两项已落盘并回读，继续完成最后一项。', evidence: ['serial-results.txt'] })]
  if (currentStep === 4) return [call('execution_submit', { output: { status: 'completed', summary: '三项原生操作完成并核验', evidence: ['serial-results.txt'], limitations: [], artifacts: ['serial-results.txt'] } })]
  const value = currentStep === 3 ? 3 : currentStep + 1
  return [call(nativeShell, { command: nativeShell === 'pwsh' ? `Add-Content serial-results.txt '${value}'; Get-Content serial-results.txt` : `printf '${value}\\n' >> serial-results.txt; cat serial-results.txt`, description: '写入并回读本执行的隔离证据' })]
 })
 const task = await h.service.createTask({ groupId: 'native-group', requestId: 'serial-operation-wakes', objective: '阶段成果驱动统筹' })
 await h.service.whenIdle()
 assert.equal(ownerTurns, 3, '仅初次委派、阶段成果、最终成果各一次统筹回合')
 assert.equal(step, 5)
 const operations = await h.query('operation.list', { taskId: task.taskId }), executions = await h.query('execution.list', { taskId: task.taskId })
 assert.equal(operations.length, 3)
 assert.ok(operations.every(item => item.state === 'succeeded' && item.executionId === executions[0].executionId))
 assert.equal(executions.length, 1); assert.equal(executions[0].inputVersion, 1); assert.equal(executions[0].drained, true)
 const wakes = await h.query('wake.list', { taskId: task.taskId })
 assert.equal(wakes.filter(item => item.kind === 'operation.result').length, 0)
 assert.equal(wakes.filter(item => item.kind === 'execution.stage.progress').length, 1)
 assert.equal(wakes.filter(item => item.kind === 'execution.result').length, 1)
 assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
 assert.deepEqual((await readFile(join(h.root, 'tasks', task.taskId, 'serial-results.txt'), 'utf8')).trim().split(/\r?\n/), ['1', '2', '3'])
})
for (const background of [false, true]) test(`native shell retains its original process, reads output to terminal and persists the owned job receipt: background=${background}`, async t => {
 let step = 0, backgroundCollected = false
 const h = await fixture(t, async request => {
  const input = latestInput(request), owner = request.tools.some(tool => tool.name === 'task_delegate')
  if (owner) return !input.executions.length && !input.task.lastDecision ? [call('task_delegate', { key: 'long', objective: 'long' }), decide('wait','waiting')]
   : [decide(input.executions.every(e => e.status === 'succeeded') ? 'complete' : 'wait','verified')]
  if (step++ === 0) return [call(nativeShell, { command: nativeShell === 'pwsh' ? "Write-Output 'before'; Start-Sleep -Milliseconds 400; Set-Content result.txt 'after'; Write-Output 'after'" : "printf 'before\\n'; sleep 0.4; printf 'after\\n' | tee result.txt", ...(background ? { run_in_background: true } : {}), timeoutMs: 80, description: 'Promote and retain original command' })]
  assert.match(JSON.stringify(request), /nativeJobReceipt/)
  if (background && !backgroundCollected) {
   backgroundCollected = true
   const receipt = modelToolValues(request).findLast(value => value.nativeJobReceipt)?.nativeJobReceipt
   return [call('job_output', { job_id: receipt.jobId, wait: true, timeout_ms: 10000 })]
  }
  assert.match(JSON.stringify(request), /after/)
  return [call('execution_submit',{output:{status:'completed',summary:'done',evidence:['actual terminal output'],limitations:[],artifacts:['result.txt']}})]
 })
 const created = await h.service.createTask({groupId:'native-group',requestId:'job-complete',objective:'long task'})
 await h.service.whenIdle()
 const operations = (await h.query('operation.list',{taskId:created.taskId})).filter(op => op.definition.toolName === nativeShell)
 assert.equal(operations.length,1)
 assert.equal(operations[0].state,'succeeded')
 assert.ok(operations[0].job, JSON.stringify(h.toolResults)); assert.equal(operations[0].job.status,'completed')
 assert.equal(operations[0].job.owner,(await h.query('execution.list'))[0].sessionId)
 assert.match(operations[0].job.chunks.map(c=>c.text).join(''),/before[\s\S]*after/)
 assert.equal((await readFile(join(h.root,'tasks',created.taskId,'result.txt'),'utf8')).trim(),'after')
 assert.equal(step,background ? 3 : 2)
})

test('native missing-job read stays a real error without creating unknown effects or blocking later work', async t => {
 let step=0
 const h=await fixture(t,async request=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate'))return !input.executions.length&&!input.task.lastDecision
   ?[call('task_delegate',{key:'read-job',objective:'inspect missing job'}),decide('wait','waiting')]
   :[decide(input.executions.every(e=>e.status==='succeeded')?'complete':'wait','verified')]
  if(step++===0)return [call('job_output',{job_id:'pwsh-777777'})]
  if(step===2){assert.match(JSON.stringify(request),/unknown job pwsh-777777/);return [call('job_list',{})]}
  return [call('execution_submit',{output:{status:'completed',summary:'Missing read remains failed, no external effects',evidence:['original missing-job receipt'],limitations:[],artifacts:[]}})]
 })
 await h.service.createTask({groupId:'native-group',requestId:'read-job',objective:'inspect job'})
 await h.service.whenIdle()
 assert.equal((await h.query('operation.list')).length,0)
 assert.ok(h.toolResults.some(row=>row.name==='job_output'&&row.result.isError))
 assert.equal((await h.query('execution.list'))[0].status,'succeeded')
})

for (const explicitStop of [false, true]) test(`native background HTTP service remains usable by the next tool and drains its original job: explicitStop=${explicitStop}`, async t => {
 let step = 0, originalJob, serverPid
 const h = await fixture(t, async (request, host) => {
  const input = latestInput(request)
  if (request.tools.some(tool => tool.name === 'task_delegate')) return !input.executions.length && !input.task.lastDecision
   ? [call('task_delegate', { key: 'service', objective: 'use service' }), decide('wait', 'waiting')]
   : [decide(input.executions.every(e => e.status === 'succeeded') ? 'complete' : 'wait', 'verified')]
  if (step++ === 0) {
   const script = join(h.root, 'service.cjs'), ready = join(h.root, 'ready.json')
   await writeFile(script, `const fs=require('fs'),http=require('http');const s=http.createServer((q,r)=>r.end('original-service'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,port:s.address().port})));`)
   return [call(nativeShell, { command: `${nativeShell === 'pwsh' ? '& ' : ''}'${process.execPath}' '${script}'`, run_in_background: true, description: 'Original owned HTTP service' })]
  }
  if (step === 2) {
   const receipt = modelToolValues(request).findLast(value => value.nativeJobReceipt)?.nativeJobReceipt
   assert.equal(receipt.status, 'running')
   originalJob = receipt.jobId
   const ready = await waitUntil(async () => { try { return JSON.parse(await readFile(join(h.root, 'ready.json'), 'utf8')) } catch {} }, 'background service ready')
   serverPid = ready.pid
   const operation = (await host.query('operation.list')).find(op => op.job?.jobId === originalJob)
   assert.equal(operation.state, 'starting')
   return [call(nativeShell, { command: nativeShell === 'pwsh' ? `(Invoke-WebRequest 'http://127.0.0.1:${ready.port}' -NoProxy).Content` : `curl --noproxy '*' 'http://127.0.0.1:${ready.port}'`, description: 'Use existing service from the next tool' })]
  }
  assert.match(JSON.stringify(request), /original-service/)
  if (explicitStop && step === 3) return [call('job_kill', { job_id: originalJob })]
  return [call('execution_submit', { output: { status: 'completed', summary: 'Actual HTTP request passed', evidence: ['original-service response'], limitations: [], artifacts: [] } })]
 })
 await h.service.createTask({ groupId: 'native-group', requestId: 'service', objective: 'Use and clean original service' })
 await h.service.whenIdle()
 assert.equal((await h.query('execution.list'))[0].drained, true)
 const operation = (await h.query('operation.list')).find(op => op.job?.jobId === originalJob)
 assert.equal(operation.job.jobId, originalJob)
 assert.ok(['killed', 'failed', 'completed'].includes(operation.job.status))
 assert.notEqual(operation.state, 'starting')
 assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' })
})
for (const background of [false, true]) test(`cancelling a native job records terminal cancellation and drains the actual owned process: background=${background}`, async t => {
 const h=await fixture(t,async request=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')) return input.executions.length?[decide('wait','waiting')]:[call('task_delegate',{key:'cancel',objective:'cancel'}),decide('wait','waiting')]
  return [call(nativeShell,{command:nativeShell==='pwsh'?"Write-Output 'started'; Start-Sleep -Seconds 30; Set-Content forbidden.txt done":"printf 'started\\n'; sleep 30; printf done > forbidden.txt",timeoutMs:80,...(background?{run_in_background:true}:{}),description:'Long cancellable process'})]
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


test('operator exact error resolution has zero-write HTTP check, retains partial effects and resumes original execution without replay', async t => {
 let originalStep=0, readStep=0, errorCalls=0, replied=false, resumed=false
 const h=await fixture(t,async(request,host)=>{
  const input=latestInput(request)
  if(request.tools.some(tool=>tool.name==='task_delegate')) {
   const executions=await host.query('execution.list'),operations=await host.query('operation.list')
   if(!executions.length)return [call('task_delegate',{key:'original-error',objective:'original-error'}),decide('wait','waiting')]
   const operation=operations.find(op=>op.definition.toolName==='test_remote_write')
   if(!executions.some(e=>e.key==='inspect-error'))return [call('task_delegate',{key:'inspect-error',objective:'inspect-error',readOnly:true,readbackOperationId:operation.operationId}),decide('wait','inspect original receipt')]
   if(!replied)return [call('task_request_human',{audience:'operator',reason:'Original response failed; effects remain uncertain',question:'Settle only the recorded failure, retain possible partial effects',evidence:[],attemptedActions:['Completed bound read-only investigation']})]
   if(!resumed){resumed=true;return [call('task_delegate',{key:'resume-original',objective:'resume-original',executionId:executions.find(e=>e.key==='original-error').executionId,readOnly:true}),decide('wait','resume same execution')]}
   return [decide('complete','original resumed without replay')]
  }
  if(input.objective==='inspect-error') {
   if(readStep++===0)return [call('read',{file_path:'evidence.txt'})]
   return [call('execution_submit',{output:{status:'completed',summary:'Original error read; effects unverified',evidence:['evidence.txt'],limitations:['partial effects possible'],artifacts:[]}})]
  }
  if(input.objective==='resume-original')return [call('execution_submit',{output:{status:'completed',summary:'Same execution resumed',evidence:[],limitations:['partial effects possible'],artifacts:[]}})]
  if(originalStep++===0){
   const execution=(await host.query('execution.list'))[0],agent=host.ctx.agents.get(execution.sessionId)
   agent.ctx.tools.register({name:'test_remote_write',description:'Simulated remote write with failed acknowledgement',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute(){errorCalls++;throw new Error('DATABASE_NOT_FOUND')}})
   return [call('write',{file_path:'evidence.txt',content:'original failure evidence'})]
  }
  if(originalStep===2)return [call('test_remote_write',{})]
  return [call('execution_submit',{output:{status:'blocked',summary:'Original request failed',evidence:[],limitations:['partial effects possible'],artifacts:[]}})]
 })
 const created=await h.service.createTask({groupId:'native-group',requestId:'operator-resolution',objective:'investigate original'})
 await h.service.whenIdle()
 const waiting=await h.query('task.get',{taskId:created.taskId}),original=(await h.query('execution.list')).find(e=>e.key==='original-error')
 const operation=(await h.query('operation.list')).find(op=>op.state==='unknown')
 const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex')
 const human=waiting.humanRequests.find(item=>item.status==='waiting-reply')
 const body={requestId:'operator-exact-resolution',reply:'Settle original failed response; partial effects remain unverified; no replay or deployment authorization',expectedRequirementRevision:waiting.requirementRevision,expectedControlRevision:waiting.controlRevision,
  nativeFailureResolutions:[{operationId:operation.operationId,expectedOperationDigest:hash(operation)}]}
 const server=createServer((req,res)=>handleRequest(req,res,{respondTaskHumanRequest:args=>h.service.respondHumanRequest(args)}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const url=`http://127.0.0.1:${server.address().port}/tasks/${created.taskId}/human-requests/${human.requestId}/reply`
 const post=(suffix,value=body,headers={})=>fetch(url+suffix,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)})
 assert.equal((await post('/check',body,{origin:'https://outside.invalid'})).status,403)
 const check=await post('/check'),checked=await check.json();assert.equal(check.status,200,JSON.stringify(checked));assert.equal(checked.writes,0)
 assert.equal((await h.query('operation.get',{operationId:operation.operationId})).state,'unknown')
 assert.equal((await h.query('source.list')).some(item=>item.requestIdentity?.nativeFailureResolutions),false)
 const bad=await post('/check',{...body,nativeFailureResolutions:[{operationId:operation.operationId,expectedOperationDigest:'0'.repeat(64)}]});assert.equal(bad.status,409)
 replied=true
 const response=await post('');assert.equal(response.status,200,JSON.stringify(await response.json()))
 await h.service.whenIdle()
 const after=await h.query('operation.get',{operationId:operation.operationId})
 assert.equal(after.state,'failed');assert.equal(after.result.partialEffectsPossible,true);assert.equal(after.result.noEffect,undefined);assert.deepEqual(after.result.previousObservation,operation)
 assert.ok(after.result.operatorSourceId);assert.equal(errorCalls,1)
 assert.equal((await post('')).status,200)
 assert.equal((await post('',{...body,reply:'changed scope'})).status,409)
 const continued=await h.query('execution.get',{executionId:original.executionId});assert.equal(continued.sessionId,original.sessionId);assert.equal(continued.inputVersion,2)
 assert.equal((await h.query('task.get',{taskId:created.taskId})).status,'completed')
})
