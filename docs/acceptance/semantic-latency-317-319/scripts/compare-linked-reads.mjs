import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { taskIndexPage } from '../../../../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'
import { createTopicCoordinator as current } from '../../../../packages/dingtalk-dsh-assistant/topic-runtime.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const baseline = '122c1ce66a89a7b9d52f714aeceed5b3245080f0'
const temporary = join(root, 'packages/dingtalk-dsh-assistant', `.semantic-latency-${process.pid}.js`)
const source = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root,
  'show', `${baseline}:packages/dingtalk-dsh-assistant/topic-runtime.js`])
await writeFile(temporary, source, { flag: 'wx' })
try {
  const { createTopicCoordinator: before } = await import(pathToFileURL(temporary))
  const results = []
  for (const [label, create] of [['PR272-before-linked-context', before], ['with-linked-context', current]]) {
    const data = { tables: {}, global: null }
    const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
      loadAll: async () => structuredClone(data), close: async () => {},
      async putRecord(table, key, value) { (data.tables[table] ??= {})[key] = structuredClone(value) },
      async deleteRecord(table, key) { delete data.tables[table][key] },
    } } } }) } } }, { backend: 'synthetic-latency' })
    const store = await openResidentStore(facility)
    await store.subscribe({ groupId: 'fixture', responsibility: '仅合成取证' })
    for (const id of ['other', '317', '318', '319']) await store.ingest({ groupId: 'fixture', messageId: id,
      text: `合成来源${id}`, occurredAt: '2026-10-27T05:17:12Z' })
    const routed = await store.routeMessages({ groupId: 'fixture', routeId: 'fixture-route', routingRevision: 0,
      routes: ['other', '317', '318', '319'].map(messageId => ({ messageId, messageVersion: 1,
        topics: [{ newTopicKey: messageId === 'other' ? 'other' : 'target', title: messageId === 'other' ? '其他事项' : '待核验事项' }] })) })
    const refs = key => [{ topicId: routed.topicIdsByKey[key], revision: store.getTopic('fixture', routed.topicIdsByKey[key]).revision }]
    for (let index = 0; index < 27; index++) {
      const target = index === 26
      await store.createTask({ groupId: 'fixture', title: target ? '目标任务' : `目录任务${index}`,
        objective: (target ? '必须完整核验目标' : '其他任务目标').repeat(900), acceptanceCriteria: ['完整目标及版本一致'], topicRefs: refs(target ? 'target' : 'other') })
    }
    const messages = []
    const agent = { steer(message) { messages.push(message.content[0].text) }, whenIdle: () => new Promise(() => {}) }
    const coordinator = create({ store, getAgent: () => agent, assertSession() {}, serializeTasks: fn => fn(),
      applyAction() { throw new Error('No effects allowed') }, appendOutbox() { throw new Error('No sends allowed') },
      reviewCandidates: () => [], validateReplyReview: value => value, cancelTask() {}, onError(_group, error) { throw error }, isClosing: () => false })
    try {
      await coordinator.schedule('fixture')
      const input = messages.filter(text => text.startsWith('[GROUP_TOPIC_DECISION]')).map(text => {
        const line = text.split('\n').find(value => value.startsWith('Topic '))
        return JSON.parse(line.slice(line.indexOf('{')))
      }).find(value => value.topicId === routed.topicIdsByKey.target)
      assert.ok(input)
      let target, catalogueReads = 0, contextReads = 0
      if (input.linkedTasks?.reads.length === 1 && !input.linkedTasks.hasMore) {
        const id = input.linkedTasks.reads[0].taskId
        target = input.linkedTasks.snapshots.find(task => task.taskId === id)
        if (!target) { contextReads++; target = store.getTask(id) }
      } else {
        let offset = 0, page
        do {
          page = taskIndexPage(store.listTasks(), offset, 50, '')
          catalogueReads++
          target ??= page.tasks.find(task => task.title === '目标任务')
          offset = page.nextOffset
        } while (page.hasMore)
        contextReads++; target = store.getTask(target.taskId)
      }
      assert.equal(target.title, '目标任务')
      assert.equal(target.objective, '必须完整核验目标'.repeat(900))
      assert.deepEqual(input.messages.map(message => message.messageId), ['317', '318', '319'])
      assert.equal(store.getGroup('fixture').outbox.length, 0)
      assert.equal(store.getTopic('fixture', input.topicId).processedRevision, 0)
      results.push({ label, catalogueReads, contextReads, totalReads: catalogueReads + contextReads,
        sourceCount: input.messages.length, taskCount: store.listTasks().length, taskEffects: 0, sends: 0 })
    } finally { await coordinator.close(); await store.close() }
  }
  assert.ok(results[0].catalogueReads >= 2)
  assert.equal(results[1].catalogueReads, 0)
  assert.equal(results[1].contextReads, 1, '大正文仍需完整读回，不能以身份索引替代')
  console.log(JSON.stringify({ baseline, kind: 'deterministic-tool-plan-not-real-model', results }, null, 2))
} finally { await unlink(temporary) }
