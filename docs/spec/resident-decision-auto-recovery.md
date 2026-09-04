# 常驻会话判断自动恢复

## 现象与证据

故障现场的两条相邻消息已完整进入 Inbox，但都在 Runtime 重启前被标记为 `resident_restarted_before_decision_settled`；新 Runtime 在约两秒后就绪。消息正文、引用正文和发送人均未缺失，失败发生在结构化判断提交之前。

故障排查时持久化状态共有 9 条 `decision-failed`：3 条重启中断、5 条失效 Task 目标以及 1 条无效 JSON。它们虽然根因不同，但共同经过“未完成判断直接写入终态”的路径，只能依赖人工精确重试。

## 根因

1. Runtime 启动时把遗留 `steered` 消息直接改成 `decision-failed`，没有把持久化 Inbox 当作可恢复工作队列。
2. Resident 连续两轮未提交、工具参数 JSON/Schema 不合法、引用上下文暂时读取失败时，pending Decision 被拒绝后同样直接进入终态。
3. `task-context` 和 `task-reopen` 的目标有效性直到业务提交阶段才检查；模型使用失效 Task ID 时已经错过原地纠正和无副作用重试边界。
4. `decision-failed` 同时承载“判断尚未完成”和“判断已接受但业务提交失败”两种语义。后者可能已经创建 Task 或追加上下文，不能安全自动重放；前者可以安全重试，却被一并阻断。

## 修复

- 新增持久状态 `decision-retrying`。凡错误发生在业务副作用开始之前，都保存原错误、尝试次数和下一次重试时间，由 Runtime 监督器按指数退避自动重新投递原消息。
- Runtime 重启时把遗留 `steered` 转成到期的 `decision-retrying`；Resident、群配置和 DWS bridge 就绪后自动恢复，不再生成新的“判断失败”。
- `decision-retrying` 同时建立群内恢复屏障。该消息成功结算前，后续消息只进入持久化 Inbox，不再 Steer；恢复成功后严格按 `sequence` 逐条放行。屏障只作用于同一群，不阻塞其他群。
- 重试信封携带上次错误和尝试次数，要求 Resident 根据当前完整 Task 索引重新生成 Decision，禁止机械复用上次参数。
- 在 `group_decision_submit` 接受 Decision 前统一校验 `task-context`、`task-reopen` 和 `task-cancel` 的真实当前目标，使失效 ID 留在可纠正、可自动重试的无副作用阶段。
- 判断已经接受且 Task/Outbox 提交开始后的异常改记为 `decision-commit-failed`，页面展示“处理提交失败”。该状态不自动重放，避免重复任务或重复回复。
- 历史 `decision-failed` 中能证明未发生业务副作用的重启中断、未提交 Decision 和无效 JSON 会在启动时自动迁移到 `decision-retrying`；其他旧失败保留精确人工重试入口。新产生的可恢复判断错误不再进入旧终态。

## 验证

1. 重启遗留 `steered` 会进入 `decision-retrying`，随后按原群内顺序重新 Steer 并成功结算。
2. 未提交 Decision 会保留原消息、错误和重试时间，不进入 `decision-failed`；到期后监督器自动重试。
3. 重试期间 DWS 重复事件不产生第二个判断；成功后清除重试时间和错误。
4. 同群后续消息在失败消息恢复前保持 `pending`，恢复后按序进入 Resident；其他群不受影响。
5. 失效的 context/reopen/cancel Task ID 在工具接受前被拒绝，不发生任何 Task 或 Outbox 副作用。
6. 已开始业务提交后失败时不自动重放，状态与“判断失败”明确区分，并阻止同群后续消息越过它提交。
7. 两条本次真实失败消息在部署后通过现有精确重试入口重新进入新机制，并回读为非失败状态。
