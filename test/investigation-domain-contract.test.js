import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvestigationWorkflow, createLegacyInvestigationWorkflow, validateInvestigationResult, validateAgentWorkResult, createInvestigationStageContract } from '../packages/dingtalk-dsh-assistant/agent-work.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'

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
  const args = { requirement: { ...requirement, request: '调查', constraints: [], scope: {}, target: {}, materials: [material] }, origin: { run: { actorId: 'actor' } }, handoff }
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
  const args = { taskId: 'task', requirement: { ...requirement, acceptanceCriteria: ['更新后的要求'], request: '调查', constraints: [], scope: {}, target: {} }, origin: { run: { actorId: 'actor' } } }
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
