import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'

const developmentSha = 'a'.repeat(40)
const mergeSha = 'b'.repeat(40)
const treeSha = 'c'.repeat(40)
const target = { id: 'uat', kind: 'uat-delivery', repository: 'HiQ-AI/dataset', environment: 'uat',
  service: 'dataset', runbookId: 'dataset-uat', branch: 'uat', businessE2eCheckIds: ['business-e2e'],
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1, cronName: 'build' },
  kubernetes: { namespace: 'uat', deployment: 'dataset' },
  registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' }, entryUrl: 'https://uat.example.test/health' }

function fixture({ tree = treeSha, e2e = true } = {}) {
  const outputs = {
    'verify-candidate': { candidate: { digest: 'd'.repeat(64), tree: treeSha },
      verification: { digest: 'e'.repeat(64), passed: true, checks: e2e ? [{ id: 'business-e2e', version: '1', passed: true }] : [] } },
    'prepare-commit': { commitId: developmentSha, candidateDigest: 'd'.repeat(64), tree: treeSha, verification: { digest: 'e'.repeat(64) } },
    commit: { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded' } },
    'prepare-push': { commitId: developmentSha, verificationDigest: 'e'.repeat(64) },
    push: { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded' } },
    'prepare-pr': { commitId: developmentSha },
    'create-pr': { prepared: { commitId: developmentSha }, receipt: { status: 'succeeded', number: 1, url: 'https://github.com/HiQ-AI/dataset/pull/1' } },
    finalize: { deliveryStatus: 'pr_verified', commitId: developmentSha, number: 1,
      url: 'https://github.com/HiQ-AI/dataset/pull/1', repo: 'HiQ-AI/dataset', head: 'feature/fix', base: 'uat', state: 'OPEN' },
  }
  const nodes = Object.keys(outputs).map(nodeId => ({ nodeId, status: 'succeeded', outputRef: `artifact:${nodeId}` }))
  const clients = { release: {
    github: {
      readBranch: async () => ({ commitSha: mergeSha, evidenceRef: 'branch' }),
      resolveApprovedPullRequest: async () => ({ number: 1, merged: true, unique: true, baseBranch: 'uat', mergeCommitSha: mergeSha, evidenceRef: 'unique-pr' }),
      readPullRequest: async () => ({ number: 1, merged: true, baseBranch: 'uat', headCommitSha: developmentSha, mergeCommitSha: mergeSha, evidenceRef: 'pr' }),
      readCommit: async ({ commitSha }) => ({ commitSha, treeSha: commitSha === mergeSha ? tree : treeSha, evidenceRef: `commit:${commitSha}` }),
    },
    woodpecker: { listPipelines: async () => ({ complete: true, hasMore: false, pipelines: [], evidenceRef: 'pipelines' }),
      readBuildEvidence: async () => ({}), triggerBuild: async () => ({}) },
    kubernetes: { readDeployment: async () => ({}), readPods: async () => ({}), readEntry: async () => ({}) },
    registry: { readManifest: async () => ({}) },
  } }
  const platform = createTrustedWorkflowPlatforms({ config: { release: { targets: [target] } }, clients, ownerActorId: 'owner' })
  platform.bindExecution({ controller: { state: async () => ({ run: { runId: 'engineering-run', taskId: 'task-1', workflowId: 'task-engineering', status: 'succeeded' }, nodes }) },
    artifacts: { read: async ref => outputs[ref.slice('artifact:'.length)] } })
  const requirement = { request: '交付 UAT', constraints: [], target: { repository: target.repository, environment: target.environment,
    service: target.service, runbookId: target.runbookId, commitSha: mergeSha },
  evidenceRefs: ['engineering-task:task-1:engineering-run'] }
  return { platform, requirement }
}

test('UAT 来源证明复用工程工件并独立核对 PR 与相同 Git tree', async () => {
  const { platform, requirement } = fixture()
  const prepared = await platform.prepareRequirement({ workflowId: 'task-uat-delivery',
    action: { arguments: { objective: '交付 UAT' }, constraints: [] },
    materials: [{ resourceRef: 'engineering-task:task-1:engineering-run' }] })
  assert.equal(prepared.target.commitSha, mergeSha)
  assert.ok(prepared.evidenceRefs.includes('engineering-task:task-1:engineering-run'))
  const result = await platform.releaseAdapters['uat-delivery'].inspect({ phase: 'preflight', requirement })
  assert.equal(result.facts.localE2ePassed, true)
  assert.equal(result.facts.sourcePackageSupported, true)
  assert.ok(result.evidenceRefs.some(ref => ref.startsWith('uat-source-proof:')))
})

test('缺业务 E2E 或 UAT merge tree 不一致时阻断发布', async () => {
  for (const scenario of [{ e2e: false }, { tree: 'f'.repeat(40) }]) {
    const { platform, requirement } = fixture(scenario)
    await assert.rejects(platform.releaseAdapters['uat-delivery'].inspect({ phase: 'preflight', requirement }),
      { code: scenario.e2e === false ? 'UAT_BUSINESS_E2E_UNCONFIRMED' : 'UAT_SOURCE_CHAIN_UNCONFIRMED' })
  }
})
