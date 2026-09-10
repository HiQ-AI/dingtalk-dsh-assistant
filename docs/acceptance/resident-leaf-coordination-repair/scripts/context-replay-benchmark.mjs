import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { createTopicCoordinator } from '../../../../packages/dingtalk-dsh-assistant/topic-runtime.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const baselineRevision = 'b7d0ea1'
const baselinePath = new URL(`./.baseline-topic-runtime-${process.pid}.mjs`, import.meta.url)
// 基线协调器来自真实 Git 对象；共享当前 Store/test substrate，使本轮只比较协调读取协议。
const original = execFileSync('git', ['show', `${baselineRevision}:packages/dingtalk-dsh-assistant/topic-runtime.js`], { cwd: root, encoding: 'utf8' })
const baseline = original.replace(/from '(\.\/[^']+)'/g, (_match, target) => `from '${pathToFileURL(resolve(root, 'packages/dingtalk-dsh-assistant', target)).href}'`)
await writeFile(baselinePath, baseline)
const records = []
function remember(session, name, output) {
  const id = `call-${session.snapshotEvents().length}`
  session.append('assistant/message', { turn: 1, step: 1, message: { id: `a-${id}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id, name, arguments: '{}' }] } }, { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: { id: `r-${id}`, role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: JSON.stringify(output) }] }] } }, { surfaceOp: 'append' })
}
async function run(factory, label, round) {
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { open: async () => ({ loadAll: async () => structuredClone(snapshot), close: async () => {}, putRecord: async (table, key, value) => { (snapshot.tables[table] ??= {})[key] = structuredClone(value) }, deleteRecord: async (table, key) => { delete snapshot.tables[table][key] } }) } }) } } }, { backend: 'replay-benchmark' })
  const store = await openResidentStore(facility), session = Session.create(`benchmark-${label}-${round}`), tools = new Map(), sent = []
  const agent = { session, steer(message) { sent.push(message.content[0].text); session.append('user/message', message, { surfaceOp: 'append' }) }, whenIdle: () => new Promise(() => {}) }
  const coordinator = factory({ store, getAgent: () => agent, assertSession() {}, serializeTasks: fn => fn(), applyAction() {}, appendOutbox: row => store.appendOutbox(row), reviewCandidates: () => [], validateReplyReview: x => x, cancelTask() {}, onError: error => { throw error }, isClosing: () => false })
  coordinator.register({ tools: { register(tool) { tools.set(tool.name, tool) } } }, 'g')
  const counters = { label, round, reviews: 5, flowCalls: 0, pageCalls: 0, flowChars: 0, pageChars: 0 }
  const call = async (name, args) => {
    const result = await tools.get(name).execute(args, {})
    remember(session, name, result)
    if (name === 'group_task_prompt_get') { counters.flowCalls++; counters.flowChars += result.prompts.reduce((total, item) => total + (item.prompt?.length ?? 0), 0) }
    if (name === 'group_task_review_context_get') { counters.pageCalls++; counters.pageChars += result.text?.length ?? 0 }
    return result
  }
  const envelope = (prefix, label = 'Topic 请求') => JSON.parse(sent.findLast(text => text.startsWith(prefix)).split('\n').find(line => line.startsWith(`${label}：`)).slice(label.length + 1))
  try {
    await store.subscribe({ groupId: 'g', responsibility: '合成核验' }); await store.setAgentNames(['助理'])
    await store.ingest({ groupId: 'g', messageId: 'm', text: '@助理 核验状态', senderOpenDingTalkId: 'synthetic', occurredAt: '2026-09-10T00:00:00Z' })
    await coordinator.schedule('g')
    const route = envelope('[GROUP_TOPIC_ROUTE]')
    const routed = await call('group_topic_route_submit', { requestId: route.requestId, routes: [{ messageId: 'm', messageVersion: 1, topics: [{ newTopicKey: 'topic', title: '合成任务' }] }] })
    const decision = routed.pendingDecisions[0]
    await call('group_decision_submit', { requestId: decision.requestId, topicId: decision.topicId, revision: decision.revision, decision: { basisMessageIds: ['m'], actions: [], reason: '合成测试无需对外回复' } })
    await coordinator.drain('g')
    await store.setTaskPrompts([{ id: 'flow', name: '合成流程', description: '流程核验', enabled: true, prompt: '固定流程正文。'.repeat(1200) }], 0)
    const created = await store.createTask({ groupId: 'g', topicRefs: [{ topicId: decision.topicId, revision: 1 }], title: '合成', objective: '相同证据原文。'.repeat(1500), acceptanceCriteria: ['保留证据'] })
    const task = await store.updateTask(created.task.taskId, current => ({ ...current, taskPromptRefs: [{ id: 'flow', revision: 1 }] }))
    const started = performance.now()
    for (let review = 1; review <= 5; review++) {
      const pending = coordinator.requestReview('checkpoint', task, { kind: 'plan-confirmed', summary: `审阅${review}` })
      const request = envelope('[TASK_CHECKPOINT_REVIEW]', '审阅请求')
      if (!request.visiblePromptRefs?.some(ref => ref.id === 'flow')) await call('group_task_prompt_get', { requestId: request.requestId, ids: ['flow'] })
      const objective = envelope('[TASK_CHECKPOINT_REVIEW]', '当前有效目标')
      if (!objective.reused) {
        let offset = 0
        while (true) { const page = await call('group_task_review_context_get', { requestId: request.requestId, section: 'objective', offset }); if (!page.hasMore) break; offset = page.nextOffset }
      }
      const result = await call('group_task_review_submit', { requestId: request.requestId, review: { decision: 'acknowledge', reason: '合成证据已核对' } })
      assert.equal(result.status, 'accepted'); await pending
    }
    counters.hostReplayMs = Math.round((performance.now() - started) * 100) / 100
    records.push(counters)
  } finally { await coordinator.close(); await store.close() }
}
try {
  const old = (await import(baselinePath.href)).createTopicCoordinator
  for (let round = 1; round <= 10; round++) { await run(old, 'baseline', round); await run(createTopicCoordinator, 'current', round) }
  const sourceHash = source => createHash('sha256').update(source).digest('hex')
  const report = { baselineRevision, baselineSourceHash: sourceHash(original), currentSourceHash: sourceHash(await readFile(resolve(root, 'packages/dingtalk-dsh-assistant/topic-runtime.js'))), rounds: 10, boundary: '真实基线协调器与当前协调器运行同一合成Store和原生Session；每轮五次审阅，不调用模型。测Host重放和实际工具正文字符，不是模型墙钟改进。', records }
  await writeFile(new URL('../context-replay-benchmark.json', import.meta.url), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await unlink(baselinePath) }
