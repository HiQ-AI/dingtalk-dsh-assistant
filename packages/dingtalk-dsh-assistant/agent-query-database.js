import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { executionDigest, executionError } from './execution-artifacts.js'
const fail=code=>{throw executionError(code)}
const quote=value=>'"'+value.replaceAll('"','""')+'"'
const identifier=value=>typeof value==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
const metadataOperations=['constraints','indexes','dependencies','table_stats']
const metadataQueries={
 constraints:`SELECT c.conname AS constraint_name,c.contype AS constraint_type,c.conrelid::regclass::text AS table_name,
  c.confrelid::regclass::text AS referenced_table,c.convalidated AS validated,c.condeferrable AS deferrable,
  c.condeferred AS initially_deferred,pg_get_constraintdef(c.oid,true) AS definition
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid OR t.oid=c.confrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname=$1 AND t.relname=$2 ORDER BY c.conrelid,c.conname,c.oid`,
 indexes:`SELECT i.relname AS index_name,x.indisprimary AS is_primary,x.indisunique AS is_unique,
  x.indisvalid AS is_valid,x.indisready AS is_ready,pg_get_indexdef(x.indexrelid) AS definition,
  pg_get_expr(x.indpred,x.indrelid) AS predicate FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class i ON i.oid=x.indexrelid
  WHERE n.nspname=$1 AND t.relname=$2 ORDER BY i.relname`,
 dependencies:`SELECT d.deptype AS dependency_type,
  pg_describe_object(d.classid,d.objid,d.objsubid) AS dependent_object,
  pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) AS referenced_object,
  CASE WHEN d.classid='pg_class'::regclass AND d.objid=t.oid THEN 'outgoing' ELSE 'incoming' END AS direction
  FROM pg_depend d JOIN pg_class t ON (d.classid='pg_class'::regclass AND d.objid=t.oid)
   OR (d.refclassid='pg_class'::regclass AND d.refobjid=t.oid) JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname=$1 AND t.relname=$2 ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid`,
 table_stats:`SELECT n.nspname AS table_schema,t.relname AS table_name,t.relkind AS relation_kind,
  t.reltuples AS estimated_rows,t.relpages AS estimated_pages,pg_table_size(t.oid) AS table_bytes,
  pg_indexes_size(t.oid) AS index_bytes,pg_total_relation_size(t.oid) AS total_bytes,
  s.last_analyze,s.last_autoanalyze FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid=t.oid WHERE n.nspname=$1 AND t.relname=$2`,
}
const columnAttributes='column_name,ordinal_position,column_default,is_nullable,data_type,character_maximum_length,character_octet_length,numeric_precision,numeric_precision_radix,numeric_scale,datetime_precision,udt_schema,udt_name,domain_schema,domain_name,collation_schema,collation_name,is_identity,identity_generation,identity_start,identity_increment,identity_minimum,identity_maximum,identity_cycle,is_generated,generation_expression'
const columnCatalog=`information_schema.columns c JOIN pg_namespace n ON n.nspname=c.table_schema
 JOIN pg_class t ON t.relnamespace=n.oid AND t.relname=c.table_name JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname=c.column_name`
const columnProjection=`${columnAttributes},format_type(a.atttypid,a.atttypmod) AS formatted_type,col_description(t.oid,a.attnum) AS column_comment`
export const agentDatabaseParameters={type:'object',properties:{resourceId:{type:'string'},operation:{type:'string',enum:['tables','columns',...metadataOperations,'select']},table:{type:'string'},columns:{type:'array',items:{type:'string'}},filters:{type:'array',items:{type:'object',properties:{column:{type:'string'},operator:{type:'string',enum:['eq','ne','lt','lte','gt','gte','like']},value:{oneOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}]}},required:['column','operator','value'],additionalProperties:false}},limit:{type:'integer'},offset:{type:'integer'}},required:['resourceId','operation'],additionalProperties:false}
/** 凭据仅Host读取；不将连接配置或数据库错误正文交给模型。 */
export function createRegisteredPostgresConnector({credentialsPath}){
 return async resource=>{
  const connections=JSON.parse(await readFile(credentialsPath,'utf8')).connections,config=connections?.[resource.connectionId]
  if(!config)fail('QUERY_DATABASE_UNCONFIGURED')
  const client=new pg.Client({host:config.host,port:config.port,database:config.db,user:config.user,password:config.password,
   connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:8000,options:'-c default_transaction_read_only=on -c statement_timeout=8000'})
  await client.connect();return client
 }
}
export function createAgentDatabaseReadCapability({resources,connectDatabase}){
 if(!Array.isArray(resources)||typeof connectDatabase!=='function'||new Set(resources.map(r=>r.id)).size!==resources.length)fail('QUERY_DATABASE_CONFIG_INVALID')
 for(const r of resources)if(!r.id||!r.connectionId||!Array.isArray(r.tables)||!r.tables.length||r.tables.some(t=>!identifier(t.schema)||!identifier(t.table)||!Array.isArray(t.columns)||!t.columns.length||t.columns.some(c=>!identifier(c)))
  ||(r.metadataSchemas!==undefined&&(!Array.isArray(r.metadataSchemas)||!r.metadataSchemas.length||r.metadataSchemas.some(s=>!identifier(s))))
  ||(r.identityPolicy!==undefined&&(r.identityPolicy!=='host-enforced-readonly'||r.environment!=='uat'))
  ||(r.environment!==undefined&&!['uat','production'].includes(r.environment)))fail('QUERY_DATABASE_CONFIG_INVALID')
 const registry=new Map(resources.map(r=>[r.id,structuredClone(r)])),produced=new WeakSet()
 const authorize=async({input,scope})=>registry.has(input.resourceId)&&scope.databaseIds?.includes(input.resourceId)===true
 return {id:'query_readonly_database',effectClass:'read',identity:'agent-db-read-v3:'+executionDigest(resources),description:'通过Host登记连接查询数据库：tables/columns返回列的类型长度、默认值、可空、identity及generated定义；metadataSchemas内可用constraints/indexes/dependencies/table_stats读取约束、索引、直接目录依赖和估算规模（不是精确行数）。select仍只读取登记表/列。结果按offset/nextOffset分页，最多100行；不接受SQL、连接串或表达式。每次核验只读事务和生产副本身份。缺少operation是工具能力问题，不等于数据库权限不足。',parameters:agentDatabaseParameters,authorize,
  available: scope => resources.some(resource => scope?.databaseIds?.includes(resource.id)),
  async execute({input,scope,signal}){
   if(!await authorize({input,scope}))fail('QUERY_SCOPE_DENIED')
   if(!['tables','columns',...metadataOperations,'select'].includes(input.operation))fail('QUERY_ARGUMENT_INVALID')
   const resource=registry.get(input.resourceId),limit=input.limit??30,offset=input.offset??0
   if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>10000)fail('QUERY_LIMIT_INVALID')
   const metadataTable=typeof input.table==='string'?input.table.split('.'):[]
   const metadataAllowed=metadataTable.length===2&&metadataTable.every(identifier)&&resource.metadataSchemas?.includes(metadataTable[0])
   const table=resource.tables.find(t=>`${t.schema}.${t.table}`===input.table)
   if(metadataOperations.includes(input.operation)?!metadataAllowed:input.operation!=='tables'&&!table&&!(input.operation==='columns'&&metadataAllowed))fail('QUERY_SCOPE_DENIED')
   const columns=input.columns??table?.columns
   if(input.operation==='select'&&(!columns?.length||columns.length>50||columns.some(c=>!table.columns.includes(c))||(input.filters??[]).length>20||(input.filters??[]).some(f=>!table.columns.includes(f.column))))fail('QUERY_SCOPE_DENIED')
   let client
   const abort=()=>{void client?.end().catch(()=>{})}
   try{
    signal?.throwIfAborted();client=await connectDatabase(resource);signal?.addEventListener('abort',abort,{once:true});signal?.throwIfAborted()
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='8000ms'")
    const schemas=[...new Set([...resource.tables.map(t=>t.schema),...(resource.metadataSchemas??[])])]
    // 生产副本的角色目录可保留主库权限；实际不可写性由副本身份和只读事务证明。
    if(resource.environment==='production'){
     if((await client.query('SELECT pg_is_in_recovery() AS in_recovery')).rows[0]?.in_recovery!==true)fail('QUERY_DATABASE_NOT_READONLY')
    }else if(resource.identityPolicy!=='host-enforced-readonly'){
     const role=(await client.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]
     if(!role||Object.values(role).some(v=>v===true))fail('QUERY_DATABASE_IDENTITY_NOT_READONLY')
     const rights=(await client.query({text:"SELECT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($1::text[]) AND has_schema_privilege(n.oid,'CREATE')) AS schema_write, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','f') AND (has_table_privilege(c.oid,'INSERT') OR has_table_privilege(c.oid,'UPDATE') OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE') OR has_any_column_privilege(c.oid,'INSERT') OR has_any_column_privilege(c.oid,'UPDATE'))) AS data_write",values:[schemas]})).rows[0]
     if(rights.schema_write||rights.data_write)fail('QUERY_DATABASE_IDENTITY_NOT_READONLY')
    }
    if((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only!=='on')fail('QUERY_DATABASE_NOT_READONLY')
    let rows
    if(input.operation==='tables')rows=(await client.query({text:'SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema=ANY($1::text[]) ORDER BY table_schema,table_name',values:[schemas]})).rows.filter(row=>resource.metadataSchemas?.includes(row.table_schema)||resource.tables.some(t=>t.schema===row.table_schema&&t.table===row.table_name))
    else if(input.operation==='columns')rows=(await client.query(metadataAllowed
     ?{text:`SELECT ${columnProjection} FROM ${columnCatalog} WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,values:metadataTable}
     :{text:`SELECT ${columnProjection} FROM ${columnCatalog} WHERE table_schema=$1 AND table_name=$2 AND column_name=ANY($3::text[]) ORDER BY ordinal_position`,values:[table.schema,table.table,table.columns]})).rows
    else if(metadataOperations.includes(input.operation))rows=(await client.query({text:metadataQueries[input.operation],values:metadataTable})).rows
    else{
     const values=[],ops={eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>=',like:'LIKE'}
     const filters=(input.filters??[]).map(f=>{if(!Object.hasOwn(ops,f.operator))fail('QUERY_ARGUMENT_INVALID');values.push(f.value);return `${quote(f.column)} ${ops[f.operator]} $${values.length}`})
     values.push(limit+1,offset)
     const text=`SELECT ${columns.map(quote).join(',')} FROM ${quote(table.schema)}.${quote(table.table)}${filters.length?' WHERE '+filters.join(' AND '):''} LIMIT $${values.length-1} OFFSET $${values.length}`
     rows=(await client.query({text,values,queryMode:'extended'})).rows
    }
    const selected=input.operation==='select'?rows.slice(0,limit):rows.slice(offset,offset+limit)
    const nextOffset=input.operation==='select'?(rows.length>limit?offset+limit:null):(offset+limit<rows.length?offset+limit:null)
    const output={resourceId:resource.id,table:input.table??null,operation:input.operation,rows:JSON.parse(JSON.stringify(selected)),limit,offset,nextOffset,
     coverage:{kind:'database',queryDigest:executionDigest({...input,offset:0,limit:0}),offset,endOffset:offset+selected.length,nextOffset},
     observedAt:new Date().toISOString(),transactionReadOnly:true,productionReplicaVerified:resource.environment==='production'}
    if(Buffer.byteLength(JSON.stringify(output))>24000)fail('QUERY_CAPACITY')
    produced.add(output);return output
   }catch(e){if(signal?.aborted)throw e;if(e.code?.startsWith('QUERY_'))throw e;fail(e.code==='57014'?'QUERY_TIMEOUT':e.code==='42P01'?'QUERY_NOT_FOUND':e.code==='42703'?'QUERY_ARGUMENT_INVALID':e.code==='42501'?'QUERY_SCOPE_DENIED':'QUERY_DATABASE_UNAVAILABLE')}
   finally{signal?.removeEventListener('abort',abort);if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{})}}
  },
  async verify({input,scope,output}){return {passed:await authorize({input,scope})&&produced.has(output),outputDigest:executionDigest(output),sourceRefs:[`database:${input.resourceId}:${input.table??'catalog'}:${executionDigest(output)}`]}}
 }
}
