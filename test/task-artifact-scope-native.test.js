import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { coordinationArtifactScope, bindTaskArtifactScope } from '../packages/dingtalk-dsh-assistant/task-artifact-scope.js'
import { available, reason, nativeTaskHost, nativeShell, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'

const quote = value => `'${value.replaceAll("'", "''")}'`
test('official artifact binding makes native FS and shell share one root and reject outside writes',
  { skip: !available ? reason : false, timeout: 60000 }, async t => {
    const root = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : join(process.cwd(), 'docs', 'tmp'), 'artifact-native-'))
    const scope = await coordinationArtifactScope(root, { coordinationId: 'coordination-team', memberTaskIds: ['task-a', 'task-b', 'task-c'] })
    let host
    const steps = new Map()
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    const policyEntry = process.env.DSH_ARTIFACT_POLICY_MODULE
    host = await nativeTaskHost(root, async (request, h) => {
      const { task } = latestInput(request)
      if (!task) return []
      await bindTaskArtifactScope({ sandboxPolicy: h.ctx.sandboxPolicy, tools: { guard: rule => h.ctx.tools.guard(rule) } }, {
        root, scope, taskId: task.taskId, session: h.ctx.sessions.get(task.sessionId),
      })
      const step = steps.get(task.taskId) ?? 0
      steps.set(task.taskId, step + 1)
      const role = task.taskId.at(-1), cwd = join(root, 'tasks', task.taskId)
      const shared = join(scope.artifactRoot, role + '.txt'), outside = join(cwd, 'forbidden.txt')
      if (step === 0) return [{ name: nativeShell, args: { description: 'Write inside the formal artifact root', command: process.platform === 'win32'
        ? `[IO.File]::WriteAllText(${quote(shared)},'native-${role}')`
        : `printf 'native-${role}' > ${quote(shared)}` } }]
      if (step === 1) return [{ name: 'write', args: { file_path: join(scope.artifactRoot, role + '-fs.txt'), content: `native-fs-${role}` } }]
      if (step === 2) return [{ name: 'read', args: { file_path: join(scope.artifactRoot, 'a.txt') } }]
      if (step === 3) return [{ name: 'write', args: { file_path: outside, content: 'forbidden' } }]
      if (step === 4) return [{ name: nativeShell, args: { description: 'Verify shell rejects writing outside artifacts', command: process.platform === 'win32'
        ? `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${quote(outside)},'forbidden')`
        : `printf 'forbidden' > ${quote(outside)}` } }]
      return [{ name: 'task_session_submit', args: { decision: { action: 'complete', summary: '统一产物根原生正反例已核验。', evidence: [], limitations: [] } } }]
    }, { fsSandbox: true, artifactPolicyEntry: policyEntry })
    for (const taskId of scope.memberTaskIds) {
      await host.service.store.command({ id: 'create-' + taskId, kind: 'task.create', args: { taskId, groupId: 'native-group', ownerActorId: 'native-user', request: '隔离验证正式产物绑定' } })
      await host.service.recover()
      await host.service.whenIdle()
      assert.equal((await host.query('task.get', { taskId })).status, 'completed', JSON.stringify(host.service.listAlerts()))
      const role = taskId.at(-1)
      assert.equal(await readFile(join(scope.artifactRoot, role + '.txt'), 'utf8'), 'native-' + role)
      assert.equal(await readFile(join(scope.artifactRoot, role + '-fs.txt'), 'utf8'), 'native-fs-' + role)
      await assert.rejects(access(join(root, 'tasks', taskId, 'forbidden.txt')), { code: 'ENOENT' })
    }
    assert.equal(host.toolResults.filter(item => item.name === 'write' && item.result.isError).length, 3, JSON.stringify(host.toolResults))
    assert.equal(host.toolResults.filter(item => item.name === nativeShell && item.result.value?.sandbox?.denied && item.result.value?.exitCode !== 0).length, 3, JSON.stringify(host.toolResults))
  })

for (const denyOutside of [false, true]) test(`one real ingress creates three naturally dependent Tasks whose Owner setup persists one formal artifact root: denyOutside=${denyOutside}`,
  { skip: !available ? reason : false, timeout: 60000 }, async t => {
    const root = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : join(process.cwd(), 'docs', 'tmp'), 'artifact-chain-'))
    let host
    const steps = new Map(), completed = []
    const policyEntry = process.env.DSH_ARTIFACT_POLICY_MODULE
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    host = await nativeTaskHost(root, async (request, h) => {
      const names = request.tools.map(tool => tool.name), input = latestInput(request)
      if (names.includes('group_topic_route_submit')) return [{ name: 'group_topic_route_submit', args: { requestId: input.requestId,
        routes: input.messages.map(message => ({ messageId: message.messageId, messageVersion: message.messageVersion, ignoredRefs: [],
          units: [{ unitKey: 'artifact-team', summary: '三个独立交付按先后处理', sourceRefs: [{ quote: message.text }], dispatchOwner: 'coordination', topics: [], reason: '独立交付依赖' }] })) } }]
      if (names.includes('coordination_submit')) return [{ name: 'coordination_submit', args: { kind: 'arrangement', members: ['alpha', 'beta', 'gamma'].map((key, index, all) => ({
        action: 'new-task', creationKey: key, title: key, objective: `交付${key}材料`, requirements: ['写入团队正式产物目录并核验原文件'], afterTaskIds: index ? [all[index - 1]] : [],
      })) } }]
      const topic = topicTaskCalls(request)
      if (topic) return topic
      if (names.includes('execution_submit')) {
        const execution = (await h.query('execution.list')).find(item => item.status === 'running')
        assert.ok(execution)
        const session = h.ctx.sessions.get(execution.sessionId)
        const bound = h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot')
        assert.ok(bound, 'execution setup must use official artifact binding')
        assert.equal(h.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
        const step = steps.get(execution.executionId) ?? 0
        steps.set(execution.executionId, step + 1)
        if (step === 0) return [{ name: 'write', args: { file_path: join(bound.artifactRoot, 'delegated.txt'), content: 'delegated-native' } }]
        if (step === 1 && denyOutside) return [{ name: 'write', args: { file_path: join(root, 'tasks', execution.taskId, 'delegated-forbidden.txt'), content: 'forbidden' } }]
        if (step === 2 && denyOutside) return [{ name: nativeShell, args: { description: 'Verify delegated shell cannot write outside the shared artifact root', command: process.platform === 'win32'
          ? `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${quote(join(root, 'tasks', execution.taskId, 'delegated-shell-forbidden.txt'))},'forbidden')`
          : `printf 'forbidden' > ${quote(join(root, 'tasks', execution.taskId, 'delegated-shell-forbidden.txt'))}` } }]
        return [{ name: 'execution_submit', args: { output: { status: 'completed', summary: '委派材料与目录外拒绝已核验。', evidence: [], limitations: [], artifacts: [] } } }]
      }
      if (!input.task) return []
      const task = input.task, step = steps.get(task.taskId) ?? 0
      steps.set(task.taskId, step + 1)
      const session = h.ctx.sessions.get(task.sessionId)
      const bound = h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot')
      assert.ok(bound, 'Owner setup must bind through the official native API before model execution')
      assert.equal(bound.ownerId, (await h.query('coordination.list'))[0].id)
      assert.equal(session.header.cwd, join(root, 'tasks', task.taskId))
      const file = join(bound.artifactRoot, task.title + '.txt')
      if (step === 0) return [{ name: 'write', args: { file_path: file, content: task.title + '-material' } }]
      if (step === 1) return [{ name: 'read', args: { file_path: task.title === 'alpha' ? file : join(bound.artifactRoot, task.title === 'beta' ? 'alpha.txt' : 'beta.txt') } }]
      if (task.title === 'alpha' && !input.executions.length) {
        if (!steps.has('delegated')) { steps.set('delegated', 1); return [{ name: 'task_delegate', args: { key: 'artifact-proof', objective: '验证委派成员只写正式共同产物根' } }] }
        return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待委派材料实际核验。', evidence: [], limitations: [] } } }]
      }
      if (task.title === 'alpha' && input.executions.some(execution => execution.status !== 'succeeded' || !execution.drained)) return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '等待委派成员排空。', evidence: [], limitations: [] } } }]
      if (task.title === 'alpha' && denyOutside && input.blockers?.operations?.length) return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '越界拒绝的原操作仍需正式核对，暂不宣称任务完成。', evidence: [], limitations: [] } } }]
      completed.push(task.title)
      return [{ name: 'task_session_submit', args: { decision: { action: 'complete', summary: '材料已实际生成并完成核验。', evidence: [], limitations: [] } } }]
    }, { fsSandbox: true, artifactPolicyEntry: policyEntry, config: { coordination: { enabled: true, provider: 'native-task-test', model: 'controlled' } } })
    await host.service.ingest({ groupId: 'native-group', messageId: 'artifact-chain', senderOpenDingTalkId: 'native-user',
      text: '测试助手，明确新建三个不同任务按顺序交付，全部团队业务产物只放正式共同产物目录。', timestamp: '2026-10-24T01:00:00Z' })
    await host.service.whenIdle()
    if (denyOutside) {
      assert.equal(completed.includes('alpha'), false, JSON.stringify({ alerts: host.service.listAlerts(), operations: await host.query('operation.list') }))
      assert.ok((await host.query('operation.list')).some(operation => operation.state === 'unknown'))
      const [coordination] = await host.query('coordination.list')
      const state = await host.query('coordination.get', { coordinationId: coordination.id })
      assert.deepEqual(state.members.map(member => member.state), ['applied', 'ready', 'ready'])
      for (const member of state.members.slice(1)) assert.ok((await host.query('task.get', { taskId: member.taskId })).coordinationHold)
      assert.equal((await host.query('task.events')).events.length, 0)
      assert.ok(host.toolResults.some(item => item.name === 'write' && item.result.error?.info?.code === 'FS_SANDBOX_DENIED'))
      assert.ok(host.toolResults.some(item => item.name === nativeShell && item.result.value?.sandbox?.denied === true && item.result.value?.exitCode !== 0))
      for (const file of ['delegated-forbidden.txt', 'delegated-shell-forbidden.txt']) await assert.rejects(access(join(root, 'tasks', state.members[0].taskId, file)), { code: 'ENOENT' })
      assert.deepEqual((await host.query('coordination.occurrence.list')).map(occurrence => occurrence.triggerKind), ['message'])
      return
    }
    assert.deepEqual(completed, ['alpha', 'beta', 'gamma'], JSON.stringify({ alerts: host.service.listAlerts(), operations: await host.query('operation.list'), executions: await host.query('execution.list') }))
    const [coordination] = await host.query('coordination.list')
    const state = await host.query('coordination.get', { coordinationId: coordination.id })
    assert.deepEqual(state.members.map(member => member.state), ['fulfilled', 'fulfilled', 'fulfilled'])
    assert.deepEqual((await host.query('coordination.occurrence.list')).map(occurrence => occurrence.triggerKind), ['message', 'business-event', 'business-event'])
    for (const name of completed) assert.equal(await readFile(join(root, 'tasks', coordination.id, 'outputs', name + '.txt'), 'utf8'), name + '-material')
  })
