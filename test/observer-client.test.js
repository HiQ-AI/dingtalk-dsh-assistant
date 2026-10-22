import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { describeMessageTraceItem } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { runInNewContext } from 'node:vm'
import { taskNotificationOutbound } from '../packages/dingtalk-dsh-assistant/task-message-projections.js'

test('成果时间记录仅混排真实巡查决定，保留无动作wait、按身份去重和时间排序', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('    const taskOutcomeRecords ='), source.indexOf('    function TaskOutcomeRecords('))
  const merge = runInNewContext(`${code}; taskOutcomeRecords`)
  const stage = { id: 'stage', at: '2026-10-22T01:00:00Z', summary: '阶段产物' }
  const review = { id: 'review', recordedAt: '2026-10-22T01:10:00Z', triggers: [{ kind: 'execution.progress.review' }, { kind: 'execution.progress.review' }],
    decision: { action: 'wait', summary: '方向正常，继续等待', evidence: ['真实记录'], limitations: ['尚未完成'] } }
  const records = merge({ executions: [{ id: 'e', title: '执行', milestones: [stage, stage] }] }, [review, review,
    { id: 'ordinary', recordedAt: '2026-10-22T01:20:00Z', triggers: [{ kind: 'execution.result' }], decision: { summary: '普通决定' } }])
  assert.equal(records.length, 2)
  assert.equal(records[0].type, '统筹巡查'); assert.equal(records[0].action, 'wait')
  assert.equal(records[1].type, '阶段成果')
  assert.equal(records[0].evidence[0], '真实记录')
  assert.equal(merge(undefined, []).length, 0)
  assert.match(source, /nextBefore !== null/)
  assert.match(source, /已加载范围内暂无阶段成果或巡查结论/)
  assert.doesNotMatch(code, /progressReview|checkedAt/)
})

test('顶部提示成功五秒关闭、手动关闭、持续错误不被刷新重开且清理定时器', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('    function FeedbackNotice('), source.indexOf('    function ObserverContent('))
  let visible = true, deps, cleanup, pendingEffect, nextId = 0
  const timers = new Map()
  const Notice = runInNewContext(`${fragment}; FeedbackNotice`, {
    useState: () => [visible, value => { visible = value }],
    useEffect: (effect, next) => { if (!deps || next.some((value, i) => value !== deps[i])) { cleanup?.(); deps = next; pendingEffect = effect } },
    window: { setTimeout: (fn, delay) => { assert.equal(delay, 5000); timers.set(++nextId, fn); return nextId }, clearTimeout: id => timers.delete(id) },
    React: { createElement: (type, props, ...children) => ({ type, props, children }) }, Button: 'button', card: {}, colors: {},
  })
  const render = props => { let result = Notice(props); if (pendingEffect) { const effect = pendingEffect; pendingEffect = undefined; cleanup = effect(); result = Notice(props) } return result }
  let tree = render({ text: '已归档' })
  assert.equal(tree.props.role, 'status'); assert.equal(timers.size, 1)
  render({ text: '已归档' }); assert.equal(nextId, 1, '轮询不能延长成功提示寿命')
  timers.get(1)(); assert.equal(render({ text: '已归档' }), null)
  tree = render({ text: '连接失败', error: true }); assert.equal(timers.size, 0); assert.equal(tree.props.role, 'alert')
  assert.equal(tree.children[1].props['aria-label'], '关闭提示'); tree.children[1].props.onClick()
  assert.equal(render({ text: '连接失败', error: true }), null)
  tree = render({ text: '新错误', error: true }); assert.equal(tree.props.role, 'alert')
  tree = render({ text: '操作完成' }); tree.children[1].props.onClick(); assert.equal(render({ text: '操作完成' }), null)
  cleanup(); assert.equal(timers.size, 0)
  assert.equal((source.match(/React\.createElement\(FeedbackNotice,/g) || []).length, 3)
})

test('消息与话题详情只展示有绑定的会话并支持分页', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /message\.runId \? React\.createElement\(Button[\s\S]*'处理过程'/)
  assert.match(source, /\/state\/workflows\/\$\{encodeURIComponent\(runId\)\}\/trace/)
  const topicContextRequest = source.slice(source.indexOf("        setContextLoading(true); setContextError('')"), source.indexOf('      const selectTopic ='))
  assert.match(topicContextRequest, /new URLSearchParams\(\{ groupId: selection\.groupId \}\)/)
  assert.match(topicContextRequest, /get\(`\/state\/topics\/\$\{encodeURIComponent\(selection\.topicId\)\}\/context\?\$\{params\}`\)/)
  assert.match(topicContextRequest, /params\.set\('cursor', contextCursor\)/)
  assert.match(topicContextRequest, /params\.set\('intentCursor', intentCursor\)/)
  assert.match(topicContextRequest, /params\.set\('revision', String\(contextRevision\)\)/)
  assert.doesNotMatch(topicContextRequest, /\/state\/workflows\/topics\//)
  assert.match(source, /session\?\.sessionId && session\.sessionBound !== false \? React\.createElement\(Button/)
  assert.match(source, /setCursorHistory\(\(items\) => \[\.\.\.items, cursor\]\)/)
  assert.match(source, /intentNextCursor/)
  assert.match(source, /判断批次分页/)
  assert.match(source, /查看本次判断/)
  assert.match(source, /重新读取当前上下文/)
})

test('精简判断轨迹不包含技术详情，并展示容量受阻原因', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const reasonCode = source.slice(source.indexOf('const traceReason = ') + 'const traceReason = '.length, source.indexOf('    const readableValue ='))
  const reason = runInNewContext(`(${reasonCode})`)
  assert.match(reason('MESSAGE_CONTEXT_CAPACITY:IB:$:33000/32000'), /上下文容量受阻.*后续判断已停止/)
  assert.match(reason('MESSAGE_MATERIAL_CAPACITY:R:u1'), /必要材料未能完整提供/)
  assert.equal(reason({ code: 'FAILED' }), '{"code":"FAILED"}')
  assert.match(reason('ENGINEERING_ACCEPTANCE_REQUIRED'), /缺少业务验收.*后续提交已停止/)
  assert.match(reason('ENGINEERING_ACCEPTANCE_FAILED'), /业务验收未通过.*后续提交已停止/)
})

test('收信箱按当前归类和话题版本计算状态，不受旧工作流字段影响', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const start = source.indexOf('      const messageWorkflowState =')
  const end = source.indexOf('      const filteredMessages =', start)
  const state = runInNewContext(`(() => { ${source.slice(start, end)}; return messageWorkflowState })()`, {
    selectedGroup: { topics: [{ processedRevision: 2, entries: [{ messageId: 'm', messageVersion: 1, action: 'add', revision: 3 }] }] },
  })
  assert.equal(state({ routingStatus: 'pending', workflowStatus: 'waiting_authorization' }), 'routing')
  assert.equal(state({ routingStatus: 'failed' }), 'failed')
  assert.equal(state({ messageId: 'm', messageVersion: 1, routingStatus: 'routed' }), 'processing')
  assert.equal(state({ messageId: 'other', routingStatus: 'routed', workflowStatus: 'intent_judging' }), 'processed')
  assert.doesNotMatch(source, /历史未记录处理过程|id: 'waiting_authorization', label: '等待授权'/)
})

test('收信箱分开表达材料读取责任及通知回读，详情可用键盘展开', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /React\.createElement\('details'[\s\S]*React\.createElement\('summary'[\s\S]*'等待与通知'/)
  assert.match(source, /message\.blockingSources/)
  assert.match(source, /恢复条件/)
  assert.match(source, /acknowledged: '已确认发送，待回读'/)
  assert.match(source, /unknown: '发送结果待核对'/)
  assert.match(source, /delivered: '已回读送达'/)
})

test('运行看板复用宿主插槽与共享导航，清退流程目录和变量配置', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /inject: \['slots', 'sessions', 'uiWorkspace', 'layout'\]/)
  assert.match(source, /priority: -10/)
  assert.match(source, /restoreSessionSelection\(\)/)
  assert.match(source, /style: navigationTabStyle\(activePage === page\.id\)/)
  assert.match(source, /'aria-label': '运行看板视图'/)
  assert.match(source, /\/state\/groups/)
  assert.match(source, /\/state\/tasks/)
  assert.doesNotMatch(source, /WorkflowBrowser|ConfigurationBrowser|WorkflowConfigurationBindings|workflow-variables|workflow-bindings|state\/workflows\/catalog/)
  assert.doesNotMatch(source, /window\.(confirm|alert|prompt)\(/)
})

test('任务卡不请求或展示执行轮次耗时统计', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /get\('\/state\/task-timings'\)/)
  assert.doesNotMatch(source, /taskTimings|timingsByTaskId|timingBreakdown|timingPart/)
  assert.doesNotMatch(source, /本轮用时|当前执行轮次统计不完整|未细分为运行状态中/)
})

test('运行看板提供统一视觉尺度、响应式布局和可见键盘焦点', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /const ui = \{ textSm: 12, textMd: 14, textLg: 16, textXl: 20/u)
  assert.match(source, /@media \(max-width: 960px\)/u)
  assert.match(source, /@media \(max-width: 720px\)/u)
  assert.match(source, /:focus-visible/u)
  assert.match(source, /observer-task-board/u)
  assert.match(source, /observer-topics-layout/u)
  assert.match(source, /actionLabel: '重新读取'/u)
})

test('发件状态按实际投递环节展示，pending不会伪装为已回读', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const expression = source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))
  const classify = runInNewContext(`(${expression})`)
  const scenarios = [
    [{ status: 'pending', readbackRequired: true }, 'confirmation', '待确认'],
    [{ status: 'pending', readbackRequired: false }, 'confirmation', '待确认'],
    [{ status: 'pending', deliveryPendingReason: 'preflight_failed', deliveryError: 'CLI_ORG_NOT_AUTHORIZED' }, 'failed', '异常'],
    [{ status: 'pending', deliveryPendingReason: 'preflight_history_partial' }, 'failed', '异常'],
    [{ status: 'pending', deliveryPendingReason: 'send_failed', deliveryError: 'timeout' }, 'failed', '异常'],
    [{ status: 'pending', deliveryError: 'legacy_error' }, 'failed', '异常'],
    [{ status: 'pending', deliveryBlockedAt: '2026-09-11T00:00:00Z', deliveryError: 'server_rejected' }, 'failed', '异常'],
    [{ status: 'pending', deliveryPendingReason: 'postflight_failed', deliveryError: 'CLI_ORG_NOT_AUTHORIZED' }, 'confirmation', '待确认'],
    [{ status: 'pending', deliveryPendingReason: 'delivery_unknown' }, 'confirmation', '待确认'],
    [{ status: 'pending', deliveryPendingReason: 'message_not_observed' }, 'confirmation', '待确认'],
    [{ status: 'sent', deliveredMessageId: 'actual-message-id' }, 'confirmed', '已送达'],
    [{ status: 'sent' }, 'confirmation', '待确认'],
    [{ status: 'sent', recallStatus: 'recalled' }, 'confirmation', '待确认'],
    [{ status: 'superseded', supersededByOutboundId: 'new' }, 'failed', '异常'],
    [{ status: 'sent', deliveredMessageId: 'actual', supersededByOutboundId: 'new' }, 'confirmed', '已送达'],
    [{ status: 'superseded', recallStatus: 'failed', recallError: 'replacement_delivery_unknown' }, 'failed', '异常'],
    [{ status: 'sent', recallStatus: 'failed', recallError: 'dws_recall_failed:1:1001' }, 'confirmation', '待确认'],
  ]
  for (const [message, id, label] of scenarios) {
    const result = classify(message)
    assert.equal(result.id, id)
    assert.equal(result.label, label)
  }
  for (const [state, phase, id, label] of [
    ['prepared', undefined, 'queued', '待发送'], ['starting', undefined, 'sending', '发送中'],
    ['unknown', 'send', 'confirmation', '待确认'], ['unknown', 'readback', 'confirmation', '待确认'],
    ['delivered', undefined, 'confirmed', '已送达'],
  ]) {
    const outbound = taskNotificationOutbound({ id: 'notice', state, payload: { text: '通知', conversationId: 'g' },
      ...(phase ? { deliveryError: { phase, message: '诊断' } } : {}),
      ...(state === 'delivered' ? { receipt: { messageId: 'verified' } } : {}) })
    const result = classify(outbound)
    assert.equal(result.id, id)
    assert.equal(result.label, label)
    assert.ok(result.hint || result.detail)
  }
  assert.match(source, /message\.deliveryError/)
  assert.match(source, /最近尝试.*fmt\(message\.deliveryAttemptedAt\)/)
  assert.match(source, /message\.deliveryAttemptCount/)
})

test('任务通知明确区分待发送、发送中、结果未知和确定的发送前阻止', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const expression = source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))
  const classify = runInNewContext(`(${expression})`)
  const scenarios = [
    [{ notificationState: 'prepared', deliveryPendingReason: 'task-notification-prepared' }, 'queued', '待发送'],
    [{ notificationState: 'starting', deliveryPendingReason: 'task-notification-starting' }, 'sending', '发送中'],
    [{ notificationState: 'unknown', deliveryPendingReason: 'task-notification-unknown' }, 'confirmation', '待确认'],
    [{ notificationState: 'unknown', deliveryPendingReason: 'task-notification-unknown', deliveryError: 'send timed out', notificationFailurePhase: 'send' }, 'confirmation', '待确认'],
    [{ notificationState: 'unknown', deliveryPendingReason: 'task-notification-unknown', deliveryError: 'collection missing', notificationFailurePhase: 'readback' }, 'confirmation', '待确认'],
    [{ notificationState: 'unknown', deliveryBlockedAt: '2026-10-14T00:00:00Z', notificationKnownNotSent: false }, 'confirmation', '待确认'],
    [{ notificationState: 'failed', deliveryPendingReason: 'task-notification-pre-send-rejected', notificationKnownNotSent: true }, 'failed', '异常'],
    [{ notificationState: 'failed', deliveryPendingReason: 'task-notification-failed', deliveryError: 'delivery failed' }, 'failed', '异常'],
    [{ notificationState: 'failed', deliveryPendingReason: 'task-notification-task-terminal', notificationKnownNotSent: true }, 'failed', '异常'],
    [{ notificationState: 'failed', deliveryPendingReason: 'task-notification-superseded', notificationKnownNotSent: true }, 'failed', '异常'],
    [{ notificationState: 'failed', deliveryPendingReason: 'task-notification-confirmation-reassessment-required', notificationKnownNotSent: true }, 'failed', '异常'],
    [{ notificationState: 'delivered', deliveredMessageId: 'observed-message' }, 'confirmed', '已送达'],
    [{ deliveryPendingReason: 'task-notification-prepared' }, 'queued', '待发送'],
    [{ deliveryPendingReason: 'task-notification-starting' }, 'sending', '发送中'],
    [{ deliveryPendingReason: 'task-notification-unknown', deliveryError: 'readback failed' }, 'confirmation', '待确认'],
    [{ deliveryPendingReason: 'task-notification-pre-send-rejected' }, 'failed', '异常'],
    [{ deliveryPendingReason: 'task-notification-failed' }, 'failed', '异常'],
    [{ deliveryPendingReason: 'task-notification-task-terminal' }, 'failed', '异常'],
    [{ deliveryPendingReason: 'task-notification-superseded' }, 'failed', '异常'],
    [{ deliveryPendingReason: 'task-notification-confirmation-reassessment-required' }, 'failed', '异常'],
  ]
  for (const [facts, id, label] of scenarios) {
    const result = classify({ status: 'pending', ...facts })
    assert.equal(result.id, id)
    assert.equal(result.label, label)
    if (facts.deliveryPendingReason === 'task-notification-task-terminal' || facts.deliveryPendingReason === 'task-notification-superseded' || facts.deliveryPendingReason === 'task-notification-confirmation-reassessment-required') {
      assert.equal(result.retryDisabled, true)
      assert.doesNotMatch(result.label, /已发送|已回读|待发送/)
    }
    if (facts.notificationState === 'unknown' || facts.deliveryPendingReason === 'task-notification-unknown') {
      assert.doesNotMatch(`${result.label} ${result.detail}`, /待发送|未发送|发送前受阻/)
      assert.equal(result.state, 'warning')
    }
  }
  assert.match(classify({ notificationState: 'failed', deliveryPendingReason: 'task-notification-pre-send-rejected' }).detail, /本次未发送/)
  assert.doesNotMatch(classify({ notificationState: 'failed', notificationKnownNotSent: false }).detail, /未发送/)
  assert.match(classify({ notificationState: 'failed', notificationKnownNotSent: true }).detail, /已确认本次未发送/)
  assert.equal(classify({ notificationState: 'unknown', recallStatus: 'recalled' }).id, 'confirmation')
  assert.equal(classify({ notificationState: 'unknown', supersededByOutboundId: 'replacement' }).id, 'confirmation')
  const filter = source.slice(source.indexOf("label: '筛选发送状态'"), source.indexOf('      const messagesTable ='))
  assert.match(filter, /notificationState: 'starting'/)
  assert.doesNotMatch(filter, /筛选发送原因|筛选替代关系|筛选撤回结果/)
  assert.match(filter, /notificationState: 'unknown'/)
  assert.match(filter, /notificationState: 'failed'/)
  assert.equal((filter.match(/筛选发送状态/g) || []).length, 1)
})

test('任务通知发件行仅展示状态、脱敏诊断和重试时间，不读取 ACK 原文', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const expression = source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))
  const outboxDelivery = runInNewContext(`(${expression})`)
  const rows = source.slice(source.indexOf('      const outboxRows ='), source.indexOf('      const renderTaskCard ='))
  const diagnostic = 'CLI_READBACK_FAILED: authorization=[redacted]'
  const message = { outboundId: 'notice', sourceMessageId: 'task-notification:notice', text: '通知正文', status: 'pending',
    notificationState: 'unknown', deliveryPendingReason: 'task-notification-unknown', notificationFailurePhase: 'readback',
    deliveryError: diagnostic, notificationRetryAt: '2026-10-14T00:01:00.000Z',
    get ack() { throw new Error('ACK must not be read by the UI') },
  }
  const render = value => runInNewContext(`${rows}; outboxRows`, {
    visibleOutbox: [value], outboxDelivery,
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }) },
    colors: { warning: 'warning', danger: 'danger', muted: 'muted', cardSurface: 'surface' }, tableBodyCell: {},
    clampTableContent: (...children) => children, singleLineTableContent: value => value,
    tableStatusTag: (label, state) => ({ type: 'tag', props: { state }, children: [label] }),
    fmt: value => `本地时间 ${value}`, short: value => value || '—',
  })
  const withFacts = facts => Object.assign(Object.create(message), facts)
  const text = tree => flattenElements(tree).flatMap(item => item.children.filter(value => typeof value === 'string')).join('\n')
  const row = render(message)[0]
  assert.equal(row.children.filter(child => child?.type === 'td').length, 4)
  const records = flattenElements(row).find(element => element.type === 'details')
  assert.equal(records.props.open, undefined, '内部 ID 默认折叠')
  assert.match(text(records), /消息记录/)
  const rendered = text(row)
  assert.match(rendered, /待确认/)
  assert.match(row.children[0].props.title, /发送后回读/)
  const checking = text(render(withFacts({ notificationFailurePhase: 'send' }))[0])
  assert.match(checking, /待确认/)
  assert.match(checking, /计划核验/)
  assert.doesNotMatch(checking, /计划重试/)
  assert.ok(rendered.includes(diagnostic))
  assert.match(rendered, /计划核验 本地时间 2026-10-14T00:01:00\.000Z/)
  assert.doesNotMatch(rendered, /待发送|\[object Object\]/)
  assert.doesNotMatch(text(render(withFacts({ deliveryError: { stdout: 'RAW_ACK_SECRET' } }))[0]), /RAW_ACK_SECRET|\[object Object\]/)
  const blocked = text(render(withFacts({ notificationState: 'failed', deliveryPendingReason: 'task-notification-pre-send-rejected', notificationKnownNotSent: true }))[0])
  assert.match(blocked, /异常/)
  assert.match(blocked, /本次未发送/)
  assert.match(blocked, /计划重试 本地时间 2026-10-14T00:01:00\.000Z/)
  for (const [reason, label] of [['task-notification-task-terminal', '异常'], ['task-notification-superseded', '异常'], ['task-notification-confirmation-reassessment-required', '异常']]) {
    const retired = text(render(withFacts({ notificationState: 'failed', deliveryPendingReason: reason, notificationKnownNotSent: true }))[0])
    assert.ok(retired.includes(label))
    assert.doesNotMatch(retired, /计划重试|计划核验|已发送|已回读/)
  }
  const delivered = text(render(withFacts({ status: 'sent', notificationState: 'delivered', deliveredMessageId: 'observed' }))[0])
  assert.doesNotMatch(delivered, /计划重试|计划核验/); assert.match(delivered, /历史诊断：CLI_READBACK_FAILED/)
  const replacedDelivered = text(render(withFacts({ status: 'sent', notificationState: 'delivered', deliveredMessageId: 'observed', supersededByOutboundId: 'replacement', deliveredAt: '2026-10-19T02:27:24Z' }))[0])
  assert.match(replacedDelivered, /已送达/)
  assert.match(replacedDelivered, /已替代/)
  assert.match(replacedDelivered, /本地时间 2026-10-19T02:27:24Z/)
  assert.doesNotMatch(replacedDelivered, /等待替换通知|送达后撤回/)
  const timed = text(render(withFacts({ sentAt: '2026-10-19T02:27:14Z', deliveredAt: '2026-10-19T02:27:24Z' }))[0])
  assert.match(timed, /本地时间 2026-10-19T02:27:24Z/)
  assert.doesNotMatch(timed, /未记录|回读确认|2026-10-19T02:27:14Z/)
  const superseded = text(render(withFacts({ supersededByOutboundId: 'replacement' }))[0])
  assert.match(superseded, /已替代/); assert.match(superseded, /待确认/); assert.doesNotMatch(superseded, /等待替换通知|送达后撤回/)
})

test('界面只保留发送状态筛选，关系与撤回不影响主状态筛选', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const classify = runInNewContext(`(${source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))})`)
  const fragment = source.slice(source.indexOf('      const filteredOutbox ='), source.indexOf('      const outboxPageSize ='))
  const selectedOutbox = [{ status: 'sent', notificationState: 'delivered', supersededByOutboundId: 'new', recallStatus: 'recalled' }, { status: 'sent' }, { notificationState: 'unknown' }]
  const filter = outboxStatusFilter => runInNewContext(`${fragment}; filteredOutbox.length`, { selectedOutbox, outboxStatusFilter, outboxDelivery: classify })
  assert.equal(filter('confirmed'), 1)
  assert.equal(filter('confirmation'), 2)
  assert.equal(filter('all'), 3)
  assert.equal(filter('failed'), 0)
})

test('现行通知账优先，历史字段与撤回结果不能覆盖未知或送达事实', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const classify = runInNewContext(`(${source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))})`)
  for (const recallStatus of ['requested', 'failed', 'recalled']) {
    for (const [notificationState, id] of [['delivered', 'confirmed'], ['unknown', 'confirmation'], ['prepared', 'queued']]) {
      const result = classify({ notificationState, status: 'sent', deliveredMessageId: 'old', supersededByOutboundId: 'new', recallStatus, recallRetryAt: '2099-01-01', recallError: 'replacement_delivery_unknown', deliveryBlockedAt: 'old', deliveryPendingReason: 'preflight_failed' })
      assert.equal(result.id, id)
      assert.equal(result.recall.id, recallStatus)
      assert.equal(result.replacementId, 'new')
      assert.doesNotMatch(JSON.stringify(result), /将有限重试|等待替换通知|送达后撤回/)
      if (notificationState === 'unknown') assert.doesNotMatch(result.detail, /未发送|发送前/)
    }
  }
  assert.equal(classify({ notificationState: 'future-state', status: 'sent' }).id, 'confirmation')
  assert.equal(classify({ status: 'sent' }).id, 'confirmation')
  assert.equal(classify({ status: 'pending' }).id, 'confirmation')
  assert.match(classify({ status: 'pending', deliveryPendingReason: 'postflight_failed' }).detail, /历史发送后回读失败/)
  for (const message of [{ notificationState: 'prepared' }, { notificationState: 'starting' }, { notificationState: 'unknown' }, { notificationState: 'unknown', notificationFailurePhase: 'readback' }, { notificationState: 'failed' }, { notificationState: 'delivered' }, { status: 'sent' }, { status: 'superseded' }]) {
    assert.ok(classify(message).label.length <= 4, '发送状态使用最多四字短名称')
  }
  assert.equal(classify({ notificationState: 'failed', deliveryPendingReason: 'task-notification-confirmation-reassessment-required' }).reasonId, 'verification')
})

test('处理步骤直接展示事项、关联对象和动作结论，未知结构不编造结果', async () => {
  const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
  const code=source.slice(source.indexOf('    const traceStatus ='),source.indexOf('    const traceElapsed ='))
  const describe=describeMessageTraceItem; const status=runInNewContext(`${code};traceStatus`)
  const split=describe({kind:'split',output:{units:[{goalText:'核对租户甲'},{goalText:'等待确认'}]}})
  assert.equal(split.conclusion,'拆分为 2 个事项');assert.equal(split.rows[1].value,'等待确认')
  const route=describe({kind:'route',input:{goalText:'核对租户甲',candidates:[{candidateId:'t1',title:'租户权限排查'}]},output:{kind:'binding',disposition:'existing',candidateId:'t1',evidence:['引用原话']}})
  assert.ok(route.rows.some(row=>row.value==='租户权限排查'))
  const intent=describe({kind:'intent',output:{decisions:[{intent:{actions:[{intent:'research',arguments:{objective:'核对权限'}}],constraints:['仅排查，不修改']}}]}})
  assert.equal(intent.rows[0].label,'开展排查');assert.equal(intent.rows[1].value,'仅排查，不修改')
  assert.equal(describe({kind:'route',output:{kind:'needs_clarification',question:'哪个租户？'}}).conclusion,'需要进一步确认')
  assert.equal(describe({kind:'intent',status:'failed'}).conclusion,'本步未完成，请查看阻塞原因')
  assert.equal(describe({kind:'unknown'}).conclusion,'尚未记录判断结论')
  assert.equal(status('settled'),'处理已结束');assert.equal(status('alien'),'状态未记录')
  assert.doesNotMatch(source,/技术详情|消息技术记录|const traceUsage/);assert.match(source,/回复送达情况见发信箱/)
})

test('消息处理历时固定截止已记录状态时间，不使用发送时间回退或当前时钟',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('const messageProcessingElapsed = ')+'const messageProcessingElapsed = '.length,source.indexOf('    const traceReason ='))
 const elapsed=runInNewContext(`(${code})`)
 const row={processingSentAt:'2026-10-15T00:00:00Z',processingCompletedAt:'2026-10-15T00:01:23Z'}
 assert.equal(elapsed(row),'历时 1 分 23 秒')
 for(const value of [undefined,null,'', 'invalid'])assert.equal(elapsed({...row,processingCompletedAt:value}),'历时未记录')
 assert.equal(elapsed({...row,processingSentAt:undefined,occurredAt:row.processingSentAt}),'历时未记录')
 assert.equal(elapsed({...row,processingCompletedAt:'2026-10-14T00:00:00Z'}),'历时未记录')
 assert.equal(elapsed({processingSentAt:0,processingCompletedAt:2500}),'历时 2.5 秒')
})

test('步骤耗时使用本次 startedAt，缺失或倒置时间不冒充零耗时',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('const traceElapsed = ')+ 'const traceElapsed = '.length,source.indexOf('    const messageProcessingElapsed ='))
 const elapsed=runInNewContext(`(${code})`)
 const step={startedAt:'2026-09-26T00:00:00Z',completedAt:'2026-09-26T00:00:02.500Z',status:'succeeded'}
 assert.equal(elapsed(step,0),'耗时 2.5 秒')
 assert.equal(elapsed({...step,attempt:2},0),'耗时 2.5 秒（第 2 次处理）')
 assert.equal(elapsed({...step,startedAt:undefined},0),'耗时未记录')
 assert.equal(elapsed({...step,completedAt:'2026-09-25T00:00:00Z'},0),'耗时未记录')
 assert.equal(elapsed({...step,status:'running'},Date.parse('2026-09-26T00:01:05Z')),'已用时 1 分 5 秒')
})

function stepOutputHarness(source, props) {
  const fragment = source.slice(source.indexOf('    function TaskStepOutputContent('), source.indexOf('    const linkedTaskText ='))
  const states = [], effects = [], scheduled = [], requests = []
  let cursor = 0
  const component = runInNewContext(`${fragment}; TaskStepOutputContent`, {
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(fn, deps) {
      const index = cursor++, previous = effects[index]
      if (!previous || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.cleanup?.(); effects[index] = { deps }
        scheduled.push(() => { effects[index].cleanup = fn() })
      }
    },
    React: { createElement: (type, properties, ...children) => ({ type, props: properties || {}, children: children.flat() }) },
    Button: 'button', colors: {}, ENDPOINT: 'http://localhost',
    get(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })) },
  })
  return {
    requests,
    render(next = props) { props = next; cursor = 0; const tree = component(props); scheduled.splice(0).forEach(effect => effect()); return tree },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}
function flattenElements(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...(tree.children || []).flatMap(flattenElements)]
}

test('历史人工介入只读且明确新执行使用原生权限流程', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /id: 'authorizations', label: '人工介入'/)
  assert.match(source, /历史介入记录只读。新执行的权限请求请在对应执行会话中处理。/)
  assert.doesNotMatch(source, /decideAuthorization|批准该事项并继续|\/authorizations\/.*\/decision/)
})
const settle = () => new Promise(resolve => setImmediate(resolve))

test('任务正文分页绑定当前详情版本，失败保留正文且旧版本慢响应被隔离', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const node = { runId: 'run', nodeRunId: 'node', outputRef: 'ref' }
  const first = stepOutputHarness(source, { taskId: 'task', node, detailRevision: 'v1' })
  first.render()
  assert.match(first.requests[0].url, /cursor=0&detailRevision=v1$/)
  first.requests[0].resolve({ text: '首段', nextCursor: 10, documentName: '结果.md' }); await settle()
  let tree = first.render()
  assert.match(flattenElements(tree).find(item => item.type === 'a').props.href, /detailRevision=v1$/)
  flattenElements(tree).find(item => item.children.includes('继续阅读产出')).props.onClick()
  first.render()
  assert.match(first.requests[1].url, /cursor=10&detailRevision=v1$/)
  first.requests[1].reject(new Error('network')); await settle()
  tree = first.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('首段')))
  assert.ok(flattenElements(tree).some(item => item.props.role === 'alert'))
  flattenElements(tree).find(item => item.children.includes('重试读取产出')).props.onClick(); first.render()
  first.unmount()
  const second = stepOutputHarness(source, { taskId: 'task', node: { ...node, outputRef: 'ref-v2' }, detailRevision: 'v2' })
  tree = second.render()
  assert.ok(!flattenElements(tree).some(item => item.children.includes('首段')))
  assert.match(second.requests[0].url, /cursor=0&detailRevision=v2$/)
  second.requests[0].resolve({ text: '当前正文', nextCursor: null }); await settle()
  first.requests[2].resolve({ text: '过期追加', nextCursor: null }); await settle()
  tree = second.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('当前正文')))
  assert.ok(!flattenElements(tree).some(item => item.children.includes('过期追加')))
  assert.match(source, /key: `\$\{taskId\}:\$\{node\.runId\}:\$\{node\.nodeRunId\}:\$\{node\.outputRef\}`/)
})

test('技术方案沿原组件展开正文并下载，修订意见保持可读标签', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const view = stepOutputHarness(source, { taskId: 'task', node: { runId: 'run', nodeRunId: 'plan', outputRef: 'ref' }, detailRevision: 'v1' })
  view.render()
  view.requests[0].resolve({ text: '# 技术方案\n\n方案修订意见\n补充边界条件', overview: '修改方案.md', documentName: '修改方案.md', nextCursor: null }); await settle()
  let tree = view.render()
  assert.ok(flattenElements(tree).some(item => item.type === 'a' && item.children.includes('下载 修改方案.md')))
  flattenElements(tree).find(item => item.type === 'details').props.onToggle({ currentTarget: { open: true } })
  tree = view.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('# 技术方案')))
  assert.ok(flattenElements(tree).some(item => item.type === 'strong' && item.children.includes('方案修订意见')))
  assert.ok(flattenElements(tree).some(item => item.children.includes('补充边界条件')))
})

test('未变产物的详情版本推进保留已读正文与分页，新页使用新版本', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const props = { taskId: 'task', node: { runId: 'run', nodeRunId: 'node', outputRef: 'ref' }, detailRevision: 'v1' }
  const view = stepOutputHarness(source, props); view.render()
  view.requests[0].resolve({ text: '保留正文', nextCursor: 6 }); await settle()
  let tree = view.render({ ...props, detailRevision: 'v2' })
  assert.equal(view.requests.length, 1)
  assert.ok(flattenElements(tree).some(item => item.children.includes('保留正文')))
  flattenElements(tree).find(item => item.children.includes('继续阅读产出')).props.onClick(); view.render({ ...props, detailRevision: 'v2' })
  assert.match(view.requests[1].url, /cursor=6&detailRevision=v2$/)
  view.render({ ...props, detailRevision: 'v3' })
  assert.match(view.requests[2].url, /cursor=6&detailRevision=v3$/)
  view.requests[1].resolve({ text: '过期页', nextCursor: null }); view.requests[2].resolve({ text: '当前页', nextCursor: null }); await settle()
  tree = view.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('保留正文当前页')))
  assert.ok(!flattenElements(tree).some(item => item.children.includes('保留正文过期页')))
})

test('简短任务标题保留可读首句，完整目标仍可展开且不写回原任务', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('    const taskDisplayTitle ='), source.indexOf('    const traceElapsed ='))
  const title = runInNewContext(`${fragment}; taskDisplayTitle`)
  assert.equal(title({ title: '核对部署结果' }), '核对部署结果')
  const task = { title: '核对当前服务部署结果。' + '补充验收条件'.repeat(30), objective: '完整目标' }
  assert.equal(title(task), '核对当前服务部署结果')
  assert.ok(Array.from(title({ title: '发布并部署'.repeat(30) })).length <= 32)
  assert.equal(title({ title: '   ' }), '未命名任务')
  assert.equal(task.objective, '完整目标')
  assert.match(source, /task\.objective/)
})

test('历史工作流消息按收信处理进度展示，不混入任务执行状态',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const stateCode=source.slice(source.indexOf('const messageWorkflowState = ')+'const messageWorkflowState = '.length,source.indexOf('      const filteredMessages ='))
 const state=runInNewContext(`(${stateCode})`,{selectedGroup:{topics:[]}})
 const deliveryCode=source.slice(source.indexOf('const delivery = ')+'const delivery = '.length,source.indexOf('      const messageRows ='))
 const delivery=runInNewContext(`(${deliveryCode})`)
 const message={workflowStatus:'execution_blocked',routingStatus:'routed',sourceKind:'workflow-v2'}
 assert.equal(state(message),'processed')
 assert.equal(delivery[state(message)].label,'已处理')
 assert.equal(delivery[state({...message,workflowStatus:'waiting_system'})].label,'已处理')
 assert.equal([message].filter(item=>state(item)==='processed').length,1)
})

test('任务短名称合同拒绝超过30字，读模型回退截断不修改完整目标',async()=>{
 const {taskTitle,taskTitleSchema}=await import('../packages/dingtalk-dsh-assistant/task-input-contract.js');
 assert.equal(taskTitleSchema.safeParse('字'.repeat(30)).success,true);
 assert.equal(taskTitleSchema.safeParse('字'.repeat(31)).success,false);
 const objective='针对孙鹏要求在生产环境Editor数据库process_id_temp表新增name列，调查结构并准备DDL';
 assert.equal(Array.from(taskTitle(objective)).length,30);
 assert.equal(taskTitle('  核对Editor临时表结构  '),'核对Editor临时表结构');
 assert.ok(objective.includes('准备DDL'));
 const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/workflow-service.js',import.meta.url),'utf8');
 assert.match(source,/title: taskTitle\(requirement\?\.title/);
});

test('自动与手动刷新共用一个请求，失败后可重新读取',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8');
 const fragment=source.slice(source.indexOf('      const pendingRefresh = '),source.indexOf('      const manualRefresh = '));
 let calls=0,resolve,reject;const updates=[],errors=[];const operation=()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no})};
 const refresh=runInNewContext(`(()=>{${fragment};return refresh})()`,{useRef:value=>({current:value}),useCallback:fn=>fn,load:operation,setData:v=>updates.push(v),setUpdatedAt:()=>{},setError:e=>errors.push(e),Date,Error});
 const first=refresh();assert.equal(refresh(),first);assert.equal(calls,1);resolve({groups:[]});await first;assert.equal(updates.length,1);
 const failed=refresh();reject(new Error('读取失败'));await failed;assert.equal(errors.at(-1),'读取失败');
 const recovered=refresh();resolve({groups:[1]});await recovered;assert.equal(calls,3);assert.equal(updates.length,2);
});

test('详情慢查询跨刷新复用，切换任务不接受旧响应', async () => {
  const source = (await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const start = source.indexOf('      const pendingDetail = '), end = source.indexOf('      useEffect(() => {\n        refresh()', start)
  const effects = [], requests = [], details = [], pending = { current: null }
  const environment = { useRef: () => pending, useEffect: fn => effects.push(fn), selectedTaskId: 'one', detailRetry: 0, updatedAt: 0,
    get: path => new Promise(resolve => requests.push({ path, resolve })), setTaskDetail: value => details.push(value), setDetailError() {}, encodeURIComponent }
  const effect = () => { runInNewContext(`(()=>{${source.slice(start,end)}})()`, environment); return effects.pop()() }
  const first = effect(); first(); const refresh = effect(); assert.equal(requests.length, 1); refresh()
  environment.selectedTaskId = 'two'; effect(); assert.equal(requests.length, 2)
  requests[0].resolve({ taskId: 'one' }); requests[1].resolve({ taskId: 'two' }); await settle()
  assert.deepEqual(details.map(value => value.taskId), ['two'])
})

test('已选话题新版本刷新详情并重置旧分页，同版本及其他话题不打断阅读', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const start = source.indexOf('        const current = listing?.topics.find')
  const end = source.indexOf('      }, [listing, selection])', start)
  const code = `(()=>{${source.slice(start, end)}})()`
  const changes = []
  const selection = { topicId: 'selected', groupId: 'g', revision: 2, summaryRevision: 3, updatedAt: 'old' }
  const env = { selection, listing: { topics: [{ ...selection }] } }
  for (const name of ['setSelection', 'setMessageOffset', 'setContextCursor', 'setContextCursorHistory', 'setIntentCursor', 'setIntentCursorHistory', 'setSelectedIntentRun', 'setContextRevision', 'setContext', 'setTopicContext']) env[name] = value => changes.push([name, value])
  runInNewContext(code, env)
  assert.equal(changes.length, 0)
  env.listing.topics = [{ ...selection, topicId: 'other', revision: 4 }]
  runInNewContext(code, env)
  assert.equal(changes.length, 0)
  env.listing.topics = [{ ...selection, summaryRevision: 4, updatedAt: 'new' }]
  runInNewContext(code, env)
  assert.equal(changes.find(([name]) => name === 'setSelection')[1].summaryRevision, 4)
  assert.equal(changes.find(([name]) => name === 'setContextRevision')[1], undefined)
  assert.equal(changes.find(([name]) => name === 'setMessageOffset')[1], 0)
  assert.equal(changes.find(([name]) => name === 'setTopicContext')[1], undefined)
})

test('unlinked retired confirmation explicitly requires manual verification instead of promising an owner wake', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const expression = source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))
  const classify = runInNewContext(`(${expression})`)
  const result = classify({ notificationState: 'failed', deliveryPendingReason: 'task-notification-confirmation-reassessment-required', notificationKnownNotSent: true })
  assert.equal(result.label, '异常')
  assert.match(result.detail, /关联不足.*人工核验/)
  assert.match(result.detail, /不会自动恢复或发送/)
  assert.doesNotMatch(result.detail, /等待负责人|自动重评估|计划重试|计划核验/)
  assert.equal(result.retryDisabled, true)
})
