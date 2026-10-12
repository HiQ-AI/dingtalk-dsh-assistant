import test from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import {planInvalidRebuildPolicyRemoval,validateReleaseRuntime} from '../scripts/repair-release-target-policy.mjs'
const deployment={id:'sg22-web-uat3',kind:'uat-deployment',repository:'HiQ-AI/dataset-web',environment:'uat',service:'dataset-web',runbookId:'dataset-web-uat3-deployment',branch:'feature/uat3-base',woodpecker:{baseUrl:'https://woodpecker.hiqdat.dev',repositoryId:2,cronName:'dataset-web-uat3-poll'},kubernetes:{namespace:'hiqlcd-app-uat3',deployment:'dataset-web'},registry:{image:'registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web'},entryUrl:'https://editor3.hiqdat.dev/'}
const target={...deployment,id:'sg22-web-uat3-rebuild',kind:'uat-rebuild',runbookId:'dataset-web-uat3-rebuild'}
const policy={targetId:deployment.id,requiredChecks:[],requiredScenarioIds:['sg22-merge-result-local','sg22-release-gates-local']},badPolicy={...policy,targetId:target.id}
const platforms={release:{targets:[deployment,target]},uatMerge:{targets:[policy,badPolicy]}}
const doc=[{name:'@zzusp/dingtalk-dsh-assistant/resident',config:{workflow:{platforms,dbPath:'unused',unrelated:{keep:true}}}}],source=yaml.dump(doc),registration={expectedProfileSha256:'historical-bound-sha',target,policy:badPolicy}
test('actual runtime assembly rejects erroneous rebuild merge policy and accepts exact single removal',()=>{
 assert.throws(()=>validateReleaseRuntime(platforms),/UAT_MERGE_TARGET_INVALID/)
 const fixed=planInvalidRebuildPolicyRemoval(source,registration,deployment.id)
 assert.equal(fixed.changed,true);assert.equal(fixed.deploymentTargetId,deployment.id)
 const actual=yaml.load(fixed.updated);const expected=structuredClone(doc);expected[0].config.workflow.platforms.uatMerge.targets=[policy]
 assert.deepEqual(actual,expected);assert.doesNotThrow(()=>validateReleaseRuntime(actual[0].config.workflow.platforms))
})
test('reject wrong target, altered policy, deployment identity and production repair',()=>{
 for(const candidate of [{...registration,target:{...target,entryUrl:'https://other.invalid/'}},{...registration,policy:{...badPolicy,requiredScenarioIds:['other']}},{...registration,target:{...target,kind:'production-release',environment:'production'}}])
  assert.throws(()=>planInvalidRebuildPolicyRemoval(source,candidate,deployment.id),/REPAIR_INVALID/)
 assert.throws(()=>planInvalidRebuildPolicyRemoval(source,registration,'wrong'),/REPAIR_INVALID/)
 const changed=structuredClone(doc);changed[0].config.workflow.platforms.uatMerge.targets[0].requiredScenarioIds=['different']
 assert.throws(()=>planInvalidRebuildPolicyRemoval(yaml.dump(changed),registration,deployment.id),/REPAIR_INVALID/)
})
test('duplicate same mapping requires explicit original deployment identity; repeated removal cannot mutate again',()=>{
 const duplicate=structuredClone(doc);duplicate[0].config.workflow.platforms.release.targets.unshift({...deployment,id:'other-alias'})
 duplicate[0].config.workflow.platforms.uatMerge.targets.unshift({...policy,targetId:'other-alias'})
 const fixed=planInvalidRebuildPolicyRemoval(yaml.dump(duplicate),registration,deployment.id)
 assert.equal(yaml.load(fixed.updated)[0].config.workflow.platforms.release.targets.length,3)
 assert.throws(()=>planInvalidRebuildPolicyRemoval(fixed.updated,registration,deployment.id),/REPAIR_INVALID/)
})