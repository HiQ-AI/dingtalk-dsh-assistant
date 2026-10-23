# R27：交互式执行接入与首轮集成

本轮尚未提交、合并或部署。各职责的完整执行文档见 `round-27/pty-execution.md`、`round-27/config-execution.md`。真实模型只运行隔离任务库，没有操作现场任务或原用户窗口。

## 已取得的证据

- PTY：55 项宿主定向单测；干净 npm、pnpm consumer 的静默退出、取消、fiber dispose 均通过，宿主自然退出，独立回读 PID 均消失。双包与关键文件摘要见本轮 JSON。
- 插件：配置和绑定 13 项、配置页浏览器 10 项、部署 helper 3 项通过。Store 与文档定向 113 项通过，原生静止账本 54 项通过。
- adapter 合同：原 26 个负例保留并迁移到 HTTP hooks，加 5 个团队/模式用例，31 项通过。此层的终端为受管固定子进程的接口适配，不能当作真实 Claude 团队证明。

## 真实整队首错

`scripts/verify-interactive-claude-team.mjs --consumer docs/tmp/claude-pty-consumer/package.json --output docs/tmp/interactive-team-live-1` 使用真实账号、修复后的 PTY、生产 Store 与 adapter。

结果 FAIL：`claude_execution_member_unbound`。真实 CLI UUID `868ee0ee-29de-4272-8045-f278378f5615`，执行 `6af3d8a1-e001-4ed4-91ab-54efbeb11231`。原事件 21 是 Agent PreToolUse，22 是成功创建 calc 的 PostToolUse（`teammate_spawned`、`in-process`、team `session-1d6e0ff1`），紧接着 SubagentStart 在身份登记完成前到达，事件 23 记录拒绝。

根因：HTTP hook 请求并发；先持久化创建结果的异步写入尚未结束，队友 hook 就读取了未登记的 Map。不是 CLI 未能生成队友，也不是认证失败。修复必须等待已经准入的创建调用完成绑定，未知成员不能直接放行。

受管终止后 wrapper 自然退出 1（测试失败），CLI outcome 为 null（取消），不能写成 CLI 正常退出 0。独立 PowerShell 回读 wrapper 55628、CLI 76296 均不存在；此结果支持 PTY 异常释放，但不证明团队业务成功。

原始本机证据保留 `docs/tmp/interactive-team-live-1/`，不提交运行库和大日志。重跑使用新目录及新轮次，不覆盖本轮首错。整队通信、双队员关闭、原会话续办及历史文档冻结仍待验证。
