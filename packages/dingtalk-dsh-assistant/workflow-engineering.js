import { acceptanceCriteriaSchema } from './task-input-contract.js'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir, realpath, lstat, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { executionDigest, executionError, readTaskMaterials } from './execution-artifacts.js'
import { defineExecutionWorkflow } from './execution-controller.js'
import { createManagedWorkspaces } from './execution-workspace.js'
import { restoreVerifiedCandidate } from './execution-candidate.js'
import { createManagedEdits } from './execution-edit.js'
import { createGitDelivery } from './execution-git.js'
import { createGithubPullRequests } from './execution-pr.js'
import { createVerificationJobCheck, createBusinessAcceptanceCheck, verificationProcessSnapshot, inspectVerificationProcessJournal, historicalVerificationProcesses } from './execution-check-job.js'
import { createEngineeringTaskWorkflow, createEngineeringDirectWorkflow, createEngineeringScopedWorkflow, createEngineeringPatchWorkflow, createEngineeringDeliverableWorkflow, createEngineeringAcceptanceWorkflow, createEngineeringLocalAcceptanceWorkflow, createEngineeringBranchReuseWorkflow, createEngineeringUatBaselineWorkflow, createEngineeringMappedBaselineWorkflow, createEngineeringRevalidationWorkflow, createEngineeringInvestigationHandoffWorkflow, createEngineeringTaskContextWorkflow, createEngineeringTechnicalPlanWorkflow, proveEngineeringNoAdditionalChange } from './task-workflow.js'
import { createLocalAcceptanceRunner } from './execution-local-acceptance.js'
import { createTaskLocalAcceptanceRunner } from './execution-task-local-acceptance.js'
import { fileURLToPath } from 'node:url'
import { checkedTaskDirectory } from './session-workspaces.js'
import { freezeCandidate, readCandidate } from './execution-candidate.js'
import { engineeringPatchRepairReasons } from './execution-recovery-policy.js'
import { createTaskWorkflowContracts } from './task-workflow-contracts.js'

// stdout 为完整业务结果；stderr 仅保留诊断尾部，不以输出容量或总时长终止 Git。
const exec = (file, args, { signal } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  let diagnostic = Buffer.alloc(0), failure
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => { diagnostic = Buffer.concat([diagnostic, chunk]).subarray(-16 * 1024) })
  child.on('error', cause => { failure = cause })
  child.on('close', (code, exitSignal) => {
    const stdout = Buffer.concat(output).toString('utf8'), stderr = diagnostic.toString('utf8')
    if (failure || code !== 0) reject(Object.assign(failure ?? new Error('ENGINEERING_COMMAND_FAILED'),
      { code: failure?.code ?? code, signal: exitSignal, stdout, stderr }))
    else resolve({ stdout, stderr })
  })
})
const fail = code => { throw executionError(code) }
const text = (value, code) => { if (typeof value !== 'string' || !value.trim()) fail(code); return value }
export async function readEngineeringRemoteRefs(directory, args, { execImpl = exec, signal } = {}) {
  if (args[0] !== 'ls-remote') fail('ENGINEERING_REMOTE_READ_ARGUMENT_INVALID')
  try {
    signal?.throwIfAborted()
    return (await execImpl('git', ['-C', directory, ...args], { windowsHide: true, signal })).stdout.trim()
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const detail = String(error.stderr ?? '')
    const denied = /authentication failed|permission denied|access denied|repository not found|could not read username|returned error: (?:401|403)|certificate problem|host key verification failed/i.test(detail)
    const transient = !denied && (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error.code)
      || /connection (?:timed out|reset)|operation timed out|tls handshake timeout|ssl connection timeout|temporary failure in name resolution|returned error: (?:429|502|503|504)|remote end hung up unexpectedly/i.test(detail))
    if (!transient) fail(error.code === 2 && args.includes('--exit-code') ? 'ENGINEERING_UAT_BRANCH_NOT_FOUND' : 'ENGINEERING_REMOTE_READ_FAILED')
    fail('ENGINEERING_REMOTE_READ_TRANSIENT')
  }
}
const repositoryReadOperation = new AsyncLocalStorage()
const git = async (directory, args, { signal = repositoryReadOperation.getStore()?.signal } = {}) => args[0] === 'ls-remote' ? readEngineeringRemoteRefs(directory, args, { signal })
  : (await exec('git', ['-C', directory, ...args], { signal })).stdout.trim()
export const uatBranchFor = environment => /^uat[1-9]$/.test(environment ?? '') ? `feature/${environment}-base` : null
export const isUatBranch = branch => /^feature\/uat[1-9]-base$/.test(branch ?? '')

export function assertEngineeringStageRepository({ requirement, stage, repositories }) {
  const condition = stage.sourceCondition
  if (!condition?.repositoryId) return
  const primary = repositories.find(repository => repository.repositoryId === requirement.target.repositoryId)
  const source = requirement.sourceInstructions?.find(item => item.sourceKey === condition.sourceKey && item.sourceVersion === condition.sourceVersion)
  if (stage.workflowId !== 'task-engineering' || !repositories.some(repository => repository.repositoryId === condition.repositoryId)
    || condition.repositoryId !== requirement.target.repositoryId && !primary?.dependencyRepositories?.includes(condition.repositoryId)
    || !source || source.actorId !== requirement.authorization.actorId || typeof condition.sourceQuote !== 'string'
    || !condition.sourceQuote.trim() || typeof condition.objective !== 'string' || !condition.objective.trim() || !source.text.includes(condition.sourceQuote)
    || !condition.sourceQuote.includes(condition.objective) || !acceptanceCriteriaSchema.safeParse(condition.acceptanceCriteria).success)
    throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', '必要工程依赖必须在 Host 允许的仓库路径内，绑定原交办人的当前需求原文及阶段验收；配置本身不创造业务授权。')
}

/** 工程领域统一接收当前 Task 查询证据和重执行来源。 */
export function createEngineeringStageContract({ engineering, controller, mayCreate, engineeringSourceTaskId, readTaskEvidence }) {
  return { id: 'task-engineering', version: '1',
    async prepare({ taskId, stage, plan, requirement, origin, decision, executionPlanRevision = plan.task.planRevision }) {
      const args = { ...origin.command.args.arguments, ...requirement.target, ...(stage.sourceCondition?.repositoryId ? { repositoryId: stage.sourceCondition.repositoryId } : {}), objective: stage.sourceCondition?.repositoryId ? stage.sourceCondition.objective : requirement.request }
      const queryEvidence = await readTaskEvidence({ taskId, requirementRevision: plan.task.requirementRevision })
      return engineering.prepareTask({ taskId, arguments: { ...args,
        acceptanceCriteria: stage.sourceCondition?.repositoryId ? stage.sourceCondition.acceptanceCriteria : requirement.acceptanceCriteria, workflowId: 'task-engineering' }, constraints: requirement.constraints }, {
        run: origin.run, unit: { constraints: [], sharedConstraints: [] },
        ...(decision?.planChange?.kind === 'insertDependency' ? { dependencyStage: { stage, planRevision: plan.task.planRevision, beforeStageId: plan.stages.find(item => !['succeeded', 'invalidated'].includes(item.status))?.stageId } } : {}),
        taskContext: { taskId, requirementRevision: plan.task.requirementRevision,
          scope: requirement.scope, queryEvidence },
        ...(origin.channel === 'web' ? { rerunOfTaskId: await engineeringSourceTaskId(origin.rerunOfTaskId, args.repositoryId) } : {}),
        commandId: `stage:${taskId}:${executionPlanRevision}:${stage.stageId}`,
        stageRunId: controller.plannedTaskStageRunId({ taskId, planRevision: executionPlanRevision,
          stageId: stage.stageId, attempt: stage.attempt ?? 1 }),
        authorizedGroupRequest: requirement.authorization?.ownerConfirmed === true || await mayCreate(origin.run, 'task-engineering', origin.command.args.binding, {
          intent: origin.command.kind, arguments: origin.command.args.arguments, constraints: origin.command.args.constraints,
          requiredExecutionMaterials: origin.command.args.requiredExecutionMaterials, commandId: origin.command.id,
        }),
      }, controller)
    } }
}

export const engineeringWorkflowOwnerContract = Object.freeze({
  id: 'engineering-delivery', version: '1',
  rulesDigest: executionDigest({ deliveryProofVersion: 1, repairVersion: 1 }),
  async readArtifacts(context) {
    const proof = await readEngineeringDeliveryProof(context)
    const labels = { 'verify-candidate': '构建与检查原始结果', 'define-local-acceptance': '本地验收要求与场景',
      'finalize-local-acceptance': '本地业务验收结果与清理收据', 'business-acceptance': '业务验收原始结果' }
    const nodeArtifacts = context.state.nodes.filter(node => labels[node.nodeId] && node.status === 'succeeded'
      && proof.evidenceRefs.includes(node.outputRef)).map(node => ({ nodeId: node.nodeId,
      description: labels[node.nodeId], artifactRef: node.outputRef }))
    return { completionEvidenceRefs: [...new Set([context.stage.outputRef, ...(context.stage.evidenceRefs ?? [])])],
      nodeArtifacts, evidenceRefs: nodeArtifacts.map(node => node.artifactRef) }
  },
  async validateCompletion(context) {
    await readEngineeringDeliveryProof(context)
    return true
  },
  async inspectRepair({ stage, state }) {
    const waiting = state.nodes.filter(node => node.status === 'waiting')
    const patchAmbiguous = waiting.length === 1 && waiting[0].nodeId === 'apply-changes'
      && engineeringPatchRepairReasons.includes(waiting[0].waitReason?.reference)
    const evidenceRefs = [...new Set([...waiting.flatMap(node => node.evidenceRefs ?? []),
      ...(patchAmbiguous ? state.nodes.filter(node => ['inspect-and-propose', 'propose-changes'].includes(node.nodeId) && node.outputRef).map(node => node.outputRef) : [])])]
    return { stageId: stage.stageId, runId: stage.runId, status: state.run.status, generation: state.run.generation,
      waitingNodes: waiting.map(node => ({ nodeId: node.nodeId, reason: node.waitReason?.reference, drained: node.drained })), evidenceRefs,
      repairable: waiting.length === 1
        && (['ENGINEERING_VERIFICATION_FAILED', 'ENGINEERING_ACCEPTANCE_FAILED', 'LOCAL_ACCEPTANCE_FAILED'].includes(waiting[0].waitReason?.reference) || patchAmbiguous) }
  },
  async prepareRepair({ state, requirement, artifacts, prepareRepairContext }) {
    if (typeof prepareRepairContext !== 'function') fail('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
    if (typeof requirement?.request !== 'string' || !requirement.request.trim()
      || !Array.isArray(requirement.acceptanceCriteria) || !requirement.acceptanceCriteria.length) fail('ENGINEERING_REPAIR_REQUIREMENT_INVALID')
    const context = await prepareRepairContext(state), original = await artifacts.read(state.run.requirementRef)
    return { contextRef: context.ref, input: { ...original, request: requirement.request, acceptanceCriteria: requirement.acceptanceCriteria,
      constraints: [...new Set([...(requirement.constraints ?? []),
        '本轮是明确失败后的修复。先用engineering_repo_inspect operation=repair读取Host失败材料和旧方案，再用source=previous读取上一代实际文件；sourceKind=workspace表示补丁未应用且不存在失败候选。歧义replacement必须重读原文并补足唯一定位上下文，禁止全局替换。当前目录仍为冻结基线，请重新应用完整有效修改并修复失败。expectedHash以source=current为准。构建、本地业务验收与清理必须重新执行，不复用旧通过结论。'])] } }
  },
})

/** 完成准入复用工程实际用例回执，并限制在该 Run 真正冻结的验收要求内。 */
export function createEngineeringCompletionPolicy() {
  return { ...engineeringWorkflowOwnerContract, version: '2',
    rulesDigest: executionDigest({ previous: engineeringWorkflowOwnerContract.rulesDigest, acceptanceScope: 'stage-assigned-engineering-criteria-v1' }),
    async validateCompletion(context) {
      const { stage, state, acceptanceItems } = context
      if (!stage || stage.runId !== state?.run?.runId || !stage.outputRef
        || stage.outputRef !== state.nodes?.at(-1)?.outputRef
        || stage.evidenceRefs !== undefined && !Array.isArray(stage.evidenceRefs)
        || !Array.isArray(acceptanceItems) || acceptanceItems.some(item => !item
          || typeof item.itemId !== 'string' || !item.itemId.trim()
          || typeof item.criterion !== 'string' || !item.criterion.trim()
          || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length
          || item.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()))
        || await engineeringWorkflowOwnerContract.validateCompletion(context) !== true) return false
      const refs = new Set([stage.outputRef, ...(stage.evidenceRefs ?? [])])
      const assigned = acceptanceItems.filter(item => item.evidenceRefs.some(ref => refs.has(ref)))
      if (!assigned.length) return true
      const input = await context.artifacts.read(context.state.run.requirementRef)
      return Array.isArray(input?.acceptanceCriteria)
        && assigned.every(item => input.acceptanceCriteria.includes(item.criterion))
    },
  }
}

export function createEngineeringFailureRepair({ store, artifacts, controller, engineering }) {
  return createTaskWorkflowContracts({ store, artifacts, controller, prepareRepairContext: engineering.prepareRepairContext })
}

const githubName = remote => /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1]
  ?? /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1]

/** 从同一工程 Run 的不可变节点工件提取交付身份；平台现状仍须独立回读。 */
export async function readEngineeringDeliveryProof({ state, artifacts, store, taskId, requiredE2eCheckIds = [] }) {
  if (state?.run?.taskId !== taskId || state.run.status !== 'succeeded'
    || typeof artifacts?.read !== 'function' || typeof store?.query !== 'function'
    || !Array.isArray(requiredE2eCheckIds) || requiredE2eCheckIds.some(id => typeof id !== 'string' || !id))
    fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
  const records = await store.query({ kind: 'workflow.list' })
  if (!Array.isArray(records)) fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
  const registered = records.filter(record => record.workflowId === state.run.workflowId
    && record.digest === state.run.workflowDigest)
  const record = registered[0], saved = record?.config
  if (registered.length !== 1 || saved?.kind !== 'engineering' || saved.taskId !== taskId
    || saved.runId !== state.run.runId || typeof saved.sourceCommandId !== 'string'
    || !saved.sourceCommandId || (saved.reissueRequestId !== undefined
      && (typeof saved.reissueRequestId !== 'string' || !saved.reissueRequestId)))
    fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
  const expectedId = saved.taskRevision
    ? `task-engineering-revision-${executionDigest([state.run.runId, saved.taskRevision.requestId]).slice(0,32)}`
    : saved.checkpoint
    ? `task-engineering-checkpoint-${executionDigest([state.run.runId, saved.checkpoint.requestId]).slice(0,32)}`
    : saved?.reissueRequestId
    ? `task-engineering-reissue-${executionDigest([state.run.runId, saved.reissueRequestId]).slice(0, 40)}`
    : `task-engineering-${executionDigest(saved.sourceCommandId).slice(0, 40)}`
  if (state.run.workflowId !== expectedId) fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
  const change = saved.taskRevision ?? saved.checkpoint
  if (change) {
    const commandId = saved.taskRevision ? change.requestId : `engineering-checkpoint:${state.run.runId}:${change.requestId}`
    const receipt = await store.query({ kind: 'receipt', commandId })
    const original = records.find(value => value.digest === change.fromDigest && value.config?.taskId === taskId
      && value.config.runId === state.run.runId && value.config.sourceCommandId === saved.sourceCommandId)
    if (!original || receipt?.result?.toDigest !== state.run.workflowDigest || receipt.result.runId !== state.run.runId
      || receipt.result.fromDigest !== change.fromDigest || (saved.taskRevision ? receipt.result.taskId !== taskId : receipt.result.kind !== change.kind)) fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
    if (saved.taskRevision) state = { ...state, nodes: state.nodes.map(node => ({ ...node, originalNodeId:node.nodeId, nodeId: saved.taskRevision.nodeRoles[node.nodeId] ?? node.nodeId })) }
  }
  const refs = [], outputs = {}
  for (const id of ['verify-candidate', 'prepare-commit', 'commit', 'prepare-push', 'push', 'prepare-pr', 'create-pr', 'finalize']) {
    const matches = state.nodes.filter(node => node.nodeId === id && node.status === 'succeeded' && node.outputRef)
    if (matches.length !== 1) fail('ENGINEERING_DELIVERY_PROOF_UNAVAILABLE')
    refs.push(matches[0].outputRef)
    outputs[id] = await artifacts.read(matches[0].outputRef)
  }
  const verified = outputs['verify-candidate'], commit = outputs['prepare-commit']
  const committed = outputs.commit, preparedPush = outputs['prepare-push'], pushed = outputs.push
  const preparedPr = outputs['prepare-pr'], createdPr = outputs['create-pr'], final = outputs.finalize
  const hex40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
  const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!hex64(verified?.candidate?.digest) || !hex64(verified?.verification?.digest)
    || verified.verification.passed !== true || !Array.isArray(verified.verification.checks)
    || verified.verification.checks.some(check => check.passed !== true || !check.id || !check.version)
    || !hex40(commit?.commitId) || commit.candidateDigest !== verified.candidate.digest
    || commit.verification?.digest !== verified.verification.digest || commit.tree !== verified.candidate.tree
    || committed?.prepared?.commitId !== commit.commitId || committed.receipt?.status !== 'succeeded'
    || preparedPush?.commitId !== commit.commitId || preparedPush.verificationDigest !== commit.verification.digest
    || pushed?.prepared?.commitId !== commit.commitId || pushed.receipt?.status !== 'succeeded'
    || preparedPr?.commitId !== commit.commitId || createdPr?.prepared?.commitId !== commit.commitId
    || createdPr.receipt?.status !== 'succeeded' || final?.deliveryStatus !== 'pr_verified'
    || final.commitId !== commit.commitId || final.number !== createdPr.receipt.number
    || final.url !== createdPr.receipt.url) fail('ENGINEERING_DELIVERY_PROOF_MISMATCH')
  const checks = new Set(verified.verification.checks.map(check => check.id))
  if (record.definitionVersion === '10') {
    const node = state.nodes.find(node => node.nodeId === 'business-acceptance' && node.status === 'succeeded' && node.outputRef)
    if (!node) fail('ENGINEERING_ACCEPTANCE_PROOF_REQUIRED')
    const acceptance = (await artifacts.read(node.outputRef))?.acceptance
    if (!acceptance?.passed || acceptance.candidateDigest !== verified.candidate.digest || !acceptance.checks?.length || acceptance.checks.some(check => !check.passed)) fail('ENGINEERING_ACCEPTANCE_PROOF_REQUIRED')
    refs.push(node.outputRef)
    acceptance.checks.forEach(check => checks.add(check.id))
  }
  let localEvidence
  if (['11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion)) {
    const node = state.nodes.find(node => node.nodeId === 'finalize-local-acceptance' && node.status === 'succeeded' && node.outputRef)
    const acceptance = node && (await artifacts.read(node.outputRef))?.localAcceptance
    if (!acceptance?.passed || acceptance.candidateDigest !== verified.candidate.digest || !acceptance.cleanup?.dataCleaned
      || !acceptance.cleanup?.processStopped || !acceptance.checks?.length || acceptance.checks.some(check => !check.passed)) fail('ENGINEERING_ACCEPTANCE_PROOF_REQUIRED')
    refs.push(node.outputRef)
    acceptance.checks.forEach(check => checks.add(check.scenarioId))
    const output = await artifacts.read(node.outputRef), prepared = output.localPrepared
    const prepareSpec = saved.taskRevision?.nodes?.find(spec => saved.taskRevision.nodeRoles[spec.nodeId] === 'prepare-local-acceptance')
    const contextNodeId = prepareSpec?.dependencyBindings?.['define-local-acceptance'] ?? 'define-local-acceptance'
    const definitionNode = state.nodes.find(item => (item.originalNodeId ?? item.nodeId) === contextNodeId && item.nodeId === 'define-local-acceptance' && item.status === 'succeeded' && item.outputRef)
    const context = definitionNode && (await artifacts.read(definitionNode.outputRef))?.localContext
    const cases = prepared?.plan?.cases, criteria = context?.criteria
    if (!prepared || prepared.taskId !== taskId || prepared.runId !== state.run.runId
      || prepared.candidateDigest !== verified.candidate.digest || prepared.identity !== acceptance.identity
      || !hex64(prepared.planDigest) || executionDigest(prepared.plan) !== prepared.planDigest
      || acceptance.planDigest !== prepared.planDigest || prepared.uatEnvironment !== context?.uatEnvironment
      || uatBranchFor(prepared.uatEnvironment) !== final.base || acceptance.uatEnvironment !== prepared.uatEnvironment
      || !Array.isArray(criteria) || !criteria.length || !Array.isArray(cases) || cases.length !== criteria.length
      || new Set(criteria.map(item => item.id)).size !== criteria.length
      || new Set(cases.map(item => item.criterionId)).size !== cases.length
      || acceptance.checks.length !== cases.length
      || criteria.some(item => !item.id || !item.description || !cases.some(entry => entry.criterionId === item.id))
      || cases.some(item => !context.scenarios?.some(scenario => scenario.id === item.scenarioId)
        || acceptance.checks.filter(check => check.criterionId === item.criterionId && check.scenarioId === item.scenarioId
          && check.expected === item.expected && check.actual === item.expected && check.passed === true
          && executionDigest(check.steps) === executionDigest(item.steps)).length !== 1))
      fail('ENGINEERING_ACCEPTANCE_PROOF_REQUIRED')
    refs.push(definitionNode.outputRef)
    localEvidence = { taskId, runId: state.run.runId, definitionVersion: record.definitionVersion,
      candidateDigest: verified.candidate.digest, treeSha: commit.tree, commitSha: commit.commitId,
      planDigest: prepared.planDigest, uatEnvironment: prepared.uatEnvironment,
      criteriaDigest: executionDigest(criteria), scenarioIds: cases.map(item => item.scenarioId),
      receiptDigest: executionDigest(acceptance), evidenceRefs: [definitionNode.outputRef, node.outputRef] }
    if (['13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion)) {
      const workspaceNode = state.nodes.find(item => item.nodeId === 'prepare-workspace' && item.status === 'succeeded' && item.outputRef)
      const workspace = workspaceNode && (await artifacts.read(workspaceNode.outputRef))?.workspace
      if (!hex40(saved.targetCommit) || !hex40(saved.taskBase) || workspace?.taskBase !== saved.taskBase
        || commit.mergeParent !== saved.targetCommit || workspace?.targetCommit !== saved.targetCommit
        || !hex40(workspace.mergeTree) || !Array.isArray(workspace.conflictPaths)) fail('ENGINEERING_UAT_BASELINE_PROOF_REQUIRED')
      localEvidence.targetCommit = saved.targetCommit
      localEvidence.taskBase = saved.taskBase
      localEvidence.mergeTree = workspace.mergeTree
      localEvidence.evidenceRefs.push(workspaceNode.outputRef); refs.push(workspaceNode.outputRef)
    }
  }
  return { taskId, runId: state.run.runId, commitSha: commit.commitId,
    treeSha: commit.tree, candidateDigest: verified.candidate.digest, verificationDigest: verified.verification.digest,
    checkIds: [...checks], localE2ePassed: requiredE2eCheckIds.length > 0 && requiredE2eCheckIds.every(id => checks.has(id)),
    sourcePackageSupported: true,
    pullRequest: { number: final.number, url: final.url, repository: final.repo,
      head: final.head, base: final.base, state: final.state, commitSha: final.commitId },
    evidenceRefs: refs, ...(localEvidence ? { localEvidence } : {}) }
}

/** 可信Host仓库白名单→每次任务的持久固定定义。启动配置不来自消息/模型。 */
/** Task专属验收只精确匹配，不能退回同仓库另一业务场景。 */
export function selectTaskLocalAcceptance(config, scope) {
  if (config.taskLocalAcceptance === undefined) return { localAcceptanceConfig: config.localAcceptance ?? null }
  if (!Array.isArray(config.taskLocalAcceptance)) fail('ENGINEERING_ACCEPTANCE_SCOPE_INVALID')
  const matches = config.taskLocalAcceptance.filter(item => executionDigest(item.scope) === executionDigest(scope))
  if (matches.length !== 1) fail(matches.length ? 'ENGINEERING_ACCEPTANCE_SCOPE_AMBIGUOUS' : 'ENGINEERING_ACCEPTANCE_SCOPE_MISMATCH')
  return { localAcceptanceConfig: structuredClone(matches[0].localAcceptance), localAcceptanceScope: structuredClone(scope) }
}

/** 从原生工具回执恢复读事实；当前文件必须仍为工具返回的完整 SHA，不制造已读记录。 */
export async function restoreEngineeringReadEvidence({ events, binding, paths, directory, allowedPrefixes }) {
  const read = new Set()
  const identity = events.find(event => event.type === 'dingtalk/execution-session')?.data?.identity
  if (!identity || ['taskId','runId','nodeRunId','generation','inputDigest','sessionId'].some(key => identity[key] !== binding[key])) return []
  for (const call of events.filter(event => event.type === 'tool/call' && event.data.name === 'engineering_repo_inspect')) {
    let args; try { args = JSON.parse(call.data.arguments) } catch { continue }
    if (args.operation !== 'read' || args.source && args.source !== 'current' || !paths.includes(args.path)) continue
    const result = events.find(event => event.seq > call.seq && event.type === 'tool/result'
      && event.data.message?.content?.some(block => block.type === 'tool-result' && block.toolCallId === call.data.callId && !block.isError))
    const blocks = result?.data.message.content.find(block => block.toolCallId === call.data.callId)?.content
    let value; try { value = JSON.parse(blocks?.find(block => block.type === 'text')?.text) } catch { continue }
    if (value.path !== args.path || !value.text || !/^[a-f0-9]{64}$/.test(value.expectedHash)
      || /[\\:\0\r\n]/.test(args.path) || args.path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
      || !allowedPrefixes.some(prefix => args.path.startsWith(prefix))) continue
    const full = join(directory, args.path)
    if (!(await lstat(full)).isFile() || resolve(await realpath(full)).toLowerCase() !== resolve(full).toLowerCase()) continue
    const bytes = await readFile(full)
    if (createHash('sha256').update(bytes).digest('hex') === value.expectedHash
      && value.text === new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(value.offset ?? 0, (value.offset ?? 0) + value.text.length)) read.add(args.path)
  }
  return [...read]
}

const engineeringRequiredNodes = ['verify-candidate', 'run-local-acceptance', 'finalize-local-acceptance', 'commit', 'push', 'create-pr', 'finalize']
async function applyEngineeringTaskRevision(workflow, previous, revision, artifacts) {
  const start = previous.nodes.findIndex(node => node.id === revision.startNodeId)
  if (start < 0 || !revision.reason?.trim()) fail('ENGINEERING_REVISION_INVALID')
  const templates = new Map([...previous.nodes, ...workflow.nodes].map(node => [node.id, node]))
  const suffix = revision.nodes ?? previous.nodes.slice(start).map(node => ({ nodeId: node.id, templateNodeId: node.id }))
  const prefix = previous.nodes.slice(0, start)
  const oldRoles = previous.ownerContract?.rulesDigest?.revisionRoles ?? Object.fromEntries(previous.nodes.map(node => [node.id,node.id]))
  const nodes = await Promise.all(suffix.map(async spec => {
    const original = templates.get(spec.templateNodeId)
    if (!original || !/^[a-z][a-z0-9-]{0,100}$/.test(spec.nodeId)) fail('ENGINEERING_REVISION_NODE_INVALID')
    const node = { ...original, id: spec.nodeId }
    if (original.allowedEffects.some(effect => !['pure', 'read'].includes(effect))
      && suffix.filter(value => value.templateNodeId === spec.templateNodeId).length !== 1) fail('ENGINEERING_REVISION_EFFECT_DUPLICATE')
    if (spec.inputSchema || spec.outputSchema || spec.inputBindings) {
      if (original.executor !== 'agent') fail('ENGINEERING_REVISION_CONTRACT_INVALID')
      for (const field of ['inputSchema', 'outputSchema']) if (spec[field]) {
        const schema = spec[field], prior = original[field]
        if (schema.type !== 'object' || (prior.required ?? []).some(key => !schema.required?.includes(key)
          || executionDigest(schema.properties?.[key] ?? null) !== executionDigest(prior.properties?.[key] ?? null))) fail('ENGINEERING_REVISION_CONTRACT_INVALID')
        node[field] = structuredClone(schema)
      }
      if (spec.inputBindings) {
        const bindings = structuredClone(spec.inputBindings), mapper = original.mapInput
        if (Object.keys(bindings).some(key => ['requirement','plan','authorization','source','baseCommit','editablePaths','__proto__','constructor','prototype'].includes(key))) fail('ENGINEERING_REVISION_INPUT_INVALID')
        node.inputDependencies = [...new Set([...(original.inputDependencies ?? []), ...Object.values(bindings).flatMap(value => value.nodeId ? [value.nodeId] : [])])]
        node.mapInput = args => {
          const input = { ...mapper(args) }
          for (const [key, value] of Object.entries(bindings)) {
            if (typeof value.field !== 'string' || ['__proto__','constructor','prototype'].includes(value.field)
              || (value.requirement === true) === (typeof value.nodeId === 'string')) fail('ENGINEERING_REVISION_INPUT_INVALID')
            const source = value.requirement ? args.requirement : args.dependencyOutputs[value.nodeId]
            if (!source || !Object.hasOwn(source, value.field)) fail('ENGINEERING_REVISION_INPUT_MISSING')
            input[key] = structuredClone(source[value.field])
          }
          return input
        }
      }
      node.rulesDigest = executionDigest({ previous: original.rulesDigest, spec })
    }
    if (spec.dependencyBindings || spec.previousOutputNodeId) {
      const redirects = structuredClone(spec.dependencyBindings ?? {}), mapper = node.mapInput
      const index = suffix.indexOf(spec), predecessors = [...prefix, ...suffix.slice(0,index).map(item => ({...templates.get(item.templateNodeId),id:item.nodeId,templateNodeId:item.templateNodeId}))]
      const role = value => oldRoles[value.templateNodeId ?? value.id] ?? value.templateNodeId ?? value.id
      const target = (id, expected) => {
        const found = predecessors.find(value => value.id === id)
        if (!expected || !found || role(found) !== (oldRoles[expected.id] ?? expected.id)
          || executionDigest(found.outputSchema) !== executionDigest(expected.outputSchema)) fail('ENGINEERING_REVISION_DEPENDENCY_INVALID')
        return found
      }
      for (const [id, source] of Object.entries(redirects)) {
        if (!original.inputDependencies?.includes(id) || spec.dependencyArtifacts?.[id] || typeof source !== 'string') fail('ENGINEERING_REVISION_DEPENDENCY_INVALID')
        target(source, templates.get(id))
      }
      if (spec.previousOutputNodeId) {
        const previousIndex = previous.nodes.findIndex(value => value.id === spec.templateNodeId)
        if (previousIndex < 1) fail('ENGINEERING_REVISION_DEPENDENCY_INVALID')
        target(spec.previousOutputNodeId, previous.nodes[previousIndex-1])
      }
      node.inputDependencies = [...new Set([...(node.inputDependencies ?? []).map(id => redirects[id] ?? id), ...Object.values(redirects), ...(spec.previousOutputNodeId ? [spec.previousOutputNodeId] : [])])]
      node.mapInput = args => {
        const dependencyOutputs = {...args.dependencyOutputs}
        for (const [id, source] of Object.entries(redirects)) {
          if (!Object.hasOwn(dependencyOutputs, source)) fail('ENGINEERING_REVISION_INPUT_MISSING')
          dependencyOutputs[id] = dependencyOutputs[source]
        }
        if (spec.previousOutputNodeId && !Object.hasOwn(dependencyOutputs,spec.previousOutputNodeId)) fail('ENGINEERING_REVISION_INPUT_MISSING')
        return mapper({...args,dependencyOutputs,...(spec.previousOutputNodeId ? {previousOutput:dependencyOutputs[spec.previousOutputNodeId]} : {})})
      }
      node.rulesDigest = executionDigest({previous:node.rulesDigest,dependencyBindings:redirects,previousOutputNodeId:spec.previousOutputNodeId??null})
    }
    if (spec.dependencyArtifacts) {
      const frozen = {}, mapper = node.mapInput
      for (const [id, ref] of Object.entries(spec.dependencyArtifacts)) {
        if (!original.inputDependencies?.includes(id) || revision.dependencyEvidence?.[id] !== ref) fail('ENGINEERING_REVISION_ARTIFACT_INVALID')
        frozen[id] = await artifacts.read(ref)
      }
      node.inputDependencies = (node.inputDependencies ?? []).filter(id => !Object.hasOwn(frozen, id))
      node.mapInput = args => mapper({ ...args, dependencyOutputs: { ...args.dependencyOutputs, ...structuredClone(frozen) } })
      node.rulesDigest = executionDigest({ previous: node.rulesDigest, dependencies: spec.dependencyArtifacts })
    }
    return node
  }))
  workflow.nodes = [...prefix, ...nodes]
  if (new Set(workflow.nodes.map(node => node.id)).size !== workflow.nodes.length) fail('ENGINEERING_REVISION_NODE_DUPLICATE')
  const roles = new Map([...prefix.map(node => [node.id,oldRoles[node.id]]), ...suffix.map(node => [node.nodeId,oldRoles[node.templateNodeId] ?? node.templateNodeId])])
  for (const id of engineeringRequiredNodes.filter(id => Object.values(oldRoles).includes(id))) {
    if ([...roles.values()].filter(role => role === id).length !== 1) fail('ENGINEERING_REVISION_RESPONSIBILITY_MISSING')
  }
  if (executionDigest(previous.nodes.map(node => oldRoles[node.id]).filter(id => engineeringRequiredNodes.includes(id)))
    !== executionDigest(workflow.nodes.map(node => roles.get(node.id)).filter(id => engineeringRequiredNodes.includes(id)))) fail('ENGINEERING_REVISION_RESPONSIBILITY_ORDER')
  workflow.ownerContract = { ...workflow.ownerContract, rulesDigest: { base: workflow.ownerContract.rulesDigest ?? null, revisionRoles: Object.fromEntries(roles) }, validateRevision: validateEngineeringTaskRevision }
  return workflow
}
function validateEngineeringTaskRevision({ previous, next, startNodeId }) {
  if (previous.ownerContract?.id !== next.ownerContract?.id || !next.id.startsWith('task-engineering-revision-')
    || !previous.nodes.some(node => node.id === startNodeId)) fail('ENGINEERING_REVISION_INVALID')
  // 职责由受信工厂在构造阶段按 templateNodeId 核验；节点名称本身不是权限。
  return true
}

export function createEngineeringRegistry({ repositories = [], ownerActorId, modelConfig, author, ghCommand, getTaskDirectories, readSessionEvents }) {
  text(ownerActorId, 'ENGINEERING_OWNER_REQUIRED')
  if (!Array.isArray(repositories) || typeof modelConfig !== 'function') fail('ENGINEERING_REGISTRY_CONFIG_INVALID')
  const configs = new Map(), routes = new Map(), preparing = new Map(), snapshots = new Map(), conflictReads = new Map()
  for (const source of repositories) {
    const config = structuredClone(source)
    const fixedPaths = Array.isArray(config.editablePaths) && config.editablePaths.length > 0
    if (fixedPaths === !!config.discovery) fail('ENGINEERING_SCOPE_MODE_REQUIRED')
    config.editablePaths ??= []
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.id ?? '') || configs.has(config.id)
      || !isAbsolute(config.sourceRepository ?? '') || !isAbsolute(config.managedRoot ?? '') || !config.remote || !config.baseRef
      || config.baseRef.startsWith('-') || /[\s\0]/.test(config.baseRef) || !Array.isArray(config.editablePaths)
      || config.editablePaths.some(path => typeof path !== 'string' || !path || /[\\:\0\r\n]/.test(path) || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())))
      || !Array.isArray(config.checks) || !config.checks.length) fail('ENGINEERING_REPOSITORY_INVALID')
    if (config.discovery && (!Array.isArray(config.discovery.allowedPrefixes) || !config.discovery.allowedPrefixes.length || config.discovery.allowedPrefixes.some(prefix => typeof prefix !== 'string' || (prefix !== '' && (!prefix.endsWith('/') || /[\\:\0\r\n]/.test(prefix) || prefix.slice(0, -1).split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))))))) fail('ENGINEERING_DISCOVERY_CONFIG_INVALID')
    config.githubRepository = config.githubRepository ?? githubName(config.remote)
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config.githubRepository ?? '')) fail('ENGINEERING_GITHUB_REPOSITORY_REQUIRED')
    config.baseBranch = config.baseBranch ?? (config.baseRef.startsWith('refs/heads/') ? config.baseRef.slice(11) : /^(?:origin\/|refs\/remotes\/)/.test(config.baseRef) ? null : config.baseRef)
    if (typeof config.baseBranch !== 'string' || !config.baseBranch || config.baseBranch.startsWith('-') || /[\s\0]/.test(config.baseBranch)) fail('ENGINEERING_BASE_BRANCH_REQUIRED')
    // 配置校验发生在任何消息进入前；真正执行时仍重新校验适配器。
    config.checks.forEach(check => createVerificationJobCheck({ ...check, root: join(config.managedRoot, 'checks') }))
    if (config.acceptanceChecks !== undefined && !Array.isArray(config.acceptanceChecks)) fail('ENGINEERING_ACCEPTANCE_CONFIG_INVALID')
    if (config.acceptanceChecks && (new Set([...config.checks, ...config.acceptanceChecks].map(check => check.id)).size !== config.checks.length + config.acceptanceChecks.length)) fail('ENGINEERING_ACCEPTANCE_CONFIG_INVALID')
    config.acceptanceChecks?.forEach(check => createBusinessAcceptanceCheck({ ...check, root: join(config.managedRoot, 'acceptance') }))
    if (config.purpose !== undefined && (typeof config.purpose !== 'string' || !config.purpose.trim())) fail('ENGINEERING_REPOSITORY_INVALID')
    if (config.routingTerms !== undefined && (!Array.isArray(config.routingTerms) || config.routingTerms.some(term => typeof term !== 'string' || !term.trim()))) fail('ENGINEERING_REPOSITORY_INVALID')
    if (config.dependencyRepositories !== undefined && (!Array.isArray(config.dependencyRepositories)
      || config.dependencyRepositories.some(id => id === config.id || !repositories.some(repository => repository.id === id))))
      fail('ENGINEERING_DEPENDENCY_CONFIG_INVALID')
    // 路由说明只用于接纳前判断，不改变既有任务冻结的执行配置摘要。
    if (config.localAcceptance) createLocalAcceptanceRunner({ root: join(config.managedRoot, 'local-acceptance'), config: config.localAcceptance })
    const { purpose, routingTerms, localAcceptance, dependencyRepositories, taskLocalAcceptance, ...executionConfig } = config
    configs.set(config.id, { config, digest: executionDigest({ config: executionConfig, ghCommand: ghCommand ?? null, author: author ?? null }), legacyDigest: executionDigest({ config: { ...executionConfig, ...(taskLocalAcceptance === undefined ? {} : {taskLocalAcceptance}) }, ghCommand: ghCommand ?? null, author: author ?? null }) })
  }
  let store, artifactStore
  async function build(record, { allowDefinitionMigration = false } = {}) {
    const saved = record.config, entry = configs.get(saved.repoId)
    if(saved.localAcceptanceScope && executionDigest(saved.localAcceptanceScope)!==executionDigest({taskId:saved.taskId,uatEnvironment:saved.uatEnvironment,requestDigest:executionDigest({request:saved.input.request,acceptanceCriteria:saved.input.acceptanceCriteria})}))fail('ENGINEERING_ACCEPTANCE_SCOPE_MISMATCH')
    if (saved.kind !== 'engineering' || saved.registryVersion !== '1' || !entry || ![entry.digest,entry.legacyDigest].includes(saved.repositoryDigest) || saved.ownerActorId !== ownerActorId) fail('ENGINEERING_DEFINITION_CONFIG_DRIFT')
    const config = entry.config
    const managedRoot = saved.taskFiles ? join(saved.taskFiles.work, 'engineering', executionDigest([saved.taskId, saved.repoId]).slice(0, 24)) : config.managedRoot
    const baseline = !record.definitionVersion || ['13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion)
    if (baseline && !/^[a-f0-9]{40}$/.test(saved.targetCommit ?? '')) fail('ENGINEERING_UAT_BASELINE_REQUIRED')
    if (baseline && !/^[a-f0-9]{40}$/.test(saved.taskBase ?? '')) fail('ENGINEERING_TASK_BASE_REQUIRED')
    const targetOptions = baseline ? { targetCommit: saved.targetCommit, taskBase: saved.taskBase } : {}
    const assertTargetCurrent = async () => {
      const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${saved.uatBranch}`])
      if ((remote.split(/\s/)[0] || null) !== saved.targetCommit) fail('ENGINEERING_UAT_BASELINE_CHANGED')
    }
    if (saved.taskFiles) await checkedTaskDirectory(managedRoot, true)
    else await mkdir(managedRoot, { recursive: true })
    const baseWorkspaceAdapter = await createManagedWorkspaces({ root: managedRoot, sourceRepository: config.sourceRepository, ...targetOptions })
    const previousEffects = async generation => (await store.query({ kind: 'effect.list', runId: saved.runId })).filter(effect => effect.generation < generation && effect.state === 'succeeded')
    const previousPush = async generation => (await previousEffects(generation)).filter(effect => effect.definition.action === 'push').sort((a, b) => b.generation - a.generation)[0]?.definition.payload
    const workspaceFor = async ({ generation, baseCommit }) => {
      const prior = await previousPush(generation)
      if (!prior) {
        if (baseCommit !== saved.input.baseCommit) fail('ENGINEERING_DERIVED_BASE_INVALID')
        return baseWorkspaceAdapter
      }
      if (baseCommit !== prior.commitId) fail('ENGINEERING_DERIVED_BASE_INVALID')
      return createManagedWorkspaces({ root: managedRoot, sourceRepository: prior.repository, ...targetOptions })
    }
    const workspaceAdapter = Object.fromEntries(['prepare', 'execute', 'reconcile'].map(method => [method, async value => (await workspaceFor(value))[method](value, { signal: repositoryReadOperation.getStore()?.signal })]))
    if (saved.branchSource) for (const method of ['prepare', 'execute']) {
      const operation = workspaceAdapter[method]
      workspaceAdapter[method] = async value => {
        const prior = await previousPush(value.generation)
        const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${saved.head}`])
        if ((remote.split(/\s/)[0] || null) !== (prior?.commitId ?? saved.branchSource.expectedRemoteSha)) fail('GIT_REMOTE_CONFLICT')
        return operation(value)
      }
    }
    if (baseline) for (const method of ['prepare', 'execute']) {
      const operation = workspaceAdapter[method]
      workspaceAdapter[method] = async value => { await assertTargetCurrent(); return operation(value) }
    }
    const editAdapter = createManagedEdits({ workspaceAdapter })
    const canonicalRoot = await realpath(managedRoot)
    const allowedRepository = repository => {
      if (!repository.startsWith(canonicalRoot + (process.platform === 'win32' ? '\\' : '/'))) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
      // gitAdapterFor只由本定义的受信节点调用；派发时再次核run+generation目录。
      return repository
    }
    const gitAdapterFor = async repository => {
      const adapter = await createGitDelivery({ repository: allowedRepository(repository), remote: config.remote, branch: saved.head, author: saved.author,
        ...(baseline ? { mergeParent: saved.targetCommit } : {}) })
      if (!baseline) return adapter
      return { ...adapter,
        preparePush: async value => { await assertTargetCurrent(); return adapter.preparePush(value) },
        executePush: async value => { await assertTargetCurrent(); return adapter.executePush(value) } }
    }
    const generationFor = async repository => {
      const state = await store.query({ kind: 'run', runId: saved.runId })
      for (let generation = 1; generation <= (state.run?.generation ?? 1); generation++) if (repository === join(canonicalRoot, `ws-${executionDigest({ runId: saved.runId, generation })}`, 'repository')) return generation
      fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
    }
    const prAdapterFor = async repository => {
      const generation = await generationFor(repository)
      const prior = (await previousEffects(generation)).filter(effect => effect.definition.action === 'pr').sort((a, b) => b.generation - a.generation)[0]
      return createGithubPullRequests({ repository: allowedRepository(repository), repo: config.githubRepository, base: saved.uatBranch ?? config.baseBranch, head: saved.head,
        ...(prior ? { previousOperationKey: prior.definition.payload.operationKey } : saved.previousPullRequest ? { previousPullRequest: saved.previousPullRequest } : {}), ...(ghCommand ? { ghCommand } : {}) })
    }
    const prepareGeneration = async ({ input, runId, generation }) => {
      if (runId !== saved.runId) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
      const prior = await previousPush(generation)
      const expectedRemoteSha = prior?.commitId ?? null
      const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${saved.head}`])
      if ((remote.split(/\s/)[0] || null) !== expectedRemoteSha) fail('GIT_REMOTE_CONFLICT')
      if (prior) {
        if (await git(prior.repository, ['rev-parse', prior.commitId]) !== prior.commitId) fail('ENGINEERING_DERIVED_BASE_INVALID')
        const oldPr = (await previousEffects(generation)).filter(effect => effect.definition.action === 'pr').sort((a, b) => b.generation - a.generation)[0]
        if (oldPr) {
          const oldAdapter = await prAdapterFor(oldPr.definition.payload.repository)
          const observed = await oldAdapter.reconcile(oldPr.definition.payload, { allowHeadChange: true })
          if (observed.status !== 'succeeded' || observed.state !== 'OPEN') fail('ENGINEERING_PREVIOUS_PR_NOT_OPEN')
        }
      }
      return { ...input, baseCommit: prior?.commitId ?? saved.input.baseCommit, expectedRemoteSha }
    }
    const commandPath = fileURLToPath(new URL('./execution-task-command.js', import.meta.url))
    const commandDigest = saved.taskFiles ? createHash('sha256').update((await readFile(commandPath, 'utf8')).replace(/\r\n/g, '\n')).digest('hex') : undefined
    const command = value => saved.taskFiles ? { ...value, executable: process.execPath,
      args: [commandPath, commandDigest, saved.taskFiles.tmp, value.executable, ...value.args] } : value
    const checkConfig = check => saved.taskFiles ? { ...check, ...(check.steps ? { steps: check.steps.map(command) } : command(check)) } : check
    const taskCheck = (factory, check, root) => {
      const value = factory({ ...checkConfig(check), root })
      return saved.taskFiles ? { ...value, configurationDigest: executionDigest({ configuration: value.configurationDigest, implementation: value.run.toString().replace(/\r\n/g, '\n'), directoryCheck: checkedTaskDirectory.toString().replace(/\r\n/g, '\n') }), async run(snapshot, context) {
        await checkedTaskDirectory(root, true)
        return value.run(snapshot, context)
      } } : value
    }
    const checks = (saved.checkpointChecks ?? config.checks).map(check => taskCheck(createVerificationJobCheck, check, join(managedRoot, 'checks')))
    const runner = ['11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion) || !record.definitionVersion
      ? (saved.taskFiles ? createTaskLocalAcceptanceRunner({ root: join(managedRoot, 'local-acceptance'), config: saved.localAcceptanceConfig, tempRoot: saved.taskFiles.tmp }) : createLocalAcceptanceRunner({ root: join(managedRoot, 'local-acceptance'), config: saved.localAcceptanceConfig })) : undefined
    const signals = new Map(), drainFailures = new Map()
    const localAcceptance = runner && { ...runner, resourceKey: 'external:local-acceptance:shared-uat',
      async dispatch(prepared, perform, signal) {
        signals.set(prepared.identity, signal)
        try { return await perform({ action: 'external', prepared }) }
        catch (error) {
          const failure = drainFailures.get(prepared.identity)
          const receipt = await runner.readReceipt(prepared).catch(() => null)
          if (failure || receipt?.executionDrained === false || receipt?.cleanup?.processStopped === false) throw Object.assign(executionError('LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED'), { executionDrained: false })
          if (receipt?.cleanup?.dataCleaned === false) throw Object.assign(executionError('LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED'), { evidence: [{ localAcceptance: receipt }] })
          throw error
        }
        finally { signals.delete(prepared.identity) }
      } }
    const workflowFactory = record.definitionVersion === '19' ? createEngineeringTechnicalPlanWorkflow : !record.definitionVersion || record.definitionVersion === '18' ? createEngineeringTaskContextWorkflow : record.definitionVersion === '17' ? createEngineeringInvestigationHandoffWorkflow : ['15', '16'].includes(record.definitionVersion) ? createEngineeringRevalidationWorkflow : record.definitionVersion === '14' ? createEngineeringMappedBaselineWorkflow : record.definitionVersion === '13' ? createEngineeringUatBaselineWorkflow : record.definitionVersion === '12' ? createEngineeringBranchReuseWorkflow : record.definitionVersion === '11' ? createEngineeringLocalAcceptanceWorkflow : record.definitionVersion === '10' ? createEngineeringAcceptanceWorkflow : record.definitionVersion === '9' ? createEngineeringDeliverableWorkflow : !config.discovery ? createEngineeringTaskWorkflow
      : record.definitionVersion === '6' ? createEngineeringDirectWorkflow
        : record.definitionVersion === '7' ? createEngineeringScopedWorkflow
          : !record.definitionVersion || record.definitionVersion === '8' ? createEngineeringPatchWorkflow : createEngineeringTaskWorkflow
    const workflowOptions = { taskContext: saved.taskContext, investigationHandoff: saved.investigationHandoff, workflowId: record.workflowId, provider: saved.provider, model: saved.model, reasoningEffort: saved.reasoningEffort,
      workspaceAdapter, editAdapter, checks, prepareGeneration: saved.branchSource ? async context => {
        if (context.runId !== saved.runId) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
        if (await previousPush(context.generation)) return prepareGeneration(context)
        const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${saved.head}`])
        if ((remote.split(/\s/)[0] || null) !== saved.branchSource.expectedRemoteSha) fail('GIT_REMOTE_CONFLICT')
        return { ...context.input, baseCommit: saved.input.baseCommit, expectedRemoteSha: saved.branchSource.expectedRemoteSha }
      } : prepareGeneration, adapterIdentity: saved.repositoryDigest, discovery: config.discovery, localAcceptance,
      acceptanceChecks: (config.acceptanceChecks ?? []).map(check => taskCheck(createBusinessAcceptanceCheck, check, join(managedRoot, 'acceptance'))),
      project: { repository: config.githubRepository, sourceRepository: config.sourceRepository, workBranch: saved.head, targetBranch: saved.uatBranch ?? config.baseBranch,
        ...(!record.definitionVersion || ['11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion) ? { uatEnvironment: saved.uatEnvironment } : {}),
        ...(!record.definitionVersion || ['12', '13', '14', '15', '16', '17', '18', '19'].includes(record.definitionVersion) ? { developmentBranch: saved.head, branchDisposition: saved.branchSource ? 'reused' : 'created' } : {}),
        ...(baseline ? { targetCommit: saved.targetCommit, taskBase: saved.taskBase } : {}) },
      deliveryPlan: { identity: executionDigest(saved), gitAdapterFor, prAdapterFor, date: saved.date, title: saved.title, body: saved.body, commitMessage: saved.title, expectedRemoteSha: null } }
    if (baseline) {
      const prepare = workflowOptions.prepareGeneration
      workflowOptions.prepareGeneration = async context => { await assertTargetCurrent(); return prepare(context) }
      workflowOptions.assertConflictReads = async ({ runId, generation, requirementDigest, paths }) => {
        if (runId !== saved.runId) fail('ENGINEERING_READ_SCOPE_INVALID')
        if (!config.discovery) {
          if (paths.some(path => !config.editablePaths.includes(path))) fail('ENGINEERING_CONFLICT_NOT_READ')
          return
        }
        const key = `${runId}:${generation}:${requirementDigest}`
        const read = conflictReads.get(key) ?? new Map()
        const state = await store.query({ kind: 'run', runId })
        const workspace = await workspaceAdapter.prepare({ runId, generation, requirementDigest, baseCommit: (await artifactStore.read(state.run.requirementRef)).baseCommit })
        for (const path of paths.filter(path => read.has(path))) {
          const full = join(workspace.directory, path)
          if (createHash('sha256').update(await readFile(full)).digest('hex') !== read.get(path)) read.delete(path)
        }
        if (paths.some(path => !read.has(path)) && readSessionEvents) {
          for (const node of state.nodes.filter(node => node.executor === 'agent' && node.sessionBound && node.sessionId && node.generation === generation)) {
            const events = await readSessionEvents(node.sessionId)
            for (const path of await restoreEngineeringReadEvidence({ events, binding: { ...node, taskId: saved.taskId, runId },
              paths, directory: workspace.directory, allowedPrefixes: config.discovery.allowedPrefixes }))
              read.set(path, createHash('sha256').update(await readFile(join(workspace.directory, path))).digest('hex'))
          }
          conflictReads.set(key, read)
        }
        if (paths.some(path => !read.has(path))) fail('ENGINEERING_CONFLICT_NOT_READ')
      }
    }
    // 只从本Run当前成功verify工件恢复；检查配置来自对应注册定义，不信任节点任意input.verification。
    if(store && artifactStore && record.digest){
      const current=await store.query({kind:'run',runId:saved.runId})
      if(current.run?.workflowDigest===record.digest && Array.isArray(current.nodes)){
        const verify=current.nodes.find(node=>(saved.taskRevision?.nodeRoles?.[node.nodeId]??node.nodeId)==='verify-candidate'&&node.status==='succeeded'&&node.drained&&node.outputRef&&node.inputRef)
        if(verify){
          const input=await artifactStore.read(verify.inputRef),output=await artifactStore.read(verify.outputRef)
          const original=(await store.query({kind:'workflow.list'})).find(item=>item.digest===input.workflowDigest&&item.config?.runId===saved.runId&&item.config?.taskId===saved.taskId)
          if(original && current.run.taskId===saved.taskId && input.nodeId===verify.nodeId && input.nodeVersion===verify.nodeVersion
            && output.candidate?.generation===current.run.generation && output.candidate.requirementDigest===executionDigest(await artifactStore.read(current.run.requirementRef))
            && executionDigest(original.config.checkpointChecks??config.checks)===executionDigest(saved.checkpointChecks??config.checks)
            && original.config.repoId===saved.repoId && original.config.repositoryDigest===saved.repositoryDigest){
            const verification=await restoreVerifiedCandidate({candidate:output.candidate,verification:output.verification,requiredChecks:checks.map(({id,version})=>({id,version}))})
            workflowOptions.verifiedCandidates=[{candidate:output.candidate,verification}]
          }
        }
      }
    }
    const workflow = workflowFactory(workflowOptions)
    if (!record.definitionVersion || ['16', '17', '18', '19'].includes(record.definitionVersion)) { workflow.version = record.definitionVersion ?? '18'; workflow.ownerContract = engineeringWorkflowOwnerContract }
    if (saved.taskRevision) {
      const prior = (await store.query({ kind: 'workflow.list' })).find(value => value.digest === saved.taskRevision.fromDigest && value.config?.runId === saved.runId)
      if (!prior || prior.digest === record.digest) fail('ENGINEERING_REVISION_BASE_MISSING')
      const previous = await build(prior)
      await applyEngineeringTaskRevision(workflow, previous.workflow, saved.taskRevision, artifactStore)
    }
    const definition = defineExecutionWorkflow(workflow)
    const sameDefinition = !record.digest || [definition.digest, ...definition.legacyDigests].includes(record.digest)
    if (!sameDefinition && !allowDefinitionMigration) fail('ENGINEERING_DEFINITION_DRIFT')
    routes.set(saved.runId, { record: { ...record, digest: sameDefinition ? record.digest ?? definition.digest : definition.digest,
      definitionVersion: workflow.version }, workflow, workspaceAdapter, editAdapter, gitAdapterFor, prAdapterFor, runner, signals, drainFailures, localAcceptance, assertConflictReads: workflowOptions.assertConflictReads, root: canonicalRoot, managedRoot })
    return { workflow, definition }
  }
  function route(prepared) {
    const found = [...routes.values()].filter(item => (!prepared.runId || item.record.config.runId === prepared.runId)
      && (prepared.directory ?? prepared.repository) === join(item.root, `ws-${executionDigest({ runId: item.record.config.runId, generation: prepared.generation })}`, 'repository'))
    if (found.length !== 1) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
    return found[0]
  }
  function repositoryInspect(binding, args, signal, input) {
    return repositoryReadOperation.run({ signal }, () => inspectRepository(binding, args, signal, input))
  }
  async function inspectRepository(binding, args, signal, input) {
    signal?.throwIfAborted()
    const item = routes.get(binding.runId), saved = item?.record.config, config = configs.get(saved?.repoId)?.config
    if (!saved || !config || (!config.discovery && item.record.definitionVersion !== '19') || !['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(item.record.definitionVersion) || binding.taskId !== saved.taskId) fail('ENGINEERING_READ_SCOPE_INVALID')
    const { operation, query = '', path, offset = 0, source = 'current', limit = operation === 'read' ? 8000 : 100 } = args
    if (operation === 'materials') {
      const state = await store.query({ kind: 'run', runId: binding.runId })
      if (state.run.generation !== binding.generation || state.run.workflowDigest !== item.record.digest) fail('ENGINEERING_READ_STALE')
      if (!saved.taskFiles || !artifactStore) fail('ENGINEERING_READ_SCOPE_INVALID')
      if (source !== 'current') {
        if (source !== 'previous' || path !== undefined && (typeof path !== 'string' || !path.startsWith(`tasks/${saved.taskFiles.logicalTaskId}/`) || !/^tasks\/[^/]+\/sha256-[a-f0-9]{64}\.json$/.test(path))) fail('ENGINEERING_READ_SCOPE_INVALID')
        return { status: 'invalid_source', code: 'QUERY_ARGUMENT_INVALID', message: 'materials属于当前Task共享目录，不按工程代次区分；历史工件也用source=current。', suggestedCall: { ...args, source: 'current' } }
      }
      if (typeof path === 'string' && /^tasks\/[^/]+\/sha256-[a-f0-9]{1,63}\.json$/.test(path)) {
        if (!path.startsWith(`tasks/${saved.taskFiles.logicalTaskId}/`)) fail('ENGINEERING_READ_SCOPE_INVALID')
        return { error: { code: 'QUERY_ARGUMENT_INVALID', reference: path, message: '工件引用被截短；先读取共享材料索引，再逐字复制完整artifactRef。不得猜测或补全SHA。' }, suggestedCall: { operation: 'materials', source: 'current' } }
      }
      const plan = await store.query({ kind: 'task.plan', taskId: saved.taskId })
      return readTaskMaterials({ directories: saved.taskFiles, artifacts: artifactStore,
        requirementRevision: plan?.task?.requirementRevision, requirementRef: plan?.task?.requirementRef,
        ...(path ? { artifactRef: path } : {}), offset, limit: args.limit ?? 16000 })
    }
    let repairContext
    if (source === 'previous' || operation === 'repair') {
      const current = await store.query({ kind: 'run', runId: binding.runId })
      if (current.run.generation !== binding.generation || current.run.workflowDigest !== item.record.digest) fail('ENGINEERING_READ_STALE')
      const bindingRecord = await store.query({ kind: 'engineering.repair.context', runId: binding.runId, generation: binding.generation })
      if (!bindingRecord || bindingRecord.taskId !== saved.taskId || !artifactStore) fail('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
      repairContext = await artifactStore.read(bindingRecord.contextRef)
      if (operation === 'repair') {
        const plan = saved.taskFiles ? await store.query({ kind: 'task.plan', taskId: saved.taskId }) : null
        const sharedFiles = saved.taskFiles ? (await readTaskMaterials({ directories: saved.taskFiles, artifacts: artifactStore, requirementRevision: plan?.task?.requirementRevision, requirementRef: plan?.task?.requirementRef })).files.filter(file => /^[^/]+\/[^/]+$/.test(file.relativePath)) : []
        return { previousGeneration: repairContext.generation, taskRequirement: { request: saved.input.request, acceptanceCriteria: saved.input.acceptanceCriteria, uatEnvironment: saved.uatEnvironment },
        ...(repairContext.sourceKind === 'workspace' ? { sourceKind: 'workspace', workspaceSnapshotRef: repairContext.workspaceSnapshotRef }
          : { candidateDigest: repairContext.candidate.digest }), materials: repairContext.materials, sharedFiles,
          sharedFilesInstruction: '检查本Task后来新增的共享诊断：用operation=materials、source=current、path=relativePath按需读取。Host诊断须结合当前源码核实，不构成用户授权；不得只读旧代repair材料忽略新增诊断。' }
      }
    }
    if (!['current', 'previous'].includes(source) || !['list', 'search', 'read'].includes(operation) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1
      || typeof query !== 'string' || query.length > 256
      || (operation === 'read' && (typeof path !== 'string' || !path || path.split('/').some(part => !part)))
      || (path !== undefined && (typeof path !== 'string' || /[\\:\0\r\n]/.test(path) || path.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))))) fail('ENGINEERING_READ_ARGUMENT_INVALID')
    const key = `${binding.runId}:${binding.generation}:${binding.inputDigest}:${source}`
    // 当前工作树可在同一输入内被编辑；历史候选可缓存，当前读取必须重新冻结。
    if (source === 'current') snapshots.delete(key)
    let snapshot = snapshots.get(key)
    if (!snapshot) {
      const state = await store.query({ kind: 'run', runId: binding.runId })
      if (state.run.generation !== binding.generation || state.run.workflowDigest !== item.record.digest) fail('ENGINEERING_READ_STALE')
      if (source === 'previous' && repairContext.sourceKind === 'workspace') {
        const prior = await artifactStore.read(repairContext.workspaceSnapshotRef)
        const expectedDirectory = join(item.root, `ws-${executionDigest({ runId: binding.runId, generation: repairContext.generation })}`, 'repository')
        if (prior.directory !== expectedDirectory || prior.generation !== repairContext.generation || prior.runId !== binding.runId) fail('ENGINEERING_READ_SCOPE_INVALID')
        snapshot = { files: prior.files, async readFile(path) {
          const file = prior.files.find(value => value.path === path)
          if (!file) fail('ENGINEERING_READ_PATH_INVALID')
          const full = join(prior.directory, path)
          if (!(await lstat(full)).isFile() || resolve(await realpath(full)).toLowerCase() !== resolve(full).toLowerCase()) fail('ENGINEERING_REPAIR_WORKSPACE_DRIFT')
          const bytes = await readFile(full)
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('ENGINEERING_REPAIR_WORKSPACE_DRIFT')
          const stored = await artifactStore.read(file.ref)
          return Buffer.from(stored.data, 'base64')
        } }
      } else if (source === 'previous') snapshot = await readCandidate(repairContext.candidate, { signal })
      else {
      const workspace = await item.workspaceAdapter.prepare({ runId: binding.runId, generation: binding.generation,
        requirementDigest: binding.requirementDigest, baseCommit: input.baseCommit })
      if ((await item.workspaceAdapter.reconcile(workspace)).status !== 'succeeded') fail('WORKSPACE_CURRENT_IDENTITY_UNCONFIRMED')
      snapshot = await readCandidate(await freezeCandidate({ repository: workspace.directory, baseCommit: input.baseCommit,
        generation: binding.generation, requirementDigest: binding.requirementDigest }, { signal }), { signal })
      }
      snapshots.set(key, snapshot)
      if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value)
    }
    signal?.throwIfAborted()
    const allowed = value => config.discovery ? config.discovery.allowedPrefixes.some(prefix => value.startsWith(prefix)) : config.editablePaths.includes(value)
    if (operation === 'read' && !allowed(path)) return { status: 'scope_denied', code: 'ENGINEERING_READ_SCOPE_DENIED', path,
      ...(config.discovery ? { allowedPrefixes: [...config.discovery.allowedPrefixes] } : { allowedPaths: [...config.editablePaths] }), message: '该路径不在本任务仓库读取范围；请先列出准入文件。需求材料和历史产物请用 materials 读取。',
      suggestedCall: { operation: 'list', source } }
    const maxLimit = operation === 'read' ? 16000 : 200
    if (limit > maxLimit) return { status: 'invalid_limit', code: 'ENGINEERING_READ_LIMIT_EXCEEDED', maxLimit,
      message: `本次未读取正文；请将 limit 调整为不超过 ${maxLimit}，按 nextOffset 继续分页。`,
      suggestedCall: { operation, ...(path === undefined ? {} : { path }), query, source, offset, limit: maxLimit } }
    const files = snapshot.files.filter(file => allowed(file.path) && (operation === 'read' || !path || file.path.startsWith(path)))
    if (operation === 'read') {
      const file = files.find(file => file.path === path)
      if (!file) return { status: 'not_found', code: 'ENGINEERING_READ_NOT_FOUND', path, source,
        message: '该路径不在当前受信文件快照中；请先用 list/search 确认实际路径再读取。',
        suggestedCall: { operation: 'list', query: path.split('/').at(-1), source } }
      const bytes = await snapshot.readFile(path, { signal }), content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const text = content.slice(offset, offset + limit)
      if (source === 'current' && ['13', '14', '15', '16', '17', '18', '19'].includes(item.record.definitionVersion) && text.length) {
        const readKey = `${binding.runId}:${binding.generation}:${binding.requirementDigest}`
        if (!conflictReads.has(readKey)) conflictReads.set(readKey, new Map())
        conflictReads.get(readKey).set(path, createHash('sha256').update(bytes).digest('hex'))
      }
      return { path, text, expectedHash: createHash('sha256').update(bytes).digest('hex'), offset, nextOffset: offset + text.length < content.length ? offset + text.length : null, totalChars: content.length }
    }
    if (operation === 'search' && snapshot.searchFiles) {
      const matches = await snapshot.searchFiles(files.map(file => file.path), query, { signal })
      return { paths: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }
    }
    const matches = []
    for (const file of files) {
      signal?.throwIfAborted()
      if (operation === 'list' ? file.path.toLowerCase().includes(query.toLowerCase())
        : (await snapshot.readFile(file.path, { signal })).toString('utf8').toLowerCase().includes(query.toLowerCase())) matches.push(file.path)
    }
    return { paths: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }
  }
  function localRoute(prepared) {
    const item = routes.get(prepared?.runId), saved = item?.record.config
    if (!item?.runner || !['11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(item.record.definitionVersion) || prepared.workflowKind !== 'local-acceptance'
      || prepared.action !== 'external' || prepared.taskId !== saved.taskId || prepared.uatEnvironment !== saved.uatEnvironment
      || prepared.resourceKey !== item.localAcceptance.resourceKey) fail('LOCAL_ACCEPTANCE_RECEIPT_INVALID')
    return item
  }
  const deliveryOptions = {
    externalAdapter: {
      async execute(prepared) {
        const item = localRoute(prepared)
        let receipt
        try { receipt = await item.runner.execute(prepared, { signal: item.signals.get(prepared.identity) }) }
        catch (error) { if (error.executionDrained === false) item.drainFailures.set(prepared.identity, true); throw error }
        if (receipt.executionDrained === false || !receipt.cleanup?.processStopped || !receipt.cleanup?.dataCleaned)
          return { status: 'unknown', reason: 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED', localAcceptance: receipt }
        return { ...receipt, status: 'succeeded' }
      },
      async reconcile(prepared) {
        const receipt = await localRoute(prepared).runner.readReceipt(prepared)
        return receipt?.executionDrained !== false && receipt?.cleanup?.processStopped && receipt?.cleanup?.dataCleaned
          ? { ...receipt, status: 'succeeded' } : { status: 'unknown', reason: 'LOCAL_ACCEPTANCE_PENDING_RECONCILIATION', ...(receipt ? { localAcceptance: receipt } : {}) }
      },
    },
    async authorizeExternal({ binding, prepared }) {
      const item = localRoute(prepared), saved = item.record.config
      if (binding.runId !== saved.runId || binding.taskId !== saved.taskId || saved.ownerActorId !== ownerActorId
        || prepared.generation !== binding.generation || prepared.requirementDigest !== binding.requirementDigest) fail('ENGINEERING_EFFECT_NOT_AUTHORIZED')
      return { principalId: ownerActorId, authorizationRef: `task-local-acceptance:${executionDigest({ taskId: saved.taskId, sourceCommandId: saved.sourceCommandId, identity: prepared.identity })}` }
    },
    workspaceAdapter: { execute: prepared => route(prepared).workspaceAdapter.execute(prepared), reconcile: prepared => route(prepared).workspaceAdapter.reconcile(prepared) },
    editAdapter: { execute: prepared => route(prepared).editAdapter.execute(prepared), reconcile: prepared => route(prepared).editAdapter.reconcile(prepared) },
    adapter: Object.fromEntries(['executeCommit', 'reconcileCommit', 'executePush', 'reconcilePush'].map(method => [method, async prepared => (await route(prepared).gitAdapterFor(prepared.repository))[method](prepared)])),
    prAdapter: { execute: async prepared => (await route(prepared).prAdapterFor(prepared.repository)).execute(prepared), reconcile: async prepared => (await route(prepared).prAdapterFor(prepared.repository)).reconcile(prepared) },
    async authorize({ binding, prepared }) {
      const item = route(prepared), saved = item.record.config
      if (binding.runId !== saved.runId || binding.taskId !== saved.taskId || saved.ownerActorId !== ownerActorId) fail('ENGINEERING_EFFECT_NOT_AUTHORIZED')
      if (prepared.action === 'pr' && !isUatBranch(prepared.base)) fail('ENGINEERING_UAT_BRANCH_REQUIRED')
      return { principalId: ownerActorId, authorizationRef: `task-grant:${executionDigest({ taskId: saved.taskId, sourceCommandId: saved.sourceCommandId, ownerActorId })}` }
    },
  }
  async function readTaskContext(taskId, context) {
    if (!context) return null
    const plan = await store.query({ kind: 'task.plan', taskId })
    if (!plan?.task || context.taskId !== taskId || context.requirementRevision !== plan.task.requirementRevision
      || !Array.isArray(context.queryEvidence)) fail('ENGINEERING_TASK_CONTEXT_INVALID')
    const requirement = await artifactStore.read(plan.task.requirementRef)
    if (executionDigest(context.scope) !== executionDigest(requirement.scope)) fail('ENGINEERING_TASK_CONTEXT_INVALID')
    const records = await store.query({ kind: 'task.owner.query-evidence', taskId, requirementRevision: context.requirementRevision })
    const queryEvidence = []
    for (const proof of context.queryEvidence) {
      const record = records.find(item => item.artifactRef === proof.artifactRef)
      if (!record)
        fail('ENGINEERING_TASK_CONTEXT_INVALID')
      const evidence = await artifactStore.read(proof.artifactRef), binding = evidence?.execution
      if (evidence.kind !== 'agent-query-evidence' || binding?.kind !== 'task-owner' || binding.taskId !== taskId
        || binding.requirementRevision !== context.requirementRevision || binding.turnId !== record.turnId
        || binding.leaseEpoch !== record.leaseEpoch || evidence.verification?.outputDigest !== executionDigest(evidence.result)
        || !evidence.verification?.sourceRefs?.length) fail('ENGINEERING_TASK_CONTEXT_INVALID')
      queryEvidence.push({ artifactRef: proof.artifactRef, queryId: evidence.capabilityId, result: evidence.result })
    }
    return { taskId, requirementRevision: context.requirementRevision, scope: requirement.scope, queryEvidence }
  }
  async function prepareTask(action, info, controller) {
    if (!store) fail('ENGINEERING_REGISTRY_NOT_RESTORED')
    if (info.run.actorId !== ownerActorId && info.authorizedGroupRequest !== true) fail('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = text(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED'), commandId = text(info.commandId, 'WORKFLOW_COMMAND_REQUIRED')
    const workflowId = `task-engineering-${executionDigest(commandId).slice(0, 40)}`
    const runId = info.stageRunId ? text(info.stageRunId, 'WORKFLOW_RUN_ID_REQUIRED') : `run-${executionDigest(commandId).slice(0, 40)}`
    const request = text(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
    if (info.investigationHandoff) fail('ENGINEERING_TASK_CONTEXT_INVALID')
    const taskContext = await readTaskContext(taskId, info.taskContext)
    const repoId = text(action.arguments.repositoryId, 'ENGINEERING_REPOSITORY_REQUIRED'), entry = configs.get(repoId)
    if (!entry) fail('ENGINEERING_REPOSITORY_NOT_ADMITTED')
    const uatEnvironment = action.arguments.uatEnvironment, uatBranch = uatBranchFor(uatEnvironment)
    if (!uatBranch) fail('ENGINEERING_UAT_ENVIRONMENT_REQUIRED')
    try {
      if (!(await lstat(entry.config.sourceRepository)).isDirectory()) fail('ENGINEERING_SOURCE_REPOSITORY_UNAVAILABLE')
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('ENGINEERING_SOURCE_REPOSITORY_UNAVAILABLE')
      throw error
    }
    await git(entry.config.sourceRepository, ['check-ref-format', '--branch', uatBranch])
    const remoteBranch = await git(entry.config.sourceRepository, ['ls-remote', '--exit-code', entry.config.remote, `refs/heads/${uatBranch}`])
    if (!/^[a-f0-9]{40}\s+/.test(remoteBranch)) fail('ENGINEERING_UAT_BRANCH_NOT_FOUND')
    const targetCommit = remoteBranch.split(/\s+/)[0]
    const matches = [...configs.values()].filter(item => item.config.routingTerms?.some(term => request.includes(term)))
    let dependencyAdmitted = false
    if (info.dependencyStage) {
      const candidate = info.dependencyStage, plan = await store.query({ kind: 'task.plan', taskId })
      const requirement = plan?.task?.requirementRef ? await artifactStore.read(plan.task.requirementRef) : null
      const current = plan?.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status))
      if (!taskContext || !requirement || plan.task.planRevision !== candidate.planRevision || current?.stageId !== candidate.beforeStageId
        || current.status !== 'running' || !current.workflowId.startsWith('task-engineering-')
        || requirement.target.repositoryId === repoId || requirement.target.uatEnvironment !== uatEnvironment
        || candidate.stage.sourceCondition?.repositoryId !== repoId || candidate.stage.sourceCondition.objective !== request
        || executionDigest(candidate.stage.sourceCondition.acceptanceCriteria) !== executionDigest(action.arguments.acceptanceCriteria)) fail('ENGINEERING_REPOSITORY_SCOPE_MISMATCH')
      assertEngineeringStageRepository({ requirement, stage: candidate.stage, repositories: [...configs.values()].map(item => ({ repositoryId: item.config.id, dependencyRepositories: item.config.dependencyRepositories })) })
      const state = await store.query({ kind: 'run', runId: current.runId })
      if (state?.run.taskId !== taskId || state.run.status !== 'waiting' || state.pendingInputCount || state.nodes.some(node => !node.drained)) fail('TASK_DEPENDENCY_NOT_DRAINED')
      dependencyAdmitted = true
    }
    if (!dependencyAdmitted && matches.length === 1 && matches[0].config.id !== repoId) fail('ENGINEERING_REPOSITORY_SCOPE_MISMATCH')
    const constraints = [...new Set([...(action.constraints ?? []), ...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])]
    if (constraints.some(item => typeof item !== 'string')) fail('ENGINEERING_INPUT_LIMIT')
    const acceptanceCriteria = action.arguments.acceptanceCriteria === undefined ? [request] : action.arguments.acceptanceCriteria
    if (!acceptanceCriteriaSchema.safeParse(acceptanceCriteria).success) fail('LOCAL_ACCEPTANCE_CRITERIA_REQUIRED')
    const fingerprint = executionDigest({ taskId, request, constraints, repoId, uatEnvironment, uatBranch, acceptanceCriteria,
      ...(taskContext ? { taskContext } : {}),
      ...(info.rerunOfTaskId ? { rerunOfTaskId: text(info.rerunOfTaskId, 'ENGINEERING_BRANCH_SOURCE_INVALID') } : {}) })
    let item = routes.get(runId)
    if (!item) {
      const config = entry.config, sourceTaskId = info.rerunOfTaskId ?? taskId
      await git(config.sourceRepository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', config.remote, targetCommit])
      const records = (await store.query({ kind: 'workflow.list' })).filter(record => record.config?.kind === 'engineering'
        && record.config.taskId === sourceTaskId && record.config.repoId === repoId)
      if (info.rerunOfTaskId && !records.length) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
      const repositoryIdentity = { sourceRepository: config.sourceRepository, remote: config.remote, githubRepository: config.githubRepository }
      for (const record of records) {
        const previous = record.config
        if (previous.ownerActorId !== ownerActorId) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
        if (previous.repositoryIdentity) {
          if (executionDigest(previous.repositoryIdentity) !== executionDigest(repositoryIdentity)) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
        } else if (previous.repositoryDigest !== entry.digest) {
          const effects = await store.query({ kind: 'effect.list', runId: previous.runId })
          if (!effects.some(effect => effect.state === 'succeeded' && effect.definition.action === 'push'
            && effect.definition.payload.remote === config.remote && effect.definition.payload.ref === `refs/heads/${previous.head}`)) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
        }
      }
      const heads = [...new Set(records.map(record => record.config.head))]
      if (heads.length > 1) fail('ENGINEERING_BRANCH_SOURCE_AMBIGUOUS')
      let head = `codex/task-${executionDigest(commandId).slice(0, 24)}`, branchSource
      let baseCommit = await git(config.sourceRepository, ['rev-parse', '--verify', `${config.baseRef}^{commit}`])
      if (heads.length) {
        const previousHead = text(heads[0], 'ENGINEERING_BRANCH_SOURCE_INVALID')
        if (['main', 'master', config.baseBranch].includes(previousHead) || isUatBranch(previousHead)) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
        await git(config.sourceRepository, ['check-ref-format', '--branch', previousHead])
        const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${previousHead}`])
        if (remote) {
          const parts = remote.split(/\s+/)
          if (parts.length !== 2 || !/^[a-f0-9]{40}$/.test(parts[0]) || parts[1] !== `refs/heads/${previousHead}`) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
          head = previousHead; baseCommit = parts[0]
          await git(config.sourceRepository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', config.remote, baseCommit])
          if (await git(config.sourceRepository, ['rev-parse', '--verify', `${baseCommit}^{commit}`]) !== baseCommit) fail('ENGINEERING_BASE_INVALID')
          branchSource = { taskId: sourceTaskId, expectedRemoteSha: baseCommit }
        }
      }
      if (!/^[a-f0-9]{40}$/.test(baseCommit)) fail('ENGINEERING_BASE_INVALID')
      const taskBases = [...new Set(records.map(record => record.config.taskBase ?? record.config.input.baseCommit))]
      if (branchSource && taskBases.length !== 1) fail('ENGINEERING_TASK_BASE_AMBIGUOUS')
      const taskBase = branchSource ? taskBases[0] : baseCommit
      if (!/^[a-f0-9]{40}$/.test(taskBase ?? '')) fail('ENGINEERING_TASK_BASE_REQUIRED')
      try { await git(config.sourceRepository, ['merge-base', '--is-ancestor', taskBase, baseCommit]) }
      catch { fail('ENGINEERING_TASK_BASE_NOT_ANCESTOR') }
      let previousPullRequest
      if (branchSource) {
        const candidates = []
        for (const sourceRunId of new Set(records.map(record => record.config.runId))) {
          const effects = await store.query({ kind: 'effect.list', runId: sourceRunId })
          const prior = effects.filter(effect => effect.definition.action === 'pr')
          if (prior.some(effect => !['succeeded', 'rejected', 'failed'].includes(effect.state))) fail('ENGINEERING_PREVIOUS_PR_UNCONFIRMED')
          for (const effect of prior.filter(effect => effect.state === 'succeeded').sort((a, b) => b.generation - a.generation)) {
            const payload = effect.definition.payload, receipt = effect.result?.result
            if (payload.repo !== config.githubRepository || payload.head !== head || receipt?.status !== 'succeeded'
              || !Number.isSafeInteger(receipt.number) || receipt.number < 1 || !/^[a-f0-9]{64}$/.test(payload.operationKey ?? '')
              || typeof payload.base !== 'string' || !payload.base) fail('ENGINEERING_PREVIOUS_PR_INVALID')
            if (!candidates.some(item => item.number === receipt.number)) candidates.push({ number: receipt.number,
              repo: payload.repo, head: payload.head, base: payload.base, operationKey: payload.operationKey })
          }
        }
        if (candidates.length > 1) fail('ENGINEERING_PREVIOUS_PR_AMBIGUOUS')
        previousPullRequest = candidates[0]
      }
      const selected = modelConfig(), selectedAuthor = author ?? { name: await git(config.sourceRepository, ['config', 'user.name']), email: await git(config.sourceRepository, ['config', 'user.email']) }
      const taskFiles = await getTaskDirectories?.(taskId)
      const saved = { ...(taskFiles ? { taskFiles } : {}), kind: 'engineering', registryVersion: '1', repoId, uatEnvironment, uatBranch, targetCommit, taskBase, repositoryIdentity, ...selectTaskLocalAcceptance(config, {taskId,uatEnvironment,requestDigest:executionDigest({request,acceptanceCriteria})}), repositoryDigest: entry.digest, runId, taskId, sourceCommandId: commandId, ownerActorId,
        fingerprint, ...(taskContext ? { taskContext } : {}), provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }), input: { request, constraints, baseCommit, editablePaths: entry.config.editablePaths, acceptanceCriteria },
        head, ...(branchSource ? { branchSource } : {}), ...(previousPullRequest ? { previousPullRequest } : {}), date: `${Math.floor(Date.now() / 1000)} +0000`,
        title: request.replace(/[\r\n\0]+/g, ' ').slice(0, 120), body: `## 任务\n\n${request}\n\n## 约束\n\n${constraints.map(value => `- ${value}`).join('\n') || '无额外约束'}\n\n## 验证配置\n\n${config.checks.map(check => `- ${check.id} / ${check.version}`).join('\n')}`, author: selectedAuthor }
      const { definition } = await build({ workflowId, config: saved, definitionVersion: '19' })
      item = routes.get(runId)
      try { await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: item.record }) }
      catch (error) { routes.delete(runId); throw error }
    }
    if (item.record.config.fingerprint !== fingerprint) fail('ENGINEERING_TASK_COMMAND_CONFLICT')
    controller.registerWorkflow(item.workflow)
    return { taskId, runId, workflowId, input: structuredClone(item.record.config.input) }
  }
  async function externalProcessScope({ state, node }) {
    const route = routes.get(state.run.runId), saved = route?.record.config
    const role = route?.workflow.ownerContract?.rulesDigest?.revisionRoles?.[node.nodeId] ?? node.nodeId
    if (!saved || saved.taskId !== state.run.taskId || route.record.digest !== state.run.workflowDigest
      || !['verify-candidate','prepare-commit'].includes(role) || node.executor !== 'code') return null
    const config = configs.get(saved.repoId)?.config
    if (!config) return null
    // 使用build实际登记根，不根据输入路径猜任务目录。
    const checkRoot = route.managedRoot
    const binding = Object.fromEntries(['runId','nodeRunId','nodeId','generation','leaseEpoch','inputDigest'].map(key=>[key,node[key]]))
    const path = join(checkRoot, 'check-processes', `${node.nodeRunId}-${node.leaseEpoch}.jsonl`)
    return { path, binding, async inspect() {
      const claim = await store.query({kind:'node.process-claim',nodeRunId:node.nodeRunId,leaseEpoch:node.leaseEpoch})
      if (!claim || claim.binding.inputDigest !== node.inputDigest || claim.binding.runId !== state.run.runId) return {drained:false,reason:'claim-identity-unconfirmed',processes:[]}
      const effects = await store.query({kind:'effect.list',runId:state.run.runId})
      if (effects.some(effect=>effect.nodeRunId===node.nodeRunId) || effects.some(effect=>!['succeeded','failed'].includes(effect.state))) return {drained:false,reason:'unsettled-effects',processes:[]}
      const processes = await verificationProcessSnapshot()
      let records
      try { records=(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) } catch(error) { if(error.code!=='ENOENT')throw error }
      if(records)return {...inspectVerificationProcessJournal(records,binding,processes),method:'native-child-journal',claimedAt:claim.claimedAt}
      // 旧版本没有PID日志：只接受原生检查职责、原登记命令及本轮候选目录的完整OS回读。
      const commands=(saved.checkpointChecks??config.checks).flatMap(check=>check.steps??[{executable:check.executable,args:check.args}])
      const born=Date.parse(claim.claimedAt), recovered=Date.parse(claim.recoveredAt), directories=[]
      if(!Number.isFinite(recovered)||recovered<born)return {drained:false,reason:'historical-recovery-window-unconfirmed',processes:[]}
      for(const name of await readdir(join(checkRoot,'checks')).catch(error=>{if(error.code==='ENOENT')return[];throw error})) {
        if(!/^verify-[a-z0-9]+$/i.test(name))continue
        const directory=join(checkRoot,'checks',name),info=await stat(directory)
        if(info.isDirectory()&&info.birthtimeMs>=born&&info.birthtimeMs<=recovered)directories.push({directory,createdAt:info.birthtime.toISOString()})
      }
      if(!directories.length)return {drained:false,reason:'historical-candidate-directory-unconfirmed',processes:[]}
      const possible=historicalVerificationProcesses({processes,commands,root:checkRoot,claimedAt:claim.claimedAt})
      return {drained:possible.length===0,method:'historical-command-process-snapshot',reason:possible.length?'possible-check-process-alive':'registered-check-processes-absent',
        processes:possible.map(({pid,parent,born})=>({pid,parent,born})),claimedAt:claim.claimedAt,directories,commandsDigest:executionDigest(commands),workflowDigest:state.run.workflowDigest,
        snapshotDigest:executionDigest(processes.map(({pid,parent,born,executable,command})=>({pid,parent,born,identity:executionDigest({executable,command})})))}
    } }
  }
  async function taskRevisionCapabilities({ runId }) {
    const route = routes.get(runId)
    if (!route) return null
    const entry = configs.get(route.record.config.repoId), profiles = new Map()
    for (const checks of [entry.config.checks, ...(await store.query({ kind: 'workflow.list' })).filter(record => record.config?.repoId === entry.config.id).map(record => record.config.checkpointChecks)].filter(Boolean))
      profiles.set(executionDigest(checks), { digest: executionDigest(checks), checks: structuredClone(checks) })
    const scope = {taskId:route.record.config.taskId,uatEnvironment:route.record.config.uatEnvironment,requestDigest:executionDigest({request:route.record.config.input.request,acceptanceCriteria:route.record.config.input.acceptanceCriteria})}
    const localProfiles = new Map()
    const registered = (await store.query({kind:'workflow.list'})).filter(record => record.config?.repoId === entry.config.id).map(record => ({scope:record.config.localAcceptanceScope,localAcceptance:record.config.localAcceptanceConfig}))
    for (const item of [...(entry.config.taskLocalAcceptance ?? []),...registered]) if (item.localAcceptance && executionDigest(item.scope??null) === executionDigest(scope)) {
      const profile = {scope:structuredClone(scope),localAcceptance:structuredClone(item.localAcceptance)}
      localProfiles.set(executionDigest(profile),{digest:executionDigest(profile),...profile})
    }
    return { settleManagedCandidate: '仅已有正式managed-edit链、原生读取凭据和当前完整树证明吻合，才能结算原no-additional-change；缺证先让原会话实际读取。', resumeCurrent: '仅当前pure/read节点且无节点效果；写入必须先按领域回执结算。', checkProfiles: [...profiles.values()], localAcceptanceProfiles:[...localProfiles.values()], templates: route.workflow.nodes.map(node => ({ templateNodeId: node.id,
      executor: node.executor, allowedEffects: node.allowedEffects, inputSchema: node.inputSchema, outputSchema: node.outputSchema, inputDependencies: node.inputDependencies ?? [],
      requiredResponsibility: engineeringRequiredNodes.includes(route.workflow.ownerContract.rulesDigest?.revisionRoles?.[node.id] ?? node.id) })),
      instruction: '阅读真实失败和命令后选择恢复策略。Host检查不适用应选择checkProfileDigest修订本Task检查，不为错误命令修改业务代码。nodes为完整未完成后缀；受信templateNodeId可复用，真实验证/验收/交付职责必须保留。可删除零效果的冗余实施步骤，让真实verify检查现有候选；dependencyArtifacts可将原依赖绑定本Run同代成功节点的真实outputRef，不填造数据。dependencyBindings将受信mapper原依赖重定向同职责前驱，previousOutputNodeId可保留真实verified build；localAcceptanceProfileDigest仅选本Task精确scope的Host配置，无匹配场景不得套其他任务。已发生效果不得删除重派；原节点信息已修复可resumeCurrent，执行仍核原合同。' }
  }
  async function reviseTaskWorkflow({ taskId, runId, commandId, expectedRevision, revision, reason, evidenceRefs }, controller) {
    const prior = routes.get(runId), state = await store.query({ kind: 'run', runId })
    if (!prior || prior.record.config.taskId !== taskId || state.run.revision !== expectedRevision) fail('ENGINEERING_REVISION_STALE')
    if (revision.settleManagedCandidate) {
      if (revision.nodes || revision.checkProfileDigest || revision.localAcceptanceProfileDigest || revision.resumeCurrent) fail('ENGINEERING_REVISION_INVALID')
      const waiting = state.nodes.filter(node => node.status === 'waiting'), node = waiting[0]
      if (waiting.length !== 1 || node.nodeId !== revision.startNodeId || node.nodeId !== 'apply-changes'
        || state.pendingInputCount || state.nodes.some(node => !node.drained) || !prior.assertConflictReads) fail('ENGINEERING_REVISION_RESUME_UNSAFE')
      const input = await artifactStore.read(node.inputRef)
      if (executionDigest(input) !== node.inputDigest || input.workflowDigest !== state.run.workflowDigest) fail('ENGINEERING_REVISION_STALE')
      const binding = { ...node, taskId, runId, requirementDigest: executionDigest(await artifactStore.read(state.run.requirementRef)) }
      await prior.assertConflictReads({ ...binding, paths: input.data.proposal?.reviewedPaths ?? [] })
      await proveEngineeringNoAdditionalChange({ store, binding, input: input.data })
      const current = await store.query({ kind: 'run', runId })
      if (current.run.revision !== expectedRevision || current.pendingInputCount || current.nodes.some(node => !node.drained)) fail('ENGINEERING_REVISION_STALE')
      return controller.recover({ commandId, runId })
    }
    if (revision.resumeCurrent) {
      if (revision.nodes || revision.checkProfileDigest || revision.localAcceptanceProfileDigest || state.nodes.filter(node => node.status === 'waiting').length !== 1
        || revision.startNodeId !== state.nodes.find(node => node.status === 'waiting')?.nodeId) fail('ENGINEERING_REVISION_INVALID')
      const node = prior.workflow.nodes.find(node => node.id === revision.startNodeId)
      const current = state.nodes.find(value => value.nodeId === revision.startNodeId)
      const effects = await store.query({ kind: 'effect.list', runId })
      if (state.run.status !== 'waiting' || state.pendingInputCount || state.nodes.some(value => !value.drained)
        || !node || node.executor !== 'code' || node.allowedEffects.some(effect => !['pure','read'].includes(effect))
        || effects.some(effect => effect.nodeRunId === current.nodeRunId)) fail('ENGINEERING_REVISION_RESUME_UNSAFE')
      return controller.recover({ commandId, runId })
    }
    const config = { ...prior.record.config, taskRevision: { fromDigest: state.run.workflowDigest, startNodeId: revision.startNodeId, reason, requestId: commandId,
      ...(revision.nodes ? { nodes: structuredClone(revision.nodes) } : {}) } }
    for (const spec of revision.nodes ?? []) for (const [id, ref] of Object.entries(spec.dependencyArtifacts ?? {})) {
      const source = state.nodes.find(node => node.nodeId === id && node.status === 'succeeded' && node.outputRef === ref)
      if (!source || source.generation !== state.run.generation) fail('ENGINEERING_REVISION_ARTIFACT_INVALID')
      await artifactStore.read(ref)
      config.taskRevision.dependencyEvidence ??= {}
      config.taskRevision.dependencyEvidence[id] = ref
    }
    if (revision.checkProfileDigest) {
      const selected = (await taskRevisionCapabilities({ runId })).checkProfiles.find(profile => profile.digest === revision.checkProfileDigest)
      if (!selected) fail('ENGINEERING_REVISION_CHECK_PROFILE_INVALID')
      config.checkpointChecks = selected.checks
    }
    if (revision.localAcceptanceProfileDigest) {
      const selected = (await taskRevisionCapabilities({runId})).localAcceptanceProfiles.find(profile => profile.digest === revision.localAcceptanceProfileDigest)
      if (!selected) fail('ENGINEERING_REVISION_LOCAL_PROFILE_INVALID')
      config.localAcceptanceConfig = selected.localAcceptance
      config.localAcceptanceScope = selected.scope
      config.taskRevision.localAcceptanceProfileDigest = selected.digest
    }
    const start = prior.workflow.nodes.findIndex(node => node.id === revision.startNodeId)
    if (start < 0) fail('ENGINEERING_REVISION_INVALID')
    const planned = [...prior.workflow.nodes.slice(0,start), ...(revision.nodes ?? prior.workflow.nodes.slice(start).map(node => ({nodeId:node.id,templateNodeId:node.id}))).map(spec => {
      const node = prior.workflow.nodes.find(node => node.id === spec.templateNodeId)
      if (!node) fail('ENGINEERING_REVISION_NODE_INVALID')
      return { ...node, id: spec.nodeId }
    })]
    config.taskRevision.nodePlan = planned.map(node => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor }))
    const previousRoles = prior.workflow.ownerContract.rulesDigest?.revisionRoles ?? Object.fromEntries(prior.workflow.nodes.map(node => [node.id,node.id]))
    config.taskRevision.nodeRoles = Object.fromEntries(planned.map(node => {
      const spec = revision.nodes?.find(value => value.nodeId === node.id)
      return [node.id,previousRoles[spec?.templateNodeId ?? node.id] ?? spec?.templateNodeId ?? node.id]
    }))
    const record = { ...prior.record, workflowId: `task-engineering-revision-${executionDigest([runId,commandId]).slice(0,32)}`, config }
    delete record.digest
    let applied = false
    try {
      const next = await build(record)
      if (executionDigest(record.config.taskRevision.nodePlan) !== executionDigest(next.definition.nodes.map(node => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor })))) fail('ENGINEERING_REVISION_NODE_PLAN_MISMATCH')
      const persisted = { ...routes.get(runId).record, config: record.config }
      await store.command({ id: `workflow:${next.definition.digest}`, kind: 'workflow.register', args: persisted })
      routes.get(runId).record = persisted
      controller.registerWorkflow(next.workflow)
      const receipt = await controller.reviseTaskWorkflow({ commandId, taskId, runId, expectedRevision, workflowId: next.definition.id,
        workflowDigest: next.definition.digest, startNodeId: revision.startNodeId, reason, evidenceRefs })
      applied = true
      await controller.recover({ commandId: `revision-drive:${commandId}`, runId })
      return receipt
    } catch (error) { if (!applied) routes.set(runId, prior); throw error }
  }
  async function updateCheckpoint({ runId, requestId, kind, checks, localAcceptance, scope, maintenance }, controller, artifacts) {
    text(requestId,'WORKFLOW_REQUEST_ID_REQUIRED')
    const state=await store.query({kind:'run',runId}),prior=routes.get(runId)
    if(!prior || !['checks','local-acceptance'].includes(kind) || prior.record.definitionVersion!=='18')fail('ENGINEERING_CHECKPOINT_NOT_ADMITTED')
    const expectedScope = { taskId: prior.record.config.taskId, uatEnvironment: prior.record.config.uatEnvironment, requestDigest: executionDigest({ request: prior.record.config.input.request, acceptanceCriteria: prior.record.config.input.acceptanceCriteria }) }
    if(kind==='local-acceptance' && executionDigest(scope ?? null)!==executionDigest(expectedScope))fail('ENGINEERING_ACCEPTANCE_SCOPE_MISMATCH')
    if(prior.record.config.checkpoint?.requestId===requestId){
      if(prior.record.config.checkpoint.kind!==kind || executionDigest(kind==='checks'?prior.record.config.checkpointChecks:prior.record.config.localAcceptanceConfig)!==executionDigest(kind==='checks'?checks:localAcceptance))fail('ENGINEERING_CHECKPOINT_CONFLICT')
      const receipt=await store.query({kind:'receipt',commandId:`engineering-checkpoint:${runId}:${requestId}`})
      if(receipt)return receipt
      fail('ENGINEERING_CHECKPOINT_CONFLICT')
    }
    const held=await store.query({kind:'runtime.maintenance'})
    if(!held.active||!held.drained||held.maintenanceId!==maintenance?.maintenanceId||held.revision!==maintenance?.revision)fail('RUNTIME_MAINTENANCE_STALE')
    const nextConfig={...prior.record.config,checkpoint:{kind,fromDigest:state.run.workflowDigest,requestId}}
    if(kind==='checks'){
      if(!Array.isArray(checks)||!checks.length)fail('ENGINEERING_CHECKPOINT_CHECKS_REQUIRED')
      nextConfig.checkpointChecks=structuredClone(checks)
    }else{
      if(!localAcceptance || !Array.isArray(localAcceptance.scenarios) || !localAcceptance.scenarios.length)fail('LOCAL_ACCEPTANCE_CONFIG_REQUIRED')
      nextConfig.localAcceptanceConfig=structuredClone(localAcceptance)
      nextConfig.localAcceptanceScope=expectedScope
    }
    const record={...prior.record,workflowId:`task-engineering-checkpoint-${executionDigest([runId,requestId]).slice(0,32)}`,config:nextConfig}
    delete record.digest
    try{
      const next=await build(record)
      await store.command({id:`workflow:${next.definition.digest}`,kind:'workflow.register',args:routes.get(runId).record})
      controller.registerWorkflow(next.workflow)
      return await controller.updateEngineeringCheckpoint({commandId:`engineering-checkpoint:${runId}:${requestId}`,runId,
        expectedRevision:state.run.revision,kind,workflowId:next.definition.id,workflowDigest:next.definition.digest,maintenance})
    }catch(error){routes.set(runId,prior);throw error}
  }
  async function reissueTask({ taskId, repositoryId, requestId, uatEnvironment }, controller, artifacts) {
    text(taskId, 'WORKFLOW_TASK_ID_REQUIRED'); text(repositoryId, 'ENGINEERING_REPOSITORY_REQUIRED')
    text(requestId, 'WORKFLOW_REQUEST_ID_REQUIRED')
    const entry = configs.get(repositoryId)
    if (!entry?.config.discovery) fail('ENGINEERING_REPOSITORY_NOT_ADMITTED')
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const run = runs.find(item => !['succeeded', 'failed', 'cancelled'].includes(item.status))
    if (!run) fail('ENGINEERING_TASK_NOT_REISSUABLE')
    const state = await store.query({ kind: 'run', runId: run.runId }), prior = routes.get(run.runId)
    if (!prior || prior.record.config.taskId !== taskId) fail('ENGINEERING_TASK_NOT_REISSUABLE')
    if (prior.record.config.reissueRequestId === requestId && prior.record.config.repoId === repositoryId) {
      if (uatEnvironment && uatEnvironment !== prior.record.config.uatEnvironment) fail('ENGINEERING_TASK_COMMAND_CONFLICT')
      return { taskId, runId: run.runId, generation: state.run.generation, repositoryId }
    }
    uatEnvironment ??= prior.record.config.uatEnvironment
    const uatBranch = uatBranchFor(uatEnvironment)
    if (!uatBranch) fail('ENGINEERING_UAT_ENVIRONMENT_REQUIRED')
    await git(entry.config.sourceRepository, ['check-ref-format', '--branch', uatBranch])
    const targetRemote = await git(entry.config.sourceRepository, ['ls-remote', '--exit-code', entry.config.remote, `refs/heads/${uatBranch}`])
    const targetCommit = targetRemote.split(/\s+/)[0]
    if (!/^[a-f0-9]{40}$/.test(targetCommit)) fail('ENGINEERING_UAT_BRANCH_NOT_FOUND')
    await git(entry.config.sourceRepository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', entry.config.remote, targetCommit])
    const saved = prior.record.config
    if (saved.branchSource && repositoryId !== saved.repoId) fail('ENGINEERING_REUSED_BRANCH_NOT_REISSUABLE')
    let baseCommit = await git(entry.config.sourceRepository, ['rev-parse', '--verify', `${entry.config.baseRef}^{commit}`])
    if (saved.branchSource) {
      const remote = await git(entry.config.sourceRepository, ['ls-remote', '--refs', '--', entry.config.remote, `refs/heads/${saved.head}`])
      const parts = remote.split(/\s+/)
      if (parts.length !== 2 || !/^[a-f0-9]{40}$/.test(parts[0]) || parts[1] !== `refs/heads/${saved.head}`) fail('ENGINEERING_BRANCH_SOURCE_INVALID')
      baseCommit = parts[0]
      await git(entry.config.sourceRepository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', entry.config.remote, baseCommit])
    }
    const matches = [...configs.values()].filter(item => item.config.routingTerms?.some(term => saved.input.request.includes(term)))
    if (matches.length === 1 && matches[0].config.id !== repositoryId) fail('ENGINEERING_REPOSITORY_SCOPE_MISMATCH')
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) fail('ENGINEERING_BASE_INVALID')
    const input = { ...saved.input, acceptanceCriteria: saved.input.acceptanceCriteria ?? [], baseCommit, editablePaths: entry.config.editablePaths }
    const taskBase = saved.branchSource ? (saved.taskBase ?? saved.input.baseCommit) : baseCommit
    try { await git(entry.config.sourceRepository, ['merge-base', '--is-ancestor', taskBase, baseCommit]) }
    catch { fail('ENGINEERING_TASK_BASE_NOT_ANCESTOR') }
    const nextConfig = { ...saved, targetCommit, taskBase, repositoryIdentity: { sourceRepository: entry.config.sourceRepository, remote: entry.config.remote, githubRepository: entry.config.githubRepository }, ...selectTaskLocalAcceptance(entry.config.taskLocalAcceptance === undefined && saved.localAcceptanceScope ? {taskLocalAcceptance:[{scope:saved.localAcceptanceScope,localAcceptance:saved.localAcceptanceConfig}]} : entry.config, {taskId,uatEnvironment,requestDigest:executionDigest({request:input.request,acceptanceCriteria:input.acceptanceCriteria})}), uatEnvironment, uatBranch, repoId: repositoryId, repositoryDigest: entry.digest, input,
      ...(saved.branchSource ? { branchSource: { ...saved.branchSource, expectedRemoteSha: baseCommit } } : {}),
      fingerprint: executionDigest({ taskId, request: input.request, constraints: input.constraints, repoId: repositoryId, uatEnvironment, uatBranch, acceptanceCriteria: input.acceptanceCriteria }), reissueRequestId: requestId,
      body: `## 任务\n\n${input.request}\n\n## 约束\n\n${input.constraints.map(value => `- ${value}`).join('\n') || '无额外约束'}\n\n## 验证配置\n\n${entry.config.checks.map(check => `- ${check.id} / ${check.version}`).join('\n')}` }
    const workflowId = `task-engineering-reissue-${executionDigest([run.runId, requestId]).slice(0, 40)}`
    const record = { workflowId, config: nextConfig, definitionVersion: '16' }
    let next
    try {
      next = await build(record)
      const requirement = await artifacts.put(input, { taskId }), first = next.workflow.nodes[0]
      const firstInput = await artifacts.put({ workflowDigest: next.definition.digest, nodeId: first.id, nodeVersion: first.version,
        requirementRef: requirement.ref, data: await first.mapInput({ requirement: input, previousOutput: null, dependencyOutputs: {} }) }, { taskId })
      await store.command({ id: `workflow:${next.definition.digest}`, kind: 'workflow.register', args: { ...record, digest: next.definition.digest } })
      await store.command({ id: `reissue-repository:${run.runId}:${next.definition.digest}`, kind: 'run.workflow.reissue-repository', args: {
        runId: run.runId, expectedRevision: state.run.revision, fromDigest: state.run.workflowDigest,
        toDigest: next.definition.digest, toWorkflowId: workflowId, requirementRef: requirement.ref,
        inputRef: firstInput.ref, inputDigest: firstInput.digest,
        nodes: next.workflow.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor,
          inputRef: index ? null : firstInput.ref, inputDigest: index ? null : firstInput.digest })),
      } })
    } catch (error) { routes.set(run.runId, prior); throw error }
    controller.registerWorkflow(next.workflow)
    await controller.recover({ commandId: `reissue-drive:${run.runId}:${next.definition.digest}`, runId: run.runId })
    return { taskId, runId: run.runId, generation: state.run.generation + 1, repositoryId }
  }
  async function prepareRepairContext(state) {
    const item = routes.get(state.run.runId)
    if (!item || item.record.config.taskId !== state.run.taskId || !artifactStore) fail('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
    const workspaceNode = state.nodes.find(node => node.nodeId === 'prepare-workspace' && node.outputRef)
    if (!workspaceNode) fail('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
    const output = await artifactStore.read(workspaceNode.outputRef)
    const patchFailure = state.nodes.find(node => node.nodeId === 'apply-changes' && node.status === 'waiting' && engineeringPatchRepairReasons.includes(node.waitReason?.reference))
    const patchAmbiguous = !!patchFailure
    let candidate, workspaceSnapshotRef
    if (patchAmbiguous) {
      const expectedDirectory = join(item.root, `ws-${executionDigest({ runId: state.run.runId, generation: state.run.generation })}`, 'repository')
      if (output.workspace.directory !== expectedDirectory || resolve(await realpath(expectedDirectory)).toLowerCase() !== resolve(expectedDirectory).toLowerCase()) fail('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
      const config = configs.get(item.record.config.repoId).config
      const paths = [...new Set((await git(expectedDirectory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort()
      const files = []; let total = 0
      for (const path of paths) {
        if (!config.discovery.allowedPrefixes.some(prefix => path.startsWith(prefix))) continue
        if (/[\\:\0\r\n]/.test(path) || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) fail('ENGINEERING_READ_PATH_INVALID')
        const full = join(expectedDirectory, path)
        if (!(await lstat(full)).isFile() || resolve(await realpath(full)).toLowerCase() !== resolve(full).toLowerCase()) fail('ENGINEERING_READ_PATH_INVALID')
        const bytes = await readFile(full); total += bytes.length
        if (total > 64 * 1024 * 1024 || files.length >= 20000) fail('ENGINEERING_REPAIR_CONTEXT_CAPACITY')
        const artifact = await artifactStore.put({ data: bytes.toString('base64') }, { taskId: state.run.taskId })
        files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), ref: artifact.ref })
      }
      workspaceSnapshotRef = (await artifactStore.put({ runId: state.run.runId, generation: state.run.generation, directory: expectedDirectory,
        baseCommit: output.workspace.baseCommit, files, filesDigest: executionDigest(files) }, { taskId: state.run.taskId })).ref
    } else candidate = await freezeCandidate({ repository: output.workspace.directory, baseCommit: output.workspace.baseCommit,
      generation: state.run.generation, requirementDigest: executionDigest(await artifactStore.read(state.run.requirementRef)) })
    const refs = [...new Set(state.nodes.flatMap(node => node.status === 'waiting' ? node.evidenceRefs ?? []
      : ['inspect-and-propose', 'propose-changes'].includes(node.nodeId) && node.outputRef ? [node.outputRef] : []))]
    const materials = []
    for (const ref of refs) {
      const value = await artifactStore.read(ref)
      if (value.kind === 'engineering-verification-failure') {
        if (value.candidateDigest !== candidate.digest) fail('ENGINEERING_REPAIR_CANDIDATE_DRIFT')
        materials.push({ ref, kind: value.kind, checkId: value.checkId, log: Buffer.from(value.data, 'base64').toString('utf8') })
      } else materials.push({ ref, ...(patchAmbiguous ? { proposal: value } : {}), document: value.document ?? null, failure: value.failureCode ?? (patchAmbiguous ? patchFailure.waitReason.reference : null),
        paths: [...(value.changes ?? []), ...(value.replacements ?? [])].map(change => change.path) })
    }
    if (JSON.stringify(materials).length > 64000) fail('ENGINEERING_REPAIR_CONTEXT_CAPACITY')
    return artifactStore.put({ taskId: state.run.taskId, runId: state.run.runId, generation: state.run.generation,
      ...(patchAmbiguous ? { sourceKind: 'workspace', workspaceSnapshotRef } : { candidate }), materials }, { taskId: state.run.taskId })
  }
  return {
    prepareRepairContext,
    deliveryOptions,
    repositoryInspect,
    async restore(controlStore, artifacts) {
      store = controlStore; artifactStore = artifacts
      const result = []
      for (const record of await store.query({ kind: 'workflow.list' })) {
        if (record.config?.kind !== 'engineering') continue
        const state = await store.query({ kind: 'run', runId: record.config.runId })
        // 旧定义保留在账中供审计；只有当前运行绑定的定义需要恢复。
        if (state.run && state.run.workflowDigest !== record.digest) continue
        if (state.run && ['succeeded', 'failed', 'cancelled'].includes(state.run.status)) continue
        const { workflow, definition } = await build(record, { allowDefinitionMigration: ['3', '4'].includes(record.definitionVersion) && !!state.run })
        if (record.definitionVersion === '5' && state.run?.generation === 1 && record.config?.repoId
          && configs.get(record.config.repoId)?.config.discovery
          && state.nodes.some(node => node.nodeId === 'apply-changes' && node.status === 'waiting' && node.drained && node.waitReason?.reference === 'EDIT_PREPARED_INVALID')) {
          const directRecord = { ...record, definitionVersion: '6' }
          const direct = await build(directRecord, { allowDefinitionMigration: true })
          const requirement = await artifacts.read(state.run.requirementRef)
          const first = direct.workflow.nodes[0]
          const input = await artifacts.put({ workflowDigest: direct.definition.digest, nodeId: first.id, nodeVersion: first.version,
            requirementRef: state.run.requirementRef, data: requirement }, { taskId: state.run.taskId })
          await store.command({ id: `workflow:${direct.definition.digest}`, kind: 'workflow.register', args: {
            ...directRecord, digest: direct.definition.digest,
          } })
          await store.command({ id: `replan-direct:${state.run.runId}:${direct.definition.digest}`, kind: 'run.workflow.replan-direct', args: {
            runId: state.run.runId, expectedRevision: state.run.revision, fromDigest: record.digest, toDigest: direct.definition.digest,
            inputRef: input.ref, inputDigest: input.digest,
            nodes: direct.workflow.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor,
              inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })),
          } })
          result.push(direct.workflow)
          continue
        }
        if (![definition.digest, ...definition.legacyDigests].includes(record.digest)) {
          if (!artifacts || !['3', '4'].includes(record.definitionVersion) || workflow.version !== '5') fail('ENGINEERING_DEFINITION_DRIFT')
          if (record.definitionVersion === '4') {
            const read = state.nodes.find(node => node.nodeId === 'read-files')
            if (!read || read.status !== 'waiting' || !['controller-restarted', 'TASK_CONTEXT_TOO_LARGE'].includes(read.waitReason?.reference)) fail('ENGINEERING_DEFINITION_DRIFT')
            const oldInput = await artifacts.read(read.inputRef)
            if (executionDigest(oldInput) !== read.inputDigest || oldInput.workflowDigest !== record.digest || oldInput.nodeVersion !== '1'
              || oldInput.nodeId !== 'read-files' || oldInput.requirementRef !== state.run.requirementRef) fail('ENGINEERING_MIGRATION_INPUT_INVALID')
            const next = await artifacts.put({ ...oldInput, workflowDigest: definition.digest, nodeVersion: '2' }, { taskId: state.run.taskId })
            await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
              ...record, digest: definition.digest, definitionVersion: workflow.version,
            } })
            if (!read.drained) {
              const evidence = await artifacts.put({ kind: 'exclusive-controller-recovery', nodeRunId: read.nodeRunId, fromDigest: record.digest }, { taskId: state.run.taskId })
              await store.command({ id: `drained:${read.nodeRunId}:${read.leaseEpoch}`, kind: 'node.drained', args: {
                runId: state.run.runId, nodeId: 'read-files', generation: read.generation, leaseEpoch: read.leaseEpoch, evidenceRef: evidence.ref,
              } })
            }
            const current = await store.query({ kind: 'run', runId: record.config.runId })
            await store.command({ id: `migrate-read:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.migrate-read', args: {
              runId: current.run.runId, expectedRevision: current.run.revision, fromDigest: record.digest, toDigest: definition.digest,
              nodeRunId: read.nodeRunId, inputRef: next.ref, inputDigest: next.digest,
            } })
            result.push(workflow)
            continue
          }
          const index = state.nodes.find(node => node.nodeId === 'index-files')
          if (!index || index.status !== 'waiting' || !['ENGINEERING_INDEX_CAPACITY_EXCEEDED', 'controller-restarted'].includes(index.waitReason?.reference)) fail('ENGINEERING_DEFINITION_DRIFT')
          const oldInput = await artifacts.read(index.inputRef)
          if (executionDigest(oldInput) !== index.inputDigest || oldInput.workflowDigest !== record.digest || oldInput.nodeVersion !== '1'
            || oldInput.nodeId !== 'index-files' || oldInput.requirementRef !== state.run.requirementRef) fail('ENGINEERING_MIGRATION_INPUT_INVALID')
          const next = await artifacts.put({ ...oldInput, workflowDigest: definition.digest, nodeVersion: '2' }, { taskId: state.run.taskId })
          await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
            ...record, digest: definition.digest, definitionVersion: workflow.version,
          } })
          if (!index.drained) {
            const evidence = await artifacts.put({ kind: 'exclusive-controller-recovery', nodeRunId: index.nodeRunId, fromDigest: record.digest }, { taskId: state.run.taskId })
            await store.command({ id: `drained:${index.nodeRunId}:${index.leaseEpoch}`, kind: 'node.drained', args: {
              runId: state.run.runId, nodeId: 'index-files', generation: index.generation, leaseEpoch: index.leaseEpoch, evidenceRef: evidence.ref,
            } })
          }
          const current = await store.query({ kind: 'run', runId: record.config.runId })
          await store.command({ id: `migrate-index:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.migrate-index', args: {
            runId: current.run.runId, expectedRevision: current.run.revision, fromDigest: record.digest, toDigest: definition.digest,
            nodeRunId: index.nodeRunId, inputRef: next.ref, inputDigest: next.digest,
          } })
        }
        result.push(workflow)
      }
      return result
    },
    prepareTask(action, info, controller) {
      const key = info.commandId, digest = executionDigest({ action, info }), prior = preparing.get(key)
      if (prior) return prior.digest === digest ? prior.promise : Promise.reject(executionError('ENGINEERING_TASK_COMMAND_CONFLICT'))
      const promise = prepareTask(action, info, controller).finally(() => preparing.delete(key))
      preparing.set(key, { digest, promise }); return promise
    },
    reissueTask,
    updateCheckpoint, externalProcessScope,
    availableWorkflows: () => [...configs.values()].map(({ config }) => ({ id: 'task-engineering', repositoryId: config.id, dependencyRepositories: [...(config.dependencyRepositories ?? [])], editablePaths: [...config.editablePaths], ...(config.discovery ? { discovery: structuredClone(config.discovery) } : {}), purpose: config.purpose ?? '仅在配置范围内开发，业务验收后提交到用户明确指定的UAT分支；用户须明确uat1至uat9环境，由Host映射feature/uatN-base；缺少环境先询问，禁止提交main' })),
  }
}
