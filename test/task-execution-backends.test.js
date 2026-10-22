import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

// 真服务与SQLite，driver仅记录路由合同；CLI协议/进程行为另由独立原生测试覆盖。
test('默认DSH、混合团队、配置切换和重启保持原执行后端与逐轮文档', async t => {
  const root = await mkdtemp(join(tmpdir(), 'execution-backends-'))
  const snapshot = { tables: {}, global: null }
  const facility = new DomainFacility({ emit() {}, storage: { backend: { get: () => ({ kv: { async open() { return {
    loadAll: async () => structuredClone(snapshot), close: async () => {},
    async putRecord(table, key, value) { (snapshot.tables[table] ??= {})[key] = structuredClone(value) },
    async deleteRecord(table, key) { delete snapshot.tables[table][key] },
  } } } }) } } }, { backend: 'backend-test' })
  const residentStore = await openResidentStore(facility)
  await residentStore.subscribe({ groupId: 'g', name: '本地测试群' })
  const agentConfig = { workspaceDir: root }
  const legacy = { getAgentConfig: () => agentConfig, getGroup: id => residentStore.getGroup(id) }
  const noop = async () => {}, runs = [], registrations = [], members = []
  let service, phase = 0, resumed = false
  const driver = backend => ({ close: noop, cancel: noop, feedback: noop, assertDrained() {}, recoverDrained: noop,
    run: async ({ binding, definition, onSessionBound, onProgress, onResult }) => {
      runs.push({ backend, binding, definition })
      await onSessionBound()
      await onProgress({ reportId: `${binding.inputVersion}`, summary: `${backend}第${binding.inputVersion}轮`, evidence: [], plan: '检查固定版本，再记录证据。' })
      await onResult({ status: 'completed', summary: '路由夹具完成', evidence: [], limitations: ['非模型调用'], artifacts: [] })
      return { status: 'submitted' }
    } })
  const open = initialize => openTaskSessionService({ ctx: { agents: { get() {} }, sessions: { get() {} } }, legacy, residentStore,
    config: { dbPath: join(root, 'control.sqlite'), workspaceDir: root, instanceId: 'backend-fixture', initialize, webActorId: 'owner' },
    persistence: { register: async value => registrations.push(value.sessionId), close: noop },
    executionSessions: driver('dsh'), claudeExecutionSessions: driver('claude-code'),
    taskSessions: { close: noop, cancel: noop, run: async ({ delegate, submit }) => {
      if (phase === 0) {
        phase = 1
        members.push(await delegate({ key: 'develop', objective: '开发及测试' }))
        agentConfig.executionBackend = 'claude-code'
        members.push(await delegate({ key: 'review', objective: '独立核验' }))
        agentConfig.executionBackend = 'dsh'
        const replay = await delegate({ key: 'review', objective: '独立核验' })
        assert.equal(replay.executionId, members[1].executionId)
        members.push(await delegate({ key: 'release', objective: '核对交付边界' }))
      } else if (phase === 2) {
        phase = 3
        await delegate({ executionId: members[1].executionId, key: 'review-round-two', objective: '原核验成员继续本轮核对' })
        resumed = true
      }
      await submit({ action: 'wait', summary: '保留测试任务供下一轮', evidence: [], limitations: ['离线路由测试'] })
    } },
  })
  service = await open(true)
  t.after(async () => { await service.close(); await residentStore.close(); await rm(root, { recursive: true, force: true }) })
  const task = await service.createTask({ groupId: 'g', requestId: 'create', objective: '三人分工核对' })
  await service.whenIdle()
  assert.deepEqual(runs.map(item => item.backend), ['dsh', 'claude-code', 'dsh'])
  const first = await service.taskExecutions(task.taskId)
  assert.equal(first.total, 3)
  assert.deepEqual(first.executions.map(item => item.executionBackend), ['dsh', 'claude-code', 'dsh'])
  const cli = first.executions.find(item => item.executionBackend === 'claude-code')
  assert.ok(cli.logPath.endsWith(join(cli.executionId, 'claude-events.jsonl')))
  const priorDocument = await readFile(cli.document.path)
  assert.match(priorDocument.toString(), /executionBackend: claude-code/)
  phase = 2
  await service.store.command({ id: 'second-round', kind: 'wake.enqueue', args: { taskId: task.taskId, kind: 'fixture-next-round' } })
  await service.recover(); await service.whenIdle()
  assert.equal(resumed, true)
  assert.equal(runs.at(-1).backend, 'claude-code')
  assert.equal(runs.at(-1).binding.sessionId, cli.sessionId)
  assert.equal(runs.at(-1).binding.inputVersion, 2)
  assert.deepEqual(await readFile(cli.document.path), priorDocument)
  const second = (await service.taskExecutions(task.taskId)).executions.find(item => item.executionId === cli.executionId)
  assert.notEqual(second.document.path, cli.document.path)
  assert.match(await readFile(second.document.path, 'utf8'), /第 2 轮/)
  assert.equal(registrations.includes(cli.sessionId), false, 'CLI不能注册为DSH原生会话')
  await service.close()
  service = await open(false)
  await service.recover(); await service.whenIdle()
  assert.deepEqual((await service.taskDetail(task.taskId)).executionSessions.map(item => item.executionBackend), ['dsh', 'claude-code', 'dsh'])
  assert.equal(registrations.includes(cli.sessionId), false)
  assert.equal(runs.length, 4, '重启不重放已完成执行')
  assert.deepEqual(await readFile(cli.document.path), priorDocument)
})
