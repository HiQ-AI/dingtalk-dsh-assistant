# 启动器验证，第 3 轮

复用的检查器新增只读 startup 模式：PRAGMA quick_check、初始化 marker 与 meta 的 instance/token/epoch 一致、旧 owner 已退出。返回 pendingSessions/startingOperations/unknownNotifications，不更改日志或账本、不声称回合排空。正式 Host 原有动态库恢复事务才接管租约并将 starting 变 unknown，禁止自动重放未知效果。

原生退出等待现在同时等待旧 PID 与启动前已记录子进程；在线预检若发现尚未启动任务领取则拒绝停机。启动器与独立检查器同步到 launchers，原桌面入口保持不变；无插件安装或数据迁移。

现场已只读核验 owner 退出、pendingSessions=1、startingOperations=0、unknownNotifications=1，恢复此次重启原本启用的计划任务后，从桌面入口继续启动。最终进程/健康与测试结果待回读。

最终验证：桌面入口正常返回 Action=已启动 / PID=29612 / Health=degraded / RecoveryIssueCount=1 / AnonymousWebStatus=401，退出码 0。独立 HTTP 回读 inboundProcessing=true、dwsBridge.healthy=true，计划任务 Enabled=true。定向测试最终 10 pass / 0 fail / 0 skipped；包含真实 SQLite 只读字节等价、存活 owner 与 marker 身份拒绝，以及 OS mock 的完整启停编排。最终本机 launcher SHA256=9F3FC3D91C2253A42FB5454FA588F458891FB1F02549A701FAF5D7DF75498F9D，checker SHA256=9B9FD81991B7FF1850DC1F34722BCFA728419F99B3DB43DD774CB57638797955，分别与源码独立读取一致。

边界：真实原生退出与随后冷启动恢复分别已实跑；最终版“运行态一条命令完整重启”的后半路径以 OS mock 回归覆盖，未再次打断恢复后的业务。未执行真实钉钉发送/通知对账，不声称全健康或业务验收通过。保留首次失败及中间发现，未写全绿 report。

最终运行态桌面 -Check 因恢复后的真实活动回合返回 DEPLOY_NOT_DRAINED，按预期拒绝启停；独立读回双端口仍归 PID 29612。此轮不再次打断活动业务。
