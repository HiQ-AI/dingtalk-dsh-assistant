import { setTimeout as delay } from 'node:timers/promises'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { canonicalExecutionJson, executionDigest, executionError } from './execution-artifacts.js'

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
const requireId = value => { if (!identifier(value)) throw executionError('INVALID_IDENTIFIER'); return value }
const plannedStageRunId = (taskId, planRevision, stageId, attempt) =>
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

/** 随插件发布的固定顺序定义；函数仅来自受信模块，不接受用户/模型生成代码。 */
export function defineExecutionWorkflow(definition) {
  requireId(definition.id); requireId(definition.version)
  if (!Array.isArray(definition.nodes) || !definition.nodes.length || definition.nodes.length > 32) throw executionError('WORKFLOW_NODE_LIMIT')
  const ids = new Set()
  const nodes = definition.nodes.map(node => {
    requireId(node.id); requireId(node.version)
    if (ids.has(node.id)) throw executionError('DUPLICATE_NODE')
    if (node.inputDependencies !== undefined && (!Array.isArray(node.inputDependencies) || new Set(node.inputDependencies).size !== node.inputDependencies.length
      || node.inputDependencies.some(id => !ids.has(id)))) throw executionError('NODE_DEPENDENCY_INVALID')
    ids.add(node.id)
    if (!['code', 'agent'].includes(node.executor)) throw executionError('EXECUTOR_NOT_ADMITTED')
    if (node.drainPolicy !== undefined && (node.drainPolicy !== 'external-process' || node.executor !== 'code')) throw executionError('NODE_DRAIN_POLICY_INVALID')
    if (!Array.isArray(node.allowedEffects) || !node.allowedEffects.length || node.allowedEffects.some(e => !['pure', 'read', 'git.commit', 'git.push', 'github.pr', 'workspace.prepare', 'workspace.edit', 'external.operation', 'file.write'].includes(e))
      || (node.executor === 'agent' && node.allowedEffects.some(e => !['pure', 'read'].includes(e)))) throw executionError('EFFECT_NOT_ADMITTED')
    if (typeof node.mapInput !== 'function') throw executionError('INPUT_MAPPER_REQUIRED')
    if (node.executor === 'code' && typeof node.execute !== 'function') throw executionError('CODE_EXECUTOR_REQUIRED')
    if (node.executor === 'agent' && (![node.provider, node.model, node.prompt].every(v => typeof v === 'string' && v.length) || !Array.isArray(node.allowedTools))) throw executionError('AGENT_DEFINITION_INVALID')
    assertSupportedJsonSchema(node.inputSchema); assertSupportedJsonSchema(node.outputSchema)
    return freeze({ ...node, allowedEffects: [...node.allowedEffects], ...(node.allowedTools ? { allowedTools: [...node.allowedTools] } : {}), inputSchema: structuredClone(node.inputSchema), outputSchema: structuredClone(node.outputSchema) })
  })
  const digestInput = normalizeSource => ({ id: definition.id, version: definition.version, nodes: nodes.map(n => ({
    id: n.id, version: n.version, executor: n.executor, allowedEffects: n.allowedEffects,
    inputSchema: n.inputSchema, outputSchema: n.outputSchema, mapper: normalizeSource(n.mapInput.toString()),
    implementation: n.execute ? normalizeSource(n.execute.toString()) : null, provider: n.provider ?? null, model: n.model ?? null,
    ...(n.reasoningEffort === undefined ? {} : { reasoningEffort: n.reasoningEffort }),
    ...(n.drainPolicy === undefined ? {} : { drainPolicy: n.drainPolicy }),
    prompt: n.prompt ?? null, allowedTools: n.allowedTools ?? [], rulesDigest: n.rulesDigest ?? null,
    ...(n.inputDependencies ? { inputDependencies: n.inputDependencies } : {}),
    maxSteps: n.maxSteps ?? 32, timeoutMs: n.timeoutMs ?? 120000,
  })) })
  const digest = executionDigest(digestInput(source => source.replace(/\r\n?/g, '\n')))
  const legacyDigests = [executionDigest(digestInput(source => source)),
    executionDigest(digestInput(source => source.replace(/\r\n?|\n/g, '\r\n')))].filter(value => value !== digest)
  return Object.freeze({ id: definition.id, version: definition.version, nodes: Object.freeze(nodes), digest,
    legacyDigests: Object.freeze([...new Set(legacyDigests)]) })
}

/** 一个Controller拥有推进权；等待及状态查询不调用模型，所有身份由控制账产生。 */
export function createExecutionController({ store, artifacts, sessions, delivery, workflows, historicalWorkflows = [], readTools = [], maxConcurrentRuns = 4, changeQuietMs = 2000, maxChangeDelayMs = 10000 }) {
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 32 || !Number.isFinite(changeQuietMs) || changeQuietMs < 0 || maxChangeDelayMs < changeQuietMs) throw executionError('CONTROLLER_CONFIG_INVALID')
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
  const query = runId => store.query({ kind: 'run', runId })
  const command = (id, kind, args) => store.command({ id, kind, args })
  function definitionOf(run) {
    const definition = byDigest.get(run.workflowDigest)
    if (!definition || definition.id !== run.workflowId) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
    return run.workflowDigest === definition.digest ? definition : { ...definition, digest: run.workflowDigest }
  }
  async function prepareInput(definition, node, requirementRef, previousOutput, dependencyOutputs = {}) {
    const requirement = await artifacts.read(requirementRef)
    const data = validate(node.inputSchema, await node.mapInput({ requirement, previousOutput, dependencyOutputs }))
    return artifacts.put({ workflowDigest: definition.digest, nodeId: node.id, nodeVersion: node.version, requirementRef, data })
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
  function schedule(runId) {
    if (closed) return Promise.resolve()
    if (flights.has(runId)) { dirty.add(runId); return flights.get(runId) }
    if (queue.length >= 256) throw executionError('EXECUTION_QUEUE_FULL')
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
    const evidence = await artifacts.put({ nodeRunId: node.nodeRunId, leaseEpoch: node.leaseEpoch, reason })
    await command(`drained:${node.nodeRunId}:${node.leaseEpoch}`, 'node.drained', {
      runId: node.runId, nodeId: node.nodeId, generation: node.generation, leaseEpoch: node.leaseEpoch, evidenceRef: evidence.ref,
    })
  }
  async function applyPending(state, definition) {
    // 先建立屏障并排空旧节点，再短暂合并完整替换输入；最长等待有界。
    const pending = state.inputs.filter(input => input.status === 'pending')
    if (!pending.length) return false
    const first = Date.parse(pending[0].acceptedAt), last = Date.parse(pending.at(-1).acceptedAt)
    const wait = Math.min(last + changeQuietMs, first + maxChangeDelayMs) - Date.now()
    if (wait > 0) { await delay(Math.min(wait, 250)); return true }
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
      if (receipt.result.status === 'budget_exhausted') return
      const binding = { ...receipt.result.binding, taskId: state.run.taskId,
        requirementDigest: executionDigest(await artifacts.read(state.run.requirementRef)) }
      const abort = new AbortController(); active.set(runId, abort)
      let output, submitted = false, failure, outcome
      try {
        const input = await artifacts.read(binding.inputRef)
        if (executionDigest(input) !== binding.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== ready.nodeId) throw executionError('NODE_INPUT_IDENTITY_MISMATCH')
        validate(nodeDefinition.inputSchema, input.data)
        if (nodeDefinition.executor === 'code') {
          abort.signal.throwIfAborted()
          if (!await isCurrent(binding)) throw executionError('NODE_STALE')
          abort.signal.throwIfAborted()
          output = await nodeDefinition.execute({ input: structuredClone(input.data), signal: abort.signal, runId: binding.runId,
            taskId: binding.taskId, nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
            perform: async ({ action, prepared }) => {
              if (!nodeDefinition.allowedEffects.includes(action === 'workspace' ? 'workspace.prepare' : action === 'edit' ? 'workspace.edit' : action === 'pr' ? 'github.pr' : action === 'external' ? 'external.operation' : action === 'file' ? 'file.write' : `git.${action}`) || !delivery) throw executionError('EFFECT_NOT_ADMITTED')
              abort.signal.throwIfAborted()
              const effect = await delivery.execute({ binding, action, prepared })
              if (effect.state !== 'succeeded') throw executionError('DELIVERY_RECONCILIATION_REQUIRED')
              return effect.result.result // 对执行节点交接适配器产出，控制账回执仍单独留存。
            },
          })
          abort.signal.throwIfAborted(); submitted = true
        } else {
          if (!sessions) throw executionError('SESSION_ADAPTER_UNAVAILABLE')
          const agentDefinition = Object.fromEntries(['provider', 'model', 'reasoningEffort', 'prompt', 'allowedTools', 'outputSchema', 'maxSteps', 'timeoutMs'].filter(key => nodeDefinition[key] !== undefined).map(key => [key, nodeDefinition[key]]))
          outcome = await sessions.run({ binding, input: input.data, definition: agentDefinition,
            onSessionBound: () => command(`bound:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.sessionBound', {
              runId, nodeId: ready.nodeId, generation: binding.generation, leaseEpoch: binding.leaseEpoch, sessionId: binding.sessionId,
            }),
            onResult: value => { output = value; submitted = true },
          })
        }
      } catch (error) { failure = error }
      finally { active.delete(runId) }
      if (failure?.executionDrained === false) throw failure
      await drained(binding, 'executor-settled')
      if (!(await isCurrent(binding))) continue
      const identity = { runId, nodeId: ready.nodeId, generation: binding.generation, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest }
      if (failure || !submitted) {
        if (failure) errors.set(runId, failure)
        const evidenceRefs = []
        if (nodeDefinition.executor === 'code' && failure?.code === 'ENGINEERING_VERIFICATION_FAILED' && failure.evidence !== undefined) {
          if (!Array.isArray(failure.evidence) || failure.evidence.length > 128) throw executionError('NODE_FAILURE_EVIDENCE_INVALID')
          for (const payload of failure.evidence) evidenceRefs.push((await artifacts.put(payload)).ref)
        }
        await command(`result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', {
          ...identity, outcome: 'waiting', evidenceRefs, waitReason: { kind: 'recovery', reference: failure?.code ?? (failure ? 'NODE_EXECUTION_FAILED' : outcome?.reason ?? outcome?.status ?? 'NO_NODE_SUBMISSION') },
        })
        return
      }
      try {
        validate(nodeDefinition.outputSchema, output)
        const result = await artifacts.put(output)
        const next = definition.nodes[ready.position + 1]
        const dependencies = {}
        for (const id of next?.inputDependencies ?? []) {
          if (id === ready.nodeId) dependencies[id] = output
          else {
            const source = state.nodes.find(node => node.nodeId === id && node.status === 'succeeded' && node.outputRef)
            if (!source) throw executionError('NODE_DEPENDENCY_UNAVAILABLE')
            dependencies[id] = await artifacts.read(source.outputRef)
          }
        }
        const nextInput = next ? await prepareInput(definition, next, state.run.requirementRef, output, dependencies) : null
        await command(`result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', {
          ...identity, outcome: 'succeeded', outputRef: result.ref, evidenceRefs: [result.ref],
          ...(next ? { nextInput: { nodeId: next.id, inputRef: nextInput.ref, inputDigest: nextInput.digest } } : {}),
        })
      } catch (error) {
        // 已接纳变更/取消使提交失效，由下一轮处理屏障；存储不可用不能派生新动作。
        if (!(await isCurrent(binding))) continue
        if (['NODE_SCHEMA_INVALID', 'ARTIFACT_TOO_LARGE', 'INVALID_JSON_VALUE'].includes(error.code)) {
          await command(`invalid-result:${binding.nodeRunId}:${binding.leaseEpoch}`, 'node.commit', { ...identity, outcome: 'failed', evidenceRefs: [], waitReason: { kind: 'recovery', reference: error.code } })
          return
        }
        throw error
      }
    }
  }
  return {
    isCurrent,
    registerWorkflow(input) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const definition = registerDefinition(input, false, true)
      return { id: definition.id, version: definition.version, digest: definition.digest }
    },
    async createRun({ commandId, taskId, runId = `run-${executionDigest(commandId)}`, workflowId, input, stageBinding }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId); requireId(runId)
      let definition = definitions.get(workflowId)
      if (!definition) throw executionError('WORKFLOW_NOT_FOUND')
      if (stageBinding) {
        const plan = await store.query({ kind: 'task.plan', taskId })
        const stage = plan?.task.planRevision === stageBinding.planRevision
          ? plan.stages.find(item => item.stageId === stageBinding.stageId) : null
        if (!stage || stage.workflowId !== workflowId || ![definition.digest, ...definition.legacyDigests].includes(stage.workflowDigest))
          throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
        if (stage.workflowDigest !== definition.digest) definition = { ...definition, digest: stage.workflowDigest }
      }
      const requirement = await artifacts.put(input)
      const first = await prepareInput(definition, definition.nodes[0], requirement.ref)
      const receipt = await command(commandId, 'run.create', { taskId, runId, workflowId, workflowDigest: definition.digest, requirementRef: requirement.ref,
        ...(stageBinding ? { stageBinding } : {}),
        nodes: definition.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor, inputRef: index ? null : first.ref, inputDigest: index ? null : first.digest })),
      })
      schedule(runId); return { runId, receipt }
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
        const requirement = index === 0 ? await artifacts.put(stage.input) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: definition?.id ?? requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest, unavailableReason: stage.unavailableReason ?? null,
          requirementRef: requirement?.ref ?? null, gate: stage.gate ?? 'none' })
      }
      return command(commandId, 'task.plan.create', { taskId, requirementRevision, stages: stored })
    },
    async initializeTaskPlan({ commandId, taskId, expectedPlanRevision = 0, expectedRequirementRevision,
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
        const requirement = index === 0 ? await artifacts.put(stage.input) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: definition?.id ?? requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: stage.unavailableReason ?? null, requirementRef: requirement?.ref ?? null,
          gate: stage.gate ?? 'none' })
      }
      return command(commandId, 'task.plan.initialize', { taskId, expectedPlanRevision,
        expectedRequirementRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
        stages: stored })
    },
    async reviseTaskPlan({ commandId, taskId, expectedPlanRevision, expectedControlRevision, requirementRevision, affectedFrom, stages }) {
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
          : index === 0 ? await artifacts.put(stage.input) : null
        stored.push({ stageId: requireId(stage.stageId), workflowId: retained?.workflowId ?? definition?.id ?? requireId(stage.workflowId),
          workflowDigest: retained ? retained.workflowDigest : stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: retained?.unavailableReason ?? stage.unavailableReason ?? null,
          requirementRef: requirement?.ref ?? null,
          gate: retained?.gate ?? stage.gate ?? 'none' })
      }
      return command(commandId, 'task.plan.revise',
        { taskId, expectedPlanRevision, expectedControlRevision: expectedControlRevision ?? previous.task.controlRevision,
          requirementRevision, affectedFrom, stages: stored })
    },
    async extendTaskPlan({ commandId, taskId, expectedPlanRevision, expectedControlRevision, requirementRevision, stages }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      requireId(taskId)
      if (!Array.isArray(stages) || !stages.length) throw executionError('TASK_PLAN_STAGES_INVALID')
      const stored = stages.map(stage => {
        const definition = definitions.get(stage.workflowId)
        const dynamic = stage.workflowId === 'task-engineering' && !stage.unavailableReason
        if (!definition && !stage.unavailableReason && !dynamic) throw executionError('WORKFLOW_NOT_FOUND')
        return { stageId: requireId(stage.stageId), workflowId: requireId(stage.workflowId),
          workflowDigest: stage.unavailableReason || dynamic ? null : definition.digest,
          unavailableReason: stage.unavailableReason ?? null, requirementRef: null, gate: stage.gate ?? 'none' }
      })
      const plan = await store.query({ kind: 'task.plan', taskId })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      return command(commandId, 'task.plan.extend', { taskId, expectedPlanRevision,
        expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision, requirementRevision, stages: stored })
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
    async confirmTaskStage({ commandId, taskId, stageId, planRevision, expectedControlRevision, outputRef }) {
      const plan = await store.query({ kind: 'task.plan', taskId: requireId(taskId) })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      return command(commandId, 'task.plan.confirm',
        { taskId, planRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
          stageId: requireId(stageId), outputRef })
    },
    async bindTaskStageInput({ commandId, taskId, planRevision, expectedControlRevision, stageId, predecessorOutputRef, input, workflowId }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const plan = await store.query({ kind: 'task.plan', taskId: requireId(taskId) })
      if (!plan) throw executionError('TASK_PLAN_NOT_FOUND')
      const requirement = await artifacts.put(input)
      const definition = workflowId ? definitions.get(workflowId) : null
      if (workflowId && !definition) throw executionError('WORKFLOW_NOT_FOUND')
      return command(commandId, 'task.stage.input.bind', {
        taskId, planRevision, expectedControlRevision: expectedControlRevision ?? plan.task.controlRevision,
        stageId: requireId(stageId),
        predecessorOutputRef, requirementRef: requirement.ref,
        ...(definition ? { workflowId: definition.id, workflowDigest: definition.digest } : {}),
      })
    },
    async advanceTaskPlan(taskId) {
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
          schedule(stage.runId)
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
        taskId, runId, workflowId: stage.workflowId, input,
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
    async changeInput({ commandId, runId, inputId, sourceKey, input, expectedRevision }) {
      if (closed) throw executionError('CONTROLLER_CLOSED')
      const requirement = await artifacts.put(input)
      const receipt = await command(commandId, 'input.accept', { runId, inputId, sourceKey, requirementRef: requirement.ref, ...(expectedRevision === undefined ? {} : { expectedRevision }) })
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
    async recover({ commandId, runId }) {
      if (flights.has(runId)) throw executionError('EXECUTOR_STILL_ACTIVE')
      const state = await query(runId); const definition = definitionOf(state.run)
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
    async state(runId) { return { ...await query(runId), controllerError: errors.get(runId)?.code ?? errors.get(runId)?.message ?? null } },
    async close() {
      closed = true
      for (const runId of active.keys()) interrupt(runId)
      for (const item of queue.splice(0)) { flights.delete(item.runId); item.deferred.resolve() }
      await Promise.allSettled([...flights.values()]); await sessions?.close()
    },
  }
}
