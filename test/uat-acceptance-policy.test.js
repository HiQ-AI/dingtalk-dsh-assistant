import {createUatMergePlatform} from '../packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {validUatAcceptancePolicy,assertUatLocalAcceptance,assertCurrentUatOwnerBinding} from '../packages/dingtalk-dsh-assistant/uat-acceptance-policy.js'
import {planReleaseTargetAppend} from '../scripts/configure-release-targets.mjs'
import {createHash} from 'node:crypto'
const policy={targetId:'dataset-uat2-deployment',requiredChecks:[],acceptancePolicy:'original-owner-current-scope'}
const proof={taskId:'current-task',manifestRef:'accepted-candidate',reviewRef:'current-review',definitionVersion:'original-owner-candidate-v1',scenarioIds:['withdrawal-queue-once','isolated-retry'],evidenceDigest:'a'.repeat(64)}
test('current task policy has no per-task fixed scenario list; historical list remains valid',()=>{
 assert.equal(validUatAcceptancePolicy(policy),true)
 assert.equal(validUatAcceptancePolicy({requiredScenarioIds:['old-case']}),true)
 for(const bad of [{acceptancePolicy:'unknown'},{requiredScenarioIds:[]},{requiredScenarioIds:['duplicate','duplicate']},{...policy,requiredScenarioIds:['unrelated']}])assert.equal(validUatAcceptancePolicy(bad),false)
})
test('current policy requires real accepted candidate proof and nonempty unique scenarios',()=>{
 assert.doesNotThrow(()=>assertUatLocalAcceptance(policy,proof))
 for(const changed of [{scenarioIds:[]},{scenarioIds:['same','same']},{definitionVersion:'15'},{definitionVersion:'original-owner-review-v1'},{manifestRef:null},{reviewRef:null},{evidenceDigest:'invented'}])assert.throws(()=>assertUatLocalAcceptance(policy,{...proof,...changed}))
})
test('current Owner scope rejects old requirement and missing binding, without requiring plan metadata equality',()=>{
 const plan={task:{requirementRevision:7,planRevision:40}}
 assert.doesNotThrow(()=>assertCurrentUatOwnerBinding(policy,{ref:'accepted',requirementRevision:7,planRevision:2},plan))
 assert.throws(()=>assertCurrentUatOwnerBinding(policy,{ref:'old',requirementRevision:6},plan),{code:'UAT_OWNER_CURRENT_SCOPE_REQUIRED'})
 assert.throws(()=>assertCurrentUatOwnerBinding(policy,null,plan),{code:'UAT_OWNER_CURRENT_SCOPE_REQUIRED'})
 assert.doesNotThrow(()=>assertCurrentUatOwnerBinding({requiredScenarioIds:['historical']},null,plan))
})
test('legacy fixed scenarios still reject missing business evidence',()=>{
 assert.doesNotThrow(()=>assertUatLocalAcceptance({requiredScenarioIds:['withdrawal-queue-once']},proof))
 assert.throws(()=>assertUatLocalAcceptance({requiredScenarioIds:['unrelated']},proof),{code:'UAT_LOCAL_SCENARIO_REQUIRED'})
})
test('formal configuration planner accepts generic project/environment policy without changing old scope',async()=>{
 const target={id:policy.targetId,kind:'uat-deployment',repository:'HiQ-AI/dataset',environment:'uat',service:'dataset',runbookId:'dataset-uat2-deployment',branch:'feature/uat2-base',woodpecker:{baseUrl:'https://woodpecker.hiqdat.dev',repositoryId:1,cronName:'dataset-uat2-poll'},kubernetes:{namespace:'hiqlcd-app-uat2',deployment:'dataset'},registry:{image:'registry.cn-sh1.ctyun.cn/hiq-ai/dataset'},entryUrl:'https://editor2.hiqdat.dev/api/dataset/ready'}
 const source=`- name: '@zzusp/dingtalk-dsh-assistant/resident'
  config:
    workflow:
      repositories:
        - id: dataset
          remote: https://github.com/HiQ-AI/dataset.git
      platforms:
        release:
          targets: []
        uatMerge:
          targets: []
`
 const result=await planReleaseTargetAppend(source,{expectedProfileSha256:createHash('sha256').update(source).digest('hex'),target,policy})
 assert.equal(result.changed,true);assert.match(result.updated,/original-owner-current-scope/);assert.doesNotMatch(result.updated,/requiredScenarioIds/)
 const repeat=await planReleaseTargetAppend(result.updated,{expectedProfileSha256:createHash('sha256').update(result.updated).digest('hex'),target,policy});assert.equal(repeat.changed,false)
})

test('generic policy passes complete platform preflight using accepted current scenarios; engineering and empty proofs cannot publish',async()=>{
 const head='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40)
 const target={id:policy.targetId,kind:'uat-deployment',repository:'HiQ-AI/dataset',service:'dataset',branch:'feature/uat2-base'}
 let observedProof={...proof,commitSha:head,treeSha:tree},writes=0
 const github={readRequiredChecks:async()=>({complete:true,checks:[],evidenceRef:'rules'}),readAtomicPushPolicy:async()=>({allowed:true,evidenceRef:'atomic'}),readBranch:async()=>({commitSha:base,evidenceRef:'branch'}),readCommit:async()=>({treeSha:tree,evidenceRef:'commit'}),readChecks:async()=>({complete:true,checks:[],evidenceRef:'checks'}),readPullRequest:async()=>({number:378,state:'open',merged:false,draft:false,mergeable:true,baseBranch:target.branch,baseRepository:target.repository,headRepository:target.repository,headCommitSha:head,evidenceRef:'pr'}),atomicFastForward:async()=>{writes++;throw Error('test must not send')}}
 const platform=createUatMergePlatform({targets:[target],policies:[policy],github,readLocalEvidence:async()=>({...observedProof,evidenceRef:'accepted:current'})})
 const requirement={targetId:target.id,repository:target.repository,service:target.service,baseBranch:target.branch,pullRequestNumber:378,headCommitSha:head,requiredChecks:[],localEvidence:proof}
 assert.equal((await platform.adapter.inspect({phase:'preflight',requirement})).facts.localAcceptancePassed,true)
 observedProof={...observedProof,definitionVersion:'15',targetCommit:base};await assert.rejects(platform.adapter.inspect({phase:'preflight',requirement}),{code:'UAT_OWNER_CURRENT_SCOPE_REQUIRED'})
 observedProof={...observedProof,definitionVersion:'original-owner-candidate-v1',scenarioIds:[]};await assert.rejects(platform.adapter.inspect({phase:'preflight',requirement}),{code:'UAT_LOCAL_SCENARIO_REQUIRED'})
 assert.equal(writes,0)
})
