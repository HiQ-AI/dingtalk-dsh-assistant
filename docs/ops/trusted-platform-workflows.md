# 受信平台工作流接入

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产另需固定 tag 及已核实的 Tag→Woodpecker 触发链。UAT 集成与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- bytebase.targets 每项含唯一 id、Bytebase 项目、精确生产目标及对应的精确 UAT 数据库。受信端口分别回读两库的结构版本与摘要，并核对脚本相关前置条件；UAT 与生产的整库数据不要求相同，也不把 UAT 演练当作生产结果。SQL 正文来自当前消息已授权的精确资源，生产基线快照由 Host 受信回读并冻结，无需消息提供证明文档。缺少 UAT 目标或同结构基线的受信证据时不可启用。生产数据变更必须经过 Bytebase，不能改用数据库直连凭据。
- 四类外部效果都经 execution-delivery.js 的 external 效果账。每个效果请求冻结运行、代次、目标和内容身份；发送回执不能充当独立回读。未知结果仅恢复对账，不自动重发。生产发布在合并身份回读后进入真人审批节点，批准精确 Tag 才继续；生产数据变更在 Bytebase 工单创建并回读后，等待该平台真人审批，再执行生产任务。UAT 演练和建工单不触发重复的真人审批。
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
## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。`@zzusp/dingtalk-dsh-assistant/platform-host` 可在 Resident 前由 Cordis 加载，从本地 UAT kubeconfig 与当前 Poller 的 `db-dev/woodpecker-poller-credentials` Secret 取凭据；GitHub 令牌由本机 `gh auth token` 获取。Registry 只读回读用本机 Docker 凭据运行 `docker buildx imagetools inspect --raw`，并对原始清单字节重算期望 digest。插件只提供客户端，不能单靠安装使目录可发起。真实目标清单、UAT 验收证明、生产触发链及 Bytebase 工单/演练端口仍须逐项配置和验证。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起；不可用项应给出缺少配置的事实。平台连接只读探测与真实写操作分别验收；真实 UAT 构建、生产发布或生产 SQL 须有明确任务授权。2026-09-25 只读复核已从 Woodpecker Base64 日志解析出 dataset 与 dataset-web 的历史 UAT2 构建摘要，并与 Registry/Pod 回读一致；先前未解码原始 JSON 而判定“日志无摘要”的结论作废。UAT 目标清单、证明端口及精确 UAT 数据库目标尚未在本地 Host 配置；缺这些能力时目录继续显示“尚不能发起”。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。构建证明读取精确成功流水线的 `buildkit-build-and-push` 步骤，通过 Woodpecker `/api/repos/<repoId>/logs/<pipeline>/<stepId>` 返回的 JSON `data` 做 Base64 解码，只接受唯一完成的 `exporting manifest` 与同摘要的 `pushing manifest for <image>@<digest> ... done`；HTTP 200 的 HTML SPA、配置摘要、layer digest 和未完成进度行都不构成证明。生产必须由目标分支/合并 SHA→真人审批→Tag→Woodpecker 同 SHA 构建及产物 digest→Registry 顶层清单及平台子清单 digest→Ready Pod imageID/Deployment 就绪→业务入口组成完整来源链，不允许本地 Docker 发布。Deployment 不要求不存在的源码 SHA 注解。Bytebase 脚本通过持久效果账在精确 UAT 数据库演练并按 operationKey 独立回读；演练只证明该 UAT 状态下的结果，不证明生产行数据相同。
