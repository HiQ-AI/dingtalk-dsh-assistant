import { executionDigest, executionError } from './execution-artifacts.js'
import { assertDataChangeExecutionIdentity } from './workflow-data-change.js'

/** 平台领域决定前序证明的消费规则，公共服务不再拼装各平台参数。 */
export function createExternalStageContracts({ workflowIds, external, readEngineeringProof, readArtifact, readTaskEvidence }) {
  return workflowIds.map(id => ({ id, version: '1',
    async prepare({ taskId, stage, plan, stageIndex, requirement, origin, definitionVersion }) {
      const args = { ...origin.command.args.arguments, ...requirement.target, objective: requirement.request,
        ...(requirement.stageTargets?.[id] ? { targetId: requirement.stageTargets[id] } : {}) }
      let materials = [], taskContext
      if (['task-uat-deployment', 'task-uat-pr-merge'].includes(id)) {
        const completed = plan.stages.slice(0, Math.max(0, stageIndex)).filter(item => item.status === 'succeeded')
        const merged = completed.findLast(item => item.workflowId === 'task-uat-pr-merge' && item.outputRef)
        const engineered = completed.findLast(item => item.runId && item.workflowId.startsWith('task-engineering-'))
        const proof = engineered ? await readEngineeringProof(taskId, engineered) : null
        const mergedProof = merged ? await readArtifact(merged.outputRef) : null
        if (mergedProof && (mergedProof.baseBranch === undefined || mergedProof.mergeCommitSha === undefined))
          throw executionError('UAT_MERGE_SOURCE_INVALID')
        if (id === 'task-uat-pr-merge' && proof) Object.assign(args, {
          pullRequestNumber: proof.pullRequest.number, headCommitSha: proof.pullRequest.commitSha })
        if (id === 'task-uat-deployment' && mergedProof) args.commitSha = mergedProof.mergeCommitSha
        materials = id === 'task-uat-deployment' && mergedProof
          ? [{ resourceRef: `uat-merge-task:${taskId}:${merged.runId}` }]
          : proof ? [{ resourceRef: `engineering-task:${taskId}:${engineered.runId}` }] : []
      }
      if (id === 'task-data-change') {
        const prior = plan.stages.slice(0, Math.max(0, stageIndex)).findLast(item => item.status === 'succeeded' && item.outputRef)
        const source = prior ? await readArtifact(prior.outputRef) : origin.run?.body
        const sourceRef = prior?.outputRef ?? origin.run?.sourceKey
        if (!sourceRef || !source) throw executionError('DATA_CHANGE_SOURCE_REQUIRED')
        args.changeRef = sourceRef
        if (source?.outcome === 'needs_revision') args.previousIssueId = source.issueId
        materials = [{ resourceRef: sourceRef, text: typeof source === 'string' ? source : JSON.stringify(source) }]
        if (readTaskEvidence) taskContext = { taskId, requirementRevision: plan.task.requirementRevision, scope: requirement.scope,
          queryEvidence: (await readTaskEvidence({ taskId, requirementRevision: plan.task.requirementRevision })).map(({ artifactRef }) => ({ artifactRef })) }
      }
      return { input: await external.prepareRequirement({ workflowId: stage.workflowId, definitionVersion, ...(taskContext ? { taskContext } : {}),
        action: { taskId, arguments: { ...args, workflowId: id }, constraints: requirement.constraints }, materials }) }
    } }))
}

/** 平台流程已在最终节点核验平台事实；冻结此前 Host 的结果拒绝条件。 */
export const legacyExternalWorkflowOwnerContract = Object.freeze({
  id: 'external-result', version: '1',
  validateCompletion({ output }) {
    return !!output && !(Array.isArray(output.limitations) && output.limitations.length)
      && output.outcome !== 'blocked' && output.status !== 'unverified'
  },
})

/** 技术效果与逐项业务满足分别核验；版本 1 仅用于恢复其冻结定义。 */
export const externalWorkflowOwnerContract = Object.freeze({
  id: 'external-result', version: '2',
  rulesDigest: executionDigest({ acceptanceScope: 'domain-items-v1' }),
  async validateCompletion({ output, requirement, decision, stages, acceptanceItems, verifyAcceptance }) {
    if (!legacyExternalWorkflowOwnerContract.validateCompletion({ output }) || !Array.isArray(acceptanceItems)) return false
    if (!acceptanceItems.length) return true
    return typeof verifyAcceptance === 'function'
      && await verifyAcceptance({ requirement, decision, stages, acceptanceItems }) === true
  },
})

const text = { type: 'string' }
const sha = { type: 'string' }
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0
const identitySchema = { type: 'object', properties: {
  repository: text, environment: text, service: text, commitSha: sha, runbookId: text, releaseTag: text,
}, required: ['repository', 'environment', 'service', 'commitSha', 'runbookId'], additionalProperties: false }
const requirementSchema = { type: 'object', properties: {
  request: text, target: identitySchema, constraints: { type: 'array', items: text },
  evidenceRefs: { type: 'array', items: text },
}, required: ['request', 'target', 'constraints', 'evidenceRefs'], additionalProperties: false }
const observationSchema = { type: 'object', properties: {
  phase: text, targetDigest: text, status: text, evidenceRefs: { type: 'array', items: text },
  facts: { type: 'object' },
}, required: ['phase', 'targetDigest', 'status', 'evidenceRefs', 'facts'], additionalProperties: false }
const preparedSchema = { type: 'object', properties: {
  action: text, workflowKind: text, operation: text, runId: text, generation: { type: 'integer' },
  requirementDigest: text, resourceKey: text, targetDigest: text, expected: { type: 'object' },
  operationKey: text,
}, required: ['action', 'workflowKind', 'operation', 'runId', 'generation', 'requirementDigest', 'resourceKey', 'targetDigest', 'expected', 'operationKey'], additionalProperties: false }
const effectSchema = { type: 'object', properties: { prepared: preparedSchema, receipt: { type: 'object' } }, required: ['prepared', 'receipt'], additionalProperties: false }
const stateSchema = { type: 'object', properties: {
  requirement: requirementSchema, observation: observationSchema,
}, required: ['requirement', 'observation'], additionalProperties: false }
const readbackInputSchema = { type: 'object', properties: { requirement: requirementSchema, effect: effectSchema },
  required: ['requirement', 'effect'], additionalProperties: false }
const effectInputSchema = { type: 'object', properties: {
  state: stateSchema, prepared: preparedSchema,
}, required: ['state', 'prepared'], additionalProperties: false }
const finalSchema = { type: 'object', properties: {
  workflowKind: text, targetDigest: text, commitSha: sha, status: text,
  evidenceRefs: { type: 'array', items: text }, boundaries: { type: 'array', items: text },
}, required: ['workflowKind', 'targetDigest', 'commitSha', 'status', 'evidenceRefs', 'boundaries'], additionalProperties: false }

const catalog = {
  'uat-deployment': { environment: 'uat', operations: ['build'], phases: ['preflight', 'built', 'runtime'],
    requiredPreflight: ['targetBranchVerified', 'uatPrMerged'],
    requiredFinal: ['sourceSha', 'registryDigest', 'runtimeDigest', 'observedGeneration', 'ready', 'entryAccessible', 'imageChainVerified'] },
  'production-release': { environment: 'production', operations: ['merge-main', 'approval-gate', 'tag', 'build'], phases: ['preflight', 'merged', 'approved', 'tagged', 'built', 'runtime'],
    requiredPreflight: [],
    requiredFinal: ['sourceSha', 'registryDigest', 'runtimeDigest', 'observedGeneration', 'ready', 'entryAccessible', 'imageChainVerified'] },
  'uat-rebuild': { environment: 'uat', operations: ['rebuild'], phases: ['preflight', 'built', 'runtime'],
    requiredPreflight: ['failurePipelineVerified', 'equivalentBuildAbsent', 'branchHeadMatches', 'noNewerRuntimeVersion', 'sourcePackageSupported'],
    requiredFinal: ['sourceSha', 'registryDigest', 'runtimeDigest', 'observedGeneration', 'ready', 'entryAccessible', 'imageChainVerified'] },
}

const targetDigest = target => executionDigest(target)
function assertRequirement(input, kind) {
  const target = input.target
  if (!nonempty(input.request) || !nonempty(target.repository) || !nonempty(target.service)
    || !nonempty(target.runbookId) || !/^[a-f0-9]{40}$/.test(target.commitSha)
    || target.environment !== catalog[kind].environment
    || (kind === 'production-release' ? !/^v\d{8}-[1-9]\d*$/.test(target.releaseTag ?? '') : target.releaseTag !== undefined)
    || input.constraints.length > 32 || input.evidenceRefs.length > 64
    || input.evidenceRefs.some(ref => !nonempty(ref)) || new Set(input.evidenceRefs).size !== input.evidenceRefs.length
    || Buffer.byteLength(JSON.stringify(input), 'utf8') > 24000) throw executionError('RELEASE_REQUIREMENT_INVALID')
  return input
}
function assertObservation(value, phase, requirement) {
  if (value?.phase !== phase || value.targetDigest !== targetDigest(requirement.target)
    || value.status !== 'confirmed' || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.length || value.evidenceRefs.some(ref => !nonempty(ref))
    || !value.facts || typeof value.facts !== 'object' || Array.isArray(value.facts)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16000) throw executionError('RELEASE_READBACK_UNCONFIRMED')
  return value
}
function assertFacts(observation, keys) {
  if (keys.some(key => ['sourceSha', 'registryDigest', 'runtimeDigest', 'observedGeneration'].includes(key)
    ? !nonempty(observation.facts[key]) : observation.facts[key] !== true)) throw executionError('RELEASE_REQUIRED_FACT_MISSING')
}
function assertPrepared(prepared, { kind, operation, runId, generation, requirementDigest, requirement, previous }) {
  if (prepared?.action !== 'external' || prepared.workflowKind !== kind || prepared.operation !== operation
    || prepared.runId !== runId || prepared.generation !== generation || prepared.requirementDigest !== requirementDigest
    || prepared.resourceKey !== `external:${requirement.target.environment}:${requirement.target.repository}:${requirement.target.service}`
    || prepared.targetDigest !== targetDigest(requirement.target) || !nonempty(prepared.operationKey)
    || !prepared.expected || typeof prepared.expected !== 'object' || Array.isArray(prepared.expected)
    || prepared.expected.commitSha !== requirement.target.commitSha
    || prepared.expected.previousEvidenceDigest !== executionDigest(previous.evidenceRefs)
    || prepared.expected.previousPhase !== previous.phase
    || (kind === 'production-release' && prepared.expected.approvalScopeDigest !== executionDigest({ target: requirement.target, operation: 'tag' }))
    || (kind === 'production-release' && ['approval-gate', 'tag'].includes(operation)
      && prepared.expected.tag !== requirement.target.releaseTag)
    || (kind === 'production-release' && operation === 'tag'
      && prepared.expected.approvalReceiptDigest !== previous.facts.approvalReceiptDigest)) throw executionError('RELEASE_OPERATION_IDENTITY_INVALID')
  return prepared
}

/** 发布与重构建流程的受信 Host 合同。adapter 只读 inspect 和 prepareOperation；副作用只经 Delivery 外部网关。 */
export function createReleaseTaskWorkflow({ kind, adapter, legacy = false }) {
  const baseSpec = catalog[kind]
  const spec = kind === 'production-release' && !legacy
    ? { ...baseSpec, operations: ['verify-main-merge', 'approval-gate', 'tag', 'build'] }
    : baseSpec
  if (!spec) throw executionError('RELEASE_WORKFLOW_UNKNOWN')
  if (!adapter || !nonempty(adapter.id) || !nonempty(adapter.version) || !/^[a-f0-9]{64}$/.test(adapter.rulesDigest)
    || typeof adapter.inspect !== 'function' || typeof adapter.prepareOperation !== 'function') throw executionError('RELEASE_ADAPTER_REQUIRED')
  const nodes = [{ id: 'freeze-target', version: '1', executor: 'code', allowedEffects: ['pure'],
    inputSchema: requirementSchema, outputSchema: requirementSchema, mapInput: ({ requirement }) => requirement,
    execute: async ({ input }) => assertRequirement(input, kind) }]
  for (const [index, phase] of spec.phases.entries()) {
    const inspectId = `inspect-${phase}`
    const precedingEffectId = index > 0 ? `execute-${spec.operations[Math.min(index - 1, spec.operations.length - 1)]}` : null
    nodes.push({ id: inspectId, version: '1', executor: 'code', drainPolicy: 'external-process', allowedEffects: ['read'],
      ...(precedingEffectId ? { inputDependencies: [precedingEffectId] } : {}),
      inputSchema: precedingEffectId ? readbackInputSchema : requirementSchema, outputSchema: stateSchema,
      mapInput: precedingEffectId
        ? ({ requirement, dependencyOutputs }) => ({ requirement, effect: dependencyOutputs[precedingEffectId] })
        : ({ requirement }) => requirement,
      execute: async ({ input, signal }) => {
        signal?.throwIfAborted()
        const requirement = precedingEffectId ? input.requirement : input
        const effect = precedingEffectId ? input.effect : null
        const observation = assertObservation(await adapter.inspect({ phase, requirement: structuredClone(requirement),
          ...(effect ? { effect: structuredClone(effect) } : {}), signal }), phase, requirement)
        signal?.throwIfAborted()
        if (effect && (effect.prepared.workflowKind !== kind || effect.prepared.targetDigest !== targetDigest(requirement.target)
          || observation.facts.operationKey !== effect.prepared.operationKey
          || observation.facts.receiptDigest !== executionDigest(effect.receipt))) throw executionError('RELEASE_EFFECT_READBACK_MISMATCH')
        if (phase === 'approved' && (effect?.prepared.operation !== 'approval-gate' || effect.receipt?.status !== 'succeeded'
          || effect.receipt.scopeDigest !== executionDigest({ target: requirement.target, operation: 'tag' })
          || observation.facts.approvalScopeDigest !== executionDigest({ target: requirement.target, operation: 'tag' })
          || observation.facts.approvalReceiptDigest !== executionDigest(effect.receipt)))
          throw executionError('RELEASE_APPROVAL_READBACK_MISMATCH')
        if (phase === 'preflight') assertFacts(observation, spec.requiredPreflight)
        if (phase === 'runtime') {
          assertFacts(observation, spec.requiredFinal)
          if (observation.facts.sourceSha !== requirement.target.commitSha) throw executionError('RELEASE_RUNTIME_IDENTITY_MISMATCH')
        }
        return { requirement, observation }
      } })
    if (index === spec.phases.length - 1) {
      if (kind === 'uat-deployment') {
        nodes.push({ id: 'finalize', version: '1', executor: 'code', allowedEffects: ['pure'],
          inputSchema: stateSchema, outputSchema: finalSchema,
          mapInput: ({ previousOutput }) => previousOutput,
          execute: async ({ input }) => {
            assertObservation(input.observation, 'runtime', input.requirement)
            assertFacts(input.observation, spec.requiredFinal)
            if (input.observation.facts.sourceSha !== input.requirement.target.commitSha) throw executionError('RELEASE_RUNTIME_IDENTITY_MISMATCH')
            return { workflowKind: kind, targetDigest: targetDigest(input.requirement.target), commitSha: input.requirement.target.commitSha,
              status: 'uat-deployed', evidenceRefs: input.observation.evidenceRefs,
              boundaries: ['仅确认 UAT 运行版本；业务回归、提测和正式验收须分别证明。'] }
          } })
        break
      }

      nodes.push({ id: 'finalize', version: '1', executor: 'code', allowedEffects: ['pure'],
        inputSchema: stateSchema, outputSchema: finalSchema,
        mapInput: ({ previousOutput }) => previousOutput,
        execute: async ({ input }) => {
          assertObservation(input.observation, 'runtime', input.requirement)
          assertFacts(input.observation, spec.requiredFinal)
          if (input.observation.facts.sourceSha !== input.requirement.target.commitSha) throw executionError('RELEASE_RUNTIME_IDENTITY_MISMATCH')
          return { workflowKind: kind, targetDigest: targetDigest(input.requirement.target), commitSha: input.requirement.target.commitSha,
            status: 'technical-delivery-confirmed', evidenceRefs: input.observation.evidenceRefs,
            boundaries: ['业务 E2E 和测试负责人正式验收须独立证明；本结果仅为技术交付。'] }
        } })
      break
    }
    if (index >= spec.operations.length) continue
    const operation = spec.operations[index], prepareId = `prepare-${operation}`, executeId = `execute-${operation}`
    nodes.push({ id: prepareId, version: '1', executor: 'code', drainPolicy: 'external-process', allowedEffects: ['read'],
      inputSchema: stateSchema, outputSchema: effectInputSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, runId, generation, requirementDigest, signal }) => {
        signal?.throwIfAborted()
        const { requirement, observation } = input
        assertObservation(observation, phase, requirement)
        const expected = { commitSha: requirement.target.commitSha, previousPhase: phase,
          previousEvidenceDigest: executionDigest(observation.evidenceRefs),
          ...(kind === 'production-release' ? { approvalScopeDigest: executionDigest({ target: requirement.target, operation: 'tag' }),
            ...(operation === 'tag' ? { approvalReceiptDigest: observation.facts.approvalReceiptDigest } : {}) } : {}) }
        const prepared = await adapter.prepareOperation({ kind, operation, requirement: structuredClone(requirement),
          observation: structuredClone(observation), runId, generation, requirementDigest, expected: structuredClone(expected), signal })
        signal?.throwIfAborted()
        assertPrepared(prepared, { kind, operation, runId, generation, requirementDigest, requirement, previous: observation })
        return { state: input, prepared }
      } })
    nodes.push({ id: executeId, version: '1', executor: 'code', allowedEffects: ['external.operation'],
      inputSchema: effectInputSchema, outputSchema: effectSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, perform }) => ({ prepared: input.prepared, receipt: await perform({ action: 'external', prepared: input.prepared }) }) })
  }
  const rulesDigest = executionDigest({ kind, adapterId: adapter.id, adapterVersion: adapter.version, adapterRulesDigest: adapter.rulesDigest,
    operations: spec.operations, phases: spec.phases, preflight: spec.requiredPreflight, final: spec.requiredFinal })
  for (const node of nodes) node.rulesDigest = rulesDigest
  return { id: `task-${kind}`, version: kind === 'production-release' && !legacy ? '2' : '1', nodes }
}

/** v1 仅供历史 Run 恢复，不能用它创建新的生产发布任务。 */
export const createLegacyReleaseTaskWorkflow = ({ kind, adapter }) =>
  createReleaseTaskWorkflow({ kind, adapter, legacy: true })

export const releaseWorkflowKinds = Object.freeze(Object.keys(catalog))

export const nativeDataChangeOwnerContract = Object.freeze({
  ...externalWorkflowOwnerContract, version: '3',
  async validateCompletion(context) {
    return context.output?.outcome !== 'needs_revision'
      && await externalWorkflowOwnerContract.validateCompletion(context)
  },
})

/** 旧v3定义保持冻结；当前Host可按显式只读策略补读它的成功节点证明。 */
export async function readDataChangeCompletionEvidence(context, adapter) {
  const { taskId, stage, state, store, artifacts, signal } = context
  const final = await artifacts.read(stage.outputRef)
  if (final?.outcome === 'needs_revision') return { completionEvidenceRefs: [stage.outputRef],
    domainEvidence: { outcome: 'needs_revision', comment: final.comment } }
  if (state.run.taskId !== taskId || state.run.runId !== stage.runId || state.run.status !== 'succeeded')
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const ids = ['readback-approval', 'prepare-execute', 'execute-task', 'readback-production']
  const values = {}, nodeArtifacts = []
  for (const id of ids) {
    const matches = state.nodes.filter(node => node.nodeId === id)
    const node = matches[0]
    if (matches.length !== 1 || node.status !== 'succeeded' || node.executor !== 'code'
      || !node.drained || node.generation !== state.run.generation || !node.outputRef)
      throw executionError('DATA_CHANGE_COMPLETION_NODE_INVALID')
    values[id] = await artifacts.read(node.outputRef)
    nodeArtifacts.push({ nodeId: id, artifactRef: node.outputRef })
  }
  if (state.nodes.find(node => node.nodeId === 'readback-production').outputRef !== stage.outputRef)
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const view = values['readback-approval'], prepared = values['prepare-execute'], executed = values['execute-task']
  const identity = assertDataChangeExecutionIdentity(view), request = executed.request
  const scopeDigest = executionDigest({ runId: state.run.runId, generation: state.run.generation,
    issueId: identity.issueId, planId: identity.planId, sheetId: identity.sheetId,
    target: identity.target, sheetSha256: identity.applySqlSha256, packageDigest: identity.packageDigest })
  if (executionDigest(prepared.view) !== executionDigest(view) || executionDigest(executed.view) !== executionDigest(view)
    || executionDigest(prepared.request) !== executionDigest(request)
    || request.runId !== state.run.runId || request.generation !== state.run.generation
    || request.stage !== 'execute-task' || request.workflowKind !== 'data-change'
    || request.approvalRequestId !== identity.approvalRequestId
    || request.intent.approvalScopeDigest !== scopeDigest || view.approval.scopeDigest !== scopeDigest
    || request.intent.applySql !== view.prepared.package.applySql || request.applySqlSha256 !== identity.applySqlSha256
    || request.packageDigest !== identity.packageDigest || executionDigest(request.target) !== executionDigest(identity.target)
    || executed.receipt?.status !== 'succeeded' || executed.receipt.result?.taskId !== final.taskId
    || final.issueId !== identity.issueId || final.planId !== identity.planId || final.sheetId !== identity.sheetId
    || final.packageDigest !== identity.packageDigest || final.applySqlSha256 !== identity.applySqlSha256)
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const effects = await store.query({ kind: 'effect.list', runId: state.run.runId })
  const executionEffects = effects.filter(effect => effect.nodeId === 'execute-task')
  const effect = executionEffects[0], executeNode = state.nodes.find(node => node.nodeId === 'execute-task')
  if (executionEffects.length !== 1 || effect.nodeRunId !== executeNode.nodeRunId
    || effect.generation !== state.run.generation || effect.inputDigest !== executeNode.inputDigest
    || executionDigest(effect.definition.payload) !== executionDigest(request)
    || effect.state !== 'succeeded' || effect.result?.status !== 'succeeded'
    || executionDigest(effect.result.result) !== executionDigest(executed.receipt))
    throw executionError('DATA_CHANGE_COMPLETION_EFFECT_INVALID')
  const approvalProof = await store.query({ kind: 'approval.execution-proof', requestId: identity.approvalRequestId,
    executeEffectId: effect.effectId })
  const gate = effects.find(item => item.effectId === approvalProof.gateEffectId)
  if (approvalProof.approval.decidedBy !== identity.approvedBy
    || gate?.nodeId !== 'approval-gate' || gate.definition.payload.intent.scopeDigest !== scopeDigest
    || gate.definition.payload.intent.issueId !== identity.issueId)
    throw executionError('DATA_CHANGE_COMPLETION_APPROVAL_INVALID')
  if (typeof adapter?.readCompletion !== 'function') throw executionError('DATA_CHANGE_COMPLETION_READBACK_REQUIRED')
  const observed = await adapter.readCompletion({ request, receipt: executed.receipt, view, signal })
  if (observed.task?.id !== final.taskId || observed.taskRun?.id !== final.taskRunId
    || observed.task?.status !== 'DONE' || observed.taskRun?.status !== 'DONE'
    || observed.production?.passed !== true || observed.production.packageDigest !== identity.packageDigest
    || observed.applySql !== view.prepared.package.applySql)
    throw executionError('DATA_CHANGE_COMPLETION_READBACK_INVALID')
  return { nodeArtifacts, completionEvidenceRefs: [stage.outputRef],
    domainEvidence: { kind: 'verified-data-change-completion', taskId, runId: state.run.runId,
      generation: state.run.generation, identity, approval: approvalProof,
      nodeArtifacts, ...observed } }
}

export function createNativeDataChangeCompletionPolicy(adapter) {
  return Object.freeze({ id: 'external-result', version: '4',
    rulesDigest: executionDigest({ policy: 'data-change-completion-v1',
      reader: readDataChangeCompletionEvidence.toString(), readback: adapter?.readCompletion?.toString() ?? null }),
    readArtifacts: context => readDataChangeCompletionEvidence(context, adapter),
    async validateCompletion(context) {
      if (context.output?.outcome === 'needs_revision') return false
      await readDataChangeCompletionEvidence(context, adapter)
      return externalWorkflowOwnerContract.validateCompletion(context)
    },
  })
}

export async function readScopedDataChangeCompletionEvidence(context, adapter) {
  const { taskId, stage, state, store, artifacts, signal } = context
  const final = await artifacts.read(stage.outputRef)
  if (final?.outcome === 'needs_revision') return { completionEvidenceRefs: [stage.outputRef],
    domainEvidence: { outcome: 'needs_revision', comment: final.comment } }
  if (state.run.taskId !== taskId || state.run.runId !== stage.runId || state.run.status !== 'succeeded')
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const ids = ['readback-approval', 'prepare-execute', 'execute-task', 'readback-production']
  const values = {}, nodeArtifacts = []
  for (const id of ids) {
    const matches = state.nodes.filter(node => node.nodeId === id)
    const node = matches[0]
    if (matches.length !== 1 || node.status !== 'succeeded' || node.executor !== 'code'
      || !node.drained || node.generation !== state.run.generation || !node.outputRef)
      throw executionError('DATA_CHANGE_COMPLETION_NODE_INVALID')
    values[id] = await artifacts.read(node.outputRef)
    nodeArtifacts.push({ nodeId: id, artifactRef: node.outputRef })
  }
  if (state.nodes.find(node => node.nodeId === 'readback-production').outputRef !== stage.outputRef)
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const view = values['readback-approval'], prepared = values['prepare-execute'], executed = values['execute-task']
  const identity = assertDataChangeExecutionIdentity(view), request = executed.request
  const scopeDigest = executionDigest({ runId: state.run.runId, generation: state.run.generation,
    issueId: identity.issueId, planId: identity.planId, sheetId: identity.sheetId,
    target: identity.target, sheetSha256: identity.applySqlSha256, packageDigest: identity.packageDigest })
  if (executionDigest(prepared.view) !== executionDigest(view) || executionDigest(executed.view) !== executionDigest(view)
    || executionDigest(prepared.request) !== executionDigest(request)
    || request.runId !== state.run.runId || request.generation !== state.run.generation
    || request.stage !== 'execute-task' || request.workflowKind !== 'data-change'
    || request.approvalRequestId !== identity.approvalRequestId
    || request.intent.approvalScopeDigest !== scopeDigest || view.approval.scopeDigest !== scopeDigest
    || request.intent.applySql !== view.prepared.package.applySql || request.applySqlSha256 !== identity.applySqlSha256
    || request.packageDigest !== identity.packageDigest || executionDigest(request.target) !== executionDigest(identity.target)
    || executed.receipt?.status !== 'succeeded' || executed.receipt.result?.taskId !== final.taskId
    || final.issueId !== identity.issueId || final.planId !== identity.planId || final.sheetId !== identity.sheetId
    || final.packageDigest !== identity.packageDigest || final.applySqlSha256 !== identity.applySqlSha256)
    throw executionError('DATA_CHANGE_COMPLETION_IDENTITY_INVALID')
  const effects = await store.query({ kind: 'effect.list', runId: state.run.runId })
  const executionEffects = effects.filter(effect => effect.nodeId === 'execute-task')
  const effect = executionEffects[0], executeNode = state.nodes.find(node => node.nodeId === 'execute-task')
  if (executionEffects.length !== 1 || effect.nodeRunId !== executeNode.nodeRunId
    || effect.generation !== state.run.generation || effect.inputDigest !== executeNode.inputDigest
    || executionDigest(effect.definition.payload) !== executionDigest(request)
    || effect.state !== 'succeeded' || effect.result?.status !== 'succeeded'
    || executionDigest(effect.result.result) !== executionDigest(executed.receipt))
    throw executionError('DATA_CHANGE_COMPLETION_EFFECT_INVALID')
  const approvalProof = await store.query({ kind: 'approval.execution-proof', requestId: identity.approvalRequestId,
    executeEffectId: effect.effectId })
  const gate = effects.find(item => item.effectId === approvalProof.gateEffectId)
  if (approvalProof.approval.decidedBy !== identity.approvedBy
    || gate?.nodeId !== 'approval-gate' || gate.definition.payload.intent.scopeDigest !== scopeDigest
    || gate.definition.payload.intent.issueId !== identity.issueId)
    throw executionError('DATA_CHANGE_COMPLETION_APPROVAL_INVALID')
  const readbackNode = state.nodes.find(node => node.nodeId === 'readback-production')
  const readbackInput = readbackNode.inputRef ? await artifacts.read(readbackNode.inputRef) : null
  if (!readbackInput || executionDigest(readbackInput) !== readbackNode.inputDigest
    || readbackInput.workflowDigest !== state.run.workflowDigest || readbackInput.nodeId !== readbackNode.nodeId
    || executionDigest(readbackInput.data) !== executionDigest(executed)
    || typeof final.observedChange !== 'string' || !final.observedChange.trim()
    || typeof final.productionReadbackId !== 'string' || !final.productionReadbackId
    || typeof final.taskRunId !== 'string' || !final.taskRunId)
    throw executionError('DATA_CHANGE_COMPLETION_READBACK_INVALID')
  const currentItems = (context.acceptanceItems ?? []).filter(item => item.evidenceRefs?.includes(stage.outputRef))
  let observed
  if (currentItems.length) {
    if (typeof adapter?.readCompletion !== 'function') throw executionError('DATA_CHANGE_COMPLETION_READBACK_REQUIRED')
    observed = await adapter.readCompletion({ request, receipt: executed.receipt, view, signal })
    if (observed.task?.id !== final.taskId || observed.taskRun?.id !== final.taskRunId
    || observed.task?.status !== 'DONE' || observed.taskRun?.status !== 'DONE'
    || observed.production?.passed !== true || observed.production.packageDigest !== identity.packageDigest
    || observed.applySql !== view.prepared.package.applySql)
      throw executionError('DATA_CHANGE_COMPLETION_READBACK_INVALID')
  }
  return { nodeArtifacts, completionEvidenceRefs: [stage.outputRef],
    domainEvidence: { kind: 'verified-data-change-completion', taskId, runId: state.run.runId,
      generation: state.run.generation, identity, approval: approvalProof,
      timeScope: observed ? 'current-acceptance' : 'at-execution',
      applySql: view.prepared.package.applySql, nodeArtifacts,
      historicalReadback: final, executionReceipt: executed.receipt, ...(observed ?? {}) } }
}

export function createScopedNativeDataChangeCompletionPolicy(adapter) {
  return Object.freeze({ id: 'external-result', version: '5',
    rulesDigest: executionDigest({ policy: 'data-change-completion-scoped-v1',
      reader: readScopedDataChangeCompletionEvidence.toString(), readback: adapter?.readCompletion?.toString() ?? null }),
    readArtifacts: context => readScopedDataChangeCompletionEvidence(context, adapter),
    async validateCompletion(context) {
      if (context.output?.outcome === 'needs_revision') return false
      await readScopedDataChangeCompletionEvidence(context, adapter)
      return externalWorkflowOwnerContract.validateCompletion(context)
    },
  })
}
