# M1 恢复窗口修订与最终回归

日期：2026-09-23。沿用 round-1 环境与合成边界。

## 反例和修订

独立代码审查找到此前测试未覆盖的窗口：控制账已经提交 ready 节点，但 Host 尚未执行 claim 时崩溃。重启后 `run.recover` 要求 waiting/recovery，Controller 无条件调用它会得到 `RUN_NOT_RECOVERING`，持久任务无法正常继续。

Controller 现在对持久 ready 直接调度；只有需要恢复的等待节点才调用 `run.recover`；终态回读不再领取租约。已接纳输入与停止仍优先处理。

新增两个正式存储重开反例：首次 claim 前；上游成功事务提交而下游未 claim。均恢复到 succeeded、输出 4、两节点各 lease=1；再次恢复终态不增加租约。

## 最终验证

- `node --test test/execution-controller.test.js`：12/12 PASS。
- `pnpm test`：**690 tests / 690 pass / 0 fail / 0 skipped**，32.4 秒。新增 execution 用例合计 58，包含原生组合 4、原生 Session 12、Store 14、效果 16、Controller 12。
- 未修改 Web UI 或运行中的 resident，未调用生产或消息写接口。

round-1 的测试计数保留为历史结果；最新状态以 matrix.csv 的 round=2 为准。真实渠道、OS 隔离和业务性能等未验证项继续保留。
