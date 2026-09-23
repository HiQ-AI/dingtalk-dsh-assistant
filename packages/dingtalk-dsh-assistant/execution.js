import { openExecutionStore } from './execution-store.js'
import { openExecutionArtifacts } from './execution-artifacts.js'
import { createExecutionController } from './execution-controller.js'
import { createExecutionSessions } from './execution-session.js'

export const name = 'dingtalk-execution-foundation'
export const inject = ['executionWorkflows', 'agents', 'agentLoop', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'tools', 'systemPrompt']

/** 独立入口；不读取、写回或迁移旧resident的Task账。 */
export async function openExecutionRuntime({ ctx, dbPath, instanceId, artifactDirectory, initialize = false, workflows, readTools = [], maxConcurrentRuns = 4, changeQuietMs, maxChangeDelayMs }) {
  const store = await openExecutionStore({ dbPath, instanceId, initialize })
  let sessions, controller
  try {
    const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize })
    sessions = createExecutionSessions({ ctx, isCurrent: binding => controller.isCurrent(binding) })
    controller = createExecutionController({ store, artifacts, sessions, workflows, readTools, maxConcurrentRuns,
      ...(changeQuietMs === undefined ? {} : { changeQuietMs }), ...(maxChangeDelayMs === undefined ? {} : { maxChangeDelayMs }),
    })
    return { controller, store, artifacts, async close() { await controller.close(); await store.close() } }
  } catch (error) { await sessions?.close(); await store.close(); throw error }
}

export async function apply(ctx, config) {
  if (config.initialize) throw new Error('execution_initialization_is_offline_only')
  const runtime = await openExecutionRuntime({ ctx, ...config, initialize: false, workflows: ctx.executionWorkflows })
  try {
    ctx.provide('execution', runtime)
    ctx.effect(() => () => runtime.close())
  } catch (error) { await runtime.close(); throw error }
}
