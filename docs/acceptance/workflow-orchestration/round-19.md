# 第19轮：中断后的活动恢复与阻断草稿重判

用户明确允许中断并重启核验恢复。第一次修复包63a157f已安装，34文件摘要一致，备份完整当前v9后启动PID843020。运行核验发现启动约7分钟才开放API：逐Task同步审计while循环持续追赶live记录。此前4个running最终均保留同一inputVersion/runSequence/childSessionId恢复。

## 修复与回归

- 固定进入时的活动快照；resumeLeaf前在同一activityTail预约历史恢复槽，启动不等待观测回填，历史先于live，不跳水位。resume失败释放预约、close等待排空。
- 新增运维reconsider：只允许零动作、零操作、无Outbox/幂等账/reservation且revision未处理的blocked通知原子rejected，保留旧内容与原因并重新调度原输入；已有副作用或未知状态拒绝。
- 与not-applied并发时，旧恢复入口在Store内CAS expectedStatus=blocked，不能复活rejected草稿；迟到Outbox按三种身份拒绝。
- `node --test`：629/629 PASS，0 fail/cancel/skip，61.90秒，完整输出round-19/full-tests.txt；diff-check通过。

## 边界

17:54只读回查，两个8月创建的旧Task在17:47切换前已重开queued，但其原Session文件不存在；reopen路径要求恢复原ID，产生task-start错误。它们不是本次中断导致的会话丢失，不伪造空Session恢复。当前Task创建/重开、业务执行及历史上下文恢复分别报告。

最终候选部署及恢复回读待追加，不能把以上测试当作现场验收。
