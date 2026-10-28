# Round 5：去除正常启动全库审计与正式现场恢复

用户明确要求正常启动不读全库。dynamic-task-store正常打开移除quick_check/foreign_key_check，保留结构、版本、标记、实例/epoch和owner校验；inspectStartup同样移除quick_check，显式维护完整审计保留。

验证：Store146/146，部署检查57/57通过；初始化/重启拦截完整性审计SQL并验证原任务保持。测试明细见docs/tmp/coordination-observation-retirement-20261028/no-full-scan-tests.log及docs/tmp/no-full-startup-20261028/deployment-tests.log。

现场安装最终包SHA256 87c996bc1e236e150be26b07b90c29739dc909230ab2d7cea8dc4ee61c7f77cb；新PID5600（17:40:40.670），健康回读17:41:38.154，约57.5秒；inboundProcessing=true，DWS healthy=true，degraded/2保留。原包启动600秒超时，不把后续DWS首次启动时刻误称健康时刻。配置摘要保持6fe4ab69345680bd24dbf7cb00ffd33cda72a80555a5dafc3bd19bfac0814e7e。

原错误纯观察协调已正式check及retire：coordination-7b4d4a667b1dc14fbc3f1d4517e80162 revision1→2,state=cancelled。独立GET原dispatch工作显示code=cancelled,label=错误观察已退役，非隐藏卡片。证据no-full-startup/retire-check.json、retire-result.json、retired-work-readback.json。

v4模式恢复尚未完成：原生Remote权限命令被TASK_SESSION_HOST_WRITER_REQUIRED拒绝，未修改模式；必须在Host独占写域内修复受信绑定路径，不能外部改JSONL。原成果及任务/会话保留。
