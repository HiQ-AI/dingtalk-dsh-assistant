import { deliverTaskNotification, recallTaskOperatorNotification } from './notification-delivery.js'
import { inspectStoppedNativeOperation, inspectInvestigatedNativeFailure, inspectFailedNativeWebRead, inspectFailedNativeFileMutation, inspectFailedNativeJobRead, readNativeOperationContext, readExecutionProgress } from './dynamic-operation-readback.js'
import { isNativeFilePrecondition } from './dynamic-filesystem-scope.js'
import { safeNotificationDetail } from './notification-delivery.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, lstat, link, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { openDynamicTaskStore, ingressTimestamp } from './dynamic-task-store.js'
import { createTaskSessions, isTaskProviderTransient } from './task-session.js'
import { inspectSession } from './session-persistence.js'
import { createExecutionSessions } from './execution-session.js'
import { createTaskSessionObservability } from './task-session-observability.js'
import { openTaskTopicCoordinator } from './task-topic-coordinator.js'
import { resolveTopicMessages, stableId } from './topic-model.js'
import { ingestTaskResidentMessage, projectTaskNotification, stableTaskResourceIdentity, mergeTaskResources, taskBoardState } from './task-message-projections.js'
import { executionSessionTitle, taskWorkspace, taskExecutionWorkspace, taskDirectories, checkedTaskDirectory } from './session-workspaces.js'
import { installTaskSessionPersistence, taskSessionLogRoot } from './task-session-persistence.js'
import { formatTaskGroupReply } from './group-reply-format.js'
import { sameDeliveredText } from './group-message.js'
import { taskExecutionContext } from './execution-context.js'
import { assertTaskContextSemantics, taskContextInputContract } from './task-input-contract.js'
import { projectTaskTimeline, readTaskLifecycle, latestExecutionRoundTiming } from './task-execution-timeline.js'
export { taskExecutionContext } from './execution-context.js'

const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const clean = value => JSON.parse(JSON.stringify(value))
const string = { type: 'string' }
const texts = { type: 'array', items: string }
export function executionProgressDue(execution, now = Date.now()) {
  const last = Date.parse(execution.progressReview?.checkedAt ?? execution.updatedAt)
  return execution.status === 'running' && !execution.drained && !execution.recovering && !execution.cancelRequested
    && Number.isFinite(last) && now - last >= 10 * 60 * 1000
}
export const dynamicExecutionOutputSchema = { type: 'object', properties: {
  status: { type: 'string', enum: ['completed','blocked','needs_input'] }, summary: { type: 'string' },
  evidence: texts, limitations: texts, artifacts: texts, question: string,
}, required: ['status','summary','evidence','limitations','artifacts'], additionalProperties: false }
/** All model decisions pass through this Host boundary. No workflow catalog or staged plan exists here. */
export async function openTaskSessionService({ ctx, config, legacy, residentStore, notifications, readResource,
  taskSessions: suppliedTaskSessions, executionSessions: suppliedExecutionSessions,
  store: suppliedStore, persistence: suppliedPersistence } = {}) {
  if (!config?.dbPath || !config?.instanceId) fail('TASK_SESSION_CONFIGURATION_REQUIRED')
  for (const value of [config.maxConcurrentExecutions, config.maxConcurrentTasks, legacy.getAgentConfig().maxConcurrentTasks]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 50)) fail('TASK_SESSION_CONCURRENCY_INVALID')
  }
  const root = resolve(config.workspaceDir ?? legacy.getAgentConfig().workspaceDir)
  await mkdir(dirname(config.dbPath), { recursive: true })
  const store = suppliedStore ?? await openDynamicTaskStore({ dbPath: config.dbPath, instanceId: config.instanceId,
    initialize: config.initialize === true, ingressEpoch: config.ingressEpoch, webActorId: config.webActorId })
  let persistence
  try {
    persistence = suppliedPersistence ?? await installTaskSessionPersistence(ctx, { root })
  } catch (error) {
    if (!suppliedStore) await store.close()
    throw error
  }
  const inflightTasks = new Map(), inflightExecutions = new Map(), inflightGroups = new Map(), inflightNotifications = new Map()
  const failures = new Map(), taskSlots = new Set()
  const pendingDialogue = task => task.dialogue?.some(item => !item.reply)
  const taskLimit = () => legacy.getAgentConfig().maxConcurrentTasks ?? config.maxConcurrentTasks ?? 5
  const executionLimit = () => config.maxConcurrentExecutions ?? taskLimit()
  const reserveTask = taskId => taskSlots.has(taskId) || taskSlots.size < taskLimit() && (taskSlots.add(taskId), true)
  const retryReady = id => {
    const task = taskCache.get(id), recovery = task?.providerRecovery
    if (recovery) return recovery.requirementRevision !== task.requirementRevision
      || !!recovery.nextAttemptAt && Date.parse(recovery.nextAttemptAt) <= Date.now()
    return (failures.get(id)?.retryAfter ?? 0) <= Date.now()
  }
  let closed = false, recovering, scheduling, scheduleRequested = false, providerRetryTimer
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const taskCache = new Map(), operationCache = new Map(), notificationCache = new Map(), executionCache = new Map()
  const refreshTasks = async () => { taskCache.clear(); for (const task of await query('task.list')) taskCache.set(task.taskId, topicTaskView(task)) }
  function topicTaskView(task) { return { ...task, state: task.status === 'completed' ? 'completed' : task.control === 'cancelled' ? 'cancelled' : task.control === 'paused' || task.drained ? 'waiting' : 'running', inputVersion: task.requirementRevision, runSequence: task.runSequence ?? 1, topicRefs: task.topicRefs ?? [], appliedOperations: task.appliedOperations ?? [], acceptanceCriteria: task.requirements ?? [], taskPromptRefs: [] } }
  const command = async (kind, args, id = `${kind}:${randomUUID()}`) => {
    const receipt = await store.command({ id, kind, args: clean(args) })
    // 幂等收据保存的是当时快照；通知当前态须独立回读，不能用旧 prepared 覆盖已送达缓存。
    if (receipt.replayed && receipt.result?.notification)
      receipt.result.notification = await query('notification.get', { notificationId: receipt.result.notification.id })
    if (receipt.result?.execution) executionCache.set(receipt.result.execution.executionId,
      receipt.replayed && kind === 'execution.progressReported' ? await query('execution.get', { executionId: receipt.result.execution.executionId }) : receipt.result.execution)
    if (receipt.result?.operation) operationCache.set(receipt.result.operation.id ?? receipt.result.operation.operationId, receipt.result.operation)
    // 人工结清是复合事务，只返回任务；从账本刷新其中已结清的操作，避免残留 unknown 告警。
    if (kind === 'task.human.resolve-failures') for (const resolution of args.resolutions) {
      const operation = await query('operation.get', { operationId: resolution.operationId })
      operationCache.set(operation.id ?? operation.operationId, operation)
    }
    if (receipt.result?.notification) notificationCache.set(receipt.result.notification.id, receipt.result.notification)
    if (receipt.result?.notification) await projectTaskNotification({ residentStore, notification: receipt.result.notification })
    if (receipt.result?.task) taskCache.set(receipt.result.task.taskId, topicTaskView(receipt.result.task))
    return receipt
  }
  await refreshTasks()
  for (const item of await query('operation.list')) operationCache.set(item.id ?? item.operationId, item)
  for (const item of await query('notification.list')) notificationCache.set(item.id, item)
  for (const item of await query('execution.list')) executionCache.set(item.executionId, item)
  // 仅为启动时已停住的技术等待补一次唤醒；同一实现重启不能反复驱动模型。
  const runtimeRevision = hash(await Promise.all(['task-session-service.js', 'task-session.js', 'execution-session.js', 'dynamic-native-job.js', 'dynamic-operation-readback.js']
    .map(file => readFile(new URL(file, import.meta.url), 'utf8'))))
  const recoveryCandidates = [...taskCache.values()].filter(task => !task.archivedAt && task.status === 'active' && task.control === 'active'
    && task.drained && !task.lastDecision?.question && (task.lastDecision?.action === 'blocked'
      && task.lastDecision.limitations?.includes('TASK_SESSION_NO_SUBMISSION')
      || task.lastDecision?.action === 'wait'
      && [...operationCache.values()].some(operation => operation.taskId === task.taskId && operation.state === 'unknown')))
  const receiptMessageId = value => value?.messageId ?? value?.messageRef?.openMessageId ?? value?.sendReceipt?.messageId ?? value?.result?.messageId ?? value?.result?.openMessageId
  const isOwnNotification = message => {
    const actorId = message.senderOpenDingTalkId ?? message.actorId
    if (config.assistantActorId && actorId === config.assistantActorId && message.messageAiSendFlag === 'DWS') return true
    return !!message.messageId && [...notificationCache.values()].some(item => {
      if (item.payload?.conversationId !== message.groupId) return false
      if ([receiptMessageId(item.receipt), receiptMessageId(item.ack)].includes(message.messageId)) return true
      if (!config.assistantActorId || actorId !== config.assistantActorId || !['starting', 'unknown', 'delivered'].includes(item.state)
        || message.quotedMessage?.messageId !== item.payload.sourceMessageId) return false
      const sender = message.quotedMessage?.sender ?? message.quotedMessage?.senderName
        ?? residentStore?.getGroup(message.groupId)?.messages.find(source => source.messageId === item.payload.sourceMessageId)?.senderName
      return sameDeliveredText(message.text, item.payload.text, { sender })
    })
  }
  const observation = createTaskSessionObservability({ store: residentStore, listTasks: () => [...taskCache.values()], resolveSessionIdentity: sessionId => {
    const task = [...taskCache.values()].find(item => item.sessionId === sessionId && item.sessionBound)
    if (task) return { taskId: task.taskId, groupId: task.groupId, role: 'owner' }
    const execution = [...executionCache.values()].find(item => item.sessionId === sessionId && item.sessionBound)
    if (execution) return { taskId: execution.taskId, groupId: taskCache.get(execution.taskId)?.groupId, role: 'execution' }
    return null
  } })
  let observationTail = Promise.resolve()
  const stopObservation = ctx.on?.('session/event', (session, event) => {
    observationTail = observationTail.then(() => observation.observe(session, event)).catch(error => failures.set('observability', { id: 'observability', code: error.code ?? error.message }))
  })
  residentStore?.setTaskSessionReader?.({ getTask: id => taskCache.get(id), listTasks: () => [...taskCache.values()],
    isTaskQuiescent: taskId => [...executionCache.values()].filter(item => item.taskId === taskId).every(item => item.drained && !item.recovering) })
  const models = () => { const { provider, model, reasoningEffort } = legacy.getAgentConfig(); return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }
  const currentTask = async binding => {
    const task = await query('task.get', { taskId: binding.taskId })
    return !!task && !task.archivedAt && !task.recovering && !task.drained && task.status === 'active' && task.control === 'active' && task.sessionId === binding.sessionId
      && task.leaseEpoch === binding.leaseEpoch && task.requirementRevision === binding.requirementRevision && task.controlRevision === binding.controlRevision
      && (task.contextRevision ?? 0) === (binding.contextRevision ?? 0)
  }
  const taskSessions = suppliedTaskSessions ?? createTaskSessions({ ctx, isCurrent: currentTask, withPersistenceWriter: (binding, action) => persistence.runOwned(binding, action),
    getWorkspaceDir: ({ binding }) => taskWorkspace(root, binding.taskId), registerPersistence: value => persistence.register(value) })
  const executionSessions = suppliedExecutionSessions ?? createExecutionSessions({ ctx, withPersistenceWriter: (binding, action) => persistence.runOwned(binding, action), registerPersistence: value => persistence.register(value),
    isCurrent: binding => query('execution.current', { binding }),
    getWorkspaceDir: ({ binding }) => taskExecutionWorkspace(root, binding.taskId, binding.sessionId),
  })
  const track = (map, id, action) => {
    if (map.has(id)) return map.get(id)
    const previousFailure = failures.get(id)
    const promise = Promise.resolve().then(action).then(async value => {
      const settled = map !== inflightTasks || (await query('task.get', { taskId: id }))?.drained
      if (settled && failures.get(id) === previousFailure) failures.delete(id)
      return value
    }).catch(error => {
      const recovery = taskCache.get(id)?.providerRecovery
      failures.set(id, { id, code: error.code ?? error.message, at: new Date().toISOString(),
        ...(recovery ? { retryAfter: recovery.nextAttemptAt ? Date.parse(recovery.nextAttemptAt) : null, suspended: recovery.suspended }
          : { retryAfter: Date.now() + Math.max(100, config.retryIntervalMs ?? 5000) }) })
      ctx.logger?.warn?.(`task-session ${id}: ${error.code ?? error.message}`)
      throw error
    }).finally(async () => {
      let again = false
      if (!closed && map === inflightTasks) {
        const pending = await query('wake.list', { taskId: id }).catch(() => [])
        const task = await query('task.get', { taskId: id }).catch(() => null)
        again = !task?.archivedAt && task?.status === 'active' && task.control === 'active' && task.drained
          && retryReady(id)
          && (pendingDialogue(task) || !task.humanRequests?.some(request => request.status === 'waiting-reply'))
          && pending.some(item => item.state !== 'acked')
      }
      map.delete(id)
      if (!closed && (map === inflightTasks || map === inflightExecutions)) {
        const taskId = map === inflightTasks ? id : (await query('execution.get', { executionId: id }).catch(() => null))?.taskId
        if (taskId && !inflightTasks.has(taskId)) {
          const task = await query('task.get', { taskId }).catch(() => null)
          const executions = await query('execution.list', { taskId }).catch(() => [])
          if (!task || task.drained && !executions.some(item => !item.drained || item.status === 'queued' && !item.providerRecovery?.nextAttemptAt)) taskSlots.delete(taskId)
        }
      }
      if (again) void kickTask(id)
      if (!closed && (map === inflightTasks || map === inflightExecutions)) void schedulePending()
    })
    map.set(id, promise)
    promise.catch(() => {})
    return promise
  }
  async function verifyProviderTerminal(execution, binding = undefined) {
    binding ??= await query('execution.binding', { executionId: execution.executionId })
    executionSessions.assertDrained(binding)
    const jobs = ctx.get?.('jobs')
    if (jobs?.list?.(execution.sessionId).some(job => ['running','stopping'].includes(job.status))) fail('DYNAMIC_JOB_DRAIN_UNPROVEN')
    const stored = await inspectSession(ctx.sessionPersistence, execution.sessionId)
    const end = stored.events.findLast(event => event.type === 'turn/end')
    const input = stored.events.findLast(event => event.type === 'user/message' && event.data.source?.executionSession)
    if (end?.seq !== execution.providerRecovery.terminal.endSeq || end.data.reason?.kind !== 'error'
      || hash(end.data.reason.error) !== hash(execution.result.payload.error.providerError)
      || input?.data.source.executionSession.inputVersion !== binding.inputVersion
      || input.data.source.executionSession.inputDigest !== binding.inputDigest
      || input.data.source.executionSession.leaseEpoch !== binding.leaseEpoch || end.seq <= input.seq) fail('DYNAMIC_PROVIDER_TERMINAL_EVIDENCE_CHANGED')
    return binding
  }
  function armProviderRetry() {
    clearTimeout(providerRetryTimer)
    if (closed) return
    const now = Date.now(), due = [...executionCache.values()].filter(execution => ['queued','failed'].includes(execution.status)
      && (execution.providerRecovery?.nextAttemptAt || execution.providerRecovery?.nextReviewAt) && !execution.cancelRequested)
      .map(execution => Date.parse(execution.providerRecovery.nextAttemptAt ?? execution.providerRecovery.nextReviewAt))
      .concat([...taskCache.values()].filter(task => !task.archivedAt && task.status === 'active' && task.control === 'active' && task.providerRecovery?.nextAttemptAt)
        .map(task => Date.parse(task.providerRecovery.nextAttemptAt))).filter(at => at > now)
    if (due.length) {
      providerRetryTimer = setTimeout(() => { void schedulePending() }, Math.min(...due) - now)
      providerRetryTimer.unref()
    }
  }
  function schedulePending() {
    if (closed) return Promise.resolve()
    scheduleRequested = true
    if (scheduling) return scheduling
    scheduling = (async () => {
      while (scheduleRequested && !closed) {
        scheduleRequested = false
        for (const execution of await query('execution.list')) {
          if (closed) return
          const review = execution.status === 'failed' && execution.providerRecovery?.nextReviewAt
          if (!(review || execution.status === 'queued' && execution.providerRecovery?.nextAttemptAt) || !execution.drained || execution.recovering
            || Date.parse(review || execution.providerRecovery.nextAttemptAt) > Date.now()) continue
          const task = await requireTask(execution.taskId)
          if (task.archivedAt || task.status !== 'active' || task.control !== 'active' || task.humanRequests?.some(item => item.status === 'waiting-reply')
            || !review && execution.requirementRevision !== task.requirementRevision || execution.controlRevision !== task.controlRevision
            || execution.cancelRequested) continue
          if ((await query('wake.list', { taskId: task.taskId })).some(item => item.kind === 'human.responded' && item.state !== 'acked')) continue
          let binding
          try {
            binding = await query('execution.binding', { executionId: execution.executionId })
            await verifyProviderTerminal(execution, binding)
            await command(review ? 'execution.review-provider' : 'execution.retry-provider', { binding },
              `provider-${review ? 'review' : 'retry'}:${execution.executionId}:${execution.inputVersion}${review ? ':' + execution.providerRecovery.nextReviewAt : ''}`)
            failures.delete(execution.executionId)
          } catch (error) {
            failures.set(execution.executionId, { id: execution.executionId, code: error.code ?? error.message, at: new Date().toISOString() })
            if (binding) {
              try { await command('execution.provider-recovery-blocked', { binding, code: error.code ?? error.message }, `provider-recovery-blocked:${execution.executionId}:${execution.inputVersion}`) }
              catch (recordError) { failures.set(execution.executionId, { id: execution.executionId, code: 'DYNAMIC_PROVIDER_RECOVERY_RECORD_FAILED',
                cause: error.code ?? error.message, recordError: recordError.code ?? recordError.message, at: new Date().toISOString() }) }
            }
          }
        }
        // SQLite is the durable queue. A freed slot promotes existing work immediately,
        // without depending on a periodic recovery tick or manufacturing another wake.
        for (const task of await query('task.list')) {
          if (closed) return
          if (task.archivedAt || !retryReady(task.taskId) || inflightTasks.has(task.taskId) || !task.drained || task.recovering || task.status !== 'active' || task.control !== 'active') continue
          if (!pendingDialogue(task) && task.humanRequests?.some(request => request.status === 'waiting-reply')) continue
          if (!taskSlots.has(task.taskId) && taskSlots.size >= taskLimit()) continue
          if ((await query('wake.list', { taskId: task.taskId })).some(item => item.state !== 'acked')) void kickTask(task.taskId)
        }
        for (const execution of await query('execution.list')) {
          if (closed || inflightExecutions.size >= executionLimit()) break
          if (execution.providerRecovery?.nextAttemptAt || !retryReady(execution.executionId) || inflightExecutions.has(execution.executionId) || !execution.drained || execution.recovering || execution.status !== 'queued' || execution.cancelRequested) continue
          if (!taskSlots.has(execution.taskId) && taskSlots.size >= taskLimit()) continue
          void kickExecution(execution.executionId)
        }
      }
    })().catch(error => { failures.set('scheduler', { id: 'scheduler', code: error.code ?? error.message }) })
      .finally(() => { scheduling = undefined; armProviderRetry() })
    return scheduling
  }
  async function attachWorkspace(sessionId, cwd, title) {
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
    if (!registry) { if (!suppliedTaskSessions && !suppliedExecutionSessions) fail('TASK_WORKSPACE_REGISTRY_REQUIRED'); return }
    await registry.sessionKnown(sessionId)
    const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd, title)
    // A registry initialized before task-specific persistence may have retained the
    // durable slot without its header index. Rebind that same slot via public APIs.
    if (!workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
    await workspace.attachSession(sessionId)
    if (title?.trim() && workspace.title !== title.trim()) await workspace.setTitle(title.trim())
  }
  const sourceFor = async task => {
    const id = task.metadata?.authorizationSourceId
    if (id) return query('source.get', { sourceId: id })
    const sources = await Promise.all(task.sourceRefs.map(sourceId => query('source.get', { sourceId })))
    return sources.find(source => source?.actorId === task.ownerActorId)
  }
  const requireTask = async taskId => (await query('task.get', { taskId })) ?? fail('TASK_SESSION_NOT_FOUND')
  const taskDTO = async task => {
    const { dialogue: _dialogue, ...publicTask } = task
    const executions = await query('execution.list', { taskId: task.taskId })
    const pendingWake = !task.lastDecision && (await query('wake.list', { taskId: task.taskId })).some(wake => wake.state !== 'acked')
    const state = taskBoardState(task, executions, pendingWake)
    return { ...publicTask, state, contextInputContract: taskContextInputContract,
    topicRefs: task.topicRefs ?? [], executionCount: executions.length,
    executionSessions: [...new Map(executions.map(execution => [execution.sessionId || execution.executionId, {
      executionId: execution.executionId, sessionId: execution.sessionId, title: executionSessionTitle(execution), status: execution.status, createdAt: execution.createdAt,
      runTiming: execution.runTiming ?? null,
      latestRoundTiming: latestExecutionRoundTiming(execution),
      drained: execution.drained, recovering: execution.recovering === true,
    }])).values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.executionId.localeCompare(b.executionId)), waitingReason: state === 'waiting' ? task.lastDecision?.summary ?? '' : '',
    controlState: task.control, inputVersion: task.requirementRevision, result: task.completion?.result ?? task.lastDecision ?? null,
    session: { sessionId: task.sessionId, sessionBound: task.sessionBound, status: task.drained ? 'idle' : 'running', workspaceDir: await taskWorkspace(root, task.taskId), logPath: taskSessionLogRoot(root, task.taskId) },
    legacyReadonly: false }
  }
  async function taskDetail(taskId) {
    const task = await query('task.get', { taskId })
    if (!task) return null
    const wakes = await query('wake.list', { taskId })
    const lifecycle = await readTaskLifecycle(task, wakes, id => query('receipt.get', { id }))
    return { ...await taskDTO(task), executions: (await taskExecutions(taskId)).executions,
      timeline: projectTaskTimeline(task, await query('execution.list', { taskId }), wakes, lifecycle),
      blockers: await query('task.blockers', { taskId }), notifications: await query('notification.list', { taskId }) }
  }
  async function taskExecutions(taskId, { offset = 0, limit = 50 } = {}) {
    const all = await query('execution.list', { taskId })
    const executions = await Promise.all(all.slice(offset, offset + limit).map(async execution => ({ ...execution, title: executionSessionTitle(execution), objective: execution.prompt,
      workspaceDir: await taskWorkspace(root, taskId), workingDirectory: await taskExecutionWorkspace(root, taskId, execution.sessionId), logPath: taskSessionLogRoot(root, taskId),
      result: execution.result?.payload?.output ?? execution.result?.payload?.error ?? null })))
    return { executions, total: all.length, offset, limit }
  }
  async function materializeSource(taskId, source) {
    const directories = await taskDirectories(root, taskId, { create: true })
    const target = join(directories.materials, `source-${hash(source.sourceId).slice(0, 32)}.json`)
    const readSnapshot = async () => {
      await checkedTaskDirectory(directories.materials)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) fail('TASK_MATERIAL_PATH_INVALID')
      let material
      try { material = JSON.parse(await readFile(target, 'utf8')) } catch { fail('TASK_MATERIAL_SNAPSHOT_INVALID') }
      if (!material || material.sourceId !== source.sourceId || material.path !== target || material.taskId !== undefined && material.taskId !== taskId
        || material.version !== undefined && material.version !== source.version || material.actorId !== source.actorId || material.messageId !== source.messageId || material.text !== source.text
        || hash(material.quote ?? null) !== hash(source.quote ?? null) || !Array.isArray(material.resources)
        || material.resources.length !== (source.resources ?? []).length) fail('TASK_MATERIAL_SOURCE_MISMATCH')
      for (const [index, resource] of material.resources.entries()) {
        if (!resource || !source.resources.some(item => stableTaskResourceIdentity([resource.resource]) === stableTaskResourceIdentity([item]))) fail('TASK_MATERIAL_SOURCE_MISMATCH')
        if (resource.status === 'unavailable') {
          if (resource.path !== undefined || resource.value !== undefined) fail('TASK_MATERIAL_SNAPSHOT_INVALID')
          continue
        }
        if (resource.status !== 'read' || resource.complete !== true || typeof resource.path !== 'string'
          || dirname(resource.path) !== directories.materials || !/^[a-f0-9]{64}$/.test(resource.sha256 ?? '')
          || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > 8 * 1024 * 1024) fail('TASK_MATERIAL_PATH_INVALID')
        let bytes
        try {
          const entry = await lstat(resource.path)
          if (!entry.isFile() || entry.isSymbolicLink()) fail('TASK_MATERIAL_PATH_INVALID')
          bytes = await readFile(resource.path)
        } catch (error) { if (error.code === 'ENOENT') fail('TASK_MATERIAL_CONTENT_MISSING'); throw error }
        if (bytes.length !== resource.bytes || createHash('sha256').update(bytes).digest('hex') !== resource.sha256
          || typeof resource.value?.text === 'string' && !bytes.equals(Buffer.from(resource.value.text, 'utf8'))
          || resource.value?.image && resource.value.image.path !== resource.path) fail('TASK_MATERIAL_CONTENT_CHANGED')
      }
      await checkedTaskDirectory(directories.materials)
      if (typeof source.text === 'string' && Buffer.byteLength(source.text) >= 512) {
        const textPath = target.replace(/\.json$/, '.txt')
        await publish(textPath, Buffer.from(source.text, 'utf8'))
        return { ...material, version: source.version, textPath }
      }
      return material
    }
    const publish = async (path, bytes) => {
      await checkedTaskDirectory(directories.materials)
      const temporary = join(directories.materials, `.pending-${randomUUID()}`)
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try {
        await checkedTaskDirectory(directories.materials)
        await link(temporary, path).catch(error => { if (error.code !== 'EEXIST') throw error })
      } finally { await unlink(temporary) }
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) fail('TASK_MATERIAL_PATH_INVALID')
      if (!(await readFile(path)).equals(bytes)) fail('TASK_MATERIAL_CONTENT_CHANGED')
    }
    try {
      return await readSnapshot()
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const resources = []
    for (const resource of source.resources ?? []) {
      if (!readResource) { resources.push({ resource, status: 'unavailable', reason: 'resource_reader_not_configured' }); continue }
      try {
        const value = await readResource(source.groupId, source.messageId, resource)
        const text = typeof value?.text === 'string'
        const image = value?.image?.data instanceof Uint8Array && value.image.data.byteLength > 0
        if (!value || value.complete === false || value.hasMore === true || value.failures?.length || value.mediaUnavailable?.length || !text && !image) fail('RESOURCE_READ_INCOMPLETE')
        const bytes = text ? Buffer.from(value.text, 'utf8') : Buffer.from(value.image.data)
        if (bytes.length > 8 * 1024 * 1024) fail('RESOURCE_READ_TOO_LARGE')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const extension = text ? '.txt' : ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[value.image.mediaType] ?? '.bin')
        const path = join(directories.materials, `resource-${hash([source.sourceId, resource]).slice(0, 16)}-${sha256.slice(0, 16)}${extension}`)
        await publish(path, bytes)
        resources.push({ resource, status: 'read', complete: true, path, bytes: bytes.length, sha256,
          value: text ? clean(value) : { image: { mediaType: value.image.mediaType, name: value.image.name, path, bytes: bytes.length, sha256 } } })
      }
      catch (error) { resources.push({ resource, status: 'unavailable', reason: error.code ?? 'RESOURCE_READ_FAILED' }) }
    }
    const material = clean({ taskId, sourceId: source.sourceId, version: source.version, actorId: source.actorId, messageId: source.messageId,
      text: source.text, quote: source.quote, resources, path: target })
    await publish(target, Buffer.from(JSON.stringify(material)))
    return readSnapshot()
  }
  async function cancelLiveTask(taskId) {
    const list = await query('execution.list', { taskId })
    await Promise.all([taskSessions.cancel(taskId), ...list.filter(item => !item.drained).map(item => executionSessions.cancel(item.executionId))])
    await Promise.allSettled([inflightTasks.get(taskId), ...list.map(item => inflightExecutions.get(item.executionId))].filter(Boolean))
  }
  async function projectSource(source) {
    if (source.routed || source.channel === 'web' || !residentStore) return
    const message = residentStore.getGroup(source.groupId)?.messages.find(item => item.messageId === source.messageId)
    if (!message || message.routingStatus !== 'routed') return
    if (source.version < message.messageVersion) {
      await command('source.routed', { sourceId: source.sourceId, receipt: [{ supersededByVersion: message.messageVersion }] }, `topic-routed:${source.sourceId}`)
      return
    }
    const refs = residentStore.listTopics(source.groupId).filter(topic => resolveTopicMessages(residentStore.getGroup(source.groupId), topic.topicId, topic.revision).some(item => item.messageId === source.messageId && item.messageVersion === source.version))
    if (refs.some(topic => topic.processedRevision < topic.revision)) return
    await command('source.routed', { sourceId: source.sourceId, receipt: refs.map(topic => ({ topicId: topic.topicId, revision: topic.revision })) }, `topic-routed:${source.sourceId}`)
  }
  async function applyTopicAction(groupId, action, operation, record) {
    if (action.kind === 'task-proposal') return
    // Also guard durable actions accepted by older schemas before any cancellation.
    if (action.kind === 'task-context') assertTaskContextSemantics(action)
    // 固定话题历史可能保留早期通知回声；它们仅是上下文，不是准入的用户来源。
    const topicSources = [...new Map(action.topicRefs.flatMap(ref => resolveTopicMessages(residentStore.getGroup(groupId), ref.topicId, ref.revision))
      .filter(message => !isOwnNotification({ ...message, groupId })).map(message => [message.messageId, message])).values()]
    const available = await query('source.list', { groupId })
    const sources = []
    for (const message of topicSources) {
      let source = available.find(source => source.messageId === message.messageId && source.version === message.messageVersion)
      if (!source) {
        const admitted = available.filter(source => source.messageId === message.messageId && source.version < message.messageVersion).sort((a, b) => b.version - a.version)[0]
        if (!admitted) fail('TASK_TOPIC_SOURCE_VERSION_MISSING')
        const sourceId = `im:${hash([groupId, message.messageId, message.messageVersion])}`
        const receipt = await command('source.captureRevision', { sourceId, groupId, messageId: message.messageId, version: message.messageVersion,
          actorId: message.senderOpenDingTalkId ?? admitted.actorId, senderName: message.senderName ?? admitted.senderName,
          text: message._sourceMessageText ?? message.text, quote: message.quotedMessage ?? null,
          resources: message.resourceRefs ?? message.imageRefs ?? [], timestamp: message.occurredAt,
          admissionSourceId: admitted.sourceId }, `topic-source:${sourceId}`)
        source = receipt.result.source
      }
      sources.push(source)
    }
    const actionUnits = action.topicRefs.flatMap(ref => resolveTopicMessages(residentStore.getGroup(groupId), ref.topicId, ref.revision))
      .filter(message => (action.basisUnitRefs ?? record.decision.basisUnitRefs).some(ref => ref.unitId === message.unitId && ref.unitRevision === message.unitRevision))
    const basis = sources.filter(source => actionUnits.some(message => message.messageId === source.messageId))
    const existingTask = action.kind === 'new-task' ? null : await requireTask(operation.taskId)
    if (existingTask?.archivedAt) fail('DYNAMIC_TASK_ARCHIVED_CONFLICT')
    // 群续办按本次真实来源接纳；最初发起人身份不代表后续交办的唯一作者。
    const source = basis.findLast(item => item.groupId === groupId && item.actorId
      && (item.channel === 'web' ? item.actorId === config.webActorId : item.channel !== 'internal')
      && (action.kind !== 'task-cancel' || [existingTask?.ownerActorId, config.ownerActorId].includes(item.actorId)))
    if (!source) fail('TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED')
    if (existingTask && existingTask.groupId !== source.groupId) fail('TASK_SESSION_SOURCE_FORBIDDEN')
    const refs = action.topicRefs
    const id = `topic-operation:${operation.operationId}`
    if (await query('receipt.get', { id })) return
    let task
    if (action.kind === 'new-task') {
      const receipt = await command('task.create', { taskId: operation.taskId, groupId, ownerActorId: source.actorId,
        sourceRefs: sources.map(item => item.sourceId), topicRefs: refs, operationId: operation.operationId,
        title: action.title, objective: action.objective, request: sources.map(item => item.text).join('\n\n'),
        requirements: action.acceptanceCriteria ?? [], metadata: { channel: source.channel ?? 'im', authorizationSourceId: source.sourceId } }, id)
      task = receipt.result.task
    } else {
      task = await requireTask(operation.taskId)
      if (action.kind === 'task-context' && action.progressImpact === 'preserve' && action.title !== undefined && action.title !== task.title) fail('TASK_CONTEXT_CLASSIFICATION_CONFLICT')
      const topicRefs = [...new Map([...(task.topicRefs ?? []), ...refs].map(ref => [ref.topicId, ref])).values()]
      const args = { taskId: task.taskId, expectedRequirementRevision: action.inputVersion, expectedControlRevision: task.controlRevision,
        topicRefs, operationId: operation.operationId }
      const changesRequirements = action.authorizationChange === 'changed' || action.progressImpact === 'replan' || action.impactEvidence !== undefined
        || action.objective !== undefined || action.acceptanceCriteria !== undefined || action.stageTasks !== undefined
      const pendingHuman = action.kind === 'task-context' && !changesRequirements ? task.humanRequests?.findLast(request => request.status === 'waiting-reply'
        && request.audience === 'requester' && source.actorId === task.ownerActorId
        && Date.parse(source.timestamp) >= Date.parse(request.createdAt)) : null
      const supplement = action.kind === 'task-context' && action.progressImpact === 'preserve' && action.authorizationChange !== 'changed'
        && !changesRequirements && (action.title === undefined || action.title === task.title)
      const receipt = action.kind === 'task-cancel'
        ? await command('task.control', { ...args, control: 'cancelled', reason: action.reason }, id)
        : pendingHuman
        ? await command('task.human.respond', { ...args, requestId: pendingHuman.requestId,
          sourceId: source.sourceId }, id)
        : supplement
        ? await command('task.supplement', { ...args, messageId: id, text: action.context ?? source.text,
          request: `${task.request}\n\n[话题补充]\n${action.context ?? source.text}`,
          sourceRefs: [...new Set([...task.sourceRefs, ...sources.map(item => item.sourceId)])] }, id)
        : await command(action.kind === 'task-reopen' ? 'task.reopen' : 'task.revise', { ...args,
          request: `${task.request}\n\n[话题补充]\n${action.context ?? source.text}`,
          sourceRefs: [...new Set([...task.sourceRefs, ...sources.map(item => item.sourceId)])],
          ...(action.title ? { title: action.title } : {}), ...(action.objective ? { objective: action.objective } : {}),
          ...(action.acceptanceCriteria ? { requirements: action.acceptanceCriteria } : {}) }, id)
      task = receipt.result.task
      if (!pendingHuman && !supplement) await cancelLiveTask(task.taskId)
      if (supplement) for (const execution of await query('execution.list', { taskId: task.taskId })) await executionSessions.feedback(execution.executionId)
    }
    for (const item of sources) await materializeSource(task.taskId, item)
    if (action.kind !== 'task-cancel') void kickTask(task.taskId)
  }
  const topicCoordinator = await openTaskTopicCoordinator({ ctx, store: residentStore, legacy, root, models, applyAction: applyTopicAction,
    appendOutbox: async args => {
      const prepared = (await query('notification.list')).find(item => item.id === args.outboundId)
      if (prepared) {
        // Recovery must reuse the frozen payload even if Agent configuration changed.
        const group = await residentStore.appendOutbox({ ...args, text: prepared.payload.text })
        void deliverNotifications()
        return group
      }
      const sourceText = residentStore.getGroup(args.groupId)?.messages.find(message => message.messageId === args.replyToMessageId)?.text
      const previous = residentStore.getGroup(args.groupId)?.outbox.find(item => item.outboundId === args.outboundId)
      // The resident outbox can survive a crash before notification.prepare.
      const reply = previous ? { text: previous.text } : formatTaskGroupReply({ source: { groupId: args.groupId, messageId: args.replyToMessageId, senderOpenDingTalkId: args.replyToSenderOpenDingTalkId, text: sourceText }, summary: args.text, evidence: [], limitations: [], signature: legacy.getAgentConfig().replySignature, includeSignature: args.replyKind === 'substantive' })
      args = { ...args, ...reply }
      const group = await residentStore.appendOutbox(args)
      const notificationId = args.outboundId
      await command('notification.prepare', { notificationId, taskId: args.taskIds?.[0] ?? null, requirementRevision: 1, kind: 'topic-reply',
        payload: { text: args.text, topicRefs: args.topicRefs, replyKind: args.replyKind, conversationId: args.groupId, sourceMessageId: args.replyToMessageId, actorId: args.replyToSenderOpenDingTalkId,
          replyToMessageId: args.replyToMessageId, replyToSenderOpenDingTalkId: args.replyToSenderOpenDingTalkId, atOpenDingTalkIds: args.atOpenDingTalkIds ?? [], fact: { topicRefs: args.topicRefs }, kind: 'topic-reply' } }, `prepare-notification:${notificationId}`)
      void deliverNotifications()
      return group
    },
    onError: async (groupId, error) => {
      failures.set(groupId, { id: groupId, code: error.code ?? error.message })
      for (const message of residentStore.getGroup(groupId)?.messages ?? []) if (message.agentDeliveryStatus !== 'delivered' && message.agentDeliveryStatus !== 'skipped')
        await residentStore.markMessageAgentDelivery({ groupId, messageId: message.messageId, status: 'decision-failed', error: error.code ?? error.message })
    } })
  function kickGroup(groupId) {
    if (closed) return Promise.resolve()
    return track(inflightGroups, groupId, async () => {
      await refreshTasks()
      await topicCoordinator.schedule(groupId)
      await topicCoordinator.whenIdle()
      for (const source of await query('source.list', { groupId })) await projectSource(source)
      if (!(residentStore.getGroup(groupId)?.messages ?? []).some(message => ['failed','decision-failed','decision-commit-failed'].includes(message.agentDeliveryStatus))) {
        failures.delete(groupId)
      }
    })
  }
  async function ingest(message) {
    if (closed) fail('TASK_SESSION_CLOSED')
    if (!legacy.getGroup(message.groupId)) fail('group_not_subscribed')
    const actorId = message.senderOpenDingTalkId ?? message.actorId
    if (!actorId) fail('TASK_SESSION_AUTHENTICATED_SOURCE_REQUIRED')
    if (isOwnNotification(message)) {
      return { accepted: false, processing: 'ignored', reason: 'own-notification' }
    }
    const sourceId = `im:${hash([message.groupId, message.messageId, message.messageVersion ?? 1])}`
    // DWS rawOccurredAt is explicit even when absent: never admit its display-time fallback.
    const rawTime = Object.hasOwn(message, 'rawOccurredAt') ? message.rawOccurredAt : message.occurredAt ?? message.timestamp
    // Only the documented DWS local datetime format is Beijing time; ambiguous dates stay invalid.
    const envelopeTime = typeof rawTime === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(rawTime)
      ? rawTime.replace(' ', 'T') + '+08:00' : rawTime
    const actualTime = ingressTimestamp(envelopeTime)
    const original = await query('source.get', { sourceId })
    if (!original) {
      const priorAdmission = await query('receipt.get', { id: `source:${sourceId}` })
      if (priorAdmission?.result?.ignored) return { accepted: false, sourceId, processing: 'quarantined', reason: priorAdmission.result.reason }
    }
    if (original && (original.actorId !== actorId || original.text !== (message.text ?? ''))) fail('DYNAMIC_SOURCE_CONFLICT')
    const rawSource = { sourceId, groupId: message.groupId, messageId: message.messageId,
      version: message.messageVersion ?? 1, actorId, senderName: message.senderName ?? '', text: message.text ?? '',
      quote: message.quotedMessage ?? null, resources: message.resourceRefs ?? message.imageRefs ?? [], timestamp: actualTime ?? '' }
    if (!original && config.ingressEpoch && (!actualTime || Date.parse(actualTime) < Date.parse(config.ingressEpoch))) {
      const stored = await command('source.record', rawSource, `source:${sourceId}`)
      return { accepted: false, sourceId, processing: 'quarantined', reason: stored.result.reason }
    }
    // Reuse the existing message model's enrichment/version boundary before recording
    // immutable task-session sources. Replayed transport projections can enrich a quote.
    await ingestTaskResidentMessage({ ctx, residentStore, message: { ...message, occurredAt: message.occurredAt ?? actualTime }, readResource })
    const projected = residentStore.getGroup(message.groupId).messages.find(item => item.messageId === message.messageId)
    const version = projected.messageVersion
    const currentSourceId = `im:${hash([message.groupId, message.messageId, version])}`
    const previous = await query('source.get', { sourceId: currentSourceId })
    if (previous && (previous.actorId !== actorId || previous.text !== projected.text)) fail('DYNAMIC_SOURCE_CONFLICT')
    const args = previous ? { sourceId: previous.sourceId, groupId: previous.groupId, messageId: previous.messageId,
      version: previous.version, actorId: previous.actorId, senderName: previous.senderName, text: previous.text,
      quote: previous.quote, resources: previous.resources, timestamp: previous.timestamp }
      : { ...rawSource, sourceId: currentSourceId, version, senderName: projected.senderName ?? '', text: projected.text,
        quote: projected.quotedMessage ?? null, resources: projected.resourceRefs ?? projected.imageRefs ?? [], timestamp: ingressTimestamp(projected.occurredAt) ?? actualTime ?? '' }
    let stored = previous ? { result: { source: previous } } : await command('source.record', args, `source:${currentSourceId}`)
    if (previous) {
      const resources = mergeTaskResources(previous.resources, projected.resourceRefs ?? projected.imageRefs ?? previous.resources)
      if (hash(resources) !== hash(previous.resources)) stored = await command('source.enrich', { sourceId: currentSourceId, resources }, `enrich:${currentSourceId}:${hash(resources)}`)
    }
    if (stored.result.ignored) return { accepted: false, sourceId: currentSourceId, processing: 'quarantined', reason: stored.result.reason }
    void kickGroup(message.groupId)
    return { accepted: true, sourceId: currentSourceId, processing: stored.result.source.routed ? 'routed' : 'pending' }
  }

  async function nativeOperation(event) {
    const { binding, callId, toolName, arguments: args } = event
    if (event.effectClass === 'read' || event.effectClass === 'pure') return { readOnly: true }
    const key = `native:${binding.executionId}:${binding.inputVersion ?? 1}:${binding.leaseEpoch}:${callId}`
    const operationId = `operation-${hash(key).slice(0, 40)}`
    if (event.phase === 'job') {
      await command('operation.job', { binding, operationId, job: event.job }, `job:${key}:${hash(event.job)}`)
      return { operationId }
    }
    if (event.phase === 'started') {
      await command('operation.prepare', { binding, operationId, key, definition: { toolName, argumentsDigest: hash(args), effectClass: event.effectClass ?? 'unknown',
        ...(['job_output', 'job_list'].includes(toolName) ? { nativeJobRead: false } : {}) },
        authorizationRef: `task:${binding.taskId}:requirement:${binding.requirementRevision}`, resourceKeys: [] }, `prepare:${key}`)
      const receipt = await command('operation.start', { binding, operationId }, `start:${key}`)
      if (!receipt.dispatchEligible) fail(receipt.result.operation.state === 'unknown' ? 'DYNAMIC_OPERATION_UNRESOLVED' : 'DYNAMIC_OPERATION_ALREADY_DISPATCHED')
      return { operationId }
    }
    // A background launch acknowledgement does not prove a terminal process result.
    if (event.jobReceipt && ['running', 'stopping'].includes(event.jobReceipt.status)) return { operationId, running: true }
    const error = event.result?.error?.info ?? event.result?.error
    const noEffect = !event.cancelled && event.result?.isError === true && isNativeFilePrecondition(toolName, error)
    const state = noEffect ? 'failed' : event.cancelled || event.result?.isError ? 'unknown' : event.jobReceipt && event.jobReceipt.status !== 'completed' ? 'failed' : 'succeeded'
    await command('operation.settle', { binding, operationId, state,
      result: { callId, toolName, isError: event.result?.isError === true, resultDigest: hash(event.result?.content ?? event.result ?? null),
        ...(error?.code ? { errorCode: error.code } : {}), ...(noEffect ? { noEffect: true } : {}),
        ...(event.cancelled ? { cancelled: true } : {}), ...(event.jobReceipt ? { jobReceipt: event.jobReceipt } : {}) } }, `settle:${key}`)
    return { operationId }
  }
  function kickExecution(executionId) {
    if (closed || !retryReady(executionId) || !inflightExecutions.has(executionId) && inflightExecutions.size >= executionLimit()) return Promise.resolve()
    return track(inflightExecutions, executionId, async () => {
      const candidate = await query('execution.get', { executionId })
      if (!candidate || candidate.status !== 'queued' || candidate.providerRecovery?.nextAttemptAt || !candidate.drained || candidate.cancelRequested || !reserveTask(candidate.taskId)) return
      if ((await requireTask(candidate.taskId)).archivedAt) return
      const claimed = await command('execution.claim', { executionId })
      const { binding, execution } = claimed.result
      let drained = true
      let stageSequence = 0
      const stageReports = new Map()
      try {
        const result = await executionSessions.run({ binding, title: executionSessionTitle(execution), input: execution.input, definition: { ...models(), ...execution.definition,
          prompt: execution.prompt, allowedTools: execution.definition?.allowedTools ?? [], nativeTools: true, outputSchema: dynamicExecutionOutputSchema },
          onSessionBound: async () => { await attachWorkspace(binding.sessionId, await taskWorkspace(root, binding.taskId), (await requireTask(binding.taskId)).title); return command('execution.sessionBound', { binding }, `execution-bound:${executionId}:${binding.leaseEpoch}`) },
          onNativeExecution: nativeOperation,
          readFeedback: async () => ((await query('execution.get', { executionId })).feedback ?? []).filter(item => item.requirementRevision === binding.requirementRevision && item.controlRevision === binding.controlRevision),
          onFeedbackConsumed: proof => command('execution.feedbackConsumed', { binding, ...proof }, `feedback-consumed:${executionId}:${proof.messageId}`),
          onProgress: async ({ summary, evidence, reportId, activity }) => {
            if (typeof reportId !== 'string' || !reportId.trim() || reportId.length > 2000) fail('EXECUTION_PROGRESS_REPORT_ID_INVALID')
            if (!await query('execution.current', { binding })) fail('DYNAMIC_EXECUTION_NOT_CURRENT')
            if (!stageReports.has(reportId)) stageReports.set(reportId, ++stageSequence)
            const receipt = await command('execution.progressReported', { binding, summary, evidence, ...(activity === undefined ? {} : { activity }), sequence: stageReports.get(reportId) },
              `execution-stage:${executionId}:${binding.inputVersion}:${binding.leaseEpoch}:${hash(reportId)}`)
            if (!receipt.replayed) void kickTask(binding.taskId)
            return { recorded: true, sequence: receipt.result.execution.stageProgress.sequence }
          },
          ...(execution.providerRecovery?.activeInputVersion === execution.inputVersion ? { recoveryContext: { kind: 'provider-recovery', attempt: execution.providerRecovery.attempts,
            failure: execution.results.at(-1)?.payload.error,
            instruction: '模型服务暂态失败后的同会话恢复。沿原小目标继续，保留原工具结果；不得重放成功操作或未知效果。原生终态与排空已核验，这不是新的业务授权。' } } : {}),
          onResult: (output, proof) => command('execution.result', { binding, output, feedbackVersion: proof?.feedbackVersion ?? 0 }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`) })
        if (result.status !== 'submitted') await command('execution.result', { binding, error: { ...result.failure, code: result.reason ?? result.status } }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`)
      } catch (error) {
        drained = error.executionDrained !== false
        // The native submission raced newer feedback. Keep the same execution queued
        // after drain; its persisted tool results remain authoritative on resume.
        if (drained && error.code === 'DYNAMIC_EXECUTION_FEEDBACK_PENDING') return
        if (drained) {
          try { await command('execution.result', { binding, error: { code: error.code ?? error.message, message: String(error.message), phase: error.phase ?? 'runtime' } }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`) }
          catch (recordError) { throw Object.assign(new AggregateError([error, recordError], 'DYNAMIC_EXECUTION_FAILURE_RECORD_FAILED'), { code: 'DYNAMIC_EXECUTION_FAILURE_RECORD_FAILED' }) }
        }
        throw error
      } finally {
        if (drained) await command('execution.drained', { binding }, `execution-drained:${executionId}:${binding.leaseEpoch}`)
        if (!closed) void kickTask(binding.taskId)
      }
    })
  }
  function kickTask(taskId) {
    if (closed || !retryReady(taskId) || !reserveTask(taskId)) return Promise.resolve()
    return track(inflightTasks, taskId, async () => {
      let task = await requireTask(taskId)
      if (task.archivedAt || task.status !== 'active' || task.control !== 'active') { taskSlots.delete(taskId); return }
      if (!pendingDialogue(task) && task.humanRequests?.some(request => request.status === 'waiting-reply')) { taskSlots.delete(taskId); return }
      if (!task.drained) return
      if (!(await query('wake.list', { taskId })).some(item => item.state !== 'acked')) return
      const claimed = await command('task.claim', { taskId, ...(pendingDialogue(task) ? { dialogue: true } : {}) })
      const { binding, wakeIds, wakes } = claimed.result
      task = claimed.result.task
      const dialogueMessage = wakes.find(item => item.kind === 'task.dialogue')?.payload.messageId
      const dialogue = dialogueMessage ? { ...task.dialogue.find(item => item.id === dialogueMessage),
        history: task.dialogue.filter(item => item.reply && item.id !== dialogueMessage).slice(-20) } : null
      let drained = true, submitted = false
      try {
        const sources = (await Promise.all(task.sourceRefs.map(sourceId => query('source.get', { sourceId })))).filter(Boolean)
        const materials = await Promise.all(sources.map(source => materializeSource(taskId, source)))
        const operations = await query('operation.list', { taskId })
        const runResult = await taskSessions.run({ binding, input: { task, sources, ...(dialogue ? { dialogue } : {}), materials: materials.map(({ resources, ...value }) => ({ ...value, resources: resources.map(({ value: _body, ...resource }) => resource) })), wakes, executions: await query('execution.list', { taskId }),
          operations,
          operationCounts: Object.fromEntries(Object.entries(Object.groupBy(operations, operation => operation.state)).map(([state, items]) => [state, items.length])),
          blockers: await query('task.blockers', { taskId }) }, ...models(), agentPreset: legacy.getAgentConfig().agentPreset,
          groupResponsibility: legacy.getGroup(task.groupId)?.responsibility ?? '',
          onSessionBound: async () => { await attachWorkspace(binding.sessionId, await taskWorkspace(root, taskId), task.title); return command('task.sessionBound', { binding }, `task-bound:${taskId}:${binding.leaseEpoch}`) },
          delegate: async args => {
            if (dialogue && (args.feedback !== true || !args.executionId)) fail('TASK_DIALOGUE_FEEDBACK_ONLY')
            if (args.readbackOperationId) {
              const operation = await query('operation.get', { operationId: args.readbackOperationId })
              if (args.readOnly !== true || operation?.taskId !== taskId) fail('TASK_OPERATION_SCOPE_MISMATCH')
            }
            if (args.skillNames !== undefined && (!Array.isArray(args.skillNames)
              || args.skillNames.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
              || new Set(args.skillNames).size !== args.skillNames.length)) fail('TASK_SKILL_NAMES_INVALID')
            const dispatchId = `${args.executionId ? 'continue' : 'delegate'}:${taskId}:${binding.requirementRevision}:${args.key}`
            if (args.feedback === true && (!args.executionId || args.readOnly || args.readbackOperationId || args.skillNames?.length || args.resourceKeys?.length)) fail('TASK_EXECUTION_FEEDBACK_ARGUMENT_INVALID')
            const prior = await query('receipt.get', { id: dispatchId })
            if (prior) {
              if (prior.result.feedback) {
                if (args.feedback !== true || prior.result.feedback.text !== JSON.stringify({ objective: args.objective, context: args.context ?? '' })
                  || prior.result.execution.executionId !== args.executionId) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
                await executionSessions.feedback(args.executionId)
                const execution = await query('execution.get', { executionId: args.executionId })
                const feedback = execution.feedback.find(item => item.id === dispatchId)
                return { executionId: execution.executionId, sessionId: execution.sessionId, received: true, consumed: !!feedback.consumedAt, feedback }
              }
              if (args.feedback === true) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
              if (prior.result.execution.input.objective !== args.objective || (args.executionId && prior.result.execution.executionId !== args.executionId)
                || (prior.result.execution.input.recoveryReadOnly === true) !== (args.readOnly === true)
                || (prior.result.execution.input.readbackOperationId ?? null) !== (args.readbackOperationId ?? null)
                || hash(prior.result.execution.input.skillNames ?? []) !== hash(args.skillNames ?? [])) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
              return { executionId: prior.result.execution.executionId, status: prior.result.execution.status, sessionId: prior.result.execution.sessionId }
            }
            let existingTitle
            if (args.executionId) {
              const original = await query('execution.get', { executionId: args.executionId })
              if (original?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH')
              if (args.feedback === true) {
                const receipt = await command('execution.feedback', { binding, executionId: args.executionId,
                  messageId: dispatchId, text: JSON.stringify({ objective: args.objective, context: args.context ?? '' }) }, dispatchId)
                await executionSessions.feedback(args.executionId)
                return { executionId: args.executionId, sessionId: original.sessionId, feedback: receipt.result.feedback,
                  received: true, consumed: !!receipt.result.feedback.consumedAt }
              }
              existingTitle = executionSessionTitle(original)
              if (original.result?.payload.error?.code === 'EXECUTION_PROVIDER_TRANSIENT') await verifyProviderTerminal(original)
            }
            let originalOperation
            if (args.readOnly === true && args.readbackOperationId) {
              const operation = (await query('operation.list', { taskId })).find(item => item.operationId === args.readbackOperationId)
              if (!operation) fail('TASK_OPERATION_SCOPE_MISMATCH')
              originalOperation = safeNotificationDetail(await readNativeOperationContext({ ctx, operation }))
            }
            const payload = { binding, key: args.key, prompt: `当前小目标见结构化input.objective。\n具体执行由你负责，可在同一会话内持续调查、操作、验证和纠错。不得再次委派；不能宣布整体任务完成。只依据当前任务真实来源和权限执行。结果包含实际证据、限制及产物。最后调用execution_submit。`,
              input: { task: { taskId, request: task.request, objective: task.objective, requirements: task.requirements, requirementRevision: binding.requirementRevision, ownerActorId: task.ownerActorId, authorizationSourceId: task.metadata?.authorizationSourceId }, sources,
                title: existingTitle || executionSessionTitle({ input: { title: args.title, objective: args.objective }, key: args.key }), objective: args.objective, recoveryReadOnly: args.readOnly === true, readbackOperationId: args.readbackOperationId ?? null, ...(originalOperation ? { originalOperation } : {}), context: args.context ?? '', skillNames: args.skillNames ?? [], materialPaths: materials.map(item => item.path), sourceFiles: Object.fromEntries(materials.map(item => [item.sourceId, { path: item.path, textPath: item.textPath }])), previousExecutions: (await query('execution.list', { taskId })).map(taskExecutionContext) },
              definition: { nativeTools: true, recoveryReadOnly: args.readOnly === true, agentPreset: legacy.getAgentConfig().agentPreset, allowedTools: [], outputSchema: dynamicExecutionOutputSchema }, resourceKeys: args.resourceKeys ?? [] }
            const accepted = args.executionId ? await command('execution.continue', { ...payload, executionId: args.executionId }, dispatchId)
              : await command('execution.dispatch', payload, dispatchId)
            void kickExecution(accepted.result.execution.executionId)
            return { executionId: accepted.result.execution.executionId, status: accepted.result.execution.status, sessionId: accepted.result.execution.sessionId }
          },
          readExecution: async executionId => { const execution = await query('execution.get', { executionId }); if (execution?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH'); return execution },
          readProgress: async executionId => {
            const execution = await query('execution.get', { executionId })
            if (execution?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH')
            try { return { available: true, sessionLogRoot: taskSessionLogRoot(root, taskId), ...await readExecutionProgress({ ctx, execution }) } }
            catch (error) { return { available: false, executionId, sessionId: execution.sessionId,
              readError: error.code ?? 'EXECUTION_PROGRESS_LOG_UNREADABLE', limitation: '未能读取真实执行日志，不能据运行状态判断进展；先调查记录不可读原因。' } }
          },
          reconcileOperation: async operationId => {
            const operation = (await query('operation.list', { taskId })).find(item => item.operationId === operationId)
            if (!operation) fail('TASK_OPERATION_SCOPE_MISMATCH')
            if (operation.state !== 'unknown') return { operation }
            try {
              const original = await query('execution.get', { executionId: operation.executionId })
              const jobs = ctx.get?.('jobs')
              if (!original.drained || original.recovering || ctx.agents.get(original.sessionId) || ctx.sessions.get(original.sessionId)
                || !jobs?.list || jobs.list(original.sessionId).some(job => ['running','stopping'].includes(job.status))) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
              return (await command('operation.reconcile-job', { binding, operationId }, `reconcile-job:${operationId}:${hash(operation.job ?? null)}`)).result
            }
            catch (error) {
              if (error.code !== 'DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT') throw error
              const executions = await query('execution.list', { taskId })
              const jobReadProof = await inspectFailedNativeJobRead({ ctx, operation,
                execution: executions.find(item => item.executionId === operation.executionId) })
              if (jobReadProof) return (await command('operation.reconcile-job-read', { binding, operationId, proof: jobReadProof }, `reconcile-job-read:${operationId}:${hash(jobReadProof)}`)).result
              const fileProof = await inspectFailedNativeFileMutation({ ctx, operation,
                execution: executions.find(item => item.executionId === operation.executionId) })
              if (fileProof) return (await command('operation.reconcile-file-precondition', { binding, operationId, proof: fileProof }, `reconcile-file-precondition:${operationId}:${hash(fileProof)}`)).result
              const readProof = await inspectFailedNativeWebRead({ ctx, operation,
                execution: executions.find(item => item.executionId === operation.executionId) })
              if (readProof) return (await command('operation.reconcile-web-read', { binding, operationId, proof: readProof }, `reconcile-web-read:${operationId}:${hash(readProof)}`)).result
              const proof = await inspectStoppedNativeOperation({ ctx, operation, executions,
                execution: executions.find(item => item.executionId === operation.executionId) })
              if (proof) return (await command('operation.reconcile-stopped', { binding, operationId, proof }, `reconcile-stopped:${operationId}:${hash(proof)}`)).result
              return { operation, unresolved: true, reason: error.code,
                nextAction: 'Use task_delegate with readOnly=true and readbackOperationId=this operationId to associate an investigation with the original operation. The configured native tools remain available. Inspect actual effects without replay, then call task_operation_reconcile again. Verified Host stop/drain plus real observations may close only as failed with partial effects, never success.' }
            }
          },
          cancelExecution: async ({ executionId, reason }) => {
            if (dialogue) fail('TASK_DIALOGUE_CANNOT_CANCEL')
            const execution = await query('execution.get', { executionId }); if (execution?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH')
            await command('execution.cancel', { binding, executionId, reason })
            await executionSessions.cancel(executionId)
            return { executionId, cancellationRequested: true }
          },
          submit: async decision => {
            if (dialogue) {
              if (decision.action !== 'wait' || decision.question?.trim()) fail('TASK_DIALOGUE_REPLY_ONLY')
              await command('task.dialogue.reply', { binding, messageId: dialogue.id, reply: decision.summary }, `dialogue-reply:${taskId}:${dialogue.id}`)
              submitted = true
              return { accepted: true, replied: true }
            }
            if (decision.action === 'complete') {
              const source = await sourceFor(task)
              let notification
              if (source && source.channel !== 'web' && !source.sourceId.startsWith('web:')) {
                const reply = formatTaskGroupReply({ source: { groupId: source.groupId, messageId: source.messageId, senderOpenDingTalkId: source.actorId, senderName: source.senderName, text: source.text },
                  summary: decision.summary, evidence: decision.evidence, limitations: decision.limitations,
                  signature: legacy.getAgentConfig().replySignature, internalIds: await replyInternalIds(task) })
                notification = { ...reply, conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId, fact: { taskId }, kind: 'task-completed' }
              }
              await command('task.complete', { binding, summary: decision.summary, result: decision, ...(notification ? { notification } : {}) }, `complete:${taskId}:${binding.requirementRevision}`)
            } else {
              await command('task.wait', { binding, ...decision, ...(decision.question?.trim() ? { humanRequest: {
                requestId: `human-${hash([taskId, binding.requirementRevision, binding.controlRevision, binding.leaseEpoch])}`,
                reason: decision.summary, audience: decision.audience ?? 'operator', attemptedActions: decision.attemptedActions ?? [] } } : {}) }, `wait:${taskId}:${binding.leaseEpoch}`)
              if (decision.question?.trim()) {
                const current = await requireTask(taskId)
                await queueHumanRequest(current, current.humanRequests.findLast(request => request.status === 'waiting-reply'))
              }
            }
            submitted = true
            return { accepted: true }
          } })
        if (!submitted && runResult.status === 'no_submission') {
          if (dialogue) fail('TASK_DIALOGUE_NO_REPLY')
          failures.set(taskId, { id: taskId, code: runResult.reason ?? 'TASK_SESSION_NO_SUBMISSION' })
          await command('task.wait', { binding, action: 'blocked', summary: '任务会话本轮未能提交有效决定，原任务和执行结果已保留。',
            limitations: [runResult.reason ?? 'TASK_SESSION_NO_SUBMISSION'] }, `task-technical-block:${taskId}:${binding.leaseEpoch}`)
          submitted = true
        }
        if (submitted) await command('wake.ack', { binding, wakeIds }, `wake-ack:${taskId}:${binding.leaseEpoch}`)
      } catch (error) {
        drained = error.taskSessionDrained !== false
        if (drained && error.code === 'TASK_SESSION_PROVIDER_TRANSIENT') await command('task.provider-failure', { binding,
          failure: { code: error.code, phase: error.phase, providerError: error.providerError } }, `task-provider-failure:${taskId}:${binding.leaseEpoch}`)
        throw error
      }
      finally {
        if (drained) await command('task.drained', { binding }, `task-drained:${taskId}:${binding.leaseEpoch}`)
        if (!closed) void deliverNotifications()
        // Slot release and queued-work promotion happen after the tracked turn drains.
      }
    })
  }
  async function replyInternalIds(task) {
    const executions = await query('execution.list', { taskId: task.taskId })
    return [task.taskId, task.sessionId, ...task.sourceRefs,
      ...executions.flatMap(item => [item.executionId, item.sessionId])].filter(Boolean)
  }
  async function queueReply(task, source, decision, id, kind, humanRequest) {
    if (!source || source.channel === 'web' || source.sourceId.startsWith('web:')) return
    if ((await query('notification.list')).some(item => item.id === id)) {
      void deliverNotifications()
      return
    }
    const reply = formatTaskGroupReply({ source: { groupId: source.groupId, messageId: source.messageId,
      senderOpenDingTalkId: source.actorId, senderName: source.senderName, text: source.text }, summary: decision.summary,
      evidence: decision.evidence, limitations: decision.limitations,
      signature: legacy.getAgentConfig().replySignature, internalIds: await replyInternalIds(task) })
    await command('notification.prepare', { notificationId: id, taskId: task.taskId, requirementRevision: task.requirementRevision,
      kind, payload: { ...reply, conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId,
        ...(humanRequest ? { audience: humanRequest.audience, humanRequestId: humanRequest.requestId } : {}), fact: { taskId: task.taskId }, kind } }, `prepare-notification:${id}`)
    void deliverNotifications()
  }
  async function queueHumanRequest(task, request) {
    if (!request) return
    if (request.audience === 'requester') {
      const source = await sourceFor(task)
      return queueReply(task, source, { summary: request.question, evidence: [], limitations: [] },
        `question:${task.taskId}:${request.requestId}`, 'question', request)
    }
    if (!config.operatorUserId) return // 未配置/登录时仍保留Web人工介入，不能转发给需求提出人。
    const notificationId = `operator-request:${request.requestId}`
    const text = ['【任务技术问题，需要操作人处理】', `任务：${task.title}`, `申请：${request.requestId}`,
      request.question, ...(request.attemptedActions?.length ? ['已尝试：', ...request.attemptedActions] : []),
      '请在Web人工介入页答复，或在本私聊中引用本申请回复处理结果。'].join('\n\n')
    await command('notification.prepare', { notificationId, taskId: task.taskId, requirementRevision: request.requirementRevision,
      kind: 'question', payload: { text, audience: 'operator', humanRequestId: request.requestId,
        recipientUserId: config.operatorUserId, fact: { taskId: task.taskId }, kind: 'question' } }, `prepare-notification:${notificationId}`)
    void deliverNotifications()
  }
  let notificationTransportRetryAt = 0
  async function deliverNotifications(attempted) {
    for (const notification of await query('notification.list')) {
      if (notifications?.recall && notification.kind === 'question' && notification.payload.audience === 'operator'
        && notification.state === 'delivered' && notification.recall?.state !== 'recalled'
        && !(Date.parse(notification.recall?.nextAttemptAt ?? '') > Date.now())
        && retryReady(notification.id) && !inflightNotifications.has(notification.id) && !attempted?.has(notification.id)) {
        const task = await query('task.get', { taskId: notification.taskId })
        const request = task?.humanRequests?.find(item => item.requestId === notification.payload.humanRequestId)
        if (request?.status === 'answered' && request.replyChannel === 'web') {
          attempted?.add(notification.id)
          void track(inflightNotifications, notification.id, () => recallTaskOperatorNotification({ notification, notifications, command }))
        }
      }

      const previousOutbound = residentStore?.getGroup(notification.payload.conversationId)?.outbox.find(item => item.outboundId === notification.id)
      if (notification.state === 'failed' && notification.deliveryError?.knownNotSent === true && notification.deliveryError?.retryable === true) {
        let reason, taskIds = previousOutbound?.taskIds ?? []
        if (previousOutbound?.supersededByOutboundId || previousOutbound?.status === 'superseded' || previousOutbound?.recallStatus) reason = 'superseded'
        else if ((notification.payload.replyKind ?? previousOutbound?.replyKind) === 'confirmation') {
          const linked = await Promise.all(taskIds.map(taskId => query('task.get', { taskId })))
          if (!taskIds.length || !previousOutbound?.decisionId || linked.some(task => !task || !task.appliedOperations?.some(id => id.startsWith(`${previousOutbound.decisionId}:action:`)))) reason = 'confirmation-reassessment-required'
          else if (linked.every(task => task.status !== 'active' || task.control === 'cancelled')) reason = 'task-terminal'
        } else if (!(notification.payload.replyKind ?? previousOutbound?.replyKind)) reason = 'confirmation-reassessment-required'
        if (reason) {
          const retired = await command('notification.retireUnsent', { notificationId: notification.id, reason, taskIds,
            evidenceRef: `unsent-intent:${previousOutbound?.decisionId ?? notification.id}:${reason}` })
          await projectTaskNotification({ residentStore, notification: retired.result.notification })
          continue
        }
      }
      await projectTaskNotification({ residentStore, notification })
      if (['prepared', 'failed'].includes(notification.state) && (previousOutbound?.supersededByOutboundId || previousOutbound?.status === 'superseded' || previousOutbound?.recallStatus)) continue
      if (notification.state === 'delivered' || notification.state === 'failed' && !(notification.deliveryError?.knownNotSent && notification.deliveryError?.retryable)
        || inflightNotifications.size > 0 || Date.now() < notificationTransportRetryAt || !retryReady(notification.id) || Date.parse(notification.nextAttemptAt ?? '') > Date.now() || inflightNotifications.has(notification.id) || attempted?.has(notification.id)) continue
      attempted?.add(notification.id)
      void track(inflightNotifications, notification.id, async () => {
        try { await deliverTaskNotification({ notification, notifications, command }) }
        catch (error) {
          if (error.serverErrorCode === 'RATE_LIMIT_ERROR' || error.code === 'RATE_LIMIT_ERROR' || error.knownNotSent === true) notificationTransportRetryAt = Math.max(notificationTransportRetryAt, Date.parse(error.notificationRetryAt) || Date.now() + 60000)
          throw error
        }
      })
    }
  }
  async function recover() {
    if (closed) return { failures: [] }
    if (recovering) return recovering
    return recovering = (async () => {
      // A process restart cannot prove detached external operations stopped. Recover only native handles known absent;
      // unfinished operation rows remain unknown and fence execution until explicit readback reconciliation.
      const pending = await query('recovery.pending')
      for (const task of pending.tasks) if (task.recovering && !ctx.agents.get(task.sessionId) && !ctx.sessions.get(task.sessionId))
        await command('task.drained', { binding: await query('task.binding', { taskId: task.taskId }) })
      for (const group of pending.groups ?? []) if (group.recovering && !ctx.agents.get(group.sessionId) && !ctx.sessions.get(group.sessionId))
        await command('group.drained', { binding: { kind: 'group-session', groupId: group.groupId, sessionId: group.sessionId, leaseEpoch: group.leaseEpoch, sessionBound: group.sessionBound } })
      for (const execution of pending.executions) if (execution.recovering) {
        // Physical native-session drain is independent of effect certainty. The
        // operation fence stays unknown; recoverDrained validates real history
        // and absence of live handles before permitting any readonly continuation.
        const binding = await query('execution.binding', { executionId: execution.executionId })
        try {
          const jobs = ctx.get?.('jobs')
          if (jobs?.list?.(execution.sessionId).some(job => ['running','stopping'].includes(job.status))) fail('DYNAMIC_JOB_DRAIN_UNPROVEN')
          await executionSessions.recoverDrained({ binding, input: execution.input })
          await command('execution.drained', { binding }, `recovered-drained:${execution.executionId}:${binding.leaseEpoch}`)
        } catch (error) { failures.set(execution.executionId, { id: execution.executionId, code: error.code ?? error.message }) }
      }
      await refreshTasks()
      for (const task of taskCache.values()) if (!task.archivedAt && task.status === 'active' && task.control === 'active')
        for (const request of task.humanRequests ?? []) if (request.status === 'waiting-reply') await queueHumanRequest(task, request)
      for (const candidate of recoveryCandidates) {
        const task = await query('task.get', { taskId: candidate.taskId })
        if (task.archivedAt || task.status !== 'active' || task.control !== 'active' || !task.drained
          || task.lastDecision.question || task.requirementRevision !== candidate.requirementRevision || task.controlRevision !== candidate.controlRevision) continue
        const executions = await query('execution.list', { taskId: task.taskId })
        if (executions.some(execution => !execution.drained || execution.recovering || ['queued', 'running'].includes(execution.status))) continue
        if (task.lastDecision.action === 'blocked' && task.lastDecision.limitations?.includes('TASK_SESSION_NO_SUBMISSION')) {
          await persistence.register({ taskId: task.taskId, sessionId: task.sessionId, cwd: await taskWorkspace(root, task.taskId) })
          const { events } = await inspectSession(ctx.sessionPersistence, task.sessionId)
          if (!events.some(event => event.type === 'plugin:dingtalk/task-session' && event.data.taskId === task.taskId && event.data.sessionId === task.sessionId)) continue
          const input = events.findLast(event => event.type === 'user/message' && event.data.source?.taskSession?.leaseEpoch === task.leaseEpoch)
          const end = events.findLast(event => event.type === 'turn/end')
          if (input && end?.seq > input.seq && end.data.reason?.kind === 'error' && isTaskProviderTransient(end.data.reason.error))
            await command('task.wake', { taskId: task.taskId, kind: 'provider.recovered', payload: {
              instruction: '上轮模型服务临时故障，未产生统筹决定。沿原任务、原执行结果继续，不重放已完成或未知效果。' } },
            `provider-recovery:${task.taskId}:${task.requirementRevision}:${task.controlRevision}:${task.leaseEpoch}`)
          continue
        }
        if (task.lastDecision.action !== 'wait') continue
        if (!(await query('operation.list', { taskId: task.taskId })).some(operation => operation.state === 'unknown')) continue
        await command('task.wake', { taskId: task.taskId, kind: 'runtime.updated', payload: { runtimeRevision,
          instruction: '运行实现已更新。先调用 task_operation_reconcile；证据不足时用 readOnly=true 和 readbackOperationId 委派原效果只读核验，再对账。此前只读核查若失败，可用executionId续原只读会话，依据Host新增的originalOperation原生材料和原生工具核对实际文件及原始效果。保留 unknown 保护，不能重放原操作。' } },
        `runtime-recovery:${task.taskId}:${task.requirementRevision}:${task.controlRevision}:${runtimeRevision}`)
      }
      for (const task of await query('task.list')) if (task.sessionBound) {
        const cwd = await taskWorkspace(root, task.taskId)
        await persistence.register({ taskId: task.taskId, sessionId: task.sessionId, cwd })
        await attachWorkspace(task.sessionId, cwd, task.title)
      }
      for (const execution of await query('execution.list')) if (execution.sessionBound) {
        const cwd = await taskWorkspace(root, execution.taskId)
        await persistence.register({ taskId: execution.taskId, sessionId: execution.sessionId, cwd })
        await attachWorkspace(execution.sessionId, cwd, (await requireTask(execution.taskId)).title)
      }
      await topicCoordinator.recover()
      for (const source of await query('source.list')) {
        await projectSource(source)
        if (!source.routed) void kickGroup(source.groupId)
      }
      for (const execution of await query('execution.list')) {
        const task = await query('task.get', { taskId: execution.taskId })
        if (!task || task.archivedAt || task.status !== 'active' || task.control !== 'active' || !executionProgressDue(execution)) continue
        let observation
        try { observation = await readExecutionProgress({ ctx, execution }) }
        catch (error) { observation = { lastSequence: execution.progressReview?.lastSequence ?? -1, lastActivityAt: null,
          newEventCount: 0, changed: false, readError: error.code ?? 'EXECUTION_PROGRESS_LOG_UNREADABLE' } }
        try {
          const { lastSequence, lastActivityAt, newEventCount, changed, readError } = observation
          await command('execution.progressReviewed', { executionId: execution.executionId, inputVersion: execution.inputVersion,
            leaseEpoch: execution.leaseEpoch, inputDigest: execution.inputDigest,
            observation: { lastSequence, lastActivityAt, newEventCount, changed, ...(readError ? { readError } : {}) } },
          `execution-progress:${execution.executionId}:${execution.inputVersion}:${execution.leaseEpoch}:${execution.progressReview?.checkedAt ?? execution.updatedAt}`)
        } catch (error) {
          if (!['DYNAMIC_EXECUTION_LEASE_STALE', 'DYNAMIC_EXECUTION_NOT_CURRENT'].includes(error.code)) throw error
        }
      }
      for (const task of await query('task.list')) void kickTask(task.taskId)
      for (const execution of await query('execution.list')) if (execution.drained && execution.status === 'queued') void kickExecution(execution.executionId)
      void schedulePending()
      await deliverNotifications()
      return { failures: [...failures.values()], recovery: pending }
    })().finally(() => { recovering = undefined })
  }
  async function webTopicAction(args, task, kind) {
    if (kind === 'task-context') assertTaskContextSemantics(args)
    if (!config.webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
    if (!args.requestId) fail('TASK_SESSION_REQUEST_ID_REQUIRED')
    const groupId = task?.groupId ?? args.groupId
    if (!groupId || !legacy.getGroup(groupId)) fail('group_not_subscribed')
    const sourceId = `web:${hash([config.webActorId, groupId, args.requestId])}`
    const previous = await query('source.get', { sourceId })
    const identity = { args: clean(args), kind, taskId: task?.taskId ?? null }
    if (previous && hash(previous.requestIdentity?.request) !== hash(identity)) fail('DYNAMIC_COMMAND_ID_CONFLICT')
    const previousTopic = residentStore.listTopics(groupId).find(topic => topic.decisions.some(item => item.decisionId === stableId('decision', `${groupId}:${args.requestId}`)))
    const previousRecord = previousTopic?.decisions.find(item => item.decisionId === stableId('decision', `${groupId}:${args.requestId}`))
    if (previousRecord?.status === 'completed') return requireTask(previousRecord.operations[0].taskId)
    if (!previous && task && (args.expectedRequirementRevision !== undefined && args.expectedRequirementRevision !== task.requirementRevision
      || args.expectedControlRevision !== undefined && args.expectedControlRevision !== task.controlRevision)) fail('DYNAMIC_TASK_REVISION_STALE')
    const text = args.context?.trim() || args.objective || args.reason || ''
    const messageId = stableId('web', `${groupId}:${args.requestId}`)
    await refreshTasks()
    const inheritedRefs = task ? [...new Map((task.topicRefs ?? []).map(ref => {
      const original = residentStore.getTopic(groupId, ref.topicId)
      const current = original?.mergedInto ? residentStore.getTopic(groupId, original.mergedInto) : original
      if (!current) fail('TASK_TOPIC_SOURCE_MISSING')
      return [current.topicId, { topicId: current.topicId, revision: current.revision }]
    })).values()] : []
    const action = previous?.requestIdentity?.action ?? { kind, topicRefs: args.topicRefs ?? inheritedRefs,
      ...(kind === 'task-context' ? { progressImpact: args.progressImpact, authorizationChange: args.authorizationChange,
        impactEvidence: args.impactEvidence, objective: args.objective, title: args.title, acceptanceCriteria: args.acceptanceCriteria, stageTasks: args.stageTasks } : {}),
      ...(task ? { taskId: task.taskId, inputVersion: args.expectedRequirementRevision ?? args.inputVersion ?? task.requirementRevision, runSequence: task.runSequence ?? 1,
        ...(kind === 'task-cancel' ? { reason: text } : { context: text }) } : { title: args.title || (args.objective ?? text).slice(0, 80), objective: args.objective ?? text, acceptanceCriteria: args.acceptanceCriteria ?? [text] }) }
    await command('source.record', { sourceId, groupId, messageId, actorId: config.webActorId, text, timestamp: '', channel: 'web',
      requestIdentity: { request: identity, action } }, `source:${sourceId}`)
    const accepted = await residentStore.submitWebTaskInput({ groupId, requestId: args.requestId, text, action, topicRefs: action.topicRefs })
    if (!['accepted','duplicate'].includes(accepted.status)) fail(`TASK_TOPIC_WEB_${accepted.status}`)
    await topicCoordinator.applyAccepted(groupId, accepted.topicId, accepted.record.decisionId)
    const current = residentStore.getTopic(groupId, accepted.topicId).decisions.find(item => item.decisionId === accepted.record.decisionId)
    if (current.status !== 'completed') fail(current.error ?? 'TASK_TOPIC_WEB_DECISION_FAILED')
    await command('source.routed', { sourceId, receipt: [{ topicId: accepted.topicId, revision: current.revision }] }, `topic-routed:${sourceId}`)
    return requireTask(current.operations[0].taskId)
  }
  async function listHumanRequests() {
    const notices = await query('notification.list')
    return (await query('task.list')).flatMap(task => (task.humanRequests ?? []).map(request => ({ ...request, audience: request.audience ?? 'operator',
      taskSessionRequest: true, taskId: task.taskId, groupId: task.groupId, objective: task.objective,
      notification: (() => { const notice = notices.find(item => item.taskId === task.taskId && item.payload.humanRequestId === request.requestId && item.payload.audience === 'operator')
        return notice ? { notificationId: notice.id, state: notice.state, recall: notice.recall ?? null, delivery: notice.state === 'delivered' ? notice.receipt : null } : undefined })(),
      waitingReason: request.question, evidence: request.evidence ?? [], attemptedActions: request.attemptedActions ?? [],
      decidedAt: request.answeredAt, decision: request.status === 'answered' ? 'answered' : undefined,
      decisionSource: request.status === 'answered' ? request.replyChannel : undefined })))
  }
  async function respondHumanRequest(args) {
    if (!config.webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
    if (!args.requestId?.trim() || !args.reply?.trim()) fail('TASK_HUMAN_REPLY_REQUIRED')
    const task = await requireTask(args.taskId)
    const sourceId = `web-human:${hash([config.webActorId, task.taskId, args.humanRequestId, args.requestId])}`
    const receiptId = `human-reply:${sourceId}`
    const prior = await query('receipt.get', { id: receiptId })
    const request = task.humanRequests?.find(request => request.requestId === args.humanRequestId)
    if (!request) fail('DYNAMIC_NOT_FOUND')
    if (!prior && (request.status !== 'waiting-reply' || args.expectedRequirementRevision !== task.requirementRevision
      || args.expectedControlRevision !== task.controlRevision)) fail('DYNAMIC_HUMAN_REQUEST_STALE')
    if (prior && !args.checkOnly) {
      const originalSource = await query('source.get', { sourceId })
      if (originalSource?.text !== args.reply || hash(originalSource.requestIdentity?.nativeFailureResolutions ?? []) !== hash(args.nativeFailureResolutions ?? [])) fail('DYNAMIC_COMMAND_ID_CONFLICT')
      return taskDTO(prior.result.task)
    }
    const resolutions = args.nativeFailureResolutions ?? []
    if (resolutions.length && request.audience !== 'operator') fail('TASK_OPERATION_OPERATOR_REQUIRED')
    const proofs = []
    for (const resolution of resolutions) {
      const operation = await query('operation.get', { operationId: resolution.operationId })
      if (operation?.taskId !== task.taskId) fail('TASK_OPERATION_SCOPE_MISMATCH')
      if (operation.state === 'failed' && operation.result.operatorSourceId === sourceId
        && hash(operation.result.previousObservation) === resolution.expectedOperationDigest) continue
      if (hash(operation) !== resolution.expectedOperationDigest) fail('DYNAMIC_OPERATION_SCOPE_STALE')
      const executions = await query('execution.list', { taskId: task.taskId })
      const proof = await inspectInvestigatedNativeFailure({ ctx, operation, executions,
        execution: executions.find(item => item.executionId === operation.executionId) })
      if (!proof) fail('DYNAMIC_OPERATION_EVIDENCE_INSUFFICIENT')
      proofs.push({ operationId: operation.operationId, proof })
    }
    if (args.checkOnly) return { checkOnly: true, writes: 0, taskId: task.taskId,
      resolutions: proofs.map(({ operationId, proof }) => ({ operationId, operationDigest: proof.operationDigest,
        resultSequence: proof.resultSequence, turnEndSequence: proof.turnEndSequence,
        investigationCount: new Set(proof.observations.map(item => item.executionId)).size,
        outcome: 'failed', partialEffectsPossible: true })) }
    const source = { sourceId, groupId: task.groupId, messageId: sourceId, actorId: config.webActorId,
      text: args.reply, timestamp: '', channel: 'web',
      ...(resolutions.length ? { requestIdentity: { humanRequestId: args.humanRequestId, nativeFailureResolutions: resolutions } } : {}) }
    const response = { taskId: task.taskId, requestId: args.humanRequestId, sourceId,
      expectedRequirementRevision: args.expectedRequirementRevision, expectedControlRevision: args.expectedControlRevision }
    let result
    if (resolutions.length) result = await command('task.human.resolve-failures', { ...response, source, resolutions: proofs }, receiptId)
    else {
      await command('source.record', source, `source:${sourceId}`)
      result = await command('task.human.respond', response, receiptId)
      await command('source.routed', { sourceId, receipt: [{ taskId: task.taskId, humanRequestId: args.humanRequestId }] }, `human-source-routed:${sourceId}`)
    }
    void deliverNotifications().catch(error => {
      ctx.logger?.warn?.(`task-session recall scan ${task.taskId}: ${error.code ?? error.message}`)
    })
    void kickTask(task.taskId)
    return taskDTO(result.result.task)
  }
  async function respondPrivateHumanReply(message) {
    if (!message.messageId || !message.text?.trim() || !message.quotedMessage?.messageId) fail('TASK_HUMAN_REPLY_REQUIRED')
    const requests = await listHumanRequests()
    const request = requests.find(item => item.audience === 'operator' && item.notification?.delivery?.messageId === message.quotedMessage.messageId)
    if (!request) fail('TASK_HUMAN_PRIVATE_REQUEST_NOT_FOUND')
    const delivery = request.notification.delivery
    if (delivery.conversationId !== message.groupId || delivery.senderActorId !== message.senderOpenDingTalkId) fail('DYNAMIC_HUMAN_RESPONSE_FORBIDDEN')
    const sourceId = `private-human:${hash([request.requestId, message.groupId, message.messageId])}`, receiptId = `human-reply:${sourceId}`
    const task = await requireTask(request.taskId), prior = await query('receipt.get', { id: receiptId })
    if (!prior && (request.status !== 'waiting-reply' || request.requirementRevision !== task.requirementRevision
      || request.controlRevision !== task.controlRevision)) fail('DYNAMIC_HUMAN_REQUEST_STALE')
    await command('source.record', { sourceId, groupId: task.groupId, messageId: message.messageId,
      actorId: message.senderOpenDingTalkId, text: message.text, timestamp: message.occurredAt, channel: 'private',
      quote: { messageId: delivery.messageId, conversationId: delivery.conversationId } }, `source:${sourceId}`)
    if (prior) return taskDTO(task)
    const result = await command('task.human.respond', { taskId: task.taskId, requestId: request.requestId, notificationId: request.notification.notificationId,
      sourceId, expectedRequirementRevision: request.requirementRevision, expectedControlRevision: request.controlRevision }, receiptId)
    await command('source.routed', { sourceId, receipt: [{ taskId: task.taskId, humanRequestId: request.requestId }] }, `human-source-routed:${sourceId}`)
    if (!prior) void kickTask(task.taskId)
    return taskDTO(result.result.task)
  }
  return {
    listAuthorizationRequests: listHumanRequests, respondHumanRequest, respondPrivateHumanReply,
    store, ingest, recover, taskDetail, taskExecutions, isOwnNotification,
    listActivities: observation.listActivities, listTaskTimings: observation.listTaskTimings, listPerformance: observation.listPerformance, getActivityAuditStatus: observation.getActivityAuditStatus,
    listAlerts: () => [
      ...residentStore.listGroups().flatMap(group => {
        const failed = group.messages.filter(message => ['failed', 'decision-failed', 'decision-commit-failed'].includes(message.agentDeliveryStatus))
        return failed.length ? [{ alertId: `coordination:${group.groupId}`, fingerprint: `coordination:${group.groupId}`,
          detail: failed[0].agentDeliveryError ?? '群消息归类或协调失败，原消息尚未处理。', status: 'active',
          lastSeenAt: failed[0].agentDeliveryAt ?? new Date().toISOString() }] : []
      }),
      ...[...failures.values()].map(item => ({ alertId: `failure:${item.id}`, taskId: taskCache.has(item.id) ? item.id : undefined, fingerprint: `task-session:${item.id}`, detail: item.code, status: 'active', lastSeenAt: item.at ?? new Date().toISOString() })),
      ...[...operationCache.values()].filter(item => item.state === 'unknown').map(item => ({ alertId: `operation:${item.id ?? item.operationId}`, taskId: item.taskId, fingerprint: `unknown-operation:${item.id ?? item.operationId}`, detail: '执行效果未知，已阻止后续操作；须核实原始效果。', status: 'active', lastSeenAt: item.updatedAt ?? item.createdAt })),
      ...[...notificationCache.values()].filter(item => item.state === 'unknown').map(item => ({ alertId: `notification:${item.id}`, taskId: item.taskId, fingerprint: `unknown-notification:${item.id}`, detail: '群通知发送结果尚未回读确认。', status: 'active', lastSeenAt: item.updatedAt })),
      ...[...taskCache.values()].filter(item => item.status === 'active' && (item.lastDecision?.action === 'blocked' || item.lastDecision?.action === 'wait' && !!item.lastDecision?.question?.trim())).map(item => ({ alertId: `task-blocked:${item.taskId}`, taskId: item.taskId, fingerprint: `task-blocked:${item.taskId}`, detail: item.lastDecision.summary, status: 'active', lastSeenAt: item.updatedAt })),
    ],
    listTopics: groupId => residentStore.listTopics(groupId), getTopic: (groupId, topicId) => residentStore.getTopic(groupId, topicId),
    getTopicContext: args => residentStore.getTopicContext(args),
    async retryMessage({ groupId, messageId }) {
      if (!legacy.getGroup(groupId)) fail('group_not_subscribed')
      const sources = (await query('source.list', { groupId })).filter(source => source.messageId === messageId)
      if (!sources.length) {
        const message = residentStore.getGroup(groupId)?.messages.find(item => item.messageId === messageId)
        if (!message) fail('TASK_SESSION_SOURCE_NOT_FOUND')
        const actorId = message.senderOpenDingTalkId ?? message.actorId
        if (!actorId) fail('TASK_SESSION_AUTHENTICATED_SOURCE_REQUIRED')
        if (isOwnNotification({ ...message, groupId })) fail('TASK_SESSION_OWN_NOTIFICATION')
        const sourceId = `im:${hash([groupId, messageId, message.messageVersion ?? 1])}`
        await command('source.acceptHistory', { sourceId, groupId, messageId, version: message.messageVersion ?? 1,
          actorId, senderName: message.senderName ?? '', text: message.text ?? '', quote: message.quotedMessage ?? null,
          resources: message.resourceRefs ?? message.imageRefs ?? [], timestamp: message.occurredAt,
          authorizationRef: `message-retry:${groupId}:${messageId}:${message.messageVersion ?? 1}` }, `retry-source:${sourceId}`)
      }
      // Recover a partially accepted explicit retry without changing any message facts.
      await residentStore.retryBackgroundMessageRouting({ groupId, messageId })
      // Never clear an unknown-effect fence or repeat an already applied topic action.
      await topicCoordinator.retryMessage(groupId, messageId)
      await kickGroup(groupId)
      await recover()
      return { groupId, messageId, recoveryRequested: true }
    },
    isGroup: groupId => !!legacy.getGroup(groupId),
    async archiveTask({ taskId }) {
      const task = await requireTask(taskId)
      if (!config.webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
      const result = await command('task.archive', { taskId: task.taskId, actorId: config.webActorId })
      return taskDTO(result.result.task)
    },
    async boardTasks() { return Promise.all((await query('task.list')).map(taskDTO)) },
    async reconcileWebTaskTopics(args) {
      if (!config.webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
      await refreshTasks()
      for (const item of await query('execution.list')) executionCache.set(item.executionId, item)
      return residentStore.reconcileWebTaskTopics(args)
    },
    async createTask(args) { return taskDTO(await webTopicAction(args, null, 'new-task')) },
    async appendTaskContext(args) { return taskDTO(await webTopicAction(args, await requireTask(args.taskId), 'task-context')) },
    async taskDialogue(taskId) {
      const task = await requireTask(taskId)
      return { taskId, sessionId: task.sessionId, messages: task.dialogue ?? [],
        writable: !!config.webActorId && !task.archivedAt && task.status === 'active' && task.control === 'active',
        error: failures.get(taskId)?.code ?? null }
    },
    async sendTaskDialogue({ taskId, requestId, text }) {
      if (!config.webActorId) fail('TASK_SESSION_WEB_ACTOR_REQUIRED')
      const receipt = await command('task.dialogue.add', { taskId, requestId, text, actorId: config.webActorId }, `dialogue:${taskId}:${requestId}`)
      // The durable wake survives a closed tab, a lost response and Host restart.
      void kickTask(taskId).catch(() => {})
      return receipt.result.message
    },
    async cancelTask(args) { return taskDTO(await webTopicAction(args, await requireTask(args.taskId), 'task-cancel')) },
    async whenIdle() {
      const notificationAttempts = new Set()
      await schedulePending()
      await deliverNotifications(notificationAttempts)
      do {
        await Promise.allSettled([scheduling, ...inflightTasks.values(), ...inflightExecutions.values(), ...inflightGroups.values(), ...inflightNotifications.values()].filter(Boolean))
        await schedulePending()
        await deliverNotifications(notificationAttempts)
      } while (scheduling || [inflightTasks,inflightExecutions,inflightGroups,inflightNotifications].some(map => map.size))
    },
    async close() {
      closed = true
      clearTimeout(providerRetryTimer)
      stopObservation?.()
      await observationTail
      await topicCoordinator.close()
      await Promise.all([taskSessions.close(), executionSessions.close()])
      await Promise.allSettled([scheduling, recovering, ...inflightTasks.values(), ...inflightExecutions.values(), ...inflightGroups.values(), ...inflightNotifications.values()].filter(Boolean))
      await persistence.close()
      if (!suppliedStore) await store.close()
    },
  }
}
