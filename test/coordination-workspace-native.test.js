import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

test('saved Agent cwd survives restart without moving native Topic sessions or existing task files and logs',
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
      if (names.includes('group_topic_route_submit')) {
        if (first) { first = false; entered.resolve(); await release.promise }
        return [{ name: 'group_topic_route_submit', args: {
          requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId,
            messageVersion: message.messageVersion, units: [], ignoredRefs: [{ quote: message.text, reason: '仅讨论，无业务交办' }] })) } }]
      }
      if (names.includes('task_session_submit')) return [{ name: 'task_session_submit', args: {
        decision: { action: 'wait', summary: '仅核验目录，等待后续要求', evidence: [], limitations: [] } } }]
      return []
    }, { resident: true }))
    h.ctx.on('session/created', session => {
      if (session.id.startsWith('session-coordination-')) sessions.push({ id: session.id, cwd: session.header.cwd, session })
    })
    store = h.residentStore = await t.step(async () => openResidentStore(h.ctx.storageDomain))
    runtime = await t.step(async () => openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' }))
    await t.step(async () => runtime.subscribe({ groupId: 'native-group', name: '测试群' }))
    const open = initialize => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: store,
      config: { dbPath: join(root, 'dynamic.db'), instanceId: 'cwd-native', initialize,
        coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } },
      notifications: { async send() { return { messageId: 'isolated' } }, async readback() { return { visible: true, messageId: 'isolated' } } } })
    h.service = await t.step(async () => open(true))
    const ingest = n => h.service.ingest({ groupId: 'native-group', messageId: `cwd-${n}`, senderOpenDingTalkId: 'user',
      text: `A完成后继续B：第${n}条`, timestamp: '2026-10-21T01:00:00Z' })
    const firstIngress = ingest(1)
    await t.step(async () => entered.promise)
    const originalCwd = sessions[0].cwd
    assert.ok(originalCwd.startsWith(join(root, 'session-workspaces')), 'Topic has its own trusted session workspace')
    const before = await t.step(async () => runtime.updateAgentConfig({ workspaceDir: `  ${next}  ` }))
    assert.equal(before.workspaceDir, next)
    assert.equal(sessions[0].session.header.cwd, originalCwd, 'saving configuration never mutates a running session')
    assert.equal(store.getTaskWorkspaceDir(), root)
    release.resolve(); await t.step(async () => firstIngress); await t.step(async () => h.service.whenIdle())
    await t.step(async () => ingest(2)); await t.step(async () => h.service.whenIdle())
    assert.equal(sessions[1].cwd, originalCwd, 'future Topic sessions remain under the stable runtime root')
    assert.ok(!sessions[1].cwd.startsWith(next))
    assert.notEqual(sessions[0].id, sessions[1].id)
    await t.step(async () => assert.rejects(runtime.updateAgentConfig({ workspaceDir: 'relative-folder' }), /agent_workspace_must_be_absolute/))
    assert.equal(runtime.getAgentConfig().workspaceDir, next)
    // Restart the Host service with no explicit task root: it must retain the
    // original task workspace and persistence route root, not the new Agent cwd.
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
    assert.equal(sessions[2].cwd, originalCwd, 'clearing Agent cwd does not relocate the runtime session workspace')
    assert.ok(h.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
  }))
