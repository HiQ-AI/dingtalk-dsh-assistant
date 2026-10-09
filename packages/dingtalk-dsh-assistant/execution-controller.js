import { proveEngineeringNoAdditionalChange } from './task-workflow.js'
import { isTerminalUatBuildFailure } from './execution-delivery.js'
import { setTimeout as delay } from 'node:timers/promises'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { canonicalExecutionJson, executionDigest, executionError } from './execution-artifacts.js'
import { validateWorkflowRepairAdmission } from './task-workflow-contracts.js'
import { classifyExecutionFailure } from './execution-recovery-policy.js'

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
      || Object.keys(contract).some(key => !['id', 'version', 'rulesDigest', 'resultContract', 'readArtifacts', 'validateCompletion', 'inspectRepair', 'prepareRepair'].includes(key)))
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
    if (node.drainPolicy !== undefined && (node.drainPolicy !== 'external-process' || node.executor !== 'code')) throw executionError('NODE_DRAIN_POLICY_INVALID')
    if (!Array.isArray(node.allowedEffects) || !node.allowedEffects.length || node.allowedEffects.some(e => !['pure', 'read', 'git.commit', 'git.push', 'github.pr', 'workspace.prepare', 'workspace.edit', 'external.operation', 'file.write', 'message.send'].includes(e))
      || (node.executor === 'agent' && node.allowedEffects.some(e => !['pure', 'read'].includes(e)))) throw executionError('EFFECT_NOT_ADMITTED')
    if (typeof node.mapInput !== 'function') throw executionError('INPUT_MAPPER_REQUIRED')
    if (node.allowInputContinuation !== undefined && (node.allowInputContinuation !== true || node.executor !== 'agent' || typeof node.admitOutput !== 'function')) throw executionError('NODE_CONTINUATION_INVALID')
    if (node.admitOutput !== undefined && typeof node.admitOutput !== 'function') throw executionError('NODE_ADMISSION_INVALID')
    if (['validateOutput', 'classifyOutputError'].some(key => node[key] !== undefined && typeof node[key] !== 'function')) throw executionError('NODE_ADMISSION_INVALID')
    if (node.executor === 'code' && typeof node.execute !== 'function') throw executionError('CODE_EXECUTOR_REQUIRED')
    if (node.executor === 'agent' && (![node.provider, node.model, node.prompt].every(v => typeof v === 'string' && v.length) || !Array.isArray(node.allowedTools))) throw executionError('AGENT_DEFINITION_INVALID')
    assertSupportedJsonSchema(node.inputSchema); assertSupportedJsonSchema(node.outputSchema)
    return freeze({ ...node, allowedEffects: [...node.allowedEffects], ...(node.allowedTools ? { allowedTools: [...node.allowedTools] } : {}), inputSchema: structuredClone(node.inputSchema), outputSchema: structuredClone(node.outputSchema) })
  })
  const digestInput = (normalizeSource, historicalLimits = false) => ({ id: definition.id, version: definition.version,
    ...(ownerContract ? { ownerContract: { id: ownerContract.id, version: ownerContract.version,
      rulesDigest: ownerContract.rulesDigest ?? null,
      ...(ownerContract.resultContract ? { resultContract: ownerContract.resultContract } : {}),
      ...Object.fromEntries(['readArtifacts', 'validateCompletion', 'inspectRepair', 'prepareRepair']
        .map(key => [key, ownerContract[key] ? normalizeSource(ownerContract[key].toString()) : null])) } } : {}),
    nodes: nodes.map(n => ({
    id: n.id, version: n.version, executor: n.executor, allowedEffects: n.allowedEffects,
    ...(historicalLimits ? { maxSteps: n.maxSteps ?? 32, timeoutMs: n.timeoutMs ?? 120000 } : {}),
    inputSchema: n.inputSchema, outputSchema: n.outputSchema, mapper: normalizeSource(n.mapInput.toString()),
    implementation: n.execute ? normalizeSource(n.execute.toString()) : null, provider: n.provider ?? null, model: n.model ?? null,
    ...(n.reasoningEffort === undefined ? {} : { reasoningEffort: n.reasoningEffort }),
    ...(n.drainPolicy === undefined ? {} : { drainPolicy: n.drainPolicy }),
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
export function createExecutionController({ store, artifacts, sessions, delivery, workflows, historicalWorkflows = [], readTools = [], maxConcurrentRuns = 4 }) {
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) throw executionError('CONTROLLER_CONFIG_INVALID')
  const definitions = new Map(), byDigest = new Map()
  function registerDefinition(input, historical = false, replay = false) {
    const definition = defineExecutionWorkflow(input)
    if (!historical && definitions.has(definition.id)) {
      if (replay && definitions.get(definition.id).digest === definition.digest) return definition
      throw executionError('DUPLICATE_WORKFLOW')
    }
    if (!delivery && definition.nodes.some(node => node.allowedEffects.some(e => !['pure', 'read'].includes(e)))) throw executionError('DELIVERY_ADAPTER_REQUIRED')
    for (const node of definition.nodes) if ((node.allowedTools ?? []).some(name => !readTools.includes(name))) throw executionError('TOOL_NOT_ADMITTED')
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
  function definitionOf(run) {
    const definition = byDigest.get(run.workflowDigest)
    if (!definition || definition.id !== run.workflowId) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
    return run.workflowDigest === definition.digest ? definition : { ...definition, digest: run.workflowDigest }
  }
  async function inspectNodeRecovery(runId, suppliedState) {
    const state = suppliedState ?? await query(runId, { includeRecovery: true })
    const recovery = state.nodeRecovery
    if (!recovery) throw executionError('WORKFLOW_RECOVERY_SNAPSHOT_MISSING')
    if (!recovery.repairable) return recovery
    if (closed || flights.has(runId)) return { ...recovery, repairable: false, reason: 'executor-still-active' }
    const definition = definitionOf(state.run)
    const node = state.nodes.find(item => item.nodeRunId === recovery.nodeRunId), frozen = node && definition.nodes[node.position]
    if (!frozen || frozen.executor !== 'agent' || frozen.allowedEffects.some(effect => !['pure','read'].includes(effect)))
      return { ...recovery, repairable: false, reason: 'node-effects-not-readonly' }
    if (recovery.validationNodeRunId) {
      const validation = state.nodes.find(item => item.nodeRunId === recovery.validationNodeRunId)
      const validator = validation && definition.nodes[validation.position]
      if (validation?.position !== node.position + 1 || validation.leaseEpoch !== recovery.validationLeaseEpoch
        || validation.inputDigest !== recovery.validationInputDigest || validator?.executor !== 'code'
        || validator.allowedEffects.some(effect => effect !== 'pure'))
        return { ...recovery, repairable: false, reason: 'proposal-validation-not-pure' }
      const validationInput = await artifacts.read(validation.inputRef), proposal = await artifacts.read(node.outputRef)
      if (executionDigest(validationInput) !== validation.inputDigest || validationInput.workflowDigest !== definition.digest
        || validationInput.nodeId !== validation.nodeId || executionDigest(validationInput.data) !== executionDigest(proposal))
        return { ...recovery, repairable: false, reason: 'proposal-validation-input-mismatch' }
    }
    const input = await artifacts.read(node.inputRef)
    if (executionDigest(input) !== node.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== node.nodeId)
      return { ...recovery, repairable: false, reason: 'node-input-identity-mismatch' }
    return recovery
  }
  async function prepareInput(definition, node, requirementRef, previousOutput, dependencyOutputs = {}) {
    const requirement = await artifacts.read(requirementRef)
    const data = await admitResult('input-mapping', node.id,
      () => node.mapInput({ requirement, previousOutput, dependencyOutputs }))
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
      if (!ready) return
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
      let input, engineeringProofRef, output, submitted = false, failure, outcome
      try {
        input = await artifacts.read(binding.inputRef)
        if (executionDigest(input) !== binding.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== ready.nodeId) throw executionError('NODE_INPUT_IDENTITY_MISMATCH')
        validate(nodeDefinition.inputSchema, input.data)
        if (nodeDefinition.executor === 'code') {
          abort.signal.throwIfAborted()
          if (!await isCurrent(binding)) throw executionError('NODE_STALE')
          abort.signal.throwIfAborted()
          output = await nodeDefinition.execute({ input: structuredClone(input.data), signal: abort.signal, runId: binding.runId,
            taskId: binding.taskId, nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
            perform: async ({ action, prepared }) => {
              if (!nodeDefinition.allowedEffects.includes(action === 'workspace' ? 'workspace.prepare' : action === 'edit' ? 'workspace.edit' : action === 'pr' ? 'github.pr' : action === 'external' ? 'external.operation' : ['file', 'artifact'].includes(action) ? 'file.write' : action === 'message' ? 'message.send' : `git.${action}`) || !delivery) throw executionError('EFFECT_NOT_ADMITTED')
              abort.signal.throwIfAborted()
              const effect = await delivery.execute({ binding, action, prepared }, { signal: abort.signal })
              if (isTerminalUatBuildFailure(effect)) throw Object.assign(executionError('RELEASE_PIPELINE_FAILED'), { terminalEffect: effect })
              if (effect.unsentRecovery) throw executionError('PR_CONNECTION_FAILED')
              if (effect.state !== 'succeeded') throw executionError('DELIVERY_RECONCILIATION_REQUIRED')
              return effect.result.result // 对执行节点交接适配器产出，控制账回执仍单独留存。
            },
          })
          abort.signal.throwIfAborted(); submitted = true
        } else {
          if (!sessions) throw executionError('SESSION_ADAPTER_UNAVAILABLE')
          const agentDefinition = Object.fromEntries(['provider', 'model', 'reasoningEffort', 'prompt', 'allowedTools', 'outputSchema'].filter(key => nodeDefinition[key] !== undefined).map(key => [key, nodeDefinition[key]]))
          const recovery = await store.query({ kind: 'node.recovery-context', nodeRunId: binding.nodeRunId,
            inputDigest: binding.inputDigest, leaseEpoch: binding.leaseEpoch })
          outcome = await sessions.run({ binding, input: input.data, definition: agentDefinition,
            ...(recovery ? { recoveryContext: await artifacts.read(recovery.contextRef) } : {}),
            ...(nodeDefinition.validateOutput ? { validateOutput: value => nodeDefinition.validateOutput({ output: value, input: input.data, binding }),
              classifyOutputError: nodeDefinition.classifyOutputError } : {}),
            onSessionBound: () => command(`bound:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.sessionBound', {
              runId, nodeId: ready.nodeId, generation: binding.generation, leaseEpoch: binding.leaseEpoch, sessionId: binding.sessionId,
            }),
            onResult: value => { output = value; submitted = true },
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
            return
          }
          if (disposition?.outcome !== 'succeeded') throw executionError('NODE_ADMISSION_INVALID')
        }
        let nextState = state.nodes[ready.position + 1], retainedSuccessor = false
        if (ready.nodeId === 'plan-local-acceptance' && nextState?.status === 'succeeded') {
          const record = (await store.query({ kind: 'workflow.list' })).find(item => item.digest === state.run.workflowDigest)
          const checkpoint = record?.config?.checkpoint
          const receipt = checkpoint?.kind === 'local-acceptance' && await store.query({ kind: 'receipt', commandId: `engineering-checkpoint:${runId}:${checkpoint.requestId}` })
          if (receipt?.result.toDigest !== state.run.workflowDigest) throw executionError('ENGINEERING_CHECKPOINT_NOT_ADMITTED')
          retainedSuccessor = true
          nextState = state.nodes.find(item => item.position > ready.position && item.status !== 'succeeded')
        }
        const next = nextState && (!retainedSuccessor || nextState.status === 'blocked') ? definition.nodes[nextState.position] : undefined
        const dependencies = {}
        for (const id of next?.inputDependencies ?? []) {
          if (id === ready.nodeId) dependencies[id] = output
          else {
            const source = state.nodes.find(node => node.nodeId === id && node.status === 'succeeded' && node.outputRef)
            if (!source) throw new ResultAdmissionError(executionError('NODE_DEPENDENCY_UNAVAILABLE'), 'input-dependencies', next.id)
            dependencies[id] = await artifacts.read(source.outputRef)
          }
        }
        const priorOutput = next && nextState.position > ready.position + 1 ? await artifacts.read(state.nodes[nextState.position - 1].outputRef) : output
        const nextInput = next ? await prepareInput(definition, next, state.run.requirementRef, priorOutput, dependencies) : null
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
      const evidence=await artifacts.put({kind:'engineering-checkpoint',mode:kind,runId,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,
        invalidated:state.nodes.slice(index).filter(item=>kind!=='local-acceptance'||item.position<=index+1||item.status==='ready'||item.nodeId==='prepare-local-acceptance'&&item.status==='waiting').map(item=>({nodeRunId:item.nodeRunId,leaseEpoch:item.leaseEpoch,inputRef:item.inputRef,outputRef:item.outputRef,evidenceRefs:item.evidenceRefs}))},{reference:state.run.requirementRef})
      const receipt=await command(commandId,'run.workflow.checkpoint',{runId,expectedRevision,fromDigest:state.run.workflowDigest,toDigest:workflowDigest,toWorkflowId:workflowId,
        kind,startNodeId:start,inputRef:input.ref,inputDigest:input.digest,evidenceRef:evidence.ref,maintenance,
        expectedRequirementRevision:plan.task.requirementRevision,expectedControlRevision:plan.task.controlRevision,
        nodes:definition.nodes.map(item=>({nodeId:item.id,nodeVersion:item.version,executor:item.executor}))})
      return receipt
    },
    async resumeNode({ commandId, runId, expectedRevision, nodeRunId, generation, leaseEpoch, inputDigest, contextRef }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const replay = await store.query({ kind: 'receipt', commandId })
      if (replay) {
        const prior = replay.result
        if (prior.runId !== runId || prior.nodeRunId !== nodeRunId || prior.generation !== generation
          || prior.inputDigest !== inputDigest || prior.contextRef !== contextRef || prior.nextLeaseEpoch !== leaseEpoch + 1
          || prior.previousRunRevision !== expectedRevision) throw executionError('NODE_RECOVERY_CONFLICT')
        schedule(runId); return replay
      }
      const recovery = await inspectNodeRecovery(runId)
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
      errors.delete(runId); schedule(runId); return receipt
    },
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
    async createRun({ ownerTurnId, commandId, taskId, runId = `run-${executionDigest(commandId)}`, workflowId, input, stageBinding }) {
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
      const receipt = await command(commandId, 'run.create', { taskId, runId, workflowId, workflowDigest: definition.digest, requirementRef: requirement.ref,
        ...(stageBinding ? { stageBinding } : {}),
        nodes: definition.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor, inputRef: index ? null : first.ref, inputDigest: index ? null : first.digest })),
      }, { ...(ownerTurnId ? { ownerTurnId } : {}) })
      if (!ownerTurnId) schedule(runId)
      return { runId, receipt }
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
      if (['pause', 'cancel'].includes(intent)) await this.advanceTaskPlan(taskId)
      if (intent === 'resume') {
        const plan = await store.query({ kind: 'task.plan', taskId })
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
      interrupt(runId); schedule(runId); return receipt
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
      if (state.run.recoveryReason === 'stage-dependency') throw executionError('TASK_DEPENDENCY_PENDING')
      await sessions?.cancel(runId)
      // 独占Store已排除旧Controller；这里只排空纯/read原生句柄，不释放外部效果hold。
      for (const node of state.nodes) if (!node.drained && node.leaseEpoch > 0) {
        // 独占控制账不能证明旧操作系统子进程已退出；保留持久未排空屏障。
        if (definition.nodes.find(item => item.id === node.nodeId)?.drainPolicy === 'external-process') throw executionError('EXECUTOR_DRAIN_EVIDENCE_REQUIRED')
        if (node.executor === 'agent') await sessions?.assertDrained({ ...node, taskId: state.run.taskId })
        await drained(node, 'exclusive-controller-recovery')
      }
      // 已持久接纳的变更或停止优先收口，不能绕过输入屏障再次启动旧输入。
      if (!state.pendingInputCount && !state.run.stopRequested && !state.run.pauseRequested && !state.nodes.some(node => node.status === 'ready')
        && !['succeeded', 'failed', 'cancelled'].includes(state.run.status)) await command(commandId, 'run.recover', { runId })
      schedule(runId)
    },
    async whenIdle(runId) { while (flights.has(runId)) { await flights.get(runId); await Promise.resolve() } return query(runId) },
    async state(runId, options) { return { ...await query(runId, options), controllerError: errors.get(runId)?.code ?? errors.get(runId)?.message ?? null } },
    async close() {
      closed = true
      for (const runId of active.keys()) interrupt(runId)
      for (const item of queue.splice(0)) { flights.delete(item.runId); item.deferred.resolve() }
      await Promise.allSettled([...flights.values()]); await sessions?.close()
    },
  }
}
