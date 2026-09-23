import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createManagedWorkspaces } from '../packages/dingtalk-dsh-assistant/execution-workspace.js'
import { createManagedEdits } from '../packages/dingtalk-dsh-assistant/execution-edit.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createEngineeringTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'

for (const escalate of [false, true]) test(`发现选择流程：${escalate ? '后续Agent不能篡改已持久选择范围' : 'Host索引选择后读取，允许计划中新文件'}`, { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(join(source, 'src')); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'src/value.txt'), 'old'); await writeFile(join(source, 'outside.txt'), 'not admitted')
  await git('add', '.'); await git('commit', '-m', 'base'); const baseCommit = await git('rev-parse', 'HEAD')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'discovery', initialize: true }); t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const workspaceAdapter = await createManagedWorkspaces({ root, sourceRepository: source }), editAdapter = createManagedEdits({ workspaceAdapter })
  const delivery = createExecutionDelivery({ store, artifacts, workspaceAdapter, editAdapter, authorize: async () => ({ principalId: 'owner', authorizationRef: 'grant' }) })
  const calls = []
  const sessions = { async run({ input, definition, onSessionBound, onResult }) {
    await onSessionBound()
    if (definition.outputSchema.properties.existingPaths) {
      calls.push('select')
      assert.deepEqual(input.files.map(file => file.path), ['src/value.txt'])
      assert.equal(input.excludedCount, 1)
      onResult({ existingPaths: ['src/value.txt'], newPaths: ['src/new.txt'] })
    } else {
      calls.push('change')
      assert.deepEqual(input.files.map(file => file.path), ['src/value.txt', 'src/new.txt'])
      onResult({ changes: [{ path: 'src/value.txt', expectedHash: input.files[0].expectedHash, content: 'new' },
        { path: escalate ? 'src/not-selected.txt' : 'src/new.txt', expectedHash: null, content: 'planned new file' }] })
    }
  }, async cancel() {}, async close() {} }
  const workflow = createEngineeringTaskWorkflow({ provider: 'test', model: 'synthetic', workspaceAdapter, editAdapter, adapterIdentity: source,
    discovery: { allowedPrefixes: ['src/'] }, checks: [{ id: 'check', version: '1', run: async snapshot => ({ passed: (await snapshot.readFile('src/new.txt')).toString() === 'planned new file', log: 'new file verified' }) }] })
  const controller = createExecutionController({ store, artifacts, sessions, delivery, workflows: [workflow] }); t.after(() => controller.close())
  await controller.createRun({ commandId: 'create', runId: 'run', taskId: 'task', workflowId: 'task-engineering', input: { request: 'update source', constraints: [], baseCommit, editablePaths: [] } })
  const state = await controller.whenIdle('run')
  assert.deepEqual(calls, ['select', 'change'])
  assert.equal(state.run.status, escalate ? 'waiting' : 'succeeded')
  if (escalate) assert.equal(state.nodes.find(node => node.nodeId === 'apply-changes').waitReason.reference, 'ENGINEERING_EDIT_SCOPE_MISMATCH')
  const effects = await store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(effects.some(effect => effect.definition.action === 'edit'), !escalate)
  assert.equal(await readFile(join(source, 'src/value.txt'), 'utf8'), 'old')
  // 同一选择参数不能把目录白名单扩大；纯校验不需要另起模型。
  const validate = workflow.nodes.find(node => node.id === 'validate-selection')
  await assert.rejects(validate.execute({ input: { manifest: { files: [{ path: 'src/value.txt' }] }, selection: { existingPaths: [], newPaths: ['outside.txt'] } } }), { code: 'ENGINEERING_SELECTION_INVALID' })
  const invalid = { ...workflow, nodes: workflow.nodes.map(node => node.id === 'read-files' ? { ...node, inputDependencies: ['finalize'] } : node) }
  assert.throws(() => defineExecutionWorkflow(invalid), { code: 'NODE_DEPENDENCY_INVALID' })
})
