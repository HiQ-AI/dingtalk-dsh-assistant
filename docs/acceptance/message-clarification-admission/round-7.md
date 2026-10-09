# 首次部署与四条来源核对

2026-10-08，按 resident-review-local-deployment runbook，经原生维护、排空、seal、包安装、新进程核对和 resume 完成首次本地切换。此轮只包含澄清及准入改动，话题演进随后追加实施。

- Assistant SHA256：`f4d67e37aad98a74ac73993269fb4c1709794d07db99c9e26554c35a774bc2d0`；Observer：`ac3d43b1a7b5125ca040b10efb518329acc955cef64b96b8ada392b5cac02764`。包版本均 1.0.0，以摘要绑定源码。
- 原 PID 56220，新 PID 59604，3080/18998 同一新实例。安装包回读 100/4 文件匹配；认证 Web 200，登录交换 303；历史 1 Task、30 个旧节点、1 个终态 Run 保持。
- 恢复后维护 inactive、drained；任务计划自启重新启用。未复制历史备份。
- Runtime health 为 degraded。独立 `dws event status --format json` exit 5，明确报告旧登录态不能由当前认证服务刷新，须原账号重新登录。未触发登录、未发送群消息，不声称消息接收恢复。
- 四条源消息独立核对：#122 单独话题；#123 文档、#124 点名、#125 按文档开发属于另一话题。#122 没有业务命令。用户确认四条是同一交办链后，追加 SG7。

本地只读证据位于 `docs/tmp/clarification-deployment/readback.json` 和 `docs/tmp/clarification-deployment-inputs/runtime-after.json`。原始配置、启动日志、身份与链接不随 PR 提交。
