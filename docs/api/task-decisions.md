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

## 消息处理投影与精确恢复

`GET /state/groups` 及群详情的消息保留 `processingState`（`routing/failed/processing/needs_clarification/processed/unknown`）与精确版本 `processingFacts`。独立协调当前仍有澄清项且其他事项已完成判断时为 `needs_clarification`；其他事项未完成判断仍为 `processing`。`processingConclusion` 合并当前事项的真实 Topic 结论及同版本、同预约代的协调问题/接纳事实，不使用通知正文。待澄清保留已有完整语义决策戳的 `processingCompletedAt` 和语义耗时，缺戳仍为 null；该时间不代表来源已收束、通知送达或业务完成。澄清被正式补齐后不再展示旧问题。新增 `issues[]` 仅含 `phase/code/status/requestId/attempt/retryAt`，phase 为 `routing/decision/host/coordination`，status 为 `failed/retrying`。请求耗尽、当前 Host 阻塞及协调耗尽按原消息版本、当前事项及原 owner 投影；startup 补偿与自动退避不冒充终态。后来完成覆盖旧失败，多话题未完成 owner 不被另一成功遮住。失败的 `processingCompletedAt=null`、`processingFacts.semantic.quality=missing`，不得补当前时间或数字完成历时。

语义完成时钟只取不可变事实。新的 Topic decision 在首次合法完成事务写入 `completedAt`；重复 `completeTopicDecision` 直接返回原记录，不更新该字段、`updatedAt`、Topic 或持久存储。历史已经 completed 但缺少 `completedAt` 的记录保持缺失，不以恢复时间或旧 `updatedAt` 回填。当前精确来源 `processingCompleted.at` 在所有当前事项完成判断后落一次，HTTP 优先使用此戳；仍须通过 activeUnitRefs 匹配及当前 Topic 完成门禁。有精确来源记录但尚未落当前 `processingCompleted` 时保持完成时间缺失，不先展示 Topic 数字再切换到迟到来源戳。仅完全没有精确来源记录的旧投影，才在所有相关首个完成决定都有真实 `completedAt` 时取最大值；`updatedAt` 仅用于记录更新诊断。来源戳早于任一已知不可变决定终态属于证据矛盾，`processingCompletedAt=null`、语义耗时 missing，不硬凑数字。通知 ACK/送达、来源 routedAt、重复恢复及后续 Topic 更新均不推进本条语义时间；历史首次来源戳即使本来较晚也不倒写为推测的更早完成时间。

安全恢复描述符为 `processingFacts.recovery[]`：`{phase,requestId,token}`。描述符只表达当次可尝试路径，不是业务授权或成功承诺。Host 仅允许已知来源准入的副作用前失败，或动作全部落账且已存在原 Outbox 身份的冲突；未知效果不提供恢复描述符。

### 收件

`POST /config/groups/:groupId/messages/:messageId/retry`，路径身份按 URL component 编码，严格请求体：

```json
{
  "messageVersion": 1,
  "activeUnitRefs": [{"unitId": "current-unit", "unitRevision": 1}],
  "phase": "decision",
  "requestId": "original-request",
  "token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

版本与事项 revision 为正整数；事项 pair 不能重复，未归类原消息可为 `[]`。`phase` 为 `routing/decision/host/coordination/coordination-context`，`token` 必须来自最新 GET 的 64 位小写十六进制凭据。禁止额外字段，不接收正文、群身份覆盖、payload、Task 或新请求身份。

服务验证精确消息版本、activeUnitRefs、原请求/决策/预约及 CAS；Resident 同群串行队列在持久更新前复验。协调沿原 reservation generation 与 ledger fence 恢复，冻结、已接纳、已澄清、已解决或移交不能清预算重来。成功响应 200：`{groupId,messageId,requestId,status:"attempted"}`。不复制原消息，不重做已成功动作；完成、来源收束和通知仍从各自事实回读。

`coordination-context` 是明确触发的旧引用遗漏修复，不使用协调失败重试预算。仅原预约未保存 quotedMessage、精确原来源确有完整 quote、当前仍待澄清且没有成员/日程/发生项/作业或接纳效果时允许。令牌绑定来源 ID/版本、原引用字节、activeUnitRefs、预约代、ledger fence 和原安排修订；本机接口再次核验来源作者与群，不接收调用人补写引用。事务将原 ledger fence 加一、改回 reserved，旧语义戳移入 processingHistory，并保留旧问题和所有通知回执；精确旧澄清若仍 prepared 且没有领取/发送/ACK/receipt 证据，同事务退休为 superseded 并保留 payload；已送达记录逐字不变；starting、unknown、已 ACK 或其他发送未明状态拒绝重判，先正常核验。新接纳通知独立发送，不因同来源修复退休。Resident 原预约变为 reserved，generation 不变并记审计。后续只重判同一来源并复用原安排，不重新入站、不全量扫描、不重复发送旧问题、不清 attemptCount 或 nextRetryAt。已规划中的群、运行冻结、CAS变化或已有业务效果均拒绝；200 只表示已请求重判。看板按钮为“重新核对引用”。

任务Topic适配器在首次决定完成时通过既有 `onInputSettled` 回调推动来源投影；该投影纳入服务的 `whenIdle/close` 等待集合。来源所有当前事项确已完成后即可落戳，不等待同群其他Topic或通知回读排空；投影失败进入诊断，成功重试清除诊断。

### 发件

Outbox 的 `notificationRecovery` 为 `{action,expectedToken,reason}`，action 是 `send/readback/null`。`POST /config/groups/:groupId/notifications/:notificationId/retry` 严格只接受 `{expectedToken}`。

prepared 可 send；failed 必须无 ACK/receipt、有严格持久原生未发送证明且可重试；unknown/starting 只能原生 readback，不能把超时当未发送；delivered/superseded/退休/撤回不恢复。自动与手动复用同一发送门禁和原 notification 幂等身份；查询结果过期且无既有许可时，原生许可事务拒绝旧事实，由既有自动刷新重新冻结后再尝试。manual 释放串行槽会继续自动 drain，但本轮不再次盲试刚尝试的条目；来源暂缓由后续完成事实唤醒。

成功响应 200：`{groupId,notificationId,status:"attempted",action}`；原生来源门禁暂缓时另有 `sourcePending:true`，本次未发送。operator 私有通知不通过群恢复接口暴露。响应不含正文、payload 或原生凭据。

### 身份与错误

两接口必须来自受信本机 socket、Host 和 Origin；CAS token 不是认证。403 `TASK_LOCAL_IDENTITY_REQUIRED`；非法 JSON/额外字段/错误格式为 400 `MESSAGE_RECOVERY_REQUEST_INVALID`；不存在群通知为 404 `TASK_NOTIFICATION_NOT_FOUND`；旧态、并发、禁止、冻结及不可用为 409 的 `MESSAGE_RETRY_*`、`TASK_NOTIFICATION_RECOVERY_*`、`DYNAMIC_NOTIFICATION_RECOVERY_*` 或受限协调错误码。其他外部鉴权、网络、业务错误统一 409 `MESSAGE_RECOVERY_BLOCKED`，不透传敏感详情。先解除阻塞并刷新，再决定是否重试；200 不表示已完成或已送达。
