# 第二轮：正式部署与真实回补

日期2026-09-30，代码提交6b19686；沿runbook执行现有deploy-owner-repair.ps1，先-Check再执行，参数绑定第一轮精确包及原配置摘要。原directQueries权限/资源保持，不迁移schema，不改消息业务账。

## 部署和历史

- 旧PID37796安全排空及封存后停止；备份目录 owner-repair-20260930-180656-341 位于本机 D:/dsh_home/backups。
- 原始和备份20,772文件逐项SHA256核验完成，verified=true；一致性SQLite副本逻辑回读及工件闭包通过（838引用、4,203,567字节）。副本SHA256 fdcb78be80ffcbfa0c22513ec5cd6674fc770ebd10a4a3d43aa16af3c430d66d。
- 包 b41100519064ccc74152cc4d51dc216e109a05a3d8f33148408381cb8c402948 安装后独立package回读99文件一致。
- 新PID40192、父PID40284，创建18:19:55；双端口3080/18998均归属40192。
- 22原任务、76历史节点、29终态运行、68旧任务记录校验通过；认证Web200，token交换303，凭据未输出。
- 部署readback ready=true、dispatchResumed=true，维护inactive/active=false/revision153；原计划任务配置未改变。

## 故障路径验收

```powershell
node docs/acceptance/dws-file-backfill-recovery/scripts/verify-runtime.mjs docs/tmp/dws-backfill-conflict/conflicts.json docs/tmp/dws-backfill-conflict/runtime-immediate.json
node docs/acceptance/dws-file-backfill-recovery/scripts/verify-runtime.mjs docs/tmp/dws-backfill-conflict/conflicts.json docs/tmp/dws-backfill-conflict/runtime-delayed.json
```

18:20:59即时及18:23:15延迟核验均通过：health=ok、recoveryIssueCount=0、inboundProcessing=true；两组listener=ready、backfill=ok、无错误，humanReplies=ready；维护关闭，匿名Web401。两次双端口PID40192一致，没有重复重启。

原冲突消息只有一条message_runs记录、sourceVersion仍1；正文、发送者及runId与修复前证据完全一致。历史回补已可靠接纳，并未为展示差异新增版本或重跑任务。

## 桌面脚本

真实预检还发现旧脚本把“没有在固定日志路径找到登录链接”当未就绪；部署日志位于本次证据目录时，实际进程/双端口/health=ok/401均正常却误报异常。只移除ready条件中的accessUrl要求，登录链接仍按实际日志展示，不伪造链接。再次运行桌面restart-dsh-web.ps1 -Check通过，原JSON输出分离7项回归也通过。本机脚本SHA256 F6C0F9E73D4253DC35E6ACBBF87DE22B0492A9860CDE8FC0ACB6A458E85B0AD6。

本轮真实验收覆盖原故障回补及运行恢复；没有发起新的群消息或业务任务，部署工具的通用businessAcceptancePassed默认字段仍false，不能解释为全部业务工作流均已验收。
