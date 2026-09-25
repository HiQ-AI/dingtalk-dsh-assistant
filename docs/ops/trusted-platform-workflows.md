# 受信平台工作流接入

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

“本地 E2E、PR 和来源包的受信验收证明读取”是程序对现有执行记录的平台回读，不要求另造证明文件。业务 E2E 仅在独立业务验收中从检查工件判定；UAT 部署不要求业务 E2E，普通构建通过也不能冒充业务验收。PR 从 GitHub 回读开发提交、目标分支合并身份及 Git tree；来源包从 Woodpecker 同提交构建日志、Registry 清单摘要、目标 Pod imageID 及业务入口核对。任何一环未证实就保留对应阻断，不能用任务口头摘要代替。

UAT 部署可独立发起，显式给出白名单目标和目标分支当前提交；预检回读目标分支及唯一已合入且 merge SHA 等于当前分支 SHA 的 PR。作为工程流程后继阶段时，额外核对同一工程 Run 的不可变工件、GitHub PR 的 head、merge 与 Git tree，开发提交和目标分支合并提交的 tree 必须与工程候选一致，但不要求业务 E2E。部署完成仅确认 UAT 运行版本，回归、提测与验收另行执行。UAT 同提交重建则回读完整 Woodpecker 流水线列表：精确目标 SHA 构建失败、没有更新的成功或在途构建、前一个成功构建的摘要与 Registry 清单和当前 Deployment 所属 Ready Pod imageID 一致，才允许重建。两类检查由 Host 固定客户端实现，不需要单独的 `attestations` 服务。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产目标还需已核实的 Tag→Woodpecker 触发链。生产 Tag 是**每次任务**明确给出的 `action.arguments.releaseTag`（格式 `vYYYYMMDD-N`），与 commitSha 一起冻结在 Run 的 target、审批范围和效果身份中；不得写死在 `release.targets`，不得由模型猜序号。同一生产目标可按不同 Tag 多次发布，每次均重新检查 Tag 冲突、流水线与真人审批。UAT 部署预检与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- 当前生产目标白名单只允许 `HiQ-AI/dataset` 的 `dataset` 与 `HiQ-AI/dataset-web` 的 `dataset-web`，均以已核实的 `main` 分支和 `hiqlcd-app-prod` Deployment 为准；其他服务不加入 `release.targets`。准入仍取决于生产触发链、可信客户端和审批入口全部通过，不因出现在白名单中就自动可发起。
- bytebase.targets 每项含唯一 id、Bytebase 项目、精确生产目标及对应的精确 UAT 数据库。UAT 的 SQL 审查与事务演练由本地 PostgreSQL 受信连接完成，不调用 Bytebase；生产结构基线和同表结构证明由本地连接天翼云只读副本取得，Bytebase 负责生产工单、执行和回读。双方对脚本涉及表运行同一固定 pg_catalog 结构查询，规范化指纹必须一致；整库快照用于各自冻结，不要求无关表全库一致。UAT 与生产的行数据不要求相同，也不把 UAT 演练当作生产结果。SQL 正文来自当前消息已授权的精确资源，生产基线由 Host 受信回读并冻结，无需消息提供证明文档。缺少 UAT 目标或同表结构证明时阻断。生产写入必须经过 Bytebase，不能改用数据库直连凭据。
- 四类外部效果都经 execution-delivery.js 的 external 效果账。每个效果请求冻结运行、代次、目标和内容身份；发送回执不能充当独立回读。未知结果仅恢复对账，不自动重发。生产发布在合并身份回读后进入真人审批节点；Tag 授权再次查询同 Run、代次与目标的审批效果及审批账，必须已由 Web 真人批准且未撤销，并逐项核对 Tag、提交、范围与回执摘要，才可创建精确 Tag。生产数据变更先在 Bytebase 创建并回读 Sheet、Plan、Issue，**此时不创建 Rollout/Task**；Assistant 任务页真人审批绑定 Run、代次、Issue、Plan、Sheet、目标库、SQL SHA256 与变更包摘要。批准且未撤销后才创建 Rollout/Task 并执行，因为 Bytebase 自动发布策略可能在创建 Rollout 时立即运行 Task。Bytebase 工单的 `approvalStatus=SKIPPED` 不构成人工批准。UAT 演练和建工单不触发重复的真人审批。
- D:/baibu-agent/.secrets 中的凭据只由本机受信客户端读取；Host 配置和模型输入不包含凭据值，凭据也不能写入仓库、工件或日志。不得把宽泛的 Bytebase MCP call_api 当成受信执行端口。

## 本地客户端装配

在 `web` profile 的 `insert` 列表中，先于 `@zzusp/dingtalk-dsh-assistant/resident` 插入：

```yaml
- id: dingtalk-task-workflow-platform-clients
  name: '@zzusp/dingtalk-dsh-assistant/platform-host'
  config:
    secretsDirectory: 'D:/baibu-agent/.secrets'
```

Host 在启动时只读取当前 Poller Secret、GitHub CLI 登录及 Docker buildx 可用性，失败则拒绝装配；不会把凭据写入 profile。目标白名单仍由 `workflow.platforms` 单独配置，缺证明和目标时目录保持不可发起。部署前先核实当前 Poller Secret 名称与 UAT K3s Server；若变更，更新客户端配置和定向验证后再安装，不修改凭据文件来适配旧代码。

数据变更接入时，同一 Host 配置另需 `uatPostgres.receiptDbPath`（本机持久 SQLite 文件的绝对路径）、`uatPostgres.targets` 和 `productionPostgres.targets` 三项 `{project, target}`；Resident 的 `workflow.platforms.bytebase` 另登记三个 `{id, project, target, uatTarget}`。生产 `target` 是 Bytebase 资源名，只读连接精确映射 `.secrets/db-credentials.json` 中的 `tianyi_editor_slave`、`tianyi_bg_slave`、`tianyi_admin_slave`，须确认 `pg_is_in_recovery()=true` 和会话只读。`uatTarget`/Host `target` 是 `{instance: postgresql/192.168.8.8:30770, database: 同名库, environment: uat}`。三处清单必须逐项一致，Host 不从配置读取用户名或密码。安装前用只读客户端核对三库 `current_database()`、会话只读、实时 catalog 完整行数和生产副本身份；不得用过期 Bytebase `/schema` 缓存快照替代。UAT 回执文件所在目录应与工作流控制账一同备份，未知预留不能自动清除后重演。
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

Bytebase `projects/flbn` 下的三个已确认生产数据库分别是 `instances/flbnpguaf/databases/hiq_editor`、`instances/flbnpguaf/databases/hiq_background_db`、`instances/flbnpguaf/databases/hiq_admin`，环境均为 `environments/prod`。同名 UAT PostgreSQL 数据库通过 `192.168.8.8:30770` 本地连接；Host 从 `.secrets/db-credentials.json` 精确读取 `hiq_editor_uat` 连接，仅复用其主机、端口与凭据并显式指定三库各自数据库名。UAT receipt SQLite 放在 Host 持久目录。当前 SQL 审查仅支持单表整数列 UPDATE 与同表 SELECT 回查；有触发器、规则、RLS、外键或 CHECK 等复杂对象时拒绝演练，不将其泛化为任意 SQL 支持。

以上仓库 ID、Cron 分支和命名空间来自当前 Poller/Kubernetes 只读回读，业务回归见 `../acceptance/topic-intent-task-composition/round-8.md`。运行时仍须检查分支头、目标 SHA、同 SHA 构建与独立制品/Pod 证据。
## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。`@zzusp/dingtalk-dsh-assistant/platform-host` 可在 Resident 前由 Cordis 加载，从本地 UAT/生产 kubeconfig 与当前 Poller 的 `db-dev/woodpecker-poller-credentials` Secret 取凭据；GitHub 令牌由本机 `gh auth token` 获取。Bytebase 由本机 `.secrets/bytebase.json` 登录；生产基线由本机天翼云只读副本的固定 pg_catalog 查询实时取得并校验结果行数，UAT 由本地 PostgreSQL 连接取得独立基线。Bytebase 缓存 `successfulSyncTime` 陈旧不代替实时基线。Registry 只读回读用本机 Docker 凭据运行 `docker buildx imagetools inspect --raw`，并对原始清单字节重算期望 digest。插件只提供客户端，不能单靠安装使目录可发起。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起。平台连接只读探测与真实写操作分别验收；没有具体业务变更授权时，不为验收创建真实 Bytebase 工单或执行 SQL。2026-09-25 只读复核已从 Woodpecker Base64 日志解析出 dataset 与 dataset-web 的历史 UAT2 构建摘要，并与 Registry/Pod 回读一致；先前未解码原始 JSON 而判定“日志无摘要”的结论作废。现有工程检查只有构建/打包，未配置业务 E2E 检查 ID；这不阻止独立 UAT 部署，但不能据此声称业务验收完成。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。构建证明读取精确成功流水线的 `buildkit-build-and-push` 步骤，通过 Woodpecker `/api/repos/<repoId>/logs/<pipeline>/<stepId>` 返回的 JSON `data` 做 Base64 解码，只接受唯一完成的 `exporting manifest` 与同摘要的 `pushing manifest for <image>@<digest> ... done`；HTTP 200 的 HTML SPA、配置摘要、layer digest 和未完成进度行都不构成证明。生产必须由目标分支/合并 SHA→真人审批→Tag→Woodpecker 同 SHA 构建及产物 digest→Registry 顶层清单及平台子清单 digest→Ready Pod imageID/Deployment 就绪→业务入口组成完整来源链，不允许本地 Docker 发布。Deployment 不要求不存在的源码 SHA 注解。Bytebase 脚本通过持久效果账在精确 UAT 数据库演练并按 operationKey 独立回读；演练只证明该 UAT 状态下的结果，不证明生产行数据相同。
