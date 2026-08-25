import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, name } from '../packages/dingtalk-dsh-assistant/client.js'

test('Web client使用dsh原生插件页签slot注册唯一状态卡', () => {
  let slotName, registration, component
  const ctx = { slots: {
    inject(name, callback) { slotName = name; callback() },
    register(value, view) { registration = value; component = view; return () => undefined },
  } }
  apply(ctx)
  assert.equal(name, 'dingtalk-dsh-assistant-client')
  assert.equal(slotName, 'settings.plugins.tab')
  assert.equal(registration.id, 'dingtalk-dsh-assistant')
  assert.equal(registration.label(), '钉钉个人助理')
  assert.equal(typeof component, 'function')
})

test('Web bundle patch只挂载无副作用host face，不启动第二份resident Runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/dingtalk-dsh-assistant/package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../packages/dingtalk-dsh-assistant/cordis.patch.yml', import.meta.url), 'utf8')
  const bundle = await readFile(new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url), 'utf8')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'], './web-client.js')
  assert.match(patch, /id: dingtalk-dsh-assistant-web/)
  assert.match(patch, /name: '@zzusp\/dingtalk-dsh-assistant'/)
  assert.match(bundle, /const inject = \['slots'\]/)
})
