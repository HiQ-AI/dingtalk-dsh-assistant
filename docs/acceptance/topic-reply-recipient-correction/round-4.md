# Round 4 — 归属与非法路由定向验证

日期：2026-10-29（Asia/Shanghai）

## 结果

- 源码审查反馈：`topic-runtime.js:1034-1037` 的 foreign-reply 归属早拒绝发生在 `acceptTopicDecision` 前，因此缺路由 decision 不会被接纳；原 store 归属门禁仍保留。未发现剩余已证阻断。此为审查结论，不等于恢复组合已端到端验证。
- 独立定向测试：`node --test --test-name-pattern="共享消息由主 Topic 统一回复|普通回复只接受固定Topic真人来源" test/topic-runtime.test.js`，6 pass、0 fail、0 skip，664.8663 ms，exit 0。
- 四个非法路由 case 断言 outbox=0、applications=0；共享消息由非主 Topic 回复时返回 `reply-owned-by-other-topic`；主 Topic 可接纳且最终仅 1 task。

## 证据边界与剩余项

- 受控模型 fixture 不证明真实模型的语义稳定性；测试通过不等于实时调度未发生，不能表述为“拒绝没有任何调度”。该路径可能重建可修正请求。
- 完整 service 恢复组合仍待 tests；源码审查覆盖的 frozenReply、通知投影兼容、双记录冲突、revision 和已存 task 版本等代码阅读不单独计 PASS。历史 notification 缺少 task 版本时仅能按稳定身份兼容。
- 固定 `refs=[]` helper 兼容不等于原生固定发送端到端成功；prepare 基线非空 refs 疑点仍待验证。
- 不涉及正式库、真实消息、钉钉外发、部署或 sudden-crash 恢复测试；不创建最终 `report.md`。
