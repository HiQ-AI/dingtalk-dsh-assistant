import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolveTopicMessages, topicSourceEntries, topicDecisionCoversEntry } from '../../../../packages/dingtalk-dsh-assistant/topic-model.js'
import { activeFixedUnits } from '../../../../packages/dingtalk-dsh-assistant/fixed-topics.js'

// 隔离执行真实 projectSource 函数；只替换账本写入及持久化介质，不启动业务或调用模型。
const file = 'packages/dingtalk-dsh-assistant/task-session-service.js'
const current = await readFile(file, 'utf8')
const baseRef = process.argv[2] ?? 'd07056a670801b1700d8729e992e7ffd4b3d914b'
const baseline = execFileSync('git', ['show', `${baseRef}:${file}`], { encoding: 'utf8' })
const extract = text => text.slice(text.indexOf('  const sameProcessingRefs ='), text.indexOf('  async function applyTopicAction('))
function fixture() {
  const messages = Array.from({ length: 250 }, (_, i) => ({ messageId: `m${i}`, messageVersion: 1, sequence: i,
    routingStatus: 'routed', text: 'synthetic source '.repeat(80) }))
  const topics = Array.from({ length: 20 }, (_, i) => ({ topicId: `t${i}`, revision: 1, processedRevision: 1,
    entries: messages.map(m => ({ revision: 1, action: 'add', messageId: m.messageId, messageVersion: 1 })),
    decisions: [{ revision: 1, status: 'completed', decision: { actions: [] } }] }))
  return { messages, topics, ownership: messages.map(m => ({ unitId: `u${m.messageId}`, unitRevision: 1,
    dispatchOwner: 'legacy-topic', sourceSnapshot: { ...m } })) }
}
async function run(text, group) {
  let expanded = 0, cloned = 0
  const clone = rows => { cloned += rows.length; return structuredClone(rows) }
  const store = { getGroup: () => group, listTopics: () => group.topics,
    listSourceDispatchOwnership: (_, source) => clone(group.ownership.filter(owner => !source ||
      owner.sourceSnapshot.messageId === source.messageId && owner.sourceSnapshot.messageVersion === source.messageVersion)),
    getSourceDispatchOwnership: (_, id, rev) => clone(group.ownership.filter(o => o.unitId === id && o.unitRevision === rev))[0] }
  const writes = []
  const command = async (kind, payload) => { writes.push({ kind, payload }); return { result: { source: { ...payload, processingPending: true } } } }
  const project = new Function('residentStore', 'command', 'hash', 'activeFixedUnits', 'resolveTopicMessages', 'topicSourceEntries', 'topicDecisionCoversEntry',
    `${extract(text)}; return projectSource`)(store, command, JSON.stringify, activeFixedUnits,
    (...args) => { const rows = resolveTopicMessages(...args); expanded += rows.length; return rows }, topicSourceEntries, topicDecisionCoversEntry)
  const start = performance.now()
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0))
  for (const m of group.messages) await project({ sourceId: m.messageId, groupId: 'g', messageId: m.messageId, version: m.sourceVersion ?? m.messageVersion })
  return { writes, elapsedMs: +(performance.now() - start).toFixed(2), timerDelayMs: +(await timer).toFixed(2), expanded, cloned }
}
const before = await run(baseline, fixture()), after = await run(current, fixture())
assert.deepEqual(after.writes, before.writes)
assert.equal(after.expanded, 0)
assert.equal(after.cloned, 250)
assert.equal(before.expanded, 1250000)
const summarize = ({ writes, ...metrics }) => ({ ...metrics, commands: writes.length })
console.log(JSON.stringify({ baseRef, sources: 250, topics: 20, equalCommands: true, before: summarize(before), after: summarize(after) }, null, 2))

for (const scenario of ['pending', 'removed', 'multiple-units', 'superseded']) {
  const group = fixture()
  group.messages = group.messages.slice(0, 3)
  group.ownership = group.ownership.slice(0, 3)
  group.topics = group.topics.slice(0, 2).map(topic => ({ ...topic, entries: topic.entries.slice(0, 3) }))
  if (scenario === 'pending') group.topics[0].decisions = []
  if (scenario === 'removed') for (const topic of group.topics) {
    topic.revision = 2
    topic.entries.push({ ...topic.entries[0], revision: 2, action: 'remove' })
  }
  if (scenario === 'multiple-units') for (const topic of group.topics) {
    topic.entries = topic.entries.flatMap(entry => ['a', 'b'].map(id => ({ ...entry, unitId: `${entry.messageId}-${id}`, unitRevision: 1 })))
    for (const message of group.messages) {
      message.activeUnitRefs = ['a', 'b'].map(id => ({ unitId: `${message.messageId}-${id}`, unitRevision: 1 }))
      message.units = message.activeUnitRefs.map(ref => ({ ...ref, dispatchOwner: 'legacy-topic', sourceRanges: [{ start: 0, end: message.text.length, quote: message.text }], contextRanges: [], sourceAttachments: [] }))
    }
  }
  if (scenario === 'superseded') for (const message of group.messages) message.sourceVersion = 0
  const oldResult = await run(baseline, structuredClone(group)), newResult = await run(current, structuredClone(group))
  assert.deepEqual(newResult.writes, oldResult.writes, scenario)
  console.log(JSON.stringify({ scenario, equalCommands: true, commands: newResult.writes.length }))
}
