import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, latestInput, modelToolValues } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

test('保存 Agent 工作目录及重开服务不会迁移原生首筛、Router 或任务文件与日志',
  { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-cwd-')), next = join(root, 'configured-agent-work')
    await t.beginBusiness()
    await t.step(async () => mkdir(next))
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), sessions = []
    t.onCancel(() => release.resolve())

    let first = true, h, runtime, store
    t.after(async () => { release.resolve(); await h?.service?.close(); if (h) h.service = undefined; await runtime?.close(); if (h) h.residentStore = undefined; await h?.close(); await rm(root, { recursive: true, force: true }) })
    h = await t.step(async () => nativeTaskHost(root, async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('triage_submit') || names.includes('router_submit')) {
        if (first) { first = false; entered.resolve(); await release.promise }
        for (const source of input.sources) {
          let covered = source.text.length
          for (const page of modelToolValues(request))
            if (page.batchId === input.batchId && page.sourceId === source.sourceId && page.offset <= covered)
              covered = Math.max(covered, page.nextOffset)
          if (covered < source.totalLength)
            return [{ name: 'router_source_read', args: { sourceId: source.sourceId, offset: covered, limit: 16000 } }]
        }
        return names.includes('triage_submit')
          ? [{ name: 'triage_submit', args: { needsProcessing: true, reply: null } }]
          : [{ name: 'router_submit', args: { actions: [], continuity: [], reply: null } }]
      }
      if (names.includes('task_session_submit')) return [{ name: 'task_session_submit', args: {
        decision: { action: 'wait', summary: '仅核验目录，等待后续要求', evidence: [], limitations: [] } } }]
      return []
    }, { resident: true }))
    h.ctx.on('session/created', session => {
      const purpose = session.id.startsWith('session-triage-') ? 'triage' : session.id.startsWith('session-router-') ? 'router' : null
      if (purpose) sessions.push({ id: session.id, cwd: session.header.cwd, purpose, session })
    })
    store = h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
    runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' }))
    await t.step(async () => runtime.subscribe({ groupId: 'native-group', name: '测试群' }))
    const open = initialize => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: store,
      config: { dbPath: join(root, 'dynamic.db'), instanceId: 'cwd-native', initialize },
      notifications: { async send() { return { messageId: 'isolated' } }, async readback() { return { visible: true, messageId: 'isolated' } } } })
    h.service = await t.step(async () => open(true))
    const ingest = n => h.service.ingest({ groupId: 'native-group', messageId: `cwd-${n}`, senderOpenDingTalkId: 'user',
      text: `核验会话工作目录：第${n}条`, timestamp: '2026-10-21T01:00:00Z' })
    const firstIngress = ingest(1)
    await t.step(async () => entered.promise)
    const triageSessions = () => sessions.filter(session => session.purpose === 'triage')
    const routerSessions = () => sessions.filter(session => session.purpose === 'router')
    const originalCwd = triageSessions()[0].cwd
    assert.ok(originalCwd.startsWith(join(root, 'session-workspaces')), '首筛使用独立受信工作目录')
    const before = await t.step(async () => runtime.updateAgentConfig({ workspaceDir: `  ${next}  ` }))
    assert.equal(before.workspaceDir, next)
    assert.equal(sessions[0].session.header.cwd, originalCwd, 'saving configuration never mutates a running session')
    assert.equal(store.getTaskWorkspaceDir(), root)
    release.resolve(); await t.step(async () => firstIngress); await t.step(async () => h.service.whenIdle())
    await t.step(async () => ingest(2)); await t.step(async () => h.service.whenIdle())
    assert.equal(triageSessions()[1].cwd, originalCwd, '后续首筛会话仍使用稳定运行根')
    assert.ok(!triageSessions()[1].cwd.startsWith(next))
    assert.notEqual(triageSessions()[0].id, triageSessions()[1].id)
    const routerCwd = routerSessions()[0].cwd
    assert.ok(routerCwd.startsWith(join(root, 'session-workspaces')))
    assert.notEqual(routerCwd, originalCwd, '首筛和 Router 的职责目录独立')
    assert.ok(routerSessions().length >= 3, '排空两轮后真实创建了后续物理 Router')
    assert.ok(routerSessions().every(session => session.cwd === routerCwd && !session.cwd.startsWith(next)))
    await t.step(async () => assert.rejects(runtime.updateAgentConfig({ workspaceDir: 'relative-folder' }), /agent_workspace_must_be_absolute/))
    assert.equal(runtime.getAgentConfig().workspaceDir, next)
    // 重开 Host 不传任务根，仍须保留原任务文件及会话持久化位置。
    await t.step(async () => h.service.close()); h.service = undefined; await t.step(async () => runtime.close())
    store = h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
    runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' }))
    assert.equal(runtime.getAgentConfig().workspaceDir, next, 'saved Agent cwd survives facade restart')
    h.service = await t.step(async () => open(false))
    const task = await t.step(async () => h.service.store.command({ id: 'cwd-root-task', kind: 'task.create', args: {
      taskId: 'cwd-root-task', groupId: 'native-group', ownerActorId: 'user', request: '仅校验稳定工作区' } }))
    const projection = await t.step(async () => h.service.taskDetail(task.result.task.taskId))
    assert.ok(projection.session.workspaceDir.startsWith(join(root, 'tasks')))
    assert.ok(projection.session.logPath.startsWith(join(root, 'tasks')))
    assert.ok(!projection.session.logPath.startsWith(next))
    await t.step(async () => runtime.updateAgentConfig({ workspaceDir: '' }))
    await t.step(async () => ingest(3)); await t.step(async () => h.service.whenIdle())
    assert.equal(triageSessions()[2].cwd, originalCwd, '清空 Agent 工作目录不会迁移首筛目录')
    assert.ok(routerSessions().every(session => session.cwd === routerCwd))
    assert.ok(h.requests.every(request => !request.tools.some(tool => ['coordination_submit', 'group_topic_route_submit'].includes(tool.name))))
    assert.equal(store.listTopics('native-group').length, 0, '新消息没有创建 Topic')
  }))
