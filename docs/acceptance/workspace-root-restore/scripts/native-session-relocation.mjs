import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, rename, mkdir, lstat } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { inspectSession } from '../../../../packages/dingtalk-dsh-assistant/session-persistence.js'
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const within=(root,path)=>{const part=relative(root,path);return part!== '..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part)}
const mapped=(path,sourceRoot,targetRoot)=>within(sourceRoot,path)?join(targetRoot,relative(sourceRoot,path)):path
async function backend(root,action){const ctx=new Context();try{new JsonlSessionPersistence(ctx,{root,compression:'none'});return await action(ctx.sessionPersistence)}finally{await ctx.fiber.dispose()}}
async function files(root){
 const result=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=join(root,entry.name)
  if(entry.isSymbolicLink())throw Error('NATIVE_RELOCATION_SYMLINK_REFUSED')
  if(entry.isDirectory())result.push(...await files(path))
  else if(entry.name==='session.v4.jsonl')result.push(path)
  else if(/^session\..*\.zst$/u.test(entry.name))throw Error('NATIVE_RELOCATION_COMPRESSED_LOG_REQUIRES_EXPLICIT_SUPPORT')
 }
 return result
}
/** 零写计划；只接受本次已验证的原生v4 JSONL，不猜测私有目录编码。 */
export async function planNativeRelocations({taskDataRoot,sourceRoot,targetRoot,globalRoot}){
 for(const value of [taskDataRoot,sourceRoot,targetRoot,globalRoot])if(!isAbsolute(value))throw Error('NATIVE_RELOCATION_ABSOLUTE_PATH_REQUIRED')
 sourceRoot=resolve(sourceRoot);targetRoot=resolve(targetRoot)
 const roots=[{backendRoot:globalRoot,global:true}]
 for(const entry of await readdir(join(taskDataRoot,'tasks'),{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.')){
  const path=join(taskDataRoot,'tasks',entry.name,'.dsh','sessions')
  if(await lstat(path).catch(error=>error.code==='ENOENT'?null:Promise.reject(error)))roots.push({backendRoot:path,global:false})
 }
 const records=[],ids=new Set()
 for(const item of roots)for(const sourceFile of await files(item.backendRoot)){
  const header=JSON.parse((await readFile(sourceFile,'utf8')).split('\n')[0])
  if(!header.cwd||!within(sourceRoot,header.cwd))continue
  const saved=await backend(item.backendRoot,persistence=>inspectSession(persistence,header.id))
  if(saved.meta.id!==header.id||ids.has(header.id))throw Error('NATIVE_RELOCATION_DUPLICATE_OR_INVALID_ID')
  ids.add(header.id)
  records.push({...item,sourceFile,id:header.id,header:saved.meta,events:saved.events,inheritedEventCount:saved.inheritedEventCount,eventCount:saved.events.length,eventDigest:hash(saved.events),headerDigest:hash(saved.meta),targetCwd:mapped(saved.meta.cwd,sourceRoot,targetRoot)})
 }
 return records
}
/** 调用方已停写并搬完任务metadata；留stage到全部独立核验后再由主脚本清理。 */
export async function applyNativeRelocations(records,{sourceRoot,targetRoot,stagingRoot}){
 for(const value of [sourceRoot,targetRoot,stagingRoot])if(!isAbsolute(value))throw Error('NATIVE_RELOCATION_ABSOLUTE_PATH_REQUIRED')
 const proofs=[]
 for(const record of records){
  const physicalRoot=record.global?record.backendRoot:mapped(record.backendRoot,sourceRoot,targetRoot)
  const physicalFile=record.global?record.sourceFile:mapped(record.sourceFile,sourceRoot,targetRoot)
  const original=await backend(physicalRoot,persistence=>inspectSession(persistence,record.id))
  if(hash(original.events)!==record.eventDigest||hash(original.meta)!==record.headerDigest)throw Error('NATIVE_RELOCATION_SOURCE_CHANGED')
  const targetCwd=mapped(original.meta.cwd,sourceRoot,targetRoot)
  if(targetCwd===original.meta.cwd)throw Error('NATIVE_RELOCATION_NO_CWD_CHANGE')
  await mkdir(stagingRoot,{recursive:true})
  const stage=join(stagingRoot,`${record.id}-${randomUUID()}`)
  await rename(dirname(physicalFile),stage)
  await backend(physicalRoot,async persistence=>{
   const writer=await persistence.create({...original.meta,cwd:targetCwd},{inheritedEventCount:original.inheritedEventCount})
   try{
    await writer.append(original.events)
    let seq=original.events.at(-1)?.seq??-1
    const oldWorkingDirectory=original.events.findLast(event=>event.type==='working-directory/change')?.data.cwd
    if(oldWorkingDirectory&&within(sourceRoot,oldWorkingDirectory))await writer.append([{seq:++seq,type:'working-directory/change',time:Date.now(),data:{cwd:mapped(oldWorkingDirectory,sourceRoot,targetRoot)}}])
    await writer.append([{seq:++seq,type:'plugin:dingtalk/workspace-root-migration',time:Date.now(),ignorable:true,data:{version:1,sourceRoot,targetRoot,sourceHeaderDigest:record.headerDigest,originalEventCount:record.eventCount,originalEventDigest:record.eventDigest}}])
    await writer.flush()
   }finally{await writer.close()}
   const saved=await inspectSession(persistence,record.id)
   if(saved.meta.cwd!==targetCwd||hash(saved.events.slice(0,record.eventCount))!==record.eventDigest)throw Error('NATIVE_RELOCATION_READBACK_MISMATCH')
   proofs.push({sessionId:record.id,cwd:targetCwd,originalEventCount:record.eventCount,originalEventDigest:record.eventDigest,newEventCount:saved.events.length,backendRoot:physicalRoot,stage})
  })
 }
 return proofs
}
