import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installTaskSessionPersistence } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { taskWorkspace } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { coordinationArtifactScope, bindTaskArtifactScope } from '../packages/dingtalk-dsh-assistant/task-artifact-scope.js'
import { createExecutionSessions } from '../packages/dingtalk-dsh-assistant/execution-session.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import { available, reason, nativeTaskHost, nativeShell, latestInput } from './fixtures/task-session-native-host.js'

const quote = value => `'${value.replaceAll("'", "''")}'`
async function createOwnedFixture(prefix) {
  // Workspace-write also admits platform temp areas. A sibling Task there is
  // not an outside-write probe, so use a disposable root inside this repository.
  const root = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.' + prefix))
  try {
    const canonicalRoot = canonicalPath(root)
    for (const writable of writableRoots({ mode: 'workspace-write', workspaceRoot: root })) {
      if (writable === canonicalRoot) continue
      const path = relative(writable, canonicalRoot)
      assert.ok(path === '..' || path.startsWith('..' + sep) || isAbsolute(path),
        `Artifact fixture must be outside the platform temp grant: ${writable}`)
    }
    if (process.platform !== 'win32') return root
    // Only this freshly created disposable root is assigned to the test user;
    // hosted Windows administrators may otherwise create it owned by their group.
    execFileSync('pwsh', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';$p=${quote(root)};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;$acl.SetOwner($sid);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $p -AclObject $acl;if((Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value-ne$sid.Value){throw 'FIXTURE_OWNER'}`], { windowsHide: true })
    return root
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
test('受信原生完整模式允许原临时Git工作树及MSYS，默认模式保留产物边界',
  { ...({ skip: !available ? reason : process.platform !== 'win32', timeout: 60000 }), timeout: nativeLifecycleTimeout(60000) }, nativeLifecycle(60000, async (t) => {
    const root = await createOwnedFixture('artifact-git-')
    const repository = join(root, 'repository'), checkout = join(root, 'checkout')
    await t.beginBusiness()
    await t.step(async () => mkdir(repository))
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true })
    git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
    git('worktree', 'add', '-qb', 'candidate', checkout)
    await t.step(async () => writeFile(join(checkout, 'candidate.txt'), 'approved fixture'))
    const sh = join(git('--exec-path').trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe')
    const scope = await t.step(async () => coordinationArtifactScope(root, { coordinationId: 'git-team', memberTaskIds: ['publisher'] }))
    const cwd = await t.step(async () => taskWorkspace(root, 'publisher')), steps = new Map()
    const host = await t.step(async () => nativeTaskHost(root, async request => {
      const label = latestInput(request).task.label
      const step = steps.get(label) ?? 0; steps.set(label, step + 1)
      if (step === 0) return [{ name: nativeShell, args: { description: '验证统一产物目录', command: `Set-Content -LiteralPath ${quote(join(scope.artifactRoot, label + '.txt'))} -Value ok` } }]
      if (step === 1) return [{ name: nativeShell, args: { description: '验证真实Git元数据写权限', command: `git -C ${quote(checkout)} add candidate.txt; exit $LASTEXITCODE` } }]
      if (step === 2) return [{ name: nativeShell, args: { description: '验证真实MSYS辅助进程', command: `& ${quote(sh)} -c 'exit 0'; exit $LASTEXITCODE` } }]
      return []
    }, { fsSandbox: true }))
    const handles = []
    const router = await t.step(async () => installTaskSessionPersistence(host.ctx, { root }))
    t.after(async () => { for (const h of handles) await h.dispose(); await host.close(); await rm(root, { recursive: true, force: true }) })
    for (const label of ['default', 'full']) {
      const identity = { taskId: 'publisher', sessionId: 'git-' + label }
      await t.step(async () => router.register({ ...identity, cwd }))
      const handle = await t.step(async () => router.runOwned(identity, () => host.ctx.agents.create({ sessionId: identity.sessionId, meta: { cwd }, agentOptions: { provider: 'native-task-test', model: 'controlled' }, setup: async (ctx, agent) => {
        await host.ctx.agentPresets.mount(ctx, 'native-test')
        setSandboxMode(agent.session, label === 'full' ? 'danger-full-access' : 'workspace-write')
        await bindTaskArtifactScope(ctx, { root, scope, taskId: 'publisher', session: agent.session })
      } })))
      handles.push(handle)
      handle.agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify({ task: { label } }) }] }))
      await t.step(async () => handle.agent.whenIdle())
      const results = host.toolResults.filter(r => r.sessionId === handle.agent.id && r.name === nativeShell)
      assert.equal(results.length, 3, JSON.stringify({ results, all: host.toolResults, requests: host.requests.length, tail: handle.agent.session.snapshotEvents().slice(-3) }))
      assert.equal(results[0].result.value?.exitCode, 0, JSON.stringify(results))
      if (label === 'default') {
        assert.notEqual(results[1].result.value?.exitCode, 0, JSON.stringify(results))
        assert.equal(git('-C', checkout, 'diff', '--cached', '--name-only').trim(), '')
        assert.notEqual(results[2].result.value?.exitCode, 0, JSON.stringify(results))
      } else {
        assert.equal(results[1].result.value?.exitCode, 0, JSON.stringify(results))
        assert.equal(results[2].result.value?.exitCode, 0, JSON.stringify(results))
        assert.equal(git('-C', checkout, 'diff', '--cached', '--name-only').trim(), 'candidate.txt')
      }
      assert.equal(handle.agent.session.header.cwd, cwd)
      assert.equal(host.ctx.sessionProjections.stateOf(handle.agent.session, 'sandboxArtifactRoot').artifactRoot, scope.artifactRoot)
    }
  }))
test('原生Host已授权完整模式在恢复绑定时保留，原生逐次模式与只读模式均不改历史身份',
  { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
    const started = performance.now(), phases = [{ phase: 'begin', elapsedMs: 0 }]
    const mark = phase => phases.push({ phase, elapsedMs: Math.round(performance.now() - started) })
    t.after(() => t.diagnostic('Permission recovery phases: ' + JSON.stringify(phases)))
    const root = await createOwnedFixture('artifact-mode-')
    const host = await nativeTaskHost(root, () => { assert.fail('权限恢复不得调用模型') })
    await t.beginBusiness()

    mark('host-ready')
    let handle
    t.after(async () => { await handle?.dispose(); await host.close(); await rm(root, { recursive: true, force: true }) })
    const taskId = 'historical-owner', sessionId = 'original-owner', cwd = await t.step(async () => taskWorkspace(root, taskId))
    const scope = await t.step(async () => coordinationArtifactScope(root, { coordinationId: 'original-team', memberTaskIds: [taskId] }))
    const router = await t.step(async () => installTaskSessionPersistence(host.ctx, { root })), binding = { taskId, sessionId }
    await t.step(async () => router.register({ ...binding, cwd }))
    handle = await t.step(async () => router.runOwned(binding, () => host.ctx.agents.create({ sessionId, meta: { cwd }, setup: async (_ctx, agent) => {
      setSandboxMode(agent.session, 'danger-full-access')
      host.ctx.sandboxPolicy.bindArtifactRoot(agent.session, { ownerId: scope.ownerId, artifactRoot: scope.artifactRoot })
    } })))
    mark('created')
    await t.step(async () => host.ctx.sessions.flush(handle.agent.session))
    const before = await t.step(async () => inspectSession(host.ctx.sessionPersistence, sessionId))
    await t.step(async () => handle.dispose()); handle = undefined
    mark('disposed')
    handle = await t.step(async () => router.runOwned(binding, () => host.ctx.agents.resume({ resumeSessionId: sessionId, setup: async (ctx, agent) => {
      const session = agent.session, args = { root, scope, taskId, session }
      const seq = session.seq
      await assert.rejects(bindTaskArtifactScope(ctx, { ...args, taskId: 'foreign' }), { code: 'TASK_ARTIFACT_BINDING_INVALID' })
      const other = await coordinationArtifactScope(root, { coordinationId: 'other-team', memberTaskIds: [taskId] })
      await assert.rejects(bindTaskArtifactScope(ctx, { ...args, scope: other }), /ARTIFACT_POLICY_BINDING_CHANGED/)
      assert.equal(session.seq, seq)
      await bindTaskArtifactScope(ctx, args)
      assert.equal(host.ctx.sandboxPolicy.resolve({ session }).mode, 'danger-full-access')
      assert.equal(host.ctx.sandboxPolicy.resolve({ session }).workspaceRoot, scope.artifactRoot)
      assert.equal(host.ctx.sandboxPolicy.resolve({ session, mode: 'danger-full-access' }).mode, 'danger-full-access')
      setSandboxMode(session, 'read-only')
      const readonlySeq = session.seq
      await bindTaskArtifactScope(ctx, args)
      assert.equal(session.seq, readonlySeq)
      assert.equal(host.ctx.sandboxPolicy.resolve({ session }).mode, 'read-only')
    } })))
    mark('resumed')
    await t.step(async () => host.ctx.sessions.flush(handle.agent.session))
    const after = await t.step(async () => inspectSession(host.ctx.sessionPersistence, sessionId))
    mark('readback')
    assert.deepEqual(after.events.slice(0, before.events.length), before.events)
    assert.equal(handle.agent.session.id, sessionId)
    assert.equal(after.meta.cwd, before.meta.cwd)
    assert.deepEqual(after.events.slice(before.events.length).filter(e => e.type === 'sandbox/mode').map(e => e.data.mode), ['read-only'])
    assert.equal(after.events.filter(e => e.type === 'sandbox/mode' && e.data.artifactRoot).length, 1)
    assert.equal(host.requests.length, 0)
  }))
test('official execution artifact binding makes native FS and shell share one root and reject outside writes',
  { ...({ skip: !available ? reason : false, timeout: 60000 }), timeout: nativeLifecycleTimeout(60000) }, nativeLifecycle(60000, async (t) => {
    const root = await createOwnedFixture('artifact-native-')
    await t.beginBusiness()
    const scope = await t.step(async () => coordinationArtifactScope(root, { coordinationId: 'coordination-team', memberTaskIds: ['task-a', 'task-b', 'task-c'] }))
    let host, manager
    const steps = new Map()
    t.after(async () => { await manager?.close(); await host?.close(); await rm(root, { recursive: true, force: true }) })
    const policyEntry = process.env.DSH_ARTIFACT_POLICY_MODULE
    host = await t.step(async () => nativeTaskHost(root, async (request, h) => {
      const { task } = latestInput(request)
      if (!task) return []
      const session = h.ctx.sessions.get(task.sessionId)
      assert.equal(h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot').artifactRoot, scope.artifactRoot)
      assert.equal(h.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
      const step = steps.get(task.taskId) ?? 0
      steps.set(task.taskId, step + 1)
      const role = task.taskId.at(-1), cwd = join(root, 'tasks', task.taskId)
      const shared = join(scope.artifactRoot, role + '.txt')
      const outsideFs = join(cwd, 'forbidden-fs.txt'), outsideShell = join(cwd, 'forbidden-shell.txt')
      if (step === 0) return [{ name: nativeShell, args: { description: 'Write inside the formal artifact root', command: process.platform === 'win32'
        ? `[IO.File]::WriteAllText(${quote(shared)},'native-${role}')`
        : `printf 'native-${role}' > ${quote(shared)}` } }]
      if (step === 1) return [{ name: 'write', args: { file_path: join(scope.artifactRoot, role + '-fs.txt'), content: `native-fs-${role}` } }]
      if (step === 2) return [{ name: 'read', args: { file_path: join(scope.artifactRoot, 'a.txt') } }]
      if (step === 3) return [{ name: 'write', args: { file_path: outsideFs, content: 'forbidden' } }]
      if (step === 4) return [{ name: nativeShell, args: { description: 'Verify shell rejects writing outside artifacts', command: process.platform === 'win32'
        ? `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${quote(outsideShell)},'forbidden')`
        : `printf 'forbidden' > ${quote(outsideShell)}` } }]
      return [{ name: 'execution_submit', args: { output: { answer: 'Scoped native filesystem and shell evidence retained.' } } }]
    }, { resident: true, fsSandbox: true, artifactPolicyEntry: policyEntry }))
    manager = createExecutionSessions({ ctx: host.ctx, isCurrent: async () => true,
      getWorkspaceDir: async ({ binding }) => taskWorkspace(root, binding.taskId), contentRoot: join(root, 'content') })
    for (const taskId of scope.memberTaskIds) {
      const binding = { kind: 'task-execution', taskId, executionId: 'execution-' + taskId, sessionId: 'execution-session-' + taskId,
        requirementRevision: 1, controlRevision: 1, inputVersion: 1, inputHistory: [], inputDigest: taskId, leaseEpoch: 1, sessionBound: false }
      const result = await t.step(async () => manager.run({ binding, input: { task: { taskId, sessionId: binding.sessionId }, artifactScope: scope },
        definition: { provider: 'native-task-test', model: 'controlled', prompt: 'Verify the existing formal artifact binding.', nativeTools: true, allowedTools: [],
          outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
        onSessionBound: async () => {}, onResult: async () => {}, onNativeExecution: async () => ({}) }))
      assert.equal(result.status, 'submitted', JSON.stringify(result))
      assert.ok(host.toolResults.some(item => item.name === nativeShell && item.result.value?.exitCode === 0), JSON.stringify(host.toolResults.filter(item => item.name === nativeShell)))
      const role = taskId.at(-1)
      assert.equal(await t.step(async () => readFile(join(scope.artifactRoot, role + '.txt'), 'utf8')), 'native-' + role)
      assert.equal(await t.step(async () => readFile(join(scope.artifactRoot, role + '-fs.txt'), 'utf8')), 'native-fs-' + role)
      for (const name of ['forbidden-fs.txt', 'forbidden-shell.txt']) {
        const file = join(root, 'tasks', taskId, name)
        await t.step(async () => assert.rejects(access(file), { code: 'ENOENT' }, `Outside file must remain absent: ${file}`))
      }
    }
    assert.equal(host.toolResults.filter(item => item.name === 'write' && item.result.isError).length, 3, JSON.stringify(host.toolResults))
    assert.equal(host.toolResults.filter(item => item.name === nativeShell && item.result.value?.sandbox?.denied && item.result.value?.exitCode !== 0).length, 3, JSON.stringify(host.toolResults))
  }))

// Historical scope is retained by the real upgrade path. New coordination
// commands are never used to create this compatibility fixture.
async function existingScopedTask(root) {
  const dbPath = join(root, 'dynamic.db')
  const store = await openDynamicTaskStore({ dbPath, instanceId: 'native-test', initialize: true })
  try {
    await store.command({ id: 'original-task', kind: 'task.create', args: { taskId: 'A', groupId: 'native-group', ownerActorId: 'native-user',
      title: 'Scoped delivery', request: 'Continue the authorized scoped business work.' } })
  } finally { await store.close() }
  const db = new DatabaseSync(dbPath)
  const put = (table, id, body) => db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(id, JSON.stringify({ id, ...body }))
  try {
    db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
    put('coordination', 'retained-artifacts', { state: 'active', groupId: 'native-group', revision: 1, memberIds: ['original-member'] })
    put('coordination_members', 'original-member', { taskId: 'A', coordinationId: 'retained-artifacts', state: 'applied', control: 'active' })
    put('coordination', 'old-dispatch', { state: 'active', groupId: 'native-group', revision: 1, memberIds: ['old-pending-member'] })
    put('coordination_members', 'old-pending-member', { taskId: 'must-not-create', coordinationId: 'old-dispatch', state: 'prepared',
      createCommand: { kind: 'task.create', args: { taskId: 'must-not-create', groupId: 'native-group', request: 'Retired automatic instruction' } } })
    put('coordination_schedules', 'old-daily', { coordinationId: 'old-dispatch', state: 'active', revision: 1, timezone: 'UTC',
      rule: { kind: 'daily', time: '09:00' }, nextDueAt: '2000-01-01T09:00:00.000Z', action: { kind: 'task-command', instructionIds: ['old-pending-member'] } })
    put('coordination_jobs', 'old-queued-job', { coordinationId: 'old-dispatch', state: 'queued', scheduleId: 'old-daily',
      action: { kind: 'task-command', instructionIds: ['old-pending-member'] } })
  } finally { db.close() }
  return join(root, 'tasks', 'retained-artifacts', 'outputs')
}

async function assertRetiredDispatchFrozen(host) {
  assert.deepEqual((await host.query('task.list')).map(task => task.taskId), ['A'])
  assert.deepEqual(await host.query('coordination.occurrence.list'), [])
  const [schedule] = await host.query('coordination.schedule.list')
  assert.equal(schedule.nextDueAt, '2000-01-01T09:00:00.000Z')
  assert.equal(schedule.state, 'active'); assert.equal(schedule.retirement.kind, 'feature-removed')
  const [job] = await host.query('coordination.job.list')
  assert.equal(job.state, 'queued'); assert.equal(job.retirement.kind, 'feature-removed')
  assert.ok(host.requests.every(request => !request.tools.some(tool => tool.name === 'coordination_submit')))
  assert.equal(host.sent.length, 0)
}

const ownerWait = () => ({ name: 'task_session_submit', args: { decision: { action: 'wait', summary: 'Wait for current scoped execution evidence.', evidence: [], limitations: [] } } })
const ownerComplete = () => ({ name: 'task_session_submit', args: { decision: { action: 'complete', summary: 'Current scoped execution evidence verified.', evidence: [], limitations: [] } } })
const executionComplete = () => ({ name: 'execution_submit', args: { output: { status: 'completed', summary: 'Scoped native operations finished.', evidence: [], limitations: [], artifacts: [] } } })
const shellWrite = (file, text) => ({ name: nativeShell, args: { description: 'Verify the retained artifact boundary', command: process.platform === 'win32'
  ? `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${quote(file)},${quote(text)})`
  : `printf '%s' ${quote(text)} > ${quote(file)}` } })

// Replaces the removed automatic three-Task chain with one current Task whose
// Owner delegates three dependent executions. The native boundary remains real.
for (const denyOutside of [false, true]) test(`one Task Owner preserves retained scope across three ordered executions: denyOutside=${denyOutside}`,
  { ...({ skip: !available ? reason : false, timeout: 60000 }), timeout: nativeLifecycleTimeout(60000) }, nativeLifecycle(60000, async (t) => {
    const root = await createOwnedFixture('artifact-stages-')
    let host, ownerSession
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    const artifactRoot = await t.step(async () => existingScopedTask(root))
    const steps = new Map(), finished = [], bindings = []
    let completionAttempted = false, completionRejectionVerified = false, completionRejection
    const outsideFs = join(root, 'tasks', 'foreign-task', 'outside-fs.txt'), outsideShell = join(root, 'tasks', 'foreign-task', 'outside-shell.txt')
    await t.step(async () => mkdir(join(root, 'tasks', 'foreign-task'), { recursive: true }))
    host = await t.step(async () => nativeTaskHost(root, async (request, h) => {
      const input = latestInput(request), executing = request.tools.some(tool => tool.name === 'execution_submit')
      if (!executing) {
        assert.equal(input.task.taskId, 'A')
        ownerSession ??= input.task.sessionId; assert.equal(input.task.sessionId, ownerSession)
        const owner = h.ctx.sessions.get(ownerSession)
        assert.equal(h.ctx.sessionProjections.stateOf(owner, 'sandboxArtifactRoot').artifactRoot, artifactRoot)
        const executions = input.executions ?? []
        if (executions.some(execution => execution.status !== 'succeeded' || !execution.drained)) return [ownerWait()]
        if (executions.length < 3) {
          const stage = executions.length + 1
          assert.deepEqual(finished, Array.from({ length: stage - 1 }, (_, index) => index + 1))
          return [{ name: 'task_delegate', args: { key: 'scoped-stage-' + stage, objective: 'Scoped stage ' + stage } }, ownerWait()]
        }
        if (denyOutside && input.blockers?.operations?.length) {
          if (!completionAttempted) {
            completionAttempted = true
            const submit = h.ctx.tools.get('task_session_submit', h.ctx.agents.get(ownerSession)), execute = submit.execute
            // Native tool receipts retain Error.message, but omit code for non-HarnessError.
            // Observe the real rejection before serialization, then rethrow it unchanged.
            submit.execute = async (...args) => {
              try { return await execute.apply(submit, args) }
              catch (error) { completionRejection = { code: error.code, message: error.message }; throw error }
              finally { submit.execute = execute }
            }
            return [ownerComplete()]
          }
          assert.equal(completionRejection?.code, 'DYNAMIC_TASK_NOT_QUIESCENT')
          const rejected = h.toolResults.filter(item => item.name === 'task_session_submit' && item.result.isError)
          assert.equal(rejected.length, 1)
          assert.equal(rejected[0].result.error.message, completionRejection.message)
          const unknown = (await h.query('operation.list', { taskId: 'A' })).filter(operation => operation.state === 'unknown')
          assert.ok(unknown.length > 0)
          assert.deepEqual(JSON.parse(rejected[0].result.error.message).operations.filter(operation => operation.state === 'unknown')
            .map(operation => operation.operationId), unknown.map(operation => operation.operationId))
          assert.notEqual((await h.query('task.get', { taskId: 'A' })).status, 'completed')
          completionRejectionVerified = true
          return [ownerWait()]
        }
        return [ownerComplete()]
      }
      const execution = (await h.query('execution.list')).find(item => item.status === 'running')
      assert.ok(execution)
      const stage = Number(execution.input.objective.at(-1)), session = h.ctx.sessions.get(execution.sessionId)
      const bound = h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot')
      assert.equal(bound.artifactRoot, artifactRoot); assert.equal(bound.ownerId, 'retained-artifacts')
      assert.equal(h.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
      bindings.push({ taskId: execution.taskId, root: bound.artifactRoot, cwd: session.header.cwd })
      const step = steps.get(execution.executionId) ?? 0; steps.set(execution.executionId, step + 1)
      if (step === 0) return [{ name: 'write', args: { file_path: join(artifactRoot, `stage-${stage}.txt`), content: `stage-${stage}` } }]
      if (step === 1) return [shellWrite(join(artifactRoot, `stage-${stage}-shell.txt`), `shell-${stage}`)]
      if (step === 2) return [{ name: 'read', args: { file_path: join(artifactRoot, `stage-${Math.max(1, stage - 1)}.txt`) } }]
      if (stage === 3 && denyOutside && step === 3) return [{ name: 'write', args: { file_path: outsideFs, content: 'forbidden' } }]
      if (stage === 3 && denyOutside && step === 4) return [shellWrite(outsideShell, 'forbidden')]
      finished.push(stage)
      return [executionComplete()]
    }, { fsSandbox: true, initialize: false }))
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    assert.deepEqual(finished, [1, 2, 3], JSON.stringify(host.service.listAlerts()))
    const executions = await t.step(async () => host.query('execution.list', { taskId: 'A' }))
    assert.equal(executions.length, 3); assert.ok(executions.every(execution => execution.status === 'succeeded' && execution.drained))
    assert.ok(bindings.length > 0 && bindings.every(binding => binding.taskId === 'A' && binding.root === artifactRoot && binding.cwd === join(root, 'tasks', 'A')))
    for (const stage of [1, 2, 3]) {
      assert.equal(await t.step(async () => readFile(join(artifactRoot, `stage-${stage}.txt`), 'utf8')), `stage-${stage}`)
      assert.equal(await t.step(async () => readFile(join(artifactRoot, `stage-${stage}-shell.txt`), 'utf8')), `shell-${stage}`)
    }
    assert.ok(host.toolResults.filter(item => item.name === 'read').every(item => !item.result.isError))
    for (const file of [outsideFs, outsideShell]) await t.step(async () => assert.rejects(access(file), { code: 'ENOENT' }, `Outside file must remain absent: ${file}`))
    const task = await t.step(async () => host.query('task.get', { taskId: 'A' }))
    if (denyOutside) {
      assert.equal(completionAttempted, true)
      assert.equal(completionRejectionVerified, true)
      assert.equal(completionRejection?.code, 'DYNAMIC_TASK_NOT_QUIESCENT')
      assert.equal(task.lastDecision?.action, 'wait')
      const submissions = host.toolResults.filter(item => item.name === 'task_session_submit' && item.sessionId === ownerSession)
      assert.equal(submissions.filter(item => item.result.isError).length, 1)
      assert.equal(submissions.at(-1).result.isError, false)
      assert.equal(host.toolResults.filter(item => item.name === 'write' && item.result.isError).length, 1)
      assert.equal(host.toolResults.filter(item => item.name === nativeShell && item.result.value?.sandbox?.denied && item.result.value?.exitCode !== 0).length, 1)
      assert.ok((await t.step(async () => host.query('operation.list', { taskId: 'A' }))).some(operation => operation.state === 'unknown'))
      assert.notEqual(task.status, 'completed')
    } else assert.equal(task.status, 'completed', JSON.stringify(task))
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    assert.equal((await t.step(async () => host.query('execution.list', { taskId: 'A' }))).length, 3)
    await t.step(async () => assertRetiredDispatchFrozen(host))
  }))

test('explicit Task reopen preserves original Owner, retained artifact scope and prior files while old daily dispatch stays retired',
  { ...({ skip: !available ? reason : false, timeout: 60000 }), timeout: nativeLifecycleTimeout(60000) }, nativeLifecycle(60000, async (t) => {
    const root = await createOwnedFixture('artifact-reopen-')
    let host, ownerSession
    t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }) })
    await t.beginBusiness()
    const artifactRoot = await t.step(async () => existingScopedTask(root))
    const steps = new Map(), bindings = []
    const outsideFs = join(root, 'tasks', 'foreign-task', 'reopen-fs.txt'), outsideShell = join(root, 'tasks', 'foreign-task', 'reopen-shell.txt')
    await t.step(async () => mkdir(join(root, 'tasks', 'foreign-task'), { recursive: true }))
    host = await t.step(async () => nativeTaskHost(root, async (request, h) => {
      const input = latestInput(request), executing = request.tools.some(tool => tool.name === 'execution_submit')
      if (!executing) {
        const task = input.task, round = task.runSequence
        ownerSession ??= task.sessionId; assert.equal(task.sessionId, ownerSession)
        const session = h.ctx.sessions.get(ownerSession)
        assert.equal(h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot').artifactRoot, artifactRoot)
        const current = input.executions.filter(execution => execution.requirementRevision === task.requirementRevision)
        if (!current.length) return [{ name: 'task_delegate', args: { key: 'explicit-round-' + round, objective: 'Explicit round ' + round } }, ownerWait()]
        if (current.some(execution => execution.status !== 'succeeded' || !execution.drained) || input.blockers?.operations?.length) return [ownerWait()]
        return [ownerComplete()]
      }
      const execution = (await h.query('execution.list')).find(item => item.status === 'running')
      assert.ok(execution)
      const round = Number(execution.input.objective.at(-1)), session = h.ctx.sessions.get(execution.sessionId)
      const bound = h.ctx.sessionProjections.stateOf(session, 'sandboxArtifactRoot')
      assert.equal(bound.artifactRoot, artifactRoot); assert.equal(bound.ownerId, 'retained-artifacts')
      assert.equal(h.ctx.sandboxPolicy.resolve({ session }).mode, 'workspace-write')
      bindings.push({ round, taskId: execution.taskId, root: bound.artifactRoot, cwd: session.header.cwd })
      const step = steps.get(execution.executionId) ?? 0; steps.set(execution.executionId, step + 1)
      if (step === 0) return [{ name: 'write', args: { file_path: join(artifactRoot, `round-${round}.txt`), content: `round-${round}` } }]
      if (step === 1) return [shellWrite(join(artifactRoot, `round-${round}-shell.txt`), `shell-${round}`)]
      if (step === 2) return [{ name: 'read', args: { file_path: join(artifactRoot, 'round-1.txt') } }]
      if (round === 2 && step === 3) return [{ name: 'write', args: { file_path: outsideFs, content: 'forbidden' } }]
      if (round === 2 && step === 4) return [shellWrite(outsideShell, 'forbidden')]
      return [executionComplete()]
    }, { fsSandbox: true, initialize: false }))
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    const completed = await t.step(async () => host.query('task.get', { taskId: 'A' })), originalExecutions = await t.step(async () => host.query('execution.list', { taskId: 'A' }))
    assert.equal(completed.status, 'completed', JSON.stringify(host.service.listAlerts()))
    assert.equal(originalExecutions.length, 1)
    for (let attempt = 0; attempt < 2; attempt++) { await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle()) }
    assert.deepEqual(await t.step(async () => host.query('execution.list', { taskId: 'A' })), originalExecutions)
    await t.step(async () => assertRetiredDispatchFrozen(host))
    const reopen = { id: 'explicit-reopen', kind: 'task.reopen', args: { taskId: 'A', request: 'Explicitly authorize the second scoped round; retain prior evidence.',
      expectedRequirementRevision: completed.requirementRevision, expectedControlRevision: completed.controlRevision } }
    await t.step(async () => host.service.store.command(reopen))
    assert.equal((await t.step(async () => host.service.store.command(reopen))).replayed, true)
    await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
    const current = await t.step(async () => host.query('task.get', { taskId: 'A' })), executions = await t.step(async () => host.query('execution.list', { taskId: 'A' }))
    assert.equal(current.sessionId, completed.sessionId); assert.equal(current.runSequence, completed.runSequence + 1)
    assert.equal(current.requirementRevision, completed.requirementRevision + 1)
    assert.equal(executions.length, 2); assert.deepEqual(executions.find(execution => execution.executionId === originalExecutions[0].executionId), originalExecutions[0])
    assert.ok(bindings.some(binding => binding.round === 1)); assert.ok(bindings.some(binding => binding.round === 2))
    assert.ok(bindings.every(binding => binding.taskId === 'A' && binding.root === artifactRoot && binding.cwd === join(root, 'tasks', 'A')))
    for (const round of [1, 2]) {
      assert.equal(await t.step(async () => readFile(join(artifactRoot, `round-${round}.txt`), 'utf8')), `round-${round}`)
      assert.equal(await t.step(async () => readFile(join(artifactRoot, `round-${round}-shell.txt`), 'utf8')), `shell-${round}`)
    }
    for (const file of [outsideFs, outsideShell]) await t.step(async () => assert.rejects(access(file), { code: 'ENOENT' }, `Outside file must remain absent: ${file}`))
    assert.equal(host.toolResults.filter(item => item.name === 'write' && item.result.isError).length, 1)
    assert.equal(host.toolResults.filter(item => item.name === nativeShell && item.result.value?.sandbox?.denied && item.result.value?.exitCode !== 0).length, 1)
    assert.ok((await t.step(async () => host.query('operation.list', { taskId: 'A' }))).some(operation => operation.state === 'unknown'))
    assert.notEqual(current.status, 'completed')
    await t.step(async () => assertRetiredDispatchFrozen(host))
  }))
