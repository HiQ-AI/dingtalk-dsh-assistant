# Task 检查点审阅去重

## 症状与根因

叶子提交 `plan-confirmed` 后，主会话审阅已经返回，但 `coordinatorDecision` 尚未持久化时，Supervisor 仍能读取到未审阅 checkpoint。审阅请求表会在返回结果时删除请求，因此无法覆盖返回结果到持久化完成之间的窗口，Supervisor 会再次发起相同审阅，产生重复的 coordinator 上下文和拒绝通知。

## 修复

- Runtime 按 `checkpointId` 保存完整审阅执行 Promise，覆盖请求创建、结果等待、结果持久化、失败清理和拒绝通知。
- 叶子重复提交相同 checkpoint 与 Supervisor 恢复共用同一个执行结果。
- Supervisor 发现该 checkpoint 已有审阅执行时保持静默；执行结束后才释放索引。
- 重启后的未完成 checkpoint 仍由 Supervisor 发起一次恢复审阅，不依赖进程内索引持久化。

## 验证

- 审阅结果持久化被人为阻塞期间，多次运行 Supervisor 只产生一个审阅请求。
- 拒绝结果只向叶子注入一次 `TASK_PLAN_REJECTED`。
- 正常审阅、恢复审阅、失败清理和完整测试保持通过。
