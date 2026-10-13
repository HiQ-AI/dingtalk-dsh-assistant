import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apply, name, readResidentOverview } from '../packages/dingtalk-dsh-assistant/client.js'

test('Web client使用dsh原生插件页签slot注册唯一状态卡', () => {
  const registrations = []
  const ctx = { slots: {
    inject(name, callback) { callback() },
    register(value, view) { registrations.push({ value, view }); return () => undefined },
  } }
  apply(ctx)
  const tab = registrations.find(({ value }) => value.name === 'settings.plugins.tab')
  assert.equal(name, 'dingtalk-dsh-assistant-client')
  assert.equal(tab.value.id, 'dingtalk-dsh-assistant')
  assert.equal(tab.value.label(), '钉钉个人助理')
  assert.equal(typeof tab.view, 'function')
  assert.equal(registrations.length, 1)
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
  assert.match(source, /可更新/u)
  for (const file of ['client.js', 'web-client.js']) {
    const ui = await readFile(new URL(`../packages/dingtalk-dsh-assistant/${file}`, import.meta.url), 'utf8')
    assert.match(ui, /升级提示词/u)
    assert.match(ui, /当前安装形态、目标正式版本和在途任务/u)
    assert.match(ui, /维护排空、安全停机与备份/u)
    assert.match(ui, /'复制提示词'/u)
    assert.doesNotMatch(ui, /UPDATE_COMMAND|@latest @zzusp\/dingtalk-dsh-observer@latest/u)
  }
  assert.doesNotMatch(source, /dingtalkPluginUpdate/u)
  assert.doesNotMatch(source, /sidebar\.footer\.action/u)
  assert.doesNotMatch(source, /IconDownloadOutline16/u)
  assert.match(source, /IconRefreshOutline16/u)
  assert.match(source, /检查更新/u)
  assert.doesNotMatch(source, />↑</u)
  assert.match(source, /查看 CHANGELOG/u)
})

test('设置页指向运行看板工作流，保留未迁移群的旧配置和保存合同', async () => {
  for (const file of ['client.js', 'web-client.js']) {
    const source = await readFile(new URL(`../packages/dingtalk-dsh-assistant/${file}`, import.meta.url), 'utf8')
    assert.match(source, /\/state\/workflows\/catalog/u)
    assert.doesNotMatch(source, /WorkflowCatalog/u)
    assert.match(source, /运行看板 → 工作流/u)
    assert.match(source, /new Set\(overview\?\.workflows\?\.groupIds \?\? \[\]\)/u)
    assert.match(source, /legacyGroups\.length \? React\.createElement\('details'/u)
    assert.match(source, /legacyGroups\.length \? \{ leafSessionPrompt, taskPrompts, taskPromptsVersion: overview\?\.agentConfig\?\.taskPromptsVersion \?\? 0, maxConcurrentTasks \} : \{\}/u)
    assert.match(source, /TaskPromptEditor/u)
    assert.match(source, /旧版叶子任务配置/u)
    assert.match(source, /任务流程/u)
    assert.doesNotMatch(source, /'aria-label': '任务流程引导'/u)
    assert.doesNotMatch(source, /'aria-label': '完成证据要求'/u)
    assert.doesNotMatch(source, /taskGuidance/u)
  }
})

test('设置页读取目录群归属以区分旧配置，不加载完整工作流运行状态', async (t) => {
  const paths = []
  const catalog = { engine: 'workflow-v2', groupIds: ['workflow-group'], workflows: [] }
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname
    paths.push(path)
    return { ok: true, json: async () => path === '/state/workflows/catalog' ? catalog : {} }
  })
  const overview = await readResidentOverview()
  assert.equal(overview.workflows, catalog)
  assert.equal(paths.filter(path => path === '/state/workflows/catalog').length, 1)
  assert.equal(paths.includes('/state/workflows'), false)
})

test('插件设置页提供统一视觉尺度、窄屏表单布局和可见键盘焦点', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/client.js', import.meta.url), 'utf8')
  assert.match(source, /const ui = \{ textSm: 12, textMd: 14, textLg: 16, textXl: 20/u)
  assert.match(source, /@media \(max-width: 720px\)/u)
  assert.match(source, /:focus-visible/u)
  assert.match(source, /assistant-inline-form/u)
  assert.match(source, /data-dingtalk-assistant-settings/u)
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
