import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { createWorkflowNotifications, notificationSilence, sameDeliveredText, taskNotificationAllowed } from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'

test('内部修复方向即使继承确认事件也不投递到群', () => {
  assert.equal(taskNotificationAllowed({ phase: 'owner:repair:1', report: {
    applicationStatus: 'applied', reportType: 'repairCurrentStage', triggerTypes: ['workflow.confirmation.required'],
  } }), false)
})

async function fixture(t, body = '请处理') {
  const dir = await mkdtemp(join(tmpdir(), 'notice-obligation-'))
  const store = await openExecutionStore({ dbPath: join(dir, 'control.sqlite'), instanceId: randomUUID(), initialize: true })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const call = (kind, args) => store.command({ id: randomUUID(), kind: `message.${kind}`, args })
  await call('receive', { runId: 'm', sourceKey: 'source', sourceVersion: 1, conversationId: 'g', actorId: 'a', body,
    context: { sourceMessageId: 'in', replyObligation: { required: true, sourceKey: 'source', sourceVersion: 1 } } })
  return { store, call, edit: fn => { const db=new DatabaseSync(join(dir,'control.sqlite'));try{fn(db)}finally{db.close()} }, notices: () => store.query({ kind: 'message.notifications', states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded'] }),
    flush: adapter => createWorkflowNotifications({ store, controller: {
      taskPlan: taskId => store.query({ kind: 'task.plan', taskId }), state: runId => store.query({ kind: 'run', runId }) }, artifacts: {}, adapter }).flush() }
}

for (const scenario of [
  { name: '普通数据变更待审', workflowId: 'task-data-change', short: true },
  { name: '已有工单接续待审', workflowId: 'task-data-change-approval-resume', short: true },
  { name: '审批已批准', decision: 'approved' },
  { name: '审批已驳回', decision: 'rejected' },
  { name: 'Bytebase原生审批', approvalSource: 'bytebase' },
  { name: '其它任务阶段', workflowId: 'task-uat-deployment' },
  { name: '其它外部效果领域', workflowKind: 'production-release' },
  { name: '非真实工单资源名', issueId: '857' },
]) test(`审批等待不发群进度且原生审批不受影响：${scenario.name}`, async t => {
  const f = await fixture(t)
  const send = (kind, args) => f.store.command({ id: randomUUID(), kind, args })
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '添加name列' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  await send('task.accept', { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`,
    requirementRevision: 1, sessionId: 'owner', criteria: ['添加name列'], sourceKey: 'source', eventKey: 'created' })
  await f.call('command.complete', { commandId: 'c', leaseEpoch: claim.leaseEpoch, result: { taskId: 'task' } })
  const workflowId = scenario.workflowId ?? 'task-data-change'
  await send('task.plan.initialize', { taskId: 'task', expectedPlanRevision: 0, expectedRequirementRevision: 1,
    expectedControlRevision: 1, stages: [{ stageId: 'stage-1', workflowId, workflowDigest: 'a'.repeat(64),
      unavailableReason: null, requirementRef: 'sha256/in', gate: 'none' }] })
  await send('run.create', { runId: 'business', taskId: 'task', workflowId, workflowDigest: 'a'.repeat(64),
    requirementRef: 'sha256/in', stageBinding: { planRevision: 1, stageId: 'stage-1', attempt: 1, expectedControlRevision: 1 },
    nodes: [{ nodeId: 'approval-gate', nodeVersion: '1', executor: 'code', inputRef: 'sha256/in', inputDigest: 'a'.repeat(64) }] })
  const binding = (await send('node.claim', { runId: 'business', nodeId: 'approval-gate', expectedGeneration: 1, expectedLeaseEpoch: 0 })).result.binding
  await send('effect.prepare', { effectId: 'gate-effect', kind: 'operation', runId: 'business', nodeId: 'approval-gate',
    generation: binding.generation, leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest,
    definition: { adapterId: 'external-operation', adapterVersion: '1', principalId: 'owner', action: 'external',
      payload: { workflowKind: scenario.workflowKind ?? 'data-change', stage: 'approval-gate',
        intent: { approvalSource: scenario.approvalSource ?? 'assistant', issueId: scenario.issueId ?? 'projects/app/issues/857' } } },
    resourceKeys: ['external:database:app'], approval: { requestId: 'approval-857', approverIds: ['owner'] } })
  if (scenario.decision) await send('approval.decide', { requestId: 'approval-857', actorId: 'owner', source: 'web', decision: scenario.decision })
  await send('node.drained', { runId: 'business', nodeId: 'approval-gate', generation: binding.generation,
    leaseEpoch: binding.leaseEpoch, evidenceRef: 'native-drain-proof' })
  await send('node.commit', { runId: 'business', nodeId: 'approval-gate', generation: binding.generation,
    leaseEpoch: binding.leaseEpoch, inputDigest: binding.inputDigest, outcome: 'waiting', evidenceRefs: [],
    waitReason: { kind: 'approval', reference: 'approval-857' } })
  const summary = 'Owner生成的长进展，已核对精确表基线及SQL并保留已有工单，仍说明多项内部判断。'.repeat(8)
  await send('task.owner.claim', { taskId: 'task', turnId: 'turn', expectedLeaseEpoch: 0 })
  await send('task.owner.sessionBound', { taskId: 'task', turnId: 'turn', leaseEpoch: 1, sessionId: 'owner' })
  await send('task.owner.candidate', { taskId: 'task', turnId: 'turn', leaseEpoch: 1, decision: { action: 'wait', summary,
    evidenceRefs: [], condition: { kind: 'approval', missing: '本次DDL批准', responsibleParty: '审批人',
      resumeWhen: '批准后执行，驳回后修改重审', evidenceRefs: [] } } })
  await send('task.owner.accept', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await send('task.owner.applied', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await f.flush(); await f.flush()
  const notices = (await f.notices()).filter(item => item.payload.phase.startsWith('owner:'))
  assert.equal(notices.length, 0)
  assert.equal((await f.store.query({ kind: 'task.owner.reports', taskId: 'task' }))[0].facts.summary, summary)
  assert.equal((await f.store.query({ kind: 'approval.get', requestId: 'approval-857' })).decision, scenario.decision ?? 'pending')
})

test('系统容量失败仅留内部状态，重启扫描不发进度', async t => {
  const f = await fixture(t)
  await f.call('attention', { runId: 'm', reason: 'MESSAGE_MODEL_CONTEXT_WINDOW_EXCEEDED:S:$' })
  await f.flush(); await f.flush()
  const notices = await f.notices()
  assert.equal(notices.length, 0)
  assert.equal((await f.store.query({ kind: 'message.run', runId: 'm' })).run.status, 'needs_attention')
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

test('Task接纳完成只通知一次开始，需求修订不再通知', async t => {
  const f = await fixture(t)
  await f.call('split', { runId: 'm', units: [{ unitId: 'u', goalText: '审核状态查询' }] })
  await f.call('accept', { runId: 'm', unitId: 'u', commands: [{ commandId: 'c', kind: 'create', args: { taskId: 'task', replyPolicy: 'none' } }] })
  const claim = (await f.call('command.claim', { commandId: 'c' })).result.command
  await f.store.command({ id: 'task-accept', kind: 'task.accept', args: { taskId: 'task', requirementRef: `sha256-${'a'.repeat(64)}.json`,
    requirementRevision: 1, sessionId: 'owner', criteria: ['交付结果'], sourceKey: 'source', eventKey: 'created' } })
  await f.flush()
  assert.equal((await f.notices()).length, 0)
  await f.call('command.complete', { commandId: 'c', leaseEpoch: claim.leaseEpoch, result: { taskId: 'task', reply: '已收到' } })
  await f.flush(); assert.equal((await f.notices()).length, 1)
  assert.equal((await f.notices())[0].eventKey,'task.started:task')
  assert.equal((await f.notices())[0].payload.text,'任务已开始处理。')
  await f.store.command({ id: 'task-update', kind: 'task.requirement.update', args: { taskId: 'task', expectedRequirementRevision: 1,
    requirementRef: `sha256-${'b'.repeat(64)}.json`, eventKey: 'updated' } })
  await f.flush(); assert.equal((await f.notices()).length, 1)
})

test('发送未知后来源更新仍回读旧通知，不删除效果或再次发送', async t => {
  const f = await fixture(t)
  await f.call('wait', { runId: 'm', unitId: '$', nodeId: 'R', reason: '需要业务信息', request: { requestId: 'question', kind: 'needs_clarification', question: '请选择目标环境', permittedActors: ['a'] } })
  let sends = 0, reads = 0
  const adapter = { canDisclose: async () => true, send: async () => { sends++; throw new Error('unknown') },
    readback: async () => ++reads > 1 ? { messageId: 'out' } : null }
  await f.flush(adapter)
  await f.call('receive', { runId: 'm2', sourceKey: 'source', sourceVersion: 2, conversationId: 'g', actorId: 'a', body: '更新目标' })
  await f.flush(adapter)
  assert.equal(sends, 1); assert.equal(reads, 2)
  assert.equal((await f.notices())[0].status, 'delivered')
})

for (const kind of ['business-input', 'permission', 'execution', 'capability', 'approval'])
for (const revised of [false, true]) test(`Owner ${kind} 通知及原生领取：${revised ? '需求更新' : '当前需求'}`, async t => {
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
    decision: { action: 'block', summary: '请确认目标环境。', evidenceRefs: [],
      condition: { kind, missing: '目标环境', responsibleParty: '交办人', resumeWhen: '提供目标后继续', evidenceRefs: [] } } })
  await send('task.owner.accept', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await send('task.owner.applied', { taskId: 'task', turnId: 'turn', leaseEpoch: 1 })
  await f.flush()
  const notice = (await f.notices()).find(item => item.payload.phase.startsWith('owner:'))
  if (['execution', 'capability', 'approval'].includes(kind)) {
    assert.equal(notice, undefined)
    const [report] = await f.store.query({ kind: 'task.owner.reports', taskId: 'task' })
    assert.equal(report.facts.condition.kind, kind)
    // 模拟部署前已有的待发报告，必须由原生领取判定失效。
    await f.call('notification.prepare', { runId: 'm', commandId: 'c', notificationId: 'legacy-progress',
      eventKey: `task.owner.report:${report.reportId}`, payload: { phase: `owner:${report.reportId}`, text: '处理暂时受阻', fact: { taskId: 'task' } },
      disclosure: { conversationId: 'g', authorizationRef: 'source' } })
    const claimed = await f.call('notification.claim', { notificationId: 'legacy-progress' })
    assert.equal(claimed.dispatchEligible, false)
    assert.equal(claimed.result.notification.status, 'superseded')
    return
  }
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

test('Owner无结构化用户操作的阻塞只留内部事实', async () => {
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
  assert.equal(reports, 2); assert.equal(notices.size, 1); assert.equal([...notices.values()][0].payload.phase,'task:started')
})

test('同一事项多条补充和实际开始均静默', async () => {
  const run={runId:'supplement',sourceKey:'source',sourceVersion:1,revision:0,conversationId:'g',actorId:'a',context:{sourceMessageId:'in'}}
  const commands=['first','second'].map(commandId=>({commandId,status:'applied',kind:'revise',args:{replyPolicy:'receipt'},result:{taskId:'task',reply:'任务要求已更新，正在核对后续处理。'}}))
  const notices=new Map()
  const store={async query(q){
    if(['message.notification.diagnostics','message.acceptances','task.owner.reports'].includes(q.kind))return []
    if(q.kind==='message.notifications')return [...notices.values()]
    if(q.kind==='message.list')return [run]
    if(q.kind==='message.run')return {run,requests:[],commands}
    if(q.kind==='message.notification')return q.eventKey?[...notices.values()].find(n=>n.eventKey===q.eventKey):notices.get(q.notificationId)
    if(['message.task.latest','task.deleted','message.owner.released-wait'].includes(q.kind))return null
    if(q.kind==='task.owner.events')return []
    throw Error(q.kind)
  },async command({args}){notices.set(args.notificationId,{...args,id:args.notificationId});return {}}}
  const controller={taskPlan:async()=>({task:{controlState:'active'},stages:[{status:'running',runId:'run'}]}),state:async()=>({run:{status:'running'},nodes:[{status:'running',startedAt:'2026-10-01T00:00:00Z'}]})}
  for(let n=0;n<2;n++)await createWorkflowNotifications({store,controller}).flush()
  assert.equal(notices.size,0)
})

test('计划、开始和暂停阶段均不主动汇报进度', async () => {
 for(const mode of ['planned','created','started','paused']) {
  const run={runId:'start-message',sourceKey:'source',sourceVersion:1,revision:0,conversationId:'g',actorId:'a',context:{sourceMessageId:'in'}}
  const action={commandId:'start-command',status:'applied',kind:'create',args:{replyPolicy:'none'},result:{taskId:'task'}}
  const notices=new Map()
  const store={async query(q){
   if(q.kind==='message.notification.diagnostics'||q.kind==='message.acceptances'||q.kind==='task.owner.reports')return[]
   if(q.kind==='message.notifications')return [...notices.values()]
   if(q.kind==='message.list')return[run]
   if(q.kind==='message.run')return{run,requests:[],commands:[action]}
   if(q.kind==='message.notification')return q.eventKey?[...notices.values()].find(n=>n.eventKey===q.eventKey):notices.get(q.notificationId)
   if(['message.task.latest','task.deleted','message.owner.released-wait'].includes(q.kind))return null
   if(q.kind==='task.owner.events')return []
    throw Error(q.kind)
  },async command({args}){notices.set(args.notificationId,{...args,id:args.notificationId});return{}}}
  const controller={taskPlan:async()=>({task:{controlState:mode==='paused'?'paused':'active'},stages:[{status:mode==='planned'?'planned':'running',runId:'run'}]}),state:async()=>({run:{status:'running'},nodes:[{status:'running',startedAt:mode==='created'?null:'2026-10-01T00:00:00Z'}]})}
  for(let n=0;n<2;n++)await createWorkflowNotifications({store,controller}).flush()
  const starts=[...notices.values()].filter(n=>n.payload.phase.startsWith('owner:started:'))
  assert.equal(starts.length,0)
  if(starts.length)assert.equal(starts[0].payload.text,'任务已开始处理。')
 }
})

for (const started of [false, true]) test(`升级前已准备的开始通知在原生领取时静默失效：${started}`, async t => {
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
  assert.deepEqual((await f.store.query({kind:'message.notifications',taskId:'task',states:['prepared']})).map(n=>n.id),['start'])
  assert.deepEqual(await f.store.query({kind:'message.notifications',taskId:'other-task',states:['prepared']}),[])
  const claim = await f.call('notification.claim', { notificationId: 'start' })
  assert.equal(claim.dispatchEligible, false)
  assert.equal(claim.result.notification.status, 'superseded')
})

test('旧Owner报告跨command已送达，稳定eventKey复用且其他prepared正常投递', async t => {
  const f=await fixture(t)
  const send=(kind,args)=>f.store.command({id:randomUUID(),kind,args})
  await send('task.accept',{taskId:'task',requirementRef:`sha256-${'a'.repeat(64)}.json`,requirementRevision:1,sessionId:'owner',criteria:['交付结果'],sourceKey:'source',eventKey:'created'})
  await send('task.owner.claim',{taskId:'task',turnId:'turn',expectedLeaseEpoch:0})
  await send('task.owner.sessionBound',{taskId:'task',turnId:'turn',leaseEpoch:1,sessionId:'owner'})
  await send('task.owner.candidate',{taskId:'task',turnId:'turn',leaseEpoch:1,decision:{action:'block',summary:'等待审批',evidenceRefs:[],condition:{kind:'business-input',missing:'目标环境',responsibleParty:'需求方',resumeWhen:'提供环境后继续',evidenceRefs:[]}}})
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
  await f.call('wait',{runId:'m',unitId:'$',nodeId:'R',reason:'需要业务信息',request:{requestId:'question',kind:'needs_clarification',question:'请选择目标环境',permittedActors:['a']}})
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
  await f.call('wait',{runId:'m',unitId:'$',nodeId:'R',reason:'需要业务信息',request:{requestId:'question',kind:'needs_clarification',question:'请选择目标环境',permittedActors:['a']}})
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

test('升级前发送未知的进度仅回读，未发送的系统等待原生失效', async t => {
 const f=await fixture(t)
 await f.call('attention',{runId:'m',reason:'MANUAL_RECOVERY_REQUIRED'})
 const {run}=await f.store.query({kind:'message.run',runId:'m'})
 await f.call('notification.prepare',{runId:'m',notificationId:'old-wait',eventKey:'old-wait',
  stateFact:{revision:run.revision,status:run.status,reason:run.reason,intentStatus:run.intentStatus??null,phase:'attention'},
  payload:{phase:'attention',text:'处理暂时受阻',conversationId:'g'},disclosure:{conversationId:'g',authorizationRef:'source'}})
 const claimed=await f.call('notification.claim',{notificationId:'old-wait'})
 assert.equal(claimed.dispatchEligible,false)
 assert.equal(claimed.result.notification.status,'superseded')
 const unknown={id:'old-progress',runId:'m',status:'unknown',leaseEpoch:1,payload:{phase:'owner:started:old',text:'任务已开始处理。'}}
 let sends=0,reads=0,confirmed=0
 const store={query:async q=>q.kind==='message.notifications'&&q.states.includes('unknown')?[unknown]:[],
  command:async({kind,args})=>{assert.equal(kind,'message.notification.readback');assert.equal(args.notificationId,unknown.id);confirmed++;return{}}}
 await createWorkflowNotifications({store,adapter:{canDisclose:async()=>true,send:async()=>{sends++},
  readback:async()=>{reads++;return{messageId:'original-send'}}}}).flush()
 assert.deepEqual({sends,reads,confirmed},{sends:0,reads:1,confirmed:1})
})

for(const scenario of ['internal-progress','ordinary-progress','internal-started','internal-block','complete','user-action','permission','new-intent'])test(`所有任务采用相同通知策略：${scenario}`,async()=>{
 const run={runId:'silent-message',sourceKey:'source',sourceVersion:1,revision:0,conversationId:'g',actorId:'a',context:{sourceMessageId:'in'}}
 const action={commandId:'silent-command',status:'applied',kind:'revise',args:{replyPolicy:'none'},result:{taskId:'task'}}
 const events=Array.from({length:200},(_,i)=>({eventSeq:i+1,eventKey:i===199?'readonly-reassess:verified':'historical:'+i,eventType:i===199?'system.recovery':'workflow.succeeded',turnId:'historical'}))
 if(scenario==='ordinary-progress')events[199].eventKey='ordinary-recovery'
 if(scenario==='new-intent')events.push({eventSeq:201,eventKey:'new-source',eventType:'intent.received',turnId:'new'})
 events.push({eventSeq:202,eventKey:'stage-finished',eventType:'workflow.succeeded',turnId:'reported-turn'})
 const reportType=scenario==='complete'?'complete':scenario==='internal-block'?'block':['user-action','permission'].includes(scenario)?'wait':'advance'
 const missing='1. 请指定测试环境（UAT1 至 UAT9）。\n2. 请逐项确认以下字段的业务规格：'+Array.from({length:15},(_,i)=>`字段${i+1}的类型和是否必填`).join('；')+'。\n3. 请提供验收样例，参考 https://example.com/acceptance 最后一项。'
 const summary='请确认资料访问权限。\n'+ '已核对业务资料。'.repeat(30)+'\n请授权读取 https://example.com/material 最后一项。'
 const condition={kind:scenario==='internal-block'?'capability':scenario==='permission'?'permission':'business-input',missing,responsibleParty:'需求方',resumeWhen:'确认后继续',evidenceRefs:['proof']}
 const report={reportId:'reported',turnId:'reported-turn',reportType,applicationStatus:'applied',triggerTypes:['workflow.succeeded'],facts:{summary,evidenceRefs:['proof'],...(['block','wait'].includes(reportType)?{condition}:{})}}
 const notices=new Map(),pages=[]
 const store={async query(q){
  if(['message.notification.diagnostics','message.acceptances'].includes(q.kind))return []
  if(q.kind==='message.list')return [run]
  if(q.kind==='message.run')return{run,requests:[],commands:[action]}
  if(q.kind==='task.owner.events'){pages.push(q.afterSequenceId);return events.filter(e=>e.eventSeq>q.afterSequenceId).slice(0,q.limit)}
  if(q.kind==='task.owner.reports')return scenario==='internal-started'?[]:[report]
  if(q.kind==='message.notification')return notices.get(q.notificationId)
  if(q.kind==='message.notifications')return [...notices.values()]
  if(['message.task.latest','task.deleted','message.owner.released-wait'].includes(q.kind))return null
  throw Error(q.kind)
 },async command({kind,args}){assert.equal(kind,'message.notification.prepare');notices.set(args.notificationId,{...args,id:args.notificationId});return{}}}
 const controller={taskPlan:async()=>({task:{controlState:'active'},stages:scenario==='internal-started'?[{status:'running',runId:'investigation'}]:[]}),state:async()=>({run:{status:'running'},nodes:[{status:'running',startedAt:'2026-10-02T00:00:00Z'}]})}
 for(let n=0;n<2;n++)await createWorkflowNotifications({store,controller}).flush()
 const visible=[...notices.values()].filter(n=>n.payload.phase.startsWith('owner:'))
 assert.equal(visible.length,['complete','user-action','permission'].includes(scenario)?1:0)
 assert.equal(pages.length,0) // 通知策略不再依赖特殊恢复事件分页。
 if(scenario==='complete')assert.equal(visible[0].payload.text,`任务已完成：${summary}`)
 if(scenario==='user-action')assert.equal(visible[0].payload.text,`请补充以下信息：\n${missing}`)
 if(scenario==='permission')assert.equal(visible[0].payload.text,`需要你确认：\n${summary}`)
})

async function acceptStartTask(f,taskId='task',commandId='c',runId='m') {
 await f.call('split',{runId,units:[{unitId:'u-'+commandId,goalText:'核查结果'}]})
 await f.call('accept',{runId,unitId:'u-'+commandId,commands:[{commandId,kind:'create',args:{taskId,replyPolicy:'none'}}]})
 const claim=(await f.call('command.claim',{commandId})).result.command
 if(!(await f.store.query({kind:'task.catalog'})).some(t=>t.task_id===taskId||t.taskId===taskId)) await f.store.command({id:randomUUID(),kind:'task.accept',args:{taskId,requirementRef:`sha256-${'a'.repeat(64)}.json`,requirementRevision:1,sessionId:'owner-'+taskId,criteria:['核查结果'],sourceKey:'source',eventKey:'created-'+taskId}})
 await f.call('command.complete',{commandId,leaseEpoch:claim.leaseEpoch,result:{taskId}})
}

test('零Run任务开始投递一次；发送未知重启恢复只回查',async t=>{
 const f=await fixture(t);await acceptStartTask(f)
 let sends=0,reads=0
 const adapter={canDisclose:async()=>true,send:async()=>{sends++;throw Error('lost ACK')},readback:async()=>{reads++;return null}}
 await f.flush(adapter);await f.flush(adapter)
 assert.equal(sends,1);assert.equal(reads,2)
 assert.equal((await f.notices())[0].status,'unknown')
 assert.equal((await f.store.query({kind:'task.plan',taskId:'task'})).stages.length,0)
})
for(const mode of ['cancelled','completed','web','explicit-silence'])test(`领取任务开始通知复核并拒绝过期或禁发：${mode}`,async t=>{
 const f=await fixture(t,mode==='explicit-silence'?'请处理，不用回复我。':'请处理')
 await acceptStartTask(f)
 if(mode==='web') f.edit(db=>{const row=db.prepare("SELECT body FROM message_runs WHERE run_id='m'").get();const r=JSON.parse(row.body);r.channel='web';db.prepare("UPDATE message_runs SET body=? WHERE run_id='m'").run(JSON.stringify(r))})
 await f.flush()
 if(['web','explicit-silence'].includes(mode)){assert.equal((await f.notices()).length,0);return}
 const notice=(await f.notices())[0]
 f.edit(db=>{if(mode==='cancelled')db.prepare("UPDATE task_controls SET state='cancelled' WHERE task_id='task'").run();else db.prepare("UPDATE business_tasks SET status='succeeded' WHERE task_id='task'").run()})
 const claimed=await f.call('notification.claim',{notificationId:notice.id})
 assert.equal(claimed.dispatchEligible,false);assert.equal(claimed.result.notification.status,'superseded')
})

test('重复创建同一Task跨消息只开始一次，不同同名Task分别开始',async t=>{
 const f=await fixture(t);await acceptStartTask(f);await f.flush()
 for(const [runId,commandId,taskId] of [['m2','c2','task'],['m3','c3','task-other']]){
  await f.call('receive',{runId,sourceKey:runId,sourceVersion:1,conversationId:'g',actorId:'a',body:'请核查同名结果',context:{sourceMessageId:runId}})
  await acceptStartTask(f,taskId,commandId,runId);await f.flush()
 }
 const starts=(await f.notices()).filter(n=>n.payload.phase==='task:started')
 assert.deepEqual(starts.map(n=>n.eventKey).sort(),['task.started:task','task.started:task-other'])
})

test('原生开始准备拒绝未应用命令及借用另一Task身份',async t=>{
 const f=await fixture(t);await acceptStartTask(f)
 const args={runId:'m',commandId:'c',notificationId:'forged-start',eventKey:'task.started:other',payload:{phase:'task:started',text:'任务已开始处理。',conversationId:'g',fact:{taskId:'other'}},disclosure:{conversationId:'g',authorizationRef:'source'}}
 await assert.rejects(f.call('notification.prepare',args),{code:'MESSAGE_NOTIFICATION_FACT_REQUIRED'})
 f.edit(db=>{const row=db.prepare("SELECT body FROM message_items WHERE item_id='command:c'").get();const c=JSON.parse(row.body);c.status='pending';db.prepare("UPDATE message_items SET body=? WHERE item_id='command:c'").run(JSON.stringify(c))})
 await assert.rejects(f.call('notification.prepare',{...args,eventKey:'task.started:task',payload:{...args.payload,fact:{taskId:'task'}}}),{code:'MESSAGE_NOTIFICATION_FACT_REQUIRED'})
 assert.equal((await f.notices()).length,0)
})


test('授权请求使用独立通知且回执丢失和重启扫描不重复发送', async t => {
  const f = await fixture(t)
  await f.call('wait', { runId: 'm', unitId: '$', nodeId: 'coordinator', request: {
    requestId: 'authorize-question', kind: 'needs_authorization', question: '请 owner 授权按文档开发。', permittedActors: ['owner'],
  } })
  let sends = 0, reads = 0
  const adapter = { canDisclose: async () => true,
    send: async () => { sends++; throw new Error('ack lost') },
    readback: async () => ++reads > 1 ? { messageId: 'authorization-out' } : null }
  await f.flush(adapter); await f.flush(adapter); await f.flush(adapter)
  const notices = await f.notices()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].payload.phase, 'authorization')
  assert.equal(notices[0].eventKey, 'request.authorization:authorize-question:0')
  assert.equal(notices[0].status, 'delivered')
  assert.equal(sends, 1)
  const pending = await f.store.query({ kind: 'message.request', requestId: 'authorize-question' })
  assert.equal(pending.status, 'pending')
})

for (const kind of ['needs_clarification', 'needs_authorization']) test(`消息${kind}完整保留多行问题和引用上下文`, async t => {
 const f=await fixture(t)
 const question='请确认以下业务信息：\n1. '+ '请提供所需字段名称和示例值；'.repeat(20)+'\n2. 请选择测试范围，参考 https://example.com/scope 最后一项。'
 await f.call('wait',{runId:'m',unitId:'$',nodeId:'coordinator',request:{requestId:'specific-question',kind,question,permittedActors:['a']}})
 await f.flush()
 const notices=await f.notices()
 assert.equal(notices.length,1)
 assert.equal(notices[0].payload.text,question)
 assert.equal(notices[0].payload.sourceMessageId,'in')
 assert.equal(notices[0].payload.actorId,'a')
})

test('DWS连续编号清单仅接受已实证的项间换行消失',()=>{
 const expected='请补充：\n1. 审核申请 ID 或数据集 ID。\n2. 撤回的大致时间。\n3. 接收通知的账号。\n4. 使用的环境与链接 https://example.com/UAT2 。\n\n拿到后继续核对。'
 const rendered='请补充：  \n1. 审核申请 ID 或数据集 ID。2. 撤回的大致时间。3. 接收通知的账号。4. 使用的环境与链接 https://example.com/UAT2 。  \n拿到后继续核对。'
 assert.equal(sameDeliveredText('@需求方  '+rendered,expected,{sender:'需求方'}),true)
 for(const changed of [rendered.replace('撤回','提交'),rendered.replace('2.','5.'),rendered.replace('UAT2','UAT3'),rendered.replace(' ID 或','ID 或'),rendered.replace('2. 撤回的大致时间。3. 接收通知的账号。','3. 接收通知的账号。2. 撤回的大致时间。'),rendered+'额外内容'])assert.equal(sameDeliveredText(changed,expected),false)
 assert.equal(sameDeliveredText('第一行第二行','第一行\n第二行'),false)
 assert.equal(sameDeliveredText('1. A3. C','1. A\n3. C'),false)
 assert.equal(sameDeliveredText('```\n1. A2. B\n```','```\n1. A\n2. B\n```'),false)
 assert.equal(sameDeliveredText('1. A2. B','1. A\n\n2. B'),false)
 assert.equal(sameDeliveredText('1. **A**2. B','1. `A`\n2. B'),true)
})
