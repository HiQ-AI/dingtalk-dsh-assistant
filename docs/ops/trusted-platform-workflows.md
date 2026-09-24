# 受信平台工作流接入

四类外部工作流由固定流程定义、受信平台适配器、目标白名单和持久效果账组成。Host 的 workflow.platforms 配置不接受模型生成的目标、URL 或凭据；认证客户端须通过 dingtalkTaskWorkflowPlatformClients 服务注入。没有完整客户端、目标、审批入口或独立回读时，目录保持“尚不能发起”。仅看到平台 token 或连接健康不等于准入。

## 配置边界

- release.targets 每项含唯一 id、kind、仓库、环境、服务、runbook、目标分支、Woodpecker 仓库与 Cron、Kubernetes Deployment、Registry 镜像与 HTTPS 入口。目标 SHA 由请求显式给出，Host 再查目标分支头；生产另需固定 tag 及已核实的 Tag→Woodpecker 触发链。UAT 集成与生产合并阶段只确认已经合入且 merge SHA 等于目标分支头的唯一 PR，当前固定需求合同不能自动合并未合入 PR。
- bytebase.targets 每项含唯一 id、Bytebase 项目、生产目标和另一个精确的隔离演练目标及其基线证明引用。SQL 正文与基线快照必须来自当前消息已授权的精确资源；缺少隔离副本证明不可启用。生产数据变更必须经过 Bytebase，不能改用数据库直连凭据。
- 四类外部效果都经 execution-delivery.js 的 external 效果账。每个效果请求冻结运行、代次、目标和内容身份，按配置的任务所有者逐次审批；发送回执不能充当独立回读。未知结果仅恢复对账，不自动重发。
- D:/baibu-agent/.secrets 中的凭据只由本机受信客户端读取；Host 配置和模型输入不包含凭据值，凭据也不能写入仓库、工件或日志。不得把宽泛的 Bytebase MCP call_api 当成受信执行端口。

## 当前本地接入状态与验证

源码的四类平台编排层和 Host 装配入口已实现。真实平台客户端、目标清单及审批/演练证明仍必须逐项配置和验证。发布前按[现有本地部署 runbook](resident-review-local-deployment.md)打包并安装精确版本，先检查运行任务与持久效果，再回读 /state/workflows/catalog 中每一类是否可发起；不可用项应给出缺少配置的事实。平台连接只读探测与真实写操作分别验收；不可为跑验收而触发 UAT 构建、生产发布或生产 SQL。

当前 UAT Woodpecker 仓库 ID 应从 Poller Deployment 环境读取，不能硬编码旧值。同 SHA 重建要扫描完整分页并排除成功/在途流水线；UAT 浮动镜像 tag 不能证明新提交已运行，必须回读 Registry digest、Pod imageID、Rollout 代次与业务入口。生产必须由 Tag→Woodpecker→Registry→Deployment 链路完成，不允许本地 Docker 发布。Bytebase 的 isolated rehearsal 需要可独立回读的隔离副本和基线一致性证明。
