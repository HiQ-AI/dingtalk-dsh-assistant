import { fingerprint, stableId } from './topic-model.js'

// 动作的资源占用、未知结果与读回恢复拥有独立生命周期，不能塞入报告审阅队列。
// 仅供 Host 注册适配器后调用；没有任意命令入口，也不覆盖未接入的 shell/SQL/部署。
const ownsResources = intent => ['prepared', 'executing', 'unknown'].includes(intent.status)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const copy = value => structuredClone(value)
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  throw new Error('task_action_params_not_json')
}
function references(values, code) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !nonempty(value))) throw new Error(code)
  return [...new Set(values)].sort()
}
export function taskActions(task) {
  const actions = new Map()
  for (const event of task.executionEvents ?? []) if (event.kind === 'task-action-updated') actions.set(event.intent.actionId, copy(event.intent))
  return [...actions.values()]
}

export function createTaskActionCoordinator({ store, serialize, adapters, authorize, isCancelled, isClosing = () => false, now = () => Date.now() }) {
  if (!(adapters instanceof Map) || typeof authorize !== 'function' || typeof isCancelled !== 'function' || typeof serialize !== 'function') throw new Error('task_action_host_dependencies_required')
  // 固定注册表，不能通过请求添加适配器或在动作中切换其实现。
  const registry = new Map([...adapters].map(([id, adapter]) => [id, Object.freeze({ ...adapter })]))
  for (const [id, adapter] of registry) if (!nonempty(id) || ['parseParams', 'normalizeResourceKeys', 'execute', 'reconcile'].some(key => typeof adapter?.[key] !== 'function')) throw new Error(`task_action_adapter_invalid:${id}`)
  const runs = new Map()
  const list = taskId => store.listTasks().filter(task => taskId === undefined || task.taskId === taskId).flatMap(taskActions)
  const get = actionId => list().find(intent => intent.actionId === actionId)
  const adapterFor = intent => {
    const adapter = registry.get(intent.adapterId)
    if (!adapter) throw new Error(`task_action_adapter_unregistered:${intent.adapterId}`)
    return adapter
  }
  async function save(intent) {
    if (isClosing()) throw new Error('task_action_runtime_closed')
    await store.updateTask(intent.taskId, task => ({ ...task, executionEvents: [...(task.executionEvents ?? []), { kind: 'task-action-updated', at: new Date(now()).toISOString(), intent: copy(intent) }] }))
    return copy(intent)
  }
  async function authorized(intent, phase) {
    const task = store.getTask(intent.taskId)
    if (!task) throw new Error(`task_action_task_missing:${intent.taskId}`)
    if (phase !== 'reconcile') {
      if (task.inputVersion !== intent.inputVersion || task.runSequence !== intent.runSequence) throw new Error(`task_action_version_stale:${intent.actionId}`)
      if (isCancelled(task) || task.state === 'completed') throw new Error(`task_action_execution_stopped:${intent.actionId}`)
    }
    if (await authorize({ task: copy(task), intent: copy(intent), phase }) !== true) throw new Error(`task_action_unauthorized:${intent.actionId}`)
  }
  function claim(intent) {
    const conflict = list().find(other => other.actionId !== intent.actionId && ownsResources(other) && other.resourceKeys.some(key => intent.resourceKeys.includes(key)))
    if (conflict) throw new Error(`task_action_resource_conflict:${conflict.actionId}`)
  }
  function outcome(intent, result) {
    const receiptRefs = Array.isArray(result?.receiptRefs) && result.receiptRefs.length > 0 && result.receiptRefs.every(nonempty) ? [...new Set(result.receiptRefs)] : []
    if (result?.status === 'confirmed' && receiptRefs.length) return { ...intent, status: 'confirmed', receiptRefs, retryable: false, error: undefined, nextRetryAt: undefined }
    if (result?.status === 'failed' && result.definitelyNotApplied === true && receiptRefs.length) {
      const retryable = result.retryable === true && intent.attempt < 3
      return { ...intent, status: 'failed', definitelyNotApplied: true, receiptRefs, retryable,
        nextRetryAt: retryable ? now() + (intent.attempt === 1 ? 2000 : 10000) : undefined,
        error: String(result.error ?? 'task_action_not_applied').slice(0, 1600) }
    }
    return { ...intent, status: 'unknown', retryable: false, nextRetryAt: undefined, receiptRefs,
      error: String(result?.error ?? 'task_action_outcome_unknown').slice(0, 1600) }
  }
  async function readback(intent) {
    if (isClosing()) return get(intent.actionId)
    // 取消及输入变化不能抹掉外部事实；读回单独复核当前读取权限。
    await serialize(() => authorized(intent, 'reconcile'))
    let result
    try { result = await adapterFor(intent).reconcile(copy(intent)) } catch (error) { result = { status: 'unknown', error: String(error?.message ?? error) } }
    if (isClosing()) return get(intent.actionId)
    return serialize(() => save(outcome(get(intent.actionId), result)))
  }
  function singleFlight(actionId, operation) {
    if (runs.has(actionId)) return runs.get(actionId)
    const run = Promise.resolve().then(operation).finally(() => runs.delete(actionId))
    runs.set(actionId, run)
    return run
  }
  const api = {
    list, get,
    async prepare(value) {
      if (isClosing()) throw new Error('task_action_runtime_closed')
      const adapter = adapterFor(value)
      if (!nonempty(value.taskId) || !Number.isInteger(value.inputVersion) || value.inputVersion < 1 || !Number.isInteger(value.runSequence) || value.runSequence < 1 || value.actionId !== undefined && !nonempty(value.actionId)) throw new Error('task_action_input_invalid')
      const params = canonical(await adapter.parseParams(copy(value.params)))
      const resourceKeys = references(await adapter.normalizeResourceKeys(copy(params)), 'task_action_resource_keys_required')
      const authorizationRefs = references(value.authorizationRefs, 'task_action_authorization_refs_required')
      const body = { taskId: value.taskId, adapterId: value.adapterId, inputVersion: value.inputVersion, runSequence: value.runSequence, params, resourceKeys, authorizationRefs }
      const digest = fingerprint(body)
      const intent = { ...body, actionId: value.actionId ?? stableId('action', digest), digest, status: 'prepared', attempt: 0 }
      return serialize(async () => {
        if (isClosing()) throw new Error('task_action_runtime_closed')
        const existing = get(intent.actionId)
        if (existing) {
          if (existing.digest !== digest) throw new Error(`task_action_identity_conflict:${intent.actionId}`)
          // 幂等查询不产生新副作用；授权撤销后不能借 prepare 发起新调用。
          await authorized(intent, 'prepare')
          return existing
        }
        await authorized(intent, 'prepare')
        claim(intent)
        return save(intent)
      })
    },
    execute(actionId) {
      return singleFlight(actionId, async () => {
        if (isClosing()) throw new Error('task_action_runtime_closed')
        let intent = get(actionId)
        if (!intent) throw new Error(`task_action_not_found:${actionId}`)
        adapterFor(intent)
        // 执行中的存量记录可能在发送之后崩溃。只能读回，不能重新执行。
        if (['executing', 'unknown'].includes(intent.status)) return readback(intent)
        if (intent.status === 'confirmed' || intent.status === 'failed' && (!intent.retryable || now() < intent.nextRetryAt)) return intent
        intent = await serialize(async () => {
          if (isClosing()) throw new Error('task_action_runtime_closed')
          const current = get(actionId)
          if (!['prepared', 'failed'].includes(current.status) || current.attempt >= 3) throw new Error(`task_action_retry_forbidden:${actionId}`)
          await authorized(current, 'execute')
          if (isClosing()) throw new Error('task_action_runtime_closed')
          claim(current)
          return save({ ...current, status: 'executing', attempt: current.attempt + 1, retryable: false, nextRetryAt: undefined, definitelyNotApplied: undefined })
        })
        if (isClosing()) return get(actionId)
        let result
        try { result = await adapterFor(intent).execute(copy(intent)) } catch (error) { result = { status: 'unknown', error: String(error?.message ?? error) } }
        // execute 的“成功”不构成确认；必须从适配器独立读回。
        if (result?.status === 'failed' && result.definitelyNotApplied === true) return serialize(() => save(outcome(intent, result)))
        return readback(intent)
      })
    },
    reconcile(actionId) {
      return singleFlight(actionId, async () => {
        const intent = get(actionId)
        if (!intent) throw new Error(`task_action_not_found:${actionId}`)
        if (!['executing', 'unknown'].includes(intent.status)) return intent
        return readback(intent)
      })
    },
    cancelPrepared(taskId) {
      return serialize(async () => {
        const task = store.getTask(taskId)
        if (!task || !isCancelled(task)) throw new Error(`task_action_cancellation_required:${taskId}`)
        const cancelled = []
        for (const intent of list(taskId)) {
          if (intent.error === 'task_action_cancelled' || intent.status !== 'prepared' && !(intent.status === 'failed' && intent.definitelyNotApplied)) continue
          cancelled.push(await save({ ...intent, status: 'failed', definitelyNotApplied: true, retryable: false, nextRetryAt: undefined,
            error: 'task_action_cancelled', cancelledAt: new Date(now()).toISOString(), stopRequest: copy(task.stopRequest),
            receiptRefs: intent.receiptRefs ?? [`host-prepared-never-executed:${intent.actionId}`] }))
        }
        return cancelled
      })
    },
    async recover() {
      // 恢复只对账；新执行及已知未生效后的重试由 Host 明确调度。
      return Promise.allSettled(list().filter(intent => ['executing', 'unknown'].includes(intent.status)).map(intent => api.reconcile(intent.actionId)))
    },
  }
  return api
}
