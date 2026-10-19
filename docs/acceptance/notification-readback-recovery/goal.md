# 通知回读恢复

| 子目标 | 状态 | 证据 |
|---|---|---|
| Goal 失败对账、原任务恢复 | PASS | 原 result seq65/turn end892；failed 保留 previousObservation；原 task/session 恢复 |
| 九条正文匹配和不重发验证 | PASS | 9/9 delivered、原 messageId 全部一致、发送次数均为 1 |
| 续办派发键冲突处理 | PASS | 新真实输入对应新请求 key；原 execution/session 不变，inputVersion=3，执行总数仍 3 |
| 本地部署与持久账本回读 | PASS | 原生 SIGINT、新 PID21016、包摘要一致、health=ok、recoveryIssueCount=0 |

详见 round-3.md。业务数据库核验仍由原执行负责，本记录不宣称业务任务已完成。

## 2026-10-19 有序列表分段编号回读

目标：修复顶层连续有序列表分段重置为 1 的回读差异，按原通知正式对账，发送次数不得增加。

| 子目标 | 状态 | 证据 |
|---|---|---|
| 原消息和发送状态核验 | PASS | 原发送 SUCCESS，精确消息可读，发送者/群/引用匹配；旧校验因列表编号拒绝 |
| 格式修复及拒绝反例 | PASS | 新增两用例在基线失败，修复后通过；数字/正文/顺序/代码围栏/身份差异拒绝 |
| 本地部署及原通知正式对账 | PENDING | 等活动业务执行自然排空后按 runbook 部署；unknown 仅回读不重发 |
