# Round 8 — Frozen identity 错误外发反例

日期：2026-10-29（Asia/Shanghai）

## 结果

- S4 独立 nativeTaskHost 反例实跑：同 revision 但使用错误 taskIds 时，返回 `decisionStatus=blocked`、`error=group_reply_frozen_identity_conflict`，然而 `sends=1`，`sentTaskIds=[unrelated-fixture-task]`，命令 exit 0。
- 该 exit 0 表示反例脚本成功复现问题，不表示安全合同通过。它证明旧 decision 虽被阻断，notification gate 仍可能发送不相关 fixture task 的通知。
- 根因线索：gate 调用 frozenReply 时遗漏 taskIds，而 resume append 路径会校验。implement 已接手最小修复并补充测试 case。

## 证据边界

使用临时 SQLite、通知发送桩和优雅重启；不是正式库、真实钉钉外发或 sudden-crash 恢复。该反例保留为历史 FAIL，未创建最终 `report.md`；须等待修复后的实跑回执闭环。
