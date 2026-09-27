# Dataset 本地验收启动前置检查

## 当前结果

2026-09-26 已完成当前源码、已有打包产物、启动配置及后台副作用检查。审查发现现有启动路径缺少统一后台关闭参数；经用户授权，已在独立候选工作区增加关闭开关，构建并真实启动成功，完成存活及全部就绪依赖回读后停止进程。仅调用两个只读探针，未运行业务验收或写入测试数据。

## 已确认的运行材料

- 源码目录：`D:/dsh_home/workflows/runtime-v2/sources/dataset`。
- 已有构建产物：`D:/dsh_home/workflows/runtime-v2/engineering/dataset/checks/verify-tuoy9A/target/jimudataset.jar`，155753937 字节。该目录无 Git 元数据，使用前须另行核对候选代码身份；不能只由文件名推断版本。
- Java：`D:/soft/jdk-11.0.2/bin/java.exe`；项目 `pom.xml` 指定 Java 11，最终包名 `jimudataset`。
- Maven：`D:/soft/apache-maven-3.9.6`。已有工程构建使用 `-DskipTests package`，仅证明打包，不能作为业务验收。
- 配置入口：`src/main/resources/application-local.yml`。包含三个核心 PostgreSQL 数据源、主 Redis/Redisson、GWP Redis、两个 gRPC 服务、SSO、文件对象存储等依赖；不在此文档复制连接凭据。
- `HealthController` 定义 `/health`（仅存活）及 `/ready`（三个核心 PostgreSQL 数据源、Redis、两条 gRPC 连接）。`/health` 成功不能代替 `/ready`，两者成功也不能代替业务验收。

## 已处理的启动副作用

1. `com.ecdigit.ecdata.task.DatasourceVersionCalculateTask` 多个每 10 秒/每分钟 `@Scheduled` 无总开关。`executeSyncTask()` 取得全局 Redis 锁，读取共享进行中版本并调用同步业务；其他方法推进发布、计算等任务。`lca.calculate.queue.enabled=false` 仅切换计算排队路径，不能停止后台调度。仅将 PostgreSQL 连接设为只读，仍不能阻止 Redis 锁和先于数据库更新发生的外部调用。
2. `com.ecdigit.ecdata.config.RedisStreamConsumerConfig.redisStreamMessageListenerContainer()` 无条件创建消费组（`XGROUP CREATE MKSTREAM`），订阅发布、上架、任务三个流并启动监听。`spring.redis.queue.pending-recovery.enabled=false` 和 `spring.redis.queue.trim.enabled=false` 只关闭恢复与裁剪，不关闭主监听。更换 `key-prefix` 仍会创建共享 Redis 数据，不等于只读启动。
3. `TaskReconciler` 启动默认回收所有共享 `RUNNING/PENDING` 导入导出任务。必须设置 `task.reconcile.startup-enabled=false` 与 `task.reconcile.sweep-enabled=false`。
4. `VersionDiffReportTimeoutTask` 实现 `ApplicationRunner` 且有定时扫描，必须设置 `version-diff-report.timeout-scan.enabled=false`。
5. 另需关闭 `approval.reminder.enabled`、`data-quality-report.enabled`，避免消息提醒与报告任务。主类和计算任务类均有 `@EnableScheduling`，不能假设 Spring Boot 自动配置开关能取消显式调度。

上述后台入口已通过下面的统一开关控制，并在独立候选目录完成构建和启动。需要业务写入的验收仍须使用任务隔离数据与清理回执。

## 可复用启动方式

使用包含下述本地验收模式提交的候选，配合独立工作目录、未占用回环端口、隐藏窗口启动 Java，参数包含 `--spring.profiles.active=local`、`--server.address=127.0.0.1`、`--server.port=<分配端口>` 以及已实现的关闭开关。共享连接从仓库外受信配置注入，不能在日志或命令输出暴露凭据。启动回执记录实际 JAR 哈希、PID、端口、`/health` 与 `/ready` 的 HTTP 状态及组件状态；结束后停止本次 PID 并回读端口释放。未实际执行的命令不得标成验证通过。

## 隔离候选修复

用户确认添加本地验收模式后，在 `D:/project/worktrees/dataset-local-acceptance` 的 `codex/local-acceptance-mode` 分支实施；基线为源 checkout 当前 `bb022f5279483e8b8814d6486ccf82d63ef3f1ec`，未切换或改动源 checkout，未选择或推送任何 UAT 分支。

增加 `app.background-jobs.enabled`，默认 true，启动验收必须显式 false。上述六个后台 Bean 与依赖审批提醒任务的调试控制器使用 Spring Boot `ConditionalOnProperty`；黑名单缓存保留启动只读加载与业务服务，只有周期刷新遵循开关。共涉及 8 个 Java 文件及 README，无业务 SQL 修改。

内部构建实跑命令：设置当前构建进程 `JAVA_HOME=D:/soft/jdk-11.0.2`，执行 `D:/soft/apache-maven-3.9.6/bin/mvn.cmd -DskipTests -DskipJarEncryption package -q`。`skipJarEncryption` 是项目已有内部构建开关；不运行测试。构建退出码 0。

## 本次真实启动回读

- 本地提交：`2e201996`，未推送；未指定 UAT 环境，因此不创建 PR。
- 新构建 JAR：`D:/project/worktrees/dataset-local-acceptance/target/jimudataset.jar`；SHA256 `C770746DEF3927E8DE3D6BBDDC6DE7A5BF3BFDC4CDA00BB36834A114DC6550F9`。
- 启动时间：2026-09-26 18:16:08 +08:00；PID 37512；仅监听 `127.0.0.1:53426`；Spring 报告启动耗时 29.9 秒。
- 实际命令：`D:/soft/jdk-11.0.2/bin/java.exe -jar D:/project/worktrees/dataset-local-acceptance/target/jimudataset.jar --spring.profiles.active=local --app.background-jobs.enabled=false --server.address=127.0.0.1 --server.port=53426`。
- 工作目录：assistant 隔离工作区 `docs/tmp/dataset-startup-probe`；窗口隐藏，日志留在忽略目录，不入库。
- `GET /health`：HTTP 200，`UP`。
- `GET /ready`：HTTP 200，`UP`；`db:admin`、`db:hiq_lcd`、`db:hiq_background_db`、`redis`、`grpc:calculate`、`grpc:calc` 全部 `UP`。
- `javap` 确认编译后的 Redis 消费配置类包含 `ConditionalOnProperty(name=app.background-jobs.enabled,havingValue=true,matchIfMissing=true)`；日志未出现 Redis Stream 消费启动、消费组创建或共享任务扫描信息。
- 结束前核对 PID 的 Java 命令及候选 JAR 身份，再停止本次进程；独立回读 PID 已退出、53426 监听端口已释放。

此次使用应用现有 `local` profile 所提供的共享 UAT 连接依赖，无新增连接秘密或环境变量；唯一新增应用开关是 `app.background-jobs.enabled`。本次结果证明候选可以启动且上述就绪依赖可连接，不证明任一业务功能验收通过。后续工作流验收须使用对应任务候选 JAR、明确业务场景及数据清理证据，不能复用本次启动结果作为业务验收票据。

## UAT2 正式 Runner 接入结果

用户之后明确使用 UAT2。已从其对应分支准备隔离候选，将本地验收模式纳入提交 `9101283277add9fd34fa85f302420c0fd718ba3a`，使用仓库外共享 UAT 配置启动。正式 runner 的真实登录、单位分页查询、注销与进程清理通过；两个项目配置已在本地 web profile 启用，详见[本轮完整证据](../acceptance/topic-context-completeness/round-24.md)。此处仅证明本轮只读场景，不替代后续功能的专门验收条件。

## 2026-09-27：UAT2 companion 补齐通知 outbox 开关

来源分支 `codex/uat2-local-acceptance`，本地提交 `55a366e3e9c53c38e0a1abf5040cf633a7508871`（父提交 `9101283277add9fd34fa85f302420c0fd718ba3a`）。仅给 `ApprovalNotificationOutboxTask` 增加 `app.background-jobs.enabled` 条件，默认 true；没有改动审批 API 或线上 UAT2，也未推送。

使用 JDK 11/Maven 3.9.6 的固定参数数组执行 `-DskipTests -DskipJarEncryption package -q`，退出 0。新包位于 `D:/project/worktrees/dataset-uat2-local-acceptance/target/jimudataset.jar`，SHA256 `a910900644dad0db7ad18546db1fda9027f12c8f46b8a214722de5f3beac52bc`。

实际受信隔离 Spring 探针验证：8 个受控 Bean 在 false 不注册、true/default 注册；黑名单首次只读 1 次、关闭模式额外刷新 0 次；扫描 3072 类。旧 ffe45 包仍因 false 模式注册通知 Outbox Bean 被拒绝。该验证不启动完整业务服务、不登录、不接入共享资源。证明见 `docs/tmp/background-probe/uat2-safe/readback.json`；构建成功日志 `uat2-outbox-build-rerun.log`，首次 PowerShell 参数解析失败日志保留于同桶。Host 定向测试 10/10 PASS（`uat3-optional-outbox-tests-rerun.log`）。新包还需正式冻结入 companion 配置并执行前端业务验收，不能把本条证明当作前端已验收。
