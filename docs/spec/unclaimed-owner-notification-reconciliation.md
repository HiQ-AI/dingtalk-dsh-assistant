# 未领取的旧 Owner 通知失效处理

当前四条待发送通知均为 prepared、leaseEpoch=0。实时健康接口 outboundAuthorized=false，配置明确关闭外发；并非渠道调用失败。其中三条旧求助已被同任务后续 applied 结案报告取代。

根因是通知时效检查只在 claim 中运行，而 drain 在 canDisclose=false 时提前返回。恢复写入前旧记录仍显示待发送。不能通过领取通知再取消来治理队列，也不能依据公开 completed 投影修改历史。

在现有消息账命令中增加单条 reconcile：仅处理无任何发送/操作证据的 prepared、leaseEpoch=0 Owner wait/block 通知；同任务原报告必须 applied，且同任务最新 accepted Owner 已 applied、产生更晚的 complete/wait/block 报告，才能失效。记录替代报告 ID，不声称新报告已送达或业务全部通过。

通知扫描在披露/发送检查前执行该命令；无 adapter 时仍执行。保留最新报告、普通查询回复、已领取及未知/已送达通知。使用命令事务复核，重复扫描幂等。部署后用实时消息账独立回读三条 superseded、原查询回复仍 prepared；外发配置单独授权。

验证包括关闭外发和无适配器扫描、相同需求版本的新结论、未 applied 或其他任务报告、已领取及有发送证据反例。定向测试后按既有维护部署 runbook 安装，核对包摘要、版本、进程及健康。
