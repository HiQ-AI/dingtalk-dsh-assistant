import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:http'
import { handleRequest } from '../packages/dingtalk-dsh-assistant/http.js'
import * as resident from '../packages/dingtalk-dsh-assistant/resident.js'
import { available, reason, nativeTaskHost } from './fixtures/task-session-native-host.js'
const { apply, name } = resident
import { buildTaskAssociationIndex } from '../packages/dingtalk-dsh-assistant/runtime.js'

test('单一业务插件以原生任务会话启停，不恢复已移除的任务表格同步', { ...({ skip: !available ? reason : false }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'resident-health-'))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const interval = t.mock.method(globalThis, 'setInterval')
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, () => { throw new Error('MODEL_NOT_EXPECTED') }, { resident: true }))
  const plugin = await t.step(async () => host.ctx.plugin(resident, { host: '127.0.0.1', port: 0, agentWorkspaceDir: root,
    agentPreset: 'native-test', dws: { enabled: false }, taskSessions: { dbPath: join(root, 'tasks.db'), instanceId: 'resident-health', ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', initialize: true } }))
  assert.equal(name, 'dingtalk-dsh-assistant')
  assert.equal(interval.mock.calls.some(call => call.arguments[1] === 180000), false)
  assert.equal(host.ctx.get('execution'), undefined)
  assert.equal(host.ctx.get('subagents'), undefined)
  assert.equal(host.requests.length, 0)
  await t.step(async () => plugin.dispose())
}))

test('通用生产源码不绑定个人姓名，群回复署名遵循工作区与群职责', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /签名、口吻和身份声明由 Agent 自身工作区规则决定/)
  assert.doesNotMatch(source, /小小鹏|孙鹏/u)
  const root=new URL('../packages/',import.meta.url)
  const files=await readdir(root,{recursive:true})
  for(const file of files.filter(name=>name.endsWith('.js'))){
    const body = await readFile(new URL(file.replaceAll('\\','/'),root),'utf8')
    assert.doesNotMatch(body, /孙鹏/u, file)
    assert.doesNotMatch(body, /小小鹏/u, file)
  }
})

test('resident重启只恢复任务会话，不重新加载历史Topic任务调度器', async () => {
  const runtimeSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/task-resident-runtime.js', import.meta.url), 'utf8')
  const residentSource = await readFile(new URL('../packages/dingtalk-dsh-assistant/resident.js', import.meta.url), 'utf8')
  assert.match(residentSource, /openTaskResidentRuntime\(ctx, store/)
  assert.match(residentSource, /openTaskSessionService\(/)
  assert.match(residentSource, /const recoverTasks = \(\) => tasks\.recover\(\)/)
  assert.match(runtimeSource, /recoverInterruptedDecisions: async \(\) => \[\]/)
  assert.doesNotMatch(residentSource, /openResidentRuntime\(|openWorkflowService\(/)
  assert.doesNotMatch(residentSource, /runtime\.recoverPendingMessages\(\)/)
  assert.ok(residentSource.indexOf('void recoverTasks()') < residentSource.indexOf('startDwsBridge({'), '任务恢复必须先于DWS入站启动')
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
  const calls = []
  const server = createServer((request, response) => handleRequest(request, response, {
    retryDecisionFailedMessage: async value => { calls.push(value); return { retried: true } },
  }, { testApiEnabled: false }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const input = { messageVersion: 2, activeUnitRefs: [{ unitId: 'unit', unitRevision: 1 }], phase: 'decision', requestId: 'request', token: 'a'.repeat(64) }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/config/groups/group/messages/message/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { retried: true })
    assert.deepEqual(calls, [{ ...input, groupId: 'group', messageId: 'message' }])
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('叶子会话使用DSH原生descriptor且恢复旧会话时补齐', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/runtime.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ snapshotSubagentDescriptor \} from '@deepseek-ai\/dsh-subagent'/)
  assert.match(source, /handle\.agent\.session\.append\('subagent\/descriptor', snapshotSubagentDescriptor\(/)
  assert.match(source, /mode: 'continuable'/)
  assert.match(source, /label: leafDisplayName\(task\.title \?\? task\.objective\)/)
  assert.match(source, /heading\.length <= 20/)
  assert.match(source, /ensureLeafDescriptor\(handle, task\); applyPermission\(handle, 'danger-full-access'\)/)
  assert.equal(source.match(/applyPermission\(handle, 'danger-full-access'\)/g)?.length, 6)
  assert.doesNotMatch(source, /applyPermission\(handle, 'read-only'\)/)
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
