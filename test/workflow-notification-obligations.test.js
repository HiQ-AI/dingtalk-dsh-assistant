import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createWorkflowNotifications, notificationSilence, sameDeliveredText } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'

async function fixture(t, body = '请处理') {
  const dir = await mkdtemp(join(tmpdir(), 'notice-obligation-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: randomUUID(), initialize: true })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (kind, args) => store.command({ id: randomUUID(), kind: `message.${kind}`, args })
  await call('receive', { runId: 'm', sourceKey: 'source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body,
    context: { sourceMessageId: 'in', replyObligation: { required: true, sourceKey: 'source', sourceVersion: 1 } } })
  return { store, call, notices: () => store.query({ kind: 'message.notifications', states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded'] }),
    flush: adapter => createWorkflowNotifications({ store, controller: { taskPlan: taskId => store.query({ kind: 'task.plan', taskId }) }, artifacts: {}, adapter }).flush() }
}

test('需要排查的容量失败有真实状态通知，重启扫描不重复', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'MESSAGE_MODEL_CONTEXT_WINDOW_EXCEEDED:S:$' })
  await f.flush(); await f.flush()
  const notices = await f.notices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].payload.text, '处理遇到系统问题，无法继续推进，需要人工介入。')
  assert.equal(notices[0].payload.fact.sourceVersion, 1)
  assert.equal(notices[0].status, 'prepared')
})

test('点名问候无业务command仍有一次回应，发送未知只回读', async t => {
  const f = await fixture(t, '小小鹏在不在')
  const node = (await f.call('node.claim', { runId: 'm', unitId: '$', nodeId: 'S', input: {}, leaseWindowMs: 60500 })).result.node
  await f.call('node.complete', { runId: 'm', nodeRunId: node.nodeRunId, leaseEpoch: node.leaseEpoch,
    output: { kind: 'no_action', reason: '问候', coverage: [{ start: 0, end: '小小鹏在不在'.length }] } })
  await f.call('no_action', { runId: 'm', reason: '问候' })
  let sends = 0, reads = 0
  const adapter = { canDisclose: async () => true, send: async () => { sends++; throw new Error('ack lost') },
    readback: async () => { reads++; return reads > 1 ? { messageId: 'out' } : null } }
  await f.flush(adapter); await f.flush(adapter)
  assert.equal(sends, 1); assert.equal(reads, 2)
  const [notice] = await f.notices()
  assert.equal(notice.payload.text, '在的，请说。')
  assert.equal(notice.status, 'delivered')
  assert.equal((await f.store.query({ kind: 'message.run', runId: 'm' })).commands.length, 0)
})

test('仅禁止业务通知不限制助手生命周期；明确助手静默保留来源', () => {
  const run = { sourceKey: 's', sourceVersion: 3, body: '不改派单，不发送消息，也不改审核轮次。' }
  assert.equal(notificationSilence(run, 'receipt'), null)
  assert.deepEqual(notificationSilence({ ...run, body: '处理完不用给我发进度通知' }, 'progress'),
    { sourceKey: 's', sourceVersion: 3, sourceQuote: '不用给我发进度通知', scope: 'assistant_progress' })
  assert.equal(notificationSilence({ ...run, body: '不用给我发进度通知' }, 'required_action'), null)
  assert.equal(notificationSilence({ ...run, body: '不用给我发进度通知' }, 'result'), null)
  assert.equal(notificationSilence({ ...run, body: '不用回复我。' }, 'reply_obligation').scope, 'assistant_all')
})

test('内部读取失败不按次数制造人工告知；恢复后仍无多余回复', async t => {
  const f = await fixture(t)
  await f.call('wait', { runId: 'm', unitId: '$', nodeId: 'R', reason: '读取文件', request: { requestId: 'q', kind: 'needs_context', needs: [] } })
  await f.flush(); assert.equal((await f.notices()).length, 0)
  await f.call('request.retry', { runId: 'm', requestId: 'q', error: 'READ_FAILED', contractVersion: 'test-v1' })
  await f.flush(); await f.flush()
  assert.equal((await f.notices()).length, 0)
  await f.call('request.resolve', { runId: 'm', requestId: 'q', actorId: 'a', eventId: 'material-ready', answer: { ready: true } })
  await f.flush()
  assert.equal((await f.notices()).length, 0)
})

test('来源更新使已准备的系统状态通知失效，零发送', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'MANUAL_RECOVERY_REQUIRED' })
  await f.flush()
  const [notice] = await f.notices()
  await f.call('receive', { runId: 'm2', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '修正要求' })
  const result = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(result.dispatchEligible, false)
  assert.equal(result.result.notification.status, 'superseded')
})

test('Task已落账但command尚未完成仍有承接责任，完成后不重复；需求修订使旧回执失效', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  await f.store.command({ id: 'task-accept', kind: 'task.accept', args: { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`,
    requirementRevision: 1, sessionId: 'owner', criteria: ['交付结果'], sourceKey: 'source', eventKey: 'created' } })
  await f.flush()
  const [notice] = await f.notices()
  assert.equal(notice.payload.phase, 'accepted')
  assert.equal(notice.payload.text, '正在核对执行条件，处理尚未开始。')
  assert.equal(notice.payload.fact.requirementRevision, 1)
  await f.call('command.complete', { commandId: 'c', leaseEpoch: claim.leaseEpoch, result: { taskId: 'task', reply: '已收到' } })
  await f.flush(); assert.equal((await f.notices()).length, 1)
  await f.store.command({ id: 'task-update', kind: 'task.requirement.update', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'updated' } })
  const stale = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(stale.dispatchEligible, false)
  assert.equal(stale.result.notification.status, 'superseded')
  await f.flush()
})

test('发送未知后来源更新仍回读旧通知，不删除效果或再次发送', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'MANUAL_RECOVERY_REQUIRED' })
  let sends = 0, reads = 0
  const adapter = { canDisclose: async () => true, send: async () => { sends++; throw new Error('unknown') },
    readback: async () => ++reads > 1 ? { messageId: 'out' } : null }
  await f.flush(adapter)
  await f.call('receive', { runId: 'm2', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '更新目标' })
  await f.flush(adapter)
  assert.equal(sends, 1); assert.equal(reads, 2)
  assert.equal((await f.notices())[0].status, 'delivered')
})

for (const revised of [false, true]) test(`无计划Owner阻塞报告：${revised ? '新需求使未发报告失效' : '可发送且unknown在更新后仍回读'}`, async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  const send = (kind, args) => f.store.command({ id: randomUUID(), kind, args })
  await send('task.accept', { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`, requirementRevision: 1,
    sessionId: 'owner', criteria: ['交付结果'], sourceKey: 'source', eventKey: 'created' })
  await f.call('command.complete', { commandId: 'c', leaseEpoch: claim.leaseEpoch, result: { taskId: 'task' } })
  await send('task.owner.claim', { taskId: 'task', turnId: 'turn', expectedLeaseEpoch: 0 })
  await send('task.owner.sessionBound', { taskId: 'task', turnId: 'turn', leaseEpoch: 1, sessionId: 'owner' })
  await send('task.owner.candidate', { taskId: 'task', turnId: 'turn', leaseEpoch: 1,
    decision: { action: 'block', summary: '缺少读取生产状态的能力，尚未开始。', evidenceRefs: [] } })
  await send('task.owner.accept', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await send('task.owner.applied', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await f.flush()
  const notice = (await f.notices()).find(item => item.payload.phase.startsWith('owner:'))
  assert.ok(notice)
  if (revised) {
    await send('task.requirement.update', { taskId: 'task', expectedRequirementRevision: 1,
      requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'before-claim' })
    const stale = await f.call('notification.claim', { notificationId: notice.id })
    assert.equal(stale.dispatchEligible, false)
    assert.equal(stale.result.notification.status, 'superseded')
    return
  }
  const preparedClaim = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(preparedClaim.dispatchEligible, true)
  await f.call('notification.fail', { notificationId: notice.id, leaseEpoch: preparedClaim.result.notification.leaseEpoch, error: 'ack lost' })
  await send('task.requirement.update', { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'new-requirement' })
  await f.flush({ canDisclose: async () => true, send: async () => { throw new Error('no new send expected') }, readback: async () => ({ messageId: 'out' }) })
  assert.equal((await f.notices()).find(item => item.id === notice.id).status, 'delivered')
})

test('replyPolicy none不丢Task承接及Owner阻塞事实，重新扫描幂等', async () => {
  const run = { runId: 'm', sourceKey: 's', sourceVersion: 1, revision: 0, conversationId: 'g', actorId: 'a', context: { sourceMessageId: 'in' } }
  const action = { commandId: 'c', status: 'applied', kind: 'create', args: { replyPolicy: 'none' }, result: { taskId: 'task', reply: '已收到要求，目前尚未开始。' } }
  const notices = new Map(); let reports = 0
  const store = { async query(q) {
    if (q.kind === 'message.notification.diagnostics') return []
    if (q.kind === 'message.list') return [run]
    if (q.kind === 'message.run') return { run, requests: [], commands: [action] }
    if (q.kind === 'message.acceptances') return []
    if (q.kind === 'message.notification') return notices.get(q.notificationId)
    if (q.kind === 'message.task.latest' || q.kind === 'task.deleted' || q.kind === 'message.owner.released-wait') return null
    if (q.kind === 'task.owner.reports') { reports++; return [{ reportId: 'report', reportType: 'block', applicationStatus: 'applied', triggerTypes: [], facts: { summary: '等待负责人审批。' } }] }
    throw new Error(q.kind)
  }, async command({ kind, args }) { assert.equal(kind, 'message.notification.prepare'); notices.set(args.notificationId, { ...args, id: args.notificationId }); return {} } }
  await createWorkflowNotifications({ store }).flush()
  await createWorkflowNotifications({ store }).flush()
  assert.equal(reports, 2); assert.equal(notices.size, 2)
  assert.ok([...notices.values()].some(n => n.payload.text.includes('尚未开始')))
  const blocked = [...notices.values()].find(n => n.payload.phase.startsWith('owner:'))
  assert.ok(blocked.payload.text.startsWith('处理暂时受阻，需要人工介入。'))
  assert.equal(blocked.payload.text.includes('等待负责人审批'), true)
})

test('同一事项的多条补充不逐条回复，实际开始仍有一次通知', async () => {
  const run={runId:'supplement',sourceKey:'source',sourceVersion:1,revision:0,conversationId:'g',actorId:'a',context:{sourceMessageId:'in'}}
  const commands=['first','second'].map(commandId=>({commandId,status:'applied',kind:'revise',args:{replyPolicy:'receipt'},result:{taskId:'task',reply:'任务要求已更新，正在核对后续处理。'}}))
  const notices=new Map()
  const store={async query(q){
    if(['message.notification.diagnostics','message.acceptances','task.owner.reports'].includes(q.kind))return []
    if(q.kind==='message.list')return [run]
    if(q.kind==='message.run')return {run,requests:[],commands}
    if(q.kind==='message.notification')return q.eventKey?[...notices.values()].find(n=>n.eventKey===q.eventKey):notices.get(q.notificationId)
    if(['message.task.latest','task.deleted','message.owner.released-wait'].includes(q.kind))return null
    throw Error(q.kind)
  },async command({args}){notices.set(args.notificationId,{...args,id:args.notificationId});return {}}}
  const controller={taskPlan:async()=>({task:{controlState:'active'},stages:[{status:'running',runId:'run'}]}),state:async()=>({run:{status:'running'},nodes:[{status:'running',startedAt:'2026-10-01T00:00:00Z'}]})}
  for(let n=0;n<2;n++)await createWorkflowNotifications({store,controller}).flush()
  assert.equal(notices.size,1)
  assert.equal([...notices.values()][0].payload.text,'任务已开始处理。')
})

test('只有节点真实开始才发开始进度，重复扫描沿用同一通知', async () => {
 for(const mode of ['planned','created','started','paused']) {
  const run={runId:'start-message',sourceKey:'source',sourceVersion:1,revision:0,conversationId:'g',actorId:'a',context:{sourceMessageId:'in'}}
  const action={commandId:'start-command',status:'applied',kind:'create',args:{replyPolicy:'none'},result:{taskId:'task'}}
  const notices=new Map()
  const store={async query(q){
   if(q.kind==='message.notification.diagnostics'||q.kind==='message.acceptances'||q.kind==='task.owner.reports')return[]
   if(q.kind==='message.list')return[run]
   if(q.kind==='message.run')return{run,requests:[],commands:[action]}
   if(q.kind==='message.notification')return q.eventKey?[...notices.values()].find(n=>n.eventKey===q.eventKey):notices.get(q.notificationId)
   if(['message.task.latest','task.deleted','message.owner.released-wait'].includes(q.kind))return null
   throw Error(q.kind)
  },async command({args}){notices.set(args.notificationId,{...args,id:args.notificationId});return{}}}
  const controller={taskPlan:async()=>({task:{controlState:mode==='paused'?'paused':'active'},stages:[{status:mode==='planned'?'planned':'running',runId:'run'}]}),state:async()=>({run:{status:'running'},nodes:[{status:'running',startedAt:mode==='created'?null:'2026-10-01T00:00:00Z'}]})}
  for(let n=0;n<2;n++)await createWorkflowNotifications({store,controller}).flush()
  const starts=[...notices.values()].filter(n=>n.payload.phase.startsWith('owner:started:'))
  assert.equal(starts.length,mode==='started'?1:0)
  if(starts.length)assert.equal(starts[0].payload.text,'任务已开始处理。')
 }
})

for (const started of [false, true]) test(`开始通知领取核对真实执行状态：${started}`, async t => {
  const f = await fixture(t)
  const send = (kind, args) => f.store.command({ id: randomUUID(), kind, args })
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '任务' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'start-command', kind: 'create', args: { taskId: 'task' } }] })
  const binding = (await f.call('command.claim', { commandId: 'start-command' })).result.command
  await f.call('command.complete', { commandId: 'start-command', leaseEpoch: binding.leaseEpoch, result: { taskId: 'task' } })
  await send('task.accept', { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`, requirementRevision: 1, sessionId: 'owner', criteria: ['结果'], sourceKey: 'source', eventKey: 'created' })
  await send('task.plan.initialize', { taskId: 'task', expectedPlanRevision: 0, expectedRequirementRevision: 1, expectedControlRevision: 1, stages: [{ stageId: 'stage-1', workflowId: 'w', workflowDigest: 'a'.repeat(64), unavailableReason: null, requirementRef: 'sha256/in', gate: 'none' }] })
  await send('run.create', { runId: 'business', taskId: 'task', workflowId: 'w', workflowDigest: 'a'.repeat(64), requirementRef: 'sha256/in', stageBinding: { planRevision: 1, stageId: 'stage-1', attempt: 1, expectedControlRevision: 1 }, nodes: [{ nodeId: 'n', nodeVersion: '1', executor: 'code', inputRef: 'sha256/in', inputDigest: 'a'.repeat(64) }] })
  if (started) await send('node.claim', { runId: 'business', nodeId: 'n', expectedGeneration: 1, expectedLeaseEpoch: 0 })
  await f.call('notification.prepare', { runId: 'm', commandId: 'start-command', notificationId: 'start', eventKey: 'task.owner.report:started:business', payload: { phase: 'owner:started:business', text: '任务已开始处理。', fact: { taskId: 'task', sourceVersion: 1, runRevision: 0 } }, disclosure: { conversationId: 'g', authorizationRef: 'source' } })
  const claim = await f.call('notification.claim', { notificationId: 'start' })
  assert.equal(claim.dispatchEligible, started)
  assert.equal(claim.result.notification.status, started ? 'sending' : 'superseded')
})

test('旧Owner报告跨command已送达，稳定eventKey复用且其他prepared正常投递', async t => {
  const f=await fixture(t)
  const send=(kind,args)=>f.store.command({id:randomUUID(),kind,args})
  await send('task.accept',{taskId:'task',requirementRef:`sha256-${'a'.repeat(64)}.json`,requirementRevision:1,sessionId:'owner',criteria:['交付结果'],sourceKey:'source',eventKey:'created'})
  await send('task.owner.claim',{taskId:'task',turnId:'turn',expectedLeaseEpoch:0})
  await send('task.owner.sessionBound',{taskId:'task',turnId:'turn',leaseEpoch:1,sessionId:'owner'})
  await send('task.owner.candidate',{taskId:'task',turnId:'turn',leaseEpoch:1,decision:{action:'block',summary:'等待审批',evidenceRefs:[]}})
  await send('task.owner.accept',{taskId:'task',turnId:'turn',leaseEpoch:1})
  await send('task.owner.applied',{taskId:'task',turnId:'turn',leaseEpoch:1})
  const [report]=await f.store.query({kind:'task.owner.reports',taskId:'task'})
  const eventKey=`task.owner.report:${report.reportId}`
  await f.call('split',{runId:'m',units:[{unitId:'u'}]})
  await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'old-command',kind:'revise',args:{taskId:'task',replyPolicy:'none'}},{commandId:'c',kind:'revise',args:{taskId:'task',replyPolicy:'none'}}]})
  const oldCommand=(await f.call('command.claim',{commandId:'old-command'})).result.command
  await f.call('command.complete',{commandId:'old-command',leaseEpoch:oldCommand.leaseEpoch,result:{taskId:'task'}})
  const c=(await f.call('command.claim',{commandId:'c'})).result.command
  await f.call('command.complete',{commandId:'c',leaseEpoch:c.leaseEpoch,result:{taskId:'task'}})
  const run=(await f.store.query({kind:'message.run',runId:'m'})).run
  await f.call('notification.prepare',{runId:'m',commandId:'old-command',notificationId:'old-id-other-command',eventKey,payload:{phase:`owner:${report.reportId}`,text:'旧报告',conversationId:'g',sourceMessageId:'old-source'},disclosure:{conversationId:'g',authorizationRef:'old-source'}})
  const old=(await f.call('notification.claim',{notificationId:'old-id-other-command'})).result.notification
  await f.call('notification.sent',{notificationId:old.id,leaseEpoch:old.leaseEpoch,ack:{messageId:'old-out'}})
  await f.call('notification.readback',{notificationId:old.id,leaseEpoch:old.leaseEpoch,evidence:{messageId:'old-out'}})
  await f.call('attention',{runId:'m',reason:'MANUAL_RECOVERY_REQUIRED'})
  const store=f.store
  let sends=0
  await createWorkflowNotifications({store,adapter:{canDisclose:async()=>true,send:async()=>{sends++;return {messageId:'new-out'}},readback:async()=>({messageId:'new-out'})}}).flush()
  assert.equal(sends,1)
  assert.equal((await f.notices()).filter(n=>n.eventKey===eventKey).length,1)
  assert.equal((await f.store.query({kind:'message.notification',eventKey})).id,'old-id-other-command')
  assert.equal((await f.store.query({kind:'message.run',runId:run.runId})).notificationDiagnostics.length,0)
})

test('单条事实失败不阻断unknown回读，诊断可回读且相同错误不反复写账',async t=>{
  const f=await fixture(t)
  await f.call('attention',{runId:'m',reason:'MANUAL_RECOVERY_REQUIRED'})
  await f.flush({canDisclose:async()=>true,send:async()=>{throw Error('ACK_LOST')},readback:async()=>null})
  let broken=true,diagnosticWrites=0,reads=0
  const store={query:q=>{if(broken&&q.kind==='message.acceptances')throw Error('BROKEN_FACT');return f.store.query(q)},command:q=>{if(q.kind==='message.notification.diagnostic')diagnosticWrites++;return f.store.command(q)}}
  const adapter={canDisclose:async()=>true,send:async()=>{throw Error('MUST_NOT_RESEND')},readback:async()=>{reads++;return null}}
  const notifier=createWorkflowNotifications({store,adapter})
  await assert.rejects(notifier.flush(),/BROKEN_FACT/)
  await assert.rejects(notifier.flush(),/BROKEN_FACT/)
  assert.equal(reads,2);assert.equal(diagnosticWrites,1)
  let state=await f.store.query({kind:'message.run',runId:'m'})
  assert.equal(state.notificationDiagnostics[0].status,'unresolved');assert.equal(state.notificationDiagnostics[0].error,'BROKEN_FACT')
  broken=false;await notifier.flush()
  state=await f.store.query({kind:'message.run',runId:'m'})
  assert.equal(state.notificationDiagnostics[0].status,'resolved');assert.equal(diagnosticWrites,2)
})


test('逻辑来源等待跨原因和重放去重，不同来源独立告知', async t => {
  const f = await fixture(t)
  let sends = 0
  const adapter = { canDisclose: async () => true, send: async () => ({ messageId: `out-${++sends}` }), readback: async n => ({ messageId: n.ack.messageId }) }
  await f.call('attention', { runId: 'm', reason: 'MESSAGE_NODE_TIMEOUT' })
  await f.flush(adapter)
  await f.call('attention', { runId: 'm', reason: 'MANUAL_RECOVERY_REQUIRED' })
  await f.flush(adapter)
  assert.equal(sends, 1)
  await f.call('reprocess', { runId: 'm', newRunId: 'm2', reason: '修复后恢复' })
  await f.call('attention', { runId: 'm2', reason: 'OTHER_INTERNAL_FAILURE' })
  await f.flush(adapter)
  assert.equal(sends, 1)
  await f.call('receive', { runId: 'other', sourceKey: 'other-source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '另一件事', context: { sourceMessageId: 'other-in' } })
  await f.call('attention', { runId: 'other', reason: 'OTHER_INTERNAL_FAILURE' })
  await f.flush(adapter)
  assert.equal(sends, 2)
  const notices = await f.store.query({ kind: 'message.notifications', sourceKey: 'source', states: ['delivered'] })
  assert.equal(notices.length, 1)
  assert.equal(notices[0].runId, 'm')
})

test('未知发送同等待仅回查，未发送旧版本不遮蔽新版本', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'FIRST' })
  await f.flush()
  await f.call('reprocess', { runId: 'm', newRunId: 'm2', reason: '修复' })
  await f.call('attention', { runId: 'm2', reason: 'SECOND' })
  let sends = 0
  const adapter = { canDisclose: async () => true, send: async () => { sends++; throw Error('ACK_LOST') }, readback: async () => null }
  await f.flush(adapter)
  await f.call('attention', { runId: 'm2', reason: 'THIRD' })
  await f.flush(adapter)
  assert.equal(sends, 1)
  assert.deepEqual((await f.notices()).map(n => n.status), ['superseded', 'unknown'])
})


test('同来源正文修改是新请求，公开等待事实变化后可再次告知', async t => {
  const f = await fixture(t)
  let sends = 0
  const adapter = { canDisclose: async () => true, send: async () => ({ messageId: `out-${++sends}` }), readback: async n => ({ messageId: n.ack.messageId }) }
  await f.call('attention', { runId: 'm', reason: 'FIRST' })
  await f.flush(adapter)
  await f.call('receive', { runId: 'edited', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '修改后的新要求', context: { sourceMessageId: 'in' } })
  await f.call('attention', { runId: 'edited', reason: 'FIRST' })
  await f.flush(adapter)
  assert.equal(sends, 2)
  await f.call('attention', { runId: 'edited', reason: 'MESSAGE_CONTEXT_CAPACITY:S' })
  await f.flush(adapter)
  assert.equal(sends, 2)
  await f.call('attention', { runId: 'edited', reason: 'FIRST' })
  await f.flush(adapter)
  assert.equal(sends, 2)
  await f.flush(adapter)
  assert.equal(sends, 2)
})


test('等待通知仅显示进度，不复述原文或话题标题', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('topic.bind', { runId: 'm', unitId: 'u', expectedRevision: 0,
    binding: { kind: 'binding', disposition: 'new', candidateId: null },
    topic: { topicId: 'topic', conversationId: 'g', sourceRunId: 'm', unitId: 'u', title: '不相关的旧主题', facts: [] } })
  await f.call('attention', { runId: 'm', reason: 'FIRST' })
  await f.flush()
  assert.equal((await f.notices())[0].payload.text, '处理遇到系统问题，无法继续推进，需要人工介入。')
})


test('已送达旧等待文案，简化为进度后不重发', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('attention', { runId: 'm', reason: 'OLD_TECHNICAL_REASON' })
  const { run } = await f.store.query({ kind: 'message.run', runId: 'm' })
  const text = '已收到，目前处理遇到系统问题，尚未完成，需要先排查恢复。你暂时不需要重复提交或补充内部资料。'
  await f.call('notification.prepare', { runId: 'm', notificationId: 'old-unlabelled', eventKey: 'old-wait',
    stateFact: { revision: run.revision, status: run.status, reason: run.reason, intentStatus: run.intentStatus ?? null, phase: 'attention' },
    payload: { text, phase: 'attention', conversationId: 'g', sourceMessageId: 'in', actorId: 'a' },
    disclosure: { conversationId: 'g', authorizationRef: 'source' } })
  const n = (await f.call('notification.claim', { notificationId: 'old-unlabelled' })).result.notification
  await f.call('notification.sent', { notificationId: n.id, leaseEpoch: n.leaseEpoch, ack: { messageId: 'old-out' } })
  await f.call('notification.readback', { notificationId: n.id, leaseEpoch: n.leaseEpoch, evidence: { messageId: 'old-out' } })
  await f.call('attention', { runId: 'm', reason: 'NEW_TECHNICAL_REASON' })
  let sends = 0
  await f.flush({ canDisclose: async () => true, send: async () => { sends++; return {} }, readback: async () => null })
  assert.equal(sends, 0)
  assert.equal((await f.notices()).length, 1)
  assert.equal((await f.notices())[0].payload.text, text)
})

for (const revised of [false, true]) test(`Owner决定应用失败系统告知：${revised ? '新需求使未发报告失效' : '可发送且unknown在更新后仍回读'}`, async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  const send = (kind, args) => f.store.command({ id: randomUUID(), kind, args })
  await send('task.accept', { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`, requirementRevision: 1,
    sessionId: 'owner', criteria: ['交付结果'], sourceKey: 'source', eventKey: 'created' })
  await f.call('command.complete', { commandId: 'c', leaseEpoch: claim.leaseEpoch, result: { taskId: 'task' } })
  await send('task.owner.claim', { taskId: 'task', turnId: 'turn', expectedLeaseEpoch: 0 })
  await send('task.owner.sessionBound', { taskId: 'task', turnId: 'turn', leaseEpoch: 1, sessionId: 'owner' })
  await send('task.owner.candidate', { taskId: 'task', turnId: 'turn', leaseEpoch: 1,
    decision: { action: 'repairCurrentStage', repair: { stageId: 'stage-1', runId: 'r', generation: 1, runRevision: 0, requirementRevision: 1 }, summary: '缺少读取生产状态的能力，尚未开始。', evidenceRefs: [] } })
  await send('task.owner.accept', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await send('task.owner.action.fail', { taskId: 'task', turnId: 'turn', leaseEpoch: 1, reason: 'WORKFLOW_REPAIR_NOT_ADMITTED' })
  await f.flush()
  const notice = (await f.notices()).find(item => item.payload.phase.startsWith('owner:'))
  assert.ok(notice)
  assert.match(notice.payload.phase, /^owner:application_wait:/)
  assert.match(notice.payload.text, /需要人工介入/)
  assert.doesNotMatch(notice.payload.text, /缺少读取生产状态|WORKFLOW_REPAIR/)
  await f.flush()
  assert.equal((await f.notices()).filter(n => n.payload.phase.startsWith('owner:application_wait:')).length, 1)
  if (revised) {
    await send('task.requirement.update', { taskId: 'task', expectedRequirementRevision: 1,
      requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'before-claim' })
    const stale = await f.call('notification.claim', { notificationId: notice.id })
    assert.equal(stale.dispatchEligible, false)
    assert.equal(stale.result.notification.status, 'superseded')
    return
  }
  await f.call('notification.prepare',{runId:'m',commandId:'c',notificationId:'concurrent-owner-wait',eventKey:'concurrent-owner-wait',payload:notice.payload,disclosure:notice.disclosure})
  const preparedClaim = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(preparedClaim.dispatchEligible, true)
  const concurrent=await f.call('notification.claim',{notificationId:'concurrent-owner-wait'})
  assert.equal(concurrent.dispatchEligible,false)
  assert.equal(concurrent.result.notification.status,'superseded')
  await f.call('notification.fail', { notificationId: notice.id, leaseEpoch: preparedClaim.result.notification.leaseEpoch, error: 'ack lost' })
  await send('task.requirement.update', { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'new-requirement' })
  await f.flush({ canDisclose: async () => true, send: async () => { throw new Error('no new send expected') }, readback: async () => ({ messageId: 'out' }) })
  assert.equal((await f.notices()).find(item => item.id === notice.id).status, 'delivered')
  for (const epoch of [2,3]) {
    if (epoch === 3) await send('task.owner.event',{taskId:'task',eventKey:'actual-success',eventType:'workflow.succeeded'})
    await send('task.owner.claim',{taskId:'task',turnId:`turn-${epoch}`,expectedLeaseEpoch:epoch-1})
    await send('task.owner.candidate',{taskId:'task',turnId:`turn-${epoch}`,leaseEpoch:epoch,decision:{action:'repairCurrentStage',repair:{stageId:'stage-1',runId:'r',generation:epoch,runRevision:0,requirementRevision:2},summary:'同一受阻条件',evidenceRefs:[]}})
    await send('task.owner.accept',{taskId:'task',turnId:`turn-${epoch}`,leaseEpoch:epoch})
    await send('task.owner.action.fail',{taskId:'task',turnId:`turn-${epoch}`,leaseEpoch:epoch,reason:'OTHER_TECHNICAL_ERROR'})
    await f.flush()
    assert.equal((await f.notices()).filter(n=>n.payload.phase.startsWith('owner:application_wait:')&&n.status!=='superseded').length,epoch===2?1:2)
  }
})

test('标题更正遇到真实归类等待只给简洁进度，不复述原文或催重复材料',async t=>{
 const f=await fixture(t,'表格的标题写错了，应该是新的LCA专家')
 await f.call('split',{runId:'m',units:[{unitId:'u',goalText:'表格的标题写错了，应该是新的LCA专家'}]})
 await f.call('topic.bind',{runId:'m',unitId:'u',expectedRevision:0,binding:{kind:'binding',disposition:'new',candidateId:null},topic:{topicId:'topic',conversationId:'g',sourceRunId:'m',unitId:'u',title:'标题更正',facts:[]}})
 const oldNow=Date.now;Date.now=()=>oldNow()+61000
 try{await f.flush()}finally{Date.now=oldNow}
 const notice=(await f.notices()).find(n=>n.payload.phase==='routing_wait')
 assert.ok(notice)
 assert.equal(notice.payload.text,'目前正在核对可能相关的补充要求，相关处理尚未开始；核对清楚后继续。')
 assert.doesNotMatch(notice.payload.text,/关于|已收到|重复提交|标题写错/)
})


test('Owner首次领取前有未定新输入，不取得lease或消耗失败预算', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task' } }] })
  const c = (await f.call('command.claim', { commandId: 'c' })).result.command
  await f.store.command({ id: randomUUID(), kind: 'task.accept', args: { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`, requirementRevision: 1, sessionId: 'owner', criteria: ['交付'], sourceKey: 'source', eventKey: 'created' } })
  await f.call('command.complete', { commandId: 'c', leaseEpoch: c.leaseEpoch, result: { taskId: 'task' } })
  await f.call('receive', { runId: 'new-message', sourceKey: 'new-source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body: '先别执行，我补充条件' })
  for (let n = 0; n < 4; n++) await assert.rejects(f.store.command({ id: randomUUID(), kind: 'task.owner.claim', args: { taskId: 'task', turnId: `waiting-${n}`, expectedLeaseEpoch: 0 } }), /MESSAGE_INPUT_PENDING/)
  const owner = await f.store.query({ kind: 'task.owner', taskId: 'task' })
  assert.equal(owner.leaseEpoch, 0)
  assert.equal(owner.failureCount, 0)
  assert.equal(owner.status, 'pending')
})

for(const reason of ['MESSAGE_DEADLINE_BEFORE_CLAIM:S','MESSAGE_CONTEXT_CAPACITY:S:$:100/80','recovery_exhausted'])test(`自动恢复尚可推进时不发送系统错误：${reason}`,async t=>{
 const f=await fixture(t);await f.call('attention',{runId:'m',reason});await f.flush();assert.equal((await f.notices()).length,0)
})


test('材料耗尽但仍有内部自动读取时不发人工介入',async t=>{
 const f=await fixture(t)
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'R',reason:'读取',request:{requestId:'blocked',kind:'needs_context',needs:[]}})
 await f.call('request.retry',{runId:'m',requestId:'blocked',maxAttempts:1,error:'READ_FAILED',contractVersion:'test-v1'})
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'S',reason:'自动读取',request:{requestId:'automatic',kind:'needs_context',needs:[]}})
 await f.flush()
 assert.equal((await f.notices()).length,0)
})


test('短引用通知只允许明确发送人前缀及完整正文匹配',()=>{
 for(const body of ['已收到。\n\n- 小小鹏代回','目前正在核对相关要求。\n\n- 小小鹏代回']){
  const observed=`@李辰  ${body}`
  assert.equal(sameDeliveredText(observed,body,{sender:'李辰'}),true)
  assert.equal(sameDeliveredText(observed,body,{sender:'王明'}),false)
  assert.equal(sameDeliveredText(observed,body,null),false)
  assert.equal(sameDeliveredText(observed+'额外内容',body,{sender:'李辰'}),false)
  assert.equal(sameDeliveredText('其他文字 '+body,body,true),false)
 }
})

for(const recoverBeforeClaim of [false,true])test(`Owner真实实现阻塞首次released无report即告知，恢复边界：${recoverBeforeClaim}`,async t=>{
 const f=await fixture(t),send=(kind,args)=>f.store.command({id:randomUUID(),kind,args})
 await f.call('split',{runId:'m',units:[{unitId:'u',goalText:'核验'}]})
 await f.call('accept',{runId:'m',unitId:'u',commands:[{commandId:'c',kind:'create',args:{taskId:'task',replyPolicy:'none'}}]})
 const claim=(await f.call('command.claim',{commandId:'c'})).result.command
 await send('task.accept',{taskId:'task',requirementRef:`sha256-${'a'.repeat(64)}.json`,requirementRevision:1,sessionId:'owner',criteria:['核验'],sourceKey:'source',eventKey:'created'})
 await f.call('command.complete',{commandId:'c',leaseEpoch:claim.leaseEpoch,result:{taskId:'task'}})
 let epoch=0
 const release=async()=>{const previous=epoch++;await send('task.owner.claim',{taskId:'task',turnId:`released-${epoch}`,expectedLeaseEpoch:previous});await send('task.owner.release',{taskId:'task',turnId:`released-${epoch}`,leaseEpoch:epoch,reason:'ADVANCE_CONFLICT'})}
 await f.flush()
 assert.equal((await f.notices()).filter(n=>n.payload.phase.startsWith('owner:application_wait:')).length,0)
 await release();await f.flush();await f.flush()
 assert.deepEqual(await f.store.query({kind:'task.owner.reports',taskId:'task'}),[])
 const notices=(await f.notices()).filter(n=>n.payload.phase==='owner:application_wait:released')
 assert.equal(notices.length,1);assert.equal(notices[0].payload.text,'处理遇到系统问题，无法继续推进，需要人工介入。')
 if(recoverBeforeClaim){
  await send('task.owner.event',{taskId:'task',eventKey:'recovered',eventType:'workflow.succeeded'})
  const result=await f.call('notification.claim',{notificationId:notices[0].id})
  assert.equal(result.dispatchEligible,false);assert.equal(result.result.notification.status,'superseded');return
 }
 let sends=0
 const adapter={canDisclose:async()=>true,send:async()=>({messageId:`sent-${++sends}`}),readback:async n=>({messageId:n.ack.messageId})}
 await f.flush(adapter);await f.flush(adapter)
 assert.equal((await f.notices()).filter(n=>n.payload.phase==='owner:application_wait:released'&&n.status==='delivered').length,1)
 const sentBefore=sends
 await send('task.owner.event',{taskId:'task',eventKey:'actual-recovery',eventType:'workflow.succeeded'})
 await release()
 await f.flush(adapter);await f.flush(adapter)
 assert.equal(sends,sentBefore+1)
 assert.equal((await f.notices()).filter(n=>n.payload.phase==='owner:application_wait:released'&&n.status==='delivered').length,2)
})
