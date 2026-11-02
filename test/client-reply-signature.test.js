import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url), 'utf8')
const elements = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(elements)] : []
const text = tree => tree == null ? '' : typeof tree === 'object' ? (tree.children || []).map(text).join('') : String(tree)
const settle = () => new Promise(resolve => setImmediate(resolve))

// Exercise the shipped bundle's state and callbacks; this is not a browser/DSH deployment test.
function harness({ fetchOverride, bundle = source } = {}) {
  const states = [], effects = [], scheduled = [], timers = [], writes = []
  let cursor = 0, component, config = { agentNames: ['资料助理'], model: 'fixture', workspaceDir: '/fixture' }, failSave = false
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => value === b[index])
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useCallback(fn, deps) { const index = cursor++; if (!same(states[index]?.deps, deps)) states[index] = { fn, deps }; return states[index].fn },
    useEffect(fn, deps) { const index = cursor++; if (!same(effects[index], deps)) { effects[index] = deps; scheduled.push(fn) } },
  }
  runInNewContext(bundle, {
    setInterval: () => 0, clearInterval() {},
    setTimeout: callback => { const timer = { callback }; timers.push(timer); return timer },
    clearTimeout: timer => { timer.cancelled = true },
    async fetch(url, options) {
      const path = new URL(url).pathname
      if (fetchOverride) { const response = fetchOverride(url, options); if (response) return response }
      if (path === '/config/agent') {
        writes.push(JSON.parse(options.body))
        if (failSave) return { ok: false, json: async () => ({ error: '模拟保存失败' }) }
        config = { ...config, ...writes.at(-1) }
      }
      const value = path === '/state/agent-config' || path === '/config/agent' ? config
        : path === '/state/task-model-options' ? { available: true, reasoning: { efforts: [{ id: 'low' }] } }
        : ['/state/tasks', '/state/supervisor/alerts'].includes(path) ? { total: 0, items: [] }
        : path === '/state/groups' ? [] : {}
      return { ok: true, json: async () => structuredClone(path === '/state/agent-config' || path === '/config/agent' ? { taskSessionModel: { provider: 'openai-codex', model: 'gpt-6-astra', reasoningMode: 'explicit', reasoningEffort: 'low' }, ...value } : value) }
    },
    window: { __ModuleLoader__: { load: ({ factory }) => { component = factory(() => React).DingTalkDshAssistantCard } } },
  })
  return { writes, flushTimers() { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback() }, setConfig: value => { config = value }, failSave: value => { failSave = value },
    render() { cursor = 0; const tree = component({}); scheduled.splice(0).forEach(effect => effect()); return tree },
  }
}
const field = tree => elements(tree).find(item => item.props['aria-label'] === 'Agent 群回复署名')
const button = (tree, label) => elements(tree).find(item => item.type === 'button' && text(item) === label)

test('settings bundle saves, clears and refreshes explicit personal signature while preserving failed drafts', async () => {
  const h = harness()
  h.render(); await settle(); h.flushTimers(); await settle()
  let tree = h.render()
  assert.equal(field(tree).props.value, '')
  assert.equal(button(tree, '保存配置').props.disabled, true)
  const label = elements(tree).find(item => item.props.htmlFor === field(tree).props.id)
  assert.equal(text(label), '群回复署名（可选）')
  assert.ok(elements(tree).some(item => item.props.id === field(tree).props['aria-describedby']))
  field(tree).props.onChange({ target: { value: '资料助理代回' } })
  tree = h.render()
  assert.equal(button(tree, '保存配置').props.disabled, false)
  await elements(tree).find(item => item.type === 'form').props.onSubmit()
  tree = h.render()
  assert.equal(h.writes.at(-1).replySignature, '资料助理代回')
  assert.equal(field(tree).props.value, '资料助理代回')
  assert.equal(button(tree, '保存配置').props.disabled, true)

  h.setConfig({ agentNames: ['Ada'], replySignature: 'Ada Support', model: 'fixture', workspaceDir: '/other-agent' })
  await button(tree, '刷新').props.onClick()
  tree = h.render()
  assert.equal(field(tree).props.value, 'Ada Support')
  field(tree).props.onChange({ target: { value: '' } })
  await elements(h.render()).find(item => item.type === 'form').props.onSubmit()
  assert.equal(h.writes.at(-1).replySignature, '')
  await button(h.render(), '刷新').props.onClick()
  assert.equal(field(h.render()).props.value, '')

  h.failSave(true)
  field(h.render()).props.onChange({ target: { value: 'Mira Support' } })
  await elements(h.render()).find(item => item.type === 'form').props.onSubmit()
  tree = h.render()
  assert.equal(field(tree).props.value, 'Mira Support')
  assert.match(text(tree), /保存未全部完成/u)
  assert.match(text(tree), /草稿已保留/u)
  assert.equal(button(tree, '保存配置').props.disabled, false)
  h.failSave(false)
  await elements(tree).find(item => item.type === 'form').props.onSubmit()
  assert.equal(field(h.render()).props.value, 'Mira Support')

  h.setConfig({ agentNames: ['Unconfigured'], model: 'fixture', workspaceDir: '/clean-agent' })
  await button(h.render(), '刷新').props.onClick()
  assert.equal(field(h.render()).props.value, '', 'missing config from a different Agent must not retain the previous value')
})

test('slow environment does not delay config; stats failures and stale probes stay isolated', async () => {
  const slow = [], requests = []
  const h = harness({ fetchOverride(url) {
    const u = new URL(url)
    requests.push(u.pathname + u.search)
    if (u.pathname === '/state/environment') {
      const pending = Promise.withResolvers(); slow.push(pending); return pending.promise
    }
    if (u.pathname === '/state/tasks') return Promise.resolve({ ok: false, json: async () => ({ error: 'task_stats_offline' }) })
  } })
  h.setConfig({ agentNames: ['配置已加载'], replySignature: '不等待环境检查', model: 'fixture', workspaceDir: '/fixture' })
  h.render(); await settle()
  let tree = h.render()
  assert.equal(field(tree).props.value, '不等待环境检查')
  assert.match(text(tree), /活动 Task统计失败：task_stats_offline/u)
  assert.ok(requests.includes('/state/groups?summary=true'))
  assert.ok(!requests.includes('/state/tasks'))
  assert.ok(requests.includes('/state/tasks?offset=0&limit=1&view=summary&state=running'))
  assert.ok(requests.includes('/state/tasks?offset=0&limit=1&view=summary&state=waiting'))
  await button(tree, '刷新').props.onClick()
  slow[1].resolve({ ok: false, json: async () => ({ error: 'new_probe_failed' }) })
  await settle()
  tree = h.render()
  const environment = elements(tree).find(item => typeof item.type === 'function' && item.type.name === 'Environment')
  assert.equal(environment.props.value.error, 'new_probe_failed')
  slow[0].resolve({ ok: true, json: async () => ({ dws: { installed: true } }) })
  await settle()
  assert.equal(elements(h.render()).find(item => item.type === environment.type).props.value.error, 'new_probe_failed')
  assert.equal(field(h.render()).props.value, '不等待环境检查')
})

test('settings ingress buttons send pause/resume and show recovery rather than completion', async () => {
  let ingress = { paused: false, recovering: false }
  const writes = []
  const h = harness({ fetchOverride(url, options) {
    const path = new URL(url).pathname
    if (path === '/config/message-ingress') {
      const value = JSON.parse(options.body); writes.push(value)
      ingress = { paused: value.paused, recovering: !value.paused }
      return Promise.resolve({ ok: true, json: async () => ({ ingress }) })
    }
    if (path === '/health') return Promise.resolve({ ok: true, json: async () => ({ status: 'ok', dwsBridge: { ingress } }) })
  } })
  h.render(); await settle()
  await button(h.render(), '暂停消息接入').props.onClick()
  assert.match(text(h.render()), /已暂停接入/u)
  await button(h.render(), '恢复接入并补拉').props.onClick()
  assert.match(text(h.render()), /恢复中：正在补拉暂停期间的消息/u)
  assert.deepEqual(writes, [{ paused: true }, { paused: false }])
})

test('saving config while environment is pending does not strand the probe or overwrite drafts', async () => {
  const pending = Promise.withResolvers()
  const h = harness({ fetchOverride(url) {
    if (new URL(url).pathname === '/state/environment') return pending.promise
  } })
  h.render(); await settle(); h.flushTimers(); await settle()
  field(h.render()).props.onChange({ target: { value: '保存不影响探测' } })
  await elements(h.render()).find(item => item.type === 'form').props.onSubmit()
  pending.resolve({ ok: true, json: async () => ({ dws: { installed: true } }) })
  await settle()
  const environment = elements(h.render()).find(item => typeof item.type === 'function' && item.type.name === 'Environment')
  assert.equal(environment.props.value.dws.installed, true)
  assert.equal(field(h.render()).props.value, '保存不影响探测')
})
