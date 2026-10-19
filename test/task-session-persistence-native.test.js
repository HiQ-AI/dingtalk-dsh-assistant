import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { taskDirectories, taskWorkspace, taskExecutionWorkspace, taskFilePath } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import { installTaskSessionPersistence, registerTaskSessionPersistence, taskSessionLogRoot } from '../packages/dingtalk-dsh-assistant/task-session-persistence.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { findSessionLog } from './fixtures/session-persistence.js'

const run = promisify(execFile)
const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const test = process.argv[2] === '--task-native-child' ? () => {} : testRunner
const artifacts = resolve('docs/tmp/task-session-native-persistence')
async function temporary() { await mkdir(artifacts, { recursive: true }); return mkdtemp(join(artifacts, 'run-')) }
const message = text => createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text }] })

async function host(root) {
  const ctx = new Context(), requests = [], handles = [], actualCwds = []
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'legacy-sessions'), compression: 'none' })
  // Install the native factory first. A scoped ctx replacement would NOT redirect this factory.
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const identity = ctx.sessionPersistence.identity
  const router = await installTaskSessionPersistence(ctx, { root })
  assert.equal(ctx.sessionPersistence.identity, identity)
  class Model extends LlmAdapter {
    async *stream(request) {
      requests.push(structuredClone(request))
      if (request.messages.at(-1)?.role === 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'native probe finished' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native probe finished' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        const id = 'probe-' + requests.length
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'actual_cwd_probe', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'actual_cwd_probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
  }
  ctx.llm.registerAdapter(['task-native-fixture'], new Model())
  ctx.tools.register({ name: 'actual_cwd_probe', description: 'Run a real process in the session cwd', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(_args, execution) {
      const session = execution.agent.session
      const { stdout } = await run(process.execPath, ['-e', 'require("fs").writeFileSync("cwd-proof-"+process.argv[1]+".txt",process.argv[1]); process.stdout.write(process.cwd())', session.id], { cwd: session.header.cwd })
      actualCwds.push({ sessionId: session.id, cwd: stdout })
      return { cwd: stdout, sessionId: session.id }
    },
  })
  async function create(taskId, sessionId, execution = false) {
    const cwd = execution ? await taskExecutionWorkspace(root, taskId, sessionId) : await taskWorkspace(root, taskId)
    await registerTaskSessionPersistence(ctx, { taskId, sessionId, cwd })
    const handle = await router.runOwned({ taskId, sessionId }, () => ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider: 'task-native-fixture', model: 'fixture' } }))
    handles.push(handle); return handle.agent
  }
  async function resume(sessionId) {
    // No registration call: restart must recover routing solely from the durable binding index.
    const saved = await inspectSession(ctx.sessionPersistence, sessionId)
    const taskId = relative(join(root, 'tasks'), saved.meta.cwd).split(/[\\/]/u)[0]
    const handle = await router.runOwned({ taskId, sessionId }, () => ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'task-native-fixture', model: 'fixture' } }))
    handles.push(handle); return handle.agent
  }
  return { ctx, router, requests, actualCwds, create, resume, async createLog(header, options) {
    const taskId = relative(join(root, 'tasks'), header.cwd).split(/[\\/]/u)[0]
    if (!taskId || taskId === '..') return ctx.sessionPersistence.create(header, options)
    const activeRouter = await installTaskSessionPersistence(ctx, { root })
    return activeRouter.runOwned({ taskId, sessionId: header.id }, () => ctx.sessionPersistence.create(header, options))
  }, async close() {
    for (const handle of handles) await handle.dispose()
    await router.close(); await ctx.fiber.dispose()
  } }
}

test('task folders include shared materials/outputs and isolated execution cwd without moving legacy folders', async () => {
  const root = await temporary()
  const old = join(root, 'session-workspaces', '任务执行'); await mkdir(old, { recursive: true }); await writeFile(join(old, 'history.txt'), 'untouched')
  const paths = await taskDirectories(root, 'task-1')
  assert.deepEqual(Object.keys(paths).sort(), ['logicalTaskId', 'root', 'materials', 'outputs', 'tmp', 'work'].sort())
  const owner = await taskWorkspace(root, 'task-1'), a = await taskExecutionWorkspace(root, 'task-1', 'execution-a'), b = await taskExecutionWorkspace(root, 'task-1', 'execution-b')
  assert.equal(owner, join(root, 'tasks', 'task-1'))
  assert.equal(a, owner); assert.equal(b, owner)
  assert.equal(taskFilePath(root, 'task-1', 'materials', 'input.txt'), join(paths.materials, 'input.txt'))
  assert.equal(await readFile(join(old, 'history.txt'), 'utf8'), 'untouched')
  await assert.rejects(taskExecutionWorkspace(root, 'task-1', '../escape'), /TASK_DIRECTORY_INVALID/)
})

test('native AgentLoop and live flush write each task log only to its task while same-task real parallel subprocesses share cwd and other tasks stay isolated', { timeout: 15000 }, async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const agents = await Promise.all([h.create('task-a', 'owner-a'), h.create('task-a', 'exec-a', true), h.create('task-a', 'exec-b', true), h.create('task-b', 'owner-b')])
  for (const agent of agents) agent.followup(message('WORK_FOR_' + agent.id))
  await Promise.all(agents.map(agent => agent.whenIdle()))
  await h.ctx.sessionPersistence.flush()
  assert.equal(h.actualCwds.length, 4)
  assert.equal(new Set(h.actualCwds.filter(value => value.sessionId !== 'owner-b').map(value => value.cwd)).size, 1)
  assert.notEqual(h.actualCwds.find(value => value.sessionId === 'owner-b').cwd, h.actualCwds.find(value => value.sessionId === 'owner-a').cwd)
  assert.equal((await h.ctx.sessionPersistence.list()).length, 4)
  for (const agent of agents) {
    const taskId = agent.id === 'owner-b' ? 'task-b' : 'task-a'
    const saved = await inspectSession(h.ctx.sessionPersistence, agent.id)
    assert.equal(saved.meta.cwd, agent.session.header.cwd)
    assert.equal(h.actualCwds.find(value => value.sessionId === agent.id).cwd, saved.meta.cwd)
    assert.equal(await readFile(join(saved.meta.cwd, 'cwd-proof-' + agent.id + '.txt'), 'utf8'), agent.id)
    assert.ok(saved.events.some(event => event.type === 'tool/result'))
    assert.ok((await findSessionLog(root, agent.id)).startsWith(taskSessionLogRoot(root, taskId)))
    assert.equal((await h.ctx.sessionPersistence.stat(agent.id)).header.cwd, saved.meta.cwd)
    await assert.rejects(h.router.runOwned({ taskId, sessionId: agent.id }, () => h.ctx.sessionPersistence.open(agent.id, 'write')), { name: 'SessionAlreadyOwnedError' })
  }
  assert.equal((await readdir(join(root, 'legacy-sessions')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).length, 0)
})

test('durable registration precedes session creation, survives router close/reinstall and rejects cwd or task rebinding', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const cwd = await taskWorkspace(root, 'task-a')
  await h.router.register({ taskId: 'task-a', sessionId: 'not-yet-created', cwd })
  assert.equal(await h.ctx.sessionPersistence.stat('not-yet-created'), undefined)
  await h.router.close()
  const next = await installTaskSessionPersistence(h.ctx, { root })
  t.after(() => next.close())
  const session = h.ctx.sessions.prepare('not-yet-created', { meta: { cwd } })
  const writer = await h.createLog(session.header)
  await writer.flush(); await writer.close()
  assert.equal((await h.ctx.sessionPersistence.stat(session.id)).header.cwd, cwd)
  await assert.rejects(next.register({ taskId: 'task-b', sessionId: session.id, cwd: await taskWorkspace(root, 'task-b') }), { code: 'TASK_SESSION_BINDING_CONFLICT' })
  await assert.rejects(h.createLog({ ...session.header, cwd: root }), { code: 'TASK_SESSION_CWD_MISMATCH' })
  const unbound = h.ctx.sessions.prepare('unregistered', { meta: { cwd } })
  await assert.rejects(h.createLog(unbound.header), { code: 'TASK_SESSION_BINDING_REQUIRED' })
})

test('legacy records are inspectable but cannot be silently adopted into task persistence', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const legacy = h.ctx.sessions.prepare('legacy', { meta: { cwd: root } })
  const writer = await h.createLog(legacy.header)
  await writer.flush(); await writer.close()
  const path = await findSessionLog(root, 'legacy'), before = await readFile(path)
  await assert.rejects(h.router.register({ taskId: 'task-a', sessionId: 'legacy', cwd: await taskWorkspace(root, 'task-a') }), { code: 'TASK_SESSION_LEGACY_LOCATION' })
  assert.equal((await inspectSession(h.ctx.sessionPersistence, 'legacy')).meta.cwd, root)
  assert.deepEqual(await readFile(path), before)
  assert.equal((await h.ctx.sessionPersistence.list()).length, 1)
})

test('concurrent installation and conflicting registrations keep one native routing owner and immutable durable task binding', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  await h.router.close()
  const [a, b] = await Promise.all([installTaskSessionPersistence(h.ctx, { root }), installTaskSessionPersistence(h.ctx, { root })])
  assert.equal(a, b)
  const cwdA = await taskWorkspace(root, 'task-a'), cwdB = await taskWorkspace(root, 'task-b')
  const registrations = await Promise.allSettled([
    a.register({ taskId: 'task-a', sessionId: 'one-id', cwd: cwdA }),
    b.register({ taskId: 'task-b', sessionId: 'one-id', cwd: cwdB }),
  ])
  assert.equal(registrations.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(registrations.find(result => result.status === 'rejected').reason.code, 'TASK_SESSION_BINDING_CONFLICT')
  const winner = registrations.find(result => result.status === 'fulfilled').value
  const session = h.ctx.sessions.prepare('one-id', { meta: { cwd: winner.cwd } })
  const writer = await h.createLog(session.header)
  await writer.flush(); await writer.close()
  await a.close()
  const next = await installTaskSessionPersistence(h.ctx, { root })
  assert.equal((await h.ctx.sessionPersistence.stat('one-id')).header.cwd, winner.cwd)
  assert.equal((await h.ctx.sessionPersistence.list()).length, 1)
  await next.close()
})

test('cancelled native persistence calls retain their abort reason and never create a session', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const cwd = await taskWorkspace(root, 'task-a')
  await h.router.register({ taskId: 'task-a', sessionId: 'cancelled', cwd })
  const session = h.ctx.sessions.prepare('cancelled', { meta: { cwd } })
  const signal = AbortSignal.abort(new Error('test abort'))
  for (const operation of [
    () => h.createLog(session.header, { signal }),
    () => h.ctx.sessionPersistence.open(session.id, 'read', { signal }),
    () => h.ctx.sessionPersistence.stat(session.id, { signal }),
    () => h.ctx.sessionPersistence.list({ signal }),
  ]) await assert.rejects(operation(), error => error === signal.reason)
  assert.equal(await h.ctx.sessionPersistence.stat(session.id), undefined)
})

test('task and log directory links fail before creating anything outside the configured root', async t => {
  const root = await temporary(), outside = await temporary(), h = await host(root); t.after(() => h.close())
  const directories = await taskDirectories(root, 'task-a')
  await symlink(outside, join(directories.root, '.dsh'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(h.router.register({ taskId: 'task-a', sessionId: 'owner-a', cwd: directories.work }), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  assert.deepEqual(await readdir(outside), [])
})

for (const replaced of ['root', 'project', 'session', 'log']) test(`cached native backend rejects a replaced ${replaced} link at every persistence public entry point`, async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const cwd = await taskWorkspace(root, 'task-a')
  await h.router.register({ taskId: 'task-a', sessionId: 'before', cwd })
  await h.router.register({ taskId: 'task-a', sessionId: 'after', cwd })
  const session = h.ctx.sessions.prepare('before', { meta: { cwd } })
  const writer = await h.createLog(session.header)
  await writer.flush(); await writer.close()
  const log = await findSessionLog(root, 'before'), before = await readFile(log)
  const selected = replaced === 'root' ? taskSessionLogRoot(root, 'task-a') : replaced === 'project' ? dirname(dirname(log)) : replaced === 'session' ? dirname(log) : log
  const outside = join(root, 'outside-' + replaced)
  await rename(selected, outside)
  // Windows 最终日志路径使用无特权 junction；文件 symlink 仍由 POSIX 覆盖。
  const windowsLogLink = replaced === 'log' && process.platform === 'win32'
  const linkTarget = windowsLogLink ? join(root, 'outside-log-directory') : outside
  if (windowsLogLink) await mkdir(linkTarget)
  await symlink(linkTarget, selected, process.platform === 'win32' ? 'junction' : replaced === 'log' ? 'file' : 'dir')
  const nextHeader = h.ctx.sessions.prepare('after', { meta: { cwd } }).header
  for (const operation of [
    () => h.router.register({ taskId: 'task-a', sessionId: 'new-binding', cwd }),
    () => h.createLog(nextHeader),
    () => h.ctx.sessionPersistence.open('before', 'read'),
    () => h.router.runOwned({ taskId: 'task-a', sessionId: 'before' }, () => h.ctx.sessionPersistence.open('before', 'write')),
    () => h.ctx.sessionPersistence.stat('before'),
    () => h.ctx.sessionPersistence.list(),
  ]) await assert.rejects(operation(), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  await assert.rejects(h.ctx.sessionPersistence.flush(), error => error instanceof AggregateError
    && error.errors.some(item => /TASK_DIRECTORY_OUTSIDE_ROOT/.test(item.message)))
  assert.deepEqual(await readFile(replaced === 'log' ? outside : log), before)
  if (windowsLogLink) assert.deepEqual(await readdir(linkTarget), [])
  if (replaced !== 'log') assert.ok(!(await readdir(outside, { recursive: true })).some(path => path.includes('after') || path.includes('new-binding')))
})

test('cached task routes reject a replaced routing-index directory before registration or native access', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const cwd = await taskWorkspace(root, 'task-a')
  await h.router.register({ taskId: 'task-a', sessionId: 'cached', cwd })
  const index = join(root, 'tasks', '.session-routes'), outside = join(root, 'outside-index')
  await rename(index, outside); await symlink(outside, index, process.platform === 'win32' ? 'junction' : 'dir')
  const entries = await readdir(outside)
  await assert.rejects(h.router.register({ taskId: 'task-a', sessionId: 'new-binding', cwd }), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  await assert.rejects(h.ctx.sessionPersistence.stat('cached'), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  await assert.rejects(h.ctx.sessionPersistence.flush(), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  assert.deepEqual(await readdir(outside), entries)
})

async function processPhase(root, phase) {
  const h = await host(root)
  try {
    const writing = phase === 'write' || phase === 'crash-write'
    const agent = writing ? await h.create('durable-task', 'durable-owner') : await h.resume('durable-owner')
    agent.followup(message(writing ? 'ORIGINAL_HISTORY_MARKER' : 'RESUME_AFTER_COMPACTION'))
    await agent.whenIdle()
    if (writing) {
      const nodes = agent.session.surface.nodes.slice(1)
      agent.session.append('user/message', message('NATIVE_COMPACTION_SUMMARY'), {
        sourceEventSeqs: nodes,
        surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) },
      })
      appendPluginRecord(agent.session, 'plugin:dingtalk/native-persistence-proof', { taskId: 'durable-task' })
    }
    await h.ctx.sessions.flush(agent.session)
    await writeFile(join(root, phase + '.json'), JSON.stringify({ pid: process.pid, saved: await inspectSession(h.ctx.sessionPersistence, agent.id), requests: h.requests, actualCwds: h.actualCwds }))
    if (phase === 'crash-write') process.exit(73) // No agent, router, writer or Context teardown.
  } finally { await h.close() }
}

test('unclean native process exit resumes original task session with compaction preserved and no global duplicate log', { timeout: 20000 }, async () => {
  const root = await temporary(), self = fileURLToPath(import.meta.url)
  await assert.rejects(run(process.execPath, [self, '--task-native-child', root, 'crash-write'], { timeout: 15000 }), { code: 73 })
  await run(process.execPath, [self, '--task-native-child', root, 'resume'], { timeout: 15000 })
  const first = JSON.parse(await readFile(join(root, 'crash-write.json'), 'utf8')), next = JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'))
  assert.notEqual(first.pid, next.pid)
  assert.equal(next.saved.meta.cwd, first.saved.meta.cwd)
  assert.deepEqual(next.saved.events.slice(0, first.saved.events.length), first.saved.events)
  assert.ok(next.saved.events.some(event => event.surfaceOp?.op === 'replace'))
  assert.ok(JSON.stringify(next.saved.events).includes('ORIGINAL_HISTORY_MARKER'))
  assert.ok(JSON.stringify(next.requests[0]).includes('NATIVE_COMPACTION_SUMMARY'))
  assert.ok(!JSON.stringify(next.requests[0]).includes('ORIGINAL_HISTORY_MARKER'))
  assert.equal(next.actualCwds[0].cwd, first.saved.meta.cwd)
  assert.ok((await findSessionLog(root, 'durable-owner')).startsWith(taskSessionLogRoot(root, 'durable-task')))
})

if (process.argv[2] === '--task-native-child') await processPhase(process.argv[3], process.argv[4])


test('registered task writers require exact active Host scope while readonly access and unrelated legacy sessions remain available', async t => {
  const root = await temporary(), h = await host(root); t.after(() => h.close())
  const cwd = await taskWorkspace(root, 'scope-task')
  for (const sessionId of ['owned-a', 'owned-b']) await h.router.register({ taskId: 'scope-task', sessionId, cwd })
  const header = h.ctx.sessions.prepare('owned-a', { meta: { cwd } }).header
  await assert.rejects(h.ctx.sessionPersistence.create(header), { code: 'TASK_SESSION_HOST_WRITER_REQUIRED' })
  await assert.rejects(h.router.runOwned({ taskId: 'scope-task', sessionId: 'owned-b' }, () => h.ctx.sessionPersistence.create(header)), { code: 'TASK_SESSION_HOST_WRITER_REQUIRED' })
  await assert.rejects(h.router.runOwned({ taskId: 'wrong-task', sessionId: 'owned-a' }, () => h.ctx.sessionPersistence.create(header)), { code: 'TASK_SESSION_BINDING_REQUIRED' })
  const writer = await h.router.runOwned({ taskId: 'scope-task', sessionId: 'owned-a' }, () => h.ctx.sessionPersistence.create(header))
  await writer.flush(); await writer.close()
  const reader = await h.ctx.sessionPersistence.open('owned-a', 'read'); await reader.close()
  await assert.rejects(h.ctx.sessionPersistence.open('owned-a', 'write'), { code: 'TASK_SESSION_HOST_WRITER_REQUIRED' })
  const gate = Promise.withResolvers()
  let detached
  await h.router.runOwned({ taskId: 'scope-task', sessionId: 'owned-a' }, async () => { detached = gate.promise.then(() => h.ctx.sessionPersistence.open('owned-a', 'write')) })
  gate.resolve()
  await assert.rejects(detached, { code: 'TASK_SESSION_HOST_WRITER_REQUIRED' })
  const legacy = h.ctx.sessions.prepare('legacy-unbound', { meta: { cwd: root } })
  const legacyWriter = await h.ctx.sessionPersistence.create(legacy.header); await legacyWriter.close()
})
