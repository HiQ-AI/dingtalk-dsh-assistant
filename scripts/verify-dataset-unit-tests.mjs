import { spawnSync } from 'node:child_process'
import { openSync, closeSync, readFileSync } from 'node:fs'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function testArguments(mavenHome, bootJar, directory, suffix) {
  return ['-classpath', join(mavenHome, 'boot', bootJar), `-Dclassworlds.conf=${join(mavenHome, 'bin/m2.conf')}`, `-Dmaven.home=${mavenHome}`,
    `-Dmaven.multiModuleProjectDirectory=${directory}`, 'org.codehaus.plexus.classworlds.launcher.Launcher', '-q',
    '-DskipTests=false', '-Dmaven.test.skip=false', '-DskipJarEncryption', '-DfailIfNoTests=true',
    '-Dsurefire.failIfNoSpecifiedTests=true', '-Dtest=Test*,*Test,*Tests,*TestCase,!*IT,!*ITCase,!*E2ETest',
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
export async function main(args = process.argv.slice(2), directory = process.cwd()) {
  if(args.length!==4||args[0]!=='--java'||args[2]!=='--maven-home'||!isAbsolute(args[1])||!isAbsolute(args[3])) throw Error('DATASET_TEST_ARGUMENT_INVALID')
  const java=args[1],maven=args[3],boot=(await readdir(join(maven,'boot'))).filter(n=>/^plexus-classworlds-[\w.-]+\.jar$/.test(n))
  if(boot.length!==1)throw Error('DATASET_TEST_MAVEN_INVALID')
  const suffix='host-unit-'+randomUUID(),reports=join(directory,'target','surefire-reports'),proofDirectory=join(directory,'target',suffix),classes=join(proofDirectory,'verifier')
  const sharedRoot=dirname(dirname(dirname(dirname(directory))))
  if(basename(sharedRoot)!=='work'||basename(dirname(dirname(sharedRoot)))!=='tasks'||!/^task-[a-f0-9]+$/.test(basename(dirname(sharedRoot))))throw Error('DATASET_TEST_TASK_DIRECTORY_INVALID')
  await mkdir(classes,{recursive:true})
  const sharedPath=join(sharedRoot,`dataset-check-${suffix}.json`)
  const source=fileURLToPath(new URL('./LocalAcceptanceBackground.java',import.meta.url))
  const steps=[]
  const run=async(exe,argv,step)=>{
    const result=runCaptured(exe,argv,directory,proofDirectory,step);steps.push(result)
    await writeFile(sharedPath,JSON.stringify({id:`dataset-check-${suffix}`,text:'本轮后端检查原始输出及退出码；失败不代表业务已完成。',taskId:basename(dirname(sharedRoot)),candidateDirectory:directory,steps},null,2))
    console.log(JSON.stringify({step,exitCode:result.exitCode,error:result.error,firstErrors:result.firstErrors,sharedMaterial:basename(sharedPath)}))
    if(result.error||result.exitCode!==0)throw Error('DATASET_TEST_COMMAND_FAILED')
  }
  await run(join(dirname(java),process.platform==='win32'?'javac.exe':'javac'),['-encoding','UTF-8','-d',classes,source],'compile-verifier')
  await run(java,testArguments(maven,boot[0],directory,suffix),'maven-tests')
  await run(java,['-cp',classes,'LocalAcceptanceBackground','junit',reports,suffix],'verify-reports')
  const files=(await readdir(reports)).filter(name=>name.startsWith('TEST-')&&name.endsWith(`-${suffix}.xml`)).sort(),hashes={}
  for(const name of files)hashes[name]=createHash('sha256').update(await readFile(join(reports,name))).digest('hex')
  await writeFile(join(proofDirectory,'host-proof.json'),JSON.stringify({version:1,files:hashes}),{flag:'wx'})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('DATASET_TEST_NOT_PASSED');process.exitCode=1})
