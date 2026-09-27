import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { createAgentResourceReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-resources.js'
import { createAgentDatabaseReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-database.js'
import { createAgentStatusReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-status.js'
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const keys = (x, expected) => x && typeof x === 'object' && !Array.isArray(x) && isDeepStrictEqual(Object.keys(x).sort(), expected.sort())
export async function planAgentQueryResources(source, proposal) {
  if (!keys(proposal, ['expectedProfileSha256','target','directQueries']) || proposal.target !== 'dingtalk-dsh-assistant.config.workflow.directQueries'
    || !/^[a-f0-9]{64}$/.test(proposal.expectedProfileSha256)) fail('QUERY_CONFIG_PROPOSAL_INVALID')
  const q = proposal.directQueries
  if (!keys(q, ['resources','databases','statusResources','grants', ...(q?.databases?.length ? ['credentialsPath'] : [])]) || !Array.isArray(q.databases)
    || !Array.isArray(q.resources) || !Array.isArray(q.statusResources) || !(q.resources.length + q.databases.length + q.statusResources.length)
    || !Array.isArray(q.grants) || q.grants.length !== 1) fail('QUERY_CONFIG_PROPOSAL_INVALID')
  for (const r of q.resources) if (!keys(r, r.kind === 'repository' ? ['id','kind','root','commit','paths'] : ['id','kind','root','paths'])) fail('QUERY_CONFIG_RESOURCE_INVALID')
  for (const r of q.statusResources) if (!keys(r,r.kind === 'kubernetes' ? ['id','kind','kubeconfig','server','namespace','deployment','skipTlsVerify'] : ['id','url','fields'])) fail('QUERY_CONFIG_RESOURCE_INVALID')
  // 配置登记不读取凭据、不连接数据库；运行时按资源身份策略检查事务及角色。
  if (q.databases.length && (typeof q.credentialsPath !== 'string' || !isAbsolute(q.credentialsPath) || q.credentialsPath.includes('\0'))) fail('QUERY_CONFIG_CREDENTIALS_PATH_INVALID')
  for (const r of q.databases) {
    if (!keys(r, ['id','connectionId','tables', ...(r.environment === undefined ? [] : ['environment']), ...(r.identityPolicy === undefined ? [] : ['identityPolicy'])]) || typeof r.id !== 'string' || !r.id.trim()
      || typeof r.connectionId !== 'string' || !r.connectionId.trim() || !Array.isArray(r.tables)
      || (r.identityPolicy !== undefined && (r.identityPolicy !== 'host-enforced-readonly' || r.environment !== 'uat'))
      || (r.environment !== undefined && r.environment !== 'uat')
      || r.tables.some(t => !keys(t, ['schema','table','columns']) || !Array.isArray(t.columns) || new Set(t.columns).size !== t.columns.length)
      || new Set(r.tables.map(t => `${t.schema}.${t.table}`)).size !== r.tables.length) fail('QUERY_CONFIG_DATABASE_INVALID')
  }
  let resources, statuses, databases
  try { resources=q.resources.length ? createAgentResourceReadCapability({resources:q.resources}) : null; statuses=q.statusResources.length ? createAgentStatusReadCapability({resources:q.statusResources}) : null; databases=createAgentDatabaseReadCapability({resources:q.databases,connectDatabase:()=>fail('QUERY_CONFIG_DATABASE_CONNECTION_FORBIDDEN')}) }
  catch { fail('QUERY_CONFIG_RESOURCE_INVALID') }
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
  const parse = text => {
    const stack = [], maps = []
    let document
    try {
      document = yaml.load(text, { schema, listener(event, state) {
        if (event === 'open') stack.push(state.position)
        else {
          const start = stack.pop()
          if (state.kind === 'mapping') maps.push({ start, end: state.position, value: state.result })
        }
      } })
    } catch { fail('QUERY_CONFIG_PROFILE_YAML_INVALID') }
    const workflows = []
    const walk = value => {
      if (!value || typeof value !== 'object') return
      if (value.name === '@zzusp/dingtalk-dsh-assistant/resident' && value.config?.workflow) workflows.push(value.config.workflow)
      for (const child of Object.values(value)) walk(child)
    }
    walk(document)
    if (workflows.length !== 1) fail('QUERY_CONFIG_WORKFLOW_AMBIGUOUS')
    return { document, maps, workflow: workflows[0] }
  }
  const before = parse(source), insertions = []
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const replaceProperty = (parent, key, value) => {
    const matches = before.maps.filter(item => item.value === parent)
    if (matches.length !== 1) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const map = matches[0], lineStart = source.lastIndexOf('\n', map.start - 1) + 1
    const prefix = source.slice(lineStart, map.start)
    const first = /^\r?\n( *)\S/m.exec(source.slice(map.start, map.end))
    const indent = /^ *- $/.test(prefix) ? prefix.length : first?.[1].length
    if (!Number.isInteger(indent)) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const expression = new RegExp(`^ {${indent}}${key}:.*(?:\\r?\\n|$)`, 'gm')
    const locations = [...source.matchAll(expression)].filter(item => item.index >= map.start && item.index < map.end)
    if (locations.length > 1) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    let at, end
    if (locations.length) {
      at = locations[0].index; end = at + locations[0][0].length
      while (end < source.length) {
        const next = source.indexOf('\n', end), until = next < 0 ? source.length : next + 1
        const line = source.slice(end, until)
        if (line.trim() && /^ */.exec(line)[0].length <= indent) break
        end = until
      }
    } else {
      if (Object.hasOwn(parent, key)) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
      at = /^ *- $/.test(prefix) ? source.indexOf('\n', map.start) + 1 : map.start + first.index + first[0].lastIndexOf('\n') + 1
      end = at
    }
    const fragment = yaml.dump({ [key]: value }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(indent) + line).join(newline) + newline
    insertions.push({ at, end, fragment })
  }
  const g=q.grants[0], w=before.workflow
  if (!keys(g,['actorId','conversationId','resourceIds','databaseIds','statusIds']) || g.actorId !== w.ownerActorId
    || !w.groupIds?.includes(g.conversationId) || !g.actorId || !g.conversationId
    || !isDeepStrictEqual(g.databaseIds, q.databases.map(r=>r.id))
    || !isDeepStrictEqual(g.resourceIds, q.resources.map(r=>r.id)) || !isDeepStrictEqual(g.statusIds,q.statusResources.map(r=>r.id))) fail('QUERY_CONFIG_GRANT_INVALID')
  for(const r of q.resources) if(!await resources.authorize({input:{resourceId:r.id},scope:g})) fail('QUERY_CONFIG_AUTHORIZATION_FAILED')
  for(const r of q.databases) if(!await databases.authorize({input:{resourceId:r.id},scope:g})) fail('QUERY_CONFIG_AUTHORIZATION_FAILED')
  for(const r of q.statusResources) if(!await statuses.authorize({input:{resourceId:r.id},scope:g})) fail('QUERY_CONFIG_AUTHORIZATION_FAILED')
  if (!isDeepStrictEqual(w.directQueries,q)) replaceProperty(w,'directQueries',q)
  let updated=source
  for(const change of insertions.sort((a,b)=>b.at-a.at)) updated=updated.slice(0,change.at)+change.fragment+updated.slice(change.end)
  const after=parse(updated)
  if(!isDeepStrictEqual(after.workflow.directQueries,q)) fail('QUERY_CONFIG_ROUNDTRIP_MISMATCH')
  delete before.workflow.directQueries; delete after.workflow.directQueries
  if(!isDeepStrictEqual(before.document,after.document)) fail('QUERY_CONFIG_UNRELATED_CHANGE')
  return {updated,changed:updated!==source}
}
export async function configureAgentQueryResources({profile,proposal,mode,expectedSha256}) {
  if(!isAbsolute(profile??'')||!isAbsolute(proposal??'')||!['check','apply'].includes(mode)||!/^[a-f0-9]{64}$/.test(expectedSha256??'')) fail('QUERY_CONFIG_ARGUMENTS_INVALID')
  const source=await readFile(profile,'utf8'); if(hash(source)!==expectedSha256)fail('QUERY_CONFIG_PROFILE_CHANGED')
  let value;try{value=JSON.parse(await readFile(proposal,'utf8'))}catch{fail('QUERY_CONFIG_PROPOSAL_INVALID')}
  if(value.expectedProfileSha256!==expectedSha256)fail('QUERY_CONFIG_PROPOSAL_STALE')
  const plan=await planAgentQueryResources(source,value)
  const result={mode,changed:plan.changed,beforeSha256:hash(source),afterSha256:hash(plan.updated),writes:0}
  if(mode==='check'||!plan.changed)return result
  const lock=profile+'.agent-queries.lock',temporary=profile+'.'+randomUUID()+'.tmp',backupPath=profile+'.agent-queries-'+randomUUID()+'.bak'
  try{await writeFile(lock,JSON.stringify({pid:process.pid,beforeSha256:hash(source)}),{flag:'wx',mode:0o600})}catch{fail('QUERY_CONFIG_PROFILE_LOCKED')}
  try{
    if(await readFile(profile,'utf8')!==source)fail('QUERY_CONFIG_PROFILE_CHANGED')
    await writeFile(backupPath,source,{flag:'wx',mode:0o600})
    if(await readFile(backupPath,'utf8')!==source)fail('QUERY_CONFIG_BACKUP_MISMATCH')
    await writeFile(temporary,plan.updated,{flag:'wx',mode:0o600})
    if(await readFile(profile,'utf8')!==source)fail('QUERY_CONFIG_PROFILE_CHANGED')
    await rename(temporary,profile)
    if(await readFile(profile,'utf8')!==plan.updated)fail('QUERY_CONFIG_WRITE_READBACK_MISMATCH')
    return {...result,backupPath,writes:2}
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e});await unlink(lock)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const a=process.argv.slice(2),v={};for(let i=0;i<a.length;i++){
  if(['--check','--apply'].includes(a[i])&&!v.mode)v.mode=a[i].slice(2)
  else if(['--profile','--proposal','--expected-sha256'].includes(a[i])&&a[i+1]){const k=a[i]==='--expected-sha256'?'expectedSha256':a[i].slice(2);if(v[k])fail('QUERY_CONFIG_ARGUMENTS_INVALID');v[k]=a[++i]}
  else fail('QUERY_CONFIG_ARGUMENTS_INVALID')
 }console.log(JSON.stringify(await configureAgentQueryResources(v)))}catch(e){console.error(/^QUERY_CONFIG_[A-Z_]+$/.test(e.message)?e.message:'QUERY_CONFIG_FAILED');process.exitCode=1}
}
