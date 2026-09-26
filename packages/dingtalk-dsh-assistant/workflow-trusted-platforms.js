import { createHash } from 'node:crypto'
import { executionDigest, executionError } from './execution-artifacts.js'
import { createReleasePlatform } from './workflow-release-platform.js'
import { createUatMergePlatform } from './workflow-uat-merge-platform.js'
import { createBytebaseDataChangePlatform } from './workflow-bytebase-platform.js'
import { readEngineeringDeliveryProof } from './workflow-engineering.js'

const requireText = (value, code) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw executionError(code)
  return value
}
const digestText = value => createHash('sha256').update(value, 'utf8').digest('hex')

/** 将已认证的平台端口接到固定工作流。配置只保存目标白名单，不保存凭据。 */
export function createTrustedWorkflowPlatforms({ config, clients, ownerActorId }) {
  const owner = requireText(ownerActorId, 'EXTERNAL_OWNER_REQUIRED')
  const productionApprovers = config?.productionApproverActorIds ?? [owner]
  if (!Array.isArray(productionApprovers) || !productionApprovers.length
    || productionApprovers.some(id => typeof id !== 'string' || !id.trim()))
    throw executionError('PRODUCTION_APPROVER_INVALID')
  const releaseTargets = new Map((config.release?.targets ?? []).map(target => [target.id, target]))
  let execution
  async function readUatRebuildAttestation({ target }) {
    const selected = [...releaseTargets.values()].find(item => item.kind === 'uat-rebuild'
      && item.repository === target.repository && item.environment === target.environment
      && item.service === target.service && item.runbookId === target.runbookId)
    if (!selected) throw executionError('UAT_REBUILD_TARGET_UNRESOLVED')
    const { github, woodpecker, registry, kubernetes } = clients.release
    if (typeof github.readCommit !== 'function') throw executionError('UAT_REBUILD_SOURCE_UNCONFIRMED')
    const [branch, commit, scan] = await Promise.all([
      github.readBranch({ repository: target.repository, branch: selected.branch }),
      github.readCommit({ repository: target.repository, commitSha: target.commitSha }),
      woodpecker.listPipelines({ baseUrl: selected.woodpecker.baseUrl,
        repositoryId: selected.woodpecker.repositoryId }),
    ])
    if (branch.commitSha !== target.commitSha || commit.commitSha !== target.commitSha
      || !/^[a-f0-9]{40}$/u.test(commit.treeSha ?? '') || scan.complete !== true || scan.hasMore !== false
      || !Array.isArray(scan.pipelines) || ![branch, commit, scan].every(item => item.evidenceRef))
      throw executionError('UAT_REBUILD_SOURCE_UNCONFIRMED')
    const relevant = scan.pipelines.filter(row => row.branch === selected.branch)
    if (relevant.some(row => !Number.isInteger(row.number) || row.number < 1
      || !/^[a-f0-9]{40}$/u.test(row.commitSha ?? '') || typeof row.status !== 'string')
      || new Set(scan.pipelines.map(row => row.number)).size !== scan.pipelines.length)
      throw executionError('UAT_REBUILD_PIPELINE_LIST_INVALID')
    const failures = relevant.filter(row => row.commitSha === target.commitSha
      && ['failure', 'error', 'killed'].includes(row.status)).sort((a, b) => b.number - a.number)
    if (!failures.length || relevant.some(row => row.commitSha === target.commitSha
      && ['created', 'pending', 'running', 'blocked', 'success'].includes(row.status)))
      throw executionError('UAT_REBUILD_FAILURE_UNCONFIRMED')
    const failure = failures[0]
    if (relevant.some(row => row.number > failure.number
      && ['created', 'pending', 'running', 'blocked', 'success'].includes(row.status)))
      throw executionError('UAT_REBUILD_NEWER_PIPELINE_UNRESOLVED')
    const previous = relevant.filter(row => row.number < failure.number && row.status === 'success')
      .sort((a, b) => b.number - a.number)[0]
    if (!previous) throw executionError('UAT_REBUILD_RUNTIME_BASELINE_UNRESOLVED')
    const build = await woodpecker.readBuildEvidence({ baseUrl: selected.woodpecker.baseUrl,
      repositoryId: selected.woodpecker.repositoryId, pipelineNumber: previous.number })
    if (build.pipelineNumber !== previous.number || build.commitSha !== previous.commitSha
      || !/^sha256:[a-f0-9]{64}$/u.test(build.imageDigest ?? '')
      || !build.image?.startsWith(`${selected.registry.image}:`) || !build.evidenceRef)
      throw executionError('UAT_REBUILD_RUNTIME_BASELINE_UNRESOLVED')
    const [manifest, deployment] = await Promise.all([
      registry.readManifest({ image: selected.registry.image, digest: build.imageDigest }),
      kubernetes.readDeployment(selected.kubernetes),
    ])
    const pods = await kubernetes.readPods({ ...selected.kubernetes, deploymentUid: deployment.uid })
    if (manifest.digest !== build.imageDigest || !Array.isArray(manifest.platformDigests)
      || !manifest.platformDigests.length || deployment.ready !== true
      || deployment.readyReplicas !== deployment.desiredReplicas || deployment.desiredReplicas < 1
      || deployment.observedGeneration < deployment.generation || pods.complete !== true
      || pods.deploymentUid !== deployment.uid || pods.pods?.length !== deployment.desiredReplicas
      || pods.pods.some(pod => pod.ready !== true || pod.deploymentUid !== deployment.uid
        || !manifest.platformDigests.includes(pod.imageDigest))
      || ![build, manifest, deployment, pods].every(item => item.evidenceRef))
      throw executionError('UAT_REBUILD_NEWER_RUNTIME_UNRESOLVED')
    return { facts: { failurePipelineVerified: true, branchHeadMatches: true,
      noNewerRuntimeVersion: true, sourcePackageSupported: true },
      evidenceRef: `uat-rebuild-proof:${executionDigest({ target, failure: failure.number,
        baseline: previous.number, refs: [branch, commit, scan, build, manifest, deployment, pods]
          .map(item => item.evidenceRef) })}` }
  }
  async function readUatAttestation({ kind, target }) {
    if (kind !== 'uat-rebuild') throw executionError('UAT_PROOF_UNAVAILABLE')
    return readUatRebuildAttestation({ target })
  }
  async function verifyEngineeringDeploymentSource({ marker, target, selected }) {
    if (!execution) throw executionError('UAT_EXECUTION_BINDING_INVALID')
    const [, taskId, runId] = marker.split(':')
    const state = await execution.controller.state(runId)
    const proof = await readEngineeringDeliveryProof({ state, artifacts: execution.artifacts, store: execution.store, taskId })
    if (proof.pullRequest.repository !== target.repository) throw executionError('UAT_ENGINEERING_SOURCE_UNCONFIRMED')
    const github = clients.release.github
    if (typeof github.readCommit !== 'function' || typeof github.readPullRequest !== 'function'
      || typeof github.resolveApprovedPullRequest !== 'function') throw executionError('UAT_GITHUB_PROOF_UNAVAILABLE')
    const [pr, developmentCommit, targetCommit, approved] = await Promise.all([
      github.readPullRequest({ repository: target.repository, number: proof.pullRequest.number }),
      github.readCommit({ repository: target.repository, commitSha: proof.commitSha }),
      github.readCommit({ repository: target.repository, commitSha: target.commitSha }),
      github.resolveApprovedPullRequest({ repository: target.repository, baseBranch: selected.branch,
        mergeCommitSha: target.commitSha }),
    ])
    if (pr.number !== proof.pullRequest.number || pr.merged !== true || pr.baseBranch !== selected.branch
      || pr.headCommitSha !== proof.commitSha || pr.mergeCommitSha !== target.commitSha
      || approved.number !== pr.number || approved.unique !== true || approved.mergeCommitSha !== target.commitSha
      || developmentCommit.commitSha !== proof.commitSha || targetCommit.commitSha !== target.commitSha
      || developmentCommit.treeSha !== proof.treeSha || targetCommit.treeSha !== proof.treeSha
      || [pr, developmentCommit, targetCommit, approved].some(item => !item.evidenceRef))
      throw executionError('UAT_SOURCE_CHAIN_UNCONFIRMED')
    return `uat-source-proof:${executionDigest({ target, runId, refs: proof.evidenceRefs,
      live: [pr, developmentCommit, targetCommit, approved].map(item => item.evidenceRef) })}`
  }
  async function readUatMergeDeliveryProof({ marker, taskId }) {
    if (!execution) throw executionError('UAT_EXECUTION_BINDING_INVALID')
    const [, sourceTaskId, runId] = marker.split(':')
    if (!taskId || sourceTaskId !== taskId) throw executionError('UAT_MERGE_TASK_MISMATCH')
    const state = await execution.controller.state(runId)
    const final = state?.nodes?.find(node => node.nodeId === 'verify-source')
    if (state?.run?.runId !== runId || state.run.taskId !== taskId
      || state.run.workflowId !== 'task-uat-pr-merge' || state.run.status !== 'succeeded'
      || final?.status !== 'succeeded' || !final.outputRef)
      throw executionError('UAT_MERGE_RUN_UNCONFIRMED')
    const proof = await execution.artifacts.read(final.outputRef)
    if (proof?.status !== 'confirmed' || !/^[a-f0-9]{40}$/u.test(proof.headCommitSha ?? '')
      || !/^[a-f0-9]{40}$/u.test(proof.mergeCommitSha ?? '')
      || !/^[a-f0-9]{40}$/u.test(proof.treeSha ?? '')
      || !Number.isInteger(proof.pullRequestNumber) || proof.pullRequestNumber < 1
      || !Array.isArray(proof.evidenceRefs) || !proof.evidenceRefs.length
      || proof.evidenceRefs.some(ref => typeof ref !== 'string' || !ref))
      throw executionError('UAT_MERGE_ARTIFACT_UNCONFIRMED')
    return { proof, runId, outputRef: final.outputRef }
  }
  async function verifyUatMergeDeploymentSource({ marker, taskId, target, selected, delivered }) {
    const source = delivered ?? await readUatMergeDeliveryProof({ marker, taskId })
    const { proof, runId, outputRef } = source
    if (proof.repository !== target.repository || proof.service !== target.service
      || proof.baseBranch !== selected.branch || proof.mergeCommitSha !== target.commitSha)
      throw executionError('UAT_MERGE_SOURCE_MISMATCH')
    const github = clients.release.github
    const [pr, head, merge, approved, branch] = await Promise.all([
      github.readPullRequest({ repository: target.repository, number: proof.pullRequestNumber }),
      github.readCommit({ repository: target.repository, commitSha: proof.headCommitSha }),
      github.readCommit({ repository: target.repository, commitSha: proof.mergeCommitSha }),
      github.resolveApprovedPullRequest({ repository: target.repository, baseBranch: selected.branch,
        mergeCommitSha: proof.mergeCommitSha }),
      github.readBranch({ repository: target.repository, branch: selected.branch }),
    ])
    if (pr.number !== proof.pullRequestNumber || pr.merged !== true || pr.baseBranch !== selected.branch
      || pr.headCommitSha !== proof.headCommitSha || pr.mergeCommitSha !== proof.mergeCommitSha
      || head.treeSha !== proof.treeSha || merge.treeSha !== proof.treeSha
      || approved.unique !== true || approved.number !== pr.number || approved.mergeCommitSha !== proof.mergeCommitSha
      || branch.commitSha !== proof.mergeCommitSha
      || [pr, head, merge, approved, branch].some(item => !item.evidenceRef))
      throw executionError('UAT_MERGE_SOURCE_CHAIN_UNCONFIRMED')
    return `uat-merge-source-proof:${executionDigest({ target, taskId, runId, outputRef,
      artifact: executionDigest(proof), refs: [pr, head, merge, approved, branch].map(item => item.evidenceRef) })}`
  }
  const release = config?.release?.targets?.length
    ? createReleasePlatform({ targets: config.release.targets.map(({ id, ...target }) => target),
      clients: { ...clients?.release, attestations: { read: readUatAttestation } } })
    : null
  const uatMerge = config?.uatMerge?.targets?.length
    ? createUatMergePlatform({ targets: config.release?.targets ?? [],
      policies: config.uatMerge.targets, github: clients?.release?.github }) : null
  let boundStore = null
  async function readDataApproval({ runId, generation, requirementDigest, resourceKey,
    scopeDigest, issueId, planId, sheetId, target, sheetSha256, packageDigest, requestId }) {
    const expectedScope = executionDigest({ runId, generation, issueId, planId, sheetId,
      target, sheetSha256, packageDigest })
    if (!boundStore || scopeDigest !== expectedScope) throw executionError('BYTEBASE_APPROVAL_PROOF_REQUIRED')
    const effects = await boundStore.query({ kind: 'effect.list', runId })
    const gates = effects.filter(effect => effect.definition?.action === 'external'
      && effect.definition.payload?.workflowKind === 'data-change'
      && effect.definition.payload.stage === 'approval-gate'
      && effect.generation === generation
      && effect.definition.payload.requirementDigest === requirementDigest
      && effect.definition.payload.resourceKey === resourceKey
      && effect.definition.payload.intent?.scopeDigest === scopeDigest
      && effect.definition.payload.intent?.issueId === issueId
      && effect.definition.payload.intent?.planId === planId
      && effect.definition.payload.intent?.sheetId === sheetId
      && effect.definition.payload.intent?.sheetSha256 === sheetSha256
      && effect.definition.payload.intent?.packageDigest === packageDigest
      && executionDigest(effect.definition.payload.target) === executionDigest(target))
    if (gates.length !== 1 || gates[0].state !== 'succeeded'
      || !gates[0].requestId || (requestId && gates[0].requestId !== requestId)
      || gates[0].result?.status !== 'succeeded'
      || gates[0].result?.result?.scopeDigest !== scopeDigest
      || gates[0].result?.result?.operationKey !== gates[0].definition.payload.intent.operationKey)
      throw executionError('BYTEBASE_APPROVAL_PROOF_REQUIRED')
    const approval = await boundStore.query({ kind: 'approval.get', requestId: gates[0].requestId })
    if (approval.effectId !== gates[0].effectId || approval.decision !== 'approved'
      || approval.revoked || approval.decisionSource !== 'web' || !approval.decidedBy)
      throw executionError('BYTEBASE_APPROVAL_PROOF_REQUIRED')
    return { decision: 'approved', source: 'assistant', human: true, issueId, planId, sheetId,
      target, sheetSha256, packageDigest, scopeDigest,
      requestId: gates[0].requestId, decidedBy: approval.decidedBy }
  }
  const bytebase = config?.bytebase?.targets?.length
    ? createBytebaseDataChangePlatform({ config: config.bytebase, api: clients?.bytebase,
      productionApi: clients?.productionPostgres,
      uatApi: clients?.uatPostgres, approvalApi: { getApproval: readDataApproval } })
    : null
  if (!release && !bytebase && !uatMerge) return null
  const databaseTargets = new Map((config.bytebase?.targets ?? []).map(target => [target.id, target]))
  if ([...releaseTargets.keys(), ...databaseTargets.keys()].some(id => !id || typeof id !== 'string')
    || releaseTargets.size !== (config.release?.targets?.length ?? 0)
    || databaseTargets.size !== (config.bytebase?.targets?.length ?? 0)) throw executionError('EXTERNAL_TARGET_ID_INVALID')
  function bindExecution(value) {
    if (execution || typeof value?.controller?.state !== 'function' || typeof value?.artifacts?.read !== 'function'
      || typeof value?.store?.query !== 'function')
      throw executionError('UAT_EXECUTION_BINDING_INVALID')
    execution = value
  }
  async function prepareRequirement({ workflowId, action, materials }) {
    const request = requireText(action.arguments?.objective, 'EXTERNAL_OBJECTIVE_REQUIRED')
    const constraints = [...new Set(action.constraints ?? [])]
    if (workflowId === 'task-uat-pr-merge') {
      if (!uatMerge) throw executionError('UAT_MERGE_PLATFORM_UNAVAILABLE')
      const targetId = requireText(action.arguments?.targetId, 'UAT_MERGE_TARGET_REQUIRED')
      const selected = releaseTargets.get(targetId)
      const policy = config.uatMerge.targets.find(item => item.targetId === targetId)
      if (!selected || selected.kind !== 'uat-deployment' || !policy)
        throw executionError('UAT_MERGE_TARGET_NOT_ALLOWED')
      const pullRequestNumber = action.arguments?.pullRequestNumber
      const headCommitSha = action.arguments?.headCommitSha
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1
        || !/^[a-f0-9]{40}$/u.test(headCommitSha ?? ''))
        throw executionError('UAT_MERGE_PR_IDENTITY_REQUIRED')
      return { request, targetId, repository: selected.repository, service: selected.service,
        baseBranch: selected.branch, pullRequestNumber, headCommitSha,
        requiredChecks: [...policy.requiredChecks],
        evidenceRefs: (materials ?? []).map(item => item.resourceRef).filter(Boolean).concat(`uat-target:${targetId}`) }
    }
    if (release && workflowId !== 'task-data-change') {
      const kind = workflowId.slice('task-'.length)
      const markers = (materials ?? []).filter(item => /^engineering-task:[^:]+:[^:]+$/u.test(item.resourceRef ?? ''))
      const mergeMarkers = (materials ?? []).filter(item => /^uat-merge-task:[^:]+:[^:]+$/u.test(item.resourceRef ?? ''))
      if (mergeMarkers.length > 1 || markers.length + mergeMarkers.length > 1
        || (mergeMarkers.length && kind !== 'uat-deployment'))
        throw executionError('UAT_SOURCE_NOT_UNIQUE')
      const delivered = mergeMarkers.length
        ? await readUatMergeDeliveryProof({ marker: mergeMarkers[0].resourceRef, taskId: action.taskId }) : null
      let selected = releaseTargets.get(action.arguments?.targetId)
      if (action.arguments?.targetId !== undefined && !selected) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      if (kind === 'uat-deployment' && markers.length === 1 && !selected) {
        if (!execution) throw executionError('UAT_EXECUTION_BINDING_INVALID')
        const [, taskId, runId] = markers[0].resourceRef.split(':')
        const state = await execution.controller.state(runId)
        const proof = await readEngineeringDeliveryProof({ state, artifacts: execution.artifacts, store: execution.store, taskId })
        const matches = [...releaseTargets.values()].filter(item => item.kind === kind
          && item.repository === proof.pullRequest.repository)
        if (matches.length !== 1) throw executionError('EXTERNAL_TARGET_NOT_UNIQUE')
        selected = matches[0]
      }
      if (kind === 'uat-deployment' && delivered && !selected) {
        const matches = [...releaseTargets.values()].filter(item => item.kind === kind
          && item.repository === delivered.proof.repository && item.service === delivered.proof.service
          && item.branch === delivered.proof.baseBranch)
        if (matches.length !== 1) throw executionError('EXTERNAL_TARGET_NOT_UNIQUE')
        selected = matches[0]
      }
      if (!selected || selected.kind !== kind || !release.configuredKinds.includes(kind)) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      if (markers.length && (kind !== 'uat-deployment' || markers.length !== 1)) throw executionError('UAT_ENGINEERING_RUN_UNRESOLVED')
      const suppliedCommitSha = action.arguments?.commitSha
      const releaseTag = kind === 'production-release'
        ? requireText(action.arguments.releaseTag, 'EXTERNAL_RELEASE_TAG_REQUIRED') : null
      if (kind !== 'production-release' && action.arguments.releaseTag !== undefined)
        throw executionError('EXTERNAL_RELEASE_TAG_UNEXPECTED')
      const head = await clients.release.github.readBranch({ repository: selected.repository, branch: selected.branch })
      const commitSha = suppliedCommitSha ?? (delivered ? delivered.proof.mergeCommitSha : markers.length ? head.commitSha : null)
      requireText(commitSha, 'EXTERNAL_COMMIT_REQUIRED')
      if (head.commitSha !== commitSha || !head.evidenceRef) throw executionError('EXTERNAL_COMMIT_NOT_BRANCH_HEAD')
      const target = { repository: selected.repository, environment: selected.environment,
        service: selected.service, commitSha, runbookId: selected.runbookId,
        ...(releaseTag ? { releaseTag } : {}) }
      release.targetFor({ target }, kind)
      const sourceProof = markers.length ? await verifyEngineeringDeploymentSource({
        marker: markers[0].resourceRef, target, selected }) : delivered
          ? await verifyUatMergeDeploymentSource({ marker: mergeMarkers[0].resourceRef,
            taskId: action.taskId, target, selected, delivered }) : null
      return { request, target, constraints, evidenceRefs: [head.evidenceRef,
        ...(materials ?? []).map(item => item.resourceRef), ...(sourceProof ? [sourceProof] : [])] }
    }
    if (bytebase && workflowId === 'task-data-change') {
      const targetId = requireText(action.arguments?.targetId, 'EXTERNAL_TARGET_ID_REQUIRED')
      const selected = databaseTargets.get(targetId)
      if (!selected) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      const changeRef = requireText(action.arguments.changeRef, 'EXTERNAL_CHANGE_REF_REQUIRED')
      const source = materials.find(item => item.resourceRef === changeRef)
      if (!source?.text) throw executionError('EXTERNAL_MATERIAL_NOT_FOUND')
      const snapshot = await clients.productionPostgres.readBaseline({ project: selected.project,
        target: selected.target, scope: 'current' })
      if (snapshot?.project !== selected.project || executionDigest(snapshot.target) !== executionDigest(selected.target)
        || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId
        || !/^[a-f0-9]{64}$/.test(snapshot.sha256 ?? '') || typeof snapshot.evidenceRef !== 'string'
        || !snapshot.evidenceRef) throw executionError('EXTERNAL_BASELINE_UNCONFIRMED')
      return { request, constraints, target: selected.target,
        sources: [{ id: changeRef, sha256: digestText(source.text), content: source.text }],
        baseline: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 } }
    }
    throw executionError('EXTERNAL_WORKFLOW_NOT_CONFIGURED')
  }
  const operationAdapter = {
    execute: prepared => prepared.workflowKind === 'data-change'
      ? bytebase?.externalAdapter.execute(prepared)
      : prepared.workflowKind === 'uat-pr-merge'
        ? uatMerge?.operationAdapter.execute(prepared) : release?.operationAdapter.execute(prepared),
    reconcile: prepared => prepared.workflowKind === 'data-change'
      ? bytebase?.externalAdapter.reconcile(prepared)
      : prepared.workflowKind === 'uat-pr-merge'
        ? uatMerge?.operationAdapter.reconcile(prepared) : release?.operationAdapter.reconcile(prepared),
  }
  function bindStore(store) {
    if (typeof store?.query !== 'function' || (boundStore && boundStore !== store))
      throw executionError('EXTERNAL_STORE_BINDING_INVALID')
    boundStore = store
  }
  async function assertProductionTagApproval(prepared) {
    if (!boundStore || !/^[a-f0-9]{64}$/.test(prepared.expected?.approvalReceiptDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(prepared.expected?.approvalScopeDigest ?? '')
      || !/^v\d{8}-[1-9]\d*$/.test(prepared.expected?.tag ?? ''))
      throw executionError('RELEASE_APPROVAL_PROOF_REQUIRED')
    const effects = await boundStore.query({ kind: 'effect.list', runId: prepared.runId })
    const gates = effects.filter(effect => effect.definition?.action === 'external'
      && effect.definition.payload?.workflowKind === 'production-release'
      && effect.definition.payload.operation === 'approval-gate'
      && effect.generation === prepared.generation
      && effect.definition.payload.requirementDigest === prepared.requirementDigest
      && effect.definition.payload.targetDigest === prepared.targetDigest
      && effect.definition.payload.resourceKey === prepared.resourceKey
      && effect.definition.payload.expected?.commitSha === prepared.expected.commitSha
      && effect.definition.payload.expected?.tag === prepared.expected.tag
      && effect.definition.payload.expected?.approvalScopeDigest === prepared.expected.approvalScopeDigest)
    if (gates.length !== 1 || gates[0].state !== 'succeeded' || !gates[0].requestId
      || gates[0].result?.status !== 'succeeded'
      || gates[0].result?.result?.scopeDigest !== prepared.expected.approvalScopeDigest
      || executionDigest(gates[0].result.result) !== prepared.expected.approvalReceiptDigest)
      throw executionError('RELEASE_APPROVAL_PROOF_REQUIRED')
    const approval = await boundStore.query({ kind: 'approval.get', requestId: gates[0].requestId })
    if (approval.effectId !== gates[0].effectId || approval.decision !== 'approved'
      || approval.revoked || approval.decisionSource !== 'web' || !approval.decidedBy)
      throw executionError('RELEASE_APPROVAL_PROOF_REQUIRED')
  }
  async function authorizeExternal({ binding, prepared }) {
    if (!binding?.runId || prepared?.runId !== binding.runId || prepared.generation !== binding.generation)
      throw executionError('EXTERNAL_AUTHORIZATION_IDENTITY_INVALID')
    if (prepared.workflowKind === 'uat-pr-merge') {
      if (!uatMerge || prepared.operation !== 'merge-uat-pr'
        || !uatMerge.configuredTargetIds.includes(prepared.expected?.targetId))
        throw executionError('UAT_MERGE_TARGET_NOT_ALLOWED')
      return { principalId: owner,
        authorizationRef: `uat-merge:${executionDigest([binding.runId, binding.nodeRunId, prepared])}` }
    }
    if (prepared.workflowKind === 'data-change') {
      if (!bytebase || ![...databaseTargets.values()].some(item => executionDigest(item.target) === executionDigest(prepared.target)))
        throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      if (prepared.stage === 'approval-gate') return { principalId: owner, approval: {
        requestId: `external:${executionDigest([binding.runId, binding.nodeRunId, prepared])}`,
        approverIds: [...new Set(productionApprovers)],
      } }
      if (prepared.stage === 'execute-task') await readDataApproval({
        runId: prepared.runId, generation: prepared.generation,
        requirementDigest: prepared.requirementDigest, resourceKey: prepared.resourceKey,
        scopeDigest: prepared.intent?.approvalScopeDigest, issueId: prepared.intent?.issueId,
        planId: prepared.intent?.planId, sheetId: prepared.intent?.sheetId,
        target: prepared.target,
        sheetSha256: prepared.applySqlSha256, packageDigest: prepared.packageDigest,
        requestId: prepared.approvalRequestId,
      })
      return { principalId: owner, authorizationRef: `bytebase:${executionDigest([binding.runId, binding.nodeRunId, prepared])}` }
    } else if (!release || !release.configuredKinds.includes(prepared.workflowKind)) {
      throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
    }
    if (prepared.workflowKind === 'production-release' && prepared.operation !== 'approval-gate') {
      if (prepared.operation === 'tag') await assertProductionTagApproval(prepared)
      return { principalId: owner, authorizationRef: `release:${executionDigest([binding.runId, binding.nodeRunId, prepared])}` }
    }
    return { principalId: owner, approval: {
      requestId: `external:${executionDigest([binding.runId, binding.nodeRunId, prepared])}`,
      approverIds: [...new Set(productionApprovers)],
    } }
  }
  return { releaseAdapters: release?.releaseAdapters ?? {},
    ...(uatMerge ? { uatMergeAdapter: uatMerge.adapter } : {}),
    ...(bytebase ? { dataChangeAdapter: bytebase.workflowAdapter } : {}),
    operationAdapter, authorizeExternal, prepareRequirement, bindStore, bindExecution,
    availableTargets: [
      ...[...releaseTargets].map(([targetId, target]) => ({ targetId, workflowId: `task-${target.kind}` })),
      ...(uatMerge ? uatMerge.configuredTargetIds.map(targetId => ({ targetId, workflowId: 'task-uat-pr-merge' })) : []),
      ...[...databaseTargets.keys()].map(targetId => ({ targetId, workflowId: 'task-data-change' })),
    ] }
}
