import { openExecutionStore } from './execution-store.js'
import { openExecutionArtifacts, parseArtifactReference } from './execution-artifacts.js'
import { taskDirectories } from './session-workspaces.js'
import { createExecutionController } from './execution-controller.js'
import { createExecutionSessions } from './execution-session.js'
import { createExecutionDelivery } from './execution-delivery.js'

export { freezeCandidate, readCandidate, verifyCandidate } from './execution-candidate.js'
export { createGitDelivery } from './execution-git.js'
export { createManagedWorkspaces } from './execution-workspace.js'

export const name = 'dingtalk-execution-foundation'
export const inject = ['executionWorkflows', 'agents', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'tools', 'systemPrompt']

/** 以已有持久工件引用区分布局；旧任务不会因升级或重启自动搬迁。 */
export function createTaskDirectoryResolver({ store, workspaceRoot }) {
  return async (taskId, { logicalTaskId } = {}) => {
    const plan = await store.query({ kind: 'task.plan', taskId })
    const reference = plan?.task.requirementRef ?? plan?.stages.find(stage => stage.requirementRef)?.requirementRef
      ?? (await store.query({ kind: 'run.list', taskId, limit: 1 }))[0]?.requirementRef
    if (reference) {
      const storedId = parseArtifactReference(reference).logicalTaskId
      if (!storedId) return null
      if (logicalTaskId && logicalTaskId !== storedId) throw new Error('TASK_DIRECTORY_IDENTITY_CONFLICT')
      logicalTaskId = storedId
    } else if (plan) return null
    logicalTaskId ??= (await store.query({ kind: 'task.family', taskId }))?.rootTaskId ?? taskId
    return taskDirectories(workspaceRoot, logicalTaskId)
  }
}

/** 按依赖顺序尝试全部清理；失败必须保留，不能让前项异常跳过数据库解锁。 */
export async function closeExecutionResources(resources) {
  const errors = []
  for (const [name, close] of resources) {
    try { await close() }
    catch (cause) { errors.push(new Error(`RESOURCE_CLOSE_FAILED:${name}`, { cause })) }
  }
  if (errors.length) throw new AggregateError(errors, 'EXECUTION_RESOURCE_CLOSE_FAILED')
}

/** 独立入口；不读取、写回或迁移旧resident的Task账。 */
export async function openExecutionRuntime({ ctx, dbPath, instanceId, artifactDirectory, taskWorkspaceRoot, initialize = false, workflows, historicalWorkflows = [], deliveryOptions, readTools = [], repositoryInspect, tools = [], getWorkspaceDir, maxConcurrentRuns = 4, changeQuietMs, maxChangeDelayMs }) {
  const store = await openExecutionStore({ dbPath, instanceId, initialize })
  let sessions, controller
  try {
    const getTaskDirectories = taskWorkspaceRoot ? createTaskDirectoryResolver({ store, workspaceRoot: taskWorkspaceRoot }) : undefined
    const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize, taskWorkspaceRoot, getTaskDirectories })
    const delivery = deliveryOptions ? createExecutionDelivery({ ...deliveryOptions, store, artifacts }) : undefined
    const registeredTools = typeof tools === 'function' ? await tools({ store, artifacts }) : tools
    sessions = createExecutionSessions({ ctx, isCurrent: binding => controller.isCurrent(binding), repositoryInspect, tools: registeredTools, getWorkspaceDir })
    const definitions = typeof workflows === 'function' ? await workflows(store, artifacts) : { workflows, historicalWorkflows }
    controller = createExecutionController({ store, artifacts, sessions, delivery, ...definitions, readTools, maxConcurrentRuns,
      ...(changeQuietMs === undefined ? {} : { changeQuietMs }), ...(maxChangeDelayMs === undefined ? {} : { maxChangeDelayMs }),
    })
    return { controller, store, artifacts, delivery, async close() { await closeExecutionResources([['controller', () => controller.close()], ['store', () => store.close()]]) } }
  } catch (error) {
    try { await closeExecutionResources([['sessions', () => sessions?.close()], ['store', () => store.close()]]) }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'EXECUTION_OPEN_CLEANUP_FAILED') }
    throw error
  }
}

export async function apply(ctx, config) {
  if (config.initialize) throw new Error('execution_initialization_is_offline_only')
  const runtime = await openExecutionRuntime({ ctx, ...config, initialize: false, workflows: ctx.executionWorkflows, deliveryOptions: ctx.executionDelivery })
  try {
    ctx.provide('execution', runtime)
    ctx.effect(() => () => runtime.close())
  } catch (error) { await runtime.close(); throw error }
}
