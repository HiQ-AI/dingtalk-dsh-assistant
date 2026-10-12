import test from 'node:test'
import assert from 'node:assert/strict'
import {assertEngineeringStageRepository,selectConfiguredLocalAcceptance} from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
const requirement={target:{repositoryId:'frontend'},authorization:{actorId:'human'},sourceInstructions:[{sourceKey:'original',sourceVersion:1,actorId:'human',text:'Update the backend export'}]}
const stage={workflowId:'task-engineering',sourceCondition:{repositoryId:'backend',sourceKey:'original',sourceVersion:1,sourceQuote:'Update the backend export',objective:'backend export',acceptanceCriteria:['Export works']}}
test('configured cross-project capability needs no dependency whitelist',()=>{
 assert.doesNotThrow(()=>assertEngineeringStageRepository({requirement,stage,repositories:[{repositoryId:'frontend'},{repositoryId:'backend'}]}))
})
test('unknown capability or foreign authorization still fails',()=>{
 assert.throws(()=>assertEngineeringStageRepository({requirement,stage,repositories:[{repositoryId:'frontend'}]}),{code:'TASK_OWNER_STAGE_NOT_AUTHORIZED'})
 assert.throws(()=>assertEngineeringStageRepository({requirement:{...requirement,authorization:{actorId:'other'}},stage,repositories:[{repositoryId:'backend'}]}),{code:'TASK_OWNER_STAGE_NOT_AUTHORIZED'})
})

test('new stage uses configured runner without per-stage digest registration',()=>{
 const runner={version:'2',scenarios:[{id:'real'}]}
 assert.deepEqual(selectConfiguredLocalAcceptance({localAcceptance:runner},{taskId:'task',stageId:'backend',repositoryId:'backend',uatEnvironment:'uat3',requestDigest:'new-metadata'}),{localAcceptanceConfig:runner})
 assert.deepEqual(selectConfiguredLocalAcceptance({taskLocalAcceptance:[{scope:{taskId:'task',uatEnvironment:'uat3',requestDigest:'old'},localAcceptance:runner}]},{taskId:'task',stageId:'backend',repositoryId:'backend',uatEnvironment:'uat3',requestDigest:'new'}),{localAcceptanceConfig:runner})
 assert.throws(()=>selectConfiguredLocalAcceptance({},{taskId:'task',repositoryId:'backend',uatEnvironment:'uat3'}),{code:'LOCAL_ACCEPTANCE_CAPABILITY_MISSING'})
})
