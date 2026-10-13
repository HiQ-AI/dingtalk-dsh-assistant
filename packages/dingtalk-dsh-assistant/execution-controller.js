import { authorizationTool, isAuthorizationSession } from './execution-authorization-session.js'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import { inspectExecutionInputLineage, inspectLocalAcceptanceCorrection, executionNodeContractDigest } from './execution-input-lineage.js'
import { normalizeEngineeringAcceptancePlan, normalizeWorktreeAcceptancePlan, proveEngineeringNoAdditionalChange } from './task-workflow.js'
import { isTerminalUatBuildFailure } from './execution-delivery.js'
import { setTimeout as delay } from 'node:timers/promises'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { canonicalExecutionJson, executionDigest, executionError, parseArtifactReference } from './execution-artifacts.js'
import { validateWorkflowRepairAdmission } from './task-workflow-contracts.js'
import { classifyExecutionFailure } from './execution-recovery-policy.js'
import { withVerificationProcessJournal } from './execution-check-job.js'

const isEngineeringEditAgent = (definition, node) => ['19','20','21','22','23','24','25','26'].includes(definition.version) && definition.id.startsWith('task-engineering-')
  && node.id === 'apply-changes' && node.version === (['24','25','26'].includes(definition.version) ? '11' : definition.version === '23' ? '10' : definition.version === '22' ? '9' : ['20','21'].includes(definition.version) ? '8' : '7') && node.executor === 'agent'
  && node.allowedEffects?.length === 2 && node.allowedEffects.includes('read') && node.allowedEffects.includes('workspace.edit')
  && node.allowedTools?.length === 2 && node.allowedTools.includes('engineering_repo_inspect') && node.allowedTools.includes('engineering_apply_edits')
  && typeof node.execute === 'function'

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
const requireId = value => { if (!identifier(value)) throw executionError('INVALID_IDENTIFIER'); return value }
export const plannedStageRunId = (taskId, planRevision, stageId, attempt) =>
  `run-${executionDigest({ taskId, planRevision, stageId, attempt })}`
const validate = (schema, value) => {
  canonicalExecutionJson(value)
  const errors = validateJsonSchemaValue(schema, value)
  if (errors.length) throw executionError('NODE_SCHEMA_INVALID', errors.join('; '))
  return value
}
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

// 仅标记纯结果处理边界。工件 I/O 和控制账提交异常不得被转成确定业务失败。
class ResultAdmissionError extends Error {
  constructor(cause, phase, nodeId) {
    super(String(cause?.message ?? cause).slice(0, 2000), { cause })
    this.code = typeof cause?.code === 'string' && cause.code.trim() ? cause.code.slice(0, 200) : 'NODE_RESULT_CONTRACT_INVALID'
    this.phase = phase
    this.nodeId = nodeId
  }
}
async function admitResult(phase, nodeId, operation) {
  try { return await operation() }
  catch (cause) { throw new ResultAdmissionError(cause, phase, nodeId) }
}

/** 随插件发布的固定顺序定义；函数仅来自受信模块，不接受用户/模型生成代码。 */
export function defineExecutionWorkflow(definition) {
  requireId(definition.id); requireId(definition.version)
  let ownerContract
  if (definition.ownerContract !== undefined) {
    const contract = definition.ownerContract
    if (!contract || !identifier(contract.id) || !identifier(contract.version)
      || typeof contract.validateCompletion !== 'function'
      || ['readArtifacts', 'inspectRepair', 'prepareRepair'].some(key => contract[key] !== undefined && typeof contract[key] !== 'function')
      || Object.keys(contract).some(key => !['id', 'version', 'rulesDigest', 'resultContract', 'readArtifacts', 'validateCompletion', 'inspectRepair', 'prepareRepair', 'validateRevision'].includes(key))
      || contract.validateRevision !== undefined && typeof contract.validateRevision !== 'function')
      throw executionError('WORKFLOW_OWNER_CONTRACT_INVALID')
    if (contract.resultContract !== undefined) {
      const result = contract.resultContract
      if (!result || !identifier(result.id) || !identifier(result.version)
        || Object.keys(result).some(key => !['id', 'version', 'requiredFields'].includes(key))
        || !Array.isArray(result.requiredFields) || !result.requiredFields.length
        || result.requiredFields.some(field => !identifier(field))
        || new Set(result.requiredFields).size !== result.requiredFields.length)
        throw executionError('WORKFLOW_RESULT_CONTRACT_INVALID')
    }
    if (contract.rulesDigest !== undefined) canonicalExecutionJson(contract.rulesDigest)
    ownerContract = freeze({ ...contract, ...(contract.rulesDigest === undefined ? {} : { rulesDigest: structuredClone(contract.rulesDigest) }),
      ...(contract.resultContract ? { resultContract: structuredClone(contract.resultContract) } : {}) })
  }
  if (!Array.isArray(definition.nodes) || !definition.nodes.length) throw executionError('WORKFLOW_NODES_REQUIRED')
  const ids = new Set()
  const nodes = definition.nodes.map(node => {
    requireId(node.id); requireId(node.version)
    if (ids.has(node.id)) throw executionError('DUPLICATE_NODE')
    if (node.inputDependencies !== undefined && (!Array.isArray(node.inputDependencies) || new Set(node.inputDependencies).size !== node.inputDependencies.length
      || node.inputDependencies.some(id => !ids.has(id)))) throw executionError('NODE_DEPENDENCY_INVALID')
    ids.add(node.id)
    if (!['code', 'agent'].includes(node.executor)) throw executionError('EXECUTOR_NOT_ADMITTED')
    if (node.authorizationNode !== undefined && (['task-engineering', 'task-uat-deployment'].includes(definition.id)
      || node.authorizationNode !== true || !isAuthorizationSession(node)
      || !node.allowedEffects?.includes('external.operation'))) throw executionError('AUTHORIZATION_NODE_INVALID')
    if (node.drainPolicy !== undefined && (node.drainPolicy !== 'external-process' || node.executor !== 'code')) throw executionError('NODE_DRAIN_POLICY_INVALID')
    if (!Array.isArray(node.allowedEffects) || !node.allowedEffects.length || node.allowedEffects.some(e => !['pure', 'read', 'git.commit', 'git.push', 'github.pr', 'workspace.prepare', 'workspace.edit', 'external.operation', 'file.write', 'message.send'].includes(e))
      || (node.executor === 'agent' && node.allowedEffects.some(e => !['pure', 'read'].includes(e)) && !isEngineeringEditAgent(definition, node) && !isAuthorizationSession(node))) throw executionError('EFFECT_NOT_ADMITTED')
    if (typeof node.mapInput !== 'function') throw executionError('INPUT_MAPPER_REQUIRED')
    if (node.allowInputContinuation !== undefined && (node.allowInputContinuation !== true || node.executor !== 'agent' || typeof node.admitOutput !== 'function')) throw executionError('NODE_CONTINUATION_INVALID')
    if (node.admitOutput !== undefined && typeof node.admitOutput !== 'function') throw executionError('NODE_ADMISSION_INVALID')
    if (node.rebindOutput !== undefined && (typeof node.rebindOutput !== 'function' || node.executor !== 'agent' || node.id !== 'inspect-and-propose')) throw executionError('NODE_REBIND_INVALID')
    if (['validateOutput', 'classifyOutputError'].some(key => node[key] !== undefined && typeof node[key] !== 'function')) throw executionError('NODE_ADMISSION_INVALID')
    if (node.executor === 'code' && typeof node.execute !== 'function') throw executionError('CODE_EXECUTOR_REQUIRED')
    if (node.executor === 'agent' && (![node.provider, node.model, node.prompt].every(v => typeof v === 'string' && v.length) || !Array.isArray(node.allowedTools))) throw executionError('AGENT_DEFINITION_INVALID')
    assertSupportedJsonSchema(node.inputSchema); assertSupportedJsonSchema(node.outputSchema)
    return freeze({ ...node, allowedEffects: [...node.allowedEffects], ...(node.allowedTools ? { allowedTools: [...node.allowedTools] } : {}), inputSchema: structuredClone(node.inputSchema), outputSchema: structuredClone(node.outputSchema) })
  })
  const digestInput = (normalizeSource, historicalLimits = false) => ({ id: definition.id, version: definition.version,
    ...(ownerContract ? { ownerContract: { id: ownerContract.id, version: ownerContract.version,
      rulesDigest: ownerContract.rulesDigest ?? null,
      ...(ownerContract.validateRevision ? { validateRevision: normalizeSource(ownerContract.validateRevision.toString()) } : {}),
      ...(ownerContract.resultContract ? { resultContract: ownerContract.resultContract } : {}),
      ...Object.fromEntries(['readArtifacts', 'validateCompletion', 'inspectRepair', 'prepareRepair']
        .map(key => [key, ownerContract[key] ? normalizeSource(ownerContract[key].toString()) : null])) } } : {}),
    nodes: nodes.map(n => ({
    id: n.id, version: n.version, executor: n.executor, allowedEffects: n.allowedEffects,
    ...(n.authorizationNode ? { authorizationNode: true, authorizationExecute: normalizeSource(n.authorizationExecute.toString()) } : {}),
    ...(historicalLimits ? { maxSteps: n.maxSteps ?? 32, timeoutMs: n.timeoutMs ?? 120000 } : {}),
    inputSchema: n.inputSchema, outputSchema: n.outputSchema, mapper: normalizeSource(n.mapInput.toString()),
    implementation: n.execute ? normalizeSource(n.execute.toString()) : null, provider: n.provider ?? null, model: n.model ?? null,
    ...(n.reasoningEffort === undefined ? {} : { reasoningEffort: n.reasoningEffort }),
    ...(n.drainPolicy === undefined ? {} : { drainPolicy: n.drainPolicy }),
    ...(n.rebindOutput ? { rebindOutput: normalizeSource(n.rebindOutput.toString()) } : {}),
    ...(n.admitOutput ? { admitOutput: normalizeSource(n.admitOutput.toString()), allowInputContinuation: n.allowInputContinuation === true } : {}),
    ...(n.validateOutput ? { validateOutput: normalizeSource(n.validateOutput.toString()), classifyOutputError: n.classifyOutputError ? normalizeSource(n.classifyOutputError.toString()) : null } : {}),
    prompt: n.prompt ?? null, allowedTools: n.allowedTools ?? [], rulesDigest: n.rulesDigest ?? null,
    ...(n.inputDependencies ? { inputDependencies: n.inputDependencies } : {}),
  })) })
  const digest = executionDigest(digestInput(source => source.replace(/\r\n?/g, '\n')))
  // 已落盘定义曾将执行上限计入摘要；恢复其身份，不恢复已移除的运行上限。
  const legacyDigests = [source => source, source => source.replace(/\r\n?/g, '\n'),
    source => source.replace(/\r\n?|\n/g, '\r\n')]
    .flatMap(normalize => [false, true].map(historicalLimits => executionDigest(digestInput(normalize, historicalLimits))))
    .filter(value => value !== digest)
  return Object.freeze({ id: definition.id, version: definition.version, nodes: Object.freeze(nodes), digest,
    ...(ownerContract ? { ownerContract } : {}),
    legacyDigests: Object.freeze([...new Set(legacyDigests)]) })
}

/** 一个Controller拥有推进权；等待及状态查询不调用模型，所有身份由控制账产生。 */
export function createExecutionController({ store, artifacts, sessions, delivery, workflows, historicalWorkflows = [], readTools = [], maxConcurrentRuns = 4, externalProcessScope, configuration }) {
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) throw executionError('CONTROLLER_CONFIG_INVALID')
  const definitions = new Map(), byDigest = new Map()
  function registerDefinition(input, historical = false, replay = false) {
    const definition = defineExecutionWorkflow(input)
    if (!historical && definitions.has(definition.id)) {
      if (replay && definitions.get(definition.id).digest === definition.digest) return definition
      throw executionError('DUPLICATE_WORKFLOW')
    }
    if (!delivery && definition.nodes.some(node => node.allowedEffects.some(e => !['pure', 'read'].includes(e)))) throw executionError('DELIVERY_ADAPTER_REQUIRED')
    for (const node of definition.nodes) if ((node.allowedTools ?? []).some(name => name === authorizationTool ? !isAuthorizationSession(node) : name === 'engineering_apply_edits' ? !isEngineeringEditAgent(definition, node) : !readTools.includes(name))) throw executionError('TOOL_NOT_ADMITTED')
    if (!historical) definitions.set(definition.id, definition)
    for (const digest of [definition.digest, ...definition.legacyDigests]) byDigest.set(digest, definition)
    return definition
  }
  for (const input of historicalWorkflows) registerDefinition(input, true)
  for (const input of workflows) registerDefinition(input)
  let closed = false, running = 0
  const queue = [], flights = new Map(), active = new Map(), errors = new Map(), dirty = new Set()
  const query = (runId, options = {}) => store.query({ kind: 'run', runId, ...options })
  const command = (id, kind, args, context = {}) => store.command({ id, kind, args, ...context })
  let configurationCreation = Promise.resolve()
  const createConfiguredRun = work => {
    if (!configuration) return work()
    const pending = configurationCreation.then(work)
    configurationCreation = pending.catch(() => {})
    return pending
  }
  function nodeConfiguration(binding, workflowId, signal) {
    let reader
    const read = async (method, alias) => {
      signal.throwIfAborted()
      if (!await isCurrent(binding)) throw executionError('NODE_STALE')
      if (!configuration) throw executionError('WORKFLOW_CONFIGURATION_UNAVAILABLE')
      reader ??= configuration.forRun({ runId: binding.runId, workflowId })
      const value = await (await reader)[method](alias)
      signal.throwIfAborted()
      if (!await isCurrent(binding)) throw executionError('NODE_STALE')
      return value
    }
    return Object.freeze({ read: alias => read('read', alias), readSecret: alias => read('readSecret', alias) })
  }
  function definitionOf(run) {
    const definition = byDigest.get(run.workflowDigest)
    if (!definition || definition.id !== run.workflowId) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
    return run.workflowDigest === definition.digest ? definition : { ...definition, digest: run.workflowDigest }
  }
  const resolveLineageDefinition = record => {
    try { return definitionOf({workflowId:record.workflowId,workflowDigest:record.digest}) } catch { return null }
  }
  async function retainedSemanticEvidence(state, previous, next, retained) {
    const proof=[]
    for(const node of retained){
      const before=previous.nodes[node.position],after=next.nodes[node.position]
      if(!before||!after||executionNodeContractDigest(before)!==executionNodeContractDigest(after))throw executionError('WORKFLOW_RETAINED_CONTRACT_CHANGED')
      const input=await artifacts.read(node.inputRef)
      const lineage=await inspectExecutionInputLineage({store,artifacts,run:state.run,node,input,definition:previous,resolveDefinition:resolveLineageDefinition})
      if(!lineage.trusted || input.requirementRef!==state.run.requirementRef)throw executionError('WORKFLOW_RETAINED_INPUT_UNPROVEN')
      proof.push({nodeRunId:node.nodeRunId,nodeId:node.nodeId,nodeVersion:node.nodeVersion,inputRef:node.inputRef,inputDigest:node.inputDigest,
        requirementRef:input.requirementRef,businessInputDigest:executionDigest(input.data),fromContractDigest:executionNodeContractDigest(before),toContractDigest:executionNodeContractDigest(after)})
    }
    return {semanticProofVersion:1,producer:'execution-controller',retainedContracts:proof}
  }
  async function localPlannerInput(state,node,frozen,input) {
    const previous=state.nodes[node.position-1]
    if(node.nodeId!=='plan-local-acceptance'||frozen.executor!=='agent'||!node.sessionBound||!node.sessionId||previous?.nodeId!=='define-local-acceptance'||previous.status!=='succeeded'||!previous.outputRef)
      return {trusted:false,gates:[{name:'originalPlannerSession',passed:false}]}
    const expectedData=await frozen.mapInput({requirement:await artifacts.read(state.run.requirementRef),previousOutput:await artifacts.read(previous.outputRef),dependencyOutputs:{},artifactRefs:{previousOutput:previous.outputRef}})
    validate(frozen.inputSchema,input.data)
    return inspectLocalAcceptanceCorrection({run:state.run,node,input,expectedData})
  }
  async function inspectNodeRecovery(runId, suppliedState, automaticPlanRevision = false) {
    const state = suppliedState ?? await query(runId, { includeRecovery: true })
    const recovery = state.nodeRecovery
    if (!recovery) throw executionError('WORKFLOW_RECOVERY_SNAPSHOT_MISSING')
    if (!recovery.repairable) return recovery
    if (closed || flights.has(runId) && !(automaticPlanRevision && (recovery.technicalPlanRevision === true || recovery.localPlanCorrection === true) && !active.has(runId))) return { ...recovery, repairable: false, reason: 'executor-still-active' }
    const definition = definitionOf(state.run)
    const node = state.nodes.find(item => item.nodeRunId === recovery.nodeRunId), frozen = node && definition.nodes[node.position]
    if (recovery.readonlyFixtureRetry) {
      if(frozen?.id!=='finalize-local-acceptance'||!['21','22','23','24'].includes(definition.version)||typeof definition.nodes.find(n=>n.id==='prepare-local-acceptance')?.retryAcceptance!=='function')return {...recovery,repairable:false,reason:'acceptance-retry-capability-missing'}
      const output=await artifacts.read(recovery.acceptanceOutputRef),receipt=output.localAcceptance,prepared=output.localPrepared
      let fixtureDigest,report,ledger
      try {fixtureDigest=createHash('sha256').update(await readFile(recovery.runnerScript)).digest('hex');const config=JSON.parse(await readFile(recovery.runnerConfigPath,'utf8'));if(config.taskId!==state.run.taskId||config.uatEnvironment!==prepared.uatEnvironment)throw new Error('scope');report=JSON.parse(await readFile(`${config.evidenceRoot}/${prepared.namespace}/result.json`,'utf8'));ledger=JSON.parse(await readFile(`${config.evidenceRoot}/${prepared.namespace}/dataset-merge-ui-ledger.json`,'utf8'))}catch{}
      const expectedIds=['SG20-01-selection','SG20-02-columns','SG20-03-panel','SG20-04-filter-scroll','SG20-05-steps','SG20-06-notice','SG20-07-description']
      if(report?.runnerDigest===fixtureDigest
        ||receipt?.passed!==false||receipt.cleanup?.mode!=='read-only'||receipt.cleanup.createdResources!==0||receipt.cleanup.dataCleaned!==true||receipt.cleanup.processStopped!==true
        ||prepared.candidateDigest!==receipt.candidateDigest||prepared.planDigest!==receipt.planDigest||prepared.runId!==runId
        ||report?.browserClosed!==true||report.passed!==false||report.backendVerified!==false||report.pageErrors?.length!==0||report.cases?.length!==7
        ||expectedIds.some(id=>report.cases.filter(c=>c.id===id).length!==1)||report.cases.some(c=>!['PASS','FAIL'].includes(c.status))
        ||ledger?.namespace!==prepared.namespace||ledger.businessWrites!==0||ledger.browserClosed!==true)
        return {...recovery,repairable:false,reason:'readonly-fixture-fix-proof-missing'}
      return {...recovery,fixtureDigest}
    }
    if (recovery.readonlyAcceptanceRetry) {
      if (frozen?.id !== 'run-local-acceptance' || frozen.executor !== 'code' || !['21','22','23','24'].includes(definition.version)) return {...recovery,repairable:false,reason:'acceptance-node-contract-mismatch'}
      const input=await artifacts.read(node.inputRef)
      if (executionDigest(input)!==node.inputDigest || input.requirementRef!==state.run.requirementRef || !input.data?.localPrepared) return {...recovery,repairable:false,reason:'acceptance-input-proof-missing'}
      try {await store.query({kind:'node.acceptance-retry-proof',binding:{runId,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest},prepared:{...input.data.localPrepared,requirementDigest:input.data.candidate.requirementDigest}})}
      catch {return {...recovery,repairable:false,reason:'acceptance-retry-proof-missing'}}
      return recovery
    }

    if (!frozen || frozen.executor !== 'agent' || frozen.allowedEffects.some(effect => !['pure','read'].includes(effect))
      && !(recovery.editArgumentCorrection && isEngineeringEditAgent(definition, frozen)))
      return { ...recovery, repairable: false, reason: 'node-effects-not-readonly' }
    if (recovery.executionPlanCorrection) {
      const ui = state.nodes.find(item => item.nodeRunId === recovery.acceptanceNodeRunId)
      const output = ui && await artifacts.read(ui.outputRef)
      const receipt = output?.localAcceptance, prepared = output?.localPrepared
      const verified = state.nodes.find(item => item.nodeId === 'verify-candidate')
      const verification = verified && await artifacts.read(verified.outputRef)
      const expected = JSON.stringify({uiContract:true,coverage:'candidate-ui-with-explicit-api-and-list-fixtures',backendVerified:false})
      let report,ledger
      try {const config=JSON.parse(await readFile(recovery.runnerConfigPath,'utf8'));if(config.taskId!==state.run.taskId||config.uatEnvironment!==prepared.uatEnvironment)throw new Error('scope');report=JSON.parse(await readFile(`${config.evidenceRoot}/${prepared.namespace}/result.json`,'utf8'));ledger=JSON.parse(await readFile(`${config.evidenceRoot}/${prepared.namespace}/dataset-merge-ui-ledger.json`,'utf8'))}catch{}
      const ids=['SG20-01-selection','SG20-02-columns','SG20-03-panel','SG20-04-filter-scroll','SG20-05-steps','SG20-06-notice','SG20-07-description']
      const mismatch=receipt?.failureCode==='LOCAL_ACCEPTANCE_EXPECTATION_MISMATCH'&&receipt.checks?.length===1&&receipt.checks[0].actual===expected&&receipt.checks[0].expected!==expected
        &&report?.passed===true&&report.browserClosed===true&&report.backendVerified===false&&report.pageErrors?.length===0&&report.cases?.length===7
        &&ids.every(id=>report.cases.filter(c=>c.id===id&&c.status==='PASS').length===1)&&ledger?.namespace===prepared.namespace&&ledger.businessWrites===0&&ledger.browserClosed===true
      const parameterError=receipt?.failureCode==='LOCAL_ACCEPTANCE_COMMAND_FAILED'&&receipt.checks?.length===0&&Object.keys(prepared.plan.cases[0].parameters??{}).length>0
      if (ui.status!=='succeeded'||ui.outputRef!==recovery.acceptanceOutputRef||!ui.drained
        ||prepared?.taskId!==state.run.taskId||prepared.runId!==runId||prepared.generation!==state.run.generation
        ||prepared.candidateDigest!==verification?.candidate?.digest||verification?.verification?.passed!==true
        ||receipt?.candidateDigest!==prepared.candidateDigest||receipt?.planDigest!==executionDigest(prepared.plan)||receipt.passed!==false
        ||receipt.cleanup?.mode!=='read-only'||receipt.cleanup.createdResources!==0||receipt.cleanup.dataCleaned!==true||receipt.cleanup.processStopped!==true
        ||prepared.plan.cases?.length!==1||prepared.plan.cases[0].scenarioId!==recovery.runnerScenarioId||!recovery.runnerInstructions?.includes(expected)||!mismatch&&!parameterError)
        return {...recovery,repairable:false,reason:'readonly-plan-interface-proof-missing'}

    }
    if (recovery.validationNodeRunId && !recovery.executionPlanCorrection) {
      const validation = state.nodes.find(item => item.nodeRunId === recovery.validationNodeRunId)
      const validator = validation && definition.nodes[validation.position]
      if ((recovery.localPlanCorrection ? validation?.position <= node.position : validation?.position !== node.position + 1) || validation.leaseEpoch !== recovery.validationLeaseEpoch
        || validation.inputDigest !== recovery.validationInputDigest || (recovery.technicalPlanRevision === true
          ? !isEngineeringEditAgent(definition, validator ?? {}) : validator?.executor !== 'code' || validator.allowedEffects.some(effect => !((recovery.localPlanCorrection ? ['pure','workspace.prepare'] : ['pure']).includes(effect)))))
        return { ...recovery, repairable: false, reason: 'proposal-validation-not-pure' }
      const validationInput = await artifacts.read(validation.inputRef), proposal = await artifacts.read(node.outputRef)
      const lineage = recovery.localPlanCorrection ? {trusted:validationInput.requirementRef===state.run.requirementRef&&validation.inputRef.startsWith(`tasks/${state.run.taskId}/`),gates:[]} : await inspectExecutionInputLineage({store,artifacts,run:state.run,node:validation,input:validationInput,definition,resolveDefinition:resolveLineageDefinition})
      if (executionDigest(validationInput) !== validation.inputDigest || !lineage.trusted
        || validationInput.nodeId !== validation.nodeId || (recovery.technicalPlanRevision === true
          ? validationInput.data.plan?.ref !== node.outputRef || validationInput.data.plan?.digest !== executionDigest(proposal)
          : executionDigest(recovery.localPlanCorrection ? validationInput.data.plan : validationInput.data) !== executionDigest(proposal)))
        return { ...recovery, repairable: false, reason: 'proposal-validation-input-mismatch', gates: lineage.gates }
    }
    if (recovery.editArgumentCorrection) {
      const proofs = await Promise.all(recovery.evidenceRefs.map(ref => artifacts.read(ref)))
      if (!proofs.some(proof => proof.kind === 'execution-failure' && proof.runId === runId
        && proof.nodeRunId === node.nodeRunId && proof.nodeId === node.nodeId && proof.generation === node.generation
        && proof.leaseEpoch === node.leaseEpoch && proof.inputDigest === node.inputDigest
        && proof.code === 'execution_tool_failed' && proof.phase === 'execution'
        && proof.tool === 'engineering_apply_edits' && proof.message === 'ENGINEERING_NO_EFFECT_MODIFICATION'))
        return { ...recovery, repairable: false, reason: 'edit-rejection-proof-missing' }
    }
    const input = await artifacts.read(node.inputRef)
    const lineage = recovery.localPlanCorrection ? await localPlannerInput(state,node,frozen,input) : await inspectExecutionInputLineage({store,artifacts,run:state.run,node,input,definition,resolveDefinition:resolveLineageDefinition})
    if (!lineage.trusted) return { ...recovery, repairable: false, reason: 'node-input-identity-mismatch', gates: lineage.gates }
    return {...recovery, gates:lineage.gates, lineage:lineage.chain ?? [], warnings:lineage.warnings ?? []}
  }
  async function resumeAgent({ commandId, runId, expectedRevision, nodeRunId, generation, leaseEpoch, inputDigest, contextRef }, automaticPlanRevision = false) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const replay = await store.query({ kind: 'receipt', commandId })
      if (replay) {
        const prior = replay.result
        if (prior.runId !== runId || prior.nodeRunId !== nodeRunId || prior.generation !== generation
          || prior.inputDigest !== inputDigest || prior.contextRef !== contextRef || prior.nextLeaseEpoch !== leaseEpoch + 1
          || prior.previousRunRevision !== expectedRevision) throw executionError('NODE_RECOVERY_CONFLICT')
        if (!automaticPlanRevision) schedule(runId); return replay
      }
      const recovery = await inspectNodeRecovery(runId, undefined, automaticPlanRevision)
      if (!recovery.repairable || recovery.nodeRunId !== nodeRunId || recovery.runRevision !== expectedRevision
        || recovery.generation !== generation || recovery.leaseEpoch !== leaseEpoch || recovery.inputDigest !== inputDigest)
        throw executionError('NODE_RECOVERY_NOT_ADMITTED', recovery.reason)
      const state = await query(runId), context = await artifacts.read(contextRef)
      if (context?.kind !== 'execution-recovery-context' || context.taskId !== state.run.taskId || context.runId !== runId
        || context.nodeRunId !== nodeRunId || context.generation !== generation
        || typeof context.diagnosis !== 'string' || !context.diagnosis.trim() || typeof context.strategy !== 'string' || !context.strategy.trim()
        || !Array.isArray(context.evidenceRefs) || !context.evidenceRefs.length
        || context.evidenceRefs.some(ref => !recovery.evidenceRefs.includes(ref))
        || context.problemKey !== undefined && context.problemKey !== recovery.problemKey)
        throw executionError('NODE_RECOVERY_CONTEXT_INVALID')
      await Promise.all(context.evidenceRefs.map(ref => artifacts.read(ref)))
      const plan = await store.query({ kind: 'task.plan', taskId: state.run.taskId })
      if (context.requirementRevision !== plan.task.requirementRevision || context.planRevision !== plan.task.planRevision
        || context.controlRevision !== plan.task.controlRevision) throw executionError('NODE_RECOVERY_CONTEXT_STALE')
      const requirement = plan.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : {}
      const sources = []
      for (const frozen of requirement.sourceInstructions ?? []) {
        const source = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
        if (!source || source.status === 'superseded' || source.sourceVersion !== frozen.sourceVersion
          || source.actorId !== frozen.actorId || source.body !== frozen.text) throw executionError('NODE_RECOVERY_SOURCE_INVALID')
        sources.push({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, actorId: source.actorId, bodyDigest: executionDigest(source.body) })
      }
      const receipt = await command(commandId, 'node.resume', { runId, expectedRevision, nodeRunId, generation, leaseEpoch,
        inputDigest, contextRef, problemKey: recovery.problemKey, workflowDigest: state.run.workflowDigest, sources,
        expectedRequirementRevision: context.requirementRevision, expectedPlanRevision: context.planRevision,
        expectedControlRevision: context.controlRevision })
      errors.delete(runId); if (!automaticPlanRevision) schedule(runId); return receipt
  }
  async function prepareInput(definition, node, requirementRef, previousOutput, dependencyOutputs = {}, artifactRefs = {}) {
    const requirement = await artifacts.read(requirementRef)
    const data = await admitResult('input-mapping', node.id,
      () => node.mapInput({ requirement, previousOutput, dependencyOutputs, artifactRefs }))
    await admitResult('input-validation', node.id, () => validate(node.inputSchema, data))
    return artifacts.put({ workflowDigest: definition.digest, nodeId: node.id, nodeVersion: node.version, requirementRef, data }, { reference: requirementRef })
  }
  async function isCurrent(binding) {
    if (closed) return false
    const state = await query(binding.runId)
    const node = state.nodes.find(n => n.nodeRunId === binding.nodeRunId)
    return !!node && state.run.stopRequested !== true && state.run.pauseRequested !== true && state.pendingInputCount === 0 && node.status === 'running'
      && node.generation === binding.generation && node.leaseEpoch === binding.leaseEpoch && node.inputDigest === binding.inputDigest
  }
  function interrupt(runId) {
    active.get(runId)?.abort()
    // 排空由drive等待run()结算，不能在abort()时宣称已经停止。
    Promise.resolve(sessions?.cancel(runId)).catch(error => errors.set(runId, error))
  }
  async function prepareManagedSession(state, node, definition, maintenance) {
    const frozen = definition.nodes.find(item => item.id === node.nodeId)
    if (!sessions?.prepareManagedSession || node.executor !== 'agent' || !node.sessionBound
      || frozen.allowInputContinuation || frozen.allowedEffects.some(effect => !['pure','read'].includes(effect))) return false
    const input = await artifacts.read(node.inputRef)
    if (executionDigest(input) !== node.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== node.nodeId) throw executionError('NODE_INPUT_IDENTITY_MISMATCH')
    const effects = await store.query({kind:'effect.list',runId:state.run.runId})
    if (node.outputRef || effects.some(effect=>effect.nodeRunId===node.nodeRunId || !['succeeded','failed'].includes(effect.state))) return false
    return !!await sessions.prepareManagedSession({...node,taskId:state.run.taskId},frozen,async proof=>{
      const saved=await artifacts.put({kind:'managed-execution-session-rebind',...proof},{reference:node.inputRef})
      await command(`session-rebind:${node.nodeRunId}:${node.leaseEpoch}:${node.sessionId}`,'node.session.rebind',{
        runId:state.run.runId,runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:node.generation,
        leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,sessionId:node.sessionId,nextSessionId:proof.sessionId,
        lastInputLease:proof.lastInputLease,evidenceRef:saved.ref,...(maintenance ? {maintenance} : {})})
    })
  }
  function schedule(runId) {
    if (closed) return Promise.resolve()
    if (flights.has(runId)) { dirty.add(runId); return flights.get(runId) }
    const deferred = Promise.withResolvers()
    flights.set(runId, deferred.promise); queue.push({ runId, deferred })
    deferred.promise.catch(error => errors.set(runId, error))
    queueMicrotask(pump)
    return deferred.promise
  }
  function pump() {
    while (!closed && running < maxConcurrentRuns && queue.length) {
      const item = queue.shift(); running++
      drive(item.runId).then(item.deferred.resolve, item.deferred.reject).finally(() => {
        running--; flights.delete(item.runId)
        if (dirty.delete(item.runId) && !closed) schedule(item.runId)
        pump()
      })
    }
  }
  async function drained(node, reason) {
    const evidence = await artifacts.put({ nodeRunId: node.nodeRunId, leaseEpoch: node.leaseEpoch, reason }, { reference: node.inputRef })
    await command(`drained:${node.nodeRunId}:${node.leaseEpoch}`, 'node.drained', {
      runId: node.runId, nodeId: node.nodeId, generation: node.generation, leaseEpoch: node.leaseEpoch, evidenceRef: evidence.ref,
    })
  }
  async function applyPending(state, definition) {
    // 排空旧节点后立即消费当前持久输入；新补充进入下一批，不等待静默窗口。
    const pending = state.inputs.filter(input => input.status === 'pending')
    if (!pending.length) return false
    // 为固定节点引用留出余量；按编码字节限制ID前缀，转义字符也计入预算。
    // 剩余pending仍持有屏障；中间批次不会启动执行器。
    const batch = []
    for (const item of pending.slice(0, 16)) {
      if (Buffer.byteLength(JSON.stringify([...batch.map(p => p.inputId), item.inputId])) > 128 * 1024) break
      batch.push(item)
    }
    const input = await prepareInput(definition, definition.nodes[0], batch.at(-1).requirementRef)
    await command(`apply:${state.run.runId}:${executionDigest(batch.map(p => p.inputId))}`, 'input.apply', {
      runId: state.run.runId, inputIds: batch.map(p => p.inputId), expectedRevision: state.run.revision,
      requirementRef: batch.at(-1).requirementRef,
      nodes: definition.nodes.map((node, index) => ({ nodeId: node.id, inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })),
    })
    return true
  }
  async function correctLocalPlannerObjective(runId, state) {
    const node = state.nodes.find(item => item.status === 'waiting')
    if (node?.nodeId !== 'plan-local-acceptance' || node.waitReason?.reference !== 'execution_no_submission') return false
    if (state.run.pauseRequested || state.run.stopRequested || state.pendingInputCount) return false
    const plan = await store.query({ kind: 'task.plan', taskId: state.run.taskId })
    if (plan.task.controlState !== 'active') return false
    const requirement = await artifacts.read(plan.task.requirementRef), input = await artifacts.read(node.inputRef)
    const objective = requirement.objective?.trim()
    if (!objective || objective === input.data.request?.trim()) return false
    const commandId = `planner-objective:${node.nodeRunId}:${plan.task.requirementRevision}`
    if (await store.query({ kind: 'receipt', commandId })) return 'already-attempted'
    const recovery = await inspectNodeRecovery(runId)
    if (!recovery.repairable) return false
    const context = await artifacts.put({ kind: 'execution-recovery-context', taskId: state.run.taskId, runId,
      nodeRunId: node.nodeRunId, generation: state.run.generation, requirementRevision: plan.task.requirementRevision,
      planRevision: plan.task.planRevision, controlRevision: plan.task.controlRevision, problemKey: recovery.problemKey,
      canonicalRequirementRef: plan.task.requirementRef,
      diagnosis: 'The local planner received the original short reply without the resolved task objective.',
      strategy: `Use the current formal task objective to select the configured scenario: ${objective}. Preserve the original criteria and scope. Submit an executable plan; do not claim acceptance has run or passed.`,
      evidenceRefs: recovery.evidenceRefs }, { reference: node.inputRef })
    await resumeAgent({ commandId, runId, expectedRevision: recovery.runRevision, nodeRunId: node.nodeRunId,
      generation: recovery.generation, leaseEpoch: recovery.leaseEpoch, inputDigest: node.inputDigest, contextRef: context.ref })
    return true
  }
  async function correctLocalPlan(runId, state, automatic = false) {
    const recovery = await inspectNodeRecovery(runId, await query(runId, { includeRecovery: true }), automatic)
    if (!recovery.repairable || !recovery.localPlanCorrection) return false
    const plan = await store.query({ kind: 'task.plan', taskId: state.run.taskId })
    const context = await artifacts.put({ kind: 'execution-recovery-context', taskId: state.run.taskId, runId,
      nodeRunId: recovery.nodeRunId, generation: recovery.generation, requirementRevision: plan.task.requirementRevision,
      planRevision: plan.task.planRevision, controlRevision: plan.task.controlRevision, problemKey: recovery.problemKey,
      diagnosis: '本地验收准备拒绝了原规划结果；请读取完整失败工件和原需求，纠正原用例计划。',
      strategy: recovery.executionPlanCorrection
        ? `Continue the original planning session. Correct the plan to the frozen runner scope: candidate UI with explicit API/list fixtures, backendVerified:false; parameters:{}. Replace incompatible backend merge claims in expected and steps; retain all seven UI assertions. Expected MUST be the exact JSON string specified below. Do not claim backend verification, skip any case, change candidate code, or invent a successful result. Host retains applied candidate and passed verification; new plan digest creates a new acceptance namespace. Frozen runner instructions: ${recovery.runnerInstructions}`
        : '继续原规划会话，补齐实际可执行用例。已成功的准备、编辑和验证保持，不修改候选源码来迎合错误计划。', evidenceRefs: recovery.evidenceRefs }, { reference: state.run.requirementRef })
    await resumeAgent({ commandId: `local-plan-correction:${recovery.problemKey}`, runId, expectedRevision: recovery.runRevision,
      nodeRunId: recovery.nodeRunId, generation: recovery.generation, leaseEpoch: recovery.leaseEpoch, inputDigest: recovery.inputDigest, contextRef: context.ref }, automatic)
    return true
  }
  async function correctEditArguments(runId, state) {
    const recovery = await inspectNodeRecovery(runId, await query(runId, { includeRecovery: true }))
    if (!recovery.repairable || !recovery.editArgumentCorrection) return false
    const plan = await store.query({ kind: 'task.plan', taskId: state.run.taskId })
    const context = await artifacts.put({ kind: 'execution-recovery-context', taskId: state.run.taskId, runId,
      nodeRunId: recovery.nodeRunId, generation: recovery.generation, requirementRevision: plan.task.requirementRevision,
      planRevision: plan.task.planRevision, controlRevision: plan.task.controlRevision, problemKey: recovery.problemKey,
      diagnosis: 'Previous engineering_apply_edits batch rejected before dispatch: replacement entries 4 and 5 had identical from/to. No edit effect exists.',
      strategy: 'Continue this original session and plan. Read actual files again. Omit identical replacements. Use actual newline and quote characters rather than literal backslash-n or backslash-quote text. Submit one real batch built from current file hashes; never invent effects or repeat a successful edit.',
      evidenceRefs: recovery.evidenceRefs }, { reference: state.run.requirementRef })
    await resumeAgent({ commandId: `edit-argument-correction:${recovery.problemKey}`, runId, expectedRevision: recovery.runRevision,
      nodeRunId: recovery.nodeRunId, generation: recovery.generation, leaseEpoch: recovery.leaseEpoch, inputDigest: recovery.inputDigest, contextRef: context.ref })
    return true
  }
  async function continueOriginalAgent(runId, state) {
    const recovery = await inspectNodeRecovery(runId)
    // 专用纠正继续走自己的冻结合同；通用续行不扩大写入或改图能力。
    if (!recovery.repairable || recovery.mode !== 'resume-agent' || recovery.technicalPlanRevision
      || recovery.localPlanCorrection || recovery.editArgumentCorrection
      || recovery.readonlyAcceptanceRetry || recovery.readonlyFixtureRetry) return false
    const plan = await store.query({ kind: 'task.plan', taskId: state.run.taskId })
    const context = await artifacts.put({ kind: 'execution-recovery-context', taskId: state.run.taskId, runId,
      nodeRunId: recovery.nodeRunId, generation: recovery.generation,
      requirementRevision: plan.task.requirementRevision, planRevision: plan.task.planRevision,
      controlRevision: plan.task.controlRevision, problemKey: recovery.problemKey,
      diagnosis: `原节点执行未完成：${recovery.failure.code}；阶段：${recovery.failure.phase}。完整失败事实及来源见 evidence 与 evidenceRefs。`,
      strategy: '继续原节点会话，读取完整失败诊断和当前任务要求，在已有工具与授权范围内纠正参数、方法或产物并提交实际结果。保留已成功工作，不修改流程、不重复外部效果、不把内部错误要求用户重交材料。确实缺少能力、权限或业务信息时明确缺口及恢复条件；同一问题无新进展时不得原样重复。',
      // 通用只读节点未必有工件工具；将白名单内完整事实随受信上下文交回。
      evidence: await Promise.all(recovery.evidenceRefs.map(async artifactRef => ({ artifactRef, value: await artifacts.read(artifactRef) }))),
      evidenceRefs: recovery.evidenceRefs }, { reference: state.run.requirementRef })
    await resumeAgent({ commandId: `execution-continuation:${recovery.problemKey}`, runId,
      expectedRevision: recovery.runRevision, nodeRunId: recovery.nodeRunId,
      generation: recovery.generation, leaseEpoch: recovery.leaseEpoch, inputDigest: recovery.inputDigest,
      contextRef: context.ref })
    return true
  }
  async function drive(runId) {
    while (!closed) {
      const state = await query(runId)
      if (!state.run) throw executionError('RUN_NOT_FOUND')
      if (state.run.recoveryReason === 'stage-dependency') return
      const definition = definitionOf(state.run)
      if (state.run.stopRequested) {
        await command(`stopped:${runId}`, 'run.stopped', { runId }); return
      }
      if (state.run.pauseRequested) {
        if (state.run.recoveryReason !== 'user_pause') await command(`paused:${runId}:${state.run.revision}`, 'run.paused', { runId })
        return
      }
      if (state.pendingInputCount) { await applyPending(state, definition); continue }
      if (['succeeded', 'failed', 'cancelled'].includes(state.run.status)) return
      const ready = state.nodes.find(node => node.status === 'ready')
      if (!ready) {
        if (!await correctLocalPlan(runId, state, true)) return
        continue
      }
      const nodeDefinition = definition.nodes[ready.position]
      const receipt = await command(`claim:${ready.nodeRunId}:${ready.leaseEpoch + 1}`, 'node.claim', {
        runId, nodeId: ready.nodeId, expectedGeneration: ready.generation, expectedLeaseEpoch: ready.leaseEpoch,
      })
      const binding = { ...receipt.result.binding, taskId: state.run.taskId,
        requirementDigest: executionDigest(await artifacts.read(state.run.requirementRef)) }
      if (nodeDefinition.allowInputContinuation) {
        const history=await store.query({ kind: 'node.input-history', nodeRunId: binding.nodeRunId })
        Object.assign(binding, { kind: 'task-node', inputVersion: history.inputVersion, inputHistory: history.inputHistory })
      }
      const abort = new AbortController(); active.set(runId, abort)
      const editBatchReceipts=new Map()
      let input, engineeringProofRef, noChangeProof, editBatchReceipt, output, submitted = false, failure, outcome
      try {
        input = await artifacts.read(binding.inputRef)
        if (executionDigest(input) !== binding.inputDigest || input.nodeId !== ready.nodeId) throw executionError('NODE_INPUT_IDENTITY_MISMATCH')
        if(input.workflowDigest!==definition.digest){
          const correction=ready.nodeId==='plan-local-acceptance'&&await store.query({kind:'node.recovery-context',nodeRunId:binding.nodeRunId,inputDigest:binding.inputDigest,leaseEpoch:binding.leaseEpoch})
          if(!correction?.localPlanCorrection||!(await localPlannerInput(state,ready,nodeDefinition,input)).trusted)throw executionError('NODE_INPUT_IDENTITY_MISMATCH')
        }
        validate(nodeDefinition.inputSchema, input.data)
        if (nodeDefinition.executor === 'code') {
          abort.signal.throwIfAborted()
          if (!await isCurrent(binding)) throw executionError('NODE_STALE')
          abort.signal.throwIfAborted()
          const execute = () => nodeDefinition.execute({ input: structuredClone(input.data), signal: abort.signal, runId: binding.runId,
            taskId: binding.taskId, nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
            configuration: nodeConfiguration(binding, state.run.workflowId, abort.signal),
            perform: async ({ action, prepared }) => {
              if (!nodeDefinition.allowedEffects.includes(action === 'workspace' ? 'workspace.prepare' : action === 'edit' ? 'workspace.edit' : action === 'pr' ? 'github.pr' : action === 'external' ? 'external.operation' : ['file', 'artifact'].includes(action) ? 'file.write' : action === 'message' ? 'message.send' : `git.${action}`) || !delivery) throw executionError('EFFECT_NOT_ADMITTED')
              abort.signal.throwIfAborted()
              const effect = await delivery.execute({ binding, action, prepared }, { signal: abort.signal, authorizationNode: false })
              if (isTerminalUatBuildFailure(effect)) throw Object.assign(executionError(effect.result.result.reason), { terminalEffect: effect })
              if (effect.unsentRecovery) throw executionError('PR_CONNECTION_FAILED')
              if (effect.state !== 'succeeded') throw executionError('DELIVERY_RECONCILIATION_REQUIRED')
              return effect.result.result // 对执行节点交接适配器产出，控制账回执仍单独留存。
            },
          })
          const processScope = nodeDefinition.drainPolicy === 'external-process' && await externalProcessScope?.({ state: await query(runId), node: binding })
          output = processScope ? await withVerificationProcessJournal(processScope, execute) : await execute()
          abort.signal.throwIfAborted(); submitted = true
        } else {
          if (!sessions) throw executionError('SESSION_ADAPTER_UNAVAILABLE')
          const agentDefinition = Object.fromEntries(['provider', 'model', 'reasoningEffort', 'prompt', 'allowedTools', 'outputSchema'].filter(key => nodeDefinition[key] !== undefined).map(key => [key, nodeDefinition[key]]))
          const recovery = await store.query({ kind: 'node.recovery-context', nodeRunId: binding.nodeRunId,
            inputDigest: binding.inputDigest, leaseEpoch: binding.leaseEpoch })
          let authorizationOutput
          const managedAuthorization = isAuthorizationSession(nodeDefinition)
          const managedEdit = isEngineeringEditAgent(definition, nodeDefinition)
          const currentEdits = async () => (await store.query({ kind: 'effect.list', runId })).filter(effect => effect.nodeRunId === binding.nodeRunId)
          const normalizeManagedOutput=async value=>{
            if (['24','25','26'].includes(definition.version) && nodeDefinition.id === 'plan-local-acceptance') return normalizeWorktreeAcceptancePlan(value, input.data)
            if (definition.version === '23' && nodeDefinition.id === 'plan-local-acceptance') return normalizeEngineeringAcceptancePlan(value, input.data)
            if(!managedEdit||!['22','23','24','25','26'].includes(definition.version))return value
            const effects=await currentEdits()
            return {...value,...(['23','24'].includes(definition.version) && value.summary===undefined ? {summary:value.status==='succeeded'?'受管实施已完成，继续实际构建与验收':'技术方案需要修订'}:{}),planRef:input.data.plan.ref,effectRefs:effects.map(effect=>effect.effectId)}
          }
          const validateAgentOutput = async value => {
            value=await normalizeManagedOutput(value)
            if (nodeDefinition.validateOutput) await nodeDefinition.validateOutput({ output: value, input: input.data, binding })
            if (!managedEdit) return
            const effects = await currentEdits()
            if(['24','25','26'].includes(definition.version)){
              if(value.status==='plan-revision-needed'?effects.length!==0:value.status!=='succeeded'||!effects.length&&!noChangeProof||effects.some(effect=>effect.state!=='succeeded'||effect.inputDigest!==binding.inputDigest||effect.generation!==binding.generation||effect.definition.action!=='edit'))throw executionError('ENGINEERING_TECHNICAL_EXECUTION_INVALID')
            }else{
            if (value.planRef !== input.data.plan.ref || (value.status === 'plan-revision-needed'
              ? effects.length !== 0 || value.effectRefs?.length !== 0
              : value.status !== 'succeeded' || !(effects.length === 0 && noChangeProof && value.effectRefs?.length === 0) && (effects.length !== 1 || effects[0].state !== 'succeeded'
                || effects[0].inputDigest !== binding.inputDigest || effects[0].generation !== binding.generation
                || effects[0].definition.action !== 'edit' || value.effectRefs?.length !== 1 || value.effectRefs[0] !== effects[0].effectId)))
              throw executionError('ENGINEERING_TECHNICAL_EXECUTION_INVALID')
            }
          }
          outcome = await sessions.run({ binding, input: input.data, definition: agentDefinition,
            ...(managedAuthorization ? { requestAuthorization: async (reason, signal) => {
              if (!await isCurrent(binding)) throw executionError('NODE_STALE')
              await artifacts.put({ taskId: binding.taskId, runId, nodeRunId: binding.nodeRunId, reason,
                source: 'authorization-execution-session' }, { reference: binding.inputRef })
              authorizationOutput = await nodeDefinition.authorizationExecute({ input: structuredClone(input.data),
                runId, taskId: binding.taskId, generation: binding.generation, requirementDigest: binding.requirementDigest,
                perform: async ({ action, prepared }) => {
                  if (action !== 'external') throw executionError('EFFECT_NOT_ADMITTED')
                  const effect = await delivery.execute({ binding, action, prepared }, { signal, authorizationNode: true, authorizationRequested: true })
                  if (effect.state !== 'succeeded') throw executionError('DELIVERY_RECONCILIATION_REQUIRED')
                  return effect.result.result
                } })
              return structuredClone(authorizationOutput)
            } } : {}),
            ...(managedEdit ? { applyEdits: async (edits, signal) => {
              edits = { ...edits, changes: edits.changes ?? [], replacements: edits.replacements ?? [] }
              if (!await isCurrent(binding)) throw executionError('NODE_STALE')
              signal.throwIfAborted()
              const batchDigest = executionDigest(edits)
              if(['24','25','26'].includes(definition.version)&&editBatchReceipts.has(batchDigest))return structuredClone(editBatchReceipts.get(batchDigest))
              if (!['24','25','26'].includes(definition.version) && editBatchReceipt) {
                if (editBatchReceipt.digest !== batchDigest) throw executionError('DELIVERY_IDENTITY_CONFLICT')
                return structuredClone(editBatchReceipt.result)
              }
              let applied, dispatchStarted = false, result
              try { result = await nodeDefinition.execute({ input: structuredClone(input.data), edits, signal, runId,
                taskId: binding.taskId, nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
                perform: async ({ action, prepared }) => {
                  if (action !== 'edit' || !delivery) throw executionError('EFFECT_NOT_ADMITTED')
                  if (!await isCurrent(binding)) throw executionError('NODE_STALE')
                  signal.throwIfAborted()
                  dispatchStarted = true
                  applied = await delivery.execute({ binding, action, prepared }, { signal })
                  if (applied.state !== 'succeeded') throw executionError('DELIVERY_RECONCILIATION_REQUIRED')
                  return applied.result.result
                } })
              } catch (error) {
                if (!await isCurrent(binding)) throw executionError('NODE_STALE')
                signal.throwIfAborted()
                if (!dispatchStarted && (['24','25','26'].includes(definition.version) || !(await currentEdits()).length) && ['ENGINEERING_NO_EFFECT_MODIFICATION', 'EDIT_BASE_CONFLICT', 'ENGINEERING_CHANGE_DISPOSITION_INVALID', 'ENGINEERING_NO_CHANGE_EVIDENCE_REQUIRED', 'ENGINEERING_CONFLICT_NOT_READ', 'ENGINEERING_NO_CHANGES_PROPOSED', 'ENGINEERING_PATCH_CONFLICT', 'ENGINEERING_PATCH_BASE_CONFLICT', 'ENGINEERING_PATCH_AMBIGUOUS'].includes(error.code))
                  return { received: false, error: { code: error.code, message: '文件修改参数与当前文件不符。重新读取文件取得完整 hash 和唯一原文，修正同一批次后重试；未派发编辑。' } }
                throw error
              }
              if (!applied && result?.status === 'succeeded' && result.changeDisposition === 'no-change' && !(await currentEdits()).length) {
                noChangeProof = result
                engineeringProofRef = (await artifacts.put(result, { reference: binding.inputRef })).ref
                return { status: 'succeeded', changeDisposition: 'no-change', evidenceRef: engineeringProofRef, planRef: input.data.plan.ref }
              }
              if (!applied) throw executionError('ENGINEERING_TECHNICAL_EXECUTION_INVALID')
              const receipt = { status: 'succeeded', effectId: applied.effectId, planRef: input.data.plan.ref }
              editBatchReceipt = { digest: batchDigest, result: receipt }
              editBatchReceipts.set(batchDigest,receipt)
              return receipt
            } } : {}),
            ...(recovery ? { recoveryContext: await artifacts.read(recovery.contextRef) } : {}),
            ...((nodeDefinition.validateOutput || managedEdit) ? { validateOutput: validateAgentOutput,
              classifyOutputError: error => managedEdit && error.code === 'ENGINEERING_TECHNICAL_EXECUTION_INVALID' ? 'correctable' : nodeDefinition.classifyOutputError?.(error) } : {}),
            onSessionBound: () => command(`bound:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.sessionBound', {
              runId, nodeId: ready.nodeId, generation: binding.generation, leaseEpoch: binding.leaseEpoch, sessionId: binding.sessionId,
            }),
            onResult: async value => {
              if (managedAuthorization && !authorizationOutput) throw executionError('AUTHORIZATION_RESULT_UNVERIFIED')
              output = managedAuthorization ? authorizationOutput : await normalizeManagedOutput(value); submitted = true
            },
          })
        }
      } catch (error) {
        failure = error
        if (error?.code === 'ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT' && nodeDefinition.executor === 'code'
          && definition.id.startsWith('task-engineering-') && binding.nodeId === 'apply-changes') {
          try {
            const proven = await proveEngineeringNoAdditionalChange({ store, binding, input: input.data, signal: abort.signal })
            const evidence = await artifacts.put(proven.proof, { reference: binding.inputRef })
            output = proven.output; submitted = true; failure = null; engineeringProofRef = evidence.ref
          } catch (proofError) { failure = proofError }
        }
      }
      finally { active.delete(runId) }
      if (failure?.executionDrained === false) throw failure
      await drained(binding, 'executor-settled')
      if (!(await isCurrent(binding))) continue
      const identity = { runId, nodeId: ready.nodeId, generation: binding.generation, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest }
      if (failure || !submitted) {
        if (failure) errors.set(runId, failure)
        const evidenceRefs = []
        const terminalDeliveryFailure = isTerminalUatBuildFailure(failure?.terminalEffect)
        if (terminalDeliveryFailure) evidenceRefs.push((await artifacts.put(failure.terminalEffect.result.result, { reference: binding.inputRef })).ref)
        if (failure?.evidence !== undefined) {
          // 受信执行器可以提供失败证据，框架不按领域错误码决定是否保存。
          try {
            if (!Array.isArray(failure.evidence) || failure.evidence.length > 126) throw executionError('NODE_FAILURE_EVIDENCE_INVALID')
            for (const payload of failure.evidence) canonicalExecutionJson(payload)
          } catch (cause) { failure = new ResultAdmissionError(cause, 'failure-evidence', ready.nodeId) }
          if (!(failure instanceof ResultAdmissionError))
            for (const payload of failure.evidence) evidenceRefs.push((await artifacts.put(payload, { reference: binding.inputRef })).ref)
        }
        const reportedReason = failure?.code ?? (failure ? 'NODE_EXECUTION_FAILED' : outcome?.failure?.code ?? outcome?.reason ?? outcome?.status)
        const reason = typeof reportedReason === 'string' && reportedReason.trim() ? reportedReason.slice(0, 200) : 'NO_NODE_SUBMISSION'
        const diagnosticFailure = { code: reason, phase: failure?.phase ?? outcome?.failure?.phase ?? 'execution',
          targetNodeId: failure?.nodeId ?? ready.nodeId }
        evidenceRefs.push((await artifacts.put({ kind: 'execution-failure', ...identity, nodeRunId: binding.nodeRunId,
          ...diagnosticFailure, message: String(failure?.message ?? outcome?.failure?.message ?? reason).slice(0, 2000),
          ...(outcome?.failure?.tool ? { tool: outcome.failure.tool } : {}),
          ...(outcome?.reason ? { sessionReason: outcome.reason } : {}),
          recovery: classifyExecutionFailure(diagnosticFailure) }, { reference: binding.inputRef })).ref)
        await command(`result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', {
          ...identity, outcome: terminalDeliveryFailure ? 'failed' : 'waiting', evidenceRefs, waitReason: { kind: 'recovery', reference: reason },
          failure: diagnosticFailure,
        })
        return
      }
      let result
      try {
        await admitResult('output-validation', ready.nodeId, () => validate(nodeDefinition.outputSchema, output))
        result = await artifacts.put(output, { reference: binding.inputRef })
        if (nodeDefinition.admitOutput) {
          const input = await artifacts.read(binding.inputRef)
          const disposition = await admitResult('output-admission', ready.nodeId, () => nodeDefinition.admitOutput({ output,
            input: input.data, binding, signal: abort.signal }))
          if (disposition && ['waiting', 'failed'].includes(disposition.outcome)) {
            const code = disposition.waitReason?.reference ?? 'NODE_RESULT_CONTRACT_INVALID'
            const diagnosis = await artifacts.put({ kind: 'execution-failure', ...identity, nodeRunId: binding.nodeRunId,
              phase: 'output-admission', targetNodeId: ready.nodeId, code, message: code,
              producedOutputRef: result.ref, recovery: classifyExecutionFailure({ code, phase: 'output-admission' }) }, { reference: binding.inputRef })
            await command(`result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', { ...identity,
              outcome: disposition.outcome, outputRef: result.ref, evidenceRefs: [result.ref, diagnosis.ref], waitReason: disposition.waitReason,
              failure: { code, phase: 'output-admission', targetNodeId: ready.nodeId } })
            if (nodeDefinition.rebindOutput && code === 'ENGINEERING_DEVELOPMENT_REBUILD_REQUIRED') {
              try { await nodeDefinition.rebindOutput({ binding, outputRef: result.ref, controller: { registerWorkflow: input => registerDefinition(input, false, true) } }); errors.delete(runId) }
              catch(error) { errors.set(runId,error); throw error }
              continue
            }
            if (isEngineeringEditAgent(definition, nodeDefinition) && code === 'ENGINEERING_TECHNICAL_PLAN_REVISION_REQUIRED') {
              const snapshot = await query(runId, { includeRecovery: true })
              const recovery = await inspectNodeRecovery(runId, snapshot, true)
              if (recovery.repairable && recovery.technicalPlanRevision === true) {
                const plan = await store.query({ kind: 'task.plan', taskId: binding.taskId })
                const context = await artifacts.put({ kind: 'execution-recovery-context', taskId: binding.taskId, runId,
                  nodeRunId: recovery.nodeRunId, generation: recovery.generation, requirementRevision: plan.task.requirementRevision,
                  planRevision: plan.task.planRevision, controlRevision: plan.task.controlRevision, problemKey: recovery.problemKey,
                  diagnosis: output.summary, strategy: '依据实施节点指出的具体设计缺陷修订技术方案，先核原需求与当前代码；不重复准备工作，不请求额外人工审批。',
                  evidenceRefs: recovery.evidenceRefs }, { reference: binding.inputRef })
                await resumeAgent({ commandId: `plan-revision:${binding.nodeRunId}:${binding.leaseEpoch}`, runId,
                  expectedRevision: recovery.runRevision, nodeRunId: recovery.nodeRunId, generation: recovery.generation,
                  leaseEpoch: recovery.leaseEpoch, inputDigest: recovery.inputDigest, contextRef: context.ref }, true)
                continue
              }
            }
            return
          }
          if (disposition?.outcome !== 'succeeded') throw executionError('NODE_ADMISSION_INVALID')
        }
        let nextState = state.nodes[ready.position + 1], retainedSuccessor = false
        if ((ready.nodeId === 'plan-local-acceptance' || ['25','26'].includes(definition.version) && ready.nodeId === 'define-local-acceptance') && nextState?.status === 'succeeded') {
          const record = (await store.query({ kind: 'workflow.list' })).find(item => item.digest === state.run.workflowDigest)
          const checkpoint = record?.config?.checkpoint
          const receipt = checkpoint?.kind === 'local-acceptance' && await store.query({ kind: 'receipt', commandId: `engineering-checkpoint:${runId}:${checkpoint.requestId}` })
          const correction = await store.query({ kind: 'node.recovery-context', nodeRunId: binding.nodeRunId, inputDigest: binding.inputDigest, leaseEpoch: binding.leaseEpoch })
          if (receipt?.result?.toDigest !== state.run.workflowDigest && !correction?.localPlanCorrection) throw executionError('ENGINEERING_CHECKPOINT_NOT_ADMITTED')
          retainedSuccessor = true
          nextState = state.nodes.find(item => item.position > ready.position && item.status !== 'succeeded')
        }
        const next = nextState && (!retainedSuccessor || nextState.status === 'blocked') ? definition.nodes[nextState.position] : undefined
        const dependencies = {}, dependencyRefs = {}
        for (const id of next?.inputDependencies ?? []) {
          if (id === ready.nodeId) { dependencies[id] = output; dependencyRefs[id] = result.ref }
          else {
            const source = state.nodes.find(node => node.nodeId === id && node.status === 'succeeded' && node.outputRef)
            if (!source) throw new ResultAdmissionError(executionError('NODE_DEPENDENCY_UNAVAILABLE'), 'input-dependencies', next.id)
            dependencies[id] = await artifacts.read(source.outputRef); dependencyRefs[id] = source.outputRef
          }
        }
        const priorOutput = next && nextState.position > ready.position + 1 ? await artifacts.read(state.nodes[nextState.position - 1].outputRef) : output
        const nextInput = next ? await prepareInput(definition, next, state.run.requirementRef, priorOutput, dependencies, { previousOutput: nextState.position > ready.position + 1 ? state.nodes[nextState.position - 1].outputRef : result.ref, dependencies: dependencyRefs }) : null
        await command(`result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', {
          ...identity, outcome: 'succeeded', outputRef: result.ref, evidenceRefs: [result.ref, ...(engineeringProofRef ? [engineeringProofRef] : [])],
          ...(next ? { nextInput: { nodeId: next.id, inputRef: nextInput.ref, inputDigest: nextInput.digest } } : {}),
        })
      } catch (error) {
        // 已接纳变更/取消使提交失效，由下一轮处理屏障；存储不可用不能派生新动作。
        if (!(await isCurrent(binding))) continue
        if (error instanceof ResultAdmissionError) {
          const diagnosis = await artifacts.put({ kind: 'execution-failure', ...identity, nodeRunId: binding.nodeRunId, phase: error.phase,
            targetNodeId: error.nodeId, code: error.code, message: error.message,
            recovery: classifyExecutionFailure({ code: error.code, phase: error.phase }),
            ...(result ? { producedOutputRef: result.ref } : {}) }, { reference: binding.inputRef })
          await command(`invalid-result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', {
            ...identity, outcome: 'failed', evidenceRefs: [...(result ? [result.ref] : []), diagnosis.ref],
            waitReason: { kind: 'recovery', reference: error.code },
            failure: { code: error.code, phase: error.phase, targetNodeId: error.nodeId } })
          return
        }
        throw error
      }
    }
  }
  return {
    isCurrent,
    inspectNodeRecovery,
    async reviseTaskWorkflow({commandId,taskId,runId,expectedRevision,workflowId,workflowDigest,startNodeId,reason,evidenceRefs=[]}) {
      if(closed||flights.has(runId))throw executionError('EXECUTOR_STILL_ACTIVE')
      const replay=await store.query({kind:'receipt',commandId})
      if(replay){if(replay.result.toDigest!==workflowDigest||replay.result.runId!==runId||replay.result.taskId!==taskId)throw executionError('WORKFLOW_REVISION_CONFLICT');return replay}
      const state=await query(runId),previous=definitionOf(state.run),next=definitionOf({workflowId,workflowDigest})
      const index=state.nodes.findIndex(n=>n.nodeId===startNodeId)
      if(state.run.taskId!==taskId||index<0||typeof reason!=='string'||!reason.trim()
        ||typeof next.ownerContract?.validateRevision!=='function')throw executionError('WORKFLOW_REVISION_NOT_ADMITTED')
      const signature=executionNodeContractDigest
      if(next.nodes.length<=index||state.nodes.slice(0,index).some((n,i)=>n.status!=='succeeded'||n.nodeId!==next.nodes[i].id||signature(previous.nodes[i])!==signature(next.nodes[i])))throw executionError('WORKFLOW_REVISION_PREFIX_CHANGED')
      await next.ownerContract.validateRevision({previous,next,startNodeId,retainedNodeIds:state.nodes.slice(0,index).map(n=>n.nodeId)})
      const first=next.nodes[index],dependencies={},dependencyRefs={}
      for(const id of first.inputDependencies??[]){const node=state.nodes.slice(0,index).find(n=>n.nodeId===id);if(!node?.outputRef)throw executionError('NODE_PREDECESSOR_INCOMPLETE');dependencies[id]=await artifacts.read(node.outputRef);dependencyRefs[id]=node.outputRef}
      const prior=state.nodes[index-1],input=await prepareInput(next,first,state.run.requirementRef,prior?.outputRef?await artifacts.read(prior.outputRef):undefined,dependencies,{previousOutput:prior?.outputRef,dependencies:dependencyRefs})
      const plan=await store.query({kind:'task.plan',taskId})
      const semanticEvidence=await retainedSemanticEvidence(state,previous,next,state.nodes.slice(0,index))
      const evidence=await artifacts.put({...semanticEvidence,kind:'task-workflow-revision',taskId,runId,reason,evidenceRefs,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,previousNodes:state.nodes,retainedNodeIds:state.nodes.slice(0,index).map(n=>n.nodeId)},{reference:state.run.requirementRef})
      return command(commandId,'run.workflow.revise',{taskId,runId,expectedRevision,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,toWorkflowId:workflowId,startNodeId,reason,
        inputRef:input.ref,inputDigest:input.digest,evidenceRef:evidence.ref,expectedRequirementRevision:plan.task.requirementRevision,expectedPlanRevision:plan.task.planRevision,expectedControlRevision:plan.task.controlRevision,
        nodes:next.nodes.map(node=>({nodeId:node.id,nodeVersion:node.version,executor:node.executor}))})
    },
    async updateEngineeringCheckpoint({commandId,runId,expectedRevision,kind,workflowId,workflowDigest,maintenance}) {
      if(closed||flights.has(runId))throw executionError('EXECUTOR_STILL_ACTIVE')
      const replay=await store.query({kind:'receipt',commandId})
      if(replay){if(replay.result.toDigest!==workflowDigest)throw executionError('ENGINEERING_CHECKPOINT_CONFLICT');return replay}
      const state=await query(runId),definition=definitionOf({workflowId,workflowDigest}),plan=await store.query({kind:'task.plan',taskId:state.run.taskId})
      const start=kind==='checks'?'verify-candidate':kind==='local-acceptance'?'define-local-acceptance':null
      const index=definition.nodes.findIndex(node=>node.id===start),node=definition.nodes[index]
      if(index<0||state.nodes.length!==definition.nodes.length||state.nodes.some((item,i)=>item.nodeId!==definition.nodes[i].id))throw executionError('ENGINEERING_CHECKPOINT_NOT_ADMITTED')
      const localPreparation=kind==='local-acceptance'&&state.nodes.find(item=>item.nodeId==='prepare-local-acceptance'&&item.status==='waiting')
      if(localPreparation){
        const current=definitionOf(state.run).nodes.find(item=>item.id===localPreparation.nodeId),next=definition.nodes.find(item=>item.id===localPreparation.nodeId)
        if(localPreparation.waitReason?.reference!=='LOCAL_ACCEPTANCE_PLAN_INVALID'||[current,next].some(item=>item?.executor!=='code'||!(item.allowedEffects.every(effect=>['pure','read'].includes(effect))||item.id==='prepare-local-acceptance'&&item.version==='1'&&item.allowedEffects.length===1&&item.allowedEffects[0]==='workspace.prepare')))throw executionError('ENGINEERING_CHECKPOINT_NOT_ADMITTED')
      }
      const dependencies={}
      for(const id of node.inputDependencies??[]){const prior=state.nodes.find(item=>item.nodeId===id);if(prior?.status!=='succeeded'||!prior.outputRef)throw executionError('NODE_PREDECESSOR_INCOMPLETE');dependencies[id]=await artifacts.read(prior.outputRef)}
      const previous=state.nodes[index-1],input=await prepareInput(definition,node,state.run.requirementRef,previous?.outputRef?await artifacts.read(previous.outputRef):undefined,dependencies)
      const retained=state.nodes.filter(item=>item.position<index || kind==='local-acceptance'&&item.position>index+(['25','26'].includes(definition.version)?0:1)&&item.position<state.nodes.findIndex(node=>node.nodeId==='prepare-local-acceptance')&&item.status==='succeeded')
      const semanticEvidence=await retainedSemanticEvidence(state,definitionOf(state.run),definition,retained)
      const evidence=await artifacts.put({...semanticEvidence,kind:'engineering-checkpoint',mode:kind,runId,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,
        invalidated:state.nodes.slice(index).filter(item=>kind!=='local-acceptance'||item.position<=index+(['25','26'].includes(definition.version)?0:1)||item.status==='ready'||item.nodeId==='prepare-local-acceptance'&&item.status==='waiting').map(item=>({nodeRunId:item.nodeRunId,leaseEpoch:item.leaseEpoch,inputRef:item.inputRef,outputRef:item.outputRef,evidenceRefs:item.evidenceRefs}))},{reference:state.run.requirementRef})
      const receipt=await command(commandId,'run.workflow.checkpoint',{runId,expectedRevision,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,toWorkflowId:workflowId,
        kind,startNodeId:start,inputRef:input.ref,inputDigest:input.digest,evidenceRef:evidence.ref,maintenance,
        expectedRequirementRevision:plan.task.requirementRevision,expectedControlRevision:plan.task.controlRevision,
        nodes:definition.nodes.map(item=>({nodeId:item.id,nodeVersion:item.version,executor:item.executor}))})
      return receipt
    },
    resumeNode: args => resumeAgent(args),
    workflowDefinition(workflowId, digest) {
      if (digest !== undefined) return definitionOf({ workflowId, workflowDigest: digest })
      const definition = definitions.get(workflowId)
      if (!definition) throw executionError('WORKFLOW_NOT_FOUND')
      return definition
    },
    registerWorkflow(input) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const definition = registerDefinition(input, false, true)
      return { id: definition.id, version: definition.version, digest: definition.digest }
    },
    async prepareResetRun({ taskId,runId,workflowId,input }) {
      const definition=definitions.get(workflowId)
      if(!definition) throw executionError('WORKFLOW_NOT_FOUND')
      const requirement=await artifacts.put(input,{taskId}),first=await prepareInput(definition,definition.nodes[0],requirement.ref)
      return {taskId,runId,workflowId,workflowDigest:definition.digest,requirementRef:requirement.ref,nodes:definition.nodes.map((node,index)=>({nodeId:node.id,nodeVersion:node.version,executor:node.executor,inputRef:index?null:first.ref,inputDigest:index?null:first.digest}))}
    },
    async resetTaskExecution({ commandId, args }) {
      return createConfiguredRun(async () => {
        if (closed) throw executionError('CONTROLLER_CLOSED')
        const prior = await store.query({ kind: 'receipt', commandId })
        if (prior) {
          if (prior.result.requestDigest !== args.requestDigest) throw executionError('COMMAND_ID_CONFLICT')
          return prior.result
        }
        // 完整复核新 Run 的登记与占用情况后再冻结；预览及回执重投不创建快照。
        await store.query({ kind: 'task.execution.reset.check', ...args })
        if (args.newRun && configuration) await configuration.snapshot({ runId: args.newRun.runId, workflowId: args.newRun.workflowId })
        return (await command(commandId, 'task.execution.reset', args)).result
      })
    },
    async createRun({ ownerTurnId, commandId, taskId, runId = `run-${executionDigest(commandId)}`, workflowId, input, stageBinding }) {
      return createConfiguredRun(async () => {
        if (closed) throw executionError('CONTROLLER_CLOSED')
        requireId(taskId); requireId(runId)
        let definition, requirementReference
        if (stageBinding) {
          const plan = await store.query({ kind: 'task.plan', taskId })
          const stage = plan?.task.planRevision === stageBinding.planRevision
            ? plan.stages.find(item => item.stageId === stageBinding.stageId) : null
          if (!stage || stage.workflowId !== workflowId)
            throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
          definition = definitionOf(stage)
          requirementReference = stage.requirementRef
        } else definition = definitions.get(workflowId)
        if (!definition) throw executionError('WORKFLOW_NOT_FOUND')
        const requirement = await artifacts.put(input, { taskId, reference: requirementReference })
        const first = await prepareInput(definition, definition.nodes[0], requirement.ref)
        if (configuration) {
          const existing = await query(runId)
          const prior = await store.query({ kind: 'receipt', commandId })
          if (!existing.run && !prior) await configuration.snapshot({ runId, workflowId })
        }
        const receipt = await command(commandId, 'run.create', { taskId, runId, workflowId, workflowDigest: definition.digest, requirementRef: requirement.ref,
          ...(stageBinding ? { stageBinding } : {}),
          nodes: definition.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor, inputRef: index ? null : first.ref, inputDigest: index ? null : first.digest })),
        }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
        if (!ownerTurnId) schedule(runId)
        return { runId, receipt }
      })
    },
    async createTaskPlan({ commandId, taskId, requirementRevision = 1, stages }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      if (!Array.isArray(stages) || !stages.length) throw executionError('TASK_PLAN_STAGES_INVALID')
      const stored = []
      for (const [index, stage] of stages.entries()) {
        const definition = definitions.get(stage.workflowId)
        const dynamic = index > 0 && stage.workflowId === 'task-engineering' && !stage.unavailableReason
        if (!definition && !(index > 0 && stage.unavailableReason) && !dynamic) throw executionError('WORKFLOW_NOT_FOUND')
        if ((index === 0) !== Object.hasOwn(stage, 'input')) throw executionError('TASK_STAGE_INPUT_NOT_BOUND')
        const requirement = index === 0 ? await artifacts.put(stage.input, { taskId }) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: definition?.id ?? requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest, unavailableReason: stage.unavailableReason ?? null,
          requirementRef: requirement?.ref ?? null, gate: stage.gate ?? 'none', ...(stage.sourceCondition ? { sourceCondition: stage.sourceCondition } : {}) })
      }
      return command(commandId, 'task.plan.create', { taskId, requirementRevision, stages: stored })
    },
    async initializeTaskPlan({ ownerTurnId, commandId, taskId, expectedPlanRevision = 0, expectedRequirementRevision,
      expectedControlRevision, stages }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      const plan = await store.query({ kind: 'task.plan', taskId })
      if (!plan || plan.task.planRevision !== 0 || plan.task.requirementRevision !== expectedRequirementRevision)
        throw executionError('TASK_PLAN_STALE')
      if (!Array.isArray(stages) || !stages.length) throw executionError('TASK_PLAN_STAGES_INVALID')
      const stored = []
      for (const [index, stage] of stages.entries()) {
        const definition = definitions.get(stage.workflowId)
        const dynamic = index > 0 && stage.workflowId === 'task-engineering' && !stage.unavailableReason
        if (!definition && !(index > 0 && stage.unavailableReason) && !dynamic) throw executionError('WORKFLOW_NOT_FOUND')
        if ((index === 0) !== Object.hasOwn(stage, 'input')) throw executionError('TASK_STAGE_INPUT_NOT_BOUND')
        const requirement = index === 0 ? await artifacts.put(stage.input, { taskId, reference: plan.task.requirementRef }) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: definition?.id ?? requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: stage.unavailableReason ?? null, requirementRef: requirement?.ref ?? null,
          gate: stage.gate ?? 'none', ...(stage.sourceCondition ? { sourceCondition: stage.sourceCondition } : {}) })
      }
      return command(commandId, 'task.plan.initialize', { taskId, expectedPlanRevision,
        expectedRequirementRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
        stages: stored }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
    },
    async reviseTaskPlan({ ownerTurnId, commandId, taskId, expectedPlanRevision, expectedControlRevision, requirementRevision, affectedFrom, stages }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      const previous = await store.query({ kind: 'task.plan', taskId })
      if (!previous || previous.task.planRevision !== expectedPlanRevision) throw executionError('TASK_PLAN_STALE')
      const stored = []
      for (const [index, stage] of stages.entries()) {
        if (index < affectedFrom && Object.hasOwn(stage, 'input')) throw executionError('TASK_PLAN_PREFIX_INVALID')
        if (index === 0 && affectedFrom === 0 && !Object.hasOwn(stage, 'input')) throw executionError('TASK_STAGE_INPUT_NOT_BOUND')
        if (index > 0 && index >= affectedFrom && Object.hasOwn(stage, 'input')) throw executionError('TASK_STAGE_INPUT_NOT_BOUND')
        const retained = index < affectedFrom ? previous.stages[index] : null
        const definition = retained ? null : definitions.get(stage.workflowId)
        const dynamic = index > 0 && stage.workflowId === 'task-engineering' && !stage.unavailableReason
        if (!retained && !definition && !(index > 0 && stage.unavailableReason) && !dynamic) throw executionError('WORKFLOW_NOT_FOUND')
        if (retained && (retained.stageId !== stage.stageId || retained.workflowId !== stage.workflowId)) throw executionError('TASK_PLAN_PREFIX_INVALID')
        const requirement = index < affectedFrom ? { ref: previous.stages[index]?.requirementRef }
          : index === 0 ? await artifacts.put(stage.input, { taskId, reference: previous.task.requirementRef ?? previous.stages[0]?.requirementRef }) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: retained?.workflowId ?? definition?.id ?? requireId(stage.workflowId),
          workflowDigest: retained ? retained.workflowDigest : stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: retained?.unavailableReason ?? stage.unavailableReason ?? null,
          requirementRef: requirement?.ref ?? null,
          gate: retained?.gate ?? stage.gate ?? 'none', ...((retained?.sourceCondition ?? stage.sourceCondition) ? { sourceCondition: retained?.sourceCondition ?? stage.sourceCondition } : {}) })
      }
      return command(commandId, 'task.plan.revise',
        { taskId, expectedPlanRevision, expectedControlRevision: expectedControlRevision ?? previous.task.controlRevision,
          requirementRevision, affectedFrom, stages: stored }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
    },
    async insertTaskDependency({ ownerTurnId, commandId, taskId, expectedPlanRevision, expectedControlRevision, requirementRevision, stage, beforeStageId }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const definition = definitions.get(stage.workflowId)
      if (!definition || !Object.hasOwn(stage, 'input')) throw executionError('TASK_STAGE_INPUT_NOT_BOUND')
      const input = await artifacts.put(stage.input, { taskId })
      return command(commandId, 'task.plan.insertDependency', { taskId, expectedPlanRevision, expectedControlRevision,
        requirementRevision, beforeStageId, stage: { stageId: stage.stageId, workflowId: definition.id,
          workflowDigest: definition.digest, requirementRef: input.ref, unavailableReason: null,
          gate: 'none', sourceCondition: stage.sourceCondition } }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
    },
    async extendTaskPlan({ ownerTurnId, commandId, taskId, expectedPlanRevision, expectedControlRevision, requirementRevision, stages }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      if (!Array.isArray(stages) || !stages.length) throw executionError('TASK_PLAN_STAGES_INVALID')
      const stored = stages.map(stage => {
        const definition = definitions.get(stage.workflowId)
        const dynamic = stage.workflowId === 'task-engineering' && !stage.unavailableReason
        if (!definition && !stage.unavailableReason && !dynamic) throw executionError('WORKFLOW_NOT_FOUND')
        return { stageId: requireId(stage.stageId), workflowId: requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: stage.unavailableReason ?? null, requirementRef: null, gate: stage.gate ?? 'none', ...(stage.sourceCondition ? { sourceCondition: stage.sourceCondition } : {}) }
      })
      const plan = await store.query({ kind: 'task.plan', taskId })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      return command(commandId, 'task.plan.extend', { taskId, expectedPlanRevision,
        expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision, requirementRevision, stages: stored }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
    },
    async taskPlan(taskId) { return store.query({ kind: 'task.plan', taskId: requireId(taskId) }) },
    async pendingTaskPlans({ limit = 100, beforeSequenceId } = {}) {
      return store.query({ kind: 'task.plans.pending', limit,
        ...(beforeSequenceId === undefined ? {} : { beforeSequenceId }) })
    },
    plannedTaskStageRunId({ taskId, planRevision, stageId, attempt }) {
      return plannedStageRunId(requireId(taskId), planRevision, requireId(stageId), attempt)
    },
    async adoptLegacyTaskPlan({ commandId, taskId, runId, stageId }) {
      return command(commandId, 'task.plan.adopt', {
        taskId: requireId(taskId), runId: requireId(runId), stageId: requireId(stageId),
      })
    },
    async confirmTaskStage({ inputCommandId, commandId, taskId, stageId, planRevision, expectedControlRevision, expectedRequirementRevision, outputRef, confirmation }) {
      const plan = await store.query({ kind: 'task.plan', taskId: requireId(taskId) })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      return command(commandId, 'task.plan.confirm',
        { taskId, planRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
          stageId: requireId(stageId), outputRef, ...(confirmation ? { confirmation } : {}),
          ...(expectedRequirementRevision === undefined ? {} : { expectedRequirementRevision }) }, { ...(inputCommandId ? { inputCommandId } : {}) })
    },
    async bindTaskStageInput({ ownerTurnId, commandId, taskId, planRevision, expectedControlRevision, stageId, predecessorOutputRef, input, workflowId }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const plan = await store.query({ kind: 'task.plan', taskId: requireId(taskId) })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      const requirement = await artifacts.put(input, { taskId, reference: plan.task.requirementRef ?? plan.stages[0]?.requirementRef })
      const definition = workflowId ? definitions.get(workflowId) : null
      if (workflowId && !definition) throw executionError('WORKFLOW_NOT_FOUND')
      return command(commandId, 'task.stage.input.bind', {
        taskId, planRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
        stageId: requireId(stageId),
        predecessorOutputRef, requirementRef: requirement.ref,
        ...(definition ? { workflowId: definition.id, workflowDigest: definition.digest } : {}),
      }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
    },
    async advanceTaskPlan(taskId, { ownerTurnId } = {}) {
      requireId(taskId)
      const plan = await store.query({ kind: 'task.plan', taskId })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      const stage = plan.stages.find(item => !['succeeded', 'invalidated'].includes(item.status))
      if (plan.task.controlState !== 'active') {
        if (stage?.status === 'running' && stage.runId) {
          const state = await query(stage.runId)
          if (state.run?.status === 'succeeded') {
            await command(`stage-complete:${taskId}:${plan.task.planRevision}:${stage.stageId}:${stage.attempt}`,
              'task.stage.complete', { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId, runId: stage.runId })
          } else if (['failed', 'cancelled'].includes(state.run?.status)) {
            await command(`stage-block:${taskId}:${plan.task.planRevision}:${stage.stageId}:${stage.attempt}`,
              'task.stage.block', { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId, runId: stage.runId })
          } else if (plan.task.controlState === 'pausing' && state.run?.status === 'waiting' && state.run.recoveryReason === 'user_pause') {
            await command(`task-control-settle:${taskId}:${plan.task.controlRevision}`, 'task.control.settle',
              { taskId, expectedControlRevision: plan.task.controlRevision })
          } else if (plan.task.controlState === 'cancelling') {
            await this.stop({ commandId: `task-stop:${taskId}:${plan.task.controlRevision}`, runId: stage.runId,
              reason: 'business-task-cancelled' })
          } else if (plan.task.controlState === 'pausing') {
            await this.pause({ commandId: `task-pause:${taskId}:${plan.task.controlRevision}`, runId: stage.runId,
              reason: 'business-task-paused' })
          }
        } else if (['pausing', 'cancelling'].includes(plan.task.controlState)) {
          await command(`task-control-settle:${taskId}:${plan.task.controlRevision}`, 'task.control.settle',
            { taskId, expectedControlRevision: plan.task.controlRevision })
        }
        return store.query({ kind: 'task.plan', taskId })
      }
      if (!stage || stage.status === 'waiting_confirmation' || stage.status === 'blocked') return plan
      if (stage.status === 'running') {
        const state = await query(stage.runId)
        if (state.run?.status === 'queued') {
          if (!ownerTurnId) schedule(stage.runId)
          return plan
        }
        if (state.run?.status === 'waiting' && state.run.recoveryReason === 'controller-restarted') {
          const checkpoint = executionDigest({ revision: state.run.revision,
            nodes: state.nodes.map(node => [node.nodeRunId, node.leaseEpoch, node.status]) })
          await this.recover({ commandId: `stage-recover:${stage.runId}:${checkpoint}`, runId: stage.runId })
          return plan
        }
        if (['failed', 'cancelled'].includes(state.run?.status)) {
          await command(`stage-block:${taskId}:${plan.task.planRevision}:${stage.stageId}:${stage.attempt}`,
            'task.stage.block', { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId, runId: stage.runId })
          return store.query({ kind: 'task.plan', taskId })
        }
        if (state.run?.status !== 'succeeded') return plan
        await command(`stage-complete:${taskId}:${plan.task.planRevision}:${stage.stageId}:${stage.attempt}`,
          'task.stage.complete', { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId, runId: stage.runId })
        return store.query({ kind: 'task.plan', taskId })
      }
      if (stage.status !== 'ready' || !stage.requirementRef) return plan
      const runId = plannedStageRunId(taskId, plan.task.planRevision, stage.stageId, stage.attempt)
      const input = await artifacts.read(stage.requirementRef)
      await this.createRun({
        commandId: `stage-start:${taskId}:${plan.task.planRevision}:${stage.stageId}:${stage.attempt}`,
        taskId, runId, workflowId: stage.workflowId, input, ownerTurnId,
        stageBinding: { planRevision: plan.task.planRevision, stageId: stage.stageId,
          attempt: stage.attempt, expectedControlRevision: plan.task.controlRevision },
      })
      return store.query({ kind: 'task.plan', taskId })
    },
    async controlTask({ commandId, taskId, intent, expectedControlRevision, requirementRevision, authorizationRef }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      if (!['pause', 'cancel', 'resume', 'reopen'].includes(intent)) throw executionError('TASK_CONTROL_INVALID')
      const receipt = await command(commandId, `task.control.${intent}`, { taskId, expectedControlRevision,
        ...(intent === 'reopen' ? { requirementRevision, authorizationRef } : {}) })
      if (['pause', 'cancel'].includes(intent)) {
        const settled = await this.advanceTaskPlan(taskId)
        if (intent === 'pause' && settled.task.controlState === 'pausing') await this.advanceTaskPlan(taskId)
      }
      if (intent === 'resume') {
        const plan = await store.query({ kind: 'task.plan', taskId })
        // A new requirement resumes the Owner, not a historical development run.
        if (plan.task.planRequirementRevision !== plan.task.requirementRevision) return { receipt, plan }
        const stage = plan.stages.find(item => item.status === 'running')
        if (stage?.runId) {
          const state = await query(stage.runId)
          if (state.run?.pauseRequested) await this.resume({ commandId: `task-run-resume:${taskId}:${plan.task.controlRevision}`,
            runId: stage.runId })
        }
        await this.advanceTaskPlan(taskId)
      }
      return { receipt, plan: await store.query({ kind: 'task.plan', taskId }) }
    },
    async controlRun({commandId,...args}) {
      if(closed)throw executionError('CONTROLLER_CLOSED')
      const finishRetirement=async()=>{
        interrupt(args.runId)
        const state=await query(args.runId)
        if(state.run.stopRequested&&state.run.status==='cancelling'&&state.nodes.every(node=>node.drained))await command(commandId+':drained','run.stopped',{runId:args.runId})
        const plan=await this.taskPlan(args.taskId)
        if(plan.stages.some(stage=>stage.runId===args.runId&&stage.status==='running'))await this.advanceTaskPlan(args.taskId)
      }
      const prior=await store.query({kind:'receipt',commandId})
      if(prior) {
        const result=prior.result
        if(result.taskId!==args.taskId||result.runId!==args.runId||result.control?.action!==args.action||result.control?.source!==args.source||result.control?.actorId!==args.actorId||result.control?.reason!==args.reason)throw executionError('NODE_CONTROL_REQUEST_CONFLICT')
        if(args.action==='retire'&&(result.retiredGeneration!==args.generation||result.planRevision!==args.expectedPlanRevision))throw executionError('NODE_CONTROL_REQUEST_CONFLICT')
        if(args.action==='retire')await finishRetirement()
        return prior
      }
      const receipt=await command(commandId,'run.control',args)
      if(args.action==='retire') {
        await finishRetirement()
        return receipt
      }
      if(args.action==='stop') {
        interrupt(args.runId)
        const state=await query(args.runId)
        if(state.run.pauseRequested&&!state.run.stopRequested&&!['succeeded','failed','cancelled'].includes(state.run.status)&&state.nodes.every(node=>node.drained))await command(commandId+':drained','run.paused',{runId:args.runId})
      }
      schedule(args.runId)
      if(args.action==='continue')await this.advanceTaskPlan(args.taskId)
      return receipt
    },
    async controlNode({commandId,taskId,runId,nodeRunId,action,expectedRequirementRevision,expectedControlRevision,generation,leaseEpoch,reason,source='operator',actorId,outputRef,evidenceRefs=[]}, {validateControlledOutput}={}) {
      if(closed)throw executionError('CONTROLLER_CLOSED')
      const prior=await store.query({kind:'receipt',commandId})
      if(prior){if(prior.result.taskId!==taskId||prior.result.runId!==runId||prior.result.nodeRunId!==nodeRunId||prior.result.control?.source!==source||prior.result.control?.actorId!==actorId||prior.result.control?.action!==action||prior.result.control?.outputRef!==(outputRef??null)||prior.result.control?.reason!==reason)throw executionError('NODE_CONTROL_REQUEST_CONFLICT');return prior}
      let state=await query(runId),node=state.nodes.find(item=>item.nodeRunId===nodeRunId)
      if(state.run?.taskId!==taskId||!node||node.generation!==generation||node.leaseEpoch!==leaseEpoch)throw executionError('NODE_CONTROL_STALE')
      if(source==='task-session') {
        const owner=await store.query({kind:'task.owner',taskId})
        if(!owner||owner.status!=='running'||!owner.sessionBound||owner.sessionId!==actorId)throw executionError('WORKFLOW_ACTION_FORBIDDEN')
      }
      // Drain the old execution before granting control. Timeout leaves the pause intact, never implies drained.
      if(flights.has(runId)||state.nodes.some(item=>!item.drained)) {
        await this.pause({commandId:commandId+':pause',runId,reason})
        const started=Date.now()
        while(flights.has(runId)){if(Date.now()-started>45000)throw executionError('NODE_CONTROL_DRAIN_PENDING');await delay(100)}
        state=await query(runId);node=state.nodes.find(item=>item.nodeRunId===nodeRunId)
      }
      const definition=definitionOf(state.run),frozen=definition.nodes[node.position],input=await artifacts.read(node.inputRef)
      let output,nextInput
      if(['reuse','submit-output','skip'].includes(action)) {
        if(action==='skip') {
          // A skip has no fabricated output. Pass a real predecessor only if the next contract accepts it.
          if(node.position===0)throw executionError('NODE_SKIP_INPUT_REQUIRED')
          const previous=state.nodes[node.position-1]
          if(previous.status!=='succeeded'||!previous.outputRef||frozen.allowedEffects.some(item=>!['pure','read'].includes(item)))throw executionError('NODE_SKIP_NOT_APPLICABLE')
          if(definition.nodes.slice(node.position+1).some(item=>item.inputDependencies?.includes(node.nodeId)))throw executionError('NODE_SKIP_REQUIRED_OUTPUT')
          outputRef=previous.outputRef;output=await artifacts.read(outputRef)
        }else{
          if(!outputRef)throw executionError('NODE_CONTROL_OUTPUT_REQUIRED')
          const identity=parseArtifactReference(outputRef),scope=parseArtifactReference(state.run.requirementRef)
          if(identity.logicalTaskId!==scope.logicalTaskId)throw executionError('NODE_CONTROL_OUTPUT_SCOPE_INVALID')
          output=await artifacts.read(outputRef);validate(frozen.outputSchema,output)
          const controlledProof=await validateControlledOutput?.({input:input.data,output,binding:{...node,taskId,runId}})===true
          if(frozen.allowedEffects.includes('github.pr')&&!controlledProof)throw executionError('ENGINEERING_PR_UNCONFIRMED')
          if(action==='reuse'){
            const provenance=await store.query({kind:'node.output.producer',taskId,outputRef})
            if((!provenance||provenance.nodeId!==node.nodeId||provenance.nodeVersion!==node.nodeVersion)&&typeof frozen.validateOutput!=='function'&&!controlledProof)throw executionError('NODE_CONTROL_REUSE_UNPROVEN')
          }
          if(frozen.validateOutput)await frozen.validateOutput({input:input.data,output,binding:{...node,taskId,runId}})
          if(frozen.admitOutput&&(await frozen.admitOutput({input:input.data,output,binding:{...node,taskId,runId},signal:new AbortController().signal}))?.outcome!=='succeeded')throw executionError('NODE_CONTROL_OUTPUT_REJECTED')
          if(isEngineeringEditAgent(definition,frozen)) {
            const effects=(await store.query({kind:'effect.list',runId})).filter(item=>item.nodeRunId===nodeRunId&&item.definition.action==='edit')
            if(!effects.length||effects.some(item=>item.state!=='succeeded')||output.status!=='succeeded')throw executionError('ENGINEERING_TECHNICAL_EXECUTION_INVALID')
          }
        }
        const next=definition.nodes[node.position+1],dependencies={},dependencyRefs={}
        for(const id of next?.inputDependencies??[]){const prior=state.nodes.find(item=>item.nodeId===id&&item.status==='succeeded'&&item.outputRef);if(id===node.nodeId&&action!=='skip'){dependencies[id]=output;dependencyRefs[id]=outputRef}else if(prior){dependencies[id]=await artifacts.read(prior.outputRef);dependencyRefs[id]=prior.outputRef}else throw executionError('NODE_DEPENDENCY_UNAVAILABLE')}
        const prepared=next?await prepareInput(definition,next,state.run.requirementRef,output,dependencies,{previousOutput:outputRef,dependencies:dependencyRefs}):null
        if(prepared)nextInput={nodeId:next.id,inputRef:prepared.ref,inputDigest:prepared.digest}
        evidenceRefs=[...new Set([outputRef,...evidenceRefs])]
      }
      const receipt=await command(commandId,'node.control',{taskId,runId,nodeRunId,generation,leaseEpoch,expectedRequirementRevision,expectedControlRevision,action,source,actorId,reason,...(outputRef?{outputRef,evidenceRefs}:{}),...(nextInput?{nextInput}:{})})
      errors.delete(runId)
      if(action!=='takeover')schedule(runId)
      return receipt
    },
    async continueNode({ commandId, runId, nodeRunId, expectedInputVersion, expectedInputDigest, expectedOutputRef, answer }) {
      const replay=await store.query({kind:'receipt',commandId})
      if(replay){
        if(replay.result.answerDigest!==executionDigest(answer)||replay.result.expectedOutputRef!==expectedOutputRef)throw executionError('NODE_CONTINUATION_CONFLICT')
        schedule(runId);return replay
      }
      if(closed||flights.has(runId))throw executionError('EXECUTOR_STILL_ACTIVE')
      const state=await query(runId),node=state.nodes.find(item=>item.nodeRunId===nodeRunId),definition=definitionOf(state.run)
      if(!node||!definition.nodes[node.position].allowInputContinuation||node.inputDigest!==expectedInputDigest
        ||node.outputRef!==expectedOutputRef||node.waitReason?.reference!=='AGENT_WORK_NEEDS_INPUT')throw executionError('NODE_CONTINUATION_STALE')
      if(!answer||typeof answer.eventId!=='string'||!answer.eventId||typeof answer.answer!=='string'||!answer.answer.trim())throw executionError('NODE_CONTINUATION_INVALID')
      const previous=await artifacts.read(node.inputRef)
      const next={...previous,data:{...previous.data,clarificationAnswers:[...(previous.data.clarificationAnswers??[]),answer]}}
      validate(definition.nodes[node.position].inputSchema,next.data)
      const saved=await artifacts.put(next, { reference: node.inputRef })
      const receipt=await command(commandId,'node.continue',{runId,nodeId:node.nodeId,generation:node.generation,
        leaseEpoch:node.leaseEpoch,inputDigest:expectedInputDigest,expectedInputVersion,inputRef:saved.ref,nextInputDigest:saved.digest,
        expectedOutputRef,eventId:answer.eventId,answerDigest:executionDigest(answer)})
      schedule(runId);return receipt
    },
    async changeInput({ commandId, runId, inputId, sourceKey, input, expectedRevision, repair, repairAdmission, readonlyRecovery }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const state = await query(runId)
      if (repair) {
        const plan = await store.query({ kind: 'task.plan', taskId: repair.taskId })
        const workflowDigest = await validateWorkflowRepairAdmission({ state, plan,
          definition: definitionOf(state.run), repair, input, expectedRevision, store, artifacts, repairAdmission })
        repair = { ...repair, workflowDigest }
      }
      let candidateRepair
      if (repair && state.run.workflowId.startsWith('task-engineering-') && state.nodes.some(node => node.nodeId === 'verify-candidate' && node.status === 'waiting' && node.waitReason?.reference === 'ENGINEERING_VERIFICATION_FAILED')) {
        const node = state.nodes.find(node => node.nodeId === 'inspect-and-propose')
        const previous = node?.inputRef && await artifacts.read(node.inputRef)
        if (!previous?.data || !Array.isArray(previous.data.constraints)) throw executionError('ENGINEERING_REPAIR_CONTEXT_UNAVAILABLE')
        const data = { ...previous.data, constraints: [...input.constraints.map(value => value.replace('当前目录仍为冻结基线，请重新应用完整有效修改并修复失败。', '当前工作区已保留上一轮全部修改，只提交失败所需增量，不重复应用已存在补丁。')), '先读取本Task最新共享诊断与完整检查日志；修复后必须重新执行修改校验和真实构建检查。'] }
        await validate(definitionOf(state.run).nodes.find(item => item.id === node.nodeId).inputSchema, data)
        const saved = await artifacts.put({ ...previous, data }, { reference: state.run.requirementRef })
        candidateRepair = { inputRef: saved.ref, inputDigest: saved.digest }
      }
      const requirement = await artifacts.put(input, { reference: state.run.requirementRef })
      const receipt = await command(commandId, 'input.accept', { runId, inputId, sourceKey, requirementRef: requirement.ref, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(repair ? { repair } : {}), ...(candidateRepair ? { candidateRepair } : {}), ...(readonlyRecovery ? { readonlyRecovery } : {}) })
      if (!receipt.replayed && receipt.result.accepted !== false) { interrupt(runId); schedule(runId) }
      return receipt
    },
    async stop({ commandId, runId, reason }) {
      const receipt = await command(commandId, 'run.stop', { runId, reason })
      interrupt(runId); schedule(runId); return receipt
    },
    async pause({ commandId, runId, reason }) {
      const receipt = await command(commandId, 'run.pause', { runId, reason })
      interrupt(runId)
      const state = await query(runId)
      if (state.run.pauseRequested && !state.run.stopRequested && !['succeeded','failed','cancelled'].includes(state.run.status) && state.nodes.every(node => node.drained))
        await command(`${commandId}:drained`, 'run.paused', { runId })
      schedule(runId); return receipt
    },
    async resume({ commandId, runId }) {
      const receipt = await command(commandId, 'run.resume', { runId })
      schedule(runId); return receipt
    },
    async prepareManagedSession(runId, { maintenance } = {}) {
      if (closed || flights.has(runId)) throw executionError('EXECUTOR_STILL_ACTIVE')
      const currentMaintenance = await store.query({ kind: 'runtime.maintenance' })
      if (!currentMaintenance.active || !maintenance || maintenance.maintenanceId !== currentMaintenance.maintenanceId || maintenance.revision !== currentMaintenance.revision) throw executionError('RUNTIME_MAINTENANCE_STALE')
      const state = await query(runId), definition = definitionOf(state.run)
      if (state.run.recoveryReason === 'stage-dependency') throw executionError('TASK_DEPENDENCY_PENDING')
      const candidates = state.nodes.filter(node => node.executor === 'agent' && node.sessionBound
        && (['ready','running'].includes(node.status) || node.status === 'waiting' && node.waitReason?.reference === 'controller-restarted'))
      if (candidates.length !== 1) throw executionError('NODE_SESSION_REBIND_NOT_ADMITTED')
      return { prepared: await prepareManagedSession(state,candidates[0],definition,maintenance), state: await query(runId) }
    },
    async recover({ commandId, runId }) {
      if (flights.has(runId)) throw executionError('EXECUTOR_STILL_ACTIVE')
      const state = await query(runId), definition = definitionOf(state.run)
      const rebuilding = state.nodes.find(node => node.status === 'waiting' && node.drained && node.waitReason?.reference === 'ENGINEERING_DEVELOPMENT_REBUILD_REQUIRED')
      if (rebuilding && definition.nodes[rebuilding.position]?.rebindOutput) {
        await definition.nodes[rebuilding.position].rebindOutput({ binding: { ...rebuilding, taskId: state.run.taskId, runId }, outputRef: rebuilding.outputRef, controller: { registerWorkflow: input => registerDefinition(input, false, true) } })
        errors.delete(runId); schedule(runId); return
      }
      if (state.run.recoveryReason === 'stage-dependency') throw executionError('TASK_DEPENDENCY_PENDING')
      const objectiveCorrection = await correctLocalPlannerObjective(runId, state)
      if (objectiveCorrection === true || objectiveCorrection === 'already-attempted') return
      const fixtureRetry=await inspectNodeRecovery(runId)
      if(fixtureRetry.repairable&&fixtureRetry.readonlyFixtureRetry){
        const ui=state.nodes.find(n=>n.nodeRunId===fixtureRetry.acceptanceNodeRunId),prepare=state.nodes.find(n=>n.nodeId==='prepare-local-acceptance')
        const output=await artifacts.read(ui.outputRef),oldPrepare=await artifacts.read(prepare.outputRef)
        const retry=await definition.nodes.find(n=>n.id==='prepare-local-acceptance').retryAcceptance(output.localPrepared,{attemptKey:`fixture:${fixtureRetry.fixtureDigest}:${output.localPrepared.identity}`})
        const freshOutput={...oldPrepare,localPrepared:retry},freshArtifact=await artifacts.put(freshOutput,{reference:state.run.requirementRef})
        const uiDefinition=definition.nodes[ui.position],freshInput=await prepareInput(definition,uiDefinition,state.run.requirementRef,freshOutput)
        const prepared={...retry,action:'external',workflowKind:'local-acceptance',taskId:state.run.taskId,runId,generation:state.run.generation,requirementDigest:output.localPrepared.requirementDigest,resourceKey:output.localPrepared.resourceKey}
        const context=await artifacts.put({kind:'readonly-fixture-retry',runId,previousIdentity:output.localPrepared.identity,newIdentity:retry.identity,fixtureDigest:fixtureRetry.fixtureDigest,candidateDigest:retry.candidateDigest,planDigest:retry.planDigest,evidenceRefs:fixtureRetry.evidenceRefs,reason:'Retry the same verified candidate and plan after corrected runner assertions. Failed read-only attempt is clean; retain all seven cases and original failure evidence.'},{reference:state.run.requirementRef})
        const task=(await store.query({kind:'task.plan',taskId:state.run.taskId})).task
        await command(`clean-ui-retry:${runId}:${retry.identity}`,'node.retry-local-acceptance',{runId,expectedRevision:state.run.revision,expectedRequirementRevision:task.requirementRevision,expectedControlRevision:task.controlRevision,nodeRunId:fixtureRetry.nodeRunId,generation:fixtureRetry.generation,leaseEpoch:fixtureRetry.leaseEpoch,inputDigest:fixtureRetry.inputDigest,previousEffectId:fixtureRetry.previousEffectId,prepared,prepareOutputRef:freshArtifact.ref,nextInputRef:freshInput.ref,nextInputDigest:freshInput.digest,contextRef:context.ref})
        schedule(runId);return
      }
      const readonlyRetry=await inspectNodeRecovery(runId)
      if (readonlyRetry.repairable && readonlyRetry.readonlyAcceptanceRetry) {
        const node=state.nodes.find(n=>n.nodeRunId===readonlyRetry.nodeRunId), input=await artifacts.read(node.inputRef)
        const context=await artifacts.put({kind:'readonly-acceptance-identity-recovery',runId,nodeRunId:node.nodeRunId,generation:node.generation,inputDigest:node.inputDigest,evidenceRefs:readonlyRetry.evidenceRefs,reason:'Corrected plan has a new acceptance identity; previous completed readonly receipt remains immutable.'},{reference:node.inputRef})
        await command(`readonly-acceptance-retry:${node.nodeRunId}:${node.inputDigest}`,'node.retry-readonly-acceptance',{runId,expectedRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:node.generation,leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,prepared:{...input.data.localPrepared,requirementDigest:input.data.candidate.requirementDigest},contextRef:context.ref})
        schedule(runId);return
      }
      if (await correctLocalPlan(runId, state) || await correctEditArguments(runId, state)
        || await continueOriginalAgent(runId, state)) return
      await sessions?.cancel(runId)
      // 独占Store已排除旧Controller；这里只排空纯/read原生句柄，不释放外部效果hold。
      for (const node of state.nodes) if (!node.drained && node.leaseEpoch > 0) {
        // 独占控制账不能证明旧操作系统子进程已退出；保留持久未排空屏障。
        if (definition.nodes.find(item => item.id === node.nodeId)?.drainPolicy === 'external-process') {
          const scope = await externalProcessScope?.({ state, node }), proof = scope && await scope.inspect()
          if (!proof?.drained) throw Object.assign(executionError('EXECUTOR_DRAIN_EVIDENCE_REQUIRED'), { processInspection: proof ?? null })
          const evidence = await artifacts.put({ kind: 'external-check-drain-proof', binding: scope.binding, ...proof }, { reference: node.inputRef })
          await command(`process-drained:${node.nodeRunId}:${node.leaseEpoch}`, 'node.drained', { runId, nodeId: node.nodeId, generation: node.generation, leaseEpoch: node.leaseEpoch, evidenceRef: evidence.ref, expectedInputDigest: node.inputDigest })
          return // 只结算原检查排空；由Owner读取中断证据后选择实际修订，不重跑旧命令。
        }
        if (node.executor === 'agent') await sessions?.assertDrained({ ...node, taskId: state.run.taskId })
        await drained(node, 'exclusive-controller-recovery')
      }
      // 已持久接纳的变更或停止优先收口，不能绕过输入屏障再次启动旧输入。
      if (!state.pendingInputCount && !state.run.stopRequested && !state.run.pauseRequested && !state.nodes.some(node => node.status === 'ready')
        && !['succeeded', 'failed', 'cancelled'].includes(state.run.status)) await command(commandId, 'run.recover', { runId })
      schedule(runId)
    },
    async whenIdle(runId) { while (flights.has(runId)) { await flights.get(runId); await Promise.resolve() } return query(runId) },
    async retirePreparedEffect({ runId, effectId, assessmentRef, reason, actorId }) {
      const state = await query(runId), effect = await store.query({ kind: 'effect.get', effectId })
      const assessment = await artifacts.read(assessmentRef)
      if (!state?.run || !effect || effect.runId !== runId || assessment.taskId !== state.run.taskId
        || assessment.runId !== runId || assessment.nodeRunId !== effect.nodeRunId)
        throw executionError('PREPARED_RETIREMENT_ASSESSMENT_SCOPE_INVALID')
      const commandId = `retire-prepared:${effectId}:${executionDigest([assessmentRef,reason])}`
      const replay = await store.query({ kind: 'receipt', commandId })
      if (replay) {
        const prior = replay.result?.effect, proof = prior?.result
        if (prior?.effectId !== effectId || prior.runId !== runId || prior.nodeRunId !== effect.nodeRunId
          || prior.generation !== effect.generation || prior.inputDigest !== effect.inputDigest
          || prior.definitionDigest !== effect.definitionDigest || proof?.reason !== 'PREPARED_POLICY_RETIRED'
          || proof.assessmentRef !== assessmentRef || proof.retirementReason !== reason || proof.actorId !== actorId)
          throw executionError('PREPARED_RETIREMENT_REQUEST_CONFLICT')
        return replay
      }
      const node = state.nodes.find(item => item.nodeRunId === effect.nodeRunId)
      if (!node) throw executionError('PREPARED_RETIREMENT_ASSESSMENT_SCOPE_INVALID')
      return command(commandId, 'effect.retirePrepared', {
        effectId, assessmentRef, reason, actorId, expectedRunRevision: state.run.revision,
        expectedLeaseEpoch: node.leaseEpoch, expectedDefinitionDigest: effect.definitionDigest })
    },
    async state(runId, options) { return { ...await query(runId, options), controllerError: errors.get(runId)?.code ?? errors.get(runId)?.message ?? null } },
    async close() {
      closed = true
      for (const runId of active.keys()) interrupt(runId)
      for (const item of queue.splice(0)) { flights.delete(item.runId); item.deferred.resolve() }
      await Promise.allSettled([...flights.values()]); await sessions?.close()
    },
  }
}
