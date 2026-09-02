# 常驻回复 Steer 门禁验收目标

## 总目标

保证常驻主会话在可靠提交群回复前审阅全部已进入的同群 Steer：相关消息合并重生成，不相关消息不阻塞旧回复并在其后继续处理；Runtime 不替模型硬编码消息关系。

## sub goal matrix

| 子目标 | 状态 | 完成条件 |
| --- | --- | --- |
| SG-1 工具语义覆盖 | 已完成 | Decision 与 Task 通知均能表达相关、独立和不影响关系，漏观察原子拒绝 |
| SG-2 回复提交线性化 | 已完成 | 同群新 Steer 与可靠 Outbox 之间有明确门禁，工具成功不早于回复提交 |
| SG-3 复杂路径兼容 | 已完成 | effective reply、recheck、多 submission、Task 通知和无回复路径均有回归 |
| SG-4 并发与关闭边界 | 已完成 | 通知、历史导入和生命周期等待不占业务尾链；关闭释放等待者并保全已开始的可靠提交 |
| SG-5 发布质量 | 已完成 | 聚焦测试、全量测试、打包和 diff 检查全绿 |

## 重大决策

- 相关性继续完全由模型决定；Runtime 只验证 `observedRequestIds` 是否覆盖回复提交时的普通 pending 快照。
- 使用每群 reply barrier，只约束回复提交与下一条 Steer 的次序，不复用全局 Task 串行尾队列。
- 以可靠 Outbox 写入作为回复提交证据；pending Map 的 delete/resolve 只表示 Decision 被领取。
- Task 通知使用独立 `group_reply_submit`，不再读取 turn 最后一个 assistant 文本；通知生成必须在 Task 尾链之外等待。
- 普通消息的 `steered` 状态是业务动作和 Outbox 的前置提交条件；工具先领取但状态落库失败时整批失败。
- 生命周期操作只等待该群已领取 submission 的 `committed`，并在短临界区最终复核 Task；不使用一把全局锁包住模型等待。
- 退订沿用 `group tail → task tail` 锁序，持久化移除成功后再解绑并在锁外 dispose Resident。
- Task 通知和历史导入从首次等待 Resident 前进入每群 operation 跟踪；生命周期切换先建立 transition，再等待已登记操作收口，切换后到达的操作重新读取当前 Resident。
- 首次与后续完成通知共用 `taskResultOutboxKey()`；补发扫描全部具备 completed result 的任务，避免状态先完成、通知后失败时遗漏首次完成。
- Outbox 持久化是工具成功边界；其后发送监听器失败单独记录，不能反向否定已落库的 Decision。

## 重要信息

- 当前 `group_decision_submit` 的同步校验可作为 claim 线性化点，但实际 Outbox 位于后续异步提交段。
- `blockTaskDecisionForUnavailableMedia()` 可能把空回复任务判断转换为非空提示，门禁必须检查 effective Decision。
- 本轮只保证进程内的顺序；claim 到 Outbox 之间进程崩溃仍不具备持久事务恢复语义。
- observed 但未提交的请求已经 Steer，不会二次投递；它只保持 pending，供可靠回复后的下一 step 继续处理。
- 普通 Decision 的 Outbox 写入失败沿用既有 `decision-failed` 不自动重放边界，因为 Task 动作可能已经提交；本轮不把它错误包装成成功，也不以重挂 request 冒险重复动作。

## sub goal 进展

- Round 1：五项子目标全部完成；30 个验收项全绿，详见 `round-1.md` 与 `report.md`。
