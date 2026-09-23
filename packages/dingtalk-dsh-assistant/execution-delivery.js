import { executionDigest, executionError } from './execution-artifacts.js'

/** 受信Host交付网关；不向模型暴露authorizationRef、binding或原始adapter。 */
export function createExecutionDelivery({ store, artifacts, adapter, authorize }) {
  if (typeof authorize !== 'function') throw executionError('DELIVERY_AUTHORIZER_REQUIRED')
  const flights = new Map()
  const methods = { commit: ['executeCommit', 'reconcileCommit'], push: ['executePush', 'reconcilePush'] }
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
    if (!effect || effect.definition.adapterId !== 'git-delivery' || effect.definition.adapterVersion !== '1') throw executionError('DELIVERY_EFFECT_INVALID')
    if (['succeeded', 'failed', 'prepared'].includes(effect.state)) return effect
    const { action, payload } = effect.definition
    if (!methods[action]) throw executionError('DELIVERY_ACTION_INVALID')
    let observation
    try { observation = await adapter[methods[action][1]](payload) }
    catch (error) { observation = { status: 'unknown', reason: error.code ?? 'ADAPTER_READBACK_FAILED' } }
    return observe(effectId, observation)
  }
  async function dispatch({ binding, action, prepared }, effectId) {
    let effect = await lookup(effectId)
    if (effect) {
      if (effect.runId !== binding.runId || effect.nodeRunId !== binding.nodeRunId || effect.generation !== binding.generation
        || effect.inputDigest !== binding.inputDigest || effect.definition.action !== action
        || executionDigest(effect.definition.payload) !== executionDigest(prepared)) throw executionError('DELIVERY_IDENTITY_CONFLICT')
      if (effect.state !== 'prepared') return reconcile(effectId)
    } else {
      const grant = await authorize({ binding: structuredClone(binding), action, prepared: structuredClone(prepared) })
      if (!grant || typeof grant.principalId !== 'string' || !grant.principalId || typeof grant.authorizationRef !== 'string' || !grant.authorizationRef) throw executionError('DELIVERY_NOT_AUTHORIZED')
      await command(`prepare:${effectId}`, 'effect.prepare', {
        effectId, kind: 'operation', runId: binding.runId, nodeId: binding.nodeId, generation: binding.generation,
        leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
        definition: { adapterId: 'git-delivery', adapterVersion: '1', principalId: grant.principalId, action, payload: prepared },
        resourceKeys: [`git:${action === 'push' ? prepared.remote : prepared.repository}:${prepared.ref}`], authorizationRef: grant.authorizationRef,
      })
    }
    const { epoch } = await store.query({ kind: 'safety.get' })
    const permit = await command(`begin:${effectId}:${binding.leaseEpoch}:${epoch}`, 'effect.begin', {
      effectId, leaseEpoch: binding.leaseEpoch, expectedSafetyEpoch: epoch,
    })
    if (!permit.dispatchEligible) return reconcile(effectId)
    let observation
    try { observation = await adapter[methods[action][0]](prepared) }
    catch (error) { observation = { status: 'unknown', reason: error.code ?? 'ADAPTER_EXECUTION_UNKNOWN' } }
    return observe(effectId, observation)
  }
  return {
    execute(request) {
      // 在第一个await之前复制，调用方后续修改对象不能改变已授权的发送字节。
      const snapshot = structuredClone(request), { binding, action, prepared } = snapshot
      if (!methods[action] || prepared?.action !== action || prepared.generation !== binding?.generation
        || !/^[a-f0-9]{64}$/.test(binding?.requirementDigest ?? '') || prepared.requirementDigest !== binding.requirementDigest) return Promise.reject(executionError('DELIVERY_INPUT_INVALID'))
      const effectId = `git-${executionDigest({ nodeRunId: binding.nodeRunId, action })}`
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
