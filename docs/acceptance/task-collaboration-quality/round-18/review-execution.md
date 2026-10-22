# R18 独立审查：DSH 原生团队按需拆分

## 职责与边界

审查人：progress_audit。工作树：`D:/codex/worktrees/native-adaptive-team/dingtalk-dsh-assistant`；初始基线 `12f13e0379f34745ba215f441d27af80291b2bcf`。本轮仅审查人数策略、实现与定向验证证据，并只读回查当前现场有效后端与健康。不开模型、不提交或推送、不改生产源码、现场配置、账本或进程。旧轮验收结论不改写。

## 初始审计结论

固定人数来自两道独立 Host 门禁和多处提示，须同步移除；并发容量及效果保护不是团队累计人数限制。

| 范围 | 基线位置 | 已确认内容及处理边界 |
| --- | --- | --- |
| 完成门禁 | `packages/dingtalk-dsh-assistant/task-session.js:15`，`task-session-service.js:982` | `assertTaskExecutionTeamComplete` 拒绝 1/2 成员；仅删除人数条件，不删除完整目标验收和 Store 完成保护。 |
| 新建上限 | `packages/dingtalk-dsh-assistant/dynamic-task-store.js:896` | 同 Task 累计 10 名后拒绝新 dispatch；幂等 key、冲突、身份及版本校验仍保留。 |
| Owner 指引 | `task-session.js:41`、`:42`、`:43`、`:48`、`:196` | 系统指引和提交工具 description 均有 3–10、简单任务凑 3 人、complete 核人数。应改为实际必要性及拆分成本。 |
| 执行交接 | `task-session-service.js:907` | 成员 prompt 也声明“3至10人执行团队”，不能遗漏。 |
| 当前文档 | `README.md:16`、`:30`；`docs/ops/task-session-clean-start.md:33`、`:104` | 当前使用说明须同步；历史验收保留当时策略。 |
| 配置与读取 | `task-resident-runtime.js:14`、`:44`；`dynamic-task-store.js:1620`、`:1623` | 未发现团队累计人数配置或 team/list 的 10 人截断。配置中的 1–50 是运行并发合法范围，非团队规模。 |

保留边界：`task-session-service.js:54`、`:73`、`:74`、`:322`、`:747` 的并发准入；`dynamic-task-store.js:857` 起完成时的协调、对话、未消费反馈和 `assertClear`；`:908` 起续办排空、当前版本与未决 operation；`:1027` 起资源整组原子获取。成员消息不扩授权，阶段文档和旧轮冻结不变。

## 定向验收建议

- 0 执行直接完成、1/2 执行实际结果与排空齐备可完成；未排空、未知效果、未消费反馈等原保护继续拒绝完成。
- 第 11 个及以上真实 dispatch 成功，稳定 key 重试仍返回原身份；不同内容复用 key 仍冲突。累计人数增加不突破已配置同时运行容量。
- 原成员续办保持身份、输入版本递增、旧轮文档不改；同资源写入互斥保持。
- `test/task-session-http-integration.test.js:32`、`:54` 的 10 条真实记录加 43 条历史 SQLite 夹具是旧人数上限造成的安排；可恢复真实生产派发，但必须保留 53 条分页与阶段读取覆盖。
- 不因其他既有测试恰好使用 3 名就批量改写；只调整直接依赖旧人数合同的断言。历史模型验收不冒充新策略行为证据，本轮无需新模型调用。
- 关联脚本缺口：当前 runbook 仍链接的跨轮 `scripts/evaluate-model.mjs:184`、`:282` 导入旧 `assertTaskExecutionTeamComplete`，`:132`、`:186`、`:187`、`:434` 保留最少人数断言或提交调用。生产删除导出后会使该入口失败；须同步当前脚本与零模型 `--check`，或明确撤回为历史入口。旧 round 原结果及冻结源码不改。

## 现场只读回查

2026-10-23，本轮仅 GET `http://127.0.0.1:18998/health` 与 `/state/agent-config`。已先读当前 `http.js:216`、`:402` 和 `task-session-clean-start.md` 的返回合同。独立结果见同目录 `runtime-readback.json`。

- 当前有效 `executionBackend=dsh`，`maxConcurrentTasks=8`。源码缺省 DSH 与现场实际配置分别核对；没有读取或输出凭据、完整 profile。
- 当前 `status=ok`、`recoveryIssueCount=0`、`inboundProcessing=true`、`dwsBridge.healthy=true`。
- 此结果仅证明读取时的有效配置及健康，不证明本轮代码已经部署，不替代模型或真实钉钉业务验收。未更改已绑定 execution 的后端。

## 实现及证据复审

待实现者完成后追加；本文件初始审计不表示修改或测试已通过。
