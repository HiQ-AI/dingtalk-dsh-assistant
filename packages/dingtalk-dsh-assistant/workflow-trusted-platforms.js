import { createHash } from 'node:crypto'
import { executionDigest, executionError } from './execution-artifacts.js'
import { createReleasePlatform } from './workflow-release-platform.js'
import { createBytebaseDataChangePlatform } from './workflow-bytebase-platform.js'

const requireText = (value, code) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw executionError(code)
  return value
}
const digestText = value => createHash('sha256').update(value, 'utf8').digest('hex')

/** 将已认证的平台端口接到固定工作流。配置只保存目标白名单，不保存凭据。 */
export function createTrustedWorkflowPlatforms({ config, clients, ownerActorId }) {
  const owner = requireText(ownerActorId, 'EXTERNAL_OWNER_REQUIRED')
  if (config?.release?.targets?.some(target => target.kind === 'production-release')
    && (!Array.isArray(config?.productionApproverActorIds) || !config.productionApproverActorIds.length
      || config.productionApproverActorIds.some(id => typeof id !== 'string' || !id.trim())))
    throw executionError('PRODUCTION_APPROVER_NOT_CONFIGURED')
  const release = config?.release?.targets?.length
    ? createReleasePlatform({ targets: config.release.targets.map(({ id, ...target }) => target), clients: clients?.release })
    : null
  const bytebase = config?.bytebase?.targets?.length
    ? createBytebaseDataChangePlatform({ config: config.bytebase, api: clients?.bytebase })
    : null
  if (!release && !bytebase) return null
  const releaseTargets = new Map((config.release?.targets ?? []).map(target => [target.id, target]))
  const databaseTargets = new Map((config.bytebase?.targets ?? []).map(target => [target.id, target]))
  if ([...releaseTargets.keys(), ...databaseTargets.keys()].some(id => !id || typeof id !== 'string')
    || releaseTargets.size !== (config.release?.targets?.length ?? 0)
    || databaseTargets.size !== (config.bytebase?.targets?.length ?? 0)) throw executionError('EXTERNAL_TARGET_ID_INVALID')
  async function prepareRequirement({ workflowId, action, materials }) {
    const request = requireText(action.arguments?.objective, 'EXTERNAL_OBJECTIVE_REQUIRED')
    const targetId = requireText(action.arguments?.targetId, 'EXTERNAL_TARGET_ID_REQUIRED')
    const constraints = [...new Set(action.constraints ?? [])]
    if (release && workflowId !== 'task-data-change') {
      const kind = workflowId.slice('task-'.length)
      const selected = releaseTargets.get(targetId)
      if (!selected || selected.kind !== kind || !release.configuredKinds.includes(kind)) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      const commitSha = requireText(action.arguments.commitSha, 'EXTERNAL_COMMIT_REQUIRED')
      const head = await clients.release.github.readBranch({ repository: selected.repository, branch: selected.branch })
      if (head.commitSha !== commitSha || !head.evidenceRef) throw executionError('EXTERNAL_COMMIT_NOT_BRANCH_HEAD')
      const target = { repository: selected.repository, environment: selected.environment,
        service: selected.service, commitSha, runbookId: selected.runbookId }
      release.targetFor({ target }, kind)
      return { request, target, constraints, evidenceRefs: [head.evidenceRef, ...materials.map(item => item.resourceRef)] }
    }
    if (bytebase && workflowId === 'task-data-change') {
      const selected = databaseTargets.get(targetId)
      if (!selected) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
      const changeRef = requireText(action.arguments.changeRef, 'EXTERNAL_CHANGE_REF_REQUIRED')
      const baselineRef = requireText(action.arguments.baselineRef, 'EXTERNAL_BASELINE_REF_REQUIRED')
      const source = materials.find(item => item.resourceRef === changeRef)
      const baseline = materials.find(item => item.resourceRef === baselineRef)
      if (!source?.text || !baseline?.text) throw executionError('EXTERNAL_MATERIAL_NOT_FOUND')
      let snapshot
      try { snapshot = JSON.parse(baseline.text) } catch { throw executionError('EXTERNAL_BASELINE_INVALID') }
      if (typeof snapshot?.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256 ?? ''))
        throw executionError('EXTERNAL_BASELINE_INVALID')
      return { request, constraints, target: selected.target,
        sources: [{ id: changeRef, sha256: digestText(source.text), content: source.text }],
        baseline: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 } }
    }
    throw executionError('EXTERNAL_WORKFLOW_NOT_CONFIGURED')
  }
  const operationAdapter = {
    execute: prepared => prepared.workflowKind === 'data-change'
      ? bytebase?.externalAdapter.execute(prepared)
      : release?.operationAdapter.execute(prepared),
    reconcile: prepared => prepared.workflowKind === 'data-change'
      ? bytebase?.externalAdapter.reconcile(prepared)
      : release?.operationAdapter.reconcile(prepared),
  }
  async function authorizeExternal({ binding, prepared }) {
    if (!binding?.runId || prepared?.runId !== binding.runId || prepared.generation !== binding.generation)
      throw executionError('EXTERNAL_AUTHORIZATION_IDENTITY_INVALID')
    if (prepared.workflowKind === 'data-change') {
      if (!bytebase || ![...databaseTargets.values()].some(item => executionDigest(item.target) === executionDigest(prepared.target)))
        throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
    } else if (!release || !release.configuredKinds.includes(prepared.workflowKind)) {
      throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
    }
    return { principalId: owner, approval: {
      requestId: `external:${executionDigest([binding.runId, binding.nodeRunId, prepared])}`,
      approverIds: prepared.workflowKind === 'production-release' ? [...new Set(config.productionApproverActorIds)] : [owner],
    } }
  }
  return { releaseAdapters: release?.releaseAdapters ?? {},
    ...(bytebase ? { dataChangeAdapter: bytebase.workflowAdapter } : {}),
    operationAdapter, authorizeExternal, prepareRequirement,
    availableTargets: [
      ...[...releaseTargets].map(([targetId, target]) => ({ targetId, workflowId: `task-${target.kind}` })),
      ...[...databaseTargets.keys()].map(targetId => ({ targetId, workflowId: 'task-data-change' })),
    ] }
}
