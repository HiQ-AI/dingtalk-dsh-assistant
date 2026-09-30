import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createMessageWorkflow } from '../packages/dingtalk-dsh-assistant/message-workflow.js'

const split = input => ({ kind: 'split', units: [{ spans: [{ start: 0, end: input.sourceLength }], goalText: input.source.text,
  constraints: [], contextNeeds: [] }], sharedConstraints: [], coverage: [{ start: 0, end: input.sourceLength, role: 'unit' }] })
const independent = { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前完整对象与候选目标不同，是独立事项'] }
const answer = { kind: 'intent', actions: [{ intent: 'answer', arguments: { objective: '查询当前业务对象并回答' }, dependsOn: [] }],
  constraints: [], requiredExecutionMaterials: [], replyPolicy: 'result' }
async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'message-repair-coordination-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: 'repair-test', initialize: true })
  const workflow = createMessageWorkflow({ store, ...options })
  t.after(async () => { await workflow.close(); await store.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, workflow }
}
const source = (id, body = id) => ({ runId: id, sourceKey: id, sourceVersion: 1, conversationId: 'group', actorId: 'user', body })
async function until(predicate, description) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(description)
}

test('同群 A 模型等待时 B 仍能进入拆分，不持有整群异步锁', async t => {
  let releaseA, aStarted = false, bStarted = false
  const blocked = new Promise(resolve => { releaseA = resolve })
  const { workflow } = await fixture(t, { context: { bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.runId}`, conversationId: 'group',
    sourceRunId: run.runId, unitId: unit.unitId, title: run.body, facts: [] }) }, judge: async ({ stage, input }) => {
    if (stage === 'S') {
      if (input.source.sourceKey === 'A') { aStarted = true; await blocked } else bStarted = true
      return { kind: 'no_action', reason: '只提供资料，无需回应', coverage: [{ start: 0, end: input.sourceLength }] }
    }
    throw new Error(`unexpected stage ${stage}`)
  } })
  try {
    await workflow.receive(source('A'))
    await until(() => aStarted, 'A 未进入模型')
    await workflow.receive(source('B'))
    await until(() => bStarted, 'B 被 A 的模型调用阻塞')
  } finally { releaseA(); await workflow.process('A'); await workflow.process('B') }
})

test('候选继续读取是 Host 动作，跨页证据累积且恢复不重复已完成模型调用', async t => {
  let reads = 0, calls = 0
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 79 }, (_, i) => ({ candidateId: `c${i}`, title: `旧对象${i}`, goal: `旧对象${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        reads++
        if (input.candidatePage > 0) assert.ok(input.accumulatedEvidence.length >= input.candidatePage)
        return input.candidateContinuation ? { kind: 'continue_candidates', reason: '本页目标均不同，继续核对目录', evidence: ['已核对本页全部对象'] } : independent
      }
      return answer
    }, handlers: { answer: async () => { calls++; return { reply: '已完成查询' } } } })
  await workflow.receive(source('pages', '查询新的业务对象'), { process: false })
  let state = await workflow.process('pages')
  assert.equal(state.commands[0]?.status, 'applied', JSON.stringify(state.run))
  assert.equal(reads, 10)
  const finishedReads = reads
  state = await workflow.process('pages')
  assert.equal(reads, finishedReads)
  assert.equal(calls, 1)
  assert.equal(state.requests.length, 0)
})

test('非法内部目录引用有限纠正，不落成等待用户的请求', async t => {
  let relations = 0
  const { workflow } = await fixture(t, { judge: async ({ stage, input }) => {
    if (stage === 'S') return split(input)
    if (stage === 'R') {
      relations++
      if (relations === 1) return { kind: 'needs_context', reason: '取下一页', needs: [{ resourceRef: 'candidate-catalog:invented:page:1', reason: '内部目录' }] }
      assert.match(input.previousFailure, /REF|RESOURCE|CONTEXT/u)
      return independent
    }
    return answer
  }, handlers: { answer: async () => ({ reply: '已回答' }) } })
  await workflow.receive(source('bad-ref', '查询业务资料'), { process: false })
  const state = await workflow.process('bad-ref')
  assert.equal(state.requests.filter(item => item.status === 'pending').length, 0)
  assert.equal(state.commands[0]?.status, 'applied', JSON.stringify(state.run))
  assert.equal(relations, 2)
})

test('同一消息 A 缺材料不冻结已证明归属独立的 B，恢复后 A 沿原事项完成', async t => {
  let materialReady = false
  const completed = []
  const { workflow } = await fixture(t, { context: {
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${unit.goalText}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
    material: async () => ({ ready: materialReady, data: { text: 'A 的查询资料' } }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [
      { spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [{ resourceRef: 'file-a', reason: 'A 的资料' }] },
      { spans: [{ start: 3, end: 5 }], goalText: '查B', constraints: [], contextNeeds: [] },
    ], sharedConstraints: [], coverage: [{ start: 0, end: 5, role: 'unit' }] }
    if (stage === 'R') return independent
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.unit.goalText); return { reply: '查询完成' } } } })
  await workflow.receive({ ...source('two-units', '查A；查B'), context: { attachments: [{ resourceRef: 'file-a', name: 'A资料' }] } }, { process: false })
  await workflow.process('two-units')
  await until(() => completed.includes('查B'), 'B 被同一来源的 A 材料等待冻结')
  assert.deepEqual(completed, ['查B'])
  assert.equal((await workflow.state('two-units')).requests.filter(item => item.status === 'pending').length, 1)
  materialReady = true
  await workflow.recover()
  await until(() => completed.includes('查A'), 'A 材料恢复后没有继续')
  assert.deepEqual(completed, ['查B', '查A'])
})

test('内部材料失败有界重试后保留系统责任和准确原因，重启不无限重读', async t => {
  let reads = 0
  const { workflow, store } = await fixture(t, { policy: { recoveryDelaysMs: [0, 0] }, context: {
    material: async () => { reads++; return { ready: false, reason: 'CONNECTOR_UNAVAILABLE' } },
  }, judge: async ({ stage, input }) => stage === 'S' ? split(input)
    : { kind: 'needs_context', reason: '读取已提供文件', needs: [{ resourceRef: 'file', reason: '需要完整内容' }] } })
  await workflow.receive({ ...source('bounded-material'), context: { attachments: [{ resourceRef: 'file', name: '已提供文件' }] } }, { process: false })
  await workflow.process('bounded-material')
  for (let i = 0; i < 5; i++) await workflow.recover()
  const state = await store.query({ kind: 'message.run', runId: 'bounded-material' })
  assert.equal(reads, 3)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].blocked, true)
  assert.equal(state.requests[0].responsibility, 'system')
  assert.equal(state.requests[0].lastError, 'CONNECTOR_UNAVAILABLE')
  assert.equal(state.commands.length, 0)
})

test('跨页比较后可以选择首页相关候选，恢复不重复派发', async t => {
  const pages = [], delivered = []
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 9 }, (_, i) => ({ candidateId: `c${i}`, taskId: `task-${i}`, goal: `候选${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        pages.push(input.candidatePage)
        if (input.candidateContinuation) return { kind: 'continue_candidates', reason: '先比较目录末页', evidence: ['首页首项相关，继续核对其余项'],
          assessments: [{ candidateId: 'c0', relation: 'related', reason: '原对象相同', sourceQuote: '查A' }] }
        assert.ok(input.candidates.some(card => card.candidateId === 'c0'))
        assert.ok(input.accumulatedEvidence.some(page => page.assessments.some(item => item.candidateId === 'c0')))
        return { kind: 'binding', disposition: 'existing', candidateId: 'c0', evidence: ['全目录比较后选择首项'] }
      }
      return answer
    }, handlers: { answer: async (_, info) => { delivered.push(info.binding.candidateId); return { reply: '已查询原任务' } } } })
  await workflow.receive(source('first-page-choice', '查A'), { process: false })
  const state = await workflow.process('first-page-choice')
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.deepEqual(pages, [0, 1])
  assert.deepEqual(delivered, ['c0'])
  await workflow.recover()
  assert.deepEqual(delivered, ['c0'])
})

test('非法作用域quote在当轮明确纠正，不等待普通恢复周期', async t => {
  let relations = 0
  const { workflow } = await fixture(t, { policy: { recoveryDelaysMs: [60_000, 60_000] }, context: { candidates: async () => [{ candidateId: 'c0', goal: '另一个业务对象' }] },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        relations++
        if (relations === 1) return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '对象不同', sourceQuote: '不存在的原文' }] }
        assert.match(input.previousFailure, /MESSAGE_SCOPE_PROOF_INVALID/)
        return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '对象不同', sourceQuote: '查A' }] }
      }
      return answer
    }, handlers: { answer: async () => ({ reply: '查询完成' }) } })
  await workflow.receive(source('scope-correction', '查A'), { process: false })
  const state = await workflow.process('scope-correction')
  assert.equal(relations, 2)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
  assert.equal(state.requests.length, 0)
})

test('跨页相关候选未撤销时不能直接新建，明确重评后才派发', async t => {
  let finalJudgments = 0, executed = 0
  const { workflow } = await fixture(t, { context: { candidates: async () => Array.from({ length: 9 }, (_, i) => ({ candidateId: `c${i}`, goal: `候选${i}` })) },
    judge: async ({ stage, input }) => {
      if (stage === 'S') return split(input)
      if (stage === 'R') {
        if (input.candidateContinuation) return { kind: 'continue_candidates', reason: '仍需比较目录', evidence: ['首项可能是同一目标'],
          assessments: [{ candidateId: 'c0', relation: 'related', reason: '业务对象相同待比较', sourceQuote: '查A' }] }
        finalJudgments++
        if (finalJudgments === 1) return independent
        assert.match(input.previousFailure, /MESSAGE_/)
        assert.equal(executed, 0, '矛盾归属不得先产生效果')
        return { ...independent, assessments: [{ candidateId: 'c0', relation: 'independent', reason: '完整比较后确认对象不同', sourceQuote: '查A' }] }
      }
      return answer
    }, handlers: { answer: async () => { executed++; return { reply: '完成查询' } } } })
  await workflow.receive(source('related-then-new', '查A'), { process: false })
  const state = await workflow.process('related-then-new')
  assert.equal(finalJudgments, 2)
  assert.equal(executed, 1)
  assert.equal(state.run.status, 'settled', JSON.stringify(state.run))
})

test('非连续原文span分别提交来源证明，真实ledger接纳独立事项', async t => {
  const body = '查A；说明：仅参考；A保留旧状态'
  const finalStart = body.indexOf('A保留')
  const completed = []
  const { workflow, store } = await fixture(t, { context: {
    candidates: async ({ run }) => run.runId === 'seed' ? [] : [{ candidateId: 'old', topicId: 'topic-seed', goal: '查库存' }],
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${run.runId}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return input.source.sourceKey === 'seed' ? split(input) : { kind: 'split', units: [{
      spans: [{ start: 0, end: 2 }, { start: finalStart, end: body.length }], goalText: '查A并保留旧状态', constraints: [], contextNeeds: [],
    }], sharedConstraints: [], coverage: [{ start: 0, end: body.length, role: 'unit' }] }
    if (stage === 'R') return input.sourceKey === 'seed' ? independent : { ...independent,
      assessments: [{ candidateId: 'old', relation: 'independent', reason: '查A与库存目标不同', sourceQuote: '查A' }] }
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.run.runId); return { reply: '查询完成' } } } })
  await workflow.receive(source('seed', '查库存'), { process: false })
  await workflow.process('seed')
  await until(() => completed.includes('seed'), '基准事项未完成')
  await workflow.receive(source('non-contiguous', body), { process: false })
  await workflow.process('non-contiguous')
  await until(() => completed.includes('non-contiguous'), '合法多span证明被错误判为来源漂移')
  const current = await workflow.state('non-contiguous')
  assert.equal(current.run.status, 'settled', JSON.stringify(current.run))
  const impact = await store.query({ kind: 'message.impact', runId: 'non-contiguous' })
  const saved = JSON.stringify(impact.impact)
  assert.ok(saved.includes('independent'))
  assert.ok(!saved.includes('查A\\nA保留旧状态'))
})

test('A局部协议失败不阻止尚未关联的B，恢复不重复B效果', async t => {
  const completed = []
  const { workflow } = await fixture(t, { policy: { maxCorrections: 0 }, context: {
    candidates: async ({ unit }) => { if (unit.goalText === '查B') await new Promise(resolve => setTimeout(resolve, 80)); return [] },
    bindTopic: async ({ run, unit }) => ({ topicId: `topic-${unit.goalText}`, conversationId: run.conversationId,
      sourceRunId: run.runId, unitId: unit.unitId, title: unit.goalText, facts: [] }),
  }, judge: async ({ stage, input }) => {
    if (stage === 'S') return { kind: 'split', units: [
      { spans: [{ start: 0, end: 2 }], goalText: '查A', constraints: [], contextNeeds: [] },
      { spans: [{ start: 3, end: 5 }], goalText: '查B', constraints: [], contextNeeds: [] },
    ], sharedConstraints: [], coverage: [{ start: 0, end: 5, role: 'unit' }] }
    if (stage === 'R') return input.text === '查A'
      ? { kind: 'needs_context', reason: '非法内部材料', needs: [{ resourceRef: 'fake', reason: '内部材料' }] }
      : { ...independent, assessments: input.candidates.filter(item => item.unboundSource).map(item => ({ candidateId: item.candidateId,
        relation: 'independent', reason: '查B与查A各自查询独立对象，无共享条件', sourceQuote: '查B' })) }
    return { kind: 'topic_intents', decisions: input.units.map(unit => ({ unitId: unit.unitId, intent: answer })) }
  }, handlers: { answer: async (_, info) => { completed.push(info.unit.goalText); return { reply: '查询完成' } } } })
  await workflow.receive(source('local-failure', '查A；查B'), { process: false })
  await workflow.process('local-failure')
  await until(() => completed.includes('查B'), 'B被另一Unit协议失败阻止').catch(async () => {
    const state = await workflow.state('local-failure')
    assert.fail(JSON.stringify({ run: state.run, units: state.units, nodes: state.nodes.map(node => ({ unitId: node.unitId, nodeId: node.nodeId, status: node.status, error: node.error })), commands: state.commands }))
  })
  let state = await workflow.state('local-failure')
  assert.match(state.units.find(unit => unit.goalText === '查A').blockedReason, /PROTOCOL_CORRECTION_EXHAUSTED/)
  assert.deepEqual(completed, ['查B'])
  await workflow.recover()
  state = await workflow.state('local-failure')
  assert.deepEqual(completed, ['查B'])
  assert.equal(state.units.find(unit => unit.goalText === '查B').status, 'applied')
})

test('旧policy连续交办经大目录失败排队重启后完成IB派发与独立通知回读',async t=>{
 const {DatabaseSync}=await import('node:sqlite')
 const {createWorkflowNotifications}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 const directory=await mkdtemp(join(tmpdir(),'message-chain-')),dbPath=join(directory,'control.sqlite')
 let store=await openExecutionStore({dbPath,instanceId:'chain',initialize:true}),workflow
 t.after(async()=>{await workflow?.close();await store.close();await rm(directory,{recursive:true,force:true})})
 const texts={first:'请分析69条审核数据的刷库方案，行业审核保留，脚本完成后先交负责人审批。',second:'补充：先用两条测试，刷完找我验证，验证通过再处理69条正式数据。'}
 const pageCalls=[],effects=[],windows=[];let failed=false,ibCalls=0
 const create=()=>createMessageWorkflow({store:{query:(...args)=>store.query(...args),command:request=>{if(request.kind==='message.node.claim')windows.push(request.args.leaseWindowMs);return store.command(request)}},
  context:{candidates:async()=>Array.from({length:79},(_,i)=>({candidateId:`catalog-${i}`,goal:`其他历史事项${i}`})),
   bindTopic:async({run,unit})=>({topicId:'audit-plan',conversationId:'group',sourceRunId:run.runId,unitId:unit.unitId,title:'审核数据方案',facts:[]})},
  judge:async({stage,input})=>{
   if(stage==='S')return split(input)
   if(stage==='R'){
    pageCalls.push(`${input.sourceKey}:${input.candidatePage}`)
    if(input.sourceKey==='first'&&input.candidatePage===1&&!failed){failed=true;throw new Error('MESSAGE_NODE_TIMEOUT')}
    return input.candidateContinuation?{kind:'continue_candidates',reason:'继续核对候选',evidence:['已核对当前页']} : independent
   }
   assert.equal(stage,'IB');ibCalls++;assert.equal(input.units.length,2)
   const evidence=JSON.stringify(input);assert.ok(evidence.includes('行业审核保留'));assert.ok(evidence.includes('验证通过再处理69条'))
   return {kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:answer}))}
  },handlers:{answer:async(_,info)=>{effects.push(info.run.runId);return {reply:'已完成只读方案分析，生产操作等待既定审批和测试验证。'}}}})
 workflow=create()
 for(const [runId,body] of Object.entries(texts))await store.command({id:`receive-${runId}`,kind:'message.receive',args:{...source(runId,body),context:{sourceMessageId:`in-${runId}`},policy:{initialWindowMs:90000,linkedWindowMs:90000,attemptMs:20000,maxClaims:21,maxCorrections:2}}})
 await workflow.process('first');assert.equal(effects.length,0)
 await workflow.process('second');assert.equal(effects.length,0,'第一条关联未完成前不得派发第二条')
 await workflow.close();await store.close()
 const db=new DatabaseSync(dbPath)
 try{
  for(const row of db.prepare('SELECT run_id,body FROM message_runs').all()){const r=JSON.parse(row.body);r.createdAt='2020-01-01T00:00:00.000Z';r.executionStartedAt=r.createdAt;r.deadline=r.createdAt;db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(r),row.run_id)}
  for(const row of db.prepare("SELECT rowid,body FROM message_items WHERE kind='node'").all()){const n=JSON.parse(row.body);if(n.status==='failed'){n.retryAt='2020-01-01T00:00:00.000Z';db.prepare('UPDATE message_items SET body=? WHERE rowid=?').run(JSON.stringify(n),row.rowid)}}
 }finally{db.close()}
 store=await openExecutionStore({dbPath,instanceId:'chain'});workflow=create();await workflow.recover()
 await until(()=>effects.length===2,'关联恢复后未完成IB及真实handler派发')
 assert.equal(ibCalls,1);assert.deepEqual([...effects].sort(),['first','second']);assert.equal(pageCalls.filter(page=>page==='first:0').length,1,'重启应复用已经成功的R页');assert.equal(pageCalls.filter(page=>page==='first:1').length,2)
 assert.ok(windows.every(ms=>ms===60500),'所有阶段使用当前Host窗口，不使用旧20秒policy')
 let sent=0,readbacks=0
 const notices=createWorkflowNotifications({store,controller:{},artifacts:{},adapter:{canDisclose:async()=>true,send:async()=>({messageId:`out-${++sent}`}),readback:async notification=>{readbacks++;return {messageId:notification.ack.messageId}}}})
 await notices.flush();await notices.flush()
 assert.equal(sent,2);assert.equal(readbacks,2)
 const delivered=await store.query({kind:'message.notifications',states:['delivered']});assert.equal(delivered.length,2)
 for(const runId of Object.keys(texts)){const state=await workflow.state(runId);assert.equal(state.run.status,'settled');assert.equal(state.commands.length,1);assert.equal(state.commands[0].status,'applied');assert.equal(state.run.policy.attemptMs,20000)}
})

for(const failedStage of ['R','IB'])test('hN真实材料在'+failedStage+'读取失败等待恢复后贯穿R与IB并进入执行合同',async t=>{
 const {createWorkflowNotifications}=await import('../packages/dingtalk-dsh-assistant/workflow-notifications.js')
 let available=false,executed=0,ib=0
 const material={resources:[{resourceRef:'original-file-source',text:'sheet1!Y2=new-reviewer；行业记录保留；先两条验证再69条'}]}
 const {workflow,store}=await fixture(t,{policy:{recoveryDelaysMs:[0,0]},context:{
  validateActions:async({intent})=>{assert.deepEqual(intent.requiredExecutionMaterials,['original-file-source']);return {kind:'accepted'}},
  history:async()=>[{sourceKey:'original-file-source',actorId:'user',text:'文件审核条目.xlsx'}],
  material:async({needs,nodeId})=>{assert.deepEqual(needs.map(item=>item.resourceRef),['original-file-source']);if(!available&&nodeId===failedStage)throw new Error('CONNECTOR_UNAVAILABLE');return {ready:true,data:material}},
  bindTopic:async({run,unit})=>({topicId:'material-topic',conversationId:'group',sourceRunId:run.runId,unitId:unit.unitId,title:'审核方案',facts:[]})},
  judge:async({stage,input})=>{
   if(stage==='S'){const output=split(input);output.units[0].contextNeeds=[{resourceRef:'h1',reason:'读取审核表'}];return output}
   if(stage==='R')return independent
   assert.equal(stage,'IB');ib++;assert.ok(JSON.stringify(input).includes('sheet1!Y2=new-reviewer'))
   return {kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:answer}))}
  },handlers:{answer:async action=>{assert.deepEqual(action.requiredExecutionMaterials,['original-file-source']);executed++;return {reply:'已分析完整材料'}}}})
 await workflow.receive({...source('material-chain','读取表格分析审核方案'),context:{sourceMessageId:'in'}},{process:false})
 await workflow.process('material-chain');for(let i=0;i<4;i++)await workflow.recover()
 let state=await workflow.state('material-chain');assert.equal(state.run.status,'waiting');assert.equal(state.requests[0].blocked,true);assert.equal(ib,0);assert.equal(executed,0)
 const notifier=createWorkflowNotifications({store,controller:{},artifacts:{}});await notifier.flush()
 const notices=await store.query({kind:'message.notifications',states:['prepared']});assert.ok(notices.some(notice=>notice.payload.phase==='system_wait'))
 available=true
 await store.command({id:'retry-material',kind:'message.request.retry.reset',args:{runId:'material-chain',requestId:state.requests[0].id,sourceVersion:1,reason:'连接器恢复',dependencyRevision:'connector-ready'}})
 await workflow.recover();await until(()=>executed===1,'恢复后未执行带完整材料的命令')
 state=await workflow.state('material-chain');assert.equal(state.run.status,'settled');assert.equal(ib,1);assert.equal(state.commands[0].args.requiredExecutionMaterials[0],'original-file-source')
})

test('恢复同时发起两个大目录run，FIFO模型槽使第一页交替推进',async t=>{
 const calls=[]
 const {workflow}=await fixture(t,{policy:{concurrency:1},context:{bindTopic:async({run,unit})=>({topicId:'fair-topic',conversationId:'group',sourceRunId:run.runId,unitId:unit.unitId,title:'并发事项',facts:[]}),candidates:async()=>Array.from({length:24},(_,i)=>({candidateId:`c${i}`,goal:`旧事项${i}`}))},judge:async({stage,input})=>{
  if(stage==='S')return split(input)
  if(stage==='R'){calls.push(`${input.sourceKey}:${input.candidatePage}`);await new Promise(resolve=>setTimeout(resolve,5));return input.candidateContinuation?{kind:'continue_candidates',reason:'继续',evidence:['核对当前页']}:independent}
  return {kind:'topic_intents',decisions:input.units.map(unit=>({unitId:unit.unitId,intent:{...answer,actions:[{intent:'no_action',arguments:{},dependsOn:[]}]}}))}
 }})
 await workflow.receive(source('queue-a'),{process:false});await workflow.receive(source('queue-b'),{process:false});await workflow.recover()
 assert.ok(calls.indexOf('queue-b:0')<calls.indexOf('queue-a:2'),JSON.stringify(calls))
 await until(async()=> (await workflow.state('queue-a')).run.status==='settled','IB未完成');assert.equal((await workflow.state('queue-a')).run.status,'settled');assert.equal((await workflow.state('queue-b')).run.status,'settled')
})

test('重启后既有空材料pending命令在最终派发补齐合同，等待恢复前零领取',async t=>{
 const {prepareMessageContext}=await import('../packages/dingtalk-dsh-assistant/message-context.js')
 const directory=await mkdtemp(join(tmpdir(),'pending-material-')),dbPath=join(directory,'control.sqlite')
 let store=await openExecutionStore({dbPath,instanceId:'pending-material',initialize:true}),workflow,available=false,executed=0
 t.after(async()=>{await workflow?.close();await store.close();await rm(directory,{recursive:true,force:true})})
 const run={...source('old-command','按表格分析审核方案'),context:{sourceMessageId:'in'},policy:{initialWindowMs:90000,linkedWindowMs:90000}}
 const call=(kind,args)=>store.command({id:`prepare-${kind}`,kind:`message.${kind}`,args})
 await call('receive',run)
 const snapshot=await prepareMessageContext(run,{history:async()=>[{sourceKey:'file-origin',actorId:'user',text:'审核表.xlsx'}]})
 await call('snapshot',{runId:run.runId,snapshot})
 await call('split',{runId:run.runId,units:[{unitId:'u',spans:[{start:0,end:run.body.length}],goalText:run.body,constraints:[],sharedConstraints:[],contextNeeds:[{resourceRef:'h1',reason:'需审核表'}]}]})
 await call('accept',{runId:run.runId,unitId:'u',commands:[{commandId:'pending-answer',kind:'answer',args:{taskId:null,arguments:{objective:'分析审核方案'},binding:independent,requiredExecutionMaterials:[],replyPolicy:'result'},dependsOn:[]}]})
 await store.close();store=await openExecutionStore({dbPath,instanceId:'pending-material'})
 workflow=createMessageWorkflow({store,policy:{recoveryDelaysMs:[0,0]},context:{material:async({needs})=>{assert.deepEqual(needs.map(need=>need.resourceRef),['file-origin']);return available?{ready:true,data:{resources:[{resourceRef:'file-origin',text:'sheet1!Y2=新专家'}]}}:{ready:false,reason:'MATERIAL_READ_FAILED:unavailable'}},validateAction:async action=>{assert.deepEqual(action.requiredExecutionMaterials,['file-origin']);return {allowed:true}}},judge:async()=>{throw new Error('不得重判已接纳命令')},handlers:{answer:async action=>{assert.deepEqual(action.requiredExecutionMaterials,['file-origin']);executed++;return {reply:'已按真实表格分析'}}}})
 await workflow.recover();let state=await workflow.state(run.runId)
 assert.equal(executed,0);assert.equal(state.commands[0].status,'pending');assert.equal(state.commands[0].leaseEpoch,0);assert.equal(state.requests[0].nodeId,'execute');assert.equal(state.run.status,'waiting')
 available=true;await workflow.recover();state=await workflow.state(run.runId)
 assert.equal(executed,1);assert.equal(state.commands[0].status,'applied');assert.equal(state.run.status,'settled');assert.equal(state.nodes.length,0)
 await workflow.recover();assert.equal(executed,1)
})

for(const kind of ['pause','cancel'])test(`已有${kind}控制不继承无关材料，显式材料合同仍等待`,async t=>{
 let reads=0,effects=0
 const {workflow,store}=await fixture(t,{judge:async()=>{throw new Error('不应重判控制命令')},context:{material:async()=>{reads++;return {ready:false,reason:'FILE_UNAVAILABLE'}}},handlers:{[kind]:async(_,info)=>{assert.equal(info.unit.id,'u');effects++;return {ok:true}}}})
 const setup=async(id,explicit)=>{
  await workflow.receive(source(id),{process:false})
  await store.command({id:`split-${id}`,kind:'message.split',args:{runId:id,units:[{unitId:id==='implicit'?'u':'v',spans:[{start:0,end:id.length}],goalText:id,constraints:[],contextNeeds:[{resourceRef:'file',reason:'原事项材料'}]}]}})
  await store.command({id:`accept-${id}`,kind:'message.accept',args:{runId:id,unitId:id==='implicit'?'u':'v',commands:[{commandId:`command-${id}`,kind,args:{binding:independent,requiredExecutionMaterials:explicit?['file']:[],replyPolicy:'none'},dependsOn:[]}]}})
  await workflow.commandSettled(id)
 }
 await setup('implicit',false);assert.equal(effects,1);assert.equal(reads,0)
 await setup('explicit',true);assert.equal(effects,1);assert.equal(reads,1);assert.equal((await workflow.state('explicit')).requests[0].kind,'needs_context')
})
