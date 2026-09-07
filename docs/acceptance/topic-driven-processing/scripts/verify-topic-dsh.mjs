import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// node <script> <installed-dsh-package-directory>
// 新建独立 DSH_HOME、JSON 存储和 Session；fake LLM、fake transport，绝不启动 DWS bridge。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const dshPackage = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('installed_dsh_package_directory_required')
const runDir = path.join(root, 'docs/tmp/topic-dsh', new Date().toISOString().replaceAll(/[:.]/g, '-'))
const home = path.join(runDir, 'home'), profile = path.join(home, 'profiles/topic-e2e')
await mkdir(profile, { recursive: true })
const socket = createServer()
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'topic-isolated-e2e', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
await writeFile(path.join(profile, 'cordis.yml'), '[]\n')
const patch = [
  { id: 'hmr', disabled: true }, { id: 'session-telemetry-otel', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', disabled: true },
  { id: 'agent-default-model', config: { provider: 'fake-resident', model: 'fake' } },
  { id: 'session-persistence-jsonl', config: { root: path.join(home, 'sessions'), compression: 'none', packChunks: false } },
  { insert: [
    { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard', roots: [{ path: path.join(dshPackage, 'config/agent-presets'), trust: 'system' }], includeUserRoot: false } },
    { id: 'storage', name: '@deepseek-ai/dsh-storage' },
    { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(home, 'data') } },
    { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'topic-resident', name: pathToFileURL(path.join(root, 'packages/dingtalk-dsh-assistant/resident.js')).href, config: { host: '127.0.0.1', port, fakeModel: true, testApiEnabled: true, agentWorkspaceDir: runDir, supervisorIntervalMs: 100, groups: [], dws: { enabled: false, writesAuthorized: false, executable: process.execPath, profile: 'fake-e2e-no-dws' } } },
  ] },
]
await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2))
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name]
const child = spawn(process.execPath, [path.join(dshPackage, 'lib/bin.js'), '--profile', 'topic-e2e'], { cwd: runDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', exit
child.stdout.on('data', (value) => { logs += value })
child.stderr.on('data', (value) => { logs += value })
const done = new Promise((resolve) => child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit) }))
const base = `http://127.0.0.1:${port}`
const request = async (route, body) => {
  const response = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  const value = await response.json()
  if (!response.ok) throw new Error(`${route}:HTTP ${response.status}:${JSON.stringify(value)}`)
  return value
}
const until = async (operation, predicate, label) => {
  const deadline = Date.now() + 35_000
  let result, lastError
  while (Date.now() < deadline) {
    if (exit) throw new Error(`dsh_exited:${JSON.stringify(exit)}\n${logs.slice(-12000)}`)
    try { result = await operation(); if (predicate(result)) return result } catch (error) { lastError = error }
    await delay(150)
  }
  throw new Error(`${label}_timeout:${JSON.stringify(result)}:${lastError?.message ?? ''}\n${logs.slice(-12000)}`)
}
try {
  const health = await until(() => request('/health'), (value) => value.status === 'ok', 'boot')
  assert.equal(health.transport, 'fake-dws')
  assert.equal(health.outboundAuthorized, false)
  assert.equal(health.modelMode, 'fake')
  await request('/test/subscriptions', { groupId: 'topic-e2e-group', name: '隔离验收', responsibility: '仅限 fake 模型协议验收' })
  for (const [messageId, text] of [['message-a', '请解释数据导出格式'], ['message-b', '请解释独立事项 B']]) {
    const receipt = await request('/test/inbound', { groupId: 'topic-e2e-group', messageId, text, senderName: '协议测试用户', senderOpenDingTalkId: 'fake-sender', occurredAt: new Date().toISOString() })
    assert.equal(receipt.accepted, true)
    assert.equal(receipt.processing, 'pending')
    await until(() => request('/state/groups?groupId=topic-e2e-group'), (group) => group.outbox.some((item) => item.text.includes(text)), 'topic_reply')
  }
  const listing = await request('/state/topics?groupId=topic-e2e-group')
  assert.equal(listing.total, 2)
  assert.ok(listing.topics.every((topic) => topic.revision === topic.processedRevision && topic.revision === 1))
  const group = await request('/state/groups?groupId=topic-e2e-group')
  assert.equal(group.topicProgress.unroutedMessages, 0)
  assert.equal(group.outbox.length, 2)
  assert.ok(group.outbox.every((item) => item.status === 'pending' && item.replyToSenderOpenDingTalkId === 'fake-sender'))
  const taskInput = { groupId: group.groupId, requestId: 'web-task-protocol-1', context: '请仅在隔离 fake 环境验证两阶段工具协议', title: 'fake Task 协议', objective: '验证 Task 检查点与结果协议', acceptanceCriteria: ['收到两阶段检查点与已审阅结果'], stageTasks: ['核对输入', '核对输出'] }
  await request('/tasks', taskInput)
  const completed = await until(() => request('/state/tasks'), (tasks) => tasks.length === 1 && tasks[0].state === 'completed', 'task_completion')
  const task = completed[0]
  assert.deepEqual(task.checkpoints.map((item) => item.kind), ['plan-confirmed', 'stage-completed', 'stage-completed'])
  assert.ok(task.checkpoints.every((item) => item.coordinatorDecision === 'acknowledge'))
  assert.equal(task.result.inputVersion, task.inputVersion)
  assert.equal(task.result.runSequence, task.runSequence)
  assert.equal(task.topicRefs.length, 1)
  assert.equal(task.messageHistory, undefined)
  const notified = await until(() => request('/state/groups?groupId=topic-e2e-group'), (item) => item.outbox.some((outbound) => outbound.text === `coordinated:${task.taskId}`), 'task_notification')
  assert.equal(notified.outbox.length, 3)
  await request('/tasks', taskInput)
  assert.equal((await request('/state/tasks')).length, 1)
  const persisted = JSON.parse(await readFile(path.join(home, 'data/dingtalk_dsh_assistant.json'), 'utf8'))
  const persistedGroups = Object.values(persisted.tables.groups)
  const durable = persistedGroups.find((item) => item.groupId === group.groupId)
  assert.equal(durable.topics.length, 3)
  assert.ok(durable.topics.every((topic) => topic.decisions.length === 1 && topic.decisions[0].status === 'completed'))
  const toolCounts = {}
  for (const entry of await readdir(path.join(home, 'sessions'), { recursive: true })) {
    if (!entry.endsWith('session.jsonl')) continue
    for (const line of (await readFile(path.join(home, 'sessions', entry), 'utf8')).split('\n').filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.type === 'tool/call') toolCounts[event.data.name] = (toolCounts[event.data.name] ?? 0) + 1
    }
  }
  for (const name of ['group_topic_route_submit', 'group_decision_submit', 'submit_task_checkpoint', 'submit_task_result', 'group_task_review_submit', 'group_reply_submit']) assert.ok(toolCounts[name] > 0, `native_tool_call_missing:${name}`)
  const evidence = { status: 'PASS', dshVersion: JSON.parse(await readFile(path.join(dshPackage, 'package.json'), 'utf8')).version, health, topics: durable.topics.length, outbox: notified.outbox.length, toolCounts, task: { state: task.state, inputVersion: task.inputVersion, runSequence: task.runSequence, checkpoints: task.checkpoints.map((item) => ({ kind: item.kind, remainingItems: item.remainingItems.length, coordinatorDecision: item.coordinatorDecision })), duplicateRequestTaskCount: 1, resultStatus: task.result.status }, durableDecisions: durable.topics.map((topic) => ({ topicId: topic.topicId, revision: topic.revision, processedRevision: topic.processedRevision, status: topic.decisions[0].status })), runDir }
  await writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  child.kill('SIGTERM')
  await Promise.race([done, delay(5000)])
  if (!exit) child.kill('SIGKILL')
  await writeFile(path.join(runDir, 'dsh.log'), logs)
}
