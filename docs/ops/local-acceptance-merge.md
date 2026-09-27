# 合并归一化业务验收

`scripts/local-acceptance-merge.mjs` 是独立受信写场景，支持 `--check`、`api`（或 `execute`）、`cleanup`、`verify-cleanup`。`--check` 零写；`ready:false` 和退出码 2 表示阻断。预检通过不等同真实业务 PASS。

```powershell
node scripts/local-acceptance-merge.mjs --check --config D:/受信目录/merge-uat3.json
```

配置字段：`uatEnvironment:'uat3'`、`databaseAlias:'hiq_editor_uat'`、`expectedDatabase:'hiq_editor'`、绝对路径 `credentialsFile` / `pythonExecutable` / `sourceRepository` / `kubeconfig` / `accountsFile` / `springConfigFile` / `evidenceRoot`、40 位 `sourceCommit`、`expectedTenantId`、两个不同 UUID 的模板 `referenceIds`、`kilogramUnitId`、`tonneUnitId`、`accountKey:'editor_uat_admin'`、显式 `ssoOrigin`。Python 必须具备 psycopg2、redis、PyYAML。凭据文件使用既有 `connections[databaseAlias]`，不把连接串或凭据写入本仓库。此配置只供受信 Host 使用，不能来自模型生成的任意路径。SSO 不按 UAT 编号推导；本轮共享 Spring 配置实际为 editor2，运行配置明确沿用该值。

预检不登录 SSO，不调用业务 HTTP，不创建 ledger。数据库连接自建立起设置只读事务，并检查真实数据库名、来源、单位倍率、外键和用户触发器。代码证据通过精确 commit 读取，不能用工作分支名冒充固定候选。

## 最初预检发现（后续状态见下节）

- 原 PR #371 是旧 `do-merge → mergeDataset2`；UAT3 `feature/uat3-base` 使用 preview/confirmation 服务，必须对真实入口重做验证。
- 2026-09-26 只读盘点发现 `tw_processes` INSERT/UPDATE 触发器会 `pg_notify('editor_tw_processes_table_changes',...)`；DELETE 不触发。下游消费者与索引清理未核实前禁止执行，不能禁用触发器绕过。
- 已知历史参考产品夹具为 `1 t`、声明 `kg`，不满足 `0.5 kg`、声明 `t`，不得修改这些共享旧数据。
- 写适配已实现 namespace 专属夹具、真实 preview/confirm 与精确结果/snapshot 清理；执行前必须由 `initialize` 预登记，缺账不自动补建。

### 2026-09-26 只读实查证据

预检实际返回 `readOnly:true`、`foreignKeys:[]`；阻断为 `SIDE_EFFECT_TRIGGER_UNRESOLVED`、`DEDICATED_FIXTURE_REQUIRED`、`WRITE_ADAPTER_NOT_IMPLEMENTED`。触发器及函数联合 SHA256 为 `fb925227a39750e0541737e945276fa0799a5e3c4f5fd953f357668c0dd63d80`。实际库 `pg_replication_slots` 中当前数据库无逻辑复制槽，`pg_publication` 为空，不能假定存在可兜底删除传播的 CDC。

本地部署仓库 `D:/project/hiq-deploy/business/sql/ddl/hiq_editor_ddl.sql:4603` 保存同名通知函数，`:4719` 明确只监听 INSERT/UPDATE。知识库 `data-sync-service.md` 描述的是 PostgreSQL COPY 同步，不是该通知消费者；`flink-pg-cdc-opensearch/README.md` 的 DELETE 演示也不能证明此 UAT 库部署了 CDC。已检索 dataset 源码、知识库及相关同步仓库，尚未获得通知消费者或精确索引删除接口的证据。

### 后续消费者定位（替代上述“尚未获得消费者”结论）

通过只读 `pg_stat_activity` 发现 `deno-pg-kafka-middleware` 活跃连接，进而定位远程仓库 `HiQ-AI/pg-kafka-middleware`（核对 HEAD `b95a12468b9eafc24d69b4a00eee3ac2f1b2f9d9`）。`src/pg.listener.ts` 订阅配置的 channel 并写 Kafka，`src/kafka.consumer.ts` 转发到配置的向量服务。不是仅凭名称推断：UAT 集群 service proxy 的实际 `GET /api/configs/process_editor/tables/tw_processes` 回读确认 channel 为 `editor_tw_processes_table_changes`、topic 为 `processes-editor-updates-dev`、操作只有 INSERT/UPDATE、目标为 UAT2 lca-search 的 `/api/update-process-embedding`。配置目标 URL 使用 `http:/` 单斜杠，不能以其可能错误作为安全保证，也没有修改它。

线上 pg-kafka 镜像为 `v20250909-1`，实际 imageID 为 `sha256:9eca9bfe0b03b4166ced27ef4a0463a380265bf79d41b8d1fd2ffebd6e38e07a`。lca-search UAT2 镜像为 `v20251030-1`；其 POSTGRES_URL 通过 ConfigMap 引用读取后，仅在内存比较，host/port 与受信 `hiq_editor_uat` 一致，未输出连接值。Pod exec 权限被 RBAC 拒绝，未尝试绕过；上述读取使用已允许的 Kubernetes GET/service proxy。

远程 `HiQ-AI/lca-search` HEAD `68133df6bd7fb5994c26a46cb80d0afd909bfeb2` 的 `src/api/v1/controllers/embedding.ts` 不按 operation 区分删除；`src/core/lca_embedding/process.ts` 在找不到源行时直接返回，存在时调用嵌入服务，随后 UPDATE 同 ID 的 `tw_processes` 向量及 metadata 字段。未找到标准 DELETE 接口。此 HEAD 未与线上镜像建立源码证明，真实业务库也没有这些向量列，因此不能直接推断线上写入范围。即使最终只更新同一过程行，也需核对外部嵌入调用与 Kafka 迟到/重试边界后才能闭合共享副作用。

结论：消费者已经定位；实际部署源码对应关系及外部调用清理/保留契约仍未闭合，`SIDE_EFFECT_TRIGGER_UNRESOLVED` 继续成立。不得把“日志未见错误”或“源行删除后理论不更新”当作完整清理证据。

## 待实现的验收与清理契约

真实流程必须依次完成来源回读、权重各 0.5 的 preview、真实 do-merge、持久结果回读为 1 t（明确拒绝 0.001 t）。不得拦截响应改成预期值。

确认写入 `tw_process_data`、`tw_process_core`、`tw_processes`、`tw_process_doc`、`tb_activities`；copyProcess 来源构造还可能写 `tw_process_modeling_alidation`、`tw_process_flow_properties`。预览另生成绑定用户和租户的 Redis snapshot。所有资源必须登记精确 ID、归属和创建前不存在证据；异常重试不得重复创建。

`dataCleaned` 只描述任务业务数据、精确 snapshot 及已确认的下游派生资源均清理并独立查零。`te_system_log` 是测试审计证据，保留，回执单列可确证的审计 ID/数量。不得为了“零残留”删除共享审计记录，也不得把按账号时间筛选的日志误标为本任务唯一记录。

所有资源（包括历史 ledger 记录的 ID）在删除前重新校验租户、创建人及子行关联。文档若仍被 namespace 外的过程引用、过程 UUID 被其他过程复用，或 core 被清理集合外的数据行引用，立即阻塞，不执行删除。该检查在同一数据库事务内先于全部 DELETE；不会把候选错误复用的共享文档当作测试资源清理。专属 datasource UUID 不创建管理员库实体，管理员实体及质量报告计数必须保持零。

## 当前实现与受信接入

2026-09-26 已对线上 Pod imageID 和 registry manifest 做精确比较，均为 `sha256:d154c2b3b41cce0848fdf55dc51afb885bf0565255bfd4b66b0786acd11cf530`。从校验 SHA 的镜像层提取实际入口，`process.ts` SHA256 为 `972b2714cf4770dd928b1f1c431c3f4050ca45e4b35f20c998758829b747844c`，`embedding.ts` 为 `8652ff1be73fe509ac2bdb47f5ce987c68571ff377c47da621dbec2a112ee476`。实际代码先读取源行，不存在直接返回；后续只有同 ID UPDATE，无 INSERT/UPSERT。迟到处理不能重建已硬删除的过程行。外部调用为 SiliconFlow `/v1/embeddings` 文本转向量，无资源创建/存储接口；队列消息、应用日志及服务商请求审计明确保留，不声称删除。

预检同时核对该线上消费者镜像指纹和数据库触发器指纹，任何漂移都重新阻塞。执行阶段预登记随机 UUID，然后在单数据库事务中从两个旧模板各复制一份最小 process/doc/core/reference-data；仅新副本设置 `0.5 kg`、声明 `t`，不修改旧模板，不走会扩散附属表的 copyProcess。独立回读来源后执行真实 preview/confirm，再回读持久结果 `1 t`。失败时由 Host 调用 cleanup，按精确 ID 和归属清理；丢失 preview 响应时按 namespace、tenant、user 找回自有 snapshot，CAS 删除。confirm/preview 的不确定结果不能自动宣称清理成功。

CLI 从 stdin 接收 `{namespace,baseUrl,uatEnvironment:'uat3'}`，namespace 必须为 `acceptance-` 加 32 位小写十六进制。API 返回 `{namespace,baseUrl,actual}`，actual 为业务事实 JSON 字符串。cleanup / verify-cleanup 分开执行；独立复查数据库、snapshot、当前 token 失效。审计日志不提供可唯一关联字段时，`auditIds/auditCount` 为 null，明确不伪造计数。

本轮不可变运行配置：`D:/dsh_home/workflows/runtime-v2/local-acceptance/merge-uat3-0a18c059dedd.json`。它保留 Java/Maven/Node 路径，显式设置 `TEMP/TMP=D:/dsh_home/workflows/runtime-v2/local-acceptance/temp` 与 JAVA_HOME。生成新配置时从既有受信 JSON 合并上述字段，以内容 SHA 命名并使用独占创建，禁止覆盖在跑配置。工具 bundle 必须复制本脚本及同目录依赖 `local-acceptance-readonly.mjs`，记录各文件 SHA；固定 argv 为 `node <bundle>/local-acceptance-merge.mjs api|cleanup|verify-cleanup --config <immutable-config>`。

### Host 场景 instructions 必须包含的开发约束

使用最新 UAT3 同步候选的 preview/confirmation 入口修复，不搬旧 CommonService 补丁冒充覆盖。prepare-dataset 要求以下 `src/main/java/` 文件以 `@ConditionalOnProperty(name="app.background-jobs.enabled", havingValue="true", matchIfMissing=true)` 控制后台任务：

- `com/ecdigit/ecdata/task/ApprovalReminderTask.java`
- `com/ecdigit/ecdata/task/DataQualityReportTask.java`
- `com/ecdigit/ecdata/task/DatasourceVersionCalculateTask.java`
- `com/ecdigit/ecdata/task/VersionDiffReportTimeoutTask.java`
- `com/hiqdata/convertor/domain/task/reconcile/TaskReconciler.java`
- `com/ecdigit/ecdata/config/RedisStreamConsumerConfig.java`
- `com/ecdigit/ecdata/controller/internal/ApprovalReminderDebugController.java`

此外 `com/ecdigit/ecdata/service/BlacklistCacheService.java` 必须读取 `${app.background-jobs.enabled:true}` 并控制后台行为。缺失时由正式开发模型补齐八处，不跳过 prepare 检查。后台控制是环境前提；业务 expected 必须是两个 0.5 kg 来源声明 t、各权重 0.5、持久合并结果 1 t，不能以开关检查代替业务用例。
# 精确数值证据

## 后端专项检查配置接入

`scripts/configure-project-local-acceptance.mjs` 支持 `--checks-proposal <绝对JSON路径>`，与 bundle、merge-policy 在同一次 profile CAS 中更新。提案仅含 repository（固定 dataset）、sourceChecksSha256（当前 checks 数组 JSON 的 SHA256）、checks。只允许 dataset-package 从 version 1 升到 2，在原打包步骤前加入固定 verify-dataset-unit-tests.mjs（--java 与 --maven-home 的绝对路径）；原打包步骤及其他检查必须一致。

先以 `--check --expected-sha256 <当前profile摘要>` 零写核对，再由受控部署以相同输入 `--apply`。整体 profile 或原 checks 漂移均拒绝；已完全相同的配置重复应用零写。更新冻结检查只供新任务使用，不覆写旧运行定义或旧验收回执。后端两组纯计算单测由受信脚本限定，不能以 package 的 skipTests 声称单测通过。

预览 JSON 的 resultValue 数值词元通过原生 JSON reviver 保存原始十进制文本，数据库数值按文本读取。两者均使用有界十进制规范化精确比较，不经 Number 舍入。1、1.0、100e-2 等价；末位非零差异必须拒绝。ledger 保留 previewReferenceValue、referenceProof 原始值，actual 的 sourceValue/resultValue 从真实回读生成，不能复制 expected。需要支持 JSON reviver context.source 的受信 Node 运行时，否则明确失败。

### 前端固定伴随后端的后台隔离证明

新冻结配置的 `review-*.json` 包含受信 `companionArtifact: {path, sha256}`，由同一 bundle 的 dataset companion 身份生成。`prepare-web` 在依赖安装前对这一固定 JAR 执行 `LocalAcceptanceBackground` 编译级隔离校验，启动时 runner 仍独立复核 JAR SHA。缺少身份、摘要不符或存在未受控后台入口均阻断，不可借用其他候选的证明。

本轮旧固定 `ffe45c7c…` JAR 实际被拒绝：`ApprovalNotificationOutboxTask` 字节码只有 `@Component`、定时 dispatch，无后台总开关注解，会读取并更新共享 outbox。当前新配置可通过结构检查，但不能将此记为业务验收通过；须经正式开发流程产出隔离正确的 UAT2 companion 后，再生成新冻结配置。
