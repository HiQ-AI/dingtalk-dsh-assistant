import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import yaml from 'js-yaml'
import { createReleasePlatform } from '../packages/dingtalk-dsh-assistant/workflow-release-platform.js'
import { createUatMergePlatform } from '../packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
const fail=()=>{throw new Error('LOCAL_CONFIG_RELEASE_POLICY_REPAIR_INVALID')}
const keys=(x,a)=>x&&typeof x==='object'&&!Array.isArray(x)&&isDeepStrictEqual(Object.keys(x).sort(),a.sort())
const identity=['repository','environment','service','branch','woodpecker','kubernetes','registry','entryUrl']
export function validateReleaseRuntime(platforms){
 const deny=()=>{throw new Error('LOCAL_CONFIG_REPAIR_NETWORK_FORBIDDEN')}
 const github=Object.fromEntries(['readBranch','readPullRequest','readCommit','readChecks','readRequiredChecks','resolveApprovedPullRequest','readTag','createTag'].map(k=>[k,deny]))
 createReleasePlatform({targets:platforms.release.targets.map(({id,...target})=>target),clients:{github,woodpecker:{listPipelines:deny,readBuildEvidence:deny,triggerBuild:deny},kubernetes:{readDeployment:deny,readPods:deny,readEntry:deny},registry:{readManifest:deny},attestations:{read:deny}}})
 createUatMergePlatform({targets:platforms.release.targets,policies:platforms.uatMerge.targets,github,readLocalEvidence:deny})
}
export function planInvalidRebuildPolicyRemoval(source,registration,deploymentTargetId){
 const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:x=>x})])
 const parse=s=>{const doc=yaml.load(s,{schema}),found=[];const walk=x=>{if(!x||typeof x!=='object')return;if(x.name==='@zzusp/dingtalk-dsh-assistant/resident'&&x.config?.workflow)found.push(x.config.workflow);for(const v of Object.values(x))walk(v)};walk(doc);if(found.length!==1)fail();return {doc,workflow:found[0]}}
 if(!keys(registration,['expectedProfileSha256','target','policy'])||registration.target?.kind!=='uat-rebuild'||registration.target.environment!=='uat'||registration.policy?.targetId!==registration.target.id)fail()
 const before=parse(source),p=before.workflow.platforms,target=registration.target
 const targets=p?.release?.targets,policies=p?.uatMerge?.targets
 if(!Array.isArray(targets)||!Array.isArray(policies))fail()
 const actual=targets.filter(x=>x.id===target.id),invalid=policies.filter(x=>x.targetId===target.id)
 if(actual.length!==1||!isDeepStrictEqual(actual[0],target)||invalid.length!==1||!isDeepStrictEqual(invalid[0],registration.policy))fail()
 const deployment=targets.filter(x=>x.id===deploymentTargetId&&x.kind==='uat-deployment'&&identity.every(k=>isDeepStrictEqual(x[k],target[k])))
 if(deployment.length!==1)fail()
 const existing=policies.filter(x=>x.targetId===deployment[0].id)
 if(existing.length!==1||!isDeepStrictEqual({...existing[0],targetId:target.id},registration.policy))fail()
 const escaped=target.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 const matches=[...source.matchAll(new RegExp('^( *)- targetId: '+escaped+'\\r?$','gm'))]
 if(matches.length!==1)fail()
 const start=matches[0].index,indent=matches[0][1].length
 let end=source.indexOf('\n',start)+1
 while(end>0&&end<source.length){const nl=source.indexOf('\n',end),until=nl<0?source.length:nl+1,line=source.slice(end,until);if(line.trim()&&/^ */.exec(line)[0].length<=indent)break;end=until}
 const updated=source.slice(0,start)+source.slice(end),after=parse(updated)
 before.workflow.platforms.uatMerge.targets=policies.filter(x=>x.targetId!==target.id)
 if(!isDeepStrictEqual(before.doc,after.doc))fail()
 validateReleaseRuntime(after.workflow.platforms)
 return {updated,changed:updated!==source,workflow:after.workflow,targetId:target.id,deploymentTargetId:deployment[0].id}
}
export async function planReleasePolicyRestore(source,proposalPath,{profile,expectedSha256}){
 const bytes=await readFile(proposalPath),proposal=JSON.parse(bytes)
 if(!keys(proposal,['kind','profile','expectedProfileSha256','deploymentReceipt','registrationProposal','deploymentTargetId'])||proposal.kind!=='release-policy-repair'||proposal.profile!==profile||proposal.expectedProfileSha256!==expectedSha256||hash(source)!==expectedSha256)fail()
 const proof=async ref=>{if(!keys(ref,['path','sha256'])||!isAbsolute(ref.path)||!/^[a-f0-9]{64}$/.test(ref.sha256))fail();const b=await readFile(ref.path);if(hash(b)!==ref.sha256)fail();return JSON.parse(b)}
 const receipt=await proof(proposal.deploymentReceipt),registration=await proof(proposal.registrationProposal)
 if(receipt.profileSha256.toLowerCase()!==expectedSha256||receipt.releaseTargetsProposal!==proposal.registrationProposal.path||receipt.inputHashes?.[proposal.registrationProposal.path]?.toLowerCase()!==proposal.registrationProposal.sha256)fail()
 const plan=planInvalidRebuildPolicyRemoval(source,registration,proposal.deploymentTargetId)
 if(!isAbsolute(plan.workflow.dbPath??''))fail()
 const db=new DatabaseSync(plan.workflow.dbPath,{readOnly:true}),knownActiveRuns=[]
 try{for(const row of db.prepare("SELECT task_id,run_id,generation,workflow_digest FROM execution_runs WHERE status NOT IN ('succeeded','failed','cancelled') ORDER BY run_id").all())knownActiveRuns.push({taskId:row.task_id,runId:row.run_id,generation:row.generation,workflowDigest:row.workflow_digest,matches:true,proof:'all workflow configuration unchanged except exact invalid rebuild merge-policy removal'})}finally{db.close()}
 if(!knownActiveRuns.length)fail()
 return {plan:{updated:plan.updated,changed:plan.changed},proof:{kind:proposal.kind,proposalSha256:hash(bytes),deploymentReceipt:proposal.deploymentReceipt,registrationProposal:proposal.registrationProposal,removedPolicyTargetId:plan.targetId,preservedDeploymentTargetId:plan.deploymentTargetId,runtimeAssemblyVerified:true,knownActiveRuns}}
}