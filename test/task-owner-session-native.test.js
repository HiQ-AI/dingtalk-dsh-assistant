import { projectOwnerContext } from '../packages/dingtalk-dsh-assistant/task-owner-context.js'
import { ownerImmutableReadReceipts } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classifyAgentQueryError } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { sessionWorkspace, taskDirectories, taskFilePath } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createTaskOwnerSessions, previouslyReadOwnerArtifacts, ownerDecisionSchema } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'
import { createTaskOwnerController, readOwnerMaintenanceConstraints } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'
import { createTaskWorkflowContracts } from '../packages/dingtalk-dsh-assistant/task-workflow-contracts.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const { createScope, bindScopeParent, scopeOf } = requireLoop('@deepseek-ai/dsh-scope')
const { z } = requireLoop('zod')
const decision = { action: 'advance', summary: '启动已登记的第一阶段', evidenceRefs: [] }
function permissionFixture() {
  return {
    resolve: preset => ({ sandbox: preset, approval: preset === 'danger-full-access' ? 'never' : 'ask' }),
    current: session => session.snapshotEvents().findLast(event => event.type === 'permission/preset')?.data.preset ?? 'workspace-write',
    set(session, preset) {
      session.append('permission/preset', { preset })
      session.append('sandbox/mode', { mode: preset })
      session.append('approval/policy', { policy: preset === 'danger-full-access' ? 'never' : 'ask' })
    },
  }
}

test('Owner原生工具自主执行保留真实失败纠错与Host证据', async t => {
  for (const mode of ['correct', 'background', 'delegation', 'disabled', 'review', 'stale', 'cancel']) await t.test(mode, async t => {
    const root = await mkdtemp(join(tmpdir(), 'owner-native-tools-'))
    const calls = [{ name: 'pwsh', args: { valid: false, ...(mode === 'background' ? { run_in_background: true } : {}) } },
      { name: 'pwsh', args: { valid: true } }]
    if (mode === 'correct') calls.push({ name: 'task_owner_read_artifact', args: { artifactRef: `sha256-${'4'.repeat(64)}.json` } })
    if (mode === 'delegation') calls.splice(0, 2, { name: 'subagent', args: {} })
    const h = await host(root, null, null, decision, undefined, 1, calls, false)
    const standing = createScope(h.ctx, { preset: 'native-fixture' })
    standing.ctx.systemPrompt.section({ name: 'fixture:workspace-rules', order: 10, text: 'PRESET_WORKSPACE_RULES_MARKER：必须核验任务授权。' })
    h.ctx.sessionProjections.register({ key: 'agentPreset', stateSchema: z.union([z.string(), z.null()]), stateVersion: 1,
      init: header => header.agentPreset ?? null, apply: (state, event) => event.type === 'agent-preset/selected' ? event.data.agentPreset : state })
    const mounted = []
    const permissions = permissionFixture()
    h.onRequest(() => {
      const agent = h.ctx.agents.get('native-owner')
      assert.equal(permissions.current(agent.session), ['disabled', 'review'].includes(mode) ? 'workspace-write' : 'danger-full-access')
    })
    h.ctx.provide('agentPresets', { serviceFor: (_agent, name) => name === 'permissionPresets' ? permissions : undefined, async mount(agentCtx, id) {
      mounted.push(id)
      bindScopeParent(scopeOf(agentCtx), scopeOf(standing.ctx))
      if (mounted.length === 2) permissions.set(agentCtx.agent.session, 'workspace-write')
      return { id: 'native-fixture' }
    } })
    t.after(async () => { await h.close(); await standing.dispose(); await rm(root, { recursive: true, force: true }) })
    let executed = 0, delegated = 0, artifactReads = 0, cancellation
    const receipts = []
    standing.ctx.tools.register({ name: 'subagent', description: '宿主委派fixture', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => { delegated++; return { sessionId: 'child-fixture', status: 'started' } } })
    standing.ctx.tools.register({ name: 'pwsh', description: '原生执行fixture',
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      parameters: { type: 'object', properties: { valid: { type: 'boolean' }, run_in_background: { type: 'boolean' } }, required: ['valid'], additionalProperties: false },
      async execute(args, exec) {
        executed++
        if (mode === 'cancel') { cancellation = h.sessions.cancel('native-task'); exec.signal.throwIfAborted() }
        if (!args.valid) throw new Error('真实命令参数错误')
        return { text: '真实业务检查通过' }
      } })
    assert.equal(h.ctx.tools.get('pwsh'), undefined, '原生工具仅注册在preset父scope，global查找不可见')
    const result = await h.sessions.run({ binding: { taskId: 'native-task', sessionId: 'native-owner', turnId: 'turn-1', leaseEpoch: 1,
      ownerEpoch: 1, requirementRevision: 1, inputDigest: 'a'.repeat(64), sessionBound: false },
      input: { ...(mode === 'review' ? { deliveryReview: true } : {}) }, provider: 'owner-fixture', model: 'scripted',
      onSessionBound: async () => {}, onCandidate: async () => {}, readArtifact: async ref => {
        artifactReads++; assert.equal(ref, `sha256-${'4'.repeat(64)}.json`); return { actual: '真实原生工具证据' }
      },
      ...(mode === 'disabled' ? {} : { onNativeExecution: async receipt => {
        receipts.push(receipt)
        if (mode === 'stale' && receipt.phase === 'started') h.setLease(2)
        return { evidenceRef: `sha256-${String(receipts.length).repeat(64)}.json` }
      } }) })
    await cancellation
    assert.equal(h.requests[0].tools.some(x => x.name === 'subagent'), !['disabled', 'review'].includes(mode), '启用时完整公开preset工具')
    if (mode === 'correct') {
      assert.match(h.requests[0].system, /PRESET_WORKSPACE_RULES_MARKER/)
      assert.match(h.requests[0].system, /不绕过受管数据库变更、生产变更、发布和消息发送入口/)
      assert.match(h.requests[0].system, /未知外部效果先回查原效果/)
      assert.equal(result.status, 'submitted'); assert.equal(executed, 2)
      assert.deepEqual(receipts.map(x => x.phase), ['started', 'settled', 'started', 'settled'])
      assert.equal(receipts[1].result.isError, true); assert.equal(receipts[3].result.isError, false)
      assert.deepEqual(receipts[0].arguments, receipts[1].arguments)
      assert.equal(receipts[0].binding.sessionId, 'native-owner')
      assert.match(JSON.stringify(h.requests[1]), /Host原生工具执行回执/)
      assert.match(JSON.stringify(h.requests[1]), /真实命令参数错误/)
      assert.equal(artifactReads, 1)
      h.setLease(2)
      const resumed = await h.sessions.run({ binding: { taskId: 'native-task', sessionId: 'native-owner', turnId: 'turn-2', leaseEpoch: 2,
        ownerEpoch: 1, requirementRevision: 1, inputDigest: 'b'.repeat(64), sessionBound: true }, input: {},
        provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, onCandidate: async () => {},
        onNativeExecution: async () => { throw new Error('恢复仅提交，不重复业务工具') } })
      assert.equal(resumed.status, 'submitted')
      assert.deepEqual(mounted, [undefined, 'native-fixture'])
      const persisted = await h.ctx.sessionPersistence.inspect('native-owner')
      assert.equal(persisted.events.filter(event => event.type === 'agent-preset/selected').length, 1)
    } else if (mode === 'background') {
      assert.equal(executed, 2); assert.equal(receipts.length, 4)
      assert.equal(receipts[0].arguments.run_in_background, true)
    } else if (mode === 'delegation') {
      assert.equal(delegated, 1); assert.equal(receipts.length, 2)
      assert.equal(receipts[1].toolName, 'subagent')
      assert.match(JSON.stringify(receipts[1].result.content), /child-fixture/)
    } else if (mode === 'cancel') {
      assert.equal(executed, 1); assert.equal(receipts[0].phase, 'started')
      const settled = receipts.find(x => x.phase === 'settled')
      assert.equal(settled.cancelled, true); assert.equal(settled.result.isError, true)
      assert.notEqual(result.status, 'submitted')
    } else if (mode === 'stale') {
      assert.equal(executed, 0); assert.equal(result.status, 'stale')
      assert.equal(receipts[0].phase, 'started')
    } else {
      assert.equal(executed, 0); assert.equal(receipts.length, 0)
      assert.ok(h.requests[0].tools.every(x => x.name !== 'pwsh'))
    }
  })
})

test('Owner条件证据子集错误穿过真实SQLite线程精确反馈并同轮修正', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-condition-feedback-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'condition-feedback', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const workflow = { id: 'condition-fixture', version: '1', nodes: [{ id: 'step', version: '1', executor: 'code', allowedEffects: ['pure'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }] }
  const controller = createExecutionController({ store, artifacts, workflows: [workflow] })
  t.after(async () => { await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'condition-task', stages: [{ stageId: 'step', workflowId: workflow.id, input: {} }] })
  const send = (kind, args) => store.command({ id: `${kind}-${Math.random()}`, kind, args })
  await send('task.owner.init', { taskId: 'condition-task', sessionId: 'condition-owner', sourceKey: 'source', criteria: ['核验真实结果'] })
  await send('task.owner.event', { taskId: 'condition-task', eventKey: 'start', eventType: 'task.created' })
  await send('task.owner.claim', { taskId: 'condition-task', turnId: 'condition-turn', expectedLeaseEpoch: 0 })
  await send('task.owner.sessionBound', { taskId: 'condition-task', turnId: 'condition-turn', leaseEpoch: 1, sessionId: 'condition-owner' })
  const evidenceRef = `tasks/condition-task/sha256-${'c'.repeat(64)}.json`
  const chosen = { action: 'wait', summary: '等待实际核验结果', evidenceRefs: [],
    condition: { kind: 'execution', missing: '结果仍未确认', responsibleParty: '原执行会话', resumeWhen: '原调用结果已核验', evidenceRefs: [evidenceRef] } }
  const h = await host(root, null, null, step => ({ ...chosen, evidenceRefs: step === 1 ? [] : [evidenceRef] }))
  h.onRequest(() => { assert.ok(h.requests.length < 3, '应在精确反馈后一次修正完成') })
  t.after(() => h.close())
  let calls = 0
  const result = await h.sessions.run({ binding: { taskId: 'condition-task', sessionId: 'condition-owner', turnId: 'condition-turn', leaseEpoch: 1,
    ownerEpoch: 1, sessionBound: false }, input: { completionEvidenceRefs: ['unrelated-completion-ref'] },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async decision => { calls++; return send('task.owner.candidate', { taskId: 'condition-task', turnId: 'condition-turn', leaseEpoch: 1, decision }) } })
  assert.equal(result.status, 'submitted', JSON.stringify(h.requests.at(-1)?.messages)); assert.equal(calls, 2)
  const feedback = JSON.stringify(h.requests[1])
  assert.match(feedback, /condition.evidenceRefs必须是decision.evidenceRefs的子集/)
  assert.ok(feedback.includes(evidenceRef))
  assert.ok(!feedback.includes('Host completionEvidenceRefs:'))
  assert.equal((await send('task.owner.accept', { taskId: 'condition-task', turnId: 'condition-turn', leaseEpoch: 1 })).result.status, 'accepted')
})

test('Owner原生权限服务缺失时在模型调用前明确失败', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-permission-missing-'))
  const h = await host(root)
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  h.ctx.get('agentPresets').serviceFor = () => undefined
  await assert.rejects(h.sessions.run({ binding: { taskId: 'permission-task', sessionId: 'permission-owner', turnId: 'turn-1', leaseEpoch: 1,
    ownerEpoch: 1, requirementRevision: 1, inputDigest: 'a'.repeat(64), sessionBound: false }, input: {},
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, onCandidate: async () => {},
    onNativeExecution: async () => ({}) }), { code: 'TASK_OWNER_PERMISSION_PRESET_UNAVAILABLE' })
  assert.equal(h.requests.length, 0)
})

test('真实原生AgentLoop返回克隆complete仍接纳原已验回执', async t => {
  for (const mode of ['clone', 'diagnostic', 'foreign-diagnostic', 'child', 'foreign-child', 'missing-child', 'failed-child', 'unsatisfied-child']) await t.test(mode, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-native-completion-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'native-completion', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const requirement = { request: '交付核验结论', acceptanceCriteria: ['结论已核验'], constraints: [], scope: {} }
  const workflow = { id: 'proof-report', version: '1', ownerContract: { id: 'proof-result', version: '1', validateCompletion: () => true },
    nodes: [{ id: 'report', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      mapInput: ({ requirement }) => requirement, execute: async () => ({ summary: '结论已核验' }) }] }
  if (mode.endsWith('child')) workflow.nodes.unshift({ id:'ui-check',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>({passed:mode!=='failed-child',summary:'fixture child UI evidence'}) })
  const foreignWorkflow = {...workflow,id:'foreign-proof',nodes:workflow.nodes.map((node,index)=>index===0?{...node,execute:async()=>({passed:true,foreign:true})}:node)}
  const controller = createExecutionController({ store, artifacts, workflows: [workflow,foreignWorkflow] })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'native-task', stages: [{ stageId: 'report', workflowId: workflow.id, input: requirement }] })
  let plan = await controller.advanceTaskPlan('native-task')
  await controller.whenIdle(plan.stages[0].runId)
  plan = await controller.advanceTaskPlan('native-task')
  const ref = plan.stages[0].outputRef
  const childRef = mode.endsWith('child') ? (await controller.state(plan.stages[0].runId)).nodes[0].outputRef : ref
  let foreignRef
  if(mode==='foreign-child'){
    await controller.createTaskPlan({commandId:'foreign-plan',taskId:'foreign-task',stages:[{stageId:'foreign',workflowId:'foreign-proof',input:requirement}]})
    const foreignPlan=await controller.advanceTaskPlan('foreign-task');await controller.whenIdle(foreignPlan.stages[0].runId)
    const foreignState=await controller.state(foreignPlan.stages[0].runId);assert.equal(foreignState.run.status,'succeeded');foreignRef=foreignState.nodes[0].outputRef;assert.notEqual(foreignRef,childRef);assert.equal((await artifacts.read(foreignRef)).passed,true)
  }
  const submittedRef = mode === 'foreign-child' ? foreignRef : mode === 'missing-child' ? 'sha256-'+ 'b'.repeat(64) +'.json' : childRef
  const candidate = { action: 'complete', summary: '结论已核验', evidenceRefs: [submittedRef],
    assessments: [{ itemId: 'acceptance-1', status: mode==='unsatisfied-child'?'unsatisfied':'satisfied', evidenceRefs: [submittedRef] }] }
  const diagnostic = await artifacts.put({ kind: 'domain-acceptance-rejection', taskId: mode === 'foreign-diagnostic' ? 'other' : 'native-task',
    assessment: { status: 'unverified', criteria: [{ criterion: '结论已核验', passed: false, reason: '核验原执行记录' }] },
    evidence: [{ evidenceId: ref, hostExecution: { taskId: 'native-task', runId: plan.stages[0].runId } }] })
  const h = await host(root, null, mode === 'clone' ? null : step => step === 2 ? diagnostic.ref : null, candidate, undefined, 2)
  const helpers = createTaskWorkflowContracts({ store, artifacts, controller })
  let submittedDecision, returnedDecision
  const sessionRunner = { async run(options) {
    const result = await h.sessions.run({ ...options, onCandidate: async decision => {
      submittedDecision = decision
      return options.onCandidate(decision)
    } })
    returnedDecision = result.decision
    return result
  }, close: () => h.sessions.close() }
  let checks = 0
  const owner = createTaskOwnerController({ ctx: {}, store, artifacts, controller, sessionRunner,
    modelConfig: () => ({ provider: 'owner-fixture', model: 'scripted' }), advanceTask: async () => {}, authorizeStages: async () => false,
    authorizeCompletion: async ({ taskId, decision }) => {
      if (++checks === 1 && ['diagnostic','foreign-diagnostic'].includes(mode)) throw Object.assign(new Error('实际验收未核验，读取原始诊断'),
        { code: 'TASK_OWNER_COMPLETION_UNVERIFIED', diagnosticRef: diagnostic.ref })
      return helpers.authorizeCompletion({ taskId, decision, requirement, plan: await controller.taskPlan(taskId) })
    },
    readDeliveryManifest: helpers.readDeliveryManifest })
  t.after(async () => { await owner.close(); await h.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  const initial = await owner.ensure({ taskId: 'native-task', sourceKey: 'source', criteria: requirement.acceptanceCriteria, origin: {} })
  await store.command({ id: 'bind', kind: 'task.requirement.bind-legacy', args: { taskId: 'native-task', expectedRequirementRevision: 1,
    requirementRef: (await artifacts.put(requirement)).ref, sessionId: initial.sessionId,
    criteria: requirement.acceptanceCriteria, sourceKey: 'source', eventKey: 'bind' } })
  if (['foreign-diagnostic','foreign-child','missing-child','failed-child','unsatisfied-child'].includes(mode)) {
    await assert.rejects(owner.drive('native-task'), mode==='foreign-diagnostic' ? /TASK_OWNER_NO_DECISION/ : /TASK_OWNER_REPEATED_INVALID_DECISION/)
    const persisted = await h.ctx.sessionPersistence.inspect(initial.sessionId)
    if(mode==='unsatisfied-child') assert.equal(checks,0,'satisfied-only schema rejects before Host completion authorization')
    else assert.match(JSON.stringify(persisted.events), mode==='foreign-diagnostic' ? /TASK_OWNER_ARTIFACT_SCOPE_MISMATCH/u : /TASK_OWNER_COMPLETION_UNVERIFIED/u)
    assert.equal(await store.query({ kind: 'task.owner.delivery-manifest', taskId: 'native-task' }), null)
    return
  }
  await owner.drive('native-task')
  assert.notEqual(submittedDecision, returnedDecision)
  assert.deepEqual(submittedDecision, returnedDecision)
  if (mode==='child') {
    assert.notEqual(childRef,ref); assert.deepEqual(returnedDecision.evidenceRefs,[ref]);assert.deepEqual(returnedDecision.assessments[0].evidenceRefs,[ref]);assert.deepEqual(candidate.evidenceRefs,[childRef])
    assert.match(JSON.stringify(h.requests[0]),/completionEvidenceRefs/)
  }
  const saved = await store.query({ kind: 'task.owner.delivery-manifest', taskId: 'native-task' })
  assert.equal((await artifacts.read(saved.ref)).businessValidation.status, 'accepted')
  if(mode==='child' && process.env.SG20_OWNER_BINDING_PROOF_PATH){
    await writeFile(process.env.SG20_OWNER_BINDING_PROOF_PATH,JSON.stringify({testProvider:'owner-fixture',scriptedModel:true,businessBackendVerified:false,inputRequest:h.requests[0],modelSubmitted:candidate,hostCanonicalDecision:returnedDecision,persistedOwnerDecision:(await store.query({kind:'task.owner',taskId:'native-task'})).decision,manifest:await artifacts.read(saved.ref),originalChildRef:childRef,canonicalStageRef:ref},null,2))
  }
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'native-task' })).decision.action, 'complete')
  assert.ok(h.requests.length > 0)
  if (mode === 'diagnostic') {
    assert.match(JSON.stringify(h.requests[2]), /核验原执行记录/u)
    assert.ok(!candidate.evidenceRefs.includes(diagnostic.ref))
  }
  })
})

test('状态候选同轮纠正，改写说明不能绕过相同动作检测；只结束当前思考轮', async t => {
  for (const repeat of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'owner-decision-correction-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const invalid = { action: 'wait', summary: '等待业务规格', evidenceRefs: [] }
    const valid = { ...invalid, condition: { kind: 'business-input', missing: '字段规格', responsibleParty: '需求方', resumeWhen: '确认字段规格', evidenceRefs: [] } }
    const h = await host(root, null, null, step => step === 1 ? invalid : repeat ? { ...invalid, summary: '换一种说法仍等待业务规格' } : valid)
    t.after(() => h.close())
    let attempts = 0
    const result = await h.sessions.run({ binding: { taskId: 'task-condition', sessionId: 'owner-condition', turnId: 'review', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { task: { status: 'succeeded' }, stages: [], goal: { request: '核验字段定义' } },
      provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      onCandidate: async value => { attempts++; if (!value.condition) throw Object.assign(Error('missing condition'), { code: 'TASK_OWNER_CONDITION_REQUIRED' }) } })
    assert.equal(attempts, 2)
    assert.equal(h.requests.length, 2)
    assert.equal(result.status, repeat ? 'no_submission' : 'submitted')
    if (repeat) assert.equal(result.reason, 'TASK_OWNER_REPEATED_INVALID_DECISION')
    else assert.deepEqual(result.decision.condition, valid.condition)
    const stored = await h.ctx.sessionPersistence.inspect('owner-condition')
    assert.match(JSON.stringify(stored.events), /候选未落账/u)
  }
})

test('相同等待动作只改写condition说明仍触发重新诊断', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-condition-wording-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root, null, null, step => ({ action: 'wait', summary: `等待说明${step}`, evidenceRefs: [],
    condition: { kind: 'execution', missing: `内部问题${step}`, responsibleParty: `执行负责人${step}`, resumeWhen: `恢复后${step}`, evidenceRefs: [] } }))
  t.after(() => h.close())
  const result = await h.sessions.run({ binding: { taskId: 'task-condition', sessionId: 'owner-condition', turnId: 'turn', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { goal: { request: '继续处理' } }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => { throw Object.assign(Error('TASK_OWNER_RECOVERY_AVAILABLE'), { code: 'TASK_OWNER_RECOVERY_AVAILABLE' }) } })
  assert.equal(result.reason, 'TASK_OWNER_REPEATED_INVALID_DECISION')
  assert.equal(h.requests.length, 2)
})

test('Owner compact context requires complete current constraints before submit and exposes paged material tool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-compact-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const input = { taskId: 'compact-task', task: { requirementRevision: 1, controlState: 'paused' },
    goal: { request: '等待真人批准', constraints: ['必须保持暂停。'.repeat(3000)] }, stages: [] }
  const projection = await projectOwnerContext(input, artifacts), ref = projection.requiredRefs[0]
  const calls = [
    { name: 'task_owner_submit', args: { decision } },
    { name: 'task_owner_read_artifact', args: { artifactRef: ref, offset: 0, limit: 16000 } },
    { name: 'task_owner_submit', args: { decision } },
    { name: 'task_owner_read_artifact', args: { artifactRef: ref, offset: 16000, limit: 16000 } },
    { name: 'task_owner_list_materials', args: { cursor: 0, limit: 10 } },
  ]
  const h = await host(root, null, null, decision, undefined, 1, calls)
  t.after(() => h.close())
  let candidates = 0, listings = 0
  const result = await h.sessions.run({ binding: { taskId: 'compact-task', sessionId: 'compact-owner', turnId: 'compact-turn', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input, ...projection, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    readArtifact: ref => artifacts.read(ref), listMaterials: async args => { listings++; assert.equal(args.limit, 10); return { entries: [], nextCursor: null } },
    onCandidate: async () => { candidates++ } })
  assert.equal(result.status, 'submitted'); assert.equal(candidates, 1); assert.equal(listings, 1)
  assert.equal(h.requests.length, 6)
  assert.match(JSON.stringify(h.requests[2]), /task_owner_current_context_unread/)
  assert.match(JSON.stringify(h.requests[3]), /task_owner_current_context_unread/)
  const saved = await h.ctx.sessionPersistence.inspect('compact-owner')
  assert.ok(JSON.stringify(saved.events).includes(ref))
})

test('unchanged context receipt survives consecutive turns without reread; changed constraints require fresh complete pages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-repeat-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const marker = 'UNCHANGED_AUTHORIZATION_', input = { taskId: 'repeat-task', task: { requirementRevision: 1 },
    goal: { request: '等待批准', constraints: [marker.repeat(1800)] }, stages: [] }
  const waiting = { action: 'wait', summary: '等待已有批准', evidenceRefs: [], condition: {
    kind: 'approval', missing: '真人批准', responsibleParty: '审批人', resumeWhen: '批准后继续', evidenceRefs: [] } }
  const firstProjection = await projectOwnerContext(input, artifacts), calls = []
  const scheduleRead = async ref => {
    const length = JSON.stringify(await artifacts.read(ref)).length
    for (let offset = 0; offset < length; offset += 16000) calls.push({ name: 'task_owner_read_artifact', args: { artifactRef: ref, offset } })
  }
  await scheduleRead(firstProjection.requiredRefs[0]); calls.push({ name: 'task_owner_submit', args: { decision: waiting } })
  const h = await host(root, null, null, waiting, undefined, 1, calls)
  t.after(() => h.close())
  const sizes = [], copies = []
  const run = async (lease, projection) => {
    h.setLease(lease); const firstRequest = h.requests.length
    const result = await h.sessions.run({ binding: { taskId: input.taskId, sessionId: 'repeat-owner', turnId: `turn-${lease}`,
      leaseEpoch: lease, ownerEpoch: 1, sessionBound: lease > 1, requirementRevision: input.task.requirementRevision },
      input, ...projection, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      readArtifact: ref => artifacts.read(ref), onCandidate: async () => {} })
    assert.equal(result.status, 'submitted')
    const request = JSON.stringify(h.requests[firstRequest]); sizes.push(request.length); copies.push(request.split(marker).length-1)
    return h.requests.length-firstRequest
  }
  assert.equal(await run(1, firstProjection), calls.length)
  assert.equal(await run(2, firstProjection), 1)
  assert.equal(await run(3, firstProjection), 1)
  assert.ok(copies[1] > 1700); assert.equal(copies[2], copies[1])
  assert.ok(sizes[2]-sizes[1] < 3000)
  // A new requirement revision alone does not invalidate a still-current identical section.
  input.task.requirementRevision = 2
  assert.equal(await run(4, await projectOwnerContext(input, artifacts)), 1)
  input.goal.constraints = ['CHANGED_APPROVAL_REQUIRES_HUMAN_'.repeat(1300)]
  const changed = await projectOwnerContext(input, artifacts)
  assert.notEqual(changed.requiredRefs[0], firstProjection.requiredRefs[0])
  calls[h.requests.length] = { name: 'task_owner_submit', args: { decision: waiting } }
  calls.length = h.requests.length+1
  await scheduleRead(changed.requiredRefs[0]); calls.push({ name: 'task_owner_submit', args: { decision: waiting } })
  assert.ok(await run(5, changed) > 1)
  assert.equal(copies[4], 0)
  input.goal.constraints = [marker.repeat(1800)]
  assert.equal(await run(6, await projectOwnerContext(input, artifacts)), 1)
  assert.equal(copies[5], copies[1]) // Restore one applicable copy from audit pages, without a new tool read.
  const saved = await h.ctx.sessionPersistence.inspect('repeat-owner')
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_owner_read_artifact').length, 6)
  assert.ok(saved.events.some(event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace'))
  assert.ok(JSON.stringify(saved.events).includes(marker.repeat(100)))
  if (process.env.DSH_CONTEXT_METRICS_PATH) await writeFile(process.env.DSH_CONTEXT_METRICS_PATH, JSON.stringify({ firstRequestChars: sizes, firstRequestMarkerOccurrences: copies, nativeArtifactCalls: 6 }, null, 2))
})

test('generic DSH summary restores applicable complete read from audit without repeated read or lost changed requirement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-generic-compaction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true }), calls = []
  const marker = 'GENERIC_READ_', input = { taskId: 'generic-task', task: { requirementRevision: 1 }, goal: { request: '等待批准', constraints: [marker.repeat(2200)] }, stages: [] }
  const waiting = { action: 'wait', summary: '等待批准', evidenceRefs: [], condition: { kind: 'approval', missing: '真人批准', responsibleParty: '审批人', resumeWhen: '批准后继续', evidenceRefs: [] } }
  const schedule = async projection => {
    const ref = projection.requiredRefs[0], length = JSON.stringify(await artifacts.read(ref)).length
    for (let offset = 0; offset < length; offset += 16000) calls.push({ name: 'task_owner_read_artifact', args: { artifactRef: ref, offset } })
    calls.push({ name: 'task_owner_submit', args: { decision: waiting } })
  }
  const original = await projectOwnerContext(input, artifacts); await schedule(original)
  const h = await host(root, null, null, waiting, undefined, 1, calls)
  t.after(() => h.close())
  const run = async (lease, projection) => {
    h.setLease(lease); const start = h.requests.length
    const result = await h.sessions.run({ binding: { taskId: input.taskId, sessionId: 'generic-owner', turnId: `generic-${lease}`, leaseEpoch: lease,
      ownerEpoch: 1, sessionBound: lease > 1, requirementRevision: input.task.requirementRevision }, input, ...projection,
      provider: 'owner-fixture', model: 'scripted', readArtifact: ref => artifacts.read(ref), onSessionBound: async () => {},
      onCandidate: async () => { if (lease === 1) {
        const session = h.ctx.agents.get('generic-owner').session, shadowed = session.surface.nodes.slice(0, -1)
        session.append('user/message', createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: 'Generic DSH historical summary, no full tool pages' }] }),
          { surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed.at(-1) }, sourceEventSeqs: shadowed })
      } } })
    assert.equal(result.status, 'submitted'); return { steps: h.requests.length-start, request: JSON.stringify(h.requests[start]) }
  }
  await run(1, original)
  const second = await run(2, original); assert.equal(second.steps, 1); assert.equal(second.request.split(marker).length-1, 2200)
  input.goal.constraints = ['NEW_REQUIRED_APPROVAL_'.repeat(1300)]
  const changed = await projectOwnerContext(input, artifacts); calls.length = h.requests.length; await schedule(changed)
  const third = await run(3, changed); assert.ok(third.steps > 1); assert.ok(!third.request.includes(marker))
  input.goal.constraints = [marker.repeat(2200)]
  const fourth = await run(4, await projectOwnerContext(input, artifacts)); assert.equal(fourth.steps, 1)
  assert.equal(fourth.request.split(marker).length-1, 2200)
  const saved = await h.ctx.sessionPersistence.inspect('generic-owner')
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'task_owner_read_artifact').length, 4)
  assert.ok(saved.events.some(event => event.data.source?.ownerReadProjection))
})

async function host(root, pageRef = null, artifactRef = null, candidate = decision, getWorkspaceDir = () => sessionWorkspace(root, 'owner'), artifactPages = 1, queryCalls = [], withPreset = true) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  const standing = withPreset ? createScope(ctx, { preset: 'fixture' }) : null
  if (standing) {
    ctx.sessionProjections.register({ key: 'agentPreset', stateSchema: z.union([z.string(), z.null()]), stateVersion: 1,
      init: header => header.agentPreset ?? null, apply: (state, event) => event.type === 'agent-preset/selected' ? event.data.agentPreset : state })
    standing.ctx.tools.register({ name: 'read', description: '未调用的原生读取fixture', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => { throw new Error('此用例不应调用原生读取') } })
    const permissions = permissionFixture()
    ctx.provide('agentPresets', { serviceFor: (_agent, name) => name === 'permissionPresets' ? permissions : undefined, async mount(agentCtx, selected) {
      assert.ok(selected === undefined || selected === 'fixture')
      bindScopeParent(scopeOf(agentCtx), scopeOf(standing.ctx)); return { id: 'fixture' }
    } })
  }
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false,
    compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  const requestChecks = []
  class Scripted extends LlmAdapter {
    async *stream(options) {
      for (const check of requestChecks) check(options)
      requests.push(options)
      const selectedArtifact = typeof artifactRef === 'function' ? artifactRef(requests.length) : artifactRef
      const queryCall = queryCalls[requests.length - 1]
      const id = `call-${requests.length}`, name = queryCall ? queryCall.name : pageRef && requests.length === 1
        ? 'task_owner_read_events' : selectedArtifact && requests.length <= artifactPages
          ? 'task_owner_read_artifact' : 'task_owner_submit'
      const args = JSON.stringify(queryCall ? queryCall.args : name === 'task_owner_read_events' ? { pageRef }
        : name === 'task_owner_read_artifact' ? { artifactRef: selectedArtifact, offset: typeof artifactRef === 'function' ? 0 : (requests.length - 1) * 16000 } : { decision: typeof candidate === 'function' ? candidate(requests.length) : candidate })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['owner-fixture'], new Scripted())
  let currentLease = 1
  const sessions = createTaskOwnerSessions({ ctx, getWorkspaceDir, isCurrent: async binding => binding.leaseEpoch === currentLease })
  return { ctx, sessions, requests, onRequest(check) { requestChecks.push(check) }, setLease(value) { currentLease = value },
    async close() { await sessions.close(); await standing?.dispose(); await ctx.fiber.dispose() } }
}

test('原生Owner同轮收到受信验收实际判定及持久工件引用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-assessment-feedback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root, null, null, step => ({ action: 'advance', summary: step === 1 ? '尝试完成验收' : '依据实际拒绝修正', evidenceRefs: [] }))
  t.after(() => h.close())
  const ref = `sha256-${'f'.repeat(64)}.json`, message = `领域验收实际判定：unverified；未满足：生产回查。原始验收结果与证据：${ref}`
  let attempts = 0
  const result = await h.sessions.run({ binding: { taskId: 'task', sessionId: 'assessment-owner',
    turnId: 'assessment-turn', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false }, input: {},
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => { if (++attempts === 1) throw Object.assign(new Error(message), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' }) } })
  assert.equal(result.status, 'submitted')
  assert.match(JSON.stringify(h.requests[1]), /领域验收实际判定：unverified/u)
  assert.ok(JSON.stringify(h.requests[1]).includes(ref))
  const saved = await h.ctx.sessionPersistence.inspect('assessment-owner')
  assert.ok(JSON.stringify(saved.events).includes(message))
})

test('同一个业务 Task 的原生 Owner 会话跨唤醒复用并持久记录候选', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  const taskId = 'task-1', sessionId = 'owner-task-1', seen = []
  const run = leaseEpoch => h.sessions.run({ binding: { taskId, sessionId,
    turnId: `turn-${leaseEpoch}`, leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 },
    input: { taskId, eventWatermark: leaseEpoch, goal: { request: '整理任务交付报告' } }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => { seen.push(`bound-${leaseEpoch}`) },
    onCandidate: async value => { seen.push(`candidate-${leaseEpoch}`); assert.deepEqual(value, decision) } })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.deepEqual(seen, ['bound-1', 'candidate-1', 'bound-2', 'candidate-2'])
  const saved = await h.ctx.sessionPersistence.inspect(sessionId)
  assert.equal(saved.events.filter(event => event.type === 'dingtalk/task-owner-session').length, 1)
  assert.equal(saved.meta.cwd, join(root, 'session-workspaces', '任务负责'))
  assert.equal(saved.events.findLast(event => event.type === 'session/title').data.title, '整理任务交付报告 · 任务负责')
  assert.equal(saved.events.filter(event => event.type === 'user/message' && event.surfaceOp === 'append').length, 2)
  assert.equal(h.requests.length, 2)
  assert.ok(h.requests.every(request => request.tools.map(tool => tool.name).join(',') === 'task_owner_submit'))
  assert.match(h.requests[0].system, /先完成必要调查，再用task-general-capability阶段/u)
  assert.match(h.requests[0].system, /write-task-file/u)
  assert.match(h.requests[0].system, /含capabilityStep时，本轮planChange.stages只能有一个阶段/u)
  assert.match(h.requests[0].system, /已有计划的前序阶段必须全部成功/u)
  assert.match(h.requests[0].system, /下一轮才追加群文件交付阶段，保留各阶段的gate/u)
  assert.match(h.requests[0].system, /再安排task-group-file-delivery阶段/u)
  assert.match(h.requests[0].system, /import-task-file/u)
  assert.match(h.requests[0].system, /input严格含\{role,fileName,relativePath\}/u)
  assert.match(h.requests[0].system, /Host只读来源后冻结大小和SHA256/u)
  assert.match(h.requests[0].system, /二进制仅使用真实受信来源并已登记的artifactFiles/u)
  assert.match(h.requests[0].system, /正文报告不能替代附件/u)
})

test('原生Owner会话必须读取积压事件页后才能提交候选', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-paged-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pageRef = `sha256-${'a'.repeat(64)}.json`
  const h = await host(root, pageRef)
  t.after(() => h.close())
  const read = []
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'paged-session',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { taskId: 'task-1', eventPages: [{ ref: pageRef, firstSeq: 1, lastSeq: 1, count: 1 }] },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    readPage: async ref => { read.push(ref); return [{ eventSeq: 1, eventType: 'task.created', payload: null }] },
    onCandidate: async value => assert.deepEqual(value, decision) })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(read, [pageRef])
  assert.deepEqual(h.requests.map(request => request.tools.map(tool => tool.name)), [
    ['task_owner_read_events', 'task_owner_submit'], ['task_owner_read_events', 'task_owner_submit']])
})

test('Owner 仅能读取当前 Task 已成功阶段的产物正文', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRef = `sha256-${'b'.repeat(64)}.json`
  const h = await host(root, null, artifactRef, decision, undefined, 6)
  t.after(() => h.close())
  const read = []
  const longArtifact='发现原因'.repeat(20000)+'最后条件'
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'artifact-session',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
  input: { taskId: 'task-1', stageArtifacts: [{ stageId: 'stage-1', outputRef: artifactRef,
    evidenceRefs: [] }] }, provider: 'owner-fixture', model: 'scripted',
  onSessionBound: async () => {}, readArtifact: async ref => {
    read.push(ref); return { summary: longArtifact, limitations: [] }
  }, onCandidate: async value => assert.deepEqual(value, decision) })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(read, Array(6).fill(artifactRef))
  assert.ok(JSON.stringify(h.requests).includes('最后条件'))
  assert.ok(h.requests.every(request => request.tools.some(tool => tool.name === 'task_owner_read_artifact')))
})

test('原生会话桥允许读取受信nodeArtifacts正文，拒绝未登记引用', async t => {
  for (const allowed of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'owner-node-proof-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const nodeRef = `sha256-${'d'.repeat(64)}.json`
    const h = await host(root, null, nodeRef); t.after(() => h.close())
    let reads = 0
    const result = await h.sessions.run({ binding: { taskId: 'task', sessionId: 'proof-owner',
      turnId: 'proof-turn', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { taskId: 'task', stageArtifacts: [{ outputRef: `sha256-${'e'.repeat(64)}.json`,
        evidenceRefs: [], completionEvidenceRefs: [], domainEvidence: { taskRunId: '901' },
        nodeArtifacts: allowed ? [{ nodeId: 'execute-task', artifactRef: nodeRef }] : [] }] },
      provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      readArtifact: async ref => { assert.equal(ref, nodeRef); reads++; return { taskRunId: '901' } },
      onCandidate: async () => {} })
    assert.equal(reads, allowed ? 1 : 0)
    assert.equal(result.status, 'submitted')
    assert.match(JSON.stringify(h.requests), /taskRunId/u)
    if (!allowed) assert.match(JSON.stringify(h.requests), /TASK_OWNER_ARTIFACT_NOT_ALLOWED/u)
  }
})

test('已绑定的负责人会话缺失时拒绝另建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  h.setLease(2)
  await assert.rejects(h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'missing-session',
    turnId: 'turn-2', leaseEpoch: 2, ownerEpoch: 1, sessionBound: true },
    input: { taskId: 'task-1' }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => {}, onCandidate: async () => {} }),
  { code: 'TASK_OWNER_SESSION_MISSING' })
  assert.equal(h.requests.length, 0)
})

test('会话存储读故障原样阻断，不能伪装为可重建的缺失', async () => {
  const ctx = { agents: { get: () => null }, sessions: { get: () => null },
    sessionPersistence: { inspect: async () => { throw Object.assign(new Error('disk-read-failed'), { code: 'EIO' }) } } }
  const sessions = createTaskOwnerSessions({ ctx, isCurrent: async () => true })
  await assert.rejects(sessions.run({ binding: { taskId: 'task-1', sessionId: 'session-1',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: true }, input: {},
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => {} }), { code: 'EIO' })
  await sessions.close()
})


test('Owner新增能力阶段只接纳已登记写能力，调查读取不能逐次编排', async t => {
  for (const effectClass of ['read', 'file.write']) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-capability-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const candidate = { ...decision, planChange: { kind: 'initialize', stages: [{ workflowId: 'task-general-capability', gate: 'none', capabilityStep: { capabilityId: 'cap', input: {}, expectedEvidence: 'artifact' } }] } }
    const h = await host(root, null, null, candidate); t.after(() => h.close())
    let accepted = 0
    const outcome = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'owner-capability', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { taskId: 'task-1', capabilities: [{ id: 'cap', effectClass }] }, provider: 'owner-fixture', model: 'scripted',
      onSessionBound: async () => {}, onCandidate: async () => { accepted++ } })
    assert.equal(outcome.status, effectClass === 'read' ? 'no_submission' : 'submitted')
    assert.equal(accepted, effectClass === 'read' ? 0 : 1)
  }
})


test('原生Owner公开摘要含内部编号时工具反馈要求改写，记录仍保留绑定', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-public-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root, null, null, turn => ({ ...decision, summary: turn === 1 ? '任务会话已启动；taskId=task-1' : '已开始整理资料。' }))
  t.after(() => h.close())
  const candidates = []
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'public-session', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false }, input: { taskId: 'task-1' }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, onCandidate: async value => candidates.push(value) })
  assert.equal(result.status, 'submitted')
  assert.equal(h.requests.length, 2)
  assert.deepEqual(candidates.map(value => value.summary), ['已开始整理资料。'])
  assert.match(h.requests[0].system, /发给群成员的回复/u)
  assert.match(JSON.stringify(h.requests[1]), /GROUP_REPLY_INTERNAL_DETAILS/u)
  assert.ok((await h.ctx.sessionPersistence.inspect('public-session')).events.length > 0)
})


test('Owner原生工作目录使用受信任务绑定，重启保持cwd及宿主日志根', async t => {
  const base = resolve('docs/tmp/task-owner-session-native')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'run-')), selected = []
  const h = await host(root, null, null, decision, async ({ binding }) => {
    selected.push(structuredClone(binding))
    return (await taskDirectories(root, binding.taskId)).work
  })
  t.after(() => h.close())
  const run = (host, taskId, leaseEpoch = 1) => host.sessions.run({
    binding: { taskId, sessionId: `owner-${taskId}`, turnId: `turn-${leaseEpoch}`, leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 },
    input: { taskId: 'forged', cwd: root }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => {}, onCandidate: async () => {} })
  const locations = []
  for (const taskId of ['task-a', 'task-b']) {
    assert.equal((await run(h, taskId)).status, 'submitted')
    const saved = await h.ctx.sessionPersistence.inspect(`owner-${taskId}`)
    assert.equal(saved.meta.cwd, taskFilePath(root, taskId, 'work'))
    const location = h.ctx.sessionPersistence.locate(saved.meta).path
    assert.ok(location.startsWith(join(root, 'sessions') + sep))
    assert.ok(!location.startsWith(join(root, 'tasks') + sep))
    assert.match(await readFile(location, 'utf8'), /dingtalk\/task-owner-session/)
    locations.push(location)
  }
  assert.deepEqual(selected.map(binding => binding.taskId), ['task-a', 'task-b'])
  assert.deepEqual(selected.map(binding => binding.sessionId), ['owner-task-a', 'owner-task-b'])
  assert.notEqual(locations[0], locations[1])
  await h.close()
  const resumed = await host(root, null, null, decision, () => { throw new Error('must not reselect persisted cwd') })
  t.after(() => resumed.close()); resumed.setLease(2)
  assert.equal((await run(resumed, 'task-a', 2)).status, 'submitted')
  const saved = await resumed.ctx.sessionPersistence.inspect('owner-task-a')
  assert.equal(saved.meta.cwd, taskFilePath(root, 'task-a', 'work'))
  assert.equal(resumed.ctx.sessionPersistence.locate(saved.meta).path, locations[0])
  assert.equal(saved.events.filter(event => event.type === 'user/message' && event.surfaceOp === 'append').length, 2)
})

test('Owner原生会话引用拒绝可修正，未知持久化错误仍终止', async t => {
  for (const code of ['TASK_OWNER_REF_INVALID', 'TASK_OWNER_STORAGE_UNKNOWN']) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-correction-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root, null, null, step => ({ ...decision, evidenceRefs: step === 1 ? ['dws:source'] : [] }))
    t.after(() => h.close())
    let calls = 0
    const result = await h.sessions.run({ binding: { taskId: 'task-correction', sessionId: 'owner-correction', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { goal: { request: '调查' } }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      onCandidate: async value => { calls++; if (value.evidenceRefs.length) throw Object.assign(Error(code), { code }) } })
    assert.equal(result.status, code === 'TASK_OWNER_REF_INVALID' ? 'submitted' : 'no_submission')
    assert.equal(calls, code === 'TASK_OWNER_REF_INVALID' ? 2 : 1)
    if (calls === 2) assert.match(JSON.stringify(h.requests[1]), /TASK_OWNER_REF_INVALID/u)
  }
})

test('Owner完整大材料重试只保留当前输入投影，原始快照审计不改写', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const marker = 'WORKBOOK_FULL_BODY_4eb39'
  const body = marker + '完整单元格正文'.repeat(70000)
  let reject = true
  const run = leaseEpoch => h.sessions.run({ binding: { taskId: 'task-snapshot', sessionId: 'owner-snapshot', turnId: `turn-${leaseEpoch}`,
    leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 }, input: { taskId: 'task-snapshot', goal: { materials: [{ text: body }] } },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => { if (reject) throw Object.assign(Error('UNKNOWN_STORAGE'), { code: 'UNKNOWN_STORAGE' }) } })
  assert.equal((await run(1)).status, 'no_submission')
  const first = await h.ctx.sessionPersistence.inspect('owner-snapshot')
  reject = false; h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  const request = JSON.stringify(h.requests[1])
  assert.equal(request.split(marker).length - 1, 1)
  assert.ok(request.includes(body))
  assert.match(request, /superseded/u)
  const after = await h.ctx.sessionPersistence.inspect('owner-snapshot')
  assert.deepEqual(after.events.slice(0, first.events.length), first.events)
  assert.equal(after.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
  assert.equal(after.events.filter(e => e.surfaceOp?.op === 'replace').length, 1)
})

test('Owner引用可在第十步纠正提交，旧lease仍不能继续', async t => {
  for (const stale of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-ref-fence-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root); t.after(() => h.close())
    let calls = 0
    const result = await h.sessions.run({ binding: { taskId: 'task-ref', sessionId: 'owner-ref', turnId: 'turn-ref', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { goal: { request: '调查' } }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      onCandidate: async () => { calls++; if (stale) h.setLease(2); if (stale || calls < 10) throw Object.assign(Error('bad ref'), { code: 'TASK_OWNER_REF_INVALID' }) } })
    assert.equal(result.status, stale ? 'stale' : 'submitted')
    assert.equal(calls, stale ? 1 : 10)
  }
})

test('Owner原生旧修复动作无论绑定是否有效均拒绝并回到业务观察',async t=>{
 for(const mode of ['absent','stale','valid']){
  const root=await mkdtemp(join(tmpdir(),'owner-repair-binding-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const repair={stageId:'stage-1',runId:'run-1',generation:1,runRevision:0,requirementRevision:2}
  const h=await host(root,null,null,step=>step===1?{action:'repairCurrentStage',repair:{...repair,runRevision:mode==='stale'?1:0},summary:'执行会话读取失败，核对 inputDigest 后按原始证据修正引用',evidenceRefs:[]}:decision)
  t.after(()=>h.close());const submitted=[]
  const result=await h.sessions.run({binding:{taskId:'task-repair',sessionId:'owner-repair',turnId:'turn-1',leaseEpoch:1,ownerEpoch:1,sessionBound:false},
   input:{goal:{request:'调查'},currentExecution:mode==='absent'?null:{repairable:true,repairBinding:repair}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>submitted.push(value)})
  assert.equal(result.status,'submitted');assert.equal(submitted.length,1)
  assert.equal(submitted[0].action,decision.action)
  assert.equal(h.requests.length,2)
 }
})

test('Owner初始计划错误在同一原生turn内修正为initialize',async t=>{
 const root=await mkdtemp(join(tmpdir(),'owner-plan-correction-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const h=await host(root,null,null,step=>({action:'advance',summary:'先调查',evidenceRefs:[],planChange:step===1?{kind:'replaceSuffix',affectedFrom:0,stages:[{workflowId:'task-investigation',gate:'none'}]}:{kind:'initialize',stages:[{workflowId:'task-investigation',gate:'none'}]}}));t.after(()=>h.close())
 let calls=0
 const result=await h.sessions.run({binding:{taskId:'new-task',sessionId:'new-owner',turnId:'turn-1',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{task:{planRevision:0},stages:[],goal:{request:'调查'}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>{calls++;if(value.planChange.kind!=='initialize')throw Object.assign(Error('TASK_OWNER_ADVANCE_CONFLICT'),{code:'TASK_OWNER_ADVANCE_CONFLICT'})}})
 assert.equal(result.status,'submitted');assert.equal(calls,2);assert.equal(result.decision.planChange.kind,'initialize');assert.match(JSON.stringify(h.requests[1]),/尚无计划/)
})

test('Owner读取调查的待补充建议后可安排待审候选阶段，不机械继承business-input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-review-candidate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRef = `sha256-${'c'.repeat(64)}.json`
  const candidate = { action: 'advance', summary: '目标已确认，准备明确候选提交真人审批', evidenceRefs: [artifactRef],
    planChange: { kind: 'replaceSuffix', affectedFrom: 0, stages: [{ workflowId: 'task-data-change', gate: 'none', sourceCondition: {
      sourceKey: 'source-request', sourceVersion: 1, sourceQuote: '新增列并提交工单审批，通过后执行', objective: '新增列并提交工单审批，通过后执行',
    } }] } }
  const h = await host(root, null, artifactRef, candidate)
  t.after(() => h.close())
  let read = false, submitted = false
  const result = await h.sessions.run({ binding: { taskId: 'task-column', sessionId: 'owner-column', turnId: 'review', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { goal: { request: '新增列并提交工单审批，通过后执行' }, stageArtifacts: [{ stageId: 'investigate', outputRef: artifactRef }],
      workflowCatalog: [{ id: 'task-data-change' }] }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    readArtifact: async () => { read = true; return { outcome: 'needs_input', question: '是否确认全部字段规格？', limitations: ['目标明确，候选可供审批'] } },
    onCandidate: async value => { assert.equal(read, true); assert.equal(value.action, 'advance'); submitted = true } })
  assert.equal(result.status, 'submitted'); assert.equal(submitted, true)
  assert.match(h.requests[0].system, /不把候选当用户事实/)
  assert.match(h.requests[0].system, /驳回时读真实意见/)
  assert.match(h.requests[0].system, /修改后重新送审/)
  assert.match(h.requests[0].system, /普通调查.*直接使用本会话的查询工具/)
  assert.doesNotMatch(h.requests[0].system, /outcome=needs_input 时 wait 并询问/)
})

test('任务会话直接查询并同轮修正，成功证据先落账再读取提交；过期结果不交付', async t => {
  for (const stale of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'owner-query-native-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const ref = `sha256-${'9'.repeat(64)}.json`
    const h = await host(root, null, null, { ...decision, evidenceRefs: [ref] }, undefined, 1, [
      { name: 'query_fixture', args: { valid: false } },
      { name: 'query_fixture', args: { valid: true } },
      { name: 'task_owner_read_artifact', args: { artifactRef: ref } },
    ])
    t.after(() => h.close())
    let persisted = false, submitted = false
    const queryBinding = { kind: 'task-owner', taskId: 'task-query', sessionId: 'owner-query', turnId: 'turn-1', leaseEpoch: 1,
      ownerEpoch: 1, requirementRevision: 2, inputDigest: 'a'.repeat(64) }
    const result = await h.sessions.run({ binding: { ...queryBinding, sessionBound: false }, input: { goal: { request: '核验事实' } },
      provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, queryInput: { scope: 'registered' },
      tools: [{ name: 'query_fixture', description: '受信只读查询', parameters: { type: 'object', properties: { valid: { type: 'boolean' } }, required: ['valid'], additionalProperties: false },
        classifyError: error => error.code === 'QUERY_SCOPE_DENIED' ? 'correctable' : 'fatal',
        async execute({ binding, input, args }) {
          assert.deepEqual(binding, queryBinding); assert.deepEqual(input, { scope: 'registered' })
          if (!args.valid) throw Object.assign(Error('选择已授权查询范围'), { code: 'QUERY_SCOPE_DENIED' })
          if (stale) h.setLease(2)
          return { evidenceRef: ref, result: { verified: true }, sourceRefs: ['source'] }
        } }],
      onQueryEvidence: async value => { assert.deepEqual(value, { binding: queryBinding, evidenceRef: ref }); persisted = true },
      readArtifact: async value => { assert.equal(persisted, true); assert.equal(value, ref); return { verified: true } },
      onCandidate: async value => { assert.equal(persisted, true); assert.deepEqual(value.evidenceRefs, [ref]); submitted = true } })
    assert.equal(result.status, stale ? 'stale' : 'submitted')
    assert.equal(persisted, !stale); assert.equal(submitted, !stale)
    assert.match(JSON.stringify(h.requests[1]), /correctable_error/)
    assert.ok(h.requests[0].tools.some(tool => tool.name === 'query_fixture'))
    assert.ok(h.requests[0].tools.every(tool => ['query_fixture', 'task_owner_read_artifact', 'task_owner_submit'].includes(tool.name)))
  }
})

test('任务查询仅开放注入工具；未知工具与未知执行错误不能伪装为可纠正结果', async t => {
  for (const mode of ['unregistered', 'fatal']) {
    const root = await mkdtemp(join(tmpdir(), 'owner-query-guard-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root, null, null, decision, undefined, 1, [{ name: mode === 'unregistered' ? 'not_injected' : 'query_fixture', args: {} }])
    t.after(() => h.close())
    let executed = 0, persisted = 0
    await h.sessions.run({ binding: { taskId: 'guard-task', sessionId: 'guard-owner', turnId: 'turn-1', leaseEpoch: 1,
      ownerEpoch: 1, requirementRevision: 1, inputDigest: 'b'.repeat(64), sessionBound: false },
      input: {}, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, onCandidate: async () => {},
      queryInput: {}, readArtifact: async () => ({}), onQueryEvidence: async () => { persisted++ },
      tools: [{ name: 'query_fixture', description: '受信只读查询', parameters: { type: 'object', properties: {}, additionalProperties: false },
        classifyError: () => 'fatal', execute: async () => { executed++; throw Object.assign(Error('连接实现故障'), { code: 'QUERY_DRIVER_BROKEN' }) } }] })
    assert.equal(executed, mode === 'fatal' ? 1 : 0); assert.equal(persisted, 0)
    const saved = await h.ctx.sessionPersistence.inspect('guard-owner')
    assert.ok(saved.events.some(event => event.type === 'tool/result' && event.data.message.content[0].isError))
    assert.doesNotMatch(JSON.stringify(saved.events), /"status":"correctable_error"/)
  }
})

test('跨轮查询证据由Host清单重新注入可读范围，不依赖旧材料或阶段', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-query-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ref = `sha256-${'8'.repeat(64)}.json`
  const h = await host(root, null, ref, { ...decision, evidenceRefs: [ref] })
  t.after(() => h.close())
  let read = false
  const result = await h.sessions.run({ binding: { taskId: 'history-task', sessionId: 'history-owner', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { queryEvidence: [{ artifactRef: ref }] }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    readArtifact: async value => { assert.equal(value, ref); read = true; return { kind: 'agent-query-evidence', result: { verified: true } } },
    onCandidate: async () => assert.equal(read, true) })
  assert.equal(result.status, 'submitted')
})

test('工程准备缺UAT在同一Owner会话纠正为具体等待，未接纳工程计划', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-engineering-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wait = { action: 'wait', summary: '请指定本任务目标UAT环境（uat1至uat9）', evidenceRefs: [],
    condition: { kind: 'business-input', missing: 'uatEnvironment', responsibleParty: '交办人',
      resumeWhen: '目标UAT补入当前Task需求后继续', evidenceRefs: [] } }
  const h = await host(root, null, null, step => step === 1 ? {
    action: 'advance', summary: '按文档开发', evidenceRefs: [],
    planChange: { kind: 'initialize', stages: [{ workflowId: 'task-engineering', gate: 'none' }] },
  } : wait)
  t.after(() => h.close())
  const accepted = []
  const result = await h.sessions.run({
    binding: { taskId: 'engineering-task', sessionId: 'engineering-owner', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { task: { planRevision: 0 }, stages: [], goal: { request: '按文档开发', target: { repositoryId: 'repo' } } },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async value => {
      if (value.action === 'advance') throw Object.assign(Error('缺少uatEnvironment；先读取来源，确实缺少则等待交办人补充目标UAT'), { code: 'TASK_OWNER_ENGINEERING_INPUT_REQUIRED' })
      accepted.push(value)
    },
  })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(accepted, [wait])
  assert.equal(h.requests.length, 2)
  assert.match(JSON.stringify(h.requests[1]), /缺少uatEnvironment/u)
  assert.match(h.requests[0].system, /补充后继续原Task/u)
  assert.match(h.requests[0].system, /summary仍为string.*【结论】.*【结果】.*【下一步】/u)
  assert.match(h.requests[0].system, /排查完成（尚未修复）/u)
  assert.match(h.requests[0].system, /2–3条短重点/u)
})


test('缺UAT先读取已有材料再等待工程字段，读取权限失败独立分类',async t=>{
 for(const denied of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'owner-material-before-uat-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const ref=`sha256-${'8'.repeat(64)}.json`
  let read=false
  const candidate={action:'wait',summary:denied?'资料访问被拒绝，等待修复访问权限。':'已读取文档并整理需求，工程执行还需指定环境。',evidenceRefs:denied?[]:[ref],condition:{kind:denied?'permission':'business-input',missing:denied?'文档访问权限':'target.environment',responsibleParty:denied?'系统维护方':'交办人',resumeWhen:denied?'访问权限恢复后重读原文档':'补入唯一UAT环境后继续工程阶段',evidenceRefs:denied?[]:[ref]}}
  const h=await host(root,null,null,candidate,undefined,1,[{name:'read_document',args:{}}]);t.after(()=>h.close())
  const result=await h.sessions.run({binding:{taskId:'material-task',sessionId:'material-owner',turnId:'turn',leaseEpoch:1,ownerEpoch:1,requirementRevision:1,inputDigest:'digest',sessionBound:false},input:{goal:{request:'按文档开发',target:{}},queryContext:{resources:[{resourceRef:'document'}]}},provider:'owner-fixture',model:'scripted',queryInput:{},
   tools:[{name:'read_document',description:'读取已有文档',parameters:{type:'object',properties:{},additionalProperties:false},classifyError:classifyAgentQueryError,execute:async()=>{read=true;if(denied)throw Object.assign(Error('文档访问被拒绝'),{code:'DWS_DOC_PERMISSION_DENIED'});return {evidenceRef:ref,result:{text:'当前文档正文'},sourceRefs:['document']}}}],
   onQueryEvidence:async()=>{},readArtifact:async()=>({text:'当前文档正文'}),onSessionBound:async()=>{},onCandidate:async value=>{assert.ok(read);assert.equal(value.condition.kind,denied?'permission':'business-input')}})
  assert.equal(result.status,'submitted')
  const prompt=JSON.stringify(h.requests[0])
  assert.match(prompt,/缺少UAT只阻塞工程阶段/u);assert.match(prompt,/必须先调用对应工具取得实际结果/u)
  assert.match(prompt,/不能把读取失败与缺UAT合并成用户补充问题/u)
 }
})


test('文档六类实际读取失败可交给Owner继续判断，未知错误仍fatal',()=>{
 for(const code of ['DWS_DOC_AUTH_REQUIRED','DWS_DOC_PERMISSION_DENIED','DWS_DOC_NOT_FOUND','DWS_DOC_INCOMPLETE','DWS_DOC_TEMPORARY','DWS_DOC_READ_FAILED'])assert.equal(classifyAgentQueryError({code}),'correctable')
 for(const code of ['DWS_DOC_UNKNOWN','DWS_DOC_SCOPE_CHANGED','QUERY_VERIFICATION_FAILED','QUERY_SCOPE_CHANGED',undefined])assert.equal(classifyAgentQueryError({code}),'fatal')
})

test('Owner同会话刷新共享索引并读取未在当前版本清单中的历史材料，跨Task拒绝',async t=>{
 for(const foreign of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'owner-shared-material-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const ref=`tasks/${foreign?'other-task':'shared-task'}/sha256-${'7'.repeat(64)}.json`
  const h=await host(root,null,step=>step===1?'task-materials-index':ref,decision,undefined,2);t.after(()=>h.close())
  const reads=[]
  await h.sessions.run({binding:{taskId:'shared-task',sessionId:'shared-owner',turnId:'turn-1',leaseEpoch:1,ownerEpoch:1,sessionBound:false},
   input:{sharedMaterials:{logicalTaskId:'shared-task',entries:[]}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async()=>{},
   readArtifact:async value=>{reads.push(value);return value==='task-materials-index'?{entries:[{artifactRef:ref,status:'history'}]}:{result:{markdown:'历史原文'}}}})
  assert.deepEqual(reads,foreign?['task-materials-index']:['task-materials-index',ref])
 }
})


for (const mode of ['new', 'partial', 'legacy']) test(`原生Owner动作应用未知错误完整反馈后换策略并推进原Task，不重apply旧决定 mode=${mode}`, async t => {
  const partial = mode === 'partial'
  const root = await mkdtemp(join(tmpdir(), 'owner-action-feedback-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'owner-action-feedback', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let executionCalls = 0, applicationCalls = 0, feedbackRef, owner
  const workflow = { id: 'actual-work', version: '1', nodes: [{ id: 'work', version: '1', executor: 'code', allowedEffects: ['pure'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement,
    execute: async ({ input }) => { executionCalls++; return { result: input.request, verified: true } } }] }
  const controller = createExecutionController({ store, artifacts, workflows: [workflow] })
  const h = await host(root, null, step => step === 2 ? feedbackRef : null,
    step => ({ action: 'advance', summary: step === 1 ? '先尝试当前配置' : '完整错误证明配置已修正，使用当前计划继续', evidenceRefs: step === 1 ? [] : [feedbackRef], ...(partial && step === 1 ? { appendStages: [{ workflowId: workflow.id, gate: 'none' }] } : {}) }), undefined, 2)
  t.after(async () => { await owner?.close(); await h.close(); await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'one', workflowId: workflow.id, input: { request: '原业务目标' } }] })
  let legacyFailure = mode === 'legacy'
  const ownerStore = { ...store, async command(value) {
    if (legacyFailure && value.kind === 'task.owner.action.fail') { legacyFailure = false; const args = { ...value.args }; delete args.diagnosticRef; return store.command({ ...value, args }) }
    return store.command(value)
  } }
  owner = createTaskOwnerController({ ctx: h.ctx, store: ownerStore, artifacts, controller, modelConfig: () => ({ provider: 'owner-fixture', model: 'scripted' }),
    authorizeStages: async () => true,
    advanceTask: async taskId => { applicationCalls++; if (applicationCalls === 1) throw Object.assign(new Error('实际命令 check --suite missing-suite，注册候选却是 correct-suite'), { code: 'ARBITRARY_HOST_CONFIGURATION_ERROR', cause: new Error('底层选择不存在；业务代码尚未执行') }); return controller.advanceTaskPlan(taskId) },
    sessionRunner: { async run(args) { h.setLease(args.binding.leaseEpoch); if (args.binding.leaseEpoch === 2) {
      const event = args.input.events.find(item => item.eventType === 'system.recovery'); assert.ok(event?.payloadRef); feedbackRef = event.payloadRef
      const diagnostic = await artifacts.read(feedbackRef); assert.equal(diagnostic.kind, 'owner-action-failure')
      assert.equal(diagnostic.errors[0].code, 'ARBITRARY_HOST_CONFIGURATION_ERROR'); assert.match(diagnostic.errors[0].message, mode === 'legacy' ? /历史决定应用失败/ : /check --suite missing-suite/)
      if (mode !== 'legacy') assert.match(diagnostic.errors[1].message, /业务代码尚未执行/); assert.equal(diagnostic.receipts.length, partial ? 1 : 0); assert.equal(diagnostic.plan.stages.length, partial ? 2 : 1); assert.equal(diagnostic.plan.stages[0].status, 'ready')
    } return h.sessions.run(args) }, async close() {} } })
  await owner.ensure({ taskId: 'task', criteria: ['原业务目标'], sourceKey: 'source', origin: {} })
  if (partial) {
    const beforePlan = await controller.taskPlan('task')
    await assert.rejects(owner.drive('task'), /TASK_OWNER_NO_DECISION/)
    const nativeOwner = await store.query({ kind: 'task.owner', taskId: 'task' })
    const native = await h.ctx.sessionPersistence.inspect(nativeOwner.sessionId)
    assert.match(JSON.stringify(native.events), /TASK_OWNER_RUNTIME_PLAN_CHANGE_DISABLED/)
    assert.deepEqual(await controller.taskPlan('task'), beforePlan)
    assert.deepEqual(await owner.applyPending(), [])
    assert.equal(applicationCalls, 0)
    assert.equal(executionCalls, 0)
    return
  }
  await owner.drive('task'); const initial = await store.query({ kind: 'task.owner', taskId: 'task' })
  assert.equal((await owner.applyPending()).length, 1)
  if (mode === 'legacy') { assert.equal((await store.query({kind:'task.owner',taskId:'task'})).status,'blocked'); assert.deepEqual(await owner.applyPending(),[]); assert.equal(applicationCalls,1) }
  const failed = await store.query({ kind: 'task.owner', taskId: 'task' }); assert.equal(failed.status, 'pending'); assert.equal(failed.sessionId, initial.sessionId)
  assert.equal((await store.query({ kind: 'task.owner.actions.pending' })).length, 0)
  assert.deepEqual(await owner.applyPending(), []); assert.equal(applicationCalls, 1)
  await owner.drive('task'); assert.deepEqual(await owner.applyPending(), [])
  const plan = await controller.taskPlan('task'), state = await controller.whenIdle(plan.stages[0].runId)
  assert.equal(state.run.status, 'succeeded'); assert.equal(plan.stages.length, partial ? 2 : 1); assert.ok(executionCalls >= 1)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).sessionId, initial.sessionId)
  const native = await h.ctx.sessionPersistence.inspect(initial.sessionId)
  assert.equal(native.events.filter(e => e.type === 'dingtalk/task-owner-session').length, 1)
  assert.ok(JSON.stringify(native.events).includes(mode === 'legacy' ? '历史决定应用失败' : '底层选择不存在'))
})

 test('未决真实效果拒绝Owner新派发并在原生同轮转为对账等待', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-effect-feedback-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'owner-effect', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  let sends = 0, advances = 0
  const delivery = createExecutionDelivery({ store, artifacts,
    authorize: async () => null, authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'original-grant' }),
    externalAdapter: { execute: async () => { sends++; return { status: 'unknown', reason: 'ACK_LOST' } } } })
  const workflow = { id: 'external-work', version: '1', nodes: [{ id: 'send', version: '1', executor: 'code', allowedEffects: ['external.operation'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement,
    execute: async ({ perform, runId, generation, requirementDigest }) => perform({ action: 'external', prepared: {
      action: 'external', workflowKind: 'test', stage: 'send', runId, generation, requirementDigest, resourceKey: 'external:test', intent: { request: 'original' } } }) }] }
  const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
  const h = await host(root, null, null, step => step === 1 ? { action: 'advance', summary: '尝试继续', evidenceRefs: [] }
    : { action: 'wait', summary: '原操作回执未确认，等待系统对账', evidenceRefs: [], condition: {
      kind: 'execution', missing: '原操作真实回执', responsibleParty: '系统', resumeWhen: '原效果对账确认', evidenceRefs: [] } })
  const owner = createTaskOwnerController({ ctx: h.ctx, store, artifacts, controller,
    modelConfig: () => ({ provider: 'owner-fixture', model: 'scripted' }), sessionRunner: h.sessions,
    authorizeStages: async () => true, advanceTask: async () => { advances++ } })
  t.after(async () => { await owner.close(); await h.close(); await controller.close(); await store.close() })
  await controller.createTaskPlan({ commandId: 'plan', taskId: 'task', stages: [{ stageId: 'one', workflowId: workflow.id, input: { request: '真实写目标' } }] })
  const plan = await controller.advanceTaskPlan('task'), runId = plan.stages[0].runId
  await controller.whenIdle(runId)
  const before = await store.query({ kind: 'effect.list', runId }); assert.equal(before.length, 1, JSON.stringify(await controller.state(runId))); assert.equal(before[0].state, 'unknown')
  await owner.ensure({ taskId: 'task', criteria: ['核验原效果'], sourceKey: 'source', origin: {} })
  await owner.drive('task'); await owner.applyPending()
  assert.equal(sends, 1); assert.equal(advances, 0)
  assert.deepEqual(await store.query({ kind: 'effect.list', runId }), before)
  assert.equal((await store.query({ kind: 'task.owner', taskId: 'task' })).decision.action, 'wait')
  assert.match(JSON.stringify(h.requests[1]), /DELIVERY_RECONCILIATION_REQUIRED/)
 })

for (const mode of ['current','resume-agent','restart','foreign','stale']) test(`旧Owner流程修订不再因证据或模式而获得执行权限：${mode}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'owner-old-revision-'));const h=await host(root,null,null,step=>step===1?{action:'repairCurrentStage',summary:'旧修订',evidenceRefs:[],workflowRevision:{startNodeId:'check',resumeCurrent:true}}:decision);t.after(()=>h.close())
 let accepted=0;const result=await h.sessions.run({binding:{taskId:'task',sessionId:'owner-'+mode,turnId:'turn',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{currentExecution:{repairable:true,mode}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>{assert.notEqual(value.action,'repairCurrentStage');accepted++}})
 assert.equal(result.status,'submitted');assert.equal(accepted,1);assert.equal(h.requests.length,2)
})

test('原生相同候选补读新诊断可继续；重复读同一工件不算进展',async t=>{
 for(const repeat of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'owner-read-progress-')),refs=[`sha256-${'a'.repeat(64)}.json`,`sha256-${'b'.repeat(64)}.json`],read=new Set()
  const h=await host(root,null,step=>step===2?refs[0]:step===4?refs[repeat?0:1]:null,{action:'advance',summary:'依据真实诊断继续',evidenceRefs:refs},undefined,4)
  t.after(()=>h.close())
  const run=()=>h.sessions.run({binding:{taskId:'task',sessionId:'owner-progress',turnId:'turn',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{stageArtifacts:[{evidenceRefs:refs}]},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},readArtifact:async ref=>{read.add(ref);return{ref}},onCandidate:async()=>{if(read.size<2)throw Object.assign(Error('尚缺具体诊断'),{code:'TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD'})}})
  if(repeat){const value=await run();assert.equal(value.reason,'TASK_OWNER_REPEATED_INVALID_DECISION')}
  else assert.equal((await run()).status,'submitted')
 }
})
test('历史原生读取只复用同任务同需求完整成功分页，不信失败与部分正文',()=>{
 const ref=`tasks/task/sha256-${'a'.repeat(64)}.json`,binding={taskId:'task',sessionId:'owner',requirementRevision:2}
 const input=(taskId='task',revision=2)=>({type:'user/message',data:{source:{taskOwner:{taskId,sessionId:'owner'}},content:[{type:'text',text:JSON.stringify({task:{requirementRevision:revision}})}]}})
 const call=(id,offset)=>({type:'tool/call',data:{name:'task_owner_read_artifact',callId:id,arguments:JSON.stringify({artifactRef:ref,offset})}})
 const result=(id,text,error=false)=>({type:'tool/result',data:{message:{content:[{toolCallId:id,isError:error,content:[{type:'text',text:JSON.stringify({artifact:text,totalLength:4,nextOffset:text.length===4?null:2})}]}]}}})
 assert.deepEqual(previouslyReadOwnerArtifacts([input(),call('a',0),result('a','ab'),call('b',2),result('b','cd')],binding),[ref])
 for(const events of [[input('other'),call('a',0),result('a','abcd')],[input('task',1),call('a',0),result('a','abcd')],[input(),call('a',0),result('a','abcd',true)],[input(),call('a',2),result('a','cd')]])assert.deepEqual(previouslyReadOwnerArtifacts(events,binding),[])
})

for(const status of ['pending','blocked','applied']) test(`收回Owner执行修复后封存历史决定且不重放：${status}`,async t=>{
 const {DatabaseSync}=await import('node:sqlite');const root=await mkdtemp(join(tmpdir(),'owner-withdraw-')),dbPath=join(root,'control.sqlite')
 const store=await openExecutionStore({dbPath,instanceId:'withdraw',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
 const controller=createExecutionController({store,artifacts,workflows:[{id:'historical',version:'1',nodes:[{id:'work',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>({})}]}]});let calls=0
 const owner=createTaskOwnerController({ctx:{},store,artifacts,controller,modelConfig:()=>({}),authorizeStages:async()=>false,advanceTask:async()=>{calls++},repairCurrentStage:async()=>{calls++},sessionRunner:{async close(){}}})
 t.after(async()=>{await owner.close();await controller.close();await store.close()})
 await controller.createTaskPlan({commandId:'plan',taskId:'task',stages:[{stageId:'one',workflowId:'historical',input:{request:'原业务目标'}}]})
 await owner.ensure({taskId:'task',criteria:['原业务目标'],sourceKey:'source',origin:{}})
 await store.command({id:'claim',kind:'task.owner.claim',args:{taskId:'task',turnId:'old',expectedLeaseEpoch:0}})
 await store.command({id:'bind',kind:'task.owner.sessionBound',args:{taskId:'task',turnId:'old',leaseEpoch:1,sessionId:(await store.query({kind:'task.owner',taskId:'task'})).sessionId}})
 const db=new DatabaseSync(dbPath);const old={action:'repairCurrentStage',summary:'旧工程修复',evidenceRefs:[],workflowRevision:{startNodeId:'inspect'}}
 db.prepare("UPDATE task_owner_turns SET status='accepted',decision_json=?,application_status=? WHERE turn_id='old'").run(JSON.stringify(old),status)
 db.prepare("UPDATE task_owners SET current_turn_id=NULL,status=? WHERE task_id='task'").run(status==='blocked'?'blocked':'idle');db.close()
 await owner.applyPending();await owner.applyPending();assert.equal(calls,0)
 const check=new DatabaseSync(dbPath,{readOnly:true});const row=check.prepare("SELECT application_status,decision_json FROM task_owner_turns WHERE turn_id='old'").get();check.close()
 assert.equal(row.application_status,status==='applied'?'applied':'discarded');assert.deepEqual(JSON.parse(row.decision_json),old)
 const events=await store.query({kind:'task.owner.events',taskId:'task',afterSequenceId:0,limit:100})
 if(status!=='applied'){const event=events.find(e=>e.eventType==='system.recovery');assert.ok(event?.payloadRef);const proof=await artifacts.read(event.payloadRef);assert.equal(proof.errors[0].code,'TASK_OWNER_EXECUTION_REPAIR_DISABLED');assert.deepEqual(proof.decision,old)}
})

test('Owner原生工具只公开业务协调并可按既有计划继续',async t=>{
 assert.equal(ownerDecisionSchema.properties.action.enum.includes('repairCurrentStage'),false)
 assert.equal(Object.hasOwn(ownerDecisionSchema.properties,'workflowRevision'),false)
 assert.equal(Object.hasOwn(ownerDecisionSchema.properties,'repair'),false)
 const root=await mkdtemp(join(tmpdir(),'owner-observe-only-'));const h=await host(root,null,null,()=>({action:'advance',summary:'按既有计划继续',evidenceRefs:[]}));t.after(()=>h.close())
 let accepted=0;const result=await h.sessions.run({binding:{taskId:'task',sessionId:'owner-observe',turnId:'turn',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{currentExecution:{repairable:false,responsibility:'execution-session'}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async()=>{accepted++}})
 assert.equal(result.status,'submitted');assert.equal(accepted,1)
 assert.match(h.requests[0].system,/任务级唯一责任人/u)
 assert.match(h.requests[0].system,/节点会话是受托执行者/u)
 assert.match(h.requests[0].system,/不承诺自动修复/u)
 assert.match(h.requests[0].system,/不得提交repairCurrentStage或workflowRevision/u)
})

test('maintenance constraint body and original provenance reach actual native model request after event consumption',async t=>{
 const root=await mkdtemp(join(tmpdir(),'owner-maintenance-model-input-'))
 const store=await openExecutionStore({dbPath:join(root,'fixture.sqlite'),instanceId:'maintenance-input',initialize:true})
 const artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
 let executions=0
 const workflow={id:'fixture-delivery',version:'1',nodes:[{id:'proof',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:({requirement})=>requirement,execute:async()=>{executions++;return {fixture:true}}}]}
 const controller=createExecutionController({store,artifacts,workflows:[workflow]})
 await controller.createTaskPlan({commandId:'fixture-plan',taskId:'fixture-task',stages:[{stageId:'delivery',workflowId:workflow.id,input:{request:'fixture draft delivery',acceptanceCriteria:['fixture delivery'],constraints:[]}}]})
 let plan=await controller.advanceTaskPlan('fixture-task');await controller.whenIdle(plan.stages[0].runId);plan=await controller.advanceTaskPlan('fixture-task')
 const text='EXACT_MAINTENANCE_BODY: existing Draft PR is this delivery endpoint; backendVerified:false; no merge/deploy authorization; evaluate original items using actual stage evidence.'
 const original={sourceKey:'dws:fixture-source',sourceVersion:1,actorId:'original-user',text:'fixture original instruction'}
 const source={kind:'engineering-maintenance-constraint',version:1,requestId:'fixture-maintenance',taskId:'fixture-task',actorId:'actual-operator',channel:'internal-maintenance',text,requestDigest:'fixture-digest',requirementRef:plan.task.requirementRef,runId:plan.stages[0].runId,stageId:plan.stages[0].stageId,evidenceRefs:[plan.stages[0].outputRef],sources:[original]}
 const sourceRef=(await artifacts.put(source,{taskId:'fixture-task'})).ref
 const waiting={action:'wait',summary:'fixture wait for independent review',evidenceRefs:[],condition:{kind:'approval',missing:'fixture review',responsibleParty:'fixture operator',resumeWhen:'fixture review result',evidenceRefs:[]}}
 const h=await host(root,null,sourceRef,waiting)
 const owner=createTaskOwnerController({ctx:{},store,artifacts,controller,sessionRunner:h.sessions,modelConfig:()=>({provider:'owner-fixture',model:'scripted'}),advanceTask:async()=>{},authorizeStages:async()=>false})
 t.after(async()=>{await owner.close();await h.close();await controller.close();await store.close()})
 const initial=await owner.ensure({taskId:'fixture-task',sourceKey:'fixture-source',criteria:['fixture delivery'],origin:{}})
 const event=await owner.event({taskId:'fixture-task',eventKey:'existing-maintenance',eventType:'intent.received',payload:{kind:'constraint',text,actorId:'actual-operator',sourceKey:sourceRef,repairSource:{kind:'engineering-maintenance',sourceRef}}})
 const texts=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(texts):value&&typeof value==='object'?Object.values(value).flatMap(texts):[]
 const wireInput=request=>texts(request).flatMap(value=>{try{const parsed=JSON.parse(value);return parsed?.maintenanceConstraints?[parsed]:[]}catch{return []}}).at(-1)
 await owner.drive('fixture-task');await owner.applyPending()
 assert.ok(h.requests.length>=2)
 const first=wireInput(h.requests[0]);assert.ok(first,'native LlmAdapter must receive the serialized Owner input, not an index assertion')
 assert.equal(first.maintenanceConstraints[0].text,text);assert.equal(first.maintenanceConstraints[0].actorId,'actual-operator');assert.equal(first.maintenanceConstraints[0].channel,'internal-maintenance')
 assert.deepEqual(first.maintenanceConstraints[0].sources,[original]);assert.deepEqual(first.maintenanceConstraints[0].evidenceRefs,source.evidenceRefs);assert.equal(first.maintenanceConstraints[0].sourceRef,sourceRef)
 const after=await store.query({kind:'task.owner',taskId:'fixture-task'});assert.equal(after.status,'idle');assert.ok(after.processedWatermark>=event.result.eventSeq)
 h.setLease(2)
 await owner.event({taskId:'fixture-task',eventKey:'fixture-existing-path-recovery',eventType:'system.recovery',payload:{reason:'fixture re-evaluate recorded input, no new constraint'}})
 const requestCount=h.requests.length
 await owner.drive('fixture-task');await owner.applyPending()
 const second=wireInput(h.requests[requestCount]);assert.ok(second)
 assert.equal(second.maintenanceConstraints.length,1);assert.equal(second.maintenanceConstraints[0].text,text);assert.deepEqual(second.maintenanceConstraints[0].sources,[original])
 assert.ok(!second.events.some(item=>item.eventType==='intent.received'),'existing consumed fact must remain visible without resending it')
 const final=await store.query({kind:'task.owner',taskId:'fixture-task'});assert.equal(final.sessionId,initial.sessionId);assert.equal(executions,1)
 const proofPath=join(root,'model-request-proof.json')
 await writeFile(proofPath,JSON.stringify({testProvider:'owner-fixture',scriptedModel:true,businessBackendVerified:false,firstModelRequest:h.requests[0],secondModelRequest:h.requests[requestCount],firstOwnerInput:first,secondOwnerInput:second,originalExecutions:executions,originalSessionPreserved:final.sessionId===initial.sessionId},null,2))
 console.log('Native model request proof: '+proofPath)
 const saved=await h.ctx.sessionPersistence.inspect(final.sessionId)
 assert.ok(saved.events.some(item=>item.type==='tool/call'&&item.data.name==='task_owner_read_artifact'&&JSON.parse(item.data.arguments).artifactRef===sourceRef),'canonical source must remain readable through the native artifact tool')
})

test('maintenance input preserves canonical source and excludes other task, requirement and run',async()=>{
 const plan={task:{requirementRef:'current-requirement'},stages:[{stageId:'current-stage',runId:'current-run'}]}
 const canonical={kind:'engineering-maintenance-constraint',channel:'internal-maintenance',taskId:'task',requestId:'existing',requirementRef:'current-requirement',stageId:'current-stage',runId:'current-run',actorId:'operator',text:'full unchanged body',sources:[{actorId:'user',text:'original'}],evidenceRefs:['actual-proof']}
 for(const delta of [{},{taskId:'foreign'},{requirementRef:'old-requirement'},{runId:'foreign-run'},{channel:'im'}]){
  const source={...canonical,...delta},records=new Map([['fact',{kind:'constraint',repairSource:{kind:'engineering-maintenance',sourceRef:'canonical'}}],['canonical',source]])
  const store={query:async()=>[{eventSeq:540,eventType:'intent.received',payloadRef:'fact'}]}
  const result=await readOwnerMaintenanceConstraints({taskId:'task',plan,store,artifacts:{read:async ref=>records.get(ref)}})
  if(Object.keys(delta).length===0){assert.equal(result.length,1);assert.deepEqual(result[0],{eventSeq:540,payloadRef:'fact',sourceRef:'canonical',...canonical})}else assert.deepEqual(result,[])
 }
})

test('Owner completion schema and references allow bounded same-turn correction',async t=>{
 for(const mode of ['schema','references','limit']){
  const root=await mkdtemp(join(tmpdir(),'owner-completion-correction-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const ref='sha256-'+ 'a'.repeat(64)+'.json',valid={action:'complete',summary:'Verified fixture delivery',evidenceRefs:[ref],assessments:[{itemId:'acceptance-1',status:'satisfied',evidenceRefs:[ref]}]}
  const h=await host(root,null,null,step=>mode==='schema'&&step===1?{...valid,summary:{bad:true}}:mode==='references'&&step===1?{...valid,evidenceRefs:['unknown']} :mode==='limit'?{...valid,evidenceRefs:['unknown-'+step]}:valid);t.after(()=>h.close())
  let checks=0
  const result=await h.sessions.run({binding:{taskId:'correction-task',sessionId:'correction-owner',turnId:'correction-turn',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{completionEvidenceRefs:[ref]},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>{checks++;if(value.evidenceRefs[0]!==ref)throw Object.assign(Error('Bind successful original stage receipt'),{code:'TASK_OWNER_COMPLETION_UNVERIFIED'});return {} }})
  if(mode==='limit'){assert.notEqual(result.status,'submitted');assert.equal(checks,4);assert.ok(h.requests.length<=5);assert.match(JSON.stringify((await h.ctx.sessionPersistence.inspect('correction-owner')).events),/TASK_OWNER_CORRECTION_LIMIT/)}
  else{assert.equal(result.status,'submitted');assert.deepEqual(result.decision,valid);assert.equal(h.requests.length,2);assert.match(JSON.stringify(h.requests[1]),/Host completionEvidenceRefs/)}
 }
})

test('paused delivery review compiles one complete native prompt and reaches original Owner decision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-delivery-review-prompt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const chosen = {action:'wait',summary:'Review actual facts',evidenceRefs:[],condition:{kind:'capability',missing:'remaining evidence',responsibleParty:'execution host',resumeWhen:'evidence available',evidenceRefs:[]}}
  const h = await host(root,null,null,()=>chosen)
  t.after(()=>h.close())
  const result = await h.sessions.run({binding:{taskId:'review-task',sessionId:'original-review-owner',turnId:'review-turn',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{task:{controlState:'paused'},deliveryReview:{payloadRef:'review-facts'},stages:[],goal:{request:'Review existing Draft only'}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>assert.equal(value.action,'wait')})
  assert.equal(result.status,'submitted');assert.equal(h.requests.length,1);assert.equal(result.decision.action,'wait')
})
