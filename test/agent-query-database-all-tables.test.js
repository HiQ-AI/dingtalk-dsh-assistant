import test from 'node:test'
import assert from 'node:assert/strict'
import {createAgentDatabaseReadCapability} from '../packages/dingtalk-dsh-assistant/agent-query-database.js'
const resource={id:'hiq-editor-production-approval',connectionId:'existing',environment:'production',tables:[{schema:'public',table:'approval',columns:['id']}],metadataSchemas:['public'],dataAccess:'all-tables-readonly'}
const scope={databaseIds:[resource.id]}
function fixture(options={}){
 const queries=[];let connected=0
 const client={async query(q){queries.push(q);const text=typeof q==='string'?q:q.text
  if(options.code&&text.startsWith('SELECT "'))throw Object.assign(Error('DB error'),{code:options.code})
  if(text.includes('pg_is_in_recovery'))return {rows:[{in_recovery:options.replica!==false}]}
  if(text==='SHOW transaction_read_only')return {rows:[{transaction_read_only:options.readOnly===false?'off':'on'}]}
  if(text.includes('t.relkind AS relation_kind'))return {rows:[{relation_kind:options.kind??'r'}]}
  if(text.startsWith('SELECT column_name FROM information_schema.columns'))return {rows:[{column_name:'id'},{column_name:'result'},{column_name:'tenant_id'}]}
  if(text.includes('FROM information_schema.tables'))return {rows:[{table_schema:'public',table_name:'tb_impact_methods',table_type:'BASE TABLE'},{table_schema:'history',table_name:'te_version_publish_log',table_type:'BASE TABLE'}]}
  if(text.startsWith('SELECT "'))return {rows:[{id:7,result:'read only'}]}
  return {rows:[]}
 },async end(){queries.push('END')}}
 const capability=createAgentDatabaseReadCapability({resources:[options.resource??resource],connectDatabase:async()=>{connected++;if(options.connectError)throw Error('no connection');return client}})
 return {capability,queries,get connected(){return connected}}
}
for(const table of ['public.tb_impact_methods','public.tb_impact_results','history.te_version_publish_log'])test('all-table SELECT '+table,async()=>{
 const f=fixture(),input={resourceId:resource.id,operation:'select',table,columns:['id','result'],filters:[{column:'tenant_id',operator:'eq',value:"';DELETE FROM x;--"}]}
 const result=await f.capability.execute({input,scope});assert.equal(result.transactionReadOnly,true);assert.equal(result.productionReplicaVerified,true)
 const sql=f.queries.find(q=>q.text?.startsWith('SELECT "'));assert.match(sql.text,/^SELECT "id","result" FROM "/);assert.doesNotMatch(sql.text,/DELETE/);assert.equal(sql.values[0],input.filters[0].value)
 assert.ok(f.queries.includes('BEGIN READ ONLY'));assert.ok(f.queries.includes("SET LOCAL statement_timeout='8000ms'"));assert.equal(f.queries.at(-2),'ROLLBACK');assert.equal(f.queries.at(-1),'END')
})
test('all tables catalog and data have the same declared capability',async()=>{
 const f=fixture();const output=await f.capability.execute({input:{resourceId:resource.id,operation:'tables'},scope});assert.equal(output.rows.length,2);assert.match(f.capability.description,/all-tables-readonly/)
})
test('no writes arbitrary SQL functions external views or malformed projection/filter identifiers',async()=>{
 const f=fixture()
 for(const operation of ['delete','update','insert','call','ddl'])await assert.rejects(f.capability.execute({input:{resourceId:resource.id,operation,table:'public.tb_impact_results'},scope}),{code:'QUERY_ARGUMENT_INVALID'})
 for(const change of [{table:'public.x;DELETE FROM x'},{columns:['id;DROP TABLE x']},{filters:[{column:'id) OR true--',operator:'eq',value:1}]},{filters:[{column:'id',operator:'call',value:1}]}])await assert.rejects(f.capability.execute({input:{resourceId:resource.id,operation:'select',table:'public.tb_impact_results',columns:['id'],...change},scope}),{code:'QUERY_ARGUMENT_INVALID'})
 assert.equal(f.connected,0)
 for(const kind of ['v','f'])await assert.rejects(fixture({kind}).capability.execute({input:{resourceId:resource.id,operation:'select',table:'public.function_view',columns:['id']},scope}),{code:'QUERY_DATABASE_OBJECT_UNSUPPORTED'})
})
test('actual catalog checks projection and filter columns even in all-table mode',async()=>{
 for(const change of [{columns:['missing']},{filters:[{column:'missing',operator:'eq',value:1}]}])await assert.rejects(fixture().capability.execute({input:{resourceId:resource.id,operation:'select',table:'public.tb_impact_results',columns:['id'],...change},scope}),{code:'QUERY_ARGUMENT_INVALID'})
})
test('legacy metadata-only schemas do not open data or another resource',async()=>{
 const {dataAccess,...legacyResource}=resource;const f=fixture({resource:legacyResource})
 await assert.rejects(f.capability.execute({input:{resourceId:resource.id,operation:'select',table:'public.tb_impact_results',columns:['id']},scope}),{code:'QUERY_DATABASE_TABLE_UNSUPPORTED'})
 await assert.rejects(f.capability.execute({input:{resourceId:resource.id,operation:'select',table:'public.approval',columns:['result']},scope}),{code:'QUERY_DATABASE_COLUMN_UNSUPPORTED'})
 await assert.rejects(f.capability.execute({input:{resourceId:'other',operation:'tables'},scope:{databaseIds:['other']}}),{code:'QUERY_DATABASE_RESOURCE_UNSUPPORTED'});assert.equal(f.connected,0)
})
test('42501 parameter connection replica and identity failures are distinct',async()=>{
 const input={resourceId:resource.id,operation:'select',table:'public.tb_impact_results',columns:['id']}
 for(const [options,code] of [[{code:'42501'},'QUERY_DATABASE_PERMISSION_DENIED'],[{code:'28P01'},'QUERY_DATABASE_AUTH_FAILED'],[{code:'42703'},'QUERY_ARGUMENT_INVALID'],[{connectError:true},'QUERY_DATABASE_UNAVAILABLE'],[{replica:false},'QUERY_DATABASE_NOT_READONLY'],[{readOnly:false},'QUERY_DATABASE_NOT_READONLY']])await assert.rejects(fixture(options).capability.execute({input,scope}),{code})
 const f=fixture();await assert.rejects(f.capability.execute({input,scope:{databaseIds:[]}}),{code:'QUERY_SCOPE_DENIED'});assert.equal(f.connected,0)
})

test('real query tool facade validates SQL fields and never changes cancellation or identity',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {openExecutionArtifacts}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
 const {createAgentQueryTools,verifyAgentEvidence}=await import('../packages/dingtalk-dsh-assistant/agent-query-tools.js')
 const root=await mkdtemp(join(tmpdir(),'dsh-db-tool-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true}),f=fixture()
 const binding={kind:'task-owner',taskId:'task',sessionId:'owner',turnId:'turn',leaseEpoch:1,ownerEpoch:1,requirementRevision:1,inputDigest:'a'.repeat(64)}
 let active=true,actor='owner'
 const resolveScope=async({input})=>{if(!active||input.actorId!==actor)throw Object.assign(Error('current binding rejected'),{code:'QUERY_SCOPE_DENIED'});return {...scope,actorId:actor}}
 const [tool]=createAgentQueryTools({capabilities:[f.capability],resolveScope,artifacts})
 const args={resourceId:resource.id,operation:'select',table:'public.tb_impact_results',columns:['id']},input={actorId:'owner'}
 await assert.rejects(tool.execute({binding,input,args:{...args,sql:'DELETE FROM public.x'}}),{code:'QUERY_ARGUMENT_INVALID'})
 await assert.rejects(tool.execute({binding,input:{actorId:'other'},args}),{code:'QUERY_SCOPE_DENIED'});assert.equal(f.connected,0)
 const result=await tool.execute({binding,input,args});assert.ok(result.evidenceRef)
 await verifyAgentEvidence({artifacts,refs:[result.evidenceRef],binding,scope:{...scope,actorId:actor}})
 active=false;const before=f.connected
 await assert.rejects(tool.execute({binding,input,args}),{code:'QUERY_SCOPE_DENIED'});assert.equal(f.connected,before);assert.equal(active,false)
})
