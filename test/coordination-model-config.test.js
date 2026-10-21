import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import { coordinationModelSelection } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

function memoryFacility() {
  const rows=new Map(),table=name=>({get:key=>rows.get(`${name}:${key}`),entries:()=>[...rows].filter(([k])=>k.startsWith(name+':')).map(([k,v])=>[k.slice(name.length+1),v])[Symbol.iterator](),
    put:async(k,v)=>rows.set(`${name}:${k}`,v),delete:async k=>rows.delete(`${name}:${k}`),update:async(k,f)=>{const v=f(rows.get(`${name}:${k}`));rows.set(`${name}:${k}`,v);return v}})
  return {rows,facility:{open:async()=>({table,close:async()=>{}})}}
}
test('coordination selection defaults independently to astra/low and disabled selection never enables itself',()=>{
  const executor={provider:'executor',model:'sol',reasoningEffort:'high'}
  assert.equal(coordinationModelSelection({},executor),null)
  assert.deepEqual(coordinationModelSelection({enabled:true},executor),{provider:'openai-codex',model:'gpt-6-astra',reasoningEffort:'low'})
  assert.equal(coordinationModelSelection({enabled:true,reasoningMode:'inherit'},executor).reasoningEffort,'high')
  assert.equal(coordinationModelSelection({enabled:true,reasoningMode:'model-default'},executor).reasoningEffort,undefined)
})

test('HTTP coordination config preflights, persists and reopens while Owner/executor and enabled remain unchanged',async t=>{
  const root=await mkdtemp(join(tmpdir(),'coord-model-settings-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const {rows,facility}=memoryFacility(), store=await openResidentStore(facility)
  const executor={provider:'exec',model:'sol',reasoningEffort:'high'};let writes=0
  const ctx={agentDefaultModel:{currentSelection:()=>({...executor}),saveSelection:async()=>{writes++}},llm:{
    listProviders:()=>[{id:'openai-codex',name:'Codex'}],listModels:async()=>[{id:'gpt-6-astra',name:'Astra'},{id:'coord-next',name:'Next'}],
    resolveModelInfo:async(provider,model)=>{if(provider!=='openai-codex'||!['gpt-6-astra','coord-next'].includes(model))throw Error('MODEL_NOT_FOUND');return {reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}},
    async resolveCallConfig(value){const info=await this.resolveModelInfo(value.provider,value.model);if(value.reasoningEffort&&!info.reasoning.efforts.some(e=>e.id===value.reasoningEffort))throw Error('UNSUPPORTED_REASONING_EFFORT');return value},
  }}
  let runtime=await openTaskResidentRuntime(ctx,store,root,{coordinationModel:{enabled:false}})
  const server=createServer((req,res)=>handleRequest(req,res,runtime).catch(e=>{res.writeHead(400);res.end(JSON.stringify({error:e.message}))}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close()})
  const base=`http://127.0.0.1:${server.address().port}`, read=async()=>(await fetch(base+'/state/agent-config')).json()
  const save=body=>fetch(base+'/config/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const initial=await read(), desired={provider:'openai-codex',model:'coord-next',reasoningMode:'explicit',reasoningEffort:'high'}
  assert.deepEqual(initial.coordinationModel,{provider:'openai-codex',model:'gpt-6-astra',reasoningMode:'explicit',reasoningEffort:'low'})
  assert.equal((await save({coordinationModel:desired})).status,200)
  assert.deepEqual((await read()).coordinationModel,desired)
  assert.deepEqual(residentDomainSpec.tables.scheduler.valueSchema.parse(rows.get('scheduler:runtime')).coordinationModel,desired)
  assert.deepEqual((await read()).taskSessionModel,initial.taskSessionModel);assert.equal(writes,0)
  assert.equal(rows.get('scheduler:runtime').coordination,undefined)
  assert.equal(coordinationModelSelection({enabled:false,...desired}),null)
  for(const value of [{...desired,reasoningEffort:'ultra'},{...desired,model:'missing'},{...desired,provider:2}])assert.equal((await save({coordinationModel:value})).status,400)
  assert.deepEqual((await read()).coordinationModel,desired)
  await runtime.close();runtime=await openTaskResidentRuntime(ctx,await openResidentStore(facility),root,{coordinationModel:{model:'stale-profile'}})
  assert.deepEqual((await read()).coordinationModel,desired)
  assert.deepEqual(executor,{provider:'exec',model:'sol',reasoningEffort:'high'})
})

test('combined save validates coordinator before either write and readbacks independent-store failures without compensation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'coord-model-save-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const {facility}=memoryFacility(),store=await openResidentStore(facility)
  let current={provider:'exec',model:'sol',reasoningEffort:'low'},nativeWrites=0,pluginWrites=0,failure=''
  const originalSave=store.setAgentSettings
  store.setAgentSettings=async patch=>{pluginWrites++;if(failure==='before')throw Error('DISK_FULL');await originalSave(patch);if(failure==='after')throw Error('ACK_LOST')}
  const ctx={agentDefaultModel:{currentSelection:()=>({...current}),saveSelection:async value=>{nativeWrites++;current={...value}}},llm:{resolveCallConfig:async value=>{
    if(value.model==='missing'||value.reasoningEffort==='ultra')throw Error('UNSUPPORTED_MODEL_OR_DEPTH');return value}}}
  const runtime=await openTaskResidentRuntime(ctx,store,root);t.after(()=>runtime.close())
  const coordinator={provider:'openai-codex',model:'coord-next',reasoningMode:'explicit',reasoningEffort:'high'}
  const desired={model:'sol-next',reasoningEffort:'high',coordinationModel:coordinator}
  await assert.rejects(runtime.updateAgentConfig({...desired,coordinationModel:{...coordinator,reasoningEffort:'ultra'}}))
  assert.equal(nativeWrites,0);assert.equal(pluginWrites,0)
  failure='before'
  await assert.rejects(runtime.updateAgentConfig(desired),e=>e.message==='AGENT_CONFIG_SAVE_FAILED'&&e.readback.model==='sol-next'&&e.readback.coordinationModel.model==='gpt-6-astra')
  assert.equal(nativeWrites,1);assert.equal(pluginWrites,1)
  failure='after'
  await assert.rejects(runtime.updateAgentConfig(desired),e=>e.message==='AGENT_CONFIG_SAVE_FAILED'&&e.readback.coordinationModel.model==='coord-next')
  assert.equal(nativeWrites,2);assert.equal(pluginWrites,2)
})
