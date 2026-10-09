import { scriptedCoordinator } from './fixtures/group-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, executionDigest, executionError } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskWorkflowContracts, validateWorkflowRepairAdmission } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { readOnlyWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/task-readonly-workflows.js'
import { createGeneralCapabilityStepWorkflow } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { externalWorkflowOwnerContract, legacyExternalWorkflowOwnerContract, createReleaseTaskWorkflow } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { openWorkflowService } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { dataChangeProposalRepairPolicy } from '../packages/dingtalk-dsh-assistant/workflow-data-change.js'

test('数据变更候选修复仅接纳零外部效果，保留旧定义并以受信票据重做当前输入', async () => {
  const stage = { stageId: 'sql', runId: 'run', workflowId: 'task-data-change', workflowDigest: 'a'.repeat(64), status: 'running' }
  const plan = { task: { taskId: 'task', controlState: 'active', requirementRevision: 3, planRequirementRevision: 3, requirementRef: 'task-requirement' }, stages: [stage] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: stage.workflowId, workflowDigest: stage.workflowDigest,
    status: 'waiting', generation: 2, revision: 7, requirementRef: 'original' }, pendingInputCount: 0, nodes: [
      { nodeId: 'freeze-input', status: 'succeeded', drained: true, outputRef: 'frozen' },
      { nodeId: 'propose-sql', status: 'succeeded', drained: true, outputRef: 'proposal' },
      { nodeId: 'validate-package', status: 'waiting', drained: true, evidenceRefs: ['failure'], waitReason: { reference: 'DATA_CHANGE_PROPOSAL_INVALID' } },
      { nodeId: 'approval-gate', status: 'blocked', drained: true },
    ] }
  const original = { request: '增加name列', target: { database: 'editor' }, constraints: [], sources: [{ id: 'message', content: '增加name列' }] }
  const values = { original, 'task-requirement': original, proposal: { applySql: '' }, failure: { code: 'DATA_CHANGE_PROPOSAL_INVALID' } }
  let effects = [], changed, prepared = 0
  const contract = Object.freeze({ id: 'native-data-change', version: '3' })
  const facade = createTaskWorkflowContracts({
    controller: { taskPlan: async () => plan, state: async () => state, workflowDefinition: () => ({ ownerContract: contract }),
      changeInput: async value => { changed = value; return { accepted: true } } },
    store: { query: async ({ kind }) => kind === 'effect.list' ? effects : null },
    artifacts: { read: async ref => values[ref] },
    prepareDataChangeRepairInput: async ({ repairConstraints }) => { prepared++
      values.context = { taskId: 'task', runId: 'run', generation: 2 }
      return { contextRef: 'context', input: { ...original, constraints: repairConstraints, sources: [...original.sources, { id: 'current-query', content: '当前表只有id列' }] } }
    },
  })
  const observed = await facade.inspectCurrentExecution('task')
  assert.equal(observed.repairable, true); assert.equal(observed.requiresCurrentQuery, true)
  assert.equal(contract.inspectRepair, undefined)
  const decision = { summary: '读取当前表结构并补齐SQL候选', repair: observed.repairBinding, evidenceRefs: ['failure', 'proposal'] }
  for (const effect of ['succeeded', 'failed', 'unknown', 'sending']) {
    effects = [{ state: effect }]
    assert.equal((await facade.inspectCurrentExecution('task')).repairable, false)
    await assert.rejects(facade.repairCurrentStage({ taskId: 'task', commandId: `deny-${effect}`, decision }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  }
  effects = []
  state.nodes.at(-1).status = 'succeeded'; state.nodes.at(-1).outputRef = 'approval'
  assert.equal((await facade.inspectCurrentExecution('task')).repairable, false)
  state.nodes.at(-1).status = 'blocked'; delete state.nodes.at(-1).outputRef
  assert.deepEqual(await facade.repairCurrentStage({ taskId: 'task', commandId: 'repair', decision }), { accepted: true })
  assert.equal(prepared, 1); assert.equal(changed.expectedRevision, 7)
  assert.equal(changed.input.constraints.includes(`候选修正：${decision.summary}`), true)
  const admission = { state, plan, definition: { digest: stage.workflowDigest, ownerContract: contract }, ...changed,
    store: { query: async () => effects }, artifacts: { read: async ref => values[ref] } }
  assert.equal(await validateWorkflowRepairAdmission(admission), stage.workflowDigest)
  effects = [{ state: 'succeeded' }]
  await assert.rejects(validateWorkflowRepairAdmission(admission), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  effects = []
  await assert.rejects(validateWorkflowRepairAdmission({ ...admission, repairAdmission: {} }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  await assert.rejects(validateWorkflowRepairAdmission({ ...admission, input: { ...changed.input, request: '删除库' } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  original.constraints = [`候选修正：${decision.summary}`]
  await assert.rejects(facade.repairCurrentStage({ taskId: 'task', commandId: 'repeat', decision }), /DATA_CHANGE_REPAIR_STRATEGY_REPEATED/)
  assert.equal(prepared, 1)
})

test('数据变更候选修复拒绝缺少受信查询修正和目标漂移', async () => {
  const original = { request: '增加列', target: { database: 'editor' }, constraints: [] }
  const context = { state: { run: { requirementRef: 'input' }, nodes: [{ nodeId: 'propose-sql', outputRef: 'proposal' }] },
    artifacts: { read: async ref => ref === 'input' ? original : {} }, observed: { evidenceRefs: ['failure'] }, decision: { summary: '补全候选' } }
  await assert.rejects(dataChangeProposalRepairPolicy.prepareRepair(context), /DATA_CHANGE_REPAIR_CONTEXT_REQUIRED/)
  for (const build of [() => original, constraints => ({ ...original, constraints, target: { database: 'other' } }),
    constraints => ({ ...original, constraints, request: '删除库' }), () => ({ ...original, sources: [{ id: 'unbound' }] })]) {
    await assert.rejects(dataChangeProposalRepairPolicy.prepareRepair({ ...context,
      prepareDataChangeRepairInput: async ({ repairConstraints }) => ({ input: build(repairConstraints), contextRef: 'context' }) }), /DATA_CHANGE_REPAIR_INPUT_UNCHANGED/)
  }
  const fact = { kind: 'verified-task-query', capabilityId: 'production-schema', result: { columns: ['id'] } }
  original.sources = [{ id: 'old-query', content: JSON.stringify({ ...fact, evidenceRef: 'old-query' }) }]
  await assert.rejects(dataChangeProposalRepairPolicy.prepareRepair({ ...context,
    decision: { summary: '换一种表述重新尝试' }, prepareDataChangeRepairInput: async ({ repairConstraints }) => ({ contextRef: 'context',
      input: { ...original, constraints: repairConstraints, sources: [
        ...original.sources, { id: 'new-query', content: JSON.stringify({ ...fact, evidenceRef: 'new-query' }) },
      ] } }),
  }), /DATA_CHANGE_REPAIR_INPUT_UNCHANGED/)
})

test('候选修复附带查询与阶段诊断独立核验，不能省略原诊断或借用旧任务阶段证明', async () => {
  const stage = { stageId: 'sql', runId: 'run', workflowId: 'task-data-change', workflowDigest: 'a'.repeat(64), status: 'running' }
  const plan = { task: { taskId: 'task', planRevision: 1, controlState: 'active', requirementRevision: 3,
    planRequirementRevision: 3, requirementRef: 'requirement' }, stages: [stage] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: stage.workflowId, workflowDigest: stage.workflowDigest,
    status: 'waiting', generation: 2, revision: 7, requirementRef: 'original' }, pendingInputCount: 0, nodes: [
    { nodeId: 'freeze-input', status: 'succeeded', drained: true },
    { nodeId: 'propose-sql', status: 'succeeded', drained: true, outputRef: 'proposal' },
    { nodeId: 'validate-package', nodeRunId: 'failed-node', leaseEpoch: 1, status: 'waiting', drained: true,
      evidenceRefs: ['failure'], waitReason: { reference: 'DATA_CHANGE_PROPOSAL_INVALID' } },
  ] }
  const original = { request: '增加列', target: { database: 'editor' }, constraints: [], sources: [{ content: '原文' }] }
  const record = { artifactRef: 'query', turnId: 'query-turn', leaseEpoch: 4, requirementRevision: 3 }
  const result = { columns: ['id'] }
  const query = { kind: 'agent-query-evidence', execution: { kind: 'task-owner', taskId: 'task',
    requirementRevision: 3, turnId: record.turnId, leaseEpoch: record.leaseEpoch }, result,
    verification: { sourceRefs: ['production-catalog'], outputDigest: executionDigest(result) } }
  let records = [record], events = [], changed, preparations = 0
  const values = { original, requirement: original, failure: { code: 'DATA_CHANGE_PROPOSAL_INVALID' }, proposal: { applySql: '' }, query }
  const contract = Object.freeze({ id: 'native-data-change', version: '3' })
  const store = { query: async ({ kind }) => kind === 'effect.list' ? [] : kind === 'task.owner.query-evidence' ? records
    : kind === 'task.owner.events' ? events : null }
  const artifacts = { read: async ref => values[ref] }
  const facade = createTaskWorkflowContracts({ store, artifacts,
    controller: { taskPlan: async () => plan, state: async () => state, workflowDefinition: () => ({ ownerContract: contract }),
      changeInput: async request => { changed = request; return { accepted: true } } },
    prepareDataChangeRepairInput: async ({ repairConstraints }) => { preparations++
      values.context = { taskId: 'task', runId: 'run', generation: 2 }
      return { input: { ...original, constraints: repairConstraints, sources: [{ content: '原文' }, { content: '当前目录列:id' }] }, contextRef: 'context' }
    },
  })
  const observed = await facade.inspectCurrentExecution('task')
  values.wrapper = { taskId: 'task', planRevision: 1, stageId: 'sql', runId: 'run', workflowId: stage.workflowId,
    currentExecution: { repairBinding: observed.repairBinding }, diagnostics: [{ nodeRunId: 'failed-node', generation: 2, leaseEpoch: 1 }] }
  events = [{ eventSeq: 1, eventType: 'workflow.failed', payloadRef: 'wrapper' }]
  const decision = { summary: '依据目录资料补齐候选', repair: observed.repairBinding, evidenceRefs: ['failure', 'proposal', 'query', 'wrapper'] }
  const reject = async (refs, commandId) => assert.rejects(facade.repairCurrentStage({ taskId: 'task', commandId,
    decision: { ...decision, evidenceRefs: refs } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  await reject(['query', 'wrapper'], 'only-extra')
  await reject(['failure', 'query'], 'missing-proposal')
  for (const [name, extra] of [
    ['foreign-task', { ...query, execution: { ...query.execution, taskId: 'foreign' } }],
    ['old-revision', { ...query, execution: { ...query.execution, requirementRevision: 2 } }],
    ['bad-query-digest', { ...query, result: { columns: ['forged'] } }],
    ['other-stage', { ...values.wrapper, stageId: 'other' }],
    ['other-run', { ...values.wrapper, runId: 'other' }],
    ['old-generation', { ...values.wrapper, diagnostics: [{ nodeRunId: 'failed-node', generation: 1, leaseEpoch: 1 }] }],
    ['old-binding', { ...values.wrapper, currentExecution: { repairBinding: { ...observed.repairBinding, generation: 1 } } }],
    ['old-plan', { ...values.wrapper, planRevision: 0 }],
    ['goal-material', { content: '普通任务材料' }],
  ]) {
    values[name] = extra
    records = extra.kind === 'agent-query-evidence' ? [record, { ...record, artifactRef: name }] : [record]
    events = [events[0], { eventSeq: 2, eventType: 'workflow.failed', payloadRef: name }]
    await reject(['failure', 'proposal', name], name)
  }
  records = [record]; events = [events[0]]
  values.unrecorded = values.wrapper
  await reject(['failure', 'proposal', 'unrecorded'], 'unrecorded')
  assert.equal(preparations, 0)
  assert.deepEqual(await facade.repairCurrentStage({ taskId: 'task', commandId: 'valid', decision }), { accepted: true })
  assert.equal(preparations, 1)
  const admission = { state, plan, definition: { digest: stage.workflowDigest, ownerContract: contract }, ...changed, store, artifacts }
  assert.equal(await validateWorkflowRepairAdmission(admission), stage.workflowDigest)
  records = []
  await assert.rejects(validateWorkflowRepairAdmission(admission), /WORKFLOW_REPAIR_NOT_ADMITTED/)
})

test('数据变更候选通过真实控制账新generation重新生成，原失败与冻结digest保留且无外部效果', async t => {
  const input = { request: '编写增加列的候选', target: { database: 'editor' }, sources: [{ id: 'message', content: '增加列' }], constraints: [] }
  const workflow = { id: 'task-data-change', version: '7', ownerContract: externalWorkflowOwnerContract, nodes: [
    { id: 'freeze-input', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input },
    { id: 'propose-sql', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => ({ applySql: input.sources.length > 1 ? 'candidate-only' : '' }) },
    { id: 'validate-package', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ previousOutput }) => previousOutput, execute: async ({ input }) => {
        if (!input.applySql) throw executionError('DATA_CHANGE_PROPOSAL_INVALID'); return input
      } },
  ] }
  const f = await fixture(t, workflow, input)
  const goal = await f.artifacts.put(requirement)
  await f.store.command({ id: 'sql-bind-goal', kind: 'task.requirement.bind-legacy', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: goal.ref, sessionId: 'owner-session', criteria: requirement.acceptanceCriteria, sourceKey: 'source', eventKey: 'bound' } })
  const plan = await f.controller.advanceTaskPlan('task'), runId = plan.stages[0].runId
  await f.controller.whenIdle(runId)
  const before = await f.controller.state(runId)
  assert.equal(before.run.status, 'waiting')
  const facade = createTaskWorkflowContracts({ controller: f.controller, store: f.store, artifacts: f.artifacts,
    prepareDataChangeRepairInput: async ({ repairConstraints, state }) => ({ input: { ...input,
      constraints: repairConstraints, sources: [...input.sources, { id: 'verified-query', content: '当前表只有id列' }] },
      contextRef: (await f.artifacts.put({ taskId: 'task', runId, generation: state.run.generation }, { taskId: 'task' })).ref }),
  })
  const observed = await facade.inspectCurrentExecution('task')
  assert.equal(observed.repairable, true)
  await facade.repairCurrentStage({ taskId: 'task', commandId: 'sql-repair', decision: {
    summary: '根据当前查询补齐完整候选', repair: observed.repairBinding, evidenceRefs: observed.evidenceRefs,
  } })
  await f.controller.whenIdle(runId)
  const after = await f.controller.state(runId)
  assert.equal(after.run.status, 'succeeded'); assert.equal(after.run.generation, before.run.generation + 1)
  assert.equal(after.run.workflowDigest, before.run.workflowDigest)
  assert.deepEqual(await f.store.query({ kind: 'effect.list', runId }), [])
  const oldFailure = before.nodes.find(node => node.nodeId === 'validate-package').evidenceRefs[0]
  assert.equal((await f.artifacts.read(oldFailure)).code, 'DATA_CHANGE_PROPOSAL_INVALID')
  assert.equal(workflow.ownerContract.inspectRepair, undefined)
})

test('冻结SQL校验只在当前Host纯只读预检通过后恢复，静态证明不随回执时间或源引用变化', async t => {
  let supported = false, calls = 0
  const candidate = { applySql: 'ALTER TABLE public.process_id_temp ADD COLUMN is_deleted integer DEFAULT 0;',
    rollbackSql: '仅作回滚预案', verificationSql: '只读目录查询', expectedChange: '{"rows":[]}' }
  const input = { request: '增加is_deleted整型默认0', target: { instance: 'postgres', database: 'editor', environment: 'production' },
    constraints: [], sources: [{ id: 'current-query', content: '当前只有id列' }] }
  const workflow = { id: 'task-data-change', version: '7', ownerContract: externalWorkflowOwnerContract, nodes: [
    { id: 'freeze-input', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input },
    { id: 'propose-sql', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
      mapInput: ({ previousOutput }) => previousOutput, execute: async () => candidate },
    { id: 'validate-package', version: '1', executor: 'code', allowedEffects: ['read'], rulesDigest: 'b'.repeat(64), inputSchema: schema, outputSchema: schema,
      mapInput: ({ requirement, previousOutput }) => ({ requirement, proposal: previousOutput }), execute: async ({ input }) => {
        calls++
        if (!supported) throw executionError('BYTEBASE_PRECONDITIONS_UNCONFIRMED')
        const body = { ...input.proposal, target: input.requirement.target, applySqlSha256: 'c'.repeat(64),
          sourceDigest: executionDigest(input.requirement.sources), baseline: { snapshotId: `read-${calls}`, sha256: 'd'.repeat(64) } }
        return { ...body, validation: { adapterId: 'native-postgres', adapterVersion: '1', packageDigest: executionDigest(body), receiptId: `receipt-${calls}` } }
      } },
  ] }
  const f = await fixture(t, workflow, input), goal = await f.artifacts.put(requirement)
  await f.store.command({ id: 'sql-validation-bind-goal', kind: 'task.requirement.bind-legacy', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: goal.ref, sessionId: 'owner-session', criteria: requirement.acceptanceCriteria, sourceKey: 'source', eventKey: 'bound' } })
  const plan = await f.controller.advanceTaskPlan('task'), runId = plan.stages[0].runId
  await f.controller.whenIdle(runId)
  const before = await f.controller.state(runId)
  const facade = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts, controller: f.controller,
    prepareDataChangeRepairInput: async ({ repairConstraints, observed, state }) => ({
      input: { ...input, constraints: repairConstraints, sources: [...input.sources, observed.validationSource] },
      contextRef: (await f.artifacts.put({ taskId: 'task', runId, generation: state.run.generation }, { taskId: 'task' })).ref,
    }),
  })
  assert.equal((await facade.inspectCurrentExecution('task')).repairable, false)
  supported = true
  const observed = await facade.inspectCurrentExecution('task')
  assert.equal(observed.repairable, true); assert.ok(observed.validationSource)
  const repeated = await facade.inspectCurrentExecution('task')
  assert.deepEqual(repeated.validationSource, observed.validationSource)
  assert.equal(observed.validationSource.content.includes('receipt-'), false)
  assert.equal(observed.validationSource.content.includes('read-'), false)
  assert.equal(observed.validationSource.content.includes('sourceDigest'), false)
  supported = false
  await assert.rejects(facade.repairCurrentStage({ taskId: 'task', commandId: 'still-failed', decision: {
    summary: '确认原SQL仅修复Host准备校验', repair: observed.repairBinding, evidenceRefs: observed.evidenceRefs,
  } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  supported = true
  await facade.repairCurrentStage({ taskId: 'task', commandId: 'validation-repair', decision: {
    summary: '确认原SQL仅修复Host准备校验', repair: observed.repairBinding, evidenceRefs: observed.evidenceRefs,
  } })
  await f.controller.whenIdle(runId)
  const after = await f.controller.state(runId)
  assert.equal(after.run.status, 'succeeded'); assert.equal(after.run.generation, before.run.generation + 1)
  assert.equal(after.run.workflowDigest, before.run.workflowDigest)
  assert.deepEqual(await f.store.query({ kind: 'effect.list', runId }), [])
})

const schema = { type: 'object' }

test('Owner根据真实Host检查事实选择任务副本修订，未知错误不强迫修改业务',async()=>{
 const stage={stageId:'engineering',runId:'run',workflowId:'task-engineering-test',workflowDigest:'digest',status:'running'}
 const plan={task:{controlState:'active',requirementRevision:2,planRequirementRevision:2},stages:[stage]}
 const state={run:{taskId:'task',runId:'run',workflowId:stage.workflowId,workflowDigest:'digest',status:'waiting',generation:4,revision:8},pendingInputCount:0,nodes:[{nodeId:'verify-candidate',status:'waiting',drained:true,evidenceRefs:['real-log'],waitReason:{reference:'ARBITRARY_HOST_FAILURE'}}]}
 const caps={checkProfiles:[{digest:'trusted',checks:[{id:'test',args:['--test']}]}]};let received,effects=[]
 const facade=createTaskWorkflowContracts({controller:{taskPlan:async()=>plan,state:async()=>state,workflowDefinition:()=>({})},store:{query:async q=>q.kind==='effect.list'?effects:null},artifacts:{read:async()=>({})},inspectWorkflowRevision:async()=>caps,reviseWorkflow:async args=>{received=args;return {queued:true}}})
 const observed=await facade.inspectCurrentExecution('task')
 assert.equal(observed.repairable,true);assert.equal(observed.mode,'workflow-revision');assert.deepEqual(observed.evidenceRefs,['real-log'])
 const decision={repair:observed.repairBinding,summary:'原配置选择不存在的测试；选择Host已登记的自动发现检查',evidenceRefs:['real-log'],workflowRevision:{startNodeId:'verify-candidate',checkProfileDigest:'trusted'}}
 assert.deepEqual(await facade.repairCurrentStage({taskId:'task',commandId:'revise',decision}),{queued:true})
 assert.equal(received.expectedRevision,8);assert.deepEqual(received.revision,decision.workflowRevision)
 await assert.rejects(facade.repairCurrentStage({taskId:'task',commandId:'foreign',decision:{...decision,evidenceRefs:['other-task']}}),/WORKFLOW_REPAIR_NOT_ADMITTED/)
 effects=[{state:'unknown'}];assert.equal((await facade.inspectCurrentExecution('task')).repairable,false)
})
const requirement = { request: '按现有材料回答问题', acceptanceCriteria: ['给出有依据的调查结论'], constraints: [], scope: {} }
const synthetic = (ownerContract, version = '1') => ({ id: 'task-inventory-count', version, ...(ownerContract ? { ownerContract } : {}), nodes: [
  { id: 'count', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema,
    mapInput: ({ requirement }) => requirement, execute: async ({ input }) => ({ total: input.items.length }) },
] })

async function fixture(t, workflow, input, sessions, inputs = [input]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-contract-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'contract', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let controller = createExecutionController({ store, artifacts, sessions, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: inputs.map((input, index) => ({ stageId: index ? `next-${index}` : 'first', workflowId: workflow.id, ...(index ? {} : { input }) })) })
  await store.command({ id: 'owner', kind: 'task.owner.init', args: { taskId: 'task', sessionId: 'owner-session', sourceKey: 'source', criteria: requirement.acceptanceCriteria } })
  let helpers = createTaskWorkflowContracts({ controller, store, artifacts })
  async function finish() {
    let plan
    for (let index = 0; index < inputs.length; index++) {
      if (index) {
        plan = await controller.advanceTaskPlan('task')
        await controller.bindTaskStageInput({ commandId: `bind-${index}`, taskId: 'task', planRevision: plan.task.planRevision,
          stageId: `next-${index}`, predecessorOutputRef: plan.stages[index - 1].outputRef, input: inputs[index] })
      }
      plan = await controller.advanceTaskPlan('task')
      await controller.whenIdle(plan.stages[index].runId)
    }
    plan = await controller.advanceTaskPlan('task')
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
  await assert.rejects(f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision, assessments: [] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  await assert.rejects(f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision, evidenceRefs: ['invented'] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  await assert.rejects(f.helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision,
    assessments: [{ ...completed.decision.assessments[0], status: 'unsatisfied' }] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
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
  assert.equal(reads, 2); assert.equal(checks, 1)
  assert.equal(f.controller.workflowDefinition(workflow.id, original.digest).ownerContract.version, '1')
  assert.equal(Object.isFrozen(f.controller.workflowDefinition(workflow.id, original.digest).ownerContract), true)
  await assert.rejects(f.helpers.readStageArtifacts({ taskId: 'other', stage, state, plan: completed.plan }), /WORKFLOW_OWNER_STAGE_MISMATCH/)
  await assert.rejects(f.helpers.readStageArtifacts({ taskId: 'task', stage: { ...stage, outputRef: 'foreign' }, state, plan: completed.plan }), /WORKFLOW_OWNER_STAGE_MISMATCH/)
})

test('冻结合同的只读完成策略把原始节点正文同时交给Owner及语义验收，不扩大完成引用', async t => {
  const frozen = { id: 'external-result', version: '3', validateCompletion: () => true }
  const workflow = synthetic(frozen)
  workflow.nodes.push({ ...workflow.nodes[0], id: 'summary', mapInput: ({ previousOutput }) => previousOutput,
    execute: async () => ({ summary: '已完成', hostExecution: { domainEvidence: { total: 999 } } }) })
  const originalDigest = defineExecutionWorkflow(workflow).digest
  const f = await fixture(t, workflow, { items: ['a', 'b'] }), completed = await f.finish()
  const stage = completed.plan.stages[0], state = await f.controller.state(stage.runId)
  const nodeRef = state.nodes[0].outputRef
  let invalid = false, observed
  const policy = { ...frozen, version: '4',
    async readArtifacts({ stage, state, artifacts, store }) {
      assert.equal(store.command, undefined); assert.equal(artifacts.put, undefined)
      const ref = invalid ? 'foreign-node' : state.nodes[0].outputRef
      return { completionEvidenceRefs: [stage.outputRef], nodeArtifacts: [{ nodeId: 'count', artifactRef: ref }],
        domainEvidence: { nodeRef: ref, body: await artifacts.read(state.nodes[0].outputRef) } }
    },
    async validateCompletion({ verifyAcceptance }) { return verifyAcceptance() },
  }
  const helpers = createTaskWorkflowContracts({ controller: f.controller, store: f.store, artifacts: f.artifacts,
    completionPolicy(contract, context) {
      assert.equal(context.stage.runId, stage.runId)
      return contract.version === '3' ? policy : contract
    },
    verifyAcceptance(context) { observed = context.stages[0].output.hostExecution.domainEvidence; return true },
  })
  const extension = await helpers.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan })
  assert.deepEqual(extension.completionEvidenceRefs, [stage.outputRef])
  assert.equal(extension.nodeArtifacts[0].artifactRef, nodeRef)
  assert.equal(await helpers.authorizeCompletion(completed), true)
  assert.deepEqual(observed, extension.domainEvidence)
  assert.equal(observed.body.total, 2)
  assert.equal(f.controller.workflowDefinition(workflow.id, originalDigest).ownerContract.version, '3')
  assert.equal(stage.workflowDigest, originalDigest)
  await assert.rejects(helpers.authorizeCompletion({ ...completed, decision: { ...completed.decision,
    evidenceRefs: [nodeRef], assessments: [{ ...completed.decision.assessments[0], evidenceRefs: [nodeRef] }] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  invalid = true
  await assert.rejects(helpers.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan }), /TASK_OWNER_ARTIFACT_SCOPE_MISMATCH/)
  await assert.rejects(helpers.authorizeCompletion(completed), /TASK_OWNER_ARTIFACT_SCOPE_MISMATCH/)
})

test('未绑定合同的旧定义保留产出读取，但完成和修复不得套用当前合同', async t => {
  const f = await fixture(t, synthetic(), { items: [] }), completed = await f.finish(), stage = completed.plan.stages[0]
  await f.restart(synthetic({ id: 'inventory-result', version: '2', validateCompletion: () => true }, '2'))
  assert.deepEqual(await f.helpers.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan }), {})
  await assert.rejects(f.helpers.authorizeCompletion(completed), /WORKFLOW_OWNER_CONTRACT_UNAVAILABLE/)
  const waitingPlan = { ...completed.plan, stages: [{ ...stage, status: 'running' }] }
  const inspect = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts,
    controller: { ...f.controller, taskPlan: async () => waitingPlan } })
  assert.equal((await inspect.inspectCurrentExecution('task')).repairable, false)
  await assert.rejects(inspect.repairCurrentStage({ taskId: 'task', decision: {}, commandId: 'legacy-repair' }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  // 已终态旧定义未加载也可读取，不能回退为当前版本。
  const unloaded = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts,
    controller: { ...f.controller, workflowDefinition() { throw Object.assign(Error('missing'), { code: 'WORKFLOW_VERSION_UNAVAILABLE' }) } } })
  assert.deepEqual(await unloaded.readStageArtifacts({ taskId: 'task', stage, plan: completed.plan }), {})
  await assert.rejects(unloaded.authorizeCompletion(completed), /WORKFLOW_OWNER_CONTRACT_UNAVAILABLE/)
})

test('同领域连续状态变更按当前验收逐阶段分派，历史证明仍核验且不得冒充最新状态', async t => {
  const calls = [], workflow = synthetic({ id: 'state-change', version: '1', validateCompletion: () => true })
  const f = await fixture(t, workflow, { items: ['added'] }, undefined, [{ items: ['added'] }, { items: [] }])
  const completed = await f.finish(), [add, drop] = completed.plan.stages
  const decision = { ...completed.decision, evidenceRefs: [drop.outputRef], assessments: completed.decision.assessments.map(item => ({ ...item, evidenceRefs: [drop.outputRef] })) }
  let corruptHistory = false
  const policy = { id: 'state-change', version: '2', async readArtifacts(context) {
    const output = await context.artifacts.read(context.stage.outputRef)
    if (corruptHistory && context.stage.stageId === add.stageId) throw Error('HISTORICAL_EFFECT_INVALID')
    const current = (context.acceptanceItems ?? []).length > 0
    calls.push({ stageId: context.stage.stageId, current })
    if (current && output.total !== 0) throw Error('CURRENT_STATE_UNCONFIRMED')
    return { completionEvidenceRefs: [context.stage.outputRef], domainEvidence: { total: output.total, current } }
  }, async validateCompletion(context) {
    await this.readArtifacts(context)
    return !context.acceptanceItems.length || await context.verifyAcceptance()
  } }
  const helpers = createTaskWorkflowContracts({ controller: f.controller, artifacts: f.artifacts, store: f.store,
    completionPolicy: () => policy, verifyAcceptance: async context => {
      assert.deepEqual(context.stages.map(item => item.stage.stageId), [drop.stageId])
      assert.equal(context.stages[0].output.hostExecution.domainEvidence.current, true)
      return true
    } })
  await helpers.readStageArtifacts({ taskId: 'task', stage: add, plan: completed.plan })
  assert.deepEqual(calls.pop(), { stageId: add.stageId, current: false })
  assert.equal(await helpers.authorizeCompletion({ ...completed, decision }), true)
  assert.ok(calls.some(item => item.stageId === add.stageId && !item.current))
  assert.ok(!calls.some(item => item.stageId === add.stageId && item.current))
  await assert.rejects(helpers.authorizeCompletion({ ...completed, decision: { ...decision, assessments: [] } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  await assert.rejects(helpers.authorizeCompletion(completed), /CURRENT_STATE_UNCONFIRMED/)
  corruptHistory = true
  await assert.rejects(helpers.authorizeCompletion({ ...completed, decision }), /HISTORICAL_EFFECT_INVALID/)
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

test('失败阶段使用Host节点续行资格，绑定诊断和策略且不重建阶段输入', async () => {
  const stage = { stageId: 'first', runId: 'run', workflowId: 'task-inventory-count', workflowDigest: 'a'.repeat(64), status: 'blocked' }
  const plan = { task: { taskId: 'task', controlState: 'active', requirementRevision: 3, planRequirementRevision: 3, planRevision: 2, controlRevision: 1 }, stages: [stage] }
  const state = { run: { taskId: 'task', runId: 'run', workflowId: stage.workflowId, workflowDigest: stage.workflowDigest,
    status: 'failed', generation: 2, revision: 7 }, nodes: [{ nodeId: 'read', nodeRunId: 'node', status: 'failed', drained: true, evidenceRefs: ['failure'] }] }
  const recovery = { repairable: true, mode: 'resume-agent', reason: 'QUERY_PARAMETER_INVALID', nodeId: 'read', nodeRunId: 'node', leaseEpoch: 4,
    inputDigest: 'b'.repeat(64), generation: 2, runRevision: 7, evidenceRefs: ['failure'], problemKey: 'c'.repeat(64) }
  let resumed, persisted, reads = 0
  const helpers = createTaskWorkflowContracts({ store: { query: async () => null },
    artifacts: { read: async ref => { assert.equal(ref, 'failure'); reads++; return { code: recovery.reason } },
      put: async (value, scope) => { assert.deepEqual(scope, { taskId: 'task' }); persisted = value; return { ref: 'recovery-context' } } },
    controller: { taskPlan: async () => plan, state: async () => state, workflowDefinition: () => ({}), inspectNodeRecovery: async () => recovery,
      resumeNode: async value => { resumed = value; return { resumed: true } }, changeInput: async () => { throw Error('INPUT_CHANGE_NOT_ALLOWED') } } })
  const observed = await helpers.inspectCurrentExecution('task')
  assert.equal(observed.repairable, true); assert.equal(observed.stageId, 'first')
  const decision = { action: 'repairCurrentStage', summary: '修正查询字段拼写，继续读取当前表', repair: observed.repairBinding, evidenceRefs: ['failure'] }
  await assert.rejects(helpers.repairCurrentStage({ taskId: 'task', commandId: 'bad-ref', decision: { ...decision, evidenceRefs: ['foreign'] } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  await assert.rejects(helpers.repairCurrentStage({ taskId: 'task', commandId: 'stale', decision: { ...decision, repair: { ...decision.repair, runRevision: 6 } } }), /WORKFLOW_REPAIR_NOT_ADMITTED/)
  assert.deepEqual(await helpers.repairCurrentStage({ taskId: 'task', commandId: 'resume', decision }), { resumed: true })
  assert.equal(reads, 1)
  assert.deepEqual(persisted, { kind: 'execution-recovery-context', taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 2,
    problemKey: recovery.problemKey, requirementRevision: 3, planRevision: 2, controlRevision: 1,
    diagnosis: decision.summary, strategy: decision.summary, evidenceRefs: ['failure'] })
  assert.deepEqual(resumed, { commandId: 'resume', runId: 'run', expectedRevision: 7, nodeRunId: 'node', generation: 2,
    leaseEpoch: 4, inputDigest: recovery.inputDigest, contextRef: 'recovery-context' })
  plan.task.planRequirementRevision = 2
  assert.equal((await helpers.inspectCurrentExecution('task')).repairable, false)
  recovery.evidenceRefs = ['foreign']
  await assert.rejects(helpers.inspectCurrentExecution('task'), /WORKFLOW_OWNER_ARTIFACT_SCOPE_MISMATCH/)
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
  assert.equal(seen.length, 1)
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
  await assert.rejects(truncated.authorizeCompletion(completed), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  for (const verifyAcceptance of [undefined, async () => false]) {
    const rejected = createTaskWorkflowContracts({ store, artifacts, controller, verifyAcceptance })
    await assert.rejects(rejected.authorizeCompletion(completed), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  }
  for (const bad of ['invented', 'tasks/other-task/sha256-' + 'a'.repeat(64) + '.json']) {
    const invalid = { ...decision, evidenceRefs: [...refs, bad], assessments: [{ ...decision.assessments[0], evidenceRefs: [...refs, bad] }] }
    await assert.rejects(helpers.authorizeCompletion({ ...completed, decision: invalid }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  }
  // 即便有写入和投递效果，业务语义校验不接受时也不得完成。
  const business = createTaskWorkflowContracts({ store, artifacts, controller, verifyAcceptance: async ({ stages }) =>
    stages.some(item => item.output.productionRepairVerified === true) })
  await assert.rejects(business.authorizeCompletion({ ...completed, requirement: { ...requirement, request: '修复生产故障' } }), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
})


test('完成拒绝沿原错误合同返回具体门禁、阶段及当前版本，不折叠原诊断异常', async t => {
  const contract = { id: 'fixture-domain', version: '7', validateCompletion: async () => false }
  const f = await fixture(t, synthetic(contract), { items: ['a','b'] }), completed = await f.finish()
  await assert.rejects(f.helpers.authorizeCompletion(completed), error => {
    assert.equal(error.code, 'TASK_OWNER_COMPLETION_UNVERIFIED')
    assert.equal(error.completionGate.gate, 'domain-completion')
    assert.equal(error.completionGate.stageId, completed.plan.stages[0].stageId)
    assert.deepEqual(error.completionGate.contract, { id: 'fixture-domain', version: '7' })
    assert.match(error.message, /domain-completion/)
    return true
  })
  await assert.rejects(f.helpers.authorizeCompletion({ ...completed, plan: { ...completed.plan,
    task: { ...completed.plan.task, planRequirementRevision: 0 } } }), error => {
    assert.equal(error.completionGate.gate, 'plan-current-and-complete')
    assert.equal(error.completionGate.planRequirementRevision, 0)
    assert.equal(error.completionGate.requirementRevision, completed.plan.task.requirementRevision)
    return true
  })
  const original = Object.assign(new Error('原始领域实际判定'), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED', diagnosticRef: 'trusted-original' })
  const throwing = createTaskWorkflowContracts({ store: f.store, artifacts: f.artifacts, controller: f.controller,
    completionPolicy: () => ({ ...contract, validateCompletion: async () => { throw original } }) })
  await assert.rejects(throwing.authorizeCompletion(completed), error => error === original && error.diagnosticRef === 'trusted-original')
})

test('无调查阶段以当前任务原生查询证据验收，拒绝伪造引用及旧需求证据', async () => {
  const proof = { taskId: 'direct', requirementRevision: 3, evidenceRef: 'query-proof', artifactRef: 'query-proof',
    queryId: 'query_readonly_database', turnId: 'turn', leaseEpoch: 4, result: { rows: [{ column_name: 'name' }] }, evidence: { result: { rows: [{ column_name: 'name' }] } } }
  const item = { itemId: 'item', criterion: '确认目标列存在' }
  const plan = { task: { taskId: 'direct', requirementRevision: 3, status: 'active', planRevision: 0 }, stages: [] }
  const decision = { action: 'complete', summary: '列存在', evidenceRefs: ['query-proof'],
    assessments: [{ itemId: 'item', status: 'satisfied', evidenceRefs: ['query-proof'] }] }
  let evidence = [proof], calls = 0
  const contracts = createTaskWorkflowContracts({ controller: {}, artifacts: {},
    store: { async query({ kind }) { return kind === 'task.owner.acceptance' ? [item] : { taskId: 'direct' } } },
    readTaskEvidence: async binding => { assert.deepEqual(binding, { taskId: 'direct', requirementRevision: 3 }); return evidence },
    verifyAcceptance: async context => {
      calls++; assert.deepEqual(context.stages, []); assert.deepEqual(context.directEvidence, [proof]); return true
    } })
  const args = { taskId: 'direct', plan, requirement: { request: '确认目标列', scope: {} }, decision }
  assert.equal(await contracts.authorizeCompletion(args), true)
  const manifest = await contracts.readDeliveryManifest(args)
  assert.equal(manifest.complete, true); assert.equal(manifest.businessValidation.status, 'accepted'); assert.equal(calls, 1)
  assert.deepEqual(manifest.queryEvidence, [{ taskId: 'direct', requirementRevision: 3, evidenceRef: 'query-proof',
    artifactRef: 'query-proof', queryId: 'query_readonly_database', turnId: 'turn', leaseEpoch: 4 }])
  assert.equal(JSON.stringify(manifest.queryEvidence).includes('column_name'), false)
  await assert.rejects(contracts.authorizeCompletion({ ...args, decision: { ...decision, evidenceRefs: ['invented'] } }),
    { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  evidence = [{ ...proof, requirementRevision: 2 }]
  await assert.rejects(contracts.authorizeCompletion(args), { code: 'TASK_OWNER_ARTIFACT_SCOPE_MISMATCH' })
  evidence = [{ ...proof, taskId: 'other' }]
  await assert.rejects(contracts.readDeliveryManifest(args), { code: 'TASK_OWNER_ARTIFACT_SCOPE_MISMATCH' })
  evidence = []
  await assert.rejects(contracts.authorizeCompletion(args), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
})

test('直接查询必须经过共享语义验收，查询成功不代表业务完成', async () => {
  const proof = { taskId: 'task', requirementRevision: 1, evidenceRef: 'proof', artifactRef: 'proof', evidence: {} }
  const item = { itemId: 'item', criterion: '给出结论' }
  const args = { taskId: 'task', requirement: {}, plan: { task: { taskId: 'task', requirementRevision: 1 }, stages: [] },
    decision: { evidenceRefs: ['proof'], assessments: [{ itemId: 'item', status: 'satisfied', evidenceRefs: ['proof'] }] } }
  const options = { controller: {}, artifacts: {}, readTaskEvidence: async () => [proof],
    store: { async query({ kind }) { return kind === 'task.owner.acceptance' ? [item] : {} } } }
  await assert.rejects(createTaskWorkflowContracts(options).authorizeCompletion(args), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
  await assert.rejects(createTaskWorkflowContracts({ ...options, verifyAcceptance: async () => false }).authorizeCompletion(args),
    { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
})

test('工程检查缺文件以完整Host日志识别为配置前提，损坏日志不冒认',async()=>{
 const {inspectEngineeringCheckPrerequisite}=await import('../packages/dingtalk-dsh-assistant/task-workflow-contracts.js')
 const {createHash}=await import('node:crypto')
 const paths=['tests/a.test.cjs','tests/b.test.cjs'],bytes=Buffer.from(JSON.stringify({steps:[{args:['--test',...paths],exitCode:1,stderr:`Could not find '${paths.join(', ')}'\n`}]}))
 const part={kind:'engineering-verification-failure',candidateDigest:'candidate',checkId:'dataset-build',checkVersion:'1',encoding:'base64',part:0,parts:1,data:bytes.toString('base64'),logBytes:bytes.length,logSha256:createHash('sha256').update(bytes).digest('hex')}
 const context={state:{nodes:[{nodeId:'verify-candidate',status:'waiting',waitReason:{reference:'ENGINEERING_VERIFICATION_FAILED'},evidenceRefs:['log']}]},artifacts:{read:async()=>part}}
 assert.deepEqual((await inspectEngineeringCheckPrerequisite(context)).missingPaths,paths)
 part.logSha256='0'.repeat(64);assert.equal(await inspectEngineeringCheckPrerequisite(context),null)
})

test('工程检查失败同代候选重入保留成功准备与工作区，重做修改和验证',async t=>{
 const calls={};let input,artifactStore;
 const contract={id:'engineering-fixture',version:'1',validateCompletion:()=>true,inspectRepair:({state})=>({repairable:state.nodes.some(n=>n.waitReason?.reference==='ENGINEERING_VERIFICATION_FAILED'),evidenceRefs:state.nodes.flatMap(n=>n.evidenceRefs??[])}),prepareRepair:async({state,artifacts})=>({contextRef:(await artifactStore.put({taskId:'task',runId:state.run.runId,generation:state.run.generation})).ref,input:{...input,constraints:['结合最新共享诊断修复']}})};
 const ids=['prepare-generation','define-local-acceptance','plan-local-acceptance','prepare-workspace','inspect-and-propose','validate-proposal','apply-changes','verify-candidate'];
 const workflow={id:'task-engineering-fixture',version:'1',ownerContract:contract,nodes:ids.map(id=>({id,version:'1',executor:'code',allowedEffects:['pure'],inputSchema:schema,outputSchema:schema,mapInput:({requirement,previousOutput})=>id==='inspect-and-propose'?requirement:previousOutput??requirement,execute:async({input})=>{calls[id]=(calls[id]??0)+1;if(id==='verify-candidate'&&calls[id]===1)throw Object.assign(Error('真实测试失败'),{code:'ENGINEERING_VERIFICATION_FAILED',evidence:[{failed:true}]});return input}}))};
 input={constraints:[],request:'修复'};const f=await fixture(t,workflow,input);artifactStore=f.artifacts;const goal=await f.artifacts.put(requirement);await f.store.command({id:'bind-goal',kind:'task.requirement.bind-legacy',args:{taskId:'task',expectedRequirementRevision:1,requirementRef:goal.ref,sessionId:'owner-session',criteria:requirement.acceptanceCriteria,sourceKey:'source',eventKey:'bound'}});
 const plan=await f.controller.advanceTaskPlan('task'),runId=plan.stages[0].runId,before=await f.controller.whenIdle(runId);assert.equal(before.run.status,'waiting');
 const facade=createTaskWorkflowContracts({store:f.store,artifacts:f.artifacts,controller:f.controller}),observed=await facade.inspectCurrentExecution('task');
 await assert.rejects(f.store.command({id:'unbound-candidate',kind:'input.accept',args:{runId,inputId:'unbound',sourceKey:'unbound',requirementRef:before.run.requirementRef,candidateRepair:{inputRef:before.nodes[4].inputRef,inputDigest:before.nodes[4].inputDigest}}}),/WORKFLOW_REPAIR_NOT_ADMITTED/);
 const db=new DatabaseSync(join(f.artifacts.root,'..','control.db'));
 try{db.prepare("INSERT INTO execution_effects(effect_id,kind,run_id,node_run_id,node_id,generation,input_digest,definition_digest,definition_json,resource_keys_json,authorization_ref,state,created_at,updated_at) VALUES('external-proof','operation',?,?,?,?,?,'digest','{\"action\":\"external\"}','[]','fixture','succeeded','now','now')").run(runId,before.nodes[4].nodeRunId,before.nodes[4].nodeId,before.run.generation,before.nodes[4].inputDigest);
 await assert.rejects(facade.repairCurrentStage({taskId:'task',commandId:'external-deny',decision:{repair:observed.repairBinding,evidenceRefs:observed.evidenceRefs}}),/WORKFLOW_REPAIR_NOT_ADMITTED/);
 assert.equal((await f.controller.state(runId)).nodes[4].status,'succeeded');
 db.prepare("DELETE FROM execution_effects WHERE effect_id='external-proof'").run();}finally{db.close()}
 await facade.repairCurrentStage({taskId:'task',commandId:'repair-candidate',decision:{repair:observed.repairBinding,evidenceRefs:observed.evidenceRefs}});
 const after=await f.controller.whenIdle(runId);assert.equal(after.run.status,'succeeded');assert.equal(after.run.generation,before.run.generation);assert.equal(after.run.requirementRef,before.run.requirementRef);
 for(const id of ids.slice(0,4))assert.equal(calls[id],1);for(const id of ids.slice(4))assert.equal(calls[id],2);
 for(let i=0;i<4;i++){assert.equal(after.nodes[i].outputRef,before.nodes[i].outputRef);assert.equal(after.nodes[i].leaseEpoch,before.nodes[i].leaseEpoch)}
 assert.equal((await f.store.query({kind:'workflow.repair.context',runId,generation:after.run.generation})).mode,'candidate-in-place');
});

for(const variant of ['current','foreign-task','old-requirement','old-plan','old-control','unregistered','missing-diagnostic'])test(`实际修复合同统一当前Task证据范围 ${variant}`,async()=>{
 const stage={stageId:'engineering',runId:'run',workflowId:'task-engineering-test',workflowDigest:'digest',status:'running'}
 const task={taskId:'task',controlState:'active',requirementRevision:2,planRequirementRevision:2,planRevision:3,controlRevision:4,requirementRef:'requirement'}
 const plan={task,stages:[stage]},state={run:{taskId:'task',runId:'run',workflowId:stage.workflowId,workflowDigest:'digest',status:'waiting',generation:4,revision:8},pendingInputCount:0,nodes:[{nodeId:'inspect',status:'succeeded',outputRef:'candidate',drained:true},{nodeId:'verify',status:'waiting',drained:true,evidenceRefs:['real-log'],waitReason:{reference:'HOST_FAILURE'}}]}
 const diagnostic={kind:'owner-action-failure',taskId:variant==='foreign-task'?'other':'task',plan:{task:{...task,requirementRevision:variant==='old-requirement'?1:2,planRevision:variant==='old-plan'?2:3,controlRevision:variant==='old-control'?3:4}}}
 const events=variant==='unregistered'?[]:[{eventType:'system.recovery',eventSeq:1,payloadRef:'feedback'}];let invoked=0
 const facade=createTaskWorkflowContracts({controller:{taskPlan:async()=>plan,state:async()=>state,workflowDefinition:()=>({})},store:{query:async q=>q.kind==='effect.list'?[]:q.kind==='task.owner.events'?events:null},artifacts:{read:async ref=>ref==='feedback'?diagnostic:{}},inspectWorkflowRevision:async()=>({checkProfiles:[]}),reviseWorkflow:async()=>{invoked++;return{queued:true}}})
 const observed=await facade.inspectCurrentExecution('task'),decision={repair:observed.repairBinding,summary:'读取原需求、候选和当前Host反馈后调整策略',evidenceRefs:[...(variant==='missing-diagnostic'?[]:['real-log']),'requirement','candidate','feedback'],workflowRevision:{startNodeId:'verify',resumeCurrent:true}}
 if(variant==='current'){assert.deepEqual(await facade.repairCurrentStage({taskId:'task',decision,commandId:'recover'}),{queued:true});assert.equal(invoked,1)}
 else{await assert.rejects(facade.repairCurrentStage({taskId:'task',decision,commandId:'reject'}),/WORKFLOW_REPAIR_NOT_ADMITTED/);assert.equal(invoked,0)}
})
