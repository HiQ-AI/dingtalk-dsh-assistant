# 主会话与叶子会话内部检查点

## 问题

当前主会话会把新任务、群聊补充、目标修订、真人批复和结果驳回交给叶子；叶子只在 `completed` 或 `waiting` 时回传结构化结果。执行中缺少事件驱动的中间同步，主会话可能直到最终验收才发现目标理解、阶段范围或证据方向已经偏离。

## 目标

- 叶子在关键阶段向主会话提交结构化 checkpoint。
- 主会话只返回确认或具体纠偏，不把 checkpoint 发送到群聊。
- checkpoint 不代替最终结果，不改变 Task 状态，也不构成完成证据。
- 不做周期性心跳，不转发工具日志，避免内部沟通刷屏。

## 协议

叶子新增 `submit_task_checkpoint` 工具，字段为：

- `kind`：`plan-confirmed`、`stage-completed`、`scope-conflict`、`evidence-gap`、`risk-changed`。
- `stageTask`：`stage-completed` 时必填，且必须与当前执行轮次的阶段任务逐字一致，供看板计算进度。
- `summary`：当前理解或阶段结论。
- `completedItems`、`evidence`、`remainingItems`、`nextStep`。
- `needsCoordinatorDecision`：是否需要主会话裁决。

Runtime 持久化 checkpoint，将完整内容交给对应 resident 主会话。主会话严格返回：

- `acknowledge`：理解一致，叶子继续执行；
- `guidance`：存在目标、范围、验收或群聊新上下文偏差，并给出具体纠偏。

工具结果直接把主会话决定返回叶子。该链路不写 Outbox，不产生群消息。最终完成与等待仍必须使用 `submit_task_result`。

## 触发边界

仅在以下事件提交：首次形成可执行计划、一个有验收意义的阶段完成、发现目标或范围冲突、证据缺口会影响验收、风险发生实质变化。普通命令进度、等待流水线、重试和无新事实的状态不得提交。
