import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvestigationWorkflow, createLegacyInvestigationWorkflow, validateInvestigationResult, validateAgentWorkResult, createInvestigationStageContract } from '../packages/dingtalk-dsh-assistant/agent-work.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { createGeneralCapabilityStepWorkflow, verifyTaskAcceptance } from '../packages/dingtalk-dsh-assistant/task-general-workflow.js'
import { externalWorkflowOwnerContract, legacyExternalWorkflowOwnerContract } from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const requirement = { acceptanceCriteria: ['查明原因', '完成修复部署'],
  acceptanceItems: [{ itemId: 'acceptance-1', criterion: '查明原因' }, { itemId: 'acceptance-2', criterion: '完成修复部署' }] }
const result = () => ({ outcome: 'completed', summary: '已定位；修复待后续执行', evidenceRefs: ['source-a'], limitations: ['尚未修复部署'], question: '',
  findings: [{ kind: 'fact', statement: '配置缺失', evidenceRefs: ['source-a'] }],
  openItems: [{ description: '实施修复部署', reason: '后续授权阶段负责', evidenceRefs: [] }],
  criterionReviews: [{ itemId: 'acceptance-1', status: 'satisfied', reason: '配置核查确定缺项', evidenceRefs: ['source-a'] },
    { itemId: 'acceptance-2', status: 'insufficient_evidence', reason: '调查阶段尚未实施修复部署', evidenceRefs: [] }] })
const options = { provider: 'fixture', model: 'fixture', allowedTools: ['query'], capabilityIdentity: 'query-v1',
  verifyResult: async ({ result: value }) => validateAgentWorkResult(value, { sourceRefs: ['source-a'], verifyEvidence: async () => false }) }

test('v5 冻结定义保留历史 digest，新运行 v6 维持原预算', () => {
  const old = defineExecutionWorkflow(createLegacyInvestigationWorkflow(options))
  assert.equal(old.digest, '62b750dda434456907624168d6acb58aa974d223582dd8ceb2c6d53a2faaf81a')
  const current = defineExecutionWorkflow(createInvestigationWorkflow(options))
  assert.equal(current.version, '6')
  assert.notEqual(current.digest, old.digest)
  assert.equal(current.nodes[0].maxSteps, old.nodes[0].maxSteps)
  assert.equal(current.nodes[0].timeoutMs, old.nodes[0].timeoutMs)
  assert.deepEqual(current.ownerContract.resultContract.requiredFields, Object.keys(result()))
})

test('调查阶段交付逐条说明整体要求的不足，后续编码未执行不阻塞阶段成功', async () => {
  const workflow = createInvestigationWorkflow(options)
  const binding = { runId: 'run', taskId: 'task', generation: 1 }
  assert.deepEqual(await workflow.nodes[0].admitOutput({ output: result(), input: requirement, binding }), { outcome: 'succeeded' })
  const output = await workflow.nodes[1].execute({ input: { requirement, result: result() }, ...binding, signal: new AbortController().signal })
  assert.deepEqual(output, result())
  // 阶段可以成功，但没有 Owner 逐项评价与后续证据，不能声明整体完成。
  assert.equal(await workflow.ownerContract.validateCompletion({ output, state: { run: { requirementRef: 'frozen-input' } },
    artifacts: { read: async ref => { assert.equal(ref, 'frozen-input'); return requirement } } }), false)
})

test('Owner不能把调查明确不足改成已满足，必须引用随后阶段的有效产物', async () => {
  const contract = createInvestigationWorkflow(options).ownerContract
  for (const status of ['insufficient_evidence', 'not_applicable']) {
    const output = result(); output.criterionReviews[1].status = status
    const stage = { stageId: 'first', runId: 'run', workflowId: 'task-investigation', workflowDigest: 'v6', status: 'succeeded', outputRef: 'investigation' }
    const later = { stageId: 'second', runId: 'next', workflowId: 'delivery', workflowDigest: 'delivery-v1', status: 'succeeded', outputRef: 'delivered' }
    const plan = { task: { taskId: 'task', status: 'succeeded', planRevision: 1, requirementRevision: 1, planRequirementRevision: 1 }, stages: [stage] }
    const laterOutput = { summary: '修复部署验收已回读' }
    const deliveryContract = { id: 'delivery-result', version: '1', validateCompletion: () => true }
    const facade = createTaskWorkflowContracts({ controller: {
      state: async runId => {
        const selected = runId === 'run' ? stage : later
        return { run: { taskId: 'task', runId, workflowId: selected.workflowId, workflowDigest: selected.workflowDigest,
          generation: 0, status: 'succeeded', requirementRef: 'requirement' }, pendingInputCount: 0,
          nodes: [{ status: 'succeeded', generation: 0, outputRef: selected.outputRef }] }
      },
      workflowDefinition: id => ({ ownerContract: id === 'task-investigation' ? contract : deliveryContract }),
    }, store: { query: async () => requirement.acceptanceItems }, artifacts: {
      read: async ref => ref === 'requirement' ? requirement : ref === 'investigation' ? output : laterOutput,
    } })
    const decision = { evidenceRefs: ['investigation'], assessments: requirement.acceptanceItems.map(item => ({
      itemId: item.itemId, status: 'satisfied', evidenceRefs: ['investigation'],
    })) }
    const args = { taskId: 'task', plan, requirement, decision }
    assert.equal(await facade.authorizeCompletion(args), false)
    plan.stages.push(later)
    assert.equal(await facade.authorizeCompletion(args), false, '存在后续成功阶段但不引用仍不能覆盖不足')
    decision.assessments[1].evidenceRefs = ['delivered']
    decision.evidenceRefs.push('delivered')
    assert.equal(await facade.authorizeCompletion(args), true)
    deliveryContract.id = 'agent-investigation-result'
    laterOutput.criterionReviews = [{ itemId: 'acceptance-2', status: 'insufficient_evidence' }]
    assert.equal(await facade.authorizeCompletion(args), false, '另一份仍不足的调查不是补齐证据')
    laterOutput.criterionReviews[0].status = 'satisfied'
    assert.equal(await facade.authorizeCompletion(args), true)
  }
})

test('领域结果拒绝错型、缺失及重复验收项、虚构证据及无引用事实', async () => {
  const mutations = [
    value => { value.findings = '文本' },
    value => { delete value.openItems },
    value => { value.criterionReviews.pop() },
    value => { value.criterionReviews[1].itemId = 'acceptance-1' },
    value => { value.criterionReviews[1].itemId = 'acceptance-3' },
    value => { value.findings[0].evidenceRefs = ['other'] },
    value => { value.findings[0].evidenceRefs = [] },
    value => { value.criterionReviews[0].evidenceRefs = [] },
    value => { value.criterionReviews[1].reason = ' ' },
    value => { value.openItems = Array(33).fill(value.openItems[0]) },
    value => { value.findings = []; value.openItems = [] },
  ]
  for (const mutate of mutations) {
    const value = result(); mutate(value)
    await assert.rejects(validateInvestigationResult(value, { requirement, verifyResult: options.verifyResult }), { code: 'AGENT_WORK_RESULT_INVALID' })
  }
  const value = result(); value.evidenceRefs.push('foreign')
  await assert.rejects(validateInvestigationResult(value, { requirement, verifyResult: options.verifyResult }), { code: 'AGENT_WORK_EVIDENCE_INVALID' })
})

test('旧来源校验仅接收基础字段，权限错误不被领域校验覆盖', async () => {
  let seen
  await validateInvestigationResult(result(), { requirement, verifyResult: async args => { seen = args; return options.verifyResult(args) }, taskId: 'task' })
  assert.equal(seen.taskId, 'task')
  assert.deepEqual(Object.keys(seen.result), ['outcome', 'summary', 'evidenceRefs', 'limitations', 'question'])
  await assert.rejects(validateInvestigationResult(result(), { requirement, verifyResult: async () => { throw Object.assign(Error('denied'), { code: 'QUERY_SCOPE_DENIED' }) } }), { code: 'QUERY_SCOPE_DENIED' })
})

test('调查输入保留 Host handoff、材料按 ID 去重且拒绝冲突', async () => {
  const material = { id: 'source-a', text: '来源正文' }
  const contract = createInvestigationStageContract({ queryScope: value => value, queryCatalog: () => ({ queries: [] }), readSources: async () => [material], readAcceptanceItems: async () => requirement.acceptanceItems })
  const handoff = { outputRef: 'prior-ref', value: { summary: '前序结果' } }
  const args = { requirement: { ...requirement, request: '调查', constraints: [], scope: { sourceKeys: [], sourceVersions: {} }, target: {}, materials: [material] }, origin: { run: { actorId: 'actor' } }, handoff }
  const { input } = await contract.prepare(args)
  assert.deepEqual(input.materials, [material]); assert.deepEqual(input.handoff, handoff)
  assert.equal(input.scope.predecessorOutputRef, 'prior-ref')
  args.requirement.materials = [{ ...material, text: '不同内容' }]
  await assert.rejects(contract.prepare(args), { code: 'WORKFLOW_MATERIAL_ID_CONFLICT' })
})

test('修订后的真实 hash 验收 ID 冻结交接，拒绝按序号冒充及容量截断', async () => {
  const revisedItems = [{ itemId: 'acceptance-ab12cd34', criterion: '更新后的要求' }]
  let currentItems = revisedItems
  const contract = createInvestigationStageContract({ queryScope: value => value, queryCatalog: () => ({}), readSources: async () => [],
    readAcceptanceItems: async taskId => { assert.equal(taskId, 'task'); return currentItems } })
  const args = { taskId: 'task', requirement: { ...requirement, acceptanceCriteria: ['更新后的要求'], request: '调查', constraints: [], scope: { sourceKeys: [], sourceVersions: {} }, target: {} }, origin: { run: { actorId: 'actor' } } }
  const { input } = await contract.prepare(args)
  assert.deepEqual(input.acceptanceItems, revisedItems)
  const value = result(); value.criterionReviews = [{ ...value.criterionReviews[0], itemId: revisedItems[0].itemId }]
  assert.deepEqual(await validateInvestigationResult(value, { requirement: input }), value)
  value.criterionReviews[0].itemId = 'acceptance-1'
  await assert.rejects(validateInvestigationResult(value, { requirement: input }), { code: 'AGENT_WORK_RESULT_INVALID' })
  currentItems = Array.from({ length: 33 }, (_, index) => ({ itemId: `acceptance-${index}`, criterion: '要求' }))
  await assert.rejects(contract.prepare(args), { code: 'INVESTIGATION_ACCEPTANCE_ITEMS_INVALID' })
  const handoff = { outputRef: 'prior', value: { summary: '前序结论' } }
  const legacy = (await contract.prepare({ ...args, definitionVersion: '5', handoff })).input
  assert.equal('acceptanceItems' in legacy, false); assert.equal('handoff' in legacy, false)
  assert.deepEqual(legacy.context.predecessor, handoff.value)
})

function mixedFixture({ verdict = true, legacy = false, external = false } = {}) {
  const goal = structuredClone(requirement)
  goal.request = '查明原因并保存调查记录'
  goal.acceptanceCriteria[1] = '保存调查记录'
  goal.acceptanceItems[1].criterion = '保存调查记录'
  const investigation = result(), calls = []
  investigation.openItems[0] = { description: '保存记录', reason: '尚未写入', evidenceRefs: [] }
  const written = { status: 'written', content: '配置缺失；已保存调查记录' }
  const note = external ? { status: 'uat-deployed', boundaries: ['只确认UAT部署'], evidenceRefs: ['uat-readback'] }
    : { capabilityId: 'write-note', output: written, verification: { passed: true, outputDigest: executionDigest(written) } }
  const check = async input => {
    calls.push(structuredClone(input))
    return { status: verdict ? 'satisfied' : 'unsatisfied', resultVerified: verdict,
      criteria: input.acceptanceCriteria.map(criterion => ({ criterion, passed: verdict, evidenceIds: ['out-2'] })) }
  }
  const current = createGeneralCapabilityStepWorkflow({ capabilities: [], completionCheck: check }).ownerContract
  const second = external ? legacy ? legacyExternalWorkflowOwnerContract : externalWorkflowOwnerContract
    : legacy ? createGeneralCapabilityStepWorkflow({ capabilities: [], workflowVersion: '4', completionCheck: check }).ownerContract : current
  const contracts = [createInvestigationWorkflow(options).ownerContract, second]
  const stages = contracts.map((contract, index) => ({ stageId: `stage-${index + 1}`, runId: `run-${index + 1}`,
    workflowId: `workflow-${index + 1}`, workflowDigest: `frozen-${index + 1}`, status: 'succeeded', outputRef: `out-${index + 1}` }))
  const plan = { task: { taskId: 'task', status: 'succeeded', requirementRevision: 1, planRequirementRevision: 1, planRevision: 1 }, stages }
  const states = stages.map(stage => ({ run: { ...stage, taskId: 'task', status: 'succeeded', generation: 0, revision: 1,
    requirementRef: `input-${stage.stageId}` }, nodes: [{ status: 'succeeded', outputRef: stage.outputRef, generation: 0 }], pendingInputCount: 0 }))
  const decision = { summary: '调查和保存均完成', evidenceRefs: ['out-1', 'out-2'],
    assessments: goal.acceptanceItems.map((item, index) => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: [`out-${index + 1}`] })) }
  const helpers = createTaskWorkflowContracts({
    controller: { state: async id => states[stages.findIndex(stage => stage.runId === id)],
      workflowDefinition: id => ({ ownerContract: contracts[stages.findIndex(stage => stage.workflowId === id)] }) },
    artifacts: { read: async ref => ref === 'out-1' ? investigation : ref === 'out-2' ? note : goal },
    store: { query: async () => goal.acceptanceItems },
    completionPolicy: contract => contract === second ? external ? externalWorkflowOwnerContract : current : contract,
    verifyAcceptance: context => verifyTaskAcceptance({ ...context, check }),
  })
  return { goal, investigation, note, calls, stages, states, helpers,
    args: { taskId: 'task', plan, requirement: goal, decision } }
}

test('混合领域只核验实际承担条目，无关写入拒绝且有效保存不必再次证明调查', async () => {
  const rejected = mixedFixture({ verdict: false })
  assert.equal(await rejected.helpers.authorizeCompletion(rejected.args), false)
  assert.equal((await rejected.helpers.readDeliveryManifest(rejected.args)).businessValidation.status, 'unverified')
  assert.deepEqual(rejected.calls[0].acceptanceCriteria, ['保存调查记录'])
  assert.deepEqual(rejected.calls[0].acceptanceItems.map(item => item.itemId), ['acceptance-2'])
  assert.deepEqual(rejected.calls[0].evidence.map(item => item.evidenceId), ['out-2'])
  const accepted = mixedFixture()
  assert.equal(await accepted.helpers.authorizeCompletion(accepted.args), true)
  const receipt = (await accepted.helpers.readDeliveryManifest(accepted.args)).businessValidation
  assert.equal(receipt.status, 'accepted')
  assert.deepEqual(receipt.items.map(item => [item.itemId, item.validators[0].contract.id]),
    [['acceptance-1', 'agent-investigation-result'], ['acceptance-2', 'general-capability-result']])
  assert.equal(accepted.calls.length, 1)
})

test('验收回执仅跟随实际已验决定，序列化伪造、产物/运行/计划/决定变化均失效', async () => {
  for (const mutate of [f => { f.args.decision = structuredClone(f.args.decision) },
    f => { f.note.output.content = '另一份内容' }, f => { f.states[1].run.revision++ },
    f => { f.args.plan.task.planRevision++ }, f => { f.args.decision.summary = '修改结论' }]) {
    const f = mixedFixture()
    assert.equal(await f.helpers.authorizeCompletion(f.args), true)
    assert.equal((await f.helpers.readDeliveryManifest(f.args)).businessValidation.status, 'accepted')
    mutate(f)
    assert.equal((await f.helpers.readDeliveryManifest(f.args)).businessValidation.status, 'unverified')
  }
})

test('历史通用阶段无承担条目时只核验效果，承担条目时仍执行当前领域门禁', async () => {
  const f = mixedFixture({ legacy: true })
  f.goal.acceptanceItems.pop(); f.goal.acceptanceCriteria.pop(); f.investigation.criterionReviews.pop()
  f.args.decision.assessments.pop()
  assert.equal(await f.helpers.authorizeCompletion(f.args), true)
  assert.equal(f.calls.length, 0)
  const assigned = mixedFixture({ legacy: true, verdict: false })
  assert.equal(await assigned.helpers.authorizeCompletion(assigned.args), false)
  assert.equal(assigned.calls.length, 1)
})

test('旧新平台效果都不能作为生产修复的逐项接纳，当前域判据必须通过', async () => {
  for (const legacy of [false, true]) {
    const f = mixedFixture({ external: true, legacy, verdict: false })
    f.goal.acceptanceItems[1].criterion = f.goal.acceptanceCriteria[1] = '生产故障已修复'
    assert.equal(await f.helpers.authorizeCompletion(f.args), false)
    assert.deepEqual(f.calls[0].acceptanceCriteria, ['生产故障已修复'])
    assert.equal((await f.helpers.readDeliveryManifest(f.args)).businessValidation.status, 'unverified')
  }
})

test('验收输入身份不能被产物同名字段覆盖，跨项引用不能借总证据集合混入', async () => {
  const input = { source: 'Host冻结输入' }, output = { evidenceId: 'forged', executedInput: { source: 'forged' } }
  const context = { requirement: { request: '验证两项' }, decision: { summary: '候选', evidenceRefs: ['a', 'b'] },
    stages: [{ stage: { outputRef: 'a' }, input, output }],
    acceptanceItems: [{ itemId: 'one', criterion: '第一项', evidenceRefs: ['a'] }] }
  assert.equal(await verifyTaskAcceptance({ ...context, check: async request => {
    assert.equal(request.evidence[0].evidenceId, 'a')
    assert.deepEqual(request.evidence[0].executedInput, input)
    return { status: 'satisfied', resultVerified: true, criteria: [{ criterion: '第一项', passed: true, evidenceIds: ['a'] }] }
  } }), true)
  assert.equal(await verifyTaskAcceptance({ ...context, check: async () => ({ status: 'satisfied', resultVerified: true,
    criteria: [{ criterion: '第一项', passed: true, evidenceIds: ['b'] }] }) }), false)
})
