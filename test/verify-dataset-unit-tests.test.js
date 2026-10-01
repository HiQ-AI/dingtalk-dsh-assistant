import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { testArguments } from '../scripts/verify-dataset-unit-tests.mjs'

const bin=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin'):''
const java=join(bin,process.platform==='win32'?'java.exe':'java'),javac=join(bin,process.platform==='win32'?'javac.exe':'javac')
test('专项检查显式运行两类并禁止跳过，报告目录独立',()=>{
 const args=testArguments('D:/maven','plexus-classworlds-2.7.jar','D:/candidate','host-unit-00000000-0000-0000-0000-000000000000')
 assert.ok(args.includes('-DskipTests=false'));assert.ok(args.includes('-Dmaven.test.skip=false'))
 assert.ok(args.includes('-Dtest=MergePreviewCalculatorTest,MergeWeightAllocatorTest'))
 assert.equal(args.at(-1),'org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test')
 assert.ok(args.includes('-Dsurefire.reportNameSuffix=host-unit-00000000-0000-0000-0000-000000000000'))
})
test('JDK原生报告校验拒绝零用例、跳过、失败、缺失和伪造suite计数', {skip:process.platform!=='win32'}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'host-junit-proof-')),classes=join(root,'classes');await mkdir(classes)
 const compile=spawnSync(javac,['-encoding','UTF-8','-d',classes,resolve('scripts/LocalAcceptanceBackground.java')],{encoding:'utf8',windowsHide:true});assert.equal(compile.status,0,compile.stderr)
 const names=['MergePreviewCalculatorTest','MergeWeightAllocatorTest'],suffix='host-unit-00000000-0000-0000-0000-000000000000'
 const write=async(overrides={})=>{for(const name of names){const attrs={tests:1,failures:0,errors:0,skipped:0,...overrides};await writeFile(join(root,`TEST-com.ecdigit.ecdata.service.merge.${name}-${suffix}.xml`),`<testsuite name="com.ecdigit.ecdata.service.merge.${name}(${suffix})" ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}><testcase name="works"/></testsuite>`)}}
 const run=()=>spawnSync(java,['-cp',classes,'LocalAcceptanceBackground','junit',root,suffix],{encoding:'utf8',windowsHide:true})
 assert.notEqual(run().status,0)
 await write();const good=run();assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/"tests":2/)
 const stale=spawnSync(java,['-cp',classes,'LocalAcceptanceBackground','junit',root,'host-unit-11111111-1111-1111-1111-111111111111'],{encoding:'utf8',windowsHide:true})
 assert.notEqual(stale.status,0,'其他执行的成功报告不能复用')
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