import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, stat, rm, mkdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const evidence = join(repository, 'docs/acceptance/topic-driven-processing/round-1')
await mkdir(evidence, { recursive: true })
const scratch = await mkdtemp(join(evidence, 'store-performance-'))
const backends = []
const groups = 'synthetic-group'
const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]
const distribution = (values) => ({ samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) })
const input = (index) => ({ groupId: groups, messageId: `synthetic-${index}`, text: `合成事项 ${index}：${'这是一段无个人信息的固定测试内容。'.repeat(12)}`, occurredAt: new Date(1_780_000_000_000 + index * 1000).toISOString(), senderName: '合成测试者', senderOpenDingTalkId: 'synthetic-id' })
async function storeAt(root, opener) {
  const backend = new JsonStorageBackend(root); backends.push(backend)
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => backend } } }, { backend: 'json' })
  return opener(facility)
}
async function measure(operation) { const start = performance.now(); await operation(); return performance.now() - start }
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value))

try {
  // 固定实施前基线，避免本分支提交后把新版误当作v6。
  const baseCommit = '0925f0d4ed4f49072454f563477f433b10ebb61d'
  const baseRoot = join(scratch, 'base-source'); await mkdir(baseRoot)
  for (const file of ['store.js', 'task-result.js']) {
    const source = execFileSync('git', ['show', `${baseCommit}:packages/dingtalk-dsh-assistant/${file}`], { cwd: repository, encoding: 'utf8', windowsHide: true })
    await writeFile(join(baseRoot, file), source)
  }
  const baseModule = await import(pathToFileURL(join(baseRoot, 'store.js')).href)
  const base = await storeAt(join(scratch, 'v6'), baseModule.openResidentStore), current = await storeAt(join(scratch, 'v7'), openResidentStore)
  await base.subscribe({ groupId: groups }); await current.subscribe({ groupId: groups })
  for (let index = 0; index < 120; index++) {
    await base.ingest(input(index)); await current.ingest(input(index))
  }
  await current.routeMessages({ groupId: groups, routeId: 'history-routing', routingRevision: 0, routes: current.getGroup(groups).messages.map((message) => ({ messageId: message.messageId, messageVersion: 1, topics: [{ newTopicKey: message.messageId, title: message.messageId }] })) })
  const before = { v6: byteLength(base.getGroup(groups)), v7: byteLength(current.getGroup(groups)) }
  const baselineTimes = [], currentTimes = [], routeTimes = [], decisionTimes = []
  for (let index = 120; index < 160; index++) {
    const message = input(index)
    // 两版交替使用相同输入，分别量化ingest；归类/接受单独计时，不混入基线。
    baselineTimes.push(await measure(() => base.ingest(message)))
    currentTimes.push(await measure(() => current.ingest(message)))
    let routed
    routeTimes.push(await measure(async () => { routed = await current.routeMessages({ groupId: groups, routeId: `route-${index}`, routingRevision: current.getGroup(groups).routingRevision, routes: [{ messageId: message.messageId, messageVersion: 1, topics: [{ newTopicKey: 'item', title: message.messageId }] }] }) }))
    const topicId = routed.topicIdsByKey.item
    decisionTimes.push(await measure(async () => { const result = await current.acceptTopicDecision({ groupId: groups, topicId, revision: 1, decisionId: `decision-${index}`, decision: { actions: [], reason: '合成记录仅验证存储' } }); assert.equal(result.status, 'accepted') }))
    await current.completeTopicDecision({ groupId: groups, topicId, decisionId: `decision-${index}` })
  }
  const initialTopic = current.listTopics(groups)[0]
  // 额外将40条合成消息关联到一个历史Topic，验证固定版本和正文分页，仍保留其他归属。
  const originalMessages = current.getGroup(groups).messages.slice(120)
  await current.routeMessages({ groupId: groups, routeId: 'pagination', routingRevision: current.getGroup(groups).routingRevision, routes: originalMessages.map((message) => ({ messageId: message.messageId, messageVersion: 1, topics: [{ topicId: initialTopic.topicId }, { topicId: current.listTopics(groups).find((topic) => topic.title === message.messageId).topicId }] })) })
  const complete = current.getTopicContext({ groupId: groups, topicId: initialTopic.topicId, revision: 41, offset: 0, limit: 100 })
  const page = current.getTopicContext({ groupId: groups, topicId: initialTopic.topicId, revision: 41, offset: 0, limit: 10 })
  const fixed = current.getTopicContext({ groupId: groups, topicId: initialTopic.topicId, revision: 1, offset: 0, limit: 10 })
  assert.equal(current.listTopics(groups).length, 160)
  assert.equal(complete.total, 41); assert.equal(page.messages.length, 10); assert.equal(fixed.messages.length, 1)
  const indexProjection = current.listTopics(groups).map(({ topicId, title, revision, processedRevision, status, summary }) => ({ topicId, title, revision, processedRevision, status, summary: summary.slice(0, 240) }))
  const after = { v6: byteLength(base.getGroup(groups)), v7: byteLength(current.getGroup(groups)) }
  await base.close(); await current.close()
  const report = { measuredAt: new Date().toISOString(), baseCommit, backend: '@deepseek-ai/dsh-storage-json@0.1.1-rc.2', synthetic: true,
    input: { historyMessages: 120, samples: 40, totalMessages: 160, topics: 160 },
    ingest: { v6: distribution(baselineTimes), v7: distribution(currentTimes) }, route: distribution(routeTimes), acceptDecision: distribution(decisionTimes),
    groupBytes: { before, after, growth: { v6: after.v6 - before.v6, v7: after.v7 - before.v7 } },
    mediumBytes: { v6: (await stat(join(scratch, 'v6/dingtalk_dsh_assistant.json'))).size, v7: (await stat(join(scratch, 'v7/dingtalk_dsh_assistant.json'))).size },
    query: { topicIndexAllBytes: byteLength(indexProjection), topicIndexPage50Bytes: byteLength(indexProjection.slice(0, 50)), fullContextBytes: byteLength(complete), page10ContextBytes: byteLength(page), fixedRevision1ContextBytes: byteLength(fixed), fullMessages: complete.total, pageMessages: page.messages.length, fixedRevisionMessages: fixed.messages.length },
    limitations: ['单机顺序合成存储基准，不代表真实模型或网络延迟', '两版只对比相同ingest操作；v7另外保存Topic与决策，大小和写放大有额外成本', '没有已批准的性能SLO，报告实测分位数但不宣称性能验收通过', 'SDK JSON每次重写整个domain文件；当前样本不证明无限历史规模'] }
  const reportPath = join(evidence, 'store-performance.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await Promise.all(backends.map((backend) => backend.close()))
  const inside = relative(evidence, scratch)
  if (inside.startsWith('..') || resolve(evidence, inside) !== scratch) throw new Error('performance_cleanup_outside_workspace')
  await rm(scratch, { recursive: true, force: true })
}
