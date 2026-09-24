import { executionDigest, executionError } from './execution-artifacts.js'

const text = { type: 'string' }
const sha = { type: 'string' }
const nonempty = value => typeof value === 'string' && value.trim() === value && value.length > 0
const identitySchema = { type: 'object', properties: {
  repository: text, environment: text, service: text, commitSha: sha, runbookId: text,
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
  'uat-delivery': { environment: 'uat', operations: ['integrate', 'build'], phases: ['preflight', 'integrated', 'built', 'runtime'],
    requiredPreflight: ['localE2ePassed', 'developmentPrVerified', 'uatPrVerified', 'sourcePackageSupported', 'equivalentBuildAbsent'],
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
    || (kind === 'production-release' && ['approval-gate', 'tag'].includes(operation) && !nonempty(prepared.expected.tag))
    || (kind === 'production-release' && operation === 'tag'
      && prepared.expected.approvalReceiptDigest !== previous.facts.approvalReceiptDigest)) throw executionError('RELEASE_OPERATION_IDENTITY_INVALID')
  return prepared
}

/** 发布与重构建流程的受信 Host 合同。adapter 只读 inspect 和 prepareOperation；副作用只经 Delivery 外部网关。 */
export function createReleaseTaskWorkflow({ kind, adapter }) {
  const spec = catalog[kind]
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
  return { id: `task-${kind}`, version: '1', nodes }
}

export const releaseWorkflowKinds = Object.freeze(Object.keys(catalog))
