# 群消息引用回复与观察冲突修复

## 现场结论

2026-09-02 15:24 的失败卡片不是 DWS 发送失败。Resident 已经生成回复并调用 `group_decision_submit`，但首个调用只在 `submissions[].requestIds` 中提交请求 ID，没有在顶层 `observedRequestIds` 再重复一次。Runtime 因而把本次请求自身判为 `missing` 并抛出 `group_decision_reply_observation_stale`。模型在下一 step 补齐字段后提交成功，Outbox 和 DWS 回读也均成功。

现场同时暴露出第二个独立缺口：普通群 Decision 写 Outbox 时只传 `groupId/sourceMessageId/text`，没有传 `replyToMessageId`、`replyToSenderOpenDingTalkId` 和 `atOpenDingTalkIds`。DWS adapter 因此选择普通群发送，而不是仓库已有的原生引用回复命令。Task 完成通知具备这些字段，普通回答和确认没有。

## 根因

### 观察协议把同一事实要求模型重复表达

`submissions[].requestIds` 已经证明模型审阅并决定了这些请求，但现有实现仍要求模型把相同 ID 再写入顶层 `observedRequestIds`。这个字段原本用于声明“已审阅但本批不提交”的其他 pending 请求，却同时承担提交请求自身的重复声明，增加了无业务价值的失败面。

真实 stale 是乐观并发协议的预期分支，不是工具参数或业务执行异常。当前实现通过抛异常返回，导致 DSH 把一次安全拒绝展示成 `Assistant Message / Failed`；即使下一 step 自动恢复，失败卡片仍会留在会话里。

### 普通 Decision 没有把入站来源映射到引用发送参数

入站链路已经保存了当前消息 ID、发送人 ID 和被引用消息 ID；Decision owner 也能定位参与本次判断的普通请求。缺口位于 Runtime 的 Outbox 构造：普通回复没有选择引用目标并传递结构化路由字段。后续 Store、Outbox listener、DWS adapter、原生 `chat message reply` 和回读校验均已支持这些字段。

## 修复目标

- `submissions` 中的普通请求天然计入已观察集合；`observedRequestIds` 只需补充本批已审阅但未提交的普通 pending，请求重复列出仍兼容。
- 提交瞬间存在真正未审阅的新 pending 时，仍然零副作用拒绝旧回复。
- stale 作为结构化工具结果返回，不再制造预期内的 Failed 卡片；模型必须在下一 step 结合缺失请求重生成并重提。
- 普通 Decision 的非空回复使用 DWS 原生引用回复当前被回答的入站消息，并结构化 @ 该消息发送人。
- 多请求合并时，以本 submission 中序号最新且具备稳定发送人 ID 的普通消息作为引用目标；这与最终回复所覆盖的最新补充一致。若缺少稳定发送人 ID，则保持现有普通发送，不能伪造引用参数。
- 被引用的历史消息 ID 继续只作为语义上下文和来源证据；出站应引用当前群成员的消息，而不是再次引用其所引用的旧消息。

## 协议设计

### Decision 提交

Runtime 计算：

```text
effectiveObserved = submitted ordinary request IDs U observedRequestIds
```

当 effective Decision 含非空回复时，将 `effectiveObserved` 与当前同群普通 pending 快照比较。完全一致才领取请求和执行副作用。`observedRequestIds` 继续允许包含已提交 ID，以兼容已经部署的提示和 fake model。

工具统一返回 `status`：

- `accepted`：返回已领取请求和剩余 pending。
- `stale`：返回 `missingRequestIds`、`unexpectedRequestIds` 和当前 pending；不领取请求、不执行 Task 动作、不写 Outbox。

schema、群归属、未知 ID、重复提交等真正的调用错误仍抛异常。

### Task 通知提交

`group_reply_submit` 没有 `submissions` 可推导观察集合，因此仍要求 `observedRequestIds` 覆盖全部普通 pending。真实 stale 同样改为结构化 `status: stale`，其余校验错误仍抛异常。

### 引用路由

对普通 Decision：

1. 从该 submission 的普通请求按 sequence 排序。
2. 选择最后一个同时具备 `messageId` 和 `senderOpenDingTalkId` 的消息。
3. Outbox `sourceMessageId` 继续使用 owner 消息保证稳定幂等键。
4. 设置 `replyToMessageId` 为引用目标的当前消息 ID，`replyToSenderOpenDingTalkId` 为其发送人 ID，`atOpenDingTalkIds` 为该发送人 ID。
5. DWS adapter 按既有分支调用 `chat message reply`，发送后回读必须同时匹配正文和 quoted message ID。

## 故障与边界

- 结构化 stale 仍依赖模型继续下一 step；若模型停止，既有 `whenIdle()` 兜底会把请求标为未提交失败，不会静默丢消息。
- Outbox 写入失败、Task 动作已执行后的不可自动重放边界不变。
- 本修复不把被引用消息正文当作当前请求，也不基于引用关系自动关联 Task；业务相关性仍由 Resident 结合上下文判断。
- 引用发送仍以 DWS 回读为最终渠道证据；工具提交成功只证明 Outbox 已可靠落库。

## 验证要求

- 复现现场参数：只提交一个含回复请求且省略 `observedRequestIds`，必须一次成功，不出现 stale。
- 提交请求自身自动计入观察，但另有未观察 pending 时，必须返回结构化 stale 且无 Task/Outbox 副作用。
- stale 后结合新增请求重提必须成功，旧候选不能发送。
- `group_reply_submit` 的真实 stale 也返回结构化结果并可重提。
- 普通单消息回复、引用入站消息、合并多消息、发送人 ID 缺失四类路由均有回归。
- Store、dispatch 和回读链路保持 `replyTo* / at*` 字段并选择 DWS 原生 reply 命令。
- 全量测试、打包、diff 检查和本地安装包源码回读通过。
- 本地部署后分别验证进程、监听端口、Web HTTP、Runtime health、DWS bridge 和状态 API；真实群业务 E2E 若未主动制造消息，则明确保留为未验证边界。
