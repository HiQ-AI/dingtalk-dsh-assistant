import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import {createTaskOwnerController} from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import {openTaskSessionControlFixture} from './fixtures/task-session-control-integration.js'
import {executionDigest} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {nodeBinding,saveActual} from './fixtures/task-session-control-adapter.js'
const loopRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {SessionProjectionRegistry}=loopRequire('@deepseek-ai/dsh-session-projection')
test('real configured model chooses isolated takeover and verified continuation',{timeout:180000,skip:process.env.DSH_ARCHIVE_LIVE_MODEL_TEST!=='1'},async t=>{
 process.env.DSH_HOME='D:/dsh_home' // Existing provider login only: no credential copy, setup, logout or login.
 const root=resolve('docs/tmp/task-session-control/cold-start-fix/real-model-round-2');await mkdir(root,{recursive:true})
 const ctx=new Context();new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx);new SessionTitleService(ctx,{fallbackMaxWords:10,fallbackMaxBytes:120,maxTitleBytes:200});new SystemPrompt(ctx,{includeRuntimeContext:false,includeHarnessIdentity:false});new LlmRuntime(ctx);new ToolRuntime(ctx);new JsonlSessionPersistence(ctx,{root:join(root,'sessions'),packChunks:false,compression:'none',writeBatchMaxDelayMs:1});await ctx.plugin(AgentLoop, {agents:[],maxParallelToolCalls:1})
 const plugin=await import('file:///D:/dsh_home/profiles/web/node_modules/dsh-codex-connect/lib/index.js');plugin.apply(ctx,{enableProxy:false,enableSearch:false,enableReserveFallback:false,enableNativeCompaction:false,enableImageTool:false,enableImageGeneration:false,enableAutoReview:false})
 const f=await openTaskSessionControlFixture(t);const goal={request:'Repair this synthetic isolated failed local verification without rerunning its failed executor. Independently produce and verify the requested local artifact, preserve successful preceding work, and advance the next node exactly once. Choose appropriate task execution controls yourself. No network tool, notification, PR or business resource is allowed. After controls succeed submit a wait decision because this is a bounded test, not a business task completion.',acceptanceCriteria:['actual requested artifact'],constraints:[],scope:{}}
 await f.start({input:goal});const before=await f.controller.state(f.runId);assert.equal(before.run.status,'waiting');const calls=[]
 const evidence=async (value,binding)=>{const result=JSON.parse(JSON.stringify(value));const record={kind:'agent-query-evidence',execution:binding,result,verification:{sourceRefs:[before.run.requirementRef],outputDigest:executionDigest(result)}};return {...result,evidenceRef:(await saveActual(f,record)).ref}}
 const tool=(name,description,parameters,fn)=>({name,description,parameters,control:name!=='local_execution_state',execute:async({binding,args})=>{calls.push({name,args});await writeFile(join(root,'actions.json'),JSON.stringify(calls,null,2));const value=await fn(binding,args);return name==='local_execution_state'?evidence(value,binding):JSON.parse(JSON.stringify(value))}})
 const tools=[tool('local_execution_state','Read exact current isolated node status, controls and requested local output.',{type:'object',properties:{},additionalProperties:false},async()=>({state:await f.controller.state(f.runId),expected:f.expected})),tool('produce_actual_file','Create only the fixed allowed local requested file, run its real independent verifier and persist its actual verified output artifact.',{type:'object',properties:{},additionalProperties:false},async()=>{const output=await f.equivalentOutput();return {actual:output,outputRef:(await saveActual(f,output)).ref}}),tool('task_execution_control','Control the current isolated failed node using original Task session. takeover drains and takes responsibility; submit-output admits a real verified artifact and continues the next node; continue resumes a stopped run. Reuse requestId to avoid duplicate control.',{type:'object',properties:{action:{type:'string',enum:['takeover','submit-output','continue']},requestId:{type:'string'},reason:{type:'string'},outputRef:{type:'string'}},required:['action','requestId','reason'],additionalProperties:false},async(binding,args)=>{const b={...await nodeBinding(f),source:'task-session',actorId:binding.sessionId,commandId:args.requestId,reason:args.reason};return args.action==='continue'?f.controller.controlRun({...b,action:args.action}):f.controller.controlNode({...b,action:args.action,outputRef:args.outputRef})})]
 const owner=createTaskOwnerController({ctx,store:f.store,artifacts:f.artifacts,controller:f.controller,modelConfig:()=>({provider:'openai-codex',model:'gpt-5.6-sol'}),advanceTask:async()=>{},authorizeStages:async()=>false,authorizeCompletion:async()=>false,inspectCurrentExecution:async()=>({runId:f.runId,stageId:'produce',nodes:(await f.controller.state(f.runId)).nodes}),controlTools:tools,getWorkspaceDir:()=>root})
 t.after(async()=>{await owner.close();await ctx.fiber.dispose()})
 const initial=await owner.ensure({taskId:f.taskId,sourceKey:'isolated-real-model',criteria:goal.acceptanceCriteria,origin:{}});const plan=await f.controller.taskPlan(f.taskId)
 await f.store.command({id:'bind-original-model-goal',kind:'task.requirement.bind-legacy',args:{taskId:f.taskId,expectedRequirementRevision:plan.task.requirementRevision,requirementRef:(await f.artifacts.put(goal,{taskId:f.taskId})).ref,sessionId:initial.sessionId,criteria:goal.acceptanceCriteria,sourceKey:'isolated-real-model',eventKey:'bind'}})
 await owner.drive(f.taskId);const done=await f.controller.whenIdle(f.runId);const trace=await f.calls();const proof={realModel:true,provider:'openai-codex',model:'gpt-5.6-sol',actions:calls,runStatus:done.run.status,trace,output:await readFile(f.candidatePath,'utf8'),owner:await f.store.query({kind:'task.owner',taskId:f.taskId})};await writeFile(join(root,'result.json'),JSON.stringify(proof,null,2));assert.equal(done.run.status,'succeeded');assert.equal(trace.filter(x=>x.phase==='verify').length,1);assert.equal(trace.filter(x=>x.phase==='deliver').length,1);assert.ok(calls.some(x=>x.name==='task_execution_control'&&x.args.action==='takeover'));assert.ok(calls.some(x=>x.name==='produce_actual_file'));console.log(JSON.stringify({realModel:true,runStatus:done.run.status,actions:calls.map(x=>[x.name,x.args.action]),downstreamCount:1}))
})
