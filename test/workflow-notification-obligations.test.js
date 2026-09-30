import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createWorkflowNotifications, notificationSilence } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'

async function fixture(t, body = '请处理') {
  const dir = await mkdtemp(join(tmpdir(), 'notice-obligation-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: randomUUID(), initialize: true })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (kind, args) => store.command({ id: randomUUID(), kind: `message.${kind}`, args })
  await call('receive', { runId: 'm', sourceKey: 'source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body,
    context: { sourceMessageId: 'in', replyObligation: { required: true, sourceKey: 'source', sourceVersion: 1 } } })
  return { store, call, notices: () => store.query({ kind: 'message.notifications', states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded'] }),
    flush: adapter => createWorkflowNotifications({ store, controller: {}, artifacts: {}, adapter }).flush() }
}

test('需要排查的容量失败有真实状态通知，重启扫描不重复', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'MESSAGE_CONTEXT_CAPACITY:S:$:8372/8000' })
  await f.flush(); await f.flush()
  const notices = await f.notices()
  assert.equal(notices.length, 1)
  assert.match(notices[0].payload.text, /容量问题/)
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

test('内部读取短暂等待不催问，耗尽后告知；恢复后旧待发告知失效', async t => {
  const f = await fixture(t)
  await f.call('wait', { runId: 'm', unitId: '$', nodeId: 'R', reason: '读取文件', request: { requestId: 'q', kind: 'needs_context', needs: [] } })
  await f.flush(); assert.equal((await f.notices()).length, 0)
  await f.call('request.retry', { runId: 'm', requestId: 'q', maxAttempts: 1, error: 'READ_FAILED', contractVersion: 'test-v1' })
  await f.flush(); await f.flush()
  const [notice] = await f.notices()
  assert.equal(notice.payload.phase, 'system_wait')
  assert.match(notice.payload.text, /不需要提供内部资料/)
  await f.call('request.resolve', { runId: 'm', requestId: 'q', actorId: 'a', eventId: 'material-ready', answer: { ready: true } })
  const claim = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(claim.dispatchEligible, false)
  assert.equal(claim.result.notification.status, 'superseded')
})

test('来源更新使已准备的系统状态通知失效，零发送', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'recovery_exhausted' })
  await f.flush()
  const [notice] = await f.notices()
  await f.call('receive', { runId: 'm2', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '修正要求' })
  const result = await f.call('notification.claim', { notificationId: notice.id })
  assert.equal(result.dispatchEligible, false)
  assert.equal(result.result.notification.status, 'superseded')
})

test('Task已落账但command尚未完成仍有承接责任，完成后不重复；需求修订使旧回执失效', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  await f.store.command({ id: 'task-accept', kind: 'task.accept', args: { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`,
    requirementRevision: 1, sessionId: 'owner', criteria: ['交付结果'], sourceKey: 'source', eventKey: 'created' } })
  await f.flush()
  const [notice] = await f.notices()
  assert.equal(notice.payload.phase, 'accepted')
  assert.equal(notice.payload.fact.requirementRevision, 1)
  assert.match(notice.payload.text, /尚不能确认已开始/)
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
  await f.call('attention', { runId: 'm', reason: 'recovery_exhausted' })
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
  await f.call('split', { runId: 'm', units: [{ unitId: 'u' }] })
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
    if (q.kind === 'message.task.latest') return null
    if (q.kind === 'task.owner.reports') { reports++; return [{ reportId: 'report', reportType: 'block', applicationStatus: 'applied', triggerTypes: [], facts: { summary: '等待负责人审批。' } }] }
    throw new Error(q.kind)
  }, async command({ kind, args }) { assert.equal(kind, 'message.notification.prepare'); notices.set(args.notificationId, { ...args, id: args.notificationId }); return {} } }
  await createWorkflowNotifications({ store }).flush()
  await createWorkflowNotifications({ store }).flush()
  assert.equal(reports, 2); assert.equal(notices.size, 2)
  assert.ok([...notices.values()].some(n => n.payload.text.includes('尚未开始')))
  assert.ok([...notices.values()].some(n => n.payload.text.includes('审批')))
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
  await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
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
  await f.call('attention',{runId:'m',reason:'recovery_exhausted'})
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
