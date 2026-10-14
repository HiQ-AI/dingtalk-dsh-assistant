# 本机部署与真实原任务恢复

2026-10-14，按`docs/ops/task-session-clean-start.md`原生双包脚本执行。先`-Check`：零写入/零信号，PID11876，quiescent=true、drained=true、verifiedSessions=5、unknownOperations=1。随后SIGINT正常退出，独立核验旧owner释放及子进程排空，再官方CLI安装及计划任务启动；未创建历史备份。

- Assistant包SHA256：`73aa65eff96d38b4635e6b50b18acda323ccebac43ae642f4873957ff1a3b7cc`，234254字节；源码、包和安装回读一致。
- Observer包SHA256：`b67253f63c0f28151e9e41b209229b2fda0d3827de27fd0720fa8cd69fd45d74`，本轮无UI改动。
- 新PID37728；installedVersion=1.0.0；profile原字节摘要保持。
- /health：inboundProcessing=true、DWS healthy=true、humanReplies ready。启动时status=degraded/recoveryIssueCount=2，分别是原web_fetch unknown及原任务blocked；不将交通就绪当作未知效果已解决。
- 原待答技术申请audience=operator，私聊通知独立回读为delivered；实际messageId、conversationId、senderActorId及发送时间均返回。未进入业务群发件箱。
- 在既有受信Web介入API提交真实技术修复结果。独立回读原申请status=answered、decisionSource=web；task/session身份保持，原任务重新委派原只读调查。
- 实际原生执行会话`task-execution-df7df92d-a241-4f81-80e4-ef3820e086cb`：tool/call seq90为GitHub提交关联PR及git ls-remote查询，tool/result seq91 isError=false，返回实际#372合并状态和远端refs；read seq95读取原web_fetch日志，seq96 isError=false，返回原始调用和WEB_UNSUPPORTED_CONTENT_TYPE终态。

原生证据不是另起CLI代查：上述结果来自被修复任务自己的执行日志。原Owner继续开发分支调查与原操作对账，未代其修改业务代码或宣布布局完成。本轮真实私聊已验证送达，真人引用答复仅在原生fixture测试验证；现场恢复使用Web，未伪造真人私聊答复。

本地详细证据：`docs/tmp/intervention-deployment/{control,quiescent,installed,observer-installed,readback}.json`、`intervention-live-native-proof.json`、`intervention-resumed-task.json`。日志/消息原文及个人身份不入库；重新取证沿既有API和原生日志的精确身份执行。
