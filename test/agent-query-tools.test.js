import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentQueryTools,verifyAgentEvidence,classifyAgentQueryError } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { createAgentResourceReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-resources.js'
import { createAgentDatabaseReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-database.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
const binding={kind:'message-unit',runId:'r',unitId:'u',inputVersion:1,inputDigest:'a'.repeat(64),sessionId:'s',leaseEpoch:1,sessionBound:true}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'agent-query-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'docs'));await writeFile(join(root,'docs','a.md'),'hello project\npassword: hidden\n');const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true});const capability=createAgentResourceReadCapability({resources:[{id:'docs',kind:'files',root,paths:['docs']}]});return{root,artifacts,capability}}
test('真实文件分页/搜索/红线与持久证据绑定；另一发送者/输入代际不可冒用',async t=>{
 const f=await fixture(t),scope={resourceIds:['docs'],subjectId:'person-a'}
 const tools=createAgentQueryTools({capabilities:[f.capability],resolveScope:async()=>scope,artifacts:f.artifacts}),tool=tools[0]
 const result=await tool.execute({binding,input:{},args:{resourceId:'docs',operation:'read',path:'docs/a.md'}})
 assert.match(result.result.content,/hello project/);assert.doesNotMatch(result.result.content,/hidden/)
 assert.equal((await verifyAgentEvidence({artifacts:f.artifacts,refs:[result.evidenceRef],binding,scope})).sourceRefs.length,1)
 await assert.rejects(verifyAgentEvidence({artifacts:f.artifacts,refs:[result.evidenceRef],binding:{...binding,inputVersion:2},scope}),{code:'QUERY_EVIDENCE_INVALID'})
 await verifyAgentEvidence({artifacts:f.artifacts,refs:[result.evidenceRef],binding:{...binding,inputVersion:2},allowedBindings:[binding],scope})
 await assert.rejects(verifyAgentEvidence({artifacts:f.artifacts,refs:[result.evidenceRef],binding,scope:{...scope,subjectId:'person-b'}}),{code:'QUERY_EVIDENCE_INVALID'})
 await assert.rejects(tool.execute({binding,input:{},args:{resourceId:'docs',operation:'read',path:'../secret'}}),{code:'QUERY_SCOPE_DENIED'})
 await assert.rejects(tool.execute({binding,input:{},args:{resourceId:'docs',operation:'read',path:'docs/missing'}}),{code:'QUERY_NOT_FOUND'})
 const search=await tool.execute({binding,input:{},args:{resourceId:'docs',operation:'search',query:'project'}});assert.equal(search.result.matches.length,1)
 const listing=await tool.execute({binding,input:{},args:{resourceId:'docs',operation:'list'}});assert.deepEqual(listing.result.paths,['docs/a.md'])
})
test('会话安装复用authorize execute verify，并拒绝写能力、权限漂移及伪输出',async t=>{
 const f=await fixture(t),scope={resourceIds:[]}
 const [tool]=createAgentQueryTools({capabilities:[f.capability,{effectClass:'file.write'}],resolveScope:async()=>scope,artifacts:f.artifacts})
 await assert.rejects(tool.execute({binding,args:{resourceId:'docs',operation:'list'}}),{code:'QUERY_SCOPE_DENIED'})
 assert.equal(classifyAgentQueryError({code:'QUERY_NOT_FOUND'}),'correctable');assert.equal(classifyAgentQueryError({code:'QUERY_SCOPE_DENIED'}),'fatal')
 assert.equal((await f.capability.verify({input:{resourceId:'docs'},scope:{resourceIds:['docs']},output:{sources:['fake']}})).passed,false)
})
test('内置工具可见性只由实际登记且授权的资源决定',async t=>{
 const f=await fixture(t)
 const {createAgentStatusReadCapability}=await import('../packages/dingtalk-dsh-assistant/agent-query-status.js')
 const database=createAgentDatabaseReadCapability({resources:[{id:'uat',connectionId:'alias',tables:[{schema:'public',table:'sample',columns:['id']}]}],connectDatabase:async()=>{throw Error('NOT_CALLED')}})
 const status=createAgentStatusReadCapability({resources:[{id:'health',url:'http://127.0.0.1:18998/health',fields:['status']}]})
 for(const [capability,key,id] of [[f.capability,'resourceIds','docs'],[database,'databaseIds','uat'],[status,'statusIds','health']]){
  assert.equal(capability.available({}),false)
  assert.equal(capability.available({[key]:['unregistered']}),false)
  assert.equal(capability.available({[key]:[id]}),true)
 }
})
test('数据库工具拒绝SQL与高权限身份；结构化条件值使用参数，事务只读并回滚',async()=>{
 const calls=[],resource={id:'uat',connectionId:'alias',tables:[{schema:'public',table:'sample',columns:['id','name']}]}
 let privileged=true
 const client={query:async q=>{calls.push(q);const text=typeof q==='string'?q:q.text;if(text.includes('FROM pg_roles'))return{rows:[{rolsuper:privileged,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false}]};if(text.includes('schema_write'))return{rows:[{schema_write:false,data_write:false}]};if(text==='SHOW transaction_read_only')return{rows:[{transaction_read_only:'on'}]};return{rows:[{id:1,name:'read'}]}},end:async()=>{}}
 const capability=createAgentDatabaseReadCapability({resources:[resource],connectDatabase:async()=>client}),scope={databaseIds:['uat']},input={resourceId:'uat',operation:'select',table:'public.sample',columns:['id'],filters:[{column:'name',operator:'eq',value:"'; DELETE FROM sample; --"}]}
 await assert.rejects(capability.execute({input,scope}),{code:'QUERY_DATABASE_IDENTITY_NOT_READONLY'})
 const uat=createAgentDatabaseReadCapability({resources:[{...resource,environment:'uat',identityPolicy:'host-enforced-readonly'}],connectDatabase:async()=>client})
 const uatResult=await uat.execute({input,scope});assert.equal(uatResult.transactionReadOnly,true)
 assert.equal(calls.at(-1),'ROLLBACK')
 assert.throws(()=>createAgentDatabaseReadCapability({resources:[{...resource,environment:'production',identityPolicy:'host-enforced-readonly'}],connectDatabase:async()=>client}),{code:'QUERY_DATABASE_CONFIG_INVALID'})
 await assert.rejects(uat.execute({input:{...input,operation:'delete'},scope}),{code:'QUERY_ARGUMENT_INVALID'})
 await assert.rejects(uat.execute({input:{...input,table:'public.other'},scope}),{code:'QUERY_SCOPE_DENIED'})
 privileged=false;const result=await capability.execute({input,scope});assert.equal(result.transactionReadOnly,true)
 const sql=calls.find(c=>typeof c==='object'&&c.text.startsWith('SELECT "id"'));assert.ok(sql);assert.doesNotMatch(sql.text,/DELETE/);assert.match(sql.values[0],/DELETE/);assert.equal(calls.at(-1),'ROLLBACK')
 await assert.rejects(capability.execute({input:{...input,columns:['password']},scope}),{code:'QUERY_SCOPE_DENIED'})
})

test('状态工具仅登记端点GET与标量字段，不将整份响应泄露给Agent',async()=>{
 const {createAgentStatusReadCapability}=await import('../packages/dingtalk-dsh-assistant/agent-query-status.js')
 assert.throws(()=>createAgentStatusReadCapability({resources:[{id:'bad',url:'file:///secret',fields:['status']}]}),{code:'QUERY_STATUS_CONFIG_INVALID'})
 const capability=createAgentStatusReadCapability({resources:[{id:'health',url:'http://127.0.0.1:18998/health',fields:['status']}],fetchImpl:async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return new Response(JSON.stringify({status:'ok',password:'never-expose'}))}})
 const result=await capability.execute({input:{resourceId:'health'},scope:{statusIds:['health']}})
 assert.deepEqual(result.values,{status:'ok'});assert.doesNotMatch(JSON.stringify(result),/password|never-expose/)
 await assert.rejects(capability.execute({input:{resourceId:'health'},scope:{statusIds:[]}}),{code:'QUERY_SCOPE_DENIED'})
})
test('查询中权限撤销拒绝结果；秘密分页按全文先遮盖；无匹配可继续',async t=>{
 const f=await fixture(t),scope={resourceIds:['docs'],subjectId:'p'}
 const result=await f.capability.execute({input:{resourceId:'docs',operation:'read',path:'docs/a.md',offset:24,limit:100},scope})
 assert.doesNotMatch(result.content,/hidden/)
 const empty=await f.capability.execute({input:{resourceId:'docs',operation:'search',query:'unmatched'},scope});assert.deepEqual(empty.matches,[])
 const original=f.capability.execute;f.capability.execute=async args=>{const result=await original(args);scope.resourceIds=[];return result}
 const [tool]=createAgentQueryTools({capabilities:[f.capability],resolveScope:async()=>scope,artifacts:f.artifacts})
 await assert.rejects(tool.execute({binding,args:{resourceId:'docs',operation:'list'}}),{code:'QUERY_SCOPE_CHANGED'})
})

test('工具参数Schema拒绝原始SQL和动态URL，缺工具错误不能伪造correctable',async t=>{
 const {assertSupportedJsonSchema}=await import('@deepseek-ai/dsh-tools')
 const {agentDatabaseParameters}=await import('../packages/dingtalk-dsh-assistant/agent-query-database.js')
 assert.doesNotThrow(()=>assertSupportedJsonSchema(agentDatabaseParameters))
 const f=await fixture(t),db=createAgentDatabaseReadCapability({resources:[{id:'db',connectionId:'alias',tables:[{schema:'public',table:'t',columns:['id']}]}],connectDatabase:async()=>{throw Error('must not connect')}})
 const [tool]=createAgentQueryTools({capabilities:[db],resolveScope:async()=>({databaseIds:['db']}),artifacts:f.artifacts})
 await assert.rejects(tool.execute({binding,args:{resourceId:'db',operation:'select',sql:'DELETE FROM public.t'}}),{code:'QUERY_ARGUMENT_INVALID'})
 assert.equal(classifyAgentQueryError({code:'custom',correctable:true}),'fatal')
})


test('真实Git批读取保持搜索文件分页、固定提交、遮盖及digest，200文件只启动一个cat-file',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises')
 const {executionDigest}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
 const root=await mkdtemp(join(tmpdir(),'agent-query-git-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const run=promisify(execFile),git=async(...args)=>(await run('git',['-C',root,...args],{windowsHide:true})).stdout.trim()
 await git('init');await git('config','user.name','Test');await git('config','user.email','test@example.invalid')
 await mkdir(join(root,'src'));await mkdir(join(root,'private'))
 for(let i=0;i<205;i++)await writeFile(join(root,'src',String(i).padStart(3,'0')+'.txt'),i===204?'java.version=17\npassword=java.version-secret\njava.version=21\n':'not matched\n')
 await writeFile(join(root,'private','secret.txt'),'java.version=unauthorized')
 await git('add','.');await git('commit','-m','fixture');const commit=await git('rev-parse','HEAD')
 await writeFile(join(root,'src','204.txt'),'changed working copy')
 const capability=createAgentResourceReadCapability({resources:[{id:'repo',kind:'repository',root,commit,paths:['src']}]}),scope={resourceIds:['repo']}
 const input={resourceId:'repo',operation:'search',query:'java.version',limit:2}
 const trace=join(root,'git-trace.log'),oldTrace=process.env.GIT_TRACE;process.env.GIT_TRACE=trace.replaceAll('\\','/')
 let first
 try{first=await capability.execute({input,scope})}finally{if(oldTrace===undefined)delete process.env.GIT_TRACE;else process.env.GIT_TRACE=oldTrace}
 assert.equal(first.scannedFiles,200);assert.equal(first.nextOffset,200);assert.deepEqual(first.matches,[])
 const traceText=await readFile(trace,'utf8');assert.equal((traceText.match(/built-in: git cat-file --batch/g)??[]).length,1);assert.doesNotMatch(traceText,/built-in: git show /)
 const second=await capability.execute({input:{...input,offset:first.nextOffset},scope})
 assert.equal(second.scannedFiles,5);assert.equal(second.nextOffset,null);assert.equal(second.truncatedFile,'src/204.txt')
 assert.deepEqual(second.matches.map(m=>m.line),[1,2]);assert.equal(second.matches[1].text,'password=[REDACTED]')
 assert.equal(second.matches[0].digest,executionDigest('java.version=17\npassword=java.version-secret\njava.version=21\n'))
 assert.ok(second.sources.every(ref=>ref.startsWith(`repo:${commit}:src/204.txt:`)))
 await assert.rejects(capability.execute({input,scope:{resourceIds:[]}}),{code:'QUERY_SCOPE_DENIED'})
 const abort=new AbortController();abort.abort(new Error('cancelled-test'))
 await assert.rejects(capability.execute({input,scope,signal:abort.signal}),/cancelled-test|aborted/)
})
