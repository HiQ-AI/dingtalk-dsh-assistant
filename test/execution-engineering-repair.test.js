import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createEngineeringRegistry } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { createEngineeringFailureRepair } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'

for (const ambiguous of [false, true]) test(`正式Owner修复同Run新代：${ambiguous ? '补丁歧义读原工作区' : '读失败候选'}、并发拒绝、幂等及旧证据保留`, { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engineering-repair-')), source = join(root, 'source'), remote = join(root, 'remote.git')
  await mkdir(join(source, 'src'), { recursive: true })
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'src/value.txt'), ambiguous ? 'unique\nbase\nbase' : 'base'); await git('add', '.'); await git('commit', '-m', 'base')
  await git('init', '--bare', remote); await git('push', remote, 'HEAD:refs/heads/feature/uat2-base')
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'repair', initialize: true })
  t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const profile = join(root, 'profile.json'); await writeFile(profile, JSON.stringify({ environment: 'uat', env: {} }))
  const command = { executable: process.execPath, args: ['-e', 'process.exit(1)'] }
  const registry = createEngineeringRegistry({ ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'test' }), author: { name: 'Test', email: 'test@example.invalid' }, repositories: [{ id: 'repo', sourceRepository: source, managedRoot: join(root, 'managed'), remote, baseRef: 'main', githubRepository: 'test/repo', discovery: { allowedPrefixes: ['src/'] }, checks: [{ id: 'build', version: '1', executable: process.execPath, args: ['-e', "const v=require('node:fs').readFileSync('src/value.txt','utf8');console.log(v);if(!v.includes('good'))process.exit(1)"] }], localAcceptance: { version: '1', sharedDataProfilePath: profile, prepareSteps: [], service: { ...command, args: ['-e', 'process.exit(1)', '{port}', '127.0.0.1'], readyPath: '/' }, scenarios: [{ ...command, id: 'value', description: '值' }], cleanup: command, verifyCleanup: command } }] })
  await registry.restore(store, artifacts)
  let proposals = 0, oldRead = false
  const sessions = { async run({ binding, input, onSessionBound, onResult }) {
    await onSessionBound()
    if (input.criteria) return onResult({ cases: [] }) // 第二代止于本地验收计划门禁，不访问业务服务。
    const current = await registry.repositoryInspect(binding, { operation: 'read', path: 'src/value.txt' }, undefined, input)
    let content = 'effective-change\nbad'
    if (binding.generation === 2) {
      const context = await registry.repositoryInspect(binding, { operation: 'repair' }, undefined, input)
      if (ambiguous) {
        assert.equal(context.sourceKind, 'workspace'); assert.equal(context.candidateDigest, undefined)
        assert.ok(context.materials.some(item => item.proposal?.replacements?.[1]?.from === 'base'))
      } else assert.ok(context.materials.some(item => item.log?.includes('bad')))
      const previous = await registry.repositoryInspect(binding, { operation: 'read', source: 'previous', path: 'src/value.txt' }, undefined, input)
      if (ambiguous) {
        await assert.rejects(registry.repositoryInspect({ ...binding, generation: 1 }, { operation: 'repair' }, undefined, input), /ENGINEERING_READ_STALE/)
        await assert.rejects(registry.repositoryInspect(binding, { operation: 'read', source: 'previous', path: '../outside' }, undefined, input), /ENGINEERING_READ_ARGUMENT_INVALID/)
        const oldFile = join(oldWorkspace.workspace.directory, 'src/value.txt')
        await writeFile(oldFile, previous.text + '\ndrift')
        try { await assert.rejects(registry.repositoryInspect(binding, { operation: 'read', source: 'previous', path: 'src/value.txt' }, undefined, input), /ENGINEERING_REPAIR_WORKSPACE_DRIFT/) }
        finally { await writeFile(oldFile, previous.text) }
      }
      assert.equal(previous.text, ambiguous ? 'unique\nbase\nbase' : content); oldRead = true; content = ambiguous ? 'effective-change\ngood' : previous.text.replace('bad', 'good')
    }
    proposals++
    onResult({ changeDisposition: 'modify', reviewedPaths: ['src/value.txt'], reason: '读取当前值后按任务修复并验证', document: { name: '修改方案.md', markdown: '修改 src/value.txt 并验证构建。' },
      changes: ambiguous && binding.generation === 1 ? [] : [{ path: 'src/value.txt', expectedHash: current.expectedHash, content }],
      replacements: ambiguous && binding.generation === 1 ? [{ path: 'src/value.txt', expectedHash: current.expectedHash, from: 'unique', to: 'first-change' }, { path: 'src/value.txt', expectedHash: current.expectedHash, from: 'base', to: 'good' }] : [] })
  }, async cancel() {}, async close() {} }
  const controller = createExecutionController({ store, artifacts, sessions, readTools: ['engineering_repo_inspect'], delivery: createExecutionDelivery({ store, artifacts, ...registry.deliveryOptions }), workflows: [], changeQuietMs: 0, maxChangeDelayMs: 0 })
  t.after(() => controller.close())
  const runId = controller.plannedTaskStageRunId({ taskId: 'task', planRevision: 1, stageId: 'stage-1', attempt: 1 })
  const prepared = await registry.prepareTask({ taskId: 'task', arguments: { repositoryId: 'repo', uatEnvironment: 'uat2', objective: '修复', acceptanceCriteria: ['值正确'] } }, { commandId: 'original', stageRunId: runId, run: { actorId: 'owner' }, unit: {} }, controller)
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'stage-1', workflowId: prepared.workflowId, input: prepared.input }] })
  const requirement = await artifacts.put(prepared.input)
  await store.command({ id: 'bind', kind: 'task.requirement.bind-legacy', args: { taskId: 'task', expectedRequirementRevision: 1, requirementRef: requirement.ref, sessionId: 'owner-test', criteria: ['值正确'], sourceKey: 'web:test', eventKey: 'created' } })
  await controller.advanceTaskPlan('task'); await controller.whenIdle(runId)
  const first = await controller.state(runId, { includeRecovery: true }), failed = first.nodes.find(node => node.nodeId === (ambiguous ? 'apply-changes' : 'verify-candidate'))
  assert.equal(failed.status, 'waiting', JSON.stringify(first)); assert.equal(failed.waitReason.reference, ambiguous ? 'ENGINEERING_PATCH_AMBIGUOUS' : 'ENGINEERING_VERIFICATION_FAILED')
  const evidenceRef = ambiguous ? first.nodes.find(node => ['inspect-and-propose', 'propose-changes'].includes(node.nodeId)).outputRef : failed.evidenceRefs[0]
  const failedEvidence = await artifacts.read(evidenceRef)
  const oldWorkspace = await artifacts.read(first.nodes.find(node => node.nodeId === 'prepare-workspace').outputRef)
  if (ambiguous) assert.equal(await readFile(join(oldWorkspace.workspace.directory, 'src/value.txt'), 'utf8'), 'unique\nbase\nbase')
  const helpers = createEngineeringFailureRepair({ store, artifacts, controller, engineering: registry })
  const observed = await helpers.inspectCurrentExecution('task'); assert.equal(observed.repairable, true)
  if (ambiguous) for (const change of [{ nodeId: 'verify-candidate' }, { waitReason: { reference: 'EDIT_BASE_CONFLICT' } }]) {
    const wrongController = { ...controller, state: async (runId, options) => {
      const value = await controller.state(runId, options)
      return { ...value, nodes: value.nodes.map(node => node.nodeId === 'apply-changes' ? { ...node, ...change } : node) }
    } }
    assert.equal((await createEngineeringFailureRepair({ store, artifacts, controller: wrongController, engineering: registry }).inspectCurrentExecution('task')).repairable, false)
  }
  const decision = { action: 'repairCurrentStage', summary: '修复bad并保留有效改动', repair: observed.repairBinding, evidenceRefs: observed.evidenceRefs }
  for (const field of ['generation', 'runRevision', 'requirementRevision']) await assert.rejects(helpers.repairCurrentStage({ taskId: 'task', decision: { ...decision, repair: { ...decision.repair, [field]: decision.repair[field] + 1 } }, commandId: `stale-${field}` }), /REPAIR_NOT_ADMITTED/)
  const contextRef = (await artifacts.put({ test: 'transaction-gate' })).ref
  for (const [field, expected] of [['generation', 'WORKFLOW_REPAIR_NOT_ADMITTED'], ['requirementRevision', 'WORKFLOW_REPAIR_NOT_ADMITTED'], ['runRevision', 'WORKFLOW_REPAIR_NOT_ADMITTED']]) {
    await assert.rejects(controller.changeInput({ commandId: `atomic-${field}`, runId, inputId: `atomic-${field}`, sourceKey: `atomic-${field}`,
      input: prepared.input, expectedRevision: first.run.revision,
      repair: { ...decision.repair, [field]: decision.repair[field] + 1, taskId: 'task', contextRef } }), { code: expected })
  }
  const unknownStore = { query: args => args.kind === 'effect.list' ? Promise.resolve([{ state: 'unknown' }]) : store.query(args) }
  const unknown = createEngineeringFailureRepair({ store: unknownStore, artifacts, controller, engineering: registry })
  assert.equal((await unknown.inspectCurrentExecution('task')).repairable, false)
  await assert.rejects(unknown.repairCurrentStage({ taskId: 'task', decision, commandId: 'unknown' }), /REPAIR_NOT_ADMITTED/)
  let repairCommand
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller, modelConfig: () => ({ provider: 'test', model: 'test' }), authorizeStages: async () => true, advanceTask: async () => {}, ...helpers,
    repairCurrentStage: args => { repairCommand = args.commandId; return helpers.repairCurrentStage(args) },
    sessionRunner: { async run({ input, onSessionBound, onCandidate, readArtifact }) {
      assert.equal(input.currentExecution.repairable, true)
      for (const ref of decision.evidenceRefs) await readArtifact(ref)
      if (!ambiguous) assert.equal((await readArtifact(evidenceRef)).text, Buffer.from(failedEvidence.data, 'base64').toString('utf8'))
      await onSessionBound(); await onCandidate(decision); return { status: 'submitted', decision }
    }, async close() {} } })
  t.after(() => owner.close())
  await owner.observe('task'); await owner.drive('task'); assert.deepEqual(await owner.applyPending(), [])
  await controller.whenIdle(runId)
  const second = await controller.state(runId)
  assert.equal(second.run.generation, 2, JSON.stringify(second)); assert.equal(proposals, 2); assert.equal(oldRead, true)
  assert.equal(second.nodes.find(node => node.nodeId === 'verify-candidate').status, 'succeeded', JSON.stringify(second))
  const workspace = await artifacts.read(second.nodes.find(node => node.nodeId === 'prepare-workspace').outputRef)
  assert.equal(await readFile(join(workspace.workspace.directory, 'src/value.txt'), 'utf8'), 'effective-change\ngood')
  assert.deepEqual(await artifacts.read(evidenceRef), failedEvidence)
  if (ambiguous) assert.equal(await readFile(join(oldWorkspace.workspace.directory, 'src/value.txt'), 'utf8'), 'unique\nbase\nbase')
  await helpers.repairCurrentStage({ taskId: 'task', decision, commandId: repairCommand })
  assert.equal((await controller.state(runId)).run.generation, 2)
})
