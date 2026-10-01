// 复用本机已配置模型，仅执行无工具 S/R 判断；源库只读，不接入派发或钉钉通道。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow, defaultMessagePolicy } from '../../../../packages/dingtalk-dsh-assistant/message-workflow.js'
import { DatabaseSync } from 'node:sqlite'
import { createMessageModel, prepareMessageRequest } from '../../../../packages/dingtalk-dsh-assistant/message-model.js'
import { splitContext, unitContext, intentContext, messageSchemas, validateSplit, validateContextRequests, validateExecutionMaterialRefs } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'

const [profile, dbPath, outputPath, splitProbePath] = process.argv.slice(2)
if (!profile || !dbPath || !outputPath) throw new Error('需要 profile、只读源库和输出文件')
const require = createRequire(join(resolve(profile), 'package.json'))
const imported = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await imported('@deepseek-ai/cordis')
const { LlmRuntime } = await imported('@deepseek-ai/dsh-llm')
const provider = await imported('dsh-codex-connect')
const config = await fetch('http://127.0.0.1:18998/state/agent-config').then(response => response.json())
if (config.provider !== 'openai-codex') throw new Error('实际模型提供者与读取器不匹配')
const ctx = new Context()
new LlmRuntime(ctx)
provider.apply(ctx, { ...provider.DEFAULT_OPENAI_CODEX_SETTINGS, enableProxy: Boolean(config.proxyUrl), ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}) })
const judge = createMessageModel({ llm: ctx.llm, modelConfig: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } })
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = []
const priorSplits = splitProbePath ? JSON.parse(await readFile(splitProbePath, 'utf8')).rows : []
try {
  for (const sequence of [114, 115]) {
    const prior = priorSplits.find(row => row.sequence === sequence && row.stage === 'S' && row.status === 'validated')
    if (prior) { rows.push({ ...prior, reusedFrom: splitProbePath }); continue }
    const run = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE rowid=?').get(sequence).body)
    const input = splitContext(run.snapshot)
    const fitted = { input, prepared: prepareMessageRequest('S', input) }
    const started = Date.now()
    try {
      const directory = await mkdtemp(join(tmpdir(), 'message-live-model-'))
      const isolated = await openExecutionStore({ dbPath: join(directory, 'control.sqlite'), instanceId: 'model-probe', initialize: true })
      let response
      const workflow = createMessageWorkflow({ store: isolated, judge: async request => {
        if (request.stage === 'S') { response = await judge(request); return response }
        if (request.stage === 'R') return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['隔离验证不关联任何真实任务'] }
        return { kind: 'needs_clarification', reason: '隔离验证在业务派发前停止', question: '隔离测试终点' }
      } })
      try {
        await workflow.receive({ runId: `probe-${sequence}`, sourceKey: run.sourceKey, sourceVersion: run.sourceVersion,
          actorId: run.actorId, conversationId: run.conversationId, body: run.body, context: run.context }, { process: false })
        await isolated.command({ id: `snapshot-${sequence}`, kind: 'message.snapshot', args: { runId: `probe-${sequence}`, snapshot: run.snapshot } })
        const result = await workflow.process(`probe-${sequence}`)
        const node = result.nodes.find(item => item.nodeId === 'S' && item.status === 'succeeded')
        if (!node || !response) throw new Error(`S未通过默认workflow窗口:${result.run.reason ?? JSON.stringify(result.nodes.map(item => item.error))}`)
        validateSplit(response.output, run.body)
        validateContextRequests('S', response.output, fitted.input)
        if (result.commands.length) throw new Error('隔离模型验证不得产生业务命令')
        rows.push({ sequence, stage: 'S', elapsedMs: Date.now() - started, inputBytes: node.input.inputBytes,
          defaultPolicy: defaultMessagePolicy, hostNodeStatus: node.status, status: 'validated', output: response.output })
      } finally { await workflow.close(); await isolated.close(); await rm(directory, { recursive: true, force: true }) }

    } catch (error) { rows.push({ sequence, stage: 'S', status: 'failed', elapsedMs: Date.now() - started, error: error.code ?? error.message }); process.exitCode = 1 }
    console.log(JSON.stringify({ sequence, status: rows.at(-1).status, elapsedMs: rows.at(-1).elapsedMs }))
  }
  for (const sequence of [114, 115]) {
    const split = rows.find(row => row.sequence === sequence && row.stage === 'S' && row.status === 'validated')?.output
    if (split?.kind !== 'split' || split.units.length !== 1) continue
    const run = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE rowid=?').get(sequence).body)
    const base = unitContext(run.snapshot, { ...split.units[0], sharedConstraints: split.sharedConstraints })
    const binding = sequence === 114 ? { disposition: 'new', candidateId: null } : { disposition: 'existing', candidateId: 'isolated-task', taskId: 'isolated-task', state: 'running' }
    const facts = { actorMayCreate: true, actorMayControl: true,
      availableWorkflows: [{ id: 'task-investigation', label: '调查与分析', mode: 'read-only' }],
      unavailableWorkflows: ['生产数据变更执行'],
      ...(sequence === 115 ? { task: { taskId: 'isolated-task', goal: '按前述69条数据要求调查刷库方案、准备脚本并提交审批', status: 'running', ownerActorId: run.actorId } } : {}) }
    const input = intentContext(base, binding, facts, run.snapshot.policy)
    let actualOutput
    try {
      const response = await judge({ stage: 'I', input, schema: messageSchemas.I, signal: AbortSignal.timeout(defaultMessagePolicy.attemptMs), maxOutputTokens: 1500 })
      actualOutput = response.output
      validateExecutionMaterialRefs('I', actualOutput, input)
      const expected = sequence === 114 ? ['create', 'research'] : ['revise']
      if (response.output.kind !== 'intent' || !response.output.actions.some(action => expected.includes(action.intent))) throw new Error('准备与补充请求未进入预期意图')
      rows.push({ sequence, stage: 'I', status: 'validated', syntheticTaskFacts: true, output: response.output })
    } catch (error) { rows.push({ sequence, stage: 'I', status: 'failed', syntheticTaskFacts: true, ...(actualOutput ? { output: actualOutput } : {}), error: error.code ?? error.message }); process.exitCode = 1 }
  }
  const text = '小小鹏，现在帮忙看第一个sheet页70条数据集的审核状态：行业专家和lca专家分别是谁、是否完成审核。'
  const input = { sourceKey: 'isolated-business-query', sourceVersion: 1, actorId: 'requester', conversationId: 'isolated', text,
    goalText: text, constraints: [], sharedConstraints: [], referenceSources: [], executionMaterialRefs: [],
    candidates: [{ candidateId: 'old', title: '审核草稿保存和撤回通知缺陷', goal: '修复草稿、撤回通知功能', topicId: 'old-topic' }],
    candidateContinuation: null, candidatePage: 0, omittedCandidateCount: 0, accumulatedEvidence: [] }
  try {
    const response = await judge({ stage: 'R', input, schema: messageSchemas.R, signal: AbortSignal.timeout(60000), maxOutputTokens: 1800 })
    validateContextRequests('R', response.output, input)
    if (response.output.kind !== 'binding' || response.output.disposition !== 'new') throw new Error('业务数据查询未正确作为独立事项')
    rows.push({ stage: 'R', status: 'validated', output: response.output })
  } catch (error) { rows.push({ stage: 'R', status: 'failed', error: error.code ?? error.message }); process.exitCode = 1 }
} finally {
  db.close()
  await ctx.fiber.dispose()
  await writeFile(outputPath, JSON.stringify({ checkedAt: new Date().toISOString(), provider: config.provider, model: config.model,
    actualProvider: true, tools: [], sourceDatabaseReadOnly: true, externalEffects: 0, rows }, null, 2) + '\n')
}
