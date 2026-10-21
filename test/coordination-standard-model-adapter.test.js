import test from 'node:test'
import assert from 'node:assert/strict'
import { createStandardModelReplayAdapter } from '../scripts/coordination-standard-model-adapter.mjs'

test('standard replay adapter is inert until explicitly called and passes only synthetic context without tools', async () => {
  let resolved=0,streams=0
  const adapter=createStandardModelReplayAdapter({provider:'selected-provider',model:'selected-model',maxInvocations:1,llm:{
    async resolveCallConfig(config){resolved++;assert.deepEqual(config,{provider:'selected-provider',model:'selected-model'});return config},
    async *stream(request){streams++;assert.deepEqual(request.tools,[]);assert.match(request.messages[0].content[0].text,/synthetic/)
      yield {type:'text-delta',text:JSON.stringify({kind:'clarify',question:'哪一个？'})}
      yield {type:'usage',usage:{inputTokens:10,outputTokens:5}}
      yield {type:'finish',reason:{kind:'stop'}}
    }}})
  assert.equal(resolved,0);assert.equal(streams,0)
  assert.equal((await adapter.plan({message:'synthetic original',context:{groupId:'isolated'}})).kind,'clarify')
  await assert.rejects(adapter.plan({}),/BUDGET_EXHAUSTED/)
  assert.equal(streams,1)
  assert.equal(adapter.accounting().providerNetworkCalls,null)
  assert.deepEqual(adapter.accounting().records[0].usage,{inputTokens:10,outputTokens:5})
  assert.equal(adapter.accounting().records[0].rawText,JSON.stringify({kind:'clarify',question:'哪一个？'}))
  assert.equal(adapter.accounting().records[0].input.message,'synthetic original')
  assert.ok(adapter.accounting().records[0].elapsedMs>=0)
})

test('unavailable route is a plan attempt but never manufactures a model stream or zero cost',async()=>{
  const adapter=createStandardModelReplayAdapter({provider:'selected',model:'selected',llm:{async resolveCallConfig(){throw new Error('route unavailable')},async *stream(){assert.fail('route must resolve first')}}})
  await assert.rejects(adapter.plan({message:'synthetic',context:{}}),/route unavailable/)
  const account=adapter.accounting()
  assert.equal(account.planAttempts,1);assert.equal(account.standardStreamInvocations,0)
  assert.equal(account.records[0].streamStarted,false);assert.equal(account.records[0].cost,null)
})

test('standard replay adapter refuses tools and incomplete finish without a retry or execution', async () => {
  for(const chunks of [[{type:'tool-call-delta'}],[{type:'finish',reason:{kind:'error',failure:{code:'UNKNOWN',message:'selected route account unavailable'}}}]]){
    let streams=0
    const adapter=createStandardModelReplayAdapter({provider:'test',model:'test',llm:{async resolveCallConfig(c){return c},async *stream(){streams++;yield*chunks}}})
    await assert.rejects(adapter.plan({message:'synthetic',context:{}}),/TOOL_FORBIDDEN|INCOMPLETE/)
    assert.equal(streams,1);assert.equal(adapter.accounting().records[0].completed,false)
    if(chunks[0].type==='finish')assert.deepEqual(adapter.accounting().records[0].failure,chunks[0].reason.failure)
  }
})
