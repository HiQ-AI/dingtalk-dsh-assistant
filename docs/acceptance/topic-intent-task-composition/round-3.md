# 第三轮：本地真实消息复核

2026-09-24 对 `msg2DFvyVcXDxI` 与 `msg7mPEpufwzaJ` 做本地重处理时，发现旧运行已送达澄清通知，但重处理入口未核对通知外部效果，导致同一来源再次发出回复；第二条短指代消息先失去关联上下文，随后又错误拒绝建任务。矩阵 R01 为第一条消息无重复回复且查证账号问题，R02 为第二条消息关联原话题并正确续办；两项真实业务验收均失败，不能标记为通过。

修复后，`message.reprocess` 在通知已尝试发送时拒绝重跑，并在允许重跑时原子封存尚未领取的旧通知；同话题意图重判也检查已尝试通知。`node --test test/message-ledger.test.js test/message-workflow.test.js test/workflow-service.test.js test/workflow-engineering.test.js` 返回 124/124 PASS。修复包安装后，源码与安装版 `message-ledger.js` SHA256 均为 `48147F59D155F6428FFC7B4A432E81D75BAFB8A30301AD765C62EE7140673672`；本地 3080/18998 属于同一新进程，18998 `/health` 返回 `status=ok`、`recoveryIssueCount=0`。重启前后通知状态计数均为 acknowledged 1、delivered 36、superseded 1。

`clarify-111e94` 已有钉钉发送成功回执，但缺少独立送达回读；不可把它判作未发送或再次发送。此前错误回复仍在群里，账号问题也未取得账号记录或创建日志。此轮只完成防重修复和本地运行核对，不重播两条消息，不将业务结果改为 PASS。
