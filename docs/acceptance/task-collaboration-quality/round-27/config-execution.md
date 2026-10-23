# R27 配置与独立验收执行记录

## 本轮职责

维护执行后端选择的现有配置入口与用户说明，核验默认 DSH、保存回读及原执行身份保留。统筹仍由 DSH 承担；交互式 Claude Lead 的进程、权限和原生队友由后端实施负责。无提交、推送、部署或业务任务操作。

## 当前实现

- 复用 `agentConfig.executionBackend` 的 `dsh` / `claude-code`，不增加配置字段或第二保存入口。
- `client.js` 选项更新为“交互式 Claude Code（Agent Teams）”；说明统筹始终使用 DSH，Claude Lead 按需创建和调度队友。
- 通过 `node scripts/build-web-client.mjs` 生成发布 bundle。
- 保留既有原生 select、label/help 关联、保存中禁用、失败草稿、过期刷新保护和默认 DSH。
- 已读 DESIGN.md、UX-CONTRACT.md、frontend-design 与 frontend-design-premium；本轮仅文本变化，不改主题、布局或全局 UI 合同。

## 已执行验证

`node --test test/client.test.js test/task-model-config.test.js test/task-execution-backends.test.js`

结果：13 / 13 PASS，0 skipped。覆盖默认 DSH、HTTP 配置校验/保存/回读/重开、混合后端分派、配置切换后旧执行绑定与逐轮文件字节保持。

`audit_project.py . --mode strict --output docs/acceptance/task-collaboration-quality/round-27/config-ui-audit.json`

结果：errors=0，warnings=0，unresolved=0。静态审计不能代替浏览器或真实 CLI。

## 待完成与边界

- 浏览器验收 PASS：使用既有 `scripts/execution-backend-browser.mjs`、真实浏览器和发布 bundle，但 HTTP 为隔离 fixture，不修改现场配置。`config-browser-result.json` 独立回读 passed=true，10 项检查覆盖键盘、保存防重、回读、失败草稿、重试和 390px 无溢出；已查看窄屏截图。
- 历史 headless Claude 不能仅因 `executionBackend` 同为 `claude-code` 就暗中按交互式恢复；已向后端和统筹提出必须明确识别旧模式并保留旧绑定。
- README/runbook 已按受管 HTTP hooks、in-process 队友、关闭确认与历史 mode 拒绝策略更新。
- 以上配置验证不证明真实 Claude 登录、Agent Teams、取消排空或本地部署已完成。

## PTY 双包部署支持

统筹追加职责：为原生 SIGINT 部署脚本接入精确 PTY 双包提案。新增标准库 helper `scripts/pty-package-upgrade.mjs`，固定双包身份和关键文件；新增 helper 的原因是既有 host upgrade 工具针对 alpha2 整体宿主升级，不能复用来改变整套宿主。

已运行 `node --test test/pty-package-upgrade.test.js`，3/3 PASS：check 零写、只改两个 overrides、重复 apply CAS 拒绝；缺包、伪造名、错误摘要与删关键文件拒绝；实际 base 消费者使用旧 provider 或旧 node-pty worker 时拒绝，即使根包正确也不误报。PowerShell Parser 与 git diff --check 通过。

原生部署脚本新增可选 `-PtyUpgradeProposal`，只在既有离线排空完成后 apply，原官方安装后 verify；提案摘要在各阶段复核。安装或验证失败沿原失败路径停机，profile patch 不改。runbook 已写明持久包路径、提案格式、原生安装和实际消费者回读。尚未执行现场部署，最终执行由统筹负责。

## 原 adapter 测试迁移

保留原 26 个身份、反馈、权限、实际文件副作用、孙进程、取消、恢复及日志防重解析点用例；固定程序由 JSON stdout 协议迁移到真实 HTTP hooks，测试中的 spawnTerminal 接口适配真实 DSH spawn 管道，terminate 等待真实进程范围退出。该夹具不代表原生 PTY 或真实 Claude，独立集成探针承担这两层验证。新增旧 headless mode 拒绝、原生队友职责与关闭文档、外部 peer、后台派生和隔离工作树拒绝 5 个用例。

首错分别保留 adapter-test-migration*.log。迭代发现启动前反馈在 initialized 前被跳过（后端已修复）、terminate 拒绝跳过 HTTP 关闭和 cancel 未处理 Promise 拒绝（已提交后端修复）；不删除失败用例。第 4 次运行 30 个通过，排空负例导致测试宿主未退出，核验精确 PID/父 PID/命令后终止专属测试子进程，未碰真实 Claude 窗口。等待后端修复后再完整运行。

最终完整重跑 `node --test test/claude-execution-session-native.test.js`：31/31 PASS、0 skipped、0 cancelled，41.2 秒自然退出 0。证据 `adapter-test-migration-5.log`，原第 1–4 次失败日志保留；后端已修初次反馈补投、终止 Promise 复用/错误收集以及排空失败时 HTTP 资源清理。源码 SHA 独立记录于 `config-final-proof.json`。配置/部署 helper/测试/文档职责完成并冻结；真实 Claude、原生 PTY、正式安装与部署仍由独立链路确认。
