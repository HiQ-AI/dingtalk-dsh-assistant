import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { executionDigest, executionError } from './execution-artifacts.js'
const fail=code=>{throw executionError(code)}
const quote=value=>'"'+value.replaceAll('"','""')+'"'
const identifier=value=>typeof value==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
export const agentDatabaseParameters={type:'object',properties:{resourceId:{type:'string'},operation:{type:'string',enum:['tables','columns','select']},table:{type:'string'},columns:{type:'array',items:{type:'string'}},filters:{type:'array',items:{type:'object',properties:{column:{type:'string'},operator:{type:'string',enum:['eq','ne','lt','lte','gt','gte','like']},value:{oneOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}]}},required:['column','operator','value'],additionalProperties:false}},limit:{type:'integer'},offset:{type:'integer'}},required:['resourceId','operation'],additionalProperties:false}
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
  ||(r.identityPolicy!==undefined&&(r.identityPolicy!=='host-enforced-readonly'||r.environment!=='uat'))
  ||(r.environment!==undefined&&!['uat','production'].includes(r.environment)))fail('QUERY_DATABASE_CONFIG_INVALID')
 const registry=new Map(resources.map(r=>[r.id,structuredClone(r)])),produced=new WeakSet()
 const authorize=async({input,scope})=>registry.has(input.resourceId)&&scope.databaseIds?.includes(input.resourceId)===true
 return {id:'query_readonly_database',effectClass:'read',identity:'agent-db-read-v2:'+executionDigest(resources),description:'查询Host登记数据库的明确表/列，按结构化条件读取最多100行；不接受SQL、连接串或表达式。每次核验只读事务；默认检查只读角色，显式UAT资源由Host约束现有账号。',parameters:agentDatabaseParameters,authorize,
  available: scope => resources.some(resource => scope?.databaseIds?.includes(resource.id)),
  async execute({input,scope,signal}){
   if(!await authorize({input,scope}))fail('QUERY_SCOPE_DENIED')
   if(!['tables','columns','select'].includes(input.operation))fail('QUERY_ARGUMENT_INVALID')
   const resource=registry.get(input.resourceId),limit=input.limit??30,offset=input.offset??0
   if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>10000)fail('QUERY_LIMIT_INVALID')
   const table=resource.tables.find(t=>`${t.schema}.${t.table}`===input.table)
   if(input.operation!=='tables'&&!table)fail('QUERY_SCOPE_DENIED')
   const columns=input.columns??table?.columns
   if(input.operation==='select'&&(!columns?.length||columns.length>50||columns.some(c=>!table.columns.includes(c))||(input.filters??[]).length>20||(input.filters??[]).some(f=>!table.columns.includes(f.column))))fail('QUERY_SCOPE_DENIED')
   let client
   const abort=()=>{void client?.end().catch(()=>{})}
   try{
    signal?.throwIfAborted();client=await connectDatabase(resource);signal?.addEventListener('abort',abort,{once:true});signal?.throwIfAborted()
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='8000ms'")
    const schemas=[...new Set(resource.tables.map(t=>t.schema))]
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
    if(input.operation==='tables')rows=(await client.query({text:'SELECT table_schema,table_name,table_type FROM information_schema.tables WHERE table_schema=ANY($1::text[]) ORDER BY table_schema,table_name',values:[schemas]})).rows.filter(row=>resource.tables.some(t=>t.schema===row.table_schema&&t.table===row.table_name))
    else if(input.operation==='columns')rows=(await client.query({text:'SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=ANY($3::text[]) ORDER BY ordinal_position',values:[table.schema,table.table,table.columns]})).rows
    else{
     const values=[],ops={eq:'=',ne:'<>',lt:'<',lte:'<=',gt:'>',gte:'>=',like:'LIKE'}
     const filters=(input.filters??[]).map(f=>{if(!Object.hasOwn(ops,f.operator))fail('QUERY_ARGUMENT_INVALID');values.push(f.value);return `${quote(f.column)} ${ops[f.operator]} $${values.length}`})
     values.push(limit,offset)
     const text=`SELECT ${columns.map(quote).join(',')} FROM ${quote(table.schema)}.${quote(table.table)}${filters.length?' WHERE '+filters.join(' AND '):''} LIMIT $${values.length-1} OFFSET $${values.length}`
     rows=(await client.query({text,values,queryMode:'extended'})).rows
    }
    const output={resourceId:resource.id,table:input.table??null,operation:input.operation,rows:JSON.parse(JSON.stringify(rows)),limit,offset,observedAt:new Date().toISOString(),transactionReadOnly:true}
    if(Buffer.byteLength(JSON.stringify(output))>24000)fail('QUERY_CAPACITY')
    produced.add(output);return output
   }catch(e){if(signal?.aborted)throw e;if(e.code?.startsWith('QUERY_'))throw e;fail(e.code==='57014'?'QUERY_TIMEOUT':e.code==='42P01'?'QUERY_NOT_FOUND':e.code==='42703'?'QUERY_ARGUMENT_INVALID':e.code==='42501'?'QUERY_SCOPE_DENIED':'QUERY_DATABASE_UNAVAILABLE')}
   finally{signal?.removeEventListener('abort',abort);if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{})}}
  },
  async verify({input,scope,output}){return {passed:await authorize({input,scope})&&produced.has(output),outputDigest:executionDigest(output),sourceRefs:[`database:${input.resourceId}:${input.table??'catalog'}:${executionDigest(output)}`]}}
 }
}
