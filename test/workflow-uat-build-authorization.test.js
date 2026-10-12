import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
const sha='a'.repeat(40), target={id:'web-uat2',kind:'uat-deployment',repository:'HiQ-AI/dataset-web',environment:'uat',service:'dataset-web',runbookId:'web-uat2',branch:'feature/uat2-base',woodpecker:{baseUrl:'https://woodpecker.hiqdat.dev',repositoryId:2,cronName:'web-uat2'},kubernetes:{namespace:'hiqlcd-app-uat2',deployment:'dataset-web'},registry:{image:'registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web'},entryUrl:'https://uat2.example.test'}
function fixture(kind='uat-deployment'){
 const configuredTarget={...target,kind}
 const methods=names=>Object.fromEntries(names.map(name=>[name,async()=>({})]))
 const clients={release:{github:methods(['readBranch','resolveApprovedPullRequest','readPullRequest','readCommit','readChecks','readRequiredChecks','mergePullRequest']),woodpecker:methods(['listPipelines','readBuildEvidence','triggerBuild']),kubernetes:methods(['readDeployment','readPods','readEntry']),registry:methods(['readManifest'])}}
 const platform=createTrustedWorkflowPlatforms({config:{release:{targets:[configuredTarget]}},clients,ownerActorId:'owner'})
 const objective='批准构建 '+target.id+' '+target.repository+' '+sha
 const source={sourceKey:'human-1',sourceVersion:1,actorId:'owner',body:objective,status:'active'}
 const condition={sourceKey:source.sourceKey,sourceVersion:1,sourceQuote:objective,objective}
 const input={target:{repository:target.repository,environment:target.environment,service:target.service,runbookId:target.runbookId,commitSha:sha}}
 const requirement={scope:{actorId:'owner'},stageAuthorizations:[{workflowId:'task-uat-deployment',gate:'none',...condition}],sourceInstructions:[{sourceKey:source.sourceKey,sourceVersion:1,actorId:'owner',text:objective}]}
 const stage={runId:'run-1',workflowId:'task-'+kind,status:'running',gate:'none',requirementRef:'stage-input',sourceCondition:condition}
 const plan={task:{taskId:'task-1',controlState:'active',requirementRevision:2,planRequirementRevision:2,requirementRef:'task-input'},stages:[stage]}
 const queries=[]
 platform.bindExecution({controller:{state:async()=>({})},artifacts:{read:async ref=>ref==='stage-input'?input:requirement},store:{query:async q=>{queries.push(q);return q.kind==='task.plan'?plan:source}}})
 const binding={taskId:'task-1',runId:'run-1',nodeRunId:'node-1',generation:1}
 const prepared={workflowKind:kind,operation:kind==='uat-rebuild'?'rebuild':'build',runId:'run-1',generation:1,requirementDigest:executionDigest(input),targetDigest:executionDigest(input.target),expected:{commitSha:sha}}
 return {platform,binding,prepared,plan,stage,input,requirement,source,condition,queries}
}
test('ordinary UAT build uses fixed task and candidate checks without a human grant',async()=>{
 const f=fixture();delete f.requirement.stageAuthorizations;delete f.requirement.sourceInstructions;delete f.stage.sourceCondition
 const grant=await f.platform.authorizeExternal(f)
 assert.equal(grant.approval,undefined);assert.match(grant.authorizationRef,/^uat-build:/)
 assert.deepEqual(await f.platform.authorizeExternal(f),grant)
 assert.ok(f.queries.every(q=>q.kind==='task.plan'))
})
const invalid={
 'paused task':['UAT_EXECUTION_BINDING_INVALID',f=>f.plan.task.controlState='paused'],
 'stale requirement':['UAT_EXECUTION_BINDING_INVALID',f=>f.plan.task.requirementRevision=3],
 'different task':['UAT_EXECUTION_BINDING_INVALID',f=>f.binding.taskId='other'],
 'different run':['UAT_EXECUTION_BINDING_INVALID',f=>f.stage.runId='other'],
 'wrong stage':['UAT_EXECUTION_BINDING_INVALID',f=>f.stage.workflowId='task-production-release'],
 'different candidate':['UAT_BUILD_TARGET_MISMATCH',f=>f.prepared.expected.commitSha='b'.repeat(40)],
 'different target':['UAT_BUILD_TARGET_MISMATCH',f=>f.prepared.targetDigest='b'.repeat(64)],
 'different input':['UAT_BUILD_TARGET_MISMATCH',f=>f.prepared.requirementDigest='b'.repeat(64)],
 'production target':['UAT_BUILD_TARGET_MISMATCH',f=>f.input.target.environment='production'],
 'unconfigured repository':['UAT_BUILD_TARGET_MISMATCH',f=>f.input.target.repository='other/repo'],
}
for(const [name,[code,change]] of Object.entries(invalid))test(name+' cannot dispatch or invent an approval',async()=>{
 const f=fixture();change(f);await assert.rejects(f.platform.authorizeExternal(f),{code})
})
test('other UAT operation retains business approval policy',async()=>{
 const f=fixture();f.prepared.operation='deploy';const grant=await f.platform.authorizeExternal(f)
 assert.equal(grant.authorizationRef,undefined);assert.ok(grant.approval)
})

test('UAT same-candidate rebuild has no business approval',async()=>{
 const f=fixture('uat-rebuild');const grant=await f.platform.authorizeExternal(f)
 assert.equal(grant.approval,undefined);assert.match(grant.authorizationRef,/^uat-build:/)
})
