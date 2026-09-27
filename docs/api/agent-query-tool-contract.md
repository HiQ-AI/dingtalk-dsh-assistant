# 共享 Agent 查询工具合同

`createAgentQueryTools({capabilities,resolveScope,artifacts})` 返回共享执行会话的 tools 数组。每项 `execute({binding,input,args,signal})` 使用 Host 的 resolveScope，顺序调用现有 capability 的 authorize / execute / verify；只安装 `effectClass=read`，每项能力必须提供 parameters JSON Schema。输入错误、路径不存在、分页限制和查询超时属于 correctable；越权、来源变化、身份失效、核验失败与未配置连接属于 fatal，不接受模型给出的错误分类。

工具返回 `{evidenceRef,result,sourceRefs}`。工件记录 kind=agent-query-evidence、规范 execution 身份、scopeDigest、capabilityId/identity、输入摘要、result、verification 和 observedAt。模型不能指定工件来源；`verifyAgentEvidence({artifacts,refs,binding,allowedBindings,scope})` 精确核对身份集合、当前 scope、结果摘要与来源，失败抛错，成功返回 `{sourceRefs}`。allowedBindings 只能由 Host 从持久执行历史重建，不接受模型传入。临时 sessionBound/inputRef 不参与身份。

## 已实现能力

- `query_project_resource`：登记的文件根与路径、或指定 Git 提交。list、search、read；没有终端/任意命令；目录不跟随链接、拒绝 .git/.secrets/.env/私钥路径。read 上限16000字符，search每页最多200文件/4MiB，nextOffset 为文件序号；truncatedFile 表示需继续 read 该文件。仅常见凭据字段做遮盖，Host 仍必须登记可读范围，不能以遮盖代替敏感数据授权；最终对外回复遵循业务数据红线，不直接转发源码或日志。
- `query_readonly_database`：登记逻辑连接、schema/table/columns；结构化 tables、columns、select 与参数化条件，不接受 SQL/表达式/连接串。默认每次检查真实角色、目标 schema CREATE/表写权限与数据库侧只读事务。显式 `environment: uat` 加 `identityPolicy: host-enforced-readonly` 时，可由 Host 使用用户指定的现有 UAT 账号，仍逐次验证只读事务；其他环境不得启用该模式。两种模式都限定8秒语句超时、最多100行/24KiB，最终 rollback。连接配置仅Host从本机 secrets 读取。
- `query_runtime_status`：Host 固定GET URL及标量字段白名单，不接受模型URL、禁止重定向，5秒/64KiB限制。日志/配置文本由明确登记的 file 资源读取；不要登记含凭据的完整 profile。

## 配置与授权

资源定义与实际主体授权分开：resourceIds / databaseIds / statusIds 是 resolveScope 的授权集合，应包含可信主体/群权限版本及项目范围。资源配置本身不自动授权任何群。环境提案保留在部署方本地，不能直接复制其他环境的主体或资源标识。

内置查询能力通过 `available(scope)` 声明当前授权范围是否包含实际登记的资源，消息 Host 用它选择会话工具。该方法仅控制工具可见性，每次调用仍必须执行 authorize 和权限变化核对。消息问答及调查阶段的 context 同时提供授权后的资料、数据库和运行状态目录，资料列出逻辑标识、说明、代码版本及允许读取的相对路径，不传宿主根目录、连接凭据或端点地址。Agent 在登记路径内定位文件；范围内文件不存在可纠正，越出登记路径仍拒绝，不能因用户猜测路径扩大权限。

现场已验证资料、固定提交搜索/读取及状态查询。数据库实际查询须对正式配置的目标资源单独验收；已有 UAT 账号的本地只读事务探针不等于 Agent 会话与渠道验收。

## Kubernetes运行资源

`query_runtime_status` 另接受Host登记的 `kind: kubernetes` 资源：精确 `kubeconfig/server/skipTlsVerify/namespace/deployment`。同一resourceId同时回读部署、Pod及受控日志，不新增调度阶段。现有 `createPlatformClients.kubernetes.readDeployment/readPods`负责所属部署/ReplicaSet/Pod读取；调用包装增加12秒命令超时、1MiB输出上限与取消信号，总查询60秒。模型仍只能提供resourceId。

返回运行镜像tag/imageID digest、Pod就绪/重启、部署generation与resourceVersion；查询末尾重查Deployment，变化则拒绝。配置仅投影容器端口和cpu/memory/ephemeral-storage requests/limits；不输出env、Secret、ConfigMap或完整YAML。日志每容器固定最近10分钟/最多200行/32KiB，输出时间、WARN/ERROR等级、异常类、Java代码位置与计数，绝不返回原始正文/请求参数。最多8 Pod、每Pod4容器。当前无经过核验的业务消息模板，`messageTemplatesSupported=false`，不能据此声称支持完整日志根因排查。空窗口或无错误匹配不证明服务无错误。

部署版以真实Pod imageID为准，未映射Git证据时不猜提交SHA；K8s Ready不等于业务验收。`skipTlsVerify`沿用已有客户端的显式配置，新增环境优先配置可信CA；此选项不由模型选择。登记、配置写入和真实查询必须分别核对，不以存在资源提案代替已接入。
