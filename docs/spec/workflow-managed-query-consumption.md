# 托管配置的现有查询消费

日期：2026-10-13。本文件记录生产消费增量的开工方案；变量存储合同沿用 workflow-managed-configuration.md。

## 缺口与选择

仅向受信 code 节点提供 reader、导出 PostgreSQL connector，仍不能让已有工作流消费用户保存的变量。现有 query_readonly_database 的 Host 工具已经收到真实执行 binding，但数据库 capability 没有把它传给连接适配器。进一步追到原生会话发现：工程 v25 的 allowedTools 未授权此工具，输入也没有查询 scope；只接适配器仍无法使用。这是初选方案的反证。

最终选择新增工程 v26，保留 v25 及所有历史定义、摘要和恢复路径。v26 仅给 inspect-and-propose 节点显式增加已配置的 query_readonly_database 和 Host 冻结的 scope/数据库目录，权限及 scope 方案进入定义摘要；apply-changes 保持原两个工具。无已授权数据库时不授予此工具，工程仍能创建。不复活已经退休的调查流程。

另外两个候选不适合本次最小闭环：通用 capability 阶段只支持 file.write，增加数据库动作需要改变流程定义；平台客户端在启动时建立全局闭包，改成按运行读取影响多类发布操作。它们继续保持原文件来源，后续必须显式迁移。

## 接线与参数

`workflow.directQueries.configurationConnections` 是受信 Host 登记的 connectionId 到 `{configAlias,passwordAlias}` 的映射。它只选择既有 databases 中的连接，不创建资源、不扩大 permissions 或表列范围。普通 JSON 的字段为 host/port/db/user，password 使用单独 secret 文本。

被映射的连接只读取执行快照，缺少服务、快照、绑定或类型不符即拒绝；即使同时配置 credentialsPath 也不回退。未映射连接继续使用原 credentialsPath。全体连接都迁移后可以移除 credentialsPath；混用时该文件只负责未迁移的连接。配置提案脚本按同一规则校验，不读取凭据或连接数据库，保留 check/CAS apply。

共享工具仍做 scope、资源、SQL 和结果核验。数据库 capability 将 Host binding/signal 传给 connector。workflow-service 对托管连接要求 task-node 身份，读取当前 Run 和节点，核对 taskId/sessionId、generation/inputDigest/leaseEpoch 及取消/暂停状态；使用持久 Run 的 workflowId 调用 configuration.forRun。每次读取前后复核租约，绝不信任模型传来的 workflowId 或别名。消息问答和 Task Owner 没有执行 Run 快照，对托管连接明确拒绝；其余资源查询不变。

能力 identity 纳入托管映射，来源配置变更不能误用旧 scope。变量正文和秘密只在 Host connector 内使用，不进入模型目录、工具参数、结果、工件或错误。配置错误保留稳定机器码，不回显底层异常。

## 验证

运行真实 service/query tools/controller 链路，用隔离 pg Client 证明 v26 工程节点的原生会话实际注册和调用托管数据库工具；保留资源授权、只读事务与结果证据。覆盖旧 Run 冻结、新 Run 新版本、原输入文件移动后重建 Host、错误 kind/缺绑定无文件回退、跨 task/session/过期租约拒绝，以及消息/Owner 拒绝托管资源。扫描模型参数与执行工件确保无配置正文或秘密。

配置脚本另验托管全部/混合来源及非法映射；历史 v25 精确摘要恢复、旧版无新增工具以及 v26 无配置创建必须回归。此验证不连接正式数据库，不部署，不自动导入原文件，不声称平台和工程文件消费者已迁移。
