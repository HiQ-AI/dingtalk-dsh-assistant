import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { openExecutionRuntime, apply } from '../packages/dingtalk-dsh-assistant/execution.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const file = fileURLToPath(import.meta.url)
const fixtureRoot = resolve('docs/tmp/execution-runtime-native')
const workflow = { id: 'native', version: '1', nodes: [
  { id: 'reason', version: '1', executor: 'agent', allowedEffects: ['read'], allowedTools: [],
    inputSchema: { type: 'string' }, outputSchema: { type: 'number' }, mapInput: ({ requirement }) => requirement,
    provider: 'm1-synthetic', model: 'scripted', prompt: '提交数字7，仅验证生命周期。', maxSteps: 3, timeoutMs: 5000 },
  { id: 'calculate', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
    mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => input * 2 },
] }

async function nativeHost(root, mode) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  class Model extends LlmAdapter {
    async *stream(options) {
      requests.push(JSON.parse(JSON.stringify(options)))
      if (mode === 'initial') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'M1_PERSISTED_WAIT_MARKER' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'M1_PERSISTED_WAIT_MARKER' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        const args = JSON.stringify({ output: 7 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'submit', name: 'execution_node_submit', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'submit', name: 'execution_node_submit', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
  }
  ctx.llm.registerAdapter(['m1-synthetic'], new Model())
  return { ctx, requests }
}

async function phase(root, mode) {
  const { ctx, requests } = await nativeHost(root, mode)
  const runtime = await openExecutionRuntime({ ctx, dbPath: join(root, 'control.db'), instanceId: 'm1-integration',
    artifactDirectory: join(root, 'artifacts'), initialize: mode !== 'resume', workflows: [workflow] })
  try {
    if (mode === 'crash-before-bind') {
      const flush = ctx.sessions.flush.bind(ctx.sessions)
      ctx.sessions.flush = async session => {
        await flush(session)
        const state = await runtime.controller.state('run')
        await writeFile(join(root, 'crash-ready.json'), JSON.stringify({ pid: process.pid, state }))
        await new Promise(() => {})
      }
    }
    if (mode === 'crash-before-commit') {
      const put = runtime.artifacts.put
      runtime.artifacts.put = async value => {
        const artifact = await put(value)
        if (value === 7) {
          await writeFile(join(root, 'crash-ready.json'), JSON.stringify({ pid: process.pid, artifact, state: await runtime.controller.state('run') }))
          await new Promise(() => {})
        }
        return artifact
      }
    }
    if (mode === 'resume') {
      const before = await runtime.controller.state('run')
      assert.equal(before.run.status, 'waiting')
      assert.equal(requests.length, 0)
      await runtime.controller.recover({ commandId: 'resume', runId: 'run' })
    } else {
      await runtime.controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'native', input: '固定输入' })
    }
    const state = await runtime.controller.whenIdle('run')
    const session = await ctx.sessionPersistence.inspect(state.nodes[0].sessionId)
    await writeFile(join(root, `${mode}.json`), JSON.stringify({ pid: process.pid, state, requests, session,
      finalOutput: state.run.status === 'succeeded' ? await runtime.artifacts.read(state.nodes[1].outputRef) : null }))
  } finally { await runtime.close(); await ctx.fiber.dispose() }
}

async function run(root, mode, kill = false) {
  const child = spawn(process.execPath, [file, '--m1-native-child', root, mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes }); child.stdout.resume()
  const done = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    if (kill) {
      let ready
      for (let i = 0; i < 200 && child.exitCode === null; i++) {
        ready = await readFile(join(root, 'crash-ready.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error })
        if (ready) break
        await delay(25)
      }
      assert.ok(ready, stderr)
      assert.equal(ready.pid, child.pid)
      child.kill('SIGKILL'); await done
      return ready
    }
    const exit = await done
    assert.equal(exit.code, 0, stderr)
    return JSON.parse(await readFile(join(root, `${mode}.json`), 'utf8'))
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await done } }
}

if (process.argv[2] === '--m1-native-child') {
  await phase(process.argv[3], process.argv[4])
} else {
  for (const mode of ['initial', 'crash-before-bind', 'crash-before-commit']) {
    test(`正式Controller+SQLite+原生JSONL跨进程组合恢复：${mode}`, { timeout: 25000 }, async () => {
      await mkdir(fixtureRoot, { recursive: true })
      const root = await mkdtemp(join(fixtureRoot, 'run-'))
      const before = await run(root, mode, mode !== 'initial')
      assert.equal(before.state.nodes[0].sessionBound, mode !== 'crash-before-bind')
      const resumed = await run(root, 'resume')
      assert.notEqual(resumed.pid, before.pid)
      assert.equal(resumed.state.nodes[0].sessionId, before.state.nodes[0].sessionId)
      assert.equal(resumed.state.nodes[0].leaseEpoch, 2)
      assert.equal(resumed.state.nodes[0].inputDigest, before.state.nodes[0].inputDigest)
      assert.equal(resumed.state.run.status, 'succeeded')
      assert.equal(resumed.finalOutput, 14)
      assert.equal(resumed.requests.length, 1)
      if (mode === 'initial') assert.ok(JSON.stringify(resumed.requests).includes('M1_PERSISTED_WAIT_MARKER'))
      assert.equal(resumed.session.events.filter(e => e.type === 'dingtalk/execution-session').length, 1)
    })
  }

  test('实际Cordis apply注册执行服务，fiber dispose关闭存储并释放独占锁', { timeout: 15000 }, async t => {
    await mkdir(fixtureRoot, { recursive: true })
    const root = await mkdtemp(join(fixtureRoot, 'apply-'))
    const config = { dbPath: join(root, 'control.db'), instanceId: 'm1-apply', artifactDirectory: join(root, 'artifacts'), initialize: false }
    // 初始化与普通启动分离，实际 apply 路径不得暗中建新数据库或工件根。
    const initialized = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: true })
    try { await openExecutionArtifacts({ directory: config.artifactDirectory, initialize: true }) }
    finally { await initialized.close() }
    const { ctx, requests } = await nativeHost(root, 'apply')
    let reopened
    t.after(async () => { await ctx.fiber.dispose(); await reopened?.close() })
    ctx.provide('executionWorkflows', [workflow])
    await apply(ctx, config)
    const runtime = ctx.execution
    assert.equal(ctx.get('execution'), runtime)
    assert.ok(runtime.controller)
    await runtime.controller.createRun({ commandId: 'apply-create', taskId: 'apply-task', runId: 'apply-run', workflowId: 'native', input: '入口验证' })
    const completed = await runtime.controller.whenIdle('apply-run')
    assert.equal(completed.run.status, 'succeeded')
    assert.equal(await runtime.artifacts.read(completed.nodes[1].outputRef), 14)
    assert.equal(requests.length, 1)
    await ctx.fiber.dispose()
    assert.equal(runtime.store.healthy, false)
    // 新开同一个控制库是独立证据：上一条 fiber dispose 真的释放了实例锁。
    reopened = await openExecutionStore({ dbPath: config.dbPath, instanceId: config.instanceId })
    const persisted = await reopened.query({ kind: 'run', runId: 'apply-run' })
    assert.equal(persisted.run.status, 'succeeded')
    assert.ok(persisted.nodes.every(node => node.drained))
  })
}
