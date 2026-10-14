# 恢复Agent工作区

2026-10-14按用户要求将Agent工作区从D:\baibu-agent\task-session-runtime-clean恢复为D:\baibu-agent。

原因：清洁启动将独立运行数据根也用作Agent工作区；store的tables.scheduler.runtime.agentWorkspaceDir优先于profile配置，所以必须同时修改两处。

先跑restore-workspace.mjs --check（0写入）及精确控制台Check；核验全部原生任务/执行已排空，再SIGINT退出PID61872。offline-ledger.json独立确认旧PID退出、原生回合结束、unknown效果/通知均0。未清账、未迁移目录、未备份历史副本。

仅改变profile agentWorkspaceDir和持久store同名字段。taskSessions.workspaceDir显式固定现有任务数据根，dbPath/instanceId/epoch及原会话身份不变，以免切换全局工作区后找不到历史任务日志。配置编辑脚本验证store其余字段深度相同，失败时恢复原文本。

新PID46748，GET /state/agent-config独立读回workspaceDir=D:\baibu-agent，profile和store读回一致。入站已开启、消息桥健康。health=degraded的唯一告警为18:12:14已有的原布局任务人工等待，发生在本次切换前；不是路径迁移故障。未替用户答复该业务问题。

证据：before-ledger.json、offline-ledger.json、config-change.json、readback.json、existing-alerts.json。配置修复之外没有修改产品源码或部署其他包。
