import { deliverTaskNotification } from './notification-delivery.js'
import { inspectStoppedNativeOperation, readNativeOperationContext, readExecutionProgress } from './dynamic-operation-readback.js'
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
import { taskWorkspace, taskExecutionWorkspace, taskDirectories, checkedTaskDirectory } from './session-workspaces.js'
import { installTaskSessionPersistence, taskSessionLogRoot } from './task-session-persistence.js'
import { formatTaskGroupReply } from './group-reply-format.js'
import { sameDeliveredText } from './group-message.js'

const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const clean = value => JSON.parse(JSON.stringify(value))
const string = { type: 'string' }
const texts = { type: 'array', items: string }
// 模型只接收执行当前目标和结果；完整输入、旧输入及宿主凭据留在持久账。
export function taskExecutionContext(execution) {
  const fields = ['executionId', 'sessionId', 'taskId', 'key', 'inputVersion', 'requirementRevision', 'controlRevision',
    'leaseEpoch', 'inputDigest', 'status', 'drained', 'recovering', 'cancelRequested', 'result', 'updatedAt', 'progressReview']
  return { ...Object.fromEntries(fields.filter(key => Object.hasOwn(execution, key)).map(key => [key, execution[key]])),
    input: Object.fromEntries(['title', 'objective', 'recoveryReadOnly', 'readbackOperationId', 'skillNames']
      .filter(key => Object.hasOwn(execution.input ?? {}, key)).map(key => [key, execution.input[key]])) }
}
const taskOperationContext = operation => Object.fromEntries(['operationId', 'executionId', 'state', 'requirementRevision',
  'controlRevision', 'definition', 'resourceKeys', 'evidenceRef', ...(operation.state === 'succeeded' ? [] : ['result'])]
  .filter(key => Object.hasOwn(operation, key)).map(key => [key, operation[key]]))
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
  const taskLimit = () => legacy.getAgentConfig().maxConcurrentTasks ?? config.maxConcurrentTasks ?? 5
  const executionLimit = () => config.maxConcurrentExecutions ?? taskLimit()
  const reserveTask = taskId => taskSlots.has(taskId) || taskSlots.size < taskLimit() && (taskSlots.add(taskId), true)
  const retryReady = id => (failures.get(id)?.retryAfter ?? 0) <= Date.now()
  let closed = false, recovering, scheduling, scheduleRequested = false
  const query = (kind, args = {}) => store.query({ kind, ...args })
  const taskCache = new Map(), operationCache = new Map(), notificationCache = new Map(), executionCache = new Map()
  const refreshTasks = async () => { taskCache.clear(); for (const task of await query('task.list')) taskCache.set(task.taskId, topicTaskView(task)) }
  function topicTaskView(task) { return { ...task, state: task.status === 'completed' ? 'completed' : task.control === 'cancelled' ? 'cancelled' : task.control === 'paused' || task.drained ? 'waiting' : 'running', inputVersion: task.requirementRevision, runSequence: task.runSequence ?? 1, topicRefs: task.topicRefs ?? [], appliedOperations: task.appliedOperations ?? [], acceptanceCriteria: task.requirements ?? [], taskPromptRefs: [] } }
  const command = async (kind, args, id = `${kind}:${randomUUID()}`) => {
    const receipt = await store.command({ id, kind, args: clean(args) })
    if (receipt.result?.execution) executionCache.set(receipt.result.execution.executionId, receipt.result.execution)
    if (receipt.result?.operation) operationCache.set(receipt.result.operation.id ?? receipt.result.operation.operationId, receipt.result.operation)
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
  const recoveryCandidates = [...taskCache.values()].filter(task => task.status === 'active' && task.control === 'active'
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
  residentStore?.setTaskSessionReader?.({ getTask: id => taskCache.get(id), listTasks: () => [...taskCache.values()] })
  const models = () => { const { provider, model, reasoningEffort } = legacy.getAgentConfig(); return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }
  const currentTask = async binding => {
    const task = await query('task.get', { taskId: binding.taskId })
    return !!task && !task.recovering && !task.drained && task.status === 'active' && task.control === 'active' && task.sessionId === binding.sessionId
      && task.leaseEpoch === binding.leaseEpoch && task.requirementRevision === binding.requirementRevision && task.controlRevision === binding.controlRevision
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
      failures.set(id, { id, code: error.code ?? error.message, at: new Date().toISOString(), retryAfter: Date.now() + Math.max(100, config.retryIntervalMs ?? 5000) })
      ctx.logger?.warn?.(`task-session ${id}: ${error.code ?? error.message}`)
      throw error
    }).finally(async () => {
      let again = false
      if (!closed && map === inflightTasks) {
        const pending = await query('wake.list', { taskId: id }).catch(() => [])
        const task = await query('task.get', { taskId: id }).catch(() => null)
        again = task?.status === 'active' && task.control === 'active' && task.drained
          && !task.humanRequests?.some(request => request.status === 'waiting-reply')
          && pending.some(item => item.state !== 'acked')
      }
      map.delete(id)
      if (!closed && (map === inflightTasks || map === inflightExecutions)) {
        const taskId = map === inflightTasks ? id : (await query('execution.get', { executionId: id }).catch(() => null))?.taskId
        if (taskId && !inflightTasks.has(taskId)) {
          const task = await query('task.get', { taskId }).catch(() => null)
          const executions = await query('execution.list', { taskId }).catch(() => [])
          if (!task || task.drained && !executions.some(item => !item.drained || item.status === 'queued')) taskSlots.delete(taskId)
        }
      }
      if (again) void kickTask(id)
      if (!closed && (map === inflightTasks || map === inflightExecutions)) void schedulePending()
    })
    map.set(id, promise)
    promise.catch(() => {})
    return promise
  }
  function schedulePending() {
    if (closed) return Promise.resolve()
    scheduleRequested = true
    if (scheduling) return scheduling
    scheduling = (async () => {
      while (scheduleRequested && !closed) {
        scheduleRequested = false
        // SQLite is the durable queue. A freed slot promotes existing work immediately,
        // without depending on a periodic recovery tick or manufacturing another wake.
        for (const task of await query('task.list')) {
          if (closed) return
          if (!retryReady(task.taskId) || inflightTasks.has(task.taskId) || !task.drained || task.recovering || task.status !== 'active' || task.control !== 'active') continue
          if (task.humanRequests?.some(request => request.status === 'waiting-reply')) continue
          if (!taskSlots.has(task.taskId) && taskSlots.size >= taskLimit()) continue
          if ((await query('wake.list', { taskId: task.taskId })).some(item => item.state !== 'acked')) void kickTask(task.taskId)
        }
        for (const execution of await query('execution.list')) {
          if (closed || inflightExecutions.size >= executionLimit()) break
          if (!retryReady(execution.executionId) || inflightExecutions.has(execution.executionId) || !execution.drained || execution.recovering || execution.status !== 'queued' || execution.cancelRequested) continue
          if (!taskSlots.has(execution.taskId) && taskSlots.size >= taskLimit()) continue
          void kickExecution(execution.executionId)
        }
      }
    })().catch(error => { failures.set('scheduler', { id: 'scheduler', code: error.code ?? error.message }) })
      .finally(() => { scheduling = undefined })
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
  const authorize = (task, source) => {
    if (!source?.actorId || task.groupId !== source.groupId || ![task.ownerActorId, config.ownerActorId].filter(Boolean).includes(source.actorId)) fail('TASK_SESSION_SOURCE_FORBIDDEN')
  }
  const taskDTO = async task => {
    const executions = await query('execution.list', { taskId: task.taskId })
    const pendingWake = !task.lastDecision && (await query('wake.list', { taskId: task.taskId })).some(wake => wake.state !== 'acked')
    const state = taskBoardState(task, executions, pendingWake)
    return { ...task, state,
    topicRefs: task.topicRefs ?? [], executionCount: executions.length, waitingReason: state === 'waiting' ? task.lastDecision?.summary ?? '' : '',
    controlState: task.control, inputVersion: task.requirementRevision, result: task.completion?.result ?? task.lastDecision ?? null,
    session: { sessionId: task.sessionId, sessionBound: task.sessionBound, status: task.drained ? 'idle' : 'running', workspaceDir: await taskWorkspace(root, task.taskId), logPath: taskSessionLogRoot(root, task.taskId) },
    legacyReadonly: false }
  }
  async function taskDetail(taskId) {
    const task = await query('task.get', { taskId })
    if (!task) return null
    return { ...await taskDTO(task), executions: (await taskExecutions(taskId)).executions,
      blockers: await query('task.blockers', { taskId }), notifications: await query('notification.list', { taskId }) }
  }
  async function taskExecutions(taskId, { offset = 0, limit = 50 } = {}) {
    const all = await query('execution.list', { taskId })
    const executions = await Promise.all(all.slice(offset, offset + limit).map(async execution => ({ ...execution, objective: execution.prompt,
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
        || material.actorId !== source.actorId || material.messageId !== source.messageId || material.text !== source.text
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
    const material = clean({ taskId, sourceId: source.sourceId, actorId: source.actorId, messageId: source.messageId,
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
    const topicSources = [...new Map(action.topicRefs.flatMap(ref => resolveTopicMessages(residentStore.getGroup(groupId), ref.topicId, ref.revision)).map(message => [message.messageId, message])).values()]
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
    const source = existingTask ? basis.findLast(item => item.actorId === existingTask.ownerActorId || item.actorId === config.ownerActorId)
      : basis.findLast(item => item.channel !== 'web' && item.channel !== 'internal') ?? basis.at(-1)
    if (!source) fail('TASK_TOPIC_AUTHENTICATED_SOURCE_REQUIRED')
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
      task = await requireTask(operation.taskId); authorize(task, source)
      const topicRefs = [...new Map([...(task.topicRefs ?? []), ...refs].map(ref => [ref.topicId, ref])).values()]
      const args = { taskId: task.taskId, expectedRequirementRevision: action.inputVersion, expectedControlRevision: task.controlRevision,
        topicRefs, operationId: operation.operationId }
      const pendingHuman = action.kind === 'task-context' ? task.humanRequests?.findLast(request => request.status === 'waiting-reply') : null
      const receipt = action.kind === 'task-cancel'
        ? await command('task.control', { ...args, control: 'cancelled', reason: action.reason }, id)
        : pendingHuman
        ? await command('task.human.respond', { ...args, requestId: pendingHuman.requestId,
          sourceId: source.sourceId }, id)
        : await command(action.kind === 'task-reopen' ? 'task.reopen' : 'task.revise', { ...args,
          request: `${task.request}\n\n[话题补充]\n${action.context ?? source.text}`,
          sourceRefs: [...new Set([...task.sourceRefs, ...sources.map(item => item.sourceId)])],
          ...(action.title ? { title: action.title } : {}), ...(action.objective ? { objective: action.objective } : {}),
          ...(action.acceptanceCriteria ? { requirements: action.acceptanceCriteria } : {}) }, id)
      task = receipt.result.task
      if (!pendingHuman) await cancelLiveTask(task.taskId)
    }
    for (const item of sources) await materializeSource(task.taskId, item)
    if (action.kind !== 'task-cancel') void kickTask(task.taskId)
  }
  const topicCoordinator = await openTaskTopicCoordinator({ ctx, store: residentStore, legacy, root, models, applyAction: applyTopicAction,
    appendOutbox: async args => {
      const reply = formatTaskGroupReply({ source: { groupId: args.groupId, messageId: args.replyToMessageId, senderOpenDingTalkId: args.replyToSenderOpenDingTalkId }, summary: args.text, evidence: [], limitations: [], signature: legacy.getAgentConfig().replySignature })
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
      if ((await query('operation.list')).some(item => item.state === 'unknown')) fail('DYNAMIC_OPERATION_UNRESOLVED')
      await command('operation.prepare', { binding, operationId, key, definition: { toolName, argumentsDigest: hash(args) },
        authorizationRef: `task:${binding.taskId}:requirement:${binding.requirementRevision}`, resourceKeys: event.nativeConcurrencySafe === true ? [] : ['host-native-operation'] }, `prepare:${key}`)
      let receipt
      for (;;) {
        try { receipt = await command('operation.start', { binding, operationId }, `start:${key}`); break }
        catch (error) {
          if (error.code === 'DYNAMIC_OPERATION_UNRESOLVED') {
            // The atomic start gate refused dispatch. Retire only this exact still-prepared request;
            // never clear the unrelated unknown operation or an operation that already started.
            await command('operation.cancelPrepared', { binding, operationId, key, reason: error.code }, `not-dispatched:${key}`)
          }
          if (error.code !== 'DYNAMIC_RESOURCE_BUSY' || closed || !await query('execution.current', { binding })) throw error
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      if (!receipt.dispatchEligible) fail(receipt.result.operation.state === 'unknown' ? 'DYNAMIC_OPERATION_UNRESOLVED' : 'DYNAMIC_OPERATION_ALREADY_DISPATCHED')
      return { operationId }
    }
    const state = event.cancelled || event.result?.isError ? 'unknown' : event.jobReceipt && event.jobReceipt.status !== 'completed' ? 'failed' : 'succeeded'
    await command('operation.settle', { binding, operationId, state,
      result: { callId, toolName, isError: event.result?.isError === true, resultDigest: hash(event.result?.content ?? event.result ?? null), ...(event.jobReceipt ? { jobReceipt: event.jobReceipt } : {}) } }, `settle:${key}`)
    return { operationId }
  }
  function kickExecution(executionId) {
    if (closed || !retryReady(executionId) || !inflightExecutions.has(executionId) && inflightExecutions.size >= executionLimit()) return Promise.resolve()
    return track(inflightExecutions, executionId, async () => {
      const candidate = await query('execution.get', { executionId })
      if (!candidate || candidate.status !== 'queued' || !candidate.drained || candidate.cancelRequested || !reserveTask(candidate.taskId)) return
      const claimed = await command('execution.claim', { executionId })
      const { binding, execution } = claimed.result
      let drained = true
      try {
        const result = await executionSessions.run({ binding, input: execution.input, definition: { ...models(), ...execution.definition,
          prompt: execution.prompt, allowedTools: execution.definition?.allowedTools ?? [], nativeTools: true, outputSchema: dynamicExecutionOutputSchema },
          onSessionBound: async () => { await attachWorkspace(binding.sessionId, await taskWorkspace(root, binding.taskId), (await requireTask(binding.taskId)).title); return command('execution.sessionBound', { binding }, `execution-bound:${executionId}:${binding.leaseEpoch}`) },
          onNativeExecution: nativeOperation,
          onResult: output => command('execution.result', { binding, output }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`) })
        if (result.status !== 'submitted') await command('execution.result', { binding, error: { code: result.reason ?? result.status } }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`)
      } catch (error) {
        drained = error.executionDrained !== false
        if (drained) await command('execution.result', { binding, error: { code: error.code ?? error.message } }, `execution-result:${executionId}:${binding.inputVersion ?? 1}`).catch(() => {})
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
      if (task.status !== 'active' || task.control !== 'active') { taskSlots.delete(taskId); return }
      if (task.humanRequests?.some(request => request.status === 'waiting-reply')) { taskSlots.delete(taskId); return }
      if (!task.drained) return
      if (!(await query('wake.list', { taskId })).some(item => item.state !== 'acked')) return
      const claimed = await command('task.claim', { taskId })
      const { binding, wakeIds, wakes } = claimed.result
      task = claimed.result.task
      let drained = true, submitted = false
      try {
        const sources = (await Promise.all(task.sourceRefs.map(sourceId => query('source.get', { sourceId })))).filter(Boolean)
        const materials = await Promise.all(sources.map(source => materializeSource(taskId, source)))
        const operations = await query('operation.list', { taskId })
        const runResult = await taskSessions.run({ binding, input: { task: { ...task, humanRequests: task.humanRequests?.slice(-1) }, sources, materials: materials.map(({ resources, ...value }) => ({ ...value, resources: resources.map(({ value: _body, ...resource }) => resource) })), wakes, executions: (await query('execution.list', { taskId })).map(taskExecutionContext),
          operations: operations.filter(operation => operation.state !== 'succeeded').map(taskOperationContext),
          operationCounts: Object.fromEntries(Object.entries(Object.groupBy(operations, operation => operation.state)).map(([state, items]) => [state, items.length])),
          blockers: await query('task.blockers', { taskId }) }, ...models(), agentPreset: legacy.getAgentConfig().agentPreset,
          groupResponsibility: legacy.getGroup(task.groupId)?.responsibility ?? '',
          onSessionBound: async () => { await attachWorkspace(binding.sessionId, await taskWorkspace(root, taskId), task.title); return command('task.sessionBound', { binding }, `task-bound:${taskId}:${binding.leaseEpoch}`) },
          delegate: async args => {
            if (args.readbackOperationId) {
              const operation = await query('operation.get', { operationId: args.readbackOperationId })
              if (args.readOnly !== true || operation?.taskId !== taskId) fail('TASK_OPERATION_SCOPE_MISMATCH')
            }
            if (args.skillNames !== undefined && (!Array.isArray(args.skillNames)
              || args.skillNames.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
              || new Set(args.skillNames).size !== args.skillNames.length)) fail('TASK_SKILL_NAMES_INVALID')
            const dispatchId = `${args.executionId ? 'continue' : 'delegate'}:${taskId}:${binding.requirementRevision}:${args.key}`
            const prior = await query('receipt.get', { id: dispatchId })
            if (prior) {
              if (prior.result.execution.input.objective !== args.objective || (args.executionId && prior.result.execution.executionId !== args.executionId)
                || (prior.result.execution.input.recoveryReadOnly === true) !== (args.readOnly === true)
                || (prior.result.execution.input.readbackOperationId ?? null) !== (args.readbackOperationId ?? null)
                || hash(prior.result.execution.input.skillNames ?? []) !== hash(args.skillNames ?? [])) fail('DYNAMIC_DISPATCH_KEY_CONFLICT')
              return { executionId: prior.result.execution.executionId, status: prior.result.execution.status, sessionId: prior.result.execution.sessionId }
            }
            let originalOperation
            if (args.readOnly === true && args.readbackOperationId) {
              const operation = (await query('operation.list', { taskId })).find(item => item.operationId === args.readbackOperationId)
              if (!operation) fail('TASK_OPERATION_SCOPE_MISMATCH')
              originalOperation = safeNotificationDetail(await readNativeOperationContext({ ctx, operation }))
            }
            const payload = { binding, key: args.key, prompt: `受托小目标：${args.objective}\n具体执行由你负责，可在同一会话内持续调查、操作、验证和纠错。不得再次委派；不能宣布整体任务完成。只依据当前任务真实来源和权限执行。结果包含实际证据、限制及产物。最后调用execution_submit。`,
              input: { task: { taskId, request: task.request, requirementRevision: binding.requirementRevision, ownerActorId: task.ownerActorId, authorizationSourceId: task.metadata?.authorizationSourceId }, sources,
                title: args.key, objective: args.objective, recoveryReadOnly: args.readOnly === true, readbackOperationId: args.readbackOperationId ?? null, ...(originalOperation ? { originalOperation } : {}), context: args.context ?? '', skillNames: args.skillNames ?? [], materialPaths: materials.map(item => item.path), previousExecutions: (await query('execution.list', { taskId })).map(taskExecutionContext) },
              definition: { nativeTools: true, recoveryReadOnly: args.readOnly === true, protectedPaths: [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, `${config.dbPath}.initialized`], agentPreset: legacy.getAgentConfig().agentPreset, allowedTools: [], outputSchema: dynamicExecutionOutputSchema }, resourceKeys: args.resourceKeys ?? [] }
            const accepted = args.executionId ? await command('execution.continue', { ...payload, executionId: args.executionId }, dispatchId)
              : await command('execution.dispatch', payload, dispatchId)
            void kickExecution(accepted.result.execution.executionId)
            return { executionId: accepted.result.execution.executionId, status: accepted.result.execution.status, sessionId: accepted.result.execution.sessionId }
          },
          readExecution: async executionId => { const execution = await query('execution.get', { executionId }); if (execution?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH'); return taskExecutionContext(execution) },
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
              const proof = await inspectStoppedNativeOperation({ ctx, operation, executions,
                execution: executions.find(item => item.executionId === operation.executionId) })
              if (proof) return (await command('operation.reconcile-stopped', { binding, operationId, proof }, `reconcile-stopped:${operationId}:${hash(proof)}`)).result
              return { operation, unresolved: true, reason: error.code,
                nextAction: 'Use task_delegate with readOnly=true and readbackOperationId=this operationId to associate an investigation with the original operation. The configured native tools remain available. Inspect actual effects without replay, then call task_operation_reconcile again. Verified Host stop/drain plus real observations may close only as failed with partial effects, never success.' }
            }
          },
          cancelExecution: async ({ executionId, reason }) => {
            const execution = await query('execution.get', { executionId }); if (execution?.taskId !== taskId) fail('TASK_EXECUTION_SCOPE_MISMATCH')
            await command('execution.cancel', { binding, executionId, reason })
            await executionSessions.cancel(executionId)
            return { executionId, cancellationRequested: true }
          },
          submit: async decision => {
            if (decision.action === 'complete') {
              const source = await sourceFor(task)
              let notification
              if (source && source.channel !== 'web' && !source.sourceId.startsWith('web:')) {
                const reply = formatTaskGroupReply({ source: { groupId: source.groupId, messageId: source.messageId, senderOpenDingTalkId: source.actorId, senderName: source.senderName },
                  summary: decision.summary, evidence: decision.evidence, limitations: decision.limitations,
                  signature: legacy.getAgentConfig().replySignature, internalIds: await replyInternalIds(task) })
                notification = { ...reply, conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId, fact: { taskId }, kind: 'task-completed' }
              }
              await command('task.complete', { binding, summary: decision.summary, result: decision, ...(notification ? { notification } : {}) }, `complete:${taskId}:${binding.requirementRevision}`)
            } else {
              await command('task.wait', { binding, ...decision, ...(decision.question?.trim() ? { humanRequest: {
                requestId: `human-${hash([taskId, binding.requirementRevision, binding.controlRevision, binding.leaseEpoch])}`,
                reason: decision.summary, attemptedActions: decision.attemptedActions ?? [] } } : {}) }, `wait:${taskId}:${binding.leaseEpoch}`)
              if (decision.question?.trim()) {
                const source = [...sources].reverse().find(item => item.actorId === task.ownerActorId) ?? await sourceFor(task)
                await queueReply(task, source, { summary: decision.question, evidence: [], limitations: [] }, `question:${taskId}:${binding.requirementRevision}:${hash(decision.question)}`, 'question')
              }
            }
            submitted = true
            return { accepted: true }
          } })
        if (!submitted && runResult.status === 'no_submission') {
          failures.set(taskId, { id: taskId, code: runResult.reason ?? 'TASK_SESSION_NO_SUBMISSION' })
          await command('task.wait', { binding, action: 'blocked', summary: '任务会话本轮未能提交有效决定，原任务和执行结果已保留。',
            limitations: [runResult.reason ?? 'TASK_SESSION_NO_SUBMISSION'] }, `task-technical-block:${taskId}:${binding.leaseEpoch}`)
          submitted = true
        }
        if (submitted) await command('wake.ack', { binding, wakeIds }, `wake-ack:${taskId}:${binding.leaseEpoch}`)
      } catch (error) { drained = error.taskSessionDrained !== false; throw error }
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
  async function queueReply(task, source, decision, id, kind) {
    if (!source || source.channel === 'web' || source.sourceId.startsWith('web:')) return
    const reply = formatTaskGroupReply({ source: { groupId: source.groupId, messageId: source.messageId,
      senderOpenDingTalkId: source.actorId, senderName: source.senderName }, summary: decision.summary,
      evidence: decision.evidence, limitations: decision.limitations,
      signature: legacy.getAgentConfig().replySignature, internalIds: await replyInternalIds(task) })
    await command('notification.prepare', { notificationId: id, taskId: task.taskId, requirementRevision: task.requirementRevision,
      kind, payload: { ...reply, conversationId: source.groupId, sourceMessageId: source.messageId, actorId: source.actorId, fact: { taskId: task.taskId }, kind } }, `prepare-notification:${id}`)
    void deliverNotifications()
  }
  let notificationTransportRetryAt = 0
  async function deliverNotifications(attempted) {
    for (const notification of await query('notification.list')) {
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
      for (const candidate of recoveryCandidates) {
        const task = await query('task.get', { taskId: candidate.taskId })
        if (task.status !== 'active' || task.control !== 'active' || !task.drained
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
        if (!task || task.status !== 'active' || task.control !== 'active' || !executionProgressDue(execution)) continue
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
      await deliverNotifications()
      return { failures: [...failures.values()], recovery: pending }
    })().finally(() => { recovering = undefined })
  }
  async function webTopicAction(args, task, kind) {
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
    const action = previous?.requestIdentity?.action ?? { kind, topicRefs: args.topicRefs ?? task?.topicRefs ?? [],
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
    return (await query('task.list')).flatMap(task => (task.humanRequests ?? []).map(request => ({ ...request,
      taskSessionRequest: true, taskId: task.taskId, groupId: task.groupId, objective: task.objective,
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
    await command('source.record', { sourceId, groupId: task.groupId, messageId: sourceId,
      actorId: config.webActorId, text: args.reply, timestamp: '', channel: 'web' }, `source:${sourceId}`)
    const result = await command('task.human.respond', { taskId: task.taskId, requestId: args.humanRequestId,
      sourceId, expectedRequirementRevision: args.expectedRequirementRevision, expectedControlRevision: args.expectedControlRevision }, receiptId)
    await command('source.routed', { sourceId, receipt: [{ taskId: task.taskId, humanRequestId: args.humanRequestId }] }, `human-source-routed:${sourceId}`)
    void kickTask(task.taskId)
    return taskDTO(result.result.task)
  }
  return {
    listAuthorizationRequests: listHumanRequests, respondHumanRequest,
    store, ingest, recover, taskDetail, taskExecutions, isOwnNotification,
    listActivities: observation.listActivities, listTaskTimings: observation.listTaskTimings, listPerformance: observation.listPerformance, getActivityAuditStatus: observation.getActivityAuditStatus,
    listAlerts: () => [
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
    async boardTasks() { return Promise.all((await query('task.list')).map(taskDTO)) },
    async createTask(args) { return taskDTO(await webTopicAction(args, null, 'new-task')) },
    async appendTaskContext(args) { return taskDTO(await webTopicAction(args, await requireTask(args.taskId), 'task-context')) },
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
