import { createHash, randomUUID } from 'node:crypto'
import { createTaskOwnerSessions } from './task-owner-session.js'
import { executionDigest, readTaskMaterials, readTaskMaterialValue, parseArtifactReference } from './execution-artifacts.js'

const error = (code, message = code) => Object.assign(new Error(message), { code })
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

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

/** Task 事件唤醒、模型候选、Host 接纳和执行回执的唯一入口。 */
export function createTaskOwnerController({ ctx, store, artifacts, controller, modelConfig, advanceTask,
  authorizeStages, authorizeCompletion, prepareInitialStage, inspectCurrentExecution, repairCurrentStage,
  readStageArtifacts, readDeliveryManifest, readCurrentSources, readMaterialAccess, validateDataChangeRepairContext, capabilityCatalog = [], workflowCatalog = [], sessionRunner, getWorkspaceDir, tools = [], prepareQueryInput }) {
  if (!ctx || !store || !artifacts || !controller || typeof modelConfig !== 'function'
    || typeof advanceTask !== 'function' || typeof authorizeStages !== 'function') throw error('TASK_OWNER_CONTROLLER_INVALID')
  let closed = false
  const flights = new Map()
  const dispatchFlights = new Map()
  let dispatchFlight, dispatchRequested = false
  const flightAborts = new Map()
  const sessions = sessionRunner ?? createTaskOwnerSessions({ ctx, getWorkspaceDir, isCurrent: async binding => {
    const owner = await store.query({ kind: 'task.owner', taskId: binding.taskId })
    return !!owner && owner.status === 'running' && owner.turnId === binding.turnId
      && owner.leaseEpoch === binding.leaseEpoch && owner.sessionId === binding.sessionId
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
      const eventType = stage.status === 'waiting_confirmation' ? 'workflow.confirmation.required'
        : stage.status === 'blocked' || problemNodes.length ? 'workflow.failed' : 'workflow.succeeded'
      const payload = { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId,
        workflowId: stage.workflowId, status: stage.status, runId: stage.runId,
        outputRef: stage.outputRef, evidenceRefs: stage.evidenceRefs,
        ...(problemNodes.length ? { diagnostics: problemNodes.map(node => ({ nodeId: node.nodeId,
          nodeRunId: node.nodeRunId, generation: node.generation, leaseEpoch: node.leaseEpoch,
          status: node.status, drained: node.drained, waitReason: node.waitReason, evidenceRefs: node.evidenceRefs })) } : {}),
        ...(currentExecution?.stageId === stage.stageId ? { currentExecution } : {}) }
      // 失败诊断或恢复资格发生变化才唤醒；完成阶段沿用稳定身份，轮询不制造新事件。
      const eventIdentity = ['running', 'blocked'].includes(stage.status) ? payload : [taskId, plan.task.planRevision, stage.stageId, stage.status]
      await event({ taskId, eventKey: `stage-${key(eventIdentity).slice(0, 40)}`,
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
        instruction: '此前动作未能执行；根据当前状态修正参数或计划后继续，不要原样重复失败动作。' } } : {}),
      ...(readCurrentSources ? { currentSources: await readCurrentSources({ taskId, plan, signal }) } : {}),
      acceptanceItems, versions: claim.versions, task: plan.task, stages: plan.stages, events }
    if (plan.task.planRevision > 0 && plan.task.planRequirementRevision !== plan.task.requirementRevision) result.planReview = {
      required: true, instruction: '当前计划尚未覆盖当前需求；继续任务须使用advance与planChange.kind=replaceSuffix重评未完成阶段。repairCurrentStage不能替代需求重评，不得编造repairBinding。' }
    if (readMaterialAccess) result.materialAccess = await readMaterialAccess({ taskId, plan, requirement: goal, signal })
    const repairedStages = new Set(plan.stages.filter(stage => stage.status !== 'succeeded'
      && result.materialAccess?.scopeRepairs?.some(repair => repair.runId === stage.runId
        && repair.inputRef === stage.requirementRef)).map(stage => stage.stageId))
    result.stageArtifacts = await readTaskOwnerStageArtifacts({ taskId,
      stages: plan.stages.filter(stage => !repairedStages.has(stage.stageId)), controller, plan, readStageArtifacts, signal })
    if (repairedStages.size) result.invalidatedDiagnostics = [...repairedStages].map(stageId => ({ stageId,
      reason: '旧调查输入的材料范围遗漏已由Host核验修复；旧失败诊断不再作为当前判断依据，必须用当前材料范围重新读取。' }))
    if (readDeliveryManifest) {
      const manifest = await readDeliveryManifest({ taskId, plan, requirement: goal, signal })
      result.deliveryManifest = { ref: (await artifacts.put(manifest, { taskId })).ref, complete: manifest.complete,
        missing: manifest.missing, validation: manifest.validation }
    }
    if (inspectCurrentExecution) {
      result.currentExecution = await inspectCurrentExecution(taskId, plan, { signal })
      if (result.currentExecution?.evidenceRefs?.length && !repairedStages.has(result.currentExecution.stageId)) result.stageArtifacts.push({ stageId: result.currentExecution.stageId, outputRef: null, evidenceRefs: result.currentExecution.evidenceRefs })
    }
    const directories = await artifacts.getTaskDirectories?.(taskId)
    if (directories) result.sharedMaterials = await readTaskMaterials({ directories, artifacts, requirementRevision: plan.task.requirementRevision, requirementRef: plan.task.requirementRef })
    result.capabilities = capabilityCatalog
    result.workflowCatalog = workflowCatalog
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
      if ((await controller.taskPlan(taskId))?.task.controlState !== 'active') return null
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
          .map(({ artifactRef, evidenceRef, queryId, taskId, turnId, leaseEpoch, requirementRevision }) =>
            ({ artifactRef, evidenceRef, queryId, taskId, turnId, leaseEpoch, requirementRevision }))
        const unreadPages = new Set((input.eventPages ?? []).map(page => page.ref))
        const readableArtifacts = new Set(input.stageArtifacts.flatMap(stage =>
          [stage.outputRef, ...stage.evidenceRefs, ...(stage.nodeArtifacts ?? []).map(node => node.artifactRef)].filter(Boolean)))
        for (const item of input.queryEvidence) readableArtifacts.add(item.artifactRef)
        const readArtifacts = new Map()
        if (input.deliveryManifest) readableArtifacts.add(input.deliveryManifest.ref)
        for (const ref of [...input.events.map(event => event.payloadRef), ...(input.goal?.materials ?? []).map(material => material.artifactRef)].filter(Boolean)) readableArtifacts.add(ref)
        let acceptedCompletion
        const result = await sessions.run({ binding, input, tools, queryInput, ...modelConfig(), signal,
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
            if (input.sharedMaterials && artifactRef === 'task-materials-index') return readTaskMaterials({
              directories: await artifacts.getTaskDirectories(taskId), artifacts, requirementRevision: input.task.requirementRevision, requirementRef: input.task.requirementRef })
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
          onCandidate: async decision => {
            if (unreadPages.size) throw error('TASK_OWNER_EVENTS_UNREAD')
            if (input.currentExecution?.repairable === true && ['wait', 'block'].includes(decision.action))
              throw error('TASK_OWNER_RECOVERY_AVAILABLE')
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
            if (proposed && !await authorizeStages({ taskId, stages: proposed, signal })) throw error('TASK_OWNER_STAGE_NOT_AUTHORIZED')
            if (decision.action === 'complete') {
              if ([...(decision.evidenceRefs ?? []), ...(decision.assessments ?? []).flatMap(item => item.evidenceRefs ?? [])].some(ref => (input.queryEvidence.some(item => item.artifactRef === ref) || readArtifacts.get(ref)?.kind === 'agent-query-evidence') && !readArtifacts.has(ref))) throw error('TASK_OWNER_COMPLETION_EVIDENCE_UNREAD')
              try {
                if (!input.stages.length && typeof authorizeCompletion !== 'function' || authorizeCompletion && !await authorizeCompletion({ taskId, decision, signal })) throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
              } catch (cause) {
                delete cause.ownerDiagnosticRef
                if (cause.code === 'TASK_OWNER_COMPLETION_UNVERIFIED' && cause.diagnosticRef) {
                  const diagnostic = await artifacts.read(cause.diagnosticRef)
                  if (diagnostic.kind !== 'domain-acceptance-rejection' || diagnostic.taskId !== taskId
                    || !Array.isArray(diagnostic.evidence) || !diagnostic.evidence.length
                    || diagnostic.evidence.some(item => item.hostQuery
                      ? item.hostQuery.taskId !== taskId || item.hostQuery.requirementRevision !== binding.requirementRevision
                        || readArtifacts.get(item.evidenceId)?.kind !== 'agent-query-evidence'
                      : item.hostExecution?.taskId !== taskId
                        || !input.stages.some(stage => stage.runId === item.hostExecution.runId && stage.outputRef === item.evidenceId)))
                    throw error('TASK_OWNER_ARTIFACT_SCOPE_MISMATCH')
                  readableArtifacts.add(cause.diagnosticRef)
                  cause.ownerDiagnosticRef = cause.diagnosticRef
                }
                throw cause
              }
            }
            const digest = decision.action === 'complete' ? executionDigest(decision) : null
            const candidate = await command(`owner-candidate:${turnId}`, 'task.owner.candidate', {
              taskId, turnId, leaseEpoch: claim.leaseEpoch, decision })
            if (digest) acceptedCompletion = { decision, digest }
            return candidate
          },
        })
        signal.throwIfAborted()
        if (result.status !== 'submitted') throw error(result.reason ?? 'TASK_OWNER_NO_DECISION')
        const proposedStages = result.decision.planChange?.stages ?? result.decision.appendStages
        if (proposedStages && !await authorizeStages({ taskId, stages: proposedStages, signal }))
          throw error('TASK_OWNER_STAGE_NOT_AUTHORIZED')
        // 领域完成验收已在候选提交前实跑；最终清单及事务版本校验防止旧候选接纳。
        signal.throwIfAborted()
        let deliveryManifestRef
        if (result.decision.action === 'complete' && readDeliveryManifest) {
          if (!acceptedCompletion || executionDigest(result.decision) !== acceptedCompletion.digest
            || executionDigest(acceptedCompletion.decision) !== acceptedCompletion.digest)
            throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
          const plan = await controller.taskPlan(taskId)
          const requirement = await artifacts.read(plan.task.requirementRef)
          const manifest = await readDeliveryManifest({ taskId, plan, requirement, decision: acceptedCompletion.decision, signal })
          signal.throwIfAborted()
          if (manifest?.kind !== 'task-delivery-manifest' || manifest.version !== 1 || manifest.complete !== true
              || manifest.businessValidation?.status !== 'accepted'
            || manifest.taskId !== taskId || manifest.requirementRevision !== plan.task.requirementRevision
            || manifest.planRevision !== plan.task.planRevision) throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
          deliveryManifestRef = (await artifacts.put(manifest, { taskId })).ref
        }
        signal.throwIfAborted()
        const accepted = (await command(`owner-accept:${turnId}`, 'task.owner.accept', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, ...(deliveryManifestRef ? { deliveryManifestRef } : {}) })).result
        return accepted
      } catch (cause) {
        await command(`owner-release:${turnId}`, 'task.owner.release', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, reason: signal.aborted ? 'TASK_OWNER_CANDIDATE_STALE'
            : String(cause.code ?? cause.message).slice(0, 200) }).catch(() => {})
        if (signal.aborted) return null
        if (cause.code === 'TASK_OWNER_SESSION_MISSING') await command(`owner-replace:${turnId}`,
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
  async function applyPendingActions() {
    let afterSequenceId = 0
    const failures = []
    for (;;) {
      const page = await store.query({ kind: 'task.owner.actions.pending', limit: 100, afterSequenceId })
      for (const action of page) {
        try {
          const { taskId, turnId, decision } = action
          const proposedStages = decision.planChange?.stages ?? decision.appendStages
          const owner = await store.query({ kind: 'task.owner', taskId })
          const currentPlan = await controller.taskPlan(taskId)
          const requirementDelta = currentPlan.task.requirementRef ? 0 : 1
          const priorPlanReceipt = proposedStages?.length
            ? await store.query({ kind: 'receipt', commandId: `owner-plan:${turnId}` }) : null
          if (currentPlan.task.controlState !== 'active' || (!priorPlanReceipt && (owner.eventWatermark !== action.eventWatermark
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
                if (mode === 'replaceSuffix' && plan.stages.some(stage => stage.status === 'running')) continue
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
            await advanceTask(taskId, { ownerTurnId: turnId, ...(proposedStages?.[0]?.capabilityStep
              ? { ownerStep: proposedStages[0].capabilityStep } : {}) })
          }
          await command(`owner-applied:${turnId}`, 'task.owner.applied', { taskId, turnId, leaseEpoch: action.leaseEpoch })
          if (decision.action === 'advance' && (await controller.taskPlan(taskId)).stages.some(stage => stage.status === 'running' && stage.runId)) await advanceTask(taskId)
        } catch (cause) {
          await command(`owner-action-fail:${action.turnId}:${randomUUID()}`, 'task.owner.action.fail', {
            taskId: action.taskId, turnId: action.turnId, leaseEpoch: action.leaseEpoch,
            reason: String(cause.code ?? cause.message).slice(0, 200) }).catch(() => {})
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
