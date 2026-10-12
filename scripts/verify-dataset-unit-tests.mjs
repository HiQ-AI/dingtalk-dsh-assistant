import { spawnSync } from 'node:child_process'
import { openSync, closeSync, readFileSync } from 'node:fs'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function testArguments(mavenHome, bootJar, directory, suffix, policy) {
  return ['-classpath', join(mavenHome, 'boot', bootJar), `-Dclassworlds.conf=${join(mavenHome, 'bin/m2.conf')}`, `-Dmaven.home=${mavenHome}`,
    `-Dmaven.multiModuleProjectDirectory=${directory}`, 'org.codehaus.plexus.classworlds.launcher.Launcher', '-q',
    '-DskipTests=false', '-Dmaven.test.skip=false', '-DskipJarEncryption', '-DfailIfNoTests=true',
    '-Dsurefire.failIfNoSpecifiedTests=true', policy ? `-Dtest=${[...new Set(policy.requiredTests.map(item=>item.suite))].join(',')}` : '-Dtest=Test*,*Test,*Tests,*TestCase,!*IT,!*ITCase,!*E2ETest',
    `-Dsurefire.reportNameSuffix=${suffix}`, 'test-compile', 'org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test']
}
export function runCaptured(executable, args, directory, proofDirectory, step) {
  const stdoutPath=join(proofDirectory,`${step}.stdout.log`),stderrPath=join(proofDirectory,`${step}.stderr.log`)
  const stdout=openSync(stdoutPath,'wx'),stderr=openSync(stderrPath,'wx');let result
  try {result=spawnSync(executable,args,{cwd:directory,windowsHide:true,shell:false,stdio:['ignore',stdout,stderr]})}
  finally {closeSync(stdout);closeSync(stderr)}
  const out=readFileSync(stdoutPath,'utf8'),err=readFileSync(stderrPath,'utf8')
  return {step,exitCode:result.status,signal:result.signal,error:result.error?.code??null,
    firstErrors:(out+'\n'+err).split(/\r?\n/).filter(line=>/^\[ERROR\]|^.*(?:AssertionError|WantedButNotInvoked|COMPILATION ERROR)/.test(line)).slice(0,12),
    stdoutTail:out.slice(-6000),stderrTail:err.slice(-6000),stdout:out,stderr:err,
    stdoutPath,stderrPath,stdoutBytes:Buffer.byteLength(out),stderrBytes:Buffer.byteLength(err)}
}
export function validatePolicyScope(policy, scope) {
  const fields = ['taskId', 'stageId', 'repositoryId', 'requestDigest', 'candidateDigest']
  if (!policy || !scope || fields.some(key => typeof scope[key] !== 'string' || !scope[key]
    || policy.scope?.[key] !== scope[key]) || Object.keys(policy.scope).length !== fields.length
    || !/^[a-f0-9]{64}$/.test(scope.requestDigest) || !/^[a-f0-9]{64}$/.test(scope.candidateDigest)
    || !Array.isArray(policy.requiredTests) || !policy.requiredTests.length) throw Error('JUNIT_SCOPE_INVALID')
  return scope
}
export function hostVerificationScope(environment = process.env) {
  if (!environment.DSH_VERIFICATION_SCOPE) throw Error('JUNIT_HOST_SCOPE_REQUIRED')
  let scope
  try { scope = JSON.parse(environment.DSH_VERIFICATION_SCOPE) } catch { throw Error('JUNIT_HOST_SCOPE_REQUIRED') }
  const fields=['taskId','repositoryId','requestDigest','candidateDigest']
  if(!scope || fields.some(key=>typeof scope[key]!=='string'||!scope[key])
    || !(scope.stageId===null||typeof scope.stageId==='string'&&scope.stageId)
    || !/^[a-f0-9]{64}$/.test(scope.requestDigest)||!/^[a-f0-9]{64}$/.test(scope.candidateDigest))throw Error('JUNIT_HOST_SCOPE_REQUIRED')
  return scope
}
export async function validateJUnitCoverage(stdout, policy, scope) {
  const cases=stdout.split(/\r?\n/).filter(line=>line.startsWith('HOST_JUNIT_CASE:')).map(line=>{
    const [suite,name,status,reason]=line.slice('HOST_JUNIT_CASE:'.length).split(':').map(value=>Buffer.from(value,'base64').toString('utf8'))
    return {suite,name,status,reason}
  })
  if(!cases.some(item=>item.status==='executed'))throw Error('JUNIT_EXECUTED_TESTS_MISSING')
  if (policy) validatePolicyScope(policy, scope)
  for(const required of policy?.requiredTests??[])if(!cases.some(item=>item.suite===required.suite&&item.name===required.name&&item.status==='executed'))throw Error('JUNIT_REQUIRED_COVERAGE_MISSING')
  // No alternative-file exception: arbitrary JSON cannot establish Host provenance.
  if(policy?.allowedSkips?.length)throw Error('JUNIT_SKIP_EXCEPTION_UNSUPPORTED')
  if(cases.some(item=>item.status==='skipped'))throw Error('JUNIT_SKIPPED_NOT_AUTHORIZED')
  return {scope:policy?.scope??null,requiredTests:policy?.requiredTests??[],cases}
}

export async function main(args = process.argv.slice(2), directory = process.cwd()) {
  if(![4,8].includes(args.length)||args[0]!=='--java'||args[2]!=='--maven-home'||!isAbsolute(args[1])||!isAbsolute(args[3])) throw Error('DATASET_TEST_ARGUMENT_INVALID')
  let policy
  if(args.length===8){if(args[4]!=='--policy'||!isAbsolute(args[5])||args[6]!=='--policy-sha256'||!/^[a-f0-9]{64}$/.test(args[7]))throw Error('DATASET_TEST_POLICY_INVALID');const bytes=await readFile(args[5]);if(createHash('sha256').update(bytes).digest('hex')!==args[7])throw Error('DATASET_TEST_POLICY_INVALID');policy=JSON.parse(bytes)}
  const hostScope = policy || process.env.DSH_VERIFICATION_SCOPE ? hostVerificationScope() : undefined
  if (policy) validatePolicyScope(policy, hostScope)
  const java=args[1],maven=args[3],boot=(await readdir(join(maven,'boot'))).filter(n=>/^plexus-classworlds-[\w.-]+\.jar$/.test(n))
  if(boot.length!==1)throw Error('DATASET_TEST_MAVEN_INVALID')
  const suffix='host-unit-'+randomUUID(),reports=join(directory,'target','surefire-reports'),proofDirectory=join(directory,'target',suffix),classes=join(proofDirectory,'verifier')
  const sharedRoot=proofDirectory
  await mkdir(classes,{recursive:true})
  const sharedPath=join(sharedRoot,`dataset-check-${suffix}.json`)
  const source=fileURLToPath(new URL('./LocalAcceptanceBackground.java',import.meta.url))
  const steps=[]
  const run=async(exe,argv,step)=>{
    const result=runCaptured(exe,argv,directory,proofDirectory,step);steps.push(result)
    await writeFile(sharedPath,JSON.stringify({id:`dataset-check-${suffix}`,text:'本轮后端检查原始输出及退出码；失败不代表业务已完成。',taskId:hostScope?.taskId??null,candidateDirectory:directory,steps},null,2))
    console.log(JSON.stringify({step,exitCode:result.exitCode,error:result.error,firstErrors:result.firstErrors,sharedMaterial:basename(sharedPath)}))
    if(result.error||result.exitCode!==0)throw Error('DATASET_TEST_COMMAND_FAILED')
  }
  await run(join(dirname(java),process.platform==='win32'?'javac.exe':'javac'),['-encoding','UTF-8','-d',classes,source],'compile-verifier')
  await run(java,testArguments(maven,boot[0],directory,suffix,policy),'maven-tests')
  await run(java,['-cp',classes,'LocalAcceptanceBackground','junit',reports,suffix],'verify-reports')
  const coverage=await validateJUnitCoverage(steps.at(-1).stdout,policy,hostScope)
  const files=(await readdir(reports)).filter(name=>name.startsWith('TEST-')&&name.endsWith(`-${suffix}.xml`)).sort(),hashes={}
  for(const name of files)hashes[name]=createHash('sha256').update(await readFile(join(reports,name))).digest('hex')
  await writeFile(join(proofDirectory,'host-proof.json'),JSON.stringify({version:2,files:hashes,coverage}),{flag:'wx'})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('DATASET_TEST_NOT_PASSED');process.exitCode=1})
