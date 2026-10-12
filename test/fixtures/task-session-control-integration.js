import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm,realpath} from 'node:fs/promises'
import {resolve,join,sep} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {openExecutionStore} from '../../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts} from '../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {taskDirectories} from '../../packages/dingtalk-dsh-assistant/session-workspaces.js'
import {createExecutionController} from '../../packages/dingtalk-dsh-assistant/execution-controller.js'
const exec=promisify(execFile),object={type:'object'}
export async function openTaskSessionControlFixture(t,{execute,expected='actual requested artifact',controllerFactory=createExecutionController,workflowFactory,validateOutput,ownerContract}={}){
 const temporary=resolve('docs/tmp/task-session-control');await mkdir(temporary,{recursive:true});const approved=await realpath(resolve('docs/tmp'));assert.ok((await realpath(temporary)).startsWith(approved+sep),'fixture temporary root must stay in repository docs/tmp')
 const directory=await mkdtemp(join(temporary,'task-session-control-')),dbPath=join(directory,'control.sqlite'),instanceId='task-session-control'
 const candidatePath=join(directory,'actual-result.txt'),script=join(directory,'verify.cjs'),tracePath=join(directory,'calls.jsonl')
 await writeFile(script,"const fs=require('node:fs'),[file,expected]=process.argv.slice(2);let actual='';try{actual=fs.readFileSync(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e};console.log(JSON.stringify({actual,expected}));if(actual!==expected)process.exit(7)")
 const trace=async phase=>appendFile(tracePath,JSON.stringify({phase})+'\n')
 const verify=async()=>{try{const result=await exec(process.execPath,[script,candidatePath,expected],{windowsHide:true});return {actual:JSON.parse(result.stdout).actual,exitCode:0}}catch(error){error.actualExitCode=error.code;error.code='LOCAL_CHECK_FAILED';throw error}}
 const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true,taskWorkspaceRoot:join(directory,'task-files'),getTaskDirectories:async taskId=>taskDirectories(join(directory,'task-files'),taskId)})
 let store,controller;const context={directory,candidatePath,script,expected,trace,verify,artifacts}
 Object.defineProperties(context,{store:{get:()=>store},controller:{get:()=>controller}})
 const defaultWorkflow={id:'task-session-control-fixture',version:'1',...(ownerContract?{ownerContract}:{}),nodes:[
  {id:'prepare',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({requirement})=>requirement,execute:async({input})=>{await trace('prepare');return input}},
  {id:'verify',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,validateOutput:validateOutput??(()=>verify()),mapInput:({previousOutput})=>previousOutput,execute:async args=>{await trace('verify');return execute?execute({...args,fixture:context}):verify()}},
  {id:'deliver',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:object,outputSchema:object,mapInput:({previousOutput})=>previousOutput,execute:async({input})=>{const actual=await verify();await trace('deliver');await appendFile(join(directory,'delivery.log'),actual.actual+'\n');return {result:actual.actual,source:input}}},
 ]}
 const workflows=workflowFactory?workflowFactory(context):[defaultWorkflow],workflow=workflows[0]
 const open=async initialize=>{store=await openExecutionStore({dbPath,instanceId,...(initialize?{initialize:true}:{})});controller=controllerFactory({store,artifacts,workflows,changeQuietMs:0,maxChangeDelayMs:0})};await open(true)
 t.after(async()=>{await controller?.close();await store?.close();const actual=await realpath(directory),root=await realpath(temporary);assert.ok(actual.startsWith(root+sep)&&actual.split(sep).at(-1).startsWith('task-session-control-'));await rm(actual,{recursive:true,force:true})})
 let runId
 return {...context,workflow,workflows,dbPath,instanceId,taskId:'task-session-control',
  get store(){return store},get controller(){return controller},get runId(){return runId},
  async start({stages,input={request:expected}}={}){const taskId='task-session-control';await controller.createTaskPlan({commandId:'plan',taskId,stages:stages??[{stageId:'produce',workflowId:workflow.id,input}]});const started=await controller.advanceTaskPlan(taskId);runId=started.stages[0].runId;return controller.whenIdle(runId)},
  async reopen(){await controller.close();await store.close();await open(false)},
  async calls(){try{return (await readFile(tracePath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch(error){if(error.code==='ENOENT')return [];throw error}},
  async equivalentOutput(){await exec(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],process.argv[2])",candidatePath,expected],{windowsHide:true});const actual=await verify();return {tool:'independent-file-tool',location:candidatePath,value:actual.actual}},
 }
}
