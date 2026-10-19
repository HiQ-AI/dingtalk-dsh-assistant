# 启动器验证，第 2 轮

第 1 轮真实启动产生 PID 17380，独立读回双端口均属于该 PID；匿名 Web=401，inboundProcessing=true，DWS listeners ready / backfill ok。health=degraded / recoveryIssueCount=1，唯一问题为启动前已有的未知完成通知“群通知发送结果尚未回读确认”。原第一轮等待器要求全健康，五分钟返回失败但实例保持运行，未启动第二实例。

修复启动完成与业务全健康混淆：入口报告实际 health/recoveryIssueCount，degraded 明确警告；仍要求身份、双端口、匿名认证屏障和已配置入站就绪。未知通知不重放、不清账，不扩大为通知修复。

最终定向测试：node --test test/restart-web.test.js，8 pass / 0 fail / 0 skipped，增加 degraded 返回实际启动结果场景。运行态真实桌面 Check 返回 writes=0 / signals=0、PID 17380、drained=true、31 个已核对原生会话。

最终源码与本机 launcher 的 SHA256 均为 927F7FBCD4D5E91C04EA8A706570037607E1E399FD26489C119AFA4B73ECF6BC。运行态真实重启验证进行中。

第 2 轮真实原生退出已退出旧 PID，但子进程稍后才结束，脚本即时断言中止启动并保留自启禁用；随后独立读回旧 PID/子进程/双端口均消失。离线部署 checker 报 DEPLOY_NATIVE_TURN_NOT_ENDED，读回发现一个在预检后新进入的任务回合（drained=false）。因此不能把在线预检当原子排空，也不能把部署用全部 turn/end 门禁作为崩溃恢复启动前提。第 3 轮修订与验证另记。
