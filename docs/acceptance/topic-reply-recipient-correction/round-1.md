# Round 1 — 范围与待验项

日期：2026-10-29（Asia/Shanghai）

## 来源与状态

- 唯一目标见 `goal.md`；本轮先将目标要求拆为可追溯待验项，不替 platform/implement/test 提前定义语义或断言细节。
- Round 1 起始检查时，隔离工作树为 `worktree-topic-reply-recipient-correction`、HEAD `63ab508b502c8d2576a654e9be2f15225031d7ff`；当时除 acceptance 桶外无文件改动。本记录只读写验收文档，不修改源码、测试、README、ops、goal/spec 或机制报告。
- 起始时尚无 platform 机制结论、tests 反例/测试输出或 implement 最终语义合同；本轮正向行为项均为 `PENDING`，无 PASS。

## Platform 合同反馈（已纠正；实现与测试仍待验证）

- Platform 确认：非空 `decision.reply` 需要同群固定 Topic 绑定的明确 routing；无法证明真人目标时拒绝/阻断，不回退到最后 basis 作者或匿名猜测。实现及反例仍需验证。
- `group-reply-format.js:67-70` 据 platform 代码阅读要求 source message/sender。关于 `atOpenDingTalkIds`，platform 已更正先前误报：省略字段或显式 `[]` 均默认 @ 引用目标；只有显式非空列表才逐一校验并保留。先前“空数组表示不 @”的建议错误，已由本条更正；此合同仍待测试结果证明。
- 旧 pending 恢复：platform 更正为旧冻结 payload 沿用原实际内容；不得按新默认重选收件人。缺少足以恢复原实际内容的冻结证据时如何 fail-closed，仍待机制/实现确认和测试，不自动猜测或重发。
- Platform 未独立运行双依据基线；A/B/C 脱敏反例仍待 S3 tests 的实际复现及输出。以上不替代机制实现与实测证据。

## 待验范围

| 用例 | 状态 | 依据/待明确点 |
|---|---|---|
| 语义收件人不被最后依据发言人覆盖 | PENDING | 目标明确要求；由 platform/implement 确认现有调用链及语义对象传递，tests 给出脱敏反例与断言。 |
| 明确收件人纠正不因无任务动作而吞掉 | PENDING | 目标明确要求；确切对话/通知结果及 ledger 幂等断言等待机制收敛，不自行规定必须新发消息。 |
| 不强制每条纠正单独另发 | PENDING | 目标明确限制；如何在现有回复/通知路径中表达由语义合同确定。 |
| 来源、引用、群归属和收件人身份校验 | PENDING | 目标完成条件；负例、已有显式选人能力及跨群拒绝边界等待 tests/platform 合同。 |
| 不硬编码姓名或纠正关键词 | PENDING | 目标完成条件；待结合实现审查及反例确认。 |
| 重复输入及发送恢复幂等 | PENDING | 目标完成条件；精确幂等键/状态转换遵循当前机制，待 platform/tests 证据。 |
| 普通确认及完成/阻塞通知路径不回归 | PENDING | 目标完成条件；测试 fixture 和回归命令待 tests 提供。 |

## 明确范围外

- 不访问正式库、不重放真实消息、不发送或撤回真实通知、不部署；不声称现场验收。
- 不改造成完整跨 Topic 主回复架构，不扩大跨群收件人授权。
- 不触发 CI、不合并、不写旧 PR #291 分支。

验收状态以 `matrix.csv` 为准；历史失败按后续 round 追加保留。全绿前不创建 `report.md`，README/ops 等用户合同文档待机制和实现合同明确后再同步。
