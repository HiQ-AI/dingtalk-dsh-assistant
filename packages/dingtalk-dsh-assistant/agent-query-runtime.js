import { createPlatformClients } from './workflow-platform-clients.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { executionError } from './execution-artifacts.js'
const exec=promisify(execFile),safe=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9.-]{0,62}$/.test(x)
const fail=code=>{throw executionError(code)}
export function validateRuntimeResource(r){
 if(r.kind!=='kubernetes'||!r.id||!isAbsolute(r.kubeconfig??'')||!safe(r.namespace)||!safe(r.deployment))fail('QUERY_STATUS_CONFIG_INVALID')
 let u;try{u=new URL(r.server)}catch{fail('QUERY_STATUS_CONFIG_INVALID')}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('QUERY_STATUS_CONFIG_INVALID')
}
/** 精确K8s目标只读，日志仅分类统计，配置只投影端口/资源，凭据留Host。 */
export async function readRuntimeResource(r,{signal,execFileImpl=exec}={}){
 validateRuntimeResource(r)
 signal=signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)
 const base=['--kubeconfig',r.kubeconfig,'--server',r.server,...(r.skipTlsVerify===true?['--insecure-skip-tls-verify']:[]),'--request-timeout=10s','-n',r.namespace]
 const run=async args=>{try{return(await execFileImpl('kubectl',[...base,...args],{windowsHide:true,timeout:12000,maxBuffer:1024*1024,signal})).stdout}catch{if(signal?.aborted)throw signal.reason;fail('QUERY_RUNTIME_UNAVAILABLE')}}
 const json=async args=>{try{return JSON.parse(await run([...args,'-o','json']))}catch(e){if(e.code)throw e;fail('QUERY_RUNTIME_INVALID')}}
 const captured=new Map()
 const boundedExec=async(command,args)=>{
  try{const result=await execFileImpl(command,args,{windowsHide:true,timeout:12000,maxBuffer:1024*1024,signal});
   const at=args.indexOf('get');if(at>=0)captured.set(args[at+1],JSON.parse(result.stdout));return result
  }catch{if(signal?.aborted)throw signal.reason;fail('QUERY_RUNTIME_UNAVAILABLE')}
 }
 const {kubernetes}=createPlatformClients({kubeconfig:r.kubeconfig,kubeServer:r.server,kubeSkipTlsVerify:r.skipTlsVerify===true,execFileImpl:boundedExec})
 let deploymentProof,podProof
 try{deploymentProof=await kubernetes.readDeployment(r);podProof=await kubernetes.readPods({...r,deploymentUid:deploymentProof.uid})}catch{if(signal?.aborted)throw signal.reason;fail('QUERY_RUNTIME_UNAVAILABLE')}
 const d=captured.get('deployment')
 if(d.metadata?.name!==r.deployment||d.metadata?.namespace!==r.namespace||!d.metadata?.uid)fail('QUERY_RUNTIME_IDENTITY_INVALID')
 const sets=captured.get('replicasets'),pods=captured.get('pods')
 const owned=new Set((sets.items??[]).filter(s=>s.metadata?.ownerReferences?.some(o=>o.kind==='Deployment'&&o.uid===d.metadata.uid&&o.controller===true)).map(s=>s.metadata.uid))
 const selected=(pods.items??[]).filter(p=>p.metadata?.ownerReferences?.some(o=>o.kind==='ReplicaSet'&&owned.has(o.uid)&&o.controller===true))
 if(selected.length>8)fail('QUERY_CAPACITY')
 const observations=[]
 for(const p of selected){
  if(!safe(p.metadata.name)||p.metadata.namespace!==r.namespace)fail('QUERY_RUNTIME_IDENTITY_INVALID')
  const containers=[]
  if((p.spec?.containers??[]).length>4)fail('QUERY_CAPACITY')
  for(const c of p.spec?.containers??[]){
   if(!safe(c.name))fail('QUERY_RUNTIME_IDENTITY_INVALID')
   const state=(p.status?.containerStatuses??[]).find(s=>s.name===c.name)
   const raw=await run(['logs',p.metadata.name,'--container',c.name,'--since=10m','--tail=200','--limit-bytes=32768','--timestamps=true'])
   const lines=raw.split(/\r?\n/).filter(Boolean),exceptions={},diagnostics=[]
   for(const line of lines)for(const name of line.match(/\b(?:[a-zA-Z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error)\b/g)??[])exceptions[name]=(exceptions[name]??0)+1
   for(const line of lines){
    const timestamp=/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/.exec(line)?.[0]??null
    const level=/\b(ERROR|WARN)\b/.exec(line)?.[1]??null
    const exceptionType=/\b(?:[a-zA-Z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error)\b/.exec(line)?.[0]??null
    const location=/\bat ([a-zA-Z_$][\w.$]*)\(([A-Za-z_$][\w$]*\.java):(\d{1,6})\)/.exec(line)
    if(level||exceptionType||location)diagnostics.push({timestamp,level,exceptionType,codeLocation:location?`${location[1]}(${location[2]}:${location[3]})`:null})
   }
   containers.push({name:c.name,image:c.image,imageId:state?.imageID??null,ready:state?.ready===true,restartCount:state?.restartCount??0,
    ports:(c.ports??[]).map(x=>({port:x.containerPort,protocol:x.protocol??'TCP'})),resources:Object.fromEntries(['requests','limits'].map(k=>[k,Object.fromEntries(Object.entries(c.resources?.[k]??{}).filter(([name,value])=>['cpu','memory','ephemeral-storage'].includes(name)&&typeof value==='string'&&/^[0-9.]+(?:[eE][+-]?[0-9]+|[a-zA-Z]{0,2})$/.test(value)))])),
    logSummary:{windowSeconds:600,maxLines:200,maxBytes:32768,returnedLines:lines.length,errorLines:lines.filter(x=>/\bERROR\b/.test(x)).length,warnLines:lines.filter(x=>/\bWARN\b/.test(x)).length,exceptionTypes:Object.entries(exceptions).slice(0,30).map(([type,count])=>({type,count})),diagnostics:diagnostics.slice(0,50),messageTemplatesSupported:false,rawContentExposed:false}})
  }
  observations.push({name:p.metadata.name,uid:p.metadata.uid,resourceVersion:p.metadata.resourceVersion,phase:p.status?.phase??null,containers})
 }
 const latest=await json(['get','deployment',r.deployment])
 if(latest.metadata?.uid!==d.metadata.uid||latest.metadata?.resourceVersion!==d.metadata.resourceVersion)fail('QUERY_SOURCE_CHANGED')
 return{deploymentProof,podProof,namespace:r.namespace,deployment:r.deployment,uid:d.metadata.uid,resourceVersion:d.metadata.resourceVersion,generation:d.metadata.generation,observedGeneration:d.status?.observedGeneration??null,desiredReplicas:d.spec?.replicas??0,readyReplicas:d.status?.readyReplicas??0,pods:observations,limitations:['Kubernetes就绪不等于业务验收通过','日志仅返回时间/级别/异常类型/Java代码位置；尚无已核验业务消息模板，不支持原文消息诊断；不是完整日志查询','运行配置仅端口/资源配额，env与Secret未读取输出','镜像ID为运行版本，未映射Git提交时不推测提交SHA']}
}
