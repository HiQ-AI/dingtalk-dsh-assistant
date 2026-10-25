import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
const elements = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(elements)] : []
const text = tree => tree == null ? '' : typeof tree === 'object' ? (tree.children || []).map(text).join('\n') : String(tree)
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(componentName, initialProps = {}) {
  const states = [], effects = [], scheduled = [], requests = [], events = [], intervals = new Map(), timeouts = new Map()
  let timerId = 0
  let cursor = 0, component, props = initialProps, uuid = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }), Fragment: 'fragment',
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useCallback(fn) { cursor++; return fn },
    useEffect(fn, deps) { const index = cursor++, previous = effects[index]; if (!previous || deps.some((value, position) => value !== previous.deps[position])) { previous?.cleanup?.(); effects[index] = { deps }; scheduled.push(() => { effects[index].cleanup = fn() }) } },
  }
  runInNewContext(source.replace('return module.exports', `return { ...module.exports, testComponent: ${componentName} }`), {
    document: initialProps.testDocument,
    AbortController, URL, URLSearchParams, console, setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => `request-${++uuid}` },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve: value => resolve({ ok: true, json: async () => value }), reject })) },
    window: { setInterval: (fn, delay) => { intervals.set(++timerId, { fn, delay }); return timerId }, clearInterval: id => intervals.delete(id), setTimeout: (fn, delay) => { timeouts.set(++timerId, { fn, delay }); return timerId }, clearTimeout: id => timeouts.delete(id), addEventListener: (...args) => events.push(['add', ...args]), removeEventListener: (...args) => events.push(['remove', ...args]),
      __ModuleLoader__: { load: ({ factory }) => { component = factory(name => name === 'react' ? React : { Button: 'button', StateDot: 'dot' }).testComponent } } },
  })
  return { requests, events, intervals, timeouts,
    render(next = props) { props = next; cursor = 0; const tree = component(props); if (props.testDialog && tree.props?.ref) tree.props.ref.current = props.testDialog; scheduled.splice(0).forEach(effect => effect()); return tree },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}
const button = (tree, label) => elements(tree).find(item => item.type === 'button' && text(item) === label)
const input = (tree, label) => elements(tree).find(item => item.type === 'label' && item.children[0] === label)?.children.find(item => typeof item === 'object')

const workFixture = (id, overrides = {}) => ({ id, kind: 'schedule', groupId: 'g', title: `安排 ${id}`, updatedAt: '2026-10-25T00:00:00Z', result: { code: 'delivery_failed', label: '提醒发送失败', tone: 'danger' }, plan: { label: '单次计划已启用', state: 'active', rule: { kind: 'once', at: '2026-10-25T00:00:00Z' }, timezone: 'Asia/Shanghai' }, nextStep: { label: '无后续触发安排；无重试安排', triggerAt: null, sendRetryAt: null, readbackAt: null }, ...overrides })
const detailFixture = (work, overrides = {}) => ({ work, members: [], history: { sources: [], changes: [], occurrences: [], jobs: [] }, observedAt: '2026-10-25T00:00:00Z', ...overrides })

test('协调工作从实体接口读取结果而非输入，区分加载空态失败并保留同范围数据', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g', name: '验收群' }] })
  let tree = h.render()
  assert.match(h.requests[0].url, /\/state\/coordination-work\?offset=0&limit=10&groupId=g$/)
  assert.match(text(tree), /正在读取协调工作/); assert.doesNotMatch(text(tree), /暂无协调工作/)
  h.requests[0].resolve({ works: [workFixture('schedule:one', { title: '真实提醒安排', sources: [{ original: '修改输入不能成为行标题', state: 'accepted' }] })], total: 1, observedAt: '2026-10-25T00:00:00Z' }); await settle()
  tree = h.render(); assert.match(text(tree), /真实提醒安排/); assert.doesNotMatch(text(tree), /修改输入不能成为行标题|已接纳|进行中|已完成/)
  const rows = elements(tree).filter(item => item.props['data-work-id'])
  assert.equal(rows.length, 1); assert.equal(elements(rows[0]).filter(item => item.props['data-work-result']).length, 1)
  assert.match(text(rows[0]), /提醒发送失败/)
  assert.equal(elements(rows[0]).find(item => item.type === 'dot').props.state, 'error')
  assert.equal(h.intervals.size, 1)
  const tick = [...h.intervals.values()][0]; assert.equal(tick.delay, 5000)
  tick.fn(); tick.fn(); assert.equal(h.requests.length, 2, '单范围轮询不能重复发起慢请求')
  h.requests[1].reject(new Error('private raw diagnostic')); await settle(); tree = h.render()
  assert.match(text(tree), /保留上次列表/); assert.match(text(tree), /真实提醒安排/); assert.doesNotMatch(text(tree), /private raw diagnostic/)
  button(tree, '重试列表').props.onClick(); h.render()
  h.requests[2].resolve({ works: [], total: 0, observedAt: '2026-10-25T00:00:01Z' }); await settle(); tree = h.render()
  assert.match(text(tree), /暂无协调工作/); assert.doesNotMatch(text(tree), /真实提醒安排/)
  h.unmount(); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0)
})

test('协调详情按实体隔离慢响应，任务依赖证据只读且返回目标保留实体身份', async () => {
  const navigations = [], h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }], onOpenTask: (...args) => navigations.push(args) })
  h.render(); h.requests[0].resolve({ works: [workFixture('one'), workFixture('dispatch:two')], total: 2 }); await settle()
  let tree = h.render()
  elements(tree).find(item => item.props['data-work-id'] === 'one').props.onClick(); h.render()
  elements(tree).find(item => item.props['data-work-id'] === 'dispatch:two').props.onClick(); tree = h.render()
  assert.equal(h.requests[1].options.signal.aborted, true)
  assert.match(h.requests[2].url, /coordination-work\/dispatch%3Atwo$/)
  h.requests[1].resolve(detailFixture(workFixture('one', { title: '过期安排' }))); await settle()
  const detail = detailFixture(workFixture('dispatch:two', { title: '<script>untrusted()</script>', kind: 'dispatch', result: { code: 'waiting_completion', label: '等待任务完成', tone: 'warning' }, plan: null }), { history: { sources: [{ id: 's', original: '修改输入', state: 'accepted' }], occurrences: [{ occurrenceId: 'o', actionState: 'succeeded', deliveryState: 'unknown' }] }, members: [
    { instructionId: 'i-a', taskId: 'task-a', title: '前置任务', state: 'applied', dependencies: [], taskState: 'active' },
    { instructionId: 'i-b', taskId: 'task-b', title: '后续任务', state: 'ready', dependencies: ['i-a'], waitingReason: { code: 'waiting_dependency' }, reorderAssessment: { state: 'assessed', summary: '保持既有工作', evidence: ['顺序核验'] }, decision: { action: 'blocked', summary: '等待证据', evidence: ['javascript:alert(1)'], limitations: ['未核验'] } },
    { instructionId: 'i-c', taskId: 'task-c', title: '历史证明任务', state: 'version_changed', dependencies: [], completionProofCurrent: false, completionProof: null, historicalCompletionProof: { eventId: 'old-proof', commandId: 'old-completion' } },
  ], collections: { changes: { truncated: true, returned: 100, total: 101 } } })
  h.requests[2].resolve(detail); await settle(); tree = h.render()
  assert.doesNotMatch(text(tree), /过期安排/); assert.match(text(tree), /前置事项：前置任务/)
  assert.match(text(tree), /已接纳，尚未完成/); assert.match(text(tree), /结果未知/); assert.match(text(tree), /暂无当前指令的正式完成证明/)
  assert.match(text(tree), /历史完成证明引用（不证明当前指令完成）/); assert.match(text(tree), /仅显示最近 100 \/ 101 条/); assert.match(text(tree), /保持既有工作/)
  assert.match(text(tree), /<script>untrusted/); assert.equal(elements(tree).some(item => item.type === 'a' || item.props.dangerouslySetInnerHTML), false)
  for (const label of ['输入与变更历史', '任务要求与证据', '触发与送达记录', '证据与读取边界']) {
    const node = elements(tree).find(item => item.type === 'details' && text(item.children[0]) === label)
    assert.ok(node); assert.equal(node.props.open, undefined)
  }
  const actions = elements(tree).filter(item => item.type === 'button' && text(item) === '查看任务')
  actions[1].props.onClick(); assert.equal(navigations[0][0].taskId, 'task-b'); assert.equal(navigations[0][1].workId, 'dispatch:two'); assert.equal(navigations[0][1].groupId, 'g'); assert.equal(navigations[0][1].offset, 0)
  button(tree, '返回协调工作').props.onClick(); h.render(); assert.equal(h.requests[2].options.signal.aborted, true)
  h.unmount(); assert.equal(h.intervals.size, 0)
})

test('协调筛群立即移除旧实体且拒绝迟到响应，新页空态不泄露旧详情', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g', name: '新群' }], target: { groupId: '', workId: 'old' } })
  let tree = h.render()
  assert.equal(h.requests.length, 2)
  const filter = elements(tree).find(item => item.props.label === '筛选协调群组')
  filter.props.onChange('g'); tree = h.render()
  assert.match(h.requests[2].url, /groupId=g/)
  h.requests[0].resolve({ works: [workFixture('old', { title: '旧群正文' })], total: 1 })
  h.requests[1].resolve(detailFixture(workFixture('old', { title: '旧群详情' }))); await settle()
  tree = h.render(); assert.doesNotMatch(text(tree), /旧群正文|旧群详情/)
  h.requests[2].reject(new Error('coordination_observer_unavailable')); await settle(); tree = h.render()
  assert.match(text(tree), /尚未提供协调工作读取/); assert.doesNotMatch(text(tree), /暂无协调工作/)
  h.unmount()
})

test('混排记录分页经过普通决定仍可续读，失败保留、重试去重、刷新与卸载防陈旧响应', async () => {
  const h = harness('TaskOutcomeRecords', { taskId: 'task', timeline: { executions: [{ id: 'e', milestones: [{ id: 's', at: '2026-10-22T00:00:00Z', summary: '已有成果' }] }] } })
  let tree = h.render()
  assert.match(h.requests[0].url, /\/decisions\?limit=20$/)
  h.requests[0].resolve({ decisions: [{ id: 'ordinary', triggers: [], decision: { summary: '不能混入' } }], nextBefore: 10 }); await settle()
  tree = h.render(); assert.doesNotMatch(text(tree), /不能混入/); assert.match(text(tree), /还有更早/)
  button(tree, '读取更早记录').props.onClick(); button(tree, '读取更早记录').props.onClick(); h.render()
  assert.equal(h.requests.length, 2); assert.match(h.requests[1].url, /before=10/)
  h.requests[1].reject(new Error('offline')); await settle(); tree = h.render()
  assert.match(text(tree), /已有成果/); assert.match(text(tree), /未全部读取/)
  button(tree, '重试读取记录').props.onClick(); h.render()
  const review = { id: 'r', recordedAt: '2026-10-22T00:10:00Z', triggers: [{ kind: 'execution.progress.review' }], decision: { action: 'wait', summary: '无新动作，继续等待', evidence: ['日志'], limitations: [] } }
  h.requests[2].resolve({ decisions: [review, review], nextBefore: null }); await settle(); tree = h.render()
  assert.equal(text(tree).split('无新动作，继续等待').length - 1, 1)
  assert.match(text(tree), /统筹巡查/); assert.match(text(tree), /阶段成果/)
  assert.equal(button(tree, '读取更早记录'), undefined)
  button(tree, '刷新记录').props.onClick(); h.render(); h.unmount()
  assert.equal(h.requests[3].options.signal.aborted, true)
  h.requests[3].resolve({ decisions: [{ ...review, decision: { summary: '过期响应' } }], nextBefore: null }); await settle()
  assert.doesNotMatch(text(h.render()), /过期响应/)
})

test('时间泳道图保留多区段、并行、人工介入底行以及触屏可读的完整明细', () => {
  const segment = { id: 'one', label: '查询业务信息并完整核对证据'.repeat(5), startedAt: '2026-10-16T00:00:00Z', endedAt: '2026-10-16T00:01:00Z', status: 'recorded' }
  const timeline = { task: { startedAt: segment.startedAt, endedAt: segment.endedAt, active: false }, executions: [
    { id: 'session', title: '执行会话完整中文长名'.repeat(8), complete: false, segments: [segment, { ...segment, id: 'two' }], milestones: [{ id: 'milestone', summary: '成果说明', at: segment.endedAt }] },
  ], human: { id: 'human', title: '人工介入', complete: true, segments: [], milestones: [] } }
  const tree = harness('TaskExecutionTimeline', { timeline }).render(), nodes = elements(tree)
  const rows = nodes.filter(node => node.type === 'tr')
  assert.match(text(rows.at(-1)), /人工介入/)
  assert.match(text(tree), /暂无人工介入/)
  assert.match(text(tree), /部分区间未记录/)
  assert.ok(text(tree).includes(segment.label))
  assert.equal(nodes.filter(node => node.props.className?.includes('timeline-bar')).length, 3)
  assert.ok(nodes.some(node => node.type === 'details'))
  assert.ok(nodes.some(node => node.type === 'button' && node.props.className === 'timeline-milestone' && node.props['aria-label'].includes('成果说明')))
  for (const trigger of nodes.filter(node => node.props.className === 'timeline-milestone' || node.props.className?.startsWith('timeline-bar'))) {
    assert.equal(trigger.props.title, undefined)
    assert.ok(trigger.props['aria-label'])
  }
  assert.ok(nodes.some(node => node.props.className === 'timeline-duration' && text(node) === '1分0秒'))
  assert.match(text(harness('TaskOutcomeRecords', { taskId: 'task', timeline }).render()), /成果说明/)
  assert.ok(nodes.some(node => node.props.role === 'region' && node.props.tabIndex === 0))
  assert.match(text(harness('TaskExecutionTimeline', {}).render()), /历史执行过程未记录/)
})

test('任务详情只有一个任务会话入口，动态执行与结果拥有独立数据', () => {
  const task = { taskId: 't', title: '核对服务', objective: '按实际情况核对', state: 'running', requirementRevision: 2, controlRevision: 3, controlState: 'active', session: { sessionId: 'task-session', workspaceDir: '/task', logPath: '/task/log' }, result: { summary: '进行中', evidence: ['proof'], limitations: ['尚未完成'] } }
  const h = harness('TaskSessionDetail', { task, onOpenSession() {}, onChanged() {}, onBack() {} })
  const tree = h.render(), children = elements(tree)
  assert.equal(children.filter(item => item.props.label === '任务会话').length, 1)
  assert.equal(children.find(item => item.props.label === '任务会话').props.session.sessionId, 'task-session')
  assert.ok(children.some(item => item.props.taskId === 't'))
  assert.equal(children.some(item => typeof item.type === 'function' && item.type.name === 'TaskProgress'), false)
  assert.ok(children.some(item => typeof item.type === 'function' && item.type.name === 'TaskResult'))
  assert.match(text(tree), /需求修订 2/)
  assert.match(text(tree), /控制修订 3/)
  assert.doesNotMatch(source, /WorkflowBrowser|ConfigurationBrowser|groupTaskSteps|taskStepControl|planStageState/)
})

test('历史任务只读且保留产出读取，没有控制或动态新执行入口', () => {
  const task = { taskId: 'old', title: '旧任务', legacyReadonly: true, result: '历史结果', executionNodes: [{ nodeRunId: 'old-node', title: '历史步骤', status: 'succeeded', outputRef: 'old-output' }] }
  const tree = harness('TaskSessionDetail', { task, onBack() {} }).render()
  assert.ok(elements(tree).some(item => item.props.task?.legacyReadonly === true))
  const history = harness('LegacyTaskHistory', { task }).render()
  assert.match(text(history), /历史任务只读/)
  assert.ok(elements(history).some(item => item.props.node?.outputRef === 'old-output'))
  assert.equal(elements(tree).some(item => item.props.label === '任务会话'), false)
  assert.equal(elements(tree).some(item => item.props.onChanged), false)
})

test('任务与执行会话明确显示ID目录和日志，缺失会话不伪造入口', async () => {
  const opened = []
  const h = harness('SessionLocation', { session: { sessionId: 's', workspaceDir: '/task/work', logPath: '/task/log.jsonl' }, label: '任务会话', onOpenSession: async id => opened.push(id) })
  let tree = h.render()
  assert.match(text(tree), /\/task\/work/); assert.match(text(tree), /\/task\/log.jsonl/)
  await button(tree, '打开任务会话').props.onClick()
  assert.deepEqual(opened, ['s'])
  tree = h.render({ session: {}, label: '执行会话' })
  assert.match(text(tree), /尚未建立/)
  assert.equal(elements(tree).filter(item => item.type === 'button').length, 0)
})

test('Claude Code绑定只显示后端、目录和当前轮文档，不提供DSH导航', () => {
  const session = { executionBackend: 'claude-code', sessionId: 'cli-session', sessionBound: true, workspaceDir: '/task', workingDirectory: '/task/work',
    logPath: '/task/outputs/execution/claude-events.jsonl', document: { path: '/task/outputs/execution/round-2.md', inputVersion: 2 } }
  const h = harness('SessionLocation', { session, label: '执行会话', compact: true, onOpenSession() { assert.fail('CLI不能调用原生会话导航') } })
  const tree = h.render()
  assert.match(text(tree), /Claude Code/)
  assert.ok(text(tree).includes(session.workingDirectory)); assert.ok(text(tree).includes(session.logPath)); assert.ok(text(tree).includes(session.document.path))
  assert.match(text(tree), /第 2 轮/)
  assert.equal(elements(tree).filter(item => item.type === 'button').length, 0)
  assert.doesNotMatch(text(tree), /尚未绑定/)
  assert.equal(elements(h.render({ session, label: '执行会话', entryOnly: true })).filter(item => item.type === 'button').length, 0)
  const dsh = h.render({ session: { ...session, executionBackend: 'dsh' }, label: '执行会话' })
  assert.ok(button(dsh, '打开执行会话'), 'DSH入口仍保留')
})

test('结果区分结论、证据与限制，不把限制当作已完成结果', () => {
  const tree = harness('TaskResult', { result: { summary: '服务状态已核对', evidence: ['https://example.test/evidence'], limitations: ['尚未部署'] } }).render()
  assert.match(text(tree), /服务状态已核对/)
  assert.match(text(tree), /证据/); assert.match(text(tree), /限制与未验证项/); assert.match(text(tree), /尚未部署/)
  assert.equal(elements(tree).find(item => item.type === 'a').props.href, 'https://example.test/evidence')
})

test('Web看板无新建入口或表单接线，空列表和已有任务仍显示看板', () => {
  assert.doesNotMatch(source, /CreateTaskForm|creatingTask|setCreatingTask|useUnsavedTaskChanges|新建任务|task-create-error/)
  assert.doesNotMatch(source, /post\(['"]\/tasks['"]/)
  const fragment = source.slice(source.indexOf('      const tasksPage ='), source.indexOf('      const authorizationStatus ='))
  for (const bucketColumns of [[], [{ type: 'section', props: { 'aria-label': '执行中' }, children: ['已有任务'] }]]) {
    const tree = runInNewContext(`(()=>{${fragment};return tasksPage})()`, {
      selectedTaskId: '', bucketColumns, ui: {}, React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }) },
    })
    assert.ok(elements(tree).some(item => item.props.className === 'observer-task-board'))
    assert.equal(elements(tree).some(item => ['button', 'form', 'input', 'textarea'].includes(item.type)), false)
    assert.equal(text(tree).includes('已有任务'), bucketColumns.length > 0)
  }
})

test('任务对话运行中可发送，IME不误发，失败保留草稿和幂等键，关闭重开与旧回读不丢消息', async () => {
  const h = harness('TaskDialogue', { taskId: 't' })
  let tree = h.render(); button(tree, '介入任务会话').props.onClick(); tree = h.render()
  h.requests[0].resolve({ messages: [], writable: true }); await settle(); tree = h.render()
  input(tree, '消息').props.onChange({ target: { value: '目标不变，请先检查原错误' } }); tree = h.render()
  const form = () => elements(tree).find(item => item.type === 'form')
  await form().props.onSubmit({ preventDefault() {}, nativeEvent: { isComposing: true } })
  assert.equal(h.requests.length, 1)
  const first = form().props.onSubmit({ preventDefault() {} }); form().props.onSubmit({ preventDefault() {} })
  assert.equal(h.requests.length, 2)
  const identity = JSON.parse(h.requests[1].options.body)
  h.requests[1].reject(Error('connection lost')); await first; tree = h.render()
  assert.equal(input(tree, '消息').props.value, identity.text)
  assert.match(text(tree), /发送失败/)
  button(tree, '收起任务会话').props.onClick(); tree = h.render()
  button(tree, '介入任务会话').props.onClick(); tree = h.render()
  assert.equal(input(tree, '消息').props.value, identity.text)
  const retry = form().props.onSubmit({ preventDefault() {} })
  assert.deepEqual(JSON.parse(h.requests[3].options.body), identity)
  const saved = { id: identity.requestId, text: identity.text, receivedAt: '2026-10-20T02:00:00Z', reply: null }
  h.requests[3].resolve(saved); await retry
  h.requests[2].resolve({ writable: true, messages: [] }); await settle(); tree = h.render()
  assert.equal(input(tree, '消息').props.value, '')
  assert.ok(text(tree).includes(identity.text)); assert.match(text(tree), /已保存，待统筹处理/)
  button(tree, '收起任务会话').props.onClick(); tree = h.render(); button(tree, '介入任务会话').props.onClick(); h.render()
  h.requests[4].resolve({ writable: true, messages: [{ ...saved, reply: '原统筹已保存提醒，尚未确认消费。', repliedAt: saved.receivedAt }] }); await settle()
  tree = h.render(); assert.match(text(tree), /原统筹已保存提醒/)
  assert.doesNotMatch(text(tree), /已保存，待统筹处理/)
  h.unmount()
})

test('对话按任务key隔离，历史任务不挂载，已结束任务只读回看', async () => {
  for (const taskId of ['one', 'two']) {
    const tree = harness('TaskSessionDetail', { task: { taskId, state: 'running' } }).render()
    const dialogue = elements(tree).find(item => item.props.taskId === taskId && item.props.key === `dialogue:${taskId}` && item.type?.name === 'TaskDialogue')
    assert.ok(dialogue)
  }
  assert.equal(elements(harness('TaskSessionDetail', { task: { taskId: 'old', legacyReadonly: true } }).render()).some(item => item.type?.name === 'TaskDialogue'), false)
  const h = harness('TaskDialogue', { taskId: 'done' })
  button(h.render(), '介入任务会话').props.onClick(); h.render()
  h.requests[0].resolve({ writable: false, messages: [] }); await settle()
  assert.equal(button(h.render(), '发送').props.disabled, true)
  h.unmount()
})

test('介入任务会话位于原任务会话卡片，两入口样式相同，完整面板不挤入侧栏', () => {
  const h = harness('TaskSessionDetail', { task: { taskId: 'layout', state: 'running' } })
  const tree = h.render(), location = elements(tree).find(item => item.props.label === '任务会话')
  assert.equal(text(location.props.primaryAction), '介入任务会话')
  assert.equal(location.props.primaryAction.props.variant, 'outline')
  const columnsIndex = tree.children.findIndex(item => item?.props?.className === 'detail-columns')
  const dialogueIndex = tree.children.findIndex(item => item?.type?.name === 'TaskDialogue')
  assert.ok(dialogueIndex > columnsIndex)
  assert.equal(tree.children[dialogueIndex].props.hideTrigger, true)
  const card = harness('SessionLocation', { session: { sessionId: 'same-session' }, label: '任务会话', compact: true, primaryAction: location.props.primaryAction, onOpenSession() {} }).render()
  assert.equal(button(card, '打开任务会话').props.variant, 'outline')
  assert.equal(button(card, '打开任务会话').props.size, location.props.primaryAction.props.size)
  assert.equal(JSON.stringify(button(card, '打开任务会话').props.style), JSON.stringify(location.props.primaryAction.props.style))
  location.props.primaryAction.props.onClick()
  assert.equal(elements(h.render()).find(item => item.props.hideTrigger).props.open, true)
  assert.equal(h.render({ task: { taskId: 'other-task', state: 'running' } }).children.find(item => item?.props?.hideTrigger).props.open, false)
})

test('任务详情移除需求与控制区，同时保留会话、结果、执行及返回看板', () => {
  const task = { taskId: 't', title: '核对', state: 'running', objective: '核对当前服务' }
  const h = harness('TaskSessionDetail', { task, onBack() {}, onOpenSession() {} })
  const tree = h.render(), children = elements(tree)
  assert.equal(children.filter(item => item.props.label === '任务会话').length, 1)
  assert.ok(children.some(item => item.props.taskId === 't'))
  assert.ok(button(tree, '返回看板'))
  assert.equal(children.some(item => ['textarea', 'input', 'form'].includes(item.type)), false)
  assert.equal(h.requests.length, 0)
  assert.doesNotMatch(source, /TaskControls|需求与控制|提交需求补充|确认取消任务|补充需求/)

})

test('动态执行分页的失败可重试，离开后慢响应不能覆盖新查询', async () => {
  const h = harness('TaskExecutions', { taskId: 't', updatedAt: 1, onOpenSession() {} })
  h.render(); assert.match(h.requests[0].url, /executions\?offset=0&limit=20/)
  h.requests[0].resolve({ executions: [{ executionId: 'e1', objective: '检查依赖', status: 'running' }], total: 21 }); await settle()
  let tree = h.render(); assert.match(text(tree), /检查依赖/)
  button(tree, '下一页').props.onClick(); tree = h.render(); assert.match(h.requests[1].url, /offset=20/)
  tree = h.render()
  assert.match(text(tree), /检查依赖/)
  assert.match(text(tree), /21 条执行记录 · 1–1/)
  assert.equal(button(tree, '下一页').props.disabled, true)
  h.requests[1].reject(Error('offline')); await settle(); tree = h.render(); assert.ok(button(tree, '重试'))
  button(tree, '重试').props.onClick(); h.render(); assert.equal(h.requests.length, 3)
  h.requests[2].resolve({ executions: [{ executionId: 'e21', objective: '读取日志', status: 'succeeded' }], total: 21 }); await settle()
  tree = h.render(); assert.match(text(tree), /读取日志/)
  assert.equal(button(tree, '下一页').props.disabled, true)
  h.render({ taskId: 't', updatedAt: 2, onOpenSession() {} }); h.unmount()
  h.requests[3].resolve({ executions: [{ executionId: 'stale', objective: '过期' }], total: 1 }); await settle()
  assert.doesNotMatch(text(h.render()), /过期/)
})

test('执行加载状态区域与分页始终存在，空记录刷新及失败保留已显示内容', async () => {
  const h = harness('TaskExecutions', { taskId: 'empty', updatedAt: 1 })
  let tree = h.render()
  const feedback = value => elements(value).find(item => item.props.className === 'detail-execution-feedback')
  assert.ok(feedback(tree)); assert.ok(button(tree, '上一页')); assert.ok(button(tree, '下一页'))
  assert.equal(button(tree, '下一页').props.disabled, true)
  h.requests[0].resolve({ executions: [], total: 0 }); await settle()
  tree = h.render(); assert.match(text(tree), /尚无动态执行/)
  tree = h.render({ taskId: 'empty', updatedAt: 2 }); assert.ok(feedback(tree)); assert.match(text(tree), /尚无动态执行/)
  assert.equal(button(tree, '上一页').props.disabled, true)
  h.requests[1].reject(Error('network')); await settle()
  tree = h.render(); assert.match(text(tree), /尚无动态执行/); assert.ok(button(tree, '重试'))
  assert.ok(elements(tree).some(item => item.props.role === 'alert'))
})

test('执行会话计数前复用成功刷新的时间，刷新失败保留旧时间，缺失或非法时间不显示', async () => {
  const stamp = '2026-10-16T08:19:10.000Z', next = '2026-10-16T08:20:10.000Z'
  const h = harness('TaskExecutions', { taskId: 't', updatedAt: stamp })
  h.render(); h.requests[0].resolve({ executions: [], total: 0 }); await settle()
  let tree = h.render()
  assert.ok(elements(tree).some(n => n.type === 'h2' && text(n) === '执行会话'))
  assert.doesNotMatch(text(tree), /执行记录已更新|由任务会话按需安排/)
  const meta = value => elements(value).find(n => n.props.className?.includes('detail-execution-meta'))
  assert.equal(text(meta(tree).children[0]), `更新 ${new Date(stamp).toLocaleString('zh-CN', { hour12: false })}`)
  assert.match(text(meta(tree).children[1]), /0 条执行记录/)
  h.render({ taskId: 't', updatedAt: next }); h.requests[1].reject(Error('offline')); await settle()
  assert.ok(text(h.render()).includes(new Date(stamp).toLocaleString('zh-CN', { hour12: false })))
  for (const invalid of [undefined, 'invalid-time']) {
    const empty = harness('TaskExecutions', { taskId: 'empty', updatedAt: invalid })
    empty.render(); empty.requests[0].resolve({ executions: [], total: 0 }); await settle()
    assert.doesNotMatch(text(empty.render()), /Invalid Date|更新 /)
  }
})

test('取消新增蓝色覆盖后恢复PR196品牌状态色与原生StateDot，保留本轮列表内容', async () => {
  assert.doesNotMatch(source, /observer-task-running|detail-execution-running-tag|taskRunningTag|customTone/)
  const h = harness('TaskExecutions', { taskId:'t' })
  h.render(); h.requests[0].resolve({ executions:['running','succeeded','waiting'].map((status,i)=>({ executionId:String(i),status })), total:3 }); await settle()
  const nodes=elements(h.render())
  for (const color of ['var(--dsw-alias-brand-primary, #4d6bfe)','var(--dsw-alias-state-success-primary, #248a3d)','var(--dsw-alias-state-warn-primary, #a56500)']) assert.ok(nodes.some(n=>n.props.style?.color===color))
  assert.ok(nodes.some(n=>n.type==='dot' && n.props.state==='ongoing'))
  const top=elements(harness('TaskSessionDetail',{task:{ taskId:'t',state:'running' }}).render())
  assert.ok(top.some(n=>n.props.style?.color==='var(--dsw-alias-brand-primary, #4d6bfe)'))
  assert.ok(nodes.some(n=>n.type==='h2' && text(n)==='执行会话'))
})

test('当前进展合并活跃阻塞记录，包含详情分页外的并行执行且不把已完成结果当进展', () => {
  const task = { state: 'running', requirementRevision: 3, controlRevision: 1, result: { summary: '已完成的历史结论' },
    executions: [{ executionId: 'old', status: 'succeeded', drained: true, objective: '已完成事项' }, { executionId: 'stale', status: 'stale', drained: true, objective: '旧修订事项' }, { executionId: 'one', status: 'running', sessionBound: true, input: { title: '检查甲', objective: '核对甲配置' }, progressReview: { newEventCount: 2 } }],
    blockers: { executions: [{ executionId: 'one', status: 'running', input: { title: '检查甲', objective: '核对甲配置' } }, { executionId: 'two', status: 'running', sessionId: 'unverified', input: { title: '检查乙', objective: '核对乙日志' } }] } }
  const view = harness('taskProgressView', task).render()
  assert.equal(view.executions.length, 2); assert.equal(view.summary, '2 项执行中 · 0 项待执行')
  assert.equal(view.executions[0].sessionBound, true); assert.equal(view.executions[1].sessionBound, false)
  const tree = harness('TaskProgress', { task }).render()
  assert.match(text(tree), /核对甲配置/); assert.match(text(tree), /核对乙日志/); assert.match(text(tree), /新增 2 条会话事件/)
  assert.doesNotMatch(text(tree), /已完成的历史结论|已完成事项|旧修订事项|%/)
})

test('当前进展准确区分暂停、完成、恢复、旧修订收尾与暂无数据', () => {
  const base = { state: 'running', requirementRevision: 3, executions: [{ executionId: 'one', status: 'running', requirementRevision: 3 }] }
  const view = task => harness('taskProgressView', task).render()
  const paused = view({ ...base, state: 'waiting', controlState: 'paused' })
  assert.match(paused.summary, /任务已暂停/); assert.equal(paused.executions[0].running, false)
  assert.equal(view({ ...base, state: 'completed' }).executions.length, 0)
  assert.equal(view({ ...base, recovering: true }).executions[0].running, false)
  const outdated = view({ ...base, requirementRevision: 4 })
  assert.equal(outdated.executions[0].running, false); assert.equal(outdated.executions[0].label, '等待停止 / 收尾')
  assert.match(view({ state: 'running' }).summary, /暂无当前执行进展/)
  const tree = harness('TaskProgress', { task: { ...base, executions: [{ ...base.executions[0], progressReview: { readError: 'fixture_read_failure', newEventCount: 0 } }] } }).render()
  assert.match(text(tree), /进展记录读取失败/); assert.doesNotMatch(text(tree), /新增 0 条/)
})

test('整体进展不从目标或结果推断，新回合保留已确认快照并标注非实时', () => {
  const task = { state: 'running', drained: false, requirementRevision: 3, controlRevision: 1,
    result: { summary: '修复已经完成' }, executions: [{ objective: '准备验证修复' }],
    lastDecision: { action: 'wait', summary: '正在排查原因', at: '2026-10-14T09:15:00Z', requirementRevision: 3, controlRevision: 1 } }
  const view = harness('taskOverallProgressView', task).render()
  assert.equal(view.description, task.lastDecision.summary)
  assert.equal(view.recordedAt, task.lastDecision.at); assert.equal(view.missing, false)
  assert.equal(view.updating, true); assert.equal(view.heading, '最近已确认进展')
  assert.doesNotMatch(view.description, /修复已经完成|准备验证/)
})

test('整体进展校验修订和记录时间，更新中不隐藏快照，暂停完成不误报实时', () => {
  const task = { state: 'waiting', drained: true, requirementRevision: 3, controlRevision: 1,
    lastDecision: { action: 'wait', summary: '已核对修复边界，等待确认验证范围。', at: '2026-10-14T09:15:00Z', requirementRevision: 3, controlRevision: 1 } }
  const view = value => harness('taskOverallProgressView', value).render()
  assert.equal(view(task).description, task.lastDecision.summary); assert.equal(view(task).recordedAt, task.lastDecision.at)
  assert.equal(view({ ...task, state: 'running' }).description, task.lastDecision.summary)
  assert.equal(view({ ...task, state: 'running' }).heading, '最新统筹进展')
  assert.equal(view({ ...task, requirementRevision: 4 }).missing, true)
  assert.equal(view({ ...task, controlRevision: 2 }).missing, true)
  assert.equal(view({ ...task, drained: false }).missing, false)
  assert.equal(view({ ...task, drained: false }).updating, true)
  assert.equal(view({ ...task, lastDecision: { ...task.lastDecision, at: undefined } }).missing, true)
  assert.match(view({ ...task, controlState: 'paused' }).description, /任务已暂停/)
  assert.match(view({ ...task, state: 'completed' }).description, /结果与执行记录见下方/)
})

test('新回合暂缺统筹记录时保留已读确认说明，跨任务或修订不得沿用', () => {
  const task = { taskId: 'one', state: 'running', drained: true, requirementRevision: 3, controlRevision: 1,
    lastDecision: { action: 'wait', summary: '已定位原因，正在验证修复。', at: '2026-10-14T09:15:00Z', requirementRevision: 3, controlRevision: 1 } }
  const h = harness('TaskProgress', { task })
  assert.match(text(h.render()), /已定位原因，正在验证修复/)
  let tree = h.render({ task: { ...task, drained: false, lastDecision: null } })
  assert.match(text(tree), /已定位原因，正在验证修复/); assert.match(text(tree), /不代表实时工作/)
  tree = h.render({ task: { ...task, requirementRevision: 4, drained: false, lastDecision: null } })
  assert.doesNotMatch(text(tree), /已定位原因/)
  tree = h.render({ task: { ...task, taskId: 'two', drained: false, lastDecision: null } })
  assert.doesNotMatch(text(tree), /已定位原因/)
})

test('已取消任务仍出现在已结束桶，所有历史记录进入只读历史页', () => {
  assert.match(source, /\['completed', 'cancelled', 'succeeded', 'failed'\]\.includes\(task\.state\)/)
  assert.match(source, /filter\(task => task\.legacyReadonly \|\| task\.archivedAt\)/)
  assert.match(source, /slice\(\(currentHistoryPage - 1\) \* 20, currentHistoryPage \* 20\)/)
  assert.match(source, /message\.taskSessionRefs \|\| \[\]/)
  assert.match(source, /onClick: \(\) => openTask\(tasksById\.get\(taskId\) \|\| \{ taskId \}\)/)
})

test('预分配会话尚未绑定时只展示路径，不提供可继续的会话入口', () => {
  const tree = harness('SessionLocation', { session: { sessionId: 'reserved', sessionBound: false, workspaceDir: '/task/work' }, label: '任务会话' }).render()
  assert.match(text(tree), /尚未绑定/)
  assert.equal(elements(tree).filter(item => item.type === 'button').length, 0)
})


test('历史正文只在打开时读取，不因列表刷新读取全部旧工件', () => {
  const node = { nodeRunId: 'node', status: 'succeeded', outputRef: 'output' }
  const h = harness('LegacyTaskOutput', { taskId: 'old', node, detailRevision: 'v1' })
  let tree = h.render(); assert.equal(elements(tree).some(item => item.props.node), false)
  tree.props.onToggle({ currentTarget: { open: true } }); tree = h.render()
  assert.equal(elements(tree).find(item => item.props.node).props.node.outputRef, 'output')
})


test('当前人工问题答复必填、防重且失败保留原文和原修订，成功刷新原任务', async () => {
  const request = { requestId: 'question-1', taskId: 'task-1', taskSessionRequest: true, status: 'waiting-reply', requirementRevision: 2, controlRevision: 3 }
  let changed = 0
  const h = harness('HumanRequestReply', { request, onChanged: () => changed++ })
  let tree = h.render()
  await tree.props.onSubmit({ preventDefault() {} }); tree = h.render()
  assert.equal(h.requests.length, 0)
  assert.equal(input(tree, '答复内容').props.maxLength, 20000)
  assert.match(text(tree), /请填写答复内容/)
  input(tree, '答复内容').props.onChange({ target: { value: '选择目标 A，保持其他约束' } }); tree = h.render()
  const operation = tree.props.onSubmit({ preventDefault() {} }); tree.props.onSubmit({ preventDefault() {} })
  assert.equal(h.requests.length, 1)
  assert.match(h.requests[0].url, /tasks\/task-1\/human-requests\/question-1\/reply$/)
  const body = JSON.parse(h.requests[0].options.body)
  assert.equal(body.reply, '选择目标 A，保持其他约束')
  assert.equal(body.expectedRequirementRevision, 2); assert.equal(body.expectedControlRevision, 3)
  assert.equal(button(h.render(), '提交答复中…').props.disabled, true)
  h.requests[0].reject(Error('DYNAMIC_TASK_REVISION_STALE')); await operation
  tree = h.render({ request: { ...request, requirementRevision: 4 }, onChanged: () => changed++ })
  assert.equal(input(tree, '答复内容').props.value, body.reply)
  assert.match(text(tree), /DYNAMIC_TASK_REVISION_STALE.*内容已保留/)
  const retry = tree.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(JSON.parse(h.requests[1].options.body), body)
  h.requests[1].resolve({ taskId: 'task-1' }); await retry
  tree = h.render(); assert.equal(changed, 1)
  assert.match(text(tree), /答复已记录，原任务将继续处理/)
  assert.equal(button(tree, '提交答复').props.disabled, true)
})

test('历史、已答复及失效问题只读，任务问题能导航人工介入页', () => {
  for (const request of [{ status: 'waiting-reply' }, { taskSessionRequest: true, status: 'answered', reply: '已核实' }, { taskSessionRequest: true, status: 'superseded' }]) {
    const tree = harness('HumanRequestReply', { request }).render()
    assert.equal(elements(tree).some(item => item.type === 'textarea'), false)
    assert.equal(elements(tree).some(item => item.type === 'form'), false)
  }
  const opened = []
  const tree = harness('TaskSessionDetail', { task: { taskId: 't', lastDecision: { question: '选择哪个目标？' } }, onOpenHumanRequest: id => opened.push(id) }).render()
  button(tree, '查看人工介入问题').props.onClick()
  assert.deepEqual(opened, ['t'])
  assert.doesNotMatch(source, /需求与控制|TaskControls/)
})

test('任务详情使用当前申请的原因、问题和证据，忽略历史已答申请', () => {
  const current = { requestId: 'current', status: 'waiting-reply', reason: '准备已完成，目标环境尚未明确。', question: '使用哪个环境？', evidence: ['已核验配置'], attemptedActions: ['读取环境清单'] }
  const task = { taskId: 't', waitingReason: '较旧的统筹摘要', lastDecision: { question: current.question }, humanRequests: [current, { status: 'answered', question: '旧问题' }] }
  const tree = harness('TaskSessionDetail', { task }).render()
  const content = elements(tree).find(item => typeof item.type === 'function' && item.type.name === 'HumanRequestContent')
  assert.equal(content.props.request, current)
  assert.equal(elements(tree).filter(item => item.props.role === 'status').length, 0, '长申请不作为整块实时通知重复朗读')
  assert.doesNotMatch(text(tree), /较旧的统筹摘要|旧问题/)
  assert.match(source, /React\.createElement\(HumanRequestContent, \{ request: selectedAuthorization \}\)/)
})

test('人工请求分层保留完整范围，格式化链接和换行，原文可独立审计', () => {
  const scope = '不得修改生产环境；保留原有开关。'.repeat(80)
  const request = { reason: '代码已验证。\\n等待明确目标环境。', question: `是否使用候选环境？\\n范围：${scope}\\n参考 [变更记录](https://example.test/pull/353)。`,
    evidence: ['[测试结果](https://example.test/result)', 'D:\\my notes\\new.sql', '`print("\\n")`'], attemptedActions: ['读取配置\\n核对现有功能'] }
  const tree = harness('HumanRequestContent', { request }).render(), nodes = elements(tree)
  assert.deepEqual(nodes.filter(item => item.type === 'h3').map(text), ['当前进度与等待原因', '需要你决定'])
  assert.match(text(tree.children[0]), /代码已验证。\n等待明确目标环境/)
  assert.ok(text(tree.children[1]).includes(scope))
  assert.deepEqual(nodes.filter(item => item.type === 'a').map(item => [text(item), item.props.href, item.props.rel]), [
    ['变更记录', 'https://example.test/pull/353', 'noopener noreferrer'], ['测试结果', 'https://example.test/result', 'noopener noreferrer'],
  ])
  const disclosures = nodes.filter(item => item.type === 'details')
  assert.deepEqual(disclosures.map(item => text(item.children[0])), ['证据与范围明细 · 3', '已尝试 · 1', '申请原文'])
  assert.ok(disclosures.every(item => !item.props.open), '辅助资料初始折叠，问题和完整范围直接显示')
  const evidence = nodes.filter(item => item.type === 'li').map(text)
  assert.ok(evidence.includes('D:\\my notes\\new.sql'))
  assert.ok(evidence.includes('`print("\\n")`'))
  assert.equal(JSON.parse(text(nodes.find(item => item.type === 'pre'))).question, request.question)
  assert.equal(JSON.parse(text(nodes.find(item => item.type === 'pre'))).reason, request.reason)
  assert.equal(request.reason, '代码已验证。\\n等待明确目标环境。')
})

test('人工请求不把问题重复作为原因，不产生非HTTP链接或执行HTML', () => {
  const question = '选择环境。 [不可点击](javascript:alert(1)) <img src=x onerror=alert(1)>'
  const tree = harness('HumanRequestContent', { request: { question, waitingReason: question } }).render()
  assert.match(text(tree.children[0]), /该申请未说明等待原因/)
  assert.equal(text(tree.children[1]), `需要你决定\n${question}`)
  assert.equal(elements(tree).some(item => item.type === 'a' || item.type === 'img' || item.props.dangerouslySetInnerHTML), false)
  assert.equal(elements(tree).filter(item => item.type === 'details').length, 1)
})


test('人工详情使用原生Modal隔离背景，关闭恢复焦点和滚动，内部点击不关闭', () => {
  const calls = []
  const testDialog = { showModal: () => calls.push('open'), close: () => calls.push('close'), getBoundingClientRect: () => ({ left: 20, right: 900, top: 20, bottom: 800 }) }
  const testDocument = { activeElement: { isConnected: true, focus: () => calls.push('focus') }, documentElement: { style: { overflow: 'auto' } } }
  const h = harness('HumanRequestModal', { children: ['正文'], onClose: () => calls.push('dismiss'), testDialog, testDocument })
  const tree = h.render()
  assert.equal(tree.type, 'dialog')
  assert.deepEqual(calls, ['open'])
  assert.equal(testDocument.documentElement.style.overflow, 'hidden')
  tree.props.onClick({ target: testDialog, currentTarget: testDialog, clientX: 40, clientY: 40 })
  assert.deepEqual(calls, ['open'])
  tree.props.onClick({ target: testDialog, currentTarget: testDialog, clientX: 10, clientY: 10 })
  tree.props.onCancel({ preventDefault: () => calls.push('prevent') })
  h.unmount()
  assert.deepEqual(calls, ['open', 'dismiss', 'prevent', 'dismiss', 'close', 'focus'])
  assert.equal(testDocument.documentElement.style.overflow, 'auto')
})

test('协调首群按稳定顺序初始化，异步不读全部，空群与失效选择明确处理', async () => {
  const props = { groups: [], groupsReady: false }
  const h = harness('CoordinationBrowser', props)
  let tree = h.render()
  assert.equal(h.requests.length, 0); assert.match(text(tree), /正在读取群聊/)
  tree = h.render({ groupsReady: true, groups: [{ groupId: '' }, { groupId: 'b', name: '首群' }, { groupId: 'a' }, { groupId: 'b', name: '重复群' }] })
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].url, /groupId=b/)
  h.requests[0].resolve({ works: [], total: 0 }); await settle(); tree = h.render()
  assert.match(text(tree), /暂无协调工作/)
  const filter = elements(tree).find(item => item.props.label === '筛选协调群组')
  assert.equal(filter.props.value, 'b'); assert.equal(filter.props.options.length, 3)
  filter.props.onChange('a'); h.render()
  assert.match(h.requests[1].url, /groupId=a/)
  h.requests[0].resolve({ works: [{ id: 'late', title: '迟到旧群' }], total: 1 }); await settle()
  tree = h.render({ groupsReady: true, groups: [{ groupId: 'b' }, { groupId: 'a' }] })
  assert.equal(elements(tree).find(item => item.props.label === '筛选协调群组').props.value, 'a')
  assert.doesNotMatch(text(tree), /迟到旧群/)
  tree = h.render({ groupsReady: true, groups: [{ groupId: 'b' }] })
  assert.equal(h.requests[1].options.signal.aborted, true)
  assert.equal(elements(tree).find(item => item.props.label === '筛选协调群组').props.value, 'b')
  assert.match(h.requests.at(-1).url, /groupId=b/)
  tree = h.render({ groupsReady: true, groups: [] })
  assert.match(text(tree), /暂无可选群聊/)
  assert.equal([...h.intervals.values()].length, 0)
  assert.equal(h.requests.every(req => /groupId=/.test(req.url)), true)
  h.unmount()
})

test('协调手选与显式全部在重排刷新后保持，失效返回目标不读旧详情', async () => {
  const groups = [{ groupId: 'a' }, { groupId: 'b' }]
  const h = harness('CoordinationBrowser', { groups, target: { groupId: 'removed', workId: 'secret', offset: 30 } })
  let tree = h.render()
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].url, /offset=0&limit=10&groupId=a/)
  assert.equal(h.requests.some(req => req.url.includes('secret')), false)
  elements(tree).find(item => item.props.label === '筛选协调群组').props.onChange('b'); tree = h.render()
  h.requests.at(-1).resolve({ works: [], total: 0 }); await settle(); tree = h.render()
  button(tree, '刷新协调记录').props.onClick(); tree = h.render({ groups: [...groups].reverse() })
  assert.match(h.requests.at(-1).url, /groupId=b/)
  elements(tree).find(item => item.props.label === '筛选协调群组').props.onChange(''); tree = h.render()
  assert.doesNotMatch(h.requests.at(-1).url, /groupId=/)
  tree = h.render({ groups }); assert.equal(elements(tree).find(item => item.props.label === '筛选协调群组').props.value, '')
  h.unmount()
})

test('协调单次active空nextDue且作业完成仍突出提醒发送失败，输入变更只在历史', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }], target: { groupId: 'g', workId: 'schedule:s' } })
  h.render()
  const work = workFixture('schedule:s', { title: '真实定时提醒' })
  h.requests[0].resolve({ works: [work], total: 1 })
  h.requests[1].resolve(detailFixture(work, { history: { sources: [{ id: 'create', original: '原始长文本', state: 'accepted' }, { id: 'change', original: '修改时间', state: 'accepted' }], changes: [{ action: 'reschedule', revision: 2 }], occurrences: [{ occurrenceId: 'o', actionState: 'succeeded', deliveryState: 'failed' }], jobs: [{ jobId: 'j', state: 'completed' }] } })); await settle()
  const tree = h.render(), words = text(tree), article = elements(tree).find(item => item.type === 'article')
  assert.equal(elements(tree).filter(item => item.props['data-work-id']).length, 1)
  assert.equal(elements(article).filter(item => item.props['data-work-result']).length, 1)
  assert.equal(text(elements(article).find(item => item.props['data-work-result'])).trim(), '提醒发送失败')
  assert.match(words, /计划：单次计划已启用/); assert.match(words, /下次触发：无后续触发安排/); assert.match(words, /重试：无重试安排/)
  assert.doesNotMatch(words, /下次触发：未记录|进行中/)
  assert.equal(elements(tree).some(item => item.type === 'h3' && text(item) === '任务调度'), false)
  const history = elements(tree).find(item => item.type === 'details' && text(item.children[0]) === '输入与变更历史')
  assert.ok(history); assert.equal(history.props.open, undefined); assert.match(text(history), /原始长文本/); assert.match(text(history), /修改时间/)
  const visibleWords = node => node?.type === 'details' ? text(node.children[0]) : node && typeof node === 'object' ? (node.children || []).map(visibleWords).join('\n') : String(node ?? '')
  assert.doesNotMatch(visibleWords(article), /已完成|已接纳|已执行|修改时间/)
  h.unmount()
})

test('协调全部群同文实体仍显示归属，历史结论不冒充下一动作', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'a', name: '甲群' }, { groupId: 'b', name: '乙群' }], target: { groupId: '' } })
  h.render(); h.requests[0].resolve({ works: [workFixture('a', { groupId: 'a', title: '同文' }), workFixture('b', { groupId: 'b', title: '同文' })], total: 2 }); await settle()
  let tree = h.render()
  const rows = elements(tree).filter(item => item.props['data-work-id'])
  assert.match(text(rows[0]), /甲群/); assert.match(text(rows[1]), /乙群/)
  rows[1].props.onClick(); h.render()
  h.requests[1].resolve(detailFixture(workFixture('b', { kind: 'dispatch', groupId: 'b', result: { code: 'waiting_completion', label: '等待任务完成', tone: 'warning' } }), { members: [{ instructionId: 'i', taskId: 't', state: 'applied', decision: { action: 'complete', summary: '历史完成结论' } }] })); await settle()
  tree = h.render(); assert.match(text(tree), /所属群聊：乙群/)
  assert.match(text(tree), /下一动作：未记录下一动作/)
  assert.doesNotMatch(text(tree), /下一动作：.*历史完成结论/)
  assert.match(text(tree), /任务最近记录的结论（complete）：历史完成结论/)
  h.unmount()
})

test('协调主结果只消费后端投影，未知状态不推导成功且周期下次与重试分层', async () => {
  for (const result of [
    { code: 'delivery_pending', label: '等待发送提醒', tone: 'warning' },
    { code: 'delivery_unknown', label: '提醒送达未确认', tone: 'warning' },
    { code: 'delivered', label: '提醒已送达', tone: 'success' },
    { code: 'dispatch_applied', label: '任务已调度', tone: 'warning' },
    { code: 'dispatch_fulfilled', label: '任务调度已完成', tone: 'success' },
    { code: 'future_raw_state' },
  ]) {
    const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }] })
    h.render(); h.requests[0].resolve({ works: [workFixture(result.code, { result })], total: 1 }); await settle()
    const tree = h.render(), row = elements(tree).find(item => item.props['data-work-id'])
    assert.equal(elements(row).filter(item => item.props['data-work-result']).length, 1)
    assert.match(text(row), new RegExp(result.label || '状态未确认'))
    h.unmount()
  }
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }], target: { groupId: 'g', workId: 'recurring' } })
  h.render(); h.requests[1].resolve(detailFixture(workFixture('recurring', { result: { code: 'failed', label: '最近提醒发送失败', tone: 'danger' }, plan: { label: '周期计划已启用', rule: { kind: 'daily', time: '09:00' } }, nextStep: { label: '等待下次触发', triggerAt: '2026-10-26T01:00:00Z', sendRetryAt: '2026-10-25T02:00:00Z', readbackAt: null } }))); await settle()
  const words = text(h.render())
  assert.match(words, /最近提醒发送失败/); assert.match(words, /周期计划已启用/); assert.match(words, /每日 09:00/)
  assert.doesNotMatch(words, /下次触发：无后续触发安排|重试：无重试安排/)
  h.unmount()
})


test('协调当前与历史proof独立折叠，计划修订展示历史状态周期与下次事实', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }], target: { groupId: 'g', workId: 'dispatch:proof' } })
  h.render(); h.requests[1].resolve(detailFixture(workFixture('dispatch:proof', { kind: 'dispatch', result: { code: 'partially_completed', label: '部分任务已正式完成', tone: 'info' } }), {
    members: [
      { instructionId: 'current', taskId: 'current', title: '当前完成任务', state: 'fulfilled', completionProofCurrent: true, completionProof: { eventId: 'current-event', commandId: 'current-command' } },
      { instructionId: 'old', taskId: 'old', title: '版本变化任务', state: 'version_changed', completionProofCurrent: false, completionProof: null, historicalCompletionProof: { eventId: 'old-event', commandId: 'old-command' } },
    ], history: { sources: [], changes: [{ action: 'schedule-revision', revision: 1, state: 'paused', timezone: 'Asia/Shanghai', rule: { kind: 'daily', time: '09:30' }, nextDueAt: null }], occurrences: [], jobs: [] },
  })); await settle()
  const tree = h.render(), words = text(tree)
  assert.match(words, /当前指令已有正式完成证明/); assert.match(words, /历史完成证明引用（不证明当前指令完成）/)
  assert.equal(elements(tree).filter(item => item.type === 'summary' && text(item) === '正式完成证明引用').length, 1)
  for (const label of ['正式完成证明引用', '历史完成证明引用（不证明当前指令完成）']) {
    const node = elements(tree).find(item => item.type === 'details' && text(item.children[0]) === label)
    assert.equal(node.props.open, undefined)
  }
  const history = elements(tree).find(item => item.type === 'details' && text(item.children[0]) === '输入与变更历史')
  assert.match(text(history), /计划修订/); assert.match(text(history), /历史计划状态：已暂停/); assert.match(text(history), /历史周期：每日 09:30/); assert.match(text(history), /历史下次触发：无后续触发安排/)
  h.unmount()
})

test('协调实体分页收缩回有效页并清理选中，轮询与卸载不泄漏请求', async () => {
  const h = harness('CoordinationBrowser', { groups: [{ groupId: 'g' }], target: { groupId: 'g', offset: 20, workId: 'schedule:old' } })
  h.render(); h.requests[0].resolve({ works: [], total: 11 }); await settle(); h.render(); h.render()
  assert.match(h.requests.at(-1).url, /offset=10&limit=10&groupId=g/)
  assert.equal(h.requests[1].options.signal.aborted, true)
  const before = h.requests.length
  h.unmount(); assert.equal(h.intervals.size, 0)
  assert.equal(h.requests.every(request => request.options.signal.aborted), true)
  h.requests[1].reject(new Error('aborted')); h.requests.at(-1).reject(new Error('aborted')); await settle()
  assert.equal(h.timeouts.size, 0); assert.equal(h.requests.length, before)
})
