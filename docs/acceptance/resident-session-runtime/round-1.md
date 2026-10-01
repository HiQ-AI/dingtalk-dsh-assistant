# 常驻会话修复：第一轮验证

本轮修复群协调会话的 Agent 工作目录、原生完全权限和完整群名标题，并减少历史 Host 快照及跨账号通知回声带来的重复处理。

## 已执行

- `node --test test/message-coordinator.test.js test/message-ledger.test.js test/workflow-service.test.js`：321 项通过，0 失败。
- `node --test test/group-coordinator-session-native.test.js test/message-coordinator.test.js`：38 项通过，0 失败；包括原生历史继承、旧会话字节不变、CAS 绑定、恢复不触发模型请求。
- 最后补充群名改名断言后，`node --test test/group-coordinator-session-native.test.js`：9 项通过；下一轮输入字符数从 30432 降至 1949，来源原文、引用、附件保留，当前轮快照保留。
- `node --test --test-name-pattern='已送达通知回声|已回读的自身澄清通知' test/workflow-service.test.js`：2 项通过，验证发送账号与任务 Owner 不同的通知回声被过滤，以及同文字不同消息 ID 的真人消息仍被处理。
- `pnpm install --frozen-lockfile`、`node scripts/build-web-client.mjs`、`git diff --check`：退出码 0。

以上原生验证采用真实 DSH session/persistence/permission/title 服务，模型响应为受控测试数据；不是实际模型延迟的测量。测试 shell 仅提供 sandboxMode 事实，不执行外部命令。

## 部署检查受阻

2026-10-01，按运维 runbook 执行 `deploy-owner-repair.ps1 -Check`，返回 `BACKUP_ARTIFACT_MISSING`。没有进入维护或停止当前进程。缺失来源为历史 message_items 的工件引用：

- task-bf67e52908fd266fa6108536ad88b5ab：a7125737a36960e89190cc5784348f92f4fad01be8c8c202122e1e85813699d3、0693325e1b0a46e843ac1ff5a4878195739251486084bfb3a1ab85c29515e6fd。
- task-417bbafbcaffdcb6a2f553778cf060fc：e989f36f99c0078177aca53bd6bea96d477175f8a109f0a0d3c6f9f436df1309、4bfc1cbab84208bfab63167669b68b33582ac344fb95e21205ac4715f8f09306。

只读 SQLite 枚举共找到 11 个任务工件引用，其中上述 4 个原文件不存在。对 D:/dsh_home、D:/baibu-agent/tasks、主仓 docs 和 D:/codex/worktrees 使用包含隐藏及忽略文件的精确文件名检索，未找到原件。部署不能绕过备份完整性检查，也不能制造 hash 工件。已向用户询问可恢复的备份位置。

尚未部署、尚未测量真实新消息延迟，生产数据库业务授权不变。
