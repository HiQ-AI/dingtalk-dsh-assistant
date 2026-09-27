# 隔离自身回声残留节点的维护恢复

当前事故只允许 msg-92023445605d174a87e6028d94c579a24ca3012f：运行已由原生 outbound_echo 判定 superseded，但 S 模型节点遗留 running，导致维护不能排空。恢复不重新派发消息，也不将业务任务置为成功。

先只读核验目标和唯一忙项，再在线进入正式 maintenance draining。以 profile CAS 安装既有 bootstrap witness，等同一 Host/PID 的 ready 见证后追加 resident disable，必须收到 loader 完整 partial-dispose 完成见证；端口关闭本身不够。之后 helper 获取原生控制库 owner 锁、备份与验证完整运行库及旧域数据，调用严格限类的原生 repair 命令并独立回读。最后 CAS 删除固定 witness/fence，让原 Host 重建 resident，确认维护仍 active/draining 且 drained，输出正式部署的接续维护 ID/revision。

失败保持证据和当前 fence，不强停 Host，不解除维护，不写 SQL 业务数据。仅同证据目录及相同 profile/进程/维护身份可 Resume；命令采用固定事故 ID 幂等，不提供任意命令 hook。
