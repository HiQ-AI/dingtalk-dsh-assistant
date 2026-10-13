# 托管配置执行底座验证

日期：2026-10-13。此文件记录运行时专项证据，页面交互结果仍以 matrix.csv 和编号 round 为准。所有数据库客户端均为隔离 stub，未读取真实凭据、连接正式数据库或执行部署。

## 已接入并实跑的边界

- `execution-controller.js` 在新 Run 持久创建前冻结引用；串行保护配置冻结与创建准入，重投/已有 Run 不补冻最新值。只有 code executor 获得配置读取器，读前后校验取消和当前节点租约。
- `execution.js`、`workflow-service.js` 透传配置服务；`agent-query-database.js` 的显式托管模式按受信 connectionId→configAlias/passwordAlias 读取，保留 PostgreSQL 结构校验、只读默认参数和错误脱敏，缺绑定不回退文件。
- 原生 LocalCredentialProvider、真实 Store/Artifacts/Controller 与隔离 Client 组合验证：导入普通 JSON 和 secret 后冻结旧 Run，修改变量、移动原 JSON，再重建 provider/Host，旧 Run 使用原值，新 Run 使用新值。重投不能污染新 runId 快照，跨流程读拒绝；取消后已捕获读取器失效。模型执行参数、产出工件和状态不含测试秘密/连接配置正文。
- 无配置服务时不读取变量的旧执行保持工作；实际读取失败关闭。无快照的旧 Run 重投后仍无快照。
- `openExecutionRuntime` 真实入口透传测试验证冻结和节点读取，未仅测试导出函数。

## 已执行命令

| 命令 | 实际结果 |
| --- | --- |
| `node --test test/execution-controller.test.js` | 139 / 139 PASS，224664.7761 ms |
| `node --test test/execution-configuration.test.js test/agent-query-database-all-tables.test.js` | 14 / 14 PASS，2284.7087 ms |
| `node --test --test-name-pattern '数据库目录提供真实连接和结构范围' test/workflow-service.test.js` | 1 / 1 PASS，757.95 ms |
| `node --test test/configure-agent-query-resources.test.js test/agent-query-database-all-tables.test.js` | 21 / 21 PASS，429.7888 ms；增加托管映射后的配置脚本与 connector 验证 |

## 尚未构成证明的边界

截至本记录，code 节点集成用的是隔离测试定义。现有工程节点只允许 engineering_repo_inspect / engineering_apply_edits，原生会话会按 definition.allowedTools 限制工具；已退休的调查工作流不可借本次变更恢复。因此，新增 directQueries 托管映射与 service 连接适配器本身尚不证明已有工作流可实际消费；生产消费增量仍在收敛，必须补最终路径和实跑证据后再宣称闭环。

平台 secretsDirectory/kubeconfig、工程 Spring 配置、sharedDataProfilePath 与脚本 --config 仍是文件消费者，未自动迁移。正式数据库连接、业务查询、钉钉会话和部署均未验证。
