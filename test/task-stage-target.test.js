import test from 'node:test'
import assert from 'node:assert/strict'
import {stageTargetId} from '../packages/dingtalk-dsh-assistant/task-stage-target.js'
test('each repeated publication workflow binds its declared repository target without changing single target behavior',()=>{
 const requirement={stageTargets:{merge:['front-uat3','back-uat3'],deploy:['front-uat3','back-uat3']}},plan={stages:[{workflowId:'merge'},{workflowId:'deploy'},{workflowId:'merge'},{workflowId:'deploy'}]}
 assert.equal(stageTargetId(requirement,plan,0,'merge'),'front-uat3');assert.equal(stageTargetId(requirement,plan,1,'deploy'),'front-uat3');assert.equal(stageTargetId(requirement,plan,2,'merge'),'back-uat3');assert.equal(stageTargetId(requirement,plan,3,'deploy'),'back-uat3')
 assert.throws(()=>stageTargetId(requirement,{stages:[...plan.stages,{workflowId:'merge'}]},4,'merge'),/EXTERNAL_TARGET_NOT_ALLOWED/)
 assert.equal(stageTargetId({stageTargets:{merge:'single'}},plan,2,'merge'),'single')
})

import {createExternalStageContracts} from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
test('accepted Owner candidates feed formal merge and deployment selects the matching repository receipt',async()=>{
 const captured=[],external={availableTargets:[{workflowId:'task-uat-deployment',targetId:'front',repository:'Owner/front'},{workflowId:'task-uat-deployment',targetId:'back',repository:'Owner/back'}],prepareAcceptedProjectSource:async()=>({pullRequestNumber:7,headCommitSha:'a'.repeat(40),resourceRef:'owner-delivery-task:task'}),prepareRequirement:async args=>{captured.push(args);return args}}
 const contracts=createExternalStageContracts({workflowIds:['task-uat-pr-merge','task-uat-deployment'],external,readEngineeringProof:async()=>{throw Error('must not replay native engineering')},readArtifact:async ref=>({repository:ref,baseBranch:'feature/uat3-base',mergeCommitSha:ref==='Owner/front'?'f'.repeat(40):'b'.repeat(40)})})
 const origin={command:{args:{arguments:{}}}},requirement={request:'release accepted candidates',target:{},stageTargets:{'task-uat-pr-merge':'front','task-uat-deployment':['front','back']}}
 await contracts[0].prepare({taskId:'task',stage:{workflowId:'task-uat-pr-merge'},plan:{stages:[{workflowId:'task-engineering-original',runId:'run',status:'succeeded'}]},stageIndex:1,requirement,origin})
 assert.equal(captured[0].materials[0].resourceRef,'owner-delivery-task:task');assert.equal(captured[0].action.arguments.pullRequestNumber,7)
 const stages=[{workflowId:'task-uat-pr-merge',runId:'front-merge',status:'succeeded',outputRef:'Owner/front'},{workflowId:'task-uat-pr-merge',runId:'back-merge',status:'succeeded',outputRef:'Owner/back'},{workflowId:'task-uat-deployment'}]
 await contracts[1].prepare({taskId:'task',stage:{workflowId:'task-uat-deployment'},plan:{stages},stageIndex:2,requirement,origin})
 assert.equal(captured[1].action.arguments.commitSha,'f'.repeat(40));assert.equal(captured[1].materials[0].resourceRef,'uat-merge-task:task:front-merge')
})
