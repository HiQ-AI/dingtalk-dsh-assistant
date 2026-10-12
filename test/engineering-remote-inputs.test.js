import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {createTaskRemoteWorkspace} from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import {resolveRemoteProjectBranches,createEngineeringRegistry} from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import {buildInternalAcceptancePlan} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import {discoverProjectRunConfiguration,projectConfiguredService,projectConfiguredBuild,assertProjectRunConfiguration} from '../packages/dingtalk-dsh-assistant/execution-project-config.js'
import {describeTaskNodeOutput} from '../packages/dingtalk-dsh-assistant/workflow-service.js'
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{windowsHide:true,encoding:'utf8'}).trim()
async function fixture(t,id='arbitrary-project'){
 const parent=resolve('docs/tmp/remote-input-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'repo-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'original'),remote=join(root,'remote.git'),managed=join(root,'managed');await mkdir(source);await mkdir(managed);git(source,'init','-b','trunk');git(source,'config','user.name','Test');git(source,'config','user.email','test@example.invalid');await writeFile(join(source,'value.txt'),'source');git(source,'add','.');git(source,'commit','-m','source');const sourceCommit=git(source,'rev-parse','HEAD');execFileSync('git',['init','--bare',remote]);git(source,'push',remote,'HEAD:refs/heads/trunk');git(remote,'symbolic-ref','HEAD','refs/heads/trunk');git(source,'checkout','-b','feature/uat4-base');await writeFile(join(source,'uat-only.txt'),'must not enter development');git(source,'add','.');git(source,'commit','-m','target only');git(source,'push',remote,'HEAD:refs/heads/feature/uat4-base');const targetCommit=git(source,'rev-parse','HEAD');git(source,'checkout','-b','feature/clean','trunk');await writeFile(join(source,'full-feature.txt'),'keep every existing feature');git(source,'add','.');git(source,'commit','-m','full existing feature');git(source,'push',remote,'HEAD:refs/heads/feature/clean');return {root,source,remote,managed,sourceCommit,targetCommit,developmentCommit:git(source,'rev-parse','HEAD'),id}
}
test('remote HEAD and three branch intention resolve without source checkout; optional wrong local HEAD cannot affect source',async t=>{
 const f=await fixture(t);const config={remote:f.remote,sourceRepository:join(f.root,'nonexistent'),developmentBranch:'feature/clean'}
 const selected=await resolveRemoteProjectBranches(config,{uatBranch:'feature/uat4-base',commandId:'command'})
 assert.equal(selected.sourceBranch,'trunk');assert.equal(selected.sourceCommit,f.sourceCommit);assert.equal(selected.developmentCommit,f.developmentCommit);assert.equal(selected.targetCommit,f.targetCommit)
 const display=describeTaskNodeOutput({nodeId:'prepare-generation'},{requirement:{baseCommit:selected.developmentCommit},startingPoint:{repository:f.id,sourceBranch:selected.sourceBranch,plannedDevelopmentBranch:selected.developmentBranch,targetBranch:selected.targetBranch,remoteSourceCommit:selected.sourceCommit,sourceOrigin:selected.origin}})
 assert.match(display.text,/拟用开发分支/);assert.match(display.text,/远程源提交（ls-remote 查询）/);assert.match(display.text,/尚未创建|仅解析配置/);assert.ok(!display.text.includes(f.developmentCommit))
 assert.doesNotThrow(()=>createEngineeringRegistry({ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),repositories:[{id:'demo',githubRepository:'test/demo',remote:f.remote,managedRoot:f.managed,editablePaths:['value.txt'],checks:[{id:'build',version:'1',executable:process.execPath,args:['-e','process.exit(0)']}]}]}))
})
test('same Task/repo reuses exact Git directory across generations/stages, preserves dirty files/full feature, never premerges target',async t=>{
 const f=await fixture(t),adapter=await createTaskRemoteWorkspace({root:f.managed,remote:f.remote,taskId:'task',repositoryId:f.id,sourceBranch:'trunk',sourceCommit:f.sourceCommit,developmentBranch:'feature/clean',targetBranch:'feature/uat4-base',targetCommit:f.targetCommit})
 const first=await adapter.prepare({runId:'stage-one',generation:1,requirementDigest:'a'.repeat(64),baseCommit:f.developmentCommit});const receipt=await adapter.execute(first)
 assert.equal(receipt.sourceCommit,f.developmentCommit);assert.equal(receipt.developmentBranch,'feature/clean');assert.equal(await readFile(join(receipt.directory,'full-feature.txt'),'utf8'),'keep every existing feature');await assert.rejects(readFile(join(receipt.directory,'uat-only.txt')),{code:'ENOENT'})
 await writeFile(join(receipt.directory,'value.txt'),'undelivered edit')
 for(const [runId,generation]of[['stage-one',2],['stage-two',1]]){const next=await adapter.prepare({runId,generation,requirementDigest:'b'.repeat(64),baseCommit:f.developmentCommit});assert.equal(next.directory,first.directory);assert.equal((await adapter.execute(next)).status,'succeeded');assert.equal(await readFile(join(next.directory,'value.txt'),'utf8'),'undelivered edit')}
 const detail=describeTaskNodeOutput({nodeId:'prepare-workspace'},{workspace:receipt});assert.match(detail.text,/实际开发分支/);assert.match(detail.text,/实际 checkout 提交/);assert.ok(detail.text.includes(f.developmentCommit))
})
test('internal acceptance derives original goals and parameters without planner artifact and does not invent success',()=>{
 const criteria=[{id:'criterion-1',description:'original expected one'},{id:'criterion-2',description:'原'.repeat(5000)}],scenarios=[{id:'actual-one',description:'native assertion',expected:'actual expected one',criterionIds:['criterion-1'],parameters:{item:3}},{id:'actual-two',description:'native second',expected:'actual expected two',criterionIds:['criterion-2']}]
 const plan=buildInternalAcceptancePlan({criteria,scenarios});assert.equal(plan.cases.length,2);assert.equal(plan.cases[0].expected,'actual expected one');assert.equal(plan.cases[0].criterionDescription,criteria[0].description);assert.deepEqual(plan.cases[0].parameters,{item:3});assert.equal(plan.cases[1].criterionDescription.length,5000);assert.ok(!plan.passed)
 assert.throws(()=>buildInternalAcceptancePlan({criteria,scenarios:[]}),{code:'LOCAL_ACCEPTANCE_CAPABILITY_MISSING'})
})
test('existing project profile is referenced for native service/Maven without fixed local.yml or credential contents',async t=>{
 const f=await fixture(t),root=join(f.root,'configuration');await mkdir(root);const file=join(root,'application-demo.properties');await writeFile(file,'spring.datasource.password=TEST_PRIVATE_CREDENTIAL\n')
 const service={executable:'java',args:['-jar','target/demo.jar','--spring.profiles.active=demo','--spring.config.additional-location=file:private-fallback/']}
 const config=await discoverProjectRunConfiguration({directory:f.source,configurationRoot:root,service,files:[]});assert.equal(config.files.length,1);assert.equal(config.files[0].path,file);assert.ok(!JSON.stringify(config).includes('TEST_PRIVATE_CREDENTIAL'))
 assert.ok(projectConfiguredService(service,config).args.at(-1).includes(file.replaceAll('\\','/')));assert.ok(!projectConfiguredService(service,config).args.some(a=>a.includes('private-fallback')))
 const build=projectConfiguredBuild({executable:'mvn.cmd',args:['test']},config);assert.ok(build.args.some(a=>a.includes('spring.config.additional-location=')))
 const explicit={executable:'mvn.cmd',args:['test','-Dspring.profiles.active=unit']};assert.deepEqual(projectConfiguredBuild(explicit,config),explicit)
 await assertProjectRunConfiguration(config);await writeFile(file,'changed');await assert.rejects(assertProjectRunConfiguration(config),{code:'LOCAL_ACCEPTANCE_RUN_CONFIG_CHANGED'})
 const absent=await discoverProjectRunConfiguration({directory:f.source,service,files:[]});assert.equal(absent.files.length,0);assert.deepEqual(projectConfiguredService(service,absent),service)
})

test('repository admission rejects inline remote credentials without echoing them',()=>{
 assert.throws(()=>createEngineeringRegistry({ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),repositories:[{id:'demo',githubRepository:'test/demo',remote:'https://user:PRIVATE@example.invalid/test/demo.git',managedRoot:resolve('docs/tmp/managed'),editablePaths:['value.txt'],checks:[{id:'build',version:'1',executable:process.execPath,args:['-e','process.exit(0)']}]}]}),error=>error.code==='ENGINEERING_REMOTE_CREDENTIALS_INLINE'&&!error.message.includes('PRIVATE'))
})

test('internal JSON scenario expectation comes from approved contract, never goal prose',()=>{
 const criteria=[{id:'criterion-1',description:'withdraw messages without losing original business facts'}]
 const scenarios=[{id:'withdraw',description:'parameters为空对象。expected必须为{"withdrawn":true,"persisted":true}'}]
 assert.equal(buildInternalAcceptancePlan({criteria,scenarios}).cases[0].expected,'{"withdrawn":true,"persisted":true}')
 assert.throws(()=>buildInternalAcceptancePlan({criteria,scenarios:[{id:'missing',description:'check business outcome'}]}),{code:'LOCAL_ACCEPTANCE_EXPECTATION_REQUIRED'})
})
