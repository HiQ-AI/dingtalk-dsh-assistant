# 数据变更受信接入与本地 UAT 演练

## 现状

本机数据变更目录不可发起，直接原因是 `workflow.platforms.bytebase.targets` 未登记。现有 Host 仅提供 Bytebase 数据库身份与 `/schema` 只读回读；`workflow-bytebase-platform.js` 还要求生产侧 SQL 审查、工单创建/对账、执行/回读端口及独立 UAT PostgreSQL 端口。`workflow-postgres-uat-platform.js` 已有精确连接、事务回滚和持久回执合同，但尚未由 Host 装配。

## 本轮目标与边界

- 生产目标只允许 `projects/flbn` 下的 `hiq_editor`、`hiq_background_db`、`hiq_admin` 三库，每库绑定同名 UAT PostgreSQL 库，目标和认证资料由本机 Host 冻结，不由消息生成。
- UAT SQL 审查、结构基线、脚本前置条件和事务演练只经本地受信 PostgreSQL 连接执行，不调用 Bytebase。演练在同一会话 `BEGIN`→SQL→只读核验→`ROLLBACK`，脚本和目标表触发器若可能产生事务外副作用则拒绝。
- 天翼云生产只读副本通过本机受信 PostgreSQL 连接提供生产结构基线和固定 pg_catalog 查询；Bytebase 处理生产库身份、Sheet→Plan→Issue 工单、批准后 Rollout/Task 执行和独立回读。UAT 本地 SQL 审查先于事务演练；生产与 UAT 对脚本所涉表使用同一目录查询和规范化指纹，指纹不等即阻断。工单创建回读后仍在 Assistant 任务页等待真人审批；Bytebase `SKIPPED` 不等于批准。
- 凭据仅从 `D:/baibu-agent/.secrets` 读取，profile 只保存目标标识；UAT 连接必须显式限定数据库、主机、端口和最小权限。未知写回执只读对账，不能重放。
- 平台不能证明完整能力或涉及表的同结构基线时，数据变更保持不可发起；生产结构基线使用天翼云只读副本固定实时 pg_catalog 查询，不依赖陈旧的 Bytebase `/schema` 缓存同步时间。生产写入仍只能通过 Bytebase；不能通过宽泛 MCP、直连生产主库写入或跳过审查来开放目录。

## 验证

先以只读探测核对三组数据库身份、结构版本和必要权限；隔离测试覆盖非法目标/SQL、事务外副作用、回滚、重复和未知回执、工单幂等、审批撤销和生产回读。完整本地安装后回读目录状态。无具体业务变更授权时，不为验收创建真实 Bytebase 工单或执行 SQL。
