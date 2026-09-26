import { executionDigest, executionError } from './execution-artifacts.js'

/** 受信Host交付网关；不向模型暴露authorizationRef、binding或原始adapter。 */
export function createExecutionDelivery({ store, artifacts, adapter, workspaceAdapter, editAdapter, prAdapter, externalAdapter, fileAdapter, authorize, authorizeExternal, authorizeFile }) {
  if (typeof authorize !== 'function') throw executionError('DELIVERY_AUTHORIZER_REQUIRED')
  const flights = new Map()
  const methods = {
    commit: { id: 'git-delivery', adapter, execute: 'executeCommit', reconcile: 'reconcileCommit' },
    push: { id: 'git-delivery', adapter, execute: 'executePush', reconcile: 'reconcilePush' },
    workspace: { id: 'managed-workspace', adapter: workspaceAdapter, execute: 'execute', reconcile: 'reconcile' },
    edit: { id: 'managed-edit', adapter: editAdapter, execute: 'execute', reconcile: 'reconcile' },
    pr: { id: 'github-pr', adapter: prAdapter, execute: 'execute', reconcile: 'reconcile' },
    external: { id: 'external-operation', adapter: externalAdapter, execute: 'execute', reconcile: 'reconcile' },
    file: { id: 'task-markdown-file', adapter: fileAdapter, execute: 'execute', reconcile: 'reconcile' },
  }
  const command = (id, kind, args) => store.command({ id, kind, args })
  async function lookup(effectId) {
    try { return await store.query({ kind: 'effect.get', effectId }) }
    catch (error) { if (error.code === 'effect_not_found') return null; throw error }
  }
  async function observe(effectId, observation) {
    if (!['succeeded', 'failed', 'unknown'].includes(observation?.status)) throw executionError('DELIVERY_OBSERVATION_INVALID')
    const artifact = await artifacts.put(observation)
    await command(`observe:${effectId}:${artifact.digest}`, 'effect.observe', {
      effectId, receiptId: `receipt:${effectId}:${artifact.digest}`, status: observation.status,
      evidenceRef: artifact.ref, result: observation,
    })
    return lookup(effectId)
  }
  async function reconcile(effectId) {
    const effect = await lookup(effectId)
    const route = methods[effect?.definition.action]
    if (!effect || !route?.adapter || effect.definition.adapterId !== route.id || effect.definition.adapterVersion !== '1') throw executionError('DELIVERY_EFFECT_INVALID')
    if (effect.state === 'succeeded' && effect.definition.action === 'workspace') {
      // 历史创建成功不能证明目录当前仍属于本任务；重用前只读复核，不重建。
      const current = await route.adapter.reconcile(effect.definition.payload)
      if (current?.status !== 'succeeded') throw executionError('WORKSPACE_CURRENT_IDENTITY_UNCONFIRMED')
    }
    if (effect.state === 'succeeded' && ['edit', 'file'].includes(effect.definition.action)) {
      if ((await route.adapter.reconcile(effect.definition.payload))?.status !== 'succeeded')
        throw executionError(effect.definition.action === 'file' ? 'TASK_MARKDOWN_CURRENT_IDENTITY_UNCONFIRMED' : 'EDIT_CURRENT_IDENTITY_UNCONFIRMED')
    }
    if (['succeeded', 'failed', 'prepared'].includes(effect.state)) return effect
    const { action, payload } = effect.definition
    if (!methods[action]) throw executionError('DELIVERY_ACTION_INVALID')
    let observation
    try { observation = await route.adapter[route.reconcile](payload) }
    catch (error) { observation = { status: 'unknown', reason: error.code ?? 'ADAPTER_READBACK_FAILED' } }
    return observe(effectId, observation)
  }
  async function dispatch({ binding, action, prepared }, effectId) {
    const route = methods[action]
    let effect = await lookup(effectId)
    if (effect) {
      if (effect.runId !== binding.runId || effect.nodeRunId !== binding.nodeRunId || effect.generation !== binding.generation
        || effect.inputDigest !== binding.inputDigest || effect.definition.action !== action
        || executionDigest(effect.definition.payload) !== executionDigest(prepared)) throw executionError('DELIVERY_IDENTITY_CONFLICT')
      if (effect.state !== 'prepared') return reconcile(effectId)
    } else {
      const grant = await (action === 'external' ? authorizeExternal : action === 'file' ? authorizeFile : authorize)?.({ binding: structuredClone(binding), action, prepared: structuredClone(prepared) })
      if (!grant || typeof grant.principalId !== 'string' || !grant.principalId
        || (typeof grant.authorizationRef !== 'string' || !grant.authorizationRef) && (!grant.approval || typeof grant.approval.requestId !== 'string'
          || !grant.approval.requestId || !Array.isArray(grant.approval.approverIds) || !grant.approval.approverIds.length)) throw executionError('DELIVERY_NOT_AUTHORIZED')
      await command(`prepare:${effectId}`, 'effect.prepare', {
        effectId, kind: 'operation', runId: binding.runId, nodeId: binding.nodeId, generation: binding.generation,
        leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
        definition: { adapterId: route.id, adapterVersion: '1', principalId: grant.principalId, action, payload: prepared },
        resourceKeys: [['external', 'file'].includes(action) ? prepared.resourceKey : ['workspace', 'edit'].includes(action) ? `workspace:${prepared.directory}` : action === 'pr' ? `github:${prepared.repo}:${prepared.head}` : `git:${action === 'push' ? prepared.remote : prepared.repository}:${prepared.ref}`],
        ...(grant.approval ? { approval: grant.approval } : { authorizationRef: grant.authorizationRef }),
      })
    }
    const { epoch } = await store.query({ kind: 'safety.get' })
    const permit = await command(`begin:${effectId}:${binding.leaseEpoch}:${epoch}`, 'effect.begin', {
      effectId, leaseEpoch: binding.leaseEpoch, expectedSafetyEpoch: epoch,
    })
    if (!permit.dispatchEligible) return reconcile(effectId)
    let observation
    try { observation = await route.adapter[route.execute](prepared) }
    catch (error) { observation = { status: 'unknown', reason: error.code ?? 'ADAPTER_EXECUTION_UNKNOWN' } }
    return observe(effectId, observation)
  }
  return {
    execute(request) {
      // 在第一个await之前复制，调用方后续修改对象不能改变已授权的发送字节。
      const snapshot = structuredClone(request), { binding, action, prepared } = snapshot
      if (!methods[action]?.adapter || prepared?.action !== action || prepared.generation !== binding?.generation
        || (['workspace', 'edit', 'pr', 'external', 'file'].includes(action) && prepared.runId !== binding?.runId)
        || (action === 'external' && (typeof prepared.resourceKey !== 'string' || !/^external:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(prepared.resourceKey)
          || typeof prepared.workflowKind !== 'string' || !/^[a-z][a-z-]{1,63}$/.test(prepared.workflowKind)))
        || (action === 'file' && (prepared.taskId !== binding?.taskId || prepared.nodeRunId !== binding?.nodeRunId
          || typeof prepared.resourceKey !== 'string' || !/^file:[a-zA-Z0-9._-]+:[a-f0-9]{64}$/.test(prepared.resourceKey)))
        || !/^[a-f0-9]{64}$/.test(binding?.requirementDigest ?? '') || prepared.requirementDigest !== binding.requirementDigest) return Promise.reject(executionError('DELIVERY_INPUT_INVALID'))
      const effectId = `${['workspace', 'edit', 'external', 'file'].includes(action) ? action : 'git'}-${executionDigest({ nodeRunId: binding.nodeRunId, action })}`
      const digest = executionDigest(snapshot), existing = flights.get(effectId)
      if (existing) return existing.digest === digest ? existing.promise : Promise.reject(executionError('DELIVERY_IDENTITY_CONFLICT'))
      const promise = dispatch(snapshot, effectId).finally(() => flights.delete(effectId))
      flights.set(effectId, { digest, promise })
      return promise
    },
    async reconcile(effectId) {
      if (flights.has(effectId)) return flights.get(effectId).promise
      return reconcile(effectId)
    },
  }
}
