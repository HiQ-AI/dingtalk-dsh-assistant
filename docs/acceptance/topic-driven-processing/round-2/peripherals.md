# 外围与原生 DSH 协议验证

2026-09-07。本轮补齐 Web 强制请求身份与版本、Resident 启动契约、Outbox prepare 重试及 fake Task 叶子协议。

- `node --test test/fake-llm.test.js test/http.test.js test/dws-adapter.test.js test/dws-bridge.test.js test/observer-client.test.js test/dingtalk-dsh-assistant.test.js`：77/77 PASS。
- `node scripts/build-web-client.mjs`：退出 0。
- 补齐 processing 后，`node --test test/http.test.js test/observer-client.test.js`：11/11 PASS；Observer 独立 Edge 脚本完整复跑 PASS，新增“处理失败 · 已处理 2 / 3 · 动作 1 / 2”可见断言。列表和详情公开最新未完成意图的 decisionId/status/appliedOperations/totalOperations/error（错误最多 1000 字），不公开动作正文。
- [原生 DSH 结果](native-dsh.json)：实际安装的 DSH 0.1.1-rc.2，独立 profile、存储和 Session。两条 HTTP inbound 先返回可靠接收，再由真实工具调用归类、提交 Topic 决策；Web 新建生成第三个 Topic 和一个 Task，叶子依次提交 plan-confirmed、两个 stage-completed、completed result，经三次检查点审阅和一次完成审阅生成通知。JSON 存储回读三个决策完成、三个 Outbox pending；相同 Web requestId 重试仍为一个 Task。Session JSONL 独立统计工具调用，防止仅以 HTTP 成功判定。
- 复跑：`node docs/acceptance/topic-driven-processing/scripts/verify-topic-dsh.mjs D:/soft/node-v16.20.2/node_global/node_modules/@deepseek-ai/dsh`。脚本明确接受已安装 DSH 包目录，临时产物生成在 `docs/tmp/topic-dsh`，结束后终止子进程。无需替换现有 profile。

初次 Task 扩展验证脚本把 Task 的 `state` 误写成 `status`，导致已完成 Task 被当作等待；已按真实 API 修正并完整复跑通过。fake 模型的工具错误会直接失败，不能把拒绝当成成功继续提交。

Web create/context/reopen 要求 requestId/context；已有 Task 的 context/reopen/cancel 还强制 topicRefs、inputVersion、runSequence，cancel 使用 reason 原文。body 禁止 taskId、childSessionId 和伪造渠道字段。Resident 不再持有 Web 业务直写工具；误归类修订使用 group_topic_route_review，非空回复带 replyReview.kind。新版 Task 输入重建 plan，旧检查点保留在内部执行事件。

UI 第一轮证据见 [Observer 检查记录](../round-1/observer-checks.md)、[Observer 审计](../round-1/observer-ui-audit.json)、[Premium 审计](../round-1/premium-audit.json)。根目录 premium-audit.json 已归入第一轮目录，截图与完整 profile/cache/log 留在 docs/tmp，不入库。

边界：fake LLM 验证工具协议与状态闭环，不证明真实模型判断质量。DWS bridge 禁用、外发授权关闭，没有真实群消息；Outbox pending 不代表投递成功。本轮没有发布、部署或升级既有 profile。
