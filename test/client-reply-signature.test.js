import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url), 'utf8')
const elements = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(elements)] : []
const text = tree => tree == null ? '' : typeof tree === 'object' ? (tree.children || []).map(text).join('') : String(tree)
const settle = () => new Promise(resolve => setImmediate(resolve))

// Exercise the shipped bundle's state and callbacks; this is not a browser/DSH deployment test.
function harness() {
  const states = [], effects = [], scheduled = [], writes = []
  let cursor = 0, component, config = { agentNames: ['资料助理'], model: 'fixture', workspaceDir: '/fixture' }, failSave = false
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => value === b[index])
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useCallback(fn, deps) { const index = cursor++; if (!same(states[index]?.deps, deps)) states[index] = { fn, deps }; return states[index].fn },
    useEffect(fn, deps) { const index = cursor++; if (!same(effects[index], deps)) { effects[index] = deps; scheduled.push(fn) } },
  }
  runInNewContext(source, {
    async fetch(url, options) {
      const path = new URL(url).pathname
      if (path === '/config/agent') {
        writes.push(JSON.parse(options.body))
        if (failSave) return { ok: false, json: async () => ({ error: '模拟保存失败' }) }
        config = { ...config, ...writes.at(-1) }
      }
      const value = path === '/state/agent-config' || path === '/config/agent' ? config
        : ['/state/groups', '/state/tasks', '/state/supervisor/alerts'].includes(path) ? [] : {}
      return { ok: true, json: async () => structuredClone(value) }
    },
    window: { __ModuleLoader__: { load: ({ factory }) => { component = factory(() => React).DingTalkDshAssistantCard } } },
  })
  return { writes, setConfig: value => { config = value }, failSave: value => { failSave = value },
    render() { cursor = 0; const tree = component(); scheduled.splice(0).forEach(effect => effect()); return tree },
  }
}
const field = tree => elements(tree).find(item => item.props['aria-label'] === 'Agent 群回复署名')
const button = (tree, label) => elements(tree).find(item => item.type === 'button' && text(item) === label)

test('设置页移除署名入口，普通配置仍可保存且失败保留草稿', async () => {
  const h = harness()
  h.render(); await settle()
  let tree = h.render()
  assert.equal(field(tree), undefined)
  assert.equal(button(tree, '保存配置').props.disabled, true)
  const names = () => elements(tree).find(item => item.props['aria-label'] === 'Agent 名称和别名')
  names().props.onChange({ target: { value: '新助理' } })
  tree = h.render()
  await button(tree, '保存配置').props.onClick()
  tree = h.render()
  assert.equal(h.writes.at(-1).agentNames.join(','), '新助理')
  assert.equal(Object.hasOwn(h.writes.at(-1), 'replySignature'), false)
  assert.equal(button(tree, '保存配置').props.disabled, true)
  h.setConfig({ agentNames: ['Ada'], replySignature: '旧全局代回', model: 'fixture', workspaceDir: '/fixture' })
  await button(tree, '刷新').props.onClick()
  tree = h.render()
  assert.equal(field(tree), undefined)
  assert.equal(names().props.value, 'Ada')
  h.failSave(true)
  names().props.onChange({ target: { value: '保留草稿' } })
  await button(h.render(), '保存配置').props.onClick()
  tree = h.render()
  assert.equal(names().props.value, '保留草稿')
  assert.match(text(tree), /模拟保存失败/u)
  assert.equal(button(tree, '保存配置').props.disabled, false)
})
