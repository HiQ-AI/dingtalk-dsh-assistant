import test from 'node:test'
import assert from 'node:assert/strict'
import { agentWorkDefinition, validateAgentWorkResult, createLegacyInvestigationWorkflow as createInvestigationWorkflow, classifyAgentWorkOutputError } from '../packages/dingtalk-dsh-assistant/agent-work.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

const result = (extra = {}) => ({ outcome: 'completed', summary: '已读取代码，当前材料无法确认根因。', evidenceRefs: ['evidence-a'], limitations: ['缺少当时运行日志'], question: '', ...extra })

test('输出校验仅明确的格式和引用错误可纠正，权限和存储故障不降级', () => {
  for (const code of ['AGENT_WORK_RESULT_INVALID', 'AGENT_WORK_EVIDENCE_INVALID', 'ARTIFACT_REFERENCE_INVALID', 'QUERY_EVIDENCE_INVALID'])
    assert.equal(classifyAgentWorkOutputError({ code }), 'correctable')
  for (const code of ['QUERY_SCOPE_DENIED', 'QUERY_SCOPE_CHANGED', 'QUERY_BINDING_INVALID', 'ARTIFACT_DIGEST_MISMATCH', 'EIO'])
    assert.equal(classifyAgentWorkOutputError({ code }), 'fatal')
})

test('问答证据须由Host实际验证，false、缺失和跨范围拒绝不被当成成功', async () => {
  const seen = []
  assert.deepEqual(await validateAgentWorkResult(result(), { verifyEvidence: async refs => { seen.push(refs); return true } }), result())
  assert.deepEqual(seen, [['evidence-a']])
  await assert.rejects(validateAgentWorkResult(result()), { code: 'AGENT_WORK_EVIDENCE_UNAVAILABLE' })
  await assert.rejects(validateAgentWorkResult(result(), { verifyEvidence: async () => false }), { code: 'AGENT_WORK_EVIDENCE_INVALID' })
  await assert.rejects(validateAgentWorkResult(result(), { verifyEvidence: async () => { throw Object.assign(Error('denied'), { code: 'QUERY_EVIDENCE_INVALID' }) } }), { code: 'QUERY_EVIDENCE_INVALID' })
  assert.deepEqual(await validateAgentWorkResult(result(), { sourceRefs: ['evidence-a'] }), result())
})

test('调查先拒绝模型截短或拼造的证据，真实返回引用的存储故障仍致命', async () => {
  const ref = `tasks/task/sha256-${'a'.repeat(64)}.json`
  let reads = 0
  const missing = Object.assign(Error('original evidence missing'), { code: 'ENOENT' })
  const options = { requireExecutedQueryAccounting: true, executedQueryRefs: [ref], sourceRefs: ['source'],
    verifyEvidence: async () => { reads++; throw missing } }
  for (const wrong of [ref.split('/').at(-1), ref.replace('/task/', '/other/'), `tasks/task/sha256-${'b'.repeat(64)}.json`]) {
    await assert.rejects(validateAgentWorkResult(result({ evidenceRefs: [wrong] }), options), { code: 'AGENT_WORK_EVIDENCE_INVALID' })
  }
  assert.equal(reads, 0)
  await assert.rejects(validateAgentWorkResult(result({ evidenceRefs: [ref] }), options), error => error === missing)
  assert.equal(classifyAgentWorkOutputError(missing), 'fatal')
  assert.equal(reads, 1)
  assert.equal((await validateAgentWorkResult(result({ evidenceRefs: ['source', ref] }), { ...options,
    verifyEvidence: async refs => { assert.deepEqual(refs, [ref]); return true } })).outcome, 'completed')
})

test('结果区分已答复、必需补充和能力阻塞；limitations不自动将答复变成等待', async () => {
  const options = { sourceRefs: ['evidence-a'] }
  assert.equal((await validateAgentWorkResult(result(), options)).outcome, 'completed')
  assert.equal((await validateAgentWorkResult(result({ outcome: 'needs_input', question: '请指定要检查的版本。' }), options)).outcome, 'needs_input')
  assert.equal((await validateAgentWorkResult(result({ outcome: 'blocked' }), options)).outcome, 'blocked')
  for (const invalid of [result({ outcome: 'needs_input' }), result({ outcome: 'blocked', limitations: [] }), result({ question: '多余问题' }), result({ evidenceRefs: ['evidence-a', 'evidence-a'] }), null])
    await assert.rejects(validateAgentWorkResult(invalid, options), { code: 'AGENT_WORK_RESULT_INVALID' })
})

test('调查只有一个自主Agent阶段及受信接纳，Owner不能将needs_input或blocked视为完成', async () => {
  let verified = 0
  const workflow = defineExecutionWorkflow(createInvestigationWorkflow({ provider: 'fixture', model: 'fixture', allowedTools: ['query'], capabilityIdentity: 'query-v1',
    verifyResult: async ({ result: value }) => { verified++; return validateAgentWorkResult(value, { verifyEvidence: async () => true }) } }))
  assert.equal(workflow.id, 'task-investigation'); assert.equal(workflow.version, '5')
  assert.match(workflow.nodes[0].prompt, /completed 仅表示调查阶段完成/)
  assert.match(workflow.nodes[0].prompt, /缺少调查本身所需/)
  assert.doesNotMatch(workflow.nodes[0].prompt, /本次执行职责是回答当前消息/)
  assert.equal(workflow.nodes[0].allowInputContinuation, true)
  assert.deepEqual(workflow.nodes.map(node => node.executor), ['agent', 'code'])
  assert.deepEqual(workflow.nodes[0].allowedTools, ['query'])
  const signal = new AbortController().signal
  const accepted = await workflow.nodes[1].execute({ input: { requirement: {}, result: result() }, runId: 'run', taskId: 'task', generation: 1, signal })
  assert.equal(verified, 1); assert.deepEqual(accepted, result())
  assert.equal(await workflow.ownerContract.validateCompletion({ output: accepted }), true)
  for (const output of [result({ outcome: 'needs_input', question: '哪个环境？' }), result({ outcome: 'blocked' }), { outcome: 'completed', summary: '假完成' }])
    assert.equal(await workflow.ownerContract.validateCompletion({ output }), false)
  const forbidden = defineExecutionWorkflow(createInvestigationWorkflow({ provider: 'fixture', model: 'fixture', allowedTools: ['query'], capabilityIdentity: 'query-v1', verifyResult: async () => { throw Object.assign(Error('denied'), { code: 'QUERY_EVIDENCE_INVALID' }) } }))
  await assert.rejects(forbidden.nodes[1].execute({ input: { requirement: {}, result: result() }, signal }), { code: 'QUERY_EVIDENCE_INVALID' })
})

test('共享执行保留规划、审查、数据和复盘的专业约束，禁止重复工具声明', () => {
  const definition = agentWorkDefinition({ provider: 'fixture', model: 'fixture', allowedTools: ['query'] })
  assert.match(definition.prompt, /本次执行职责是回答当前消息/)
  assert.doesNotMatch(definition.prompt, /completed 仅表示调查阶段完成/)
  for (const guidance of ['方案分析', 'PR审查', '数据问题', '复盘', '故障与性能分析', '不得创建业务任务']) assert.ok(definition.prompt.includes(guidance))
  assert.throws(() => agentWorkDefinition({ provider: 'fixture', model: 'fixture', allowedTools: ['query', 'query'] }), { code: 'AGENT_WORK_CONFIG_INVALID' })
})
