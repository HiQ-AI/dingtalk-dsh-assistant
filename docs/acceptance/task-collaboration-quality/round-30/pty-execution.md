# R30 PTY 退出码顺序修复

职责：解决完整交互式 Claude Team 集成暴露的 `exitCode: undefined`，保持适配器必须真实 exitCode=0 的成功条件，重新构建双包并证明零/非零退出码不丢失。生产未部署；旧包与旧轮证据保留。

## 根因与反证

R29 的实际 CLI 收到 SessionEnd `prompt_input_exit`，但下一条 PTY exit 只有 `signal:null`。node-pty `lib/windowsTerminal.js` 在输出 socket close 时立即读取 `agent.exitCode`；这个字段由 native `SetupExitCallback` 的另一异步回调赋值。Claude 可以先关闭终端输出，再结束进程或交付 native callback，因此输出 EOF 不能证明退出码已知。

`verify-node-pty-exit-order.mjs` 在测试中把 native callback 交付延迟 2.5 秒，使用两个真实 Node PTY 子进程分别以 0、7 退出。v1 两次都提前发布空 outcome，且回调记录证实先后顺序。反证保存在 `../round-27/pty-exit-order-before.json`，保留其 FAIL，不回填成通过。本反证不调用模型，也未向现有 Claude 窗口发消息。

## 最小修复与交付

`node-pty-exit-order.patch` 在 WindowsPtyAgent 增加 native exit 事件，在 WindowsTerminal socket close 路径等待已知 exitCode 或订阅下一次 native exit，再发布终端 exit。既等待输出结束，也等待进程退出码；不将 undefined 当 0，不用定时猜测成功，不改业务适配器断言。启动错误路径仍返回原错误码。

宿主生命周期源码补丁不变；宿主包版本升为 `0.2.1-rc.2.pty.2`，精确依赖 `node-pty@1.2.0-beta.15.dsh.2`。node-pty v2 同时带已有 worker dispose 补丁与本次退出顺序补丁。`build-claude-pty-packages.ps1` 在全新 staging 目录应用补丁并产出新包，不修改源码依赖安装目录或正在运行的 profile。

产物：`docs/tmp/claude-pty-packages-v2/`；新的干净 consumer：`docs/tmp/claude-pty-pnpm-consumer-v2/`。包清单及两份源码 patch SHA 见 `pty-package-manifest.json`。部署需新持久目录，不能覆盖 v1；校验除 windowsPtyAgent/unixTerminal 外，还必须包含 `lib/windowsTerminal.js`。配置执行成员已同步 helper 白名单。

## 实跑结果

1. 全新 pnpm consumer 从候选 tarball 安装 14 包成功；仍使用 hoisted、autoInstallPeers=false，依赖声明旧版，仅 pnpm.overrides 切换补丁版本。
2. 相同延迟 callback 回归通过：真实 0 → exitCode 0；真实 7 → exitCode 7，exit 都在对应 native callback 后发布。见 `pty-exit-order-after.json`，probe 自然退出 0。
3. 真实 `claude.exe --help` 与 `--version` 分别通过 DSH spawnTerminal 执行，均真实 exitCode=0、输出非空，两个 CLI PID 消失；wrapper 自然退出 0。见 `claude-pty-exit.json` 与 `.natural-exit.json`。这是实际 Claude 二进制的无模型 smoke，不等同完整交互 Team 验收。
4. v2 重跑 `silent-exit`、`silent-cancel`、`dispose-running` 全通过，静默退出真实 0，取消保持未知/null而非伪造 0，PID 分配后与子进程自报一致。wrapper 自然退出 0；独立 PowerShell 回读 wrapper 与三子进程均消失。见 `pty-lifecycle-result.json`、`pty-natural-exit.json`。
5. `pty-consumer-readback.json` 从实际 provider 解析 node-pty，确认新版本及四个核心文件摘要；host JS 摘要与 v1 一致，node-pty 的 WindowsPtyAgent、WindowsTerminal 摘要改变。

本项无新模型调用；完整交互 Lead、队友调度及最终插件提交由本轮统筹另行复验。Windows 原有可观察进程树清理边界保持，不宣称新增 Job containment。
