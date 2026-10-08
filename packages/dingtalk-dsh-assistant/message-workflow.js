import { randomUUID } from 'node:crypto'
import { digest } from './message-context.js'

export const defaultMessagePolicy = Object.freeze({ version: 'message-v2.6', concurrency: 2 })
function incompleteMaterial(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(incompleteMaterial)
  return Boolean(value.capacityExceeded || value.projection?.complete === false || Object.values(value).some(incompleteMaterial))
}

/** 群常驻协调是唯一语义入口；本层只处理来源、持久命令和执行恢复。 */
export function createMessageWorkflow({ store, coordinator, context = {}, handlers = {}, policy = {}, clock = Date.now }) {
  if (!store?.command || !store?.query || !coordinator?.process) throw new Error('MESSAGE_DEPENDENCIES_REQUIRED')
  const config = { ...defaultMessagePolicy, ...policy }
  let closed = false
  const cmd = async (kind, args, id = `${kind}:${randomUUID()}`) => (await store.command({ id, kind, args })).result
  const state = runId => store.query({ kind: 'message.run', runId })
  const revision = data => data.run.revision ?? data.run.matterSetRevision ?? 0
  async function receive(input, { process: launch = true } = {}) {
    if (closed) throw new Error('MESSAGE_WORKFLOW_CLOSED')
    if (!input.sourceKey || !Number.isInteger(input.sourceVersion) || !input.actorId || !input.conversationId || typeof input.body !== 'string' || !input.body.length) throw new Error('MESSAGE_INPUT_INVALID')
    const runId = input.runId ?? `msg-${digest([input.sourceKey, input.sourceVersion]).slice(0, 40)}`
    const result = await cmd('message.receive', { ...input, runId, policy: config }, `receive:${runId}`)
    if (launch) void process(runId).catch(() => {})
    return { ...result, runId }
  }
  async function reprocess(runId, compactPolicy) {
    const previous=await state(runId)
    const nextVersion=previous.run.sourceVersion+1
    const newRunId=`msg-replay-${digest([previous.run.sourceKey,nextVersion]).slice(0,40)}`
    const result=await cmd('message.reprocess',{runId,newRunId,policy:config,...(compactPolicy !== undefined ? {compactPolicy} : {})},`reprocess:${runId}:${newRunId}`)
    await process(result.run.runId)
    return state(result.run.runId)
  }
  async function waiting(data, unitId, stage, output) {
    const aliases = new Map((data.run.snapshot?.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
    const needs = (output.needs ?? []).map(need => ({ ...need, resourceRef: aliases.get(need.resourceRef) ?? need.resourceRef }))
    const requestId = digest([data.run.runId, unitId, stage, revision(data), { ...output, needs }])
    if (data.requests.some(request => request.id === requestId && request.status === 'resolved')) {
      return cmd('message.attention', { runId: data.run.runId, unitId, reason: `MESSAGE_CONTEXT_UNCHANGED:${stage}:${unitId}` })
    }
    return cmd('message.wait', { runId: data.run.runId, unitId, nodeId: stage, expectedRevision: revision(data), reason: output.reason, request: { requestId, kind: output.kind, question: output.question ?? output.reason, needs, permittedActors: [data.run.actorId] } })
  }
  function inheritedMaterialNeeds(data, unit) {
    const aliases = new Map((data.run.snapshot?.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
    const needs = [...(unit.contextNeeds ?? []), ...data.requests.filter(request => request.unitId === (unit.id ?? unit.unitId) && request.kind === 'needs_context' && request.status === 'resolved').flatMap(request => request.needs ?? [])]
    return [...new Map(needs.map(need => { const resourceRef = aliases.get(need.resourceRef) ?? need.resourceRef; return [resourceRef, { ...need, resourceRef }] })).values()]
  }
  async function readMaterial(input) {
    try {
      const value = await context.material?.(input)
      return value?.ready && !incompleteMaterial(value.data) ? value : { ready: false, reason: value?.reason ?? 'MATERIAL_UNAVAILABLE' }
    } catch (error) { return { ready: false, reason: error.code ?? error.message } }
  }
  async function dispatch(runId, { resolvedCoordinatorTurnId } = {}) {
    const data = await state(runId)
    if (resolvedCoordinatorTurnId && data.run.coordinatorConsumed?.turnId === resolvedCoordinatorTurnId) {
      for (const barrier of data.barriers.filter(item => item.ownerRunId === runId && item.status === 'resolved'
        && item.resolution === 'coordinator_no_action_consumed' && item.resolvedCoordinatorTurnId === resolvedCoordinatorTurnId))
        await context.onBarrierResolved?.(barrier, data)
    }
    await Promise.all(data.commands.filter(command => !['applied', 'rejected', 'unknown', 'failed', 'running', 'waiting', 'cancelled', 'superseded'].includes(command.status)).map(async command => {
      const action = { intent: command.kind, ...command.args }
      const info = { run: data.run, unit: data.units.find(unit => (unit.id ?? unit.unitId) === command.unitId), binding: command.args.binding, commandId: command.commandId }
      const aliases = new Map((data.run.snapshot?.historyManifest ?? []).map((item, index) => [`h${index + 1}`, item.sourceKey]))
      action.requiredExecutionMaterials = [...new Set([...(action.requiredExecutionMaterials ?? []).map(ref => aliases.get(ref) ?? ref), ...(['pause', 'cancel'].includes(command.kind) ? [] : inheritedMaterialNeeds(data, info.unit ?? {}).map(need => need.resourceRef))])]
      if (action.requiredExecutionMaterials.length) {
        if (data.requests.some(request => request.unitId === command.unitId && request.status === 'pending')) return
        const needs = action.requiredExecutionMaterials.map(resourceRef => ({ resourceRef, reason: 'required_execution_material' }))
        const material = await readMaterial({ run: data.run, unit: info.unit, nodeId: 'execute', needs })
        if (!material.ready) { await waiting(data, command.unitId, 'execute', { kind: 'needs_context', reason: material.reason, needs }); return }
      }
      const blocked = command.dependsOn?.find(id => data.commands.find(item => item.commandId === id)?.status === 'rejected')
      const validation = blocked ? { allowed: false, reason: '依赖动作已拒绝' } : await context.validateAction?.(action, info)
      if (validation?.allowed === false) {
        try { await cmd('message.command.reject', { commandId: command.commandId, reason: validation.reason }, `reject:${command.commandId}`) }
        catch (error) { if (!['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_STALE'].includes(error.code)) throw error }
        await dispatch(runId)
        return
      }
      const handler = command.kind === 'no_action' ? async () => ({ outcome: 'ignored' }) : handlers[command.kind]
      if (!handler) {
        await cmd('message.attention', { runId, reason: `UNSUPPORTED_HANDLER:${command.kind}:${command.commandId}` }, `unsupported:${command.commandId}`)
        return
      }
      let receipt
      try { receipt = await store.command({ id: `dispatch:${command.commandId}:${randomUUID()}`, kind: 'message.command.claim', args: { commandId: command.commandId } }) }
      catch (error) { if (['MESSAGE_COMMAND_NOT_READY', 'MESSAGE_DEPENDENCY_PENDING', 'MESSAGE_INPUT_PENDING', 'MESSAGE_STALE'].includes(error.code)) return; throw error }
      if (!receipt.dispatchEligible || !receipt.result?.command) return
      const claimed = receipt.result.command
      let result
      try {
        result = await handler(action, { ...info, commandLeaseEpoch: claimed.leaseEpoch })
        // Agent 的持久执行自行提交结果；路由队列不能等待一次长查询结束。
        if (result?.executionPending === true) return
        await cmd('message.command.complete', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, result })
      } catch (error) { await cmd('message.command.fail', { commandId: command.commandId, leaseEpoch: claimed.leaseEpoch, error: error.code ?? error.message }); return }
      await context.onCommandApplied?.(action, info, result)
      // 回执提交即唤醒其已就绪后继，不能等待同批其它慢动作或下一次恢复轮询。
      await dispatch(runId)
    }))
    const final = await state(runId)
    if (final.units.filter(item => item.status !== 'superseded').length && final.units.filter(item => item.status !== 'superseded').every(item => ['applied', 'ignored', 'rejected'].includes(item.status)) && !final.requests.some(item => item.status === 'pending')) {
      for (const barrier of final.barriers.filter(item => item.status === 'pending')) {
        await cmd('message.barrier.resolve', { runId, barrierId: barrier.id, resolution: 'all_units_applied_or_no_action' }, `barrier:${barrier.id}:resolve`)
        await context.onBarrierResolved?.(barrier, final)
      }
    }
  }

  function process(runId) {
    if (closed) return Promise.reject(new Error('MESSAGE_WORKFLOW_CLOSED'))
    return coordinator.process(runId, { dispatch })
  }
  async function recover() {
    for (const check of await store.query({ kind: 'message.echo.unreconciled', limit: 200 })) {
      if (check.eligible) await cmd('message.echo.reconcile', { runId: check.runId, expectedDigest: check.expectedDigest }, `echo-reconcile:${check.runId}:${check.expectedDigest}`)
    }
    for (const run of await store.query({ kind: 'message.pending' })) {
      const noAction = await store.query({ kind: 'message.barrier.no-action', runId: run.runId })
      if (noAction.eligible && noAction.barrierIds.length) {
        try {
          await cmd('message.barrier.reconcile-no-action', { runId: run.runId, expectedDigest: noAction.expectedDigest }, `no-action-barriers:${run.runId}:${noAction.expectedDigest}`)
          const resolved = await state(run.runId)
          for (const barrier of resolved.barriers.filter(item => noAction.barrierIds.includes(item.id) && item.status === 'resolved')) await context.onBarrierResolved?.(barrier, resolved)
        }
        catch (error) { if (error.code !== 'MESSAGE_NO_ACTION_BARRIER_STALE') throw error }
      }
      if (run.context?.sourceMessageId && await store.query({ kind: 'message.outboundByMessage', conversationId: run.conversationId, messageId: run.context.sourceMessageId })) {
        try { await cmd('message.echo.quarantine', { runId: run.runId }, `echo-quarantine:${run.runId}`) }
        catch (error) { if (error.code !== 'MESSAGE_ECHO_QUARANTINE_FORBIDDEN') throw error }
        continue
      }
      const data = await state(run.runId)
      for (const request of data.requests.filter(item => item.nodeId === 'execute' && item.kind === 'needs_context' && item.status === 'pending')) {
        if (request.blocked || request.retryAt && Date.parse(request.retryAt) > clock()) continue
        const material = await readMaterial({ run, unit: data.units.find(unit => unit.unitId === request.unitId), nodeId: request.nodeId, needs: request.needs })
        if (material.ready) await cmd('message.wake', { runId: run.runId, requestId: request.id, eventId: `material:${request.id}:${digest(material.data ?? {})}`, actorId: run.actorId, answer: material.data ?? {} })
        else await cmd('message.request.retry', { runId: run.runId, requestId: request.id, error: material.reason,
          retryAt: new Date(clock() + Math.min(30000 * 2 ** Math.min(request.attempts ?? 0, 17), 2147483647)).toISOString(), contractVersion: 'material-v2' })
      }
    }
    return coordinator.recover({ dispatch })
  }
  async function resume(input) {
    const result = await cmd('message.wake', input, `wake:${input.eventId}`)
    if (result?.run?.runId) await coordinator.wake(result.run.runId, { dispatch })
    return result
  }
  async function close() { closed = true; await coordinator.close() }
  return { receive, reprocess, process, recover, resume, state, commandSettled: dispatch, close }
}
