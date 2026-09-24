import { executionDigest, executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(code) }
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
const nonempty = value => typeof value === 'string' && !!value.trim() && value === value.trim()
const copy = value => structuredClone(value)
const kinds = new Set(['uat-delivery', 'uat-rebuild', 'production-release'])
const phases = {
  'uat-delivery': ['preflight', 'integrated', 'built', 'runtime'],
  'uat-rebuild': ['preflight', 'built', 'runtime'],
  'production-release': ['preflight', 'merged', 'tagged', 'built', 'runtime'],
}
const operations = {
  'uat-delivery': ['integrate', 'build'],
  'uat-rebuild': ['rebuild'],
  'production-release': ['merge-main', 'tag', 'build'],
}
const precedingPhase = { integrate: 'preflight', build: 'integrated', rebuild: 'preflight',
  'merge-main': 'preflight', tag: 'merged' }
const attestations = {
  'uat-delivery': ['localE2ePassed', 'developmentPrVerified', 'uatPrVerified', 'sourcePackageSupported'],
  'uat-rebuild': ['failurePipelineVerified', 'branchHeadMatches', 'noNewerRuntimeVersion', 'sourcePackageSupported'],
  'production-release': ['releaseSetVerified', 'uatAccepted', 'productionBaselineVerified', 'dependencyOrderVerified', 'rollbackBoundaryVerified'],
}
const validEvidence = value => nonempty(value?.evidenceRef)
const safe = value => value && typeof value === 'object' && !Array.isArray(value)

/** Host 固定配置。凭据由注入的受信客户端持有，不能出现在 target 或 prepared 中。 */
export function createReleasePlatform({ targets, clients }) {
  if (!Array.isArray(targets) || !safe(clients) || !targets.length) fail('RELEASE_PLATFORM_CONFIG_INVALID')
  for (const name of ['github', 'woodpecker', 'kubernetes', 'registry', 'attestations']) {
    if (!safe(clients[name])) fail('RELEASE_PLATFORM_CLIENT_REQUIRED')
  }
  const commonMethods = { github: ['readBranch'], woodpecker: ['listPipelines'],
    kubernetes: ['readDeployment', 'readEntry'], registry: ['readManifest'], attestations: ['read'] }
  for (const target of targets) {
    const methods = { ...commonMethods,
      github: [...commonMethods.github, ...(target?.kind === 'uat-rebuild' ? []
        : ['resolveApprovedPullRequest', 'readPullRequest']), ...(target?.kind === 'production-release' ? ['readTag', 'createTag'] : [])],
      woodpecker: [...commonMethods.woodpecker, ...(target?.kind === 'production-release' ? [] : ['triggerBuild'])] }
    for (const [client, required] of Object.entries(methods)) {
      if (required.some(method => typeof clients[client]?.[method] !== 'function')) fail('RELEASE_PLATFORM_CAPABILITY_MISSING')
    }
  }
  const byKey = new Map(), byKind = new Map()
  for (const input of targets) {
    const target = copy(input)
    if (!kinds.has(target.kind) || !nonempty(target.repository) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository)
      || !nonempty(target.service) || !nonempty(target.runbookId)
      || target.environment !== (target.kind === 'production-release' ? 'production' : 'uat')
      || !nonempty(target.branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target.branch)
      || !nonempty(target.kubernetes?.namespace) || !nonempty(target.kubernetes?.deployment)
      || !nonempty(target.registry?.image) || !/^registry\.cn-sh1\.ctyun\.cn\/[A-Za-z0-9._/-]+$/.test(target.registry.image)
      || !nonempty(target.entryUrl) || !/^https:\/\//.test(target.entryUrl)
      || !Number.isInteger(target.woodpecker?.repositoryId) || target.woodpecker.repositoryId < 1
      || target.woodpecker.baseUrl !== 'https://woodpecker.hiqdat.dev'
      || (target.kind !== 'production-release' && !nonempty(target.woodpecker.cronName))
      || (target.kind === 'production-release' && (target.productionTriggerVerified !== true
        || !/^v\d{8}-[1-9]\d*$/.test(target.releaseTag ?? '')))) fail('RELEASE_PLATFORM_TARGET_INVALID')
    const key = `${target.kind}:${target.repository}:${target.environment}:${target.service}:${target.runbookId}`
    if (byKey.has(key)) fail('RELEASE_PLATFORM_TARGET_DUPLICATE')
    // 严格白名单。不允许把认证材料、任意 HTTP 地址或命令随任务持久化。
    if (Object.keys(target).some(field => !['kind', 'repository', 'environment', 'service', 'runbookId', 'branch', 'woodpecker', 'kubernetes', 'registry', 'entryUrl', 'productionTriggerVerified', 'releaseTag'].includes(field))
      || Object.keys(target.woodpecker ?? {}).some(field => !['baseUrl', 'repositoryId', 'cronName'].includes(field))
      || Object.keys(target.kubernetes).some(field => !['namespace', 'deployment'].includes(field))
      || Object.keys(target.registry).some(field => !['image'].includes(field))) fail('RELEASE_PLATFORM_TARGET_INVALID')
    byKey.set(key, target)
    byKind.set(target.kind, [...(byKind.get(target.kind) ?? []), target])
  }
  const rulesDigest = executionDigest([...byKey.values()])
  function targetFor(requirement, kind) {
    if (!safe(requirement?.target) || !sha(requirement.target.commitSha)) fail('RELEASE_PLATFORM_IDENTITY_INVALID')
    const { repository, environment, service, runbookId } = requirement.target
    const target = byKey.get(`${kind}:${repository}:${environment}:${service}:${runbookId}`)
    if (!target) fail('RELEASE_PLATFORM_TARGET_NOT_ALLOWED')
    return target
  }
  function requireMethod(client, method) {
    const fn = clients[client]?.[method]
    if (typeof fn !== 'function') fail('RELEASE_PLATFORM_CAPABILITY_MISSING')
    return fn.bind(clients[client])
  }
  async function read(client, method, args) {
    const result = await requireMethod(client, method)(copy(args))
    if (!safe(result) || !validEvidence(result)) fail('RELEASE_PLATFORM_READBACK_UNCONFIRMED')
    return result
  }
  async function branchHead(target) {
    const ref = await read('github', 'readBranch', { repository: target.repository, branch: target.branch })
    if (!sha(ref.commitSha)) fail('RELEASE_PLATFORM_BRANCH_UNCONFIRMED')
    return ref
  }
  async function approvedPullRequest(target, commitSha, evidenceRefs) {
    const pr = await read('github', 'resolveApprovedPullRequest', { repository: target.repository,
      baseBranch: target.branch, mergeCommitSha: commitSha, evidenceRefs })
    if (!Number.isInteger(pr.number) || pr.number < 1 || pr.baseBranch !== target.branch
      || pr.mergeCommitSha !== commitSha || pr.merged !== true || pr.unique !== true) fail('RELEASE_PLATFORM_PR_IDENTITY_UNCONFIRMED')
    return pr
  }
  async function pipelines(target, commitSha) {
    const result = await read('woodpecker', 'listPipelines', { baseUrl: target.woodpecker.baseUrl,
      repositoryId: target.woodpecker.repositoryId })
    if (result.complete !== true || result.hasMore !== false || !Array.isArray(result.pipelines)
      || result.pipelines.some(row => !Number.isInteger(row.number) || row.number < 1 || !sha(row.commitSha)
        || !nonempty(row.branch) || (target.kind === 'production-release' && !nonempty(row.ref))
        || !['created', 'pending', 'running', 'blocked', 'success', 'failure', 'error', 'killed', 'declined', 'canceled', 'skipped'].includes(row.status))
      || new Set(result.pipelines.map(row => row.number)).size !== result.pipelines.length) fail('RELEASE_PLATFORM_PIPELINE_LIST_INCOMPLETE')
    const same = result.pipelines.filter(row => row.commitSha === commitSha && (target.kind === 'production-release'
      ? row.ref === `refs/tags/${target.releaseTag}` : row.branch === target.branch))
    return { ...result, same, equivalentBuildAbsent: !same.some(row => ['created', 'pending', 'running', 'blocked', 'success'].includes(row.status)) }
  }
  async function inspect({ kind, phase, requirement, effect }) {
    if (!phases[kind]?.includes(phase)) fail('RELEASE_PLATFORM_PHASE_INVALID')
    const target = targetFor(requirement, kind), refs = [], facts = {}
    const add = observation => { refs.push(observation.evidenceRef); return observation }
    if (phase === 'preflight') {
      const head = add(await branchHead(target))
      if (head.commitSha !== requirement.target.commitSha) fail('RELEASE_PLATFORM_BRANCH_MOVED')
      if (kind !== 'uat-rebuild') add(await approvedPullRequest(target, requirement.target.commitSha, requirement.evidenceRefs))
      const signed = add(await read('attestations', 'read', { kind, target: requirement.target,
        required: attestations[kind], evidenceRefs: requirement.evidenceRefs }))
      if (attestations[kind].some(key => signed.facts?.[key] !== true)) fail('RELEASE_PLATFORM_ATTESTATION_MISSING')
      for (const key of attestations[kind]) facts[key] = true
      if (kind !== 'production-release') {
        const scan = add(await pipelines(target, requirement.target.commitSha))
        facts.equivalentBuildAbsent = scan.equivalentBuildAbsent
        if (kind === 'uat-delivery' && scan.same.some(row => ['failure', 'error', 'killed', 'declined', 'canceled'].includes(row.status)))
          fail('RELEASE_PLATFORM_FAILED_BUILD_REQUIRES_REBUILD')
      }
    } else if (phase === 'integrated' || phase === 'merged') {
      const ref = add(await branchHead(target))
      if (ref.commitSha !== requirement.target.commitSha) fail('RELEASE_PLATFORM_BRANCH_MISMATCH')
    } else if (phase === 'tagged') {
      const tag = add(await read('github', 'readTag', { repository: target.repository,
        tag: effect?.prepared?.expected?.tag }))
      if (tag.commitSha !== requirement.target.commitSha) fail('RELEASE_PLATFORM_TAG_MISMATCH')
    } else if (phase === 'built') {
      const scan = add(await pipelines(target, requirement.target.commitSha))
      if (!scan.same.some(row => row.status === 'success')) fail('RELEASE_PLATFORM_BUILD_UNCONFIRMED')
    } else if (phase === 'runtime') {
      const manifest = add(await read('registry', 'readManifest', { image: target.registry.image,
        commitSha: requirement.target.commitSha }))
      const deployment = add(await read('kubernetes', 'readDeployment', target.kubernetes))
      const entry = add(await read('kubernetes', 'readEntry', { url: target.entryUrl }))
      if (!digest(manifest.digest) || !digest(deployment.imageDigest)
        || manifest.digest !== deployment.imageDigest || deployment.sourceSha !== requirement.target.commitSha
        || !Number.isInteger(deployment.generation) || !Number.isInteger(deployment.observedGeneration)
        || deployment.observedGeneration < deployment.generation || deployment.ready !== true
        || entry.accessible !== true) fail('RELEASE_PLATFORM_RUNTIME_UNCONFIRMED')
      Object.assign(facts, { sourceSha: deployment.sourceSha, registryDigest: manifest.digest,
        runtimeDigest: deployment.imageDigest, observedGeneration: String(deployment.observedGeneration),
        ready: true, entryAccessible: true })
    }
    if (effect) {
      if (effect.prepared.targetDigest !== executionDigest(requirement.target)) fail('RELEASE_PLATFORM_EFFECT_MISMATCH')
      facts.operationKey = effect.prepared.operationKey
      facts.receiptDigest = executionDigest(effect.receipt)
    }
    return { phase, targetDigest: executionDigest(requirement.target), status: 'confirmed', evidenceRefs: refs, facts }
  }
  async function prepareOperation({ kind, operation, requirement, observation, runId, generation, requirementDigest, expected }) {
    const target = targetFor(requirement, kind)
    if (!operations[kind].includes(operation) || observation.status !== 'confirmed'
      || !Array.isArray(observation.evidenceRefs) || !observation.evidenceRefs.length
      || observation.evidenceRefs.some(ref => !nonempty(ref))
      || observation.targetDigest !== executionDigest(requirement.target)
      || observation.phase !== (kind === 'production-release' && operation === 'build' ? 'tagged' : precedingPhase[operation])
      || expected.previousPhase !== observation.phase || expected.previousEvidenceDigest !== executionDigest(observation.evidenceRefs)
      || !nonempty(runId) || !Number.isInteger(generation) || !/^[a-f0-9]{64}$/.test(requirementDigest)) fail('RELEASE_PLATFORM_PREPARE_INVALID')
    // 操作参数只取自白名单和冻结的需求，不接受模型生成的 URL、命令或认证字段。
    const operationKey = executionDigest({ kind, operation, runId, generation, requirementDigest,
      targetDigest: observation.targetDigest, previousEvidenceDigest: expected.previousEvidenceDigest })
    const pr = ['integrate', 'merge-main'].includes(operation)
      ? await approvedPullRequest(target, requirement.target.commitSha, requirement.evidenceRefs) : null
    return { action: 'external', workflowKind: kind, operation, runId, generation, requirementDigest,
      resourceKey: `external:${requirement.target.environment}:${requirement.target.repository}:${requirement.target.service}`,
      targetDigest: observation.targetDigest, expected: { ...expected,
        ...(pr ? { pullRequestNumber: pr.number, mergeCommitSha: pr.mergeCommitSha } : {}),
        ...(operation === 'tag' ? { tag: target.releaseTag } : {}) }, operationKey }
  }
  function assertPrepared(prepared) {
    if (!safe(prepared) || !operations[prepared.workflowKind]?.includes(prepared.operation)
      || !/^[a-f0-9]{64}$/.test(prepared.operationKey) || !/^[a-f0-9]{64}$/.test(prepared.requirementDigest)
      || !/^[a-f0-9]{64}$/.test(prepared.targetDigest) || !sha(prepared.expected?.commitSha)) fail('RELEASE_PLATFORM_OPERATION_INVALID')
    const target = (byKind.get(prepared.workflowKind) ?? []).find(candidate => executionDigest({
      repository: candidate.repository, environment: candidate.environment, service: candidate.service,
      commitSha: prepared.expected.commitSha, runbookId: candidate.runbookId,
    }) === prepared.targetDigest)
    const identity = target && { repository: target.repository, environment: target.environment, service: target.service,
      commitSha: prepared.expected.commitSha, runbookId: target.runbookId }
    if (!target || prepared.resourceKey !== `external:${target.environment}:${target.repository}:${target.service}`
      || prepared.targetDigest !== executionDigest(identity)
      || prepared.expected.previousPhase !== (prepared.workflowKind === 'production-release' && prepared.operation === 'build'
        ? 'tagged' : precedingPhase[prepared.operation])
      || (prepared.operation === 'tag' && prepared.expected.tag !== target.releaseTag)
      || (['integrate', 'merge-main'].includes(prepared.operation)
        && (!Number.isInteger(prepared.expected.pullRequestNumber) || prepared.expected.pullRequestNumber < 1
          || prepared.expected.mergeCommitSha !== prepared.expected.commitSha))
      || prepared.operationKey !== executionDigest({ kind: prepared.workflowKind, operation: prepared.operation,
        runId: prepared.runId, generation: prepared.generation, requirementDigest: prepared.requirementDigest,
        targetDigest: prepared.targetDigest, previousEvidenceDigest: prepared.expected.previousEvidenceDigest })) fail('RELEASE_PLATFORM_OPERATION_INVALID')
    return target
  }
  async function execute(prepared) {
    const target = assertPrepared(prepared)
    // merge SHA 必须已在目标分支，故集成/主干合并只能确认既有结果；不可猜测 GitHub merge 产生的新 SHA。
    if (['integrate', 'merge-main'].includes(prepared.operation)
      || prepared.workflowKind === 'production-release' && prepared.operation === 'build') return reconcile(prepared)
    if (['build', 'rebuild'].includes(prepared.operation)) {
      const current = await pipelines(target, prepared.expected.commitSha)
      if (current.same.some(row => row.status === 'success')) return { status: 'succeeded',
        evidenceRef: current.evidenceRef, operationKey: prepared.operationKey }
      if (current.same.some(row => ['created', 'pending', 'running', 'blocked'].includes(row.status)))
        return { status: 'unknown', evidenceRef: current.evidenceRef, operationKey: prepared.operationKey }
      if (prepared.operation === 'build' && current.same.some(row => ['failure', 'error', 'killed', 'declined', 'canceled'].includes(row.status)))
        fail('RELEASE_PLATFORM_FAILED_BUILD_REQUIRES_REBUILD')
    }
    if (prepared.operation === 'tag') {
      const current = await read('github', 'readTag', { repository: target.repository, tag: target.releaseTag })
      if (current.commitSha === prepared.expected.commitSha) return { status: 'succeeded',
        evidenceRef: current.evidenceRef, operationKey: prepared.operationKey }
      if (current.exists !== false) fail('RELEASE_PLATFORM_TAG_CONFLICT')
    }
    const method = {
      build: ['woodpecker', 'triggerBuild'], rebuild: ['woodpecker', 'triggerBuild'], tag: ['github', 'createTag'],
    }[prepared.operation]
    if (!method) fail('RELEASE_PLATFORM_OPERATION_INVALID')
    const evidence = await read(...method, { target: copy(target), operationKey: prepared.operationKey,
      commitSha: prepared.expected.commitSha, ...(prepared.expected.tag ? { tag: prepared.expected.tag } : {}) })
    // 发送回执不是完成证据。立即做一次独立回读；未确认时留给恢复流程，不重发。
    const observed = await reconcile(prepared)
    return { ...observed, dispatchEvidenceRef: evidence.evidenceRef }
  }
  async function reconcile(prepared) {
    const target = assertPrepared(prepared)
    const kind = prepared.operation === 'build' || prepared.operation === 'rebuild' ? 'build'
      : prepared.operation === 'tag' ? 'tag' : 'branch'
    let observation
    if (kind === 'build') {
      const scan = await pipelines(target, prepared.expected.commitSha)
      observation = { evidenceRef: scan.evidenceRef,
        confirmed: scan.same.some(row => row.status === 'success') }
    } else if (kind === 'tag') {
      const tag = await read('github', 'readTag', { repository: target.repository, tag: prepared.expected.tag })
      observation = { evidenceRef: tag.evidenceRef, confirmed: tag.commitSha === prepared.expected.commitSha }
    } else if (['integrate', 'merge-main'].includes(prepared.operation)) {
      const pr = await read('github', 'readPullRequest', { repository: target.repository,
        number: prepared.expected.pullRequestNumber })
      const ref = await branchHead(target)
      observation = { evidenceRef: pr.evidenceRef, branchEvidenceRef: ref.evidenceRef,
        confirmed: pr.merged === true && pr.baseBranch === target.branch
          && pr.mergeCommitSha === prepared.expected.commitSha && ref.commitSha === prepared.expected.commitSha }
    } else {
      const ref = await branchHead(target)
      observation = { evidenceRef: ref.evidenceRef, confirmed: ref.commitSha === prepared.expected.commitSha }
    }
    return { status: observation.confirmed ? 'succeeded' : 'unknown', evidenceRef: observation.evidenceRef,
      operationKey: prepared.operationKey }
  }
  const releaseAdapters = Object.fromEntries([...byKind.keys()].map(kind => [kind, {
    id: `trusted-release-${kind}`, version: '1', rulesDigest,
    inspect: args => inspect({ ...args, kind }), prepareOperation,
  }]))
  return { releaseAdapters, operationAdapter: { execute, reconcile }, targetFor,
    configuredKinds: Object.freeze([...byKind.keys()]) }
}
