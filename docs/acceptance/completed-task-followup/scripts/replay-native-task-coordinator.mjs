// 只读历史快照 + 当前原生协调器 + 当前配置模型；任务动作只在隔离内存投影中回执，不执行或发送。
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../../../../packages/dingtalk-dsh-assistant/store.js'
import { openTaskTopicCoordinator } from '../../../../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'
import { available, reason, nativeTaskHost } from '../../../../test/fixtures/task-session-native-host.js'

const { values } = parseArgs({ options: { profile: { type: 'string' }, resident: { type: 'string' }, tasks: { type: 'string' },
  message: { type: 'string' }, output: { type: 'string' }, check: { type: 'boolean' }, run: { type: 'boolean' } } })
for (const key of ['profile', 'resident', 'tasks', 'output']) assert.ok(isAbsolute(values[key] ?? ''), key)
assert.ok(values.message)
assert.notEqual(values.check === true, values.run === true)
assert.ok(available, reason)
const profile = createRequire(join(values.profile, 'package.json'))
const provider = await import(pathToFileURL(profile.resolve('dsh-codex-connect')))
const raw = JSON.parse(await readFile(values.resident, 'utf8'))
const original = Object.values(raw.tables.groups).find(group => group.messages.some(message => message.messageId === values.message))
assert.ok(original)
const source = original.messages.find(message => message.messageId === values.message)
const tasksBytes = await readFile(values.tasks), captured = JSON.parse(tasksBytes)
assert.ok(captured.tasks.length && !captured.hasMore && captured.tasks.every(task => task.state === 'completed'))
const configResponse = await fetch('http://127.0.0.1:18998/state/agent-config', { signal: AbortSignal.timeout(10000) })
assert.equal(configResponse.status, 200)
const config = await configResponse.json()
const selection = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
assert.equal(selection.provider, 'openai-codex')
const patches = profile('yaml').parse(await readFile(join(values.profile, 'cordis.patch.yml'), 'utf8'),
  { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: text => text }] })
const providers = patches.filter(patch => patch.name === 'dsh-codex-connect')
assert.equal(providers.length, 1, '使用当前 profile 明确配置的唯一 provider，包括代理；不执行 YAML 中的 JS')
const profileSettings = providers[0].config
if (values.check) {
  console.log(JSON.stringify({ mode: 'check', writes: 0, taskCount: captured.tasks.length, ...selection, businessDispatch: false, dingtalkSend: false }))
  process.exit(0)
}
const output = resolve(values.output)
await mkdir(output, { recursive: false })
// 完整原文与本机身份仅留在本轮本地临时目录；交付报告只保存摘要和哈希。
const group = structuredClone(original)
group.messages = group.messages.filter(message => message.sequence < source.sequence)
group.topics = group.topics.filter(topic => !topic.entries.some(entry => entry.messageId === source.messageId))
  .map(topic => ({ ...topic, processedRevision: topic.revision, decisions: [] }))
group.outbox = []; group.coordinationRequests = {}; group.routeHistory = []; group.taskReservations = []
group.nextSequence = source.sequence
const snapshot = { global: null, tables: { groups: { [group.groupId]: group } } }
const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
  loadAll: async () => structuredClone(snapshot), close: async () => {},
  async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
  async deleteRecord(table, key) { delete snapshot.tables[table]?.[key] },
} } } }) } } }, { backend: 'isolated-followup-replay' })
const store = await openResidentStore(facility)
await store.setAgentNames(['小小鹏'])
const taskMap = new Map(captured.tasks.map(task => [task.taskId, structuredClone(task)]))
store.setTaskSessionReader({ getTask: id => taskMap.get(id), listTasks: () => [...taskMap.values()], isTaskQuiescent: () => true })
const h = await nativeTaskHost(join(output, 'native'), () => { throw new Error('SCRIPTED_MODEL_FORBIDDEN') }, { resident: true })
provider.apply(h.ctx, { ...provider.DEFAULT_OPENAI_CODEX_SETTINGS, ...profileSettings })
const applied = [], errors = []
const started = Date.now()
const coordinator = await openTaskTopicCoordinator({ ctx: h.ctx, store, root: output, models: selection,
  legacy: { getAgentConfig: () => ({ agentPreset: 'native-test' }) },
  async applyAction(_groupId, action, operation) {
    applied.push(structuredClone(action))
    const current = taskMap.get(action.taskId)
    taskMap.set(operation.taskId, { ...(current ?? {}), taskId: operation.taskId, groupId: group.groupId,
      title: current?.title ?? action.title, objective: current?.objective ?? action.objective,
      state: 'running', inputVersion: (current?.inputVersion ?? 0) + 1, runSequence: (current?.runSequence ?? 0) + 1,
      appliedOperations: [...(current?.appliedOperations ?? []), operation.operationId], topicRefs: action.topicRefs })
  },
  appendOutbox: args => store.appendOutbox(args),
  onError: (_groupId, error) => errors.push({ code: error.code, message: error.message }),
})
let passed = false, failure
try {
  await store.ingest({ groupId: group.groupId, messageId: source.messageId, text: source.text,
    senderName: source.senderName, senderOpenDingTalkId: source.senderOpenDingTalkId, sourceKind: 'dingtalk', occurredAt: source.occurredAt })
  await coordinator.schedule(group.groupId)
  await coordinator.whenIdle()
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.ok(applied.length > 1, '批量跟进必须分别操作多个原任务')
  assert.ok(applied.every(action => action.kind === 'task-reopen' && captured.tasks.some(task => task.taskId === action.taskId)))
  assert.equal(new Set(applied.map(action => action.taskId)).size, applied.length)
  passed = true
} catch (error) { failure = error.message }
finally {
  await coordinator.close(); await store.close(); await h.close()
}
const summary = {
  passed, failure, ...selection, elapsedMs: Date.now() - started,
  sourceSha256: createHash('sha256').update(source.text).digest('hex'), capturedTasksSha256: createHash('sha256').update(tasksBytes).digest('hex'),
  capturedTaskCount: captured.tasks.length, taskCataloguePages: h.toolResults.filter(result => result.name === 'group_task_list').length,
  taskDetailReads: h.toolResults.filter(result => result.name === 'group_task_context_get').length,
  actionKinds: applied.map(action => action.kind), uniqueOriginalTargets: new Set(applied.map(action => action.taskId)).size,
  businessDispatch: false, dingtalkSend: false, errors,
  boundary: '真实模型及当前原生协调器；原消息及14项历史任务快照，话题历史作只读裁剪，任务执行为隔离内存投影，无真实PR/UAT操作。',
}
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
await writeFile(join(output, 'actions.local.json'), JSON.stringify(applied, null, 2))
console.log(JSON.stringify(summary))
if (!passed) process.exitCode = 1
