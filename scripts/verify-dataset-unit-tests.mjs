import { spawnSync } from 'node:child_process'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function testArguments(mavenHome, bootJar, directory, suffix) {
  return ['-classpath', join(mavenHome, 'boot', bootJar), `-Dclassworlds.conf=${join(mavenHome, 'bin/m2.conf')}`, `-Dmaven.home=${mavenHome}`,
    `-Dmaven.multiModuleProjectDirectory=${directory}`, 'org.codehaus.plexus.classworlds.launcher.Launcher', '-q',
    '-DskipTests=false', '-Dmaven.test.skip=false', '-DskipJarEncryption', '-DfailIfNoTests=true',
    '-Dsurefire.failIfNoSpecifiedTests=true', '-Dtest=MergePreviewCalculatorTest,MergeWeightAllocatorTest',
    `-Dsurefire.reportNameSuffix=${suffix}`, 'test-compile', 'org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test']
}
export async function main(args = process.argv.slice(2), directory = process.cwd()) {
  if(args.length!==4||args[0]!=='--java'||args[2]!=='--maven-home'||!isAbsolute(args[1])||!isAbsolute(args[3])) throw Error('DATASET_TEST_ARGUMENT_INVALID')
  const java=args[1],maven=args[3],boot=(await readdir(join(maven,'boot'))).filter(n=>/^plexus-classworlds-[\w.-]+\.jar$/.test(n))
  if(boot.length!==1)throw Error('DATASET_TEST_MAVEN_INVALID')
  const suffix='host-unit-'+randomUUID(),reports=join(directory,'target','surefire-reports'),proofDirectory=join(directory,'target',suffix),classes=join(proofDirectory,'verifier')
  await mkdir(classes,{recursive:true})
  const source=fileURLToPath(new URL('./LocalAcceptanceBackground.java',import.meta.url))
  const run=(exe,argv)=>{const result=spawnSync(exe,argv,{cwd:directory,windowsHide:true,shell:false,stdio:'inherit',timeout:1800000});if(result.error||result.status!==0)throw Error('DATASET_TEST_COMMAND_FAILED')}
  run(join(dirname(java),process.platform==='win32'?'javac.exe':'javac'),['-encoding','UTF-8','-d',classes,source])
  run(java,testArguments(maven,boot[0],directory,suffix))
  run(java,['-cp',classes,'LocalAcceptanceBackground','junit',reports,suffix])
  const files=['MergePreviewCalculatorTest','MergeWeightAllocatorTest'],hashes={}
  for(const name of files)hashes[name]=createHash('sha256').update(await readFile(join(reports,`TEST-com.ecdigit.ecdata.service.merge.${name}-${suffix}.xml`))).digest('hex')
  await writeFile(join(proofDirectory,'host-proof.json'),JSON.stringify({version:1,files:hashes}),{flag:'wx'})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('DATASET_TEST_NOT_PASSED');process.exitCode=1})
