import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, glob } from 'node:fs/promises'
import { resolve, join, relative, basename, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { nativeTaskHost } from '../../../../test/fixtures/task-session-native-host.js'
import { createIndependentCoordinationPlanner } from '../../../../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'
import { localSlot } from '../../../../packages/dingtalk-dsh-assistant/coordination-time.js'
import { inspectSession } from '../../../../packages/dingtalk-dsh-assistant/session-persistence.js'
import { compareProposal } from '../../../../scripts/coordination-language-replay.mjs'

// 运行生产独立规划器与真实时间插件；上下文为合成材料，提交仅捕获，不接任务库或发送器。
const [output, connectPath, model, reasoningEffort, proxyUrl, ...selectedIds] = process.argv.slice(2)
assert.ok(output && connectPath && model && reasoningEffort && proxyUrl,
  'usage: node evaluate-model.mjs <new-output-directory> <connect-entry> <model> <reasoning-effort> <proxy-url> [case-id ...]')
const root = resolve(output)
await mkdir(root, { recursive: false })
const fixturesPath = new URL('../fixtures/model-cases.json', import.meta.url)
const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'))
assert.ok(selectedIds.every(id => fixtures.cases.some(sample => sample.id === id)), 'unknown case')
const cases = selectedIds.length ? fixtures.cases.filter(sample => selectedIds.includes(sample.id)) : fixtures.cases
const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE)))
const timeModulePath = profile.resolve('@deepseek-ai/dsh-time-context')
const digests = Object.fromEntries(await Promise.all([
  ['planner', new URL('../../../../packages/dingtalk-dsh-assistant/independent-coordination-planner.js', import.meta.url)],
  ['fixtures', fixturesPath], ['evaluator', new URL(import.meta.url)], ['timeContext', timeModulePath],
].map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])))
const h = await nativeTaskHost(root, () => [], { resident: true })
const permitted = new Set(['coordination_context_get', 'coordination_submit'])
h.ctx.on('tools/pre-execute', async (exec, next) => permitted.has(exec.name)
  ? next() : { kind: 'deny', reason: 'isolated_reminder_evaluation_no_business_tools' })
const results = []
let activePlanner
const missingPolicy = 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.'

function contextFor(sample, number, args, reads) {
  const now = new Date().toISOString(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const source = { messageId: `message-${number}`, messageVersion: 1, sourceRefs: [{ quote: sample.message }],
    occurredAt: sample.occurredAt, actorId: 'actor-001', unitId: `unit-${number}`, unitRevision: 1,
    unitText: sample.message, original: sample.message, sourceOffset: 0, nextSourceOffset: null, truncated: false }
  const prior = sample.prior
  const priorSource = prior && { unitText: prior.message, messageId: 'message-000', unitId: 'unit-000', unitRevision: 1,
    actorId: 'actor-001', occurredAt: prior.occurredAt, sourceRefs: [{ quote: prior.message }],
    sourceOffset: 0, nextSourceOffset: null, truncated: false }
  const schedule = prior?.at ? [{ id: 'schedule-001', coordinationId: 'arrangement-001', revision: 1,
    state: 'active', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: prior.at }, nextDueAt: prior.at,
    action: { kind: 'message-reminder', text: '提醒你查看云端专家的开发进度。' }, target: { conversationId: 'group-001', recipientIds: ['actor-001'] } }] : []
  for (const id of args.coordinationIds ?? []) assert.equal(id, 'arrangement-001', 'fixture arrangement must exist')
  for (const id of args.taskIds ?? []) assert.equal(id, sample.task?.taskId, 'fixture task must exist')
  if (reads) reads.push(structuredClone(args))
  const task = sample.task
  // 与生产context的clone一致，省略不存在的可选字段，满足原生工具无损JSON契约。
  return JSON.parse(JSON.stringify({ reservationId: `reservation-${number}`, generation: 1, groupId: 'group-001', currentTime: now,
    timeContext: { timeZone, source: 'host-working-timezone', currentLocal: localSlot(now, timeZone), sourceLocal: localSlot(sample.occurredAt, timeZone) },
    source, tasks: task ? [{ taskId: task.taskId, title: task.title, objectivePreview: task.objective,
      status: task.status, control: task.control, inputVersion: task.requirementRevision, runSequence: task.runSequence }] : [],
    total: task ? 1 : 0, offset: 0, nextOffset: null, hasMore: false,
    taskContexts: args.taskIds?.length ? [task] : [],
    recipients: [{ recipientId: 'actor-001', name: '测试用户', evidenceRef: source.messageId, observedAt: sample.occurredAt }], recipientsTruncated: false,
    arrangements: prior ? [{ id: 'arrangement-001', revision: 1, lifecycleState: prior.state, state: prior.state,
      memberCount: 0, sourceId: 'source-000', question: prior.question, createdAt: prior.occurredAt,
      sourcePreview: prior.message, actorId: 'actor-001' }] : [],
    arrangementContexts: args.coordinationIds?.length && prior ? [{
      coordination: { id: 'arrangement-001', revision: 1, state: prior.state, memberIds: [], question: prior.question,
        pendingClarifications: [], ordinalSelectionRequiresClarification: false, sourceOrderTotal: 0,
        ordinalAppendRequiresClarification: false, sourceOrderTruncated: false, nextSourceOrderOffset: null, history: [], historyTruncated: false },
      source: priorSource, members: [], memberOffset: 0, membersTotal: 0, nextMemberOffset: null, membersTruncated: false,
      schedules: schedule, schedulesTruncated: false, occurrences: [], occurrencesTruncated: false,
    }] : [],
    arrangementOffset: 0, arrangementsTotal: prior ? 1 : 0, arrangementsHasMore: false, nextArrangementOffset: null,
    unresolved: prior?.state === 'needs_clarification' ? [{ reservationId: 'reservation-000', unitId: 'unit-000', unitRevision: 1,
      coordinationId: 'arrangement-001', question: prior.question, sourcePreview: prior.message }] : [],
    unresolvedTruncated: false,
    allowedActions: ['arrangement', 'schedule', 'clarify', 'reject', 'change', 'resolve', 'query', 'schedule-change', 'occurrence-control'],
    limitations: ['同群；收件人目录仅含有来源证据的已观察成员，缺失或重名必须澄清。'] }))
}

try {
  const connect = await import(pathToFileURL(resolve(connectPath)).href)
  await connect.apply(h.ctx, { enableProxy: true, proxyUrl, enableSearch: false, enableReserveFallback: false,
    enableNativeCompaction: false, enableImageTool: false, enableImageGeneration: false, enableAutoReview: false })
  // 使用真实模块自然产生非浏览器缺失提示；不伪造user/rpcId、不覆盖Date或抹掉上游政策。
  await h.ctx.plugin(await import(pathToFileURL(timeModulePath).href), { refreshIntervalMs: 0 })
  for (const [index, sample] of cases.entries()) {
    const number = String(index + 1).padStart(3, '0'), reads = [], proposals = [], inputs = []
    const caseDir = join(root, `case-${number}`)
    await mkdir(caseDir)
    const request = { reservationId: `reservation-${number}`, generation: 1, groupId: 'group-001' }
    activePlanner = createIndependentCoordinationPlanner({ ctx: h.ctx, root, agentPreset: 'native-test',
      getModelSelection: () => ({ provider: 'openai-codex', model, reasoningEffort }),
      context: async (_request, args = {}) => { const input = contextFor(sample, number, args, inputs.length ? reads : null); inputs.push(input); return input },
      submit: async (_request, proposal) => { proposals.push(proposal); return { captured: true, proposal } },
    })
    const startedAt = Date.now(), timer = setTimeout(() => { void activePlanner.close() }, 120000)
    let error, native
    try { await activePlanner.plan(request) } catch (caught) { error = caught.message }
    finally { clearTimeout(timer); await activePlanner.close() }
    // 从隔离目录查找并独立打开持久会话；模型没有这些路径和预期断言。
    const matches = []
    for await (const path of glob('**/session.v4.jsonl', { cwd: join(root, 'legacy-sessions') })) {
      if (basename(dirname(path)).startsWith(`independent-reservation-${number}-`)) matches.push(path)
    }
    if (matches.length === 1) native = await inspectSession(h.ctx.sessionPersistence, basename(dirname(matches[0])))
    const events = native?.events ?? [], trace = events.filter(event => event.type === 'tool/call').map(event => ({
      sequence: event.seq, tool: event.data.name, args: typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments }))
    const timeMessages = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'time-context')
      .flatMap(event => event.data.content ?? []).filter(part => part.type === 'text').map(part => part.text)
    const headers = events.filter(event => event.type === 'request/header').map(event => ({ sequence: event.seq, time: event.time, data: event.data }))
    const usages = events.filter(event => event.type === 'assistant/message' && event.data.usage)
      .map(event => ({ sequence: event.seq, provider: event.data.message?.source?.provider,
        model: event.data.message?.source?.model, usage: event.data.usage }))
    const proposal = proposals[0], failures = proposal ? compareProposal(proposal, sample.expect) : [{ reason: 'no captured proposal' }]
    if (error) failures.push({ reason: error })
    if (matches.length !== 1) failures.push({ reason: 'native session count', count: matches.length })
    if (proposals.length !== 1) failures.push({ reason: 'proposal count', count: proposals.length })
    if (!timeMessages.some(text => text.includes(missingPolicy))) failures.push({ reason: 'real missing-browser-timezone policy absent' })
    if (trace.some(call => !permitted.has(call.tool))) failures.push({ reason: 'unexpected tool' })
    if (events.some(event => event.type === 'tool/result' && event.data.message?.isError)) failures.push({ reason: 'tool error cannot be erased by later retry' })
    if (sample.noTaskReads && reads.some(args => args.taskIds?.length)) failures.push({ reason: 'unnecessary task detail read' })
    if (sample.readPrior && !reads.some(args => args.coordinationIds?.includes('arrangement-001'))) failures.push({ reason: 'original arrangement not read' })
    if (sample.reminderContains && !(proposal?.resolution ?? proposal)?.reminderText?.includes(sample.reminderContains)) failures.push({ reason: 'reminder subject lost' })
    await writeFile(join(caseDir, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n')
    if (native) await writeFile(join(caseDir, 'native-session.json'), JSON.stringify(native, null, 2) + '\n')
    const result = { id: sample.id, artifactDirectory: relative(root, caseDir), passed: !failures.length,
      elapsedMs: Date.now() - startedAt, error, failures, proposals, reads, trace, timeMessages, headers, usages, semanticReview: sample.review }
    results.push(result)
    await writeFile(join(root, 'results.json'), JSON.stringify({ model, reasoningEffort, provider: 'openai-codex', digests,
      runtime: 'isolated native-test preset plus the actual installed time-context plugin; production planner and two real tool schemas',
      limitation: 'Proposal semantics only; no real scheduling, message delivery or production latency measurement.',
      passed: results.filter(item => item.passed).length, executed: results.length, cases: results }, null, 2) + '\n')
    console.log(JSON.stringify({ case: sample.id, passed: result.passed, elapsedMs: result.elapsedMs, error, failures }))
  }
} finally { await activePlanner?.close(); await h.close() }
assert.ok(results.length === cases.length && results.every(result => result.passed), 'native reminder model validation failed; inspect results.json')
