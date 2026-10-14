import { planReleasePolicyRestore } from './repair-release-target-policy.mjs'
import {createLegacyVerificationJobCheck} from '../packages/dingtalk-dsh-assistant/execution-check-job.js'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import yaml from 'js-yaml'
import { DatabaseSync } from 'node:sqlite'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createLocalAcceptanceRunner } from '../packages/dingtalk-dsh-assistant/execution-local-acceptance.js'

const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const validRepositoryId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)
  && !['__proto__', 'constructor', 'prototype'].includes(id)
const validRepositoryIds = ids => Array.isArray(ids) && ids.length > 0
  && ids.every(validRepositoryId) && new Set(ids).size === ids.length

const restoreKey = Symbol('bound-repository-restore')
function parseProjectProfile(source, yaml, ids) {
  if (!validRepositoryIds(ids)) fail('LOCAL_CONFIG_REPOSITORIES_REQUIRED')
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
    } catch { fail('LOCAL_CONFIG_PROFILE_YAML_INVALID') }
    const collections = [], workflows = [], hosts = []
    const walk = (value, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (Array.isArray(value.repositories) && ids.every(id => value.repositories.some(repo => repo?.id === id))) { collections.push(value.repositories); workflows.push(value) }
      if (value.name === '@zzusp/dingtalk-dsh-assistant/platform-host') hosts.push(value.config)
      for (const child of Object.values(value)) walk(child, seen)
    }
    walk(document)
    if (collections.length !== 1) fail('LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS')
    const repositories = collections[0]
    if (ids.some(id => repositories.filter(repo => repo?.id === id).length !== 1)) fail('LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS')
    return { document, maps, repositories, workflow: workflows[0], hosts }
  }
  return parse(source)
}

/** 仅更新 bundle 明确指定的项目及已配置的 UAT 目标，保留 !!js 和无关配置原文。 */
export function planProjectLocalAcceptance(source, bundle, yaml, { allowUpdate = false, mergePolicy, checksProposal, repositoryPatches, [restoreKey]: restore } = {}) {
  // The old project-specific check-command rewrites are retired, not widened into arbitrary command edits.
  if (checksProposal !== undefined) fail('LOCAL_CONFIG_LEGACY_CHECKS_PROPOSAL_UNSUPPORTED')
  const ids = restore ? restore.map(item => item.id) : plain(bundle) ? Object.keys(bundle) : []
  if (!validRepositoryIds(ids)) fail('LOCAL_CONFIG_BUNDLE_INVALID')
  const parse = text => parseProjectProfile(text, yaml, ids)
  const before = parse(source), insertions = []
  let appliedMergePolicy
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const replaceProperty = (parent, key, value) => {
    const matches = before.maps.filter(item => item.value === parent)
    if (matches.length !== 1) fail('LOCAL_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const map = matches[0], lineStart = source.lastIndexOf('\n', map.start - 1) + 1
    const prefix = source.slice(lineStart, map.start)
    const first = /^\r?\n( *)\S/m.exec(source.slice(map.start, map.end))
    const indent = /^ *- $/.test(prefix) ? prefix.length : first?.[1].length
    if (!Number.isInteger(indent)) fail('LOCAL_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const expression = new RegExp(`^ {${indent}}${key}:.*(?:\\r?\\n|$)`, 'gm')
    const locations = [...source.matchAll(expression)].filter(item => item.index >= map.start && item.index < map.end)
    if (locations.length > 1) fail('LOCAL_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
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
      if (Object.hasOwn(parent, key)) fail('LOCAL_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
      at = /^ *- $/.test(prefix) ? source.indexOf('\n', map.start) + 1 : map.start + first.index + first[0].lastIndexOf('\n') + 1
      end = at
    }
    const fragment = value === undefined ? '' : yaml.dump({ [key]: value }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(indent) + line).join(newline) + newline
    insertions.push({ at, end, fragment })
  }
  if(restore)for(const item of restore){const repo=before.repositories.find(r=>r.id===item.id);if(!isDeepStrictEqual(repo.checks,item.checks))replaceProperty(repo,'checks',item.checks);if(Object.hasOwn(repo,'taskLocalAcceptance'))replaceProperty(repo,'taskLocalAcceptance',undefined)}
  if(!restore)for (const id of ids) {
    const repo = before.repositories.find(item => item.id === id)
    try { if (!createLocalAcceptanceRunner({ root: repo.managedRoot, config: bundle[id] })) fail('INVALID') }
    catch { fail(`LOCAL_CONFIG_INVALID_${id}`) }
    if (Object.hasOwn(repo, 'localAcceptance')) {
      if (!isDeepStrictEqual(repo.localAcceptance, bundle[id])) {
        if (!allowUpdate) fail(`LOCAL_CONFIG_ALREADY_DIFFERENT_${id}`)
        replaceProperty(repo, 'localAcceptance', bundle[id])
      }
      continue
    }
    const maps = before.maps.filter(item => item.value === repo)
    if (maps.length !== 1) fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED')
    const { start } = maps[0], lineStart = source.lastIndexOf('\n', start - 1) + 1
    const prefix = source.slice(lineStart, start)
    if (!/^ *- $/.test(prefix)) fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED')
    const end = source.indexOf('\n', start)
    if (end < 0 || !/^id:\s/.test(source.slice(start, end).trim())) fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED')
    try { if (yaml.load(source.slice(start, end).trim())?.id !== id) fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED') }
    catch { fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED') }
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    const fragment = yaml.dump({ localAcceptance: bundle[id] }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(prefix.length) + line).join(newline) + newline
    insertions.push({ at: end + 1, fragment })
  }
  if (mergePolicy !== undefined) {
    if (!plain(mergePolicy) || Object.keys(mergePolicy).join() !== 'targets' || !Array.isArray(mergePolicy.targets)
      || !mergePolicy.targets.length || mergePolicy.targets.some(item => !plain(item))
      || new Set(mergePolicy.targets.map(item => item.targetId)).size !== mergePolicy.targets.length)
      fail('LOCAL_CONFIG_MERGE_POLICY_INVALID')
    for (const policy of mergePolicy.targets) {
      const target = before.workflow.platforms?.release?.targets?.filter(item => item.id === policy.targetId)
      const repositories = before.repositories.filter(repo => typeof repo.githubRepository === 'string'
        && repo.githubRepository === target?.[0]?.repository)
      const repo = repositories[0]
      if (typeof policy.targetId !== 'string' || !policy.targetId.trim() || target?.length !== 1 || target[0].kind !== 'uat-deployment'
        || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(target[0].repository ?? '')
        || typeof target[0].branch !== 'string' || !target[0].branch.trim()
        || repositories.length !== 1 || !ids.includes(repo.id)
        || Object.keys(policy).some(key => !['targetId','requiredChecks','requiredScenarioIds'].includes(key))
        || !Array.isArray(policy.requiredChecks) || policy.requiredChecks.some(name => typeof name !== 'string' || !name.trim())
        || new Set(policy.requiredChecks).size !== policy.requiredChecks.length
        || !Array.isArray(policy.requiredScenarioIds) || !policy.requiredScenarioIds.length
        || new Set(policy.requiredScenarioIds).size !== policy.requiredScenarioIds.length
        || policy.requiredScenarioIds.some(id => typeof id !== 'string' || !bundle[repo.id].scenarios.some(item => item.id === id))) fail('LOCAL_CONFIG_MERGE_POLICY_INVALID')
    }
    if (before.hosts.length !== 1 || !plain(before.hosts[0])) fail('LOCAL_CONFIG_PLATFORM_HOST_AMBIGUOUS')
    const previous = before.workflow.platforms.uatMerge
    if (previous !== undefined && (!plain(previous) || Object.keys(previous).join() !== 'targets'
      || !Array.isArray(previous.targets) || previous.targets.some(item => !plain(item) || typeof item.targetId !== 'string')
      || new Set(previous.targets.map(item => item.targetId)).size !== previous.targets.length)) fail('LOCAL_CONFIG_MERGE_POLICY_INVALID')
    const byTarget = new Map(mergePolicy.targets.map(item => [item.targetId, item]))
    appliedMergePolicy = { targets: (previous?.targets ?? []).map(item => byTarget.get(item.targetId) ?? item) }
    for (const item of mergePolicy.targets) if (!appliedMergePolicy.targets.some(existing => existing.targetId === item.targetId)) appliedMergePolicy.targets.push(item)
    if (!isDeepStrictEqual(previous, appliedMergePolicy)) replaceProperty(before.workflow.platforms, 'uatMerge', appliedMergePolicy)
    if (before.hosts[0].uatMergeWritesEnabled !== true) replaceProperty(before.hosts[0], 'uatMergeWritesEnabled', true)
  }
  if(repositoryPatches!==undefined){
    if(!allowUpdate||!Array.isArray(repositoryPatches)||!repositoryPatches.length||new Set(repositoryPatches.map(p=>p?.id)).size!==repositoryPatches.length)fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')
    for(const patch of repositoryPatches){
      if(!plain(patch)||!ids.includes(patch.id)||Object.keys(patch).some(k=>!['id','dependencyRepositories','taskLocalAcceptance'].includes(k)))fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')
      const repo=before.repositories.find(r=>r.id===patch.id)
      if(patch.dependencyRepositories!==undefined){
        if(!validRepositoryIds(patch.dependencyRepositories)||patch.dependencyRepositories.some(id=>id===patch.id||!ids.includes(id)))fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')
        if(!isDeepStrictEqual(repo.dependencyRepositories,patch.dependencyRepositories))replaceProperty(repo,'dependencyRepositories',patch.dependencyRepositories)
      }
      if(patch.taskLocalAcceptance!==undefined){
        if(!Array.isArray(patch.taskLocalAcceptance)||patch.taskLocalAcceptance.some(item=>!plain(item)||Object.keys(item).some(key=>!['localAcceptance','scope','checks'].includes(key))||!plain(item.scope)||Object.keys(item.scope).sort().join(',')!=='requestDigest,taskId,uatEnvironment'||!/^task-[a-f0-9]+$/.test(item.scope.taskId)||!/^uat[1-9]$/.test(item.scope.uatEnvironment)||!/^[a-f0-9]{64}$/.test(item.scope.requestDigest)))fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')
        for(const item of patch.taskLocalAcceptance)if(item.checks!==undefined){
          if(!Array.isArray(item.checks)||!item.checks.length)fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')
          try{for(const check of item.checks)createLegacyVerificationJobCheck({...check,root:repo.managedRoot})}catch{fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')}
        }
        for(const item of patch.taskLocalAcceptance)try{createLocalAcceptanceRunner({root:repo.managedRoot,config:item.localAcceptance})}catch{fail('LOCAL_CONFIG_REPOSITORY_PATCH_INVALID')}
        if(!isDeepStrictEqual(repo.taskLocalAcceptance,patch.taskLocalAcceptance))replaceProperty(repo,'taskLocalAcceptance',patch.taskLocalAcceptance)
      }
    }
  }
  let updated = source
  for (const item of insertions.sort((a, b) => b.at - a.at || (b.end ?? b.at) - (a.end ?? a.at))) updated = updated.slice(0, item.at) + item.fragment + updated.slice(item.end ?? item.at)
  const after = parse(updated)
  const strip = parsed => {
    for (const repo of parsed.repositories) if (ids.includes(repo.id)){if(restore){delete repo.checks;delete repo.taskLocalAcceptance}else delete repo.localAcceptance}
    for(const patch of repositoryPatches??[])for(const key of Object.keys(patch).filter(key=>key!=='id'))delete parsed.repositories.find(repo=>repo.id===patch.id)[key]
    if (mergePolicy !== undefined) { delete parsed.workflow.platforms.uatMerge; delete parsed.hosts[0].uatMergeWritesEnabled }
    return parsed.document
  }
  if(!restore)for (const id of ids) if (!isDeepStrictEqual(after.repositories.find(repo => repo.id === id).localAcceptance, bundle[id])) fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  for(const patch of repositoryPatches??[])for(const key of Object.keys(patch).filter(key=>key!=='id'))if(!isDeepStrictEqual(after.repositories.find(repo=>repo.id===patch.id)[key],patch[key]))fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  if (mergePolicy !== undefined && (!isDeepStrictEqual(after.workflow.platforms.uatMerge, appliedMergePolicy) || after.hosts[0].uatMergeWritesEnabled !== true)) fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  if (!isDeepStrictEqual(strip(before), strip(after))) fail('LOCAL_CONFIG_UNRELATED_CHANGE')
  return { updated, changed: insertions.length > 0, repositoryIds: ids }
}

/** 仅撤回已由原部署回执和当前活动定义共同证明的仓库配置漂移。 */
export async function planProjectRepositoryRestore(source, proposalPath, { profile, expectedSha256 }) {
  const bytes=await readFile(proposalPath),proposal=JSON.parse(bytes)
  if(proposal.kind==='release-policy-repair')return planReleasePolicyRestore(source,proposalPath,{profile,expectedSha256})
  const ids = Array.isArray(proposal.repositories) ? proposal.repositories.map(repo => repo?.id) : []
  const proofFile=async proof=>{if(!plain(proof)||!isAbsolute(proof.path??'')||!/^[a-f0-9]{64}$/.test(proof.sha256??''))fail('LOCAL_CONFIG_RESTORE_PROOF_INVALID');const value=await readFile(proof.path);if(hash(value)!==proof.sha256)fail('LOCAL_CONFIG_RESTORE_PROOF_CHANGED');return JSON.parse(value)}
  if(proposal.profile!==profile||proposal.expectedProfileSha256!==expectedSha256||hash(source)!==expectedSha256
    ||!isAbsolute(proposal.sourceProfile??'')||!/^[a-f0-9]{64}$/.test(proposal.sourceProfileSha256??'')
    ||!validRepositoryIds(ids)
    ||proposal.repositories.some(r=>!ids.includes(r.id)||Object.keys(r).some(k=>!['id','restoreChecks','removeTaskLocalAcceptance','dependencyRepositories'].includes(k))||r.removeTaskLocalAcceptance!==true))fail('LOCAL_CONFIG_RESTORE_PROPOSAL_INVALID')
  const oldText=await readFile(proposal.sourceProfile,'utf8');if(hash(oldText)!==proposal.sourceProfileSha256)fail('LOCAL_CONFIG_RESTORE_SOURCE_CHANGED')
  const receipt=await proofFile(proposal.deploymentReceipt),beforeProof=await proofFile(proposal.beforeConfigProof)
  if(receipt.mode!=='apply'||receipt.changed!==true||receipt.afterSha256!==expectedSha256||!isAbsolute(receipt.backupPath??'')||hash(await readFile(receipt.backupPath))!==receipt.beforeSha256
    ||beforeProof.oldProfile!==proposal.sourceProfile||!Array.isArray(beforeProof.runs)||!beforeProof.runs.length)fail('LOCAL_CONFIG_RESTORE_DEPLOYMENT_UNBOUND')
  let current, old
  try { current=parseProjectProfile(source,yaml,ids); old=parseProjectProfile(oldText,yaml,ids) }
  catch { fail('LOCAL_CONFIG_RESTORE_TARGET_INVALID') }
  const restores=[]
  for(const item of proposal.repositories){
    const now=current.repositories.find(r=>r.id===item.id),prior=old.repositories.find(r=>r.id===item.id)
    if(!Array.isArray(prior.checks)||Object.hasOwn(prior,'taskLocalAcceptance')||!isDeepStrictEqual(prior.checks,item.restoreChecks)||!isDeepStrictEqual(now.dependencyRepositories,item.dependencyRepositories))fail('LOCAL_CONFIG_RESTORE_TARGET_INVALID')
    const strip=r=>{const copy=structuredClone(r);delete copy.checks;delete copy.taskLocalAcceptance;delete copy.dependencyRepositories;return copy}
    if(!isDeepStrictEqual(strip(now),strip(prior)))fail('LOCAL_CONFIG_RESTORE_UNRELATED_CHANGE')
    restores.push({id:item.id,checks:prior.checks})
  }
  const plan=planProjectLocalAcceptance(source,null,yaml,{[restoreKey]:restores}),after=parseProjectProfile(plan.updated,yaml,ids)
  const digest=(repo,workflow)=>{const config=structuredClone(repo);config.editablePaths??=[];config.githubRepository??=config.remote.replace(/\.git$/,'').replace(/^.*github.com[:/]/,'');config.baseBranch??=config.baseRef.startsWith('refs/heads/')?config.baseRef.slice(11):/^(origin\/|refs\/remotes\/)/.test(config.baseRef)?null:config.baseRef;const{purpose,routingTerms,localAcceptance,dependencyRepositories,...executionConfig}=config;return executionDigest({config:executionConfig,ghCommand:null,author:workflow.gitAuthor??null})}
  if(!isAbsolute(current.workflow.dbPath??''))fail('LOCAL_CONFIG_RESTORE_DATABASE_INVALID')
  const db=new DatabaseSync(current.workflow.dbPath,{readOnly:true}),knownActiveRuns=[]
  try{
    const rows=db.prepare("SELECT r.task_id,r.run_id,r.status,r.generation,w.body FROM execution_runs r JOIN message_workflows w ON r.workflow_digest=w.digest WHERE r.status NOT IN ('succeeded','failed','cancelled')").all()
    for(const row of rows){const record=JSON.parse(row.body);if(record.config?.kind!=='engineering')continue;const saved=record.config,proof=beforeProof.runs.find(r=>r.runId===row.run_id),repo=after.repositories.find(r=>r.id===saved.repoId)
      if(!ids.includes(saved.repoId)||!proof||proof.taskId!==row.task_id||proof.generation!==row.generation||proof.status!==row.status||proof.savedRepositoryDigest!==saved.repositoryDigest||!repo||digest(repo,after.workflow)!==saved.repositoryDigest)fail('LOCAL_CONFIG_RESTORE_ACTIVE_DIGEST_MISMATCH')
      knownActiveRuns.push({taskId:row.task_id,runId:row.run_id,generation:row.generation,repositoryId:saved.repoId,repositoryDigest:saved.repositoryDigest,matches:true})
    }
    if(!knownActiveRuns.length||knownActiveRuns.length!==beforeProof.runs.length)fail('LOCAL_CONFIG_RESTORE_ACTIVE_SET_CHANGED')
  }finally{db.close()}
  return {plan,proof:{proposalSha256:hash(bytes),sourceProfileSha256:hash(oldText),deploymentReceipt:proposal.deploymentReceipt,beforeConfigProof:proposal.beforeConfigProof,fields:restores.map(r=>({id:r.id,fields:['checks','taskLocalAcceptance']})),knownActiveRuns}}
}

export async function configureProjectLocalAcceptance({ profile, bundle, mode, expectedSha256, mergePolicy, checksProposal, repositoryPatches, restoreProposal }) {
  if (!isAbsolute(profile ?? '') || (!restoreProposal && !isAbsolute(bundle ?? '')) || !['check', 'apply'].includes(mode)) fail('LOCAL_CONFIG_ARGUMENTS_INVALID')
  if ((expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256))
    || (mode === 'apply' && !expectedSha256) || (mergePolicy !== undefined && !isAbsolute(mergePolicy))
    || (checksProposal !== undefined && (!isAbsolute(checksProposal) || !expectedSha256))) fail('LOCAL_CONFIG_EXPECTED_HASH_REQUIRED')
  if(restoreProposal && (!isAbsolute(restoreProposal)||bundle||mergePolicy||checksProposal||repositoryPatches||!expectedSha256))fail('LOCAL_CONFIG_RESTORE_ARGUMENTS_INVALID')
  let supplied
  const source = await readFile(profile, 'utf8')
  if (expectedSha256 !== undefined && hash(source) !== expectedSha256) fail('LOCAL_CONFIG_PROFILE_CHANGED')
  try { if(!restoreProposal)supplied = JSON.parse(await readFile(bundle, 'utf8')) } catch { fail('LOCAL_CONFIG_BUNDLE_JSON_INVALID') }
  let policy
  if (mergePolicy) { try { policy = JSON.parse(await readFile(mergePolicy, 'utf8')) } catch { fail('LOCAL_CONFIG_MERGE_POLICY_JSON_INVALID') } }
  let checks
  if (checksProposal) { try { checks = JSON.parse(await readFile(checksProposal, 'utf8')) } catch { fail('LOCAL_CONFIG_CHECKS_PROPOSAL_JSON_INVALID') } }
  let patches
  if(repositoryPatches){try{patches=JSON.parse(await readFile(repositoryPatches,'utf8'))}catch{fail('LOCAL_CONFIG_REPOSITORY_PATCH_JSON_INVALID')}}
  const restored=restoreProposal ? await planProjectRepositoryRestore(source,restoreProposal,{profile,expectedSha256}) : null
  const plan = restored?.plan ?? planProjectLocalAcceptance(source, supplied, yaml, { allowUpdate: !!expectedSha256, mergePolicy: policy, checksProposal: checks, repositoryPatches:patches })
  const result = { mode, changed: plan.changed, repositories: plan.repositoryIds ?? [], beforeSha256: hash(source), afterSha256: hash(plan.updated), writes: 0, ...(restored?{restore:restored.proof}:{}) }
  if (mode === 'check' || !plan.changed) return result
  const lockPath = `${profile}.local-acceptance.lock`
  try { await writeFile(lockPath, JSON.stringify({ pid: process.pid, beforeSha256: hash(source) }), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code === 'EEXIST') fail('LOCAL_CONFIG_PROFILE_LOCKED'); throw error }
  try {
  if (await readFile(profile, 'utf8') !== source) fail('LOCAL_CONFIG_PROFILE_CHANGED')
  if(restoreProposal){const fresh=await planProjectRepositoryRestore(source,restoreProposal,{profile,expectedSha256});if(fresh.plan.updated!==plan.updated||!isDeepStrictEqual(fresh.proof,restored.proof))fail('LOCAL_CONFIG_RESTORE_PROOF_CHANGED')}
  const backupPath = `${profile}.local-acceptance-${randomUUID()}.bak`, temporary = `${profile}.${randomUUID()}.tmp`
  if(restored?.proof?.kind!=='release-policy-repair')await writeFile(backupPath, source, { flag: 'wx', mode: 0o600 })
  if (restored?.proof?.kind!=='release-policy-repair' && await readFile(backupPath, 'utf8') !== source) fail('LOCAL_CONFIG_BACKUP_MISMATCH')
  try {
    await writeFile(temporary, plan.updated, { flag: 'wx', mode: 0o600 })
    if (await readFile(profile, 'utf8') !== source) fail('LOCAL_CONFIG_PROFILE_CHANGED')
    await rename(temporary, profile)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  if (await readFile(profile, 'utf8') !== plan.updated) fail('LOCAL_CONFIG_WRITE_READBACK_MISMATCH')
  return restored?.proof?.kind==='release-policy-repair' ? {...result,writes:1} : { ...result, backupPath, writes: 2 }
  } finally { await unlink(lockPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (['--check', '--apply'].includes(arg) && !values.mode) values.mode = arg.slice(2)
      else if (['--profile', '--bundle', '--expected-sha256', '--merge-policy', '--checks-proposal','--repository-patches','--restore-proposal'].includes(arg) && args[i + 1]) {
        const key = arg === '--expected-sha256' ? 'expectedSha256' : arg === '--merge-policy' ? 'mergePolicy' : arg === '--checks-proposal' ? 'checksProposal' : arg==='--repository-patches'?'repositoryPatches':arg==='--restore-proposal'?'restoreProposal':arg.slice(2)
        if (values[key]) fail('LOCAL_CONFIG_ARGUMENTS_INVALID')
        values[key] = args[++i]
      }
      else fail('LOCAL_CONFIG_ARGUMENTS_INVALID')
    }
    console.log(JSON.stringify(await configureProjectLocalAcceptance(values)))
  } catch (error) {
    console.error(/^LOCAL_CONFIG_[A-Za-z0-9_-]+$/.test(error.message) ? error.message : 'LOCAL_CONFIG_FAILED')
    process.exitCode = 1
  }
}
