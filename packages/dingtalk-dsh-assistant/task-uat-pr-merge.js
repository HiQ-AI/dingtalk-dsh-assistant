import { executionDigest, executionError } from './execution-artifacts.js'
import { isUatBranch } from './workflow-engineering.js'

const text = { type: 'string' }
const requirementSchema = { type: 'object', properties: {
  request: text, targetId: text, repository: text, service: text, baseBranch: text,
  pullRequestNumber: { type: 'integer' }, headCommitSha: text,
  requiredChecks: { type: 'array', items: text }, evidenceRefs: { type: 'array', items: text },
}, required: ['request', 'targetId', 'repository', 'service', 'baseBranch',
  'pullRequestNumber', 'headCommitSha', 'requiredChecks', 'evidenceRefs'], additionalProperties: false }
const observationSchema = { type: 'object', properties: {
  status: text, evidenceRefs: { type: 'array', items: text }, facts: { type: 'object' },
}, required: ['status', 'evidenceRefs', 'facts'], additionalProperties: false }
const preparedSchema = { type: 'object', properties: {
  action: text, workflowKind: text, operation: text, runId: text, generation: { type: 'integer' },
  requirementDigest: text, resourceKey: text, targetDigest: text, expected: { type: 'object' }, operationKey: text,
}, required: ['action', 'workflowKind', 'operation', 'runId', 'generation', 'requirementDigest',
  'resourceKey', 'targetDigest', 'expected', 'operationKey'], additionalProperties: false }
const stateSchema = { type: 'object', properties: { requirement: requirementSchema, observation: observationSchema },
  required: ['requirement', 'observation'], additionalProperties: false }
const effectInputSchema = { type: 'object', properties: { state: stateSchema, prepared: preparedSchema },
  required: ['state', 'prepared'], additionalProperties: false }
const effectSchema = { type: 'object', properties: { prepared: preparedSchema, receipt: { type: 'object' } },
  required: ['prepared', 'receipt'], additionalProperties: false }
const resultSchema = { type: 'object', properties: {
  status: text, repository: text, service: text, baseBranch: text, headCommitSha: text, mergeCommitSha: text,
  treeSha: text, pullRequestNumber: { type: 'integer' }, evidenceRefs: { type: 'array', items: text },
}, required: ['status', 'repository', 'service', 'baseBranch', 'headCommitSha', 'mergeCommitSha',
  'treeSha', 'pullRequestNumber', 'evidenceRefs'], additionalProperties: false }
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)

/** UAT PR 合并是独立外部效果，Owner 只提出目标；Host 核验对象、检查和人工审批。 */
export function createLegacyUatPrMergeTaskWorkflow({ adapter }) {
  if (!adapter || typeof adapter.inspect !== 'function' || typeof adapter.prepareOperation !== 'function'
    || typeof adapter.id !== 'string' || typeof adapter.version !== 'string'
    || !/^[a-f0-9]{64}$/u.test(adapter.rulesDigest ?? '')) throw executionError('UAT_MERGE_ADAPTER_REQUIRED')
  const nodes = [
    { id: 'freeze-target', version: '1', executor: 'code', allowedEffects: ['pure'],
      inputSchema: requirementSchema, outputSchema: requirementSchema,
      mapInput: ({ requirement }) => requirement,
      execute: async ({ input }) => {
        if (!input.request?.trim() || !input.targetId?.trim() || !validSha(input.headCommitSha)
          || !Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber < 1
          || !Array.isArray(input.requiredChecks) || !input.requiredChecks.length
          || !Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length)
          throw executionError('UAT_MERGE_REQUIREMENT_INVALID')
        return input
      } },
    { id: 'inspect-preflight', version: '1', executor: 'code', drainPolicy: 'external-process', allowedEffects: ['read'],
      inputSchema: requirementSchema, outputSchema: stateSchema,
      mapInput: ({ requirement }) => requirement,
      execute: async ({ input, signal }) => {
        signal?.throwIfAborted()
        const observation = await adapter.inspect({ phase: 'preflight', requirement: structuredClone(input) })
        signal?.throwIfAborted()
        if (observation?.status !== 'confirmed' || observation.facts?.headTreeVerified !== true
          || observation.facts?.checksPassed !== true || observation.facts?.baseBound !== true
          || !Array.isArray(observation.evidenceRefs) || !observation.evidenceRefs.length)
          throw executionError('UAT_MERGE_PREFLIGHT_UNCONFIRMED')
        return { requirement: input, observation }
      } },
    { id: 'prepare-merge', version: '1', executor: 'code', drainPolicy: 'external-process', allowedEffects: ['read'],
      inputSchema: stateSchema, outputSchema: effectInputSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, runId, generation, requirementDigest, signal }) => {
        signal?.throwIfAborted()
        const prepared = await adapter.prepareOperation({ requirement: structuredClone(input.requirement),
          observation: structuredClone(input.observation), runId, generation, requirementDigest })
        signal?.throwIfAborted()
        if (prepared?.action !== 'external' || prepared.workflowKind !== 'uat-pr-merge'
          || prepared.operation !== 'merge-uat-pr' || prepared.runId !== runId
          || prepared.generation !== generation || prepared.requirementDigest !== requirementDigest
          || prepared.targetDigest !== executionDigest(input.requirement)
          || prepared.expected?.headCommitSha !== input.requirement.headCommitSha
          || prepared.expected?.pullRequestNumber !== input.requirement.pullRequestNumber)
          throw executionError('UAT_MERGE_OPERATION_IDENTITY_INVALID')
        return { state: input, prepared }
      } },
    { id: 'execute-merge', version: '1', executor: 'code', allowedEffects: ['external.operation'],
      inputSchema: effectInputSchema, outputSchema: effectSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, perform }) => ({ prepared: input.prepared,
        receipt: await perform({ action: 'external', prepared: input.prepared }) }) },
    { id: 'verify-source', version: '1', executor: 'code', drainPolicy: 'external-process', allowedEffects: ['read'],
      inputSchema: effectSchema, outputSchema: resultSchema,
      mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, signal }) => {
        signal?.throwIfAborted()
        const result = await adapter.inspect({ phase: 'merged', prepared: structuredClone(input.prepared),
          receipt: structuredClone(input.receipt) })
        signal?.throwIfAborted()
        if (result?.status !== 'confirmed' || !validSha(result.mergeCommitSha)
          || !validSha(result.treeSha) || result.headCommitSha !== input.prepared.expected.headCommitSha)
          throw executionError('UAT_MERGE_READBACK_UNCONFIRMED')
        return result
      } },
  ]
  const rulesDigest = executionDigest({ adapterId: adapter.id, version: adapter.version,
    adapterRulesDigest: adapter.rulesDigest, nodes: nodes.map(node => node.id) })
  for (const node of nodes) node.rulesDigest = rulesDigest
  return { id: 'task-uat-pr-merge', version: '1', nodes }
}


export function createUatPrMergeTaskWorkflowV2(options) {
  const workflow = createLegacyUatPrMergeTaskWorkflow(options), freeze = workflow.nodes[0], execute = freeze.execute
  workflow.version = '2'
  freeze.execute = async context => {
    if (!isUatBranch(context.input.baseBranch)) throw executionError('UAT_MERGE_BRANCH_INVALID')
    return execute(context)
  }
  for (const node of workflow.nodes) node.rulesDigest = executionDigest({ previous: node.rulesDigest, uatBranchPolicy: isUatBranch.toString() })
  return workflow
}

export function createUatPrMergeTaskWorkflow(options) {
  const workflow = createUatPrMergeTaskWorkflowV2(options)
  workflow.version = '3'
  const extend = schema => {
    if (schema === requirementSchema) return { ...schema, properties: { ...schema.properties, localEvidence: { type: 'object' } }, required: [...schema.required, 'localEvidence'] }
    if (!schema || typeof schema !== 'object') return schema
    return Array.isArray(schema) ? schema.map(extend) : Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, extend(value)]))
  }
  for (const node of workflow.nodes) {
    node.inputSchema = extend(node.inputSchema); node.outputSchema = extend(node.outputSchema)
    node.rulesDigest = executionDigest({ previous: node.rulesDigest, localEvidenceVersion: 1 })
  }
  workflow.nodes[0].execute = async ({ input }) => {
    if (!isUatBranch(input.baseBranch)) throw executionError('UAT_MERGE_BRANCH_INVALID')
    if (!input.request?.trim() || !input.targetId?.trim() || !validSha(input.headCommitSha)
      || !Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber < 1
      || !Array.isArray(input.requiredChecks) || !input.localEvidence
      || !Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length) throw executionError('UAT_MERGE_REQUIREMENT_INVALID')
    return input
  }
  const inspect = workflow.nodes.find(node => node.id === 'inspect-preflight'), original = inspect.execute
  inspect.execute = async context => {
    const result = await original(context)
    if (result.observation.facts.localAcceptancePassed !== true) throw executionError('UAT_LOCAL_EVIDENCE_REQUIRED')
    return result
  }
  return workflow
}

/** main 合并是独立上线任务，不能复用开发 PR 的目标和通过状态。 */
export function createMainPrMergeTaskWorkflow({ adapter }) {
  const workflow = createLegacyUatPrMergeTaskWorkflow({ adapter }), freeze = workflow.nodes[0], originalFreeze = freeze.execute
  workflow.id = 'task-main-pr-merge'
  freeze.execute = async context => {
    if (context.input.baseBranch !== 'main') throw executionError('MAIN_MERGE_BRANCH_INVALID')
    return originalFreeze(context)
  }
  workflow.nodes.find(node => node.id === 'inspect-preflight').execute = async ({ input, signal }) => {
    signal?.throwIfAborted()
    const observation = await adapter.inspect({ phase: 'preflight', requirement: structuredClone(input) })
    signal?.throwIfAborted()
    const facts = observation?.facts
    if (observation?.status !== 'confirmed' || !observation.evidenceRefs?.length
      || ['headTreeVerified', 'checksPassed', 'baseBound', 'uatVerified', 'businessAcceptancePassed', 'humanApproved'].some(key => facts?.[key] !== true)
      || !/^[a-f0-9]{64}$/.test(facts.approvalReceiptDigest ?? '')) throw executionError('MAIN_MERGE_PREFLIGHT_UNCONFIRMED')
    return { requirement: input, observation }
  }
  workflow.nodes.find(node => node.id === 'prepare-merge').execute = async ({ input, runId, generation, requirementDigest, signal }) => {
    signal?.throwIfAborted()
    const prepared = await adapter.prepareOperation({ requirement: structuredClone(input.requirement), observation: structuredClone(input.observation), runId, generation, requirementDigest })
    signal?.throwIfAborted()
    if (prepared?.action !== 'external' || prepared.workflowKind !== 'main-pr-merge' || prepared.operation !== 'merge-main-pr'
      || prepared.runId !== runId || prepared.generation !== generation || prepared.requirementDigest !== requirementDigest
      || prepared.targetDigest !== executionDigest(input.requirement) || prepared.expected?.baseBranch !== 'main'
      || prepared.expected?.headCommitSha !== input.requirement.headCommitSha || prepared.expected?.pullRequestNumber !== input.requirement.pullRequestNumber
      || prepared.expected?.approvalReceiptDigest !== input.observation.facts.approvalReceiptDigest) throw executionError('MAIN_MERGE_OPERATION_IDENTITY_INVALID')
    return { state: input, prepared }
  }
  const verify = workflow.nodes.find(node => node.id === 'verify-source'), originalVerify = verify.execute
  verify.execute = async context => {
    const result = await originalVerify(context)
    if (result.baseBranch !== 'main' || result.pullRequestNumber !== context.input.prepared.expected.pullRequestNumber) throw executionError('MAIN_MERGE_READBACK_UNCONFIRMED')
    return result
  }
  for (const node of workflow.nodes) node.rulesDigest = executionDigest({ previous: node.rulesDigest, workflowKind: 'main-pr-merge' })
  return workflow
}
