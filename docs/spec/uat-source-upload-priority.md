# UAT 主动源码包部署

## 目标与现状

页面的“UAT 部署”为 `task-uat-deployment`，当前 `workflow-platform-clients.js` 的 `triggerBuild` 主动 POST Cron，没有上传源码包。旧 `taskPrompts` 中的上传要求不控制该代码路径。

目标：已接入源码包的 dataset / dataset-web UAT 分支优先上传精确源码并触发 manual 构建，复用成功或在途的同提交构建，不等待 Poller；仍独立核对构建摘要和运行版本。

## 方案与范围

- 在现有平台客户端触发节点接入固定源码上传端点。复用现有通用上传协议、Git 隔离临时仓和凭据环境传递方式，不执行业务仓脚本。
- 新增专用源码包模块，隔离 Git 取源码、YAML 能力核验、归档和 HTTP 上传，使已有平台客户端不继续膨胀。精确分支 fetch 后核验 SHA；只归档已提交对象，不包含本地工作区文件。
- Host 从已配置 secretsDirectory 的 `woodpecker-source-upload-token.txt` 读取上传 Token；缺失时上传路径拒绝执行，不从其他凭据猜测，也不静默退回 Cron。其他仓库继续既有 Cron 路径，生产 Tag 不变。
- 解析目标提交的流水线，验证 manual 入口、prepare-uploaded-source 与 SOURCE_PACKAGE_ID 的互斥 clone 条件。上传前再次核验分支及完整等价流水线列表。
- 只发送一次 PUT；回执必须绑定项目、pipeline、环境、SHA、包 SHA256 与流水线号。上传后独立读取流水线身份；效果账继续负责结果未知时只读对账。构建证明对带源码包的流水线额外核验实际 prepare 成功和 clone 跳过。

## 反证与验证

历史验收出现过 PUT 201 / manual 成功受理而 clone 仍执行，故接收回执不等于源码消费。定向测试覆盖上传成功、分支漂移、无支持入口、缺凭据、摘要/身份不匹配、超时/409、成功/在途去重、只读恢复、源码准备和克隆冲突；继续运行 release、UAT 来源证明和 Host 测试。

另做真实 Git 临时仓归档验证与当前目标的只读源码入口核验。此次修改工作流实现，不以触发真实业务部署作为测试；PR、本地安装和实际业务部署证据分开记录。
