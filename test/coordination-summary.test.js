import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { coordinationSnapshot, coordinationNotificationState, formatCoordinationSnapshot, formatCoordinationAcceptance, formatCoordinationTime } from '../packages/dingtalk-dsh-assistant/coordination-summary.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

const member = (id, state) => ({ id, taskId: id, state, control: state === 'cancelled' ? 'cancelled' : 'active',
  command: { id: `command:${id}`, args: { request: `goal:${id}` } } })
const snapshot = members => coordinationSnapshot({ coordination: { id: 'coordination', revision: 2, state: 'active' },
  members, tasks: members.map(m => ({ taskId: m.taskId, status: m.state === 'fulfilled' ? 'completed' : 'active' })),
  schedules: [], occurrences: [], jobs: [] })

test('四个观察事项显示各自名称，失效版本不冒充需求变化或拼接当前诊断', () => {
  const titles = ['修复终审只读数据UPR导入覆盖并部署UAT2', '修复新建未保存草稿UPR导入受限',
    '修复草稿UPR导入物料名称回显并部署UAT2', '按v4实现合并数据集UPR替换与来源保留并提测UAT2']
  const result = coordinationSnapshot({ coordination: { id: 'coordination', revision: 1, state: 'active' },
    members: titles.map((_, index) => ({ ...member(String(index), index ? 'observing' : 'fulfilled'), observation: true,
      ...(index ? { waitingReason: { code: 'target_version_changed' } } : {}) })),
    tasks: titles.map((title, index) => ({ taskId: String(index), title, status: index ? 'active' : 'completed',
      lastDecision: { action: 'blocked', summary: '底座失败结算校验未结算' } })), schedules: [], occurrences: [], jobs: [] })
  const text = formatCoordinationSnapshot(result), lines = text.split('\n')
  assert.equal(lines.length, 4)
  titles.forEach((title, index) => assert.ok(lines[index].startsWith(`${title}：`)))
  assert.match(lines[0], /已完成/)
  assert.equal(lines.slice(1).every(line => line.endsWith('当前状态需重新核对。')), true)
  assert.doesNotMatch(text, /原事项|任务要求已变化|底座|结算/)
  assert.equal(result.members.every(item => item.blocker === null), true)
})

test('通知意义忽略版本、回执和诊断改写，但保留真实阻塞及澄清变化', () => {
  const first = snapshot([{ ...member('A', 'applied'), effectiveVersion: { contextRevision: 1 } }])
  first.members[0].blocker = '等待构建回包'
  const internal = structuredClone(first)
  internal.revision++; internal.members[0].effectiveVersion.contextRevision++
  internal.members[0].receiptRef = 'new-receipt'; internal.members[0].blocker = '内部再次核对构建回包'
  assert.deepEqual(coordinationNotificationState(first), coordinationNotificationState(internal))
  internal.members[0].blocker = null
  assert.notDeepEqual(coordinationNotificationState(first), coordinationNotificationState(internal))
  const question = structuredClone(first)
  question.pendingClarifications = [{ clarificationId: 'question', question: '需要哪个环境？' }]
  assert.notDeepEqual(coordinationNotificationState(first), coordinationNotificationState(question))
})

for (const [actionState, deliveryState, expected] of [
  ['expired', 'none', '已过期，本次未执行'], ['failed', 'none', '未能完成'], ['blocked', 'none', '暂时受阻'],
  ['succeeded', 'failed', '通知发送失败，送达情况需要核查'], ['succeeded', 'unknown', '是否送达尚未确认'], ['succeeded', 'delivered', '已送达'],
]) test(`群摘要只解释提醒业务结果与工作时区，不输出内部审计字段: ${actionState}/${deliveryState}`, () => {
  const result = coordinationSnapshot({ coordination: { id: 'coordination-secret', revision: 77, state: 'active' }, members: [], tasks: [],
    schedules: [{ id: 'schedule:secret', revision: 12, state: 'completed', timezone: 'UTC', rule: { kind: 'once', at: '2026-10-23T08:22:00Z' },
      action: { kind: 'message-reminder', text: '查看订单 BIZ-413 的进度。' }, target: { recipientIds: ['recipientOpenID-secret'] } }],
    occurrences: [{ id: 'time:secret', scheduleId: 'schedule:secret', plannedAt: '2026-10-23T08:22:00Z', actionState, deliveryState,
      target: { recipientIds: ['recipientOpenID-secret'] }, result: { text: '内部结果' }, notificationId: 'notification-secret' }], jobs: [] })
  const before = structuredClone(result), text = formatCoordinationSnapshot(result, { timeZone: 'Asia/Shanghai' })
  assert.match(text, new RegExp(expected)); assert.match(text, /2026年10月23日 16:22（北京时间）/)
  assert.match(text, /查看订单 BIZ-413 的进度。/)
  assert.equal((text.match(/16:22/g) ?? []).length, 1)
  assert.doesNotMatch(text, /secret|版本|0 项|0成员|UTC|T08:22|回执|完成证明|。。|已修复|不会补发/)
  if (deliveryState === 'unknown') assert.doesNotMatch(text, /已送达|已完成|未能发送/)
  assert.deepEqual(result, before, '只调整外发正文，不改快照和幂等事实')
})

for (const [state, blocked, proof, deliveryState, expected] of [
  ['applied', false, null, 'none', '已接纳处理要求，任务尚未正式完成'],
  ['applied', true, null, 'none', '已接纳处理要求，任务尚未正式完成'],
  ['applied', false, null, 'delivered', '已接纳处理要求，任务尚未正式完成'],
  ['fulfilled', false, null, 'none', '已接纳处理要求，任务尚未正式完成'],
  ['fulfilled', false, { commandId: 'complete:A' }, 'none', '对应任务已正式完成'],
]) test(`任务命令接纳不冒充业务完成: ${state}/${blocked}/${Boolean(proof)}/${deliveryState}`, () => {
  const result = coordinationSnapshot({ coordination: { id: 'coordination', revision: 1, state: 'active' },
    members: [{ ...member('A', state), completionProof: proof },
      { ...member('B', 'ready'), waitingReason: { code: 'waiting_dependency', dependencyInstructionIds: ['A'] } }],
    tasks: [{ taskId: 'A', status: state === 'fulfilled' ? 'completed' : 'active',
      ...(blocked ? { lastDecision: { action: 'blocked', summary: '终端权限阻断，产物尚未生成' } } : {}) }, { taskId: 'B', status: 'active' }],
    schedules: [], jobs: [], occurrences: [{ id: 'start:A', action: { kind: 'task-command', instructionIds: ['A'] },
      actionState: 'succeeded', deliveryState, result: { semantics: 'Task command acceptance receipts; not business completion.' } }] })
  const before = structuredClone(result), text = formatCoordinationSnapshot(result)
  assert.match(text, new RegExp(`本次安排${expected}。`))
  assert.match(text, /需要先完成前面的事项/)
  assert.doesNotMatch(text, /本次安排已执行|已执行，结果已送达|complete:A|start:A|task-command/)
  if (blocked) { assert.equal(result.state, 'needs_attention'); assert.match(text, /终端权限阻断，产物尚未生成/) }
  assert.deepEqual(result, before)
})

test('任务命令只核对本次目标，不把其他已完成成员作为本次完成证明', () => {
  const result = snapshot([{ ...member('A', 'fulfilled'), completionProof: { commandId: 'complete:A' } }, member('B', 'applied')])
  for (const instructionIds of [['B'], ['A', 'B'], ['missing'], []]) {
    result.occurrences = [{ actionKind: 'task-command', instructionIds, actionState: 'succeeded', deliveryState: 'none' }]
    assert.match(formatCoordinationSnapshot(result), /本次安排已接纳处理要求，任务尚未正式完成。/)
  }
})

for (const [deliveryState, expected] of [
  ['none', '本次安排已执行。'], ['delivered', '本次安排已执行，结果已送达。'],
  ['unknown', '本次安排已执行，结果通知是否送达尚未确认。'],
]) test(`只读查询仍区分实际执行与结果送达: ${deliveryState}`, () => {
  const result = coordinationSnapshot({ coordination: { id: 'coordination', revision: 1, state: 'active' }, members: [], tasks: [], schedules: [], jobs: [],
    occurrences: [{ id: 'query:A', action: { kind: 'read-query', taskIds: ['A'] }, actionState: 'succeeded', deliveryState }] })
  assert.equal(formatCoordinationSnapshot(result), expected)
  assert.equal(Object.hasOwn(result.occurrences[0], 'actionKind'), false, '其他动作不改变快照字段和摘要')
})

test('业务要求和业务ID保留，机器等待码译成说明而不泄露内部结构', () => {
  const result = snapshot([{ ...member('internal-task', 'applied'), id: 'instruction-secret',
    command: { id: 'command-secret', args: { request: '核查订单 BIZ-413 https://example.test/order/BIZ-413' } },
    waitingReason: { code: 'waiting_dependency', dependencyInstructionIds: ['dependency-secret'] } }])
  const text = formatCoordinationSnapshot(result)
  assert.match(text, /核查订单 BIZ-413 https:\/\/example.test\/order\/BIZ-413/)
  assert.match(text, /需要先完成前面的事项/)
  assert.doesNotMatch(text, /internal-task|instruction-secret|command-secret|dependency-secret|waiting_dependency|正式完成 0/)
})

test('接纳、改期、暂停、恢复、取消和未明确事项都使用自然文案', () => {
  const options = { timeZone: 'Asia/Shanghai' }
  const proposal = { kind: 'schedule', actionKind: 'message-reminder', rule: { kind: 'once', at: '2026-10-23T08:22:00Z' },
    timezone: 'UTC', reminderText: '查看进度。', recipientIds: ['recipient-secret'], interpretation: 'coordination-secret schedule-secret 版本9' }
  assert.equal(formatCoordinationAcceptance(proposal, options), '已安排提醒：2026年10月23日 16:22（北京时间），查看进度。')
  const schedule = { rule: proposal.rule, timezone: 'UTC', action: { kind: 'message-reminder', text: proposal.reminderText } }
  const changed = { kind: 'schedule-change', scheduleId: 'schedule-secret', expectedScheduleRevision: 9, rule: proposal.rule }
  assert.equal(formatCoordinationAcceptance(changed, { ...options, schedule }), '已将提醒时间改为2026年10月23日 16:22（北京时间）：查看进度。')
  for (const [state, verb] of [['paused', '暂停'], ['active', '恢复'], ['cancelled', '取消']]) {
    assert.equal(formatCoordinationAcceptance({ ...changed, rule: undefined, state }, { ...options, schedule }), `已${verb}这项提醒${state === 'cancelled' ? '的后续安排' : ''}：查看进度。`)
  }
  for (const [control, verb] of [['pause', '暂停'], ['resume', '恢复'], ['cancel', '取消']]) {
    assert.equal(formatCoordinationAcceptance({ kind: 'occurrence-control', occurrenceId: 'time-secret', control },
      { ...options, occurrence: { action: { kind: 'message-reminder' } } }), `已${verb}本次提醒。`)
  }
  assert.equal(formatCoordinationAcceptance({ kind: 'arrangement', pendingClarifications: [{ clarificationId: 'internal-question', question: '提醒你查看哪个项目？' }] }, options), '提醒你查看哪个项目？')
  assert.doesNotMatch(formatCoordinationAcceptance({ ...proposal, actionKind: 'read-query' }, options), /secret|补执行|0 项|动作结果|UTC|。。/)
})

test('改期、单次暂停、取消后的送达和无结果通知都按真实状态说明', () => {
  const result = coordinationSnapshot({ coordination: { id: 'coordination-secret', revision: 3, state: 'active' }, members: [], tasks: [],
    schedules: [{ id: 'schedule-secret', revision: 2, state: 'active', timezone: 'Asia/Shanghai', rule: { kind: 'once', at: '2026-10-23T08:40:00Z' },
      action: { kind: 'message-reminder', text: '查看进度。' }, target: { recipientIds: [] } }],
    occurrences: [{ id: 'old-time', scheduleId: 'schedule-secret', plannedAt: '2026-10-23T08:22:00Z', actionState: 'waiting', deliveryState: 'none', paused: true }], jobs: [] })
  let text = formatCoordinationSnapshot(result, { timeZone: 'Asia/Shanghai' })
  assert.match(text, /16:40/); assert.match(text, /16:22（北京时间）的提醒已暂停/)
  result.occurrences[0].cancelledAt = '2026-10-23T08:30:00Z'; result.occurrences[0].deliveryState = 'delivered'
  text = formatCoordinationSnapshot(result, { timeZone: 'Asia/Shanghai' })
  assert.match(text, /已取消/); assert.match(text, /之前的通知已经送达，取消不会撤回已发消息/)
  result.schedules = []; result.occurrences = [{ actionState: 'succeeded', deliveryState: 'none' }]
  assert.equal(formatCoordinationSnapshot(result), '本次安排已执行。')
  assert.equal(Object.hasOwn(snapshot([]), 'paused'), false)
  const unpaused = coordinationSnapshot({ coordination: { id: 'c', state: 'active', revision: 1 }, members: [], tasks: [], schedules: [], jobs: [],
    occurrences: [{ id: 'o', actionState: 'waiting', deliveryState: 'none', paused: false }] })
  assert.equal(Object.hasOwn(unpaused.occurrences[0], 'paused'), false, '未暂停历史快照的字段和 digest 不因文案升级改变')
  for (const deliveryState of ['unknown', 'delivered']) {
    const acknowledgement = formatCoordinationAcceptance({ kind: 'occurrence-control', control: 'cancel' }, { occurrence: { action: { kind: 'message-reminder' }, deliveryState } })
    assert.match(acknowledgement, deliveryState === 'unknown' ? /是否送达尚未确认/ : /已经送达，取消不会撤回/)
  }
})

test('恢复旧控制确认使用已被再次调整的当前事实，不混用旧操作与新时间', () => {
  const options = { timeZone: 'Asia/Shanghai', schedule: { revision: 3, state: 'cancelled', action: { kind: 'message-reminder', text: '查看进度。' },
    rule: { kind: 'once', at: '2026-10-23T08:40:00Z' }, timezone: 'Asia/Shanghai' } }
  const text = formatCoordinationAcceptance({ kind: 'schedule-change', expectedScheduleRevision: 1, rule: { kind: 'once', at: '2026-10-23T08:30:00Z' } }, options)
  assert.equal(text, '这项提醒后来又有调整，目前已取消：查看进度。')
  assert.doesNotMatch(text, /已将|16:40|16:30/)
  assert.equal(formatCoordinationAcceptance({ kind: 'occurrence-control', control: 'resume', expectedControlRevision: 1 }, {
    occurrence: { instanceControlRevision: 3, cancelledAt: '2026-10-23T08:30:00Z', action: { kind: 'message-reminder' } } }), '这次提醒后来又有调整，目前已取消。')
  for (const [deliveryState, boundary] of [['unknown', '之前的通知是否送达尚未确认。'], ['delivered', '之前的通知已经送达，取消不会撤回已发消息。']]) {
    assert.equal(formatCoordinationAcceptance({ kind: 'occurrence-control', control: 'pause', expectedControlRevision: 1 }, {
      occurrence: { instanceControlRevision: 3, cancelledAt: '2026-10-23T08:30:00Z', deliveryState, action: { kind: 'message-reminder' } },
    }), `这次提醒后来又有调整，目前已取消。${boundary}`)
  }
})

test('历史阻塞诊断保留原证据，公开文本给出可读待核查说明', () => {
  const result = snapshot([member('A', 'applied')])
  result.members[0].blocker = 'coordinationId: coordination-secret 执行失败'
  assert.match(formatCoordinationSnapshot(result), /具体原因还需核查/)
  assert.doesNotMatch(formatCoordinationSnapshot(result), /coordinationId|coordination-secret/)
  assert.equal(result.members[0].blocker, 'coordinationId: coordination-secret 执行失败')
  result.members[0].blocker = '需要补充订单 BIZ-413 的凭证，查看 https://example.test/order/BIZ-413'
  assert.match(formatCoordinationSnapshot(result), /订单 BIZ-413 的凭证，查看 https:\/\/example.test\/order\/BIZ-413/)
})

test('historical Owner blockers do not override completed or cancelled member facts', () => {
  for (const state of ['fulfilled','cancelled']) {
    const result = coordinationSnapshot({ coordination: { id: 'coordination', revision: 2, state: 'active' },
      members: [member('A',state)], tasks: [{taskId:'A',status:state === 'fulfilled' ? 'completed' : 'active',
        lastDecision:{action:'blocked',summary:'historical blocker'}}], schedules:[],occurrences:[],jobs:[] })
    assert.equal(result.state,state === 'fulfilled' ? 'completed' : 'cancelled')
    assert.equal(result.members[0].blocker,null)
  }
})

test('all individually cancelled members report cancelled rather than zero-result business completion', () => {
  const result = snapshot([member('A','cancelled'),member('B','cancelled')])
  assert.equal(result.state,'cancelled')
  assert.equal(result.fulfilled,0)
  assert.deepEqual(result.remainingInstructionIds,[])
})

test('Owner reorder clarification remains visible as an outstanding reason but never overrides terminal facts',()=>{
  const assessment={id:'assessment',state:'needs_clarification',summary:'是否允许保留已发生的页面改动？',evidence:['existing execution log']}
  const result=snapshot([{...member('A','applied'),reorderAssessment:assessment}])
  assert.equal(result.state,'needs_attention')
  assert.equal(result.members[0].blocker,assessment.summary)
  assert.deepEqual(result.members[0].reorderAssessment.evidence,assessment.evidence)
  for(const state of ['fulfilled','cancelled'])assert.equal(snapshot([{...member('A',state),reorderAssessment:assessment}]).members[0].blocker,null)
})

test('pending members stay outstanding while recurring templates are not unexecuted business work', () => {
  const template = {...member('A','template'),recurringTemplateScheduleId:'daily',waitingReason:{code:'target_version_changed'}}
  const build = coordination => coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active',...coordination},
    members:[template],tasks:[{taskId:'A',status:'active',lastDecision:{action:'blocked',summary:'unrelated historical blocker'}}],schedules:[{id:'daily',revision:1,state:'active'}],occurrences:[],jobs:[]})
  assert.deepEqual(build({}).remainingInstructionIds,[])
  assert.equal(build({}).state,'active')
  const pending = build({pendingClarifications:[{clarificationId:'ambiguous',question:'哪一个？'}]})
  assert.equal(pending.state,'needs_attention')
  assert.deepEqual(pending.outstanding.clarificationIds,['ambiguous'])
  const cancelled=build({state:'cancelled',pendingClarifications:[{clarificationId:'ambiguous',question:'哪一个？'}]})
  assert.equal(cancelled.state,'cancelled');assert.deepEqual(cancelled.outstanding.clarificationIds,[])
})

test('fulfilled and individually cancelled members report partial completion and retain distinct member facts', () => {
  const result = snapshot([member('A','fulfilled'),member('B','cancelled')])
  assert.equal(result.state,'partially_completed')
  assert.equal(result.fulfilled,1)
  assert.deepEqual(result.members.map(m=>m.state),['fulfilled','cancelled'])
})

test('a recurring authorization blocked at trigger remains visible as outstanding with its actual reason', () => {
  const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[],tasks:[],
    schedules:[{id:'daily',state:'active',revision:1}],occurrences:[{id:'slot',actionState:'blocked',deliveryState:'none',failureReason:'authorization_changed'}],
    jobs:[{id:'job',state:'blocked',waitingReason:'authorization_changed'}]})
  assert.equal(result.state,'needs_attention');assert.deepEqual(result.outstanding.occurrenceIds,['slot'])
  assert.equal(result.occurrences[0].failureReason,'authorization_changed');assert.equal(result.jobs[0].failureReason,'authorization_changed')
  const explanation=formatCoordinationSnapshot(result)
  assert.match(explanation,/受阻/);assert.match(explanation,/相关授权已变化/);assert.doesNotMatch(explanation,/authorization_changed/)
})

test('cancelled blocked occurrence retires execution obligations but preserves unknown delivery readback',()=>{
  for(const deliveryState of ['none','unknown']){
    const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[],tasks:[],schedules:[],
      occurrences:[{id:'slot',actionState:'blocked',cancelledAt:'2026-10-21T00:00:00Z',deliveryState,failureReason:'authorization_changed'}],jobs:[]})
    assert.deepEqual(result.outstanding.occurrenceIds,deliveryState==='unknown'?['slot']:[])
    if(deliveryState==='none')assert.equal(result.state,'cancelled')
    assert.match(formatCoordinationSnapshot(result),/本次安排已取消/)
  }
})

for (const delivery of ['delivered','unknown','cancelled']) test(`expired read-only schedule prepares one recoverable notice and preserves ${delivery} boundary`, async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
  const directory=await mkdtemp(join(tmpdir(),'coordination-expired-notice-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'expired-notice',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={})=>store.command({id:randomUUID(),kind,args})
  await command('task.create',{taskId:'A',groupId:'group',request:'原目标'})
  const before=await store.query({kind:'task.get',taskId:'A'})
  const source=(await command('coordination.reserve',{unitId:'expired-query',revision:1,groupId:'group',original:'九点查询A'})).result.source
  await command('coordination.accept',{coordinationId:'expired',sourceId:source.id,fence:source.fence,members:[],readOnly:true,
    schedule:{scheduleId:'at-nine',timezone:'Asia/Shanghai',rule:{kind:'once',at:'2026-10-21T01:00:00.000Z'},
      action:{kind:'read-query',taskIds:['A']},target:{conversationId:'group',recipientIds:['recipient']}}})
  t.mock.timers.tick(76*60000)
  const occurrence=(await command('coordination.schedule.scan')).result.occurrences[0]
  assert.equal(occurrence.actionState,'expired');assert.equal(occurrence.deliveryState,'none')
  assert.deepEqual(await store.query({kind:'coordination.job.list'}),[])
  const first=(await command('coordination.aggregate',{coordinationId:'expired'})).result.notification
  assert.ok(first);assert.match(first.payload.text,/已过期，本次未执行/);assert.ok(first.payload.text.includes(formatCoordinationTime('2026-10-21T01:00:00Z')))
  assert.deepEqual(first.payload.atOpenDingTalkIds,['recipient'])
  assert.doesNotMatch(first.payload.text,/recipient|Asia\/Shanghai|at-nine|time:|版本|0 项/)
  await store.close();store=await openDynamicTaskStore(options)
  assert.equal((await command('coordination.aggregate',{coordinationId:'expired'})).result.notification,undefined)
  assert.equal((await store.query({kind:'notification.list'})).length,1)
  if (delivery==='cancelled') {
    await command('coordination.occurrence.cancel',{occurrenceId:occurrence.id,expectedControlRevision:1})
    // 不先 aggregate，直接竞争发送许可，证明最终门禁回读取消事实。
    const rejected=await command('notification.start',{notificationId:first.id})
    assert.equal(rejected.dispatchEligible,false);assert.equal(rejected.result.notification.state,'superseded')
    const after=(await command('coordination.aggregate',{coordinationId:'expired'})).result
    assert.equal(after.notification,undefined);assert.equal(after.snapshot.state,'cancelled')
    assert.equal((await store.query({kind:'notification.list'})).length,1)
    assert.deepEqual(await store.query({kind:'task.get',taskId:'A'}),before)
    return
  }
  const permitted=(await command('notification.start',{notificationId:first.id})).result.notification
  if (delivery==='unknown') await command('coordination.occurrence.cancel',{occurrenceId:occurrence.id,expectedControlRevision:1})
  await command('notification.receipt',{notificationId:first.id,dispatchToken:permitted.dispatchToken,state:delivery})
  await store.close();store=await openDynamicTaskStore(options)
  await command('coordination.schedule.scan');await command('coordination.aggregate',{coordinationId:'expired'})
  const notices=await store.query({kind:'notification.list'})
  assert.equal(notices.length,1);assert.equal(notices[0].id,first.id);assert.equal(notices[0].state,delivery)
  assert.equal(notices[0].payloadDigest,first.payloadDigest)
  assert.deepEqual(await store.query({kind:'task.get',taskId:'A'}),before)
})

test('a past recurring slot retains its own fulfillment without releasing current-version dependencies', () => {
  const old={...member('A','fulfilled'),recurringOccurrenceId:'yesterday',waitingReason:{code:'target_version_changed'},completionProof:{commandId:'old-proof'}}
  const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[old],tasks:[],
    schedules:[{id:'daily',state:'active',revision:1}],occurrences:[],jobs:[]})
  assert.equal(result.state,'active');assert.equal(result.members[0].state,'fulfilled')
  assert.deepEqual(result.remainingInstructionIds,[])
  assert.deepEqual(result.members[0].completionProof,{commandId:'old-proof'})
})

test('unsent summary A superseded by active facts B can freeze A again, while an unknown permitted summary keeps its identity', async t => {
  const directory=await mkdtemp(join(tmpdir(),'coordination-summary-'))
  const store=await openDynamicTaskStore({dbPath:join(directory,'tasks.sqlite'),instanceId:'summary-test',initialize:true})
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args)=>store.command({id:randomUUID(),kind,args})
  await command('task.create',{taskId:'A',groupId:'group',request:'original goal'})
  const source=(await command('coordination.reserve',{unitId:'unit',revision:1,groupId:'group',original:'extra material'})).result.source
  await command('coordination.accept',{sourceId:source.id,fence:1,coordinationId:'coordination',members:[{
    instructionId:'instruction',taskId:'A',progressImpact:'preserve',dependencies:[],command:{id:'coordination-command:coordination:instruction',kind:'task.supplement',
      args:{taskId:'A',expectedRequirementRevision:1,expectedControlRevision:1,messageId:'material',text:'extra material',request:'goal and material'}}}]})
  const binding=(await command('task.claim',{taskId:'A'})).result.binding
  await command('task.wait',{binding,action:'blocked',summary:'need verified evidence'})
  const first=(await command('coordination.aggregate',{coordinationId:'coordination'})).result.notification
  assert.ok(first)
  await command('task.wait',{binding,action:'wait',summary:'working'})
  await command('coordination.aggregate',{coordinationId:'coordination'})
  assert.equal((await store.query({kind:'notification.get',notificationId:first.id})).state,'superseded')
  await command('task.wait',{binding,action:'blocked',summary:'need verified evidence'})
  const returned=(await command('coordination.aggregate',{coordinationId:'coordination'})).result
  const second=returned.notification
  assert.equal(returned.snapshot.state,'needs_attention')
  assert.ok(second,'the earlier A candidate never received a send permit, so its supersession must not suppress the later A summary')
  assert.notEqual(second.id,first.id)
  assert.equal((await command('notification.start',{notificationId:first.id})).dispatchEligible,false)
  const permitted=(await command('notification.start',{notificationId:second.id})).result.notification
  await command('notification.receipt',{notificationId:second.id,dispatchToken:permitted.dispatchToken,state:'unknown'})
  await command('task.wait',{binding,action:'blocked',summary:'different new evidence missing'})
  const changed=(await command('coordination.aggregate',{coordinationId:'coordination'})).result
  assert.equal(changed.notification,undefined)
  assert.equal(changed.coordination.summaryNotificationId,second.id)
  const frozen=await store.query({kind:'notification.get',notificationId:second.id})
  assert.equal(frozen.state,'unknown')
  assert.equal(frozen.payloadDigest,second.payloadDigest)
  assert.deepEqual((await store.query({kind:'notification.list'})).map(n=>n.id),[first.id,second.id])
})

async function summaryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-significance-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'significance-test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args) => store.command({ id: randomUUID(), kind, args })
  await command('task.create', { taskId: 'A', groupId: 'group', request: '核查UPR导入' })
  const source = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'group', original: '补充材料' })).result.source
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'coordination', members: [{
    instructionId: 'instruction', taskId: 'A', progressImpact: 'preserve', dependencies: [],
    command: { id: 'coordination-command:coordination:instruction', kind: 'task.supplement',
      args: { taskId: 'A', expectedRequirementRevision: 1, expectedControlRevision: 1, messageId: 'material', text: '补充材料', request: '核查UPR导入及材料' } } }] })
  const binding = (await command('task.claim', { taskId: 'A' })).result.binding
  return { command, maintain: args => store.maintain(args), dbPath: options.dbPath, query: args => store.query(args), binding,
    restart: async () => { await store.close(); store = await openDynamicTaskStore(options) } }
}

test('已送达摘要不因内部诊断改写、重启或未通知的 A→B→A 重复发送', async t => {
  const f = await summaryFixture(t)
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '等待只读核对结果' })
  const first = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification
  const permitted = (await f.command('notification.start', { notificationId: first.id })).result.notification
  await f.command('notification.receipt', { notificationId: first.id, dispatchToken: permitted.dispatchToken, state: 'delivered' })
  for (const summary of ['已检查内部回包，仍待校验', '已排空调查，仍待结算']) {
    await f.command('task.wait', { binding: f.binding, action: 'blocked', summary })
    const result = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result
    assert.equal(result.notification, undefined)
    assert.equal(result.changed, true, '审计快照仍完整反映内部事实变化')
    await f.command('task.drained', { binding: f.binding })
    await f.restart()
    f.binding = (await f.command('task.claim', { taskId: 'A', force: true })).result.binding
  }
  await f.command('task.wait', { binding: f.binding, action: 'wait', summary: '核对中' })
  assert.equal((await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification, undefined)
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '仍待校验' })
  assert.equal((await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification, undefined)
  assert.deepEqual((await f.query({ kind: 'notification.list' })).map(item => item.id), [first.id])
})

test('相同业务意义不能绕过发送前完整事实 fence，未发送候选可重新准备', async t => {
  const f = await summaryFixture(t)
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '旧核对事实' })
  const first = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '最新核对事实' })
  const start = await f.command('notification.start', { notificationId: first.id })
  assert.equal(start.dispatchEligible, false)
  assert.equal(start.result.notification.state, 'superseded')
  const next = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification
  assert.ok(next)
  assert.notEqual(next.id, first.id)
  assert.equal(next.payload.fact.significanceDigest, first.payload.fact.significanceDigest)
  assert.notEqual(next.payload.fact.snapshotDigest, first.payload.fact.snapshotDigest)
  assert.match(next.payload.text, /最新核对事实/)
})

test('发送中聚合不能提前记为已通知：确定未发送后允许准备同业务状态的新事实', async t => {
  const f = await summaryFixture(t)
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '旧核对事实' })
  const first = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification
  const permit = (await f.command('notification.start', { notificationId: first.id })).result.notification
  assert.equal((await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification, undefined)
  await f.command('notification.receipt', { notificationId: first.id, dispatchToken: permit.dispatchToken, state: 'failed',
    error: { phase: 'send', knownNotSent: true, retryable: true, message: '发送前已确定拒绝' } })
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: '最新核对事实' })
  const next = (await f.command('coordination.aggregate', { coordinationId: 'coordination' })).result.notification
  assert.ok(next, '从未送达不能永久抑制相同业务状态的通知')
  assert.notEqual(next.id, first.id)
  assert.equal(next.payload.fact.significanceDigest, first.payload.fact.significanceDigest)
  assert.match(next.payload.text, /最新核对事实/)
})

for (const phase of ['aggregate', 'permit', 'unknown', 'delivered']) test(`历史纯观察保留可读记录并停止自动群通知：${phase}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coordination-historical-observation-'))
  const options = { dbPath: join(directory, 'tasks.sqlite'), instanceId: 'observation-test', initialize: true }
  let store = await openDynamicTaskStore(options)
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
  const command = (kind, args) => store.command({ id: randomUUID(), kind, args })
  await command('task.create', { taskId: 'A', groupId: 'group', request: '原任务' })
  const task = await store.query({ kind: 'task.get', taskId: 'A' })
  const source = (await command('coordination.reserve', { unitId: 'unit', revision: 1, groupId: 'group', original: '修复了没' })).result.source
  await command('coordination.accept', { sourceId: source.id, fence: source.fence, coordinationId: 'coordination', members: [{
    instructionId: 'observe', taskId: 'A', observation: true, dependencies: [],
    command: { id: 'coordination-command:coordination:observe', kind: 'coordination.observe', args: { taskId: 'A',
      expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision,
      expectedContextRevision: task.contextRevision ?? 0, expectedRunSequence: task.runSequence } } }] })
  const aggregate = (await command('coordination.aggregate', { coordinationId: 'coordination' })).result
  assert.equal(aggregate.notification, undefined)
  const notificationId = 'coordination:coordination:summary:1'
  await command('notification.prepare', { notificationId, kind: 'coordination', requirementRevision: 1,
    payload: { kind: 'coordination', conversationId: 'group', text: '旧观察摘要', fact: { coordinationId: 'coordination',
      eventId: 'summary:1', snapshotDigest: aggregate.coordination.aggregateDigest, summaryRevision: 1 } } })
  const historicalCoordination=(await store.query({kind:'coordination.get',coordinationId:'coordination'})).coordination
  const historicalNotice=await store.query({kind:'notification.get',notificationId})
  await store.close()
  // 只在隔离库播种升级前已存在的通知状态；不调用新版本的发送许可来伪造旧行为。
  const db = new DatabaseSync(options.dbPath)
  const coordination = historicalCoordination
  coordination.summaryNotificationId = notificationId; coordination.summaryRevision = 1
  db.prepare('UPDATE dynamic_coordination SET body=? WHERE id=?').run(JSON.stringify(coordination), 'coordination')
  if (['unknown', 'delivered'].includes(phase)) {
    const notice = historicalNotice
    notice.state = phase; notice.sendPermit = { notificationId }; notice.dispatchToken = 'old-permit'
    db.prepare('UPDATE dynamic_notifications SET body=? WHERE id=?').run(JSON.stringify(notice), notificationId)
  }
  db.close(); store = await openDynamicTaskStore(options)
  if (phase === 'permit') {
    const start = await command('notification.start', { notificationId })
    assert.equal(start.dispatchEligible, false)
    assert.equal(start.result.notification.retirement.reason, 'coordination-observation-only')
  }
  const observed = (await command('coordination.aggregate', { coordinationId: 'coordination' })).result
  assert.equal(observed.notification, undefined)
  assert.equal(observed.snapshot.members[0].observation, true)
  const notices = await store.query({ kind: 'notification.list' })
  assert.equal(notices.length, 1)
  assert.equal(notices[0].state, ['unknown', 'delivered'].includes(phase) ? phase : 'superseded')
  assert.deepEqual(await store.query({ kind: 'task.get', taskId: 'A' }), task)
})


test('Host coordination inspections stop unchanged durable growth without replaying notification effects', async t => {
  const f = await summaryFixture(t)
  await f.command('task.wait', { binding: f.binding, action: 'blocked', summary: 'synthetic blocker' })
  const first = (await f.maintain({ kind: 'coordination.aggregate', args: { coordinationId: 'coordination' } })).result
  assert.ok(first.notification)
  const before = new DatabaseSync(f.dbPath, { readOnly: true })
  const receipts = before.prepare('SELECT count(*) n FROM dynamic_receipts').get().n
  const changes = before.prepare('PRAGMA data_version').get().data_version
  for (let i=0;i<20;i++) {
    await f.maintain({ kind: 'coordination.observe.reconcile', args: { coordinationId: 'coordination' } })
    const result = (await f.maintain({ kind: 'coordination.aggregate', args: { coordinationId: 'coordination' } })).result
    assert.equal(result.changed, false)
    assert.equal(result.notification, undefined)
  }
  assert.equal(before.prepare('SELECT count(*) n FROM dynamic_receipts').get().n, receipts)
  assert.equal(before.prepare('PRAGMA data_version').get().data_version, changes, 'unchanged passes must not write central state')
  before.close()
  assert.deepEqual((await f.query({ kind: 'notification.list' })).map(n => n.id), [first.notification.id])
})
