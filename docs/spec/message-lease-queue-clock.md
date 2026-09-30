# 消息排队与模型执行计时修订

现场失败：真实 R 调用超时后，消息在串行恢复或模型并发槽等待期间继续消耗共享 deadline，随后被标记为领取前超时。事项阻挡又使常规恢复无法重试，连带阻挡其他话题。

本次将执行时限绑定实际节点 lease：领取成功时记录本次 deadline，单次调用超时、领取次数、租约及效果门禁继续有效；排队不使用旧消息 deadline 拒绝下一次领取。恢复不再使用包含排队时间的十分钟墙钟年龄，真实失败恢复仍最多两次，同一失败 lease 不重复扣恢复次数。历史领取前超时经既有 recover 清理同原因事项阻挡，其他阻挡不变。持续失败由恢复次数及模型领取预算终止。

验证覆盖已有失败后长排队、旧事项 attention 正常恢复、相同失败重复恢复不扣次数、新失败预算耗尽、单次超时与旧 lease 拒绝。运行库及外部渠道不参与开发测试。

失败预算以原生 execution_events 中 message.node.fail 的 node.id/leaseEpoch 与当前失败节点为证据，不采用旧 recoveryWindows 扫描计数；已被后续重试覆盖的失败仍可从事件账还原。测试包含旧 recoveryWindows=2 但仅一次真实失败，原版本继续且不重跑 S。

调用窗口由当前 Host 在每次 `message.node.claim` 显式传入必需 `leaseWindowMs=attemptMs+commitReserveMs`，节点原子冻结该窗口与 deadline；不读取旧运行 policy 的 attemptMs 推算当前调用时限。历史20秒 policy 与当前60秒 Host 的30秒模型结果已用实际 reducer 时钟推进验证。恢复预算耗尽立即停止该轮处理，保留 recovery_exhausted 原因，不再用泛化 MESSAGE_NEEDS_ATTENTION 覆盖。
