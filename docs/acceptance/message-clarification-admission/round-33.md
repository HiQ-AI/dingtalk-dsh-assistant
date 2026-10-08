# 第33轮：只读查询参数错误不误报授权不足

实际Owner两次columns调用省略schema，尽管tables已返回public.tw_process_drafts，旧工具仍以QUERY_SCOPE_DENIED结束，促成不必要的授权请求。唯一已登记短表名现直接解析为其schema.table；未知或歧义短名返回QUERY_ARGUMENT_INVALID并提示使用tables结果，明确跨schema/越权列仍拒绝。不扩大资源、表或列权限，能力身份升级为agent-db-read-v4。

node --test --test-name-pattern='数据库' test/agent-query-tools.test.js：2/2 PASS，真实执行284ms；覆盖唯一短名、歧义/未知短名、跨schema和越权列拒绝、只读事务及参数化。日志docs/tmp/sg15-database-final.log。

另复用已登记hiq_editor_uat连接与只读事务核验四张候选表实际列；最小只读配置提案保留其它资源/权限，尚未在线应用。Kubernetes UAT2 dataset实际部署的POSTGRES_HOST/PORT来自uat-env，与登记连接一致；无显式POSTGRES_DB_EDITOR/SCHEMA_EDITOR覆盖。消息服务目标为hiq-message，消息表不在Editor连接中，不臆造表或复制生产权限。当前只确认参数修复及结构读取，未声称消息投递问题已查明。

## 四表真实业务读取能力补证

使用隔离的 `uat-review-direct-queries.json` 提案实例化现有 `createAgentDatabaseReadCapability`，复用 `createRegisteredPostgresConnector` 与已登记 `hiq_editor_uat` 连接；未应用线上配置、未新增连接或消息库。

执行 `node docs/tmp/authorization-state-tests/verify-uat-table-read.mjs`。对四张登记表分别执行结构化 `select`，仅取 `id`、`limit:1`，每次由既有能力建立只读事务并回滚、关闭连接。未输出或保存查询到的 ID 值。

| 表 | 返回条数 | 字段 | transactionReadOnly | 原生 verify |
| --- | ---: | --- | --- | --- |
| public.tw_process_drafts | 1 | id | true | PASS |
| public.te_approval_application | 1 | id | true | PASS |
| public.te_approval_assignment | 1 | id | true | PASS |
| public.te_approval_review_record | 1 | id | true | PASS |

本次证明四表登记后确实能够读取业务行，不只是目录结构可读；属于能力验证，没有绑定本次具体审核申请，不据此判断撤回通知的业务原因或投递状态。脱敏汇总保存在 `docs/tmp/authorization-state-tests/uat-four-table-read-proof.json`，不含个人数据。
