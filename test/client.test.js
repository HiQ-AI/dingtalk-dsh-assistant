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

test('设置页异步展示版本状态且版本检查不阻塞核心配置加载', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/client.js', import.meta.url), 'utf8')
  assert.match(source, /setOverview\(next\); request\('\/state\/version'\)\.then/u)
  assert.match(source, /版本与更新/u)
  assert.match(source, /新版本检查失败/u)
  assert.match(source, /发现新版本/u)
  assert.match(source, /查看 CHANGELOG/u)
})

test('添加常驻群在操作位置反馈前置条件、进度和请求结果', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/client.js', import.meta.url), 'utf8')
  assert.match(source, /请先从搜索结果中选择要常驻的群聊/u)
  assert.match(source, /请填写该群的会话职责后再添加/u)
  assert.match(source, /正在创建常驻会话/u)
  assert.match(source, /添加失败：/u)
  assert.match(source, /常驻群已添加，会话已开始运行/u)
  assert.doesNotMatch(source, /disabled: !newGroup\.groupId\.trim\(\) \|\| !newGroup\.responsibility\.trim\(\)/u)
})
