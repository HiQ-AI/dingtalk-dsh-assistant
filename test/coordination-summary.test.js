import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { coordinationSnapshot, coordinationNotificationState, formatCoordinationSnapshot, formatCoordinationAcceptance, formatCoordinationTime } from '../packages/dingtalk-dsh-assistant/coordination-summary.js'
import { currentCoordinationFixture } from './fixtures/current-coordination-contracts.js'

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

test('a past recurring slot retains its own fulfillment without releasing current-version dependencies', () => {
  const old={...member('A','fulfilled'),recurringOccurrenceId:'yesterday',waitingReason:{code:'target_version_changed'},completionProof:{commandId:'old-proof'}}
  const result=coordinationSnapshot({coordination:{id:'coordination',revision:1,state:'active'},members:[old],tasks:[],
    schedules:[{id:'daily',state:'active',revision:1}],occurrences:[],jobs:[]})
  assert.equal(result.state,'active');assert.equal(result.members[0].state,'fulfilled')
  assert.deepEqual(result.remainingInstructionIds,[])
  assert.deepEqual(result.members[0].completionProof,{commandId:'old-proof'})
})


for (const delivery of ['delivered', 'unknown', 'cancelled']) test(`historical expired query keeps its ${delivery} evidence without scheduling or changing its Task`, async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.command('task.drained', { binding })
  const task = await f.query('task.get', { taskId: 'A' }), wakes = await f.query('wake.list')
  const receipt = delivery === 'delivered' ? { messageId: 'already-sent', conversationId: 'group' } : undefined
  await f.historical([
    ['coordination', 'expired', { state: 'active', revision: 1, groupId: 'group', memberIds: [] }],
    ['coordination_schedules', 'at-nine', { coordinationId: 'expired', state: 'expired', rule: { kind: 'once', at: '2026-10-21T01:00:00Z' } }],
    ['coordination_occurrences', 'slot', { coordinationId: 'expired', actionState: 'expired', deliveryState: delivery, plannedAt: '2026-10-21T01:00:00Z' }],
    ['notifications', 'old', { kind: 'coordination', state: delivery, receipt, sendPermit: { notificationId: 'old' },
      payload: { text: '原查询已过期，本次未执行', conversationId: 'group', atOpenDingTalkIds: ['author'], fact: { coordinationId: 'expired', eventId: 'expired-slot' } } }],
  ])
  const before = await f.query('notification.get', { notificationId: 'old' })
  await f.reopen()
  assert.deepEqual(await f.query('notification.get', { notificationId: 'old' }), before)
  assert.equal((await f.query('coordination.schedule.list'))[0].state, 'expired')
  assert.equal((await f.query('coordination.occurrence.list'))[0].deliveryState, delivery)
  assert.deepEqual(await f.query('coordination.job.list'), [])
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), task)
  assert.deepEqual(await f.query('wake.list'), wakes)
})

test('Topic explicitly decides A to B to A facts; no retired significance cache suppresses a new authorized result', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.wait(binding, 'A：等待证据')
  await f.submit(f.submission(await f.context(), { reply: '等待证据', atOpenDingTalkIds: ['author'] }, 'first-A'))
  const [first] = await f.query('notification.list')
  await f.wait(binding, 'B：核对中')
  await f.submit(f.submission(await f.context(), {}, 'silent-B'))
  await f.wait(binding, 'A：新核验仍需证据')
  assert.equal((await f.query('notification.list')).length, 1, '事实本身不自动发通知')
  await f.submit(f.submission(await f.context(), { reply: '新核验仍需证据', atOpenDingTalkIds: ['author'] }, 'second-A'))
  const notices = await f.query('notification.list')
  assert.equal(notices.length, 2); assert.notEqual(notices[0].id, notices[1].id)
  assert.deepEqual(notices[0], first); assert.match(notices[1].payload.text, /新核验/)
})

test('delivered Topic result and frozen text survive new diagnostics and silent followup decisions', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.wait(binding, '等待只读核对结果')
  await f.submit(f.submission(await f.context(), { reply: '仍待校验', atOpenDingTalkIds: ['author'] }))
  const [first] = await f.query('notification.list')
  const started = (await f.command('notification.start', { notificationId: first.id })).result.notification
  await f.command('notification.receipt', { notificationId: first.id, dispatchToken: started.dispatchToken, state: 'delivered',
    receipt: { messageId: 'delivered-once', conversationId: 'group' } })
  const delivered = await f.query('notification.get', { notificationId: first.id })
  for (const summary of ['内部回读已更新', '仍待业务核验']) {
    await f.wait(binding, summary)
    const ctx = await f.context()
    assert.equal(ctx.input.replies[0].deliveredMessageId, 'delivered-once')
    await f.submit(f.submission(ctx))
  }
  await f.command('task.drained', { binding }); await f.reopen(); await f.handler.recover()
  assert.deepEqual(await f.query('notification.get', { notificationId: first.id }), delivered)
  assert.equal((await f.query('notification.list')).length, 1)
  assert.equal(await f.context(), null)
})

test('same wording cannot bypass the current task snapshot fence before a Topic reply is accepted', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.wait(binding, '待核对')
  const old = f.submission(await f.context(), { reply: '待核对', atOpenDingTalkIds: ['author'] }, 'old-facts')
  await f.command('task.supplement', { taskId: 'A', messageId: 'new-context', text: '补充验收条件',
    expectedRequirementRevision: 1, expectedControlRevision: 1 })
  assert.equal((await f.submit(old)).status, 'topic-stale')
  assert.deepEqual(await f.query('notification.list'), [])
  const fresh = await f.context()
  assert.notEqual(fresh.taskSnapshot, old.factContext.taskSnapshot)
  await f.submit(f.submission(fresh, { reply: '按新增验收条件核对', atOpenDingTalkIds: ['author'] }, 'fresh-facts'))
  assert.equal((await f.query('notification.list')).length, 1)
  assert.match((await f.query('notification.list'))[0].payload.text, /新增验收条件/)
})

test('unknown Topic delivery remains frozen across recovery and new facts stay pending for a new decision', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.wait(binding, '旧核对事实')
  const request = f.submission(await f.context(), { reply: '旧结论', atOpenDingTalkIds: ['author'] }, 'unknown-result')
  await f.submit(request)
  const [first] = await f.query('notification.list')
  const started = (await f.command('notification.start', { notificationId: first.id })).result.notification
  await f.command('notification.receipt', { notificationId: first.id, dispatchToken: started.dispatchToken, state: 'unknown' })
  await f.wait(binding, '最新核对事实')
  const frozen = await f.query('notification.get', { notificationId: first.id })
  await f.command('task.drained', { binding }); await f.reopen(); await f.handler.recover(); await f.handler.recover()
  assert.deepEqual(await f.query('notification.get', { notificationId: first.id }), frozen)
  assert.equal((await f.query('notification.list')).length, 1)
  assert.equal((await f.context()).input.facts[0].summary, '最新核对事实')
  assert.equal(Boolean((await f.command('notification.start', { notificationId: first.id })).dispatchEligible), false)
})

for (const phase of ['aggregate', 'permit', 'unknown', 'delivered']) test(`historical observation is readable and cannot create a new group effect: ${phase}`, async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.command('task.drained', { binding })
  const task = await f.query('task.get', { taskId: 'A' })
  const state = ['unknown', 'delivered'].includes(phase) ? phase : 'prepared'
  const payload = { conversationId: 'group', text: '历史观察摘要', fact: { coordinationId: 'history', eventId: 'summary-1' } }
  await f.historical([
    ['coordination', 'history', { groupId: 'group', state: 'active', revision: 1, memberIds: ['observer'] }],
    ['coordination_members', 'observer', { coordinationId: 'history', taskId: 'A', observation: true, state: 'observing' }],
    ['notifications', 'history-summary', { kind: 'coordination', state, payload,
      ...(['unknown', 'delivered'].includes(phase) ? { sendPermit: { notificationId: 'history-summary' }, dispatchToken: 'historical-permit' } : {}),
      ...(phase === 'delivered' ? { receipt: { messageId: 'historical-delivery' } } : {}) }],
  ])
  const history = await f.query('coordination.get', { coordinationId: 'history' })
  assert.equal(history.members[0].observation, true); assert.equal(history.members[0].eligible, false)
  assert.equal(history.coordination.retirement.previousState, 'active')
  if (phase === 'permit') assert.equal(Boolean((await f.command('notification.start', { notificationId: 'history-summary' })).dispatchEligible), false)
  await f.reopen()
  const notices = await f.query('notification.list')
  assert.equal(notices.length, 1); assert.deepEqual(notices[0].payload, payload)
  assert.equal(notices[0].state, state === 'prepared' ? 'superseded' : state)
  assert.deepEqual(await f.query('task.get', { taskId: 'A' }), task)
})

test('unchanged Topic fact inspections do not grow receipts or replay accepted notification effects', async t => {
  const f = await currentCoordinationFixture(t), binding = await f.create()
  await f.wait(binding, 'synthetic blocker')
  await f.submit(f.submission(await f.context(), { reply: '等待核验', atOpenDingTalkIds: ['author'] }))
  const notices = await f.query('notification.list'), reader = new DatabaseSync(f.options.dbPath, { readOnly: true })
  try {
    const receipts = reader.prepare('SELECT count(*) n FROM dynamic_receipts').get().n
    const changes = reader.prepare('PRAGMA data_version').get().data_version
    for (let i = 0; i < 20; i++) {
      assert.equal(await f.context(), null)
      await f.query('coordination.list'); await f.query('task.events')
    }
    assert.equal(reader.prepare('SELECT count(*) n FROM dynamic_receipts').get().n, receipts)
    assert.equal(reader.prepare('PRAGMA data_version').get().data_version, changes)
  } finally { reader.close() }
  assert.deepEqual(await f.query('notification.list'), notices)
})
