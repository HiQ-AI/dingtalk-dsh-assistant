# 第七轮：仅保留送达时间

用户要求只要一个送达时间。源码 f50432f 将时间列改为“送达时间”，只展示 deliveredAt，缺失显示未记录；不再展示发送时间与回读确认两层。sentAt 底层事实保留，没有数据修改。README、DESIGN 和当前部署说明同步。

30/30 Observer 客户端与归档交互测试通过，语法、diff 检查和 strict UI 审计通过。测试以 sentAt 与 deliveredAt 不同的记录验证仅展示 deliveredAt。

原生零写 Check 后排空33会话，旧 PID30656退出，安装 Observer 2.0.0（SHA256 900db9342c1a51ff3cdb83dc09994fd878ff3791cf284c2cfc792b993539c8bc），四文件核对一致，新 PID59384。profile 保持，无备份；入站和桥接正常，既有1条未知通知告警保留，整体 degraded。

真实 Chrome 重载，表头为状态、送达时间、消息内容、来源。原问题通知显示已送达，单一时间2026/10/19 10:27:24，辅助关系仍为已替代；没有发送时间或回读确认第二行。截图与部署原始证据在 docs/tmp/outbox-delivery-time*，不入库。
