# 事项级任务授权边界

## 现状与根因

Topic 将原始消息拆成 unit，并用 `sourceRanges`、`contextRanges` 固定事项文本。#107 为恢复被 `ignoredRefs` 剥离的开头点名，让授权校验读取整条 `_sourceMessageText`。该做法使同一消息中 A 对 Agent 的点名也能授权明确交给其他人的 B；隔离反例 `@助理 请修复 A；@李四 请修复 B。` 在 #107 错误创建 B Task，#107 前会拒绝。

`contextRefs.quote` 只允许当前消息中的唯一片段。实测错误提交均把 `quotedMessage.content` 当作当前消息 `contextRefs`；引用消息已单独提供，改进提示和错误即可，不改变坐标契约。

## 修复方案

决策动作只检查自己的 `basisUnitRefs`。对每个 unit，从固定版本原文中读取该事项 `sourceRanges` 结束位置之前最近的明确指向：`@` 点名或 `cc:`；前一事项中的指向只在后文没有新指向时沿用。事项正文中的显式 Agent 名称继续按现有规则识别。指向其他人的 unit 禁止执行动作，除非后续属于该动作依据的消息直接引用原消息并明确转交 Agent。`new-task` 至少需要一个属于动作依据的 Agent 指向或有效方案确认。不得从同条消息的其他 unit 借用指向。

验证：原先被剥离的开头点名、同消息共享开头点名、A/B 分别指派、其他人称呼位于 ignoredRefs、引用消息纠正后成功路由与任务创建，并运行完整测试。保持 Domain 版本及既有数据结构不变。
