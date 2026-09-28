# Agent 自身资源权限修订

用户明确：Agent 是独立员工，资源权限属于 Agent 的职责和授权，不按群成员划分。本次仅修改插件，不修改平台原生内容。

## 实施

- directQueries.grants（actorId/conversationId 数组）替换为 directQueries.permissions（resourceIds/databaseIds/statusIds 单对象）。Agent 资源目录对不同发送者一致。
- 消息和调查共享 queryScope；来源身份仍验证执行归属，不能冒用他人会话，但不用于选择资源权限。
- 配置登记脚本保留 CAS、零写 Check、备份及资源校验，拒绝旧主体授权结构；正式配置需使用新版提案切换，不静默继承旧 grants。
- 任务确认、取消和恢复的操作身份规则保持独立，不等同于资源读取权限。
- 更新方案、API 合同、README、部署说明；移除跨自然人资源隔离完成条件。

## 验收

不同发送者获得同一 Agent 工具目录和资源范围；超出 Agent 权限的资源仍拒绝；模型不能改变受信权限；旧 grants 配置明确拒绝；配置 Check 零写和 CAS 不退化。运行相关定向测试。正式部署另按 runbook，不把源码通过当作部署。