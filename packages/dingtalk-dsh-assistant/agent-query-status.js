import { validateRuntimeResource, readRuntimeResource } from './agent-query-runtime.js'
import { executionDigest, executionError } from './execution-artifacts.js'
const fail=code=>{throw executionError(code)}
/** 只允许Host登记的GET状态端点与字段投影，URL/请求头不由模型决定。 */
export function createAgentStatusReadCapability({resources,fetchImpl=fetch,execFileImpl}){
 if(!Array.isArray(resources)||new Set(resources.map(r=>r.id)).size!==resources.length)fail('QUERY_STATUS_CONFIG_INVALID')
 for(const r of resources){if(r.kind==='kubernetes'){validateRuntimeResource(r);continue}const url=new URL(r.url);if(!r.id||url.username||url.password||url.search||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))||!Array.isArray(r.fields)||!r.fields.length||r.fields.some(f=>!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(f)))fail('QUERY_STATUS_CONFIG_INVALID')}
 const registry=new Map(resources.map(r=>[r.id,structuredClone(r)])),produced=new WeakSet()
 const authorize=async({input,scope})=>registry.has(input.resourceId)&&scope.statusIds?.includes(input.resourceId)===true
 return{id:'query_runtime_status',effectClass:'read',identity:'agent-runtime-status-v1:'+executionDigest(resources),description:'读取Host登记的项目运行状态/版本端点，只返回授权字段；不执行变更或任意URL访问。',parameters:{type:'object',properties:{resourceId:{type:'string'}},required:['resourceId'],additionalProperties:false},authorize,
  available: scope => resources.some(resource => scope?.statusIds?.includes(resource.id)),
  async execute({input,scope,signal}){
   if(!await authorize({input,scope}))fail('QUERY_SCOPE_DENIED')
   const resource=registry.get(input.resourceId)
   if(resource.kind==='kubernetes'){const values=await readRuntimeResource(resource,{signal,execFileImpl});const output={resourceId:resource.id,values,observedAt:new Date().toISOString()};produced.add(output);return output}
   const response=await fetchImpl(resource.url,{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)})
   if(!response.ok)fail('QUERY_STATUS_UNAVAILABLE')
   const reader=response.body.getReader();let size=0;const chunks=[]
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();fail('QUERY_CAPACITY')}chunks.push(value)}}finally{reader.releaseLock()}
   let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail('QUERY_STATUS_INVALID')}
   const values={};for(const field of resource.fields){let value=parsed;for(const key of field.split('.'))value=value&&Object.hasOwn(value,key)?value[key]:undefined;if(value!==undefined){if(value!==null&&typeof value==='object')fail('QUERY_STATUS_PROJECTION_INVALID');values[field]=value}}
   const output={resourceId:resource.id,values,observedAt:new Date().toISOString()};produced.add(output);return output
  },
  async verify({input,scope,output}){return{passed:await authorize({input,scope})&&produced.has(output),outputDigest:executionDigest(output),sourceRefs:[`status:${input.resourceId}:${executionDigest(output)}`]}}
 }
}
