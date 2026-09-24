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
      async triggerBuild(args) { state.calls.push(args); if (overrides.finish !== false) state.pipeline.push({ number: 1,
        commitSha, branch: target.branch, status: 'success' }); return { evidenceRef: 'woodpecker:trigger:1' } },
    },
    kubernetes: {
      async readDeployment() { return { sourceSha: commitSha, imageDigest, generation: 3,
        observedGeneration: 3, ready: true, evidenceRef: 'k8s:deployment:1' } },
      async readEntry() { return { accessible: true, evidenceRef: 'http:entry:1' } },
    },
    registry: { async readManifest() { return { digest: imageDigest, evidenceRef: 'registry:manifest:1' } } },
    attestations: { async read() { return { facts: { localE2ePassed: true, developmentPrVerified: true,
      uatPrVerified: true, sourcePackageSupported: true }, evidenceRef: 'attestation:1' } } },
  }
  return { platform: createReleasePlatform({ targets: [target], clients }), clients, state }
}

test('目标固定白名单，生产触发未证实则拒绝注册', () => {
  assert.throws(() => createReleasePlatform({ targets: [{ ...target, kind: 'production-release',
    environment: 'production', releaseTag: 'v20260925-1' }], clients: fixture().clients }),
  { code: 'RELEASE_PLATFORM_TARGET_INVALID' })
  const { platform } = fixture()
  assert.deepEqual(platform.configuredKinds, ['uat-delivery'])
  assert.throws(() => platform.targetFor({ ...requirement, target: { ...requirement.target,
    repository: 'Other/repo' } }, 'uat-delivery'), { code: 'RELEASE_PLATFORM_TARGET_NOT_ALLOWED' })
  assert.throws(() => createReleasePlatform({ targets: [target], clients: { ...fixture().clients,
    github: { readBranch: fixture().clients.github.readBranch } } }), { code: 'RELEASE_PLATFORM_CAPABILITY_MISSING' })
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
