# 验收计划

## 症状与根因

每条 `[GROUP_MESSAGE_STEER]` 都重复内嵌约 15 KB 历史回复候选；常驻系统提示又展开全部 Task 的 `messageHistory`。两者使无须回复的消息也持续消耗上下文，并干扰后续群消息判断。

## 修复

1. Steer 和 Task 通知只携带候选数量，非空回复前通过 `group_reply_review_get` 按请求 ID 读取完整候选。
2. 常驻系统提示只保留 Task 摘要索引，关联前通过 `group_task_context_get` 按 Task ID 读取完整上下文。
3. 两个读取工具校验当前 Resident、群、请求或 Task 归属、数量和重复 ID，不产生业务副作用。
4. 更新用户文档和故障排查说明。

## 验证

- 定向协议测试与全量 `npm test`。
- 用当前 30 条消息和当前 Task 数据重放，比较修复前后输入体积并确认正文零泄漏。
- 三包打包、源码哈希和 profile 安装回读。
- 更新收敛压缩插件，本地重启后回读进程、端口、Web、Runtime、DWS bridge、原 Resident Session 和恢复问题。
- 按精确消息 ID 回读并复核最近消息的 Task、Outbox 和处理状态。
