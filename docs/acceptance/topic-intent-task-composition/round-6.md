# 第六轮：真人审批与 UAT 数据库演练

本轮状态以 `matrix.csv` 的 `round_6` 列为准。固定流程的本地测试通过，不代表真实发布、真实 UAT 数据库演练或生产 SQL 已发生。

| 用例 | 本轮结果与证据 |
| --- | --- |
| P01 | PASS：生产发布在目标分支及合并身份回读后停于独立真人 `approval-gate`，批准后同一 Run 才准备固定 Tag；来源链改为 GitHub SHA/Tag→Woodpecker 同提交构建及镜像 digest→Registry 顶层及平台子清单→Ready Pod imageID。`task-release-workflows.test.js`、`workflow-release-platform.test.js` 定向通过。 |
| P02 | PASS：Bytebase 生产与 UAT 目标由受信配置指定；Host 回读冻结生产基线，平台分别核验结构版本、结构摘要及脚本前置条件；UAT 演练通过外部效果账执行且未知回执只读对账；建工单并回读后，唯一真人审批由 Bytebase `approval-gate` 回读，生产执行前复查。`workflow-data-change*.test.js`、`workflow-bytebase-platform.test.js`、`workflow-trusted-platforms.test.js` 定向 18/18。 |
| P03 | PASS：生产发布效果账仅在 Tag 前的 gate 发起真人审批，后续 Tag 必须携带审批回执身份；数据变更 UAT 演练和建工单不重复弹 Web 审批，生产执行由 Bytebase 人工审批身份约束。审批列表可读取持久审批账；`execution-effects.test.js`、`http.test.js` 定向 36/36。 |
| P04 | FAIL：真实只读探测确认 Woodpecker dataset repo 1 的成功 Tag 流水线可回读提交 SHA，但成功构建步骤日志未产出可机器核验的镜像 digest；Registry 受信读取令牌未配置。Kubernetes 可回读目标 Deployment、所属 Pod 和实际 imageID，仍无法据此单独证明提交到镜像的来源链。精确 UAT 数据库目标也未在当前受信配置中确认。缺口保持四类流程不可发起。 |
| P05 | NOT_RUN：真实 UAT 演练、生产 Tag、Bytebase 工单与生产 SQL 均未触发。 |
| P06 | NOT_RUN：本轮代码尚未安装到本地 resident。 |

`node --test --test-concurrency=4 --test-force-exit "test/*.test.js"`：976/976 通过，0 失败、0 跳过。随后修正 Registry 仓库名输入与固定目标合同的一处不一致，`node --test test/workflow-platform-clients.test.js test/workflow-release-platform.test.js`：15/15 通过。清除未接入 Host 的旧只读演练节点后，`node --test test/workflow-data-change.test.js test/workflow-data-change-external.test.js test/workflow-bytebase-platform.test.js test/workflow-service.test.js`：64/64 通过。`git diff --check` 无空白错误。平台连接探测只读，未输出凭据值。
