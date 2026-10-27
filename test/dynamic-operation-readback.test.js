import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectStoppedNativeOperation, inspectInvestigatedNativeFailure, inspectFailedNativeWebRead, inspectFailedNativeFileMutation, inspectFailedNativeJobRead, readNativeOperationContext, legacyDrainedError, readExecutionProgress } from '../packages/dingtalk-dsh-assistant/dynamic-operation-readback.js'
import { isNativeFilePrecondition } from '../packages/dingtalk-dsh-assistant/dynamic-filesystem-scope.js'
import { sessionPersistenceFixture } from './fixtures/session-persistence.js'
// Reproduce the a5 nativeOperation ledger's canonical arguments/content digest.
const canonical = value => value && typeof value==='object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function fixture(){
 const binding={kind:'task-execution',taskId:'task',executionId:'execution',sessionId:'session',inputVersion:1,leaseEpoch:1,inputDigest:'original'}
 const operation={operationId:'operation',taskId:'task',executionId:'execution',dispatchBinding:binding,state:'unknown',key:'native:execution:1:1:call-1',definition:{toolName:'pwsh',argumentsDigest:hash({command:'git fetch origin --prune',timeoutMs:20000})},result:{toolName:'pwsh',callId:'call-1',isError:true,resultDigest:hash([{type:'text',text:legacyDrainedError}])},updatedAt:'2026-10-14T01:00:00Z'}
 const execution={...binding,drained:true,recovering:false}
 const readback={...binding,executionId:'readback',sessionId:'readback-session',inputDigest:'readback-input',status:'succeeded',drained:true,definition:{recoveryReadOnly:true},input:{readbackOperationId:'operation'},updatedAt:'2026-10-14T02:00:00Z'}
 const seed=b=>({seq:0,type:'plugin:dingtalk/execution-session',data:{identity:b}})
 const input=b=>({seq:1,type:'user/message',data:{source:{executionSession:{sessionId:b.sessionId,leaseEpoch:b.leaseEpoch,inputVersion:b.inputVersion,inputDigest:b.inputDigest,requirementRevision:1,controlRevision:1}}}})
 const original=[seed(binding),input(binding),{seq:2,type:'tool/call',data:{callId:'call-1',name:'pwsh',arguments:JSON.stringify({command:'git fetch origin --prune',timeoutMs:20000})}},
  {seq:3,type:'tool/result',data:{message:{role:'tool',toolCallId:'call-1',isError:true,content:[{type:'text',text:'Error: '+legacyDrainedError}]}}}]
 const readEvents=[seed(readback),input(readback),{seq:2,type:'tool/call',data:{callId:'read-1',name:'read',arguments:JSON.stringify({file_path:'.git/FETCH_HEAD'})}},
  {seq:3,type:'tool/result',data:{message:{role:'tool',toolCallId:'read-1',isError:false,content:[{type:'text',text:'Observed actual refs; fetch completion remains unknown'}]}}}]
 const live=new Set(),jobs=[]
 const ctx={agents:{get:id=>live.has(id)},sessions:{get:()=>undefined},get:name=>name==='jobs'?{list:()=>jobs}:undefined,
  sessionPersistence:sessionPersistenceFixture(async id=>({meta:{id},events:id==='session'?original:readEvents}))}
 return {ctx,operation,execution,executions:[execution,readback],original,readEvents,live,jobs,readback}
}
function webFailure() {
 const f=fixture()
 f.operation.definition.toolName=f.operation.result.toolName=f.original[2].data.name='web_fetch'
 f.original[2].data.arguments=JSON.stringify({url:'https://example.invalid/document'})
 f.operation.definition.argumentsDigest=hash(JSON.parse(f.original[2].data.arguments))
 f.original[3].data.message.content=[{type:'text',text:'Error: unsupported content type "unknown"'}]
 f.operation.result.resultDigest=hash(f.original[3].data.message.content)
 f.original[2].data.turn=f.original[3].data.turn=1
 for(const event of f.original.slice(1))event.seq++
 f.input=f.original[1];f.call=f.original[2];f.result=f.original[3]
 f.original.splice(1,0,{seq:1,type:'turn/start',data:{turn:1}})
 f.end={seq:5,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}};f.original.push(f.end)
 return f
}

for (const drained of [true, false]) test(`Host restart running acknowledgement and successful investigation do not invent a terminal result: drained=${drained}`, async () => {
 const f = fixture()
 f.operation.result = null
 f.operation.recoveryReason = 'host_restart'
 f.operation.job = { jobId: 'original-owned-job', owner: f.execution.sessionId, startedAt: 100, status: 'running' }
 f.execution.drained = drained
 // Draft retained a successful launch acknowledgement; material retained only registration.
 if (drained) f.original[3].data.message = { role: 'tool', toolCallId: 'call-1', isError: false,
  content: [{ type: 'text', text: JSON.stringify({ nativeJobReceipt: f.operation.job }) }] }
 else f.original.pop()
 assert.equal(await inspectStoppedNativeOperation(f), null)
 assert.equal(await inspectInvestigatedNativeFailure(f), null)
 assert.equal(await inspectFailedNativeWebRead(f), null)
 assert.equal(f.operation.state, 'unknown')
 assert.equal(f.operation.job.status, 'running')
 assert.equal(f.operation.job.finishedAt, undefined)
})

test('历史原生job读取仅凭精确missing-job拒绝和完整终态结算，写工具与替换身份仍拒绝', async()=>{
 const make=()=>{
  const f=webFailure()
  f.operation.definition.toolName=f.operation.result.toolName=f.call.data.name='job_output'
  f.operation.definition.effectClass='unknown'
  f.call.data.arguments=JSON.stringify({job_id:'pwsh-7'})
  f.operation.definition.argumentsDigest=hash(JSON.parse(f.call.data.arguments))
  f.result.data.message.content=[{type:'text',text:'Error: unknown job pwsh-7'}]
  f.operation.result.resultDigest=hash(f.result.data.message.content)
  return f
 }
 const proof=await inspectFailedNativeJobRead(make())
 assert.equal(proof.kind,'native-job-read-missing');assert.equal(proof.jobId,'pwsh-7');assert.equal(proof.noEffect,true)
 for(const mutate of [
  f=>{f.operation.definition.toolName='job_kill'},f=>{f.operation.definition.effectClass='write'},
  f=>{f.operation.definition.nativeJobRead=false},f=>{f.operation.result.cancelled=true},
  f=>{f.result.data.message.isError=false},f=>{f.result.data.message.content[0].text='Error: arbitrary failure'},
  f=>{f.call.data.arguments=JSON.stringify({job_id:'pwsh-8'})},f=>{f.execution.drained=false},
  f=>{f.end.data.reason.kind='aborted'},f=>{f.jobs.push({status:'running'})},
 ]){const f=make();mutate(f);assert.equal(await inspectFailedNativeJobRead(f),null)}
})

function fileFailure(code = 'FS_NOT_OBSERVED') {
 const f=webFailure()
 f.operation.definition.toolName=f.operation.result.toolName=f.call.data.name='edit'
 f.operation.definition.effectClass='unknown'
 f.result.data.error={name:'FsError',code}
 return f
}
for(const code of ['FS_NOT_OBSERVED','FS_STALE_VERSION','FS_NOT_FOUND','FS_NOT_DIRECTORY','FS_NOT_REGULAR_FILE','FS_NOT_TEXT','FS_TOO_LARGE','FS_EDIT_NOT_FOUND','FS_AMBIGUOUS_EDIT'])
 test(`文件前置拒绝按Host错误码对账而非文字或当前文件: ${code}`,async()=>{
  const f=fileFailure(code), proof=await inspectFailedNativeFileMutation(f)
  assert.equal(proof.kind,'native-file-precondition-failed');assert.equal(proof.errorCode,code);assert.equal(proof.noEffect,true)
  assert.equal(isNativeFilePrecondition('write',{code}),true)
 })
test('IO/权限/取消/未知错误及伪造正文不能证明无文件效果',async()=>{
 for(const code of ['FS_IO_ERROR','FS_PERMISSION_DENIED','FS_SANDBOX_DENIED','FS_ABORTED','NEW_ERROR',null])
  assert.equal(await inspectFailedNativeFileMutation(fileFailure(code)),null)
 for(const change of [f=>{delete f.result.data.error},f=>{f.operation.result.errorCode='FS_IO_ERROR'},
  f=>{f.operation.result.cancelled=true},f=>{f.live.add('session')},f=>{f.end.data.reason.kind='aborted'},
  f=>{f.operation.definition.toolName='pwsh'},f=>{f.operation.result.resultDigest='changed'}]) {
  const f=fileFailure();change(f);assert.equal(await inspectFailedNativeFileMutation(f),null)
 }
})
test('原网页读取错误以精确调用及正常回合结束证明失败，不要求新调查或重放', async()=>{
 const f=webFailure(), proof=await inspectFailedNativeWebRead(f)
 assert.equal(proof.kind,'native-web-read-failed'); assert.equal(proof.resultSequence,4); assert.equal(proof.turnEndSequence,5)
 assert.equal(proof.operationDigest,hash(f.operation))
 for(const mutate of [
  f=>{f.operation.definition.toolName='pwsh'}, f=>{f.operation.definition.effectClass='write'}, f=>{f.operation.definition.effectClass='unknown'}, f=>{f.operation.result.resultDigest='wrong'},
  f=>{f.call.data.arguments='{"url":"https://different.invalid"}'},
  f=>{f.original[0].data.identity.sessionId='wrong'}, f=>{f.input.data.source.executionSession.leaseEpoch++},
  f=>{f.result.data.message.isError=false}, f=>{f.result.data.message.toolCallId='wrong'},
  f=>{f.original.pop()}, f=>{f.end.data.reason.kind='aborted'}, f=>{f.end.data.turn=2},
  f=>{f.original.splice(1,1)}, f=>{f.original.splice(3,0,{seq:2.5,type:'turn/start',data:{turn:2}})},
  f=>{f.execution.drained=false}, f=>{f.execution.recovering=true}, f=>{f.live.add('session')},
  f=>{f.jobs.push({status:'running'})}, f=>{f.operation.result.cancelled=true},
 ]) {const bad=webFailure();mutate(bad);assert.equal(await inspectFailedNativeWebRead(bad),null)}
})

test('legacy Host drained error plus bound real readonly observation proves failed partial effects only',async()=>{
 const f=fixture(),proof=await inspectStoppedNativeOperation(f)
 assert.equal(proof.kind,'legacy-host-drained-partial');assert.equal(proof.partialEffectsPossible,true)
 assert.equal(proof.observations[0].executionId,'readback')
 assert.match(proof.conclusion,/does not prove command success/)
})

test('readback context exposes only the digest-bound original native call and result', async () => {
 const f=fixture()
 f.operation.result.resultDigest=hash(f.original[3].data.message.content)
 const context=await readNativeOperationContext(f)
 assert.equal(context.arguments.command,'git fetch origin --prune')
 assert.equal(context.result.isError,true)
 assert.equal(context.callSequence,2)
 for(const mutate of [
  x=>{x.operation.result.resultDigest='wrong'},
  x=>{x.original[2].data.arguments=JSON.stringify({command:'git push origin main'})},
  x=>{x.original[3].data.message.toolCallId='other'},
  x=>{x.original[0].data.identity.sessionId='other'},
  x=>{x.operation.key='other'},
 ]){
  const changed=fixture();changed.operation.result.resultDigest=hash(changed.original[3].data.message.content);mutate(changed)
  assert.equal(await readNativeOperationContext(changed),null)
 }
})
for(const [name,mutate] of Object.entries({
 'model text instead of tool receipt':f=>{f.original[3]={seq:3,type:'assistant/message',data:{message:{content:[{type:'text',text:legacyDrainedError}]}}}},
 'printed error text in successful shell output':f=>{f.original[3].data.message.isError=false},
 'forged ledger result digest':f=>{f.operation.result.resultDigest='0'.repeat(64)},
 'wrong call':f=>{f.original[3].data.message.toolCallId='another-call'},
 'changed arguments':f=>{f.original[2].data.arguments=JSON.stringify({command:'git push origin main',timeoutMs:20000})},
 'wrong session identity':f=>{f.original[0].data.identity={...f.operation.dispatchBinding,sessionId:'other'}},
 'active original agent':f=>f.live.add('session'),
 'live job still running':f=>f.jobs.push({status:'running'}),
 'execution not drained':f=>{f.execution.drained=false},
 'no actual readonly result':f=>f.readEvents.pop(),
 'wrong readback operation':f=>{f.readback.input.readbackOperationId='other'},
 'unrestricted readback':f=>{f.readback.definition.recoveryReadOnly=false},
 'failed readback call':f=>{f.readEvents[3].data.message.isError=true},
 'stale observation predates unknown':f=>{f.readback.updatedAt='2026-10-14T00:00:00Z'},
}))test(`legacy unknown remains fenced: ${name}`,async()=>{const f=fixture();mutate(f);assert.equal(await inspectStoppedNativeOperation(f),null)})


test('execution progress reads exact current input with real bounded excerpts and unfinished call facts', async () => {
 const f=fixture()
 assert.equal('taskId' in f.original[1].data.source.executionSession,false)
 assert.equal('executionId' in f.original[1].data.source.executionSession,false)
 f.original[2].time=1000;f.original[3].time=1100
 const data={message:{content:[{type:'text',text:'正在核对目标接口；password=private-secret '+ '业务证据'.repeat(300)}]}}
 f.original.push({seq:4,type:'assistant/message',time:1200,data},{seq:5,type:'tool/call',time:1300,data:{callId:'pending',name:'read',arguments:'{"file_path":"proof.txt"}'}})
 f.execution.progressReview={lastSequence:3}
 const progress=await readExecutionProgress(f)
 assert.equal(progress.lastSequence,5);assert.equal(progress.previousSequence,3);assert.equal(progress.newEventCount,2)
 assert.equal(progress.lastActivityAt,'1970-01-01T00:00:01.300Z');assert.equal(progress.pendingToolCallCount,1)
 assert.equal(progress.pendingToolCalls[0].callId,'pending')
 assert.equal('preview' in progress.pendingToolCalls[0],false)
 assert.equal(progress.pendingToolCalls[0].digest,hash(f.original.at(-1).data))
 const excerpt=progress.excerpts.find(item=>item.sequence===4)
 assert.equal(excerpt.digest,hash(data));assert.equal(excerpt.truncated,true);assert.ok(excerpt.preview.length<=640)
 assert.match(excerpt.preview,/核对目标接口/);assert.ok(!excerpt.preview.includes('private-secret'))
 assert.ok(progress.excerpts.find(item=>item.type==='tool/result').preview.includes('isError'))
 assert.equal(progress.inputDigest,'original')
 f.execution.progressReview.lastSequence=5
 const unchanged=await readExecutionProgress(f)
 assert.equal(unchanged.newEventCount,0);assert.equal(unchanged.hasNewEvents,false)
 assert.equal(unchanged.pendingToolCallCount,1);assert.equal(unchanged.changed,false);assert.match(unchanged.limitations[0],/无新日志不证明停止/)
 f.original.at(-1).time='2026-10-14T09:00:00Z'
 assert.equal((await readExecutionProgress(f)).lastActivityAt,'2026-10-14T09:00:00.000Z')
 f.original.at(-1).time='invalid-time'
 assert.equal((await readExecutionProgress(f)).lastActivityAt,null)
})

test('running execution progress flushes its existing native writer before the read-only snapshot', async () => {
 const f=fixture(),buffer=f.original.splice(1),live={id:f.execution.sessionId},order=[]
 f.ctx.sessions={get:id=>id===live.id?live:undefined,flush:async session=>{assert.equal(session,live);order.push('flush');f.original.push(...buffer)}}
 const persistence=f.ctx.sessionPersistence,open=persistence.open.bind(persistence)
 persistence.open=async(...args)=>{order.push('read');assert.equal(args[1],'read');return open(...args)}
 const progress=await readExecutionProgress(f)
 assert.deepEqual(order,['flush','read']);assert.ok(progress.excerpts.some(item=>item.type==='tool/call'))
})

test('execution progress rejects wrong identity, stale input version or lease and unavailable persistence', async () => {
 for(const mutate of [
  f=>{f.original[0].data.identity.sessionId='other'},
  f=>{f.execution.inputVersion=2},f=>{f.execution.leaseEpoch=2},f=>{f.execution.inputDigest='changed'},
  f=>{f.original.push({seq:4,type:'user/message',data:{source:{executionSession:{...f.execution,inputVersion:2}}}})},
 ]) { const f=fixture();mutate(f);await assert.rejects(readExecutionProgress(f),/EXECUTION_PROGRESS_(IDENTITY|INPUT)_MISMATCH/) }
 const f=fixture();f.ctx.sessionPersistence.open=async()=>{throw Error('missing')}
 await assert.rejects(readExecutionProgress(f),{code:'EXECUTION_PROGRESS_LOG_UNREADABLE'})
})

test('execution progress limits excerpts to latest eight real events without copying full logs', async () => {
 const f=fixture()
 for(let seq=4;seq<20;seq++)f.original.push({seq,time:seq,type:'assistant/message',data:{message:{content:[{type:'text',text:'业务检查 '+seq}]}}})
 const view=await readExecutionProgress(f)
 assert.equal(view.excerpts.length,8);assert.ok(view.excerpts.reduce((sum,item)=>sum+item.preview.length,0)<=8*640);assert.equal(view.excerpts[0].sequence,12);assert.equal(view.excerpts.at(-1).sequence,19)
 assert.equal(view.excerpts.at(-1).digest,hash(f.original.at(-1).data));assert.equal('events' in view,false)
})


test('investigated native error closes failed with partial effects, never infers noEffect from DATABASE_NOT_FOUND', async () => {
 const make=()=>{const f=webFailure(); f.operation.definition.toolName=f.operation.result.toolName=f.call.data.name='mcp__bytebase__get_schema';
  f.call.data.arguments=JSON.stringify({database:'uat2',include:'summary'});f.operation.definition.argumentsDigest=hash(JSON.parse(f.call.data.arguments));
  f.result.data.message.content=[{type:'text',text:'Error: {"code":"DATABASE_NOT_FOUND"}'}];f.operation.result.resultDigest=hash(f.result.data.message.content);return f}
 const f=make(),proof=await inspectInvestigatedNativeFailure(f)
 assert.equal(proof.kind,'native-investigated-failure');assert.equal(proof.partialEffectsPossible,true);assert.equal(proof.noEffect,undefined)
 assert.equal(proof.observations[0].executionId,'readback')
 for(const mutate of [x=>{x.operation.result.isError=false},x=>{x.operation.result.cancelled=true},x=>{x.end.data.reason.kind='aborted'},
  x=>{x.operation.result.resultDigest='wrong'},x=>{x.execution.drained=false},x=>{x.live.add('readback-session')},
  x=>{x.readback.definition.recoveryReadOnly=false},x=>{x.readback.input.readbackOperationId='other'},x=>{x.readback.status='running'},
  x=>{x.readEvents.pop()},x=>{x.readEvents[3].data.message.isError=true},x=>{x.readback.updatedAt='2026-10-14T00:00:00Z'}]){
  const bad=make();mutate(bad);assert.equal(await inspectInvestigatedNativeFailure(bad),null)
 }
 // Arbitrary tool names and write failures do not become noEffect: failed is only a terminal observation.
 const write=make();write.operation.definition.toolName=write.operation.result.toolName=write.call.data.name='edit';write.operation.definition.effectClass='write'
 assert.equal((await inspectInvestigatedNativeFailure(write)).partialEffectsPossible,true)
})

test('原生edit值校验以绑定参数和精确拒绝回执对账，歧义错误仍保持unknown', async()=>{
 const make=(args={file_path:'a.txt',old_string:'same',new_string:'same'},message='old_string and new_string must differ')=>{
  const f=fileFailure();delete f.result.data.error
  f.call.data.arguments=JSON.stringify(args);f.operation.definition.argumentsDigest=hash(args)
  f.result.data.message.content=[{type:'text',text:`Error: ${message}`}]
  f.operation.result.resultDigest=hash(f.result.data.message.content)
  return f
 }
 for(const [args,message] of [
  [{file_path:'a',old_string:'x',new_string:'x'},'old_string and new_string must differ'],
  [{file_path:' ',old_string:'x',new_string:'y'},'file_path must be a non-empty string'],
  [{file_path:'a',old_string:'',new_string:'y'},'old_string must be a non-empty string']
 ]) {
  const proof=await inspectFailedNativeFileMutation(make(args,message))
  assert.equal(proof.errorCode,'NATIVE_EDIT_ARGUMENT_REJECTED');assert.equal(proof.noEffect,true)
 }
 for(const mutate of [f=>{f.result.data.message.content[0].text='Error: disk failure';f.operation.result.resultDigest=hash(f.result.data.message.content)},
  f=>{f.call.data.arguments=JSON.stringify({file_path:'a',old_string:'x',new_string:'y'});f.operation.definition.argumentsDigest=hash(JSON.parse(f.call.data.arguments))},
  f=>{f.result.data.error={code:'FS_IO_ERROR'}},f=>{f.operation.definition.toolName=f.operation.result.toolName=f.call.data.name='write'},
  f=>{f.execution.drained=false},f=>{f.end.data.reason.kind='aborted'},f=>{f.operation.definition.argumentsDigest='wrong'}]){
  const f=make();mutate(f);assert.equal(await inspectFailedNativeFileMutation(f),null)
 }
 assert.equal(isNativeFilePrecondition('write',{code:'NATIVE_EDIT_ARGUMENT_REJECTED'}),false)
})

test('blocked drained turn preserves an earlier failed receipt for operator investigation, without granting automatic recovery', async () => {
 const make=()=>{const f=webFailure();f.end.data.reason.kind='blocked';return f}
 const f=make(),proof=await inspectInvestigatedNativeFailure(f)
 assert.equal(proof.kind,'native-investigated-failure')
 assert.equal(proof.partialEffectsPossible,true)
 assert.equal(proof.noEffect,undefined)
 assert.equal(proof.turnEndSequence,f.end.seq)
 assert.equal(proof.observations[0].executionId,'readback')
 assert.equal(await inspectFailedNativeWebRead(make()),null)
 for(const mutate of [
  x=>{x.execution.drained=false},x=>{x.execution.recovering=true},x=>{x.live.add('session')},
  x=>{x.jobs.push({status:'running'})},x=>{x.jobs.push({status:'stopping'})},
  x=>{x.operation.result.cancelled=true},x=>{x.result.data.message.isError=false},
  x=>{x.readback.input.readbackOperationId='other'},x=>{x.readEvents.pop()},
  x=>{x.end.data.reason.kind='aborted'},x=>{x.end.data.turn=2},x=>{x.original.pop()},
  x=>{x.original.splice(-1,0,{seq:4.5,type:'turn/start',data:{turn:2}})},
 ]){const bad=make();mutate(bad);assert.equal(await inspectInvestigatedNativeFailure(bad),null)}
})
