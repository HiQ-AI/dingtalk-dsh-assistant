import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, name } from '../packages/dingtalk-group-assistant/client.js'

test('Web client使用dsh原生插件页签slot注册唯一状态卡', () => {
  let slotName, registration, component
  const ctx = { slots: {
    inject(name, callback) { slotName = name; callback() },
    register(value, view) { registration = value; component = view; return () => undefined },
  } }
  apply(ctx)
  assert.equal(name, 'dingtalk-group-assistant-client')
  assert.equal(slotName, 'settings.plugins.tab')
  assert.equal(registration.id, 'dingtalk-group-assistant')
  assert.equal(registration.label(), '钉钉群聊个人助理')
  assert.equal(typeof component, 'function')
})

test('Web bundle patch只挂载无副作用host face，不启动第二份resident Runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/dingtalk-group-assistant/package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../packages/dingtalk-group-assistant/cordis.patch.yml', import.meta.url), 'utf8')
  const bundle = await readFile(new URL('../packages/dingtalk-group-assistant/web-client.js', import.meta.url), 'utf8')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'], './web-client.js')
  assert.match(patch, /id: dingtalk-group-assistant-web/)
  assert.match(patch, /name: '@baibu-agent\/dingtalk-group-assistant'/)
  assert.match(bundle, /const inject = \['slots'\]/)
})
