# 第5轮：真实模型按执行文档协调

使用当前生产 Owner 指引、Store、模型投影与文档生成器，8 类隔离样本通过已安装 web Connect 调用 `gpt-6-astra / low`；业务执行器不运行。只允许本样本登记文档、模型内容文件和精确冻结单行素材的原生读取，路径及 realpath 均校验。原 trace 和源快照位于 `docs/tmp/task-collaboration-model-round-5/`，可提交摘要及 SHA 见 `round-5/model-results.json`。

| 样本 | 独立语义判断 | 原生证据 |
| --- | --- | --- |
| simple-three | PASS：已完成两人后只补第三人必要原文核对 | seq 36/41 实读两份 MD，37/42 返回完整 70 行；46 新增第三人、51 如实等待；8 calls |
| independent-ready | PASS：两个无冲突目标同轮派发，第三人待前置 | seq 16/21 委派，26 明确排队且第三人尚未登记 |
| shared-writer | PASS：同一文件两个相关字段由同一成员一次修改 | seq 16 单写者，21 两个只读职责等待产物就绪，未重现 R4 两个串行写者过拆 |
| dependency-pending | FAIL：业务判断正确，但进度工具返回非法 JSON | seq 16/17 工具错误含 `progressReview: undefined`，不能把后续正确 wait 当无错通过；见 R6 修复复验 |
| dependency-ready | PASS：核验前置后沿原执行续办 | seq 36/41/46 三份完整 MD；56 原 ID 仅改 convertPrice，引用 12345→123.45 和 99→0.99；61 如实 queued；10 calls |
| complex-ten-reuse | PASS：已有 10 人继续复用原团队 | seq 31/41 完整读原两 MD，51/53 原 team1/2 续办，58 如实 queued；没有第 11 人；9 calls |
| complex-self-claim | PASS：实施自述不作高风险验收 | seq 36/41/46 三份完整 MD；51/56 原审阅成员对固定 SHA 分别核对权限反例、迁移证据，61 明确结果未回；10 calls |
| team-complete | PASS：完整读证后给简单答案 | seq 36–38 并行读取，39–41 返回 70/70/71 行，45 只回答两版本均 2.4.1，不重派、不重做；6 calls |

`document-read` 事前事件只证明尝试；以上逐例核对实际 tool result，确认没有把截断或失败当成已读。结构断言和人工独立语义复核分列于 JSON。

调用成本仍有余量：重复投影的文档元数据有时需要先读取 JSON 引用，再拿到 MD 路径。simple-three 本次 8 calls/53.909s，对比 R4 的 9/60.681s 只是单样本观察；不据此宣称普遍加速、零层导航或所有通信成本问题已解决。

首错根因同时存在于夹具和生产：合成 pending 手造 timer wake 却未落 `progressReviewed`；生产主动查询首次巡检前的执行也可能没有该字段。修复生产可选字段输出、补真实无字段原生反例，并在 R6 令隔离 timer 走 Store 真实命令生成 wake；保留本轮 FAIL。
