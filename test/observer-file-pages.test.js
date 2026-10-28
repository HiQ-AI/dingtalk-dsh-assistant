import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {describeTaskNodeOutput} from '../packages/dingtalk-dsh-assistant/node-output-readout.js'
import {executionError} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {writeObserverArtifactText,replaceObserverArtifactFile} from '../packages/dingtalk-dsh-assistant/observer-artifact-pages.js'
import {installObserverArtifactBindings,putObserverArtifactBinding,queryObserverArtifactBinding} from '../packages/dingtalk-dsh-assistant/observer-artifact-bindings.js'
import {installObserverTracePages} from '../packages/dingtalk-dsh-assistant/observer-trace-pages.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,writeFile,readFile,readdir,rm,copyFile,mkdir,stat,utimes} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync,spawn} from 'node:child_process'
import {openExecutionArtifacts,executionDigest,canonicalExecutionJson} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {installObserverEvidencePages,indexObserverItemEvidence,indexObserverRunEvidence,observerEvidencePage,observerEvidenceBinding} from '../packages/dingtalk-dsh-assistant/observer-evidence-pages.js'
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'observer-file-pages-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}

test('artifact pages read bounded byte ranges, preserve UTF16/hash and reject changed source or chunk',async t=>{
 const root=await temporary(t),artifacts=await openExecutionArtifacts({directory:root})
 const text='a'.repeat(4095)+'😀'+'b'.repeat(200000),value={summary:text},saved=await artifacts.put(value,{observerNodeId:'read-files',observerMessageOutput:true})
 const counts=[]
 const page=await artifacts.readObserverPage(saved.ref,'message-output',{offset:4095,limit:2,hash:executionDigest(text),requireHash:true,onRead:entry=>counts.push(entry)})
 assert.equal(page.text,'😀');assert.equal(page.hash,executionDigest(text));assert.equal(page.totalLength,text.length)
 assert(counts.filter(row=>row.kind==='text').reduce((n,row)=>n+row.bytes,0)<=16384)
 assert(counts.filter(row=>row.kind==='meta').reduce((n,row)=>n+row.bytes,0)<=8192)
 await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{offset:4096,limit:2,hash:page.hash,requireHash:true}),{code:'OBSERVER_TEXT_CURSOR_INVALID'})
 const short=await artifacts.readObserverPage(saved.ref,'message-output',{offset:4094,limit:2,hash:page.hash,requireHash:true});assert.equal(short.text,'a');assert.equal(short.nextCursor,4095)
 await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{offset:2,limit:2,requireHash:true}),{code:'OBSERVER_TEXT_CURSOR_INVALID'})
 await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{hash:'stale'}),{code:'MESSAGE_EVIDENCE_VERSION_CHANGED'})
 const names=await readdir(root),file=names.find(name=>name.endsWith('.utf16'))
 const bytes=await readFile(join(root,file));bytes[0]^=1;await writeFile(join(root,file),bytes)
 // Pick the same view whose first page was changed, independent of random view hash names.
 let rejected=0;for(const view of ['message-output','node:read-files'])try{await artifacts.readObserverPage(saved.ref,view,{limit:2})}catch(cause){if(cause.code==='OBSERVER_TEXT_INDEX_INVALID')rejected++}
 assert.equal(rejected,1)
 await writeFile(join(root,saved.ref),Buffer.from('changed'))
 await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{limit:2}),{code:'ARTIFACT_DIGEST_MISMATCH'})
})

test('SQLite evidence page fetches at most four bounded chunks and enforces recorded/snapshot/shared bindings',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)')
 installObserverEvidencePages(db)
 const text='a'.repeat(150000)+'😀'+'b'.repeat(150000)
 indexObserverRunEvidence(db,{runId:'r',snapshot:{source:{sourceKey:'source',text,sourceVersion:1}}})
 indexObserverItemEvidence(db,'other','node',{id:'shared',nodeRunId:'shared',nodeId:'IB',createdAt:'same',input:{units:[{runId:'r'}],sharedTopic:{sources:[{sourceKey:'shared',text:'Shared evidence'}]}}})
 indexObserverItemEvidence(db,'r','agent-execution',{id:'execution',resultRef:'ref',result:{evidenceRefs:['query']}})
 let bodyRows=0,bodyUnits=0;const sql=[]
 const observed={prepare(query){sql.push(query);const stmt=db.prepare(query);return {get:(...args)=>stmt.get(...args),all:(...args)=>{const rows=stmt.all(...args);if(query.includes('SELECT start,text')){bodyRows+=rows.length;bodyUnits+=rows.reduce((n,row)=>n+row.text.length,0)}return rows}}}}
 const page=observerEvidencePage(observed,{runId:'r',resourceRef:'source',offset:150000,limit:8000,hash:executionDigest(text)})
 assert.equal(page.text,text.slice(150000,158000));assert.equal(page.totalLength,text.length);assert(bodyRows<=4);assert(bodyUnits<=16384)
 assert(sql.some(query=>query.includes('start>=? AND start<=?')))
 assert.equal(observerEvidencePage(db,{runId:'r',resourceRef:'source',materialOnly:true}),null)
 assert.equal(observerEvidencePage(db,{runId:'r',resourceRef:'shared'}).text,'Shared evidence')
 assert.equal(observerEvidencePage(db,{runId:'foreign',resourceRef:'shared'}),null)
 assert.equal(observerEvidenceBinding(db,{runId:'r',resourceRef:'ref'}).kind,'output')
 assert.equal(observerEvidenceBinding(db,{runId:'foreign',resourceRef:'ref'}),null)
 assert.throws(()=>observerEvidencePage(db,{runId:'r',resourceRef:'source',offset:150001,limit:2,hash:page.hash}),{code:'MESSAGE_EVIDENCE_CURSOR_INVALID'})
 indexObserverItemEvidence(db,'r','material',{id:'material',resourceRef:'source',material:{text:'Exact recorded material'}})
 assert.equal(observerEvidencePage(db,{runId:'r',resourceRef:'source'}).text,'Exact recorded material')
 const before=db.prepare('SELECT total_changes() n').get().n
 indexObserverRunEvidence(db,{runId:'r',snapshot:{source:{sourceKey:'source',text,sourceVersion:1}}})
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before)
})

test('legacy artifacts require explicit backed-up offline indexing; default CLI is read only',async t=>{
 const root=await temporary(t),path=join(root,'ledger.sqlite'),backup=join(root,'backup.sqlite'),manifest=join(root,'manifest.json')
 const db=new DatabaseSync(path);db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)');db.close()
 const value={summary:'Legacy '.repeat(10000)},encoded=Buffer.from(canonicalExecutionJson(value)),digest=createHash('sha256').update(encoded).digest('hex'),ref=`sha256-${digest}.json`
 await writeFile(join(root,ref),encoded);await writeFile(manifest,JSON.stringify([{ref,nodeId:'read-files'}]))
 const artifacts=await openExecutionArtifacts({directory:root})
 await assert.rejects(artifacts.readObserverPage(ref,'message-output'),{code:'OBSERVER_TEXT_MIGRATION_REQUIRED'})
 const script=new URL('../scripts/migrate-observer-artifact-pages.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')
 const run=(...extra)=>spawnSync(process.execPath,[script,'--database',path,'--artifact-directory',root,'--manifest',manifest,...extra],{encoding:'utf8',timeout:15000})
 const before=await readFile(path),listing=await readdir(root)
 const dry=run();assert.equal(dry.status,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).ready,0);assert.deepEqual(await readdir(root),listing);assert.deepEqual(await readFile(path),before)
 assert.notEqual(run('--apply').status,0)
 await copyFile(path,backup);const sha=createHash('sha256').update(before).digest('hex')
 const applied=run('--apply','--backup',backup,'--expected-sha256',sha);assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).ready,1)
 assert.deepEqual(await readFile(backup),before);assert.deepEqual(await readFile(join(root,ref)),encoded)
 const migrated=new DatabaseSync(path,{readOnly:true});assert.equal(migrated.prepare('SELECT count(*) n FROM observer_artifact_page_bindings').get().n,1);migrated.close()
 const persisted=await openExecutionArtifacts({directory:root,observerPageBindings:{get:binding=>{const db=new DatabaseSync(path,{readOnly:true});try{return queryObserverArtifactBinding(db,binding)}finally{db.close()}},put:()=>{throw new Error('GET must never bind')}}})
 assert.equal((await persisted.readObserverPage(ref,'node:read-files',{offset:10000,limit:2})).text,describeTaskNodeOutput({nodeId:'read-files'},value).text.slice(10000,10002))
})


test('trusted manifest binding rejects coordinated text/hash/meta tampering and immutable EEXIST corruption',async t=>{
 const root=await temporary(t),bindings=new Map(),artifacts=await openExecutionArtifacts({directory:root,observerPageBindings:{get:({ref,view})=>bindings.get(JSON.stringify([ref,view])),put:({ref,view,root})=>bindings.set(JSON.stringify([ref,view]),root)}})
 const value={summary:'Original signed projection '.repeat(1000)},saved=await artifacts.put(value,{observerMessageOutput:true})
 const original=await readFile(join(root,saved.ref)),key=JSON.stringify([saved.ref,'message-output']),trusted=bindings.get(key)
 await writeObserverArtifactText(join(root,saved.ref),'message-output','Forged content',{},{replace:true})
 await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{hash:null,limit:2}),{code:'OBSERVER_TEXT_BINDING_MISMATCH'})
 assert.equal(bindings.get(key),trusted);assert.deepEqual(await readFile(join(root,saved.ref)),original)
 await assert.rejects(artifacts.put(value,{observerMessageOutput:true}),{code:'OBSERVER_TEXT_INDEX_CONFLICT'})
 assert.equal(bindings.get(key),trusted)
})

test('intermediate trace-only schema is not mistaken for a completed pagination migration',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE observer_trace_index(id TEXT)')
 assert.equal(installObserverTracePages(db),false)
 assert.throws(()=>installObserverTracePages(db,{migrate:true}),{code:'OBSERVER_PAGINATION_PARTIAL_SCHEMA_REQUIRES_REBUILD'})
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,1)
})


test('copied artifact indexes require explicit rebuild and trusted binding update after identity changes',async t=>{
 const root=await temporary(t),source=join(root,'source'),copied=join(root,'copied');await mkdir(source);await mkdir(copied)
 const database=join(root,'ledger.sqlite'),backup=join(root,'backup.sqlite'),manifest=join(root,'manifest.json')
 const db=new DatabaseSync(database);db.exec('CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT)');installObserverArtifactBindings(db)
 const original=await openExecutionArtifacts({directory:source,observerPageBindings:{get:args=>queryObserverArtifactBinding(db,args),put:args=>putObserverArtifactBinding(db,args)}})
 const value={summary:'Copied text '.repeat(1000)},saved=await original.put(value,{observerMessageOutput:true})
 for(const name of await readdir(source))await copyFile(join(source,name),join(copied,name))
 await utimes(join(copied,saved.ref),new Date(100000),new Date(200000))
 const copiedArtifacts=await openExecutionArtifacts({directory:copied,observerPageBindings:{get:args=>queryObserverArtifactBinding(db,args),put:()=>{throw new Error('read only')}}})
 await assert.rejects(copiedArtifacts.readObserverPage(saved.ref,'message-output'),{code:'ARTIFACT_DIGEST_MISMATCH'})
 db.close();await copyFile(database,backup);await writeFile(manifest,JSON.stringify([{ref:saved.ref}]))
 const before=await readFile(database),sha=createHash('sha256').update(before).digest('hex')
 const script=new URL('../scripts/migrate-observer-artifact-pages.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')
 const run=(...extra)=>spawnSync(process.execPath,[script,'--database',database,'--artifact-directory',copied,'--manifest',manifest,'--apply','--backup',backup,'--expected-sha256',sha,...extra],{encoding:'utf8',timeout:15000})
 assert.notEqual(run().status,0)
 const rebuilt=run('--rebuild');assert.equal(rebuilt.status,0,rebuilt.stderr);assert.equal(JSON.parse(rebuilt.stdout).ready,1)
 const migrated=new DatabaseSync(database,{readOnly:true})
 const reopened=await openExecutionArtifacts({directory:copied,observerPageBindings:{get:args=>queryObserverArtifactBinding(migrated,args),put:()=>{throw new Error('read only')}}})
 assert.equal((await reopened.readObserverPage(saved.ref,'message-output',{limit:2})).text,value.summary.slice(0,2))
 migrated.close();assert.deepEqual(await readFile(backup),before)
})

test('synthetic storage amplification is measured separately from page-read bounds',async t=>{
 const root=await temporary(t),artifacts=await openExecutionArtifacts({directory:root}),text='synthetic trace line\n'.repeat(8000)
 const saved=await artifacts.put({summary:text},{observerNodeId:'read-files',observerMessageOutput:true}),originalBytes=(await stat(join(root,saved.ref))).size
 let indexBytes=0;for(const name of await readdir(root))if(name.includes('.observer-'))indexBytes+=(await stat(join(root,name))).size
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)')
 db.prepare('INSERT INTO message_runs VALUES(?,?)').run('r',JSON.stringify({runId:'r',snapshot:{source:{sourceKey:'source',text}}}))
 const pages=()=>db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size
 const before=pages();installObserverEvidencePages(db);const after=pages()
 const filesBefore=(await readdir(root)).length;await artifacts.put({input:'No output projection requested'});const emptyDefaultIndexFiles=(await readdir(root)).length-filesBefore-1;assert.equal(emptyDefaultIndexFiles,0)
 t.diagnostic(JSON.stringify({syntheticTextUTF16Units:text.length,originalArtifactBytes:originalBytes,artifactIndexBytes:indexBytes,sqliteAllocatedBytesBefore:before,sqliteAllocatedBytesAfter:after,sqliteIndexDeltaBytes:after-before,emptyDefaultIndexFiles}))
 assert(indexBytes>0);assert(after>before)
})


test('real taskNodeOutput page path never calls whole artifact read and retains task/ref/revision gates',async t=>{
 const root=await temporary(t),actual=await openExecutionArtifacts({directory:root}),node={nodeRunId:'n',nodeId:'read-files'},value={summary:'Task output '.repeat(20000)},saved=await actual.put(value,{observerNodeId:node.nodeId});node.outputRef=saved.ref
 const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/workflow-service.js',import.meta.url),'utf8'),start=source.indexOf('  async function taskNodeOutput('),end=source.indexOf('  async function taskRuns(',start)
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
 const make=new AsyncFunction('readableTaskFamily','store','controller','artifacts','taskNodeReadoutRef','executionError','describeTaskNodeOutput','join',source.slice(start,end)+';return taskNodeOutput')
 let revision=1,owner='t',wholeReads=0,pageBytes=0,race=false
 const artifacts={...actual,read:async()=>{wholeReads++;throw new Error('Whole artifact read forbidden for a page')},readObserverPage:async(...args)=>{const page=await actual.readObserverPage(args[0],args[1],{...args[2],onRead:row=>{if(row.kind==='text')pageBytes+=row.bytes}});if(race)revision++;return page}}
 const store={query:async query=>query.kind==='task.viewRevision'?revision:query.kind==='run'?{run:{taskId:owner},nodes:[node],pendingInputCount:0}:null}
 const read=await make(async()=>({latestTaskId:'t'}),store,{taskPlan:async()=>null},artifacts,async node=>node.outputRef,executionError,describeTaskNodeOutput,join)
 const expected=describeTaskNodeOutput(node,value)
 const first=await read('t','r','n',{limit:10,outputRef:saved.ref,detailRevision:1});assert.equal(first.text,expected.text.slice(0,10));assert.equal(first.totalLength,expected.text.length);assert.equal(wholeReads,0);assert(pageBytes<=16384)
 const bytesBefore=pageBytes
 await assert.rejects(read('t','r','n',{limit:10,outputRef:'wrong'}),{code:'TASK_OUTPUT_CHANGED'})
 await assert.rejects(read('t','r','n',{limit:10,outputRef:saved.ref,detailRevision:0}),{code:'TASK_OUTPUT_CHANGED'});assert.equal(pageBytes,bytesBefore)
 owner='foreign';assert.equal(await read('t','r','n',{limit:10,outputRef:saved.ref}),null);assert.equal(pageBytes,bytesBefore)
 owner='t';race=true;await assert.rejects(read('t','r','n',{limit:10,outputRef:saved.ref}),{code:'TASK_OUTPUT_CHANGED'});assert.equal(wholeReads,0)
})


test('trusted execution-store binding survives restart and GET never writes or reconstructs it',async t=>{
 const root=await temporary(t),database=join(root,'execution.sqlite'),directory=join(root,'artifacts');await mkdir(directory)
 let store=await openExecutionStore({dbPath:database,instanceId:'first',initialize:true})
 const bindings=()=>({get:args=>store.query({kind:'observer.artifact-binding',...args}),put:args=>store.command({id:`page:${args.root}`,kind:'observer.artifact-bind',args})})
 let saved
 try{const artifacts=await openExecutionArtifacts({directory,observerPageBindings:bindings()});saved=await artifacts.put({summary:'Persistent proof '.repeat(10000)},{observerMessageOutput:true});assert.equal((await artifacts.readObserverPage(saved.ref,'message-output',{limit:2})).text,'Pe')}
 finally{await store.close()}
 store=await openExecutionStore({dbPath:database,instanceId:'first'})
 try{
  const artifacts=await openExecutionArtifacts({directory,observerPageBindings:{get:bindings().get,put:()=>{throw new Error('GET must be read only')}}})
  assert.equal((await artifacts.readObserverPage(saved.ref,'message-output',{offset:10000,limit:2})).text,'Persistent proof '.repeat(10000).slice(10000,10002))
  await writeObserverArtifactText(join(directory,saved.ref),'message-output','Forged after restart',{},{replace:true})
  await assert.rejects(artifacts.readObserverPage(saved.ref,'message-output',{limit:2}),{code:'OBSERVER_TEXT_BINDING_MISMATCH'})
 }finally{await store.close()}
})

test('legacy contextual node outputs require the same explicit context before indexed presentation',async t=>{
 const root=await temporary(t),artifacts=await openExecutionArtifacts({directory:root})
 for(const nodeId of ['prepare-workspace','prepare-generation']){
  const value={legacy:'context in effect/workflow'},saved=await artifacts.put(value,{observerNodeId:nodeId})
  await assert.rejects(artifacts.readObserverPage(saved.ref,`node:${nodeId}`),{code:'OBSERVER_TEXT_MIGRATION_REQUIRED'})
  await assert.rejects(artifacts.indexObserverPages(saved.ref,value,{nodeId}),{code:'OBSERVER_TEXT_CONTEXT_REQUIRED'})
  const context=nodeId==='prepare-workspace'?{workspace:{status:'succeeded',directory:'synthetic/work',developmentBranch:'feature/test',sourceCommit:'verified'}}:{startingPoint:{repository:'synthetic',workBranch:'feature/test'}}
  await artifacts.indexObserverPages(saved.ref,value,{nodeId,context})
  const expected=describeTaskNodeOutput({nodeId},value,context)
  assert.equal((await artifacts.readObserverPage(saved.ref,`node:${nodeId}`,{limit:8000})).text,expected.text)
 }
})


test('Windows explicit replacement retries transient denial without deleting either file',async t=>{
 const root=await temporary(t),source=join(root,'pending'),destination=join(root,'manifest');await writeFile(source,'new');await writeFile(destination,'old')
 let elapsed=0,attempts=0;const sleeps=[]
 await replaceObserverArtifactFile(source,destination,{platform:'win32',clock:()=>elapsed,wait:async ms=>{sleeps.push(ms);elapsed+=ms},renameFile:async(from,to)=>{
  attempts++;assert.equal(from,source);assert.equal(to,destination);assert.equal(await readFile(destination,'utf8'),'old');assert.equal(await readFile(source,'utf8'),'new')
  if(attempts<=3)throw Object.assign(new Error('temporary sharing violation'),{code:['EPERM','EBUSY','EACCES'][attempts-1]})
  const {rename}=await import('node:fs/promises');await rename(from,to)
 }})
 assert.equal(attempts,4);assert.deepEqual(sleeps,[25,50,100]);assert.equal(elapsed,175);assert.equal(await readFile(destination,'utf8'),'new')
})

test('replacement retry is bounded and permanent/non-Windows denials retain their original errors',async()=>{
 let elapsed=0,attempts=0;const refusal=Object.assign(new Error('persistent sharing denial'),{code:'EPERM'})
 await assert.rejects(replaceObserverArtifactFile('source','destination',{platform:'win32',clock:()=>elapsed,wait:async ms=>{elapsed+=ms},renameFile:async()=>{attempts++;throw refusal}}),cause=>cause===refusal)
 assert.equal(elapsed,1000);assert(attempts>1&&attempts<=10)
 for(const [platform,code]of [['linux','EPERM'],['win32','ENOENT']]){
  let calls=0;const cause=Object.assign(new Error('not retryable'),{code})
  await assert.rejects(replaceObserverArtifactFile('source','destination',{platform,clock:()=>0,wait:async()=>{assert.fail('unexpected retry')},renameFile:async()=>{calls++;throw cause}}),actual=>actual===cause)
  assert.equal(calls,1)
 }
})


test('Windows synthetic sharing lock releases before the bounded replacement retry',{skip:process.platform!=='win32'},async t=>{
 const root=await temporary(t),source=join(root,'pending'),destination=join(root,'manifest');await writeFile(source,'new');await writeFile(destination,'old')
 const script="$file=[System.IO.File]::Open($env:OBSERVER_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::Out.WriteLine('locked');[void][Console]::In.ReadLine()}finally{$file.Dispose()}"
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,OBSERVER_LOCK_PATH:destination},stdio:['pipe','pipe','pipe']})
 let stderr='',output='';child.stderr.on('data',chunk=>{stderr+=chunk})
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`synthetic lock process exit ${code}: ${stderr}`)))})
 try{
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('locked'))resolve()});child.once('exit',code=>{if(!output.includes('locked'))reject(new Error(`synthetic lock unavailable ${code}: ${stderr}`))})})
  const failures=[];let attempts=0
  await replaceObserverArtifactFile(source,destination,{renameFile:async(from,to)=>{
   attempts++;try{const {rename}=await import('node:fs/promises');return await rename(from,to)}catch(cause){failures.push(cause.code);child.stdin.end('\n');await exited;throw cause}
  }})
  assert(attempts>=2);assert(failures.every(code=>['EPERM','EBUSY','EACCES'].includes(code)));assert.equal(await readFile(destination,'utf8'),'new')
 }finally{if(!child.stdin.destroyed)child.stdin.end('\n');await exited}
})


test('offline evidence backfill materializes at most 32 eligible bodies before writing and skips irrelevant kinds',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)')
 const run=db.prepare('INSERT INTO message_runs VALUES(?,?)'),item=db.prepare('INSERT INTO message_items VALUES(?,?,?,?)')
 const payload='Synthetic body '.repeat(100)
 for(let i=0;i<100;i++)run.run(`r${i}`,JSON.stringify({runId:`r${i}`,...(i%2===0?{snapshot:{source:{sourceKey:`source${i}`,text:payload},quotes:['non-object legacy reference']}}:{})}))
 for(let i=0;i<400;i++)item.run('ignored'+i,'r0',i%2?'command':'unit',JSON.stringify({id:'ignored'+i,payload}))
 for(let i=0;i<65;i++){
  item.run('material'+i,'r0','material',JSON.stringify({id:'mat'+i,resourceRef:'material'+i,material:{text:payload}}))
  item.run('node'+i,'r0','node',JSON.stringify({nodeRunId:'n'+i,nodeId:'IB',input:{sharedTopic:{sources:[{sourceKey:'node-source'+i,text:payload}]}}}))
  item.run('execution'+i,'r0','agent-execution',JSON.stringify({commandId:'a'+i,resultRef:'artifact'+i,result:{evidenceRefs:['evidence'+i]}}))
  item.run('empty-node'+i,'r0','node',JSON.stringify({nodeRunId:'empty'+i,input:{payload}}))
 }
 const batches=[];let reading=false
 const observed={exec(sql){assert.equal(reading,false);return db.exec(sql)},prepare(sql){const stmt=db.prepare(sql),backfill=sql.startsWith('SELECT rowid AS sequence_id,');return {get:(...args)=>stmt.get(...args),all:(...args)=>{reading=true;try{const rows=stmt.all(...args);if(backfill)batches.push({sql,rows:rows.length});return rows}finally{reading=false}},run:(...args)=>{assert.equal(reading,false);return stmt.run(...args)},iterate(){assert.fail('must not retain a live iterator while writing index')}}}}
 installObserverEvidencePages(observed)
 assert(batches.length>2);assert(batches.every(batch=>batch.rows<=32&&batch.sql.includes('LIMIT 32')&&batch.sql.includes('rowid>? AND rowid<=?')))
 assert.equal(Math.max(...batches.map(batch=>batch.rows)),32)
 assert.equal(batches.filter(batch=>batch.sql.includes('FROM message_runs')).reduce((n,batch)=>n+batch.rows,0),50)
 assert.equal(batches.filter(batch=>batch.sql.includes('FROM message_items')).reduce((n,batch)=>n+batch.rows,0),195)
 assert.equal(db.prepare('SELECT count(*) n FROM observer_evidence_text').get().n,180)
 assert.equal(db.prepare('SELECT count(*) n FROM observer_evidence_bindings').get().n,130)
})
