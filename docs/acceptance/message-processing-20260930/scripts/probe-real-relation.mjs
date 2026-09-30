// 仅读取真实R快照并调用无工具模型；不连接派发、外发和写库入口。
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join,resolve} from 'node:path'
import {writeFile,readFile} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'

import {messageSchemas,validateContextRequests,validateExecutionMaterialRefs} from '../../../../packages/dingtalk-dsh-assistant/message-context.js'
const [profile,dbPath,outputPath,maxTokensArg,timeoutArg,sequenceArg,settingsPath,isolatedContextWindowArg,stage='R',adapterPath]=process.argv.slice(2)
if(!profile||!dbPath||!outputPath||!sequenceArg||!settingsPath)throw new Error('需要profile/只读源库/输出文件/输出token/超时/来源序号/正式settings路径')
const require=createRequire(join(resolve(profile),'package.json')),imported=name=>import(pathToFileURL(require.resolve(name)).href)
// 仅本进程把提供方依赖重定向至正式构建候选；候选仍复用正式实例的其余依赖。
const adapterUrl=adapterPath?pathToFileURL(resolve(adapterPath)).href:null
const hooks=adapterUrl?registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='@deepseek-ai/dsh-llm-pi-ai')return {url:adapterUrl,shortCircuit:true}
 if(context.parentURL===adapterUrl&&!specifier.startsWith('.')&&!specifier.startsWith('node:')&&!specifier.startsWith('file:'))return nextResolve(specifier,{...context,parentURL:pathToFileURL(join(resolve(profile),'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href})
 return nextResolve(specifier,context)
}}):null
const {prepareMessageRequest}=await import(pathToFileURL(join(resolve(profile),'node_modules/@zzusp/dingtalk-dsh-assistant/message-model.js')).href)
const db=new DatabaseSync(dbPath,{readOnly:true})
let input,node,run
try{
 const origin=JSON.parse(db.prepare('SELECT body FROM message_runs WHERE rowid=?').get(Number(sequenceArg)).body)
 run=JSON.parse(db.prepare('SELECT r.body FROM message_runs r JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=r.source_version WHERE r.source_key=?').get(origin.sourceKey).body)
 node=JSON.parse(db.prepare("SELECT body FROM message_items WHERE run_id=? AND kind='node' AND json_extract(body,'$.nodeId')=? ORDER BY rowid DESC LIMIT 1").get(run.runId,stage).body)
 const {inputBytes,inputHash,inputReadyAt,...raw}=node.input;input=raw
}finally{db.close()}
const prepared=prepareMessageRequest(stage,input)
const {Context}=await imported('@deepseek-ai/cordis'),{LlmRuntime}=await imported('@deepseek-ai/dsh-llm'),provider=await imported('dsh-codex-connect')
const config=await fetch('http://127.0.0.1:18998/state/agent-config').then(r=>r.json())
if(config.provider!=='openai-codex')throw new Error('提供方不匹配')
const runtimeSettings=require('yaml').parse(await readFile(settingsPath,'utf8'))['llm-openai-codex']??{}
const effectiveSettings={...provider.DEFAULT_OPENAI_CODEX_SETTINGS,...runtimeSettings,...(isolatedContextWindowArg?{contextWindowOverrides:{...runtimeSettings.contextWindowOverrides,[config.model]:Number(isolatedContextWindowArg)}}:{})}
const ctx=new Context();new LlmRuntime(ctx);provider.apply(ctx,effectiveSettings)
const catalog=(await ctx.llm.listModels(config.provider)).find(model=>model.id===config.model)
console.log(JSON.stringify({sameInputHash:prepared.inputHash===node.input.inputHash,inputBytes:prepared.inputBytes,catalog,settingsKeys:Object.keys(runtimeSettings),contextWindowOverrides:runtimeSettings.contextWindowOverrides??null,isolatedContextWindowOverride:isolatedContextWindowArg?Number(isolatedContextWindowArg):null}))
let text='',usage,finish,error,validated=false,output
const start=Date.now(),maxTokens=Number(maxTokensArg),timeoutMs=Number(timeoutArg)
try{
 for await(const chunk of ctx.llm.stream({provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,maxTokens,system:prepared.system,messages:prepared.messages,tools:[],signal:AbortSignal.timeout(timeoutMs)})){
  if(chunk.type==='text-delta')text+=chunk.text
  if(chunk.type==='usage')usage=chunk.usage
  if(chunk.type==='finish')finish=chunk.reason
 }
 if(finish?.kind==='stop'){output=messageSchemas[stage].parse(JSON.parse(text));validateContextRequests(stage,output,input);validateExecutionMaterialRefs(stage,output,input);validated=true}
}catch(e){error={name:e.name,code:e.code??null,message:e.message}}
finally{
 await ctx.fiber.dispose();hooks?.deregister()
 let structuredValid=false,structuredError
 try{const candidate=messageSchemas[stage].parse(JSON.parse(text));validateContextRequests(stage,candidate,input);validateExecutionMaterialRefs(stage,candidate,input);structuredValid=true}catch(e){structuredError=e.message}
 const result={at:new Date().toISOString(),sourceDatabaseReadOnly:true,stage,adapterPath:adapterPath??null,tools:[],externalEffects:0,runId:run.runId,sourceVersion:run.sourceVersion,nodeRunId:node.id,provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,catalog,settingsKeys:Object.keys(runtimeSettings),contextWindowOverrides:runtimeSettings.contextWindowOverrides??null,isolatedContextWindowOverride:isolatedContextWindowArg?Number(isolatedContextWindowArg):null,inputBytes:prepared.inputBytes,inputHash:prepared.inputHash,persistedInputHash:node.input.inputHash,sameInputHash:prepared.inputHash===node.input.inputHash,maxTokens,timeoutMs,elapsedMs:Date.now()-start,outputBytes:Buffer.byteLength(text),wouldExceedProductionByteCap:Buffer.byteLength(text)>maxTokens*4,finish,usage,error,validated,structuredValid,structuredError,output,text}
 await writeFile(outputPath,JSON.stringify(result,null,2))
 console.log(JSON.stringify({...result,text:undefined,output:undefined}))
}
