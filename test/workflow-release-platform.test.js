import test from 'node:test'
import assert from 'node:assert/strict'
import { createReleasePlatform } from '../packages/dingtalk-dsh-assistant/workflow-release-platform.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const commitSha = 'a'.repeat(40)
const imageDigest = `sha256:${'b'.repeat(64)}`
const target = { kind: 'uat-delivery', repository: 'HiQ-AI/dataset', environment: 'uat', service: 'dataset',
  runbookId: 'dataset-uat', branch: 'feature/uat2-base',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 13, cronName: 'dataset-uat2-poll' },
  kubernetes: { namespace: 'hiqlcd-app-uat2', deployment: 'dataset' },
  registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' }, entryUrl: 'https://uat2.example.test/health' }
const requirement = { request: '交付 UAT2', target: { repository: target.repository, environment: 'uat', service: 'dataset',
  commitSha, runbookId: target.runbookId }, constraints: [], evidenceRefs: ['approval:1'] }

function fixture(overrides = {}) {
  const state = { pipeline: [], calls: [] }
  const clients = {
    github: {
      async readBranch() { return { commitSha: overrides.branchSha ?? commitSha, evidenceRef: 'github:branch:1' } },
      async resolveApprovedPullRequest() { return { number: 42, baseBranch: target.branch, mergeCommitSha: commitSha,
        merged: true, unique: true, evidenceRef: 'github:pr:42' } },
      async readPullRequest() { return { number: 42, baseBranch: target.branch, mergeCommitSha: commitSha,
        merged: true, evidenceRef: 'github:pr:42' } },
      async readTag() { return { commitSha, evidenceRef: 'github:tag:1' } },
      async createTag() { return { evidenceRef: 'github:tag:create:1' } },
    },
    woodpecker: {
      async listPipelines() { return { complete: overrides.complete ?? true, hasMore: false,
        pipelines: state.pipeline, evidenceRef: 'woodpecker:list:1' } },
      async readBuildEvidence({ pipelineNumber }) { return { pipelineNumber, commitSha,
        image: overrides.buildImage ?? `${target.registry.image}:uat2`,
        imageDigest: overrides.buildDigest ?? imageDigest, evidenceRef: 'woodpecker:build:1' } },
      async triggerBuild(args) { state.calls.push(args); if (overrides.finish !== false) state.pipeline.push({ number: 1,
        commitSha, branch: target.branch, status: 'success' }); return { evidenceRef: 'woodpecker:trigger:1' } },
    },
    kubernetes: {
      async readDeployment() { return { uid: 'deployment-uid', generation: 3, observedGeneration: 3,
        desiredReplicas: 1, readyReplicas: 1, ready: true, evidenceRef: 'k8s:deployment:1' } },
      async readPods() { return { complete: true, deploymentUid: 'deployment-uid', pods: [{ ready: true,
        deploymentUid: 'deployment-uid', imageDigest: overrides.podDigest ?? imageDigest }], evidenceRef: 'k8s:pods:1' } },
      async readEntry() { return { accessible: true, evidenceRef: 'http:entry:1' } },
    },
    registry: { async readManifest() { return { digest: overrides.manifestDigest ?? imageDigest,
      platformDigests: overrides.platformDigests ?? [imageDigest], evidenceRef: 'registry:manifest:1' } } },
    attestations: { async read() { return { facts: { localE2ePassed: true, developmentPrVerified: true,
      uatPrVerified: true, sourcePackageSupported: true }, evidenceRef: 'attestation:1' } } },
  }
  return { platform: createReleasePlatform({ targets: [target], clients }), clients, state }
}

test('目标固定白名单，生产触发未证实则拒绝注册', () => {
  assert.throws(() => createReleasePlatform({ targets: [{ ...target, kind: 'production-release',
    environment: 'production' }], clients: fixture().clients }),
  { code: 'RELEASE_PLATFORM_TARGET_INVALID' })
  const { platform } = fixture()
  assert.deepEqual(platform.configuredKinds, ['uat-delivery'])
  assert.throws(() => platform.targetFor({ ...requirement, target: { ...requirement.target,
    repository: 'Other/repo' } }, 'uat-delivery'), { code: 'RELEASE_PLATFORM_TARGET_NOT_ALLOWED' })
  assert.throws(() => createReleasePlatform({ targets: [target], clients: { ...fixture().clients,
    github: { readBranch: fixture().clients.github.readBranch } } }), { code: 'RELEASE_PLATFORM_CAPABILITY_MISSING' })
  assert.throws(() => createReleasePlatform({ targets: [{ ...target, kind: 'production-release',
    environment: 'production', productionTriggerVerified: true, releaseTag: 'v20260925-1' }], clients: fixture().clients }),
  { code: 'RELEASE_PLATFORM_TARGET_INVALID' })
})

test('没有唯一且已合入的精确 PR 身份，UAT 集成拒绝准备', async () => {
  const { clients } = fixture()
  clients.github.resolveApprovedPullRequest = async () => ({ number: 42, baseBranch: target.branch,
    mergeCommitSha: commitSha, merged: false, unique: true, evidenceRef: 'github:pr:42' })
  const platform = createReleasePlatform({ targets: [target], clients })
  await assert.rejects(platform.releaseAdapters['uat-delivery'].inspect({ phase: 'preflight', requirement }),
    { code: 'RELEASE_PLATFORM_PR_IDENTITY_UNCONFIRMED' })
})

test('预检要分支 SHA、受信证明与完整分页查重', async () => {
  const good = fixture()
  const observed = await good.platform.releaseAdapters['uat-delivery'].inspect({ phase: 'preflight', requirement })
  assert.equal(observed.facts.equivalentBuildAbsent, true)
  await assert.rejects(fixture({ branchSha: 'c'.repeat(40) }).platform.releaseAdapters['uat-delivery']
    .inspect({ phase: 'preflight', requirement }), { code: 'RELEASE_PLATFORM_BRANCH_MOVED' })
  await assert.rejects(fixture({ complete: false }).platform.releaseAdapters['uat-delivery']
    .inspect({ phase: 'preflight', requirement }), { code: 'RELEASE_PLATFORM_PIPELINE_LIST_INCOMPLETE' })
})

test('精确 prepared 才能触发，写回执之后必须独立回读成功', async () => {
  const { platform, state } = fixture()
  const adapter = platform.releaseAdapters['uat-delivery']
  const observation = { phase: 'integrated', status: 'confirmed', targetDigest: executionDigest(requirement.target), evidenceRefs: ['github:branch:1'] }
  const expected = { commitSha, previousPhase: 'integrated',
    previousEvidenceDigest: executionDigest(observation.evidenceRefs) }
  const prepared = await adapter.prepareOperation({ kind: 'uat-delivery', operation: 'build', requirement,
    observation, runId: 'run-1', generation: 1, requirementDigest: executionDigest(requirement), expected })
  await assert.rejects(platform.operationAdapter.execute({ ...prepared, operationKey: '0'.repeat(64) }),
    { code: 'RELEASE_PLATFORM_OPERATION_INVALID' })
  assert.equal(state.calls.length, 0)
  const result = await platform.operationAdapter.execute(prepared)
  assert.equal(result.status, 'succeeded')
  assert.equal(state.calls.length, 1)
  assert.equal((await platform.operationAdapter.reconcile(prepared)).status, 'succeeded')
})

test('流水线未完成时回读 unknown，不发送第二次', async () => {
  const { platform, state } = fixture({ finish: false })
  const adapter = platform.releaseAdapters['uat-delivery']
  const observation = { phase: 'integrated', status: 'confirmed', targetDigest: executionDigest(requirement.target), evidenceRefs: ['github:branch:1'] }
  const prepared = await adapter.prepareOperation({ kind: 'uat-delivery', operation: 'build', requirement,
    observation, runId: 'run-1', generation: 1, requirementDigest: executionDigest(requirement),
    expected: { commitSha, previousPhase: 'integrated', previousEvidenceDigest: executionDigest(observation.evidenceRefs) } })
  assert.equal((await platform.operationAdapter.execute(prepared)).status, 'unknown')
  assert.equal((await platform.operationAdapter.reconcile(prepared)).status, 'unknown')
  assert.equal(state.calls.length, 1)
})

test('执行前再查：已有在途流水线不重触发，普通 UAT 失败须走重建', async () => {
  const ongoing = fixture()
  ongoing.state.pipeline.push({ number: 5, branch: target.branch, commitSha, status: 'running' })
  const observation = { phase: 'integrated', status: 'confirmed',
    targetDigest: executionDigest(requirement.target), evidenceRefs: ['github:branch:1'] }
  const prepared = await ongoing.platform.releaseAdapters['uat-delivery'].prepareOperation({ kind: 'uat-delivery',
    operation: 'build', requirement, observation, runId: 'run-1', generation: 1,
    requirementDigest: executionDigest(requirement), expected: { commitSha, previousPhase: 'integrated',
      previousEvidenceDigest: executionDigest(observation.evidenceRefs) } })
  assert.equal((await ongoing.platform.operationAdapter.execute(prepared)).status, 'unknown')
  assert.equal(ongoing.state.calls.length, 0)

  const failed = fixture()
  failed.state.pipeline.push({ number: 6, branch: target.branch, commitSha, status: 'failure' })
  await assert.rejects(failed.platform.releaseAdapters['uat-delivery'].inspect({ phase: 'preflight', requirement }),
    { code: 'RELEASE_PLATFORM_FAILED_BUILD_REQUIRES_REBUILD' })
})

test('运行态凭流水线 SHA→镜像摘要→Pod imageID 同链，Deployment 无源码注解也可确认', async () => {
  const childDigest = `sha256:${'c'.repeat(64)}`
  const good = fixture({ podDigest: childDigest, platformDigests: [childDigest] })
  good.state.pipeline.push({ number: 9, branch: target.branch, commitSha, status: 'success' })
  const effect = { prepared: { workflowKind: 'uat-delivery', targetDigest: executionDigest(requirement.target),
    operationKey: 'operation-1' }, receipt: { status: 'succeeded' } }
  const observed = await good.platform.releaseAdapters['uat-delivery'].inspect({ phase: 'runtime', requirement, effect })
  assert.equal(observed.facts.sourceSha, commitSha)
  assert.equal(observed.facts.registryDigest, imageDigest)
  assert.equal(observed.facts.runtimeDigest, childDigest)
  assert.equal(observed.facts.imageChainVerified, true)

  const drift = fixture({ podDigest: `sha256:${'d'.repeat(64)}`, platformDigests: [childDigest] })
  drift.state.pipeline.push({ number: 9, branch: target.branch, commitSha, status: 'success' })
  await assert.rejects(drift.platform.releaseAdapters['uat-delivery'].inspect({ phase: 'runtime', requirement, effect }),
    { code: 'RELEASE_PLATFORM_RUNTIME_UNCONFIRMED' })
  const missing = fixture({ buildDigest: 'unknown' })
  missing.state.pipeline.push({ number: 9, branch: target.branch, commitSha, status: 'success' })
  await assert.rejects(missing.platform.releaseAdapters['uat-delivery'].inspect({ phase: 'runtime', requirement, effect }),
    { code: 'RELEASE_PLATFORM_BUILD_DIGEST_UNCONFIRMED' })
})

test('生产机械预检不依赖业务布尔证明，审批回执只授权冻结的 Tag', async () => {
  const prodTarget = { ...target, kind: 'production-release', environment: 'production', branch: 'main',
    productionTriggerVerified: true }
  const prodRequirement = { ...requirement, target: { ...requirement.target, environment: 'production',
    releaseTag: 'v20260925-1' } }
  const { clients } = fixture()
  delete clients.attestations
  clients.github.resolveApprovedPullRequest = async () => ({ number: 75, baseBranch: 'main',
    mergeCommitSha: commitSha, merged: true, unique: true, evidenceRef: 'github:pr:75' })
  clients.github.readTag = async () => ({ exists: false, evidenceRef: 'github:tag:absent' })
  const tagWrites = []
  clients.github.createTag = async args => { tagWrites.push(args); return { evidenceRef: 'github:tag:created' } }
  const platform = createReleasePlatform({ targets: [prodTarget], clients })
  const adapter = platform.releaseAdapters['production-release']
  const preflight = await adapter.inspect({ phase: 'preflight', requirement: prodRequirement })
  assert.deepEqual(preflight.facts, {})
  const merged = { phase: 'merged', status: 'confirmed', targetDigest: executionDigest(prodRequirement.target),
    evidenceRefs: ['github:main:1'], facts: {} }
  const approvalScopeDigest = executionDigest({ target: prodRequirement.target, operation: 'tag' })
  const gate = await adapter.prepareOperation({ kind: 'production-release', operation: 'approval-gate',
    requirement: prodRequirement, observation: merged, runId: 'run-prod', generation: 1,
    requirementDigest: executionDigest(prodRequirement), expected: { commitSha, previousPhase: 'merged',
      previousEvidenceDigest: executionDigest(merged.evidenceRefs), approvalScopeDigest } })
  assert.equal(gate.expected.tag, prodRequirement.target.releaseTag)
  const receipt = await platform.operationAdapter.execute(gate)
  assert.equal(receipt.scopeDigest, approvalScopeDigest)
  const approved = await adapter.inspect({ phase: 'approved', requirement: prodRequirement,
    effect: { prepared: gate, receipt } })
  const tag = await adapter.prepareOperation({ kind: 'production-release', operation: 'tag',
    requirement: prodRequirement, observation: approved, runId: 'run-prod', generation: 1,
    requirementDigest: executionDigest(prodRequirement), expected: { commitSha, previousPhase: 'approved',
      previousEvidenceDigest: executionDigest(approved.evidenceRefs), approvalScopeDigest,
      approvalReceiptDigest: approved.facts.approvalReceiptDigest } })
  assert.equal(tag.expected.tag, prodRequirement.target.releaseTag)
  await assert.rejects(platform.operationAdapter.execute({ ...tag, expected: { ...tag.expected,
    approvalScopeDigest: '0'.repeat(64) } }), { code: 'RELEASE_PLATFORM_OPERATION_INVALID' })
  assert.equal((await platform.operationAdapter.execute(tag)).status, 'unknown')
  assert.equal(tagWrites.length, 1)
  assert.equal(tagWrites[0].tag, prodRequirement.target.releaseTag)
  assert.equal(tagWrites[0].target.releaseTag, prodRequirement.target.releaseTag)
  const nextRequirement = { ...prodRequirement, target: { ...prodRequirement.target, releaseTag: 'v20260926-2' } }
  const nextPreflight = await adapter.inspect({ phase: 'preflight', requirement: nextRequirement })
  assert.deepEqual(nextPreflight.facts, {})
  const nextMerged = { ...merged, targetDigest: executionDigest(nextRequirement.target) }
  const nextScope = executionDigest({ target: nextRequirement.target, operation: 'tag' })
  const nextGate = await adapter.prepareOperation({ kind: 'production-release', operation: 'approval-gate',
    requirement: nextRequirement, observation: nextMerged, runId: 'run-next', generation: 1,
    requirementDigest: executionDigest(nextRequirement), expected: { commitSha, previousPhase: 'merged',
      previousEvidenceDigest: executionDigest(nextMerged.evidenceRefs), approvalScopeDigest: nextScope } })
  assert.equal(nextGate.expected.tag, 'v20260926-2')
  assert.notEqual(nextGate.expected.approvalScopeDigest, gate.expected.approvalScopeDigest)
  await assert.rejects(platform.operationAdapter.execute({ ...gate, expected: { ...gate.expected,
    tag: 'v20260926-2' } }), { code: 'RELEASE_PLATFORM_OPERATION_INVALID' })
  const wrongImage = fixture({ buildImage: `${target.registry.image}:v20260924-1` })
  delete wrongImage.clients.attestations
  wrongImage.clients.github.resolveApprovedPullRequest = clients.github.resolveApprovedPullRequest
  wrongImage.clients.github.readTag = clients.github.readTag
  const wrongPlatform = createReleasePlatform({ targets: [prodTarget], clients: wrongImage.clients })
  wrongImage.state.pipeline.push({ number: 55, branch: 'main', ref: `refs/tags/${prodRequirement.target.releaseTag}`,
    commitSha, status: 'success' })
  await assert.rejects(wrongPlatform.releaseAdapters['production-release'].inspect({ phase: 'built',
    requirement: prodRequirement, effect: { prepared: tag, receipt: { status: 'succeeded' } } }),
  { code: 'RELEASE_PLATFORM_BUILD_DIGEST_UNCONFIRMED' })
})
