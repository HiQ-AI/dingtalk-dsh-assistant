import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, name } from '../packages/dingtalk-dsh-assistant/resident.js'
import { buildTaskAssociationIndex } from '../packages/dingtalk-dsh-assistant/runtime.js'

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

test('resident重启通过Topic协调器恢复归类和已接受决策', async () => {
  const runtimeSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  const residentSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/resident.js', import.meta.url), 'utf8')
  const topicSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/topic-runtime.js', import.meta.url), 'utf8')
  assert.match(runtimeSource, /recoverInterruptedDecisions: \(\) => topics\.recover\(\)/)
  assert.match(topicSource, /routingStatus !== 'routed'/)
  assert.match(topicSource, /const commit = unfinished\(topic\)/)
  assert.doesNotMatch(residentSource, /runtime\.recoverPendingMessages\(\)/)
  assert.ok(residentSource.indexOf('await runtime.recoverInterruptedDecisions()') < residentSource.indexOf('startDwsBridge({'), '中断收敛必须先于DWS入站启动')
})

test('DWS profile在恢复遗留判断前注入引用消息查询协议', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/resident.js', import.meta.url), 'utf8')
  assert.match(source, /const dwsConfig = config\.dws \?\? \{\}[\s\S]*runtime\.setCurrentDwsProfile\(dwsConfig\.profile\)[\s\S]*await runtime\.recoverInterruptedDecisions\(\)/u)
})

test('旧任务来源和续接迁移配置在打开存储前明确拒绝', async () => {
  for (const field of ['taskProvenanceMigrations', 'taskContinuationMigrations']) {
    let opened = false
    await assert.rejects(apply({ storageDomain: { async open() { opened = true; throw new Error('not expected') } } }, { [field]: [{}] }), /legacy_task_migrations_removed:use_offline_topic_storage_migration/)
    assert.equal(opened, false)
  }
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
  assert.match(source, /ensureLeafDescriptor\(handle, task\); applyPermission\(handle, 'danger-full-access'\)/)
  assert.equal(source.match(/applyPermission\(handle, 'danger-full-access'\)/g)?.length, 2)
  assert.doesNotMatch(source, /applyPermission\(handle, 'workspace-write'\)/)
})

test('Task上下文只引用固定Topic版本，不再构造消息正文持久副本', async () => {
  const refs = [{ topicId: 'topic-1', revision: 2 }]
  const [item] = buildTaskAssociationIndex([{ taskId: 'task-1', title: '执行任务', objective: '导出数据', state: 'running', topicRefs: refs, inputVersion: 3, runSequence: 1, messageHistory: [{ text: '历史原文不得重复注入' }] }])
  assert.deepEqual(item.topicRefs, refs)
  assert.equal(item.inputVersion, 3)
  assert.equal(item.messageHistory, undefined)
  assert.equal(item.sourceMessageId, undefined)
})
