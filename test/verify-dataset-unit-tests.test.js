import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { testArguments, runCaptured } from '../scripts/verify-dataset-unit-tests.mjs'

test('长检查输出完整落盘，尾部失败可见且保持真实退出码',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dataset-log-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const result=runCaptured(process.execPath,['-e',"process.stdout.write('DEBUG '.repeat(12000)+'\\n[ERROR] real-tail-failure\\n');process.stderr.write('stderr-proof');process.exitCode=1"],root,root,'tests')
 assert.equal(result.exitCode,1);assert.equal(result.error,null)
 assert.ok(result.stdoutBytes>32768);assert.match(result.stdoutTail,/real-tail-failure/)
 assert.deepEqual(result.firstErrors,['[ERROR] real-tail-failure'])
 assert.equal(await readFile(result.stdoutPath,'utf8'),result.stdout)
 assert.equal(await readFile(result.stderrPath,'utf8'),'stderr-proof')
})

const bin=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin'):''
const java=join(bin,process.platform==='win32'?'java.exe':'java'),javac=join(bin,process.platform==='win32'?'javac.exe':'javac')
test('检查采用Maven原生单测发现并禁止跳过，报告目录独立',()=>{
 const args=testArguments('D:/maven','plexus-classworlds-2.7.jar','D:/candidate','host-unit-00000000-0000-0000-0000-000000000000')
 assert.ok(args.includes('-DskipTests=false'));assert.ok(args.includes('-Dmaven.test.skip=false'))
 assert.ok(args.includes('-Dtest=Test*,*Test,*Tests,*TestCase,!*IT,!*ITCase,!*E2ETest'));assert.ok(args.includes('-DfailIfNoTests=true'))
 assert.equal(args.at(-1),'org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test')
 assert.ok(args.includes('-Dsurefire.reportNameSuffix=host-unit-00000000-0000-0000-0000-000000000000'))
})
test('JDK报告记录跳过但拒绝全跳过、零用例、失败、缺失和伪造计数', {skip:process.platform!=='win32'}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'host-junit-proof-')),classes=join(root,'classes');await mkdir(classes)
 const compile=spawnSync(javac,['-encoding','UTF-8','-d',classes,resolve('scripts/LocalAcceptanceBackground.java')],{encoding:'utf8',windowsHide:true});assert.equal(compile.status,0,compile.stderr)
 const names=['ProcessImportTemplateSheetTest','ImportControllerTaskStatusTest'],suffix='host-unit-00000000-0000-0000-0000-000000000000'
 const write=async(overrides={})=>{for(const name of names){const attrs={tests:1,failures:0,errors:0,skipped:0,...overrides};await writeFile(join(root,`TEST-com.ecdigit.ecdata.service.merge.${name}-${suffix}.xml`),`<testsuite name="com.ecdigit.ecdata.service.merge.${name}(${suffix})" ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}><testcase name="works"/></testsuite>`)}}
 const run=()=>spawnSync(java,['-cp',classes,'LocalAcceptanceBackground','junit',root,suffix],{encoding:'utf8',windowsHide:true})
 assert.notEqual(run().status,0)
 await write();const good=run();assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/"tests":2/)
 await write();await writeFile(join(root,`TEST-com.ecdigit.ecdata.service.merge.${names[0]}-${suffix}.xml`),`<testsuite name="com.ecdigit.ecdata.service.merge.${names[0]}(${suffix})" tests="1" failures="0" errors="0" skipped="1"><testcase><skipped message="Requires integration context"/></testcase></testsuite>`)
 const mixed=run();assert.equal(mixed.status,0,mixed.stderr);assert.match(mixed.stdout,/"executed":1/);assert.match(mixed.stdout,/"skipped":1/)
 await writeFile(join(root,`TEST-com.ecdigit.ecdata.service.merge.${names[1]}-${suffix}.xml`),`<testsuite name="com.ecdigit.ecdata.service.merge.${names[1]}(${suffix})" tests="1" failures="0" errors="0" skipped="1"><testcase><skipped/></testcase></testsuite>`)
 assert.notEqual(run().status,0,'全部跳过不能通过检查')
 const stale=spawnSync(java,['-cp',classes,'LocalAcceptanceBackground','junit',root,'host-unit-11111111-1111-1111-1111-111111111111'],{encoding:'utf8',windowsHide:true})
 assert.notEqual(stale.status,0,'其他执行的成功报告不能复用')
 await write();await writeFile(join(root,`TEST-com.ecdigit.ecdata.service.merge.${names[0]}-${suffix}.xml`),'<testsuite name="forged" tests="1" failures="0" errors="0" skipped="0"><testcase/></testsuite>');assert.notEqual(run().status,0,'suite身份伪造拒绝')
 for(const attrs of [{tests:0},{skipped:1},{failures:1},{errors:1},{tests:2}]){await write(attrs);assert.notEqual(run().status,0,JSON.stringify(attrs))}
})

test('后端配置提案仅更换指定check版本与steps，不触碰其他仓库配置', async()=>{
 const {prepareBackendChecks}=await import('../docs/acceptance/topic-context-completeness/scripts/prepare-backend-unit-checks.mjs')
 const before=[{id:'dataset-package',version:'1',steps:[{executable:'java',args:['-DskipTests','package']}]},{id:'other',version:'9',steps:[]}]
 const options={toolsDirectory:'D:/trusted',nodeExecutable:'D:/node.exe',javaExecutable:'D:/java.exe',mavenHome:'D:/maven'}
 const after=prepareBackendChecks(before,options)
 assert.equal(before[0].steps.length,1);assert.equal(after[0].steps.length,2);assert.equal(after[0].version,'2')
 assert.deepEqual(after[1],before[1]);assert.deepEqual(after[0].steps[1],before[0].steps[0])
 assert.throws(()=>prepareBackendChecks(after,options),/ALREADY_CONFIGURED/)
})

test('后端检查提案可由当前构造器接纳，不透传旧执行上限',async()=>{
 const {prepareBackendChecks}=await import('../docs/acceptance/topic-context-completeness/scripts/prepare-backend-unit-checks.mjs')
 const {createVerificationJobCheck}=await import('../packages/dingtalk-dsh-assistant/execution-check-job.js')
 const before=[{id:'dataset-package',version:'1',steps:[{executable:'java',args:['-DskipTests','package']}]}]
 const options={toolsDirectory:tmpdir(),nodeExecutable:process.execPath,javaExecutable:java,mavenHome:tmpdir()}
 // 路径授权来自Host；此处用当前机器绝对路径验证构造器合同，不执行构建。
 options.javaExecutable=resolve(java)
 const after=prepareBackendChecks(before,options)
 assert.ok(createVerificationJobCheck({...after[0],root:tmpdir()}))
 assert.equal(after[0].timeoutMs,undefined);assert.ok(after[0].steps.every(step=>step.timeoutMs===undefined))
 for(const changed of [{...before[0],timeoutMs:1000},{...before[0],steps:[{...before[0].steps[0],timeoutMs:1000}]}])
  assert.throws(()=>prepareBackendChecks([changed],options),/EXISTING_STEPS_DIFFERENT/)
})

test('notification coverage rejects wrong suites, no tests and unproved skipped exceptions',async t=>{
 const {validateJUnitCoverage}=await import('../scripts/verify-dataset-unit-tests.mjs')
 const {createHash}=await import('node:crypto')
 const scope={taskId:'notification',stageId:'backend',repositoryId:'dataset',requestDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64)}
 const testCase=(suite,name,status='executed',reason='')=>'HOST_JUNIT_CASE:'+ [suite,name,status,reason].map(value=>Buffer.from(value).toString('base64')).join(':')
 const suite='com.ecdigit.ecdata.task.ApprovalNotificationOutboxTaskTest',policy={scope,requiredTests:[{suite,name:'dispatchRetry'}],allowedSkips:[]}
 await assert.rejects(validateJUnitCoverage('',policy,scope),/JUNIT_EXECUTED_TESTS_MISSING/)
 await assert.rejects(validateJUnitCoverage(testCase('MergePreviewCalculatorTest','merge'),policy,scope),/JUNIT_REQUIRED_COVERAGE_MISSING/)
 const skipped=testCase('VersionManageControllerPublishTest','batchPublish','skipped','requires full Spring context'),good=testCase(suite,'dispatchRetry')
 await assert.rejects(validateJUnitCoverage(good+'\n'+skipped,policy,scope),/JUNIT_SKIPPED_NOT_AUTHORIZED/)
 const root=await mkdtemp(join(tmpdir(),'dsh-skip-proof-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'alternative.json'),bytes=Buffer.from(JSON.stringify({scope,criterion:'batch publish validation',passed:true,actual:'validated',expected:'validated'}));await writeFile(path,bytes)
 policy.allowedSkips=[{suite:'VersionManageControllerPublishTest',name:'batchPublish',reason:'requires full Spring context',alternativeEvidence:{path,sha256:createHash('sha256').update(bytes).digest('hex'),criterion:'batch publish validation'}}]
 await assert.rejects(validateJUnitCoverage(good+'\n'+skipped,policy,scope),/JUNIT_SKIP_EXCEPTION_UNSUPPORTED/)
 await assert.rejects(validateJUnitCoverage(good+'\n'+skipped.replace(Buffer.from('requires full Spring context').toString('base64'),Buffer.from('different').toString('base64')),policy,scope),/JUNIT_SKIP_EXCEPTION_UNSUPPORTED/)
 await writeFile(path,'{}');await assert.rejects(validateJUnitCoverage(good+'\n'+skipped,policy,scope),/JUNIT_SKIP_EXCEPTION_UNSUPPORTED/)
 await assert.rejects(validateJUnitCoverage(good,policy,{...scope,taskId:'foreign'}),/JUNIT_SCOPE_INVALID/)
})

test('JUnit policy requires independent Host task stage repository request and candidate binding',async()=>{
 const {validateJUnitCoverage,hostVerificationScope}=await import('../scripts/verify-dataset-unit-tests.mjs')
 const scope={taskId:'task-1234',stageId:'notification',repositoryId:'dataset',requestDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64)}
 const policy={scope:{...scope},requiredTests:[{suite:'NotificationTest',name:'retry'}]}
 const output='HOST_JUNIT_CASE:'+['NotificationTest','retry','executed',''].map(s=>Buffer.from(s).toString('base64')).join(':')
 assert.throws(()=>hostVerificationScope({}),/JUNIT_HOST_SCOPE_REQUIRED/)
 await assert.rejects(validateJUnitCoverage(output,policy,undefined),/JUNIT_SCOPE_INVALID/)
 for(const key of ['taskId','stageId','repositoryId','requestDigest','candidateDigest']){
  const wrong={...scope,[key]:key.endsWith('Digest')?'c'.repeat(64):'foreign'}
  await assert.rejects(validateJUnitCoverage(output,policy,wrong),/JUNIT_SCOPE_INVALID/)
  const incomplete={...scope};delete incomplete[key]
  await assert.rejects(validateJUnitCoverage(output,{...policy,scope:incomplete},scope),/JUNIT_SCOPE_INVALID/)
 }
 assert.equal((await validateJUnitCoverage(output,policy,{...scope})).cases.length,1)
})

test('Host rejects pinned JUnit policy from another stage repository request or candidate before execution',async t=>{
 const {validateEngineeringVerificationPolicy}=await import('../packages/dingtalk-dsh-assistant/workflow-engineering.js')
 const {createHash}=await import('node:crypto')
 const root=await mkdtemp(join(tmpdir(),'dsh-host-policy-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'policy.json'),scope={taskId:'task-1234',stageId:'notification',repositoryId:'dataset',requestDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64)}
 const bytes=Buffer.from(JSON.stringify({scope:{...scope},requiredTests:[{suite:'NotificationTest',name:'retry'}]}));await writeFile(path,bytes)
 const command={args:['verify-dataset-unit-tests.mjs','--policy',path,'--policy-sha256',createHash('sha256').update(bytes).digest('hex')]}
 await validateEngineeringVerificationPolicy(command,{...scope})
 for(const key of ['taskId','stageId','repositoryId','requestDigest','candidateDigest']){
  const wrong={...scope,[key]:key.endsWith('Digest')?'c'.repeat(64):'foreign'}
  await assert.rejects(validateEngineeringVerificationPolicy(command,wrong),e=>e.code==='ENGINEERING_CHECK_SCOPE_MISMATCH')
 }
 await assert.rejects(validateEngineeringVerificationPolicy({args:['verify-dataset-unit-tests.mjs']},scope),e=>e.code==='ENGINEERING_CHECK_POLICY_REQUIRED')
 await assert.rejects(validateEngineeringVerificationPolicy(command,undefined),e=>e.code==='ENGINEERING_CHECK_SCOPE_MISMATCH')
})

test('V2 check process receives independent Host binding over ambient scope',async t=>{
 const {createVerificationJobCheck}=await import('../packages/dingtalk-dsh-assistant/execution-check-job.js')
 const root=await mkdtemp(join(tmpdir(),'dsh-host-env-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const scope={taskId:'task-1234',stageId:'notification',repositoryId:'dataset',requestDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64)}
 const check=createVerificationJobCheck({id:'host-scope',version:'1',root,executable:process.execPath,args:['-e',"const s=JSON.parse(process.env.DSH_VERIFICATION_SCOPE);if(s.taskId!=='task-1234'||s.stageId!=='notification'||s.candidateDigest!=='b'.repeat(64))process.exit(1)"]})
 const result=await check.run({files:[],candidateDigest:scope.candidateDigest},{bindingScope:scope})
 assert.equal(result.passed,true)
})
