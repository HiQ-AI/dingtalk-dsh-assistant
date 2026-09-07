# 验收报告

## 结果

round-1 全绿。常驻会话的重复历史注入已改为按需读取，本机 DSH Web 已加载修复包和 `@zzusp/dsh-compaction-convergent@0.1.1-rc.2-convergent.6`，原 Resident Session 正常恢复。

## 已验证能力

- 普通群判断和 Task 通知不再内嵌历史回复候选正文；只有非空回复前才按请求读取不可变候选快照。
- 系统提示只保留 Task 摘要索引；完整目标、验收标准、消息和参与人时间线按 Task ID 获取。
- 请求 ID、Task ID、群归属、重复值和读取数量均失败关闭，读取工具不产生 Task、Outbox 或撤回副作用。
- 最近 30 条真实状态重放的新 Steer 中位长度为 244 字符且候选正文零泄漏；Task 索引由 46,697 降至 8,082 字符。
- 全量测试 183/183；安装源码哈希一致；本地 Runtime、DWS bridge、Web 和原 Resident Session 均正常。
- 最近消息的真实 DWS 内容、Task 时间线与 Outbox 已逐项复核，没有需要补发或纠正的处理。

## 边界

未主动向业务群发送测试消息；部署后首条自然群消息的实际 Session 事件体积不在本轮人为制造。
