# 第一轮

- 修复前新增原生运行测试实际得到两条 operation，预期零条，断言失败；复现日志 baseline.log。该次日志中的另一个失败是尚未实现导出，不算功能复现证据。
- 修复网页只读识别、旧读取错误证明与账务恢复后，运行 `node --test test/dynamic-operation-readback.test.js test/dynamic-task-store.test.js test/task-session-service-native.test.js`：87/87 PASS，无跳过。原生测试使用本机 DSH profile，模型为脚本化适配器。
- 覆盖原生会话、任务取消、错误摘要/身份、账务幂等与原执行续办。日志 round-1.log；不代表真实业务已恢复。
