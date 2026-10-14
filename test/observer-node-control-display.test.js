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
    AbortController, URL, console, crypto: { randomUUID: () => `request-${++uuid}` },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve: value => resolve({ ok: true, json: async () => value }), reject })) },
    window: { addEventListener: (...args) => events.push(['add', ...args]), removeEventListener: (...args) => events.push(['remove', ...args]),
      __ModuleLoader__: { load: ({ factory }) => { component = factory(name => name === 'react' ? React : { Button: 'button', StateDot: 'dot' }).testComponent } } },
  })
  return { requests, events,
    render(next = props) { props = next; cursor = 0; const tree = component(props); scheduled.splice(0).forEach(effect => effect()); return tree },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}
const button = (tree, label) => elements(tree).find(item => item.type === 'button' && text(item) === label)
const input = (tree, label) => elements(tree).find(item => item.type === 'label' && item.children[0] === label)?.children.find(item => typeof item === 'object')

test('任务详情只有一个任务会话入口，动态执行与结果拥有独立数据', () => {
  const task = { taskId: 't', title: '核对服务', objective: '按实际情况核对', state: 'running', requirementRevision: 2, controlRevision: 3, controlState: 'active', session: { sessionId: 'task-session', workspaceDir: '/task', logPath: '/task/log' }, result: { summary: '进行中', evidence: ['proof'], limitations: ['尚未完成'] } }
  const h = harness('TaskSessionDetail', { task, onOpenSession() {}, onChanged() {}, onBack() {} })
  const tree = h.render(), children = elements(tree)
  assert.equal(children.filter(item => item.props.label === '任务会话').length, 1)
  assert.equal(children.find(item => item.props.label === '任务会话').props.session.sessionId, 'task-session')
  assert.ok(children.some(item => item.props.taskId === 't'))
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

test('新建任务校验字段，重复提交仅一次，失败保留草稿和幂等键', async () => {
  const created = [], dirty = [], h = harness('CreateTaskForm', { groups: [{ groupId: 'g', name: '测试群' }], onCreated: value => created.push(value), onCancel() {}, onDirtyChange: value => dirty.push(value) })
  let tree = h.render(), form = tree
  await form.props.onSubmit({ preventDefault() {} })
  tree = h.render(); assert.equal(h.requests.length, 0); assert.ok(elements(tree).some(item => item.props.role === 'alert'))
  assert.equal(input(tree, '任务名称').props['aria-invalid'], true)
  for (const [label, value] of [['来源群', 'g'], ['任务名称', '检查服务'], ['任务目标', '核对状态'], ['验收要求（每行一项，可选）', '可读取\n状态准确']]) { input(tree, label).props.onChange({ target: { value } }); tree = h.render() }
  const submit = tree.props.onSubmit({ preventDefault() {} }); tree.props.onSubmit({ preventDefault() {} })
  assert.equal(h.requests.length, 1)
  const firstBody = JSON.parse(h.requests[0].options.body)
  assert.deepEqual(firstBody.acceptanceCriteria, ['可读取', '状态准确'])
  assert.equal('workflowId' in firstBody, false)
  h.requests[0].reject(Error('temporary network failure')); await submit
  tree = h.render(); assert.equal(input(tree, '任务目标').props.value, '核对状态')
  const retry = tree.props.onSubmit({ preventDefault() {} })
  assert.equal(JSON.parse(h.requests[1].options.body).requestId, firstBody.requestId)
  h.requests[1].resolve({ taskId: 'created' }); await retry
  assert.deepEqual(created, [{ taskId: 'created' }]); assert.equal(dirty.at(-1), false)
})

test('新建任务取消保护草稿，继续填写保留内容，IME不提前提交', async () => {
  let cancelled = 0
  const h = harness('CreateTaskForm', { groups: [], onCreated() {}, onCancel: () => cancelled++ })
  let tree = h.render(); input(tree, '任务名称').props.onChange({ target: { value: '未提交任务' } }); tree = h.render()
  await tree.props.onSubmit({ preventDefault() {}, nativeEvent: { isComposing: true } }); assert.equal(h.requests.length, 0)
  button(tree, '返回看板').props.onClick(); tree = h.render(); assert.equal(cancelled, 0)
  button(tree, '继续填写').props.onClick(); tree = h.render(); assert.equal(input(tree, '任务名称').props.value, '未提交任务')
  button(tree, '返回看板').props.onClick(); tree = h.render(); button(tree, '放弃草稿并返回').props.onClick(); assert.equal(cancelled, 1)
  assert.ok(h.events.some(([kind, event]) => kind === 'add' && event === 'beforeunload'))
})

test('任务详情移除需求与控制区，同时保留会话、结果、执行及独立新建入口', () => {
  const task = { taskId: 't', title: '核对', state: 'running', objective: '核对当前服务' }
  const h = harness('TaskSessionDetail', { task, onBack() {}, onOpenSession() {} })
  const tree = h.render(), children = elements(tree)
  assert.equal(children.filter(item => item.props.label === '任务会话').length, 1)
  assert.ok(children.some(item => item.props.taskId === 't'))
  assert.ok(button(tree, '返回看板'))
  assert.equal(children.some(item => ['textarea', 'input', 'form'].includes(item.type)), false)
  assert.equal(h.requests.length, 0)
  assert.doesNotMatch(source, /TaskControls|需求与控制|提交需求补充|确认取消任务|补充需求/)
  const create = harness('CreateTaskForm', { groups: [], onCreated() {}, onCancel() {} }).render()
  assert.ok(input(create, '任务目标'))
  assert.ok(button(create, '创建任务'))
})

test('动态执行分页的失败可重试，离开后慢响应不能覆盖新查询', async () => {
  const h = harness('TaskExecutions', { taskId: 't', updatedAt: 1, onOpenSession() {} })
  h.render(); assert.match(h.requests[0].url, /executions\?offset=0&limit=20/)
  h.requests[0].resolve({ executions: [{ executionId: 'e1', objective: '检查依赖', status: 'running' }], total: 21 }); await settle()
  let tree = h.render(); assert.match(text(tree), /检查依赖/)
  button(tree, '下一页').props.onClick(); h.render(); assert.match(h.requests[1].url, /offset=20/)
  h.requests[1].reject(Error('offline')); await settle(); tree = h.render(); assert.ok(button(tree, '重试读取执行'))
  button(tree, '重试读取执行').props.onClick(); h.render(); assert.equal(h.requests.length, 3)
  h.requests[2].resolve({ executions: [{ executionId: 'e21', objective: '读取日志', status: 'succeeded' }], total: 21 }); await settle()
  tree = h.render(); assert.match(text(tree), /读取日志/)
  assert.equal(button(tree, '下一页').props.disabled, true)
  h.render({ taskId: 't', updatedAt: 2, onOpenSession() {} }); h.unmount()
  h.requests[3].resolve({ executions: [{ executionId: 'stale', objective: '过期' }], total: 1 }); await settle()
  assert.doesNotMatch(text(h.render()), /过期/)
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
