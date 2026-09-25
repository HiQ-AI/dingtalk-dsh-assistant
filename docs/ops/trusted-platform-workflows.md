# 受信平台工作流接入

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

“本地 E2E、PR 和来源包的受信验收证明读取”是程序对现有执行记录的平台回读，不要求另造证明文件。本地业务 E2E 只从同一工程 Run 的验收检查工件及显式配置的检查 ID 判定；普通构建通过不能冒充 E2E。PR 从 GitHub 回读开发提交、目标分支合并身份及 Git tree；来源包从 Woodpecker 同提交构建日志、Registry 清单摘要、目标 Pod imageID 及业务入口核对。任何一环未证实就保留对应阻断，不能用任务口头摘要代替。

UAT 交付目标配置 `businessE2eCheckIds` 为本地工程流程实际执行的业务验收检查 ID；受信读取直接使用同一工程 Run 的不可变工件，再回读 GitHub PR 的 head、merge 与 Git tree，开发提交和目标分支合并提交的 tree 必须与工程候选一致。UAT 同提交重建则回读完整 Woodpecker 流水线列表：精确目标 SHA 构建失败、没有更新的成功或在途构建、前一个成功构建的摘要与 Registry 清单和当前 Deployment 所属 Ready Pod imageID 一致，才允许重建。两类检查由 Host 固定客户端实现，不需要单独的 `attestations` 服务。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产目标还需已核实的 Tag→Woodpecker 触发链。生产 Tag 是**每次任务**明确给出的 `action.arguments.releaseTag`（格式 `vYYYYMMDD-N`），与 commitSha 一起冻结在 Run 的 target、审批范围和效果身份中；不得写死在 `release.targets`，不得由模型猜序号。同一生产目标可按不同 Tag 多次发布，每次均重新检查 Tag 冲突、流水线与真人审批。UAT 集成与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- 当前生产目标白名单只允许 `HiQ-AI/dataset` 的 `dataset` 与 `HiQ-AI/dataset-web` 的 `dataset-web`，均以已核实的 `main` 分支和 `hiqlcd-app-prod` Deployment 为准；其他服务不加入 `release.targets`。准入仍取决于生产触发链、可信客户端和审批入口全部通过，不因出现在白名单中就自动可发起。
- bytebase.targets 每项含唯一 id、Bytebase 项目、精确生产目标及对应的精确 UAT 数据库。受信端口分别回读两库的结构版本与摘要，并核对脚本相关前置条件；UAT 与生产的整库数据不要求相同，也不把 UAT 演练当作生产结果。SQL 正文来自当前消息已授权的精确资源，生产基线快照由 Host 受信回读并冻结，无需消息提供证明文档。缺少 UAT 目标或同结构基线的受信证据时不可启用。生产数据变更必须经过 Bytebase，不能改用数据库直连凭据。
- 四类外部效果都经 execution-delivery.js 的 external 效果账。每个效果请求冻结运行、代次、目标和内容身份；发送回执不能充当独立回读。未知结果仅恢复对账，不自动重发。生产发布在合并身份回读后进入真人审批节点；Tag 授权再次查询同 Run、代次与目标的审批效果及审批账，必须已由 Web 真人批准且未撤销，并逐项核对 Tag、提交、范围与回执摘要，才可创建精确 Tag。生产数据变更在 Bytebase 工单创建并回读后，等待 **Assistant 任务页的真人审批**；审批范围冻结 Run、代次、工单、任务、目标库、Sheet SQL SHA256 和变更包摘要，执行前重新回读批准且未撤销。Bytebase 工单的 `approvalStatus=SKIPPED` 不构成人工批准。UAT 演练和建工单不触发重复的真人审批。
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
当前已核实的 UAT 样例目标如下；它们是目标候选，**尚未写入 `workflow.platforms.release.targets`**，因为 UAT attestation 仍缺受信来源：

| 服务 | 仓库/分支 | Woodpecker 仓库/Cron | Kubernetes Deployment | Registry 镜像 | 业务入口 |
| --- | --- | --- | --- | --- | --- |
| dataset-web UAT2 | `HiQ-AI/dataset-web` / `feature/uat2-base` | `2` / `dataset-web-uat2-poll` | `hiqlcd-app-uat2/dataset-web` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web` | `https://editor2.hiqdat.dev/` |
| dataset UAT3 | `HiQ-AI/dataset` / `feature/uat3-base` | `1` / `dataset-uat3-poll` | `hiqlcd-app-uat3/dataset` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset` | `https://editor3.hiqdat.dev/api/dataset/ready` |

生产发布仅登记下列目标候选，Tag 不写在目标配置里，每次任务单独指定。现有只读证据表明两项 Deployment 均为 Ready 2/2，历史 `v20260918-1` Tag 构建的 Woodpecker manifest 摘要与 Registry、Ready Pod imageID 一致；新版本仍须每次重新核对。

| 服务 | 仓库/分支 | Woodpecker 仓库 | Kubernetes Deployment | Registry 镜像 | 业务入口 |
| --- | --- | --- | --- | --- | --- |
| dataset | `HiQ-AI/dataset` / `main` | `1` | `hiqlcd-app-prod/dataset` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset` | `https://editor.hiqlcd.com/api/dataset/ready` |
| dataset-web | `HiQ-AI/dataset-web` / `main` | `2` | `hiqlcd-app-prod/dataset-web` | `registry.cn-sh1.ctyun.cn/hiq-ai/dataset-web` | `https://editor.hiqlcd.com/` |

Bytebase `projects/flbn` 下的三个已确认生产数据库分别是 `instances/flbnpguaf/databases/hiq_editor`、`instances/flbnpguaf/databases/hiq_background_db`、`instances/flbnpguaf/databases/hiq_admin`，环境均为 `environments/prod`。同名 UAT PostgreSQL 数据库的只读连通已核实；此事实不等于已取得可比结构基线、SQL 安全审查和持久演练回执，因此尚不可登记为可执行数据变更目标。

以上仓库 ID、Cron 分支和命名空间来自当前 Poller/Kubernetes 只读回读，业务回归见 `../acceptance/topic-intent-task-composition/round-8.md`。运行时仍须检查分支头、目标 SHA、同 SHA 构建与独立制品/Pod 证据。
## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。`@zzusp/dingtalk-dsh-assistant/platform-host` 可在 Resident 前由 Cordis 加载，从本地 UAT/生产 kubeconfig 与当前 Poller 的 `db-dev/woodpecker-poller-credentials` Secret 取凭据；GitHub 令牌由本机 `gh auth token` 获取。Bytebase 只读端口由本机 `.secrets/bytebase.json` 登录，只提供精确数据库身份与 `/schema` 基线；最近成功同步时间超过 24 小时或位于未来即拒绝基线。Registry 只读回读用本机 Docker 凭据运行 `docker buildx imagetools inspect --raw`，并对原始清单字节重算期望 digest。插件只提供客户端，不能单靠安装使目录可发起。Bytebase 的 SQL 审查、工单幂等创建/对账、生产执行回读，以及 PostgreSQL UAT 受信演练端口尚未真实接入，数据变更必须继续不可发起。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起；不可用项应给出缺少配置的事实。平台连接只读探测与真实写操作分别验收；真实 UAT 构建、生产发布或生产 SQL 须有明确任务授权。2026-09-25 只读复核已从 Woodpecker Base64 日志解析出 dataset 与 dataset-web 的历史 UAT2 构建摘要，并与 Registry/Pod 回读一致；先前未解码原始 JSON 而判定“日志无摘要”的结论作废。现有工程检查只有构建/打包，未配置业务 E2E 检查 ID，故 UAT 交付不得把它们当成完整验收证明。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。构建证明读取精确成功流水线的 `buildkit-build-and-push` 步骤，通过 Woodpecker `/api/repos/<repoId>/logs/<pipeline>/<stepId>` 返回的 JSON `data` 做 Base64 解码，只接受唯一完成的 `exporting manifest` 与同摘要的 `pushing manifest for <image>@<digest> ... done`；HTTP 200 的 HTML SPA、配置摘要、layer digest 和未完成进度行都不构成证明。生产必须由目标分支/合并 SHA→真人审批→Tag→Woodpecker 同 SHA 构建及产物 digest→Registry 顶层清单及平台子清单 digest→Ready Pod imageID/Deployment 就绪→业务入口组成完整来源链，不允许本地 Docker 发布。Deployment 不要求不存在的源码 SHA 注解。Bytebase 脚本通过持久效果账在精确 UAT 数据库演练并按 operationKey 独立回读；演练只证明该 UAT 状态下的结果，不证明生产行数据相同。
