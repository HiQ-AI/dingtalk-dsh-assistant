# 模型语义与基线反证

真实配置 `openai-codex / gpt-6-sol / low`，原生协调会话、工具反馈、隔离 SQLite 和真实 provider；Host 准入事实受控，dispatch 为空，无群消息和业务执行。

| 案例 | 结果 | 可观察事实 |
| --- | --- | --- |
| 来个任务，边做边修插件 | PASS | 仅保存工作方式事实，不捏造具体缺陷、不发澄清 |
| 按文档开发 | PASS | 干净的相关上下文中形成一个 create，无澄清，无旧 SQL/工单目标扩写 |
| 互斥目标未选择 | PASS | 合法 target_conflict、真实 sourceKey，零业务 command |

见 `round-5/native-replay/summary.json` 及逐例结果。三例耗时分别 152863、8009、6434 ms；首例真实慢流未被当作业务失败。此处仅证明语义候选与落账，不证明正式任务已执行或外部送达。

独立基线：`git archive` 提取未修改 `806ef59`，独立 `pnpm install --frozen-lockfile`，确认源码 blob 和本地 workspace 依赖身份。四项既有失败全部复现：外部阶段测试缺 stageAuthorizations，以及 C13、直接调查同会话/重启的通知计数 2!=1。见 `round-5/baseline-service.json`；不扩展本次范围修复这些既有失败。

核心合同最终一轮：`node --test test/message-context.test.js test/message-coordinator.test.js test/group-coordinator-session-native.test.js test/task-owner-session-native.test.js test/message-ledger.test.js test/workflow-notification-obligations.test.js test/observer-client.test.js`，248/248 PASS。后续审阅发现的授权续办和材料恢复边界另记下一轮。
