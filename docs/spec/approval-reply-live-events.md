# 钉钉授权回复实时生效

## 症状

授权或人工处置申请已经通过 DWS 发送到钉钉本人单聊，并持久化真实 `conversationId`、申请消息 `messageId` 与 `sentAt`。真人在钉钉引用该消息回复后，申请仍停留在 `waiting-reply`，任务不会恢复；随后只能在 Web 授权中心再次操作。

## 根因

Runtime 只为来源群建立 `event +listen-im --kind group` 实时订阅。本人单聊中的授权回复不进入该订阅，而是由定时轮询执行两条历史查询：

1. `chat +search-msg` 按 blocker request ID 搜申请正文；搜索结果不保证包含正文不含 request ID 的引用回复。
2. `chat +chat-messages` 按审批单聊 `conversationId` 和时间范围读取回复；当前真实 profile 对 2026-09-02 的审批会话返回 `complete=true` 但 0 条，而同一申请已通过发送状态取得真实消息 ID。

因此发送成功不等于回复可被轮询回读。轮询链路没有收到引用回复，自然不会调用 `resolveHumanBlocker`。

另有同根因缺陷：非 `redline` 人工处置回复在轮询路径中以 `decision=undefined` 调用 Runtime，但 Runtime 要求所有 human blocker 都有明确 decision，导致即使找到回复也无法恢复任务。

## 修复方案

使用 DWS 原生个人 IM 实时事件建立独立的 `all-direct` 订阅：

- 只消费 message 事件，要求存在非空正文、回复消息 ID和 `quotedMessage.messageId`。
- 使用引用的申请消息 ID在当前 `waiting/human-intervention` Task 中精确匹配 blocker；不按文案、发送人展示名或时间窗猜测。
- `redline` 仍只接受明确的“批准/同意”或“拒绝/不同意”；其他文本保持等待。
- 非 `redline` 的引用回复代表真人已经提供处置意见，统一以 `approved` 恢复任务，并把完整原文交给叶子重新核验。
- Runtime 现有幂等和状态检查仍是最终门禁，重复事件不会重复恢复任务。
- 历史轮询保留作为进程离线窗口的恢复路径，并同步修正非 `redline` decision。

个人 IM listener 具备与群 listener 等价的 ready、异常、重连和关闭语义，并进入 `/health` 的 DWS bridge 健康快照。若个人 listener 未 ready，不能继续报告 `inboundProcessing=true`，避免群监听健康掩盖审批回复链路不可用。

## 不采用的方案

- 不扩大关键词搜索：无法知道真人回复正文，也不能证明搜索结果包含引用关系。
- 不把群 listener 改成 `all-direct`：群业务消息与审批单聊是不同路由，混合会把私人消息误送入群 Decision。
- 不放宽为任意单聊文本批准：只接受精确引用当前 blocker 消息的回复，授权边界保持 fail-closed。

## 验证范围

- Adapter 参数编译和 ready/NDJSON 生命周期。
- 实时个人引用回复：redline 批准、redline 非明确决定、非 redline 处置、无引用/错误引用忽略、重复事件幂等。
- 个人 listener 启动、退出重连、健康快照与关闭。
- 历史轮询非 redline decision 修复。
- 全量测试、打包内容、安装文件哈希与本地 Runtime health。
- 真实钉钉历史接口当前缺失记录作为根因证据；修复后的真实回复 E2E 需要新的 pending 申请和真人引用回复，不能用模拟事件冒充。
