# Round 2：根因修复回归

本轮只修改 Round 1 仍失败的共享根因：

1. 普通任务回复和完成通知共用 `replyRouting`；有效引用省略 `atOpenDingTalkIds` 时统一推导被引用发送人，跨 Topic 或非法显式接收人仍拒绝。
2. coordinationRequests 支持 `superseded`、`supersededBy`、`supersedeReason`；完成请求落 `completed`，任务/流程版本失效请求落 `superseded`，不再遗留永久 pending。
3. 恢复异常使用稳定身份聚合，记录首次、最近和次数；扫描与提交间已失效的旧任务结果属于正常竞态，不再污染当前健康状态。
4. 人工批准上下文固定携带精确 `requestedAction`；备注可以收窄方式，冲突时禁止行动并提交 `scope-conflict`。Observer 将按钮改为“批准该事项并继续”。

验证：

- 定向测试：199/199 PASS。
- 全量测试：419/419 PASS。
- `node scripts/build-web-client.mjs`：成功生成实际 Web client bundle。
- `git diff --check`：PASS。

尚需：按本地部署 runbook 安装两个实际包、重启一次、回读安装源码哈希、健康接口以及真实看板页面。完成前不写最终 report。
