import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import yaml from 'js-yaml'
import {planReleaseTargetAppend,configureReleaseTargetAppend} from '../scripts/configure-release-targets.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex')
const target={id:'web-uat3',kind:'uat-deployment',repository:'Owner/web',environment:'uat',service:'web',runbookId:'web-uat3',branch:'feature/uat3-base',woodpecker:{baseUrl:'https://woodpecker.hiqdat.dev',repositoryId:2,cronName:'web-uat3-poll'},kubernetes:{namespace:'app-uat3',deployment:'web'},registry:{image:'registry.cn-sh1.ctyun.cn/hiq-ai/web'},entryUrl:'https://editor3.example.invalid/'}
const policy={targetId:target.id,requiredChecks:[],requiredScenarioIds:['seven-ui']}
const source=yaml.dump([{name:'@zzusp/dingtalk-dsh-assistant/resident',config:{workflow:{repositories:[{id:'web',githubRepository:'Owner/web'}],platforms:{release:{targets:[{...target,id:'old',runbookId:'old',branch:'feature/uat2-base'}]},uatMerge:{targets:[{...policy,targetId:'old'}]}},untouched:'preserve'}}}])
const proposal={expectedProfileSha256:hash(source),target,policy}
test('append exact UAT target and policy; preserve existing settings and reject conflict/production/credentials',async()=>{
 const plan=await planReleaseTargetAppend(source,proposal), parsed=yaml.load(plan.updated)[0].config.workflow
 assert.equal(parsed.untouched,'preserve');assert.equal(parsed.platforms.release.targets.length,2)
 assert.deepEqual(parsed.platforms.release.targets[1],target);assert.deepEqual(parsed.platforms.uatMerge.targets[1],policy)
 assert.equal((await planReleaseTargetAppend(plan.updated,{...proposal,expectedProfileSha256:hash(plan.updated)})).changed,false)
 for(const changed of [{target:{...target,kind:'production-release'}},{target:{...target,woodpecker:{...target.woodpecker,token:'forbidden'}}},{policy:{...policy,requiredScenarioIds:[]}},{target:{...target,repository:'Other/web'}}])await assert.rejects(planReleaseTargetAppend(source,{...proposal,...changed}),/RELEASE_CONFIG_/)
 await assert.rejects(planReleaseTargetAppend(plan.updated,{...proposal,expectedProfileSha256:hash(plan.updated),target:{...target,entryUrl:'https://different.invalid/'}}),/TARGET_CONFLICT/)
})
test('check is read-only; apply uses profile CAS and idempotent readback',async t=>{
 const root=await mkdtemp(join(tmpdir(),'release-target-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const profile=join(root,'profile.yml'),file=join(root,'proposal.json');await writeFile(profile,source);await writeFile(file,JSON.stringify(proposal))
 const args={profile,proposal:file,expectedSha256:hash(source)}
 assert.equal((await configureReleaseTargetAppend({...args,mode:'check'})).writes,0);assert.equal(await readFile(profile,'utf8'),source)
 assert.equal((await configureReleaseTargetAppend({...args,mode:'apply'})).writes,1)
 await assert.rejects(configureReleaseTargetAppend({...args,mode:'apply'}),/PROFILE_CHANGED/)
 const after=await readFile(profile,'utf8');await writeFile(file,JSON.stringify({...proposal,expectedProfileSha256:hash(after)}))
 assert.equal((await configureReleaseTargetAppend({...args,expectedSha256:hash(after),mode:'apply'})).writes,0)
})
test('append rebuild target through existing CAS registration; preserve deployment identity and policy',async()=>{
 const rebuild={...target,id:'web-uat3-rebuild',kind:'uat-rebuild',runbookId:'web-uat3-rebuild'}
 const rebuildPolicy={...policy,targetId:rebuild.id}
 const deployed=(await planReleaseTargetAppend(source,proposal)).updated
 const request={expectedProfileSha256:hash(deployed),target:rebuild,policy:rebuildPolicy}
 const plan=await planReleaseTargetAppend(deployed,request), parsed=yaml.load(plan.updated)[0].config.workflow
 assert.deepEqual(parsed.platforms.release.targets.find(x=>x.id===target.id),target)
 assert.deepEqual(parsed.platforms.release.targets.find(x=>x.id===rebuild.id),rebuild)
 assert.deepEqual(parsed.platforms.uatMerge.targets.find(x=>x.targetId===rebuild.id),rebuildPolicy)
 assert.equal((await planReleaseTargetAppend(plan.updated,{...request,expectedProfileSha256:hash(plan.updated)})).changed,false)
 await assert.rejects(planReleaseTargetAppend(deployed,{...request,expectedProfileSha256:hash(source)}),/PROPOSAL_STALE/)
 for(const changed of [{kind:'production-release'},{environment:'production'},{woodpecker:{...rebuild.woodpecker,token:'forbidden'}}])
  await assert.rejects(planReleaseTargetAppend(deployed,{...request,target:{...rebuild,...changed}}),/RELEASE_CONFIG_/)
 await assert.rejects(planReleaseTargetAppend(plan.updated,{...request,expectedProfileSha256:hash(plan.updated),target:{...rebuild,entryUrl:'https://different.invalid/'}}),/TARGET_CONFLICT/)
})