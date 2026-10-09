// 真实云模型 + 原生Owner；正式实例仅GET，独立本地fixture无业务外发入口。
// 先 --check，后 --run；两者均须 --profile <正式profile绝对路径>
// --settings <Host原生settings.yaml绝对路径> --output <不存在的独立输出目录>。
// settings仅在内存读取供Connect复用；禁止打印/复制凭据或整个配置。
// 本地verify为受控fixture，验证Owner选择及原Run推进，不代表业务测试通过。
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join, isAbsolute } from 'node:path'
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../../../../packages/dingtalk-dsh-assistant/task-owner-controller.js'

const {values}=parseArgs({options:{profile:{type:'string'},settings:{type:'string'},output:{type:'string'},check:{type:'boolean'},run:{type:'boolean'}}})
assert.ok(isAbsolute(values.profile??'')&&isAbsolute(values.output??''));assert.notEqual(values.check===true,values.run===true)
const requireProfile=createRequire(join(values.profile,'package.json')),provider=await import(pathToFileURL(requireProfile.resolve('dsh-codex-connect')))
const {SessionProjectionRegistry}=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))('@deepseek-ai/dsh-session-projection')
assert.ok(isAbsolute(values.settings??''));const settings=requireProfile('yaml').parse(await readFile(values.settings,'utf8'))['llm-openai-codex'];assert.ok(settings)
if(values.check){console.log(JSON.stringify({mode:'check',writes:0,modelDispatch:0,businessTools:0,nativeProviderAvailable:true}));process.exit(0)}
const response=await fetch('http://127.0.0.1:18998/state/agent-config',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200)
const config=await response.json(),selection={provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort};assert.equal(selection.provider,'openai-codex')
const output=resolve(values.output);await mkdir(output,{recursive:false})
const ctx=new Context();new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx)
new SystemPrompt(ctx,{includeRuntimeContext:false,includeHarnessIdentity:false});new LlmRuntime(ctx);new ToolRuntime(ctx)
ctx.provide('shell',{sandboxMode:'workspace-write'});new ApprovalService(ctx,{policy:'ask'})
new PermissionPresetService(ctx,{presets:{'workspace-write':{sandbox:'workspace-write',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}}})
new JsonlSessionPersistence(ctx,{root:join(output,'sessions'),packChunks:false,compression:'none',writeBatchMaxDelayMs:1})
new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
provider.apply(ctx,{...provider.DEFAULT_OPENAI_CODEX_SETTINGS,...settings})
const traces=[];ctx.on('tools/result',(exec,result)=>traces.push({tool:exec.name,result}))
const store=await openExecutionStore({dbPath:join(output,'control.sqlite'),instanceId:'native-owner-revision',initialize:true})
const artifacts=await openExecutionArtifacts({directory:join(output,'artifacts'),initialize:true})
let prefixCalls=0,verifyCalls=0,applications=0,owner,budgetTimer
const object={type:'object'},prefix={id:'prepare',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({requirement})=>requirement,execute:async({input})=>{prefixCalls++;return input}}
const verify={id:'verify',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({previousOutput})=>previousOutput,execute:async()=>{throw Object.assign(Error('No tests were executed: Host selected MissingOldSuite; candidate only contains ApprovalOutboxTest. Business implementation was not tested.'),{code:'HOST_CHECK_DIAGNOSTIC'})}}
const original={id:'isolated-checks',version:'1',nodes:[prefix,verify]},controller=createExecutionController({store,artifacts,workflows:[original]})
const profiles=[{version:'4',checks:[{id:'unit',testDiscovery:'ordinary repository unit tests',expectedClasses:['ApprovalOutboxTest'],requireTestsGreaterThanZero:true,exclude:['*IT','*ITCase','*E2ETest']}]},{version:'5',checks:[{id:'unit',testDiscovery:'ordinary repository unit tests',expectedClasses:['ApprovalOutboxTest'],requireTestsGreaterThanZero:true,exclude:['*IT','*ITCase','*E2ETest'],reportContract:'actual junit XML'}]}].map(p=>({...p,digest:executionDigest(p)}))
let result
try{
 await controller.createTaskPlan({commandId:'plan',taskId:'isolated-task',stages:[{stageId:'engineering',workflowId:original.id,input:{request:'修复审核通知，并以真实单测验证；不得为适应Host过期测试选择器修改业务实现'}}]})
 const plan=await controller.advanceTaskPlan('isolated-task'),runId=plan.stages[0].runId,before=await controller.whenIdle(runId)
 await store.command({id:'register-original',kind:'workflow.register',args:{workflowId:original.id,digest:before.run.workflowDigest,definitionVersion:'1',config:{kind:'fixture',taskId:'isolated-task',runId}}})
 const diagnosis=await artifacts.put({kind:'host-check-selection-diagnostic',taskId:'isolated-task',runId,actualCommand:'mvn -Dtest=MissingOldSuite test',actualExit:1,actualTests:0,candidateTestClasses:['ApprovalOutboxTest'],body:'完整日志证明Host选择了仓库中不存在的旧测试类；没有证据证明候选业务实现失败。不得增加伪测试类或关闭无测试失败。选择Host登记的正常单测发现配置，在同Run保留准备与候选重新验证。',tail:'日志结束：No tests were executed; profile 4 is the currently registered correction.'},{taskId:'isolated-task'})
 const inspectCurrentExecution=async()=>{const state=await controller.state(runId);return{repairable:state.run.status!=='succeeded',mode:'workflow-revision',stageId:'engineering',runId,generation:state.run.generation,evidenceRefs:[diagnosis.ref,...state.nodes.flatMap(n=>n.evidenceRefs??[])],repairBinding:{stageId:'engineering',runId,generation:state.run.generation,runRevision:state.run.revision,requirementRevision:1},workflowRevisionCapabilities:{checkProfiles:[profiles[applications?1:0]],templates:[],instruction:'仅修订verify检查配置，成功prepare及业务实现不改。'}}}
 owner=createTaskOwnerController({ctx,store,artifacts,controller,modelConfig:()=>selection,advanceTask:async()=>{throw Error("UNEXPECTED_STAGE_ADVANCE")},authorizeStages:async()=>false,inspectCurrentExecution,
  repairCurrentStage:async({decision,commandId})=>{
   applications++;assert.equal(decision.workflowRevision?.startNodeId,'verify');assert.equal(decision.workflowRevision.checkProfileDigest,profiles[applications===1?0:1].digest);assert.equal(decision.workflowRevision.nodes,undefined)
   if(applications===1)throw Object.assign(Error('登记配置4的JUnit报告契约在Host预检被拒绝，尚未修改Run或执行检查。当前Host已登记配置5，修正了报告契约；读取完整失败工件后改选配置5，不能重投配置4或改业务测试。'),{code:'UNFAMILIAR_REPORT_CONTRACT_MISMATCH',cause:Error('仅Host检查报告适配错误，原成功prepare保留，无业务编辑发生。')})
   const state=await controller.state(runId),next={id:'isolated-checks-revised',version:'2',ownerContract:{id:'original-verification',version:'1',async validateCompletion(){return true},async validateRevision({next}){assert.deepEqual(next.nodes.map(n=>n.id),['prepare','verify'])}},nodes:[prefix,{...verify,version:'2',execute:async()=>{verifyCalls++;await writeFile(join(output,'local-check-result.json'),JSON.stringify({tests:1,failures:0,selectedClass:'ApprovalOutboxTest'}));return{tests:1,failures:0}}}]}
   controller.registerWorkflow(next);const frozen=defineExecutionWorkflow(next)
   await store.command({id:commandId+':register',kind:'workflow.register',args:{workflowId:next.id,digest:frozen.digest,definitionVersion:'2',config:{kind:'fixture',taskId:'isolated-task',runId,taskRevision:{fromDigest:state.run.workflowDigest,startNodeId:'verify',reason:decision.summary,nodePlan:next.nodes.map(n=>({nodeId:n.id,nodeVersion:n.version,executor:n.executor}))}}}})
   await controller.reviseTaskWorkflow({commandId,taskId:'isolated-task',runId,expectedRevision:state.run.revision,workflowId:next.id,workflowDigest:frozen.digest,startNodeId:'verify',reason:decision.summary,evidenceRefs:decision.evidenceRefs})
   await controller.recover({commandId:commandId+':recover',runId})
  }})
 budgetTimer=setTimeout(()=>{void owner.close()},300000);budgetTimer.unref()
 await owner.ensure({taskId:'isolated-task',criteria:['审核通知实现保持并通过真实单测'],sourceKey:'isolated-source',origin:{}});await owner.observe('isolated-task')
 await owner.drive('isolated-task');const first=await store.query({kind:'task.owner',taskId:'isolated-task'});assert.equal(first.decision.action,'repairCurrentStage');await owner.applyPending()
 const failed=await store.query({kind:'task.owner',taskId:'isolated-task'});assert.equal(failed.status,'pending');assert.equal(applications,1)
 await owner.drive('isolated-task');await owner.applyPending();const after=await controller.whenIdle(runId),last=await store.query({kind:'task.owner',taskId:'isolated-task'})
 assert.equal(applications,2);assert.equal(after.run.status,'succeeded');assert.equal(after.run.generation,before.run.generation);assert.deepEqual(after.nodes[0],before.nodes[0]);assert.equal(prefixCalls,1);assert.equal(verifyCalls,1);assert.equal(first.sessionId,last.sessionId);assert.equal((await store.query({kind:'effect.list',runId})).length,0)
 const native=await ctx.sessionPersistence.inspect(last.sessionId);assert.ok(JSON.stringify(native.events).includes('UNFAMILIAR_REPORT_CONTRACT_MISMATCH'))
 result={passed:true,selection,taskId:'isolated-task',runId,sameOwnerSession:true,applications,prefixCalls,verifyCalls,externalEffects:0,decisions:[first.decision,last.decision],boundary:'真实云模型原生Owner选择和错误反馈；独立本地Host检查fixture及原生workflow修订，不证明真实业务单测或五任务验收。'}
}catch(error){result={passed:false,selection,error:{code:error.code,message:error.message,stack:error.stack},applications,prefixCalls,verifyCalls};process.exitCode=1}
finally{clearTimeout(budgetTimer);const savedOwner=await store.query({kind:'task.owner',taskId:'isolated-task'});if(savedOwner?.sessionId){const native=await ctx.sessionPersistence.inspect(savedOwner.sessionId);result.nativeEnds=native.events.filter(e=>e.type==='turn/end').map(e=>({seq:e.seq,reason:e.data.reason}));}await writeFile(join(output,'summary.json'),JSON.stringify(result,null,2));await writeFile(join(output,'tool-traces.json'),JSON.stringify(traces,null,2));await owner?.close();await controller.close();await store.close();await ctx.fiber.dispose()}
console.log(JSON.stringify(result))
