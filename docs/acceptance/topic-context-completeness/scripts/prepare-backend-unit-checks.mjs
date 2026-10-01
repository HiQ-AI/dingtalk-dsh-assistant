import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 只生成待审阅的单仓 checks 提案；不接触运行 profile。 */
export function prepareBackendChecks(checks, { toolsDirectory, nodeExecutable, javaExecutable, mavenHome }) {
  if(!Array.isArray(checks)||checks.filter(c=>c.id==='dataset-package').length!==1)throw Error('BACKEND_CHECK_TARGET_INVALID')
  for(const path of [toolsDirectory,nodeExecutable,javaExecutable,mavenHome])if(!isAbsolute(path))throw Error('BACKEND_CHECK_PATH_INVALID')
  const result=structuredClone(checks),check=result.find(c=>c.id==='dataset-package')
  if(check.timeoutMs!==undefined||check.steps?.some(step=>step.timeoutMs!==undefined))throw Error('BACKEND_CHECK_EXISTING_STEPS_DIFFERENT')
  const step={executable:nodeExecutable,args:[join(toolsDirectory,'verify-dataset-unit-tests.mjs'),'--java',javaExecutable,'--maven-home',mavenHome]}
  if(check.steps?.some(s=>s.args?.includes(step.args[0])))throw Error('BACKEND_CHECK_ALREADY_CONFIGURED')
  if(!Array.isArray(check.steps)||check.steps.length!==1||!check.steps[0].args?.includes('-DskipTests')||!check.steps[0].args?.includes('package'))throw Error('BACKEND_CHECK_EXISTING_STEPS_DIFFERENT')
  check.steps=[step,...check.steps];check.version=String(Number(check.version)+1)
  if(!/^\d+$/.test(check.version))throw Error('BACKEND_CHECK_VERSION_INVALID')
  return result
}
export async function main(args=process.argv.slice(2)){
  if(args.length!==2||!args.every(isAbsolute))throw Error('BACKEND_CHECK_ARGUMENT_INVALID')
  const request=JSON.parse(await readFile(args[0],'utf8'))
  const checks=prepareBackendChecks(request.checks,request)
  const output={repository:'dataset',checks,requiredToolFiles:['verify-dataset-unit-tests.mjs','LocalAcceptanceBackground.java'],sourceChecksSha256:createHash('sha256').update(JSON.stringify(request.checks)).digest('hex')}
  await writeFile(args[1],JSON.stringify(output,null,2)+'\n',{flag:'wx'})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('BACKEND_CHECK_PROPOSAL_FAILED');process.exitCode=1})
