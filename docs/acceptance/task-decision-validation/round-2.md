# 第 2 轮：回复替换链

## 基线

用户现场纠正通知因 group_reply_replacement_not_delivered 阻塞；旧 pending 通知因 dws_recall_failed:1:1001 已重试超过 17000 次。部署前备份已存在此故障。另一普通引用回复 dws_reply_failed:1:1001 重试超过 7000 次。Task 输入和 Topic 均已接纳，此故障是投递生命周期问题。

## 已验证

- 全量 `pnpm test`：415/415 通过，0 fail、0 skipped。
- Runtime/真实 Store/Bridge 整合用例覆盖在途发送时替换、ack 落盘失败、迟到回执、两次重启，仅发送 old/new 各一次、旧实际消息只撤回一次。
- 替换图接纳前校验、未送达旧意图 superseded 不伪报未发送、链式继承、部分撤回失败、永久拒绝停止重试、瞬态错误三次上限均通过。
- 撤回成功但状态写失败测试保留 failed/待核验，不伪报 recalled。普通发送被服务端拒绝后持久 deliveryBlockedAt，启动/监听/周期不重复调用；正常读失败不当作明确发送拒绝。
- `node scripts/build-web-client.mjs` 通过。真实 Observer 脚本的隔离浏览器验证 9 类状态、键盘筛选和 390px 窄屏通过，pageErrors=0、真实 DWS 请求=0，截图已检查。
- 前端静态 strict audit 仅报告全项目缺 DESIGN.md、UX-CONTRACT.md 及 Canonical Map 三项基础契约；本轮仅修状态说明，不引入全站设计文档或重构布局，不声称全项目 Premium 合规。新增状态复用原 outboxDelivery、SelectMenu、tableStatusTag 和主题，不改视觉 token。
- 现场纯函数预检 388 Outbox，43 条存在有效后继，无引用缺失/环/分叉；v7 schema 45 Tasks，invalidRecords=0、strippedFields=0。

## 部署与现场

待部署 Assistant 和 Observer 固定包；不手工标 sent、不删记录。DSH 和其它依赖保持不变。待回读纠正通知实际 messageId、旧意图停止发送与撤回错误尝试计数停止增长。
