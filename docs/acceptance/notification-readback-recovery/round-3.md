# 第 3 轮

- `node --test test/dynamic-task-store.test.js test/task-notification-readback.test.js`：84/84 PASS。新增反例验证同一续办请求键改目标被拒绝；新步骤请求键保留原 executionId/sessionId，输入版本递增，执行数不增加。
- 部署源码 1181976；Assistant 包 SHA256：eb5c36d7efe3d4de8a28ab954f2dae0ce5deb93343f758883e3997f19ca6b642。53 个安装文件核对通过；Observer 沿用既有已验证包。
- 部署前 Check：writes=0、signals=0、verifiedSessions=24、unknownOperations=0、unknownNotifications=9。执行已排空后 SIGINT 退出，子进程剩余 0，端口关闭后安装。
- 新 PID21016 同时持有 3080/18998，原计划任务 enabled=true，profile patch 摘要未变。独立健康回读 status=ok、inboundProcessing=true、recoveryIssueCount=0，恢复告警接口为空数组。
- 原 operator 申请经 reply/check（writes=0）再正式 reply；原执行 inputVersion=3/status=running、executionId/sessionId 不变，任务执行数仍为 3。
- 原 9 条通知全部 delivered，逐条 messageId 与部署前 DWS SUCCESS 回执相同，sendAttemptCount 全为 1；未重发。敏感业务原文与原始现场记录仅放本地 docs/tmp。

这证明运行时恢复和通知对账完成，不代表原业务任务数据库核验、共享库变更或业务部署完成。
