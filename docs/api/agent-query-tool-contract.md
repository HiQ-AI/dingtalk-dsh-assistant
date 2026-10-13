# 共享 Agent 查询工具合同

`createAgentQueryTools({capabilities,resolveScope,artifacts})` 返回共享执行会话的 tools 数组。每项 `execute({binding,input,args,signal})` 使用 Host 的 resolveScope，顺序调用现有 capability 的 authorize / execute / verify；只安装 `effectClass=read`，每项能力必须提供 parameters JSON Schema。输入错误、路径不存在、分页限制和查询超时属于 correctable；越权、来源变化、身份失效、核验失败与未配置连接属于 fatal，不接受模型给出的错误分类。

工具返回 `{evidenceRef,result,sourceRefs}`。工件记录 kind=agent-query-evidence、规范 execution 身份、scopeDigest、capabilityId/identity、输入摘要、result、verification 和 observedAt。模型不能指定工件来源；`verifyAgentEvidence({artifacts,refs,binding,allowedBindings,scope})` 精确核对身份集合、当前 scope、结果摘要与来源，失败抛错，成功返回 `{sourceRefs}`。allowedBindings 只能由 Host 从持久执行历史重建，不接受模型传入。临时 sessionBound/inputRef 不参与身份。

## 已实现能力

- `query_project_resource`：登记的文件根与路径、或指定 Git 提交。list、search、read；没有终端/任意命令；目录不跟随链接、拒绝 .git/.secrets/.env/私钥路径。read 上限16000字符，search每页最多200文件/4MiB，nextOffset 为文件序号；truncatedFile 表示需继续 read 该文件。仅常见凭据字段做遮盖，Host 仍必须登记可读范围，不能以遮盖代替敏感数据授权；最终对外回复遵循业务数据红线，不直接转发源码或日志。
- `query_readonly_database`：登记逻辑连接、schema/table/columns；结构化 tables、columns、constraints、indexes、dependencies、table_stats、select 与参数化条件，不接受 SQL/表达式/连接串。默认每次检查真实角色、目标 schema CREATE/表写权限与数据库侧只读事务。显式 `environment: uat` 加 `identityPolicy: host-enforced-readonly` 时，可由 Host 使用用户指定的现有 UAT 账号，仍逐次验证只读事务；其他环境不得启用该模式。两种模式都限定8秒语句超时、最多100行/24KiB，最终 rollback。连接配置由 Host 从受控托管配置或已登记本机文件读取，模型不接收正文。columns 返回类型长度、默认值、可空、identity/generated；元数据操作只访问已登记 metadataSchemas，select 仍受表/列白名单约束。dependencies 是目录直接依赖，table_stats 是估算规模，不能当作完整业务依赖或精确行数。生产查询逐次核验副本身份。
- `query_runtime_status`：Host 固定GET URL及标量字段白名单，不接受模型URL、禁止重定向，5秒/64KiB限制。日志/配置文本由明确登记的 file 资源读取；不要登记含凭据的完整 profile。

## 配置与授权

资源定义与 Agent 授权分开：directQueries.permissions 包含 resourceIds / databaseIds / statusIds，是 Agent 自身职责范围的授权集合，不包含 actorId 或 conversationId。发送者身份用于来源及执行归属，不选择资源权限。旧 grants 配置必须通过新版提案替换，运行时明确拒绝，不静默迁移。环境提案保留在部署方本地，不能直接复制其他环境的资源标识。

`directQueries.configurationConnections` 可将既有 connectionId 显式映射到 `{configAlias,passwordAlias}`。前者引用普通 JSON（仅 host/port/db/user），后者引用秘密文本；port 仅接受整数或十进制数字字符串且范围 1–65535。映射键必须是 databases 已登记连接，别名以字母开头、仅字母数字下划线短横线、最多 64 字符。映射中的连接不读取 credentialsPath，也不因缺快照/缺绑定/类型不符回退文件。未映射连接仍要求原绝对 credentialsPath；全部迁入可省略该路径。配置提案不接收变量正文或秘密，不自动扩大 permissions。

工程 v26 仅在「分析并提出方案」节点获得该工具，其冻结 scope/目录只包含同时已授权且已映射的资源；v25 和历史流程不增加工具，v26 无此资源也不增加工具。Host 从真实 Run/节点/定义判断窄 scope，复核当前租约、taskId、sessionId 和取消状态，再用 Run.workflowId 读取本 Run 的配置快照。数据库 capability 将 Host binding/signal 传给连接器，模型参数合同保持不变。消息问答和 Task Owner 无 Run 快照，托管资源返回 `QUERY_CONFIGURATION_TASK_NODE_REQUIRED`，其余登记查询继续原规则。配置值和 secret 不写入模型输入、查询证据或错误正文。

内置查询能力通过 `available(scope)` 声明当前授权范围是否包含实际登记的资源，消息 Host 用它选择会话工具。该方法仅控制工具可见性，每次调用仍必须执行 authorize 和权限变化核对。消息问答及调查阶段的 context 同时提供授权后的资料、数据库和运行状态目录，资料列出逻辑标识、说明、代码版本及允许读取的相对路径，不传宿主根目录、连接凭据或端点地址。Agent 在登记路径内定位文件；范围内文件不存在可纠正，越出登记路径仍拒绝，不能因用户猜测路径扩大权限。

现场已验证资料、固定提交搜索/读取及状态查询。数据库实际查询须对正式配置的目标资源单独验收；已有 UAT 账号的本地只读事务探针不等于 Agent 会话与渠道验收。

## Kubernetes运行资源

`query_runtime_status` 另接受Host登记的 `kind: kubernetes` 资源：精确 `kubeconfig/server/skipTlsVerify/namespace/deployment`。同一resourceId同时回读部署、Pod及受控日志，不新增调度阶段。现有 `createPlatformClients.kubernetes.readDeployment/readPods`负责所属部署/ReplicaSet/Pod读取；调用包装增加12秒命令超时、1MiB输出上限与取消信号，总查询60秒。模型仍只能提供resourceId。

返回运行镜像tag/imageID digest、Pod就绪/重启、部署generation与resourceVersion；查询末尾重查Deployment，变化则拒绝。配置仅投影容器端口和cpu/memory/ephemeral-storage requests/limits；不输出env、Secret、ConfigMap或完整YAML。日志每容器固定最近10分钟/最多200行/32KiB，输出时间、WARN/ERROR等级、异常类、Java代码位置与计数，绝不返回原始正文/请求参数。最多8 Pod、每Pod4容器。当前无经过核验的业务消息模板，`messageTemplatesSupported=false`，不能据此声称支持完整日志根因排查。空窗口或无错误匹配不证明服务无错误。

部署版以真实Pod imageID为准，未映射Git证据时不猜提交SHA；K8s Ready不等于业务验收。`skipTlsVerify`沿用已有客户端的显式配置，新增环境优先配置可信CA；此选项不由模型选择。登记、配置写入和真实查询必须分别核对，不以存在资源提案代替已接入。

## 调查覆盖合同

新建 investigation v8 从原生 tool/call 与 tool/result 重建本轮已成功查询集合，完成交付须逐项引用或显式排除；不能只引用原群消息绕过实际查询核验。引用同一查询从 offset=0 到 nextOffset=null 的连续证据；search 的截断文件须引用相同文件摘要的完整 read。无关查询可在 coverageExclusions 中明确引用并说明排除理由。Host 在结果验证时检查覆盖，缺页反馈为 AGENT_WORK_COVERAGE_INCOMPLETE，不能只凭结论自称调查完整。旧 v5/v6/v7 使用原冻结定义恢复，不套用新合同。
