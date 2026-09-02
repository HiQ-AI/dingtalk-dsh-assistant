# Task 消息与参与人时间线方案

## 目标

Task 必须持久记录与其相关的全部群消息，而不是只保留当前一条来源。每条记录包含消息 ID、原文、发送人姓名、发送人稳定 ID、时间、引用关系和所属执行轮次。叶子会话收到同一份按时间排序的来源事实；Task 完成或阻塞通知由常驻主会话基于完整时间线选择引用目标和需要通知的人，Runtime 不再机械使用最后触发人。

## 当前缺口

`relatedContexts` 保存的是给叶子的文本信封，无法直接用于路由；`triggerHistory` 只在创建或重开时追加单个当前触发。一个 Decision 同时处理多条消息、多个 Task 时，当前实现还会把整批消息信封传给每个动作。通知阶段的 `resolveTaskNotificationTrigger()` 最终只返回一条最近来源，并固定生成单人 `atOpenDingTalkIds`。

因此现有结构同时存在两个问题：Task 的结构化流程记录不完整；通知对象由时间位置决定，而不是由消息语义和任务参与过程决定。

## 数据模型

Task 新增可选 `messageHistory`。每项保存：

- `messageId`：群消息稳定 ID，作为去重键；
- `text`：进入 Task 时的原始正文快照；
- `senderName`、`senderOpenDingTalkId`：发送人快照；
- `occurredAt`、`quotedMessageId`：时间与引用关系；
- `runSequence`、`associatedAt`：关联到哪个执行轮次以及关联时间。

历史 Task 启动时只用能够可靠回读的 `triggerHistory` 和群消息补齐 `messageHistory`。无法证明关联的旧消息不反向猜测；新进入的关联消息必须完整追加且按 `messageId` 幂等。该字段是可选的向后兼容增量，storage domain 继续使用版本 6，不要求旧 JSON 状态迁移。

顶层 `sourceMessageId/requester*` 与 `triggerHistory` 暂时保留兼容旧数据、现有接口和执行轮次来源，但不再作为通知收件人的唯一事实。

## 多消息与多 Task 关联

`task-proposal`、`new-task`、`task-context`、`task-reopen` 动作必须携带 `sourceMessageIds`。常驻模型可让一条消息关联多个 Task，也可在同一批中给不同 Task 选择不同消息集合；为了覆盖“先询问、后确认”等跨轮流程，也可选择本群已持久化的历史消息。Runtime 校验每个 ID 都属于本群消息历史，并要求至少一条来自当前 Decision，再为该动作独立构造叶子来源信封和 `messageHistory`。

字段在 Decision 解析与工具 schema 中均为必填，空数组、重复 ID、不属于本群的 ID，以及完全不包含当前处理消息的历史集合都会在动作执行前被拒绝，避免用整批消息做隐式兜底而污染 Task。

## 通知路由

`[TASK_COORDINATION]` 向常驻主会话提供完整 `messageHistory`，包括正文和参与人。`group_reply_submit` 增加：

- `replyToMessageId`：从 Task 时间线选择一条最适合承接本次通知的消息；
- `atOpenDingTalkIds`：从 Task 时间线参与人中选择一到多人。

常驻模型根据本次结果影响、谁提出要求、谁补充范围、谁需要回答或采取后续行动来选择，不按“最后一条”硬编码。Runtime 只做真实性约束：引用消息必须属于 Task，@ ID 必须出现在 Task 参与人集合；`replyToSenderOpenDingTalkId` 由选中的消息记录推导，模型不能自行填写。

如果旧 Task 没有可用时间线，Runtime 才退回兼容来源；这个退化路径不能覆盖或伪造发送人。

## 边界

- 普通群聊即时回复仍引用当前 Decision 中由现有规则选择的消息，本方案只改变 Task 结果/阻塞通知。
- 不把所有群成员自动 @；是否通知由常驻模型根据完整流程决定。
- 不允许模型提供 Task 历史之外的消息 ID 或人员 ID。
- 不修改 DWS 引用回复协议、Outbox 幂等键或 Task 动作授权边界。
