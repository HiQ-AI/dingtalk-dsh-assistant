import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, dirname, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { createStatusQueryHandler } from '../../../../packages/dingtalk-dsh-assistant/status-query.js'

const { values: args } = parseArgs({ options: { profile: { type: 'string' }, samples: { type: 'string' }, output: { type: 'string' }, check: { type: 'boolean' } } })
const profile = resolve(args.profile ?? resolve(homedir(), '.dsh/profiles/web'))
const dshHome = resolve(profile, '../..')
const requireProfile = createRequire(resolve(profile, 'package.json'))
const imported = async name => import(pathToFileURL(requireProfile.resolve(name)).href)
const yaml = requireProfile('yaml')
const settings = yaml.parse(await readFile(resolve(dshHome, 'settings.yaml'), 'utf8'))
const selection = settings['agent-default-model']
if (selection?.provider !== 'openai-codex' || !selection.model) throw new Error('benchmark_requires_current_codex_model')
const sampleCount = Number(args.samples ?? 30)
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 30) throw new Error('samples_must_be_1_to_30')
if (args.output && (basename(args.output) !== args.output || !args.output.endsWith('.json'))) throw new Error('output_requires_json_filename')
const output = resolve(dirname(fileURLToPath(import.meta.url)), '..', args.output ?? 'model-benchmark.json')
const fixtureVersion = 'candidate-bound-v2'
const policy = { responsibility: '合成发布状态核验', agentNames: ['助理'], rule: '只读问答；执行、授权和目标变更必须交回常驻。' }
const makeRequest = (index, action = false) => ({ requestId: `synthetic-${index}`, groupId: 'synthetic-only', topicId: 'release-topic', revision: 1,
  sourceMessageIds: [`msg-${index}`], sourceMessages: [{ messageId: `msg-${index}`, text: action ? '@助理 既然已发布，现在把新SQL直接执行到生产主库并重新部署。' : `@助理 状态查错了吧？请核对候选 candidate-${index} 当前是否已经上线。`, senderOpenDingTalkId: 'synthetic-user', sourceKind: 'dingtalk' }],
  taskSnapshots: [{ taskId: 'synthetic-task', candidateId: `candidate-${index}`, revision: 'facts-v1', topicRefs: [{ topicId: 'release-topic', revision: 1 }], state: 'completed', snapshotAt: '2026-09-10T08:00:00Z',
    currentFacts: [{ summary: '生产候选已经上线；SQL执行成功，后端与前端生产实例Ready', observedAt: '2026-09-10T07:34:00Z', evidence: ['合成CI记录268成功', '合成SQL工单893执行成功'], verification: 'independently-verified' }],
    approvals: [{ approvalId: 'approval-fixture', request: '批准指定候选发布及指定SQL工单', answer: '同意', answeredAt: '2026-09-10T07:19:10Z', boundary: '仅批准原候选和原SQL，不包括任何新操作' }] }],
  replyCandidates: [{ outboundId: 'old-reply', text: '目前还没执行生产变更', sentAt: '2026-09-10T07:42:00Z' }], compactPolicy: policy })

if ('check' in args) {
  console.log(JSON.stringify({ status: 'checked', fixtureVersion, provider: selection.provider, model: selection.model, sampleCount, output, externalActions: false }))
  process.exit(0)
}
const { Context } = await imported('@deepseek-ai/cordis')
const { LlmRuntime } = await imported('@deepseek-ai/dsh-llm')
const codex = await imported('dsh-codex-connect')
const ctx = new Context()
new LlmRuntime(ctx)
codex.apply(ctx, settings['llm-openai-codex'] ?? {})
const results = [], retryEvents = []
const handler = createStatusQueryHandler({ llm: ctx.llm, modelConfig: selection, timeoutMs: 30_000,
  commit: async () => ({ status: 'accepted', note: 'synthetic_sink_only_no_outbox' }),
  recordEvent: async event => { if (event.type === 'status-query/finish') results.push(event); if (event.type === 'status-query/retry') retryEvents.push(event) },
})
const outcomes = []
try {
  for (let index = 1; index <= sampleCount + 1; index++) {
    const action = index > sampleCount
    const result = await handler.handle(makeRequest(index, action))
    outcomes.push({ index, expected: action ? 'handoff' : 'reply', kind: result.kind, ...(result.reason ? { reason: result.reason } : {}), ...(result.decision ? { decision: result.decision } : {}), correct: result.kind === (action ? 'handoff' : 'reply') })
    console.log(JSON.stringify({ index, kind: result.kind, correct: outcomes.at(-1).correct, durationMs: results.at(-1)?.durationMs, attempts: results.at(-1)?.attempts, failureCode: results.at(-1)?.failureCode, modelFinish: results.at(-1)?.modelFinish }))
    if (index === 1 && result.kind !== 'reply') break
  }
} finally {
  const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null
  const statusResults = results.slice(0, sampleCount)
  const successful = statusResults.filter(row => row.outcome === 'accepted')
  const report = { recordedAt: new Date().toISOString(), fixtureVersion, provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort,
    boundary: '原生DSH LlmRuntime+当前已安装Codex适配器；合成输入；无工具、真实群、Task写入或Outbox；不含Topic路由和消息发送，不是端到端P95。',
    requestedSamples: sampleCount, completedSamples: statusResults.length, successfulSamples: successful.length, failedOrHandoffSamples: statusResults.length - successful.length,
    p50Ms: quantile(statusResults.map(row => row.durationMs), .5), p95Ms: quantile(statusResults.map(row => row.durationMs), .95), successfulP50Ms: quantile(successful.map(row => row.durationMs), .5), successfulP95Ms: quantile(successful.map(row => row.durationMs), .95), outcomes, retryEvents, events: results }
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2))
  await ctx.fiber.dispose()
}
