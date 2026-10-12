import test from 'node:test'
import assert from 'node:assert/strict'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { inspectLocalAcceptanceCorrection } from '../packages/dingtalk-dsh-assistant/execution-input-lineage.js'
// Synthetic archived planner input: no runtime database or task artifacts are read.
const taskId='task-synthetic-sg20',requirementRef=`tasks/${taskId}/requirement.json`
const data={request:'merge candidate records',criteria:[{id:'merge',description:'preserve records'}],scenarios:[{id:'merge-records',description:'exercise merge'}],uatEnvironment:'uat3'}
const input={nodeId:'plan-local-acceptance',requirementRef,workflowDigest:'historical-workflow',data}
const defined={localContext:structuredClone(data)}
const run={taskId,runId:'synthetic-run',requirementRef,workflowDigest:'current-workflow'}
const node={inputRef:`tasks/${run.taskId}/sha256-${executionDigest(input)}.json`,inputDigest:executionDigest(input)}
const check=(changes={})=>inspectLocalAcceptanceCorrection({run,node,input,expectedData:defined.localContext,...changes})
test('synthetic SG20 planner business input survives historical workflow revision without rewriting artifact',()=>{
 const result=check();assert.equal(result.trusted,true);assert.deepEqual(result.warnings,['historical-workflow-metadata']);assert.equal(node.inputDigest,executionDigest(input))
})
test('foreign task and different required business inputs still reject correction',()=>{
 assert.equal(check({run:{...run,taskId:'foreign'}}).trusted,false)
 assert.equal(check({run:{...run,requirementRef:'tasks/foreign/requirement.json'}}).trusted,false)
 for(const key of ['request','criteria','scenarios','uatEnvironment']) assert.equal(check({expectedData:{...defined.localContext,[key]:null}}).trusted,false)
})
test('tampered input digest and missing executable scenario still reject',()=>{
 assert.equal(check({node:{...node,inputDigest:'0'.repeat(64)}}).trusted,false)
 const empty={...input,data:{...input.data,scenarios:[]}}
 assert.equal(check({input:empty,node:{...node,inputDigest:executionDigest(empty)},expectedData:empty.data}).trusted,false)
})
test('preparation input differs from planner input and is validated by its actual plan dependency',()=>{
 const plan={cases:[{scenarioId:'merge-records',expected:'records preserved'}]}
 const prepare={requirementRef,data:{plan}}
 assert.notDeepEqual(prepare.data,input.data);assert.deepEqual(prepare.data.plan,plan);assert.equal(prepare.requirementRef,run.requirementRef)
})
