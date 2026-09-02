# 验收计划

## 症状

- 单个含回复的 Decision 已在 `submissions` 中提交当前请求，却因顶层未重复填写同一 ID 被判 stale，并显示 Failed 卡片。
- 后续自动重试虽成功，普通 Decision Outbox 没有引用和结构化 @ 元数据，DWS 退化为普通群消息。

## 根因

- 观察门禁重复要求模型表达“提交即已观察”的同一事实。
- 预期的 stale 控制流使用异常表示。
- Runtime 普通 Decision 的 Outbox 构造没有映射入站消息路由元数据。

## 修复

- 使用 submission 普通请求与显式 observed 的并集做观察校验。
- 为两个 Resident 回复工具增加 `accepted/stale` 结构化结果。
- 普通 Decision 从参与本批判断的最新有效入站消息构造 `replyToMessageId`、`replyToSenderOpenDingTalkId` 和 `atOpenDingTalkIds`。
- 同步提示词、README 和 fake model，避免继续诱导重复字段。

## 验证

以 `matrix.csv` 为唯一状态总表；每轮证据新增到 `round-N.md`，全绿后生成 `report.md`。验证分为 Runtime 聚焦回归、全仓测试、npm 打包、本地 profile 安装源码回读、运行态健康和可选真实群业务 E2E。
