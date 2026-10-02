import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { digest, referencedResourceIds } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { createMessageCoordinator } from '../packages/dingtalk-dsh-assistant/message-coordinator.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')

async function fixture(t, action = false, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coordinator-integration-'))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  new ApprovalService(ctx, { policy: 'ask' })
  new PermissionPresetService(ctx, { presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const inputs = [], requests = []
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      let input
      for (const m of options.messages) for (const b of m.content ?? []) if (b.type === 'text') {
        try { const parsed = JSON.parse(b.text); if (parsed.sources) input = parsed } catch {}
      }
      assert.ok(input, '原生会话收到当前完整协调输入')
      inputs.push(input)
      await hooks.onModel?.(input, requests.length)
      const decision = { decisions: input.sources.map(source => ({ runId: source.runId, reason: action ? '明确交办' : '仅提供背景无需回复', units: action ? [{ spans: [{ start: 0, end: source.body.length }], goalText: source.body,
        binding: { disposition: 'new', candidateId: null }, intent: { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: source.body }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' } }] : [] })) }
      hooks.transformDecision?.(decision, requests.length)
      const id = `call-${requests.length}`, name = action && requests.length === 1 ? 'group_coordinator_read_tasks' : 'group_coordinator_submit', args = JSON.stringify(name === 'group_coordinator_read_tasks' ? {} : { decision })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['coordinator-fixture'], new Scripted())
  const store = await openExecutionStore({ dbPath: join(root, 'control.sqlite'), instanceId: 'test', initialize: true })
  let judges = 0, dispatched = 0, candidateReads = 0
  const context = { agentNames: () => ['小小鹏'], candidates: async () => { candidateReads++; return { cards: [], total: 0, catalogRevision: "empty" } }, facts: async () => ({}), validateActions: async () => ({ kind: 'accepted' }) }
  Object.assign(context, hooks.context?.(store) ?? {})
  const coordinatorStore = hooks.coordinatorQuery ? { command: store.command.bind(store), query: async args => hooks.coordinatorQuery(args, await store.query(args)) } : store
  const coordinator = createMessageCoordinator({ ctx, store: coordinatorStore, context, sessionRunner: hooks.sessionRunner, clock: hooks.clock,
    getWorkspaceDir: hooks.getWorkspaceDir,
    modelConfig: hooks.modelConfig ?? (async () => ({ provider: 'coordinator-fixture', model: 'scripted' })) })
  const workflow = createMessageWorkflow({ store, coordinator, context, judge: async () => { judges++; throw Error('旧阶段不得运行') }, handlers: { answer: async () => { dispatched++; return { status: 'completed', reply: '已核验' } }, ...hooks.handlers } })
  t.after(async () => { await workflow.close(); await store.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const receive = async (runId, body) => { await workflow.receive({ runId, sourceKey: `source:${runId}`, sourceVersion: 1, conversationId: 'group', actorId: 'user', body, context: { compactPolicy: '本群助手负责核验', directedToAgent: action } }, { process: false }); await workflow.process(runId) }
  return { ctx, store, workflow, receive, inputs, requests, counters: () => ({ judges, dispatched, candidateReads }) }
}

test('原生群协调贯通持久账：同session连续两消息，静默稳态恢复不再调用模型', async t => {
  const f = await fixture(t)
  await f.receive('m1', '资料先放这里')
  const first = await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })
  await f.receive('m2', '补充一份背景')
  const second = await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })
  assert.equal(first.coordinator.sessionId, second.coordinator.sessionId)
  assert.equal(second.coordinator.leaseEpoch, 2)
  assert.equal(second.coordinator.status, 'idle')
  assert.equal(second.sources.length, 0)
  for (const id of ['m1', 'm2']) { const state = await f.store.query({ kind: 'message.run', runId: id }); assert.equal(state.run.status, 'settled'); assert.equal(state.commands.length, 0); assert.ok(state.run.snapshot) }
  await f.workflow.recover()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.counters(), { judges: 0, dispatched: 0, candidateReads: 2 })
  const saved = await f.ctx.sessionPersistence.inspect(first.coordinator.sessionId)
  assert.equal(saved.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 1)
  assert.equal(saved.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
})

test('原生协调接纳动作经既有dispatch实际执行一次，恢复不重派', async t => {
  const f = await fixture(t, true)
  await f.receive('action', '小小鹏核验这份资料')
  const state = await f.store.query({ kind: 'message.run', runId: 'action' })
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0].status, 'applied')
  await f.workflow.recover()
  assert.equal(f.counters().judges, 0)
  assert.equal(f.counters().dispatched, 1)
})

test('idle群恢复自动派生到新工作区，控制账绑定和原生父日志一致且无需新消息', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coordinator-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let cwd = join(root, '旧职责目录')
  await mkdir(cwd)
  const f = await fixture(t, false, { getWorkspaceDir: () => cwd, context: () => ({ groups: () => ['group'] }) })
  await f.receive('before-root', '原有上下文不丢失')
  const prior = (await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })).coordinator
  cwd = root
  await f.workflow.recover()
  const current = (await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })).coordinator
  assert.notEqual(current.sessionId, prior.sessionId)
  assert.equal(current.leaseEpoch, prior.leaseEpoch + 1)
  assert.equal(current.sessionHistory[0].sessionId, prior.sessionId)
  const child = await f.ctx.sessionPersistence.inspect(current.sessionId)
  assert.equal(child.meta.cwd, root)
  assert.equal(child.meta.parentSession, prior.sessionId)
  assert.equal(f.requests.length, 1)
  await f.receive('after-root', '同群补充')
  assert.equal(f.requests.length, 2)
  assert.equal((await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })).coordinator.sessionId, current.sessionId)
  assert.equal((await f.workflow.state('before-root')).run.status, 'settled')
})


test('群flight处理中接收新消息，原会话提交后自动接续下一水位', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, false, { onModel: async (_input, count) => { if (count === 1) { started.resolve(); await release.promise } } })
  const first = f.receive('first', '第一份资料')
  await started.promise
  const second = f.receive('second', '另一个独立背景')
  // receive先持久化；确认第二条已经进入同群账本再放开本轮。
  while (!(await f.store.query({ kind: 'message.source', sourceKey: 'source:second' }))) await new Promise(resolve => setTimeout(resolve, 1))
  release.resolve()
  await Promise.all([first, second])
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.inputs.map(i => i.sources.map(s => s.runId)), [['first'], ['second']])
  const group = await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })
  assert.equal(group.coordinator.leaseEpoch, 2)
  assert.equal(group.sources.length, 0)
  assert.equal(f.counters().judges, 0)
})

 test('原生turn内来源编辑：旧submit一次结束，立即同session新claim读取v2', async t => {
  let f
  f = await fixture(t, false, { onModel: async (_input, count) => {
    if (count === 1) await f.workflow.receive({ runId: 'edited-v2', sourceKey: 'source:edited', sourceVersion: 2, conversationId: 'group', actorId: 'user', body: '更正后的完整背景' }, { process: false })
  } })
  await f.receive('edited', '原背景')
  assert.deepEqual(f.inputs.map(i => i.sources.map(s => [s.runId, s.sourceVersion])), [[['edited', 1]], [['edited-v2', 2]]])
  assert.equal(f.requests.length, 2)
  assert.equal((await f.workflow.state('edited')).commands.length, 0)
  assert.equal((await f.workflow.state('edited-v2')).run.status, 'settled')
  const group = await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })
  assert.equal(group.coordinator.leaseEpoch, 2); assert.equal(group.sources.length, 0)
})

test('reprocess 创建新来源版本并由原生协调完成，无旧flight函数依赖', async t => {
  const f = await fixture(t)
  await f.workflow.receive({ runId: 'replay', sourceKey: 'source:replay', sourceVersion: 1, conversationId: 'group', actorId: 'user', body: '无需处理的背景' }, { process: false })
  const result = await f.workflow.reprocess('replay')
  assert.notEqual(result.run.runId, 'replay'); assert.equal(result.run.sourceVersion, 2)
  assert.equal(result.run.status, 'settled'); assert.equal(result.commands.length, 0)
  assert.equal(f.requests.length, 1)
})



const answerDecision = input => ({ decisions: input.sources.map(source => ({ runId: source.runId, reason: '明确查询', units: [{ spans: [{ start: 0, end: source.body.length }], goalText: source.body, binding: { disposition: 'new', candidateId: null }, intent: { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: source.body }, dependsOn: [] }], constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' } }] })) })

test('原生提交已落账但工具回执丢失，按committed派发一次且不重判', async t => {
  let submits = 0
  const f = await fixture(t, true, { sessionRunner: { close: async () => {}, run: async args => {
    await args.onSessionBound(); submits++
    await args.onCandidate(answerDecision(args.input))
    return { status: 'no_submission', reason: 'tool_ack_lost' }
  } } })
  await f.receive('ack-lost', '核对资料')
  assert.equal((await f.workflow.state('ack-lost')).commands[0].status, 'applied')
  await f.workflow.recover()
  assert.equal(submits, 1); assert.equal(f.counters().dispatched, 1)
})

test('提交使用模型观察时的任务版本；变化后拒绝，读工具刷新才接纳', async t => {
  let attempts = 0, refreshes = 0, store
  const f = await fixture(t, true, {
    context: actual => {
      store = actual
      return {
        candidates: async () => ({ cards: [{ candidateId: 'task-card', taskId: 'task', engine: 'workflow', title: '既有事项' }], total: 1, catalogRevision: 'one' }),
        facts: async ({ binding }) => binding.disposition === 'new' ? {} : { task: { factVersion: await store.query({ kind: 'message.task.version', taskId: 'task' }) } },
      }
    },
    sessionRunner: { close: async () => {}, run: async args => {
      await args.onSessionBound()
      const decision = answerDecision(args.input)
      if (!args.input.sources.length) { await args.onCandidate(decision); return { status: 'submitted' } }
      decision.decisions[0].units[0].binding = { disposition: 'existing', candidateId: 'task-card' }
      // prepare 已读取旧版本；独立事务形成新事实，不能用提交时事实偷偷替换旧观察。
      await store.command({ id: 'create-task', kind: 'task.accept', args: { taskId: 'task', requirementRef: 'sha256/requirement', requirementRevision: 1, sessionId: 'owner', criteria: ['核验'], sourceKey: 'origin', eventKey: 'created' } })
      attempts++
      await assert.rejects(args.onCandidate(decision), error => error.code === 'MESSAGE_TASK_FACTS_STALE')
      const read = args.readTools.find(t => t.name === 'group_coordinator_read_task')
      await read.execute({ runId: args.input.sources[0].runId, candidateId: 'task-card' }); refreshes++
      attempts++; await args.onCandidate(decision)
      return { status: 'submitted' }
    } },
  })
  await f.receive('changed-task', '查询已有任务')
  assert.equal(attempts, 2); assert.equal(refreshes, 1)
  assert.equal((await f.workflow.state('changed-task')).commands[0].status, 'applied')
  assert.equal(f.counters().dispatched, 1)
})


for (const placement of ['same-unit', 'same-topic-units']) test(`同一事项重复建Task候选整体拒绝，模型同轮纠正后只派发一次：${placement}`, async t => {
  let rejected = 0, f
  f = await fixture(t, true, { sessionRunner: { close: async () => {}, run: async args => {
    await args.onSessionBound()
    const candidate = answerDecision(args.input), unit = candidate.decisions[0].units[0]
    unit.intent.actions = [{ intent: 'create', arguments: { objective: '完整事项', workflowId: 'task-investigation' }, dependsOn: [] }]
    if (placement === 'same-unit') unit.intent.actions.push({ intent: 'research', arguments: { objective: '同一事项准备', workflowId: 'task-investigation' }, dependsOn: [0] })
    else candidate.decisions[0].units.push({ ...structuredClone(unit), binding: { disposition: 'conversation', candidateId: `source:${args.input.sources[0].runId}` } })
    await assert.rejects(args.onCandidate(candidate), { code: 'GROUP_COORDINATOR_EXISTING_TASK_REQUIRES_UPDATE' })
    rejected++
    assert.deepEqual((await f.workflow.state(args.input.sources[0].runId)).commands, [])
    await args.onCandidate(answerDecision(args.input))
    return { status: 'submitted' }
  } } })
  await f.receive(`duplicate-${placement}`, '核对同一事项')
  assert.equal(rejected, 1)
  assert.equal((await f.workflow.state(`duplicate-${placement}`)).commands.length, 1)
  await f.workflow.recover()
  assert.equal(f.counters().dispatched, 1)
})

test('原生协调重复创建反馈后同会话纠正，拒绝候选不落账且无需重领取', async t => {
  let invalidSubmitted = false
  const f = await fixture(t, true, { transformDecision(decision, count) {
    // 第一调用读目录，第二调用提交非法双创建，第三调用按明确反馈纠正为查询。
    if (count === 2) {
      invalidSubmitted = true
      decision.decisions[0].units[0].intent.actions = ['create', 'research'].map(intent => ({ intent,
        arguments: { objective: '同一事项', workflowId: 'task-investigation' }, dependsOn: [] }))
    }
  } })
  await f.receive('native-duplicate', '核对同一事项')
  assert.equal(invalidSubmitted, true)
  assert.equal(f.requests.length, 3)
  assert.match(JSON.stringify(f.requests[2].messages), /同一事项只能创建一个Task/)
  const state = await f.workflow.state('native-duplicate')
  assert.deepEqual(state.commands.map(c => c.kind), ['answer'])
  assert.equal(f.counters().dispatched, 1)
  assert.equal((await f.store.query({ kind: 'message.coordinator', conversationId: 'group' })).coordinator.leaseEpoch, 1)
})

test('同一来源两个独立单元获得不同稳定话题，首单元保持批次canonical引用', async t => {
  const f = await fixture(t, true, { sessionRunner: { close: async () => {}, run: async args => {
    await args.onSessionBound()
    const candidate = answerDecision(args.input), first = candidate.decisions[0].units[0]
    first.spans = [{ start: 0, end: 4 }]; first.goalText = '排查A'
    const second = structuredClone(first); second.spans = [{ start: 4, end: 7 }]; second.goalText = '排查B'
    candidate.decisions[0].units.push(second)
    await args.onCandidate(candidate); return { status: 'submitted' }
  } } })
  await f.receive('two-goals', '排查A；排查B')
  const state = await f.workflow.state('two-goals')
  assert.equal(new Set(state.units.map(unit => unit.topicId)).size, 2)
  assert.equal(state.units[0].topicId, `topic-${digest(['two-goals', 'coordinator']).slice(0, 32)}`)
  assert.equal(state.units[1].topicId, `topic-${digest(['two-goals', 'coordinator', 1]).slice(0, 32)}`)
  assert.equal(state.commands.length, 2)
  await f.workflow.recover()
  assert.equal(f.counters().dispatched, 2)
})

test('原生模型遗漏后半原文与虚构前置材料获得反馈，同轮纠正后执行', async t => {
  const f = await fixture(t, true, { transformDecision(decision, count) {
    const unit = decision.decisions[0].units[0]
    if (count === 2) unit.spans[0].end = 2
    if (count === 3) unit.intent.requiredExecutionMaterials = ['当前生产只读证据及表结构']
  } })
  await f.receive('complete-source', '调查现状；需负责人审批后才能执行')
  assert.equal(f.inputs[0].sources[0].sourceLength, '调查现状；需负责人审批后才能执行'.length)
  assert.equal(f.requests.length, 4)
  assert.match(JSON.stringify(f.requests[2].messages), /完整覆盖sourceLength/)
  assert.match(JSON.stringify(f.requests[3].messages), /调查objective/)
  const state = await f.workflow.state('complete-source')
  assert.equal(state.commands.length, 1); assert.equal(state.requests.length, 0)
  assert.equal(f.counters().dispatched, 1)
})

for(const code of ['GROUP_COORDINATOR_RUN_INVALID','GROUP_COORDINATOR_READ_TOOL_REQUIRED','GROUP_COORDINATOR_BUSY','CONNECTOR_TIMEOUT'])test(`协调故障分类与唯一通知：${code}`,async t=>{
 const f=await fixture(t,false,{sessionRunner:{async run(){throw Object.assign(Error(code),{code})},async close(){}}})
 await f.workflow.receive({runId:'failure-source',sourceKey:'failure-source-key',sourceVersion:1,conversationId:'group',actorId:'user',body:'请处理这项任务',context:{sourceMessageId:'original-message'}},{process:false})
 await assert.rejects(f.workflow.process('failure-source'),error=>error.code===code)
 const permanent=['GROUP_COORDINATOR_RUN_INVALID','GROUP_COORDINATOR_READ_TOOL_REQUIRED'].includes(code)
 const state=await f.store.query({kind:'message.run',runId:'failure-source'})
 assert.equal(state.run.status,permanent?'needs_attention':'pending')
 const {createWorkflowNotifications}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 let sent=0
 const notifier=createWorkflowNotifications({store:f.store,adapter:{canDisclose:async()=>true,send:async()=>{sent++;return{messageId:'notice-message'}},readback:async()=>({messageId:'notice-message',conversationId:'group'})}})
 await notifier.flush();await notifier.flush()
 const notices=await f.store.query({kind:'message.notifications',states:['prepared','acknowledged','delivered','superseded']})
 assert.equal(sent,permanent?1:0)
 assert.equal(notices.length,permanent?1:0)
 if(permanent){assert.equal(notices[0].status,'delivered');assert.equal(notices[0].payload.phase,'attention')}
})

for (const mention of ['required', 'objective']) test(`同批引用附件来源不能忽略或错绑，修正fact后整批接纳：${mention}`, async t => {
  let f, rejected = 0
  f = await fixture(t, false, { sessionRunner: { close: async () => {}, run: async args => {
    await args.onSessionBound()
    const file=args.input.sources.find(s=>s.runId==='file'), request=args.input.sources.find(s=>s.runId==='request')
    const candidate=answerDecision(args.input)
    const fileDecision=candidate.decisions.find(d=>d.runId===file.runId), taskDecision=candidate.decisions.find(d=>d.runId===request.runId)
    const fileUnit=fileDecision.units[0]
    fileDecision.units=[]
    taskDecision.units[0].intent.actions=[{intent:'research',arguments:{objective:'核对生产现状',workflowId:'task-investigation'},dependsOn:[]}]
    taskDecision.units[0].intent.requiredExecutionMaterials=mention==='required'?['sql-file']:[]
    if(mention==='objective')taskDecision.units[0].intent.actions[0].arguments.objective='核对附件fileId=sql-file，调查生产现状'
    await assert.rejects(args.onCandidate(candidate), error => error.code === 'GROUP_COORDINATOR_MATERIAL_SOURCE_UNBOUND'
      && error.message.includes('targetSourceRunId=request') && error.message.includes('candidateId:source:request')); rejected++
    fileUnit.intent.actions=[{intent:'fact',arguments:{kind:'fact',text:file.body},dependsOn:[]}];fileUnit.intent.replyPolicy='none'
    fileDecision.units=[fileUnit]
    await assert.rejects(args.onCandidate(candidate),{code:'GROUP_COORDINATOR_MATERIAL_SOURCE_UNBOUND'}); rejected++
    fileUnit.binding={disposition:'conversation',candidateId:'source:request'}
    await args.onCandidate(candidate);return{status:'submitted'}
  } } })
  await f.workflow.receive({runId:'file',sourceKey:'file-source',sourceVersion:1,conversationId:'group',actorId:'user',body:'原SQL资料',context:{attachments:[{resourceRef:'sql-file'}]}},{process:false})
  await f.workflow.receive({runId:'request',sourceKey:'request-source',sourceVersion:1,conversationId:'group',actorId:'user',body:'请核对生产现状'},{process:false})
  await f.workflow.process('request')
  assert.equal(rejected,2)
  assert.equal((await f.workflow.state('file')).units[0].topicId,(await f.workflow.state('request')).units[0].topicId)
})

test('消费v2忽略来源只解除本源编辑屏障，跨任务屏障保留', async t => {
  const f=await fixture(t)
  await f.workflow.receive({runId:'old',sourceKey:'edit-source',sourceVersion:1,conversationId:'group',actorId:'user',body:'闲聊'},{process:false})
  await f.workflow.receive({runId:'current',sourceKey:'edit-source',sourceVersion:2,conversationId:'group',actorId:'user',body:'闲聊',barriers:[{barrierId:'foreign',targetTaskId:'other-task',reason:'source_edit'}]},{process:false})
  await f.workflow.process('current')
  const state=await f.workflow.state('current')
  assert.equal(state.barriers.find(b=>b.id==='edit:current').status,'resolved')
  assert.equal(state.barriers.find(b=>b.id==='foreign').status,'pending')
  assert.equal(state.commands.length,0)
})

test('原生持久同session重放回读旧命令无Task事实，历史received不冒充任务接纳', async t => {
  let f, attempts=0, replayObserved=false
  f=await fixture(t,true,{
    transformDecision(decision){for(const d of decision.decisions)d.units[0].intent.actions=[{intent:'research',arguments:{objective:'核对材料',workflowId:'task-investigation'},dependsOn:[]}]},
    onModel(input){
      if(input.sources[0]?.sourceVersion===2){
        const current=input.sources[0].processing
        assert.equal(current.authority,'current_persistent_backend')
        assert.equal(current.currentSourceVersion,2)
        const old=current.versions.find(v=>v.sourceVersion===1)
        assert.equal(old.status,'superseded');assert.equal(old.commands.length,1)
        assert.equal(old.commands[0].taskExists,false)
        assert.equal(current.versions.find(v=>v.sourceVersion===2).commands.length,0)
        replayObserved=true
      }
    },
    handlers:{research:async action=>{
      if(++attempts===1)throw Object.assign(Error('MESSAGE_INPUT_PENDING'),{code:'MESSAGE_INPUT_PENDING'})
      await f.store.command({id:'accept-replayed-task',kind:'task.accept',args:{taskId:action.taskId,requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'replayed-owner',criteria:['核对'],sourceKey:'source:original',eventKey:'created'}})
      return{status:'created',taskId:action.taskId}
    }}
  })
  await f.receive('original','核对材料')
  const group=await f.store.query({kind:'message.coordinator',conversationId:'group'})
  const persisted=await f.ctx.sessionPersistence.inspect(group.coordinator.sessionId)
  const history=JSON.stringify(persisted.events)
  assert.match(history,/acceptedDecisions/);assert.match(history,/executionPending/);assert.match(history,/taskExists/)
  await f.workflow.receive({runId:'replayed',sourceKey:'source:original',sourceVersion:2,conversationId:'group',actorId:'user',body:'核对材料'},{process:false})
  await f.workflow.process('replayed')
  assert.equal(replayObserved,true);assert.equal(attempts,2)
  const current=await f.store.query({kind:'message.source.processing',runId:'replayed'})
  assert.equal(current.versions.find(v=>v.sourceVersion===2).commands[0].taskExists,true)
  assert.equal((await f.store.query({kind:'message.coordinator',conversationId:'group'})).coordinator.sessionId,group.coordinator.sessionId)
  await assert.rejects(f.store.query({kind:'message.source.processing',runId:'original'}),{code:'MESSAGE_STALE'})
})

test('原生绑定反馈区分过时candidate与批次existing误用，同轮精确修正', async t => {
  const f=await fixture(t,true,{transformDecision(decision,count){
    const unit=decision.decisions[0].units[0]
    if(count===2)unit.binding={disposition:'existing',candidateId:'source:old-run'}
    if(count===3)unit.binding={disposition:'existing',candidateId:`source:${decision.decisions[0].runId}`}
    if(count===4)unit.binding={disposition:'conversation',candidateId:`source:${decision.decisions[0].runId}`}
  }})
  await f.receive('current-source','核对材料')
  assert.equal(f.requests.length,4)
  assert.match(JSON.stringify(f.requests[2].messages),/candidateId=source:old-run/)
  assert.match(JSON.stringify(f.requests[2].messages),/GROUP_COORDINATOR_UNKNOWN_TARGET/)
  assert.match(JSON.stringify(f.requests[3].messages),/GROUP_COORDINATOR_BATCH_TARGET_DISPOSITION_INVALID/)
  assert.match(JSON.stringify(f.requests[3].messages),/批次source引用使用conversation或new/)
  assert.equal((await f.workflow.state('current-source')).commands.length,1)
  assert.equal(f.counters().dispatched,1)
})

test('读取目录与初始输入使用同一批次候选及明确合法绑定',async t=>{
 const f=await fixture(t,true,{sessionRunner:{async close(){},async run(args){
  await args.onSessionBound()
  const read=await args.readTools.find(tool=>tool.name==='group_coordinator_read_tasks').execute({})
  assert.deepEqual(read.batchCandidates,args.input.batchCandidates)
  assert.deepEqual(read.batchCandidates[0].supplementBinding,{disposition:'conversation',candidateId:'source:batch-visible'})
  assert.deepEqual(read.batchCandidates[0].creationBinding,{disposition:'new',candidateId:null})
  assert.match(read.batchCandidates[0].purpose,/不能用existing/)
  await args.onCandidate(answerDecision(args.input));return{status:'submitted'}
 }}})
 await f.receive('batch-visible','核对资料')
 assert.equal(f.counters().dispatched,1)
})

test('原生重分段与先读材料请求反馈可纠正，保持同轮至真实提交',async t=>{
 const f=await fixture(t,true,{transformDecision(decision,count){
  if(count===2)decision.decisions[0].units[0].intent={kind:'needs_resegmentation',reason:'需要重新关联本批目标'}
  if(count===3)decision.decisions[0].units[0].intent={kind:'needs_context',reason:'需要核对材料',needs:[]}
 }})
 await f.receive('correctable','核对材料')
 assert.equal(f.requests.length,4)
 assert.match(JSON.stringify(f.requests[2].messages),/重新提交完整decisions/)
 assert.match(JSON.stringify(f.requests[3].messages),/group_coordinator_read_material/)
 assert.equal((await f.store.query({kind:'message.coordinator',conversationId:'group'})).coordinator.leaseEpoch,1)
 assert.equal((await f.workflow.state('correctable')).commands.length,1)
 assert.equal(f.counters().dispatched,1)
})

test('附件身份只匹配参数完整ID，嵌套字段可见且不把前缀或独立附件强纳入',()=>{
 const attachments=[{resourceRef:'file-a',fileId:'file-a'},{source:{resourceId:'file-b'}},{resourceRef:'unrelated'}]
 assert.deepEqual(referencedResourceIds({objective:'引用 fileId=file-a，继续核对',nested:{constraints:['file-b']}},attachments),['file-a','file-b'])
 assert.deepEqual(referencedResourceIds({objective:'file-a-more prefixfile-b 与 ordinary'},attachments),[])
})

for (const kind of [undefined, 'constraint']) test(`补充动作的可选kind正常落账并派发：${kind ?? 'fact'}`, async t => {
  let received
  const f = await fixture(t, true, {
    transformDecision(decision) {
      const unit = decision.decisions[0].units[0]
      unit.intent.actions = [{ intent: 'fact', arguments: { text: '原需求中的补充条件', ...(kind ? { kind } : {}) }, dependsOn: [] }]
      unit.intent.replyPolicy = 'none'
    },
    handlers: { fact: async action => { received = action.arguments; return { status: 'completed' } } },
  })
  await f.receive(`fact-kind-${kind ?? 'default'}`, '原需求中的补充条件')
  const state = await f.workflow.state(`fact-kind-${kind ?? 'default'}`)
  assert.equal(state.commands[0].status, 'applied')
  assert.equal(state.commands[0].args.arguments.kind, kind ?? 'fact')
  assert.equal(received.kind, kind ?? 'fact')
  const topic = await f.store.query({ kind: 'message.topic', topicId: state.units[0].topicId })
  assert.ok(topic.facts.some(fact => fact.kind === (kind ?? 'fact') && fact.text === '原需求中的补充条件'))
})

test('实现错误同条件不原样重启，新来源到达后继续原群', async t => {
 let calls=0,failures=0,injectFailures=false
 const f=await fixture(t,false,{coordinatorQuery(args,value){
  if(injectFailures && args.kind==='message.coordinator')value.unconsumedTaskEvents.push({taskId:'task-existing',eventSeq:++failures,eventType:'owner.failed'})
  return value
 },sessionRunner:{async close(){},async run(args){
  calls++
  if(calls===1)throw Object.assign(Error('implementation_broken'),{code:'implementation_broken'})
  await args.onSessionBound();await args.onCandidate({decisions:args.input.sources.map(s=>({runId:s.runId,reason:'背景',units:[]}))});return{status:'submitted'}
 }}})
 await assert.rejects(f.receive('broken','背景'),{code:'implementation_broken'})
 for(let i=0;i<6;i++)await f.workflow.recover()
 assert.equal(calls,1)
 injectFailures=true
 for(let i=0;i<6;i++)await f.workflow.recover()
 assert.equal(calls,1,'内部失败事件不会触发同条件模型重启')
 injectFailures=false
 await f.receive('new-condition','新背景')
 assert.equal(calls,2)
 assert.equal((await f.store.query({kind:'message.coordinator',conversationId:'group'})).sources.length,0)
})

test('暂态探测递增退避，无次数上限，新来源无需等待旧退避', async t=>{
 let now=Date.now(),calls=0
 const f=await fixture(t,false,{clock:()=>now,sessionRunner:{async close(){},async run(){calls++;throw Object.assign(Error('temporary'),{code:'ECONNRESET'})}}})
 await assert.rejects(f.receive('network','资料'),{code:'ECONNRESET'})
 let delay=0
 for(let i=0;i<6;i++){
  const c=(await f.store.query({kind:'message.coordinator',conversationId:'group'})).coordinator
  assert.ok(c.recovery.delayMs>delay);delay=c.recovery.delayMs
  await f.workflow.recover();assert.equal(calls,i+1)
  now=Date.parse(c.retryAt)+1;await f.workflow.recover();assert.equal(calls,i+2)
 }
 await assert.rejects(f.receive('network-new','新增资料'),{code:'ECONNRESET'})
 assert.equal(calls,8)
})

test('群协调传递原始简单加列目标，候选细节不升级为业务硬条件', async t => {
  const f = await fixture(t, true)
  const body = '生产 sales 数据库的order_notes表新增label列，提交Bytebase审批，通过后执行'
  await f.receive('simple-column', body)
  const instruction = f.inputs[0].instructions
  assert.match(instruction, /objective只表达来源中用户要求的交付、范围和明确条件/)
  assert.match(instruction, /系统建议的代码扫描、字段用途澄清、演练、备份等不得扩写/)
  assert.match(instruction, /未指定的实现细节可提出明确候选交真人审批/)
  const state = await f.workflow.state('simple-column')
  assert.equal(state.units[0].goalText, body)
  assert.equal(state.requests.length, 0)
  assert.equal(state.commands.length, 1)
})
