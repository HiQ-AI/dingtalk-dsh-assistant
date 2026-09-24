# 第五轮：受信平台适配器

本轮状态以 matrix.csv 的 round_5 列为准。测试通过仅证明适配器的隔离合同行为，不等于真实 UAT、生产或数据库写入已经授权和完成。

| 用例 | 验收对象 | 当前证据 |
| --- | --- | --- |
| P01 | 三类发布适配器的目标白名单、精确 SHA、同 SHA 查重、独立回读和未知回执不重发 | PASS：workflow-release-platform.test.js 与 task-release-workflows.test.js 合计 13/13 通过 |
| P02 | Bytebase 目标、SQL 摘要、隔离演练、审批、工单与生产回读身份 | PASS：workflow-bytebase-platform.test.js 5/5；workflow-data-change.test.js 2/2 通过 |
| P03 | Host 目标准入、材料冻结和逐次效果审批 | PASS：workflow-trusted-platforms.test.js 3/3；workflow-service.test.js 50/50 通过 |
| P04 | 真实平台客户端的只读连接、对象身份与客户端代码 | 待验收：Woodpecker token 进程内只读 /api/user 返回 200；UAT/生产 Deployment 与 Bytebase 目标已只读核对，客户端尚缺镜像与来源证明 |
| P05 | 四类目录真实可发起，预检、审批和执行后独立回读 | 未运行：生产触发链/审批人、Bytebase 隔离副本及受信客户端能力未齐，不触发真实副作用 |
| P06 | 精确包安装、本地重启与目录回读 | 未运行：等待代码和平台准入收敛；不得以本轮源码测试替代部署证据 |

本轮完整 `pnpm test`：967/967 通过，0 失败。`git diff --check` 未发现空白错误。测试没有发送真实 UAT 构建、生产发布或数据写入。

缺口：当前发布合同冻结提交 SHA，所以 UAT 集成和生产合并只确认已合入的唯一 PR；不能安全执行未合 PR 的自动合并。UAT 浮动镜像 tag 未证明 Pod 已运行精确 digest。Bytebase 生产目标已读到，隔离副本与同基线证明尚未取得。相关证据缺失时保持不可发起。
