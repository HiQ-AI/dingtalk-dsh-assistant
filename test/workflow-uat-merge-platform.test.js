import test from 'node:test'
import assert from 'node:assert/strict'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createUatMergePlatform } from '../packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js'
import { createPlatformClients } from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'
import { createUatPrMergeTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-uat-pr-merge.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), MERGE = 'c'.repeat(40), TREE = 'd'.repeat(40)
const target = { id: 'dataset-uat', kind: 'uat-deployment', repository: 'HiQ-AI/dataset',
  service: 'dataset', branch: 'uat' }
const requirement = { request: '将开发 PR 合入 UAT', targetId: target.id,
  repository: target.repository, service: target.service, baseBranch: target.branch,
  pullRequestNumber: 42, headCommitSha: HEAD, requiredChecks: ['unit'], evidenceRefs: ['task:source'] }

function fixture({ failingCheck = false, driftHead = false, missingWrites = false } = {}) {
  let merged = false, calls = 0, checks = 0
  const github = {
    readPullRequest: async () => ({ number: 42, state: merged ? 'closed' : 'open', merged,
      draft: false, mergeable: true, baseBranch: 'uat', baseRepository: 'HiQ-AI/dataset',
      headRepository: 'HiQ-AI/dataset', headCommitSha: driftHead ? BASE : HEAD,
      baseCommitSha: BASE, mergeCommitSha: merged ? MERGE : null, evidenceRef: 'pr:42' }),
    readBranch: async () => ({ commitSha: merged ? MERGE : BASE, evidenceRef: 'branch:uat' }),
    readCommit: async ({ commitSha }) => ({ commitSha, treeSha: TREE, evidenceRef: `commit:${commitSha}` }),
    readChecks: async () => { checks++; return { complete: true, checks: [{ id: 1, name: 'unit',
      status: 'completed', conclusion: failingCheck ? 'failure' : 'success' }], evidenceRef: 'checks:unit' } },
    ...(!missingWrites ? { mergePullRequest: async () => { calls++; merged = true
      return { mergeCommitSha: MERGE, evidenceRef: 'dispatch:42' } } } : {}),
  }
  const platform = () => createUatMergePlatform({ targets: [target], policies: [{ targetId: target.id,
    requiredChecks: ['unit'] }], github })
  return { platform, get calls() { return calls }, get checks() { return checks } }
}

test('精确 PR、head、目标和检查通过后，合并经独立回读产生来源证明；再次执行不重发', async () => {
  const f = fixture(), p = f.platform()
  const observation = await p.adapter.inspect({ phase: 'preflight', requirement })
  const prepared = await p.adapter.prepareOperation({ requirement, observation, runId: 'run-1', generation: 1,
    requirementDigest: executionDigest(requirement) })
  const first = await p.operationAdapter.execute(prepared)
  assert.equal(first.status, 'succeeded')
  assert.equal(first.mergeCommitSha, MERGE)
  assert.equal((await p.operationAdapter.execute(prepared)).status, 'succeeded')
  assert.equal(f.calls, 1)
  const source = await p.adapter.inspect({ phase: 'merged', prepared, receipt: first })
  assert.equal(source.treeSha, TREE)
  assert.equal(source.headCommitSha, HEAD)
  assert.ok(source.evidenceRefs.length >= 4)
  assert.equal(createUatPrMergeTaskWorkflow({ adapter: p.adapter }).id, 'task-uat-pr-merge')
})

test('head 漂移、检查失败、未装写端口均阻断合并', async () => {
  for (const options of [{ driftHead: true }, { failingCheck: true }]) {
    const f = fixture(options)
    await assert.rejects(f.platform().adapter.inspect({ phase: 'preflight', requirement }),
      /UAT_MERGE_PR_DRIFT_OR_UNCONFIRMED|UAT_MERGE_REQUIRED_CHECK_NOT_PASSED/)
    assert.equal(f.calls, 0)
  }
  assert.throws(() => fixture({ missingWrites: true }).platform(), /UAT_MERGE_PLATFORM_UNAVAILABLE/)
})

test('GitHub 合并写端口默认关闭；开启后仅向冻结 PR/head 发送一次 PUT', async () => {
  assert.equal(createPlatformClients().github.mergePullRequest, undefined)
  let puts = 0
  const clients = createPlatformClients({ githubMergeWritesEnabled: true, githubToken: 'test',
    fetchImpl: async (url, options) => { puts++
      assert.equal(url, 'https://api.github.com/repos/HiQ-AI/dataset/pulls/42/merge')
      assert.equal(options.method, 'PUT')
      assert.deepEqual(JSON.parse(options.body), { sha: HEAD, merge_method: 'merge' })
      return { ok: true, status: 200, json: async () => ({ merged: true, sha: MERGE }) }
    } })
  const receipt = await clients.github.mergePullRequest({ repository: 'HiQ-AI/dataset', number: 42, headCommitSha: HEAD })
  assert.equal(receipt.mergeCommitSha, MERGE)
  assert.equal(puts, 1)
})

test('合并请求回执丢失后仅只读对账，恢复时不发送第二次', async () => {
  let merged = false, sends = 0
  const github = {
    readPullRequest: async () => ({ number: 42, state: merged ? 'closed' : 'open', merged,
      draft: false, mergeable: true, baseBranch: 'uat', baseRepository: 'HiQ-AI/dataset',
      headRepository: 'HiQ-AI/dataset', headCommitSha: HEAD, baseCommitSha: BASE,
      mergeCommitSha: merged ? MERGE : null, evidenceRef: 'pr:42' }),
    readBranch: async () => ({ commitSha: merged ? MERGE : BASE, evidenceRef: 'branch:uat' }),
    readCommit: async ({ commitSha }) => ({ commitSha, treeSha: TREE, evidenceRef: `commit:${commitSha}` }),
    readChecks: async () => ({ complete: true, checks: [{ id: 1, name: 'unit',
      status: 'completed', conclusion: 'success' }], evidenceRef: 'checks:unit' }),
    mergePullRequest: async () => { sends++; merged = true; throw new Error('response lost') },
  }
  const p = createUatMergePlatform({ targets: [target], policies: [{ targetId: target.id,
    requiredChecks: ['unit'] }], github })
  const observation = await p.adapter.inspect({ phase: 'preflight', requirement })
  const prepared = await p.adapter.prepareOperation({ requirement, observation, runId: 'run-timeout', generation: 1,
    requirementDigest: executionDigest(requirement) })
  await assert.rejects(p.operationAdapter.execute(prepared), /response lost/)
  assert.equal((await p.operationAdapter.reconcile(prepared)).status, 'succeeded')
  assert.equal((await p.operationAdapter.execute(prepared)).status, 'succeeded')
  assert.equal(sends, 1)
})

test('独立 UAT 合并流程经 Host 运行，最终产物通过 schema 并落到精确 Run', async t => {
  const f = fixture(), p = f.platform(), dir = await mkdtemp(join(tmpdir(), 'dsh-uat-merge-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'uat-merge', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
  const workflow = createUatPrMergeTaskWorkflow({ adapter: p.adapter })
  const delivery = { async execute({ prepared }) { return { state: 'succeeded',
    result: { result: await p.operationAdapter.execute(prepared) } } } }
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createRun({ commandId: 'create', runId: 'run-merge', taskId: 'task-1',
    workflowId: workflow.id, input: requirement })
  const state = await controller.whenIdle('run-merge')
  assert.equal(state.run.status, 'succeeded', JSON.stringify(state.nodes.map(node => [node.nodeId, node.waitReason])))
  const result = await artifacts.read(state.nodes.at(-1).outputRef)
  assert.equal(result.mergeCommitSha, MERGE)
  assert.equal(f.calls, 1)
})
