import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, latestInput } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

test('saved Agent cwd is injected into the next native coordination plan while active sessions and task log root stay fixed',
  { skip: !available ? reason : false, timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coordination-cwd-')), next = join(root, 'configured-agent-work')
    await mkdir(next)
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), sessions = []
    let first = true, h, runtime, store
    t.after(async () => { release.resolve(); await h?.service?.close(); await runtime?.close(); await h?.close(); await rm(root, { recursive: true, force: true }) })
    h = await nativeTaskHost(root, async request => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: {
        requestId: input.requestId, routes: input.messages.map(message => ({ messageId: message.messageId,
          messageVersion: message.messageVersion, ignoredRefs: [], units: [{ unitKey: 'sequence', summary: '前置任务存在歧义',
            sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '同群任务顺序' }] })) } }]
      if (names.includes('coordination_submit')) {
        if (first) { first = false; entered.resolve(); await release.promise }
        return [{ name: 'coordination_submit', args: { kind: 'clarify', question: '请明确任务A', candidates: [] } }]
      }
      if (names.includes('task_session_submit')) return [{ name: 'task_session_submit', args: {
        decision: { action: 'wait', summary: '仅核验目录，等待后续要求', evidence: [], limitations: [] } } }]
      return []
    }, { resident: true })
    h.ctx.on('session/created', session => {
      if (session.id.startsWith('independent-')) sessions.push({ id: session.id, cwd: session.header.cwd, session })
    })
    store = await openResidentStore(h.ctx.storageDomain)
    runtime = await openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' })
    await runtime.subscribe({ groupId: 'native-group', name: '测试群' })
    const open = initialize => openTaskSessionService({ ctx: h.ctx, legacy: runtime, residentStore: store,
      config: { dbPath: join(root, 'dynamic.db'), instanceId: 'cwd-native', initialize,
        coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } },
      notifications: { async send() { return { messageId: 'isolated' } }, async readback() { return { visible: true, messageId: 'isolated' } } } })
    h.service = await open(true)
    const ingest = n => h.service.ingest({ groupId: 'native-group', messageId: `cwd-${n}`, senderOpenDingTalkId: 'user',
      text: `A完成后继续B：第${n}条`, timestamp: '2026-10-21T01:00:00Z' })
    const firstIngress = ingest(1)
    await entered.promise
    assert.equal(sessions[0].cwd, root, 'empty initial Agent configuration uses its existing cwd fallback')
    const before = await runtime.updateAgentConfig({ workspaceDir: `  ${next}  ` })
    assert.equal(before.workspaceDir, next)
    assert.equal(sessions[0].session.header.cwd, root, 'saving configuration never mutates a running session')
    assert.equal(store.getTaskWorkspaceDir(), root)
    release.resolve(); await firstIngress; await h.service.whenIdle()
    await ingest(2); await h.service.whenIdle()
    assert.equal(sessions[1].cwd, next)
    assert.notEqual(sessions[0].id, sessions[1].id)
    await assert.rejects(runtime.updateAgentConfig({ workspaceDir: 'relative-folder' }), /agent_workspace_must_be_absolute/)
    assert.equal(runtime.getAgentConfig().workspaceDir, next)
    // Restart the Host service with no explicit task root: it must retain the
    // original task workspace and persistence route root, not the new Agent cwd.
    await h.service.close(); await runtime.close()
    store = await openResidentStore(h.ctx.storageDomain)
    runtime = await openTaskResidentRuntime(h.ctx, store, root, { agentPreset: 'native-test' })
    assert.equal(runtime.getAgentConfig().workspaceDir, next, 'saved Agent cwd survives facade restart')
    h.service = await open(false)
    const task = await h.service.store.command({ id: 'cwd-root-task', kind: 'task.create', args: {
      taskId: 'cwd-root-task', groupId: 'native-group', ownerActorId: 'user', request: '仅校验稳定工作区' } })
    const projection = await h.service.taskDetail(task.result.task.taskId)
    assert.ok(projection.session.workspaceDir.startsWith(join(root, 'tasks')))
    assert.ok(projection.session.logPath.startsWith(join(root, 'tasks')))
    assert.ok(!projection.session.logPath.startsWith(next))
    await runtime.updateAgentConfig({ workspaceDir: '' })
    await ingest(3); await h.service.whenIdle()
    assert.equal(sessions[2].cwd, root, 'empty saved value uses runtime cwd, without a fixed coordination subdirectory')
  })
