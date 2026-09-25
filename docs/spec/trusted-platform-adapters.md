# 四类受信平台适配器实施前快照

## 目标与现状

当前目录已定义 `task-uat-delivery`、`task-production-release`、`task-data-change`、`task-uat-rebuild` 的固定节点和外部效果合同，但 `resident.js` 仅从未注册的 `dingtalkTaskWorkflowExternal` 服务读取适配器，故四类均显示“缺少受信平台适配器”。本次使本机配置齐备时真实注册四类适配器；缺目标、凭据、权限或独立回读时明确阻塞，绝不通过合成回执宣称交付。

本机已只读确认 `D:/baibu-agent/.secrets` 存在 Bytebase、Woodpecker 与 K3s 凭据文件，未输出密钥值。`D:/project/dsh-bytebase-mcp` 提供 Bytebase MCP OAuth 客户端；`D:/baibu-agent/docs/ops/woodpecker-uat.md` 记录当前 Woodpecker/Kubernetes 路径。实际服务、仓库、环境、数据库目标仍须在启动时从显式受信配置和平台查询交叉验证，不把历史文档中的 ID 当当前事实。

## 边界与调用流

- 三类发布流程共用一个发布平台连接器，分别实现 UAT 集成构建、生产合并/标签/构建，以及 UAT 同提交重建。每步 `inspect` 只读真实 PR、Git SHA、流水线、制品和运行版本，`prepareOperation` 冻结精确目标、当前阶段及证据摘要；`execute` 只处理预先登记的操作类型；`reconcile` 用同一操作身份独立查询，未知结果不盲重发。
- 数据变更连接器使用 Bytebase 工单/计划/任务对象，准备阶段校验 SQL 来源与隔离演练；生产写入必须拥有精确对象与审批证据。`validate`/`rehearse` 不得向生产目标写入；`readback` 区分工单创建、批准、执行及生产结果。
- 四类效果继续使用 `execution-delivery.js` 的 `external` 网关。受信 Host 检查主体、目标和来源，创建审批请求后才允许外部写入；不会因为同群或同话题自动得到生产权限。
- 凭据由显式文件路径在本机读取，不入库、不写日志、不作为模型参数。目标映射由受信配置定义，消息里的仓库/环境/数据库名称仅为待核参数；不能临时拼接任意 URL、SQL 执行器或 shell 命令。
- 真实 UAT/生产发布、Bytebase 生产 SQL 均属于外部副作用；本轮自动化验收使用隔离假服务或只读真实查询，不为验证而触发真实构建、发布或数据变更。上线前要分别核对权限、请求身份、未知回执和回滚界限。

## 实施与验收

1. 先确定平台 API/CLI 与本机凭据结构，核对四类流程的目标字段及 `prepareRequirement` 来源；对真实平台只读探测。
2. 分别实现发布和 Bytebase 适配器，以及统一效果分发、审批授权与 `resident` 装配；配置缺失时 fail closed。
3. 用假服务覆盖四类注册、预检、审批前零写、一次执行、丢回执后只对账、目标漂移、权限拒绝和独立回读；本机真实服务仅做只读连接与对象身份核对。
4. 更新 README、部署 runbook 与验收矩阵，按 runbook 精确打包、本地安装并回读四类目录状态。未经授权不执行生产或 UAT 外部写入。

本文件记录开工前判断；验证中发现的平台接口或目标差异记入后续验收轮次，不回写为“原本已知”。
