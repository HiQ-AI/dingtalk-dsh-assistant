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
| 本地部署及原通知正式对账 | PASS | round-7.md：PID62032，原通知 delivered、原 messageId、sendAttemptCount=1，health=ok、告警 0 |


## 2026-10-20 原成功发送回执确认送达

目标：原 openTaskId 查询 SUCCESS、目标会话与精确 messageId 回读一致即可确认送达；不以钉钉渲染正文作硬门槛；原未知通知只核验不重发。

| 子目标 | 状态 | 证据 |
|---|---|---|
| 精确成功回执与历史匹配分离 | PASS | 原成功任务绑定 ID/会话；无成功任务回执沿原严格规则 |
| 定向测试及真实原消息只读验证 | PASS | round-8.md：38 项定向测试；真实原消息 proof=send-receipt，writes=0 |
| 本地部署与原通知持久账回读 | PASS | round-10.md：PID70064；原消息 delivered、sendAttemptCount=1；health=ok、告警0 |

重大决策：按用户确认，精确成功发送任务的消息ID与会话足以证明送达；正文渲染和引用/@核验不再覆盖该送达事实。部署暴露宿主声明/安装漂移与必需peer缺项，按声明补齐后启动；永久部署检查在停机前拒绝宿主版本漂移或CLI装配失败。
