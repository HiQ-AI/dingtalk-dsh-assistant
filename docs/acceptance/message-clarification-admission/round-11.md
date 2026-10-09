# 话题持久化、当前投影与安全修复验证

2026-10-08，短 D 盘 TEMP/TMP 下执行：

```powershell
node --test test/message-ledger.test.js test/message-context-repair.test.js test/http.test.js test/observer-client.test.js
```

171/171 PASS，日志 `docs/tmp/clarification-service-tests/topic-final-tests.log`。覆盖持久 title/summary、重启、同批重复展示拒绝、来源/版本门禁、当前上下文候选、话题刷新、维护封存与预检摘要绑定、预检零写及跨站/自报身份拒绝。此命令不包含真实模型或群通道验证。

独立浏览器执行 `docs/acceptance/topic-context-completeness/scripts/verify-observer-browser.mjs --topic-only`：16 项 PASS，25 次只读请求、0 写、0 浏览器错误，包含当前名称/摘要变化后列表与详情刷新和窄屏。完整旧浏览器流程在后续任务上下文旧断言失败，本轮仅声明话题流程通过。

历史关联修复由原生事务负责；服务及真实现场证据在后续轮次补充，不能把 reducer 测试等同已修改现场。

最终服务集成定向 15/15 PASS（包含原准入边界及两个新话题用例）：预检零写、错误身份/未封存/过期摘要拒绝，重复 apply 幂等，旧链接返回目标四条，原请求和消息状态保持，Task/业务命令/通知/outbox 零新增。日志 `docs/tmp/clarification-service-tests/service-topic-final.log`。
新增 CLI 后 `node --test test/http.test.js` 34/34 PASS：缺参数、陈旧 digest、未维护、非回环地址拒绝；正确 apply 先复查摘要再写，写后独立读取目标。
