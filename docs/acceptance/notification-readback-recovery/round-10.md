# 第 10 轮：补齐声明宿主的必需依赖并核验原通知

按 profile 当前声明的宿主目录读取真实 dependency/peerDependency 闭包，排除 optional peers，发现23个必需peer缺项；22个版本为0.2.1-rc.2，cordis-plugin-group为1.0.5。通过原生plugin add安装精确版本，不开启autoInstallPeers、不删除历史或修改业务库。

执行前Check证明旧PID退出、双端口关闭、profile patch摘要不变、精确peer版本来自声明运行时；writes=0、signals=0。安装后再次运行实际profile CLI的plugin --help并沿原计划任务启动，随后独立回读包、进程、健康及原通知。

## 独立最终回读

- Assistant 2.0.2，包SHA256：`a21bf09c5b7e65e79612f80e11b9cb226920e190f9e5c150912aacad531ff93d`。恢复安装时54个Assistant与4个Observer包文件通过核验；补齐依赖后再次核对已安装readback源码摘要一致。
- 旧PID69116退出，新PID70064同时持有3080/18998；原计划任务自启已恢复。
- `/health`：status=ok、inboundProcessing=true、dwsBridge.healthy=true、recoveryIssueCount=0。profile patch SHA256仍为 `f6f3d205bc8a9509c268e6e1e1f83470010b714a382139ab19d01dcb94d2971f`，原6个bundle保持不变。
- 原通知 `completion:task-fd754e63922f99796598df3048c7b6e9:2` 由正式运行扫描于2026-10-20T10:50:05.006Z提交notification.reconcile，当前state=delivered。
- 原messageId=`msgZ4pAi4EDUH0RY2mDwDxksA==`，与部署前SUCCESS及本轮DWS精确消息回读一致；sentAt仍为2026-10-20T10:01:50.000Z，identity=send-receipt，mentionVerification=unavailable。
- sendAttemptCount始终为1。原openTaskId和原正文保留；本轮只读核验脚本只调用发送状态查询与精确消息读取，writes=0；没有重发或直接写SQLite。
- evidenceRef=`notification-readback:a8105369230e4ab6397afd46e99e20ea929a245288eb9318d15465f044ea929a`。
- 实跑部署脚本中的宿主版本守卫：不一致返回DEPLOY_HOST_CONFIGURATION_DRIFT，一致通过；PowerShell AST无语法错误。实际profile CLI的plugin --help为exit0。

本轮证明原消息送达及状态结清，不证明接收人已读或原业务PR已经合并/部署。完整私有证据留于docs/tmp/notification-receipt-deploy。
