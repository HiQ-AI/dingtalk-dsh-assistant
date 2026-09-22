# 第10轮：部署后消息响应与性能投影

今日新消息在收件与路由后进入代理处理，`agentDeliveryStatus=delivered`仅表示内部交付。核对两条相关实质回复的Outbox，分别于2026-09-22 09:46:37和09:47:08 +08:00为`sent`，各有`deliveredMessageId`且`readbackRequired=true`。没有重放、修改或补发历史消息。

同时健康接口转为`degraded`，恢复问题为`performance-projection`：原生Domain的scheduler.update要求记录已存在，而新会话的`performance:<sessionId>`尚不存在。性能投影写盘失败未阻断群业务，但指标缺失且健康告警增长。原mock的update允许首次插入，因此旧测试未捕获。

修复：性能分区在串行队列内读取当前值，统一用scheduler.put原子写入；已有分区保留投影并继续累积。新增原生Domain首次写入、重启后续写回归；mock记录put的写键。`node --test test/performance.test.js test/performance-runtime.test.js`为13 PASS，`pnpm test`为515 PASS/0 FAIL。部署及健康恢复尚待验证。

CI首次和第二次均在原有审阅耗尽用例失败：fixture使用1ms重试，较快的CI runner在任务准备期间重试并撤销了请求身份。该用例改为200ms，仍验证三次耗尽与显式重试；定向用例1 PASS，全量515 PASS。前两次失败不归因于性能分区修复，CI最终结果需以新提交重跑。
