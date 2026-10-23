# R27 PTY 生命周期执行记录

职责：修复 Windows DSH PTY 的 PID 与释放问题，交付可重新构建的包，并在未挂接开发工作区的 npm consumer 上验证。未修改已安装 profile，未推送 DSH 上游。

## 根因与范围

从远程 master 重新 fetch 得到 `687f282e8625c6b8d11ff58211a90524be2e4317`（rc.2）。旧 `origin/master` 指向更早历史且非快进，保留它，另存审计 ref。独立宿主工作树为 `D:/codex/worktrees/dsh-pty-interactive-lead`，未复用主仓 node_modules。

1. `LocalTerminalHandle` 构造时固定保存 `terminal.pid`，而 Windows node-pty 异步分配最初为 0。改为读取当前 PID，并在可观察到存活 PID 时捕获一次 start identity；退出后不重新捕获，保留 PID 重用防护。
2. Windows 根进程已退出不代表 PTY 传输已释放。清理在确认进程退出后仍调用一次 node-pty 公共 `kill()` 释放传输；重复 terminate 不重复释放。
3. rc.2 的 pnpm workspace 已包含 node-pty bundled ConPTY worker dispose 补丁，但 npm consumer 安装原始 beta.15 时没有该补丁。仅改宿主不足以修复 MessagePort 留存，因此必须同时交付补丁 node-pty tarball。

没有选择切回 system ConPTY：现有宿主使用 bundled console 是为修复 Windows PowerShell prompt readiness，切回会引入关联回归。没有 private-field unref、强制 process.exit、直接编辑运行时 node_modules 或改变 Windows Job 保证。

## 源码与构建配方

- `../scripts/dsh-rc2-pty-lifecycle.patch`：精确 rc.2 源码、定向测试与双语 README 补丁，SHA256 见本轮包清单。
- `../scripts/build-claude-pty-packages.ps1`：检查 base、已应用 patch 和 node-pty workspace 补丁后构建 TypeScript/bundle，使用 npm tarball 完成交付；`-Check` 零写入。输出目录必须全新，旧轮产物不覆盖。
- `../scripts/dsh-pty-unit.config.mjs`：运行定向单测，显式覆盖 Windows 默认聚合配置排除此文件的问题。
- `../scripts/verify-claude-pty-lifecycle.mjs`：从指定 consumer package.json 解析真实包，验证静默退出、静默取消和 fiber dispose。

重新构建：从上述 base 创建独立工作树，`git apply` 本 patch，执行 `pnpm --filter '@deepseek-ai/dsh-subprocess-local...' install --offline --frozen-lockfile --ignore-scripts`（缓存不足时去掉 offline，保持锁文件），再运行打包脚本 `-HostSource <worktree> -OutputDirectory <新目录> -Check`，检查通过后去掉 `-Check` 构建。无需将现有安装包目录作为源码。

产物为 `@deepseek-ai/dsh-subprocess-local@0.2.1-rc.2.pty.1` 与 `node-pty@1.2.0-beta.15.dsh.1`，前者精确依赖后者。正式 DSH `plugin add` 使用 pnpm，部署 helper 因此在 profile 写入 `pnpm.overrides`；独立 npm consumer 使用 npm 自己的 `overrides`，两者不混用。部署必须同时绑定两个补丁包，不能仅安装宿主包后从 registry 拉原 beta.15。tarball 位于 `docs/tmp/claude-pty-packages/`，大二进制不提交，摘要保存在 `pty-package-manifest.json`。

## 本轮实际验证

- 55 项定向单测通过；本轮执行耗时 3.91 秒。TypeScript 定向 build 与 tsdown bundle 通过。
- 全量 offline 安装因不相关 Electron app-builder-lib 缓存缺失失败；收敛到 subprocess-local 的 35 个 workspace 依赖后，748 包由缓存成功安装，不改锁文件。
- npm offline consumer 首次因缓存 registry 元数据缺 cordis 4.0.5 失败。因此把 profile 中精确已安装的 11 个支持依赖打包为 fixture tarballs，和 2 个候选包一起从本地 tarballs 安装到全新 consumer。没有 workspace 链接，没有复制主仓 node_modules。`npm install --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund` 成功安装 14 包；忽略安装脚本不影响本机已带 prebuild 的 Windows 路径，其他平台安装不在本轮声明内。
- `silent-exit`、`silent-cancel`、`dispose-running` 三种真实 PTY 模式均 PASS；每种 stdin/stdout 都是真 TTY。初始 PID 允许为 0，分配后 PID 与子进程自报 PID 一致。
- 每种模式执行重复 terminate，随后 fiber dispose。静默自然退出 exitCode=0；取消不伪造成功退出码，outcome 为 null。
- wrapper 自然退出 0，未用 process.exit 或外部强杀。独立 PowerShell Get-Process 回读 wrapper PID 58732 与子进程 55036、83548、45392 均不存在。
- `pty-consumer-readback.json` 从真实 provider 再解析 node-pty，确认使用两个补丁版本及三个关键文件 SHA256。`pty-natural-exit.json` 的 beforeExit 仍列普通 stdout/stderr PipeWrap；最终进程自然退出才是无持活泄漏的验收依据，不能要求列表为空。

边界：本记录证明修复包的 Windows 本机 PTY 生命周期；实际 dsh-base → provider 安装链、Claude Agent Team、钉钉业务及配置页由本轮其他执行项独立验证。Windows terminal 仍是已有的可观察进程树清理，不宣称升级为 Job containment。

## 部署适配只读审查

审查对象为 `scripts/pty-package-upgrade.mjs`、`deploy-task-session-native.ps1` 的 PtyUpgradeProposal 分支及三项单测。未修改其他执行成员负责的文件。

- 未发现阻塞项。helper 严格限制两个名称、版本与三个关键文件；先验 tarball SHA、再读取 tar 成员及包身份、最终复验 SHA。profile manifest 在 apply 前两次 CAS，写入临时文件后原子 rename，再独立回读新 SHA。提案文件在部署 check/apply/verify 前后均有摘要校验。
- verify 通过真正的 dsh-base 入口解析 provider，再从 provider 解析 node-pty，能拒绝仅 root 安装正确而嵌套消费者仍旧版的情形；不是查看 root package version 代替消费链。
- DSH rc.2 `apps/cli/src/plugin.ts` 实际转发 `runPluginCommand`/pnpm；`pnpm.overrides` 与正式安装方式一致。另建全新 pnpm consumer，保留声明的原始 rc.2/beta.15 依赖，单靠 `pnpm.overrides` 指向补丁 tarballs，在 `nodeLinker: hoisted`、`autoInstallPeers: false` 下实际安装成功（pnpm 10.13.1，14 包）。真实三个 PTY 模式再次全部通过，wrapper 自然退出 0，独立回读四 PID 均不存在；证据见 `pty-pnpm-result.json` 与 `pty-pnpm-natural-exit.json`。
- 安装失败阶段发生在自启禁用、旧进程已退出之后，脚本保持停机并保留阶段证据，不会把部分安装启动，也不会自动覆盖未知现场。此边界不是自动回滚：manifest 可能已写入两 override，锁文件/node_modules 可能已部分改变；修复后须用新的 manifest SHA 重新制定继续方案，不能重放旧提案 CAS。正式部署仍须实际执行 verify 后才能宣告消费链正确。
