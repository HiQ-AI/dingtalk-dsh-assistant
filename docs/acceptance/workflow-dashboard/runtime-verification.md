# 托管配置执行底座验证

日期：2026-10-13。最终回归基于检查点 `7d40832` 合并 `origin/main`（`f1487e0`）后的工作树。页面/API 和最终交付状态以 matrix.csv、编号 round 及报告为准。数据库客户端、LLM 输出均使用隔离替身；未读取真实凭据、连接正式数据库、执行业务部署或发钉钉消息。

## 接入边界

- `execution-controller.js` 在新 Run 持久创建前冻结引用；串行保护配置冻结与创建准入，重投及已有 Run 不补冻最新值。只有 code executor 获得读取器，读前后校验取消与当前节点租约。`execution.js`、`workflow-service.js` 透传配置服务。
- 配置服务按受信 instanceId 隔离存储，同实例内按 runId 唯一冻结；测试重启保持相同 instanceId。旧 Run 缺快照时不自动采用最新值，跨目录流程拒绝，工程派生 workflowId 沿同一目录身份读取原快照。
- connector 的托管来源按 Host 的 connectionId→configAlias/passwordAlias 映射读取，普通 JSON 仅允许 host/port/db/user，密码从 secret 独立读取。托管 port 严格检查类型及范围；缺变量不回退文件。未映射文件保持原 pg 参数语义，包括缺省 port 和空密码；只读事务、表列授权与副本/角色检查未放宽。
- 生产消费入口为新增工程 v26 的 `inspect-and-propose` 节点。仅同时存在显式托管映射和原 permissions 授权的数据库进入 scope/catalog；`apply-changes` 保留原两个工具。实际工具集、冻结范围及 scope 方案参与摘要。无托管映射、仅旧文件配置或无授权数据库时，新 v26 工程仍可创建，但不增加数据库工具。
- Host 从持久 Run、当前节点及真实 binding 核验版本、工具权限与租约，使用 Run 的 workflowId 读取快照；模型不能选择别名或扩大范围。消息/Task Owner 没有 Run 快照，访问托管资源明确拒绝；未迁移资源保持原查询能力。
- `resetTaskExecution` 复用配置创建队列，先检查 receipt/requestDigest，再以完整 reset.check 核验新 Run 登记、版本及占用，冻结后提交原事务；reducer 再校验一次。预览不冻结、回执重投不重冻。v26 重发保持同一 Run、原快照、冻结 scope 和工具。

## 正式原生工程链

`test/workflow-managed-query-native.test.js` 使用真实 openWorkflowService、工程 registry、SQLite Store、Artifacts、Controller，以及原生 AgentRegistry/AgentLoop/ToolRuntime/SessionStore/JSONL 持久化和 LocalCredentialProvider。源仓库与 bare remote 均在隔离目录。协调器/Owner 返回受控决策，原生 LLM 适配器驱动真实登记的工具调用，pg Client 为无网络替身。

用例经正式任务接纳→v26 工程准备→工作区→原生方案节点触发 `query_readonly_database`，从原生会话持久事件提取证据，再读取 Host 工件断言 `[{id:7}]`。这不是手动执行任意定义或只测导出 connector。导入普通 JSON 与 secret 后，旧 Run 查询；修改变量、移动原 JSON、关闭并重建 Host。旧 Run 自动恢复仍用原版本，新任务使用新版本，连接顺序为旧/旧/新，原路径读回 ENOENT。

实际 service.resetExecution 验证：预览不创建快照；维护排空且任务暂停时重置成新 Run，仅冻结一次；再次改变量并重投原请求，回执与快照不变，冲突重投拒绝。退出维护并显式恢复后，原生方案节点实际查询重置时冻结的版本。还验证过期 binding、Owner 拒绝、仅旧文件/无权限时实际模型工具目录无查询工具，以及模型请求、JSONL、工件、任务文件均不含测试秘密或连接配置正文。

`test/execution-configuration.test.js` 补充真实 code 节点和 openExecutionRuntime、取消后读取器失效、恶意复用 commandId/runId 不污染快照、跨流程拒绝、未接服务的不读变量流程正常、旧 Run 不补冻。历史 v25 与 v26 摘要/重建的独立证据见 [工程历史定义独立验证](historical-definition-verification.md)；不能以一个夹具推断所有历史组合。

## 最终合并后命令

从仓库根执行。三组各运行一次，共 46 个不同用例全部通过；中断后独立回读完整测试汇总，确认进程已结束，没有重复执行。日志均位于 `docs/tmp/workflow-dashboard/`。

| 命令 | 结果 | 原始日志 |
| --- | --- | --- |
| `node --test test/execution-configuration.test.js test/execution-task-reset.test.js test/agent-query-database-all-tables.test.js test/workflow-managed-query-native.test.js` | 23/23 PASS，47106.1469 ms | runtime-merged-final.log |
| `node --test --test-name-pattern '普通UAT构建失败收口' test/workflow-service.test.js` | 4/4 PASS，9570.3396 ms，含 unsent | runtime-merged-source-service.log |
| `node --test test/workflow-source-upload.test.js test/workflow-source-evidence.test.js` | 19/19 PASS，59264.4043 ms | runtime-merged-source-upload.log |

合并源码复核：execution-controller 的上游差异仅终止 UAT 构建错误码改取真实 receipt.reason；配置冻结和 reset 接点仍完整。workflow-service 上游合并主要改变稳定 stepKey 与真实绑定会话展示，托管消费/权限接线保留。工程合同的上游变化是发布字节恢复，由独立历史验证和 engineering-approach-contract 专项验证；不修改历史定义来规避摘要差异。最终原生 v26 重启及 reset 路径已在合并源码重跑通过。

## 合并前各轮命令

下列计数包含重叠用例，不能相加作为独立用例总数。全组通过后，仅为新改动补定向验证，未运行全量 pnpm test。

| 命令 | 次数及结果 | 原始日志 |
| --- | --- | --- |
| `node --test test/execution-controller.test.js test/execution-store.test.js test/execution-task-reset.test.js` | 1 次，248/248 PASS，226760.5231 ms；后续增量另验 | runtime-controller-store.log |
| `node --test test/workflow-engineering.test.js` | 1 次，45/45 PASS，570904.0035 ms；后续 reissue 增量另验 | runtime-engineering.log |
| `node --test --test-name-pattern '工程空方案重发' test/workflow-engineering.test.js` | 2 次：0/1 后修复；1/1 PASS，41668.304 ms | runtime-v26-reissue.log；runtime-v26-reissue-round2.log |
| `node --test --test-name-pattern '数据库目录提供真实连接和结构范围\|Owner直接查询证据经真实Service' test/workflow-service.test.js` | 1 次，2/2 PASS，11602.2953 ms | runtime-service-query.log |
| `node --test --test-name-pattern '编辑工具登记只接受\|new simplified run' test/execution-controller.test.js test/execution-task-reset.test.js` | 1 次，6/6 PASS，1736.9428 ms，含 v26 apply 额外工具拒绝及 reset | runtime-v26-admission-reset.log |
| `node --test test/execution-store.test.js test/execution-task-reset.test.js test/execution-configuration.test.js test/agent-query-database-all-tables.test.js test/configure-agent-query-resources.test.js` | 1 次，134/134 PASS，165229.3593 ms；当次 reset 参数集尚未含 v26，后续专项补齐 | runtime-final-targeted.log |
| `node --test test/workflow-managed-query-native.test.js` | 单项迭代 7 次：前 5 次 FAIL；round6 1/1 PASS，18503.6246 ms；补无托管/无权限反例的 round7 1/1 PASS，43221.2122 ms | runtime-managed-query-native-round3-fail.log、round4.log 至 round7.log |
| `node --test test/execution-task-reset.test.js test/execution-configuration.test.js test/workflow-managed-query-native.test.js` | 1 次，11/12，54353.6398 ms；原生含 reset 查询通过，唯一失败为 unit 夹具 close 缺项 | runtime-reset-configuration-round1.log |
| `node --test --test-name-pattern 'controller reset admission' test/execution-task-reset.test.js` | 诊断 1 次，0/1，同一 close 缺项 | runtime-reset-admission-debug.log |
| `node --test test/execution-task-reset.test.js test/agent-query-database-all-tables.test.js` | 修正夹具及旧文件参数兼容后 1 次，18/18 PASS，5034.3673 ms | runtime-reset-connector-round2.log |

早期底座阶段另有 controller 139/139（224664.7761 ms）、configuration+connector 14/14（2284.7087 ms）、catalog 单项 1/1（757.95 ms）、proposal+connector 21/21（429.7888 ms）；这些不是最终 v26 验证，交付采用后续表格结果。

## 失败与修正

1. 原生第 1、2 次未建立工程 Run。首轮夹具缺正式 `legacy.workspaceDir`，Owner 证据核验报 `TASK_OWNER_QUERY_EVIDENCE_INVALID`；次轮消息原文未包含 uat2，Host 去掉未获原文支持的目标后报 `TASK_OWNER_ENGINEERING_INPUT_REQUIRED`。补齐工作区与原文，没有绕过门禁。两轮原始日志被早期同名重定向覆盖，**未保留 raw**；`runtime-native-initial-failure-readback.json` 标为 reconstructed summary，并独立回读保留的临时 SQLite Owner 错误。它不是原始测试日志。
2. 原生第 3 次 raw 已保留：对二次 JSON 序列化后的模型请求使用错误子串断言。连接和工具已工作，但该轮是 FAIL；改为读取真实会话证据。
3. 第 4 次 raw 已保留：结束的会话已卸载，`ctx.sessions.get` 为 undefined；改用原生 `ctx.sessionPersistence.inspect`。
4. 第 5 次 raw 已保留：预期两次连接，实际三次。真实 Host 重建自动恢复旧 Run，再创建新任务；正确断言为旧/旧/新，没有忽略恢复连接。第 6 次通过；第 7 次追加无映射/无授权反例后通过。
5. v26 重发首轮 raw：`WORKFLOW_REISSUE_UNSAFE`。store reducer 仍硬编码 v22，修正为来源 v26 保持 v26，核验冻结 databaseQuery 不变并使用对应前缀节点；第二次真实重发通过。
6. 独立审查用最小 probe 反证 `Number(true)`/数组可被当作端口；托管分支改为严格类型检查，boolean/array/非法字符串在创建 Client 前拒绝。后续审查发现规则同时影响旧文件默认值，现限定托管分支；缺省端口/空密码回归通过。
7. 独立审查发现 reset reducer 直接插入新 Run，绕过 createRun 冻结；补正式 controller 接纳与完整检查。首轮组合原生 reset 查询通过，unit 收尾因 `sessions:{}` 缺 close 失败，raw 已保留；诊断重现后仅补夹具 close，reset+connector 18/18，最终合并后组合 23/23 全部通过。

## 未迁移与未验证

平台 secretsDirectory/kubeconfig、工程 Spring 配置、sharedDataProfilePath 与脚本 --config 仍为文件消费者，需逐项显式迁移。配置 Tab 不代表所有旧文件自动迁入。未验证真实数据库可连、正式角色权限、业务查询、真实模型自主方案完成、完整工程发布、钉钉消息或部署。
