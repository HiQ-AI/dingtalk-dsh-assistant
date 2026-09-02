# Task reopen 独立执行轮次

## 目标

同一业务 Task 在收到新增范围或结果纠正后继续复用 `taskId`，但 reopen 必须像新建任务一样初始化干净的执行轮次，避免旧 Session、Goal、计划、阻塞和结果污染新目标。

## 当前问题

- reopen 复用原 `childSessionId`，叶子会话仍携带上一轮历史判断和计划。
- Goal 仅在旧 Goal 为 `complete` 时重建，异常状态可能恢复旧 Goal。
- 来源、验收要求、阶段任务、活动和结果没有轮次边界。
- 当前阻塞与等待结果可能继续留在 Task 上。

## 方案

- `running` 或 `waiting` Task 的新增信息一律使用 `task-context`，保持同一轮次；只有 `completed`（含已归档）Task 才允许 reopen。
- Task 增加 `runSequence`、`runStartedAt`、`acceptanceCriteria`、`stageTasks` 和 `runHistory`。
- 新建任务初始化第 1 轮；reopen 将当前轮快照写入 `runHistory`，然后初始化下一轮。
- reopen 保持原 `childSessionId` 以延续同一任务上下文，但必须创建全新 Goal，并把当前轮目标、验收标准和阶段任务明确注入同一叶子 Session。
- 当前轮目标、兼容来源字段、验收标准和阶段任务按新轮更新；`messageHistory` 跨轮按消息 ID 追加全部相关消息与发送人，其他历史继续保存在 `triggerHistory`、`objectiveHistory`、`relatedContexts` 和 `runHistory`。
- 清理当前阻塞、等待结果、完成结果和归档状态；历史审批仍保留在 `humanBlockerHistory`，但不继续作为当前 blocker。
- 完成通知继续按 `completionSequence` 幂等区分，完成门禁只审查当前轮目标与验收标准。

## 验证

- 新建任务第 1 轮字段完整。
- completed Task reopen 后生成新 Session、新 Goal 和第 2 轮元数据。
- 来源消息、发送人、目标、验收标准和阶段任务均为新一轮值。
- 旧 blocker/result/session 只存在历史，不成为当前状态。
- 旧轮结果不能通过新轮完成门禁，也不能生成完成 outbox。
