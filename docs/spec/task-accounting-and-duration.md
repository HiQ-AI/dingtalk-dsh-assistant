# Task 通用门禁与耗时拆分

## 目标

在不改变 Task 持续修订模式和 `completed` 运行状态语义的前提下，补齐两项通用能力：

1. 对所有 Task 创建入口执行与任务类型无关的元数据门禁。
2. 将 Task 当前执行轮次耗时拆分为总墙钟、排队、运行、等待、可测工具时间和未分类运行时间。

## 非目标

- 不因需求变更拆分 Task；同一目标的补充、修订和返工继续复用原 Task。
- 不新增分析、开发、部署、验收等状态；`completed` 仍只表示当前执行轮次结束，工作边界由完成总结说明。
- 不减少现有过程回执，也不改变群聊通知策略。
- 验收标准门禁不绑定任何任务类型、仓库、环境或交付形式。
- 本轮不实现远端消息、Resident、Task 和回执对账；继续观察本周真实运行情况后再决定。

## 方案

### 通用 Task 门禁

创建 Task 时统一校验：

- `title` 为 1–120 字的简洁标题，不能是来源证据信封；
- `objective` 非空，不能是来源证据信封；
- `acceptanceCriteria` 至少一项，每项非空；
- `sourceMessageId` 非空；真实消息来源必须能在当前群 Resident 中回读；人工来源必须使用 `web:` 前缀并显式提供提出人姓名和稳定 ID；
- `requesterName` 与 `requesterOpenDingTalkId` 均存在。

验收标准只要求“可逐项核验”，不内置开发、分析、部署等类型规则。

### 耗时拆分

Task 持久化状态变更时间线，记录 `queued/running/waiting/completed`、时间和执行轮次。当前轮指标：

- `wallMs`：本轮开始到完成或当前时刻；
- `queuedMs`、`runningMs`、`waitingMs`：按状态时间线积分；
- `toolMs`：按同一 call ID 的 `tool/call` 与 `tool/result` 配对计算；终结工具可能先把 Task 置为完成、再写入结果事件，因此允许已开始的调用由完成状态之后到达的结果闭合，但耗时只累计到 Task 完成边界；
- `unclassifiedRunningMs`：`runningMs - toolMs`，包括模型思考、编辑、验证组织和其他不可单独测量时间。

旧 Task 没有完整状态时间线或活动 call ID 时返回 `complete=false` 和缺失原因，展示层不得伪装成精确统计。

任务卡不展示执行轮次耗时拆分，避免诊断信息挤占任务浏览空间。`/state/task-timings` 继续保留给诊断消费者；使用 `unclassifiedRunningMs` 时，应将它解释为运行状态中尚未按工具调用单独计量的时间，不能将它表述为模型持续工作时长。

## 验证

- Store 单测覆盖创建门禁、状态时间线、对账派生和旧数据迁移。
- Runtime 单测覆盖 Task 创建、状态切换和工具活动 call ID。
- HTTP 与 observer 单测覆盖耗时拆分展示。
- 执行全量 `npm test`、打包检查，并在本地 Web 状态 API 验证真实返回。
