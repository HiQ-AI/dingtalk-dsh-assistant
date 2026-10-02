import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentQueryTools,verifyAgentEvidence,classifyAgentQueryError } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { createAgentResourceReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-resources.js'
import { createAgentDatabaseReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-database.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { validateAgentWorkResult } from '../packages/dingtalk-dsh-assistant/agent-work.js'
const binding={kind:'message-unit',runId:'r',unitId:'u',inputVersion:1,inputDigest:'a'.repeat(64),sessionId:'s',leaseEpoch:1,sessionBound:true}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'agent-query-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'docs'));await writeFile(join(root,'docs','a.md'),'hello project\npassword: hidden\n');const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true});const capability=createAgentResourceReadCapability({resources:[{id:'docs',kind:'files',root,paths:['docs']}]});return{root,artifacts,capability}}
test('生产查询只接受实时只读副本，角色目录权限不误判；主库和可写事务均拒绝',async()=>{
 const resource={id:'production',connectionId:'slave',environment:'production',tables:[{schema:'public',table:'sample',columns:['id']}]}
 let replica=true,readonly='on',businessReads=0
 const client={async query(q){const text=typeof q==='string'?q:q.text;if(text.includes('pg_is_in_recovery'))return{rows:[{in_recovery:replica}]};if(text==='SHOW transaction_read_only')return{rows:[{transaction_read_only:readonly}]};if(typeof q==='object'){businessReads++;return{rows:[{id:1}]}}return{rows:[]}},async end(){}}
 const capability=createAgentDatabaseReadCapability({resources:[resource],connectDatabase:async()=>client}),scope={databaseIds:['production']},input={resourceId:'production',operation:'select',table:'public.sample'}
 assert.equal((await capability.execute({input,scope})).transactionReadOnly,true)
 assert.equal(businessReads,1)
 replica=false;await assert.rejects(capability.execute({input,scope}),{code:'QUERY_DATABASE_NOT_READONLY'})
 replica=true;readonly='off';await assert.rejects(capability.execute({input,scope}),{code:'QUERY_DATABASE_NOT_READONLY'})
 assert.equal(businessReads,1)
})

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
 assert.equal(classifyAgentQueryError({code:'QUERY_NOT_FOUND'}),'correctable');assert.equal(classifyAgentQueryError({code:'QUERY_SCOPE_DENIED'}),'correctable')
 assert.equal(classifyAgentQueryError({code:'QUERY_CAPACITY'}),'correctable')
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


test('查询证据使用受信任务绑定，普通消息查询不写入任务目录', async t => {
 const f=await fixture(t), writes=[],put=f.artifacts.put
 f.artifacts.put=async(value,options)=>{writes.push(options);return put(value,options)}
 const [tool]=createAgentQueryTools({capabilities:[f.capability],resolveScope:async()=>({resourceIds:['docs']}),artifacts:f.artifacts})
 await tool.execute({binding,args:{resourceId:'docs',operation:'list'}})
 assert.equal(writes[0],undefined)
 const taskBinding={kind:'task-node',taskId:'task',runId:'run',nodeRunId:'node',generation:1,inputDigest:'a'.repeat(64),sessionId:'session',leaseEpoch:1,inputRef:'sha256-'+ 'b'.repeat(64)+'.json'}
 await tool.execute({binding:taskBinding,args:{resourceId:'docs',operation:'list'}})
 assert.deepEqual(writes[1],{taskId:'task',reference:taskBinding.inputRef})
})

test('生产只读连接按显式schema调查未知表结构，数据读取仍保留表白名单',async()=>{
 const calls=[];let connected=0,replica=true;
 const resource={id:'production',connectionId:'slave',environment:'production',metadataSchemas:['public'],tables:[{schema:'public',table:'approved',columns:['id']}]};
 const client={async query(q){calls.push(q);const sql=typeof q==='string'?q:q.text;
  if(sql.includes('pg_is_in_recovery'))return{rows:[{in_recovery:replica}]};
  if(sql==='SHOW transaction_read_only')return{rows:[{transaction_read_only:'on'}]};
  if(sql.includes('information_schema.columns'))return{rows:[{column_name:'id',data_type:'character varying',is_nullable:'NO'}]};
  if(sql.includes('information_schema.tables'))return{rows:[{table_schema:'public',table_name:'process_id_temp'},{table_schema:'private',table_name:'secret'}]};
  return{rows:[]};},async end(){}};
 const capability=createAgentDatabaseReadCapability({resources:[resource],connectDatabase:async()=>{connected++;return client}}),scope={databaseIds:['production']};
 const input={resourceId:'production',operation:'columns',table:'public.process_id_temp'};
 const result=await capability.execute({input,scope});assert.equal(result.rows[0].column_name,'id');
 assert.equal((await capability.verify({input,scope,output:result})).passed,true);
 assert.deepEqual(calls.find(q=>typeof q==='object'&&q.text.includes('information_schema.columns')).values,['public','process_id_temp']);
 assert.equal((await capability.execute({input:{resourceId:'production',operation:'tables'},scope})).rows.length,1);
 assert.equal(connected,2);
 for(const input of [{resourceId:'production',operation:'select',table:'public.process_id_temp'},{resourceId:'production',operation:'columns',table:'private.secret'},{resourceId:'production',operation:'columns',table:'public.process_id_temp;DROP TABLE x'}])await assert.rejects(capability.execute({input,scope}),{code:'QUERY_SCOPE_DENIED'});
 assert.equal(connected,2);
 replica=false;await assert.rejects(capability.execute({input,scope}),{code:'QUERY_DATABASE_NOT_READONLY'});
 assert.equal(calls.filter(q=>typeof q==='object'&&q.text.includes('information_schema.columns')).length,1);
 assert.throws(()=>createAgentDatabaseReadCapability({resources:[{...resource,metadataSchemas:['public;DROP']}],connectDatabase:async()=>client}),{code:'QUERY_DATABASE_CONFIG_INVALID'});
});

test('完整结构固定操作保留schema权限及生产副本门禁，结构分页给出覆盖证明',async()=>{
 const resource={id:'production',connectionId:'slave',environment:'production',metadataSchemas:['public'],tables:[{schema:'public',table:'approved',columns:['id']}]}
 const calls=[];let replica=true,connections=0
 const client={async query(q){const sql=typeof q==='string'?q:q.text;calls.push(q);if(sql.includes('pg_is_in_recovery'))return{rows:[{in_recovery:replica}]};if(sql==='SHOW transaction_read_only')return{rows:[{transaction_read_only:'on'}]};if(typeof q==='object')return{rows:[{column_name:'id',formatted_type:'character varying(255)',column_default:null,is_nullable:'NO'},{column_name:'name'}]};return{rows:[]}},async end(){}}
 const capability=createAgentDatabaseReadCapability({resources:[resource],connectDatabase:async()=>{connections++;return client}}),scope={databaseIds:['production']}
 for(const operation of ['columns','constraints','indexes','dependencies','table_stats']) {
  const input={resourceId:'production',operation,table:'public.process_id_temp',limit:1},first=await capability.execute({input,scope})
  assert.equal(first.nextOffset,1);assert.equal(first.coverage.endOffset,1);assert.equal(first.productionReplicaVerified,true)
  const second=await capability.execute({input:{...input,offset:1},scope});assert.equal(second.nextOffset,null);assert.equal(first.coverage.queryDigest,second.coverage.queryDigest)
  assert.equal((await capability.verify({input,scope,output:first})).passed,true)
  assert.deepEqual(calls.filter(q=>typeof q==='object').at(-1).values,['public','process_id_temp'])
 }
 const columnSql=calls.find(q=>typeof q==='object'&&q.text.includes('information_schema.columns')).text
 for(const field of ['column_default','character_maximum_length','numeric_precision','is_identity','generation_expression','format_type','column_comment'])assert.ok(columnSql.includes(field))
 const before=connections
 for(const operation of ['constraints','indexes','dependencies','table_stats','select'])await assert.rejects(capability.execute({input:{resourceId:'production',operation,table:operation==='select'?'public.process_id_temp':'private.secret'},scope}),{code:'QUERY_SCOPE_DENIED'})
 assert.equal(connections,before)
 replica=false;await assert.rejects(capability.execute({input:{resourceId:'production',operation:'indexes',table:'public.process_id_temp'},scope}),{code:'QUERY_DATABASE_NOT_READONLY'})
 assert.equal(calls.filter(q=>typeof q==='object').length,10)
})

test('调查 completed 机械核对引用搜索的连续分页及截断文件，范围排除不强迫无关检索扫完',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'docs','b.md'),'hello project\nhello project again\n')
 const scope={resourceIds:['docs']},[tool]=createAgentQueryTools({capabilities:[f.capability],resolveScope:async()=>scope,artifacts:f.artifacts})
 const search={resourceId:'docs',operation:'search',query:'project',limit:1}
 const first=await tool.execute({binding,input:{},args:search}),second=await tool.execute({binding,input:{},args:{...search,offset:first.result.nextOffset}})
 assert.equal(second.result.truncatedFile,'docs/b.md')
 const base={outcome:'completed',summary:'已核验引用范围',limitations:[],question:''}
 const options={requireCompleteCoverage:true,readEvidence:ref=>f.artifacts.read(ref),verifyEvidence:async refs=>{await verifyAgentEvidence({artifacts:f.artifacts,refs,binding,scope});return true}}
 await assert.rejects(validateAgentWorkResult({...base,evidenceRefs:[first.evidenceRef]},options),{code:'AGENT_WORK_COVERAGE_INCOMPLETE'})
 await assert.rejects(validateAgentWorkResult({...base,evidenceRefs:[first.evidenceRef,second.evidenceRef]},options),{code:'AGENT_WORK_COVERAGE_INCOMPLETE'})
 const read=await tool.execute({binding,input:{},args:{resourceId:'docs',operation:'read',path:'docs/b.md'}})
 assert.equal((await validateAgentWorkResult({...base,evidenceRefs:[first.evidenceRef,second.evidenceRef,read.evidenceRef]},options)).outcome,'completed')
 const excluded={...base,evidenceRefs:[first.evidenceRef],limitations:['当前目标只核对a文件，b文件是另一业务模块，未声明全库零引用。'],coverageExclusions:[{evidenceRef:first.evidenceRef,reason:'当前目标只核对a文件，b文件是另一业务模块，未声明全库零引用。'}]}
 assert.equal((await validateAgentWorkResult(excluded,options)).outcome,'completed')
 await assert.rejects(validateAgentWorkResult({...excluded,coverageExclusions:[{evidenceRef:first.evidenceRef,reason:' '}]},options),{code:'AGENT_WORK_RESULT_INVALID'})
 await assert.rejects(validateAgentWorkResult({...excluded,coverageExclusions:[{evidenceRef:read.evidenceRef,reason:'不在引用证据中'}]},options),{code:'AGENT_WORK_RESULT_INVALID'})
 await assert.rejects(validateAgentWorkResult(excluded,{...options,verifyEvidence:async()=>false}),{code:'AGENT_WORK_EVIDENCE_INVALID'})
})

test('成功查询必须逐项引用或Host归属核验后的明确排除，原消息不能掩盖已执行分页',async t=>{
 const f=await fixture(t),scope={resourceIds:['docs']},[tool]=createAgentQueryTools({capabilities:[f.capability],resolveScope:async()=>scope,artifacts:f.artifacts})
 const page=await tool.execute({binding,input:{},args:{resourceId:'docs',operation:'read',path:'docs/a.md',limit:5}})
 const options={sourceRefs:['dws-source'],requireCompleteCoverage:true,requireExecutedQueryAccounting:true,executedQueryRefs:[page.evidenceRef],readEvidence:ref=>f.artifacts.read(ref),
  verifyEvidence:async refs=>{await verifyAgentEvidence({artifacts:f.artifacts,refs,binding,scope});return true}}
 const base={outcome:'completed',summary:'本轮查询已核验',evidenceRefs:['dws-source'],limitations:[],question:''}
 await assert.rejects(validateAgentWorkResult(base,options),{code:'AGENT_WORK_COVERAGE_INCOMPLETE'})
 await assert.rejects(validateAgentWorkResult({...base,evidenceRefs:['dws-source',page.evidenceRef]},options),{code:'AGENT_WORK_COVERAGE_INCOMPLETE'})
 const excluded={...base,limitations:['只读取开头作目录候选；当前结论仅为原消息提出的需求，未确认文件全文。'],coverageExclusions:[{evidenceRef:page.evidenceRef,reason:'只读取开头作目录候选，本文并非当前需求依据，未声明文件全文已核验。'}]}
 assert.equal((await validateAgentWorkResult(excluded,options)).outcome,'completed')
 await assert.rejects(validateAgentWorkResult(excluded,{...options,verifyEvidence:async refs=>{await verifyAgentEvidence({artifacts:f.artifacts,refs,binding:{...binding,inputVersion:2},scope});return true}}),{code:'QUERY_EVIDENCE_INVALID'})
 await assert.rejects(validateAgentWorkResult({...excluded,coverageExclusions:[{evidenceRef:'unexecuted-ref',reason:'任意材料'}]},options),{code:'AGENT_WORK_RESULT_INVALID'})
})
