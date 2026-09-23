import { openExecutionStore } from './execution-store.js'
import { openExecutionArtifacts } from './execution-artifacts.js'
import { createExecutionController } from './execution-controller.js'
import { createExecutionSessions } from './execution-session.js'
import { createExecutionDelivery } from './execution-delivery.js'

export { freezeCandidate, readCandidate, verifyCandidate } from './execution-candidate.js'
export { createGitDelivery } from './execution-git.js'
export { createManagedWorkspaces } from './execution-workspace.js'

export const name = 'dingtalk-execution-foundation'
export const inject = ['executionWorkflows', 'agents', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'tools', 'systemPrompt']

/** 独立入口；不读取、写回或迁移旧resident的Task账。 */
export async function openExecutionRuntime({ ctx, dbPath, instanceId, artifactDirectory, initialize = false, workflows, deliveryOptions, readTools = [], maxConcurrentRuns = 4, changeQuietMs, maxChangeDelayMs }) {
  const store = await openExecutionStore({ dbPath, instanceId, initialize })
  let sessions, controller
  try {
    const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize })
    const delivery = deliveryOptions ? createExecutionDelivery({ ...deliveryOptions, store, artifacts }) : undefined
    sessions = createExecutionSessions({ ctx, isCurrent: binding => controller.isCurrent(binding) })
    controller = createExecutionController({ store, artifacts, sessions, delivery, workflows, readTools, maxConcurrentRuns,
      ...(changeQuietMs === undefined ? {} : { changeQuietMs }), ...(maxChangeDelayMs === undefined ? {} : { maxChangeDelayMs }),
    })
    return { controller, store, artifacts, delivery, async close() { await controller.close(); await store.close() } }
  } catch (error) { await sessions?.close(); await store.close(); throw error }
}

export async function apply(ctx, config) {
  if (config.initialize) throw new Error('execution_initialization_is_offline_only')
  const runtime = await openExecutionRuntime({ ctx, ...config, initialize: false, workflows: ctx.executionWorkflows, deliveryOptions: ctx.executionDelivery })
  try {
    ctx.provide('execution', runtime)
    ctx.effect(() => () => runtime.close())
  } catch (error) { await runtime.close(); throw error }
}
