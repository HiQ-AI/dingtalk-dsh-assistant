# 受信平台工作流接入

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产另需固定 tag 及已核实的 Tag→Woodpecker 触发链。UAT 集成与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- bytebase.targets 每项含唯一 id、Bytebase 项目、精确生产目标及对应的精确 UAT 数据库。受信端口分别回读两库的结构版本与摘要，并核对脚本相关前置条件；UAT 与生产的整库数据不要求相同，也不把 UAT 演练当作生产结果。SQL 正文来自当前消息已授权的精确资源，生产基线快照由 Host 受信回读并冻结，无需消息提供证明文档。缺少 UAT 目标或同结构基线的受信证据时不可启用。生产数据变更必须经过 Bytebase，不能改用数据库直连凭据。
- 四类外部效果都经 execution-delivery.js 的 external 效果账。每个效果请求冻结运行、代次、目标和内容身份；发送回执不能充当独立回读。未知结果仅恢复对账，不自动重发。生产发布在合并身份回读后进入真人审批节点，批准精确 Tag 才继续；生产数据变更在 Bytebase 工单创建并回读后，等待该平台真人审批，再执行生产任务。UAT 演练和建工单不触发重复的真人审批。
- D:/baibu-agent/.secrets 中的凭据只由本机受信客户端读取；Host 配置和模型输入不包含凭据值，凭据也不能写入仓库、工件或日志。不得把宽泛的 Bytebase MCP call_api 当成受信执行端口。

## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。真实平台客户端、目标清单及审批/演练证明仍必须逐项配置和验证。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起；不可用项应给出缺少配置的事实。平台连接只读探测与真实写操作分别验收；不可为跑验收而触发 UAT 构建、生产发布或生产 SQL。当前 Woodpecker Tag 流水线可读到提交 SHA，但 dataset 成功构建的步骤日志未给机器可核验的镜像 digest，构建→Registry 的来源链尚未闭合；Registry 受信读取令牌及精确 UAT 数据库目标也未配置。缺这些能力时客户端不暴露相应受信端口，目录继续显示“尚不能发起”。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。生产必须由目标分支/合并 SHA→真人审批→Tag→Woodpecker 同 SHA 构建及产物 digest→Registry 顶层清单及平台子清单 digest→Ready Pod imageID/Deployment 就绪→业务入口组成完整来源链，不允许本地 Docker 发布。Deployment 不要求不存在的源码 SHA 注解。Bytebase 脚本通过持久效果账在精确 UAT 数据库演练并按 operationKey 独立回读；演练只证明该 UAT 状态下的结果，不证明生产行数据相同。
