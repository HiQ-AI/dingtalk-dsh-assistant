# Round 13：精确失败与恢复的修前反例

2026-10-26；分支 `worktree-inbox-failure-fix`，基线 `dc41f69f`。本轮续修不继承 PR260 的合并、部署授权。仅合成测试，不重放业务消息、不外发、不改业务账、不停止服务。

## 修前结果

本轮失败证据保留，不因后续通过覆盖。状态以权威根 `matrix.csv` 合法同步后的记录为准。

| 用例 | 实际结果 | 证据 |
| --- | --- | --- |
| 当前 request 耗尽及当前协调来源失败投影 | FAIL（2/2）：实际 processing，预期 failed | `round-13/projection-red.log:1` |
| 协调来源精确 reservation/generation 只读投影 | FAIL（1/1）：字段缺失 | `round-13/dto-red.log:1` |
| 收件原请求手动恢复、版本/Unit/token 与重复点击 | FAIL（1/1）：retryMessageRequest 尚不存在 | `round-13/manual-inbound-red.log:1` |
| 协调原来源的显式 CAS 重试 | FAIL（1/1）：retryEpoch 未消费 | `round-13/coordination-retry-red.log:1` |

## 缺陷与修复边界

- 群级 `agentDeliveryStatus=decision-failed` 不足以归因当前消息；必须核当前 message/version/active Unit/Topic/request/reservation。启动失败有自动补偿，不能误报协议终态。
- 失败只投影状态与白名单问题，不能伪造 semantic 完成戳或数字完成历时；旧版本、已替代事实及后来完成须分别处理。
- 恢复必须消费原请求 CAS，不复制消息、不重做已接纳效果、不清 unknown-effect fence；未知发送只能原生回读。
- 原始失败协议链与两个成功慢样本另见 `round-15.md`。协议最小回归在 `test/topic-runtime.test.js` 的“审阅后的Task瞬态运行状态不使候选事实失效，正文来源和归属仍须重读”；这份归档没有该用例修前独立日志，不用其它红测冒充其逐条原始输出。

修后过程见 `round-14.md`；最终风险、原生恢复、浏览器与包烟测见 `round-16.md`。以上计数相互独立，不累加成覆盖总数。
