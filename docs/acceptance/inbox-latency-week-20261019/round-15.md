# Round 15：失败协议与成功慢样本的脱敏取证

2026-10-26。依据原 latency-data 已交只读分析归档，不再次扩扫业务库/会话。以样本 A（失败）、B/C（成功慢）代替真实消息、群、actor、session 身份；不保留正文、凭据或私有原始文件路径。下列原事件行号用于持有原证据的本机监管复核，并不是仓库内合成事件或公开原始日志。

## 结论

A 的正常 turn 结束不等于决定被接纳：五次提交全部返回 `review-required`，而非 accepted。已有具体可重现代码缺陷是回复审阅签名把关联 Task 的 running/waiting 瞬态当成候选事实变化；本轮只将这两态归一为 active，保留正文、来源、归属、终态和投递证据的审阅门禁，并返回明确重读动作。不能把真实五次提交全部归结为这一单因。

B/C 都是 attempt0 成功，不能套 A 的协议重试解释。主要跨度位于原生 turn 及若干无细分日志的 Host/调度空窗，排队仅约 0.6–2.3 秒；没有实证支持盲调并发。本轮未实施两条成功样本的性能优化，未测得提速，不承诺收益。

## A：协议逐次提交与反证

| 原事件行 | 事实 | 可得结论 |
| --- | --- | --- |
| 31、54 | group_reply_review_get 成功 | 不能说从未读审阅 |
| 35–36、63–64、68–69、91–92、114–115 | 五次 group_decision_submit 均 isError=false、status=review-required | 工具调用成功不等于决定接纳；无 accepted/duplicate/task-stale |
| 四个正常 turn end | 原生 turn 正常收束 | 不是业务决定成功证据 |
| 候选前后快照 deep diff | 关联 Task.state running→waiting；outbound identity、正文和来源不变 | 可触发旧版完整候选签名变化；不是内容本身变化 |
| 审阅到提交之间 | Task blocked 与新 turn 发生 | 运行态变化存在时序机会，不证明每次提交瞬间均命中同一分支 |
| 最终快照 | request exhausted、attempt=3；Topic revision=15、processedRevision=14，无 revision15 决定 | 该快照未证明后来已成功，不能显示处理完成 |

反证与盲点：

- 后三次提交未再次 review_get，已丢失的 readReview 标记会继续阻塞；没有逐次 submit 瞬间候选和 refreshReview 分支日志，不能断言五次全部由 Task.state 单因触发。
- offset out-of-order 到第四轮前才出现，不能解释首次 review-required。
- preserve/replan、confirmation/correction 变体没有解决审阅门禁；工具 isError=false 和模型正常结束也没有 accepted 证据。
- 候选真实正文、来源、归属和 Task 终态变化确应要求重读，不能以“快”为由删掉审阅。

源码与最小反例：`packages/dingtalk-dsh-assistant/topic-runtime.js:234` 的 reviewRequired 指明 `nextAction=group_reply_review_get`；`:235` 的 refreshReview 仅归一 running/waiting。`test/topic-runtime.test.js:1502` 同时覆盖瞬态可提交、终态/正文/来源/归属必须重读，且每组仅一条 outbox。修前最小反例结论由前序实跑交接，独立红测日志未归档；当前绿测与真实因果边界分开记录，不伪造缺失红测文件。

状态修复另见 `round-13.md`：HTTP 需按原 message/version/unit/request 精确匹配，startup 补偿不判终态，失败不生成完成戳；它解决“失败一直 processing”，不声称替真实请求重放成功。

## B：本次 semantic 边界内成功慢样本

单位 ms；各 span 可能嵌套，不能机械相加，也不能计入后续 shared decision。

| 事件边界 | 时长 | 解释 |
| --- | ---: | --- |
| occurred→semantic | 129323 | 本次消息总语义历时 |
| received→semantic | 119219 | 进入宿主后的本次跨度 |
| occurred→received | 10104 | 入口前；无 transport 细分 |
| ingress | 3631 | 已有入口 span |
| route queue / turn | 585 / 15082 | turn 内嵌 Host 321，不重复加 |
| decision queue / turn | 1736 / 65588 | attempt0 accepted，无协议退避解释 |
| Host action | 1782 | 已观测动作 span，不等于所有持久化 |
| send / readback | 1762 / 3623 | 实际通知段，按本次边界取证 |
| readback end→semantic | 9455 | 空窗未细分，不能默认全是模型或锁 |

三段 decision step→assistant 合计 57375，工具调用合计 5270，整个 turn 65588；第三步输出 1377 tokens，流包络约 25.4 秒。step→assistant 含宿主准备、网络、服务端等待和输出，不是独占推理秒数。后续共享 decision 不属于这次 semantic 关键路径，明确排除。

## C：本次 semantic 与后续通知分离

| 事件边界 | 时长 ms | 解释 |
| --- | ---: | --- |
| occurred→semantic | 115305 | 本次消息总语义历时 |
| received→semantic | 114601 | 宿主内跨度 |
| occurred→received | 704 | 入口前 |
| ingress | 669 | 入口 span |
| route queue / turn | 1512 / 28696 | turn 内嵌 Host 551，不重复加 |
| decision queue / turn | 2250 / 44691 | attempt0 accepted |
| turn end→Host start | 18112 | 发生在 turn 结束后、applyAction span 开始前 |
| Host action | 5330 | 只覆盖已埋点范围 |
| Host end→semantic | 7121 | 无每 await 的分解证据 |
| notification created→send | 22300 | 与 semantic 有交叉，不能全算 semantic |
| semantic→send | 16732 | 在语义完成之后，排除出本次 semantic 关键路径 |
| send / readback | 1434 / 1840 | 均在 semantic 之后 |

Decision step→assistant 合计 31196，工具 5996；turn start→首 step 5244，其余未细分 2255。不能把上述重叠区间累加成纯模型时间。

18.112 秒空窗附近源码有 rejectInvalidTopicDecision、decision applying、operation applying 等 await，Host 动作埋点位于 receipt.get 之后；未记录每次 await 的 begin/end，因此不能定量拆 fsync、队列、事件循环或 receipt 查询各自贡献。通知 created 后 projection/scan/canDisclose/start/sourcePending/inflight 也缺当时 gate 日志，不能把 22.3 秒全归轮询周期。

## 候选解释与取舍

1. 协议重试：A 有直接证据；B/C attempt0 成功，排除将 A 的退避根因套给 B/C。
2. 并发排队：B/C queue 约 0.6–2.3 秒，不足以解释 115–129 秒；不盲调并发。
3. 模型/网络/宿主 turn：有大跨度事件，但缺独占计时，保留“turn 含模型、工具、Host、网络”口径，不称纯推理瓶颈。
4. Host 持久化/调度：C 有 18.112 秒和 7.121 秒空窗，定位到相邻边界但内部未收敛；不凭猜测加锁绕过或跳业务核验。
5. 通知 gate：C 语义后有 16.732 秒；应独立看通知，不延长本次 semantic、不删 sourcePending。

本轮实现只解决已复现协议缺陷、精确失败投影和收发安全恢复。原日志只读；没有真实恢复 A，没有向任何真实渠道发送，也没有重跑 B/C 以制造性能对比。最终定向/原生/浏览器/解包验证见 `round-16.md`，均不能代替真实模型与性能验收。
