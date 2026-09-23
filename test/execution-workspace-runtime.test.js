import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim()
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-runtime-')), sourceRepository = join(root, 'source'), workspaces = join(root, 'workspaces')
  await mkdir(sourceRepository); await mkdir(workspaces)
  await git(sourceRepository, 'init', '-b', 'main')
  await git(sourceRepository, 'config', 'user.name', 'Synthetic'); await git(sourceRepository, 'config', 'user.email', 'synthetic@example.invalid')
  await writeFile(join(sourceRepository, 'base.txt'), 'original'); await git(sourceRepository, 'add', 'base.txt'); await git(sourceRepository, 'commit', '-m', 'base')
  const baseCommit = await git(sourceRepository, 'rev-parse', 'HEAD')
  const options = { dbPath: join(root, 'control.db'), instanceId: 'workspace' }
  const store = await openExecutionStore({ ...options, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const adapter = await createManagedWorkspaces({ root: workspaces, sourceRepository })
  t.after(() => store.close())
  return { root, sourceRepository, baseCommit, options, store, artifacts, adapter }
}
const grant = async () => ({ principalId: 'synthetic', authorizationRef: 'task-grant' })
const workflow = execute => ({ id: 'workspace', version: '1', nodes: [{ id: 'prepare', version: '1', executor: 'code', allowedEffects: ['workspace.prepare'],
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute }] })

test('Controller补充换代：旧代删除/未跟踪及用户改动原样保留，新目录只来自固定基线', { timeout: 120000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const directories = []
  const delivery = createExecutionDelivery({ store: f.store, artifacts: f.artifacts, workspaceAdapter: f.adapter, authorize: grant })
  const controller = createExecutionController({ store: f.store, artifacts: f.artifacts, delivery, changeQuietMs: 0, maxChangeDelayMs: 0,
    workflows: [workflow(async ({ runId, generation, requirementDigest, perform, signal }) => {
      const prepared = await f.adapter.prepare({ runId, generation, requirementDigest, baseCommit: f.baseCommit })
      const result = await perform({ action: 'workspace', prepared }); directories.push(result.directory)
      if (generation === 1) { entered.resolve(); await release.promise; signal.throwIfAborted() }
      return result
    })] })
  t.after(async () => { release.resolve(); await controller.close() })
  await controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'workspace', input: { requirement: 'A' } })
  await entered.promise
  await unlink(join(directories[0], 'base.txt'))
  await writeFile(join(directories[0], 'old-only.txt'), 'old A')
  await writeFile(join(f.sourceRepository, 'base.txt'), 'user source edit')
  await controller.changeInput({ commandId: 'change', runId: 'run', inputId: 'B', sourceKey: 'message:B', input: { requirement: 'B' } })
  release.resolve()
  const state = await controller.whenIdle('run')
  assert.equal(state.run.status, 'succeeded'); assert.equal(state.nodes[0].generation, 2)
  assert.notEqual(directories[0], directories[1])
  assert.equal(await readFile(join(directories[1], 'base.txt'), 'utf8'), 'original')
  await assert.rejects(readFile(join(directories[1], 'old-only.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(directories[0], 'base.txt')), { code: 'ENOENT' })
  assert.equal(await readFile(join(directories[0], 'old-only.txt'), 'utf8'), 'old A')
  assert.equal(await readFile(join(f.sourceRepository, 'base.txt'), 'utf8'), 'user source edit')
  assert.equal(await git(f.sourceRepository, 'rev-parse', 'HEAD'), f.baseCommit)
})

test('准备目录成功但回执丢失：重开控制账先对账，再恢复复用目录，不重克隆', { timeout: 120000 }, async t => {
  const f = await fixture(t); let executions = 0
  const wrapped = { ...f.adapter, execute: async payload => { executions++; await f.adapter.execute(payload); throw Object.assign(new Error('lost ACK'), { code: 'ACK_LOST' }) } }
  const create = store => {
    const delivery = createExecutionDelivery({ store, artifacts: f.artifacts, workspaceAdapter: wrapped, authorize: grant })
    const controller = createExecutionController({ store, artifacts: f.artifacts, delivery, workflows: [workflow(async ({ runId, generation, requirementDigest, perform }) =>
      perform({ action: 'workspace', prepared: await f.adapter.prepare({ runId, generation, requirementDigest, baseCommit: f.baseCommit }) }))] })
    return { controller, delivery }
  }
  const first = create(f.store)
  await first.controller.createRun({ commandId: 'create', taskId: 'task', runId: 'run', workflowId: 'workspace', input: { requirement: 'A' } })
  assert.equal((await first.controller.whenIdle('run')).run.status, 'waiting')
  const [effect] = await f.store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(effect.state, 'unknown')
  const directory = effect.definition.payload.directory
  await writeFile(join(directory, 'base.txt'), 'preserve user edit')
  await first.controller.close(); await f.store.close()
  const reopened = await openExecutionStore(f.options), second = create(reopened)
  t.after(async () => { await second.controller.close(); await reopened.close() })
  assert.equal((await second.delivery.reconcile(effect.effectId)).state, 'succeeded')
  await second.controller.recover({ commandId: 'recover', runId: 'run' })
  assert.equal((await second.controller.whenIdle('run')).run.status, 'succeeded')
  assert.equal(executions, 1)
  assert.equal(await readFile(join(directory, 'base.txt'), 'utf8'), 'preserve user edit')
})
