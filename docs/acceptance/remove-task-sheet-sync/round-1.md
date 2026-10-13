# 第 1 轮：功能移除验收

日期：2026-10-13。基线为 `origin/main` 的 `44646d2`，工作分支 `worktree-remove-task-sheet-sync`。状态见 `matrix.csv`。

## 自动测试

```powershell
pnpm install --frozen-lockfile
node --test test/http.test.js test/store.test.js test/check-resident-storage.test.js test/dingtalk-dsh-assistant.test.js test/workflow-migration.test.js
node --test test/client.test.js
node scripts/build-web-client.mjs
git diff --check
```

- worktree 独立安装 250 个包，未复用主检出的 node_modules 链接。
- 后端定向测试 86/86 PASS，0 fail、0 skipped，耗时 9810.0262 ms；独立读取 `round-1/backend-tests.log`，7886 bytes。
- 四个旧接口在生产/测试模式下共 8 次真实本机 HTTP 请求均返回 `404 {error: "not_found"}`。相邻状态、Agent 和群配置接口继续通过原有测试。
- 带旧 `enabled: true` 配置的存储通过只读预检，`strippedFields=0`；修改其他配置并重新打开后历史字段不变，Store 不再提供同步 get/set。
- 真实 Resident apply/dispose 夹具未注册 180000 ms 定时器，启停后旧同步配置和状态不变。迁移回归通过，v8 schema 文件 diff 为空。
- 新增客户端概览回归先在旧实现运行失败：请求旧接口的 `Promise.all index 6` 收到 `Not Found`。移除后客户端定向测试 7/7 PASS，概览只请求仍存在的 7 个端点。
- Web bundle 由仓库生成脚本生成；`git diff --check` 通过。

## 独立浏览器

复用既有 `leaf-prompt-defaults/scripts/browser.mjs` 的隔离夹具方式，加载真实 React 和本次发布 bundle，使用新建 headless Chrome。所有 Resident API 经内存 fixture 拦截，不连接当前运行实例，也不操作用户现有浏览器。

```powershell
$playwrightPath = 'C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
$reactDomPath = 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.development.js'
node docs/acceptance/remove-task-sheet-sync/scripts/browser.mjs $playwrightPath $reactDomPath docs/acceptance/remove-task-sheet-sync/round-1
```

修改前在同一夹具加 `--baseline` 运行：旧卡片存在、同步状态请求 1 次、页面异常 0；基线截图已查看。基线模式需使用上述基线版本的 bundle。

修改后 7 组检查通过：初始 loading/概览、刷新/键盘焦点、Agent 配置保存并重载、保存失败保留草稿及刷新重试、概览 503 后刷新恢复、工作流键盘及相邻原生 select、390px 窄屏无横向溢出。共 74 次 fixture API 请求，旧同步接口请求 0、页面异常 0；3 次配置写请求均为内存 fixture。

实际查看桌面及窄屏截图：环境检查直接衔接 Agent 配置，无同步卡片、遗留空块或控件溢出。窄屏 section 间距为 12px。静态 premium strict 审计 0 findings；默认审计对 createElement 和未声明 UX 契约的覆盖有限，不据此声明全应用可访问性合规。

## 发布包回读

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/remove-task-sheet-sync-pack
tar -tf docs/tmp/remove-task-sheet-sync-pack/zzusp-dingtalk-dsh-assistant-1.0.0.tgz
```

包大小 898581 bytes，共 126 文件，SHA256 `a584955d448bcac40c01130cfbcc5a61288c95f975b9bc0001ce0db6925b21fe`。独立列包确认不含 `task-sheet-sync.js`、仍含 DWS runner；经 `tar -xOf` 读取 resident/http/store/web-client 与工作区逐字节相同。前三者中的 resident/http 及 web-client 均无同步执行引用，store 仅留历史 schema 字段。

生效源码及脚本搜索仅余当前和 v8 schema 的历史字段。独立审查发现部署文档关闭顺序仍含“同步服务”，已修正并回读；最终未发现待修问题。

## 边界与产物

7 项移除验收均 PASS。未执行全量测试、发布、合并、本机部署或真实钉钉消息/表格操作；当前运行中的旧进程不由此代码变更自动替换。原有远端表格内容不在移除范围。

截图、浏览器 JSON、审计结果和测试/打包日志位于忽略的 `round-1/`；tgz 位于忽略的 `docs/tmp/remove-task-sheet-sync-pack/`。原始日志和二进制不入 Git，以上命令及提交的浏览器脚本可再生成证据。
