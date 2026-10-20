# 第1轮：启动失败补偿与原消息恢复

基线：原消息140收到于2026-10-20 18:39:40，归类失败于18:49:58；routingStatus=pending、agentDeliveryStatus=decision-failed，原route请求attempt0且无messageId，错误为tool-subagent拒绝已废弃toolFilter。旧扫描保持exhausted却可能清空内存错误，所以health=ok不代表归类可用。

## 源码与反例

- 仅create未返回句柄时标startup；其后steer/派发异常显式记dispatch，不进入历史零输入恢复。
- 持久startupAttempt及nextRetryAt，最高5分钟退避；当前preset有效且到期时同requestId续办。并发recover由原请求互斥，重启保留时点。
- 历史无failurePhase且attempt0且无messageId才有资格；已有输入、协议耗尽和未知效果不重放。
- 129项coordination-sessions/topic-runtime全文件回归通过；额外定向复查普通dispatch拒绝反例通过。HTTP SQLite用例通过，证明持久消息错误进入告警且实际消除后才消失。
- 本机实际原生schedule插件4个工具均返回subagent_session，调度服务调用为0。因此移除6个过时toolFilter不会开放子Agent调度操作。

## 配置与部署

配置修复先--check：writes=0；随后--apply仅删除6个已知deny块，YAML解析后逐项比较其他语义不变。profile SHA256：f6f3d205bc8a9509c268e6e1e1f83470010b714a382139ab19d01dcb94d2971f → fb0a6a410c0d9efb4c311c760457efc80f9087b8fb8343f403ccbaf1748bfbfa。

最终Assistant2.0.2包SHA256：ed285c066a4e193f8b5aefe966b6b723c840bd7e261053175fe87292dc42257d。Check writes=0/signals=0、旧PID70064、46会话排空、unknownOperations=0、unknownNotifications=0。沿原生CTRL+C退出及同一数据库/实例安装启动；不备份历史、不重发原消息。

包安装完成并由新PID35992启动，54个Assistant与4个Observer文件核验通过；部署脚本首次渠道快照尚在初始化，返回DEPLOY_TRANSPORT_NOT_READY。此时原消息仍保留历史exhausted与旧错误；没有重装或重启，按round-2独立回读。永久脚本已补双端口就绪后最多60秒的真实渠道等待，实跑等待分支和实际健康检查通过。详细现场材料仅在docs/tmp/coordination-startup-recovery。
