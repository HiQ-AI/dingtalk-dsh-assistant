# 受信平台工作流接入

简单可空加列同时接受 `smallint`、`integer`、`bigint` 的范围内十进制整数常量 `DEFAULT`，例如 `integer DEFAULT 0`，复用精确目录预检和插件审批，不另加演练。其他类型默认值、表达式、函数及 `NOT NULL` 继续不属于简单路径。默认值验收保存并精确比较 PostgreSQL 目录原表达式；`0` 是字符串 `"0"`，不能省略或改为 null。

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

“本地 E2E、PR 和来源包的受信验收证明读取”是程序对现有执行记录的平台回读，不要求另造证明文件。业务 E2E 仅在独立业务验收中从检查工件判定；UAT 部署不要求业务 E2E，普通构建通过也不能冒充业务验收。PR 从 GitHub 回读开发提交、目标分支合并身份及 Git tree；来源包从 Woodpecker 同提交构建日志、Registry 清单摘要、目标 Pod imageID 及业务入口核对。任何一环未证实就保留对应阻断，不能用任务口头摘要代替。

UAT 部署可独立发起，显式给出白名单目标和目标分支当前提交；预检回读目标分支及唯一已合入且 merge SHA 等于当前分支 SHA 的 PR。作为工程流程后继阶段时，额外核对同一工程 Run 的不可变工件、GitHub PR 的 head、merge 与 Git tree，开发提交和目标分支合并提交的 tree 必须与工程候选一致，但不要求业务 E2E。部署完成仅确认 UAT 运行版本，回归、提测与验收另行执行。UAT 同提交重建则回读完整 Woodpecker 流水线列表：精确目标 SHA 构建失败、没有更新的成功或在途构建、前一个成功构建的摘要与 Registry 清单和当前 Deployment 所属 Ready Pod imageID 一致，才允许重建。两类检查由 Host 固定客户端实现，不需要单独的 `attestations` 服务。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产目标还需已核实的 Tag→Woodpecker 触发链。生产 Tag 是**每次任务**明确给出的 `action.arguments.releaseTag`（格式 `vYYYYMMDD-N`），与 commitSha 一起冻结在 Run 的 target、审批范围和效果身份中；不得写死在 `release.targets`，不得由模型猜序号。同一生产目标可按不同 Tag 多次发布，每次均重新检查 Tag 冲突、流水线与真人审批。UAT 部署预检与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- 当前生产目标白名单只允许 `HiQ-AI/dataset` 的 `dataset` 与 `HiQ-AI/dataset-web` 的 `dataset-web`，均以已核实的 `main` 分支和 `hiqlcd-app-prod` Deployment 为准；其他服务不加入 `release.targets`。准入仍取决于生产触发链、可信客户端和审批入口全部通过，不因出现在白名单中就自动可发起。
- bytebase.targets 每项登记唯一 id、Bytebase 项目和精确生产目标。新数据变更 v6 的单条新增可空、无默认值列先由生产只读连接核对准确表列，生成候选 DDL 并提交 Bytebase；不要求 UAT 目标、全库一致或额外业务用途调查。复杂 SQL 仍要求配置 UAT 目标并完成既有演练。生产写入只经过 Bytebase，新增列验收通过生产只读副本固定列目录查询完成。
- 外部写操作沿用持久效果账和独立回读。数据变更先创建并回读 Sheet、Plan、Issue；Bytebase 3.18 可自动创建未执行 Rollout/Task 并将 Issue 标为 DONE，该状态不能证明 SQL 执行。适配器只接纳独立回读为 NOT_STARTED 且没有 TaskRun 的既有 Task。新工单在任何 Sheet/Plan/Issue 写入前只读核对准确生产环境的原生 rollout_policy 为手动策略；AUTO、无权限或缺少完整策略返回均拒绝发送。人工审批使用插件审批账与认证身份，绑定准确目标、SQL、工单、当前运行和变更包。待审继续等待，驳回保留意见并在同 Task 修改候选、关联原工单重新送审；SQL 改动使旧批准失效。Bytebase 原生审批的 SKIPPED、APPROVED 不作为插件审批结果，不能用自动生成的 DONE 替代插件真人批准。批准后复用既有 Rollout/Task，执行前再次回读批准和目标，执行后分别核对 TaskRun 与真实数据库列属性。既有冻结流程保持原定义恢复。生产发布的 Web 真人批准与 Tag 来源链保持既有合同。
- D:/baibu-agent/.secrets 中的凭据只由本机受信客户端读取；Host 配置和模型输入不包含凭据值，凭据也不能写入仓库、工件或日志。不得把宽泛的 Bytebase MCP call_api 当成受信执行端口。

简单加列的新定义为 v6。候选形成前不读取生产全库基线；受信适配器解析单条 DDL 的 schema/table，生产只读 Host 用参数化目录查询和独立行数核验获取该表基线。scope、摘要和快照身份冻结进变更包，准备、校验、批准后执行均核对同一准确表范围。模型提供的范围或基线不作为可信输入。复杂 SQL 保留原全库基线与 UAT 合同；持久化 v3/v4/v5 定义按原合同恢复。

## 本地客户端装配

在 `web` profile 的 `insert` 列表中，先于 `@zzusp/dingtalk-dsh-assistant/resident` 插入：

```yaml
- id: dingtalk-task-workflow-platform-clients
  name: '@zzusp/dingtalk-dsh-assistant/platform-host'
  config:
    secretsDirectory: 'D:/baibu-agent/.secrets'
```

Host 在启动时只读取当前 Poller Secret、GitHub CLI 登录及 Docker buildx 可用性，失败则拒绝装配；不会把凭据写入 profile。目标白名单仍由 `workflow.platforms` 单独配置，缺证明和目标时目录保持不可发起。部署前先核实当前 Poller Secret 名称与 UAT K3s Server；若变更，更新客户端配置和定向验证后再安装，不修改凭据文件来适配旧代码。

复杂数据变更接入时，同一 Host 配置另需 `uatPostgres.receiptDbPath`（本机持久 SQLite 文件的绝对路径）、`uatPostgres.targets` 和 `productionPostgres.targets` 三项 `{project, target}`；Resident 的 `workflow.platforms.bytebase` 另登记三个 `{id, project, target, uatTarget}`。生产 `target` 是 Bytebase 资源名，只读连接精确映射 `.secrets/db-credentials.json` 中的 `tianyi_editor_slave`、`tianyi_bg_slave`、`tianyi_admin_slave`，须确认 `pg_is_in_recovery()=true` 和会话只读。`uatTarget`/Host `target` 是 `{instance: postgresql/192.168.8.8:30770, database: 同名库, environment: uat}`。三处清单必须逐项一致，Host 不从配置读取用户名或密码。安装前用只读客户端核对三库 `current_database()`、会话只读、实时 catalog 完整行数和生产副本身份；不得用过期 Bytebase `/schema` 缓存快照替代。UAT 回执文件所在目录应与工作流控制账一同备份，未知预留不能自动清除后重演。
当前已核实的 UAT 部署目标如下；本机配置以这些精确资源为白名单，每次仍需独立预检：

目标 ID 分别为 `dataset-web-uat2-deployment` 与 `dataset-uat3-deployment`，`kind` 均为 `uat-deployment`。发起时指定目标 ID 和目标分支当前 `commitSha`；工程流程自动后继时可由受信工程 Run 推导目标和提交。部署结果 `uat-deployed` 仅代表精确版本运行成功。

既有生产发布与同提交重建定义的摘要包含节点函数字节。`task-release-workflows.js` 在 `.gitattributes` 中保持原始换行，新增流程不得改写旧节点的源码换行或适配器规则摘要；升级前后均应在持久账本上验证旧定义可恢复。

| 服务 | 仓库/分支 | Woodpecker 仓库/Cron | Kubernetes Deployment | Registry 镜像 | 业务入口 |
| --- | --- | --- | --- | --- | --- |
| dataset-web UAT2 | `HiQ-AI/dataset-web` / `feature/uat2-base` | `2` / `dataset-web-uat2-poll` | `hiqlcd-app-uat2/dataset-web` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web` | `https://editor2.hiqdat.dev/` |
| dataset UAT3 | `HiQ-AI/dataset` / `feature/uat3-base` | `1` / `dataset-uat3-poll` | `hiqlcd-app-uat3/dataset` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset` | `https://editor3.hiqdat.dev/api/dataset/ready` |

生产发布仅登记下列目标候选，Tag 不写在目标配置里，每次任务单独指定。现有只读证据表明两项 Deployment 均为 Ready 2/2，历史 `v20260918-1` Tag 构建的 Woodpecker manifest 摘要与 Registry、Ready Pod imageID 一致；新版本仍须每次重新核对。

| 服务 | 仓库/分支 | Woodpecker 仓库 | Kubernetes Deployment | Registry 镜像 | 业务入口 |
| --- | --- | --- | --- | --- | --- |
| dataset | `HiQ-AI/dataset` / `main` | `1` | `hiqlcd-app-prod/dataset` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset` | `https://editor.hiqlcd.com/api/dataset/ready` |
| dataset-web | `HiQ-AI/dataset-web` / `main` | `2` | `hiqlcd-app-prod/dataset-web` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web` | `https://editor.hiqlcd.com/` |

Bytebase `projects/flbn` 下的三个已确认生产数据库分别是 `instances/flbnpguaf/databases/hiq_editor`、`instances/flbnpguaf/databases/hiq_background_db`、`instances/flbnpguaf/databases/hiq_admin`，环境均为 `environments/prod`。同名 UAT PostgreSQL 数据库通过 `192.168.8.8:30770` 本地连接；Host 从 `.secrets/db-credentials.json` 精确读取 `hiq_editor_uat` 连接，仅复用其主机、端口与凭据并显式指定三库各自数据库名。UAT receipt SQLite 放在 Host 持久目录。复杂 SQL 的既有演练审查支持单表整数列 UPDATE 与同表 SELECT 回查；新增可空无默认值列走上述 v4 简单路径；有触发器、规则、RLS、外键或 CHECK 等复杂对象时拒绝演练，不将其泛化为任意 SQL 支持。

以上仓库 ID、Cron 分支和命名空间来自当前 Poller/Kubernetes 只读回读，业务回归见 `../acceptance/topic-intent-task-composition/round-8.md`。运行时仍须检查分支头、目标 SHA、同 SHA 构建与独立制品/Pod 证据。
## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。`@zzusp/dingtalk-dsh-assistant/platform-host` 可在 Resident 前由 Cordis 加载，从本地 UAT/生产 kubeconfig 与当前 Poller 的 `db-dev/woodpecker-poller-credentials` Secret 取凭据；GitHub 令牌由本机 `gh auth token` 获取。Bytebase 由本机 `.secrets/bytebase.json` 登录；生产基线由本机天翼云只读副本的固定 pg_catalog 查询实时取得并校验结果行数，UAT 由本地 PostgreSQL 连接取得独立基线。Bytebase 缓存 `successfulSyncTime` 陈旧不代替实时基线。Registry 只读回读用本机 Docker 凭据运行 `docker buildx imagetools inspect --raw`，并对原始清单字节重算期望 digest。插件只提供客户端，不能单靠安装使目录可发起。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起。平台连接只读探测与真实写操作分别验收；没有具体业务变更授权时，不为验收创建真实 Bytebase 工单或执行 SQL。2026-09-25 只读复核已从 Woodpecker Base64 日志解析出 dataset 与 dataset-web 的历史 UAT2 构建摘要，并与 Registry/Pod 回读一致；先前未解码原始 JSON 而判定“日志无摘要”的结论作废。现有工程检查只有构建/打包，未配置业务 E2E 检查 ID；这不阻止独立 UAT 部署，但不能据此声称业务验收完成。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。构建证明读取精确成功流水线的 `buildkit-build-and-push` 步骤，通过 Woodpecker `/api/repos/<repoId>/logs/<pipeline>/<stepId>` 返回的 JSON `data` 做 Base64 解码，只接受唯一完成的 `exporting manifest` 与同摘要的 `pushing manifest for <image>@<digest> ... done`；HTTP 200 的 HTML SPA、配置摘要、layer digest 和未完成进度行都不构成证明。生产必须由目标分支/合并 SHA→真人审批→Tag→Woodpecker 同 SHA 构建及产物 digest→Registry 顶层清单及平台子清单 digest→Ready Pod imageID/Deployment 就绪→业务入口组成完整来源链，不允许本地 Docker 发布。Deployment 不要求不存在的源码 SHA 注解。Bytebase 脚本通过持久效果账在精确 UAT 数据库演练并按 operationKey 独立回读；演练只证明该 UAT 状态下的结果，不证明生产行数据相同。

## 开发 PR 目标门禁

新增工程任务参数 `uatEnvironment` 只接受 `uat1`～`uat9`，对应目标只能是 `feature/uatN-base`。未明确环境先向用户询问；不要在 repository 配置中用 `baseBranch` 代替用户选择。远端不存在对应分支时阻断，不自动创建或换环境。重发接口 `reissue-repository` 可携带该参数；省略时仅复用该任务此前明确保存的环境。

独立上线流程 `task-main-pr-merge` 需要可信 `mainMergeAdapter` 与现有外部效果授权端口。适配器必须提供精确 PR/SHA 的 UAT、业务验收和真人批准证据，并在合并后独立回读 main、PR 号和提交身份。仅新增流程定义不代表本地平台已经接入此能力。此次规则不迁移历史 PR 目标，也不触发真实合并。

## 工程 v11 本地验收接入

`repositories[].localAcceptance` 由受信 Host 配置，包含 `version`、`sharedDataProfilePath`、`prepareSteps`、`service`、`scenarios`、`cleanup`、`verifyCleanup`、`timeoutMs`。`service` 配置固定 `executable`、`args`（使用 `{port}` 指定本地端口）与 `readyPath`；`scenarios` 每项提供 `id`、`description` 及固定 `executable`、`args`。Agent 只能选择已登记场景并填写任务用例，不能提供任意命令替代 Host 配置。

`sharedDataProfilePath` 指向仓库外的 JSON 文件，结构为 `{ "environment": "uat", "env": { ... } }`，凭据不得写入版本库、节点报告或 PR。九个 UAT 环境读取同一个共享数据库连接配置；明确选择的 `uatEnvironment` 负责 PR 分支和部署环境，不负责切换数据库。配置变更按现有部署 runbook 备份并安装，报告源码更新和真实项目配置接入的状态应分开。

验收链先确认当前任务验收条件与场景配置，再编写覆盖全部条件的用例，准备候选代码的独立目录及任务数据标识，启动修改后的服务、等待就绪、执行场景并比较预期与实际，最后清理本任务数据、停止本次服务并独立确认。验收回执绑定候选代码、方案和任务数据标识；结果失败或清理缺证据均阻止提交。中断后的未知执行先核对效果，不直接重复写入共享库。清理命令只能操作本任务命名空间，不能清空共享表或移除其他任务数据。

当前文档声明的是接入契约；没有真实 `localAcceptance` 配置时，流程以 `LOCAL_ACCEPTANCE_CONFIG_REQUIRED` 等待。Dataset 已完成带后台关闭开关的真实启动及共享依赖就绪检查，见 [启动记录](dataset-local-acceptance-startup.md)；当前受信只读 API/浏览器场景及会话清理见下文，必须由真实 runner 对当前候选执行；不能以该启动结果、隔离用例或构建通过代替业务验收证据。

本地验收的外部操作使用统一资源键 `external:local-acceptance:shared-uat`，避免不同 UAT 编号或连接文件别名导致并发验收互相影响。未知执行和未确认清理保留操作占用，不自动重放业务请求。失败报告仍保留预期、实际及清理结果。

启动命令须直接启动服务进程，参数包含 `127.0.0.1` 与 `{port}`，当前实现核对 Windows 端口实际归属 PID，不接受只启动后自行退出的包装器。就绪阶段先以无凭据 HTTP 轮询，成功后必须确认进程仍存活且端口归属正确；每个业务用例前再次核对主服务与伴随服务。进程检查失败在阶段和总收据保存安全分类、退出码、信号及耗时，不记录原始命令或 stderr。`timeoutMs` 显式配置 1000～2400000 毫秒。固定场景命令从 stdin 接收 JSON `{namespace,baseUrl,uatEnvironment,case}`，其中 case 提供 criterionId、scenarioId、steps、expected、parameters；stdout 仅输出 `{namespace,baseUrl,actual}`。actual 必须来自实际业务执行，不能回显 expected 冒充验收。场景参数合同写在 Host 的 description 中。

清理命令从 stdin 接收任务命名空间及本地地址，先清理本任务数据；停止本次服务进程后，verifyCleanup 通过共享数据库独立只读检查并返回 `{namespace,empty:true}`。verifyCleanup 不能依赖已停止的本地 HTTP。连接配置中的环境变量值仅注入受信子进程，不出现在节点报告中。配置及受信场景脚本应位于候选源码之外，由 Host 审核后登记；不能把 Agent 输出直接作为 argv 执行。


## Dataset 与 Dataset Web 实际接入步骤

### 范围与依赖

本轮用户明确选择 UAT2，两个项目配置只接受 `uatEnvironment=uat2`；其他 UAT 不能套用这份配置。共享数据库仍是同一套 UAT 数据库，前端 SSO 明确绑定 `https://editor2.hiqdat.dev`，开发 PR 对应 `feature/uat2-base`。操作实例前先按 [本地部署 runbook](resident-review-local-deployment.md) 确認任务、持久效果、备份与回退边界。

外部运行配置位于 `D:/dsh_home/workflows/runtime-v2/local-acceptance/uat2-runtime.json`，列出 Java、Maven、Node、Yarn、Spring 配置目录、Playwright 模块、凭据文件与证据目录。当前依赖使用 JDK11、Maven3.9.6、Node22.13.0、Yarn1.22.21 和独立 headless Edge；Yarn 从已固定版本的 Corepack 缓存取得，Playwright 来自明确的本机依赖目录。启动脚本须校验路径存在，不从模型建议临时下载执行器。登录凭据从 `D:/baibu-agent/.secrets/test-accounts.json` 的明确账户键读取，不复制到源码、bundle 或报告。登录可能影响同账户已有编辑器会话，必须使用已授权验收账户。

### 三个 Host 脚本

| 脚本 | 职责 |
| --- | --- |
| `scripts/local-acceptance-project.mjs` | 校验显式 UAT1～9 配置及任务环境一致性与外部依赖，构建候选 Dataset 或安装 Dataset Web 冻结依赖，编译启动本地前端并绑定本次后端 |
| `scripts/local-acceptance-readonly.mjs` | 真实登录、允许列表内只读 API/页面读取、预期与实际投影、认证会话及浏览器清理和独立回查 |
| `scripts/configure-project-local-acceptance.mjs` | 从外部双项目 bundle 校验并接入 `repositories[].localAcceptance`；提供 `--check` 与带备份的 `--apply` |

Dataset 服务使用 `local` profile、仓库外 Spring 连接配置与 `--app.background-jobs.enabled=false`，准备阶段检查候选源码具备后台总开关，再以 `-DskipTests -DskipJarEncryption package` 构建。Dataset Web 使用本地候选源码构建，后端作为伴随服务按固定绝对 JAR 路径和 SHA256 启动。前端 `/api/dataset` 指向该次回环后端，浏览器先核对可信响应头中的后端 origin/SHA256 与直接后端就绪响应。后端 JAR 按内容摘要放到仓库外不可变目录；后端功能变化时必须重新构建及更新对应产物绑定，不能沿用旧 JAR 证明新功能。

### 生成、实跑、激活

1. 核对外部 runtime JSON 的 UAT2、工具路径、已授权账户与外部 Spring 配置；准备包含后台总开关的 UAT2 后端候选及 JAR。使用 `docs/acceptance/topic-context-completeness/scripts/prepare-uat2-project-configuration.mjs` 固化两个运行脚本和后端 JAR，生成仅含 `dataset`、`dataset-web` 两键的外部 bundle；记录输出路径及 JAR 摘要。此步不修改运行 profile。
2. 用 `run-uat2-project-acceptance.mjs <project> <bundle绝对路径> <输出绝对目录>` 分别实跑两个项目的真实 runner。每次冻结候选、准备目录、启动、场景读取、停止及清理，保存准备工件和最终回执。工程编排在本地验收前已单独构建；前端准备阶段只安装冻结依赖，由 Vue CLI 启动时编译当前候选，避免重复静态构建。脚本内单位分页、登录页与单位列表是接入验收用例，仅证明对应条件，不代替任意开发任务的功能验收。
3. 对正式 profile 执行以下零写校验。脚本使用仓库声明的 `js-yaml` 并保留 `!!js` 代码字符串；既有配置更新必须携带已审阅的 profile SHA256。剥除明确允许更新的字段后，配置须与原文深比较一致。

   ```powershell
   node scripts/configure-project-local-acceptance.mjs --profile D:/dsh_home/profiles/web/cordis.patch.yml --bundle <bundle绝对路径> --check
   ```

4. 按 runbook 停止实例并完成持久数据备份后，用同一参数及 `--expected-sha256 <已审阅profile哈希>` 执行 `--apply`。脚本取得独占 lock 文件，再检查原文、备份、原子替换并独立读回；其他脚本实例、过期哈希都会拒绝。相同配置不重复写。锁仅约束遵守该锁的配置工具，应用期间不得使用编辑器或其他工具并发改写 profile；遗留锁须先确认所属进程已退出，不能盲目删除。
5. 安装本次修改涉及的精确包并启动实例，独立核对安装文件、profile 双项目配置、进程及健康状态；记录真实 runner 回执与部署回读各自结果。本节提供操作步骤，不表示已激活或部署成功。

### 只读数据与清理证据

当前允许场景为真实单位分页、草稿、工作区只读查询与受限浏览器读取；禁止把只返回空列表的 `/unit/getList` 当作真实数据查询证据。业务写入、合并计算、创建/删除等要求超出本轮场景，缺少对应受信场景时应停止。前端外部遥测持续阻断，非允许列表的业务请求令验收失败。

本轮不创建业务测试数据，清理回执依据只读请求账证明创建数为零，并注销本次认证会话、独立回读会话失效、关闭浏览器、停止本次服务及伴随后端；不执行共享表删除。后续若新增写入场景，必须同时提供任务命名空间的数据隔离、精确清理及独立数据库回查，不能复用只读清理器冒充数据已清理。服务启动、页面加载、接口成功、业务断言及清理完成分别留证据。

### 两项历史任务的配置更新（dataset UAT3 / dataset-web UAT2）

本次远程提测目标分别为后端 UAT3、前端 UAT2。准备仓库外的双项目 bundle，仍只包含 `dataset`、`dataset-web` 两键；各值是完整 localAcceptance 配置。先实际执行对应业务验收并确认清理，不能把既有只读接入场景当作修复验收。后端合并计算场景未实现时，不登记虚构 ID，也不激活整条链。

另准备仓库外的 merge-policy JSON，结构为 `{"targets":[{"targetId":"dataset-uat3-deployment","requiredChecks":[],"requiredScenarioIds":["已实现并验证的后端业务场景ID"]},{"targetId":"dataset-web-uat2-deployment","requiredChecks":[],"requiredScenarioIds":["已实现并验证的前端业务场景ID"]}]}`。这里的场景名称是格式说明，不能直接使用。脚本只允许这两个既有目标及对应仓库/分支，并要求每个场景 ID 已存在于待安装 bundle。GitHub 实际必要检查仍在合并执行时实时回读；空列表不跳过真实规则。

以下 PowerShell 命令在仓库根执行，将 `$bundle` 和 `$policy` 设置为已完成审阅的外部 JSON 绝对路径：

```powershell
$profile = 'D:/dsh_home/profiles/web/cordis.patch.yml'
$expected = (Get-FileHash -LiteralPath $profile -Algorithm SHA256).Hash.ToLowerInvariant()
node scripts/configure-project-local-acceptance.mjs --profile $profile --bundle $bundle --merge-policy $policy --expected-sha256 $expected --check
```

核对输出 `beforeSha256`、`afterSha256`，按运行手册停止实例及备份后，保持同一个 `$expected` 执行：

```powershell
node scripts/configure-project-local-acceptance.mjs --profile $profile --bundle $bundle --merge-policy $policy --expected-sha256 $expected --apply
Get-FileHash -LiteralPath $profile -Algorithm SHA256
```

哈希发生变化时重新审阅，不能自动刷新期望哈希后强行重试。此命令只允许更新两个 localAcceptance、`workflow.platforms.uatMerge` 和 Host 的 `uatMergeWritesEnabled=true`；保留生产开关、其他目标、注释和 `!!js` 原文。省略 `--merge-policy` 只更新本地验收配置，不启用合并。安装精确包、启动与目录回读按本地部署手册另行执行，本节不表示已激活。

### 工程开发分支复用

v12 新任务可通过受信重执行来源关联原任务开发分支。目录准备前核对远端最新提交，推送核对冻结的远端 SHA；多分支歧义或归属不符须先处理，不能猜分支或强推。既有 v11 及更早冻结定义保持恢复原样。部署后须分别确认新目录产出、原任务分支复用及 PR 的 UAT 目标，安装成功不能替代真实任务验证。

### 两项专属业务场景配置

本轮任务使用 `docs/acceptance/topic-context-completeness/scripts/prepare-task-uat-configuration.mjs <原bundle绝对路径> <评审runtime绝对路径> <合并runtime绝对路径>` 生成不可变工具、共享环境配置、双项目 bundle 与合并策略，不直接激活 profile。后端固定本次 UAT3 `merge-normalization`，前端固定本次 UAT2 `review-opinion-draft`；各 runtime 的连接来源必须已经核实，不按 UAT 编号猜数据库或 SSO。

生成结果包含每个工具 SHA256。配置更新先以当前 profile SHA 执行 `configure-project-local-acceptance.mjs --profile <路径> --bundle <新bundle> --merge-policy <策略> --expected-sha256 <当前SHA256> --check`；停机备份后再用相同参数执行 `--apply`。场景已登记不等于业务通过，合并仍须本轮真实候选、目标和验收收据一致。详见 `local-acceptance-review.md` 和 `local-acceptance-merge.md`。

### UAT 原子合入与确定性失败恢复

UAT 合入保留原 PR 身份、实时 required checks 和已验收 tree 的回读，写端改用受信 Git 快进：先证明冻结 base 是 head 的祖先，再携带完整 `--force-with-lease=refs/heads/<UAT>:<expectedBase>` 推进到精确已验收 head。该选项仅用于原子比较 base；程序先强制验证祖先关系，禁止 non-FF。受信目标来自 Host 的 repository/branch 配置，模型不能提供任意仓库或 ref。GitHub 实际 PR merged 状态、合入 SHA、目标分支及 tree 的独立回读全部成立后才签发证明；push 成功本身不构成合入证明。

写入前读取经典分支保护及有效 rules。要求 PR、限制 direct push、要求签名或不受支持的规则时阻断，不借管理员权限绕过；无保护 UAT 分支仍执行身份、检查、tree、FF 与显式 base 租约。无法读规则或缺原子端口同样阻断。若仓库策略不允许此快进通道，应接入并验收 GitHub merge queue 的实际 merge-group 后再交付，本实现不降级到缺少 expectedBase 的 REST merge。鉴权仅由受信环境注入 Git，失败只输出安全错误码。原子写入回执未知只做效果对账，不重复推送。

自动恢复使用共享明确暂态白名单（连接重置、超时、临时 DNS、平台 429/502/503/504 等）。同 Run/generation/node/input/error 的恢复最多接纳三次，间隔至少 1 秒、2 秒；接纳身份和下一次时间写入控制账事件，进程重启不重置额度。未知效果、未排空执行、待接纳输入均不能领取恢复次数。其他错误默认保持等待；`apply-changes` 的 `ENGINEERING_PATCH_AMBIGUOUS`、`ENGINEERING_PATCH_CONFLICT`、`ENGINEERING_PATCH_BASE_CONFLICT` 进入既有 Owner 新代修复，保留原工作区快照和失败方案，不重复执行同一补丁。通用 `EDIT_BASE_CONFLICT` 不被自动改判为工程可修复。预算仍累计，恢复不自动扩容。

此变更更新 UAT adapter rulesDigest。已有持久化外部定义必须按正式版本登记规则处理，不能直接改旧记录以绕过身份校验。验证仅使用隔离控制账与本地 bare Git；真实 GitHub 权限、保护规则及 PR 自动标记 merged 仍须在授权合入时独立回读。

### R5/R8：冻结 Host 后台证明及专项测试

工具快照必须同时包含 `local-acceptance-project.mjs`、`LocalAcceptanceBackground.java`；后端专项检查另外包含 `verify-dataset-unit-tests.mjs`。Java 源是受信验证器资产，缺失即失败；不从业务仓补齐。编译器使用配置 JDK 的同目录 javac。探针输出存入外部工具配置目录的 logs/namespace，业务测试 XML 写候选 target/surefire-reports/TEST-<类名>-host-unit-<UUID>.xml；证明和验证器写 target/host-unit-<UUID>。只读取本次 UUID 报告，并校验 XML suite 同一后缀，旧报告不能复用。Surefire 2.22.2 的 reportsDirectory 没有命令行属性，不能使用无效的 -Dsurefire.reportsDirectory。

先生成、审阅后端检查提案，再通过既有受控配置接纳流程冻结新 checks 版本。提案生成本身不修改 profile，不代表已经激活。专项测试命令安排在原 package 步骤前；若任一报告缺失、用例数为零、跳过或失败，Host 检查失败。不得以 Maven 退出 0 替代报告检查。该轮未修改活动 profile、未部署、未重跑共享资源业务验收。

隔离后台探针验证已识别的 Spring 后台入口与开关行为；它不是任意 Java 代码的形式化无副作用证明。新增线程/自定义消费者实现仍需业务代码审阅和相应受信探针扩展。业务仓已有开关需通过正式开发流程修复，不能由 Host 改业务源文件。

### v15：已有实现的重新验收

工程方案明确选择 `changeDisposition=modify` 或 `no-change`。无需修改时必须给出实际读取的文件、理由及方案文档；Host 核对读取记录、受管工作区身份、无冲突和冻结合并树一致性，然后显示“现有实现符合要求，无需修改源码；继续构建与验收”。该路径不产生文件编辑效果，不接受同内容替换冒充修改。构建检查、本地业务验收、清理、提交与 UAT 门禁完整保留。v14 合同不变；v15 仅用于新接纳或正式重执行，不回写旧执行账。

UAT2 companion 的审批通知 outbox 也属于后台入口。候选 JAR 包含 `ApprovalNotificationOutboxTask` 时，隔离探针必须额外验证该 Bean 在 false 时不注册、true/default 时注册（共 8 个）；不含此类的 UAT3 候选仍验证原有 7 个。输出包含 outboxPresent，Host 按实际类别核对计数，不能仅将该类加入扫描白名单后放行。旧 ffe45 companion 会因 false 模式仍注册该 Bean 被拒绝；应构建 UAT2 独立本地模式修复包，核对新 JAR 摘要后再冻结配置。

### 同路径新增文本冲突

工作区三方合并支持 modify/modify 与双方独立新增同路径的 UTF8 add/add 冲突。add/add 必须通过祖先缺失、双方 rename-aware diff 均为 A、普通文件模式一致及 UTF8/blob 校验；保留原生冲突标记交正式模型方案解决。未解决标记不能交付。删除、重命名及二进制冲突仍停止并报告，不能借此改变可信任务起点或自动选择一侧。

### 正式 UAT 流程后的独立只读回读

使用 `docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs`，显式传入本次已交付提交及流水线编号：

```powershell
& D:/soft/node-v24.19.0/node.exe docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs --project dataset --commit <本次完整SHA> --pipeline <本次流水线编号>
& D:/soft/node-v24.19.0/node.exe docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs --project dataset-web --commit <本次完整SHA> --pipeline <本次流水线编号>
```

脚本只读，固定 dataset #371/UAT3、dataset-web #368/UAT2，从各实际 Poller Deployment 读取 Woodpecker repoId；复用 Host clients 校验已合入 PR 和目标 ref、精确成功流水线、BuildKit digest、Registry 清单、Deployment 代次和副本、所属 Pod 的真实 imageID、HTTP，并再次核对分支未漂移。不会触发流水线、推送或发送消息。

额外核对 `notify-dingtalk` 步骤 success/exit0 及日志中的成功回执。此回执证明流水线机器人接口返回 errcode=0，不代替群会话独立回读；通知配置的群名不能凭 secret 名称猜测。不得使用旧 SHA/旧 pipeline 来证明本次部署。

### 工程读取路径纠正

`engineering_repo_inspect` 在已验证的允许前缀与受信文件快照内遇到不存在路径时，返回正常结构化 `status=not_found`、`ENGINEERING_READ_NOT_FOUND` 和 `suggestedCall`。模型应先 list/search 找到真实路径再读取；结果没有文件 hash，不代表已经检查该文件。此情况不终止同一节点会话。越界、权限、符号链接、身份/代际或快照完整性错误仍触发原有停止门禁；不存在路径不消耗额外重试许可或改变执行预算。

### PR 发送阶段日志

PR 适配器在受信 repository 同级 .dsh-pr-journal 保存按 operationKey 命名的 attempt-start、send-intent、send-complete 或 preflight-failed 身份记录，排他创建并 fsync，不保存原始 stderr/凭据。最多三次仅限只读瞬态重试；mutation 不重试。看到已有尝试/发送意图仅允许对账，进程在意图前崩溃也保守阻塞。不要删除日志以重发。旧 unknown 对账不会补造阶段记录；未观测到远端标记仍是 unknown，须正式恢复流程处理。

重启恢复时 reconcile 会只读既有阶段日志：完整身份的 preflight-failed + attempt-start 且无 send-intent/send-complete 可返回既有 failed。发送意图优先；缺损/矛盾日志拒绝，旧日志目录缺失不创建目录，继续远端只读对账。

### UAT 批准请求与回执

`/state/authorizations` 包含原生 UAT build/rebuild 批准请求，支持受信可读 Web 来源，目标取冻结需求的 runbookId、仓库、服务与提交。审批权限仍取现有 approverIds、Web 身份和任务来源，不因列表可见而扩大。批准接口返回持久首终态；Owner 事件键用固定长度摘要，事件内容不包含易变的 applied 标记，重复提交不会重复通知 Owner。接口失败时仍应先回读审批账和节点状态，不因 HTTP 报错重发外部操作。

### 工程远端引用读取超时

`ls-remote` 的明确网络暂态先经过最多三次只读尝试；持续失败使用 `ENGINEERING_REMOTE_READ_TRANSIENT`，沿用节点三次持久化退避额度。认证/权限/证书失败为 `ENGINEERING_REMOTE_READ_FAILED`，缺失分支仍为 `ENGINEERING_UAT_BRANCH_NOT_FOUND`，不会误报网络成功或重发 Git 写操作。

旧版本已记为 `NODE_EXECUTION_FAILED` 的一次失败，不能批量改状态或加入通用重试白名单。须以节点原始错误和耗时证明确为 `ls-remote`，核对固定 run/node/input、已排空、效果全部终态、无新输入/停止/暂停，确认冻结候选仍有效后，通过限定范围原生恢复命令重领该节点。保留旧失败记录，不直接更新数据库。


### Owner 读取成功工程阶段的验收明细

Owner 快照复用同一成功工程 Run 的交付证明，将构建检查、验收要求、业务收据及清理结果的原始节点引用附在 `stageArtifacts.nodeArtifacts`。只有通过 task/run/candidate/commit/冻结定义一致性核验的引用可读；`completionEvidenceRefs` 保留正式阶段完成引用，不能用 PR 状态代替业务证据。展开仅影响 Owner 材料，不修改工作流冻结摘要或重做成功节点。

若旧 Owner 因材料不可达已阻塞，部署后应由原生 `task.owner.event` 提交新的证据可读事件唤醒，再由 Owner 重新读取并决定。事件不包含人为“已通过”结论，不改要求、不手工标完成；事故恢复先核对固定任务、Owner epoch/水位、三个成功阶段和原始验收证明，在维护封存及 Owner 排空后操作。使用对应验收轮次的窄范围工具与 manifest，禁止对未知写效果盲目恢复。


### 普通 UAT 构建终态失败

`uat-deployment/build` 的完整同分支、同提交流水线扫描若只有明确终态失败，会产生 `RELEASE_PIPELINE_FAILED` 收据（流水线编号、状态、提交、operationKey 和扫描证据）。Host 严格核对冻结效果身份后，以原生效果观察及节点失败收口，保留原操作和失败证据，不重发构建。仍有等价流水线进行中、读取异常、列表不完整或身份不确定时保持 unknown。普通构建的失败不能套用到 `uat-rebuild` 的旧失败列表；其接续须使用同提交重建的明确授权、预检及运行版本证据。

### 本次 UAT2 流水线总时限修复

2026-09-27 的 dataset-web 流水线 #319 因仓库级 10 分钟总时限终止：源码拉取与构建已成功，部署部分生效，通知未完成。不能以 Pod Ready 替代完整流水线成功。已将 Woodpecker repo2（HiQ-AI/dataset-web）的 timeout 调整为30分钟，独立回读确认；该设置影响此仓库之后的流水线，其余仓库及配置字段未修改。

固定事故工具 `docs/acceptance/topic-context-completeness/scripts/configure-frontend-pipeline-timeout.mjs` 提供 `--check` 和 `--apply`，绑定 #319 / d1e447787201212140a2732b798d336965ddfaa7 / UAT2，不能用于其他任务。执行前检查无活动流水线及身份；唯一变更意图保留，不删除重发。结果不确定时仅回读 repo timeout。证据位于 round-36/frontend-timeout-*.json。

### 固定事故：前端 UAT #319 超时收口

本次固定工具为 `docs/acceptance/topic-context-completeness/scripts/reconcile-frontend-uat-timeout-native.mjs`，使用 round-36 的 manifest；PowerShell 复用 `recover-pr371-merge-maintenance.ps1 -RecoveryScope frontend-uat-timeout`。仅处理原 PID27236、原部署 Run 的唯一 unknown build 效果，以只读原生适配器核对 repo2/#319 killed 后记录 failed。流程仍为 check → offline → reconcile → install → start → readback → resume-dispatch，备份/容量/锁/profile/package/原进程见证门禁不变。私有证据目录为 `docs/tmp/frontend-uat-timeout-incident`。

该工具不运行重建、不把当前 Ready Pod 当作流水线成功，不更改历史节点产出。原生失败收据写入后仅将原节点排队；新产品启动后正常将旧部署 Run 收口失败。正式同提交重建由任务编排另行接续。若同提交出现新流水线、PR/UAT分支漂移或任何身份不一致，固定工具停止，不扩大事故范围。

### 原任务中接续失败部署

原始 Web 请求须明确包含工程、UAT 合并、UAT 部署三阶段；前两阶段成功且第三阶段有可信终态失败时，正常 Owner 恢复循环仅修订第三阶段为一次 `task-uat-rebuild`，保留旧计划和失败 Run。项目、提交及环境来源于失败部署的冻结输入；对应重建白名单还须精确匹配原目标的分支、Woodpecker、Kubernetes、镜像仓库与入口地址，不使用模型推断。

重建继续原阶段确认门禁和平台审批，以及失败流水线、分支头、无更新运行版本和来源制品预检。没有唯一对应重建目标或证据不完整时保持阻断。修订后、绑定输入前重启可从原计划身份恢复；不会重跑成功前缀。重建失败不自动再次修订；成功后 Owner 仍需核验保留的工程本地验收工件、合并产物及重建运行回读才能结案。


### 超时流水线已部分部署的同提交重建

流水线整体 failure/error/killed 不代表构建步骤失败。重建预检可接受本次失败流水线的同提交制品已运行：Host 必须独立确认唯一 `buildkit-build-and-push` 步骤 success/exit0、该步骤日志中唯一且一致的export/push digest、Registry manifest，以及目标Deployment全部Ready副本的实际imageID。若该构建未成功，仍可用失败前成功流水线的旧制品证明；混合新旧副本、无来源digest、更新流水线和不完整Pod清单继续阻断。`readBuildEvidence` 默认仍要求整体成功；仅重建证明显式传入精确 `expectedPipelineStatus` 才允许检查失败流水线中的成功构建。

### 数据变更插件审批的持续接续

当前数据变更 v6 在 Bytebase 创建工单后进入插件审批，待审批不是执行受阻。插件对准确目标、SQL、工单和当前运行绑定批准；收到插件真人批准后恢复原 Run 执行，驳回后修订送审。Bytebase 平台的 APPROVED、SKIPPED 均不能替代插件批准。历史 v4/v5 冻结运行继续保留原定义，不能直接改成新审批或重发建单。完成调查但 Owner 未完成的 Task 可经本机 context 修订下一步；成功调查成果保留，取消或已业务完成任务不能用此入口续办。

群通知使用一句简短进展或具体受阻原因，完整 condition 保留在任务详情，不自动拼接责任人和继续条件。审批页展示工单、准确生产目标、SQL 原文及摘要，批准仍由已配置的插件审批人作出。

审批意见沿现有 approval.decided 审计事件与首终态决定同事务保存，重启后从原生批量投影读取；重复或晚到决定不能覆盖首个意见。数据变更驳回仅关闭尚未发送的插件审批门禁，原有未知写入仍先对账。

审批私聊发送结果未知时，运行看板显示“投递待确认”，仍列入待处理并保留 Web 批准、拒绝入口；投递确认不代替审批决定。

### 旧原生审批观察阻止精确包切换

若正式维护预检仅有旧v5原生approval-gate未知观察，仍不能忽略effects或强行停止Resident。使用scripts/recover-data-change-approval.ps1和scripts/reconcile-data-change-approval.mjs参数化交接；manifest位于私人docs/tmp，绑定当前包/profile/实例/Task/Run/effect/节点及版本，不复制凭据。--check为零写，返回绑定摘要；取得摘要后冻结manifest并用ExpectedManifestSha256约束每阶段。

PowerShell Phase依次check、offline、reconcile、install、start、readback、resume-dispatch。offline先维护禁派发，见证完整dispose，取得owner锁，停止精确PID并完整备份包括任务工件；对账阶段释放外部锁后由原生Store自身独占，独立验证备份和无监听，只关闭唯一纯审批读取，不stop业务Run、修改Owner或批准DDL。效果failed且busy清零后原生seal，才安装精确包并恢复原profile。恢复自启和派发前独立回读新进程、包文件、完整profile、历史及HTTP。

对账--readback用于中断续查，不重复未知操作。其它未知写效果、已执行TaskRun、SQL/目标/包/节点漂移、备份缺失或维护不符全部拒绝。正常新运行仍走普通部署runbook，不能把本领域范围扩成全局unknown豁免。安装后正式context纠正当前需求，再handoff同Task已有工单进入插件审批；旧闭合failed观察被幂等接受。


插件私聊审批使用 `workflow-approval:<冻结通知摘要>` 作为82字符幂等键，发送前校验钉钉128字符上限。网络异常或缺回执保持 unknown；只有同一请求/摘要绑定的精确平台 UUID 长度拒绝、1001错误码及真实trace可登记明确未发送。现有 `POST /authorizations/:requestId/reissue` 对原生通知恢复要求本机同源、配置Web身份、维护已排空及 `noticeDigest/proof`；原请求和SQL保持，负回执不给生产执行许可。恢复后下一次发送使用新命令身份，重复恢复或重启不重新授予旧发送许可。

钉钉消息回读会将文本软换行显示为空格，审批确认只归一段落回读产生的 Markdown 硬换行和 CRLF/LF 软换行显示差异；其他空格、SQL及标点必须保持。已有 openTaskId 只查发送状态并读取原消息，显示差异不得触发重新发送。

审批私聊使用 Markdown 标题、空行和明确字段，私聊正文不包含执行SQL，完整SQL保留在工单及审批详情；避免堆放重复目标、resourceKey和长摘要。短审批编号用于消息定位，未知发送仍须完整正文及权威收件人匹配，不能仅凭编号认领。已送达消息可原位编辑展示，审批仍绑定原请求、冻结执行内容和同一引用消息ID，不新建审批或补发。
