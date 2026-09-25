# 第十二轮：数据变更本地 UAT 演练与生产只读基线

以 `matrix.csv` 的 `round_12` 为准。本轮没有业务 SQL 授权，因此没有执行真实 UAT UPDATE、创建 Bytebase 工单或触发生产写入；P04 保持 `NOT_RUN`。

| 用例 | 结果与证据 |
| --- | --- |
| P02 | PASS：受信 Host 的 UAT SQL 审查与事务演练均使用本地 PostgreSQL 连接；单表限定、触发器及其他不可证明副作用阻断、事务回滚、精确结果和未知回执由隔离测试覆盖。生产与 UAT 对脚本涉及的表以相同 pg_catalog 查询形成结构指纹；全库其他表可不同。 |
| P03 | PASS：生产结构基线改由本机直连天翼云只读副本获取；Bytebase 仅用于生产工单、批准后执行与回读。工单创建仅至 Sheet→Plan→Issue，Assistant 任务页真人批准后才创建 Rollout/Task。 |
| P06 | PASS：`pnpm test` 全量 1011/1011；定向回归 45/45；`git diff --check` 通过；profile 配置脚本 `-Check` 返回 `already-configured`。 |
| P07 | PASS：本地精确安装包 SHA256 `33b4e869f554dc49b870a61376ddf2f231454036118055c6f87bef7783813e87`，新 PID 38936 监听 3080/18998，`/health` 返回 `ok`，数据变更目录版本 3 为 `available`。源码与安装包内六个相关 JS 字节哈希一致。安装后受信 Host 逐一只读连接三组生产天翼云副本，均证实 `transaction_read_only=on`、`pg_is_in_recovery=true`，以及三组 UAT PostgreSQL 数据库；所有六个目标均取得当前目录基线。 |

本轮只证明受信连接、审查与事务演练的隔离测试、本地运行态和只读基线。实际业务 SQL 的影响行、UAT 回滚与 Bytebase 工单写权限仍需在具体任务中按批准的 SQL 验收。部署中曾发现 profile 的 `adapterVersion` 被 YAML 解析为数字导致启动失败，配置脚本已修复为字符串并支持重复 `-Check`；随后重新启动和回读成功。
