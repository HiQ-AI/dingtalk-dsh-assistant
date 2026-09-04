# 群判断异常空闲恢复与自身回复回读

## 现象

2026-09-04 09:29:03 至 09:29:17，同群连续三条消息 `#589`、`#590`、`#591` 均在约五分钟后落为 `decision-failed`，错误统一为 `group_decision_not_submitted`。其中 `#589` 是本插件此前写入 pending Outbox 的短引用回复，钉钉回读正文额外带有前导 `@孙鹏`；`#590` 是明确的新任务请求；`#591` 引用 `#589` 表示该旧询问无需处理。

## 根因与反证

1. Runtime 为每个 Decision 请求注册 `agent.whenIdle()` 观察器。Agent 活动结束时若请求仍 pending，当前实现立即判定未提交；当上一段 Agent 活动异常结束、而新 `steer` 仍留在原生 Inbox 时，没有再唤醒一个 Turn 消费这些输入。因此同一活动期间进入的三条消息一起失败。
2. `matchesOutbound()` 对正文不完全相等的消息要求期望正文至少 24 个标准化字符。短引用回复虽同时满足“当前登录人发送”和“引用消息 ID 精确相等”，仍因钉钉补充前导 `@` 而无法匹配，导致插件自己的回复进入 Resident 判断。
3. 不是 DWS 漏收：三个完整消息 ID、正文、发送人和引用关系都已持久化。不是 `task-cancel` schema 或取消速度问题：`#590` 未创建任何 Task，失败发生在结构化 Decision 提交之前。不是引用正文缺失：`#591` 已持久化 `#589` 的引用 ID 与完整正文。

## 修复

- 每个群只维护一个 pending Decision 空闲观察器。第一次空闲时如仍有 pending 请求，使用一个内部 `GROUP_DECISION_RESUME` followup 唤醒下一 Turn；原始 Steer 已被领取时可从 Session 上下文恢复，尚未领取时由原生 Inbox 在新 Turn 首步一并领取。
- 恢复 Turn 再次空闲后仍未提交，才将剩余请求标为 `group_decision_not_submitted`，避免无限重试和重复副作用。
- 引用回复已精确匹配 `replyToMessageId` 时，允许标准化后的实际正文包含期望正文，不再对短文本套用 24 字符门槛；无引用消息仍保留原门槛。
- 回补确认 pending Outbox 后，将历史 `failed` 或 `decision-failed` 自身消息修正为 `skipped`，从看板移除伪判断失败。

## 验证

- 并发构造多个 pending Steer，第一次 Agent 空闲后只产生一次恢复唤醒；在恢复 Turn 内提交 Decision 后，所有请求成功且不进入 `decision-failed`。
- 连续两轮均未提交时仍明确失败，证明恢复有界。
- 短引用回复包含钉钉前导 `@` 时，只有引用 ID 一致才命中 pending Outbox；错误引用不得命中。
- DWS 回补命中后确认 Outbox、把既有 `decision-failed` 修正为 `skipped`，且不得再次调用 Runtime ingest。
- 全量测试、打包、本地安装、重启与 Runtime/DWS 健康回读通过后，再精确重试本次仍需判断的 `#590`、`#591`。
