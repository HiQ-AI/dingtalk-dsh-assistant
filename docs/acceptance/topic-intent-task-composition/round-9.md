# 第九轮：本地受信连接装配与准入审计

以 `matrix.csv` 的 `round_9` 列为准。本轮没有 UAT 重建、生产发布、Bytebase 工单或 SQL 外部写入。

| 用例 | 结果与证据 |
| --- | --- |
| P07 | PASS：新增 Cordis Host 客户端插件，从当前 Poller Kubernetes Secret 读取 Woodpecker token（只在进程内），GitHub 由本机 `gh auth token`，Kubernetes 由 UAT kubeconfig 访问；Registry 通过本机 Docker `buildx imagetools inspect --raw`，按原始字节重算 digest。真实 UAT3 dataset 清单 `sha256:cc00a10a126a34c1239497f6d6bf5dce96b3a2cbd51ac4379996caf29dba7d7e` 与期望相同，目标 Deployment generation 232/232、Ready 1/1。本地代码全量测试 982/982；精确 tgz 长度 387880 字节，SHA256 `D4A10F310315DD6B4F5F25CE691E2880FF2C37CC8C5A22455427A18838CCBF6A`。部署前旧进程 33192 两端口归属一致，73 旧 Task 和 5 工作流 Task 全部 completed、pending 通知 0。停机后备份 SQLite 65724416 字节、SHA256 `C2E07154686655B9C8B5C4EA26639D94A8BA3B04DF9678CC390865BEF89F7453` 及 profile/storage。新包安装后关键文件与源码 SHA256 一致；profile 在 Resident 前注册 Host 客户端，新 PID 32640 同时监听 3080/18998，`/health=ok`、恢复故障 0；73+5 Task 均仍 completed。 |
| P04 | FAIL：UAT 交付与重建仍缺能独立核验本地 E2E/PR/来源包的受信 attestation 端口及精确目标清单；生产目标和 Tag 触发/发布范围未冻结。Bytebase 当前受信端口 13 项仅实现数据库读取 1 项；当前账号全局项目/实例列表 403，已知 `projects/flbn` 15 个库均标生产，未确认 Bytebase 管理的 UAT 配对库；所查最近 100 个 Issue 审批状态均 `SKIPPED`，不能冒充真人审批。数据库读取已修复为按平台返回 project、instanceResource、effectiveEnvironment 核验，不再使用请求方环境冒充。真实本地目录四类仍 unavailable，未宣称可发起。 |

Host 客户端可读取平台不代表完整外部工作流可用；四类流程须分别通过目标、证明、审批及执行/回读检查后才能转换目录状态。真实凭据未写入仓库或验收记录。