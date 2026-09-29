import { readFile,writeFile,rename,unlink } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import defaultYaml from 'js-yaml'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
const fail=code=>{throw Error(code)},hash=v=>createHash('sha256').update(v).digest('hex')
export const testStep=Object.freeze({executable:'D:/soft/node-v22.13.0/node.exe',args:['--test','tests/review-opinion-draft-persistence.test.cjs','tests/audit-review-draft-storage.test.cjs','tests/audit-reviewer-enhancements.test.cjs'],timeoutMs:120000})
export function planFrontendChecks(source,yaml){
 const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>value})])
 const parse=text=>{
  const maps=[],stack=[]
  const document=yaml.load(text,{schema,listener(event,state){if(event==='open')stack.push(state.position);else{const start=stack.pop();if(state.kind==='mapping')maps.push({start,end:state.position,value:state.result})}}})
  const repos=[],seen=new Set();const walk=value=>{if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);if(Array.isArray(value.repositories))for(const r of value.repositories)if(r?.id==='dataset-web')repos.push(r);for(const child of Object.values(value))walk(child)};walk(document)
  if(repos.length!==1)fail('FRONTEND_CHECK_REPOSITORY_AMBIGUOUS')
  const checks=repos[0].checks?.filter(c=>c.id==='dataset-build')
  if(checks?.length!==1)fail('FRONTEND_CHECK_TARGET_AMBIGUOUS')
  return{document,maps,check:checks[0]}
 }
 const before=parse(source),old=before.check.steps
 if(!Array.isArray(old))fail('FRONTEND_CHECK_STEPS_INVALID')
 const install={executable:testStep.executable,args:['D:/soft/node-v16.20.2/node_global/node_modules/yarn/bin/yarn.js','install','--frozen-lockfile','--non-interactive','--silent'],timeoutMs:600000}
 const build={executable:testStep.executable,args:['D:/soft/node-v16.20.2/node_global/node_modules/yarn/bin/yarn.js','run','build'],timeoutMs:1800000}
 const expected=[install,testStep,build]
 if(isDeepStrictEqual(old,expected))return{updated:source,changed:false}
 if(!isDeepStrictEqual(old,[install,build]))fail('FRONTEND_CHECK_EXISTING_STEPS_DIFFERENT')
 const locations=before.maps.filter(m=>m.value===before.check)
 if(locations.length!==1)fail('FRONTEND_CHECK_LAYOUT_UNSUPPORTED')
 const map=locations[0],lineStart=source.lastIndexOf('\n',map.start-1)+1
 const startLine=/^( *)- steps:[ \t]*\r?\n/.exec(source.slice(lineStart))
 if(!startLine)fail('FRONTEND_CHECK_LAYOUT_UNSUPPORTED')
 const at=lineStart+startLine[0].length,indent=startLine[1].length+2
 let end=at
 while(end<source.length){const next=source.indexOf('\n',end),until=next<0?source.length:next+1,line=source.slice(end,until);if(line.trim()&&/^ */.exec(line)[0].length<=indent)break;end=until}
 const newline=source.includes('\r\n')?'\r\n':'\n'
 const fragment=yaml.dump(expected,{noRefs:true,lineWidth:-1}).trimEnd().split('\n').map(line=>' '.repeat(indent+2)+line).join(newline)+newline
 const updated=source.slice(0,at)+fragment+source.slice(end),after=parse(updated)
 if(!isDeepStrictEqual(after.check.steps,expected))fail('FRONTEND_CHECK_ROUNDTRIP_INVALID')
 delete before.check.steps;delete after.check.steps
 if(!isDeepStrictEqual(before.document,after.document))fail('FRONTEND_CHECK_UNRELATED_CHANGE')
 return{updated,changed:true}
}
export async function configureFrontendChecks({mode,expectedSha256,profile='D:/dsh_home/profiles/web/cordis.patch.yml',dbPath='D:/dsh_home/workflows/runtime-v2/control.sqlite',yaml}){
 if(!['check','apply'].includes(mode)||! /^[a-f0-9]{64}$/.test(expectedSha256??''))fail('FRONTEND_CHECK_ARGUMENT_INVALID')
 yaml??=defaultYaml
 const source=await readFile(profile,'utf8')
 if(hash(source)!==expectedSha256)fail('FRONTEND_CHECK_PROFILE_CHANGED')
 const plan=planFrontendChecks(source,yaml),result={mode,changed:plan.changed,beforeSha256:hash(source),afterSha256:hash(plan.updated),writes:0,repository:'dataset-web',checkId:'dataset-build',testFiles:testStep.args.slice(1)}
 if(mode==='check')return result
 const owner=new DatabaseSync(dbPath+'.owner.sqlite');let locked=false
 const lockPath=profile+'.local-acceptance.lock'
 try{
  owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  const db=new DatabaseSync(dbPath,{readOnly:true})
  try{if(db.prepare("SELECT count(*) n FROM execution_nodes WHERE current=1 AND (status='running' OR drained=0)").get().n||db.prepare("SELECT count(*) n FROM task_owners WHERE status='running'").get().n||db.prepare("SELECT count(*) n FROM execution_effects WHERE state IN ('starting','executing','unknown')").get().n)fail('FRONTEND_CHECK_INSTANCE_NOT_DRAINED')}finally{db.close()}
  await writeFile(lockPath,JSON.stringify({pid:process.pid,expectedSha256}),{flag:'wx',mode:0o600});locked=true
  if(await readFile(profile,'utf8')!==source)fail('FRONTEND_CHECK_PROFILE_CHANGED')
  if(!plan.changed)return result
  const backupPath=profile+'.frontend-checks-'+randomUUID()+'.bak',temporary=profile+'.'+randomUUID()+'.tmp'
  await writeFile(backupPath,source,{flag:'wx',mode:0o600})
  if(await readFile(backupPath,'utf8')!==source)fail('FRONTEND_CHECK_BACKUP_INVALID')
  try{
   await writeFile(temporary,plan.updated,{flag:'wx',mode:0o600})
   if(await readFile(profile,'utf8')!==source)fail('FRONTEND_CHECK_PROFILE_CHANGED')
   await rename(temporary,profile)
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e})}
  const readback=await readFile(profile,'utf8')
  if(readback!==plan.updated||planFrontendChecks(readback,yaml).changed)fail('FRONTEND_CHECK_READBACK_FAILED')
  return{...result,backupPath,writes:2}
 }finally{if(locked)await unlink(lockPath);try{owner.exec('ROLLBACK')}catch{}owner.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [mode,flag,expectedSha256,...extra]=process.argv.slice(2)
  if(!['--check','--apply'].includes(mode)||flag!=='--expected-sha256'||extra.length)fail('FRONTEND_CHECK_ARGUMENT_INVALID')
  console.log(JSON.stringify(await configureFrontendChecks({mode:mode.slice(2),expectedSha256})))
 }catch(error){console.error(/^FRONTEND_CHECK_/.test(error.message)?error.message:'FRONTEND_CHECK_FAILED');process.exitCode=1}
}
