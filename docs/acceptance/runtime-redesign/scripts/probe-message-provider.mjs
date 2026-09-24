import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createMessageModel } from '../../../../packages/dingtalk-dsh-assistant/message-model.js'
import { messageSchemas } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openWorkflowService } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

const { values } = parseArgs({ options: { profile: { type: 'string' }, output: { type: 'string' }, pipeline: { type: 'boolean' } } })
if (!values.profile || !values.output) throw new Error('profile and output required')
const require = createRequire(join(resolve(values.profile), 'package.json'))
const imported = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await imported('@deepseek-ai/cordis')
const { LlmRuntime } = await imported('@deepseek-ai/dsh-llm')
const provider = await imported('dsh-codex-connect')
const config = await fetch('http://127.0.0.1:18998/state/agent-config').then(response => response.json())
if (config.provider !== 'openai-codex') throw new Error('provider mismatch')
const ctx = new Context()
new LlmRuntime(ctx)
provider.apply(ctx, { ...provider.DEFAULT_OPENAI_CODEX_SETTINGS, enableProxy: Boolean(config.proxyUrl), ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}) })
const judge = createMessageModel({ llm: ctx.llm, modelConfig: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } })
const rows = []
try {
  for (const text of values.pipeline ? [] : ['请整理这条材料：北京为首都，只做文字摘要。', '先暂停翻译任务，另外查询审核任务的进度。', '不是让你执行 SQL，只分析脚本风险。']) {
    const started = performance.now(), signal = AbortSignal.timeout(20000)
    try {
      const response = await judge({ stage: 'S', schema: messageSchemas.S, input: { source: { text, actorId: 'synthetic-owner', conversationId: 'isolated-fixture' }, background: [], quotes: [], attachments: [], omissions: [] }, signal, maxOutputTokens: 2000 })
      rows.push({ stage: 'S', source: text, elapsedMs: Math.round(performance.now() - started), status: 'completed', ...response })
    } catch (error) {
      rows.push({ stage: 'S', source: text, elapsedMs: Math.round(performance.now() - started), status: 'failed', error: error.code ?? error.name })
    }
    console.log(JSON.stringify(rows.at(-1)))
  }
  if (values.pipeline) {
    for (const [pkg, symbol] of [['dsh-agent', 'AgentRegistry'], ['dsh-session', 'SessionStore'], ['dsh-session-projection', 'SessionProjectionRegistry']]) {
      const module = await imported(`@deepseek-ai/${pkg}`)
      new module[symbol](ctx)
    }
    const { SystemPrompt } = await imported('@deepseek-ai/dsh-system-prompt')
    new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
    const { ToolRuntime } = await imported('@deepseek-ai/dsh-tools')
    new ToolRuntime(ctx)
    const { AgentLoop } = await imported('@deepseek-ai/dsh-agent-loop')
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
    const { JsonlSessionPersistence } = await imported('@deepseek-ai/dsh-session-persistence-jsonl')
    const directory = resolve(values.output, '..', `native-${Date.now()}`)
    await mkdir(directory, { recursive: true })
    new JsonlSessionPersistence(ctx, { root: join(directory, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
    const dbPath = join(directory, 'control.db'), artifactDirectory = join(directory, 'artifacts')
    const init = await openExecutionStore({ dbPath, instanceId: 'live-provider-isolated', initialize: true })
    await init.close()
    await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
    const started = performance.now()
    const service = await openWorkflowService({ ctx, config: { dbPath, artifactDirectory, instanceId: 'live-provider-isolated', groupIds: ['isolated-fixture'], ownerActorId: 'synthetic-owner' },
      legacy: { getAgentConfig: () => config, getGroup: () => ({ messages: [], responsibility: '仅处理本次合成测试，不连接业务系统。' }) },
      judge: async args => { const start = performance.now(); const response = await judge(args); rows.push({ stage: args.stage, elapsedMs: Math.round(performance.now() - start), usage: response.usage, output: response.output }); return response },
    })
    try {
      const accepted = await service.ingest({ groupId: 'isolated-fixture', messageId: 'synthetic-1', senderOpenDingTalkId: 'synthetic-owner', text: '请创建一个材料分析任务：把“北京是中国首都”整理成一句摘要，不读取其他材料、不修改任何外部系统。' })
      rows.push({ stage: 'receive', elapsedMs: Math.round(performance.now() - started), accepted })
      const state = await service.messages.process(accepted.runId)
      for (const action of state.commands) if (action.result?.runId) await service.execution.controller.whenIdle(action.result.runId)
      rows.push({ stage: 'pipeline', elapsedMs: Math.round(performance.now() - started), state: await service.state(accepted.runId), tasks: await service.tasks() })
      console.log(JSON.stringify(rows.map(row => ({ stage: row.stage, elapsedMs: row.elapsedMs, status: row.state?.run.status, tasks: row.tasks?.map(task => ({ state: task.state, outcome: task.outcome, result: task.result, waitingReason: task.waitingReason })) }))))
    } finally { await service.close() }
  }
} finally {
  await ctx.fiber.dispose()
  await mkdir(resolve(values.output, '..'), { recursive: true })
  await writeFile(resolve(values.output), JSON.stringify({ provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, actualProvider: true, externalEffects: false, rows }, null, 2))
}
