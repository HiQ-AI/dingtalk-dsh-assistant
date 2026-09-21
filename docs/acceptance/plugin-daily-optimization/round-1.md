# 第一轮：系统审阅故障与工具结果

2026-09-21 在新 worktree 基于 `origin/main` 98f63bd。`pnpm install --frozen-lockfile` 成功，工作区依赖独立安装。

- 错误分类：确定性上下文预算异常从业务 `rejected` 改为系统 `failed`；持久原报告不自动重试。队列测试连续 recover 100 次只执行一次，并证明真实业务 reject 仍为 rejected。
- Runtime 恢复：测试先落盘一份失败报告并关闭旧 Runtime，再重开同一存储；Task 进入 `waitingKind=system`、Goal 阻断、Outbox 只生成一条故障通知，100 次新提交被拒绝，其它 Task 正常启动。修正后同一 submissionId 重试可审阅通过，旧 pending 通知变为 superseded。
- 工具事件：按当前 DSH 事件真实形态构造 tool/call 和 tool/result，投影结果为 `tool=group_topic_context_get`、`isError=true`、原 callId。
- `pnpm test`：461 pass，0 fail。此处仅是本地测试，尚未安装到真实 Profile，也未声称群消息实际送达。
