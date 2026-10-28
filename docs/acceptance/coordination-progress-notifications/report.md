# 最终现场结果

2026-10-28 本地已部署最终模式修复包，PID44064，双端口、入站及DWS健康，degraded/2为保留的其他未知效果恢复问题。最终包SHA256 8bf31fb1f2bfffff2133343d89dd2351a6098bbf1711d77bb81d848d3ad810c0。正常启动全库审计已移除；此前去全扫版本PID5600创建至健康回读57.5秒。正式policy artifact.2消费者路径、manifest及入口SHA保持。

原错误纯观察协调已正式退役：coordination-7b4d4a667b1dc14fbc3f1d4517e80162 revision2/state cancelled，原工作卡code cancelled、label错误观察已退役；四个原业务任务与历史送达证据保留。

原v4 Owner模式阻塞已解除：同session task-session-58aa4fb1-ad0a-448b-a5ae-0f16e793d6ca 原生seq7446追加workspace-write（18:01:35.767），seq7449新turn/start，seq7454输入lease165，需求/控制13/13保持；已有多条实际工具调用/成功回包。触发来自用户授权后正式Task dialogue入口的技术恢复指令，不把此证据冒充全局recover自动恢复成功。

尚未ack的历史wakes等待当前Owner提交，原UAT2发布尚未完成；本次不代替业务验收。全局recover在原pending任务前进行大量历史会话登记的耗时位置仍未完全收敛，记为后续性能盲点，不作为本次模式修复未执行的借口。

验证：相关协调回归210、原生HTTP1、Store146、部署57、模式scope19+原生5各自通过；不相加冒充唯一用例数。详见round-1至round-6和docs/tmp/no-full-startup-20261028、coordination-mode-fix-20261028的独立现场回读。

PR #285 保持OPEN，代码已在本地验证部署，尚未合并、未运行CI。

## 追加迭代：目录权限源头治理

第7轮已在当前tasks根落地可继承当前用户FullControl，并通过原outputs与新目录原生正反例验证；本项即时生效，无须重启。源码新增一次性准备脚本、Owner能力事实提示及文档。此追加迭代尚未全绿：额外资源组两项超时，提示包尚未安装；原任务已通过preserve context恢复lease169，尚不代表剩余业务发布完成。准确状态以matrix.csv第7轮及round-7.md为准，不沿用前面阶段完成结论。
