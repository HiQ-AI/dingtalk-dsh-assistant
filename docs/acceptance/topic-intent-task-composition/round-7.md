# 第七轮：真实 UAT 任务与构建证明预检

本轮状态以 `matrix.csv` 的 `round_7` 列为准。隔离测试与历史流水线只读回读不能代替两项新修复的 UAT 部署。

| 用例 | 结果与证据 |
| --- | --- |
| P01 | PASS：`uat-delivery` 与 `uat-rebuild` 的固定节点、同 SHA 查重和失败重建门禁在本地测试通过；适配器新增 Woodpecker 成功流水线唯一构建步骤的 Base64 日志解析，只接受完成的导出/推送 manifest 同摘要。针对 `data:null` 空行的真实格式修复后，`readBuildEvidence` 对 dataset repo 1 pipeline #262 只读调用返回 `28ebb9bbbcd9528040d3025903218aa530f8dfaa`、`dataset:uat2`、`sha256:2d2609a96b72f65e8856e58f56c202dbe68e36c2272cb731d51f7d1111509a20`，与独立 Registry/Pod 回读一致。`node --test test/workflow-platform-clients.test.js test/workflow-release-platform.test.js` 16/16。 |
| P04 | FAIL：历史 UAT2 构建摘要链已核实，但当前本地 Host 尚未配置目标、Registry 受信端口与 UAT 证明提供者；目录不能宣称可发起。 |
| P05 | FAIL：两项 UAT 交付并非同一环境。dataset-web 草稿目标 UAT2，PR #369→Woodpecker #318→Registry/Pod digest `sha256:50460dc619700691cdfadabfbb0f5cb179eab182ce19c07b628efd7e0c9be299`，独立浏览器保存后重新进入回显通过。数据集合并目标由既有 `dataset-merge-process-data/goal.md:25` 明确为 UAT3；误将旧方法修复 PR #372 合入 UAT2，随后通过恢复 PR #373 和流水线 #275 恢复原源码，构建/Registry/唯一 Ready Pod digest `sha256:8f0239de75f540091f74e4ef741577f0d7412c86e8bf59e7e7ee1b43ec06efc6` 一致，远端目标文件与误投前 `28ebb9bb` 完全一致。UAT3 当前新预览链以受控夹具真实复现 `0.5 kg→t` 输出 `0.001 t`（目标 `1 t`），两次来源数据均在 `finally` 恢复并 `--check` PASS，未生成确认结果；修复待下一轮验证。成功构建的同 SHA 重建不得为验收重复触发。 |
| P06 | PASS：部署前只读回读 73 个旧 Task 均 completed、工作流运行无活动 Run、通知无 pending；停止实际监听 PID 24648 后备份 `control.sqlite`（65724416 字节，SHA256 `C2E07154686655B9C8B5C4EA26639D94A8BA3B04DF9678CC390865BEF89F7453`）及 profile 配置到仓库外。按 runbook 安装精确 `@zzusp/dingtalk-dsh-assistant@0.5.15` tgz，新 PID 33192 同时监听 3080/18998，`/health.status=ok`、`recoveryIssueCount=0`，安装 `workflow-platform-clients.js` 与 `workflow-release-platform.js` SHA256 与本次源码逐一相同；四类外部目录仍 unavailable，未宣称可发起。 |

插件全量回归 `node --test --test-concurrency=4 --test-force-exit "test/*.test.js"` 为 977/977，通过后修正了真实 Woodpecker 空日志行，定向 16/16 再通过。UAT2 旧基线只读回读：dataset 分支 `28ebb9bb`、Woodpecker #262、Ready Pod 均为上述摘要；dataset-web 旧基线分支 `bbe49eae`、Woodpecker #315 与 Registry/Pod 摘要一致，均未含昨天的业务修复。

真实业务集成：dataset-web #369 在 UAT2 既有草稿机制内修复模板指纹初始化时序，定向 15/15、生产 Vue lint 和 `yarn build:test` 通过，合并 SHA `198e04afffff02dc1e865fe65f6eefff8a07f4ac`；Woodpecker #318 全步骤成功并完成页面 E2E。dataset 开发 PR #371 的 22 行修复只涉及 UAT3 不再调用的旧 `mergeDataset2`；本轮错误移植到 UAT2 后已按上述独立来源链恢复，不能把 #274 的技术发布算作正确目标交付。UAT3 真实反例促使改动转向 `MergePreviewCalculator`，后续修复和重验另记新轮。
