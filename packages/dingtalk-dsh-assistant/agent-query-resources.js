import { readdir, lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { executionDigest, executionError } from './execution-artifacts.js'
const run = promisify(execFile)
const fail = code => { throw executionError(code) }
const safePath = path => typeof path === 'string' && path && !isAbsolute(path) && !path.split(/[\\/]/).some(p => !p || p === '..' || p === '.')
const denied = path => path.split(/[\\/]/).some(p => /^\.(?:git|secrets|env)(?:$|\.)/i.test(p) || /\.(?:pem|key|p12|pfx)$/i.test(p))
const allowed = (resource, path) => safePath(path) && !denied(path) && resource.paths.some(prefix => path === prefix || path.startsWith(prefix.replace(/\/$/,'') + '/'))
export const agentResourceReadParameters = { type:'object', properties:{resourceId:{type:'string'},operation:{type:'string',enum:['list','search','read']},path:{type:'string'},query:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['resourceId','operation'],additionalProperties:false }

/** 明确登记资料/日志/配置根或 Git 固定提交；不创建 worktree、不执行项目代码。 */
export function createAgentResourceReadCapability({ resources }) {
 if(!Array.isArray(resources)||!resources.length||new Set(resources.map(r=>r.id)).size!==resources.length)fail('QUERY_RESOURCE_CONFIG_INVALID')
 for(const r of resources)if(!r.id||!isAbsolute(r.root??'')||!Array.isArray(r.paths)||!r.paths.length||r.paths.some(p=>!safePath(p)||denied(p))||r.kind==='repository'&&!/^[a-f0-9]{40}$/.test(r.commit??'')||!['repository','files'].includes(r.kind))fail('QUERY_RESOURCE_CONFIG_INVALID')
 const registry=new Map(resources.map(r=>[r.id,structuredClone(r)]))
 const produced=new WeakSet()
 const authorize=async({input,scope})=>registry.has(input.resourceId)&&Array.isArray(scope.resourceIds)&&scope.resourceIds.includes(input.resourceId)
 async function git(resource,args,signal){try{return (await run('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',resource.root,...args],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:10000,windowsHide:true,signal,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout}catch(e){if(signal?.aborted)throw e;fail(e.killed?'QUERY_TIMEOUT':'QUERY_NOT_FOUND')}}
 // 一个受限批读取进程按需获取文件，避免每个文件启动 Git；不提前读取后续页。
 function repositoryReader(resource,signal){
  signal?.throwIfAborted()
  const child=spawn('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',resource.root,'cat-file','--batch'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'}})
  let pending=null,buffer=Buffer.alloc(0),failure=null,closed=false
  const done=new Promise(resolve=>child.once('close',resolve))
  function reject(error){failure=error;if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null}child.kill()}
  const aborted=()=>reject(signal.reason??executionError('QUERY_CANCELLED'))
  signal?.addEventListener('abort',aborted,{once:true})
  child.on('error',()=>reject(executionError('QUERY_NOT_FOUND')))
  child.stdin.on('error',()=>reject(executionError('QUERY_NOT_FOUND')))
  child.stderr.resume()
  child.on('close',()=>{closed=true;if(pending)reject(executionError('QUERY_NOT_FOUND'))})
  child.stdout.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk])
   if(!pending){reject(executionError('QUERY_NOT_FOUND'));return}
   if(pending.size===null){
    const newline=buffer.indexOf(10)
    if(newline<0){if(buffer.length>1024)reject(executionError('QUERY_NOT_FOUND'));return}
    const match=/^[a-f0-9]{40,64} blob ([0-9]+)$/.exec(buffer.subarray(0,newline).toString('ascii'))
    if(!match){reject(executionError('QUERY_NOT_FOUND'));return}
    pending.size=Number(match[1]);buffer=buffer.subarray(newline+1)
    if(pending.size>4*1024*1024){reject(executionError('QUERY_NOT_FOUND'));return}
   }
   if(buffer.length>=pending.size+1){
    if(buffer.length!==pending.size+1||buffer[pending.size]!==10){reject(executionError('QUERY_NOT_FOUND'));return}
    const content=buffer.subarray(0,pending.size).toString('utf8'),current=pending
    buffer=Buffer.alloc(0);pending=null;clearTimeout(current.timer);current.resolve(content)
   }
  })
  return {
   async read(path){
    signal?.throwIfAborted()
    if(!allowed(resource,path)||/[\r\n]/.test(path))fail('QUERY_SCOPE_DENIED')
    if(failure)throw failure
    if(closed)fail('QUERY_NOT_FOUND')
    return new Promise((resolve,rejectRead)=>{
     pending={resolve,reject:rejectRead,size:null,timer:setTimeout(()=>reject(executionError('QUERY_TIMEOUT')),10000)}
     child.stdin.write(`${resource.commit}:${path}\n`)
    })
   },
   async close(){signal?.removeEventListener('abort',aborted);if(!closed){child.stdin.end();child.kill()}await done},
  }
 }
 async function physical(resource,path){
  const base=await realpath(resource.root),target=resolve(base,path),rel=relative(base,target)
  if(rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel))fail('QUERY_SCOPE_DENIED')
  let cursor=base
  for(const piece of rel.split(sep)){cursor=resolve(cursor,piece);if((await lstat(cursor)).isSymbolicLink())fail('QUERY_SCOPE_DENIED')}
  if(await realpath(target)!==target)fail('QUERY_SCOPE_DENIED')
  return target
 }
 async function files(resource,signal){
  if(resource.kind==='repository')return (await git(resource,['ls-tree','-r','--name-only',resource.commit],signal)).split(/\r?\n/).filter(p=>allowed(resource,p)).sort()
  const found=[]
  async function walk(path){signal?.throwIfAborted();const target=await physical(resource,path),entry=await lstat(target);if(entry.isFile()){found.push(path);return}if(!entry.isDirectory())fail('QUERY_SCOPE_DENIED');for(const child of await readdir(target,{withFileTypes:true})){const name=path+'/'+child.name;if(denied(name))continue;if(child.isSymbolicLink())continue;if(found.length>=5000)fail('QUERY_CAPACITY');await walk(name)}}
  for(const path of resource.paths)await walk(path)
  return [...new Set(found)].sort()
 }
 async function read(resource,path,signal){
  if(!allowed(resource,path))fail('QUERY_SCOPE_DENIED')
  if(resource.kind==='repository')return git(resource,['show',`${resource.commit}:${path}`],signal)
  let target;try{target=await physical(resource,path)}catch(e){if(e.code==='ENOENT')fail('QUERY_NOT_FOUND');throw e}
  const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const before=await handle.stat();if(!before.isFile()||before.size>1024*1024)fail('QUERY_CAPACITY');const data=await handle.readFile();const after=await lstat(target);if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||data.length>1024*1024)fail('QUERY_SOURCE_CHANGED');return new TextDecoder('utf-8',{fatal:true}).decode(data)}finally{await handle.close()}
 }
 const redact=text=>text.replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\r\n]+/gi,'$1[REDACTED]')
 return {id:'query_project_resource',effectClass:'read',identity:'agent-resource-read-v1:'+executionDigest(resources),description:'读取Host授权的项目资料、固定提交代码、登记日志/配置；list以路径序号分页；search的offset/nextOffset是文件序号，truncatedFile需read补读；read最多16000字符，返回可信来源与版本。',parameters:agentResourceReadParameters,authorize,
  available: scope => resources.some(resource => scope?.resourceIds?.includes(resource.id)),
  async execute({input,scope,signal}){
   if(!await authorize({input,scope}))fail('QUERY_SCOPE_DENIED')
   const resource=registry.get(input.resourceId),offset=input.offset??0,limit=input.limit??(input.operation==='read'?12000:50)
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>(input.operation==='read'?16000:200))fail('QUERY_LIMIT_INVALID')
   let value,sources=[]
   if(input.operation==='read'){
    if(!input.path)fail('QUERY_ARGUMENT_INVALID')
    const content=await read(resource,input.path,signal),digest=executionDigest(content)
    const visible=redact(content)
    value={path:input.path,content:visible.slice(offset,offset+limit),offset,nextOffset:offset+limit<visible.length?offset+limit:null,digest}
    sources=[`${resource.id}:${resource.commit??digest}:${input.path}`]
   }else{
    const paths=await files(resource,signal)
    if(input.operation==='list'){const selected=paths.filter(p=>!input.path||p.startsWith(input.path));value={paths:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null};sources=[`${resource.id}:${resource.commit??executionDigest(selected)}:paths`]}
    else{
     if(typeof input.query!=='string'||!input.query||input.query.length>200)fail('QUERY_ARGUMENT_INVALID')
     const selected=paths.filter(p=>!input.path||p.startsWith(input.path)),matches=[];let bytes=0,index=offset,scanned=0,truncatedFile=null
     const reader=resource.kind==='repository'?repositoryReader(resource,signal):null
     try{for(;index<selected.length;index++){
      signal?.throwIfAborted();const path=selected[index],content=reader?await reader.read(path):await read(resource,path,signal);bytes+=Buffer.byteLength(content);scanned++
      const lines=content.split('\n'),digest=executionDigest(content)
      for(let i=0;i<lines.length;i++)if(lines[i].includes(input.query)){
       if(matches.length===limit){truncatedFile=path;break}
       matches.push({path,line:i+1,text:redact(lines[i]).slice(0,500),digest})
      }
      if(matches.length>=limit||bytes>=4*1024*1024||scanned>=200){index++;break}
     }
     }finally{await reader?.close()}
     value={matches,nextOffset:index<selected.length?index:null,scannedFiles:scanned,truncatedFile}
     sources=matches.map(m=>`${resource.id}:${resource.commit??m.digest}:${m.path}:${m.line}`);if(!sources.length)sources=[`${resource.id}:${resource.commit??executionDigest(selected.slice(offset,index))}:searched-paths`]

    }
   }
   const output={resourceId:resource.id,version:resource.commit??'observed-file-digest',...value,sources};produced.add(output);return output
  },
  async verify({input,scope,output}){return {passed:await authorize({input,scope})&&produced.has(output),outputDigest:executionDigest(output),sourceRefs:output.sources}}
 }
}
