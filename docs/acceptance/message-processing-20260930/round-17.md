# 第 17 轮：稳定集成与安装准备

## 结果

- 21 个相关 Node 测试文件，共 **631/631 PASS、0 fail、0 skipped**，耗时 196043ms。覆盖消息、事项影响、Task/Owner、阶段、通知、HTTP、DWS、Observer 和部署完整性。
- `pwsh -NoProfile -File test/deploy-owner-repair.test.ps1` 全部通过，包含新增 6 项迁移锁、摘要、模式与启动门禁。
- `node scripts/build-web-client.mjs` 成功，生成的 Assistant web-client 无 diff。
- Assistant 包逐项核对 **99 文件**，Observer 包核对 **4 文件**；SHA256 及字节数见 `round-17-packages.json`。
- 正式实例的部署 `-Check -HoldMaintenance -MigrateMessageImpact` **writes=0**，22 个原 Task、在途已排空；所需空间 3012643368 bytes，小于可用空间。此结果不是已部署。
- 最新真实模型验证：原长消息的 S 已通过实际 Host 默认窗口；I 在 Host 准入事实下分别返回调查承接、原 Task 修订，且阶段来源逐字引用校验通过；业务集合查询 R 保持独立事项。I 的任务事实为隔离构造，模型验证未创建生产任务、未执行 SQL 或发送消息。
- 隔离 Edge UI 7 项通过，错误 0、写操作 0；见 `round-2/observer-waits-checks.json`，页面资料为合成数据。

## 复现

```powershell
node --test --test-concurrency=2 test/message-workflow.test.js test/message-ledger.test.js test/message-impact.test.js test/message-repair-coordination.test.js test/message-context-repair.test.js test/workflow-service.test.js test/workflow-notification-obligations.test.js test/execution-store.test.js test/execution-controller.test.js test/execution-task-plan.test.js test/task-owner-store.test.js test/task-owner-recovery.test.js test/task-owner-session-native.test.js test/task-owner-delivery-manifest.test.js test/task-stage-contracts.test.js test/task-general-workflow.test.js test/http.test.js test/workflow-entry.test.js test/dws-bridge.test.js test/observer-client.test.js test/deployment-integrity.test.js
pwsh -NoProfile -File test/deploy-owner-repair.test.ps1
```

原始失败/成功日志及真实消息模型输出仅留本机；公开仓库保存脱敏用例、脚本、计数和安装包摘要。原始模型探针需有权限的本机 profile 与只读源库才能重跑，不能当公共 CI 数据。

## 未验证边界

尚未执行正式 schema 迁移、安装重启、恢复原七条或真实渠道外发；没有验证 Excel 业务内容、专家账号、SQL 正确性或生产执行。A14 保持 NOT_RUN，A06/A28 真实运行部分仍待核验，因此不生成全绿 report。
