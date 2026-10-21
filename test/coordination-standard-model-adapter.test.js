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
})

test('standard replay adapter refuses tools and incomplete finish without a retry or execution', async () => {
  for(const chunks of [[{type:'tool-call-delta'}],[{type:'finish',reason:{kind:'error'}}]]){
    let streams=0
    const adapter=createStandardModelReplayAdapter({provider:'test',model:'test',llm:{async resolveCallConfig(c){return c},async *stream(){streams++;yield*chunks}}})
    await assert.rejects(adapter.plan({message:'synthetic',context:{}}),/TOOL_FORBIDDEN|INCOMPLETE/)
    assert.equal(streams,1);assert.equal(adapter.accounting().records[0].completed,false)
  }
})
