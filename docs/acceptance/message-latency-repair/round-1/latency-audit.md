# 今日消息链路只读审计

2026-10-22。本记录仅输出脱敏指标与会话行号；消息、群、任务和会话标识以 SHA256 前 12 位关联，不提交原文、人员信息、模型流或 reasoning。来源为本机 `/state/groups`、`/state/performance` 和 `sessions/*/*/session.v4.jsonl`。命令未调用发送、重放或部署接口。

## 覆盖及方法

首次采样默认写入 round-1。已归档轮次不可覆盖，脚本遇到已有 today-metadata.json 会在读取现场前拒绝；下一次采样通过第四位置参数选择新轮次，例如：`node docs/acceptance/message-latency-repair/scripts/audit-today.mjs 2026-10-22 D:/dsh_home http://127.0.0.1:18998 docs/acceptance/message-latency-repair/round-2`。摘要打印到 stdout，按需另存该新轮次的 audit-summary.json。

本轮已冻结。最后整理仅重命名已采 JSON 的 sourceOccurredAt 字段并更正说明，没有再次请求现场或改变采样截止时间。sourceOccurredAt 是来源消息的发生时间；本轮没有独立的本机入站时钟。等文回复匹配按当前消息关联会话检查，避免其他消息相同回复文本造成误分类。

输出 `today-metadata.json` 为细节、`audit-summary.json` 为消息关联摘要。本次读取当日保留的 15 条消息、20 个会话。performance API 只有 3 行，明确标为 `incomplete / observed-events-only`，不能以此推算全日吞吐或无遗漏。

机器字段使用 `earliestRelatedReplyMs`，不能直接当作首受理时延。必须同时读取 `replyClassification` 和 `eligibleForAdmissionLatency`：confirmation / exact-decision-reply / coordination-clarification 可纳入受理链路；related-substantive-unverified 不可纳入，未保留关联回复则值为 null。756.964 秒样本明确标为 false。

消息关联使用输入顶层 `source.messageId`、`ownedDeltaMessageIds` 或 `messages[].messageId`；不以正文中出现历史 ID 作为归属，避免上下文旧消息污染链路。工具异常只采顶层 error 或 isError，不把成功查询返回的历史任务错误当作本轮工具失败。`modelMs` 是 step/start 到 assistant/message，包含网络和本地准备，不是纯模型推理时间；token 使用包含 cacheRead 的输入量，不把 uncached inputTokens 当完整上下文。原始消息目前未投影出的答复不推断为“没有回复”。

## 核心短延时样本

消息别名 `1508f4198d0b`：消息发生时间 07:31:45.381Z，07:35:24.469Z 送达，合计 **219.088 秒**。

| 阶段 | UTC 起止 | 耗时 |
| --- | --- | ---: |
| 消息到 route turn/start | 07:31:45.381 → 07:31:46.089 | 0.708 秒 |
| route | 07:31:46.089 → 07:31:52.915 | 6.826 秒 |
| route 到首规划 | 07:31:52.915 → 07:31:53.031 | 0.116 秒 |
| 规划一，8 步无 submit | 07:31:53.031 → 07:32:39.129 | 46.098 秒 |
| 第一次重试间隔 | 07:32:39.129 → 07:32:47.404 | 8.275 秒 |
| 规划二，8 步无 submit | 07:32:47.404 → 07:33:55.920 | 68.516 秒 |
| 第二次重试间隔 | 07:33:55.920 → 07:35:02.324 | 66.404 秒 |
| 规划三，到澄清工具结果 | 07:35:02.324 → 07:35:14.130 | 11.806 秒 |
| sendStarted 到 delivered | 07:35:14.091 → 07:35:24.469 | 10.378 秒 |

最后规划工具与发送存在 39 毫秒重叠，turn/end 在 07:35:14.142；不能简单相加为串行时间。两次重试间隔为实测墙钟，分别包含配置退避 5/60 秒及恢复调度余量，不把 8.275/66.404 全归为模型。

| 会话别名 | modelMs 合计 | 工具耗时合计 | 工具返回字节 | 输入含缓存累计 token | 单步最高输入含缓存 |
| --- | ---: | ---: | ---: | ---: | ---: |
| a3df39f68b29 | 45,739 | 129 | 122,024 | 237,605 | 49,046 |
| d6a8d10771d3 | 68,261 | 96 | 148,652 | 248,084 | 54,292 |
| 734a8fce5e9d | 11,661 | 98 | 9,901 | 38,131 | 20,450 |

前两轮各发生相同两次 `COORDINATION_CONTEXT_RANGE`：line 19 请求 `limit=100`，line 29 请求 17 个 taskIds；随后按 4/4/4/4/1 批读取全部 17 个任务，八步全用于 context_get，没有一次 submit。第二轮单步最大 20.421 秒。第三轮仅 context_get + submit(kind=clarify)。首包本来就含约 9,593 bytes 目录；重复读取和详情扩张造成额外模型轮次，实际工具本地执行只有毫秒级。该样本主要可消除成本是规划合同/上下文与重试，不是 route 或钉钉投递占据全部时间。

## 其他两条慢受理确认：不同的重复提交路径

以下两条 outbox 文本在内存中与各自 group_decision_submit.reply 比较为完全相同，均为 `confirmation`，不是拿最终业务结果当作首条受理回复。

| 消息别名 | 消息发生 UTC | 消息到 route | route | decision | decision 后到 send | send 到 delivered | 总计 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 72a41858e7f9 | 01:03:08.044 | 0.861s | 19.522s | 80.414s | 1.287s | 12.052s | 114.182s |
| 96b6d9b53f04 | 01:39:49.000 | 8.825s | 15.203s | 67.904s | 1.083s | 25.794s | 119.390s |

表中省略两个阶段间小间隙，因此各列不要求精确相加。route 分别 4/3 步，各有一次 `group_topic_context_get → topic_page_invalid`。

两个非法请求均为 `limit=10000`，第一个未传 offset，第二个 offset=0。实际 `store.js:741` 限制 context limit 为 1..500，默认 10；`topic-runtime.js:978` 公开 schema 仅声明 integer，没有范围或“消息条数”单位说明。两例移除 limit 后以默认值成功。不要与 group_topic_list 的 1..100（默认50）上界混淆；第一例的 list limit=100 本身合法。

decision 会话 `754f97f36715` 共 8 步，5 次提交完整决策，动作始终为 task-reopen，reply 始终 42 字：

1. line 33：decision 字段为 topicUpdate/basisMessageIds/basisUnitRefs/actions/reply，没有 replyReview；返回 `review-required / reply_kind_required`。
2. line 38：补 replyReview.kind=confirmation；返回仅 `review-required`，随后才读取候选。
3. line 48：reviewed=3、sameMatter=3、replace=0；返回 `group_reply_review_replacement_incomplete`。
4. line 53：reviewed=3、sameMatter=0、replace=0；返回 `group_reply_review_same_task_confirmation_missing`。
5. line 58：reviewed=3、sameMatter=1、replace=1，接受。

decision 会话 `6661a365af09` 共 6 步，3 次提交完整决策，动作 task-reopen，reply 始终 55 字：line 38 reviewed=4/sameMatter=1/未传 replace → replacement_incomplete；line 43 sameMatter=0/replace=0 → same_task_confirmation_missing；line 48 sameMatter=1/replace=1 → accepted。

**可证实的合同可发现性问题**：`decision.js:31-41` 将 replyReview 设为 optional、数组默认空且没有字段说明；实际 `topic-runtime.js:907-911` 对非空 reply 强制 review。`task-topic-coordinator.js:137-141` 另要求非 substantive 的 replace 与 sameMatter 集合相同、confirmation 必须覆盖同 Task 的已有 confirmation。工具只返回 status/error，没有字段修正指引；`group_reply_review_get` 只给候选。输入在公开 schema 上合法，却需要依次试出运行时条件，并重传完整决策。不能据此取消历史候选校验；应改善契约公开和错误修复信息。

## 长间隔样本：不能冒充已证实的首回复延迟

消息 `984bf6a64f9e` 当前关联到一条 substantive outbox，间隔 756.964 秒；该 outbox 不等于任何当日决策 reply，因此**不能确认这是首受理答复，也不能将 756.964 秒并入受理时延统计**。

- sourceKind=dingtalk，occurredAt 与 processingSentAt 均为 01:52:24Z；不是数据中显式标记的 backfill，但没有独立接收时钟证明。
- route turn/start=01:59:03.229Z，较原消息晚 399.229 秒。
- decision 两轮起止跨度 164.807 秒，其中 turn 实际 100.902+33.276 秒；10 步、modelMs 合计 125.053 秒。之后到该 outbox sendStarted 又有 115.748 秒，投递 60.932 秒。
- 前一 decision 会话 `b212024d95ef` 在 01:52:03.595Z 开始后没有 turn/end/assistant/message，另一个 decision `63ed0b876ecd` 于 01:58:50.450Z 开始；时间上与等待窗口吻合。今日这些 v4 文件没有 coordination-dispatched/queued 事件，故不能把 399 秒确定为串行队列，也不能排除接收/恢复/进程中断。
- 未找到今日独立 answer 会话；这不证明答复阶段耗时为零。需要另取对应任务/通知的权威来源后才能解释这条 substantive 的业务归属。

## 15:36 的八步路由：多候选检索，不是错误重试

消息 `98ec8155cb36` 对应会话 `5af10a7ed766`：07:36:20.711Z → 07:37:11.282Z，共 50.571 秒；modelMs 合计49.088秒、工具合计1.020秒。八步顺序为：

1. 读取一条消息，结果 complete 且 hasMore=false。
2. requestId 关联 Topic 目录，limit=40，返回0项且 hasMore=false。
3. 读取 Topic `4078ef3530b2`，limit=10，返回8条消息。
4. 第一个两字符关键词全群搜索，limit=40，命中1项。
5. 不同的两字符关键词全群搜索，limit=40，命中16项。
6. 读取另一 Topic `55a4b48ffc2b`，limit=10，返回1条消息。
7. 读取第三 Topic `1dc28c6787e8`，limit=10，返回2条消息。
8. group_topic_route_submit 返回 accepted。

三个 Topic 均 hasMoreMessages=false，两个关键词不同；没有同页重复、没有工具错误，也没有八步后未提交。可确认是多个候选的检索比较，不是分页或参数重试；单凭元数据不能断言这三个业务候选都是必需，也不能将其当作本轮已证实的浪费。模型响应累计约占97%，不宜通过降低合法步数强行跳过上下文。

## 结论边界

219 秒样本与两条约两分钟确认具有不同入口，但都出现工具合同未充分公开带来的重复模型调用；前者是 context 范围/只读观察要求，后者是 reply-review 交叉字段规则。投递另占约 10–26 秒，本轮没有网络层证据可进一步归因。399 秒前置间隔与 60 秒投递保留为未收敛问题。所有优化后的真实模型收益需部署后重新采样，不能用合成测试墙钟冒充。
