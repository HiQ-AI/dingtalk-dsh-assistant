# 新版工作流归档入口修复

HTTP workflowTaskAction 已匹配 archive，却只允许 context/cancel/confirm-stage/continue-budget；Service 同样缺少归档动作，原生控制账没有归档展示记录。旧 Runtime 归档工作目录的安全合同继续复用，不能把文件清理与新版工作流标记混为一谈。

新增原生 task.archive 命令，在控制事务中校验任务完成/取消、Owner 已收口、所有运行和执行租约终态、效果已排空；仅追加归档事件与幂等回执，不变更完成状态、节点产物或删除工程目录。task.archives 查询已有事件，新版 tasks 投影 archivedAt。HTTP archive 接受现有空对象，复用本机身份和 configured actor 授权，无模型或群发。

验证：HTTP真实入口/幂等/重启持久化/非法身份/活动任务拒绝/未决效果拒绝，相关原生控制与Service回归。交付修复PR并部署，正式API批量归档 legacy 未归档以及明确测试任务。没有明确测试证据的当前业务任务保留；旧版工作目录归档若遇安全门禁必须报告，不绕过。
