# 模型过载与启动环境恢复验证

## 原生协调错误

源码提交 e45c3e9 保留本轮原生 turn/end 的失败 cause，精确识别现场 Codex 过载响应。已有决定优先；其他原生错误保持条件等待；仅检查本轮事件水位后的结束事件。

- `node --test test/message-coordinator.test.js test/group-coordinator-session-native.test.js`：59/59 PASS，29556.0718 ms，日志 docs/tmp/clarification-tests/provider-recovery.log。
- 全文件运行后追加的旧实现 condition 摘要恢复例：定向 1/1 PASS，原 sourceKey、sourceVersion、runId 不变，仅重领一次。
- 两个边界定向 2/2 PASS：已接纳后晚到 error 仍 submitted（也包含在前述 59 项）；上一轮原生 error 不污染下一轮正常 no_submission（全文件运行后新增）。不重复累计测试数量。
- `git diff --check` 通过。

Assistant 包 `provider-recovery-20261008-assistant-fbef7d7d.tgz`，SHA256 `fbef7d7d5d671dcb640c70340970bc8ccd1a6230e66a7daf0b8eb227b184b1b0`，708279 bytes；独立 package 检查 verifiedFiles=100。此记录只证明打包及源码一致，部署和原消息 Task 回读另列。

## 计划任务启动与现场回读

三个 PowerShell 测试脚本 deploy-owner-repair、deploy-local-no-backup、deploy-execution-events-index 均 PASS，覆盖正常部署、失败续修、启动身份拒绝和恢复边界。部署 --Check 零副作用预检通过后安装上述已核验包，经现有 DSH Web Local 启动 PID 141508。

部署独立回读：包源码 verifiedFiles=100；认证 Web 200，控制健康 ok，旧 Task 1 / 节点 30 / Run 1 保持；11:48 恢复派发，maintenance.active=false。11:49 健康回读 inboundProcessing=true，两群 listener=ready、backfill=ok，humanReplies=ready。

11:50 只读 SQLite 回读 coordinator：原两个 sourceVersion=2 的 replay 保持；error=GROUP_COORDINATOR_PROVIDER_FAILED，recovery.kind=dependency，delayMs=120000，retryAt=2026-10-08T03:52:27.288Z。原生 turn/end 连续返回 Codex servers overloaded。说明新补丁已把模型过载恢复为暂态重试，未伪造澄清或重复来源。

真实新 Task 仍未创建，当前为外部模型服务阻塞；不能将通道恢复、模型回放或重试机制验证当作真实任务承接完成。两条通知的实际撤回证据见 round-16。
