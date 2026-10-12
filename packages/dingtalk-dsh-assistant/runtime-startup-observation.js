import { executionError } from './execution-artifacts.js'
const fail=()=>{throw executionError('QUERY_STARTUP_CONFIG_INVALID')}
const escape=value=>value.split('.').join('[.]')
export function validateStartupInspection(value){
 if(value===undefined)return
 if(!value||Object.keys(value).sort().join(',')!=='booleanProperties,springConditions'
  ||!Array.isArray(value.booleanProperties)||!value.booleanProperties.length||value.booleanProperties.length>8
  ||new Set(value.booleanProperties).size!==value.booleanProperties.length
  ||value.booleanProperties.some(key=>typeof key!=='string'||!/^\w[\w.-]{0,100}\.enabled$/.test(key))
  ||!Array.isArray(value.springConditions)||value.springConditions.length>8
  ||value.springConditions.some(item=>!item||Object.keys(item).sort().join(',')!=='className,property'
    ||!/^[$A-Za-z][\w$]{0,120}$/.test(item.className)||!value.booleanProperties.includes(item.property))
  ||new Set(value.springConditions.map(item=>item.className)).size!==value.springConditions.length)fail()
}
/** Project only operator-registered booleans and class/property condition outcomes. Never return source text. */
export function projectStartupInspection(config,{container,startedAt,raw,completeness}){
 validateStartupInspection(config)
 const start=Date.parse(startedAt)
 if(!Number.isFinite(start))throw executionError('QUERY_RUNTIME_IDENTITY_INVALID')
 const command=[...(container.command??[]),...(container.args??[])].join(' ')
 const properties=config.booleanProperties.map(key=>{
  const values=prefix=>[...new Set([...command.matchAll(new RegExp(`(?:^|[ ])${prefix}${escape(key)}=(true|false)(?=[ "';]|$)`,'g'))].map(match=>match[1]==='true'))]
  return{key,jvmDeclarations:values('-D'),springArguments:values('--'),effectiveValueProven:false}
 })
 const lines=raw.split(/\r?\n/).flatMap(line=>{
  const match=/^(\d{4}-\d{2}-\d{2}T\S+) (.*)$/.exec(line)
  return match&&Date.parse(match[1])>=start?[{timestamp:match[1],text:match[2]}]:[]
 })
 const returnedBytes=Buffer.byteLength(raw,'utf8')
 const complete=completeness?.status==='complete-retained-window' && completeness.limitBytes===524288
  && completeness.returnedBytes===returnedBytes && returnedBytes<524288
 const windowIntegrity={status:returnedBytes>=524288?'byte-limit-reached':complete?'complete-retained-window':'unknown',returnedBytes,limitBytes:524288}
 const conditions=config.springConditions.map(item=>{
  if(!complete)return{...item,status:'unavailable',reason:'startup-log-integrity-unproven',excludedByCondition:null}
  const results=[]
  for(let i=0;i<lines.length;i++)if(lines[i].text.trim()===`${item.className}:`){
   const block=[]
   for(let j=i+1;j<lines.length&&j<i+12;j++){
    if(/^\s*[$A-Za-z][\w$]*:\s*$/.test(lines[j].text)&&lines[j].text.trim()!=='Matched:')break
    block.push(lines[j])
   }
   const negative=block.some(line=>line.text.trim()==='Did not match:')
   const reason=block.find(line=>line.text.includes(`@ConditionalOnProperty (${item.property}=true)`)
     &&line.text.includes("found different value in property 'enabled'")&&line.text.includes('(OnPropertyCondition)'))
   if(negative&&reason)results.push({status:'not-matched',timestamp:reason.timestamp,reason:'different-property-value',excludedByCondition:true})
   else if(block.some(line=>line.text.trim()==='Matched:'))results.push({status:'matched',timestamp:lines[i].timestamp,reason:'condition-matched',excludedByCondition:false})
  }
  const statuses=new Set(results.map(result=>result.status))
  return{...item,...(statuses.size===1?results.at(-1):{status:'unavailable',reason:statuses.size?'conflicting-observations':'startup-condition-not-in-retained-window',excludedByCondition:null})}
 })
 return{startedAt,properties,conditions,windowIntegrity,rawContentExposed:false,environmentExposed:false,
  limitations:['Declared command booleans are not an Environment dump. A negative condition proves exclusion only for the registered class/property in this container startup. Missing or truncated retained logs never prove absence.']}
}
