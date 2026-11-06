# 任务统筹决定历史与消息恢复

`GET /state/tasks/:taskId/decisions` 沿现有受保护的 `/state` 读取入口，返回该任务历次已接纳决定，按新到旧排列。查询不会唤醒或续办任务。

| 查询参数 | 约束 |
|---|---|
| `limit` | 默认 20，整数 1–100 |
| `before` | 可省略；继续分页时传上一页 `nextBefore`，必须为正安全整数 |

```json
{
  "taskId": "task-id",
  "decisions": [{
    "id": "original-command-id",
    "sequence": 123,
    "taskId": "task-id",
    "sessionId": "owner-session-id",
    "leaseEpoch": 3,
    "requirementRevision": 1,
    "controlRevision": 1,
    "contextRevision": 0,
    "recordedAt": "2026-10-21T00:00:00.000Z",
    "triggers": [{"wakeId": "wake-id", "kind": "execution.progress.review", "executionId": "original-execution", "inputVersion": 2, "leaseEpoch": 2, "lastSequence": 42}],
    "decision": {"action": "wait", "summary": "首次发现范围偏离，已反馈原执行，下一次核对目标产物。", "evidence": ["原记录第42条"], "limitations": ["反馈进入模型步骤尚不证明已落实"]}
  }],
  "nextBefore": 123
}
```

`nextBefore=null` 表示没有更早记录。游标基于不可覆盖的命令收据序号，新决定插入不会移动旧页边界。不存在任务返回 404，非法页长/游标返回 400。`sequence` 是存储游标，不是模型日志序号；执行日志定位使用 `triggers.lastSequence`。

完整 `decision` 保留 summary/evidence/limitations 和实际存在的 question/audience/attemptedActions 等字段。wait、人工介入、完成、任务对话回复均与原状态变更在同一事务存储；失败提交不伪造已接纳决定，原调用和失败仍在统筹日志中。同命令重试不新增历史。

统筹使用 `task_decisions_read({limit,before})` 读取同一接口数据，Host 将任务固定为当前受信 binding，不接收模型提供的其他 taskId。历史不自动注入每轮上下文；`lastDecision` 仍用于最新进展。

上线前的决定保留在原命令收据和原统筹日志；没有 `taskDecision` 结构的旧收据不从旁支快照猜测补录，空列表不代表旧任务没有历史。新增部分索引只提高读取效率，不删除或迁移旧收据。回退旧版代码不会删除这些历史，但旧版后续新决定不具备此查询结构。

## Router 回复与通知路由

以下是模型工具 `router_submit` 的回复合同，不是 HTTP 重试接口的请求字段。`reply=null` 表示不回复；回复对象保留 `sourceId`、`text`、`review`，可带原完成附件的 `completion`，并复用通知字段 `replyToMessageId`、`atOpenDingTalkIds`、`atAll`。

`sourceId` 是业务来源与失败恢复锚，不决定显式引用或全部收件人。显式通知字段只使用同群、完整已读、当前版本及作者匹配的来源身份；引用作者必须在所选收件人中。填收件人并省略 `replyToMessageId` 表示不引用，显式空收件人数组表示不提及。`atAll=true` 与引用、非空成员提及互斥。三项通知字段全省略时保留当前来源定向默认；私聊不得指定成员提及或全群通知。不能按显示名猜 ID、默认加入所有历史参与者或用正文手写提及。

正文与路由校验在 `routerCommit` 和 Task 动作前完成，非法候选可在原模型轮次修正。Host 将选定路由及其来源证据冻结在原 reply application 与通知参数中；发送、Outbox 投影、原生回读及严格未发送证明均使用这个实际目标，业务来源不覆盖显式路由。恢复不得换 operation/notification ID 或修改原参数，unknown/starting 仍只对账。

## 消息处理投影与精确恢复

新消息直接使用 sourceId、messageId 和消息版本关联 Task，不创建 Topic/Unit。消息列表中的 `processingState` 为 `routing/failed/processing/processed/unknown`；首筛未结束为 routing，尚未完成来源处置时，Router 排队或恢复尝试中为 processing，精确来源持久处置后为 processed。来源已处理、Task 业务完成和通知 delivered 是三种独立事实。

来源的 `directProcessing` / `processingCompleted.mode="direct"` 提供不可变处置时间，HTTP 据此给出 `processingCompletedAt` 和语义历时，不以恢复时间、通知 ACK 或 Task 状态补造。来源已 processed 后仍可发生后续 Host 回复失败；保留 processed 及原处置时钟，同时显示独立失败和恢复信息。`processingRetrying=true` 表示尝试进行中，不代表成功；本次 token 已消费时不再提供恢复按钮。

当前可尝试恢复的列表描述符为 `processingRecovery`；详细投影的 `processingFacts.recovery[]` 使用同一身份结构：

```json
{
  "sourceId": "original-source-id",
  "messageId": "original-message-id",
  "messageVersion": 1,
  "phase": "host",
  "role": "application",
  "requestId": "original-request-id",
  "retryToken": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

阶段/角色映射为 routing/triage（轻量首筛）、decision/router（常驻 Router）、host/application（Host 应用）。详细 `processingFacts.issues[]` 保留 phase、role、status、requestId、attempt、code、failurePhase 及精确来源身份；status 为 failed/retrying。仅匹配同一来源、消息和版本的记录进入当前投影。首次创建原生会话失败也可持久登记恢复身份，不要求已经存在 sessionId。

旧 Topic/Unit 记录继续只读投影原证据，可能保留 needs_clarification、原问题及旧格式 `{phase,requestId,token}`。这些不是新消息运行合同，不恢复旧 Topic/协调模型。旧 Topic 已真实完成但异步来源结算中断时，启动恢复只补原来源结算，保留原 Task、决议、成功 receipt 和已送达通知，不重新判断或发送。历史缺少完成时间的记录保持缺失。

### 收件

`POST /config/groups/:groupId/messages/:messageId/retry`，路径身份按 URL component 编码，严格请求体：

```json
{
  "messageVersion": 1,
  "activeUnitRefs": [],
  "phase": "host",
  "requestId": "original-request-id",
  "token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`messageVersion` 为正整数；新来源的 `activeUnitRefs` 为空数组，不创建事项中间层。HTTP 保留该数组字段的严格格式校验：若存在元素，其 unitRevision 为正整数且 pair 不重复，但旧 Topic/协调请求不会因此获准重放。phase 仅接受 routing/decision/host；coordination 与 coordination-context 返回请求格式错误。token 使用最新描述符的 retryToken，必须是 64 位小写十六进制。禁止额外字段，不接收正文、来源身份覆盖、payload、Task 或新请求 ID。

服务按同群、消息版本、routing epoch、阶段、原 requestId、token 和失败状态持久 CAS；旧 token、错身份和并发重复消费拒绝。先解决真实启动/执行阻断，再沿原来源及原动作/receipt 恢复；未知外部效果沿原 operation/notification 对账，不换 ID 重试。旧来源缺少当前 Router 准入凭据时保持待对账，不能使用此入口重新入站。

旧回复的来源变为同群、同消息、同作者的严格更高版本后，旧 token 继续失效；后台只沿原回复的 prepare/退役 CAS 补账，真实 ACK 后才清原失败。当前版本失败继续要求显式重试，不自动重放 Task 动作，也不退休或重发 unknown/starting/delivered 通知。

非回复的 Task 应用若已在 SQLite 取得成功 receipt、却在 Resident ACK 前失败落账，随后同作者来源升版，旧 token 仍失效。公开恢复只允许沿原 operation/command ID 和完整原参数核对该成功 receipt，完成原应用的必要收尾及 ACK 后才清原失败；不重复执行 Task reducer。无 receipt 保留未结算，查询异常或参数 digest 冲突不放行；来源升版本身不授权旧动作或新副作用，不能按 taskId 直接标记成功。

成功响应 200：`{groupId,messageId,requestId,status:"attempted"}`。未修复的真实故障仍可能返回失败并留下新失败身份/token；不能把 attempted、一次调度或来源 processed 当作 Task completed 或通知 delivered。应分别回读精确来源、失败记录、Task 和通知事实。

### 发件

Outbox 的 `notificationRecovery` 为 `{action,expectedToken,reason}`，action 是 `send/readback/null`。`POST /config/groups/:groupId/notifications/:notificationId/retry` 严格只接受 `{expectedToken}`。

prepared 可 send；failed 必须无 ACK/receipt、有严格持久原生未发送证明且可重试；unknown/starting 只能原生 readback，不能把超时当未发送；delivered/superseded/退休/撤回不恢复。自动与手动复用同一发送门禁和原 notification 幂等身份；查询结果过期且无既有许可时，原生许可事务拒绝旧事实，由既有自动刷新重新冻结后再尝试。manual 释放串行槽会继续自动 drain，但本轮不再次盲试刚尝试的条目；来源暂缓由后续完成事实唤醒。

成功响应 200：`{groupId,notificationId,status:"attempted",action}`；原生来源门禁暂缓时另有 `sourcePending:true`，本次未发送。operator 私有通知不通过群恢复接口暴露。响应不含正文、payload 或原生凭据。

### 身份与错误

两接口必须来自受信本机 socket、Host 和 Origin；CAS token 不是认证。403 `TASK_LOCAL_IDENTITY_REQUIRED`；非法 JSON/额外字段/错误格式为 400 `MESSAGE_RECOVERY_REQUEST_INVALID`；不存在群通知为 404 `TASK_NOTIFICATION_NOT_FOUND`；旧态、并发、禁止、冻结及不可用为 409 的 `MESSAGE_RETRY_*`、`TASK_NOTIFICATION_RECOVERY_*`、`DYNAMIC_NOTIFICATION_RECOVERY_*` 或受限协调错误码。其他外部鉴权、网络、业务错误统一 409 `MESSAGE_RECOVERY_BLOCKED`，不透传敏感详情。先解除阻塞并刷新，再决定是否重试；200 不表示已完成或已送达。
