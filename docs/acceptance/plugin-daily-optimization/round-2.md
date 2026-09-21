# 第二轮：逐项集成回归

2026-09-21，隔离 worktree `worktree-plugin-daily-optimization`。本轮只使用内存 Domain、模拟 Session 与 DWS adapter，不重放真实群消息或业务写入。

- 派发：`#1066` 单消息三事项回归，三个 Topic 可分别建 Task；多 Unit 的 `new-task` 缺少 `dispatchAssessment`、引用其他事项 Unit、流程版本陈旧或停用均被拒绝。Host 只能核实来源与当前流程身份，业务对象、他人后续的语义仍需 Resident 判断。
- 输入修订：授权变化须带当前决策的新消息依据；旧阶段批准失效。旧版本待审报告只转为历史，通知叶子按当前版本重提，不自动执行原业务动作。无影响补充保留原有效阶段。
- 活动：临时 EPERM 模拟失败后按 Session 原事件顺序补齐；活跃与已完成任务跨重启补齐均通过。500 条明细裁剪后累计统计仍在，过期事件推进水位，重复投影不重计。历史已裁剪的数据标 `retained-only`，不能称完整历史。
- 通知：一次发送与两次群历史回读分别计数为 `sendAttemptCount=1`、`readbackAttemptCount=2`；`deliveryAttemptCount` 仍只表示流程轮数。
- `pnpm test`：470 pass、0 fail。此结果是本地自动化验证，不代表真实群送达或当前 Profile 已安装。

当前未做生产群业务 E2E、历史漏失数量核对或本机 Profile 切换。部署前应按 `docs/ops/resident-review-local-deployment.md` 复核活动 Task、存储备份和现有健康状态。

按用户提供的 `agent-checklist.md` 复查了本次受影响的多事项边界：`SHARED-005/006/007`、`REQ-ITEM-F3-8/12/13` 和 `REQ-ITEM-F8-8/10/14/16`。来源 Unit、原子接纳、#1066 三事项及独立进度有对应回归；此次新增的 `dispatchAssessment` 仍不能证明自然语言范围正确，未以结构测试宣称语义零遗漏。清单中审核业务功能、v7→v8 迁移和完整 gold 样本评测属于原多话题功能验收，不以本轮局部优化冒充重新验收。
