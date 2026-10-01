import { scriptedCoordinator } from './fixtures/group-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { readOnlyWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/task-readonly-workflows.js'
import { createGeneralCapabilityStepWorkflow } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { externalWorkflowOwnerContract, legacyExternalWorkflowOwnerContract, createReleaseTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

const schema = { type: 'object' }
const requirement = { request: '按现有材料回答问题', acceptanceCriteria: ['给出有依据的调查结论'], constraints: [], scope: {} }
const synthetic = (ownerContract, version = '1') => ({ id: 'task-inventory-count', version, ...(ownerContract ? { ownerContract } : {}), nodes: [
  { id: 'count', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async ({ input }) => ({ total: input.items.length }) },
] })

async function fixture(t, workflow, input, sessions) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-contract-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'contract', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let controller = createExecutionController({ store, artifacts, sessions, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'first', workflowId: workflow.id, input }] })
  await store.command({ id: 'owner', kind: 'task.owner.init', args: { taskId: 'task', sessionId: 'owner-session', sourceKey: 'source', criteria: requirement.acceptanceCriteria } })
  let helpers = createTaskWorkflowContracts({ controller, store, artifacts })
  async function finish() {
    const started = await controller.advanceTaskPlan('task')
    await controller.whenIdle(started.stages[0].runId)
    const plan = await controller.advanceTaskPlan('task')
    const [item] = await store.query({ kind: 'task.owner.acceptance', taskId: 'task' })
    const decision = { action: 'complete', summary: '已按范围完成', evidenceRefs: [plan.stages[0].outputRef],
      assessments: [{ itemId: item.itemId, status: 'satisfied', evidenceRefs: [plan.stages[0].outputRef] }] }
    return { taskId: 'task', plan, requirement, decision }
  }
  return { get controller() { return controller }, store, artifacts, get helpers() { return helpers }, finish,
    async restart(current) {
      await controller.close()
      controller = createExecutionController({ store, artifacts, sessions, workflows: [current], historicalWorkflows: [workflow] })
      helpers = createTaskWorkflowContracts({ controller, store, artifacts })
    } }
}

test('只读调查范围说明不阻塞完成，未知来源和未满足验收仍被拒绝', async t => {
  const workflow = { id:'historical-material-fixture',version:'1',ownerContract:readOnlyWorkflowOwnerContract,nodes:[{id:'result',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:({requirement})=>requirement,execute:async()=>({summary:'现有记录无法确认创建人，调查结果已经说明。',evidenceIds:['message'],limitations:['材料没有账号创建人的审计记录']})}] }
  const input = { request: requirement.request, constraints: [], materials: [{ id: 'message', text: '同事询问账号是否由小小鹏创建，现有记录无法确认创建人。' }] }
  const sessions = { async run({ onSessionBound, onResult }) {
    await onSessionBound()
    onResult({ summary: '现有记录无法确认创建人，调查结果已经说明。', findings: [{ statement: '记录未提供创建人', evidenceIds: ['message'] }],
      evidenceIds: ['message'], limitations: ['材料没有账号创建人的审计记录'] })
  }, async close() {}, async cancel() {} }
  const f = await fixture(t, workflow, input, sessions), completed = await f.finish()
  assert.equal(completed.plan.task.status, 'succeeded')
  assert.equal(await f.helpers.authorizeCompletion(completed), true)
  assert.equal(await f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision, assessments: [] } }), false)
  assert.equal(await f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision, evidenceRefs: ['invented'] } }), false)
  assert.equal(await f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision,
    assessments: [{ ...completed.decision.assessments[0], status: 'unsatisfied' }] } }), false)
  const final = await f.artifacts.read(completed.plan.stages[0].outputRef)
  assert.equal(await workflow.ownerContract.validateCompletion({ state: await f.controller.state(completed.plan.stages[0].runId),
    output: { ...final, evidenceIds: ['unknown'] }, artifacts: f.artifacts }), false)
  assert.equal(await workflow.ownerContract.validateCompletion({ state: await f.controller.state(completed.plan.stages[0].runId),
    output: { ...final, evidenceIds: [] }, artifacts: f.artifacts }), false)
})

test('第三个纯代码流程只通过合同扩展读产物和验收，旧计划仍使用冻结合同', async t => {
  let reads = 0, checks = 0
  const contract = { id: 'inventory-result', version: '1', rulesDigest: executionDigest({ expected: 2 }),
    readArtifacts({ stage, store, artifacts }) {
      assert.equal(typeof store.command, 'undefined'); assert.equal(typeof artifacts.put, 'undefined'); reads++
      return { nodeArtifacts: [{ nodeId: 'count', description: '已核对数量', artifactRef: stage.outputRef }], evidenceRefs: [stage.outputRef] }
    },
    validateCompletion({ output, store, artifacts }) {
      assert.equal(typeof store.command, 'undefined'); assert.equal(typeof artifacts.put, 'undefined'); checks++
      return output.total === 2
    } }
  const workflow = synthetic(contract), f = await fixture(t, workflow, { items: ['a', 'b'] })
  const original = defineExecutionWorkflow(workflow)
  const changed = synthetic({ ...contract, version: '2', validateCompletion: () => false }, '2')
  await f.restart(changed)
  assert.notEqual(defineExecutionWorkflow(changed).digest, original.digest)
  const completed = await f.finish(), stage = completed.plan.stages[0]
  assert.equal(stage.workflowDigest, original.digest)
  const state = await f.controller.state(stage.runId)
  assert.equal(state.run.workflowDigest, original.digest)
  assert.equal((await f.helpers.readStageArtifacts({ taskId: 'task', stage, state, plan: completed.plan })).nodeArtifacts[0].nodeId, 'count')
  assert.equal(await f.helpers.authorizeCompletion(completed), true)
  assert.equal(reads, 1); assert.equal(checks, 1)
  assert.equal(f.controller.workflowDefinition(workflow.id, original.digest).ownerContract.version, '1')
  assert.equal(Object.isFrozen(f.controller.workflowDefinition(workflow.id, original.digest).ownerContract), true)
  await assert.rejects(f.helpers.readStageArtifacts({ taskId: 'other', stage, state, plan: completed.plan }), /WORKFLOW_OWNER_STAGE_MISMATCH/)
  await assert.rejects(f.helpers.readStageArtifacts({ taskId: 'task', stage: { ...stage, outputRef: 'foreign' }, state, plan: completed.plan }), /WORKFLOW_OWNER_STAGE_MISMATCH/)
})

test('未绑定合同的旧定义保留产出读取，但完成和修复不得套用当前合同', async t => {
  const f = await fixture(t, synthetic(), { items: [] }), completed = await f.finish(), stage = completed.plan.stages[0]
  await f.restart(synthetic({ id: 'inventory-result', version: '2', validateCompletion: () => true }, '2'))
  assert.deepEqual(await f.helpers.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan }), {})
  await assert.rejects(f.helpers.authorizeCompletion(completed), /WORKFLOW_OWNER_CONTRACT_UNAVAILABLE/)
  const waitingPlan = { ...completed.plan, stages: [{ ...stage, status: 'running' }] }
  const inspect = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts,
    controller: { ...f.controller, taskPlan: async () => waitingPlan } })
  assert.equal(await inspect.inspectCurrentExecution('task'), null)
  await assert.rejects(inspect.repairCurrentStage({ taskId: 'task', decision: {}, commandId: 'legacy-repair' }), /WORKFLOW_OWNER_CONTRACT_UNAVAILABLE/)
  // 已终态旧定义未加载也可读取，不能回退为当前版本。
  const unloaded = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts,
    controller: { ...f.controller, workflowDefinition() { throw Object.assign(Error('missing'), { code: 'WORKFLOW_VERSION_UNAVAILABLE' }) } } })
  assert.deepEqual(await unloaded.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan }), {})
  await assert.rejects(unloaded.authorizeCompletion(completed), /WORKFLOW_OWNER_CONTRACT_UNAVAILABLE/)
})

test('保留写效果流程冻结验收身份，不再导出旧只读执行工厂', async () => {
  const old=await import('../packages/dingtalk-dsh-assistant/task-readonly-workflows.js')
  assert.equal(old.createReadOnlyTaskWorkflows,undefined)
  const capabilities=[{id:'write-file',identity:'write-v1',effectClass:'file.write',authorize:()=>true,prepare:()=>({}),verify:()=>({})}]
  const one=createGeneralCapabilityStepWorkflow({capabilities,completionCheck:()=>true,completionIdentity:'one'})
  const two=createGeneralCapabilityStepWorkflow({capabilities,completionCheck:()=>true,completionIdentity:'two'})
  assert.equal(one.version,'6');assert.notEqual(defineExecutionWorkflow(one).digest,defineExecutionWorkflow(two).digest)
})

test('平台技术效果不能冒充业务验收，领域条目须独立核验且缺校验器拒绝', async () => {
  const output = { status: 'uat-deployed', boundaries: ['仅确认 UAT 版本，业务验收尚需独立证明'] }
  const acceptanceItems = [{ itemId: 'repair', criterion: '生产故障已经修复', evidenceRefs: ['uat-output'] }]
  assert.equal(await externalWorkflowOwnerContract.validateCompletion({ output }), false)
  assert.equal(await externalWorkflowOwnerContract.validateCompletion({ output, acceptanceItems: [] }), true)
  assert.equal(await externalWorkflowOwnerContract.validateCompletion({ output, acceptanceItems }), false)
  assert.equal(await externalWorkflowOwnerContract.validateCompletion({ output, acceptanceItems, verifyAcceptance: async () => false }), false)
  let calls = 0
  const context = { output, acceptanceItems, requirement: { request: '部署 UAT' },
    decision: { evidenceRefs: ['uat-output'] }, stages: [{ output }] }
  assert.equal(await externalWorkflowOwnerContract.validateCompletion({ ...context, verifyAcceptance: async received => {
    calls++; assert.deepEqual(received, { requirement: context.requirement, decision: context.decision,
      stages: context.stages, acceptanceItems }); return true
  } }), true)
  assert.equal(calls, 1)
  for (const output of [null, { outcome: 'blocked' }, { status: 'unverified' }, { limitations: ['尚未回读'] }])
    assert.equal(await externalWorkflowOwnerContract.validateCompletion({ output, acceptanceItems: [], verifyAcceptance: async () => true }), false)
  assert.equal(legacyExternalWorkflowOwnerContract.validateCompletion({ output }), true)
})

test('公共修复屏障不依赖领域合同自律，不确定效果、暂停、待处理输入与未排空均不得准备修复', async () => {
  let prepared = 0, changed = 0
  const stage = { stageId: 'first', runId: 'run', workflowId: 'task-inventory-count', workflowDigest: 'a'.repeat(64), status: 'running' }
  const plan = { task: { controlState: 'active', requirementRevision: 3 }, stages: [stage] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: stage.workflowId, workflowDigest: stage.workflowDigest,
    status: 'waiting', generation: 2, revision: 7 }, pendingInputCount: 0, nodes: [{ status: 'waiting', drained: true, evidenceRefs: ['failure'] }] }
  const contract = { id: 'inventory-result', version: '1', validateCompletion: () => true,
    inspectRepair: () => ({ repairable: true, repairBinding: { generation: 999 }, evidenceRefs: ['failure'] }),
    prepareRepair: () => { prepared++; return { contextRef: 'context', input: {} } } }
  const helpers = (selectedPlan, selectedState, effects) => createTaskWorkflowContracts({
    store: { query: async ({ kind }) => kind === 'effect.list' ? effects : null }, artifacts: { read: async () => ({}) },
    controller: { taskPlan: async () => selectedPlan, state: async () => selectedState, workflowDefinition: () => ({ ownerContract: contract }),
      changeInput: async () => { changed++ } } })
  const admitted = await helpers(plan, state, []).inspectCurrentExecution('task')
  assert.equal(admitted.repairable, true); assert.equal(admitted.repairBinding.generation, 2)
  for (const [selectedPlan, selectedState, effects] of [
    [{ ...plan, task: { ...plan.task, controlState: 'paused' } }, state, []],
    [plan, { ...state, pendingInputCount: 1 }, []],
    [plan, { ...state, nodes: [{ ...state.nodes[0], drained: false }] }, []],
    [plan, state, [{ state: 'unknown' }]], [plan, state, [{ state: 'sending' }]],
  ]) {
    const facade = helpers(selectedPlan, selectedState, effects)
    assert.equal((await facade.inspectCurrentExecution('task')).repairable, false)
    await assert.rejects(facade.repairCurrentStage({ taskId: 'task', commandId: 'repair',
      decision: { repair: admitted.repairBinding, evidenceRefs: ['failure'] } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  }
  assert.equal(prepared, 0); assert.equal(changed, 0)
  await assert.rejects(helpers(plan, { ...state, nodes: [] }, []).inspectCurrentExecution('task'), /WORKFLOW_OWNER_ARTIFACT_SCOPE_MISMATCH/)
})

test('通用能力合同仍按同一产物摘要与完整验收条件检查目标', async () => {
  const capabilities = [{ id: 'lookup', identity: 'lookup-v1', effectClass: 'file.write', authorize: () => true, prepare: () => ({}), verify: () => ({}) }]
  let calls = 0
  const { ownerContract } = createGeneralCapabilityStepWorkflow({ capabilities, completionIdentity: 'test-v1',
    completionCheck: async ({ acceptanceCriteria, evidence }) => { calls++; return { status: 'satisfied', resultVerified: true,
      criteria: acceptanceCriteria.map(criterion => ({ criterion, passed: true, evidenceIds: [evidence[0].evidenceId] })) } } })
  const output = { capabilityId: 'lookup', output: { value: '已读回' }, verification: { passed: true, outputDigest: executionDigest({ value: '已读回' }) } }
  const stage = { stageId: 'first', outputRef: 'result' }, decision = { summary: '完成', evidenceRefs: ['result'] }
  const args = { output, stage, decision, requirement, stages: [{ stage, output, contractId: ownerContract.id }],
    acceptanceItems: requirement.acceptanceCriteria.map((criterion, index) => ({ itemId: `item-${index}`, criterion, evidenceRefs: ['result'] })) }
  assert.equal(await ownerContract.validateCompletion(args), true)
  assert.equal(await ownerContract.validateCompletion({ ...args, output: { ...output, verification: { passed: true, outputDigest: 'wrong' } } }), false)
  assert.equal(await ownerContract.validateCompletion({ ...args, decision: { ...decision, evidenceRefs: ['other'] } }), false)
  assert.equal(calls, 2)
})

test('第三种流程经真实 Controller/Store 修复，同一合同准备票据不可伪造或修改，未知效果阻断', async t => {
  let artifactStore, preparations = 0
  const contract = { id: 'inventory-result', version: '1', validateCompletion: ({ output }) => output.total === 2,
    inspectRepair: ({ state }) => ({ repairable: state.nodes.some(node => node.waitReason?.reference === 'INVENTORY_CHECK_FAILED'),
      evidenceRefs: state.nodes.flatMap(node => node.evidenceRefs ?? []) }),
    async prepareRepair({ state, artifacts }) {
      preparations++
      const context = await artifactStore.put({ taskId: state.run.taskId, runId: state.run.runId, generation: state.run.generation, reason: '库存校验失败' })
      const original = await artifacts.read(state.run.requirementRef)
      return { contextRef: context.ref, input: { ...original, corrected: true } }
    } }
  const workflow = synthetic(contract)
  workflow.nodes[0].execute = async ({ input }) => {
    if (!input.corrected) throw Object.assign(Error('库存需修复'), { code: 'INVENTORY_CHECK_FAILED', evidence: [{ actual: 1, expected: 2 }] })
    return { total: 2 }
  }
  const f = await fixture(t, workflow, { items: ['a', 'b'] }); artifactStore = f.artifacts
  const goal = await f.artifacts.put(requirement)
  await f.store.command({ id: 'bind-goal', kind: 'task.requirement.bind-legacy', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: goal.ref, sessionId: 'owner-session', criteria: requirement.acceptanceCriteria, sourceKey: 'source', eventKey: 'bound' } })
  const plan = await f.controller.advanceTaskPlan('task'), runId = plan.stages[0].runId
  const failed = await f.controller.whenIdle(runId)
  assert.equal(failed.run.status, 'waiting')
  let prepared
  const facade = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts,
    controller: { ...f.controller, changeInput: async request => { prepared = request; return { prepared: true } } } })
  const observed = await facade.inspectCurrentExecution('task')
  const decision = { repair: observed.repairBinding, evidenceRefs: observed.evidenceRefs }
  await facade.repairCurrentStage({ taskId: 'task', commandId: 'repair', decision })
  assert.equal(preparations, 1)
  const foreign = await f.artifacts.put({ taskId: 'other', runId: 'other', generation: 1 })
  for (const changed of [ { ...prepared, repairAdmission: undefined }, { ...prepared, repairAdmission: {} },
    { ...prepared, input: { ...prepared.input, items: ['arbitrary'] } },
    { ...prepared, repair: { ...prepared.repair, contextRef: foreign.ref } },
    { ...prepared, repair: { ...prepared.repair, generation: 99 } } ])
    await assert.rejects(f.controller.changeInput(changed), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  const db = new DatabaseSync(join(f.artifacts.root, '..', 'control.db'))
  try {
    db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('unknown-fixture','operation',?,?,?,?,?,'digest','{}','[]','fixture','unknown','now','now')")
      .run(runId, failed.nodes[0].nodeRunId, failed.nodes[0].nodeId, failed.run.generation, failed.nodes[0].inputDigest)
    assert.equal((await facade.inspectCurrentExecution('task')).repairable, false)
    await assert.rejects(f.controller.changeInput(prepared), /WORKFLOW_REPAIR_NOT_ADMITTED/)
    const nextInput = await f.artifacts.put(prepared.input)
    await assert.rejects(f.store.command({ id: 'race-input', kind: 'input.accept', args: { runId, inputId: 'race-input', sourceKey: 'race-input',
      requirementRef: nextInput.ref, expectedRevision: prepared.expectedRevision,
      repair: { ...prepared.repair, workflowDigest: failed.run.workflowDigest } } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
    // 只改变临时反例夹具；没有派发外部效果。
    db.prepare("UPDATE execution_effects SET state='failed' WHERE effect_id='unknown-fixture'").run()
  } finally { db.close() }
  await f.controller.changeInput(prepared)
  const repaired = await f.controller.whenIdle(runId)
  assert.equal(repaired.run.generation, 2); assert.equal(repaired.run.status, 'succeeded')
  assert.equal(repaired.run.claimCount, 2); assert.equal(repaired.run.maxClaims, failed.run.maxClaims)
  const binding = await f.store.query({ kind: 'workflow.repair.context', runId, generation: 2 })
  assert.equal(binding.workflowDigest, failed.run.workflowDigest); assert.equal(binding.contextRef, prepared.repair.contextRef)
  assert.deepEqual(await f.store.query({ kind: 'engineering.repair.context', runId, generation: 2 }), binding)
  assert.equal((await facade.repairCurrentStage({ taskId: 'task', commandId: 'repair', decision })).replayed, true)
  assert.equal(preparations, 1)
})

test('正式 Host 继续恢复外部旧/新定义，待执行阶段不套最新合同', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-contract-host-')), model = { provider: 'test', model: 'test' }
  const dbPath = join(root, 'control.db'), artifactDirectory = join(root, 'artifacts')
  const store = await openExecutionStore({ dbPath, instanceId: 'contract-host', initialize: true })
  t.after(() => store.close())
  const artifacts = await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
  const adapter = { id: 'local-fixture', version: '1', rulesDigest: 'a'.repeat(64),
    inspect: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') }, prepareOperation: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') } }
  const release = createReleaseTaskWorkflow({ kind: 'uat-deployment', adapter })
  const external = { releaseAdapters: { 'uat-deployment': adapter },
    operationAdapter: { execute: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') }, reconcile: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') } },
    authorizeExternal: async () => false, prepareRequirement: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') } }
  const externalConfig = { kind: 'external', registryVersion: '1', adapterId: adapter.id, adapterVersion: adapter.version, rulesDigest: adapter.rulesDigest }
  const legacyOwned = { ...release, ownerContract: legacyExternalWorkflowOwnerContract }
  let previous = createExecutionController({ store, artifacts, workflows: [release],
    delivery: { execute: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') } } })
  for (const [index, workflow] of [release, legacyOwned].entries()) {
    if (index) {
      await previous.close()
      previous = createExecutionController({ store, artifacts, workflows: [workflow],
        delivery: { execute: async () => { throw Error('UNEXPECTED_EXTERNAL_CALL') } } })
    }
    const definition = defineExecutionWorkflow(workflow)
    await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: { workflowId: workflow.id,
      definitionVersion: workflow.version, config: { ...externalConfig, ...(index ? { ownerContractVersion: '1' } : {}) }, digest: definition.digest } })
    await previous.createTaskPlan({ commandId: `plan:${index}`, taskId: `old-external-${index}`,
      stages: [{ stageId: 'first', workflowId: workflow.id, input: {} }] })
  }
  await previous.close(); await store.close()
  const options = { ctx: {}, config: { groupIds: ['g'], ownerActorId: 'owner', dbPath, artifactDirectory, instanceId: 'contract-host' },
    legacy: { getAgentConfig: () => model }, judge: async () => { throw Error('UNEXPECTED_MODEL_CALL') }, external,
    taskOwnerSessions: { async close() {} } }
  let service = await openWorkflowService(options)
  t.after(() => service.close())
  for (const workflow of [release, legacyOwned]) {
    const digest = defineExecutionWorkflow(workflow).digest
    const definition = service.execution.controller.workflowDefinition(workflow.id, digest)
    assert.equal(definition.digest, digest); assert.equal(definition.ownerContract?.version, workflow.ownerContract?.version)
  }
  const current = service.execution.controller.workflowDefinition(release.id)
  assert.equal(current.ownerContract.id, 'external-result')
  const currentRecord = (await service.execution.store.query({ kind: 'workflow.list' })).find(record => record.digest === current.digest)
  assert.equal(currentRecord.config.ownerContractVersion, '2')
  await service.execution.controller.createTaskPlan({ commandId: 'current-external', taskId: 'current-external',
    stages: [{ stageId: 'first', workflowId: release.id, input: {} }] })
  await service.close()
  service = await openWorkflowService(options)
  assert.equal(service.execution.controller.workflowDefinition(release.id, current.digest).ownerContract.id, 'external-result')
  const restored = await service.execution.controller.taskPlan('current-external')
  assert.equal(restored.stages[0].workflowDigest, current.digest)
})


test('复合验收只共享该条显式绑定的当前阶段证据，领域效果仍独立核验', async t => {
  const base = join(process.cwd(), 'docs/tmp/task-unified-file-storage')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'domain-evidence-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'domain-evidence', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const seen = []
  const general = createGeneralCapabilityStepWorkflow({ capabilities: [{ id: 'write', identity: 'write-v1', effectClass: 'file.write', authorize: () => true, prepare: () => ({}), verify: () => ({}) }],
    completionIdentity: 'test-v1', completionCheck: async () => { throw Error('原冻结合同内置验收不应重复执行') } }).ownerContract
  const workflows = ['write', 'delivery', 'unrelated'].map(domain => ({ ...synthetic({ id: domain, version: '1',
    async validateCompletion(context) {
      assert.ok(context.stages.every(item => item.contractId === domain))
      assert.equal(context.output.total, domain === 'unrelated' ? 3 : 2)
      assert.equal(context.output.hostExecution, undefined)
      return !context.acceptanceItems.length || await context.verifyAcceptance(context)
    } }), id: `task-${domain}`, nodes: [{ ...synthetic().nodes[0], execute: async ({ input }) => ({ domain, total: input.items.length }) }] }))
  workflows[0].ownerContract = general
  workflows[0].nodes[0].execute = async () => ({ output: { written: true }, verification: { passed: true, outputDigest: executionDigest({ written: true }) } })
  const digests = workflows.map(workflow => defineExecutionWorkflow(workflow).digest)
  let controller = createExecutionController({ store, artifacts, workflows })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: workflows.map((workflow, i) => ({ stageId: `stage-${i}`, workflowId: workflow.id, ...(i === 0 ? { input: { items: ['a', 'b'] } } : {}) })) })
  await store.command({ id: 'owner', kind: 'task.owner.init', args: { taskId: 'task', sessionId: 'owner', sourceKey: 'source', criteria: ['生成文件并发送本群'] } })
  let plan
  for (let i = 0; i < workflows.length; i++) {
    if (i) {
      plan = await controller.advanceTaskPlan('task')
      await controller.bindTaskStageInput({ commandId: `bind-${i}`, taskId: 'task', planRevision: plan.task.planRevision, stageId: `stage-${i}`, predecessorOutputRef: plan.stages[i - 1].outputRef, input: { items: ['a', 'b', ...(i === 2 ? ['c'] : [])] } })
    }
    plan = await controller.advanceTaskPlan('task')
    await controller.whenIdle(plan.stages[i].runId)
  }
  plan = await controller.advanceTaskPlan('task')
  await controller.close()
  controller = createExecutionController({ store, artifacts, workflows })
  for (const stage of plan.stages) await controller.recover({ commandId: `recover-${stage.stageId}`, runId: stage.runId })
  assert.deepEqual(workflows.map(workflow => defineExecutionWorkflow(workflow).digest), digests)
  assert.deepEqual(plan.stages.map(stage => stage.workflowDigest), digests)
  const [item] = await store.query({ kind: 'task.owner.acceptance', taskId: 'task' })
  const refs = plan.stages.slice(0, 2).map(stage => stage.outputRef)
  const decision = { action: 'complete', summary: '生成并发送', evidenceRefs: refs,
    assessments: [{ itemId: item.itemId, status: 'satisfied', evidenceRefs: refs }] }
  const helpers = createTaskWorkflowContracts({ store, artifacts, controller, verifyAcceptance: async context => {
    seen.push(context)
    return context.acceptanceItems[0].evidenceRefs.length === 2
      && context.stages.map(item => item.contractId).sort().join(',') === 'delivery,general-capability-result'
  } })
  assert.equal(await helpers.authorizeCompletion({ taskId: 'task', plan, requirement, decision }), true)
  assert.equal(seen.length, 2)
  for (const context of seen) {
    assert.deepEqual(context.acceptanceItems[0].evidenceRefs, refs)
    for (const item of context.stages) {
      const host = item.output.hostExecution
      assert.equal(host.taskId, 'task')
      assert.equal(host.stageId, item.stage.stageId)
      assert.equal(host.runId, item.stage.runId)
      assert.equal(host.predecessorOutputRef, item.stage.predecessorOutputRef)
      assert.ok(host.run.createdAt <= host.run.updatedAt)
      assert.ok(host.nodes.every(node => node.status === 'succeeded'))
      assert.deepEqual(host.planning, { receipts: [], truncated: false })
    }
  }
  const completed = { taskId: 'task', plan, requirement, decision }
  const truncated = createTaskWorkflowContracts({ store: { query: query => query.kind === 'task.owner.planning'
    ? { receipts: [], truncated: true } : store.query(query) }, artifacts, controller,
    verifyAcceptance: () => { throw Error('截断规划不能进入语义判断') } })
  assert.equal(await truncated.authorizeCompletion(completed), false)
  for (const verifyAcceptance of [undefined, async () => false]) {
    const rejected = createTaskWorkflowContracts({ store, artifacts, controller, verifyAcceptance })
    assert.equal(await rejected.authorizeCompletion(completed), false)
  }
  for (const bad of ['invented', 'tasks/other-task/sha256-' + 'a'.repeat(64) + '.json']) {
    const invalid = { ...decision, evidenceRefs: [...refs, bad], assessments: [{ ...decision.assessments[0], evidenceRefs: [...refs, bad] }] }
    assert.equal(await helpers.authorizeCompletion({ ...completed, decision: invalid }), false)
  }
  // 即便有写入和投递效果，业务语义校验不接受时也不得完成。
  const business = createTaskWorkflowContracts({ store, artifacts, controller, verifyAcceptance: async ({ stages }) =>
    stages.some(item => item.output.productionRepairVerified === true) })
  assert.equal(await business.authorizeCompletion({ ...completed, requirement: { ...requirement, request: '修复生产故障' } }), false)
})
