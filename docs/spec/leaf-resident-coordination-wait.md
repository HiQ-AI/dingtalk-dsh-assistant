# 叶子请求常驻会话协调检查

日期：2026-09-20。实施前快照。

## 症状与根因

关登工时任务的写入、10 条精确清单及独立回读已经完成，尚需由来源群中的 leobot 检查。叶子直接向 parent resident 调用原生 `send_message` 被 DSH 拒绝，这是原生会话权限限制；叶子直接向来源群发消息也违反本插件的唯一群出口约束。

当前 `waitingKind=information` 只描述向相关参与人追问缺失输入，`human-intervention` 则触发人工批准。外部参与者按已授权任务目标做独立检查，既不是缺失输入，也不应再次要求人工批准。`runtime.js` 已有 `coordinateTaskResult` → `topics.requestReply` → resident `group_reply_submit` 的受管消息链路，适合复用。

## 目标和设计

新增 `waitingKind=coordination` 结果分支：携带明确检查请求、已完成工作摘要和证据；Host 持久化 Task waiting 状态并通过现有 Task 协调链路把完整结果交给来源群 resident。resident 根据原始 Topic 消息和历史回复选择真实接收者并经统一 Outbox 发送；叶子不获得跨会话 send_message 或群聊发送权限。收到独立检查结果后，仍走原 Topic/Task 输入链路续接同一 Task；不自动把“请求已发出”判为任务完成或检查通过。

复用当前 information-wait 的通知、Outbox、结果指纹和重启重放机制。Store 只扩展 waitingKind 枚举，不改 domain 版本或迁移历史记录。扩展后必须验证人工审批请求数为零、同一报告只发起一次协调、重启补偿和并发版本校验。原有 information 与 human-intervention 含义不变。

现场现存的第二条人工阻塞是旧代码产生的历史状态。修复后先核对最新 Task、授权和外部工时操作回读，再经受控续接把检查请求转换成新的 coordination 报告；不得重跑 10 条工时写入。部署与现场续接单独留证据。
