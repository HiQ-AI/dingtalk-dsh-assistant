# 第八轮：维护暂停阻塞修复

真实正式事件顺序证明，维护封存后、解除维护前的恢复派发遇到 RUNTIME_MAINTENANCE_ACTIVE，被误记为永久 needs_attention。原验收消息未产生任务或外发效果。

在真实 store 中先复现 S 和 IB 领取前维护门禁导致失败，再最小修复：领取前维护拒绝透传为暂停，外层不标失败，话题不立即重调度。已有租约的业务错误处理保持原逻辑。覆盖 S、IB、command 三个边界，解除维护后同消息继续，无重复模型调用或派发。

定向回归 message-workflow、message-ledger、execution-store：154/154 PASS，0 skip；精确收窄领取前条件后维护用例再次 4/4 PASS。正式修复包安装与原生重处理、群附件送达和重启恢复尚待完成，不据此声称业务验收通过。

正式包965260ffaedf37ecdb4e4797de85bc0682773d49552922a66b2606978bf2c288安装99文件通过，新PID38576，健康ok/recoveryIssueCount=0，维护inactive revision120。通过原生Web reprocess续跑同一真实原消息：S/R/IB成功，create在Task接纳前因TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED被拒，command=unknown/result=null，实际Task不存在。真实业务仍FAIL。

只读定位：IB与冻结command均有完整fileDelivery，quote逐字包含两句原文及句号；source.includes(quote)=true，旧实现按句号切source后包含quote的clause为0，导致合法授权误拒。不得手工替换quote或改控制表绕过。

额外边界：短维护暂停测试不证明S/R跨长维护窗口直接process后续行；旧误标消息本轮使用原生reprocess获得新处理时限。
