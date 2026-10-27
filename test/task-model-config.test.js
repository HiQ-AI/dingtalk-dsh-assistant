import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskModelConfig, taskModelSelection } from '../packages/dingtalk-dsh-assistant/task-model-config.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openResidentStore, residentDomainSpec } from '../packages/dingtalk-dsh-assistant/store.js'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'

test('unset task depth defaults low; explicit inheritance and model default remain distinct', () => {
  const execution = { provider: 'executor', model: 'sol', reasoningEffort: 'low' }
  assert.deepEqual(taskModelSelection({...execution,reasoningEffort:'high'}, {}), { ...execution, provider: 'openai-codex', model: 'gpt-6-astra' })
  assert.equal(taskModelSelection(execution, { reasoningEffort: 'high' }).reasoningEffort, 'high')
  for (const reasoningEffort of [null, '']) assert.equal(taskModelSelection(execution, { reasoningEffort }).reasoningEffort, undefined)
  assert.equal(taskModelSelection(execution, { reasoningMode: 'inherit' }).reasoningEffort, 'low')
  assert.equal(taskModelSelection(execution, { reasoningMode: 'model-default' }).reasoningEffort, undefined)
  for (const config of [{ reasoningEffort: 2 }, { reasoningMode: 'unknown' }, { reasoningMode: 'explicit' }, null]) assert.throws(() => taskModelConfig(config))
  assert.equal(execution.model, 'sol'); assert.equal(execution.reasoningEffort, 'low')
})

function memoryFacility() {
  const seed = new Map()
  const table = name => ({
    get: key => seed.get(`${name}:${key}`),
    entries: () => [...seed].filter(([key]) => key.startsWith(`${name}:`)).map(([key,value]) => [key.slice(name.length+1),value])[Symbol.iterator](),
    put: async (key,value) => seed.set(`${name}:${key}`,value), delete: async key => seed.delete(`${name}:${key}`),
    update: async (key, transform) => { const id = `${name}:${key}`; const next = transform(seed.get(id)); seed.set(id,next); return next },
  })
  return { seed, facility: { async open() { return { table, close: async () => {} } } } }
}

test('HTTP task settings validate, persist, refresh and reopen without touching native default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-model-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { seed, facility } = memoryFacility()
  const execution = { provider: 'executor', model: 'sol', reasoningEffort: 'low' }
  let defaultWrites = 0
  const llm = {
    listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
    listModels: async () => [{ id: 'gpt-6-astra', name: 'Astra' }],
    resolveModelInfo: async (provider, model) => { if (provider !== 'openai-codex' || model !== 'gpt-6-astra') throw Error('MODEL_NOT_FOUND'); return { reasoning: { efforts: [{ id:'low', name:'Low' },{ id:'high',name:'High' }] } } },
    async resolveCallConfig(config) { const info = await this.resolveModelInfo(config.provider, config.model); if (config.reasoningEffort && !info.reasoning.efforts.some(x => x.id === config.reasoningEffort)) throw Error('UNSUPPORTED_REASONING_EFFORT'); return config },
  }
  const ctx = { llm, agentDefaultModel: { currentSelection: () => ({ ...execution }), saveSelection: async () => { defaultWrites++ } } }
  let runtime = await openTaskResidentRuntime(ctx, await openResidentStore(facility), root)
  const server = createServer((req,res) => handleRequest(req,res,runtime).catch(error => { res.writeHead(400); res.end(JSON.stringify({ error:error.message })) }))
  await new Promise(done => server.listen(0,'127.0.0.1',done))
  t.after(async () => { await new Promise(done => server.close(done)); await runtime.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const read = async () => (await fetch(base+'/state/agent-config')).json()
  const save = value => fetch(base+'/config/agent',{ method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({ taskSessionModel:value }) })
  assert.equal((await read()).taskSessionModel.reasoningMode,'explicit')
  const value = { provider:'openai-codex',model:'gpt-6-astra',reasoningMode:'explicit',reasoningEffort:'high' }
  assert.equal((await save(value)).status,200)
  assert.deepEqual((await read()).taskSessionModel,value)
  assert.deepEqual(residentDomainSpec.tables.scheduler.valueSchema.parse(seed.get('scheduler:runtime')).taskSessionModel,value)
  assert.equal((await save({ ...value,reasoningEffort:'ultra' })).status,400)
  assert.equal((await save({ ...value,model:'missing' })).status,400)
  assert.deepEqual((await read()).taskSessionModel,value)
  const options = await (await fetch(base+'/state/task-model-options?provider=openai-codex&model=gpt-6-astra')).json()
  assert.equal(options.available,true); assert.deepEqual(options.reasoning.efforts.map(x=>x.id),['low','high'])
  const unavailable = await (await fetch(base+'/state/task-model-options?provider=openai-codex&model=missing')).json()
  assert.equal(unavailable.available,false); assert.ok(unavailable.providers.length)
  await runtime.close()
  runtime = await openTaskResidentRuntime(ctx,await openResidentStore(facility),root,{taskSessionModel:{model:'profile-must-not-override-saved'}})
  assert.deepEqual((await read()).taskSessionModel,value)
  assert.equal((await save({ ...value,reasoningMode:'model-default',reasoningEffort:null })).status,200)
  assert.equal(taskModelSelection(execution,(await read()).taskSessionModel).reasoningEffort,undefined)
  assert.equal((await save({ ...value,reasoningMode:'inherit',reasoningEffort:null })).status,200)
  assert.equal(taskModelSelection(execution,(await read()).taskSessionModel).reasoningEffort,'low')
  const combined = await fetch(base+'/config/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({reasoningEffort:'ultra',taskSessionModel:{...value,reasoningMode:'inherit',reasoningEffort:null}})})
  assert.equal(combined.status,400)
  const inherited = await fetch(base+'/config/agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({reasoningEffort:'ultra'})})
  assert.equal(inherited.status,400)
  assert.equal(defaultWrites,0); assert.deepEqual(execution,{provider:'executor',model:'sol',reasoningEffort:'low'})
})


test('unified save preflights both models and reports readback on independent-store failures without compensation', async t => {
  const root=await mkdtemp(join(tmpdir(),'agent-unified-save-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const {facility}=memoryFacility(), store=await openResidentStore(facility)
  let current={provider:'executor',model:'sol',reasoningEffort:'low'},defaultWrites=0,residentWrites=0,defaultFailure='',residentFailure=''
  const llm={async resolveCallConfig(value){
    if(!['executor','gateway-next','openai-codex'].includes(value.provider))throw Error('PROVIDER_NOT_FOUND')
    if(!['sol','sol-next','gpt-6-astra'].includes(value.model))throw Error('MODEL_NOT_FOUND')
    if(value.reasoningEffort&&!['low','high'].includes(value.reasoningEffort))throw Error('UNSUPPORTED_REASONING_EFFORT')
    return value
  }}
  const savePatch=store.setAgentSettings
  store.setAgentSettings=async patch=>{residentWrites++;if(residentFailure==='before')throw Error('DISK_FULL');await savePatch(patch);if(residentFailure==='after')throw Error('ACK_LOST')}
  const ctx={llm,agentDefaultModel:{currentSelection:()=>({...current}),saveSelection:async value=>{
    defaultWrites++;if(defaultFailure==='before')throw Error('PROFILE_WRITE_FAILED');current={...value};if(defaultFailure==='after')throw Error('PROFILE_ACK_LOST')
  }}}
  const runtime=await openTaskResidentRuntime(ctx,store,root);t.after(()=>runtime.close())
  const desired={provider:'gateway-next',model:'sol-next',reasoningEffort:'high',agentNames:['Ada'],proxyUrl:'',replySignature:'',executionBackend:'claude-code',taskSessionModel:{provider:'openai-codex',model:'gpt-6-astra',reasoningMode:'explicit',reasoningEffort:'low'}}
  for(const input of [{...desired,provider:'missing'},{...desired,provider:''},{...desired,provider:2},{...desired,model:'missing'},{...desired,taskSessionModel:{...desired.taskSessionModel,reasoningEffort:'ultra'}},{...desired,proxyUrl:'invalid'},{...desired,executionBackend:'unknown'}])await assert.rejects(runtime.updateAgentConfig(input))
  assert.equal(defaultWrites,0);assert.equal(residentWrites,0)
  const saved=await runtime.updateAgentConfig(desired)
  assert.equal(saved.provider,'gateway-next');assert.equal(current.provider,'gateway-next');assert.equal(saved.model,'sol-next');assert.equal(saved.reasoningEffort,'high');assert.equal(saved.taskSessionModel.reasoningEffort,'low')
  assert.equal(saved.executionBackend,'claude-code')
  const next={...desired,model:'sol',reasoningEffort:'low',agentNames:['Grace'],executionBackend:'dsh',taskSessionModel:{...desired.taskSessionModel,reasoningEffort:'high'}}
  defaultFailure='before'
  await assert.rejects(runtime.updateAgentConfig(next),error=>error.message==='AGENT_CONFIG_SAVE_FAILED'&&error.readback.model==='sol-next'&&error.readback.agentNames[0]==='Ada')
  assert.equal(residentWrites,1)
  defaultFailure='after'
  await assert.rejects(runtime.updateAgentConfig(next),error=>error.readback.model==='sol'&&error.readback.agentNames[0]==='Ada')
  assert.equal(residentWrites,1,'unknown native acknowledgement never blindly repeats or compensates')
  defaultFailure='';residentFailure='before'
  await assert.rejects(runtime.updateAgentConfig(next),error=>error.readback.model==='sol'&&error.readback.taskSessionModel.reasoningEffort==='low'&&error.readback.executionBackend==='claude-code')
  residentFailure='after'
  await assert.rejects(runtime.updateAgentConfig(next),error=>error.readback.agentNames[0]==='Grace'&&error.readback.taskSessionModel.reasoningEffort==='high'&&error.readback.executionBackend==='dsh')
  assert.equal(defaultWrites,5,'one native write per explicit save attempt')
})

test('execution backend defaults to DSH and validates, persists and reopens through the existing Agent HTTP configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-backend-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { seed, facility } = memoryFacility(), store = await openResidentStore(facility)
  let nativeWrites = 0, pluginWrites = 0
  const savePatch = store.setAgentSettings
  store.setAgentSettings = async patch => { pluginWrites++; return savePatch(patch) }
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'executor', model: 'sol' }), saveSelection: async () => { nativeWrites++ } }, llm: { resolveCallConfig: async value => value } }
  let runtime = await openTaskResidentRuntime(ctx, store, root)
  const server = createServer((req, res) => handleRequest(req, res, runtime).catch(error => { res.writeHead(400); res.end(JSON.stringify({ error: error.message })) }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(async () => { await new Promise(done => server.close(done)); await runtime.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const read = async () => (await fetch(base + '/state/agent-config')).json()
  const save = body => fetch(base + '/config/agent', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const initial = await read()
  assert.equal(initial.executionBackend, 'dsh')
  assert.equal(seed.get('scheduler:runtime').executionBackend, undefined, '读取默认值不伪造一次配置保存')
  for (const executionBackend of ['', null, 1, {}, 'claude', 'DSH', 'dsh ']) {
    const response = await save({ executionBackend, model: 'new-model', agentNames: ['不应写入'] })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'agent_execution_backend_invalid')
    assert.deepEqual(await read(), initial)
  }
  assert.equal(nativeWrites, 0); assert.equal(pluginWrites, 0, '非法后端在任何配置写入前拒绝')
  const response = await save({ executionBackend: 'claude-code' })
  assert.equal(response.status, 200); assert.equal((await response.json()).executionBackend, 'claude-code')
  assert.equal((await read()).executionBackend, 'claude-code')
  assert.equal(residentDomainSpec.tables.scheduler.valueSchema.parse(seed.get('scheduler:runtime')).executionBackend, 'claude-code')
  await runtime.close()
  runtime = await openTaskResidentRuntime(ctx, await openResidentStore(facility), root, { executionBackend: 'dsh' })
  assert.equal((await read()).executionBackend, 'claude-code', '持久设置优先于重启时的初值')
  assert.equal((await save({ executionBackend: 'dsh' })).status, 200)
  assert.equal((await read()).executionBackend, 'dsh')
  assert.equal(nativeWrites, 0)
  const fresh = await openResidentStore(memoryFacility().facility)
  const configured = await openTaskResidentRuntime(ctx, fresh, root, { executionBackend: 'claude-code' })
  assert.equal(configured.getAgentConfig().executionBackend, 'claude-code')
  await configured.close()
  await assert.rejects(openTaskResidentRuntime(ctx, fresh, root, { executionBackend: 'invalid' }), /agent_execution_backend_invalid/)
})
