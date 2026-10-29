# #408 / #409 消息处理延迟改进验收报告

## 结论

本轮授权范围内的定向回归已通过，矩阵中适用验收项的最终有效结果均为 PASS；早期 FAIL 保留在原轮列，后续修复/合同诊断的通过单列记录。已明确不执行的现场/生产/crash/旧库完整兼容项标为 `OUT_OF_SCOPE`，非行为验收事件标为 `NOT_APPLICABLE`。完整逐用例状态以 [`matrix.csv`](matrix.csv) 为准，运行依据见 [`round-1.md`](round-1.md) 至 [`round-6.md`](round-6.md)。

验证运行时使用隔离 worktree `worktree-inbox-latency-408-409` 的未提交实现和测试 diff；之后由 Lead 提交实现、测试、README 与 ops，提交 SHA 为 `c6f19af0fd6772ca4d4a1c07a49dcbfd534ce8db`。本次结果证明列出的本地/native 测试行为，不表示这些测试在该提交 SHA 上重跑，也不表示已经部署或验证真实钉钉现场延迟改善。

## 主要回归结果

- 指定 `DSH_NATIVE_TEST_PROFILE` 后，`node --test test/task-topic-routing-native.test.js`：21/21 PASS、0 FAIL/cancelled/skip，54,005.6761 ms，exit 0。此前 13/13 与 19/19 运行分别保留在早期 round，未覆盖最终记录。
- 指定 native profile 后，`node --test --test-name-pattern='native completion race|native service cancellation stops|native requirement update resumes|native capacity queues promote|native session creation failure' test/task-session-service-native.test.js`：9/9 PASS、0 FAIL/cancelled/skip，115,591.5036 ms，exit 0。覆盖完成竞争恢复、真实本地执行进程取消与迟到结果拒绝、同一 Owner 接纳新需求并 fence 旧结果、四组任务/执行容量组合、会话创建故障有界恢复。
- 指定 native profile 后，`node --test test/task-session-service-native.test.js` 的 `native service cancellation stops|native requirement update resumes|recovering an idle owner|empty owner recovery reviews` 四项定向选择：4/4 PASS，43,101.1186 ms，exit 0；临时根目录、通知桩。该组与 9 项风险组部分重叠，不合并计算为额外独立测试数。
- `node --test test/task-archive-scheduling.test.js test/coordination-resources.test.js test/performance.test.js` 在当前并行 diff 下：50/50 PASS，1,629.0329 ms，exit 0；`node --test test/topic-runtime.test.js`：143/143 PASS，7,402.94 ms，exit 0。Lead 的独立 topic-runtime 四项抽验另为 4/4 PASS，953.6322 ms。
- 同 Topic busy/异任务独立专项 1 PASS，6,377.8288 ms；当前格式失败记录重放、材料恢复、claim fence、跨入口 Owner wake、Host 子阶段等专项结果按 round 记录，避免跨场景外推。

## 合同与证据边界

- 已验证群任务目录默认排除归档；底层 `task.get` 可按 taskId 回查归档；上下文工具对同群归档任务仅给出有限身份和 `allowedActions: []`，不恢复或授权执行；跨群与不存在任务错误区分，参数错误结构化返回。
- 已验证多事项遗漏范围使用 UTF-16 左闭右开 offsets，具体测试断言见 round；来源授权与跨群上下文等合同由定向测试覆盖。
- Owner 接纳竞态在可控实验中复现，修复后指定门闩测试和跨入口实验通过；另有旧/新 Owner 双 gate 与 busy/backoff 合同测试。真实 Agent 是否被取消、现场 148 秒的完整归因并未验证。
- Host 的 `task-commit`、`old-drain`、`materialize` 子阶段具有测试记录；子阶段嵌套在 Host span 内，不能重复累加。事件时间测试不是 #408/#409 现场计时。
- 当前失败记录恢复与构造旧键序 writer 兼容夹具通过：用真实 Store 持久化反转键序的 action/topicRefs，重启后保留旧 fingerprint、同值成功、异值拒绝且版本/Owner 不增；未测试旧版本完整数据库迁移或突然崩溃恢复。
- 材料重放/Owner cancel recovery 迭代中曾出现真实失败或脚本旧断言不匹配，首版 Owner 门闩曾 timeout；所有历史事件及随后诊断/修正结果均保留在 round-2/round-3，未删改。并行编辑的 SyntaxError 作为历史测试启动事件保留，不是产品行为用例。

## 明确未执行

- 不访问生产数据库、不部署、不重放真实 #408/#409 消息、不发送钉钉通知；因此不声称现场 E2E latency 改善或真实 148 秒已被解释。
- 不把受控 Owner/Execution 桩测试解释为真实 DSH Agent 生命周期或所有外部副作用保证；本地真实进程取消只限列明的测试 fixture。
- 不做突然 crash recovery、旧版本数据库 writer 兼容、未列出的容量和创建失败组合；这些不是本轮通过声明，矩阵标为 `OUT_OF_SCOPE`。

## 产物

- 验收矩阵：`matrix.csv`
- 逐轮证据：`round-1.md` 至 `round-6.md`；本报告未编辑 platform 独占实验记录 `round-1-owner-admission.md`。
- 用户合同文档同步：`README.md`、`docs/ops/task-archive.md`
- 报告只总结本轮当前有效验收结果；保留的历史中间失败不从证据链中删除。
