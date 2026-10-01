import { createHash, randomUUID } from 'node:crypto'
import { createTaskOwnerSessions } from './task-owner-session.js'

const error = code => Object.assign(new Error(code), { code })
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** 当前阶段的成功证明和诊断引用分开；领域扩展只来自冻结定义的受信合同。 */
export async function readTaskOwnerStageArtifacts({ taskId, stages, controller, plan, readStageArtifacts }) {
  const result = []
  for (const stage of stages.filter(item => item.status !== 'invalidated')) {
    const state = stage.runId ? await controller.state(stage.runId) : null
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
      const extension = await readStageArtifacts({ taskId, stage, state, plan })
      const known = new Set([stage.outputRef, ...(stage.evidenceRefs ?? []),
        ...(state?.nodes ?? []).flatMap(node => [node.outputRef, ...(node.evidenceRefs ?? [])].filter(Boolean))])
      if ([...(extension?.evidenceRefs ?? []), ...(extension?.completionEvidenceRefs ?? []),
        ...(extension?.nodeArtifacts ?? []).map(node => node.artifactRef)].some(ref => !known.has(ref)))
        throw error('TASK_OWNER_ARTIFACT_SCOPE_MISMATCH')
      if (extension?.nodeArtifacts) entry.nodeArtifacts = extension.nodeArtifacts
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
  authorizeStages, authorizeCompletion = async () => true, prepareInitialStage, inspectCurrentExecution, repairCurrentStage,
  readStageArtifacts, readDeliveryManifest, readCurrentSources, readMaterialAccess, capabilityCatalog = [], workflowCatalog = [], sessionRunner, getWorkspaceDir }) {
  if (!ctx || !store || !artifacts || !controller || typeof modelConfig !== 'function'
    || typeof advanceTask !== 'function' || typeof authorizeStages !== 'function') throw error('TASK_OWNER_CONTROLLER_INVALID')
  let closed = false
  const flights = new Map()
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
      const state = stage.status === 'running' && stage.runId ? await controller.state(stage.runId) : null
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
        ...(stage.status === 'running' && currentExecution?.stageId === stage.stageId ? { currentExecution } : {}) }
      // 终态阶段沿用既有身份；只有运行中诊断需要按执行代际和失败内容再次唤醒。
      const eventIdentity = stage.status === 'running' ? payload : [taskId, plan.task.planRevision, stage.stageId, stage.status]
      await event({ taskId, eventKey: `stage-${key(eventIdentity).slice(0, 40)}`,
        eventType, payload })
    }
    return plan
  }

  async function snapshot(taskId, claim) {
    const owner = await store.query({ kind: 'task.owner', taskId })
    const plan = await controller.taskPlan(taskId)
    const events = []
    let cursor = owner.processedWatermark
    for (;;) {
      const page = await store.query({ kind: 'task.owner.events', taskId, afterSequenceId: cursor, limit: 200 })
      const selected = page.filter(item => item.eventSeq <= claim.eventWatermark)
      for (const item of selected) {
        events.push({ eventSeq: item.eventSeq, eventType: item.eventType,
          payload: item.payloadRef ? await artifacts.read(item.payloadRef) : null })
      }
      if (!page.length || page.at(-1).eventSeq >= claim.eventWatermark) break
      cursor = page.at(-1).eventSeq
    }
    const goal = plan.task.requirementRef ? await artifacts.read(plan.task.requirementRef)
      : plan.stages[0]?.requirementRef ? await artifacts.read(plan.stages[0].requirementRef) : null
    const acceptanceItems = await store.query({ kind: 'task.owner.acceptance', taskId })
    const result = { taskId, eventWatermark: claim.eventWatermark, goal,
      ...(readCurrentSources ? { currentSources: await readCurrentSources({ taskId, plan }) } : {}),
      acceptanceItems, versions: claim.versions, task: plan.task, stages: plan.stages, events }
    if (plan.task.planRevision > 0 && plan.task.planRequirementRevision !== plan.task.requirementRevision) result.planReview = {
      required: true, instruction: '当前计划尚未覆盖当前需求；继续任务须使用advance与planChange.kind=replaceSuffix重评未完成阶段。repairCurrentStage不能替代需求重评，不得编造repairBinding。' }
    if (readMaterialAccess) result.materialAccess = await readMaterialAccess({ taskId, plan, requirement: goal })
    const repairedStages = new Set(plan.stages.filter(stage => stage.status !== 'succeeded'
      && result.materialAccess?.scopeRepairs?.some(repair => repair.runId === stage.runId
        && repair.inputRef === stage.requirementRef)).map(stage => stage.stageId))
    result.stageArtifacts = await readTaskOwnerStageArtifacts({ taskId,
      stages: plan.stages.filter(stage => !repairedStages.has(stage.stageId)), controller, plan, readStageArtifacts })
    if (repairedStages.size) result.invalidatedDiagnostics = [...repairedStages].map(stageId => ({ stageId,
      reason: '旧调查输入的材料范围遗漏已由Host核验修复；旧失败诊断不再作为当前判断依据，必须用当前材料范围重新读取。' }))
    if (readDeliveryManifest) {
      const manifest = await readDeliveryManifest({ taskId, plan, requirement: goal })
      result.deliveryManifest = { ref: (await artifacts.put(manifest, { taskId })).ref, complete: manifest.complete,
        missing: manifest.missing, validation: manifest.validation }
    }
    if (inspectCurrentExecution) {
      result.currentExecution = await inspectCurrentExecution(taskId, plan)
      if (result.currentExecution?.evidenceRefs?.length && !repairedStages.has(result.currentExecution.stageId)) result.stageArtifacts.push({ stageId: result.currentExecution.stageId, outputRef: null, evidenceRefs: result.currentExecution.evidenceRefs })
    }
    result.capabilities = capabilityCatalog
    result.workflowCatalog = workflowCatalog
    return result
  }

  async function drive(taskId) {
    if (closed) throw error('TASK_OWNER_CONTROLLER_CLOSED')
    if (flights.has(taskId)) return flights.get(taskId)
    const flight = (async () => {
      const before = await store.query({ kind: 'task.owner', taskId })
      if (!before || before.status !== 'pending' || before.processedWatermark === before.eventWatermark) return null
      if ((await controller.taskPlan(taskId))?.task.controlState !== 'active') return null
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
        const input = await snapshot(taskId, claim)
        const unreadPages = new Set((input.eventPages ?? []).map(page => page.ref))
        const readableArtifacts = new Set(input.stageArtifacts.flatMap(stage =>
          [stage.outputRef, ...stage.evidenceRefs].filter(Boolean)))
        if (input.deliveryManifest) readableArtifacts.add(input.deliveryManifest.ref)
        const result = await sessions.run({ binding, input, ...modelConfig(),
          readPage: async pageRef => {
            if (!unreadPages.has(pageRef)) throw error('TASK_OWNER_PAGE_NOT_ALLOWED')
            const page = await artifacts.read(pageRef)
            unreadPages.delete(pageRef)
            return page
          },
          readArtifact: async artifactRef => {
            if (!readableArtifacts.has(artifactRef)) throw error('TASK_OWNER_ARTIFACT_NOT_ALLOWED')
            const value = await artifacts.read(artifactRef)
            return value?.encoding === 'base64' && typeof value.data === 'string'
              ? { ...value, text: Buffer.from(value.data, 'base64').toString('utf8') } : value
          },
          onSessionBound: () => command(`owner-bound:${turnId}`, 'task.owner.sessionBound', {
            taskId, turnId, leaseEpoch: claim.leaseEpoch, sessionId: claim.sessionId }),
          onCandidate: decision => {
            if (unreadPages.size) throw error('TASK_OWNER_EVENTS_UNREAD')
            if (decision.action === 'repairCurrentStage') {
              const expected = input.currentExecution?.repairBinding
              if (input.currentExecution?.repairable !== true || !expected
                || Object.keys(decision.repair ?? {}).length !== Object.keys(expected).length
                || Object.entries(expected).some(([key, value]) => decision.repair?.[key] !== value))
                throw error('TASK_OWNER_REPAIR_BINDING_INVALID')
            }
            return command(`owner-candidate:${turnId}`, 'task.owner.candidate', {
              taskId, turnId, leaseEpoch: claim.leaseEpoch, decision })
          },
        })
        if (result.status !== 'submitted') throw error(result.reason ?? 'TASK_OWNER_NO_DECISION')
        const proposedStages = result.decision.planChange?.stages ?? result.decision.appendStages
        if (proposedStages && !await authorizeStages({ taskId, stages: proposedStages }))
          throw error('TASK_OWNER_STAGE_NOT_AUTHORIZED')
        if (result.decision.action === 'complete' && !await authorizeCompletion({ taskId, decision: result.decision }))
          throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
        let deliveryManifestRef
        if (result.decision.action === 'complete' && readDeliveryManifest) {
          const plan = await controller.taskPlan(taskId)
          const requirement = await artifacts.read(plan.task.requirementRef)
          const manifest = await readDeliveryManifest({ taskId, plan, requirement, decision: result.decision })
          if (manifest?.kind !== 'task-delivery-manifest' || manifest.version !== 1 || manifest.complete !== true
              || manifest.businessValidation?.status !== 'accepted'
            || manifest.taskId !== taskId || manifest.requirementRevision !== plan.task.requirementRevision
            || manifest.planRevision !== plan.task.planRevision) throw error('TASK_OWNER_COMPLETION_UNVERIFIED')
          deliveryManifestRef = (await artifacts.put(manifest, { taskId })).ref
        }
        const accepted = (await command(`owner-accept:${turnId}`, 'task.owner.accept', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, ...(deliveryManifestRef ? { deliveryManifestRef } : {}) })).result
        return accepted
      } catch (cause) {
        await command(`owner-release:${turnId}`, 'task.owner.release', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch, reason: String(cause.code ?? cause.message).slice(0, 200) }).catch(() => {})
        if (cause.code === 'TASK_OWNER_SESSION_MISSING') await command(`owner-replace:${turnId}`,
          'task.owner.replace-session', { taskId, expectedLeaseEpoch: claim.leaseEpoch,
            newSessionId: `owner-${key([taskId, claim.ownerEpoch + 1]).slice(0, 40)}`,
            reason: 'SESSION_NOT_FOUND' })
        throw cause
      }
    })().finally(() => flights.delete(taskId))
    flights.set(taskId, flight)
    return flight
  }

  async function applyPending() {
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
                const prepared = mode === 'initialize' || mode === 'replaceSuffix' && affectedFrom === 0
                  ? await (prepareInitialStage?.({ taskId, stage: proposedStages[0], decision, plan })
                    ?? artifacts.read(plan.task.requirementRef).then(input => ({ input }))) : null
                const initial = prepared ? { ...stages[0], ...prepared } : null
                if (mode === 'initialize') await controller.initializeTaskPlan({
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

  async function recover() {
    const failures = await applyPending()
    let beforeSequenceId
    for (;;) {
      const page = await store.query({ kind: 'task.owners.pending', limit: 100,
        ...(beforeSequenceId ? { beforeSequenceId } : {}) })
      for (const item of page) {
        try { await drive(item.taskId) }
        catch (cause) { failures.push({ scope: 'owner', taskId: item.taskId, code: cause.code ?? cause.message }) }
      }
      if (page.length < 100) break
      beforeSequenceId = page.at(-1).sequenceId
    }
    failures.push(...await applyPending())
    return failures
  }

  return { ensure, event, observe, drive, recover, applyPending, async close() {
    closed = true
    await sessions.close()
    await Promise.allSettled([...flights.values()])
  } }
}
