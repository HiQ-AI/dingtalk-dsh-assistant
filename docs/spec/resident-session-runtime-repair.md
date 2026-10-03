# 常驻会话运行修复

## 目标与现状

2026-10-01 正式实例的群协调会话仍位于 Agent 工作区的职责子目录，原生权限为 workspace-write/ask，没有群名标题。21:15:34 至 21:22:48 的模型调用报告 inputTokens=847203；随后历史压缩持续约三分钟。原始 JSONL 包含重复的候选目录、历史和后台快照。进度通知的发送账号与任务所有者不同，ingest 的 ownerActorId 条件漏掉已登记通知的回声。

## 方案与边界

1. 群协调会话直接使用已校验的 Agent workspaceDir；创建和恢复均通过原生 permissionPresets 设置 danger-full-access，并通过 sessionTitle 使用完整群名。
2. Session header 不可变。已有错误目录的会话在原生句柄排空、控制账 idle 时以 sessionId/leaseEpoch CAS 绑定派生会话；新 Session 通过原生 seed/inheritedEventCount/parentSession 保留旧事件，不改旧日志或任务身份。首次创建失败可按已持久绑定的 parentSession 重试。
3. 在下一轮开始前，用原生 surface replacement 将已结束轮次的重复 Host 输入改为原始来源、引用和附件的历史记录；完整原始事件仍保留。当前完整来源、任务目录、处理状态和版本校验照常提供。不是业务摘要、删日志或限制原文长度。
4. 已登记的同群外发消息 ID 不依赖任务所有者身份过滤。回读迟到时沿用现有回声隔离与来源版本校验，不按署名、正文相似度或发送者批量忽略消息。

原生完全权限不扩大业务工具目录、数据库授权表列、生产执行审批或群职责。当前生产表读取阻碍独立保留，不重跑业务、不执行 DDL。权限同因检查关注本次群常驻入口；Task 会话的独立文件布局不改。

## 验证与交付

复用 group-coordinator-session-native、message-coordinator、message-ledger、workflow-service 定向测试，覆盖跨轮/重启、旧目录派生、父日志不变、群名变更、权限持久化、写工具拒绝、当前完整快照与旧快照收紧、通知账号差异及普通用户消息反例。部署遵循 docs/ops/resident-review-local-deployment.md，先 Check、维护排空、备份与封存，再安装精确包，独立回读进程/哈希/health/会话。真实新消息性能只在用户已提供的消息上观察，不发送测试群消息。
