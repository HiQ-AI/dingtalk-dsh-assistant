import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

function memoryFacility() {
  const rows=new Map(),table=name=>({get:key=>rows.get(`${name}:${key}`),entries:()=>[...rows].filter(([k])=>k.startsWith(name+':')).map(([k,v])=>[k.slice(name.length+1),v])[Symbol.iterator](),
    put:async(k,v)=>rows.set(`${name}:${k}`,v),delete:async k=>rows.delete(`${name}:${k}`),update:async(k,f)=>{const v=f(rows.get(`${name}:${k}`));rows.set(`${name}:${k}`,v);return v}})
  return {rows,facility:{open:async()=>({table,close:async()=>{}})}}
}
test('retired coordinator settings stay historical; reads hide them and writes fail before changing Owner or executor', async t=>{
  const root=await mkdtemp(join(tmpdir(),'coord-model-settings-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const {rows,facility}=memoryFacility(), store=await openResidentStore(facility)
  const historical={provider:'old',model:'old-model',reasoningMode:'explicit',reasoningEffort:'low'}
  await store.setAgentSettings({coordinationModel:historical})
  const executor={provider:'exec',model:'sol',reasoningEffort:'high'};let writes=0
  const ctx={agentDefaultModel:{currentSelection:()=>({...executor}),saveSelection:async()=>{writes++}},llm:{resolveCallConfig:async value=>value}}
  const runtime=await openTaskResidentRuntime(ctx,store,root,{coordinationModel:{enabled:true}})
  const server=createServer((req,res)=>handleRequest(req,res,runtime).catch(e=>{res.writeHead(400);res.end(JSON.stringify({error:e.message}))}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close()})
  const base=`http://127.0.0.1:${server.address().port}`
  const initial=await(await fetch(base+'/state/agent-config')).json()
  assert.equal(initial.coordinationModel,undefined)
  const response=await fetch(base+'/config/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({model:'changed',coordinationModel:historical})})
  assert.equal(response.status,400);assert.equal((await response.json()).error,'INDEPENDENT_COORDINATION_RETIRED')
  assert.equal(writes,0)
  assert.deepEqual(residentDomainSpec.tables.scheduler.valueSchema.parse(rows.get('scheduler:runtime')).coordinationModel,historical)
  assert.deepEqual((await(await fetch(base+'/state/agent-config')).json()).taskSessionModel,initial.taskSessionModel)
})

test('combined save validates Task Owner before either write and readbacks independent-store failures without compensation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'coord-model-save-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const {facility}=memoryFacility(),store=await openResidentStore(facility)
  let current={provider:'exec',model:'sol',reasoningEffort:'low'},nativeWrites=0,pluginWrites=0,failure=''
  const originalSave=store.setAgentSettings
  store.setAgentSettings=async patch=>{pluginWrites++;if(failure==='before')throw Error('DISK_FULL');await originalSave(patch);if(failure==='after')throw Error('ACK_LOST')}
  const ctx={agentDefaultModel:{currentSelection:()=>({...current}),saveSelection:async value=>{nativeWrites++;current={...value}}},llm:{resolveCallConfig:async value=>{
    if(value.model==='missing'||value.reasoningEffort==='ultra')throw Error('UNSUPPORTED_MODEL_OR_DEPTH');return value}}}
  const runtime=await openTaskResidentRuntime(ctx,store,root);t.after(()=>runtime.close())
  const owner={provider:'openai-codex',model:'coord-next',reasoningMode:'explicit',reasoningEffort:'high'}
  const desired={model:'sol-next',reasoningEffort:'high',taskSessionModel:owner}
  await assert.rejects(runtime.updateAgentConfig({...desired,taskSessionModel:{...owner,reasoningEffort:'ultra'}}))
  assert.equal(nativeWrites,0);assert.equal(pluginWrites,0)
  failure='before'
  await assert.rejects(runtime.updateAgentConfig(desired),e=>e.message==='AGENT_CONFIG_SAVE_FAILED'&&e.readback.model==='sol-next'&&e.readback.taskSessionModel.model==='gpt-6-astra')
  assert.equal(nativeWrites,1);assert.equal(pluginWrites,1)
  failure='after'
  await assert.rejects(runtime.updateAgentConfig(desired),e=>e.message==='AGENT_CONFIG_SAVE_FAILED'&&e.readback.taskSessionModel.model==='coord-next')
  assert.equal(nativeWrites,2);assert.equal(pluginWrites,2)
})
