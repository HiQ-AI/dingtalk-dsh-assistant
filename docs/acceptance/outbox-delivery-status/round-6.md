# 第六轮：收拢状态、筛选和字段

用户明确反馈状态、筛选、字段拆分过碎。本轮源码 cfeb380 将界面收拢为五种短状态（待发送、发送中、待确认、已送达、异常）、一个状态筛选、四列（状态、发送时间、消息内容、来源）。第五轮四维筛选布局被本轮替代；底层事实仍分开判断，历史和未知结果保留。原因、替代和实际撤回结果作为消息辅助信息，内部 ID 和诊断默认折叠在“消息记录”。

76/76 定向测试通过：observer-client、observer-archive-interaction、task-message-projections、task-notification-delivery、task-notification-readback；语法检查、diff 检查与 strict UI 审计通过。

原生部署复用 Assistant 33c8030，Observer cfeb380 包 SHA256 为 c478dde05e96bb2030955d536ffc433bf6dacc459077a363fe6ed3e930706304。旧 PID 21008 排空后退出，新 PID 30656 持有3080/18998，安装验证四个文件一致；profile 摘要保持，计划任务启用，未创建备份。inboundProcessing=true、dwsBridge.healthy=true；既有一条未知通知告警仍在，整体 degraded。

真实 Chrome 验证：四列、唯一状态筛选及五个短名称准确；原样本主状态“已送达”，消息下显示“已替代”，记录默认折叠，展开后投递 ID 和替代 ID 可查。待确认筛出1条未知结果且未误报送达，异常为空，已送达63条；刷新保持筛选。恢复全部状态64条。768px下 body.scrollWidth=768，无页面横向溢出，四列在表格内部滚动，视口已恢复。

独立 API 比较部署前后64条记录的发送状态、通知状态、投递 ID、回读时间、替代关系和撤回状态，changed=0。没有新发群消息、撤回消息或补造历史时间。

原始证据及截图位于 docs/tmp/outbox-compact-cfeb380/ 与 docs/tmp/outbox-compact-cfeb380-deploy/，含业务内容不入库。
