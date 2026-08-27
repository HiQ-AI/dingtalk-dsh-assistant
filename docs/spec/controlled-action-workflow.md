# 受控动作与任务阻塞工作流

## 背景与问题

当前叶子任务只有 `completed` 与两类 `waiting` 结果。叶子不能直接操作来源群，但现有提示词没有明确禁止它判断“主会话应当如何处置自己发出的消息”，因此叶子把“撤回错误群消息”提交成 `waitingKind=human-intervention`。Runtime 收到真人批准后又只把批复文本转发回叶子，导致本应由 resident 主会话作出的消息生命周期决策在叶子与真人之间反复循环。

现有授权复用又以 `blockerCategory + requestedAction` 的完整文本计算指纹。即使实际目标始终是撤回同一条消息，只要叶子换一种表述，就会产生新的申请。真人在批复中表达“同类操作以后无需授权”也只作为普通文本注入叶子，不会形成 Runtime 策略。

这使三种不同事实被混在一个状态里：

1. 叶子没有渠道权限，需要 Host 代执行；
2. 动作确实需要真人授权；
3. 动作已获批准但尚未执行或执行失败。

## 目标

- 叶子只提交任务结果、结论、证据和置信边界，不判断主会话消息是否应发送、编辑或撤回。
- resident 主会话根据叶子结果和群聊上下文作出消息生命周期决策；Runtime 不用审批消息承载内部协调。
- 受控动作使用结构化身份、稳定幂等键和受限执行工具，不以自然语言作为授权身份。
- 真人批准后必须进入执行态；未经执行和回读，主会话不得声称消息动作完成。
- 同一个动作在执行中、已批准、已完成或失败时均不得重复创建申请。
- 明确哪些动作默认允许、哪些需要一次批准、哪些禁止执行。
- resident 主会话能收到不省略的叶子结果，并对自己发出的消息承担发送、编辑、纠正和撤回责任。

## 非目标

- 不允许叶子直接获得来源群写权限。
- 不把一句自然语言“以后都允许”扩展成跨群、跨动作、跨任务的无限授权。
- 不把动作执行成功等同于整个 Task 完成；叶子仍需按验收标准提交最终结果。
- 不用兼容分支保留旧的重复审批行为；迁移后只有一条规范路径。

## 核心模型

### Task Result

叶子结果仍只有 `completed` 与 `waiting`。任务完成时只表达业务事实：

```json
{
  "status": "completed",
  "summary": "重新核验后确认应使用 A 数据库与 B schema；此前结论不成立",
  "evidence": ["查询回执……", "代码位置……", "现场回读……"],
  "artifacts": []
}
```

叶子不知道也不需要知道 resident 曾发送哪些消息，更不得输出 `action-required`、目标 messageId、“建议撤回”或“请主会话撤回”。`human-intervention` 仅保留给完成业务任务本身确实需要真人输入或授权的事项，不能用于消息发送后的运营处置。

### Controlled Action

Runtime 为每个动作创建持久记录：

```text
actionId
taskId
type
target
canonicalKey
policyDecision
authorizationId?
state
attempts[]
readback
createdAt / updatedAt
```

动作状态机：

```text
requested
  -> validating
  -> denied ---------------------------> terminal
  -> awaiting-approval -> rejected ----> terminal
                      -> approved
  -> approved / auto-approved
  -> awaiting-resident
  -> executing
  -> verifying
  -> succeeded ------------------------> notify resident
  -> retryable-failure -> executing     (有界重试)
  -> failed ---------------------------> notify resident / keep task actionable
```

任何状态迁移都由 Runtime 持久化后再产生外部副作用。重启后从持久状态继续，不重复发送审批、不重复执行已经成功的动作。

## 稳定动作身份

`canonicalKey` 只由结构化字段生成，不包含 summary、reason 或 requestedAction 文案：

```text
group-message-recall:{task.groupId}:{target.messageId}
```

规则：

- 同一 Task、同一群、同一消息始终是同一个动作。
- `requested`、`awaiting-approval`、`approved`、`executing`、`verifying`、`succeeded` 状态下的重复提交返回原动作，不创建 blocker。
- `failed` 后重复提交继续原动作的重试/处置链，不新建审批。
- 目标消息变化才是新动作；原因文案变化不是新动作。

## 策略与授权矩阵

第一阶段只开放一个受控动作：`group-message-recall`。

| 条件 | 决策 | 原因 |
|---|---|---|
| 目标群等于 Task 来源群，目标消息可证明是本插件 Outbox 发出的消息，目的为纠正或撤销本 Task 的错误通知 | `auto-approved` | 属于插件自身消息生命周期管理，不需要真人批准 |
| 目标群等于 Task 来源群，但消息来源无法从 Outbox / deliveredMessageId 证明 | `awaiting-approval` | 防止撤回真人手工消息或其他系统消息 |
| 跨群撤回、目标群与 Task 无关 | `denied` | 超出任务来源和授权边界 |
| 只读查询、回读验证 | 不创建动作、不创建审批 | 本来就是叶子允许的只读能力 |

以后新增动作类型时，必须同时提供 validator、policy、executor、verifier 和测试矩阵；没有注册的动作一律拒绝，不能回退为自然语言审批。

## 执行职责

### 叶子会话

- 独立完成业务任务，提交完整结果、结论、证据、未验证项和置信边界。
- 不读取 resident 的 Outbox 来判断消息处置，不提交消息 action，不提供 messageId。
- 不调用来源群写工具，不决定授权策略，不因群消息仍存在而申请阻塞。
- 任务是否完成只由业务验收标准决定，不依赖 resident 后续如何处置群消息。

### Runtime / Host

- 将叶子完整结果交给对应 resident 主会话，不压缩掉结论变化、证据和未验证项。
- 对 resident 决定的动作校验类型、Task 归属、目标范围和稳定 ID。
- 计算 canonicalKey，去重并持久化动作。
- 根据策略自动批准、请求真人批准或拒绝。
- 只在真正进入 `awaiting-approval` 时生成一条私聊审批。
- 将已获准动作以结构化请求投递给对应群的 resident 主会话，并只向它暴露绑定 actionId 的受限执行工具。
- 主会话执行后，Runtime 必须进入 verifying，并以目标系统回读作为成功依据。
- 将结构化结果通知 resident 主会话，并与原 Task Result 分开留痕。

### resident 主会话

- 是来源群消息发送、回复、编辑和撤回的唯一会话级责任方；叶子只交付任务结果，不交付消息处置意见。
- 接收完整叶子结果，并结合当前群聊上下文、自己此前发送的 Outbox 和结论变化判断：无需动作、补充说明、更正、编辑或撤回。
- 判断撤回时由主会话选定自己发出的目标消息，再向 Runtime 创建结构化受控动作；不是把判断交给叶子或真人。
- 通过 `execute_task_group_action({ actionId })` 受限工具执行。工具从 Runtime 持久记录读取动作类型和目标，主会话不能改写 groupId、messageId 或授权范围。
- 不解析 requestedAction 后自行猜命令，也不得绕过 action journal 直接调用 DWS 完成该动作。
- 工具返回执行与回读结果；主会话负责判断是否需要向群内补发纠正说明，但不能把同一动作重新包装成真人审批。
- 当执行器不支持某动作或动作终态失败时，负责给出可读处置结论；不得再次把同一动作包装成真人审批。

### 真人

- 只处理策略判定为 `awaiting-approval` 的动作。
- 批复对象是稳定 actionId 与结构化范围，不是叶子的自然语言段落。
- “本次批准”只作用于 actionId；更广的策略变更必须有明确的结构化 scope 并持久化，不能从随口评论无限外推。

## 主会话决策工作流

```text
叶子提交完整 Task Result
  -> Runtime 原样投递给 resident 主会话
  -> resident 对照当前群聊和自身 Outbox 判断是否需要消息处置
  -> 无需处置：结束
  -> 需要处置：resident 创建绑定 Task + messageId 的结构化动作
  -> Runtime 校验来源、去重和策略
  -> resident 通过受限工具执行
  -> Runtime 精确回读并记录结果
```

“原结论被推翻”不必然等于“撤回”：如果后续对话需要保留上下文，主会话可以选择引用更正；只有主会话综合消息内容、传播影响和当前上下文后才能作出选择。

## 批复工作流

```text
真人引用审批消息回复
  -> Runtime 绑定 authorizationId + actionId
  -> 持久化 decision
  -> 撤回/关闭审批卡片
  -> approved: 立即进入 executing
  -> rejected: 结束动作并通知 resident，明确动作未执行
```

关键不变量：

- `approved` 后不允许仅向任何会话发送批准文本并视为完成；必须回到 resident 主会话执行动作。
- 执行成功前，resident 不得发布动作成功结论。
- 执行失败不重新申请同一授权。
- 真人回复中包含“以后无需授权”时，只记录为策略变更建议；由明确的策略接口落成 scope 后才生效。内置的“撤回插件自身错误通知”已经是 auto-approved，无需依赖这句话。

## 主会话撤回执行工具

### validate

1. `target.groupId === task.groupId`。
2. messageId 是稳定 DingTalk openMessageId。
3. 在目标群 Outbox 中找到 `deliveredMessageId === target.messageId`；记录对应 outboundId、sourceMessageId 和正文摘要。
4. 当前回读确认消息仍存在；若已经不存在，按幂等成功处理。

### dispatch

resident 主会话完成判断并创建动作后，Runtime 将动作推进到 `awaiting-resident`，向同一 resident 上下文返回：

```text
[HOST_ACTION_REQUEST]
Action: <actionId>
Task: <taskId>
Type: group-message-recall
Target group: <groupId>
Target message: <messageId>
Policy: auto-approved | approved:<authorizationId>
Decision evidence: <主会话对照叶子结果与原消息形成的理由>

请使用 execute_task_group_action({ actionId }) 执行。不得改变目标、扩大范围或再次申请相同授权。
```

Runtime 以 actionId 跟踪是否已经向 resident 投递；主会话繁忙时使用插话发送，不进入普通排队。重复恢复只重放未确认投递，不创建新动作。

### execute

resident 主会话调用 `execute_task_group_action({ actionId })`。Runtime 在工具入口重新校验：

1. action 属于当前 resident 的 groupId；
2. 状态是 `awaiting-resident`、可重试的 `executing` 或 `retryable-failure`；
3. policyDecision 是 `auto-approved` 或已有有效 authorizationId；
4. canonicalKey 未成功执行。

校验通过后，工具内部通过 DWS adapter 的 `recallMessage(messageId)` 执行；主会话拿不到可替换的 messageId 参数。这样消息撤回由主会话负责，但外部副作用仍受 Runtime 的幂等、授权和审计约束。

### verify

使用精确 messageId 回读：

- 不再返回消息：`succeeded`；
- 仍返回消息：进入 retryable-failure；
- 回读 partial/unknown：保持 verifying，不得宣称成功；
- 明确权限/时限失败：`failed`，保留真实错误并通知 resident。

### resume

成功后给 resident 主会话返回：

```text
[HOST_ACTION_RESULT]
Action: <actionId>
Type: group-message-recall
Status: succeeded
Target message: <messageId>
Execution receipt: ...
Readback: message absent

受控动作已执行并回读确认，不得再次申请或重复执行该动作。
```

消息处置结果不再回灌叶子，也不改变已提交的业务 Task Result，避免叶子再次对消息生命周期作出判断。

## 防循环约束

Runtime 在以下任一条件下拒绝创建新审批：

- canonicalKey 已存在非终态动作；
- canonicalKey 已成功；
- canonicalKey 已获批准但尚未执行；
- canonicalKey 执行失败且授权范围未变化；
- 请求内容是“请 Host 执行已批准动作”而非新的真人决策。

同一 actionId 最多发送一次有效审批消息。因迁移或页面操作需要重新签发时，旧申请必须先 supersede 并撤回，且 actionId 不变。

## 失败与恢复

- Runtime 重启：扫描 `approved/awaiting-resident/executing/verifying/retryable-failure` 动作；未投递的交给 resident，已投递但未执行的按 actionId 恢复，不重复审批；扫描 `awaiting-approval` 时只恢复监听，不重发已有审批。
- DWS 暂时不可用：指数退避并记录 attempt；不询问真人“是否重试”。
- 目标消息已不存在：幂等成功。
- 消息不可撤回：动作失败，resident 主会话收到真实原因，可选择发送纠正说明；不能把同一撤回动作重新包装成审批。
- resident Session 损坏：动作状态属于 Task/Host，不随会话重建丢失；新 resident 从 action journal 恢复未完成动作。

## 数据迁移

- 保留历史 humanBlocker 作为审计数据，不把旧 requestedAction 自动迁移成可执行动作。
- 对当前异常 Task，可从已知 Task、来源群和稳定 messageId 人工生成一次 canonical action；完成后把旧 blocker 标为 superseded，避免再次投递。
- schema 版本升级后，旧 Task 没有 actions 字段时默认为空数组。

## 验收矩阵

1. 叶子推翻旧结论：只提交完整新结论和证据，不出现撤回建议、messageId 或 human-intervention。
2. resident 收到结果后决定撤回本 Task 的插件 Outbox 消息：不发审批，执行一次并回读成功。
3. 未知来源消息：只发一条审批；批准后执行，不再次审批。
4. 批准后执行暂时失败：自动重试，不再次审批。
5. 批准后明确失败：resident 收到失败，不再次审批，不回灌叶子。
6. 人工拒绝：不执行，resident 收到 rejected 结果。
7. Runtime 在 approved、executing、verifying 各阶段重启：不重复审批、不重复成功动作，最终收敛。
8. 目标消息执行前已被人工撤回：按幂等成功。
9. 目标跨群：直接拒绝，不发审批、不执行。
10. requestedAction/summary 文案变化但目标相同：复用同一 canonical action。
11. 真人评论“以后无需授权”：不会形成无边界全局授权；内置自身错误消息撤回仍自动执行。
12. 当前事故复现：叶子只返回错误结论被推翻的证据；resident 独立决定一次消息处置，整个过程不产生叶子撤回申请和重复审批。

## 实施顺序

1. 收紧 Task Result schema 与叶子提示词，明确禁止叶子输出消息处置动作或建议；扩展 store action journal。
2. 增加 Runtime action registry、canonical 去重和状态迁移。
3. 为 resident 主会话注册 `execute_task_group_action`，工具内部接入 DWS bridge 的 recall executor 与精确回读 verifier。
4. 改造真人审批，使 authorization 绑定 actionId，批准后驱动 resident dispatch。
5. 将完整叶子结果交给 resident 决策，消息动作结果只返回 resident，不回灌叶子。
6. 加入迁移与当前异常 Task 的一次性收口路径。
7. 完成单元、重启恢复、DWS mock、当前事故回归和本地运行验证。
