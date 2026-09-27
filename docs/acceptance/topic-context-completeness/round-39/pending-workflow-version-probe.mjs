import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'

// 精确复现：计划已冻结旧版本、阶段尚未建立Run；升级后仍提供旧工厂。
const directory = fileURLToPath(new URL('.', import.meta.url))
const temporaryRoot = fileURLToPath(new URL('../../../tmp/framework-contract-probe/', import.meta.url))
await mkdir(temporaryRoot, { recursive: true })
const root = await mkdtemp(join(temporaryRoot, 'pending-version-'))
const dbPath = join(root, 'control.sqlite')
const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
const makeWorkflow = version => ({ id: 'pending-version', version, nodes: [{
  id: 'prepare', version, executor: 'code', allowedEffects: ['pure'],
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input,
}] })
const oldWorkflow = makeWorkflow('1'), newWorkflow = makeWorkflow('2')
let store = await openExecutionStore({ dbPath, instanceId: 'pending-version-probe', initialize: true })
let controller = createExecutionController({ store, artifacts, workflows: [oldWorkflow] })
await controller.createTaskPlan({ commandId: 'create-plan', taskId: 'pending-task',
  stages: [{ stageId: 'stage-1', workflowId: 'pending-version', input: { message: 'original' } }] })
await controller.close(); await store.close()
store = await openExecutionStore({ dbPath, instanceId: 'pending-version-probe' })
controller = createExecutionController({ store, artifacts, workflows: [newWorkflow], historicalWorkflows: [oldWorkflow] })
try {
  let advanceError = null
  try { await controller.advanceTaskPlan('pending-task') }
  catch (error) { advanceError = error.code ?? error.message }
  const plan = await controller.taskPlan('pending-task')
  const result = { observedAt: new Date().toISOString(), baseline: '89df536', advanceError,
    historicalWorkflowRegistered: true, oldDigest: defineExecutionWorkflow(oldWorkflow).digest,
    newDigest: defineExecutionWorkflow(newWorkflow).digest,
    frozenDigest: plan.stages[0].workflowDigest, stageStatus: plan.stages[0].status, runId: plan.stages[0].runId }
  assert.equal(result.advanceError, 'WORKFLOW_VERSION_UNAVAILABLE')
  assert.equal(result.frozenDigest, result.oldDigest)
  assert.notEqual(result.oldDigest, result.newDigest)
  assert.equal(result.stageStatus, 'ready')
  assert.equal(result.runId, null)
  await writeFile(join(directory, 'pending-workflow-version-probe.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await controller.close(); await store.close() }
