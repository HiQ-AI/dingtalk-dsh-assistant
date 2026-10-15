# 第6轮：独立核验安装并启动，现场后台收据

complete-verified-install.ps1 -Check零写通过，双包/源码/安装内容、profile、旧PID、离线账本均核验。实际执行仅恢复原计划任务自启并启动，不重装。新PID42240，消息接入/DWS就绪。证据 round-4/recovery-check.json、round-4/recovered-start.json。

原任务同execution/session输入版本2恢复。真实会话日志452调用显式后台PostgreSQL，453即返回原job pwsh-2/running；457调用下一工具pg_isready及隔离回归。同一服务未被工具结束清理。原pwsh-10终态不变。证据 round-6/live-background-receipt.json、round-6/task-progress.json。

后台及时返回与跨工具使用现场通过。业务回归和终态清理在第7轮回读。
