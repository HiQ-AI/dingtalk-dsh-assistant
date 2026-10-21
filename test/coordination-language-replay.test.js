import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compareProposal, replayLanguage } from '../scripts/coordination-language-replay.mjs'

test('language replay without an explicit adapter never claims model calls or passes', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/coordination-language-cases.json',import.meta.url),'utf8'))
  const report = await replayLanguage(fixtures)
  assert.ok(fixtures.cases.length >= 15)
  assert.equal(report.actualModelCalls,0)
  assert.ok(report.results.every(r => ['not_executed','implementation_gap'].includes(r.status)))
  assert.equal(report.implementationGaps,fixtures.cases.filter(c=>c.implementationGap).length)
})

test('replay grades semantics and schema, hides answers, and separates scripted evidence', async () => {
  let calls = 0
  const report = await replayLanguage({context:{groupId:'isolated'},cases:[
    {id:'correct',message:'先澄清',expect:[{path:'kind',equals:'clarify'}]},
    {id:'wrong',message:'应拒绝',expect:[{path:'kind',equals:'reject'}]},
    {id:'malformed',message:'格式',expect:[]}],adapter:{evidenceKind:'scripted',identity:'unit-script',plan(input){
      assert.deepEqual(Object.keys(input).sort(),['context','message'])
      assert.equal(input.context.groupId,'isolated')
      return ++calls === 3 ? {kind:'unknown'} : {kind:'clarify',question:'目标是谁？'}
    }}})
  assert.equal(report.passed,1); assert.equal(report.failed,2); assert.equal(report.actualModelCalls,0)
  assert.equal(report.adapterInvocations,3)
  assert.deepEqual(compareProposal({members:[{taskId:'A'}]},[{path:'members.0.taskId',equals:'B'}]).map(f=>f.path),['members.0.taskId'])
})

test('real-model adapter invocations do not manufacture provider call accounting', async () => {
  const report=await replayLanguage({context:{},cases:[{id:'case',message:'澄清',expect:[]}],
    adapter:{identity:'isolated-test-contract',evidenceKind:'actual-model',plan:async()=>({kind:'clarify',question:'哪一个？'})}})
  assert.equal(report.actualModelCalls,null)
  assert.equal(report.adapterInvocations,1)
})

test('unsupported conditional action stays an implementation gap rather than a successful clarification', async () => {
  const report=await replayLanguage({context:{},cases:[{id:'conditional',message:'查完没完成就继续',implementationGap:'missing conditional contract',expect:[]}],
    adapter:{identity:'scripted',evidenceKind:'scripted',plan:()=>assert.fail('unsupported contract must not be scored as passed')}})
  assert.equal(report.passed,0);assert.equal(report.implementationGaps,1);assert.equal(report.adapterInvocations,0)
})
