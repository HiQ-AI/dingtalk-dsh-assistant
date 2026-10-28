import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'
import {handleRequest as currentHandler} from '../packages/dingtalk-dsh-assistant/http.js'
import {createObserverGroupPages} from '../packages/dingtalk-dsh-assistant/observer-group-pages.js'
import {createHash} from 'node:crypto'

// Serial, in-memory synthetic HTTP comparison. Never opens a ledger/profile or
// contacts a running resident. This measures API + client JSON cost, not startup,
// actual database I/O, browser rendering, or production P95.
const root=fileURLToPath(new URL('../',import.meta.url))
const arg=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1]}
const base=arg('--base')??'041277a23d443e527e67ca44272144edd2e42c38'
assert.match(base,/^[a-f0-9]{40}$/u)
const output=resolve(root,arg('--output')??'scratch/integration-evidence/observer-benchmark.json')
const helper=resolve(root,'scratch/integration-evidence/benchmark-helpers',`${base}-http.mjs`)
await mkdir(dirname(helper),{recursive:true});await mkdir(dirname(output),{recursive:true})
const baselineSource=execFileSync('git',['show',`${base}:packages/dingtalk-dsh-assistant/http.js`],{cwd:root,encoding:'utf8'})
const source=baselineSource.replace(/(from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/gu,(_,prefix,quote,spec)=>`${prefix}${quote}${pathToFileURL(resolve(root,'packages/dingtalk-dsh-assistant',spec)).href}${quote}`)
await writeFile(helper,source)
const {handleRequest:baselineHandler}=await import(pathToFileURL(helper).href)
const sourceHashes={}
for(const name of ['http.js','observer-group-pages.js','observer-message-projection.js'])sourceHashes[name]=createHash('sha256').update(await readFile(resolve(root,'packages/dingtalk-dsh-assistant',name))).digest('hex')
const serverFor=async(handler,runtime)=>{
 const server=createServer((request,response)=>Promise.resolve(handler(request,response,runtime)).catch(()=>{response.writeHead(500);response.end('{"error":"synthetic_fixture_failed"}') }))
 await new Promise(done=>server.listen(0,'127.0.0.1',done))
 return {server,url:`http://127.0.0.1:${server.address().port}`}
}
const close=async server=>{server.closeIdleConnections();await new Promise(done=>server.close(done))}
const results=[]
for(const total of [1000,10000]){
 const accesses=new Set(),body='synthetic '.repeat(103),groupId='synthetic'
 const messages=Array.from({length:total},(_,index)=>({messageId:`message-${index}`,sequence:index,messageVersion:1,sourceKind:'dingtalk',senderName:'synthetic',occurredAt:'2026-10-28T00:00:00Z',routingStatus:'pending',get text(){accesses.add(index);return body}}))
 const group={groupId,name:'synthetic',topics:[],messages,outbox:[],taskReservations:[],routeHistory:[]}
 const runtime={listGroups:()=>[group],getGroup:()=>group,listTopics:()=>[],messageProcessingSources:async()=>[],messageProcessingRequests:async()=>[],isOwnNotification:()=>false}
 let metadataReads=0,selectedContextIds=0
 const paged={...runtime,listObserverGroups:()=>[{groupId,name:'synthetic'}],observerGroupPage:createObserverGroupPages({readGroup:()=>group,readVersion:()=>1,readMetadata:()=>{metadataReads++;return {sources:[],coordinationSources:[]}},readSources:(_,items)=>{selectedContextIds+=items.length;return []},readRequests:()=>[],ownerships:()=>[],isOwnNotification:()=>false})}
 const old=await serverFor(baselineHandler,runtime),current=await serverFor(currentHandler,paged)
 const measure=async(mode)=>{
  global.gc?.();accesses.clear();const priorMetadata=metadataReads,priorContexts=selectedContextIds,start=performance.now()
  const urls=mode==='baseline'?[old.url+'/state/groups']:[current.url+'/state/groups?summary=true',current.url+`/state/groups/${groupId}/messages?offset=0&limit=10`]
  let bytes=0,value
  for(const url of urls){const response=await fetch(url);assert.equal(response.status,200);const text=await response.text();bytes+=Buffer.byteLength(text);value=JSON.parse(text)}
  const returned=mode==='baseline'?value[0].messages.length:value.items.length
  assert.equal(returned,mode==='baseline'?total:10)
  return {elapsedMs:Number((performance.now()-start).toFixed(3)),responseBytes:bytes,returnedRows:returned,residentTextFieldsAccessed:accesses.size,metadataReads:metadataReads-priorMetadata,selectedContextIds:selectedContextIds-priorContexts,requestCount:urls.length}
 }
 try{
  const oldCold=await measure('baseline'),newCold=await measure('paged'),oldWarm=[],newWarm=[]
  for(let index=0;index<5;index++){oldWarm.push(await measure('baseline'));newWarm.push(await measure('paged'))}
  const summary=items=>{const values=items.map(item=>item.elapsedMs).sort((a,b)=>a-b);return {samples:items,p50Ms:values[Math.ceil(values.length*.5)-1],p95Ms:values[Math.ceil(values.length*.95)-1]}}
  results.push({total,bodyUtf8Bytes:Buffer.byteLength(body),baseline:{cold:oldCold,warm:summary(oldWarm)},paged:{cold:newCold,warm:summary(newWarm)}})
 }finally{await close(old.server);await close(current.server)}
}
const report={generatedAt:new Date().toISOString(),node:process.version,base,baselineHttpSha256:createHash('sha256').update(baselineSource).digest('hex'),currentSourceHashes:sourceHashes,synthetic:true,onlineLedgerAccess:false,method:'serial localhost GET + response JSON parsing; 1 cold then 5 warm samples; paged includes group summary request',limitations:['Resident payloads already exist in memory; text getter accesses are not disk reads.','Empty topics/outbox/source/notification history; no production latency claim.','Cold metadata construction remains O(total); warm request reuses the metadata index.','Baseline HTTP source is fixed Git blob; its relative helper imports use the current compatible modules with these empty auxiliary histories.','P95 is the maximum of five warm samples, not a production distribution.'],results}
await writeFile(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({output,results:results.map(item=>({total:item.total,baselineBytes:item.baseline.cold.responseBytes,pagedBytes:item.paged.cold.responseBytes,baselineP50:item.baseline.warm.p50Ms,pagedP50:item.paged.warm.p50Ms}))},null,2))
