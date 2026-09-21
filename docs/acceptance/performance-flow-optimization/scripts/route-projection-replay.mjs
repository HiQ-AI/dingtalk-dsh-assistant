import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { createTopicCoordinator } from '../../../../packages/dingtalk-dsh-assistant/topic-runtime.js'

process.on('uncaughtException', error => {
  const firstLine = String(error.message).split('\n')[0]
  console.error(JSON.stringify({ error: error.name, code: error.code, check: /^[a-z][a-z0-9_:-]+$/u.test(firstLine) ? firstLine : 'input-or-execution-failure' }))
  process.exitCode = 1
})

// 输入均只读；真实存储只加载为内存副本，模型/执行/发送能力均为拒绝执行的fixture。
// 输出仅统计量和哈希，不输出消息、目录标题、业务路径或身份清单。
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(process.argv[index]?.startsWith('--') && process.argv[index + 1], 'argument_pair_required')
  args.set(process.argv[index], process.argv[index + 1])
}
for (const key of ['--audit-metrics', '--state', '--session-root']) assert.ok(args.has(key), `required_argument:${key}`)
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const baselineRef = args.get('--baseline-ref') ?? 'fd8fa1537b42a261965439108baae5700bb4bb78'
assert.match(baselineRef, /^[a-f0-9]{40}$/, 'full_baseline_commit_required')
const output = path.resolve(args.get('--output') ?? path.join(repo, 'docs/acceptance/performance-flow-optimization/round-7/route-projection-summary.json'))
const audit = JSON.parse(await readFile(args.get('--audit-metrics'), 'utf8'))
const raw = await readFile(args.get('--state'), 'utf8'), source = JSON.parse(raw)
const sessionRoot = path.resolve(args.get('--session-root'))
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
const content = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? part.thinking ?? content(part.content)).join('\n') : ''
const distribution = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, sum: sorted.reduce((a, b) => a + b, 0), p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) } }
const baselineSource = execFileSync('git', ['show', `${baselineRef}:packages/dingtalk-dsh-assistant/topic-runtime.js`], { cwd: repo, encoding: 'utf8' })
const newGeneratorPath = path.join(repo, 'packages/dingtalk-dsh-assistant/topic-runtime.js')
const newGeneratorSha256 = hash(await readFile(newGeneratorPath, 'utf8'))
// 使用旧模块真实生成器；只改加载器的相对import地址，依赖仍取同一工作区，避免复制旧算法。
const loadable = baselineSource.replace(/from (['"])([^'"]+)\1/g, (_match, quote, specifier) => {
  const resolved = specifier.startsWith('./') ? pathToFileURL(path.resolve(repo, 'packages/dingtalk-dsh-assistant', specifier)).href : import.meta.resolve(specifier)
  return `from ${quote}${resolved}${quote}`
})
const { createTopicCoordinator: baselineCoordinator } = await import(`data:text/javascript;base64,${Buffer.from(loadable).toString('base64')}`)
const samples = []
for (const session of audit.sessions) {
  const wanted = new Map(session.inputs.filter(input => input.marker === 'GROUP_TOPIC_ROUTE').map(input => [input.line, input]))
  if (!wanted.size) continue
  let line = 0
  const sessionFile = path.resolve(sessionRoot, session.id, 'session.jsonl')
  assert.ok(sessionFile.startsWith(`${sessionRoot}${path.sep}`), 'session_path_outside_root')
  const lines = readline.createInterface({ input: createReadStream(sessionFile), crlfDelay: Infinity })
  for await (const text of lines) {
    line++
    const input = wanted.get(line)
    if (!input) continue
    const event = JSON.parse(text), body = content(event.data.content)
    assert.equal(hash(body), input.fingerprint, 'historical_input_fingerprint_changed')
    const envelopeLine = body.split('\n').find(item => item.startsWith('Topic 请求：'))
    assert.ok(envelopeLine, 'historical_route_envelope_missing')
    const envelope = JSON.parse(envelopeLine.slice('Topic 请求：'.length))
    const ids = envelope.messages.map(message => message.messageId)
    const group = Object.values(source.tables.groups).find(candidate => ids.every(id => candidate.messages.some(message => message.messageId === id)))
    assert.ok(group, 'historical_batch_missing_from_current_store')
    samples.push({ groupId: group.groupId, ids, original: envelope, historicalContentBytes: input.bytes, fingerprint: input.fingerprint, at: input.at })
    wanted.delete(line)
    if (!wanted.size) break
  }
  assert.equal(wanted.size, 0, 'historical_log_missing_requested_lines')
}
samples.sort((a, b) => a.at - b.at)
assert.equal(samples.length, 91, 'fixed_route_sample_count_changed')
const covered = new Set(samples.flatMap(sample => sample.ids))
const todayMessages = Object.values(source.tables.groups).flatMap(group => group.messages).filter(message => {
  const at = typeof message.occurredAt === 'number' ? message.occurredAt : Date.parse(message.occurredAt)
  return at >= audit.start && at <= audit.cutoff
})
assert.equal(todayMessages.length, 81, 'fixed_message_count_changed')
assert.ok(todayMessages.every(message => covered.has(message.messageId)), 'today_message_not_covered')

function memoryFacility(snapshot) {
  return new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'fixed-route-replay' })
}
const businessState = store => ({ tasks: store.listTasks(), groups: store.listGroups().map(({ coordinationRequests, ...group }) => group) })
async function harness(factory) {
  const store = await openResidentStore(memoryFacility(structuredClone(source)))
  const before = hash(businessState(store)), tools = new Map(), sent = [], errors = []
  const forbidden = () => { throw new Error('offline_business_side_effect_forbidden') }
  const agent = { session: { snapshotEvents: () => [] }, steer: message => sent.push(message), whenIdle: () => new Promise(() => {}) }
  const coordinator = factory({ store, getAgent: () => agent, assertSession: () => {}, serializeTasks: operation => operation(), applyAction: forbidden, appendOutbox: forbidden,
    reviewCandidates: () => [], validateReplyReview: forbidden, cancelTask: forbidden, onError: (_group, error) => errors.push(error.message.split(':')[0]), isClosing: () => false })
  for (const group of store.listGroups()) {
    const groupTools = new Map()
    coordinator.register({ tools: { register: tool => groupTools.set(tool.name, tool) } }, group.groupId)
    tools.set(group.groupId, groupTools)
  }
  return { store, sent, async call(groupId, name, input) { return tools.get(groupId).get(name).execute(input, {}) },
    async close() { await coordinator.close(); assert.equal(hash(businessState(store)), before, 'offline_business_state_changed'); assert.deepEqual(errors, [], 'offline_coordinator_errors'); await store.close() } }
}
const oldRun = await harness(baselineCoordinator), newRun = await harness(createTopicCoordinator)
const oldBytes = [], newBytes = [], oldEnvelopeBytes = [], newEnvelopeBytes = [], topicCoverage = [], relatedCoverage = []
let fullTextChecks = 0, quotedBatches = 0, relatedTopicChecks = 0, directoryPages = 0, relatedPages = 0, sourceVersionChanges = 0, missingHistoricalVersions = 0, linkedTaskChecks = 0
const allMessageIds = new Set()
try {
  for (const sample of samples) {
    const request = { messageIds: sample.ids, reason: 'offline-fixed-batch-comparison' }
    const oldEnvelope = await oldRun.call(sample.groupId, 'group_topic_route_review', request)
    const envelope = await newRun.call(sample.groupId, 'group_topic_route_review', request)
    assert.equal(envelope.totalMessages, sample.ids.length)
    assert.deepEqual(oldEnvelope.messages.map(message => message.messageId), envelope.messages.map(message => message.messageId), 'batch_identity_changed')
    oldBytes.push(bytes(oldRun.sent.at(-1).content)); newBytes.push(bytes(newRun.sent.at(-1).content))
    oldEnvelopeBytes.push(bytes(oldEnvelope)); newEnvelopeBytes.push(bytes(envelope))
    const allTopics = newRun.store.listTopics(sample.groupId), directory = [...envelope.topics]
    let offset = envelope.nextTopicOffset
    while (offset < envelope.totalTopics) {
      const page = await newRun.call(sample.groupId, 'group_topic_list', { offset, limit: 100 })
      assert.ok(page.nextOffset > offset, 'directory_pagination_stalled')
      directory.push(...page.topics); offset = page.nextOffset; directoryPages++
    }
    assert.equal(directory.length, allTopics.length, 'directory_count_lost')
    assert.deepEqual(directory.map(topic => topic.topicId), allTopics.map(topic => topic.topicId), 'directory_identity_or_order_lost')
    topicCoverage.push({ firstPage: envelope.topics.length, total: allTopics.length })
    const messages = newRun.store.getGroup(sample.groupId).messages.filter(message => sample.ids.includes(message.messageId))
    const quotedIds = new Set(messages.map(message => message.quotedMessage?.messageId).filter(Boolean))
    if (quotedIds.size) quotedBatches++
    const referencedIds = new Set([...quotedIds, ...messages.map(message => message.messageId)])
    const expectedIds = new Set(allTopics.filter(topic => {
      const effective = new Map()
      for (const entry of topic.entries) effective.set(entry.unitId ?? entry.messageId, entry)
      return [...effective.values()].some(entry => entry.action === 'add' && referencedIds.has(entry.messageId))
    }).map(topic => topic.topicId))
    const linkedTasks = newRun.store.listTasks().filter(task => task.groupId === sample.groupId && task.topicRefs.some(ref => expectedIds.has(ref.topicId)))
    for (const task of linkedTasks) for (const ref of task.topicRefs) expectedIds.add(ref.topicId)
    linkedTaskChecks += linkedTasks.length
    const expectedRelated = allTopics.filter(topic => expectedIds.has(topic.topicId)).map(topic => topic.topicId)
    const related = [...envelope.relatedTopics]
    offset = envelope.nextRelatedTopicOffset
    while (offset < envelope.totalRelatedTopics) {
      const page = await newRun.call(sample.groupId, 'group_topic_list', { requestId: envelope.requestId, offset, limit: 100 })
      assert.ok(page.nextOffset > offset, 'related_pagination_stalled')
      related.push(...page.topics); offset = page.nextOffset; relatedPages++
    }
    assert.deepEqual(related.map(topic => topic.topicId), expectedRelated, 'quoted_topic_relation_lost')
    relatedTopicChecks += expectedRelated.length; relatedCoverage.push(expectedRelated.length)
    for (const message of envelope.messages) {
      const original = messages.find(item => item.messageId === message.messageId)
      let text = message.text, next = text.length
      while (next < original.text.length) {
        const page = await newRun.call(sample.groupId, 'group_topic_route_context_get', { requestId: envelope.requestId, messageId: message.messageId, offset: next })
        assert.ok(page.nextOffset > next, 'message_pagination_stalled')
        text += page.text; next = page.nextOffset
      }
      assert.equal(text, original.text, 'full_message_text_lost')
      assert.equal(message.messageVersion, original.messageVersion, 'message_version_changed')
      const historicalVersion = sample.original.messages.find(item => item.messageId === message.messageId)?.messageVersion
      if (historicalVersion === undefined) missingHistoricalVersions++
      else if (historicalVersion !== original.messageVersion) sourceVersionChanges++
      allMessageIds.add(message.messageId); fullTextChecks++
    }
  }
} finally { await oldRun.close(); await newRun.close() }
const before = distribution(oldBytes), after = distribution(newBytes)
assert.equal(hash(await readFile(newGeneratorPath, 'utf8')), newGeneratorSha256, 'product_source_changed_during_replay')
const result = {
  date: '2026-09-21', cutoff: new Date(audit.cutoff).toISOString(), baselineRef, newGeneratorSha256,
  auditStoreSha256: audit.sourceSha256, comparedStoreSha256: hash(raw), exactHistoricalStoreAvailable: hash(raw) === audit.sourceSha256,
  sampleFingerprint: hash(samples.map(sample => sample.fingerprint)), samples: { historicalRouteEnvelopes: samples.length, todayMessages: todayMessages.length, todayCovered: todayMessages.filter(message => allMessageIds.has(message.messageId)).length, allBatchMessages: allMessageIds.size, sourceVersionChanges, missingHistoricalVersions },
  historicalObservedContentBytes: distribution(samples.map(sample => sample.historicalContentBytes)),
  sameSnapshotGeneratedContentBytes: { before, after, p50Reduction: 1 - after.p50 / before.p50, p95Reduction: 1 - after.p95 / before.p95, totalReduction: 1 - after.sum / before.sum },
  sameSnapshotGeneratedEnvelopeBytes: { before: distribution(oldEnvelopeBytes), after: distribution(newEnvelopeBytes) },
  checks: { businessStateUnchanged: true, fullMessageTextChecks: fullTextChecks, completeDirectoryBatches: topicCoverage.length, directoryFirstPageCount: distribution(topicCoverage.map(item => item.firstPage)), directoryTotalCount: distribution(topicCoverage.map(item => item.total)), directoryPages, quotedBatches, relatedTopicRelationsChecked: relatedTopicChecks, linkedTaskChecks, relatedPages, noRelatedTopicLoss: true },
  limitations: ['The current store differs from the audit snapshot; this is paired projection on one captured current snapshot, not historical state reconstruction.', 'All 81 dated messages are covered by the 91 historical batches; nested quote identities are not additional batch messages. No LLM or external business action is replayed.', 'Directory, related-task/quote relation and full-text checks are deterministic structure checks, not human semantic routing ground truth.', 'The old module is the pinned baseline generator with imports resolved against current dependencies; results quantify this route generator change only.', 'Byte reduction is not token, cache, model-latency or business-response improvement.'],
}
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
