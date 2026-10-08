# 最终本地部署与四条历史话题修复

2026-10-08，原生部署脚本零写 Check 通过，再执行 HoldMaintenance；独立 Readback 后，在封存维护内执行 `scripts/reconcile-topic.mjs --check`，核对摘要，再显式传 expected-digest/request-id 执行 apply。源话题仅迁移 1 个绑定和 1 条原始事实，目标累计 4 条源消息。未重放业务。

## 包与运行态

- Assistant 1.0.0：`c66ed9df7a984c77cb5a94524f1edaacef266dbffda0ec72e70e7ef49cbed511`。
- Observer 1.0.0：`259393aed6a274660d7b65d1badeeea1c9e1789e268e61a2312930c5669d68b6`。
- 新 PID 146180；安装内容 100/4 文件与打包源码一致。认证 Web 200、交换 303；历史 1 Task、30 个节点、1 个终态 Run 验证保持。
- 独立 Resume 通过，dispatchResumed=true、maintenanceActive=false、drained=true。DWS 登录失效仍导致 degraded/inboundProcessing=false；没有声称真实收消息恢复。

## 现场独立回读

证据 `round-13/live-topic-readback.json`：原 #122 话题已指向 #123–125 的同一话题；当前列表不再出现空的旧话题，旧详情链接返回目标四条消息。当前标题“数据集过程导入导出开发”，摘要保留工作意向、文档标题所述范围、点名及明确开发要求，并说明正文未核验、开发未执行。

四条原始 Run 全字段保持，既有 Task 及其执行状态保持，Trace 项数及 command 投影保持。对比前的 PowerShell JSON 序列化会裁剪时间末尾零，验证脚本只统一 ISO 时间精度并排除动态 sampledAt，未忽略业务字段。首次严格字符串比较因此失败，规范化后通过；部署工具同时独立比对持久历史摘要。

历史澄清请求及已送达通知保留，未把修复话题当作业务补充或授权回复。本轮验证不代表原业务任务已开发，也不代表消息通道已重新认证。

本地原始日志和配置放 `docs/tmp/clarification-deployment-inputs/topic-*` 与 `docs/tmp/topic-evolution-deployment/`，不入库。复现依次使用同一包参数 `deploy-owner-repair.ps1 -Check / -HoldMaintenance / -Readback`、受管话题 CLI 和 `-Resume`；不要原样重放已应用的历史修复。
