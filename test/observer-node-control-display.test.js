import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = (await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const mappingCode = source.slice(source.indexOf('    const taskStepControl ='), source.indexOf('    const taskDisplayTitle ='))
const control = runInNewContext(`${mappingCode}; taskStepControl`)
const progressCode = source.slice(source.indexOf('      const taskNodes ='), source.indexOf('      const taskTone ='))
const progress = task => runInNewContext(`${progressCode}; ({ completedSteps, skippedSteps, stepsResolved, stepProgress, stepProgressText })`, { selectedWorkflowTask: task })
const stateCode = source.match(/      const nodeState = (\{[^\n]+\})/)[1]
const states = runInNewContext(`(${stateCode})`)
const reasonCode = source.slice(source.indexOf('    const traceReason ='), source.indexOf('    const readableValue ='))
const traceReason = runInNewContext(`${reasonCode}; traceReason`)
const rowCode = source.slice(source.indexOf('            const presentation = taskStepControl(node)'), source.indexOf('          }))))),', source.indexOf('            const presentation = taskStepControl(node)')))
const children = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(children)] : []
const text = tree => tree === null || tree === undefined ? '' : typeof tree === 'object' ? (tree.children || []).map(text).join('\n') : String(tree)
const navigation = []
const render = node => runInNewContext(`(() => { ${rowCode} })()`, {
  node, index: 0, taskStepControl: control, nodeState: states, nodeTitle: {},
  colors: { surface: 'surface', muted: 'muted', warning: 'warning', accent: 'accent' },
  stepColor: status => status === 'succeeded' ? 'success' : status,
  React: { createElement: (type, props, ...items) => ({ type, props: props || {}, children: items.flat() }) },
  TaskStepElapsed: 'existing-elapsed', TaskStepOutput: 'existing-output',
  selectedWorkflowTask: { taskId: 'task', detailRevision: 'current' }, traceReason,
  taskStepStart: () => '开始时间未记录', fmt: value => value,
  navigate: id => navigation.push(id),
})
const base = { stepKey: 'task:stage:workflow:node', nodeRunId: 'node', nodeId: 'apply-changes', status: 'succeeded' }

test('完成方式取自现有control，接管、复用和跳过不能混为新执行成功', () => {
  for (const [action, label] of [['submit-output', '会话接管完成'], ['reuse', '已复用产出'], ['skip', '不适用 · 已跳过']]) {
    const node = Object.freeze({ ...base, control: Object.freeze({ action, reason: '仅处理当前节点', source: 'task-session' }) })
    const result = control(node)
    assert.equal(result.label, label)
    assert.equal(result.skipped, action === 'skip')
    assert.match(text(render(node)), new RegExp(label.replace(' · ', '.*')))
    const row = render(node)
    assert.equal(row.props['data-step-key'], base.stepKey)
    assert.equal(children(row).find(item => item.children.includes(label)).props.style.color, action === 'skip' ? 'skipped' : 'success')
  }
})

test('运行、失败、阻塞和取消优先于旧control完成记录', () => {
  for (const status of ['running', 'waiting', 'failed', 'blocked', 'cancelled', 'ready', 'pending']) {
    for (const action of ['skip', 'reuse', 'submit-output']) {
      const node = { ...base, status, control: { action, reason: '先前操作原因' }, waitReason: { reference: '当前实际原因' } }
      assert.equal(control(node).label, undefined)
      assert.equal(control(node).skipped, false)
      const row = text(render(node))
      assert.ok(row.includes(states[status]), `${status}/${action} preserves real status`)
      assert.ok(row.includes('当前实际原因'))
      assert.doesNotMatch(row, /会话接管完成|已复用产出|不适用 · 已跳过/)
    }
  }
  assert.equal(control({ ...base, definitionPending: true, control: { action: 'skip' } }).label, undefined)
})

test('接管等待明确尚未提交，保留实际等待原因及操作来源', () => {
  const node = { ...base, status: 'waiting', control: { action: 'takeover', reason: ' 自动执行受阻\n由原会话纠正 ', source: 'task-session' }, waitReason: { reference: 'controller_timeout' } }
  const row = text(render(node))
  assert.match(row, /会话接管中 · 等待提交/)
  assert.match(row, /controller_timeout/)
  assert.match(row, /操作原因（原任务会话）：自动执行受阻\n由原会话纠正/)
  assert.doesNotMatch(row, /接管完成/)
  assert.match(text(render({ ...node, control: { ...node.control, source: 'operator' } })), /操作原因（维护操作）/)
})

test('无control、未知操作及不完整旧记录保留原状态，不猜完成方式或伪造产物', () => {
  for (const value of [undefined, null, {}, { action: 'future-action', reason: '未知操作' }, { action: 'toString' }, { action: 'constructor' }]) {
    const node = { ...base, control: value }
    assert.equal(control(node).label, undefined)
    assert.equal(control(node).reason, '')
    assert.ok(text(render(node)).includes('已完成'))
    assert.doesNotMatch(text(render(node)), /接管完成|已复用产出|不适用/)
    assert.ok(children(render(node)).some(item => item.children.includes('暂未记录产出')))
  }
  for (const reason of [null, undefined, {}, 123, '  ']) assert.equal(control({ ...base, control: { action: 'reuse', reason } }).reason, '')
  assert.equal(control({ status: 'skipped' }).skipped, true)
  const legacy = progress({ executionNodes: [{ status: 'skipped' }] })
  assert.equal(legacy.skippedSteps, 0)
  assert.equal(legacy.stepProgress, 0)
})

test('跳过单列为已处理，完整进度不能声称全部执行成功', () => {
  const nodes = [base, { ...base, control: { action: 'reuse' } }, { ...base, control: { action: 'skip' } }]
  const result = progress({ executionNodes: nodes })
  assert.equal(result.completedSteps, 2)
  assert.equal(result.skippedSteps, 1)
  assert.equal(result.stepProgress, 100)
  assert.equal(result.stepProgressText, '步骤处理 100%')
  const blocked = progress({ executionNodes: [{ ...base, status: 'blocked', control: { action: 'skip' } }] })
  assert.equal(blocked.completedSteps, 0)
  assert.equal(blocked.skippedSteps, 0)
  assert.equal(blocked.stepProgress, 0)
  const pending = progress({ plan: { stepsResolved: false }, executionNodes: [nodes[2]] })
  assert.equal(pending.stepProgress, 99)
  assert.equal(pending.stepProgressText, '步骤待确定')
  const undefinedStep = progress({ executionNodes: [{ ...nodes[2], definitionPending: true }] })
  assert.equal(undefinedStep.skippedSteps, 0)
  assert.equal(undefinedStep.stepProgress, 0)
})

test('状态展示保持已有产出绑定和键盘会话入口，不增加控制请求', () => {
  const node = { ...base, outputRef: 'accepted-output', sessionId: 'original-session', control: { action: 'reuse', reason: '沿用有效成果' } }
  const tree = render(node)
  const output = children(tree).find(item => item.type === 'existing-output')
  assert.equal(output.props.node, node)
  assert.equal(output.props.taskId, 'task')
  assert.equal(output.props.detailRevision, 'current')
  const button = children(tree).find(item => item.type === 'button' && item.children.includes('查看会话记录'))
  assert.equal(button.props.type, 'button')
  button.props.onClick()
  assert.equal(navigation.at(-1), 'original-session')
  assert.doesNotMatch(mappingCode + rowCode, /fetch\(|post\(|\/node-control|confirm\(|alert\(/)
})

test('整个Observer模块可加载，最小展示未加入新计时算法', () => {
  let module
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: options => { module = options.factory(name => name === 'react' ? {} : {}) } } },
  })
  assert.equal(module.name, 'dingtalk-dsh-observer-client')
  assert.equal(typeof module.apply, 'function')
  assert.doesNotMatch(mappingCode + progressCode + rowCode, /waitingMs|waitingElapsedMs|sampledAt|new Date\(control|Date\.parse\(control/)
  assert.match(rowCode, /React\.createElement\(TaskStepElapsed, \{ node \}\)/)
})
