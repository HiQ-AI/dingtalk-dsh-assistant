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

test('old profile inherits reasoning; explicit and model default are distinct', () => {
  const execution = { provider: 'executor', model: 'sol', reasoningEffort: 'low' }
  assert.deepEqual(taskModelSelection(execution, {}), { ...execution, provider: 'openai-codex', model: 'gpt-6-astra' })
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
  assert.equal((await read()).taskSessionModel.reasoningMode,'inherit')
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
