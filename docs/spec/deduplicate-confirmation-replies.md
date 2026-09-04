# 常驻会话确认回复去重与替换

## 问题

常驻会话目前只在回复提交时校验是否审阅了同一 step 中的 pending 群消息。它没有把历史 Outbox、历史回复所对应的真实群消息正文，以及当前回复是否属于过程确认，作为结构化提交条件。因此同一事项换一条消息、换一个引用目标或追加少量信息后，Resident 仍可能重复发送“已收到/继续处理”类确认，群内形成多条价值相同的回复。

现有“新消息与近期回复冲突时撤回”规则只是一条自然语言要求；Runtime 虽然已经注册 DWS 撤回器并能做撤回后读回校验，但普通群回复链路没有调用它。

## 目标

1. 每次非空群回复提交前，Resident 必须显式审阅当前可见的历史回复候选。
2. 候选必须携带旧回复对应的真实来源消息正文、引用正文、关联 Task 和 Outbox ID；同一事项由 Resident 综合正文、任务目标、上下文和时间线判断，不能由 Runtime 按引用 ID 或关键词直接判定。
3. 同一事项已经存在等价确认且没有新增必要信息时不再回复。
4. 新确认需要补全必要信息时，先撤回 Resident 自己此前发送且已读回确认的旧回复，再写入并发送一条合并后的最新确认。
5. 撤回目标不明确、尚未读回或撤回验证失败时 fail closed，不发送可能造成重复的新确认。

## 方案

### 回复审阅契约

为 Decision reply 和 `group_reply_submit` 增加可选 `replyReview`：

- `kind`: `confirmation`、`substantive` 或 `correction`；
- `reviewedOutboundIds`: 本轮实际审阅的全部候选 Outbox ID；
- `sameMatterOutboundIds`: Resident 根据真实内容判定为同一事项既有确认的 ID；
- `replaceOutboundIds`: 本次发送前需要撤回的 ID。

当候选非空时 Runtime 强制要求 `replyReview`，并验证审阅集合与候选快照一致、所有 ID 均来自当前群、替换集合属于同一事项集合。`confirmation` 在命中同一事项后若仍要发送，必须替换全部已识别旧确认；没有新增价值时应返回空 reply/ignore。`correction` 必须替换被订正回复；`substantive` 不撤回过程确认。

### 候选构建

候选从当前群未撤回的可靠 Outbox 构建，包含：

- 最近回复；
- 所有带结构化类型的历史确认回复；
- 与当前 Task 关联的全部回复；
- 根据当前真实消息正文做字符片段召回的历史回复。

字符召回只负责缩小候选范围，不能直接判定同一事项。最终判断仍由 Resident 阅读当前消息、旧回复来源消息正文、引用正文、Task 目标和群上下文后完成。新 Outbox 额外保存 `replyKind`、`matterSourceMessageIds`、`taskIds` 和 `replacesOutboundIds`，旧数据保持兼容并通过已有 source/replyTo/Task 时间线推导。

### 撤回与发送顺序

Runtime 只允许撤回 `status=sent`、存在 `deliveredMessageId` 且尚未撤回的自身 Outbox。依次执行：

1. 将旧 Outbox 标记为 `requested`；
2. 调用 DWS 撤回并确认历史中已不存在该消息；
3. 标记为 `recalled`；
4. 全部旧回复成功撤回后，追加新的可靠 Outbox。

任一步失败时记录 `failed` 并中止新回复。真人消息和非 Outbox 消息永远不进入撤回目标。

## 验证范围

- 同一 Task 连续补充只保留一条合并确认；
- 不同引用但真实内容属于同一事项时仍能替换；
- 引用相同但正文属于不同事项时不得误撤回；
- 等价重复确认保持静默；
- 历史回复尚未读回、撤回器缺失或撤回读回失败时不发送新确认；
- 结果、阻塞、回答等实质回复不被过程确认去重规则吞掉；
- 旧存储数据无需迁移，普通 Decision、Task 与 DWS readback 行为不回归。
