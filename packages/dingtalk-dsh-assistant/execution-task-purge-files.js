import { readdir,lstat,realpath,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute } from 'node:path'
import { executionError } from './execution-artifacts.js'
import { checkedTaskDirectory } from './session-workspaces.js'
import { approvedPurgeTaskIds } from './execution-task-purge.js'
const planned=new WeakSet()
const fail=()=>{throw executionError('TASK_PURGE_FILE_SCOPE_INVALID')}
const strings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[]
const approvedRoot=taskId=>{if(!approvedPurgeTaskIds.includes(taskId))fail();return resolve('D:/baibu-agent/tasks',taskId)}
async function entries(directory){return readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error})}
export async function planExecutionFilePurge({taskId,directories,artifacts,requirementRef}){
 const root=approvedRoot(taskId)
 if(directories?.logicalTaskId!==taskId||resolve(directories.root)!==root||resolve(directories.work)!==join(root,'work')||resolve(directories.tmp)!==join(root,'tmp')||resolve(directories.outputs)!==join(root,'outputs'))fail()
 await checkedTaskDirectory(directories.work)
 const keep=new Set(),queue=[requirementRef],materialStrings=new Set()
 while(queue.length){const ref=queue.pop();if(keep.has(ref))continue;keep.add(ref);const value=await artifacts.read(ref);for(const child of strings(value)){materialStrings.add(child);if(/^tasks\/[a-zA-Z0-9._-]+\/sha256-[a-f0-9]{64}\.json$/.test(child)&&!keep.has(child))queue.push(child)}}
 const paths=[],protectedPaths=[]
 for(const entry of await entries(join(directories.work,'artifacts'))){
  if(!/^sha256-[a-f0-9]{64}\.json$/.test(entry.name))continue
  const ref=`tasks/${taskId}/${entry.name}`
  if(!keep.has(ref))paths.push(join(directories.work,'artifacts',entry.name));else protectedPaths.push(artifacts.locate(ref))
 }
 for(const purpose of ['execution','owner'])for(const entry of await entries(join(directories.work,taskId,purpose)))paths.push(join(directories.work,taskId,purpose,entry.name))
 // These exact scratch areas are separate from every managed ws-*/repository.
 for(const bucket of await entries(join(directories.work,'engineering'))){
  if(!bucket.isDirectory())continue
  const base=join(directories.work,'engineering',bucket.name)
  for(const entry of await entries(base))if(entry.isDirectory()&&entry.name.startsWith('ws-'))protectedPaths.push(join(base,entry.name))
  for(const area of ['checks','check-processes','local-acceptance'])for(const entry of await entries(join(base,area)))paths.push(join(base,area,entry.name))
 }
 for(const area of ['tmp','outputs'])for(const entry of await entries(directories[area])){
  const path=join(directories[area],entry.name)
  if(materialStrings.has(`${area}/${entry.name}`)||materialStrings.has(path))protectedPaths.push(path);else paths.push(path)
 }
 const plan=Object.freeze({taskId,root,paths:Object.freeze([...new Set(paths)]),protectedPaths:Object.freeze(protectedPaths)})
 planned.add(plan);return plan
}
async function validateTree(path,root){
 const pending=[path]
 // Bound filesystem reads; every entry retains the same containment, .git and link checks.
 while(pending.length){
  const batch=pending.splice(-16)
  const children=await Promise.all(batch.map(async current=>{
   const resolved=resolve(current),rel=relative(root,resolved)
   if(!rel||rel.startsWith('..')||isAbsolute(rel)||rel.split(/[\\/]/).some(part=>part.toLowerCase()==='.git'))fail()
   const entry=await lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error});if(!entry)return []
   if(entry.isSymbolicLink()||entry.isDirectory()&&resolve(await realpath(current))!==resolved)fail()
   // A regular file has no link of its own; containment follows its checked directory chain.
   return entry.isDirectory()?(await entries(current)).map(child=>join(current,child.name)):[]
  }))
  pending.push(...children.flat())
 }
}
export async function validateFilePurgePlan(plan){
 if(!planned.has(plan)||plan.root!==approvedRoot(plan.taskId))fail()
 await checkedTaskDirectory(plan.root)
 for(const path of plan.paths)await validateTree(path,plan.root)
 return true
}
export async function executeFilePurge(plan){
 await validateFilePurgePlan(plan)
 let removed=0
 for(const path of plan.paths){await validateTree(path,plan.root);await rm(path,{recursive:true,force:true});removed++}
 return {taskId:plan.taskId,removedPaths:removed,protectedPaths:plan.protectedPaths,backupsCreated:false}
}