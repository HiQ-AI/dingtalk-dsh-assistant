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
import { createEngineeringRegistry } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

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
      assert.deepEqual(input.directories, [{ directory: 'src/', names: ['value.txt'] }])
      assert.equal(input.fileCount, 1)
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
  await assert.rejects(validate.execute({ input: { manifest: { directories: [{ directory: 'src/', names: ['value.txt'] }] }, selection: { existingPaths: [], newPaths: ['outside.txt'] } } }), { code: 'ENGINEERING_SELECTION_INVALID' })
  const invalid = { ...workflow, nodes: workflow.nodes.map(node => node.id === 'read-files' ? { ...node, inputDependencies: ['finalize'] } : node) }
  assert.throws(() => defineExecutionWorkflow(invalid), { code: 'NODE_DEPENDENCY_INVALID' })
})

test('工程目录清单容纳真实规模路径且保留全部候选', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-capacity-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  for (let group = 0; group < 200; group++) {
    const parent = join(source, 'src', `feature-${group}`); await mkdir(parent, { recursive: true })
    for (let file = 0; file < (group < 24 ? 5 : 4); file++) await writeFile(join(parent, `implementation-${file}.ts`), '')
  }
  await git('add', '.'); await git('commit', '-m', 'base'); const baseCommit = await git('rev-parse', 'HEAD')
  const workspaceAdapter = await createManagedWorkspaces({ root, sourceRepository: source })
  const workflow = createEngineeringTaskWorkflow({ provider: 'test', model: 'synthetic', workspaceAdapter, editAdapter: {}, adapterIdentity: source,
    discovery: { allowedPrefixes: ['src/'] }, checks: [{ id: 'check', version: '1', run: async () => ({ passed: true, log: '' }) }] })
  const index = workflow.nodes.find(node => node.id === 'index-files')
  const prepared = await workspaceAdapter.prepare({ runId: 'capacity-run', generation: 1, requirementDigest: 'a'.repeat(64), baseCommit })
  await workspaceAdapter.execute(prepared)
  const manifest = await index.execute({ input: { request: '修复归一化计算', constraints: [], baseCommit, editablePaths: [] },
    runId: 'capacity-run', generation: 1, requirementDigest: 'a'.repeat(64) })
  assert.equal(manifest.fileCount, 824)
  assert.equal(manifest.directories.length, 200)
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 32000)
  const validate = workflow.nodes.find(node => node.id === 'validate-selection')
  assert.deepEqual(await validate.execute({ input: { manifest, selection: { existingPaths: ['src/feature-199/implementation-3.ts'], newPaths: [] } } }),
    { paths: ['src/feature-199/implementation-3.ts'] })
})

test('恢复旧工程索引容量等待时迁移同一运行并保留旧定义', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-migration-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(root); await mkdir(join(source, 'src'))
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'src/value.txt'), 'old'); await git('add', '.'); await git('commit', '-m', 'base')
  const baseCommit = await git('rev-parse', 'HEAD')
  const store = await openExecutionStore({ dbPath: join(directory, 'control.db'), instanceId: 'migration', initialize: true }); t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const repository = { id: 'sample', sourceRepository: source, managedRoot: root, remote: 'https://github.com/example/sample.git',
    baseRef: 'main', baseBranch: 'main', githubRepository: 'example/sample', editablePaths: [], discovery: { allowedPrefixes: ['src/'] },
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }
  const registry = createEngineeringRegistry({ repositories: [repository], ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }),
    author: { name: 'Test', email: 'test@example.invalid' } })
  const oldDigest = 'b'.repeat(64), runId = 'migration-run', taskId = 'migration-task', workflowId = 'task-engineering-migration'
  const saved = { kind: 'engineering', registryVersion: '1', repoId: repository.id,
    repositoryDigest: executionDigest({ config: repository, ghCommand: null, author: { name: 'Test', email: 'test@example.invalid' } }),
    runId, taskId, sourceCommandId: 'source', ownerActorId: 'owner', provider: 'test', model: 'test',
    input: { request: '修复文件', constraints: [], baseCommit, editablePaths: [] }, head: 'codex/task-test', date: '1750000000 +0000',
    title: '修复文件', body: '任务', author: { name: 'Test', email: 'test@example.invalid' } }
  await store.command({ id: 'old-workflow', kind: 'workflow.register', args: { workflowId, definitionVersion: '3', digest: oldDigest, config: saved } })
  const requirement = await artifacts.put(saved.input), input = await artifacts.put({ workflowDigest: oldDigest, nodeId: 'index-files', nodeVersion: '1', requirementRef: requirement.ref, data: saved.input })
  const names = ['prepare-generation', 'prepare-workspace', 'index-files', 'select-files', 'validate-selection', 'read-files', 'propose-changes', 'apply-changes', 'verify-candidate', 'prepare-commit', 'commit', 'prepare-push', 'push', 'prepare-pr', 'create-pr', 'finalize']
  await store.command({ id: 'create', kind: 'run.create', args: { runId, taskId, workflowId, workflowDigest: oldDigest, requirementRef: requirement.ref,
    nodes: names.map((nodeId, i) => ({ nodeId, nodeVersion: '1', executor: ['select-files', 'propose-changes'].includes(nodeId) ? 'agent' : 'code',
      inputRef: i === 0 ? input.ref : null, inputDigest: i === 0 ? input.digest : null })) } })
  for (let i = 0; i < 3; i++) {
    const nodeId = names[i], claimed = (await store.command({ id: `claim-${i}`, kind: 'node.claim', args: { runId, nodeId, expectedGeneration: 1, expectedLeaseEpoch: 0 } })).result.binding
    await store.command({ id: `drain-${i}`, kind: 'node.drained', args: { runId, nodeId, generation: 1, leaseEpoch: 1, evidenceRef: requirement.ref } })
    await store.command({ id: `commit-${i}`, kind: 'node.commit', args: { runId, nodeId, generation: 1, leaseEpoch: 1,
      inputDigest: claimed.inputDigest, outcome: i === 2 ? 'waiting' : 'succeeded', evidenceRefs: [],
      ...(i === 2 ? { waitReason: { kind: 'recovery', reference: 'ENGINEERING_INDEX_CAPACITY_EXCEEDED' } }
        : { outputRef: requirement.ref, nextInput: { nodeId: names[i + 1], inputRef: input.ref, inputDigest: input.digest } }) } })
  }
  const [workflow] = await registry.restore(store, artifacts), state = await store.query({ kind: 'run', runId })
  assert.equal(workflow.version, '4'); assert.equal(state.run.status, 'queued')
  assert.equal(state.nodes.find(node => node.nodeId === 'index-files').status, 'ready')
  assert.notEqual(state.run.workflowDigest, oldDigest)
  assert.equal((await store.query({ kind: 'workflow.list' })).length, 2)
  const [same] = await registry.restore(store, artifacts)
  assert.equal(same.version, '4'); assert.equal((await store.query({ kind: 'workflow.list' })).length, 2)
})
