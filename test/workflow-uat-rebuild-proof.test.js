import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedWorkflowPlatforms } from '../packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js'

const target = { id: 'rebuild', kind: 'uat-rebuild', repository: 'HiQ-AI/dataset', environment: 'uat',
  service: 'dataset', runbookId: 'dataset-uat', branch: 'uat',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 1, cronName: 'build' },
  kubernetes: { namespace: 'uat', deployment: 'dataset' },
  registry: { image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset' }, entryUrl: 'https://uat.example.test/health' }
const currentSha = 'a'.repeat(40), previousSha = 'b'.repeat(40), imageDigest = `sha256:${'c'.repeat(64)}`

function fixture({ podDigest = imageDigest, newer = false } = {}) {
  const pipelines = [{ number: 20, commitSha: currentSha, branch: 'uat', status: 'failure' },
    { number: 19, commitSha: previousSha, branch: 'uat', status: 'success' },
    ...(newer ? [{ number: 21, commitSha: 'd'.repeat(40), branch: 'uat', status: 'running' }] : [])]
  const clients = { release: {
    github: { readBranch: async () => ({ commitSha: currentSha, evidenceRef: 'branch' }),
      readCommit: async ({ commitSha }) => ({ commitSha, treeSha: 'e'.repeat(40), evidenceRef: 'commit' }) },
    woodpecker: { listPipelines: async () => ({ complete: true, hasMore: false, pipelines, evidenceRef: 'scan' }),
      readBuildEvidence: async () => ({ pipelineNumber: 19, commitSha: previousSha, imageDigest,
        image: `${target.registry.image}:old`, evidenceRef: 'build' }), triggerBuild: async () => ({}) },
    registry: { readManifest: async () => ({ digest: imageDigest, platformDigests: [imageDigest], evidenceRef: 'manifest' }) },
    kubernetes: { readDeployment: async () => ({ uid: 'deployment-1', generation: 2, observedGeneration: 2,
      desiredReplicas: 1, readyReplicas: 1, ready: true, evidenceRef: 'deployment' }),
      readPods: async () => ({ complete: true, deploymentUid: 'deployment-1',
        pods: [{ deploymentUid: 'deployment-1', ready: true, imageDigest: podDigest }], evidenceRef: 'pods' }),
      readEntry: async () => ({}) },
  } }
  const platform = createTrustedWorkflowPlatforms({ config: { release: { targets: [target] } }, clients, ownerActorId: 'owner' })
  const requirement = { request: '同 SHA 重建', constraints: [], evidenceRefs: ['source'],
    target: { repository: target.repository, environment: 'uat', service: target.service,
      runbookId: target.runbookId, commitSha: currentSha } }
  return { platform, requirement }
}

test('UAT 重建证明直接读回失败流水线和当前 Pod 的旧成功制品', async () => {
  const { platform, requirement } = fixture()
  const observed = await platform.releaseAdapters['uat-rebuild'].inspect({ phase: 'preflight', requirement })
  assert.equal(observed.facts.failurePipelineVerified, true)
  assert.equal(observed.facts.noNewerRuntimeVersion, true)
  assert.ok(observed.evidenceRefs.some(ref => ref.startsWith('uat-rebuild-proof:')))
})

test('Pod 制品不符或有更新在途流水线时阻断重建', async () => {
  for (const scenario of [{ podDigest: `sha256:${'f'.repeat(64)}` }, { newer: true }]) {
    const { platform, requirement } = fixture(scenario)
    await assert.rejects(platform.releaseAdapters['uat-rebuild'].inspect({ phase: 'preflight', requirement }),
      { code: scenario.newer ? 'UAT_REBUILD_NEWER_PIPELINE_UNRESOLVED' : 'UAT_REBUILD_NEWER_RUNTIME_UNRESOLVED' })
  }
})
