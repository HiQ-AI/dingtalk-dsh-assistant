import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
const elements = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(elements)] : []
const text = tree => tree == null ? '' : typeof tree === 'object' ? (tree.children || []).map(text).join('\n') : String(tree)
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(componentName, initialProps = {}) {
  const states = [], effects = [], scheduled = [], requests = [], events = []
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
    AbortController, URL, console, crypto: { randomUUID: () => `request-${++uuid}` },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve: value => resolve({ ok: true, json: async () => value }), reject })) },
    window: { addEventListener: (...args) => events.push(['add', ...args]), removeEventListener: (...args) => events.push(['remove', ...args]),
      __ModuleLoader__: { load: ({ factory }) => { component = factory(name => name === 'react' ? React : { Button: 'button', StateDot: 'dot' }).testComponent } } },
  })
  return { requests, events,
    render(next = props) { props = next; cursor = 0; const tree = component(props); if (props.testDialog && tree.props?.ref) tree.props.ref.current = props.testDialog; scheduled.splice(0).forEach(effect => effect()); return tree },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}
const button = (tree, label) => elements(tree).find(item => item.type === 'button' && text(item) === label)
const input = (tree, label) => elements(tree).find(item => item.type === 'label' && item.children[0] === label)?.children.find(item => typeof item === 'object')

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
  assert.match(text(tree), /成果说明/)
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
