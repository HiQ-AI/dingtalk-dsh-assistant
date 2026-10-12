import { validUatAcceptancePolicy } from '../packages/dingtalk-dsh-assistant/uat-acceptance-policy.js'
import { planUatSchemaTargetAppend } from './configure-uat-schema-target.mjs'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { createReleasePlatform } from '../packages/dingtalk-dsh-assistant/workflow-release-platform.js'
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const keys = (x, expected) => x && typeof x === 'object' && !Array.isArray(x) && isDeepStrictEqual(Object.keys(x).sort(), expected.sort())
export async function planReleaseTargetAppend(source, proposal) {
  if (keys(proposal, ['expectedProfileSha256', 'uatSchemaMigrationTarget'])) return planUatSchemaTargetAppend(source, proposal)
  if (!keys(proposal, ['expectedProfileSha256','target','policy']) || hash(source)!==proposal.expectedProfileSha256) fail('RELEASE_CONFIG_PROPOSAL_STALE')
  const {target,policy}=proposal
  if (typeof target?.id!=='string'||!target.id.trim() || !['uat-deployment','uat-rebuild'].includes(target.kind) || !/^feature\/uat[1-9]-base$/.test(target.branch??'')
    || !(keys(policy,['targetId','requiredChecks','requiredScenarioIds'])||keys(policy,['targetId','requiredChecks','acceptancePolicy'])) || policy.targetId!==target.id
    || !Array.isArray(policy.requiredChecks) || policy.requiredChecks.some(x=>typeof x!=='string'||!x.trim())
    || new Set(policy.requiredChecks).size!==policy.requiredChecks.length
    || !validUatAcceptancePolicy(policy)) fail('RELEASE_CONFIG_TARGET_INVALID')
  const unavailable=()=>fail('RELEASE_CONFIG_NETWORK_FORBIDDEN')
  const clients={github:{readBranch:unavailable,resolveApprovedPullRequest:unavailable,readPullRequest:unavailable},woodpecker:{listPipelines:unavailable,readBuildEvidence:unavailable,triggerBuild:unavailable},kubernetes:{readDeployment:unavailable,readPods:unavailable,readEntry:unavailable},registry:{readManifest:unavailable},attestations:{read:unavailable}}
  try { const {id,...spec}=target; createReleasePlatform({targets:[spec],clients}) } catch { fail('RELEASE_CONFIG_TARGET_INVALID') }
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
  const platforms=before.workflow.platforms
  if(!Array.isArray(platforms?.release?.targets)||!Array.isArray(platforms?.uatMerge?.targets)
    || !before.workflow.repositories?.some(repo=>repo.githubRepository===target.repository || repo.remote?.replace(/\.git$/,'').endsWith('/'+target.repository))) fail('RELEASE_CONFIG_REPOSITORY_UNKNOWN')
  const current=platforms.release.targets.filter(x=>x.id===target.id), currentPolicies=platforms.uatMerge.targets.filter(x=>x.targetId===target.id)
  if(current.length>1||currentPolicies.length>1||current.length&&!isDeepStrictEqual(current[0],target)||currentPolicies.length&&!isDeepStrictEqual(currentPolicies[0],policy)) fail('RELEASE_CONFIG_TARGET_CONFLICT')
  if(!current.length)replaceProperty(platforms.release,'targets',[...platforms.release.targets,target])
  if(!currentPolicies.length)replaceProperty(platforms.uatMerge,'targets',[...platforms.uatMerge.targets,policy])
  let updated=source
  for(const change of insertions.sort((a,b)=>b.at-a.at))updated=updated.slice(0,change.at)+change.fragment+updated.slice(change.end)
  const after=parse(updated)
  const strip=value=>{value.workflow.platforms.release.targets=value.workflow.platforms.release.targets.filter(x=>x.id!==target.id);value.workflow.platforms.uatMerge.targets=value.workflow.platforms.uatMerge.targets.filter(x=>x.targetId!==target.id);return value.document}
  if(!isDeepStrictEqual(after.workflow.platforms.release.targets.find(x=>x.id===target.id),target)||!isDeepStrictEqual(after.workflow.platforms.uatMerge.targets.find(x=>x.targetId===target.id),policy)||!isDeepStrictEqual(strip(before),strip(after)))fail('RELEASE_CONFIG_UNRELATED_CHANGE')
  return {updated,changed:updated!==source}
}
export async function configureReleaseTargetAppend({profile,proposal,mode,expectedSha256}) {
  if(!isAbsolute(profile??'')||!isAbsolute(proposal??'')||!['check','apply'].includes(mode)||!/^[a-f0-9]{64}$/.test(expectedSha256??'')) fail('RELEASE_CONFIG_ARGUMENTS_INVALID')
  const source=await readFile(profile,'utf8'); if(hash(source)!==expectedSha256)fail('RELEASE_CONFIG_PROFILE_CHANGED')
  let value;try{value=JSON.parse(await readFile(proposal,'utf8'))}catch{fail('RELEASE_CONFIG_PROPOSAL_INVALID')}
  if(value.expectedProfileSha256!==expectedSha256)fail('RELEASE_CONFIG_PROPOSAL_STALE')
  const plan=await planReleaseTargetAppend(source,value)
  const result={mode,changed:plan.changed,beforeSha256:hash(source),afterSha256:hash(plan.updated),writes:0}
  if(mode==='check'||!plan.changed)return result
  const lock=profile+'.release-targets.lock',temporary=profile+'.'+randomUUID()+'.tmp'
  try{await writeFile(lock,JSON.stringify({pid:process.pid,beforeSha256:hash(source)}),{flag:'wx',mode:0o600})}catch{fail('RELEASE_CONFIG_PROFILE_LOCKED')}
  try{
    if(await readFile(profile,'utf8')!==source)fail('RELEASE_CONFIG_PROFILE_CHANGED')
    await writeFile(temporary,plan.updated,{flag:'wx',mode:0o600})
    if(await readFile(profile,'utf8')!==source)fail('RELEASE_CONFIG_PROFILE_CHANGED')
    await rename(temporary,profile)
    if(await readFile(profile,'utf8')!==plan.updated)fail('RELEASE_CONFIG_WRITE_READBACK_MISMATCH')
    return {...result,writes:1}
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e});await unlink(lock)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const a=process.argv.slice(2),v={};for(let i=0;i<a.length;i++){
  if(['--check','--apply'].includes(a[i])&&!v.mode)v.mode=a[i].slice(2)
  else if(['--profile','--proposal','--expected-sha256'].includes(a[i])&&a[i+1]){const k=a[i]==='--expected-sha256'?'expectedSha256':a[i].slice(2);if(v[k])fail('RELEASE_CONFIG_ARGUMENTS_INVALID');v[k]=a[++i]}
  else fail('RELEASE_CONFIG_ARGUMENTS_INVALID')
 }console.log(JSON.stringify(await configureReleaseTargetAppend(v)))}catch(e){console.error(/^RELEASE_CONFIG_[A-Z_]+$/.test(e.message)?e.message:'RELEASE_CONFIG_FAILED');process.exitCode=1}
}
