import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const hash = value => createHash('sha256').update(value).digest('hex')
const block = '\n# dsh-bootstrap-maintenance: temporary resident fence\n- id: dingtalk-dsh-assistant\n  disabled: true\n'
const fail = code => { throw new Error(code) }
const targetId='dingtalk-dsh-assistant', targetName='@zzusp/dingtalk-dsh-assistant/resident'
const witnessBlock=config=>'\n# dsh-bootstrap-witness: temporary full-dispose proof\n- insert:\n    - id: dsh-bootstrap-dispose-witness\n      name: '+JSON.stringify(import.meta.url)+'\n      config: '+JSON.stringify(config)+'\n'
const witnessValid=config=>config && isAbsolute(config.evidenceDirectory??'') && Number.isSafeInteger(config.expectedPid) && config.expectedPid>0 && /^[a-f0-9-]{36}$/i.test(config.nonce??'')

export const name='dsh-bootstrap-dispose-witness'
export const inject=['loader']
export async function apply(ctx,config){
  if(!witnessValid(config) || config.expectedPid!==process.pid)fail('BOOTSTRAP_WITNESS_IDENTITY_INVALID')
  let ready=false, disposed=false
  const publish=async(kind)=>{
    const output=join(config.evidenceDirectory,`bootstrap-${kind}.json`),temporary=output+'.'+randomUUID()+'.tmp'
    await writeFile(temporary,JSON.stringify({kind,nonce:config.nonce,pid:process.pid,entryId:targetId,moduleName:targetName}),{flag:'wx',mode:0o600})
    await rename(temporary,output)
  }
  ctx.on('loader/partial-dispose',async(entry,_legacy,active)=>{
    if(!ready || disposed || active!==true || entry?.options?.id!==targetId || entry.options.name!==targetName || entry.options.disabled!==true || entry.fiber!==undefined || entry._disposing!==0)return
    disposed=true
    await publish('disposed')
  })
  await publish('ready');ready=true
}
export default {name,inject,apply}

// 只追加/删除本工具的固定末尾patch；不重新序列化包含!!js和秘密的配置。
export function bootstrapProfile(source, mode, yaml, witness) {
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind:'scalar', construct:value=>value })])
  const document = yaml.load(source, {schema})
  if (!Array.isArray(document)) fail('BOOTSTRAP_PROFILE_INVALID')
  const residents=[]
  const walk=value=>{if(!value || typeof value!=='object')return;if(value.name==='@zzusp/dingtalk-dsh-assistant/resident')residents.push(value);for(const child of Object.values(value))walk(child)}
  walk(document)
  if(residents.length!==1 || residents[0].id!=='dingtalk-dsh-assistant' || residents[0].disabled) fail('BOOTSTRAP_RESIDENT_IDENTITY_INVALID')
  if(mode==='witness'){
    if(!witnessValid(witness) || source.includes('# dsh-bootstrap-witness:'))fail('BOOTSTRAP_WITNESS_INVALID')
    return source+witnessBlock(witness)
  }
  if(mode==='disable') {
    if(source.includes('# dsh-bootstrap-maintenance:') || document.some(entry=>entry.id==='dingtalk-dsh-assistant' && entry.disabled)) fail('BOOTSTRAP_ALREADY_DISABLED')
    return source+block
  }
  if(mode!=='enable' || !source.endsWith(block)) fail('BOOTSTRAP_FENCE_CHANGED')
  let enabled=source.slice(0,-block.length)
  if(enabled.includes('# dsh-bootstrap-witness:')){
    const entries=document.flatMap(row=>Array.isArray(row.insert)?row.insert:[]).filter(row=>row.id==='dsh-bootstrap-dispose-witness')
    if(entries.length!==1 || entries[0].name!==import.meta.url || !witnessValid(entries[0].config) || !enabled.endsWith(witnessBlock(entries[0].config)))fail('BOOTSTRAP_WITNESS_CHANGED')
    enabled=enabled.slice(0,-witnessBlock(entries[0].config).length)
  }
  return enabled
}

export async function changeBootstrapProfile({profile,expectedSha256,mode,check=false,yaml,witness}) {
  const source=await readFile(profile,'utf8')
  if(hash(source)!==expectedSha256) fail('BOOTSTRAP_PROFILE_CAS')
  const next=bootstrapProfile(source,mode,yaml,witness)
  if(!check){
    // 与正式configure工具共用互斥锁，两个同SHA写者不能同时通过CAS。
    const lockPath=profile+'.local-acceptance.lock'
    try {await writeFile(lockPath,JSON.stringify({pid:process.pid,beforeSha256:expectedSha256}),{flag:'wx',mode:0o600})}
    catch(error){if(error.code==='EEXIST')fail('BOOTSTRAP_PROFILE_LOCKED');throw error}
    try {
      if(hash(await readFile(profile))!==expectedSha256)fail('BOOTSTRAP_PROFILE_CAS')
      const temporary=profile+'.bootstrap-'+randomUUID()
      try {await writeFile(temporary,next,{flag:'wx',mode:0o600});if(hash(await readFile(profile))!==expectedSha256)fail('BOOTSTRAP_PROFILE_CAS');await rename(temporary,profile)}
      finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
      if(await readFile(profile,'utf8')!==next)fail('BOOTSTRAP_PROFILE_READBACK_MISMATCH')
    } finally {await unlink(lockPath)}
  }
  return {mode,check,writes:check?0:1,beforeSha256:expectedSha256,afterSha256:hash(next)}
}

// 正式Store命令而非SQL写账。调用者必须已停止旧Host且保持profile禁用。
export async function sealBootstrapStore({openExecutionStore,dbPath,instanceId,maintenanceId,actorId}) {
  const store=await openExecutionStore({dbPath,instanceId})
  try {
    const before=await store.query({kind:'runtime.maintenance'})
    if(before.active || !before.drained)fail('BOOTSTRAP_STORE_NOT_DRAINED')
    const args={maintenanceId,actorId,reason:'首次升级离线维护：旧Host已退出，Resident配置禁用',expectedRevision:before.revision}
    await store.command({id:`${maintenanceId}:enter`,kind:'runtime.maintenance.change',args:{...args,active:true}})
    await store.command({id:`${maintenanceId}:seal`,kind:'runtime.maintenance.seal',args:{...args,expectedRevision:before.revision+1}})
    const state=await store.query({kind:'runtime.maintenance'})
    if(!state.stopPermitted || state.phase!=='stopping')fail('BOOTSTRAP_SEAL_UNCONFIRMED')
    return {mode:'bootstrap-offline',state}
  } finally {await store.close()}
}

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{profile:{type:'string'},'expected-sha256':{type:'string'},check:{type:'boolean'},installed:{type:'string'},'maintenance-id':{type:'string'},'evidence-directory':{type:'string'},'expected-pid':{type:'string'},nonce:{type:'string'}}})
  const mode=positionals[0]
  if(positionals.length!==1 || !['witness','disable','enable','seal-offline'].includes(mode) || !isAbsolute(values.profile??'') || !/^[a-f0-9]{64}$/i.test(values['expected-sha256']??''))fail('BOOTSTRAP_ARGUMENT_INVALID')
  const profile=values.profile, source=await readFile(profile,'utf8')
  if(hash(source)!==values['expected-sha256'].toLowerCase())fail('BOOTSTRAP_PROFILE_CAS')
  if(mode!=='seal-offline')return console.log(JSON.stringify(await changeBootstrapProfile({profile,expectedSha256:values['expected-sha256'].toLowerCase(),mode,check:!!values.check,yaml,witness:{evidenceDirectory:values['evidence-directory'],expectedPid:Number(values['expected-pid']),nonce:values.nonce}})))
  if(values.check || !isAbsolute(values.installed??'') || !/^deploy-[a-f0-9-]+$/i.test(values['maintenance-id']??''))fail('BOOTSTRAP_ARGUMENT_INVALID')
  bootstrapProfile(source,'enable',yaml)
  const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>value})])
  const entries=yaml.load(source,{schema}), residents=[]
  const walk=v=>{if(!v||typeof v!=='object')return;if(v.name==='@zzusp/dingtalk-dsh-assistant/resident')residents.push(v);for(const c of Object.values(v))walk(c)};walk(entries)
  const config=residents[0].config.workflow
  if(!config?.webActorId || !isAbsolute(config.dbPath??'') || !config.instanceId)fail('BOOTSTRAP_WORKFLOW_CONFIG_INVALID')
  const {openExecutionStore}=await import(pathToFileURL(join(values.installed,'execution-store.js')).href)
  console.log(JSON.stringify(await sealBootstrapStore({openExecutionStore,dbPath:config.dbPath,instanceId:config.instanceId,maintenanceId:values['maintenance-id'],actorId:config.webActorId})))
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(/^BOOTSTRAP_|^STORE_|^RUNTIME_MAINTENANCE_/.test(error.message)?error.message:'BOOTSTRAP_FAILED');process.exitCode=1})
