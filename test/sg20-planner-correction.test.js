import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { inspectLocalAcceptanceCorrection } from '../packages/dingtalk-dsh-assistant/execution-input-lineage.js'
const root='D:/baibu-agent/tasks/task-83c651ebdbdb77584a06d1fcb6b9e255/work/artifacts/'
const input=JSON.parse(readFileSync(root+'sha256-f259c945d86933c23656dfdc5e2033213cd4558e01ffe0c0f4d3025cfa238ab2.json','utf8'))
const defined=JSON.parse(readFileSync(root+'sha256-a8284bbcf501aa1e1c7906cd4d9a7cb09798484ebc085ba6a705ef660440c4de.json','utf8'))
const run={taskId:'task-83c651ebdbdb77584a06d1fcb6b9e255',runId:'run-01a4fc72219b513a3f78e7cdb5be55699e448d6b63b97d3a65f8fcf60dc4d03f',requirementRef:input.requirementRef,workflowDigest:'231eb18aaa5dd39aee567151ec4b02baa3f8b9e0b4b7b29527bf3606046d489d'}
const node={inputRef:`tasks/${run.taskId}/sha256-${executionDigest(input)}.json`,inputDigest:executionDigest(input)}
const check=(changes={})=>inspectLocalAcceptanceCorrection({run,node,input,expectedData:defined.localContext,...changes})
test('real SG20 planner business input survives historical workflow revision without rewriting artifact',()=>{
 const result=check();assert.equal(result.trusted,true);assert.deepEqual(result.warnings,['historical-workflow-metadata']);assert.equal(node.inputDigest,'f259c945d86933c23656dfdc5e2033213cd4558e01ffe0c0f4d3025cfa238ab2')
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
 const prepare=JSON.parse(readFileSync(root+'sha256-30dddd5205bdd7135c096a249fa9f8eeaad0a64c9ef906717f225b73e8ade1f9.json','utf8'))
 const plan=JSON.parse(readFileSync(root+'sha256-6b20d0ea9be4a5fee9878ca07056218d7724bdb563a254e62ae94e8bb043cbf2.json','utf8'))
 assert.notDeepEqual(prepare.data,input.data);assert.deepEqual(prepare.data.plan,plan);assert.equal(prepare.requirementRef,run.requirementRef)
})
