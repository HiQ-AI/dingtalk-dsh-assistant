# 隔离回归与现场诊断

2026-10-13：已确认被引用来源是 `superseded/outbound_echo`，但引用投影为 `sourceKind=message`。已送达通知与引用消息的精确身份一致；正常待处理来源版本未变化，连续领取身份也一致，排除真实来源更新及租约被抢。

现场维护已通过正式 API 进入并独立回读排空，停止无效重试。私有诊断证据位于 `docs/tmp/group-reply-missing-20261013/`。测试和部署结果待补充；本记录不宣称消息恢复。

相关基线回归：`node --test test/message-coordinator.test.js test/message-workflow.test.js test/group-coordinator-session-native.test.js`，88/88 通过，0 失败、0 跳过。

独立审查还发现同一来源类型错误影响澄清校验：`checkedSourceRefs` 把已验证的通知引用按入站版本查询。范围收敛为同一通知引用合同：澄清校验重读同群精确通知及送达证据、正文；普通入站仍按来源版本校验，不通过跳过全部引用检查解决。加入定向反例后再记录最终回归。

旧实现复现：真实服务 fixture 保存 delivered 通知，正式接收并隔离历史回声，引用该回声时提交事务返回 `GROUP_COORDINATOR_SOURCE_STALE`（1 个用例，0 通过、1 失败，符合故障基线）。首次修复验证中的批次断言暴露 fixture 的自动派发竞态，改为原生 receive 的 `process:false` 同批接收，并逐项派发已接纳命令后重跑。

最终定向命令：`node --test --test-name-pattern='引用已隔离的已送达回声|澄清可核对已送达助手引用' test/workflow-service.test.js test/message-coordinator.test.js`，7/7 通过，0 失败、0 跳过。覆盖精确 delivered、已隔离 echo、同批两条来源正常处理，以及 ACK-only、消息 ID 不符、跨群、正文不符的拒绝。详细私有日志在 `docs/tmp/coordinator-outbound-quote-tests/`，完整相关回归待记录。
