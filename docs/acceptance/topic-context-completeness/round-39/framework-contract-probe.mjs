import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'

// 仅使用本轮目录下的新控制库和纯 code 节点，不访问运行实例或外部平台。
const directory = fileURLToPath(new URL('.', import.meta.url))
const temporaryRoot = fileURLToPath(new URL('../../../tmp/framework-contract-probe/', import.meta.url))
await mkdir(temporaryRoot, { recursive: true })
const probeRoot = await mkdtemp(join(temporaryRoot, 'run-'))
const observations = []
for (const [kind, value] of [['plain', { ok: true }], ['date', new Date('2026-01-01T00:00:00Z')], ['mapper-error', { ok: true }]]) {
  const root = join(probeRoot, kind)
  await mkdir(root)
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: `probe-${kind}`, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const definition = { id: `probe-${kind}`, version: '1', nodes: [{ id: 'produce', version: '1', executor: 'code',
    allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    mapInput: ({ requirement }) => requirement, execute: async () => value }] }
  if (kind === 'mapper-error') definition.nodes.push({ id: 'consume', version: '1', executor: 'code',
    allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    mapInput: ({ previousOutput }) => previousOutput.missing.value, execute: async ({ input }) => input })
  const controller = createExecutionController({ store, artifacts, workflows: [definition] })
  try {
    await controller.createRun({ commandId: `create-${kind}`, taskId: `task-${kind}`, runId: `run-${kind}`, workflowId: definition.id, input: {} })
    let idleError = null, idleErrorName = null
    try { await controller.whenIdle(`run-${kind}`) } catch (error) { idleError = error.code ?? error.message; idleErrorName = error.name }
    const state = await controller.state(`run-${kind}`)
    let recoveryError = null
    if (kind !== 'plain') {
      try { await controller.recover({ commandId: `recover-${kind}`, runId: `run-${kind}` }) }
      catch (error) { recoveryError = error.code ?? error.message }
    }
    observations.push({ kind, idleError, idleErrorName, recoveryError, runStatus: state.run.status,
      nodeStatus: state.nodes[0].status, drained: state.nodes[0].drained,
      outputRef: state.nodes[0].outputRef, waitReason: state.nodes[0].waitReason,
      controllerError: state.controllerError })
  } finally { await controller.close(); await store.close() }
}
assert.equal(observations[0].runStatus, 'succeeded')
assert.equal(observations[1].idleError, 'INVALID_JSON_OBJECT')
assert.equal(observations[1].runStatus, 'running')
assert.equal(observations[1].nodeStatus, 'running')
assert.equal(observations[1].drained, true)
assert.equal(observations[1].recoveryError, 'RUN_NOT_RECOVERING')
assert.equal(observations[2].idleErrorName, 'TypeError')
assert.equal(observations[2].runStatus, 'running')
assert.equal(observations[2].nodeStatus, 'running')
assert.equal(observations[2].drained, true)
assert.equal(observations[2].recoveryError, 'RUN_NOT_RECOVERING')

// 定义摘要不自动封存闭包参数；作者必须显式更新 rulesDigest / version。
const closureWorkflow = value => ({ id: 'closure-probe', version: '1', nodes: [{ id: 'produce', version: '1',
  executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'number' },
  mapInput: ({ requirement }) => requirement, execute: async () => value }] })
const first = defineExecutionWorkflow(closureWorkflow(1)), second = defineExecutionWorkflow(closureWorkflow(2))
const closureObservation = { sameDigest: first.digest === second.digest,
  firstOutput: await first.nodes[0].execute(), secondOutput: await second.nodes[0].execute() }
assert.equal(closureObservation.sameDigest, true)
assert.notEqual(closureObservation.firstOutput, closureObservation.secondOutput)
const result = { observedAt: new Date().toISOString(), baseline: '89df536', observations, closureObservation }
await writeFile(join(directory, 'framework-contract-probe.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
