# 第七轮：真实 UAT 任务与构建证明预检

本轮状态以 `matrix.csv` 的 `round_7` 列为准。隔离测试与历史流水线只读回读不能代替两项新修复的 UAT 部署。

| 用例 | 结果与证据 |
| --- | --- |
| P01 | PASS：`uat-delivery` 与 `uat-rebuild` 的固定节点、同 SHA 查重和失败重建门禁在本地测试通过；适配器新增 Woodpecker 成功流水线唯一构建步骤的 Base64 日志解析，只接受完成的导出/推送 manifest 同摘要。针对 `data:null` 空行的真实格式修复后，`readBuildEvidence` 对 dataset repo 1 pipeline #262 只读调用返回 `28ebb9bbbcd9528040d3025903218aa530f8dfaa`、`dataset:uat2`、`sha256:2d2609a96b72f65e8856e58f56c202dbe68e36c2272cb731d51f7d1111509a20`，与独立 Registry/Pod 回读一致。`node --test test/workflow-platform-clients.test.js test/workflow-release-platform.test.js` 16/16。 |
| P04 | FAIL：历史 UAT2 构建摘要链已核实，但当前本地 Host 尚未配置目标、Registry 受信端口与 UAT 证明提供者；目录不能宣称可发起。 |
| P05 | NOT_RUN：昨天的 dataset #371 与 dataset-web #368 均为 `main` 开发 PR，未进入 UAT2 分支；真实 UAT 交付/重建尚未触发。UAT2 目标待确认，业务修复正分别在隔离 worktree 构建验证。 |
| P06 | NOT_RUN：当前修复包尚未安装本地 resident。 |

插件全量回归 `node --test --test-concurrency=4 --test-force-exit "test/*.test.js"` 为 977/977，通过后修正了真实 Woodpecker 空日志行，定向 16/16 再通过。UAT2 旧基线只读回读：dataset 分支 `28ebb9bb`、Woodpecker #262、Ready Pod 均为上述摘要；dataset-web 旧基线分支 `bbe49eae`、Woodpecker #315 与 Registry/Pod 摘要一致，均未含昨天的业务修复。
