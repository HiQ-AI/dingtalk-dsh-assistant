import { createHash, randomUUID } from 'node:crypto'
import { createTaskOwnerSessions } from './task-owner-session.js'

const error = code => Object.assign(new Error(code), { code })
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** Task 事件唤醒、模型候选、Host 接纳和执行回执的唯一入口。 */
export function createTaskOwnerController({ ctx, store, artifacts, controller, modelConfig, advanceTask,
  authorizeStages, authorizeCompletion = async () => true, prepareInitialStage,
  capabilityCatalog = [], workflowCatalog = [], sessionRunner }) {
  if (!ctx || !store || !artifacts || !controller || typeof modelConfig !== 'function'
    || typeof advanceTask !== 'function' || typeof authorizeStages !== 'function') throw error('TASK_OWNER_CONTROLLER_INVALID')
  let closed = false
  const flights = new Map()
  const sessions = sessionRunner ?? createTaskOwnerSessions({ ctx, isCurrent: async binding => {
    const owner = await store.query({ kind: 'task.owner', taskId: binding.taskId })
    return !!owner && owner.status === 'running' && owner.turnId === binding.turnId
      && owner.leaseEpoch === binding.leaseEpoch && owner.sessionId === binding.sessionId
  } })
  const command = (id, kind, args) => store.command({ id, kind, args })

  async function event({ taskId, eventKey, eventType, payload }) {
    if (closed) throw error('TASK_OWNER_CONTROLLER_CLOSED')
    const artifact = payload === undefined ? null : await artifacts.put(payload)
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
    for (const stage of plan.stages) {
      if (!['succeeded', 'blocked', 'waiting_confirmation'].includes(stage.status)) continue
      const eventType = stage.status === 'waiting_confirmation' ? 'workflow.confirmation.required'
        : stage.status === 'blocked' ? 'workflow.failed' : 'workflow.succeeded'
      const payload = { taskId, planRevision: plan.task.planRevision, stageId: stage.stageId,
        workflowId: stage.workflowId, status: stage.status, runId: stage.runId,
        outputRef: stage.outputRef, evidenceRefs: stage.evidenceRefs }
      await event({ taskId, eventKey: `stage-${key([taskId, plan.task.planRevision, stage.stageId, stage.status]).slice(0, 40)}`,
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
      acceptanceItems, versions: claim.versions, task: plan.task, stages: plan.stages, events }
    result.stageArtifacts = plan.stages.filter(stage => stage.status === 'succeeded' && stage.outputRef)
      .map(stage => ({ stageId: stage.stageId, outputRef: stage.outputRef,
        evidenceRefs: stage.evidenceRefs ?? [] }))
    result.capabilities = capabilityCatalog
    result.workflowCatalog = workflowCatalog
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) {
      const pages = []
      let batch = []
      for (const item of events) {
        const next = [...batch, item]
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 24 * 1024) {
          if (!batch.length) throw error('TASK_OWNER_EVENT_CAPACITY')
          const artifact = await artifacts.put(batch)
          pages.push({ ref: artifact.ref, firstSeq: batch[0].eventSeq,
            lastSeq: batch.at(-1).eventSeq, count: batch.length })
          batch = [item]
        } else batch = next
      }
      if (batch.length) {
        if (Buffer.byteLength(JSON.stringify(batch), 'utf8') > 24 * 1024) throw error('TASK_OWNER_EVENT_CAPACITY')
        const artifact = await artifacts.put(batch)
        pages.push({ ref: artifact.ref, firstSeq: batch[0].eventSeq,
          lastSeq: batch.at(-1).eventSeq, count: batch.length })
      }
      result.events = []
      result.eventPages = pages
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024
      || result.eventPages?.length > 60) throw error('TASK_OWNER_INPUT_CAPACITY')
    return result
  }

  async function drive(taskId) {
    if (closed) throw error('TASK_OWNER_CONTROLLER_CLOSED')
    if (flights.has(taskId)) return flights.get(taskId)
    const flight = (async () => {
      const before = await store.query({ kind: 'task.owner', taskId })
      if (!before || before.status !== 'pending' || before.processedWatermark === before.eventWatermark) return null
      const turnId = `turn-${randomUUID()}`
      const claim = (await command(`owner-claim:${turnId}`, 'task.owner.claim', {
        taskId, turnId, expectedLeaseEpoch: before.leaseEpoch,
      })).result
      const binding = { taskId, turnId, sessionId: claim.sessionId, leaseEpoch: claim.leaseEpoch,
        ownerEpoch: claim.ownerEpoch, sessionBound: claim.sessionBound }
      try {
        const input = await snapshot(taskId, claim)
        const unreadPages = new Set((input.eventPages ?? []).map(page => page.ref))
        const readableArtifacts = new Set(input.stageArtifacts.flatMap(stage =>
          [stage.outputRef, ...stage.evidenceRefs]))
        const result = await sessions.run({ binding, input, ...modelConfig(),
          readPage: async pageRef => {
            if (!unreadPages.has(pageRef)) throw error('TASK_OWNER_PAGE_NOT_ALLOWED')
            const page = await artifacts.read(pageRef)
            unreadPages.delete(pageRef)
            return page
          },
          readArtifact: async artifactRef => {
            if (!readableArtifacts.has(artifactRef)) throw error('TASK_OWNER_ARTIFACT_NOT_ALLOWED')
            return artifacts.read(artifactRef)
          },
          onSessionBound: () => command(`owner-bound:${turnId}`, 'task.owner.sessionBound', {
            taskId, turnId, leaseEpoch: claim.leaseEpoch, sessionId: claim.sessionId }),
          onCandidate: decision => {
            if (unreadPages.size) throw error('TASK_OWNER_EVENTS_UNREAD')
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
        const accepted = (await command(`owner-accept:${turnId}`, 'task.owner.accept', {
          taskId, turnId, leaseEpoch: claim.leaseEpoch })).result
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
          if ((!priorPlanReceipt && (owner.eventWatermark !== action.eventWatermark
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
          if (decision.action === 'advance') {
            if (proposedStages?.length) {
              const plan = currentPlan
              const mode = decision.planChange?.kind ?? (plan.task.planRevision === 0 ? 'initialize'
                : plan.task.status === 'succeeded' ? 'replaceSuffix' : 'append')
              const affectedFrom = decision.planChange?.affectedFrom ?? plan.stages.length
              const stageIdBase = mode === 'replaceSuffix' ? affectedFrom : plan.stages.length
              const stages = proposedStages.map((stage, index) => ({ workflowId: stage.workflowId, gate: stage.gate,
                stageId: `stage-${stageIdBase + index + 1}` }))
              if (!priorPlanReceipt) {
                if (mode === 'replaceSuffix' && plan.stages.some(stage => stage.status === 'running')) continue
                const prepared = mode === 'initialize' || mode === 'replaceSuffix' && affectedFrom === 0
                  ? await (prepareInitialStage?.({ taskId, stage: proposedStages[0], decision, plan })
                    ?? artifacts.read(plan.task.requirementRef).then(input => ({ input }))) : null
                const initial = prepared ? { ...stages[0], ...prepared } : null
                if (mode === 'initialize') await controller.initializeTaskPlan({
                  commandId: `owner-plan:${turnId}`, taskId, expectedPlanRevision: 0,
                  expectedRequirementRevision: action.requirementRevision,
                  expectedControlRevision: action.controlRevision,
                  stages: [initial, ...stages.slice(1)],
                })
                else if (mode === 'replaceSuffix') {
                  const replacement = affectedFrom === 0
                    ? [initial, ...stages.slice(1)]
                    : stages
                  await controller.reviseTaskPlan({
                  commandId: `owner-plan:${turnId}`, taskId, expectedPlanRevision: action.planRevision,
                  expectedControlRevision: action.controlRevision,
                  requirementRevision: action.requirementRevision + requirementDelta, affectedFrom,
                  stages: [...plan.stages.slice(0, affectedFrom).map(old => ({ stageId: old.stageId,
                    workflowId: old.workflowId, gate: old.gate })), ...replacement],
                  })
                }
                else await controller.extendTaskPlan({ commandId: `owner-plan:${turnId}`, taskId,
                  expectedPlanRevision: action.planRevision, expectedControlRevision: action.controlRevision,
                  requirementRevision: action.requirementRevision + requirementDelta, stages })
              }
            }
            await advanceTask(taskId, proposedStages?.[0]?.capabilityStep
              ? { ownerStep: proposedStages[0].capabilityStep } : undefined)
          }
          await command(`owner-applied:${turnId}`, 'task.owner.applied', { taskId, turnId, leaseEpoch: action.leaseEpoch })
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
