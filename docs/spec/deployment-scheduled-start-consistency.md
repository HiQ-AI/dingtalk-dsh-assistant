# 部署启动环境一致性

2026-10-08。部署 helper 普通及离线修复当前以调用者环境 Start-Process 启动持久脚本；本机已配置的 DSH Web Local 计划任务是日常重启入口。现场通过该入口重启后 DWS ready/回补成功；Windows 底层凭据隔离机制尚未证实，本变更只统一服务启动环境。

两条部署路径统一调用已配置计划任务，不新增启动选项、不修改 Action/Principal。启动前及零写 Check 核对唯一任务、固定 PowerShell Action、显式 DSH_HOME、web profile及工作目录。启动前拒绝既有进程/端口/运行中任务，继续由现有 Read-Deployment 证明新进程与双端口和安装状态。launch.json 保留既有字段，launcherPid=null（调度请求没有可证明的launcher PID），补充启动方式与任务名，startedAt记录调度时间。

Enrollment 仅根据原流程保存的 enrollmentAutostartRestore 恢复 enabled 状态，恢复提前到启动前且先核对 Action；不借此启用原本禁用的任务。普通与repair均复用这一门禁。测试通过mock任务/进程读取检查三种入口、Action漂移和无授权enable拒绝，不重启线上。
