# 第十轮：受信证明、生产白名单与本地部署

以 `matrix.csv` 的 `round_10` 列为准。本轮未创建生产 Tag、未触发 UAT 构建、未创建 Bytebase 工单，也未执行 SQL。

| 用例 | 结果与证据 |
| --- | --- |
| P01 | PASS：生产 Tag 改为每次任务显式提供并冻结在审批范围，Host 在创建 Tag 前回读同 Run 的 Web 真人审批效果。UAT 交付从同一工程 Run 工件、业务 E2E 检查 ID、GitHub PR head/merge 和相同 Git tree 取证；同提交重建从失败流水线、先前成功制品、Registry 与当前 Ready Pod 取证。 |
| P02 | PASS：数据变更编排改为 UAT PostgreSQL 演练、Bytebase 建工单、Assistant 任务页真人审批、生产执行前二次回读。隔离 Controller 测试覆盖待批准、批准续行、撤销阻断与未知结果不重发；真实写端口仍未开放。 |
| P03 | PASS：Host 只注册 `dataset` 与 `dataset-web` 两个生产发布目标，并注册它们在 UAT2/UAT3 的同提交重建目标；目标 Tag 不写死在配置。Bytebase 只读客户端可核生产库身份和 `/schema`，基线成功同步超过 24 小时即拒绝。 |
| P04 | FAIL：UAT 交付缺真实业务 E2E 检查 ID；数据变更缺可信 UAT PostgreSQL SQL 审查/事务演练端口、Bytebase Sheet→Plan→Rollout→Issue 幂等创建与执行回读。当前 `hiq_editor` 的 Bytebase 成功同步时间为 `2026-09-10T07:23:59Z`，真实回读报 `BYTEBASE_BASELINE_STALE`。因此本地目录 UAT 交付和数据变更仍为 unavailable，不能宣称四类全通。 |
| P06 | PASS：代码全量测试 990/990，通过后增量相关定向测试 91/91；`node scripts/build-web-client.mjs` 退出 0。精确安装包 396489 字节、SHA256 `E52604A49A176AEE58F65CD21D7CAC98A36CAD859358F7CC7D01BF9AA889C082`。停机前 73 个旧 Task、5 个工作流 Task 均无活动；停机后备份 SQLite SHA256 `C2E07154686655B9C8B5C4EA26639D94A8BA3B04DF9678CC390865BEF89F7453` 与 profile、storage，稳定存储 `--check` 为 ok、strippedFields=0。新 PID 45236 同时监听 3080/18998，`/health=ok`、恢复故障 0；安装目录五个关键源码 SHA256 与工作树一致，73+5 Task 仍无活动。 |
| P07 | PASS：真实只读 Host 回读生产 `dataset`、`dataset-web` 均 Ready 2/2，UAT2 `dataset-web` 与 UAT3 `dataset` 均 Ready 1/1；生产历史 Tag 的 Woodpecker manifest digest 与 Registry、Ready Pod imageID 一致。新版目录 `task-production-release` 和 `task-uat-rebuild` 为 available，`task-uat-delivery` 与 `task-data-change` 为 unavailable。 |

`available` 只表示目标与端口已登记，具体任务仍须在执行时通过来源、审批和目标状态检查。当前两个生产服务未发布新版本，三库未做数据变更。
