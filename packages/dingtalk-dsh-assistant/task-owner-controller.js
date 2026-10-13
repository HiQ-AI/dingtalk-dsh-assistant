import { createHash, randomUUID } from 'node:crypto'
import { createTaskOwnerSessions } from './task-owner-session.js'
import { projectOwnerContext } from './task-owner-context.js'
import { executionDigest, readTaskMaterials, readTaskMaterialValue, parseArtifactReference } from './execution-artifacts.js'

const error = (code, message = code) => Object.assign(new Error(message), { code })
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** Keep recorded maintenance facts visible after their event watermark was consumed. */
export async function readOwnerMaintenanceConstraints({ taskId, plan, store, artifacts, signal }) {
  const constraints = new Map()
  let cursor = 0
  for (;;) {
    const page = await store.query({ kind: 'task.owner.events', taskId, afterSequenceId: cursor, limit: 200 })
    for (const event of page) {
      signal?.throwIfAborted()
      if (event.eventType !== 'intent.received' || !event.payloadRef) continue
      const fact = await artifacts.read(event.payloadRef)
      if (fact?.kind !== 'constraint' || fact.repairSource?.kind !== 'engineering-maintenance' || !fact.repairSource.sourceRef) continue
      const source = await artifacts.read(fact.repairSource.sourceRef)
      if (source?.kind !== 'engineering-maintenance-constraint' || source.channel !== 'internal-maintenance'
        || source.taskId !== taskId || source.requirementRef !== plan.task.requirementRef
        || !plan.stages.some(stage => stage.stageId === source.stageId && stage.runId === source.runId)) continue
      constraints.set(source.requestId, { eventSeq: event.eventSeq, payloadRef: event.payloadRef,
        sourceRef: fact.repairSource.sourceRef, ...source })
    }
    if (page.length < 200) break
    cursor = page.at(-1).eventSeq
  }
  return [...constraints.values()]
}

/** 当前阶段的成功证明和诊断引用分开；领域扩展只来自冻结定义的受信合同。 */
export async function readTaskOwnerStageArtifacts({ taskId, stages, controller, plan, readStageArtifacts, signal }) {
  const result = []
  for (const stage of stages.filter(item => item.status !== 'invalidated')) {
    signal?.throwIfAborted()
    const state = stage.runId ? await controller.state(stage.runId, { includeRecovery: true }) : null
    if (state && (state.run?.taskId !== taskId || state.run.runId !== stage.runId
      || state.run.workflowId !== stage.workflowId || state.run.workflowDigest !== stage.workflowDigest))
      throw error('TASK_OWNER_STAGE_RUN_MISMATCH')
    const succeeded = stage.status === 'succeeded' && stage.outputRef
    const problemNodes = (state?.nodes ?? []).filter(node => ['waiting', 'failed'].includes(node.status))
    if (!succeeded && !problemNodes.length) continue
    const entry = { stageId: stage.stageId, status: stage.status, outputRef: succeeded ? stage.outputRef : null,
      evidenceRefs: succeeded ? [...(stage.evidenceRefs ?? [])] : [],
      completionEvidenceRefs: succeeded ? [...new Set([stage.outputRef, ...(stage.evidenceRefs ?? [])])] : [] }
    if (succeeded && readStageArtifacts) {
      const extension = await readStageArtifacts({ taskId, stage, state, plan, signal })
      const known = new Set([stage.outputRef, ...(stage.evidenceRefs ?? []),
        ...(state?.nodes ?? []).flatMap(node => [node.outputRef, ...(node.evidenceRefs ?? [])].filter(Boolean))])
      if ([...(extension?.evidenceRefs ?? []), ...(extension?.completionEvidenceRefs ?? []),
        ...(extension?.nodeArtifacts ?? []).map(node => node.artifactRef)].some(ref => !known.has(ref)))
        throw error('TASK_OWNER_ARTIFACT_SCOPE_MISMATCH')
      if (extension?.nodeArtifacts) entry.nodeArtifacts = extension.nodeArtifacts
      if (extension?.domainEvidence !== undefined) entry.domainEvidence = structuredClone(extension.domainEvidence)
      entry.evidenceRefs = [...new Set([...entry.evidenceRefs, ...(extension?.evidenceRefs ?? [])])]
      if (extension?.completionEvidenceRefs) entry.completionEvidenceRefs = extension.completionEvidenceRefs
    }
    if (problemNodes.length) {
      entry.diagnostics = problemNodes.map(node => ({ nodeId: node.nodeId, nodeRunId: node.nodeRunId,
        status: node.status, generation: node.generation, leaseEpoch: node.leaseEpoch, drained: node.drained,
        waitReason: node.waitReason, evidenceRefs: [...(node.evidenceRefs ?? [])] }))
      entry.evidenceRefs = [...new Set([...entry.evidenceRefs,
        ...(state.nodes ?? []).flatMap(node => [node.outputRef, ...(['waiting', 'failed'].includes(node.status) ? node.evidenceRefs ?? [] : [])].filter(Boolean))])]
    }
    result.push(entry)
  }
  return result
}

// Waiting is an observation, not failure. Some existing executors encode approval/input waits as recovery.
const expectedWaitReasons = new Set(['PLUGIN_APPROVAL_PENDING', 'BYTEBASE_APPROVAL_PENDING', 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED',
  'AGENT_WORK_NEEDS_INPUT', 'AGENT_WORK_BLOCKED', 'LOCAL_ACCEPTANCE_CAPABILITY_MISSING', 'ENGINEERING_UAT_ENVIRONMENT_REQUIRED',
  'ENGINEERING_DEVELOPMENT_REBUILD_REQUIRED'])
export function ownerWorkflowObservationType(stage, nodes) {
  if (stage.status === 'waiting_confirmation') return 'workflow.confirmation.required'
  if (nodes.some(node => node.status === 'failed' || node.status === 'waiting' && node.waitReason?.kind === 'recovery'
    && node.waitReason.reference && !expectedWaitReasons.has(node.waitReason.reference))) return 'workflow.failed'
  if (nodes.some(node => node.status === 'waiting')) return 'workflow.waiting'
  return stage.status === 'blocked' ? 'workflow.failed' : 'workflow.succeeded'
}

/** Task 事件唤醒、模型候选、Host 接纳和执行回执的唯一入口。 */
export function createTaskOwnerController({ ctx, store, artifacts, controller, modelConfig, advanceTask,
  authorizeStages, authorizeCompletion, verifyBlocker, prepareInitialStage, inspectCurrentExecution, repairCurrentStage,
  readStageArtifacts, readDeliveryManifest, verifyDeliveryReview, readCurrentSources, readMaterialAccess, validateDataChangeRepairContext, capabilityCatalog = [], workflowCatalog = [], sessionRunner, getWorkspaceDir, tools = [], controlTools = [], prepareQueryInput }) {
  if (!ctx || !store || !artifacts || !controller || typeof modelConfig !== 'function'
    || typeof advanceTask !== 'function' || typeof authorizeStages !== 'function') throw error('TASK_OWNER_CONTROLLER_INVALID')
  let closed = false
  const flights = new Map()
  const dispatchFlights = new Map()
  let dispatchFlight, dispatchRequested = false
  const flightAborts = new Map()
  const sessions = sessionRunner ?? createTaskOwnerSessions({ ctx, getWorkspaceDir, isCurrent: async binding => {
    const owner = await store.query({ kind: 'task.owner', taskId: binding.taskId })
    const plan = await controller.taskPlan(binding.taskId)
    return !!owner && owner.status === 'running' && owner.turnId === binding.turnId
      && owner.leaseEpoch === binding.leaseEpoch && owner.sessionId === binding.sessionId
      && (plan?.task.controlState === 'active' || !!owner.deliveryReview)
      && (binding.requirementRevision === undefined || plan?.task.requirementRevision === binding.requirementRevision)
  } })
  const command = (id, kind, args) => store.command({ id, kind, args })

  async function event({ taskId, eventKey, eventType, payload }) {
    if (closed) throw error('TASK_OWNER_CONTROLLER_CLOSED')
    const artifact = payload === undefined ? null : await artifacts.put(payload, { taskId })
    return command(`owner-event:${eventKey}`, 'task.owner.event', {
      taskId, eventKey, eventType, ...(artifact ? { payloadRef: artifact.ref } : {}),
    })
  }

  async function ensure({ taskId, origin, criteria, sourceKey }) {
    const sessionId = `owner-${key(taskId).slice(0, 40)}`
    await command(`owner-init:${taskId}`, 'task.owner.init', { taskId, sessionId, criteria, sourceKey })
    if (origin) await event({ taskId, eventKey: `task-created-${key(taskId).slice(0, 40)}`,
      eventType: 'task.created', payload: origin })
    return store.query({ kind: 'task.owner', taskId })
  }

  async function observe(taskId) {
    const plan = await controller.taskPlan(taskId)
    if (!plan) return null
    const owner = await store.query({ kind: 'task.owner', taskId })
    if (owner?.eventWatermark === 0) await event({ taskId,
      eventKey: `task-recovered-${key(taskId).slice(0, 40)}`, eventType: 'task.created' })
    const currentExecution = await inspectCurrentExecution?.(taskId, plan)
    for (const stage of plan.stages) {
      const state = ['running', 'blocked'].includes(stage.status) && stage.runId ? await controller.state(stage.runId) : null
      const problemNodes = (state?.nodes ?? []).filter(node => ['waiting', 'failed'].includes(node.status))
      if (!['succeeded', 'blocked', 'waiting_confirmation'].includes(stage.status) && !problemNodes.length) continue
      const eventType = ownerWorkflowObservationType(stage, problemNodes)
      const payload = { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId,
        workflowId: stage.workflowId, status: stage.status, runId: stage.runId,
        outputRef: stage.outputRef, evidenceRefs: stage.evidenceRefs,
        ...(problemNodes.length ? { diagnostics: problemNodes.map(node => ({ nodeId: node.nodeId,
          nodeRunId: node.nodeRunId, generation: node.generation, leaseEpoch: node.leaseEpoch,
          status: node.status, drained: node.drained, waitReason: node.waitReason, evidenceRefs: node.evidenceRefs })) } : {}),
        ...(currentExecution?.stageId === stage.stageId ? { currentExecution } : {}) }
      // 失败诊断或恢复资格发生变化才唤醒；完成阶段沿用稳定身份，轮询不制造新事件。
      const eventIdentity = ['running', 'blocked'].includes(stage.status) ? payload : [taskId, plan.task.planRevision, stage.stageId, stage.status]
      await event({ taskId, eventKey: `${eventType === 'workflow.waiting' ? 'stage-wait' : 'stage'}-${key(eventIdentity).slice(0, 40)}`,
        eventType, payload })
    }
    return plan
  }

  async function snapshot(taskId, claim, signal) {
    signal.throwIfAborted()
    const owner = await store.query({ kind: 'task.owner', taskId })
    const plan = await controller.taskPlan(taskId)
    const events = []
    let cursor = owner.processedWatermark
    for (;;) {
      const page = await store.query({ kind: 'task.owner.events', taskId, afterSequenceId: cursor, limit: 200 })
      const selected = page.filter(item => item.eventSeq <= claim.eventWatermark && item.eventType !== 'query.succeeded')
      for (const item of selected) {
        events.push({ eventSeq: item.eventSeq, eventType: item.eventType, payloadRef: item.payloadRef ?? null })
      }
      if (!page.length || page.at(-1).eventSeq >= claim.eventWatermark) break
      cursor = page.at(-1).eventSeq
    }
    const goal = plan.task.requirementRef ? await artifacts.read(plan.task.requirementRef)
      : plan.stages[0]?.requirementRef ? await artifacts.read(plan.stages[0].requirementRef) : null
    const acceptanceItems = await store.query({ kind: 'task.owner.acceptance', taskId })
    const modelGoal = Array.isArray(goal?.materials) ? { ...goal, materials: await Promise.all(goal.materials.map(async material => ({
      id: material.id, artifactRef: (await artifacts.put(material, { taskId })).ref,
    }))) } : goal
    const result = { taskId, eventWatermark: claim.eventWatermark, goal: modelGoal,
      ...(owner.lastFailure ? { correction: { reason: owner.lastFailure,
        instruction: '此前动作未完整应用；先读取system.recovery事件中的完整诊断、已发生回执及当前状态，仅观察并如实报告；执行故障交原执行会话纠正，不修改既有流程。不得原样重发已执行部分，未知效果先对账，不把内部故障转给业务用户。' } } : {}),
      ...(readCurrentSources ? { currentSources: await readCurrentSources({ taskId, plan, signal }) } : {}),
      maintenanceConstraints: await readOwnerMaintenanceConstraints({ taskId, plan, store, artifacts, signal }),
      acceptanceItems, versions: claim.versions, task: plan.task, stages: plan.stages, events }
    if (!owner.deliveryReview && plan.task.planRevision > 0 && plan.task.planRequirementRevision !== plan.task.requirementRevision) result.planReview = {
      required: true, instruction: '当前计划尚未覆盖当前需求；继续任务须使用advance与planChange.kind=replaceSuffix重评未完成阶段。repairCurrentStage不能替代需求重评，不得编造repairBinding。' }
    if (readMaterialAccess) result.materialAccess = await readMaterialAccess({ taskId, plan, requirement: goal, signal })
    const repairedStages = new Set(plan.stages.filter(stage => stage.status !== 'succeeded'
      && result.materialAccess?.scopeRepairs?.some(repair => repair.runId === stage.runId
        && repair.inputRef === stage.requirementRef)).map(stage => stage.stageId))
    result.stageArtifacts = await readTaskOwnerStageArtifacts({ taskId,
      stages: plan.stages.filter(stage => !repairedStages.has(stage.stageId)), controller, plan, readStageArtifacts, signal })
    result.completionEvidenceRefs = [...new Set(plan.stages.filter(stage => stage.status === 'succeeded')
      .flatMap(stage => [stage.outputRef, ...(stage.evidenceRefs ?? [])]).filter(Boolean))]
    if (repairedStages.size) result.invalidatedDiagnostics = [...repairedStages].map(stageId => ({ stageId,
      reason: '旧调查输入的材料范围遗漏已由Host核验修复；旧失败诊断不再作为当前判断依据，必须用当前材料范围重新读取。' }))
    if (owner.deliveryReview) {
      result.candidateAcceptanceInstructions = 'During this original Owner review, explicitly accept only supported candidate scenarios using wait.candidateAcceptance {scenarioIds,evidenceRefs}. Read the reviewed facts completely and cite their payloadRef. This records candidate acceptance while the task still waits for authorized publication or other required evidence. Do not mark complete until the full user goal, including release readbacks, is achieved. Never infer acceptance from a wait summary, fabricate results, shrink scope, or rerun engineering.'
      result.deliveryReview = owner.deliveryReview
      result.reviewInstructions = '这是用户明确请求的暂停中成果评估；继续原 Owner 会话，工程保持暂停。先读取 deliveryReview.payloadRef 的 Host 回读事实和当前完整需求，逐项判断实际成果是否已满足批准的本地修复及 Draft PR 交付边界。只能 complete/wait/block，不得 advance、重建计划、运行工程或重复发布。缺少旧格式节点回执本身不是重跑理由。测试范围与未验证项必须如实报告。'
      result.completionEvidenceRefs = [owner.deliveryReview.payloadRef]
    }
    const candidateBinding = await store.query({kind:'task.owner.candidate-acceptance',taskId})
    if (candidateBinding?.ref) {
      const acceptance = await artifacts.read(candidateBinding.ref)
      result.candidateAcceptance = {ref:candidateBinding.ref,reviewRef:acceptance.reviewRef,accepted:acceptance.accepted,scenarioIds:acceptance.scenarioIds,businessCompleted:false}
      result.completionEvidenceRefs = [...new Set([...result.completionEvidenceRefs,candidateBinding.ref,acceptance.reviewRef].filter(Boolean))]
    }
    if (readDeliveryManifest && !owner.deliveryReview) {
      const manifest = await readDeliveryManifest({ taskId, plan, requirement: goal, signal })
      result.deliveryManifest = { ref: (await artifacts.put(manifest, { taskId })).ref, complete: manifest.complete,
        missing: manifest.missing, validation: manifest.validation }
    }
    if (inspectCurrentExecution) {
      result.currentExecution = await inspectCurrentExecution(taskId, plan, { signal })
      if (result.currentExecution) {
        result.currentExecution = { ...result.currentExecution, repairable: false, responsibility: 'execution-session' }
        delete result.currentExecution.repairBinding
        delete result.currentExecution.workflowRevisionCapabilities
      }
      if (result.currentExecution?.evidenceRefs?.length && !repairedStages.has(result.currentExecution.stageId)) result.stageArtifacts.push({ stageId: result.currentExecution.stageId, outputRef: null, evidenceRefs: result.currentExecution.evidenceRefs })
    }
    const directories = await artifacts.getTaskDirectories?.(taskId)
    if (directories) result.sharedMaterials = { logicalTaskId: directories.logicalTaskId,
      indexTool: 'task_owner_list_materials', instruction: '材料索引按需分页；history仅供参考，不授予当前执行权限。' }
    result.capabilities = owner.deliveryReview ? [] : capabilityCatalog
    result.workflowCatalog = owner.deliveryReview ? [] : workflowCatalog
    signal.throwIfAborted()
    return result
  }

  async function readTaskEvidence({ taskId, requirementRevision, signal }) {
    const records = await store.query({kind:'task.owner.query-evidence',taskId, ...(requirementRevision !== undefined ? {requirementRevision} : {})})
    const result = []
    for (const record of records) {
      signal?.throwIfAborted()
      const evidence = await artifacts.read(record.artifactRef), execution = evidence?.execution
      if (evidence?.kind !== 'agent-query-evidence' || execution?.kind !== 'task-owner'
        || execution.taskId !== taskId || execution.turnId !== record.turnId || execution.leaseEpoch !== record.leaseEpoch
        || execution.requirementRevision !== record.requirementRevision
        || !evidence.verification?.sourceRefs?.length || evidence.verification.outputDigest !== executionDigest(evidence.result))
        throw error('TASK_OWNER_QUERY_EVIDENCE_INVALID')
      result.push({...record,evidenceRef:record.artifactRef,queryId:evidence.capabilityId,result:evidence.result,evidence})
    }
    const native = await store.query({kind:'task.owner.native-evidence',taskId, ...(requirementRevision !== undefined ? {requirementRevision} : {})})
    const calls = new Map()
    for (const record of native) {
      signal?.throwIfAborted()
      const evidence = await artifacts.read(record.artifactRef), execution = evidence?.execution
      if (evidence?.kind !== 'task-native-execution' || execution?.kind !== 'task-owner'
        || execution.taskId !== taskId || execution.turnId !== record.turnId || execution.leaseEpoch !== record.leaseEpoch
        || execution.requirementRevision !== record.requirementRevision
        || !['started','settled'].includes(evidence.phase) || !evidence.callId || !evidence.toolName
        || evidence.verification?.outputDigest !== executionDigest(evidence.result)
        || evidence.verification?.argumentsDigest !== executionDigest(evidence.arguments)) throw error('TASK_OWNER_NATIVE_EVIDENCE_INVALID')
      const identity = key(execution, evidence.callId)
      const previous = calls.get(identity)
      if (evidence.phase === 'settled' && (!previous || previous.evidence.phase !== 'started'
        || evidence.startedRef !== previous.evidenceRef || evidence.toolName !== previous.evidence.toolName
        || evidence.verification.argumentsDigest !== previous.evidence.verification.argumentsDigest)) throw error('TASK_OWNER_NATIVE_EVIDENCE_INVALID')
      if (evidence.phase === 'started' && previous) throw error('TASK_OWNER_NATIVE_EVIDENCE_INVALID')
      calls.set(identity, {...record,evidenceRef:record.artifactRef,queryId:evidence.toolName,result:evidence.result,evidence})
    }
    result.push(...calls.values())
    return result
  }

  async function drive(taskId) {
    if (closed) throw error('TASK_OWNER_CONTROLLER_CLOSED')
    if (flights.has(taskId)) return flights.get(taskId)
    const abort = new AbortController(), signal = abort.signal
    flightAborts.set(taskId, abort)
    const flight = (async () => {
      const before = await store.query({ kind: 'task.owner', taskId })
      if (!before || before.status !== 'pending' || before.processedWatermark === before.eventWatermark) return null
      if (before.retryAt && Date.now() < Date.parse(before.retryAt)) return null
      if ((await controller.taskPlan(taskId))?.task.controlState !== 'active' && !before.deliveryReview) return null
      if (signal.aborted) return null
      const turnId = `turn-${randomUUID()}`
      let claim
      try {
        claim = (await command(`owner-claim:${turnId}`, 'task.owner.claim', {
          taskId, turnId, expectedLeaseEpoch: before.leaseEpoch,
        })).result
      } catch (cause) {
        if ((cause.code ?? cause.message) === 'MESSAGE_INPUT_PENDING') return null
        throw cause
      }
      const binding = { taskId, turnId, sessionId: claim.sessionId, leaseEpoch: claim.leaseEpoch,
        ownerEpoch: claim.ownerEpoch, sessionBound: claim.sessionBound }
      try {
        signal.throwIfAborted()
        const input = await snapshot(taskId, claim, signal)
        const queryInput = await prepareQueryInput?.({taskId,requirement:await artifacts.read(input.task.requirementRef),origin:input.currentSources,planning:input,binding})
        Object.assign(binding,{kind:'task-owner',requirementRevision:input.task.requirementRevision,
          inputRef:input.task.requirementRef,inputDigest:executionDigest(queryInput ?? input.goal)})
        input.queryEvidence = (await readTaskEvidence({taskId,requirementRevision:binding.requirementRevision,signal}))
          .map(({ artifactRef, evidenceRef, queryId, taskId, turnId, leaseEpoch, requirementRevision, evidence }) =>
            ({ artifactRef, evidenceRef, queryId, taskId, turnId, leaseEpoch, requirementRevision,
              ...(evidence.kind === 'task-native-execution' ? {nativeExecution:{phase:evidence.phase,
                outcome:evidence.phase === 'started' || evidence.cancelled ? 'unknown' : evidence.postExecutionDecision !== 'accept' || evidence.result?.isError ? 'failed' : 'returned',
                instruction:'真实工具回执不等于业务验证；unknown先核对原效果，禁止直接重放。'}} : {}) }))
        input.completionEvidenceRefs = [...new Set([...input.completionEvidenceRefs, ...input.queryEvidence.map(item => item.evidenceRef)])]
        const unreadPages = new Set((input.eventPages ?? []).map(page => page.ref))
        const readableArtifacts = new Set(input.stageArtifacts.flatMap(stage =>
          [stage.outputRef, ...stage.evidenceRefs, ...(stage.nodeArtifacts ?? []).map(node => node.artifactRef)].filter(Boolean)))
        if (input.deliveryReview) readableArtifacts.add(input.deliveryReview.payloadRef)
        if (input.candidateAcceptance?.ref) readableArtifacts.add(input.candidateAcceptance.ref)
        if (input.candidateAcceptance?.reviewRef) readableArtifacts.add(input.candidateAcceptance.reviewRef)
        if (input.task.requirementRef) readableArtifacts.add(input.task.requirementRef)
        for (const item of input.queryEvidence) readableArtifacts.add(item.artifactRef)
        const projection = await projectOwnerContext(input, artifacts)
        for (const ref of projection.readableRefs) readableArtifacts.add(ref)
        const readArtifacts = new Map()
        if (input.deliveryManifest) readableArtifacts.add(input.deliveryManifest.ref)
        for (const ref of [...input.events.map(event => event.payloadRef), ...(input.goal?.materials ?? []).map(material => material.artifactRef)].filter(Boolean)) readableArtifacts.add(ref)
        let acceptedCompletion, acceptedCandidate
        const materialIndexState = {}
        const nativeCalls = new Map()
        const result = await sessions.run({ binding, input, ...projection, tools: [...tools,...controlTools], queryInput, ...modelConfig(), signal,
          onNativeExecution: async call => {
            const expected = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(name => [name,binding[name]]))
            if (input.deliveryReview || executionDigest(call.binding) !== executionDigest(expected)
              || !['started','settled'].includes(call.phase) || !call.callId || !call.toolName) throw error('TASK_OWNER_NATIVE_EVIDENCE_INVALID')
            const started = nativeCalls.get(call.callId)
            if (call.phase === 'started' ? !!started : !started || started.toolName !== call.toolName
              || started.argumentsDigest !== executionDigest(call.arguments)) throw error('TASK_OWNER_NATIVE_EVIDENCE_INVALID')
            if (call.phase === 'started') signal.throwIfAborted()
            const evidence = { kind:'task-native-execution', execution:expected, callId:call.callId,
              toolName:call.toolName, arguments:call.arguments, phase:call.phase,
              result:call.phase === 'started' ? null : call.result, recordedAt:new Date().toISOString(),
              ...(started ? {startedRef:started.evidenceRef,cancelled:call.cancelled === true,postExecutionDecision:call.postExecutionDecision} : {}),
              verification:{argumentsDigest:executionDigest(call.arguments),outputDigest:executionDigest(call.phase === 'started' ? null : call.result)} }
            const {ref:evidenceRef} = await artifacts.put(evidence,{taskId})
            await command(`owner-native:${turnId}:${key(evidenceRef)}`,'task.owner.native-evidence',{
              taskId,turnId,leaseEpoch:claim.leaseEpoch,requirementRevision:binding.requirementRevision,
              sessionId:binding.sessionId,ownerEpoch:binding.ownerEpoch,evidenceRef})
            if (call.phase === 'started') nativeCalls.set(call.callId,{evidenceRef,toolName:call.toolName,argumentsDigest:evidence.verification.argumentsDigest})
            else nativeCalls.delete(call.callId)
            readableArtifacts.add(evidenceRef)
            readArtifacts.set(evidenceRef,evidence)
            return {evidenceRef}
          },
          listMaterials: input.sharedMaterials ? async ({ cursor = 0, limit = 50 }) => readTaskMaterials({
            directories: await artifacts.getTaskDirectories(taskId), artifacts, requirementRevision: input.task.requirementRevision,
            requirementRef: input.task.requirementRef, indexOffset: cursor, indexLimit: limit, indexState: materialIndexState }) : undefined,
          onPreviouslyReadArtifacts: async refs => {
            const currentRefs = new Set([input.task.requirementRef, ...input.stageArtifacts.flatMap(stage =>
              [stage.outputRef, ...(stage.evidenceRefs ?? []), ...(stage.nodeArtifacts ?? []).map(node => node.artifactRef)])].filter(Boolean))
            for (const ref of refs) if (currentRefs.has(ref)) {
              const parsed = parseArtifactReference(ref)
              if (parsed.logicalTaskId && parsed.logicalTaskId !== (input.sharedMaterials?.logicalTaskId ?? taskId)) continue
              readArtifacts.set(ref, await artifacts.read(ref))
            }
          },
          onQueryEvidence: async ({binding: queryBinding,evidenceRef}) => {
            const evidence = await artifacts.read(evidenceRef)
            const expected = Object.fromEntries(['kind','taskId','sessionId','turnId','leaseEpoch','ownerEpoch','requirementRevision','inputDigest'].map(name => [name,binding[name]]))
            if (executionDigest(queryBinding) !== executionDigest(expected) || executionDigest(evidence?.execution) !== executionDigest(expected)
              || evidence?.kind !== 'agent-query-evidence' || !evidence.verification?.sourceRefs?.length
              || evidence.verification.outputDigest !== executionDigest(evidence.result)) throw error('TASK_OWNER_QUERY_EVIDENCE_INVALID')
            await command(`owner-query:${turnId}:${key(evidenceRef)}`,'task.owner.query-evidence',{
              taskId,turnId,leaseEpoch:claim.leaseEpoch,requirementRevision:binding.requirementRevision,evidenceRef})
            readableArtifacts.add(evidenceRef)
            readArtifacts.set(evidenceRef,evidence)
          },
          readPage: async pageRef => {
            if (!unreadPages.has(pageRef)) throw error('TASK_OWNER_PAGE_NOT_ALLOWED')
            const page = await artifacts.read(pageRef)
            unreadPages.delete(pageRef)
            return page
          },
          readArtifact: async artifactRef => {
            if (input.sharedMaterials && artifactRef === 'task-materials-index') {
              // Compatibility with old sessions: freeze the legacy index once per turn, so character pages cannot drift.
              if (!readArtifacts.has(artifactRef)) readArtifacts.set(artifactRef, await readTaskMaterials({
                directories: await artifacts.getTaskDirectories(taskId), artifacts, requirementRevision: input.task.requirementRevision, requirementRef: input.task.requirementRef }))
              return readArtifacts.get(artifactRef)
            }
            if (input.sharedMaterials && /^(work|tmp|outputs)\//u.test(artifactRef)) {
              const value = await readTaskMaterialValue({ directories: await artifacts.getTaskDirectories(taskId), artifacts, artifactRef })
              readArtifacts.set(artifactRef, value)
              return value
            }
            if (!readableArtifacts.has(artifactRef) && (!input.sharedMaterials || parseArtifactReference(artifactRef).logicalTaskId !== input.sharedMaterials.logicalTaskId)) throw error('TASK_OWNER_ARTIFACT_NOT_ALLOWED')
            const value = await artifacts.read(artifactRef)
            readArtifacts.set(artifactRef, value)
            return value?.encoding === 'base64' && typeof value.data === 'string'
              ? { ...value, text: Buffer.from(value.data, 'base64').toString('utf8') } : value
          },
          onSessionBound: () => command(`owner-bound:${turnId}`, 'task.owner.sessionBound', {
            taskId, turnId, leaseEpoch: claim.leaseEpoch, sessionId: claim.sessionId }),
          onCandidate: async (decision, _binding, toolContext) => {
            if (input.deliveryReview && (!['complete','wait','block'].includes(decision.action) || decision.planChange || decision.appendStages)) throw error('TASK_OWNER_DELIVERY_REVIEW_READ_ONLY')
            if (decision.candidateAcceptance) {
              if (!input.deliveryReview || decision.action !== 'wait' || !readArtifacts.has(input.deliveryReview.payloadRef)
                || typeof verifyDeliveryReview !== 'function' || !await verifyDeliveryReview({taskId,review:input.deliveryReview,decision,signal,candidate:true})) throw error('TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED')
            }
            if (decision.action === 'repairCurrentStage' || decision.workflowRevision !== undefined) throw error('TASK_OWNER_EXECUTION_REPAIR_DISABLED')
            if (input.task.planRevision > 0 && input.task.planRequirementRevision === input.task.requirementRevision
              && (decision.planChange || decision.appendStages?.length)
              && !(decision.planChange?.kind === 'replaceSuffix' && decision.planChange.stages.length === 1
                && decision.planChange.stages[0].preparedInputRef)) throw error('TASK_OWNER_RUNTIME_PLAN_CHANGE_DISABLED')
            if (unreadPages.size) throw error('TASK_OWNER_EVENTS_UNREAD')
            if (['advance', 'repairCurrentStage'].includes(decision.action)) {
              for (const stage of input.stages.filter(stage => stage.runId)) {
                const effects = await store.query({ kind: 'effect.list', runId: stage.runId })
                if (effects.some(effect => !['succeeded', 'failed'].includes(effect.state)))
                  throw error('DELIVERY_RECONCILIATION_REQUIRED', '当前Task仍有未决效果。先回读原effect，不能新建阶段、换身份重发或恢复执行。')
              }
            }

            if (decision.action === 'repairCurrentStage') {
              if (input.currentExecution?.queryContextRequired === true) {
                if (typeof validateDataChangeRepairContext !== 'function') throw error('WORKFLOW_REPAIR_NOT_ADMITTED')
                await validateDataChangeRepairContext({ taskId, stageId: input.currentExecution.stageId, decision, signal })
              }
              const expected = input.currentExecution?.repairBinding
              if (input.currentExecution?.repairable !== true || !expected
                || Object.keys(decision.repair ?? {}).length !== Object.keys(expected).length
                || Object.entries(expected).some(([key, value]) => decision.repair?.[key] !== value))
                throw error('TASK_OWNER_REPAIR_BINDING_INVALID')
              const requiredDiagnostics = input.currentExecution.evidenceRefs
              const allowedRepairEvidence = ref => {
                if (requiredDiagnostics.includes(ref)) return readArtifacts.has(ref)
                if (readArtifacts.has(ref)) {
                  if (ref === input.task.requirementRef || input.stageArtifacts.some(stage =>
                    stage.outputRef === ref || stage.evidenceRefs?.includes(ref) || stage.nodeArtifacts?.some(node => node.artifactRef === ref))) return true
                  const diagnostic = readArtifacts.get(ref)
                  if (input.events.some(event => event.eventType === 'system.recovery' && event.payloadRef === ref)
                    && diagnostic?.kind === 'owner-action-failure' && diagnostic.taskId === taskId
                    && diagnostic.plan?.task?.requirementRevision === binding.requirementRevision
                    && diagnostic.plan?.task?.planRevision === input.task.planRevision
                    && diagnostic.plan?.task?.controlRevision === input.task.controlRevision) return true
                }
                if (input.currentExecution.mode !== 'repair-proposal') return false
                const evidence = readArtifacts.get(ref)
                return evidence?.kind === 'agent-query-evidence'
                  ? evidence.execution?.taskId === taskId && evidence.execution?.requirementRevision === binding.requirementRevision
                  : evidence?.taskId === taskId && evidence.stageId === expected.stageId && evidence.runId === expected.runId
                    && evidence.currentExecution?.repairable === true && executionDigest(evidence.currentExecution.repairBinding) === executionDigest(expected)
              }
              if (!decision.evidenceRefs?.length || !requiredDiagnostics.every(ref =>
                decision.evidenceRefs.includes(ref) && readArtifacts.has(ref))
                || !decision.evidenceRefs.every(allowedRepairEvidence))
                throw error('TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD', '须在本轮读取并引用 currentExecution.evidenceRefs 的全部诊断；额外证据须已通过本轮受信查询或允许的工件读取。')
              if (input.currentExecution.mode === 'resume-agent' && !decision.evidenceRefs.some(ref => {
                const diagnostic = readArtifacts.get(ref), current = input.currentExecution
                const failed = current.validationNodeRunId ? { nodeRunId: current.validationNodeRunId,
                  leaseEpoch: current.validationLeaseEpoch, inputDigest: current.validationInputDigest } : current
                return diagnostic?.kind === 'execution-failure' && diagnostic.runId === current.runId
                  && diagnostic.nodeRunId === failed.nodeRunId && diagnostic.generation === current.generation
                  && diagnostic.leaseEpoch === failed.leaseEpoch && diagnostic.inputDigest === failed.inputDigest
              })) throw error('TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD')
            }
            const proposed = decision.planChange?.stages ?? decision.appendStages
            if (proposed && !await authorizeStages({ taskId, stages: proposed, decision, signal })) throw error('TASK_OWNER_STAGE_NOT_AUTHORIZED')
            if (decision.action === 'complete') {
              // Host 完成验收会重新读取并验证持久查询证据；本轮工具读取记录不是证据有效期。
              if (typeof authorizeCompletion !== 'function' && [...(decision.evidenceRefs ?? []), ...(decision.assessments ?? []).flatMap(item => item.evidenceRefs ?? [])].some(ref => (input.queryEvidence.some(item => item.artifactRef === ref) || readArtifacts.get(ref)?.kind === 'agent-query-evidence') && !readArtifacts.has(ref))) throw error('TASK_OWNER_COMPLETION_EVIDENCE_UNREAD')
              try {
                if (input.deliveryReview ? !readArtifacts.has(input.deliveryReview.payloadRef) || typeof verifyDeliveryReview !== 'function' || !await verifyDeliveryReview({taskId,review:input.deliveryReview,decision,signal}) : !input.stages.length && typeof authorizeCompletion !== 'function' || authorizeCompletion && !await authorizeCompletion({ taskId, decision, signal })) throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
              } catch (cause) {
                delete cause.ownerDiagnosticRef
                if (cause.code === 'TASK_OWNER_COMPLETION_UNVERIFIED' && cause.diagnosticRef) {
                  const diagnostic = await artifacts.read(cause.diagnosticRef)
                  if (diagnostic.kind !== 'domain-acceptance-rejection' || diagnostic.taskId !== taskId
                    || !Array.isArray(diagnostic.evidence) || !diagnostic.evidence.length
                    || diagnostic.evidence.some(item => item.hostCandidate
                      ? item.hostCandidate.taskId !== taskId || item.hostCandidate.requirementRevision !== binding.requirementRevision
                        || item.hostCandidate.accepted !== true || item.hostCandidate.businessCompleted !== false
                        || ![input.candidateAcceptance?.ref, input.candidateAcceptance?.reviewRef].includes(item.evidenceId)
                      : item.hostNativeExecution
                      ? item.hostNativeExecution.taskId !== taskId || item.hostNativeExecution.requirementRevision !== binding.requirementRevision
                        || readArtifacts.get(item.evidenceId)?.kind !== 'task-native-execution'
                          && !input.queryEvidence.some(evidence => evidence.artifactRef === item.evidenceId)
                      : item.hostQuery
                      ? item.hostQuery.taskId !== taskId || item.hostQuery.requirementRevision !== binding.requirementRevision
                        || readArtifacts.get(item.evidenceId)?.kind !== 'agent-query-evidence'
                          && !input.queryEvidence.some(evidence => evidence.artifactRef === item.evidenceId)
                      : item.hostExecution?.taskId !== taskId
                        || !input.stages.some(stage => stage.runId === item.hostExecution.runId && stage.outputRef === item.evidenceId)))
                    throw error('TASK_OWNER_ARTIFACT_SCOPE_MISMATCH')
                  readableArtifacts.add(cause.diagnosticRef)
                  cause.ownerDiagnosticRef = cause.diagnosticRef
                }
                throw cause
              }
            }
            if (!input.deliveryReview && verifyBlocker && ['wait', 'block'].includes(decision.action)
              && ['business-input', 'approval', 'capability', 'permission', 'execution'].includes(decision.condition?.kind)
              && Array.isArray(decision.condition.evidenceRefs)
              && decision.condition.evidenceRefs.every(ref => decision.evidenceRefs?.includes(ref))) {
              const records = await readTaskEvidence({ taskId, requirementRevision: binding.requirementRevision, signal })
              const requested = new Set(decision.evidenceRefs)
              const unknown = [...requested].filter(ref => ref !== input.task.requirementRef
                && !records.some(record => record.evidenceRef === ref || record.artifactRef === ref) && !readArtifacts.has(ref))
              if (unknown.length) throw error('TASK_OWNER_BLOCKER_EVIDENCE_UNREAD',
                `停止依据引用未经当前任务核验：${JSON.stringify(unknown)}。仅使用当前任务提供的引用；可读材料先完整读取，不存在或其他任务的引用应移除，不能凭空补写。`)
              const selected = records.filter(record => requested.has(record.evidenceRef) || requested.has(record.artifactRef))
              for (const record of records.filter(record => record.evidence.kind === 'task-native-execution').slice(-12))
                if (!selected.includes(record)) selected.push(record)
              const evidence = [{ evidenceId: input.task.requirementRef, requirement: input.goal },
                ...selected.map(record => ({ evidenceId: record.evidenceRef, ...record.evidence }))]
              for (const ref of requested) if (!evidence.some(item => item.evidenceId === ref) && readArtifacts.has(ref))
                evidence.push({ evidenceId: ref, artifact: readArtifacts.get(ref) })
              const assessment = await verifyBlocker({ goal: input.goal, currentSources: input.currentSources,
                currentExecution: { execution: input.currentExecution, stages: input.stages }, toolContext,
                evidence, decision }, { signal })
              signal.throwIfAborted()
              if (assessment?.status !== 'external-blocker') {
                const diagnostic = await artifacts.put({ kind: 'owner-blocker-review', taskId,
                  requirementRevision: binding.requirementRevision, turnId, assessment, decision, toolContext,
                  evidenceRefs: evidence.map(item => item.evidenceId) }, { taskId })
                readableArtifacts.add(diagnostic.ref)
                throw Object.assign(error('TASK_OWNER_BLOCKER_UNVERIFIED',
                  `停止依据尚未成立：${assessment?.reason ?? '未获得有效判定'}。由原执行会话继续调查、准备和核验；真实外部阻碍可据新证据再提交。诊断：${diagnostic.ref}`),
                  { ownerDiagnosticRef: diagnostic.ref })
              }
            }
            const digest = decision.action === 'complete' ? executionDigest(decision) : null
            const candidate = await command(`owner-candidate:${turnId}`, 'task.owner.candidate', {
              taskId, turnId, leaseEpoch: claim.leaseEpoch, decision })
            if (digest) acceptedCompletion = { decision, digest }
            if (decision.candidateAcceptance) acceptedCandidate = { decision: structuredClone(decision), digest: executionDigest(decision) }
            return decision.action === 'complete' || decision.candidateAcceptance ? { ...candidate, canonicalDecision: structuredClone(decision) } : candidate
          },
        })
        signal.throwIfAborted()
        if (result.status !== 'submitted') throw error(result.reason ?? 'TASK_OWNER_NO_DECISION')
        const proposedStages = result.decision.planChange?.stages ?? result.decision.appendStages
        if (proposedStages && !await authorizeStages({ taskId, stages: proposedStages, decision: result.decision, signal }))
          throw error('TASK_OWNER_STAGE_NOT_AUTHORIZED')
        // 领域完成验收已在候选提交前实跑；最终清单及事务版本校验防止旧候选接纳。
        signal.throwIfAborted()
        let deliveryManifestRef, candidateAcceptanceRef
        if (result.decision.candidateAcceptance) {
          if (!acceptedCandidate || executionDigest(result.decision) !== acceptedCandidate.digest
            || executionDigest(acceptedCandidate.decision) !== acceptedCandidate.digest) throw error('TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED')
          const acceptance = await verifyDeliveryReview({taskId,review:input.deliveryReview,decision:acceptedCandidate.decision,signal,candidate:true})
          if (acceptance?.kind !== 'task-candidate-acceptance' || acceptance.accepted !== true || acceptance.businessCompleted !== false
            || acceptance.taskId !== taskId) throw error('TASK_OWNER_CANDIDATE_ACCEPTANCE_UNVERIFIED')
          candidateAcceptanceRef = (await artifacts.put(acceptance,{taskId})).ref
        }
        if (result.decision.action === 'complete' && (readDeliveryManifest || input.deliveryReview)) {
          if (!acceptedCompletion || executionDigest(result.decision) !== acceptedCompletion.digest
            || executionDigest(acceptedCompletion.decision) !== acceptedCompletion.digest)
            throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
          const plan = await controller.taskPlan(taskId)
          const requirement = await artifacts.read(plan.task.requirementRef)
          const manifest = input.deliveryReview ? await verifyDeliveryReview({taskId,review:input.deliveryReview,decision:acceptedCompletion.decision,signal,manifest:true})
            : await readDeliveryManifest({ taskId, plan, requirement, decision: acceptedCompletion.decision, signal })
          signal.throwIfAborted()
          if (manifest?.kind !== 'task-delivery-manifest' || manifest.version !== 1 || manifest.complete !== true
              || manifest.businessValidation?.status !== 'accepted'
            || manifest.taskId !== taskId || manifest.requirementRevision !== plan.task.requirementRevision
            || manifest.planRevision !== plan.task.planRevision) throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
          deliveryManifestRef = (await artifacts.put(manifest, { taskId })).ref
        }
        signal.throwIfAborted()
        const accepted = (await command(`owner-accept:${turnId}`, 'task.owner.accept', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, ...(deliveryManifestRef ? { deliveryManifestRef } : {}), ...(candidateAcceptanceRef ? { candidateAcceptanceRef } : {}) })).result
        return accepted
      } catch (cause) {
        await command(`owner-release:${turnId}`, 'task.owner.release', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, reason: signal.aborted ? 'TASK_OWNER_CANDIDATE_STALE'
            : String(cause.code ?? cause.message).slice(0, 200) }).catch(() => {})
        if (signal.aborted) return null
        if (cause.code === 'TASK_OWNER_SESSION_MISSING' && !before.deliveryReview) await command(`owner-replace:${turnId}`,
          'task.owner.replace-session', { taskId, expectedLeaseEpoch: claim.leaseEpoch,
            newSessionId: `owner-${key([taskId, claim.ownerEpoch + 1]).slice(0, 40)}`,
            reason: 'SESSION_NOT_FOUND' })
        throw cause
      }
    })().finally(() => { flights.delete(taskId); flightAborts.delete(taskId) })
    flights.set(taskId, flight)
    return flight
  }

  let applicationFlight
  let applicationRequested = false
  function applyPending() {
    applicationRequested = true
    return applicationFlight ??= (async () => {
      const failures = []
      do {
        applicationRequested = false
        failures.push(...await applyPendingActions())
      } while (applicationRequested && !closed)
      return failures
    })().finally(() => { applicationFlight = undefined })
  }
  async function feedbackApplicationFailure(action, cause) {
    const plan = await controller.taskPlan(action.taskId)
    const receipts = await Promise.all(['owner-plan', 'owner-repair'].map(prefix => store.query({ kind: 'receipt', commandId: `${prefix}:${action.turnId}` })))
    const executions = await Promise.all(plan.stages.filter(stage => stage.runId).map(async stage => ({
      stageId: stage.stageId, state: await controller.state(stage.runId),
      effects: (await store.query({ kind: 'effect.list', runId: stage.runId })).map(effect => ({ effectId: effect.effectId,
        nodeRunId: effect.nodeRunId, inputDigest: effect.inputDigest, state: effect.state, action: effect.definition?.action ?? null,
        evidenceRef: effect.result?.evidenceRef ?? null })),
    })))
    const causes = []
    for (let item = cause; item && !causes.some(saved => saved.original === item); item = item.cause)
      causes.push({ original: item, code: item.code ?? null, message: String(item.message ?? item), stack: item.stack ?? null })
    const diagnostic = await artifacts.put({ kind: 'owner-action-failure', taskId: action.taskId, turnId: action.turnId,
      decision: action.decision, applicationStatus: action.applicationStatus ?? 'pending', errors: causes.map(({ original, ...saved }) => saved), plan,
      receipts: receipts.filter(Boolean), executions,
      instruction: '旧决定已停止应用；先读真实回执和当前状态。已发生的步骤不能重发，未知效果先对账；纠正原因后提出新的具体策略，不把内部故障变成业务补充。' }, { taskId: action.taskId })
    await command(`owner-action-fail:${action.turnId}:${randomUUID()}`, 'task.owner.action.fail', {
      taskId: action.taskId, turnId: action.turnId, leaseEpoch: action.leaseEpoch,
      reason: String(cause.code ?? cause.message).slice(0, 200), diagnosticRef: diagnostic.ref })
  }

  async function applyPendingActions() {
    let afterSequenceId = 0
    const failures = []
    for (;;) {
      const page = await store.query({ kind: 'task.owner.actions.pending', limit: 100, afterSequenceId })
      for (const action of page) {
        const actionPlan = await controller.taskPlan(action.taskId)
        if (action.decision.action === 'repairCurrentStage' || action.decision.workflowRevision !== undefined
          || actionPlan.task.planRevision > 0 && actionPlan.task.planRequirementRevision === actionPlan.task.requirementRevision
            && (action.decision.planChange || action.decision.appendStages?.length)
            && !(action.decision.planChange?.kind === 'replaceSuffix' && action.decision.planChange.stages.length === 1
              && action.decision.planChange.stages[0].preparedInputRef)) {
          await feedbackApplicationFailure(action, error('TASK_OWNER_EXECUTION_REPAIR_DISABLED', '旧未应用的执行修复/动态流程决定已封存；由原执行会话继续，既有成功效果和已应用历史保持。'))
          continue
        }
        if (action.applicationStatus === 'blocked') {
          await feedbackApplicationFailure(action, error(action.lastFailure ?? 'TASK_OWNER_APPLICATION_FAILED',
            '历史决定应用失败；以下原错误码来自持久Owner记录，旧版未保存完整调用栈。不得据此重放旧决定。'))
          continue
        }
        try {
          const { taskId, turnId, decision } = action
          const proposedStages = decision.planChange?.stages ?? decision.appendStages
          const owner = await store.query({ kind: 'task.owner', taskId })
          const currentPlan = await controller.taskPlan(taskId)
          const requirementDelta = currentPlan.task.requirementRef ? 0 : 1
          const priorPlanReceipt = proposedStages?.length
            ? await store.query({ kind: 'receipt', commandId: `owner-plan:${turnId}` }) : null
          if (currentPlan.task.controlState !== 'active' && !(owner.deliveryReview && ['complete','wait','block'].includes(decision.action)) || (!priorPlanReceipt && (owner.eventWatermark !== action.eventWatermark
              || owner.planRevision !== action.planRevision
              || owner.requirementRevision !== action.requirementRevision))
            || priorPlanReceipt && (owner.planRevision !== priorPlanReceipt.result?.planRevision
              || owner.requirementRevision !== action.requirementRevision + requirementDelta)
            || owner.controlRevision !== action.controlRevision
            || owner.authorizationRevision !== action.authorizationRevision
            || owner.inputFenceRevision !== action.inputFenceRevision) {
            await command(`owner-discard:${turnId}`, 'task.owner.discard', {
              taskId, turnId, leaseEpoch: action.leaseEpoch })
            continue
          }
          if (action.retryAt && Date.now() < Date.parse(action.retryAt)) continue
          if (decision.action === 'repairCurrentStage') {
            if (typeof repairCurrentStage !== 'function') throw error('TASK_OWNER_REPAIR_UNAVAILABLE')
            await repairCurrentStage({ taskId, decision, commandId: `owner-repair:${turnId}` })
          }
          if (decision.action === 'advance') {
            if (proposedStages?.length) {
              const plan = currentPlan
              const mode = decision.planChange?.kind ?? (plan.task.planRevision === 0 ? 'initialize'
                : plan.task.status === 'succeeded' ? 'replaceSuffix' : 'append')
              const affectedFrom = decision.planChange?.affectedFrom ?? plan.stages.length
              const stageIdBase = mode === 'replaceSuffix' ? affectedFrom : plan.stages.length
              const stages = proposedStages.map((stage, index) => ({ workflowId: stage.workflowId, gate: stage.gate, ...(stage.sourceCondition ? { sourceCondition: stage.sourceCondition } : {}),
                stageId: `stage-${stageIdBase + index + 1}` }))
              if (!priorPlanReceipt) {
                // Native plan revision atomically checks drain and effects; do not silently strand a stopped no-effect stage.
                const prepared = mode === 'initialize' || mode === 'insertDependency' || mode === 'replaceSuffix' && affectedFrom === 0
                  ? await (prepareInitialStage?.({ taskId, stage: { ...proposedStages[0], stageId: stages[0].stageId }, decision, plan })
                    ?? artifacts.read(plan.task.requirementRef).then(input => ({ input }))) : null
                const initial = prepared ? { ...stages[0], ...prepared } : null
                if (mode === 'insertDependency') {
                  const current = plan.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status))
                  await controller.insertTaskDependency({ commandId: `owner-plan:${turnId}`, ownerTurnId: turnId,
                    taskId, expectedPlanRevision: action.planRevision, expectedControlRevision: action.controlRevision,
                    requirementRevision: action.requirementRevision, beforeStageId: current?.stageId, stage: initial })
                }
                else if (mode === 'initialize') await controller.initializeTaskPlan({
                  commandId: `owner-plan:${turnId}`, ownerTurnId: turnId, taskId, expectedPlanRevision: 0,
                  expectedRequirementRevision: action.requirementRevision,
                  expectedControlRevision: action.controlRevision,
                  stages: [initial, ...stages.slice(1)],
                })
                else if (mode === 'replaceSuffix') {
                  const replacement = affectedFrom === 0
                    ? [initial, ...stages.slice(1)]
                    : stages
                  await controller.reviseTaskPlan({
                  commandId: `owner-plan:${turnId}`, ownerTurnId: turnId, taskId, expectedPlanRevision: action.planRevision,
                  expectedControlRevision: action.controlRevision,
                  requirementRevision: action.requirementRevision + requirementDelta, affectedFrom,
                  stages: [...plan.stages.slice(0, affectedFrom).map(old => ({ stageId: old.stageId,
                    workflowId: old.workflowId, gate: old.gate, ...(old.sourceCondition ? { sourceCondition: old.sourceCondition } : {}) })), ...replacement],
                  })
                }
                else await controller.extendTaskPlan({ commandId: `owner-plan:${turnId}`, ownerTurnId: turnId, taskId,
                  expectedPlanRevision: action.planRevision, expectedControlRevision: action.controlRevision,
                  requirementRevision: action.requirementRevision + requirementDelta, stages })
              }
            }
            await advanceTask(taskId, { ownerTurnId: turnId, ...(proposedStages?.[0]?.preparedInputRef
              ? { preparedInputRef: proposedStages[0].preparedInputRef, sessionId: owner.sessionId } : {}), ...(proposedStages?.[0]?.capabilityStep
              ? { ownerStep: proposedStages[0].capabilityStep } : {}) })
          }
          await command(`owner-applied:${turnId}`, 'task.owner.applied', { taskId, turnId, leaseEpoch: action.leaseEpoch })
          if (decision.action === 'advance' && (await controller.taskPlan(taskId)).stages.some(stage => stage.status === 'running' && stage.runId)) await advanceTask(taskId)
        } catch (cause) {
          await feedbackApplicationFailure(action, cause)
          failures.push({ scope: 'owner-action', taskId: action.taskId, turnId: action.turnId, code: cause.code ?? cause.message })
        }
      }
      if (page.length < 100) break
      afterSequenceId = page.at(-1).sequenceId
    }
    return failures
  }

  function dispatch() {
    if (closed) return Promise.resolve()
    dispatchRequested = true
    return dispatchFlight ??= (async () => {
      do {
        dispatchRequested = false
        let beforeSequenceId
        do {
          const page = await store.query({ kind: 'task.owners.pending', limit: 100,
            ...(beforeSequenceId ? { beforeSequenceId } : {}) })
          for (const item of page) {
            if (closed || dispatchFlights.size >= 4) break
            if (dispatchFlights.has(item.taskId) || flights.has(item.taskId)) continue
            if (item.retryAt && Date.now() < Date.parse(item.retryAt)) continue
            let claimed = false
            const work = (async () => {
              try {
                const result = await drive(item.taskId)
                claimed = result !== null
                return await applyPending()
              }
              catch (cause) { return [{ scope: 'owner', taskId: item.taskId, code: cause.code ?? cause.message }] }
            })().finally(() => {
              dispatchFlights.delete(item.taskId)
              if (!closed && claimed) dispatch().catch(cause => ctx.logger?.warn?.('Task Owner dispatch failed: %s', cause.code ?? cause.message))
            })
            dispatchFlights.set(item.taskId, work)
          }
          beforeSequenceId = page.length === 100 ? page.at(-1).sequenceId : undefined
        } while (!closed && beforeSequenceId && dispatchFlights.size < 4)
      } while (!closed && dispatchRequested && dispatchFlights.size < 4)
    })().finally(() => {
      dispatchFlight = undefined
      if (!closed && dispatchRequested && dispatchFlights.size < 4)
        dispatch().catch(cause => ctx.logger?.warn?.('Task Owner dispatch failed: %s', cause.code ?? cause.message))
    })
  }
  async function recover() {
    const failures = await applyPending()
    await dispatch()
    const results = await Promise.all([...dispatchFlights.values()])
    failures.push(...results.flat(), ...await applyPending())
    return failures
  }

  async function cancel(taskId) {
    flightAborts.get(taskId)?.abort(error('TASK_OWNER_CANCELLED'))
    await sessions.cancel?.(taskId)
    await flights.get(taskId)
  }

  return { ensure, event, observe, drive, dispatch, recover, applyPending, cancel, readTaskEvidence, async close() {
    closed = true
    await dispatchFlight
    for (const abort of flightAborts.values()) abort.abort(error('TASK_OWNER_CONTROLLER_CLOSED'))
    await sessions.close()
    await Promise.allSettled([...flights.values()])
    await Promise.allSettled([...dispatchFlights.values()])
    await applicationFlight
  } }
}
