import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validateLocalAcceptanceSubmission,validateEngineeringPlanScope} from '../packages/dingtalk-dsh-assistant/engineering-output-contract.js'
import {executionDigest} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/paused-task-contracts.json',import.meta.url),'utf8'))
for(const item of fixture.tasks)test(`${item.sg} frozen paused contract replay`,()=>{
 assert.equal(item.control.state,'paused')
 const context={criteria:item.criteria,scenarios:item.scenarios}
 assert.throws(()=>validateLocalAcceptanceSubmission(item.plan,context),e=>e.code==='LOCAL_ACCEPTANCE_CAPABILITY_MISSING')
 const stage={taskId:item.taskId,stageId:'isolated-coverage-negative',repositoryId:'dataset',objective:'isolated',criteria:item.criteria.map(c=>c.description),editablePaths:[],allowedPrefixes:['src/']}
 const scope={taskId:stage.taskId,stageId:stage.stageId,repositoryId:stage.repositoryId,requestDigest:executionDigest({request:stage.objective,acceptanceCriteria:stage.criteria})}
 const approved={...context,stageContract:stage,acceptanceApplicability:{scope,scenarios:item.scenarios.map(s=>({scenarioId:s.id,criteria:stage.criteria}))}}
 assert.throws(()=>validateLocalAcceptanceSubmission({cases:[]},approved),e=>e.code==='LOCAL_ACCEPTANCE_PLAN_INVALID')
 assert.throws(()=>validateLocalAcceptanceSubmission(item.plan,{...approved,acceptanceApplicability:{...approved.acceptanceApplicability,scope:{...scope,taskId:'foreign-task'}}}),e=>e.code==='LOCAL_ACCEPTANCE_CAPABILITY_MISSING')
 if(item.sg==='SG22')assert.throws(()=>validateEngineeringPlanScope({scopePaths:item.scopePaths,criteria:stage.criteria.map(criterion=>({criterion}))},stage),e=>e.code==='ENGINEERING_TECHNICAL_PLAN_INVALID')
})
