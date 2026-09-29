import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openWorkflowService } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'
const { values } = parseArgs({ options: { db: { type: 'string' }, artifacts: { type: 'string' }, evidence: { type: 'string' }, tasks: { type: 'string', multiple: true } } })
for (const key of ['db', 'artifacts', 'evidence', 'tasks']) assert.ok(values[key], `需要 --${key}`)
const evidence = resolve(values.evidence), allowed = relative(resolve('docs/tmp'), evidence)
assert.ok(allowed && !allowed.startsWith('..') && !isAbsolute(allowed), '真实证据必须在 docs/tmp 内')
await mkdir(evidence, { recursive: false })
const snapshot = join(evidence, 'control-copy.sqlite')
const digest = value => createHash('sha256').update(value).digest('hex')
function state(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row, (_, item) => item instanceof Uint8Array ? [...item] : item)).sort()
    return [name, { count: rows.length, digest: digest(rows.join('\n')) }]
  }))
}
const live = new DatabaseSync(resolve(values.db), { readOnly: true })
const liveBefore = state(live)
await backup(live, snapshot)
live.close()
const copy = new DatabaseSync(snapshot, { readOnly: true })
const before = state(copy), instanceId = copy.prepare('SELECT instance_id FROM execution_meta').get().instance_id
copy.close()
const actualStore = await openExecutionStore({ dbPath: snapshot, instanceId })
let commands = 0, artifactReads = 0
const blocked = () => { commands++; throw Error('READ_ONLY_ACCEPTANCE_FORBIDS_COMMAND') }
const store = { query: request => actualStore.query(request), command: blocked }
const actualArtifacts = await openExecutionArtifacts({ directory: resolve(values.artifacts) })
const artifacts = { root: actualArtifacts.root, read: async ref => { artifactReads++; return actualArtifacts.read(ref) }, put: blocked }
const controller = { state: async runId => ({ ...await store.query({ kind: 'run', runId }), controllerError: null }), taskPlan: taskId => store.query({ kind: 'task.plan', taskId }), workflowDefinition: () => null }
const families = await Promise.all(values.tasks.map(taskId => store.query({ kind: 'task.family', taskId })))
const origins = await Promise.all([...new Set(families.flatMap(family => family.taskIds))].map(taskId => store.query({ kind: 'task.origin', taskId })))
const groupIds = [...new Set(origins.filter(origin => origin.channel !== 'web').map(origin => origin.run.conversationId))]
const webActors = [...new Set(origins.filter(origin => origin.channel === 'web').map(origin => origin.run.actorId))]
assert.ok(webActors.length <= 1)
const service = await openWorkflowService({ ctx: {}, config: { groupIds: groupIds.length ? groupIds : ['read-only-acceptance'], ownerActorId: 'read-only-acceptance', webActorId: webActors[0] }, legacy: { getAgentConfig: () => ({ provider: 'deepseek', model: 'deepseek-chat', workspaceDir: evidence }) }, judge: blocked, execution: { store, artifacts, controller }, taskOwnerSessions: { run: blocked, async close() {} }, messageAgentSessions: { run: blocked, async close() {} } })
const privateCases = [], cases = []
try {
  for (let index = 0; index < values.tasks.length; index++) {
    const taskId = values.tasks[index], plan = await controller.taskPlan(taskId), detail = await service.taskDetail(taskId)
    assert.ok(detail)
    assert.equal(detail.state, 'completed')
    assert.equal(detail.outcome, 'succeeded')
    assert.equal(detail.plan.stages.length, plan.stages.length)
    const states = await Promise.all(plan.stages.map(stage => controller.state(stage.runId)))
    const expected = states.flatMap((item, stageIndex) => item.nodes.map(node => ({ stageId: plan.stages[stageIndex].stageId, runId: item.run.runId, nodeRunId: node.nodeRunId })))
    assert.deepEqual(detail.executionNodes.map(node => ({ stageId: node.stageId, runId: node.runId, nodeRunId: node.nodeRunId })), expected)
    assert.equal(new Set(detail.executionNodes.map(node => node.stepKey)).size, expected.length)
    let readable = 0, pages = 0, characters = 0
    const outputs = []
    for (const node of detail.executionNodes) {
      if (!node.outputRef) continue
      const chunks = []; let offset = 0
      while (true) {
        const output = await service.taskNodeOutput(taskId, node.runId, node.nodeRunId, { outputRef: node.outputRef, detailRevision: detail.detailRevision, offset, limit: 1200 })
        assert.ok(output, '正文必须属于当前计划节点')
        chunks.push(output.text); pages++
        if (output.nextCursor === null) { assert.equal(chunks.join('').length, output.totalLength); break }
        assert.ok(output.nextCursor > offset); offset = output.nextCursor
      }
      const text = chunks.join(''); characters += text.length; readable++
      outputs.push({ nodeRunId: node.nodeRunId, text })
      await assert.rejects(service.taskNodeOutput(taskId, node.runId, node.nodeRunId, { outputRef: 'sha256-' + '0'.repeat(64) + '.json', detailRevision: detail.detailRevision }), { code: 'TASK_OUTPUT_CHANGED' })
    }
    assert.ok(readable > 0)
    const family = await store.query({ kind: 'task.family', taskId })
    for (const previous of family.taskIds) assert.equal((await service.taskDetail(previous)).taskId, taskId)
    if (states.length > 1 && detail.executionNodes[0].outputRef) assert.equal(await service.taskNodeOutput(taskId, states[1].run.runId, detail.executionNodes[0].nodeRunId, { outputRef: detail.executionNodes[0].outputRef }), null)
    cases.push({ case: index + 1, stages: plan.stages.length, nodes: expected.length, readableNodes: readable, pages, characters, familyLinksChecked: family.taskIds.length, complete: true, outputOwnershipChecked: true })
    privateCases.push({ taskId, plan, states, detail, outputs })
  }
} finally { await service.close(); await actualStore.close() }
const readback = new DatabaseSync(snapshot, { readOnly: true }), after = state(readback); readback.close()
assert.deepEqual(after, before, '隔离副本业务表完全不变')
assert.equal(commands, 0)
const liveReadback = new DatabaseSync(resolve(values.db), { readOnly: true }), liveAfter = state(liveReadback); liveReadback.close()
const liveChangedTables = Object.keys(liveBefore).filter(name => liveBefore[name].digest !== liveAfter[name]?.digest)
const liveBusinessChangedTables = liveChangedTables.filter(name => !['execution_events', 'execution_receipts'].includes(name))
assert.deepEqual(liveBusinessChangedTables, [], '正式任务状态、节点、计划与外部效果表不变')
const summary = { verified: true, cases, blockedMutationAttempts: commands, artifactReads, copyBusinessTablesUnchanged: true, liveBusinessTablesUnchanged: true, liveBusinessChangedTables, liveChangedTables, limitation: '真实数据的一致 SQLite 副本与当前分支服务投影；正式实例仅只读，不代表正式部署或重新执行业务' }
await writeFile(join(evidence, 'private-readback.json'), JSON.stringify({ privateCases, before, after, liveBefore, liveAfter }, null, 2))
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2))
await writeFile(join(evidence, 'replay-details.json'), JSON.stringify(privateCases.map(item => ({ taskId: item.taskId, detail: item.detail, outputs: item.outputs })), null, 2))
console.log(JSON.stringify(summary, null, 2))
