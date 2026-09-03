import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, name } from '../packages/dingtalk-dsh-assistant/resident.js'

test('单一业务插件使用通用命名且 health 明示 fake transport', async () => {
  const effects = []
  const logs = []
  const records = new Map()
  const table = {
    get: (key) => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    async put(key, value) { records.set(key, value) },
    async update(key, transform) { const value = transform(records.get(key)); records.set(key, value); return value },
  }
  const ctx = {
    effect(callback) {
      effects.push(callback)
    },
    logger: {
      info(message) {
        logs.push(message)
      },
    },
    storageDomain: {
      async open() {
        return { table: () => table, close: async () => undefined }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    agents: {
      async create() { throw new Error('not expected') },
      async resume() { throw new Error('not expected') },
    },
    subagents: { drainContinuableDescendants: async () => undefined },
  }

  await apply(ctx, { host: '127.0.0.1', port: 0 })
  assert.equal(name, 'dingtalk-dsh-assistant')
  assert.equal(effects.length, 1)

  const dispose = effects[0]()
  assert.match(logs[0], /DingTalk group assistant listening/)
  await dispose()
})

test('完成通知签名由 Agent 工作区规则决定且插件不写死身份', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /签名、口吻和身份声明由 Agent 自身工作区规则决定/)
  assert.doesNotMatch(source, /小小鹏|孙鹏/u)
})

test('resident重启后按群内顺序恢复遗留pending消息', async () => {
  const runtimeSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  const residentSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/resident.js', import.meta.url), 'utf8')
  assert.match(runtimeSource, /async recoverPendingMessages\(\)/)
  assert.match(runtimeSource, /agentDeliveryStatus === 'pending'/)
  assert.match(runtimeSource, /left\.groupId\.localeCompare\(right\.groupId\) \|\| left\.sequence - right\.sequence/)
  assert.match(runtimeSource, /\['steered', 'delivered', 'decision-failed', 'skipped'\]\.includes\(persisted\?\.agentDeliveryStatus\)/)
  assert.match(residentSource, /runtime\.recoverPendingMessages\(\)/)
  assert.match(runtimeSource, /async recoverInterruptedDecisions\(\)/)
  assert.match(runtimeSource, /agentDeliveryStatus === 'steered'/)
  assert.match(runtimeSource, /resident_restarted_before_decision_settled/)
  assert.match(residentSource, /runtime\.recoverInterruptedDecisions\(\)/)
})

test('任务上下文允许静默追加且已插话消息不会由重复事件重试', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /decision\.reply\.trim\(\) === ''/)
  assert.match(source, /group = store\.getGroup\(message\.groupId\)/)
  assert.match(source, /\['steered', 'delivered', 'decision-failed', 'skipped'\]\.includes\(persisted\?\.agentDeliveryStatus\)/)
})

test('生产HTTP提供精确的单消息重试入口', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/http.js', import.meta.url), 'utf8')
  assert.match(source, /\/messages\\\/\(\[\^\/\]\+\)\\\/retry/)
  assert.match(source, /await store\.retryDecisionFailedMessage\(\{ groupId, messageId \}\)/)
})

test('叶子会话使用DSH原生descriptor且恢复旧会话时补齐', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ snapshotSubagentDescriptor \} from '@deepseek-ai\/dsh-subagent'/)
  assert.match(source, /handle\.agent\.session\.append\('subagent\/descriptor', snapshotSubagentDescriptor\(/)
  assert.match(source, /mode: 'continuable'/)
  assert.match(source, /label: leafDisplayName\(task\.title \?\? task\.objective\)/)
  assert.match(source, /heading\.length <= 20/)
  assert.match(source, /ensureLeafDescriptor\(handle, task\); applyFullAccess\(handle\)/)
})

test('群消息任务名与来源证据分别持久化', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /title: action\.title, objective: action\.objective/)
  assert.match(source, /relatedContexts: \[sourceEnvelope\]/)
})
