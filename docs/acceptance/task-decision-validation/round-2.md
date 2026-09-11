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

固定源码 `3c85ec4584c7a41346e14639d3e143071c058438` 的 Assistant/Observer 0.5.14 包已通过原生 CLI 安装；28 个非 package.json 安装文件与源码逐一哈希一致，其它依赖与配置未变。不手工标 sent、不删记录。

- Assistant tgz：136268 字节，SHA256 `C7A37E6779D87EC60D17FABAE7CEEA9C52B2B07DB11F6401C0CAABE2E89E450E`。
- Observer tgz：19553 字节，SHA256 `2A67DD8B502BA2F5BFB1320A0286C2B82A863DBB14A04BB44948D37F3918949B`。
- 备份 `C:/Users/64554/.dsh/backups/outbox-replacement-3c85ec4-20260911` 已独立列出存储、配置、lock 和 patch 文件。停机稳定预检 390 Outbox、43 条有效后继；重启后 Domain v7、46 Tasks、invalidRecords=0、strippedFields=0。
- 新 Runtime PID 1212992，同时监听 3080/18998；health=ok、recoveryIssueCount=0、DWS listener ready、backfill ok。认证首页 HTTP 200 且含 __DSH_BOOT__；隔离 headless Edge 实际打开运行看板、Outbox 与撤回待处理筛选，authenticatedUi/installedReplacementStatuses/recallFailuresVisible 均 true，截图已人工检查。
- 原纠正 `outbound-50b240c77234b0b5b1fc08614541e427` 已 sent，messageId `msgMKH5gUe38XFDPHAphNCDcg==`。独立 `dws chat +messages-mget` 回读 complete=true、failedCount=0、foundCount=1，创建时间 2026-09-11 14:38:43，正文与引用对象匹配；不是仅凭内部 sent 判断送达。
- 原被替换 `outbound-2e132af08a1610f388a1c5059cc58254` 为 superseded，后继为上述纠正，deliveryAttemptCount=17310。旧发送未知保留 recallError=replacement_delivery_unknown、recallAttemptCount=1、无 recallRetryAt。
- 另一普通回复 `outbound-6d4a7d47b6a983402c0902c0a2694b97` 保留 pending 与明确服务端拒绝原因，deliveryBlockedAt 已持久化，deliveryAttemptCount=7118。未改变其业务目标或手工重发。
- 从 14:38 到 14:40:47 的独立 Store 回读，上述 17310/7118 计数不再增长。原纠正 deliveryAttemptCount=150 亦稳定，历史计数未清零。
- 4 条可撤回旧通知已 recalled；7 条历史通知服务端返回 dws_recall_failed:1:1001，均 failed、recallAttemptCount=1、无 recallRetryAt。没有伪称撤回成功，也未猜测服务端拒绝原因；失败不再阻塞新纠正。

本轮 10 项 case 全 PASS。Provider 拒绝和历史发送未知属于保留的真实业务边界，不代表已成功撤回所有旧消息。实际业务任务保持原叶子继续，不将本轮通知修复等同 UAT3 业务交付。
