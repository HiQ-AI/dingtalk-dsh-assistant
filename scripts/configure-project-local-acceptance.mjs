import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import yaml from 'js-yaml'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createLocalAcceptanceRunner } from '../packages/dingtalk-dsh-assistant/execution-local-acceptance.js'

const ids = ['dataset', 'dataset-web']
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)

/** 精确更新双项目验收及显式 UAT 策略，保留 !!js 和无关配置原文。 */
export function planProjectLocalAcceptance(source, bundle, yaml, { allowUpdate = false, mergePolicy, checksProposal } = {}) {
  if (!plain(bundle) || !isDeepStrictEqual(Object.keys(bundle).sort(), [...ids].sort())) fail('LOCAL_CONFIG_BUNDLE_INVALID')
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
  const before = parse(source), insertions = []
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
    const fragment = yaml.dump({ [key]: value }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(indent) + line).join(newline) + newline
    insertions.push({ at, end, fragment })
  }
  for (const id of ids) {
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
    if (end < 0 || !/^id:\s*(?:dataset|dataset-web|"dataset"|"dataset-web"|'dataset'|'dataset-web')\s*(?:#.*)?$/.test(source.slice(start, end).trim())) fail('LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED')
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    const fragment = yaml.dump({ localAcceptance: bundle[id] }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(prefix.length) + line).join(newline) + newline
    insertions.push({ at: end + 1, fragment })
  }
  if (mergePolicy !== undefined) {
    const expected = { 'dataset-uat3-deployment': ['HiQ-AI/dataset', 'feature/uat3-base', 'dataset'],
      'dataset-web-uat2-deployment': ['HiQ-AI/dataset-web', 'feature/uat2-base', 'dataset-web'] }
    if (!plain(mergePolicy) || Object.keys(mergePolicy).join() !== 'targets' || !Array.isArray(mergePolicy.targets)
      || mergePolicy.targets.length !== 2 || new Set(mergePolicy.targets.map(item => item.targetId)).size !== 2)
      fail('LOCAL_CONFIG_MERGE_POLICY_INVALID')
    for (const policy of mergePolicy.targets) {
      const fixed = expected[policy.targetId], target = before.workflow.platforms?.release?.targets?.filter(item => item.id === policy.targetId)
      if (!fixed || target?.length !== 1 || target[0].kind !== 'uat-deployment' || target[0].repository !== fixed[0] || target[0].branch !== fixed[1]
        || Object.keys(policy).some(key => !['targetId','requiredChecks','requiredScenarioIds'].includes(key))
        || !Array.isArray(policy.requiredChecks) || policy.requiredChecks.some(name => typeof name !== 'string' || !name.trim())
        || new Set(policy.requiredChecks).size !== policy.requiredChecks.length
        || !Array.isArray(policy.requiredScenarioIds) || !policy.requiredScenarioIds.length
        || new Set(policy.requiredScenarioIds).size !== policy.requiredScenarioIds.length
        || policy.requiredScenarioIds.some(id => typeof id !== 'string' || !bundle[fixed[2]].scenarios.some(item => item.id === id))) fail('LOCAL_CONFIG_MERGE_POLICY_INVALID')
    }
    if (before.hosts.length !== 1 || !plain(before.hosts[0])) fail('LOCAL_CONFIG_PLATFORM_HOST_AMBIGUOUS')
    if (!isDeepStrictEqual(before.workflow.platforms.uatMerge, mergePolicy)) replaceProperty(before.workflow.platforms, 'uatMerge', mergePolicy)
    if (before.hosts[0].uatMergeWritesEnabled !== true) replaceProperty(before.hosts[0], 'uatMergeWritesEnabled', true)
  }
  if (checksProposal !== undefined) {
    const repo = before.repositories.find(item => item.id === 'dataset')
    if (!allowUpdate || !plain(checksProposal) || Object.keys(checksProposal).some(key => !['repository','checks','sourceChecksSha256'].includes(key))
      || checksProposal.repository !== 'dataset' || !/^[a-f0-9]{64}$/.test(checksProposal.sourceChecksSha256 ?? '')
      || !Array.isArray(repo.checks) || !Array.isArray(checksProposal.checks)) fail('LOCAL_CONFIG_CHECKS_PROPOSAL_INVALID')
    if (!isDeepStrictEqual(repo.checks, checksProposal.checks)) {
      if (hash(JSON.stringify(repo.checks)) !== checksProposal.sourceChecksSha256) fail('LOCAL_CONFIG_CHECKS_CHANGED')
      const old = repo.checks.find(item => item.id === 'dataset-package'), next = checksProposal.checks.find(item => item.id === 'dataset-package')
      if (!old || !next || old.version !== '1' || next.version !== '2' || old.steps?.length !== 1 || next.steps?.length !== 2
        || !isDeepStrictEqual({ ...old, version: '2', steps: next.steps }, next)
        || !isDeepStrictEqual(next.steps.slice(1), old.steps)
        || !isDeepStrictEqual(repo.checks.filter(item => item.id !== old.id), checksProposal.checks.filter(item => item.id !== old.id))
        || repo.checks.length !== checksProposal.checks.length
        || !isAbsolute(next.steps[0].executable ?? '') || !Array.isArray(next.steps[0].args)
        || next.steps[0].args.length !== 5 || !isAbsolute(next.steps[0].args[0])
        || !/[\\/]verify-dataset-unit-tests\.mjs$/.test(next.steps[0].args[0])
        || next.steps[0].args[1] !== '--java' || !isAbsolute(next.steps[0].args[2])
        || next.steps[0].args[3] !== '--maven-home' || !isAbsolute(next.steps[0].args[4])
        || next.steps[0].timeoutMs !== 1800000) fail('LOCAL_CONFIG_CHECKS_PROPOSAL_INVALID')
      replaceProperty(repo, 'checks', checksProposal.checks)
    }
  }
  let updated = source
  for (const item of insertions.sort((a, b) => b.at - a.at || (b.end ?? b.at) - (a.end ?? a.at))) updated = updated.slice(0, item.at) + item.fragment + updated.slice(item.end ?? item.at)
  const after = parse(updated)
  const strip = parsed => {
    for (const repo of parsed.repositories) if (ids.includes(repo.id)) delete repo.localAcceptance
    if (checksProposal !== undefined) delete parsed.repositories.find(repo => repo.id === 'dataset').checks
    if (mergePolicy !== undefined) { delete parsed.workflow.platforms.uatMerge; delete parsed.hosts[0].uatMergeWritesEnabled }
    return parsed.document
  }
  for (const id of ids) if (!isDeepStrictEqual(after.repositories.find(repo => repo.id === id).localAcceptance, bundle[id])) fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  if (checksProposal !== undefined && !isDeepStrictEqual(after.repositories.find(repo => repo.id === 'dataset').checks, checksProposal.checks)) fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  if (mergePolicy !== undefined && (!isDeepStrictEqual(after.workflow.platforms.uatMerge, mergePolicy) || after.hosts[0].uatMergeWritesEnabled !== true)) fail('LOCAL_CONFIG_ROUNDTRIP_MISMATCH')
  if (!isDeepStrictEqual(strip(before), strip(after))) fail('LOCAL_CONFIG_UNRELATED_CHANGE')
  return { updated, changed: insertions.length > 0 }
}

export async function configureProjectLocalAcceptance({ profile, bundle, mode, expectedSha256, mergePolicy, checksProposal }) {
  if (!isAbsolute(profile ?? '') || !isAbsolute(bundle ?? '') || !['check', 'apply'].includes(mode)) fail('LOCAL_CONFIG_ARGUMENTS_INVALID')
  if ((expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256))
    || (mode === 'apply' && !expectedSha256) || (mergePolicy !== undefined && !isAbsolute(mergePolicy))
    || (checksProposal !== undefined && (!isAbsolute(checksProposal) || !expectedSha256))) fail('LOCAL_CONFIG_EXPECTED_HASH_REQUIRED')
  let supplied
  const source = await readFile(profile, 'utf8')
  if (expectedSha256 !== undefined && hash(source) !== expectedSha256) fail('LOCAL_CONFIG_PROFILE_CHANGED')
  try { supplied = JSON.parse(await readFile(bundle, 'utf8')) } catch { fail('LOCAL_CONFIG_BUNDLE_JSON_INVALID') }
  let policy
  if (mergePolicy) { try { policy = JSON.parse(await readFile(mergePolicy, 'utf8')) } catch { fail('LOCAL_CONFIG_MERGE_POLICY_JSON_INVALID') } }
  let checks
  if (checksProposal) { try { checks = JSON.parse(await readFile(checksProposal, 'utf8')) } catch { fail('LOCAL_CONFIG_CHECKS_PROPOSAL_JSON_INVALID') } }
  const plan = planProjectLocalAcceptance(source, supplied, yaml, { allowUpdate: !!expectedSha256, mergePolicy: policy, checksProposal: checks })
  const result = { mode, changed: plan.changed, repositories: ids, beforeSha256: hash(source), afterSha256: hash(plan.updated), writes: 0 }
  if (mode === 'check' || !plan.changed) return result
  const lockPath = `${profile}.local-acceptance.lock`
  try { await writeFile(lockPath, JSON.stringify({ pid: process.pid, beforeSha256: hash(source) }), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code === 'EEXIST') fail('LOCAL_CONFIG_PROFILE_LOCKED'); throw error }
  try {
  if (await readFile(profile, 'utf8') !== source) fail('LOCAL_CONFIG_PROFILE_CHANGED')
  const backupPath = `${profile}.local-acceptance-${randomUUID()}.bak`, temporary = `${profile}.${randomUUID()}.tmp`
  await writeFile(backupPath, source, { flag: 'wx', mode: 0o600 })
  if (await readFile(backupPath, 'utf8') !== source) fail('LOCAL_CONFIG_BACKUP_MISMATCH')
  try {
    await writeFile(temporary, plan.updated, { flag: 'wx', mode: 0o600 })
    if (await readFile(profile, 'utf8') !== source) fail('LOCAL_CONFIG_PROFILE_CHANGED')
    await rename(temporary, profile)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  if (await readFile(profile, 'utf8') !== plan.updated) fail('LOCAL_CONFIG_WRITE_READBACK_MISMATCH')
  return { ...result, backupPath, writes: 2 }
  } finally { await unlink(lockPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (['--check', '--apply'].includes(arg) && !values.mode) values.mode = arg.slice(2)
      else if (['--profile', '--bundle', '--expected-sha256', '--merge-policy', '--checks-proposal'].includes(arg) && args[i + 1]) {
        const key = arg === '--expected-sha256' ? 'expectedSha256' : arg === '--merge-policy' ? 'mergePolicy' : arg === '--checks-proposal' ? 'checksProposal' : arg.slice(2)
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
