import { executionDigest, executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(code) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0

/** 目标只来自 Host 的 UAT 白名单，合并策略和必要检查也由 Host 固定。 */
export function createUatMergePlatform({ targets, policies, github }) {
  if (!Array.isArray(targets) || !Array.isArray(policies) || !github
    || ['readBranch', 'readPullRequest', 'readCommit', 'readChecks', 'mergePullRequest']
      .some(name => typeof github[name] !== 'function')) fail('UAT_MERGE_PLATFORM_UNAVAILABLE')
  const byId = new Map()
  for (const policy of policies) {
    const target = targets.find(item => item.id === policy.targetId && item.kind === 'uat-deployment')
    if (!target || !['dataset', 'dataset-web'].includes(target.service)
      || !Array.isArray(policy.requiredChecks) || !policy.requiredChecks.length
      || policy.requiredChecks.some(name => !nonempty(name))
      || new Set(policy.requiredChecks).size !== policy.requiredChecks.length
      || byId.has(policy.targetId) || Object.keys(policy).some(key => !['targetId', 'requiredChecks'].includes(key)))
      fail('UAT_MERGE_TARGET_INVALID')
    byId.set(policy.targetId, { target, requiredChecks: [...policy.requiredChecks] })
  }
  if (!byId.size) fail('UAT_MERGE_TARGET_REQUIRED')
  const read = async (method, args) => {
    const result = await github[method](structuredClone(args))
    if (!nonempty(result?.evidenceRef)) fail('UAT_MERGE_READBACK_UNCONFIRMED')
    return result
  }
  const selected = requirement => {
    const entry = byId.get(requirement?.targetId)
    if (!entry || requirement.repository !== entry.target.repository
      || requirement.service !== entry.target.service || requirement.baseBranch !== entry.target.branch
      || executionDigest(requirement.requiredChecks) !== executionDigest(entry.requiredChecks)
      || !sha(requirement.headCommitSha) || !Number.isInteger(requirement.pullRequestNumber)
      || requirement.pullRequestNumber < 1) fail('UAT_MERGE_TARGET_NOT_ALLOWED')
    return entry
  }
  async function preflight(requirement) {
    const { target, requiredChecks } = selected(requirement)
    const [pr, branch, head, checks] = await Promise.all([
      read('readPullRequest', { repository: target.repository, number: requirement.pullRequestNumber }),
      read('readBranch', { repository: target.repository, branch: target.branch }),
      read('readCommit', { repository: target.repository, commitSha: requirement.headCommitSha }),
      read('readChecks', { repository: target.repository, commitSha: requirement.headCommitSha }),
    ])
    if (pr.number !== requirement.pullRequestNumber || pr.state !== 'open' || pr.merged !== false
      || pr.draft === true || pr.mergeable !== true || pr.baseBranch !== target.branch
      || pr.baseRepository !== target.repository || pr.headRepository !== target.repository
      || pr.headCommitSha !== requirement.headCommitSha || pr.baseCommitSha !== branch.commitSha
      || !sha(head.treeSha) || checks.complete !== true || !Array.isArray(checks.checks))
      fail('UAT_MERGE_PR_DRIFT_OR_UNCONFIRMED')
    for (const name of requiredChecks) {
      const matching = checks.checks.filter(check => check.name === name)
      if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'success')
        fail('UAT_MERGE_REQUIRED_CHECK_NOT_PASSED')
    }
    return { status: 'confirmed', facts: { headTreeVerified: true, checksPassed: true, baseBound: true,
      baseCommitSha: branch.commitSha, headTreeSha: head.treeSha },
    evidenceRefs: [pr, branch, head, checks].map(item => item.evidenceRef) }
  }
  async function inspect({ phase, requirement, prepared, receipt }) {
    if (phase === 'preflight') return preflight(requirement)
    if (phase !== 'merged') fail('UAT_MERGE_PHASE_INVALID')
    const target = assertPrepared(prepared)
    const result = await reconcile(prepared)
    if (result.status !== 'succeeded' || receipt?.status !== 'succeeded'
      || result.mergeCommitSha !== receipt.mergeCommitSha) fail('UAT_MERGE_READBACK_UNCONFIRMED')
    return { status: 'confirmed', repository: target.repository, service: target.service,
      baseBranch: target.branch, pullRequestNumber: prepared.expected.pullRequestNumber,
      headCommitSha: prepared.expected.headCommitSha, mergeCommitSha: result.mergeCommitSha,
      treeSha: result.treeSha, evidenceRefs: result.evidenceRefs }
  }
  async function prepareOperation({ requirement, observation, runId, generation, requirementDigest }) {
    const { target } = selected(requirement)
    if (observation?.status !== 'confirmed' || observation.facts?.checksPassed !== true
      || !sha(observation.facts?.baseCommitSha) || !sha(observation.facts?.headTreeSha)
      || !nonempty(runId) || !Number.isInteger(generation) || !/^[a-f0-9]{64}$/u.test(requirementDigest ?? ''))
      fail('UAT_MERGE_PREPARE_INVALID')
    const expected = { targetId: requirement.targetId, pullRequestNumber: requirement.pullRequestNumber,
      headCommitSha: requirement.headCommitSha, baseCommitSha: observation.facts.baseCommitSha,
      headTreeSha: observation.facts.headTreeSha, requiredChecks: requirement.requiredChecks,
      preflightDigest: executionDigest(observation.evidenceRefs) }
    const targetDigest = executionDigest(requirement)
    return { action: 'external', workflowKind: 'uat-pr-merge', operation: 'merge-uat-pr', runId, generation,
      requirementDigest, resourceKey: `external:uat:${target.repository}:${target.service}:${target.branch}`,
      targetDigest, expected, operationKey: executionDigest({ runId, generation, requirementDigest,
        targetDigest, expected }) }
  }
  function assertPrepared(prepared) {
    const { expected } = prepared ?? {}
    const match = byId.get(expected?.targetId)
    if (!match) fail('UAT_MERGE_OPERATION_INVALID')
    const { target, requiredChecks } = match
    if (!(
      prepared.resourceKey === `external:uat:${target.repository}:${target.service}:${target.branch}`
      && executionDigest(expected?.requiredChecks) === executionDigest(requiredChecks))) fail('UAT_MERGE_OPERATION_INVALID')
    if (prepared.action !== 'external' || prepared.workflowKind !== 'uat-pr-merge'
      || prepared.operation !== 'merge-uat-pr' || !nonempty(prepared.runId)
      || !Number.isInteger(prepared.generation) || !/^[a-f0-9]{64}$/u.test(prepared.requirementDigest ?? '')
      || !/^[a-f0-9]{64}$/u.test(prepared.targetDigest ?? '')
      || !Number.isInteger(expected?.pullRequestNumber) || expected.pullRequestNumber < 1
      || !sha(expected.headCommitSha) || !sha(expected.baseCommitSha) || !sha(expected.headTreeSha)
      || !/^[a-f0-9]{64}$/u.test(expected.preflightDigest ?? '')
      || prepared.operationKey !== executionDigest({ runId: prepared.runId,
        generation: prepared.generation, requirementDigest: prepared.requirementDigest,
        targetDigest: prepared.targetDigest, expected })) fail('UAT_MERGE_OPERATION_INVALID')
    return target
  }
  async function reconcile(prepared) {
    const target = assertPrepared(prepared), expected = prepared.expected
    const pr = await read('readPullRequest', { repository: target.repository, number: expected.pullRequestNumber })
    if (pr.number !== expected.pullRequestNumber || pr.baseBranch !== target.branch
      || pr.headCommitSha !== expected.headCommitSha) fail('UAT_MERGE_PR_IDENTITY_DRIFT')
    if (!pr.merged || !sha(pr.mergeCommitSha)) return { status: 'unknown', operationKey: prepared.operationKey,
      evidenceRefs: [pr.evidenceRef] }
    const [merge, head, branch] = await Promise.all([
      read('readCommit', { repository: target.repository, commitSha: pr.mergeCommitSha }),
      read('readCommit', { repository: target.repository, commitSha: expected.headCommitSha }),
      read('readBranch', { repository: target.repository, branch: target.branch }),
    ])
    if (merge.treeSha !== expected.headTreeSha || head.treeSha !== expected.headTreeSha
      || branch.commitSha !== pr.mergeCommitSha) fail('UAT_MERGE_SOURCE_TREE_OR_BRANCH_UNCONFIRMED')
    return { status: 'succeeded', operationKey: prepared.operationKey,
      mergeCommitSha: pr.mergeCommitSha, treeSha: merge.treeSha,
      evidenceRef: pr.evidenceRef, evidenceRefs: [pr, merge, head, branch].map(item => item.evidenceRef) }
  }
  async function execute(prepared) {
    const target = assertPrepared(prepared), expected = prepared.expected
    // 先只读对账。执行过但响应丢失时直接收敛，不发第二次合并请求。
    const prior = await reconcile(prepared)
    if (prior.status === 'succeeded') return prior
    const requirement = { targetId: expected.targetId,
      repository: target.repository, service: target.service, baseBranch: target.branch,
      pullRequestNumber: expected.pullRequestNumber, headCommitSha: expected.headCommitSha,
      requiredChecks: expected.requiredChecks }
    const observed = await preflight(requirement)
    if (observed.facts.baseCommitSha !== expected.baseCommitSha
      || observed.facts.headTreeSha !== expected.headTreeSha
      || executionDigest(observed.evidenceRefs) !== expected.preflightDigest)
      fail('UAT_MERGE_PREFLIGHT_DRIFT')
    // GitHub 接收后的网络不确定性留给 reconcile；效果账不得重发。
    await read('mergePullRequest', { repository: target.repository, number: expected.pullRequestNumber,
      headCommitSha: expected.headCommitSha })
    return reconcile(prepared)
  }
  return { adapter: { id: 'trusted-uat-pr-merge', version: '1',
    rulesDigest: executionDigest({ targets: [...byId].map(([id, value]) => ({ id,
      repository: value.target.repository, branch: value.target.branch, requiredChecks: value.requiredChecks })) }),
    inspect, prepareOperation }, operationAdapter: { execute, reconcile }, configuredTargetIds: [...byId.keys()] }
}
