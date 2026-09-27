import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const exec = promisify(execFile), root = process.cwd(), directory = resolve('docs/tmp/framework-tests/sg21')
await mkdir(directory, { recursive: true })
const packageRoot = resolve('packages/dingtalk-dsh-assistant')
const current = name => import(pathToFileURL(join(packageRoot, name)).href)
async function baseline(name) {
  const { stdout } = await exec('git', ['show', `89df536:packages/dingtalk-dsh-assistant/${name}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
  const source = stdout.replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g, (_, start, value, end) => start + pathToFileURL(resolve(packageRoot, value)).href + end)
  const file = join(directory, 'baseline-' + name)
  await writeFile(file, source)
  return import(pathToFileURL(file).href)
}
const { defineExecutionWorkflow } = await current('execution-controller.js')
const config = { provider: 'test', model: 'test' }, rows = []
const oldTask = await baseline('task-workflow.js'), task = await current('task-workflow.js')
const oldRead = await baseline('task-readonly-workflows.js'), read = await current('task-readonly-workflows.js')
const oldGeneral = await baseline('task-general-workflow.js'), general = await current('task-general-workflow.js')
const capabilities = [{ id: 'lookup', identity: 'lookup-v1', effectClass: 'read', authorize: () => true, execute: async () => ({}), verify: () => ({}) }]
const pairs = [[oldTask.createAnalysisTaskWorkflow(config), task.createLegacyAnalysisTaskWorkflow(config)],
  ...oldRead.createReadOnlyTaskWorkflows(config).map((workflow, i) => [workflow, read.createLegacyReadOnlyTaskWorkflows(config)[i]]),
  [oldGeneral.createGeneralCapabilityStepWorkflow({ capabilities }), general.createLegacyGeneralCapabilityStepWorkflow({ capabilities })]]
for (const [before, after] of pairs) {
  assert.equal(defineExecutionWorkflow(before).digest, defineExecutionWorkflow(after).digest)
  rows.push({ id: before.id, version: before.version, digest: defineExecutionWorkflow(after).digest, same: true })
}
const oldEngineering = await baseline('workflow-engineering.js'), engineering = await current('workflow-engineering.js')
const { openExecutionStore } = await current('execution-store.js')
const work = await mkdtemp(join(directory, 'legacy-engineering-')), source = join(work, 'source')
await mkdir(source)
const git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
await writeFile(join(source, 'value.txt'), 'baseline'); await git('add', '.'); await git('commit', '-m', 'baseline'); await git('branch', 'feature/uat2-base')
const store = await openExecutionStore({ dbPath: join(work, 'control.db'), instanceId: 'legacy', initialize: true })
try {
  const options = { ownerActorId: 'owner', modelConfig: () => config, repositories: [{ id: 'repo', sourceRepository: source,
    managedRoot: join(work, 'managed'), remote: source, baseRef: 'main', githubRepository: 'example/repo', editablePaths: ['value.txt'],
    checks: [{ id: 'check', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }] }] }
  const previous = oldEngineering.createEngineeringRegistry(options); await previous.restore(store)
  let oldWorkflow
  await previous.prepareTask({ taskId: 'task', arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修改' } },
    { commandId: 'source', run: { actorId: 'owner' }, unit: {} }, { registerWorkflow(workflow) { oldWorkflow = workflow } })
  assert.equal(oldWorkflow.version, '15')
  const next = engineering.createEngineeringRegistry(options), restored = await next.restore(store)
  assert.equal(restored.length, 1); assert.equal(restored[0].version, '15'); assert.equal(restored[0].ownerContract, undefined)
  assert.equal(defineExecutionWorkflow(restored[0]).digest, defineExecutionWorkflow(oldWorkflow).digest)
  rows.push({ id: 'engineering-registry', version: '15', digest: defineExecutionWorkflow(restored[0]).digest, same: true })
} finally { await store.close() }
await writeFile(resolve('docs/acceptance/topic-context-completeness/round-41/legacy-digest-check.json'), JSON.stringify({ baseline: '89df536', rows }, null, 2))
console.log(JSON.stringify({ baseline: '89df536', total: rows.length, same: rows.every(row => row.same) }))
