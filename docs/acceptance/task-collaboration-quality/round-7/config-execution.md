# SG7 执行后端配置

## 职责与范围

在既有插件配置页增加执行后端选择，默认 DSH 原生，可选 Claude Code CLI；负责配置验证、持久化和界面状态及定向验证。后续追加 Observer 后端区别与路径展示。不修改 task-session-service.js / dynamic-task-store.js。后端绑定与已有执行续办由统筹实现。

## 当前发现与方案

- 唯一入口：client.js 的 Agent 配置表单经 PUT /config/agent 调用 task-resident-runtime.js.updateAgentConfig，写入 store.js 的 scheduler.runtime；web-client.js 是构建产物。
- 配置合同：agentConfig.executionBackend 仅接受 dsh / claude-code，未配置读为 dsh。resident 的 taskSessions.executionBackend 可设初值，已保存值优先；非法值在任何存储写入前拒绝。
- 按 DESIGN.md / UX-CONTRACT.md 复用系统原生 select、宿主主题与单一保存按钮。中文使用提示明确仅新执行采用，已有执行和续办保持原后端；保存中禁用、失败保留草稿、刷新不覆盖未保存值。
- 暂不增加 claudeExecutable：使用已安装到 PATH 的 claude。CLI 可用性与真实执行属于后端验证，不把配置保存成功称为 CLI 验证通过。
- 已读取 frontend-design / frontend-design-premium 及相关表单、原生下拉、验证规范；未更换视觉系统。

## 修改与证据

- task-resident-runtime.js：读取缺省值与 profile 初值、枚举预检、保存回读；非法后端在任何配置存储写入前拒绝。
- store.js / resident.js：持久 schema 与读取、taskSessions.executionBackend 初值接线。service 通过现有 getAgentConfig() 读取配置。
- client.js / 生成的 web-client.js：原 Agent 卡片新增有标签的原生 select；草稿、保存中禁用、失败回读及刷新保护共用既有流程。DESIGN.md / UX-CONTRACT.md 同步此行为。
- test/task-model-config.test.js / test/client.test.js：配置真 HTTP 保存、拒绝、重启和回读；已有两存储部分失败测试加入后端断言。
- Observer web-client.js：CLI 在详情与卡片标为 Claude Code，不把 CLI sessionBound 当作 DSH 导航身份；静态行保留标题、状态与最新轮耗时，详情显示工作目录、当前轮文档和 CLI 日志路径。当前文档路径不等于文件已落盘；不新增文档 HTTP API 或终端。
- test/observer-node-control-display.test.js / observer-board-restoration.test.js：CLI 绑定不得打开 DSH、原生入口仍保留，路径/轮次/标题/状态/耗时断言；observer-client 原入口断言同步显式后端门禁。
- scripts/execution-backend-browser.mjs：复用现有 React + 发布 bundle + 隔离 HTTP 的浏览器验收模式，参数化本机 Playwright、ReactDOM 和 Chromium 路径，不依赖业务运行端口。

## 测试与限制

已完成：

| 验证 | 结果 | 证据 |
|---|---|---|
| task-model-config、coordination-model-config、client、web-client-build | 17 PASS、1 SKIP；锁定测试 profile 缺少 Web module registry，未把 skip 记通过 | config-tests-1.log |
| 安装 web profile 的实际官方 client registry 加载 + 发布 bundle 构建 | 3 PASS、0 SKIP，补足上行缺失能力；最终精确文案修正后再次 3 PASS、0 SKIP | config-native-web-1.log / config-native-web-2.log |
| premium-ui.json 要求的 client/http/observer 5文件 + 卡片恢复合同 | 最终 112 PASS、0 SKIP；前次配置-only 101 PASS | config-ui-regression-2.log / config-ui-regression-1.log |
| Observer 独立定向 | 71 PASS、0 SKIP | config-observer-1.log |
| Chrome 真实 React+完整发布 bundle | PASS，3 次配置请求；默认DSH、原生菜单展开/键盘、唯一保存防重、刷新回读、过期刷新保护、失败草稿保留及重试、390px无溢出；新增CLI文档/日志路径展开、无DSH按钮、原生入口仍导航 | config-browser-3.log / config-browser-result.json |
| UI strict audit | 0 errors / 0 warnings / 0 unresolved | config-premium-audit.json |
| DESIGN.md 官方 lint | 0 errors / 0 warnings；3条已声明token信息 | config-design-lint.log |
| git diff --check | PASS | 本轮命令回读 |

已人工查看 backend-select-open.png、backend-saved-desktop.png、backend-error-narrow.png，字段样式与相邻模型选择一致，窄屏文案和错误完整换行，焦点可见。backend-observer-narrow.png 使用完整 observerCss + taskDetailCss，CLI 路径完整换行；按钮采用 fixture 原生 button 适配，未声称宿主视觉全链验证。

关键命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node --test test/web-client-build.test.js
node scripts/build-web-client.mjs
node --test test/task-model-config.test.js test/coordination-model-config.test.js test/client.test.js
node --test test/client.test.js test/http.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js
node docs/acceptance/task-collaboration-quality/scripts/execution-backend-browser.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs D:/dsh_home/profiles/web/node_modules/react-dom/umd/react-dom.development.js 'C:/Program Files/Google/Chrome/Application/chrome.exe' docs/acceptance/task-collaboration-quality/round-7
```

本文件只记录本执行职责；浏览器 API 使用隔离 fixture，真 HTTP 持久行为由配置测试单独验证。未证明 Claude CLI 运行、已有执行后端绑定、任务结果或部署成功，这些由后端验收补齐。未新增 CLAUDE 可执行路径或独立设置页，未改 task-session-service.js / dynamic-task-store.js，未提交。

## README 与运维收尾

按统筹追加分工同步 README 的执行后端配置、会话身份、模型/preset/Skill 范围、日志及看板说明，并在既有 `docs/ops/task-session-clean-start.md` 增补“执行后端配置与核验”。明确默认 DSH、唯一保存入口、仅新执行生效；CLI 使用 PATH 命令及自身默认模型，不传 DSH 模型，不自动登录。共同团队/文档合同、permission MCP 操作准入、hooks/其他 MCP/嵌套 Agent/后台任务限制、unknown 不重放且不走 DSH 自动对账，以及无排空证明保留占位均写入。

对照本轮已落盘 `claude-execution-session.js` 的工具集合、启动 flags、permission 门禁和排空分支，以及 `task-session-service.js` 的 CLI 对账拒绝分支完成只读核对。`git diff --check -- README.md docs/ops/task-session-clean-start.md` PASS；独立回读确认原“执行均 DSH 原生会话/均挂 preset”描述已修正。此次仅文档收尾，不重复运行已通过的 UI 测试；CLI 适配仍由并行成员完成，最终措辞由统筹结合最终实现复核，未新增真实 CLI 登录或业务验收声明。

## 最后只读集成审阅

结论：当前配置、持久执行定义、后端路由与看板合同一致，未发现阻断问题；此结论来自源码及既有定向证据，不表示已做真实 Claude 推理。审阅期间未改生产代码、测试或提交，根会话仍在完成集成回归与打包。

| 核对项 | 结论与反例检查 | 当前源码证据 |
|---|---|---|
| 缺省与非法值 | UI、runtime 与服务均缺省 DSH；已保存设置优先。HTTP 非法值在写入前拒绝，直接 store dispatch 也拒绝非法 backend。旧 definition 无字段保留原生路由。 | `task-resident-runtime.js:15,42,67`；`store.js:205`；`resident.js:82`；`task-session-service.js:35`；`dynamic-task-store.js:888` |
| 新建与续办身份 | 新 dispatch 从 `getAgentConfig()` 固化 definition。虽续办 payload 带当前选择，store 只修改原 definition 的 recoveryReadOnly，保留原 backend；稳定 key 重试先回读原收据，不因切换配置另建成员。 | `task-session-service.js:863–880,909–911`；`dynamic-task-store.js:907–948` |
| 生命周期路由 | run/cancel/feedback/assertDrained/recoverDrained 从持久执行定义选择 driver；CLI 不挂 DSH workspace，启动恢复不把它注册为原生 Session。配置切换不参与这些路由。 | `task-session-service.js:193–207,766,1141,1177` |
| DTO 与 UI | 列表 `executionSessions`、详情 `executions` 都输出后端；详情保留文档、工作目录及后端日志路径。SessionLocation 的显示和 click 两层均拒绝 CLI 导航；当前进展复用该组件且保留字段，卡片 CLI 渲染静态 div。另一个“查看会话记录”属于消息处理 trace，不承载动态执行。 | `task-session-service.js:350–384`；Observer `web-client.js:381,580–602,730–744,798,1584–1591` |
| 设置范围 | 仅增加 executionBackend，没有 claudeExecutable、CLI 模型或重复保存入口；DSH model 虽出现在服务公共 definition，CLI argv 不读取或传递该选择。 | Assistant `client.js:195,301–304`；`task-session-service.js:763`；`claude-execution-session.js:310–315` |

已有配置 HTTP 测试覆盖默认不写账、非法值原子拒绝、保存回读及重启优先级；UI 合同/浏览器证据覆盖 CLI 已绑定也无 DSH 导航、混合卡片与原生入口保留。根新增 `test/task-execution-backends.test.js` 包含配置切换后的原 CLI 成员续办、重启不重放及旧文档不变断言；本审阅只读该用例，最终实跑结论以根会话回归日志为准。

轻微文案观察（已告知统筹，未擅改 UI）：`client.js:304` 的“使用本机 CLI 配置”范围偏宽，当前 adapter 使用 `--setting-sources ''`，README 已准确写为“使用 CLI 自身默认模型”。建议最终 UI 文案也用该限定语，避免用户误以为会继承任意本机 settings/hooks/MCP。此项不改变后端选择或执行身份合同。

统筹复核后批准该精确文案修正：帮助文字现为“仅新执行使用此选择；已有执行及续办保持原后端。Claude Code CLI 使用 CLI 自身默认模型；需在服务账号下安装并登录。”已重建 `web-client.js`，用安装 Web profile 重新实跑 `node --test --test-reporter=tap test/web-client-build.test.js`，3 PASS、0 SKIP，证据 `config-native-web-2.log`。独立回读 source 与 bundle 均含新文本，`git diff --check` PASS；按统筹要求未重复 112 项或浏览器验证，因为这次只改精确文字。

最终实现冻结后，仅补 README 与既有 runbook 的后台任务机制：固定 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，permission 仍拒绝 `run_in_background`；异常 Bash `backgroundTaskId` 触发受管进程终止并保留未知效果，禁后台不等于 OS 沙箱、实际排空或远程效果消失。已读取 adapter 的 env、异常回执、finally 终止/排空/unknown 路径并独立回读两份文档，`git diff --check` PASS。本次未改 UI/源码、不重复 UI 验证，不将成员提供的真实 CLI 两轮结果或 26 项测试转记为本执行独立实跑。
